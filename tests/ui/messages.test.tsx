// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { MessageStream } from "../../src/ui/components/conversation/messages.js";
import type { SessionEvent } from "../../src/session/types.js";
import { transcriptFromSession } from "../../src/ui/view/transcript.js";

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function permissionView(action: "allow" | "ask" | "deny", effective: "allow" | "deny") {
  const events: SessionEvent[] = [
    {

      seq: 1,
      ts: "t",
      type: "permission_decision",
      payload: {
        callId: "c1",
        tool: "mem_write",
        action,
        effective,
        reason: "preset:diagnose:write",
        preset: "diagnose",
        source: "builtin",
        paramsDigest: "d",
        paramsKeys: ["address", "value"],
        access: "write",
      },
    },
  ];
  return transcriptFromSession(events);
}

describe("permission message", () => {
  it("渲染工具、动作、结果与理由", () => {
    const root = mount();
    render(<MessageStream view={permissionView("ask", "deny")} />, root);
    const block = root.querySelector(".permission");
    expect(block).not.toBeNull();
    expect(root.textContent).toContain("mem_write");
    expect(root.textContent).toContain("ask");
    expect(root.textContent).toContain("preset:diagnose:write");
  });

  it("action=ask 且 effective=deny 同时可见「拒绝」与「未执行」", () => {
    const root = mount();
    render(<MessageStream view={permissionView("ask", "deny")} />, root);
    expect(root.textContent).toContain("拒绝");
    expect(root.textContent).toContain("未执行");
    expect(root.textContent).not.toContain("已执行");
    expect(root.querySelector(".permission")?.getAttribute("data-effective")).toBe("deny");
  });

  it("允许时显示通过而不显示未执行", () => {
    const root = mount();
    render(<MessageStream view={permissionView("allow", "allow")} />, root);
    expect(root.textContent).toContain("允许");
    expect(root.textContent).not.toContain("未执行");
  });

  it("permission 不渲染成工具卡", () => {
    const root = mount();
    render(<MessageStream view={permissionView("deny", "deny")} />, root);
    expect(root.querySelectorAll(".tool").length).toBe(0);
    expect(root.querySelectorAll(".permission").length).toBe(1);
  });

  it("仅 tool_started（无 tool_result）的工具卡显示执行中", () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        ts: "t",
        type: "assistant",
        payload: {
          content: "",
          toolCalls: [{ id: "c1", name: "serial_read", arguments: { port: "COM3" } }],
        },
      },
      { seq: 2, ts: "t", parent: 1, type: "tool_started", payload: { callId: "c1", tool: "serial_read", access: "read" } },
    ];
    const root = mount();
    render(<MessageStream view={transcriptFromSession(events)} />, root);
    expect(root.querySelector(".tool-flag--pending")?.textContent).toContain("执行中");
  });

  it("权限拒绝且无 tool_result 时工具卡不再显示执行中", () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        ts: "t",
        type: "assistant",
        payload: {
          content: "",
          toolCalls: [{ id: "c1", name: "mem_write", arguments: { address: "0x0", value: "1" } }],
        },
      },
      {
        seq: 2,
        ts: "t",
        parent: 1,
        type: "permission_decision",
        payload: {
          callId: "c1",
          tool: "mem_write",
          action: "ask",
          effective: "deny",
          reason: "preset:read-only:write",
          preset: "read-only",
          source: "builtin",
          paramsDigest: "d",
          paramsKeys: ["address", "value"],
          access: "write",
        },
      },
    ];
    const root = mount();
    render(<MessageStream view={transcriptFromSession(events)} />, root);
    expect(root.querySelector(".tool-flag--pending")).toBeNull();
    expect(root.querySelector(".tool-flag--error")?.textContent).toContain("permission_denied");
    expect(root.textContent).toContain("拒绝");
    expect(root.textContent).toContain("未执行");
  });
});