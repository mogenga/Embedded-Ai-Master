import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import { isProcessAlive, signalProcessTree } from "./process-tree.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

export const shellInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
});

export type ShellInput = z.infer<typeof shellInputSchema>;

const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_COMMAND_PREVIEW = 200;
const DETAIL_TEXT_CHARS = 4096;
const ABORT_ESCALATE_MS = 1_000;
const ABORT_FALLBACK_MS = 3_000;
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
const SUDO_VALUE_OPTIONS = new Set([
  "-u",
  "--user",
  "-g",
  "--group",
  "-p",
  "--prompt",
  "-c",
  "--close-from",
  "-d",
  "--chdir",
  "-h",
  "--host",
  "-r",
  "--role",
  "-t",
  "--type",
  "--other-user",
]);

function failure(code: string, message: string): ToolResult {
  return { isError: true, code, message, text: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewCommand(command: string): string {
  return command.length <= MAX_COMMAND_PREVIEW ? command : `${command.slice(0, MAX_COMMAND_PREVIEW)}...`;
}

/**
 * 终止这棵进程树（D-229）。
 *
 * 实现搬到了 `process-tree.ts`，与 `background.ts` 共用一份——这条路径上
 * 「前台 / 后台」的差异只有「要不要等结果」，复制两份会让它们各自演化。
 *
 * **不阻塞**：Windows 上 `taskkill /T /F` 的启动成本固定约 1 s（实测 10 次，
 * 对不存在的 pid 也一样），同步等它会把 25 ms 的超时轮询与 abort 兜底定时器
 * 一起冻住。返回值只表示**回收器已发出**，终局由子进程的 `exit` 事件或
 * `ABORT_FALLBACK_MS` 兜底给出。
 */
function terminateTree(pid: number): boolean {
  return signalProcessTree(pid);
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
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      const option = tokens[index]!.toLowerCase();
      const separator = option.indexOf("=");
      if (separator === -1 && SUDO_VALUE_OPTIONS.has(option)) {
        index += 2;
      } else {
        index += 1;
      }
    }
  }
  return { name: leafCommand(tokens[index] ?? ""), args: tokens.slice(index + 1) };
}

function unquote(value: string): string {
  return value.replace(/['"]/g, "").trim();
}

function normalizeTarget(value: string): string | undefined {
  const target = unquote(value).trim();
  if (target.length === 0) return undefined;
  const posix = target.replace(/\\/g, "/");
  const home = /^(~|\$HOME|\$\{HOME\})(?:\/|$)/i.exec(posix);
  if (home) {
    const prefix = home[1]!;
    const rest = posix.slice(home[0].length).replace(/^\/+/, "");
    if (rest.length === 0) return prefix;
    const normalized = path.posix.normalize(`/${rest}`);
    return normalized === "/" ? prefix : `${prefix}${normalized}`;
  }
  const drive = /^[a-z]:/i.exec(posix);
  if (drive) {
    const rest = posix.slice(2);
    const normalized = path.posix.normalize(rest.length === 0 ? "/" : rest);
    if (normalized === "/" || /^\/\*+(?:\.\*+)?$/.test(normalized)) return "/";
    return normalized;
  }
  const normalized = path.posix.normalize(posix);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function isRootTarget(value: string): boolean {
  const target = normalizeTarget(value);
  if (target === undefined) return false;
  if (target === "/" || target === "~") return true;
  if (/^\/\*+(?:\.\*+)?$/.test(target)) return true;
  if (/^~\/\*+(?:\.\*+)?$/.test(target)) return true;
  if (/^\$(?:HOME|\{HOME\})(?:\/\*+(?:\.\*+)?)?$/i.test(target)) return true;
  const segments = target.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return false;
  if (segments.every((segment) => segment === "..")) return true;
  const last = segments[segments.length - 1]!;
  return (
    segments.length > 1
    && segments.slice(0, -1).every((segment) => segment === "..")
    && /^\*+(?:\.\*+)?$/.test(last)
  );
}

function isWildcardTarget(value: string): boolean {
  const target = normalizeTarget(value);
  return target !== undefined && /^\*+(?:\.\*+)?$/.test(target);
}

function isCurrentTarget(value: string): boolean {
  return normalizeTarget(value) === ".";
}

function isRecursiveForceRm(args: string[], atRoot: boolean): boolean {
  let recursive = false;
  let force = false;
  let preserveRoot = false;
  const targets: string[] = [];
  for (const arg of args) {
    const value = arg.toLowerCase();
    if (value === "--") continue;
    if (value.startsWith("--recursive")) {
      recursive = true;
      continue;
    }
    if (value.startsWith("--force")) {
      force = true;
      continue;
    }
    if (value === "--no-preserve-root") {
      preserveRoot = true;
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
  if (preserveRoot) return true;
  return (
    (recursive || force)
    && targets.some(
      (target) =>
        isRootTarget(target)
        || (atRoot && (isWildcardTarget(target) || isCurrentTarget(target))),
    )
  );
}

function isWindowsWipe(name: string, args: string[], atRoot: boolean): boolean {
  if (name !== "del" && name !== "erase" && name !== "rd" && name !== "rmdir") return false;
  const lower = args.map((arg) => unquote(arg.toLowerCase()));
  const recursive = lower.includes("/s");
  const rootTarget = lower.some(isRootTarget);
  // del/rd 的 "." 目标在任意位置都按「当前位置」处理；atRoot 时它就是根，
  // 非 atRoot 时按 no-op（isRootTarget(".") 为 false）。
  const currentTarget = atRoot && lower.some(isCurrentTarget);
  const wildcardTarget = atRoot && lower.some(isWildcardTarget);
  return recursive && (rootTarget || currentTarget || wildcardTarget);
}

function isFormatDrive(name: string, args: string[]): boolean {
  if (name !== "format") return false;
  return args.some((arg) => /^[a-z]:([\\/].*)?$/.test(unquote(arg.toLowerCase())));
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

const CD_COMMANDS = new Set(["cd", "pushd", "chdir", "set-location"]);

function cdTarget(args: string[]): string | undefined {
  for (const arg of args) {
    const value = unquote(arg);
    if (value === "--") continue;
    if (/^-{1,2}[a-z][\w-]*$/i.test(value)) continue;
    return value;
  }
  return undefined;
}

// 拦截器输入是「会在 shell:true 下原样交给出层 shell 的字符串」，所以：
// - 初始 atRoot 按 spawn 的真实 cwd（workdir 根）判定，而不是等 cd 段；
// - atRoot 粘性：cd 到根之后再 cd . / cd 子目录不会把位置洗回安全区；
// - 包装层（env/nohup/sudo/command/cmd /c、bash -c …）递归剥开，对内层串重新评估。
export function isDangerousCommand(command: string): boolean {
  return evaluateDanger(command, true, new Set());
}

const WRAPPER_HEADS = new Set(["env", "nohup", "stdbuf", "timeout", "nice", "setsid", "xargs"]);
const WRAPPER_SHELL_HEADS = new Set(["cmd", "bash", "sh", "zsh", "ksh", "powershell", "pwsh"]);
const SHELL_INNER_OPTION = new Set(["-c", "/c", "-command", "/command", "--command"]);

function unwrapSegments(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).map(unquote).filter(Boolean);
  if (tokens.length === 0) return [segment];
  const head = leafCommand(tokens[0]!);
  if (head === "cmd") {
    // cmd /c <rest>：/c 之后 cmd 会把余部当作一条命令原样执行
    const index = tokens.findIndex((token) => token.toLowerCase() === "/c");
    if (index !== -1 && index + 1 < tokens.length) {
      return [tokens.slice(index + 1).join(" ")];
    }
    return [segment];
  }
  if (WRAPPER_SHELL_HEADS.has(head)) {
    const index = tokens.findIndex((token) => SHELL_INNER_OPTION.has(token.toLowerCase()));
    if (index !== -1 && index + 1 < tokens.length) {
      const rest = tokens
        .slice(index + 1)
        .join(" ")
        .replace(/^[&|(]+/, "")
        .replace(/[&|)"']+$/, "");
      return [rest];
    }
    // powershell.exe 无 -Command 时仍把余部当命令行执行
    if ((head === "powershell" || head === "pwsh") && tokens.length > 1) {
      return [tokens.slice(1).join(" ")];
    }
    return [segment];
  }
  if (WRAPPER_HEADS.has(head)) {
    // env/nohup/timeout/nice/xargs 等：跳过自身、其选项与数值参数（timeout 10 / nice 19），余下仍是一条命令
    let index = 1;
    while (index < tokens.length && (tokens[index]!.startsWith("-") || /^\d+$/.test(tokens[index]!))) index++;
    if (index < tokens.length) {
      return [tokens.slice(index).join(" ")];
    }
  }
  return [segment];
}

function evaluateDanger(command: string, atRoot: boolean, seen: Set<string>): boolean {
  if (seen.has(command)) return false;
  seen.add(command);
  if (FORK_BOMB.test(command)) return true;
  // 反引号 / $( ) 命令替换先于外层执行：把内部串变成独立命令段重新评估
  if (command.includes("`") || command.includes("$(")) {
    const inner = command
      .replace(/`([^`]*)`/g, "; $1 ;")
      .replace(/\$\(([^()]*)\)/g, "; $1 ;");
    if (inner !== command && evaluateDanger(inner, atRoot, seen)) return true;
  }
  let rootSticky = atRoot;
  let varRoot: string | undefined;
  for (const raw of command.split(/[\n\r;|&]+/)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // X=/; rm -rf $X：值为主题的裸变量赋值出现后，后续 $VAR 引用按根处理
    const assignment = /^([a-z_][a-z0-9_]*)=(.*)$/i.exec(trimmed);
    if (assignment && isRootTarget(unquote(assignment[2]!))) {
      varRoot = assignment[1]!;
    }
    for (const segment of unwrapSegments(trimmed)) {
      if (evaluateDanger(segment, rootSticky, seen)) return true;
      let segmentText = segment;
      if (varRoot !== undefined) {
        const expanded = segment.replace(new RegExp(`\\\$\\{?${varRoot}\\}?`, "gi"), "/");
        if (expanded !== segment && evaluateDanger(expanded, rootSticky, seen)) return true;
        segmentText = expanded;
      }
      const tokens = segmentText.trim().split(/\s+/).map(unquote).filter(Boolean);
      if (tokens.length === 0) continue;
      const { name, args } = commandOf(tokens);
      if (CD_COMMANDS.has(name)) {
        const target = cdTarget(args);
        if (target === undefined) {
          rootSticky = true;
        } else {
          // cd . 与 cd .. 不离开当前位置（根的父仍是根），保持原状；
          // cd 到根（含 Windows 盘根 /c、C:\）置位；cd 到真实子目录解除。
          // 防止 cd . 把根位置洗回安全区（cd / && cd . && rm -rf *）。
          const normalized = normalizeTarget(target);
          if (normalized === ".." || /^\/[a-z]$/i.test(target)) {
            rootSticky = rootSticky || isRootTarget(target);
          } else if (isRootTarget(target)) {
            rootSticky = true;
          } else if (normalized !== ".") {
            rootSticky = false;
          }
        }
        continue;
      }
      if (name === "rm" && isRecursiveForceRm(args, rootSticky)) return true;
      if (isWindowsWipe(name, args, rootSticky)) return true;
      if (isFormatDrive(name, args)) return true;
      if (isDdToDevice(name, args)) return true;
      if (isRegDeleteHklm(name, args)) return true;
      if (isCipherWipe(name, args)) return true;
      if (isPowerShellWipe(name, args)) return true;
      if (name === "mkfs" || name.startsWith("mkfs.")) return true;
      if (name === "diskpart" || name === "bcdedit") return true;
      if (name === "shutdown" || name === "reboot" || name === "poweroff" || name === "halt") {
        return true;
      }
    }
  }
  return false;
}

function isPowerShellWipe(name: string, args: string[]): boolean {
  if (name !== "remove-item" && name !== "ri") return false;
  const lower = args.map((arg) => unquote(arg.toLowerCase()));
  const recursive = lower.some((arg) => /^-rec/.test(arg) || arg === "-r");
  const force = lower.some((arg) => arg === "-force" || arg === "-f");
  if (!recursive && !force) return false;
  return lower.some((arg) => isRootTarget(arg));
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

interface Collected {
  text: string;
  truncated: boolean;
  bytes: number;
}

interface Collector {
  push(chunk: Buffer): void;
  value(): Collected;
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
      return { text: decode(Buffer.concat(parts), truncated), truncated, bytes };
    },
  };
}

function composeText(
  headers: string[],
  out: { text: string; truncated: boolean },
  err: { text: string; truncated: boolean },
): string {
  const sections = [...headers];
  const outText = out.text.replace(/\r?\n$/, "");
  const errText = err.text.replace(/\r?\n$/, "");
  if (outText.length > 0) sections.push(outText);
  if (errText.length > 0) sections.push(`[stderr]\n${errText}`);
  if (out.truncated) sections.push("[stdout truncated at 1 MiB]");
  if (err.truncated) sections.push("[stderr truncated at 1 MiB]");
  return sections.join("\n");
}

function summarize(text: string): string {
  if (text.length <= DETAIL_TEXT_CHARS) return text;
  const last = text.charCodeAt(DETAIL_TEXT_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? DETAIL_TEXT_CHARS - 1 : DETAIL_TEXT_CHARS;
  return text.slice(0, end);
}

function streamDetail(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  out: Collected,
  err: Collected,
): Record<string, unknown> {
  return {
    exitCode,
    signal,
    stdout: summarize(out.text),
    stderr: summarize(err.text),
    stdoutBytes: out.bytes,
    stderrBytes: err.bytes,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
  };
}

function runCommand(command: string, cwd: string, signal: AbortSignal): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    if (signal.aborted) {
      resolvePromise(failure("shell_aborted", "command aborted"));
      return;
    }
    let settled = false;
    const stdout = createCollector();
    const stderr = createCollector();
    let child: ReturnType<typeof spawn> | undefined;
    let escalateTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const clearAbortTimers = (): void => {
      if (escalateTimer !== undefined) clearTimeout(escalateTimer);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      escalateTimer = undefined;
      fallbackTimer = undefined;
    };
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearAbortTimers();
      signal.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const onAbort = (): void => {
      const pid = child?.pid;
      // `terminateFailed` 的含义是「**没能**把回收器发出去」——不是「进程一定
      // 还在」。D-229 之前这里用 `spawnSync` 的退出码当判据，那需要等约 1 s；
      // 现在按「有没有可操作的 pid」判，进程是否真的消失交给下面的兜底：
      // 兜底触发时若进程还活着，文案里的「not confirmed」就兑现了。
      let terminateFailed = pid === undefined;
      if (pid !== undefined) {
        terminateFailed = !terminateTree(pid);
      }
      escalateTimer = setTimeout(() => {
        if (settled || pid === undefined) return;
        // 已经是 `/T /F`（最强），再发一次对同样的目标做同样的事；仅在
        // **它已经消失**时记下「这次没打出去」——那正是 terminateFailed 的语义。
        if (!isProcessAlive(pid)) return;
        terminateFailed = !terminateTree(pid);
      }, ABORT_ESCALATE_MS);
      fallbackTimer = setTimeout(() => {
        if (settled) return;
        // 兜底到点时进程仍在 = 终止未被确认，如实标出来（R3）。
        if (pid !== undefined && isProcessAlive(pid)) terminateFailed = true;
        const message = "command aborted; process termination not confirmed";
        finish({
          isError: true,
          code: "shell_aborted",
          message,
          detail: { abortEscalated: true, terminateFailed },
          text: message,
        });
      }, ABORT_FALLBACK_MS);
    };

    try {
      child = spawn(command, {
        shell: true,
        cwd,
        env: process.env,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        finish(failure("shell_aborted", `command aborted: ${errorMessage(error)}`));
        return;
      }
      finish(failure("shell_spawn_failed", `failed to spawn command: ${errorMessage(error)}`));
      return;
    }

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error) => {
      if (signal.aborted || isAbortError(error)) {
        finish(failure("shell_aborted", `command aborted: ${errorMessage(error)}`));
        return;
      }
      finish(failure("shell_spawn_failed", `failed to spawn command: ${errorMessage(error)}`));
    });

    child.on("close", (code, exitSignal) => {
      if (signal.aborted) {
        finish(failure("shell_aborted", "command aborted"));
        return;
      }
      const out = stdout.value();
      const err = stderr.value();
      if (exitSignal !== null) {
        finish({
          isError: true,
          code: "shell_terminated",
          message: `command terminated by signal ${exitSignal}`,
          detail: streamDetail(code, exitSignal, out, err),
          text: composeText([`signal=${exitSignal}`, `exit=${code === null ? "null" : code}`], out, err),
        });
        return;
      }
      const exitCode = code ?? 1;
      finish({
        isError: false,
        code: "ok",
        message: "",
        detail: streamDetail(exitCode, null, out, err),
        text: composeText([`exit=${exitCode}`], out, err),
      });
    });
  });
}

export const shellTool: ToolDef<ShellInput> = {
  name: "shell",
  description: "在 workdir 内执行 shell 命令(非沙箱,仅拦截已知高危命令)",
  schema: shellInputSchema,
  annotations: { readOnly: false, destructive: true },
  access: () => "write",
  execute: async (input, ctx, signal) => {
    if (isDangerousCommand(input.command)) {
      return failure("dangerous_command", `dangerous command blocked: ${previewCommand(input.command)}`);
    }
    const cwd = resolveCwd(ctx, input.cwd ?? ".");
    if (typeof cwd !== "string") return cwd;
    return runCommand(input.command, cwd, signal);
  },
};