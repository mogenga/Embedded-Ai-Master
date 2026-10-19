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
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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

  constructor(readonly status: number, readonly bodyPreview: string) {
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

function resolveChatCompletionsUrl(baseUrl: string): string {
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

async function readJsonBody(
  response: Response,
  maxBytes: number,
): Promise<Record<string, any>> {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new ModelResponseError(`Model API response exceeds ${maxBytes} bytes`);
    }
  }
  const body = response.body;
  let text: string;
  if (body === null || body === undefined) {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ModelResponseError(`Model API response exceeds ${maxBytes} bytes`);
    }
  } else {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
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
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch (error) {
    throw new ModelResponseError("Model API returned invalid JSON", error);
  }
}

export function createOpenAIProvider(cfg: OpenAIProviderCfg): ModelProtocol {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const chatCompletionsUrl = resolveChatCompletionsUrl(cfg.baseUrl);
  const retryConfig: RetryConfig = {
    maxRetries: cfg.retry?.maxRetries ?? 5,
    baseDelayMs: cfg.retry?.baseDelayMs ?? 1000,
    sleep: cfg.retry?.sleep,
    rand: cfg.retry?.rand,
    isRetryable: (err) =>
      err instanceof RetryableHttpError
      || err instanceof NetworkError
      || err instanceof RequestTimeoutError,
  };
  const requestTimeoutMs = cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = cfg.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    async complete(messages: ModelChatMessage[], tools: ModelToolSchema[], opts): Promise<CompletionResult> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const requestBody: Record<string, unknown> = {
        model: cfg.model,
        messages,
        max_tokens: opts.maxOutputTokens,
        stream: false,
      };
      if (tools !== undefined) requestBody.tools = tools;

      let isFirstAttempt = true;
      const data = await retry(async () => {
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
            return await readJsonBody(response, maxResponseBytes);
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
      const rawToolCalls = message?.tool_calls;
      if (rawToolCalls !== undefined && rawToolCalls !== null && !Array.isArray(rawToolCalls)) {
        throw new ModelResponseError("Model API returned malformed tool_calls");
      }
      const toolCalls = (rawToolCalls ?? []).map((call: any) => {
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
      if (content) opts.onDelta?.(content);
      const usage = data.usage;
      // 网关可能把 usage 数字序列化成字符串;能收窄成有限数就接受,
      // 否则整体省略,由 load 侧的 usage_missing 状态显式披露(D-014)。
      const promptTokens = toFiniteNumber(usage?.prompt_tokens);
      const completionTokens = toFiniteNumber(usage?.completion_tokens);
      const hasCompleteUsage = promptTokens !== undefined && completionTokens !== undefined;
      const cachedTokens = toFiniteNumber(usage?.prompt_tokens_details?.cached_tokens);

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
