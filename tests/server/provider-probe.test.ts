import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeProvider } from "../../src/model/probe.js";
import { createUiServer } from "../../src/server/api.js";

/**
 * 「测试连接」探测。所有 HTTP 都打本地假网关（node:http 的 createServer），
 * 不触网：默认 `npm test` 必须离线通过。
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

const MISSING_ENV = "EAM_PROBE_ENV_THAT_DOES_NOT_EXIST";
const KEY_ENV = "EAM_PROBE_TEST_KEY";

let gateways: Gateway[] = [];
let home: string;

function track(gateway: Gateway): Gateway {
  gateways.push(gateway);
  return gateway;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "eam-provider-probe-"));
  // 并行改动会让「vitest 下缺 HARNESS_HOME」变成硬错误；显式指向临时目录。
  vi.stubEnv("HARNESS_HOME", home);
  delete process.env[MISSING_ENV];
  vi.stubEnv(KEY_ENV, "s3cret");
});

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  rmSync(home, { recursive: true, force: true });
});

describe("probeProvider", () => {
  it("/models 成功时列出模型并带 Bearer", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { object: "list", data: [{ id: "flash" }, { id: "pro" }] });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKeyEnv: KEY_ENV });

    expect(result).toMatchObject({
      ok: true,
      baseUrl: gateway.baseUrl,
      models: ["flash", "pro"],
    });
    expect(typeof result.latencyMs).toBe("number");
    expect(result.error).toBeUndefined();
    expect(result.code).toBeUndefined();
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({ method: "GET", url: "/v1/models" });
    expect(gateway.requests[0]?.headers.authorization).toBe("Bearer s3cret");
  });

  it("baseUrl 末尾斜杠不会产生双斜杠", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [] });
    }));

    const result = await probeProvider({ baseUrl: `${gateway.baseUrl}/`, apiKeyEnv: KEY_ENV });

    expect(result).toMatchObject({ ok: true, models: [] });
    expect(gateway.requests[0]?.url).toBe("/v1/models");
  });

  it("2xx 但响应体不是认识的形状时 ok 仍为 true，只是不带 models 与 error", async () => {
    const gateway = track(await startGateway((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ models: ["flash"] })); // 非 OpenAI 形状
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKeyEnv: KEY_ENV });

    expect(result.ok).toBe(true);
    // 契约：ok:true 不能带 error；拿不到列表时 models 字段不存在。
    expect(result.error).toBeUndefined();
    expect("models" in result).toBe(false);
  });

  it("2xx 但响应体不是 JSON 时也不报错（端点可达）", async () => {
    const gateway = track(await startGateway((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("ok");
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKeyEnv: KEY_ENV });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect("models" in result).toBe(false);
  });

  it("2xx 之后读 body 失败仍算端点可达，不回头报不可达", async () => {
    // 握手已经成功；读响应体时断线不能把「端点活着」改写成「连不上」。
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error("socket hang up");
          },
          releaseLock: () => undefined,
          cancel: async () => undefined,
        }),
      },
    })) as unknown as typeof fetch;

    const result = await probeProvider({ baseUrl: "http://gw.example/v1", fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect("models" in result).toBe(false);
  });

  it("密钥被拒绝时返回 unauthorized", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 401, { error: { message: "invalid api key" } });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKeyEnv: KEY_ENV });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unauthorized");
    expect(result.error).toContain("401");
    expect(result.error).toContain(KEY_ENV);
    expect(result.models).toBeUndefined();
    expect(gateway.requests[0]?.headers.authorization).toBe("Bearer s3cret");
  });

  it("403 同样归入 unauthorized", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 403, { error: { message: "forbidden" } });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKeyEnv: KEY_ENV });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unauthorized");
  });

  it("apiKeyEnv 指向的环境变量未设置时，错误里说清是环境变量缺失而非含糊的 401", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 401, { error: { message: "missing key" } });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKeyEnv: MISSING_ENV });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unauthorized");
    expect(result.error).toContain(MISSING_ENV);
    expect(result.error).toContain("未设置");
    // 没有密钥可发时不得伪造 Authorization 头。
    expect(gateway.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("未配置 apiKeyEnv 但网关要求鉴权时，说明是没有配 apiKeyEnv", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 401, { error: { message: "missing key" } });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unauthorized");
    expect(result.error).toContain("apiKeyEnv");
  });

  it("网络不可达时返回 unreachable", async () => {
    const port = await freePort();

    const result = await probeProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 3000,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unreachable");
    expect(result.error).toBeTruthy();
    expect(result.models).toBeUndefined();
  });

  it("服务端迟迟不响应时按超时返回 unreachable", async () => {
    const gateway = track(await startGateway(() => {
      // 永不响应：探测必须靠自己的计时器返回。
    }));

    const startedAt = Date.now();
    const result = await probeProvider({ baseUrl: gateway.baseUrl, timeoutMs: 300 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unreachable");
    expect(result.error).toContain("超时");
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("传入已中止的 AbortSignal 时抛出取消错误而不是伪造探测结论", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [] });
    }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      probeProvider({ baseUrl: gateway.baseUrl, signal: controller.signal, timeoutMs: 3000 }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    ["not-a-url", "not-a-url"],
    ["file 协议", "file:///C:/Windows/win.ini"],
    ["ftp 协议", "ftp://gw.example/v1"],
    ["带 query", "http://gw.example/v1?api-version=1"],
    ["带 hash", "http://gw.example/v1#frag"],
    ["空字符串", ""],
  ])("baseUrl 非法（%s）时不发请求，返回 invalid_base_url", async (_label, baseUrl) => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("不应发出请求");
    }) as unknown as typeof fetch;

    const result = await probeProvider({ baseUrl, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_base_url");
    expect(result.error).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("/models 返回 404 且没给 model 时如实报 http_error，并提示可填模型名兜底", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 404, { error: { message: "not found" } });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKeyEnv: KEY_ENV });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("http_error");
    expect(result.error).toContain("404");
    expect(result.error).toContain("模型名");
    // 没有 model 就不该打 chat/completions。
    expect(gateway.requests.map((entry) => entry.url)).toEqual(["/v1/models"]);
  });

  it("/models 返回 404 时用最小 chat/completions 请求兜底并成功", async () => {
    const gateway = track(await startGateway((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        json(res, 404, { error: { message: "no model listing" } });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        json(res, 200, { choices: [{ message: { content: "p" }, finish_reason: "length" }] });
        return;
      }
      json(res, 500, { error: { message: "unexpected" } });
    }));

    const result = await probeProvider({
      baseUrl: gateway.baseUrl,
      apiKeyEnv: KEY_ENV,
      model: "flash",
    });

    expect(result).toMatchObject({ ok: true, baseUrl: gateway.baseUrl });
    expect(result.error).toBeUndefined();
    expect(gateway.requests.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
    ]);
    const chat = gateway.requests[1];
    expect(chat?.headers.authorization).toBe("Bearer s3cret");
    expect(JSON.parse(chat?.body ?? "{}")).toMatchObject({
      model: "flash",
      max_tokens: 1,
      stream: false,
      messages: [expect.objectContaining({ role: "user" })],
    });
  });

  it("兜底请求也失败时如实返回 ok:false，并同时说明两次失败", async () => {
    const gateway = track(await startGateway((req, res) => {
      if (req.url === "/v1/models") {
        json(res, 404, { error: { message: "no listing" } });
        return;
      }
      json(res, 400, { error: { message: "unknown model" } });
    }));

    const result = await probeProvider({
      baseUrl: gateway.baseUrl,
      apiKeyEnv: KEY_ENV,
      model: "nope",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("http_error");
    expect(result.error).toContain("404");
    expect(result.error).toContain("400");
  });
});

describe("POST /api/providers/test", () => {
  let ui: ReturnType<typeof createUiServer> | undefined;

  async function startUi(): Promise<number> {
    const port = await freePort();
    ui = createUiServer({ harnessHome: home, port, host: "127.0.0.1" });
    await ui.listening;
    return port;
  }

  afterEach(async () => {
    await ui?.close();
    ui = undefined;
  });

  function writeHeaders(port: number): Record<string, string> {
    return {
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/json; charset=utf-8",
    };
  }

  function post(port: number, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/providers/test`, {
      method: "POST",
      headers: writeHeaders(port),
      body: JSON.stringify(body),
    });
  }

  it("探测成功时返回 200 + ProviderProbeResult", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [{ id: "flash" }] });
    }));
    const port = await startUi();

    const response = await post(port, { baseUrl: gateway.baseUrl, apiKeyEnv: KEY_ENV });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      baseUrl: gateway.baseUrl,
      models: ["flash"],
    });
  });

  it("探测失败时同样是 200，失败是答案不是 HTTP 错误", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 401, { error: { message: "nope" } });
    }));
    const port = await startUi();

    const response = await post(port, { baseUrl: gateway.baseUrl, apiKeyEnv: KEY_ENV });

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; code: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unauthorized");
    expect(body.error).toBeTruthy();
  });

  it("baseUrl 缺失或不是字符串时返回 400 invalid_base_url", async () => {
    const port = await startUi();

    const missing = await post(port, {});
    expect(missing.status).toBe(400);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe("invalid_base_url");

    const wrongType = await post(port, { baseUrl: 42 });
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json() as { error: { code: string } }).error.code).toBe("invalid_base_url");
  });

  it("可选字段类型不对时返回 400", async () => {
    const port = await startUi();

    const badEnv = await post(port, { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: 42 });
    expect(badEnv.status).toBe(400);
    expect((await badEnv.json() as { error: { code: string } }).error.code).toBe("invalid_base_url");

    const badModel = await post(port, { baseUrl: "http://127.0.0.1:1/v1", model: {} });
    expect(badModel.status).toBe(400);
    expect((await badModel.json() as { error: { code: string } }).error.code).toBe("invalid_base_url");
  });

  it("缺少 Origin 时按写端点拒绝（403），不会真的去探测", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [] });
    }));
    const port = await startUi();

    const response = await fetch(`http://127.0.0.1:${port}/api/providers/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: gateway.baseUrl }),
    });

    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("forbidden_origin");
    expect(gateway.requests).toHaveLength(0);
  });

  it("GET 方法返回 405", async () => {
    const port = await startUi();

    const response = await fetch(`http://127.0.0.1:${port}/api/providers/test`);

    expect(response.status).toBe(405);
  });
});
