import { describe, expect, it } from "vitest";
import { checkBudget } from "../src/context/budget.js";
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
