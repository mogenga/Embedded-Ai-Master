import { randomUUID } from "node:crypto";
import { digestParams, summarizeParams } from "./audit.js";
import { PermissionConfigError } from "./errors.js";
import { evaluatePolicy } from "./policy.js";
import type {
  PermissionAction,
  PermissionCheckInput,
  PermissionGate,
  PermissionPreset,
  PermissionPrompter,
  PermissionPromptRequest,
  PermissionRequest,
  SourcedRule,
} from "./types.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_APPROVAL_TIMEOUT_MS = 2_147_483_647;
const APPROVAL_ERROR_MAX_LENGTH = 200;
const APPROVAL_ERROR_PREFIX = "approval_error: ";

export interface PermissionGateOptions {
  preset: PermissionPreset;
  rules: readonly SourcedRule[];
  prompter?: PermissionPrompter;
  approvalTimeoutMs?: number;
}

type ApprovalOutcome =
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

type ApprovalPrompt = Omit<PermissionPromptRequest, "signal" | "deadlineAt">;

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return "function";
  if (typeof value === "symbol" || typeof value === "bigint") return String(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") {
    // 不可信对象可能自定义 Symbol.toStringTag 并在其中抛错;描述本身不得抛。
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

// 与 policy.ts 同理:prompter 的 rejection 值不可信,读取 message/toString 本身
// 可能抛错。若在此处再抛,settle 不会执行,审批队列会永久占用 active 槽位。
const UNKNOWN_ERROR_MESSAGE = "unknown error";

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return UNKNOWN_ERROR_MESSAGE;
  }
}

function approvalErrorReason(message: string): string {
  const available = Math.max(0, APPROVAL_ERROR_MAX_LENGTH - APPROVAL_ERROR_PREFIX.length);
  return `${APPROVAL_ERROR_PREFIX}${Array.from(message).slice(0, available).join("")}`;
}

function validateApprovalTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_APPROVAL_TIMEOUT_MS) {
    throw new PermissionConfigError(
      "invalid_schema",
      `approvalTimeoutMs 必须是 1..${MAX_APPROVAL_TIMEOUT_MS} 的整数，收到 ${String(value)}`,
    );
  }
  return value;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function createPermissionGate(opts: PermissionGateOptions): PermissionGate {
  const configuredTimeout = opts.approvalTimeoutMs;
  const timeoutMs = validateApprovalTimeout(
    configuredTimeout === undefined ? DEFAULT_APPROVAL_TIMEOUT_MS : configuredTimeout,
  );
  const { preset, rules, prompter } = opts;

  let active = false;
  let pumping = false;
  const queue: Array<() => void> = [];

  function pump(): void {
    if (pumping || active) return;
    pumping = true;
    try {
      while (!active && queue.length > 0) {
        queue.shift()!();
      }
    } finally {
      pumping = false;
    }
  }

  function requestApproval(prompt: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      let started = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const deadline = Date.now() + timeoutMs;

      const start = (): void => {
        if (settled || prompter === undefined) return;
        if (Date.now() >= deadline) {
          settle({ kind: "timeout" });
          controller.abort();
          return;
        }
        started = true;
        active = true;

        try {
          const promptReq: PermissionPromptRequest = {
            requestId: prompt.requestId,
            callId: prompt.callId,
            tool: prompt.tool,
            args: prompt.args,
            reason: prompt.reason,
            preset: prompt.preset,
            access: prompt.access,
            deadlineAt: new Date(deadline).toISOString(),
            paramsDigest: prompt.paramsDigest,
            paramsKeys: prompt.paramsKeys,
            ...(prompt.paramsPreview === undefined
              ? {}
              : { paramsPreview: prompt.paramsPreview }),
            signal: controller.signal,
          };
          const pending = prompter.request(promptReq);
          if (!isThenable(pending)) {
            settle({ kind: "error", message: `非法审批返回值: ${describeValue(pending)}` });
            return;
          }

          Promise.resolve(pending).then(
            (value) => {
              if (value === "allow" || value === "deny") {
                settle({ kind: value });
                return;
              }
              settle({ kind: "error", message: `非法审批结果: ${describeValue(value)}` });
            },
            (error) => settle({ kind: "error", message: errorMessage(error) }),
          );
        } catch (error) {
          settle({ kind: "error", message: errorMessage(error) });
        }
      };

      function cleanup(): void {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        signal.removeEventListener("abort", onAbort);
        if (!started) {
          const index = queue.indexOf(start);
          if (index >= 0) queue.splice(index, 1);
        }
      }

      function settle(outcome: ApprovalOutcome): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
        if (started) {
          started = false;
          active = false;
        }
        pump();
      }

      function onAbort(): void {
        settle({ kind: "aborted" });
        controller.abort();
      }

      if (signal.aborted) {
        settle({ kind: "aborted" });
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        settle({ kind: "timeout" });
        controller.abort();
      }, timeoutMs);
      queue.push(start);
      pump();
    });
  }

  return {
    async check(input: PermissionCheckInput): Promise<PermissionRequest> {
      const evaluation = evaluatePolicy({ preset, rules, tool: input.tool, args: input.args });
      const action: PermissionAction = isPermissionAction(evaluation.action)
        ? evaluation.action
        : "deny";

      const summary = summarizeParams(input.args);
      const requestId = randomUUID();
      const request: PermissionRequest = {
        requestId,
        callId: input.callId,
        tool: input.tool.name,
        args: input.args,
        access: evaluation.access,
        action,
        effective: action === "allow" ? "allow" : "deny",
        reason: evaluation.reason,
        preset: evaluation.preset,
        source: evaluation.source,
        paramsDigest: digestParams(input.args),
        paramsKeys: summary.keys,
        ...(summary.preview === undefined ? {} : { paramsPreview: summary.preview }),
        ...(evaluation.ruleIndex === undefined ? {} : { ruleIndex: evaluation.ruleIndex }),
      };

      if (action === "allow") return request;
      if (action === "deny") return request;

      if (prompter === undefined) {
        return { ...request, effective: "deny", reason: "approval_unavailable" };
      }

      if (input.signal.aborted) {
        return { ...request, effective: "deny", reason: "approval_aborted" };
      }

      const outcome = await requestApproval(
        {
          requestId,
          callId: request.callId,
          tool: request.tool,
          args: request.args,
          reason: evaluation.reason,
          preset: evaluation.preset,
          access: request.access,
          paramsDigest: request.paramsDigest,
          paramsKeys: summary.keys,
          ...(request.paramsPreview === undefined
            ? {}
            : { paramsPreview: request.paramsPreview }),
        },
        input.signal,
      );

      switch (outcome.kind) {
        case "allow":
          return {
            ...request,
            effective: "allow",
            reason: `${evaluation.reason};approval_granted`,
          };
        case "deny":
          return { ...request, effective: "deny", reason: "approval_denied" };
        case "timeout":
          return { ...request, effective: "deny", reason: "approval_timeout" };
        case "aborted":
          return { ...request, effective: "deny", reason: "approval_aborted" };
        case "error":
          return {
            ...request,
            effective: "deny",
            reason: approvalErrorReason(outcome.message),
          };
      }
    },
  };
}
