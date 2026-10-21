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
  sessionExportName,
  sessionLoadedEvent,
  sessionMarkdown,
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
  /** The rows last sent to the sidebar; `searchSessions` filters over these. */
  let lastSessions = [];
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

  /**
   * Switch the open session and start its translation cursor after `events`.
   *
   * `lastSeq` is the bridge's own bookmark of what it has already handed to
   * the renderer. For a session that was just loaded from disk it is the last
   * event in the log — starting at -1 there would replay the whole transcript
   * the next time the stream opened.
   */
  function adoptSession(id, events) {
    currentSessionId = id;
    lastSeq = -1;
    for (const event of events) {
      if (isRecord(event) && typeof event.seq === "number" && event.seq > lastSeq) lastSeq = event.seq;
    }
    ctx = createContext({ sessionId: id });
    ctx.lastSeq = lastSeq;
  }

  /** How many times one run may re-open the stream or rebuild from disk. */
  const MAX_STREAM_REOPENS = 3;
  const MAX_RELOADS = 3;

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
      // A gap means events between our cursor and this one never reached the
      // renderer; appending what follows would splice two non-adjacent states
      // together. Rebuild the transcript from the log instead of guessing.
      const seq = typeof parsed.seq === "number" ? parsed.seq : undefined;
      if (seq !== undefined && seq > ctx.lastSeq + 1 && ctx.lastSeq >= 0) {
        void reloadAfterGap(id);
        return;
      }
      emitAll(sessionEventToHostEvents(parsed, ctx));
      lastSeq = ctx.lastSeq;
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
      // `slow_consumer` is the server telling us to reload; anything else is a
      // broken read. Both are recoverable up to a bounded number of attempts.
      closeStream();
      if (attemptReopen(code)) return;
      emit({
        type: "notice",
        level: "warn",
        text: code === "" ? "实时事件流中断" : `实时事件流中断（${code}），已停止重试`,
      });
      if (ctx.running) {
        ctx.running = false;
        emit({ type: "run_end" });
      }
    });
  }

  let streamReopens = 0;
  let gapReloads = 0;

  /** Re-open the stream from the current cursor. False when out of attempts. */
  function attemptReopen(code) {
    if (typeof EventSourceCtor !== "function") return false;
    if (streamReopens >= MAX_STREAM_REOPENS) return false;
    streamReopens += 1;
    emit({
      type: "notice",
      level: "dim",
      text: `实时事件流中断（${code === "" ? "连接断开" : code}），正在从第 ${lastSeq + 1} 条续接`,
    });
    openStream(lastSeq);
    return true;
  }

  /**
   * Rebuild the open conversation from the log after a gap.
   *
   * The renderer replaces its transcript with `session_loaded`, so the result
   * is a coherent view of what actually happened rather than a splice. Bounded:
   * a session that keeps gapping is reported instead of retried forever.
   */
  async function reloadAfterGap(id) {
    if (gapReloads >= MAX_RELOADS) {
      emit({
        type: "notice",
        level: "warn",
        text: `事件流出现缺口，已重试 ${MAX_RELOADS} 次仍未补齐`,
      });
      return;
    }
    gapReloads += 1;
    closeStream();
    emit({ type: "notice", level: "dim", text: "事件流出现缺口，正在重新读取会话" });
    const wasRunning = ctx.running;
    try {
      const response = await fetchImpl(`/api/sessions/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      const events = isRecord(body) && Array.isArray(body.events) ? body.events : [];
      const header = isRecord(body) && isRecord(body.header) ? body.header : {};
      adoptSession(id, events);
      // `adoptSession` builds a fresh context; the turn is still in flight.
      ctx.running = wasRunning;
      emit(sessionLoadedEvent(events, { cwd: textOf(header.workdir), mode: stateMode }));
      emit(stateEvent());
    } catch (error) {
      ctx.running = wasRunning;
      emit({
        type: "notice",
        level: "warn",
        text: `缺口重读失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (wasRunning) openStream(lastSeq);
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
      // A session the operator renamed carries its title from the API. Only
      // the rest need the first user message read out of the log, and only a
      // bounded number of them: this is one request per untitled session.
      const missing = summaries
        .filter((summary) => isRecord(summary) && textOf(summary.title) === "")
        .map((summary) => textOf(summary.id))
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
          const title = textOf(record.title) || (titles.get(id) ?? "");
          return { ...record, title, summary: title === "" ? id : title };
        }),
      );
      event.sessions = event.sessions.map((session) => ({
        ...session,
        status: session.id === runningSessionId ? "working" : "ready",
      }));
      lastSessions = event.sessions;
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
    // The cursor this turn starts from: everything the renderer already shows.
    // A brand-new conversation has nothing yet (-1); continuing one resumes
    // after its last event. Opening the stream at -1 for a continued session
    // re-translated the whole log into a transcript the user was already
    // reading, so every follow-up redrew the conversation from the top.
    const since = lastSeq;
    streamReopens = 0;
    gapReloads = 0;
    ctx = createContext({ sessionId: currentSessionId });
    ctx.lastSeq = since;
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
          // The permission preset this run executes under. The server refuses
          // unknown values, so a stale client cannot fall back silently.
          mode: stateMode,
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
    // `adoptSession` resets the cursor to the log's head; this turn's events
    // start after `since`, so both the bookmarked seq and the translation
    // cursor have to be put back. Same for `running`: without it `stream_end`
    // would not know a turn was in flight and would never emit run_end.
    lastSeq = since;
    ctx.lastSeq = since;
    ctx.running = true;
    currentSessionId = sessionId;
    runningSessionId = sessionId;
    openStream(since);
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
    "saveMcpServer",
    "removeMcpServer",
    "savePermissions",
    "saveRunLimits",
    "sessionFlags",
    "deleteSession",
    "forkSession",
    "revealArtifact",
    "exportSession",
  ]);

  /** The last `/api/config` snapshot; the settings page reads from here. */
  let lastConfig = null;

  async function refreshConfig() {
    try {
      const response = await fetchImpl("/api/config");
      if (!response.ok) {
        emit({ type: "notice", level: "warn", text: `配置读取失败：${await readError(response)}` });
        return;
      }
      lastConfig = await response.json();
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `配置读取失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    emitSettings();
  }

  function emitSettings() {
    const settings = { locale, providers: [], models: [], model: lastModel };
    const stored = storage?.getItem("prometheus.theme");
    if (stored !== null && stored !== undefined) settings.theme = stored;
    if (isRecord(lastConfig)) {
      if (Array.isArray(lastConfig.mcpServers)) settings.mcpServers = lastConfig.mcpServers;
      if (isRecord(lastConfig.permissions)) settings.permissions = lastConfig.permissions;
      if (isRecord(lastConfig.run)) settings.run = lastConfig.run;
      settings.configPaths = {
        mcp: textOf(lastConfig.mcpPath),
        permissions: textOf(lastConfig.permissionsPath),
        run: textOf(lastConfig.runPath),
      };
    }
    emit({ type: "settings", settings });
  }

  /** PUT /api/config with one section; a rejection becomes a warning. */
  async function putConfig(section, value) {
    try {
      const response = await fetchImpl("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [section]: value }),
      });
      if (!response.ok) {
        emit({ type: "notice", level: "warn", text: `配置未保存：${await readError(response)}` });
        return;
      }
      lastConfig = await response.json();
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `配置未保存：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    emitSettings();
  }

  /**
   * Render the open conversation as Markdown and hand it to the renderer.
   *
   * The transcript is rebuilt from the log, not scraped from the DOM: the log
   * is the record, and a scrolled or partly built screen is not.
   */
  async function exportSession(id) {
    try {
      const response = await fetchImpl(`/api/sessions/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      const events = isRecord(body) && Array.isArray(body.events) ? body.events : [];
      const title = titles.get(id) ?? titleOf(events);
      emit({
        type: "export_ready",
        markdown: sessionMarkdown(events, { title }),
        filename: sessionExportName(id, title),
      });
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `导出失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** One mutating call against a saved session; failures become a warning. */
  async function sessionCommand(method, path, body) {
    try {
      const response = await fetchImpl(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        emit({ type: "notice", level: "warn", text: `会话操作失败：${await readError(response)}` });
        return undefined;
      }
      return await response.json().catch(() => ({}));
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `会话操作失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

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
        // The config half comes from `/api/config`; the UI half is local.
        // Re-reading on every open is what makes an edit to `mcp.json` in an
        // editor show up without a server restart.
        void refreshConfig();
        return;
      case "saveMcpServer": {
        const server = isRecord(payload.server) ? payload.server : {};
        const existing = Array.isArray(lastConfig?.mcpServers) ? lastConfig.mcpServers : [];
        const name = textOf(server.name).trim();
        const next = existing.filter((entry) => textOf(entry.name) !== name);
        next.push({
          name,
          command: textOf(server.command).trim(),
          ...(textOf(server.args).trim() === "" ? {} : { args: textOf(server.args).trim().split(/\s+/) }),
          ...(textOf(server.cwd).trim() === "" ? {} : { cwd: textOf(server.cwd).trim() }),
          ...(server.timeoutMs === undefined || server.timeoutMs === null || server.timeoutMs === ""
            ? {}
            : { timeoutMs: Number(server.timeoutMs) }),
          disabled: server.disabled === true,
        });
        void putConfig("mcpServers", next);
        return;
      }
      case "removeMcpServer": {
        const name = textOf(payload.name);
        const existing = Array.isArray(lastConfig?.mcpServers) ? lastConfig.mcpServers : [];
        void putConfig("mcpServers", existing.filter((entry) => textOf(entry.name) !== name));
        return;
      }
      case "savePermissions":
        void putConfig("permissions", isRecord(payload.permissions) ? payload.permissions : {});
        return;
      case "saveRunLimits":
        void putConfig("run", isRecord(payload.run) ? payload.run : {});
        return;
      case "sessionFlags": {
        const id = textOf(payload.id);
        if (id === "") return;
        void sessionCommand("PATCH", `/api/sessions/${encodeURIComponent(id)}`, {
          ...(payload.title !== undefined ? { title: payload.title } : {}),
          ...(payload.pinned !== undefined ? { pinned: payload.pinned === true } : {}),
          ...(payload.archived !== undefined ? { archived: payload.archived === true } : {}),
        }).then((body) => {
          if (body === undefined) return;
          void refreshSessions();
        });
        return;
      }
      case "deleteSession": {
        const id = textOf(payload.id);
        if (id === "") return;
        if (id === currentSessionId) {
          emit({ type: "notice", level: "warn", text: "不能删除当前打开的会话，请先新建会话" });
          return;
        }
        void sessionCommand("DELETE", `/api/sessions/${encodeURIComponent(id)}`).then((body) => {
          if (body === undefined) return;
          titles.delete(id);
          void refreshSessions();
        });
        return;
      }
      case "forkSession": {
        const id = textOf(payload.id);
        if (id === "") return;
        if (ctx.running) {
          emit({ type: "notice", level: "warn", text: "当前回合尚未结束，请先停止或等待" });
          return;
        }
        void sessionCommand("POST", `/api/sessions/${encodeURIComponent(id)}/fork`).then((body) => {
          const forkedId = isRecord(body) ? textOf(body.sessionId) : "";
          if (forkedId === "") return;
          emit({ type: "notice", level: "dim", text: `已从该会话分叉出 ${forkedId}` });
          void refreshSessions();
          void loadSession(forkedId);
        });
        return;
      }
      case "revealArtifact": {
        const target = textOf(payload.path);
        if (target === "") return;
        // A browser cannot open the file manager. An `openExternal` call on a
        // `file://` URL is silently ignored by Chrome, so the path is reported
        // instead of pretending a window opened.
        emit({ type: "notice", level: "dim", text: `产物：${target}` });
        return;
      }
      case "exportSession": {
        if (currentSessionId === "") {
          emit({ type: "notice", level: "warn", text: "没有可导出的对话" });
          return;
        }
        void exportSession(currentSessionId);
        return;
      }
      case "setMode": {
        const mode = textOf(payload.mode);
        if (["read-only", "workspace-write", "diagnose", "danger-full-access"].includes(mode)) {
          if (ctx.running) {
            // Changing the preset mid-run would change what the operator has
            // already approved for this turn.
            emit({ type: "notice", level: "warn", text: "运行中不能切换权限模式" });
            return;
          }
          // The mode travels with the next prompt (`POST /api/actions` takes
          // it), so the kernel's gate runs under the preset the user picked.
          // Tracking it locally only would leave the menu a control that
          // changes a label and nothing else.
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
      case "searchSessions": {
        // The list the bridge already holds is all it can search: the HTTP API
        // has no query parameter. Filtering here at least matches what the
        // sidebar shows; answering with `[]` reported "no such conversation"
        // for a row the user was looking at.
        const query = textOf(payload.query).trim().toLowerCase();
        const matches =
          query === ""
            ? []
            : lastSessions.filter((entry) => {
                const haystack = `${entry.title ?? ""} ${entry.summary ?? ""} ${entry.cwd ?? ""}`;
                return haystack.toLowerCase().includes(query);
              });
        emit({ type: "session_matches", query, sessions: matches });
        return;
      }
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
