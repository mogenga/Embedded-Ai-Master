import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { makeImageOnlyPdf, makeTextPdf } from './fixtures.js'
import { extractPdfText, findPdfExtractor } from '../pdf.js'

// 顶层探测一次：有提取器的机器跑真实提取，没有的机器整组 skip（对齐 kb
// 语料缺失即 skip 的先例——不伪造，也不让 CI 依赖 pdftotext）。
const hasExtractor = (await findPdfExtractor()) !== null

describe('findPdfExtractor', () => {
  it('reports ENOENT as null when PATH holds no pdftotext', async () => {
    // `-v` 恒非零退出码；探测信号是「可执行文件是否存在」。空 PATH 下
    // spawn 直接 ENOENT——这就是「没装」的路径，全平台可测。
    const result = await findPdfExtractor({ PATH: path.join(tmpdir(), 'definitely-empty') })
    expect(result).toBeNull()
  })

  it('returns the command name or null on this machine, never a fabrication', async () => {
    const result = await findPdfExtractor()
    expect(['pdftotext', null]).toContain(result)
  })
})

describe('extractPdfText (requires pdftotext)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-pdf-'))
  const textPdf = path.join(dir, 'text.pdf')

  it.skipIf(!hasExtractor)(
    'extracts text pages split by form feeds',
    async () => {
      writeFileSync(
        textPdf,
        makeTextPdf([
          ['RM0008 Reference Manual', 'USART2 base 0x40004400 CR1 at offset 0x00'],
          ['USB_BCDR register', 'Bits 31:16 must be kept at reset value'],
        ]),
      )
      const text = await extractPdfText(textPdf)
      expect(text).not.toBeNull()
      const pages = (text as string).split('\f')
      expect(pages[0]).toContain('USART2')
      expect(pages[1]).toContain('USB_BCDR')
    },
  )

  it.skipIf(!hasExtractor)(
    'returns empty text for an image-only PDF (no text layer)',
    async () => {
      const imagePdf = path.join(dir, 'image.pdf')
      writeFileSync(imagePdf, makeImageOnlyPdf())
      const text = await extractPdfText(imagePdf)
      expect(text).not.toBeNull()
      expect((text as string).trim()).toBe('')
    },
  )

  it.skipIf(!hasExtractor)('returns null for a missing file', async () => {
    expect(await extractPdfText(path.join(dir, 'nope.pdf'))).toBeNull()
  })
})
