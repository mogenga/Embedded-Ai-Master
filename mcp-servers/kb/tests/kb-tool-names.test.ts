import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 语料里点名的工具必须真的存在。
 *
 * `frontmatter.tools` 是模型可见内容：写一个不存在的工具名，模型会照着调用并
 * 失败（`debug/swd/no-connect.md` 曾写「agent 跑 probe_attach（已有的工具）」，
 * 而 probe server 的真实名字是 `attach`）。这条断言把「语料提到的工具」钉在
 * 各 server 的实际工具面上。
 *
 * 工具名从 `tools.ts` 静态提取，不 import 业务模块：import 会拉起 zod schema、
 * 后端构造等副作用，而这个测试只需要名字。内核 `src/tools/` 的基础工具也计入
 * ——语料会要求 agent 用 `shell` 跑 readelf/objdump，`shell` 同样是真实工具。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const KB_ROOT = path.join(HERE, '..', 'kb')

/** 参与工具面统计的文件；任一缺失都应当报错，而不是静默少算。 */
const TOOL_SOURCE_FILES = [
  'mcp-servers/probe/tools.ts',
  'mcp-servers/serial/tools.ts',
  'mcp-servers/keil/tools.ts',
  'mcp-servers/kb/tools.ts',
  'mcp-servers/datasheet/tools.ts',
]

/** 内核内置工具目录（`name: "..."` 与 MCP server 同形）。 */
const KERNEL_TOOL_DIR = 'src/tools'

/**
 * 已改名的旧工具名，正文里不允许再出现。
 *
 * 不含 `flash_write`：`reference/renesas-ra-clock-options.md` 里它是 R_FLASH_HP
 * 驱动的 API，不是工具。`firmware_check` / `disasm` 只留在 frontmatter 的
 * description 触发词里（按任务约束不改其它 frontmatter 字段），正文已改写。
 */
const RETIRED_TOOL_NAMES = [
  'probe_attach',
  'probe_halt',
  'probe_detach',
  'probe_resume',
  'probe_reset',
  'probe_cmd',
  'probe_bp',
  'probe_step',
  'reg_read',
  'reg_write',
  'mem_read_width',
  'rtt_start',
  'rtt_stop',
  'rtt_read',
  'serial_stats',
  'serial_capture',
  'can_open',
  'can_read',
  'can_stats',
  'can_scan',
  'sym_resolve',
  'sym_find',
  'sym_list',
]

/**
 * 用户本地沉淀，不在 OTA 清单里（`inbox.ts` 的 MANAGED_CORPUS_EXCLUDES），
 * 内容是历史记录，不参与发布，也不该被当成语料正文校验。
 */
const LOCAL_ONLY_FILES = new Set(['_inbox.md'])

const NAME_LITERAL = /\bname:\s*["']([a-z][a-z0-9_]*)["']/g

function relative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/')
}

function readToolNames(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf8')
  return [...text.matchAll(NAME_LITERAL)].map((match) => match[1] as string)
}

function listMarkdownFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listMarkdownFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full)
  }
  return files.sort()
}

interface ToolReference {
  file: string
  line: number
  name: string
}

/**
 * 返回 frontmatter 结束分隔线的行号（0-based）；没有 frontmatter 或未闭合时
 * 返回 -1（`parseFrontmatter` 也把这两种情况当「整份都是正文」）。
 */
function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return -1
  return lines.findIndex((line, index) => index > 0 && line.trim() === '---')
}

function frontmatterToolReferences(filePath: string): ToolReference[] {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  const end = frontmatterEnd(lines)
  const references: ToolReference[] = []
  for (let index = 0; index < end; index += 1) {
    const line = lines[index] ?? ''
    if (!line.startsWith('tools:')) continue
    const match = /^tools:\s*\[(.*)\]\s*$/.exec(line)
    if (match === null) {
      throw new Error(`${relative(filePath)}:${index + 1} 的 tools 字段不是行内数组: ${line}`)
    }
    for (const token of (match[1] ?? '').split(',')) {
      const name = token.trim()
      if (name !== '') references.push({ file: relative(filePath), line: index + 1, name })
    }
  }
  return references
}

/** 正文（frontmatter 之后）出现的已废弃工具名。 */
function retiredBodyReferences(filePath: string): ToolReference[] {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  const start = frontmatterEnd(lines) + 1
  const pattern = new RegExp(`\\b(${RETIRED_TOOL_NAMES.join('|')})\\b`)
  const references: ToolReference[] = []
  for (let index = start; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index] ?? '')
    if (match !== null) {
      references.push({ file: relative(filePath), line: index + 1, name: match[1] as string })
    }
  }
  return references
}

/**
 * 语料与工具面都齐了才跑。缺工具面源文件时不能悄悄当成「语料全对」——
 * 那正是这条断言要防的静默失效；因此按「资产缺失」跳过并在套件名里点名。
 */
const missingSources = [...TOOL_SOURCE_FILES, KERNEL_TOOL_DIR].filter(
  (relativePath) => !existsSync(path.join(REPO_ROOT, ...relativePath.split('/'))),
)
const missingCorpus = !existsSync(KB_ROOT)
const skipReason = missingCorpus
  ? 'mcp-servers/kb/kb 不存在（语料是本地资产）'
  : missingSources.length > 0
    ? `缺少工具面源文件：${missingSources.join('、')}`
    : null

const toolFiles =
  skipReason === null
    ? [
        ...TOOL_SOURCE_FILES.map((relativePath) => path.join(REPO_ROOT, ...relativePath.split('/'))),
        ...readdirSync(path.join(REPO_ROOT, ...KERNEL_TOOL_DIR.split('/')))
          .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
          .map((name) => path.join(REPO_ROOT, ...KERNEL_TOOL_DIR.split('/'), name)),
      ]
    : []

const realToolNames = new Set(toolFiles.flatMap(readToolNames))

const corpusFiles =
  skipReason === null
    ? listMarkdownFiles(KB_ROOT).filter((file) => !LOCAL_ONLY_FILES.has(path.basename(file)))
    : []

const suite = skipReason === null ? describe : describe.skip

suite(
  skipReason === null ? 'KB 语料工具名必须存在于真实工具面' : `KB 语料工具名（已跳过：${skipReason}）`,
  () => {
    it('从各 server 与内核静态提取到了工具名', () => {
      // 正则失配时集合为空，下面的用例会把每条语料都报成未知工具——先在这里
      // 给出可读的失败原因，避免排查方向被误导。
      expect(realToolNames.size).toBeGreaterThanOrEqual(20)
      expect(realToolNames.has('attach')).toBe(true)
      expect(realToolNames.has('mem_read')).toBe(true)
      expect(realToolNames.has('shell')).toBe(true)
    })

    it('frontmatter.tools 里的每个名字都是真实工具', () => {
      const references = corpusFiles.flatMap(frontmatterToolReferences)
      // 扫描空转（解析器坏了）与「全部合规」看起来一样，先确认确实读到了内容。
      expect(references.length).toBeGreaterThan(50)

      const unknown = references.filter((reference) => !realToolNames.has(reference.name))
      expect(unknown.map((reference) => `${reference.file}:${reference.line} → ${reference.name}`)).toEqual([])
    })

    it('正文不再引用已改名的旧工具', () => {
      const references = corpusFiles.flatMap(retiredBodyReferences)
      expect(references.map((reference) => `${reference.file}:${reference.line} → ${reference.name}`)).toEqual([])
    })
  },
)
