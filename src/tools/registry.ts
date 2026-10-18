import { z } from "zod";
import type { ModelToolSchema } from "../model/protocol.js";
import type { ToolDef } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef<any>>();

  constructor(tools: ToolDef<any>[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`tool already registered: ${tool.name}`);
      }
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
      parameters: z.toJSONSchema(tool.schema, { io: "input" }),
    },
  }));
}
