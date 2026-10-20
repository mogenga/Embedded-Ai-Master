import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// 用可控失败模拟“项目配置存在但不可 stat”;ESM 命名空间不可 spy,只能模块级替换。
const statFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      statSync: (...args: Parameters<typeof actual.statSync>) => {
        if (statFailure.enabled) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return actual.statSync(...args);
      },
    },
  };
});
import {
  loadPermissionConfig,
  parseInlinePermissionConfig,
  parsePermissionConfig,
} from "../src/permissions/config.js";
import { PermissionConfigError } from "../src/permissions/errors.js";

const roots: string[] = [];

interface TempLayout {
  root: string;
  home: string;
  workdir: string;
}

function tempLayout(): TempLayout {
  const root = mkdtempSync(path.join(tmpdir(), "permissions-config-"));
  roots.push(root);
  const home = path.join(root, "home");
  const workdir = path.join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  return { root, home, workdir };
}

function writeConfig(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function userPath(home: string): string {
  return path.join(home, "permissions.json");
}

function projectPath(workdir: string): string {
  return path.join(workdir, ".harness", "permissions.json");
}

function expectConfigError(fn: () => unknown, code?: string): PermissionConfigError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PermissionConfigError);
  const configError = caught as PermissionConfigError;
  if (code !== undefined) expect(configError.code).toBe(code);
  return configError;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("loadPermissionConfig 缺省值", () => {
  it("没有配置文件时使用 diagnose 与 120000ms", () => {
    const { home, workdir } = tempLayout();
    const loaded = loadPermissionConfig({ home, workdir });
    expect(loaded.preset).toBe("diagnose");
    expect(loaded.approvalTimeoutMs).toBe(120000);
    expect(loaded.rules).toEqual([]);
    expect(loaded.projectSkipped).toBeUndefined();
    expect(loaded.userConfigPath).toBe(userPath(home));
    expect(loaded.projectConfigPath).toBe(projectPath(workdir));
  });
});

describe("parsePermissionConfig 版本与 JSON", () => {
  it("坏 JSON 抛 invalid_json 且信息含路径", () => {
    const error = expectConfigError(() => parsePermissionConfig("{", "p.json"), "invalid_json");
    expect(error.message).toContain("p.json");
  });

  it("version 2 抛 unsupported_version", () => {
    expectConfigError(() => parsePermissionConfig(JSON.stringify({ version: 2 }), "p.json"), "unsupported_version");
  });

  it("空对象与缺失 version 均抛 unsupported_version", () => {
    expectConfigError(() => parsePermissionConfig("{}", "p.json"), "unsupported_version");
    expectConfigError(() => parsePermissionConfig(JSON.stringify({ rules: [] }), "p.json"), "unsupported_version");
  });

  it("非数字 version 抛 unsupported_version", () => {
    expectConfigError(() => parsePermissionConfig(JSON.stringify({ version: "1" }), "p.json"), "unsupported_version");
  });

  it("顶层不是对象时抛 unsupported_version", () => {
    expectConfigError(() => parsePermissionConfig("null", "p.json"), "unsupported_version");
    expectConfigError(() => parsePermissionConfig("[]", "p.json"), "unsupported_version");
  });

  it("未知顶层字段被拒绝且信息含字段名与路径", () => {
    const error = expectConfigError(
      () => parsePermissionConfig(JSON.stringify({ version: 1, extra: true }), "p.json"),
      "invalid_schema",
    );
    expect(error.message).toMatch(/extra/);
    expect(error.message).toContain("p.json");
  });

  it("未知规则字段被拒绝", () => {
    expectConfigError(
      () =>
        parsePermissionConfig(
          JSON.stringify({ version: 1, rules: [{ tool: "fs", action: "allow", extra: 1 }] }),
          "p.json",
        ),
      "invalid_schema",
    );
  });
});

describe("parsePermissionConfig 字段校验", () => {
  const invalid: Array<[string, unknown]> = [
    ["tool 为空", { version: 1, rules: [{ tool: "", action: "allow" }] }],
    ["tool 纯空白", { version: 1, rules: [{ tool: "   ", action: "allow" }] }],
    ["tool 超长", { version: 1, rules: [{ tool: "a".repeat(201), action: "allow" }] }],
    ["reason 为空", { version: 1, rules: [{ tool: "fs", reason: "", action: "allow" }] }],
    ["reason 纯空白", { version: 1, rules: [{ tool: "fs", reason: "   ", action: "allow" }] }],
    ["key 纯空白", { version: 1, rules: [{ tool: "fs", params: [{ key: "   ", eq: 1 }], action: "allow" }] }],
    ["非法 action", { version: 1, rules: [{ tool: "fs", action: "maybe" }] }],
    ["timeout 为 0", { version: 1, approvalTimeoutMs: 0 }],
    ["timeout 非整数", { version: 1, approvalTimeoutMs: 1.5 }],
    ["timeout 超过上限", { version: 1, approvalTimeoutMs: 2147483648 }],
    ["非法预设", { version: 1, preset: "yolo" }],
    [
      "matcher 多操作符",
      { version: 1, rules: [{ tool: "fs", params: [{ key: "op", eq: "read", glob: "*" }], action: "allow" }] },
    ],
    ["matcher 无操作符", { version: 1, rules: [{ tool: "fs", params: [{ key: "op" }], action: "allow" }] }],
    [
      "range 反向",
      { version: 1, rules: [{ tool: "fs", params: [{ key: "address", range: [10, 1] }], action: "allow" }] },
    ],
    [
      "range 非有限",
      { version: 1, rules: [{ tool: "fs", params: [{ key: "address", range: [0, Number.POSITIVE_INFINITY] }], action: "allow" }] },
    ],
    ["in 为空", { version: 1, rules: [{ tool: "fs", params: [{ key: "port", in: [] }], action: "allow" }] }],
    [
      "extentKey 无 range",
      { version: 1, rules: [{ tool: "fs", params: [{ key: "address", eq: 1, extentKey: "bytes" }], action: "allow" }] },
    ],
    [
      "extentKey 纯空白",
      { version: 1, rules: [{ tool: "fs", params: [{ key: "address", range: [0, 15], extentKey: "   " }], action: "allow" }] },
    ],
    [
      "extentKey 含空段",
      { version: 1, rules: [{ tool: "fs", params: [{ key: "address", range: [0, 15], extentKey: "bytes..length" }], action: "allow" }] },
    ],
    ["key 含空段", { version: 1, rules: [{ tool: "fs", params: [{ key: "a..b", eq: 1 }], action: "allow" }] }],
    ["key 为空", { version: 1, rules: [{ tool: "fs", params: [{ key: "", eq: 1 }], action: "allow" }] }],
    ["key 超长", { version: 1, rules: [{ tool: "fs", params: [{ key: "a".repeat(201), eq: 1 }], action: "allow" }] }],
    ["glob 为空", { version: 1, rules: [{ tool: "fs", params: [{ key: "p", glob: "" }], action: "allow" }] }],
    [
      "glob 超长",
      { version: 1, rules: [{ tool: "fs", params: [{ key: "p", glob: "a".repeat(201) }], action: "allow" }] },
    ],
    [
      "matcher 未知字段",
      { version: 1, rules: [{ tool: "fs", params: [{ key: "p", eq: 1, extra: true }], action: "allow" }] },
    ],
  ];

  for (const [label, value] of invalid) {
    it(`拒绝 ${label}`, () => {
      expectConfigError(() => parsePermissionConfig(JSON.stringify(value), "p.json"), "invalid_schema");
    });
  }

  it("接受完整合法配置", () => {
    const config = parsePermissionConfig(
      JSON.stringify({
        version: 1,
        preset: "workspace-write",
        approvalTimeoutMs: 5000,
        rules: [
          {
            tool: "mcp__probe__mem_*",
            action: "ask",
            reason: "写内存前确认",
            params: [
              { key: "address", range: [0, 65535] },
              { key: "op", glob: "mem_*" },
              { key: "flags.reset", eq: false },
              { key: "mode", in: ["read", 1, null] },
            ],
          },
        ],
      }),
      "p.json",
    );
    expect(config.version).toBe(1);
    expect(config.preset).toBe("workspace-write");
    expect(config.approvalTimeoutMs).toBe(5000);
    expect(config.rules?.[0]?.params).toHaveLength(4);
  });

  it("rejects an infinite range parsed from raw JSON (1e400)", () => {
    // JSON.stringify(Infinity) 会变成 null,所以上面的“range 非有限”用例实际未覆盖 Infinity;
    // 这里用原始文本表达,确保 JSON.parse 产生的 Infinity 被 Zod 拒绝。
    const raw =
      '{"version":1,"rules":[{"tool":"fs","params":[{"key":"a","range":[0,1e400]}],"action":"allow"}]}';
    expect(Number.isFinite(JSON.parse(raw).rules[0].params[0].range[1])).toBe(false);
    expectConfigError(() => parsePermissionConfig(raw, "p.json"), "invalid_schema");
  });

  it("接受 range 上下界相等", () => {
    const config = parsePermissionConfig(
      JSON.stringify({ version: 1, rules: [{ tool: "fs", params: [{ key: "n", range: [3, 3] }], action: "allow" }] }),
      "p.json",
    );
    expect(config.rules?.[0]?.params?.[0]?.range).toEqual([3, 3]);
  });

  it("接受 range 与 extentKey 组合", () => {
    const config = parsePermissionConfig(
      JSON.stringify({
        version: 1,
        rules: [
          {
            tool: "mcp__probe__mem_write",
            params: [{ key: "address", range: [0x20000000, 0x2001ffff], extentKey: "bytes.length" }],
            action: "allow",
          },
        ],
      }),
      "p.json",
    );
    expect(config.rules?.[0]?.params?.[0]?.extentKey).toBe("bytes.length");
  });

  it("带 BOM 的文件也能解析", () => {
    const config = parsePermissionConfig(`\uFEFF${JSON.stringify({ version: 1 })}`, "p.json");
    expect(config.version).toBe(1);
  });
});

describe("parseInlinePermissionConfig", () => {
  it("接受内联子集", () => {
    const inline = parseInlinePermissionConfig({
      preset: "danger-full-access",
      approvalTimeoutMs: 1000,
      rules: [{ tool: "fs", action: "allow" }],
    });
    expect(inline).toEqual({
      preset: "danger-full-access",
      approvalTimeoutMs: 1000,
      rules: [{ tool: "fs", action: "allow" }],
    });
  });

  it("接受空对象", () => {
    expect(parseInlinePermissionConfig({})).toEqual({});
  });

  it("非法规则抛 PermissionConfigError", () => {
    expectConfigError(() => parseInlinePermissionConfig({ rules: [{ tool: "", action: "allow" }] }), "invalid_schema");
  });

  it("未知字段被拒绝且信息含字段名", () => {
    const error = expectConfigError(() => parseInlinePermissionConfig({ extra: true }), "invalid_schema");
    expect(error.message).toMatch(/extra/);
  });

  it("version 不属于内联子集", () => {
    expectConfigError(() => parseInlinePermissionConfig({ version: 1 }), "invalid_schema");
  });

  it("非法 preset 与 timeout 抛 PermissionConfigError", () => {
    expectConfigError(() => parseInlinePermissionConfig({ preset: "yolo" }), "invalid_schema");
    expectConfigError(() => parseInlinePermissionConfig({ approvalTimeoutMs: 0 }), "invalid_schema");
  });

  it("非对象输入抛 PermissionConfigError", () => {
    expectConfigError(() => parseInlinePermissionConfig(null), "invalid_schema");
    expectConfigError(() => parseInlinePermissionConfig([]), "invalid_schema");
    expectConfigError(() => parseInlinePermissionConfig("x"), "invalid_schema");
  });
});

describe("loadPermissionConfig 项目信任", () => {
  it("项目配置存在但未 trust 时跳过且不读取内容", () => {
    const { home, workdir } = tempLayout();
    const projectFile = projectPath(workdir);
    writeConfig(projectFile, "{ 这不是 JSON");

    const loaded = loadPermissionConfig({ home, workdir });
    expect(loaded.projectSkipped).toBe(projectFile);
    expect(loaded.preset).toBe("diagnose");
    expect(loaded.rules).toEqual([]);
  });

  it("项目配置不存在时不返回 projectSkipped", () => {
    const { home, workdir } = tempLayout();
    expect(loadPermissionConfig({ home, workdir }).projectSkipped).toBeUndefined();
  });

  it("trustProjectConfig 为 true 时加载项目配置", () => {
    const { home, workdir } = tempLayout();
    writeConfig(projectPath(workdir), {
      version: 1,
      preset: "danger-full-access",
      rules: [{ tool: "shell", action: "allow" }],
    });

    const loaded = loadPermissionConfig({ home, workdir, trustProjectConfig: true });
    expect(loaded.projectSkipped).toBeUndefined();
    expect(loaded.preset).toBe("danger-full-access");
    expect(loaded.rules).toEqual([{ rule: { tool: "shell", action: "allow" }, source: "project" }]);
  });

  it("显式 projectConfigPath 视为已信任", () => {
    const { home, workdir } = tempLayout();
    const explicit = path.join(workdir, "custom", "permissions.json");
    writeConfig(explicit, { version: 1, rules: [{ tool: "fs", action: "allow" }] });

    const loaded = loadPermissionConfig({ home, workdir, projectConfigPath: explicit });
    expect(loaded.projectSkipped).toBeUndefined();
    expect(loaded.projectConfigPath).toBe(explicit);
    expect(loaded.rules).toEqual([{ rule: { tool: "fs", action: "allow" }, source: "project" }]);
  });

  it("trustProjectConfig 非 true 时不加载项目配置", () => {
    const { home, workdir } = tempLayout();
    writeConfig(projectPath(workdir), { version: 1, rules: [{ tool: "fs", action: "allow" }] });
    const loaded = loadPermissionConfig({ home, workdir, trustProjectConfig: false });
    expect(loaded.projectSkipped).toBe(projectPath(workdir));
    expect(loaded.rules).toEqual([]);
  });
});

describe("loadPermissionConfig 合并", () => {
  it("规则顺序为 inline → project → user 且带正确 source", () => {
    const { home, workdir } = tempLayout();
    writeConfig(userPath(home), {
      version: 1,
      preset: "read-only",
      approvalTimeoutMs: 3000,
      rules: [{ tool: "user_tool", action: "deny" }],
    });
    writeConfig(projectPath(workdir), {
      version: 1,
      preset: "workspace-write",
      approvalTimeoutMs: 2000,
      rules: [{ tool: "project_tool", action: "ask" }],
    });

    const loaded = loadPermissionConfig({
      home,
      workdir,
      trustProjectConfig: true,
      inline: {
        preset: "danger-full-access",
        approvalTimeoutMs: 1000,
        rules: [{ tool: "inline_tool", action: "allow" }],
      },
    });

    expect(loaded.preset).toBe("danger-full-access");
    expect(loaded.approvalTimeoutMs).toBe(1000);
    expect(loaded.rules).toEqual([
      { rule: { tool: "inline_tool", action: "allow" }, source: "inline" },
      { rule: { tool: "project_tool", action: "ask" }, source: "project" },
      { rule: { tool: "user_tool", action: "deny" }, source: "user" },
    ]);
  });

  it("rejects an unvalidated inline config instead of merging it silently", () => {
    const { home, workdir } = tempLayout();
    const invalidPreset = expectConfigError(
      () => loadPermissionConfig({ home, workdir, inline: { preset: "yolo" as never } }),
      "invalid_schema",
    );
    expect(invalidPreset.message).toContain("<inline>");

    expectConfigError(
      () =>
        loadPermissionConfig({
          home,
          workdir,
          inline: { rules: [{ tool: "fs", action: "allow", bogus: 1 } as never] },
        }),
      "invalid_schema",
    );
  });

  it("inline 未提供 preset/timeout 时依次取 project、user", () => {
    const { home, workdir } = tempLayout();
    writeConfig(userPath(home), { version: 1, preset: "read-only", approvalTimeoutMs: 3000 });
    writeConfig(projectPath(workdir), { version: 1, preset: "workspace-write", approvalTimeoutMs: 2000 });

    const trusted = loadPermissionConfig({ home, workdir, trustProjectConfig: true, inline: {} });
    expect(trusted.preset).toBe("workspace-write");
    expect(trusted.approvalTimeoutMs).toBe(2000);

    const untrusted = loadPermissionConfig({ home, workdir, inline: {} });
    expect(untrusted.preset).toBe("read-only");
    expect(untrusted.approvalTimeoutMs).toBe(3000);
  });

  it("只有 user 配置时生效", () => {
    const { home, workdir } = tempLayout();
    writeConfig(userPath(home), {
      version: 1,
      preset: "danger-full-access",
      rules: [{ tool: "shell", action: "allow" }],
    });

    const loaded = loadPermissionConfig({ home, workdir });
    expect(loaded.preset).toBe("danger-full-access");
    expect(loaded.rules).toEqual([{ rule: { tool: "shell", action: "allow" }, source: "user" }]);
  });

  it("显式 userConfigPath 缺失时不报错", () => {
    const { home, workdir } = tempLayout();
    const missing = path.join(home, "missing.json");
    const loaded = loadPermissionConfig({ home, workdir, userConfigPath: missing });
    expect(loaded.userConfigPath).toBe(missing);
    expect(loaded.rules).toEqual([]);
  });
});

describe("loadPermissionConfig 读取错误", () => {
  it("坏 user 配置错误信息含路径", () => {
    const { home, workdir } = tempLayout();
    const file = userPath(home);
    writeConfig(file, "{");
    const error = expectConfigError(() => loadPermissionConfig({ home, workdir }), "invalid_json");
    expect(error.message).toContain(file);
  });

  it("坏 project 配置（已信任）错误信息含路径", () => {
    const { home, workdir } = tempLayout();
    const file = projectPath(workdir);
    writeConfig(file, JSON.stringify({ version: 3 }));
    const error = expectConfigError(
      () => loadPermissionConfig({ home, workdir, trustProjectConfig: true }),
      "unsupported_version",
    );
    expect(error.message).toContain(file);
  });

  it("discloses an untrusted project config that exists but cannot be inspected", () => {
    const { home, workdir } = tempLayout();
    statFailure.enabled = true;
    try {
      // 未信任:不得静默当作“未配置”,必须 fail-closed 披露不可访问。
      expectConfigError(() => loadPermissionConfig({ home, workdir }), "read_failed");
    } finally {
      statFailure.enabled = false;
    }
  });

  it("非 ENOENT 读取失败映射为 read_failed", () => {
    const { home, workdir } = tempLayout();
    const file = userPath(home);
    mkdirSync(file, { recursive: true });
    const error = expectConfigError(() => loadPermissionConfig({ home, workdir }), "read_failed");
    expect(error.message).toContain(file);
  });

  it("project 读取失败在信任时映射为 read_failed", () => {
    const { home, workdir } = tempLayout();
    const file = projectPath(workdir);
    mkdirSync(file, { recursive: true });
    expectConfigError(
      () => loadPermissionConfig({ home, workdir, trustProjectConfig: true }),
      "read_failed",
    );
  });
});
