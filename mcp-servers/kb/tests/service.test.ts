import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KbService, KbServiceError } from '../service.js'

const INDEX_FIXTURE = `# 夹具索引
version: 1

entries:
  - id: uart-no-output
    title: 串口无输出
    path: protocols/uart/no-output.md
    tags: [uart, serial, rs232]
    keywords: [没输出, 无输出, 收不到, 没反应]
    summary: 完全无输出或对端收不到

  - id: uart-garbled
    title: 串口乱码
    path: protocols/uart/garbled-data.md
    tags: [uart, baud]
    keywords: [乱码, garbled]
    summary: 有数据但内容是乱码

  - id: i2c-nack
    title: I2C 从机不应答
    path: protocols/i2c/nack.md
    tags: [i2c]
    keywords: [nack, 不应答]
    summary: 从机无 ACK

  - id: toolchain-c
    title: C 工具链
    path: system/toolchain.md
    tags: [c, toolchain]
    keywords: [c, 优化, 对齐]
    summary: C 编译器与链接脚本
`

const NO_OUTPUT_FIXTURE = `---
name: evidence-no-output
tags: [serial]
description: '串口无输出'
---
# 串口无输出
第一行正文
UART 接线要共地
第三行正文
`

const GARBLED_FIXTURE = `# 串口乱码
uart 参数不一致
`

const INBOX_FIXTURE = `# 收件箱
UART 待归档候选
`

const ABOUT_FIXTURE = `# 关于
UART 语料说明
`

const MIB = 1024 * 1024

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof KbServiceError ? error.code : undefined
  }
  return undefined
}

function errorOf(run: () => unknown): KbServiceError | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof KbServiceError ? error : undefined
  }
  return undefined
}

// 独立的临时 KB 根：共享 fixture 里已有 7 个 markdown，任何小上限都会先把它们
// 数满，测不出「上限恰好等于文件数」这类边界。
function withIsolatedKb(
  fileCount: number,
  run: (root: string) => void,
  content = '# x\n',
): void {
  const isolated = mkdtempSync(path.join(tmpdir(), 'kb-scan-'))
  try {
    for (let index = 0; index < fileCount; index += 1) {
      writeFixture(isolated, `f-${index}.md`, content)
    }
    run(isolated)
  } finally {
    rmSync(isolated, { recursive: true, force: true })
  }
}

describe('KbService', () => {
  let root: string
  let service: KbService

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kb-service-'))
    writeFixture(root, 'index.yaml', INDEX_FIXTURE)
    writeFixture(root, '_inbox.md', INBOX_FIXTURE)
    writeFixture(root, '_about.md', ABOUT_FIXTURE)
    writeFixture(root, 'cases/_about.md', ABOUT_FIXTURE)
    writeFixture(root, 'protocols/uart/no-output.md', NO_OUTPUT_FIXTURE)
    writeFixture(root, 'protocols/uart/garbled-data.md', GARBLED_FIXTURE)
    writeFixture(root, 'system/toolchain.md', '# C 工具链\n链接脚本与优化\n')
    writeFixture(root, 'notes.txt', 'UART 但扩展名不在白名单\n')
    writeFixture(root, 'big.md', `${'x'.repeat(MIB)}\n`)
    service = new KbService(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('lookup', () => {
    it('命中 keyword 时返回 top-1 候选', () => {
      const result = service.lookup('串口没输出')

      expect(result.found).toBe(true)
      expect(result.reason).toBeUndefined()
      expect(result.candidates[0]).toEqual({
        path: 'protocols/uart/no-output.md',
        title: '串口无输出',
        summary: '完全无输出或对端收不到',
        score: 3,
      })
      expect(result.candidates).toHaveLength(1)
    })

    it('分数 = 命中 keyword 长度和 + 2 × 命中 tag 数，并按分数降序', () => {
      const result = service.lookup('uart 乱码')

      expect(result.candidates[0]).toMatchObject({
        path: 'protocols/uart/garbled-data.md',
        score: 4,
      })
      expect(result.candidates[1]).toMatchObject({
        path: 'protocols/uart/no-output.md',
        score: 2,
      })
    })

    it('英文 token 按 ASCII 词边界匹配', () => {
      expect(service.lookup('uartx')).toEqual({
        found: false,
        candidates: [],
        reason: 'no_match',
      })
    })

    it('忽略单字符英文 keyword/tag', () => {
      expect(service.lookup('C 语言')).toEqual({
        found: false,
        candidates: [],
        reason: 'no_match',
      })
    })

    it('查询含大量未登录 token 时按低置信拒答', () => {
      expect(service.lookup('乱码 xyz')).toEqual({
        found: false,
        candidates: [],
        reason: 'low_confidence',
      })
    })

    it('单一技术 token 未被条目覆盖时拒答', () => {
      expect(service.lookup('乱码 ESP32')).toEqual({
        found: false,
        candidates: [],
        reason: 'low_confidence',
      })
    })

    it('多个技术 token 只覆盖一半时拒答', () => {
      expect(service.lookup('uart xyz')).toEqual({
        found: false,
        candidates: [],
        reason: 'low_confidence',
      })
    })

    it('技术 token 覆盖超过一半时命中', () => {
      const result = service.lookup('i2c nack')

      expect(result.found).toBe(true)
      expect(result.candidates[0]?.path).toBe('protocols/i2c/nack.md')
    })

    it('CPU/MCU 等泛指词不计入技术 token', () => {
      const result = service.lookup('CPU nack')

      expect(result.found).toBe(true)
      expect(result.candidates[0]?.path).toBe('protocols/i2c/nack.md')
    })

    it('短中文通用词不单独支撑命中', () => {
      for (const query of ['优化', '对齐', '没反应']) {
        expect(service.lookup(query)).toEqual({
          found: false,
          candidates: [],
          reason: 'low_confidence',
        })
      }
    })

    it('中文关键词之外的上下文足够时仍命中', () => {
      expect(service.lookup('串口没输出').found).toBe(true)
      expect(service.lookup('串口乱码').found).toBe(true)
    })

    it('长中文查询即使只命中一个短关键词也仍命中', () => {
      const result = service.lookup('调试版本一切正常,换成优化版本之后数据就错了')

      expect(result.found).toBe(true)
      expect(result.candidates[0]?.path).toBe('system/toolchain.md')
    })

    it('命中两个不同中文关键词时视为信息量足够', () => {
      const result = service.lookup('优化 对齐')

      expect(result.found).toBe(true)
      expect(result.candidates[0]?.path).toBe('system/toolchain.md')
    })

    it('同分按 path 字典序稳定排序，limit 截断', () => {
      const result = service.lookup('uart', 1)

      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0]?.path).toBe('protocols/uart/garbled-data.md')
    })

    it('大小写不敏感匹配 keyword', () => {
      const result = service.lookup('NACK')

      expect(result.found).toBe(true)
      expect(result.candidates[0]?.path).toBe('protocols/i2c/nack.md')
    })

    it('空查询返回 empty_query', () => {
      for (const query of ['', '   ', '\n\t']) {
        expect(service.lookup(query)).toEqual({
          found: false,
          candidates: [],
          reason: 'empty_query',
        })
      }
    })

    it('无命中返回 no_match', () => {
      expect(service.lookup('温度传感器漂移')).toEqual({
        found: false,
        candidates: [],
        reason: 'no_match',
      })
    })
  })

  describe('read', () => {
    it('读取 markdown 并解析 frontmatter', () => {
      const result = service.read('protocols/uart/no-output.md')

      expect(result.path).toBe('protocols/uart/no-output.md')
      expect(result.content).toContain('UART 接线要共地')
      expect(result.frontmatterParsed).toBe(true)
      expect(result.frontmatter?.['name']).toBe('evidence-no-output')
      expect(result.frontmatter?.['tags']).toEqual(['serial'])
      expect(result.reviewStatus).toBe('reviewed')
    })

    it('反斜杠相对路径规范化后仍可读', () => {
      const result = service.read('protocols\\uart\\no-output.md')

      expect(result.path).toBe('protocols/uart/no-output.md')
    })

    it('_inbox.md 可读但标记为 unreviewed', () => {
      const result = service.read('_inbox.md')

      expect(result.reviewStatus).toBe('unreviewed')
      expect(result.frontmatterParsed).toBe(false)
      expect(result.frontmatter).toBeUndefined()
      expect(result.content).toContain('UART 待归档候选')
    })

    it('_about.md 与 cases/_about.md 按 basename 标记为 unreviewed', () => {
      expect(service.read('_about.md').reviewStatus).toBe('unreviewed')
      expect(service.read('cases/_about.md').reviewStatus).toBe('unreviewed')
    })

    it('普通 markdown 标记为 reviewed', () => {
      expect(service.read('protocols/uart/garbled-data.md').reviewStatus).toBe('reviewed')
    })

    it('拒绝 .. 路径、绝对路径与空路径', () => {
      expect(errorCode(() => service.read('../secret.md'))).toBe('path_denied')
      expect(errorCode(() => service.read('protocols/../../secret.md'))).toBe('path_denied')
      expect(errorCode(() => service.read(path.join(root, 'protocols/uart/no-output.md')))).toBe(
        'path_denied',
      )
      expect(errorCode(() => service.read('/etc/passwd'))).toBe('path_denied')
      expect(errorCode(() => service.read(''))).toBe('path_denied')
      expect(errorCode(() => service.read('   '))).toBe('path_denied')
    })

    it('拒绝非 .md/.yaml 扩展名', () => {
      expect(errorCode(() => service.read('notes.txt'))).toBe('path_denied')
      expect(errorCode(() => service.read('protocols'))).toBe('path_denied')
    })

    it('拒绝符号链接逃逸', () => {
      const outside = mkdtempSync(path.join(tmpdir(), 'kb-outside-'))
      try {
        writeFixture(outside, 'secret.md', '# 外部文件\n')
        symlinkSync(outside, path.join(root, 'escape'), 'junction')

        expect(errorCode(() => service.read('escape/secret.md'))).toBe('path_denied')
      } finally {
        try {
          rmSync(path.join(root, 'escape'), { recursive: false, force: true })
        } catch {
          /* junction 已被删除 */
        }
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('不存在的文件返回 not_found', () => {
      expect(errorCode(() => service.read('protocols/uart/missing.md'))).toBe('not_found')
    })

    it('超过 1 MiB 返回 file_too_large', () => {
      expect(errorCode(() => service.read('big.md'))).toBe('file_too_large')
    })

    it('默认读取小文件返回全文与总行数', () => {
      const result = service.read('protocols/uart/no-output.md')

      expect(result.offset).toBe(0)
      expect(result.lines).toBe(9)
      expect(result.totalLines).toBe(9)
      expect(result.truncated).toBe(false)
      expect(result.content.endsWith('第三行正文\n')).toBe(true)
    })

    it('offset/limit 只截取窗口，frontmatter 与 reviewStatus 仍按整份文件解析', () => {
      const result = service.read('protocols/uart/no-output.md', { offset: 6, limit: 2 })

      expect(result.content).toBe('第一行正文\nUART 接线要共地\n')
      expect(result.offset).toBe(6)
      expect(result.lines).toBe(2)
      expect(result.totalLines).toBe(9)
      expect(result.truncated).toBe(true)
      expect(result.frontmatterParsed).toBe(true)
      expect(result.frontmatter?.['name']).toBe('evidence-no-output')
      expect(result.reviewStatus).toBe('reviewed')
    })

    it('窗口读到文件末尾时 truncated 为 false', () => {
      const result = service.read('protocols/uart/no-output.md', { offset: 8, limit: 50 })

      expect(result.content).toBe('第三行正文\n')
      expect(result.lines).toBe(1)
      expect(result.truncated).toBe(false)
    })

    it('offset 越过文件末尾返回空窗口且不报错', () => {
      const result = service.read('protocols/uart/no-output.md', { offset: 100, limit: 10 })

      expect(result.content).toBe('')
      expect(result.offset).toBe(100)
      expect(result.lines).toBe(0)
      expect(result.totalLines).toBe(9)
      expect(result.truncated).toBe(false)
    })

    it('limit 默认与上限都是 2000 行', () => {
      writeFixture(root, 'long.md', `${Array.from({ length: 2100 }, (_, i) => `行 ${i}`).join('\n')}\n`)

      const byDefault = service.read('long.md')
      expect(byDefault.lines).toBe(2000)
      expect(byDefault.totalLines).toBe(2100)
      expect(byDefault.truncated).toBe(true)

      expect(service.read('long.md', { limit: 5000 }).lines).toBe(2000)

      const tail = service.read('long.md', { offset: 2000 })
      expect(tail.lines).toBe(100)
      expect(tail.totalLines).toBe(2100)
      expect(tail.truncated).toBe(false)
      expect(tail.content.startsWith('行 2000\n')).toBe(true)
      expect(tail.content.endsWith('行 2099\n')).toBe(true)
    })

    it('窗口按原文切片，CRLF 原样保留', () => {
      writeFixture(root, 'crlf.md', '第一行\r\n第二行\r\n')

      const result = service.read('crlf.md', { offset: 1, limit: 1 })

      expect(result.totalLines).toBe(2)
      expect(result.content).toBe('第二行\r\n')
    })
  })

  describe('glob', () => {
    it('protocols/**/*.md 命中嵌套文件，*.md 只命中根层', () => {
      writeFixture(root, 'overview.md', '# 概览\n')

      // scanTruncated 是本轮新增字段（D-179 ②），不是行为变化：
      // 遍历未触顶时为 false，与旧断言等价。
      expect(service.glob('protocols/**/*.md')).toEqual({
        found: true,
        matches: ['protocols/uart/garbled-data.md', 'protocols/uart/no-output.md'],
        count: 2,
        truncated: false,
        scanTruncated: false,
      })
      expect(service.glob('*.md').matches).toEqual(['big.md', 'overview.md'])
      expect(service.glob('**/*.md').matches).toContain('protocols/uart/no-output.md')
    })

    it('? 只匹配单个非分隔字符', () => {
      writeFixture(root, 'a.md', '# a\n')
      writeFixture(root, 'ab.md', '# ab\n')

      expect(service.glob('?.md').matches).toEqual(['a.md'])
      expect(service.glob('??.md').matches).toEqual(['ab.md'])
    })

    it('排除 _inbox.md、_about.md 与 index.yaml（含子目录同名文件）', () => {
      const matches = service.glob('**/*').matches

      expect(matches).not.toContain('_inbox.md')
      expect(matches).not.toContain('_about.md')
      expect(matches).not.toContain('cases/_about.md')
      expect(matches).not.toContain('index.yaml')
      expect(matches).not.toContain('notes.txt')
      expect(matches).toContain('big.md')
    })

    it('空 pattern 与空白 pattern 抛 invalid_pattern', () => {
      for (const pattern of ['', '   ']) {
        expect(errorCode(() => service.glob(pattern))).toBe('invalid_pattern')
      }
    })

    it('无匹配返回 found: false 与空数组', () => {
      expect(service.glob('no-such-dir/**/*.md')).toEqual({
        found: false,
        matches: [],
        count: 0,
        truncated: false,
        scanTruncated: false,
      })
    })

    it('超过 100 条时截断并标记 truncated，count 为实际命中总数', () => {
      const names = Array.from({ length: 150 }, (_, i) => `bulk/file-${String(i).padStart(3, '0')}.md`)
      for (const name of names) writeFixture(root, name, '# x\n')

      const result = service.glob('bulk/*.md')

      expect(result.matches).toHaveLength(100)
      expect(result.matches[0]).toBe('bulk/file-000.md')
      expect(result.count).toBe(150)
      expect(result.truncated).toBe(true)
      expect(result.found).toBe(true)
      expect(result.scanTruncated).toBe(false)
    })

    it('遍历触顶时 scanTruncated 为 true，truncated 仍只表示返回条数被截', () => {
      // 上限做成可注入：只为测试用 3 个文件的小上限，不真造 20001 个文件。
      withIsolatedKb(
        5,
        (isolatedRoot) => {
          const limited = new KbService(isolatedRoot, { maxWalkFiles: 3 })
          const result = limited.glob('**/*.md')

          expect(result.scanTruncated).toBe(true)
          // 已扫描部分仍按名字序返回，且 count 只报已扫描到的。
          expect(result.matches).toEqual(['f-0.md', 'f-1.md', 'f-2.md'])
          expect(result.count).toBe(3)
          // 返回条数没被截：truncated 与 scanTruncated 是两个独立信号。
          expect(result.truncated).toBe(false)
        },
      )
    })

    it('上限恰好等于文件数时不标记截断', () => {
      withIsolatedKb(
        3,
        (isolatedRoot) => {
          const exact = new KbService(isolatedRoot, { maxWalkFiles: 3 })

          const result = exact.glob('**/*.md')

          expect(result.matches).toHaveLength(3)
          expect(result.scanTruncated).toBe(false)
        },
      )
    })

    it('忽略 .git / node_modules 等缓存目录，不访问其内容', () => {
      for (const dir of ['.git', 'node_modules', 'dist', '__pycache__']) {
        writeFixture(root, `${dir}/secret.md`, 'UART 不该被检索到\n')
      }
      writeFixture(root, 'src/keep.md', 'UART 保留\n')

      const matches = service.glob('**/*.md').matches
      expect(matches).toContain('src/keep.md')
      expect(matches.some((item) => item.includes('secret'))).toBe(false)

      const paths = new Set(service.grep('UART 不该').hits.map((hit) => hit.path))
      expect(paths.size).toBe(0)
    })

    it('目录名按小写比较，Node_Modules 同样被忽略', () => {
      writeFixture(root, 'Node_Modules/secret.md', 'UART 不该被检索到\n')

      expect(service.glob('**/*.md').matches.some((item) => item.includes('secret'))).toBe(false)
    })

    it('拒绝绝对路径与 .. 段，不越出知识库根', () => {
      const outside = mkdtempSync(path.join(tmpdir(), 'kb-glob-outside-'))
      try {
        writeFixture(outside, 'secret.md', '# 外部\n')
        for (const pattern of ['../*.md', 'protocols/../../*.md', path.join(outside, '*.md'), '/*.md']) {
          expect(errorCode(() => service.glob(pattern)), pattern).toBe('path_denied')
        }
        expect(service.glob('**/*.md').matches.some((item) => item.includes('secret'))).toBe(false)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('反斜杠分隔符按 POSIX 分隔符处理', () => {
      expect(service.glob('protocols\\uart\\*.md').matches).toEqual([
        'protocols/uart/garbled-data.md',
        'protocols/uart/no-output.md',
      ])
    })

    it('超长或超深 pattern 被拒，把 (?:.*/)? 的层数关进笼子（D-086）', () => {
      // 每一段 `**/` 都是回溯时的一个可选出口：不设上限时 pattern 长度就是
      // 攻击面，而 pattern 来自模型输出，不是可信输入。
      expect(errorCode(() => service.glob('a'.repeat(257)))).toBe('invalid_pattern')
      expect(errorCode(() => service.glob(`${'**/'.repeat(65)}x.md`))).toBe('invalid_pattern')
      // 边界：上限不能顺手砍掉正常用法。
      expect(service.glob(`${'a'.repeat(252)}.md`).found).toBe(false)
      expect(service.glob(`${'**/'.repeat(20)}*.md`).found).toBe(true)
    })
  })

  describe('grep', () => {
    it('大小写不敏感，返回相对路径与 1-based 行号', () => {
      const result = service.grep('uart 接线')

      expect(result.found).toBe(true)
      expect(result.hits).toEqual([
        { path: 'protocols/uart/no-output.md', line: 8, text: 'UART 接线要共地' },
      ])
      expect(result.count).toBe(1)
      expect(result.truncated).toBe(false)
      // fileCount / files / scanTruncated 是本轮新增字段（D-179 ②）。
      expect(result.fileCount).toBe(1)
      expect(result.files).toEqual([{ path: 'protocols/uart/no-output.md', hits: 1 }])
      expect(result.scanTruncated).toBe(false)
    })

    it('正则语法生效，非法正则抛 invalid_regex 且带原因', () => {
      expect(service.grep('第.行正文').hits).toHaveLength(2)
      expect(service.grep('^UART\\s+接线').hits).toHaveLength(1)

      const error = errorOf(() => service.grep('(['))
      expect(error?.code).toBe('invalid_regex')
      expect(error?.message).toMatch(/\[/)
    })

    it('排除 _inbox.md、_about.md 与 index.yaml', () => {
      const paths = new Set(service.grep('UART').hits.map((hit) => hit.path))

      expect(paths.has('_inbox.md')).toBe(false)
      expect(paths.has('_about.md')).toBe(false)
      expect(paths.has('cases/_about.md')).toBe(false)
      expect(paths.has('index.yaml')).toBe(false)
      expect(paths.has('protocols/uart/no-output.md')).toBe(true)
    })

    it('glob 参数限定检索文件', () => {
      const all = service.grep('UART')
      const limited = service.grep('UART', 'system/*.md')

      expect(all.found).toBe(true)
      expect(limited).toEqual({
        found: false,
        hits: [],
        count: 0,
        truncated: false,
        fileCount: 0,
        files: [],
        scanTruncated: false,
      })
      expect(service.grep('优化', 'system/*.md').hits).toEqual([
        { path: 'system/toolchain.md', line: 2, text: '链接脚本与优化' },
      ])
    })

    it('命中行文本截断到 300 字符', () => {
      writeFixture(root, 'long-line.md', `UART ${'x'.repeat(400)}\n`)

      const hit = service.grep('UART', 'long-line.md').hits[0]

      expect(hit?.text).toHaveLength(300)
      expect(hit?.text.startsWith('UART ')).toBe(true)
    })

    it('超过 100 条时截断并标记 truncated，count 与 files[].hits 仍是真实总数', () => {
      const lines = Array.from({ length: 150 }, (_, i) => `needle ${i}`)
      writeFixture(root, 'bulk/hits.md', `${lines.join('\n')}\n`)

      const result = service.grep('needle')

      expect(result.found).toBe(true)
      expect(result.hits).toHaveLength(100)
      expect(result.count).toBe(150)
      expect(result.truncated).toBe(true)
      expect(result.hits[0]).toEqual({ path: 'bulk/hits.md', line: 1, text: 'needle 0' })
      expect(result.hits[99]?.line).toBe(100)
      // 返回条数被截断不影响文件级统计：files[].hits 是真值，不是前 100 条里的计数。
      expect(result.fileCount).toBe(1)
      expect(result.files).toEqual([{ path: 'bulk/hits.md', hits: 150 }])
    })

    it('fileCount 与 files 报出命中集中在几个文件（D-179 ②）', () => {
      writeFixture(root, 'signal/dense.md', 'topic alpha\nplain\ntopic alpha\ntopic alpha\n')
      writeFixture(root, 'signal/sparse-a.md', 'topic alpha\n')
      writeFixture(root, 'signal/sparse-b.md', 'topic alpha\n')

      const result = service.grep('topic alpha')

      expect(result.count).toBe(5)
      expect(result.fileCount).toBe(3)
      // 按 hits 降序，同数按 path 升序：dense 在前，两个 1 行的按字典序。
      expect(result.files).toEqual([
        { path: 'signal/dense.md', hits: 3 },
        { path: 'signal/sparse-a.md', hits: 1 },
        { path: 'signal/sparse-b.md', hits: 1 },
      ])
      // 与 count 一致：sum(files[].hits) === count（未超过 10 个文件时）。
      expect(result.files.reduce((sum, file) => sum + file.hits, 0)).toBe(result.count)
    })

    it('files 只保留命中最多的前 10 个文件，fileCount 仍是全部命中文件数', () => {
      for (let index = 0; index < 12; index += 1) {
        const repeats = (index % 3) + 1
        const body = Array.from({ length: repeats }, () => 'topic beta').join('\n')
        writeFixture(root, `many/f-${String(index).padStart(2, '0')}.md`, `${body}\n`)
      }

      const result = service.grep('topic beta')

      expect(result.fileCount).toBe(12)
      expect(result.files).toHaveLength(10)
      expect(result.count).toBe(24)
      expect(result.files[0]?.hits).toBe(3)
      // 稳定排序：hits 降序、同 hits 按 path 升序，截断后的前 10 个不随遍历顺序变化。
      expect(result.files.map((file) => file.path)).toEqual([
        'many/f-02.md',
        'many/f-05.md',
        'many/f-08.md',
        'many/f-11.md',
        'many/f-01.md',
        'many/f-04.md',
        'many/f-07.md',
        'many/f-10.md',
        'many/f-00.md',
        'many/f-03.md',
      ])
    })

    it('无命中返回 found: false，fileCount 与 files 为空', () => {
      expect(service.grep('zzz-not-there')).toEqual({
        found: false,
        hits: [],
        count: 0,
        truncated: false,
        fileCount: 0,
        files: [],
        scanTruncated: false,
      })
    })

    it('遍历触顶时 scanTruncated 为 true，count 与 files 只代表已扫描部分', () => {
      withIsolatedKb(
        5,
        (isolatedRoot) => {
          const limited = new KbService(isolatedRoot, { maxWalkFiles: 3 })
          const result = limited.grep('needle scan')

          expect(result.scanTruncated).toBe(true)
          expect(result.truncated).toBe(false)
          // 截断时 count 只覆盖已扫描到的文件，因此严格小于真实总数 5。
          expect(result.count).toBe(3)
          expect(result.fileCount).toBe(3)
          expect(result.files.map((file) => file.path)).toEqual(['f-0.md', 'f-1.md', 'f-2.md'])
        },
        'needle scan\n',
      )
    })

    it('忽略目录同样不进入 grep', () => {
      writeFixture(root, 'node_modules/secret.md', 'needle hidden\n')
      writeFixture(root, '.venv/secret.md', 'needle hidden\n')
      writeFixture(root, 'src/keep.md', 'needle visible\n')

      const paths = new Set(service.grep('needle').hits.map((hit) => hit.path))

      expect(paths.has('src/keep.md')).toBe(true)
      expect([...paths].some((item) => item.includes('secret'))).toBe(false)
    })

    it('glob 参数拒绝绝对路径与 .. 段', () => {
      expect(errorCode(() => service.grep('UART', '../*.md'))).toBe('path_denied')
      expect(errorCode(() => service.grep('UART', 'protocols/../../*.md'))).toBe('path_denied')
      expect(errorCode(() => service.grep('UART', '/etc/**'))).toBe('path_denied')
    })

    it('空正则按空模式处理为 invalid_pattern，而不是匹配每一行', () => {
      expect(errorCode(() => service.grep(''))).toBe('invalid_pattern')
    })
  })

  describe('search', () => {
    it('大小写不敏感命中，返回 1-based 行号与前后各一行上下文', () => {
      const result = service.search(['UART'])

      expect(result.found).toBe(true)
      const hit = result.hits.find(
        (item) =>
          item.path === 'protocols/uart/no-output.md' && item.token === 'UART',
      )
      expect(hit).toBeDefined()
      expect(hit?.line).toBe(8)
      expect(hit?.text).toBe('第一行正文\nUART 接线要共地\n第三行正文')
    })

    it('小写 token 命中小写与大写内容', () => {
      const result = service.search(['uart'])

      const paths = new Set(result.hits.map((hit) => hit.path))
      expect(paths.has('protocols/uart/no-output.md')).toBe(true)
      expect(paths.has('protocols/uart/garbled-data.md')).toBe(true)
    })

    it('排除 _inbox.md、_about.md 与 index.yaml', () => {
      const result = service.search(['UART'])

      const paths = new Set(result.hits.map((hit) => hit.path))
      expect(paths.has('_inbox.md')).toBe(false)
      expect(paths.has('_about.md')).toBe(false)
      expect(paths.has('index.yaml')).toBe(false)
      expect(paths.has('notes.txt')).toBe(false)
      expect(paths.has('big.md')).toBe(false)
    })

    it('limit 截断命中数', () => {
      expect(service.search(['UART'], 1).hits).toHaveLength(1)
    })

    it('无命中与空 token 返回 found: false', () => {
      expect(service.search(['zzz-not-there'])).toEqual({ found: false, hits: [] })
      expect(service.search([])).toEqual({ found: false, hits: [] })
    })

    it('token 只做字面匹配，不按正则解释', () => {
      expect(service.search(['U.RT'])).toEqual({ found: false, hits: [] })
    })

    it('遍历触顶时显式返回 scanTruncated，不静默少扫', () => {
      withIsolatedKb(
        5,
        (isolatedRoot) => {
          const limited = new KbService(isolatedRoot, { maxWalkFiles: 3 })
          const result = limited.search(['needle'])

          expect(result.scanTruncated).toBe(true)
          expect(result.hits.length).toBeLessThan(5)
        },
        'needle scan\n',
      )
    })

    it('未触顶时不出现 scanTruncated 字段', () => {
      expect(service.search(['UART']).scanTruncated).toBeUndefined()
    })
  })

  describe('status', () => {
    it('统计 markdown 文件数、索引条目与索引存在性', () => {
      expect(service.status()).toEqual({
        root: realpathSync(root),
        fileCount: 7,
        indexEntries: 4,
        indexPresent: true,
        inboxPending: 0,
      })
    })

    it('遍历触顶时 fileCount 只是下界，并显式给出 scanTruncated', () => {
      withIsolatedKb(5, (isolatedRoot) => {
        const limited = new KbService(isolatedRoot, { maxWalkFiles: 3 })

        const status = limited.status()

        expect(status.fileCount).toBe(3)
        expect(status.scanTruncated).toBe(true)
      })
    })

    it('KB 根不存在时不崩溃，indexPresent 为 false', () => {
      const ghostRoot = path.join(root, 'no-such-dir')
      const ghost = new KbService(ghostRoot)

      expect(ghost.status()).toEqual({
        root: path.resolve(ghostRoot),
        fileCount: 0,
        indexEntries: 0,
        indexPresent: false,
        inboxPending: 0,
      })
      expect(ghost.status().scanTruncated).toBeUndefined()
      expect(ghost.lookup('串口')).toEqual({
        found: false,
        candidates: [],
        reason: 'index_missing',
      })
      expect(ghost.search(['UART'])).toEqual({ found: false, hits: [] })
    })
  })
})