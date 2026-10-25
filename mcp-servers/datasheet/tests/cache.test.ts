import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DatasheetCache } from '../cache.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ds-cache-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function stampOf(file: string): string {
  const info = statSync(file)
  return `${info.mtimeMs}:${info.size}`
}

describe('DatasheetCache', () => {
  it('round-trips an entry while the stamp matches', () => {
    const cache = new DatasheetCache(path.join(dir, 'c'))
    const file = path.join(dir, 'rm0008.pdf')
    writeFileSync(file, '%PDF-1.4 fixture')
    const stamp = stampOf(file)
    cache.store(file, { path: 'rm0008.pdf', pages: ['page one', 'page two'] }, stamp)
    const loaded = cache.load(file, stamp)
    expect(loaded).toEqual({ path: 'rm0008.pdf', pages: ['page one', 'page two'] })
  })

  it('keeps the empty (no text layer) marker across a reload', () => {
    const cache = new DatasheetCache(path.join(dir, 'c'))
    const file = path.join(dir, 'scan.pdf')
    writeFileSync(file, '%PDF-1.4 scanned')
    const stamp = stampOf(file)
    cache.store(file, { path: 'scan.pdf', pages: [''], empty: true }, stamp)
    expect(cache.load(file, stamp)).toEqual({ path: 'scan.pdf', pages: [''], empty: true })
  })

  it('invalidates when the file is replaced (mtime or size changes)', () => {
    const cache = new DatasheetCache(path.join(dir, 'c'))
    const file = path.join(dir, 'a.pdf')
    writeFileSync(file, '%PDF-1.4 v1')
    const stamp = stampOf(file)
    cache.store(file, { path: 'a.pdf', pages: ['v1'] }, stamp)

    utimesSync(file, new Date(), new Date(Date.now() + 2000))
    expect(cache.load(file, stampOf(file))).toBeNull()

    writeFileSync(file, '%PDF-1.4 v2 with more bytes')
    expect(cache.load(file, stampOf(file))).toBeNull()

    // stamp 由调用方 stat 计算：用旧 stamp 查询会命中旧条目——这是失效
    // 模型的既定边界（indexFile 永远用当前 stat），不是缓存缺陷。
    expect(cache.load(file, stamp)).toEqual({ path: 'a.pdf', pages: ['v1'] })
  })

  it('returns null for a cache miss or a corrupt JSON file', () => {
    const cache = new DatasheetCache(path.join(dir, 'c'))
    const missing = path.join(dir, 'never.pdf')
    expect(cache.load(missing, '0:0')).toBeNull()

    const key = cache.keyFor(missing)
    mkdirSync(path.join(dir, 'c'), { recursive: true })
    writeFileSync(path.join(path.join(dir, 'c'), `${key}.json`), '{not json', 'utf8')
    expect(cache.load(missing, '0:0')).toBeNull()
  })

  it('keys are pure hex so the write target can never escape the cache dir', () => {
    const cache = new DatasheetCache(path.join(dir, 'c'))
    expect(cache.keyFor(path.join(dir, '..\\evil name with spaces.pdf'))).toMatch(/^[0-9a-f]{16}$/)
  })

  it('swallows write failures (cache loss costs time, not correctness)', () => {
    // 缓存目录路径被一个普通文件占位：mkdirSync 必然失败，store 必须静默。
    const blocker = path.join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const cache = new DatasheetCache(blocker)
    expect(() =>
      cache.store(path.join(dir, 'a.pdf'), { path: 'a.pdf', pages: ['x'] }, '1:1'),
    ).not.toThrow()
  })

  it('counts entries and reports 0 when the directory is absent', () => {
    const cache = new DatasheetCache(path.join(dir, 'absent'))
    expect(cache.count()).toBe(0)
    const file = path.join(dir, 'a.pdf')
    writeFileSync(file, '%PDF-1.4')
    cache.store(file, { path: 'a.pdf', pages: ['x'] }, stampOf(file))
    cache.store(path.join(dir, 'b.pdf'), { path: 'b.pdf', pages: ['y'] }, '0:0')
    expect(cache.count()).toBe(2)
  })
})