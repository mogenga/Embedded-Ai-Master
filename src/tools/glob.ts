import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { walkFiles, MAX_SCANNED_FILES } from "./fs-walk.js";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

export const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});

export type GlobInput = z.infer<typeof globInputSchema>;

const MAX_RESULTS = 200;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

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

function compilePattern(raw: string): RegExp | undefined {
  const normalized = raw.replace(/\\/g, "/");
  if (
    normalized.length === 0
    || normalized.length > MAX_PATTERN_LENGTH
    || normalized.includes("\0")
  ) {
    return undefined;
  }
  const pattern = normalized.replace(/(^|\/)(?:\*\*\/){2,}/g, "$1**/");
  if (pattern.split("/").filter((segment) => segment.length > 0).length > MAX_PATTERN_SEGMENTS) {
    return undefined;
  }
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      const double = pattern[index + 1] === "*";
      const startsSegment = index === 0 || pattern[index - 1] === "/";
      const after = double ? index + 2 : index + 1;
      const endsSegment = after >= pattern.length || pattern[after] === "/";
      if (double && startsSegment && endsSegment) {
        if (pattern[after] === "/") {
          source += "(?:.*/)?";
          index = after;
        } else {
          source += ".*";
          index = after - 1;
        }
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += REGEX_SPECIAL.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`, "u");
}

export function isValidGlob(pattern: string): boolean {
  return compilePattern(pattern) !== undefined;
}

export function matchesGlob(relPath: string, pattern: string): boolean {
  const regex = compilePattern(pattern);
  return regex ? regex.test(relPath) : false;
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
    const regex = compilePattern(input.pattern);
    if (!regex) {
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
          if (regex.test(relative)) matches.push(relative);
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
    if (state.scanTruncated) lines.push(`[scan truncated at ${MAX_SCANNED_FILES} files]`);
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
