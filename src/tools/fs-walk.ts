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

/**
 * Sees each directory the walk accepts into its queue.
 *
 * Called before the directory is visited, and only for directories that pass
 * the same rules as a normal walk (not a symlink, not on the ignore list).
 * Synchronous on purpose: it reports what BFS already discovered, and making
 * it awaitable would let a caller change the traversal's timing.
 */
export type DirectoryVisitor = (absolute: string, relative: string) => void;

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
 *
 * `visitDirectory` 是给「目录本身也是结果」的调用方（`@` 文件名搜索）用的。
 * 它在该目录通过全部接受规则（非符号链接、不在忽略清单）**入队时**触发，
 * 因此：
 * - 不增加任何 I/O——这些目录本来就要 readdir，名字已经在手上；
 * - **不消耗 `scanned` 预算**。预算是文件数，这条语义在 `glob` / `grep` /
 *   搜索三处必须一致；若目录也计数，同一个预算买到的文件覆盖会随目录密度
 *   变化，`scanTruncated` 的含义也随之漂移。
 * - 根目录本身不触发：调用方要的是「根下面有哪些目录」，根不是一个候选。
 * 截断时未发现的目录不会被静默漏掉——预算截停一律置 `scanTruncated`，
 * 与文件走到同一条「结果可能不完整」的披露路径。
 */
export async function walkFiles(
  root: string,
  workdir: string,
  visit: FileVisitor,
  maxScanned = MAX_SCANNED_FILES,
  signal?: AbortSignal,
  visitDirectory?: DirectoryVisitor,
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
        visitDirectory?.(absolute, toPosix(path.relative(workdir, absolute)));
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
