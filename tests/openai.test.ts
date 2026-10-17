import { describe, expect, it, vi } from "vitest";
import { createOpenAIProvider, type OpenAIProviderCfg } from "../src/model/openai.js";
import type { ModelChatMessage, ModelToolSchema } from "../src/model/protocol.js";
import type { RetryConfig } from "../src/model/retry.js";

type Assert<T extends true> = T;
type HasKey<T, K extends string> = K extends keyof T ? true : false;
type HasNow<T> = "now" extends keyof T ? true : false;
type RetryConfigHasNoNow = Assert<HasNow<RetryConfig> extends false ? true : false>;
type RetryOptions = NonNullable<OpenAIProviderCfg["retry"]>;
type RetryOptionsExcludeIsRetryable = Assert<HasKey<RetryOptions, "isRetryable"> extends false ? true : false>;
const retryOptionsExcludeIsRetryable: RetryOptionsExcludeIsRetryable = true;

const OK_BODY = {
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
};
const TOOL: ModelToolSchema = {
  type: "function",
  function: { name: "echo", description: "Echo input", parameters: { type: "object" } },
};
const MESSAGES: ModelChatMessage[] = [{ role: "user", content: "hi" }];

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const response = handler(String(url), init ?? {});
    const bodyText = JSON.stringify(response.body);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => JSON.parse(bodyText),
      text: async () => bodyText,
    };
  }) as unknown as typeof fetch;
}

function successFetch(body: unknown = OK_BODY) {
  return mockFetch(() => ({ status: 200, body }));
}

function complete(fetchImpl: typeof fetch, options: { apiKey?: string } = {}) {
  return createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl, ...options })
    .complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 });
}

describe("OpenAI 兼容模型适配器", () => {
  it("请求体包含 model/messages/tools/max_tokens 且 stream=false", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      captured = JSON.parse(String(init.body));
      return { status: 200, body: OK_BODY };
    });

    await createOpenAIProvider({ baseUrl: "http://gw/v1", model: "local-gw/flash", fetchImpl })
      .complete(MESSAGES, [TOOL], { signal: new AbortController().signal, maxOutputTokens: 8192 });

    expect(captured).toMatchObject({
      model: "local-gw/flash",
      messages: MESSAGES,
      tools: [TOOL],
      max_tokens: 8192,
      stream: false,
    });
  });

  it("请求发往 /chat/completions 且 method 为 POST", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const fetchImpl = mockFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init.method;
      return { status: 200, body: OK_BODY };
    });

    await complete(fetchImpl);

    expect(capturedUrl).toBe("http://gw/v1/chat/completions");
    expect(capturedMethod).toBe("POST");
  });

  it("baseUrl 的多个尾斜杠被折叠", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = mockFetch((url) => {
      capturedUrl = url;
      return { status: 200, body: OK_BODY };
    });

    await createOpenAIProvider({ baseUrl: "http://gw/v1///", model: "m", fetchImpl })
      .complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 });

    expect(capturedUrl).toBe("http://gw/v1/chat/completions");
  });

  it("将合法 tool_calls arguments JSON 解析为对象", async () => {
    const result = await complete(successFetch({ choices: [{ message: { content: "", tool_calls: [
      { id: "call-1", function: { name: "echo", arguments: '{"value":1}' } },
    ] }, finish_reason: "tool_calls" }] }));

    expect(result.toolCalls[0]).toEqual({ id: "call-1", name: "echo", arguments: { value: 1 } });
  });

  it("非法 tool_calls arguments 返回结构化错误", async () => {
    const result = await complete(successFetch({ choices: [{ message: { content: "", tool_calls: [
      { id: "call-1", function: { name: "echo", arguments: "{bad" } },
    ] }, finish_reason: "tool_calls" }] }));

    expect(result.toolCalls[0].arguments).toEqual({ error: "invalid_json", raw: "{bad" });
  });

  it.each(["null", "[]"])("JSON arguments 为 %s 时返回 invalid_json", async (raw) => {
    const result = await complete(successFetch({ choices: [{ message: { content: "", tool_calls: [
      { id: "call-1", function: { name: "echo", arguments: raw } },
    ] }, finish_reason: "tool_calls" }] }));

    expect(result.toolCalls[0].arguments).toEqual({ error: "invalid_json", raw });
  });

  it("非字符串 tool_calls arguments 返回结构化错误且保留字符串化值", async () => {
    const result = await complete(successFetch({ choices: [{ message: { content: "", tool_calls: [
      { id: "call-1", function: { name: "echo", arguments: { value: 1 } } },
    ] }, finish_reason: "tool_calls" }] }));

    expect(result.toolCalls[0].arguments).toEqual({ error: "invalid_json", raw: "[object Object]" });
  });

  it("message.content 缺失时返回空字符串", async () => {
    const result = await complete(successFetch({ choices: [{ message: { tool_calls: [] }, finish_reason: "tool_calls" }] }));

    expect(result.content).toBe("");
  });

  it("tool_calls 字段缺失时返回空数组", async () => {
    const result = await complete(successFetch(OK_BODY));

    expect(result.toolCalls).toEqual([]);
  });

  it("finish_reason=length 标记输出截断", async () => {
    const result = await complete(successFetch({ choices: [{ message: { content: "hi" }, finish_reason: "length" }] }));

    expect(result.truncatedByMaxTokens).toBe(true);
  });

  it("透传 prompt、completion 与 cached token 用量", async () => {
    const result = await complete(successFetch({
      ...OK_BODY,
      usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } },
    }));

    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3, cachedTokens: 4 });
  });

  it.each(["bad", null, Infinity])("忽略非有限数值 cached_tokens: %s", async (cachedTokens) => {
    const result = await complete(successFetch({
      ...OK_BODY,
      usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: cachedTokens } },
    }));

    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3 });
  });

  it("不读取或转发过期 retry.now", async () => {
    const now = vi.fn(() => 123);
    const fetchImpl = successFetch();
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1", model: "m", fetchImpl,
      retry: { now } as unknown as Partial<import("../src/model/retry.js").RetryConfig>,
    });

    await provider.complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 });
    expect(now).not.toHaveBeenCalled();
  });

  it("usage 缺少必需字段时省略 usage", async () => {
    const result = await complete(successFetch({
      ...OK_BODY,
      usage: { prompt_tokens: 10 },
    }));

    expect(result).not.toHaveProperty("usage");
  });

  it("缺少 tool call id 或 name 时抛 invalid_response", async () => {
    for (const call of [
      { function: { name: "echo", arguments: "{}" } },
      { id: "call-1", function: { arguments: "{}" } },
    ]) {
      await expect(complete(successFetch({ choices: [{ message: { content: "", tool_calls: [call] }, finish_reason: "tool_calls" }] })))
        .rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("成功响应 JSON 解析失败抛 invalid_response 且不重试", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("bad json"); },
      text: async () => "{bad",
    })) as unknown as typeof fetch;

    await expect(complete(fetchImpl)).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([{ label: "null", body: null }, { label: "[]", body: [] }])("顶层响应 $label 抛 invalid_response", async ({ body }) => {
    await expect(complete(successFetch(body)))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("tool_calls 为 object 时抛 invalid_response", async () => {
    await expect(complete(successFetch({
      choices: [{ message: { content: "", tool_calls: {} }, finish_reason: "tool_calls" }],
    }))).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("tool_calls 为 null 时抛 invalid_response", async () => {
    await expect(complete(successFetch({
      choices: [{ message: { content: "", tool_calls: null }, finish_reason: "tool_calls" }],
    }))).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("retry 配置不接受调用方覆盖 isRetryable", () => {
    const cfg: OpenAIProviderCfg = {
      baseUrl: "http://gw/v1",
      model: "m",
      // @ts-expect-error isRetryable 由适配器内部固定，调用方不得覆盖
      retry: { isRetryable: () => true },
    };

    expect(cfg.retry).toBeDefined();
  });

  it("仅 apiKey 非空时发送 Bearer Authorization", async () => {
    let headers: HeadersInit | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      headers = init.headers;
      return { status: 200, body: OK_BODY };
    });
    await complete(fetchImpl, { apiKey: "k" });
    expect(new Headers(headers).get("authorization")).toBe("Bearer k");

    for (const apiKey of [undefined, ""]) {
      let noKeyHeaders: HeadersInit | undefined;
      const noKeyFetch = mockFetch((_url, init) => {
        noKeyHeaders = init.headers;
        return { status: 200, body: OK_BODY };
      });
      await complete(noKeyFetch, { apiKey });
      expect(new Headers(noKeyHeaders).has("authorization")).toBe(false);
    }
  });

  it("onDelta 对完整 content 调用一次", async () => {
    const onDelta = vi.fn();
    const provider = createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl: successFetch() });
    await provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 1,
      onDelta,
    });

    expect(onDelta.mock.calls).toEqual([["hi"]]);
  });

  it("malformed tool_calls 时不回调 onDelta", async () => {
    const onDelta = vi.fn();
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl: successFetch({
        choices: [{ message: { content: "hi", tool_calls: {} }, finish_reason: "tool_calls" }],
      }),
    });

    await expect(provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 1,
      onDelta,
    })).rejects.toMatchObject({ code: "invalid_response" });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("空 content 不回调 onDelta", async () => {
    const onDelta = vi.fn();
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl: successFetch({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
    });

    await provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 1,
      onDelta,
    });

    expect(onDelta).not.toHaveBeenCalled();
  });

  it("429 后重试并成功", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}), text: async () => "{}" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => OK_BODY, text: async () => JSON.stringify(OK_BODY) }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      retry: { maxRetries: 3, baseDelayMs: 1, sleep: async () => {}, rand: () => 0.5 },
    });

    const result = await provider.complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("hi");
  });

  it("5xx 后重试并成功", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}), text: async () => "unavailable" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => OK_BODY, text: async () => JSON.stringify(OK_BODY) }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      retry: { maxRetries: 3, baseDelayMs: 1, sleep: async () => {}, rand: () => 0.5 },
    });

    const result = await provider.complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("hi");
  });

  it("fetch 网络错误重试后成功", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => OK_BODY, text: async () => JSON.stringify(OK_BODY) }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      retry: { maxRetries: 3, baseDelayMs: 1, sleep: async () => {}, rand: () => 0.5 },
    });

    const result = await provider.complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("hi");
  });

  it("退避期间取消时不再发送下一次请求", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "{}",
    })) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      retry: {
        maxRetries: 3,
        baseDelayMs: 1,
        sleep: async () => controller.abort(),
        rand: () => 0.5,
      },
    });

    await expect(provider.complete(MESSAGES, [], { signal: controller.signal, maxOutputTokens: 1 }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("AbortError 直接终止且不重试", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    const fetchImpl = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      retry: { maxRetries: 3, baseDelayMs: 1, sleep: async () => {}, rand: () => 0.5 },
    });

    await expect(provider.complete(MESSAGES, [], { signal: AbortSignal.abort(), maxOutputTokens: 1 }))
      .rejects.toBe(abortError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("401 抛 ModelFatalError 且不重试", async () => {
    const fetchImpl = mockFetch(() => ({ status: 401, body: { error: "unauthorized" } }));

    await expect(complete(fetchImpl)).rejects.toMatchObject({ code: "api_4xx", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
