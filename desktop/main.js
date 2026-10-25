/**
 * Electron main process: one window, one agent host child process.
 *
 * The window loads the renderer from `desktop/renderer/index.html` — plain ES
 * modules, no bundler — and talks to the host over NDJSON on stdio. The host
 * is a separate process on purpose: a crash or a runaway tool takes the agent
 * down, not the window, and the renderer can ask for a restart without losing
 * its scroll position.
 */

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
  startWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // 关窗即退出前先请 host 走 shutdown：里面会关串口、停后台作业。上一轮
    // 事故的孤儿实例就是这里直接 quit，host（和它攥着的 COM 口）没收到任何
    // 通知，任务栏图标没了进程还在，串口被占到手动杀进程为止。
    stopHost();
    setTimeout(() => app.quit(), 300);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) startWindow();
});
