import { mkdtempSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUiServer } from "../../src/server/api.js";
import type { RunnerDecideOutcome, SessionRunner } from "../../src/server/runner.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function makeServer(runner: SessionRunner): Promise<ReturnType<typeof createUiServer>> {
  const port = await freePort();
  return createUiServer({ harnessHome: makeHome(), port, runner });
}

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "eam-ui-approvals-"));
}

function runnerReturning(outcome: RunnerDecideOutcome): SessionRunner {
  return {
    start: vi.fn(async () => ({ sessionId: "created-1", created: true })),
    decide: vi.fn(async () => outcome),
    close: vi.fn(async () => {}),
  };
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

function errorCode(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

const PAYLOAD = JSON.stringify({ sessionId: "s1", requestId: "r1", decision: "allow" });

describe("approvals api", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("accepted 返回 202 并转发决策", async () => {
    const runner = runnerReturning({ kind: "accepted" });
    const s = await makeServer(runner);
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, PAYLOAD);
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ requestId: "r1", decision: "allow" });
    expect(vi.mocked(runner.decide)).toHaveBeenCalledWith("s1", "r1", "allow");
  });

  it("duplicate 返回 200 并标记 duplicate", async () => {
    const s = await makeServer(runnerReturning({ kind: "duplicate" }));
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, PAYLOAD);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      requestId: "r1",
      decision: "allow",
      duplicate: true,
    });
  });

  it("unknown_request 返回 404", async () => {
    const s = await makeServer(runnerReturning({ kind: "unknown_request" }));
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, PAYLOAD);
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("unknown_request");
  });

  it("unknown_session 返回 404", async () => {
    const s = await makeServer(runnerReturning({ kind: "unknown_session" }));
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, PAYLOAD);
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("unknown_session");
  });

  it("already_decided 返回 409", async () => {
    const s = await makeServer(runnerReturning({ kind: "already_decided" }));
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, PAYLOAD);
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe("already_decided");
  });

  it("超时后迟到决策返回 410 approval_expired", async () => {
    const s = await makeServer(runnerReturning({ kind: "expired" }));
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, PAYLOAD);
    expect(res.status).toBe(410);
    expect(errorCode(res.body)).toBe("approval_expired");
  });

  it("decision 不是 allow/deny 返回 400 invalid_decision 且不调用 runner", async () => {
    const runner = runnerReturning({ kind: "accepted" });
    const s = await makeServer(runner);
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, JSON.stringify({ sessionId: "s1", requestId: "r1", decision: "maybe" }));
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_decision");
    expect(vi.mocked(runner.decide)).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ["缺失 decision", JSON.stringify({ sessionId: "s1", requestId: "r1" })],
    ["decision 非字符串", JSON.stringify({ sessionId: "s1", requestId: "r1", decision: 1 })],
  ])("%s 返回 400 invalid_body 且不调用 runner", async (_label, payload) => {
    const runner = runnerReturning({ kind: "accepted" });
    const s = await makeServer(runner);
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, payload);
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_body");
    expect(vi.mocked(runner.decide)).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ["缺失 sessionId", JSON.stringify({ requestId: "r1", decision: "allow" })],
    ["sessionId 非字符串", JSON.stringify({ sessionId: 42, requestId: "r1", decision: "allow" })],
    ["缺失 requestId", JSON.stringify({ sessionId: "s1", decision: "allow" })],
    ["requestId 非字符串", JSON.stringify({ sessionId: "s1", requestId: 42, decision: "allow" })],
    ["requestId 空串", JSON.stringify({ sessionId: "s1", requestId: "", decision: "allow" })],
    ["requestId 超长", JSON.stringify({ sessionId: "s1", requestId: "r".repeat(201), decision: "allow" })],
    ["requestId 含控制字符", JSON.stringify({ sessionId: "s1", requestId: "r\u0000", decision: "allow" })],
    ["requestId 非 ASCII", JSON.stringify({ sessionId: "s1", requestId: "审批", decision: "allow" })],
  ])("%s 返回 400 invalid_body 且不调用 runner", async (_label, payload) => {
    const runner = runnerReturning({ kind: "accepted" });
    const s = await makeServer(runner);
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, payload);
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_body");
    expect(vi.mocked(runner.decide)).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ["路径穿越", "../evil"],
    ["含点", "s1.old"],
    ["空串", ""],
  ])("非法 sessionId 格式（%s）返回 400 invalid_session_id 且不调用 runner", async (_label, sessionId) => {
    const runner = runnerReturning({ kind: "accepted" });
    const s = await makeServer(runner);
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, JSON.stringify({ sessionId, requestId: "r1", decision: "allow" }));
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe("invalid_session_id");
    expect(vi.mocked(runner.decide)).not.toHaveBeenCalled();
  });


  it("requestId 恰好 200 字符时放行", async () => {
    const runner = runnerReturning({ kind: "accepted" });
    const s = await makeServer(runner);
    close = s.close;
    const requestId = "r".repeat(200);
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      origin: `http://127.0.0.1:${s.port}`,
      "content-type": "application/json",
    }, JSON.stringify({ sessionId: "s1", requestId, decision: "allow" }));
    expect(res.status).toBe(202);
    expect(vi.mocked(runner.decide)).toHaveBeenCalledWith("s1", requestId, "allow");
  });

  it("缺少 Origin 返回 403 forbidden_origin", async () => {
    const runner = runnerReturning({ kind: "accepted" });
    const s = await makeServer(runner);
    close = s.close;
    const res = await rawRequest(s.port, "/api/approvals", "POST", {
      "content-type": "application/json",
    }, PAYLOAD);
    expect(res.status).toBe(403);
    expect(errorCode(res.body)).toBe("forbidden_origin");
    expect(vi.mocked(runner.decide)).not.toHaveBeenCalled();
  });
});