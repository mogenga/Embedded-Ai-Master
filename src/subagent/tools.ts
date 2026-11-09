import path from "node:path";
import { z } from "zod";
import type { ToolCtx, ToolDef, ToolResult } from "../tools/types.js";
import {
  MAX_RUNNING_SUBAGENTS,
  getSubagent,
  killSubagent,
  listSubagents,
  resolveSubagentMaxTurns,
  resolveSubagentTimeoutMs,
  startSubagent,
} from "./runner.js";
import type { SubagentDeps } from "./runner.js";
import type { SubagentSummary } from "./types.js";

/**
 * 子代理的两个工具（批次 9 · 9.4）。
 *
 * 装配位置刻意不在 `createBuiltinTools()`：那边不接参数、`tests/tools.test.ts`
 * 钉着它返回 13 个纯对象工具，而这些工具需要 model / registry / permissionGate。
 * 调用方把两者并列拼进同一个 `ToolRegistry`（`src/index.ts` 的两条构造路径都要）。
 */

const MAX_CHECK_TEXT_CHARS = 4096;
const MAX_CHECK_PROMPT_CHARS = 200;

export const subagentInputSchema = z.object({
  prompt: z.string().min(1),
  /** 显示名；只用于完成提示与列表，缺省时不拿 id 冒充名字。 */
  label: z.string().min(1).optional(),
  /**
   * 子代理自己的模型调用上限。**缺省不限**（2026-11-09）。
   *
   * 给这个值相当于替这次分派划一条边界；不给就一直跑到它自己结束。终止仍有
   * `subagent_check{kill:true}` 与宿主退出时的 `killAllSubagents()`。
   */
  maxTurns: z.number().int().positive().optional(),
  /**
   * 子代理自身的寿命上限（毫秒），**不是**这次工具调用的超时——工具立即返回。
   * **缺省不限**，同上。
   */
  timeoutMs: z.number().int().positive().optional(),
});

export type SubagentInput = z.infer<typeof subagentInputSchema>;

export const subagentCheckInputSchema = z.object({
  id: z.string().min(1).optional(),
  /**
   * 终止该子代理。
   *
   * 它是写操作：只有带 `kill: true` 时这个工具才需要写权限，纯粹查询状态的
   * 调用不应该被 `read-only` / `diagnose` 预设拦下（与 `terminal_bg_check` 同形）。
   */
  kill: z.boolean().optional(),
});

export type SubagentCheckInput = z.infer<typeof subagentCheckInputSchema>;

function failure(code: string, message: string): ToolResult {
  return { isError: true, code, message, text: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 父会话目录。
 *
 * `ToolCtx` 只有 `sessionId / cwd / artifactDir`，没有会话目录；而 `artifactDir`
 * 的定义就是 `<session.dir>/artifacts`（`src/tools/types.ts`），所以它的父目录
 * 就是会话目录。取不到时**显式报错**，不拿 cwd 顶上——那会把子会话建到工作区里，
 * 变成一个既不属于会话、又会被 `git status` 看见的目录。
 */
function parentDirOf(ctx: ToolCtx): string | undefined {
  if (ctx.artifactDir === undefined || ctx.artifactDir.length === 0) return undefined;
  return path.dirname(path.resolve(ctx.artifactDir));
}

/** 「不限」要说出来，不能印成 0 或一个默认数字。 */
function describeLimit(value: number | undefined): string {
  return value === undefined ? "no limit" : String(value);
}

function describeTimeout(value: number | undefined): string {
  return value === undefined ? "no limit" : `${value}ms`;
}

function summaryLine(summary: SubagentSummary): string {
  const name = summary.label ?? summary.id;
  const prompt = summary.promptPreview.length <= MAX_CHECK_PROMPT_CHARS
    ? summary.promptPreview
    : `${summary.promptPreview.slice(0, MAX_CHECK_PROMPT_CHARS)}...`;
  return `${summary.id} ${name} ${summary.status} — ${prompt}`;
}

function renderSummary(summary: SubagentSummary): string {
  const lines = [
    `${summary.id} ${summary.status}`,
    ...(summary.label === undefined ? [] : [`label: ${summary.label}`]),
    `session: ${summary.sessionDir}`,
    `turns: ${summary.turns}, tool calls: ${summary.toolCalls}`,
    `tokens: ${summary.promptTokens} prompt + ${summary.completionTokens} completion`,
  ];
  if (summary.costUsd !== undefined) lines.push(`cost: $${summary.costUsd.toFixed(6)}`);
  lines.push(`started: ${summary.startedAt}`);
  if (summary.finishedAt !== undefined) lines.push(`finished: ${summary.finishedAt}`);
  if (summary.killedBy !== undefined) lines.push(`killed by: ${summary.killedBy}`);
  if (summary.error !== undefined) lines.push(`error: ${summary.error}`);
  if (summary.truncated === true) {
    lines.push(
      `result: ${summary.textBytes} bytes total, truncated — kept the first ${summary.capturedBytes} bytes`,
    );
  }
  const body = summary.text.length > MAX_CHECK_TEXT_CHARS
    ? summary.text.slice(0, MAX_CHECK_TEXT_CHARS)
    : summary.text;
  if (body.trim() === "") {
    lines.push("[no result text]");
  } else {
    lines.push(summary.truncated === true ? "[result, head of captured text]" : "[result]", body);
  }
  return lines.join("\n");
}

function summaryDetail(summary: SubagentSummary): Record<string, unknown> {
  return {
    id: summary.id,
    sessionDir: summary.sessionDir,
    status: summary.status,
    label: summary.label ?? null,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt ?? null,
    turns: summary.turns,
    toolCalls: summary.toolCalls,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    costUsd: summary.costUsd ?? null,
    textBytes: summary.textBytes,
    capturedBytes: summary.capturedBytes,
    truncated: summary.truncated === true,
    killedBy: summary.killedBy ?? null,
  };
}

export function createSubagentTools(deps: SubagentDeps): [ToolDef<SubagentInput>, ToolDef<SubagentCheckInput>] {
  const subagentTool: ToolDef<SubagentInput> = {
    name: "subagent",
    description:
      "把一个只读调查任务分派给同进程的子代理,立即返回它的 id 而不阻塞本轮;"
      + `子代理只能用读取类工具(写操作会被权限层拒绝),最多 ${MAX_RUNNING_SUBAGENTS} 个并发。`
      + "它结束时结果会自动回来;也可以用 subagent_check 按 id 取结论、看进度或终止它。",
    schema: subagentInputSchema,
    // 它不是只读的:要花模型的钱,还要起一个会写日志的会话。但**不是** destructive
    // ——它不删除、不覆盖任何东西。声明 destructive 会让它在 diagnose 预设下变成
    // 无条件审批,而那个预设里「问一次再跑」正是操作者最常做的动作。
    annotations: { readOnly: false },
    access: () => "write",
    execute: async (input, ctx, signal): Promise<ToolResult> => {
      if (signal.aborted) {
        return failure("subagent_aborted", "subagent aborted before start");
      }
      const parentDir = parentDirOf(ctx);
      if (parentDir === undefined) {
        return failure(
          "subagent_unavailable",
          "no session directory is available: the subagent session cannot be placed",
        );
      }
      let outcome: Awaited<ReturnType<typeof startSubagent>>;
      try {
        outcome = await startSubagent(ctx.sessionId, parentDir, input.prompt, {
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          deps,
        });
      } catch (error) {
        return failure("subagent_start_failed", `failed to start subagent: ${errorMessage(error)}`);
      }
      if ("error" in outcome) {
        return failure(outcome.code, outcome.error);
      }
      const sessionDir = path.join(parentDir, "subagents", outcome.id);
      return {
        isError: false,
        code: "ok",
        message: "",
        text: [
          `started subagent ${outcome.id}`,
          `session: ${sessionDir}`,
          // 报的是**真正生效**的两个值，不是用户填的原值：填了 0 或超范围的
          // 值会被判为无效，正文里再回显原值就是说谎。缺省是「不限」，不是
          // 某个默认数字——这与主循环的 maxTurns 同一条语义。
          `max turns: ${describeLimit(resolveSubagentMaxTurns(input.maxTurns))}, `
            + `timeout: ${describeTimeout(resolveSubagentTimeoutMs(input.timeoutMs))}`,
          `use subagent_check with id="${outcome.id}" to read the result, or kill it`,
        ].join("\n"),
        detail: { id: outcome.id, sessionDir, status: "running" },
      };
    },
  };

  const subagentCheckTool: ToolDef<SubagentCheckInput> = {
    name: "subagent_check",
    description:
      "查询子代理:给出 id 时返回状态(running / finished / failed / killed / timed_out)、"
      + "用量与结论正文,kill=true 时请求终止它;不给 id 时列出本会话的全部分子代理。"
      + "结论超过上限时正文会明确写出「已截断」与两个字节数。",
    schema: subagentCheckInputSchema,
    // 与 `terminal_bg_check` 同一姿态:静态注解无法描述「带 kill 才是破坏性」。
    // 声明 readOnly 会对 kill 路径说谎,声明 destructive 会把一次纯状态查询标成
    // 破坏操作。权限门控读的是 access(),它按本次输入回答。
    access: (input) => (input.kill === true ? "write" : "read"),
    execute: async (input, ctx, signal): Promise<ToolResult> => {
      if (input.kill === true && input.id === undefined) {
        return failure("invalid_input", "kill requires an id");
      }
      if (signal.aborted) {
        return failure("subagent_aborted", "subagent check aborted");
      }

      if (input.id === undefined) {
        const owned = listSubagents(ctx.sessionId);
        if (owned.length === 0) {
          return {
            isError: false,
            code: "ok",
            message: "",
            text: "没有子代理",
            detail: { subagents: [] },
          };
        }
        return {
          isError: false,
          code: "ok",
          message: "",
          text: owned.map(summaryLine).join("\n"),
          detail: { subagents: owned.map(summaryDetail) },
        };
      }

      const summary = getSubagent(ctx.sessionId, input.id);
      if (summary === undefined) {
        // 跨父会话的 id 与不存在的 id 同一条回答:一个 id 不该成为
        // 跨会话读取的旁路(与 `background.ts` 的 lookupJob 同一条理由)。
        return failure(
          "subagent_unknown",
          `unknown subagent: ${input.id} (subagents belong to the session that started them and do not survive a host restart)`,
        );
      }

      if (input.kill === true) {
        if (summary.status === "running" && killSubagent(ctx.sessionId, input.id)) {
          // 终止是异步的:此刻只能说「已请求终止」,不能说「已结束」。
          return {
            isError: false,
            code: "ok",
            message: "",
            text: [
              `${summary.id} termination requested`,
              `session: ${summary.sessionDir}`,
              "the subagent is still winding down; check again for its final status",
            ].join("\n"),
            detail: { ...summaryDetail(summary), killRequested: true },
          };
        }
        // 已经结束:如实报告它的终局,不伪造一次新的终止。
        return {
          isError: false,
          code: "ok",
          message: "",
          text: renderSummary(summary),
          detail: { ...summaryDetail(summary), killRequested: false },
        };
      }

      return {
        isError: false,
        code: "ok",
        message: "",
        text: renderSummary(summary),
        detail: summaryDetail(summary),
      };
    },
  };

  return [subagentTool, subagentCheckTool];
}
