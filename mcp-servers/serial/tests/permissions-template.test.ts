import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadPermissionConfig } from "../../../src/permissions/config.js";
import type { InlinePermissionConfig } from "../../../src/permissions/config.js";
import { evaluatePolicy } from "../../../src/permissions/policy.js";
import type { ToolDef } from "../../../src/tools/types.js";

/**
 * `mcp-servers/serial/permissions.example.json` 必须是**能被真实加载**的配置，
 * 不是一份看起来像那么回事的 JSON。
 *
 * 模板和 probe 那份同一形态：它不自动生效，复制到 `.harness/permissions.json`
 * 或内联进 `permissions.rules` 后才起作用；所以这里走的就是内核那两件真实工具
 * ——`loadPermissionConfig` 的校验与 `evaluatePolicy` 的求值。
 */

const TEMPLATE_PATH = path.join(import.meta.dirname, "..", "permissions.example.json");

function readTemplate(): InlinePermissionConfig & { version?: number } {
  return JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as InlinePermissionConfig & {
    version?: number;
  };
}

function loadTemplate(): ReturnType<typeof loadPermissionConfig> {
  const raw = readTemplate();
  return loadPermissionConfig({
    home: path.join(import.meta.dirname, ".no-home"),
    workdir: path.join(import.meta.dirname, ".no-workdir"),
    inline: { preset: raw.preset, rules: raw.rules },
  });
}

/** `embed_serial` 在权限层的形状：一个工具，工具级注解是破坏性。 */
function serialTool(): ToolDef<unknown> {
  return {
    name: "mcp__serial__embed_serial",
    description: "embed_serial",
    schema: z.unknown(),
    annotations: { readOnly: false, destructive: true },
    execute: async () => ({ isError: false, code: "ok", message: "", text: "" }),
  };
}

function evaluate(action: string) {
  const loaded = loadTemplate();
  return evaluatePolicy({
    preset: loaded.preset,
    rules: loaded.rules,
    tool: serialTool(),
    args: { action },
  });
}

describe("serial 领域权限模板", () => {
  it("模板能被 loadPermissionConfig 加载，预设是 diagnose", () => {
    const raw = readTemplate();
    const loaded = loadTemplate();

    expect(raw.version).toBe(1);
    expect(loaded.preset).toBe("diagnose");
    // 规则数来自模板本身：两条（read 放行 + 写/开关端口审批）。
    expect(loaded.rules).toHaveLength(2);
    for (const entry of loaded.rules) expect(entry.rule.tool).toBe("mcp__serial__embed_serial");
    expect(loaded.rules.map((entry) => entry.source)).toEqual(["inline", "inline"]);
  });

  it("read 放行为 allow，write / open / close 都是 ask", () => {
    expect(evaluate("read")).toMatchObject({ action: "allow", source: "inline" });
    for (const action of ["write", "open", "close"]) {
      expect(evaluate(action), action).toMatchObject({ action: "ask", source: "inline" });
    }
  });

  it("read 的 allow 只覆盖 read：别的动作不会蹭到那条规则", () => {
    const rule = loadTemplate().rules[0]?.rule;
    expect(rule?.action).toBe("allow");
    expect(rule?.params).toEqual([{ key: "action", in: ["read"] }]);
  });

  it("ask 规则的理由说明可以按端口白名单收窄（与 embedded 模板同一措辞）", () => {
    const askRule = loadTemplate().rules[1]?.rule;

    expect(askRule?.action).toBe("ask");
    expect(askRule?.reason).toContain("可仿照 probe 示例按端口白名单收窄为 allow");
  });
});
