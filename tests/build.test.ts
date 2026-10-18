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

    expect(messages).toEqual([
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
    ]);

    expect(messages[0]).toMatchObject({ role: "assistant", content: "我先调用工具" });
    expect(messages[0].tool_calls).toEqual([
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
      mk(1, "assistant", { content: "no tools", toolCalls: [] }),
    ]);

    expect(messages[0].tool_calls?.map((call) => call.id)).toEqual(["c1", "c2"]);
    expect(messages[0].tool_calls?.map((call) => call.function.arguments)).toEqual([
      '{"text":"a"}',
      '{"text":"b"}',
    ]);
    expect(messages[1].tool_calls).toEqual([]);
  });

  it("invalid_json 标记的 toolCalls 回填原 raw 字符串", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: { error: "invalid_json", raw: "{bad" } }],
      }),
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

    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("未知 type 事件抛错,不静默丢弃", () => {
    expect(() => buildMessages([mk(0, "mystery" as EventType, { content: "x" })])).toThrow();
  });

  it("tool_call 类型不属于投影输入并抛错", () => {
    expect(() => buildMessages([mk(0, "tool_call", { id: "c1" })])).toThrow();
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

  it("tool_result 的 parent 不存在时抛错", () => {
    expect(() =>
      buildMessages([mk(0, "tool_result", { id: "c1", text: "x" }, 9)]),
    ).toThrow();
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
    expect(() => buildMessages([mk(0, "tool_result", { id: "c1", text: "x" })])).toThrow();
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

  it("parent 乱序也按 seq 解析归属", () => {
    const messages = buildMessages([
      mk(2, "tool_result", { id: "c1", ok: true, text: "x" }, 1),
      mk(1, "assistant", { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] }),
      mk(0, "user", { content: "hi" }),
    ]);

    expect(messages.map((message) => message.role)).toEqual(["tool", "assistant", "user"]);
    expect(messages[0]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "x" });
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