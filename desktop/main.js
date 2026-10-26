/**
 * Electron main process: one window, one agent host child process.
 *
 * The window loads the renderer from `desktop/renderer/index.html` — plain ES
 * modules, no bundler — and talks to the host over NDJSON on stdio. The host
 * is a separate process on purpose: a crash or a runaway tool takes the agent
 * down, not the window, and the renderer can ask for a restart without losing
 * its scroll position.
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
} from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  TRAY_PRODUCT_NAME,
  readCloseBehavior,
  shouldHideOnClose,
  trayFailureText,
  trayHintText,
  trayMenuTemplate,
  writeCloseBehavior,
} from "./close-behavior.js";
import { createUpdater } from "./updater.js";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = join(here, "host", "host.js");
const RENDERER = join(here, "renderer", "index.html");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

/** Workspace the host is started in; the renderer can narrow it, not widen it. */
const startCwd = process.cwd();

/**
 * Update state goes to every open window over the same `host-event` channel
 * the host uses. A second channel would mean two listeners in the renderer and
 * two orders for the page to reconcile; one channel keeps the "the page draws
 * whatever arrived last" rule.
 *
 * `BrowserWindow.getAllWindows()` rather than a captured window: the updater is
 * created once at startup, before any window exists, and must keep working when
 * the window is recreated from `activate`.
 */
function sendToAllWindows(message) {
  for (const target of BrowserWindow.getAllWindows()) {
    if (!target.isDestroyed()) target.webContents.send("host-event", message);
  }
}

/**
 * Every window's way to stop its host, so an install can shut them down first.
 *
 * A `Set` rather than one function: the window is recreated from `activate`, and
 * a stale entry must not keep a dead host's stopper alive. Each entry removes
 * itself when the window closes.
 */
const hostStoppers = new Set();

/**
 * The updater controller, created once.
 *
 * `app.isPackaged` decides whether a check is even attempted: in a checkout
 * there is no `resources/app-update.yml`, so every check would fail with a
 * config error that says nothing about the release. `createUpdater` reports
 * that as `unsupported` and never loads `electron-updater` at all.
 */
let updaterController = null;
function updater() {
  updaterController ??= createUpdater({
    isPackaged: app.isPackaged,
    onStatus: (status) => sendToAllWindows({ type: "update_status", status }),
    // The NSIS installer's `CHECK_APP_RUNNING` force-kills a running app on the
    // `--updated` path. Asking each host to run its own `shutdown` first is
    // what keeps spawned MCP servers from outliving the process they belonged
    // to (the same reason `stopHost` exists at all).
    onBeforeInstall: async () => {
      for (const stop of hostStoppers) stop();
    },
  });
  return updaterController;
}

// Registered once, outside `startWindow`: IPC handlers are global, and a
// second registration throws.
ipcMain.handle("update-status", () => updater().status());
ipcMain.handle("update-check", () => updater().check());
ipcMain.handle("update-download", () => updater().download());
ipcMain.handle("update-install", () => updater().install());

/* ---------- close behaviour and the system tray ---------- */

/**
 * True from `before-quit` until the process ends.
 *
 * Without this flag the window's own `close` handler would swallow every real
 * quit: `app.quit()` (the tray menu, `quitAndInstall()`) asks each window to
 * close *after* `before-quit`, so a tray-mode window would hide itself instead
 * of closing and the app would never exit. The flag is the only thing that
 * tells "the user clicked X" apart from "the app is going down".
 */
let isQuitting = false;

/**
 * What the close button does, as last read from disk or written by Settings.
 *
 * Kept in memory rather than re-read on every close: the value only changes
 * through `set-close-behavior`, which updates this copy, and a synchronous
 * disk read on every X click would put an IO error between the user and a
 * decision that has a perfectly good default.
 */
let closeBehavior = "tray";

/** The tray icon, or null before `whenReady` and after `will-quit`. */
let tray = null;

/** The first-hide hint is once per process, not once per window. */
let trayHintShown = false;

function userDataDir() {
  return app.getPath("userData");
}

/**
 * Locale for text that is drawn by the OS (tray menu, notification).
 *
 * `app.getLocale()` rather than the renderer's language setting: the tray is
 * built before any page loads, and `localStorage` is not readable from the
 * main process. The two can disagree if the user picked a language that is
 * not the system one; the tray still speaks the system's, which is what a
 * tray that is drawn by the OS should do.
 */
function trayLocale() {
  return String(app.getLocale() ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/**
 * The tray image, picked by DPI rather than downscaled.
 *
 * `desktop/build/icon.ico` is not usable here: `build/` is not in `build.files`,
 * so it does not exist inside the asar. The two PNGs under `renderer/assets/`
 * are the ico's own 16 px and 32 px frames exported losslessly, and they ship
 * with `renderer/**\/*`. Resizing the 128 px product mark instead would blur its
 * thin lines and disagree with the taskbar icon.
 *
 * An empty image is a tray the user cannot see, so a failure is reported
 * (R3) rather than passed off as a working tray.
 */
function trayIcon() {
  const scaleFactor = screen.getPrimaryDisplay()?.scaleFactor ?? 1;
  const file = join(here, "renderer", "assets", scaleFactor >= 1.5 ? "tray-32.png" : "tray-16.png");
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    console.warn(
      `[tray] 托盘图标加载失败：${file}（文件不存在或不是有效图片）。` +
        "托盘图标会是空白，菜单仍可用。",
    );
    return nativeImage.createEmpty();
  }
  return image;
}

/** Show the window, recreating it when every window has already closed. */
function showMainWindow() {
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing === undefined) {
    startWindow();
    return;
  }
  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
}

/** Rebuild the context menu from the current behaviour. */
function refreshTrayMenu() {
  if (tray === null) return;
  try {
    tray.setContextMenu(
      Menu.buildFromTemplate(
        trayMenuTemplate({
          behavior: closeBehavior,
          locale: trayLocale(),
          onShow: () => showMainWindow(),
          onQuit: () => app.quit(),
        }),
      ),
    );
  } catch {
    // The tray can be gone already during quit; a stale menu there is not a
    // failure worth surfacing.
  }
}

/**
 * Create the tray. Called for packaged and development runs alike: a tray that
 * only appears in installers is a difference that shows up as "works on my
 * machine" when someone debugs the close button.
 *
 * `close` calls this too, and a throw there would be an uncaught exception in
 * the main process — the same shape as the 0.1.1 `stopHost` bug. So a failure
 * is reported and returns `null`; the window still hides, and the next close
 * tries again.
 */
function ensureTray() {
  if (tray !== null) return tray;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip(TRAY_PRODUCT_NAME);
    // On Windows a left click does not open the context menu on its own; the
    // expected gesture for "bring it back" is a click on the icon.
    tray.on("click", () => showMainWindow());
    refreshTrayMenu();
  } catch (error) {
    tray = null;
    console.warn(
      `[tray] 托盘创建失败：${error instanceof Error ? error.message : String(error)}。` +
        "窗口仍会隐藏，但托盘图标不可用；退出请用任务管理器或重启应用。",
    );
  }
  return tray;
}

/** One notification; a failure to show it is logged, never thrown. */
function notify({ title, body }, failureLabel) {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body }).show();
  } catch (error) {
    console.warn(`[tray] ${failureLabel}：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The "it went to the tray" notification, shown once per process. */
function showTrayHintOnce() {
  if (trayHintShown) return;
  trayHintShown = true;
  notify(trayHintText(trayLocale()), "首次最小化提示发送失败");
}

/** Say why the window stayed open when the tray could not be created. */
function warnTrayFailure() {
  notify(trayFailureText(trayLocale()), "托盘失败提示发送失败");
  // Also on stderr: a Windows notification can be swallowed by Focus Assist,
  // and this is the one message that explains why close no longer works.
  console.warn("[tray] 托盘不可用，关闭窗口不会隐藏，也不会退出应用。");
}

/** Load the persisted behaviour, warn once when the file was bad, sync the tray. */
function loadCloseBehavior() {
  const result = readCloseBehavior({ userDataDir: userDataDir() });
  closeBehavior = result.behavior;
  if (result.source === "invalid") {
    // Not a startup failure: the fallback is the safer answer, and the user
    // needs to know why their choice was not applied.
    console.warn(`[close-behavior] ${result.reason ?? "配置无效"}，已回落 "${closeBehavior}"`);
  }
  refreshTrayMenu();
  return result;
}

// Both handlers are global: registered once, outside `startWindow`, like the
// updater's. The renderer is not trusted with this value — an out-of-range
// behaviour is refused by `writeCloseBehavior` and nothing is written.
ipcMain.handle("get-close-behavior", () => {
  const result = loadCloseBehavior();
  return {
    behavior: result.behavior,
    source: result.source,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
});

ipcMain.handle("set-close-behavior", async (_event, behavior) => {
  const result = await writeCloseBehavior({ userDataDir: userDataDir(), behavior });
  if (result.saved) {
    closeBehavior = result.behavior;
    refreshTrayMenu();
  }
  return result;
});

app.on("before-quit", () => {
  isQuitting = true;
});

// Windows keeps a destroyed process's tray icon until hover if it is not
// removed explicitly; `will-quit` is the last point where the object is alive.
app.on("will-quit", () => {
  if (tray === null) return;
  try {
    tray.destroy();
  } catch {
    /* already gone */
  }
  tray = null;
});

function startWindow(options = {}) {
  const win = new BrowserWindow({
    ...(options.bounds ? options.bounds : { width: 1360, height: 880 }),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0e0e10",
    title: "Embedded AI Master",
    // Windows 任务栏/标题栏图标。打包后的 exe 用自身的资源图标，但开发
    // 模式（electron .）不传这个就是 Electron 默认图标。
    icon: join(here, "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    // The renderer draws its own caption buttons on Windows so they match the
    // top bar and follow the theme; macOS keeps its traffic lights.
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // A preload that `require`s electron must not run sandboxed; the
      // isolation boundary is the preload's allow-list plus the CSP.
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadFile(RENDERER);

  /**
   * Tray mode: X hides the window instead of closing it.
   *
   * `preventDefault()` is what keeps the host alive: with it, `closed` never
   * fires, so the window's own stopper (below) does not run the host down and
   * `window-all-closed` is never reached. `isQuitting` comes first because a
   * real quit — the tray menu, `quitAndInstall()` — also closes this window;
   * hiding it there would swallow the quit.
   *
   * The decision itself is the pure `shouldHideOnClose`; this handler only
   * applies it.
   */
  win.on("close", (event) => {
    if (!shouldHideOnClose({ behavior: closeBehavior, isQuitting })) return;
    event.preventDefault();
    // Hiding without a tray would leave no window and no icon to bring it
    // back — and the single-instance lock makes a relaunch exit silently. So
    // a tray that cannot be created keeps the window open and says why.
    if (ensureTray() === null) {
      warnTrayFailure();
      return;
    }
    win.hide();
    showTrayHintOnce();
  });

  const sendWindowState = () => {
    if (!win.isDestroyed()) win.webContents.send("window-state", { maximized: win.isMaximized() });
  };
  win.on("maximize", sendWindowState);
  win.on("unmaximize", sendWindowState);

  const sendToRenderer = (message) => {
    if (!win.isDestroyed()) win.webContents.send("host-event", message);
  };

  let host = null;
  let hostCwd = options.cwd ?? startCwd;
  let sessionToLoad = options.loadSession ?? null;

  const sendToHost = (payload) => {
    if (host === null) return;
    if (host.stdin.writable) host.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  /**
   * (Re)start the agent process. Called at launch and again from the retry
   * button after a crash, so a host failure does not require closing the
   * window or losing the workspace.
   */
  function startHost(cwd) {
    hostCwd = cwd || hostCwd;
    if (!existsSync(HOST)) {
      sendToRenderer({
        type: "fatal",
        message: `找不到桌面宿主：${HOST}。请在仓库根目录运行 npm run build 后重试。`,
      });
      return;
    }
    host = spawn(process.execPath, [HOST], {
      cwd: hostCwd,
      // Node, not a second Electron app: the host imports the compiled kernel
      // and has no Electron API in scope.
      //
      // Only a packaged app names its `resources/` here. The property is not
      // passed unconditionally because a development host sees a
      // `resourcesPath` too — Electron's own `dist/resources`, which holds no
      // kernel — and the host could not tell the two apart. Omitting it in
      // development is what makes the host fall back to the checkout layout
      // and report "run npm run build" instead of "reinstall".
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...(app.isPackaged ? { HARNESS_RESOURCES_PATH: process.resourcesPath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    createInterface({ input: host.stdout }).on("line", (line) => {
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        sendToRenderer({ type: "notice", level: "warn", text: line });
        return;
      }
      sendToRenderer(message);
      // The host announces itself with `state` once `init` has been handled.
      // Sending `loadSession` before that races the session bookkeeping.
      if (message?.type === "state" && sessionToLoad !== null) {
        const id = sessionToLoad;
        sessionToLoad = null;
        sendToHost({ cmd: "loadSession", id });
      }
    });
    createInterface({ input: host.stderr }).on("line", (line) => {
      sendToRenderer({ type: "notice", level: "error", text: line });
    });
    host.on("exit", (code) => {
      host = null;
      sendToRenderer({ type: "host_exit", code });
    });
    sendToHost({ cmd: "init", cwd: hostCwd, mode: process.env.HARNESS_PERMISSION_MODE });
  }

  /**
   * Stop the agent process without orphaning its children.
   *
   * `kill()` on Windows is TerminateProcess: the host never runs its cleanup,
   * and a spawned MCP server can outlive it. The host therefore has a
   * `shutdown` command; ask for it, close stdin as a second signal, and only
   * fall back to a hard kill if the process is still there after 500 ms.
   */
  function stopHost() {
    const target = host;
    host = null;
    if (target === null) return;
    try {
      if (target.stdin.writable) target.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      target.stdin.end();
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        target.kill();
      } catch {
        /* already gone */
      }
    }, 500);
    target.once("exit", () => clearTimeout(timer));
  }

  ipcMain.on("host-send", (event, payload) => {
    if (!win.isDestroyed() && event.sender === win.webContents) sendToHost(payload);
  });

  ipcMain.on("host-restart", (event) => {
    if (win.isDestroyed() || event.sender !== win.webContents) return;
    stopHost();
    startHost(hostCwd);
  });

  ipcMain.on("window-control", (event, action) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (target === null) return;
    if (action === "minimize") target.minimize();
    else if (action === "maximize") {
      if (target.isMaximized()) target.unmaximize();
      else target.maximize();
    } else if (action === "close") target.close();
  });

  ipcMain.handle("window-state", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    return { maximized: Boolean(target?.isMaximized()) };
  });

  ipcMain.handle("pick-directory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("pick-file", async (_event, options = {}) => {
    const result = await dialog.showOpenDialog({
      properties: options.multiple === true ? ["openFile", "multiSelections"] : ["openFile"],
    });
    if (result.canceled) return options.multiple === true ? [] : null;
    return options.multiple === true ? result.filePaths : result.filePaths[0];
  });

  ipcMain.handle("save-file", async (_event, request = {}) => {
    const result = await dialog.showSaveDialog({
      defaultPath: request.suggestedName ?? "session.json",
      filters: request.filters,
    });
    if (result.canceled || result.filePath === undefined) return { saved: false };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(result.filePath, String(request.content ?? ""), "utf8");
    return { saved: true, path: result.filePath };
  });

  ipcMain.handle("app-version", () => pkg.version ?? "0.0.0");
  ipcMain.handle("open-external", (_event, url) => shell.openExternal(String(url)));
  // Reveal a produced artifact rather than opening it: an artifact can be a
  // binary capture, and handing it to its default application would launch a
  // program the operator did not ask for.
  ipcMain.handle("reveal-artifact", (_event, target) =>
    shell.showItemInFolder(String(target ?? "")),
  );
  ipcMain.handle("notify", (_event, payload) => {
    if (Notification.isSupported()) {
      new Notification({ title: String(payload?.title ?? "Embedded AI Master"), body: String(payload?.body ?? "") }).show();
    }
  });

  // Registered with the updater so an install shuts this host down before the
  // installer runs. Removed on `closed`: a dead window's stopper would be a
  // no-op, but keeping it would make the set grow with every recreated window.
  const stopForInstall = () => stopHost();
  hostStoppers.add(stopForInstall);

  win.on("closed", () => {
    hostStoppers.delete(stopForInstall);
    stopHost();
  });
  startHost(hostCwd);

  return win;
}

// One app instance per machine: a second launch would create a second host and
// a second window over the same session directory.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

app.on("second-instance", () => {
  // Deliberately the original shape rather than `showMainWindow()`: in
  // `quit` mode there are moments (after `closed`, before the 300 ms
  // `app.quit()`) when recreating a window would be undone by the pending
  // quit. In tray mode the window still exists — hidden — so this branch
  // reveals it, which is the "second launch brings it back" behaviour users
  // expect.
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  // Windows 任务栏归属：不设 AppUserModelId 时窗口可能被归进
  // electron.exe 的分组，图标与通知都跟着错。
  if (process.platform === "win32") app.setAppUserModelId("com.embedded-ai.master");
  // Read before the first window exists: its `close` handler reads the value
  // synchronously, so a window created before the read would apply the default
  // to its first close even when the file says `quit`.
  loadCloseBehavior();
  // Always, packaged or not: a tray that only exists in installers makes the
  // close button behave differently in the two forms, which is exactly the
  // class of bug this feature is prone to. `quit` mode ships one too, so
  // "show the window" is available after a hide from an earlier run.
  ensureTray();
  startWindow();
});

app.on("window-all-closed", () => {
  // In tray mode the X button hides the window, so no `closed` event fires and
  // this handler is not reached at all — the host and the tray keep running.
  // It is reached in `quit` mode (unchanged behaviour) and, in tray mode, when
  // a window is destroyed without going through `close` (a renderer crash);
  // quitting then is the honest outcome, since a tray with no window and an
  // uncertain host is not a state to keep hiding in.
  if (process.platform !== "darwin") {
    // 这里**不**停宿主：`stopHost` 是 `startWindow` 的内部函数，模块作用域
    // 够不着它。0.1.1 在这里直接调用，于是关窗时抛
    // `ReferenceError: stopHost is not defined`，后面的 `app.quit()` 从未被
    // 安排——主进程无窗口挂着不退，单实例锁又让再次启动静默退出，用户只能
    // 去任务管理器杀进程。
    //
    // 宿主不需要这里再停一次：每个窗口自己的 `closed` 处理器已经写过
    // `shutdown` 并关掉 stdin（见 startWindow 末尾）。实测 Electron 的触发
    // 顺序是 `win.close()` → `window:closed` → `app:window-all-closed`，所以
    // 走到这里时宿主的停机流程已经启动。这个处理器只负责退出。
    //
    // 300ms 是给已经发出的 shutdown 写入与 stdin 关闭留一个事件循环，不是
    // 留给宿主处理完——`stopHost` 里另有一个 500ms 的硬杀兜底。
    setTimeout(() => app.quit(), 300);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) startWindow();
});
