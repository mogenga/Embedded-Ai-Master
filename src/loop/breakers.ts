export type BreakReason = "max_turns" | "max_cost_usd";

export interface BreakerLimits {
  maxTurns: number;
  maxCostUsd?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export interface PricePerMillion {
  input: number;
  output: number;
  cachedInput?: number;
}

export class LoopBroke extends Error {
  readonly reason: BreakReason;

  constructor(reason: BreakReason) {
    super(`loop breaker tripped: ${reason}`);
    this.name = "LoopBroke";
    this.reason = reason;
  }
}

export function assertBreakers(
  cfg: BreakerLimits,
  turn: number,
  costUsd: number,
  costTracked = true,
): void {
  if (turn > cfg.maxTurns) throw new LoopBroke("max_turns");
  if (cfg.maxCostUsd !== undefined && costTracked && costUsd >= cfg.maxCostUsd) {
    throw new LoopBroke("max_cost_usd");
  }
}

export function computeCostUsd(usage: TokenUsage, price?: PricePerMillion): number {
  if (price === undefined) return 0;
  const rawCached = usage.cachedTokens ?? 0;
  const cached = Math.min(Math.max(rawCached, 0), usage.promptTokens);
  const uncached = usage.promptTokens - cached;
  const cachedPrice = price.cachedInput ?? price.input;
  return (uncached * price.input + cached * cachedPrice + usage.completionTokens * price.output) / 1_000_000;
}
