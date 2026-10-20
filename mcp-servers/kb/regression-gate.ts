export interface RegressionBaseline {
  index: { total: number; recallAt2: number; hitAt1: number; mrr: number }
  search: { total: number; hitAt1: number; goldInTop20: number }
  negatives: { total: number; refusalRate: number }
}

export interface RegressionFailure {
  metric: string
  expected?: number
  actual?: number
}

export interface RegressionGateResult {
  ok: boolean
  failures: RegressionFailure[]
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

function readBaselineNumber(baseline: unknown, path: readonly string[]): number | undefined {
  return readNumber(baseline, path)
}

function compareMetric(
  failures: RegressionFailure[],
  report: unknown,
  baseline: unknown,
  metric: string,
  path: readonly string[],
): void {
  const expected = readBaselineNumber(baseline, path)
  if (expected === undefined) {
    failures.push({ metric: `invalid_baseline:${metric}` })
    return
  }
  const actual = readNumber(report, path)
  if (actual === undefined) {
    failures.push({ metric: `invalid_report:${metric}`, expected })
    return
  }
  if (actual < expected - EPSILON) {
    failures.push({ metric, expected, actual })
  }
}

function compareTotal(
  failures: RegressionFailure[],
  report: unknown,
  baseline: unknown,
  track: string,
): void {
  compareMetric(failures, report, baseline, `${track}.total`, [track, 'total'])
}

export function compareRegression(report: unknown, baseline: RegressionBaseline): RegressionGateResult {
  if (!isRecord(report)) {
    return { ok: false, failures: [{ metric: 'invalid_report' }] }
  }

  const failures: RegressionFailure[] = []
  for (const track of ['index', 'search', 'negatives'] as const) {
    compareTotal(failures, report, baseline, track)
  }
  compareMetric(failures, report, baseline, 'index.recallAt2', ['index', 'recallAt2'])
  compareMetric(failures, report, baseline, 'index.hitAt1', ['index', 'hitAt1'])
  compareMetric(failures, report, baseline, 'index.mrr', ['index', 'mrr'])
  compareMetric(failures, report, baseline, 'search.hitAt1', ['search', 'hitAt1'])
  compareMetric(failures, report, baseline, 'search.goldInTop20', ['search', 'goldInTop20'])
  compareMetric(failures, report, baseline, 'negatives.refusalRate', ['negatives', 'refusalRate'])

  return { ok: failures.length === 0, failures }
}