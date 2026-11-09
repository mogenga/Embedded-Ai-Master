import type {
  PermissionAction,
  PermissionPreset,
  PermissionSource,
} from "../permissions/types.js";
import type { SubagentSummary } from "../subagent/types.js";
import type { ToolAccess } from "../tools/types.js";

export type EventType =
  | "system"
  | "user"
  | "assistant"
  | "assistant_delta"
  // 模型的推理过程（reasoning_content / reasoning）逐段到达。
  //
  // **只有这一种事件，没有 thinking_start / thinking_end**：段落边界是纯投影
  // 状态——「上一条事件是不是 thinking_delta」就能推出来，多两种事件类型就多
  // 两处必须与 `assistant_delta` 保持一致的判定，而它们不携带任何新事实。
  //
  // 它绝不能被投影进模型上下文（`buildMessages` 显式跳过）：`assistant` 正文
  // 会被原样送回下一次请求，把推理也塞进去等于让模型重复消费自己的思考，
  // 既浪费 token，也可能诱导它照抄上一轮的推理路径。
  | "thinking_delta"
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
  | "background_result"
  /**
   * 一个只读子代理的终局，由宿主写成（`src/subagent/runner.ts` 的完成队列）。
   *
   * 与 `background_result` 同一类东西：**事实记录**，不是对话内容。模型已经
   * 通过 `subagent_check` 或随后一条 user 消息看到结论，投影层再放一遍只是让它
   * 复述自己没说过的话——所以 `build.ts` 原位跳过它。
   */
  | "subagent_result"
  /**
   * 一个子代理开跑。由 runner 在返回 id **之前**写（`src/subagent/runner.ts`）。
   *
   * 与 `subagent_result` 同一类东西：**事实记录**，不是对话内容，投影层同样
   * 原位跳过。它存在的理由是终局事件要等作业结束才写，而「现在有哪些子代理在
   * 跑、已经跑了多久」必须有一个更早的凭据——没有它，运行中的那一侧根本不知道
   * 有过这个子代理。
   */
  | "subagent_started";

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

/**
 * 模型推理过程的一段增量文本。
 *
 * 与 `AssistantDeltaPayload` 同形，但**不是**同一种东西：它只用于显示，
 * 投影层必须跳过它（见 `EventType` 的 `thinking_delta` 注释）。字段单独成类型
 * 是为了让「哪些 payload 可以进上下文」在类型层面就看得出来。
 */
export interface ThinkingDeltaPayload {
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
  | "tool_name_renamed"
  /**
   * 正常关闭时进程树回收未确认（D-225）。
   *
   * 它不是「调用失败」也不是「连接失败」：连接已经用完了，只是「关干净了没有」
   * 答案是「不确认」（R3：不许把没确认的事说成成功）。**必须在这份白名单里**，
   * 否则 `toMcpStatusPayload` 会把事件当未知类型丢掉，上报变成假绿地。
   */
  | "dispose_incomplete";

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
  "dispose_incomplete",
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

/**
 * 一条 `subagent_result` 事件的 payload。
 *
 * 就是 `SubagentSummary` 本身：宿主把完成队列里的那一份原样写进日志，完成提示、
 * 回放与事后取证读的是同一份字段。不存在「事件里另算一遍」的第二个口径——
 * 两处各算一次，迟早会对不上。
 */
export type SubagentResultPayload = SubagentSummary;

/**
 * 一条 `subagent_started` 事件的 payload。
 *
 * `maxTurns` / `timeoutMs` 是**真正生效**的两个上限，不是调用方填的原值：填 0
 * 或超范围的值会被 `resolveSubagentMaxTurns` / `resolveSubagentTimeoutMs` 夹到
 * 边界上，事件里回显原值就是说谎——而且与 `subagent` 工具正文会给出两个不同
 * 的数字。这两个数由 runner 算一次、两处共用。
 */
export interface SubagentStartedPayload {
  id: string;
  sessionDir: string;
  promptPreview: string;
  label?: string;
  startedAt: string;
  /** 真正生效的轮数上限，不是用户填的原值（填 0 会被夹到边界）。 */
  maxTurns: number;
  /** 真正生效的寿命上限（毫秒），同上。 */
  timeoutMs: number;
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
