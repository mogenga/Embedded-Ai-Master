import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpCallResult, McpToolInfo } from "./manager.js";
import type { ToolDef } from "../tools/types.js";

export interface McpToolSource {
  tools(): McpToolInfo[];
  call(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
}

export interface McpToolAdapterStatus {
  kind: "mcp_tool_name_collision";
  server: string;
  tool: string;
  name: string;
}

export interface CreateMcpToolsOptions {
  onStatus?: (status: McpToolAdapterStatus) => void;
}

const MAX_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 7;
const INVALID_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

function sanitizeSegment(segment: string): string {
  return segment.replace(INVALID_NAME_CHARS, "_");
}

export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
  if (raw.length <= MAX_TOOL_NAME_LENGTH) {
    return raw;
  }
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 6);
  return `${raw.slice(0, MAX_TOOL_NAME_LENGTH - HASH_SUFFIX_LENGTH)}_${hash}`;
}

export function createMcpTools(
  manager: McpToolSource,
  options: CreateMcpToolsOptions = {},
): ToolDef<unknown>[] {
  const tools: ToolDef<unknown>[] = [];
  const usedNames = new Set<string>();

  for (const info of manager.tools()) {
    const name = mcpToolName(info.server, info.tool);
    if (usedNames.has(name)) {
      options.onStatus?.({
        kind: "mcp_tool_name_collision",
        server: info.server,
        tool: info.tool,
        name,
      });
      continue;
    }
    usedNames.add(name);
    tools.push({
      name,
      description: info.description,
      schema: z.unknown(),
      modelSchema: info.inputSchema,
      annotations: {
        readOnly: info.readOnly === true,
        destructive: info.destructive === true,
        evidence: false,
      },
      execute: async (input, _ctx, signal) =>
        manager.call(info.server, info.tool, input, signal),
    });
  }

  return tools;
}