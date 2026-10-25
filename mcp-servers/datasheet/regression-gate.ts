export interface DatasheetRegressionBaseline {
  queries: { total: number; recallAt2: number; hitAt1: number; mrr: number }
  negatives: { total: number; falsePositiveRate: number }
}

export interface DatasheetRegressionFailure {
  metric: string
  expected?: number
  actual?: number
}

export interface DatasheetRegressionGateResult {
  ok: boolean
  failures: DatasheetRegressionFailure[]
}

const EPSILON = 1e-9

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNumber(value: unknown, path: readonly string[]): number | undefined {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined
}

/**
 * 与 kb/regression-gate.ts 同构的比较器，方向定义不同处只有一处：
 * negatives.falsePositiveRate 是「不高于基线」（kb 的 refusalRate 是不低于）。
 * queries 三项指标必须不低于基线；查询总数必须一致（查询集变了基线要重标）。
 */
export function compareDatasheetRegression(
  report: unknown,
  baseline: DatasheetRegressionBaseline,
): DatasheetRegressionGateResult {
  if (!isRecord(report)) {
    return { ok: false, failures: [{ metric: 'invalid_report' }] }
  }
  const failures: DatasheetRegressionFailure[] = []

  const atLeast = (metric: string, path: readonly string[]): void => {
    const expected = readNumber(baseline, path)
    if (expected === undefined) {
      failures.push({ metric: `invalid_baseline:${metric}` })
      return
    }
    const actual = readNumber(report, path)
    if (actual === undefined) {
      failures.push({ metric: `invalid_report:${metric}`, expected })
      return
    }
    if (actual < expected - EPSILON) failures.push({ metric, expected, actual })
  }
  const atMost = (metric: string, path: readonly string[]): void => {
    const expected = readNumber(baseline, path)
    if (expected === undefined) {
      failures.push({ metric: `invalid_baseline:${metric}` })
      return
    }
    const actual = readNumber(report, path)
    if (actual === undefined) {
      failures.push({ metric: `invalid_report:${metric}`, expected })
      return
    }
    if (actual > expected + EPSILON) failures.push({ metric, expected, actual })
  }

  atLeast('queries.total', ['queries', 'total'])
  atLeast('queries.recallAt2', ['queries', 'recallAt2'])
  atLeast('queries.hitAt1', ['queries', 'hitAt1'])
  atLeast('queries.mrr', ['queries', 'mrr'])
  atLeast('negatives.total', ['negatives', 'total'])
  atMost('negatives.falsePositiveRate', ['negatives', 'falsePositiveRate'])

  return { ok: failures.length === 0, failures }
}