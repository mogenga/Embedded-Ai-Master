import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPermissionConfig } from "../../../src/permissions/config.js";
import type { InlinePermissionConfig } from "../../../src/permissions/config.js";
import { PHASED_TOOLS } from "../server.js";

/**
 * `mcp-servers/embedded/permissions.example.json` 的工具名必须与 `server.ts`
 * 的 `PHASED_TOOLS` 逐一对应。
 *
 * 模板是给人复制去用的：写错一个名字，那条规则就永不命中，而它看起来还在。
 * 实际发生过——规则写 `embed_pack`，真实工具是 `embed_packs`（OPT-43）。
 * 双向断言：「模板 ⊆ 真实」挡住错名，「真实 ⊆ 模板」挡住漏配（比如
 * `embed_identify` 一直没有规则）。
 */

const TEMPLATE_PATH = path.join(import.meta.dirname, "..", "permissions.example.json");

function readTemplate(): InlinePermissionConfig & { version?: number } {
  return JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as InlinePermissionConfig & {
    version?: number;
  };
}

/** `mcp__embedded__` 之后的部分，即真实工具名。 */
function templateToolNames(): string[] {
  const raw = readTemplate();
  return (raw.rules ?? []).map((rule) => rule.tool.replace(/^mcp__embedded__/, ""));
}

function realToolNames(): string[] {
  return PHASED_TOOLS.map((tool) => tool.name);
}

describe("embedded 领域权限模板", () => {
  it("模板里的每个工具名都是真实工具（挡住错名）", () => {
    const real = new Set(realToolNames());

    expect(templateToolNames().filter((name) => !real.has(name))).toEqual([]);
  });

  it("每个真实工具都有规则（挡住漏配）", () => {
    const inTemplate = new Set(templateToolNames());

    expect(realToolNames().filter((name) => !inTemplate.has(name))).toEqual([]);
  });

  it("工具链包那条规则拼写是 embed_packs", () => {
    expect(templateToolNames()).toContain("embed_packs");
    expect(templateToolNames()).not.toContain("embed_pack");
  });

  it("规则能经内核的权限 schema 校验，且没有把非破坏性工具配成 deny", () => {
    const raw = readTemplate();
    const loaded = loadPermissionConfig({
      home: path.join(import.meta.dirname, ".no-home"),
      workdir: path.join(import.meta.dirname, ".no-workdir"),
      inline: { preset: raw.preset, rules: raw.rules },
    });

    expect(loaded.preset).toBe("diagnose");
    expect(loaded.rules).toHaveLength(PHASED_TOOLS.length);

    const actions = new Map(loaded.rules.map((entry) => [entry.rule.tool, entry.rule.action]));
    for (const tool of PHASED_TOOLS) {
      if (tool.destructive) continue;
      // 非破坏性的那几个只读工具必须放行，否则模板把只读也变成审批。
      expect(actions.get(`mcp__embedded__${tool.name}`), tool.name).not.toBe("deny");
    }
    // embed_identify 是本轮补上的那条只读规则。
    expect(actions.get("mcp__embedded__embed_identify")).toBe("allow");
  });
});
