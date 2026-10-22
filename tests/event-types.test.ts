import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMessages } from "../src/context/build.js";
import { sessionEventsToMessages, sessionEventToHostEvents, createContext } from "../desktop/renderer/protocol.js";
import { readSessionDir } from "../src/session/persistence.js";
import { createSession } from "../src/session/session.js";
import type {
  DeviceStatusPayload,
  McpStatusPayload,
  SessionEvent,
  TodosPayload,
  ToolStartedPayload,
} from "../src/session/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "event-types-"));
  tempDirs.push(dir);
  return dir;
}

const toolStarted: ToolStartedPayload = { callId: "c1", tool: "fs", access: "read" };
// annotations 是可选的：老日志没有这个字段，回放时仍要能当作 ToolStartedPayload 用。
const toolStartedWithAnnotations: ToolStartedPayload = {
  callId: "c2",
  tool: "shell",
  access: "write",
  annotations: { destructive: true },
};
const mcpStatus: McpStatusPayload = { kind: "connected", server: "probe", toolCount: 2 };
const deviceStatus: DeviceStatusPayload = {
  callId: "c1",
  server: "probe",
  tool: "mcp__probe__attach",
  state: { probe: "attached" },
};
const todos: TodosPayload = {
  callId: "c3",
  items: [
    { content: "读 datasheet", status: "completed" },
    { content: "量波形", status: "in_progress" },
  ],
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

  it("带 annotations 的 tool_started 仍是合法事件，且不影响消息投影", () => {
    const withMarks: SessionEvent[] = [
      { seq: 0, ts: "t", type: "tool_started", payload: { ...toolStartedWithAnnotations } },
    ];
    expect(() => buildMessages(withMarks)).not.toThrow();
    expect(buildMessages(withMarks).length).toBe(0);
    expect(sessionEventsToMessages(withMarks)).toEqual([]);

    const ctx = createContext({ sessionId: "s" });
    const out = withMarks.flatMap((event) => sessionEventToHostEvents(event, ctx));
    expect(out.map((message) => message.type)).toStrictEqual(["tool_start"]);
    expect(out[0].name).toBe("shell");
  });

  it("buildMessages 忽略 todos：计划是界面状态，不进模型上下文", () => {
    const events: SessionEvent[] = [
      { seq: 0, ts: "t", type: "todos", payload: { ...todos } },
    ];

    expect(() => buildMessages(events)).not.toThrow();
    expect(buildMessages(events)).toEqual([]);
    // 桌面协议层同样不把它当消息：它走的是计划卡，不是对话。
    expect(sessionEventsToMessages(events)).toEqual([]);
  });

  it("todos 事件往返持久化：白名单缺一项就会整份日志不可读", async () => {
    // 这条覆盖 persistence 的 EVENT_TYPES：它是读取时的事件类型白名单，
    // 不是写盘过滤器。漏登记不会让写入失败，而会让**下一次读盘**抛
    // unknown_event_type，整份日志（包括之前的真实工具结果）一起不可用。
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.append({ type: "user", payload: { content: "u" } });
    await session.append({ type: "todos", payload: { ...todos } });
    await session.close();

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.type)).toEqual(["user", "todos"]);
    expect(result.events[1]?.payload).toStrictEqual({ ...todos });
  });
});
