import { describe, expect, it } from "vitest";
import type { LoopEvent } from "../../src/loop/events.js";
import type { SessionEvent } from "../../src/session/types.js";
import { transcriptFromLoop, transcriptFromSession } from "../../src/ui/view/transcript.js";
import type { TranscriptEvent } from "../../src/ui/view/transcript.js";

const VERDICT = {
  rootCause: "RCC_CFGR 仍为 HSI，BRR 按 PCLK1 = 84 MHz 计算，实际波特率偏快。",
  evidence: [{ name: "RCC_CFGR", code: "0x40023808", value: "0x00", verdict: "bad", label: "HSI 直供" }],
  prediction: "把 BRR 改为 0x0009 后 115200 应可读。",
  ownership: [{ t: "agent", title: "agent 自己做", desc: "读寄存器。" }],
  confidence: "高",
};

const SESSION_EVENTS: SessionEvent[] = [
  { seq: 1, ts: "t", type: "user", payload: { content: "串口输出乱码。" } },
  {
    seq: 2,
    ts: "t",
    type: "assistant",
    payload: { content: "第 0 步分流 · 一次只问一个问题\n终端设置的波特率是多少？", toolCalls: [] },
  },
  { seq: 3, ts: "t", type: "user", payload: { content: "115200。" } },
  {
    seq: 4,
    ts: "t",
    type: "assistant",
    payload: {
      content: "",
      toolCalls: [{ id: "call_1", name: "mem_read", arguments: { address: "0x40023808", size: 4 } }],
    },
  },
  {
    seq: 5,
    ts: "t",
    parent: 4,
    type: "tool_result",
    payload: {
      id: "call_1",
      ok: true,
      text: "0x00000000",
      detail: { ms: 12, readout: [{ label: "读回", value: "0x0000_0000" }] },
    },
  },
  { seq: 6, ts: "t", type: "assistant", payload: { content: "", toolCalls: [], verdict: VERDICT } },
  {
    seq: 7,
    ts: "t",
    type: "assistant",
    payload: {
      content: "",
      toolCalls: [],
      guard: { action: "写入", address: "0x40004408", value: "0x0009", state: "待确认" },
    },
  },
  { seq: 8, ts: "t", type: "status", payload: { status: "done" } },
];

const LOOP_EVENTS: LoopEvent[] = [
  { kind: "model_message", content: "第 0 步分流 · 一次只问一个问题\n终端设置的波特率是多少？" },
  { kind: "tool_use", id: "call_1", name: "mem_read", input: { address: "0x40023808", size: 4 } },
  {
    kind: "tool_result",
    id: "call_1",
    ok: true,
    text: "0x00000000",
    detail: { ms: 12, readout: [{ label: "读回", value: "0x0000_0000" }] },
  },
  { kind: "turn_end", turn: 1, costUsd: 0.004 },
  { kind: "done", finishReason: "no_tool_calls" },
];

function comparable(events: readonly TranscriptEvent[]): TranscriptEvent[] {
  return events.filter((event) => event.kind !== "user" && event.kind !== "verdict" && event.kind !== "guard");
}

function toolNames(events: readonly TranscriptEvent[]): string[] {
  return events.filter((event) => event.kind === "tool").map((event) => event.tool.name);
}

describe("transcript consistency", () => {
  const sessionView = transcriptFromSession(SESSION_EVENTS);
  const loopView = transcriptFromLoop(LOOP_EVENTS);

  it("可投影组件序列一致", () => {
    expect(loopView.events.map((event) => event.kind)).toEqual(comparable(sessionView.events).map((event) => event.kind));
  });
  it("工具名序列一致", () => {
    expect(toolNames(loopView.events)).toEqual(toolNames(comparable(sessionView.events)));
  });
  it("两路归约均稳定", () => {
    expect(transcriptFromSession(SESSION_EVENTS)).toEqual(sessionView);
    expect(transcriptFromLoop(LOOP_EVENTS)).toEqual(loopView);
  });
  it("LoopEvent 不产生 user/verdict/guard 投影", () => {
    const kinds = new Set(loopView.events.map((event) => event.kind));
    expect(kinds.has("user")).toBe(false);
    expect(kinds.has("verdict")).toBe(false);
    expect(kinds.has("guard")).toBe(false);
  });
  it("两路终态均为 done", () => {
    expect(sessionView.status).toBe("done");
    expect(loopView.status).toBe("done");
  });
});