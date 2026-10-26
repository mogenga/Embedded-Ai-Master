/**
 * Window close behaviour — main process side only.
 *
 * "What does the close button do" belongs to the **window**, not to the agent
 * host: the host is a separate process that may not even be running, and
 * `desktop/host/host.js`'s `saveSettings` deliberately accepts only `locale`.
 * So the value lives next to the window, in `window-behavior.json` under
 * `app.getPath("userData")`, and this file owns the file format and the two
 * decisions that follow from it:
 *
 *   1. **A bad file never blocks startup.** Missing, unreadable, malformed or
 *      out of range all fall back to `tray` and report *why* in the result. A
 *      settings file is not worth an app that will not start, and the fallback
 *      is the safer of the two: it keeps the host and the tray alive. The
 *      reason travels with the value so the caller can log it instead of
 *      silently pretending the file was fine (R3).
 *   2. **Only exact lowercase values are writable.** `"TRay"`, `"tray "`, `1`
 *      and `""` are refused rather than folded to a neighbour: a typo turning
 *      into a silent settings change is exactly the "same question answered
 *      differently" problem `docs/corpus-ota.md` settled for the corpus.
 *
 * Like `desktop/updater.js`, this file has **no top-level import of
 * `electron`** so `vitest` can load it directly. `main.js` owns the `Tray`,
 * `Menu` and `Notification` objects and only passes plain data here.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir as fsMkdir,
  open as fsOpen,
  rename as fsRename,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import path from "node:path";

/** File under `app.getPath("userData")`. Exported so the test can name it once. */
export const CLOSE_BEHAVIOR_FILE = "window-behavior.json";

/** Values a window close may have. Kept as a list so a typo becomes a test failure. */
export const CLOSE_BEHAVIORS = ["tray", "quit"];

/**
 * The fallback. `tray` rather than `quit` because it is the branch that keeps
 * work alive: a corrupt settings file must not silently end a running debug
 * session the way a `quit` fallback would.
 */
export const DEFAULT_CLOSE_BEHAVIOR = "tray";

/** Tray tooltip. The product name, not the window title. */
export const TRAY_PRODUCT_NAME = "Embedded AI Master";

function describeValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a candidate value.
 *
 * @param {unknown} value
 * @returns {{ behavior: "tray" | "quit", source: "file" | "default" | "invalid", reason?: string }}
 *   `source` says where the answer came from: `file` means the value was
 *   accepted as given, `default` means there was nothing to read, `invalid`
 *   means something was there and was refused (the caller may log `reason`).
 */
export function normalizeCloseBehavior(value) {
  if (value === "tray" || value === "quit") {
    return { behavior: value, source: "file" };
  }
  if (value === undefined || value === null) {
    // "Nothing said" is not the same as "something wrong said": the settings
    // file simply has no value yet, and that is the normal first run.
    return { behavior: DEFAULT_CLOSE_BEHAVIOR, source: "default" };
  }
  return {
    behavior: DEFAULT_CLOSE_BEHAVIOR,
    source: "invalid",
    reason: `不支持的关闭行为：${describeValue(value)}（只接受 "tray" / "quit"）`,
  };
}

/**
 * Parse the contents of `window-behavior.json`.
 *
 * Empty text and a missing key are `default`; bad JSON, a non-object document
 * and an out-of-range value are `invalid`. Neither throws — the caller decides
 * whether to warn, and the answer is always usable.
 *
 * @param {unknown} text
 */
export function parseCloseBehaviorFile(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { behavior: DEFAULT_CLOSE_BEHAVIOR, source: "default" };
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return {
      behavior: DEFAULT_CLOSE_BEHAVIOR,
      source: "invalid",
      reason: `window-behavior.json 不是合法 JSON：${errorMessage(error)}`,
    };
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return {
      behavior: DEFAULT_CLOSE_BEHAVIOR,
      source: "invalid",
      reason: `window-behavior.json 顶层必须是对象，实际是 ${Array.isArray(document) ? "数组" : typeof document}`,
    };
  }
  return normalizeCloseBehavior(document.closeBehavior);
}

/**
 * Read the persisted behaviour.
 *
 * Never throws: a missing file is the normal first run (`default`), and any
 * other failure (permissions, IO, a directory where a file should be) is
 * `invalid` with the reason attached. The app must start either way.
 *
 * @param {object} options
 * @param {string} options.userDataDir `app.getPath("userData")`
 * @param {(file: string, encoding: string) => string} [options.readFile]
 *   injection point for the tests; defaults to `fs.readFileSync`.
 */
export function readCloseBehavior({ userDataDir, readFile = readFileSync } = {}) {
  if (typeof userDataDir !== "string" || userDataDir === "") {
    return {
      behavior: DEFAULT_CLOSE_BEHAVIOR,
      source: "default",
      reason: "没有 userData 目录，使用默认关闭行为",
    };
  }
  const file = path.join(userDataDir, CLOSE_BEHAVIOR_FILE);
  let text;
  try {
    text = readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      // First run: no file, no warning.
      return { behavior: DEFAULT_CLOSE_BEHAVIOR, source: "default" };
    }
    return {
      behavior: DEFAULT_CLOSE_BEHAVIOR,
      source: "invalid",
      reason: `读取 ${file} 失败：${errorMessage(error)}`,
    };
  }
  return parseCloseBehaviorFile(text);
}

/**
 * Decide whether a window close should be intercepted.
 *
 * The `isQuitting` check is what makes a real quit possible at all: the tray
 * menu's Quit and `quitAndInstall()` both call `app.quit()`, which fires
 * `before-quit` **before** any window is asked to close. Without this branch
 * the window's own `close` handler would hide it again and the quit would be
 * swallowed.
 *
 * A value that is not `tray`/`quit` is treated as the default (`tray`), which
 * matches `normalizeCloseBehavior`; no caller can be left in an undefined
 * state where a close both does and does not quit.
 *
 * @param {{ behavior?: unknown, isQuitting?: unknown }} [options]
 * @returns {boolean} true = preventDefault + hide
 */
export function shouldHideOnClose({ behavior, isQuitting } = {}) {
  if (isQuitting === true) return false;
  return normalizeCloseBehavior(behavior).behavior === "tray";
}

/**
 * Write the behaviour atomically.
 *
 * Temp file + fsync + rename, copied from `src/config/app-config.ts` for the
 * same reason: `writeFile` straight to the target truncates first, so a crash
 * mid-write leaves half a JSON document, and half a JSON document at the next
 * start is a warning the user cannot act on. `flag: "wx"` makes the temp name
 * collision an error rather than a clobber.
 *
 * Never throws: the answer is `{ saved: false, error }` so the IPC handler can
 * hand the reason to the page (R3) instead of rejecting into a console nobody
 * sees.
 *
 * @param {object} options
 * @param {string} options.userDataDir
 * @param {unknown} options.behavior
 * @param {() => string} [options.newId]
 * @param {Function} [options.writeFile] injection points for the tests
 * @param {Function} [options.rename]
 * @param {Function} [options.mkdir]
 * @param {Function} [options.rm]
 * @param {Function} [options.open]
 * @returns {Promise<{ behavior: "tray" | "quit", saved: boolean, error?: string }>}
 */
export async function writeCloseBehavior({
  userDataDir,
  behavior,
  newId = randomUUID,
  writeFile = fsWriteFile,
  rename = fsRename,
  mkdir = fsMkdir,
  rm = fsRm,
  open = fsOpen,
} = {}) {
  const normalized = normalizeCloseBehavior(behavior);
  if (normalized.source !== "file") {
    // A refused value must not reach the disk even as the default: writing
    // `tray` for a typo would record a choice the user never made.
    const error =
      normalized.source === "default"
        ? "缺少关闭行为：只接受 \"tray\" / \"quit\""
        : normalized.reason ?? "关闭行为只能是 \"tray\" 或 \"quit\"";
    return { behavior: DEFAULT_CLOSE_BEHAVIOR, saved: false, error };
  }
  if (typeof userDataDir !== "string" || userDataDir === "") {
    return { behavior: normalized.behavior, saved: false, error: "没有 userData 目录" };
  }
  const file = path.join(userDataDir, CLOSE_BEHAVIOR_FILE);
  const tmpPath = `${file}.${newId()}.tmp`;
  const text = `${JSON.stringify({ closeBehavior: normalized.behavior }, null, 2)}\n`;
  try {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(tmpPath, text, { encoding: "utf8", flag: "wx" });
    const handle = await open(tmpPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, file);
  } catch (error) {
    // Whatever happened, the temp file must not survive: a leftover
    // `window-behavior.json.<uuid>.tmp` is a trap for the next reader.
    await rm(tmpPath, { force: true }).catch(() => undefined);
    return {
      behavior: normalized.behavior,
      saved: false,
      error: `写入 ${file} 失败：${errorMessage(error)}`,
    };
  }
  return { behavior: normalized.behavior, saved: true };
}

/**
 * Tray menu strings. Two languages because the tray is drawn by the OS before
 * any page exists, so it follows `app.getLocale()` rather than the app's own
 * locale setting (which lives in the renderer's `localStorage`).
 */
export const TRAY_LABELS = {
  en: {
    show: "Show main window",
    behaviorTray: "Close button: minimize to tray",
    behaviorQuit: "Close button: quit the app",
    quit: "Quit",
  },
  zh: {
    show: "显示主窗口",
    behaviorTray: "关闭按钮：最小化到托盘",
    behaviorQuit: "关闭按钮：退出应用",
    quit: "退出",
  },
};

/**
 * Build the tray context menu template.
 *
 * Pure and returned as data so the tests can assert order and wording without
 * an Electron `Menu`. The behaviour line is `enabled: false` on purpose: the
 * switch is in Settings, and a second clickable copy here would leave "which
 * one wins" ambiguous.
 *
 * @param {object} [options]
 * @param {unknown} [options.behavior] current close behaviour
 * @param {string} [options.locale] `"en"` | `"zh"`; anything else is English
 * @param {() => void} [options.onShow]
 * @param {() => void} [options.onQuit]
 */
export function trayMenuTemplate({ behavior, locale, onShow, onQuit } = {}) {
  const labels = TRAY_LABELS[locale] ?? TRAY_LABELS.en;
  const hides = normalizeCloseBehavior(behavior).behavior === "tray";
  return [
    { id: "show", label: labels.show, click: () => onShow?.() },
    { type: "separator" },
    {
      id: "close-behavior",
      label: hides ? labels.behaviorTray : labels.behaviorQuit,
      enabled: false,
    },
    { type: "separator" },
    { id: "quit", label: labels.quit, click: () => onQuit?.() },
  ];
}

/**
 * The one-time "this went to the tray" notification.
 *
 * Only the first hide in a process shows it: the second one is a user who
 * already knows, and a notification on every close is nagging, not teaching.
 */
export const TRAY_HINT = {
  en: {
    title: "Embedded AI Master",
    body: "Minimized to the system tray. Use the tray icon to bring the window back.",
  },
  zh: {
    title: "Embedded AI Master",
    body: "已最小化到系统托盘，可从托盘图标恢复窗口。",
  },
};

/** @param {string} [locale] */
export function trayHintText(locale) {
  // A copy, not the frozen table: a caller that decorates the object must not
  // edit the text every later call reads.
  return { ...(TRAY_HINT[locale] ?? TRAY_HINT.en) };
}

/**
 * What to tell the user when the tray cannot be created.
 *
 * Hiding the window without a tray would strand the app: no window, no icon,
 * and a single-instance lock that makes a relaunch exit silently (the exact
 * trap the 0.1.1 `stopHost` bug left users in). So the window stays open and
 * the failure is named (R3).
 */
export const TRAY_FAILURE = {
  en: {
    title: "Could not minimize to the tray",
    body: "The tray icon could not be created, so the window stays open. Use File > Exit to quit, or restart the app and try again.",
  },
  zh: {
    title: "无法最小化到托盘",
    body: "托盘图标创建失败，窗口保持打开。可用「文件 → 退出」退出应用，或重启后再试。",
  },
};

/** @param {string} [locale] */
export function trayFailureText(locale) {
  return { ...(TRAY_FAILURE[locale] ?? TRAY_FAILURE.en) };
}
