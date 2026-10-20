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

const here = dirname(fileURLToPath(import.meta.url));
const HOST = join(here, "host", "host.js");
const RENDERER = join(here, "renderer", "index.html");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

/** Workspace the host is started in; the renderer can narrow it, not widen it. */
const startCwd = process.cwd();

function startWindow(options = {}) {
  const win = new BrowserWindow({
    ...(options.bounds ? options.bounds : { width: 1360, height: 880 }),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0e0e10",
    title: "Embedded AI Master",
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
  ipcMain.handle("notify", (_event, payload) => {
    if (Notification.isSupported()) {
      new Notification({ title: String(payload?.title ?? "Embedded AI Master"), body: String(payload?.body ?? "") }).show();
    }
  });

  win.on("closed", () => {
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
  startWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) startWindow();
});
