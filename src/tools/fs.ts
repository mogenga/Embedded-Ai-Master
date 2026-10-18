import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

export const fsInputSchema = z.object({
  op: z.enum(["read", "write", "edit"]),
  path: z.string().min(1),
  content: z.string().optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(2000).optional(),
});

export type FsInput = z.infer<typeof fsInputSchema>;

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 256 * 1024;

function failure(code: string, message: string, detail?: unknown): ToolResult {
  return { isError: true, code, message, detail, text: message };
}

function success(text: string, detail?: unknown): ToolResult {
  return { isError: false, code: "ok", message: "", detail, text };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function toRelative(workdir: string, absolute: string): string {
  return path.relative(path.resolve(workdir), absolute).split(path.sep).join("/");
}

function takeUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function splitLines(raw: string): string[] {
  if (raw.length === 0) return [];
  const lines = raw.split(/\r?\n/);
  if (raw.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type FileFailure = { failure: ToolResult } | { info: Awaited<ReturnType<typeof stat>> };

async function statRegularFile(absolute: string, inputPath: string): Promise<FileFailure> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { failure: failure("not_found", `file not found: ${inputPath}`) };
    }
    return { failure: failure("read_failed", `failed to stat ${inputPath}: ${errorMessage(error)}`) };
  }
  if (!info.isFile()) {
    return { failure: failure("not_a_file", `not a regular file: ${inputPath}`) };
  }
  return { info };
}

async function readOp(input: FsInput, ctx: ToolCtx): Promise<ToolResult> {
  const absolute = resolveInWorkdir(ctx.cwd, input.path);
  const checked = await statRegularFile(absolute, input.path);
  if ("failure" in checked) return checked.failure;

  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (error) {
    return failure("read_failed", `failed to read ${input.path}: ${errorMessage(error)}`);
  }

  const lines = splitLines(raw);
  const start = input.offset ?? 0;
  const maxLines = input.limit ?? MAX_READ_LINES;
  const output: string[] = [];
  let used = 0;
  let truncated = false;
  let index = start;

  for (; index < lines.length && output.length < maxLines; index++) {
    const prefix = `${String(index + 1).padStart(4, " ")}| `;
    const candidate = prefix + lines[index]!;
    const separator = output.length === 0 ? 0 : 1;
    const cost = separator + Buffer.byteLength(candidate, "utf8");
    if (used + cost > MAX_READ_BYTES) {
      const available = MAX_READ_BYTES - used - separator - Buffer.byteLength(prefix, "utf8");
      const piece = takeUtf8(lines[index]!, available);
      if (piece.length > 0) output.push(prefix + piece);
      truncated = true;
      break;
    }
    output.push(candidate);
    used += cost;
  }
  if (!truncated && index < lines.length) truncated = true;

  const body = output.join("\n");
  const text = truncated ? (body.length > 0 ? `${body}\n[truncated]` : "[truncated]") : body;
  return success(text, { path: toRelative(ctx.cwd, absolute), lines: output.length, truncated });
}

async function writeOp(input: FsInput, ctx: ToolCtx): Promise<ToolResult> {
  if (typeof input.content !== "string") {
    return failure("invalid_input", "write requires content");
  }
  const absolute = resolveInWorkdir(ctx.cwd, input.path);
  try {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, input.content, "utf8");
  } catch (error) {
    return failure("write_failed", `failed to write ${input.path}: ${errorMessage(error)}`);
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  const relative = toRelative(ctx.cwd, absolute);
  return success(`wrote ${bytes} bytes to ${relative}`, { path: relative, bytes });
}

async function editOp(input: FsInput, ctx: ToolCtx): Promise<ToolResult> {
  if (typeof input.oldText !== "string" || input.oldText.length === 0 || typeof input.newText !== "string") {
    return failure("invalid_input", "edit requires non-empty oldText and newText");
  }
  const absolute = resolveInWorkdir(ctx.cwd, input.path);
  const checked = await statRegularFile(absolute, input.path);
  if ("failure" in checked) return checked.failure;

  let content: string;
  try {
    content = await readFile(absolute, "utf8");
  } catch (error) {
    return failure("read_failed", `failed to read ${input.path}: ${errorMessage(error)}`);
  }

  const first = content.indexOf(input.oldText);
  if (first === -1) {
    return failure("edit_not_found", `oldText not found in ${input.path}`);
  }
  if (content.indexOf(input.oldText, first + input.oldText.length) !== -1) {
    return failure("edit_not_unique", `oldText matches multiple times in ${input.path}`);
  }

  const next = content.slice(0, first) + input.newText + content.slice(first + input.oldText.length);
  try {
    await writeFile(absolute, next, "utf8");
  } catch (error) {
    return failure("write_failed", `failed to write ${input.path}: ${errorMessage(error)}`);
  }
  const relative = toRelative(ctx.cwd, absolute);
  return success(`replaced 1 occurrence in ${relative}`, { path: relative, occurrences: 1 });
}

export const fsTool: ToolDef<FsInput> = {
  name: "fs",
  description: "在 workdir 内读取、写入或编辑文本文件",
  schema: fsInputSchema,
  annotations: { readOnly: false, destructive: true },
  execute: async (input, ctx) => {
    try {
      switch (input.op) {
        case "read":
          return await readOp(input, ctx);
        case "write":
          return await writeOp(input, ctx);
        case "edit":
          return await editOp(input, ctx);
      }
      return failure("invalid_input", `unknown op: ${String(input.op)}`);
    } catch (error) {
      if (error instanceof ToolPathError) return failure(error.code, error.message);
      return failure("internal_error", errorMessage(error));
    }
  },
};