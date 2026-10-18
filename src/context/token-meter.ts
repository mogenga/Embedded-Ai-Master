import type { ModelChatMessage } from "../model/protocol.js";

export interface TokenMeter {
  measure(messages: ModelChatMessage[]): number;
  observe(promptTokens: number, messages: ModelChatMessage[]): void;
  ratio(): number;
}

export function createTokenMeter(
  heuristic: (messages: ModelChatMessage[]) => number,
): TokenMeter {
  let ratio = 1;

  return {
    measure(messages) {
      return Math.ceil(heuristic(messages) * ratio);
    },
    observe(promptTokens, messages) {
      if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
        return;
      }

      const raw = promptTokens / Math.max(1, heuristic(messages));
      const clamped = Math.min(2, Math.max(0.5, raw));
      ratio = 0.5 * ratio + 0.5 * clamped;
    },
    ratio() {
      return ratio;
    },
  };
}