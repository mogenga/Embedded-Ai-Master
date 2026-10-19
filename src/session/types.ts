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
  | "usage"
  | "checkpoint"
  | "status"
  | "interrupted"
  | "compaction"
  | "permission_decision";

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
  evidence?: boolean;
  toolName?: string;
}

export type CompactionPayload =
  | { kind: "microcompact"; elidedSeqs: number[]; note: string }
  | { kind: "summary"; summary: string; coversUpToSeq: number }
  | { kind: "failed"; reason: string; stage: "microcompact" | "summary" };

export interface PermissionDecisionPayload {
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
