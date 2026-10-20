// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { ApprovalNotice } from "../../../src/ui/components/conversation/approval-notice.js";
import type { ApprovalModel } from "../../../src/ui/view/transcript.js";

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function makeApproval(overrides: Partial<ApprovalModel> = {}): ApprovalModel {
  return {
    requestId: "req-1",
    callId: "call-1",
    tool: "mem_write",
    reason: "写入寄存器前需声明目标地址与写入值",
    preset: "confirm-writes",
    paramsPreviewText: "address=0x40004408, value=0x0009",
    deadlineAt: FUTURE,
    status: "pending",
    ...overrides,
  };
}

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (found === undefined) throw new Error(`未找到按钮：${text}`);
  return found;
}

describe("ApprovalNotice", () => {
  it("pending 显示工具名、理由、参数摘要、截止时间与两个按钮", () => {
    const root = mount();
    render(<ApprovalNotice approval={makeApproval()} sessionId="s1" onDecision={async () => {}} />, root);
    expect(root.querySelector(".approval")).not.toBeNull();
    expect(root.textContent).toContain("mem_write");
    expect(root.textContent).toContain("写入寄存器前需声明目标地址与写入值");
    expect(root.textContent).toContain("address=0x40004408, value=0x0009");
    expect(root.textContent).toContain("截止");
    expect(root.querySelector(".approval-head .approval-action")?.textContent).toBe("ask");
    expect(root.querySelector(".approval-head .approval-state")?.textContent).toBe("待审批");
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain("批准");
    expect(buttons[1].textContent).toContain("拒绝");
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(false);
  });

  it("点击批准回传 allow，提交中禁用按钮，成功后提示等待确认且不本地改状态", async () => {
    const root = mount();
    const calls: Array<[string, string, "allow" | "deny"]> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(
      <ApprovalNotice
        approval={makeApproval()}
        sessionId="s1"
        onDecision={async (sessionId, requestId, decision) => {
          calls.push([sessionId, requestId, decision]);
          await gate;
        }}
      />,
      root,
    );
    buttonByText(root, "批准").click();
    await tick();
    expect(calls).toEqual([["s1", "req-1", "allow"]]);
    expect(buttonByText(root, "批准").disabled).toBe(true);
    expect(buttonByText(root, "拒绝").disabled).toBe(true);

    release();
    await tick();
    expect(root.textContent).toContain("已提交，等待确认");
    expect(root.querySelector(".approval")?.getAttribute("data-status")).toBe("pending");
    expect(root.textContent).not.toContain("已允许");
    expect(buttonByText(root, "批准").disabled).toBe(true);
  });

  it("点击拒绝回传 deny", async () => {
    const root = mount();
    const calls: Array<[string, string, "allow" | "deny"]> = [];
    render(
      <ApprovalNotice
        approval={makeApproval()}
        sessionId="s1"
        onDecision={async (sessionId, requestId, decision) => {
          calls.push([sessionId, requestId, decision]);
        }}
      />,
      root,
    );
    buttonByText(root, "拒绝").click();
    await tick();
    expect(calls).toEqual([["s1", "req-1", "deny"]]);
    expect(root.textContent).toContain("已提交，等待确认");
  });

  it("onDecision 失败时显示错误文本且按钮恢复", async () => {
    const root = mount();
    render(
      <ApprovalNotice
        approval={makeApproval()}
        sessionId="s1"
        onDecision={() => Promise.reject(new Error("审批接口不可用"))}
      />,
      root,
    );
    buttonByText(root, "批准").click();
    await tick();
    expect(root.textContent).toContain("审批接口不可用");
    expect(buttonByText(root, "批准").disabled).toBe(false);
    expect(buttonByText(root, "拒绝").disabled).toBe(false);
    expect(root.textContent).not.toContain("已提交，等待确认");
  });

  it.each([
    [409, "审批请求已完成相反的决策"],
    [410, "审批请求已过期"],
  ] as const)("onDecision 返回 HTTP %s 时记录终态错误并禁用按钮", async (status, message) => {
    const root = mount();
    render(
      <ApprovalNotice
        approval={makeApproval()}
        sessionId="s1"
        onDecision={() => Promise.reject(Object.assign(new Error(message), { status }))}
      />,
      root,
    );
    buttonByText(root, "批准").click();
    await tick();
    expect(root.textContent).toContain(message);
    expect(buttonByText(root, "批准").disabled).toBe(true);
    expect(buttonByText(root, "拒绝").disabled).toBe(true);
    expect(root.querySelector(".approval")?.getAttribute("data-status")).toBe("pending");
    expect(root.textContent).not.toContain("已允许");
    expect(root.textContent).not.toContain("已拒绝");
  });

  it("deadlineAt 已过期时禁用按钮并显示已过期", () => {
    const root = mount();
    render(
      <ApprovalNotice approval={makeApproval({ deadlineAt: PAST })} sessionId="s1" onDecision={async () => {}} />,
      root,
    );
    expect(root.textContent).toContain("已过期");
    expect(buttonByText(root, "批准").disabled).toBe(true);
    expect(buttonByText(root, "拒绝").disabled).toBe(true);
  });

  it.each([
    ["allowed", "已允许"],
    ["denied", "已拒绝"],
    ["aborted", "已中断"],
    ["expired", "已过期"],
  ] as const)("终态 %s 无按钮且显示 %s", (status, label) => {
    const root = mount();
    render(<ApprovalNotice approval={makeApproval({ status })} sessionId="s1" onDecision={async () => {}} />, root);
    expect(root.querySelectorAll("button").length).toBe(0);
    expect(root.textContent).toContain(label);
  });

  it("缺少 onDecision 时按钮禁用", () => {
    const root = mount();
    render(<ApprovalNotice approval={makeApproval()} sessionId="s1" />, root);
    expect(buttonByText(root, "批准").disabled).toBe(true);
    expect(buttonByText(root, "拒绝").disabled).toBe(true);
  });
});