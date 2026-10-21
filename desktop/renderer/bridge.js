/**
 * Browser bridge: `window.prometheus` over the kernel's HTTP/SSE server.
 *
 * The renderer was written against an Electron preload that speaks NDJSON to
 * a host process. Served from `npm run serve:ui` there is no preload, so this
 * module installs the same small surface — `send`, `onEvent`, and the handful
 * of optional members the renderer guards — on top of the API the server
 * already exposes:
 *
 *   prompt          POST /api/actions           (optional `cwd`, `model`)
 *   permission      POST /api/approvals
 *   abort           POST /api/abort
 *   listSessions    GET  /api/sessions
 *   loadSession     GET  /api/sessions/:id
 *   getTree         GET  /api/tree?path=…
 *   setModel        local choice, sent as `model` by the next new session
 *   refreshModels   GET  /api/config
 *   setWorkspace    POST /api/workspace        { path }
 *   getFile         GET  /api/file?path=…
 *   getArtifacts    GET  /api/sessions/:id/artifacts
 *   getArtifact     GET  /api/file?path=…
 *   saveProviders   PUT  /api/config           { providers }
 *   testProvider    POST /api/providers/test   { baseUrl, apiKey?, apiKeyEnv?, model? }
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
  modelsOf,
  providersEvent,
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

/**
 * A path key that compares the same way the sidebar groups sessions.
 *
 * Windows sessions were saved with both separators (`G:\x` and `G:/x`), and
 * the renderer's own `normalizeCwd` folds case; matching a filter with a raw
 * `===` would hide every session under the folder the user is looking at.
 */
function pathKey(value) {
  return textOf(value).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
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
  /**
   * Chooser for several same-named folders: `(candidates, name) => path|null`.
   *
   * Injected so tests can answer without a DOM; `pickDirectory` falls back to
   * the built-in dialog when this is absent.
   */
  const chooseCandidate = typeof options.chooseCandidate === "function" ? options.chooseCandidate : undefined;
  const handlers = new Set();
  /** Events produced before the renderer subscribed (hello/ready/state). */
  const pending = [];
  let ready = false;
  let stream;
  let streamSessionId = "";
  let runningSessionId = "";
  let currentSessionId = "";
  let lastSeq = -1;
  /**
   * The model the next *new* conversation is created with.
   *
   * It is deliberately not overwritten when an old session is opened: the
   * kernel pins a session's model in its header and refuses to resume under a
   * different one, so a pick made here can only ever apply to the next new
   * conversation. Letting a header write this value meant that merely reading
   * an old conversation silently redefined what "new session" would run on,
   * discarding a pick the operator had just made.
   */
  let lastModel = "";
  /** The open session's own model from its header; display only. */
  let sessionModel = "";
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
      // The picker reads the catalogue from here. Sending `[]` left it stuck
      // on "loading models…" for the whole session, and the chip reported no
      // model while `providers.json` named one.
      model: shownModel(),
      models: modelsOf(isRecord(lastConfig) ? lastConfig.providers : undefined),
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
      sessionModel = textOf(header.model) || sessionModel;
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

  /**
   * The list/filter the operator last asked for.
   *
   * `listSessions` carries the sidebar's archive toggle and filter, and the
   * HTTP list has no query parameters — the bridge filters what the server
   * returns. Remembering the request keeps a background refresh (after a run
   * or a rename) from putting the archived rows the user just hid back on
   * screen.
   */
  let listFilter = {};

  /** The last `status` filter the bridge warned about, so it warns once. */
  let lastStatusNotice = "";

  async function refreshSessions(options) {
    if (options !== undefined) {
      listFilter = {
        includeArchived: options.includeArchived === true,
        cwd: textOf(options.cwd),
        status: textOf(options.status),
      };
    }
    const filter = listFilter;
    if (filter.status !== undefined && filter.status !== "") {
      // The HTTP list carries no run state, so the four state filters cannot
      // be answered. Saying so beats an unchanged list that reads as "no
      // sessions match"; the notice fires once per selection, not per refresh.
      if (filter.status !== lastStatusNotice) {
        lastStatusNotice = filter.status;
        emit({ type: "notice", level: "dim", text: "浏览器形态暂不支持按状态筛选" });
      }
    } else {
      lastStatusNotice = "";
    }
    try {
      const response = await fetchImpl("/api/sessions");
      if (!response.ok) {
        emit({ type: "notice", level: "warn", text: `会话列表读取失败：${await readError(response)}` });
        return;
      }
      const body = await response.json();
      const all = isRecord(body) && Array.isArray(body.sessions) ? body.sessions : [];
      // The open session's workdir is read from the unfiltered list: the open
      // conversation may be archived or in another folder, and the sidebar
      // still needs its cwd to expand the right group.
      const openSummary = all.find(
        (summary) => isRecord(summary) && summary.id === currentSessionId,
      );
      const workdir = textOf(isRecord(openSummary) ? openSummary.workdir : undefined);
      const summaries = all.filter((summary) => {
        if (!isRecord(summary)) return true;
        if (summary.archived === true && filter.includeArchived !== true) return false;
        if (filter.cwd !== undefined && filter.cwd !== "" && pathKey(summary.workdir) !== pathKey(filter.cwd)) {
          return false;
        }
        return true;
      });
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
      // The filtered count is the number the sidebar paginates against; the
      // server total would offer "load more" for rows the filter removed.
      event.total = event.sessions.length;
      event.all = event.sessions.length;
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
          // The working directory the operator is looking at (the open
          // session's workdir, or the one just registered as the workspace).
          // Absent when the bridge does not know one: a made-up path would
          // start the run in the wrong folder.
          ...(currentCwd === "" ? {} : { cwd: currentCwd }),
          // The picker's choice, only when this prompt creates the session.
          // A resumed run keeps the model in its header, and sending another
          // one would only earn a `model_mismatch` from the kernel.
          ...(currentSessionId === ""
            ? { ...(lastModel === "" ? {} : { model: lastModel }) }
            : {}),
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
      // A session just created is pinned to the model this prompt sent, which
      // is what its header now says; the chip must name that, not a later pick
      // that only applies to the *next* new conversation.
      if (created && lastModel !== "") sessionModel = lastModel;
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
    // Display only: this is the model the opened conversation is pinned to.
    // `lastModel` stays whatever the operator picked for the next new session
    // — see its declaration for why the two must not be the same variable.
    sessionModel = textOf(header.model) || sessionModel;
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
    "setModel",
    "refreshModels",
    "setLocale",
    "setUiPreference",
    "getUsage",
    "getSetupChecklist",
    "listCommands",
    "getTree",
    "setWorkspace",
    "getFile",
    "getArtifacts",
    "getArtifact",
    "searchSessions",
    "saveSettings",
    "saveProviders",
    "testProvider",
    "setEffort",
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
    emitModels();
  }

  /**
   * Feed the picker from the provider file.
   *
   * The desktop host sends this event after a save; the browser form has the
   * same job. Only a non-empty list is announced: an empty `models` event
   * would blank a catalogue the picker already has.
   */
  function emitModels() {
    const models = modelsOf(isRecord(lastConfig) ? lastConfig.providers : undefined);
    if (models.length === 0) return;
    // The kernel falls back to the file's first reference when none is
    // configured, so the chip must name the same one the run will use. Only a
    // reference the file no longer offers is replaced: an existing pick
    // survives a reload, otherwise every settings visit would silently undo it.
    if (lastModel === "" || !models.some((model) => model.id === lastModel)) {
      lastModel = models[0].id;
    }
    if (sessionModel !== "" && !models.some((model) => model.id === sessionModel)) {
      sessionModel = "";
    }
    emit({ type: "models", models, model: shownModel(), source: "providers.json" });
    emit(stateEvent());
  }

  /** The model the chip names: the open session's, else the next new one's. */
  function shownModel() {
    return currentSessionId === "" ? lastModel : sessionModel || lastModel;
  }

  /**
   * Pick the model for the next new conversation.
   *
   * Only a reference the provider file lists is accepted: `POST /api/actions`
   * resolves it again and a typo would surface as a failed turn instead of a
   * rejected choice. The open session keeps its own model — the kernel pins it
   * in the header and refuses to resume under another one — so a pick made
   * here can only ever apply to the next new session, and the notice says so.
   */
  function setModel(model) {
    // An empty or non-string model is a renderer bug, not a choice. Returning
    // silently is right here: `renderModelMenu` only ever sends an id from the
    // catalogue it was given.
    if (model === "") return;
    if (ctx.running) {
      // Rebuilding the run under a different model mid-turn is not something
      // the kernel supports; pretending the click worked would be worse.
      emit({ type: "notice", level: "warn", text: "运行中不能切换模型" });
      return;
    }
    const models = modelsOf(isRecord(lastConfig) ? lastConfig.providers : undefined);
    if (!models.some((entry) => entry.id === model)) {
      emit({ type: "notice", level: "warn", text: `模型不在 providers.json 中：${model}` });
      return;
    }
    lastModel = model;
    emit({ type: "models", models, model: shownModel(), source: "providers.json" });
    emit(stateEvent());
    if (currentSessionId !== "") {
      // The chip keeps naming the open session's model, so without this line
      // the click would look like it did nothing at all.
      emit({
        type: "notice",
        level: "dim",
        text: "模型仅对新建会话生效；当前会话沿用启动时的模型",
      });
    }
  }

  function emitSettings() {
    const file = isRecord(lastConfig) ? lastConfig.providers : undefined;
    // The file's own shape reaches the settings page here. Without it the page
    // has nothing it can write back, so it renders "this host does not report
    // an editable configuration" instead of a form — the browser form had no
    // way to configure a model at all.
    const { providers, providerConfig } = providersEvent(file);
    const settings = { locale, providers, models: modelsOf(file), model: lastModel };
    if (providerConfig !== undefined) settings.providerConfig = providerConfig;
    if (typeof lastConfig?.providersError === "string" && lastConfig.providersError !== "") {
      settings.providersError = lastConfig.providersError;
    }
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
        providers: textOf(lastConfig.providersPath),
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
    // Saving the provider file is what teaches the picker a new model; the
    // desktop host does the same after `writeProviders`. Without this a model
    // added on the settings page would be usable by the next run but still
    // absent from the menu the operator picks from.
    if (section === "providers") emitModels();
  }

  /**
   * Probe one model gateway for the settings page.
   *
   * The server owns the probe: it resolves `apiKeyEnv` against its own
   * environment, forwards a directly-typed `apiKey` only into the outbound
   * request, and talks to the gateway. The bridge never reads the key and
   * never guesses that a gateway is up. Every outcome — a refusal, a network
   * error, a non-200 — comes back as a `provider_test` event carrying the
   * address the operator typed: that is the string the page keys its card on,
   * and a normalized echo would leave the card stuck on "testing".
   *
   * `ok: true` is only ever forwarded from the server's own explicit `true`.
   * A 200 whose body never said so is not evidence the gateway answered, and a
   * green card on an untested address is the silent success R3 forbids.
   *
   * The key itself must never leave in an event: `provider_test` carries only
   * the address and the reason, and every error string is passed through
   * `redact` first so a transport error that happens to quote the request
   * cannot echo it into the renderer's event stream.
   */
  async function testProvider(baseUrl, apiKeyEnv, model, apiKey) {
    const address = textOf(baseUrl).trim();
    const key = textOf(apiKey).trim();
    // Defense in depth: nothing below is supposed to put the key in a message,
    // but a `fetch` rejection text is not ours to control.
    const redact = (text) => (key === "" ? text : text.split(key).join("***"));
    if (address === "") {
      emit({
        type: "provider_test",
        ok: false,
        baseUrl: "",
        error: "连接测试失败：请先填写模型服务地址（baseUrl）",
      });
      return;
    }
    // Only the fields the operator filled in: an empty `apiKeyEnv` would ask
    // the server to read a variable with no name.
    const body = {
      baseUrl: address,
      ...(textOf(apiKeyEnv).trim() === "" ? {} : { apiKeyEnv: textOf(apiKeyEnv).trim() }),
      ...(textOf(model).trim() === "" ? {} : { model: textOf(model).trim() }),
      ...(key === "" ? {} : { apiKey: key }),
    };
    let response;
    try {
      response = await fetchImpl("/api/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      emit({
        type: "provider_test",
        ok: false,
        baseUrl: address,
        error: redact(`连接测试失败：${error instanceof Error ? error.message : String(error)}`),
      });
      return;
    }
    if (!response.ok) {
      // A 400 carries the reason the address was refused. `readError` only
      // understands the API's `{ error: { message } }` envelope; the probe may
      // report its own shape, so the body is read here and the same three
      // spellings are tried before falling back to the status line.
      let reason = "";
      try {
        const body = await response.json();
        if (isRecord(body)) {
          reason =
            textOf(isRecord(body.error) ? body.error.message : undefined)
            || textOf(body.message)
            || textOf(body.error);
        }
      } catch {
        // Not JSON: the status line below is the honest answer.
      }
      emit({
        type: "provider_test",
        ok: false,
        baseUrl: address,
        error: redact(`连接测试失败：${reason === "" ? `HTTP ${response.status}` : reason}`),
      });
      return;
    }
    const payload = await response.json().catch(() => undefined);
    if (!isRecord(payload)) {
      emit({
        type: "provider_test",
        ok: false,
        baseUrl: address,
        error: "连接测试失败：服务端返回了无法解析的内容",
      });
      return;
    }
    if (payload.ok !== true) {
      const reason = textOf(payload.error);
      emit({
        type: "provider_test",
        ok: false,
        baseUrl: address,
        error: redact(reason === "" ? "连接测试失败：服务端未给出原因" : reason),
        ...(textOf(payload.code) === "" ? {} : { code: textOf(payload.code) }),
        // A failed probe has no latency to report; `0` would read as "instant".
        ...(typeof payload.latencyMs === "number" ? { latencyMs: payload.latencyMs } : {}),
      });
      return;
    }
    emit({
      type: "provider_test",
      ok: true,
      baseUrl: address,
      // Absent means "the gateway did not list its models", which is not the
      // same as "it listed none" — the field is left out rather than sent as
      // an empty array.
      ...(Array.isArray(payload.models)
        ? { models: payload.models.filter((entry) => typeof entry === "string") }
        : {}),
      ...(typeof payload.latencyMs === "number" ? { latencyMs: payload.latencyMs } : {}),
    });
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

  /**
   * One read of `/api/file`; the server owns the path rules.
   *
   * Returns the preview body or `undefined` after emitting the warning. The
   * path travels percent-encoded: an absolute Windows path carries `:` and
   * `\`, and building the URL by hand would split the query at the first one.
   */
  async function readFilePreview(path, label) {
    let response;
    try {
      response = await fetchImpl(`/api/file?path=${encodeURIComponent(path)}`);
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `${label}：${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
    if (!response.ok) {
      emit({ type: "notice", level: "warn", text: `${label}：${await readError(response)}` });
      return undefined;
    }
    const body = await response.json().catch(() => undefined);
    if (!isRecord(body)) {
      emit({ type: "notice", level: "warn", text: `${label}：服务端返回了无法解析的内容` });
      return undefined;
    }
    return body;
  }

  /**
   * One directory listing from `/api/tree`.
   *
   * The renderer parks the child container of the folder it just expanded in
   * `pendingTreeTarget` and only releases it on the next `tree` event. Every
   * failure therefore answers with a warning *and* an empty tree: the notice
   * says why, the empty tree lets the row collapse instead of waiting forever.
   * An empty tree on its own would read as "the folder is empty" (R3).
   */
  async function getTree(path) {
    const label = "文件树读取失败";
    if (path === "") {
      // Without a path the request would be answered with a path error the
      // user cannot act on; the empty tree still releases the expander.
      emit({ type: "notice", level: "warn", text: `${label}：没有给出路径` });
      emit({ type: "tree", nodes: [] });
      return;
    }
    let response;
    try {
      response = await fetchImpl(`/api/tree?path=${encodeURIComponent(path)}`);
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `${label}：${error instanceof Error ? error.message : String(error)}`,
      });
      emit({ type: "tree", nodes: [] });
      return;
    }
    if (!response.ok) {
      emit({ type: "notice", level: "warn", text: `${label}：${await readError(response)}` });
      emit({ type: "tree", nodes: [] });
      return;
    }
    const body = await response.json().catch(() => undefined);
    if (!isRecord(body)) {
      emit({ type: "notice", level: "warn", text: `${label}：服务端返回了无法解析的内容` });
      emit({ type: "tree", nodes: [] });
      return;
    }
    // The server's shape is already the renderer's (`{name, path, type}`); it
    // is passed through rather than rebuilt, so a new field is not dropped.
    const entries = Array.isArray(body.entries) ? body.entries : [];
    emit({ type: "tree", nodes: entries, truncated: body.truncated === true });
  }

  /**
   * Register the folder the operator wants to work in.
   *
   * The server refuses `/api/tree` and `/api/file` paths outside a known
   * workspace, so the root has to be announced before the tree can be read.
   * Local state is only adopted after the server accepts it: a rejected path
   * must leave the topbar on the folder that actually works.
   */
  async function setWorkspace(path) {
    if (path === "") {
      emit({ type: "notice", level: "warn", text: "工作区切换失败：没有给出路径" });
      return;
    }
    let response;
    try {
      response = await fetchImpl("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `工作区切换失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (!response.ok) {
      emit({ type: "notice", level: "warn", text: `工作区切换失败：${await readError(response)}` });
      return;
    }
    const body = await response.json().catch(() => undefined);
    const accepted = textOf(isRecord(body) ? body.path : undefined) || path;
    currentCwd = accepted;
    emit(stateEvent());
    void getTree(accepted);
  }

  /**
   * Open one file in the workbench.
   *
   * The renderer keys the preview on `file.path` matching `state.selectedFile`,
   * and `selectedFile` is what was clicked. The server answers with the
   * resolved real path (`G:\x` for `g:/x`), so passing it through unchanged
   * would make the renderer drop the preview as "not the selected file". The
   * requested path is kept and the resolved one travels alongside.
   */
  async function getFile(path) {
    if (path === "") {
      emit({ type: "notice", level: "warn", text: "文件读取失败：没有给出路径" });
      return;
    }
    const body = await readFilePreview(path, "文件读取失败");
    if (body === undefined) return;
    emit({
      type: "file",
      file: {
        path,
        ...(textOf(body.path) === "" || body.path === path ? {} : { resolvedPath: body.path }),
        content: textOf(body.content),
        truncated: body.truncated === true,
        binary: body.binary === true,
      },
    });
  }

  /** The current session's artifacts; no session is an empty list, not an error. */
  async function getArtifacts() {
    if (currentSessionId === "") {
      emit({ type: "artifacts", artifacts: [] });
      return;
    }
    let response;
    try {
      response = await fetchImpl(`/api/sessions/${encodeURIComponent(currentSessionId)}/artifacts`);
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `产物列表读取失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (!response.ok) {
      emit({ type: "notice", level: "warn", text: `产物列表读取失败：${await readError(response)}` });
      return;
    }
    const body = await response.json().catch(() => undefined);
    const artifacts = isRecord(body) && Array.isArray(body.artifacts) ? body.artifacts : [];
    emit({ type: "artifacts", artifacts });
  }

  /**
   * Render one artifact in the workbench pane.
   *
   * Same endpoint as `getFile`, different event: `renderArtifact` takes a
   * `kind` and picks a renderer from it. The listing reports `unknown` for
   * files it cannot classify, which the pane would draw as raw JSON; a listed
   * artifact that is plain text is therefore opened as `text`. A binary file
   * cannot be drawn at all, and saying so is the honest answer.
   */
  async function getArtifact(path) {
    if (path === "") {
      emit({ type: "notice", level: "warn", text: "产物读取失败：没有给出路径" });
      return;
    }
    const body = await readFilePreview(path, "产物读取失败");
    if (body === undefined) return;
    if (body.binary === true) {
      emit({ type: "notice", level: "dim", text: `产物是二进制文件，无法在浏览器中预览：${path}` });
      return;
    }
    emit({
      type: "artifact",
      artifact: {
        path,
        kind: "text",
        content: textOf(body.content),
        truncated: body.truncated === true,
      },
    });
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

  /**
   * Ask the server which absolute paths carry the folder name the picker gave.
   *
   * `showDirectoryPicker` hands back a `FileSystemDirectoryHandle` whose
   * `name` is a bare folder name — never the absolute path `/api/tree` and
   * `/api/file` need. The server and the page usually run on the same machine,
   * so the server can look the name up within a bounded set of places it
   * already knows about. The result is only a list of candidates: it grants
   * nothing by itself, the accepted path is still registered through
   * `POST /api/workspace`.
   *
   * `undefined` means the lookup itself failed and a notice already said why;
   * an empty `candidates` is a real answer ("no such folder here").
   */
  async function resolveWorkspaceName(name) {
    let response;
    try {
      response = await fetchImpl("/api/workspace/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch (error) {
      emit({
        type: "notice",
        level: "warn",
        text: `定位文件夹失败：${error instanceof Error ? error.message : String(error)}；请直接输入绝对路径`,
      });
      return undefined;
    }
    if (!response.ok) {
      emit({
        type: "notice",
        level: "warn",
        text: `定位文件夹失败：${await readError(response)}；请直接输入绝对路径`,
      });
      return undefined;
    }
    const body = await response.json().catch(() => undefined);
    if (!isRecord(body) || !Array.isArray(body.candidates)) {
      emit({ type: "notice", level: "warn", text: "定位文件夹失败：服务端返回了无法解析的内容；请直接输入绝对路径" });
      return undefined;
    }
    const candidates = [];
    for (const entry of body.candidates) {
      if (!isRecord(entry)) continue;
      const candidatePath = textOf(entry.path).trim();
      if (candidatePath === "") continue;
      candidates.push({ path: candidatePath, name: textOf(entry.name) || name });
    }
    return { candidates, truncated: body.truncated === true };
  }

  /**
   * Draw a chooser for several same-named folders. `undefined` = cannot draw.
   *
   * Plain DOM: the renderer has no framework and no bundler, and this is the
   * only place the bridge itself needs a widget. `null` is an explicit cancel.
   */
  function drawCandidateChooser(candidates, folderName) {
    const doc = globalThis.document;
    if (doc === undefined || typeof doc.createElement !== "function") return undefined;
    const dialog = doc.createElement("dialog");
    if (typeof dialog.showModal !== "function") return undefined;
    dialog.className = "bridge-candidate-dialog";
    const heading = doc.createElement("p");
    // The bridge already tracks the UI locale; `i18n.js` is the renderer's own
    // table and this widget lives here, so these two strings are kept local.
    heading.textContent =
      locale === "en"
        ? `Found ${candidates.length} folders named ${folderName}. Choose one to open:`
        : `找到 ${candidates.length} 个名为 ${folderName} 的文件夹，请选择要打开的一个：`;
    dialog.appendChild(heading);
    const list = doc.createElement("div");
    dialog.appendChild(list);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try {
          dialog.close();
        } catch {
          // Closing a dialog that never opened is not worth reporting.
        }
        if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
        resolve(value);
      };
      for (const candidate of candidates) {
        const button = doc.createElement("button");
        button.type = "button";
        button.textContent = candidate.path;
        button.title = candidate.path;
        button.addEventListener("click", () => finish(candidate.path));
        list.appendChild(button);
      }
      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.textContent = locale === "en" ? "Cancel" : "取消";
      cancel.addEventListener("click", () => finish(null));
      dialog.appendChild(cancel);
      // Esc closes with an empty return value; treat it as the same cancel.
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish(null);
      });
      doc.body.appendChild(dialog);
      try {
        dialog.showModal();
      } catch {
        // A document that refuses `showModal` cannot present a choice either.
        finish(undefined);
      }
    });
  }

  /**
   * Ask the browser for a folder and turn its bare name into a real path.
   *
   * `showDirectoryPicker` exists in Chromium but never reveals an absolute
   * path — only `handle.name`. The name is not useless: the server is usually
   * on the same machine and can resolve it within a bounded search. So the
   * click now leads somewhere: one candidate is used directly, several are
   * offered for the operator to choose, none falls back to typing with the
   * reason spelled out.
   *
   * Returning `null` is always "nothing was picked" and the renderer follows
   * up with a path prompt; what differs is what was already said. A cancelled
   * dialog is a normal cancel and stays quiet. A picker that failed, or a name
   * that could not be found, gets a notice saying which it was (R3).
   */
  async function pickDirectory() {
    const picker = globalThis.showDirectoryPicker;
    if (typeof picker !== "function") {
      // The capability is genuinely absent (Firefox / Safari). Say which part
      // is missing and leave it at that: the caller already answers a `null`
      // with its path field, so a "go type it somewhere" directive here would
      // be a second instruction for a step that is already happening.
      emit({
        type: "notice",
        level: "warn",
        text: "浏览器形态没有原生目录选择器（showDirectoryPicker 不可用），拿不到本地文件夹的绝对路径",
      });
      return null;
    }
    let handle;
    try {
      handle = await picker.call(globalThis);
    } catch (error) {
      // Chromium throws `AbortError` when the operator closes the dialog.
      // Closing a dialog is a decision, not a failure: stay quiet.
      if (error instanceof Error && error.name === "AbortError") return null;
      const reason =
        error instanceof Error && error.message !== "" ? error.message : String(error ?? "未知错误");
      emit({
        type: "notice",
        level: "warn",
        text: `打开文件夹选择器失败：${reason}；请直接输入绝对路径`,
      });
      return null;
    }
    const name = textOf(handle?.name).trim();
    if (name === "") {
      emit({
        type: "notice",
        level: "warn",
        text: "文件夹选择器没有返回文件夹名，无法定位路径；请直接输入绝对路径",
      });
      return null;
    }
    const resolved = await resolveWorkspaceName(name);
    if (resolved === undefined) return null;
    if (resolved.candidates.length === 0) {
      // Saying "not found" is not the same as saying "it does not exist": the
      // search is bounded, and `truncated` means it ran out of budget first.
      emit({
        type: "notice",
        level: "warn",
        text: resolved.truncated
          ? `在常见位置搜索名为 ${name} 的文件夹时超出预算，可能没有找全；请直接输入绝对路径`
          : `没在常见位置找到名为 ${name} 的文件夹，请直接输入绝对路径`,
      });
      return null;
    }
    if (resolved.candidates.length === 1) {
      const only = resolved.candidates[0];
      emit({
        type: "notice",
        level: "dim",
        text: `已按文件夹名定位到 ${only.path}${resolved.truncated ? "（搜索可能不全）" : ""}`,
      });
      return only.path;
    }
    const chooser = typeof chooseCandidate === "function" ? chooseCandidate : drawCandidateChooser;
    let chosen;
    try {
      chosen = await chooser(resolved.candidates, name);
    } catch {
      chosen = undefined;
    }
    // `null` is the operator cancelling the chooser — quiet, like any cancel.
    if (chosen === null) return null;
    const chosenText = textOf(chosen).trim();
    const match = resolved.candidates.find((entry) => pathKey(entry.path) === pathKey(chosenText));
    if (match === undefined) {
      // Nothing was drawn, or the answer was not one of the candidates. Never
      // widen the boundary by handing back an unverified path: list them so the
      // operator can copy the right one.
      emit({
        type: "notice",
        level: "warn",
        text:
          `找到 ${resolved.candidates.length} 个名为 ${name} 的文件夹但没能选定，请直接输入绝对路径：`
          + resolved.candidates.map((entry) => entry.path).join("、"),
      });
      return null;
    }
    return match.path;
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
        // Nothing is pinned any more: the chip goes back to naming the model
        // the next run is created with.
        sessionModel = "";
        adoptSession("", []);
        emit({ type: "session_loaded", messages: [], cwd: "", mode: stateMode, effort: "auto" });
        emit(stateEvent());
        return;
      case "listSessions":
        // The sidebar's archive toggle and filter travel with the request;
        // without them `refreshSessions` would answer with the full list and
        // the controls would look like they did nothing.
        void refreshSessions({
          includeArchived: payload.includeArchived === true,
          cwd: textOf(payload.cwd),
          status: textOf(payload.status),
        });
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
      case "saveProviders":
        // Same writer as the other sections: one error path, one settings
        // reply. A second copy would drift the moment the shape changes.
        void putConfig("providers", isRecord(payload.providers) ? payload.providers : {});
        return;
      case "testProvider":
        // Not awaited: the probe can take the server's full timeout (10 s by
        // default), and the command queue must stay free for a stop or a
        // session switch while the operator waits for the answer.
        void testProvider(payload.baseUrl, payload.apiKeyEnv, payload.model, payload.apiKey);
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
      case "setModel":
        setModel(textOf(payload.model));
        return;
      case "refreshModels":
        // `refreshConfig` already reports a failed read as a warning and keeps
        // the previous catalogue; a second copy here would drift from it.
        void refreshConfig();
        return;
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
      case "setEffort":
        // Reasoning effort is a harness/model setting the kernel does not
        // expose, and `POST /api/actions` carries none. Answering with a
        // `state` would make the menu show a level that never reached the
        // model, so the command says what it cannot do instead.
        emit({ type: "notice", level: "warn", text: "内核不支持调整推理强度" });
        return;
      case "saveSettings": {
        // Only the locale half has a browser-side home (localStorage). The
        // other settings (`provider`, `model`, `apiKey`, …) belong to the
        // kernel's own config files, and this bridge has no general write
        // path for them: a silent success would leave the form claiming a
        // value that was never saved.
        const settings = isRecord(payload.settings) ? payload.settings : {};
        const unknown = Object.keys(settings).filter((key) => key !== "locale");
        let applied = false;
        if (settings.locale === "en" || settings.locale === "zh") {
          locale = settings.locale;
          storage?.setItem("prometheus.locale", settings.locale);
          emit({ type: "locale", locale: settings.locale });
          applied = true;
        } else if (settings.locale !== undefined) {
          unknown.push("locale");
        }
        if (unknown.length > 0) {
          emit({
            type: "notice",
            level: "warn",
            text: `该设置没有后端：${unknown.join(", ")}`,
          });
        } else if (!applied) {
          emit({ type: "notice", level: "warn", text: "该设置没有后端" });
        }
        return;
      }
      case "getFile":
        void getFile(textOf(payload.path));
        return;
      case "getArtifacts":
        void getArtifacts();
        return;
      case "getArtifact":
        void getArtifact(textOf(payload.path));
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
        void getTree(textOf(payload.path));
        return;
      case "setWorkspace":
        void setWorkspace(textOf(payload.path));
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
    // Initial value, not a "not supported" answer: at boot there is no session
    // and no workspace yet, so the sidebar starts blank. Real listings come
    // from the `getTree` command.
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
      pickDirectory,
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
