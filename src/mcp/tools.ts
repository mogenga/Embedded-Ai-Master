import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpCallResult, McpToolInfo } from "./manager.js";
import type { ToolDef } from "../tools/types.js";

export interface McpToolSource {
  tools(): McpToolInfo[];
  call(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
}

export type McpToolAdapterStatus = {
  kind: "mcp_tool_name_renamed";
  server: string;
  tool: string;
  name: string;
  originalName: string;
};

export interface CreateMcpToolsOptions {
  onStatus?: (status: McpToolAdapterStatus) => void;
}

const MAX_TOOL_NAME_LENGTH = 64;
const HASH_HEX_LENGTH = 6;
const HASH_SUFFIX_LENGTH = HASH_HEX_LENGTH + 1;
const INVALID_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

function sanitizeSegment(segment: string): string {
  return segment.replace(INVALID_NAME_CHARS, "_");
}

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_HEX_LENGTH);
}

function clippedName(name: string, seed: string): string {
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - HASH_SUFFIX_LENGTH)}_${hashHex(seed)}`;
}

export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
  if (raw.length <= MAX_TOOL_NAME_LENGTH) {
    return raw;
  }
  return clippedName(raw, raw);
}

function renamedName(base: string, server: string, tool: string, used: Set<string>): string {
  const identity = `mcp__${server}__${tool}`;
  for (let attempt = 0; ; attempt += 1) {
    const seed = attempt === 0 ? identity : `${identity}#${attempt}`;
    const candidate = clippedName(base, seed);
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

export function createMcpTools(
  manager: McpToolSource,
  options: CreateMcpToolsOptions = {},
): ToolDef<unknown>[] {
  const tools: ToolDef<unknown>[] = [];
  const usedNames = new Set<string>();

  for (const info of manager.tools()) {
    const baseName = mcpToolName(info.server, info.tool);
    let name = baseName;
    if (usedNames.has(baseName)) {
      name = renamedName(baseName, info.server, info.tool, usedNames);
      options.onStatus?.({
        kind: "mcp_tool_name_renamed",
        server: info.server,
        tool: info.tool,
        name,
        originalName: baseName,
      });
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
        evidence: info.evidence === true,
      },
      execute: async (input, _ctx, signal) =>
        manager.call(info.server, info.tool, input, signal),
    });
  }

  return tools;
}
