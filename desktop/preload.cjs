/**
 * Preload bridge: the only surface the renderer can use to reach Electron.
 *
 * The members below are the ones this build can honour. Browser-only members
 * of the original preload (browser view, update check, image reading, system
 * integration) are intentionally absent: the renderer guards every optional
 * call, and an absent member is a clearer answer than a stub that fails.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("prometheus", {
  send: (payload) => ipcRenderer.send("host-send", payload),
  onEvent: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("host-event", listener);
    return () => ipcRenderer.removeListener("host-event", listener);
  },
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  pickFile: (options) => ipcRenderer.invoke("pick-file", options),
  windowControl: (action) => ipcRenderer.send("window-control", action),
  windowState: () => ipcRenderer.invoke("window-state"),
  onWindowState: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("window-state", listener);
    return () => ipcRenderer.removeListener("window-state", listener);
  },
  restartHost: () => ipcRenderer.send("host-restart"),
  saveFile: (suggestedName, content, filters) =>
    ipcRenderer.invoke("save-file", { suggestedName, content, filters }),
  appVersion: () => ipcRenderer.invoke("app-version"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  // Show a produced file in Explorer/Finder. The host is headless; only the
  // window process can reach the shell.
  revealArtifact: (target) => ipcRenderer.invoke("reveal-artifact", target),
  notify: (title, body) => ipcRenderer.invoke("notify", { title, body }),
  // In-app updates. Each call returns the resulting status, and every change
  // also arrives as a `update_status` message on `onEvent` — the same channel
  // the host uses, so the page has one place to read state from.
  //
  // No arguments cross this boundary on purpose: the main process owns the
  // updater, and "which version" / "from where" are not the renderer's to
  // choose. Checking, downloading and installing are three separate calls
  // because none of them may happen without a click.
  updateStatus: () => ipcRenderer.invoke("update-status"),
  updateCheck: () => ipcRenderer.invoke("update-check"),
  updateDownload: () => ipcRenderer.invoke("update-download"),
  updateInstall: () => ipcRenderer.invoke("update-install"),
  platform: process.platform,
});
