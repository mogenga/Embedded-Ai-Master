import { resolveContextWindow, resolveMaxOutput } from "../config/providers.js";
import type { ModelCfg } from "../config/providers.js";
import { normalizeUsage } from "../loop/breakers.js";
import { heuristicCountTokens } from "../model/count.js";
import type { CompletionResult, ModelChatMessage, ModelProtocol } from "../model/protocol.js";
import type { SessionHandle } from "../session/session.js";
import type { SessionEvent } from "../session/types.js";
import { buildMessages } from "./build.js";
import { elidedContent } from "./microcompact.js";
import type { SystemSections } from "./system-sections.js";
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
  /**
   * 显式要求压缩：跳过软阈值提前返回，也跳过 microcompact。
   *
   * 这是 `/compact` 这类用户指令的出口——用户说「压缩」时不该被阈值挡回来。
   * 缺省 false，等价于历史上「只在超预算时才动手」的行为。
   */
  force?: boolean;
  signal: AbortSignal;
  /**
   * 投影期的系统提示词分节（不写会话日志）。
   *
   * 压缩必须看见它们：`measure()` 量的就是「这次请求会带多少」，漏掉固定前缀会
   * 低估占用、让压缩触发过晚（设计稿 §5.2）。摘要输入也走同一份投影，保证
   * 「压缩后重发的消息」与「压缩时看到的消息」口径一致。
   */
  systemSections?: SystemSections;
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

/**
 * 尾部边界的预算估算。
 *
 * **不再自己除以 4**（D-093）：裸 `/4` 与预算路径（`TokenMeter`，用真实 usage
 * 锚定过比例）是两套口径，中文日志下偏差可达数倍，结果就是「保留 16%」实际
 * 保留得远多于或远少于 16%，而压缩阈值又是按另一套口径算的。传进来的
 * `estimate` 由调用方给（有 meter 时就是 `meter.measure`），两处口径一致。
 */
function computeTailBoundary(
  events: readonly SessionEvent[],
  contextWindow: number,
  keepTailRatio: number,
  scale: number,
): number {
  const tailBudget = contextWindow * keepTailRatio;
  let accumulated = 0;
  let tailStart = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // 逐条估算，最后乘同一个比例——**不是**对每条各调一次 `meter.measure`：
    // 后者的 `Math.ceil` 会放大到每条消息上，N 条就多算 N 次舍入，尾部预算
    // 被系统性高估、边界前移，压缩该触发时不触发（实测：自定义 keepTailRatio
    // 的集成用例因此少了压缩）。
    accumulated += estimateEventTokens(events[index]) * scale;
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

/**
 * 带系统提示词分节投影日志事件。
 *
 * 分节缺省时与 `buildMessages(events)` 逐字节相同——这条捷径让「没有分节」的
 * 调用方（大多数测试与脚本）不必改，也保证行为向后兼容。
 */
function projectWith(
  sections: SystemSections | undefined,
  events: readonly SessionEvent[],
): ModelChatMessage[] {
  return sections === undefined
    ? buildMessages(events)
    : buildMessages(events, { systemSections: sections });
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
    force = false,
    signal,
    systemSections,
  } = opts;
  assertCompactionRatios(keepTailRatio, softRatio);
  assertKeepRecentTurns(keepRecentTurns);
  // contextWindow / maxOutput 在 providers.json 里是可选的：这里一次性解析成本地值，
  // 避免 undefined 参与算术得出 NaN 阈值（NaN 比较恒为 false，会让压缩静默永不触发）。
  const contextWindow = resolveContextWindow(modelCfg);
  const maxOutput = resolveMaxOutput(modelCfg);
  const softLimit = Math.floor(contextWindow * softRatio);
  const measure = () => {
    const messages = projectWith(systemSections, session.events());
    return { messages, tokens: measureWith(meter, messages) };
  };

  let current = measure();
  // force 跳过软阈值：用户显式要压缩时，「还没到阈值」不是拒绝的理由。
  if (!force && current.tokens <= softLimit) return;

  const events = session.events();
  const boundary = lastSummaryBoundary(events);
  const elided = collectElidedSeqs(events);
  const recent = recentBatchParents(events, keepRecentTurns);
  const candidates: number[] = [];
  // force 时整个 microcompact 阶段都跳过：它是「超预算时先廉价回收」的手段，
  // 把工具结果悄悄换成一行标记就收工。用户显式要求压缩，要的是一份摘要，
  // 不是一次静默替换——所以连候选都不必找。
  if (!force) {
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
  // 尾部边界的尺子与预算路径一致（D-093）：`meter.ratio()` 是 usage 锚定出来的
  // 全局比例，套在同一条启发式估算上。没有 meter 时比例就是 1，与压缩前的
  // 行为逐字节相同。
  let coversUpToSeq = computeTailBoundary(
    latest,
    contextWindow,
    keepTailRatio,
    meter?.ratio() ?? 1,
  );
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
    prefixMessages = projectWith(systemSections, prefix);
  } catch (error) {
    await session.append({
      type: "compaction",
      payload: { kind: "failed", reason: failureReason(error), stage: "summary" },
    });
    return;
  }

  const maxChars = Math.floor(contextWindow * 0.6 * 4);
  const transcript = truncateSurrogateSafe(toTranscript(prefixMessages), maxChars);

  let result: CompletionResult;
  try {
    result = await model.complete(
      [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: transcript },
      ],
      [],
      { signal, maxOutputTokens: Math.min(2048, maxOutput) },
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
    const latestEvents = session.events();
    const boundary = lastSummaryBoundary(latestEvents);
    const elidedNow = collectElidedSeqs(latestEvents);
    const emergencyCandidates: number[] = [];
    for (const event of latestEvents) {
      if (event.type !== "tool_result") continue;
      if (
        event.payload.evidence === true
        && typeof event.payload.artifactPath !== "string"
      ) {
        continue;
      }
      if (elidedNow.has(event.seq)) continue;
      if (boundary !== undefined && event.seq <= boundary) continue;
      const text = event.payload.text;
      if (typeof text !== "string" || elidedContent(event.payload, text) === undefined) {
        continue;
      }
      emergencyCandidates.push(event.seq);
    }
    if (emergencyCandidates.length > 0) {
      await session.append({
        type: "compaction",
        payload: {
          kind: "microcompact",
          elidedSeqs: emergencyCandidates,
          note: `elided ${emergencyCandidates.length} tool results (emergency)`,
        },
      });
      if (measure().tokens <= softLimit) {
        return;
      }
    }
    await session.append({
      type: "compaction",
      payload: { kind: "failed", reason: "still_over_budget", stage: "summary" },
    });
  }
}