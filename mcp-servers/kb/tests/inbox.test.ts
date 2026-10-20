import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendProposal,
  appendReviewed,
  formatProposal,
  newProposalId,
  parseInbox,
  proposalDigest,
  removeProposal,
} from '../inbox.js'
import type { KbProposal } from '../inbox.js'

const INBOX_FIXTURE = `# 知识库收件箱

<!-- kb_propose appends below this line -->
---
date: 2026-10-01
kind: trap
domain: uart
source: session:old
content: 旧条目内容
---
id: 20261020-120000-abcdef
date: 2026-10-20
kind: correction
domain: stm32
source: user correction
title: USART2 引脚
content: 第一行
第二行
---
`

function proposal(overrides: Partial<KbProposal> = {}): KbProposal {
  return {
    id: '20261020-130000-123456',
    date: '2026-10-20',
    kind: 'trap',
    domain: 'renode',
    source: 'session:new',
    content: 'Renode 复位后 USART2 未初始化',
    ...overrides,
  }
}

describe('parseInbox', () => {
  it('解析旧块与带 id 的块，旧块生成稳定 legacy id', () => {
    const proposals = parseInbox(INBOX_FIXTURE)

    expect(proposals).toHaveLength(2)
    expect(proposals[0]).toMatchObject({
      id: 'legacy-1',
      date: '2026-10-01',
      kind: 'trap',
      domain: 'uart',
      source: 'session:old',
      content: '旧条目内容',
    })
    expect(proposals[1]).toMatchObject({
      id: '20261020-120000-abcdef',
      kind: 'correction',
      title: 'USART2 引脚',
      content: '第一行\n第二行',
    })
  })

  it('忽略没有正文的空块', () => {
    expect(parseInbox('---\nid: x\nkind: trap\n---\n')).toEqual([])
  })
})

describe('formatProposal', () => {
  it('生成以分隔线包裹的块', () => {
    const text = formatProposal(proposal())
    expect(text.startsWith('---\nid: 20261020-130000-123456\n')).toBe(true)
    expect(text.endsWith('---\n')).toBe(true)
    expect(parseInbox(text)).toHaveLength(1)
  })

  it('保留多行正文', () => {
    const text = formatProposal(proposal({ content: '第一行\n第二行' }))
    expect(parseInbox(text)[0]?.content).toBe('第一行\n第二行')
  })
})

describe('appendProposal / removeProposal', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kb-inbox-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('文件不存在时创建头部并追加', () => {
    const result = appendProposal(root, proposal())

    expect(result.path).toBe('_inbox.md')
    expect(result.duplicateOf).toBeUndefined()
    const text = readFileSync(path.join(root, '_inbox.md'), 'utf8')
    expect(text).toContain('# 知识库收件箱')
    expect(parseInbox(text)).toHaveLength(1)
  })

  it('同一 kind/domain/content 不重复写入', () => {
    const first = appendProposal(root, proposal())
    const second = appendProposal(root, proposal({ id: '20261020-140000-999999' }))

    expect(first.duplicateOf).toBeUndefined()
    expect(second.duplicateOf).toBe('20261020-130000-123456')
    expect(parseInbox(readFileSync(path.join(root, '_inbox.md'), 'utf8'))).toHaveLength(1)
  })

  it('移除提案保留头部与其他块', () => {
    writeFileSync(path.join(root, '_inbox.md'), INBOX_FIXTURE, 'utf8')

    const removed = removeProposal(root, '20261020-120000-abcdef')

    expect(removed?.content).toBe('第一行\n第二行')
    const text = readFileSync(path.join(root, '_inbox.md'), 'utf8')
    expect(text).toContain('# 知识库收件箱')
    expect(text).toContain('旧条目内容')
    expect(text).not.toContain('USART2 引脚')
    expect(parseInbox(text)).toHaveLength(1)
  })

  it('移除不存在的 id 返回 undefined 且不改文件', () => {
    writeFileSync(path.join(root, '_inbox.md'), INBOX_FIXTURE, 'utf8')
    const before = readFileSync(path.join(root, '_inbox.md'), 'utf8')

    expect(removeProposal(root, 'missing')).toBeUndefined()
    expect(readFileSync(path.join(root, '_inbox.md'), 'utf8')).toBe(before)
  })
})

describe('appendReviewed', () => {
  it('创建审核记录并追加状态', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kb-reviewed-'))
    try {
      expect(
        appendReviewed(root, {
          id: 'abc',
          status: 'accepted',
          reviewedAt: '2026-10-20T12:00:00.000Z',
          target: 'protocols/uart/no-output.md',
        }),
      ).toBe('_reviewed.md')
      const text = readFileSync(path.join(root, '_reviewed.md'), 'utf8')
      expect(text).toContain('status: accepted')
      expect(text).toContain('target: protocols/uart/no-output.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('proposalDigest / newProposalId', () => {
  it('忽略 source/title/date，只按 kind/domain/content 计算', () => {
    const left = proposal()
    const right = proposal({ id: 'x', date: '2000-01-01', source: 'other', title: 't' })
    expect(proposalDigest(left)).toBe(proposalDigest(right))
  })

  it('生成时间戳加随机后缀的 id', () => {
    const id = newProposalId(new Date('2026-10-20T12:34:56.789Z'))
    expect(id).toMatch(/^20261020123456-[0-9a-f]{6}$/)
  })
})