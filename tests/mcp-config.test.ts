import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/mcp/config.js";
import type { McpConfigWarning } from "../src/mcp/config.js";
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

  it("解析 inheritEnv/envAllowlist，project 按字段覆盖", () => {
    const { home, workdir } = setup(
      { probe: { command: "node", inheritEnv: false, envAllowlist: ["A"] } },
      { probe: { inheritEnv: true, envAllowlist: ["B"] } },
    );

    expect(loadMcpConfig({ home, workdir })).toEqual([
      {
        name: "probe",
        command: "node",
        cwd: workdir,
        timeoutMs: 15_000,
        inheritEnv: true,
        envAllowlist: ["B"],
      },
    ]);
  });

  it.each([
    { inheritEnv: "yes" },
    { inheritEnv: 1 },
    { envAllowlist: "PATH" },
    { envAllowlist: [1] },
    { envAllowlist: null },
  ])("非法 inheritEnv/envAllowlist 被拒绝: %j", (extra) => {
    const { home, workdir } = setup({ probe: { command: "node", ...extra } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("includeProject:false 时忽略 project 配置", () => {
    const { home, workdir } = setup(
      { probe: { command: "user" } },
      { probe: { command: "project" } },
    );

    expect(loadMcpConfig({ home, workdir, includeProject: false })).toEqual([
      {
        name: "probe",
        command: "user",
        cwd: workdir,
        timeoutMs: 15_000,
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

  it("user 无 command 且 project 仅 disabled:true 时报缺 command", () => {
    const { home, workdir } = setup(
      { probe: { args: ["x.js"] } },
      { probe: { disabled: true } },
    );
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("user 单独 disabled:true 时跳过", () => {
    const { home, workdir } = setup({ probe: { command: "node", disabled: true } });
    expect(loadMcpConfig({ home, workdir })).toEqual([]);
  });

  it("user 缺 command 时由 project 补齐并成功", () => {
    const { home, workdir } = setup(
      { probe: { args: ["x.js"], env: { A: "1" } } },
      { probe: { command: "node" } },
    );
    expect(loadMcpConfig({ home, workdir })).toEqual([
      {
        name: "probe",
        command: "node",
        args: ["x.js"],
        env: { A: "1" },
        cwd: workdir,
        timeoutMs: 15_000,
      },
    ]);
  });

  it("project disabled:false 覆盖 user disabled:true 时启用", () => {
    const { home, workdir } = setup(
      { probe: { command: "node", disabled: true } },
      { probe: { disabled: false } },
    );
    expect(loadMcpConfig({ home, workdir })).toEqual([
      { name: "probe", command: "node", cwd: workdir, timeoutMs: 15_000 },
    ]);
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

  it("未知字段宽松忽略但通过 onWarning 披露（D-103）", () => {
    const { home, workdir, userConfigPath } = setup({
      probe: {
        type: "stdio",
        description: "探针",
        command: "node",
        futureOption: { nested: true },
      },
    });
    const warnings: McpConfigWarning[] = [];

    expect(
      loadMcpConfig({ home, workdir, onWarning: (warning) => warnings.push(warning) }),
    ).toEqual([{ name: "probe", command: "node", cwd: workdir, timeoutMs: 15_000 }]);
    expect(warnings).toEqual([
      { file: userConfigPath, server: "probe", field: "type" },
      { file: userConfigPath, server: "probe", field: "description" },
      { file: userConfigPath, server: "probe", field: "futureOption" },
    ]);
  });

  it("未提供 onWarning 时未知字段不影响加载", () => {
    const { home, workdir } = setup({ probe: { command: "node", typoField: 1 } });
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
    writeJson(userConfigPath, {});
    expectInvalid(() => loadMcpConfig({ home, workdir }));
    writeJson(userConfigPath, { mcpServer: { probe: { command: "node" } } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
    writeJson(userConfigPath, { mcpServers: [] });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
    writeJson(userConfigPath, { mcpServers: { probe: "node" } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("project 坏 JSON 与 schema 非法报 McpConfigError", () => {
    const { home, workdir, projectConfigPath } = setup({ probe: { command: "node" } });
    mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    writeFileSync(projectConfigPath, "{oops", "utf8");
    expectInvalid(() => loadMcpConfig({ home, workdir }));
    writeJson(projectConfigPath, []);
    expectInvalid(() => loadMcpConfig({ home, workdir }));
    writeJson(projectConfigPath, {});
    expectInvalid(() => loadMcpConfig({ home, workdir }));
    writeJson(projectConfigPath, { mcpServers: { probe: null } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("缺 command、command 为空或类型非法报错", () => {
    const cases: unknown[] = [
      {},
      { command: "" },
      { command: "   " },
      { command: 1 },
      { command: "node", args: [1] },
      { command: "node", args: "x" },
      { command: "node", env: { A: 1 } },
      { command: "node", env: [] },
      { command: "node", env: null },
      { command: "node", cwd: 1 },
      { command: "node", cwd: "" },
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

  it("userConfigPath/projectConfigPath 覆盖默认路径，cwd 相对覆盖文件目录", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const workdir = path.join(root, "work");
    const userConfigPath = path.join(root, "custom", "user.json");
    const projectConfigPath = path.join(root, "custom", "project.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    writeJson(path.join(home, "mcp.json"), { mcpServers: { defaultUser: { command: "node" } } });
    writeJson(path.join(workdir, ".harness", "mcp.json"), {
      mcpServers: { defaultProject: { command: "node" } },
    });
    writeJson(userConfigPath, { mcpServers: { userTool: { command: "node", cwd: "user-bin" } } });
    writeJson(projectConfigPath, {
      mcpServers: { projectTool: { command: "node", cwd: "project-bin" } },
    });

    expect(loadMcpConfig({ home, workdir, userConfigPath, projectConfigPath })).toEqual([
      {
        name: "projectTool",
        command: "node",
        cwd: path.resolve(path.dirname(projectConfigPath), "project-bin"),
        timeoutMs: 15_000,
      },
      {
        name: "userTool",
        command: "node",
        cwd: path.resolve(path.dirname(userConfigPath), "user-bin"),
        timeoutMs: 15_000,
      },
    ]);
  });

  it.each(["bad name", "with.dot", "a/b", "", "x".repeat(65)])("非法名称 %j 被拒绝", (name) => {
    const { home, workdir } = setup({ [name]: { command: "node" } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("64 字符名称合法", () => {
    const name = "a".repeat(64);
    const { home, workdir } = setup({ [name]: { command: "node" } });
    expect(loadMcpConfig({ home, workdir })).toEqual([
      { name, command: "node", cwd: workdir, timeoutMs: 15_000 },
    ]);
  });

  it.each([0, -1, 1.5, "100", null])("非法 timeoutMs %j 被拒绝", (timeoutMs) => {
    const { home, workdir } = setup({ probe: { command: "node", timeoutMs } });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("配置文件路径为目录时报读取失败", () => {
    const { home, workdir, userConfigPath } = setup();
    mkdirSync(userConfigPath, { recursive: true });
    expectInvalid(() => loadMcpConfig({ home, workdir }));
  });

  it("UTF-8 BOM 可正常解析", () => {
    const { home, workdir, userConfigPath } = setup();
    mkdirSync(path.dirname(userConfigPath), { recursive: true });
    writeFileSync(
      userConfigPath,
      `\uFEFF${JSON.stringify({ mcpServers: { probe: { command: "node" } } })}`,
      "utf8",
    );
    expect(loadMcpConfig({ home, workdir })).toEqual([
      { name: "probe", command: "node", cwd: workdir, timeoutMs: 15_000 },
    ]);
  });
});
