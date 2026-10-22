import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { z } from "zod";
import type {
  BackgroundJobStatus,
  BackgroundKilledBy,
  BackgroundResultPayload,
} from "../session/types.js";
import { resolveInWorkdir, ToolPathError } from "./path-safety.js";
import { isDangerousCommand } from "./shell.js";
import type { ToolCtx, ToolDef, ToolResult } from "./types.js";

// 后台作业的输出上限刻意比前台 `shell` 的 1 MiB 小一个数量级。
//
// 前台输出是「这一轮现在就要的答案」,留 1 MiB 合理;后台输出是「十分钟后
// 我回来瞄一眼」的东西,留 64 KiB 的尾部足够判断它成没成、最后几行喊了什么,
// 而十个 64 KiB 的作业仍在内存里可控。真正需要全文的场合,命令本身应该把自己
// 的日志重定向到文件——工具不替它保管一份没人会读的完整转录。
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_COMMAND_PREVIEW = 200;
const MAX_CHECK_TEXT_CHARS = 4096;
const MAX_LISTED_JOBS = 20;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const ABORT_ESCALATE_MS = 1_000;
const ABORT_FALLBACK_MS = 3_000;
const JOB_ID_PATTERN = /^bg_[0-9a-f]{12}$/;

export const terminalBgInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  /**
   * 作业自身的寿命上限（毫秒），**不是**这次工具调用的超时。
   *
   * 工具调用本身立即返回；这个数字到点后终止整棵进程树，结果记为
   * `timed_out`。缺省 10 分钟——「后台」不是「永久」。
   */
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

export type TerminalBgInput = z.infer<typeof terminalBgInputSchema>;

export const terminalBgCheckInputSchema = z.object({
  id: z.string().min(1).optional(),
  /**
   * 终止该作业的整棵进程树。
   *
   * 它是写操作：只有带 `kill: true` 时这个工具才需要写权限，纯粹查询状态的
   * 调用不应该被 `read-only` / `diagnose` 预设拦下。
   */
  kill: z.boolean().optional(),
});

export type TerminalBgCheckInput = z.infer<typeof terminalBgCheckInputSchema>;

type JobState = "running" | BackgroundJobStatus;

interface BackgroundJob {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: string;
  startedAtMs: number;
  /** 已累计的真实输出字节数（不只是保留下来的那些）。 */
  stdoutBytes: number;
  stderrBytes: number;
  /** 保留的尾部字节，超过上限后从头部丢弃。 */
  tail: Buffer;
  /** 已经丢弃的字节数；> 0 即发生过截断。 */
  droppedBytes: number;
  state: JobState;
  exitCode: number | null;
  signal: string | null;
  killedBy: BackgroundKilledBy | null;
  finishedAt?: string;
  durationMs?: number;
  timeoutMs: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  escalateTimer?: ReturnType<typeof setTimeout>;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  /** 进程已回收且终局已定，不必再 terminate。 */
  settled: boolean;
  /** 已有 `check` 或完成队列把终局说出去过；之后不再重复回报。 */
  reported: boolean;
}

// 进程级注册表:作业不属于任何一次工具调用,而属于宿主进程。宿主退出时
// `killAllBackgroundJobs()` 把它们一起带走,否则一个 detached 构建会活过 App。
const jobs = new Map<string, BackgroundJob>();
// 按会话分组的完成队列,等宿主取走写成 `background_result` 事件。
const completions = new Map<string, BackgroundResultPayload[]>();

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
 * 与 `shell` 的 `terminateTree` 语义相同:POSIX 先杀进程组、再单杀 pid;
 * Windows 用 `taskkill /T /F`。
 *
 * 这里复制而不是从 `shell.ts` 导入,是因为 `shell.ts` 里那份是模块私有的、
 * 只为前台的一次调用服务;后台还需要它处理「作业结束后进程树还在跑」的情况。
 * 两处必须保持一致,改动时一起改。
 */
function terminateTree(pid: number, force = false): boolean {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function resolveCwd(ctx: ToolCtx, input: string): string | ToolResult {
  let absolute: string;
  try {
    absolute = resolveInWorkdir(ctx.cwd, input);
  } catch (error) {
    if (error instanceof ToolPathError) return failure("cwd_invalid", `invalid cwd: ${error.message}`);
    return failure("cwd_invalid", `invalid cwd: ${errorMessage(error)}`);
  }
  try {
    if (!statSync(absolute).isDirectory()) {
      return failure("cwd_invalid", `cwd is not a directory: ${input}`);
    }
  } catch (error) {
    return failure("cwd_invalid", `cannot inspect cwd ${input}: ${errorMessage(error)}`);
  }
  return absolute;
}

/**
 * 保留尾部:超过上限时丢弃最旧的部分。
 *
 * 前台 `shell` 保留的是**头部**(它要回答「命令说了什么」),后台保留的是
 * **尾部**——十分钟构建的最后几行才是成败所在。两者都必须在正文里说明自己
 * 截断过,否则一段残缺输出会被当成完整输出读(R3)。
 */
function appendCapped(job: BackgroundJob, chunk: Buffer): void {
  if (chunk.length === 0) return;
  job.tail = Buffer.concat([job.tail, chunk]);
  if (job.tail.length > MAX_CAPTURE_BYTES) {
    const excess = job.tail.length - MAX_CAPTURE_BYTES;
    job.droppedBytes += excess;
    job.tail = job.tail.subarray(excess);
  }
}

/**
 * 解码保留的尾部。
 *
 * 从头部丢字节可能切断多字节字符:跳过开头 1–3 个续字节再解码,免得
 * 正文以一个 U+FFFD 开头、让人以为是命令自己打印了乱码。
 */
function decodeTail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && start < 3 && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

function bytesOf(job: BackgroundJob): number {
  return job.stdoutBytes + job.stderrBytes;
}

function clearTimers(job: BackgroundJob): void {
  if (job.timeoutTimer !== undefined) clearTimeout(job.timeoutTimer);
  if (job.escalateTimer !== undefined) clearTimeout(job.escalateTimer);
  if (job.fallbackTimer !== undefined) clearTimeout(job.fallbackTimer);
  job.timeoutTimer = undefined;
  job.escalateTimer = undefined;
  job.fallbackTimer = undefined;
}

function finishJob(
  job: BackgroundJob,
  state: BackgroundJobStatus,
  exitCode: number | null,
  signal: string | null,
  killedBy: BackgroundKilledBy | null,
): void {
  if (job.state !== "running" || job.settled) return;
  job.state = state;
  job.exitCode = exitCode;
  job.signal = signal;
  job.killedBy = killedBy;
  job.finishedAt = new Date().toISOString();
  job.durationMs = Date.now() - job.startedAtMs;
  job.settled = true;
  clearTimers(job);
}

function completionPayload(job: BackgroundJob): BackgroundResultPayload {
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    status: job.state === "running" ? "exited" : job.state,
    exitCode: job.exitCode,
    signal: job.signal,
    killedBy: job.killedBy,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? new Date().toISOString(),
    durationMs: job.durationMs ?? Date.now() - job.startedAtMs,
    stdoutBytes: job.stdoutBytes,
    stderrBytes: job.stderrBytes,
    bytes: bytesOf(job),
    capturedBytes: job.tail.length,
    truncated: job.droppedBytes > 0,
    text: decodeTail(job.tail),
  };
}

function enqueueCompletion(job: BackgroundJob): void {
  if (job.reported) return;
  job.reported = true;
  const queue = completions.get(job.sessionId);
  const payload = completionPayload(job);
  if (queue === undefined) completions.set(job.sessionId, [payload]);
  else queue.push(payload);
}

/**
 * 取出并清空某个会话的完成通知。
 *
 * 这是宿主写 `background_result` 事件的唯一入口:写成事件之后,重开这个会话
 * 仍能从日志里看到「那条后台命令最后怎么了」。取出即消费,同一个终局不会
 * 被写两遍。
 */
export function takeBackgroundCompletions(sessionId: string): BackgroundResultPayload[] {
  const queue = completions.get(sessionId);
  if (queue === undefined || queue.length === 0) return [];
  completions.delete(sessionId);
  return queue;
}

/**
 * 把一个作业的待发通知从队列里摘掉。
 *
 * `check` 已经把终局写进自己的正文时调用:否则用户会先看到 check 的完整
 * 报告、随后又收到同一条完成通知。谁先说谁负责,另一个不再说。
 */
function suppressCompletion(sessionId: string, id: string): void {
  const queue = completions.get(sessionId);
  if (queue === undefined) return;
  const remaining = queue.filter((entry) => entry.id !== id);
  if (remaining.length === 0) completions.delete(sessionId);
  else completions.set(sessionId, remaining);
}

/**
 * 请求终止一个作业。
 *
 * 只发出终止信号并把「谁要它死」记在作业上——**不**在这里宣布终局:进程
 * 还没回收,此刻说「已结束」就是伪造。终局由随后的 `close`（或兜底定时器）
 * 给出。
 */
function stopJob(job: BackgroundJob, killedBy: BackgroundKilledBy): void {
  if (job.state !== "running" || job.settled || job.killedBy !== null) return;
  job.killedBy = killedBy;
  terminateTree(job.pid);
  job.escalateTimer = setTimeout(() => {
    if (job.settled) return;
    terminateTree(job.pid, true);
  }, ABORT_ESCALATE_MS);
  job.escalateTimer.unref?.();
  // 兜底:进程迟迟不退出时也要给一个终局,而不是让作业永远 running。
  // 与 `shell.ts` 的 abort 兜底同一措辞——「未能确认终止」是事实。
  job.fallbackTimer = setTimeout(() => {
    if (job.settled) return;
    finishJob(
      job,
      killedBy === "timeout" ? "timed_out" : "signaled",
      null,
      null,
      killedBy,
    );
    enqueueCompletion(job);
  }, ABORT_FALLBACK_MS);
  job.fallbackTimer.unref?.();
}

/**
 * 结束所有作业。宿主退出时调用。
 *
 * 返回**发出终止信号**的作业数,不是「确认已退出」的数目:同步的退出钩子里
 * 没有时间等 `taskkill` 完成,谎称「已全部退出」就是 R3 意义上的伪装成功。
 */
export function killAllBackgroundJobs(): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.state !== "running" || job.settled) continue;
    terminateTree(job.pid);
    terminateTree(job.pid, true);
    job.state = "signaled";
    job.killedBy = "abort";
    job.settled = true;
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - job.startedAtMs;
    clearTimers(job);
    count += 1;
  }
  jobs.clear();
  completions.clear();
  return count;
}

function formatStatus(job: BackgroundJob): string {
  if (job.state === "running") return "running";
  if (job.state === "timed_out") return "timed_out";
  if (job.state === "signaled") {
    return job.signal === null ? "signaled" : `signaled (${job.signal})`;
  }
  return `exited with code ${job.exitCode ?? "unknown"}`;
}

function outputLine(job: BackgroundJob): string {
  const bytes = bytesOf(job);
  if (job.droppedBytes > 0) {
    return `output: ${bytes} bytes total, truncated — kept the last ${job.tail.length} bytes`;
  }
  return `output: ${bytes} bytes`;
}

function renderJob(job: BackgroundJob, withOutput: boolean): string {
  const lines = [
    `${job.id} ${formatStatus(job)}`,
    `command: ${previewCommand(job.command)}`,
    `cwd: ${job.cwd}`,
    outputLine(job),
  ];
  if (job.state === "running") {
    lines.push(`timeout: ${job.timeoutMs}ms (elapsed ${Date.now() - job.startedAtMs}ms)`);
  } else {
    lines.push(`duration: ${job.durationMs ?? 0}ms`);
    if (job.killedBy !== null) lines.push(`killed by: ${job.killedBy}`);
  }
  if (!withOutput) return lines.join("\n");

  const text = decodeTail(job.tail);
  const body =
    text.length > MAX_CHECK_TEXT_CHARS ? text.slice(text.length - MAX_CHECK_TEXT_CHARS) : text;
  if (body.trim() === "") {
    lines.push("[no output captured]");
  } else {
    lines.push(job.droppedBytes > 0 ? "[tail of captured output]" : "[output]", body);
  }
  return lines.join("\n");
}

function jobDetail(job: BackgroundJob): Record<string, unknown> {
  return {
    id: job.id,
    status: job.state,
    pid: job.pid,
    command: job.command,
    cwd: job.cwd,
    exitCode: job.exitCode,
    signal: job.signal,
    killedBy: job.killedBy,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    durationMs: job.durationMs ?? null,
    stdoutBytes: job.stdoutBytes,
    stderrBytes: job.stderrBytes,
    bytes: bytesOf(job),
    capturedBytes: job.tail.length,
    truncated: job.droppedBytes > 0,
    timeoutMs: job.timeoutMs,
  };
}

/**
 * 解除 stdio 管道对事件循环的引用。
 *
 * Node 的 `ChildProcessWithoutNullStreams['stdout']` 类型是 `Readable`,运行期
 * 却是带 `unref()` 的 `Socket`。能力探测而不是类型断言:一个没有 `unref` 的
 * 实现只是让宿主要多等一会儿,不该让工具抛错。
 */
function unrefStream(stream: unknown): void {
  const candidate = stream as { unref?: () => void } | null;
  if (typeof candidate?.unref === "function") candidate.unref();
}

function newJobId(): string {
  // 12 个十六进制字符 = 48 bit:同一个宿主进程里撞不上,也不至于长到没法念。
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `bg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const terminalBgTool: ToolDef<TerminalBgInput> = {
  name: "terminal_bg",
  description:
    "在后台启动一条长耗时 shell 命令(构建、测试、长时间烧写),立即返回作业 id 而不阻塞本轮;"
    + "命令结束(或超时、被终止)时会自动反馈结果。用 terminal_bg_check 查进度、看输出尾部,"
    + "必要时终止它。危险命令与前台 shell 走同一套拦截。",
  schema: terminalBgInputSchema,
  annotations: { readOnly: false, destructive: true },
  access: () => "write",
  execute: async (input, ctx, signal): Promise<ToolResult> => {
    if (isDangerousCommand(input.command)) {
      return failure("dangerous_command", `dangerous command blocked: ${previewCommand(input.command)}`);
    }
    if (signal.aborted) {
      return failure("background_aborted", "background command aborted before start");
    }
    const cwd = resolveCwd(ctx, input.cwd ?? ".");
    if (typeof cwd !== "string") return cwd;

    const timeoutMs =
      input.timeoutMs === undefined
        ? DEFAULT_TIMEOUT_MS
        : Math.min(Math.max(Math.floor(input.timeoutMs), 1), MAX_TIMEOUT_MS);
    const startedAtMs = Date.now();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, {
        shell: true,
        cwd,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return failure("background_spawn_failed", `failed to spawn command: ${errorMessage(error)}`);
    }
    const pid = child.pid;
    if (pid === undefined) {
      // 进程没起来:不要伪造一个 pid 让 check 去查。同步失败可能在 error 事件
      // 里到达,所以也要摘下监听,免得它把整个宿主拖进未捕获异常。
      child.on("error", () => undefined);
      return failure("background_spawn_failed", "failed to spawn command: no pid");
    }

    const job: BackgroundJob = {
      id: newJobId(),
      sessionId: ctx.sessionId,
      command: input.command,
      cwd,
      pid,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      stdoutBytes: 0,
      stderrBytes: 0,
      tail: Buffer.alloc(0),
      droppedBytes: 0,
      state: "running",
      exitCode: null,
      signal: null,
      killedBy: null,
      timeoutMs,
      settled: false,
      reported: false,
    };
    jobs.set(job.id, job);

    // 进程与两条管道都必须 unref:否则一个十分钟的后台作业会让宿主进程
    // 一直活着,退出 App 之后还在跑。`unref` 只解除父子间的存活耦合,
    // 不影响 `close`/`data` 事件——只要事件循环还在转,数据照常到达。
    //
    // `stdout`/`stderr` 在 Node 的类型里是 `Readable`,实际是带 `unref` 的
    // `Socket`(已实测)。取其能力而不是断言整个对象:没有 `unref` 时跳过,
    // 而不是让工具在运行期崩掉。
    unrefStream(child.stdout);
    unrefStream(child.stderr);
    child.unref();

    job.timeoutTimer = setTimeout(() => {
      if (job.settled) return;
      stopJob(job, "timeout");
    }, timeoutMs);
    job.timeoutTimer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      job.stdoutBytes += chunk.length;
      appendCapped(job, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      job.stderrBytes += chunk.length;
      appendCapped(job, chunk);
    });

    child.on("error", (error) => {
      if (job.settled) return;
      job.tail = Buffer.concat([job.tail, Buffer.from(`\n[spawn error] ${errorMessage(error)}\n`)]);
      finishJob(job, job.killedBy === null ? "exited" : "signaled", null, null, job.killedBy);
      enqueueCompletion(job);
    });

    child.on("close", (code, exitSignal) => {
      if (job.settled) return;
      // 谁要它死已经记在 `killedBy` 上:超时就是 timed_out,人为终止就是
      // signaled。命令自己崩掉(没有 killedBy)才按退出码/信号分类。
      if (job.killedBy === "timeout") {
        finishJob(job, "timed_out", code, exitSignal, "timeout");
      } else if (job.killedBy !== null) {
        finishJob(job, "signaled", code, exitSignal, job.killedBy);
      } else if (exitSignal !== null) {
        finishJob(job, "signaled", code, exitSignal, null);
      } else {
        finishJob(job, "exited", code ?? 1, null, null);
      }
      enqueueCompletion(job);
    });

    return {
      isError: false,
      code: "ok",
      message: "",
      text: [
        `started background job ${job.id} (pid ${pid})`,
        `command: ${previewCommand(input.command)}`,
        `timeout: ${timeoutMs}ms`,
        `use terminal_bg_check with id="${job.id}" to read the tail or kill it`,
      ].join("\n"),
      detail: {
        id: job.id,
        pid,
        status: "running",
        cwd,
        timeoutMs,
        startedAt: job.startedAt,
      },
    };
  },
};

function lookupJob(ctx: ToolCtx, id: string): { job: BackgroundJob } | { error: ToolResult } {
  const job = jobs.get(id);
  // 别的会话的作业一律按「不存在」处理:后台作业的输出里可能有另一个会话的
  // 内容,一个 id 不该成为跨会话读取的旁路。
  if (job === undefined || job.sessionId !== ctx.sessionId) {
    return {
      error: failure(
        "background_job_unknown",
        `unknown background job: ${id} (jobs belong to the session that started them and do not survive a host restart)`,
      ),
    };
  }
  return { job };
}

export const terminalBgCheckTool: ToolDef<TerminalBgCheckInput> = {
  name: "terminal_bg_check",
  description:
    "查询后台作业:给出 id 时返回状态(running / exited / signaled / timed_out)、退出码与输出尾部,"
    + "kill=true 时终止整棵进程树;不给 id 时列出本会话的全部后台作业。"
    + "输出超过捕获上限时正文会明确写出「已截断」与两个字节数。",
  schema: terminalBgCheckInputSchema,
  // 刻意不声明注解:静态注解无法描述「带 kill 才是破坏性」。声明 readOnly
  // 会对 kill 路径说谎,声明 destructive 会把一次纯状态查询标成破坏操作。
  // 权限门控读的是 access(),它按本次输入回答。
  access: (input) => (input.kill === true ? "write" : "read"),
  execute: async (input, ctx, signal): Promise<ToolResult> => {
    if (input.kill === true && input.id === undefined) {
      return failure("invalid_input", "kill requires an id");
    }
    if (signal.aborted) {
      return failure("background_aborted", "background check aborted");
    }

    if (input.id === undefined) {
      const owned = [...jobs.values()]
        .filter((job) => job.sessionId === ctx.sessionId)
        .slice(-MAX_LISTED_JOBS);
      if (owned.length === 0) {
        return {
          isError: false,
          code: "ok",
          message: "",
          text: "没有后台作业",
          detail: { jobs: [] },
        };
      }
      return {
        isError: false,
        code: "ok",
        message: "",
        text: owned
          .map((job) => `${job.id} ${formatStatus(job)} — ${previewCommand(job.command)}`)
          .join("\n"),
        detail: { jobs: owned.map(jobDetail) },
      };
    }

    if (!JOB_ID_PATTERN.test(input.id)) {
      return failure("background_job_unknown", `unknown background job: ${input.id}`);
    }
    const found = lookupJob(ctx, input.id);
    if ("error" in found) return found.error;
    const job = found.job;

    if (input.kill === true) {
      if (job.state === "running" && !job.settled) {
        stopJob(job, "kill");
        // 终止是异步的:此刻只能说「已请求终止」,不能说「已结束」。
        return {
          isError: false,
          code: "ok",
          message: "",
          text: [
            `${job.id} termination requested`,
            `command: ${previewCommand(job.command)}`,
            outputLine(job),
          ].join("\n"),
          detail: { ...jobDetail(job), killRequested: true },
        };
      }
      // 已经结束:如实报告它的终局,不伪造一次新的终止。
      job.reported = true;
      suppressCompletion(job.sessionId, job.id);
      return {
        isError: false,
        code: "ok",
        message: "",
        text: renderJob(job, true),
        detail: { ...jobDetail(job), killRequested: false },
      };
    }

    // 报告一次终局就算「已经说过」:完成队列不再重复通知同一条结局。
    if (job.state !== "running") {
      job.reported = true;
      suppressCompletion(job.sessionId, job.id);
    }
    return {
      isError: false,
      code: "ok",
      message: "",
      text: renderJob(job, true),
      detail: jobDetail(job),
    };
  },
};
