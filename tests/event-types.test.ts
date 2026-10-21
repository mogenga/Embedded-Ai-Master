import { describe, expect, it } from "vitest";
import { buildMessages } from "../src/context/build.js";
import { sessionEventsToMessages, sessionEventToHostEvents, createContext } from "../desktop/renderer/protocol.js";
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

  it("桌面协议层不把状态类事件画成消息", () => {
    expect(sessionEventsToMessages(events)).toEqual([]);
  });

  it("桌面协议层把 device_status 与 mcp_status 转成状态事件", () => {
    const ctx = createContext({ sessionId: "s" });
    const out = events.flatMap((event) => sessionEventToHostEvents(event, ctx));
    expect(out.map((message) => message.type)).toStrictEqual(["tool_start", "notice", "device_status"]);
    expect(out.filter((message) => message.type === "notice")[0].level).toBe("dim");
    // The probe's own fields travel under `device`, not as a whole board
    // state: the board pane's fields (target, ports, scan) do not exist here.
    expect(out[2].device).toStrictEqual({ probe: "attached" });
    expect(out[2].tool).toBe("mcp__probe__attach");
  });
});
