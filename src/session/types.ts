import type {
  PermissionAction,
  PermissionPreset,
  PermissionSource,
} from "../permissions/types.js";
import type { ToolAccess } from "../tools/types.js";

export type EventType =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "tool_started"
  | "mcp_status"
  | "device_status"
  | "usage"
  | "checkpoint"
  | "status"
  | "interrupted"
  | "compaction"
  | "permission_decision"
  | "approval_request";

export interface SessionHeader {
  id: string;
  createdAt: string;
  status: "open" | "closed";
  provider?: string;
  model?: string;
  workdir?: string;
  forkedFrom?: { sessionId: string; seq: number };
}

export interface SessionEvent {
  seq: number;
  ts: string;
  type: EventType;
  payload: Record<string, unknown>;
  parent?: number;
}

export interface SessionEventEnvelope extends SessionEvent {
  sessionId: string;
}

export interface ToolStartedPayload {
  callId: string;
  tool: string;
  access?: ToolAccess;
}

export type McpStatusPayloadKind =
  | "connected"
  | "connect_failed"
  | "tools_changed"
  | "tools_refresh_failed"
  | "tool_invalid_schema"
  | "listener_failed"
  | "call_failed"
  | "config_failed"
  | "config_warning"
  | "project_config_skipped"
  | "tool_name_renamed";

// 运行时白名单:type 只是编译期约束,日志/SSE 的内容不可信,必须有一处可被代码读取的清单。
export const MCP_STATUS_PAYLOAD_KINDS: readonly McpStatusPayloadKind[] = [
  "connected",
  "connect_failed",
  "tools_changed",
  "tools_refresh_failed",
  "tool_invalid_schema",
  "listener_failed",
  "call_failed",
  "config_failed",
  "config_warning",
  "project_config_skipped",
  "tool_name_renamed",
];

export interface McpStatusPayload {
  kind: McpStatusPayloadKind;
  server?: string;
  tool?: string;
  toolCount?: number;
  message?: string;
  attempts?: number;
  name?: string;
  originalName?: string;
  scope?: "global";
}

export interface DeviceStatusPayload {
  callId: string;
  server: string;
  tool: string;
  state: Record<string, unknown>;
}

export interface AssistantPayload {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown> | { error: "invalid_json"; raw: string };
    invalidJson?: boolean;
  }>;
}

export interface ToolResultPayload {
  id: string;
  ok: boolean;
  text: string;
  artifactPath?: string;
  code?: string;
  detail?: unknown;
  evidence?: boolean;
  toolName?: string;
}

export type CompactionPayload =
  | { kind: "microcompact"; elidedSeqs: number[]; note: string }
  | { kind: "summary"; summary: string; coversUpToSeq: number }
  | { kind: "failed"; reason: string; stage: "microcompact" | "summary" };

export interface PermissionDecisionPayload {
  requestId?: string;
  callId: string;
  tool: string;
  action: PermissionAction;
  effective: "allow" | "deny";
  reason: string;
  preset: PermissionPreset;
  source: PermissionSource;
  ruleIndex?: number;
  paramsDigest: string;
  paramsKeys: string[];
  paramsPreview?: Record<string, unknown>;
  access?: ToolAccess;
}

export interface ApprovalRequestPayload {
  requestId: string;
  callId: string;
  tool: string;
  action: "ask";
  access?: ToolAccess;
  reason: string;
  preset: PermissionPreset;
  paramsDigest: string;
  paramsKeys: string[];
  paramsPreview?: Record<string, unknown>;
  deadlineAt: string;
  effective?: never;
}
