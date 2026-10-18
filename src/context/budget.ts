import type { ModelChatMessage } from "../model/protocol.js";
import { heuristicCountTokens } from "../model/count.js";

export function checkBudgetTokens(
  tokens: number,
  contextWindow: number,
  softRatio = 0.8,
): { over: boolean; tokens: number; softLimit: number } {
  const softLimit = Math.floor(contextWindow * softRatio);

  return { over: tokens > softLimit, tokens, softLimit };
}

export function checkBudget(
  messages: ModelChatMessage[],
  contextWindow: number,
): { over: boolean; tokens: number; softLimit: number } {
  return checkBudgetTokens(heuristicCountTokens(messages), contextWindow);
}
