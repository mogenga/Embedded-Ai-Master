import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadPermissionConfig } from "../src/permissions/config.js";
import type { InlinePermissionConfig } from "../src/permissions/config.js";
import { evaluatePolicy } from "../src/permissions/policy.js";
import type { ToolDef } from "../src/tools/types.js";

const TEMPLATE_PATH = path.join(import.meta.dirname, "../mcp-servers/probe/permissions.example.json");

function loadTemplate(): InlinePermissionConfig {
  const raw = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as InlinePermissionConfig & {
    version?: number;
  };
  return { preset: raw.preset, rules: raw.rules };
}

function tool(
  name: string,
  annotations: { readOnly?: boolean; destructive?: boolean },
): ToolDef<unknown> {
  return {
    name,
    description: name,
    schema: z.unknown(),
    annotations,
    execute: async () => ({ isError: false, code: "ok", message: "", text: "" }),
  };
}

function evaluate(name: string, annotations: { readOnly?: boolean; destructive?: boolean }, args: unknown) {
  const loaded = loadPermissionConfig({
    home: path.join(import.meta.dirname, ".no-home"),
    workdir: path.join(import.meta.dirname, ".no-workdir"),
    inline: loadTemplate(),
  });
  return evaluatePolicy({
    preset: loaded.preset,
    rules: loaded.rules,
    tool: tool(name, annotations),
    args,
  });
}

const MEM_WRITE = { destructive: true };
const MEM_READ = { readOnly: true };
const SERIAL_OPEN = { readOnly: false };
const SERIAL_WRITE = { destructive: true };

describe("probe 领域权限模板", () => {
  it("允许 SRAM 窗口内的整段写入", () => {
    const evaluation = evaluate("mcp__probe__mem_write", MEM_WRITE, {
      address: 0x20000000,
      bytes: [1, 2, 3, 4],
    });
    expect(evaluation.action).toBe("allow");
    expect(evaluation.source).toBe("inline");
  });

  it("起始地址在窗口内但跨度越界时回落到 ask", () => {
    const evaluation = evaluate("mcp__probe__mem_write", MEM_WRITE, {
      address: 0x2001fff0,
      bytes: new Array(32).fill(0),
    });
    expect(evaluation.action).toBe("ask");
  });

  it("窗口外地址回落到 ask", () => {
    const evaluation = evaluate("mcp__probe__mem_write", MEM_WRITE, {
      address: 0x08000000,
      bytes: [1],
    });
    expect(evaluation.action).toBe("ask");
  });

  it("白名单内的串口目标允许打开", () => {
    const evaluation = evaluate("mcp__probe__serial_open", SERIAL_OPEN, {
      host: "127.0.0.1",
      port: 3456,
    });
    expect(evaluation.action).toBe("allow");
  });

  it("白名单外的串口端口与主机被拒绝", () => {
    expect(
      evaluate("mcp__probe__serial_open", SERIAL_OPEN, { host: "127.0.0.1", port: 3458 }).action,
    ).toBe("deny");
    expect(
      evaluate("mcp__probe__serial_open", SERIAL_OPEN, { host: "0.0.0.0", port: 3456 }).action,
    ).toBe("deny");
  });

  it("复位被独立拒绝", () => {
    const evaluation = evaluate("mcp__probe__reset", { destructive: true }, {});
    expect(evaluation.action).toBe("deny");
    expect(evaluation.reason).toContain("禁止复位");
  });

  it("串口写入仍按预设询问，读工具保持允许", () => {
    expect(evaluate("mcp__probe__serial_write", SERIAL_WRITE, { data: "x" }).action).toBe("ask");
    expect(evaluate("mcp__probe__mem_read", MEM_READ, { address: 0, length: 4 }).action).toBe("allow");
    expect(evaluate("mcp__probe__attach", { readOnly: true }, {}).action).toBe("allow");
  });
});