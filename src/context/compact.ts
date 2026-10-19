import type { ModelCfg } from "../config/providers.js";
import { normalizeUsage } from "../loop/breakers.js";
import { heuristicCountTokens } from "../model/count.js";
import type { CompletionResult, ModelChatMessage, ModelProtocol } from "../model/protocol.js";
import type { SessionHandle } from "../session/session.js";
import type { SessionEvent } from "../session/types.js";
import { buildMessages } from "./build.js";
import { elidedContent } from "./microcompact.js";
import { truncateSurrogateSafe } from "./text.js";
import type { TokenMeter } from "./token-meter.js";

export const SUMMARY_PROMPT =
  "Summarize the conversation for continuation. Preserve: user goals, decisions, tool evidence references, open questions, and exact identifiers. Do not invent facts. Output plain text.";

export interface CompactOptions {
  session: SessionHandle;
  model: ModelProtocol;
  modelCfg: ModelCfg;
  keepRecentTurns?: number;
  keepTailRatio?: number;
  softRatio?: number;
  meter?: TokenMeter;
  signal: AbortSignal;
}

export function assertCompactionRatios(keepTailRatio: number, softRatio: number): void {
  if (!(keepTailRatio > 0 && keepTailRatio < softRatio && softRatio < 1)) {
    throw new TypeError(
      `keepTailRatio and softRatio must satisfy 0 < keepTailRatio < softRatio < 1; got keepTailRatio=${keepTailRatio}, softRatio=${softRatio}`,
    );
  }
}

export function assertKeepRecentTurns(keepRecentTurns: number): void {
  if (!Number.isInteger(keepRecentTurns) || keepRecentTurns < 0) {
    throw new TypeError(
      `keepRecentTurns must be a finite non-negative integer; got ${keepRecentTurns}`,
    );
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function collectElidedSeqs(events: readonly SessionEvent[]): Set<number> {
  const elided = new Set<number>();
  for (const event of events) {
    if (event.type !== "compaction" || event.payload.kind !== "microcompact") continue;
    const seqs = event.payload.elidedSeqs;
    if (!Array.isArray(seqs)) continue;
    for (const seq of seqs) {
      if (Number.isInteger(seq)) elided.add(seq);
    }
  }
  return elided;
}

function lastSummaryBoundary(events: readonly SessionEvent[]): number | undefined {
  return lastSummaryEvent(events)?.coversUpToSeq;
}

interface PreviousSummary {
  seq: number;
  summary: string;
  coversUpToSeq: number;
}

function lastSummaryEvent(events: readonly SessionEvent[]): PreviousSummary | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "compaction" || event.payload.kind !== "summary") continue;
    const summary = event.payload.summary;
    const coversUpToSeq = event.payload.coversUpToSeq;
    if (typeof summary !== "string" || typeof coversUpToSeq !== "number") continue;
    return { seq: event.seq, summary, coversUpToSeq };
  }
  return undefined;
}

function recentBatchParents(
  events: readonly SessionEvent[],
  keepRecentTurns: number,
): Set<number> {
  const parents: number[] = [];
  for (const event of events) {
    if (event.type !== "assistant") continue;
    const calls = event.payload.toolCalls;
    if (Array.isArray(calls) && calls.length > 0) parents.push(event.seq);
  }
  const keep = Math.max(0, Math.floor(keepRecentTurns));
  return new Set(parents.slice(parents.length - keep));
}

function estimateEventTokens(event: SessionEvent): number {
  switch (event.type) {
    case "system":
    case "user": {
      const content = event.payload.content;
      return typeof content === "string" ? Math.ceil(content.length / 4) : 0;
    }
    case "assistant": {
      const content = typeof event.payload.content === "string" ? event.payload.content : "";
      const calls = Array.isArray(event.payload.toolCalls) ? event.payload.toolCalls : [];
      return Math.ceil((content.length + JSON.stringify(calls).length) / 4);
    }
    case "tool_result": {
      const text = typeof event.payload.text === "string" ? event.payload.text : "";
      return Math.ceil(text.length / 4);
    }
    default:
      return 0;
  }
}

function computeTailBoundary(
  events: readonly SessionEvent[],
  contextWindow: number,
  keepTailRatio: number,
): number {
  const tailBudget = contextWindow * keepTailRatio;
  let accumulated = 0;
  let tailStart = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    accumulated += estimateEventTokens(events[index]);
    if (accumulated >= tailBudget) {
      tailStart = index;
      break;
    }
    if (index === 0) tailStart = 0;
  }
  return tailStart === 0 ? -1 : events[tailStart - 1].seq;
}

function adjustSummaryBoundary(events: readonly SessionEvent[], initial: number): number {
  let boundary = initial;
  const resultsByParent = new Map<number, number>();
  for (const event of events) {
    if (event.type !== "tool_result" || event.parent === undefined) continue;
    const current = resultsByParent.get(event.parent) ?? -1;
    resultsByParent.set(event.parent, Math.max(current, event.seq));
  }
  for (const event of events) {
    if (event.type !== "tool_result" || event.payload.evidence !== true) continue;
    if (event.seq <= boundary) boundary = Math.min(boundary, event.seq - 1);
  }
  for (const event of events) {
    if (event.type !== "assistant" || event.seq > boundary) continue;
    const calls = event.payload.toolCalls;
    if (!Array.isArray(calls) || calls.length === 0) continue;
    const lastResult = resultsByParent.get(event.seq);
    if (lastResult !== undefined && lastResult > boundary) {
      boundary = Math.min(boundary, event.seq - 1);
    }
  }
  return boundary;
}

function toTranscript(messages: ModelChatMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `tool(${message.tool_call_id ?? ""}): ${message.content}`;
      }
      const calls = message.tool_calls;
      if (calls !== undefined && calls.length > 0) {
        const rendered = calls
          .map((call) => `${call.function.name}(${call.function.arguments})`)
          .join(", ");
        return `${message.role}: ${message.content} [tool calls: ${rendered}]`;
      }
      return `${message.role}: ${message.content}`;
    })
    .join("\n");
}

function measureWith(meter: TokenMeter | undefined, messages: ModelChatMessage[]): number {
  return meter === undefined ? heuristicCountTokens(messages) : meter.measure(messages);
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function compactSession(opts: CompactOptions): Promise<void> {
  const {
    session,
    model,
    modelCfg,
    keepRecentTurns = 2,
    keepTailRatio = 0.16,
    softRatio = 0.8,
    meter,
    signal,
  } = opts;
  assertCompactionRatios(keepTailRatio, softRatio);
  assertKeepRecentTurns(keepRecentTurns);
  const softLimit = Math.floor(modelCfg.contextWindow * softRatio);
  const measure = () => {
    const messages = buildMessages(session.events());
    return { messages, tokens: measureWith(meter, messages) };
  };

  let current = measure();
  if (current.tokens <= softLimit) return;

  const events = session.events();
  const boundary = lastSummaryBoundary(events);
  const elided = collectElidedSeqs(events);
  const recent = recentBatchParents(events, keepRecentTurns);
  const candidates: number[] = [];
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    if (event.payload.evidence === true) continue;
    if (event.parent !== undefined && recent.has(event.parent)) continue;
    if (elided.has(event.seq)) continue;
    if (boundary !== undefined && event.seq <= boundary) continue;
    const text = event.payload.text;
    if (typeof text !== "string" || elidedContent(event.payload, text) === undefined) continue;
    candidates.push(event.seq);
  }

  if (candidates.length > 0) {
    await session.append({
      type: "compaction",
      payload: {
        kind: "microcompact",
        elidedSeqs: candidates,
        note: `elided ${candidates.length} tool results`,
      },
    });
    current = measure();
    if (current.tokens <= softLimit) return;
  }

  const latest = session.events();
  let coversUpToSeq = computeTailBoundary(latest, modelCfg.contextWindow, keepTailRatio);
  coversUpToSeq = adjustSummaryBoundary(latest, coversUpToSeq);
  const previousSummary = lastSummaryEvent(latest);
  if (previousSummary !== undefined && coversUpToSeq <= previousSummary.seq) {
    await session.append({
      type: "compaction",
      payload: { kind: "failed", reason: "no_progress", stage: "summary" },
    });
    return;
  }
  const prefix = latest.filter((event) => event.seq <= coversUpToSeq);
  const hasContent = prefix.some(
    (event) => event.type === "user" || event.type === "assistant" || event.type === "tool_result",
  );
  if (coversUpToSeq < 0 || !hasContent) {
    await session.append({
      type: "compaction",
      payload: { kind: "failed", reason: "no summarizable content", stage: "summary" },
    });
    return;
  }

  let prefixMessages: ModelChatMessage[];
  try {
    prefixMessages = buildMessages(prefix);
  } catch (error) {
    await session.append({
      type: "compaction",
      payload: { kind: "failed", reason: failureReason(error), stage: "summary" },
    });
    return;
  }

  const maxChars = Math.floor(modelCfg.contextWindow * 0.6 * 4);
  const transcript = truncateSurrogateSafe(toTranscript(prefixMessages), maxChars);

  let result: CompletionResult;
  try {
    result = await model.complete(
      [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: transcript },
      ],
      [],
      { signal, maxOutputTokens: Math.min(2048, modelCfg.maxOutput) },
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    await session.append({
      type: "compaction",
      payload: { kind: "failed", reason: failureReason(error), stage: "summary" },
    });
    return;
  }

  if (result.content.trim() === "") {
    await session.append({
      type: "compaction",
      payload: { kind: "failed", reason: "empty summary", stage: "summary" },
    });
    return;
  }
  if (result.truncatedByMaxTokens) {
    await session.append({
      type: "compaction",
      payload: { kind: "failed", reason: "summary truncated", stage: "summary" },
    });
    return;
  }

  if (result.usage === undefined) {
    await session.append({
      type: "status",
      payload: { status: "usage_missing", stage: "summary" },
    });
  } else {
    const normalized = normalizeUsage(result.usage);
    const usage: Record<string, unknown> = {
      promptTokens: normalized.promptTokens,
      completionTokens: normalized.completionTokens,
    };
    if (normalized.cachedTokens !== undefined) {
      usage.cachedTokens = normalized.cachedTokens;
    }
    if (normalized.cachedTokensRaw !== undefined) {
      usage.cachedTokensRaw = normalized.cachedTokensRaw;
    }
    await session.append({ type: "usage", payload: usage });
  }
  await session.append({
    type: "compaction",
    payload: { kind: "summary", summary: result.content, coversUpToSeq },
  });

  const afterSummary = measure();
  if (afterSummary.tokens > softLimit) {
    await session.append({
      type: "compaction",
      payload: { kind: "failed", reason: "still_over_budget", stage: "summary" },
    });
  }
}