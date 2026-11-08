import { createHash } from "node:crypto";
import { z } from "zod";
import { parseDeviceStatus } from "./device-status.js";
import type { McpCallResult, McpToolInfo } from "./manager.js";
import type { ToolAccess, ToolDef, ToolResult } from "../tools/types.js";

export interface McpToolSource {
  tools(): McpToolInfo[];
  call(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
}

export type McpToolAdapterStatus =
  | {
      kind: "mcp_tool_name_renamed";
      server: string;
      tool: string;
      name: string;
      originalName: string;
    }
  | {
      kind: "mcp_tool_invalid_schema";
      server: string;
      tool: string;
      message: string;
    };

export interface CreateMcpToolsOptions {
  onStatus?: (status: McpToolAdapterStatus) => void;
  reservedNames?: Iterable<string>;
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

function isObjectSchema(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    !Array.isArray(schema) &&
    (schema as { type?: unknown }).type === "object"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionList(values: string[] | undefined): ReadonlySet<string> | undefined {
  return values === undefined ? undefined : new Set(values);
}

/**
 * 按**本次调用的 `action`** 判定读写（OPT-21）。
 *
 * 没有出现在任何白名单里的动作一律 `unknown`（fail-closed：`diagnose` 下拒绝，
 * 而不是当成只读放行）。两边都声明时同样 `unknown`——两份白名单互相矛盾，
 * 按任何一边都可能把一次真实的写放过去；宁可多问一次，不可少问一次。
 */
function actionAccess(
  readOnly: ReadonlySet<string> | undefined,
  destructive: ReadonlySet<string> | undefined,
  input: unknown,
): ToolAccess {
  if (!isRecord(input)) return "unknown";
  const action = input.action;
  if (typeof action !== "string") return "unknown";
  const isRead = readOnly?.has(action) === true;
  const isDestructive = destructive?.has(action) === true;
  if (isRead && isDestructive) return "unknown";
  if (isDestructive) return "write";
  if (isRead) return "read";
  return "unknown";
}

function withDeviceStatus(result: McpCallResult, server: string): ToolResult {
  if (result.isError === true) return result;
  const structured = result.structuredContent;
  if (!isRecord(structured)) return result;
  const descriptor = Object.getOwnPropertyDescriptor(structured, "deviceStatus");
  if (descriptor === undefined || !("value" in descriptor)) return result;
  const parsed = parseDeviceStatus(descriptor.value);
  if (parsed.ok) {
    return { ...result, deviceStatus: { server, state: parsed.value.state } };
  }
  return { ...result, deviceStatusInvalid: parsed.reason };
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
  const usedNames = new Set<string>(options.reservedNames ?? []);

  // 先按 (server, tool) 字典序排序再分配名称:同一批工具不因 server 返回顺序
  // 不同而改变暴露名,权限规则与历史会话才能按名寻址(D-100)。
  const infos = manager.tools()
    .slice()
    .sort((left, right) =>
      left.server === right.server
        ? left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0
        : left.server < right.server ? -1 : 1,
    );
  for (const info of infos) {
    if (!isObjectSchema(info.inputSchema)) {
      options.onStatus?.({
        kind: "mcp_tool_invalid_schema",
        server: info.server,
        tool: info.tool,
        message: `MCP 工具 inputSchema 根必须是 object: ${info.server}/${info.tool}`,
      });
      continue;
    }
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
    // 注解描述的是「这个工具可能有破坏性」，是给 UI 与策略表看的整工具属性；
    // `access` 描述的是「这一次调用是哪种」。两者并存时
    // `src/permissions/policy.ts` 的 `toolAccess` 优先用 `access`，注解仍照原样
    // 保留——不要因为有了 per-action 判定就把 destructive 改成 false。
    const readOnlyActions = actionList(info.readOnlyActions);
    const destructiveActions = actionList(info.destructiveActions);
    const perAction = readOnlyActions !== undefined || destructiveActions !== undefined;
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
      // 两份白名单都缺失 → 不声明 `access`，权限层完全走注解旧路径（零行为变化）。
      ...(perAction
        ? {
            access: (input: unknown): ToolAccess =>
              actionAccess(readOnlyActions, destructiveActions, input),
          }
        : {}),
      // MCP 工具的自有预算来自 `mcp.json` 的 `timeoutMs`（`loadTools` 已把它
      // 带进 `McpToolInfo`）。不声明这一项，管线会一律套 120s 缺省，
      // `keil_debug` 的构建动作就在 120s 被掐断（OPT-13）。
      ...(info.callTimeoutMs === undefined ? {} : { callTimeoutMs: info.callTimeoutMs }),
      execute: async (input, _ctx, signal) => {
        const result = withDeviceStatus(
          await manager.call(info.server, info.tool, input, signal),
          info.server,
        );
        return info.evidence === true && result.isError !== true
          ? { ...result, evidence: true }
          : result;
      },
    });
  }

  return tools;
}
