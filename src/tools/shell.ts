import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { z } from "zod";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

export const shellInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
});

export type ShellInput = z.infer<typeof shellInputSchema>;

const MAX_STREAM_BYTES = 1024 * 1024;
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

function failure(code: string, message: string): ToolResult {
  return { isError: true, code, message, text: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string } | null;
  return candidate?.name === "AbortError" || candidate?.code === "ABORT_ERR";
}

function leafCommand(raw: string): string {
  const lower = raw.toLowerCase();
  const cut = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
  const base = cut === -1 ? lower : lower.slice(cut + 1);
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function commandOf(tokens: string[]): { name: string; args: string[] } {
  let index = 0;
  while (index < tokens.length && /^[a-z_][a-z0-9_]*=/i.test(tokens[index]!)) index++;
  while (index < tokens.length) {
    const head = tokens[index]!.toLowerCase();
    if (head !== "sudo" && head !== "command") break;
    index++;
    while (index < tokens.length && tokens[index]!.startsWith("-")) index++;
  }
  return { name: leafCommand(tokens[index] ?? ""), args: tokens.slice(index + 1) };
}

function unquote(value: string): string {
  return value.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

function isRootTarget(value: string): boolean {
  const target = unquote(value);
  return /^\/+\*?$/.test(target) || /^~\/?\*?$/.test(target);
}

function isRecursiveForceRm(args: string[]): boolean {
  let recursive = false;
  let force = false;
  const targets: string[] = [];
  for (const arg of args) {
    const value = arg.toLowerCase();
    if (value === "--") continue;
    if (value === "--recursive") {
      recursive = true;
      continue;
    }
    if (value === "--force") {
      force = true;
      continue;
    }
    if (value.startsWith("--")) continue;
    if (value.startsWith("-") && value.length > 1) {
      if (value.includes("r")) recursive = true;
      if (value.includes("f")) force = true;
      continue;
    }
    targets.push(value);
  }
  return recursive && force && targets.some(isRootTarget);
}

function isWindowsWipe(name: string, args: string[]): boolean {
  if (name !== "del" && name !== "erase" && name !== "rd" && name !== "rmdir") return false;
  const lower = args.map((arg) => unquote(arg.toLowerCase()));
  const recursive = lower.includes("/s");
  const rootTarget = lower.some((arg) => /^[a-z]:\\?\*?$/.test(arg));
  return recursive && rootTarget;
}

function isFormatDrive(name: string, args: string[]): boolean {
  if (name !== "format") return false;
  return args.some((arg) => /^[a-z]:(\/.*)?$/.test(unquote(arg.toLowerCase())));
}

function isDdToDevice(name: string, args: string[]): boolean {
  if (name !== "dd") return false;
  return args.some((arg) => /^of=\/dev\//.test(unquote(arg.toLowerCase())));
}

function isRegDeleteHklm(name: string, args: string[]): boolean {
  if (name !== "reg") return false;
  if ((args[0] ?? "").toLowerCase() !== "delete") return false;
  return args.slice(1).some((arg) => {
    const value = unquote(arg.toLowerCase());
    return value === "hklm" || value.startsWith("hklm\\") || value.startsWith("hkey_local_machine");
  });
}

function isCipherWipe(name: string, args: string[]): boolean {
  if (name !== "cipher") return false;
  return args.some((arg) => /^\/w(:|$)/.test(unquote(arg.toLowerCase())));
}

export function isDangerousCommand(command: string): boolean {
  if (FORK_BOMB.test(command)) return true;
  for (const segment of command.split(/[\n\r;|&()]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const { name, args } = commandOf(tokens);
    if (name === "mkfs" || name.startsWith("mkfs.")) return true;
    if (name === "diskpart" || name === "bcdedit") return true;
    if (name === "shutdown" || name === "reboot" || name === "poweroff" || name === "halt") return true;
    if (name === "rm" && isRecursiveForceRm(args)) return true;
    if (isWindowsWipe(name, args)) return true;
    if (isFormatDrive(name, args)) return true;
    if (isDdToDevice(name, args)) return true;
    if (isRegDeleteHklm(name, args)) return true;
    if (isCipherWipe(name, args)) return true;
  }
  return false;
}

function resolveCwd(ctx: ToolCtx, input: string): string | ToolResult {
  let absolute: string;
  try {
    absolute = resolveInWorkdir(ctx.cwd, input);
  } catch (error) {
    if (error instanceof ToolPathError) return failure("cwd_invalid", `invalid cwd: ${error.message}`);
    return failure("cwd_invalid", `invalid cwd: ${errorMessage(error)}`);
  }
  let info;
  try {
    info = statSync(absolute);
  } catch (error) {
    return failure("cwd_invalid", `cannot inspect cwd ${input}: ${errorMessage(error)}`);
  }
  if (!info.isDirectory()) return failure("cwd_invalid", `cwd is not a directory: ${input}`);
  return absolute;
}

interface Collector {
  push(chunk: Buffer): void;
  value(): { text: string; truncated: boolean };
}

function decode(buffer: Buffer, truncated: boolean): string {
  if (!truncated) return buffer.toString("utf8");
  let end = buffer.length;
  while (end > 0) {
    const byte = buffer[end - 1]!;
    if ((byte & 0x80) === 0) break;
    if ((byte & 0xc0) === 0xc0) {
      const size = (byte & 0xf8) === 0xf0 ? 4 : (byte & 0xf0) === 0xe0 ? 3 : 2;
      if (buffer.length - (end - 1) < size) end--;
      break;
    }
    end--;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function createCollector(): Collector {
  const parts: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      const remaining = MAX_STREAM_BYTES - bytes;
      if (remaining <= 0) {
        if (chunk.length > 0) truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        parts.push(chunk.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        return;
      }
      parts.push(chunk);
      bytes += chunk.length;
    },
    value() {
      return { text: decode(Buffer.concat(parts), truncated), truncated };
    },
  };
}

function runCommand(command: string, cwd: string, signal: AbortSignal): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const stdout = createCollector();
    const stderr = createCollector();
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let child;
    try {
      child = spawn(command, { shell: true, cwd, env: process.env, signal });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        finish(failure("shell_aborted", `command aborted: ${errorMessage(error)}`));
        return;
      }
      finish(failure("shell_spawn_failed", `failed to spawn command: ${errorMessage(error)}`));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error) => {
      if (signal.aborted || isAbortError(error)) {
        finish(failure("shell_aborted", `command aborted: ${errorMessage(error)}`));
        return;
      }
      finish(failure("shell_spawn_failed", `failed to spawn command: ${errorMessage(error)}`));
    });

    child.on("close", (code) => {
      if (signal.aborted) {
        finish(failure("shell_aborted", "command aborted"));
        return;
      }
      const out = stdout.value();
      const err = stderr.value();
      const exitCode = code ?? 1;
      const sections = [`exit=${exitCode}`];
      const outText = out.text.replace(/\r?\n$/, "");
      const errText = err.text.replace(/\r?\n$/, "");
      if (outText.length > 0) sections.push(outText);
      if (errText.length > 0) sections.push(`[stderr]\n${errText}`);
      if (out.truncated) sections.push("[stdout truncated at 1 MiB]");
      if (err.truncated) sections.push("[stderr truncated at 1 MiB]");
      finish({
        isError: false,
        code: "ok",
        message: "",
        detail: {
          exitCode,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
        },
        text: sections.join("\n"),
      });
    });
  });
}

export const shellTool: ToolDef<ShellInput> = {
  name: "shell",
  description: "在 workdir 内执行 shell 命令(非沙箱,仅拦截已知高危命令)",
  schema: shellInputSchema,
  annotations: { readOnly: false, destructive: true },
  execute: async (input, ctx, signal) => {
    if (isDangerousCommand(input.command)) {
      return failure("dangerous_command", `dangerous command blocked: ${input.command}`);
    }
    const cwd = resolveCwd(ctx, input.cwd ?? ".");
    if (typeof cwd !== "string") return cwd;
    return runCommand(input.command, cwd, signal);
  },
};