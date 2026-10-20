/**
 * Browser bridge: `window.prometheus` over the kernel's HTTP/SSE server.
 *
 * The renderer was written against an Electron preload that speaks NDJSON to
 * a host process. Served from `npm run serve:ui` there is no preload, so this
 * module installs the same small surface — `send`, `onEvent`, and the handful
 * of optional members the renderer guards — on top of the API the server
 * already exposes:
 *
 *   prompt          POST /api/actions
 *   permission      POST /api/approvals
 *   abort           POST /api/abort
 *   listSessions    GET  /api/sessions
 *   loadSession     GET  /api/sessions/:id
 *   live events     GET  /api/events (SSE)
 *
 * Everything else answers with a `notice` naming the command. A silent no-op
 * would leave the operator believing an action happened; R3 applies to the
 * bridge as much as to a tool.
 *
 * The protocol translation lives in ./protocol.js, shared with the desktop
 * host so both forms produce the same renderer events for the same log.
 */

import {
  createContext,
  initialState,
  sessionEventToHostEvents,
  sessionEventsToMessages,
  sessionLoadedEvent,
  sessionsEvent,
} from "./protocol.js";

const DEFAULT_TITLE_LIMIT = 80;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function titleOf(events) {
  for (const event of events) {
    if (!isRecord(event) || event.type !== "user") continue;
    const content = textOf(isRecord(event.payload) ? event.payload.content : undefined).trim();
    if (content !== "") return content.length > DEFAULT_TITLE_LIMIT ? `${content.slice(0, DEFAULT_TITLE_LIMIT)}…` : content;
  }
  return "";
}

async function readError(response) {
  try {
    const body = await response.json();
    const detail = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const message = textOf(detail?.message);
    if (message !== "") return message;
    const code = textOf(detail?.code);
    if (code !== "") return code;
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `HTTP ${response.status}`;
}

/**
 * Create the bridge. Exported so tests can drive it with a fake fetch and a
 * fake EventSource instead of starting a server.
 */
export function createBrowserBridge(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const EventSourceCtor = options.EventSourceImpl ?? globalThis.EventSource;
  const storage = options.storage ?? globalThis.localStorage;
  const notify = typeof options.notify === "function" ? options.notify : undefined;
  const handlers = new Set();
  /** Events produced before the renderer subscribed (hello/ready/state). */
  const pending = [];
  let ready = false;
  let stream;
  let streamSessionId = "";
  let runningSessionId = "";
  let currentSessionId = "";
  let lastSeq = -1;
  let lastModel = "";
  /** The open session's working directory; unknown until a session loads. */
  let currentCwd = "";
  let locale = "zh";
  /** id → title, filled from session headers when the list is built. */
  const titles = new Map();
  let ctx = createContext();

  function emit(message) {
    const list = [...handlers];
    if (list.length === 0) {
      pending.push(message);
      return;
    }
    for (const handler of list) {
      try {
        handler(message);
      } catch {
        // A renderer that throws while drawing one event must not take the
        // stream down with it; the next event still arrives.
      }
    }
  }

  function emitAll(messages) {
    for (const message of messages) emit(message);
  }

  function closeStream() {
    if (stream !== undefined) {
      const current = stream;
      stream = undefined;
      try {
        current.close();
      } catch {
        // Closing an already-closed source is not an error worth surfacing.
      }
    }
  }

  function stateEvent() {
    return initialState({
      sessionId: currentSessionId,
      cwd: currentCwd,
      locale,
      mode: stateMode,
      model: lastModel,
      models: [],
      modelsSource: "providers.json",
    });
  }

  let stateMode = "diagnose";

  function adoptSession(id, events) {
    currentSessionId = id;
    lastSeq = -1;
    for (const event of events) {
      if (isRecord(event) && typeof event.seq === "number" && event.seq > lastSeq) lastSeq = event.seq;
    }
    ctx = createContext({ sessionId: id });
  }

  function openStream(since) {
    if (currentSessionId === "") return;
    closeStream();
    if (typeof EventSourceCtor !== "function") return;
    const id = currentSessionId;
    const url = `/api/events?sessionId=${encodeURIComponent(id)}&since=${since}`;
    let source;
    try {
      source = new EventSourceCtor(url);
    } catch {
      return;
    }
    stream = source;
    streamSessionId = id;
    source.addEventListener("message", (event) => {
      if (stream !== source) return;
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        emit({ type: "notice", level: "warn", text: "事件流返回了无法解析的数据" });
        return;
      }
      if (!isRecord(parsed) || parsed.sessionId !== id) return;
      emitAll(sessionEventToHostEvents(parsed, ctx));
    });
    source.addEventListener("stream_end", () => {
      if (stream !== source) return;
      // The kernel closes the header after every run, which ends the stream.
      // Nothing else will arrive for this run; a new prompt opens a new one.
      closeStream();
      if (ctx.running) {
        ctx.running = false;
        emit({ type: "run_end" });
      }
      void refreshSessions();
    });
    source.addEventListener("stream_error", (event) => {
      if (stream !== source) return;
      let code = "";
      try {
        code = textOf(JSON.parse(event.data).code);
      } catch {
        // The frame is advisory; the notice below still says what happened.
      }
      emit({
        type: "notice",
        level: "warn",
        text: code === "" ? "实时事件流中断" : `实时事件流中断（${code}）`,
      });
      closeStream();
      if (ctx.running) {
        ctx.running = false;
        emit({ type: "run_end" });
      }
    });
  }

  async function refreshSessions() {
    try {
      const response = await fetchImpl("/api/sessions");
      if (!response.ok) {
        emit({ type: "notice", level: "warn", text: `会话列表读取失败：${await readError(response)}` });
        return;
      }
      const body = await response.json();
      const summaries = isRecord(body) && Array.isArray(body.sessions) ? body.sessions : [];
      // The list API has no title; fetch the first user message of a bounded
      // number of sessions, and cache what was already read.
      const missing = summaries
        .map((summary) => textOf(isRecord(summary) ? summary.id : undefined))
        .filter((id) => id !== "" && !titles.has(id))
        .slice(0, 30);
      await Promise.all(
        missing.map(async (id) => {
          try {
            const detail = await fetchImpl(`/api/sessions/${encodeURIComponent(id)}`);
            if (!detail.ok) return;
            const parsed = await detail.json();
            const events = isRecord(parsed) && Array.isArray(parsed.events) ? parsed.events : [];
            titles.set(id, titleOf(events));
          } catch {
            // A session that cannot be read is still listed by its id.
          }
        }),
      );
      // The sidebar expands the group matching `state.cwd`; without a cwd the
      // open conversation's project would start folded. Adopt the open
      // session's workdir as soon as the list reveals it.
      const openSummary = summaries.find(
        (summary) => isRecord(summary) && summary.id === currentSessionId,
      );
      const workdir = textOf(isRecord(openSummary) ? openSummary.workdir : undefined);
      if (workdir !== "" && workdir !== currentCwd) {
        currentCwd = workdir;
        emit(stateEvent());
      }
      const event = sessionsEvent(
        summaries.map((summary) => {
          const record = isRecord(summary) ? summary : {};
          const id = textOf(record.id);
          const title = titles.get(id) ?? "";
          return { ...record, title, summary: title === "" ? id : title };
        }),
      );
      event.sessions = event.sessions.map((session) => ({
        ...session,
        status: session.id === runningSessionId ? "working" : "ready",
      }));
      emit(event);
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `会话列表读取失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function startPrompt(text) {
    if (ctx.running) {
      emit({ type: "notice", level: "warn", text: "当前回合尚未结束，请先停止或等待" });
      return;
    }
    ctx = createContext({ sessionId: currentSessionId });
    ctx.running = true;
    emit({ type: "run_start" });
    let response;
    try {
      response = await fetchImpl("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          ...(currentSessionId === "" ? {} : { sessionId: currentSessionId }),
        }),
      });
    } catch (error) {
      ctx.running = false;
      emit({
        type: "error",
        message: `发送失败：${error instanceof Error ? error.message : String(error)}`,
      });
      emit({ type: "run_end" });
      return;
    }
    if (!response.ok) {
      ctx.running = false;
      emit({ type: "error", message: `发送失败：${await readError(response)}` });
      emit({ type: "run_end" });
      return;
    }
    const body = await response.json().catch(() => ({}));
    const sessionId = textOf(isRecord(body) ? body.sessionId : undefined);
    if (sessionId === "") {
      ctx.running = false;
      emit({ type: "error", message: "发送失败：服务端未返回会话 id" });
      emit({ type: "run_end" });
      return;
    }
    const created = isRecord(body) && body.created === true;
    if (created || currentSessionId !== sessionId) {
      // No `session_loaded` here: the renderer echoed the user's message as
      // soon as they submitted, and replacing the transcript with an empty
      // message list would erase it. A session switch is the only thing that
      // rebuilds the transcript.
      adoptSession(sessionId, []);
      emit(stateEvent());
    }
    // adoptSession replaces the protocol context, so the running flag set
    // before the POST has to be restored — otherwise stream_end would not
    // know a turn was in flight and would never emit run_end.
    ctx.running = true;
    currentSessionId = sessionId;
    runningSessionId = sessionId;
    openStream(-1);
    void refreshSessions();
  }

  async function loadSession(id) {
    if (ctx.running) {
      emit({ type: "notice", level: "warn", text: "当前回合尚未结束，请先停止或等待" });
      return;
    }
    closeStream();
    let response;
    try {
      response = await fetchImpl(`/api/sessions/${encodeURIComponent(id)}`);
    } catch (error) {
      emit({
        type: "error",
        message: `会话打开失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (!response.ok) {
      emit({ type: "error", message: `会话打开失败：${await readError(response)}` });
      return;
    }
    const body = await response.json().catch(() => ({}));
    const events = isRecord(body) && Array.isArray(body.events) ? body.events : [];
    const header = isRecord(body) && isRecord(body.header) ? body.header : {};
    adoptSession(id, events);
    lastModel = textOf(header.model) || lastModel;
    currentCwd = textOf(header.workdir) || currentCwd;
    titles.set(id, titleOf(events));
    emit(sessionLoadedEvent(events, { cwd: textOf(header.workdir), mode: stateMode }));
    emit(stateEvent());
    // Do not open the stream: this session is closed, so the stream would end
    // immediately. The next prompt resumes it and opens a fresh stream.
    streamSessionId = "";
  }

  async function decidePermission(requestId, answer) {
    if (currentSessionId === "") {
      emit({ type: "notice", level: "warn", text: "没有可审批的会话" });
      return;
    }
    const decision = answer === "no" ? "deny" : "allow";
    let response;
    try {
      response = await fetchImpl("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId, requestId, decision }),
      });
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `审批提交失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (!response.ok) {
      emit({
        type: "notice",
        level: "warn",
        text: `审批提交失败：${await readError(response)}`,
      });
      emit({ type: "permission_closed", id: requestId });
      return;
    }
    if (answer === "always") {
      emit({
        type: "notice",
        level: "dim",
        text: "内核只按单次请求审批；“始终允许”本次生效，不会持久化",
      });
    }
  }

  async function abort() {
    if (currentSessionId === "") {
      emit({ type: "notice", level: "dim", text: "没有正在运行的会话" });
      return;
    }
    try {
      await fetchImpl("/api/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId }),
      });
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `中止失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const supportedCommands = new Set([
    "prompt",
    "abort",
    "permission",
    "newSession",
    "listSessions",
    "loadSession",
    "getSettings",
    "setMode",
    "setLocale",
    "setUiPreference",
    "getUsage",
    "getSetupChecklist",
    "listCommands",
    "getTree",
    "searchSessions",
  ]);

  function unsupported(command) {
    emit({
      type: "notice",
      level: "warn",
      text: `浏览器形态暂不支持该命令：${command}`,
    });
  }

  function send(payload) {
    if (!isRecord(payload) || typeof payload.cmd !== "string") return;
    const cmd = payload.cmd;
    if (!supportedCommands.has(cmd)) {
      // The file mention popup asks for matches on every keystroke; a warning
      // per character would bury the transcript. Answer the query instead.
      if (cmd === "searchFiles") {
        emit({ type: "file_matches", query: textOf(payload.query), files: [] });
        return;
      }
      unsupported(cmd);
      return;
    }
    switch (cmd) {
      case "prompt":
        void startPrompt(textOf(payload.text));
        return;
      case "abort":
        void abort();
        return;
      case "permission":
        void decidePermission(textOf(payload.id), textOf(payload.answer));
        return;
      case "newSession":
        closeStream();
        currentSessionId = "";
        runningSessionId = "";
        adoptSession("", []);
        emit({ type: "session_loaded", messages: [], cwd: "", mode: stateMode, effort: "auto" });
        emit(stateEvent());
        return;
      case "listSessions":
        void refreshSessions();
        return;
      case "loadSession":
        void loadSession(textOf(payload.id));
        return;
      case "getSettings":
        emit({
          type: "settings",
          settings: {
            locale,
            theme: storage?.getItem("prometheus.theme") ?? "dark",
            density: storage?.getItem("prometheus.density") ?? "balanced",
            fontScale: Number(storage?.getItem("prometheus.fontScale") ?? 1),
            transcriptWidth: storage?.getItem("prometheus.width") ?? "standard",
            transcriptView: storage?.getItem("prometheus.view") ?? "normal",
            reduceMotion: storage?.getItem("prometheus.motion") === "reduced",
            codeFont: storage?.getItem("prometheus.codeFont") ?? "",
            outputStyle: "default",
            restartSession: storage?.getItem("prometheus.restartSession") !== "0",
            suggestions: storage?.getItem("prometheus.suggestions") !== "0",
            updateCheck: false,
            isolateByDefault: false,
            providers: [],
            models: [],
            model: lastModel,
          },
        });
        return;
      case "setMode": {
        const mode = textOf(payload.mode);
        if (["read-only", "workspace-write", "diagnose", "danger-full-access"].includes(mode)) {
          stateMode = mode;
          emit(stateEvent());
        }
        return;
      }
      case "setLocale": {
        const next = textOf(payload.locale);
        if (next === "en" || next === "zh") {
          locale = next;
          storage?.setItem("prometheus.locale", next);
          emit({ type: "locale", locale: next });
        }
        return;
      }
      case "setUiPreference":
        emit({ type: "ui_preference", key: payload.key, value: payload.value });
        return;
      case "getUsage":
        emit({ type: "usage_summary", days: Number(payload.days) || 30, summary: null });
        return;
      case "getSetupChecklist":
        emit({ type: "setup_checklist", checks: [] });
        return;
      case "listCommands":
        emit({ type: "commands", commands: [] });
        return;
      case "getTree":
        emit({ type: "tree", nodes: [] });
        return;
      case "searchSessions":
        emit({ type: "session_matches", query: textOf(payload.query), sessions: [] });
        return;
    }
  }

  function onEvent(handler) {
    if (typeof handler !== "function") return () => {};
    handlers.add(handler);
    const queued = pending.splice(0);
    for (const message of queued) {
      try {
        handler(message);
      } catch {
        // Same tolerance as `emit`: one bad handler must not stop delivery.
      }
    }
    return () => {
      handlers.delete(handler);
    };
  }

  function boot() {
    if (ready) return;
    ready = true;
    emit({ type: "hello" });
    emit({ type: "ready" });
    emit(stateEvent());
    void refreshSessions();
    emit({ type: "commands", commands: [] });
    emit({ type: "setup_checklist", checks: [] });
    emit({ type: "tree", nodes: [] });
    emit({ type: "locale", locale });
  }

  return {
    api: {
      send,
      onEvent,
      // Same-origin links open in a tab; the renderer calls this unguarded.
      openExternal: (url) => {
        globalThis.open?.(url, "_blank", "noopener");
      },
      // No filesystem pickers in a browser. Returning the empty answer keeps
      // the guarded call sites working; their buttons are hidden anyway.
      pickDirectory: async () => null,
      pickFile: async (options) =>
        isRecord(options) && options.multiple === true ? [] : null,
      // Downloads are the browser-native equivalent of Save As.
      saveFile: async (name, content) => {
        const blob = new Blob([String(content ?? "")], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = String(name ?? "session.json");
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        return { saved: true, path: anchor.download };
      },
      appVersion: async () => "web",
      restartHost: () => globalThis.location?.reload(),
      platform: undefined,
      ...(notify === undefined ? {} : { notify }),
    },
    boot,
    /** Test seam: drive the SSE pump without a real browser. */
    _internal: {
      emit,
      getSessionId: () => currentSessionId,
      getLastSeq: () => lastSeq,
      getStreamSessionId: () => streamSessionId,
      openStream,
      adoptSession,
    },
  };
}

// Install only when nothing else already did: under Electron the preload has
// defined `window.prometheus`, and the bridge must leave it alone.
if (typeof window !== "undefined" && window.prometheus === undefined) {
  const bridge = createBrowserBridge();
  window.prometheus = bridge.api;
  bridge.boot();
}
