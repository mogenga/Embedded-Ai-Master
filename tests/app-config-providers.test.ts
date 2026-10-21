import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppConfigError,
  readAppConfig,
  readProviders,
  writeProviders,
} from "../src/config/app-config.js";
import type { ProvidersConfig } from "../src/config/providers.js";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "eam-app-config-providers-"));
  homes.push(home);
  return home;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readRaw(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function tmpFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function expectAppConfigError(run: () => unknown, code: string): AppConfigError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppConfigError);
  const appError = caught as AppConfigError;
  expect(appError.code).toBe(code);
  // 报错必须带原因与文件位置（R3），不能只说「无效」。
  expect(appError.message.length).toBeGreaterThan(0);
  expect(appError.message).toContain("providers.json");
  return appError;
}

const OPENAI_PROVIDER: ProvidersConfig[string] = {
  protocol: "openai-chat-completions",
  baseUrl: "https://api.example.com/v1",
  apiKeyEnv: "EAM_API_KEY",
  models: {
    "test-model": { contextWindow: 128_000, maxOutput: 4096 },
  },
  requestTimeoutMs: 30_000,
  maxResponseBytes: 1_048_576,
  pricePerMillion: { input: 1, output: 2, cachedInput: 0.5 },
};

const VALID_FILE: ProvidersConfig = { openai: OPENAI_PROVIDER };

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("readProviders", () => {
  it("providers.json 不存在时返回空配置，不抛错", () => {
    const home = makeHome();

    const result = readProviders(home);

    expect(result.providers).toEqual({});
    expect(result.providersPath).toBe(path.join(home, "providers.json"));
  });

  it("合法文件原样读出", () => {
    const home = makeHome();
    writeJson(path.join(home, "providers.json"), VALID_FILE);

    const result = readProviders(home);

    expect(result.providers).toEqual(VALID_FILE);
    expect(result.providersPath).toBe(path.join(home, "providers.json"));
  });

  it("模型没写 contextWindow/maxOutput 时照常读出（由内核默认值兜底）", () => {
    const home = makeHome();
    const minimal = {
      openai: { ...OPENAI_PROVIDER, models: { "test-model": {} } },
    };
    writeJson(path.join(home, "providers.json"), minimal);

    const result = readProviders(home);

    // 不补默认值：文件里没写就是没写，设置页与日志都不该声称用户填过。
    expect(result.providers).toEqual(minimal);
    expect(result.providers.openai?.models["test-model"]).toEqual({});
  });

  it("旧文件里写下的 contextWindow/maxOutput 原样保留", () => {
    const home = makeHome();
    writeJson(path.join(home, "providers.json"), VALID_FILE);

    const result = readProviders(home);

    expect(result.providers.openai?.models["test-model"]).toEqual({
      contextWindow: 128_000,
      maxOutput: 4096,
    });
  });

  it("坏 JSON 抛 config_unreadable 并指明文件", () => {
    const home = makeHome();
    writeFileSync(path.join(home, "providers.json"), "{bad", "utf8");

    expectAppConfigError(() => readProviders(home), "config_unreadable");
  });

  it.each<[string, unknown]>([
    ["顶层是数组", []],
    ["顶层是数字", 42],
    ["顶层是字符串", "openai"],
    // contextWindow / maxOutput 是可选的，缺省由内核默认值兜底，不再算无效配置。
    ["contextWindow 非正整数", { openai: { ...OPENAI_PROVIDER, models: { m: { contextWindow: 0 } } } }],
    ["maxOutput 非整数", { openai: { ...OPENAI_PROVIDER, models: { m: { maxOutput: 1.5 } } } }],
    ["protocol 不支持", { openai: { ...OPENAI_PROVIDER, protocol: "anthropic" } }],
    ["baseUrl 非 URL", { openai: { ...OPENAI_PROVIDER, baseUrl: "not-a-url" } }],
    ["models 不是对象", { openai: { ...OPENAI_PROVIDER, models: [] } }],
  ])("schema 不符抛 invalid_config（%s）", (_label, value) => {
    const home = makeHome();
    writeJson(path.join(home, "providers.json"), value);

    expectAppConfigError(() => readProviders(home), "invalid_config");
  });
});

describe("writeProviders", () => {
  it("落盘后 readProviders 能读回，文件是 2 空格缩进 + 末尾换行", async () => {
    const home = makeHome();

    const written = await writeProviders(home, VALID_FILE);

    expect(written).toEqual(VALID_FILE);
    expect(readProviders(home).providers).toEqual(VALID_FILE);
    const raw = readRaw(path.join(home, "providers.json"));
    expect(raw).toBe(`${JSON.stringify(VALID_FILE, null, 2)}\n`);
    expect(raw).toContain('\n  "openai": {');
    expect(raw.endsWith("\n")).toBe(true);
    expect(tmpFilesIn(home)).toEqual([]);
  });

  it("整份替换：不在文件里留下上一版的 provider", async () => {
    const home = makeHome();
    await writeProviders(home, VALID_FILE);

    await writeProviders(home, { local: { ...OPENAI_PROVIDER, baseUrl: "http://127.0.0.1:8080/v1" } });

    const providers = readProviders(home).providers;
    expect(Object.keys(providers)).toEqual(["local"]);
    // 整份替换：上一版的 provider 键不在文件里（protocol 字面量含 "openai"，不能直接查子串）。
    const raw = JSON.parse(readRaw(path.join(home, "providers.json"))) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["local"]);
  });

  it("写入空对象得到空配置而不是报错", async () => {
    const home = makeHome();

    await writeProviders(home, {});

    expect(readProviders(home).providers).toEqual({});
  });

  it.each<[string, unknown]>([
    ["顶层是数组", [OPENAI_PROVIDER]],
    ["顶层是数字", 42],
    ["顶层是 null", null],
    ["contextWindow 非正整数", { openai: { ...OPENAI_PROVIDER, models: { m: { contextWindow: 0 } } } }],
    ["protocol 不支持", { openai: { ...OPENAI_PROVIDER, protocol: "anthropic" } }],
    ["baseUrl 非 URL", { openai: { ...OPENAI_PROVIDER, baseUrl: "not-a-url" } }],
    ["pricePerMillion 为负", {
      openai: { ...OPENAI_PROVIDER, pricePerMillion: { input: -1, output: 0 } },
    }],
    ["undefined", undefined],
    ["函数", () => ({})],
  ])("非法输入被拒（%s）且原文件不变", async (_label, input) => {
    const home = makeHome();
    const before = `${JSON.stringify(VALID_FILE, null, 2)}\n`;
    writeFileSync(path.join(home, "providers.json"), before, "utf8");

    await expect(writeProviders(home, input)).rejects.toBeInstanceOf(AppConfigError);
    await expect(writeProviders(home, input)).rejects.toMatchObject({ code: "invalid_config" });

    expect(readRaw(path.join(home, "providers.json"))).toBe(before);
    expect(tmpFilesIn(home)).toEqual([]);
  });
});

describe("readAppConfig 的 providers 降级读取", () => {
  it("providers.json 正常时快照带 providers 与 providersPath，且没有 providersError", () => {
    const home = makeHome();
    writeJson(path.join(home, "providers.json"), VALID_FILE);

    const snapshot = readAppConfig(home);

    expect(snapshot.providers).toEqual(VALID_FILE);
    expect(snapshot.providersPath).toBe(path.join(home, "providers.json"));
    expect(snapshot).not.toHaveProperty("providersError");
  });

  it("providers.json 不存在时 providers 为空且没有 providersError", () => {
    const home = makeHome();

    const snapshot = readAppConfig(home);

    expect(snapshot.providers).toEqual({});
    expect(snapshot).not.toHaveProperty("providersError");
  });

  it.each<[string, string]>([
    ["坏 JSON", "{bad"],
    ["schema 不符", '{"openai":{"protocol":"openai-chat-completions"}}'],
  ])("providers.json 坏掉（%s）时仍能读出其余配置，并带 providersError", (_label, text) => {
    const home = makeHome();
    writeFileSync(path.join(home, "providers.json"), text, "utf8");
    writeJson(path.join(home, "run.json"), {
      maxTurns: 7,
      maxCostUsd: null,
      timeoutMs: null,
      systemPrompt: "只做只读诊断",
    });
    writeJson(path.join(home, "permissions.json"), { version: 1, preset: "read-only" });
    writeJson(path.join(home, "mcp.json"), { mcpServers: { probe: { command: "node" } } });

    const snapshot = readAppConfig(home);

    expect(snapshot.providers).toEqual({});
    expect(typeof snapshot.providersError).toBe("string");
    expect(snapshot.providersError).toContain("providers.json");
    // 其余三份配置照常读出，设置页才能打开并让用户修。
    expect(snapshot.run.maxTurns).toBe(7);
    expect(snapshot.run.systemPrompt).toBe("只做只读诊断");
    expect(snapshot.permissions.preset).toBe("read-only");
    expect(snapshot.mcpServers).toEqual([{ name: "probe", command: "node" }]);
  });
});
