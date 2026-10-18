export type EventType =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "checkpoint"
  | "status"
  | "interrupted";

export interface SessionEvent {
  seq: number;
  ts: string;
  type: EventType;
  payload: Record<string, unknown>;
  parent?: number;
}

export interface AssistantPayload {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown> | { error: "invalid_json"; raw: string };
  }>;
}

export interface ToolResultPayload {
  id: string;
  ok: boolean;
  text: string;
  artifactPath?: string;
  code?: string;
  detail?: unknown;
}
