import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { matchToolPattern } from "../permissions/rules.js";
import { signalProcessTree } from "../tools/process-tree.js";
import type { HookDef, HookEvent, HookOutcome, HookPayload, HookRunner } from "./types.js";

/**
 * 执行一条钩子：`spawn` + stdin 写入 + 超时 + 输出截断。
 *
 * 钩子是**用户可写的命令**，所以这里对它的 env 与输出都做了硬边界：
 *
 * - env 是硬编码最小集（`HOOK_ENV_ALLOWLIST`），不继承 `process.env`。
 *   模型的密钥（`providers.json` 的 `apiKey` / `apiKeyEnv` 指向的变量）绝不能被
 *   一条用户可写的命令读到——那等于把密钥交给了一个只看配置、不看代码的人。
 *   与 `src/mcp/manager.ts` 的 `buildEnv` 同一姿态，但那边可以配 `inheritEnv`，
 *   这里刻意不给这个开关。
 * - stdout / stderr 各截到 8000 字符：钩子输出会进工具正文（post）或错误信息
 *   （pre），不设上限等于让一条钩子把上下文撑爆。
 * - 超时用 `AbortSignal`，进程用 `signalProcessTree` 收（D-229 那一份，
 *   不另写杀进程逻辑）。
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_HOOK_OUTPUT_CHARS = 8_000;
const TRUNCATED_SUFFIX = "…[truncated]";

/**
 * 钩子进程能看到的环境变量。
 *
 * 与 `buildEnv` 的默认白名单同一姿态，但**没有** `inheritEnv` / `envAllowlist`：
 * 那份白名单是给 MCP server 的，server 是用户自己配的可执行程序，放宽是用户的
 * 决定；钩子的定位是「一条能看工具调用的命令」，它没有理由需要模型的密钥。
 *
 * `PATHEXT` / `SystemRoot` / `COMSPEC` 只在 Windows 上存在，取不到时自然缺席，
 * 不需要按平台分支。
 */
const HOOK_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "SystemRoot",
  "COMSPEC",
] as const;

/** 写进钩子 stdin 的完整文档：`tool` 由 `run()` 补上。 */
type HookStdin = HookPayload & { tool: string };

function buildHookEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOOK_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// 按 UTF-16 截断时避免切断代理对，否则 JSON/日志会留下孤立代理字符（D-034）。
function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = Math.max(0, Math.floor(maxChars));
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

interface OutputSink {
  push(chunk: Buffer): void;
  value(): string;
}

/**
 * 收集一路输出，超过上限就停止累积。
 *
 * 上限是**字符数**（与 `MAX_HOOK_OUTPUT_CHARS` 同一口径），但累积时按两倍上限
 * 就熔断：一条钩子可以无限往外写，不设边界等于让它决定我们要占多少内存。
 * 被截断时在文本末尾明说（R3：不许把不完整的说成完整的）。
 */
function makeSink(): OutputSink {
  // StringDecoder 而不是 `chunk.toString("utf8")`：多字节字符跨 chunk 边界时
  // 后者会产生替换字符，钩子写的中文会变成乱码。
  const decoder = new StringDecoder("utf8");
  let text = "";
  let overflowed = false;
  return {
    push(chunk) {
      if (overflowed) return;
      text += decoder.write(chunk);
      if (text.length >= MAX_HOOK_OUTPUT_CHARS) overflowed = true;
    },
    value() {
      if (!overflowed) text += decoder.end();
      if (text.length <= MAX_HOOK_OUTPUT_CHARS) return text;
      return `${truncateText(text, MAX_HOOK_OUTPUT_CHARS - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
    },
  };
}

function serializeStdin(stdin: HookStdin): string | undefined {
  try {
    return JSON.stringify(stdin);
  } catch {
    // 循环引用 / BigInt 等：这条钩子记失败，按「钩子没能求值」处理。
    return undefined;
  }
}

function hookLabel(hook: HookDef): string {
  // 序号 + 来源 + 文件外再带命令：用户要能一眼找到是哪一条。
  return `hook #${hook.index} (${hook.source}) ${hook.command}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RunOneOptions {
  hook: HookDef;
  stdin: HookStdin;
  signal: AbortSignal;
}

type OutcomeFields = {
  blocked: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  failure?: string;
};

function runOne(opts: RunOneOptions): Promise<HookOutcome> {
  const { hook, signal } = opts;
  const startedAt = Date.now();
  const finish = (fields: OutcomeFields): HookOutcome => {
    const outcome: HookOutcome = {
      event: hook.event,
      command: hook.command,
      source: hook.source,
      index: hook.index,
      blocked: fields.blocked,
      stdout: fields.stdout,
      stderr: fields.stderr,
      durationMs: Date.now() - startedAt,
    };
    if (fields.exitCode !== undefined) outcome.exitCode = fields.exitCode;
    if (fields.failure !== undefined) outcome.failure = fields.failure;
    return outcome;
  };

  const stdinText = serializeStdin(opts.stdin);
  if (stdinText === undefined) {
    return Promise.resolve(
      finish({
        blocked: false,
        stdout: "",
        stderr: "",
        failure: `${hookLabel(hook)}: payload is not serializable to JSON`,
      }),
    );
  }

  if (signal.aborted) {
    return Promise.resolve(
      finish({
        blocked: false,
        stdout: "",
        stderr: "",
        failure: `${hookLabel(hook)}: aborted before start`,
      }),
    );
  }

  const timeoutMs =
    hook.timeoutMs !== undefined && Number.isFinite(hook.timeoutMs) && hook.timeoutMs > 0
      ? hook.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  return new Promise<HookOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(hook.command, hook.args ?? [], {
        cwd: opts.stdin.cwd,
        env: buildHookEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // POSIX 上让子进程自成进程组：`signalProcessTree` 会先杀 `-pid`。
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve(
        finish({
          blocked: false,
          stdout: "",
          stderr: "",
          failure: `${hookLabel(hook)}: failed to spawn: ${errorMessage(error)}`,
        }),
      );
      return;
    }

    const stdout = makeSink();
    const stderr = makeSink();
    let settled = false;

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);

    const onStdout = (chunk: Buffer): void => stdout.push(chunk);
    const onStderr = (chunk: Buffer): void => stderr.push(chunk);

    const settle = (outcome: HookOutcome): void => {
      if (settled) return;
      settled = true;
      combined.removeEventListener("abort", onAbort);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      // 超时/中止时进程可能仍在跑：不 unref 的话，一个还在被 taskkill 收掉的
      // 进程能把宿主的事件循环多按住一会儿。它已经不再影响这条钩子的结论。
      unrefChild(child);
      resolve(outcome);
    };

    const onAbort = (): void => {
      // 先发回收再结算：结算之后调用方会立刻拿到 hook_failed 并继续跑，
      // 一个还在后台跑 60 s 的钩子会与后续调用重叠（D-022 同一原则）。
      // `signalProcessTree` 只表示「回收器已发出」，不等进程消失（D-229）。
      signalProcessTree(child.pid);
      const reason = timeoutSignal.aborted ? `timed out after ${timeoutMs}ms` : "aborted";
      settle(
        finish({
          blocked: false,
          stdout: stdout.value(),
          stderr: stderr.value(),
          failure: `${hookLabel(hook)}: ${reason}`,
        }),
      );
    };

    const onError = (error: Error): void => {
      settle(
        finish({
          blocked: false,
          stdout: stdout.value(),
          stderr: stderr.value(),
          failure: `${hookLabel(hook)}: failed to spawn: ${error.message}`,
        }),
      );
    };

    const onClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
      if (closeSignal !== null) {
        settle(
          finish({
            blocked: false,
            stdout: stdout.value(),
            stderr: stderr.value(),
            failure: `${hookLabel(hook)}: terminated by signal ${closeSignal}`,
          }),
        );
        return;
      }
      if (code === null) {
        settle(
          finish({
            blocked: false,
            stdout: stdout.value(),
            stderr: stderr.value(),
            failure: `${hookLabel(hook)}: exited without a code`,
          }),
        );
        return;
      }
      // 退出码语义：`preToolUse` 的 2 是**阻断**，也是唯一会被当成决定的退出码；
      // 其它非 0 是「钩子没跑成」。记录在这里，态度由 pipeline 决定——只有它
      // 知道 event 是 pre 还是 post、结果要不要改。
      const blocked = hook.event === "preToolUse" && code === 2;
      settle(
        finish({
          blocked,
          stdout: stdout.value(),
          stderr: stderr.value(),
          exitCode: code,
          ...(code !== 0 && !blocked
            ? { failure: `${hookLabel(hook)}: exited with code ${code}` }
            : {}),
        }),
      );
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    combined.addEventListener("abort", onAbort, { once: true });

    // stdin 写完就关：一个读不到 EOF 的钩子会一直等下去。
    const stdin = child.stdin;
    if (stdin !== null) {
      // 钩子可能不读 stdin 就退出（例如只看退出码的脚本），此时写入拿到 EPIPE。
      // 它不影响结论，但未处理的 'error' 会把宿主带走。
      stdin.on("error", () => undefined);
      stdin.end(stdinText, "utf8");
    }
  });
}

function unrefChild(child: ChildProcess): void {
  const candidate = child as ChildProcess & { unref?: () => void };
  if (typeof candidate.unref === "function") candidate.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    const value = stream as { unref?: () => void } | null | undefined;
    if (typeof value?.unref === "function") value.unref();
  }
}

/**
 * 由一组钩子定义造出 `HookRunner`。
 *
 * 只做「哪些钩子匹配 + 按配置顺序串行跑完」——决定权（阻断 / 追加 / 失败态度）
 * 在 `src/tools/pipeline.ts`：那是唯一知道工具结果长什么样的地方。
 */
export function createHookRunner(hooks: readonly HookDef[]): HookRunner {
  return {
    async run(
      event: HookEvent,
      tool: string,
      payload: HookPayload,
      signal: AbortSignal,
    ): Promise<HookOutcome[]> {
      const matched = hooks.filter(
        (hook) =>
          hook.event === event
          && (hook.matcher === undefined || matchToolPattern(hook.matcher, tool)),
      );
      const outcomes: HookOutcome[] = [];
      // 串行而非并行：同一次调用里的多条钩子按配置顺序一条一条跑，输出顺序可
      // 预测；并发还会让「第一条阻断」变成不确定的。
      for (const hook of matched) {
        outcomes.push(await runOne({ hook, stdin: { ...payload, tool }, signal }));
      }
      return outcomes;
    },
  };
}
