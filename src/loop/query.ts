import { resolveContextWindow, resolveMaxOutput } from "../config/providers.js";
import type { ModelCfg } from "../config/providers.js";
import { buildContextBreakdown } from "../context/breakdown.js";
import { buildMessages } from "../context/build.js";
import type { TokenMeter } from "../context/token-meter.js";
import type {
  CompletionResult,
  ModelChatMessage,
  ModelProtocol,
} from "../model/protocol.js";
import type { PermissionGate } from "../permissions/types.js";
import type { SessionHandle } from "../session/session.js";
import type {
  PermissionDecisionPayload,
  TodosPayload,
  ToolResultPayload,
  ToolStartedPayload,
} from "../session/types.js";
import { executeBatch } from "../tools/pipeline.js";
import type { BatchCall, BatchOptions, BatchResult } from "../tools/pipeline.js";
import { toModelToolSchemas } from "../tools/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import type { BreakerLimits, PricePerMillion } from "./breakers.js";
import { assertBreakers, computeCostUsd, LoopBroke, normalizeUsage } from "./breakers.js";
import { createAssistantDeltaWriter } from "./assistant-delta.js";
import type { LoopEvent, LoopFinishReason } from "./events.js";

export interface LoopCtx {
  session: SessionHandle;
  model: ModelProtocol;
  modelCfg: ModelCfg;
  tools: ToolRegistry;
  budget: (messages: ModelChatMessage[]) => { over: boolean; tokens: number; softLimit: number };
  compactor?: (session: SessionHandle) => Promise<void>;
  meter?: TokenMeter;
  signal: AbortSignal;
  artifactDir: string;
  cwd?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  pricePerMillion?: PricePerMillion;
  permissionGate?: PermissionGate;
}

export interface LoopConfig extends BreakerLimits {}

interface InvalidJsonMarker {
  error: "invalid_json";
  raw: string;
}

type CallSlot = { marker: ToolResult } | { index: number };

type InterruptReason = Exclude<LoopFinishReason, "no_tool_calls">;

type ExitReason = "normal" | "consumer" | "error";

interface PendingBatch {
  assistantSeq: number;
  calls: CompletionResult["toolCalls"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 内部标记必须显式携带 invalidJson=true(由适配器解析失败分支生成);
// 仅凭 arguments 形状判断会把模型合法输出的同形参数误判为解析失败(D-038)。
function isInvalidJsonMarker(
  call: CompletionResult["toolCalls"][number],
): call is CompletionResult["toolCalls"][number] & {
  arguments: { error: "invalid_json"; raw: string };
} {
  return (
    call.invalidJson === true
    && isRecord(call.arguments)
    && call.arguments.error === "invalid_json"
    && typeof call.arguments.raw === "string"
  );
}

// 重复 tool call id 会让日志出现同 id 的两条 tool_result，回放投影时必抛错，
// 整份会话从此不可回放。必须在落日志前拒绝，保证"日志是唯一事实源"仍可投影。
function assertUniqueToolCallIds(toolCalls: CompletionResult["toolCalls"]): void {
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (seen.has(call.id)) {
      throw new TypeError(`duplicate tool call id: ${call.id}`);
    }
    seen.add(call.id);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

const MAX_INVALID_JSON_RAW_CHARS = 8_000;

// 坏参数原文来自模型输出,必须限长;否则一次超长坏参数会放大日志与下一轮上下文(D-028)。
function capInvalidJsonRaw(raw: string): string {
  return raw.length > MAX_INVALID_JSON_RAW_CHARS
    ? `${raw.slice(0, MAX_INVALID_JSON_RAW_CHARS)}[truncated]`
    : raw;
}

function markerResult(raw: string): ToolResult {
  const capped = capInvalidJsonRaw(raw);
  return {
    isError: true,
    code: "invalid_json",
    message: "tool arguments are not valid JSON",
    detail: { raw: capped },
    text: `tool arguments are not valid JSON: ${capped}`,
  };
}

function abortedToolResult(): ToolResult {
  return {
    isError: true,
    code: "tool_aborted",
    message: "tool aborted before execution",
    text: "tool aborted before execution",
  };
}

function lostToolResult(): ToolResult {
  return {
    isError: true,
    code: "tool_result_lost",
    message: "tool result not recorded due to error",
    text: "tool result not recorded due to error",
  };
}

/**
 * 这次请求实际携带的消息有多少 token、被什么占着。
 *
 * 必须在**发请求之前**量,量的是 `messages` 本身——不要在 `usage` 事件落盘时
 * 重新 `buildMessages(session.events())`:那一刻 assistant 事件已写入、对应的
 * `tool_result` 还没写,投影层会以「工具批次未闭合」拒绝投影,整段被 catch 吞掉,
 * 于是**每一条带工具调用的回合都没有占用率**(D-195)。而这种回合正是本仓库的
 * 常态:这个数字在最该出现的时候从不出现,比不显示更糟——它看起来像没测量。
 *
 * 崩溃时返回 `undefined` 而不是零:占用率是显示数据,量不出来就不报,
 * 绝不能因此让这一轮失败,也不能用一个 0 冒充「上下文是空的」。
 */
function measureRequestContext(
  messages: ModelChatMessage[],
  ctx: LoopCtx,
): { tokens: number; percent: number; window: number; softLimit: number } | undefined {
  try {
    const measured = ctx.budget(messages);
    const window = resolveContextWindow(ctx.modelCfg);
    // 零测量不是「空上下文」,是量不出来——报出去会画成一个 0% 的窗口。
    if (!(measured.tokens > 0) || !(window > 0)) return undefined;
    return {
      tokens: measured.tokens,
      // 一位小数让细小的变化可见;界面四舍五入显示,但事件里是事实本身。
      percent: Math.min(100, Math.round((measured.tokens / window) * 1000) / 10),
      window,
      softLimit: measured.softLimit,
    };
  } catch {
    return undefined;
  }
}


function splitToolUses(toolCalls: CompletionResult["toolCalls"]): {
  calls: BatchCall[];
  slots: CallSlot[];
} {
  const calls: BatchCall[] = [];
  const slots: CallSlot[] = toolCalls.map((call) => {
    if (isInvalidJsonMarker(call)) {
      return { marker: markerResult(call.arguments.raw) };
    }
    calls.push({ id: call.id, name: call.name, input: call.arguments });
    return { index: calls.length - 1 };
  });
  return { calls, slots };
}

function toResultPayload(
  id: string,
  toolName: string,
  result: ToolResult,
): Record<string, unknown> {
  const payload: ToolResultPayload = {
    id,
    ok: !result.isError,
    text: result.text,
    code: result.code,
    toolName,
  };
  if (result.artifactPath !== undefined) payload.artifactPath = result.artifactPath;
  if (result.detail !== undefined) payload.detail = result.detail;
  if (result.evidence !== undefined) payload.evidence = result.evidence;
  return { ...payload };
}

function toLoopToolResult(
  id: string,
  result: ToolResult,
): Extract<LoopEvent, { kind: "tool_result" }> {
  const event: Extract<LoopEvent, { kind: "tool_result" }> = {
    kind: "tool_result",
    id,
    ok: !result.isError,
    text: result.text,
    code: result.code,
  };
  if (result.artifactPath !== undefined) event.artifactPath = result.artifactPath;
  if (result.detail !== undefined) event.detail = result.detail;
  return event;
}

async function* emitInterrupted(
  session: SessionHandle,
  reason: InterruptReason,
): AsyncGenerator<LoopEvent> {
  await session.append({ type: "interrupted", payload: { reason } });
  yield { kind: "interrupted", reason };
  yield { kind: "done", finishReason: reason };
}

// checkpoint.turn 必须在会话内单调递增;resume 后从最后一条 checkpoint 续编,
// 否则同一目录会出现重复 turn,未来按 turn 定位断点会歧义(D-045)。
function lastCheckpointTurn(session: SessionHandle): number {
  const events = session.events();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "checkpoint") continue;
    const turn = event.payload.turn;
    if (typeof turn === "number" && Number.isFinite(turn) && turn >= 0) {
      return turn;
    }
  }
  return 0;
}

export async function* query(
  ctx: LoopCtx,
  input: string,
  cfg: LoopConfig,
): AsyncGenerator<LoopEvent> {
  const { session } = ctx;
  const initialEvents = session.events();
  if (
    ctx.systemPrompt !== undefined &&
    !initialEvents.some((event) => event.type === "system")
  ) {
    if (initialEvents.length > 0) {
      throw new Error(
        "ctx.systemPrompt cannot be inserted into a non-empty session without a system event",
      );
    }
    await session.append({ type: "system", payload: { content: ctx.systemPrompt } });
  }
  await session.append({ type: "user", payload: { content: input } });


  const costTracked = ctx.pricePerMillion !== undefined;
  // `turn` 与 `runTurn` 是两件事，曾经被合并成一个变量：
  //
  // - `turn` 是会话级检查点序号，跨消息单调递增（D-045：同一目录出现重复 turn
  //   会让「按 turn 定位断点」产生歧义）。
  // - `runTurn` 是**本次运行**已经发起的模型调用数，`maxTurns` 只对它生效——
  //   设置项写的是「每条消息的轮数上限 / Turns per message」。
  //
  // 合并的后果：一次会话累计用满当时的默认上限（10）轮之后，**之后每条消息**
  // 都在调用模型**之前**就被熔断，界面显示「达到最大回合数」而模型一次都没被调用，
  // 会话从此不可用。用户实测遇到的就是这个（D-183）。默认上限现已整体移除：
  // `maxTurns` 缺省表示不检查轮数，只有显式配置正整数才有上限。
  //
  // `costUsd` 保持会话累计，并**有意**计入历史 usage：它的设置项描述是总预算，
  // 越过上限就该停，这是 2026-10-18 起就有测试锁定的行为（「历史 usage 计入
  // maxCostUsd,首轮前即熔断」）。它与 `maxTurns` 的区别不是疏漏：轮数上限按
  // 标签说的是「每条消息」，预算是「整段会话」。
  let turn = lastCheckpointTurn(session);
  let runTurn = 0;
  let costUsd = computeCostUsd(session.usageTotals(), ctx.pricePerMillion);
  let pending: PendingBatch | undefined;
  let exitReason: ExitReason | undefined;

  const removePending = (id: string): void => {
    if (pending === undefined) return;
    const calls = pending.calls.filter((call) => call.id !== id);
    pending = calls.length === 0
      ? undefined
      : { assistantSeq: pending.assistantSeq, calls };
  };

  // 第一阶段:先让所有 tool_result 落盘,并立即把对应 call 移出 pending 账本。
  // 第二阶段再写状态事件;即使状态写入失败,pending 已空,不会把已执行的真实结果
  // 误补成 tool_result_lost。
  const appendToolResult = async (
    call: CompletionResult["toolCalls"][number],
    result: ToolResult,
    parent: number,
  ): Promise<void> => {
    await session.append({
      type: "tool_result",
      payload: toResultPayload(call.id, call.name, result),
      parent,
    });
    removePending(call.id);
  };

  const appendDeviceStatus = async (
    call: CompletionResult["toolCalls"][number],
    result: ToolResult,
    parent: number,
  ): Promise<void> => {
    if (result.isError) return;
    if (result.deviceStatus !== undefined) {
      await session.append({
        type: "device_status",
        payload: {
          callId: call.id,
          server: result.deviceStatus.server,
          tool: call.name,
          state: result.deviceStatus.state,
        },
        parent,
      });
      return;
    }
    if (result.deviceStatusInvalid !== undefined) {
      await session.append({
        type: "status",
        payload: {
          status: "device_status_invalid",
          tool: call.name,
          message: result.deviceStatusInvalid,
        },
        parent,
      });
    }
  };

  // 与 appendDeviceStatus 同一约定:第一阶段先让真实结果落盘,第二阶段再写状态事件。
  // 失败的工具没有计划成立,所以 isError 时不写;没有 todos 字段时也不写。
  const appendTodos = async (
    call: CompletionResult["toolCalls"][number],
    result: ToolResult,
    parent: number,
  ): Promise<void> => {
    if (result.isError) return;
    if (result.todos === undefined) return;
    const payload: TodosPayload = { callId: call.id, items: result.todos };
    await session.append({ type: "todos", payload: { ...payload }, parent });
  };

  try {
    while (true) {
      turn += 1;
      runTurn += 1;
      if (ctx.signal.aborted) {
        exitReason = "normal";
        yield* emitInterrupted(session, "aborted");
        return;
      }

      try {
        assertBreakers(cfg, runTurn, costUsd, costTracked);
      } catch (error) {
        if (error instanceof LoopBroke) {
          exitReason = "normal";
          yield* emitInterrupted(session, error.reason);
          return;
        }
        throw error;
      }

      await session.append({ type: "checkpoint", payload: { turn } });

      let messages = buildMessages(session.events());
      const budget = ctx.budget(messages);
      if (budget.over && ctx.compactor !== undefined) {
        try {
          await ctx.compactor(session);
        } catch (error) {
          if (isAbortError(error) || ctx.signal.aborted) {
            exitReason = "normal";
            yield* emitInterrupted(session, "aborted");
            return;
          }
          throw error;
        }
        yield { kind: "compacted" };
        messages = buildMessages(session.events());
        costUsd = computeCostUsd(session.usageTotals(), ctx.pricePerMillion);
      }

      // 量在发请求之前:这一刻 `messages` 还是闭合的日志投影,能算占用率与分类;
      // 等 `usage` 事件落盘时,assistant 已写、tool_result 未写,再投影必然抛错
      // (D-195)。量的是即将送出去的那份消息,也就是这个数字真正含义所在。
      const requestContext = measureRequestContext(messages, ctx);

      let response: CompletionResult;
      const toolSchemas = toModelToolSchemas(ctx.tools.all());
      // 增量文本先落盘再被投影：会话日志是唯一事实源，实时事件不允许绕过它。
      // 完整内容仍由随后的 `assistant` 事件承载，所以写失败不终止这一轮。
      const deltaWriter = createAssistantDeltaWriter({
        session,
        onError: () => {
          // 增量丢失只影响流式显示，完整内容仍在 assistant 事件里。
        },
      });
      try {
        response = await ctx.model.complete(messages, toolSchemas, {
          signal: ctx.signal,
          maxOutputTokens: resolveMaxOutput(ctx.modelCfg),
          onDelta: (text) => deltaWriter.push(text),
        });
      } catch (error) {
        await deltaWriter.flush();
        if (isAbortError(error) || ctx.signal.aborted) {
          exitReason = "normal";
          yield* emitInterrupted(session, "aborted");
          return;
        }
        throw error;
      }
      await deltaWriter.flush();

      assertUniqueToolCallIds(response.toolCalls);
      const assistantEvent = await session.append({
        type: "assistant",
        payload: { content: response.content, toolCalls: response.toolCalls },
      });
      if (response.toolCalls.length > 0) {
        pending = { assistantSeq: assistantEvent.seq, calls: response.toolCalls.slice() };
      }

      if (response.usage !== undefined) {
        const usage = response.usage;
        const normalized = normalizeUsage(usage);
        const payload: Record<string, unknown> = {
          promptTokens: normalized.promptTokens,
          completionTokens: normalized.completionTokens,
        };
        if (normalized.cachedTokens !== undefined) {
          payload.cachedTokens = normalized.cachedTokens;
        }
        // 占用率是**这次请求**携带的消息量：`requestContext` 在发请求之前就量好了,
        // 那时 `messages` 是闭合的、可投影的。不要在这里重新投影日志(D-195)。
        // 没有它,界面只能显示花费,永远看不到窗口有多满(D-165)。
        if (requestContext !== undefined) {
          payload.context = {
            tokens: requestContext.tokens,
            percent: requestContext.percent,
            window: requestContext.window,
          };
          // 分段条回答「这些 token 被什么占的」,与 `context.tokens` 是同一个
          // 实测值的两种说法(D-191)。meter 先取到局部常量再进闭包:`ctx.meter`
          // 是可选字段,直接在闭包里用会让 TS 无法窄化。
          const meter = ctx.meter;
          try {
            payload.contextBreakdown = buildContextBreakdown(messages, {
              window: requestContext.window,
              used: requestContext.tokens,
              compactAt: requestContext.softLimit,
              ...(meter === undefined ? {} : { measure: (list) => meter.measure(list) }),
            });
          } catch {
            // 分类拆分坏了不影响总量:总量已经测到,分段是它的细化。
            delete payload.contextBreakdown;
          }
        }
        if (normalized.cachedTokensRaw !== undefined) {
          payload.cachedTokensRaw = normalized.cachedTokensRaw;
        }
        costUsd += computeCostUsd(usage, ctx.pricePerMillion);
        // `computeCostUsd` returns 0 when no price is configured, and zero
        // dollars is a different claim from "no price known". The field only
        // travels when the provider actually carries a price.
        if (ctx.pricePerMillion !== undefined) payload.costUsd = costUsd;
        await session.append({ type: "usage", payload });
        ctx.meter?.observe(normalized.promptTokens, messages);
      } else {
        await session.append({ type: "status", payload: { status: "usage_missing" } });
      }

      yield { kind: "model_message", content: response.content };
      for (const call of response.toolCalls) {
        yield { kind: "tool_use", id: call.id, name: call.name, input: call.arguments };
      }

      if (ctx.signal.aborted) {
        for (const call of response.toolCalls) {
          const result = abortedToolResult();
          await appendToolResult(call, result, assistantEvent.seq);
          yield toLoopToolResult(call.id, result);
        }
        pending = undefined;
        exitReason = "normal";
        yield* emitInterrupted(session, "aborted");
        return;
      }

      if (response.toolCalls.length === 0) {
        if (response.truncatedByMaxTokens) continue;
        await session.append({
          type: "status",
          payload: { status: "done", finishReason: "no_tool_calls" },
        });
        exitReason = "normal";
        yield { kind: "done", finishReason: "no_tool_calls" };
        return;
      }

      const split = splitToolUses(response.toolCalls);
      const batchOptions: BatchOptions = {
        signal: ctx.signal,
        artifactDir: ctx.artifactDir,
        ...(ctx.cwd === undefined ? {} : { cwd: ctx.cwd }),
        ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
        // 由 pipeline 在每个调用真正执行前调用;写失败会让该调用不执行。
        onToolStarted: async (call, access) => {
          const payload: ToolStartedPayload = {
            callId: call.id,
            tool: call.name,
            access,
          };
          // 工具行上的「只读 / 会破坏 / 证据」标记来自工具自己的注解。
          // 只写为 true 的键:缺省是「未知」,与 false 的「确认不是只读」不是一回事,
          // 把 false 也写进去会让 UI 把未知当成否定。工具可能根本不存在(模型编造的
          // 名字),此时 lookup 返回 undefined,整个字段不写。
          const annotations = ctx.tools.lookup(call.name)?.annotations;
          if (annotations !== undefined) {
            const marks: NonNullable<ToolStartedPayload["annotations"]> = {};
            if (annotations.readOnly === true) marks.readOnly = true;
            if (annotations.destructive === true) marks.destructive = true;
            if (annotations.evidence === true) marks.evidence = true;
            if (Object.keys(marks).length > 0) payload.annotations = marks;
          }
          await session.append({
            type: "tool_started",
            payload: { ...payload },
            parent: assistantEvent.seq,
          });
        },
      };
      if (ctx.permissionGate !== undefined) {
        const gate = ctx.permissionGate;
        batchOptions.permission = {
          gate,
          onDecision: async (call, decision) => {
            const payload: PermissionDecisionPayload = {
              requestId: decision.requestId,
              callId: decision.callId,
              tool: decision.tool,
              action: decision.action,
              effective: decision.effective,
              reason: decision.reason,
              preset: decision.preset,
              source: decision.source,
              ...(decision.ruleIndex === undefined ? {} : { ruleIndex: decision.ruleIndex }),
              paramsDigest: decision.paramsDigest,
              paramsKeys: decision.paramsKeys,
              ...(decision.paramsPreview === undefined
                ? {}
                : { paramsPreview: decision.paramsPreview }),
              access: decision.access,
            };
            await session.append({
              type: "permission_decision",
              payload: { ...payload },
              parent: assistantEvent.seq,
            });
          },
        };
      }
      const batchResults: BatchResult[] =
        split.calls.length === 0
          ? []
          : await executeBatch(session, ctx.tools, split.calls, batchOptions);

      const outcomes: Array<{
        call: CompletionResult["toolCalls"][number];
        result: ToolResult;
      }> = [];
      for (let index = 0; index < response.toolCalls.length; index += 1) {
        const call = response.toolCalls[index];
        const slot = split.slots[index];
        const result = "marker" in slot ? slot.marker : batchResults[slot.index].result;
        await appendToolResult(call, result, assistantEvent.seq);
        outcomes.push({ call, result });
        yield toLoopToolResult(call.id, result);
      }
      for (const outcome of outcomes) {
        await appendDeviceStatus(outcome.call, outcome.result, assistantEvent.seq);
        await appendTodos(outcome.call, outcome.result, assistantEvent.seq);
      }
      pending = undefined;

      if (response.truncatedByMaxTokens) continue;
    }
  } catch (error) {
    exitReason = "error";
    if (pending !== undefined) {
      const pendingCalls = pending.calls.slice();
      const parent = pending.assistantSeq;
      for (const call of pendingCalls) {
        try {
          await appendToolResult(call, lostToolResult(), parent);
        } catch {}
      }
      pending = undefined;
    }
    try {
      await session.append({ type: "interrupted", payload: { reason: "error" } });
    } catch {}
    throw error;
  } finally {
    if (exitReason === undefined) {
      if (pending !== undefined) {
        const pendingCalls = pending.calls.slice();
        const parent = pending.assistantSeq;
        for (const call of pendingCalls) {
          try {
            await appendToolResult(call, abortedToolResult(), parent);
          } catch {}
        }
        pending = undefined;
      }
      try {
        await session.append({ type: "interrupted", payload: { reason: "consumer_closed" } });
      } catch {}
    }
  }
}
