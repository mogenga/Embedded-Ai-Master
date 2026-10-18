import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUiServer } from "../../src/server/api.js";

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "eam-ui-api-"));
  mkdirSync(path.join(home, "sessions", "s1"), { recursive: true });
  writeFileSync(path.join(home, "sessions", "s1", "header.json"), JSON.stringify({
    id: "s1", createdAt: "2026-10-18T00:00:00.000Z", status: "closed", model: "local-gw/flash",
  }));
  writeFileSync(path.join(home, "sessions", "s1", "session.v1.jsonl"),
    JSON.stringify({ seq: 0, ts: "t", type: "user", payload: { content: "你好" } }) + "\n");
  mkdirSync(path.join(home, "kb", "protocols"), { recursive: true });
  writeFileSync(path.join(home, "kb", "protocols", "uart.md"), "# uart\n");
  return home;
}

describe("ui api", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("会话列表返回真实 header", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    const res = await fetch(`http://127.0.0.1:${s.port}/api/sessions`);
    const body = await res.json() as { sessions: Array<{ id: string; model?: string }> };
    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([expect.objectContaining({ id: "s1", model: "local-gw/flash" })]);
  });

  it("会话事件按真实日志返回", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions/s1`)).json() as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });

  it("拒绝路径穿越与未知会话", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/..%2f..%2fetc`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/nope`)).status).toBe(404);
  });

  it("知识库树扫描真实目录", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/kb`)).json() as { root: string | null; tree: Array<{ name: string; kind: string }> };
    expect(body.root).toContain("kb");
    expect(body.tree).toEqual([expect.objectContaining({ name: "protocols", kind: "dir" })]);
  });

  it("设备状态诚实返回 unknown", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/device`)).json() as Record<string, string>;
    expect(body).toEqual({ probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" });
  });

  it("写操作与事件流诚实返回 501", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    expect((await fetch(`http://127.0.0.1:${s.port}/api/actions`, { method: "POST", body: "{}" })).status).toBe(501);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/events`)).status).toBe(501);
  });
});