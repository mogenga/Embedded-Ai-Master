import { open, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveUnder, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

// 产物是「历史输出的全文」，读回它是为了补齐上下文里被截断的那段，不是重新取证：
// 一次读太多等于把落盘省下的 token 又塞回上下文。默认 16 KiB（盘上约 4k tokens），
// 单次上限 64 KiB（约 16k tokens，仍低于 pipeline 25k tokens 的出口上限）。
// 继续读用 detail.nextOffset —— 与 read 的 D-084 口径一致。
export const DEFAULT_ARTIFACT_LIMIT_BYTES = 16 * 1024;
export const MAX_ARTIFACT_LIMIT_BYTES = 64 * 1024;

export const artifactInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(MAX_ARTIFACT_LIMIT_BYTES).optional(),
});

export type ArtifactInput = z.infer<typeof artifactInputSchema>;

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

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

async function readWindow(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

async function artifactOp(
  input: ArtifactInput,
  ctx: ToolCtx,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (signal.aborted) return failure("aborted", "artifact aborted");

  // 根固定为 artifactDir：不回退到 cwd，也不放宽 read 的 workdir 边界。
  // 没配置或目录不存在时必须说清楚，否则模型会把「没有产物」误读成「文件被删了」。
  if (ctx.artifactDir === undefined || ctx.artifactDir.length === 0) {
    return failure("artifact_dir_missing", "no artifact directory is available for this session");
  }
  const root = path.resolve(ctx.artifactDir);
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failure("artifact_dir_missing", `artifact directory not found: ${ctx.artifactDir}`);
    }
    return failure("read_failed", `cannot inspect artifact directory: ${errorMessage(error)}`);
  }
  if (!rootInfo.isDirectory()) {
    return failure("artifact_dir_missing", `artifact directory is not a directory: ${ctx.artifactDir}`);
  }

  let absolute: string;
  try {
    absolute = resolveUnder(root, input.path);
  } catch (error) {
    if (error instanceof ToolPathError) return failure(error.code, error.message);
    return failure("internal_error", errorMessage(error));
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failure("not_found", `artifact not found: ${input.path}`);
    }
    return failure("read_failed", `failed to stat ${input.path}: ${errorMessage(error)}`);
  }
  if (!info.isFile()) {
    return failure("not_a_file", `not a regular file: ${input.path}`);
  }

  const size = info.size;
  const limit = input.limit ?? DEFAULT_ARTIFACT_LIMIT_BYTES;
  const requestedOffset = input.offset ?? 0;
  const relative = toPosix(path.relative(root, absolute));

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, "r");
  } catch (error) {
    return failure("read_failed", `failed to open ${input.path}: ${errorMessage(error)}`);
  }

  try {
    // offset 落在多字节字符中间时前移到下一个字符起点：否则解码会得到替换符，
    // 读回的「原文」就不再是原文。
    let start = Math.min(requestedOffset, size);
    if (start < size) {
      const probe = await readWindow(handle, start, Math.min(3, size - start));
      let index = 0;
      while (index < probe.length && isContinuation(probe[index]!)) {
        index += 1;
        start += 1;
      }
    }
    if (signal.aborted) return failure("aborted", "artifact aborted");

    // 多读 3 字节：判断 limit 边界是否正切在一个完整字符中间。
    const raw = start >= size ? Buffer.alloc(0) : await readWindow(
      handle,
      start,
      Math.min(limit + 3, size - start),
    );
    if (signal.aborted) return failure("aborted", "artifact aborted");
    let used = Math.min(limit, raw.length);
    if (used < raw.length && isContinuation(raw[used]!)) {
      // 边界切在多字节字符内部：回退到该字符的起始字节，不返回半个字符。
      while (used > 0 && isContinuation(raw[used]!)) used -= 1;
      if (used === 0) {
        // limit 小于一个字符的宽度：仍返回一个完整字符，否则 nextOffset 不前进，
        // 模型会在同一个 offset 上永远读不动。
        used = 1;
        while (used < raw.length && isContinuation(raw[used]!)) used += 1;
      }
    }

    const text = raw.subarray(0, used).toString("utf8");
    const nextOffset = Math.min(start + used, size);
    const truncated = nextOffset < size;
    const detail = {
      path: relative,
      offset: start,
      bytes: used,
      size,
      truncated,
      nextOffset,
    };
    if (used === 0) {
      return success("(no bytes at offset)", detail);
    }
    return success(truncated ? `${text}\n[truncated]` : text, detail);
  } catch (error) {
    if (signal.aborted) return failure("aborted", "artifact aborted");
    return failure("read_failed", `failed to read ${input.path}: ${errorMessage(error)}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export const artifactTool: ToolDef<ArtifactInput> = {
  name: "artifact",
  description:
    "读取本会话落盘的产物全文（超过 8k token 的工具输出会被改写成产物路径）。"
    + "path 相对 artifact 根，也可用落在根内的绝对路径；用 offset/limit 按字节分页，"
    + "截断时正文末尾标 [truncated]，detail.nextOffset 给出下一页起点",
  schema: artifactInputSchema,
  // evidence: false —— 这是取回历史输出，不是新的取证动作；标成证据会让压缩
  // 一直保护一段已经落盘的副本，把「读回」变成上下文负担。
  annotations: { readOnly: true, evidence: false },
  execute: (input, ctx, signal) => artifactOp(input, ctx, signal),
};
