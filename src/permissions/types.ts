import type { ToolAccess, ToolDef } from "../tools/types.js";

export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionPreset = "read-only" | "workspace-write" | "diagnose" | "danger-full-access";

export type PermissionSource = "inline" | "project" | "user" | "builtin";

export interface ParamMatcher {
  key: string;
  eq?: string | number | boolean | null;
  glob?: string;
  in?: Array<string | number | boolean | null>;
  range?: [number, number];
}

export interface PermissionRule {
  tool: string;
  params?: ParamMatcher[];
  action: PermissionAction;
  reason?: string;
}

export interface SourcedRule {
  rule: PermissionRule;
  source: PermissionSource;
}

export interface PermissionConfig {
  version: 1;
  preset?: PermissionPreset;
  rules?: PermissionRule[];
  approvalTimeoutMs?: number;
}

export interface PermissionCheckInput {
  callId: string;
  tool: ToolDef<any>;
  args: unknown;
  signal: AbortSignal;
}

export interface PermissionRequest {
  callId: string;
  tool: string;
  args: unknown;
  access: ToolAccess;
  action: PermissionAction;
  effective: "allow" | "deny";
  reason: string;
  preset: PermissionPreset;
  source: PermissionSource;
  ruleIndex?: number;
  paramsDigest: string;
  paramsKeys: string[];
  paramsPreview?: Record<string, unknown>;
}

export interface PermissionPromptRequest {
  requestId: string;
  callId: string;
  tool: string;
  args: unknown;
  reason: string;
  preset: PermissionPreset;
  access: ToolAccess;
  deadlineAt: string;
  paramsDigest: string;
  paramsKeys: string[];
  paramsPreview?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface PermissionGate {
  check(input: PermissionCheckInput): Promise<PermissionRequest>;
}

export interface PermissionPrompter {
  request(req: PermissionPromptRequest): Promise<"allow" | "deny">;
}
