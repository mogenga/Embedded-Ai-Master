import type { ModelChatMessage } from "./protocol.js";

function serializedToolCallsLength(message: ModelChatMessage): number {
  const calls = message.tool_calls;
  if (calls === undefined || calls.length === 0) return 0;
  const serialized = JSON.stringify(calls);
  return typeof serialized === "string" ? serialized.length : 0;
}

export function heuristicCountTokens(messages: ModelChatMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total
      + Math.ceil((message.content.length + serializedToolCallsLength(message)) / 4),
    0,
  );
}
