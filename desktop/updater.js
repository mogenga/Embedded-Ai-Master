/**
 * In-app updates — main process side only.
 *
 * `electron-updater` needs Electron's `app` object, so it cannot live in the
 * host child process (`ELECTRON_RUN_AS_NODE=1` has no Electron API). This file
 * is imported by `main.js` and by the tests; it therefore holds **no top-level
 * import of `electron` or `electron-updater`**. The one module that would fail
 * to resolve on a machine where the dependency has not been installed yet is
 * loaded lazily, inside `createUpdater`, and a failure is reported as a state
 * (`unsupported` / `missing`) rather than thrown at startup — the same rule
 * `desktop/host/host.js` follows for `packsModule()` / `kbModule()`.
 *
 * Two deliberate constraints shape the state machine:
 *
 * 1. **Nothing happens without a click.** `autoDownload` and
 *    `autoInstallOnAppQuit` are both forced to `false`: checking, downloading
 *    and installing are three separate user actions. `docs/corpus-ota.md`
 *    settled the same question for the corpus ("a silent change makes 'the
 *    same question answered differently' unexplainable"); an application
 *    upgrade is a bigger version of that — the user may be in the middle of a
 *    long tool run.
 * 2. **A failure is never reported as "up to date" (R3).** Every error is
 *    classified into a reason the settings page can name, and an unknown code
 *    stays `unknown` rather than being folded into a friendlier state.
 */

/** States the renderer draws. Kept as a list so a typo is a test failure. */
export const UPDATE_STATES = [
  "unsupported",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
];

/**
 * `electron-updater` publishes `autoUpdater` through an **arrow-function**
 * getter (`get: () => { ... }`). Node's CJS named-export detection
 * (`cjs-module-lexer`) does not recognise that form, so
 * `import { autoUpdater } from "electron-updater"` yields `undefined` while
 * `mod.default.autoUpdater` works. Verified against 6.8.11; if a future major
 * switches the package to real ESM, the first assignment still wins.
 */
let autoUpdaterPromise;
function loadAutoUpdater() {
  autoUpdaterPromise ??= import("electron-updater")
    .then((mod) => mod?.autoUpdater ?? mod?.default?.autoUpdater ?? null)
    .catch(() => null);
  return autoUpdaterPromise;
}

/**
 * How much of an error message may reach the UI or the log.
 *
 * GitHub provider URLs can carry credentials in the query string (and a
 * redirected download URL carries signature parameters), so the query and the
 * fragment are dropped entirely rather than filtered by parameter name. Stack
 * traces go too: they are noise in a settings page and can embed the same URL.
 */
export function sanitizeMessage(value) {
  // `electron-updater` throws real `Error`s, but a plain `{ code, message }`
  // reach this function from the tests and from any re-wrapped failure. Reading
  // `.message` off those keeps the reason text; `String(obj)` would print
  // "[object Object]" and take the diagnostic with it.
  const text =
    typeof value === "string"
      ? value
      : typeof value?.message === "string"
        ? value.message
        : String(value ?? "");
  const firstLine = text.split("\n")[0].trim();
  const withoutQuery = firstLine.replace(/\bhttps?:\/\/[^\s)"']+/gi, (url) => {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : `${url.slice(0, cut)}?<redacted>`;
  });
  const withoutTokens = withoutQuery.replace(
    /\b(bearer|token|api[_-]?key|access[_-]?token)\b\s*[:=]?\s*\S+/gi,
    "$1=<redacted>",
  );
  return withoutTokens.length > 300 ? `${withoutTokens.slice(0, 297)}…` : withoutTokens;
}

/** The updater's own error codes, grouped by what the user can do about them. */
const REASON_BY_CODE = {
  ERR_UPDATER_INVALID_SIGNATURE: "signature",
  ERR_CHECKSUM_MISMATCH: "checksum",
  ERR_UPDATER_NO_CHECKSUM: "checksum",
  ERR_UPDATER_NO_PUBLISHED_VERSIONS: "no-release",
  ERR_UPDATER_LATEST_VERSION_NOT_FOUND: "no-release",
  ERR_UPDATER_RELEASE_NOT_FOUND: "no-release",
  // The release exists but its `latest.yml` is missing: a publishing mistake,
  // not "no new version" — it must not be shown as "up to date".
  ERR_UPDATER_CHANNEL_FILE_NOT_FOUND: "no-manifest",
  ERR_UPDATER_ASSET_NOT_FOUND: "download",
  ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND: "download",
  ERR_UPDATER_OLD_FILE_NOT_FOUND: "download",
  ERR_UPDATER_ZIP_FILE_NOT_FOUND: "download",
  ERR_UPDATER_WEB_INSTALLER_DISABLED: "download",
  ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION: "config",
  ERR_UPDATER_UNSUPPORTED_PROVIDER: "config",
  ERR_UPDATER_INVALID_RELEASE_FEED: "config",
  ERR_UPDATER_NO_FILES_PROVIDED: "config",
  ERR_UPDATER_INVALID_VERSION: "manifest",
  ERR_UPDATER_INVALID_UPDATE_INFO: "manifest",
  ERR_UPDATER_INVALID_CHANNEL: "manifest",
};

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ERR_SOCKET_TIMEOUT",
]);

const NETWORK_MESSAGE = /net::|getaddrinfo|socket hang up|self[- ]signed certificate|unable to verify the first certificate|network error/i;

/**
 * Turn an error from `electron-updater` into a reason the page can name.
 *
 * The split is by *what the operator does next*, which is why "the release has
 * no `latest.yml`" is its own reason instead of joining "no release": one means
 * publish something, the other means fix the uploaded asset list.
 *
 * @param {{ code?: string, statusCode?: number, message?: string }} error
 * @returns {{ reason: string, message: string }}
 */
export function classifyUpdaterError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const statusCode = typeof error?.statusCode === "number" ? error.statusCode : 0;
  const message = sanitizeMessage(error);
  const reason = (() => {
    if (code in REASON_BY_CODE) return REASON_BY_CODE[code];
    // `app-update.yml` missing: a development run or a corrupted install,
    // never a statement about the feed.
    if (code === "ENOENT") return "config";
    if (NETWORK_CODES.has(code)) return "network";
    if (NETWORK_MESSAGE.test(message)) return "network";
    // `HttpError` from builder-util-runtime carries `HTTP_ERROR_<status>` and
    // the status separately; anything 4xx/5xx is the feed answering badly.
    if (statusCode >= 400 || /^HTTP_ERROR_\d{3}$/.test(code)) return "network";
    return "unknown";
  })();
  return { reason, message };
}

/**
 * Map `checkForUpdates()`'s result to a state.
 *
 * `null` is what the library returns when it considers itself inactive
 * (`isUpdaterActive()` is false). That is not "up to date" — it is "this build
 * cannot check", so it becomes `unsupported`.
 */
export function checkResultToStatus(result) {
  if (result === null || result === undefined) {
    return { state: "unsupported", reason: "disabled" };
  }
  const info = result.updateInfo ?? result.versionInfo ?? {};
  const version = typeof info.version === "string" ? info.version : "";
  if (result.isUpdateAvailable !== true) {
    return { state: "up-to-date", version };
  }
  const status = { state: "available", version };
  if (typeof info.releaseDate === "string" && info.releaseDate !== "") {
    status.releaseDate = info.releaseDate;
  }
  if (typeof info.releaseName === "string" && info.releaseName !== "") {
    status.releaseName = info.releaseName;
  }
  return status;
}

/**
 * Clamp a `download-progress` payload into something a one-line label can show.
 *
 * `percent` is recomputed from the byte counts when both are usable, because
 * the library reports it with full float precision and a differential download
 * can emit values outside 0..100 when the cached blockmap is stale.
 */
export function formatProgress(progress) {
  const transferred = Number(progress?.transferred);
  const total = Number(progress?.total);
  const reported = Number(progress?.percent);
  let percent = Number.isFinite(reported) ? reported : Number.NaN;
  if (!Number.isFinite(percent) && Number.isFinite(transferred) && Number.isFinite(total) && total > 0) {
    percent = (transferred / total) * 100;
  }
  const safePercent = Number.isFinite(percent) ? Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10 : 0;
  return {
    state: "downloading",
    percent: safePercent,
    transferred: Number.isFinite(transferred) && transferred > 0 ? transferred : 0,
    total: Number.isFinite(total) && total > 0 ? total : 0,
    bytesPerSecond: Number(progress?.bytesPerSecond) > 0 ? Math.round(Number(progress.bytesPerSecond)) : 0,
  };
}

/**
 * Console logger for `autoUpdater.logger`.
 *
 * The library logs resolved feed URLs and, on GitHub, the asset URL it is about
 * to fetch. Both go through `sanitizeMessage`, so a signed URL or a token in a
 * query string never reaches the terminal or a log file.
 */
export function createUpdaterLogger(sink = console) {
  const write = (level, message) => {
    const text = sanitizeMessage(message);
    if (text === "") return;
    const line = `[updater] ${text}`;
    if (level === "error") sink.error(line);
    else if (level === "warn") sink.warn(line);
    else sink.log(line);
  };
  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
    debug: (message) => write("debug", message),
  };
}

/** Two statuses that would draw the same thing; used to suppress event noise. */
function sameStatus(a, b) {
  if (a === null || b === null) return a === b;
  return (
    a.state === b.state &&
    a.reason === b.reason &&
    a.version === b.version &&
    a.percent === b.percent &&
    a.message === b.message
  );
}

/**
 * Build the controller `main.js` exposes over IPC.
 *
 * @param {object} options
 * @param {(status: object) => void} [options.onStatus] called on every change
 * @param {boolean} [options.isPackaged] `app.isPackaged`; false means the
 *   unpackaged dev run, where `resources/app-update.yml` does not exist and a
 *   check can only fail — so no check is attempted at all.
 * @param {() => Promise<any>} [options.loadAutoUpdater] injection point for the
 *   tests; defaults to the lazy `electron-updater` import.
 * @param {() => Promise<void> | void} [options.onBeforeInstall] called before
 *   `quitAndInstall`; `main.js` uses it to shut the host down first. A throw
 *   from it is swallowed — a host that will not stop must not block an update
 *   the user already asked to install.
 */
export function createUpdater({
  onStatus,
  isPackaged = true,
  loadAutoUpdater: load = loadAutoUpdater,
  /**
   * Called right before the installer is launched.
   *
   * The host is a child process that owns MCP servers; letting the NSIS
   * installer find it still running means `CHECK_APP_RUNNING` kills it
   * abruptly, and its MCP children can survive that. Giving the updater a
   * chance to ask the host to stop first is the difference between a clean
   * shutdown and an orphaned debug session.
   */
  onBeforeInstall,
} = {}) {
  const emitStatus = typeof onStatus === "function" ? onStatus : () => {};
  let status = isPackaged === false ? { state: "unsupported", reason: "dev" } : { state: "idle" };
  let updater = null;
  let wiring = null;

  function emit(next) {
    if (sameStatus(status, next)) return status;
    status = next;
    try {
      emitStatus(status);
    } catch {
      // A renderer that has gone away must not take the update state down.
    }
    return status;
  }

  function wire(au) {
    if (wiring === au) return;
    wiring = au;
    au.on("checking-for-update", () => emit({ state: "checking" }));
    au.on("update-available", (info) => emit(checkResultToStatus({ isUpdateAvailable: true, updateInfo: info })));
    au.on("update-not-available", (info) =>
      emit(checkResultToStatus({ isUpdateAvailable: false, updateInfo: info })),
    );
    au.on("download-progress", (progress) => emit(formatProgress(progress)));
    au.on("update-downloaded", (event) => {
      const version = typeof event?.version === "string" ? event.version : "";
      emit({ state: "downloaded", version });
    });
    au.on("error", (error) => {
      const { reason, message } = classifyUpdaterError(error);
      const code = typeof error?.code === "string" ? error.code : "";
      emit({ state: "error", reason, message, ...(code === "" ? {} : { code }) });
    });
  }

  /**
   * Load the library and apply the two "never do this on your own" switches.
   *
   * Returns `null` — not a throw — when the dependency is absent or this is an
   * unpackaged run, because "the app cannot update" is a state the page has to
   * be able to show.
   */
  async function ensureUpdater() {
    if (updater !== null) return updater;
    if (isPackaged === false) {
      emit({ state: "unsupported", reason: "dev" });
      return null;
    }
    let loaded = null;
    try {
      loaded = await load();
    } catch {
      loaded = null;
    }
    if (loaded === null || typeof loaded?.checkForUpdates !== "function" || typeof loaded?.on !== "function") {
      // The second check is not redundant: `import { autoUpdater }` on this
      // package yields `undefined` (see the note on `loadAutoUpdater`), and a
      // wrong shape must read as "no updater here" rather than throwing inside
      // `wire()` on the first click.
      emit({ state: "unsupported", reason: "missing" });
      return null;
    }
    updater = loaded;
    // Both must be explicit: the library defaults them to `true`, which would
    // download on check and install on ordinary quit.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.logger = createUpdaterLogger();
    wire(updater);
    return updater;
  }

  return {
    /** The current state, for a page that opens after something has happened. */
    status() {
      return status;
    },

    async check() {
      const au = await ensureUpdater();
      if (au === null) return status;
      emit({ state: "checking" });
      try {
        const result = await au.checkForUpdates();
        return emit(checkResultToStatus(result));
      } catch (error) {
        const { reason, message } = classifyUpdaterError(error);
        const code = typeof error?.code === "string" ? error.code : "";
        return emit({ state: "error", reason, message, ...(code === "" ? {} : { code }) });
      }
    },

    /**
     * Download the update the last check found. Only meaningful from
     * `available`; any other state is answered with the current status rather
     * than starting a download the user did not ask for.
     */
    async download() {
      const au = await ensureUpdater();
      if (au === null) return status;
      if (status.state !== "available") return status;
      try {
        await au.downloadUpdate();
        // `update-downloaded` normally carries the version; keep the one the
        // check found in case the event arrives without it.
        if (status.state === "downloading" || status.state === "available") {
          return emit({ state: "downloaded", version: status.version ?? "" });
        }
        return status;
      } catch (error) {
        const { reason, message } = classifyUpdaterError(error);
        const code = typeof error?.code === "string" ? error.code : "";
        return emit({ state: "error", reason, message, ...(code === "" ? {} : { code }) });
      }
    },

    /**
     * Quit and run the downloaded installer.
     *
     * Returns `false` when there is nothing to install, so the caller can tell
     * "asked to install" from "installed nothing". Not silent: the NSIS
     * installer already suppresses its "app is running" prompt for an update
     * (`--updated`), and showing its progress window is the honest way to
     * report what the click started.
     */
    async install() {
      const au = await ensureUpdater();
      if (au === null) return false;
      if (status.state !== "downloaded") return false;
      try {
        // Ask the host to stop before the installer looks for a running app.
        // Awaited, but never allowed to block the install: a host that refuses
        // to die must not turn a working update into a dead button.
        if (typeof onBeforeInstall === "function") {
          await Promise.resolve()
            .then(() => onBeforeInstall())
            .catch(() => undefined);
        }
        // `quitAndInstall` is synchronous and may dispatch an `error` event
        // instead of throwing (the installer could not be spawned). Both are
        // handled: the event path updates the state, and a throw becomes an
        // error state rather than an unhandled rejection in the main process.
        au.quitAndInstall(false, true);
        return true;
      } catch (error) {
        const { reason, message } = classifyUpdaterError(error);
        const code = typeof error?.code === "string" ? error.code : "";
        emit({ state: "error", reason, message, ...(code === "" ? {} : { code }) });
        return false;
      }
    },
  };
}
