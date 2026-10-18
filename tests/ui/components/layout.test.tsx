// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { App } from "../../../src/ui/app.js";
import { TopBar } from "../../../src/ui/components/topbar.js";
import { StatusBar } from "../../../src/ui/components/statusbar.js";
import { UART_TRANSCRIPT_EVENTS } from "../../../src/ui/demo/fixtures.js";
import { transcriptFromSession } from "../../../src/ui/view/transcript.js";

describe("layout", () => {
  it("App 渲染三栏与状态栏", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<App view={transcriptFromSession(UART_TRANSCRIPT_EVENTS)} />, root);
    expect(root.querySelector(".app")).not.toBeNull();
    expect(root.querySelector(".topbar")).not.toBeNull();
    expect(root.querySelector(".rail")).not.toBeNull();
    expect(root.querySelector(".conversation")).not.toBeNull();
    expect(root.querySelector(".dock")).not.toBeNull();
    expect(root.querySelector(".statusbar")).not.toBeNull();
  });
  it("TopBar 主题切换按 aria-pressed 高亮当前项", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<TopBar themeChoice="dark" onThemeChange={() => {}} dockOpen onDockToggle={() => {}} />, root);
    const pressed = root.querySelectorAll(".seg [aria-pressed=\"true\"]");
    expect(pressed.length).toBe(1);
    expect(root.querySelector('[data-theme-opt="dark"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('[data-theme-opt="light"]')?.getAttribute("aria-pressed")).toBe("false");
  });
  it("TopBar 点击主题项回传选择", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const calls: string[] = [];
    render(<TopBar themeChoice="system" onThemeChange={(choice) => calls.push(choice)} dockOpen onDockToggle={() => {}} />, root);
    (root.querySelector('[data-theme-opt="light"]') as HTMLButtonElement).click();
    expect(calls).toEqual(["light"]);
  });
  it("DockToggle 反映展开态并回传点击", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let toggles = 0;
    render(<TopBar themeChoice="system" onThemeChange={() => {}} dockOpen={false} onDockToggle={() => { toggles += 1; }} />, root);
    const toggle = root.querySelector(".icon-btn") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    expect(toggles).toBe(1);
  });
  it("Dock 折叠类随 dockOpen 切换", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<App view={transcriptFromSession(UART_TRANSCRIPT_EVENTS)} dockOpen={false} />, root);
    expect(root.querySelector(".workspace")?.className).toContain("is-collapsed");
    render(<App view={transcriptFromSession(UART_TRANSCRIPT_EVENTS)} dockOpen />, root);
    expect(root.querySelector(".workspace")?.className).not.toContain("is-collapsed");
  });
  it("StatusBar 展示会话/上下文/费用", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<StatusBar sessionId="#128" context="12.4k / 200k" cost="¥0.42" />, root);
    expect(root.textContent).toContain("#128");
    expect(root.textContent).toContain("12.4k / 200k");
    expect(root.textContent).toContain("¥0.42");
  });
  it("StatusBar 状态点区分未知与已知", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<StatusBar probe="" alert="UART 帧错误" />, root);
    const dots = root.querySelectorAll(".sb .dot");
    expect(dots[0].getAttribute("data-s")).toBe("idle");
    expect(dots[1].getAttribute("data-s")).toBe("idle");
    expect(dots[2].getAttribute("data-s")).toBe("warn");
  });
  it("App 状态栏接投影的会话/上下文/费用", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = {
      ...transcriptFromSession(UART_TRANSCRIPT_EVENTS),
      context: { used: 12400, limit: 200000 },
      cost: 0.018,
      sessionId: "#128",
    };
    render(<App view={view} />, root);
    const text = root.querySelector(".statusbar")?.textContent ?? "";
    expect(text).toContain("#128");
    expect(text).toContain("12.4k / 200k");
    expect(text).toContain("$0.018");
  });
  it("App 状态栏缺 context/cost 时显示 —", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = { ...transcriptFromSession(UART_TRANSCRIPT_EVENTS), usage: undefined, cost: undefined };
    render(<App view={view} />, root);
    const values = [...root.querySelectorAll(".statusbar .sb.mono")].map((el) => el.textContent);
    expect(values).toContain("—");
  });
  it("无 emoji：App 文案不含 emoji 码点", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<App view={transcriptFromSession(UART_TRANSCRIPT_EVENTS)} />, root);
    const text = root.textContent ?? "";
    const bad = [...text].filter((ch) => /\p{Extended_Pictographic}/u.test(ch));
    expect(bad).toEqual([]);
  });
});