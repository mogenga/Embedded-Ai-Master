export interface SearchQueryRecord {
  id: string
  gold: string[]
}

export interface SearchHitLike {
  path: string
}

export interface SearchResultLike {
  found: boolean
  hits: SearchHitLike[]
}

export type SearchMissReason =
  | 'no_ascii_or_hex_token'
  | 'no_hits'
  | 'gold_not_in_top_20_hits'
  | 'gold_in_top_20_but_not_first'

export interface SearchMiss {
  id: string
  gold: string[]
  tokens: string[]
  hitPaths?: string[]
  firstHit?: string
  reason: SearchMissReason
}

export interface SearchAccumulator {
  total: number
  hitAt1: number
  goldInTop20: number
  misses: SearchMiss[]
}

export function createSearchAccumulator(): SearchAccumulator {
  return { total: 0, hitAt1: 0, goldInTop20: 0, misses: [] }
}

export function recordSearchResult(
  accumulator: SearchAccumulator,
  query: SearchQueryRecord,
  tokens: string[],
  result: SearchResultLike,
): void {
  accumulator.total += 1

  if (tokens.length === 0) {
    accumulator.misses.push({
      id: query.id,
      gold: query.gold,
      tokens,
      reason: 'no_ascii_or_hex_token',
    })
    return
  }

  const hitPaths = [...new Set(result.hits.map((hit) => hit.path))]
  const goldInTop20 = query.gold.some((gold) => hitPaths.includes(gold))
  const firstHit = result.hits[0]?.path
  const strictHit = firstHit !== undefined && query.gold.includes(firstHit)

  if (goldInTop20) accumulator.goldInTop20 += 1
  if (strictHit) accumulator.hitAt1 += 1

  if (!goldInTop20) {
    accumulator.misses.push({
      id: query.id,
      gold: query.gold,
      tokens,
      hitPaths: hitPaths.slice(0, 5),
      reason: result.found ? 'gold_not_in_top_20_hits' : 'no_hits',
    })
    return
  }

  if (!strictHit) {
    accumulator.misses.push({
      id: query.id,
      gold: query.gold,
      tokens,
      hitPaths: hitPaths.slice(0, 5),
      firstHit,
      reason: 'gold_in_top_20_but_not_first',
    })
  }
}
