import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DatasheetCache } from '../cache.js'
import {
  createDatasheetServer,
  createDatasheetService,
  resolveDatasheetCacheDir,
  resolveDatasheetRoot,
} from '../server.js'
import { DatasheetService, EXTRACTOR_INSTALL_HINT } from '../service.js'
import { datasheetTools } from '../tools.js'
import type { DatasheetToolSpec } from '../tools.js'

let root: string
let cacheDir: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ds-tools-'))
  cacheDir = path.join(root, '.datasheet-mcp')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeService(extractor: string | null): DatasheetService {
  writeFileSync(path.join(root, 'rm0008.pdf'), '%PDF-1.4 placeholder')
  return new DatasheetService(root, new DatasheetCache(cacheDir), {
    findExtractor: () => Promise.resolve(extractor),
    extract: () =>
      Promise.resolve('RM0008\r\nUSART2 base 0x40004400\fUSB_BCDR register page'),
  })
}

function toolByName(tools: DatasheetToolSpec[], name: string): DatasheetToolSpec {
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`tool not found: ${name}`)
  return tool
}

describe('datasheet tool surface', () => {
  it('exposes exactly the four tools, all read-only', () => {
    const tools = datasheetTools(makeService('pdftotext'))
    expect(tools.map((tool) => tool.name)).toEqual([
      'datasheet_search',
      'datasheet_read',
      'datasheet_registers',
      'datasheet_status',
    ])
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
      expect(tool.annotations?.destructiveHint).toBeUndefined()
    }
  })
})

describe('datasheet_search', () => {
  it('returns structured hits on a real phrase match', async () => {
    const handler = toolByName(datasheetTools(makeService('pdftotext')), 'datasheet_search')
      .handler
    const result = await handler({ query: 'usb_bcdr', limit: 5 })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({
      found: true,
      extractor: 'pdftotext',
      hits: [
        {
          path: 'rm0008.pdf',
          page: 2,
          excerpt: expect.stringContaining('USB_BCDR'),
        },
      ],
    })
  })

  it('surfaces count / truncated / scanTruncated in the result', async () => {
    const handler = toolByName(datasheetTools(makeService('pdftotext')), 'datasheet_search')
      .handler
    const result = await handler({ query: 'usb_bcdr' })
    expect(result.structuredContent).toMatchObject({
      count: 1,
      truncated: false,
      scanTruncated: false,
    })
  })

  it('tells the caller how many hits were cut when the limit truncates', async () => {
    writeFileSync(path.join(root, 'second.pdf'), '%PDF-1.4 placeholder')
    const handler = toolByName(datasheetTools(makeService('pdftotext')), 'datasheet_search')
      .handler
    const result = await handler({ query: 'usb_bcdr', limit: 1 })
    expect(result.structuredContent).toMatchObject({
      count: 2,
      truncated: true,
      scanTruncated: false,
    })
    expect((result.structuredContent as { hits: unknown[] }).hits).toHaveLength(1)
  })

  it('fails with invalid_argument on schema violations', async () => {
    const handler = toolByName(datasheetTools(makeService('pdftotext')), 'datasheet_search')
      .handler
    for (const args of [{ query: '' }, { query: 'x', limit: 0 }, { query: 'x', limit: 51 }, {}]) {
      const result = await handler(args)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'invalid_argument' })
    }
  })

  it('returns an explicit error with the install hint when the extractor is missing', async () => {
    const handler = toolByName(datasheetTools(makeService(null)), 'datasheet_search').handler
    const result = await handler({ query: 'USART' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      code: 'extractor_missing',
      found: false,
      extractor: null,
    })
    expect(JSON.stringify(result.structuredContent)).toContain('winget')
  })
})

describe('datasheet_read', () => {
  it('returns whole pages for a valid range', async () => {
    const handler = toolByName(datasheetTools(makeService('pdftotext')), 'datasheet_read').handler
    const result = await handler({ path: 'rm0008.pdf', page: 1 })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({
      path: 'rm0008.pdf',
      total: 2,
      truncated: false,
      pages: [{ page: 1, text: expect.stringContaining('USART2') }],
    })
  })

  it('rejects absolute paths and escapes with path_denied', async () => {
    const handler = toolByName(datasheetTools(makeService('pdftotext')), 'datasheet_read').handler
    for (const args of [
      { path: path.join(root, 'rm0008.pdf'), page: 1 },
      { path: '../outside.pdf', page: 1 },
    ]) {
      const result = await handler(args)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'path_denied' })
    }
  })

  it('rejects out-of-range pages with the total attached', async () => {
    const handler = toolByName(datasheetTools(makeService('pdftotext')), 'datasheet_read').handler
    const result = await handler({ path: 'rm0008.pdf', page: 3 })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      code: 'page_out_of_range',
      total: 2,
    })
  })

  it('fails with the install hint when the extractor is missing', async () => {
    const handler = toolByName(datasheetTools(makeService(null)), 'datasheet_read').handler
    const result = await handler({ path: 'rm0008.pdf', page: 1 })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      code: 'extractor_missing',
      message: EXTRACTOR_INSTALL_HINT,
    })
  })
})

describe('datasheet_registers', () => {
  const REGISTER_TEXT = [
    '            USB control register (USB_CNTR)',
    '            Address offset: 0x40',
    '            Reset value: 0x0003',
    '            Bit 15 CTRM: Correct transfer interrupt mask',
    '            Bit 14 PMAOVRM: Packet memory area over / underrun interrupt mask',
    '            Bit 13 ERRM: Error interrupt mask',
  ].join('\n')

  function registerService(extractor: string | null): DatasheetService {
    writeFileSync(path.join(root, 'rm0008.pdf'), '%PDF-1.4 placeholder')
    return new DatasheetService(root, new DatasheetCache(cacheDir), {
      findExtractor: () => Promise.resolve(extractor),
      extract: () => Promise.resolve(REGISTER_TEXT),
    })
  }

  it('returns structured tables for a register-name query', async () => {
    const handler = toolByName(datasheetTools(registerService('pdftotext')), 'datasheet_registers')
      .handler
    const result = await handler({ query: 'CNTR' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({
      found: true,
      tables: [
        {
          path: 'rm0008.pdf',
          name: 'USB_CNTR',
          offset: '0x40',
          resetValue: '0x0003',
          sourcePage: 1,
          bits: expect.any(Array),
        },
      ],
    })
    const table = (result.structuredContent as { tables: Array<{ bits: unknown[] }> }).tables[0]
    expect(table.bits).toHaveLength(3)
  })

  it('requires exactly one of query / path', async () => {
    const handler = toolByName(datasheetTools(registerService('pdftotext')), 'datasheet_registers')
      .handler
    for (const args of [{}, { query: 'x', path: 'a.pdf' }]) {
      const result = await handler(args)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'invalid_argument' })
    }
  })

  it('fails with the install hint when the extractor is missing', async () => {
    const handler = toolByName(datasheetTools(registerService(null)), 'datasheet_registers')
      .handler
    const result = await handler({ query: 'CNTR' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'extractor_missing' })
  })

  it('reports found=false without an error when nothing matches', async () => {
    const handler = toolByName(datasheetTools(registerService('pdftotext')), 'datasheet_registers')
      .handler
    const result = await handler({ query: 'ZZ_NOPE' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ found: false, tables: [] })
  })
})

describe('datasheet_status', () => {
  it('reports root, extractor and cache facts', async () => {
    const handler = toolByName(datasheetTools(makeService('pdftotext')), 'datasheet_status')
      .handler
    const result = await handler({})
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({
      root,
      extractor: 'pdftotext',
      cacheDir,
      fileCount: 1,
    })
  })

  it('carries the install hint when the extractor is missing, without failing', async () => {
    const handler = toolByName(datasheetTools(makeService(null)), 'datasheet_status').handler
    const result = await handler({})
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ extractor: null })
    expect(JSON.stringify(result.structuredContent)).toContain('winget')
  })
})

describe('server wiring', () => {
  it('resolves the root from DATASHEET_ROOT or the cwd', () => {
    expect(resolveDatasheetRoot({}, root)).toBe(path.resolve(root))
    expect(resolveDatasheetRoot({ DATASHEET_ROOT: 'sub' }, root)).toBe(path.resolve(root, 'sub'))
  })

  it('resolves the cache dir next to the root, or from DATASHEET_CACHE_DIR', () => {
    expect(resolveDatasheetCacheDir({}, root, path.resolve(root))).toBe(
      path.join(path.resolve(root), '.datasheet-mcp'),
    )
    expect(resolveDatasheetCacheDir({ DATASHEET_CACHE_DIR: 'elsewhere' }, root)).toBe(
      path.resolve(root, 'elsewhere'),
    )
  })

  it('builds a service from env defaults without touching the workspace', () => {
    const service = createDatasheetService({ DATASHEET_ROOT: root }, root)
    expect(service.status()).resolves.toMatchObject({ root: path.resolve(root) })
  })

  it('registers all four tools on the MCP server', () => {
    const server = createDatasheetServer(makeService('pdftotext')) as unknown as {
      _registeredTools: Record<string, unknown>
    }
    // SDK v2 未暴露公开的列举接口（无 inMemory transport、listTools 需连接后
    // 走协议）；读私有注册表（普通对象，键为工具名）只为断言注册确实发生。
    expect(Object.keys(server._registeredTools)).toEqual([
      'datasheet_search',
      'datasheet_read',
      'datasheet_registers',
      'datasheet_status',
    ])
  })
})