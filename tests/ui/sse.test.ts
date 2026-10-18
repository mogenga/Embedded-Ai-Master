import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStream, postAction } from "../../src/ui/view/sse.js";
import type { LoopEvent } from "../../src/loop/events.js";

class FakeES {
  static instances: FakeES[] = [];
  url: string;
  handlers: Record<string, (e?: unknown) => void> = {};
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeES.instances.push(this);
  }
  addEventListener(k: string, fn: (e?: unknown) => void) {
    this.handlers[k] = fn;
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
  emit(k: string, data?: string) {
    if (data !== undefined) (this.handlers[k] as (e?: unknown) => void)({ data });
    else this.handlers[k]?.();
  }
}

class ThrowingES {
  constructor() {
    throw new Error("ctor boom");
  }
}

describe("sse", () => {
  beforeEach(() => {
    FakeES.instances = [];
  });

  it("message 事件解析为 LoopEvent 并分发", () => {
    const seen: LoopEvent[] = [];
    const s = createEventStream(
      "http://x/ev",
      { onEvent: (ev) => seen.push(ev) },
      { EventSourceCtor: FakeES as unknown as typeof EventSource, retryMs: 0 },
    );
    const es = FakeES.instances.at(-1)!;
    es.emit("message", JSON.stringify({ kind: "done", finishReason: "no_tool_calls" }));
    expect(seen).toEqual([{ kind: "done", finishReason: "no_tool_calls" }]);
    s.close();
  });

  it("非法 JSON 走 onError 不中断流", () => {
    const seen: unknown[] = [];
    const s = createEventStream(
      "http://x/ev",
      { onEvent: () => {}, onError: (e) => seen.push(e) },
      { EventSourceCtor: FakeES as unknown as typeof EventSource, retryMs: 0 },
    );
    const es = FakeES.instances.at(-1)!;
    es.emit("message", "{bad json");
    expect(seen.length).toBe(1);
    expect(es.closed).toBe(false);
    s.close();
  });

  it("close 后不再重连", async () => {
    const s = createEventStream(
      "http://x/ev",
      { onEvent: () => {} },
      { EventSourceCtor: FakeES as unknown as typeof EventSource, retryMs: 1 },
    );
    const es = FakeES.instances.at(-1)!;
    s.close();
    s.close();
    es.emit("error");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeES.instances.length).toBe(1);
  });

  it("连续 error 只调度一次重连", async () => {
    const s = createEventStream(
      "http://x/ev",
      { onEvent: () => {} },
      { EventSourceCtor: FakeES as unknown as typeof EventSource, retryMs: 5 },
    );
    const es = FakeES.instances.at(-1)!;
    es.emit("error");
    es.emit("error");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(FakeES.instances.length).toBeLessThanOrEqual(2);
    s.close();
  });

  it("close 后 error 不调用 onError", () => {
    const seen: unknown[] = [];
    const s = createEventStream(
      "http://x/ev",
      { onEvent: () => {}, onError: (e) => seen.push(e) },
      { EventSourceCtor: FakeES as unknown as typeof EventSource, retryMs: 5 },
    );
    const es = FakeES.instances.at(-1)!;
    s.close();
    es.emit("error");
    expect(seen).toHaveLength(0);
  });

  it("EventSource 构造抛错转 onError 且不逃逸", () => {
    const seen: unknown[] = [];
    expect(() =>
      createEventStream(
        "http://x/ev",
        { onEvent: () => {}, onError: (e) => seen.push(e) },
        { EventSourceCtor: ThrowingES as unknown as typeof EventSource, retryMs: 5 },
      ),
    ).not.toThrow();
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toContain("ctor boom");
  });

  it("postAction 成功与失败", async () => {
    const okFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await postAction("http://x/a", { v: 1 }, { fetchImpl: okFetch as unknown as typeof fetch })).toEqual({ ok: 1 });
    const badFetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(postAction("http://x/a", {}, { fetchImpl: badFetch as unknown as typeof fetch })).rejects.toMatchObject({
      code: "http_error",
      status: 500,
    });
  });
});