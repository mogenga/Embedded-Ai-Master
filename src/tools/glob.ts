import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

export const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});

export type GlobInput = z.infer<typeof globInputSchema>;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".harness",
  "dist",
  "coverage",
  "build",
  "out",
  "target",
  ".pio",
]);
const IGNORED_DIR_PREFIXES = ["cmake-build-"];
const UNREADABLE_CODES = new Set(["EACCES", "EPERM", "ENOENT"]);
const MAX_SCANNED_FILES = 5000;
const MAX_RESULTS = 200;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

interface WalkState {
  scanned: number;
  matched: number;
  skipped: number;
  scanTruncated: boolean;
  matches: string[];
}

function failure(code: string, message: string): ToolResult {
  return { isError: true, code, message, text: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isIgnoredDirectory(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  return IGNORED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isUnreadable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && UNREADABLE_CODES.has(code);
}

function compilePattern(raw: string): RegExp | undefined {
  const pattern = raw.replace(/\\/g, "/");
  if (pattern.length === 0 || pattern.includes("\0")) return undefined;
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

export function matchesGlob(relPath: string, pattern: string): boolean {
  const regex = compilePattern(pattern);
  return regex ? regex.test(relPath) : false;
}

async function walkEntries(
  dir: string,
  entries: Dirent[],
  workdir: string,
  regex: RegExp,
  state: WalkState,
): Promise<unknown | undefined> {
  for (const entry of entries) {
    if (state.scanned >= MAX_SCANNED_FILES) {
      state.scanTruncated = true;
      return undefined;
    }
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDirectory(entry.name)) continue;
      let children: Dirent[];
      try {
        children = await readdir(absolute, { withFileTypes: true });
      } catch (error) {
        if (isUnreadable(error)) {
          state.skipped += 1;
          continue;
        }
        return error;
      }
      const nested = await walkEntries(absolute, children, workdir, regex, state);
      if (nested !== undefined) return nested;
      continue;
    }
    if (!entry.isFile()) continue;
    state.scanned += 1;
    const relative = toPosix(path.relative(workdir, absolute));
    if (regex.test(relative)) {
      state.matched += 1;
      state.matches.push(relative);
    }
  }
  return undefined;
}

export const globTool: ToolDef<GlobInput> = {
  name: "glob",
  description:
    "在 workdir 内按 glob 模式查找文件；pattern 匹配相对 workdir 的 POSIX 路径（不是 path 根），* 也匹配以点开头的隐藏文件",
  schema: globInputSchema,
  annotations: { readOnly: true },
  execute: async (input, ctx: ToolCtx) => {
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

    const state: WalkState = {
      scanned: 0,
      matched: 0,
      skipped: 0,
      scanTruncated: false,
      matches: [],
    };

    let rootEntries: Dirent[];
    try {
      rootEntries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isUnreadable(error)) {
        state.skipped += 1;
        rootEntries = [];
      } else {
        return failure("read_failed", `cannot read directory ${input.path ?? "."}: ${errorMessage(error)}`);
      }
    }

    const resourceError = await walkEntries(root, rootEntries, workdir, regex, state);
    if (resourceError !== undefined) {
      return failure("read_failed", `cannot read directory: ${errorMessage(resourceError)}`);
    }

    state.matches.sort();
    const returned = state.matches.slice(0, MAX_RESULTS);
    const lines = returned.length === 0 ? ["(no matches)"] : [...returned];
    if (state.matched > MAX_RESULTS) lines.push("[truncated]");
    if (state.scanTruncated) lines.push(`[scan truncated at ${MAX_SCANNED_FILES} files]`);
    if (state.skipped > 0) lines.push(`[skipped ${state.skipped} unreadable entries]`);

    return {
      isError: false,
      code: "ok",
      message: "",
      detail: {
        scanned: state.scanned,
        matched: state.matched,
        returned: returned.length,
        skipped: state.skipped,
        truncated: state.matched > MAX_RESULTS,
        scanTruncated: state.scanTruncated,
      },
      text: lines.join("\n"),
    };
  },
};
