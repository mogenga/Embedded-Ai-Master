import { describe, expect, it } from "vitest";
import { checkBudget, checkBudgetTokens } from "../src/context/budget.js";
import type { ModelChatMessage } from "../src/model/protocol.js";

describe("上下文预算", () => {
  it("contextWindow=10000 时 softLimit 为 8000,恰好 8000 不 over", () => {
    const messages: ModelChatMessage[] = [{ role: "user", content: "a".repeat(32000) }];

    expect(checkBudget(messages, 10000)).toMatchObject({
      over: false,
      softLimit: 8000,
      tokens: 8000,
    });
  });

  it("超过 softLimit 1 token 时 over", () => {
    const messages: ModelChatMessage[] = [{ role: "user", content: "a".repeat(32004) }];

    expect(checkBudget(messages, 10000).over).toBe(true);
  });
});

describe("checkBudgetTokens", () => {
  it("默认 softRatio=0.8，恰好 softLimit 不 over", () => {
    expect(checkBudgetTokens(8000, 10000)).toEqual({
      over: false,
      tokens: 8000,
      softLimit: 8000,
    });
  });

  it("超过 softLimit 1 token 时 over", () => {
    expect(checkBudgetTokens(8001, 10000).over).toBe(true);
  });

  it("自定义 softRatio", () => {
    expect(checkBudgetTokens(5000, 10000, 0.5)).toEqual({
      over: false,
      tokens: 5000,
      softLimit: 5000,
    });
    expect(checkBudgetTokens(5001, 10000, 0.5).over).toBe(true);
  });

  it("softLimit 向下取整", () => {
    expect(checkBudgetTokens(1001, 10000, 0.1)).toEqual({
      over: true,
      tokens: 1001,
      softLimit: 1000,
    });
  });

  it("tokens 为 0 时不 over", () => {
    expect(checkBudgetTokens(0, 10000).over).toBe(false);
  });
});
describe("预算计入 tool_calls", () => {
  it("content 为空但 tool_calls 很大时按 tool_calls 计入并 over", () => {
    const messages: ModelChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "echo", arguments: JSON.stringify({ text: "x".repeat(32000) }) },
          },
        ],
      },
    ];

    expect(checkBudget(messages, 10000).over).toBe(true);
  });
});
