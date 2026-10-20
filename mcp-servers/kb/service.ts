import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { parseFrontmatter, parseIndexYaml } from './yaml.js'
import type { IndexEntry } from './yaml.js'

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
}

export interface KbReadResult {
  path: string
  content: string
  frontmatter?: Record<string, string | string[]>
  frontmatterParsed: boolean
  reviewStatus: 'reviewed' | 'unreviewed'
}

export interface KbStatus {
  root: string
  fileCount: number
  indexEntries: number
  indexPresent: boolean
}

export type KbServiceErrorCode = 'path_denied' | 'file_too_large' | 'not_found'

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
const TAG_WEIGHT = 2
const CONFIDENCE_THRESHOLD = 1.75
const OOV_PENALTY = 0.75
const QUERY_TOKEN_PATTERN = /0x[0-9A-Fa-f]+|[A-Za-z_][A-Za-z0-9_]*/g
const CJK_PATTERN = /[\u4e00-\u9fff]/
const PURE_ASCII_WORD = /^[A-Za-z][A-Za-z0-9_]*$/
const BOUNDARY_PATTERN_CACHE = new Map<string, RegExp>()

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

export class KbService {
  private readonly root: string
  private readonly rootExists: boolean

  constructor(root: string) {
    const resolved = path.resolve(root)
    let real = resolved
    try {
      real = realpathSync(resolved)
    } catch {
      real = resolved
    }
    this.root = real
    this.rootExists = this.isDirectory(real)
  }

  lookup(query: string, limit = DEFAULT_LOOKUP_LIMIT): KbLookupResult {
    const trimmed = query.trim()
    if (trimmed === '') return { found: false, candidates: [], reason: 'empty_query' }

    const entries = this.loadIndex()
    if (entries === null) return { found: false, candidates: [], reason: 'index_missing' }

    const needle = trimmed.toLowerCase()
    const factor = confidenceFactor(trimmed, buildVocabulary(entries))
    const scored = entries
      .map((entry) => ({ entry, score: scoreEntry(entry, needle) * factor }))
      .filter((candidate) => candidate.score > 0)
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
        reason: scored.length === 0 ? 'no_match' : 'low_confidence',
      }
    }
    return { found: true, candidates }
  }

  read(relativePath: string): KbReadResult {
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
    const parsed = parseFrontmatter(content)
    const result: KbReadResult = {
      path: relative,
      content,
      frontmatterParsed: parsed.parsed,
      reviewStatus: NAVIGATION_FILES.has(path.posix.basename(relative)) ? 'unreviewed' : 'reviewed',
    }
    if (parsed.parsed) result.frontmatter = parsed.data
    return result
  }

  search(tokens: string[], limit = DEFAULT_SEARCH_LIMIT): KbSearchResult {
    const needles = tokens.map((token) => token.trim()).filter((token) => token !== '')
    if (!this.rootExists || needles.length === 0) return { found: false, hits: [] }

    const hits: KbSearchHit[] = []
    for (const filePath of this.walkMarkdown()) {
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

    return { found: hits.length > 0, hits: hits.slice(0, Math.max(0, limit)) }
  }

  status(): KbStatus {
    if (!this.rootExists) {
      return { root: this.root, fileCount: 0, indexEntries: 0, indexPresent: false }
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

    return {
      root: this.root,
      fileCount: this.walkMarkdown().length,
      indexEntries,
      indexPresent,
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

    if (!isWithin(this.root, real)) {
      throw new KbServiceError('path_denied', `KB 路径越出知识库根目录: ${relativePath}`)
    }
    if (!ALLOWED_EXTENSIONS.has(path.extname(real).toLowerCase())) {
      throw new KbServiceError('path_denied', `KB 只允许 .md 与 .yaml: ${relativePath}`)
    }

    return { absolute: real, relative }
  }

  private walkMarkdown(): string[] {
    const files: string[] = []
    const visit = (directory: string): void => {
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((left, right) => compareText(left.name, right.name))
      for (const entry of entries) {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          visit(full)
          continue
        }
        if (!entry.isFile()) continue
        if (entry.name.toLowerCase().endsWith('.md')) files.push(full)
      }
    }
    visit(this.root)
    return files
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