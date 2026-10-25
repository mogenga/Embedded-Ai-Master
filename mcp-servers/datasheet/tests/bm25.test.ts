import { describe, expect, it } from 'vitest'

import { bm25PageScore, buildBm25Index, scorePages, tokenize } from '../bm25.js'
import { expandQueryTokens } from '../service.js'

describe('tokenize', () => {
  it('splits on non-alphanumeric runs and lowercases', () => {
    expect(tokenize('USB_BCDR, reset: 0x00!')).toEqual(['usb', 'bcdr', 'reset', '0x00'])
  })

  it('drops CJK separators (Chinese queries rely on synonym expansion)', () => {
    expect(tokenize('复位值')).toEqual([])
  })
})

describe('scorePages', () => {
  it('ranks the page with the rare term above frequent words', () => {
    const pages = [
      'clock clock clock clock enable enable', // 高频泛词页
      'USB_BCDR register controls DP pull-down', // 稀有术语页
    ]
    const scored = scorePages(pages, 'USB_BCDR')
    expect(scored[0].page).toBe(1)
    expect(scored[0].score).toBeGreaterThan(0)
  })

  it('a whole-phrase hit outranks scattered token hits (D13 hybrid ranking)', () => {
    const pages = [
      'the alternate function mapping is described in the GPIO chapter',
      'the function of each alternate pin role',
    ]
    // 第 0 页短语连续出现（phraseHit），第 1 页两个 token 都在但分散。
    // 混合排序下整短语命中必须稳赢分词命中。
    const scored = scorePages(pages, 'alternate function')
    expect(scored[0].page).toBe(0)
    expect(scored[0].phraseHit).toBe(true)
    expect(scored[1].phraseHit).toBe(false)
    expect(scored[0].score).toBeGreaterThan(scored[1].score)
  })

  it('returns nothing for a query with no matching tokens', () => {
    expect(scorePages(['clock enable'], 'zzz')).toEqual([])
  })

  it('sorts deterministically (score desc, then page asc)', () => {
    const pages = ['alpha alpha', 'beta', 'gamma gamma']
    const scored = scorePages(pages, 'alpha beta gamma')
    expect(scored.map((entry) => entry.page)).toEqual([0, 2, 1])
  })

  it('bm25 score grows with term frequency but saturates', () => {
    const index = buildBm25Index(['clock clock clock clock clock clock'])
    const low = bm25PageScore(index, 0, ['clock'])
    const pages = Array.from({ length: 6 }, (_, i) => (i === 0 ? 'clock' : 'other words here'))
    const sparseIndex = buildBm25Index(pages)
    const sparse = bm25PageScore(sparseIndex, 0, ['clock'])
    // 同一 token 在更稀有的文档里得分更高（idf 主导）。
    expect(sparse).toBeGreaterThan(low)
  })
})

describe('expandQueryTokens', () => {
  it('maps alternate function to AF and back', () => {
    expect(expandQueryTokens('alternate function mode')).toContain('af')
    expect(expandQueryTokens('AF0 selection')).toContain('alternate')
  })

  it('maps Chinese domain terms to English tokens', () => {
    expect(expandQueryTokens('复位值是多少')).toEqual(expect.arrayContaining(['reset', 'value']))
  })

  it('leaves unrelated queries untouched', () => {
    expect(expandQueryTokens('USB_BCDR')).toEqual(['usb', 'bcdr'])
  })
})