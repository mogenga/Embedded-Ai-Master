import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/types.js";
import { deviceFromSession, UNKNOWN_DEVICE } from "../../src/ui/view/device.js";

let seq = 0;

function deviceEvent(state: unknown): SessionEvent {
  seq += 1;
  return {
    seq,
    ts: "t",
    type: "device_status",
    payload: { callId: `c-${seq}`, server: "probe", tool: "mcp__probe__attach", state },
  };
}

describe("deviceFromSession", () => {
  it("空事件返回四个 unknown 字段", () => {
    expect(deviceFromSession([])).toEqual(UNKNOWN_DEVICE);
  });

  it("逐条 patch 合并，缺失字段保留", () => {
    const device = deviceFromSession([
      deviceEvent({ probe: "attached" }),
      deviceEvent({ serial: "open" }),
    ]);
    expect(device).toEqual({ probe: "attached", serial: "open", cpu: "unknown", backend: "unknown" });
  });

  it("后续事件只覆盖出现的字段", () => {
    const device = deviceFromSession([
      deviceEvent({ probe: "attached", serial: "open", cpu: "halted", backend: "renode" }),
      deviceEvent({ serial: "closed" }),
    ]);
    expect(device).toEqual({
      probe: "attached",
      serial: "closed",
      cpu: "halted",
      backend: "renode",
    });
  });

  it("未知键与非字符串值被忽略", () => {
    const device = deviceFromSession([
      deviceEvent({ probe: "attached", strange: "x", cpu: 42, backend: null, serial: ["open"] }),
    ]);
    expect(device).toEqual({ probe: "attached", serial: "unknown", cpu: "unknown", backend: "unknown" });
  });

  it("非法 state 形态被忽略", () => {
    const device = deviceFromSession([
      deviceEvent(undefined),
      deviceEvent(null),
      deviceEvent(["attached"]),
      deviceEvent("attached"),
      deviceEvent({ probe: "attached" }),
    ]);
    expect(device.probe).toBe("attached");
  });

  it("空数组重新开始为 unknown（新会话重置）", () => {
    expect(deviceFromSession([deviceEvent({ probe: "attached" })])).not.toEqual(UNKNOWN_DEVICE);
    expect(deviceFromSession([])).toEqual(UNKNOWN_DEVICE);
  });

  it("不从工具名或参数推断状态", () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        ts: "t",
        type: "assistant",
        payload: {
          content: "",
          toolCalls: [{ id: "c1", name: "mcp__probe__attach", arguments: { probe: "attached" } }],
        },
      },
      {
        seq: 2,
        ts: "t",
        type: "tool_result",
        payload: { id: "c1", ok: true, text: "probe attached", detail: { readout: [{ label: "probe", value: "attached" }] } },
      },
    ];
    expect(deviceFromSession(events)).toEqual(UNKNOWN_DEVICE);
  });
});