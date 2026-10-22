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
  | "assistant_delta"
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
  | "approval_request"
  | "todos"
  | "background_result";

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
  /** 工具自身的语义标记；取自 ToolDef.annotations，缺省即未知。 */
  annotations?: { readOnly?: boolean; destructive?: boolean; evidence?: boolean };
}

/**
 * 模型输出的一段增量文本。
 *
 * 与 `assistant` 事件并存：`assistant` 是这一轮的最终结论（内容完整、可用于
 * 重建模型上下文），`assistant_delta` 是到达过程中的片段，只用于实时显示。
 * 投影层忽略 delta，用 `assistant` 重建上下文；UI 用 delta 做逐字显示。
 */
export interface AssistantDeltaPayload {
  text: string;
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

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/**
 * 模型当前的待办计划。
 *
 * 这是界面状态，不是对话内容：投影层忽略它，模型上下文由 `assistant` 与
 * `tool_result` 重建。每次 `todo_write` 写整份列表（替换而不是追加），
 * 渲染器据此原地打勾。
 */
export interface TodosPayload {
  callId: string;
  items: TodoItem[];
}

export type BackgroundJobStatus = "exited" | "signaled" | "timed_out";

export type BackgroundKilledBy = "timeout" | "kill" | "abort";

/**
 * 一条后台作业的终局。
 *
 * 这是**事实记录**，不是界面状态：模型与回放都可能需要知道上一轮那条
 * `terminal_bg` 最后怎么了。它由宿主的完成泵写成一条 `background_result`
 * 事件（`parent` 指向发起它的那次 `terminal_bg` 调用），投影层把它原位跳过
 * ——它不带新的对话内容，模型已经通过 `terminal_bg_check` 或宿主后续的
 * user 消息看到结果。
 *
 * `bytes` 是作业真实产出的字节数，`capturedBytes` 是我们真正留下的字节数；
 * 两者不等即 `truncated=true`。只报 `capturedBytes` 会把截断说成完整（R3）。
 */
export interface BackgroundResultPayload {
  id: string;
  command: string;
  cwd: string;
  status: BackgroundJobStatus;
  exitCode: number | null;
  signal: string | null;
  killedBy: BackgroundKilledBy | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** stdout+stderr 的真实总字节数。 */
  bytes: number;
  /** 实际保留的尾部字节数；`bytes` 大于它即发生了截断。 */
  capturedBytes: number;
  truncated: boolean;
  /** 保留的尾部文本（stdout 与 stderr 按到达顺序合并）。 */
  text: string;
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
