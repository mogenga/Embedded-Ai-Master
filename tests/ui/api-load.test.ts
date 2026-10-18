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
    expect(loaded.kbRoot).toBe("/kb");
    expect(loaded.kbTree.length).toBe(1);
    expect(loaded.device.cpu).toBe("Cortex-M4");
  });

  it("无会话时返回空视图且不请求会话详情", async () => {
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
    expect(calls).not.toContain("/api/sessions/s1");
  });

  it("透传会话列表坏目录", async () => {
    const errors = [{ dir: "broken", code: "invalid_header" }];
    const fetchImpl = routedFetch({
      "/api/sessions": { sessions: [SESSION_SUMMARY], errors },
      "/api/sessions/s1": SESSION_DETAIL,
      "/api/kb": { root: null, tree: [] },
      "/api/device": { probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" },
    });
    const loaded = await loadWorkbench({ fetchImpl });
    expect(loaded.errors).toEqual(errors);
  });

  it("列表缺 errors 字段时返回空数组", async () => {
    const fetchImpl = routedFetch({
      "/api/sessions": { sessions: [SESSION_SUMMARY] },
      "/api/sessions/s1": SESSION_DETAIL,
      "/api/kb": { root: null, tree: [] },
      "/api/device": { probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" },
    });
    const loaded = await loadWorkbench({ fetchImpl });
    expect(loaded.errors).toEqual([]);
  });

  it("会话详情失败时上抛 ApiError", async () => {
    const fetchImpl = routedFetch({
      "/api/sessions": { sessions: [SESSION_SUMMARY], errors: [] },
      "/api/kb": { root: null, tree: [] },
      "/api/device": { probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" },
    });
    await expect(loadWorkbench({ fetchImpl })).rejects.toBeInstanceOf(ApiError);
  });

  it("loadSessionView 投影指定会话并写入 sessionId", async () => {
    const fetchImpl = routedFetch({ "/api/sessions/s1": SESSION_DETAIL });
    const view = await loadSessionView("s1", { fetchImpl });
    expect(view.sessionId).toBe("s1");
    expect(view.events.length).toBe(2);
  });
});