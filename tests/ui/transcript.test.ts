import { describe, expect, it } from "vitest";
import {
  emptyTranscriptView,
  TRANSCRIPT_KINDS,
  transcriptFromSession,
  transcriptFromLoop,
  reduceStep,
} from "../../src/ui/view/transcript.js";
import type { TranscriptEvent } from "../../src/ui/view/transcript.js";
import type { SessionEvent } from "../../src/session/types.js";
import type { LoopEvent } from "../../src/loop/events.js";
import { makeSessionEvents } from "./support/builders.js";

function toolPair(result: Record<string, unknown>): SessionEvent[] {
  return [
    {
      seq: 1,
      ts: "t",
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [{ id: "c1", name: "serial_read", arguments: { port: "COM3" } }],
      },
    },
    { seq: 2, ts: "t", parent: 1, type: "tool_result", payload: { id: "c1", ...result } },
  ];
}

function lastTool(events: readonly SessionEvent[]): Extract<TranscriptEvent, { kind: "tool" }> {
  const view = transcriptFromSession(events);
  return view.events.filter((e) => e.kind === "tool").at(-1) as Extract<TranscriptEvent, { kind: "tool" }>;
}

function approvalEvents(): SessionEvent[] {
  return [
    { seq: 1, ts: "t", type: "user", payload: { content: "症状" } },
    {
      seq: 2,
      ts: "t",
      type: "assistant",
      payload: { content: "", toolCalls: [{ id: "c1", name: "mem_write", arguments: { address: "0x0", value: "1" } }] },
    },
    {
      seq: 3,
      ts: "t",
      parent: 2,
      type: "approval_request",
      payload: {
        requestId: "req-1",
        callId: "c1",
        tool: "mem_write",
        action: "ask",
        access: "write",
        reason: "write 需要人工确认",
        preset: "read-only",
        paramsDigest: "digest",
        paramsKeys: ["address", "value"],
        paramsPreview: { address: "0x0800_0000", value: "1" },
        deadlineAt: "2026-10-20T10:00:30.000Z",
      },
    },
  ];
}

function decisionEvent(reason: string, effective: "allow" | "deny", callId = "c1"): SessionEvent {
  return {
    seq: 4,
    ts: "t",
    parent: 2,
    type: "permission_decision",
    payload: {
      callId,
      tool: "mem_write",
      action: effective === "allow" ? "allow" : "deny",
      effective,
      reason,
      preset: "read-only",
      source: "builtin",
      paramsDigest: "digest",
      paramsKeys: ["address", "value"],
    },
  };
}

function approvalOf(events: readonly SessionEvent[]): Extract<TranscriptEvent, { kind: "approval" }> {
  return transcriptFromSession(events).events.find((e) => e.kind === "approval") as Extract<
    TranscriptEvent,
    { kind: "approval" }
  >;
}

describe("transcript", () => {
  it("user 事件渲染为用户气泡", () => {
    const v = transcriptFromSession(makeSessionEvents());
    expect(v.events[0]).toMatchObject({ kind: "user", text: expect.stringContaining("乱码") });
  });
  it("第0步分流渲染为 ask", () => {
    const v = transcriptFromSession(makeSessionEvents());
    expect(v.events[1]).toMatchObject({ kind: "ask", text: expect.stringContaining("分流") });
  });
  it("工具卡渲染且持有证据", () => {
    const v = transcriptFromSession(makeSessionEvents());
    const tools = v.events.filter((e) => e.kind === "tool") as Array<{ kind: "tool"; tool: { name: string; evidence?: unknown[] } }>;
    expect(tools.some((t) => t.tool.name === "mem_read" && ((t.tool.evidence ?? []).length > 0))).toBe(true);
  });
  it("ok=false 的工具呈现 error 形态且保留错误码", () => {
    const evs = [
      ...makeSessionEvents(),
      { seq: 99, ts: "t", type: "assistant", payload: { content: "", toolCalls: [{ id: "c9", name: "serial_read", arguments: {} }] } },
      { seq: 100, ts: "t", type: "tool_result", payload: { id: "c9", ok: false, code: "io_timeout", text: "读取超时" }, parent: 99 },
    ] as unknown as SessionEvent[];
    const v = transcriptFromSession(evs);
    const tool = v.events.filter((e) => e.kind === "tool").at(-1) as Extract<TranscriptEvent, { kind: "tool" }>;
    expect(tool.tool.ok).toBe(false);
    expect(tool.tool.errorCode).toBe("io_timeout");
  });
  it("verdict 渲染为判决卡", () => {
    const v = transcriptFromSession(makeSessionEvents());
    expect(v.events.some((e) => e.kind === "verdict")).toBe(true);
  });
  it("guard 渲染为安全提示", () => {
    const v = transcriptFromSession(makeSessionEvents());
    const g = v.events.find((e) => e.kind === "guard");
    expect(g && g.kind === "guard" && g.guard.state).toBe("待确认");
  });
  it("归约确定性：同输入两次结果全等", () => {
    expect(transcriptFromSession(makeSessionEvents())).toEqual(transcriptFromSession(makeSessionEvents()));
  });
  it("五步路径：verdict 后全部 done", () => {
    const steps = reduceStep(makeSessionEvents());
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
  });
  it("成功但无 detail 且有 text 时投影为 readout 纯文本", () => {
    const tool = lastTool(toolPair({ ok: true, text: "0x0000_002E" }));
    expect(tool.tool.kind).toBe("readout");
    expect(tool.tool.text).toBe("0x0000_002E");
    expect(tool.tool.readout).toBeUndefined();
  });
  it("成功但无 detail 且 text 为空时投影为空读数错误", () => {
    const tool = lastTool(toolPair({ ok: true, text: "" }));
    expect(tool.tool.kind).toBe("error");
    expect(tool.tool.errorCode).toBe("empty_result");
    expect(tool.tool.errorText).toBe("工具未返回读数");
  });
  it("成功但 text 为空且 artifactPath 存在时保留 readout 与路径", () => {
    const tool = lastTool(toolPair({ ok: true, text: "", artifactPath: "artifacts/large.bin" }));
    expect(tool.tool.kind).toBe("readout");
    expect(tool.tool.artifactPath).toBe("artifacts/large.bin");
    expect(tool.tool.text).toBe("");
    expect(tool.tool.errorCode).toBeUndefined();
  });
  it("artifactPath 透传到工具卡", () => {
    const tool = lastTool(
      toolPair({
        ok: true,
        text: "",
        artifactPath: "artifacts/read.bin",
        detail: { readout: [{ label: "读回", value: "0x00" }] },
      }),
    );
    expect(tool.tool.artifactPath).toBe("artifacts/read.bin");
    expect(tool.tool.kind).toBe("readout");
  });
  it("工具骨架 queued，结果到达后转 done", () => {
    const skeleton = transcriptFromSession(toolPair({}).slice(0, 1));
    const card = skeleton.events[0] as Extract<TranscriptEvent, { kind: "tool" }>;
    expect(card.tool.state).toBe("queued");
    expect(card.tool.ok).toBe(true);
    const settled = lastTool(toolPair({ ok: true, text: "x" }));
    expect(settled.tool.state).toBe("done");
  });
  it("status done 投影为已完成", () => {
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "user", payload: { content: "症状" } },
      { seq: 2, ts: "t", type: "status", payload: { status: "done" } },
    ];
    expect(transcriptFromSession(events).status).toBe("done");
  });
  it("status usage_missing 保持诊断中并记录中断原因", () => {
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "user", payload: { content: "症状" } },
      { seq: 2, ts: "t", type: "status", payload: { status: "usage_missing" } },
    ];
    const view = transcriptFromSession(events);
    expect(view.status).toBe("diagnosing");
    expect(view.interruptReason).toBeTruthy();
    expect(view.events.some((e) => e.kind === "interrupted")).toBe(false);
  });
  it("status 未知值忽略", () => {
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "user", payload: { content: "症状" } },
      { seq: 2, ts: "t", type: "status", payload: { status: "unknown_value" } },
    ];
    const view = transcriptFromSession(events);
    expect(view.status).toBe("diagnosing");
    expect(view.interruptReason).toBeUndefined();
  });
  it("usage 事件投影 usage 与累计 cost", () => {
    const view = transcriptFromSession(makeSessionEvents());
    expect(view.usage).toMatchObject({ prompt: 8120, completion: 1460, cached: 2048 });
    expect(view.cost).toBeCloseTo(0.018);
  });
  it("loop 的 turn_end.costUsd 累计到 view.cost", () => {
    const events: LoopEvent[] = [
      { kind: "model_message", content: "分析中" },
      { kind: "turn_end", turn: 1, costUsd: 0.002 },
      { kind: "turn_end", turn: 2, costUsd: 0.003 },
      { kind: "done", finishReason: "no_tool_calls" },
    ];
    const view = transcriptFromLoop(events);
    expect(view.cost).toBeCloseTo(0.005);
    expect(view.status).toBe("done");
  });
  it("session 负数或非有限 costUsd 不进入成本", () => {
    const negative = transcriptFromSession([
      { seq: 1, ts: "t", type: "usage", payload: { promptTokens: 10, costUsd: -1 } },
    ]);
    expect(negative.cost).toBeUndefined();
    expect(negative.usage?.costUsd).toBeUndefined();
    const nan = transcriptFromSession([
      { seq: 1, ts: "t", type: "usage", payload: { promptTokens: 10, costUsd: Number.NaN } },
    ]);
    expect(nan.cost).toBeUndefined();
    expect(nan.usage?.costUsd).toBeUndefined();
  });
  it("session 非法 costUsd 不污染此前累计", () => {
    const view = transcriptFromSession([
      { seq: 1, ts: "t", type: "usage", payload: { promptTokens: 1, costUsd: 0.02 } },
      { seq: 2, ts: "t", type: "usage", payload: { promptTokens: 1, costUsd: -5 } },
    ]);
    expect(view.cost).toBeCloseTo(0.02);
    expect(view.usage?.costUsd).toBeCloseTo(0.02);
  });
  it("loop 负数或非有限 costUsd 被忽略", () => {
    const mixed = transcriptFromLoop([
      { kind: "model_message", content: "分析中" },
      { kind: "turn_end", turn: 1, costUsd: 0.002 },
      { kind: "turn_end", turn: 2, costUsd: -1 },
      { kind: "turn_end", turn: 3, costUsd: Number.NaN },
      { kind: "done", finishReason: "no_tool_calls" },
    ]);
    expect(mixed.cost).toBeCloseTo(0.002);
    const invalid = transcriptFromLoop([
      { kind: "model_message", content: "分析中" },
      { kind: "turn_end", turn: 1, costUsd: -1 },
      { kind: "turn_end", turn: 2, costUsd: Number.NaN },
      { kind: "done", finishReason: "no_tool_calls" },
    ]);
    expect(invalid.cost).toBeUndefined();
  });
  it("tool_started 使工具卡从 queued 进入 running，tool_result 进入 done/failed", () => {
    const base: SessionEvent[] = [
      { seq: 1, ts: "t", type: "user", payload: { content: "症状" } },
      {
        seq: 2,
        ts: "t",
        type: "assistant",
        payload: {
          content: "",
          toolCalls: [
            { id: "c1", name: "serial_read", arguments: { port: "COM3" } },
            { id: "c2", name: "mem_read", arguments: { address: "0x0" } },
          ],
        },
      },
    ];
    const queued = transcriptFromSession(base).events.filter((event) => event.kind === "tool") as Array<
      Extract<TranscriptEvent, { kind: "tool" }>
    >;
    expect(queued.map((event) => event.tool.state)).toEqual(["queued", "queued"]);

    const started = transcriptFromSession([
      ...base,
      { seq: 3, ts: "t", parent: 2, type: "tool_started", payload: { callId: "c1", tool: "serial_read", access: "read" } },
      { seq: 4, ts: "t", parent: 2, type: "tool_result", payload: { id: "c1", ok: true, text: "ok" } },
      { seq: 5, ts: "t", parent: 2, type: "tool_result", payload: { id: "c2", ok: false, code: "io", text: "boom" } },
    ]).events.filter((event) => event.kind === "tool") as Array<Extract<TranscriptEvent, { kind: "tool" }>>;
    expect(started.map((event) => event.tool.state)).toEqual(["done", "failed"]);
    expect(started[0].tool.ok).toBe(true);
    expect(started[1].tool.errorCode).toBe("io");

    const running = transcriptFromSession([
      ...base,
      { seq: 3, ts: "t", parent: 2, type: "tool_started", payload: { callId: "c1", tool: "serial_read", access: "read" } },
    ]).events.filter((event) => event.kind === "tool") as Array<Extract<TranscriptEvent, { kind: "tool" }>>;
    expect(running.map((event) => event.tool.state)).toEqual(["running", "queued"]);
  });

  it("permission_decision 生成 permission 事件且不产生工具卡", () => {
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "user", payload: { content: "症状" } },
      {
        seq: 2,
        ts: "t",
        type: "assistant",
        payload: {
          content: "",
          toolCalls: [{ id: "c1", name: "mem_write", arguments: { address: "0x0", value: "1" } }],
        },
      },
      {
        seq: 3,
        ts: "t",
        parent: 2,
        type: "permission_decision",
        payload: {
          callId: "c1",
          tool: "mem_write",
          action: "ask",
          effective: "deny",
          reason: "test:ask-denied",
          preset: "read-only",
          source: "builtin",
          paramsDigest: "digest",
          paramsKeys: ["address", "value"],
          access: "write",
        },
      },
      {
        seq: 4,
        ts: "t",
        parent: 2,
        type: "tool_result",
        payload: { id: "c1", ok: false, code: "permission_denied", text: "denied" },
      },
    ];

    const view = transcriptFromSession(events);
    const permission = view.events.find((event) => event.kind === "permission");
    expect(permission).toEqual({
      id: "ev-3",
      kind: "permission",
      permission: {
        callId: "c1",
        tool: "mem_write",
        action: "ask",
        effective: "deny",
        reason: "test:ask-denied",
      },
    });
    expect(view.events.filter((event) => event.kind === "tool")).toHaveLength(1);
    expect(reduceStep(events)).toStrictEqual(reduceStep(events.filter((event) => event.type !== "permission_decision")));
  });

  it("TRANSCRIPT_KINDS 包含 permission", () => {
    expect([...TRANSCRIPT_KINDS]).toContain("permission");
  });

  it("approval_request 投影为 pending 审批卡", () => {
    const approval = approvalOf(approvalEvents());
    expect(approval).toMatchObject({
      id: "ev-3",
      kind: "approval",
      approval: {
        requestId: "req-1",
        callId: "c1",
        tool: "mem_write",
        reason: "write 需要人工确认",
        preset: "read-only",
        deadlineAt: "2026-10-20T10:00:30.000Z",
        status: "pending",
      },
    });
    expect([...TRANSCRIPT_KINDS]).toContain("approval");
  });

  it("paramsPreview 扁平化为展示文本：最多 8 键、单值 200 字符且不改写原 payload", () => {
    const preview: Record<string, unknown> = {};
    for (let i = 1; i <= 12; i += 1) preview[`k${i}`] = i === 1 ? "x".repeat(250) : `v${i}`;
    const events = approvalEvents();
    events[2].payload = { ...events[2].payload, paramsPreview: preview };

    const text = approvalOf(events).approval.paramsPreviewText;
    expect(typeof text).toBe("string");
    expect(text).toContain("k1=");
    expect(text).toContain("x".repeat(200));
    expect(text).not.toContain("x".repeat(201));
    expect(text).toContain("k8=");
    expect(text).not.toContain("k9=");
    expect((text as string).split(", ")).toHaveLength(8);
    expect(preview.k1).toBe("x".repeat(250));
    expect(events[2].payload.paramsPreview).toBe(preview);
  });

  it("无 paramsPreview 时 paramsPreviewText 缺省", () => {
    const events = approvalEvents();
    const payload = { ...events[2].payload };
    delete payload.paramsPreview;
    events[2].payload = payload;
    expect(approvalOf(events).approval.paramsPreviewText).toBeUndefined();
  });

  it("permission_decision allow 命中审批卡：status allowed 且不新增 permission 事件", () => {
    const view = transcriptFromSession([...approvalEvents(), decisionEvent("user_approved", "allow")]);
    const approvals = view.events.filter((event) => event.kind === "approval") as Array<
      Extract<TranscriptEvent, { kind: "approval" }>
    >;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approval.status).toBe("allowed");
    expect(view.events.some((event) => event.kind === "permission")).toBe(false);
  });

  it.each([
    ["approval_timeout: 30s", "expired"],
    ["approval_aborted: user", "aborted"],
    ["user_denied", "denied"],
  ])("permission_decision deny %s → %s", (reason, status) => {
    const view = transcriptFromSession([...approvalEvents(), decisionEvent(reason, "deny")]);
    const approvals = view.events.filter((event) => event.kind === "approval") as Array<
      Extract<TranscriptEvent, { kind: "approval" }>
    >;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approval.status).toBe(status);
    expect(view.events.some((event) => event.kind === "permission")).toBe(false);
    const tool = view.events.find((event) => event.kind === "tool") as Extract<TranscriptEvent, { kind: "tool" }>;
    expect(tool.tool.state).toBe("failed");
  });

  it("callId 未命中审批卡时 permission_decision 仍生成 permission 事件", () => {
    const view = transcriptFromSession([...approvalEvents(), decisionEvent("user_denied", "deny", "c-other")]);
    expect(view.events.some((event) => event.kind === "permission")).toBe(true);

    const approvals = view.events.filter((event) => event.kind === "approval") as Array<
      Extract<TranscriptEvent, { kind: "approval" }>
    >;
    expect(approvals[0].approval.status).toBe("pending");
  });

  it("mcp_status 与 device_status 不进入正文事件", () => {
    const events: SessionEvent[] = [
      { seq: 1, ts: "t", type: "user", payload: { content: "症状" } },
      { seq: 2, ts: "t", type: "mcp_status", payload: { kind: "connected", server: "echo" } },
      {
        seq: 3,
        ts: "t",
        type: "device_status",
        payload: { callId: "c1", server: "probe", tool: "mcp__probe__attach", state: { probe: "attached" } },
      },
    ];
    const view = transcriptFromSession(events);
    expect(view.events.map((event) => event.kind)).toEqual(["user"]);
  });
  it("emptyTranscriptView 返回五步待办、idle 与空事件", () => {
    const view = emptyTranscriptView();
    expect(view.status).toBe("idle");
    expect(view.events).toEqual([]);
    expect(view.steps.map((step) => step.state)).toEqual(["now", "todo", "todo", "todo", "todo"]);
    expect(view.sessionId).toBeUndefined();
  });
});