import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProvidersConfig } from "../src/config/providers.js";
import {
  parseArgs,
  resolveModelRefFromEnv,
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
});

describe("sessionCost", () => {
  async function writeEvents(lines: unknown[]): Promise<string> {
    const dir = await tempDir();
    const filePath = path.join(dir, "session.v1.jsonl");
    await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
    return filePath;
  }

  it("按 usage 事件与价格汇总费用", async () => {
    const filePath = await writeEvents([
      { seq: 0, ts: "2026-01-01T00:00:00.000Z", type: "user", payload: { content: "hi" } },
      { seq: 1, ts: "2026-01-01T00:00:01.000Z", type: "usage", payload: { promptTokens: 10, completionTokens: 5 } },
      {
        seq: 2,
        ts: "2026-01-01T00:00:02.000Z",
        type: "usage",
        payload: { promptTokens: 10, completionTokens: 5, cachedTokens: 4 },
      },
    ]);

    expect(sessionCost(filePath, { input: 1, output: 2, cachedInput: 0.5 })).toBeCloseTo(
      0.000038,
      12,
    );
  });

  it("price 缺省时费用为 0", async () => {
    const filePath = await writeEvents([
      { seq: 0, ts: "2026-01-01T00:00:00.000Z", type: "usage", payload: { promptTokens: 10, completionTokens: 5 } },
    ]);

    expect(sessionCost(filePath)).toBe(0);
  });

  it("读取失败返回 undefined", async () => {
    const dir = await tempDir();
    expect(sessionCost(path.join(dir, "missing.jsonl"), { input: 1, output: 1 })).toBeUndefined();
  });

  it("文件损坏返回 undefined", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "broken.jsonl");
    await writeFile(filePath, "{not-json}\n", "utf8");
    expect(sessionCost(filePath, { input: 1, output: 1 })).toBeUndefined();
  });
});
