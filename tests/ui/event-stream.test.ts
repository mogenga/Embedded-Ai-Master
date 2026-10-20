import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionEventStream } from "../../src/ui/api/event-stream.js";
import type { SessionEventEnvelope } from "../../src/session/types.js";

type Handler = (event: Event | MessageEvent) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly listeners = new Map<string, Set<Handler>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    const set = this.listeners.get(type) ?? new Set<Handler>();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: Handler): void {
    this.listeners.get(type)?.delete(handler);
  }

  close(): void {
    this.closed = true;
  }

  dispatch(type: string, data?: unknown): void {
    const event =
      data === undefined
        ? new Event(type)
        : ({ data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent);
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }

  search(): URLSearchParams {
    return new URL(this.url, "http://127.0.0.1").searchParams;
  }

  static get current(): FakeEventSource {
    const item = FakeEventSource.instances.at(-1);
    if (item === undefined) throw new Error("FakeEventSource 尚未创建");
    return item;
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

const Ctor = FakeEventSource as unknown as typeof EventSource;

function envelope(seq: number, sessionId = "s1", type = "user"): SessionEventEnvelope {
  return { sessionId, seq, ts: "t", type: type as SessionEventEnvelope["type"], payload: { content: `ev-${seq}` } };
}

interface Recorder {
  events: SessionEventEnvelope[];
  opens: number;
  errors: number;
  gaps: number;
  ends: number;
}

function recorder(): Recorder {
  return { events: [], opens: 0, errors: 0, gaps: 0, ends: 0 };
}

function handlers(rec: Recorder) {
  return {
    onEvent: (event: SessionEventEnvelope) => {
      rec.events.push(event);
    },
    onOpen: () => {
      rec.opens += 1;
    },
    onError: () => {
      rec.errors += 1;
    },
    onGap: () => {
      rec.gaps += 1;
    },
    onEnd: () => {
      rec.ends += 1;
    },
  };
}

function open(url: string, initialSince: number, rec: Recorder, retryMs = 10) {
  return createSessionEventStream({
    url,
    sessionId: "s1",
    initialSince,
    handlers: handlers(rec),
    deps: { EventSourceCtor: Ctor, retryMs },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
});

afterEach(() => {
  vi.useRealTimers();
  FakeEventSource.reset();
});

describe("session event stream", () => {
  it("用 URL/searchParams 合并 sessionId 与 initialSince 并保留既有查询参数", () => {
    open("http://127.0.0.1:5174/api/events?sessionId=old&foo=1", 7, recorder());
    const search = FakeEventSource.current.search();
    expect(search.get("sessionId")).toBe("s1");
    expect(search.get("since")).toBe("7");
    expect(search.get("foo")).toBe("1");
  });

  it("流独占游标：重复丢弃、连续交付、缺口触发 onGap 并停止重连", async () => {
    const rec = recorder();
    open("/api/events?x=1", 5, rec);
    const source = FakeEventSource.current;

    source.dispatch("message", envelope(5));
    source.dispatch("message", envelope(6));
    expect(rec.events.map((event) => event.seq)).toEqual([6]);

    source.dispatch("message", envelope(8));
    expect(rec.gaps).toBe(1);
    expect(source.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(rec.errors).toBe(0);
  });

  it("重连使用流自己的最新 lastSeq", async () => {
    const rec = recorder();
    open("/api/events", -1, rec);
    FakeEventSource.current.dispatch("message", envelope(0));
    FakeEventSource.current.dispatch("message", envelope(1));
    FakeEventSource.current.dispatch("error");

    await vi.advanceTimersByTimeAsync(20);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.current.search().get("since")).toBe("1");
    expect(rec.events.map((event) => event.seq)).toEqual([0, 1]);
  });

  it("stream_end 后停止并不再重连，onEnd 与 onError 分开", async () => {
    const rec = recorder();
    open("/api/events", -1, rec);
    const source = FakeEventSource.current;
    source.dispatch("message", envelope(0));
    source.dispatch("stream_end", { lastSeq: 0 });
    expect(rec.ends).toBe(1);
    expect(source.closed).toBe(true);

    source.dispatch("error");
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(rec.errors).toBe(0);
  });

  it("onerror 最多重连 3 次，超过上限进入终态 onError", async () => {
    const rec = recorder();
    open("/api/events", -1, rec);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failing = FakeEventSource.current;
      failing.dispatch("error");
      await vi.advanceTimersByTimeAsync(20);
      expect(failing.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(attempt + 2);
    }

    const terminal = FakeEventSource.current;
    terminal.dispatch("error");
    await vi.advanceTimersByTimeAsync(20);
    expect(terminal.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(4);
    expect(rec.errors).toBe(1);
  });

  it("onOpen 重置重连计数", async () => {
    const rec = recorder();
    open("/api/events", -1, rec);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      FakeEventSource.current.dispatch("error");
      await vi.advanceTimersByTimeAsync(20);
      FakeEventSource.current.dispatch("open");
      expect(rec.opens).toBe(attempt + 1);
    }

    FakeEventSource.current.dispatch("error");
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeEventSource.instances).toHaveLength(5);
    expect(rec.errors).toBe(0);
  });

  it("stream_error 也按重连上限处理", async () => {
    const rec = recorder();
    open("/api/events", -1, rec);
    FakeEventSource.current.dispatch("stream_error", { code: "session_corrupt", lastSeq: -1 });
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(rec.gaps).toBe(0);
  });

  it("非法 JSON 走 onError 且不再重连", async () => {
    const rec = recorder();
    open("/api/events", -1, rec);
    FakeEventSource.current.dispatch("message", "{not-json");
    expect(rec.errors).toBe(1);
    expect(FakeEventSource.current.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("忽略 sessionId 不匹配的事件", () => {
    const rec = recorder();
    open("/api/events", -1, rec);
    FakeEventSource.current.dispatch("message", envelope(0, "other"));
    FakeEventSource.current.dispatch("message", envelope(0, "s1"));
    expect(rec.events.map((event) => event.seq)).toEqual([0]);
  });

  it("gap 一旦触发只回调一次，后续事件不再推进游标", () => {
    const rec = recorder();
    open("/api/events", -1, rec);
    const source = FakeEventSource.current;
    source.dispatch("message", envelope(1));
    expect(rec.gaps).toBe(1);
    source.dispatch("message", envelope(3));
    source.dispatch("error");
    expect(rec.gaps).toBe(1);
    expect(rec.errors).toBe(0);
    expect(rec.events).toEqual([]);
  });

  it("调用方按新 lastSeq 重开后可继续且不重复", () => {
    const rec = recorder();
    open("/api/events?foo=1", -1, rec);
    FakeEventSource.current.dispatch("message", envelope(0));
    FakeEventSource.current.dispatch("message", envelope(1));
    FakeEventSource.current.dispatch("error");
    vi.advanceTimersByTime(20);
    FakeEventSource.current.dispatch("message", envelope(1, "s1"));
    FakeEventSource.current.dispatch("message", envelope(2));
    expect(rec.events.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it("旧连接迟到的 stream_end 不影响已重连的新连接", async () => {
    const rec = recorder();
    open("/api/events", -1, rec);
    const stale = FakeEventSource.current;
    stale.dispatch("error");
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeEventSource.instances).toHaveLength(2);

    stale.dispatch("stream_end", { lastSeq: 0 });
    expect(rec.ends).toBe(0);
    expect(FakeEventSource.current.closed).toBe(false);
  });

  it("onEvent 抛错进入终态 onError，不静默消费该事件", () => {
    const rec = recorder();
    createSessionEventStream({
      url: "/api/events",
      sessionId: "s1",
      initialSince: -1,
      handlers: {
        ...handlers(rec),
        onEvent: () => {
          throw new Error("consumer boom");
        },
      },
      deps: { EventSourceCtor: Ctor, retryMs: 10 },
    });
    const source = FakeEventSource.current;
    source.dispatch("message", envelope(0));
    expect(rec.errors).toBe(1);
    expect(source.closed).toBe(true);
    source.dispatch("message", envelope(0));
    expect(rec.errors).toBe(1);
  });

  it("close 清理待重连 timer 且不再回调", async () => {
    const rec = recorder();
    const stream = open("/api/events", -1, rec);
    FakeEventSource.current.dispatch("error");
    stream.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(rec.errors).toBe(0);
  });
});