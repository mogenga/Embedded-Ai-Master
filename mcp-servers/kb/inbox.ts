import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type KbProposalKind = 'trap' | 'correction' | 'reference' | 'case'

export interface KbProposal {
  id: string
  date: string
  kind: KbProposalKind
  domain: string
  source: string
  content: string
  title?: string
}

export interface ReviewedEntry {
  id: string
  status: 'accepted' | 'rejected'
  reviewedAt: string
  target?: string
  reason?: string
}


const INBOX_FILE = '_inbox.md'
const REVIEWED_FILE = '_reviewed.md'

/**
 * 受管语料集合必须排除的文件名（按 basename 匹配），供 manifest 生成与 OTA 发布脚本使用。
 *
 * `_inbox.md` 排第一：它是用户本地沉淀，而 OTA 会**整份替换**语料快照
 * （`docs/corpus-ota.md` §3/§4）。把它算进清单只有两种结局——更新时冲掉用户的
 * 提案，或者新快照校验失败。`_reviewed.md` 同理：审核记录也是用户数据，不是语料正文。
 */
export const MANAGED_CORPUS_EXCLUDES: readonly string[] = [INBOX_FILE, REVIEWED_FILE]

const INBOX_HEADER = [
  '# 知识库收件箱 (KB Inbox)',
  '',
  '由 `kb_propose` 写入，人工审核后由 `scripts/kb-review.mjs` 标记。未审核内容不参与检索。',
  '',
  '<!-- kb_propose appends below this line -->',
].join('\n')
const REVIEWED_HEADER = '# KB 审核记录\n'
const KINDS = new Set<KbProposalKind>(['trap', 'correction', 'reference', 'case'])
const FIELD_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]?(.*)$/

function isSeparator(line: string): boolean {
  return line.trim() === '---'
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1)
    }
  }
  return value
}

const KNOWN_FIELDS = new Set(['id', 'date', 'kind', 'domain', 'source', 'title', 'content'])

function parseFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let currentKey: string | undefined
  let inContent = false
  for (const line of raw.split(/\r?\n/)) {
    // content 是块内最后一个字段；一旦开始，后续形如 "Name: value" 的正文行
    // 不得再被识别为字段，否则正文会被截断、重复检测失效。
    if (inContent) {
      fields.content = `${fields.content}\n${line}`
      continue
    }
    const match = FIELD_PATTERN.exec(line)
    if (match !== null && KNOWN_FIELDS.has(match[1]!)) {
      currentKey = match[1]!
      fields[currentKey] = match[2] ?? ''
      if (currentKey === 'content') inContent = true
      continue
    }
    if (currentKey !== undefined) {
      fields[currentKey] = `${fields[currentKey]}\n${line}`
    }
  }
  for (const key of Object.keys(fields)) {
    fields[key] = fields[key]!.replace(/[ \t]+$/gm, '').replace(/\s+$/, '')
  }
  return fields
}

function splitBlocks(text: string): { header: string; blocks: string[] } {
  const lines = text.split(/\r?\n/)
  const headerLines: string[] = []
  const blocks: string[] = []
  let current: string[] | null = null

  const pushCurrent = () => {
    if (current === null) return
    const block = current.join('\n')
    if (block.trim() !== '') blocks.push(block)
  }

  for (const line of lines) {
    if (isSeparator(line)) {
      if (current === null) {
        current = []
      } else {
        pushCurrent()
        current = []
      }
      continue
    }
    if (current === null) headerLines.push(line)
    else current.push(line)
  }
  pushCurrent()
  return { header: headerLines.join('\n').replace(/\s+$/, ''), blocks }
}

interface ParsedBlock {
  id?: string
  date: string
  kind: KbProposalKind
  domain: string
  source: string
  content: string
  title?: string
  raw: string
}

function parseBlock(raw: string): ParsedBlock | undefined {
  const fields = parseFields(raw)
  const content = fields.content ?? ''
  if (content.trim() === '') return undefined
  const id = fields.id?.trim()
  const kind = fields.kind?.trim()
  return {
    ...(id === undefined || id === '' ? {} : { id }),
    date: fields.date?.trim() ?? '',
    kind: kind !== undefined && KINDS.has(kind as KbProposalKind) ? (kind as KbProposalKind) : 'reference',
    domain: fields.domain?.trim() ?? '',
    source: fields.source?.trim() ?? '',
    content,
    ...(fields.title !== undefined && fields.title.trim() !== ''
      ? { title: fields.title.trim() }
      : {}),
    raw,
  }
}

function toProposal(parsed: ParsedBlock, id: string): KbProposal {
  return {
    id,
    date: parsed.date,
    kind: parsed.kind,
    domain: parsed.domain,
    source: parsed.source,
    content: parsed.content,
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
  }
}

/**
 * `_inbox.md` 的默认位置：语料根内。
 *
 * OTA 会整份替换语料快照，部署形态把 inbox 放在根外（契约 `docs/corpus-ota.md` §3
 * 的 `$HARNESS_HOME/kb/inbox/_inbox.md`），因此下面所有读写都提供「按文件路径」的
 * 变体；`root` 版本只是默认位置的薄封装，行为与改动前逐字一致。
 */
export function defaultInboxFile(root: string): string {
  return path.join(root, INBOX_FILE)
}

/** 审核记录与 inbox 同目录：inbox 搬到哪里，记录就跟到哪里。 */
function reviewedFileFor(inboxFile: string): string {
  return path.join(path.dirname(inboxFile), REVIEWED_FILE)
}

export function parseInbox(text: string): KbProposal[] {
  const { blocks } = splitBlocks(text)
  const proposals: KbProposal[] = []
  let legacyIndex = 0
  for (const raw of blocks) {
    const parsed = parseBlock(raw)
    if (parsed === undefined) continue
    legacyIndex += 1
    proposals.push(toProposal(parsed, parsed.id ?? `legacy-${legacyIndex}`))
  }
  return proposals
}

export function formatProposal(proposal: KbProposal): string {
  const lines = [
    '---',
    `id: ${proposal.id}`,
    `date: ${proposal.date}`,
    `kind: ${proposal.kind}`,
    `domain: ${proposal.domain}`,
    `source: ${proposal.source}`,
  ]
  if (proposal.title !== undefined) lines.push(`title: ${proposal.title}`)
  lines.push(`content: ${proposal.content}`, '---', '')
  return lines.join('\n')
}

export function proposalDigest(proposal: Pick<KbProposal, 'kind' | 'domain' | 'content'>): string {
  return createHash('sha256')
    .update(`${proposal.kind}\n${proposal.domain}\n${proposal.content}`)
    .digest('hex')
}

export function newProposalId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * 把提案追加到 `file`；返回的 `path` 是**调用方看到的** inbox 标识。
 *
 * `label` 由调用方传：默认形态下是 `_inbox.md`（相对语料根，历史契约），
 * 外部 inbox 形态下是绝对路径——写在哪里就如实回报哪里，不能一边写外部文件
 * 一边回 `_inbox.md` 让人以为语料根里有一份（R3）。
 */
export function appendProposalTo(
  file: string,
  proposal: KbProposal,
  label: string = INBOX_FILE,
): { path: string; duplicateOf?: string } {
  if (!existsSync(file)) {
    // 刻意不补建父目录：inbox 目录由部署层（快照种子化）负责，这里悄悄建目录会把
    // 「路径配错」伪装成写入成功。父目录缺失时 ENOENT 由调用方如实报为写入失败。
    writeFileSync(file, `${INBOX_HEADER}\n\n${formatProposal(proposal)}`, 'utf8')
    return { path: label }
  }
  const existingText = readFileSync(file, 'utf8')
  const existing = parseInbox(existingText)
  const digest = proposalDigest(proposal)
  const duplicate = existing.find((item) => proposalDigest(item) === digest)
  if (duplicate !== undefined) {
    return { path: label, duplicateOf: duplicate.id }
  }

  const separator = existingText.endsWith('\n') ? '' : '\n'
  appendFileSync(file, `${separator}${formatProposal(proposal)}`, 'utf8')
  return { path: label }
}

export function appendProposal(
  root: string,
  proposal: KbProposal,
): { path: string; duplicateOf?: string } {
  return appendProposalTo(defaultInboxFile(root), proposal)
}

export function removeProposalFrom(file: string, id: string): KbProposal | undefined {
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  const { header, blocks } = splitBlocks(text)

  const kept: string[] = []
  let removed: KbProposal | undefined
  let legacyIndex = 0
  for (const raw of blocks) {
    const parsed = parseBlock(raw)
    if (parsed === undefined) {
      if (raw.trim() !== '') kept.push(raw)
      continue
    }
    legacyIndex += 1
    const proposalId = parsed.id ?? `legacy-${legacyIndex}`
    if (proposalId === id) {
      removed = toProposal(parsed, proposalId)
      continue
    }
    kept.push(raw)
  }
  if (removed === undefined) return undefined

  const body = kept.map((raw) => `---\n${raw}\n---`).join('\n')
  const next = `${header}${header === '' ? '' : '\n\n'}${body}${body === '' ? '' : '\n'}`
  writeFileSync(file, next, 'utf8')
  return removed
}

export function removeProposal(root: string, id: string): KbProposal | undefined {
  return removeProposalFrom(defaultInboxFile(root), id)
}

/** 审核记录写到 inbox 同目录；返回相对该目录的文件名（`_reviewed.md`）。 */
export function appendReviewedTo(inboxFile: string, entry: ReviewedEntry): string {
  const file = reviewedFileFor(inboxFile)
  if (!existsSync(file)) writeFileSync(file, `${REVIEWED_HEADER}\n`, 'utf8')
  const lines = [
    '---',
    `id: ${entry.id}`,
    `status: ${entry.status}`,
    `reviewedAt: ${entry.reviewedAt}`,
  ]
  if (entry.target !== undefined) lines.push(`target: ${entry.target}`)
  if (entry.reason !== undefined) lines.push(`reason: ${entry.reason}`)
  lines.push('---', '')
  const text = readFileSync(file, 'utf8')
  appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}${lines.join('\n')}`, 'utf8')
  return REVIEWED_FILE
}

export function appendReviewed(root: string, entry: ReviewedEntry): string {
  return appendReviewedTo(defaultInboxFile(root), entry)
}