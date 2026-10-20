import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/ui/api/client.js";
import { loadSessionView, loadWorkbench } from "../../src/ui/api/load.js";

function routedFetch(routes: Record<string, unknown>): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (!Object.hasOwn(routes, url)) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "未找到" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(routes[url]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const SESSION_SUMMARY = { id: "s1", createdAt: "2026-10-18T21:40:00.000Z", status: "open" };
const SESSION_DETAIL = {
  header: SESSION_SUMMARY,
  events: [
    { seq: 0, ts: "2026-10-18T21:40:00.000Z", type: "user", payload: { content: "真实症状" } },
    {
      seq: 1,
      ts: "2026-10-18T21:40:01.000Z",
      type: "assistant",
      payload: { content: "真实回复", toolCalls: [] },
    },
  ],
};
const UNKNOWN = { probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" };

describe("workbench load", () => {
  it("加载会话、KB 与设备并投影首个会话", async () => {
    const fetchImpl = routedFetch({
      "/api/sessions": { sessions: [SESSION_SUMMARY], errors: [] },
      "/api/sessions/s1": SESSION_DETAIL,
      "/api/kb": { root: "/kb", tree: [{ name: "protocols", path: "/kb/protocols", kind: "dir" }] },
      "/api/device": { probe: "OpenOCD", serial: "COM3", cpu: "Cortex-M4", backend: "Renode" },
    });
    const loaded = await loadWorkbench({ fetchImpl });
    expect(loaded.sessions).toEqual([SESSION_SUMMARY]);
    expect(loaded.activeSessionId).toBe("s1");
    expect(loaded.view.sessionId).toBe("s1");
    expect(loaded.view.events.map((event) => event.kind)).toEqual(["user", "assistant"]);
    expect(loaded.events).toEqual(SESSION_DETAIL.events);
    expect(loaded.lastSeq).toBe(1);
    expect(loaded.kbRoot).toBe("/kb");
    expect(loaded.kbTree.length).toBe(1);
    expect(loaded.device.cpu).toBe("Cortex-M4");
  });

  it("无会话时返回空视图、空事件且 lastSeq=-1", async () => {
    const calls: string[] = [];
    const base = routedFetch({
      "/api/sessions": { sessions: [], errors: [] },
      "/api/kb": { root: null, tree: [] },
      "/api/device": { probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" },
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(String(input));
      return base(input, init);
    };
    const loaded = await loadWorkbench({ fetchImpl });
    expect(loaded.activeSessionId).toBeUndefined();
    expect(loaded.view.events).toEqual([]);
    expect(loaded.view.status).toBe("idle");
    expect(loaded.events).toEqual([]);
    expect(loaded.lastSeq).toBe(-1);
    expect(calls).not.toContain("/api/sessions/s1");
  });

  it("设备事件存在时以事件投影为准，不用 /api/device 覆盖", async () => {
    const events = [
      ...SESSION_DETAIL.events,
      {
        seq: 2,
        ts: "t",
        type: "device_status",
        payload: { callId: "c1", server: "probe", tool: "mcp__probe__attach", state: { probe: "attached", cpu: "halted" } },
      },
    ];
    const fetchImpl = routedFetch({
      "/api/sessions": { sessions: [SESSION_SUMMARY], errors: [] },
      "/api/sessions/s1": { header: SESSION_SUMMARY, events },
      "/api/kb": { root: null, tree: [] },
      "/api/device": { probe: "OpenOCD", serial: "COM3", cpu: "Cortex-M4", backend: "Renode" },
    });
    const loaded = await loadWorkbench({ fetchImpl });
    expect(loaded.device).toEqual({ probe: "attached", serial: "unknown", cpu: "halted", backend: "unknown" });
  });

  it("无 device_status 时回退 /api/device", async () => {
    const fetchImpl = routedFetch({
      "/api/sessions": { sessions: [SESSION_SUMMARY], errors: [] },
      "/api/sessions/s1": SESSION_DETAIL,
      "/api/kb": { root: null, tree: [] },
      "/api/device": { probe: "OpenOCD", serial: "COM3", cpu: "Cortex-M4", backend: "Renode" },
    });
    const loaded = await loadWorkbench({ fetchImpl });
    expect(loaded.device).toEqual({ probe: "OpenOCD", serial: "COM3", cpu: "Cortex-M4", backend: "Renode" });
  });

  it("透传会话列表坏目录", async () => {
    const errors = [{ dir: "broken", code: "invalid_header" }];
    const fetchImpl = routedFetch({
      "/api/sessions": { sessions: [SESSION_SUMMARY], errors },
      "/api/sessions/s1": SESSION_DETAIL,
      "/api/kb": { root: null, tree: [] },
      "/api/device": UNKNOWN,
    });
    const loaded = await loadWorkbench({ fetchImpl });
    expect(loaded.errors).toEqual(errors);
  });

  it("列表缺 errors 字段时返回空数组", async () => {
    const fetchImpl = routedFetch({
      "/api/sessions": { sessions: [SESSION_SUMMARY] },
      "/api/sessions/s1": SESSION_DETAIL,
      "/api/kb": { root: null, tree: [] },
      "/api/device": UNKNOWN,
    });
    const loaded = await loadWorkbench({ fetchImpl });
    expect(loaded.errors).toEqual([]);
  });

  it("会话详情失败时上抛 ApiError", async () => {
    const fetchImpl = routedFetch({
      "/api/sessions": { sessions: [SESSION_SUMMARY], errors: [] },
      "/api/kb": { root: null, tree: [] },
      "/api/device": UNKNOWN,
    });
    await expect(loadWorkbench({ fetchImpl })).rejects.toBeInstanceOf(ApiError);
  });

  it("loadSessionView 返回事件、游标、设备与写入 sessionId 的视图", async () => {
    const fetchImpl = routedFetch({ "/api/sessions/s1": SESSION_DETAIL });
    const loaded = await loadSessionView("s1", { fetchImpl });
    expect(loaded.view.sessionId).toBe("s1");
    expect(loaded.view.events.length).toBe(2);
    expect(loaded.events).toEqual(SESSION_DETAIL.events);
    expect(loaded.lastSeq).toBe(1);
    expect(loaded.device).toEqual(UNKNOWN);
  });

  it("loadSessionView 无 device_status 时使用传入的回退设备", async () => {
    const fallback = { probe: "OpenOCD", serial: "COM3", cpu: "Cortex-M4", backend: "Renode" };
    const fetchImpl = routedFetch({ "/api/sessions/s1": SESSION_DETAIL });
    const loaded = await loadSessionView("s1", { fetchImpl, deviceFallback: fallback });
    expect(loaded.device).toEqual(fallback);
  });

  it("loadSessionView 有 device_status 时事件投影优先于回退设备", async () => {
    const fallback = { probe: "OpenOCD", serial: "COM3", cpu: "Cortex-M4", backend: "Renode" };
    const events = [
      ...SESSION_DETAIL.events,
      {
        seq: 2,
        ts: "t",
        type: "device_status",
        payload: { callId: "c1", server: "probe", tool: "mcp__probe__attach", state: { probe: "attached" } },
      },
    ];
    const fetchImpl = routedFetch({
      "/api/sessions/s1": { header: SESSION_SUMMARY, events },
    });
    const loaded = await loadSessionView("s1", { fetchImpl, deviceFallback: fallback });
    expect(loaded.device).toEqual({ probe: "attached", serial: "unknown", cpu: "unknown", backend: "unknown" });
    expect(loaded.lastSeq).toBe(2);
  });

  it("loadSessionView 空事件时 lastSeq=-1", async () => {
    const fetchImpl = routedFetch({
      "/api/sessions/s1": { header: SESSION_SUMMARY, events: [] },
    });
    const loaded = await loadSessionView("s1", { fetchImpl });
    expect(loaded.events).toEqual([]);
    expect(loaded.lastSeq).toBe(-1);
  });
});