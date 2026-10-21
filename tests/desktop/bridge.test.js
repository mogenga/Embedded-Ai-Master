import { beforeEach, describe, expect, it, vi } from "vitest";
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
