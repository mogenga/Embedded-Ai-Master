import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiHandler, createUiServer } from "../../src/server/api.js";
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

function makeRunner(overrides: Partial<SessionRunner> = {}): SessionRunner {
  return {
    start: vi.fn(async () => ({ sessionId: "created-1", created: true })),
    decide: vi.fn(async () => ({ kind: "accepted" as const })),
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

  it("列表与详情使用同一 id 规则：含点目录记 invalid_id 且不可打开", async () => {
    const home = makeHome();
    writeSession(home, "s1.old", "s1");
    const s = createUiServer({ harnessHome: home });
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
    const s = createUiServer({ harnessHome: home });
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
    const s = createUiServer({ harnessHome: home });
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
    const s = createUiServer({ harnessHome: home });
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
    const s = createUiServer({ harnessHome: home });
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
    const s = createUiServer({ harnessHome: home });
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

  it("写操作接入 runner 返回 202，事件流返回真实 SSE", async () => {
    const runner = makeRunner();
    const s = createUiServer({ harnessHome: makeHome(), runner });
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

  it("写端点缺少 Origin 返回 403 forbidden_origin", async () => {
    const s = createUiServer({ harnessHome: makeHome(), runner: makeRunner() });
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
    const s = createUiServer({ harnessHome: makeHome(), runner: makeRunner() });
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
    const s = createUiServer({ harnessHome: makeHome() });
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
    const s = createUiServer({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/actions", "POST", writeHeaders(s.port), "{bad");
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_body");
  });

  it("Body 非普通对象返回 400 invalid_body", async () => {
    const s = createUiServer({ harnessHome: makeHome(), runner: makeRunner() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/actions", "POST", writeHeaders(s.port), "[1,2]");
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_body");
  });

  it("Content-Type 非 JSON 返回 415 unsupported_media_type", async () => {
    const s = createUiServer({ harnessHome: makeHome(), runner: makeRunner() });
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
    const s = createUiServer({ harnessHome: makeHome(), runner: makeRunner() });
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
    const s = createUiServer({ harnessHome: makeHome(), runner: makeRunner() });
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
    const s = createUiServer({ harnessHome: makeHome(), runner });
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
    const s = createUiServer({ harnessHome: makeHome(), runner });
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
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/sessions", "GET", { host: "evil.example" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden_host" } });
  });

  it("拒绝 Host 端口与监听端口不一致", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/sessions", "GET", {
      host: `127.0.0.1:${s.port + 1}`,
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden_host" } });
  });

  it("拒绝跨源 Origin", async () => {
    const s = createUiServer({ harnessHome: makeHome() });
    close = s.close;
    const res = await rawRequest(s.port, "/api/actions", "POST", {
      origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden_origin" } });
  });

  it("拒绝浏览器跨源写请求（Sec-Fetch-Site: cross-site）", async () => {
    const s = createUiServer({ harnessHome: makeHome(), runner: makeRunner() });
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
    const s = createUiServer({ harnessHome: makeHome() });
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
    const s = createUiServer({ harnessHome: home });
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