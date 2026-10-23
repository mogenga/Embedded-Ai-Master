import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MANAGED_CORPUS_EXCLUDES } from '../inbox.js'
import { KbService, KbServiceError } from '../service.js'
import { kbTools } from '../tools.js'
import type { KbToolSpec } from '../tools.js'

/**
 * 外部 inbox（`KbServiceOptions.inboxPath`）的行为。
 *
 * 为什么必须注入读失败：真实 chmod 在 Windows 上不生效，也没有跨平台的「不可读文件」
 * 做法。这里用模块 mock 只让指定路径的 `readFileSync` 抛 EACCES，其余用例照常走真实 fs。
 */
let denyReadFileSync: string | undefined

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((target: unknown, options?: unknown) => {
      if (denyReadFileSync !== undefined && String(target) === denyReadFileSync) {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.readFileSync(target as never, options as never)
    }) as typeof actual.readFileSync,
  }
})

const INDEX_FIXTURE = `version: 1
entries:
  - id: uart-no-output
    title: 串口无输出
    path: protocols-uart-no-output.md
    tags: [uart]
    keywords: [没输出, 无输出]
    summary: 完全无输出
`

function findTool(tools: KbToolSpec[], name: string): KbToolSpec {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool
}

function structured(result: Awaited<ReturnType<KbToolSpec['handler']>>): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

describe('kb_propose 的外部 inbox', () => {
  let root: string
  let inboxDir: string
  let inboxFile: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kb-inbox-root-'))
    inboxDir = mkdtempSync(path.join(tmpdir(), 'kb-inbox-external-'))
    inboxFile = path.join(inboxDir, '_inbox.md')
    writeFileSync(path.join(root, 'index.yaml'), INDEX_FIXTURE, 'utf8')
    writeFileSync(path.join(root, 'protocols-uart-no-output.md'), '# 串口无输出\n', 'utf8')
    denyReadFileSync = undefined
  })

  afterEach(() => {
    denyReadFileSync = undefined
    rmSync(root, { recursive: true, force: true })
    rmSync(inboxDir, { recursive: true, force: true })
  })

  it('传 inboxPath 时写入该路径，且不创建语料根内的 _inbox.md', async () => {
    const tools = kbTools(new KbService(root, { inboxPath: inboxFile }))

    const result = await findTool(tools, 'kb_propose').handler({
      kind: 'trap',
      domain: 'renode',
      source: 'session:test',
      content: 'OTA 形态下的沉淀内容',
    })

    expect(result.isError).toBeUndefined()
    const data = structured(result)
    expect(data.status).toBe('pending_review')
    // 写在哪就报在哪：外部 inbox 用绝对路径，不伪装成根内的 `_inbox.md`。
    expect(data.inboxPath).toBe(inboxFile)
    expect(readFileSync(inboxFile, 'utf8')).toContain('content: OTA 形态下的沉淀内容')
    expect(existsSync(path.join(root, '_inbox.md'))).toBe(false)
  })

  it('不传 inboxPath 时行为与改动前一致（写 <root>/_inbox.md，回报相对路径）', async () => {
    const tools = kbTools(new KbService(root))

    const result = await findTool(tools, 'kb_propose').handler({
      kind: 'trap',
      domain: 'uart',
      source: 'session:test',
      content: '默认位置内容',
    })

    expect(structured(result).inboxPath).toBe('_inbox.md')
    expect(readFileSync(path.join(root, '_inbox.md'), 'utf8')).toContain(
      'content: 默认位置内容',
    )
    expect(existsSync(inboxFile)).toBe(false)
  })

  it('外部 inbox 下重复提交仍按 kind + domain + content 去重', async () => {
    const tools = kbTools(new KbService(root, { inboxPath: inboxFile }))
    const args = {
      kind: 'trap',
      domain: 'renode',
      source: 'session:test',
      content: '重复提交的外部内容',
    }

    const first = await findTool(tools, 'kb_propose').handler(args)
    const second = await findTool(tools, 'kb_propose').handler({ ...args, source: 'session:other' })

    expect(structured(second).duplicate).toBe(true)
    expect(structured(second).proposalId).toBe(structured(first).proposalId)
    expect(
      readFileSync(inboxFile, 'utf8').match(/content: 重复提交的外部内容/g),
    ).toHaveLength(1)
  })

  it('kb_status 如实回报 inbox 位置与待审数', async () => {
    const tools = kbTools(new KbService(root, { inboxPath: inboxFile }))
    await findTool(tools, 'kb_propose').handler({
      kind: 'trap',
      domain: 'uart',
      source: 's',
      content: '待审计数',
    })

    const status = structured(await findTool(tools, 'kb_status').handler({}))

    expect(status).toMatchObject({
      inboxPending: 1,
      inboxPath: inboxFile,
      inboxExternal: true,
    })
    expect(status.inboxError).toBeUndefined()
  })

  it('默认形态下 kb_status 报相对路径且 inboxExternal 为 false', () => {
    const status = new KbService(root).status()

    expect(status.inboxPath).toBe('_inbox.md')
    expect(status.inboxExternal).toBe(false)
    expect(status.inboxPending).toBe(0)
  })

  it('inbox 不存在时保持 inboxPending=0，不报错', () => {
    const status = new KbService(root, { inboxPath: inboxFile }).status()

    expect(status.inboxPending).toBe(0)
    expect(status.inboxError).toBeUndefined()
    expect(status.inboxPath).toBe(inboxFile)
  })

  it('inbox 读取失败时保留 inboxError，不吞成 0（R3）', async () => {
    writeFileSync(inboxFile, '---\nid: x\nkind: trap\ncontent: 内容\n---\n', 'utf8')
    denyReadFileSync = inboxFile
    const tools = kbTools(new KbService(root, { inboxPath: inboxFile }))

    const result = await findTool(tools, 'kb_status').handler({})

    expect(result.isError).toBeUndefined()
    const status = structured(result)
    expect(status.inboxPending).toBe(0)
    expect(String(status.inboxError)).toContain('EACCES')
  })

  it('外部 inbox 不经 kb_read 暴露：绝对路径被拒，根内同名路径按不存在处理', () => {
    writeFileSync(inboxFile, '# 待审\n', 'utf8')
    const service = new KbService(root, { inboxPath: inboxFile })

    // 取舍：宁可不给根外路径开口子，也不让 kb_read 变成任意文件读取。
    expect(() => service.read(inboxFile)).toThrowError(KbServiceError)
    expect(() => service.read(inboxFile)).toThrowError(/相对路径|越出知识库根目录/)
    expect(() => service.read('_inbox.md')).toThrowError(/不存在/)
  })

  it('inboxPath 指向语料根内时按根内处理（可读、回报相对路径）', () => {
    const inner = path.join(root, 'inbox', '_inbox.md')
    const status = new KbService(root, { inboxPath: inner }).status()

    expect(status.inboxExternal).toBe(false)
    expect(status.inboxPath).toBe('inbox/_inbox.md')
  })
})

describe('MANAGED_CORPUS_EXCLUDES', () => {
  it('第一项是 _inbox.md，且包含审核记录', () => {
    expect(MANAGED_CORPUS_EXCLUDES[0]).toBe('_inbox.md')
    expect(MANAGED_CORPUS_EXCLUDES).toContain('_inbox.md')
    expect(MANAGED_CORPUS_EXCLUDES).toContain('_reviewed.md')
  })
})
