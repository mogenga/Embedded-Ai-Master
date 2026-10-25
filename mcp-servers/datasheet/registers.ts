import type { DatasheetCacheEntry } from './cache.js'

export interface RegisterBitField {
  name: string
  msb: number
  lsb: number
  /** 位域描述（"Bit 15 CTRM: Correct transfer..." 冒号后的原文）。 */
  desc?: string
}

export interface RegisterTable {
  /** 寄存器名（标题括号里的全大写标识符，如 USB_CNTR）。 */
  name: string
  /** 外设前缀（regname 首个下划线前段，且标题文本里出现过；不可靠时省略）。 */
  peripheral?: string
  /** 原文形态的偏移（如 "0x40"）。 */
  offset?: string
  /** 原文形态的复位值（如 "0x0003"）。 */
  resetValue?: string
  bits: RegisterBitField[]
  /** 标题行所在页（1-based）。 */
  sourcePage: number
  /** 置信度分：越高越可信；低于门槛的表不产出（宁缺毋滥）。 */
  confidence: number
}

/** 产出一张表的最低置信分。 */
const MIN_CONFIDENCE = 3
const MAX_BIT_INDEX = 31
/** 标题之后 offset/reset 行仍算数的最大行距（跳过表格图形行）。 */
const META_LINE_DISTANCE = 12

// 标题行：`... (USB_CNTR)` —— 括号内全大写标识符（带下划线的多段名，首段
// 允许 2 字符如 ST_REG；或 ≥4 字符纯字母）且行尾结束（目录行带点线页码，
// 不满足行尾条件，天然排除）。
const TITLE_PATTERN = /\(([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{4,})\)\s*$/
const OFFSET_PATTERN = /Address offset:\s*(0x[0-9A-Fa-f]+)/
// 复位值可能是 "0x0000 0000"（空格分组的 32 位写法），整段保留。
const RESET_PATTERN = /Reset value:\s*(0x[0-9A-Fa-f]+(?:\s+[0-9A-Fa-f]+)*)/
// 位域行：`Bit 15 CTRM: ...` / `Bits 2:0 LATENCY: ...` / `Bits 26:24 SWJ_CFG[2:0]: ...`
// （名字可带 [x:y] 位宽注记，RM0008 的 AFIO_MAPR 实测形态）。
const BIT_FIELD_PATTERN =
  /^\s*Bits?\s+(\d+)(?::(\d+))?\s+([A-Za-z_][A-Za-z0-9_]*(?:\[[0-9]+:[0-9]+\])?)\s*:\s*(.*)$/

interface PendingTable {
  name: string
  titleText: string
  sourcePage: number
  titleLine: number
  offset?: string
  resetValue?: string
  bits: RegisterBitField[]
}

/**
 * 从 -layout 页文本提取 ST 风格寄存器表（启发式、无 LLM）。
 *
 * 依赖的三个稳定版式（RM0008 Rev21 / RM0090 Rev22 实测同构）：
 *   1. 标题行 `Xxx register (REG_NAME)`；
 *   2. 元信息行 `Address offset: 0x..` / `Reset value: 0x..`；
 *   3. 位域行 `Bit n NAME: desc` / `Bits msb:lsb NAME: desc`——逐行正则即可
 *      解析，不需要列对齐推断（列对齐只影响位号图，不影响位域行本身）。
 *
 * 置信度门槛（identifyGate 哲学：低置信宁可不产出，假阳性直接误导用户）：
 *   必要条件：≥2 个位域、全部 msb ≤ 31、msb 序列大体降序、位域名不重复；
 *   加分项：offset 行 +2、reset 行 +1、标题行规范 +1、位域带描述 +1。
 */
export function extractRegisterTables(entry: DatasheetCacheEntry): RegisterTable[] {
  const linesWithPage: Array<{ text: string; page: number }> = []
  entry.pages.forEach((pageText, pageIndex) => {
    for (const text of pageText.split('\n')) {
      linesWithPage.push({ text, page: pageIndex + 1 })
    }
  })

  const tables: RegisterTable[] = []
  let pending: PendingTable | null = null

  const flush = (): void => {
    if (pending === null) return
    const table = finalizeTable(pending)
    if (table !== null) tables.push(table)
    pending = null
  }

  for (let i = 0; i < linesWithPage.length; i++) {
    const { text, page } = linesWithPage[i]
    // 页眉/页脚行带文档号（RM0008 ... / ... RM0090 Rev 22）：它们行尾常是
    // 章节名的 "(USB)"，会抢占真标题。含手册号的行一律不当标题。
    if (/\bRM0\d{3}\b/.test(text)) continue
    const title = text.match(TITLE_PATTERN)
    if (title !== null && !/\.\s*\.\s*\.\s*\d+\s*$/.test(text)) {
      if (pending !== null && pending.bits.length > 0) flush()
      // bits=0 的旧 pending（页眉残留或无位域的杂项括号行）直接被覆盖。
      pending = {
        name: title[1],
        titleText: text,
        sourcePage: page,
        titleLine: i,
        bits: [],
      }
      continue
    }
    if (pending === null) continue
    const distance = i - pending.titleLine
    if (distance <= META_LINE_DISTANCE) {
      const offset = text.match(OFFSET_PATTERN)
      if (offset !== null && pending.offset === undefined) {
        pending.offset = offset[1]
        continue
      }
      const reset = text.match(RESET_PATTERN)
      if (reset !== null && pending.resetValue === undefined) {
        pending.resetValue = reset[1]
        continue
      }
    }
    const bitField = text.match(BIT_FIELD_PATTERN)
    if (bitField !== null) {
      const msb = Number(bitField[1])
      const lsb = bitField[2] === undefined ? msb : Number(bitField[2])
      const desc = (bitField[4] ?? '').trim()
      pending.bits.push({
        name: bitField[3],
        msb,
        lsb,
        ...(desc !== '' ? { desc } : {}),
      })
    }
  }
  flush()
  return tables
}

function finalizeTable(pending: PendingTable): RegisterTable | null {
  const { bits } = pending
  if (bits.length < 2) return null
  if (bits.some((bit) => bit.msb > MAX_BIT_INDEX || bit.lsb > bit.msb)) return null
  // ST 表按段降序（从高位往低位）；AFIO_MAPR 这类「密度/连通型分段」表有
  // 两段、各自从高位重新开始。msb 上升沿 = 新段；超过 2 段按噪声丢弃。
  let segments = 1
  const segmentOf: number[] = []
  for (let i = 0; i < bits.length; i++) {
    if (i > 0 && bits[i].msb > bits[i - 1].msb) segments += 1
    segmentOf.push(segments)
  }
  if (segments > 2) return null
  // 重名只在同段内才算噪声（跨段是密度变体对同一位的重复定义）。
  const seen = new Set<string>()
  for (let i = 0; i < bits.length; i++) {
    const key = `${segmentOf[i]}:${bits[i].name}`
    if (seen.has(key)) return null
    seen.add(key)
  }

  let confidence = 1
  if (pending.offset !== undefined) confidence += 2
  if (pending.resetValue !== undefined) confidence += 1
  if (pending.titleText.trim().length > 0) confidence += 1
  if (bits.filter((bit) => bit.desc !== undefined && bit.desc !== '').length >= bits.length / 2) {
    confidence += 1
  }
  if (confidence < MIN_CONFIDENCE) return null

  const peripheral = peripheralOf(pending.name, pending.titleText)
  return {
    name: pending.name,
    ...(peripheral !== undefined ? { peripheral } : {}),
    ...(pending.offset !== undefined ? { offset: pending.offset } : {}),
    ...(pending.resetValue !== undefined ? { resetValue: pending.resetValue } : {}),
    bits: pending.bits,
    sourcePage: pending.sourcePage,
    confidence,
  }
}

/**
 * regname 首个下划线前段，且出现在标题的**括号外**文本里（括号内必含全名，
 * 用全名校验恒真）。"USB control register (USB_CNTR)" → USB；
 * "AF remap register (AFIO_MAPR)" → 括号外无 AFIO，省略。
 */
function peripheralOf(name: string, titleText: string): string | undefined {
  const underscore = name.indexOf('_')
  if (underscore < 2) return undefined
  const prefix = name.slice(0, underscore)
  const outside = titleText.replace(/\([^)]*\)\s*$/, '')
  if (outside.toLowerCase().includes(prefix.toLowerCase())) return prefix
  return undefined
}