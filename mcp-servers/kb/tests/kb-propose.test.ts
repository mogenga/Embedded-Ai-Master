import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KbService } from '../service.js'
import { kbTools } from '../tools.js'
import type { KbToolSpec } from '../tools.js'

const INDEX_FIXTURE = `version: 1
entries:
  - id: uart-no-output
    title: 串口无输出
    path: protocols-uart-no-output.md
    tags: [uart]
    keywords: [没输出, 无输出]
    summary: 完全无输出
`

const NO_OUTPUT_FIXTURE = `# 串口无输出
检查接线与共地
`

function findTool(tools: KbToolSpec[], name: string): KbToolSpec {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool
}

function structured(result: Awaited<ReturnType<KbToolSpec['handler']>>): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

describe('kb_propose', () => {
  let root: string
  let tools: KbToolSpec[]

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kb-propose-'))
    writeFileSync(path.join(root, 'index.yaml'), INDEX_FIXTURE, 'utf8')
    writeFileSync(path.join(root, 'protocols-uart-no-output.md'), NO_OUTPUT_FIXTURE, 'utf8')
    tools = kbTools(new KbService(root))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('写入待审 inbox 并返回 pending_review', async () => {
    const result = await findTool(tools, 'kb_propose').handler({
      kind: 'trap',
      domain: 'renode',
      source: 'session:test',
      content: 'Renode 复位后 USART2 CR1/BRR 均为 0',
      title: 'Renode UART 复位基线',
    })

    expect(result.isError).toBeUndefined()
    const data = structured(result)
    expect(data.status).toBe('pending_review')
    expect(data.inboxPath).toBe('_inbox.md')
    expect(String(data.proposalId)).toMatch(/^\d{14}-[0-9a-f]{6}$/)
    const inbox = readFileSync(path.join(root, '_inbox.md'), 'utf8')
    expect(inbox).toContain('content: Renode 复位后 USART2 CR1/BRR 均为 0')
  })

  it('同一内容重复提交不重复写入', async () => {
    const args = {
      kind: 'trap',
      domain: 'renode',
      source: 'session:test',
      content: '重复内容',
    }
    const first = await findTool(tools, 'kb_propose').handler(args)
    const second = await findTool(tools, 'kb_propose').handler({ ...args, source: 'session:other' })

    expect(structured(second).duplicate).toBe(true)
    expect(structured(second).proposalId).toBe(structured(first).proposalId)
    expect(readFileSync(path.join(root, '_inbox.md'), 'utf8').match(/content: 重复内容/g)).toHaveLength(1)
  })

  it('拒绝空内容与破坏分隔线的正文', async () => {
    const empty = await findTool(tools, 'kb_propose').handler({
      kind: 'trap',
      domain: 'uart',
      source: 's',
      content: '',
    })
    expect(empty.isError).toBe(true)
    expect(structured(empty).code).toBe('invalid_argument')

    const blank = await findTool(tools, 'kb_propose').handler({
      kind: 'trap',
      domain: 'uart',
      source: 's',
      content: '   ',
    })
    expect(blank.isError).toBe(true)
    expect(structured(blank).code).toBe('invalid_argument')

    const blankDomain = await findTool(tools, 'kb_propose').handler({
      kind: 'trap',
      domain: '   ',
      source: 's',
      content: '正文',
    })
    expect(blankDomain.isError).toBe(true)
    expect(structured(blankDomain).code).toBe('invalid_argument')

    const separator = await findTool(tools, 'kb_propose').handler({
      kind: 'trap',
      domain: 'uart',
      source: 's',
      content: '第一段\n---\n第二段',
    })
    expect(separator.isError).toBe(true)
    expect(structured(separator).code).toBe('invalid_argument')
  })

  it('写入失败显式返回 proposal_failed', async () => {
    const ghost = kbTools(new KbService(path.join(root, 'missing-dir')))
    const result = await findTool(ghost, 'kb_propose').handler({
      kind: 'trap',
      domain: 'uart',
      source: 's',
      content: '写入失败',
    })

    expect(result.isError).toBe(true)
    expect(structured(result).code).toBe('proposal_failed')
  })

  it('未审提案不进入 lookup/search，status 报告待审数', async () => {
    await findTool(tools, 'kb_propose').handler({
      kind: 'trap',
      domain: 'uart',
      source: 's',
      content: 'UNIQUE_PROPOSAL_TOKEN_42',
    })

    const search = await findTool(tools, 'kb_search').handler({ tokens: ['UNIQUE_PROPOSAL_TOKEN_42'] })
    expect(structured(search)).toMatchObject({ found: false, hits: [] })

    const lookup = await findTool(tools, 'kb_lookup').handler({ query: 'UNIQUE_PROPOSAL_TOKEN_42' })
    expect(structured(lookup).found).toBe(false)

    const status = await findTool(tools, 'kb_status').handler({})
    expect(structured(status).inboxPending).toBe(1)
  })
})