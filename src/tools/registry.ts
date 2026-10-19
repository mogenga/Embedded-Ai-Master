import { z } from "zod";
import type { ModelToolSchema } from "../model/protocol.js";
import type { ToolDef } from "./types.js";

// OpenAI function 工具名契约: a-z/A-Z/0-9/_/-,长度 1-64。
// 在注册期 fail-fast,避免 MCP 工具名到网关才 400。
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function rootTypeOf(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) {
    return undefined;
  }
  return (schema as { type?: unknown }).type;
}

function toParametersSchema(tool: ToolDef<any>): unknown {
  if (tool.modelSchema !== undefined) {
    const rootType = rootTypeOf(tool.modelSchema);
    if (rootType !== "object") {
      throw new Error(`tool "${tool.name}" modelSchema root must be an object, got ${String(rootType ?? "none")}`);
    }
    return tool.modelSchema;
  }
  const parameters = z.toJSONSchema(tool.schema, { io: "input" });
  const rootType = rootTypeOf(parameters);
  if (rootType !== "object") {
    throw new Error(`tool "${tool.name}" parameters root must be an object, got ${String(rootType ?? "none")}`);
  }
  return parameters;
}

function buildToolMap(tools: ToolDef<any>[]): Map<string, ToolDef<any>> {
  const map = new Map<string, ToolDef<any>>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`invalid tool name "${tool.name}": must match ${TOOL_NAME_PATTERN.source}`);
    }
    if (map.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }

    toParametersSchema(tool);
    map.set(tool.name, tool);
  }
  return map;
}

export class ToolRegistry {
  private tools: Map<string, ToolDef<any>>;

  constructor(tools: ToolDef<any>[]) {
    this.tools = buildToolMap(tools);
  }


  replace(tools: ToolDef<any>[]): void {
    this.tools = buildToolMap(tools);
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
