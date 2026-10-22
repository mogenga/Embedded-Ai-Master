import { describe, expect, it } from "vitest";
import {
  createContext,
  initialState,
  MAX_TOOL_OUTPUT_BYTES,
  modelsOf,
  providersEvent,
  sessionEventToHostEvents,
  sessionEventsToMessages,
  sessionExportName,
  sessionLoadedEvent,
  sessionMarkdown,
  sessionsEvent,
  summarizeToolCall,
} from "../../desktop/renderer/protocol.js";

function ev(seq, type, payload, parent) {
  const event = { seq, ts: "2026-10-20T00:00:00.000Z", type, payload };
  if (parent !== undefined) event.parent = parent;
  return event;
}

function translate(events, ctx = createContext({ sessionId: "s1" })) {
  const out = [];
  for (const event of events) out.push(...sessionEventToHostEvents(event, ctx));
  return { out, ctx };
}

describe("summarizeToolCall", () => {
  it("优先取 path/command/pattern 等命名参数", () => {
    expect(summarizeToolCall("read_file", { path: "src/a.ts", offset: 0 })).toBe("src/a.ts");
    expect(summarizeToolCall("shell", { command: "npm test" })).toBe("npm test");
    expect(summarizeToolCall("grep", { pattern: "TODO" })).toBe("TODO");
    expect(summarizeToolCall("probe", { address: 536870912 })).toBe("536870912");
  });

  it("无匹配参数时回退到工具名", () => {
    expect(summarizeToolCall("mcp__probe__halt", {})).toBe("mcp__probe__halt");
    expect(summarizeToolCall("mcp__probe__halt", null)).toBe("mcp__probe__halt");
  });

  it("长参数截断到 120 字符", () => {
    expect(summarizeToolCall("read_file", { path: "x".repeat(200) })).toHaveLength(120);
  });
});

describe("assistant 三段合成", () => {
  it("assistant 事件展开为 start/delta/end", () => {
    const { out, ctx } = translate([
      ev(0, "assistant", { content: "你好", toolCalls: [] }),
    ]);
    expect(out).toStrictEqual([
      { type: "assistant_start" },
      { type: "assistant_delta", text: "你好" },
      { type: "assistant_end" },
    ]);
    expect(ctx.lastAssistantText).toBe("你好");
  });

  it("空 content 也发 start/end，不发 delta", () => {
    const { out } = translate([ev(0, "assistant", { content: "", toolCalls: [] })]);
    expect(out).toStrictEqual([{ type: "assistant_start" }, { type: "assistant_end" }]);
  });

  it("记录 toolCalls 供 tool_started 摘要使用", () => {
    const { out, ctx } = translate([
      ev(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/a.ts" } }],
      }),
      ev(1, "tool_started", { callId: "c1", tool: "read_file", access: "read" }, 0),
    ]);
    expect(ctx.pendingCalls.get("c1")).toStrictEqual({
      name: "read_file",
      arguments: { path: "src/a.ts" },
    });
    expect(out).toContainEqual({
      type: "tool_start",
      name: "read_file",
      summary: "src/a.ts",
      id: "c1",
    });
  });

  it("tool_started 的注解透传，只保留 true 的键", () => {
    const { out } = translate([
      ev(0, "tool_started", {
        callId: "c1",
        tool: "read_file",
        annotations: { readOnly: true, destructive: false, evidence: true },
      }),
    ]);
    expect(out).toStrictEqual([
      {
        type: "tool_start",
        name: "read_file",
        summary: "read_file",
        id: "c1",
        annotations: { readOnly: true, evidence: true },
      },
    ]);
  });

  it("没有注解的旧日志不产出 annotations 字段", () => {
    const { out } = translate([ev(0, "tool_started", { callId: "c1", tool: "shell" })]);
    // A `false`-filled object would read as "known to be non-destructive"; the
    // absent field is what lets the consumer tell "unknown" apart.
    expect(out[0]).not.toHaveProperty("annotations");
    expect(Object.keys(out[0])).toStrictEqual(["type", "name", "summary", "id"]);
  });

  it("注解全为 false 或不是对象时也不产出 annotations", () => {
    const allFalse = translate([
      ev(0, "tool_started", { callId: "c1", tool: "shell", annotations: { destructive: false } }),
    ]);
    expect(allFalse.out[0]).not.toHaveProperty("annotations");
    const notRecord = translate([
      ev(0, "tool_started", { callId: "c1", tool: "shell", annotations: "read-only" }),
    ]);
    expect(notRecord.out[0]).not.toHaveProperty("annotations");
  });
});

describe("assistant_delta 流式片段", () => {
  it("增量片段逐条转成 assistant_delta", () => {
    const { out } = translate([
      ev(0, "assistant_delta", { text: "你" }),
      ev(1, "assistant_delta", { text: "好" }),
    ]);
    expect(out).toStrictEqual([
      { type: "assistant_delta", text: "你" },
      { type: "assistant_delta", text: "好" },
    ]);
  });

  it("完整 assistant 事件不重复已流式过的文本", () => {
    const { out } = translate([
      ev(0, "assistant_delta", { text: "你好" }),
      ev(1, "assistant", { content: "你好世界", toolCalls: [] }),
    ]);
    // start + 补齐的 "世界" + end：整段再发一次会让气泡显示两遍。
    expect(out).toStrictEqual([
      { type: "assistant_delta", text: "你好" },
      { type: "assistant_start" },
      { type: "assistant_delta", text: "世界" },
      { type: "assistant_end" },
    ]);
  });

  it("流式文本与完整文本不一致时以完整文本为准", () => {
    const { out } = translate([
      ev(0, "assistant_delta", { text: "部分" }),
      ev(1, "assistant", { content: "完整答案", toolCalls: [] }),
    ]);
    expect(out).toContainEqual({ type: "assistant_delta", text: "完整答案" });
    // 不重复已流式的部分。
    expect(out.filter((item) => item.type === "assistant_delta")).toHaveLength(2);
  });

  it("空片段不产出事件", () => {
    const { out } = translate([ev(0, "assistant_delta", { text: "" })]);
    expect(out).toStrictEqual([]);
  });
});

describe("tool_result", () => {
  it("成功时输出 tool_end + tool_output", () => {
    const { out } = translate([
      ev(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.ts" } }],
      }),
      ev(1, "tool_started", { callId: "c1", tool: "read_file" }, 0),
      ev(2, "tool_result", { id: "c1", ok: true, text: "file body", toolName: "read_file" }, 0),
    ]);
    const tail = out.slice(out.findIndex((item) => item.type === "tool_end"));
    expect(tail).toStrictEqual([
      { type: "tool_end", name: "read_file", ok: true, summary: "a.ts", id: "c1" },
      { type: "tool_output", name: "read_file", content: "file body" },
    ]);
  });

  it("失败时只发 tool_end，不把错误文本画成工具输出", () => {
    const { out } = translate([
      ev(0, "tool_result", { id: "c1", ok: false, text: "boom", toolName: "shell" }),
    ]);
    expect(out).toStrictEqual([
      // The call was refused before it started, so the row is created here —
      // otherwise a denied call would be missing from the transcript.
      { type: "tool_start", name: "shell", summary: "shell", id: "c1" },
      { type: "tool_end", name: "shell", ok: false, summary: "shell", id: "c1" },
    ]);
  });

  it("已有 tool_started 时 tool_result 不再补一行 tool_start", () => {
    const { out } = translate([
      ev(0, "tool_started", { callId: "c1", tool: "shell" }),
      ev(1, "tool_result", { id: "c1", ok: false, text: "boom", toolName: "shell" }),
    ]);
    expect(out.filter((item) => item.type === "tool_start")).toHaveLength(1);
  });

  it("超长输出按 UTF-8 字节截断且不产生替换字符", () => {
    const { out } = translate([
      ev(0, "tool_result", {
        id: "c1",
        ok: true,
        text: "😀".repeat(MAX_TOOL_OUTPUT_BYTES),
        toolName: "echo",
      }),
    ]);
    const output = out.find((item) => item.type === "tool_output");
    expect(output.content).toContain("…[truncated]");
    expect(output.content).not.toContain("�");
    const body = output.content.replace("\n…[truncated]", "");
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
  });

  it("tool_output 透传 artifactPath，没有产物时不带该字段", () => {
    const withArtifact = translate([
      ev(0, "tool_result", {
        id: "c1",
        ok: true,
        text: "抓取已保存",
        toolName: "mcp__probe__capture",
        artifactPath: "E:/home/sessions/s1/artifacts/capture.sr",
      }),
    ]).out.find((item) => item.type === "tool_output");
    expect(withArtifact.artifactPath).toBe("E:/home/sessions/s1/artifacts/capture.sr");

    const plain = translate([
      ev(0, "tool_result", { id: "c1", ok: true, text: "ok", toolName: "fs" }),
    ]).out.find((item) => item.type === "tool_output");
    expect(plain).not.toHaveProperty("artifactPath");
  });
});

describe("审批与权限", () => {
  it("approval_request → permission_request", () => {
    const { out } = translate([
      ev(0, "approval_request", {
        requestId: "req-1",
        callId: "c1",
        tool: "mcp__probe__mem_write",
        action: "ask",
        reason: "写 SRAM",
        preset: "diagnose",
        paramsDigest: "d",
        paramsKeys: ["address"],
        deadlineAt: "2026-10-20T00:01:00.000Z",
      }),
    ]);
    expect(out).toStrictEqual([
      {
        type: "permission_request",
        id: "req-1",
        question: "mcp__probe__mem_write: 写 SRAM",
        detail: {
          tool: "mcp__probe__mem_write",
          preset: "diagnose",
          paramsPreview: {},
          deadlineAt: "2026-10-20T00:01:00.000Z",
        },
      },
    ]);
  });

  it("permission_decision 拒绝时补 notice，允许时不产出", () => {
    const denied = translate([
      ev(0, "permission_decision", { callId: "c1", tool: "shell", effective: "deny", reason: "未授权" }),
    ]);
    expect(denied.out).toStrictEqual([
      { type: "notice", level: "warn", text: "已拒绝 shell：未授权" },
    ]);
    const allowed = translate([
      ev(0, "permission_decision", { callId: "c1", tool: "shell", effective: "allow", reason: "ok" }),
    ]);
    expect(allowed.out).toStrictEqual([]);
  });

  it("内核的原因码翻成人话，策略码不重复", () => {
    const { out } = translate([
      ev(0, "permission_decision", {
        callId: "c1",
        tool: "fs",
        effective: "deny",
        reason: "preset:diagnose:write;approval_timeout",
      }),
    ]);
    // `preset:…` is what the question already said; the useful half is why
    // the operator's answer never arrived.
    expect(out).toStrictEqual([
      { type: "notice", level: "warn", text: "已拒绝 fs：审批超时" },
    ]);
  });

  it("审批超时由 permission_decision 关闭审批条", () => {
    const ctx = createContext({ sessionId: "s1" });
    const asked = translate(
      [
        ev(0, "approval_request", { requestId: "req-1", callId: "c1", tool: "shell", reason: "r" }),
      ],
      ctx,
    );
    expect(asked.out[0].type).toBe("permission_request");
    const decided = translate(
      [ev(1, "permission_decision", { requestId: "req-1", callId: "c1", tool: "shell", effective: "deny", reason: "approval_timeout" })],
      ctx,
    );
    expect(decided.out).toStrictEqual([
      { type: "permission_closed", id: "req-1" },
      { type: "notice", level: "warn", text: "已拒绝 shell：审批超时" },
    ]);
    expect(ctx.pendingApprovals.size).toBe(0);
  });
});

describe("运行状态", () => {
  it("status done → run_end", () => {
    const ctx = createContext({ sessionId: "s1" });
    ctx.running = true;
    const { out } = translate([ev(0, "status", { status: "done", finishReason: "no_tool_calls" })], ctx);
    expect(out).toStrictEqual([{ type: "run_end" }]);
    expect(ctx.running).toBe(false);
  });

  it("interrupted → notice + run_end", () => {
    const { out, ctx } = translate([ev(0, "interrupted", { reason: "aborted" })]);
    expect(out).toStrictEqual([
      { type: "notice", level: "warn", text: "已中止" },
      { type: "run_end" },
    ]);
    expect(ctx.running).toBe(false);
  });

  it("usage → usage 事件字段映射", () => {
    const { out } = translate([
      ev(0, "usage", { promptTokens: 10, completionTokens: 2, cachedTokens: 3 }),
    ]);
    expect(out).toStrictEqual([
      { type: "usage", usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 3 } },
    ]);
  });

  it("usage 带上上下文占用与成本时一并透传，缺失则不带字段", () => {
    const { out } = translate([
      ev(0, "usage", {
        promptTokens: 10,
        completionTokens: 2,
        context: { tokens: 4200, percent: 51.3, window: 8192 },
        costUsd: 0.0123,
      }),
    ]);
    expect(out[0].context).toStrictEqual({ tokens: 4200, percent: 51.3, window: 8192 });
    expect(out[0].costUsd).toBe(0.0123);

    // A provider with no price writes no `costUsd`: absent means unknown, and
    // a zero here would read as "known to be free".
    const bare = translate([ev(0, "usage", { promptTokens: 1, completionTokens: 1 })]);
    expect(bare.out[0]).not.toHaveProperty("costUsd");
    expect(bare.out[0]).not.toHaveProperty("context");
  });
});

describe("usage 的分类拆分", () => {
  const breakdown = {
    used: 42000,
    window: 128000,
    percent: 32.8,
    compactAt: 102400,
    parts: [
      { key: "systemPrompt", tokens: 3200 },
      { key: "messages", tokens: 28900 },
      { key: "toolResults", tokens: 7000 },
      { key: "mcpTools", tokens: 2900 },
    ],
  };

  it("有生产者时原样透传拆分", () => {
    const { out } = translate([
      ev(0, "usage", { promptTokens: 10, completionTokens: 2, contextBreakdown: breakdown }),
    ]);
    expect(out[0].contextBreakdown).toStrictEqual(breakdown);
  });

  it("没有拆分字段的老日志不带这个字段（缺席不是 null）", () => {
    const { out } = translate([ev(0, "usage", { promptTokens: 10, completionTokens: 2 })]);
    expect(out[0]).not.toHaveProperty("contextBreakdown");
    expect(Object.keys(out[0])).toStrictEqual(["type", "usage"]);
  });

  it("逐项丢掉坏类别，其余保留", () => {
    const { out } = translate([
      ev(0, "usage", {
        promptTokens: 1,
        contextBreakdown: {
          ...breakdown,
          parts: [
            { key: "messages", tokens: 100 },
            { key: "", tokens: 5 },
            { key: "toolResults", tokens: 0 },
            { key: "mcpTools", tokens: -1 },
            { key: "systemPrompt", tokens: "3200" },
            { key: "systemPrompt", tokens: Number.POSITIVE_INFINITY },
            { key: 3, tokens: 5 },
            null,
            "messages",
          ],
        },
      }),
    ]);
    expect(out[0].contextBreakdown.parts).toStrictEqual([{ key: "messages", tokens: 100 }]);
  });

  it("四个数字缺一个或不是有限数就整条不算拆分", () => {
    const invalid = [
      { ...breakdown, used: undefined },
      { ...breakdown, used: "42000" },
      { ...breakdown, used: Number.NaN },
      { ...breakdown, window: 0 },
      { ...breakdown, window: -128000 },
      { ...breakdown, window: Number.POSITIVE_INFINITY },
      { ...breakdown, percent: null },
      { ...breakdown, compactAt: undefined },
      { ...breakdown, compactAt: "102400" },
      { ...breakdown, parts: [] },
      { ...breakdown, parts: "x" },
      { ...breakdown, parts: [{ key: "", tokens: 1 }] },
    ];
    for (const contextBreakdown of invalid) {
      const { out } = translate([
        ev(0, "usage", { promptTokens: 1, contextBreakdown }),
      ]);
      // The field is present in the payload, so the answer travels — it is
      // `null`, which says "reported, not drawable", not "never reported".
      expect(out[0].contextBreakdown).toBeNull();
    }
    // A payload without the field keeps the field off the message entirely.
    const { out } = translate([ev(0, "usage", { promptTokens: 1, contextBreakdown: "x" })]);
    expect(out[0]).not.toHaveProperty("contextBreakdown");
  });
});

describe("compaction failed 的两种非失败原因", () => {
  it("no_progress 是 dim 提示，不是红色失败", () => {
    const { out } = translate([
      ev(0, "compaction", { kind: "failed", reason: "no_progress", stage: "summary" }),
    ]);
    expect(out).toStrictEqual([
      { type: "notice", level: "dim", text: "压缩没有进展（上一次摘要已经覆盖到这里）" },
    ]);
  });

  it("no summarizable content 同样是 dim", () => {
    const { out } = translate([
      ev(0, "compaction", { kind: "failed", reason: "no summarizable content", stage: "summary" }),
    ]);
    expect(out).toStrictEqual([{ type: "notice", level: "dim", text: "没有可压缩的内容" }]);
  });

  it("其他原因仍然是带阶段的 warn", () => {
    const { out } = translate([
      ev(0, "compaction", { kind: "failed", reason: "provider_error", stage: "summary" }),
    ]);
    expect(out).toStrictEqual([
      { type: "notice", level: "warn", text: "压缩失败（summary）: provider_error" },
    ]);
  });
});

describe("其他事件", () => {
  it("device_status → device_status 携带原始 state", () => {
    const { out } = translate([
      ev(0, "device_status", {
        callId: "c1",
        server: "probe",
        tool: "mcp__probe__attach",
        state: { probe: "attached", cpu: "halted" },
      }),
    ]);
    expect(out).toHaveLength(1);
    // A separate event, not a `board_state`: the probe reports four fields and
    // the board pane reads a different set (target, ports, scan), so folding
    // one into the other blanked the pane.
    expect(out[0].type).toBe("device_status");
    expect(out[0].device).toStrictEqual({ probe: "attached", cpu: "halted" });
    expect(out[0].tool).toBe("mcp__probe__attach");
    expect(out[0].server).toBe("probe");
  });

  it("mcp_status 成功为 dim、失败为 warn", () => {
    expect(
      translate([ev(0, "mcp_status", { kind: "connected", server: "probe", toolCount: 2 })]).out,
    ).toStrictEqual([{ type: "notice", level: "dim", text: "MCP probe: connected" }]);
    expect(
      translate([ev(0, "mcp_status", { kind: "connect_failed", server: "kb", message: "spawn" })]).out,
    ).toStrictEqual([{ type: "notice", level: "warn", text: "MCP kb: connect_failed — spawn" }]);
  });

  it("compaction summary 产出 compacted", () => {
    const { out } = translate([
      ev(0, "compaction", { kind: "summary", summary: "s", coversUpToSeq: 4 }),
    ]);
    // `coversUpToSeq` is an event number, not a token count: it is reported
    // as-is and the before/after figures stay 0 so the renderer omits them.
    expect(out).toStrictEqual([
      { type: "compacted", removed: 0, level: "summary", before: 0, after: 0, coversUpToSeq: 4 },
    ]);
  });

  it("user/system/checkpoint/tool_call 不产出", () => {
    const { out } = translate([
      ev(0, "system", { content: "sys" }),
      ev(1, "user", { content: "hi" }),
      ev(2, "checkpoint", { turn: 1 }),
      ev(3, "tool_call", { id: "c1" }),
    ]);
    expect(out).toStrictEqual([]);
  });

  it("未知类型显式 warn 而不是静默", () => {
    const { out } = translate([ev(0, "mystery", {})]);
    expect(out).toStrictEqual([
      { type: "notice", level: "warn", text: "未识别的事件类型: mystery" },
    ]);
  });

  it("重复 seq 被游标丢弃", () => {
    const ctx = createContext({ sessionId: "s1" });
    translate([ev(3, "assistant", { content: "a", toolCalls: [] })], ctx);
    const again = sessionEventToHostEvents(ev(3, "assistant", { content: "a", toolCalls: [] }), ctx);
    expect(again).toStrictEqual([]);
    expect(ctx.lastSeq).toBe(3);
  });
});

describe("sessionEventsToMessages", () => {
  const events = [
    ev(0, "system", { content: "sys" }),
    ev(1, "user", { content: "串口没输出" }),
    ev(2, "assistant", {
      content: "先看 KB",
      toolCalls: [{ id: "c1", name: "mcp__kb__kb_lookup", arguments: { query: "串口" } }],
    }),
    ev(3, "tool_started", { callId: "c1", tool: "mcp__kb__kb_lookup" }, 2),
    ev(4, "tool_result", { id: "c1", ok: true, text: "hit", toolName: "mcp__kb__kb_lookup" }, 2),
  ];

  it("重建 user/assistant/tool 行", () => {
    expect(sessionEventsToMessages(events)).toStrictEqual([
      { role: "user", text: "串口没输出", index: 0, images: 0 },
      { role: "assistant", text: "先看 KB" },
      {
        role: "tool",
        name: "mcp__kb__kb_lookup",
        summary: "串口",
        ok: true,
        done: true,
      },
    ]);
  });

  it("空对话返回空数组", () => {
    expect(sessionEventsToMessages([])).toStrictEqual([]);
    expect(sessionEventsToMessages(undefined)).toStrictEqual([]);
  });
});

describe("state / sessions / session_loaded", () => {
  it("initialState 使用内核预设与模型引用", () => {
    const state = initialState({
      sessionId: "s1",
      cwd: "E:/proj",
      mode: "diagnose",
      model: "gw/flash",
      models: [{ id: "gw/flash", name: "flash", contextLength: 8192 }],
    });
    expect(state).toMatchObject({
      type: "state",
      sessionId: "s1",
      cwd: "E:/proj",
      mode: "diagnose",
      model: "gw/flash",
      locale: "zh",
      effortChoices: { levels: [], default: "", fixed: "" },
    });
    expect(state.models).toHaveLength(1);
  });

  it("initialState 没有上下文测量时 context 为 null，不是 0%", () => {
    // R3: unknown is not zero. A `{tokens: 0, percent: 0}` default painted
    // "0%" for a session nobody had measured.
    const bare = initialState({ sessionId: "s1" });
    expect(bare.context).toBeNull();
    expect(bare).not.toHaveProperty("costUsd");
    expect(bare.contextBreakdown).toBeNull();
  });

  it("initialState 原样带上真实的上下文占用与成本", () => {
    const measured = initialState({
      sessionId: "s1",
      context: { tokens: 1234, percent: 12.3, window: 128000 },
      costUsd: 0.42,
    });
    expect(measured.context).toStrictEqual({ tokens: 1234, percent: 12.3, window: 128000 });
    expect(measured.costUsd).toBe(0.42);
  });

  it("initialState 透传调用方给的分类拆分", () => {
    const contextBreakdown = {
      used: 42000,
      window: 128000,
      percent: 32.8,
      compactAt: 102400,
      parts: [{ key: "messages", tokens: 42000 }],
    };
    const state = initialState({ sessionId: "s1", contextBreakdown });
    expect(state.contextBreakdown).toStrictEqual(contextBreakdown);
    // The split and the total are independent fields: a caller with only a
    // split still gets no fabricated `context`.
    expect(state.context).toBeNull();
  });

  it("initialState 拒绝残缺的拆分，降级为 null", () => {
    const valid = {
      used: 10,
      window: 100,
      percent: 10,
      compactAt: 80,
      parts: [{ key: "messages", tokens: 10 }],
    };
    const invalid = [
      undefined,
      null,
      "x",
      [],
      { ...valid, used: undefined },
      { ...valid, window: 0 },
      { ...valid, percent: Number.NaN },
      { ...valid, compactAt: null },
      { ...valid, parts: [] },
      { ...valid, parts: [{ key: "nope", tokens: 0 }] },
    ];
    for (const contextBreakdown of invalid) {
      expect(initialState({ contextBreakdown }).contextBreakdown).toBeNull();
    }
  });

  it("initialState 只在 window 有限且为正时带上它", () => {
    expect(initialState({ context: { tokens: 10, percent: 1 } }).context).toStrictEqual({
      tokens: 10,
      percent: 1,
    });
    for (const window of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "8192", null]) {
      expect(initialState({ context: { tokens: 10, percent: 1, window } }).context).toStrictEqual({
        tokens: 10,
        percent: 1,
      });
    }
  });

  it("initialState 拒绝残缺或非数值的上下文，降级为 null", () => {
    // A record missing either half is not a measurement: filling the other
    // with 0 would show a figure the kernel never reported.
    const invalid = [
      { tokens: 10 },
      { percent: 1 },
      { tokens: "10", percent: 1 },
      { tokens: 10, percent: "1" },
      { tokens: Number.NaN, percent: 1 },
      { tokens: 10, percent: Number.POSITIVE_INFINITY },
      {},
    ];
    for (const context of invalid) {
      expect(initialState({ context }).context).toBeNull();
    }
    expect(initialState({ context: [] }).context).toBeNull();
    expect(initialState({ context: "3000" }).context).toBeNull();
    expect(initialState({ context: null }).context).toBeNull();
  });

  it("initialState 接受真实的 0 测量：0 是数字，缺字段才是未知", () => {
    // The kernel never writes a zero measurement (query.ts skips it), but
    // when a caller does hand over one it is a reported figure, not a gap:
    // the "unknown" sentinel is `null`, not a magic zero.
    expect(initialState({ context: { tokens: 0, percent: 0 } }).context).toStrictEqual({
      tokens: 0,
      percent: 0,
    });
  });

  it("sessionsEvent 把 workdir 映射为 cwd 并给出 renderer 需要的字段", () => {
    const event = sessionsEvent([
      { id: "s1", createdAt: "2026-10-20T00:00:00.000Z", status: "closed", workdir: "E:/p", model: "gw/flash" },
    ]);
    expect(event.sessions[0]).toStrictEqual({
      id: "s1",
      cwd: "E:/p",
      model: "gw/flash",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      title: "",
      summary: "s1",
      pinned: false,
      archived: false,
      status: "ready",
    });
    expect(event.total).toBe(1);
  });

  it("sessionsEvent 采用内核给的标题、置顶与更新时间", () => {
    const event = sessionsEvent([
      {
        id: "s1",
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-21T09:00:00.000Z",
        status: "closed",
        workdir: "E:/p",
        title: "串口无输出",
        pinned: true,
        archived: true,
      },
    ]);
    expect(event.sessions[0]).toMatchObject({
      title: "串口无输出",
      // The summary the row falls back to is the title, not the id.
      summary: "串口无输出",
      pinned: true,
      archived: true,
      updatedAt: "2026-10-21T09:00:00.000Z",
    });
  });

  it("sessionLoadedEvent 携带消息、模式与本次会话用量", () => {
    const event = sessionLoadedEvent(
      [
        ev(0, "user", { content: "hi" }),
        ev(1, "usage", { promptTokens: 10, completionTokens: 2, cachedTokens: 3 }),
        ev(2, "usage", { promptTokens: 4 }),
      ],
      { cwd: "E:/p", mode: "read-only" },
    );
    expect(event).toStrictEqual({
      type: "session_loaded",
      messages: [{ role: "user", text: "hi", index: 0, images: 0 }],
      cwd: "E:/p",
      mode: "read-only",
      effort: "auto",
      // usage events are per model call; the popover says "this session".
      usage: { inputTokens: 14, outputTokens: 2, cachedTokens: 3 },
    });
  });

  it("sessionLoadedEvent 的成本取最后一条带 costUsd 的用量事件", () => {
    const event = sessionLoadedEvent([
      ev(0, "usage", { promptTokens: 1, costUsd: 0.01 }),
      ev(1, "usage", { promptTokens: 1 }),
      ev(2, "usage", { promptTokens: 1, costUsd: 0.02 }),
    ]);
    // `costUsd` is the running session total, not this call's share.
    expect(event.costUsd).toBe(0.02);
    // No priced call at all: the field is absent, so the renderer can hide the
    // row instead of printing "$0.00" for a provider that has no price.
    expect(sessionLoadedEvent([ev(0, "usage", { promptTokens: 1 })])).not.toHaveProperty("costUsd");
  });
});

describe("导出", () => {
  const log = [
    ev(0, "user", { content: "串口没输出" }),
    ev(1, "assistant", {
      content: "先查一下",
      toolCalls: [{ id: "c1", name: "mcp__probe__attach", arguments: { target: "stm32" } }],
    }),
    ev(2, "tool_result", {
      id: "c1",
      ok: true,
      text: "attached",
      toolName: "mcp__probe__attach",
      artifactPath: "E:/home/sessions/s1/artifacts/capture.txt",
    }),
    ev(3, "tool_result", { id: "c2", ok: false, text: "boom", toolName: "shell" }),
    ev(4, "interrupted", { reason: "aborted" }),
    ev(5, "checkpoint", { turn: 1 }),
  ];

  it("按日志渲染 Markdown：用户/助手/工具/产物/中断，跳过 checkpoint", () => {
    const md = sessionMarkdown(log, { title: "串口没输出" });
    expect(md.startsWith("# 串口没输出")).toBe(true);
    expect(md).toContain("## User\n\n串口没输出");
    expect(md).toContain("## Assistant\n\n先查一下");
    expect(md).toContain("- `mcp__probe__attach` {\"target\":\"stm32\"}");
    expect(md).toContain("### mcp__probe__attach");
    expect(md).toContain("```\nattached\n```");
    expect(md).toContain("Artifact: `E:/home/sessions/s1/artifacts/capture.txt`");
    expect(md).toContain("### shell (failed)");
    expect(md).toContain("> Interrupted: aborted");
    expect(md).not.toContain("checkpoint");
  });

  it("超长工具输出截断，空日志也有标题", () => {
    const md = sessionMarkdown([ev(0, "tool_result", { id: "c", ok: true, toolName: "t", text: "x".repeat(5000) })]);
    expect(md).toContain("…[truncated]");
    expect(md.length).toBeLessThan(2500);
    expect(sessionMarkdown([])).toBe("# Conversation\n");
  });

  it("导出文件名去掉路径非法字符", () => {
    expect(sessionExportName("s1", "a/b:c*?")).toBe("a-b-c-.md");
    expect(sessionExportName("s1", "")).toBe("s1.md");
    expect(sessionExportName("", "")).toBe("session.md");
  });
});

describe("providers 配置的两种形状", () => {
  it("providersEvent 把文件拆成选单列表与可编辑对象", () => {
    const config = {
      gw: {
        protocol: "openai-chat-completions",
        baseUrl: "https://gw.example/v1",
        apiKeyEnv: "GW_KEY",
        models: { flash: { contextWindow: 128000, maxOutput: 4096 } },
      },
      backup: {
        protocol: "openai-chat-completions",
        baseUrl: "https://backup.example/v1",
        models: { slow: { contextWindow: 4096, maxOutput: 256 } },
      },
    };
    const { providers, providerConfig } = providersEvent(config);
    // The picker's flat list: one row per provider, carrying its URL.
    expect(providers).toStrictEqual([
      { id: "gw", baseUrl: "https://gw.example/v1" },
      { id: "backup", baseUrl: "https://backup.example/v1" },
    ]);
    // The file itself, untouched: the settings page saves this shape back.
    expect(providerConfig).toStrictEqual(config);
  });

  it("modelsOf 跨 provider 展开成 provider/model 引用", () => {
    const models = modelsOf({
      gw: { models: { flash: { contextWindow: 128000, maxOutput: 4096 } } },
      backup: { models: { slow: { contextWindow: 4096, maxOutput: 256 } } },
    });
    expect(models).toStrictEqual([
      { id: "gw/flash", name: "flash", contextLength: 128000, supportsTools: true, supportsReasoning: false, supportsVision: false },
      { id: "backup/slow", name: "slow", contextLength: 4096, supportsTools: true, supportsReasoning: false, supportsVision: false },
    ]);
  });

  it("非对象输入不算配置，也不编造条目", () => {
    expect(providersEvent(null)).toStrictEqual({ providers: [], providerConfig: undefined });
    expect(providersEvent("nope").providers).toStrictEqual([]);
    expect(modelsOf(undefined)).toStrictEqual([]);
  });
});
