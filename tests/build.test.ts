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
        toolCalls: [{ id: "c1", name: "echo", arguments: { error: "invalid_json", raw: "{bad" }, invalidJson: true }],
      }),
      mk(1, "tool_result", { id: "c1", ok: false, text: "bad" }, 0),
    ]);

    expect(messages[0].tool_calls?.[0].function.arguments).toBe("{bad");
  });

  it("未标记 invalidJson 的同形 arguments 按普通对象序列化(D-038)", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: { error: "invalid_json", raw: "{bad" } }],
      }),
      mk(1, "tool_result", { id: "c1", ok: false, text: "bad" }, 0),
    ]);

    expect(messages[0].tool_calls?.[0].function.arguments).toBe(
      '{"error":"invalid_json","raw":"{bad"}',
    );
  });

  it("usage/checkpoint/status/interrupted/compaction 事件被丢弃", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "hi" }),
      mk(1, "usage", { promptTokens: 1, completionTokens: 2 }),
      mk(2, "checkpoint", { summary: "x" }),
      mk(3, "status", { status: "done", finishReason: "no_tool_calls" }),
      mk(4, "interrupted", { reason: "aborted" }),
      mk(5, "compaction", { summary: "compacted" }),
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

  it("microcompact 替换非 evidence 结果并保留 evidence 原文", () => {
    const evidenceText = `evidence body\n${"x".repeat(200)}`;
    const messages = buildMessages([
      mk(0, "system", { content: "SYS" }),
      mk(1, "assistant", {
        content: "",
        toolCalls: [
          { id: "c1", name: "reg_read", arguments: {} },
          { id: "c2", name: "echo", arguments: {} },
        ],
      }),
      mk(
        2,
        "tool_result",
        { id: "c1", ok: true, text: evidenceText, toolName: "reg_read", evidence: true },
        1,
      ),
      mk(
        3,
        "tool_result",
        { id: "c2", ok: true, text: `first line\nsecond line${"x".repeat(100)}`, toolName: "echo" },
        1,
      ),
      mk(4, "compaction", { kind: "microcompact", elidedSeqs: [2, 3], note: "trim" }),
    ]);

    expect(messages.map((message) => message.role)).toStrictEqual([
      "system",
      "assistant",
      "tool",
      "tool",
    ]);
    expect(messages[2]).toStrictEqual({ role: "tool", tool_call_id: "c1", content: evidenceText });
    expect(messages[3]).toStrictEqual({
      role: "tool",
      tool_call_id: "c2",
      content: "[tool result elided; echo: first line]",
    });
  });

  it("microcompact 对已有 artifactPath 的结果引用完整输出", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(
        1,
        "tool_result",
        { id: "c1", ok: true, text: `big output ${"x".repeat(100)}`, toolName: "echo", artifactPath: "/tmp/a.txt" },
        0,
      ),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ]);

    expect(messages[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "[tool result elided; full output at /tmp/a.txt]",
    });
  });

  it("多个 microcompact 的 elidedSeqs 取并集", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [
          { id: "c1", name: "echo", arguments: {} },
          { id: "c2", name: "echo", arguments: {} },
          { id: "c3", name: "echo", arguments: {} },
        ],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text: `one\n${"x".repeat(100)}`, toolName: "echo" }, 0),
      mk(2, "tool_result", { id: "c2", ok: true, text: `two\n${"y".repeat(100)}`, toolName: "echo" }, 0),
      mk(3, "tool_result", { id: "c3", ok: true, text: `three\n${"x".repeat(100)}`, toolName: "echo" }, 0),
      mk(4, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "a" }),
      mk(5, "compaction", { kind: "microcompact", elidedSeqs: [3], note: "b" }),
    ]);

    expect(messages[1].content).toBe("[tool result elided; echo: one]");
    expect(messages[2].content).toBe(`two\n${"y".repeat(100)}`);
    expect(messages[3].content).toBe("[tool result elided; echo: three]");
  });

  it("evidence 结果同时带 artifactPath 时保留原文", () => {
    const text = `evidence body ${"x".repeat(100)}`;
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "reg_read", arguments: {} }],
      }),
      mk(
        1,
        "tool_result",
        { id: "c1", ok: true, text, toolName: "reg_read", artifactPath: "/tmp/a.txt", evidence: true },
        0,
      ),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ]);

    expect(messages[1]).toStrictEqual({ role: "tool", tool_call_id: "c1", content: text });
  });

  it("toolName 缺失时占位使用 tool 回退", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text: `first line\n${"x".repeat(100)}` }, 0),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ]);

    expect(messages[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "[tool result elided; tool: first line]",
    });
  });

  it("elidedSeqs 中的浮点 seq 不参与替换", () => {
    const text = `keep me\n${"x".repeat(100)}`;
    const messages = buildMessages([
      mk(0, "user", { content: "hi" }),
      mk(0.5, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1.5, "tool_result", { id: "c1", ok: true, text, toolName: "echo" }, 0.5),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1.5], note: "trim" }),
    ]);

    expect(messages[2]).toStrictEqual({ role: "tool", tool_call_id: "c1", content: text });
  });

  it("summary 与 microcompact 同时生效", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "old" }),
      mk(1, "compaction", { kind: "summary", summary: "SUM", coversUpToSeq: 0 }),
      mk(2, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(3, "tool_result", { id: "c1", ok: true, text: `result\n${"x".repeat(100)}`, toolName: "echo" }, 2),
      mk(4, "compaction", { kind: "microcompact", elidedSeqs: [3], note: "trim" }),
      mk(5, "user", { content: "new" }),
    ]);

    expect(messages).toStrictEqual([
      { role: "system", content: "[Conversation summary]\nSUM" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "[tool result elided; echo: result]" },
      { role: "user", content: "new" },
    ]);
  });

  it("microcompact 首行截断不切断代理对", () => {
    const firstLine = "a".repeat(119) + "😀" + "tail" + "z".repeat(100);
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text: firstLine, toolName: "echo" }, 0),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ]);

    expect(messages[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: `[tool result elided; echo: ${"a".repeat(119)}]`,
    });
  });

  it("microcompact 首行恰好 120 字符时不截断", () => {
    const firstLine = "a".repeat(120);
    const text = `${firstLine}\n${"x".repeat(200)}`;
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text, toolName: "echo" }, 0),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ]);

    expect(messages[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: `[tool result elided; echo: ${firstLine}]`,
    });
  });

  it("microcompact 首行按 CRLF 切分", () => {
    const text = `first line\r\n${"x".repeat(200)}`;
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text, toolName: "echo" }, 0),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ]);

    expect(messages[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "[tool result elided; echo: first line]",
    });
  });

  it("microcompact 首行遇到连续空行时只取第一行", () => {
    const text = `first line\n\n${"x".repeat(200)}`;
    const events: SessionEvent[] = [
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text, toolName: "echo" }, 0),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ];

    expect(() => buildMessages(events)).not.toThrow();
    expect(buildMessages(events)[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "[tool result elided; echo: first line]",
    });
  });

  it("microcompact 首行在文件末尾换行时正常提取", () => {
    const text = `first line\n${"x".repeat(200)}\n`;
    const events: SessionEvent[] = [
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text, toolName: "echo" }, 0),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ];

    expect(() => buildMessages(events)).not.toThrow();
    expect(buildMessages(events)[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "[tool result elided; echo: first line]",
    });
  });

  it("summary 保留 system 与尾部,并在最后 system 后插入摘要", () => {
    const messages = buildMessages([
      mk(0, "system", { content: "SYS1" }),
      mk(1, "system", { content: "SYS2" }),
      mk(2, "user", { content: "old" }),
      mk(3, "assistant", { content: "old answer", toolCalls: [] }),
      mk(4, "compaction", { kind: "summary", summary: "SUM", coversUpToSeq: 3 }),
      mk(5, "user", { content: "new" }),
      mk(6, "assistant", { content: "new answer", toolCalls: [] }),
    ]);

    expect(messages).toStrictEqual([
      { role: "system", content: "SYS1" },
      { role: "system", content: "SYS2" },
      { role: "system", content: "[Conversation summary]\nSUM" },
      { role: "user", content: "new" },
      { role: "assistant", content: "new answer", tool_calls: [] },
    ]);
  });

  it("summary 的 coversUpToSeq 落在批次中间时忽略该 summary", () => {
    const events: SessionEvent[] = [
      mk(0, "user", { content: "hi" }),
      mk(1, "assistant", {
        content: "",
        toolCalls: [
          { id: "c1", name: "echo", arguments: {} },
          { id: "c2", name: "echo", arguments: {} },
        ],
      }),
      mk(2, "tool_result", { id: "c1", ok: true, text: "a" }, 1),
      mk(3, "tool_result", { id: "c2", ok: true, text: "b" }, 1),
      mk(4, "compaction", { kind: "summary", summary: "SUM", coversUpToSeq: 1 }),
    ];

    const messages = buildMessages(events);

    expect(messages).toStrictEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "echo", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "a" },
      { role: "tool", tool_call_id: "c2", content: "b" },
    ]);
  });

  it("summary 覆盖 evidence 时忽略 summary 并保留 evidence 原文", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "old" }),
      mk(1, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(2, "tool_result", { id: "c1", ok: true, text: "EVIDENCE-BODY", evidence: true }, 1),
      mk(3, "compaction", { kind: "summary", summary: "BAD", coversUpToSeq: 2 }),
      mk(4, "user", { content: "new" }),
    ]);

    expect(messages).toStrictEqual([
      { role: "user", content: "old" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "EVIDENCE-BODY" },
      { role: "user", content: "new" },
    ]);
  });

  it("无效 summary 回退到上一条有效 summary", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "old" }),
      mk(1, "compaction", { kind: "summary", summary: "OLD-VALID", coversUpToSeq: 0 }),
      mk(2, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(3, "tool_result", { id: "c1", ok: true, text: "EV", evidence: true }, 2),
      mk(4, "compaction", { kind: "summary", summary: "NEW-BAD", coversUpToSeq: 3 }),
      mk(5, "user", { content: "new" }),
    ]);

    expect(messages[0]).toStrictEqual({
      role: "system",
      content: "[Conversation summary]\nOLD-VALID",
    });
    expect(
      messages.some((message) => message.role === "tool" && message.content === "EV"),
    ).toBe(true);
    expect(messages.some((message) => message.content.includes("NEW-BAD"))).toBe(false);
  });

  it("summary 边界倒退时忽略较新的倒退 summary", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "u0" }),
      mk(1, "user", { content: "u1" }),
      mk(2, "user", { content: "u2" }),
      mk(3, "compaction", { kind: "summary", summary: "S1", coversUpToSeq: 2 }),
      mk(4, "user", { content: "u3" }),
      mk(5, "compaction", { kind: "summary", summary: "S2", coversUpToSeq: 1 }),
      mk(6, "user", { content: "u4" }),
    ]);

    expect(messages).toStrictEqual([
      { role: "system", content: "[Conversation summary]\nS1" },
      { role: "user", content: "u3" },
      { role: "user", content: "u4" },
    ]);
  });

  it("较新有效 summary 覆盖旧有效 summary", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "u0" }),
      mk(1, "user", { content: "u1" }),
      mk(2, "user", { content: "u2" }),
      mk(3, "compaction", { kind: "summary", summary: "OLD", coversUpToSeq: 2 }),
      mk(4, "user", { content: "u4" }),
      mk(5, "compaction", { kind: "summary", summary: "NEW", coversUpToSeq: 4 }),
      mk(6, "user", { content: "u6" }),
    ]);

    expect(messages).toStrictEqual([
      { role: "system", content: "[Conversation summary]\nNEW" },
      { role: "user", content: "u6" },
    ]);
  });

  it("边界覆盖完整工具批次时 summary 仍生效", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text: "result", toolName: "echo" }, 0),
      mk(2, "user", { content: "tail" }),
      mk(3, "compaction", { kind: "summary", summary: "SUM", coversUpToSeq: 1 }),
    ]);

    expect(messages).toStrictEqual([
      { role: "system", content: "[Conversation summary]\nSUM" },
      { role: "user", content: "tail" },
    ]);
  });

  it("coversUpToSeq 等于 summary 自身 seq 时拒绝", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "u0" }),
      mk(1, "compaction", { kind: "summary", summary: "BAD", coversUpToSeq: 1 }),
      mk(2, "user", { content: "u2" }),
    ]);

    expect(messages).toStrictEqual([
      { role: "user", content: "u0" },
      { role: "user", content: "u2" },
    ]);
  });

  it("coversUpToSeq 大于 summary 自身 seq 且小于 lastSeq 时拒绝", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "u0" }),
      mk(1, "compaction", { kind: "summary", summary: "BAD", coversUpToSeq: 2 }),
      mk(2, "user", { content: "u2" }),
      mk(3, "user", { content: "u3" }),
    ]);

    expect(messages).toStrictEqual([
      { role: "user", content: "u0" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
    ]);
  });

  it("coversUpToSeq 等于 lastSeq 但晚于 summary 自身 seq 时拒绝", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "u0" }),
      mk(1, "compaction", { kind: "summary", summary: "BAD", coversUpToSeq: 3 }),
      mk(2, "user", { content: "u2" }),
      mk(3, "user", { content: "u3" }),
    ]);

    expect(messages).toStrictEqual([
      { role: "user", content: "u0" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
    ]);
  });

  it("elidedSeqs 非数组时忽略该 compaction", () => {
    const text = `first line\n${"x".repeat(200)}`;
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text, toolName: "echo" }, 0),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: 1, note: "bad" }),
    ]);

    expect(messages[1]).toStrictEqual({ role: "tool", tool_call_id: "c1", content: text });
  });

  it("toolName 非字符串时回退 tool", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text: `first line\n${"x".repeat(200)}`, toolName: 123 }, 0),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ]);

    expect(messages[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "[tool result elided; tool: first line]",
    });
  });

  it("artifactPath 非字符串时走首行占位", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(
        1,
        "tool_result",
        { id: "c1", ok: true, text: `first line\n${"x".repeat(200)}`, toolName: "echo", artifactPath: 123 },
        0,
      ),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ]);

    expect(messages[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "[tool result elided; echo: first line]",
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["空摘要", { kind: "summary", summary: "  ", coversUpToSeq: 2 }],
    ["非字符串摘要", { kind: "summary", summary: 42, coversUpToSeq: 2 }],
    ["非 number 边界", { kind: "summary", summary: "BAD", coversUpToSeq: "2" }],
    ["负边界", { kind: "summary", summary: "BAD", coversUpToSeq: -1 }],
    ["超过末条", { kind: "summary", summary: "BAD", coversUpToSeq: 99 }],
    ["非整数边界", { kind: "summary", summary: "BAD", coversUpToSeq: 1.5 }],
  ])("%s 的 summary 无效并回退到上一条", (_label, invalid) => {
    const messages = buildMessages([
      mk(0, "user", { content: "old" }),
      mk(1, "compaction", { kind: "summary", summary: "OLD-VALID", coversUpToSeq: 0 }),
      mk(2, "user", { content: "middle" }),
      mk(3, "compaction", invalid),
      mk(4, "user", { content: "new" }),
    ]);

    expect(messages).toStrictEqual([
      { role: "system", content: "[Conversation summary]\nOLD-VALID" },
      { role: "user", content: "middle" },
      { role: "user", content: "new" },
    ]);
  });

  it("microcompact 不替换占位更长的短结果", () => {
    const messages = buildMessages([
      mk(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }),
      mk(1, "tool_result", { id: "c1", ok: true, text: "ok", toolName: "echo" }, 0),
      mk(2, "compaction", { kind: "microcompact", elidedSeqs: [1], note: "trim" }),
    ]);

    expect(messages[1]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "ok",
    });
  });

  it("compaction 事件本身不产生消息", () => {
    const messages = buildMessages([
      mk(0, "user", { content: "hi" }),
      mk(1, "compaction", { kind: "microcompact", elidedSeqs: [], note: "none" }),
      mk(2, "compaction", { kind: "failed", reason: "boom", stage: "summary" }),
      mk(3, "user", { content: "again" }),
    ]);

    expect(messages).toStrictEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
    ]);
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
      mk(4, "compaction", { kind: "microcompact", elidedSeqs: [3], note: "trim" }),
      mk(5, "compaction", { kind: "summary", summary: "SUM", coversUpToSeq: 3 }),
    ];
    const snapshot = JSON.stringify(events);

    buildMessages(events);

    expect(JSON.stringify(events)).toBe(snapshot);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
