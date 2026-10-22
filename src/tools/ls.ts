import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

export const lsInputSchema = z.object({
  path: z.string().optional(),
});

export type LsInput = z.infer<typeof lsInputSchema>;

// 一次列目录最多回报 500 条：再多模型也读不完，而且会挤占上下文。
// 但「截断」必须如实说出来——条目数超限时 detail.truncated 置真、文本追加 [truncated]，
// 不能让调用方把「只看到前 500 条」误当成「目录里就这些」。
const MAX_ENTRIES = 500;

type LsEntryType = "dir" | "file" | "symlink" | "other";

interface LsEntry {
  name: string;
  type: LsEntryType;
  size?: number;
}

// 展示顺序：目录在前、文件在后，符号链接与其他类型排在最后，组内按名字排序。
const TYPE_RANK: Record<LsEntryType, number> = {
  dir: 0,
  file: 1,
  symlink: 2,
  other: 3,
};

function failure(code: string, message: string): ToolResult {
  return { isError: true, code, message, text: message };
}

function success(text: string, detail: unknown): ToolResult {
  return { isError: false, code: "ok", message: "", detail, text };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

// 人类可读大小：B / KB / MB，固定一位小数，让「1.2 KB」这种量级一眼可读。
// 不引入 GB 档：目录列表里的单文件超过 1 GiB 时继续用 MB 表达（1024.0 MB）也不会歧义。
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(1)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function classify(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): LsEntryType {
  // 先判断 symlink：目录链接在某些平台上 isDirectory() 也为 false，但顺序仍以 symlink 优先，
  // 保证「不跟随链接」的语义不会被 dirent 的实现细节改写。
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  return "other";
}

function compareEntries(a: LsEntry, b: LsEntry): number {
  const byType = TYPE_RANK[a.type] - TYPE_RANK[b.type];
  if (byType !== 0) return byType;
  if (a.name === b.name) return 0;
  return a.name.localeCompare(b.name);
}

function formatLine(entry: LsEntry): string {
  switch (entry.type) {
    case "dir":
      return `d  ${entry.name}/`;
    case "file":
      // 大小未知时写 "-" 而不是 0：R3——未知不是零，不能把 stat 失败伪装成空文件。
      return `f  ${entry.size === undefined ? "-" : formatSize(entry.size)}  ${entry.name}`;
    case "symlink":
      // 只标记不跟随：跟随会让 path-safety 的边界判定失效，也会把环/外部目标带进结果。
      return `l  ${entry.name}`;
    default:
      return `?  ${entry.name}`;
  }
}

export const lsTool: ToolDef<LsInput> = {
  name: "ls",
  description:
    "列出 workdir 内某个目录的直接子项（不递归），目录在前、文件在后，路径缺省为 workdir 根",
  schema: lsInputSchema,
  annotations: { readOnly: true },
  execute: async (input, ctx: ToolCtx, signal) => {
    if (signal.aborted) return failure("aborted", "ls aborted");

    const label = input.path ?? ".";
    const workdir = path.resolve(ctx.cwd);
    let root: string;
    try {
      root = resolveInWorkdir(workdir, label);
    } catch (error) {
      if (error instanceof ToolPathError) return failure(error.code, error.message);
      return failure("internal_error", errorMessage(error));
    }

    // 先 stat 再 readdir：只有 stat 成功且不是目录，才能把「路径是文件」和「目录不存在」区分开
    // （直接 readdir 两种情形都可能只给出 ENOTDIR）。
    let rootInfo;
    try {
      rootInfo = await stat(root);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        return failure("not_found", `directory not found: ${label}`);
      }
      return failure("read_failed", `cannot inspect directory ${label}: ${errorMessage(error)}`);
    }
    if (!rootInfo.isDirectory()) {
      return failure("not_a_directory", `not a directory: ${label}`);
    }

    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return failure("aborted", "ls aborted");
      const code = errorCode(error);
      // stat 与 readdir 之间目录可能被删除或替换成文件，按「不存在」回报而不是谎报空目录。
      if (code === "ENOENT" || code === "ENOTDIR") {
        return failure("not_found", `directory not found: ${label}`);
      }
      return failure("read_failed", `cannot read directory ${label}: ${errorMessage(error)}`);
    }
    if (signal.aborted) return failure("aborted", "ls aborted");

    // 这里刻意不套用 fs-walk 的忽略清单：glob / grep 的忽略清单是给「大范围扫描」用的，
    // 而 ls 是用户明确点名要看这个目录。点名要看 node_modules，就如实列出来，
    // 免得模型以为目录不存在或为空，反而去猜路径。
    const entries: LsEntry[] = dirents.map((dirent) => ({
      name: dirent.name,
      type: classify(dirent),
    }));

    // 先排序再截断：截断必须留下「前缀」，否则每次调用看到的都是 readdir 的随机顺序。
    entries.sort(compareEntries);
    const truncated = entries.length > MAX_ENTRIES;
    const shown = truncated ? entries.slice(0, MAX_ENTRIES) : entries;

    // 文件大小 dirent 不提供，只能逐个 lstat；用 lstat 而不是 stat，
    // 这样即使 readdir 之后条目被换成符号链接，也不会去读链接目标（可能在工作区外）的大小。
    for (const entry of shown) {
      if (entry.type !== "file") continue;
      if (signal.aborted) return failure("aborted", "ls aborted");
      try {
        const info = await lstat(path.join(root, entry.name));
        // 竞态下条目已不是普通文件时保持未知，不拿新类型的大小冒充。
        if (info.isFile()) entry.size = info.size;
      } catch {
        // 单个文件 stat 失败不影响整次列目录；该行大小写 "-"（R3：未知不是零）。
      }
    }

    const relative = toPosix(path.relative(workdir, root)) || ".";
    if (shown.length === 0) {
      // 空目录必须与失败可区分：返回明确的占位文本，而不是空字符串。
      return success("(empty directory)", { path: relative, entries: [], truncated: false });
    }

    const lines = shown.map(formatLine);
    if (truncated) lines.push("[truncated]");

    return success(lines.join("\n"), {
      path: relative,
      entries: shown,
      truncated,
    });
  },
};
