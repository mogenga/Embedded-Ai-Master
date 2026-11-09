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
  SubagentResultPayload,
  SubagentStartedPayload,
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

const subagentStarted: SubagentStartedPayload = {
  id: "sa_0123456789ab",
  sessionDir: "/sessions/parent/subagents/sa_0123456789ab",
  promptPreview: "确认主频",
  startedAt: "2026-11-08T00:00:00.000Z",
  maxTurns: 30,
  timeoutMs: 600_000,
};

const subagentResult: SubagentResultPayload = {
  id: "sa_0123456789ab",
  sessionDir: "/sessions/parent/subagents/sa_0123456789ab",
  status: "finished",
  startedAt: "2026-11-08T00:00:00.000Z",
  finishedAt: "2026-11-08T00:03:00.000Z",
  turns: 3,
  toolCalls: 2,
  promptTokens: 1200,
  completionTokens: 180,
  text: "结论：时钟树是 72 MHz。",
  textBytes: 42,
  capturedBytes: 42,
  promptPreview: "确认主频",
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

  it("buildMessages 忽略 subagent_result，且它可出现在工具批次中间", () => {
    // 子代理完全可能在父轮次的 assistant 与它的 tool_result 之间结束。
    // 与 `background_result` 同一分支：不能并进会在未闭合批次上抛错的那三类。
    const events: SessionEvent[] = [
      {
        seq: 0,
        ts: "t",
        type: "assistant",
        payload: { content: "", toolCalls: [{ id: "c1", name: "subagent", arguments: {} }] },
      },
      { seq: 1, ts: "t", type: "subagent_result", payload: { ...subagentResult } },
      { seq: 2, ts: "t", type: "tool_result", payload: { id: "c1", text: "ok" }, parent: 0 },
    ];

    expect(() => buildMessages(events)).not.toThrow();
    expect(buildMessages(events).map((message) => message.role)).toEqual(["assistant", "tool"]);
  });

  it("桌面协议层认识 subagent_result，不会画成「未识别的事件类型」", () => {
    // Task 2 才画那一行提示；这里只钉住**登记**这件事——漏登记的表现不是
    // 「少画一行」，而是屏幕上一句警告，恰好盖在子代理结论本该出现的位置。
    const ctx = createContext({ sessionId: "s" });
    const out = sessionEventToHostEvents(
      { seq: 0, ts: "t", type: "subagent_result", payload: { ...subagentResult } },
      ctx,
    );

    expect(
      out.filter(
        (message) =>
          message.type === "notice" && String(message.text).includes("未识别的事件类型"),
      ),
    ).toStrictEqual([]);
  });

  it("subagent_result 事件往返持久化：白名单缺一项就会整份日志不可读", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.append({ type: "user", payload: { content: "u" } });
    await session.append({ type: "subagent_result", payload: { ...subagentResult } });
    await session.close();

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.type)).toEqual(["user", "subagent_result"]);
    expect(result.events[1]?.payload).toStrictEqual({ ...subagentResult });
  });

  it("buildMessages 忽略 subagent_started，且它可出现在工具批次中间", () => {
    // `subagent` 工具在自己的 execute 里写这条事件，此刻 assistant 与它的
    // tool_result 都还没闭合。与 `subagent_result` 同一分支：它是事实记录，
    // 不是模型说过的话，也绝不能被并进会在未闭合批次上抛错的那三类。
    const events: SessionEvent[] = [
      {
        seq: 0,
        ts: "t",
        type: "assistant",
        payload: { content: "", toolCalls: [{ id: "c1", name: "subagent", arguments: {} }] },
      },
      { seq: 1, ts: "t", type: "subagent_started", payload: { ...subagentStarted } },
      { seq: 2, ts: "t", type: "tool_result", payload: { id: "c1", text: "ok" }, parent: 0 },
    ];

    expect(() => buildMessages(events)).not.toThrow();
    expect(buildMessages(events).map((message) => message.role)).toEqual(["assistant", "tool"]);
  });

  it("桌面协议层认识 subagent_started，不会画成「未识别的事件类型」", () => {
    // 漏登记的表现不是「少画一行」，而是每次派发子代理都在工具行上方多一句警告。
    const ctx = createContext({ sessionId: "s" });
    const out = sessionEventToHostEvents(
      { seq: 0, ts: "t", type: "subagent_started", payload: { ...subagentStarted } },
      ctx,
    );

    expect(
      out.filter(
        (message) =>
          message.type === "notice" && String(message.text).includes("未识别的事件类型"),
      ),
    ).toStrictEqual([]);
    // **登记 ≠ 绘制在转录里**：这条事件产出的是输入框上方那条「运行中」的界面
    // 状态，不是对话气泡。Task 1 曾在这里钉 `toStrictEqual([])`；Task 2 给它加了
    // 绘制之后，那条断言被换成下面这两条——**不是删掉**：一条要求确实产出了一条
    // 消息（否则「登记了但哪也不去」会静默通过），一条要求它没有变成 notice
    // （转录里多一行「子代理开始」与工具行重复，且会在每次派发时出现）。
    expect(out).toStrictEqual([
      {
        type: "subagent_started",
        id: subagentStarted.id,
        promptPreview: subagentStarted.promptPreview,
        startedAt: subagentStarted.startedAt,
        sessionDir: subagentStarted.sessionDir,
        maxTurns: subagentStarted.maxTurns,
        timeoutMs: subagentStarted.timeoutMs,
      },
    ]);
    expect(out.filter((message) => message.type === "notice")).toStrictEqual([]);
  });

  it("subagent_started 事件往返持久化：白名单缺一项就会整份日志不可读", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.append({ type: "user", payload: { content: "u" } });
    await session.append({ type: "subagent_started", payload: { ...subagentStarted } });
    await session.close();

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.type)).toEqual(["user", "subagent_started"]);
    expect(result.events[1]?.payload).toStrictEqual({ ...subagentStarted });
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
