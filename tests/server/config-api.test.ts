import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppConfigError,
  readAppConfig,
  writeMcpServers,
  writePermissionConfig,
  writeRunLimits,
} from "../../src/config/app-config.js";
import type { AppMcpServer } from "../../src/config/app-config.js";
import { createConfigApi } from "../../src/server/config-api.js";
import { HttpError } from "../../src/server/http.js";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "eam-config-api-"));
  homes.push(home);
  return home;
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tmpFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

async function expectHttpError(
  run: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<HttpError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpError);
  const httpError = caught as HttpError;
  expect(httpError.status).toBe(status);
  expect(httpError.code).toBe(code);
  // 错误必须带原因，不能只有「无效」（R3）。
  expect(httpError.message.length).toBeGreaterThan(0);
  return httpError;
}

async function expectAppConfigError(run: () => Promise<unknown>, code: string): Promise<AppConfigError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppConfigError);
  const appError = caught as AppConfigError;
  expect(appError.code).toBe(code);
  return appError;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("readAppConfig 默认值", () => {
  it("空 HARNESS_HOME 返回空 MCP、默认权限与默认运行上限", () => {
    const home = makeHome();

    const snapshot = readAppConfig(home);

    expect(snapshot.mcpServers).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.permissions).toEqual({
      preset: "diagnose",
      approvalTimeoutMs: 120_000,
      rules: [],
    });
    expect(snapshot.permissionsPath).toBe(path.join(home, "permissions.json"));
    expect(snapshot.mcpPath).toBe(path.join(home, "mcp.json"));
    expect(snapshot.run).toEqual({
      maxTurns: 10,
      maxCostUsd: null,
      timeoutMs: null,
      systemPrompt: "",
    });
    expect(snapshot.runPath).toBe(path.join(home, "run.json"));
  });

  it("权限文件只覆盖部分字段时其余取默认值，rules 还原为无 source 的裸规则", () => {
    const home = makeHome();
    writeJson(path.join(home, "permissions.json"), {
      version: 1,
      preset: "read-only",
      rules: [{ tool: "shell", action: "deny", reason: "no shell" }],
    });

    const snapshot = readAppConfig(home);

    expect(snapshot.permissions.preset).toBe("read-only");
    expect(snapshot.permissions.approvalTimeoutMs).toBe(120_000);
    expect(snapshot.permissions.rules).toEqual([
      { tool: "shell", action: "deny", reason: "no shell" },
    ]);
    expect(snapshot.permissions.rules[0]).not.toHaveProperty("source");
  });

  it("读到已有 mcp.json 时返回条目，未知字段进 warnings 而不是静默丢弃", () => {
    const home = makeHome();
    writeJson(path.join(home, "mcp.json"), {
      mcpServers: {
        probe: { command: "node", args: ["probe.js"], timeoutMs: 5000, timeoutMS: 1 },
      },
    });

    const snapshot = readAppConfig(home);

    expect(snapshot.mcpServers).toEqual([
      { name: "probe", command: "node", args: ["probe.js"], timeoutMs: 5000 },
    ]);
    expect(snapshot.warnings).toEqual([{ server: "probe", field: "timeoutMS" }]);
  });

  it("mcp.json 损坏时抛 config_unreadable 而不是当成空列表", () => {
    const home = makeHome();
    writeFileSync(path.join(home, "mcp.json"), "{bad", "utf8");

    expect(() => readAppConfig(home)).toThrow(AppConfigError);
    try {
      readAppConfig(home);
    } catch (error) {
      expect((error as AppConfigError).code).toBe("config_unreadable");
    }
  });
});

describe("MCP 配置读写往返", () => {
  it("写入后读回同样的条目，文件是可人工编辑的 { mcpServers } 形状", async () => {
    const home = makeHome();
    const servers: AppMcpServer[] = [
      {
        name: "probe",
        command: "node",
        args: ["probe.js"],
        env: { PROBE_PORT: "3333" },
        cwd: "/tmp/work",
        timeoutMs: 5000,
        disabled: false,
      },
      { name: "kb", command: "node", disabled: true },
    ];

    const written = await writeMcpServers(home, servers);
    const snapshot = readAppConfig(home);

    expect(written).toEqual(servers);
    expect(snapshot.mcpServers).toEqual(servers);
    const raw = readJson(path.join(home, "mcp.json")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(raw.mcpServers)).toEqual(["probe", "kb"]);
    expect(raw.mcpServers.probe).toEqual({
      command: "node",
      args: ["probe.js"],
      env: { PROBE_PORT: "3333" },
      cwd: "/tmp/work",
      timeoutMs: 5000,
      disabled: false,
    });
    // name 只作为 map 的键，不写进条目本身。
    expect(raw.mcpServers.probe).not.toHaveProperty("name");
    expect(readFileSync(path.join(home, "mcp.json"), "utf8")).toContain('\n  "mcpServers": {');
  });

  it("写空列表会清空文件但不删文件，且不残留临时文件", async () => {
    const home = makeHome();
    await writeMcpServers(home, [{ name: "probe", command: "node" }]);

    await writeMcpServers(home, []);

    expect(readAppConfig(home).mcpServers).toEqual([]);
    expect(readJson(path.join(home, "mcp.json"))).toEqual({ mcpServers: {} });
    expect(tmpFilesIn(home)).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["name 非法", [{ name: "bad name", command: "node" }]],
    ["name 含路径分隔符", [{ name: "../evil", command: "node" }]],
    ["name 过长", [{ name: "a".repeat(65), command: "node" }]],
    ["name 缺失", [{ command: "node" }]],
    ["command 为空", [{ name: "probe", command: "   " }]],
    ["command 非字符串", [{ name: "probe", command: 1 }]],
    ["args 含非字符串", [{ name: "probe", command: "node", args: ["a", 2] }]],
    ["timeoutMs 为 0", [{ name: "probe", command: "node", timeoutMs: 0 }]],
    ["timeoutMs 非整数", [{ name: "probe", command: "node", timeoutMs: 1.5 }]],
    ["disabled 非布尔", [{ name: "probe", command: "node", disabled: "yes" }]],
    ["env 值非字符串", [{ name: "probe", command: "node", env: { A: 1 } }]],
    ["未知字段", [{ name: "probe", command: "node", timeoutMS: 1000 }]],
    ["条目不是对象", [42]],
    ["不是数组", { mcpServers: {} }],
    ["名称重复", [
      { name: "probe", command: "node" },
      { name: "probe", command: "node" },
    ]],
  ])("非法输入被拒（%s）且原文件不变", async (_label, input) => {
    const home = makeHome();
    const before = { mcpServers: { keep: { command: "node" } } };
    writeJson(path.join(home, "mcp.json"), before);

    await expectAppConfigError(() => writeMcpServers(home, input), "invalid_config");

    expect(readJson(path.join(home, "mcp.json"))).toEqual(before);
    expect(tmpFilesIn(home)).toEqual([]);
  });
});

describe("权限配置写入", () => {
  it("只给部分字段时文件只含给出的字段，读回时其余取默认值", async () => {
    const home = makeHome();

    await writePermissionConfig(home, { preset: "workspace-write" });

    expect(readJson(path.join(home, "permissions.json"))).toEqual({
      version: 1,
      preset: "workspace-write",
    });
    const snapshot = readAppConfig(home);
    expect(snapshot.permissions).toEqual({
      preset: "workspace-write",
      approvalTimeoutMs: 120_000,
      rules: [],
    });
    expect(tmpFilesIn(home)).toEqual([]);
  });

  it("完整配置往返：rules 与 approvalTimeoutMs 被保留", async () => {
    const home = makeHome();
    const rules = [
      { tool: "shell", params: [{ key: "command", glob: "pyocd *" }], action: "deny" as const },
    ];

    const written = await writePermissionConfig(home, {
      preset: "read-only",
      rules,
      approvalTimeoutMs: 5000,
    });

    expect(written).toEqual({ preset: "read-only", approvalTimeoutMs: 5000, rules });
    expect(readAppConfig(home).permissions).toEqual({
      preset: "read-only",
      approvalTimeoutMs: 5000,
      rules,
    });
  });

  it("已知文件被整份替换，不在文件里留下上一版的规则", async () => {
    const home = makeHome();
    writeJson(path.join(home, "permissions.json"), {
      version: 1,
      preset: "read-only",
      rules: [{ tool: "shell", action: "deny" }],
    });

    await writePermissionConfig(home, { preset: "diagnose" });

    expect(readAppConfig(home).permissions.rules).toEqual([]);
    expect(readAppConfig(home).permissions.preset).toBe("diagnose");
  });

  it.each<[string, unknown]>([
    ["预设非法", { preset: "yolo" }],
    ["approvalTimeoutMs 为 0", { approvalTimeoutMs: 0 }],
    ["approvalTimeoutMs 非整数", { approvalTimeoutMs: 1.5 }],
    ["未知字段", { presett: "read-only" }],
    ["rules 不是数组", { rules: {} }],
    ["规则 action 非法", { rules: [{ tool: "shell", action: "maybe" }] }],
    ["不是对象", "read-only"],
  ])("非法配置被拒（%s）且原文件不变", async (_label, input) => {
    const home = makeHome();
    const before = { version: 1, preset: "read-only" };
    writeJson(path.join(home, "permissions.json"), before);

    await expectAppConfigError(() => writePermissionConfig(home, input), "invalid_config");

    expect(readJson(path.join(home, "permissions.json"))).toEqual(before);
    expect(tmpFilesIn(home)).toEqual([]);
  });
});

describe("运行上限配置", () => {
  it("run.json 读写往返", async () => {
    const home = makeHome();
    const limits = { maxTurns: 25, maxCostUsd: 1.5, timeoutMs: 60_000, systemPrompt: "只做只读诊断" };

    const written = await writeRunLimits(home, limits);

    expect(written).toEqual(limits);
    expect(readAppConfig(home).run).toEqual(limits);
    expect(readJson(path.join(home, "run.json"))).toEqual(limits);
    expect(tmpFilesIn(home)).toEqual([]);
  });

  it("null 表示不限，写回后读到的仍是 null 而不是默认值", async () => {
    const home = makeHome();

    await writeRunLimits(home, { maxTurns: 3, maxCostUsd: null, timeoutMs: null, systemPrompt: "" });

    expect(readAppConfig(home).run).toEqual({
      maxTurns: 3,
      maxCostUsd: null,
      timeoutMs: null,
      systemPrompt: "",
    });
  });

  it.each<[string, unknown]>([
    ["maxTurns 为 0", { maxTurns: 0 }],
    ["maxTurns 为负", { maxTurns: -1 }],
    ["maxTurns 非整数", { maxTurns: 2.5 }],
    ["maxTurns 是字符串", { maxTurns: "10" }],
    ["maxCostUsd 是字符串", { maxCostUsd: "1.5" }],
    ["maxCostUsd 为 0", { maxCostUsd: 0 }],
    ["timeoutMs 为负", { timeoutMs: -1 }],
    ["systemPrompt 非字符串", { systemPrompt: 42 }],
    ["未知字段", { maxTurn: 10 }],
    ["不是对象", 10],
  ])("非法运行上限被拒（%s）且原文件不变", async (_label, input) => {
    const home = makeHome();
    const before = { maxTurns: 7, maxCostUsd: null, timeoutMs: null, systemPrompt: "" };
    writeJson(path.join(home, "run.json"), before);

    await expectAppConfigError(() => writeRunLimits(home, input), "invalid_config");

    expect(readJson(path.join(home, "run.json"))).toEqual(before);
    expect(tmpFilesIn(home)).toEqual([]);
  });

  it("run.json 损坏时 readAppConfig 抛 config_unreadable", () => {
    const home = makeHome();
    writeFileSync(path.join(home, "run.json"), '{"maxTurns": 0}', "utf8");

    try {
      readAppConfig(home);
      throw new Error("expected AppConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(AppConfigError);
      expect((error as AppConfigError).code).toBe("config_unreadable");
    }
  });
});

describe("ConfigApi 错误映射", () => {
  it("get 返回与 readAppConfig 一致的快照", () => {
    const home = makeHome();
    const api = createConfigApi({ harnessHome: home });

    expect(api.get()).toEqual(readAppConfig(home));
  });

  it("get 在配置损坏时映射为 500 config_unreadable 并带原因", async () => {
    const home = makeHome();
    writeFileSync(path.join(home, "permissions.json"), '{"version":2}', "utf8");
    const api = createConfigApi({ harnessHome: home });

    const error = await expectHttpError(async () => api.get(), 500, "config_unreadable");
    expect(error.message).toContain("权限配置");
  });

  it("putMcp 缺 servers 数组 → 400 invalid_body", async () => {
    const home = makeHome();
    const api = createConfigApi({ harnessHome: home });

    await expectHttpError(async () => api.putMcp({}), 400, "invalid_body");
    await expectHttpError(async () => api.putMcp({ servers: {} }), 400, "invalid_body");
    await expectHttpError(async () => api.putMcp([]), 400, "invalid_body");
    expect(existsSync(path.join(home, "mcp.json"))).toBe(false);
  });

  it("putMcp 内容非法 → 400 invalid_config 且消息点名具体字段", async () => {
    const home = makeHome();
    const api = createConfigApi({ harnessHome: home });

    const error = await expectHttpError(
      async () => api.putMcp({ servers: [{ name: "probe", command: "" }] }),
      400,
      "invalid_config",
    );

    expect(error.message).toContain("command");
  });

  it("putMcp 成功返回写入的条目", async () => {
    const home = makeHome();
    const api = createConfigApi({ harnessHome: home });

    const result = await api.putMcp({ servers: [{ name: "probe", command: "node" }] });

    expect(result).toEqual({
      mcpServers: [{ name: "probe", command: "node" }],
      warnings: [],
    });
    expect(api.get().mcpServers).toEqual([{ name: "probe", command: "node" }]);
  });

  it("putPermissions 缺 permissions 对象 → 400 invalid_config", async () => {
    const home = makeHome();
    const api = createConfigApi({ harnessHome: home });

    await expectHttpError(async () => api.putPermissions({}), 400, "invalid_config");
    await expectHttpError(async () => api.putPermissions({ permissions: [] }), 400, "invalid_config");
    expect(existsSync(path.join(home, "permissions.json"))).toBe(false);
  });

  it("putPermissions 规则非法 → 400 invalid_config 且消息带原因", async () => {
    const home = makeHome();
    const api = createConfigApi({ harnessHome: home });

    const error = await expectHttpError(
      async () => api.putPermissions({ permissions: { preset: "yolo" } }),
      400,
      "invalid_config",
    );

    expect(error.message).toContain("preset");
  });

  it("putRun 缺 run 对象 → 400 invalid_body", async () => {
    const home = makeHome();
    const api = createConfigApi({ harnessHome: home });

    await expectHttpError(async () => api.putRun({}), 400, "invalid_body");
    await expectHttpError(async () => api.putRun({ run: [] }), 400, "invalid_body");
    expect(existsSync(path.join(home, "run.json"))).toBe(false);
  });

  it("putRun 非法 maxTurns → 400 invalid_config 且原文件不变", async () => {
    const home = makeHome();
    const before = { maxTurns: 5, maxCostUsd: null, timeoutMs: null, systemPrompt: "" };
    writeJson(path.join(home, "run.json"), before);
    const api = createConfigApi({ harnessHome: home });

    const error = await expectHttpError(
      async () => api.putRun({ run: { maxTurns: 0 } }),
      400,
      "invalid_config",
    );

    expect(error.message).toContain("maxTurns");
    expect(readJson(path.join(home, "run.json"))).toEqual(before);
  });
});
