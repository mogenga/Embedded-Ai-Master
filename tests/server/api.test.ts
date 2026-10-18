import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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

function writeSession(home: string, dir: string, id: string): void {
  mkdirSync(path.join(home, "sessions", dir), { recursive: true });
  writeFileSync(path.join(home, "sessions", dir, "header.json"), JSON.stringify({
    id, createdAt: "2026-10-18T00:00:00.000Z", status: "closed",
  }));
  writeFileSync(path.join(home, "sessions", dir, "session.v1.jsonl"),
    JSON.stringify({ seq: 0, ts: "t", type: "user", payload: { content: "hi" } }) + "\n");
}

function rawRequest(
  port: number,
  urlPath: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: urlPath,
      method,
      agent: false,
      headers: { connection: "close" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function canSymlink(): boolean {
  const root = mkdtempSync(path.join(tmpdir(), "eam-symlink-"));
  const target = path.join(root, "target.txt");
  writeFileSync(target, "x");
  try {
    symlinkSync(target, path.join(root, "link.txt"), "file");
    return true;
  } catch {
    return false;
  }
}

const SYMLINK_SUPPORTED = canSymlink();

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

  it("目录名与 header.id 不同时列表 id 为目录名且可打开", async () => {
    const home = makeHome();
    writeSession(home, "dirA", "s1");
    const s = createUiServer({ harnessHome: home });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).json() as {
      sessions: Array<{ id: string }>;
      errors: Array<{ dir: string; code: string }>;
    };
    expect(body.sessions.map((item) => item.id)).toContain("dirA");
    expect(body.errors).toContainEqual({ dir: "dirA", code: "id_mismatch" });
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/dirA`)).status).toBe(200);
  });

  it("坏目录不静默且不影响好会话", async () => {
    const home = makeHome();
    mkdirSync(path.join(home, "sessions", "broken"));
    const s = createUiServer({ harnessHome: home });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).json() as {
      sessions: Array<{ id: string }>;
      errors: Array<{ dir: string; code: string }>;
    };
    expect(body.sessions.map((item) => item.id)).toEqual(["s1"]);
    expect(body.errors).toContainEqual({ dir: "broken", code: "invalid_header" });
  });

  it("会话根不可读时列表进 errors 而非静默为空", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "eam-ui-api-"));
    writeFileSync(path.join(home, "sessions"), "not a directory");
    const s = createUiServer({ harnessHome: home });
    close = s.close;
    const res = await fetch(`http://127.0.0.1:${s.port}/api/sessions`);
    const body = await res.json() as { sessions: unknown[]; errors: Array<{ code: string }> };
    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([]);
    expect(body.errors).toContainEqual(expect.objectContaining({ code: "unreadable" }));
  });

  it("拒绝路径穿越与未知会话", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/..%2f..%2fetc`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/nope`)).status).toBe(404);
  });

  it("反斜杠与 NUL 路径返回 400", async () => {
    const s = createUiServer({ harnessHome: makeHome(), staticRoot: makeHome() });
    close = s.close;
    expect((await rawRequest(s.port, "/api/sessions/..%5c..%5cetc")).status).toBe(400);
    expect((await rawRequest(s.port, "/%00")).status).toBe(400);
  });

  it("静态穿越不返回文件内容", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eam-static-"));
    const staticRoot = path.join(root, "dist-web");
    mkdirSync(path.join(staticRoot, "web"), { recursive: true });
    writeFileSync(path.join(staticRoot, "web", "index.html"), "<html>ok</html>");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ secret: "top-level" }));
    const s = createUiServer({ harnessHome: makeHome(), staticRoot });
    close = s.close;
    const traversal = await rawRequest(s.port, "/%2e%2e/package.json");
    expect([400, 404]).toContain(traversal.status);
    expect(traversal.body).not.toContain("top-level");
    expect((await fetch(`http://127.0.0.1:${s.port}/`)).status).toBe(200);
  });

  it.skipIf(!SYMLINK_SUPPORTED)("符号链接穿越会话根与静态根均被拒绝", async () => {
    const home = makeHome();
    const outside = mkdtempSync(path.join(tmpdir(), "eam-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "outside-secret");
    writeFileSync(path.join(outside, "header.json"), JSON.stringify({
      id: "leak", createdAt: "2026-10-18T00:00:00.000Z", status: "closed",
    }));
    writeFileSync(path.join(outside, "session.v1.jsonl"), "{}\n");
    symlinkSync(outside, path.join(home, "sessions", "leak"), "dir");
    const staticRoot = path.join(home, "static");
    mkdirSync(path.join(staticRoot, "web"), { recursive: true });
    writeFileSync(path.join(staticRoot, "web", "index.html"), "<html>ok</html>");
    symlinkSync(outside, path.join(staticRoot, "leak"), "dir");
    symlinkSync(path.join(outside, "secret.txt"), path.join(staticRoot, "secret.txt"), "file");
    const s = createUiServer({ harnessHome: home, staticRoot });
    close = s.close;
    const staticLeak = await fetch(`http://127.0.0.1:${s.port}/secret.txt`);
    expect([400, 404]).toContain(staticLeak.status);
    expect(await staticLeak.text()).not.toContain("outside-secret");
    const sessionLeak = await fetch(`http://127.0.0.1:${s.port}/api/sessions/leak`);
    expect([400, 404]).toContain(sessionLeak.status);
  });

  it("不支持的方法返回 405", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    const res = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
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