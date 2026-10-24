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
  statSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { kernelMissingMessage, RESOURCES_PATH_ENV, resolveRoots } from "./roots.js";
import { SerialBridge, listSerialPorts, serialRingPath } from "./serial-bridge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// `distParent` is the directory that holds `dist/` — the checkout root in
// development, `resources/` once packaged. It is resolved rather than assumed
// because the two layouts differ; see `./roots.js` for the precedence and for
// why `process.resourcesPath` is not read here.
//
// The main process passes its `process.resourcesPath` down in an environment
// variable: the host runs with `ELECTRON_RUN_AS_NODE=1` and has no Electron
// API, and the property it *can* see in that mode belongs to the Electron
// installation, not to this app.
const roots = resolveRoots({
  here,
  resourcesPath: process.env[RESOURCES_PATH_ENV],
  env: process.env,
});
const dist = (name) => pathToFileURL(path.join(roots.distDir, name)).href;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** One bridge per host process; its events leave through the same `send`. */
const serialBridge = new SerialBridge(send);

/**
 * Board pane state the host owns directly. The target part number is NOT
 * here — that answer comes from the agent's probe tools via `device_status`
 * events, and a host-side guess would be a fabricated one (R3). This is the
 * selection the tools should use, persisted per host process.
 */
let boardSelection = {};

/**
 * The device half of the board pane: call each configured embedded backend's
 * read-only status tool through a short-lived MCP manager. Undefined when the
 * kernel's MCP modules are missing (stale dist) — the pane keeps its serial
 * half either way.
 */
async function probeBoardDevices() {
  const config = mcpBoardModule?.config;
  const managerCtor = mcpBoardModule?.manager?.McpManager;
  if (typeof config?.loadMcpConfig !== "function" || typeof managerCtor !== "function") {
    return [];
  }
  try {
    const { probeBoardState } = await import("./board-probe.js");
    return await probeBoardState({
      loadMcpConfig: config.loadMcpConfig,
      McpManager: managerCtor,
      harnessHome,
      workdir: cwd,
    });
  } catch {
    // An unreachable backend is a normal finding, not a host failure; the
    // per-tool errors travel in the results when they do.
    return [];
  }
}

/** Project identity from the cwd, at the shape the pane's `project` expects. */
function state_boardProject() {  const dir = cwd ?? "";
  if (dir === "") return { kind: "unknown", evidence: [] };
  // The same signals the route facade uses; cheap extension checks only —
  // this is a display hint, not a routing decision.
  if (existsSync(path.join(dir, ".uvprojx"))) return { kind: "keil", root: dir, evidence: [] };
  for (const marker of [[".project", ".cproject"], ["CMakeLists.txt", "project.cmake"], ["platformio.ini"], ["sdkconfig"], ["Makefile"]]) {
    if (marker.every((name) => existsSync(path.join(dir, name)))) {
      const kind = marker[0] === ".project" ? "cubeide" : marker[0] === "CMakeLists.txt" ? "espidf" : marker[0] === "platformio.ini" ? "platformio" : marker[0] === "sdkconfig" ? "zephyr" : "make";
      return { kind, root: dir, evidence: [] };
    }
  }
  return { kind: "unknown", evidence: [] };
}

function fatal(message) {
  send({ type: "fatal", message });
}

/**
 * `process.exit` does not wait for a pipe write, and a truncated `fatal` reads
 * as no message at all: the parent sees a process that died for no stated
 * reason. Drain stdout, then leave.
 *
 * The returned promise never resolves, and callers must `await` it: the exit
 * runs from a write callback, which is a later turn of the loop, so returning
 * normally would let the module go on importing from a `dist/` just declared
 * absent. Top-level `await` is what stops the rest of the file.
 */
function exitAfterFlush(code) {
  return new Promise(() => {
    process.stdout.write("", () => process.exit(code));
    // A pipe nobody is reading would otherwise hold the process open.
    setTimeout(() => process.exit(code), 1000).unref();
  });
}

// A missing build used to surface as the first dynamic import's module error,
// which names a file the operator never chose and says nothing about the cure.
// Check the entry up front and say what went wrong in the layout they have.
if (!existsSync(roots.entry)) {
  fatal(kernelMissingMessage(roots.form, roots.entry));
  await exitAfterFlush(1);
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
    // `readSessionHeader` lives here now: it used to be re-exported by the
    // HTTP layer's `api.js`, which was deleted with the browser form. The one
    // that survived is the checked variant (it also insists on at least one
    // log file), so a session directory with a header but no log reads as
    // corrupt here rather than as an empty conversation.
    { readSessionDir, readSessionSnapshot, readSessionHeader },
    { resolveHarnessHome },
    // `supportsReasoning` / `isReasoningEffort` are the kernel's own rules for
    // the reasoning parameter; the host reads them rather than keeping a second
    // copy that could drift from what the request actually sends.
    {
      isReasoningEffort,
      loadProviders,
      resolveModelRef,
      supportsReasoning,
    },
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
    skillsModule,
    backgroundModule,
    protocol,
  ] = await Promise.all([
    import(dist("server/runner.js")),
    import(dist("events/log-tail.js")),
    import(dist("session/persistence.js")),
    import(dist("config/harness-home.js")),
    import(dist("config/providers.js")),
    import(dist("session/handle.js")),
    import(dist("session/metadata.js")),
    import(dist("config/app-config.js")),
    import(dist("server/session-admin.js")),
    // Namespace, not destructured names: `listDirectory` / `registerWorkspaceRoot`
    // are newer exports, and a stale `dist/` must not take the whole host down
    // at import time — the handlers report the gap instead.
    import(dist("server/files-api.js")),
    // Same namespace rule, plus a `catch`: `dist/skills/store.js` is newer than
    // most `dist/` trees in the wild, and an un-rebuilt kernel must still boot
    // — the settings page is where the operator fixes that, and it cannot open
    // in a process that exited during startup. The handlers answer "run npm run
    // build" instead of pretending there are no skills.
    import(dist("skills/store.js")).catch(() => undefined),
    // Same namespace rule, plus a `catch`: a `dist/` built before the
    // background terminal landed must still boot — the pump reports the gap
    // instead of the host dying at import time.
    import(dist("tools/background.js")).catch(() => undefined),
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
    isReasoningEffort,
    supportsReasoning,
    writeMcpServers,
    writePermissionConfig,
    writeProviders,
    writeRunLimits,
    createSessionAdmin,
    filesApi,
    skills: skillsModule,
    background: backgroundModule,
    protocol,
  };
} catch (error) {
  fatal(
    `内核未构建：${error instanceof Error ? error.message : String(error)}。请先在仓库根目录运行 npm run build。`,
  );
  // Same reason as the entry check above: the message must reach the parent.
  await exitAfterFlush(1);
}

// `hello` is emitted before stdin is read: the renderer uses it to move its
// status line from "starting" to "connecting".
send({ type: "hello" });

// ---------------------------------------------------------------------------
// Model probe (optional module)
// ---------------------------------------------------------------------------

/**
 * The kernel's `probeProvider`, loaded apart from the modules above.
 *
 * `dist/model/probe.js` is newer than the rest of the kernel surface: a
 * `dist/` built before it landed has no such file, and a static import — or a
 * destructured name in the `Promise.all` above — would throw while this
 * process is still starting and take the whole host down. One command the
 * settings page can retry must not cost the operator their window, so the
 * import is namespace-style and its failure is kept for the handler to report.
 *
 * A namespace rather than a named import: a file that exists but does not yet
 * export `probeProvider` has to fail the same way, and an absent export is
 * only visible on the namespace.
 */
const probeModule = await import(dist("model/probe.js")).catch(() => undefined);

/**
 * The kernel's MCP stack, for the board pane's device probe.
 *
 * Same lazy/namespace rule as `probeModule`: a `dist/` without these modules
 * (or without `loadMcpConfig` on config.js) must not stop the host from
 * booting — the board pane reports the gap instead.
 */
const mcpBoardModule = await Promise.all([
  import(dist("mcp/config.js")),
  import(dist("mcp/manager.js")),
]).then(([config, manager]) => ({ config, manager })).catch(() => undefined);

/**
 * The kernel's knowledge-base locator, loaded lazily by `getKb`.
 *
 * Same reasoning as `probeModule`, one step further: `dist/server/kb-locate.js`
 * is newer than most `dist/` trees in the wild, and putting it in the startup
 * `Promise.all` would make an un-rebuilt kernel refuse to boot at all. The
 * settings page can retry this command, so it reports the gap instead.
 */
let kbModulePromise;
function kbModule() {
  kbModulePromise ??= import(dist("server/kb-locate.js")).catch(() => undefined);
  return kbModulePromise;
}

/**
 * The kernel's corpus OTA client, its config reader and its manifest rules,
 * loaded lazily.
 *
 * Same reasoning as `kbModule`, one module further: `dist/corpus/update.js`
 * and `dist/config/corpus-config.js` are newer than most `dist/` trees in the
 * wild, and a kernel built before them must still boot — the knowledge-base
 * page is where the operator reads about the corpus, so it cannot live in a
 * process that died during startup. Each handler answers "run npm run build"
 * instead of taking the window down.
 *
 * All three come from one promise because every corpus answer needs at least
 * two of them: the status reader plus the config loader, and the apply path
 * also parses the manifest it hands back to the kernel.
 */
let corpusModulePromise;
function corpusModule() {
  corpusModulePromise ??= Promise.all([
    import(dist("corpus/update.js")),
    import(dist("config/corpus-config.js")),
    import(dist("corpus/manifest.js")),
  ])
    .then(([update, config, manifest]) => ({ update, config, manifest }))
    .catch(() => undefined);
  return corpusModulePromise;
}

/**
 * The first-run seeding module (`dist/corpus/seed.js`), loaded lazily by the
 * boot sequence.
 *
 * Same stale-`dist/` reasoning as `kbModule`, and here it matters more: seeding
 * runs before the operator has done anything, so an import that threw at boot
 * would take the window down over a feature nobody has asked for yet. A kernel
 * built before seeding landed simply skips it — the knowledge base then behaves
 * exactly as it did before, and `getKb` still answers from whatever `mcp.json`
 * and the checkout hold.
 *
 * `snapshot.js` rides along because the host needs `getKbLayout` to name the
 * two paths `seedKbMcpEntry` writes (`kb/current`, `kb/inbox/_inbox.md`); those
 * must come from the kernel's own layout function rather than being spelled out
 * here, or the OTA writer and the MCP config would disagree about §3's layout.
 */
let seedModulePromise;
function seedModule() {
  seedModulePromise ??= Promise.all([
    import(dist("corpus/seed.js")),
    import(dist("corpus/snapshot.js")),
  ])
    .then(([seed, snapshot]) => ({ seed, snapshot }))
    .catch(() => undefined);
  return seedModulePromise;
}

/**
 * The kernel's toolchain-pack stack (`dist/packs/*`), loaded lazily by the
 * Tools settings page.
 *
 * Same stale-`dist/` rule as `kbModule`: `dist/packs/` is newer than most
 * `dist/` trees in the wild, and an import that threw at boot would take the
 * window down over a page nobody had opened. The handlers answer "run
 * `npm run build`" instead.
 */
let packsModulePromise;
function packsModule() {
  packsModulePromise ??= Promise.all([
    import(dist("packs/registry.js")),
    import(dist("packs/install.js")),
    import(dist("packs/catalog.js")),
  ])
    .then(([registry, install, catalog]) => ({ registry, install, catalog }))
    .catch(() => undefined);
  return packsModulePromise;
}

/**
 * The keil MCP server's compiled modules that the Tools page borrows:
 * `TOOLCHAIN_INFO` (the kind → label/purpose table the renderer cannot read
 * from TypeScript) and `findUv4` (Keil's registry/TOOLS.INI install discovery —
 * Keil is never on PATH and never a pack).
 *
 * These live under `dist-mcp/`, not `dist/`: they are domain modules with
 * their own build, so the host resolves them off `roots.distParent`. In a
 * checkout that directory exists whenever `npm run build:mcp` has run; a
 * missing table only blanks the Tools page's detection section, it does not
 * take the host down.
 */
const distMcp = (name) => pathToFileURL(path.join(roots.distParent, "dist-mcp", name)).href;
let keilToolchainModulePromise;
function keilToolchainModule() {
  keilToolchainModulePromise ??= Promise.all([
    import(distMcp("keil/toolchain.js")),
    import(distMcp("keil/keilInstall.js")).catch(() => undefined),
  ])
    .then(([toolchain, keilInstall]) => ({ toolchain, keilInstall }))
    .catch(() => undefined);
  return keilToolchainModulePromise;
}

/**
 * Toolchain detection, cached per host process and reset whenever a pack
 * changes (install/remove) — a cache that survived an install would keep
 * reporting the freshly installed compiler as missing.
 */
let toolchainDetectionCache = null;
function resetToolchainDetection() {
  toolchainDetectionCache = null;
}

async function detectToolchainsForPacks(registry) {
  if (toolchainDetectionCache) return toolchainDetectionCache;
  const keil = await keilToolchainModule();
  const packDirs = [];
  try {
    for (const entries of registry.packBinDirs().values()) {
      for (const entry of entries) if (!packDirs.includes(entry.dir)) packDirs.push(entry.dir);
    }
  } catch {
    /* pack 目录列不出来时照样探测 PATH——那是更可信的一半也不能丢 */
  }
  const { detectToolchains } = await import("./toolchains.js");
  toolchainDetectionCache = await detectToolchains({
    packDirs,
    findUv4: typeof keil?.keilInstall?.findUv4 === "function" ? keil.keilInstall.findUv4 : null,
  });
  return toolchainDetectionCache;
}

/**
 * Toolchain-pack install state.
 *
 * Two guards, by design: `packInstallRunning` is this host's own refusal (the
 * command loop must never queue two transactions from one window), and the
 * registry-level `.lock` file is the second one, covering the CLI and a second
 * window — processes this host cannot see. `packAbort` cancels the in-flight
 * install when a new one is requested, same as A's host.
 */
let packAbort = null;
let packInstallRunning = false;

/**
 * Where `<resources>/corpus.json` would live, or `undefined` when this install
 * has no such level.
 *
 * Packaged, `roots.distParent` is the app's `resources/` directory, which is
 * exactly where the build injects `corpus.json` (contract §2). In a checkout
 * it is the repository root — a directory that holds `config/corpus.local.json`
 * rather than `corpus.json`, so pointing the loader at it would only ever
 * produce "not found" for a file that was never meant to be there.
 *
 * **Testing and development** therefore use the level that outranks it anyway:
 * `$HARNESS_HOME/corpus.json` (contract §2, highest precedence). Point
 * `HARNESS_HOME` at a temporary directory, drop a `corpus.json` in it, and the
 * whole check/apply path runs against that file — no extra environment
 * variable and no second validation path in this host. A `HARNESS_CORPUS_CONFIG`
 * override was considered and rejected for that reason: it would have to
 * re-implement `loadCorpusConfig`'s validation here, and two validators for one
 * file will eventually disagree about what "configured" means.
 */
const corpusResourcesRoot = roots.form === "packaged" ? roots.distParent : undefined;

/**
 * Wording for "there is no `corpus.json` at any level".
 *
 * Mirrors `normalizeConfig` in `src/corpus/update.ts`, which produces this
 * sentence when it is handed `config: null`. Kept as a copy rather than
 * obtained by calling the kernel with a null config: that call happens to
 * return before any request today, but a reordering there would turn "opening
 * Settings" into a network call, and the page opening must never reach out.
 */
const CORPUS_CONFIG_MISSING = "没有语料更新配置（corpus.json 缺失），无法检查更新";

/**
 * The manifest the last check verified, so "Update now" does not fetch
 * `latest.json` a second time.
 *
 * Keyed on the config it was verified under (`publicKeyPem` + `updateBaseUrl`):
 * editing either one makes the cached manifest a statement about a different
 * source, and installing it would mean trusting bytes the current config never
 * vouched for.
 */
let corpusManifestCache = null;
/**
 * Corpus commands run one at a time, in arrival order.
 *
 * A queue rather than a "busy" refusal, for two reasons. The commands share
 * `state.json` and the manifest cache, so overlapping them would let one write
 * over the other's result. And the natural sequence a user produces — click
 * Check, then click Update now before the first answer lands — is not an error:
 * the update simply waits for the check that is already fetching the manifest it
 * needs. Refusing it would be a refusal with nothing wrong. A rejected link is
 * swallowed so one failed command cannot poison the queue for every later one.
 */
let corpusQueue = Promise.resolve();

function enqueueCorpus(task) {
  const run = corpusQueue.then(task, task);
  corpusQueue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// `getKb` still wants a checkout root: the default corpus it falls back to is
// `<repoRoot>/mcp-servers/kb/kb`. This is that same directory only in
// development — packaged, it is `resources/`, which holds no corpus, and the
// locator reports the candidates it tried rather than pretending otherwise.
const repoRoot = roots.distParent;

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
/**
 * Timer that drains finished background jobs into the log.
 *
 * A background job by definition outlives the turn that started it, so this
 * cannot be driven by `follow`: the pump has already returned by the time the
 * job ends. It polls while the host is alive and stops on the same paths that
 * stop following (`stopFollow`, `shutdown`, stdin close).
 */
let backgroundPump;
/**
 * The in-flight `/compact`, if any.
 *
 * Kept apart from `followAbort` because it belongs to no run: `handleAbort`
 * stops this first so a compaction blocked on a slow summary request can be
 * cancelled without pretending a turn was running.
 */
let compactAbort;

/**
 * The kernel modules `/compact` needs, loaded on first use.
 *
 * Deliberately not in the startup `Promise.all`: `dist/context/compact.js`
 * and friends are newer than some `dist/` trees in the wild, and a kernel
 * built before them must still boot. A command the user can retry reports the
 * gap instead of taking the window down (`getKb` / `getTree` do the same).
 *
 * `dist/context/breakdown.js` rides in the same batch and shares its failure
 * mode on purpose: the split is what `/compact` reports afterwards, so a
 * kernel without it would answer with numbers the host could not break down.
 * One "npm run build" message covers both, and the `catch` below stays.
 */
let compactModulesPromise;
function compactModules() {
  compactModulesPromise ??= Promise.all([
    import(dist("config/providers.js")),
    import(dist("model/openai.js")),
    import(dist("session/session.js")),
    import(dist("context/compact.js")),
    import(dist("context/build.js")),
    import(dist("context/breakdown.js")),
    import(dist("model/count.js")),
  ])
    .then(([
      providersModule,
      openaiModule,
      sessionModule,
      compactModule,
      buildModule,
      breakdownModule,
      countModule,
    ]) => ({
      loadProviders: providersModule.loadProviders,
      resolveModelRef: providersModule.resolveModelRef,
      resolveProviderApiKey: providersModule.resolveProviderApiKey,
      resolveContextWindow: providersModule.resolveContextWindow,
      createOpenAIProvider: openaiModule.createOpenAIProvider,
      resumeSession: sessionModule.resumeSession,
      compactSession: compactModule.compactSession,
      buildMessages: buildModule.buildMessages,
      // A namespace member, not a destructured name: an older `dist/` may lack
      // `context/breakdown.js` entirely (the import above rejects and
      // `compactModules()` resolves `undefined`, which the handler reports as
      // "run npm run build"). When the module exists but the export does not,
      // the value is `undefined` and the meter simply carries no split.
      buildContextBreakdown: breakdownModule.buildContextBreakdown,
      heuristicCountTokens: countModule.heuristicCountTokens,
    }))
    .catch(() => undefined);
  return compactModulesPromise;
}

/**
 * Whether the stale-`dist/` warning for file search has been sent.
 *
 * The `@` popup asks once per keystroke; without this flag a kernel missing
 * `searchFilesByName` would emit one notice per character and bury the
 * transcript. One warning per process says the same thing once.
 */
let searchUnavailableWarned = false;

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

/**
 * The reasoning levels this kernel can send, in menu order.
 *
 * Not `REASONING_EFFORTS` from the kernel: `none` is a real protocol value but
 * a confusing menu row ("no thinking" reads like turning the feature off, and
 * for most models `minimal` is the practical floor), so the picker offers the
 * four levels a model is chosen between. `auto` is the renderer's own sentinel
 * and is not listed here.
 */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high"];

/** The `provider/model` reference the host is currently pointed at. */
function currentModelCfg() {
  try {
    return kernel.resolveModelRef(providers, modelRef).model;
  } catch {
    // No model, or a reference that no longer resolves: nothing is declared.
    return undefined;
  }
}

/**
 * Whether the selected model accepts a reasoning parameter.
 *
 * Delegated to the kernel so the host and the request agree on one rule:
 * `supportsReasoning` is true only when the config says so (`supportsReasoning:
 * true`, or a default `reasoningEffort`), otherwise false. The host's job is to
 * report that answer, not to guess a second one.
 */
function currentModelSupportsReasoning() {
  const cfg = currentModelCfg();
  return cfg === undefined ? false : kernel.supportsReasoning(cfg);
}

function buildModelList(config) {
  const out = [];
  for (const [providerName, provider] of Object.entries(config)) {
    for (const [modelName, model] of Object.entries(provider.models ?? {})) {
      out.push({
        id: `${providerName}/${modelName}`,
        name: modelName,
        contextLength: model.contextWindow,
        supportsTools: true,
        // The file is the only source for this: `GET /v1/models` does not
        // report it, so an undeclared model is honestly "not known to accept
        // one" rather than an assumed true.
        supportsReasoning: kernel.supportsReasoning(model),
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
let runLimits = {
  maxTurns: null,
  maxCostUsd: null,
  timeoutMs: null,
  systemPrompt: "",
  reasoningEffortByModel: {},
};

/**
 * The effort choice the operator made for the current model, or "auto".
 *
 * Read from `run.json` (per model reference) rather than localStorage: the
 * choice is part of what a run does, it has to survive a restart, and the
 * renderer's storage is per-window. `auto` is the absence of a record — see
 * `AppRunLimits.reasoningEffortByModel`.
 */
function currentEffort() {
  if (modelRef === "") return "auto";
  const stored = runLimits.reasoningEffortByModel?.[modelRef];
  return typeof stored === "string" ? stored : "auto";
}

/**
 * The effort table, creating it when the loaded config predates the field.
 *
 * A `dist/` built before `AppRunLimits.reasoningEffortByModel` existed returns
 * a `run` object without it, and the host must not crash on that: the settings
 * page is where a stale build gets noticed, and a `setEffort` that throws would
 * take the composer down instead. A missing table is also the honest state —
 * nobody has chosen a level yet.
 */
function effortTable() {
  if (runLimits.reasoningEffortByModel === undefined) {
    runLimits.reasoningEffortByModel = {};
  }
  return runLimits.reasoningEffortByModel;
}

/**
 * What the effort popover may offer for the selected model.
 *
 * `levels: []` means "auto only" — the renderer prepends `auto` itself. A model
 * that does not declare reasoning support gets that, plus a note saying why:
 * the alternative is a menu of levels whose parameter the request would drop.
 * `default` is the level `auto` will actually send, so the menu can say what
 * the model will do without the operator having to read providers.json.
 */
function effortChoices() {
  const choices = { levels: [], default: "", fixed: "", note: "" };
  const cfg = currentModelCfg();
  if (cfg === undefined) {
    choices.note = "没有可用模型，无法调整推理强度";
    return choices;
  }
  if (!kernel.supportsReasoning(cfg)) {
    // Name the field, because the fix is a providers.json edit.
    choices.note = `${modelRef} 未声明支持推理强度（providers.json 里该模型的 supportsReasoning 不是 true），请求不会携带该参数`;
    return choices;
  }
  choices.levels = [...EFFORT_LEVELS];
  if (typeof cfg.reasoningEffort === "string") choices.default = cfg.reasoningEffort;
  return choices;
}

/**
 * The limits to hand this run.
 *
 * `null` means "not set", not "zero": sending `maxCostUsd: null` would fail
 * the runner's number check, and sending 0 would stop the loop before its
 * first turn. Unset fields are omitted so the kernel defaults apply — which
 * for `maxTurns` means no cap at all, not a hidden number.
 */
function runLimitOptions() {
  return {
    ...(typeof runLimits.maxTurns === "number"
      && Number.isFinite(runLimits.maxTurns)
      && runLimits.maxTurns > 0
      ? { maxTurns: runLimits.maxTurns }
      : {}),
    ...(runLimits.maxCostUsd === null ? {} : { maxCostUsd: runLimits.maxCostUsd }),
    ...(runLimits.timeoutMs === null ? {} : { timeoutMs: runLimits.timeoutMs }),
    ...(runLimits.systemPrompt === "" ? {} : { systemPrompt: runLimits.systemPrompt }),
    // Omitted for "auto": the runner would turn it into "no override" anyway,
    // and a field that never travels is one less thing to misread downstream.
    ...(currentEffort() === "auto" ? {} : { reasoningEffort: currentEffort() }),
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
 * Occupancy, its per-category split and spend, as of the last priced call.
 *
 * `state` is sent on boot and on every session switch; without these figures
 * the meter drops back to zero each time a conversation is reopened, even
 * though its transcript is full.
 *
 * The split is read from the same `usage` event that carried the occupancy —
 * the kernel writes both together, so taking them from different events could
 * pair a total with a breakdown of a different transcript. A log written before
 * the split existed simply has no such field, and the key stays absent rather
 * than travelling as `null` ("no measurement" is a different claim).
 */
function lastMeasure(events) {
  let context;
  let contextBreakdown;
  let costUsd;
  for (const event of events) {
    if (event?.type !== "usage" || typeof event.payload !== "object" || event.payload === null) continue;
    const payload = event.payload;
    if (typeof payload.context === "object" && payload.context !== null) {
      context = payload.context;
      contextBreakdown = payload.contextBreakdown;
    }
    if (typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd)) {
      costUsd = payload.costUsd;
    }
  }
  return {
    ...(context === undefined ? {} : { context }),
    ...(contextBreakdown === undefined ? {} : { contextBreakdown }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

let lastSessionId = "";
let lastSessionMeasure = {};

function stateEvent() {
  // The cached measure belongs to the session that produced it; showing it
  // over a different conversation would be a fabricated number.
  const extra = sessionId !== "" && sessionId === lastSessionId ? lastSessionMeasure : {};
  const state = kernel.protocol.initialState({
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
  // Both fields describe the selected model, so they are rebuilt from the
  // config on every event: a model switch changes what the menu may offer, and
  // a cached list would keep offering levels the new model drops.
  //
  // Assigned here rather than passed as options because the shared protocol
  // module still emits its own `auto` for them; until that module grows the
  // same option handling, overwriting is what keeps this event honest instead
  // of announcing `auto` right after the operator picked `high`.
  state.effort = currentEffort();
  state.effortChoices = effortChoices();
  return state;
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

/**
 * The first-run seed, started once by `init`.
 *
 * `undefined` until `init` runs. Kept as a promise (rather than fired and
 * forgotten) so a second `init` — the renderer reloading does not send one, but
 * a re-handshake would — cannot start a second copy, and so `getKb` can await
 * it before reporting a root that is about to change.
 */
let seedFirstRunPromise;

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
 *
 * **Only a hit is cached.** A miss means the log has no user event *yet*:
 * `runner.start()` returns as soon as `onSession` fires — the header is
 * written, the user event is not — so the `sessions` push that follows every
 * prompt runs before there is anything to read. Caching that empty answer
 * froze the row on its UUID for the life of the process: the title arrived
 * milliseconds later and nothing ever asked again. A session with genuinely
 * no messages now pays one log read per list push, which is the correct price
 * for a row that can still change.
 */
const titleCache = new Map();
const TITLE_SCAN_LIMIT = 30;

/** Cache key for one session row: a rename or a fork changes `createdAt`. */
function titleKey(entry) {
  return `${entry.id}@${entry.createdAt}`;
}

function titleFor(entry) {
  // A name the operator gave is the title; the first user message is only a
  // stand-in for a session nobody renamed.
  if (typeof entry.title === "string" && entry.title !== "") return entry.title;
  const key = titleKey(entry);
  const cached = titleCache.get(key);
  if (cached !== undefined) return cached;
  const title = sessions.titleOf(entry.id);
  // `titleOf` falls back to the id when the log has no user event; that is a
  // miss, not a title, and must not be remembered.
  if (title === entry.id || title === "") return "";
  titleCache.set(key, title);
  return title;
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
    const alreadyCached = titleCache.has(titleKey(entry));
    // A row with no derived title yet reports `""` rather than its id: the
    // renderer draws "no messages" for that, where an id reads as a name the
    // operator gave. It stays out of the cache so the next push can find it.
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

// ---------------------------------------------------------------------------
// Background terminal results
// ---------------------------------------------------------------------------

/** How often a finished background job is turned into a log event. */
const BACKGROUND_PUMP_MS = 1_000;

/**
 * Write every finished background job as a `background_result` event.
 *
 * The log is the single source of truth in this app: a reopened session has to
 * show what that ten-minute build ended up doing, and an out-of-band message
 * would be gone the moment the window closed. So the completion goes through
 * `takeBackgroundCompletions` → an appended event → the normal event pump,
 * which is already watching the log.
 *
 * The append needs a session handle, and the run's own handle is closed when
 * its turn ends — precisely the case this feature exists for. Opening one here
 * mirrors `handleCompact`: briefly take the lock, append, release. If the lock
 * is busy (the user is mid-turn in another window) the entry is dropped rather
 * than retried forever; the job's own `check` command still reports it, and
 * `background_result` is a notification, not the only record.
 */
async function pumpBackgroundResults() {
  if (sessionId === "") return;
  const modules = kernel.background;
  if (modules === undefined || typeof modules.takeBackgroundCompletions !== "function") return;
  const pending = modules.takeBackgroundCompletions(sessionId);
  if (pending.length === 0) return;
  const id = sessionId;
  let handle;
  try {
    handle = await kernel.resumeSession(path.join(sessionsRoot, id));
  } catch (error) {
    // Lock held by a live run: that run's own pump will not see these either,
    // so say so once instead of swallowing them (R3).
    send({
      type: "notice",
      level: "dim",
      text: `后台作业已结束，但会话被占用，结果未能写入日志：${messageOf(error)}`,
    });
    return;
  }
  try {
    for (const payload of pending) {
      await handle.append({ type: "background_result", payload });
    }
  } catch (error) {
    send({
      type: "notice",
      level: "warn",
      text: `后台作业结果写入失败：${messageOf(error)}`,
    });
  } finally {
    void handle.close().catch(() => undefined);
  }
}

/** Start the drain loop. Idempotent: a second call does not stack timers. */
function startBackgroundPump() {
  if (backgroundPump !== undefined) return;
  backgroundPump = setInterval(() => {
    void pumpBackgroundResults().catch(() => undefined);
  }, BACKGROUND_PUMP_MS);
  // Never a reason to keep the app alive on its own; a real run has its own
  // handles.
  backgroundPump.unref?.();
}

function stopBackgroundPump() {
  if (backgroundPump !== undefined) {
    clearInterval(backgroundPump);
    backgroundPump = undefined;
  }
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
// Skills and the slash-command catalogue
// ---------------------------------------------------------------------------

/**
 * The built-in slash commands this form can actually run.
 *
 * All three have a real handler here: `/clear` maps to `newSession`,
 * `/context` is answered by the renderer from the kernel's own measurement,
 * and `/compact` runs the kernel's compaction. A verb with no route behind it
 * would be a menu row that fails on click (R3), so the list is short on
 * purpose.
 *
 * One function, called by both `init` and `listCommands`: the boot push and
 * the answer to the renderer's own request have to be the same list, and two
 * literals for one catalogue is exactly how they drift apart.
 */
function builtinCommands() {
  return [{ name: "clear" }, { name: "context" }, { name: "compact" }];
}

/** What the settings page and the transcript show when the store is absent. */
const SKILLS_MISSING = "内核未导出技能存储，请重新执行 npm run build";

/**
 * A skill failure, tagged so the renderer can route it to the settings page.
 *
 * Every one of these is answered while the settings dialog is open, and the
 * dialog is a `showModal()` on top of the transcript: a bare `notice` drawn
 * behind it is a failure the user never sees (R3). `domain` is the routing
 * key — the renderer keeps a plain `notice` in the transcript, and puts a
 * `skills` one in the page that asked for it.
 */
function skillNotice(text) {
  send({ type: "notice", level: "warn", text, domain: "skills" });
}

/**
 * The compiled skill store, or `undefined` when this `dist/` has none.
 *
 * The import is namespaced and `catch`-ed (see the startup block): a kernel
 * built before `skills/store.js` landed boots normally, and every skill
 * command reports the gap instead. The check is on the namespace member, not
 * on the import: a module that exists but does not yet export `readSkills` is
 * the same unsupported state, and only the namespace can see that.
 */
function skillStore() {
  const store = kernel.skills;
  if (store === null || typeof store !== "object") return undefined;
  return typeof store.readSkills === "function" ? store : undefined;
}

/**
 * Where the store should look, as `{ home, workdir, agentsHome }`.
 *
 * An empty `cwd` is "no workspace open" and is omitted rather than sent as
 * `""`: a defined workdir means "also read project skills underneath it", and
 * the empty string would resolve against the host process's own directory —
 * making an unrelated folder's `.harness/skills` count as this workspace's.
 *
 * `agentsHome` is skill-CLI's root (`~/.agents` by default). It is passed
 * explicitly rather than left to the store's default so that `AGENTS_HOME`
 * reaches it — the same override `HARNESS_HOME` has — and so the value the app
 * reads is the one this host resolved, not a second lookup inside the kernel.
 */
function skillsLocation() {
  const agentsHome = process.env.AGENTS_HOME?.trim();
  return {
    home: harnessHome,
    ...(cwd === "" ? {} : { workdir: cwd }),
    ...(agentsHome === undefined || agentsHome === "" ? {} : { agentsHome }),
  };
}

/** One skill exactly as the renderer consumes it — no extra fields. */
function skillRow(skill) {
  return {
    name: String(skill?.name ?? ""),
    description: typeof skill?.description === "string" ? skill.description : "",
    argumentHint: typeof skill?.argumentHint === "string" ? skill.argumentHint : "",
    // The renderer draws `project` vs `user` and nothing else; a store that
    // ever grows a third scope must be taught here before it can be drawn.
    scope: skill?.scope === "project" ? "project" : "user",
    body: typeof skill?.body === "string" ? skill.body : "",
  };
}

/**
 * Read the whole skill library, or `undefined` when the kernel has no store.
 *
 * `problems` is kept apart from `skills` on purpose: a file whose front matter
 * does not close is a file the operator can fix, and dropping it silently
 * would make the library read as "nothing here" (R3). A store that throws is
 * turned into a problem with the reason instead of taking the command down —
 * the settings page still has to open so the file can be repaired by hand.
 *
 * Every caller re-reads from disk. There is no cache to invalidate: the files
 * are hand-editable, and a cached list would describe a folder nobody
 * re-listed.
 */
function readSkillsSnapshot() {
  const store = skillStore();
  if (store === undefined) return undefined;
  let result;
  try {
    result = store.readSkills(skillsLocation());
  } catch (error) {
    return { skills: [], problems: [{ file: "", message: messageOf(error) }] };
  }
  return {
    skills: (Array.isArray(result?.skills) ? result.skills : []).map(skillRow),
    problems: (Array.isArray(result?.problems) ? result.problems : []).map((problem) => ({
      file: String(problem?.file ?? ""),
      message: String(problem?.message ?? ""),
    })),
  };
}

/**
 * Everything the `/` menu may offer: the builtins, then one row per skill.
 *
 * Built-in entries stay `{ name }` — the renderer supplies their localized
 * description from its own catalogue and treats a missing `source` as
 * `"builtin"`. Skill rows carry what the file says, tagged `source: "skill"`,
 * which is what makes the palette insert `/name ` for arguments instead of
 * running it as a builtin verb.
 *
 * A skill that shadows a builtin is still listed: the renderer merges rows by
 * name and the first one (the builtin) wins, so the file is unreachable from
 * `/` without this list having to hide it — and hiding it here would not stop
 * the settings page from showing it, because that page reads `skills`.
 */
function commandCatalogue(snapshot = readSkillsSnapshot()) {
  const commands = builtinCommands();
  if (snapshot === undefined) return commands;
  for (const skill of snapshot.skills) {
    if (skill.name === "") continue;
    commands.push({
      name: skill.name,
      description: skill.description,
      argumentHint: skill.argumentHint,
      source: "skill",
    });
  }
  return commands;
}

/**
 * Push the fresh library and the refreshed palette, in that order.
 *
 * Both, always: the settings page draws from `skills` and the composer's `/`
 * menu from `commands`, and a save that refreshed only one would leave the two
 * views disagreeing about which skills exist.
 *
 * The runner is deliberately not rebuilt. Skills do not change the kernel's
 * tool set, and rebuilding would discard the session state that outlives one
 * conversation for a file that only affects the palette.
 */
function broadcastSkills() {
  const snapshot = readSkillsSnapshot();
  if (snapshot === undefined) {
    send({ type: "notice", level: "warn", text: SKILLS_MISSING });
    return;
  }
  send({ type: "skills", ...snapshot });
  send({ type: "commands", commands: commandCatalogue(snapshot) });
}

/**
 * Write the current effort table back to `run.json`, keeping the other limits.
 *
 * `saveRunLimits` replaces the whole file, so the table is sent together with
 * the limits already loaded — otherwise a click on the popover would erase the
 * operator's `maxTurns` / `systemPrompt`. The local copy is updated before the
 * write (the callers do that) and restored from disk only when the write
 * actually fails, because an optimistic local value that outlived a failed
 * write would be a level the next run uses but the file does not record.
 *
 * Failures are reported, not swallowed (R3): the caller already sent the
 * `state`, and the notice is what stops that from being the last word.
 */
let effortWrite = Promise.resolve(true);

/**
 * @returns whether the file now records the current table.
 */
function persistEffort() {
  const wanted = {
    maxTurns: runLimits.maxTurns,
    maxCostUsd: runLimits.maxCostUsd,
    timeoutMs: runLimits.timeoutMs,
    systemPrompt: runLimits.systemPrompt,
    reasoningEffortByModel: { ...effortTable() },
  };
  // Serialized: two menu clicks in one tick must not race to rename two
  // different temp files over the same target, and the last click must win.
  effortWrite = effortWrite
    .then(() => kernel.writeRunLimits(harnessHome, wanted))
    .then(
      (written) => {
        runLimits = written;
        return true;
      },
      (error) => {
        // Reported, never swallowed (R3). The caller puts the in-memory value
        // back, so the next run cannot use a level the file does not record.
        send({
          type: "notice",
          level: "warn",
          text: `推理强度未保存：${messageOf(error)}`,
        });
        return false;
      },
    );
  return effortWrite;
}

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
  // A background job outlives this turn, so its result cannot ride `follow`.
  // The pump outlives it too — started here, stopped only when the host is.
  startBackgroundPump();
  send(sessionsEvent());
}

function handleAbort() {
  // A compaction is not a turn: it has no session in the runner's registry, so
  // `runner.abort` would answer "nothing is running" while a summary request
  // kept the UI busy. The controller is the stop button for it.
  if (compactAbort !== undefined) {
    compactAbort.abort();
    return;
  }
  if (sessionId === "" || !runner.abort(sessionId)) {
    send({ type: "notice", level: "dim", text: "没有正在运行的会话" });
    return;
  }
  // The kernel appends `interrupted` and closes the session; the pump will
  // deliver both and emit run_end. Nothing else to send here.
}

/**
 * Run the kernel's compaction on the open session, now.
 *
 * There is no shortcut here: the same `compactSession` the loop calls is
 * invoked against a handle opened for this command, keeps the same boundaries
 * and writes the same `compaction` events the transcript already knows how to
 * draw. The host's only jobs are the bookkeeping the loop would have done for
 * it — a busy state, an abort path, and a fresh measurement afterwards.
 *
 * One deliberate difference from the loop: this command compacts whether or
 * not the session has reached the soft threshold (`force: true`). The operator
 * pressed the button, so the occupancy check is not theirs to lose; the
 * threshold still travels to the kernel as `compactAt` for the report and the
 * meter, but it no longer decides whether anything happens.
 *
 * Every outcome is stated with real numbers: a completion quotes the occupancy
 * measured before and after, a no-op says so with the before figure, and a
 * failure carries the kernel's own reason. Nothing here reports success it did
 * not observe (R3), and nothing invents a zero for a figure it could not take.
 */
async function handleCompact() {
  if (sessionId === "") {
    send({ type: "notice", level: "warn", text: "没有打开的会话" });
    return;
  }
  if (ctx.running) {
    send({ type: "notice", level: "warn", text: "当前回合尚未结束，请先停止或等待" });
    return;
  }
  let header;
  try {
    ({ header } = await sessions.detailTolerant(sessionId));
  } catch (error) {
    send({ type: "notice", level: "warn", text: `上下文压缩失败：${messageOf(error)}` });
    return;
  }
  const model = header.model ?? modelRef;
  if (model === "") {
    send({ type: "notice", level: "warn", text: "没有可用的模型，无法压缩上下文" });
    return;
  }

  const modules = await compactModules();
  if (modules === undefined) {
    send({
      type: "notice",
      level: "warn",
      text: "上下文压缩不可用：内核未编译，请先 npm run build",
    });
    return;
  }

  let handle;
  const controller = new AbortController();
  compactAbort = controller;
  const signal = controller.signal;
  // The UI state is set only once the session is actually held: a refusal
  // before this point must not flash a busy meter.
  ctx.running = true;
  running = true;
  send({ type: "run_start" });
  try {
    const providers = modules.loadProviders(harnessHome);
    const { provider, modelName, model: modelCfg } = modules.resolveModelRef(providers, model);
    const apiKey = modules.resolveProviderApiKey(provider);
    // The summary is a real completion on the same model, so it carries the
    // same effort the operator selected: a compaction that quietly ran at a
    // different level than the conversation would be a second, invisible
    // setting. Keyed by the *session's* model (`model`), not `modelRef` —
    // `handleCompact` already resolves the header's model for the same reason.
    const summaryEffort = runLimits.reasoningEffortByModel?.[model];
    const modelProtocol = modules.createOpenAIProvider({
      baseUrl: provider.baseUrl,
      model: modelName,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(summaryEffort === undefined ? {} : { reasoningEffort: summaryEffort }),
      ...(provider.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: provider.requestTimeoutMs }),
      ...(provider.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: provider.maxResponseBytes }),
    });

    const window = modules.resolveContextWindow(modelCfg);
    const softRatio = 0.8;
    const softLimit = Math.floor(window * softRatio);
    const tokensOf = (events) => modules.heuristicCountTokens(modules.buildMessages(events));

    // The handle is opened before anything is measured: it takes the session
    // lock, so "another process is using this conversation" is reported as
    // itself instead of as a measurement that could change a moment later.
    handle = await modules.resumeSession(path.join(sessionsRoot, sessionId));
    const lastSeq = handle.events().at(-1)?.seq ?? -1;
    // Measured whether or not it clears the threshold: the figure is what the
    // report compares against, and `force` below is what makes the threshold
    // stop being a gate.
    const beforeTokens = tokensOf(handle.events());

    try {
      await modules.compactSession({
        session: handle,
        model: modelProtocol,
        modelCfg,
        signal,
        softRatio,
        // The operator asked for a compaction, so the kernel's soft threshold
        // does not get to answer "nothing to do". `force` skips both the
        // early return and the microcompact stage; without it (a `dist/`
        // built before this option existed) the call behaves as it always
        // did, which the report below still describes honestly.
        force: true,
      });
    } finally {
      await handle.close().catch(() => undefined);
      handle = undefined;
    }

    // What this call appended is what happened. Reading the log again rather
    // than trusting a return value keeps the report tied to the record.
    const after = await sessions.detailTolerant(sessionId);
    const appended = after.events.filter((event) => event.seq > lastSeq);
    const compactions = appended.filter((event) => event.type === "compaction");
    const summary = compactions.filter((event) => event.payload?.kind === "summary");
    const failed = compactions.filter((event) => event.payload?.kind === "failed");
    const elided = compactions
      .filter((event) => event.payload?.kind === "microcompact")
      .reduce(
        (total, event) =>
          total + (Array.isArray(event.payload.elidedSeqs) ? event.payload.elidedSeqs.length : 0),
        0,
      );
    // The same measurement the kernel makes, taken again on the log as it now
    // stands. Both figures are facts about this command: `beforeTokens` from
    // the handle before it ran, `afterTokens` from the record after it. A
    // message build that throws is kept as its own outcome: a compaction that
    // did happen must not be reported as a failure because the meter choked
    // on the result, and no figure is invented to fill the gap (R3).
    let messagesAfter;
    let afterTokens = 0;
    let measureError;
    try {
      messagesAfter = modules.buildMessages(after.events);
      afterTokens = modules.heuristicCountTokens(messagesAfter);
    } catch (error) {
      measureError = error;
    }

    // `summary` and `microcompact` become the transcript's existing
    // `compacted` marker. `failed` is left to the branch below: the protocol
    // turns it into a warning too, and forwarding it here would print the same
    // kernel reason twice.
    for (const event of compactions) {
      if (event.payload?.kind === "failed") continue;
      for (const message of kernel.protocol.sessionEventToHostEvents(event, ctx)) {
        send(message);
      }
    }
    if (failed.length > 0) {
      // The kernel's own reason, stated once. It normally also wrote a
      // `compaction` event with `kind: "failed"`, which the protocol renders
      // as the same warning through the pump; this direct path exists because
      // nothing is following the log during the command.
      for (const event of failed) {
        for (const message of kernel.protocol.sessionEventToHostEvents(event, ctx)) {
          send(message);
        }
      }
    } else if (summary.length === 0 && elided === 0) {
      // compactSession ran but found nothing it could do. Saying so beats a
      // silent no-op the operator would read as "it worked". The figure is the
      // one measured before the call, stated so the operator can see what was
      // weighed.
      send({
        type: "notice",
        level: "dim",
        text: `压缩没有产生任何改动（上下文 ${beforeTokens} / 窗口 ${window} tokens，压缩阈值 ${softLimit}）`,
      });
    } else if (afterTokens > 0) {
      // What actually changed, in the two measurements that bracket it. No
      // fallback to 0: an unmeasurable `after` is not an empty transcript, and
      // the `compacted` marker above already reports that it happened.
      send({
        type: "notice",
        level: "dim",
        text: `压缩完成：上下文 ${beforeTokens} → ${afterTokens} tokens（窗口 ${window}，压缩阈值 ${softLimit}）`,
      });
    } else if (measureError !== undefined) {
      // The compaction was appended (the marker above says so); only the
      // "how much is left" figure is missing. Stated with the kernel's reason
      // instead of a made-up number.
      send({
        type: "notice",
        level: "warn",
        text: `压缩已完成，但未能重新测量上下文：${messageOf(measureError)}`,
      });
    }
    if (failed.length === 0 && summary.length === 0 && elided > 0) {
      // Only reachable through a kernel that still stops after microcompaction
      // (one built before `force`); it is a fact either way, so it is stated
      // whether or not the "压缩完成" line above had a measured `after`.
      send({
        type: "notice",
        level: "dim",
        text: `已省略 ${elided} 条工具结果（microcompact）`,
      });
    }

    // The meter must show the transcript as it now stands. The figure is the
    // kernel's own heuristic on the kernel's own message build — the same
    // measurement `compactSession` made — not a guess at how much a summary
    // saved. The split answers "what is the window spent on" for the same
    // message build; it is attached only when the compiled kernel exports it,
    // so a `dist/` that has compaction but not `context/breakdown.js` still
    // gets an honest total instead of a crash.
    if (afterTokens > 0 && window > 0) {
      // A split that throws costs the split, not the total: the kernel's own
      // loop takes the same stance (`query.ts` deletes the field and keeps the
      // measurement), and a compaction that did happen must not be reported as
      // a failure because its chart could not be drawn.
      let contextBreakdown;
      if (typeof modules.buildContextBreakdown === "function") {
        try {
          contextBreakdown = modules.buildContextBreakdown(messagesAfter, {
            window,
            used: afterTokens,
            compactAt: softLimit,
          });
        } catch {
          contextBreakdown = undefined;
        }
      }
      lastSessionMeasure = {
        ...lastSessionMeasure,
        context: {
          tokens: afterTokens,
          percent: Math.min(100, Math.round((afterTokens / window) * 1000) / 10),
          window,
        },
        ...(contextBreakdown === undefined ? {} : { contextBreakdown }),
      };
      send(stateEvent());
    }
  } catch (error) {
    if (signal.aborted) {
      send({ type: "notice", level: "dim", text: "上下文压缩已停止" });
      return;
    }
    send({ type: "notice", level: "warn", text: `上下文压缩失败：${messageOf(error)}` });
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    compactAbort = undefined;
    ctx.running = false;
    running = false;
    send({ type: "run_end" });
  }
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
  // `cwd` here is the folder the topbar currently names — including one adopted
  // from a conversation that was just opened. A new session starting where the
  // topbar points is the intended meaning of that switch.
  //
  // The effort is the host's current choice for the selected model, not a
  // literal `auto`: a new conversation runs under the same model, so the
  // popover must keep showing what the next request will actually send.
  send({ type: "session_loaded", messages: [], cwd, mode, effort: currentEffort() });
  send(stateEvent());
  send(sessionsEvent());
}

/**
 * Adopt the working directory a saved conversation was recorded in.
 *
 * Opening a conversation from the sidebar is a workspace switch: the topbar,
 * the file tree and the preview boundary all describe the project the
 * operator is now looking at, so all three have to follow the header rather
 * than the folder this window happened to boot in — switching conversations
 * therefore re-points the topbar's directory at the header's workdir.
 *
 * A workdir that is gone is not adopted — pointing the host at a directory
 * that does not exist would make every later tree request, every new session
 * and the topbar itself lie. The caller still opens the transcript; this
 * function only says what it did, and `stateEvent()` then keeps the old cwd.
 *
 * Returns the cwd the caller should build its protocol context with.
 */
function adoptSessionWorkdir(workdir) {
  if (typeof workdir !== "string" || workdir.trim() === "") return cwd;
  const resolved = path.resolve(workdir);
  // One `stat` rather than `exists` then `stat`: between the two the folder
  // could vanish, and a `stat` failure already says everything needed. It
  // follows symlinks on purpose — `registerWorkspaceRoot` does too, so a
  // project reached through a link is a real directory here as well.
  let isDirectory = false;
  let reason = "";
  try {
    isDirectory = statSync(resolved).isDirectory();
    if (!isDirectory) reason = "不是目录";
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    // "Gone" and "present but unreadable" are different facts, and the second
    // one must not be reported as the first.
    reason = code === "ENOENT" || code === "ENOTDIR"
      ? "已不存在"
      : `无法访问（${code === "" ? messageOf(error) : code}）`;
  }
  if (!isDirectory) {
    // R3: a record pointing at a folder that is gone or unreadable is said out
    // loud instead of being silently swapped for the boot folder.
    send({
      type: "notice",
      level: "warn",
      text: `会话记录的工作目录${reason}：${resolved}`,
    });
    return cwd;
  }
  cwd = resolved;
  // Same registration as `init`/`setCwd`: the folder has to be browsable by
  // the tree, not merely be where the next session runs. Not awaited — the
  // transcript replay must not wait on the filesystem — but parked so the
  // `getTree` that follows the topbar repaint settles it first.
  pendingRoot = registerRoot(cwd).catch(() => false);
  return cwd;
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
  // Follow the conversation's own project before the context and the `state`
  // are built: both carry a cwd, and they must describe the same folder as
  // the `session_loaded` below. Synchronous, so no other command can slip in
  // between the decision and the events that report it.
  const sessionCwd = adoptSessionWorkdir(detail.header.workdir);
  ctx = kernel.protocol.createContext({ sessionId: id, cwd: sessionCwd });
  const lastSeq = detail.events.at(-1)?.seq ?? -1;
  ctx.lastSeq = lastSeq;
  lastSessionId = id;
  lastSessionMeasure = lastMeasure(detail.events);
  const loaded = kernel.protocol.sessionLoadedEvent(detail.events, {
    // The record's own workdir, even when it no longer exists: the replay is
    // describing that conversation, and `adoptSessionWorkdir` has already
    // said why the topbar is not moving there.
    cwd: detail.header.workdir ?? sessionCwd,
    mode,
  });
  // The shared protocol module emits a literal `auto` here. Overwritten with
  // the real choice so the transcript's header and the `state` that follows
  // do not disagree about what the next request will carry.
  loaded.effort = currentEffort();
  send(loaded);
  // The runner is deliberately not rebuilt here. Rebuilding would discard
  // state that outlives one conversation, and it is not needed for the cwd:
  // `handlePrompt` passes the current `cwd` in its start options for every
  // new session, which overrides the runner's constructor default. So the
  // folder adopted above is also where the next new conversation runs — the
  // topbar names that folder, and a new session using anything else would
  // make the two disagree. A resumed run passes no cwd at all (the kernel
  // reads the header), so this switch cannot alter an existing conversation's
  // workdir either.
  //
  // Waited for, unlike `init`: `setCwd` does the same, and by the time the
  // `state` naming this folder reaches the renderer the kernel already knows
  // the folder is browsable. A failed registration is not fatal — `getTree`
  // carries the reason.
  await settleRoot();
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
 * Probe one model gateway and answer with a `provider_test` event.
 *
 * The probe itself is the kernel's: it resolves `apiKeyEnv` against this
 * process's environment, forwards a directly-typed `apiKey` into the outbound
 * request, and talks to the gateway. The host does not decide the outcome —
 * forwarding a `true` nobody measured would put a green card on an address
 * that was never contacted (R3).
 *
 * The key is write-only from here: it goes into `probeProvider` and nowhere
 * else. Every event text this function sends is passed through `redactKey`
 * first, because a thrown transport error is not ours to control and could
 * quote the request it failed on.
 *
 * Every path answers, so the settings page's card always leaves its "testing"
 * state; only a probe that is still in flight has no event yet.
 */
async function handleTestProvider(payload) {
  const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  // Not the key itself, just a way to keep it out of anything we print.
  const redactKey = (text) => (apiKey === "" ? text : text.split(apiKey).join("***"));
  if (baseUrl === "") {
    send({
      type: "provider_test",
      ok: false,
      baseUrl: "",
      error: "连接测试失败：请先填写模型服务地址（baseUrl）",
    });
    return;
  }
  const probe = probeModule?.probeProvider;
  if (typeof probe !== "function") {
    // A `dist/` built before the probe landed. Say what to do about it; the
    // rest of the host keeps working, which is why this is not fatal.
    send({
      type: "provider_test",
      ok: false,
      baseUrl,
      error: "连接测试不可用：内核未编译该模块，请先在仓库根目录执行 npm run build",
    });
    return;
  }
  const options = {
    baseUrl,
    ...(apiKey === "" ? {} : { apiKey }),
    ...(typeof payload.apiKeyEnv === "string" && payload.apiKeyEnv.trim() !== ""
      ? { apiKeyEnv: payload.apiKeyEnv.trim() }
      : {}),
    ...(typeof payload.model === "string" && payload.model.trim() !== ""
      ? { model: payload.model.trim() }
      : {}),
  };
  let result;
  try {
    result = await probe(options);
  } catch (error) {
    send({
      type: "provider_test",
      ok: false,
      baseUrl,
      error: redactKey(`连接测试失败：${messageOf(error)}`),
    });
    return;
  }
  const record = typeof result === "object" && result !== null ? result : {};
  if (record.ok !== true) {
    const reason = typeof record.error === "string" ? record.error : "";
    send({
      type: "provider_test",
      ok: false,
      baseUrl,
      error: redactKey(reason === "" ? "连接测试失败：内核未给出原因" : reason),
      ...(typeof record.code === "string" && record.code !== "" ? { code: record.code } : {}),
      ...(typeof record.latencyMs === "number" ? { latencyMs: record.latencyMs } : {}),
    });
    return;
  }
  send({
    type: "provider_test",
    ok: true,
    // The address the operator typed, not the kernel's normalized copy: the
    // settings page keys its card on the string it sent.
    baseUrl,
    // Absent, not `[]`: "the gateway did not list models" is a different fact
    // from "it listed none".
    ...(Array.isArray(record.models)
      ? { models: record.models.filter((entry) => typeof entry === "string") }
      : {}),
    ...(typeof record.latencyMs === "number" ? { latencyMs: record.latencyMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// Corpus OTA (Settings → Knowledge base)
// ---------------------------------------------------------------------------
//
// Three commands, and the split between them is the contract (`docs/corpus-ota.md`
// §6): reading the status never touches the network, checking does, and applying
// only happens because the operator clicked. `getCorpusStatus` is therefore the
// only one the page calls on open — the startup check is the kernel's own job,
// and a settings page that re-checked would turn "opening Settings" into a
// network request the user never asked for.
//
// The `CorpusUpdateState` union is the kernel's (`src/corpus/update.ts`), sent
// through unchanged. This host never re-derives a state: a copied switch here
// would eventually disagree with the one that writes `state.json`, and the page
// would then describe a corpus that is not the one on disk (R3).

const CORPUS_CONFIG_FILE = "corpus.json";
const CORPUS_MANIFEST_FILE = "latest.json";

/**
 * Load `corpus.json` the way the kernel does, or say why there is none.
 *
 * `loadCorpusConfig` answers with a discriminated union on purpose: "no file at
 * any level" (`none`), "a file that does not parse" (`invalid`, with the path
 * and the field) and "loaded" are three different situations with three
 * different cures. Collapsing them into one `null` would make a broken file read
 * as "never configured" and send the user looking for a file that is already
 * there (R3).
 *
 * `path` travels with every answer: it is what makes `config_invalid`
 * actionable. When no file exists at any level it names the one the user can
 * create, which is the only level this host can see on every install.
 */
async function readCorpusConfig(modules) {
  const homePath = path.join(harnessHome, CORPUS_CONFIG_FILE);
  let loaded;
  try {
    loaded = await modules.config.loadCorpusConfig({
      harnessHome,
      // Absent in development on purpose: a checkout holds
      // `config/corpus.local.json`, not `corpus.json`, and the build (not this
      // host) is what copies one to the other. See `corpusResourcesRoot`.
      ...(corpusResourcesRoot === undefined ? {} : { resourcesRoot: corpusResourcesRoot }),
    });
  } catch (error) {
    // The loader reports read failures as `invalid` rather than throwing; this
    // is for a shape it did not anticipate, and it still has to become a corpus
    // state rather than a dead host.
    return { config: null, reason: `读取语料配置失败：${messageOf(error)}`, path: homePath };
  }
  if (loaded.kind === "ok") {
    const source = loaded.source;
    return {
      config: loaded.config,
      source,
      // The file that actually won. Showing the home path when the packaged
      // file is the one in use would send the operator to edit a file the
      // loader never read.
      path: source === "resources" && corpusResourcesRoot !== undefined
        ? path.join(corpusResourcesRoot, CORPUS_CONFIG_FILE)
        : homePath,
    };
  }
  if (loaded.kind === "invalid") {
    // `reason` already names the offending file and field; the path is for the
    // page's "where to configure this" line, which has to survive a rebuild.
    return { config: null, reason: loaded.reason, path: homePath };
  }
  return { config: null, reason: CORPUS_CONFIG_MISSING, path: homePath };
}

/**
 * First-run seeding: materialise the bundled corpus and wire up the `kb` MCP
 * server.
 *
 * Two facts this closes, both of them "nothing happened on a fresh install":
 * with no `$HARNESS_HOME/mcp.json` the KB server is never started, so the model
 * has no `kb_*` tools; and with no `kb/current` the settings page can only say
 * `unavailable`. Seeding is what makes a fresh install usable without the
 * operator hand-copying a corpus.
 *
 * **Development and packaged differ in exactly one input.** A checkout holds no
 * `resources/corpus/`, so `resourcesRoot` stays `undefined` and the kernel
 * answers `no_bundled_corpus` — the same shape `corpusResourcesRoot` already
 * uses for `corpus.json`. That is deliberate: a developer's `~/.harness/kb`
 * must not be filled with a shipped corpus that then looks like an OTA result.
 *
 * **Nothing here blocks or fails the boot.** Every outcome is reported at most
 * as a warn notice, and only when something actually went wrong: a successful
 * seed and a deliberate skip are both silent, because neither is the
 * operator's problem. `ready` has already been sent by the time this runs, so a
 * slow disk cannot delay the handshake either.
 *
 * Not queued with `enqueueCorpus` on purpose. That queue orders commands the
 * page issued; seeding happens once before anyone can click, and putting it
 * behind the queue would let a status read answer `unavailable` for a corpus
 * that is about to exist.
 */
async function seedFirstRun() {
  const modules = await seedModule();
  if (modules === undefined) return;

  const { seed, snapshot } = modules;
  if (typeof seed.seedCorpus !== "function" || typeof seed.seedKbMcpEntry !== "function") {
    return;
  }

  // The layout is the kernel's (§3): deriving these paths here would be a
  // second copy of a contract that already has one owner.
  let layout;
  try {
    layout = snapshot.getKbLayout(harnessHome);
  } catch (error) {
    send({
      type: "notice",
      level: "warn",
      text: `知识库初始化跳过：${messageOf(error)}`,
    });
    return;
  }

  // 1. The corpus itself. Packaged, `roots.distParent` is `resources/`, where
  //    the build puts `corpus/` — the same value `readCorpusConfig` already
  //    uses for `corpus.json`.
  try {
    await seed.seedCorpus({
      harnessHome,
      ...(roots.form === "packaged" ? { resourcesRoot: roots.distParent } : {}),
    });
  } catch (error) {
    // A broken install (unreadable corpus, malformed `latest.json`) has to be
    // visible: the alternative is a knowledge base that quietly is not there.
    send({
      type: "notice",
      level: "warn",
      text: `内置知识库初始化失败：${messageOf(error)}`,
    });
  }

  // 2. The MCP entry, so the model gets the `kb_*` tools and `getKb`/OTA point
  //    at the same root.
  //
  //    Runs in development too, and the kernel skips it when `kb/current` does
  //    not exist. That skip is the whole point of this ordering: writing
  //    `mcp.json` on a machine with no corpus would make `getKb` report a
  //    missing directory instead of falling back to the checkout's
  //    `mcp-servers/kb/kb`, which is strictly worse — and the MCP server it
  //    would launch would answer from an empty root.
  try {
    // The answer is deliberately not branched on. `kb_entry_exists`,
    // `no_current_snapshot`, `kb_server_missing` and `kb_root_env_override` are
    // all legitimate states, not failures: the user configured their own
    // server, this machine has no corpus yet, the kernel's MCP server is not
    // built, or the operator pinned `KB_ROOT`. Announcing any of them at every
    // launch would be noise about a situation the operator created.
    await seed.seedKbMcpEntry({
      harnessHome,
      kernelRoot: roots.distParent,
      currentKbRoot: layout.currentLink,
      inboxPath: path.join(layout.inboxDir, "_inbox.md"),
      mcpModules: { readAppConfig: kernel.readAppConfig, writeMcpServers: kernel.writeMcpServers },
    });
  } catch (error) {
    // This one is a failure: `readAppConfig` refused to read a file it cannot
    // parse, or the write did not land. Either way the operator has to know
    // why the `kb` tools are missing.
    send({
      type: "notice",
      level: "warn",
      text: `知识库 MCP 配置写入失败：${messageOf(error)}`,
    });
  }
}

/**
 * `latest.json`'s address, joined the way `src/corpus/update.ts` joins it.
 *
 * This is the one piece of the kernel's URL handling copied here, and it is
 * copied because the capturing fetch below has to recognise the manifest
 * response by URL. Validation guarantees the trailing `/` (`corpus-config.ts`),
 * so the two spellings cannot differ today; should that ever change, the
 * capture simply misses and `apply` falls back to re-checking — a slower path,
 * not a wrong one.
 */
function corpusManifestUrl(updateBaseUrl) {
  const base = updateBaseUrl.endsWith("/") ? updateBaseUrl : `${updateBaseUrl}/`;
  return new URL(CORPUS_MANIFEST_FILE, base).toString();
}

function corpusConfigFingerprint(config) {
  // Both fields decide what a manifest means: the address says where it came
  // from, the key says who signed it. A cache that survived either changing
  // would be a manifest the current config never vouched for.
  return `${config.updateBaseUrl}\n${config.publicKeyPem}`;
}

/**
 * Drop a leading UTF-8 BOM.
 *
 * Tested by code point, not by a literal: a U+FEFF pasted into source is
 * invisible in review and dies the moment the file is re-encoded. Same rule and
 * same reason as `stripBom` in `src/corpus/update.ts` and
 * `src/config/corpus-config.ts`.
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Where the manifest text came from, so the caller can say which it used.
 * Kept as a value rather than a boolean: the log line and the tests both read it.
 */
const CORPUS_MANIFEST_FROM_CACHE = "cache";
const CORPUS_MANIFEST_FROM_CHECK = "check";

/**
 * Run `checkForUpdate` while keeping a copy of the manifest it fetched.
 *
 * The kernel's check returns a state, not the manifest, and `applyUpdate` needs
 * the parsed manifest. Re-fetching it here would mean this host implementing
 * the HTTP-status rules of contract §6.1 — including the one that says a 403
 * from OBS means "not published / no GetObject", never "up to date". That is
 * exactly the rule that must not exist twice. Instead the fetch is wrapped:
 * `checkForUpdate` does all of the talking, and its response body is cloned on
 * the way past.
 *
 * Cloning is what makes this safe: `checkForUpdate` still reads the body from
 * the response it was given, and the copy is only used if the check itself
 * concluded `update_available` — i.e. only after the kernel parsed and verified
 * those bytes. Nothing that failed verification can reach `applyUpdate` through
 * here.
 */
async function checkCorpusWithManifest(modules, config) {
  const manifestUrl = corpusManifestUrl(config.updateBaseUrl);
  let captured = null;
  const recordingFetch = async (url, init) => {
    const response = await globalThis.fetch(url, init);
    if (url === manifestUrl && response.status === 200) {
      try {
        captured = await response.clone().text();
      } catch {
        // The clone is an optimisation. A body that cannot be duplicated leaves
        // `captured` null and the caller re-checks instead.
        captured = null;
      }
    }
    return response;
  };

  const status = await modules.update.checkForUpdate({
    harnessHome,
    config,
    fetchImpl: recordingFetch,
  });
  return { status, manifestText: status.kind === "update_available" ? captured : null };
}

/** A sentence for a state that carries one; the union has no other shape. */
function corpusStatusReason(status) {
  if (status.kind === "up_to_date") {
    return `已安装的语料版本就是 v${status.corpusVersion}，无需更新`;
  }
  if ("reason" in status && typeof status.reason === "string") return status.reason;
  // `bundled` and `unavailable` carry no explanation of their own; reaching
  // here means a check answered with a state only a status read produces.
  return `更新源没有可用的新版清单（当前状态：${status.kind}）`;
}

function sendCorpusKernelMissing() {
  send({
    type: "notice",
    level: "warn",
    text: "语料更新不可用：内核未编译，请先在仓库根目录运行 npm run build",
  });
  // The page needs an answer or it waits forever; `error` is not one of the
  // seven states, and inventing one would be a claim about a corpus this host
  // could not read.
  send({ type: "corpus_status", error: "内核未编译，无法读取语料更新状态（请先 npm run build）" });
}

async function handleCorpusStatus() {
  // Same reason as `getKb`: a seed still copying the bundled corpus would have
  // this answer `unavailable` for a corpus that is about to exist, and nothing
  // would refresh the page afterwards. The seed never throws.
  if (seedFirstRunPromise !== undefined) await seedFirstRunPromise;

  const modules = await corpusModule();
  if (modules === undefined) {
    sendCorpusKernelMissing();
    return;
  }

  const { config, reason, source, path: configPath } = await readCorpusConfig(modules);

  let status = null;
  let readError = "";
  try {
    status = await modules.update.readCorpusStatus({ harnessHome });
  } catch (error) {
    readError = messageOf(error);
  }

  /**
   * Which of the seven states this is.
   *
   * `unavailable` outranks the config verdict: with no `kb/current` there is no
   * corpus to update at all, and pointing the user at `corpus.json` would send
   * them to fix the second thing first. A status read that threw outranks both
   * — it is the one fact here that is not a supported state.
   *
   * `config_invalid` otherwise replaces the stored state rather than sitting
   * beside it, because the update feature genuinely cannot run: contract §2
   * says the knowledge base keeps working while updates report
   * `corpus_config_invalid`.
   */
  let reported;
  if (status === null) {
    reported = { kind: "check_failed", reason: `读取语料状态失败：${readError}`, checkedAt: "" };
  } else if (status.kind === "unavailable") {
    reported = status;
  } else if (config === null) {
    reported = { kind: "config_invalid", reason };
  } else {
    reported = status;
  }

  send({
    type: "corpus_status",
    status: reported,
    ...(source === undefined ? {} : { configSource: source }),
    configPath,
  });
}

async function handleCorpusCheck() {
  // A check started before the seed finished would compare the remote version
  // against a local version that is still being materialised, and could even
  // race `setCurrent`. The seed is a one-off filesystem copy and never throws,
  // so waiting costs at most that copy on the very first launch.
  if (seedFirstRunPromise !== undefined) await seedFirstRunPromise;

  const modules = await corpusModule();
  if (modules === undefined) {
    sendCorpusKernelMissing();
    return;
  }

  const { config, reason, source, path: configPath } = await readCorpusConfig(modules);
  if (config === null) {
    // No request to make: say so in the same shape a failed check uses, so the
    // page has one state machine instead of a special case.
    send({
      type: "corpus_status",
      status: { kind: "config_invalid", reason },
      ...(source === undefined ? {} : { configSource: source }),
      configPath,
    });
    return;
  }

  try {
    const { status, manifestText } = await checkCorpusWithManifest(modules, config);
    if (status.kind === "update_available" && manifestText !== null) {
      corpusManifestCache = {
        fingerprint: corpusConfigFingerprint(config),
        text: manifestText,
        corpusVersion: status.corpusVersion,
      };
    } else if (status.kind !== "update_available") {
      // A check that concludes anything else makes the previous manifest a
      // statement about a source that has since changed (or about a version
      // that is already installed).
      corpusManifestCache = null;
    }
    send({
      type: "corpus_status",
      status,
      ...(source === undefined ? {} : { configSource: source }),
      configPath,
    });
  } catch (error) {
    // `checkForUpdate` is documented as never throwing; this is the belt for a
    // host whose kernel is older or newer than the contract.
    send({
      type: "corpus_status",
      status: {
        kind: "check_failed",
        reason: `检查更新失败：${messageOf(error)}`,
        checkedAt: new Date().toISOString(),
      },
      ...(source === undefined ? {} : { configSource: source }),
      configPath,
    });
  }
}

/**
 * The manifest to install, and where it came from.
 *
 * Two sources, in this order:
 *
 * 1. The text the last successful check fetched and verified, when the config
 *    it was verified under is still the current one. That is what makes "update
 *    to what I was shown" true rather than approximate, and it costs no request.
 * 2. A fresh check, run through the same capturing wrapper — used when there is
 *    no cache or the cache belongs to another config. The kernel decides whether
 *    there is anything to install, so a failed or pointless re-check answers
 *    with its own state instead of a second paraphrase from this host.
 *
 * Either way the text goes through `applyUpdate`, which parses and verifies the
 * signature again before touching disk. Nothing this host fetched is trusted on
 * its own say-so.
 */
async function resolveCorpusManifest(modules, config) {
  const fingerprint = corpusConfigFingerprint(config);
  if (corpusManifestCache !== null && corpusManifestCache.fingerprint === fingerprint) {
    return { ok: true, text: corpusManifestCache.text, from: CORPUS_MANIFEST_FROM_CACHE };
  }

  const { status, manifestText } = await checkCorpusWithManifest(modules, config);
  if (status.kind !== "update_available" || manifestText === null) {
    return { ok: false, status };
  }
  corpusManifestCache = {
    fingerprint,
    text: manifestText,
    corpusVersion: status.corpusVersion,
  };
  return { ok: true, text: manifestText, from: CORPUS_MANIFEST_FROM_CHECK };
}

async function handleCorpusApply() {
  // Same reason as the check: an apply racing the seed would have two writers
  // switching `current` over one `snapshots/` tree.
  if (seedFirstRunPromise !== undefined) await seedFirstRunPromise;

  const modules = await corpusModule();
  if (modules === undefined) {
    sendCorpusKernelMissing();
    return;
  }

  const { config, reason } = await readCorpusConfig(modules);
  if (config === null) {
    send({ type: "corpus_update_result", ok: false, reason });
    return;
  }

  const resolved = await resolveCorpusManifest(modules, config);
  if (!resolved.ok) {
    send({ type: "corpus_update_result", ok: false, reason: corpusStatusReason(resolved.status) });
    // The state may have moved (a re-check can write `check_failed`), so the
    // seven-state display is refreshed rather than left describing a moment
    // before this click.
    await handleCorpusStatus();
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(stripBom(resolved.text));
  } catch (error) {
    // Unreachable through the cache (the kernel parsed these bytes) but this
    // is the boundary where they become an object again.
    send({
      type: "corpus_update_result",
      ok: false,
      reason: `更新源返回的 latest.json 不是合法 JSON（${messageOf(error)}）`,
    });
    return;
  }

  let result;
  try {
    result = await modules.update.applyUpdate({
      harnessHome,
      config,
      manifest,
      onProgress: (progress) => {
        // The kernel's own counts, forwarded as they happen. No timer, no
        // estimated percentage: a progress line that moves on its own is the
        // fake progress bar this page must not have.
        send({
          type: "corpus_update_progress",
          completed: progress.completed,
          total: progress.total,
          path: progress.path,
          action: progress.action === "reused" ? "reused" : "downloaded",
        });
      },
    });
  } catch (error) {
    result = { ok: false, reason: `更新失败：${messageOf(error)}`, corpusVersionUnchanged: null };
  }

  if (result.ok === true) {
    // The installed version is now on disk; a stale cache would offer to
    // install it again.
    corpusManifestCache = null;
    send({ type: "corpus_update_result", ok: true, corpusVersion: result.corpusVersion });
    // The tree on this page describes the corpus that was just replaced.
    // Re-reading it is the only way it can keep describing what is there.
    void handlers.getKb();
  } else {
    send({
      type: "corpus_update_result",
      ok: false,
      reason: result.reason,
      corpusVersionUnchanged: result.corpusVersionUnchanged ?? null,
    });
  }
  await handleCorpusStatus();
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
    // The panel owns the COM handle, so the agent's `embed_serial write`
    // leaves a request file for this process to execute — the only process
    // that can. Idle cost is one readdir per tick.
    serialBridge.startMailbox();
    // Same reason as `providers` above: a config file the app cannot parse is
    // an error the settings page shows, not a reason to refuse to boot.
    if (config?.providersError !== undefined) providersError = config.providersError;
    send(stateEvent());
    send({ type: "ready" });
    send(sessionsEvent());
    // The skills are read once here and the same snapshot feeds both pushes,
    // so the settings page and the `/` menu cannot describe two different
    // libraries within one handshake. A kernel without the store still answers
    // with an empty list and no warning: boot is not a place to complain about
    // a module nobody asked for yet, and `getSkills` is where the operator
    // learns it is missing. The empty event is still required — the settings
    // page may open before the store's answer would ever arrive.
    const skills = readSkillsSnapshot();
    send({ type: "skills", ...(skills ?? { skills: [], problems: [] }) });
    // The same catalogue `listCommands` answers with: the popup must be usable
    // before the renderer's own `listCommands` arrives, and two sources for one
    // list is how they drift apart.
    send({ type: "commands", commands: commandCatalogue(skills) });
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

    // First-run seeding runs *after* the handshake, not inside it: a fresh
    // install may have a corpus to copy and a disk to wait on, and `init` must
    // not make `ready` wait on the filesystem. Parked like `pendingRoot` above,
    // and swallowed for the same reason — `seedFirstRun` reports its own
    // failures as notices, so a rejected promise here would only duplicate them.
    if (seedFirstRunPromise === undefined) {
      seedFirstRunPromise = seedFirstRun().catch(() => undefined);
    }
  },

  prompt(payload) {
    return handlePrompt(payload.text);
  },

  abort() {
    // The compaction check comes before the runner guard: a compaction holds
    // no runner entry, and a host whose runner was never built must still be
    // able to stop one.
    if (runner === undefined && compactAbort === undefined) return;
    handleAbort();
  },

  /**
   * `/compact` — run the kernel's compaction on the open session.
   *
   * Not returned to the command queue for the same reason `testProvider` is
   * not: the summary is one model call and can take as long as the gateway
   * does, and `abort` must still reach `handleAbort` while it runs. That
   * handler knows to stop this first.
   */
  compact() {
    void handleCompact();
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
    const previous = mode;
    if (previous === payload.mode) return;
    mode = payload.mode;
    // The preset is read when a run *starts*, so a switch made mid-turn cannot
    // change what the operator already approved — and blocking it was worse
    // than allowing it: `ctx.running` is cleared only by a kernel `done` /
    // `interrupted` event, so one turn that ended without either left the
    // switch dead for the rest of the session, silently. Storing the choice
    // now and letting the next run pick it up is both safe and what the label
    // promises.
    // Rebuild only when no turn is open: closing a runner out from under a
    // live run would drop its session registry entry.
    if (!ctx.running) {
      void runner?.close();
      runner = createRunner();
    }
    send(stateEvent());
    send({
      type: "notice",
      level: "dim",
      text: ctx.running
        ? `权限模式：${previous} → ${mode}（本轮结束后生效）`
        : `权限模式：${previous} → ${mode}`,
    });
  },

  /**
   * The settings page's permissions form.
   *
   * It writes the file for the *next* host launch, but the operator changed
   * the switch expecting the switch to move: leaving the live mode untouched
   * made "完全访问" a setting that appeared to do nothing while every write
   * still asked. The running mode is now applied here too — through the same
   * guard as the composer's menu, so a mid-run change is still refused with
   * the same notice rather than silently deferred to the next launch.
   */
  async savePermissions(payload) {
    const wanted = payload.permissions;
    if (typeof wanted !== "object" || wanted === null) {
      send({ type: "notice", level: "warn", text: "缺少 permissions 对象" });
      return;
    }
    const presets = ["read-only", "workspace-write", "diagnose", "danger-full-access"];
    const wantedPreset = wanted.preset;
    const switchesMode = typeof wantedPreset === "string" && presets.includes(wantedPreset) && wantedPreset !== mode;
    if (switchesMode && ctx.running) {
      send({ type: "notice", level: "warn", text: "运行中不能切换权限模式；新预设已保存，下一轮生效" });
    }
    try {
      await kernel.writePermissionConfig(harnessHome, wanted);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `权限配置未保存：${messageOf(error)}` });
      return;
    }
    if (switchesMode && !ctx.running) {
      mode = wantedPreset;
      void runner?.close();
      runner = createRunner();
    }
    configEvent();
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
   * Where the knowledge base is and what is under it.
   *
   * The root is not `$HARNESS_HOME/kb`: the real corpus lives wherever the KB
   * MCP server's `KB_ROOT` points (default `<repo>/mcp-servers/kb/kb`). The
   * kernel's `resolveKbRoot` owns that precedence so this handler cannot drift
   * from what the MCP server itself would read; `source` and `note` travel to
   * the settings page, which has to be able to say "not found" instead of
   * drawing an empty knowledge base (R3).
   */
  async getKb() {
    const located = await kbModule();
    if (typeof located?.resolveKbRoot !== "function" || typeof located.scanKbRoot !== "function") {
      // A `dist/` built before the locator landed. One settings-page command
      // must not take the host down, so the failure is reported and the
      // renderer's pending request is released with an empty answer.
      send({
        type: "notice",
        level: "warn",
        text: "知识库不可用：内核未编译，请先 npm run build",
      });
      send({
        type: "kb",
        kb: { root: "", source: "none", fileCount: 0, indexPresent: false, truncated: false, tree: [] },
      });
      return;
    }
    // Settle the first-run seed first: it may be writing `mcp.json` right now,
    // and a root resolved a moment earlier would describe a corpus that is
    // already superseded. The seed never throws, so this cannot turn a page
    // opening into a failure.
    if (seedFirstRunPromise !== undefined) await seedFirstRunPromise;
    const location = located.resolveKbRoot({ harnessHome, repoRoot });
    try {
      const scan = await located.scanKbRoot(location.root);
      send({
        type: "kb",
        kb: {
          ...location,
          fileCount: scan.fileCount,
          indexPresent: scan.indexPresent,
          truncated: scan.truncated,
          tree: scan.tree,
        },
      });
    } catch (error) {
      // A read failure is a fact the page shows, not a reason to send nothing.
      send({
        type: "kb",
        kb: {
          ...location,
          fileCount: 0,
          indexPresent: false,
          truncated: false,
          tree: [],
          error: messageOf(error),
        },
      });
    }
  },

  /**
   * What the corpus updater knows, without asking anyone.
   *
   * The knowledge-base page calls this when it opens. It must not reach the
   * network: opening Settings is not a request to check for updates, and the
   * startup check (contract §6) has already written whatever `state.json` is
   * going to say. `readCorpusStatus` is the kernel's own reader of that file,
   * so the seven states here are the same seven the update path produces.
   */
  getCorpusStatus() {
    // Queued as well, not answered from beside the queue: a status read that
    // overtook a running apply would describe the corpus as it was before the
    // install, and the page would show the old version until the next visit.
    void enqueueCorpus(handleCorpusStatus);
  },

  /**
   * Ask the update source. **This touches the network**, so it only ever runs
   * from the operator's click.
   *
   * Not returned to the NDJSON command queue for the same reason
   * `testProvider` is not: a check waits on a request with the kernel's own
   * timeout (30 s), and the rest of the window must keep answering while it
   * does. Corpus commands are ordered among themselves by `enqueueCorpus`, so
   * "check, then update" from one page cannot interleave.
   */
  checkCorpusUpdate() {
    void enqueueCorpus(handleCorpusCheck);
  },

  /**
   * Install the version the last check reported. Also a network operation —
   * every changed file is downloaded — and it is the operator's click that
   * starts it, never the page opening (contract §6: no automatic apply).
   */
  applyCorpusUpdate() {
    void enqueueCorpus(handleCorpusApply);
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

  async saveRunLimits(payload) {
    const wanted = payload.run;
    if (typeof wanted !== "object" || wanted === null) {
      send({ type: "notice", level: "warn", text: "缺少 run 对象" });
      return;
    }
    // The settings page writes the file whole and does not know about the
    // effort table (it is filled by the composer's popover, not by that form).
    // Carrying the host's copy through means saving `maxTurns` cannot silently
    // erase which level each model was set to; a caller that does send the
    // field still wins, because its value is what is being written.
    const merged = wanted.reasoningEffortByModel === undefined
      ? { ...wanted, reasoningEffortByModel: { ...effortTable() } }
      : wanted;
    try {
      runLimits = await kernel.writeRunLimits(harnessHome, merged);
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
   * Probe one model gateway for the settings page.
   *
   * Deliberately not returned to the command queue: a probe can take the
   * kernel's full timeout, and `abort` / `listSessions` must still answer while
   * the operator waits. `handleTestProvider` catches everything itself, so
   * there is no unhandled rejection behind the `void`.
   */
  testProvider(payload = {}) {
    void handleTestProvider(payload);
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
    // Keys are `id@createdAt`, not the bare id — deleting by id alone left
    // every entry in place, so a later session reusing the id would have
    // inherited this one's title.
    for (const key of [...titleCache.keys()]) {
      if (key.startsWith(`${id}@`)) titleCache.delete(key);
    }
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
   * Choose the reasoning effort for the next run of the selected model.
   *
   * The value is real: it lands in `run.json` (keyed by model reference, so a
   * later restart and a model switch both keep their own choice) and
   * `handlePrompt` hands it to the kernel, which puts it on the wire as
   * `reasoning_effort`.
   *
   * Refusals are specific rather than generic. A model that never declared
   * `supportsReasoning` gets a warning naming the field to edit; an unknown
   * level gets the accepted set. Either way nothing is written and no `state`
   * is sent — a `state` is the host's claim that the value now applies, and
   * that would be false.
   */
  async setEffort(payload = {}) {
    const wanted = typeof payload.effort === "string" ? payload.effort : "";
    const cfg = currentModelCfg();
    if (cfg === undefined) {
      send({ type: "notice", level: "warn", text: "没有可用模型，无法设置推理强度" });
      return;
    }
    if (!kernel.supportsReasoning(cfg)) {
      // `auto` is still accepted: it means "send nothing", which is exactly
      // what this model's requests do, so refusing it would be false. Anything
      // else is refused, naming the model and the field to edit — "unsupported"
      // alone sends the operator hunting.
      if (wanted === "auto") {
        delete effortTable()[modelRef];
        if (!(await persistEffort())) return;
        send(stateEvent());
        return;
      }
      send({
        type: "notice",
        level: "warn",
        text: `${modelRef} 不接受推理强度参数（providers.json 里该模型未声明 supportsReasoning），当前只支持 auto`,
      });
      return;
    }
    if (wanted !== "auto" && !kernel.isReasoningEffort(wanted)) {
      send({
        type: "notice",
        level: "warn",
        text: `不支持的推理强度：${JSON.stringify(wanted)}；该模型支持 auto, ${EFFORT_LEVELS.join(", ")}`,
      });
      return;
    }
    const table = effortTable();
    const previous = table[modelRef];
    if (wanted === "auto") {
      // "auto" is the absence of a choice, not a level: remove the entry so a
      // future default in providers.json applies again.
      delete table[modelRef];
    } else {
      table[modelRef] = wanted;
    }
    // Awaited, not fired and forgotten: the command queue runs one command at a
    // time, so awaiting here means the `state` below is only sent after the
    // value is on disk. A write that failed has already put the old value back
    // and said so, and this returns without claiming success.
    if (!(await persistEffort())) {
      if (previous === undefined) delete table[modelRef];
      else table[modelRef] = previous;
      return;
    }
    send(stateEvent());
    // The settings page keeps its own copy of `run.json` and writes it back
    // whole on every control it owns. Without this push that copy still has the
    // pre-click table, and the next `maxTurns` edit would revert this choice.
    configEvent();
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

  /**
   * The slash commands this form can actually run.
   *
   * The three builtins have a real handler here: `/clear` maps to
   * `newSession`, `/context` is answered by the renderer from the kernel's own
   * measurement, and `/compact` runs the kernel's compaction. A verb with no
   * route behind it would be a menu row that fails on click (R3), so the
   * builtin list is short on purpose.
   *
   * Saved skills follow as `source: "skill"` rows. They are read from disk on
   * every call — the files are hand-editable, and a remembered list would
   * answer a question about a folder nobody re-read.
   */
  listCommands() {
    send({ type: "commands", commands: commandCatalogue() });
  },

  /**
   * The whole skill library, for the settings page.
   *
   * A kernel without the store is answered, not ignored: a warn notice names
   * the fix and the empty `skills` event releases the renderer's pending
   * request, which would otherwise wait for a library that cannot arrive.
   */
  getSkills() {
    const snapshot = readSkillsSnapshot();
    if (snapshot === undefined) {
      skillNotice(SKILLS_MISSING);
      send({ type: "skills", skills: [], problems: [] });
      return;
    }
    send({ type: "skills", ...snapshot });
  },

  /**
   * Write one skill file, then answer from the disk.
   *
   * The payload is an input, not a record: `writeSkill` validates the name
   * (the file name is the skill's name, so a bad name is a path, not a typo)
   * and decides where the file lands from `scope`. A failed save broadcasts
   * nothing — a `skills` event after a refusal would redraw the page as if the
   * edit had landed, and the next read would silently undo it.
   *
   * On success the library is re-read rather than echoed back from the input:
   * the store normalizes what it writes (front matter order, body trimming),
   * and the page has to show what a later boot would show.
   */
  async saveSkill(payload = {}) {
    const wanted = payload.skill;
    if (typeof wanted !== "object" || wanted === null || Array.isArray(wanted)) {
      skillNotice("技能未保存：缺少 skill 对象");
      return;
    }
    const store = skillStore();
    if (store === undefined || typeof store.writeSkill !== "function") {
      skillNotice(SKILLS_MISSING);
      return;
    }
    // The name is handed over as sent, not trimmed or pre-validated:
    // `SKILL_NAME_PATTERN` belongs to the store, and it is the one rule that
    // decides both the file name and whether `/name` can ever address the
    // skill. A second copy here would be a second opinion the palette does not
    // share; the store's rejection reaches the operator through the `catch`
    // below, worded by the component that owns the constraint.
    try {
      await store.writeSkill(skillsLocation(), {
        name: String(wanted.name ?? ""),
        description: String(wanted.description ?? ""),
        argumentHint: String(wanted.argumentHint ?? ""),
        // Passed through, not coerced. The store rejects an unknown scope with
        // a message naming the two it accepts; mapping `"projct"` to `"user"`
        // here would write the skill into the wrong library and tell nobody.
        scope: wanted.scope,
        body: String(wanted.body ?? ""),
      });
    } catch (error) {
      skillNotice(`技能未保存：${messageOf(error)}`);
      return;
    }
    broadcastSkills();
  },

  /**
   * Delete one skill file.
   *
   * `false` from the store is "nothing was deleted" and is answered as such
   * (R3): the row the operator clicked may have been removed from disk by hand
   * a moment earlier, and a redraw with no notice would look like the delete
   * worked. The name and scope travel back in the notice so the operator knows
   * which of the two libraries was searched — the same skill name may exist in
   * both, and only one of them was asked about.
   */
  async removeSkill(payload = {}) {
    const name = String(payload.name ?? "").trim();
    // Same rule as `saveSkill`: the store owns what a valid scope is, and a
    // coerced default here would search one library while the operator meant
    // the other. `removeSkill` has no "remember the last scope" fallback on
    // purpose — deleting is not a place to guess.
    const scope = payload.scope;
    if (name === "") {
      skillNotice("技能未删除：名称不能为空");
      return;
    }
    const store = skillStore();
    if (store === undefined || typeof store.removeSkill !== "function") {
      skillNotice(SKILLS_MISSING);
      return;
    }
    let removed;
    try {
      removed = await store.removeSkill(skillsLocation(), { name, scope });
    } catch (error) {
      skillNotice(`技能未删除：${messageOf(error)}`);
      return;
    }
    if (removed !== true) {
      const where = scope === "project" ? "项目" : "用户";
      skillNotice(`技能未删除：${where}技能里没有 ${name}（可能已被删除）`);
      return;
    }
    broadcastSkills();
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

  /**
   * File-name matches for the composer's `@` popup.
   *
   * The kernel owns both the walk and the boundary (`searchFilesByName` uses
   * the same `resolveReadableDirectory` as `getTree`), so the desktop and
   * browser forms answer from the same rules. The root is the host's current
   * workspace — the same `cwd` the topbar shows and the next session runs in.
   *
   * Every failure still answers with a `file_matches` carrying the query: the
   * renderer only releases the popup on that event, so staying silent would
   * leave it waiting forever. A refusal says why in a `notice` (R3); a truncation
   * rides along as `truncated` because "not all matches" is not "no matches".
   */
  async searchFiles(payload = {}) {
    const query = typeof payload.query === "string" ? payload.query : "";
    // A keystroke-driven command must not wait on a registration that the boot
    // handshake has not finished yet; a failed one is reported by the search.
    await settleRoot();
    const search = kernel.filesApi?.searchFilesByName;
    if (typeof search !== "function") {
      // A `dist/` built before the search landed. Warn once per process: the
      // popup asks on every keystroke, and one notice per character would bury
      // the transcript. The empty answer still releases the popup.
      if (!searchUnavailableWarned) {
        searchUnavailableWarned = true;
        send({
          type: "notice",
          level: "warn",
          text: "文件搜索不可用：内核未导出 searchFilesByName，请先执行 npm run build",
        });
      }
      send({
        type: "file_matches",
        query,
        files: [],
        truncated: false,
        scanned: 0,
      });
      return;
    }
    if (cwd === "") {
      // No workspace open: there is no folder to search. Not an error.
      send({ type: "file_matches", query, files: [], truncated: false, scanned: 0 });
      return;
    }
    let result;
    try {
      result = await search(harnessHome, cwd, query);
    } catch (error) {
      send({ type: "notice", level: "warn", text: `文件搜索失败：${messageOf(error)}` });
      send({ type: "file_matches", query, files: [], truncated: false, scanned: 0 });
      return;
    }
    const files = Array.isArray(result?.files) ? result.files : [];
    send({
      type: "file_matches",
      query,
      files: files.map((file) => file.path),
      // 两种截断对弹窗是同一件事：列表不是全部。
      truncated: result?.truncated === true || result?.scanTruncated === true,
      scanned: typeof result?.scanned === "number" ? result.scanned : 0,
    });
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
    stopBackgroundPump();
    serialBridge.stopMailbox();
    void serialBridge.closeAll();
    // Detached builds must not survive the window that started them: they are
    // `unref`-ed on purpose (so a finished one cannot hold the process open),
    // which also means nothing else will reap a running one. The kernel sends
    // the kill signal; it cannot confirm death from a shutdown path, and the
    // notice says exactly that rather than claiming they exited.
    const signalled = kernel.background?.killAllBackgroundJobs?.() ?? 0;
    if (signalled > 0) {
      send({
        type: "notice",
        level: "dim",
        text: `已终止 ${signalled} 个后台作业（仅发出终止信号，未能确认退出）`,
      });
    }
    void runner?.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  },

  // -------------------------------------------------------------------------
  // Serial monitor. The renderer's pane has been waiting on these since it
  // was written (D-166); the bridge owns the port through a PowerShell pump,
  // and the agent reads the same ring through the embed_serial MCP tool —
  // the port is exclusive, the data is shared.
  // -------------------------------------------------------------------------
  async serialOpen({ port, baud, encoding }) {
    const baudNum = Number(baud) || 115200;
    const result = await serialBridge.open(String(port ?? ""), baudNum, { encoding });
    if (!result.ok) {
      send({ type: "serial_state", open: false, port: String(port ?? ""), baud: baudNum, error: result.error });
      return;
    }
    send({ type: "serial_snapshot", ...result.snapshot });
  },

  async serialClose() {
    const ports = serialBridge.openPorts;
    await Promise.all(ports.map((port) => serialBridge.close(port)));
    if (ports.length === 0) {
      // Nothing was open; the renderer's toggle still wants the state back.
      send({ type: "serial_state", open: false });
    }
  },

  serialStatus() {
    const port = serialBridge.openPorts[0];
    if (port === undefined) {
      send({ type: "serial_state", open: false });
      return;
    }
    send({ type: "serial_snapshot", open: true, port, baud: serialBridge.sessionOf(port).baud, lines: [], dropped: 0 });
  },

  serialClear() {
    const port = serialBridge.openPorts[0];
    if (port !== undefined) {
      const session = serialBridge.sessionOf(port);
      session.ring.length = 0;
      session.dropped = 0;
    }
    send({ type: "serial_cleared" });
  },

  serialWrite({ data, hex }) {
    const port = serialBridge.openPorts[0];
    if (port === undefined || typeof data !== "string" || data === "") {
      send({ type: "notice", level: "warn", text: "serialWrite：无已打开的串口或数据为空" });
      return;
    }
    if (!serialBridge.write(port, data, { hex: hex === true })) {
      send({ type: "notice", level: "warn", text: `serialWrite：${port} 写入失败` });
    }
  },

  /** Manual modem-line control (DTR/RTS): the board-reset gesture. */
  serialLine({ line, value }) {
    const port = serialBridge.openPorts[0];
    if (port === undefined) {
      send({ type: "notice", level: "warn", text: "serialLine：无已打开的串口" });
      return;
    }
    if (!serialBridge.setLine(port, line, value === true)) {
      send({ type: "notice", level: "warn", text: `serialLine：${port} ${line} 设置失败` });
    }
  },

  /** Runtime baud change without dropping the line. */
  serialBaud({ baud }) {
    const port = serialBridge.openPorts[0];
    if (port === undefined) {
      send({ type: "notice", level: "warn", text: "serialBaud：无已打开的串口" });
      return;
    }
    if (!serialBridge.setBaud(port, baud)) {
      send({ type: "notice", level: "warn", text: "serialBaud：波特率无效（300–4000000）" });
    }
  },

  /** Runtime text-codec change (utf-8 / gbk) without dropping the line. */
  serialEncoding({ encoding }) {
    const port = serialBridge.openPorts[0];
    if (port === undefined) {
      send({ type: "notice", level: "warn", text: "serialEncoding：无已打开的串口" });
      return;
    }
    if (!serialBridge.setEncoding(port, encoding)) {
      send({ type: "notice", level: "warn", text: "serialEncoding：编码切换失败" });
    }
  },

  async listSerialPorts() {
    const ports = await listSerialPorts();
    // The pane's port dropdown also feeds from board_state.ports; serial
    // enumeration is the authoritative one for the monitor, so it ships here.
    send({ type: "serial_ports", ports });
  },

  /**
   * Board pane refresh. The kernel has no machine scanner, so what the host
   * can answer truthfully is the serial side (ports from WMI, the mirror
   * state the panel itself owns) plus the session selection; the target/
   * flash answers only the agent's probe tools can give. The renderer knows
   * this shape and prompts the agent for the tool half when the user asks
   * for a refresh — this handler never pretends to know a part number.
   */
  async getBoardState() {
    const ports = await listSerialPorts();
    // The device half comes from the MCP backends directly: a short-lived
    // manager connects to the configured embedded servers and calls their
    // read-only status tools. No model, no agent turn, no approval — read-only
    // by whitelist in board-probe.js. Slow path (connect ~seconds), so it
    // races the serial half and the answer lands in a second event.
    const devicePromise = probeBoardDevices();
    devicePromise.then((devices) => {
      if (devices.length > 0) send({ type: "board_devices", devices });
    });
    const mirrorPath = serialRingPath();
    let serial = { open: false };
    let serialTail = [];
    try {
      if (existsSync(mirrorPath)) {
        const mirror = JSON.parse(readFileSync(mirrorPath, "utf8"));
        const entry = mirror.ports?.[0];
        if (entry) {
          serial = { open: true, port: entry.port, baud: entry.baud, lines: entry.lines?.length ?? 0, dropped: entry.dropped ?? 0 };
          // A short tail for the board pane's preview: five lines is enough to
          // see the device is alive without duplicating the serial pane.
          serialTail = (entry.lines ?? []).slice(-5).map((line) => ({ text: String(line.text ?? "").slice(0, 120), at: line.at, level: line.level }));
        }
      }
    } catch {
      // A torn mirror reads as closed; the serial pane is the authority anyway.
    }
    send({
      type: "board_state",
      state: {
        scannedAt: Date.now(),
        project: state_boardProject(),
        ports,
        serial,
        serialTail,
        selection: boardSelection,
        effective: { port: boardSelection?.port, baud: boardSelection?.baud },
      },
    });
  },

  setBoardSelection({ selection }) {
    boardSelection = typeof selection === "object" && selection !== null ? { ...selection } : {};
    // Re-answer with the merged state so the pane never shows a value the
    // tools would not use.
    void handlers.getBoardState();
  },

  // ---- 工具链包 -------------------------------------------------------------
  // 消息形状以 settings.js 已消费的 case 分支为准（A 的 host.js 协议已漂移，
  // 不作反推依据）。安装是分钟级操作：进度边跑边发，handler 不把 promise
  // 交还命令队列，否则下载期间整个宿主不再响应任何命令。

  /**
   * 已装 pack + 磁盘占用 + 本机探测 + 工具链元数据表，合成一条 `packs`
   * 消息——渲染器打开这一页要问的三个问题（有什么、装了什么、还能装
   * 什么）在同一次回答里到齐，语言切换时也只重放这一个来源。
   */
  async getPacks() {
    const packs = await packsModule();
    if (!packs) {
      send({ type: "notice", level: "warn", text: "工具链包不可用：内核未编译，请先 npm run build" });
      send({ type: "packs", root: "", freeBytes: null, totalBytes: 0, detected: null, toolchains: [], packs: [] });
      return;
    }
    try {
      const summary = packs.registry.packsSummary();
      // 探测是尽力而为：注册表读不了或 dist-mcp 缺失时 pack 列表照样
      // 发——那一半的答案不依赖探测成功。
      let detected = null;
      try {
        detected = await detectToolchainsForPacks(packs.registry);
      } catch {
        /* detection is optional; the pack list is still worth showing */
      }
      // 元数据表随消息一起发：渲染器读不了 TS 模块，而 label/purpose 本来
      // 就是答案的一部分，不是装饰。
      let toolchains = [];
      try {
        const keil = await keilToolchainModule();
        if (keil?.toolchain?.TOOLCHAIN_INFO) {
          toolchains = Object.entries(keil.toolchain.TOOLCHAIN_INFO).map(([kind, info]) => ({ kind, ...info }));
        }
      } catch {
        /* 表拿不到时探测区留空，页面其余部分照常 */
      }
      send({
        type: "packs",
        root: summary.root,
        freeBytes: summary.freeBytes,
        totalBytes: summary.totalBytes,
        detected,
        toolchains,
        packs: summary.packs.map((pack) => ({
          manifest: {
            id: pack.manifest.id,
            name: pack.manifest.name,
            version: pack.manifest.version,
            provides: pack.manifest.provides,
            license: pack.manifest.license,
          },
          bytes: pack.bytes,
          status: pack.status,
          problem: pack.problem,
        })),
      });
    } catch (error) {
      send({ type: "notice", level: "warn", text: `toolchain packs: ${messageOf(error)}` });
    }
  },

  async getPackCatalog() {
    const packs = await packsModule();
    if (!packs) {
      send({ type: "notice", level: "warn", text: "工具链目录不可用：内核未编译，请先 npm run build" });
      return;
    }
    try {
      // includeUnverified：目录里没填哈希的条目也列出来，但标成不可安装 ——
      // 静默隐藏会让用户以为"没有这个工具链"，而不是"还没准备好"。
      send({
        type: "pack_catalog",
        entries: packs.catalog.catalogFor(undefined, undefined, { includeUnverified: true }).map((entry) => ({
          id: entry.id,
          name: entry.name,
          version: entry.version,
          downloadBytes: entry.downloadBytes,
          provides: entry.provides,
          installable: packs.catalog.isInstallable(entry),
        })),
      });
    } catch (error) {
      send({ type: "notice", level: "warn", text: `toolchain catalog: ${messageOf(error)}` });
    }
  },

  /**
   * 安装目录里的一个 pack。handler 立即返回：进度走 `pack_progress` 事件，
   * 结束走 `pack_installed` / `pack_error`，命令循环全程可响应。
   */
  async installPack(payload = {}) {
    const packs = await packsModule();
    if (!packs) {
      send({ type: "pack_error", id: payload.id ?? null, message: "工具链包不可用：内核未编译，请先 npm run build" });
      return;
    }
    const entry = packs.catalog
      .catalogFor(undefined, undefined, { includeUnverified: true })
      .find((item) => item.id === payload.id);
    if (!entry) {
      send({ type: "pack_error", id: payload.id ?? null, message: "no such pack in the catalog" });
      return;
    }
    if (!packs.catalog.isInstallable(entry)) {
      send({ type: "pack_error", id: entry.id, message: "this pack has not been checksummed yet and cannot be installed" });
      return;
    }
    if (packInstallRunning) {
      // 本窗口的自守卫；跨窗口/CLI 由根目录的 .lock 文件把守。
      send({ type: "pack_error", id: entry.id, message: "另一个包安装正在进行中，请等它结束再试" });
      return;
    }
    packAbort?.abort();
    packAbort = new AbortController();
    const controller = packAbort;
    packInstallRunning = true;
    packs.install
      .installPack(packs.catalog.toInstallEntry(entry), {
        signal: controller.signal,
        onProgress: (progress) => send({ type: "pack_progress", ...progress }),
      })
      .then(() => {
        resetToolchainDetection();
        send({ type: "pack_installed", id: entry.id });
        // 装完之后列表与探测都变了：重发整份而不是就地补一条。
        void handlers.getPacks();
      })
      .catch((error) => {
        send({ type: "pack_error", id: entry.id, message: messageOf(error) });
      })
      .finally(() => {
        packInstallRunning = false;
        if (packAbort === controller) packAbort = null;
      });
  },

  /**
   * 离线安装：用户手上是别人拷过来的 pack.json + 压缩包，机器连不上下载
   * 站。同一个事务、同一套成员检查、同一个校验——只是字节从本地来。
   */
  async installFromManifest(payload = {}) {
    const packs = await packsModule();
    if (!packs) {
      send({ type: "pack_error", id: null, message: "工具链包不可用：内核未编译，请先 npm run build" });
      return;
    }
    if (typeof payload.path !== "string" || payload.path === "") {
      send({ type: "pack_error", id: null, message: "离线安装需要 pack.json 的路径" });
      return;
    }
    if (packInstallRunning) {
      send({ type: "pack_error", id: null, message: "另一个包安装正在进行中，请等它结束再试" });
      return;
    }
    packAbort?.abort();
    packAbort = new AbortController();
    const controller = packAbort;
    packInstallRunning = true;
    packs.install
      .installFromManifest(payload.path, {
        signal: controller.signal,
        localFiles: Array.isArray(payload.files) && payload.files.length > 0 ? payload.files : undefined,
        onProgress: (progress) => send({ type: "pack_progress", ...progress }),
      })
      .then((manifest) => {
        resetToolchainDetection();
        send({ type: "pack_installed", id: manifest.id });
        void handlers.getPacks();
      })
      .catch((error) => {
        send({ type: "pack_error", id: null, message: messageOf(error) });
      })
      .finally(() => {
        packInstallRunning = false;
        if (packAbort === controller) packAbort = null;
      });
  },

  /**
   * 卸载。armed 两段式确认在渲染器（settings.js），到达这里的已是确认
   * 过的请求；pack 先改名出 `packs/` 再删除，失败也只是不可见而非半卸载。
   */
  async removePack(payload = {}) {
    const packs = await packsModule();
    if (!packs) {
      send({ type: "pack_error", id: payload.id ?? null, message: "工具链包不可用：内核未编译，请先 npm run build" });
      return;
    }
    try {
      await packs.registry.removePack(payload.id);
      resetToolchainDetection();
      // `packs` 事件本身就是刷新信号：渲染器收到即整页重渲染。
      void handlers.getPacks();
    } catch (error) {
      send({ type: "pack_error", id: payload.id ?? null, message: messageOf(error) });
    }
  },

  /** 校验一个已装的 pack（浅检查 + 可执行文件应答）。 */
  async verifyPack(payload = {}) {
    const packs = await packsModule();
    if (!packs) {
      send({ type: "pack_error", id: payload.id ?? null, message: "工具链包不可用：内核未编译，请先 npm run build" });
      return;
    }
    packs.registry
      .verifyPack(payload.id, { onProgress: (progress) => send({ type: "pack_progress", ...progress }) })
      .then((result) => {
        send({ type: "pack_verified", id: payload.id, ok: result.ok, problems: result.problems });
      })
      .catch((error) => send({ type: "pack_error", id: payload.id ?? null, message: messageOf(error) }));
  },

  /** 清理中断遗留的事务目录与 trash（只删本应用创建且已过期的）。 */
  async prunePacks() {
    const packs = await packsModule();
    if (!packs) {
      send({ type: "notice", level: "warn", text: "工具链包不可用：内核未编译，请先 npm run build" });
      return;
    }
    try {
      const result = await packs.registry.pruneTmp();
      send({ type: "pack_pruned", removed: result.removed.length, bytes: result.bytes });
      void handlers.getPacks();
    } catch (error) {
      send({ type: "notice", level: "warn", text: `prunePacks 失败：${messageOf(error)}` });
    }
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
  stopBackgroundPump();
  kernel.background?.killAllBackgroundJobs?.();
  void runner?.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

process.on("uncaughtException", (error) => {
  send({ type: "error", message: `宿主异常：${error.message}` });
  process.exit(1);
});
