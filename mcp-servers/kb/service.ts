import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { parseFrontmatter, parseIndexYaml } from './yaml.js'
import type { IndexEntry } from './yaml.js'
import { parseInbox } from './inbox.js'

export interface KbLookupCandidate {
  path: string
  title: string
  summary: string
  score: number
}

export interface KbLookupResult {
  found: boolean
  candidates: KbLookupCandidate[]
  reason?: 'no_match' | 'empty_query' | 'index_missing' | 'low_confidence'
}

export interface KbSearchHit {
  path: string
  line: number
  text: string
  token: string
}

export interface KbSearchResult {
  found: boolean
  hits: KbSearchHit[]
  // 遍历预算被用完时出现；此时 hits 只覆盖已扫描到的文件（R3：不静默）。
  scanTruncated?: boolean
}

export interface KbGlobResult {
  found: boolean
  matches: string[]
  count: number
  truncated: boolean
  // 遍历预算被用完（不是返回条数被截）：count/found 只代表已扫描到的部分。
  scanTruncated: boolean
}

export interface KbGrepHit {
  path: string
  line: number
  text: string
}

export interface KbGrepFileHits {
  path: string
  // 该文件的真实命中行数，不随返回条数截断。
  hits: number
}

export interface KbGrepResult {
  found: boolean
  hits: KbGrepHit[]
  count: number
  truncated: boolean
  // 命中集中在几个文件 vs 散落在很多文件——只是线索，不是置信度（D-179 ②）。
  fileCount: number
  files: KbGrepFileHits[]
  scanTruncated: boolean
}

export interface KbServiceOptions {
  // 仅供测试注入更小的遍历预算；生产一律用 MAX_WALK_FILES。
  maxWalkFiles?: number
  /**
   * `kb_propose` 写入的 inbox 文件（绝对路径或相对进程 cwd 的路径）。
   *
   * 不传时保持历史行为：写 `<root>/_inbox.md`。传了就把 inbox 挪到语料根之外
   * （OTA 部署形态是 `$HARNESS_HOME/kb/inbox/_inbox.md`，见 `docs/corpus-ota.md` §3）：
   * 快照会被整份替换，用户沉淀不能跟着被冲掉。`kb_status` 与 `kb_propose`
   * 都按这个位置读/写，不存在「写外部、读老位置」的分叉。
   */
  inboxPath?: string
}

export interface KbReadOptions {
  offset?: number
  limit?: number
}

export interface KbReadResult {
  path: string
  content: string
  offset: number
  lines: number
  totalLines: number
  truncated: boolean
  frontmatter?: Record<string, string | string[]>
  frontmatterParsed: boolean
  reviewStatus: 'reviewed' | 'unreviewed'
}

export interface KbStatus {
  root: string
  fileCount: number
  indexEntries: number
  indexPresent: boolean
  inboxPending: number
  inboxError?: string
  // inbox 的实际位置。默认形态是 `<root>/_inbox.md`；外部 inbox 时是绝对路径。
  // 报位置是 R3 要求：写在哪就必须能查到在哪，不能让人以为语料根里有一份。
  inboxPath: string
  // inbox 是否位于语料根之外（OTA 形态为 true）。外部 inbox 不经 kb_read 暴露。
  inboxExternal: boolean
  // 遍历预算被用完时出现；此时 fileCount 是「至少 N」（R3：不静默）。
  scanTruncated?: boolean
}

export type KbServiceErrorCode =
  | 'path_denied'
  | 'file_too_large'
  | 'not_found'
  | 'invalid_pattern'
  | 'invalid_regex'

export class KbServiceError extends Error {
  constructor(
    readonly code: KbServiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KbServiceError'
  }
}

const MAX_FILE_BYTES = 1024 * 1024
const ALLOWED_EXTENSIONS = new Set(['.md', '.yaml'])
const NAVIGATION_FILES = new Set(['_inbox.md', '_about.md'])
const INDEX_FILE = 'index.yaml'
const DEFAULT_LOOKUP_LIMIT = 2
const DEFAULT_SEARCH_LIMIT = 20
// 与实验 B 的工具面一致：grep/glob 单次最多 100 条，read 单次最多 2000 行。
const MAX_GLOB_MATCHES = 100
const MAX_GREP_HITS = 100
const GREP_TEXT_LIMIT = 300
// `files` 只列命中最多的前 10 个文件：模型要的是「集中还是散落」，不是完整清单。
const MAX_GREP_FILES = 10
// 单次遍历最多访问的文件数。远大于当前 108 文件语料，只是防止 KB_ROOT 被误指到
// 大目录时无限递归（旧实现的 walkFiles 既无上限也无忽略目录清单）。
const MAX_WALK_FILES = 20000
// 与内核 `src/tools/fs-walk.ts` 的 IGNORED_DIRS 同名子集。这里再写一遍是因为
// MCP server 不能 import 内核（那会把领域进程绑到平台层构建产物上），理由同 D-086。
const IGNORED_WALK_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.venv',
  'venv',
  '.next',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
])
const DEFAULT_READ_LINES = 2000
const MAX_READ_LINES = 2000
const GLOB_META_CHARS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])
// 内核 `src/tools/glob.ts` 的两个同值常量。这里再写一遍是因为 MCP server 不能
// import 内核（那会把领域进程绑到平台层的构建产物上）；值必须一致，理由见 D-086。
const MAX_PATTERN_LENGTH = 256
const MAX_PATTERN_SEGMENTS = 64
const TAG_WEIGHT = 2
const CONFIDENCE_THRESHOLD = 1.75
const OOV_PENALTY = 0.75
const TECH_COVERAGE_RATIO = 0.5
const MIN_CJK_HIT_CHARS = 4
const MIN_CJK_CONTEXT_CHARS = 2
const QUERY_TOKEN_PATTERN = /0x[0-9A-Fa-f]+|[A-Za-z_][A-Za-z0-9_]*/g
const CJK_PATTERN = /[\u4e00-\u9fff]/
const CJK_RUN_PATTERN = /[\u4e00-\u9fff]+/g
const PURE_ASCII_WORD = /^[A-Za-z][A-Za-z0-9_]*$/
const BOUNDARY_PATTERN_CACHE = new Map<string, RegExp>()
const ENGLISH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'should',
  'so',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
])
const GENERIC_TECH_TOKENS = new Set(['cpu', 'mcu', 'soc'])

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function boundaryPattern(token: string): RegExp {
  const cached = BOUNDARY_PATTERN_CACHE.get(token)
  if (cached !== undefined) return cached
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(token)}(?![A-Za-z0-9_])`,
    'i',
  )
  BOUNDARY_PATTERN_CACHE.set(token, pattern)
  return pattern
}

function matchesToken(needle: string, token: string): boolean {
  const normalized = token.trim().toLowerCase()
  if (normalized === '') return false
  if (CJK_PATTERN.test(normalized)) return needle.includes(normalized)
  if (PURE_ASCII_WORD.test(normalized) && normalized.length < 2) return false
  return boundaryPattern(normalized).test(needle)
}

function scoreEntry(entry: IndexEntry, needle: string): number {
  let score = 0
  for (const keyword of entry.keywords) {
    if (matchesToken(needle, keyword)) score += keyword.trim().length
  }
  for (const tag of entry.tags) {
    if (matchesToken(needle, tag)) score += TAG_WEIGHT
  }
  return score
}

function extractQueryTokens(query: string): string[] {
  const seen = new Set<string>()
  for (const match of query.matchAll(QUERY_TOKEN_PATTERN)) {
    const token = match[0].toLowerCase()
    if (token.length < 2) continue
    seen.add(token)
  }
  return [...seen]
}

function extractTechTokens(query: string): string[] {
  const seen = new Set<string>()
  for (const match of query.matchAll(QUERY_TOKEN_PATTERN)) {
    const raw = match[0]
    if (raw.length < 2) continue
    const normalized = raw.toLowerCase()
    if (seen.has(normalized)) continue
    if (GENERIC_TECH_TOKENS.has(normalized)) continue
    const isAcronym = /^[A-Z][A-Z0-9_]+$/.test(raw)
    if (!isAcronym && ENGLISH_STOPWORDS.has(normalized)) continue
    seen.add(normalized)
  }
  return [...seen]
}

function entrySearchText(entry: IndexEntry): string {
  return [entry.title, entry.summary, entry.path, ...entry.keywords, ...entry.tags]
    .join('\n')
    .toLowerCase()
}

function countTechCoverage(entry: IndexEntry, techTokens: string[]): number {
  if (techTokens.length === 0) return 0
  const text = entrySearchText(entry)
  let covered = 0
  for (const token of techTokens) {
    if (matchesToken(text, token)) covered += 1
  }
  return covered
}

function hasEnoughTechCoverage(covered: number, total: number): boolean {
  if (total === 0) return true
  if (covered === 0) return false
  if (total === 1) return true
  return covered / total > TECH_COVERAGE_RATIO
}

function countCjkChars(text: string): number {
  let count = 0
  for (const run of text.match(CJK_RUN_PATTERN) ?? []) count += [...run].length
  return count
}

interface CjkMatchStats {
  hitChars: number
  keywordCount: number
}

function cjkMatchStats(entry: IndexEntry, needle: string): CjkMatchStats {
  const seen = new Set<string>()
  let hitChars = 0
  for (const keyword of entry.keywords) {
    const normalized = keyword.trim().toLowerCase()
    if (normalized === '' || !CJK_PATTERN.test(normalized) || seen.has(normalized)) continue
    if (!needle.includes(normalized)) continue
    seen.add(normalized)
    hitChars += countCjkChars(normalized)
  }
  return { hitChars, keywordCount: seen.size }
}

function hasEnoughChineseConfidence(
  stats: CjkMatchStats,
  queryCjkChars: number,
): boolean {
  if (stats.hitChars >= MIN_CJK_HIT_CHARS) return true
  if (stats.keywordCount >= 2) return true
  return queryCjkChars - stats.hitChars >= MIN_CJK_CONTEXT_CHARS
}

function buildVocabulary(entries: IndexEntry[]): Set<string> {
  const vocabulary = new Set<string>()
  for (const entry of entries) {
    for (const token of [...entry.keywords, ...entry.tags]) {
      const normalized = token.trim().toLowerCase()
      if (normalized !== '') vocabulary.add(normalized)
    }
  }
  return vocabulary
}

function confidenceFactor(query: string, vocabulary: Set<string>): number {
  const tokens = extractQueryTokens(query)
  if (tokens.length === 0) return 1
  const known = tokens.filter((token) => vocabulary.has(token)).length
  const oovRatio = (tokens.length - known) / tokens.length
  return Math.max(0, 1 - OOV_PENALTY * oovRatio)
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

function isNavigationFile(relative: string): boolean {
  const base = path.posix.basename(relative)
  return NAVIGATION_FILES.has(base) || base === INDEX_FILE
}

function normalizePattern(pattern: string): string {
  const raw = pattern.trim()
  if (raw === '') {
    throw new KbServiceError('invalid_pattern', 'pattern 不能为空')
  }
  // 与内核 `src/tools/glob.ts` 的 MAX_PATTERN_LENGTH / MAX_PATTERN_SEGMENTS 同值：
  // 这不是审美限制，而是把 `(?:.*/)?` 的层数关进笼子。每一段 `**/` 都会给回溯
  // 多一个可选出口，长模式在匹配失败时是多项式级的（D-086 记的就是这一条）。
  if (raw.length > MAX_PATTERN_LENGTH) {
    throw new KbServiceError(
      'invalid_pattern',
      `pattern 超过 ${MAX_PATTERN_LENGTH} 字符上限: ${raw.length}`,
    )
  }
  if (
    path.isAbsolute(raw) ||
    /^[A-Za-z]:/.test(raw) ||
    raw.startsWith('/') ||
    raw.startsWith('\\')
  ) {
    throw new KbServiceError('path_denied', `pattern 必须是相对知识库根的路径: ${pattern}`)
  }

  const normalized = raw.replace(/\\/g, '/')
  const segments = normalized.split('/').filter((segment) => segment !== '')
  if (segments.some((segment) => segment === '..')) {
    throw new KbServiceError('path_denied', `pattern 不允许 .. 越界: ${pattern}`)
  }
  if (segments.length > MAX_PATTERN_SEGMENTS) {
    throw new KbServiceError(
      'invalid_pattern',
      `pattern 超过 ${MAX_PATTERN_SEGMENTS} 段上限: ${segments.length}`,
    )
  }
  return normalized
}

function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          // `**/` 允许零层目录，否则 protocols/**/*.md 会漏掉 protocols/x.md。
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
        continue
      }
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += GLOB_META_CHARS.has(char) ? `\\${char}` : char
  }
  return new RegExp(`^${source}$`)
}

function splitKeepingTerminators(content: string): string[] {
  if (content === '') return []
  return content.split(/(?<=\n)/)
}

function truncateLine(text: string): string {
  return text.length > GREP_TEXT_LIMIT ? text.slice(0, GREP_TEXT_LIMIT) : text
}

export class KbService {
  private readonly root: string
  private readonly rootExists: boolean
  private readonly maxWalkFiles: number
  private readonly inboxFile: string
  private readonly inboxExternal: boolean

  constructor(root: string, options: KbServiceOptions = {}) {
    const resolved = path.resolve(root)
    let real = resolved
    try {
      real = realpathSync(resolved)
    } catch {
      real = resolved
    }
    this.root = real
    this.rootExists = this.isDirectory(real)
    this.maxWalkFiles = Math.max(0, Math.trunc(options.maxWalkFiles ?? MAX_WALK_FILES))

    // 先 `path.resolve` 再判断归属：外部 inbox 的父目录可能还不存在（首次启动前），
    // 不能用 realpathSync——那会对不存在的路径抛 ENOENT。归属比较本身要能同时
    // 处理 Windows 大小写不敏感与前缀混淆（`/kb` vs `/kbevil`），所以用 isWithin。
    const configuredInbox = options.inboxPath?.trim()
    if (configuredInbox === undefined || configuredInbox === '') {
      this.inboxFile = path.join(real, '_inbox.md')
      this.inboxExternal = false
    } else {
      const inbox = path.resolve(configuredInbox)
      this.inboxFile = inbox
      // 显式指定但在语料根内：按「根内」处理，于是仍可经 kb_read 读到并且
      // kb_status 报相对路径——位置语义跟着实际所在，不跟着参数是否传了。
      this.inboxExternal = !isWithin(real, inbox)
    }
  }

  get rootPath(): string {
    return this.root
  }

  /**
   * inbox 的绝对路径。`kb_propose` 写它，`kb_status` 读它，审核脚本读它——
   * 三处必须是同一个值，否则就是「写外部、读老位置」的静默不一致。
   */
  get inboxPath(): string {
    return this.inboxFile
  }

  /** inbox 对外的标识：根内用相对语料根的 POSIX 路径，根外用绝对路径。 */
  inboxLabel(): string {
    if (!this.inboxExternal) return toPosix(path.relative(this.root, this.inboxFile))
    return this.inboxFile
  }

  lookup(query: string, limit = DEFAULT_LOOKUP_LIMIT): KbLookupResult {
    const trimmed = query.trim()
    if (trimmed === '') return { found: false, candidates: [], reason: 'empty_query' }

    const entries = this.loadIndex()
    if (entries === null) return { found: false, candidates: [], reason: 'index_missing' }

    const needle = trimmed.toLowerCase()
    const factor = confidenceFactor(trimmed, buildVocabulary(entries))
    const techTokens = extractTechTokens(trimmed)
    const queryCjkChars = countCjkChars(needle)
    const lexical = entries
      .map((entry) => ({
        entry,
        score: scoreEntry(entry, needle) * factor,
        techCovered: countTechCoverage(entry, techTokens),
        cjk: cjkMatchStats(entry, needle),
      }))
      .filter((candidate) => candidate.score > 0)

    const scored = lexical
      .filter((candidate) =>
        hasEnoughTechCoverage(candidate.techCovered, techTokens.length),
      )
      .filter(
        (candidate) =>
          techTokens.length > 0 ||
          hasEnoughChineseConfidence(candidate.cjk, queryCjkChars),
      )
      .sort(
        (left, right) =>
          right.score - left.score || compareText(left.entry.path, right.entry.path),
      )

    const candidates = scored
      .filter((candidate) => candidate.score >= CONFIDENCE_THRESHOLD)
      .slice(0, Math.max(0, limit))
      .map(({ entry, score }) => ({
        path: entry.path,
        title: entry.title,
        summary: entry.summary,
        score,
      }))

    if (candidates.length === 0) {
      return {
        found: false,
        candidates: [],
        reason: lexical.length === 0 ? 'no_match' : 'low_confidence',
      }
    }
    return { found: true, candidates }
  }

  read(relativePath: string, options: KbReadOptions = {}): KbReadResult {
    const { absolute, relative } = this.resolveRelative(relativePath)
    const info = statSync(absolute)
    if (!info.isFile()) {
      throw new KbServiceError('not_found', `KB 路径不是文件: ${relativePath}`)
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new KbServiceError(
        'file_too_large',
        `KB 文件超过 1 MiB 上限: ${relativePath}`,
      )
    }

    const content = readFileSync(absolute, 'utf8')
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = Math.min(
      Math.max(0, Math.trunc(options.limit ?? DEFAULT_READ_LINES)),
      MAX_READ_LINES,
    )
    const allLines = splitKeepingTerminators(content)
    const window = allLines.slice(offset, offset + limit)

    // frontmatter 与 reviewStatus 永远按整份文件判定：它们描述文件属性，不是窗口属性。
    const parsed = parseFrontmatter(content)
    const result: KbReadResult = {
      path: relative,
      content: window.join(''),
      offset,
      lines: window.length,
      totalLines: allLines.length,
      truncated: offset + window.length < allLines.length,
      frontmatterParsed: parsed.parsed,
      reviewStatus: NAVIGATION_FILES.has(path.posix.basename(relative)) ? 'unreviewed' : 'reviewed',
    }
    if (parsed.parsed) result.frontmatter = parsed.data
    return result
  }

  glob(pattern: string): KbGlobResult {
    const matcher = globToRegExp(normalizePattern(pattern))
    if (!this.rootExists) {
      return { found: false, matches: [], count: 0, truncated: false, scanTruncated: false }
    }

    // 与 grep 同一口径：`count` 是真实总数，但只保留能返回的那几条（D-078）。
    const matches: string[] = []
    let count = 0
    const walk = this.walkFiles(ALLOWED_EXTENSIONS)
    for (const filePath of walk.files) {
      const relative = toPosix(path.relative(this.root, filePath))
      if (isNavigationFile(relative)) continue
      if (!matcher.test(relative)) continue
      if (matches.length < MAX_GLOB_MATCHES) matches.push(relative)
      count += 1
    }

    return {
      found: count > 0,
      matches,
      count,
      truncated: count > MAX_GLOB_MATCHES,
      scanTruncated: walk.scanTruncated,
    }
  }

  grep(pattern: string, globPattern?: string): KbGrepResult {
    const needle = pattern.trim()
    if (needle === '') {
      throw new KbServiceError('invalid_pattern', 'pattern 不能为空')
    }

    let regex: RegExp
    try {
      regex = new RegExp(needle, 'i')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new KbServiceError('invalid_regex', `正则非法: ${reason}`)
    }

    const trimmedGlob = globPattern?.trim() ?? ''
    const matcher = trimmedGlob === '' ? undefined : globToRegExp(normalizePattern(trimmedGlob))

    // `count` 要报真实总数，但**不为此把每一行都留在内存里**：命中行一旦超过
    // 返回上限就只计数、不再保存文本。否则 `kb_grep(".")` 会把整份语料的每一行
    // 都复制一遍——这就是内核 grep 的 D-078（先收集再截断）。总数照样准确，
    // 因为这里只丢掉了「本来就返回不出去」的部分。
    // 每个命中文件的计数不受返回上限影响，所以 files[] 报的也是真值。
    const hits: KbGrepHit[] = []
    const perFile = new Map<string, number>()
    let matched = 0
    const walk = this.walkFiles(ALLOWED_EXTENSIONS)
    for (const filePath of walk.files) {
      const relative = toPosix(path.relative(this.root, filePath))
      if (isNavigationFile(relative)) continue
      if (matcher !== undefined && !matcher.test(relative)) continue

      let content: string
      try {
        const info = statSync(filePath)
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
        content = readFileSync(filePath, 'utf8')
      } catch {
        continue
      }

      let fileHits = 0
      const lines = content.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        if (!regex.test(line)) continue
        if (hits.length < MAX_GREP_HITS) {
          hits.push({ path: relative, line: index + 1, text: truncateLine(line.trim()) })
        }
        fileHits += 1
      }
      if (fileHits > 0) {
        perFile.set(relative, fileHits)
        matched += fileHits
      }
    }

    // 命中集中在几个文件 vs 散落在很多文件：这是供模型判断的线索，不是置信度。
    // 不加 score/confidence 之类的字段——未评测的数字会被当成结论（D-179）。
    const files = [...perFile.entries()]
      .map(([filePath, fileHits]) => ({ path: filePath, hits: fileHits }))
      .sort((left, right) => right.hits - left.hits || compareText(left.path, right.path))
      .slice(0, MAX_GREP_FILES)

    // count 报告真实命中总数（可以大于返回条数），truncated 说明 hits 被截断。
    return {
      found: matched > 0,
      hits,
      count: matched,
      truncated: matched > MAX_GREP_HITS,
      fileCount: perFile.size,
      files,
      scanTruncated: walk.scanTruncated,
    }
  }

  search(tokens: string[], limit = DEFAULT_SEARCH_LIMIT): KbSearchResult {
    const needles = tokens.map((token) => token.trim()).filter((token) => token !== '')
    if (!this.rootExists || needles.length === 0) return { found: false, hits: [] }

    const walk = this.walkMarkdown()
    const hits: KbSearchHit[] = []
    for (const filePath of walk.files) {
      const base = path.posix.basename(toPosix(filePath))
      if (NAVIGATION_FILES.has(base) || base === INDEX_FILE) continue

      let content: string
      try {
        const info = statSync(filePath)
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
        content = readFileSync(filePath, 'utf8')
      } catch {
        continue
      }

      const relative = toPosix(path.relative(this.root, filePath))
      const lines = content.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const lower = (lines[index] ?? '').toLowerCase()
        if (lower === '') continue
        for (const needle of needles) {
          if (!lower.includes(needle.toLowerCase())) continue
          const text = lines
            .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
            .join('\n')
          hits.push({ path: relative, line: index + 1, text, token: needle })
        }
      }
    }

    hits.sort(
      (left, right) =>
        compareText(left.path, right.path) ||
        left.line - right.line ||
        compareText(left.token, right.token),
    )

    const result: KbSearchResult = {
      found: hits.length > 0,
      hits: hits.slice(0, Math.max(0, limit)),
    }
    if (walk.scanTruncated) result.scanTruncated = true
    return result
  }

  status(): KbStatus {
    const inboxPath = this.inboxLabel()
    if (!this.rootExists) {
      return {
        root: this.root,
        fileCount: 0,
        indexEntries: 0,
        indexPresent: false,
        inboxPending: 0,
        inboxPath,
        inboxExternal: this.inboxExternal,
      }
    }

    const indexPath = path.join(this.root, INDEX_FILE)
    const indexPresent = this.isRegularFile(indexPath)
    let indexEntries = 0
    if (indexPresent) {
      try {
        indexEntries = parseIndexYaml(readFileSync(indexPath, 'utf8')).length
      } catch {
        indexEntries = 0
      }
    }

    let inboxPending = 0
    let inboxError: string | undefined
    // 读的位置就是写的位置（this.inboxFile）。文件不存在时保持既有 `inboxPending: 0`
    // 语义——「没有待审提案」不是错误；只有文件存在却读不动/解析不了才报 inboxError。
    if (this.isRegularFile(this.inboxFile)) {
      try {
        inboxPending = parseInbox(readFileSync(this.inboxFile, 'utf8')).length
      } catch (error) {
        inboxError = error instanceof Error ? error.message : String(error)
      }
    }

    const walk = this.walkMarkdown()
    return {
      root: this.root,
      // 遍历被截时 fileCount 只是下界，调用方必须读 scanTruncated 才能知道。
      fileCount: walk.files.length,
      indexEntries,
      indexPresent,
      inboxPending,
      inboxPath,
      inboxExternal: this.inboxExternal,
      ...(inboxError === undefined ? {} : { inboxError }),
      ...(walk.scanTruncated ? { scanTruncated: true } : {}),
    }
  }

  private loadIndex(): IndexEntry[] | null {
    if (!this.rootExists) return null
    const indexPath = path.join(this.root, INDEX_FILE)
    if (!this.isRegularFile(indexPath)) return null
    return parseIndexYaml(readFileSync(indexPath, 'utf8'))
  }

  private resolveRelative(relativePath: string): { absolute: string; relative: string } {
    const raw = relativePath.trim()
    if (raw === '') throw new KbServiceError('path_denied', 'KB 路径不能为空')
    if (
      path.isAbsolute(raw) ||
      /^[A-Za-z]:/.test(raw) ||
      raw.startsWith('/') ||
      raw.startsWith('\\')
    ) {
      throw new KbServiceError('path_denied', `KB 路径必须是相对路径: ${relativePath}`)
    }

    const segments = raw.replace(/\\/g, '/').split('/')
    if (segments.some((segment) => segment === '' || segment === '..')) {
      throw new KbServiceError('path_denied', `KB 路径不允许空段或 ..: ${relativePath}`)
    }

    const relative = segments.join('/')
    if (!ALLOWED_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) {
      throw new KbServiceError('path_denied', `KB 只允许 .md 与 .yaml: ${relativePath}`)
    }

    const target = path.resolve(this.root, ...segments)
    let real: string
    try {
      real = realpathSync(target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new KbServiceError('not_found', `KB 文件不存在: ${relativePath}`)
      }
      throw new KbServiceError('path_denied', `KB 路径无法解析: ${relativePath}`)
    }

    // 刻意**不放宽**这里去迁就外部 inbox（OTA 形态下 `inboxPath` 在语料根之外）：
    // 外部 inbox 经 `kb_read` 读不到，是接受的取舍——它本来就是待审区，
    // `kb_read` 的返回值会原样进模型上下文并标 `reviewStatus: reviewed`，
    // 让一条「根外任意路径可读」的口子换来读自家 inbox，代价与收益不成比例。
    // 审核脚本不经这条路径，它直接按 `KbService.inboxPath` 读文件，所以人工流程不受影响。
    if (!isWithin(this.root, real)) {
      throw new KbServiceError('path_denied', `KB 路径越出知识库根目录: ${relativePath}`)
    }
    if (!ALLOWED_EXTENSIONS.has(path.extname(real).toLowerCase())) {
      throw new KbServiceError('path_denied', `KB 只允许 .md 与 .yaml: ${relativePath}`)
    }

    return { absolute: real, relative }
  }

  private walkFiles(extensions?: Set<string>): { files: string[]; scanTruncated: boolean } {
    const files: string[] = []
    let scanned = 0
    let scanTruncated = false
    const visit = (directory: string): void => {
      if (scanTruncated) return
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((left, right) => compareText(left.name, right.name))
      for (const entry of entries) {
        // 与内核 walkFiles 同口径：达到上限后只要还有后续条目就标记截断。
        // 不能悄悄少扫几个文件还说「没有更多」——那是 R3 意义上的不诚实。
        if (scanned >= this.maxWalkFiles) {
          scanTruncated = true
          return
        }
        if (entry.isDirectory()) {
          // 目录名按小写比较：Windows 上 Node_Modules 与 node_modules 是同一个目录。
          if (IGNORED_WALK_DIRS.has(entry.name.toLowerCase())) continue
          visit(path.join(directory, entry.name))
          continue
        }
        if (!entry.isFile()) continue
        // 计数按**访问过的文件**算，不按扩展名过滤：目录里堆满 .txt 时遍历成本
        // 一样高，预算必须覆盖它，否则上限挡不住任何真实的大目录。
        scanned += 1
        if (extensions === undefined) {
          files.push(path.join(directory, entry.name))
          continue
        }
        const extension = path.posix.extname(entry.name).toLowerCase()
        if (extensions.has(extension)) files.push(path.join(directory, entry.name))
      }
    }
    visit(this.root)
    return { files, scanTruncated }
  }

  private walkMarkdown(): { files: string[]; scanTruncated: boolean } {
    return this.walkFiles(new Set(['.md']))
  }

  private isDirectory(target: string): boolean {
    try {
      return statSync(target).isDirectory()
    } catch {
      return false
    }
  }

  private isRegularFile(target: string): boolean {
    try {
      return statSync(target).isFile()
    } catch {
      return false
    }
  }
}