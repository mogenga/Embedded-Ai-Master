import { describe, expect, it, vi } from "vitest";
import type { SessionEventEnvelope } from "../../src/session/types.js";
import type {
  SessionEventStream,
  SessionEventStreamHandlers,
} from "../../src/ui/api/event-stream.js";
import type { LoadedSession } from "../../src/ui/api/load.js";
import { createSessionStreamController } from "../../src/ui/api/session-stream.js";
import { UNKNOWN_DEVICE } from "../../src/ui/view/device.js";
import { emptyTranscriptView } from "../../src/ui/view/transcript.js";

interface FakeStream {
  id: string;
  since: number;
  handlers: SessionEventStreamHandlers;
  closed: boolean;
  close(): void;
}

function loaded(id: string, lastSeq: number, device = UNKNOWN_DEVICE): LoadedSession {
  return {
    view: { ...emptyTranscriptView(), sessionId: id },
    events: [],
    lastSeq,
    device,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(autoResolve?: (id: string) => number) {
  const opened: FakeStream[] = [];
  const pendingLoads: Array<{ id: string; resolve: (value: LoadedSession) => void; reject: (error: unknown) => void }> = [];
  const loadSession = vi.fn((id: string) => {
    if (autoResolve !== undefined) return Promise.resolve(loaded(id, autoResolve(id)));
    return new Promise<LoadedSession>((resolve, reject) => {
      pendingLoads.push({ id, resolve, reject });
    });
  });
  const onLoaded = vi.fn();
  const onError = vi.fn();
  const onLoadError = vi.fn();
  const onEvent = vi.fn<(id: string, event: SessionEventEnvelope) => void>();
  const controller = createSessionStreamController({
    loadSession,
    openStream: (id, since, handlers) => {
      const stream: FakeStream = {
        id,
        since,
        handlers,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      opened.push(stream);
      return stream as SessionEventStream;
    },
    onEvent,
    onError,
    onLoadError,
    onLoaded,
  });
  return { opened, pendingLoads, loadSession, onLoaded, onError, onLoadError, onEvent, controller };
}

describe("session stream controller", () => {
  it("gap 关闭旧流、只重拉一次、按新 lastSeq 重开", async () => {
    const h = harness();
    h.controller.start("s1", -1);
    expect(h.opened).toHaveLength(1);

    h.opened[0].handlers.onGap?.();
    expect(h.opened[0].closed).toBe(true);
    expect(h.loadSession).toHaveBeenCalledTimes(1);
    expect(h.loadSession).toHaveBeenCalledWith("s1");

    h.pendingLoads[0].resolve(loaded("s1", 5));
    await flush();

    expect(h.onLoaded).toHaveBeenCalledWith("s1", expect.objectContaining({ lastSeq: 5 }));
    expect(h.opened).toHaveLength(2);
    expect(h.opened[1].since).toBe(5);
  });

  it("重拉期间并发 gap 只额外排队一次", async () => {
    const h = harness();
    h.controller.start("s1", -1);
    h.opened[0].handlers.onGap?.();
    h.opened[0].handlers.onGap?.();
    h.opened[0].handlers.onGap?.();
    expect(h.loadSession).toHaveBeenCalledTimes(1);

    h.pendingLoads[0].resolve(loaded("s1", 5));
    await flush();
    expect(h.opened).toHaveLength(2);
    expect(h.opened[1].closed).toBe(true);
    expect(h.loadSession).toHaveBeenCalledTimes(2);

    h.pendingLoads[1].resolve(loaded("s1", 8));
    await flush();
    expect(h.opened).toHaveLength(3);
    expect(h.opened[2].since).toBe(8);
  });

  it("切换会话后旧会话的重拉结果被丢弃，且新会话 gap 不被阻塞", async () => {
    const h = harness();
    h.controller.start("s1", -1);
    h.opened[0].handlers.onGap?.();
    expect(h.loadSession).toHaveBeenCalledTimes(1);

    h.controller.start("s2", -1);
    h.opened[1].handlers.onGap?.();
    expect(h.loadSession).toHaveBeenCalledTimes(2);
    expect(h.loadSession).toHaveBeenLastCalledWith("s2");

    h.pendingLoads[0].resolve(loaded("s1", 3));
    await flush();
    expect(h.onLoaded).not.toHaveBeenCalledWith("s1", expect.anything());
    expect(h.opened).toHaveLength(2);

    h.pendingLoads[1].resolve(loaded("s2", 7));
    await flush();
    expect(h.onLoaded).toHaveBeenCalledWith("s2", expect.objectContaining({ lastSeq: 7 }));
    expect(h.opened).toHaveLength(3);
    expect(h.opened[2].id).toBe("s2");
    expect(h.opened[2].since).toBe(7);
  });

  it("同一会话连续 gap 超过上限后上抛 streamError 并停止重拉", async () => {
    let seq = 0;
    const h = harness(() => {
      seq += 1;
      return seq;
    });
    h.controller.start("s1", -1);

    for (let index = 0; index < 3; index += 1) {
      h.opened.at(-1)!.handlers.onGap?.();
      await flush();
    }
    expect(h.opened).toHaveLength(4);
    expect(h.onError).not.toHaveBeenCalled();

    h.opened.at(-1)!.handlers.onGap?.();
    await flush();
    expect(h.opened).toHaveLength(4);
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledWith("s1", expect.stringContaining("缺口"));

    h.controller.start("s1", -1);
    h.opened.at(-1)!.handlers.onGap?.();
    await flush();
    expect(h.opened).toHaveLength(6);
    expect(h.onError).toHaveBeenCalledTimes(1);
  });

  it("重拉失败走 onLoadError，不吞错", async () => {
    const h = harness();
    h.controller.start("s1", -1);
    h.opened[0].handlers.onGap?.();
    h.pendingLoads[0].reject(new Error("boom"));
    await flush();
    expect(h.onLoadError).toHaveBeenCalledWith("s1", expect.any(Error));
    expect(h.onLoaded).not.toHaveBeenCalled();
  });

  it("close 后 gap 与事件均不再回调", async () => {
    const h = harness();
    h.controller.start("s1", -1);
    const stream = h.opened[0];
    h.controller.close();
    stream.handlers.onGap?.();
    stream.handlers.onEvent?.({
      sessionId: "s1",
      seq: 0,
      ts: "t",
      type: "user",
      payload: {},
    });
    await flush();
    expect(h.loadSession).not.toHaveBeenCalled();
    expect(h.onEvent).not.toHaveBeenCalled();
  });
});