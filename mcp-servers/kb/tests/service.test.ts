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
  })

  describe('status', () => {
    it('统计 markdown 文件数、索引条目与索引存在性', () => {
      expect(service.status()).toEqual({
        root: realpathSync(root),
        fileCount: 7,
        indexEntries: 4,
        indexPresent: true,
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
      })
      expect(ghost.lookup('串口')).toEqual({
        found: false,
        candidates: [],
        reason: 'index_missing',
      })
      expect(ghost.search(['UART'])).toEqual({ found: false, hits: [] })
    })
  })
})