import { heuristicCountTokens } from "./count.js";
import type { CompletionResult, ModelChatMessage, ModelProtocol, ModelToolSchema } from "./protocol.js";
import { retry, type RetryConfig } from "./retry.js";

export interface OpenAIProviderCfg {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  retry?: Partial<RetryConfig>;
}

class ModelFatalError extends Error {
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

class RetryableHttpError extends Error {
  constructor(readonly status: number, readonly bodyPreview: string) {
    super(`Model API request failed with status ${status}`);
    this.name = "RetryableHttpError";
  }
}

class UnexpectedHttpError extends Error {
  constructor(readonly status: number, readonly bodyPreview: string) {
    super(`Model API request failed with status ${status}`);
    this.name = "UnexpectedHttpError";
  }
}

class NetworkError extends Error {
  constructor(cause: unknown) {
    super("Model API network request failed", { cause });
    this.name = "NetworkError";
  }
}

class ModelResponseError extends Error {
  readonly code = "invalid_response";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ModelResponseError";
  }
}

function isCancellationError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function createOpenAIProvider(cfg: OpenAIProviderCfg): ModelProtocol {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const retryConfig: RetryConfig = {
    maxRetries: cfg.retry?.maxRetries ?? 5,
    baseDelayMs: cfg.retry?.baseDelayMs ?? 1000,
    sleep: cfg.retry?.sleep,
    rand: cfg.retry?.rand,
    now: cfg.retry?.now,
    isRetryable: (err) => err instanceof RetryableHttpError || err instanceof NetworkError,
  };

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
        if (!isFirstAttempt && opts.signal.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        isFirstAttempt = false;
        let response: Response;
        try {
          response = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
            signal: opts.signal,
          });
        } catch (err) {
          if (isCancellationError(err) || opts.signal.aborted) throw err;
          throw new NetworkError(err);
        }
        if (!response.ok) {
          const bodyPreview = (await response.text()).slice(0, 512);
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new ModelFatalError(response.status, bodyPreview);
          }
          if (response.status === 429 || response.status >= 500) {
            throw new RetryableHttpError(response.status, bodyPreview);
          }
          throw new UnexpectedHttpError(response.status, bodyPreview);
        }
        try {
          return await response.json() as Record<string, any>;
        } catch (err) {
          throw new ModelResponseError("Model API returned invalid JSON", err);
        }
      }, retryConfig);

      const choice = data.choices?.[0];
      const message = choice?.message;
      const content = typeof message?.content === "string" ? message.content : "";
      if (content) opts.onDelta?.(content);
      const toolCalls = (message?.tool_calls ?? []).map((call: any) => {
        if (typeof call?.id !== "string" || typeof call?.function?.name !== "string") {
          throw new ModelResponseError("Model API returned a malformed tool call");
        }
        const raw = call.function?.arguments;
        let args: Record<string, unknown> | { error: "invalid_json"; raw: string };
        if (typeof raw !== "string") {
          args = { error: "invalid_json", raw: String(raw) };
        } else {
          try {
            args = JSON.parse(raw);
          } catch {
            args = { error: "invalid_json", raw };
          }
        }
        return { id: call.id, name: call.function.name, arguments: args };
      });
      const usage = data.usage;
      const hasCompleteUsage = Number.isFinite(usage?.prompt_tokens)
        && Number.isFinite(usage?.completion_tokens);

      return {
        content,
        toolCalls,
        truncatedByMaxTokens: choice?.finish_reason === "length",
        ...(hasCompleteUsage ? {
          usage: {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            ...(usage.prompt_tokens_details?.cached_tokens !== undefined
              ? { cachedTokens: usage.prompt_tokens_details.cached_tokens }
              : {}),
          },
        } : {}),
        stopReason: choice?.finish_reason,
      };
    },
    countTokens: heuristicCountTokens,
  };
}
