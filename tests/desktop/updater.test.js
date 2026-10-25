/**
 * The updater's pure half: result mapping, error classification, progress
 * clamping, and the controller's state machine driven by an injected fake.
 *
 * Nothing here imports `electron-updater` or touches the network: the library
 * is not installed in this checkout, and `createUpdater` takes its loader as a
 * parameter precisely so the state machine can be exercised without it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_STATES,
  checkResultToStatus,
  classifyUpdaterError,
  createUpdater,
  createUpdaterLogger,
  formatProgress,
  sanitizeMessage,
} from "../../desktop/updater.js";

/** A stand-in for `electron-updater`'s `NsisUpdater` with the members we use. */
function fakeUpdater(overrides = {}) {
  const handlers = new Map();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: true,
    logger: null,
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: "0.1.0" },
    })),
    downloadUpdate: vi.fn(async () => ["C:\\cache\\setup.exe"]),
    quitAndInstall: vi.fn(),
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return this;
    },
    emitFor(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    handlerCount(event) {
      return (handlers.get(event) ?? []).length;
    },
    ...overrides,
  };
}

function controllerFor(fake, options = {}) {
  const seen = [];
  const controller = createUpdater({
    onStatus: (status) => seen.push(status),
    isPackaged: true,
    loadAutoUpdater: async () => fake,
    ...options,
  });
  return { controller, seen };
}

describe("UPDATE_STATES", () => {
  it("每个状态都是小写短横线标识，且不重复", () => {
    expect(new Set(UPDATE_STATES).size).toBe(UPDATE_STATES.length);
    for (const state of UPDATE_STATES) expect(state).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("包含验收要求区分的那几个状态", () => {
    for (const state of ["checking", "up-to-date", "available", "downloading", "downloaded", "error", "unsupported"]) {
      expect(UPDATE_STATES).toContain(state);
    }
  });
});

describe("checkResultToStatus", () => {
  it("有新版 → available 并带上版本号", () => {
    expect(
      checkResultToStatus({
        isUpdateAvailable: true,
        updateInfo: { version: "0.2.0", releaseDate: "2026-11-01T00:00:00Z", releaseName: "v0.2.0" },
      }),
    ).toEqual({
      state: "available",
      version: "0.2.0",
      releaseDate: "2026-11-01T00:00:00Z",
      releaseName: "v0.2.0",
    });
  });

  it("无新版 → up-to-date，且仍带上远端版本号（可核对）", () => {
    expect(checkResultToStatus({ isUpdateAvailable: false, updateInfo: { version: "0.1.0" } })).toEqual({
      state: "up-to-date",
      version: "0.1.0",
    });
  });

  it("isUpdateAvailable 不是严格 true 时不宣称有新版", () => {
    for (const value of [undefined, null, 0, "true", 1]) {
      const status = checkResultToStatus({ isUpdateAvailable: value, updateInfo: { version: "9.9.9" } });
      expect(status.state).toBe("up-to-date");
    }
  });

  it("null（updater 自认未启用）→ unsupported，不是「已是最新」（R3）", () => {
    expect(checkResultToStatus(null)).toEqual({ state: "unsupported", reason: "disabled" });
    expect(checkResultToStatus(undefined)).toEqual({ state: "unsupported", reason: "disabled" });
  });

  it("旧字段名 versionInfo 也能读到版本", () => {
    expect(checkResultToStatus({ isUpdateAvailable: false, versionInfo: { version: "0.1.0" } })).toEqual({
      state: "up-to-date",
      version: "0.1.0",
    });
  });

  it("version 不是字符串时留空，不把 undefined 拼进界面", () => {
    expect(checkResultToStatus({ isUpdateAvailable: true, updateInfo: { version: 3 } })).toEqual({
      state: "available",
      version: "",
    });
  });

  it("空的 releaseDate / releaseName 不进状态", () => {
    const status = checkResultToStatus({
      isUpdateAvailable: true,
      updateInfo: { version: "0.2.0", releaseDate: "", releaseName: "" },
    });
    expect(status).not.toHaveProperty("releaseDate");
    expect(status).not.toHaveProperty("releaseName");
  });
});

describe("classifyUpdaterError", () => {
  const cases = [
    ["ERR_UPDATER_NO_PUBLISHED_VERSIONS", "no-release"],
    ["ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "no-release"],
    ["ERR_UPDATER_RELEASE_NOT_FOUND", "no-release"],
    // 发布事故：release 在，但少了 latest.yml。不能算「没有新版本」。
    ["ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", "no-manifest"],
    ["ERR_UPDATER_INVALID_SIGNATURE", "signature"],
    ["ERR_CHECKSUM_MISMATCH", "checksum"],
    ["ERR_UPDATER_NO_CHECKSUM", "checksum"],
    ["ERR_UPDATER_ASSET_NOT_FOUND", "download"],
    ["ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND", "download"],
    ["ERR_UPDATER_ZIP_FILE_NOT_FOUND", "download"],
    ["ERR_UPDATER_WEB_INSTALLER_DISABLED", "download"],
    ["ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION", "config"],
    ["ERR_UPDATER_UNSUPPORTED_PROVIDER", "config"],
    ["ERR_UPDATER_INVALID_RELEASE_FEED", "config"],
    ["ERR_UPDATER_INVALID_VERSION", "manifest"],
    ["ERR_UPDATER_INVALID_UPDATE_INFO", "manifest"],
    ["ENOTFOUND", "network"],
    ["EAI_AGAIN", "network"],
    ["ECONNRESET", "network"],
    ["ETIMEDOUT", "network"],
    ["ENOENT", "config"],
  ];

  for (const [code, reason] of cases) {
    it(`${code} → ${reason}`, () => {
      expect(classifyUpdaterError({ code, message: "boom" }).reason).toBe(reason);
    });
  }

  it("HttpError 的 statusCode 参与判定（4xx/5xx 都是源没答好）", () => {
    expect(classifyUpdaterError({ statusCode: 503, message: "HTTP error" }).reason).toBe("network");
    expect(classifyUpdaterError({ statusCode: 404, message: "HTTP error" }).reason).toBe("network");
    expect(classifyUpdaterError({ code: "HTTP_ERROR_500", message: "x" }).reason).toBe("network");
  });

  it("底层 fetch 的报错文案也认成网络问题", () => {
    expect(classifyUpdaterError({ message: "net::ERR_INTERNET_DISCONNECTED" }).reason).toBe("network");
    expect(classifyUpdaterError({ message: "getaddrinfo ENOTFOUND github.com" }).reason).toBe("network");
  });

  it("不认识的码留 unknown，不猜成「已是最新」", () => {
    expect(classifyUpdaterError({ code: "SOMETHING_NEW", message: "?" }).reason).toBe("unknown");
    expect(classifyUpdaterError(new Error("plain failure")).reason).toBe("unknown");
    expect(classifyUpdaterError(null).reason).toBe("unknown");
  });

  it("message 经过脱敏：不带 query 与 token", () => {
    const { message } = classifyUpdaterError({
      code: "ETIMEDOUT",
      message: "request to https://github.com/o/r/releases/download/v1/x.exe?token=abc123 failed",
    });
    expect(message).not.toContain("abc123");
    expect(message).toContain("?<redacted>");
  });
});

describe("sanitizeMessage", () => {
  it("只保留首行", () => {
    expect(sanitizeMessage("first\nsecond\nthird")).toBe("first");
  });

  it("去掉 URL 的 query 与 fragment，保留路径", () => {
    expect(sanitizeMessage("at https://host/a/b?signature=xyz#frag end")).toBe("at https://host/a/b?<redacted> end");
  });

  it("不带 query 的 URL 原样保留", () => {
    expect(sanitizeMessage("https://github.com/o/r")).toBe("https://github.com/o/r");
  });

  it("抹掉 bearer / token / api_key 的值", () => {
    expect(sanitizeMessage("Authorization: Bearer gh_123456")).not.toContain("gh_123456");
    expect(sanitizeMessage("token=abcdef")).not.toContain("abcdef");
    expect(sanitizeMessage("api_key: sk-live-9999")).not.toContain("sk-live-9999");
  });

  it("超长文案截断，带省略号", () => {
    const long = sanitizeMessage("x".repeat(400));
    expect(long).toHaveLength(298);
    expect(long.endsWith("…")).toBe(true);
  });

  it("接受 Error 与任意值", () => {
    expect(sanitizeMessage(new Error("nope"))).toBe("nope");
    expect(sanitizeMessage(undefined)).toBe("");
  });
});

describe("formatProgress", () => {
  it("四舍五入到一位小数并夹在 0..100", () => {
    expect(formatProgress({ percent: 33.3333 }).percent).toBe(33.3);
    expect(formatProgress({ percent: -5 }).percent).toBe(0);
    expect(formatProgress({ percent: 250 }).percent).toBe(100);
  });

  it("没有 percent 时用字节数算", () => {
    expect(formatProgress({ transferred: 50, total: 200 }).percent).toBe(25);
  });

  it("字节数不可用时百分比为 0，但不返回 NaN", () => {
    expect(formatProgress({ transferred: 0, total: 0 }).percent).toBe(0);
    expect(formatProgress({}).percent).toBe(0);
    expect(formatProgress(null).percent).toBe(0);
  });

  it("负的 / 非数字的传输量归零", () => {
    expect(formatProgress({ transferred: -1, total: 100 }).transferred).toBe(0);
    expect(formatProgress({ transferred: "many", total: 100 }).total).toBe(100);
  });

  it("bytesPerSecond 取整，负值归零", () => {
    expect(formatProgress({ percent: 1, bytesPerSecond: 1234.7 }).bytesPerSecond).toBe(1235);
    expect(formatProgress({ percent: 1, bytesPerSecond: -3 }).bytesPerSecond).toBe(0);
  });

  it("状态是 downloading", () => {
    expect(formatProgress({ percent: 10 }).state).toBe("downloading");
  });
});

describe("createUpdaterLogger", () => {
  it("按级别转给 console，并加上 [updater] 前缀", () => {
    const sink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = createUpdaterLogger(sink);
    logger.info("hello");
    logger.warn("careful");
    logger.error("bad");
    logger.debug("detail");
    expect(sink.log.mock.calls.map(([line]) => line)).toEqual(["[updater] hello", "[updater] detail"]);
    expect(sink.warn).toHaveBeenCalledWith("[updater] careful");
    expect(sink.error).toHaveBeenCalledWith("[updater] bad");
  });

  it("日志里不留 token 与 URL query", () => {
    const sink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    createUpdaterLogger(sink).info("GET https://h/p?token=SECRET");
    const line = sink.log.mock.calls[0][0];
    expect(line).not.toContain("SECRET");
    expect(line).toContain("?<redacted>");
  });

  it("空消息不打印（库会传 undefined）", () => {
    const sink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    createUpdaterLogger(sink).info(undefined);
    expect(sink.log).not.toHaveBeenCalled();
  });
});

describe("createUpdater — 开发形态", () => {
  it("isPackaged: false → 初始 unsupported/dev，且从不加载 electron-updater", async () => {
    const load = vi.fn(async () => fakeUpdater());
    const { controller, seen } = controllerFor(null, { isPackaged: false, loadAutoUpdater: load });
    expect(controller.status()).toEqual({ state: "unsupported", reason: "dev" });
    expect(await controller.check()).toEqual({ state: "unsupported", reason: "dev" });
    expect(await controller.download()).toEqual({ state: "unsupported", reason: "dev" });
    expect(await controller.install()).toBe(false);
    expect(load).not.toHaveBeenCalled();
    // 没有状态变化可播：初始状态已经是终态。
    expect(seen).toEqual([]);
  });
});

describe("createUpdater — 依赖缺失", () => {
  it("loader 返回 null → unsupported/missing，不抛", async () => {
    const { controller } = controllerFor(null, { loadAutoUpdater: async () => null });
    expect(await controller.check()).toEqual({ state: "unsupported", reason: "missing" });
  });

  it("loader 抛错（模块不存在）→ unsupported/missing，不抛", async () => {
    const { controller } = controllerFor(null, {
      loadAutoUpdater: async () => {
        throw new Error("Cannot find module 'electron-updater'");
      },
    });
    expect(await controller.check()).toEqual({ state: "unsupported", reason: "missing" });
  });

  it("加载到的东西没有 checkForUpdates（导出形状变了）→ unsupported/missing", async () => {
    const { controller } = controllerFor(null, { loadAutoUpdater: async () => ({ default: {} }) });
    expect(await controller.check()).toEqual({ state: "unsupported", reason: "missing" });
  });
});

describe("createUpdater — 绝不自动下载 / 自动安装", () => {
  it("初始化后 autoDownload 与 autoInstallOnAppQuit 都被显式关掉", async () => {
    const fake = fakeUpdater();
    const { controller } = controllerFor(fake);
    await controller.check();
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
  });

  it("只 check 不 download：downloadUpdate 没被调用", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } })),
    });
    const { controller } = controllerFor(fake);
    const status = await controller.check();
    expect(status).toEqual({ state: "available", version: "0.2.0" });
    expect(fake.downloadUpdate).not.toHaveBeenCalled();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it("没有 check 过就 download / install：什么都不做", async () => {
    const fake = fakeUpdater();
    const { controller } = controllerFor(fake);
    expect(await controller.download()).toEqual({ state: "idle" });
    expect(await controller.install()).toBe(false);
    expect(fake.downloadUpdate).not.toHaveBeenCalled();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("createUpdater — 检查结果", () => {
  it("无新版 → up-to-date", async () => {
    const fake = fakeUpdater();
    const { controller } = controllerFor(fake);
    expect(await controller.check()).toEqual({ state: "up-to-date", version: "0.1.0" });
  });

  it("checkForUpdates 返回 null → unsupported/disabled，而不是 up-to-date", async () => {
    const fake = fakeUpdater({ checkForUpdates: vi.fn(async () => null) });
    const { controller } = controllerFor(fake);
    expect(await controller.check()).toEqual({ state: "unsupported", reason: "disabled" });
  });

  it("网络失败 → error/network，带脱敏后的原因", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => {
        const error = new Error("getaddrinfo ENOTFOUND api.github.com");
        error.code = "ENOTFOUND";
        throw error;
      }),
    });
    const { controller } = controllerFor(fake);
    const status = await controller.check();
    expect(status).toMatchObject({ state: "error", reason: "network", code: "ENOTFOUND" });
    expect(status.message).toContain("ENOTFOUND");
  });

  it("校验失败 → error/signature（与网络失败区分开）", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => {
        const error = new Error("New version 0.2.0 is not signed by the application owner");
        error.code = "ERR_UPDATER_INVALID_SIGNATURE";
        throw error;
      }),
    });
    const { controller } = controllerFor(fake);
    expect(await controller.check()).toMatchObject({ state: "error", reason: "signature" });
  });

  it("发布端缺 latest.yml → error/no-manifest，不会被说成「已是最新」", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => {
        const error = new Error("Cannot find latest.yml in the latest release artifacts");
        error.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
        throw error;
      }),
    });
    const { controller } = controllerFor(fake);
    expect(await controller.check()).toMatchObject({ state: "error", reason: "no-manifest" });
  });

  it("重复 check 不重复挂监听", async () => {
    const fake = fakeUpdater();
    const { controller } = controllerFor(fake);
    await controller.check();
    await controller.check();
    expect(fake.handlerCount("error")).toBe(1);
    expect(fake.handlerCount("update-available")).toBe(1);
  });

  it("logger 被接到 updater 上", async () => {
    const fake = fakeUpdater();
    const { controller } = controllerFor(fake);
    await controller.check();
    expect(typeof fake.logger?.info).toBe("function");
    expect(typeof fake.logger?.error).toBe("function");
  });
});

describe("createUpdater — 下载与安装", () => {
  it("available 后 download → downloadUpdate 被调用，状态到 downloaded", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } })),
      downloadUpdate: vi.fn(async () => {
        fake.emitFor("download-progress", { percent: 40, transferred: 40, total: 100, bytesPerSecond: 10 });
        fake.emitFor("update-downloaded", { version: "0.2.0" });
        return ["C:\\cache\\setup.exe"];
      }),
    });
    const { controller, seen } = controllerFor(fake);
    await controller.check();
    const status = await controller.download();
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(status).toEqual({ state: "downloaded", version: "0.2.0" });
    expect(seen.map((entry) => entry.state)).toEqual(["checking", "available", "downloading", "downloaded"]);
  });

  it("下载失败 → error/download", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } })),
      downloadUpdate: vi.fn(async () => {
        const error = new Error("404");
        error.code = "ERR_UPDATER_ASSET_NOT_FOUND";
        throw error;
      }),
    });
    const { controller } = controllerFor(fake);
    await controller.check();
    expect(await controller.download()).toMatchObject({ state: "error", reason: "download" });
  });

  it("downloaded 后 install → quitAndInstall 带 (false, true)", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } })),
      downloadUpdate: vi.fn(async () => {
        fake.emitFor("update-downloaded", { version: "0.2.0" });
        return ["C:\\cache\\setup.exe"];
      }),
    });
    const { controller } = controllerFor(fake);
    await controller.check();
    await controller.download();
    expect(await controller.install()).toBe(true);
    // 非静默（用户看得见安装进度），装完自动启动新版本。
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("install 前先调 onBeforeInstall（让宿主先退出，别被安装器强杀）", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } })),
      downloadUpdate: vi.fn(async () => {
        fake.emitFor("update-downloaded", { version: "0.2.0" });
        return ["C:\\cache\\setup.exe"];
      }),
    });
    const order = [];
    fake.quitAndInstall = vi.fn(() => order.push("install"));
    const controller = createUpdater({
      onStatus: () => {},
      isPackaged: true,
      loadAutoUpdater: async () => fake,
      onBeforeInstall: () => order.push("stop-host"),
    });
    await controller.check();
    await controller.download();
    expect(await controller.install()).toBe(true);
    expect(order).toEqual(["stop-host", "install"]);
  });

  it("onBeforeInstall 抛错不阻断安装", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } })),
      downloadUpdate: vi.fn(async () => {
        fake.emitFor("update-downloaded", { version: "0.2.0" });
        return ["C:\\cache\\setup.exe"];
      }),
    });
    const controller = createUpdater({
      onStatus: () => {},
      isPackaged: true,
      loadAutoUpdater: async () => fake,
      onBeforeInstall: () => {
        throw new Error("host refused to die");
      },
    });
    await controller.check();
    await controller.download();
    expect(await controller.install()).toBe(true);
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("quitAndInstall 抛错 → error 状态并返回 false，不是未处理的 rejection", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } })),
      downloadUpdate: vi.fn(async () => {
        fake.emitFor("update-downloaded", { version: "0.2.0" });
        return ["C:\\cache\\setup.exe"];
      }),
      quitAndInstall: vi.fn(() => {
        throw Object.assign(new Error("Cannot run installer"), { code: "EACCES" });
      }),
    });
    const { controller } = controllerFor(fake);
    await controller.check();
    await controller.download();
    expect(await controller.install()).toBe(false);
    expect(controller.status()).toMatchObject({ state: "error" });
  });

  it("加载到的东西没有 on()（形状不对）→ unsupported/missing，不在 wire 里抛", async () => {
    const { controller } = controllerFor(null, {
      loadAutoUpdater: async () => ({ checkForUpdates: async () => null }),
    });
    expect(await controller.check()).toEqual({ state: "unsupported", reason: "missing" });
  });

  it("「有新版但还没下载」时 install 被拒绝", async () => {
    const fake = fakeUpdater({
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } })),
    });
    const { controller } = controllerFor(fake);
    await controller.check();
    expect(await controller.install()).toBe(false);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("createUpdater — 事件驱动的状态", () => {
  it("库自己发的 error 事件也进状态", async () => {
    const fake = fakeUpdater();
    const { controller } = controllerFor(fake);
    await controller.check();
    fake.emitFor("error", Object.assign(new Error("signature mismatch"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }));
    expect(controller.status()).toMatchObject({ state: "error", reason: "signature" });
  });

  it("update-available 事件更新版本号", async () => {
    const fake = fakeUpdater();
    const { controller } = controllerFor(fake);
    await controller.check();
    fake.emitFor("update-available", { version: "0.3.0", releaseDate: "2026-12-01T00:00:00Z" });
    expect(controller.status()).toEqual({
      state: "available",
      version: "0.3.0",
      releaseDate: "2026-12-01T00:00:00Z",
    });
  });

  it("重复的同值状态不重复上报（进度事件会刷屏）", async () => {
    const fake = fakeUpdater();
    const { controller, seen } = controllerFor(fake);
    await controller.check();
    const before = seen.length;
    fake.emitFor("download-progress", { percent: 10, transferred: 10, total: 100 });
    fake.emitFor("download-progress", { percent: 10, transferred: 10, total: 100 });
    fake.emitFor("download-progress", { percent: 20, transferred: 20, total: 100 });
    expect(seen.length).toBe(before + 2);
    expect(controller.status().percent).toBe(20);
  });

  it("onStatus 抛错不会让更新流程中断", async () => {
    const fake = fakeUpdater();
    const controller = createUpdater({
      onStatus: () => {
        throw new Error("renderer gone");
      },
      isPackaged: true,
      loadAutoUpdater: async () => fake,
    });
    await expect(controller.check()).resolves.toEqual({ state: "up-to-date", version: "0.1.0" });
  });
});
