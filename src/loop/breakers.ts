export type BreakReason = "max_turns" | "max_cost_usd";

export interface BreakerLimits {
  /** 本次运行的模型调用上限；缺省表示不限制轮数（没有默认上限）。 */
  maxTurns?: number;
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
  // 缺省 = 不检查轮数，而不是「检查一个默认值」。刻意没有默认上限：
  // 任何隐式上限都会在长诊断里静默截断一次本来能跑完的运行（D-183）。
  if (cfg.maxTurns !== undefined) {
    if (!Number.isFinite(cfg.maxTurns) || cfg.maxTurns < 0) {
      throw new TypeError("maxTurns must be a finite non-negative number");
    }
    if (turn > cfg.maxTurns) throw new LoopBroke("max_turns");
  }
  if (cfg.maxCostUsd !== undefined && !Number.isFinite(cfg.maxCostUsd)) {
    throw new TypeError("maxCostUsd must be a finite number");
  }
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
