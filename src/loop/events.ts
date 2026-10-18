export type LoopFinishReason = "no_tool_calls" | "max_turns" | "max_cost_usd" | "aborted";

export type LoopEvent =
  | { kind: "model_message"; content: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; ok: boolean; text: string }
  | { kind: "turn_end"; turn: number; costUsd?: number }
  | { kind: "compacted" }
  | { kind: "interrupted"; reason: string }
  | { kind: "done"; finishReason: LoopFinishReason };