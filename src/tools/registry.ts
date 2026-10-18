import { z } from "zod";
import type { ModelToolSchema } from "../model/protocol.js";
import type { ToolDef } from "./types.js";

// OpenAI function 工具名契约: a-z/A-Z/0-9/_/-,长度 1-64。
// 在注册期 fail-fast,避免 MCP 工具名到网关才 400。
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function toParametersSchema(tool: ToolDef<any>): unknown {
  const parameters = z.toJSONSchema(tool.schema, { io: "input" });
  const rootType = (parameters as { type?: unknown }).type;
  if (rootType !== "object") {
    throw new Error(`tool "${tool.name}" parameters root must be an object, got ${String(rootType ?? "none")}`);
  }
  return parameters;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef<any>>();

  constructor(tools: ToolDef<any>[]) {
    for (const tool of tools) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        throw new Error(`invalid tool name "${tool.name}": must match ${TOOL_NAME_PATTERN.source}`);
      }
      if (this.tools.has(tool.name)) {
        throw new Error(`tool already registered: ${tool.name}`);
      }
      // 构造期即验证 schema 可转换且根为 object: fail-fast,
      // 同时把 zod 的 unrepresentable 错误提前到装配期。
      toParametersSchema(tool);
      this.tools.set(tool.name, tool);
    }
  }

  lookup(name: string): ToolDef<any> | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef<any>[] {
    return [...this.tools.values()];
  }

  find(name: string): { tool?: ToolDef<any> } {
    const tool = this.lookup(name);
    return tool ? { tool } : {};
  }
}

export function toModelToolSchemas(tools: ToolDef<any>[]): ModelToolSchema[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toParametersSchema(tool),
    },
  }));
}
