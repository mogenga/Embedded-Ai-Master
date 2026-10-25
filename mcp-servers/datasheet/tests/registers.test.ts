import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DatasheetCache } from '../cache.js'
import { extractRegisterTables } from '../registers.js'
import { DatasheetService } from '../service.js'
import { findPdfExtractor } from '../pdf.js'
import { makeTextPdf } from './fixtures.js'

const hasExtractor = (await findPdfExtractor()) !== null

const USB_CNTR_TEXT = [
  '            USB control register (USB_CNTR)',
  '',
  '            Address offset: 0x40',
  '',
  '            Reset value: 0x0003',
  '',
  '15      14  13  12  11  10  9   8                7  6         5  4   3   2   1   0',
  '',
  'CTRM PMAOVRM ERRM WKUPM SUSPM RESETM SOFM ESOFM     Reserved     RESUME FSUSP LP_MODE PDWN FRES',
  '',
  '            Bit 15 CTRM: Correct transfer interrupt mask',
  '                        0: Correct Transfer (CTR) Interrupt disabled.',
  '            Bit 14 PMAOVRM: Packet memory area over / underrun interrupt mask',
  '            Bit 13 ERRM: Error interrupt mask',
  '            Bit 12 WKUPM: Wakeup mode interrupt mask',
  '            Bit 11 SUSPM: Suspend mode interrupt mask',
  '            Bit 10 RESETM: USB reset interrupt mask',
  '            Bit 9 SOFM: Start of frame interrupt mask',
  '            Bit 8 ESOFM: Expected start of frame interrupt mask',
  '            Bit 7 RESUME: Resume request',
  '            Bit 6 FSUSP: Force suspend',
  '            Bit 5 LP_MODE: Low-power mode',
  '            Bit 4 PDWN: Power down',
  '            Bit 3 FRES: Force USB Reset',
].join('\n')

function pages(...texts: string[]): { path: string; pages: string[] } {
  return { path: 'rm.pdf', pages: texts }
}

describe('extractRegisterTables', () => {
  it('extracts a canonical register table with offset, reset and bit fields', () => {
    const tables = extractRegisterTables(pages(USB_CNTR_TEXT))
    expect(tables).toHaveLength(1)
    const table = tables[0]
    expect(table.name).toBe('USB_CNTR')
    expect(table.peripheral).toBe('USB')
    expect(table.offset).toBe('0x40')
    expect(table.resetValue).toBe('0x0003')
    expect(table.sourcePage).toBe(1)
    expect(table.confidence).toBeGreaterThanOrEqual(5)
    expect(table.bits).toHaveLength(13)
    expect(table.bits[0]).toEqual({
      name: 'CTRM',
      msb: 15,
      lsb: 15,
      desc: 'Correct transfer interrupt mask',
    })
    expect(table.bits[12]).toEqual({ name: 'FRES', msb: 3, lsb: 3, desc: 'Force USB Reset' })
  })

  it('parses multi-bit fields (Bits 2:0) and [x:y] name annotations', () => {
    const text = [
      '              Flash access control register (FLASH_ACR)',
      '              Address offset: 0x00',
      '              Reset value: 0x30',
      '              Bit 4 PRFTBE: Prefetch buffer enable',
      '              Bits 2:0 LATENCY: Latency',
      '              Bits 26:24 SWJ_CFG[2:0]: Serial wire JTAG configuration',
    ].join('\n')
    const tables = extractRegisterTables(pages(text))
    expect(tables).toHaveLength(1)
    expect(tables[0].bits).toEqual([
      { name: 'PRFTBE', msb: 4, lsb: 4, desc: 'Prefetch buffer enable' },
      { name: 'LATENCY', msb: 2, lsb: 0, desc: 'Latency' },
      { name: 'SWJ_CFG[2:0]', msb: 26, lsb: 24, desc: 'Serial wire JTAG configuration' },
    ])
  })

  it('keeps the reset value with space-separated halves intact', () => {
    const text = [
      '  AF remap register (AFIO_MAPR)',
      '  Address offset: 0x04',
      '  Reset value: 0x0000 0000',
      '  Bit 15 PD01_REMAP: Port D0/D1 mapping',
      '  Bit 14 CAN_REMAP: CAN remapping',
    ].join('\n')
    expect(extractRegisterTables(pages(text))[0].resetValue).toBe('0x0000 0000')
  })

  it('ignores running headers that end in a chapter paren (RM0008 ... (USB))', () => {
    const text = [
      'RM0008                              Universal serial bus full-speed device interface (USB)',
      USB_CNTR_TEXT,
    ].join('\n')
    const tables = extractRegisterTables(pages(text))
    expect(tables.map((t) => t.name)).toEqual(['USB_CNTR'])
  })

  it('ignores table-of-contents lines with dotted page numbers', () => {
    const text = [
      '9.4.2 AF remap and debug I/O configuration register (AFIO_MAPR) . . . . . . 184',
      USB_CNTR_TEXT,
    ].join('\n')
    const tables = extractRegisterTables(pages(text))
    expect(tables.map((t) => t.name)).toEqual(['USB_CNTR'])
  })

  it('carries a table across a page break (title on page N, bits on page N+1)', () => {
    const tables = extractRegisterTables({
      path: 'rm.pdf',
      pages: ['            USB control register (USB_CNTR)\n\n            Address offset: 0x40\n\n            Reset value: 0x0003', '            Bit 15 CTRM: Correct transfer interrupt mask\n            Bit 14 PMAOVRM: Packet memory area over / underrun interrupt mask'],
    })
    expect(tables).toHaveLength(1)
    expect(tables[0].name).toBe('USB_CNTR')
    expect(tables[0].sourcePage).toBe(1)
    expect(tables[0].bits).toHaveLength(2)
  })

  it('accepts density-variant tables that restart from high bits (two segments)', () => {
    const text = [
      '  AF remap register (AFIO_MAPR)',
      '  Address offset: 0x04',
      '  Bit 26 SWJ_CFG: Serial wire JTAG configuration',
      '  Bit 15 PD01_REMAP: Port D0/D1 mapping',
      '  Bit 0 SPI1_REMAP: SPI1 remapping',
      '  Bit 26 SWJ_CFG: Serial wire JTAG configuration (connectivity line)',
      '  Bit 4 TIM5CH4_IREMAP: TIM5 channel 4 remap',
      '  Bit 0 SPI1_REMAP: SPI1 remapping (connectivity line)',
    ].join('\n')
    const tables = extractRegisterTables(pages(text))
    expect(tables).toHaveLength(1)
    expect(tables[0].bits).toHaveLength(6)
  })

  it('drops low-confidence noise (scattered bits without a table)', () => {
    const prose = [
      'The LP_MODE bit in the USB_CNTR register is cleared.',
      'Bit 15 CTRM: mentioned in prose without a table',
      'Bit 14 PMAOVRM: also mentioned',
    ].join('\n')
    expect(extractRegisterTables(pages(prose))).toEqual([])
  })

  it('drops a table with more than two bit-order segments', () => {
    const text = [
      '  Something register (SOME_REG)',
      '  Address offset: 0x10',
      '  Bit 15 A: a',
      '  Bit 0 B: b',
      '  Bit 15 C: c',
      '  Bit 0 D: d',
      '  Bit 15 E: e',
    ].join('\n')
    expect(extractRegisterTables(pages(text))).toEqual([])
  })

  it('drops fields above bit 31', () => {
    const text = [
      '  Wide register (WIDE_REG)',
      '  Address offset: 0x00',
      '  Bit 40 BIG: too wide',
      '  Bit 39 BIG2: also too wide',
    ].join('\n')
    expect(extractRegisterTables(pages(text))).toEqual([])
  })

  it('keeps a table without offset/reset lines only when bits and descriptions are strong', () => {
    // bits >= 2 + desc 齐备 + 标题规范 = confidence 1+1+1 = 3 达门槛。
    const text = [
      '  Status register (ST_REG)',
      '  Bit 1 TXE: transmit empty',
      '  Bit 0 RXNE: receive not empty',
    ].join('\n')
    expect(extractRegisterTables(pages(text))).toHaveLength(1)
  })

  it('skips the peripheral field when the name prefix does not appear in the title', () => {
    const text = [
      '  Mysterious register (ZZ9_PLURAL)',
      '  Address offset: 0x04',
      '  Bit 1 A: alpha',
      '  Bit 0 B: beta',
    ].join('\n')
    const table = extractRegisterTables(pages(text))[0]
    expect(table.name).toBe('ZZ9_PLURAL')
    expect(table.peripheral).toBeUndefined()
  })
})

describe('service.registers (extract injected)', () => {
  let root: string
  let cacheDir: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ds-regs-'))
    cacheDir = path.join(root, '.datasheet-mcp')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeService(extractor: string | null) {
    writeFileSync(path.join(root, 'rm.pdf'), '%PDF-1.4')
    return new DatasheetService(root, new DatasheetCache(cacheDir), {
      findExtractor: () => Promise.resolve(extractor),
      extract: () => Promise.resolve(USB_CNTR_TEXT),
    })
  }

  it('finds tables by case-insensitive substring of the register name', async () => {
    const result = await makeService('pdftotext').registers('usb')
    expect(result.found).toBe(true)
    expect(result.tables).toHaveLength(1)
    expect(result.tables[0]).toMatchObject({ path: 'rm.pdf', name: 'USB_CNTR', offset: '0x40' })
  })

  it('reports found=false when nothing matches', async () => {
    const result = await makeService('pdftotext').registers('ZZ_NOPE')
    expect(result.found).toBe(false)
    expect(result.tables).toEqual([])
  })

  it('rejects a blank query and a missing extractor explicitly', async () => {
    await expect(makeService('pdftotext').registers('   ')).rejects.toMatchObject({
      code: 'empty_query',
    })
    await expect(makeService(null).registers('usb')).rejects.toMatchObject({
      code: 'extractor_missing',
    })
  })

  it('returns the tables of a named file, optionally filtered by page', async () => {
    const service = makeService('pdftotext')
    const all = await service.registersAt('rm.pdf')
    expect(all.found).toBe(true)
    expect(all.tables).toHaveLength(1)
    const page1 = await service.registersAt('rm.pdf', 1)
    expect(page1.tables).toHaveLength(1)
    const page2 = await service.registersAt('rm.pdf', 2)
    expect(page2.found).toBe(false)
    expect(page2.tables).toEqual([])
  })

  it('keeps the path rules of datasheet_read (absolute and .. rejected)', async () => {
    const service = makeService('pdftotext')
    await expect(service.registersAt(path.join(root, 'rm.pdf'))).rejects.toMatchObject({
      code: 'path_denied',
    })
    await expect(service.registersAt('../x.pdf')).rejects.toMatchObject({ code: 'path_denied' })
    await expect(service.registersAt('ghost.pdf')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('service.registers (real pdftotext)', () => {
  it.skipIf(!hasExtractor)('extracts a real table from a generated PDF', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ds-regs-real-'))
    try {
      writeFileSync(
        path.join(root, 'rm.pdf'),
        makeTextPdf([['USB control register (USB_CNTR)', 'Address offset: 0x40', 'Reset value: 0x0003', 'Bit 15 CTRM: Correct transfer interrupt mask', 'Bit 14 PMAOVRM: Overrun mask', 'Bit 13 ERRM: Error mask']]),
      )
      const service = new DatasheetService(
        root,
        new DatasheetCache(path.join(root, '.datasheet-mcp')),
      )
      const result = await service.registers('CNTR')
      expect(result.found).toBe(true)
      expect(result.tables[0]).toMatchObject({ name: 'USB_CNTR', offset: '0x40', sourcePage: 1 })
      expect(result.tables[0].bits).toHaveLength(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})