import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { parseFrontmatter, parseIndexYaml } from '../yaml.js'

const realIndexPath = fileURLToPath(new URL('../kb/index.yaml', import.meta.url))
const realIndexExists = existsSync(realIndexPath)

const INDEX_FIXTURE = `# 症状索引
version: 1

entries:
  - id: uart-no-output
    title: 串口无输出
    path: protocols/uart/no-output.md
    tags: [uart, serial, rs232]
    keywords: [无输出, 没数据, no output]
    summary: 完全无输出或对端收不到

  # 厂商维度
  - id: uart-garbled
    title: '串口乱码: 波特率偏差'
    path: "protocols/uart/garbled-data.md"
    tags: ["uart", 'baud']
    keywords: [乱码, garbled]
    summary: 有数据但内容是乱码
`

describe('parseIndexYaml', () => {
  it('解析 entries 列表、行内数组、引号与注释', () => {
    const entries = parseIndexYaml(INDEX_FIXTURE)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      id: 'uart-no-output',
      title: '串口无输出',
      path: 'protocols/uart/no-output.md',
      tags: ['uart', 'serial', 'rs232'],
      keywords: ['无输出', '没数据', 'no output'],
      summary: '完全无输出或对端收不到',
    })
    expect(entries[1]?.title).toBe('串口乱码: 波特率偏差')
    expect(entries[1]?.path).toBe('protocols/uart/garbled-data.md')
    expect(entries[1]?.tags).toEqual(['uart', 'baud'])
  })

  it('缺少 summary 时补空字符串', () => {
    const entries = parseIndexYaml(`entries:
  - id: only-required
    title: 标题
    path: a/b.md
    tags: []
    keywords: []
`)
    expect(entries[0]?.summary).toBe('')
  })

  it('行内数组按逗号切分，引号内逗号不切', () => {
    const entries = parseIndexYaml(`entries:
  - id: quoted-comma
    title: 引号数组
    path: a.md
    tags: ['a,b', "c"]
    keywords: [d]
`)
    expect(entries[0]?.tags).toEqual(['a,b', 'c'])
  })

  it('缺少必填字段时抛错', () => {
    expect(() =>
      parseIndexYaml(`entries:
  - id: no-path
    title: 缺 path
    tags: []
    keywords: []
`),
    ).toThrow(/path/)
  })

  it('空文件与纯注释返回空数组', () => {
    expect(parseIndexYaml('')).toEqual([])
    expect(parseIndexYaml('# 只有注释\n\n')).toEqual([])
  })

  it('值中的冒号在首个冒号处分割', () => {
    const entries = parseIndexYaml(`entries:
  - id: colon
    title: 标题: 带冒号
    path: a.md
    tags: []
    keywords: []
    summary: 前置: 后置
`)
    expect(entries[0]?.title).toBe('标题: 带冒号')
    expect(entries[0]?.summary).toBe('前置: 后置')
  })

  it.skipIf(!realIndexExists)('真实 index.yaml 解析出 90 条', () => {
    const entries = parseIndexYaml(readFileSync(realIndexPath, 'utf8'))

    expect(entries).toHaveLength(90)
    const first = entries.find((entry) => entry.id === 'uart-no-output')
    expect(first?.path).toBe('protocols/uart/no-output.md')
    expect(first?.tags.length).toBeGreaterThan(0)
    expect(first?.keywords.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.id).not.toBe('')
      expect(entry.title).not.toBe('')
      expect(entry.path).not.toBe('')
      expect(Array.isArray(entry.tags)).toBe(true)
      expect(Array.isArray(entry.keywords)).toBe(true)
    }
  })
})

describe('parseFrontmatter', () => {
  it('解析简单键值、行内数组与引号内的冒号', () => {
    const text = `---
name: uart-no-output
tags: [uart, serial]
description: '串口无输出。触发词: 无输出, 收不到'
meaning: "真机: 有冒号"
---
# 正文
内容
`
    const result = parseFrontmatter(text)

    expect(result.parsed).toBe(true)
    expect(result.data['name']).toBe('uart-no-output')
    expect(result.data['tags']).toEqual(['uart', 'serial'])
    expect(result.data['description']).toBe('串口无输出。触发词: 无输出, 收不到')
    expect(result.data['meaning']).toBe('真机: 有冒号')
    expect(result.body).toBe('# 正文\n内容\n')
  })

  it('未加引号的冒号值解析失败但保留 body', () => {
    const text = `---
title: 未加引号: 的值
---
正文第一行
正文第二行
`
    const result = parseFrontmatter(text)

    expect(result.parsed).toBe(false)
    expect(result.body).toBe('正文第一行\n正文第二行\n')
  })

  it('无 frontmatter 时 parsed 为 false 且 body 为原文', () => {
    const text = '# 标题\n正文\n'
    const result = parseFrontmatter(text)

    expect(result.parsed).toBe(false)
    expect(result.data).toEqual({})
    expect(result.body).toBe(text)
  })

  it('未闭合的 frontmatter 不抛错且 body 为原文', () => {
    const text = `---
name: broken
正文
`
    const result = parseFrontmatter(text)

    expect(result.parsed).toBe(false)
    expect(result.body).toBe(text)
  })

  it('空文本不抛错', () => {
    expect(parseFrontmatter('')).toEqual({ data: {}, body: '', parsed: false })
  })
})