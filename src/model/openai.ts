import { isReasoningEffort } from "../config/providers.js";
import type { ReasoningEffort } from "../config/providers.js";
import { heuristicCountTokens } from "./count.js";
import type { CompletionResult, ModelChatMessage, ModelProtocol, ModelToolSchema } from "./protocol.js";
import { retry, type RetryConfig } from "./retry.js";

export interface OpenAIProviderCfg {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  retry?: Partial<Omit<RetryConfig, "isRetryable">>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * 是否请求流式响应。默认 true：网关不支持时自动降级为一次性响应，
   * 并记住该网关的结果，不在后续每次请求上重复试探。
   */
  stream?: boolean;
  /**
   * 这一次请求要发的 `reasoning_effort`。
   *
   * **缺省即不发送**，不是「发服务商默认值」：字段缺席与显式 `"none"` 在不同
   * 网关上含义不同，凭一个内核默认值替用户做选择，会悄悄改变既有用户的每一次
   * 请求。调用方（`runSession`）已经用 `resolveReasoningEffort` 合并了单次覆盖
   * 与模型配置；这一层只负责把拿到的值原样放上线。
   */
  reasoningEffort?: ReasoningEffort;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** 单个 SSE 行（一条 data: 帧）的上限，防止网关不发换行把内存吃光。 */
const MAX_SSE_LINE_CHARS = 1024 * 1024;

export class ModelFatalError extends Error {
  readonly code = "api_4xx";
  readonly status: number;
  readonly bodyPreview: string;

  constructor(status: number, bodyPreview: string) {
    super(`Model API request failed with status ${status}`);
    this.name = "ModelFatalError";
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

export class RetryableHttpError extends Error {
  readonly code = "retryable_http";

  constructor(readonly status: number, readonly bodyPreview: string) {
    super(`Model API request failed with status ${status}`);
    this.name = "RetryableHttpError";
  }
}

export class UnexpectedHttpError extends Error {
  readonly code = "unexpected_status";
  readonly bodyPreview: string;

  constructor(readonly status: number, bodyPreview: string) {
    super(`Model API request failed with status ${status}`);
    this.name = "UnexpectedHttpError";
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

export class NetworkError extends Error {
  readonly code = "network";

  constructor(cause: unknown) {
    super("Model API network request failed", { cause });
    this.name = "NetworkError";
  }
}

export class ModelResponseError extends Error {
  readonly code = "invalid_response";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ModelResponseError";
  }
}

export class RequestTimeoutError extends Error {
  readonly code = "request_timeout";

  constructor(timeoutMs: number) {
    super(`Model API request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * 网关拒绝了流式请求。
 *
 * 这不是模型端的错误，而是端点能力问题：降级为一次性响应后重试即可，
 * 因此单独成一类，避免被当成不可重试的 4xx 直接终止本轮。
 */
export class StreamUnsupportedError extends Error {
  readonly code = "stream_unsupported";

  constructor(readonly status: number) {
    super(`Model API rejected a streaming request with status ${status}`);
    this.name = "StreamUnsupportedError";
  }
}

function isCancellationError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * 校验 provider 的 baseUrl，返回解析后的 URL。
 *
 * 导出是为了让「测试连接」探测（`model/probe.ts`）复用同一套规则：
 * 探测和真正发请求时必须接受/拒绝同样的地址，否则用户会看到
 * 「测试通过但发消息失败」这种自相矛盾的结论。改这里的规则会同时
 * 改变两处行为，这是有意的。
 */
export function parseProviderBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`baseUrl must use http or https; got ${url.protocol}`);
  }
  if (url.search || url.hash) {
    throw new TypeError("baseUrl must not contain a query or hash");
  }
  return url;
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const url = parseProviderBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url.toString();
}

async function readBodyPreview(response: Response, maxBytes = 512): Promise<string> {
  const body = response.body;
  if (body === null || body === undefined) {
    return (await response.text()).slice(0, maxBytes);
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const take = Math.min(value.byteLength, maxBytes - total);
      chunks.push(Buffer.from(value.subarray(0, take)));
      total += take;
      if (take < value.byteLength || total >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, maxBytes);
}

/**
 * 把网关返回的 tool_calls 归一成 `CompletionResult` 的形状。
 *
 * 一次性响应与流式响应用同一套规则：参数不是合法 JSON 对象时保留原文
 * 并打上 `invalid_json` 标记，由上层决定怎么处理（R3：不静默吞掉）。
 */
function parseToolCalls(rawToolCalls: unknown): CompletionResult["toolCalls"] {
  if (rawToolCalls !== undefined && rawToolCalls !== null && !Array.isArray(rawToolCalls)) {
    throw new ModelResponseError("Model API returned malformed tool_calls");
  }
  return (rawToolCalls ?? []).map((call: any) => {
    if (typeof call?.id !== "string" || typeof call?.function?.name !== "string") {
      throw new ModelResponseError("Model API returned a malformed tool call");
    }
    // OpenAI wire 契约只接受 type=function;缺失视为兼容旧网关,
    // 其他取值说明网关在发非 function 调用,继续执行会伪造工具语义(D-037)。
    if (call.type !== undefined && call.type !== "function") {
      throw new ModelResponseError("Model API returned a non-function tool call type");
    }
    if (
      call.function === null
      || typeof call.function !== "object"
      || Array.isArray(call.function)
    ) {
      throw new ModelResponseError("Model API returned a malformed tool call");
    }
    const raw = call.function?.arguments;
    let args: Record<string, unknown> | { error: "invalid_json"; raw: string };
    let invalidJson = true;
    if (typeof raw !== "string") {
      args = { error: "invalid_json", raw: String(raw) };
    } else {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
          invalidJson = false;
        } else {
          args = { error: "invalid_json", raw };
        }
      } catch {
        args = { error: "invalid_json", raw };
      }
    }
    return invalidJson
      ? { id: call.id, name: call.function.name, arguments: args, invalidJson: true }
      : { id: call.id, name: call.function.name, arguments: args };
  });
}

function parseJsonText(text: string): Record<string, any> {
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch (error) {
    throw new ModelResponseError("Model API returned invalid JSON", error);
  }
}

function normalizeUsage(usage: unknown): {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
} {
  const record = typeof usage === "object" && usage !== null ? (usage as Record<string, any>) : {};
  const promptTokens = toFiniteNumber(record.prompt_tokens);
  const completionTokens = toFiniteNumber(record.completion_tokens);
  const cachedTokens = toFiniteNumber(record.prompt_tokens_details?.cached_tokens);
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  };
}

interface SseToolCall {
  id: string;
  name: string;
  args: string;
}

interface SseState {
  content: string;
  toolCalls: Map<number, SseToolCall>;
  finishReason: unknown;
  usage: unknown;
}

function createSseState(): SseState {
  return { content: "", toolCalls: new Map(), finishReason: undefined, usage: undefined };
}

/**
 * 处理一条 SSE 帧。
 *
 * 帧格式（OpenAI chat completions 流式）：
 *   data: {"choices":[{"delta":{"content":"…"},"finish_reason":null}],"usage":null}
 *   data: [DONE]
 */
function applySseFrame(payload: unknown, state: SseState, onDelta: ((text: string) => void) | undefined): void {
  if (typeof payload !== "object" || payload === null) {
    throw new ModelResponseError("Model API returned a malformed stream frame");
  }
  const record = payload as Record<string, any>;
  if (record.usage !== undefined && record.usage !== null) state.usage = record.usage;
  if (!Array.isArray(record.choices)) {
    // usage 帧的 choices 是空数组；缺少 choices 的帧不是合法形状。
    if (record.usage !== undefined) return;
    throw new ModelResponseError("Model API returned a malformed stream frame");
  }
  for (const choice of record.choices) {
    if (choice === null || typeof choice !== "object") {
      throw new ModelResponseError("Model API returned a malformed stream frame");
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      state.finishReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (delta === undefined || delta === null) continue;
    if (typeof delta !== "object" || Array.isArray(delta)) {
      throw new ModelResponseError("Model API returned a malformed stream delta");
    }
    if (typeof delta.content === "string" && delta.content !== "") {
      state.content += delta.content;
      onDelta?.(delta.content);
    }
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      if (!Array.isArray(delta.tool_calls)) {
        throw new ModelResponseError("Model API returned malformed tool_calls");
      }
      for (const call of delta.tool_calls) {
        if (call === null || typeof call !== "object") {
          throw new ModelResponseError("Model API returned a malformed tool call");
        }
        const index = typeof call.index === "number" ? call.index : 0;
        const acc = state.toolCalls.get(index) ?? { id: "", name: "", args: "" };
        if (typeof call.id === "string" && call.id !== "") acc.id = call.id;
        if (typeof call.function?.name === "string" && call.function.name !== "") {
          acc.name = call.function.name;
        }
        if (typeof call.function?.arguments === "string") acc.args += call.function.arguments;
        state.toolCalls.set(index, acc);
      }
    }
  }
}

function applySseLine(line: string, state: SseState, onDelta: ((text: string) => void) | undefined): void {
  const trimmed = line.trim();
  if (trimmed === "") return;
  // 注释行（": ping"）与 event:/id: 行不是数据帧，忽略。
  if (!trimmed.startsWith("data:")) return;
  const data = trimmed.slice("data:".length).trim();
  if (data === "[DONE]") return;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    throw new ModelResponseError("Model API returned a malformed stream frame", error);
  }
  applySseFrame(payload, state, onDelta);
}

function sseStateToResult(state: SseState): CompletionResult {
  const calls = [...state.toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, call]) => ({
      // 还原成 OpenAI wire 形状，交给同一套解析规则：流式与一次性响应对
      // 参数的处理必须一致（同样的 invalid_json 标记与截断）。
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.args },
    }));
  const usage = normalizeUsage(state.usage);
  const hasCompleteUsage = usage.promptTokens !== undefined && usage.completionTokens !== undefined;
  return {
    content: state.content,
    toolCalls: parseToolCalls(calls),
    truncatedByMaxTokens: state.finishReason === "length",
    ...(hasCompleteUsage
      ? {
          usage: {
            promptTokens: usage.promptTokens as number,
            completionTokens: usage.completionTokens as number,
            ...(usage.cachedTokens === undefined ? {} : { cachedTokens: usage.cachedTokens }),
          },
        }
      : {}),
    stopReason: state.finishReason,
  };
}

/**
 * 首几行是否像 SSE 数据帧（决定这次响应按流式还是按一次性解析）。
 *
 * 兼容网关可能漏发 `Content-Type`，所以也要看内容：SSE 帧以 `data:` 开头，
 * 而 JSON 响应第一行是 `{`。多行扫描是为了容忍开头的注释行（`: ping`）与
 * `event:` 行。
 */
function looksLikeEventStream(buffer: string): boolean {
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith(":")) continue;
    return trimmed.startsWith("data:") || trimmed.startsWith("event:");
  }
  return false;
}

function isEventStreamContentType(response: Response): boolean {
  const contentType = response.headers?.get?.("content-type");
  return typeof contentType === "string"
    && contentType.toLowerCase().includes("text/event-stream");
}

type AttemptResult =
  | { kind: "json"; data: Record<string, any> }
  | { kind: "sse"; result: CompletionResult };

/**
 * 读一次响应，按内容形态分派到一次性或流式解析。
 *
 * 形态由 `Content-Type` 与首行内容共同决定：网关声明了 event-stream 就按流式
 * 读；没有声明但首行是 `data:` 也按流式读（部分兼容网关漏发响应头）；两者
 * 都不是就按一次性 JSON 读。
 */
async function readCompletionBody(
  response: Response,
  maxBytes: number,
  onDelta: ((text: string) => void) | undefined,
): Promise<AttemptResult> {
  const body = response.body;
  const state = createSseState();

  if (body === null || body === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ModelResponseError(`Model API response exceeds ${maxBytes} bytes`);
    }
    if (isEventStreamContentType(response) || looksLikeEventStream(text)) {
      for (const line of text.split("\n")) applySseLine(line, state, onDelta);
      return { kind: "sse", result: sseStateToResult(state) };
    }
    return { kind: "json", data: parseJsonText(text) };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let total = 0;
  // 形态有三种：未定 / SSE / JSON。`Content-Type` 能直接定；漏发响应头的
  // 兼容网关靠首行内容定。原始字节始终保留，JSON 路径要用它拼回完整响应体。
  let mode: "undecided" | "sse" | "json" = isEventStreamContentType(response)
    ? "sse"
    : "undecided";
  const rawChunks: Buffer[] = [];

  const processSseBuffer = (): void => {
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      applySseLine(line, state, onDelta);
    }
    if (buffer.length > MAX_SSE_LINE_CHARS) {
      throw new ModelResponseError("Model API stream frame exceeds the line limit");
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ModelResponseError(`Model API response exceeds ${maxBytes} bytes`);
      }
      rawChunks.push(Buffer.from(value));
      if (mode === "sse") {
        buffer += decoder.decode(value, { stream: true });
        processSseBuffer();
        continue;
      }
      if (mode === "json") continue;
      // 形态未定：先攒到能看出首行，再决定按哪种协议解析。
      buffer += decoder.decode(value, { stream: true });
      if (looksLikeEventStream(buffer)) {
        mode = "sse";
        processSseBuffer();
        continue;
      }
      // 首行结束但不是 SSE：这是 JSON 响应，之后的字节原样累积即可。
      if (buffer.includes("\n")) mode = "json";
    }
  } finally {
    reader.releaseLock();
  }

  if (mode === "sse") {
    const tail = decoder.decode();
    if (tail !== "") buffer += tail;
    processSseBuffer();
    if (buffer.trim() !== "") applySseLine(buffer, state, onDelta);
    return { kind: "sse", result: sseStateToResult(state) };
  }

  const text = Buffer.concat(rawChunks).toString("utf8");
  return { kind: "json", data: parseJsonText(text) };
}

/**
 * 网关用这些状态码表示"不接受 stream 参数"。
 *
 * 只有 400/404/405/415/422 会被当作"不支持流式"：它们同时是参数校验类的
 * 状态码。429/5xx 是暂时性的，重试后可能就支持了，不该降级。
 */
function isStreamUnsupportedStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 405 || status === 415 || status === 422;
}

export function createOpenAIProvider(cfg: OpenAIProviderCfg): ModelProtocol {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const chatCompletionsUrl = resolveChatCompletionsUrl(cfg.baseUrl);
  const requestTimeoutMs = cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = cfg.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // 在构造期校验，而不是发请求时才带上：一个内核不认识的等级发出去，只会在
  // 某个网关上换回 400（甚至被静默忽略而界面显示「已生效」）。这里就拒绝，
  // 错误立刻落在调用栈上，且不会产生任何出站请求。
  if (cfg.reasoningEffort !== undefined && !isReasoningEffort(cfg.reasoningEffort)) {
    throw new TypeError(
      `reasoningEffort 非法: ${JSON.stringify(cfg.reasoningEffort)}`,
    );
  }
  // 降级是 provider 实例的状态而不是全局的：provider 每轮会话都会重建，
  // 全局缓存会让一个网关的结论污染另一个（并发跑不同 baseUrl 的测试就会串）。
  // 实例内的记忆已经足够——同一个 provider 连续几轮不会反复试探。
  let streamEnabled = cfg.stream !== false;

  return {
    async complete(messages: ModelChatMessage[], tools: ModelToolSchema[], opts): Promise<CompletionResult> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      // 已经把增量文本交给上层之后不能再重试：重试会把同一段文字再送一遍。
      let deliveredText = false;
      const onDelta = (text: string): void => {
        deliveredText = true;
        opts.onDelta?.(text);
      };
      const retryConfig: RetryConfig = {
        maxRetries: cfg.retry?.maxRetries ?? 5,
        baseDelayMs: cfg.retry?.baseDelayMs ?? 1000,
        sleep: cfg.retry?.sleep,
        rand: cfg.retry?.rand,
        isRetryable: (err) =>
          !deliveredText
          && (
            err instanceof RetryableHttpError
            || err instanceof NetworkError
            || err instanceof RequestTimeoutError
          ),
      };

      const attempt = async (stream: boolean): Promise<AttemptResult> => {
        const requestBody: Record<string, unknown> = {
          model: cfg.model,
          messages,
          max_tokens: opts.maxOutputTokens,
          stream,
        };
        if (stream) requestBody.stream_options = { include_usage: true };
        if (tools !== undefined) requestBody.tools = tools;
        // 只在真的设置了等级时才带上这个字段。缺席 = 「不提要求」，显式
        // `"none"` = 「明确不要推理」，网关对两者的处理不同，所以这里既不能
        // 补默认值，也不能把 `"none"` 当成空值省掉。
        if (cfg.reasoningEffort !== undefined) {
          requestBody.reasoning_effort = cfg.reasoningEffort;
        }

        let isFirstAttempt = true;
        return await retry(async () => {
          // 第一次请求保留原始 AbortError(由 fetch 透传);重试前再检查一次,
          // 防止退避期间取消后仍发出新请求(D-010)。
          if (!isFirstAttempt && opts.signal.aborted) {
            throw new DOMException("The operation was aborted", "AbortError");
          }
          isFirstAttempt = false;
          const timeoutController = new AbortController();
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            timeoutController.abort();
          }, requestTimeoutMs);
          const signal = AbortSignal.any([opts.signal, timeoutController.signal]);
          try {
            let response: Response;
            try {
              response = await fetchImpl(chatCompletionsUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(requestBody),
                signal,
              });
            } catch (err) {
              if (timedOut) throw new RequestTimeoutError(requestTimeoutMs);
              if (isCancellationError(err) || opts.signal.aborted) throw err;
              throw new NetworkError(err);
            }
            if (!response.ok) {
              const bodyPreview = await readBodyPreview(response);
              if (timedOut) throw new RequestTimeoutError(requestTimeoutMs);
              if (stream && isStreamUnsupportedStatus(response.status)) {
                throw new StreamUnsupportedError(response.status);
              }
              // 408/409/425 属于暂时性冲突/超时,与 429/5xx 一样可重试(D-036)。
              if (
                (response.status >= 400 && response.status < 500)
                && response.status !== 429
                && response.status !== 408
                && response.status !== 409
                && response.status !== 425
              ) {
                throw new ModelFatalError(response.status, bodyPreview);
              }
              if (response.status === 429 || response.status >= 500) {
                throw new RetryableHttpError(response.status, bodyPreview);
              }
              if (
                response.status === 408
                || response.status === 409
                || response.status === 425
              ) {
                throw new RetryableHttpError(response.status, bodyPreview);
              }
              throw new UnexpectedHttpError(response.status, bodyPreview);
            }
            try {
              return await readCompletionBody(response, maxResponseBytes, onDelta);
            } catch (err) {
              if (timedOut) throw new RequestTimeoutError(requestTimeoutMs);
              if (isCancellationError(err) || opts.signal.aborted) throw err;
              throw err;
            }
          } catch (err) {
            if (timedOut) throw new RequestTimeoutError(requestTimeoutMs);
            throw err;
          } finally {
            clearTimeout(timer);
          }
        }, { ...retryConfig, signal: opts.signal });
      };

      let outcome: AttemptResult;
      try {
        outcome = await attempt(streamEnabled);
      } catch (error) {
        if (!(error instanceof StreamUnsupportedError)) throw error;
        // 网关不接受流式：本轮与该 provider 后续都直接用一次性响应。
        streamEnabled = false;
        outcome = await attempt(false);
      }

      if (outcome.kind === "sse") {
        return outcome.result;
      }

      const data = outcome.data;
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new ModelResponseError("Model API returned an invalid response shape");
      }
      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw new ModelResponseError("Model API returned no choices");
      }
      const choice = data.choices[0];
      if (choice === null || typeof choice !== "object" || Array.isArray(choice)) {
        throw new ModelResponseError("Model API returned an invalid choice");
      }
      const message = choice.message;
      if (
        message !== undefined
        && (message === null || typeof message !== "object" || Array.isArray(message))
      ) {
        throw new ModelResponseError("Model API returned an invalid message");
      }
      const toolCalls = parseToolCalls(message?.tool_calls);
      // content 为 null/缺失是合法的(纯 tool_calls 回复);其他非字符串类型是协议漂移,
      // 静默转空字符串会掩盖网关问题(R3 工具必须诚实)。
      if (
        message?.content !== undefined
        && message.content !== null
        && typeof message.content !== "string"
      ) {
        throw new ModelResponseError("Model API returned non-string message content");
      }
      const content = typeof message?.content === "string" ? message.content : "";
      if (content) onDelta(content);
      // 网关可能把 usage 数字序列化成字符串;能收窄成有限数就接受,
      // 否则整体省略,由 load 侧的 usage_missing 状态显式披露(D-014)。
      const promptTokens = toFiniteNumber(data.usage?.prompt_tokens);
      const completionTokens = toFiniteNumber(data.usage?.completion_tokens);
      const hasCompleteUsage = promptTokens !== undefined && completionTokens !== undefined;
      const cachedTokens = toFiniteNumber(data.usage?.prompt_tokens_details?.cached_tokens);

      return {
        content,
        toolCalls,
        truncatedByMaxTokens: choice?.finish_reason === "length",
        ...(hasCompleteUsage ? {
          usage: {
            promptTokens,
            completionTokens,
            ...(cachedTokens !== undefined ? { cachedTokens } : {}),
          },
        } : {}),
        stopReason: choice?.finish_reason,
      };
    },
    countTokens: heuristicCountTokens,
  };
}
