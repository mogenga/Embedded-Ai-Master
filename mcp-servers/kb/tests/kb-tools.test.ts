import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KbService } from '../service.js'
import { createKbService, resolveKbRoot } from '../server.js'
import { kbTools } from '../tools.js'
import type { KbToolSpec } from '../tools.js'

const INDEX_FIXTURE = `# 夹具索引
version: 1

entries:
  - id: uart-no-output
    title: 串口无输出
    path: protocols/uart/no-output.md
    tags: [uart, serial, rs232]
    keywords: [没输出, 无输出, 收不到]
    summary: 完全无输出或对端收不到

  - id: i2c-nack
    title: I2C 从机不应答
    path: protocols/i2c/nack.md
    tags: [i2c]
    keywords: [nack, 不应答]
    summary: 从机无 ACK
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

const NACK_FIXTURE = `# I2C NACK
从机没有返回 ACK
`

const INBOX_FIXTURE = `# 收件箱
UART 待归档候选
`

const ABOUT_FIXTURE = `# 关于
UART 语料说明
`

const CORRUPT_INDEX = `entries:
  - id: broken
    title: [未闭合
`

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function findTool(tools: KbToolSpec[], name: string): KbToolSpec {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool
}

function structured(result: Awaited<ReturnType<KbToolSpec['handler']>>): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

function errorCode(result: Awaited<ReturnType<KbToolSpec['handler']>>): unknown {
  return structured(result).code
}

describe('kbTools', () => {
  let root: string
  let tools: KbToolSpec[]

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kb-tools-'))
    writeFixture(root, 'index.yaml', INDEX_FIXTURE)
    writeFixture(root, 'protocols/uart/no-output.md', NO_OUTPUT_FIXTURE)
    writeFixture(root, 'protocols/i2c/nack.md', NACK_FIXTURE)
    writeFixture(root, '_inbox.md', INBOX_FIXTURE)
    writeFixture(root, '_about.md', ABOUT_FIXTURE)
    writeFixture(root, 'cases/_about.md', ABOUT_FIXTURE)
    tools = kbTools(new KbService(root))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('注册 7 个工具，其中 6 个只读，kb_read 标记为证据工具', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'kb_glob',
      'kb_grep',
      'kb_lookup',
      'kb_propose',
      'kb_read',
      'kb_search',
      'kb_status',
    ])
    for (const name of ['kb_lookup', 'kb_read', 'kb_search', 'kb_status', 'kb_glob', 'kb_grep']) {
      expect(findTool(tools, name).annotations?.readOnlyHint, name).toBe(true)
    }
    expect(findTool(tools, 'kb_glob').annotations?.destructiveHint).toBeUndefined()
    expect(findTool(tools, 'kb_grep').annotations?.destructiveHint).toBeUndefined()
    expect(findTool(tools, 'kb_propose').annotations?.readOnlyHint).toBe(false)
    expect(findTool(tools, 'kb_propose').annotations?.destructiveHint).toBe(true)
    expect(findTool(tools, 'kb_read').meta?.evidence).toBe(true)
  })

  it('kb_lookup 命中索引并支持 limit', async () => {
    const result = await findTool(tools, 'kb_lookup').handler({ query: '串口无输出', limit: 1 })

    expect(result.isError).toBeUndefined()
    const data = structured(result)
    expect(data.found).toBe(true)
    expect((data.candidates as Array<{ path: string }>)[0]?.path).toBe(
      'protocols/uart/no-output.md',
    )
    expect(data.reason).toBeUndefined()
  })

  it('kb_lookup 无命中返回 found=false 与 no_match', async () => {
    const result = await findTool(tools, 'kb_lookup').handler({ query: '温度传感器漂移' })

    expect(result.isError).toBeUndefined()
    expect(structured(result)).toMatchObject({
      found: false,
      candidates: [],
      reason: 'no_match',
    })
  })

  it('kb_lookup 空 query 返回 found=false 与 empty_query', async () => {
    const result = await findTool(tools, 'kb_lookup').handler({ query: '   ' })

    expect(result.isError).toBeUndefined()
    expect(structured(result)).toMatchObject({
      found: false,
      candidates: [],
      reason: 'empty_query',
    })
  })

  it('kb_read 读取文件并保留 reviewStatus', async () => {
    const tool = findTool(tools, 'kb_read')

    const parsed = await tool.handler({ path: 'protocols/uart/no-output.md' })
    expect(parsed.isError).toBeUndefined()
    expect(structured(parsed).content).toContain('UART 接线要共地')
    expect(structured(parsed).reviewStatus).toBe('reviewed')

    expect(structured(await tool.handler({ path: '_about.md' })).reviewStatus).toBe('unreviewed')
    expect(structured(await tool.handler({ path: 'cases/_about.md' })).reviewStatus).toBe(
      'unreviewed',
    )
  })

  it('kb_read 拒绝越界路径与非允许扩展名', async () => {
    const tool = findTool(tools, 'kb_read')

    for (const denied of ['../secret.md', 'protocols/../../secret.md', 'notes.txt', 'protocols']) {
      const result = await tool.handler({ path: denied })
      expect(result.isError).toBe(true)
      expect(errorCode(result)).toBe('path_denied')
    }
  })

  it('kb_read 对不存在的文件返回 not_found', async () => {
    const result = await findTool(tools, 'kb_read').handler({ path: 'protocols/uart/missing.md' })

    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('not_found')
  })

  it('kb_read 支持 offset/limit 并返回窗口元数据', async () => {
    const tool = findTool(tools, 'kb_read')

    const first = structured(await tool.handler({ path: 'protocols/uart/no-output.md' }))
    expect(first).toMatchObject({ offset: 0, lines: 9, totalLines: 9, truncated: false })

    const window = structured(
      await tool.handler({ path: 'protocols/uart/no-output.md', offset: 6, limit: 2 }),
    )
    expect(window).toMatchObject({ offset: 6, lines: 2, totalLines: 9, truncated: true })
    expect(window.content).toBe('第一行正文\nUART 接线要共地\n')
    expect(window.reviewStatus).toBe('reviewed')
  })

  it('kb_read 拒绝负 offset 与非正 limit，超过 2000 的 limit 夹到上限', async () => {
    const tool = findTool(tools, 'kb_read')

    for (const args of [
      { path: 'protocols/uart/no-output.md', offset: -1 },
      { path: 'protocols/uart/no-output.md', limit: 0 },
    ]) {
      const result = await tool.handler(args)
      expect(result.isError).toBe(true)
      expect(errorCode(result)).toBe('invalid_argument')
    }

    const clamped = structured(
      await tool.handler({ path: 'protocols/uart/no-output.md', limit: 100000 }),
    )
    expect(clamped).toMatchObject({ offset: 0, lines: 9, totalLines: 9, truncated: false })
  })

  it('kb_read 描述说明 truncated 的续读语义', () => {
    const description = findTool(tools, 'kb_read').description

    expect(description).toContain('truncated: true')
    expect(description).toContain('offset')
  })

  it('kb_glob 按模式列文件并排除导航文件', async () => {
    const tool = findTool(tools, 'kb_glob')

    const result = await tool.handler({ pattern: '**/*.md' })
    expect(result.isError).toBeUndefined()
    expect(structured(result)).toEqual({
      found: true,
      matches: ['protocols/i2c/nack.md', 'protocols/uart/no-output.md'],
      count: 2,
      truncated: false,
    })

    expect(structured(await tool.handler({ pattern: '*.md' })).matches).toEqual([])
  })

  it('kb_glob 空 pattern 返回 invalid_pattern，无匹配 found=false', async () => {
    const tool = findTool(tools, 'kb_glob')

    const invalid = await tool.handler({ pattern: '  ' })
    expect(invalid.isError).toBe(true)
    expect(errorCode(invalid)).toBe('invalid_pattern')

    const miss = await tool.handler({ pattern: 'no-such-dir/*.md' })
    expect(miss.isError).toBeUndefined()
    expect(structured(miss)).toEqual({ found: false, matches: [], count: 0, truncated: false })
  })

  it('kb_glob 拒绝越界路径', async () => {
    const tool = findTool(tools, 'kb_glob')

    for (const pattern of ['../*.md', 'protocols/../../*.md', '/etc/*.md']) {
      const result = await tool.handler({ pattern })
      expect(result.isError).toBe(true)
      expect(errorCode(result)).toBe('path_denied')
    }
  })

  it('kb_grep 大小写不敏感并返回 1-based 行号', async () => {
    const tool = findTool(tools, 'kb_grep')

    const result = await tool.handler({ pattern: 'uart 接线' })
    expect(result.isError).toBeUndefined()
    expect(structured(result)).toEqual({
      found: true,
      hits: [{ path: 'protocols/uart/no-output.md', line: 8, text: 'UART 接线要共地' }],
      count: 1,
      truncated: false,
    })
  })

  it('kb_grep 非法正则返回 invalid_regex，空 pattern 返回 invalid_pattern', async () => {
    const tool = findTool(tools, 'kb_grep')

    const invalid = await tool.handler({ pattern: '([' })
    expect(invalid.isError).toBe(true)
    expect(errorCode(invalid)).toBe('invalid_regex')
    expect(structured(invalid).message).toMatch(/\[/)

    const empty = await tool.handler({ pattern: '' })
    expect(empty.isError).toBe(true)
    expect(errorCode(empty)).toBe('invalid_pattern')
  })

  it('kb_grep 的 glob 参数限定文件并排除导航文件', async () => {
    const tool = findTool(tools, 'kb_grep')

    const all = structured(await tool.handler({ pattern: 'UART' }))
    const paths = new Set((all.hits as Array<{ path: string }>).map((hit) => hit.path))
    expect(paths.has('_inbox.md')).toBe(false)
    expect(paths.has('_about.md')).toBe(false)
    expect(paths.has('index.yaml')).toBe(false)

    const limited = structured(await tool.handler({ pattern: 'UART', glob: 'protocols/i2c/*.md' }))
    expect(limited).toEqual({ found: false, hits: [], count: 0, truncated: false })

    const denied = await tool.handler({ pattern: 'UART', glob: '../*.md' })
    expect(denied.isError).toBe(true)
    expect(errorCode(denied)).toBe('path_denied')
  })

  it('新工具描述写明无命中必须如实告知，且不含实验数字', () => {
    for (const name of ['kb_glob', 'kb_grep']) {
      const description = findTool(tools, name).description
      expect(description, name).toContain('found=false')
      expect(description, name).toContain('不得编造')
      expect(description, name).not.toMatch(/\d+\.\d+|\d{2,}%/)
    }
    expect(findTool(tools, 'kb_lookup').description).toContain('kb_grep')
    expect(findTool(tools, 'kb_search').description).toContain('kb_grep')
  })

  it('kb_search 返回命中上下文，空 token 返回 empty_query，无命中 found=false', async () => {
    const tool = findTool(tools, 'kb_search')

    const hit = await tool.handler({ tokens: ['共地'] })
    expect(hit.isError).toBeUndefined()
    expect(structured(hit).found).toBe(true)
    expect((structured(hit).hits as Array<{ path: string }>)[0]?.path).toBe(
      'protocols/uart/no-output.md',
    )

    const empty = await tool.handler({ tokens: ['  '] })
    expect(empty.isError).toBe(true)
    expect(errorCode(empty)).toBe('empty_query')

    const miss = await tool.handler({ tokens: ['温度传感器漂移'] })
    expect(miss.isError).toBeUndefined()
    expect(structured(miss)).toMatchObject({ found: false, hits: [] })
  })

  it('kb_status 报告文件数与索引状态', async () => {
    const result = await findTool(tools, 'kb_status').handler({})

    expect(result.isError).toBeUndefined()
    expect(structured(result)).toMatchObject({
      indexPresent: true,
      indexEntries: 2,
    })
  })

  it('KB 根不存在时 kb_status 返回 indexPresent=false 且不崩溃', async () => {
    const ghost = kbTools(new KbService(path.join(root, 'no-such-dir')))

    const status = await findTool(ghost, 'kb_status').handler({})
    expect(status.isError).toBeUndefined()
    expect(structured(status)).toMatchObject({ indexPresent: false, fileCount: 0 })

    const lookup = await findTool(ghost, 'kb_lookup').handler({ query: '串口' })
    expect(lookup.isError).toBeUndefined()
    expect(structured(lookup)).toMatchObject({ found: false, reason: 'index_missing' })
  })

  it('索引损坏时返回 index_invalid，不让 server 崩溃', async () => {
    writeFixture(root, 'index.yaml', CORRUPT_INDEX)
    const corruptTools = kbTools(new KbService(root))

    const lookup = await findTool(corruptTools, 'kb_lookup').handler({ query: '串口' })
    expect(lookup.isError).toBe(true)
    expect(errorCode(lookup)).toBe('index_invalid')

    const status = await findTool(corruptTools, 'kb_status').handler({})
    expect(status.isError).toBe(true)
    expect(errorCode(status)).toBe('index_invalid')
  })
})

describe('KB_ROOT', () => {
  it('缺省解析到 cwd 下的 mcp-servers/kb/kb', () => {
    expect(resolveKbRoot({}, 'C:/work/project')).toBe(
      path.resolve('C:/work/project', 'mcp-servers/kb/kb'),
    )
  })

  it('KB_ROOT 相对路径按 cwd 解析，绝对路径保持不变', () => {
    expect(resolveKbRoot({ KB_ROOT: 'kb-fixture' }, 'C:/work/project')).toBe(
      path.resolve('C:/work/project', 'kb-fixture'),
    )
    expect(resolveKbRoot({ KB_ROOT: '  C:/kb-root  ' }, 'C:/work/project')).toBe(
      path.resolve('C:/kb-root'),
    )
  })

  it('createKbService 使用传入的 cwd 与 KB_ROOT', () => {
    const service = createKbService({ KB_ROOT: 'no-such-kb-fixture-dir' }, process.cwd())

    expect(service.status().root).toBe(path.resolve(process.cwd(), 'no-such-kb-fixture-dir'))
  })
})