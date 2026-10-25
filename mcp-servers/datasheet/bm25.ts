/**
 * BM25 打分 + 混合排序（零依赖手写，~80 行）。
 *
 * 为什么不上 FTS5/向量：寄存器名是精确标识符，BM25 的词频-逆文档频对
 * 「术语在少数页高频出现」的形态已经足够；B 仓库零依赖现状不破（验收
 * 6：package.json diff 无变化）。风格对齐 kb/index.yaml 的手写打分函数。
 *
 * 排序信号两条：
 *   1. BM25 分（页级 token 化：小写、按非字母数字切分；停用词表为零起步）
 *   2. 子串命中加成（整短语命中稳赢分词命中——D13 的混合排序）
 */

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^0-9a-z]+/)
    .filter((token) => token !== '')
}

interface Bm25Index {
  /** 每页的 token 计数。 */
  pageTerms: Array<Map<string, number>>
  /** 每个 token 出现过的页数。 */
  docFreq: Map<string, number>
  totalPages: number
  /** 所有页 token 长度的平均值。 */
  avgLength: number
}

const K1 = 1.2
const B = 0.75

export function buildBm25Index(pages: string[]): Bm25Index {
  const pageTerms: Array<Map<string, number>> = []
  const docFreq = new Map<string, number>()
  let totalTokens = 0
  for (const page of pages) {
    const terms = new Map<string, number>()
    for (const token of tokenize(page)) {
      terms.set(token, (terms.get(token) ?? 0) + 1)
      totalTokens++
    }
    for (const token of terms.keys()) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
    }
    pageTerms.push(terms)
  }
  return {
    pageTerms,
    docFreq,
    totalPages: pages.length,
    avgLength: pages.length === 0 ? 0 : totalTokens / pages.length,
  }
}

/** 单页对一组查询 token 的 BM25 分（token 去重后求和）。 */
export function bm25PageScore(index: Bm25Index, pageIndex: number, queryTokens: string[]): number {
  const terms = index.pageTerms[pageIndex]
  if (terms === undefined) return 0
  const length = [...terms.values()].reduce((sum, count) => sum + count, 0)
  const norm = index.avgLength > 0 ? length / index.avgLength : 1
  let score = 0
  const seen = new Set<string>()
  for (const token of queryTokens) {
    if (seen.has(token)) continue
    seen.add(token)
    const tf = terms.get(token)
    if (tf === undefined) continue
    const df = index.docFreq.get(token) ?? 0
    // Robertson-Sparck Jones 近似：df 越小（稀有术语）权重越高。
    const idf = Math.log(1 + (index.totalPages - df + 0.5) / (df + 0.5))
    score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm)))
  }
  return score
}

/** 页级打分入口：BM25 分 + 整短语子串加成（短语命中稳赢）。 */
export function scorePages(
  pages: string[],
  query: string,
  phraseBonus = 4,
): Array<{ page: number; score: number; phraseHit: boolean }> {
  const index = buildBm25Index(pages)
  const queryTokens = [...new Set(tokenize(query))]
  const needle = query.trim().toLowerCase()
  const scored: Array<{ page: number; score: number; phraseHit: boolean }> = []
  for (let page = 0; page < pages.length; page++) {
    const bm25 = queryTokens.length > 0 ? bm25PageScore(index, page, queryTokens) : 0
    const phraseHit = needle !== '' && pages[page].toLowerCase().includes(needle)
    const score = bm25 + (phraseHit ? phraseBonus : 0)
    if (score > 0) scored.push({ page, score, phraseHit })
  }
  scored.sort((a, b) => b.score - a.score || a.page - b.page)
  return scored
}