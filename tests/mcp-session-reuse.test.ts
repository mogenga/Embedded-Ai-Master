import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSession } from "../src/index.js";
import type { LoopEvent } from "../src/loop/events.js";
import { createMcpRegistry } from "../src/mcp/registry.js";
import { readSessionFile } from "../src/session/session.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");

const PROVIDERS_TEXT = JSON.stringify({
  gw: {
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    models: { flash: { contextWindow: 8192, maxOutput: 512 } },
  },
});

const EMPTY_RESPONSE = {
  choices: [{ message: { content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 3 },
};

const tempDirs: string[] = [];

async function tempDir(prefix = "mcp-reuse-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function mockFetch(bodies: unknown[]): {
  impl: typeof fetch;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const payload = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

async function collect(generator: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

async function writeMcpConfig(dir: string, servers: Record<string, unknown>): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "mcp.json");
  await writeFile(file, JSON.stringify({ mcpServers: servers }), "utf8");
  return file;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

function mcpStatusKinds(sessionDir: string): string[] {
  return readSessionFile(path.join(sessionDir, "session.v1.jsonl"))
    .filter((event) => event.type === "mcp_status")
    .map((event) => String((event.payload as { kind?: unknown }).kind));
}

function toolCall(id: string, name: string, args: unknown): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function toolNames(body: Record<string, unknown> | undefined): string[] {
  const tools = body?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => String((tool as { function?: { name?: unknown } }).function?.name));
}

describe("runSession 会话级 MCP 复用", () => {
  it("同一 sessionDir + 同一 registry 的两条 run 只 spawn 一个子进程，且都拿到工具", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const pidLog = path.join(configDir, "pid.log");
    const userConfigPath = await writeMcpConfig(configDir, {
      echo: { command: process.execPath, args: [FIXTURE], env: { PID_LOG: pidLog } },
    });
    const sessionDir = path.join(home, "reuse-session");
    const registry = createMcpRegistry();
    const pids = async (): Promise<number[]> =>
      (await readFile(pidLog, "utf8")).trim().split("\n").map(Number);

    const first = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: PROVIDERS_TEXT,
        sessionDir,
        fetchImpl: first.impl,
        cwd: configDir,
        mcp: { userConfigPath },
        mcpRegistry: registry,
      }),
    );

    const second = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: PROVIDERS_TEXT,
        sessionDir,
        resume: true,
        fetchImpl: second.impl,
        cwd: configDir,
        mcp: { userConfigPath },
        mcpRegistry: registry,
      }),
    );

    // 一条连接，两轮共用：这正是「每条消息重新握手」被去掉的证据。
    expect(await pids()).toHaveLength(1);
    expect(registry.size()).toBe(1);

    // 两轮的工具表都得有 MCP 工具：本轮 registry 是新建的，复用的 manager
    // 只在 acquire 时连接过，所以每一轮都必须自己 rebuild 一次。
    expect(toolNames(first.calls[0])).toContain("mcp__echo__echo");
    expect(toolNames(second.calls[0])).toContain("mcp__echo__echo");

    // 第一轮的 connected 仍写进了日志；第二轮没有新连接，自然没有新
    // connected（复用的定义就是不再握手）。
    expect(mcpStatusKinds(sessionDir)).toContain("connected");

    await registry.releaseAll();
    expect(registry.size()).toBe(0);
  }, 30_000);

  it("第二条 run 重新订阅工具变更：list_changed 后的新工具进入本轮请求", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, {
      echo: { command: process.execPath, args: [FIXTURE] },
    });
    const sessionDir = path.join(home, "resubscribe-session");
    const registry = createMcpRegistry();

    const first = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: PROVIDERS_TEXT,
        sessionDir,
        fetchImpl: first.impl,
        cwd: configDir,
        mcp: { userConfigPath },
        mcpRegistry: registry,
      }),
    );

    // 第二条消息调用 grow：它注册一个新工具并发 list_changed。事件若没有
    // 重新订阅到本轮的 ToolRegistry，下一次请求就还是旧的工具表。
    //
    // 第二次请求前等 tools_changed 落盘：list_changed 的刷新是异步的，直接发
    // 下一次请求会跑在刷新前面，测到的是竞速而不是订阅。
    const second = mockFetch([
      toolCall("grow-call", "mcp__echo__grow", {}),
      EMPTY_RESPONSE,
    ]);
    let fetchCount = 0;
    const wrapped: typeof fetch = async (input, init) => {
      if (fetchCount === 1) {
        await waitFor(() => mcpStatusKinds(sessionDir).includes("tools_changed"), 5_000);
      }
      fetchCount += 1;
      return second.impl(input, init);
    };
    await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: PROVIDERS_TEXT,
        sessionDir,
        resume: true,
        fetchImpl: wrapped,
        cwd: configDir,
        mcp: { userConfigPath },
        // grow 是写类工具，默认 diagnose 预设会拒绝；这条测的是订阅，不是权限。
        permissions: { preset: "danger-full-access" },
        mcpRegistry: registry,
      }),
    );

    expect(toolNames(second.calls[0])).not.toContain("mcp__echo__grown-1");
    expect(toolNames(second.calls[1])).toContain("mcp__echo__grown-1");

    await registry.releaseAll();
  }, 30_000);

  it("每条 run 结束时退订自己的工具表监听，不跨 run 累积", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, {
      echo: { command: process.execPath, args: [FIXTURE] },
    });
    const sessionDir = path.join(home, "listener-session");
    const registry = createMcpRegistry();

    for (const input of ["hi", "again"]) {
      const { impl } = mockFetch([EMPTY_RESPONSE]);
      await collect(
        runSession({
          input,
          model: "gw/flash",
          providersText: PROVIDERS_TEXT,
          sessionDir,
          ...(input === "hi" ? {} : { resume: true }),
          fetchImpl: impl,
          cwd: configDir,
          mcp: { userConfigPath },
          mcpRegistry: registry,
        }),
      );
    }

    // 同一个 manager 被复用了两轮；没有退订的话这里会留下两条 listener，
    // 每条都指向前一轮已经没人读的 ToolRegistry。
    const manager = await registry.acquire(sessionDir, async () => {
      throw new Error("应当命中缓存，不应新建 manager");
    });
    const listeners = (manager as unknown as { listeners: Set<unknown> }).listeners;
    expect(listeners.size).toBe(0);

    await registry.releaseAll();
  }, 30_000);

  it("releaseAll 后复用的子进程退出", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const pidFile = path.join(configDir, "pid");
    const userConfigPath = await writeMcpConfig(configDir, {
      echo: { command: process.execPath, args: [FIXTURE], env: { PID_FILE: pidFile } },
    });
    const sessionDir = path.join(home, "release-session");
    const registry = createMcpRegistry();
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: PROVIDERS_TEXT,
        sessionDir,
        fetchImpl: impl,
        cwd: configDir,
        mcp: { userConfigPath },
        mcpRegistry: registry,
      }),
    );

    const pid = Number(await readFile(pidFile, "utf8"));
    const isAlive = (value: number): boolean => {
      try {
        process.kill(value, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(isAlive(pid)).toBe(true);

    await registry.releaseAll();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(isAlive(pid)).toBe(false);
  }, 30_000);

  it("不传 registry 时行为不变：一轮一个 manager，结束后关闭子进程", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const pidFile = path.join(configDir, "pid");
    const userConfigPath = await writeMcpConfig(configDir, {
      echo: { command: process.execPath, args: [FIXTURE], env: { PID_FILE: pidFile } },
    });
    const sessionDir = path.join(home, "default-session");
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: PROVIDERS_TEXT,
        sessionDir,
        fetchImpl: impl,
        cwd: configDir,
        mcp: { userConfigPath },
      }),
    );

    expect(toolNames(calls[0])).toContain("mcp__echo__echo");
    expect(mcpStatusKinds(sessionDir)).toContain("connected");
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(await readFile(pidFile, "utf8"));
    const isAlive = (value: number): boolean => {
      try {
        process.kill(value, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 默认路径仍然「本轮关闭」：runSession 结束后连接不遗留。
    expect(isAlive(pid)).toBe(false);
  }, 30_000);
});
