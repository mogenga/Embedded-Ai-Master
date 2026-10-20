// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { ToolCard } from "../../../src/ui/components/conversation/tool-card.js";
import { VerdictCard } from "../../../src/ui/components/conversation/verdict-card.js";
import { GuardNotice } from "../../../src/ui/components/conversation/guard-notice.js";
import { transcriptFromSession } from "../../../src/ui/view/transcript.js";
import type { TranscriptEvent } from "../../../src/ui/view/transcript.js";
import { makeSessionEvents } from "../support/builders.js";

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
          ok: false, state: "failed",
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
    const v = transcriptFromSession(makeSessionEvents());
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
    const v = transcriptFromSession(makeSessionEvents());
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
    render(<ToolCard tool={{ id: "r", name: "mem_read", args: "0x0 · 32B", ok: true, state: "done", kind: "readout", readout }} />, root);
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
          ok: true, state: "done",
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
  it("running 工具卡显示执行中且不显示成功勾", () => {
    const root = mount();
    render(
      <ToolCard tool={{ id: "p", name: "mem_read", args: "0x0", ok: true, state: "running", kind: "readout" }} />,
      root,
    );
    expect(root.textContent).toContain("执行中");
    const flag = root.querySelector(".tool-flag--pending");
    expect(flag).not.toBeNull();
    expect(flag?.querySelector('use[href="#i-check"]')).toBeNull();
  });
  it("成功无 detail 的 text 工具卡渲染纯文本", () => {
    const root = mount();
    render(
      <ToolCard
        tool={{ id: "t", name: "serial_read", args: "COM3", ok: true, state: "done", kind: "readout", text: "0x0000_002E" }}
      />,
      root,
    );
    expect(root.querySelector(".tool-text")?.textContent).toBe("0x0000_002E");
  });
  it("text 折叠区显示行数与字节数并可展开", async () => {
    const root = mount();
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    render(<ToolCard tool={{ id: "t", name: "serial_read", args: "COM3", ok: true, state: "done", kind: "readout", text }} />, root);
    const count = root.querySelector(".tool-fold-count")?.textContent ?? "";
    expect(count).toContain("10 行");
    expect(count).toContain("B");
    expect(root.querySelector(".tool-text")).toBeNull();
    const btn = root.querySelector<HTMLButtonElement>(".tool-fold-btn");
    btn?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector(".tool-text")?.textContent).toBe(text);
  });
  it("errorText 为空时回退固定文案", () => {
    const root = mount();
    render(
      <ToolCard
        tool={{ id: "e", name: "serial_read", args: "COM3", ok: false, state: "failed", kind: "error", errorCode: "io_timeout", errorText: "" }}
      />,
      root,
    );
    expect(root.textContent).toContain("工具未返回错误说明");
  });
  it("readOnly 工具卡以中性标记消费", () => {
    const root = mount();
    render(
      <ToolCard
        tool={{ id: "r", name: "mem_read", args: "0x0", ok: true, state: "done", kind: "readout", readOnly: true, readout: [] }}
      />,
      root,
    );
    expect(root.querySelector(".tool")?.getAttribute("data-ro")).toBe("true");
  });
  it("artifactPath 在无结构化内容时展示", () => {
    const root = mount();
    render(
      <ToolCard
        tool={{ id: "a", name: "serial_read", args: "COM3", ok: true, state: "done", kind: "readout", artifactPath: "artifacts/read.bin" }}
      />,
      root,
    );
    expect(root.textContent).toContain("artifacts/read.bin");
  });
  it("超长 text 的折叠摘要截断到 120 字符", () => {
    const root = mount();
    const text = "x".repeat(100000);
    render(<ToolCard tool={{ id: "t", name: "serial_read", args: "COM3", ok: true, state: "done", kind: "readout", text }} />, root);
    const sum = root.querySelector(".tool-fold-sum")?.textContent ?? "";
    expect(sum.length).toBeLessThanOrEqual(130);
  });
  it("readout 空 text 但 artifactPath 存在时展示结果已落盘", () => {
    const root = mount();
    render(
      <ToolCard
        tool={{
          id: "a",
          name: "serial_read",
          args: "COM3",
          ok: true, state: "done",
          kind: "readout",
          text: "",
          artifactPath: "artifacts/large.bin",
        }}
      />,
      root,
    );
    expect(root.textContent).toContain("结果已落盘");
    expect(root.textContent).toContain("artifacts/large.bin");
  });
  it("GuardNotice 待确认提供确认与拒绝入口，确认后仅执行中", async () => {
    const root = mount();
    let confirmed = 0;
    render(
      <GuardNotice
        guard={{ action: "写入", address: "0x40004408", value: "0x0009", state: "待确认" }}
        onConfirm={() => {
          confirmed += 1;
        }}
      />,
      root,
    );
    const confirm = [...root.querySelectorAll<HTMLButtonElement>(".guard-actions button")].find((b) =>
      b.textContent?.includes("确认写入"),
    );
    expect(confirm).toBeDefined();
    confirm?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmed).toBe(1);
    expect(root.querySelector(".guard")?.getAttribute("data-state")).toBe("执行中");
    expect(root.textContent).toContain("执行中，等待工具结果");
    expect(root.textContent).not.toContain("已执行");
    expect(root.querySelector(".guard-actions")).toBeNull();
  });
  it("GuardNotice 拒绝后状态为已拒绝", async () => {
    const root = mount();
    let rejected = 0;
    render(
      <GuardNotice
        guard={{ action: "写入", address: "0x40004408", value: "0x0009", state: "待确认" }}
        onReject={() => {
          rejected += 1;
        }}
      />,
      root,
    );
    const reject = [...root.querySelectorAll<HTMLButtonElement>(".guard-actions button")].find((b) =>
      b.textContent?.includes("拒绝"),
    );
    reject?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected).toBe(1);
    expect(root.querySelector(".guard")?.getAttribute("data-state")).toBe("已拒绝");
    expect(root.textContent).not.toContain("已执行");
  });
  it("判决卡根因中寄存器与时钟名使用行内代码", () => {
    const root = mount();
    render(
      <VerdictCard
        verdict={{
          rootCause: "RCC_CFGR 显示 PCLK1 = 84 MHz，但 HSE 未起振，RCC_CFGR 读回 0x00000000。",
          evidence: [],
          prediction: "改 BRR 后复测。",
          ownership: [],
          confidence: "高",
        }}
      />,
      root,
    );
    const codes = [...root.querySelectorAll(".vc-body .k")].map((el) => el.textContent ?? "");
    expect(codes).toContain("PCLK1");
    expect(codes).toContain("HSE");
    expect(codes.some((text) => text.includes("0x00000000"))).toBe(true);
  });
  it("低置信度追加不确定性说明", () => {
    const root = mount();
    render(
      <VerdictCard
        verdict={{
          rootCause: "可能为时钟源问题。",
          evidence: [],
          prediction: "复测。",
          ownership: [],
          confidence: "低",
        }}
      />,
      root,
    );
    expect(root.textContent).toContain("低置信度");
    expect(root.textContent).toContain("不确定");
  });
});