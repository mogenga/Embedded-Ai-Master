import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 一份 PDF 的页级缓存条目（JSON 形态与 A 侧 datasheet.ts 完全一致）。 */
export interface DatasheetCacheEntry {
  /** 相对检索根的路径，POSIX 分隔符。 */
  path: string
  pages: string[]
  /** 该 PDF 没有文本层（扫描件）：记下来，后续查询不再反复重提取。 */
  empty?: boolean
}

interface StoredEntry extends DatasheetCacheEntry {
  stamp?: string
}

/**
 * 页级 JSON 缓存。
 *
 * 键 = sha1(绝对路径) 前 16 位；stamp = `mtimeMs:size`。文件被替换后 stamp
 * 变化自然失效，未变化时一次读取代替一次 30 秒的提取。写失败静默：缓存是
 * 加速器，丢它只损时间不损正确性。
 *
 * 「写入前显式拒绝越界」：所有写入目标必须是 `<cacheDir>/<hex16>.json`，
 * store 前显式校验目标仍在缓存目录内；cacheDir 必须解析为绝对路径，否则
 * 构造时抛错（显式失败，不静默降级）。
 */
export class DatasheetCache {
  private readonly dir: string

  constructor(cacheDir: string) {
    const resolved = path.resolve(cacheDir)
    if (!path.isAbsolute(resolved)) {
      throw new Error(`datasheet cache dir must resolve to an absolute path: ${cacheDir}`)
    }
    this.dir = resolved
  }

  get directory(): string {
    return this.dir
  }

  /** sha1(绝对路径) 前 16 位，纯 hex——文件名不含任何用户输入成分。 */
  keyFor(file: string): string {
    return createHash('sha1').update(file).digest('hex').slice(0, 16)
  }

  private target(file: string): string {
    return path.join(this.dir, `${this.keyFor(file)}.json`)
  }

  /** stamp 匹配才返回；读不到/坏 JSON/不匹配都返回 null（视为无缓存）。 */
  load(file: string, stamp: string): DatasheetCacheEntry | null {
    try {
      const cached = JSON.parse(readFileSync(this.target(file), 'utf8')) as StoredEntry
      if (cached.stamp === stamp && Array.isArray(cached.pages)) {
        const { path: p, pages, empty } = cached
        return empty === true ? { path: p, pages, empty } : { path: p, pages }
      }
      return null
    } catch {
      return null
    }
  }

  /** 写失败静默（缓存丢失只损时间）；目标越出缓存目录时显式拒绝写入。 */
  store(file: string, entry: DatasheetCacheEntry, stamp: string): void {
    const target = this.target(file)
    if (path.dirname(target) !== this.dir) {
      throw new Error(`refusing to write datasheet cache outside its directory: ${target}`)
    }
    const payload: StoredEntry = { ...entry, stamp }
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(target, JSON.stringify(payload), 'utf8')
    } catch {
      /* the cache is an accelerator; losing it costs time, not correctness */
    }
  }

  /** 缓存目录里的条目数（status 统计用；目录不存在按 0）。 */
  count(): number {
    try {
      return readdirSync(this.dir).filter((name) => /\.json$/.test(name)).length
    } catch {
      return 0
    }
  }
}