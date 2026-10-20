import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HOST = path.join(import.meta.dirname, "..", "..", "desktop", "host", "host.js");
// 每个用例都要起一个 Node 宿主进程；满负载下会超过 vitest 的 5s 默认超时。
const HOST_TIMEOUT_MS = 30_000;
const tempDirs = [];
const servers = [];

/**
 * A local gateway that answers every completion with 400.
 *
 * A refused connection would be retried with exponential backoff for ~30 s;
 * an HTTP 400 is not retryable, so the run fails immediately. The session log
 * is still written before the model call, which is what the cursor test needs.
 */
async function failingGateway() {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad request (test)" } }));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}/v1`;
}

async function tempHome() {
  const dir = await mkdtemp(path.join(tmpdir(), "eam-host-"));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, "providers.json"),
    JSON.stringify({
      gw: {
        protocol: "openai-chat-completions",
        baseUrl: await failingGateway(),
        models: { flash: { contextWindow: 8192, maxOutput: 512 } },
      },
    }),
  );
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve)).catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Run the host as a child process and feed it NDJSON.
 *
 * The host owns stdin and a session runner, so this is the same surface the
 * Electron main process drives — not a re-implementation in the test.
 */
function runHost(home, commands, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: options.cwd ?? path.dirname(HOST),
      env: { ...process.env, HARNESS_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`host timed out; events: ${events.map((event) => event.type).join(",")}`));
    }, options.timeoutMs ?? 20_000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          events.push({ type: "unparsed", line });
        }
      }
      if (options.until !== undefined && options.until(events)) {
        child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      }
    });
    child.stderr.on("data", (chunk) => {
      events.push({ type: "stderr", text: chunk.toString("utf8") });
    });
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(events);
    });

    for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`);
  });
}

describe("desktop host", () => {
  it("握手：hello → state → ready → sessions → commands", async () => {
    const home = await tempHome();
    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("hello");
    expect(types).toContain("ready");
    expect(types.indexOf("state")).toBeLessThan(types.indexOf("ready"));
    const state = events.find((event) => event.type === "state");
    expect(state.model).toBe("gw/flash");
    expect(state.models).toHaveLength(1);
    expect(state.mode).toBe("diagnose");
    // 没有会话目录时列表为空，而不是报错。
    const sessions = events.find((event) => event.type === "sessions");
    expect(sessions.sessions).toStrictEqual([]);
    expect(events.find((event) => event.type === "commands")).toStrictEqual({
      type: "commands",
      commands: [],
    });
  }, HOST_TIMEOUT_MS);

  it("providers 缺失时发 fatal 而不是崩溃", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "eam-host-empty-"));
    tempDirs.push(home);
    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "fatal"),
    });
    const fatal = events.find((event) => event.type === "fatal");
    expect(fatal).toBeDefined();
    expect(fatal.message).toContain("providers");
    // fatal 之后进程仍在：renderer 要能显示设置入口。
    expect(events.some((event) => event.type === "ready")).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("不支持的命令显式 warn（R3，不静默）", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "gitCommit", message: "x" },
        { cmd: "terminalRun", command: "ls" },
      ],
      { until: (all) => all.filter((event) => event.type === "notice").length >= 2 },
    );
    const notices = events.filter((event) => event.type === "notice");
    expect(notices.map((notice) => notice.text)).toStrictEqual([
      "桌面宿主暂不支持该命令：gitCommit",
      "桌面宿主暂不支持该命令：terminalRun",
    ]);
    expect(notices.every((notice) => notice.level === "warn")).toBe(true);
  }, HOST_TIMEOUT_MS);

  it("setMode 在空闲时重建 runner 并更新 state", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setMode", mode: "read-only" },
      ],
      {
        until: (all) =>
          all.filter((event) => event.type === "state").some((event) => event.mode === "read-only"),
      },
    );
    const modes = events.filter((event) => event.type === "state").map((event) => event.mode);
    expect(modes).toContain("diagnose");
    expect(modes).toContain("read-only");
  }, HOST_TIMEOUT_MS);

  it("setMode 收到内核以外的预设时忽略", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setMode", mode: "bypassPermissions" },
        { cmd: "listSessions" },
      ],
      { until: (all) => all.some((event) => event.type === "sessions") },
    );
    expect(events.filter((event) => event.type === "state")).toHaveLength(1);
  }, HOST_TIMEOUT_MS);

  it("prompt 创建会话、回放事件并以 run_end 收尾（模型不可达）", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "prompt", text: "串口没输出" },
      ],
      {
        until: (all) => all.some((event) => event.type === "run_end"),
        timeoutMs: 30_000,
      },
    );
    const types = events.map((event) => event.type);
    expect(types).toContain("run_start");
    // 提交时 renderer 已经画过用户消息：本轮不再用 session_loaded 重建转录。
    expect(types).not.toContain("session_loaded");
    // 用户事件不单独回显。
    expect(types).not.toContain("assistant_delta");
    // 模型不可达时本轮以 interrupted 事件收尾，并且必须给出 run_end。
    expect(types).toContain("notice");
    expect(types.filter((type) => type === "run_end")).toHaveLength(1);
    expect(events.find((event) => event.type === "state").sessionId).toBe("");

    const sessionsDir = path.join(home, "sessions");
    const dirs = await readdir(sessionsDir);
    expect(dirs).toHaveLength(1);
  }, HOST_TIMEOUT_MS);

  it("loadSession 回放历史消息并设置游标", async () => {
    const home = await tempHome();
    const created = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "prompt", text: "症状" },
      ],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    expect(created.some((event) => event.type === "run_end")).toBe(true);
    const [sessionId] = await readdir(path.join(home, "sessions"));

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: sessionId },
      ],
      { until: (all) => all.some((event) => event.type === "session_loaded") },
    );
    const loaded = events.find((event) => event.type === "session_loaded");
    expect(loaded.messages[0]).toMatchObject({ role: "user", text: "症状" });
    expect(loaded.mode).toBe("diagnose");
  }, HOST_TIMEOUT_MS);

  it("loadSession 拒绝非法 id", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: "../escape" },
      ],
      { until: (all) => all.some((event) => event.type === "error") },
    );
    const error = events.find((event) => event.type === "error");
    expect(error.message).toContain("非法的会话 id");
  }, HOST_TIMEOUT_MS);

  it("getUsage 汇总当前会话的 usage 事件", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "getUsage" },
      ],
      { until: (all) => all.some((event) => event.type === "usage_summary") },
    );
    expect(events.find((event) => event.type === "usage_summary")).toStrictEqual({
      type: "usage_summary",
      days: 0,
      summary: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    });
  }, HOST_TIMEOUT_MS);

  it("getSetupChecklist 如实报告 providers 状态", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "getSetupChecklist" },
      ],
      { until: (all) => all.some((event) => event.type === "setup_checklist") },
    );
    const checklist = events.find((event) => event.type === "setup_checklist");
    expect(checklist.checks.every((check) => check.ok)).toBe(true);
  }, HOST_TIMEOUT_MS);

  it("getTree 返回空树而不是挂起", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, "sessions"), { recursive: true });
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "getTree", path: "." },
      ],
      { until: (all) => all.some((event) => event.type === "tree") },
    );
    expect(events.find((event) => event.type === "tree")).toStrictEqual({
      type: "tree",
      nodes: [],
    });
  }, HOST_TIMEOUT_MS);

  it("无法解析的指令被拒绝而不是让宿主崩溃", async () => {
    const home = await tempHome();
    const child = spawn(process.execPath, [HOST], {
      cwd: path.dirname(HOST),
      env: { ...process.env, HARNESS_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") events.push(JSON.parse(line));
      }
      if (events.some((event) => event.type === "notice" && event.text.includes("无法解析"))) {
        child.stdin.end();
      }
    });
    child.stdin.write("not json\n");
    child.stdin.write('{"cmd":"init","cwd":"."}\n');
    await new Promise((resolve) => child.on("exit", resolve));
    expect(events[0].type).toBe("hello");
    expect(events.some((event) => event.type === "notice" && event.text.includes("无法解析"))).toBe(true);
    expect(events.some((event) => event.type === "ready")).toBe(true);
  }, HOST_TIMEOUT_MS);
});
