import { describe, expect, it } from "vitest";
import { buildMessages } from "../src/context/build.js";
import { transcriptFromSession } from "../src/ui/view/transcript.js";
import type {
  DeviceStatusPayload,
  McpStatusPayload,
  SessionEvent,
  ToolStartedPayload,
} from "../src/session/types.js";

const toolStarted: ToolStartedPayload = { callId: "c1", tool: "fs", access: "read" };
const mcpStatus: McpStatusPayload = { kind: "connected", server: "probe", toolCount: 2 };
const deviceStatus: DeviceStatusPayload = {
  callId: "c1",
  server: "probe",
  tool: "mcp__probe__attach",
  state: { probe: "attached" },
};

const events: SessionEvent[] = [
  { seq: 0, ts: "t", type: "tool_started", payload: { ...toolStarted } },
  { seq: 1, ts: "t", type: "mcp_status", payload: { ...mcpStatus } },
  { seq: 2, ts: "t", type: "device_status", payload: { ...deviceStatus } },
];

describe("新事件类型", () => {
  it("buildMessages 忽略 tool_started/mcp_status/device_status", () => {
    expect(() => buildMessages(events)).not.toThrow();
    expect(buildMessages(events).length).toBe(0);
  });

  it("transcript 投影不产生工具卡片且状态保持 idle", () => {
    const view = transcriptFromSession(events);
    expect(view.events.filter((event) => event.kind === "tool")).toEqual([]);
    expect(view.status).toBe("idle");
  });
});
