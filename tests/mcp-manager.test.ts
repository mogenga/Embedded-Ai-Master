import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("连接超时可注入并记录 connect_failed", async () => {
    const events: McpStatusEvent[] = [];
    const manager = track(
      new McpManager([config("silent", { env: { SILENT: "1" } })], {
        connectTimeoutMs: 300,
        logger: (event) => events.push(event),
      }),
    );

    const started = Date.now();
    await manager.connectAll();

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(manager.tools()).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "connect_failed", server: "silent" }));
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
  it("断线后 call 自动重连一次", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const manager = track(new McpManager([config("echo", { env: { PID_FILE: pidFile } })]));
    await manager.connectAll();
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(pid)).toBe(true);

    await manager.call("echo", "crash", {}, signal()).catch(() => undefined);
    await waitFor(() => !isAlive(pid), 3_000);

    const result = await manager.call("echo", "echo", { text: "after-crash" }, signal());
    expect(result).toMatchObject({ isError: false, code: "ok", text: "after-crash" });

    const newPid = Number(readFileSync(pidFile, "utf8"));
    expect(newPid).not.toBe(pid);
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

  it("重连仍失败时返回 mcp_unavailable", async () => {
    const root = tempRoot();
    const pidFile = path.join(root, "pid");
    const serverConfig = config("echo", { env: { PID_FILE: pidFile } });
    const manager = track(new McpManager([serverConfig]));
    await manager.connectAll();
    const pid = Number(readFileSync(pidFile, "utf8"));

    await manager.call("echo", "crash", {}, signal()).catch(() => undefined);
    await waitFor(() => !isAlive(pid), 3_000);
    serverConfig.command = "definitely-not-a-real-command-embedded-ai";

    const result = await manager.call("echo", "echo", { text: "nope" }, signal());
    expect(result).toMatchObject({ isError: true, code: "mcp_unavailable" });
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
});