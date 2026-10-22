import { describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../src/model/openai.js";
import type { ModelChatMessage } from "../src/model/protocol.js";

const OK_BODY = { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] };
const MESSAGES: ModelChatMessage[] = [{ role: "user", content: "hi" }];

/** Capture every request body the adapter puts on the wire. */
function capturingFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      json: async () => OK_BODY,
      text: async () => JSON.stringify(OK_BODY),
    };
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

function complete(fetchImpl: typeof fetch, reasoningEffort?: string) {
  return createOpenAIProvider({
    baseUrl: "http://gw/v1",
    model: "m",
    fetchImpl,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as never }),
  }).complete(MESSAGES, [], { signal: new AbortController().signal, maxOutputTokens: 1 });
}

describe("reasoning_effort 上线", () => {
  it("配置了等级时请求体带 reasoning_effort", async () => {
    const { impl, bodies } = capturingFetch();

    await complete(impl, "high");

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.reasoning_effort).toBe("high");
  });

  it("没有配置时请求体里根本没有这个字段", async () => {
    const { impl, bodies } = capturingFetch();

    await complete(impl);

    // 不是 `undefined`、不是 `null`：字段必须缺席。显式发送与不发送对
    // 不同网关含义不同，凭空补一个默认值会悄悄改变既有用户的每一次请求。
    expect(bodies).toHaveLength(1);
    expect(Object.hasOwn(bodies[0] as object, "reasoning_effort")).toBe(false);
  });

  it("显式 none 会作为字段发出去，而不是被当成「没设置」省略", async () => {
    const { impl, bodies } = capturingFetch();

    await complete(impl, "none");

    expect(Object.hasOwn(bodies[0] as object, "reasoning_effort")).toBe(true);
    expect(bodies[0]?.reasoning_effort).toBe("none");
  });

  it.each(["minimal", "low", "medium", "high"])("合法等级 %s 原样上线", async (level) => {
    const { impl, bodies } = capturingFetch();

    await complete(impl, level);

    expect(bodies[0]?.reasoning_effort).toBe(level);
  });

  it("非法等级在创建适配器时就被拒绝，不会发出去", () => {
    const { impl, bodies } = capturingFetch();

    expect(() =>
      createOpenAIProvider({
        baseUrl: "http://gw/v1",
        model: "m",
        fetchImpl: impl,
        reasoningEffort: "max" as never,
      }),
    ).toThrowError(/reasoningEffort/);
    // 拒绝发生在构造成员时，所以没有任何请求被发出。
    expect(bodies).toHaveLength(0);
  });

  it("降级为非流式重试时仍然带着同一个等级", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (calls === 1) {
        // 400 = 网关不接受 stream；适配器会关掉流式再试一次。
        return {
          ok: false,
          status: 400,
          json: async () => ({}),
          text: async () => "{\"error\":\"no stream\"}",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => OK_BODY,
        text: async () => JSON.stringify(OK_BODY),
      };
    }) as unknown as typeof fetch;

    await complete(impl, "low");

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.stream).toBe(true);
    expect(bodies[1]?.stream).toBe(false);
    expect(bodies[1]?.reasoning_effort).toBe("low");
  });
});
