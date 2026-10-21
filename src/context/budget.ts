import { resolveContextWindow } from "../config/providers.js";
import type { ModelCfg } from "../config/providers.js";
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

/**
 * 已测得 token 数时按模型配置判定：`contextWindow` 未配置则用内核估算默认值。
 *
 * 默认值兜底只在这一层做——把 `modelCfg.contextWindow ?? 128000` 撒到各调用点，
 * 会让默认值失去单一出处，且漏掉一处就会得到 NaN 阈值（比较恒为 false，压缩静默永不触发）。
 */
export function checkBudgetTokensForModel(
  tokens: number,
  modelCfg: ModelCfg,
  softRatio = 0.8,
): { over: boolean; tokens: number; softLimit: number } {
  return checkBudgetTokens(tokens, resolveContextWindow(modelCfg), softRatio);
}

/** 直接按消息估算 token 再判定；语义同 `checkBudget`，但窗口走默认值兜底。 */
export function checkBudgetForModel(
  messages: ModelChatMessage[],
  modelCfg: ModelCfg,
  softRatio = 0.8,
): { over: boolean; tokens: number; softLimit: number } {
  return checkBudgetTokensForModel(heuristicCountTokens(messages), modelCfg, softRatio);
}
