import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { KbService } from '../service.js'
import {
  createSearchAccumulator,
  recordSearchResult,
} from '../regression-report.js'

interface QueryRecord {
  id: string
  track: 'index' | 'search'
  text: string
  gold: string[]
}

interface NegativeRecord {
  id: string
  text: string
}

interface RegressionBaseline {
  index: { total: number; recallAt2: number; hitAt1: number; mrr: number }
  search: { total: number; hitAt1: number; goldInTop20: number }
  negatives: { total: number; refusalRate: number }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KB_ROOT = path.join(HERE, '..', 'kb')
const DATA_DIR = path.join(HERE, '..', 'data')
const QUERIES_PATH = path.join(DATA_DIR, 'queries.jsonl')
const NEGATIVES_PATH = path.join(DATA_DIR, 'negatives.jsonl')
const BASELINE_PATH = path.join(HERE, 'regression-baseline.json')
const TOKEN_PATTERN = /0x[0-9A-Fa-f]+|[A-Za-z_][A-Za-z0-9_]*/g
const LOOKUP_LIMIT = 2
const SEARCH_LIMIT = 20

function readJsonl<T>(filePath: string): T[] {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T)
}

function extractTokens(text: string): string[] {
  const seen = new Map<string, string>()
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0]
    const key = token.toLowerCase()
    if (!seen.has(key)) seen.set(key, token)
  }
  return [...seen.values()]
}

const missingAssets = [
  { label: 'mcp-servers/kb/kb', present: existsSync(KB_ROOT) },
  { label: 'mcp-servers/kb/data/queries.jsonl', present: existsSync(QUERIES_PATH) },
  { label: 'mcp-servers/kb/data/negatives.jsonl', present: existsSync(NEGATIVES_PATH) },
]
  .filter((asset) => !asset.present)
  .map((asset) => asset.label)

if (missingAssets.length === 0 && !existsSync(BASELINE_PATH)) {
  throw new Error(`缺少回归基线: ${BASELINE_PATH}`)
}

const baseline =
  missingAssets.length === 0
    ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as RegressionBaseline)
    : undefined

describe('search 回归 miss 分类', () => {
  const query = { id: 'q-1', gold: ['gold.md'] }

  it('gold 在 top20 但不是第一条时记录 not_first', () => {
    const accumulator = createSearchAccumulator()
    recordSearchResult(accumulator, query, ['uart'], {
      found: true,
      hits: [{ path: 'other.md' }, { path: 'gold.md' }],
    })

    expect(accumulator.hitAt1).toBe(0)
    expect(accumulator.goldInTop20).toBe(1)
    expect(accumulator.misses).toEqual([
      {
        id: 'q-1',
        gold: ['gold.md'],
        tokens: ['uart'],
        hitPaths: ['other.md', 'gold.md'],
        firstHit: 'other.md',
        reason: 'gold_in_top_20_but_not_first',
      },
    ])
  })

  it('gold 未进 top20 与无命中分别记录', () => {
    const accumulator = createSearchAccumulator()
    recordSearchResult(accumulator, query, ['uart'], {
      found: true,
      hits: [{ path: 'other.md' }],
    })
    recordSearchResult(accumulator, { id: 'q-2', gold: ['gold.md'] }, ['uart'], {
      found: false,
      hits: [],
    })

    expect(accumulator.misses.map((miss) => miss.reason)).toEqual([
      'gold_not_in_top_20_hits',
      'no_hits',
    ])
  })

  it('第一条命中时严格 Hit@1 与 goldInTop20 都计数且无 miss', () => {
    const accumulator = createSearchAccumulator()
    recordSearchResult(accumulator, query, ['uart'], {
      found: true,
      hits: [{ path: 'gold.md' }, { path: 'other.md' }],
    })

    expect(accumulator.hitAt1).toBe(1)
    expect(accumulator.goldInTop20).toBe(1)
    expect(accumulator.misses).toEqual([])
  })

  it('无 token 查询计入总数并记录原因', () => {
    const accumulator = createSearchAccumulator()
    recordSearchResult(accumulator, query, [], { found: false, hits: [] })

    expect(accumulator.total).toBe(1)
    expect(accumulator.misses[0]?.reason).toBe('no_ascii_or_hex_token')
  })
})

const suiteName =
  missingAssets.length === 0
    ? 'KB 双轨回归（本地语料）'
    : `KB 双轨回归（已跳过：缺少 ${missingAssets.join('、')}）`

const suite = missingAssets.length === 0 ? describe : describe.skip

suite(suiteName, () => {
  const expected = baseline as RegressionBaseline
  const queries = missingAssets.length === 0 ? readJsonl<QueryRecord>(QUERIES_PATH) : []
  const negatives = missingAssets.length === 0 ? readJsonl<NegativeRecord>(NEGATIVES_PATH) : []
  const service = new KbService(KB_ROOT)

  it('index 轨 Recall@2 / Hit@1 / MRR 不低于基线', () => {
    const indexQueries = queries.filter((query) => query.track === 'index')
    let recallSum = 0
    let hitAt1 = 0
    let mrrSum = 0
    for (const query of indexQueries) {
      const result = service.lookup(query.text, LOOKUP_LIMIT)
      const candidatePaths = result.candidates.map((candidate) => candidate.path)
      const matched = query.gold.filter((gold) => candidatePaths.includes(gold))
      recallSum += matched.length / query.gold.length
      const rank = candidatePaths.findIndex((candidate) => query.gold.includes(candidate))
      if (rank === 0) hitAt1 += 1
      if (rank >= 0) mrrSum += 1 / (rank + 1)
    }
    const total = indexQueries.length
    expect(total).toBe(expected.index.total)
    expect(total === 0 ? 0 : recallSum / total).toBeGreaterThanOrEqual(
      expected.index.recallAt2,
    )
    expect(total === 0 ? 0 : hitAt1 / total).toBeGreaterThanOrEqual(expected.index.hitAt1)
    expect(total === 0 ? 0 : mrrSum / total).toBeGreaterThanOrEqual(expected.index.mrr)
  })

  it('search 轨严格 Hit@1 与 goldInTop20 不低于基线', () => {
    const searchQueries = queries.filter((query) => query.track === 'search')
    let hitAt1 = 0
    let goldInTop20 = 0
    for (const query of searchQueries) {
      const tokens = extractTokens(query.text)
      if (tokens.length === 0) continue
      const result = service.search(tokens, SEARCH_LIMIT)
      const hitPaths = new Set(result.hits.map((hit) => hit.path))
      if (result.hits.length > 0 && query.gold.includes(result.hits[0].path)) hitAt1 += 1
      if (query.gold.some((gold) => hitPaths.has(gold))) goldInTop20 += 1
    }
    const total = searchQueries.length
    expect(total).toBe(expected.search.total)
    expect(total === 0 ? 0 : hitAt1 / total).toBeGreaterThanOrEqual(expected.search.hitAt1)
    expect(total === 0 ? 0 : goldInTop20 / total).toBeGreaterThanOrEqual(
      expected.search.goldInTop20,
    )
  })

  it('负样本拒答率不低于基线', () => {
    let refused = 0
    for (const query of negatives) {
      const result = service.lookup(query.text)
      if (result.found === false) refused += 1
    }
    const refusalRate = negatives.length === 0 ? 0 : refused / negatives.length
    expect(negatives.length).toBe(expected.negatives.total)
    expect(refusalRate).toBeGreaterThanOrEqual(expected.negatives.refusalRate)
  })
})