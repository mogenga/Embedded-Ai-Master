/**
 * Agent host for the desktop app.
 *
 * Runs under plain Node (spawned by the Electron main process with
 * `ELECTRON_RUN_AS_NODE=1`), owns one session at a time, and speaks
 * newline-delimited JSON over stdio:
 *
 *   stdin  <- { cmd: "...", ... }
 *   stdout -> { type: "...", ... }
 *
 * The kernel is consumed through its compiled `dist/` modules, never through
 * `src/`: the host adds transport (NDJSON), session bookkeeping (which run is
 * live, which seq has been delivered) and the renderer's protocol vocabulary.
 * Domain behaviour — approvals, permissions, MCP, tools — stays in the kernel.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
// Dynamic import takes a URL, not a Windows path: `E:\...` would be parsed as
// a protocol named "e".
const dist = (name) => pathToFileURL(path.join(repoRoot, "dist", name)).href;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fatal(message) {
  send({ type: "fatal", message });
}

// ---------------------------------------------------------------------------
// Kernel modules (compiled)
// ---------------------------------------------------------------------------

let kernel;
try {
  const [
    { createSessionRunner },
    { createLogTailEventSource },
    { readSessionDir, readSessionSnapshot },
    { resolveHarnessHome },
    { loadProviders, resolveModelRef },
    { readSessionHeader },
    { isValidSessionId },
    protocol,
  ] = await Promise.all([
    import(dist("server/runner.js")),
    import(dist("events/log-tail.js")),
    import(dist("session/persistence.js")),
    import(dist("config/harness-home.js")),
    import(dist("config/providers.js")),
    import(dist("server/api.js")),
    import(dist("session/handle.js")),
    import("../renderer/protocol.js"),
  ]);
  kernel = {
    createSessionRunner,
    createLogTailEventSource,
    readSessionDir,
    readSessionSnapshot,
    resolveHarnessHome,
    loadProviders,
    resolveModelRef,
    readSessionHeader,
    isValidSessionId,
    protocol,
  };
} catch (error) {
  fatal(
    `内核未构建：${error instanceof Error ? error.message : String(error)}。请先在仓库根目录运行 npm run build。`,
  );
  process.exit(1);
}

// `hello` is emitted before stdin is read: the renderer uses it to move its
// status line from "starting" to "connecting".
send({ type: "hello" });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const harnessHome = kernel.resolveHarnessHome();
const sessionsRoot = path.join(harnessHome, "sessions");

let runner;
let eventSource;
let providers = {};
let modelRef = "";
let modelList = [];
let cwd = process.cwd();
let locale = "zh";
let mode = "diagnose";
let sessionId = "";
let running = false;
/** The protocol context for the open session; replaced on every new run. */
let ctx = kernel.protocol.createContext();
/** Stream handle for the live run. */
let followAbort;
/** Resolves when the pump ends; kept so tests can await a turn. */
let followTask;

const sessions = (() => {
  return {
    list() {
      const out = [];
      let entries = [];
      try {
        entries = readdirSync(sessionsRoot, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !kernel.isValidSessionId(entry.name)) continue;
        const dir = path.join(sessionsRoot, entry.name);
        try {
          const header = kernel.readSessionHeader(dir);
          out.push({
            id: entry.name,
            createdAt: header.createdAt,
            status: header.status,
            ...(header.model === undefined ? {} : { model: header.model }),
            ...(header.workdir === undefined ? {} : { workdir: header.workdir }),
          });
        } catch {
          // A corrupt or unreadable directory is skipped rather than shown as
          // an empty conversation; the renderer gets fewer rows, not fake ones.
        }
      }
      out.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return out;
    },
    detail(id) {
      return kernel.readSessionDir(path.join(sessionsRoot, id));
    },
    /**
     * Read a session whose log may end mid-line.
     *
     * A run killed between `write` and `fsync` leaves a partial last line. The
     * HTTP API tolerates it for open sessions (`allowTrailingPartial`); the
     * desktop host used the strict reader, so the same session opened in the
     * browser and refused to open here.
     */
    async detailTolerant(id) {
      const dir = path.join(sessionsRoot, id);
      const header = kernel.readSessionHeader(dir);
      const snapshot = await kernel.readSessionSnapshot(dir, { allowTrailingPartial: true });
      return { header, events: snapshot.events };
    },
    titleOf(id) {
      try {
        const { events } = sessions.detail(id);
        for (const event of events) {
          if (event.type !== "user") continue;
          const content = event.payload?.content;
          if (typeof content !== "string" || content.trim() === "") continue;
          const trimmed = content.trim();
          return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
        }
      } catch {
        // Fall through to the id.
      }
      return id;
    },
  };
})();

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function buildModelList(config) {
  const out = [];
  for (const [providerName, provider] of Object.entries(config)) {
    for (const [modelName, model] of Object.entries(provider.models ?? {})) {
      out.push({
        id: `${providerName}/${modelName}`,
        name: modelName,
        contextLength: model.contextWindow,
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
      });
    }
  }
  return out;
}

function baseUrlOf(ref) {
  try {
    return kernel.resolveModelRef(providers, ref).provider.baseUrl;
  } catch {
    return "";
  }
}

function stateEvent() {
  return kernel.protocol.initialState({
    sessionId,
    cwd,
    locale,
    mode,
    model: modelRef,
    models: modelList,
    modelsSource: "providers.json",
    baseUrl: baseUrlOf(modelRef),
  });
}

/**
 * Build the runner for the current mode.
 *
 * The preset is fixed when the runner is constructed: the kernel reads
 * `permissions.preset` on every run it starts. Changing the mode therefore
 * rebuilds the runner, and that is only allowed while no turn is in flight so
 * no live run changes policy under the operator.
 */
function createRunner() {
  return kernel.createSessionRunner({
    harnessHome,
    ...(modelRef === "" ? {} : { model: modelRef }),
    cwd,
    permissions: { preset: mode },
  });
}

/**
 * Derived titles, keyed by `id@createdAt`.
 *
 * The kernel header has no title field, so the first user message stands in
 * for one. Reading a log per row on every list would stall the sidebar on a
 * large home; the cache makes each session pay that cost once.
 */
const titleCache = new Map();
const TITLE_SCAN_LIMIT = 30;

function titleFor(entry) {
  const key = `${entry.id}@${entry.createdAt}`;
  const cached = titleCache.get(key);
  if (cached !== undefined) return cached;
  const title = sessions.titleOf(entry.id);
  titleCache.set(key, title === entry.id ? "" : title);
  return title === entry.id ? "" : title;
}

function sessionsEvent() {
  const all = sessions.list();
  let scanned = 0;
  const list = all.map((entry) => {
    const alreadyCached = titleCache.has(`${entry.id}@${entry.createdAt}`);
    const title = alreadyCached || scanned < TITLE_SCAN_LIMIT ? titleFor(entry) : "";
    if (!alreadyCached) scanned += 1;
    return { ...entry, title };
  });
  const event = kernel.protocol.sessionsEvent(list);
  event.sessions = event.sessions.map((session) => ({
    ...session,
    status: session.id === sessionId && running ? "working" : "ready",
  }));
  return event;
}

// ---------------------------------------------------------------------------
// Event pump
// ---------------------------------------------------------------------------

function stopFollow() {
  if (followAbort !== undefined) {
    followAbort.abort();
    followAbort = undefined;
  }
  followTask = undefined;
}

/**
 * Deliver every event newer than `since` and then keep following.
 *
 * The kernel's `follow` returns when the session header flips to `closed`,
 * which happens at the end of every run — that return is this host's "turn
 * finished" signal when the log does not carry an explicit `status`.
 */
function startFollow(id, since) {
  stopFollow();
  followAbort = new AbortController();
  const signal = followAbort.signal;
  const task = (async () => {
    try {
      const reader = eventSource.follow(id, since, signal);
      for await (const event of reader) {
        if (signal.aborted) return;
        for (const message of kernel.protocol.sessionEventToHostEvents(event, ctx)) {
          send(message);
        }
      }
      if (signal.aborted) return;
      // Stream ended without an explicit run_end (a crash or an aborted run
      // whose status event never landed). Close the turn honestly.
      if (ctx.running) {
        ctx.running = false;
        running = false;
        send({ type: "run_end" });
      }
      send(sessionsEvent());
    } catch (error) {
      if (signal.aborted) return;
      send({
        type: "notice",
        level: "warn",
        text: `事件流中断：${error instanceof Error ? error.message : String(error)}`,
      });
      if (ctx.running) {
        ctx.running = false;
        running = false;
        send({ type: "run_end" });
      }
    }
  })();
  followTask = task;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function handlePrompt(text) {
  if (typeof text !== "string" || text.trim() === "") {
    send({ type: "error", message: "消息不能为空" });
    return;
  }
  if (ctx.running) {
    // The kernel refuses a second concurrent run (`session_busy`); say so
    // before posting instead of surfacing a 409 as a send failure.
    send({ type: "notice", level: "warn", text: "当前回合尚未结束，请先停止或等待" });
    return;
  }

  let since = -1;
  if (sessionId !== "") {
    try {
      const snapshot = await eventSource.read(sessionId, -1);
      since = snapshot.headSeq;
    } catch {
      since = -1;
    }
  }

  ctx = kernel.protocol.createContext({ sessionId, cwd });
  ctx.running = true;
  running = true;
  send({ type: "run_start" });

  let outcome;
  try {
    outcome = await runner.start({
      text,
      ...(sessionId === "" ? {} : { sessionId }),
    });
  } catch (error) {
    running = false;
    ctx.running = false;
    send({ type: "error", message: `发送失败：${error instanceof Error ? error.message : String(error)}` });
    send({ type: "run_end" });
    return;
  }

  const created = outcome.created;
  if (created || outcome.sessionId !== sessionId) {
    sessionId = outcome.sessionId;
    // No `session_loaded`: the renderer already echoed the user's message.
    // Only switching to another session rebuilds the transcript.
    send(stateEvent());
  }
  // The follow must start after `start` so a brand-new log exists; `since`
  // was captured before it, so the first events of this run are included.
  startFollow(sessionId, since);
  send(sessionsEvent());
}

function handleAbort() {
  if (sessionId === "" || !runner.abort(sessionId)) {
    send({ type: "notice", level: "dim", text: "没有正在运行的会话" });
    return;
  }
  // The kernel appends `interrupted` and closes the session; the pump will
  // deliver both and emit run_end. Nothing else to send here.
}

function handleNewSession() {
  if (ctx.running) {
    send({ type: "notice", level: "warn", text: "当前回合尚未结束，请先停止或等待" });
    return;
  }
  stopFollow();
  sessionId = "";
  ctx = kernel.protocol.createContext({ cwd });
  send({ type: "session_loaded", messages: [], cwd, mode, effort: "auto" });
  send(stateEvent());
  send(sessionsEvent());
}

async function handleLoadSession(id) {
  if (ctx.running) {
    send({ type: "notice", level: "warn", text: "当前回合尚未结束，请先停止或等待" });
    return;
  }
  if (typeof id !== "string" || !kernel.isValidSessionId(id)) {
    send({ type: "error", message: `非法的会话 id: ${String(id)}` });
    return;
  }
  stopFollow();
  let detail;
  try {
    detail = await sessions.detailTolerant(id);
  } catch (error) {
    send({ type: "error", message: `会话打开失败：${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  sessionId = id;
  running = false;
  ctx = kernel.protocol.createContext({ sessionId: id, cwd });
  const lastSeq = detail.events.at(-1)?.seq ?? -1;
  ctx.lastSeq = lastSeq;
  send(
    kernel.protocol.sessionLoadedEvent(detail.events, {
      cwd: detail.header.workdir ?? cwd,
      mode,
    }),
  );
  send(stateEvent());
  // No follow: the session is closed, so following would end immediately.
  // The next prompt resumes it and starts a fresh pump.
}

function handlePermission(id, answer) {
  if (sessionId === "") {
    send({ type: "notice", level: "warn", text: "没有可审批的会话" });
    return;
  }
  const decision = answer === "no" ? "deny" : "allow";
  void runner.decide(sessionId, String(id), decision).then((outcome) => {
    if (outcome.kind === "unknown_session" || outcome.kind === "unknown_request") {
      send({ type: "notice", level: "warn", text: "审批请求不存在或已失效" });
      send({ type: "permission_closed", id });
      return;
    }
    if (outcome.kind === "expired") {
      send({ type: "notice", level: "warn", text: "审批请求已过期" });
      send({ type: "permission_closed", id });
      return;
    }
    if (answer === "always") {
      send({
        type: "notice",
        level: "dim",
        text: "内核只按单次请求审批；“始终允许”本次生效，不会持久化",
      });
    }
  });
}

/**
 * Commands this host implements. Everything else answers with a warning:
 * the renderer hides those controls, but a stale client or a keyboard
 * shortcut must not look like it worked.
 */
const handlers = {
  init(payload) {
    if (typeof payload.cwd === "string" && payload.cwd !== "" && existsSync(payload.cwd)) {
      cwd = path.resolve(payload.cwd);
    }
    if (payload.locale === "en" || payload.locale === "zh") locale = payload.locale;
    if (typeof payload.mode === "string") mode = payload.mode;

    try {
      providers = kernel.loadProviders(harnessHome);
    } catch (error) {
      fatal(`providers 不可用：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    modelList = buildModelList(providers);
    const first = modelList[0]?.id;
    const envModel = process.env.HARNESS_WEB_MODEL?.trim();
    modelRef = envModel !== undefined && envModel !== "" ? envModel : (first ?? "");
    try {
      kernel.resolveModelRef(providers, modelRef);
    } catch {
      modelRef = first ?? "";
    }

    runner = createRunner();
    eventSource = kernel.createLogTailEventSource({ sessionsRoot });
    send(stateEvent());
    send({ type: "ready" });
    send(sessionsEvent());
    send({ type: "commands", commands: [] });
    send({ type: "setup_checklist", checks: [] });
    send({ type: "locale", locale });
  },

  prompt(payload) {
    return handlePrompt(payload.text);
  },

  abort() {
    if (runner === undefined) return;
    handleAbort();
  },

  permission(payload) {
    if (runner === undefined) return;
    handlePermission(payload.id, payload.answer);
  },

  newSession() {
    if (runner === undefined) return;
    handleNewSession();
  },

  loadSession(payload) {
    if (runner === undefined) return;
    return handleLoadSession(payload.id);
  },

  listSessions() {
    send(sessionsEvent());
  },

  setMode(payload) {
    const presets = ["read-only", "workspace-write", "diagnose", "danger-full-access"];
    if (!presets.includes(payload.mode)) return;
    if (ctx.running) {
      // Changing the preset mid-run would change what the operator approved.
      send({ type: "notice", level: "warn", text: "运行中不能切换权限模式" });
      return;
    }
    mode = payload.mode;
    // Rebuild so the next run starts under the new preset.
    void runner?.close();
    runner = createRunner();
    send(stateEvent());
  },

  /**
   * Pick the model for the next run.
   *
   * Only references that exist in `providers.json` are accepted: the runner
   * resolves the reference itself and a typo would surface as a failed turn
   * rather than a rejected choice. The current session keeps its model (the
   * kernel refuses to resume under a different one), so this takes effect on
   * the next new conversation and the notice says so.
   */
  setModel(payload) {
    const wanted = typeof payload.model === "string" ? payload.model : "";
    try {
      kernel.resolveModelRef(providers, wanted);
    } catch {
      send({ type: "notice", level: "warn", text: `模型不在 providers.json 中：${wanted}` });
      return;
    }
    if (ctx.running) {
      send({ type: "notice", level: "warn", text: "运行中不能切换模型" });
      return;
    }
    modelRef = wanted;
    void runner?.close();
    runner = createRunner();
    send(stateEvent());
    if (sessionId !== "") {
      send({
        type: "notice",
        level: "dim",
        text: "模型仅对新建会话生效；当前会话沿用启动时的模型",
      });
    }
  },

  /**
   * Re-read `providers.json`.
   *
   * The file is the source of truth and is edited by hand, so a reload is the
   * only way an edited model list reaches the picker. A broken file leaves the
   * loaded list alone rather than emptying the picker.
   */
  refreshModels() {
    let next;
    try {
      next = kernel.loadProviders(harnessHome);
    } catch (error) {
      send({
        type: "notice",
        level: "warn",
        text: `providers.json 读取失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    providers = next;
    modelList = buildModelList(providers);
    const stillValid = modelList.some((model) => model.id === modelRef);
    if (!stillValid) modelRef = modelList[0]?.id ?? "";
    send({ type: "models", models: modelList, model: modelRef, source: "providers.json" });
    send(stateEvent());
  },

  /**
   * Change the working directory for the next conversation.
   *
   * The kernel fixes a session's workdir in its header and refuses to resume
   * under another one, so this only affects a session that is about to be
   * created — the renderer calls it from the sidebar's "new session in this
   * project" control.
   */
  setCwd(payload) {
    const next = typeof payload.cwd === "string" ? payload.cwd : "";
    if (next === "" || !existsSync(next)) {
      send({ type: "notice", level: "warn", text: `目录不存在：${next}` });
      return;
    }
    if (ctx.running) {
      send({ type: "notice", level: "warn", text: "运行中不能切换工作目录" });
      return;
    }
    if (sessionId !== "") {
      send({
        type: "notice",
        level: "dim",
        text: "工作目录仅对新建会话生效；先新建会话再继续",
      });
      return;
    }
    cwd = path.resolve(next);
    ctx = kernel.protocol.createContext({ cwd });
    void runner?.close();
    runner = createRunner();
    send(stateEvent());
  },

  setLocale(payload) {
    if (payload.locale !== "en" && payload.locale !== "zh") return;
    locale = payload.locale;
    send({ type: "locale", locale });
    send(stateEvent());
  },

  setUiPreference(payload) {
    send({ type: "ui_preference", key: payload.key, value: payload.value });
  },

  /**
   * The values this host owns.
   *
   * Display preferences are the renderer's: it keeps them in localStorage and
   * has no way to push them here. Sending placeholders for them (`theme:
   * "dark"`, `fontScale: 1`) made opening Settings reset whatever the user had
   * chosen, so the fields are simply absent — the renderer only applies what it
   * receives.
   */
  getSettings() {
    send({
      type: "settings",
      settings: {
        locale,
        providers: Object.keys(providers).map((name) => ({
          id: name,
          baseUrl: providers[name]?.baseUrl ?? "",
        })),
        models: modelList,
        model: modelRef,
      },
    });
  },

  getUsage() {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    if (sessionId !== "") {
      try {
        for (const event of sessions.detail(sessionId).events) {
          if (event.type !== "usage") continue;
          inputTokens += Number(event.payload?.promptTokens) || 0;
          outputTokens += Number(event.payload?.completionTokens) || 0;
          cachedTokens += Number(event.payload?.cachedTokens) || 0;
        }
      } catch {
        // An unreadable session reports zeros rather than a made-up total.
      }
    }
    send({
      type: "usage_summary",
      days: 0,
      summary: { inputTokens, outputTokens, cachedTokens },
    });
  },

  getSetupChecklist() {
    const checks = [
      {
        label: "providers.json",
        detail: path.join(harnessHome, "providers.json"),
        ok: Object.keys(providers).length > 0,
      },
      {
        label: "模型引用",
        detail: modelRef === "" ? "没有可用模型" : modelRef,
        ok: modelRef !== "",
      },
    ];
    send({ type: "setup_checklist", checks });
  },

  listCommands() {
    send({ type: "commands", commands: [] });
  },

  getTree(payload) {
    // No file-tree API in the kernel. Answering with an empty tree keeps the
    // workbench from hanging; the pane that would show it is hidden.
    void payload;
    send({ type: "tree", nodes: [] });
  },

  searchFiles(payload) {
    send({ type: "file_matches", query: String(payload.query ?? ""), files: [] });
  },

  /**
   * Search saved conversations by what the sidebar shows.
   *
   * Matching the UUID alone made this useless: session ids are generated, so a
   * title the user remembers could never match. Title, workdir and id are all
   * searched, and the reply uses the same row shape as `sessions` so the
   * renderer can draw results with the component it already has.
   */
  searchSessions(payload) {
    const query = String(payload.query ?? "").trim().toLowerCase();
    const matches =
      query === ""
        ? []
        : sessions.list().filter((entry) => {
            const title = titleFor(entry);
            return (
              entry.id.toLowerCase().includes(query)
              || (title !== "" && title.toLowerCase().includes(query))
              || String(entry.workdir ?? "").toLowerCase().includes(query)
            );
          });
    const event = kernel.protocol.sessionsEvent(
      matches.map((entry) => ({ ...entry, title: titleFor(entry) })),
    );
    event.query = query;
    send({ ...event, type: "session_matches" });
  },

  shutdown() {
    stopFollow();
    void runner?.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  },
};

// ---------------------------------------------------------------------------
// NDJSON loop
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    send({ type: "notice", level: "warn", text: "宿主收到无法解析的指令" });
    return;
  }
  if (typeof payload !== "object" || payload === null || typeof payload.cmd !== "string") {
    send({ type: "notice", level: "warn", text: "宿主收到的指令缺少 cmd" });
    return;
  }
  const handler = handlers[payload.cmd];
  if (handler === undefined) {
    send({
      type: "notice",
      level: "warn",
      text: `桌面宿主暂不支持该命令：${payload.cmd}`,
    });
    return;
  }
  try {
    const result = handler(payload);
    if (result instanceof Promise) {
      result.catch((error) => {
        send({
          type: "error",
          message: `${payload.cmd} 失败：${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
  } catch (error) {
    send({
      type: "error",
      message: `${payload.cmd} 失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

rl.on("close", () => {
  stopFollow();
  void runner?.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

process.on("uncaughtException", (error) => {
  send({ type: "error", message: `宿主异常：${error.message}` });
  process.exit(1);
});
