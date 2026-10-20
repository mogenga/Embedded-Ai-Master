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
  it("请求体包含 model/messages/tools/max_tokens 且 stream=true", async () => {
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
      stream: true,
      stream_options: { include_usage: true },
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

  it.each([
    ["query", "http://gw/v1?api-version=1"],
    ["hash", "http://gw/v1#frag"],
  ])("baseUrl 携带 %s 时拒绝配置", (_label, baseUrl) => {
    expect(() => createOpenAIProvider({ baseUrl, model: "m", fetchImpl: successFetch() }))
      .toThrowError(/baseUrl must not contain a query or hash/);
  });

  it("baseUrl 非法时拒绝配置", () => {
    expect(() => createOpenAIProvider({ baseUrl: "not-a-url", model: "m", fetchImpl: successFetch() }))
      .toThrowError(/baseUrl is not a valid URL/);
  });

  it.each(["ftp://gw/v1", "file:///tmp/gw"])(
    "非 http(s) scheme 在创建期拒绝: %s（D-013）",
    (baseUrl) => {
      expect(() => createOpenAIProvider({ baseUrl, model: "m", fetchImpl: successFetch() }))
        .toThrowError(/http/);
    },
  );

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

    expect(result.toolCalls[0]).toEqual({
      id: "call-1",
      name: "echo",
      arguments: { error: "invalid_json", raw: "{bad" },
      invalidJson: true,
    });
  });

  it.each(["null", "[]"])("JSON arguments 为 %s 时返回 invalid_json", async (raw) => {
    const result = await complete(successFetch({ choices: [{ message: { content: "", tool_calls: [
      { id: "call-1", function: { name: "echo", arguments: raw } },
    ] }, finish_reason: "tool_calls" }] }));

    expect(result.toolCalls[0]).toEqual({
      id: "call-1",
      name: "echo",
      arguments: { error: "invalid_json", raw },
      invalidJson: true,
    });
  });

  it("非字符串 tool_calls arguments 返回结构化错误且保留字符串化值", async () => {
    const result = await complete(successFetch({ choices: [{ message: { content: "", tool_calls: [
      { id: "call-1", function: { name: "echo", arguments: { value: 1 } } },
    ] }, finish_reason: "tool_calls" }] }));

    expect(result.toolCalls[0]).toEqual({
      id: "call-1",
      name: "echo",
      arguments: { error: "invalid_json", raw: "[object Object]" },
      invalidJson: true,
    });
  });

  it("模型输出恰好形如 marker 的合法 arguments 时不标记 invalidJson", async () => {
    const result = await complete(successFetch({ choices: [{ message: { content: "", tool_calls: [
      { id: "call-1", function: { name: "echo", arguments: '{"error":"invalid_json","raw":"{bad"}' } },
    ] }, finish_reason: "tool_calls" }] }));

    expect(result.toolCalls[0]).toEqual({
      id: "call-1",
      name: "echo",
      arguments: { error: "invalid_json", raw: "{bad" },
    });
    expect(result.toolCalls[0]).not.toHaveProperty("invalidJson");
  });

  it("message.content 缺失时返回空字符串", async () => {
    const result = await complete(successFetch({ choices: [{ message: { tool_calls: [] }, finish_reason: "tool_calls" }] }));

    expect(result.content).toBe("");
  });

  it("tool_calls 字段缺失时返回空数组", async () => {
    const result = await complete(successFetch(OK_BODY));

    expect(result.toolCalls).toEqual([]);
  });

  it.each([
    ["缺失", {}],
    ["空数组", { choices: [] }],
    ["非数组", { choices: "bad" }],
    ["null", { choices: null }],
  ])("choices %s 时抛 invalid_response", async (_label, body) => {
    await expect(complete(successFetch(body)))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    ["null", [null]],
    ["数组", [[]]],
    ["字符串", ["bad"]],
  ])("choices 元素为 %s 时抛 invalid_response", async (_label, choices) => {
    await expect(complete(successFetch({ choices })))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("choices 元素缺少 message 时按空内容成功", async () => {
    const result = await complete(successFetch({ choices: [{}] }));

    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([]);
  });

  it("choices 元素 message 为 null 时抛 invalid_response", async () => {
    await expect(complete(successFetch({ choices: [{ message: null }] })))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("choices 元素 message 为非对象时抛 invalid_response", async () => {
    await expect(complete(successFetch({ choices: [{ message: "bad" }] })))
      .rejects.toMatchObject({ code: "invalid_response" });
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

  it("usage 数字字段为字符串时按数值收窄（D-014）", async () => {
    const result = await complete(successFetch({
      ...OK_BODY,
      usage: { prompt_tokens: "10", completion_tokens: "3" },
    }));

    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3 });
  });

  it("usage 数字字段非数值字符串时仍省略 usage", async () => {
    const result = await complete(successFetch({
      ...OK_BODY,
      usage: { prompt_tokens: "ten", completion_tokens: "3" },
    }));

    expect(result).not.toHaveProperty("usage");
  });

  it("tool call type 非 function 或 content 非字符串时抛 invalid_response（D-037）", async () => {
    await expect(complete(successFetch({
      choices: [{
        message: {
          content: "",
          tool_calls: [{
            id: "c1",
            type: "image",
            function: { name: "echo", arguments: "{}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }))).rejects.toMatchObject({ code: "invalid_response" });

    await expect(complete(successFetch({
      choices: [{
        message: { content: 42, tool_calls: [] },
        finish_reason: "stop",
      }],
    }))).rejects.toMatchObject({ code: "invalid_response" });
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

  it("成功响应读取正文抛 AbortError 时原样透传", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw abortError; },
      text: async () => { throw abortError; },
    })) as unknown as typeof fetch;

    await expect(complete(fetchImpl)).rejects.toBe(abortError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetch 收到与 opts.signal 联动的 signal", async () => {
    const controller = new AbortController();
    let captured: AbortSignal | null | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      captured = init.signal as AbortSignal | null | undefined;
      return { status: 200, body: OK_BODY };
    });

    await createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl })
      .complete(MESSAGES, [], { signal: controller.signal, maxOutputTokens: 1 });

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
    controller.abort();
    expect(captured?.aborted).toBe(true);
  });

  it.each([{ label: "null", body: null }, { label: "[]", body: [] }])("顶层响应 $label 抛 invalid_response", async ({ body }) => {
    await expect(complete(successFetch(body)))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    ["object", {}],
    ["string", "bad"],
  ])("tool_calls 为 %s 时抛 invalid_response", async (_label, toolCalls) => {
    await expect(complete(successFetch({
      choices: [{ message: { content: "", tool_calls: toolCalls }, finish_reason: "tool_calls" }],
    }))).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("tool_calls 为 null 时等同缺失返回空数组", async () => {
    const result = await complete(successFetch({
      choices: [{ message: { content: "", tool_calls: null }, finish_reason: "tool_calls" }],
    }));

    expect(result.toolCalls).toEqual([]);
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

  it("未注入 sleep/rand 时默认退避路径可完成重试", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => "server error" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => OK_BODY, text: async () => JSON.stringify(OK_BODY) }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      retry: { maxRetries: 1, baseDelayMs: 1 },
    });

    const result = await provider.complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("hi");
  });

  it.each([408, 409, 425])("HTTP %i 视为可重试（D-036）", async (status) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status,
        json: async () => ({}),
        text: async () => "retry me",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => OK_BODY,
        text: async () => JSON.stringify(OK_BODY),
      }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      retry: { maxRetries: 1, baseDelayMs: 1, sleep: async () => {}, rand: () => 0.5 },
    });

    const result = await provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 1,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("hi");
  });

  it("401 抛 ModelFatalError 且不重试，bodyPreview 截断到 512", async () => {
    const body = "x".repeat(600);
    const expectedPreview = JSON.stringify(body).slice(0, 512);
    const fetchImpl = mockFetch(() => ({ status: 401, body }));

    try {
      await complete(fetchImpl);
      expect.fail("应拒绝 401 响应");
    } catch (error) {
      expect(error).toMatchObject({ code: "api_4xx", status: 401, bodyPreview: expectedPreview });
      expect((error as { bodyPreview: string }).bodyPreview).toHaveLength(512);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("错误响应体只读取前 512 字节并取消流", async () => {
    let cancelled = false;
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(256)));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 401 }),
    ) as unknown as typeof fetch;

    try {
      await complete(fetchImpl);
      expect.fail("应拒绝 401 响应");
    } catch (error) {
      expect(error).toMatchObject({ code: "api_4xx", status: 401 });
      expect((error as { bodyPreview: string }).bodyPreview).toHaveLength(512);
    }
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(3);
  });

  it("请求超过 requestTimeoutMs 时抛 RequestTimeoutError", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      requestTimeoutMs: 10,
      retry: { maxRetries: 0 },
    });

    await expect(
      provider.complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 }),
    ).rejects.toMatchObject({ name: "RequestTimeoutError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }, 2_000);

  it("请求超时可重试，重试成功返回结果", async () => {
    let calls = 0;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => OK_BODY,
        text: async () => JSON.stringify(OK_BODY),
      });
    }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      requestTimeoutMs: 10,
      retry: { maxRetries: 1, baseDelayMs: 1, sleep: async () => {}, rand: () => 0.5 },
    });

    const result = await provider.complete(
      MESSAGES,
      [],
      { signal: new AbortController().signal, maxOutputTokens: 1 },
    );

    expect(result.content).toBe("hi");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 2_000);

  it("调用方取消仍抛 AbortError 而非超时", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      requestTimeoutMs: 1_000,
      retry: { maxRetries: 0 },
    });
    const pending = provider.complete(
      MESSAGES,
      [],
      { signal: controller.signal, maxOutputTokens: 1 },
    );
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("响应体超过 maxResponseBytes 时拒绝", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: OK_BODY }));
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      maxResponseBytes: 20,
    });

    await expect(
      provider.complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("流式响应超过 maxResponseBytes 时取消读取并拒绝", async () => {
    let cancelled = false;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(16)));
        if (sent >= 10) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      maxResponseBytes: 20,
    });

    await expect(
      provider.complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(cancelled).toBe(true);
  });
});

describe("OpenAI 流式响应", () => {
  function sseResponse(lines: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  function sseFetch(lines: string[]): { impl: typeof fetch; calls: number } {
    const state = { impl: undefined as unknown as typeof fetch, calls: 0 };
    state.impl = vi.fn(async () => {
      state.calls += 1;
      return sseResponse(lines);
    }) as unknown as typeof fetch;
    return state;
  }

  it("逐帧回调 onDelta 并拼出完整 content", async () => {
    const onDelta = vi.fn();
    const fetchImpl = sseFetch([
      'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]).impl;
    const provider = createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl });

    const result = await provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 16,
      onDelta,
    });

    expect(onDelta.mock.calls).toEqual([["你"], ["好"]]);
    expect(result.content).toBe("你好");
    expect(result.stopReason).toBe("stop");
  });

  it("流式帧里的 usage 汇总成完整用量", async () => {
    const fetchImpl = sseFetch([
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}',
      "data: [DONE]",
    ]).impl;
    const provider = createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl });

    const result = await provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 16,
    });

    expect(result.usage).toStrictEqual({
      promptTokens: 11,
      completionTokens: 3,
      cachedTokens: 2,
    });
  });

  it("流式帧里的 tool_calls 累积成完整调用", async () => {
    const fetchImpl = sseFetch([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"echo","arguments":"{\\"op\\":"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"write\\"}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ]).impl;
    const provider = createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl });

    const result = await provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 16,
    });

    expect(result.toolCalls).toStrictEqual([
      { id: "call-1", name: "echo", arguments: { op: "write" } },
    ]);
  });

  it("漏发 Content-Type 但内容是 data: 帧时仍按流式解析", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n"));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const onDelta = vi.fn();
    const provider = createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl });

    const result = await provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 16,
      onDelta,
    });

    expect(result.content).toBe("hi");
    expect(onDelta.mock.calls).toEqual([["hi"]]);
  });

  it("网关拒绝流式时降级为一次性响应", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.stream === true) {
        return new Response("no stream here", { status: 400 });
      }
      return new Response(JSON.stringify(OK_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const onDelta = vi.fn();
    const provider = createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl });

    const result = await provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 16,
      onDelta,
    });

    expect(result.content).toBe("hi");
    expect(calls).toBe(2);
    expect(onDelta.mock.calls).toEqual([["hi"]]);
  });

  it("降级后同一端点不再试探流式", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? "{}"));
      if (String(init?.body ?? "").includes('"stream":true')) {
        return new Response("no", { status: 400 });
      }
      return new Response(JSON.stringify(OK_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl });
    const options = { signal: new AbortController().signal, maxOutputTokens: 16 };

    await provider.complete(MESSAGES, [], options);
    await provider.complete(MESSAGES, [], options);

    // 第一次 complete 试探一次流式（被拒）后立刻降级；第二次 complete
    // 不再试探，直接一次性。两次调用各产生一次一次性请求。
    expect(bodies.filter((body) => body.includes('"stream":true'))).toHaveLength(1);
    expect(bodies.filter((body) => body.includes('"stream":false'))).toHaveLength(2);
  });

  it("流式帧 JSON 非法时抛 invalid_response", async () => {
    const fetchImpl = sseFetch(["data: {not json}"]).impl;
    const provider = createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl });

    await expect(
      provider.complete(MESSAGES, [], {
        signal: new AbortController().signal,
        maxOutputTokens: 16,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("流式响应缺少 choices 时抛 invalid_response", async () => {
    const fetchImpl = sseFetch(['data: {"foo":1}']).impl;
    const provider = createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl });

    await expect(
      provider.complete(MESSAGES, [], {
        signal: new AbortController().signal,
        maxOutputTokens: 16,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("stream=false 配置时不请求流式", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      captured = JSON.parse(String(init.body));
      return { status: 200, body: OK_BODY };
    });
    const provider = createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "m",
      fetchImpl,
      stream: false,
    });

    await provider.complete(MESSAGES, [], {
      signal: new AbortController().signal,
      maxOutputTokens: 16,
    });

    expect(captured).toMatchObject({ stream: false });
    expect(captured?.stream_options).toBeUndefined();
  });
});
