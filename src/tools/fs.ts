import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

// 文件能力拆成四个独立工具,而不是继续用 `fs` + `op` 分派:
// 权限规则按工具名匹配,单工具分派会把「能不能写」藏进参数里,规则必须写
// params 才能区分读写;一旦漏写,读规则会顺带放行写。拆开后 write/edit/multiedit
// 各自可被 allow/ask/deny,读工具则完全落在只读注解上。

export const readInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(2000).optional(),
});

export type ReadInput = z.infer<typeof readInputSchema>;

export const writeInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteInput = z.infer<typeof writeInputSchema>;

export const editInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string(),
  newText: z.string(),
});

export type EditInput = z.infer<typeof editInputSchema>;

const editPairSchema = z.object({
  oldText: z.string(),
  newText: z.string(),
});

export const multieditInputSchema = z.object({
  path: z.string().min(1),
  // 上限 50:再多也不是「一处改动」,模型该直接用 write 重写整个文件。
  edits: z.array(editPairSchema).min(1).max(50),
});

export type MultieditInput = z.infer<typeof multieditInputSchema>;

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 256 * 1024;
// Windows 保留设备名:ASCII 与 Unicode 上标数字变体(COM¹/COM²/COM³ 等),
// 以及 CONIN$/CONOUT$ 控制台别名(D-073)。
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\..*)?$/i;

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

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
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

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function applyFileStyle(text: string, crlf: boolean): string {
  const normalized = normalizeNewlines(text);
  return crlf ? normalized.replace(/\n/g, "\r\n") : normalized;
}

function isCrlfContent(content: string): boolean {
  return content.includes("\r\n") && !content.replace(/\r\n/g, "").includes("\n");
}

function normalizeWithMap(content: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;
    if (char === "\r" && content[index + 1] === "\n") {
      map.push(index);
      text += "\n";
      index++;
      continue;
    }
    map.push(index);
    text += char;
  }
  map.push(content.length);
  return { text, map };
}

function normalizedDeviceName(input: string): string {
  let name = path.win32.basename(input).trim();
  const colon = name.indexOf(":");
  if (colon !== -1) name = name.slice(0, colon).trimEnd();
  while (name.endsWith(".") || name.endsWith(" ")) {
    name = name.slice(0, -1).trimEnd();
  }
  return name;
}

function reservedDeviceName(input: string): string | undefined {
  const name = normalizedDeviceName(input);
  return WINDOWS_RESERVED.test(name) ? name : undefined;
}

async function ensureRegularFile(absolute: string, inputPath: string): Promise<ToolResult | undefined> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failure("not_found", `file not found: ${inputPath}`);
    }
    return failure("read_failed", `failed to stat ${inputPath}: ${errorMessage(error)}`);
  }
  if (!info.isFile()) {
    return failure("not_a_file", `not a regular file: ${inputPath}`);
  }
  return undefined;
}

async function readOp(input: ReadInput, ctx: ToolCtx, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return failure("aborted", "read aborted");
  const absolute = resolveInWorkdir(ctx.cwd, input.path);
  const invalid = await ensureRegularFile(absolute, input.path);
  if (invalid) return invalid;
  if (signal.aborted) return failure("aborted", "read aborted");

  const start = input.offset ?? 0;
  const maxLines = input.limit ?? MAX_READ_LINES;
  const output: string[] = [];
  let used = 0;
  let linesSeen = 0;
  let truncated = false;
  const stream = createReadStream(absolute, { encoding: "utf8", signal });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (signal.aborted) return failure("aborted", "read aborted");
      linesSeen++;
      if (linesSeen <= start) continue;
      if (output.length >= maxLines) {
        truncated = true;
        break;
      }
      const prefix = `${String(linesSeen).padStart(4, " ")}| `;
      const candidate = prefix + line;
      const separator = output.length === 0 ? 0 : 1;
      const cost = separator + Buffer.byteLength(candidate, "utf8");
      if (used + cost > MAX_READ_BYTES) {
        const available = MAX_READ_BYTES - used - separator - Buffer.byteLength(prefix, "utf8");
        const piece = takeUtf8(line, available);
        if (piece.length > 0) output.push(prefix + piece);
        truncated = true;
        break;
      }
      output.push(candidate);
      used += cost;
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return failure("aborted", "read aborted");
    }
    return failure("read_failed", `failed to read ${input.path}: ${errorMessage(error)}`);
  } finally {
    reader.close();
    stream.destroy();
  }

  const relative = toRelative(ctx.cwd, absolute);
  if (output.length === 0) {
    return success("(no lines at offset)", {
      path: relative,
      lines: 0,
      truncated: false,
      nextOffset: start,
    });
  }
  const body = output.join("\n");
  const text = truncated ? (body.length > 0 ? `${body}\n[truncated]` : "[truncated]") : body;
  // 截断时披露下一次 offset,模型无需猜行号即可继续读取(D-084)。
  return success(text, {
    path: relative,
    lines: output.length,
    truncated,
    nextOffset: start + output.length,
  });
}

async function writeOp(input: WriteInput, ctx: ToolCtx, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return failure("aborted", "write aborted");
  if (typeof input.content !== "string") {
    return failure("invalid_input", "write requires content");
  }
  const reserved = reservedDeviceName(input.path);
  if (reserved) {
    return failure("reserved_name", `reserved Windows device name: ${reserved}`);
  }
  const absolute = resolveInWorkdir(ctx.cwd, input.path);
  try {
    await mkdir(path.dirname(absolute), { recursive: true });
    if (signal.aborted) return failure("aborted", "write aborted");
    await writeFile(absolute, input.content, { encoding: "utf8", signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return failure("aborted", "write aborted; file may be partial");
    }
    return failure("write_failed", `failed to write ${input.path}: ${errorMessage(error)}`);
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  const relative = toRelative(ctx.cwd, absolute);
  return success(`wrote ${bytes} bytes to ${relative}`, { path: relative, bytes });
}

interface EditPair {
  oldText: string;
  newText: string;
}

interface EditFailure {
  code: "edit_not_found" | "edit_not_unique";
  index: number;
}

type ApplyEditsResult =
  | { ok: true; text: string; occurrences: number }
  | { ok: false; failure: EditFailure };

// 在内存里顺序应用全部替换,全部成功才返回最终文本。
// 这是 multiedit 原子性的唯一来源:调用方只在 ok 时才写盘,
// 任何一步失败都直接返回,文件从未被打开写入,因此不需要回滚。
function applyEdits(content: string, pairs: readonly EditPair[]): ApplyEditsResult {
  const crlf = isCrlfContent(content);
  let current = content;
  let occurrences = 0;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]!;
    // 空 oldText 的 indexOf 恒为 0,会变成「在文件头插入」这种静默错误;
    // 按「没找到」处理,并把位置告诉调用方。
    if (pair.oldText.length === 0) {
      return { ok: false, failure: { code: "edit_not_found", index } };
    }
    // 每一步都对「当前累积文本」重新归一化取 map:替换会改变长度,
    // 沿用最初那一次 map 会把行号映射到错误的原始字节上。
    // 未触及的原文片段始终从 current 原样切片,所以 CRLF/混合换行不会被抹平。
    const mapped = crlf ? undefined : normalizeWithMap(current);
    const haystack = mapped ? mapped.text : current;
    const needle = applyFileStyle(pair.oldText, crlf);
    const first = haystack.indexOf(needle);
    if (first === -1) {
      return { ok: false, failure: { code: "edit_not_found", index } };
    }
    if (haystack.indexOf(needle, first + needle.length) !== -1) {
      return { ok: false, failure: { code: "edit_not_unique", index } };
    }
    const replacement = applyFileStyle(pair.newText, crlf);
    const start = mapped ? mapped.map[first]! : first;
    const end = mapped ? mapped.map[first + needle.length]! : first + needle.length;
    current = current.slice(0, start) + replacement + current.slice(end);
    occurrences += 1;
  }
  return { ok: true, text: current, occurrences };
}

async function editOp(input: EditInput, ctx: ToolCtx, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return failure("aborted", "edit aborted");
  if (typeof input.oldText !== "string" || input.oldText.length === 0 || typeof input.newText !== "string") {
    return failure("invalid_input", "edit requires non-empty oldText and newText");
  }
  const reserved = reservedDeviceName(input.path);
  if (reserved) {
    return failure("reserved_name", `reserved Windows device name: ${reserved}`);
  }
  const absolute = resolveInWorkdir(ctx.cwd, input.path);
  const invalid = await ensureRegularFile(absolute, input.path);
  if (invalid) return invalid;
  if (signal.aborted) return failure("aborted", "edit aborted");

  let content: string;
  try {
    content = await readFile(absolute, { encoding: "utf8", signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return failure("aborted", "edit aborted");
    }
    return failure("read_failed", `failed to read ${input.path}: ${errorMessage(error)}`);
  }

  const applied = applyEdits(content, [{ oldText: input.oldText, newText: input.newText }]);
  if (!applied.ok) {
    return applied.failure.code === "edit_not_found"
      ? failure("edit_not_found", `oldText not found in ${input.path}`)
      : failure("edit_not_unique", `oldText matches multiple times in ${input.path}`);
  }
  if (signal.aborted) return failure("aborted", "edit aborted");
  try {
    await writeFile(absolute, applied.text, { encoding: "utf8", signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return failure("aborted", "edit aborted; file may be partial");
    }
    return failure("write_failed", `failed to write ${input.path}: ${errorMessage(error)}`);
  }
  const relative = toRelative(ctx.cwd, absolute);
  return success(`replaced 1 occurrence in ${relative}`, { path: relative, occurrences: 1 });
}

async function multieditOp(
  input: MultieditInput,
  ctx: ToolCtx,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (signal.aborted) return failure("aborted", "multiedit aborted");
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return failure("invalid_input", "multiedit requires at least one edit");
  }
  const reserved = reservedDeviceName(input.path);
  if (reserved) {
    return failure("reserved_name", `reserved Windows device name: ${reserved}`);
  }
  const absolute = resolveInWorkdir(ctx.cwd, input.path);
  const invalid = await ensureRegularFile(absolute, input.path);
  if (invalid) return invalid;
  if (signal.aborted) return failure("aborted", "multiedit aborted");

  let content: string;
  try {
    content = await readFile(absolute, { encoding: "utf8", signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return failure("aborted", "multiedit aborted");
    }
    return failure("read_failed", `failed to read ${input.path}: ${errorMessage(error)}`);
  }

  const applied = applyEdits(content, input.edits);
  if (!applied.ok) {
    const { code, index } = applied.failure;
    const detail = { path: toRelative(ctx.cwd, absolute), index };
    const message =
      code === "edit_not_found"
        ? `edits[${index}].oldText not found in ${input.path}`
        : `edits[${index}].oldText matches multiple times in ${input.path}`;
    return failure(code, message, detail);
  }
  // 全部替换已在内存里成功;这里只写一次盘,失败也只影响这一次写。
  if (signal.aborted) return failure("aborted", "multiedit aborted");
  try {
    await writeFile(absolute, applied.text, { encoding: "utf8", signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return failure("aborted", "multiedit aborted; file may be partial");
    }
    return failure("write_failed", `failed to write ${input.path}: ${errorMessage(error)}`);
  }
  const relative = toRelative(ctx.cwd, absolute);
  const suffix = applied.occurrences === 1 ? "occurrence" : "occurrences";
  return success(`replaced ${applied.occurrences} ${suffix} in ${relative}`, {
    path: relative,
    occurrences: applied.occurrences,
  });
}

// 四个工具共用同一层外壳:执行前复查中断、把路径越界转成结构化错误码。
// 工具内抛出的异常一律折成 internal_error,不能让异常穿过管线(R3:失败要显式)。
async function executeOp<I>(
  label: string,
  op: (input: I, ctx: ToolCtx, signal: AbortSignal) => Promise<ToolResult>,
  input: I,
  ctx: ToolCtx,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (signal.aborted) return failure("aborted", `${label} aborted before execution`);
  try {
    return await op(input, ctx, signal);
  } catch (error) {
    if (error instanceof ToolPathError) return failure(error.code, error.message);
    return failure("internal_error", errorMessage(error));
  }
}

export const readTool: ToolDef<ReadInput> = {
  name: "read",
  description: "读取 workdir 内的文本文件,返回带行号的内容;可按 offset/limit 分页,超长自动截断",
  schema: readInputSchema,
  // 不提供 access:由 readOnly 注解推导出 "read",避免注解与 access 两处声明打架。
  annotations: { readOnly: true },
  execute: (input, ctx, signal) => executeOp("read", readOp, input, ctx, signal),
};

export const writeTool: ToolDef<WriteInput> = {
  name: "write",
  description: "在 workdir 内写入文本文件(覆盖已有内容),父目录不存在时自动创建",
  schema: writeInputSchema,
  annotations: { readOnly: false, destructive: true },
  // 写类工具没有只读模式,常量返回 write;这样 read-only/diagnose 预设才能按预设拒绝或询问。
  access: () => "write",
  execute: (input, ctx, signal) => executeOp("write", writeOp, input, ctx, signal),
};

export const editTool: ToolDef<EditInput> = {
  name: "edit",
  description: "把文件里唯一命中的 oldText 替换成 newText;命中零次或多次都报错且不改文件",
  schema: editInputSchema,
  annotations: { readOnly: false, destructive: true },
  access: () => "write",
  execute: (input, ctx, signal) => executeOp("edit", editOp, input, ctx, signal),
};

export const multieditTool: ToolDef<MultieditInput> = {
  name: "multiedit",
  description:
    "按顺序对同一文件应用多处替换;要么全部成功、要么一个字节都不改,失败时用 detail.index 指出第几处",
  schema: multieditInputSchema,
  annotations: { readOnly: false, destructive: true },
  access: () => "write",
  execute: (input, ctx, signal) => executeOp("multiedit", multieditOp, input, ctx, signal),
};
