import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { walkFiles, MAX_SCANNED_FILES } from "./fs-walk.js";
import { compileGlobMatcher, isValidGlob } from "./glob.js";
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

function compileRegex(pattern: string, ignoreCase: boolean): RegExp | undefined {
  if (pattern.length === 0) return undefined;
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    return undefined;
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
    const regex = compileRegex(input.pattern, input.ignoreCase ?? false);
    if (!regex) {
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

    const matches: MatchLine[] = [];
    const skipped: SkippedCounts = {
      binary: 0,
      tooLarge: 0,
      unreadableFiles: 0,
      unreadableDirectories: 0,
    };
    let skippedLongLines = 0;

    let outcome;
    try {
      outcome = await walkFiles(root, workdir, async (absolute, relative) => {
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
        for (let index = 0; index < lines.length; index++) {
          if ((index & 255) === 0) signal.throwIfAborted();
          const text = lines[index]!;
          if (Buffer.byteLength(text, "utf8") > MAX_LINE_BYTES) {
            skippedLongLines += 1;
            continue;
          }
          if (regex.test(text)) matches.push({ file: relative, line: index + 1, text });
        }
      }, MAX_SCANNED_FILES, signal);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return failure("aborted", "grep aborted");
      }
      return failure("read_failed", `cannot read directory: ${errorMessage(error)}`);
    }

    if (outcome.error !== undefined) {
      return failure("read_failed", `cannot read directory: ${errorMessage(outcome.error)}`);
    }

    skipped.unreadableDirectories += outcome.state.skippedDirectories;

    matches.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.line - b.line;
    });

    const returned = matches.slice(0, limit);
    const lines =
      returned.length === 0
        ? ["(no matches)"]
        : returned.map((match) => `${match.file}:${match.line}:${match.text}`);
    if (matches.length > limit) lines.push("[truncated]");

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
    }

    return {
      isError: false,
      code: "ok",
      message: "",
      detail: {
        scanned: outcome.state.scanned,
        matched: matches.length,
        returned: returned.length,
        skipped: {
          binary: skipped.binary,
          tooLarge: skipped.tooLarge,
          unreadableFiles: skipped.unreadableFiles,
          unreadableDirectories: skipped.unreadableDirectories,
        },
        skippedLongLines,
        truncated: matches.length > limit,
        scanTruncated: outcome.state.scanTruncated,
      },
      text: lines.join("\n"),
    };
  },
};