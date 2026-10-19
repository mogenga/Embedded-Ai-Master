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

  it("空 tool_calls 数组不计 token", () => {
    const messages: ModelChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [] },
    ];

    expect(heuristicCountTokens(messages)).toBe(0);
  });

  it("tool_calls 序列化后按 4 字符/token 计入", () => {
    const messages: ModelChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "echo", arguments: JSON.stringify({ text: "x".repeat(400) }) },
          },
        ],
      },
    ];

    const serialized = JSON.stringify(messages[0].tool_calls);
    expect(heuristicCountTokens(messages)).toBe(Math.ceil(serialized.length / 4));
  });

  it("content 与 tool_calls 合并计算", () => {
    const messages: ModelChatMessage[] = [
      {
        role: "assistant",
        content: "abcd",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: "1234" } },
        ],
      },
    ];

    const serialized = JSON.stringify(messages[0].tool_calls);
    expect(heuristicCountTokens(messages)).toBe(Math.ceil((4 + serialized.length) / 4));
  });
});
