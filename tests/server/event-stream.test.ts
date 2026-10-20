import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionNotFoundError } from "../../src/events/types.js";
import type {
  SessionEventEnvelope,
  SessionEventSource,
} from "../../src/events/types.js";
import { createApiHandler } from "../../src/server/api.js";
import { createEventStreamHandler } from "../../src/server/event-stream.js";
import { SessionCorruptionError } from "../../src/session/errors.js";
import type { SessionHeader } from "../../src/session/types.js";

interface SseFrame {
  event?: string;
  id?: number;
  data?: string;
  comments: string[];
}

function parseBlock(block: string): SseFrame | undefined {
  const frame: SseFrame = { comments: [] };
  let sawField = false;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      frame.comments.push(line.slice(1).trim());
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      frame.event = value;
      sawField = true;
    } else if (field === "id") {
      frame.id = Number(value);
      sawField = true;
    } else if (field === "data") {
      frame.data = (frame.data ?? "") + value;
      sawField = true;
    }
  }
  return sawField || frame.comments.length > 0 ? frame : undefined;
}

async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseBlock(block);
        if (frame !== undefined) yield frame;
      }
    }
    buffer += decoder.decode();
    const frame = parseBlock(buffer);
    if (frame !== undefined) yield frame;
  } finally {
    reader.releaseLock();
  }
}

async function collectFrames(url: string, signal?: AbortSignal): Promise<SseFrame[]> {
  const res = await fetch(url, signal === undefined ? undefined : { signal });
  const frames: SseFrame[] = [];
  for await (const frame of readFrames(res.body!)) frames.push(frame);
  return frames;
}

function header(status: "open" | "closed", id = "s1"): SessionHeader {
  return { id, createdAt: "2026-10-20T00:00:00.000Z", status };
}

function envelope(seq: number, content = `e${seq}`): SessionEventEnvelope {
  return { seq, ts: "t", type: "user", payload: { content }, sessionId: "s1" };
}

interface FakeSourceOptions {
  header?: SessionHeader;
  events?: SessionEventEnvelope[];
  followImpl?: (
    sessionId: string,
    since: number,
    signal: AbortSignal,
  ) => AsyncIterable<SessionEventEnvelope>;
}

function fakeSource(opts: FakeSourceOptions = {}): {
  source: SessionEventSource;
  readCalls: Array<{ sessionId: string; since: number }>;
  followCalls: Array<{ sessionId: string; since: number }>;
  followSignals: AbortSignal[];
} {
  const sessionHeader = opts.header ?? header("closed");
  const events = opts.events ?? [];
  const readCalls: Array<{ sessionId: string; since: number }> = [];
  const followCalls: Array<{ sessionId: string; since: number }> = [];
  const followSignals: AbortSignal[] = [];
  const source: SessionEventSource = {
    async read(sessionId, since) {
      readCalls.push({ sessionId, since });
      const head = events.at(-1)?.seq ?? -1;
      const cursor = Math.min(since, head);
      return {
        header: sessionHeader,
        events: events.filter((event) => event.seq > cursor),
        headSeq: head,
      };
    },
    follow(sessionId, since, signal) {
      followCalls.push({ sessionId, since });
      followSignals.push(signal);
      if (opts.followImpl !== undefined) {
        return opts.followImpl(sessionId, since, signal);
      }
      return (async function* () {
        for (const event of events) {
          if (event.seq > since) yield event;
        }
      })();
    },
  };
  return { source, readCalls, followCalls, followSignals };
}

function waitUntilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const servers: Server[] = [];
const clients: AbortController[] = [];
const homes: string[] = [];

async function start(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>,
): Promise<string> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

async function startStream(opts: FakeSourceOptions & {
  retryMs?: number;
  heartbeatMs?: number;
  liveQueueMax?: number;
} = {}): Promise<{
  url: string;
  fake: ReturnType<typeof fakeSource>;
}> {
  const fake = fakeSource(opts);
  const url = await start(
    createEventStreamHandler({
      eventSource: fake.source,
      ...(opts.retryMs === undefined ? {} : { retryMs: opts.retryMs }),
      ...(opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs }),
      ...(opts.liveQueueMax === undefined ? {} : { liveQueueMax: opts.liveQueueMax }),
    }),
  );
  return { url, fake };
}

async function jsonError(url: string): Promise<{ status: number; body: { error: { code: string } } }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as { error: { code: string } } };
}

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "eam-events-"));
  homes.push(home);
  mkdirSync(path.join(home, "sessions"), { recursive: true });
  return home;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.abort();
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

describe("SSE 事件流", () => {
  it("先补播全部事件再跟随新事件，帧含 id 与 data 信封", async () => {
    const { url, fake } = await startStream({
      header: header("open"),
      events: [envelope(0), envelope(1)],
      followImpl: async function* () {
        yield envelope(2);
        yield envelope(3);
      },
    });

    const frames = await collectFrames(`${url}/api/events?sessionId=s1`);
    const dataFrames = frames.filter((frame) => frame.id !== undefined);

    expect(dataFrames.map((frame) => frame.id)).toEqual([0, 1, 2, 3]);
    expect(JSON.parse(dataFrames[0]!.data!)).toMatchObject({ seq: 0, sessionId: "s1" });
    expect(JSON.parse(frames.at(-1)!.data!)).toEqual({ lastSeq: 3 });
    expect(frames.at(-1)!.event).toBe("stream_end");
    expect(fake.readCalls).toEqual([{ sessionId: "s1", since: -1 }]);
    expect(fake.followCalls).toEqual([{ sessionId: "s1", since: 1 }]);
  });

  it("since / Last-Event-ID / 缺省与 query 优先", async () => {
    const events = [envelope(0), envelope(1), envelope(2)];

    const byQuery = await startStream({ header: header("closed"), events });
    expect(
      (await collectFrames(`${byQuery.url}/api/events?sessionId=s1&since=1`))
        .filter((frame) => frame.id !== undefined)
        .map((frame) => frame.id),
    ).toEqual([2]);
    expect(byQuery.fake.readCalls[0]).toEqual({ sessionId: "s1", since: 1 });

    const byHeader = await startStream({ header: header("closed"), events });

    const res = await fetch(`${byHeader.url}/api/events?sessionId=s1`, {
      headers: { "Last-Event-ID": "1" },
    });
    const ids: number[] = [];
    for await (const frame of readFrames(res.body!)) {
      if (frame.id !== undefined) ids.push(frame.id);
    }
    expect(ids).toEqual([2]);
    expect(byHeader.fake.readCalls[0]).toEqual({ sessionId: "s1", since: 1 });

    const queryWins = await startStream({ header: header("closed"), events });
    const queryRes = await fetch(`${queryWins.url}/api/events?sessionId=s1&since=2`, {
      headers: { "Last-Event-ID": "1" },
    });
    const queryIds: number[] = [];
    for await (const frame of readFrames(queryRes.body!)) {
      if (frame.id !== undefined) queryIds.push(frame.id);
    }
    expect(queryIds).toEqual([]);
    expect(queryWins.fake.readCalls[0]).toEqual({ sessionId: "s1", since: 2 });

    const defaults = await startStream({ header: header("closed"), events });
    const defaultFrames = await collectFrames(`${defaults.url}/api/events?sessionId=s1`);
    expect(defaultFrames.filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual([
      0, 1, 2,
    ]);
    expect(defaults.fake.readCalls[0]).toEqual({ sessionId: "s1", since: -1 });
  });

  it("since 超前 head 时按 head 夹紧，follow 仍收到后续事件", async () => {
    const { url, fake } = await startStream({
      header: header("open"),
      events: [envelope(0), envelope(1), envelope(2)],
      followImpl: async function* () {
        yield envelope(3);
      },
    });

    const frames = await collectFrames(`${url}/api/events?sessionId=s1&since=10`);

    expect(frames.filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual([3]);
    expect(fake.followCalls).toEqual([{ sessionId: "s1", since: 2 }]);
    expect(JSON.parse(frames.at(-1)!.data!)).toEqual({ lastSeq: 3 });
  });

  it("closed 会话 since 超前 head 时 stream_end.lastSeq 不回显未写游标", async () => {
    const { url } = await startStream({
      header: header("closed"),
      events: [envelope(0), envelope(1), envelope(2)],
    });

    const frames = await collectFrames(`${url}/api/events?sessionId=s1&since=10`);

    expect(frames.filter((frame) => frame.id !== undefined)).toEqual([]);
    const lastSeq = (JSON.parse(frames.at(-1)!.data!) as { lastSeq: number }).lastSeq;
    expect(lastSeq).not.toBe(10);
    expect([2, -1]).toContain(lastSeq);
  });

  it("非法 since 与 Last-Event-ID 返回 400 invalid_cursor", async () => {
    const { url } = await startStream({ header: header("closed") });

    for (const since of ["-2", "abc", "1.5"]) {
      const result = await jsonError(`${url}/api/events?sessionId=s1&since=${since}`);
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("invalid_cursor");
    }

    const headerResult = await fetch(`${url}/api/events?sessionId=s1`, {
      headers: { "Last-Event-ID": "abc" },
    });
    expect(headerResult.status).toBe(400);
    expect(((await headerResult.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_cursor",
    );
  });

  it("非法或空 sessionId 返回 400，且不读取事件源", async () => {
    const { url, fake } = await startStream({ header: header("closed") });

    for (const query of ["", "?sessionId=", "?sessionId=..%2f..%2fetc", "?sessionId=a.b"]) {
      const result = await jsonError(`${url}/api/events${query}`);
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("invalid_session_id");
    }
    expect(fake.readCalls).toEqual([]);
  });

  it("不存在返回 404、损坏返回 500，均以 JSON 返回", async () => {
    const notFound = fakeSource();
    notFound.source.read = async () => {
      throw new SessionNotFoundError("nope");
    };
    const notFoundUrl = await start(createEventStreamHandler({ eventSource: notFound.source }));
    const missing = await jsonError(`${notFoundUrl}/api/events?sessionId=s1`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("session_not_found");

    const corrupt = fakeSource();
    corrupt.source.read = async () => {
      throw new SessionCorruptionError("invalid_event_line", "bad");
    };
    const corruptUrl = await start(createEventStreamHandler({ eventSource: corrupt.source }));
    const broken = await jsonError(`${corruptUrl}/api/events?sessionId=s1`);
    expect(broken.status).toBe(500);
    expect(broken.body.error.code).toBe("session_corrupt");
  });

  it("超出安全整数范围的 Last-Event-ID 返回 400", async () => {
    const { url } = await startStream({ header: header("closed") });
    const result = await fetch(`${url}/api/events?sessionId=s1`, {
      headers: { "Last-Event-ID": "9007199254740992" },
    });
    expect(result.status).toBe(400);
    expect(((await result.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_cursor",
    );
  });

  it("closed 会话补播后发 stream_end 并关闭", async () => {
    const { url, fake } = await startStream({
      header: header("closed"),
      events: [envelope(0), envelope(1)],
    });

    const frames = await collectFrames(`${url}/api/events?sessionId=s1`);

    expect(frames.filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual([0, 1]);
    expect(frames.at(-1)).toMatchObject({ event: "stream_end" });
    expect(JSON.parse(frames.at(-1)!.data!)).toEqual({ lastSeq: 1 });
    expect(fake.followCalls).toEqual([]);
  });

  it("客户端 abort 时不发 stream_end，并触发 follow 的 abort", async () => {
    let followSignal: AbortSignal | undefined;
    const { url } = await startStream({
      header: header("open"),
      followImpl: (_sessionId, _since, signal) => {
        followSignal = signal;
        return (async function* () {
          yield envelope(0);
          await waitUntilAborted(signal);
        })();
      },
    });

    const controller = new AbortController();
    clients.push(controller);
    const res = await fetch(`${url}/api/events?sessionId=s1`, { signal: controller.signal });
    const frames: SseFrame[] = [];
    const iterator = readFrames(res.body!);
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      frames.push(next.value);
      if (next.value.id === 0) break;
    }
    controller.abort();
    await waitUntilAborted(followSignal!);

    expect(followSignal!.aborted).toBe(true);
    expect(frames.some((frame) => frame.event === "stream_end")).toBe(false);
  });

  it("follow 中途损坏写 stream_error 且 lastSeq 为已写出最大值", async () => {
    const { url } = await startStream({
      header: header("open"),
      events: [envelope(0), envelope(1)],
      followImpl: async function* () {
        yield envelope(2);
        throw new SessionCorruptionError("invalid_event_line", "bad");
      },
    });

    const frames = await collectFrames(`${url}/api/events?sessionId=s1`);
    const errorFrame = frames.find((frame) => frame.event === "stream_error");

    expect(errorFrame).toBeDefined();
    expect(JSON.parse(errorFrame!.data!)).toEqual({ code: "session_corrupt", lastSeq: 2 });
    expect(frames.some((frame) => frame.event === "stream_end")).toBe(false);
    expect(frames.filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual([
      0, 1, 2,
    ]);
  });

  it("follow 非损坏错误映射为 internal_error", async () => {
    const { url } = await startStream({
      header: header("open"),
      events: [envelope(0)],
      followImpl: async function* () {
        throw new Error("boom");
      },
    });

    const frames = await collectFrames(`${url}/api/events?sessionId=s1`);
    const errorFrame = frames.find((frame) => frame.event === "stream_error");

    expect(JSON.parse(errorFrame!.data!)).toEqual({ code: "internal_error", lastSeq: 0 });
  });

  it("heartbeat 发送注释帧", async () => {
    let followSignal: AbortSignal | undefined;
    const { url } = await startStream({
      header: header("open"),
      heartbeatMs: 20,
      followImpl: (_sessionId, _since, signal) => {
        followSignal = signal;
        return (async function* () {
          await waitUntilAborted(signal);
        })();
      },
    });

    const controller = new AbortController();
    clients.push(controller);
    const res = await fetch(`${url}/api/events?sessionId=s1`, { signal: controller.signal });
    const frames: SseFrame[] = [];
    for await (const frame of readFrames(res.body!)) {
      frames.push(frame);
      if (frame.comments.includes("ping")) break;
    }
    controller.abort();
    for (let attempt = 0; attempt < 100 && !followSignal!.aborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(frames.some((frame) => frame.comments.includes("ping"))).toBe(true);
    expect(followSignal!.aborted).toBe(true);
  });

  it("大补播 600 条在 liveQueueMax=1 下完整送达且不报 slow_consumer", async () => {
    const events = Array.from({ length: 600 }, (_value, index) => envelope(index));
    const { url } = await startStream({
      header: header("open"),
      events,
      liveQueueMax: 1,
      followImpl: async function* () {
        return;
      },
    });

    const frames = await collectFrames(`${url}/api/events?sessionId=s1`);

    expect(frames.filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual(
      Array.from({ length: 600 }, (_value, index) => index),
    );
    expect(frames.some((frame) => frame.event === "stream_error")).toBe(false);
    expect(JSON.parse(frames.at(-1)!.data!)).toEqual({ lastSeq: 599 });
  });

  it("实时队列溢出返回 slow_consumer 且 lastSeq 不跳过未写出事件", async () => {
    const { url } = await startStream({
      header: header("open"),
      liveQueueMax: 1,
      followImpl: async function* (_sessionId, _since, signal) {
        for (let seq = 0; seq < 400; seq += 1) {
          if (signal.aborted) return;
          yield envelope(seq, "x".repeat(32 * 1024));
        }
      },
    });

    const res = await fetch(`${url}/api/events?sessionId=s1`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const frames: SseFrame[] = [];
    for await (const frame of readFrames(res.body!)) frames.push(frame);

    const errorFrame = frames.find((frame) => frame.event === "stream_error");
    expect(errorFrame).toBeDefined();
    const payload = JSON.parse(errorFrame!.data!) as { code: string; lastSeq: number };
    expect(payload.code).toBe("slow_consumer");
    expect(payload.lastSeq).toBeGreaterThanOrEqual(-1);
    const writtenIds = frames
      .filter((frame) => frame.id !== undefined)
      .map((frame) => frame.id!);
    expect(payload.lastSeq).toBe(writtenIds.at(-1) ?? -1);
    expect(frames.some((frame) => frame.event === "stream_end")).toBe(false);
  });

  it("实时阶段完全不读的客户端在写超时后收到 slow_consumer 并关闭", async () => {
    class StalledResponse extends EventEmitter {
      headersSent = false;
      destroyed = false;
      writableEnded = false;
      statusCode = 0;
      frames: string[] = [];

      writeHead(): this {
        this.headersSent = true;
        return this;
      }

      flushHeaders(): void {}

      setHeader(): void {}

      write(chunk: string): boolean {
        this.frames.push(String(chunk));
        // 实时数据帧永远写不出去;控制帧(stream_error)可以写出。
        if (String(chunk).startsWith("id: ")) return false;
        return true;
      }

      end(): void {
        this.writableEnded = true;
        this.emit("finish");
      }
    }

    const fake = fakeSource({
      header: header("open"),
      followImpl: async function* () {
        for (let seq = 0; seq < 100; seq += 1) {
          yield envelope(seq, "x".repeat(4 * 1024));
        }
      },
    });
    const req = Object.assign(new EventEmitter(), {
      url: "/api/events?sessionId=s1",
      method: "GET",
      headers: {},
      resume(): void {},
    });
    const res = new StalledResponse();
    const handler = createEventStreamHandler({
      eventSource: fake.source,
      liveQueueMax: 2,
      liveWriteTimeoutMs: 20,
      heartbeatMs: 1_000,
    });

    await Promise.race([
      handler(
        req as unknown as import("node:http").IncomingMessage,
        res as unknown as import("node:http").ServerResponse,
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("stalled live consumer did not end handler")), 1_000),
      ),
    ]);

    const errorFrame = res.frames.find((frame) => frame.includes("stream_error"));
    expect(errorFrame).toBeDefined();
    expect(JSON.parse(errorFrame!.split("data: ")[1]!)).toEqual({
      code: "slow_consumer",
      lastSeq: -1,
    });
    expect(res.writableEnded).toBe(true);
  });

  it("客户端断开触发 follow abort", async () => {
    let followSignal: AbortSignal | undefined;
    const { url } = await startStream({
      header: header("open"),
      followImpl: (_sessionId, _since, signal) => {
        followSignal = signal;
        return (async function* () {
          yield envelope(0);
          await waitUntilAborted(signal);
        })();
      },
    });

    const res = await fetch(`${url}/api/events?sessionId=s1`);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    for (let attempt = 0; attempt < 100 && !followSignal!.aborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(followSignal!.aborted).toBe(true);
  });

  it("补播 drain 等待期间 abort 立即停止写入并清理", async () => {
    const events = Array.from({ length: 200 }, (_value, index) =>
      envelope(index, "y".repeat(64 * 1024)),
    );
    const fake = fakeSource({ header: header("open"), events });
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const handler = createEventStreamHandler({ eventSource: fake.source });
    const url = await start(async (req, res) => {
      await handler(req, res);
      resolveDone?.();
    });

    const controller = new AbortController();
    clients.push(controller);
    const res = await fetch(`${url}/api/events?sessionId=s1`, { signal: controller.signal });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await Promise.race([
      done,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("abort during replay hung")), 2_000),
      ),
    ]);
    expect(fake.followCalls).toEqual([]);
  });

  it("补播写入超时后 handler 有界退出", async () => {
    const events = Array.from({ length: 200 }, (_value, index) =>
      envelope(index, "z".repeat(64 * 1024)),
    );
    const fake = fakeSource({ header: header("open"), events });
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const handler = createEventStreamHandler({
      eventSource: fake.source,
      heartbeatMs: 10,
      replayTimeoutMs: 30,
    });
    const url = await start(async (req, res) => {
      await handler(req, res);
      resolveDone?.();
    });

    const res = await fetch(`${url}/api/events?sessionId=s1`);
    expect(res.status).toBe(200);
    await Promise.race([
      done,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("replay timeout did not end handler")), 2_000),
      ),
    ]);
    expect(fake.followCalls).toEqual([]);
    await res.body?.cancel().catch(() => undefined);
  });

  it("closed 会话的 stream_end 写超时后 handler 有界退出", async () => {
    class NonReadingResponse extends EventEmitter {
      headersSent = false;
      destroyed = false;
      writableEnded = false;
      statusCode = 0;
      private writes = 0;

      writeHead(): this {
        this.headersSent = true;
        return this;
      }

      flushHeaders(): void {}

      setHeader(): void {}

      write(): boolean {
        this.writes += 1;
        return this.writes <= 2;
      }

      end(): void {
        this.writableEnded = true;
        this.emit("finish");
      }
    }

    const fake = fakeSource({ header: header("closed"), events: [envelope(0)] });
    const req = Object.assign(new EventEmitter(), {
      url: "/api/events?sessionId=s1",
      method: "GET",
      headers: {},
      resume(): void {},
    });
    const res = new NonReadingResponse();
    const handler = createEventStreamHandler({
      eventSource: fake.source,
      replayTimeoutMs: 20,
      heartbeatMs: 1_000,
    });

    await Promise.race([
      handler(
        req as unknown as import("node:http").IncomingMessage,
        res as unknown as import("node:http").ServerResponse,
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("stream_end 写超时未结束 handler")), 1_000),
      ),
    ]);
    expect(res.writableEnded).toBe(true);
    expect(fake.followCalls).toEqual([]);
  });

  it("open 会话尾部半行可通过详情接口读取，closed 仍报损坏", async () => {
    const home = makeHome();
    const sessionDir = path.join(home, "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, "session.v1.jsonl"),
      `${JSON.stringify({ seq: 0, ts: "t", type: "user", payload: { content: "hi" } })}\n{"seq":1`,
    );

    writeFileSync(
      path.join(sessionDir, "header.json"),
      JSON.stringify({ id: "s1", createdAt: "2026-10-20T00:00:00.000Z", status: "open" }),
    );
    const openUrl = await start(createApiHandler({ harnessHome: home }));
    const openRes = await fetch(`${openUrl}/api/sessions/s1`);
    expect(openRes.status).toBe(200);
    const openBody = (await openRes.json()) as { events: unknown[] };
    expect(openBody.events).toHaveLength(1);

    writeFileSync(
      path.join(sessionDir, "header.json"),
      JSON.stringify({ id: "s1", createdAt: "2026-10-20T00:00:00.000Z", status: "closed" }),
    );
    const closedUrl = await start(createApiHandler({ harnessHome: home }));
    const closedRes = await fetch(`${closedUrl}/api/sessions/s1`);
    expect(closedRes.status).toBe(500);
    expect(((await closedRes.json()) as { error: { code: string } }).error.code).toBe(
      "session_corrupt",
    );
  });
});