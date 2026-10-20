// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { Composer } from "../../../src/ui/components/conversation/composer.js";
import { DeviceMonitor } from "../../../src/ui/components/dock/device-monitor.js";
import { Dock } from "../../../src/ui/components/dock/dock.js";
import { PortSettings } from "../../../src/ui/components/dock/port-settings.js";
import type { SessionEvent } from "../../../src/session/types.js";
import { emptyTranscriptView, transcriptFromSession } from "../../../src/ui/view/transcript.js";
import { makeTranscriptView, UNKNOWN_DEVICE } from "../support/builders.js";

const CONNECTED_DEVICE = {
  probe: "OpenOCD · ST-Link V2",
  serial: "COM3",
  cpu: "STM32F407ZGT6",
  backend: "Renode 未启用",
};

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("composer", () => {
  it("空输入发送按钮禁用", () => {
    const root = mount();
    render(<Composer onSend={() => {}} />, root);
    expect(root.querySelector<HTMLButtonElement>(".send")!.disabled).toBe(true);
  });

  it("canSend=false 时发送禁用并显示可见说明", () => {
    const root = mount();
    render(<Composer onSend={() => {}} canSend={false} disabledReason="未配置提交端点" />, root);
    const send = root.querySelector<HTMLButtonElement>(".send")!;
    expect(send.disabled).toBe(true);
    expect(root.textContent).toContain("未配置提交端点");
  });

  it("canSend=false 时不发送也不清空输入", () => {
    const root = mount();
    let sent = "";
    render(<Composer onSend={(t) => { sent = t; }} canSend={false} disabledReason="未配置提交端点" />, root);
    const ta = root.querySelector("textarea")!;
    ta.value = "你好";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toBe("");
    expect(ta.value).toBe("你好");
  });

  it("Enter 发送非空文本并清空", () => {
    const root = mount();
    let sent = "";
    render(<Composer onSend={(t) => { sent = t; }} />, root);
    const ta = root.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.value = "你好";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toBe("你好");
    expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("Shift+Enter 换行且空输入 Enter 不发送", () => {
    const root = mount();
    let sent = "";
    render(<Composer onSend={(t) => { sent = t; }} />, root);
    const ta = root.querySelector("textarea")!;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    ta.value = "换行";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(sent).toBe("");
  });

  it("异步发送失败时保留输入并提示", async () => {
    const root = mount();
    render(
      <Composer
        onSend={() => Promise.reject(new Error("boom"))}
      />,
      root,
    );
    const ta = root.querySelector("textarea")!;
    ta.value = "重试我";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ta.value).toBe("重试我");
    expect(root.textContent).toContain("发送失败，输入已保留");
  });

  it("sendError 在 Composer 区域显示可读错误", () => {
    const root = mount();
    render(<Composer onSend={() => {}} errorMessage="发送失败（HTTP 409）：会话忙" />, root);
    expect(root.querySelector(".composer-error")?.textContent).toContain("发送失败（HTTP 409）：会话忙");
  });

  it("异步发送失败且带 errorMessage 时优先显示具体错误", async () => {
    const root = mount();
    render(<Composer onSend={() => Promise.reject(new Error("boom"))} errorMessage="发送失败（HTTP 500）" />, root);
    const ta = root.querySelector("textarea")!;
    ta.value = "重试我";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ta.value).toBe("重试我");
    expect(root.querySelector(".composer-error")?.textContent).toContain("发送失败（HTTP 500）");
  });

  it("发送后滚动消息流到底部", async () => {
    const stream = document.createElement("div");
    stream.className = "cnv-stream";
    Object.defineProperty(stream, "scrollHeight", { value: 640, configurable: true });
    document.body.appendChild(stream);
    const root = mount();
    render(<Composer onSend={() => {}} />, root);
    const ta = root.querySelector("textarea")!;
    ta.value = "你好";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stream.scrollTop).toBe(640);
  });
});

describe("dock", () => {
  it("调试坞三分区可折叠且 aria-expanded 同步", async () => {
    const root = mount();
    render(<Dock view={emptyTranscriptView()} device={UNKNOWN_DEVICE} />, root);
    const heads = [...root.querySelectorAll<HTMLButtonElement>(".dock-sec-head")];
    expect(heads.length).toBe(3);
    const dev = heads.find((h) => h.textContent?.includes("设备监控"))!;
    expect(dev.getAttribute("aria-expanded")).toBe("true");
    dev.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(dev.getAttribute("aria-expanded")).toBe("false");
  });

  it("加载中与失败时 Dock 不显示空数据态", () => {
    const root = mount();
    render(<Dock view={emptyTranscriptView()} device={UNKNOWN_DEVICE} state="loading" />, root);
    expect(root.textContent).toContain("加载中");
    expect(root.textContent).not.toContain("暂无工具调用");
    render(<Dock view={emptyTranscriptView()} device={UNKNOWN_DEVICE} state="error" />, root);
    expect(root.textContent).toContain("调试数据加载失败");
    expect(root.textContent).not.toContain("暂无工具调用");
  });

  it("空视图显示空态且统计为 — 而非 0", () => {
    const root = mount();
    render(<Dock view={emptyTranscriptView()} device={UNKNOWN_DEVICE} />, root);
    expect(root.textContent).toContain("暂无工具调用");
    expect(root.textContent).toContain("—");
  });

  it("同一工具同时含 evidence 与 readout 时两者都进入寄存器表", () => {
    const root = mount();
    render(<Dock view={makeTranscriptView()} device={CONNECTED_DEVICE} />, root);
    const names = [...root.querySelectorAll(".reg-name")].map((el) => el.textContent);
    expect(names).toContain("时钟源判定");
    expect(names).toContain("读回");
  });

  it("unknown 设备与串口的状态点为 idle", () => {
    const root = mount();
    render(<Dock view={emptyTranscriptView()} device={UNKNOWN_DEVICE} />, root);
    const heads = [...root.querySelectorAll<HTMLButtonElement>(".dock-sec-head")];
    const dot = (title: string) =>
      heads.find((head) => head.textContent?.includes(title))!.querySelector(".dot")!.getAttribute("data-s");
    expect(dot("设备监控")).toBe("idle");
    expect(dot("端口设置")).toBe("idle");
  });

  it("日志状态点与 mark 由真实工具事件派生", () => {
    const events: SessionEvent[] = [
      {
        seq: 0,
        ts: "2026-10-18T00:00:00.000Z",
        type: "assistant",
        payload: {
          content: "",
          toolCalls: [
            { id: "kb", name: "kb_lookup", arguments: { query: "uart" } },
            { id: "mem", name: "mem_read", arguments: { address: "0x0" } },
          ],
        },
      },
      {
        seq: 1,
        ts: "2026-10-18T00:00:00.000Z",
        type: "tool_result",
        payload: { id: "kb", ok: true, text: "命中 1", detail: { hits: [] } },
      },
      {
        seq: 2,
        ts: "2026-10-18T00:00:00.000Z",
        type: "tool_result",
        payload: { id: "mem", ok: false, text: "读失败", code: "io_error" },
      },
    ];
    const root = mount();
    render(<Dock view={transcriptFromSession(events)} device={UNKNOWN_DEVICE} />, root);
    const marks = [...root.querySelectorAll(".log-mark")].map((el) => el.getAttribute("data-l"));
    expect(marks).toEqual(["kv", "err"]);
    const heads = [...root.querySelectorAll<HTMLButtonElement>(".dock-sec-head")];
    const logDot = heads.find((head) => head.textContent?.includes("调试日志"))!.querySelector(".dot");
    expect(logDot!.getAttribute("data-s")).toBe("warn");
  });

  it("日志点无错误时为 ok、无日志时为 idle", () => {
    const root = mount();
    render(<Dock view={makeTranscriptView()} device={CONNECTED_DEVICE} />, root);
    const head = [...root.querySelectorAll<HTMLButtonElement>(".dock-sec-head")]
      .find((item) => item.textContent?.includes("调试日志"))!;
    expect(head.querySelector(".dot")!.getAttribute("data-s")).toBe("ok");
    const empty = mount();
    render(<Dock view={emptyTranscriptView()} device={CONNECTED_DEVICE} />, empty);
    const emptyHead = [...empty.querySelectorAll<HTMLButtonElement>(".dock-sec-head")]
      .find((item) => item.textContent?.includes("调试日志"))!;
    expect(emptyHead.querySelector(".dot")!.getAttribute("data-s")).toBe("idle");
  });

  it("从工具事件派生日志与寄存器", () => {
    const root = mount();
    render(<Dock view={makeTranscriptView()} device={CONNECTED_DEVICE} />, root);
    expect(root.textContent).toContain("kb_lookup");
    expect(root.textContent).toContain("· ok");
    expect(root.textContent).toContain("时钟源判定");
    expect(root.querySelectorAll(".reg-table tbody tr").length).toBeGreaterThan(0);
    expect(root.querySelectorAll(".log-item").length).toBeGreaterThan(0);
  });

  it("未接入设备时四个字段显示未接入", () => {
    const root = mount();
    render(<DeviceMonitor device={UNKNOWN_DEVICE} registers={[]} />, root);
    expect([...root.querySelectorAll(".field dd")].map((el) => el.textContent)).toEqual([
      "未接入",
      "未接入",
      "未接入",
      "未接入",
    ]);
  });

  it("未接入设备时复位按钮禁用", () => {
    const root = mount();
    render(<DeviceMonitor device={UNKNOWN_DEVICE} registers={[]} />, root);
    const reset = [...root.querySelectorAll<HTMLButtonElement>(".btn")].find((b) => b.textContent?.includes("复位"))!;
    expect(reset.disabled).toBe(true);
  });

  it("复位需二次确认，未确认不显示已执行", async () => {
    const root = mount();
    render(<DeviceMonitor device={CONNECTED_DEVICE} registers={[]} />, root);
    const reset = [...root.querySelectorAll<HTMLButtonElement>(".btn")].find((b) => b.textContent?.includes("复位"))!;
    reset.click();
    await Promise.resolve();
    expect(root.textContent).toContain("AIRCR @ 0xE000_ED0C = 0x05FA_0004");
    expect(root.textContent).not.toContain("已执行复位");
    const confirm = [...root.querySelectorAll<HTMLButtonElement>(".btn")].find((b) => b.textContent?.includes("确认复位"))!;
    confirm.click();
    await Promise.resolve();
    expect(root.textContent).toContain("执行中，等待工具结果");
    expect(root.textContent).not.toContain("已执行");
  });

  it("PortSettings 未接入串口时显示说明且统计为 —", () => {
    const root = mount();
    render(<PortSettings serial="unknown" />, root);
    expect(root.textContent).toContain("未检测到串口");
    expect(root.textContent).toContain("—");
    const open = [...root.querySelectorAll<HTMLButtonElement>(".btn")].find((b) => b.textContent?.includes("打开端口"))!;
    expect(open.disabled).toBe(true);
  });

  it("PortSettings 使用 API 返回的串口名", () => {
    const root = mount();
    render(<PortSettings serial="COM7" />, root);
    expect(root.textContent).toContain("COM7");
  });
});