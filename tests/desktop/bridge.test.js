import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserBridge } from "../../desktop/renderer/bridge.js";

/** Minimal EventSource stand-in: records URLs and lets a test push frames. */
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  close() {
    this.closed = true;
  }
  dispatch(type, data) {
    for (const handler of this.listeners.get(type) ?? []) handler({ data: JSON.stringify(data) });
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    for (const [matcher, handler] of routes) {
      if (String(url).includes(matcher)) return handler(String(url), init);
    }
    return jsonResponse({ error: { code: "not_found", message: "no route" } }, 404);
  };
  impl.calls = calls;
  return impl;
}

function storageStub() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

function collect(events) {
  return events;
}

beforeEach(() => {
  FakeEventSource.instances = [];
});

afterEach(() => {
  // `pickDirectory` probes the real global; a stub must not leak into the next
  // test (Node has no `showDirectoryPicker`, the "unsupported" branch).
  vi.unstubAllGlobals();
});

describe("bridge: boot", () => {
  it("安装后先发 hello/ready/state，再发列表与空命令", async () => {
    const fetchImpl = fakeFetch([["/api/sessions", () => jsonResponse({ sessions: [] })]]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = collect([]);
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.boot(); // boot 幂等
    expect(events.map((event) => event.type)).toStrictEqual([
      "hello",
      "ready",
      "state",
      "commands",
      "setup_checklist",
      "tree",
      "locale",
    ]);
    expect(events[2]).toMatchObject({ sessionId: "", mode: "diagnose", locale: "zh" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1).type).toBe("sessions");
  });

  it("订阅前产生的事件会在订阅时补发", () => {
    const bridge = createBrowserBridge({
      fetchImpl: fakeFetch([["/api/sessions", () => jsonResponse({ sessions: [] })]]),
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    bridge.boot();
    const seen = [];
    bridge.api.onEvent((event) => seen.push(event.type));
    expect(seen.slice(0, 3)).toStrictEqual(["hello", "ready", "state"]);
  });
});

describe("bridge: prompt", () => {
  it("POST /api/actions，随后按返回的 sessionId 打开 SSE", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "prompt", text: "串口没输出" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const posted = fetchImpl.calls.find((call) => call.url === "/api/actions");
    // The permission preset travels with the prompt: the server applies it to
    // this run, so the mode menu is not a label-only control.
    expect(JSON.parse(posted.body)).toStrictEqual({
      text: "串口没输出",
      mode: "diagnose",
    });
    expect(events.some((event) => event.type === "run_start")).toBe(true);
    // 提交时 renderer 已经画过用户消息；这里若再发 session_loaded 会把它清空。
    expect(events.some((event) => event.type === "session_loaded")).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events?sessionId=sess-1&since=-1");
    expect(bridge._internal.getSessionId()).toBe("sess-1");
  });

  it("已有会话时带上 sessionId 继续", async () => {
    const fetchImpl = fakeFetch([
      ["/api/sessions/sess-1", () =>
        jsonResponse({
          header: { id: "sess-1", workdir: "E:/p", status: "closed" },
          events: [{ seq: 0, ts: "t", type: "user", payload: { content: "hi" } }],
        })],
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: false }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    bridge.boot();
    bridge.api.send({ cmd: "loadSession", id: "sess-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.api.send({ cmd: "prompt", text: "继续" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const posted = fetchImpl.calls.find((call) => call.url === "/api/actions");
    expect(JSON.parse(posted.body)).toStrictEqual({
      text: "继续",
      sessionId: "sess-1",
      // The loaded session's workdir is the only cwd the bridge knows; the run
      // has to execute there, not wherever the UI happened to open.
      cwd: "E:/p",
      mode: "diagnose",
    });
    // The stream resumes after what the loaded transcript already showed. At
    // -1 the server would replay the whole log into a transcript the user was
    // already reading, so every follow-up redrew the conversation.
    expect(FakeEventSource.instances.at(-1).url).toBe("/api/events?sessionId=sess-1&since=0");
  });

  it("setMode 随下一条 prompt 下发内核，运行中拒绝切换", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "setMode", mode: "read-only" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.api.send({ cmd: "prompt", text: "读一下" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const posted = fetchImpl.calls.find((call) => call.url === "/api/actions");
    expect(JSON.parse(posted.body)).toStrictEqual({ text: "读一下", mode: "read-only" });

    // A second message while the first is still running must not change the
    // preset the operator already approved.
    bridge.api.send({ cmd: "setMode", mode: "danger-full-access" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === "notice" && event.text.includes("运行中"))).toBe(true);
  });

  it("POST 失败时上报 error + run_end，不留下忙碌状态", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () =>
        jsonResponse({ error: { code: "model_unavailable", message: "没有可用模型" } }, 503)],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "prompt", text: "x" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const error = events.find((event) => event.type === "error");
    expect(error.message).toContain("没有可用模型");
    expect(events.at(-1).type).toBe("run_end");
  });
});

describe("bridge: SSE 折返", () => {
  it("事件帧经协议层转成渲染器事件", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "prompt", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const source = FakeEventSource.instances[0];
    source.dispatch("message", {
      seq: 0,
      ts: "t",
      type: "assistant",
      payload: { content: "回答", toolCalls: [] },
      sessionId: "sess-1",
    });
    source.dispatch("message", {
      seq: 1,
      ts: "t",
      type: "status",
      payload: { status: "done", finishReason: "no_tool_calls" },
      sessionId: "sess-1",
    });

    expect(events.filter((event) => event.type.startsWith("assistant"))).toStrictEqual([
      { type: "assistant_start" },
      { type: "assistant_delta", text: "回答" },
      { type: "assistant_end" },
    ]);
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
  });

  it("stream_end 结束本轮并关闭连接", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "prompt", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const source = FakeEventSource.instances[0];
    source.dispatch("stream_end", { lastSeq: 0 });
    expect(source.closed).toBe(true);
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
  });

  it("其他会话的事件被忽略", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "prompt", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = events.length;
    FakeEventSource.instances[0].dispatch("message", {
      seq: 0,
      ts: "t",
      type: "assistant",
      payload: { content: "别的会话", toolCalls: [] },
      sessionId: "sess-2",
    });
    expect(events).toHaveLength(before);
  });

  it("序号出现缺口时整量重拉，不把两段状态接在一起", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
      ["/api/sessions/sess-1", () =>
        jsonResponse({
          header: { id: "sess-1", workdir: "E:/w", status: "open" },
          events: [
            { seq: 0, ts: "t", type: "user", payload: { content: "hi" } },
            { seq: 1, ts: "t", type: "assistant", payload: { content: "a", toolCalls: [] } },
            { seq: 2, ts: "t", type: "assistant", payload: { content: "b", toolCalls: [] } },
          ],
        })],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "prompt", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const source = FakeEventSource.instances[0];
    source.dispatch("message", { seq: 0, ts: "t", type: "assistant", payload: { content: "a", toolCalls: [] }, sessionId: "sess-1" });
    // seq 1 is missing: appending seq 2 would splice two non-adjacent states.
    source.dispatch("message", { seq: 2, ts: "t", type: "assistant", payload: { content: "b", toolCalls: [] }, sessionId: "sess-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const notice = events.find((event) => event.type === "notice" && event.text.includes("缺口"));
    expect(notice).toBeDefined();
    const reloaded = events.filter((event) => event.type === "session_loaded").at(-1);
    expect(reloaded).toBeDefined();
    expect(reloaded.messages.map((message) => message.text)).toStrictEqual(["hi", "a", "b"]);
    // The stale stream is gone and the cursor restarts after the reloaded log.
    expect(source.closed).toBe(true);
    expect(FakeEventSource.instances.at(-1).url).toBe("/api/events?sessionId=sess-1&since=2");
  });

  it("stream_error 从当前游标续接，次数用尽后明确报错", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "prompt", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    FakeEventSource.instances[0].dispatch("message", { seq: 0, ts: "t", type: "assistant", payload: { content: "a", toolCalls: [] }, sessionId: "sess-1" });
    FakeEventSource.instances[0].dispatch("stream_error", { code: "slow_consumer", lastSeq: 0 });
    // Re-opened from the cursor the client actually reached.
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toBe("/api/events?sessionId=sess-1&since=0");

    // Three reopens, then the fourth failure stops and says so.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      FakeEventSource.instances.at(-1).dispatch("stream_error", { code: "internal_error", lastSeq: 0 });
    }
    expect(FakeEventSource.instances).toHaveLength(4);
    expect(events.some((event) => event.type === "notice" && event.text.includes("已停止重试"))).toBe(true);
    expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
  });
});

describe("bridge: 会话与审批", () => {
  it("loadSession 回放历史并给出工作目录", async () => {
    const fetchImpl = fakeFetch([
      ["/api/sessions/sess-9", () =>
        jsonResponse({
          header: { id: "sess-9", workdir: "E:/work", status: "closed", model: "gw/flash" },
          events: [
            { seq: 0, ts: "t", type: "user", payload: { content: "症状" } },
            { seq: 1, ts: "t", type: "assistant", payload: { content: "结论", toolCalls: [] } },
          ],
        })],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "loadSession", id: "sess-9" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const loaded = events.find((event) => event.type === "session_loaded");
    expect(loaded).toMatchObject({ cwd: "E:/work" });
    expect(loaded.messages).toStrictEqual([
      { role: "user", text: "症状", index: 0, images: 0 },
      { role: "assistant", text: "结论" },
    ]);
    expect(bridge._internal.getLastSeq()).toBe(1);
    // 已结束的会话不打开 SSE：它一打开就会立刻 stream_end。
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("会话列表带标题与工作目录", async () => {
    const fetchImpl = fakeFetch([
      ["/api/sessions/sess-1", () =>
        jsonResponse({
          header: { id: "sess-1", status: "closed" },
          events: [{ seq: 0, ts: "t", type: "user", payload: { content: "串口没输出怎么办" } }],
        })],
      ["/api/sessions", () =>
        jsonResponse({
          sessions: [
            { id: "sess-1", createdAt: "2026-10-20T00:00:00.000Z", status: "closed", workdir: "E:/p" },
          ],
        })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const list = events.find((event) => event.type === "sessions");
    expect(list.sessions[0]).toMatchObject({
      id: "sess-1",
      cwd: "E:/p",
      title: "串口没输出怎么办",
      summary: "串口没输出怎么办",
    });
    expect(list.total).toBe(1);
  });

  it("permission：no → deny，yes → allow，always → allow + 提示", async () => {
    const fetchImpl = fakeFetch([
      ["/api/sessions/sess-1", () =>
        jsonResponse({ header: { id: "sess-1", status: "closed" }, events: [] })],
      ["/api/approvals", () => jsonResponse({ requestId: "r", decision: "allow" }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "loadSession", id: "sess-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    bridge.api.send({ cmd: "permission", id: "req-1", answer: "no" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.api.send({ cmd: "permission", id: "req-2", answer: "yes" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.api.send({ cmd: "permission", id: "req-3", answer: "always" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const posts = fetchImpl.calls.filter((call) => call.url === "/api/approvals");
    expect(posts.map((call) => JSON.parse(call.body))).toStrictEqual([
      { sessionId: "sess-1", requestId: "req-1", decision: "deny" },
      { sessionId: "sess-1", requestId: "req-2", decision: "allow" },
      { sessionId: "sess-1", requestId: "req-3", decision: "allow" },
    ]);
    const alwaysNotice = events.find(
      (event) => event.type === "notice" && event.text.includes("始终允许"),
    );
    expect(alwaysNotice).toBeDefined();
  });

  it("审批失败时关闭审批条而不是留下死按钮", async () => {
    const fetchImpl = fakeFetch([
      ["/api/sessions/sess-1", () =>
        jsonResponse({ header: { id: "sess-1", status: "closed" }, events: [] })],
      ["/api/approvals", () =>
        jsonResponse({ error: { code: "approval_expired", message: "已过期" } }, 410)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "loadSession", id: "sess-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.api.send({ cmd: "permission", id: "req-1", answer: "yes" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toContainEqual({ type: "permission_closed", id: "req-1" });
  });
});

describe("bridge: 命令面", () => {
  it("不支持的命令显式 warn", () => {
    const bridge = createBrowserBridge({
      fetchImpl: fakeFetch([]),
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "gitCommit", message: "x" });
    expect(events.at(-1)).toMatchObject({
      type: "notice",
      level: "warn",
      text: "浏览器形态暂不支持该命令：gitCommit",
    });
  });

  it("searchFiles 返回空匹配而不是每键一条警告", () => {
    const bridge = createBrowserBridge({
      fetchImpl: fakeFetch([]),
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    const before = events.length;
    bridge.api.send({ cmd: "searchFiles", query: "a" });
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toStrictEqual({ type: "file_matches", query: "a", files: [] });
  });

  it("newSession 清空会话并停掉事件流", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    bridge.boot();
    bridge.api.send({ cmd: "prompt", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const source = FakeEventSource.instances[0];
    bridge.api.send({ cmd: "newSession" });
    expect(source.closed).toBe(true);
    expect(bridge._internal.getSessionId()).toBe("");
  });

  it("abort 走 /api/abort", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
      ["/api/abort", () => jsonResponse({ sessionId: "sess-1", aborted: true }, 202)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    bridge.boot();
    bridge.api.send({ cmd: "prompt", text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.api.send({ cmd: "abort" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl.calls.some((call) => call.url === "/api/abort")).toBe(true);
  });

  it("setLocale 写 localStorage 并发 locale 事件", () => {
    const storage = storageStub();
    const bridge = createBrowserBridge({
      fetchImpl: fakeFetch([]),
      EventSourceImpl: FakeEventSource,
      storage,
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "setLocale", locale: "en" });
    expect(storage.getItem("prometheus.locale")).toBe("en");
    expect(events.at(-1)).toStrictEqual({ type: "locale", locale: "en" });
  });

  it("getSettings 从 /api/config 取真实配置，失败时不伪造", async () => {
    const config = {
      mcpServers: [{ name: "probe", command: "node", args: ["probe.js"] }],
      permissions: { preset: "diagnose", approvalTimeoutMs: 120000, rules: [] },
      run: { maxTurns: 10, maxCostUsd: null, timeoutMs: null, systemPrompt: "" },
      mcpPath: "E:/home/mcp.json",
      permissionsPath: "E:/home/permissions.json",
      runPath: "E:/home/run.json",
    };
    const fetchImpl = fakeFetch([
      ["/api/config", () => jsonResponse(config)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "getSettings" });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "settings").length).toBeGreaterThan(0);
    });
    const settings = events.filter((event) => event.type === "settings").at(-1);
    expect(settings.settings.mcpServers).toStrictEqual(config.mcpServers);
    expect(settings.settings.permissions).toStrictEqual(config.permissions);
    expect(settings.settings.run).toStrictEqual(config.run);
    expect(settings.settings.configPaths.mcp).toBe("E:/home/mcp.json");

    // A server that does not answer leaves the settings page without config
    // rather than with invented values.
    const broken = createBrowserBridge({
      fetchImpl: fakeFetch([["/api/config", () => jsonResponse({ error: { message: "boom" } }, 500)]]),
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const brokenEvents = [];
    broken.api.onEvent((event) => brokenEvents.push(event));
    broken.boot();
    broken.api.send({ cmd: "getSettings" });
    await vi.waitFor(() => {
      expect(brokenEvents.some((event) => event.type === "notice")).toBe(true);
    });
    expect(brokenEvents.filter((event) => event.type === "settings")).toHaveLength(0);
  });

  it("saveMcpServer 合并后 PUT /api/config，删除只移除同名项", async () => {
    let stored = {
      mcpServers: [{ name: "probe", command: "node" }],
      permissions: { preset: "diagnose", approvalTimeoutMs: 120000, rules: [] },
      run: { maxTurns: 10, maxCostUsd: null, timeoutMs: null, systemPrompt: "" },
      mcpPath: "", permissionsPath: "", runPath: "",
    };
    const fetchImpl = fakeFetch([
      [
        "/api/config",
        (_url, init) => {
          if (init.method === "PUT") {
            const body = JSON.parse(init.body);
            stored = { ...stored, ...body };
            return jsonResponse(stored);
          }
          return jsonResponse(stored);
        },
      ],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "getSettings" });
    // The merge reads the snapshot the settings event carried, so the test has
    // to wait for that event, not merely for the request to be issued.
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "settings")).toBe(true);
    });

    bridge.api.send({
      cmd: "saveMcpServer",
      server: { name: "kb", command: "node", args: "-y kb.js", timeoutMs: 5000 },
    });
    // Wait for the reply, not the request: the snapshot the next merge reads
    // only arrives with the response.
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "settings")).toHaveLength(2);
    });
    const put = fetchImpl.calls.find((call) => call.method === "PUT");
    const sent = JSON.parse(put.body);
    // The existing server survives; the new one is appended with args split.
    expect(sent.mcpServers).toStrictEqual([
      { name: "probe", command: "node" },
      { name: "kb", command: "node", args: ["-y", "kb.js"], timeoutMs: 5000, disabled: false },
    ]);

    bridge.api.send({ cmd: "removeMcpServer", name: "probe" });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "settings")).toHaveLength(3);
    });
    // Removing by name leaves the other server exactly as it was.
    expect(JSON.parse(fetchImpl.calls.filter((call) => call.method === "PUT")[1].body).mcpServers)
      .toStrictEqual([{ name: "kb", command: "node", args: ["-y", "kb.js"], timeoutMs: 5000, disabled: false }]);
  });

  it("sessionFlags/deleteSession/forkSession 打到对应的会话端点", async () => {
    const fetchImpl = fakeFetch([
      ["/fork", () => jsonResponse({ sessionId: "forked-1" }, 201)],
      ["/api/sessions/s1", () => jsonResponse({ id: "s1" })],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();

    bridge.api.send({ cmd: "sessionFlags", id: "s1", title: "串口无输出", pinned: true });
    await vi.waitFor(() => {
      expect(fetchImpl.calls.some((call) => call.method === "PATCH")).toBe(true);
    });
    const patch = fetchImpl.calls.find((call) => call.method === "PATCH");
    expect(patch.url).toBe("/api/sessions/s1");
    expect(JSON.parse(patch.body)).toStrictEqual({ title: "串口无输出", pinned: true });

    bridge.api.send({ cmd: "deleteSession", id: "s2" });
    await vi.waitFor(() => {
      expect(fetchImpl.calls.some((call) => call.method === "DELETE")).toBe(true);
    });
    expect(fetchImpl.calls.find((call) => call.method === "DELETE").url).toBe("/api/sessions/s2");

    bridge.api.send({ cmd: "forkSession", id: "s1" });
    await vi.waitFor(() => {
      expect(fetchImpl.calls.some((call) => call.url.endsWith("/fork"))).toBe(true);
    });
    expect(fetchImpl.calls.find((call) => call.url.endsWith("/fork")).method).toBe("POST");
  });
});

describe("bridge: 文件与产物", () => {
  function fileBridge(routes) {
    const fetchImpl = fakeFetch([...routes, ["/api/sessions", () => jsonResponse({ sessions: [] })]]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    return { bridge, events, fetchImpl };
  }

  it("getFile 命中 /api/file 且路径完整编码", async () => {
    const { bridge, events, fetchImpl } = fileBridge([
      [
        "/api/file",
        () =>
          jsonResponse({
            path: "E:\\work\\src\\main.c",
            content: "int main() {}",
            truncated: false,
            binary: false,
          }),
      ],
    ]);
    bridge.api.send({ cmd: "getFile", path: "E:\\work\\src\\main.c" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "file")).toBe(true);
    });

    const call = fetchImpl.calls.find((entry) => entry.url.startsWith("/api/file"));
    // `:` and `\` inside a query value break a hand-built URL; the whole path
    // is one percent-encoded parameter.
    expect(call.url).toBe(`/api/file?path=${encodeURIComponent("E:\\work\\src\\main.c")}`);
    expect(call.url).toContain("%3A");
    expect(call.url).toContain("%5C");

    const file = events.find((event) => event.type === "file").file;
    // The renderer matches `file.path` against `state.selectedFile` (the path
    // it was given) and drops a preview whose path differs, so the requested
    // path stays and the resolved one travels beside it.
    expect(file.path).toBe("E:\\work\\src\\main.c");
    expect(file.content).toBe("int main() {}");
    expect(file.truncated).toBe(false);
    expect(file.binary).toBe(false);
  });

  it("getFile 失败回显式 warn，不发 file 事件", async () => {
    const { bridge, events } = fileBridge([
      ["/api/file", () => jsonResponse({ error: { code: "invalid_path", message: "只能查看会话目录内的文件" } }, 400)],
    ]);
    bridge.api.send({ cmd: "getFile", path: "/etc/passwd" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "notice")).toBe(true);
    });
    const notice = events.find((event) => event.type === "notice");
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("文件读取失败");
    expect(notice.text).toContain("只能查看会话目录内的文件");
    expect(events.some((event) => event.type === "file")).toBe(false);
  });

  it("getArtifacts 无会话时回空数组，有会话时透传列表", async () => {
    const artifacts = [{ path: "E:/s/artifacts/a.txt", name: "a.txt", kind: "text", size: 12 }];
    const { bridge, events, fetchImpl } = fileBridge([
      ["/artifacts", () => jsonResponse({ artifacts })],
      [
        "/api/sessions/s1",
        () => jsonResponse({ header: { id: "s1", workdir: "E:/p" }, events: [] }),
      ],
    ]);

    bridge.api.send({ cmd: "getArtifacts" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "artifacts")).toBe(true);
    });
    // With no session open there is nothing to ask the server about; an empty
    // list is the honest answer, not a request for another session's files.
    expect(fetchImpl.calls.some((call) => call.url.includes("/artifacts"))).toBe(false);
    expect(events.find((event) => event.type === "artifacts").artifacts).toStrictEqual([]);

    bridge.api.send({ cmd: "loadSession", id: "s1" });
    await vi.waitFor(() => {
      expect(bridge._internal.getSessionId()).toBe("s1");
    });
    bridge.api.send({ cmd: "getArtifacts" });
    await vi.waitFor(() => {
      expect(fetchImpl.calls.some((call) => call.url === "/api/sessions/s1/artifacts")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "artifacts").length).toBe(2);
    });
    expect(events.filter((event) => event.type === "artifacts").at(-1).artifacts).toStrictEqual(artifacts);
  });

  it("getArtifact 把文件内容包成 artifact 事件，二进制只回提示", async () => {
    const { bridge, events } = fileBridge([
      [
        "/api/file",
        (url) =>
          url.includes("bin")
            ? jsonResponse({ path: "E:/s/bin.dat", content: "", truncated: false, binary: true })
            : jsonResponse({ path: "E:/s/out.txt", content: "行 1", truncated: true, binary: false }),
      ],
    ]);

    bridge.api.send({ cmd: "getArtifact", path: "E:/s/out.txt" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "artifact")).toBe(true);
    });
    expect(events.find((event) => event.type === "artifact").artifact).toStrictEqual({
      path: "E:/s/out.txt",
      kind: "text",
      content: "行 1",
      truncated: true,
    });

    bridge.api.send({ cmd: "getArtifact", path: "E:/s/bin.out" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "notice" && event.text.includes("二进制"))).toBe(true);
    });
    // Passing empty content to `renderArtifact` would draw an empty pane and
    // claim the file was read; the notice says why there is nothing to draw.
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
  });

  it("setEffort 回 warn 且不发 state", () => {
    const { bridge, events } = fileBridge([]);
    bridge.api.send({ cmd: "setEffort", effort: "high" });
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice).toStrictEqual({ type: "notice", level: "warn", text: "内核不支持调整推理强度" });
    // A `state` with an effort the kernel never received would make the menu
    // show a level that is not in effect.
    expect(events.some((event) => event.type === "state" && event.effort === "high")).toBe(false);
  });

  it("saveSettings 只接受 locale，其他字段回 warn", () => {
    const storage = storageStub();
    const bridge = createBrowserBridge({
      fetchImpl: fakeFetch([]),
      EventSourceImpl: FakeEventSource,
      storage,
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();

    bridge.api.send({ cmd: "saveSettings", settings: { locale: "en" }, skipCatalog: true });
    expect(storage.getItem("prometheus.locale")).toBe("en");
    expect(events.at(-1)).toStrictEqual({ type: "locale", locale: "en" });

    const before = events.length;
    bridge.api.send({ cmd: "saveSettings", settings: { provider: "gw", model: "flash" } });
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ type: "notice", level: "warn" });
    expect(events.at(-1).text).toContain("该设置没有后端");
    expect(events.at(-1).text).toContain("provider");
    expect(events.at(-1).text).toContain("model");
  });
});

describe("bridge: 会话筛选", () => {
  const rows = [
    { id: "s1", workdir: "E:/p", createdAt: "2026-10-20T00:00:00.000Z", archived: false },
    { id: "s2", workdir: "E:/p", createdAt: "2026-10-20T00:00:00.000Z", archived: true },
    { id: "s3", workdir: "E:\\q", createdAt: "2026-10-20T00:00:00.000Z", archived: false },
  ];

  function listBridge() {
    const fetchImpl = fakeFetch([
      ["/api/sessions/s", () => jsonResponse({ header: {}, events: [] })],
      ["/api/sessions", () => jsonResponse({ sessions: rows })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    return { bridge, events, fetchImpl };
  }

  it("includeArchived:false 过滤归档行，total 是过滤后的总数", async () => {
    const { bridge, events } = listBridge();
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(1);
    });
    // The renderer boots with its archive toggle off, and an absent option is
    // "not included": the archived row is already gone from the first list.
    const boot = events.filter((event) => event.type === "sessions").at(-1);
    expect(boot.sessions.map((session) => session.id)).toStrictEqual(["s1", "s3"]);
    expect(boot.total).toBe(2);

    bridge.api.send({ cmd: "listSessions", includeArchived: false });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(2);
    });
    const list = events.filter((event) => event.type === "sessions").at(-1);
    expect(list.sessions.map((session) => session.id)).toStrictEqual(["s1", "s3"]);
    // The server's total would offer "load more" for a row the filter removed.
    expect(list.total).toBe(2);
    expect(list.all).toBe(2);

    bridge.api.send({ cmd: "listSessions", includeArchived: true });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(3);
    });
    expect(events.filter((event) => event.type === "sessions").at(-1).sessions.map((s) => s.id))
      .toStrictEqual(["s1", "s2", "s3"]);
  });

  it("cwd 按归一化路径过滤（分隔符与大小写不敏感）", async () => {
    const { bridge, events } = listBridge();
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(1);
    });

    bridge.api.send({ cmd: "listSessions", includeArchived: true, cwd: "e:\\p\\" });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(2);
    });
    const list = events.filter((event) => event.type === "sessions").at(-1);
    expect(list.sessions.map((session) => session.id)).toStrictEqual(["s1", "s2"]);
    expect(list.total).toBe(2);
  });

  it("status 筛选不被支持，发 dim 提示且只发一次", async () => {
    const { bridge, events } = listBridge();
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(1);
    });

    bridge.api.send({ cmd: "listSessions", includeArchived: false, status: "error" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "notice" && event.text.includes("按状态筛选"))).toBe(true);
    });
    const notice = events.find((event) => event.type === "notice" && event.text.includes("按状态筛选"));
    expect(notice.level).toBe("dim");
    // The HTTP list has no run state, so the status filter is a no-op: the
    // rows still come back and the notice says why nothing was filtered.
    const list = events.filter((event) => event.type === "sessions").at(-1);
    expect(list.sessions.map((session) => session.id)).toStrictEqual(["s1", "s3"]);

    bridge.api.send({ cmd: "listSessions", includeArchived: false, status: "error" });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(3);
    });
    // Re-selecting the same filter is not news; one notice per selection.
    expect(events.filter((event) => event.type === "notice" && event.text.includes("按状态筛选")))
      .toHaveLength(1);
  });

  it("后台刷新沿用最近一次的筛选，不把归档行放回来", async () => {
    const fetchImpl = fakeFetch([
      ["/api/actions", () => jsonResponse({ sessionId: "s1", created: false }, 202)],
      ["/api/sessions/s", () => jsonResponse({ header: {}, events: [] })],
      ["/api/sessions", () => jsonResponse({ sessions: rows })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(1);
    });

    bridge.api.send({ cmd: "loadSession", id: "s1" });
    await vi.waitFor(() => {
      expect(bridge._internal.getSessionId()).toBe("s1");
    });
    bridge.api.send({ cmd: "listSessions", includeArchived: false });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(2);
    });

    // `startPrompt` refreshes the list without options; it must not undo the
    // toggle the operator just set.
    bridge.api.send({ cmd: "prompt", text: "hi" });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "sessions").length).toBe(3);
    });
    expect(events.filter((event) => event.type === "sessions").at(-1).sessions.map((s) => s.id))
      .toStrictEqual(["s1", "s3"]);
  });
});

describe("bridge: 导出", () => {
  it("exportSession 从日志渲染 Markdown 并发 export_ready", async () => {
    const fetchImpl = fakeFetch([
      [
        "/api/sessions/s1",
        () =>
          jsonResponse({
            header: { id: "s1", workdir: "E:/p" },
            events: [
              { seq: 0, ts: "t", type: "user", payload: { content: "串口没输出" } },
              { seq: 1, ts: "t", type: "assistant", payload: { content: "先查 KB", toolCalls: [] } },
            ],
          }),
      ],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "loadSession", id: "s1" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session_loaded")).toBe(true);
    });

    bridge.api.send({ cmd: "exportSession" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "export_ready")).toBe(true);
    });
    const ready = events.find((event) => event.type === "export_ready");
    // The title comes from the first user message when the session has none.
    expect(ready.markdown).toContain("# 串口没输出");
    expect(ready.markdown).toContain("## Assistant");
    expect(ready.filename).toBe("串口没输出.md");
  });

  it("没有打开会话时导出回 warn 而不是空文件", () => {
    const bridge = createBrowserBridge({
      fetchImpl: fakeFetch([]),
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "exportSession" });
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("没有可导出");
  });
});

describe("bridge: 目录选择", () => {
  function pickerBridge() {
    const fetchImpl = fakeFetch([["/api/sessions", () => jsonResponse({ sessions: [] })]]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    return { bridge, events };
  }

  it("浏览器没有目录选择器时返回 null 并发出 warn 说明替代方式", async () => {
    // Node has no `showDirectoryPicker`; the bridge must not answer with a
    // silent `null` — the click would look like it did nothing (R3).
    const { bridge, events } = pickerBridge();
    const picked = await bridge.api.pickDirectory();
    expect(picked).toBeNull();
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice).toMatchObject({ type: "notice", level: "warn" });
    expect(notice.text).toContain("无法打开");
    expect(notice.text).toContain("绝对路径");
    expect(notice.text).toContain("输入路径");
  });

  it("即使 showDirectoryPicker 可用也只发 warn，绝不用 handle.name 冒充路径", async () => {
    const showDirectoryPicker = vi.fn(async () => ({ name: "work", kind: "directory" }));
    vi.stubGlobal("showDirectoryPicker", showDirectoryPicker);
    const { bridge, events } = pickerBridge();

    const picked = await bridge.api.pickDirectory();
    // `handle.name` is a bare folder name, not an absolute path: handing it to
    // `getFile` would send the server a path it cannot resolve.
    expect(picked).toBeNull();
    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice).toMatchObject({ type: "notice", level: "warn" });
    expect(notice.text).toContain("绝对路径");
    expect(notice.text).toContain("输入路径");
  });

  it("用户在选择器里取消时也给出 warn，而不是静默 null", async () => {
    // A cancel throws `AbortError` in Chromium; that is still a click that must
    // not look like a server failure or a silent no-op.
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn(async () => {
        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      }),
    );
    const { bridge, events } = pickerBridge();
    const picked = await bridge.api.pickDirectory();
    expect(picked).toBeNull();
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice).toMatchObject({ type: "notice", level: "warn" });
    expect(notice.text).toContain("绝对路径");
  });
});

describe("bridge: 文件树与工作区", () => {
  function treeBridge(routes) {
    const fetchImpl = fakeFetch([...routes, ["/api/sessions", () => jsonResponse({ sessions: [] })]]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    return { bridge, events, fetchImpl };
  }

  it("getTree 请求 /api/tree 并把 entries 原样交给 tree 事件", async () => {
    const entries = [
      { name: "src", path: "E:/p/src", type: "dir" },
      { name: "main.c", path: "E:/p/main.c", type: "file" },
    ];
    const { bridge, events, fetchImpl } = treeBridge([
      ["/api/tree", () => jsonResponse({ path: "E:/p", entries, truncated: false })],
    ]);
    // Boot already emitted one empty tree; wait for the reply, not for "a
    // tree event exists" — the latter is true before the request even lands.
    bridge.api.send({ cmd: "getTree", path: "E:/p" });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "tree").at(-1).nodes).toStrictEqual(entries);
    });

    const call = fetchImpl.calls.find((entry) => entry.url.startsWith("/api/tree"));
    expect(call.method).toBe("GET");
    // `:` and `\` inside a hand-built query split the URL at the first one.
    expect(call.url).toBe(`/api/tree?path=${encodeURIComponent("E:/p")}`);
    const tree = events.filter((event) => event.type === "tree").at(-1);
    expect(tree.nodes).toStrictEqual(entries);
    expect(tree.truncated).toBe(false);
  });

  it("getTree 失败时同时发 warn 与空树，不让展开的节点一直等", async () => {
    const { bridge, events } = treeBridge([
      ["/api/tree", () => jsonResponse({ error: { code: "invalid_path", message: "只能查看工作区内的文件" } }, 400)],
    ]);
    bridge.api.send({ cmd: "getTree", path: "C:/Windows" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "notice")).toBe(true);
    });

    const notice = events.find((event) => event.type === "notice");
    expect(notice).toMatchObject({ type: "notice", level: "warn" });
    expect(notice.text).toContain("文件树读取失败");
    expect(notice.text).toContain("只能查看工作区内的文件");
    // The renderer parks `pendingTreeTarget` until a `tree` event arrives; an
    // empty tree is the release signal. R3 applies to the notice, not to an
    // empty tree on its own: both have to be there, and the notice must come
    // first so the reason is on screen when the branch collapses.
    const lastTree = events.filter((event) => event.type === "tree").at(-1);
    expect(lastTree.nodes).toStrictEqual([]);
    expect(events.indexOf(notice)).toBeLessThan(events.lastIndexOf(lastTree));
  });

  it("getTree 网络异常时同样 warn + 空树", async () => {
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "getTree", path: "E:/p" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "tree")).toBe(true);
    });
    // The boot session list fails too in this fake, so the assertion names the
    // tree's own notice: any warn would pass for the wrong reason.
    const notice = events.find(
      (event) => event.type === "notice" && event.text.includes("文件树读取失败"),
    );
    expect(notice).toBeDefined();
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("network down");
    expect(events.filter((event) => event.type === "tree").at(-1).nodes).toStrictEqual([]);
  });

  it("setWorkspace 先 POST /api/workspace，成功后刷新 state 并取树", async () => {
    const { bridge, events, fetchImpl } = treeBridge([
      ["/api/workspace", () => jsonResponse({ path: "E:/p" })],
      ["/api/tree", () => jsonResponse({ path: "E:/p", entries: [], truncated: false })],
    ]);
    bridge.api.send({ cmd: "setWorkspace", path: "E:/p" });
    // The topbar is refreshed only after the server accepted the folder; boot
    // already emitted a state with an empty cwd, so the wait is on the value.
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "state").at(-1).cwd).toBe("E:/p");
    });

    const post = fetchImpl.calls.find((call) => call.url === "/api/workspace");
    expect(post.method).toBe("POST");
    expect(JSON.parse(post.body)).toStrictEqual({ path: "E:/p" });
    // The workspace has to be registered before the tree is readable: the
    // server refuses paths outside a known workspace.
    const postIndex = fetchImpl.calls.indexOf(post);
    const treeIndex = fetchImpl.calls.findIndex((call) => call.url.startsWith("/api/tree"));
    expect(treeIndex).toBeGreaterThan(postIndex);
  });

  it("setWorkspace 失败时只发 warn，不发成功态也不去取树", async () => {
    const { bridge, events, fetchImpl } = treeBridge([
      [
        "/api/workspace",
        () => jsonResponse({ error: { code: "invalid_path", message: "目录不存在" } }, 400),
      ],
    ]);
    bridge.api.send({ cmd: "setWorkspace", path: "E:/nope" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "notice")).toBe(true);
    });

    const notice = events.find((event) => event.type === "notice");
    expect(notice).toMatchObject({ type: "notice", level: "warn" });
    expect(notice.text).toContain("工作区切换失败");
    expect(notice.text).toContain("目录不存在");
    // Boot already emitted one state; a rejected switch must not add another,
    // and the topbar must not move to a folder the server refused.
    expect(events.filter((event) => event.type === "state" && event.cwd === "E:/nope")).toHaveLength(0);
    expect(fetchImpl.calls.some((call) => call.url.startsWith("/api/tree"))).toBe(false);
  });

  it("设置工作区后 prompt 带上新 cwd", async () => {
    const { bridge, fetchImpl } = treeBridge([
      ["/api/workspace", () => jsonResponse({ path: "E:/p" })],
      ["/api/tree", () => jsonResponse({ path: "E:/p", entries: [], truncated: false })],
      ["/api/actions", () => jsonResponse({ sessionId: "sess-1", created: true }, 202)],
    ]);
    bridge.api.send({ cmd: "setWorkspace", path: "E:/p" });
    await vi.waitFor(() => {
      expect(fetchImpl.calls.some((call) => call.url === "/api/workspace")).toBe(true);
    });
    // The tree request is issued only after the server accepted the workspace,
    // so waiting on it means the bridge has adopted the new cwd.
    await vi.waitFor(() => {
      expect(fetchImpl.calls.some((call) => call.url.startsWith("/api/tree"))).toBe(true);
    });

    bridge.api.send({ cmd: "prompt", text: "看下目录" });
    await vi.waitFor(() => {
      expect(fetchImpl.calls.some((call) => call.url === "/api/actions")).toBe(true);
    });
    const posted = fetchImpl.calls.find((call) => call.url === "/api/actions");
    expect(JSON.parse(posted.body)).toMatchObject({ text: "看下目录", cwd: "E:/p" });
  });
});

describe("bridge: providers 保存", () => {
  it("saveProviders → PUT /api/config，body 为 { providers }", async () => {
    const providers = {
      gw: { baseUrl: "https://gw.example/v1", apiKeyEnv: "GW_KEY", models: { flash: {} } },
    };
    const fetchImpl = fakeFetch([
      [
        "/api/config",
        (_url, init) => {
          if (init.method === "PUT") {
            return jsonResponse({ ...JSON.parse(init.body), mcpPath: "", permissionsPath: "", runPath: "" });
          }
          return jsonResponse({});
        },
      ],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "saveProviders", providers });
    await vi.waitFor(() => {
      expect(fetchImpl.calls.some((call) => call.method === "PUT")).toBe(true);
    });

    const put = fetchImpl.calls.find((call) => call.method === "PUT");
    expect(put.url).toBe("/api/config");
    expect(JSON.parse(put.body)).toStrictEqual({ providers });
    // A successful save emits the refreshed settings, same as the other
    // config writers: the settings page has one reply shape.
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "settings")).toBe(true);
    });
  });

  it("saveProviders 失败时回 warn，不伪造 settings", async () => {
    const fetchImpl = fakeFetch([
      [
        "/api/config",
        (_url, init) =>
          init.method === "PUT"
            ? jsonResponse({ error: { code: "config_unwritable", message: "配置写入失败" } }, 500)
            : jsonResponse({}),
      ],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "saveProviders", providers: {} });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "notice")).toBe(true);
    });
    const notice = events.find((event) => event.type === "notice");
    expect(notice).toMatchObject({ type: "notice", level: "warn" });
    expect(notice.text).toContain("配置未保存");
    expect(events.some((event) => event.type === "settings")).toBe(false);
  });
});

describe("bridge: 测试连接（testProvider）", () => {
  function probeBridge(handler) {
    const fetchImpl = fakeFetch([
      ["/api/providers/test", handler],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    return { bridge, events, fetchImpl };
  }

  it("POST /api/providers/test，成功回包转成带模型列表的 provider_test", async () => {
    const { bridge, events, fetchImpl } = probeBridge(() =>
      jsonResponse({
        ok: true,
        baseUrl: "https://gw.example/v1",
        models: ["flash", "pro"],
        latencyMs: 42,
      }),
    );
    bridge.api.send({
      cmd: "testProvider",
      baseUrl: "https://gw.example/v1",
      apiKeyEnv: "GW_KEY",
      model: "flash",
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "provider_test")).toBe(true);
    });

    const call = fetchImpl.calls.find((entry) => entry.url === "/api/providers/test");
    expect(call.method).toBe("POST");
    // Only the fields the operator filled in travel: an empty `apiKeyEnv` would
    // ask the server to read a variable with no name.
    expect(JSON.parse(call.body)).toStrictEqual({
      baseUrl: "https://gw.example/v1",
      apiKeyEnv: "GW_KEY",
      model: "flash",
    });
    expect(events.find((event) => event.type === "provider_test")).toStrictEqual({
      type: "provider_test",
      ok: true,
      baseUrl: "https://gw.example/v1",
      models: ["flash", "pro"],
      latencyMs: 42,
    });
  });

  it("可选字段为空时不发，回包缺 baseUrl 时补上请求里的值", async () => {
    const { bridge, events, fetchImpl } = probeBridge(() =>
      jsonResponse({ ok: true, models: ["flash"] }),
    );
    bridge.api.send({ cmd: "testProvider", baseUrl: "https://gw.example/v1", apiKeyEnv: "  ", model: "" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "provider_test")).toBe(true);
    });

    expect(JSON.parse(fetchImpl.calls.find((entry) => entry.url === "/api/providers/test").body))
      .toStrictEqual({ baseUrl: "https://gw.example/v1" });
    const event = events.find((entry) => entry.type === "provider_test");
    // The settings page keys its card on the address it sent; a reply without
    // one, or with a normalized spelling of it, would drop the card's state.
    expect(event.baseUrl).toBe("https://gw.example/v1");
    expect(event.ok).toBe(true);
    // No latency in the reply means no latency in the event — not `0`.
    expect(event.latencyMs).toBeUndefined();
  });

  it("服务端回 ok:false 时转成失败事件，带上原因与错误码", async () => {
    const { bridge, events } = probeBridge(() =>
      jsonResponse({
        ok: false,
        baseUrl: "https://gw.example/v1",
        error: "401 未授权：API key 无效",
        code: "unauthorized",
      }),
    );
    bridge.api.send({ cmd: "testProvider", baseUrl: "https://gw.example/v1" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "provider_test")).toBe(true);
    });
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event).toStrictEqual({
      type: "provider_test",
      ok: false,
      baseUrl: "https://gw.example/v1",
      error: "401 未授权：API key 无效",
      code: "unauthorized",
    });
    // 缺省 ≠ 空：a failed probe listed no models, it did not list zero.
    expect(event.models).toBeUndefined();
  });

  it("回包没有明确的 ok:true 时不当成连接成功（R3）", async () => {
    // A 200 with a body that never said `ok` is not a probe result; echoing it
    // as "connected" would put a green card on an untested gateway.
    const { bridge, events } = probeBridge(() => jsonResponse({ models: ["flash"] }));
    bridge.api.send({ cmd: "testProvider", baseUrl: "https://gw.example/v1" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "provider_test")).toBe(true);
    });
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event.ok).toBe(false);
    expect(typeof event.error).toBe("string");
    expect(event.error.trim()).not.toBe("");
  });

  it("HTTP 500 时回 ok:false 并带上服务端的原因，而不是静默", async () => {
    const { bridge, events } = probeBridge(() =>
      jsonResponse({ error: { code: "internal", message: "内核探测失败" } }, 500),
    );
    bridge.api.send({ cmd: "testProvider", baseUrl: "https://gw.example/v1" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "provider_test")).toBe(true);
    });
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event).toMatchObject({ type: "provider_test", ok: false, baseUrl: "https://gw.example/v1" });
    expect(event.error).toContain("内核探测失败");
  });

  it("HTTP 400 的平铺 message 也读得出来，不退化成只有状态码", async () => {
    // The probe's own rejection may use a flat `{ message }`; reporting
    // "HTTP 400" for an address the user could fix loses the one sentence
    // that says what to fix.
    const { bridge, events } = probeBridge(() =>
      jsonResponse({ message: "baseUrl 必须是 http 或 https 地址" }, 400),
    );
    bridge.api.send({ cmd: "testProvider", baseUrl: "ftp://gw.example/v1" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "provider_test")).toBe(true);
    });
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event.ok).toBe(false);
    expect(event.error).toContain("baseUrl 必须是 http 或 https 地址");
    expect(event.error).not.toContain("HTTP 400");
  });

  it("网络异常时回 ok:false，不抛也不静默", async () => {
    const { bridge, events } = probeBridge(() => {
      throw new Error("socket hang up");
    });
    bridge.api.send({ cmd: "testProvider", baseUrl: "https://gw.example/v1" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "provider_test")).toBe(true);
    });
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event).toMatchObject({ type: "provider_test", ok: false, baseUrl: "https://gw.example/v1" });
    expect(event.error).toContain("socket hang up");
  });

  it("baseUrl 为空时不发请求，直接回失败事件", async () => {
    const { bridge, events, fetchImpl } = probeBridge(() => jsonResponse({ ok: true }));
    bridge.api.send({ cmd: "testProvider", baseUrl: "   " });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "provider_test")).toBe(true);
    });
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event).toMatchObject({ type: "provider_test", ok: false, baseUrl: "" });
    expect(event.error.trim()).not.toBe("");
    expect(fetchImpl.calls.some((entry) => entry.url === "/api/providers/test")).toBe(false);
  });
});

describe("bridge: 模型配置页可达", () => {
  it("getSettings 带上 providerConfig，设置页才画得出表单", async () => {
    const providers = {
      gw: {
        protocol: "openai-chat-completions",
        baseUrl: "https://gw.example/v1",
        models: { flash: { contextWindow: 128000, maxOutput: 4096 } },
      },
    };
    const config = {
      mcpServers: [],
      permissions: { preset: "diagnose", approvalTimeoutMs: 120000, rules: [] },
      run: { maxTurns: 10, maxCostUsd: null, timeoutMs: null, systemPrompt: "" },
      mcpPath: "E:/home/mcp.json",
      permissionsPath: "E:/home/permissions.json",
      runPath: "E:/home/run.json",
      providers,
      providersPath: "E:/home/providers.json",
    };
    const fetchImpl = fakeFetch([
      ["/api/config", () => jsonResponse(config)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "getSettings" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "settings")).toBe(true);
    });

    const settings = events.filter((event) => event.type === "settings").at(-1).settings;
    // Without this the settings page shows "this host does not report an
    // editable provider configuration" and renders no form at all.
    expect(settings.providerConfig).toStrictEqual(providers);
    expect(settings.providers).toStrictEqual([{ id: "gw", baseUrl: "https://gw.example/v1" }]);
    expect(settings.models.map((model) => model.id)).toStrictEqual(["gw/flash"]);
    expect(settings.configPaths.providers).toBe("E:/home/providers.json");
  });

  it("providers 读失败时带 providersError，页面仍能打开去修它", async () => {
    const config = {
      mcpServers: [],
      permissions: { preset: "diagnose", approvalTimeoutMs: 120000, rules: [] },
      run: { maxTurns: 10, maxCostUsd: null, timeoutMs: null, systemPrompt: "" },
      mcpPath: "", permissionsPath: "", runPath: "",
      providers: {},
      providersPath: "E:/home/providers.json",
      providersError: "providers 配置校验失败: gw.baseUrl: Invalid url",
    };
    const fetchImpl = fakeFetch([
      ["/api/config", () => jsonResponse(config)],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "getSettings" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "settings")).toBe(true);
    });
    const settings = events.filter((event) => event.type === "settings").at(-1).settings;
    // The reason travels with the (empty) form, so the page can say why it is
    // empty instead of presenting a blank file as the user's configuration.
    expect(settings.providersError).toContain("baseUrl");
    expect(settings.providerConfig).toStrictEqual({});
  });

  it("读过配置后广播真实模型列表，选单不再停在加载中", async () => {
    const providers = {
      gw: {
        protocol: "openai-chat-completions",
        baseUrl: "https://gw.example/v1",
        models: { flash: { contextWindow: 128000, maxOutput: 4096 } },
      },
    };
    const fetchImpl = fakeFetch([
      ["/api/config", () => jsonResponse({ providers, providersPath: "E:/home/providers.json" })],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    bridge.api.send({ cmd: "getSettings" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "models")).toBe(true);
    });
    // The picker listens for `models`, not `settings`. Without this event the
    // chip stayed on "loading models…" even though `providers.json` named a
    // model the next run would use.
    const models = events.filter((event) => event.type === "models").at(-1);
    expect(models.models.map((model) => model.id)).toStrictEqual(["gw/flash"]);
    // The kernel falls back to the file's first reference when none is
    // configured, so the chip must name the same one the run will use.
    expect(models.model).toBe("gw/flash");
  });

  it("saveProviders 成功后选单与表单都跟上文件内容", async () => {
    let stored = {
      mcpServers: [],
      permissions: { preset: "diagnose", approvalTimeoutMs: 120000, rules: [] },
      run: { maxTurns: 10, maxCostUsd: null, timeoutMs: null, systemPrompt: "" },
      mcpPath: "", permissionsPath: "", runPath: "",
      providers: {},
      providersPath: "E:/home/providers.json",
    };
    const fetchImpl = fakeFetch([
      [
        "/api/config",
        (_url, init) => {
          if (init.method === "PUT") {
            const body = JSON.parse(init.body);
            stored = { ...stored, providers: body.providers };
            return jsonResponse(stored);
          }
          return jsonResponse(stored);
        },
      ],
      ["/api/sessions", () => jsonResponse({ sessions: [] })],
    ]);
    const bridge = createBrowserBridge({
      fetchImpl,
      EventSourceImpl: FakeEventSource,
      storage: storageStub(),
    });
    const events = [];
    bridge.api.onEvent((event) => events.push(event));
    bridge.boot();
    const providers = {
      gw: {
        protocol: "openai-chat-completions",
        baseUrl: "https://gw.example/v1",
        models: { flash: { contextWindow: 128000, maxOutput: 4096 } },
      },
    };
    bridge.api.send({ cmd: "saveProviders", providers });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "settings").length).toBeGreaterThan(0);
    });
    const settings = events.filter((event) => event.type === "settings").at(-1).settings;
    expect(settings.providerConfig).toStrictEqual(providers);
    expect(settings.models.map((model) => model.id)).toStrictEqual(["gw/flash"]);
    // The picker has to learn the new model too, not only the settings form.
    await vi.waitFor(() => {
      const state = events.filter((event) => event.type === "state").at(-1);
      expect(state?.models?.map((model) => model.id)).toStrictEqual(["gw/flash"]);
    });
  });
});
