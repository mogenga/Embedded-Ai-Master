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

import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
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

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
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
    { readSessionMeta },
    {
      readAppConfig,
      readProviders,
      writeMcpServers,
      writePermissionConfig,
      writeProviders,
      writeRunLimits,
    },
    { createSessionAdmin },
    filesApi,
    protocol,
  ] = await Promise.all([
    import(dist("server/runner.js")),
    import(dist("events/log-tail.js")),
    import(dist("session/persistence.js")),
    import(dist("config/harness-home.js")),
    import(dist("config/providers.js")),
    import(dist("server/api.js")),
    import(dist("session/handle.js")),
    import(dist("session/metadata.js")),
    import(dist("config/app-config.js")),
    import(dist("server/session-admin.js")),
    // Namespace, not destructured names: `listDirectory` / `registerWorkspaceRoot`
    // are newer exports, and a stale `dist/` must not take the whole host down
    // at import time — the handlers report the gap instead.
    import(dist("server/files-api.js")),
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
    readSessionMeta,
    readAppConfig,
    readProviders,
    writeMcpServers,
    writePermissionConfig,
    writeProviders,
    writeRunLimits,
    createSessionAdmin,
    filesApi,
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
/**
 * Where `providers.json` lives, and why it could not be read.
 *
 * Kept beside the loaded object so the settings page can show the path even
 * when the file is missing or broken — that is exactly when the user needs it.
 */
let providersPath = path.join(harnessHome, "providers.json");
let providersError = "";
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
          // A title is operator data kept beside the session, not in the
          // kernel's header: `validateHeader` drops fields it does not know,
          // so writing one there would be silently discarded on the next read.
          const meta = kernel.readSessionMeta(dir);
          out.push({
            id: entry.name,
            createdAt: header.createdAt,
            updatedAt: meta.updatedAt,
            status: header.status,
            ...(header.model === undefined ? {} : { model: header.model }),
            ...(header.workdir === undefined ? {} : { workdir: header.workdir }),
            ...(meta.title === undefined ? {} : { title: meta.title }),
            ...(meta.pinned === undefined ? {} : { pinned: meta.pinned }),
            ...(meta.archived === undefined ? {} : { archived: meta.archived }),
          });
        } catch {
          // A corrupt or unreadable directory is skipped rather than shown as
          // an empty conversation; the renderer gets fewer rows, not fake ones.
        }
      }
      // A renamed or pinned session is newer than a session created after it
      // but never touched; sorting by creation alone buried exactly the
      // conversations the operator had just worked in.
      const stamp = (entry) => entry.updatedAt ?? entry.createdAt;
      out.sort((left, right) => stamp(right).localeCompare(stamp(left)));
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

/** Saved run limits, re-read whenever the settings save handler runs. */
let runLimits = { maxTurns: 10, maxCostUsd: null, timeoutMs: null, systemPrompt: "" };

/**
 * The limits to hand this run.
 *
 * `null` means "not set", not "zero": sending `maxCostUsd: null` would fail
 * the runner's number check, and sending 0 would stop the loop before its
 * first turn. Unset fields are omitted so the kernel defaults apply.
 */
function runLimitOptions() {
  return {
    ...(runLimits.maxTurns === 10 ? {} : { maxTurns: runLimits.maxTurns }),
    ...(runLimits.maxCostUsd === null ? {} : { maxCostUsd: runLimits.maxCostUsd }),
    ...(runLimits.timeoutMs === null ? {} : { timeoutMs: runLimits.timeoutMs }),
    ...(runLimits.systemPrompt === "" ? {} : { systemPrompt: runLimits.systemPrompt }),
  };
}

/**
 * Read both config files and describe them for the renderer.
 *
 * A broken file is reported in `errors` rather than thrown: the settings page
 * must still open so the user can see (and fix) the other half. The kernel
 * itself refuses to start a run under a broken permissions file, so this is a
 * display concern only.
 */
function readConfigSnapshot() {
  try {
    return { config: kernel.readAppConfig(harnessHome), error: undefined };
  } catch (error) {
    return {
      config: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function configEvent() {
  const { config, error } = readConfigSnapshot();
  const base = {
    type: "settings",
    settings: {
      locale,
      // The picker's list: one row per provider, with the URL it points at.
      providers: Object.keys(providers).map((name) => ({
        id: name,
        baseUrl: providers[name]?.baseUrl ?? "",
      })),
      // The raw file, editable on the settings page. Named `providerConfig`
      // because `providers` above is already the picker's flat list: the two
      // shapes are different and one must not overwrite the other.
      providerConfig: config?.providers ?? providers,
      providersError: config?.providersError ?? (providersError === "" ? undefined : providersError),
      models: modelList,
      model: modelRef,
    },
  };
  if (config === undefined) {
    send({
      ...base,
      settingsError: error,
      settings: { ...base.settings, configPaths: { providers: providersPath } },
    });
    return;
  }
  send({
    ...base,
    settings: {
      ...base.settings,
      mcpServers: config.mcpServers,
      permissions: config.permissions,
      run: config.run,
      configPaths: {
        mcp: config.mcpPath,
        permissions: config.permissionsPath,
        run: config.runPath,
        providers: config.providersPath ?? providersPath,
      },
    },
  });
}

/**
 * Occupancy and spend as of the last priced call in a log.
 *
 * `state` is sent on boot and on every session switch; without these figures
 * the meter drops back to zero each time a conversation is reopened, even
 * though its transcript is full.
 */
function lastMeasure(events) {
  let context;
  let costUsd;
  for (const event of events) {
    if (event?.type !== "usage" || typeof event.payload !== "object" || event.payload === null) continue;
    const payload = event.payload;
    if (typeof payload.context === "object" && payload.context !== null) {
      context = payload.context;
    }
    if (typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd)) {
      costUsd = payload.costUsd;
    }
  }
  return {
    ...(context === undefined ? {} : { context }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

let lastSessionId = "";
let lastSessionMeasure = {};

function stateEvent() {
  // The cached measure belongs to the session that produced it; showing it
  // over a different conversation would be a fabricated number.
  const extra = sessionId !== "" && sessionId === lastSessionId ? lastSessionMeasure : {};
  return kernel.protocol.initialState({
    sessionId,
    cwd,
    locale,
    mode,
    model: modelRef,
    models: modelList,
    modelsSource: "providers.json",
    baseUrl: baseUrlOf(modelRef),
    ...extra,
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
 * Make one folder browsable by the file tree.
 *
 * Registration widens the read boundary, so a failure has to be reportable;
 * the boot call site ignores the outcome because the tree request itself
 * will carry the reason, and there is no click to answer at launch.
 */
async function registerRoot(target) {
  const register = kernel.filesApi?.registerWorkspaceRoot;
  if (typeof register !== "function") {
    throw new Error("内核未导出 registerWorkspaceRoot，请重新执行 npm run build");
  }
  return register(target);
}

/**
 * The boot workspace's registration, until the first command that needs it.
 *
 * `init` cannot await without delaying `ready`; a `getTree` that arrives
 * before the registration lands would be refused for the folder the window
 * opened in. Awaiting the same promise here closes that gap without making the
 * handshake wait on the filesystem.
 */
let pendingRoot = Promise.resolve(false);

async function settleRoot() {
  try {
    await pendingRoot;
  } catch {
    // A failed registration is reported by the listing itself.
  }
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
  // A name the operator gave is the title; the first user message is only a
  // stand-in for a session nobody renamed.
  if (typeof entry.title === "string" && entry.title !== "") return entry.title;
  const key = `${entry.id}@${entry.createdAt}`;
  const cached = titleCache.get(key);
  if (cached !== undefined) return cached;
  const title = sessions.titleOf(entry.id);
  titleCache.set(key, title === entry.id ? "" : title);
  return title === entry.id ? "" : title;
}

/** Rows per page when the renderer does not ask for a specific page size. */
const DEFAULT_SESSION_LIMIT = 80;

/**
 * The filter the renderer last asked for.
 *
 * Every command that changes a session pushes a fresh list (`sessionFlags`,
 * `deleteSession`, `forkSession`, the end of a turn). Those pushes reuse this
 * filter: otherwise archiving a row would answer with a list that still
 * contains it, and the archive button would look like it did nothing.
 */
let sessionListQuery = { includeArchived: false, limit: DEFAULT_SESSION_LIMIT };

/**
 * One spelling per workspace, for comparison only.
 *
 * Windows paths are case-insensitive and get written with either separator,
 * so `G:\proj` and `g:/proj/` name the same folder and must filter as one.
 */
function normalizeWorkdir(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Apply the renderer's filter to the full list, before paging. */
function filterSessions(all, query) {
  let rows = all;
  if (query.includeArchived !== true) {
    rows = rows.filter((entry) => entry.archived !== true);
  }
  if (typeof query.cwd === "string" && query.cwd !== "") {
    const wanted = normalizeWorkdir(query.cwd);
    rows = rows.filter((entry) => normalizeWorkdir(entry.workdir) === wanted);
  }
  if (query.status === "working") {
    rows = rows.filter((entry) => entry.id === sessionId && running);
  }
  return rows;
}

function sessionsEvent(query = sessionListQuery) {
  const all = sessions.list();
  // `sessions.list()` is already newest-first (`updatedAt ?? createdAt`), so
  // paging is stable: the same limit returns the same rows while nothing new
  // arrives.
  const filtered = filterSessions(all, query);
  const total = filtered.length;
  const limit =
    Number.isSafeInteger(query.limit) && query.limit > 0 ? query.limit : DEFAULT_SESSION_LIMIT;
  const page = filtered.slice(0, limit);
  let scanned = 0;
  const list = page.map((entry) => {
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
  // The protocol counts the rows it was handed; the sidebar needs the size of
  // the whole filtered set to know whether "load more" still applies.
  event.total = total;
  event.all = total;
  event.limit = limit;
  return event;
}

// ---------------------------------------------------------------------------
// Read-only file access
// ---------------------------------------------------------------------------

/** Files larger than this are cut, never loaded whole. */
const MAX_PREVIEW_BYTES = 256 * 1024;
/** How much of a file is inspected for a NUL byte before calling it binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Case-fold a resolved path for comparison; Windows does not distinguish. */
function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `target` is `root` or lives underneath it. */
function isInside(root, target) {
  const parent = pathKey(root);
  const child = pathKey(target);
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

/**
 * The roots a preview may read from.
 *
 * The workspace and the open session's own directory: a session's artifacts
 * and log live beside it, and the operator pointing a preview at their own
 * project is the whole purpose. Anything else is refused rather than read and
 * hidden afterwards.
 */
function allowedReadRoots() {
  const roots = [cwd];
  if (sessionId !== "") roots.push(path.join(sessionsRoot, sessionId));
  return roots;
}

/**
 * Where a requested path would land, with symlinks resolved.
 *
 * The target may not exist (that is a different notice), so the deepest
 * existing ancestor is resolved instead and the rest is re-appended. Without
 * this, a symlinked parent directory would let a path pass the prefix check
 * while the actual file sat outside every allowed root.
 */
function resolveForCheck(target) {
  const absolute = path.resolve(target);
  const rest = [];
  let current = absolute;
  for (;;) {
    if (existsSync(current)) {
      const base = realpathSync(current);
      return rest.length === 0 ? base : path.join(base, ...rest.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    rest.push(path.basename(current));
    current = parent;
  }
}

/** True when the path, once resolved, is inside one of the allowed roots. */
function isAllowedPath(target) {
  const resolved = resolveForCheck(target);
  return allowedReadRoots().some((root) => isInside(root, resolved));
}

/**
 * Read at most `maxBytes` of a regular file, and say whether it was cut.
 *
 * The descriptor is opened read-only and closed in `finally` so a refused or
 * oversized file leaves nothing behind. `readSync` is bounded by the file's
 * own size, which `lstat` already reported.
 */
function readBounded(absolute, maxBytes) {
  const fd = openSync(absolute, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** A NUL byte in the first 8 KiB means "not text"; the rest is not read. */
function looksBinary(buffer) {
  const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES);
  return sniff.includes(0);
}

/**
 * Answer a read request with one of the renderer's file/artifact shapes.
 *
 * Every failure path is a notice: a pane that shows nothing looks exactly like
 * an empty file, so a refused or unreadable path has to say why (R3).
 */
function readPreview(absolute, requested, kind) {
  let stat;
  try {
    // `lstat`, then `realpath`: a symlink is not the file the operator thinks
    // they are reading, and its target may sit outside the allowed roots.
    stat = lstatSync(absolute);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    const reason = code === "ENOENT" ? "文件不存在" : `无法读取：${messageOf(error)}`;
    send({ type: "notice", level: "warn", text: `${reason}：${requested}` });
    return;
  }
  if (stat.isSymbolicLink()) {
    send({ type: "notice", level: "warn", text: `不读取符号链接：${requested}` });
    return;
  }
  if (!stat.isFile()) {
    send({ type: "notice", level: "warn", text: `不是普通文件：${requested}` });
    return;
  }
  let buffer;
  try {
    buffer = readBounded(absolute, Math.min(stat.size, MAX_PREVIEW_BYTES));
  } catch (error) {
    send({ type: "notice", level: "warn", text: `读取失败：${messageOf(error)}` });
    return;
  }
  const truncated = stat.size > MAX_PREVIEW_BYTES;
  const binary = looksBinary(buffer);
  const content = binary ? "" : buffer.toString("utf8");
  if (kind === "file") {
    send({ type: "file", file: { path: requested, content, truncated, binary } });
    return;
  }
  // Artifacts are the kernel's own text output; a NUL byte there means the
  // file is not what the manifest said, so the caller is told rather than
  // handed an empty artifact that renders as "no content".
  if (binary) {
    send({ type: "notice", level: "warn", text: `产物不是文本文件：${requested}` });
    return;
  }
  send({
    type: "artifact",
    artifact: { path: requested, kind: "text", content, truncated },
  });
}

/** Extension → artifact kind. The kernel only writes `.txt`; the other text
 *  extensions cover a file the operator dropped in by hand. */
const ARTIFACT_KINDS = new Map([
  [".txt", "text"],
  [".log", "text"],
  [".json", "text"],
  [".md", "text"],
]);

/** The current session's artifact directory, or "" when none is open. */
function artifactsDirOf() {
  if (sessionId === "") return "";
  return path.join(sessionsRoot, sessionId, "artifacts");
}

/**
 * Ordinary files in the current session's artifact directory.
 *
 * A missing directory (no artifacts yet, or no session) is an empty list, not
 * an error: the sidebar is meant to be empty until the first artifact lands.
 */
function listArtifacts() {
  const dir = artifactsDirOf();
  if (dir === "") return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue;
    }
    // `lstat().isFile()` is false for a symlink even when it resolves to a
    // file, which is exactly the exclusion wanted here.
    if (!stat.isFile()) continue;
    out.push({
      path: absolute,
      name: entry.name,
      kind: ARTIFACT_KINDS.get(path.extname(entry.name).toLowerCase()) ?? "unknown",
      size: stat.size,
    });
  }
  // Newest names last in the kernel's `<callId>-<n>.txt` scheme, so a plain
  // name sort is stable and predictable without touching mtimes.
  out.sort((left, right) => left.name.localeCompare(right.name));
  return out;
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
        // Keep the cached measure current: a later `state` (a settings change,
        // a session switch back) reads it rather than the log.
        if (event.type === "usage" && typeof event.payload === "object" && event.payload !== null) {
          if (typeof event.payload.context === "object" && event.payload.context !== null) {
            lastSessionMeasure = { ...lastSessionMeasure, context: event.payload.context };
          }
          if (typeof event.payload.costUsd === "number" && Number.isFinite(event.payload.costUsd)) {
            lastSessionMeasure = { ...lastSessionMeasure, costUsd: event.payload.costUsd };
          }
        }
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
      // A new session records this as its workdir. A resumed one keeps the
      // header's own, so the value is harmless there — the kernel ignores it
      // when `sessionId` is set. An empty cwd is omitted rather than sent as
      // "": the runner would resolve it against the host's own directory.
      ...(cwd === "" ? {} : { cwd }),
      ...runLimitOptions(),
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
    lastSessionId = sessionId;
    lastSessionMeasure = {};
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
  lastSessionId = "";
  lastSessionMeasure = {};
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
  lastSessionId = id;
  lastSessionMeasure = lastMeasure(detail.events);
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

    // A broken or missing providers file must not kill the boot sequence: the
    // operator fixes it on the settings page, and that page needs `state`,
    // `ready` and the rest of the handshake to come up at all. Boot with an
    // empty model list, say so, and keep going.
    providers = {};
    modelList = [];
    providersError = "";
    let missing = false;
    try {
      providers = kernel.loadProviders(harnessHome);
    } catch (error) {
      providersError = messageOf(error);
      // `providers_not_found` is "not configured yet", not a fault: it gets a
      // dim pointer to the settings page instead of a fatal banner.
      missing = error instanceof Error && error.code === "providers_not_found";
      if (!missing) fatal(`providers 不可用：${providersError}`);
    }
    if (typeof kernel.readProviders === "function") {
      try {
        providersPath = kernel.readProviders(harnessHome).providersPath;
      } catch {
        // The path is display-only; the default beside `harnessHome` stands.
      }
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
    // Saved run limits apply from the first prompt; a broken file leaves the
    // defaults in place and surfaces on the settings page instead.
    const { config } = readConfigSnapshot();
    if (config !== undefined) runLimits = config.run;
    // The workspace this host opened with is browsable from the first tree
    // request, exactly like one the operator picks later. Without this the
    // files pane greeted every launch with a "refused" notice for the folder
    // the window had just opened in. `init` stays synchronous — the handshake
    // must not wait on the filesystem — so the promise is parked and `getTree`
    // awaits it before listing.
    pendingRoot = cwd === "" ? Promise.resolve(false) : registerRoot(cwd).catch(() => false);
    // Same reason as `providers` above: a config file the app cannot parse is
    // an error the settings page shows, not a reason to refuse to boot.
    if (config?.providersError !== undefined) providersError = config.providersError;
    send(stateEvent());
    send({ type: "ready" });
    send(sessionsEvent());
    send({ type: "commands", commands: [] });
    send({ type: "setup_checklist", checks: [] });
    send({ type: "locale", locale });
    if (missing) {
      send({
        type: "notice",
        level: "dim",
        text: "尚未配置模型服务，请在设置 → 模型服务中填写",
      });
    } else if (providersError !== "") {
      // Already announced through `fatal` above; the settings page repeats it
      // with the path so the user can go and fix the file.
      send({
        type: "notice",
        level: "dim",
        text: `模型服务配置有误：${providersError}。可在设置 → 模型服务中修改`,
      });
    }
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

  /**
   * The sidebar's list: filter, then one page of it.
   *
   * `status` has no reliable source for two of its three values: the host
   * knows which session is running (`working`), but nothing records "waiting
   * for the operator" or "failed" for a saved conversation — the kernel's log
   * does not carry a per-session error state that survives a reload. Rather
   * than guess those two, they are dropped and the renderer is told, so an
   * empty sidebar reads as "not supported" instead of "no matches".
   */
  listSessions(payload = {}) {
    const query = {
      includeArchived: payload.includeArchived === true,
      limit:
        Number.isSafeInteger(payload.limit) && payload.limit > 0
          ? payload.limit
          : DEFAULT_SESSION_LIMIT,
    };
    if (typeof payload.cwd === "string" && payload.cwd !== "") query.cwd = payload.cwd;
    if (payload.status === "working") {
      query.status = "working";
    } else if (payload.status === "needs-input" || payload.status === "error") {
      send({
        type: "notice",
        level: "dim",
        text: `会话筛选“${payload.status}”暂不可用；已显示全部会话`,
      });
    }
    // Remembered, not one-shot: the pushes that follow (a turn ending, a row
    // being archived) must answer with the same filter, or the filter chip in
    // the sidebar would describe a list the host no longer applies.
    sessionListQuery = query;
    send(sessionsEvent(query));
  },

  /**
   * Render the open conversation as Markdown and hand it to the window.
   *
   * The log is the source, not the transcript: a scrolled or partly rebuilt
   * DOM would export what happens to be drawn.
   */
  exportSession() {
    if (sessionId === "") {
      send({ type: "notice", level: "warn", text: "没有可导出的对话" });
      return;
    }
    let events;
    try {
      events = sessions.detail(sessionId).events;
    } catch (error) {
      send({ type: "notice", level: "warn", text: `导出失败：${messageOf(error)}` });
      return;
    }
    const title = titleFor(sessions.list().find((entry) => entry.id === sessionId) ?? { id: sessionId, createdAt: "" });
    send({
      type: "export_ready",
      markdown: kernel.protocol.sessionMarkdown(events, { title }),
      filename: kernel.protocol.sessionExportName(sessionId, title),
    });
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
  async setCwd(payload) {
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
    // Whatever this host runs in is also what the files pane may browse; kept
    // here so `setCwd` and `setWorkspace` cannot disagree about the boundary.
    // A failure is not fatal — the tree request will carry the reason.
    pendingRoot = registerRoot(cwd).catch(() => false);
    await settleRoot();
    send(stateEvent());
  },

  /**
   * Open a folder as the workspace: register it for browsing, then adopt it.
   *
   * Registration and the cwd switch are two different things and both are
   * needed — a folder the tree may list is not necessarily where the next
   * session runs. Delegating the second half to `setCwd` keeps one set of
   * rules (refuse while running, only affects a new session) instead of a
   * second copy that could drift from it.
   */
  async setWorkspace(payload = {}) {
    const wanted = typeof payload.path === "string" ? payload.path.trim() : "";
    if (wanted === "") {
      send({ type: "notice", level: "warn", text: "目录路径为空" });
      return;
    }
    // Refuse before registering: registering a folder the switch will then
    // refuse would widen what the tree can read for no effect.
    if (ctx.running) {
      send({ type: "notice", level: "warn", text: "运行中不能切换工作目录" });
      return;
    }
    let registered;
    try {
      registered = await registerRoot(wanted);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `工作区切换失败：${messageOf(error)}` });
      return;
    }
    // Full `setCwd` semantics, including the "new sessions only" notice and
    // the `state` that carries the new `cwd`. The resolved path the kernel
    // returned is used, not the raw string: `setCwd` resolves again and the
    // two spellings must agree, or the tree would open somewhere the session
    // does not run.
    return handlers.setCwd({
      cwd: typeof registered === "string" && registered !== "" ? registered : wanted,
    });
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
    configEvent();
  },

  /**
   * Write one config file, then answer with a fresh snapshot.
   *
   * A validation error leaves the file alone and comes back as a warning the
   * settings page shows inline; the page never closes on a failed save.
   */
  async saveMcpServer(payload) {
    const { config } = readConfigSnapshot();
    const existing = config?.mcpServers ?? [];
    const wanted = payload.server;
    if (typeof wanted !== "object" || wanted === null) {
      send({ type: "notice", level: "warn", text: "缺少 server 对象" });
      return;
    }
    const name = String(wanted.name ?? "").trim();
    const next = existing.filter((entry) => entry.name !== name);
    next.push({
      name,
      command: String(wanted.command ?? "").trim(),
      ...(String(wanted.args ?? "").trim() === ""
        ? {}
        : { args: String(wanted.args).trim().split(/\s+/) }),
      ...(String(wanted.cwd ?? "").trim() === "" ? {} : { cwd: String(wanted.cwd).trim() }),
      ...(wanted.timeoutMs === undefined || wanted.timeoutMs === null || wanted.timeoutMs === ""
        ? {}
        : { timeoutMs: Number(wanted.timeoutMs) }),
      disabled: wanted.disabled === true,
    });
    try {
      await kernel.writeMcpServers(harnessHome, next);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `MCP 配置未保存：${messageOf(error)}` });
      return;
    }
    configEvent();
  },

  async removeMcpServer(payload) {
    const { config } = readConfigSnapshot();
    const name = String(payload.name ?? "");
    const next = (config?.mcpServers ?? []).filter((entry) => entry.name !== name);
    if (next.length === (config?.mcpServers ?? []).length) {
      send({ type: "notice", level: "warn", text: `没有名为 ${name} 的 MCP server` });
      return;
    }
    try {
      await kernel.writeMcpServers(harnessHome, next);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `MCP 配置未保存：${messageOf(error)}` });
      return;
    }
    configEvent();
  },

  async savePermissions(payload) {
    const wanted = payload.permissions;
    if (typeof wanted !== "object" || wanted === null) {
      send({ type: "notice", level: "warn", text: "缺少 permissions 对象" });
      return;
    }
    try {
      await kernel.writePermissionConfig(harnessHome, wanted);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `权限配置未保存：${messageOf(error)}` });
      return;
    }
    // The preset in the file is not the running preset: this host owns the
    // live mode so the composer's menu stays authoritative.
    configEvent();
    send({
      type: "notice",
      level: "dim",
      text: "权限配置已保存；运行中的模式仍以输入框上方选择为准",
    });
  },

  async saveRunLimits(payload) {
    const wanted = payload.run;
    if (typeof wanted !== "object" || wanted === null) {
      send({ type: "notice", level: "warn", text: "缺少 run 对象" });
      return;
    }
    try {
      runLimits = await kernel.writeRunLimits(harnessHome, wanted);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `运行参数未保存：${messageOf(error)}` });
      return;
    }
    if (ctx.running) {
      send({ type: "notice", level: "dim", text: "运行参数将在下一回合生效" });
    }
    configEvent();
  },

  /**
   * Write the whole `providers.json`.
   *
   * The renderer's settings page edits the file as one object, so this takes
   * the object whole rather than a patch. `writeProviders` validates before it
   * touches disk, which is what keeps an invalid edit from destroying the file
   * the user was trying to fix — the same reason the other writers re-read
   * from disk afterwards instead of trusting what was passed in.
   */
  async saveProviders(payload = {}) {
    const wanted = payload.providers;
    if (typeof wanted !== "object" || wanted === null || Array.isArray(wanted)) {
      send({ type: "notice", level: "warn", text: "缺少 providers 对象" });
      return;
    }
    try {
      await kernel.writeProviders(harnessHome, wanted);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `模型配置未保存：${messageOf(error)}` });
      return;
    }
    // Re-read rather than reuse `wanted`: the file is the source of truth, and
    // a normalization difference between what was sent and what was written
    // must not leave the picker disagreeing with the disk.
    try {
      const loaded = kernel.loadProviders(harnessHome);
      providers = loaded;
      providersError = "";
    } catch (error) {
      providers = {};
      providersError = messageOf(error);
      modelList = [];
      modelRef = "";
      send({ type: "notice", level: "warn", text: `模型配置已写入但无法读回：${providersError}` });
      configEvent();
      return;
    }
    modelList = buildModelList(providers);
    const previousModel = modelRef;
    const stillValid = modelList.some((model) => model.id === modelRef);
    if (!stillValid) modelRef = modelList[0]?.id ?? "";
    // Only the model reference is baked into the runner at construction; the
    // provider itself (`baseUrl`, `apiKeyEnv`) is re-read on every run. So a
    // rebuild is needed exactly when the selected model changed or vanished.
    if (modelRef !== previousModel) {
      void runner?.close();
      runner = createRunner();
      if (ctx.running) {
        send({ type: "notice", level: "dim", text: "模型配置将在下一回合生效" });
      }
    }
    send({ type: "models", models: modelList, model: modelRef, source: "providers.json" });
    send(stateEvent());
    configEvent();
  },

  /**
   * Rename, pin or archive a saved conversation.
   *
   * Renaming the open session is allowed: the title lives beside the log, so
   * the transcript and the header are untouched, and the sidebar redraws from
   * the same list the host just sent.
   */
  async sessionFlags(payload) {
    const id = String(payload.id ?? "");
    if (id === "") return;
    const admin = kernel.createSessionAdmin({ harnessHome });
    try {
      await admin.update(id, {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.pinned !== undefined ? { pinned: payload.pinned === true } : {}),
        ...(payload.archived !== undefined ? { archived: payload.archived === true } : {}),
      });
    } catch (error) {
      send({ type: "notice", level: "warn", text: `会话未更新：${messageOf(error)}` });
      return;
    }
    send(sessionsEvent());
  },

  async deleteSession(payload) {
    const id = String(payload.id ?? "");
    if (id === "") return;
    if (id === sessionId) {
      send({ type: "notice", level: "warn", text: "不能删除当前打开的会话，请先新建会话" });
      return;
    }
    const admin = kernel.createSessionAdmin({ harnessHome });
    try {
      await admin.remove(id);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `会话未删除：${messageOf(error)}` });
      return;
    }
    titleCache.delete(id);
    send(sessionsEvent());
  },

  async forkSession(payload) {
    const id = String(payload.id ?? "");
    if (id === "") return;
    if (ctx.running) {
      send({ type: "notice", level: "warn", text: "当前回合尚未结束，请先停止或等待" });
      return;
    }
    const admin = kernel.createSessionAdmin({ harnessHome });
    let outcome;
    try {
      outcome = await admin.fork(id);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `会话未分叉：${messageOf(error)}` });
      return;
    }
    send(sessionsEvent());
    send({ type: "notice", level: "dim", text: `已从该会话分叉出 ${outcome.sessionId}` });
    return handleLoadSession(outcome.sessionId);
  },

  /**
   * Answer an artifact-path request from a client without a preload.
   *
   * The renderer reveals through the preload's `revealArtifact`, which the
   * host process cannot do — it has no window. A client that sends the command
   * anyway gets the path back in a notice, so the file is findable instead of
   * the click being a silent no-op.
   */
  revealArtifact(payload) {
    const target = typeof payload.path === "string" ? payload.path : "";
    if (target === "") {
      send({ type: "notice", level: "warn", text: "产物路径为空" });
      return;
    }
    send({ type: "notice", level: "dim", text: `产物：${target}` });
  },

  /**
   * Preview one text file.
   *
   * Only the workspace and the open session's directory are readable: the
   * renderer string is not a trusted path, and a preview is the one place a
   * bad path would otherwise be followed straight off the machine.
   */
  getFile(payload = {}) {
    const requested = payload.path;
    if (typeof requested !== "string" || requested.trim() === "") {
      send({ type: "error", message: "缺少文件路径" });
      return;
    }
    // A relative path is taken against the workspace, which is what the
    // renderer means by `getFile({ path: "src/x.ts" })`.
    const absolute = path.resolve(cwd, requested);
    if (!isAllowedPath(absolute)) {
      send({ type: "notice", level: "warn", text: `路径不在工作目录内：${requested}` });
      return;
    }
    readPreview(absolute, requested, "file");
  },

  /**
   * The open session's artifacts.
   *
   * No session means an empty list, not an error: the sidebar opens before any
   * conversation does and must not greet the operator with a warning.
   */
  getArtifacts() {
    send({ type: "artifacts", artifacts: listArtifacts() });
  },

  /** One artifact's text, restricted to the open session's artifact directory. */
  getArtifact(payload = {}) {
    const requested = payload.path;
    if (typeof requested !== "string" || requested.trim() === "") {
      send({ type: "error", message: "缺少产物路径" });
      return;
    }
    const dir = artifactsDirOf();
    if (dir === "") {
      send({ type: "notice", level: "warn", text: `没有打开的会话，无法读取产物：${requested}` });
      return;
    }
    // Both a full path and a bare file name are accepted: the manifest hands
    // out absolute paths, but a client may send back only the name it drew.
    const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(dir, requested);
    if (!isInside(dir, resolveForCheck(absolute))) {
      send({ type: "notice", level: "warn", text: `产物不在当前会话的 artifacts 目录内：${requested}` });
      return;
    }
    readPreview(absolute, requested, "artifact");
  },

  /**
   * Reasoning effort is not a kernel capability.
   *
   * The model adapter sends a plain chat completion; there is no reasoning
   * parameter to set. Answering with a `state` carrying the new level would
   * show the operator a setting that does nothing.
   */
  setEffort() {
    send({ type: "notice", level: "warn", text: "内核不支持调整推理强度" });
  },

  /**
   * The settings page's one write that is not a config file.
   *
   * Only the locale is accepted, and only by forwarding to the same path the
   * language menu uses. Everything else is refused: a general settings write
   * would let any client change fields this host does not own, and the real
   * config entry points are `saveMcpServer` / `savePermissions` /
   * `saveRunLimits`.
   */
  saveSettings(payload = {}) {
    const settings = payload.settings;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      send({ type: "notice", level: "warn", text: "缺少 settings 对象" });
      return;
    }
    const keys = Object.keys(settings);
    const localeWanted = settings.locale;
    if (localeWanted !== undefined && localeWanted !== "en" && localeWanted !== "zh") {
      send({ type: "notice", level: "warn", text: `不支持的语言：${String(localeWanted)}` });
      return;
    }
    const unsupported = keys.filter((key) => key !== "locale");
    if (unsupported.length > 0) {
      send({
        type: "notice",
        level: "warn",
        text: `该设置没有后端：${unsupported.join(", ")}`,
      });
      return;
    }
    if (localeWanted === undefined) {
      // An empty object is not a save: saying "saved" would be a lie.
      send({ type: "notice", level: "warn", text: "没有可保存的设置" });
      return;
    }
    locale = localeWanted;
    send({ type: "locale", locale });
    send(stateEvent());
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
        detail: providersPath,
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

  /**
   * One directory's children for the file tree.
   *
   * `listDirectory` is the kernel's own boundary check — it refuses anything
   * outside the registered workspace and the sessions root — so this handler
   * does not re-implement containment. `path` defaults to the workspace
   * because the renderer sends `"."` from the boot call and from the pane
   * opening, and both mean "the folder I am working in".
   */
  async getTree(payload = {}) {
    const raw =
      typeof payload.path === "string" && payload.path.trim() !== "" ? payload.path : cwd;
    // A relative path is taken against the workspace, not the host process's
    // own directory: the renderer sends `"."` and means "the folder I am
    // working in". Resolving here also keeps the boundary check meaningful.
    const requested = path.resolve(cwd === "" ? process.cwd() : cwd, raw);
    await settleRoot();
    const list = kernel.filesApi?.listDirectory;
    if (typeof list !== "function") {
      // A `dist/` built before the file API landed. Say so instead of drawing
      // an empty folder, and release the renderer's pending tree target.
      send({
        type: "notice",
        level: "warn",
        text: "文件树不可用：内核未导出 listDirectory，请重新执行 npm run build",
      });
      send({ type: "tree", nodes: [] });
      return;
    }
    let listing;
    try {
      listing = await list(harnessHome, requested);
    } catch (error) {
      // R3: an unreadable or out-of-bounds directory says why. The empty
      // `tree` is the renderer's release signal, not a claim that the folder
      // is empty — `pendingTreeTarget` would otherwise wait forever.
      send({ type: "notice", level: "warn", text: `目录读取失败：${messageOf(error)}` });
      send({ type: "tree", nodes: [] });
      return;
    }
    const entries = Array.isArray(listing?.entries) ? listing.entries : [];
    send({
      type: "tree",
      nodes: entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: entry.type,
      })),
      truncated: listing?.truncated === true,
    });
  },

  searchFiles(payload) {
    // The kernel has no file-name search API (no index, no walker): probing
    // `listDirectory` recursively here would be this host inventing one, and
    // the results would disagree with the browser form's `/api` surface. The
    // mention popup therefore answers "no matches" rather than hanging.
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
    // The same archive rule the list uses: a session hidden from the sidebar
    // must not reappear as a search hit for a word in its title.
    const rows =
      payload.includeArchived === true
        ? sessions.list()
        : sessions.list().filter((entry) => entry.archived !== true);
    const matches =
      query === ""
        ? []
        : rows.filter((entry) => {
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

/**
 * Run one command and report its failure.
 *
 * `undefined` for a handler that answered synchronously, a promise otherwise;
 * the queue below awaits it either way.
 */
function runCommand(payload) {
  try {
    const result = handlers[payload.cmd](payload);
    if (result instanceof Promise) {
      return result.catch((error) => {
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
  return undefined;
}

/**
 * Commands run one at a time, in arrival order.
 *
 * `loadSession` and `sleep`-less sequences like `loadSession` → `exportSession`
 * are two writes from the same click; running them concurrently let the
 * export read `sessionId` before the load had set it and answer "nothing to
 * export" for a session the user was looking at.
 */
let commandQueue = Promise.resolve();

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
  commandQueue = commandQueue.then(() => runCommand(payload));
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
