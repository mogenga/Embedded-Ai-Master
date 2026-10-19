import { describe, expect, it } from "vitest";
import { createOpenAIProvider } from "../src/model/openai.js";
import type { ModelChatMessage } from "../src/model/protocol.js";

// 类型级断言: Task 9 的 buildMessages 必须能把 AssistantPayload.toolCalls
// 投影为 assistant 消息的 tool_calls;缺该字段时只能 as 强转,故在类型层钉死。
type Assert<T extends true> = T;
type HasToolCalls<T> = "tool_calls" extends keyof T ? true : false;
type ModelChatMessageHasToolCalls = Assert<HasToolCalls<ModelChatMessage>>;
const modelChatMessageHasToolCalls: ModelChatMessageHasToolCalls = true;

describe("模型消息契约", () => {
  it("assistant 消息可携带 OpenAI wire 格式的 tool_calls", () => {
    const msg: ModelChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }],
    };

    expect(msg.tool_calls?.[0].function.arguments).toBe("{}");
  });

  it("适配器原样透传带 tool_calls 的 assistant 消息", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        text: async () => JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      };
    }) as unknown as typeof fetch;
    const assistant: ModelChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"x"}' } }],
    };

    await createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl })
      .complete(
        [{ role: "user", content: "x" }, assistant, { role: "tool", tool_call_id: "c1", content: "x" }],
        [],
        { signal: new AbortController().signal, maxOutputTokens: 1 },
      );

    expect(captured?.messages).toEqual([
      { role: "user", content: "x" },
      assistant,
      { role: "tool", tool_call_id: "c1", content: "x" },
    ]);
  });
});
