/**
 * 测试夹具：手工生成的最小合法 PDF。
 *
 * 为什么不用二进制 fixture 入库：语料/二进制不入库是本仓库先例（kb 的
 * data/ 目录 gitignore），而 CI 机器上有没有 pdftotext 不可假设——生成器
 * 让「文本层 PDF」与「纯图 PDF」都能在 setUp 里现场产出，配合 skipIf
 * 实现同一套用例在有无提取器的机器上都成立。
 */

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

interface PdfObject {
  id: number
  body: string
}

function contentStream(pageLines: string[]): string {
  const lines = pageLines
    .map((line) => `(${escapePdfText(line)}) Tj\nT*`)
    .join('\n')
  return `BT\n/F1 10 Tf\n72 720 Td\n14 TL\n${lines}\nET`
}

function wrapStreamObject(content: string): string {
  return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
}

/** 页文本是绘图指令（无 BT/ET 文本对象）：pdftotext 输出为空，模拟扫描件。 */
const IMAGE_ONLY_CONTENT = `1 0 0 RG
2 w
100 700 m
500 700 l
100 200 m
500 200 l
S`

function assemblePdf(objects: PdfObject[]): Buffer {
  const ids = objects.map((object) => object.id)
  const maxId = Math.max(...ids)
  let out = '%PDF-1.4\n'
  const offsets = new Map<number, number>()
  for (const object of objects) {
    offsets.set(object.id, out.length)
    out += `${object.id} 0 obj\n${object.body}\nendobj\n`
  }
  const xrefOffset = out.length
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= maxId; id++) {
    const offset = offsets.get(id)
    if (offset === undefined) throw new Error(`PDF fixture missing object ${id}`)
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  out += `${xref}trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

/** 每页由若干行文本组成（pageLines[pageIndex] = 行数组）。 */
export function makeTextPdf(pageLines: string[][]): Buffer {
  const pageIds: number[] = []
  const objects: PdfObject[] = [
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
    { id: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ]
  let nextId = 4
  for (const lines of pageLines) {
    const pageId = nextId++
    const contentId = nextId++
    pageIds.push(pageId)
    objects.push({
      id: pageId,
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    })
    objects.push({ id: contentId, body: wrapStreamObject(contentStream(lines)) })
  }
  objects[1] = {
    id: 2,
    body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  }
  return assemblePdf(objects)
}

/** 无文本层的一页（只有绘图指令）：pdftotext 提取结果为空字符串。 */
export function makeImageOnlyPdf(): Buffer {
  const objects: PdfObject[] = [
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { id: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>' },
    { id: 4, body: wrapStreamObject(IMAGE_ONLY_CONTENT) },
  ]
  return assemblePdf(objects)
}