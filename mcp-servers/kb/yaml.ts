export interface IndexEntry {
  id: string
  title: string
  path: string
  tags: string[]
  keywords: string[]
  summary: string
}

export interface FrontmatterResult {
  data: Record<string, string | string[]>
  body: string
  parsed: boolean
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/
const REQUIRED_STRING_FIELDS = ['id', 'title', 'path'] as const
const REQUIRED_ARRAY_FIELDS = ['tags', 'keywords'] as const

function splitKeyValue(line: string): { key: string; raw: string } | null {
  const colon = line.indexOf(':')
  if (colon <= 0) return null
  if (colon + 1 < line.length && line[colon + 1] !== ' ') return null
  const key = line.slice(0, colon).trim()
  if (!KEY_PATTERN.test(key)) return null
  return { key, raw: line.slice(colon + 1).trim() }
}

function hasUnquotedColon(value: string): boolean {
  let quote: "'" | '"' | null = null
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote === "'") {
      if (ch === "'") {
        if (value[i + 1] === "'") i += 1
        else quote = null
      }
      continue
    }
    if (quote === '"') {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === '"') quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === ':' && (i === value.length - 1 || /\s/.test(value[i + 1] ?? ''))) return true
  }
  return false
}

function unquoteQuoted(value: string): string | null {
  const quote = value[0]
  if (quote !== "'" && quote !== '"') return value
  if (value.length < 2 || value[value.length - 1] !== quote) return null
  const inner = value.slice(1, -1)
  let out = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote === "'") {
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          out += "'"
          i += 1
          continue
        }
        return null
      }
      out += ch
      continue
    }
    if (ch === '\\') {
      const next = inner[i + 1]
      if (next === '"' || next === '\\') {
        out += next
        i += 1
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') return null
    out += ch
  }
  return out
}

function splitInlineList(body: string): string[] | null {
  const items: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quote === "'") {
      if (ch === "'") {
        if (body[i + 1] === "'") {
          current += "''"
          i += 1
          continue
        }
        quote = null
      }
      current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '\\') {
        current += ch + (body[i + 1] ?? '')
        i += 1
        continue
      }
      if (ch === '"') quote = null
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      items.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (quote !== null) return null
  items.push(current)

  const result: string[] = []
  for (const item of items) {
    const trimmed = item.trim()
    if (trimmed === '') continue
    const unquoted = unquoteQuoted(trimmed)
    if (unquoted === null) return null
    result.push(unquoted)
  }
  return result
}

function parseIndexScalar(raw: string): string | string[] {
  const value = raw.trim()
  if (value === '') return ''
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error(`index.yaml 无法解析的行内数组: ${value}`)
    const items = splitInlineList(value.slice(1, -1))
    if (items === null) throw new Error(`index.yaml 无法解析的行内数组: ${value}`)
    return items
  }
  const unquoted = unquoteQuoted(value)
  if (unquoted === null) throw new Error(`index.yaml 无法解析的引号值: ${value}`)
  return unquoted
}

function applyIndexField(entry: Partial<IndexEntry>, line: string): void {
  const pair = splitKeyValue(line)
  if (pair === null) throw new Error(`index.yaml 无法解析的字段行: ${line}`)

  switch (pair.key) {
    case 'id':
    case 'title':
    case 'path':
    case 'summary': {
      const value = parseIndexScalar(pair.raw)
      if (Array.isArray(value)) throw new Error(`index.yaml 字段 ${pair.key} 必须是字符串`)
      entry[pair.key] = value
      return
    }
    case 'tags':
    case 'keywords': {
      const value = parseIndexScalar(pair.raw)
      if (!Array.isArray(value)) throw new Error(`index.yaml 字段 ${pair.key} 必须是数组`)
      entry[pair.key] = value
      return
    }
    default:
      return
  }
}

export function parseIndexYaml(text: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  let current: Partial<IndexEntry> | null = null
  let inEntries = false
  let itemCount = 0

  const finishEntry = (): void => {
    if (current === null) return
    itemCount += 1
    for (const field of REQUIRED_STRING_FIELDS) {
      if (current[field] === undefined || current[field] === '') {
        throw new Error(`index.yaml 第 ${itemCount} 个条目缺少必填字段: ${field}`)
      }
    }
    for (const field of REQUIRED_ARRAY_FIELDS) {
      if (current[field] === undefined) {
        throw new Error(`index.yaml 第 ${itemCount} 个条目缺少必填字段: ${field}`)
      }
    }
    entries.push({
      id: current.id as string,
      title: current.title as string,
      path: current.path as string,
      tags: current.tags as string[],
      keywords: current.keywords as string[],
      summary: current.summary ?? '',
    })
    current = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    if (!inEntries) {
      if (line === 'entries:') inEntries = true
      continue
    }

    if (line === '-' || line.startsWith('- ')) {
      finishEntry()
      current = {}
      const rest = line.slice(1).trim()
      if (rest !== '') applyIndexField(current, rest)
      continue
    }

    if (current === null) throw new Error(`index.yaml 无法解析的条目行: ${line}`)
    applyIndexField(current, line)
  }

  finishEntry()
  return entries
}

function parseFrontmatterValue(raw: string): string | string[] | null {
  const value = raw.trim()
  if (value === '') return ''
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return null
    const inner = value.slice(1, -1)
    if (hasUnquotedColon(inner)) return null
    return splitInlineList(inner)
  }
  if (value.startsWith("'") || value.startsWith('"')) return unquoteQuoted(value)
  if (hasUnquotedColon(value)) return null
  return value
}

export function parseFrontmatter(text: string): FrontmatterResult {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { data: {}, body: text, parsed: false }

  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { data: {}, body: text, parsed: false }

  const body = lines.slice(end + 1).join('\n')
  const data: Record<string, string | string[]> = {}

  for (let i = 1; i < end; i += 1) {
    const rawLine = lines[i] ?? ''
    if (rawLine.trim() === '') continue
    if (rawLine.trimStart().startsWith('#')) continue
    if (/^\s/.test(rawLine)) return { data: {}, body, parsed: false }

    const pair = splitKeyValue(rawLine.trim())
    if (pair === null) return { data: {}, body, parsed: false }

    const value = parseFrontmatterValue(pair.raw)
    if (value === null) return { data: {}, body, parsed: false }
    data[pair.key] = value
  }

  return { data, body, parsed: true }
}