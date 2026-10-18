import { describe, expect, it } from "vitest";
import { transcriptFromSession, reduceStep } from "../../src/ui/view/transcript.js";
import type { TranscriptEvent } from "../../src/ui/view/transcript.js";
import type { SessionEvent } from "../../src/session/types.js";
import { UART_TRANSCRIPT_EVENTS } from "../../src/ui/demo/fixtures.js";

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
});