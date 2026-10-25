import { describe, expect, it } from 'vitest'

import {
  compareDatasheetRegression,
  type DatasheetRegressionBaseline,
} from '../regression-gate.js'

const baseline: DatasheetRegressionBaseline = {
  queries: { total: 50, recallAt2: 0.8, hitAt1: 0.7, mrr: 0.75 },
  negatives: { total: 25, falsePositiveRate: 0.08 },
}

describe('compareDatasheetRegression', () => {
  it('passes when every metric meets the baseline', () => {
    const report = {
      queries: { total: 50, recallAt2: 0.9, hitAt1: 0.7, mrr: 0.75 },
      negatives: { total: 25, falsePositiveRate: 0.04 },
    }
    expect(compareDatasheetRegression(report, baseline)).toEqual({ ok: true, failures: [] })
  })

  it('fails when a quality metric drops below the baseline', () => {
    const report = {
      queries: { total: 50, recallAt2: 0.79, hitAt1: 0.7, mrr: 0.75 },
      negatives: { total: 25, falsePositiveRate: 0.04 },
    }
    const gate = compareDatasheetRegression(report, baseline)
    expect(gate.ok).toBe(false)
    expect(gate.failures).toEqual([
      { metric: 'queries.recallAt2', expected: 0.8, actual: 0.79 },
    ])
  })

  it('fails when the false-positive rate rises above the baseline (opposite direction)', () => {
    const report = {
      queries: { total: 50, recallAt2: 0.9, hitAt1: 0.7, mrr: 0.75 },
      negatives: { total: 25, falsePositiveRate: 0.12 },
    }
    const gate = compareDatasheetRegression(report, baseline)
    expect(gate.ok).toBe(false)
    expect(gate.failures).toEqual([
      { metric: 'negatives.falsePositiveRate', expected: 0.08, actual: 0.12 },
    ])
  })

  it('fails when the query count changes (relabel required)', () => {
    const report = {
      queries: { total: 40, recallAt2: 1, hitAt1: 1, mrr: 1 },
      negatives: { total: 25, falsePositiveRate: 0.04 },
    }
    const gate = compareDatasheetRegression(report, baseline)
    expect(gate.ok).toBe(false)
    expect(gate.failures[0].metric).toBe('queries.total')
  })

  it('rejects an invalid report or baseline shape', () => {
    expect(compareDatasheetRegression('nope', baseline).ok).toBe(false)
    const broken: DatasheetRegressionBaseline = { ...baseline, queries: { ...baseline.queries } }
    broken.queries = { total: 50 } as DatasheetRegressionBaseline['queries']
    const gate = compareDatasheetRegression(
      { queries: { total: 50, recallAt2: 1, hitAt1: 1, mrr: 1 }, negatives: { total: 25, falsePositiveRate: 0 } },
      broken,
    )
    expect(gate.failures.map((f) => f.metric)).toContain('invalid_baseline:queries.recallAt2')
  })
})