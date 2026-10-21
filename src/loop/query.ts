import type { ModelCfg } from "../config/providers.js";
import { buildMessages } from "../context/build.js";
import type { TokenMeter } from "../context/token-meter.js";
import type {
  CompletionResult,
  ModelChatMessage,
  ModelProtocol,
} from "../model/protocol.js";
import type { PermissionGate } from "../permissions/types.js";
import type { SessionHandle } from "../session/session.js";
import type {
  PermissionDecisionPayload,
  ToolResultPayload,
  ToolStartedPayload,
} from "../session/types.js";
import { executeBatch } from "../tools/pipeline.js";
import type { BatchCall, BatchOptions, BatchResult } from "../tools/pipeline.js";
import { toModelToolSchemas } from "../tools/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import type { BreakerLimits, PricePerMillion } from "./breakers.js";
import { assertBreakers, computeCostUsd, LoopBroke, normalizeUsage } from "./breakers.js";
import { createAssistantDeltaWriter } from "./assistant-delta.js";
import type { LoopEvent, LoopFinishReason } from "./events.js";

export interface LoopCtx {
  session: SessionHandle;
  model: ModelProtocol;
  modelCfg: ModelCfg;
  tools: ToolRegistry;
  budget: (messages: ModelChatMessage[]) => { over: boolean; tokens: number; softLimit: number };
  compactor?: (session: SessionHandle) => Promise<void>;
  meter?: TokenMeter;
  signal: AbortSignal;
  artifactDir: string;
  cwd?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  pricePerMillion?: PricePerMillion;
  permissionGate?: PermissionGate;
}

export interface LoopConfig extends BreakerLimits {}

interface InvalidJsonMarker {
  error: "invalid_json";
  raw: string;
}

type CallSlot = { marker: ToolResult } | { index: number };

type InterruptReason = Exclude<LoopFinishReason, "no_tool_calls">;

type ExitReason = "normal" | "consumer" | "error";

interface PendingBatch {
  assistantSeq: number;
  calls: CompletionResult["toolCalls"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 内部标记必须显式携带 invalidJson=true(由适配器解析失败分支生成);
// 仅凭 arguments 形状判断会把模型合法输出的同形参数误判为解析失败(D-038)。
function isInvalidJsonMarker(
  call: CompletionResult["toolCalls"][number],
): call is CompletionResult["toolCalls"][number] & {
  arguments: { error: "invalid_json"; raw: string };
} {
  return (
    call.invalidJson === true
    && isRecord(call.arguments)
    && call.arguments.error === "invalid_json"
    && typeof call.arguments.raw === "string"
  );
}

// 重复 tool call id 会让日志出现同 id 的两条 tool_result，回放投影时必抛错，
// 整份会话从此不可回放。必须在落日志前拒绝，保证"日志是唯一事实源"仍可投影。
function assertUniqueToolCallIds(toolCalls: CompletionResult["toolCalls"]): void {
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (seen.has(call.id)) {
      throw new TypeError(`duplicate tool call id: ${call.id}`);
    }
    seen.add(call.id);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

const MAX_INVALID_JSON_RAW_CHARS = 8_000;

// 坏参数原文来自模型输出,必须限长;否则一次超长坏参数会放大日志与下一轮上下文(D-028)。
function capInvalidJsonRaw(raw: string): string {
  return raw.length > MAX_INVALID_JSON_RAW_CHARS
    ? `${raw.slice(0, MAX_INVALID_JSON_RAW_CHARS)}[truncated]`
    : raw;
}

function markerResult(raw: string): ToolResult {
  const capped = capInvalidJsonRaw(raw);
  return {
    isError: true,
    code: "invalid_json",
    message: "tool arguments are not valid JSON",
    detail: { raw: capped },
    text: `tool arguments are not valid JSON: ${capped}`,
  };
}

function abortedToolResult(): ToolResult {
  return {
    isError: true,
    code: "tool_aborted",
    message: "tool aborted before execution",
    text: "tool aborted before execution",
  };
}

function lostToolResult(): ToolResult {
  return {
    isError: true,
    code: "tool_result_lost",
    message: "tool result not recorded due to error",
    text: "tool result not recorded due to error",
  };
}


function splitToolUses(toolCalls: CompletionResult["toolCalls"]): {
  calls: BatchCall[];
  slots: CallSlot[];
} {
  const calls: BatchCall[] = [];
  const slots: CallSlot[] = toolCalls.map((call) => {
    if (isInvalidJsonMarker(call)) {
      return { marker: markerResult(call.arguments.raw) };
    }
    calls.push({ id: call.id, name: call.name, input: call.arguments });
    return { index: calls.length - 1 };
  });
  return { calls, slots };
}

function toResultPayload(
  id: string,
  toolName: string,
  result: ToolResult,
): Record<string, unknown> {
  const payload: ToolResultPayload = {
    id,
    ok: !result.isError,
    text: result.text,
    code: result.code,
    toolName,
  };
  if (result.artifactPath !== undefined) payload.artifactPath = result.artifactPath;
  if (result.detail !== undefined) payload.detail = result.detail;
  if (result.evidence !== undefined) payload.evidence = result.evidence;
  return { ...payload };
}

function toLoopToolResult(
  id: string,
  result: ToolResult,
): Extract<LoopEvent, { kind: "tool_result" }> {
  const event: Extract<LoopEvent, { kind: "tool_result" }> = {
    kind: "tool_result",
    id,
    ok: !result.isError,
    text: result.text,
    code: result.code,
  };
  if (result.artifactPath !== undefined) event.artifactPath = result.artifactPath;
  if (result.detail !== undefined) event.detail = result.detail;
  return event;
}

async function* emitInterrupted(
  session: SessionHandle,
  reason: InterruptReason,
): AsyncGenerator<LoopEvent> {
  await session.append({ type: "interrupted", payload: { reason } });
  yield { kind: "interrupted", reason };
  yield { kind: "done", finishReason: reason };
}

// checkpoint.turn 必须在会话内单调递增;resume 后从最后一条 checkpoint 续编,
// 否则同一目录会出现重复 turn,未来按 turn 定位断点会歧义(D-045)。
function lastCheckpointTurn(session: SessionHandle): number {
  const events = session.events();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "checkpoint") continue;
    const turn = event.payload.turn;
    if (typeof turn === "number" && Number.isFinite(turn) && turn >= 0) {
      return turn;
    }
  }
  return 0;
}

export async function* query(
  ctx: LoopCtx,
  input: string,
  cfg: LoopConfig,
): AsyncGenerator<LoopEvent> {
  const { session } = ctx;
  const initialEvents = session.events();
  if (
    ctx.systemPrompt !== undefined &&
    !initialEvents.some((event) => event.type === "system")
  ) {
    if (initialEvents.length > 0) {
      throw new Error(
        "ctx.systemPrompt cannot be inserted into a non-empty session without a system event",
      );
    }
    await session.append({ type: "system", payload: { content: ctx.systemPrompt } });
  }
  await session.append({ type: "user", payload: { content: input } });


  const costTracked = ctx.pricePerMillion !== undefined;
  let turn = lastCheckpointTurn(session);
  let costUsd = computeCostUsd(session.usageTotals(), ctx.pricePerMillion);
  let pending: PendingBatch | undefined;
  let exitReason: ExitReason | undefined;

  const removePending = (id: string): void => {
    if (pending === undefined) return;
    const calls = pending.calls.filter((call) => call.id !== id);
    pending = calls.length === 0
      ? undefined
      : { assistantSeq: pending.assistantSeq, calls };
  };

  // 第一阶段:先让所有 tool_result 落盘,并立即把对应 call 移出 pending 账本。
  // 第二阶段再写状态事件;即使状态写入失败,pending 已空,不会把已执行的真实结果
  // 误补成 tool_result_lost。
  const appendToolResult = async (
    call: CompletionResult["toolCalls"][number],
    result: ToolResult,
    parent: number,
  ): Promise<void> => {
    await session.append({
      type: "tool_result",
      payload: toResultPayload(call.id, call.name, result),
      parent,
    });
    removePending(call.id);
  };

  const appendDeviceStatus = async (
    call: CompletionResult["toolCalls"][number],
    result: ToolResult,
    parent: number,
  ): Promise<void> => {
    if (result.isError) return;
    if (result.deviceStatus !== undefined) {
      await session.append({
        type: "device_status",
        payload: {
          callId: call.id,
          server: result.deviceStatus.server,
          tool: call.name,
          state: result.deviceStatus.state,
        },
        parent,
      });
      return;
    }
    if (result.deviceStatusInvalid !== undefined) {
      await session.append({
        type: "status",
        payload: {
          status: "device_status_invalid",
          tool: call.name,
          message: result.deviceStatusInvalid,
        },
        parent,
      });
    }
  };

  try {
    while (true) {
      turn += 1;
      if (ctx.signal.aborted) {
        exitReason = "normal";
        yield* emitInterrupted(session, "aborted");
        return;
      }

      try {
        assertBreakers(cfg, turn, costUsd, costTracked);
      } catch (error) {
        if (error instanceof LoopBroke) {
          exitReason = "normal";
          yield* emitInterrupted(session, error.reason);
          return;
        }
        throw error;
      }

      await session.append({ type: "checkpoint", payload: { turn } });

      let messages = buildMessages(session.events());
      const budget = ctx.budget(messages);
      if (budget.over && ctx.compactor !== undefined) {
        try {
          await ctx.compactor(session);
        } catch (error) {
          if (isAbortError(error) || ctx.signal.aborted) {
            exitReason = "normal";
            yield* emitInterrupted(session, "aborted");
            return;
          }
          throw error;
        }
        yield { kind: "compacted" };
        messages = buildMessages(session.events());
        costUsd = computeCostUsd(session.usageTotals(), ctx.pricePerMillion);
      }

      let response: CompletionResult;
      const toolSchemas = toModelToolSchemas(ctx.tools.all());
      // 增量文本先落盘再被投影：会话日志是唯一事实源，实时事件不允许绕过它。
      // 完整内容仍由随后的 `assistant` 事件承载，所以写失败不终止这一轮。
      const deltaWriter = createAssistantDeltaWriter({
        session,
        onError: () => {
          // 增量丢失只影响流式显示，完整内容仍在 assistant 事件里。
        },
      });
      try {
        response = await ctx.model.complete(messages, toolSchemas, {
          signal: ctx.signal,
          maxOutputTokens: ctx.modelCfg.maxOutput,
          onDelta: (text) => deltaWriter.push(text),
        });
      } catch (error) {
        await deltaWriter.flush();
        if (isAbortError(error) || ctx.signal.aborted) {
          exitReason = "normal";
          yield* emitInterrupted(session, "aborted");
          return;
        }
        throw error;
      }
      await deltaWriter.flush();

      assertUniqueToolCallIds(response.toolCalls);
      const assistantEvent = await session.append({
        type: "assistant",
        payload: { content: response.content, toolCalls: response.toolCalls },
      });
      if (response.toolCalls.length > 0) {
        pending = { assistantSeq: assistantEvent.seq, calls: response.toolCalls.slice() };
      }

      if (response.usage !== undefined) {
        const usage = response.usage;
        const normalized = normalizeUsage(usage);
        const payload: Record<string, unknown> = {
          promptTokens: normalized.promptTokens,
          completionTokens: normalized.completionTokens,
        };
        if (normalized.cachedTokens !== undefined) {
          payload.cachedTokens = normalized.cachedTokens;
        }
        // Occupancy is measured on the transcript as it now stands: the
        // assistant turn is already appended, so this is what the next request
        // would carry. Without it the UI can only show spend, never how full
        // the window is (D-165).
        try {
          const measured = ctx.budget(buildMessages(session.events()));
          // A zero measurement is not "an empty context" — it is a transcript
          // the meter could not read. Reporting it would paint a 0% window.
          if (measured.tokens > 0 && ctx.modelCfg.contextWindow > 0) {
            payload.context = {
              tokens: measured.tokens,
              // One decimal keeps small movements visible; the UI rounds for
              // display but the event is the fact.
              percent: Math.min(
                100,
                Math.round((measured.tokens / ctx.modelCfg.contextWindow) * 1000) / 10,
              ),
              window: ctx.modelCfg.contextWindow,
            };
          }
        } catch {
          // A usage figure the meter cannot measure must not fail the turn:
          // occupancy is display data, the usage event is the audit record.
        }
        if (normalized.cachedTokensRaw !== undefined) {
          payload.cachedTokensRaw = normalized.cachedTokensRaw;
        }
        costUsd += computeCostUsd(usage, ctx.pricePerMillion);
        // `computeCostUsd` returns 0 when no price is configured, and zero
        // dollars is a different claim from "no price known". The field only
        // travels when the provider actually carries a price.
        if (ctx.pricePerMillion !== undefined) payload.costUsd = costUsd;
        await session.append({ type: "usage", payload });
        ctx.meter?.observe(normalized.promptTokens, messages);
      } else {
        await session.append({ type: "status", payload: { status: "usage_missing" } });
      }

      yield { kind: "model_message", content: response.content };
      for (const call of response.toolCalls) {
        yield { kind: "tool_use", id: call.id, name: call.name, input: call.arguments };
      }

      if (ctx.signal.aborted) {
        for (const call of response.toolCalls) {
          const result = abortedToolResult();
          await appendToolResult(call, result, assistantEvent.seq);
          yield toLoopToolResult(call.id, result);
        }
        pending = undefined;
        exitReason = "normal";
        yield* emitInterrupted(session, "aborted");
        return;
      }

      if (response.toolCalls.length === 0) {
        if (response.truncatedByMaxTokens) continue;
        await session.append({
          type: "status",
          payload: { status: "done", finishReason: "no_tool_calls" },
        });
        exitReason = "normal";
        yield { kind: "done", finishReason: "no_tool_calls" };
        return;
      }

      const split = splitToolUses(response.toolCalls);
      const batchOptions: BatchOptions = {
        signal: ctx.signal,
        artifactDir: ctx.artifactDir,
        ...(ctx.cwd === undefined ? {} : { cwd: ctx.cwd }),
        ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
        // 由 pipeline 在每个调用真正执行前调用;写失败会让该调用不执行。
        onToolStarted: async (call, access) => {
          const payload: ToolStartedPayload = {
            callId: call.id,
            tool: call.name,
            access,
          };
          await session.append({
            type: "tool_started",
            payload: { ...payload },
            parent: assistantEvent.seq,
          });
        },
      };
      if (ctx.permissionGate !== undefined) {
        const gate = ctx.permissionGate;
        batchOptions.permission = {
          gate,
          onDecision: async (call, decision) => {
            const payload: PermissionDecisionPayload = {
              requestId: decision.requestId,
              callId: decision.callId,
              tool: decision.tool,
              action: decision.action,
              effective: decision.effective,
              reason: decision.reason,
              preset: decision.preset,
              source: decision.source,
              ...(decision.ruleIndex === undefined ? {} : { ruleIndex: decision.ruleIndex }),
              paramsDigest: decision.paramsDigest,
              paramsKeys: decision.paramsKeys,
              ...(decision.paramsPreview === undefined
                ? {}
                : { paramsPreview: decision.paramsPreview }),
              access: decision.access,
            };
            await session.append({
              type: "permission_decision",
              payload: { ...payload },
              parent: assistantEvent.seq,
            });
          },
        };
      }
      const batchResults: BatchResult[] =
        split.calls.length === 0
          ? []
          : await executeBatch(session, ctx.tools, split.calls, batchOptions);

      const outcomes: Array<{
        call: CompletionResult["toolCalls"][number];
        result: ToolResult;
      }> = [];
      for (let index = 0; index < response.toolCalls.length; index += 1) {
        const call = response.toolCalls[index];
        const slot = split.slots[index];
        const result = "marker" in slot ? slot.marker : batchResults[slot.index].result;
        await appendToolResult(call, result, assistantEvent.seq);
        outcomes.push({ call, result });
        yield toLoopToolResult(call.id, result);
      }
      for (const outcome of outcomes) {
        await appendDeviceStatus(outcome.call, outcome.result, assistantEvent.seq);
      }
      pending = undefined;

      if (response.truncatedByMaxTokens) continue;
    }
  } catch (error) {
    exitReason = "error";
    if (pending !== undefined) {
      const pendingCalls = pending.calls.slice();
      const parent = pending.assistantSeq;
      for (const call of pendingCalls) {
        try {
          await appendToolResult(call, lostToolResult(), parent);
        } catch {}
      }
      pending = undefined;
    }
    try {
      await session.append({ type: "interrupted", payload: { reason: "error" } });
    } catch {}
    throw error;
  } finally {
    if (exitReason === undefined) {
      if (pending !== undefined) {
        const pendingCalls = pending.calls.slice();
        const parent = pending.assistantSeq;
        for (const call of pendingCalls) {
          try {
            await appendToolResult(call, abortedToolResult(), parent);
          } catch {}
        }
        pending = undefined;
      }
      try {
        await session.append({ type: "interrupted", payload: { reason: "consumer_closed" } });
      } catch {}
    }
  }
}
