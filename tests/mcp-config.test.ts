import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/mcp/config.js";
import { McpConfigError } from "../src/mcp/errors.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-config-"));
  roots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function setup(userServers?: Record<string, unknown>, projectServers?: Record<string, unknown>) {
  const root = tempRoot();
  const home = path.join(root, "home");
  const workdir = path.join(root, "work");
  const userConfigPath = path.join(home, "mcp.json");
  const projectConfigPath = path.join(workdir, ".harness", "mcp.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  if (userServers !== undefined) {
    writeJson(userConfigPath, { mcpServers: userServers });
  }
  if (projectServers !== undefined) {
    writeJson(projectConfigPath, { mcpServers: projectServers });
  }
  return { root, home, workdir, userConfigPath, projectConfigPath };
}

function expectInvalid(action: () => unknown): void {
  try {
    action();
    expect.fail("应抛出 McpConfigError");
  } catch (error) {
    expect(error).toBeInstanceOf(McpConfigError);
    expect(error).toMatchObject({ code: "mcp_config_invalid" });
  }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("MCP 配置加载与合并", () => {
  it("文件缺失时返回空数组", () => {
    const { home, workdir } = setup();
    expect(loadMcpConfig({ home, workdir })).toEqual([]);
  });

  it("加载 user 配置并填充缺省值", () => {
    const { home, workdir } = setup({
      probe: {
        command: "node",
        args: ["server.js"],
        env: { PORT: "1" },
        timeoutMs: 2000,
      },
    });
    expect(loadMcpConfig({ home, workdir })).toEqual([
      {
        name: "probe",
        command: "node",
        args: ["server.js"],
        env: { PORT: "1" },
        cwd: workdir,
        timeoutMs: 2000,
      },
    ]);
  });

  it("project 字段级覆盖并合并 env", () => {
    const { home, workdir } = setup(
      {
        probe: {
          command: "node",
          args: ["user.js"],
          env: { A: "user", B: "keep" },
          timeoutMs: 3000,
        },
      },
      {
        probe: {
          command: "python",
          env: { B: "project", C: "project" },
          timeoutMs: 9000,
        },
      },
    );
    expect(loadMcpConfig({ home, workdir })).toEqual([
      {
        name: "probe",
        command: "python",
        args: ["user.js"],
        env: { A: "user", B: "project", C: "project" },
        cwd: workdir,
        timeoutMs: 9000,
      },
    ]);
  });

  it("project 只写 disabled:true 时继承 user 且最终跳过", () => {
    const { home, workdir } = setup(
      { probe: { command: "node", args: ["user.js"] } },
      { probe: { disabled: true } },
    );
    expect(loadMcpConfig({ home, workdir })).toEqual([]);
  });

  it("未被 project 覆盖的 user server 保留，结果按 name 稳定排序", () => {
    const { home, workdir } = setup(
      { zeta: { command: "z" }, alpha: { command: "a" } },
      { beta: { command: "b" } },
    );
    expect(loadMcpConfig({ home, workdir }).map((server) => server.name)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  it("未知字段宽松忽略", () => {
    const { home, workdir } = setup({
      probe: {
        type: "stdio",
        description: "探针",
        command: "node",
        futureOption: { nested: true },
      },
    });
    expect(loadMcpConfig({ home, workdir })).toEqual([
      { name: "probe", command: "node", cwd: workdir, timeoutMs: 15_000 },
    ]);
  });

  it("坏 JSON 报 McpConfigError", () => {
    const { home, workdir, userConfigPath } = setup();
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(userConfigPath, "{oops", "utf8");
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("顶层 schema 非法报 McpConfigError", () => {
    const { home, workdir, userConfigPath } = setup();
    writeJson(userConfigPath, []);
    expectInvalid(() => loadMcpConfig({ home, workdir }));
    writeJson(userConfigPath, { mcpServers: [] });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
    writeJson(userConfigPath, { mcpServers: { probe: "node" } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("缺 command、command 为空或类型非法报错", () => {
    const cases: unknown[] = [
      {},
      { command: "" },
      { command: "   " },
      { command: 1 },
      { command: "node", args: [1] },
      { command: "node", env: { A: 1 } },
      { command: "node", cwd: 1 },
      { command: "node", disabled: "yes" },
    ];
    for (const server of cases) {
      const { home, workdir } = setup({ probe: server });
      expectInvalid(() => loadMcpConfig({ home, workdir }));
    }
  });

  it("project 新 server 缺 command 报错", () => {
    const { home, workdir } = setup({}, { probe: { args: ["x.js"] } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("cwd 相对配置文件目录解析，未指定时用 workdir", () => {
    const { home, workdir, userConfigPath, projectConfigPath } = setup(
      {
        userTool: { command: "node", cwd: "tools/user" },
        fallback: { command: "node" },
      },
      {
        projectTool: { command: "node", cwd: "../bin" },
      },
    );
    const result = loadMcpConfig({ home, workdir });
    expect(result).toEqual([
      { name: "fallback", command: "node", cwd: workdir, timeoutMs: 15_000 },
      { name: "projectTool", command: "node", cwd: path.resolve(path.dirname(projectConfigPath), "../bin"), timeoutMs: 15_000 },
      { name: "userTool", command: "node", cwd: path.resolve(path.dirname(userConfigPath), "tools/user"), timeoutMs: 15_000 },
    ]);
  });

  it.each(["bad name", "with.dot", "a/b", "", "x".repeat(65)])("非法名称 %j 被拒绝", (name) => {
    const { home, workdir } = setup({ [name]: { command: "node" } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it.each([0, -1, 1.5, "100", null])("非法 timeoutMs %j 被拒绝", (timeoutMs) => {
    const { home, workdir } = setup({ probe: { command: "node", timeoutMs } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });
});