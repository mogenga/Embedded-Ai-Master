import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

export const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});

export type GlobInput = z.infer<typeof globInputSchema>;

const IGNORED_DIRS = new Set([".git", "node_modules", ".harness", "dist", "coverage"]);
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

function compilePattern(pattern: string): RegExp | undefined {
  if (pattern.length === 0 || pattern.includes("\0")) return undefined;
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += REGEX_SPECIAL.test(char) ? `\\${char}` : char;
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return undefined;
  }
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
): Promise<void> {
  for (const entry of entries) {
    if (state.scanned >= MAX_SCANNED_FILES) {
      state.scanTruncated = true;
      return;
    }
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      let children: Dirent[];
      try {
        children = await readdir(absolute, { withFileTypes: true });
      } catch {
        state.skipped += 1;
        continue;
      }
      await walkEntries(absolute, children, workdir, regex, state);
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
}

export const globTool: ToolDef<GlobInput> = {
  name: "glob",
  description: "在 workdir 内按 glob 模式查找文件",
  schema: globInputSchema,
  annotations: { readOnly: true },
  execute: async (input, ctx: ToolCtx) => {
    const regex = compilePattern(input.pattern);
    if (!regex) {
      return failure("invalid_pattern", `invalid pattern: ${JSON.stringify(input.pattern)}`);
    }

    let root: string;
    try {
      root = resolveInWorkdir(ctx.cwd, input.path ?? ".");
    } catch (error) {
      if (error instanceof ToolPathError) return failure(error.code, error.message);
      return failure("internal_error", errorMessage(error));
    }

    let rootEntries: Dirent[];
    try {
      rootEntries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      return failure("read_failed", `cannot read directory ${input.path ?? "."}: ${errorMessage(error)}`);
    }

    const state: WalkState = {
      scanned: 0,
      matched: 0,
      skipped: 0,
      scanTruncated: false,
      matches: [],
    };
    await walkEntries(root, rootEntries, ctx.cwd, regex, state);

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