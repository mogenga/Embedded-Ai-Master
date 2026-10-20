// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { Dock } from "../../src/ui/components/dock/dock.js";
import { DebugLog } from "../../src/ui/components/dock/debug-log.js";
import type { McpStatusPayload } from "../../src/session/types.js";
import { emptyTranscriptView } from "../../src/ui/view/transcript.js";
import { UNKNOWN_DEVICE } from "./support/builders.js";

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

const STATUSES: McpStatusPayload[] = [
  { kind: "connected", server: "echo", toolCount: 4 },
  { kind: "tool_name_renamed", server: "echo", name: "mcp__echo__dup_a_123456", originalName: "mcp__echo__dup_a" },
  { kind: "call_failed", server: "echo", tool: "echo", message: "boom" },
];

describe("dock mcp status", () => {
  it("在调试坞显示 MCP 状态", () => {
    const root = mount();
    render(<Dock view={emptyTranscriptView()} device={UNKNOWN_DEVICE} mcpStatuses={STATUSES} />, root);
    expect(root.querySelectorAll(".mcp-status-item").length).toBe(3);
    expect(root.textContent).toContain("connected");
    expect(root.textContent).toContain("echo");
    expect(root.textContent).toContain("tool_name_renamed");
  });

  it("只显示最新 N 条", () => {
    const many: McpStatusPayload[] = Array.from({ length: 12 }, (_, index) => ({
      kind: "connected",
      server: `server-${index}`,
    }));
    const root = mount();
    render(<Dock view={emptyTranscriptView()} device={UNKNOWN_DEVICE} mcpStatuses={many} />, root);
    expect(root.querySelectorAll(".mcp-status-item").length).toBe(5);
    expect(root.textContent).toContain("server-11");
    expect(root.textContent).not.toContain("server-0");
  });

  it("DebugLog 直接接收状态并渲染最新条目", () => {
    const root = mount();
    render(<DebugLog lines={[]} mcpStatuses={STATUSES.slice(0, 2)} />, root);
    expect(root.querySelectorAll(".mcp-status-item").length).toBe(2);
    expect(root.textContent).toContain("暂无工具调用");
  });
});