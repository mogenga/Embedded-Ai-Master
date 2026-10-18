// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { ConversationHeader } from "../../../src/ui/components/conversation/header.js";
import { PathLine } from "../../../src/ui/components/conversation/pathline.js";
import { MessageStream } from "../../../src/ui/components/conversation/messages.js";
import { reduceStep, transcriptFromSession } from "../../../src/ui/view/transcript.js";
import { UART_TRANSCRIPT_EVENTS } from "../../../src/ui/demo/fixtures.js";

describe("conversation", () => {
  const view = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
  it("会话头展示标题与胶囊", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<ConversationHeader title="测试会话" status="diagnosing" />, root);
    expect(root.textContent).toContain("测试会话");
    expect(root.querySelector(".status")).not.toBeNull();
  });
  it("路径条五步状态匹配 reduceStep", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<PathLine steps={reduceStep(UART_TRANSCRIPT_EVENTS)} />, root);
    expect(root.querySelectorAll(".step").length).toBe(5);
    expect(root.querySelectorAll(`.step[data-s="done"]`).length).toBe(5);
  });
  it("消息流渲染用户与 agent 与 ask", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<MessageStream view={view} />, root);
    expect(root.querySelector(".turn--user")).not.toBeNull();
    expect(root.textContent).toContain("Embedded-Ai-Master");
    expect(root.querySelector(".ask")).not.toBeNull();
  });
  it("消息流不渲染 checkpoint 事件（无幽灵节点）", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<MessageStream view={view} />, root);
    expect(root.querySelector(".checkpoint")).toBeNull();
  });
});