import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/manager.js";
import type { McpStatusEvent } from "../src/mcp/manager.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
const roots: string[] = [];
const managers: McpManager[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-manager-"));
  roots.push(root);
  return root;
}

function config(name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    command: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    ...extra,
  };
}

function track(manager: McpManager): McpManager {
  managers.push(manager);
  return manager;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

afterEach(async () => {
  while (managers.length > 0) {
    await managers.pop()?.close();
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("McpManager 连接与工具发现", () => {
  it("connectAll 发现工具并记录 connected 状态", async () => {
    const events: McpStatusEvent[] = [];
    const manager = track(new McpManager([config("echo")], { logger: (event) => events.push(event) }));

    await manager.connectAll();

    const names = manager.tools().map((tool) => tool.tool);
    expect(names).toEqual(
      expect.arrayContaining(["echo", "multi", "fail", "slow", "grow", "binary", "structured", "crash"]),
    );
    const echo = manager.tools().find((tool) => tool.tool === "echo");
    expect(echo).toMatchObject({ server: "echo", tool: "echo", description: "Echo the provided text" });
    expect(echo?.inputSchema).toMatchObject({ type: "object" });
    expect(echo?.readOnly).toBe(true);
    expect(echo?.evidence).toBe(true);
    expect(manager.tools().find((tool) => tool.tool === "multi")?.evidence).toBeUndefined();
    expect(manager.tools().find((tool) => tool.tool === "crash")?.destructive).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ kind: "connected", server: "echo" }));
    expect(events.find((event) => event.kind === "connected")?.toolCount).toBeGreaterThan(0);
  });

  // 这条测的是「故障隔离」而不是耗时：并发跑整套测试时，spawn 两次子进程可能超过 vitest
  // 默认 5s，从而把负载抖动误报成隔离失败（D-156）。隔离性本身由下方断言保证。
  it("单个 server 失败不阻塞其他 server", async () => {
    const events: McpStatusEvent[] = [];
    const manager = track(
      new McpManager(
        [
          config("echo"),
          config("broken", { command: "definitely-not-a-real-command-embedded-ai" }),
        ],
        { logger: (event) => events.push(event) },
      ),
    );

    await expect(manager.connectAll()).resolves.toBeUndefined();

    expect(manager.tools().some((tool) => tool.server === "echo")).toBe(true);
    expect(manager.tools().some((tool) => tool.server === "broken")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: "connect_failed", server: "broken" }));
  }, 30_000);

  it("connectAll 与 close 幂等", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const manager = new McpManager([config("echo", { env: { PID_FILE: pidFile } })]);
    await manager.connectAll();
    const pid = readFileSync(pidFile, "utf8");

    await manager.connectAll();
    expect(readFileSync(pidFile, "utf8")).toBe(pid);

    await manager.close();
    await manager.close();
    await manager.connectAll();
    expect(manager.tools()).toEqual([]);
  });

  it("连接超时可注入并记录 connect_failed，且回收子进程", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const events: McpStatusEvent[] = [];
    const manager = track(
      new McpManager([config("silent", { env: { SILENT: "1", PID_FILE: pidFile } })], {
        connectTimeoutMs: 300,
        logger: (event) => events.push(event),
      }),
    );

    const started = Date.now();
    await manager.connectAll();
    const pid = Number(readFileSync(pidFile, "utf8"));

    // 断言的是「注入的 300ms 生效」而不是「耗时接近 300ms」：并发跑整套测试时，
    // spawn 与回收子进程本身可能耗时数秒（D-156）。只要远小于默认 15s 就证明注入生效。
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(manager.tools()).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "connect_failed", server: "silent" }));
    await waitFor(() => !isAlive(pid), 3_000);
  }, 30_000);

  /**
   * 并行连接：判据是**两次 connected 的时间差**，但延迟放大到 2000ms。
   *
   * 历史：这条最初用 `START_DELAY_MS: 300` + 阈值 300ms，2026-10-26 在满载下
   * （同时跑 electron-builder 打包）五次全量里红三次。差值这个量是「两次子
   * 进程启动耗时之差」，没有上界；想靠调阈值让它稳，等于在赌负载。
   *
   * 试过换成「总耗时 < 450ms」——**那次改动是错的**：实测 679ms，而两次
   * connected 明明只差几十毫秒。`connectAll` 除了两个 300ms 的延迟，还要做
   * 工具加载与状态收敛，这些**与是否并行无关**，混进总耗时就是噪声。
   *
   * 正确做法是保留差值判据、**把信号放大**：延迟拉到 2000ms 后，串行的下界
   * 就是 2000ms，而并行时两个 connected 仍然几乎同时。此时阈值放在 1500ms，
   * 距并行实测值有 1.5 秒余量，距串行下界有 500ms 余量——负载再怎么抖，
   * 也不会把一个实际并行的事件序列推过 1500ms 的差。
   *
   * 代价：这条用例从约 0.7 秒变成约 2.2 秒。用一个可以忽略的墙钟开销换一条
   * 不再随负载变红的用例，值得。
   */
  it("connectAll 并行连接多个 server", { timeout: 30_000 }, async () => {
    const connectedAt: number[] = [];
    const manager = track(
      new McpManager(
        [
          config("slow-a", { env: { START_DELAY_MS: "2000" } }),
          config("slow-b", { env: { START_DELAY_MS: "2000" } }),
        ],
        {
          logger: (event) => {
            if (event.kind === "connected") {
              connectedAt.push(Date.now());
            }
          },
        },
      ),
    );

    await manager.connectAll();

    expect(connectedAt).toHaveLength(2);
    // 串行下界 = 2000ms（两次延迟之和）；阈值 1500ms 距并行实测有 1.5s 余量。
    expect(Math.abs(connectedAt[0] - connectedAt[1])).toBeLessThan(1500);
  });

  it("close 与 connect 并发时不产生 connected 事件并回收子进程", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const events: McpStatusEvent[] = [];
    const manager = track(
      new McpManager([config("silent", { env: { SILENT: "1", PID_FILE: pidFile } })], {
        connectTimeoutMs: 500,
        logger: (event) => events.push(event),
      }),
    );

    const connecting = manager.connectAll();
    await waitFor(() => existsSync(pidFile), 2_000);
    await manager.close();
    await connecting;

    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(events).toEqual([]);
    expect(manager.tools()).toEqual([]);
    await waitFor(() => !isAlive(pid), 3_000);
    expect(await manager.call("silent", "echo", {}, signal())).toMatchObject({
      isError: true,
      code: "mcp_unavailable",
    });
  });
});

describe("McpManager 工具调用", () => {
  it("call echo 拼接文本，fail 返回 mcp_tool_error", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    const echo = await manager.call("echo", "echo", { text: "hello" }, signal());
    expect(echo).toMatchObject({ isError: false, code: "ok", text: "hello", message: "" });

    const multi = await manager.call("echo", "multi", { a: "first", b: "second" }, signal());
    expect(multi.isError).toBe(false);
    expect(multi.text).toBe("first\nsecond");

    const failure = await manager.call("echo", "fail", {}, signal());
    expect(failure.isError).toBe(true);
    expect(failure.code).toBe("mcp_tool_error");
    expect(failure.text).toBe("boom");
    expect(failure.message).toBe("boom");
    expect(failure.detail).toMatchObject({ content: [{ type: "text", text: "boom" }] });
  });

  it("非 text content 与 structuredContent 序列化为 JSON 文本", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    const binary = await manager.call("echo", "binary", {}, signal());
    expect(binary.isError).toBe(false);
    expect(JSON.parse(binary.text)).toMatchObject({ type: "image", mimeType: "image/png" });

    const structured = await manager.call("echo", "structured", {}, signal());
    expect(structured.isError).toBe(false);
    expect(JSON.parse(structured.text)).toEqual({ answer: 42 });
    expect(structured.structuredContent).toEqual({ answer: 42 });
  });

  it("失败结果的 structuredContent 同样原样透传", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    const failure = await manager.call("echo", "fail", {}, signal());

    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toEqual({ reason: "boom" });
  });

  it("inheritEnv:true 时继承 process.env、config.env 覆盖同名并透传 cwd", async () => {
    const root = tempRoot();
    const previousParentOnly = process.env.MCP_MANAGER_TEST_PARENT_ONLY;
    const previousMarker = process.env.MCP_MANAGER_TEST_MARKER;
    process.env.MCP_MANAGER_TEST_PARENT_ONLY = "parent-only";
    process.env.MCP_MANAGER_TEST_MARKER = "parent";
    try {
      const manager = track(
        new McpManager([
          config("echo", {
            inheritEnv: true,
            cwd: root,
            env: {
              MCP_MANAGER_TEST_MARKER: "config",
              MCP_MANAGER_TEST_CONFIG_ONLY: "config-only",
            },
          }),
        ]),
      );
      await manager.connectAll();

      const env = await manager.call("echo", "env", {}, signal());
      expect(JSON.parse(env.text)).toEqual({
        parentOnly: "parent-only",
        marker: "config",
        configOnly: "config-only",
      });

      const pwd = await manager.call("echo", "pwd", {}, signal());
      expect(path.resolve(pwd.text)).toBe(path.resolve(root));
    } finally {
      if (previousParentOnly === undefined) {
        delete process.env.MCP_MANAGER_TEST_PARENT_ONLY;
      } else {
        process.env.MCP_MANAGER_TEST_PARENT_ONLY = previousParentOnly;
      }
      if (previousMarker === undefined) {
        delete process.env.MCP_MANAGER_TEST_MARKER;
      } else {
        process.env.MCP_MANAGER_TEST_MARKER = previousMarker;
      }
    }
  });

  it("默认只传白名单 env，父进程其他变量不可见", async () => {
    const previous = process.env.MCP_MANAGER_TEST_PARENT_ONLY;
    process.env.MCP_MANAGER_TEST_PARENT_ONLY = "secret";
    try {
      const manager = track(new McpManager([config("echo")]));
      await manager.connectAll();

      const env = await manager.call("echo", "env", {}, signal());
      expect(JSON.parse(env.text)).toEqual({
        parentOnly: null,
        marker: null,
        configOnly: null,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_MANAGER_TEST_PARENT_ONLY;
      } else {
        process.env.MCP_MANAGER_TEST_PARENT_ONLY = previous;
      }
    }
  });

  it("envAllowlist 显式放行指定的父进程变量", async () => {
    const previous = process.env.MCP_MANAGER_TEST_PARENT_ONLY;
    process.env.MCP_MANAGER_TEST_PARENT_ONLY = "allowed";
    try {
      const manager = track(
        new McpManager([
          config("echo", { envAllowlist: ["MCP_MANAGER_TEST_PARENT_ONLY"] }),
        ]),
      );
      await manager.connectAll();

      const env = await manager.call("echo", "env", {}, signal());
      expect(JSON.parse(env.text)).toMatchObject({ parentOnly: "allowed" });
    } finally {
      if (previous === undefined) {
        delete process.env.MCP_MANAGER_TEST_PARENT_ONLY;
      } else {
        process.env.MCP_MANAGER_TEST_PARENT_ONLY = previous;
      }
    }
  });

  it("参数校验失败返回 mcp_tool_error", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    const invalid = await manager.call("echo", "echo", { wrong: "shape" }, signal());
    expect(invalid).toMatchObject({ isError: true, code: "mcp_tool_error" });
  });

  it("同一 server 的调用串行，不重叠", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    const [first, second] = await Promise.all([
      manager.call("echo", "slow", { ms: 150, tag: "first" }, signal()),
      manager.call("echo", "slow", { ms: 20, tag: "second" }, signal()),
    ]);

    const firstRange = JSON.parse(first.text) as { tag: string; start: number; end: number };
    const secondRange = JSON.parse(second.text) as { tag: string; start: number; end: number };
    expect(firstRange.tag).toBe("first");
    expect(secondRange.tag).toBe("second");
    expect(secondRange.start).toBeGreaterThanOrEqual(firstRange.end);
  });

  it("timeout 返回 mcp_timeout，abort 返回 mcp_aborted", async () => {
    const timeoutManager = track(new McpManager([config("echo", { timeoutMs: 100 })]));
    await timeoutManager.connectAll();

    const timedOut = await timeoutManager.call("echo", "slow", { ms: 800, tag: "timeout" }, signal());
    expect(timedOut).toMatchObject({ isError: true, code: "mcp_timeout" });

    const abortManager = track(new McpManager([config("abort", { timeoutMs: 5_000 })]));
    await abortManager.connectAll();
    const controller = new AbortController();
    const started = Date.now();
    const pending = abortManager.call("abort", "slow", { ms: 800, tag: "abort" }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const aborted = await pending;

    expect(aborted).toMatchObject({ isError: true, code: "mcp_aborted" });
    expect(Date.now() - started).toBeLessThan(600);
  });

  /**
   * 这条曾经是全量跑里最稳定的一条红。
   *
   * 根因不是超时阈值，是**竞速**：调用超时后 `beginDispose` 异步跑
   * `terminateAndWait(pid)`，而 `terminateAndWait` 的预算默认
   * `DEFAULT_TERMINATE_TIMEOUT_MS = 2000`。紧接着的下一次 `call` 会
   * `await state.terminating`，等满仍没死就把状态标成 `uncertain`，返回
   * `mcp_uncertain` 而不是重连。
   *
   * 实测（`PID_LOG`+`isAlive` 打点）：空载时「杀到确认死亡」约 950–1100 ms，
   * 已经是 2 s 预算的一半；同一台机器上并发跑 7 份本文件时该值升到
   * 约 2080 ms——**刚好越线**，于是七份全红。也就是说这条用例测的是
   * 「2 秒内 taskkill 能收走一个 Node 子进程」，那是机器的负载，不是 manager
   * 的语义。
   *
   * 修法：预算是 `McpManagerOptions.terminateTimeoutMs` 的既有可注入项，把它
   * 放大到 10 s（见下方构造），用例就只锁自己真正要锁的东西——超时 → 旧进程
   * 被收 → 下一次调用重连成功 → 一共只 spawn 两个进程。断言一条未删：进程
   * 仍须真的消失（`waitFor(isAlive → false)`），pids 仍须恰好两条。
   *
   * 「终止未确认时拒绝重连并返回 mcp_uncertain」那条仍用很小的预算（50 ms）
   * 覆盖 `uncertain` 分支本身，两个方向都有人管。
   */
  it("timeout 后关闭 server，后续调用重连且不残留旧进程", async () => {
    const root = tempRoot();
    const pidLog = path.join(root, "pid.log");
    // 终止预算放大到 10 s。默认 2 s 在这里不是被测对象，而是一条「机器多快
    // 能收走一个 Node 子进程」的门槛：实测空载 ~1.0 s，满载 ~2.08 s，越线后
    // manager 按设计标 `uncertain` 并拒绝重连，于是本用例红在一个与重连无关
    // 的量上。预算已经是 `McpManagerOptions` 的可注入项，测试侧直接注入。
    const manager = track(
      new McpManager(
        [config("echo", { timeoutMs: 100, env: { PID_LOG: pidLog } })],
        { terminateTimeoutMs: 10_000 },
      ),
    );
    await manager.connectAll();
    const firstPid = Number(readFileSync(pidLog, "utf8").trim().split("\n")[0]);

    const timedOut = await manager.call("echo", "slow", { ms: 800, tag: "timeout" }, signal());
    expect(timedOut).toMatchObject({ isError: true, code: "mcp_timeout" });
    // 旧进程必须真的消失——这是断言，不是等待技巧。上限与上面注入的终止预算
    // 同量级：满载时 `taskkill` 走完可能要好几秒（实测 6 份并发 > 3 s）。
    await waitFor(() => !isAlive(firstPid), 15_000);

    const after = await manager.call("echo", "echo", { text: "after-timeout" }, signal());
    expect(after).toMatchObject({ isError: false, code: "ok", text: "after-timeout" });
    const pids = readFileSync(pidLog, "utf8").trim().split("\n");
    expect(pids).toHaveLength(2);
  }, 30_000);

  it("终止未确认时拒绝重连并返回 mcp_uncertain", async () => {
    const root = tempRoot();
    const pidLog = path.join(root, "pid.log");
    const manager = track(
      new McpManager(
        [config("echo", { timeoutMs: 100, env: { PID_LOG: pidLog } })],
        { terminateTimeoutMs: 50 },
      ),
    );
    await manager.connectAll();
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      sig?: NodeJS.Signals | number,
    ) => {
      if (sig === 0) return true;
      return originalKill(pid, sig);
    }) as typeof process.kill);
    try {
      const timedOut = await manager.call("echo", "slow", { ms: 800, tag: "timeout" }, signal());
      expect(timedOut).toMatchObject({ isError: true, code: "mcp_timeout" });

      const next = await manager.call("echo", "echo", { text: "after-timeout" }, signal());

      expect(next).toMatchObject({ isError: true, code: "mcp_uncertain" });
      expect(readFileSync(pidLog, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("已取消的 signal 立即返回 mcp_aborted，signal 可省略", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    const controller = new AbortController();
    controller.abort();
    expect(await manager.call("echo", "echo", { text: "aborted" }, controller.signal)).toMatchObject({
      isError: true,
      code: "mcp_aborted",
    });

    expect(await manager.call("echo", "echo", { text: "no-signal" })).toMatchObject({
      isError: false,
      code: "ok",
      text: "no-signal",
    });
  });

  it("close 后排队中的调用返回 mcp_unavailable", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    const first = manager.call("echo", "slow", { ms: 300, tag: "first" }, signal());
    const queued = manager.call("echo", "echo", { text: "queued" }, signal());
    await manager.close();
    await first.catch(() => undefined);

    expect(await queued).toMatchObject({ isError: true, code: "mcp_unavailable" });
  });

  it("未知 server/tool 返回 mcp_unavailable", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    expect(await manager.call("missing", "echo", {}, signal())).toMatchObject({
      isError: true,
      code: "mcp_unavailable",
    });
    expect(await manager.call("echo", "missing", {}, signal())).toMatchObject({
      isError: true,
      code: "mcp_tool_error",
    });
  });
});

describe("McpManager 会话级复用支持", () => {
  it("onToolsChanged 返回的取消函数生效：取消后不再收到通知", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();
    const changed: string[] = [];
    const off = manager.onToolsChanged((server) => changed.push(server));
    const kept: string[] = [];
    manager.onToolsChanged((server) => kept.push(server));

    await manager.call("echo", "grow", {}, signal());
    await waitFor(() => changed.length > 0);
    off();

    await manager.call("echo", "grow", {}, signal());
    await waitFor(() => kept.length >= 2);
    // 取消之后的那次通知只到留下的 listener。
    expect(changed).toEqual(["echo"]);
    expect(kept.length).toBeGreaterThanOrEqual(2);
  });

  it("setLogger 重绑后新事件走新 logger", async () => {
    const first: McpStatusEvent[] = [];
    const second: McpStatusEvent[] = [];
    const manager = track(
      new McpManager([config("echo")], { logger: (event) => first.push(event) }),
    );
    await manager.connectAll();
    expect(first).toContainEqual(expect.objectContaining({ kind: "connected" }));

    manager.setLogger((event) => second.push(event));
    await manager.call("echo", "grow", {}, signal());
    await waitFor(() => second.some((event) => event.kind === "tools_changed"));

    expect(second).toContainEqual(expect.objectContaining({ kind: "tools_changed" }));
    // 重绑之后旧 sink 不再收到任何事件。
    expect(first.some((event) => event.kind === "tools_changed")).toBe(false);
  });

});

describe("McpManager 断线与重连", () => {
  it("断线后 call 自动重连一次并通知 onToolsChanged", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const events: McpStatusEvent[] = [];
    const manager = track(
      new McpManager([config("echo", { env: { PID_FILE: pidFile } })], {
        logger: (event) => events.push(event),
      }),
    );
    const changed: string[] = [];
    manager.onToolsChanged((server) => changed.push(server));
    await manager.connectAll();
    expect(changed).toEqual([]);

    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(pid)).toBe(true);

    const first = await manager.call("echo", "crash", {}, signal());
    expect(first).toMatchObject({ isError: false, code: "ok", text: "bye" });
    await waitFor(() => !isAlive(pid), 3_000);

    const result = await manager.call("echo", "echo", { text: "after-crash" }, signal());
    expect(result).toMatchObject({ isError: false, code: "ok", text: "after-crash" });

    const newPid = Number(readFileSync(pidFile, "utf8"));
    expect(newPid).not.toBe(pid);
    expect(changed).toEqual(["echo"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "tools_changed", server: "echo" }));
  });

  it("调用中断线重连一次；重试仍断线返回 mcp_unavailable", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const manager = track(new McpManager([config("echo", { env: { PID_FILE: pidFile } })]));
    await manager.connectAll();

    const failed = await manager.call("echo", "vanish", {}, signal());
    expect(failed).toMatchObject({ isError: true, code: "mcp_unavailable" });

    const after = await manager.call("echo", "echo", { text: "alive" }, signal());
    expect(after).toMatchObject({ isError: false, code: "ok", text: "alive" });
  }, 15_000);

  it("破坏性工具断线后不自动重试，返回 mcp_uncertain", async () => {
    const root = tempRoot();
    const pidLog = path.join(root, "pid.log");
    const manager = track(new McpManager([config("echo", { env: { PID_LOG: pidLog } })]));
    await manager.connectAll();

    const result = await manager.call("echo", "vanish-destructive", {}, signal());
    expect(result).toMatchObject({ isError: true, code: "mcp_uncertain" });
    const pids = readFileSync(pidLog, "utf8").trim().split("\n");
    expect(pids).toHaveLength(1);
  }, 15_000);

  it("重连仍失败时返回 mcp_unavailable 并保留旧工具缓存", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const serverConfig = config("echo", { env: { PID_FILE: pidFile } });
    const manager = track(new McpManager([serverConfig]));
    await manager.connectAll();
    const pid = Number(readFileSync(pidFile, "utf8"));
    const before = manager.tools().map((tool) => tool.tool);

    await manager.call("echo", "crash", {}, signal()).catch(() => undefined);
    await waitFor(() => !isAlive(pid), 3_000);
    serverConfig.command = "definitely-not-a-real-command-embedded-ai";

    const result = await manager.call("echo", "echo", { text: "nope" }, signal());
    expect(result).toMatchObject({ isError: true, code: "mcp_unavailable" });
    expect(manager.tools().map((tool) => tool.tool)).toEqual(before);
  });

  it("首连失败后经 call 恢复成功触发 tools_changed 与 onToolsChanged", async () => {
    const events: McpStatusEvent[] = [];
    const changed: string[] = [];
    const serverConfig = config("echo", { command: "definitely-not-a-real-command-embedded-ai" });
    const manager = track(new McpManager([serverConfig], { logger: (event) => events.push(event) }));
    manager.onToolsChanged((server) => changed.push(server));

    await manager.connectAll();
    expect(events).toContainEqual(expect.objectContaining({ kind: "connect_failed", server: "echo" }));
    expect(changed).toEqual([]);

    serverConfig.command = process.execPath;
    const result = await manager.call("echo", "echo", { text: "recovered" }, signal());
    expect(result).toMatchObject({ isError: false, code: "ok", text: "recovered" });
    expect(changed).toEqual(["echo"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "tools_changed", server: "echo" }));
  });

  it("断线恢复只重连一次（按 spawn 计数）", async () => {
    const root = tempRoot();
    const pidLog = path.join(root, "pid.log");
    const manager = track(new McpManager([config("echo", { env: { PID_LOG: pidLog } })]));
    const pids = () => readFileSync(pidLog, "utf8").trim().split("\n").map(Number);

    await manager.connectAll();
    expect(pids()).toHaveLength(1);

    await manager.call("echo", "crash", {}, signal());
    await waitFor(() => !isAlive(pids()[0]), 3_000);

    const result = await manager.call("echo", "echo", { text: "once" }, signal());
    expect(result).toMatchObject({ isError: false, code: "ok", text: "once" });
    expect(pids()).toHaveLength(2);
  });
});

describe("McpManager list_changed 与关闭", () => {
  it("list_changed 刷新工具并触发 onToolsChanged 与 status", async () => {
    const events: McpStatusEvent[] = [];
    const manager = track(new McpManager([config("echo")], { logger: (event) => events.push(event) }));
    await manager.connectAll();
    const changed: string[] = [];
    manager.onToolsChanged((server) => changed.push(server));

    await manager.call("echo", "grow", {}, signal());
    await waitFor(() => manager.tools().some((tool) => tool.tool.startsWith("grown-")));

    expect(changed).toEqual(["echo"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "tools_changed", server: "echo" }));
    expect(events.find((event) => event.kind === "tools_changed")?.toolCount).toBeGreaterThan(0);
  });

  it("onToolsChanged listener 抛错不影响其他 listener 与后续调用", async () => {
    const events: McpStatusEvent[] = [];
    const manager = track(new McpManager([config("echo")], { logger: (event) => events.push(event) }));
    await manager.connectAll();
    const changed: string[] = [];
    manager.onToolsChanged(() => {
      throw new Error("listener boom");
    });
    manager.onToolsChanged((server) => changed.push(server));

    await manager.call("echo", "grow", {}, signal());
    await waitFor(() => changed.length > 0);

    expect(changed).toEqual(["echo"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "listener_failed", server: "echo" }));
    expect(await manager.call("echo", "echo", { text: "still-alive" }, signal())).toMatchObject({
      isError: false,
      code: "ok",
      text: "still-alive",
    });
  });

  it("刷新失败时保留旧缓存并记录 tools_refresh_failed", async () => {
    const events: McpStatusEvent[] = [];
    const manager = track(new McpManager([config("echo")], { logger: (event) => events.push(event) }));
    await manager.connectAll();
    const before = manager.tools().map((tool) => tool.tool);
    const changed: string[] = [];
    manager.onToolsChanged((server) => changed.push(server));

    await manager.call("echo", "grow-broken", {}, signal());
    await waitFor(() => events.some((event) => event.kind === "tools_refresh_failed"));

    expect(changed).toEqual([]);
    expect(manager.tools().map((tool) => tool.tool)).toEqual(before);
  });

  it("坏 schema 导致 tools/list 校验失败时保留旧缓存并记录 tools_refresh_failed", async () => {
    const events: McpStatusEvent[] = [];
    const manager = track(new McpManager([config("echo")], { logger: (event) => events.push(event) }));
    await manager.connectAll();
    const before = manager.tools().map((tool) => tool.tool);

    await manager.call("echo", "bad-schema", {}, signal());
    await waitFor(() => events.some((event) => event.kind === "tools_refresh_failed"));

    expect(events).toContainEqual(
      expect.objectContaining({ kind: "tools_refresh_failed", server: "echo" }),
    );
    expect(manager.tools().map((tool) => tool.tool)).toEqual(before);
    expect(manager.tools().map((tool) => tool.tool)).not.toContain("invalid");
  });

  it("close 关闭 client 并回收子进程", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const manager = new McpManager([config("echo", { env: { PID_FILE: pidFile } })]);
    await manager.connectAll();
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(pid)).toBe(true);

    await manager.close();

    await waitFor(() => !isAlive(pid), 3_000);
    expect(await manager.call("echo", "echo", { text: "closed" }, signal())).toMatchObject({
      isError: true,
      code: "mcp_unavailable",
    });
  });

  /**
   * D-225 / BACKLOG 6.1：正常关闭要回收整棵进程树。
   *
   * **这条钉住的是仓库里真实存在的形态**：领域 server 的 `spawn` 全都**没有**
   * `detached`（`probe/renode.ts`、`serial/serial.ts`、`keil/uvsock.ts`），
   * 所以孙进程与 MCP server 同属一个 libuv 的 kill-on-close Job Object。实测
   * 三层链只杀最上层，孙与曾孙全灭。这条用例保证 `close()` 之后这条性质仍然
   * 成立——将来谁把 server 的直接子进程 `unref` 掉或改了关闭顺序，它会红。
   *
   * **detached 后代不在这条的能力范围内**，因为它收不了：`taskkill /T` 依赖
   * 活着的父进程枚举，而真实 server 在 stdin EOF 后 0–109 ms 就退出（实测），
   * taskkill 要约 1 s 才开始枚举。这条边界写在 `reapProcessTree` 的方法注释里，
   * 也在 D-225 的复核注记里。
   */
  it("close 回收整棵进程树：父进程与非 detached 孙进程都退出", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const grandchildFile = path.join(root, "grandchild.pid");
    const manager = new McpManager([
      config("echo", {
        env: { PID_FILE: pidFile, GRANDCHILD_PID_FILE: grandchildFile },
      }),
    ]);
    await manager.connectAll();
    // 两个 pid 文件由子进程在启动时写；`connected` 只保证 MCP 握手完成，
    // 不保证孙进程已经 spawn 出来。等到文件里有非空内容再读，避免读空串得到 0。
    await waitFor(
      () =>
        existsSync(pidFile) &&
        readFileSync(pidFile, "utf8").trim() !== "" &&
        existsSync(grandchildFile) &&
        readFileSync(grandchildFile, "utf8").trim() !== "",
      3_000,
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    const grandchildPid = Number(readFileSync(grandchildFile, "utf8"));
    expect(isAlive(pid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    await manager.close();

    await waitFor(() => !isAlive(pid), 3_000);
    await waitFor(() => !isAlive(grandchildPid), 3_000);
  }, 20_000);

  /**
   * 回收器起不来时不能伪装成成功（R3）。
   *
   * `taskkill` 找不到（本机实测：把 PATH 清空即可稳定制造 `spawn taskkill
   * ENOENT`）时，父进程仍然会被 SDK 的 close 收掉，但整棵树的回收没有发生。
   * 此时必须留下一条可读的 `mcp_status`（kind `dispose_incomplete`），而不是
   * 静默当作清干净了。
   *
   * 用真实 ENOENT，不打桩：打桩只能证明「我调用了它」，不能证明真实失败路径上
   * 的行为。这条在 POSIX 上不适用（走的是 `process.kill` 分支，没有 taskkill），
   * 所以按平台跳过。
   */
  it.skipIf(process.platform !== "win32")(
    "回收器起不来时记录 dispose_incomplete，不伪装成成功",
    async () => {
      const root = tempRoot();
      const pidFile = path.join(root, "pid");
      const grandchildFile = path.join(root, "grandchild.pid");
      const events: McpStatusEvent[] = [];
      const manager = new McpManager(
        [
          config("echo", {
            env: { PID_FILE: pidFile, GRANDCHILD_PID_FILE: grandchildFile },
          }),
        ],
        { logger: (event) => events.push(event) },
      );
      await manager.connectAll();
      await waitFor(
        () =>
          existsSync(grandchildFile) && readFileSync(grandchildFile, "utf8").trim() !== "",
        3_000,
      );

      const previousPath = process.env.PATH;
      const previousPathAlias = process.env.Path;
      try {
        process.env.PATH = "";
        process.env.Path = "";
        await manager.close();
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousPathAlias === undefined) delete process.env.Path;
        else process.env.Path = previousPathAlias;
      }

      const incomplete = events.filter((event) => event.kind === "dispose_incomplete");
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0]).toMatchObject({ server: "echo" });
      expect(incomplete[0]?.message).toContain("taskkill");
    },
    20_000,
  );

  /**
   * 成功关闭时**不**发 `dispose_incomplete`。
   *
   * 只有「失败要说」而没有「成功不说话」的反向断言，等于允许实现无条件报错——
   * 那样界面上每次关连接都会多一条 warn，用户很快学会忽略它，R3 的信号就废了。
   */
  it("正常关闭不产生 dispose_incomplete", async () => {
    const events: McpStatusEvent[] = [];
    const manager = new McpManager([config("echo")], {
      logger: (event) => events.push(event),
    });
    await manager.connectAll();

    await manager.close();

    expect(events.filter((event) => event.kind === "dispose_incomplete")).toHaveLength(0);
  }, 20_000);

  /**
   * `dispose_incomplete` 只在**终态关闭**时上报，重连路径不上报。
   *
   * `disposeClient` 同时服务 `close()` 与「重连前收旧的」（`connectServer`）两条
   * 路径。后者清完马上就建新连接，此时报「树没回收干净」既不影响语义，也会让
   * 每次断线重连都多一条 warn——读者很快学会忽略它，R3 的信号就废了。
   *
   * 为什么用静态断言而不是行为测试：断线重连那条路径上 `state.transport` 已被
   * `beginDispose` 清空，`pid` 恒为 `undefined`，`reapProcessTree` 直接返回成功，
   * 失败分支**走不到**。行为测试在那里恒绿，钉不住任何东西（实测：去掉守卫仍绿）。
   * 能钉住的只有调用点的参数，所以这里断言源码形态——与本仓库
   * `tests/desktop/composer-copy.test.js` 的做法一致。
   */
  it("只有终态 close 传 reportIncomplete，重连路径不传", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "..", "src", "mcp", "manager.ts"),
      "utf8",
    );
    // close() 里那处调用必须带第三参 true。
    expect(source).toMatch(/state\.closed = true;\s*\n\s*await this\.disposeClient\(state, true, true\);/);
    // 其余调用点不得带第三参（`connectServer` 里两处 + 重连前的状态收敛）。
    const calls = source.match(/this\.disposeClient\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const withReport = calls.filter((call) => call.includes(", true, true"));
    expect(withReport).toHaveLength(1);
  });

  /**
   * 关闭路径不能被 `taskkill` 的退出拖慢。
   *
   * 实测：`client.close()` 本身约 10–120 ms；`taskkill /T /F` 跑完要
   * 900–1300 ms。如果实现把它的 exit 等进来，这条会红得很明显。
   *
   * 阈值 500 ms 是一条上界，钉住「没有把 taskkill 的完整执行时间算进关闭」，
   * 同时给机器抖动留了足够余量（实测 close 稳定在 10–120 ms）。
   */
  it("close 不等待 taskkill 退出：额外开销远小于 taskkill 的执行时间", async () => {
    const manager = new McpManager([config("echo")]);
    await manager.connectAll();

    const started = Date.now();
    await manager.close();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(500);
  }, 20_000);

  /**
   * **已知边界，不是缺陷**：`detached` 的后代在 `close()` 之后仍会存活。
   *
   * 为什么收不了（本机实测，理由都写在 `reapProcessTree` 的方法注释里）：
   *  - `detached` 让后代脱离 libuv 的 kill-on-close Job Object，于是父死子不死；
   *  - `taskkill /T` 靠**活着的父进程**枚举子进程，而真实 MCP server 在 stdin
   *    EOF 后 0–109 ms 就退出，taskkill 要约 1 s 才开始枚举——竞速结构性必输；
   *  - 外部枚举（`tasklist /FI` 800–1225 ms、`Get-CimInstance` 1.7–3.6 s）都
   *    远超「关闭额外开销 ≤ 50 ms」的预算，所以「先快照后补刀」也不行。
   *
   * 这条断言的存在意义是**把边界写进可执行的规格**：哪天实现真的能收走
   * detached 后代（比如 SDK 允许传 spawn 选项），`toBe(true)` 会红，提醒改这条
   * 说明与 D-225 的复核注记，而不是让一条过时的「已知限制」悄悄一直绿着。
   */
  it.skipIf(process.platform !== "win32")(
    "已知边界：detached 后代在 close 之后仍存活",
    async () => {
      const root = tempRoot();
      const pidFile = path.join(root, "pid");
      const grandchildFile = path.join(root, "grandchild.pid");
      const manager = new McpManager([
        config("echo", {
          env: {
            PID_FILE: pidFile,
            GRANDCHILD_PID_FILE: grandchildFile,
            GRANDCHILD_DETACHED: "1",
          },
        }),
      ]);
      await manager.connectAll();
      await waitFor(
        () =>
          existsSync(grandchildFile) && readFileSync(grandchildFile, "utf8").trim() !== "",
        3_000,
      );
      const grandchildPid = Number(readFileSync(grandchildFile, "utf8"));
      expect(isAlive(grandchildPid)).toBe(true);

      await manager.close();
      // 给回收器足够的时间（本机实测 taskkill 约 1 s 走完）。
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      try {
        expect(isAlive(grandchildPid)).toBe(true);
      } finally {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {}
      }
    },
    20_000,
  );

  it("连接成功但 tools/list 挂起时按发现超时失败并回收子进程", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const connectedFile = path.join(root, "connected");
    const events: McpStatusEvent[] = [];
    const manager = track(
      new McpManager(
        [
          config("hang", {
            env: {
              TOOLS_HANG: "1",
              PID_FILE: pidFile,
              CONNECTED_FILE: connectedFile,
            },
          }),
        ],
        { connectTimeoutMs: 500, logger: (event) => events.push(event) },
      ),
    );

    await manager.connectAll();

    expect(existsSync(connectedFile)).toBe(true);
    expect(manager.tools()).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "connect_failed", server: "hang" }),
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    await waitFor(() => !isAlive(pid), 3_000);
  }, 5_000);

  it("超长文本输出按 1 MiB 截断并标记", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    const result = await manager.call("echo", "huge", {}, signal());

    expect(result).toMatchObject({ isError: false, code: "ok", detail: { truncated: true } });
    expect(result.text.endsWith("[MCP output truncated at 1 MiB]")).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(1024 * 1024 + 64);
  });

  it("超长 structuredContent 同样截断", async () => {
    const manager = track(new McpManager([config("echo")]));
    await manager.connectAll();

    const result = await manager.call("echo", "structured-huge", {}, signal());

    expect(result).toMatchObject({ isError: false, code: "ok", detail: { truncated: true } });
    expect(result.text.endsWith("[MCP output truncated at 1 MiB]")).toBe(true);
  });

  it("超大 inputSchema 被跳过，超长 description 被截断", async () => {
    const events: McpStatusEvent[] = [];
    const manager = track(
      new McpManager([config("echo", { env: { BIG_SCHEMA: "1" } })], {
        logger: (event) => events.push(event),
      }),
    );
    await manager.connectAll();

    expect(manager.tools().some((tool) => tool.tool === "huge-schema")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "tool_invalid_schema",
        server: "echo",
        tool: "huge-schema",
      }),
    );
    const description =
      manager.tools().find((tool) => tool.tool === "huge-description")?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(4096 + 20);
    expect(description.endsWith("[truncated]")).toBe(true);
  });

  it("refresh 在途时 close 不写回工具且不发 tools_refresh_failed", async () => {
    const events: McpStatusEvent[] = [];
    const manager = track(new McpManager([config("echo")], { logger: (event) => events.push(event) }));
    await manager.connectAll();

    await manager.call("echo", "grow-broken", { ms: 500 }, signal());
    await new Promise((resolve) => setTimeout(resolve, 150));
    await manager.close();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(events.some((event) => event.kind === "tools_refresh_failed")).toBe(false);
    expect(manager.tools()).toEqual([]);
  });
});
