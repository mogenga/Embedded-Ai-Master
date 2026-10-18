import { describe, expect, it } from "vitest";
import {
  applyLoadFailure,
  applyLoadSuccess,
  applySessionFailure,
  applySessionLoaded,
  applyStreamError,
  applyStreamEvent,
  startLoad,
  startSessionSwitch,
} from "../../src/ui/state.js";
import type { WorkbenchState } from "../../src/ui/state.js";
import { UNKNOWN_DEVICE, makeTranscriptView } from "./support/builders.js";
import { emptyTranscriptView } from "../../src/ui/view/transcript.js";

function baseState(): WorkbenchState {
  return {
    connection: "ready",
    view: emptyTranscriptView(),
    sessions: [],
    kbTree: [],
    kbRoot: null,
    device: UNKNOWN_DEVICE,
  };
}

const LOADED = {
  sessions: [{ id: "s2", createdAt: "2026-10-18T21:40:00.000Z", status: "open" as const }],
  activeSessionId: "s2",
  view: { ...makeTranscriptView(), sessionId: "s2" },
  kbTree: [],
  kbRoot: null,
  device: UNKNOWN_DEVICE,
};

describe("workbench state", () => {
  it("开始加载清空错误但保留旧数据", () => {
    const state = startLoad({ ...baseState(), errorMessage: "旧错误", detailError: "详情错误" });
    expect(state.connection).toBe("loading");
    expect(state.errorMessage).toBeUndefined();
    expect(state.detailError).toBeUndefined();
  });

  it("加载成功写入会话、视图、KB 与设备", () => {
    const state = applyLoadSuccess(baseState(), LOADED);
    expect(state.connection).toBe("ready");
    expect(state.activeSessionId).toBe("s2");
    expect(state.view.sessionId).toBe("s2");
    expect(state.sessions.length).toBe(1);
    expect(state.switching).toBe(false);
  });

  it("加载成功时实时视图优先于回放", () => {
    const live = { ...makeTranscriptView(), sessionId: "live" };
    const state = applyLoadSuccess(baseState(), LOADED, live);
    expect(state.view.sessionId).toBe("live");
    expect(state.activeSessionId).toBe("s2");
  });

  it("加载成功且无会话时清除旧 activeSessionId", () => {
    const previous = { ...baseState(), activeSessionId: "s1" };
    const state = applyLoadSuccess(previous, { ...LOADED, activeSessionId: undefined, sessions: [] });
    expect(state.activeSessionId).toBeUndefined();
  });

  it("加载失败进入错误态并保留重试信息", () => {
    const state = applyLoadFailure(baseState(), "连接失败");
    expect(state.connection).toBe("error");
    expect(state.errorMessage).toBe("连接失败");
    expect(state.switching).toBe(false);
  });

  it("切换会话开始时不提前改标题且不污染全局连接态", () => {
    const state = startSessionSwitch({ ...baseState(), activeSessionId: "s1" });
    expect(state.activeSessionId).toBe("s1");
    expect(state.connection).toBe("ready");
    expect(state.switching).toBe(true);
  });

  it("会话加载成功后才切换 activeSessionId", () => {
    const state = applySessionLoaded(startSessionSwitch({ ...baseState(), activeSessionId: "s1" }), "s2", {
      ...makeTranscriptView(),
      sessionId: "s2",
    });
    expect(state.activeSessionId).toBe("s2");
    expect(state.view.sessionId).toBe("s2");
    expect(state.switching).toBe(false);
  });

  it("会话加载失败保留原 activeSessionId 并只设置详情错误", () => {
    const state = applySessionFailure({ ...baseState(), activeSessionId: "s1", switching: true }, "会话读取失败");
    expect(state.activeSessionId).toBe("s1");
    expect(state.connection).toBe("ready");
    expect(state.detailError).toBe("会话读取失败");
    expect(state.errorMessage).toBeUndefined();
  });

  it("实时事件清空错误并写入视图", () => {
    const view = makeTranscriptView();
    const state = applyStreamEvent({ ...baseState(), streamError: "断线" }, view);
    expect(state.view).toBe(view);
    expect(state.streamError).toBeUndefined();
    expect(state.connection).toBe("ready");
  });

  it("事件流错误只记录局部提示，不隐藏已有内容", () => {
    const view = makeTranscriptView();
    const state = applyStreamError({ ...baseState(), view }, "事件流中断");
    expect(state.view).toBe(view);
    expect(state.streamError).toBe("事件流中断");
    expect(state.connection).toBe("ready");
  });
});