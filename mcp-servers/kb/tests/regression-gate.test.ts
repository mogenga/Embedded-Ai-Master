import { describe, expect, it } from 'vitest'

import { compareRegression } from '../regression-gate.js'
import type { RegressionBaseline } from '../regression-gate.js'

const BASELINE: RegressionBaseline = {
  index: { total: 50, recallAt2: 0.44, hitAt1: 0.38, mrr: 0.41 },
  search: { total: 30, hitAt1: 0.13333333333333333, goldInTop20: 0.43333333333333335 },
  negatives: { total: 25, refusalRate: 0.84 },
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    index: { total: 50, recallAt2: 0.44, hitAt1: 0.38, mrr: 0.41 },
    search: { total: 30, hitAt1: 0.13333333333333333, goldInTop20: 0.43333333333333335 },
    negatives: { total: 25, refusalRate: 0.84 },
    ...overrides,
  }
}

describe('compareRegression', () => {
  it('等于基线时通过', () => {
    expect(compareRegression(report(), BASELINE)).toEqual({ ok: true, failures: [] })
  })

  it('指标提升时通过', () => {
    const result = compareRegression(
      report({
        index: { total: 50, recallAt2: 0.5, hitAt1: 0.4, mrr: 0.45 },
        negatives: { total: 25, refusalRate: 0.88 },
      }),
      BASELINE,
    )
    expect(result.ok).toBe(true)
  })

  it('单项指标下降时失败并指出指标', () => {
    const result = compareRegression(
      report({ index: { total: 50, recallAt2: 0.43, hitAt1: 0.38, mrr: 0.41 } }),
      BASELINE,
    )
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([
      { metric: 'index.recallAt2', expected: 0.44, actual: 0.43 },
    ])
  })

  it('总数变化时失败', () => {
    const result = compareRegression(
      report({ search: { total: 29, hitAt1: 0.14, goldInTop20: 0.44 } }),
      BASELINE,
    )
    expect(result.ok).toBe(false)
    expect(result.failures.map((failure) => failure.metric)).toContain('search.total')
  })

  it('浮点误差在容差内通过', () => {
    const result = compareRegression(
      report({ negatives: { total: 25, refusalRate: 0.84 - 1e-10 } }),
      BASELINE,
    )
    expect(result.ok).toBe(true)
  })

  it('报告缺字段或非对象时 fail closed', () => {
    expect(compareRegression(null, BASELINE).ok).toBe(false)
    expect(compareRegression({ index: {} }, BASELINE).ok).toBe(false)
    expect(compareRegression(report({ index: { total: 50, recallAt2: 'x' } }), BASELINE).ok).toBe(false)
  })

  it('基线缺字段时失败', () => {
    const broken = { ...BASELINE, index: { total: 50 } } as RegressionBaseline
    expect(compareRegression(report(), broken).ok).toBe(false)
  })
})