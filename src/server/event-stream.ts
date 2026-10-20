import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionEventEnvelope, SessionEventSource } from "../events/types.js";
import { SessionNotFoundError } from "../events/types.js";
import { SessionCorruptionError } from "../session/errors.js";
import { isValidSessionId } from "../session/handle.js";
import { HttpError, sendError } from "./http.js";

export interface EventStreamOptions {
  eventSource: SessionEventSource;
  retryMs?: number;
  heartbeatMs?: number;
  liveQueueMax?: number;
  replayTimeoutMs?: number;
}

const DEFAULT_RETRY_MS = 3_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_LIVE_QUEUE_MAX = 500;

type WriteOutcome = "ok" | "aborted" | "error" | "timeout";

interface RequestCursor {
  sessionId: string;
  since: number;
}

function parseCursor(raw: string): number | undefined {
  if (!/^-?\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < -1) return undefined;
  return value;
}

function resolveCursor(req: IncomingMessage, url: URL): number {
  if (url.searchParams.has("since")) {
    const raw = url.searchParams.get("since") ?? "";
    const value = parseCursor(raw);
    if (value === undefined) {
      throw new HttpError(400, "invalid_cursor", "since 必须是不小于 -1 的整数");
    }
    return value;
  }
  const rawHeader = req.headers["last-event-id"];
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (header !== undefined) {
    const value = parseCursor(header);
    if (value === undefined) {
      throw new HttpError(400, "invalid_cursor", "Last-Event-ID 必须是不小于 -1 的整数");
    }
    return value;
  }
  return -1;
}

function parseRequest(req: IncomingMessage): RequestCursor {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId === null || !isValidSessionId(sessionId)) {
    throw new HttpError(400, "invalid_session_id", "非法的会话 id");
  }
  return { sessionId, since: resolveCursor(req, url) };
}

function readFailure(error: unknown): HttpError {
  if (error instanceof SessionNotFoundError) {
    return new HttpError(404, "session_not_found", "会话不存在");
  }
  if (error instanceof SessionCorruptionError) {
    return new HttpError(500, "session_corrupt", "会话数据损坏");
  }
  return new HttpError(500, "internal_error", "内部错误");
}

function followFailure(error: unknown): string {
  return error instanceof SessionCorruptionError ? "session_corrupt" : "internal_error";
}

function eventFrame(event: SessionEventEnvelope): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamEndFrame(lastSeq: number): string {
  return `event: stream_end\ndata: ${JSON.stringify({ lastSeq })}\n\n`;
}

function streamErrorFrame(code: string, lastSeq: number): string {
  return `event: stream_error\ndata: ${JSON.stringify({ code, lastSeq })}\n\n`;
}

function writeBlock(
  res: ServerResponse,
  text: string,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<WriteOutcome> {
  if (signal.aborted) return Promise.resolve("aborted");
  let accepted: boolean;
  try {
    accepted = res.write(text);
  } catch {
    return Promise.resolve("error");
  }
  if (accepted) return Promise.resolve(signal.aborted ? "aborted" : "ok");
  return new Promise<WriteOutcome>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: WriteOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onDrain = (): void => finish("ok");
    const onClose = (): void => finish("aborted");
    const onAbort = (): void => finish("aborted");
    res.on("drain", onDrain);
    res.on("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => finish("timeout"), timeoutMs);
      timer.unref?.();
    }
  });
}

type FollowOutcome =
  | { kind: "ended" }
  | { kind: "aborted" }
  | { kind: "overflow" }
  | { kind: "error"; error: unknown };

export function createEventStreamHandler(
  opts: EventStreamOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const retryMs =
    opts.retryMs !== undefined && Number.isFinite(opts.retryMs) && opts.retryMs >= 0
      ? Math.floor(opts.retryMs)
      : DEFAULT_RETRY_MS;
  const heartbeatMs =
    opts.heartbeatMs !== undefined && Number.isFinite(opts.heartbeatMs) && opts.heartbeatMs > 0
      ? Math.floor(opts.heartbeatMs)
      : DEFAULT_HEARTBEAT_MS;
  const liveQueueMax =
    opts.liveQueueMax !== undefined && Number.isFinite(opts.liveQueueMax) && opts.liveQueueMax >= 1
      ? Math.floor(opts.liveQueueMax)
      : DEFAULT_LIVE_QUEUE_MAX;
  const replayTimeoutMs =
    opts.replayTimeoutMs !== undefined
    && Number.isFinite(opts.replayTimeoutMs)
    && opts.replayTimeoutMs > 0
      ? Math.floor(opts.replayTimeoutMs)
      : Math.max(1, heartbeatMs * 2);

  return async function handler(req, res): Promise<void> {
    let cursor: RequestCursor;
    try {
      cursor = parseRequest(req);
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      sendError(res, 500, "internal_error", "内部错误");
      return;
    }

    let snapshot: Awaited<ReturnType<SessionEventSource["read"]>>;
    try {
      snapshot = await opts.eventSource.read(cursor.sessionId, cursor.since);
    } catch (error) {
      const failure = readFailure(error);
      if (!res.headersSent && !res.destroyed) {
        sendError(res, failure.status, failure.code, failure.message);
      }
      return;
    }
    if (res.destroyed) return;

    const controller = new AbortController();
    const abort = (): void => {
      if (!controller.signal.aborted) controller.abort();
    };
    req.on("aborted", abort);
    req.on("error", abort);
    res.on("error", abort);
    res.on("close", abort);
    const signal = controller.signal;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const sessionId = cursor.sessionId;
    const headSeq =
      Number.isSafeInteger(snapshot.headSeq) && snapshot.headSeq >= -1
        ? snapshot.headSeq
        : -1;
    let writtenSeq = Math.min(cursor.since, headSeq);
    let aborted = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let producer: Promise<void> | undefined;

    try {
      heartbeat = setInterval(() => {
        if (signal.aborted) return;
        try {
          res.write(": ping\n\n");
        } catch {
          abort();
        }
      }, heartbeatMs);
      heartbeat.unref?.();

      const retryOutcome = await writeBlock(res, `retry: ${retryMs}\n\n`, signal, replayTimeoutMs);
      if (retryOutcome !== "ok") {
        aborted = true;
        if (retryOutcome === "timeout") abort();
        return;
      }

      for (const event of snapshot.events) {
        if (signal.aborted) {
          aborted = true;
          break;
        }
        if (event.seq <= writtenSeq) continue;
        const outcome = await writeBlock(res, eventFrame(event), signal, replayTimeoutMs);
        if (outcome !== "ok") {
          aborted = true;
          if (outcome === "timeout") abort();
          return;
        }
        writtenSeq = event.seq;
      }
      if (aborted) return;

      if (snapshot.header.status === "closed") {
        const outcome = await writeBlock(res, streamEndFrame(writtenSeq), signal, replayTimeoutMs);
        if (outcome !== "ok") aborted = true;
        if (outcome === "timeout") abort();
        return;
      }

      const queue: SessionEventEnvelope[] = [];
      let wake: (() => void) | undefined;
      let producerDone = false;
      let overflowed = false;
      let followError: unknown;

      const notify = (): void => {
        const pending = wake;
        wake = undefined;
        pending?.();
      };

      producer = (async () => {
        try {
          for await (const event of opts.eventSource.follow(sessionId, writtenSeq, signal)) {
            if (signal.aborted) break;
            if (event.seq <= writtenSeq) continue;
            if (queue.length >= liveQueueMax) {
              overflowed = true;
              break;
            }
            queue.push(event);
            notify();
          }
        } catch (error) {
          followError = error;
        } finally {
          producerDone = true;
          notify();
        }
      })();

      const waitForWork = (): Promise<void> =>
        new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", finish);
            resolve();
          };
          wake = finish;
          if (signal.aborted) {
            finish();
            return;
          }
          signal.addEventListener("abort", finish, { once: true });
        });

      const consume = async (): Promise<FollowOutcome> => {
        for (;;) {
          if (signal.aborted) return { kind: "aborted" };
          if (overflowed) return { kind: "overflow" };
          const event = queue.shift();
          if (event === undefined) {
            if (producerDone) {
              if (followError !== undefined) return { kind: "error", error: followError };
              return { kind: "ended" };
            }
            await waitForWork();
            continue;
          }
          if (event.seq <= writtenSeq) continue;
          const outcome = await writeBlock(res, eventFrame(event), signal);
          if (outcome === "aborted") return { kind: "aborted" };
          if (outcome === "error") {
            return { kind: "error", error: new Error("SSE write failed") };
          }
          writtenSeq = event.seq;
        }
      };

      const outcome = await consume();
      if (outcome.kind === "aborted") {
        aborted = true;
        return;
      }
      if (outcome.kind === "overflow") {
        const errorOutcome = await writeBlock(
          res,
          streamErrorFrame("slow_consumer", writtenSeq),
          signal,
          replayTimeoutMs,
        );
        if (errorOutcome === "timeout") abort();
        return;
      }
      if (outcome.kind === "error") {
        const errorOutcome = await writeBlock(
          res,
          streamErrorFrame(followFailure(outcome.error), writtenSeq),
          signal,
          replayTimeoutMs,
        );
        if (errorOutcome === "timeout") abort();
        return;
      }
      const finalOutcome = await writeBlock(res, streamEndFrame(writtenSeq), signal, replayTimeoutMs);
      if (finalOutcome !== "ok") aborted = true;
      if (finalOutcome === "timeout") abort();
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      controller.abort();
      if (producer !== undefined) {
        producer.catch(() => undefined);
        await producer.catch(() => undefined);
      }
      req.off("aborted", abort);
      req.off("error", abort);
      res.off("error", abort);
      res.off("close", abort);
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          void 0;
        }
      }
      void aborted;
    }
  };
}