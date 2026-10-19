import { describe, expect, it } from "vitest";
import type { McpCallResult, McpToolInfo } from "../src/mcp/manager.js";
import type { McpToolSource } from "../src/mcp/tools.js";
import { createMcpTools } from "../src/mcp/tools.js";
import { evaluatePolicy, toolAccess } from "../src/permissions/policy.js";
import type { ToolDef } from "../src/tools/types.js";

function info(server: string, tool: string, overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    server,
    tool,
    description: "",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

function fakeSource(tools: McpToolInfo[]): McpToolSource {
  return {
    tools: () => tools.map((entry) => ({ ...entry })),
    call: async (): Promise<McpCallResult> => ({ isError: false, code: "ok", message: "", text: "ok" }),
  };
}

function byName(tools: readonly ToolDef<unknown>[], name: string): ToolDef<unknown> {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing MCP tool: ${name}`);
  return found;
}

function diagnose(tool: ToolDef<any>) {
  return evaluatePolicy({ preset: "diagnose", rules: [], tool, args: {} });
}

const source = fakeSource([
  info("s", "both", { readOnly: true, destructive: true }),
  info("s", "destructive", { destructive: true }),
  info("s", "plain"),
  info("s", "readonly", { readOnly: true }),
]);
const tools = createMcpTools(source);

describe("MCP 能力映射", () => {
  it("readOnly:true 映射为 read 并在 diagnose 下 allow", () => {
    const tool = byName(tools, "mcp__s__readonly");
    expect(toolAccess(tool, {})).toBe("read");
    expect(diagnose(tool).action).toBe("allow");
  });

  it("destructive:true 映射为 write 并在 diagnose 下 ask", () => {
    const tool = byName(tools, "mcp__s__destructive");
    expect(toolAccess(tool, {})).toBe("write");
    expect(diagnose(tool).action).toBe("ask");
  });

  it("readOnly 与 destructive 同时为 true 映射为 unknown 并 deny", () => {
    const tool = byName(tools, "mcp__s__both");
    expect(toolAccess(tool, {})).toBe("unknown");
    expect(diagnose(tool).action).toBe("deny");
  });

  it("两者都非 true 映射为 unknown 并 deny", () => {
    const tool = byName(tools, "mcp__s__plain");
    expect(toolAccess(tool, {})).toBe("unknown");
    expect(diagnose(tool).action).toBe("deny");
  });

  it("deny 的求值结果不指向任何规则", () => {
    const result = diagnose(byName(tools, "mcp__s__both"));
    expect(result.source).toBe("builtin");
    expect(result.ruleIndex).toBeUndefined();
    expect(result.reason).toBe("preset:diagnose:unknown");
  });
});
