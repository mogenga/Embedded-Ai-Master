import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiHandler, createUiServer } from "../../src/server/api.js";
import type { ApiOptions } from "../../src/server/api.js";
import { RunnerError } from "../../src/server/runner.js";
import type { RunnerErrorCode, SessionRunner } from "../../src/server/runner.js";

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
  headers: Record<string, string> = {},
  payload?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: urlPath,
      method,
      agent: false,
      headers: { connection: "close", ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start the UI server on a free port.
 *
 * `createUiServer` defaults to 5174, which a running `npm run serve:ui` also
 * occupies; a fixed port makes this suite fail with EADDRINUSE for reasons
 * that have nothing to do with the code under test.
 */
async function startUi(
  opts: ApiOptions,
): Promise<{ port: number; close(): Promise<void> }> {
  const port = await freePort();
  return createUiServer({ ...opts, port });
}

function makeRunner(overrides: Partial<SessionRunner> = {}): SessionRunner {
  return {
    start: vi.fn(async () => ({ sessionId: "created-1", created: true })),
    decide: vi.fn(async () => ({ kind: "accepted" as const })),
    abort: vi.fn(() => true),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function writeHeaders(port: number): Record<string, string> {
  return {
    origin: `http://127.0.0.1:${port}`,
    "content-type": "application/json; charset=utf-8",
  };
}

async function startApi(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function errorCode(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
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

function canJunction(): boolean {
  if (process.platform !== "win32") return false;
  const root = mkdtempSync(path.join(tmpdir(), "eam-junction-"));
  mkdirSync(path.join(root, "target"));
  try {
    symlinkSync(path.join(root, "target"), path.join(root, "link"), "junction");
    return true;
  } catch {
    return false;
  }
}

const JUNCTION_SUPPORTED = canJunction();

describe("ui api", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("会话列表返回真实 header", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const res = await fetch(`http://127.0.0.1:${s.port}/api/sessions`);
    const body = await res.json() as { sessions: Array<{ id: string; model?: string }> };
    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([expect.objectContaining({ id: "s1", model: "local-gw/flash" })]);
  });

  it("会话事件按真实日志返回", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions/s1`)).json() as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });

  it("目录名与 header.id 不同时列表 id 为目录名且可打开", async () => {
    const home = makeHome();
    writeSession(home, "dirA", "s1");
    const s = await startUi({ harnessHome: home });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).json() as {
      sessions: Array<{ id: string }>;
      errors: Array<{ dir: string; code: string }>;
    };
    expect(body.sessions.map((item) => item.id)).toContain("dirA");
    expect(body.errors).toContainEqual({ dir: "dirA", code: "id_mismatch" });
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/dirA`)).status).toBe(200);
  });

  it("列表与详情使用同一 id 规则：含点目录记 invalid_id 且不可打开", async () => {
    const home = makeHome();
    writeSession(home, "s1.old", "s1");
    const s = await startUi({ harnessHome: home });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).json() as {
      sessions: Array<{ id: string }>;
      errors: Array<{ dir: string; code: string }>;
    };
    expect(body.sessions.map((item) => item.id)).toEqual(["s1"]);
    expect(body.errors).toContainEqual({ dir: "s1.old", code: "invalid_id" });
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/s1.old`)).status).toBe(400);
  });

  it("坏目录不静默且不影响好会话", async () => {
    const home = makeHome();
    mkdirSync(path.join(home, "sessions", "broken"));
    const s = await startUi({ harnessHome: home });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).json() as {
      sessions: Array<{ id: string }>;
      errors: Array<{ dir: string; code: string }>;
    };
    expect(body.sessions.map((item) => item.id)).toEqual(["s1"]);
    expect(body.errors).toContainEqual({ dir: "broken", code: "invalid_header" });
  });

  it("坏事件日志会话仍出现在列表", async () => {
    const home = makeHome();
    writeFileSync(path.join(home, "sessions", "s1", "session.v1.jsonl"), "{bad\n");
    const s = await startUi({ harnessHome: home });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).json() as {
      sessions: Array<{ id: string }>;
      errors: Array<{ code: string }>;
    };
    expect(body.sessions.map((item) => item.id)).toContain("s1");
    expect(body.errors).toEqual([]);
  });

  it.skipIf(!SYMLINK_SUPPORTED)("header 为符号链接时列表与详情都按损坏处理", async () => {
    const home = makeHome();
    const target = path.join(home, "outside-header.json");
    writeFileSync(target, JSON.stringify({
      id: "s1", createdAt: "2026-10-18T00:00:00.000Z", status: "closed",
    }));
    rmSync(path.join(home, "sessions", "s1", "header.json"));
    symlinkSync(target, path.join(home, "sessions", "s1", "header.json"), "file");
    const s = await startUi({ harnessHome: home });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).json() as {
      sessions: unknown[];
      errors: Array<{ dir: string; code: string }>;
    };
    expect(body.sessions).toHaveLength(0);
    expect(body.errors).toContainEqual({ dir: "s1", code: "invalid_header" });
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/s1`)).status).toBe(500);
  });

  it("有效 header 但无日志文件进 errors", async () => {
    const home = makeHome();
    rmSync(path.join(home, "sessions", "s1", "session.v1.jsonl"));
    const s = await startUi({ harnessHome: home });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).json() as {
      sessions: unknown[];
      errors: Array<{ dir: string; code: string }>;
    };
    expect(body.sessions).toHaveLength(0);
    expect(body.errors).toContainEqual({ dir: "s1", code: "invalid_header" });
  });

  it.skipIf(!JUNCTION_SUPPORTED)("junction 目录记 skipped_link 且不进列表", async () => {
    const home = makeHome();
    const outside = mkdtempSync(path.join(tmpdir(), "eam-outside-"));
    writeFileSync(path.join(outside, "header.json"), JSON.stringify({
      id: "linked", createdAt: "2026-10-18T00:00:00.000Z", status: "closed",
    }));
    writeFileSync(path.join(outside, "session.v1.jsonl"), "{}\n");
    symlinkSync(outside, path.join(home, "sessions", "linked"), "junction");
    const s = await startUi({ harnessHome: home });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`)).json() as {
      sessions: Array<{ id: string }>;
      errors: Array<{ dir: string; code: string }>;
    };
    expect(body.sessions.map((item) => item.id)).not.toContain("linked");
    expect(body.errors).toContainEqual({ dir: "linked", code: "skipped_link" });
  });

  it("会话根不可读时列表进 errors 而非静默为空", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "eam-ui-api-"));
    writeFileSync(path.join(home, "sessions"), "not a directory");
    const s = await startUi({ harnessHome: home });
    close = s.close;
    const res = await fetch(`http://127.0.0.1:${s.port}/api/sessions`);
    const body = await res.json() as { sessions: unknown[]; errors: Array<{ code: string }> };
    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([]);
    expect(body.errors).toContainEqual(expect.objectContaining({ code: "unreadable" }));
  });

  it("拒绝路径穿越与未知会话", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/..%2f..%2fetc`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sessions/nope`)).status).toBe(404);
  });

  it("反斜杠与 NUL 路径返回 400", async () => {
    const s = await startUi({ harnessHome: makeHome(), staticRoot: makeHome() });
    close = s.close;
    expect((await rawRequest(s.port, "/api/sessions/..%5c..%5cetc")).status).toBe(400);
    expect((await rawRequest(s.port, "/%00")).status).toBe(400);
  });

  it("静态穿越不返回文件内容", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eam-static-"));
    const staticRoot = path.join(root, "renderer");
    mkdirSync(staticRoot, { recursive: true });
    writeFileSync(path.join(staticRoot, "index.html"), "<html>ok</html>");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ secret: "top-level" }));
    const s = await startUi({ harnessHome: makeHome(), staticRoot });
    close = s.close;
    const traversal = await rawRequest(s.port, "/%2e%2e/package.json");
    expect([400, 404]).toContain(traversal.status);
    expect(traversal.body).not.toContain("top-level");
    expect((await fetch(`http://127.0.0.1:${s.port}/`)).status).toBe(200);
  });

  it("静态入口是 staticRoot/index.html，兼容旧的 /web/index.html", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eam-static-index-"));
    const staticRoot = path.join(root, "renderer");
    mkdirSync(staticRoot, { recursive: true });
    writeFileSync(path.join(staticRoot, "index.html"), "<html>renderer</html>");
    mkdirSync(path.join(staticRoot, "web"), { recursive: true });
    writeFileSync(path.join(staticRoot, "web", "index.html"), "<html>legacy</html>");
    writeFileSync(path.join(staticRoot, "app.js"), "export const a = 1;\n");
    const s = await startUi({ harnessHome: makeHome(), staticRoot });
    close = s.close;
    const rootPage = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
    expect(rootPage).toContain("renderer");
    const explicit = await (await fetch(`http://127.0.0.1:${s.port}/index.html`)).text();
    expect(explicit).toContain("renderer");
    const legacy = await (await fetch(`http://127.0.0.1:${s.port}/web/index.html`)).text();
    expect(legacy).toContain("legacy");
    const script = await fetch(`http://127.0.0.1:${s.port}/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
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
    mkdirSync(staticRoot, { recursive: true });
    writeFileSync(path.join(staticRoot, "index.html"), "<html>ok</html>");
    symlinkSync(outside, path.join(staticRoot, "leak"), "dir");
    symlinkSync(path.join(outside, "secret.txt"), path.join(staticRoot, "secret.txt"), "file");
    const s = await startUi({ harnessHome: home, staticRoot });
    close = s.close;
    const staticLeak = await fetch(`http://127.0.0.1:${s.port}/secret.txt`);
    expect([400, 404]).toContain(staticLeak.status);
    expect(await staticLeak.text()).not.toContain("outside-secret");
    const sessionLeak = await fetch(`http://127.0.0.1:${s.port}/api/sessions/leak`);
    expect([400, 404]).toContain(sessionLeak.status);
  });

  it("不支持的方法返回 405", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const res = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
  });

  it("知识库树扫描真实目录", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/kb`)).json() as { root: string | null; tree: Array<{ name: string; kind: string }> };
    expect(body.root).toContain("kb");
    expect(body.tree).toEqual([expect.objectContaining({ name: "protocols", kind: "dir" })]);
  });

  it("GET /api/file 只读允许目录内的文本，越界与二进制如实标注", async () => {
    const home = makeHome();
    const inside = path.join(home, "sessions", "s1", "notes.txt");
    writeFileSync(inside, "串口没输出\n");
    const binary = path.join(home, "sessions", "s1", "capture.bin");
    writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    const outside = path.join(home, "secret.txt");
    writeFileSync(outside, "不应读取");
    const s = await startUi({ harnessHome: home });
    close = s.close;

    const ok = await fetch(
      `http://127.0.0.1:${s.port}/api/file?path=${encodeURIComponent(inside)}`,
    );
    expect(ok.status).toBe(200);
    const preview = (await ok.json()) as { content: string; binary: boolean; truncated: boolean };
    expect(preview.content).toBe("串口没输出\n");
    expect(preview.binary).toBe(false);
    expect(preview.truncated).toBe(false);

    const elf = await fetch(
      `http://127.0.0.1:${s.port}/api/file?path=${encodeURIComponent(binary)}`,
    );
    expect(elf.status).toBe(200);
    // A NUL byte means "not text": reporting content would show mojibake.
    expect((await elf.json()) as { binary: boolean }).toMatchObject({ binary: true, content: "" });

    const escape = await fetch(
      `http://127.0.0.1:${s.port}/api/file?path=${encodeURIComponent(outside)}`,
    );
    expect(escape.status).toBe(400);
    expect(errorCode(await escape.text())).toBe("invalid_path");

    expect((await fetch(`http://127.0.0.1:${s.port}/api/file`)).status).toBe(400);
  });

  it("GET /api/sessions/:id/artifacts 列出产物，目录不存在回空列表", async () => {
    const home = makeHome();
    const artifacts = path.join(home, "sessions", "s1", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, "call-abc.txt"), "full output");
    writeFileSync(path.join(artifacts, "capture.dat"), "binary-ish");
    const s = await startUi({ harnessHome: home });
    close = s.close;

    const listed = await fetch(`http://127.0.0.1:${s.port}/api/sessions/s1/artifacts`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      artifacts: Array<{ name: string; kind: string; size: number }>;
    };
    expect(body.artifacts.map((entry) => entry.name)).toStrictEqual(["call-abc.txt", "capture.dat"]);
    expect(body.artifacts[0].kind).toBe("text");
    expect(body.artifacts[0].size).toBe(Buffer.byteLength("full output"));

    const empty = await fetch(`http://127.0.0.1:${s.port}/api/sessions/s1/artifacts?x=1`);
    expect(empty.status).toBe(200);
    // The list is per session; the query string must not turn it into a 404.
    expect((await empty.json()) as { artifacts: unknown[] }).toMatchObject({ artifacts: expect.any(Array) });
  });

  it("GET /api/sessions/:id/artifacts 拒绝非法 id 与不存在目录", async () => {
    const home = makeHome();
    const s = await startUi({ harnessHome: home });
    close = s.close;
    const bad = await fetch(`http://127.0.0.1:${s.port}/api/sessions/..%2Fescape/artifacts`);
    expect(bad.status).toBe(400);
    const missing = await fetch(`http://127.0.0.1:${s.port}/api/sessions/nosuch/artifacts`);
    expect(missing.status).toBe(200);
    expect((await missing.json()) as { artifacts: unknown[] }).toMatchObject({ artifacts: [] });
  });

  it("设备状态诚实返回 unknown", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/device`)).json() as Record<string, string>;
    expect(body).toEqual({ probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" });
  });

  it("写操作接入 runner 返回 202，事件流返回真实 SSE", async () => {
    const runner = makeRunner();
    const s = await startUi({ harnessHome: makeHome(), runner });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "你好" }),
    );
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ sessionId: "created-1", created: true });
    expect(vi.mocked(runner.start)).toHaveBeenCalledWith({ text: "你好" });

    const events = await fetch(`http://127.0.0.1:${s.port}/api/events?sessionId=s1`);
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const body = await events.text();
    expect(body).toContain("id: 0");
    expect(body).toContain("event: stream_end");
  });

  it("POST /api/actions 透传权限预设，非字符串或内核拒绝时 400", async () => {
    const runner = makeRunner();
    const s = await startUi({ harnessHome: makeHome(), runner });
    close = s.close;
    const ok = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi", mode: "read-only" }),
    );
    expect(ok.status).toBe(202);
    expect(vi.mocked(runner.start)).toHaveBeenCalledWith({ text: "hi", mode: "read-only" });

    const wrongType = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi", mode: 3 }),
    );
    expect(wrongType.status).toBe(400);
    expect(errorCode(wrongType.body)).toBe("invalid_mode");

    // A preset the kernel refuses must surface as a client error, not as a
    // 500 or as a run under a different mode.
    runner.start = vi.fn(async () => {
      throw new RunnerError("invalid_mode", "非法的权限预设: nope");
    });
    const rejected = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi", mode: "nope" }),
    );
    expect(rejected.status).toBe(400);
    expect(errorCode(rejected.body)).toBe("invalid_mode");
  });

  it("POST /api/actions 透传运行上限，非法类型在启动前 400", async () => {
    const runner = makeRunner();
    const s = await startUi({ harnessHome: makeHome(), runner });
    close = s.close;
    const ok = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi", maxTurns: 4, maxCostUsd: 0.25, timeoutMs: 5000, systemPrompt: "p" }),
    );
    expect(ok.status).toBe(202);
    expect(vi.mocked(runner.start)).toHaveBeenCalledWith({
      text: "hi",
      maxTurns: 4,
      maxCostUsd: 0.25,
      timeoutMs: 5000,
      systemPrompt: "p",
    });

    const wrong = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi", maxTurns: "4" }),
    );
    expect(wrong.status).toBe(400);
    expect(errorCode(wrong.body)).toBe("invalid_run_limits");
    // The rejected call never reached the runner.
    expect(vi.mocked(runner.start)).toHaveBeenCalledTimes(1);
  });

  it("PATCH /api/sessions/:id 写入标题并要求写请求头", async () => {
    const home = makeHome();
    const s = await startUi({ harnessHome: home });
    close = s.close;

    const noOrigin = await rawRequest(
      s.port,
      "/api/sessions/s1",
      "PATCH",
      { "content-type": "application/json" },
      JSON.stringify({ title: "串口无输出" }),
    );
    expect(noOrigin.status).toBe(403);

    const ok = await rawRequest(
      s.port,
      "/api/sessions/s1",
      "PATCH",
      writeHeaders(s.port),
      JSON.stringify({ title: "串口无输出", pinned: true }),
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ id: "s1", title: "串口无输出", pinned: true });

    // The title is listed, not only readable through the detail endpoint.
    const list = JSON.parse(
      (await rawRequest(s.port, "/api/sessions")).body,
    ) as { sessions: Array<{ id: string; title?: string; pinned?: boolean }> };
    expect(list.sessions.find((entry) => entry.id === "s1")).toMatchObject({
      title: "串口无输出",
      pinned: true,
    });
  });

  it("DELETE /api/sessions/:id 删除会话，fork 产出新 id", async () => {
    const home = makeHome();
    writeSession(home, "s2", "s2");
    const s = await startUi({ harnessHome: home });
    close = s.close;

    const forked = await rawRequest(
      s.port,
      "/api/sessions/s2/fork",
      "POST",
      writeHeaders(s.port),
    );
    expect(forked.status).toBe(201);
    const forkId = (JSON.parse(forked.body) as { sessionId: string }).sessionId;
    expect(forkId).not.toBe("s2");

    const removed = await rawRequest(
      s.port,
      "/api/sessions/s2",
      "DELETE",
      writeHeaders(s.port),
    );
    expect(removed.status).toBe(200);
    expect((await rawRequest(s.port, "/api/sessions/s2")).status).toBe(404);
    expect((await rawRequest(s.port, `/api/sessions/${forkId}`)).status).toBe(200);
  });

  it("GET /api/config 返回 MCP/权限/运行上限，PUT 逐段写入", async () => {
    const home = makeHome();
    const s = await startUi({ harnessHome: home });
    close = s.close;

    const initial = JSON.parse((await rawRequest(s.port, "/api/config")).body) as {
      mcpServers: unknown[];
      permissions: { preset: string; approvalTimeoutMs: number };
      run: { maxTurns: number };
    };
    expect(initial.mcpServers).toEqual([]);
    expect(initial.permissions).toMatchObject({ preset: "diagnose", approvalTimeoutMs: 120000 });
    expect(initial.run.maxTurns).toBe(10);

    const putMcp = await rawRequest(
      s.port,
      "/api/config",
      "PUT",
      writeHeaders(s.port),
      JSON.stringify({
        mcpServers: [{ name: "probe", command: "node", args: ["probe.js"] }],
      }),
    );
    expect(putMcp.status).toBe(200);
    expect((JSON.parse(putMcp.body) as { mcpServers: unknown[] }).mcpServers).toHaveLength(1);

    const putBad = await rawRequest(
      s.port,
      "/api/config",
      "PUT",
      writeHeaders(s.port),
      JSON.stringify({ permissions: { preset: "yolo" } }),
    );
    expect(putBad.status).toBe(400);
    expect(errorCode(putBad.body)).toBe("invalid_config");

    const putRun = await rawRequest(
      s.port,
      "/api/config",
      "PUT",
      writeHeaders(s.port),
      JSON.stringify({ run: { maxTurns: 3 } }),
    );
    expect(putRun.status).toBe(200);
    expect((JSON.parse(putRun.body) as { run: { maxTurns: number } }).run.maxTurns).toBe(3);
  });

  it("PUT /api/config providers 段合法写入并可读回，非法输入 400 且原文件不变", async () => {
    const home = makeHome();
    const s = await startUi({ harnessHome: home });
    close = s.close;

    const providers = {
      "local-gw": {
        protocol: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKeyEnv: "LOCAL_GW_KEY",
        models: { flash: { contextWindow: 128000, maxOutput: 4096 } },
      },
    };

    const ok = await rawRequest(
      s.port,
      "/api/config",
      "PUT",
      writeHeaders(s.port),
      JSON.stringify({ providers }),
    );
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.body) as { providers: unknown }).providers).toEqual(providers);
    // The write is on disk in the kernel's own shape, not just echoed back.
    expect(
      JSON.parse(readFileSync(path.join(home, "providers.json"), "utf8")) as unknown,
    ).toEqual(providers);
    const reread = JSON.parse(
      (await rawRequest(s.port, "/api/config")).body,
    ) as { providers: unknown };
    expect(reread.providers).toEqual(providers);

    // A model without contextWindow is valid: the kernel defaults it. What is
    // still rejected is a value the kernel cannot use.
    const bad = await rawRequest(
      s.port,
      "/api/config",
      "PUT",
      writeHeaders(s.port),
      JSON.stringify({
        providers: {
          "local-gw": {
            protocol: "openai-chat-completions",
            baseUrl: "http://127.0.0.1:8080/v1",
            models: { flash: { contextWindow: 0 } },
          },
        },
      }),
    );
    expect(bad.status).toBe(400);
    expect(errorCode(bad.body)).toBe("invalid_config");
    expect(
      JSON.parse(readFileSync(path.join(home, "providers.json"), "utf8")) as unknown,
    ).toEqual(providers);
  });

  it("PUT /api/config 四个段都不匹配时仍是 400 invalid_body", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/config",
      "PUT",
      writeHeaders(s.port),
      JSON.stringify({ nope: true }),
    );
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_body");
  });

  it("GET /api/tree 列出已登记的目录，缺 path 与越界均为 400 invalid_path", async () => {
    const home = makeHome();
    const workspace = mkdtempSync(path.join(tmpdir(), "eam-workspace-"));
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "readme.md"), "# hi\n");
    const s = await startUi({ harnessHome: home });
    close = s.close;

    // A directory the operator has not opened is not browsable yet.
    const outside = mkdtempSync(path.join(tmpdir(), "eam-outside-"));
    const escape = await fetch(
      `http://127.0.0.1:${s.port}/api/tree?path=${encodeURIComponent(outside)}`,
    );
    expect(escape.status).toBe(400);
    expect(errorCode(await escape.text())).toBe("invalid_path");

    const registered = await rawRequest(
      s.port,
      "/api/workspace",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ path: workspace }),
    );
    expect(registered.status).toBe(200);
    expect((JSON.parse(registered.body) as { path: string }).path).toBeTruthy();

    const listed = await fetch(
      `http://127.0.0.1:${s.port}/api/tree?path=${encodeURIComponent(workspace)}`,
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      path: string;
      entries: Array<{ name: string; path: string; type: string }>;
      truncated: boolean;
    };
    expect(body.path).toBeTruthy();
    expect(body.truncated).toBe(false);
    expect(body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "src", type: "dir" }),
        expect.objectContaining({ name: "readme.md", type: "file" }),
      ]),
    );

    expect((await fetch(`http://127.0.0.1:${s.port}/api/tree`)).status).toBe(400);
    const empty = await fetch(`http://127.0.0.1:${s.port}/api/tree?path=`);
    expect(empty.status).toBe(400);
    expect(errorCode(await empty.text())).toBe("invalid_path");
  });

  it("POST /api/workspace 要求写请求头，文件路径 400 invalid_path", async () => {
    const home = makeHome();
    const workspace = mkdtempSync(path.join(tmpdir(), "eam-workspace-"));
    const s = await startUi({ harnessHome: home });
    close = s.close;

    const noOrigin = await rawRequest(
      s.port,
      "/api/workspace",
      "POST",
      { "content-type": "application/json" },
      JSON.stringify({ path: workspace }),
    );
    expect(noOrigin.status).toBe(403);
    expect(errorCode(noOrigin.body)).toBe("forbidden_origin");

    const file = path.join(workspace, "notes.txt");
    writeFileSync(file, "x");
    const asFile = await rawRequest(
      s.port,
      "/api/workspace",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ path: file }),
    );
    expect(asFile.status).toBe(400);
    expect(errorCode(asFile.body)).toBe("invalid_path");

    const wrongType = await rawRequest(
      s.port,
      "/api/workspace",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ path: 3 }),
    );
    expect(wrongType.status).toBe(400);
    expect(errorCode(wrongType.body)).toBe("invalid_path");
  });

  it("POST /api/actions 透传 cwd，非字符串与内核拒绝均 400 invalid_cwd", async () => {
    const runner = makeRunner();
    const s = await startUi({ harnessHome: makeHome(), runner });
    close = s.close;

    const ok = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi", cwd: "/tmp/work" }),
    );
    expect(ok.status).toBe(202);
    expect(vi.mocked(runner.start)).toHaveBeenCalledWith({ text: "hi", cwd: "/tmp/work" });

    const wrongType = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi", cwd: 3 }),
    );
    expect(wrongType.status).toBe(400);
    expect(errorCode(wrongType.body)).toBe("invalid_cwd");
    expect(vi.mocked(runner.start)).toHaveBeenCalledTimes(1);

    runner.start = vi.fn(async () => {
      throw new RunnerError("invalid_cwd", "工作目录不存在: /nope");
    });
    const rejected = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi", cwd: "/nope" }),
    );
    expect(rejected.status).toBe(400);
    expect(errorCode(rejected.body)).toBe("invalid_cwd");
  });

  it("写端点缺少 Origin 返回 403 forbidden_origin", async () => {
    const s = await startUi({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      { "content-type": "application/json" },
      JSON.stringify({ text: "hi" }),
    );
    expect(res.status).toBe(403);
    expect(errorCode(res.body)).toBe("forbidden_origin");
  });

  it("GET /api/actions 返回 405", async () => {
    const s = await startUi({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/actions", "GET");
    expect(res.status).toBe(405);
    expect(errorCode(res.body)).toBe("method_not_allowed");
  });

  it("无 runner 时返回 503 runner_unavailable", async () => {
    const handler = createApiHandler({ harnessHome: makeHome() });
    const api = await startApi(handler);
    try {
      const res = await rawRequest(
        api.port,
        "/api/actions",
        "POST",
        { origin: "http://127.0.0.1", "content-type": "application/json" },
        JSON.stringify({ text: "hi" }),
      );
      expect(res.status).toBe(503);
      expect(errorCode(res.body)).toBe("runner_unavailable");
    } finally {
      await api.close();
    }
  });

  it("未知会话 + 无 providers 时优先返回 404 unknown_session", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi", sessionId: "no-such-session" }),
    );
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("unknown_session");
  });

  it("Body 非法 JSON 返回 400 invalid_body", async () => {
    const s = await startUi({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/actions", "POST", writeHeaders(s.port), "{bad");
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_body");
  });

  it("Body 非普通对象返回 400 invalid_body", async () => {
    const s = await startUi({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/actions", "POST", writeHeaders(s.port), "[1,2]");
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_body");
  });

  it("Content-Type 非 JSON 返回 415 unsupported_media_type", async () => {
    const s = await startUi({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      { origin: `http://127.0.0.1:${s.port}`, "content-type": "text/plain" },
      JSON.stringify({ text: "hi" }),
    );
    expect(res.status).toBe(415);
    expect(errorCode(res.body)).toBe("unsupported_media_type");
  });

  it("Body 超过 64 KiB 返回 413 payload_too_large", async () => {
    const s = await startUi({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "a".repeat(66_000) }),
    );
    expect(res.status).toBe(413);
    expect(errorCode(res.body)).toBe("payload_too_large");
  });

  it("Content-Type application/jsonp 返回 415", async () => {
    const s = await startUi({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      { origin: `http://127.0.0.1:${s.port}`, "content-type": "application/jsonp" },
      JSON.stringify({ text: "hi" }),
    );
    expect(res.status).toBe(415);
    expect(errorCode(res.body)).toBe("unsupported_media_type");
  });

  it.each<[string, string]>([
    ["非字符串", JSON.stringify({ text: 42 })],
    ["缺失", JSON.stringify({})],
  ])("text %s 返回 400 invalid_body 且不调用 runner", async (_label, payload) => {
    const runner = makeRunner();
    const s = await startUi({ harnessHome: makeHome(), runner });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      payload,
    );
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_body");
    expect(vi.mocked(runner.start)).not.toHaveBeenCalled();
  });

  it.each<[RunnerErrorCode, number]>([
    ["invalid_text", 400],
    ["invalid_session_id", 400],
    ["invalid_mode", 400],
    ["invalid_run_limits", 400],
    ["invalid_cwd", 400],
    ["unknown_session", 404],
    ["session_busy", 409],
    ["session_corrupt", 500],
    ["session_unreadable", 500],
    ["model_unavailable", 503],
    ["session_start_timeout", 503],
    ["runner_unavailable", 503],
  ])("RunnerError %s 映射为 %i", async (code, status) => {
    const runner = makeRunner({
      start: vi.fn(async () => { throw new RunnerError(code, "boom"); }),
    });
    const s = await startUi({ harnessHome: makeHome(), runner });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      writeHeaders(s.port),
      JSON.stringify({ text: "hi" }),
    );
    expect(res.status).toBe(status);
    expect(errorCode(res.body)).toBe(code);
  });


  it("拒绝非 loopback Host", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/sessions", "GET", { host: "evil.example" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden_host" } });
  });

  it("拒绝 Host 端口与监听端口不一致", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/sessions", "GET", {
      host: `127.0.0.1:${s.port + 1}`,
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden_host" } });
  });

  it("拒绝跨源 Origin", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/actions", "POST", {
      origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden_origin" } });
  });

  it("拒绝浏览器跨源写请求（Sec-Fetch-Site: cross-site）", async () => {
    const s = await startUi({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(
      s.port,
      "/api/actions",
      "POST",
      { ...writeHeaders(s.port), "sec-fetch-site": "cross-site" },
      JSON.stringify({ text: "hi" }),
    );
    expect(res.status).toBe(403);
    expect(errorCode(res.body)).toBe("forbidden_origin");
  });

  it("允许 loopback Host 与同源 Origin", async () => {
    const s = await startUi({ harnessHome: makeHome() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/sessions", "GET", {
      host: `localhost:${s.port}`,
      origin: `http://127.0.0.1:${s.port}`,
    });
    expect(res.status).toBe(200);
  });

  it("close 在 SSE 活跃连接下仍有界退出并终止请求", async () => {
    const home = makeHome();
    writeFileSync(path.join(home, "sessions", "s1", "header.json"), JSON.stringify({
      id: "s1", createdAt: "2026-10-18T00:00:00.000Z", status: "open",
    }));
    const s = await startUi({ harnessHome: home });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/events?sessionId=s1`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();

    const started = Date.now();
    await Promise.race([
      s.close(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("close 超时")), 1_000),
      ),
    ]);
    expect(Date.now() - started).toBeLessThan(1_000);

    const outcome = await Promise.race([
      (async (): Promise<string> => {
        for (;;) {
          try {
            const { done } = await reader.read();
            if (done) return "done";
          } catch {
            return "error";
          }
        }
      })(),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 1_000)),
    ]);
    expect(outcome).not.toBe("pending");
  });
});