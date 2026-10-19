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
  });

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

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(manager.tools()).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "connect_failed", server: "silent" }));
    await waitFor(() => !isAlive(pid), 3_000);
  });

  it("connectAll 并行连接多个 server", async () => {
    const connectedAt: number[] = [];
    const manager = track(
      new McpManager(
        [
          config("slow-a", { env: { START_DELAY_MS: "300" } }),
          config("slow-b", { env: { START_DELAY_MS: "300" } }),
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
    // 串行时两个 connected 至少相隔 START_DELAY_MS（300ms）；300ms 阈值保留区分度并降低 CI 抖动。
    expect(Math.abs(connectedAt[0] - connectedAt[1])).toBeLessThan(300);
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

  it("timeout 后关闭 server，后续调用重连且不残留旧进程", async () => {
    const root = tempRoot();
    const pidLog = path.join(root, "pid.log");
    const manager = track(
      new McpManager([config("echo", { timeoutMs: 100, env: { PID_LOG: pidLog } })]),
    );
    await manager.connectAll();
    const firstPid = Number(readFileSync(pidLog, "utf8").trim().split("\n")[0]);

    const timedOut = await manager.call("echo", "slow", { ms: 800, tag: "timeout" }, signal());
    expect(timedOut).toMatchObject({ isError: true, code: "mcp_timeout" });
    await waitFor(() => !isAlive(firstPid), 3_000);

    const after = await manager.call("echo", "echo", { text: "after-timeout" }, signal());
    expect(after).toMatchObject({ isError: false, code: "ok", text: "after-timeout" });
    const pids = readFileSync(pidLog, "utf8").trim().split("\n");
    expect(pids).toHaveLength(2);
  });

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
