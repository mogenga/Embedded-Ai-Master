import { matchParams, matchToolPattern } from "./rules.js";
import type {
  PermissionAction,
  PermissionPreset,
  PermissionSource,
  SourcedRule,
} from "./types.js";
import type { ToolAccess, ToolDef } from "../tools/types.js";

const ERROR_REASON_PREFIX = "permission_error:";
const ERROR_REASON_MAX_LENGTH = 200;

const DEFAULT_ACTIONS: Record<PermissionPreset, Record<ToolAccess, PermissionAction>> = {
  "read-only": { read: "allow", write: "deny", unknown: "deny" },
  "workspace-write": { read: "allow", write: "ask", unknown: "deny" },
  diagnose: { read: "allow", write: "ask", unknown: "deny" },
  "danger-full-access": { read: "allow", write: "allow", unknown: "allow" },
};

export interface PolicyEvaluation {
  action: PermissionAction;
  reason: string;
  preset: PermissionPreset;
  source: PermissionSource;
  ruleIndex?: number;
  access: ToolAccess;
}

export function builtinRules(preset: PermissionPreset): SourcedRule[] {
  if (preset !== "workspace-write") return [];
  return [
    {
      rule: {
        tool: "fs",
        params: [{ key: "op", in: ["write", "edit"] }],
        action: "allow",
        reason: "preset:workspace-write:fs-write",
      },
      source: "builtin",
    },
  ];
}

function isToolAccess(value: unknown): value is ToolAccess {
  return value === "read" || value === "write" || value === "unknown";
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return "function";
  if (typeof value === "object" && value !== null) {
    return Object.prototype.toString.call(value);
  }
  return String(value);
}

export function toolAccess(tool: ToolDef<any>, args: unknown): ToolAccess {
  const access = (tool as { access?: unknown }).access;
  if (access !== undefined) {
    if (typeof access !== "function") {
      throw new Error(`tool.access is not a function: ${describeValue(access)}`);
    }
    const value: unknown = access.call(tool, args);
    if (!isToolAccess(value)) {
      throw new Error(`tool.access returned invalid value: ${describeValue(value)}`);
    }
    return value;
  }

  const destructive = tool.annotations?.destructive === true;
  const readOnly = tool.annotations?.readOnly === true;
  if (destructive && readOnly) return "unknown";
  if (destructive) return "write";
  if (readOnly) return "read";
  return "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorReason(error: unknown): string {
  const available = ERROR_REASON_MAX_LENGTH - ERROR_REASON_PREFIX.length;
  return `${ERROR_REASON_PREFIX}${errorMessage(error).slice(0, available)}`;
}

export function evaluatePolicy(input: {
  preset: PermissionPreset;
  rules: readonly SourcedRule[];
  tool: ToolDef<any>;
  args: unknown;
}): PolicyEvaluation {
  const { preset, rules, tool, args } = input;
  try {
    const access = toolAccess(tool, args);
    const all = [...rules, ...builtinRules(preset)];

    const matches: Array<{ entry: SourcedRule; index: number }> = [];
    for (let index = 0; index < all.length; index += 1) {
      const entry = all[index]!;
      if (!matchToolPattern(entry.rule.tool, tool.name)) continue;
      if (!matchParams(entry.rule.params, args)) continue;
      matches.push({ entry, index });
    }

    for (const action of ["deny", "ask", "allow"] as const) {
      const match = matches.find((candidate) => candidate.entry.rule.action === action);
      if (match === undefined) continue;
      return {
        action,
        reason: match.entry.rule.reason ?? `rule:${action}`,
        preset,
        source: match.entry.source,
        ruleIndex: match.index,
        access,
      };
    }

    return {
      action: DEFAULT_ACTIONS[preset][access],
      reason: `preset:${preset}:${access}`,
      preset,
      source: "builtin",
      access,
    };
  } catch (error) {
    return {
      action: "deny",
      reason: errorReason(error),
      preset,
      source: "builtin",
      access: "unknown",
    };
  }
}
