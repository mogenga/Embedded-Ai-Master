// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { ConversationHeader } from "../../../src/ui/components/conversation/header.js";
import { PathLine } from "../../../src/ui/components/conversation/pathline.js";
import { MessageStream } from "../../../src/ui/components/conversation/messages.js";
import { reduceStep, transcriptFromSession } from "../../../src/ui/view/transcript.js";
import type { SessionEvent } from "../../../src/session/types.js";
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
    const events: SessionEvent[] = [
      ...UART_TRANSCRIPT_EVENTS,
      { seq: 90, ts: "t", type: "checkpoint", payload: { turn: 1 } },
      { seq: 91, ts: "t", type: "compaction", payload: { summary: "压缩" } },
    ];
    const viewWithCheckpoint = transcriptFromSession(events);
    expect(viewWithCheckpoint.events).toEqual(view.events);
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<MessageStream view={viewWithCheckpoint} />, root);
    expect(root.querySelector(".checkpoint")).toBeNull();
    expect(root.textContent).not.toContain("checkpoint");
  });
  it("MessageStream 将确认回调透传给 GuardNotice", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let confirmed = 0;
    render(
      <MessageStream
        view={view}
        onGuardConfirm={() => {
          confirmed += 1;
        }}
      />,
      root,
    );
    const confirm = [...root.querySelectorAll<HTMLButtonElement>(".guard-actions button")].find((b) =>
      b.textContent?.includes("确认写入"),
    );
    confirm?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmed).toBe(1);
    expect(root.querySelector(".guard")?.getAttribute("data-state")).toBe("执行中");
    expect(root.textContent).not.toContain("已执行");
  });
  it("MessageStream 将拒绝回调透传给 GuardNotice", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let rejected = 0;
    render(
      <MessageStream
        view={view}
        onGuardReject={() => {
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
  });
});