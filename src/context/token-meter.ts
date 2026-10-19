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
  const rawHeuristic = (messages: ModelChatMessage[]): number => {
    const value = heuristic(messages);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };

  return {
    measure(messages) {
      return Math.ceil(rawHeuristic(messages) * ratio);
    },
    observe(promptTokens, messages) {
      if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
        return;
      }

      const raw = promptTokens / Math.max(1, rawHeuristic(messages));
      const clamped = Math.min(2, Math.max(0.5, raw));
      ratio = 0.5 * ratio + 0.5 * clamped;
    },
    ratio() {
      return ratio;
    },
  };
}