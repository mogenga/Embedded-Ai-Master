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

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  cachedTokensRaw?: number;
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
  if (!Number.isFinite(cfg.maxTurns) || cfg.maxTurns < 0) {
    throw new TypeError("maxTurns must be a finite non-negative number");
  }
  if (cfg.maxCostUsd !== undefined && !Number.isFinite(cfg.maxCostUsd)) {
    throw new TypeError("maxCostUsd must be a finite number");
  }
  if (turn > cfg.maxTurns) throw new LoopBroke("max_turns");
  if (cfg.maxCostUsd !== undefined && costTracked && costUsd >= cfg.maxCostUsd) {
    throw new LoopBroke("max_cost_usd");
  }
}

export function normalizeUsage(usage: TokenUsage): NormalizedUsage {
  const promptTokens = Number.isFinite(usage.promptTokens)
    ? Math.max(0, usage.promptTokens)
    : 0;
  const completionTokens = Number.isFinite(usage.completionTokens)
    ? Math.max(0, usage.completionTokens)
    : 0;
  if (usage.cachedTokens === undefined) {
    return { promptTokens, completionTokens };
  }
  const raw = usage.cachedTokens;
  const cachedTokens = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), promptTokens) : 0;
  const normalized: NormalizedUsage = { promptTokens, completionTokens, cachedTokens };
  if (Number.isFinite(raw) && cachedTokens !== raw) {
    normalized.cachedTokensRaw = raw;
  }
  return normalized;
}

export function computeCostUsd(usage: TokenUsage, price?: PricePerMillion): number {
  if (price === undefined) return 0;
  const normalized = normalizeUsage(usage);
  const cached = normalized.cachedTokens ?? 0;
  const uncached = normalized.promptTokens - cached;
  const cachedPrice = price.cachedInput ?? price.input;
  return (
    (uncached * price.input + cached * cachedPrice + normalized.completionTokens * price.output) /
    1_000_000
  );
}
