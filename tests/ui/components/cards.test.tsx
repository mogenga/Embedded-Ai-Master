// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { ToolCard } from "../../../src/ui/components/conversation/tool-card.js";
import { VerdictCard } from "../../../src/ui/components/conversation/verdict-card.js";
import { GuardNotice } from "../../../src/ui/components/conversation/guard-notice.js";
import { transcriptFromSession } from "../../../src/ui/view/transcript.js";
import type { TranscriptEvent } from "../../../src/ui/view/transcript.js";
import { UART_TRANSCRIPT_EVENTS } from "../../../src/ui/demo/fixtures.js";

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("cards", () => {
  it("工具卡失败形态显示错误码与文本，不渲染空白读数", () => {
    const root = mount();
    render(
      <ToolCard
        tool={{
          id: "c",
          name: "serial_read",
          args: "COM3",
          ok: false,
          kind: "error",
          errorCode: "io_timeout",
          errorText: "读取超时",
          readout: [{ label: "读回", value: "" }],
        }}
      />,
      root,
    );
    expect(root.textContent).toContain("io_timeout");
    expect(root.textContent).toContain("读取超时");
    expect(root.querySelector(".readout")).toBeNull();
  });
  it("证据卡判定胶囊带图标与文字", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    const toolEv = v.events.find(
      (e) => e.kind === "tool" && e.tool.evidence?.some((row) => row.label === "偏快 5.3×"),
    ) as Extract<TranscriptEvent, { kind: "tool" }> | undefined;
    expect(toolEv).toBeDefined();
    if (toolEv === undefined) throw new Error("fixture 缺少 evidence 工具卡");
    const root = mount();
    render(<ToolCard tool={toolEv.tool} />, root);
    const pill = root.querySelector('.verdict[data-v="bad"]');
    expect(pill).not.toBeNull();
    expect(pill?.querySelector("use")?.getAttribute("href")).toBe("#i-x");
    expect(pill?.textContent).toContain("偏快 5.3×");
  });
  it("判决卡含根因/证据/预测/归属四区块", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    const verdictEv = v.events.find((e) => e.kind === "verdict") as
      | Extract<TranscriptEvent, { kind: "verdict" }>
      | undefined;
    expect(verdictEv).toBeDefined();
    if (verdictEv === undefined) throw new Error("fixture 缺少判决事件");
    const root = mount();
    render(<VerdictCard verdict={verdictEv.verdict} />, root);
    ["根因", "证据链", "可证伪", "动作归属"].forEach((k) => expect(root.textContent).toContain(k));
    expect(root.querySelector('.own[data-o="agent"]')).not.toBeNull();
    expect(root.querySelector(".predict")).not.toBeNull();
  });
  it("GuardNotice 待确认状态不出现已执行", () => {
    const root = mount();
    render(<GuardNotice guard={{ action: "写入", address: "0x40004408", value: "0x0009", state: "待确认" }} />, root);
    expect(root.textContent).not.toContain("已执行");
    expect(root.textContent).toContain("待确认");
  });
  it("写工具确认后显示已执行（V14 反面）", () => {
    const root = mount();
    render(<GuardNotice guard={{ action: "写入", address: "0x40004408", value: "0x0009", state: "已执行" }} />, root);
    expect(root.textContent).toContain("已执行");
  });
  it("大输出默认折叠为摘要行数与展开按钮", async () => {
    const readout = Array.from({ length: 8 }, (_, i) => ({ label: `行${i}`, value: String(i) }));
    const root = mount();
    render(<ToolCard tool={{ id: "r", name: "mem_read", args: "0x0 · 32B", ok: true, kind: "readout", readout }} />, root);
    const btn = root.querySelector(".tool-fold-btn");
    expect(btn?.textContent).toContain("展开");
    expect(root.textContent).toContain("摘要");
    expect(root.textContent).toContain("8 行");
    expect(root.querySelectorAll(".readout dt").length).toBe(0);
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelectorAll(".readout dt").length).toBe(8);
    expect(root.querySelector(".tool-fold-btn")?.textContent).toContain("收起");
  });
  it("destructive 工具卡头使用危险色标记", () => {
    const root = mount();
    render(
      <ToolCard
        tool={{
          id: "w",
          name: "mem_write",
          args: "0x40004408 = 0x0009",
          ok: true,
          kind: "readout",
          destructive: true,
          readout: [{ label: "写入", value: "0x0009" }],
        }}
      />,
      root,
    );
    expect(root.querySelector(".tool.is-destructive")).not.toBeNull();
    expect(root.querySelector(".tool.is-destructive .tool-head")).not.toBeNull();
  });
});