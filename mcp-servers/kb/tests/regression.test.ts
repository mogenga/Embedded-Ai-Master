import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { KbService } from '../service.js'

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
  search: { total: number; hitAt1: number }
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

const suite = missingAssets.length === 0 ? describe : describe.skip
const suiteName =
  missingAssets.length === 0
    ? 'KB 双轨回归（本地语料）'
    : `KB 双轨回归（已跳过：缺少 ${missingAssets.join('、')}）`

suite(suiteName, () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as RegressionBaseline
  const queries = readJsonl<QueryRecord>(QUERIES_PATH)
  const negatives = readJsonl<NegativeRecord>(NEGATIVES_PATH)
  const service = new KbService(KB_ROOT)

  it('index 轨 Recall@2 不低于基线', () => {
    const indexQueries = queries.filter((query) => query.track === 'index')
    let recallSum = 0
    for (const query of indexQueries) {
      const result = service.lookup(query.text, LOOKUP_LIMIT)
      const candidatePaths = result.candidates.map((candidate) => candidate.path)
      const matched = query.gold.filter((gold) => candidatePaths.includes(gold))
      recallSum += matched.length / query.gold.length
    }
    const recallAt2 = indexQueries.length === 0 ? 0 : recallSum / indexQueries.length
    expect(indexQueries.length).toBe(baseline.index.total)
    expect(recallAt2).toBeGreaterThanOrEqual(baseline.index.recallAt2)
  })

  it('search 轨 Hit@1 不低于基线', () => {
    const searchQueries = queries.filter((query) => query.track === 'search')
    let hits = 0
    for (const query of searchQueries) {
      const tokens = extractTokens(query.text)
      if (tokens.length === 0) continue
      const result = service.search(tokens, SEARCH_LIMIT)
      const hitPaths = new Set(result.hits.map((hit) => hit.path))
      if (query.gold.some((gold) => hitPaths.has(gold))) hits += 1
    }
    const hitAt1 = searchQueries.length === 0 ? 0 : hits / searchQueries.length
    expect(searchQueries.length).toBe(baseline.search.total)
    expect(hitAt1).toBeGreaterThanOrEqual(baseline.search.hitAt1)
  })

  it('负样本拒答率不低于基线', () => {
    let refused = 0
    for (const query of negatives) {
      const result = service.lookup(query.text)
      if (result.found === false) refused += 1
    }
    const refusalRate = negatives.length === 0 ? 0 : refused / negatives.length
    expect(negatives.length).toBe(baseline.negatives.total)
    expect(refusalRate).toBeGreaterThanOrEqual(baseline.negatives.refusalRate)
  })
})