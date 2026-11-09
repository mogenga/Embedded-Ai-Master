import path from "node:path";
import type { ModelCfg } from "../config/providers.js";
import type { ModelChatMessage, ModelProtocol } from "../model/protocol.js";
import { computeCostUsd } from "../loop/breakers.js";
import type { PricePerMillion } from "../loop/breakers.js";
import type { LoopFinishReason } from "../loop/events.js";
import { query } from "../loop/query.js";
import type { LoopCtx } from "../loop/query.js";
import type { PermissionGate, SourcedRule } from "../permissions/types.js";
import { createPermissionGate } from "../permissions/gate.js";
import { createSession } from "../session/session.js";
import type { SessionHandle } from "../session/session.js";
import type { SystemSections } from "../context/system-sections.js";
import type { SubagentStartedPayload } from "../session/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { randomUUID } from "node:crypto";
import type { SubagentStatus, SubagentSummary } from "./types.js";

/**
 * 只读子代理的运行时（批次 9 · 9.4）。
 *
 * 与 `tools/background.ts` 是同一套姿态：起作业后立刻返回 id，作业在后台跑，
 * 终局推一条到按父会话分组的完成队列，由宿主取走写成 `subagent_result` 事件。
 * 区别只有一个——这里的「作业」是同一进程里嵌套跑的一次 `query()`，不是一个
 * 子进程。
 */

/** 同时在跑的子代理上限。常量而不是配置项：4 个并发已经够用，再多的意义只在压测。 */
export const MAX_RUNNING_SUBAGENTS = 4;

/**
 * 轮数与寿命**都没有默认上限**（用户决定，2026-11-09）。
 *
 * 曾经的默认值是 30 轮 / 10 分钟，理由是「子代理是被分派的一件差事，没人盯着
 * 它」。这条理由被推翻了：一个跑偏的子代理被静默截断，比跑久一点更糟——它交给
 * 父会话的结论会是半截的，而且「为什么停了」只写在一条 `failed` 的 `error`
 * 里。这与主循环「不填 `maxTurns` 就不检查轮数」是同一条原则（D-183）。
 *
 * 调用方仍可以显式给 `maxTurns` / `timeoutMs`：那是它为自己的用例划的边界，
 * 与主循环的 `maxTurns` 一样按给的来。缺省 = 不限。
 *
 * **子代理仍会被终止**：`killSubagent` / `subagent_check{kill:true}` 与宿主退出
 * 时的 `killAllSubagents()` 都不受这两个值影响。
 */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_SUMMARY_TEXT_BYTES = 8 * 1024;
const MAX_PROMPT_PREVIEW_CHARS = 120;
const MAX_LISTED_SUBAGENTS = 20;

/**
 * 子代理的 system 提示词（`createSession` 写进子会话日志）。
 *
 * 措辞是**产品决定**：子代理不知道自己只读时会浪费回合去试写工具，而权限层
 * 的拒绝要等一次调用发生后才看得见。这段话是「为什么不能写」唯一的告知点。
 */
export const SUBAGENT_SYSTEM_PROMPT = [
  "你是一个只读子代理，由主线程分派来调查一件事。你只能使用读取类工具，写操作会被权限层拒绝。",
  "把结论写成一段话：先说结论，再列支撑它的具体证据（文件路径、行号、命令输出）。",
  "不要复述你的调查过程。调查完毕就结束，不要提出下一步计划等待批准。",
].join("\n");

export interface SubagentDeps {
  model: ModelProtocol;
  modelCfg: ModelCfg;
  /** 惰性取值：`runSession` 里 registry 先于子代理工具建好，最终表还要装 MCP 工具。 */
  registry: () => ToolRegistry;
  budget: (messages: ModelChatMessage[]) => { over: boolean; tokens: number; softLimit: number };
  compactor?: (session: SessionHandle) => Promise<void>;
  /** 父门的副本，只取 preset 与 deny 规则（见 `childPermissionGate`）。 */
  /**
   * 父会话**这一轮实际加载的规则**（`LoadedPermissionConfig.rules`）。
   *
   * 不通过 `PermissionGate` 取：那个接口只有 `check()`，让它多暴露一个字段是
   * 为了子代理去改一个公共类型。规则本来就在 `runSession` 手里，直接传。
   */
  inheritableRules: readonly SourcedRule[];
  cwd: string;
  /** 子代理单次工具调用的预算（管线 `timeoutMs`），沿用父的。 */
  timeoutMs?: number;
  systemSections?: SystemSections;
  pricePerMillion?: PricePerMillion;
  /** 计入父会话的成本（累计），让 `maxCostUsd` 看得见子代理的开销。 */
  onSpend: (usd: number) => void;
  /**
   * 子代理开跑时写一条 `subagent_started`。失败不阻止启动（见 `startSubagent`）。
   *
   * runner 没有 session handle，所以写入是调用方的事：宿主知道父会话在哪，
   * 而同一条 `SubagentDeps` 会被同一个父会话的多次调用复用。
   */
  onStarted?: (payload: SubagentStartedPayload) => Promise<void>;
}

interface SubagentJob {
  id: string;
  parentSessionId: string;
  sessionDir: string;
  promptPreview: string;
  label?: string;
  startedAt: string;
  status: SubagentStatus;
  finishedAt?: string;
  turns: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
  text: string;
  textBytes: number;
  capturedBytes: number;
  truncated: boolean;
  error?: string;
  killedBy?: "kill" | "timeout" | "abort";
  /** 终局已定；之后不再改状态、不再重复入队。 */
  settled: boolean;
  /** 已经进过完成队列。 */
  reported: boolean;
  controller: AbortController;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

// 进程级注册表：作业属于宿主进程，不属于某一次工具调用。宿主退出时
// `killAllSubagents()` 把它们一起带走，否则一个跑着的子代理会活过 App。
const jobs = new Map<string, SubagentJob>();
// 按父会话分组的完成队列，等宿主取走写成 `subagent_result` 事件。
const completions = new Map<string, SubagentSummary[]>();
/**
 * 每个父会话已经花在子代理上的钱（美元）。
 *
 * **按会话**而不是按一次运行累计：父会话的 `costUsd` 语义是「整段会话的总预算」
 * （它读的是整份日志的 `usageTotals()`，含历史）。子代理的开销如果只活在一次
 * `runSession` 的局部变量里，下一条消息就又变成 0——设了上限却只对「当轮起的
 * 子代理」有效，那正是这道闸门最需要存在的时候。
 *
 * 只在知道价格时累加：没有价格就不加 0（零美元 ≠ 免费）。
 */
const spendByParent = new Map<string, number>();

/** 某个父会话已经花在子代理上的总金额（美元）。没有价格信息时恒为 0。 */
export function subagentSpendUsd(parentSessionId: string): number {
  return spendByParent.get(parentSessionId) ?? 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function previewPrompt(prompt: string): string {
  const flat = oneLine(prompt);
  return flat.length <= MAX_PROMPT_PREVIEW_CHARS
    ? flat
    : `${flat.slice(0, MAX_PROMPT_PREVIEW_CHARS)}...`;
}

function newSubagentId(): string {
  // `sa_` + 12 个十六进制字符：既是作业 id 也是子会话 id，必须满足
  // `isValidSessionId`（`[a-zA-Z0-9_-]{1,128}`，非 Windows 保留名）。
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `sa_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 按 UTF-8 字节截断，且不切断字符边界。
 *
 * 子代理的结论要被写进父会话日志与完成事件，两处都以字节计量（`textBytes` /
 * `capturedBytes`）。按字符截断再报字节数会让两个数字对不上，按字节硬切则会
 * 在正文末尾留下一个替换符。
 */
function truncateToBytes(text: string, maxBytes: number): { text: string; bytes: number } {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return { text, bytes: total };
  let used = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    end += char.length;
  }
  return { text: text.slice(0, end), bytes: used };
}

/**
 * 子代理实际的寿命上限（毫秒），或 `undefined` 表示不限。
 *
 * 导出是为了让工具正文报的就是真正生效的那个数：填了非法值的人看到的应该是
 * 「不限」，而不是一个他没写过的数字。
 */
export function resolveSubagentTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMEOUT_MS);
}

/** 子代理实际的轮数上限，或 `undefined` 表示不限。理由同上。 */
export function resolveSubagentMaxTurns(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

/**
 * 子代理的权限层。
 *
 * **只读是权限层保证的，不是另一张白名单。** 这里不写任何「允许调用的工具名」
 * ——那会成为「只读」的第二份定义，与 `DEFAULT_ACTIONS["read-only"]` 各自演化。
 * 继承的只有父规则里的 `deny`：收紧可以，放行不行（父的 `allow` 规则在子代理
 * 里不会让一个写工具变成可写，因为预设已经把 write 判成 deny）。
 *
 * 规则由调用方直接从 `LoadedPermissionConfig` 传进来，而不是从 gate 上取：
 * `PermissionGate` 只有 `check()`，为了子代理去给一个公共接口加字段，代价比
 * 受益大（第一版这么做了，已经改回来）。没有规则时 `read-only` 预设仍然全量兜底。
 */
function childPermissionGate(inheritableRules: readonly SourcedRule[]): PermissionGate {
  const denyRules = inheritableRules.filter((entry) => entry.rule.action === "deny");
  return createPermissionGate({ preset: "read-only", rules: denyRules });
}

/** 子会话的最后一条 assistant 正文。 */
function lastAssistantText(events: readonly { type: string; payload: Record<string, unknown> }[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "assistant") continue;
    const content = event.payload.content;
    return typeof content === "string" ? content : "";
  }
  return "";
}

function childStats(child: SessionHandle): {
  turns: number;
  toolCalls: number;
  text: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
} {
  const events = child.events();
  let turns = 0;
  let toolCalls = 0;
  for (const event of events) {
    if (event.type === "assistant") turns += 1;
    if (event.type === "tool_result") toolCalls += 1;
  }
  const totals = child.usageTotals();
  return {
    turns,
    toolCalls,
    text: lastAssistantText(events),
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    cachedTokens: totals.cachedTokens,
  };
}

function summaryOf(job: SubagentJob): SubagentSummary {
  const summary: SubagentSummary = {
    id: job.id,
    sessionDir: job.sessionDir,
    status: job.status,
    startedAt: job.startedAt,
    turns: job.turns,
    toolCalls: job.toolCalls,
    promptTokens: job.promptTokens,
    completionTokens: job.completionTokens,
    text: job.text,
    textBytes: job.textBytes,
    capturedBytes: job.capturedBytes,
    promptPreview: job.promptPreview,
    ...(job.label === undefined ? {} : { label: job.label }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.costUsd === undefined ? {} : { costUsd: job.costUsd }),
    ...(job.truncated ? { truncated: true } : {}),
    ...(job.killedBy === undefined ? {} : { killedBy: job.killedBy }),
    ...(job.error === undefined ? {} : { error: job.error }),
  };
  return summary;
}

function enqueueCompletion(job: SubagentJob): void {
  if (job.reported) return;
  // 作业表被 `killAllSubagents()` 丢掉之后不再入队：那个终局已经没人会读，
  // 推进一个孤儿队列只会让下一次同 id 的父会话读到别人的结果。
  if (jobs.get(job.id) !== job) return;
  job.reported = true;
  const queue = completions.get(job.parentSessionId);
  const payload = summaryOf(job);
  if (queue === undefined) completions.set(job.parentSessionId, [payload]);
  else queue.push(payload);
}

function clearTimer(job: SubagentJob): void {
  if (job.timeoutTimer !== undefined) {
    clearTimeout(job.timeoutTimer);
    job.timeoutTimer = undefined;
  }
}

/**
 * 定下终局。
 *
 * 只在这里改 `status`：`killSubagent` / 超时定时器只发 abort 与 `killedBy`，
 * 真正的「它已经停了」由 `query()` 收尾后回到这里宣布——那时它确实停了。
 */
function finalize(
  job: SubagentJob,
  status: SubagentStatus,
  deps: SubagentDeps,
  extra: { error?: string } = {},
): void {
  if (job.settled) return;
  job.settled = true;
  clearTimer(job);
  job.status = status;
  job.finishedAt = new Date().toISOString();
  if (extra.error !== undefined) job.error = extra.error;
  // 成本计入父会话。没有价格就不加 0：`costUsd` 字段不出现、`onSpend` 不调用
  // ——与 `usage` 事件的既有约定一致（零美元 ≠ 免费）。
  if (deps.pricePerMillion !== undefined) {
    job.costUsd = computeCostUsd(
      { promptTokens: job.promptTokens, completionTokens: job.completionTokens },
      deps.pricePerMillion,
    );
    // 进程内的会话账本先记账，再通知调用方：调用方忘了接 `onSpend` 时，
    // `subagentSpendUsd()` 仍然给出正确数字。
    spendByParent.set(
      job.parentSessionId,
      (spendByParent.get(job.parentSessionId) ?? 0) + job.costUsd,
    );
    try {
      deps.onSpend(job.costUsd);
    } catch {
      // 记账回调失败不能改写这个子代理的终局：它是已经发生的事实，
      // 而 costUsd 已经记在 summary 上。
    }
  }
  enqueueCompletion(job);
}

function ownershipOf(parentSessionId: string, id: string): SubagentJob | undefined {
  const job = jobs.get(id);
  // 别的父会话的子代理一律按「不存在」处理：它的结论可能包含另一个会话的
  // 内容，一个 id 不该成为跨会话读取的旁路（与 `background.ts` 同一条理由）。
  if (job === undefined || job.parentSessionId !== parentSessionId) return undefined;
  return job;
}

/**
 * 跑一个子代理。
 *
 * `maxTurns` / `timeoutMs` 收的是 `startSubagent` 已经解析过的数字，这里**不再
 * 解析一次**：同一对数字既要写进 `subagent_started`、又要交给 `query()` 与定时器，
 * 两处各解析一次就等于有两个口径。解析点是 `startSubagent`（那里还要把它们报给
 * 调用方）。
 */
async function runJob(
  job: SubagentJob,
  prompt: string,
  opts: { maxTurns?: number; timeoutMs?: number; deps: SubagentDeps },
): Promise<void> {
  const { deps } = opts;
  const childDir = job.sessionDir;
  let child: SessionHandle | undefined;
  let childClosed = false;
  // 关闭要**先于**宣布终局（见下面 stats 之后的注释）。`close()` 本身是幂等的，
  // 这里再挡一层只是为了让「什么时候关的」在代码里只有一处说法。
  const closeChild = async (): Promise<void> => {
    if (childClosed) return;
    childClosed = true;
    try {
      await child?.close();
    } catch {
      // 关闭失败不改变已经宣布的终局；日志仍在盘上。
    }
  };
  try {
    child = await createSession(childDir, {
      id: job.id,
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      workdir: deps.cwd,
    });

    // 寿命定时器从子代理**真正开跑**算起：建目录、拿锁不属于它的调查时间。
    // `opts.timeoutMs` 由 `startSubagent` 解析好传进来——同一对数字已经写进
    // `subagent_started`，这里再解析一次就是第二个口径。
    //
    // 缺省**不设定时器**：没有上限就没有到点这件事。终止仍由 `killSubagent`
    // 与 `killAllSubagents()` 负责。
    if (opts.timeoutMs !== undefined) {
      job.timeoutTimer = setTimeout(() => {
        if (job.settled || job.killedBy !== undefined) return;
        job.killedBy = "timeout";
        job.controller.abort();
      }, opts.timeoutMs);
      job.timeoutTimer.unref?.();
    }

    const ctx: LoopCtx = {
      session: child,
      model: deps.model,
      modelCfg: deps.modelCfg,
      tools: deps.registry(),
      budget: deps.budget,
      signal: job.controller.signal,
      // 子代理用自己的产物根：父会话的 artifacts 对它不可见，
      // `artifact` 工具的边界因此仍是「当前会话的产物」。
      artifactDir: path.join(childDir, "artifacts"),
      cwd: deps.cwd,
      permissionGate: childPermissionGate(deps.inheritableRules),
      ...(deps.compactor === undefined ? {} : { compactor: deps.compactor }),
      ...(deps.systemSections === undefined ? {} : { systemSections: deps.systemSections }),
      ...(deps.pricePerMillion === undefined ? {} : { pricePerMillion: deps.pricePerMillion }),
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      // 兜底墙钟比 runner 的 abort 晚一分钟：**正常路径必须由 abort 收尾**，
      // 否则 `query` 会自己报 `deadline` 正常结束，终局就成了 finished 而不是
      // timed_out。这一条只是「定时器没发出来的意外」的最后一道。
      //
      // 没有显式上限时整键缺席：`deadlineMs` 缺省 = 不限制（与主循环同一条
      // 语义），填一个值反而会凭空造出一个用户没要求的截止时间。
      ...(opts.timeoutMs === undefined ? {} : { deadlineMs: opts.timeoutMs + 60_000 }),
    };

    let finishReason: LoopFinishReason | undefined;
    // `maxTurns` 缺省 = 不检查轮数（`assertBreakers` 只在它非 undefined 时判）。
    // 整键缺席而不是传 undefined，与主循环 `runSession` 的写法一致。
    for await (const event of query(ctx, prompt, {
      ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
    })) {
      if (event.kind === "done") finishReason = event.finishReason;
    }

    const stats = childStats(child);
    job.turns = stats.turns;
    job.toolCalls = stats.toolCalls;
    job.promptTokens = stats.promptTokens;
    job.completionTokens = stats.completionTokens;
    const captured = truncateToBytes(stats.text, MAX_SUMMARY_TEXT_BYTES);
    job.text = captured.text;
    job.capturedBytes = captured.bytes;
    job.textBytes = Buffer.byteLength(stats.text, "utf8");
    job.truncated = job.textBytes > job.capturedBytes;

    // 先 close 再宣布终局：完成队列被取走的那一刻，子会话的锁必须已经释放。
    // 反过来的话，宿主拿到 `subagent_result` 立刻去读子会话，会撞上
    // `session_locked`——一条刚刚宣布「已完成」的会话却打不开。
    await closeChild();

    if (job.killedBy === "timeout") {
      finalize(job, "timed_out", deps);
      return;
    }
    if (job.killedBy !== undefined) {
      finalize(job, "killed", deps);
      return;
    }
    // `query` 的兜底墙钟先于 runner 的定时器到点时（定时器被事件循环拖后），
    // 事实仍然是「它跑超时了」，如实记 timed_out 而不是 folded 成一个失败。
    if (finishReason === "deadline") {
      job.killedBy = "timeout";
      finalize(job, "timed_out", deps);
      return;
    }
    if (finishReason === undefined || finishReason === "no_tool_calls" || finishReason === "truncated") {
      finalize(job, "finished", deps);
      return;
    }
    // 熔断与超限都属于**没查完**：报 finished 会把一次被截断的调查说成结论。
    finalize(job, "failed", deps, {
      error: `subagent stopped before finishing: ${finishReason}`,
    });
  } catch (error) {
    await closeChild();
    if (job.settled) return;
    if (job.killedBy === "timeout") finalize(job, "timed_out", deps);
    else if (job.killedBy !== undefined) finalize(job, "killed", deps);
    else finalize(job, "failed", deps, { error: errorMessage(error) });
  }
}

/**
 * 起一个子代理。
 *
 * 同步段只做三件事：查并发上限、登记作业、算预览；子会话目录与 `query()`
 * 都在不 await 的后台任务里。因此模型请求挂着时它仍然立即返回 id。
 *
 * 唯一的例外是 `deps.onStarted`：它必须在返回 id **之前**完成。反过来的话
 * 一次跑得极快的子代理可能先推完成事件、后写开始事件，渲染器就会先看到它结束
 * 再看到它开始——而「运行中」那一侧真正依赖的就是这一步的先后。
 */
export async function startSubagent(
  parentSessionId: string,
  parentDir: string,
  prompt: string,
  opts: {
    label?: string;
    maxTurns?: number;
    timeoutMs?: number;
    deps: SubagentDeps;
  },
): Promise<{ id: string } | { error: string; code: string }> {
  // 上限检查与作业登记之间**不能有 await**：否则两个同时到达的 start 都能
  // 看到「还差一个」，第 5、6 个一起溜过去。
  let running = 0;
  for (const job of jobs.values()) {
    if (job.parentSessionId === parentSessionId && job.status === "running") running += 1;
  }
  if (running >= MAX_RUNNING_SUBAGENTS) {
    return {
      error: `too many running subagents (max ${MAX_RUNNING_SUBAGENTS})`,
      code: "subagent_limit",
    };
  }

  // 两个上限在这里解析**一次**：同一对数字既写进 `subagent_started`，也交给
  // `runJob` 的定时器与 `query()`。`subagent` 工具正文用的是同一对 resolver，
  // 所以三处报的是同一个数。
  //
  // 两者都可能是 `undefined`（= 不限），这是缺省状态：不给就跑到它自己结束。
  const maxTurns = resolveSubagentMaxTurns(opts.maxTurns);
  const timeoutMs = resolveSubagentTimeoutMs(opts.timeoutMs);

  const id = newSubagentId();
  const job: SubagentJob = {
    id,
    parentSessionId,
    sessionDir: path.join(parentDir, "subagents", id),
    promptPreview: previewPrompt(prompt),
    startedAt: new Date().toISOString(),
    status: "running",
    turns: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    text: "",
    textBytes: 0,
    capturedBytes: 0,
    truncated: false,
    settled: false,
    reported: false,
    controller: new AbortController(),
    ...(opts.label === undefined || opts.label.trim() === "" ? {} : { label: opts.label }),
  };
  jobs.set(job.id, job);

  // 开始事件先于作业本体，但它**不是**作业的一部分：写失败只降级为一行 stderr，
  // 不取消一个已经登记、马上要跑的子代理（`appendMcpStatus` 的姿态——观测性
  // 记录写不进去，不该让被观测的那件事失败）。
  if (opts.deps.onStarted !== undefined) {
    const payload: SubagentStartedPayload = {
      id: job.id,
      sessionDir: job.sessionDir,
      promptPreview: job.promptPreview,
      ...(job.label === undefined ? {} : { label: job.label }),
      startedAt: job.startedAt,
      // 整键缺席 = 不限。写 `null` 或 0 会让读的人以为有一个他没设过的上限。
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    try {
      await opts.deps.onStarted(payload);
    } catch (error) {
      console.error(`[subagent] started event append failed: ${errorMessage(error)}`);
    }
  }

  // 不 await：这条 promise 的终局只能经完成队列或 `getSubagent` 看见。
  void runJob(job, prompt, { maxTurns, timeoutMs, deps: opts.deps }).catch((error) => {
    // runJob 自己已兜住一切；这里只兜住「finalize 本身抛了」这种意外，
    // 免得留下一个永远 running 的作业。
    finalize(job, "failed", opts.deps, { error: errorMessage(error) });
  });

  return { id };
}

export function getSubagent(parentSessionId: string, id: string): SubagentSummary | undefined {
  const job = ownershipOf(parentSessionId, id);
  return job === undefined ? undefined : summaryOf(job);
}

export function listSubagents(parentSessionId: string): SubagentSummary[] {
  const owned: SubagentJob[] = [];
  for (const job of jobs.values()) {
    if (job.parentSessionId === parentSessionId) owned.push(job);
  }
  return owned.slice(-MAX_LISTED_SUBAGENTS).map(summaryOf);
}

/**
 * 请求终止一个子代理。
 *
 * 只发 abort 并记下「谁要它停」——**不**在这里宣布终局：`query()` 还要收尾
 * （补 tool_result、写 interrupted），此刻说「已结束」就是伪造。终局由
 * `runJob` 回到 `finalize` 时给出。返回 `true` 表示请求已发出。
 */
export function killSubagent(parentSessionId: string, id: string): boolean {
  const job = ownershipOf(parentSessionId, id);
  if (job === undefined || job.settled || job.status !== "running") return false;
  if (job.killedBy !== undefined) return true;
  job.killedBy = "kill";
  job.controller.abort();
  return true;
}

/**
 * 取出并清空某个父会话的完成通知。
 *
 * 宿主写 `subagent_result` 事件的唯一入口：写成事件之后，重开父会话仍能从
 * 日志里看到「那个子代理最后查到了什么」。取出即消费，同一个终局不会写两遍。
 */
export function takeSubagentCompletions(parentSessionId: string): SubagentSummary[] {
  const queue = completions.get(parentSessionId);
  if (queue === undefined || queue.length === 0) return [];
  completions.delete(parentSessionId);
  return queue;
}

/**
 * 终止进程内所有子代理。宿主退出时调用。
 *
 * 只发 abort：`query()` 是异步的，退出钩子里没有时间等它收尾，谎称「已全部
 * 结束」就是 R3 意义上的伪装成功。作业表在这里清空——宿主都要退出了，之后的
 * 终局不会再有人读。
 */
export function killAllSubagents(): void {
  for (const job of jobs.values()) {
    if (job.settled || job.status !== "running") continue;
    if (job.killedBy === undefined) job.killedBy = "abort";
    clearTimer(job);
    job.controller.abort();
  }
  jobs.clear();
  completions.clear();
  spendByParent.clear();
}
