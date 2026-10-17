import { describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../src/model/openai.js";
import type { ModelChatMessage, ModelToolSchema } from "../src/model/protocol.js";

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

  it("message.content 缺失时返回空字符串", async () => {
    const result = await complete(successFetch({ choices: [{ message: { tool_calls: [] }, finish_reason: "tool_calls" }] }));

    expect(result.content).toBe("");
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

  it("401 抛 ModelFatalError 且不重试", async () => {
    const fetchImpl = mockFetch(() => ({ status: 401, body: { error: "unauthorized" } }));

    await expect(complete(fetchImpl)).rejects.toMatchObject({ code: "api_4xx", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
