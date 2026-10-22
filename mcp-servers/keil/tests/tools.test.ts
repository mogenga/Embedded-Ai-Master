import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createKeilTools } from "../tools.js";
import { DEBUG_ACTIONS, PROJECT_ACTIONS, DESTRUCTIVE_ACTIONS, EVIDENCE_ACTIONS } from "../actions.js";
import { declarationFor } from "../declarations.js";
import { UNSUPPORTED_ON_MDK_5_43 } from "../keilExtra.js";

const tools = createKeilTools();
const byName = (name: string) => tools.find((tool) => tool.name === name)!;
const actionEnum = (name: string): string[] =>
  ((byName(name).inputSchema as unknown as { shape: { action: { options: string[] } } }).shape.action.options);

describe("keil 工具面", () => {
  it("注册两个工具，名字与权限模板一致", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(["keil_debug", "keil_project"]);
    const permissions = JSON.parse(readFileSync("mcp-servers/keil/permissions.example.json", "utf8")) as {
      rules: { tool: string }[];
    };
    const registered = new Set(tools.map((tool) => `mcp__keil__${tool.name}`));
    expect(permissions.rules.length).toBeGreaterThan(0);
    for (const rule of permissions.rules) expect(registered.has(rule.tool)).toBe(true);
  });

  it("action 枚举与 A 侧逐字一致（57 + 14）", () => {
    expect(actionEnum("keil_debug")).toEqual([...DEBUG_ACTIONS]);
    // A 的枚举实为 57 条（规格书写作 56）：以代码为准，逐条对齐。
    expect(actionEnum("keil_debug").length).toBe(57);
    expect(actionEnum("keil_project")).toEqual([...PROJECT_ACTIONS]);
    expect(actionEnum("keil_project").length).toBe(14);
  });

  it("每个破坏性动作都有写前声明", () => {
    for (const action of DESTRUCTIVE_ACTIONS) {
      const tool = (PROJECT_ACTIONS as readonly string[]).includes(action) ? "keil_project" : "keil_debug";
      const declaration = declarationFor(tool, action, {
        address: 0x20000000,
        width: "u32",
        count: 2,
        name: "R0",
        expression: "g_state",
      });
      expect(declaration, `action ${action} 缺少 declaration`).toBeTruthy();
      expect(declaration!.operation.length).toBeGreaterThan(0);
      expect(declaration!.effect.length).toBeGreaterThan(0);
    }
  });

  it("evidence 集合覆盖 §7.1 的取证动作", () => {
    for (const action of [
      "registers", "register_read", "variables", "struct_members", "stack", "where", "tasks", "time",
      "read", "disassemble", "show_code", "symbols", "symbols_all", "trace_get", "itm", "event_recorder",
      "info", "targets", "groups", "files", "output_name", "get_option", "capabilities", "version", "license",
    ]) {
      expect(EVIDENCE_ACTIONS.has(action), action).toBe(true);
    }
  });

  it("UNSUPPORTED_ON_MDK_5_43 的 14 条都带实测理由", () => {
    expect(Object.keys(UNSUPPORTED_ON_MDK_5_43).length).toBe(14);
    for (const why of Object.values(UNSUPPORTED_ON_MDK_5_43)) expect(why.length).toBeGreaterThan(15);
  });

  it("工具描述写明会话常驻与经 uVision 落盘", () => {
    expect(byName("keil_debug").description).toMatch(/Sessions stay open/);
    expect(byName("keil_project").description).toMatch(/written to the \.uvprojx by uVision/);
  });

  it("handler 返回 probe 形状的 structuredContent", async () => {
    const debug = byName("keil_debug");
    // 用一个必然失败但不需要真机的动作：动作分发层的错误也必须结构化返回，
    // 而不是抛异常。`read` 在无会话时返回 isError 与说明文案。
    const result = await debug.handler({ action: "sessions" });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { tool: string; action: string; evidence?: boolean };
    expect(structured.tool).toBe("keil_debug");
    expect(structured.action).toBe("sessions");
    expect(structured.evidence).toBeUndefined();
  });
});