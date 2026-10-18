export type EventType =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "checkpoint"
  | "status"
  | "interrupted"
  | "compaction";

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
}
