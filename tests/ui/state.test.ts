import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionEventEnvelope } from "../../src/session/types.js";
import {
  applyLoadFailure,
  applyLoadSuccess,
  applyNewSession,
  applySessionEvent,
  applySessionFailure,
  applySessionLoaded,
  applyStreamError,
  RequestGate,
  retryTarget,
  startLoad,
  startSessionSwitch,
} from "../../src/ui/state.js";
import type { LoadedWorkbench } from "../../src/ui/api/load.js";
import type { WorkbenchState } from "../../src/ui/state.js";
import { deviceFromSession } from "../../src/ui/view/device.js";
import { emptyTranscriptView, transcriptFromSession } from "../../src/ui/view/transcript.js";
import { UNKNOWN_DEVICE, makeSessionEvents } from "./support/builders.js";

function baseState(): WorkbenchState {
  return {
    connection: "ready",
    view: emptyTranscriptView(),
    sessions: [],
    kbTree: [],
    kbRoot: null,
    device: UNKNOWN_DEVICE,
    events: [],
    lastSeq: -1,
    mcpStatuses: [],
  };
}

const EVENTS = makeSessionEvents();

const LOADED: LoadedWorkbench = {
  sessions: [{ id: "s2", createdAt: "2026-10-18T21:40:00.000Z", status: "open" as const }],
  errors: [],
  activeSessionId: "s2",
  view: { ...transcriptFromSession(EVENTS), sessionId: "s2" },
  events: EVENTS,
  lastSeq: EVENTS.at(-1)!.seq,
  kbTree: [],
  kbRoot: null,
  device: { probe: "attached", serial: "open", cpu: "halted", backend: "renode" },
  deviceFallback: { probe: "OpenOCD", serial: "COM3", cpu: "Cortex-M4", backend: "Renode" },
};

function loadedSession(id: string, events: SessionEvent[] = []) {
  return {
    view: { ...transcriptFromSession(events), sessionId: id },
    events,
    lastSeq: events.at(-1)?.seq ?? -1,
    device: deviceFromSession(events),
  };
}

function envelope(event: SessionEvent, sessionId = "s2"): SessionEventEnvelope {
  return { ...event, sessionId };
}

const DEVICE_EVENT: SessionEvent = {
  seq: 50,
  ts: "t",
  type: "device_status",
  payload: { callId: "c1", server: "probe", tool: "mcp__probe__attach", state: { probe: "attached" } },
};

describe("workbench state", () => {
  it("开始加载清空错误但保留旧数据", () => {
    const state = startLoad({ ...baseState(), errorMessage: "旧错误", detailError: "详情错误" });
    expect(state.connection).toBe("loading");
    expect(state.errorMessage).toBeUndefined();
    expect(state.detailError).toBeUndefined();
  });

  it("加载成功写入会话、事件、游标、视图、KB 与设备", () => {
    const state = applyLoadSuccess(baseState(), LOADED);
    expect(state.connection).toBe("ready");
    expect(state.activeSessionId).toBe("s2");
    expect(state.view.sessionId).toBe("s2");
    expect(state.events).toBe(LOADED.events);
    expect(state.lastSeq).toBe(12);
    expect(state.sessions.length).toBe(1);
    expect(state.switching).toBe(false);
    expect(state.device.probe).toBe("attached");
  });

  it("加载成功清除上一次的发送错误，避免串到其他会话", () => {
    const state = applyLoadSuccess({ ...baseState(), sendError: "发送失败（HTTP 409）：会话忙" }, LOADED);
    expect(state.sendError).toBeUndefined();
    const switched = applySessionLoaded(
      { ...baseState(), sendError: "发送失败（HTTP 409）：会话忙" },
      "s2",
      loadedSession("s2", EVENTS),
    );
    expect(switched.sendError).toBeUndefined();
  });

  it("加载成功且无会话时清除旧 activeSessionId", () => {
    const previous = { ...baseState(), activeSessionId: "s1" };
    const state = applyLoadSuccess(previous, {
      ...LOADED,
      activeSessionId: undefined,
      sessions: [],
      events: [],
      lastSeq: -1,
    });
    expect(state.activeSessionId).toBeUndefined();
    expect(state.events).toEqual([]);
    expect(state.lastSeq).toBe(-1);
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

  it("会话加载成功后才切换 activeSessionId 并写入事件", () => {
    const events = makeSessionEvents().slice(0, 2);
    const state = applySessionLoaded(
      startSessionSwitch({ ...baseState(), activeSessionId: "s1" }),
      "s2",
      loadedSession("s2", events),
    );
    expect(state.activeSessionId).toBe("s2");
    expect(state.view.sessionId).toBe("s2");
    expect(state.events).toBe(events);
    expect(state.lastSeq).toBe(2);
    expect(state.switching).toBe(false);
  });

  it("切换会话重置 events/lastSeq/device/mcpStatuses", () => {
    const previous: WorkbenchState = {
      ...baseState(),
      activeSessionId: "s1",
      events: [DEVICE_EVENT],
      lastSeq: 50,
      device: { probe: "attached", serial: "open", cpu: "halted", backend: "renode" },
      mcpStatuses: [{ kind: "connected", server: "echo" }],
    };
    const state = applySessionLoaded(previous, "s2", loadedSession("s2"));
    expect(state.events).toEqual([]);
    expect(state.lastSeq).toBe(-1);
    expect(state.device).toEqual(UNKNOWN_DEVICE);
    expect(state.mcpStatuses).toEqual([]);
  });

  it("无 device_status 时切换到会话保留初始 /api/device 回退值", () => {
    const fallback = { probe: "OpenOCD", serial: "COM3", cpu: "Cortex-M4", backend: "Renode" };
    const state = applySessionLoaded(baseState(), "s2", { ...loadedSession("s2"), device: fallback });
    expect(state.device).toEqual(fallback);
  });


  it("会话加载失败保留原 activeSessionId 并只设置详情错误", () => {
    const state = applySessionFailure(
      { ...baseState(), activeSessionId: "s1", switching: true },
      "s2",
      "会话读取失败",
    );
    expect(state.activeSessionId).toBe("s1");
    expect(state.connection).toBe("ready");
    expect(state.detailError).toBe("会话读取失败");
    expect(state.failedSessionId).toBe("s2");
    expect(state.errorMessage).toBeUndefined();
  });

  it("重试目标优先指向失败会话，加载成功后回到全量加载", () => {
    const failed = applySessionFailure({ ...baseState(), activeSessionId: "s1" }, "s2", "会话读取失败");
    expect(retryTarget(failed)).toEqual({ kind: "session", id: "s2" });
    expect(retryTarget(applySessionLoaded(failed, "s2", loadedSession("s2")))).toEqual({ kind: "load" });
    expect(retryTarget(startLoad(failed))).toEqual({ kind: "load" });
    expect(retryTarget(applyLoadFailure(failed, "连接失败"))).toEqual({ kind: "load" });
  });

  it("切换开始清除旧的详情错误与失败会话", () => {
    const failed = applySessionFailure(baseState(), "s2", "会话读取失败");
    const state = startSessionSwitch(failed);
    expect(state.detailError).toBeUndefined();
    expect(state.failedSessionId).toBeUndefined();
  });

  it("实时事件合并进同一数组并推进游标与视图", () => {
    const state = applySessionEvent(
      { ...baseState(), activeSessionId: "s2", lastSeq: -1 },
      envelope({ seq: 0, ts: "t", type: "user", payload: { content: "症状" } }),
    );
    expect(state.events.map((event) => event.seq)).toEqual([0]);
    expect(state.lastSeq).toBe(0);
    expect(state.view.events[0]).toMatchObject({ kind: "user", text: "症状" });
  });

  it("忽略 sessionId 不匹配的实时事件（旧流串台）", () => {
    const before: WorkbenchState = { ...baseState(), activeSessionId: "s2", lastSeq: 3 };
    const after = applySessionEvent(
      before,
      envelope({ seq: 4, ts: "t", type: "user", payload: { content: "别的会话" } }, "s1"),
    );
    expect(after).toBe(before);
  });

  it("忽略已消费序号的重复事件", () => {
    const before: WorkbenchState = { ...baseState(), activeSessionId: "s2", lastSeq: 3 };
    const after = applySessionEvent(
      before,
      envelope({ seq: 3, ts: "t", type: "user", payload: { content: "重复" } }),
    );
    expect(after).toBe(before);
  });

  it("device_status 按 patch 更新设备面板", () => {
    const first = applySessionEvent(
      { ...baseState(), activeSessionId: "s2", lastSeq: 49 },
      envelope(DEVICE_EVENT),
    );
    expect(first.device.probe).toBe("attached");
    expect(first.device.serial).toBe("unknown");
    const second = applySessionEvent(
      first,
      envelope({
        seq: 51,
        ts: "t",
        type: "device_status",
        payload: { callId: "c2", server: "serial", tool: "mcp__serial__open", state: { serial: "open" } },
      }),
    );
    expect(second.device).toEqual({ probe: "attached", serial: "open", cpu: "unknown", backend: "unknown" });
  });

  it("mcp_status 与旧 status(mcp_*) 映射进 mcpStatuses 且不重复", () => {
    const events: SessionEvent[] = [
      { seq: 0, ts: "t", type: "mcp_status", payload: { kind: "connected", server: "echo" } },
      { seq: 1, ts: "t", type: "status", payload: { status: "mcp_tools_changed", server: "echo", toolCount: 3 } },
    ];
    const state = events.reduce<WorkbenchState>(
      (current, event) => applySessionEvent(current, envelope(event)),
      { ...baseState(), activeSessionId: "s2", lastSeq: -1 },
    );
    expect(state.mcpStatuses).toEqual([
      { kind: "connected", server: "echo" },
      { kind: "tools_changed", server: "echo", toolCount: 3 },
    ]);
  });

  it("mcp statuses 只保留最新 N 条", () => {
    const events: SessionEvent[] = Array.from({ length: 30 }, (_, index) => ({
      seq: index,
      ts: "t",
      type: "mcp_status",
      payload: { kind: "connected", server: `s${index}` },
    }));
    const state = events.reduce<WorkbenchState>(
      (current, event) => applySessionEvent(current, envelope(event)),
      { ...baseState(), activeSessionId: "s2", lastSeq: -1 },
    );
    expect(state.mcpStatuses.length).toBeLessThanOrEqual(20);
    expect(state.mcpStatuses.at(-1)).toEqual({ kind: "connected", server: "s29" });
  });

  it("事件流错误只记录局部提示，不隐藏已有内容", () => {
    const view = { ...emptyTranscriptView(), sessionId: "s1" };
    const state = applyStreamError({ ...baseState(), view }, "事件流中断");
    expect(state.view).toBe(view);
    expect(state.streamError).toBe("事件流中断");
    expect(state.connection).toBe("ready");
  });

  it("新会话清空会话与设备残留状态，不凭空捏造设备", () => {
    const state = applyNewSession({
      ...baseState(),
      activeSessionId: "s1",
      view: { ...transcriptFromSession(EVENTS), sessionId: "s1" },
      events: EVENTS,
      lastSeq: EVENTS.at(-1)!.seq,
      mcpStatuses: [{ kind: "connected", server: "echo" }],
      device: { probe: "OpenOCD", serial: "COM3", cpu: "STM32F407", backend: "Renode" },
      switching: true,
      streamError: "事件流中断",
      detailError: "会话读取失败",
      failedSessionId: "s1",
      sendError: "发送失败",
    });
    expect(state.activeSessionId).toBeUndefined();
    expect(state.events).toEqual([]);
    expect(state.lastSeq).toBe(-1);
    expect(state.view.events).toEqual([]);
    expect(state.view.status).toBe("idle");
    expect(state.mcpStatuses).toEqual([]);
    expect(state.device).toEqual(UNKNOWN_DEVICE);
    expect(state.streamError).toBeUndefined();
    expect(state.detailError).toBeUndefined();
    expect(state.failedSessionId).toBeUndefined();
    expect(state.sendError).toBeUndefined();
    expect(state.switching).toBe(false);
    expect(state.connection).toBe("ready");
  });

  it("请求门只放行最新一次请求", () => {
    const gate = new RequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    const third = gate.begin();
    expect(second()).toBe(false);
    expect(third()).toBe(true);
  });
});