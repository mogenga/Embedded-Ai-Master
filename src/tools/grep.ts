import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { walkFiles, MAX_SCANNED_FILES, SCAN_TRUNCATED_HINT } from "./fs-walk.js";
import { compileGlobMatcher, isValidGlob } from "./glob.js";
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_FILES,
  MATCH_TIMEOUT_MS,
  createInterruptibleMatcher,
} from "./interruptible-regex.js";
import type { BatchLine } from "./interruptible-regex.js";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

export const grepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(1000).optional(),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

const DEFAULT_MAX_RESULTS = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

interface MatchLine {
  file: string;
  line: number;
  text: string;
}

/** 候选的顺序：(file, line) 升序。文件按路径字典序，同文件按行号数值——与旧实现的 sort 比较器同序。 */
function compareMatches(a: MatchLine, b: MatchLine): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

/**
 * 有界有序候选集（D-078）。
 *
 * 旧实现把所有命中压进数组，遍历结束后才 `sort` + 截断：`maxResults` 只限返回
 * 条数，不限收集量（实测 200 万命中峰值 +195 MiB，只回 200 条）。
 *
 * 这里容量固定为 `limit + 1`：
 * - 数组未满：二分找插入点（O(log capacity) 比较 + 一次 splice）；
 * - 数组已满且候选排在末尾之后：O(1) 丢弃——命中密集时这是绝大多数路径；
 * - 数组已满且候选更小：弹掉末尾再插入，长度恒为 capacity。
 *
 * 容量取 `limit + 1` 而不是 `limit`，是为了让 `matched > limit` 这个 truncated
 * 边沿判断保持原样：`ordered.length > limit` 与 `matched > limit` 等价（数组只会
 * 停在 `min(matched, limit + 1)`）。
 *
 * `matched` 是真实命中总数的独立计数器，不取数组长度。
 *
 * 导出**仅供测试**断言「收集量被 capacity 封顶」这条不变量：堆峰值在本机由 GC
 * 节奏主导（同一语料换成永不命中的 pattern，实测峰值仍会在 0–33 MiB 之间漂），
 * 拿它当断言测的是 GC 而不是算法。生产代码只经由 `grepTool` 使用它。
 */
export class BoundedMatches {
  private readonly capacity: number;
  private readonly items: MatchLine[] = [];
  matched = 0;

  constructor(limit: number) {
    this.capacity = limit + 1;
  }

  add(candidate: MatchLine): void {
    this.matched += 1;
    const items = this.items;
    if (items.length >= this.capacity) {
      if (compareMatches(candidate, items[items.length - 1]!) >= 0) return;
      items.pop();
    }
    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareMatches(items[mid]!, candidate) <= 0) low = mid + 1;
      else high = mid;
    }
    items.splice(low, 0, candidate);
  }

  ordered(): readonly MatchLine[] {
    return this.items;
  }

  /** 仅供测试：当前缓存条数。生产代码用 `matched` 与 `ordered()`。 */
  get retained(): number {
    return this.items.length;
  }
}

/** 一批里攒下的一个文件：相对路径 + 已按行切好、超长行置 `null` 的行数组。 */
interface BatchFile {
  file: string;
  lines: BatchLine[];
}

/**
 * 单批正则求值超过 `MATCH_TIMEOUT_MS` 时从 `flush()` 抛出，由 `execute` 转成
 * `regex_timeout`。用异常而不是返回值，是为了让 `walkFiles` 立刻停掉剩余文件的
 * 遍历——继续扫下去只会白读磁盘，而且结果无论如何都要整批作废。
 */
class RegexBudgetExceeded extends Error {
  /** 被打断时正在匹配的文件（相对 workdir），用于错误文本定位。 */
  readonly file: string;

  constructor(file: string) {
    super(`regex evaluation exceeded ${MATCH_TIMEOUT_MS} ms`);
    this.file = file;
  }
}

interface SkippedCounts {
  binary: number;
  tooLarge: number;
  unreadableFiles: number;
  unreadableDirectories: number;
}

function failure(code: string, message: string): ToolResult {
  return { isError: true, code, message, text: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

/**
 * 语法校验留在主线程：非法 pattern 走 `invalid_pattern`，不进 vm（D-085 实现要求 7）。
 * 这里的 `RegExp` 只用于校验，实际求值在 `createInterruptibleMatcher` 里。
 */
function isValidRegex(pattern: string, ignoreCase: boolean): boolean {
  if (pattern.length === 0) return false;
  try {
    new RegExp(pattern, ignoreCase ? "i" : "");
    return true;
  } catch {
    return false;
  }
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export const grepTool: ToolDef<GrepInput> = {
  name: "grep",
  description:
    "在 workdir 内按正则搜索文件内容；输出 <相对 workdir 路径>:<行号>:<文本>，默认最多 200 条",
  schema: grepInputSchema,
  annotations: { readOnly: true },
  execute: async (input, ctx: ToolCtx, signal) => {
    if (signal.aborted) {
      return failure("aborted", "grep aborted");
    }
    if (!isValidRegex(input.pattern, input.ignoreCase ?? false)) {
      return failure("invalid_pattern", `invalid pattern: ${JSON.stringify(input.pattern)}`);
    }
    if (input.glob !== undefined && !isValidGlob(input.glob)) {
      return failure("invalid_pattern", `invalid glob pattern: ${JSON.stringify(input.glob)}`);
    }
    // glob 过滤每个文件重新编译会是 O(files × compile);这里预编译一次(D-090)。
    const globFilter =
      input.glob === undefined ? undefined : compileGlobMatcher(input.glob);

    const limit = input.maxResults ?? DEFAULT_MAX_RESULTS;
    const workdir = path.resolve(ctx.cwd);
    let root: string;
    try {
      root = resolveInWorkdir(workdir, input.path ?? ".");
    } catch (error) {
      if (error instanceof ToolPathError) return failure(error.code, error.message);
      return failure("internal_error", errorMessage(error));
    }

    let rootInfo;
    try {
      rootInfo = await stat(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return failure("not_found", `directory not found: ${input.path ?? "."}`);
      if (code === "ENOTDIR") {
        return failure("not_a_directory", `not a directory: ${input.path ?? "."}`);
      }
      return failure("read_failed", `cannot inspect directory ${input.path ?? "."}: ${errorMessage(error)}`);
    }
    if (!rootInfo.isDirectory()) {
      return failure("not_a_directory", `not a directory: ${input.path ?? "."}`);
    }

    const matches = new BoundedMatches(limit);
    const skipped: SkippedCounts = {
      binary: 0,
      tooLarge: 0,
      unreadableFiles: 0,
      unreadableDirectories: 0,
    };
    let skippedLongLines = 0;

    // 分批求值（D-085）：一个 matcher 活到这次调用结束，最多攒 50 个文件 / 4 MiB。
    const matcher = createInterruptibleMatcher(input.pattern, input.ignoreCase ?? false);
    let batch: BatchFile[] = [];
    let batchBytes = 0;

    const flush = () => {
      if (batch.length === 0) return;
      const result = matcher.testBatch(batch.map((entry) => entry.lines));
      if ("timedOut" in result) {
        const interrupted = batch[result.fileIndex] ?? batch[0]!;
        throw new RegexBudgetExceeded(interrupted.file);
      }
      // hits 是扁平下标（各文件的行首尾相接），用行数前缀和还原成 (文件, 行号)。
      let base = 0;
      let cursor = 0;
      for (const entry of batch) {
        const end = base + entry.lines.length;
        for (; cursor < result.hits.length && result.hits[cursor]! < end; cursor += 1) {
          const offset = result.hits[cursor]! - base;
          matches.add({ file: entry.file, line: offset + 1, text: entry.lines[offset]! });
        }
        base = end;
      }
      batch = [];
      batchBytes = 0;
    };

    let outcome;
    try {
      outcome = await walkFiles(root, workdir, async (absolute, relative) => {
        // 每一批之前检查取消；批内不再检查——批的墙钟上界由 MATCH_TIMEOUT_MS 兜住。
        signal.throwIfAborted();
        if (globFilter !== undefined && !globFilter(relative)) return;

        let info;
        try {
          info = await stat(absolute);
        } catch {
          skipped.unreadableFiles += 1;
          return;
        }
        if (!info.isFile()) return;
        if (info.size > MAX_FILE_BYTES) {
          skipped.tooLarge += 1;
          return;
        }

        let buffer: Buffer;
        try {
          buffer = await readFile(absolute);
        } catch {
          skipped.unreadableFiles += 1;
          return;
        }
        if (buffer.includes(0)) {
          skipped.binary += 1;
          return;
        }

        const lines = splitLines(buffer.toString("utf8"));
        // 超长行不参与匹配，但仍占一个下标，好让行号与原始文本对齐（`null` 占位）。
        const kept: BatchLine[] = [];
        for (let index = 0; index < lines.length; index++) {
          const text = lines[index]!;
          if (Buffer.byteLength(text, "utf8") > MAX_LINE_BYTES) {
            skippedLongLines += 1;
            kept.push(null);
          } else {
            kept.push(text);
          }
        }
        // 先按字节判定再入批：这样「4 MiB」是真正的上界，而不是「加上当前文件后
        // 可能到 6 MiB」。批里已有内容才刷，避免单个超限文件单独成批后仍超限。
        if (batch.length > 0 && batchBytes + buffer.length > BATCH_MAX_BYTES) flush();
        batch.push({ file: relative, lines: kept });
        batchBytes += buffer.length;
        if (batch.length >= BATCH_MAX_FILES) flush();
      }, MAX_SCANNED_FILES, signal);
      // 遍历本身出错时照旧优先报 read_failed：不拿最后一批的正则结果改写错误码。
      if (outcome.error === undefined) flush();
    } catch (error) {
      if (error instanceof RegexBudgetExceeded) {
        return failure(
          "regex_timeout",
          `regex_timeout: pattern ${JSON.stringify(input.pattern)} triggered catastrophic regex ` +
            `backtracking (正则回溯过长) and was interrupted after ${MATCH_TIMEOUT_MS} ms while ` +
            `matching ${error.file}; no results are returned - narrow the pattern or the path`,
        );
      }
      if (signal.aborted || isAbortError(error)) {
        return failure("aborted", "grep aborted");
      }
      return failure("read_failed", `cannot read directory: ${errorMessage(error)}`);
    }

    if (outcome.error !== undefined) {
      return failure("read_failed", `cannot read directory: ${errorMessage(outcome.error)}`);
    }

    skipped.unreadableDirectories += outcome.state.skippedDirectories;

    // BoundedMatches 内部始终按 (file, line) 升序，容量 limit + 1；这里只取前 limit 条。
    const ordered = matches.ordered();
    const returned = ordered.length > limit ? ordered.slice(0, limit) : ordered;
    const lines =
      returned.length === 0
        ? ["(no matches)"]
        : returned.map((match) => `${match.file}:${match.line}:${match.text}`);
    if (matches.matched > limit) lines.push("[truncated]");

    const skippedFiles = skipped.binary + skipped.tooLarge + skipped.unreadableFiles;
    const skippedEntries = skippedFiles + skipped.unreadableDirectories;
    if (skippedEntries > 0) {
      lines.push(
        `[skipped ${skippedEntries} entries (${skippedFiles} files, ${skipped.unreadableDirectories} unreadable directories)]`,
      );
    }
    if (skippedLongLines > 0) {
      lines.push(`[skipped ${skippedLongLines} lines longer than 1 MiB]`);
    }
    if (outcome.state.scanTruncated) {
      lines.push(`[scan truncated at ${MAX_SCANNED_FILES} files]`);
      lines.push(SCAN_TRUNCATED_HINT);
    }

    return {
      isError: false,
      code: "ok",
      message: "",
      detail: {
        scanned: outcome.state.scanned,
        matched: matches.matched,
        returned: returned.length,
        skipped: {
          binary: skipped.binary,
          tooLarge: skipped.tooLarge,
          unreadableFiles: skipped.unreadableFiles,
          unreadableDirectories: skipped.unreadableDirectories,
        },
        skippedLongLines,
        truncated: matches.matched > limit,
        scanTruncated: outcome.state.scanTruncated,
      },
      text: lines.join("\n"),
    };
  },
};