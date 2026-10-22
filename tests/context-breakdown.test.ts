import { describe, expect, it } from "vitest";
import { buildContextBreakdown } from "../src/context/breakdown.js";
import type { ContextBreakdown } from "../src/context/breakdown.js";
import { heuristicCountTokens } from "../src/model/count.js";
import type { ModelChatMessage } from "../src/model/protocol.js";

function system(content: string): ModelChatMessage {
  return { role: "system", content };
}

function user(content: string): ModelChatMessage {
  return { role: "user", content };
}

function assistant(
  content: string,
  calls: Array<{ id: string; name: string }> = [],
): ModelChatMessage {
  return {
    role: "assistant",
    content,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: "{}" },
    })),
  };
}

function toolResult(id: string, content: string): ModelChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

function sumParts(breakdown: ContextBreakdown): number {
  return breakdown.parts.reduce((total, part) => total + part.tokens, 0);
}

describe("buildContextBreakdown", () => {
  it("按角色分类：system → systemPrompt，user/assistant → messages", () => {
    const messages = [system("SYS"), user("hello"), assistant("hi there")];

    const breakdown = buildContextBreakdown(messages, {
      window: 1000,
      used: 40,
      compactAt: 800,
    });

    expect(breakdown.parts.map((part) => part.key)).toStrictEqual([
      "systemPrompt",
      "messages",
    ]);
    // 逐桶测量：system 1 token，user+assistant 4 token；按 used=40 等比缩放即 8/32。
    expect(breakdown.parts.map((part) => part.tokens)).toStrictEqual([8, 32]);
    expect(sumParts(breakdown)).toBe(40);
  });

  it("tool 消息按 assistant 的 tool_calls[].function.name 归属：mcp__ 前缀 → mcpTools，其余 → toolResults", () => {
    const messages = [
      user("go"),
      assistant("", [
        { id: "c1", name: "mcp__probe__read_memory" },
        { id: "c2", name: "shell" },
      ]),
      toolResult("c1", "MCP-RESULT"),
      toolResult("c2", "SHELL-RESULT"),
    ];
    const measured: string[][] = [];
    const measure = (list: ModelChatMessage[]): number => {
      // 逐桶记录，验证的是分类而不是数字。
      measured.push(list.map((message) => message.content));
      return list.length * 10;
    };

    const breakdown = buildContextBreakdown(messages, {
      window: 2000,
      used: 100,
      compactAt: 1600,
      measure,
    });

    expect(breakdown.parts.map((part) => part.key)).toStrictEqual([
      "messages",
      "toolResults",
      "mcpTools",
    ]);
    expect(breakdown.parts.map((part) => part.tokens)).toStrictEqual([50, 25, 25]);
    expect(sumParts(breakdown)).toBe(100);
    expect(measured).toStrictEqual([
      ["go", ""],
      ["SHELL-RESULT"],
      ["MCP-RESULT"],
    ]);
  });

  it("tool_call_id 查不到工具名时退回 toolResults，而不是猜成 MCP", () => {
    const messages = [
      user("go"),
      assistant("", [{ id: "c1", name: "mcp__probe__read" }]),
      toolResult("c1", "MCP"),
      toolResult("orphan", "NO-PARENT"),
    ];
    const measure = (list: ModelChatMessage[]): number => list.length;

    const breakdown = buildContextBreakdown(messages, {
      window: 1000,
      used: 4,
      compactAt: 800,
      measure,
    });

    const byKey = new Map(breakdown.parts.map((part) => [part.key, part.tokens]));
    expect(byKey.get("mcpTools")).toBe(1);
    expect(byKey.get("toolResults")).toBe(1);
    expect(sumParts(breakdown)).toBe(4);
  });

  it("等比缩放后余数补给最大桶：sum(parts) 恰等于 used", () => {
    // system 1 条 → raw 1；user + assistant 合桶 → raw 2；used=10 时
    // floor(10/3)=3 与 floor(20/3)=6 合计 9，余下的 1 个 token 补给较大的那个桶。
    const messages = [system("s"), user("u"), assistant("a")];
    const measure = (list: ModelChatMessage[]): number => list.length;

    const breakdown = buildContextBreakdown(messages, {
      window: 1000,
      used: 10,
      compactAt: 800,
      measure,
    });

    expect(breakdown.parts.map((part) => part.key)).toStrictEqual([
      "systemPrompt",
      "messages",
    ]);
    expect(breakdown.parts.map((part) => part.tokens)).toStrictEqual([3, 7]);
    expect(sumParts(breakdown)).toBe(10);
    expect(breakdown.used).toBe(10);
  });

  it("默认用 heuristicCountTokens 逐桶测量，缩放后之和仍等于 used", () => {
    const messages = [
      system("S".repeat(400)),
      user("U".repeat(160)),
      assistant("A".repeat(40), [{ id: "c1", name: "shell" }]),
      toolResult("c1", "T".repeat(120)),
    ];
    const used = 123456;

    const breakdown = buildContextBreakdown(messages, {
      window: 200_000,
      used,
      compactAt: 160_000,
    });

    expect(sumParts(breakdown)).toBe(used);
    // 各桶比例应贴近原始测量比例：system 400 字节最大，tool 结果次之。
    const byKey = new Map(breakdown.parts.map((part) => [part.key, part.tokens]));
    expect(byKey.get("systemPrompt")!).toBeGreaterThan(byKey.get("toolResults")!);
    expect(byKey.get("toolResults")!).toBeGreaterThan(0);
    expect(heuristicCountTokens([system("S".repeat(400))])).toBe(100);
  });

  it("parts 只含 tokens > 0 的项，顺序固定且不因缺项调换", () => {
    const messages = [system("SYS"), user("hello")];
    const measure = (): number => 0;

    const breakdown = buildContextBreakdown(messages, {
      window: 1000,
      used: 7,
      compactAt: 800,
      measure,
    });

    // 每个桶都量不出 token，但 used > 0：总额不能凭空消失，
    // 记在第一个真有消息的桶上，类别顺序保持不变。
    expect(breakdown.parts).toStrictEqual([{ key: "systemPrompt", tokens: 7 }]);
    expect(sumParts(breakdown)).toBe(7);
  });

  it("无消息时 parts 为空，即使 used > 0", () => {
    const breakdown = buildContextBreakdown([], {
      window: 1000,
      used: 500,
      compactAt: 800,
    });

    expect(breakdown.parts).toStrictEqual([]);
    expect(breakdown.used).toBe(500);
    expect(breakdown.percent).toBe(50);
  });

  it("used <= 0 时 parts 为空且 percent 为 0", () => {
    const messages = [system("SYS"), user("hello")];

    for (const used of [0, -10]) {
      const breakdown = buildContextBreakdown(messages, {
        window: 1000,
        used,
        compactAt: 800,
      });
      expect(breakdown.parts).toStrictEqual([]);
      expect(breakdown.used).toBe(used);
      expect(breakdown.percent).toBe(0);
    }
  });

  it("percent 保留一位小数并钳在 [0, 100]", () => {
    const messages = [user("hello")];

    expect(
      buildContextBreakdown(messages, { window: 1000, used: 456, compactAt: 800 }).percent,
    ).toBe(45.6);
    expect(
      buildContextBreakdown(messages, { window: 1000, used: 4567, compactAt: 800 }).percent,
    ).toBe(100);
    expect(
      buildContextBreakdown(messages, { window: 0, used: 4567, compactAt: 800 }).percent,
    ).toBe(0);
  });

  it("window / compactAt / used 原样透传，used 不取自各桶之和", () => {
    const messages = [system("SYS"), user("hello")];
    const measured = heuristicCountTokens(messages);

    const breakdown = buildContextBreakdown(messages, {
      window: 8192,
      used: measured + 37,
      compactAt: 6553,
    });

    expect(breakdown.used).toBe(measured + 37);
    expect(breakdown.window).toBe(8192);
    expect(breakdown.compactAt).toBe(6553);
    expect(sumParts(breakdown)).toBe(measured + 37);
  });
});
