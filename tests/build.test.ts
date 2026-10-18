import { describe, expect, it } from "vitest";
import { buildMessages } from "../src/context/build.js";
import type { EventType, SessionEvent } from "../src/session/types.js";

function mk(
  seq: number,
  type: EventType,
  payload: Record<string, unknown>,
  parent?: number,
): SessionEvent {
  const event: SessionEvent = { seq, ts: "2026-10-18T00:00:00.000Z", type, payload };
  if (parent !== undefined) event.parent = parent;
  return event;
}

describe("buildMessages 投影重组", () => {
  it("线性事件投影: system/user/assistant/tool_result 重组", () => {
    const events: SessionEvent[] = [
      mk(0, "system", { content: "SYS" }),
      mk(1, "user", { content: "hello" }),
      mk(2, "assistant", {
        content: "calling",
        toolCalls: [{ id: "c1", name: "echo", arguments: { text: "x" } }],
      }),
      mk(3, "tool_result", { id: "c1", ok: true, text: "x" }, 2),
    ];

    const messages = buildMessages(events);

    expect(messages).toStrictEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"x"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "x" },
    ]);
  });

  it("assistant 同时含 content 与 tool_calls 都保留", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "我先调用工具",
        toolCalls: [{ id: "c1", name: "echo", arguments: { text: "hi" } }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text: "hi" }, 0),
    ]);

    expect(messages[0]).toMatchObject({ role: "assistant", content: "我先调用工具" });
    expect(messages[0].tool_calls).toStrictEqual([
      { id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } },
    ]);
  });

  it("多个 toolCalls 保持顺序,空数组仍带 tool_calls 字段", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [
          { id: "c1", name: "echo", arguments: { text: "a" } },
          { id: "c2", name: "echo", arguments: { text: "b" } },
        ],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text: "a" }, 0),
      mk(2, "tool_result", { id: "c2", ok: true, text: "b" }, 0),
      mk(3, "assistant", { content: "no tools", toolCalls: [] }),
    ]);

    expect(messages[0].tool_calls?.map((call) => call.id)).toEqual(["c1", "c2"]);
    expect(messages[0].tool_calls?.map((call) => call.function.arguments)).toEqual([
      '{"text":"a"}',
      '{"text":"b"}',
    ]);
    expect(messages[3].tool_calls).toStrictEqual([]);
  });

  it("invalid_json 标记的 toolCalls 回填原 raw 字符串", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: { error: "invalid_json", raw: "{bad" } }],
      }),
      mk(1, "tool_result", { id: "c1", ok: false, text: "bad" }, 0),
    ]);

    expect(messages[0].tool_calls?.[0].function.arguments).toBe("{bad");
  });

  it("usage/checkpoint/status/interrupted 事件被丢弃", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "hi" }),
      mk(1, "usage", { promptTokens: 1, completionTokens: 2 }),
      mk(2, "checkpoint", { summary: "x" }),
      mk(3, "status", { status: "done", finishReason: "no_tool_calls" }),
      mk(4, "interrupted", { reason: "aborted" }),
    ]);

    expect(messages).toStrictEqual([{ role: "user", content: "hi" }]);
  });

  it("未知 type 事件抛错,不静默丢弃", () => {
    expect(() => buildMessages([mk(0, "mystery" as EventType, { content: "x" })])).toThrow();
  });

  it("tool_call 类型事件显式丢弃", () => {
    expect(buildMessages([mk(0, "tool_call", { id: "c1" })])).toStrictEqual([]);
  });

  it("事件 seq 必须严格递增", () => {
    expect(() =>
      buildMessages([
        mk(2, "user", { content: "b" }),
        mk(1, "user", { content: "a" }),
      ]),
    ).toThrow();
    expect(() =>
      buildMessages([
        mk(1, "user", { content: "a" }),
        mk(1, "user", { content: "b" }),
      ]),
    ).toThrow();
  });

  it("system/user 的 content 非字符串时抛错", () => {
    expect(() => buildMessages([mk(0, "system", { content: 1 })])).toThrow();
    expect(() => buildMessages([mk(0, "user", {})])).toThrow();
  });

  it("assistant 缺 toolCalls 或 toolCalls 非数组时抛错", () => {
    expect(() => buildMessages([mk(0, "assistant", { content: "x" })])).toThrow();
    expect(() =>
      buildMessages([mk(0, "assistant", { content: "x", toolCalls: "nope" })]),
    ).toThrow();
    expect(() =>
      buildMessages([mk(0, "assistant", { content: 1, toolCalls: [] })]),
    ).toThrow();
  });

  it("assistant toolCalls 字段非法时抛错", () => {
    expect(() =>
      buildMessages([mk(0, "assistant", { content: "", toolCalls: [{ id: 1, name: "echo", arguments: {} }] })]),
    ).toThrow();
    expect(() =>
      buildMessages([mk(0, "assistant", { content: "", toolCalls: [{ id: "c1", name: 2, arguments: {} }] })]),
    ).toThrow();
    expect(() =>
      buildMessages([mk(0, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo" }] })]),
    ).toThrow();
    expect(() =>
      buildMessages([mk(0, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: [] }] })]),
    ).toThrow();
    expect(() =>
      buildMessages([mk(0, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: null }] })]),
    ).toThrow();
  });

  it("tool_result 的 parent 指向自身之后时抛错", () => {
    expect(() =>
      buildMessages([
        mk(0, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] }),
        mk(1, "tool_result", { id: "c1", text: "x" }, 2),
      ]),
    ).toThrow(/must precede it/);
  });

  it("tool_result 的 parent 更小但不存在时抛错", () => {
    expect(() =>
      buildMessages([mk(5, "tool_result", { id: "c1", text: "x" }, 3)]),
    ).toThrow(/not found/);
  });

  it("tool_result 的 parent 未指向 assistant 时抛错", () => {
    expect(() =>
      buildMessages([
        mk(0, "user", { content: "hi" }),
        mk(1, "tool_result", { id: "c1", text: "x" }, 0),
      ]),
    ).toThrow();
  });

  it("tool_result 无 parent 时抛错", () => {
    expect(() => buildMessages([mk(0, "tool_result", { id: "c1", text: "x" })])).toThrow(
      /must have a parent/,
    );
  });

  it("tool_result 的 id/text 非字符串时抛错", () => {
    expect(() =>
      buildMessages([
        mk(0, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] }),
        mk(1, "tool_result", { id: 1, text: "x" }, 0),
      ]),
    ).toThrow();
    expect(() =>
      buildMessages([
        mk(0, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] }),
        mk(1, "tool_result", { id: "c1" }, 0),
      ]),
    ).toThrow();
  });

  it("parent 按 seq 解析并允许 seq 间隔", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "hi" }),
      mk(5, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] }),
      mk(9, "tool_result", { id: "c1", ok: true, text: "x" }, 5),
    ]);

    expect(messages.map((message) => message.role)).toStrictEqual(["user", "assistant", "tool"]);
    expect(messages[2]).toStrictEqual({ role: "tool", tool_call_id: "c1", content: "x" });
  });

  it("tool_result 的 parent seq 必须先于自身", () => {
    expect(() =>
      buildMessages([
        mk(0, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] }),
        mk(1, "tool_result", { id: "c1", text: "x" }, 2),
      ]),
    ).toThrow(/must precede it/);
  });

  it("tool_result 的 id 必须属于 parent 的 toolCalls", () => {
    expect(() =>
      buildMessages([
        mk(0, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] }),
        mk(1, "tool_result", { id: "c2", text: "x" }, 0),
      ]),
    ).toThrow(/not found in parent/);
  });

  it("assistant 声明的 toolCalls 未全部收到结果时抛错", () => {
    expect(() =>
      buildMessages([
        mk(0, "assistant", {
          content: "",
          toolCalls: [
            { id: "c1", name: "echo", arguments: {} },
            { id: "c2", name: "echo", arguments: {} },
          ],
        }),
        mk(1, "tool_result", { id: "c1", text: "x" }, 0),
      ]),
    ).toThrow(/missing tool_result/);
  });

  it("tool_result 的 id 重复时抛错", () => {
    expect(() =>
      buildMessages([
        mk(0, "assistant", {
          content: "",
          toolCalls: [
            { id: "c1", name: "echo", arguments: {} },
            { id: "c2", name: "echo", arguments: {} },
          ],
        }),
        mk(1, "tool_result", { id: "c1", text: "x" }, 0),
        mk(2, "tool_result", { id: "c1", text: "x" }, 0),
      ]),
    ).toThrow(/duplicate/);
  });

  it("assistant 声明重复 tool call id 时抛错", () => {
    expect(() =>
      buildMessages([
        mk(0, "assistant", {
          content: "",
          toolCalls: [
            { id: "dup", name: "echo", arguments: {} },
            { id: "dup", name: "echo", arguments: {} },
          ],
        }),
      ]),
    ).toThrow(/duplicate tool call id/);
  });

  it("tool_result 乱序到达时按事件顺序投影", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "x" }),
      mk(1, "assistant", {
        content: "",
        toolCalls: [
          { id: "c1", name: "echo", arguments: {} },
          { id: "c2", name: "echo", arguments: {} },
        ],
      }),
      mk(2, "tool_result", { id: "c2", text: "b" }, 1),
      mk(3, "tool_result", { id: "c1", text: "a" }, 1),
    ]);

    expect(messages.map((message) => [message.role, message.tool_call_id ?? ""])).toEqual([
      ["user", ""],
      ["assistant", ""],
      ["tool", "c2"],
      ["tool", "c1"],
    ]);
  });

  it("tool 批次未完成时插入 user 抛错", () => {
    expect(() =>
      buildMessages([
        mk(0, "assistant", {
          content: "",
          toolCalls: [
            { id: "c1", name: "echo", arguments: {} },
            { id: "c2", name: "echo", arguments: {} },
          ],
        }),
        mk(1, "user", { content: "打断" }),
        mk(2, "tool_result", { id: "c1", text: "x" }, 0),
        mk(3, "tool_result", { id: "c2", text: "y" }, 0),
      ]),
    ).toThrow(/tool batch/);
  });

  it("system 出现在 user 之后时抛错", () => {
    expect(() =>
      buildMessages([
        mk(0, "user", { content: "hi" }),
        mk(1, "system", { content: "SYS" }),
      ]),
    ).toThrow(/system/);
  });

  it("不修改输入事件", () => {
    const events: SessionEvent[] = [
      mk(0, "system", { content: "SYS" }),
      mk(1, "user", { content: "hello" }),
      mk(2, "assistant", {
        content: "calling",
        toolCalls: [{ id: "c1", name: "echo", arguments: { text: "x" } }],
      }),
      mk(3, "tool_result", { id: "c1", ok: true, text: "x" }, 2),
    ];
    const snapshot = JSON.stringify(events);

    buildMessages(events);

    expect(JSON.stringify(events)).toBe(snapshot);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
  });
});
