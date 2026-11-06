import type { ToolResultPayload } from "../session/types.js";

export type LoopFinishReason =
  | "no_tool_calls"
  | "max_turns"
  | "max_cost_usd"
  | "aborted"
  // 整跑墙钟到点(D-189)。与 `aborted` 分开:用户主动取消和跑超时不是一回事。
  | "deadline"
  // 连续截断达到上限(KERNEL-4):正常结束,但内容确实没写完。
  | "truncated"
  // 服务端报上下文超限且一次强制压缩仍未恢复(KERNEL-5)。
  | "context_overflow";

export type LoopEvent =
  | { kind: "model_message"; content: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | ({ kind: "tool_result" } & ToolResultPayload)
  | { kind: "turn_end"; turn: number; costUsd?: number }
  | { kind: "compacted" }
  | { kind: "interrupted"; reason: string }
  | { kind: "done"; finishReason: LoopFinishReason };
