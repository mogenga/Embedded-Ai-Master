// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { Composer } from "../../../src/ui/components/conversation/composer.js";
import { Dock } from "../../../src/ui/components/dock/dock.js";

describe("composer+dock", () => {
  it("空输入发送按钮禁用", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let sent = "";
    render(<Composer onSend={(t) => { sent = t; }} />, root);
    const send = root.querySelector<HTMLButtonElement>(".send")!;
    expect(send.disabled).toBe(true);
  });
  it("Enter 发送非空文本并清空", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let sent = "";
    render(<Composer onSend={(t) => { sent = t; }} />, root);
    const ta = root.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.value = "你好";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toBe("你好");
    expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });
  it("调试坞三分区可折叠且 aria-expanded 同步", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Dock logLines={[]} registers={[]} />, root);
    const heads = [...root.querySelectorAll<HTMLButtonElement>(".dock-sec-head")];
    expect(heads.length).toBe(3);
    const dev = heads.find((h) => h.textContent?.includes("设备监控"))!;
    expect(dev.getAttribute("aria-expanded")).toBe("true");
    dev.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dev.getAttribute("aria-expanded")).toBe("false");
  });
  it("未打开端口统计显示 — 而非 0", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Dock logLines={[]} registers={[]} />, root);
    expect(root.textContent).toContain("—");
  });
  it("Shift+Enter 换行且空输入 Enter 不发送", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let sent = "";
    render(<Composer onSend={(t) => { sent = t; }} />, root);
    const ta = root.querySelector("textarea")!;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    ta.value = "换行";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(sent).toBe("");
  });
  it("打开端口后统计显示数字且错误帧使用 danger", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Dock logLines={[]} registers={[]} />, root);
    const open = [...root.querySelectorAll<HTMLButtonElement>(".btn")].find((b) => b.textContent?.includes("打开端口"))!;
    open.click();
    await Promise.resolve();
    const danger = root.querySelector('.stat-v[data-s="danger"]');
    expect(danger?.textContent).toBe("312");
  });
  it("复位需二次确认，未确认不显示已执行", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Dock logLines={[]} registers={[]} />, root);
    const reset = [...root.querySelectorAll<HTMLButtonElement>(".btn")].find((b) => b.textContent?.includes("复位"))!;
    reset.click();
    await Promise.resolve();
    expect(root.textContent).toContain("AIRCR.SYSRESETREQ");
    expect(root.textContent).not.toContain("已执行复位");
    const confirm = [...root.querySelectorAll<HTMLButtonElement>(".btn")].find((b) => b.textContent?.includes("确认复位"))!;
    confirm.click();
    await Promise.resolve();
    expect(root.textContent).toContain("已执行复位");
  });
});