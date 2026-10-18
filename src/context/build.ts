import type { ModelChatMessage } from "../model/protocol.js";
import type { SessionEvent } from "../session/types.js";

interface InvalidJsonMarker {
  error: "invalid_json";
  raw: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
      if (isInvalidJsonMarker(args)) {
        serialized = args.raw;
      } else if (isRecord(args)) {
        serialized = JSON.stringify(args);
      } else {
        throw new TypeError(`${field}.arguments must be an object or invalid_json marker`);
      }
      return { id, type: "function" as const, function: { name, arguments: serialized } };
    }),
  };
}

export function buildMessages(events: readonly SessionEvent[]): ModelChatMessage[] {
  const bySeq = new Map<number, SessionEvent>();
  for (const event of events) {
    bySeq.set(event.seq, event);
  }

  const messages: ModelChatMessage[] = [];
  for (const event of events) {
    switch (event.type) {
      case "system": {
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
        messages.push(projectAssistant(event.payload, event.seq));
        break;
      }
      case "tool_result": {
        const id = requireString(event.payload.id, `tool_result event ${event.seq} id`);
        const text = requireString(event.payload.text, `tool_result event ${event.seq} text`);
        if (event.parent === undefined) {
          throw new TypeError(`tool_result event ${event.seq} must have a parent`);
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
        messages.push({ role: "tool", content: text, tool_call_id: id });
        break;
      }
      case "usage":
      case "checkpoint":
      case "status":
      case "interrupted": {
        break;
      }
      default: {
        throw new TypeError(`unknown session event type: ${String(event.type)}`);
      }
    }
  }
  return messages;
}