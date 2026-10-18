import { describe, expect, it } from "vitest";
import { DEMO_SESSION_ID, transcriptFromSession, transcriptFromLoop, reduceStep } from "../../src/ui/view/transcript.js";
import type { TranscriptEvent } from "../../src/ui/view/transcript.js";
import type { SessionEvent } from "../../src/session/types.js";
import type { LoopEvent } from "../../src/loop/events.js";
import { UART_TRANSCRIPT_EVENTS } from "../../src/ui/demo/fixtures.js";

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

describe("transcript", () => {
  it("user 事件渲染为用户气泡", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    expect(v.events[0]).toMatchObject({ kind: "user", text: expect.stringContaining("乱码") });
  });
  it("第0步分流渲染为 ask", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    expect(v.events[1]).toMatchObject({ kind: "ask", text: expect.stringContaining("分流") });
  });
  it("工具卡渲染且持有证据", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    const tools = v.events.filter((e) => e.kind === "tool") as Array<{ kind: "tool"; tool: { name: string; evidence?: unknown[] } }>;
    expect(tools.some((t) => t.tool.name === "mem_read" && ((t.tool.evidence ?? []).length > 0))).toBe(true);
  });
  it("ok=false 的工具呈现 error 形态且保留错误码", () => {
    const evs = [
      ...UART_TRANSCRIPT_EVENTS,
      { seq: 99, ts: "t", type: "assistant", payload: { content: "", toolCalls: [{ id: "c9", name: "serial_read", arguments: {} }] } },
      { seq: 100, ts: "t", type: "tool_result", payload: { id: "c9", ok: false, code: "io_timeout", text: "读取超时" }, parent: 99 },
    ] as unknown as SessionEvent[];
    const v = transcriptFromSession(evs);
    const tool = v.events.filter((e) => e.kind === "tool").at(-1) as Extract<TranscriptEvent, { kind: "tool" }>;
    expect(tool.tool.ok).toBe(false);
    expect(tool.tool.errorCode).toBe("io_timeout");
  });
  it("verdict 渲染为判决卡", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    expect(v.events.some((e) => e.kind === "verdict")).toBe(true);
  });
  it("guard 渲染为安全提示", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    const g = v.events.find((e) => e.kind === "guard");
    expect(g && g.kind === "guard" && g.guard.state).toBe("待确认");
  });
  it("归约确定性：同输入两次结果全等", () => {
    expect(transcriptFromSession(UART_TRANSCRIPT_EVENTS)).toEqual(transcriptFromSession(UART_TRANSCRIPT_EVENTS));
  });
  it("五步路径：verdict 后全部 done", () => {
    const steps = reduceStep(UART_TRANSCRIPT_EVENTS);
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
  it("工具骨架 pending，结果到达后清除", () => {
    const skeleton = transcriptFromSession(toolPair({}).slice(0, 1));
    const card = skeleton.events[0] as Extract<TranscriptEvent, { kind: "tool" }>;
    expect(card.tool.pending).toBe(true);
    expect(card.tool.ok).toBe(true);
    const settled = lastTool(toolPair({ ok: true, text: "x" }));
    expect(settled.tool.pending).toBeUndefined();
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
    const view = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
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
  it("DEMO_SESSION_ID 为 #128", () => {
    expect(DEMO_SESSION_ID).toBe("#128");
  });
});