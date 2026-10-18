// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { App } from "../../../src/ui/app.js";
import { TopBar } from "../../../src/ui/components/topbar.js";
import { StatusBar } from "../../../src/ui/components/statusbar.js";
import { makeAppProps, makeTranscriptView, UNKNOWN_DEVICE } from "../support/builders.js";

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("layout", () => {
  it("App 渲染三栏与状态栏", () => {
    const root = mount();
    render(<App {...makeAppProps()} />, root);
    expect(root.querySelector(".app")).not.toBeNull();
    expect(root.querySelector(".topbar")).not.toBeNull();
    expect(root.querySelector(".rail")).not.toBeNull();
    expect(root.querySelector(".conversation")).not.toBeNull();
    expect(root.querySelector(".dock")).not.toBeNull();
    expect(root.querySelector(".statusbar")).not.toBeNull();
  });

  it("TopBar 展示真实设备字段，unknown 显示未接入", () => {
    const root = mount();
    render(<TopBar themeChoice="system" onThemeChange={() => {}} dockOpen onDockToggle={() => {}} device={UNKNOWN_DEVICE} />, root);
    expect([...root.querySelectorAll(".chip")].map((el) => el.textContent)).toEqual([
      "未接入",
      "未接入",
      "未接入",
    ]);
  });

  it("TopBar 主题切换按 aria-pressed 高亮当前项", () => {
    const root = mount();
    render(<TopBar themeChoice="dark" onThemeChange={() => {}} dockOpen onDockToggle={() => {}} device={UNKNOWN_DEVICE} />, root);
    const pressed = root.querySelectorAll(".seg [aria-pressed=\"true\"]");
    expect(pressed.length).toBe(1);
    expect(root.querySelector('[data-theme-opt="dark"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('[data-theme-opt="light"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("TopBar 点击主题项回传选择", () => {
    const root = mount();
    const calls: string[] = [];
    render(<TopBar themeChoice="system" onThemeChange={(choice) => calls.push(choice)} dockOpen onDockToggle={() => {}} device={UNKNOWN_DEVICE} />, root);
    (root.querySelector('[data-theme-opt="light"]') as HTMLButtonElement).click();
    expect(calls).toEqual(["light"]);
  });

  it("DockToggle 反映展开态并回传点击", () => {
    const root = mount();
    let toggles = 0;
    render(<TopBar themeChoice="system" onThemeChange={() => {}} dockOpen={false} onDockToggle={() => { toggles += 1; }} device={UNKNOWN_DEVICE} />, root);
    const toggle = root.querySelector(".icon-btn") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    expect(toggles).toBe(1);
  });

  it("Dock 折叠类随 dockOpen 切换", () => {
    const root = mount();
    render(<App {...makeAppProps()} dockOpen={false} />, root);
    expect(root.querySelector(".workspace")?.className).toContain("is-collapsed");
    render(<App {...makeAppProps()} dockOpen />, root);
    expect(root.querySelector(".workspace")?.className).not.toContain("is-collapsed");
  });

  it("加载中显示加载提示", () => {
    const root = mount();
    render(<App {...makeAppProps({ view: { ...makeTranscriptView(), events: [] }, connection: "loading" })} />, root);
    expect(root.textContent).toContain("加载中");
  });

  it("加载失败显示错误与重试", () => {
    const root = mount();
    let retried = 0;
    render(
      <App
        {...makeAppProps({
          view: { ...makeTranscriptView(), events: [] },
          connection: "error",
          errorMessage: "无法连接接口",
          onRetry: () => {
            retried += 1;
          },
        })}
      />,
      root,
    );
    expect(root.textContent).toContain("无法连接接口");
    const retry = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("重试"))!;
    retry.click();
    expect(retried).toBe(1);
  });

  it("无会话时对话区显示空态", () => {
    const root = mount();
    render(<App {...makeAppProps({ view: { ...makeTranscriptView(), events: [] }, connection: "ready" })} />, root);
    expect(root.textContent).toContain("暂无会话");
  });

  it("StatusBar 展示会话/上下文/费用", () => {
    const root = mount();
    render(<StatusBar sessionId="#128" context="12.4k / 200k" cost="¥0.42" />, root);
    expect(root.textContent).toContain("#128");
    expect(root.textContent).toContain("12.4k / 200k");
    expect(root.textContent).toContain("¥0.42");
  });

  it("StatusBar 状态点区分未知与已知", () => {
    const root = mount();
    render(<StatusBar probe="" alert="UART 帧错误" />, root);
    const dots = root.querySelectorAll(".sb .dot");
    expect(dots[0].getAttribute("data-s")).toBe("idle");
    expect(dots[1].getAttribute("data-s")).toBe("idle");
    expect(dots[2].getAttribute("data-s")).toBe("warn");
  });

  it("App 状态栏接投影的会话/上下文/费用", () => {
    const root = mount();
    const view = {
      ...makeTranscriptView(),
      context: { used: 12400, limit: 200000 },
      cost: 0.018,
      sessionId: "#128",
    };
    render(<App {...makeAppProps({ view })} />, root);
    const text = root.querySelector(".statusbar")?.textContent ?? "";
    expect(text).toContain("#128");
    expect(text).toContain("12.4k / 200k");
    expect(text).toContain("$0.018");
  });

  it("App 状态栏缺 context/cost 时显示 —", () => {
    const root = mount();
    const view = { ...makeTranscriptView(), usage: undefined, cost: undefined };
    render(<App {...makeAppProps({ view })} />, root);
    const values = [...root.querySelectorAll(".statusbar .sb.mono")].map((el) => el.textContent);
    expect(values).toContain("—");
  });

  it("无 emoji：App 文案不含 emoji 码点", () => {
    const root = mount();
    render(<App {...makeAppProps()} />, root);
    const text = root.textContent ?? "";
    const bad = [...text].filter((ch) => /\p{Extended_Pictographic}/u.test(ch));
    expect(bad).toEqual([]);
  });
});