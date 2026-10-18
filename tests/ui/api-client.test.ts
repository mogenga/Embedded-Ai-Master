import { describe, expect, it } from "vitest";
import { fetchDevice, fetchKb, fetchSession, fetchSessions } from "../../src/ui/api/client.js";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingFetch(body: unknown, status = 200): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse(body, status);
  };
  return { calls, fetchImpl };
}

describe("api client", () => {
  it("fetchSessions 请求 /api/sessions 并解析会话与错误", async () => {
    const body = {
      sessions: [{ id: "s1", createdAt: "2026-10-18T21:40:00.000Z", status: "open" }],
      errors: [{ dir: "bad", code: "bad_header" }],
    };
    const { calls, fetchImpl } = recordingFetch(body);
    const result = await fetchSessions({ fetchImpl });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/api/sessions");
    expect(result).toEqual(body);
  });

  it("fetchSession 编码会话 id 并解析 header 与 events", async () => {
    const body = {
      header: { id: "a b", createdAt: "2026-10-18T21:40:00.000Z", status: "open" },
      events: [{ seq: 1, ts: "t", type: "user", payload: { content: "症状" } }],
    };
    const { calls, fetchImpl } = recordingFetch(body);
    const result = await fetchSession("a b", { fetchImpl });
    expect(calls[0].url).toBe("/api/sessions/a%20b");
    expect(result.header.id).toBe("a b");
    expect(result.events.length).toBe(1);
  });

  it("fetchKb 解析根路径与树", async () => {
    const body = {
      root: "/tmp/kb",
      tree: [{ name: "protocols", path: "/tmp/kb/protocols", kind: "dir", children: [] }],
    };
    const { calls, fetchImpl } = recordingFetch(body);
    const result = await fetchKb({ fetchImpl });
    expect(calls[0].url).toBe("/api/kb");
    expect(result.root).toBe("/tmp/kb");
    expect(result.tree[0].name).toBe("protocols");
  });

  it("fetchDevice 解析四字段", async () => {
    const body = { probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" };
    const { calls, fetchImpl } = recordingFetch(body);
    const result = await fetchDevice({ fetchImpl });
    expect(calls[0].url).toBe("/api/device");
    expect(result).toEqual(body);
  });

  it("非 2xx 抛 code 与 status", async () => {
    const { fetchImpl } = recordingFetch(
      { error: { code: "session_not_found", message: "会话不存在" } },
      404,
    );
    await expect(fetchSession("missing", { fetchImpl })).rejects.toMatchObject({
      code: "session_not_found",
      status: 404,
    });
  });

  it("非 2xx 且响应无 code 时使用 unknown_error", async () => {
    const { fetchImpl } = recordingFetch({}, 500);
    await expect(fetchKb({ fetchImpl })).rejects.toMatchObject({ code: "unknown_error", status: 500 });
  });

  it("2xx 非 JSON 抛 invalid_response", async () => {
    const fetchImpl: typeof fetch = async () => new Response("not json", { status: 200 });
    await expect(fetchKb({ fetchImpl })).rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("2xx 空 body 抛 invalid_response", async () => {
    const fetchImpl: typeof fetch = async () => new Response("", { status: 200 });
    await expect(fetchDevice({ fetchImpl })).rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("网络异常原样上抛", async () => {
    const failure = new TypeError("network down");
    const fetchImpl: typeof fetch = async () => {
      throw failure;
    };
    await expect(fetchSessions({ fetchImpl })).rejects.toBe(failure);
  });
});