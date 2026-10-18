import type { ModelCfg } from "../config/providers.js";
import { buildMessages } from "../context/build.js";
import type {
  CompletionResult,
  ModelChatMessage,
  ModelProtocol,
} from "../model/protocol.js";
import type { SessionHandle } from "../session/session.js";
import type { ToolResultPayload } from "../session/types.js";
import { executeBatch } from "../tools/pipeline.js";
import type { BatchCall, BatchResult } from "../tools/pipeline.js";
import { toModelToolSchemas } from "../tools/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import type { BreakerLimits, PricePerMillion } from "./breakers.js";
import { assertBreakers, computeCostUsd, LoopBroke } from "./breakers.js";
import type { LoopEvent, LoopFinishReason } from "./events.js";

export interface LoopCtx {
  session: SessionHandle;
  model: ModelProtocol;
  modelCfg: ModelCfg;
  tools: ToolRegistry;
  budget: (messages: ModelChatMessage[]) => { over: boolean; tokens: number; softLimit: number };
  compactor?: (session: SessionHandle) => Promise<void>;
  signal: AbortSignal;
  artifactDir: string;
  cwd?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  pricePerMillion?: PricePerMillion;
}

export interface LoopConfig extends BreakerLimits {}

interface InvalidJsonMarker {
  error: "invalid_json";
  raw: string;
}

type CallSlot = { marker: ToolResult } | { index: number };

type InterruptReason = Exclude<LoopFinishReason, "no_tool_calls">;

interface PendingBatch {
  assistantSeq: number;
  calls: CompletionResult["toolCalls"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInvalidJsonMarker(value: unknown): value is InvalidJsonMarker {
  return isRecord(value) && value.error === "invalid_json" && typeof value.raw === "string";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function markerResult(raw: string): ToolResult {
  return {
    isError: true,
    code: "invalid_json",
    message: "tool arguments are not valid JSON",
    detail: { raw },
    text: `tool arguments are not valid JSON: ${raw}`,
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

function consumePending(pending: PendingBatch | undefined): PendingBatch | undefined {
  if (pending === undefined) return undefined;
  const calls = pending.calls.slice(1);
  return calls.length === 0 ? undefined : { assistantSeq: pending.assistantSeq, calls };
}

function splitToolUses(toolCalls: CompletionResult["toolCalls"]): {
  calls: BatchCall[];
  slots: CallSlot[];
} {
  const calls: BatchCall[] = [];
  const slots: CallSlot[] = toolCalls.map((call) => {
    if (isInvalidJsonMarker(call.arguments)) {
      return { marker: markerResult(call.arguments.raw) };
    }
    calls.push({ id: call.id, name: call.name, input: call.arguments });
    return { index: calls.length - 1 };
  });
  return { calls, slots };
}

function toResultPayload(id: string, result: ToolResult): Record<string, unknown> {
  const payload: ToolResultPayload = {
    id,
    ok: !result.isError,
    text: result.text,
    code: result.code,
  };
  if (result.artifactPath !== undefined) payload.artifactPath = result.artifactPath;
  if (result.detail !== undefined) payload.detail = result.detail;
  return { ...payload };
}

async function* emitInterrupted(
  session: SessionHandle,
  reason: InterruptReason,
): AsyncGenerator<LoopEvent> {
  await session.append({ type: "interrupted", payload: { reason } });
  yield { kind: "interrupted", reason };
  yield { kind: "done", finishReason: reason };
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

  const toolSchemas = toModelToolSchemas(ctx.tools.all());
  const costTracked = ctx.pricePerMillion !== undefined;
  let turn = 0;
  let costUsd = 0;
  let pending: PendingBatch | undefined;

  try {
    while (true) {
      turn += 1;
      if (ctx.signal.aborted) {
        yield* emitInterrupted(session, "aborted");
        return;
      }

      try {
        assertBreakers(cfg, turn, costUsd, costTracked);
      } catch (error) {
        if (error instanceof LoopBroke) {
          yield* emitInterrupted(session, error.reason);
          return;
        }
        throw error;
      }

      let messages = buildMessages(session.events());
      const budget = ctx.budget(messages);
      if (budget.over && ctx.compactor !== undefined) {
        await ctx.compactor(session);
        yield { kind: "compacted" };
        messages = buildMessages(session.events());
      }

      let response: CompletionResult;
      try {
        response = await ctx.model.complete(messages, toolSchemas, {
          signal: ctx.signal,
          maxOutputTokens: ctx.modelCfg.maxOutput,
        });
      } catch (error) {
        if (isAbortError(error) || ctx.signal.aborted) {
          yield* emitInterrupted(session, "aborted");
          return;
        }
        throw error;
      }

      const assistantEvent = await session.append({
        type: "assistant",
        payload: { content: response.content, toolCalls: response.toolCalls },
      });
      if (response.toolCalls.length > 0) {
        pending = { assistantSeq: assistantEvent.seq, calls: response.toolCalls.slice() };
      }
      yield { kind: "model_message", content: response.content };
      for (const call of response.toolCalls) {
        yield { kind: "tool_use", id: call.id, name: call.name, input: call.arguments };
      }

      if (response.usage !== undefined) {
        const usage = response.usage;
        await session.append({
          type: "usage",
          payload: {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            ...(usage.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
          },
        });
        costUsd += computeCostUsd(usage, ctx.pricePerMillion);
      }

      if (ctx.signal.aborted) {
        for (const call of response.toolCalls) {
          const result = abortedToolResult();
          await session.append({
            type: "tool_result",
            payload: toResultPayload(call.id, result),
            parent: assistantEvent.seq,
          });
          pending = consumePending(pending);
          yield { kind: "tool_result", id: call.id, ok: false, text: result.text };
        }
        pending = undefined;
        yield* emitInterrupted(session, "aborted");
        return;
      }

      if (response.toolCalls.length === 0) {
        if (response.truncatedByMaxTokens) continue;
        await session.append({
          type: "status",
          payload: { status: "done", finishReason: "no_tool_calls" },
        });
        yield { kind: "done", finishReason: "no_tool_calls" };
        return;
      }

      const split = splitToolUses(response.toolCalls);
      const batchResults: BatchResult[] =
        split.calls.length === 0
          ? []
          : await executeBatch(session, ctx.tools, split.calls, {
              signal: ctx.signal,
              artifactDir: ctx.artifactDir,
              cwd: ctx.cwd,
              timeoutMs: ctx.timeoutMs,
            });

      for (let index = 0; index < response.toolCalls.length; index += 1) {
        const call = response.toolCalls[index];
        const slot = split.slots[index];
        const result = "marker" in slot ? slot.marker : batchResults[slot.index].result;
        await session.append({
          type: "tool_result",
          payload: toResultPayload(call.id, result),
          parent: assistantEvent.seq,
        });
        pending = consumePending(pending);
        yield { kind: "tool_result", id: call.id, ok: !result.isError, text: result.text };
      }
      pending = undefined;

      if (response.truncatedByMaxTokens) continue;
    }
  } finally {
    if (pending !== undefined) {
      for (const call of pending.calls) {
        await session.append({
          type: "tool_result",
          payload: toResultPayload(call.id, abortedToolResult()),
          parent: pending.assistantSeq,
        });
      }
      await session.append({ type: "interrupted", payload: { reason: "consumer_closed" } });
      pending = undefined;
    }
  }
}
