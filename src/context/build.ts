import type { ModelChatMessage } from "../model/protocol.js";
import type { SessionEvent } from "../session/types.js";
import { elidedContent } from "./microcompact.js";

interface InvalidJsonMarker {
  error: "invalid_json";
  raw: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 与 query 的分流条件一致: 必须显式 invalidJson=true 才按 marker 回填 raw(D-038)
function isInvalidJsonMarker(value: unknown): value is InvalidJsonMarker {
  return isRecord(value) && value.error === "invalid_json" && typeof value.raw === "string";
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

function projectAssistant(
  payload: Record<string, unknown>,
  seq: number,
): ModelChatMessage {
  const content = requireString(payload.content, `assistant event ${seq} content`);
  const toolCalls = payload.toolCalls;
  if (!Array.isArray(toolCalls)) {
    throw new TypeError(`assistant event ${seq} toolCalls must be an array`);
  }

  return {
    role: "assistant",
    content,
    tool_calls: toolCalls.map((raw, index) => {
      const field = `assistant event ${seq} toolCalls[${index}]`;
      if (!isRecord(raw)) {
        throw new TypeError(`${field} must be an object`);
      }
      const id = requireString(raw.id, `${field}.id`);
      const name = requireString(raw.name, `${field}.name`);
      const args = raw.arguments;
      let serialized: string;
      if (raw.invalidJson === true && isInvalidJsonMarker(args)) {
        // 双层防御:query 落日志前已限长;投影层再兜底旧日志或外部构造事件(D-028)。
        serialized = args.raw.length > MAX_INVALID_JSON_RAW_CHARS
          ? `${args.raw.slice(0, MAX_INVALID_JSON_RAW_CHARS)}[truncated]`
          : args.raw;
      } else if (isRecord(args)) {
        serialized = JSON.stringify(args);
      } else {
        throw new TypeError(`${field}.arguments must be an object or invalid_json marker`);
      }
      return { id, type: "function" as const, function: { name, arguments: serialized } };
    }),
  };
}

const MAX_INVALID_JSON_RAW_CHARS = 8_000;

interface ActiveBatch {
  assistantSeq: number;
  remaining: string[];
  seen: Set<string>;
}

interface SummaryDirective {
  summary: string;
  coversUpToSeq: number;
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

function summaryBoundaryComplete(
  events: readonly SessionEvent[],
  coversUpToSeq: number,
): boolean {
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    if (event.seq <= coversUpToSeq) continue;
    if (event.parent !== undefined && event.parent <= coversUpToSeq) return false;
  }
  return true;
}

function summaryCoversEvidence(
  events: readonly SessionEvent[],
  coversUpToSeq: number,
): boolean {
  for (const event of events) {
    if (event.type !== "tool_result" || event.payload.evidence !== true) continue;
    if (event.seq <= coversUpToSeq) return true;
  }
  return false;
}

function toSummaryDirective(
  events: readonly SessionEvent[],
  index: number,
  lastSeq: number,
): SummaryDirective | undefined {
  const event = events[index];
  const summary = event.payload.summary;
  const coversUpToSeq = event.payload.coversUpToSeq;
  if (typeof summary !== "string" || summary.trim() === "") return undefined;
  if (
    typeof coversUpToSeq !== "number"
    || !Number.isInteger(coversUpToSeq)
    || coversUpToSeq < 0
    || coversUpToSeq > lastSeq
    || coversUpToSeq >= event.seq
  ) {
    return undefined;
  }
  if (!summaryBoundaryComplete(events, coversUpToSeq)) return undefined;
  if (summaryCoversEvidence(events, coversUpToSeq)) return undefined;
  return { summary, coversUpToSeq };
}

function findEffectiveSummary(events: readonly SessionEvent[]): SummaryDirective | undefined {
  const lastSeq = events.length === 0 ? -1 : events[events.length - 1].seq;
  let accepted: SummaryDirective | undefined;
  let lastBoundary = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "compaction" || event.payload.kind !== "summary") continue;
    const valid = toSummaryDirective(events, index, lastSeq);
    if (valid === undefined || valid.coversUpToSeq < lastBoundary) continue;
    accepted = valid;
    lastBoundary = valid.coversUpToSeq;
  }
  return accepted;
}

export function buildMessages(events: readonly SessionEvent[]): ModelChatMessage[] {
  const bySeq = new Map<number, SessionEvent>();
  let previousSeq: number | undefined;
  for (const event of events) {
    if (previousSeq !== undefined && event.seq <= previousSeq) {
      throw new TypeError(
        `session event seq must be strictly increasing: ${event.seq} after ${previousSeq}`,
      );
    }
    previousSeq = event.seq;
    bySeq.set(event.seq, event);
  }

  const messages: ModelChatMessage[] = [];
  const elidedSeqs = collectElidedSeqs(events);
  const effectiveSummary = findEffectiveSummary(events);
  const projected =
    effectiveSummary === undefined
      ? events
      : events.filter(
          (event) =>
            event.type === "system" || event.seq > effectiveSummary.coversUpToSeq,
        );

  let activeBatch: ActiveBatch | undefined;
  for (const event of projected) {
    if (
      activeBatch !== undefined &&
      (event.type === "user" || event.type === "system" || event.type === "assistant")
    ) {
      throw new TypeError(
        `tool batch for assistant event ${activeBatch.assistantSeq} is incomplete; ${event.type} event ${event.seq} cannot appear`,
      );
    }
    switch (event.type) {
      case "system": {
        if (messages.some((message) => message.role !== "system")) {
          throw new TypeError(
            `system event ${event.seq} must appear before non-system messages`,
          );
        }
        messages.push({
          role: "system",
          content: requireString(event.payload.content, `system event ${event.seq} content`),
        });
        break;
      }
      case "user": {
        messages.push({
          role: "user",
          content: requireString(event.payload.content, `user event ${event.seq} content`),
        });
        break;
      }
      case "assistant": {
        const message = projectAssistant(event.payload, event.seq);
        messages.push(message);
        const ids = message.tool_calls?.map((call) => call.id) ?? [];
        if (ids.length > 0) {
          const seen = new Set<string>();
          for (const id of ids) {
            if (seen.has(id)) {
              throw new TypeError(
                `assistant event ${event.seq} has duplicate tool call id ${id}`,
              );
            }
            seen.add(id);
          }
          activeBatch = {
            assistantSeq: event.seq,
            remaining: ids.slice(),
            seen: new Set(),
          };
        }
        break;
      }
      case "tool_result": {
        const id = requireString(event.payload.id, `tool_result event ${event.seq} id`);
        const text = requireString(event.payload.text, `tool_result event ${event.seq} text`);
        if (event.parent === undefined) {
          throw new TypeError(`tool_result event ${event.seq} must have a parent`);
        }
        if (event.parent >= event.seq) {
          throw new TypeError(
            `tool_result event ${event.seq} parent ${event.parent} must precede it`,
          );
        }
        const parent = bySeq.get(event.parent);
        if (parent === undefined) {
          throw new TypeError(`tool_result event ${event.seq} parent ${event.parent} not found`);
        }
        if (parent.type !== "assistant") {
          throw new TypeError(
            `tool_result event ${event.seq} parent ${event.parent} must be an assistant event`,
          );
        }
        const parentCalls = parent.payload.toolCalls;
        if (
          !Array.isArray(parentCalls) ||
          !parentCalls.some((call) => isRecord(call) && call.id === id)
        ) {
          throw new TypeError(
            `tool_result event ${event.seq} id ${id} not found in parent ${event.parent} toolCalls`,
          );
        }
        if (activeBatch === undefined) {
          throw new TypeError(`tool_result event ${event.seq} has no active tool batch`);
        }
        if (event.parent !== activeBatch.assistantSeq) {
          throw new TypeError(
            `tool_result event ${event.seq} parent ${event.parent} does not match active tool batch ${activeBatch.assistantSeq}`,
          );
        }
        if (activeBatch.seen.has(id)) {
          throw new TypeError(`tool_result event ${event.seq} duplicate id ${id}`);
        }
        const index = activeBatch.remaining.indexOf(id);
        if (index < 0) {
          throw new TypeError(`tool_result event ${event.seq} id ${id} not in active tool batch`);
        }
        activeBatch.remaining.splice(index, 1);
        activeBatch.seen.add(id);
        if (activeBatch.remaining.length === 0) {
          activeBatch = undefined;
        }
        const canElideEvidence =
          event.payload.evidence !== true || typeof event.payload.artifactPath === "string";
        const replacement =
          elidedSeqs.has(event.seq) && canElideEvidence
            ? elidedContent(event.payload, text)
            : undefined;
        messages.push({ role: "tool", content: replacement ?? text, tool_call_id: id });
        break;
      }
      case "tool_call":
      case "usage":
      case "checkpoint":
      case "status":
      case "interrupted":
      case "compaction": {
        break;
      }
      default: {
        throw new TypeError(`unknown session event type: ${String(event.type)}`);
      }
    }
  }
  if (activeBatch !== undefined) {
    throw new TypeError(
      `assistant event ${activeBatch.assistantSeq} has ${activeBatch.remaining.length} missing tool_result events`,
    );
  }
  if (effectiveSummary !== undefined) {
    const lastSystemIndex = messages.findLastIndex((message) => message.role === "system");
    messages.splice(lastSystemIndex + 1, 0, {
      role: "system",
      content: `[Conversation summary]\n${effectiveSummary.summary}`,
    });
  }
  return messages;
}
