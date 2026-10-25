import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { compareDatasheetRegression } from '../regression-gate.js'
import type { DatasheetRegressionBaseline } from '../regression-gate.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORPUS = path.join(HERE, '..', 'corpus')
const DATA = path.join(HERE, '..', 'data')
const BASELINE_FILE = path.join(HERE, 'regression-baseline.json')

const corpusPresent = ['RM0008.pdf', 'RM0090.pdf'].every((name) =>
  existsSync(path.join(CORPUS, name)),
)

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * 真实语料回归：语料是本地资产（gitignore + 下载脚本），缺失时整组 skip
 * ——对齐 kb/tests/regression.test.ts 的先例，不伪造数据。
 */
describe.skipIf(!corpusPresent || !existsSync(BASELINE_FILE))(
  'datasheet regression against real ST manuals',
  () => {
    it(
      'meets the recorded baseline over the gold queries and negatives',
      async () => {
        const queries = readJsonl(path.join(DATA, 'queries.jsonl'))
        const negatives = readJsonl(path.join(DATA, 'negatives.jsonl'))
        const baseline = JSON.parse(
          readFileSync(BASELINE_FILE, 'utf8'),
        ) as DatasheetRegressionBaseline
        expect(queries.length).toBe(baseline.queries.total)
        expect(negatives.length).toBe(baseline.negatives.total)

        const { DatasheetService } = await import('../service.js')
        const { DatasheetCache } = await import('../cache.js')
        const service = new DatasheetService(
          CORPUS,
          new DatasheetCache(path.join(CORPUS, '.datasheet-mcp')),
        )

        let recallAt2 = 0
        let hitAt1 = 0
        let mrrSum = 0
        for (const query of queries) {
          const result = await service.search(String(query.query), 5)
          const rank = result.hits.findIndex(
            (hit) => hit.path === query.file && hit.page === query.page,
          )
          if (rank === 0) hitAt1 += 1
          if (rank >= 0) mrrSum += 1 / (rank + 1)
          if (rank >= 0 && rank < 2) recallAt2 += 1
        }
        let falsePositives = 0
        for (const negative of negatives) {
          const result = await service.search(String(negative.query), 5)
          if (result.hits.length > 0) falsePositives += 1
        }

        const report = {
          queries: {
            total: queries.length,
            recallAt2: recallAt2 / queries.length,
            hitAt1: hitAt1 / queries.length,
            mrr: mrrSum / queries.length,
          },
          negatives: {
            total: negatives.length,
            falsePositiveRate: falsePositives / negatives.length,
          },
        }
        const gate = compareDatasheetRegression(report, baseline)
        if (!gate.ok) console.error('regression failures:', gate.failures)
        expect(gate.ok).toBe(true)
      },
      1_200_000,
    )
  },
)