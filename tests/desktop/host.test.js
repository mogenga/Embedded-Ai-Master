import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("loadSession 容忍日志尾部的半行（崩溃留下的写断点）", async () => {
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
    const { appendFile, readFile, writeFile } = await import("node:fs/promises");
    // Reproduce a crash: the header is still `open` and the last line was cut
    // mid-write. A closed session with a partial line is real corruption and
    // must still be refused.
    const headerPath = path.join(home, "sessions", sessionId, "header.json");
    const header = JSON.parse(await readFile(headerPath, "utf8"));
    await writeFile(headerPath, JSON.stringify({ ...header, status: "open" }), "utf8");
    const log = path.join(home, "sessions", sessionId, "session.v1.jsonl");
    await appendFile(log, '{"seq":99,"ts":"t","type":"assistant","payl', "utf8");

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: sessionId },
      ],
      { until: (all) => all.some((event) => event.type === "session_loaded") },
    );
    const loaded = events.find((event) => event.type === "session_loaded");
    expect(loaded).toBeDefined();
    expect(loaded.messages[0]).toMatchObject({ role: "user", text: "症状" });
  }, HOST_TIMEOUT_MS);

  it("setModel 只接受 providers.json 里的引用", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setModel", model: "gw/nope" },
        { cmd: "setModel", model: "gw/flash" },
      ],
      {
        until: (all) =>
          all.some((event) => event.type === "notice" && event.text.includes("gw/nope"))
          && all.filter((event) => event.type === "state").length >= 2,
      },
    );
    const notices = events.filter((event) => event.type === "notice");
    expect(notices.map((notice) => notice.text)).toStrictEqual(["模型不在 providers.json 中：gw/nope"]);
    // 合法引用只更新 state，不重建出一个空列表。
    const states = events.filter((event) => event.type === "state");
    expect(states.at(-1).model).toBe("gw/flash");
    expect(states.at(-1).models).toHaveLength(1);
  }, HOST_TIMEOUT_MS);

  it("refreshModels 重读 providers.json 并广播 models", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "refreshModels" },
      ],
      { until: (all) => all.some((event) => event.type === "models") },
    );
    const models = events.find((event) => event.type === "models");
    expect(models.models.map((model) => model.id)).toStrictEqual(["gw/flash"]);
    expect(models.source).toBe("providers.json");
  }, HOST_TIMEOUT_MS);

  it("searchSessions 按标题命中，不只按 id", async () => {
    const home = await tempHome();
    const created = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "prompt", text: "串口没输出" },
      ],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    expect(created.some((event) => event.type === "run_end")).toBe(true);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "searchSessions", query: "串口" },
      ],
      { until: (all) => all.some((event) => event.type === "session_matches") },
    );
    const matches = events.find((event) => event.type === "session_matches");
    // Session ids are generated, so id-only matching made this useless.
    expect(matches.sessions).toHaveLength(1);
    expect(matches.sessions[0].title).toBe("串口没输出");
  }, HOST_TIMEOUT_MS);

  it("getSettings 带上 MCP/权限/运行上限，saveMcpServer 写盘后回新快照", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "getSettings" },
        {
          cmd: "saveMcpServer",
          server: { name: "probe", command: "node", args: "probe.js --stdio", timeoutMs: 5000 },
        },
      ],
      {
        until: (all) => {
          const settings = all.filter((event) => event.type === "settings");
          return settings.length >= 2 && settings.at(-1).settings.mcpServers?.length === 1;
        },
      },
    );
    const settings = events.filter((event) => event.type === "settings");
    // The first answer has no server yet and names the files it reads.
    expect(settings[0].settings.mcpServers).toStrictEqual([]);
    expect(settings[0].settings.configPaths.mcp).toContain("mcp.json");
    expect(settings[0].settings.permissions.preset).toBe("diagnose");
    expect(settings[0].settings.run.maxTurns).toBe(10);

    const written = settings.at(-1).settings.mcpServers;
    expect(written).toStrictEqual([
      { name: "probe", command: "node", args: ["probe.js", "--stdio"], timeoutMs: 5000, disabled: false },
    ]);
    // The file is the source of truth, not host memory: a fresh edit of
    // mcp.json reaches the next settings read.
    const onDisk = JSON.parse(await readFile(path.join(home, "mcp.json"), "utf8"));
    expect(onDisk.mcpServers.probe.command).toBe("node");
  }, HOST_TIMEOUT_MS);

  it("sessionFlags 写入标题，会话列表随之显示", async () => {
    const home = await tempHome();
    const created = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "prompt", text: "串口没输出" }],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    const sessionId = created.find((event) => event.type === "sessions" && event.sessions.length > 0)
      ?.sessions[0]?.id;
    expect(sessionId).toBeDefined();

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "sessionFlags", id: sessionId, title: "UART 无输出", pinned: true },
      ],
      {
        until: (all) =>
          all.some(
            (event) =>
              event.type === "sessions"
              && event.sessions.some((entry) => entry.title === "UART 无输出"),
          ),
      },
    );
    // The `init` handshake also sends a list, and it predates the rename; the
    // last row for the session is the one that carries the new title.
    const row = events
      .filter((event) => event.type === "sessions")
      .flatMap((event) => event.sessions)
      .filter((entry) => entry.id === sessionId)
      .at(-1);
    expect(row.title).toBe("UART 无输出");
    expect(row.pinned).toBe(true);

    const meta = JSON.parse(
      await readFile(path.join(home, "sessions", sessionId, "meta.json"), "utf8"),
    );
    // The kernel's header validator drops unknown fields, so the title has to
    // live beside the session rather than inside header.json.
    expect(meta.title).toBe("UART 无输出");
  }, HOST_TIMEOUT_MS);

  it("exportSession 从已打开的会话日志渲染 Markdown", async () => {
    const home = await tempHome();
    const created = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "prompt", text: "串口没输出" }],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    const sessionId = created
      .filter((event) => event.type === "sessions")
      .flatMap((event) => event.sessions)
      .at(-1)?.id;
    expect(sessionId).toBeDefined();

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: sessionId },
        { cmd: "exportSession" },
      ],
      { until: (all) => all.some((event) => event.type === "export_ready") },
    );
    const ready = events.find((event) => event.type === "export_ready");
    // The title is the first user message; the body comes from the log, not
    // from whatever the renderer happens to have drawn.
    expect(ready.markdown).toContain("# 串口没输出");
    expect(ready.markdown).toContain("## User");
    expect(ready.filename).toBe("串口没输出.md");
  }, HOST_TIMEOUT_MS);

  it("exportSession 在没有打开的会话时回 warn", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "exportSession" }],
      { until: (all) => all.some((event) => event.type === "notice") },
    );
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("没有可导出");
    expect(events.some((event) => event.type === "export_ready")).toBe(false);
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

  it("listSessions 的 includeArchived:false 过滤掉归档会话", async () => {
    const home = await tempHome();
    const created = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "prompt", text: "串口没输出" }],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    const sessionId = created
      .filter((event) => event.type === "sessions")
      .flatMap((event) => event.sessions)
      .at(-1)?.id;
    expect(sessionId).toBeDefined();

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "sessionFlags", id: sessionId, archived: true },
        { cmd: "listSessions", includeArchived: false },
        { cmd: "listSessions", includeArchived: true },
      ],
      {
        until: (all) =>
          all.filter((event) => event.type === "sessions").length >= 4
          && all.filter((event) => event.type === "sessions").at(-1).sessions.length === 1,
      },
    );
    const lists = events.filter((event) => event.type === "sessions");
    // The boot list predates the archive, so the row is still in it.
    expect(lists[0].sessions).toHaveLength(1);
    // The push after `sessionFlags` reuses the default filter, so the row it
    // just archived is gone: otherwise the archive button looks inert.
    expect(lists[1].sessions).toStrictEqual([]);
    expect(lists[1].total).toBe(0);
    expect(lists[2].sessions).toStrictEqual([]);
    // Asking for archived rows brings the session back.
    expect(lists.at(-1).sessions).toHaveLength(1);
    expect(lists.at(-1).sessions[0].archived).toBe(true);
    expect(lists.at(-1).total).toBe(1);
  }, HOST_TIMEOUT_MS);

  it("listSessions 的 limit 只返回一页，total 是过滤后的全量", async () => {
    const home = await tempHome();
    // Two sessions: each prompt that creates one writes another directory.
    const created = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "prompt", text: "第一" }],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    expect(created.some((event) => event.type === "run_end")).toBe(true);
    await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "newSession" }, { cmd: "prompt", text: "第二" }],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    const dirs = await readdir(path.join(home, "sessions"));
    expect(dirs).toHaveLength(2);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "listSessions", limit: 1 },
      ],
      {
        until: (all) =>
          all.some((event) => event.type === "sessions" && event.limit === 1 && event.total === 2),
      },
    );
    const page = events.find((event) => event.type === "sessions" && event.limit === 1);
    expect(page.sessions).toHaveLength(1);
    // total/all describe the filtered set, not the page: that is what the
    // sidebar's "load more" row counts down.
    expect(page.total).toBe(2);
    expect(page.all).toBe(2);
    // Paging is stable: the first page is the newest session.
    const ids = dirs.map((id) => path.join(home, "sessions", id));
    expect(ids).toContain(path.join(home, "sessions", page.sessions[0].id));
  }, HOST_TIMEOUT_MS);

  it("listSessions 的 cwd 过滤归一化大小写与分隔符", async () => {
    const home = await tempHome();
    const created = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "prompt", text: "症状" }],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    expect(created.some((event) => event.type === "run_end")).toBe(true);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        // A different folder matches nothing; the session's own workdir matches.
        { cmd: "listSessions", cwd: path.join(home, "nope") },
        { cmd: "listSessions", cwd: home.replace(/\\/g, "/").toUpperCase() },
      ],
      {
        until: (all) => all.filter((event) => event.type === "sessions").length >= 3,
      },
    );
    const lists = events.filter((event) => event.type === "sessions");
    // Boot list, then the empty one, then the match.
    expect(lists[1].sessions).toStrictEqual([]);
    expect(lists[1].total).toBe(0);
    expect(lists[2].sessions).toHaveLength(1);
    expect(lists[2].total).toBe(1);
  }, HOST_TIMEOUT_MS);

  it("getFile 读工作目录内的文本，越界与二进制分别被拒/标出", async () => {
    const home = await tempHome();
    const outside = await mkdtemp(path.join(tmpdir(), "eam-outside-"));
    tempDirs.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
    await writeFile(path.join(home, "note.txt"), "寄存器 0x10 = 0", "utf8");
    // A NUL byte in the first 8 KiB marks the file as binary.
    await writeFile(path.join(home, "firmware.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x00, 0x01]));

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "getFile", path: "note.txt" },
        { cmd: "getFile", path: path.join(outside, "secret.txt") },
        { cmd: "getFile", path: "firmware.bin" },
        { cmd: "getFile", path: "" },
      ],
      {
        until: (all) =>
          all.some((event) => event.type === "file" && event.file.path === "firmware.bin")
          && all.some((event) => event.type === "notice")
          && all.some((event) => event.type === "error"),
      },
    );
    const file = events.find((event) => event.type === "file");
    expect(file.file).toStrictEqual({
      path: "note.txt",
      content: "寄存器 0x10 = 0",
      truncated: false,
      binary: false,
    });

    const notices = events.filter((event) => event.type === "notice");
    const escape = notices.find((notice) => notice.text.includes("不在工作目录内"));
    expect(escape).toBeDefined();
    expect(escape.level).toBe("warn");
    // The escaped file is never read: no `file` event names it.
    const escaped = path.join(outside, "secret.txt");
    expect(events.filter((event) => event.type === "file" && event.file.path === escaped)).toHaveLength(0);
    expect(events.filter((event) => event.type === "file").map((event) => event.file.path)).toStrictEqual([
      "note.txt",
      "firmware.bin",
    ]);

    const binary = events.find(
      (event) => event.type === "file" && event.file.path === "firmware.bin",
    );
    expect(binary.file).toMatchObject({ content: "", binary: true });

    expect(events.find((event) => event.type === "error").message).toContain("文件路径");
  }, HOST_TIMEOUT_MS);

  it("getFile 对目录回 notice 而不是当作文件", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, "sessions"), { recursive: true });
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "getFile", path: "sessions" },
      ],
      { until: (all) => all.some((event) => event.type === "notice") },
    );
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("不是普通文件");
    expect(events.some((event) => event.type === "file")).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("getArtifacts 在没有打开的会话时回空数组", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "getArtifacts" },
      ],
      { until: (all) => all.some((event) => event.type === "artifacts") },
    );
    expect(events.find((event) => event.type === "artifacts")).toStrictEqual({
      type: "artifacts",
      artifacts: [],
    });
    // An empty sidebar is the expected state here, not an error.
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "notice")).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("getArtifacts/getArtifact 列出并读取当前会话的产物", async () => {
    const home = await tempHome();
    const created = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "prompt", text: "串口没输出" }],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    const sessionId = created
      .filter((event) => event.type === "sessions")
      .flatMap((event) => event.sessions)
      .at(-1)?.id;
    expect(sessionId).toBeDefined();
    const artifactDir = path.join(home, "sessions", sessionId, "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "call-1.txt"), "full output", "utf8");
    // A directory inside the artifact folder is not an artifact.
    await mkdir(path.join(artifactDir, "nested"), { recursive: true });

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: sessionId },
        { cmd: "getArtifacts" },
        { cmd: "getArtifact", path: path.join(artifactDir, "call-1.txt") },
        { cmd: "getArtifact", path: path.join(artifactDir, "..", "header.json") },
      ],
      {
        until: (all) =>
          all.some((event) => event.type === "artifact")
          && all.some((event) => event.type === "notice"),
      },
    );
    const list = events.find((event) => event.type === "artifacts");
    expect(list.artifacts).toHaveLength(1);
    expect(list.artifacts[0]).toMatchObject({ name: "call-1.txt", kind: "text", size: 11 });

    const artifact = events.find((event) => event.type === "artifact");
    expect(artifact.artifact).toStrictEqual({
      path: path.join(artifactDir, "call-1.txt"),
      kind: "text",
      content: "full output",
      truncated: false,
    });
    // `..` out of the artifact directory is refused, not read.
    const escape = events.filter((event) => event.type === "notice").at(-1);
    expect(escape.text).toContain("不在当前会话的 artifacts 目录内");
  }, HOST_TIMEOUT_MS);

  it("setEffort 回 warn notice 且不发 state", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setEffort", effort: "high" },
        // A later command marks the end of the queue: `state` would have been
        // sent before it if `setEffort` had claimed to apply.
        { cmd: "listSessions" },
      ],
      { until: (all) => all.some((event) => event.type === "sessions") },
    );
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice).toStrictEqual({
      type: "notice",
      level: "warn",
      text: "内核不支持调整推理强度",
    });
    // Only the boot `state`; claiming success would need a second one.
    expect(events.filter((event) => event.type === "state")).toHaveLength(1);
  }, HOST_TIMEOUT_MS);

  it("saveSettings 只接受 locale，其他字段回 warn", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "saveSettings", settings: { locale: "en" } },
        { cmd: "saveSettings", settings: { theme: "dark" } },
        { cmd: "listSessions" },
      ],
      { until: (all) => all.some((event) => event.type === "sessions") },
    );
    const locale = events.filter((event) => event.type === "locale").at(-1);
    expect(locale).toStrictEqual({ type: "locale", locale: "en" });
    // The language switch also refreshes state so the chrome follows it.
    expect(events.filter((event) => event.type === "state").at(-1).locale).toBe("en");

    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("该设置没有后端");
    expect(notice.text).toContain("theme");
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
