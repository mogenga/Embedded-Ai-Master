import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { DatasheetCache } from './cache.js'
import type { DatasheetCacheEntry } from './cache.js'
import { scorePages, tokenize } from './bm25.js'
import { extractPdfText, findPdfExtractor } from './pdf.js'
import { extractRegisterTables } from './registers.js'
import type { RegisterTable } from './registers.js'

export class DatasheetServiceError extends Error {
  constructor(
    readonly code: DatasheetServiceErrorCode,
    message: string,
    /** 机器可读的补充事实（如 page_out_of_range 附 total），只用于如实报告。 */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DatasheetServiceError'
  }
}

export type DatasheetServiceErrorCode =
  | 'path_denied'
  | 'not_found'
  | 'file_too_large'
  | 'extractor_missing'
  | 'no_text_layer'
  | 'extract_failed'
  | 'page_out_of_range'
  | 'page_range_too_large'
  | 'empty_query'

export interface DatasheetFileMeta {
  /** 相对检索根，POSIX 分隔符。 */
  path: string
  /** 仅当缓存已有条目时报页数——列目录不触发提取。 */
  pages?: number
  /** 列举阶段就能确定的不索引原因（当前只有 too large）。 */
  skipped?: 'too_large'
}

export interface DatasheetListResult {
  files: DatasheetFileMeta[]
  /** 预算截停（≤200 文件）：files.length 是下界，未命中不等于不存在。 */
  scanTruncated: boolean
}

export interface DatasheetHit {
  path: string
  page: number
  excerpt: string
  /** BM25 + 短语加成的混合分：排序依据，如实可见。 */
  score?: number
}

export interface DatasheetSkip {
  path: string
  reason: string
}

export interface DatasheetSearchResult {
  hits: DatasheetHit[]
  /** 无法索引/无法检索的文件与原因：提取器缺失（附安装命令）、过大、无文本层。 */
  skipped: DatasheetSkip[]
  extractor: string | null
}

export interface DatasheetPageText {
  page: number
  text: string
}

export interface DatasheetReadResult {
  path: string
  page: number
  pageEnd: number
  pages: DatasheetPageText[]
  /** 文件总页数：页码越界时报给调用方，也是续读的依据。 */
  total: number
  /** 512KiB 输出预算用完：还有后续页未返回，应收窄页范围续读。 */
  truncated: boolean
}

export interface DatasheetStatus {
  root: string
  extractor: string | null
  cacheDir: string
  cacheEntries: number
  fileCount: number
  scanTruncated: boolean
}

/** 寄存器表查询结果：每张表带所属文件相对路径与来源页（D15）。 */
export interface DatasheetRegisterTableRef extends RegisterTable {
  path: string
}

export interface DatasheetRegistersResult {
  found: boolean
  query?: string
  page?: number
  tables: DatasheetRegisterTableRef[]
}

export interface DatasheetServiceOptions {
  /** 仅供测试注入更小的预算；生产用缺省值。 */
  maxFiles?: number
  maxDepth?: number
  maxBytes?: number
  /**
   * 提取器探测注入位（测试用）：不传时每次调用真实探测 `pdftotext -v`。
   * service 不缓存探测结果，环境装上 poppler 后无需重启即可生效。
   */
  findExtractor?: () => Promise<string | null>
  /** 文本提取注入位（测试用）：不传时用 pdf.ts 的 extractPdfText。 */
  extract?: (file: string) => Promise<string | null>
}

/** A 侧的既定值：200 个文件、6 层、80 MiB。 */
const MAX_FILES = 200
const MAX_DEPTH = 6
const MAX_BYTES = 80 * 1024 * 1024
/** A 侧安装指引原话（winget / MiKTeX 两条路），一条不删。 */
export const EXTRACTOR_INSTALL_HINT =
  "pdftotext is not installed (winget install oschwartz10612.Poppler, or use MiKTeX's copy)"
const DEFAULT_SEARCH_LIMIT = 12
const MAX_SEARCH_LIMIT = 50
const DEFAULT_REGISTERS_LIMIT = 10
/** readPages 的输出预算：单次 ≤50 页、累计 ≤512KiB（对齐 B 的输出限额惯例）。 */
const MAX_READ_PAGES = 50
const MAX_READ_BYTES = 512 * 1024
/** excerpt 窗口：命中点前 120、后 200 字符（A 侧原值）。 */
const EXCERPT_BEFORE = 120
const EXCERPT_AFTER = 200

/**
 * D11 领域同义词表：查询含一侧短语时把另一侧的 token 追加进查询（不替换，
 * 原词保留）。中文侧在 ASCII tokenize 下天然为空 token，所以这条主要服务
 * 「中文查询 → 英文手册」的 BM25 打分；反向（英文查询加中文 token）无害。
 */
const TERM_SYNONYMS: ReadonlyArray<readonly [string, string]> = [
  ['alternate function', 'AF'],
  ['reset value', '复位值'],
  ['reset', '复位'],
  ['register', '寄存器'],
  ['interrupt', '中断'],
  ['flag', '标志'],
  ['enable', '使能'],
  ['disable', '禁用'],
  ['clock', '时钟'],
  ['prescaler', '分频'],
  ['baud rate', '波特率'],
  ['watchdog', '看门狗'],
  ['timer', '定时器'],
  ['counter', '计数器'],
  ['capture', '捕获'],
  ['compare', '比较'],
  ['output', '输出'],
  ['input', '输入'],
  ['pull-up', '上拉'],
  ['pull-down', '下拉'],
  ['push-pull', '推挽'],
  ['open-drain', '开漏'],
  ['threshold', '阈值'],
  ['offset', '偏移'],
  ['mask', '掩码'],
  ['endpoint', '端点'],
  ['descriptor', '描述符'],
  ['flash', '闪存'],
  ['pending', '挂起'],
  ['overflow', '溢出'],
]

/** 查询 token 化 + 同义词展开（D11）。短语匹配统一在小写域做。 */
export function expandQueryTokens(query: string): string[] {
  const lower = query.toLowerCase()
  const tokens = new Set(tokenize(query))
  for (const [one, other] of TERM_SYNONYMS) {
    const left = one.toLowerCase()
    const right = other.toLowerCase()
    if (lower.includes(left)) for (const token of tokenize(other)) tokens.add(token)
    if (lower.includes(right)) for (const token of tokenize(one)) tokens.add(token)
  }
  return [...tokens]
}

type IndexedFile =
  | { kind: 'ok'; entry: DatasheetCacheEntry }
  | { kind: 'missing' }
  | { kind: 'too_large' }
  | { kind: 'extract_failed' }

/**
 * 数据手册检索服务。
 *
 * 能力面与 A 侧 datasheet.ts 1:1 对齐（探测/缓存/整短语匹配/诚实 skipped），
 * 新增 readPages：检索命中后读整页上下文是刚需（业界三个同类方案全部提供）。
 */
export class DatasheetService {
  private readonly root: string
  private readonly cache: DatasheetCache
  private readonly maxFiles: number
  private readonly maxDepth: number
  private readonly maxBytes: number
  private readonly findExtractor: () => Promise<string | null>
  private readonly extract: (file: string) => Promise<string | null>

  constructor(root: string, cache: DatasheetCache, options: DatasheetServiceOptions = {}) {
    this.root = path.resolve(root)
    this.cache = cache
    this.maxFiles = options.maxFiles ?? MAX_FILES
    this.maxDepth = options.maxDepth ?? MAX_DEPTH
    this.maxBytes = options.maxBytes ?? MAX_BYTES
    this.findExtractor = options.findExtractor ?? findPdfExtractor
    this.extract = options.extract ?? extractPdfText
  }

  /**
   * 列出检索根下的全部 PDF 元数据。
   *
   * 只 stat、不提取——列目录不应触发一次 30 秒的 pdftotext。缓存里已有的
   * 文件顺带报页数，其余字段（pages）留空直到首次检索。
   */
  listDatasheets(): DatasheetListResult {
    const walk = this.walkPdfFiles()
    const files: DatasheetFileMeta[] = []
    for (const file of walk.files) {
      const info = this.statFile(file)
      if (info === null) {
        files.push({ path: this.relativePath(file) })
        continue
      }
      if (info.size > this.maxBytes) {
        files.push({ path: this.relativePath(file), skipped: 'too_large' })
        continue
      }
      const cached = this.cache.load(file, this.stampOf(info))
      files.push({
        path: this.relativePath(file),
        ...(cached ? { pages: cached.pages.length } : {}),
      })
    }
    return { files, scanTruncated: walk.truncated }
  }

  /**
   * BM25 检索（D10/D13）：页级 token 化 + 整短语子串加成，混合分全局排序。
   * 每份文件报最高分的一页；excerpt 窗口语义与 A 相同（命中点前 120、
   * 后 200）。用户要的是页码，不是同一句话的每个位置。
   */
  async search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): Promise<DatasheetSearchResult> {
    const needle = query.trim().toLowerCase()
    const extractor = await this.findExtractor()
    if (!needle) return { hits: [], skipped: [], extractor }
    if (!extractor) {
      // A 的诚实设计：提取器缺失报安装命令，不返回看起来像「无命中」的空结果。
      return { hits: [], skipped: [{ path: '.', reason: EXTRACTOR_INSTALL_HINT }], extractor: null }
    }
    const cappedLimit = Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT)
    const queryTokens = [...new Set(expandQueryTokens(query))]
    // 拒答防线（负例误报的控制）：查询的每个 token 都必须在至少一份文件里
    // 出现，否则整条查询如实返回无命中。乱拼寄存器名（GPIO_CRLX）的特异
    // token（crlx）全语料零命中——返回只含泛词（GPIO）的页比无命中更误导。
    // 文档自己的通配记号（如 ODRx/DHRx）是真出现，不在此列。
    const tokenSeen = new Set<string>()
    const hits: DatasheetHit[] = []
    const skipped: DatasheetSkip[] = []
    // 混合排序要先全量打分再截断，不能像 A 那样命中即停。
    for (const file of this.walkPdfFiles().files) {
      const indexed = await this.indexFile(file)
      if (indexed.kind === 'missing') continue
      if (indexed.kind === 'too_large') {
        skipped.push({
          path: this.relativePath(file),
          reason: `file is larger than ${Math.floor(this.maxBytes / (1024 * 1024))} MiB and was skipped`,
        })
        continue
      }
      if (indexed.kind === 'extract_failed') {
        skipped.push({
          path: this.relativePath(file),
          reason: 'could not extract text (unreadable or corrupted PDF)',
        })
        continue
      }
      if (indexed.entry.empty) {
        // 扫描件：如实报「无文本层」，且缓存里的 empty 标记让下一次查询不再重提取。
        skipped.push({
          path: indexed.entry.path,
          reason: 'the PDF has no text layer (scanned images cannot be searched)',
        })
        continue
      }
      const scored = scorePages(indexed.entry.pages, query)
      for (const token of queryTokens) {
        if (tokenSeen.has(token)) continue
        const boundary = this.tokenBoundaryPattern(token)
        if (indexed.entry.pages.some((page) => boundary.test(page))) tokenSeen.add(token)
      }
      const top = scored[0]
      if (top === undefined) continue
      const pageText = indexed.entry.pages[top.page]
      const at = this.excerptAnchor(pageText, needle, queryTokens)
      const start = Math.max(0, at - EXCERPT_BEFORE)
      const excerpt = pageText
        .slice(start, at + needle.length + EXCERPT_AFTER)
        .replace(/\s+/g, ' ')
        .trim()
      hits.push({ path: indexed.entry.path, page: top.page + 1, excerpt, score: top.score })
    }
    hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.page - b.page)
    // 任一查询 token 全语料零出现：如实返回无命中，不把泛词页当答案。
    if (queryTokens.length > 0 && queryTokens.some((token) => !tokenSeen.has(token))) {
      return { hits: [], skipped, extractor }
    }
    return { hits: hits.slice(0, cappedLimit), skipped, extractor }
  }

  /** excerpt 的命中锚点：整短语优先，否则首个出现的查询 token。 */
  private excerptAnchor(pageText: string, needle: string, queryTokens: string[]): number {
    const lower = pageText.toLowerCase()
    const at = needle !== '' ? lower.indexOf(needle) : -1
    if (at >= 0) return at
    for (const token of queryTokens) {
      const tokenAt = lower.indexOf(token)
      if (tokenAt >= 0) return tokenAt
    }
    return 0
  }

  /**
   * token 的词边界模式（缓存）：`crx` 不算出现在 `ccrx` 里，`cr3` 算出现在
   * `USART_CR3` 里（`_` 是边界）。kb/service.ts 同款思路的另一份实现——
   * MCP server 不能 import 内核，两份各自演化。
   */
  private readonly boundaryPatterns = new Map<string, RegExp>()

  private tokenBoundaryPattern(token: string): RegExp {
    let pattern = this.boundaryPatterns.get(token)
    if (pattern === undefined) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      pattern = new RegExp(`(^|[^0-9a-zA-Z])${escaped}([^0-9a-zA-Z]|$)`, 'i')
      this.boundaryPatterns.set(token, pattern)
    }
    return pattern
  }

  /**
   * 按相对路径 + 1-based 页码区间读整页文本。
   *
   * 这是检索命中后的上下文刚需；A 侧没有、业界同类方案全部提供。单次
   * ≤50 页、累计 ≤512KiB，超出置 truncated: true（不静默丢页）。
   */
  async readPages(file: string, page: number, pageEnd?: number): Promise<DatasheetReadResult> {
    const target = this.resolveInsideRoot(file)
    const last = pageEnd ?? page
    if (!Number.isInteger(page) || !Number.isInteger(last) || page < 1 || last < page) {
      throw new DatasheetServiceError('page_out_of_range', `invalid page range: ${page}..${last}`)
    }
    if (last - page + 1 > MAX_READ_PAGES) {
      throw new DatasheetServiceError(
        'page_range_too_large',
        `page range must span at most ${MAX_READ_PAGES} pages`,
      )
    }
    const info = this.statFile(target)
    if (info === null) throw new DatasheetServiceError('not_found', `no such file: ${file}`)
    if (info.size > this.maxBytes) {
      throw new DatasheetServiceError(
        'file_too_large',
        `file is larger than ${Math.floor(this.maxBytes / (1024 * 1024))} MiB and was skipped`,
      )
    }
    const extractor = await this.findExtractor()
    if (!extractor) {
      throw new DatasheetServiceError('extractor_missing', EXTRACTOR_INSTALL_HINT)
    }
    const indexed = await this.indexFile(target)
    if (indexed.kind === 'too_large') {
      throw new DatasheetServiceError('file_too_large', 'file is too large to index')
    }
    if (indexed.kind !== 'ok') {
      throw new DatasheetServiceError('extract_failed', 'could not extract text from this PDF')
    }
    if (indexed.entry.empty) {
      throw new DatasheetServiceError(
        'no_text_layer',
        'the PDF has no text layer (scanned images cannot be read as text)',
      )
    }
    const total = indexed.entry.pages.length
    if (page > total) {
      throw new DatasheetServiceError('page_out_of_range', `page ${page} is out of range`, {
        total,
      })
    }
    const end = Math.min(last, total)
    const pages: DatasheetPageText[] = []
    let used = 0
    let truncated = false
    for (let p = page; p <= end; p++) {
      const text = indexed.entry.pages[p - 1]
      if (used + text.length > MAX_READ_BYTES) {
        if (pages.length === 0) {
          pages.push({ page: p, text: text.slice(0, MAX_READ_BYTES) })
          truncated = true
          break
        }
        truncated = true
        break
      }
      pages.push({ page: p, text })
      used += text.length
    }
    if (end < last && pages.length > 0) truncated = true
    return { path: this.relativePath(target), page, pageEnd: end, pages, total, truncated }
  }

  async status(): Promise<DatasheetStatus> {
    const extractor = await this.findExtractor()
    const list = this.listDatasheets()
    return {
      root: this.root,
      extractor,
      cacheDir: this.cache.directory,
      cacheEntries: this.cache.count(),
      fileCount: list.files.length,
      scanTruncated: list.scanTruncated,
    }
  }

  /**
   * 按寄存器名查结构化寄存器表（D15）。
   *
   * 匹配是大小写不敏感的包含式（`usb` 命中 USB_CNTR）；低置信度的表在
   * 提取阶段就被丢掉（宁缺毋滥）——返回的每张表都带 sourcePage，引用前
   * 应再用 datasheet_read 核对原文。
   */
  async registers(query: string, limit: number = DEFAULT_REGISTERS_LIMIT): Promise<DatasheetRegistersResult> {
    const needle = query.trim().toLowerCase()
    if (!needle) {
      throw new DatasheetServiceError('empty_query', 'register query must not be blank')
    }
    const extractor = await this.findExtractor()
    if (!extractor) {
      throw new DatasheetServiceError('extractor_missing', EXTRACTOR_INSTALL_HINT)
    }
    const tables: DatasheetRegisterTableRef[] = []
    for (const file of this.walkPdfFiles().files) {
      if (tables.length >= limit) break
      const indexed = await this.indexFile(file)
      if (indexed.kind !== 'ok') continue
      if (indexed.entry.empty) continue
      for (const table of extractRegisterTables(indexed.entry)) {
        if (tables.length >= limit) break
        if (table.name.toLowerCase().includes(needle)) {
          tables.push({ path: indexed.entry.path, ...table })
        }
      }
    }
    return { found: tables.length > 0, query, tables }
  }

  /**
   * 指名文件（可选页）返回该处的结构化寄存器表：检索命中后精读指定页用。
   */
  async registersAt(file: string, page?: number): Promise<DatasheetRegistersResult> {
    if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
      throw new DatasheetServiceError('page_out_of_range', `invalid page: ${page}`)
    }
    const target = this.resolveInsideRoot(file)
    const info = this.statFile(target)
    if (info === null) throw new DatasheetServiceError('not_found', `no such file: ${file}`)
    if (info.size > this.maxBytes) {
      throw new DatasheetServiceError('file_too_large', 'file is too large to index')
    }
    const extractor = await this.findExtractor()
    if (!extractor) {
      throw new DatasheetServiceError('extractor_missing', EXTRACTOR_INSTALL_HINT)
    }
    const indexed = await this.indexFile(target)
    if (indexed.kind !== 'ok') {
      throw new DatasheetServiceError('extract_failed', 'could not extract text from this PDF')
    }
    if (indexed.entry.empty) {
      throw new DatasheetServiceError(
        'no_text_layer',
        'the PDF has no text layer (scanned images cannot be parsed for registers)',
      )
    }
    const all = extractRegisterTables(indexed.entry)
    const tables = (page === undefined ? all : all.filter((t) => t.sourcePage === page)).map(
      (table) => ({ path: indexed.entry.path, ...table }),
    )
    return {
      found: tables.length > 0,
      ...(page === undefined ? {} : { page }),
      tables,
    }
  }

  /**
   * 检索根内解析相对路径；拒绝绝对路径与 `..` 越界（照 kb_read 的口径）。
   */
  private resolveInsideRoot(file: string): string {
    if (path.isAbsolute(file)) {
      throw new DatasheetServiceError('path_denied', 'absolute paths are not allowed')
    }
    const resolved = path.resolve(this.root, file)
    const rel = path.relative(this.root, resolved)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new DatasheetServiceError('path_denied', `path escapes the datasheet root: ${file}`)
    }
    return resolved
  }

  private relativePath(file: string): string {
    return path.relative(this.root, file).split('\\').join('/')
  }

  private statFile(file: string): { size: number; mtimeMs: number } | null {
    try {
      const info = statSync(file)
      if (!info.isFile()) return null
      return { size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return null
    }
  }

  private stampOf(info: { mtimeMs: number; size: number }): string {
    return `${info.mtimeMs}:${info.size}`
  }

  /** 载入或构建一份文件的页索引（缓存命中时零提取成本）。 */
  private async indexFile(file: string): Promise<IndexedFile> {
    const info = this.statFile(file)
    if (info === null) return { kind: 'missing' }
    if (info.size > this.maxBytes) return { kind: 'too_large' }
    const stamp = this.stampOf(info)
    const cached = this.cache.load(file, stamp)
    if (cached !== null) {
      return { kind: 'ok', entry: cached }
    }
    const text = await this.extract(file)
    if (text === null) return { kind: 'extract_failed' }
    const rawPages = text.split('\f').map((page) => page.replace(/\r\n/g, '\n'))
    // pdftotext 在最后一页后也输出一个 \f：split 出的尾空段不是真页。丢弃
    // 它，页码才与 PDF 阅读器的页码一致（readPages 的 total 是给续读用的）。
    if (rawPages.length > 1 && rawPages[rawPages.length - 1].trim() === '') rawPages.pop()
    const pages = rawPages
    const entry: DatasheetCacheEntry = {
      path: this.relativePath(file),
      pages,
      ...(text.trim() ? {} : { empty: true }),
    }
    this.cache.store(file, entry, stamp)
    return { kind: 'ok', entry }
  }

  /**
   * 检索根下的全部 PDF：≤maxDepth 层、跳 `.` 开头目录（含缓存目录
   * `.datasheet-mcp/`，防自吃）与 node_modules。A 侧的既定遍历规则。
   * truncated 置 true 表示预算截停——文件数是下界，未列出不等于不存在。
   */
  private walkPdfFiles(): { files: string[]; truncated: boolean } {
    const out: string[] = []
    let truncated = false
    const walk = (dir: string, depth: number): void => {
      if (depth > this.maxDepth) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= this.maxFiles) {
          truncated = true
          return
        }
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        if (path.extname(entry.name).toLowerCase() === '.pdf') out.push(full)
      }
    }
    walk(this.root, 0)
    return { files: out, truncated }
  }
}