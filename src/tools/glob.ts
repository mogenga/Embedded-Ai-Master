import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { walkFiles, MAX_SCANNED_FILES, SCAN_TRUNCATED_HINT } from "./fs-walk.js";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

export const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});

export type GlobInput = z.infer<typeof globInputSchema>;

const MAX_RESULTS = 200;

function failure(code: string, message: string): ToolResult {
  return { isError: true, code, message, text: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

const MAX_PATTERN_LENGTH = 256;
const MAX_PATTERN_SEGMENTS = 64;

/**
 * 旧实现把模式编译成带可选「任意前缀 + 斜杠」组的正则；每个可选组都让失败匹配在
 * 长路径上回溯，globstar-a 前缀重复 12 次对 32 段路径实测 7.7–9.0 s（D-086）。
 *
 * 这里把同一份正则**逐 token 翻译**成一组只前进的转移，再按字符位置做 DP。
 * 语义与旧正则逐条对应（每个 token 就是旧源码里生成的那一小段），但每一步只保留
 * 「可达的位置集合」，不回退，复杂度 O(token 数 × 路径长度)。
 */
type GlobToken =
  /** 字面量（正则里被转义或原样输出的普通字符）。 */
  | { kind: "literal"; char: string }
  /** `*` → `[^/]*` */
  | { kind: "star" }
  /** `?` → `[^/]` */
  | { kind: "qmark" }
  /** 整段 `**` 且后面还有 `/` → 可选的「任意前缀 + 斜杠」组，斜杠也由本 token 吃掉。 */
  | { kind: "globstar" }
  /** 末尾的整段 `**` → `.*`。 */
  | { kind: "dotall" };

function isLineTerminator(char: string): boolean {
  // JS 正则的 `.` 不匹配这四个行终止符（且没有 `s` 标志）。
  return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";
}

export function isValidGlob(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, "/");
  if (
    normalized.length === 0
    || normalized.length > MAX_PATTERN_LENGTH
    || normalized.includes("\0")
  ) {
    return false;
  }
  const collapsed = normalized.replace(/(^|\/)(?:\*\*\/){2,}/g, "$1**/");
  return collapsed.split("/").filter((segment) => segment.length > 0).length <= MAX_PATTERN_SEGMENTS;
}

/**
 * 按旧 `compilePattern` 的字符循环逐条翻译成 token；非法模式返回 undefined。
 * 校验（`\` 归一、长度、段数、`\0`）与旧实现完全一致，见 `isValidGlob`。
 */
function compileGlob(pattern: string): GlobToken[] | undefined {
  if (!isValidGlob(pattern)) return undefined;
  const normalized = pattern.replace(/\\/g, "/");
  const collapsed = normalized.replace(/(^|\/)(?:\*\*\/){2,}/g, "$1**/");
  const chars = Array.from(collapsed);
  const tokens: GlobToken[] = [];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char === "*") {
      const double = chars[index + 1] === "*";
      const startsSegment = index === 0 || chars[index - 1] === "/";
      const after = double ? index + 2 : index + 1;
      const endsSegment = after >= chars.length || chars[after] === "/";
      if (double && startsSegment && endsSegment) {
        if (chars[after] === "/") {
          tokens.push({ kind: "globstar" });
          index = after;
        } else {
          tokens.push({ kind: "dotall" });
          index = after - 1;
        }
        continue;
      }
      tokens.push({ kind: "star" });
      continue;
    }
    if (char === "?") {
      tokens.push({ kind: "qmark" });
      continue;
    }
    tokens.push({ kind: "literal", char });
  }
  return tokens;
}

/**
 * 单 token 的位置转移：`next[j]` 表示从某个 `current[i]` 出发能走到路径的第 j 个
 * 码点位置。四个分支都只做一次前向扫描，没有回溯。
 */
function advance(
  current: Uint8Array,
  token: GlobToken,
  pathChars: readonly string[],
): Uint8Array {
  const length = pathChars.length;
  const next = new Uint8Array(length + 1);
  switch (token.kind) {
    case "literal": {
      for (let index = 0; index < length; index++) {
        if (current[index] === 1 && pathChars[index] === token.char) next[index + 1] = 1;
      }
      return next;
    }
    case "qmark": {
      for (let index = 0; index < length; index++) {
        if (current[index] === 1 && pathChars[index] !== "/") next[index + 1] = 1;
      }
      return next;
    }
    case "star": {
      let open = false;
      for (let index = 0; index <= length; index++) {
        if (current[index] === 1) open = true;
        if (!open) continue;
        next[index] = 1;
        if (index < length && pathChars[index] === "/") open = false;
      }
      return next;
    }
    case "dotall": {
      let open = false;
      for (let index = 0; index <= length; index++) {
        if (current[index] === 1) open = true;
        if (!open) continue;
        next[index] = 1;
        if (index < length && isLineTerminator(pathChars[index]!)) open = false;
      }
      return next;
    }
    case "globstar": {
      // 零次（保持原位），或「任意前缀 + 一个 `/`」，且前缀里不能有行终止符。
      let open = false;
      for (let index = 0; index <= length; index++) {
        if (current[index] === 1) {
          open = true;
          next[index] = 1;
        }
        if (!open) continue;
        if (pathChars[index] === "/") next[index + 1] = 1;
        if (index < length && isLineTerminator(pathChars[index]!)) open = false;
      }
      return next;
    }
  }
}

function matchesTokens(tokens: readonly GlobToken[], relPath: string): boolean {
  const pathChars = Array.from(relPath);
  let current: Uint8Array = new Uint8Array(pathChars.length + 1);
  current[0] = 1;
  for (const token of tokens) {
    current = advance(current, token, pathChars);
    if (!current.some((value) => value === 1)) return false;
  }
  return current[pathChars.length] === 1;
}

export function matchesGlob(relPath: string, pattern: string): boolean {
  const tokens = compileGlob(pattern);
  return tokens ? matchesTokens(tokens, relPath) : false;
}

// 供批量过滤场景预编译一次,避免每个文件重复编译(D-090)。
export function compileGlobMatcher(
  pattern: string,
): ((relPath: string) => boolean) | undefined {
  const tokens = compileGlob(pattern);
  if (tokens === undefined) return undefined;
  return (relPath: string) => matchesTokens(tokens, relPath);
}

export const globTool: ToolDef<GlobInput> = {
  name: "glob",
  description:
    "在 workdir 内按 glob 模式查找文件；pattern 匹配相对 workdir 的 POSIX 路径（不是 path 根），* 也匹配以点开头的隐藏文件",
  schema: globInputSchema,
  annotations: { readOnly: true },
  execute: async (input, ctx: ToolCtx, signal) => {
    if (signal.aborted) {
      return failure("aborted", "glob aborted");
    }
    const matchesPattern = compileGlobMatcher(input.pattern);
    if (!matchesPattern) {
      return failure("invalid_pattern", `invalid pattern: ${JSON.stringify(input.pattern)}`);
    }

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

    const matches: string[] = [];
    let outcome;
    try {
      outcome = await walkFiles(
        root,
        workdir,
        (_absolute, relative) => {
          if (matchesPattern(relative)) matches.push(relative);
        },
        MAX_SCANNED_FILES,
        signal,
      );
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return failure("aborted", "glob aborted");
      }
      return failure("read_failed", `cannot read directory: ${errorMessage(error)}`);
    }
    if (outcome.error !== undefined) {
      return failure("read_failed", `cannot read directory: ${errorMessage(outcome.error)}`);
    }

    const { state } = outcome;
    matches.sort();
    const returned = matches.slice(0, MAX_RESULTS);
    const lines = returned.length === 0 ? ["(no matches)"] : [...returned];
    if (matches.length > MAX_RESULTS) lines.push("[truncated]");
    if (state.scanTruncated) {
      lines.push(`[scan truncated at ${MAX_SCANNED_FILES} files]`);
      lines.push(SCAN_TRUNCATED_HINT);
    }
    if (state.skipped > 0) lines.push(`[skipped ${state.skipped} unreadable entries]`);

    return {
      isError: false,
      code: "ok",
      message: "",
      detail: {
        scanned: state.scanned,
        matched: matches.length,
        returned: returned.length,
        skipped: state.skipped,
        truncated: matches.length > MAX_RESULTS,
        scanTruncated: state.scanTruncated,
      },
      text: lines.join("\n"),
    };
  },
};
