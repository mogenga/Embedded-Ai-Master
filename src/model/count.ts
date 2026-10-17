import type { ModelChatMessage } from "./protocol.js";

export function heuristicCountTokens(messages: ModelChatMessage[]): number {
  return messages.reduce((total, message) => total + Math.ceil(message.content.length / 4), 0);
}
