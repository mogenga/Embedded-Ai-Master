import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUiServer } from "../../src/server/api.js";

/**
 * `POST /api/providers/test` 的 `apiKey` 字段（直接填写的密钥）。
 *
 * 只覆盖「接口把 apiKey 交给探测」这一段：密钥解析本身在
 * `tests/probe-api-key.test.ts`，探测规则在 `tests/server/provider-probe.test.ts`。
 *
 * 安全要求（本文件的全部要点）：
 * - 密钥只能出现在发往网关的 `Authorization` 头里；
 * - 响应体（成功或失败）不含密钥原文；
 * - 类型不对时 400，错误文本里也不含收到的值。
 *
 * 所有 HTTP 都打本地假网关（node:http），不触网。
 */

interface GatewayRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Gateway {
  baseUrl: string;
  requests: GatewayRequest[];
  close(): Promise<void>;
}

type GatewayHandler = (req: GatewayRequest, res: ServerResponse) => void;

async function startGateway(handler: GatewayHandler): Promise<Gateway> {
  const requests: GatewayRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry: GatewayRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(entry);
      handler(entry, res);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("假网关未能绑定端口");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        // 挂起的请求会让 server.close() 一直等待；测试收尾必须销毁连接。
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("无法获取空闲端口")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const KEY_ENV = "EAM_PROBE_ENDPOINT_KEY_ENV";
const ENV_KEY_VALUE = "from-env-value";
const MISSING_ENV = "EAM_PROBE_ENDPOINT_MISSING_ENV";
const DIRECT_KEY = "sk-endpoint-0123456789abcdef";

let gateways: Gateway[] = [];
let ui: ReturnType<typeof createUiServer> | undefined;
let home: string;

function track(gateway: Gateway): Gateway {
  gateways.push(gateway);
  return gateway;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "eam-probe-api-key-"));
  // 并行改动会让「vitest 下缺 HARNESS_HOME」变成硬错误；显式指向临时目录。
  vi.stubEnv("HARNESS_HOME", home);
  vi.stubEnv(KEY_ENV, ENV_KEY_VALUE);
  delete process.env[MISSING_ENV];
});

afterEach(async () => {
  await ui?.close();
  ui = undefined;
  for (const gateway of gateways.splice(0)) await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

async function startUi(): Promise<number> {
  const port = await freePort();
  ui = createUiServer({ harnessHome: home, port, host: "127.0.0.1" });
  await ui.listening;
  return port;
}

function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/providers/test`, {
    method: "POST",
    headers: {
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/providers/test 的 apiKey", () => {
  it("apiKey 透传给探测：网关收到 Bearer <key>，响应体不含密钥", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { object: "list", data: [{ id: "flash" }] });
    }));
    const port = await startUi();

    const response = await post(port, { baseUrl: gateway.baseUrl, apiKey: DIRECT_KEY });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      baseUrl: gateway.baseUrl,
      models: ["flash"],
    });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.headers.authorization).toBe(`Bearer ${DIRECT_KEY}`);
    // 响应是用户能看到的东西：密钥不能出现在里面。
    expect(text).not.toContain(DIRECT_KEY);
  });

  it("apiKey 优先于 apiKeyEnv（两者同时给时用 apiKey）", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [{ id: "flash" }] });
    }));
    const port = await startUi();

    const response = await post(port, {
      baseUrl: gateway.baseUrl,
      apiKey: DIRECT_KEY,
      apiKeyEnv: KEY_ENV,
    });

    expect(response.status).toBe(200);
    expect(gateway.requests[0]?.headers.authorization).toBe(`Bearer ${DIRECT_KEY}`);
  });

  it("只给 apiKeyEnv 时仍走环境变量（既有路径不被破坏）", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [{ id: "flash" }] });
    }));
    const port = await startUi();

    const response = await post(port, { baseUrl: gateway.baseUrl, apiKeyEnv: KEY_ENV });

    expect(response.status).toBe(200);
    expect(gateway.requests[0]?.headers.authorization).toBe(`Bearer ${ENV_KEY_VALUE}`);
  });

  it("apiKey 为空串等于没填：请求不带 Authorization", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [{ id: "flash" }] });
    }));
    const port = await startUi();

    const response = await post(port, { baseUrl: gateway.baseUrl, apiKey: "" });

    expect(response.status).toBe(200);
    expect(gateway.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("网关拒绝 apiKey 时，失败响应只给原因不给密钥", async () => {
    const gateway = track(await startGateway((_req, res) => {
      // 网关把请求头原样回显：这是最容易被顺带泄露的一段文本。
      json(res, 401, { error: { message: `invalid api key: Bearer ${DIRECT_KEY}` } });
    }));
    const port = await startUi();

    const response = await post(port, { baseUrl: gateway.baseUrl, apiKey: DIRECT_KEY });

    // 探测失败是答案，不是服务端错误：200 + ProviderProbeResult。
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { ok: boolean; code?: string; error?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unauthorized");
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("401");
    expect(text).not.toContain(DIRECT_KEY);
  });

  it("apiKeyEnv 指向未设置的变量时，原因说清是变量缺失，且不含任何密钥原文", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 401, { error: { message: "missing key" } });
    }));
    const port = await startUi();

    const response = await post(port, { baseUrl: gateway.baseUrl, apiKeyEnv: MISSING_ENV });

    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { ok: boolean; code?: string; error?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unauthorized");
    expect(body.error).toContain(MISSING_ENV);
    expect(text).not.toContain(DIRECT_KEY);
    // 缺变量时也会照常发探测请求（只是不带 Authorization），因此网关应当
    // 收到一次、且那次请求没有凭据头——「没配密钥」不等于「不发请求」。
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("apiKey 不是字符串时 400，错误文本不回显收到的值", async () => {
    const port = await startUi();

    const response = await post(port, { baseUrl: "http://127.0.0.1:1/v1", apiKey: 42 });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "invalid_base_url", message: "apiKey 必须是字符串" },
    });
    expect(text).not.toContain("42");
  });

  it("apiKey 是对象时同样 400（不把对象序列化进错误）", async () => {
    const port = await startUi();
    const secretish = "leak-me-not";

    const response = await post(port, {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: { token: secretish },
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "invalid_base_url" } });
    expect(text).not.toContain(secretish);
  });
});
