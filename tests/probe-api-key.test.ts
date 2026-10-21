import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { looksLikeSecret, probeProvider } from "../src/model/probe.js";

/**
 * 直接填写的 API 密钥（`apiKey`）在「测试连接」里的行为，以及
 * `looksLikeSecret` 误填提示。
 *
 * 需求背景：用户把密钥本身填进了「密钥环境变量名」字段，探测却回
 * 「环境变量 d07d… 未设置」，用户不知道错在哪。设计上不再要求用户去设
 * 系统环境变量（桌面应用做不到），但既有 `apiKeyEnv` 路径必须保持可用，
 * 文案也要能把「填错字段」指出来。
 *
 * 所有 HTTP 都打本地假网关（node:http 的 createServer），不触网。
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

const ENV_KEY_NAME = "EAM_PROBE_DIRECT_KEY_ENV";
const ENV_KEY_VALUE = "from-env-value";
const DIRECT_KEY = "sk-direct-inline-key";

let gateways: Gateway[] = [];

function track(gateway: Gateway): Gateway {
  gateways.push(gateway);
  return gateway;
}

beforeEach(() => {
  vi.stubEnv(ENV_KEY_NAME, ENV_KEY_VALUE);
});

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
});

describe("probeProvider 直接填写的 apiKey", () => {
  it("apiKey 直填时请求带 Authorization: Bearer <key>", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { object: "list", data: [{ id: "flash" }] });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKey: DIRECT_KEY });

    expect(result).toMatchObject({ ok: true, models: ["flash"] });
    expect(gateway.requests[0]?.headers.authorization).toBe(`Bearer ${DIRECT_KEY}`);
  });

  it("apiKey 优先于 apiKeyEnv 指向的环境变量", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [{ id: "flash" }] });
    }));

    const result = await probeProvider({
      baseUrl: gateway.baseUrl,
      apiKey: DIRECT_KEY,
      apiKeyEnv: ENV_KEY_NAME,
    });

    expect(result.ok).toBe(true);
    expect(gateway.requests[0]?.headers.authorization).toBe(`Bearer ${DIRECT_KEY}`);
  });

  it("apiKey 为空串时回落到 apiKeyEnv，不发送空 Bearer", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [] });
    }));

    await probeProvider({ baseUrl: gateway.baseUrl, apiKey: "", apiKeyEnv: ENV_KEY_NAME });

    expect(gateway.requests[0]?.headers.authorization).toBe(`Bearer ${ENV_KEY_VALUE}`);
  });

  it("apiKey 只有空白同样视为未配置，不发 Authorization", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 200, { data: [] });
    }));

    await probeProvider({ baseUrl: gateway.baseUrl, apiKey: "   " });

    expect(gateway.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("apiKey 真的被服务端拒绝时，文案不把密钥原文回显出来", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 401, { error: { message: "invalid api key" } });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKey: DIRECT_KEY });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unauthorized");
    // 密钥只能进请求头，绝不能进错误信息（错误会进事件流/日志/前端）。
    expect(result.error).not.toContain(DIRECT_KEY);
  });

  it("apiKeyEnv 误填成密钥本身时，文案指出「这看起来是密钥，不是变量名」且不含密钥原文", async () => {
    // 用户原始报告的场景：把 32 位十六进制密钥填进了 apiKeyEnv 字段。
    // 形状与真实凭据一致即可；测试里不写真实密钥。
    const misused = "0123456789abcdef0123456789abcdef";
    const gateway = track(await startGateway((_req, res) => {
      json(res, 401, { error: { message: "missing key" } });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKeyEnv: misused });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unauthorized");
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("看起来是密钥");
    expect(result.error).toContain("API 密钥");
    // 指引必须提到正确的做法；同时不能把用户填的密钥原文抄进错误里。
    expect(result.error).not.toContain(misused);
    // 未配置任何密钥：既没发 Authorization，也不该说成「环境变量已拒绝」。
    expect(gateway.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("sk- 前缀误填进 apiKeyEnv 也识别为密钥", async () => {
    const misused = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const gateway = track(await startGateway((_req, res) => {
      json(res, 401, { error: { message: "missing key" } });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl, apiKeyEnv: misused });

    expect(result.error).toContain("看起来是密钥");
    expect(result.error).not.toContain(misused);
  });

  it("什么都没配时，文案说「未配置 API 密钥」而不只是提环境变量", async () => {
    const gateway = track(await startGateway((_req, res) => {
      json(res, 401, { error: { message: "missing key" } });
    }));

    const result = await probeProvider({ baseUrl: gateway.baseUrl });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unauthorized");
    expect(result.error).toContain("未配置");
    expect(result.error).toContain("API 密钥");
  });
});

describe("looksLikeSecret", () => {
  it.each([
    ["32 位以上十六进制串（用户报告的形状）", "0123456789abcdef0123456789abcdef"],
    ["sk- 前缀的 OpenAI 风格密钥", "sk-abcdefghijklmnopqrstuvwxyz0123456789"],
    ["sk- 短前缀也算（有密钥形态）", "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx"],
    ["长度 > 40 且不含环境变量命名特征", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"],
  ])("%s → true", (_label, value) => {
    expect(looksLikeSecret(value)).toBe(true);
  });

  it.each([
    ["大写下划线环境变量名", "DEEPSEEK_API_KEY"],
    ["短环境变量名", "MY_KEY"],
    ["小写点分名", "openai.api.key"],
    ["驼峰名", "openaiApiKey"],
    ["带数字的环境变量名", "OPENAI_API_KEY_2"],
    ["常见前缀式环境变量名", "ANTHROPIC_AUTH_TOKEN"],
  ])("%s → false", (_label, value) => {
    expect(looksLikeSecret(value)).toBe(false);
  });

  it("空串与纯空白不算密钥", () => {
    expect(looksLikeSecret("")).toBe(false);
    expect(looksLikeSecret("   ")).toBe(false);
  });

  it("判定前先 trim：首尾空白不影响结论", () => {
    expect(looksLikeSecret("  0123456789abcdef0123456789abcdef  ")).toBe(true);
    expect(looksLikeSecret("  DEEPSEEK_API_KEY  ")).toBe(false);
  });
});
