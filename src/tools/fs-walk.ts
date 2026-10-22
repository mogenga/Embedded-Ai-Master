import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".harness",
  "dist",
  "coverage",
  "build",
  "out",
  "target",
  ".pio",
  // 语言/工具链缓存与虚拟环境：体积大且不是用户代码，容易在 5000 文件预算内挤掉浅层源码。
  ".mypy_cache",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".gradle",
  ".idea",
  ".svelte-kit",
]);
export const IGNORED_DIR_PREFIXES = ["cmake-build-"];
// 按后缀忽略的目录名，如 foo.egg-info(运行时生成，不是用户代码)。
export const IGNORED_DIR_SUFFIXES = [".egg-info"];
export const MAX_SCANNED_FILES = 5000;

// 扫描被预算截断时追加的可行动提示：结果是「不完整」的，并给出收窄范围的做法。
export const SCAN_TRUNCATED_HINT =
  "[the scan stopped before finishing - results are incomplete; narrow it with a subdirectory path or a glob filter]";

const UNREADABLE_CODES = new Set(["EACCES", "EPERM", "ENOENT"]);

export interface WalkState {
  scanned: number;
  skipped: number;
  // 不可读目录数与不可读文件数分开计数(D-089)。
  skippedDirectories: number;
  skippedFiles: number;
  scanTruncated: boolean;
}

export interface WalkResult {
  state: WalkState;
  error?: unknown;
}

export type FileVisitor = (absolute: string, relative: string) => Promise<void> | void;

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function isIgnoredDirectory(name: string): boolean {
  const normalized = process.platform === "win32" ? name.toLowerCase() : name;
  if (IGNORED_DIRS.has(normalized)) return true;
  if (IGNORED_DIR_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return IGNORED_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isUnreadable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && UNREADABLE_CODES.has(code);
}

function byName(a: Dirent, b: Dirent): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * 广度优先(层序)遍历 workdir。
 *
 * 采用 BFS 而不是 DFS 的原因：扫描预算(MAX_SCANNED_FILES)耗尽时，先覆盖的是根目录与浅层文件。
 * 旧实现是 DFS 且 readdir 顺序未排序，根条目里靠前的大缓存目录(如 .mypy_cache)会先被递归进去
 * 把预算耗尽，导致根目录下的 README.md 根本没被访问到(用户报告「输入查找 README.md，似乎并没有
 * 从项目文件夹开始找」)。
 *
 * 队列里只放目录路径，出队时才 readdir(惰性)：
 * - 内存 O(队列中的目录数)，即树的宽度；
 * - 预算耗尽时不会为尚未轮到的目录白读 readdir。
 * 同一层内按名字排序后再处理，使结果不依赖 readdir 的返回顺序。
 */
export async function walkFiles(
  root: string,
  workdir: string,
  visit: FileVisitor,
  maxScanned = MAX_SCANNED_FILES,
  signal?: AbortSignal,
): Promise<WalkResult> {
  const state: WalkState = {
    scanned: 0,
    skipped: 0,
    skippedDirectories: 0,
    skippedFiles: 0,
    scanTruncated: false,
  };

  const queue: string[] = [root];
  let head = 0;

  while (head < queue.length) {
    const dir = queue[head++]!;
    signal?.throwIfAborted();
    // D-080 保守语义：预算已满且队列里还有未访问目录(本身即「后续条目」)时，
    // 即使该目录可能是空的也标记截断，避免把「没扫完」说成「扫完了」。
    if (state.scanned >= maxScanned) {
      state.scanTruncated = true;
      return { state };
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isUnreadable(error)) {
        state.skipped += 1;
        state.skippedDirectories += 1;
        continue;
      }
      return { state, error };
    }
    entries.sort(byName);
    for (const entry of entries) {
      signal?.throwIfAborted();
      // 达到预算后只要还有任意后续条目(D-080 保守语义)就标记截断。
      if (state.scanned >= maxScanned) {
        state.scanTruncated = true;
        return { state };
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredDirectory(entry.name)) continue;
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      state.scanned += 1;
      signal?.throwIfAborted();
      await visit(absolute, toPosix(path.relative(workdir, absolute)));
    }
  }

  return { state };
}
