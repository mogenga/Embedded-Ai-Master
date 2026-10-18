import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProvidersConfig } from "../src/config/providers.js";
import {
  parseArgs,
  resolveExitCode,
  resolveModelRefFromEnv,
  sanitizeTerminalText,
  sessionCost,
  withOverrides,
} from "../src/demo/run.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "demo-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const PROVIDERS: ProvidersConfig = {
  gw: {
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    models: { flash: { contextWindow: 8192, maxOutput: 512 } },
  },
};

describe("parseArgs", () => {
  it("--help 返回 help", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["prompt", "--help"])).toEqual({ kind: "help" });
  });

  it("缺少 prompt 返回错误", () => {
    expect(parseArgs([])).toMatchObject({ kind: "error" });
  });

  it("正常 prompt 返回 run", () => {
    expect(parseArgs(["hello"])).toEqual({ kind: "run", prompt: "hello" });
  });

  it("未知 flag 返回错误", () => {
    expect(parseArgs(["--verbose", "hello"])).toMatchObject({ kind: "error" });
  });

  it("多余位置参数返回错误", () => {
    expect(parseArgs(["hello", "world"])).toMatchObject({ kind: "error" });
  });
});

describe("resolveModelRefFromEnv", () => {
  it("缺失或空白时返回 undefined", () => {
    expect(resolveModelRefFromEnv({})).toBeUndefined();
    expect(resolveModelRefFromEnv({ HARNESS_COMPAT_MODEL: "" })).toBeUndefined();
    expect(resolveModelRefFromEnv({ HARNESS_COMPAT_MODEL: "   " })).toBeUndefined();
  });

  it("存在时返回 trim 后的引用", () => {
    expect(resolveModelRefFromEnv({ HARNESS_COMPAT_MODEL: "  gw/flash  " })).toBe("gw/flash");
  });
});

describe("withOverrides", () => {
  it("clone providers 后覆盖 baseUrl 与 apiKeyEnv", () => {
    const next = withOverrides(PROVIDERS, "gw", {
      HARNESS_COMPAT_BASE_URL: "http://override/v1",
      HARNESS_COMPAT_API_KEY_ENV: "OVERRIDE_KEY",
    });

    expect(next).not.toBe(PROVIDERS);
    expect(next.gw).not.toBe(PROVIDERS.gw);
    expect(next.gw.baseUrl).toBe("http://override/v1");
    expect(next.gw.apiKeyEnv).toBe("OVERRIDE_KEY");
    expect(PROVIDERS.gw.baseUrl).toBe("http://127.0.0.1:9/v1");
    expect(PROVIDERS.gw.apiKeyEnv).toBeUndefined();
  });

  it("空值不覆盖", () => {
    const next = withOverrides(PROVIDERS, "gw", {
      HARNESS_COMPAT_BASE_URL: "",
      HARNESS_COMPAT_API_KEY_ENV: "   ",
    });

    expect(next.gw.baseUrl).toBe("http://127.0.0.1:9/v1");
    expect(next.gw.apiKeyEnv).toBeUndefined();
  });

  it("拒绝原型链 provider 名且不污染 Object.prototype", () => {
    expect(() => withOverrides(PROVIDERS, "__proto__", {
      HARNESS_COMPAT_BASE_URL: "http://polluted/v1",
    })).toThrowError();

    expect(({} as { baseUrl?: string }).baseUrl).toBeUndefined();
    expect(PROVIDERS.gw.baseUrl).toBe("http://127.0.0.1:9/v1");
  });
});

describe("sanitizeTerminalText", () => {
  it("剥离 C0/C1 控制字符并保留换行与制表符", () => {
    const input = `a\x00b\x07c\x1bd\x9be\n\tf`;
    expect(sanitizeTerminalText(input)).toBe("abcde\n\tf");
  });

  it("剥离回车并保留换行", () => {
    expect(sanitizeTerminalText("\rfirst\nsecond\r\nthird\r")).toBe("first\nsecond\nthird");
    expect(sanitizeTerminalText("\rline")).toBe("line");
  });

  it("剥离 ESC、OSC 52 与清屏序列的控制字符", () => {
    const input = `before\x1b]52;c;Zm9v\x07\x1b[2Jafter\x1b[3J`;
    const result = sanitizeTerminalText(input);
    expect(result).toBe("before]52;c;Zm9v[2Jafter[3J");
    expect(result).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/);
  });
});

describe("sessionCost", () => {
  function sessionHeader(): Record<string, unknown> {
    return { id: "sess-1", createdAt: "2026-01-01T00:00:00.000Z", status: "closed" };
  }

  async function writeSession(
    v1: unknown[],
    v2?: unknown[],
  ): Promise<string> {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, "header.json"),
      `${JSON.stringify(sessionHeader())}\n`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "session.v1.jsonl"),
      `${v1.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
    if (v2 !== undefined) {
      await writeFile(
        path.join(dir, "session.v2.jsonl"),
        `${v2.map((line) => JSON.stringify(line)).join("\n")}\n`,
        "utf8",
      );
    }
    return dir;
  }

  it("按 usage 事件与价格汇总费用与 token", async () => {
    const sessionDir = await writeSession([
      { seq: 0, ts: "2026-01-01T00:00:00.000Z", type: "user", payload: { content: "hi" } },
      { seq: 1, ts: "2026-01-01T00:00:01.000Z", type: "usage", payload: { promptTokens: 10, completionTokens: 5 } },
      {
        seq: 2,
        ts: "2026-01-01T00:00:02.000Z",
        type: "usage",
        payload: { promptTokens: 10, completionTokens: 5, cachedTokens: 4 },
      },
    ]);

    const result = sessionCost(sessionDir, { input: 1, output: 2, cachedInput: 0.5 });
    expect(result).toMatchObject({
      priced: true,
      promptTokens: 20,
      completionTokens: 10,
      cachedTokens: 4,
    });
    expect(result?.cost).toBeCloseTo(0.000038, 12);
  });

  it("跨代 usage 一并汇总", async () => {
    const sessionDir = await writeSession(
      [
        { seq: 0, ts: "2026-01-01T00:00:00.000Z", type: "user", payload: { content: "hi" } },
        { seq: 1, ts: "2026-01-01T00:00:01.000Z", type: "usage", payload: { promptTokens: 10, completionTokens: 5 } },
      ],
      [
        { seq: 2, ts: "2026-01-01T00:00:02.000Z", type: "usage", payload: { promptTokens: 10, completionTokens: 5, cachedTokens: 4 } },
      ],
    );

    const result = sessionCost(sessionDir, { input: 1, output: 2, cachedInput: 0.5 });
    expect(result).toMatchObject({
      priced: true,
      promptTokens: 20,
      completionTokens: 10,
      cachedTokens: 4,
    });
    expect(result?.cost).toBeCloseTo(0.000038, 12);
  });

  it("price 缺省时 priced 为 false 并统计 token", async () => {
    const sessionDir = await writeSession([
      { seq: 0, ts: "2026-01-01T00:00:00.000Z", type: "usage", payload: { promptTokens: 10, completionTokens: 5 } },
    ]);

    expect(sessionCost(sessionDir)).toEqual({
      cost: 0,
      priced: false,
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0,
    });
  });

  it("token 累加对负数与非有限值归一为 0", async () => {
    const sessionDir = await writeSession([
      {
        seq: 0,
        ts: "2026-01-01T00:00:00.000Z",
        type: "usage",
        payload: { promptTokens: -5, completionTokens: Number.POSITIVE_INFINITY, cachedTokens: Number.NaN },
      },
      {
        seq: 1,
        ts: "2026-01-01T00:00:01.000Z",
        type: "usage",
        payload: { promptTokens: 10, completionTokens: 5, cachedTokens: -1 },
      },
    ]);

    const result = sessionCost(sessionDir, { input: 1, output: 1, cachedInput: 1 });

    expect(result).toMatchObject({
      priced: true,
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0,
    });
    expect(result?.cost).toBeCloseTo(0.000015, 12);
  });

  it("读取失败返回 undefined", async () => {
    const dir = await tempDir();
    expect(sessionCost(path.join(dir, "missing"), { input: 1, output: 1 })).toBeUndefined();
  });

  it("文件损坏返回 undefined", async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, "header.json"),
      `${JSON.stringify(sessionHeader())}\n`,
      "utf8",
    );
    await writeFile(path.join(dir, "session.v1.jsonl"), "{not-json}\n", "utf8");
    expect(sessionCost(dir, { input: 1, output: 1 })).toBeUndefined();
  });
});

describe("resolveExitCode", () => {
  it("无错误时按 finishReason 映射", () => {
    expect(resolveExitCode("no_tool_calls")).toBe(0);
    expect(resolveExitCode("max_turns")).toBe(1);
    expect(resolveExitCode("max_cost_usd")).toBe(1);
    expect(resolveExitCode("aborted")).toBe(130);
    expect(resolveExitCode(undefined)).toBe(1);
  });

  it("有错误时返回 2", () => {
    expect(resolveExitCode("no_tool_calls", new Error("boom"))).toBe(2);
    expect(resolveExitCode(undefined, { code: "api_4xx" })).toBe(2);
  });
});
