import { describe, expect, it } from "vitest";
import { heuristicCountTokens } from "../src/model/count.js";
import type { ModelChatMessage } from "../src/model/protocol.js";

describe("启发式 token 计数", () => {
  it("空消息计数为 0", () => {
    expect(heuristicCountTokens([])).toBe(0);
  });

  it("每条消息按 content 字符数除以 4 向上取整", () => {
    const messages: ModelChatMessage[] = [{ role: "user", content: "abcd" }];

    expect(heuristicCountTokens(messages)).toBe(1);
    expect(heuristicCountTokens([{ role: "user", content: "abc" }])).toBe(1);
  });

  it("多消息计数累加", () => {
    const messages: ModelChatMessage[] = [
      { role: "system", content: "a".repeat(8) },
      { role: "user", content: "b".repeat(4) },
    ];

    expect(heuristicCountTokens(messages)).toBe(3);
  });
});
