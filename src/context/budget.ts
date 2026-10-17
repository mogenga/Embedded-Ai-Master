import type { ModelChatMessage } from "../model/protocol.js";
import { heuristicCountTokens } from "../model/count.js";

export function checkBudget(
  messages: ModelChatMessage[],
  contextWindow: number,
): { over: boolean; tokens: number; softLimit: number } {
  const tokens = heuristicCountTokens(messages);
  const softLimit = Math.floor(contextWindow * 0.8);

  return { over: tokens > softLimit, tokens, softLimit };
}
