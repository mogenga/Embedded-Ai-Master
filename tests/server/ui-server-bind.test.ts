import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUiServer } from "../../src/server/api.js";

/**
 * D-171：`createUiServer` 在端口被占用时曾让整个进程退出。
 *
 * `server.listen()` 是异步的，EADDRINUSE 以 `error` 事件送达；没有监听者的
 * `error` 事件在 Node 里是未捕获异常。这些用例直接以「进程还活着、调用方
 * 拿得到失败信号」为断言——如果回归，worker 会在跑到断言前就崩掉。
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("无法获取空闲端口")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function occupy(port: number): Promise<{ close(): Promise<void> }> {
  const blocker = createNetServer();
  return new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => {
      resolve({
        close: () => new Promise<void>((done) => blocker.close(() => done())),
      });
    });
  });
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "eam-ui-bind-"));
  // 其它并行改动会把「vitest 下缺 HARNESS_HOME」变成硬错误；显式指向临时目录。
  vi.stubEnv("HARNESS_HOME", home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("createUiServer 绑定失败（D-171）", () => {
  it("端口被占用时 listening 以 EADDRINUSE 拒绝，进程不退出且能 close", async () => {
    const port = await freePort();
    const blocker = await occupy(port);
    try {
      const ui = createUiServer({ harnessHome: home, port, host: "127.0.0.1" });
      await expect(ui.listening).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(ui.server.listening).toBe(false);
      // 绑定失败后收尾必须安全：内部 runner 也要关掉，不能留下悬挂句柄。
      await expect(ui.close()).resolves.toBeUndefined();
    } finally {
      await blocker.close();
    }
  });

  it("调用方不 await listening 时也不会产生未处理拒绝", async () => {
    const port = await freePort();
    const blocker = await occupy(port);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // 旧调用点（43 处）就是这个形状：拿返回值、不 await 任何绑定信号。
      const ui = createUiServer({ harnessHome: home, port, host: "127.0.0.1" });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
      expect(ui.server.listening).toBe(false);
      await ui.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await blocker.close();
    }
  });
});
