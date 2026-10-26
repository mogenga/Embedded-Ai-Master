import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DatasheetCache } from '../cache.js'
import { DatasheetService, EXTRACTOR_INSTALL_HINT } from '../service.js'
import type { DatasheetServiceOptions } from '../service.js'
import { findPdfExtractor } from '../pdf.js'

const hasExtractor = (await findPdfExtractor()) !== null

let root: string
let cacheDir: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ds-svc-'))
  cacheDir = path.join(root, '.datasheet-mcp')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeService(overrides: DatasheetServiceOptions = {}): DatasheetService {
  return new DatasheetService(root, new DatasheetCache(cacheDir), overrides)
}

function writePdf(relativePath: string, content: string): string {
  const target = path.join(root, relativePath)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

const TWO_PAGE_TEXT = [
  'RM0008 Reference Manual',
  'USART2 base 0x40004400, CR1 at offset 0x00, UE is bit 13',
].join('\f')

describe('listDatasheets', () => {
  it('lists nothing in an empty workspace', () => {
    expect(makeService().listDatasheets()).toEqual({ files: [], scanTruncated: false })
  })

  it('discovers nested PDFs but skips dot dirs, node_modules, and the cache dir', () => {
    writePdf('docs/chips/stm32.pdf', '%PDF-1.4')
    writePdf('.datasheet-mcp/self.pdf', '%PDF-1.4')
    writePdf('.hidden/secret.pdf', '%PDF-1.4')
    writePdf('node_modules/x/hidden.pdf', '%PDF-1.4')
    const result = makeService().listDatasheets()
    expect(result.files.map((file) => file.path)).toEqual(['docs/chips/stm32.pdf'])
    expect(result.scanTruncated).toBe(false)
  })

  it('marks oversized files as skipped without extracting them', () => {
    writePdf('big.pdf', '%PDF-1.4 big')
    const result = makeService({ maxBytes: 4 }).listDatasheets()
    expect(result.files).toEqual([{ path: 'big.pdf', skipped: 'too_large' }])
  })

  it('reports scanTruncated when the file budget is exhausted (count is a lower bound)', () => {
    writePdf('a.pdf', '%PDF-1.4')
    writePdf('b.pdf', '%PDF-1.4')
    const result = makeService({ maxFiles: 1 }).listDatasheets()
    expect(result.files.length).toBe(1)
    expect(result.scanTruncated).toBe(true)
  })

  it('does not extract while listing (no pages, no cache writes)', () => {
    writePdf('placeholder.pdf', '%PDF-1.4 not really a pdf')
    const result = makeService().listDatasheets()
    expect(result.files).toEqual([{ path: 'placeholder.pdf' }])
  })

  it('does not walk deeper than maxDepth levels', () => {
    writePdf(path.join('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'deep.pdf'), '%PDF-1.4')
    writePdf(path.join('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'too-deep.pdf'), '%PDF-1.4')
    const result = makeService().listDatasheets()
    expect(result.files.map((file) => file.path)).toEqual([
      'l1/l2/l3/l4/l5/l6/deep.pdf'.split(path.sep).join('/'),
    ])
  })
})

describe('search (extractor injected)', () => {
  it('an empty query returns nothing without walking the tree', async () => {
    writePdf('a.pdf', '%PDF-1.4')
    const result = await makeService({ findExtractor: () => Promise.resolve(null) }).search('   ')
    expect(result).toEqual({ hits: [], skipped: [], extractor: null })
  })

  it('reports the install hint instead of an empty-looking miss when pdftotext is absent', async () => {
    writePdf('a.pdf', '%PDF-1.4')
    const result = await makeService({ findExtractor: () => Promise.resolve(null) }).search('USART')
    expect(result.hits).toEqual([])
    expect(result.extractor).toBeNull()
    expect(result.skipped).toEqual([{ path: '.', reason: EXTRACTOR_INSTALL_HINT }])
    expect(result.skipped[0].reason).toContain('winget')
  })

  it('classifies extraction failures per file with a reason', async () => {
    writePdf('broken.pdf', '%PDF-1.4')
    const result = await makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
      extract: () => Promise.resolve(null),
    }).search('anything')
    expect(result.skipped).toEqual([
      { path: 'broken.pdf', reason: 'could not extract text (unreadable or corrupted PDF)' },
    ])
  })

  it('reports scanned PDFs as no-text-layer and never retries them (empty cache flag)', async () => {
    const file = writePdf('scan.pdf', '%PDF-1.4')
    let calls = 0
    const service = makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
      extract: () => {
        calls++
        return Promise.resolve('  \f  ')
      },
    })
    const first = await service.search('target')
    expect(first.skipped).toEqual([
      { path: 'scan.pdf', reason: 'the PDF has no text layer (scanned images cannot be searched)' },
    ])
    const second = await service.search('target')
    expect(second.skipped).toEqual(first.skipped)
    expect(calls).toBe(1)
    expect(
      new DatasheetCache(cacheDir).load(
        file,
        `${statSync(file).mtimeMs}:${statSync(file).size}`,
      ),
    ).toMatchObject({
      empty: true,
    })
  })

  it('matches whole phrases case-insensitively and reports the first hit page', async () => {
    writePdf('rm0008.pdf', '%PDF-1.4')
    const service = makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
      extract: () => Promise.resolve(TWO_PAGE_TEXT),
    })
    const result = await service.search('usart2 base')
    expect(result.hits).toEqual([
      {
        path: 'rm0008.pdf',
        page: 2,
        excerpt: expect.stringContaining('USART2 base 0x40004400'),
        score: expect.any(Number),
      },
    ])
  })

  it('caps the excerpt window before/after the hit', async () => {
    const longPrefix = 'x'.repeat(500)
    const longSuffix = 'y'.repeat(500)
    const page = `${longPrefix} NEEDLE ${longSuffix}`
    writePdf('long.pdf', '%PDF-1.4')
    const service = makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
      extract: () => Promise.resolve(page),
    })
    const result = await service.search('NEEDLE')
    const excerpt = result.hits[0].excerpt
    expect(excerpt).toContain('NEEDLE')
    // 120 前窗 + 命中 + 200 后窗，两侧都被截到窗口内。
    expect(excerpt.length).toBeLessThanOrEqual(120 + 'NEEDLE'.length + 200)
    expect(excerpt.startsWith('x')).toBe(true)
    expect(excerpt.endsWith('y')).toBe(true)
  })

  it('starts the excerpt at offset 0 when the hit is at the page start', async () => {
    writePdf('edge.pdf', '%PDF-1.4')
    const service = makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
      extract: () => Promise.resolve('NEEDLE at page start'),
    })
    const result = await service.search('NEEDLE')
    expect(result.hits[0].excerpt.startsWith('NEEDLE')).toBe(true)
  })

  it('refuses a query whose anchor token appears nowhere (nonexistent register)', async () => {
    writePdf('rm0008.pdf', '%PDF-1.4')
    // RCC_APB3ENR 不存在：泛词 rcc 命中大量页，但锚 token apb3enr 全语料
    // 零命中——必须拒答，不得返回只含 RCC 的页当答案。
    const result = await makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
      extract: () => Promise.resolve('RCC registers RCC controls RCC clocks'),
    }).search('RCC_APB3ENR')
    expect(result.hits).toEqual([])
  })

  it('keeps hits when the anchor token does appear somewhere', async () => {
    writePdf('rm0008.pdf', '%PDF-1.4')
    const result = await makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
      extract: () => Promise.resolve('RCC_APB1ENR enables the APB1 clock'),
    }).search('RCC_APB1ENR')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].page).toBe(1)
  })

  it('honors the limit across files', async () => {
    writePdf('a.pdf', '%PDF-1.4')
    writePdf('b.pdf', '%PDF-1.4')
    const service = makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
      extract: () => Promise.resolve('shared magic phrase'),
    })
    expect((await service.search('magic phrase', 1)).hits.length).toBe(1)
    expect((await service.search('magic phrase')).hits.length).toBe(2)
  })
})

describe('search (real pdftotext)', () => {
  /**
   * 这一组会 spawn 真实的 `pdftotext`，而 vitest 的默认超时是 5 秒。机器空闲时
   * 一次提取约 0.5 秒；满载时（2026-10-26 实测：同时跑 electron-builder 打包）
   * 会超过 5 秒，于是报 `Test timed out in 5000ms`——测的是外部进程的调度，
   * 不是本模块的逻辑。给足余量。
   */
  const EXTRACTOR_TIMEOUT_MS = 30_000;

  it.skipIf(!hasExtractor)('finds the register page in a generated text PDF', { timeout: EXTRACTOR_TIMEOUT_MS }, async () => {
    writePdf('rm.pdf', '%PDF-1.4')
    const file = path.join(root, 'rm.pdf')
    const { makeTextPdf } = await import('./fixtures.js')
    writeFileSync(file, makeTextPdf([
      ['RM0008 Reference Manual', 'introduction'],
      ['USB_BCDR register', 'dPPDdisable: DP pull-down disable'],
    ]))
    const result = await makeService().search('USB_BCDR')
    expect(result.extractor).toBe('pdftotext')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].page).toBe(2)
    expect(result.hits[0].excerpt).toContain('USB_BCDR')
  })

  it.skipIf(!hasExtractor)('reports a scanned PDF as no-text-layer, then uses the cache', { timeout: EXTRACTOR_TIMEOUT_MS }, async () => {
    const { makeImageOnlyPdf } = await import('./fixtures.js')
    writePdf('scan.pdf', '%PDF-1.4')
    writeFileSync(path.join(root, 'scan.pdf'), makeImageOnlyPdf())
    const service = makeService()
    const first = await service.search('anything')
    expect(first.skipped).toEqual([
      { path: 'scan.pdf', reason: 'the PDF has no text layer (scanned images cannot be searched)' },
    ])
    const before = new DatasheetCache(cacheDir).count()
    expect(before).toBe(1)
    const second = await service.search('anything')
    expect(second.skipped).toEqual(first.skipped)
    expect(new DatasheetCache(cacheDir).count()).toBe(1)
  })
})

describe('readPages (extractor injected)', () => {
  const service = (overrides: DatasheetServiceOptions = {}) =>
    makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
      extract: () => Promise.resolve(TWO_PAGE_TEXT),
      ...overrides,
    })

  it('rejects absolute paths and .. escapes', async () => {
    await expect(service().readPages(path.join(root, 'a.pdf'), 1)).rejects.toMatchObject({
      code: 'path_denied',
    })
    await expect(service().readPages('../outside.pdf', 1)).rejects.toMatchObject({
      code: 'path_denied',
    })
  })

  it('rejects a missing file with not_found', async () => {
    writePdf('real.pdf', '%PDF-1.4')
    await expect(service().readPages('ghost.pdf', 1)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('fails with the install hint when the extractor is missing', async () => {
    writePdf('a.pdf', '%PDF-1.4')
    await expect(
      makeService({ findExtractor: () => Promise.resolve(null) }).readPages('a.pdf', 1),
    ).rejects.toMatchObject({ code: 'extractor_missing', message: EXTRACTOR_INSTALL_HINT })
  })

  it('returns whole pages with the real total', async () => {
    writePdf('rm0008.pdf', '%PDF-1.4')
    const result = await service().readPages('rm0008.pdf', 2)
    expect(result.total).toBe(2)
    expect(result.pages).toEqual([{ page: 2, text: expect.stringContaining('USART2') }])
    expect(result.truncated).toBe(false)
  })

  it('supports a page range', async () => {
    writePdf('rm0008.pdf', '%PDF-1.4')
    const result = await service().readPages('rm0008.pdf', 1, 2)
    expect(result.pages.map((page) => page.page)).toEqual([1, 2])
    expect(result.pageEnd).toBe(2)
  })

  it('rejects an out-of-range page with the total attached', async () => {
    writePdf('rm0008.pdf', '%PDF-1.4')
    await expect(service().readPages('rm0008.pdf', 3)).rejects.toMatchObject({
      code: 'page_out_of_range',
      details: { total: 2 },
    })
  })

  it('rejects a reversed range and a span larger than 50 pages', async () => {
    writePdf('rm0008.pdf', '%PDF-1.4')
    await expect(service().readPages('rm0008.pdf', 2, 1)).rejects.toMatchObject({
      code: 'page_out_of_range',
    })
    await expect(service().readPages('rm0008.pdf', 1, 51)).rejects.toMatchObject({
      code: 'page_range_too_large',
    })
  })

  it('truncates a single oversized page to 512KiB and flags truncated', async () => {
    writePdf('huge.pdf', '%PDF-1.4')
    const hugePage = 'z'.repeat(600 * 1024)
    const result = await service({
      extract: () => Promise.resolve(hugePage),
    }).readPages('huge.pdf', 1)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0].text.length).toBe(512 * 1024)
    expect(result.truncated).toBe(true)
  })

  it('drops later pages once the 512KiB budget is spent', async () => {
    writePdf('multi.pdf', '%PDF-1.4')
    const three = ['a'.repeat(200 * 1024), 'b'.repeat(200 * 1024), 'c'.repeat(200 * 1024)].join('\f')
    const result = await service({
      extract: () => Promise.resolve(three),
    }).readPages('multi.pdf', 1, 3)
    expect(result.pages.map((page) => page.page)).toEqual([1, 2])
    expect(result.truncated).toBe(true)
  })

  it('flags truncated when the requested range exceeds the real total', async () => {
    writePdf('rm0008.pdf', '%PDF-1.4')
    const result = await service().readPages('rm0008.pdf', 1, 5)
    expect(result.pageEnd).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('rejects a no-text-layer PDF explicitly', async () => {
    writePdf('scan.pdf', '%PDF-1.4')
    await expect(
      service({ extract: () => Promise.resolve('   ') }).readPages('scan.pdf', 1),
    ).rejects.toMatchObject({ code: 'no_text_layer' })
  })
})

describe('readPages (real pdftotext)', () => {
  it.skipIf(!hasExtractor)('reads a whole generated page verbatim', async () => {
    const { makeTextPdf } = await import('./fixtures.js')
    writePdf('rm.pdf', '%PDF-1.4')
    writeFileSync(
      path.join(root, 'rm.pdf'),
      makeTextPdf([['USB_BCDR register', 'dPPDdisable: DP pull-down disable']]),
    )
    const result = await makeService().readPages('rm.pdf', 1)
    expect(result.total).toBe(1)
    expect(result.pages[0].text).toContain('USB_BCDR')
    expect(result.pages[0].text).toContain('dPPDdisable')
  })
})

describe('status', () => {
  it('reports root, extractor, cache dir and file count', async () => {
    writePdf('a.pdf', '%PDF-1.4')
    writePdf('b.pdf', '%PDF-1.4')
    const status = await makeService({
      findExtractor: () => Promise.resolve('pdftotext'),
    }).status()
    expect(status).toMatchObject({
      root,
      extractor: 'pdftotext',
      cacheDir,
      cacheEntries: 0,
      fileCount: 2,
      scanTruncated: false,
    })
  })
})
