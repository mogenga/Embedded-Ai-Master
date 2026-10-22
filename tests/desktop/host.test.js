import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HOST = path.join(import.meta.dirname, "..", "..", "desktop", "host", "host.js");
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
/**
 * Whether the kernel's probe module has been compiled.
 *
 * The host treats `dist/model/probe.js` as optional so a `dist/` that predates
 * it degrades to a message instead of killing the process. Two test states
 * follow from that, and they are not the same:
 *
 * - `dist/` was never built (a fresh clone): the probe tests cannot run, so
 *   they say so as skipped rather than green.
 * - `dist/` exists but has no `probe.js` while `src/` does: a stale build. The
 *   host's test button would never work in the shipped app, so that fails
 *   loudly instead of skipping.
 */
const PROBE_SOURCE = path.join(REPO_ROOT, "src", "model", "probe.ts");
const DIST_BUILT = existsSync(path.join(REPO_ROOT, "dist", "model", "openai.js"));
const PROBE_BUILT = existsSync(path.join(REPO_ROOT, "dist", "model", "probe.js"));
const PROBE_DIST = path.join(REPO_ROOT, "dist", "model", "probe.js");
/** Same split for the knowledge-base locator that `getKb` imports lazily. */
const KB_MODULE_BUILT = existsSync(path.join(REPO_ROOT, "dist", "server", "kb-locate.js"));
/**
 * Whether the compiled probe already accepts a directly-typed `apiKey`.
 *
 * The host forwards `payload.apiKey` unconditionally — it is the caller side of
 * a contract whose kernel half (`ProviderProbeOptions.apiKey`) lands in
 * `src/model/probe.ts` separately. A `dist/` compiled before that lands drops
 * the option, the probe sends no Authorization header, and the `Bearer <key>`
 * assertion below would fail for a reason that is a pending build, not a
 * regression. Match `options.apiKey` as a property access — `options.apiKeyEnv`
 * contains the same substring and must not count.
 */
const PROBE_FORWARDS_API_KEY = PROBE_BUILT
  && /options\.apiKey(?!\w)/.test(readFileSync(PROBE_DIST, "utf8"));
const PROVIDERS_DIST = path.join(REPO_ROOT, "dist", "config", "providers.js");
/**
 * Whether the compiled providers schema already knows the `apiKey` field.
 *
 * `saveProviders` validates with that schema before writing, so a `dist/` from
 * before the field landed silently drops it — the round-trip test would then
 * wait forever for a `settings` event that can never carry the key. Same
 * pending-build window as `PROBE_FORWARDS_API_KEY`, different module.
 */
const CONFIG_ACCEPTS_API_KEY = DIST_BUILT
  && existsSync(PROVIDERS_DIST)
  && /apiKey:/.test(readFileSync(PROVIDERS_DIST, "utf8"));
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

/**
 * A local gateway that answers `/models` the way an OpenAI-compatible one does.
 *
 * `testProvider` probes this endpoint; the same server also accepts chat
 * completions so a probe that falls back to a completion still gets an answer.
 * Nothing leaves the machine.
 *
 * `requests` records what the gateway actually received (method, path,
 * headers and body): the Authorization header is the only place a key is
 * allowed to appear, so a test that wants to prove the key arrived — and that
 * nothing else did — has to see the wire, not the host's own event.
 */
async function healthyGateway() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    });
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "flash" }, { id: "pro" }] }));
      return;
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "completions not used by this test" } }));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

/**
 * An address nothing listens on.
 *
 * Port 1 on loopback is reserved and never bound; the connection is refused
 * immediately, so the failure path is exercised without a test timeout.
 */
function unreachableBaseUrl() {
  return "http://127.0.0.1:1/v1";
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

/**
 * Write a saved conversation by hand: one header plus one user event.
 *
 * Creating it through the host would tie its workdir to whichever folder that
 * host booted in. These cases need a session that *records* a different
 * project — which is exactly what a conversation opened from the sidebar is.
 */
async function writeSession(home, { id, workdir, text = "旧会话" }) {
  const dir = path.join(home, "sessions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "header.json"),
    JSON.stringify({
      id,
      createdAt: new Date().toISOString(),
      status: "closed",
      ...(workdir === undefined ? {} : { workdir }),
    }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "session.v1.jsonl"),
    `${JSON.stringify({
      seq: 0,
      ts: new Date().toISOString(),
      type: "user",
      payload: { content: text },
    })}\n`,
    "utf8",
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
      env: { ...process.env, ...(options.env ?? {}), HARNESS_HOME: home },
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

  it("providers 缺失时仍走完 init 并提示去设置页", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "eam-host-empty-"));
    tempDirs.push(home);
    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    // Regression: `loadProviders` throwing used to `fatal()` and `return`, so
    // no `state` and no `ready` were ever sent and the window stayed dead —
    // the settings page that would fix the file was unreachable.
    const types = events.map((event) => event.type);
    expect(types).toContain("state");
    expect(types).toContain("ready");
    expect(types).toContain("sessions");
    expect(types).toContain("commands");
    expect(types).toContain("setup_checklist");
    expect(types).toContain("locale");
    // A missing file is "not configured yet", not a corrupt one.
    expect(events.some((event) => event.type === "fatal")).toBe(false);

    const state = events.find((event) => event.type === "state");
    expect(state.model).toBe("");
    expect(state.models).toStrictEqual([]);
    const notice = events.find(
      (event) => event.type === "notice" && event.text.includes("设置"),
    );
    expect(notice).toStrictEqual({
      type: "notice",
      level: "dim",
      text: "尚未配置模型服务，请在设置 → 模型服务中填写",
    });
  }, HOST_TIMEOUT_MS);

  it("providers 文件损坏时发 fatal，但 init 仍然走完", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "eam-host-broken-"));
    tempDirs.push(home);
    await writeFile(path.join(home, "providers.json"), "{ not json", "utf8");
    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const fatal = events.find((event) => event.type === "fatal");
    expect(fatal).toBeDefined();
    expect(fatal.message).toContain("providers");
    // The fatal banner tells the user what is wrong; `ready` is what makes the
    // page that fixes it usable.
    expect(events.some((event) => event.type === "ready")).toBe(true);
    expect(events.some((event) => event.type === "state")).toBe(true);
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

  it("prompt 把工作区 cwd 写进会话 header", async () => {
    const home = await tempHome();
    const workspace = await mkdtemp(path.join(tmpdir(), "eam-cwd-"));
    tempDirs.push(workspace);
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setWorkspace", path: workspace },
        { cmd: "prompt", text: "看下这个工程" },
      ],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );
    expect(events.some((event) => event.type === "run_end")).toBe(true);

    const [sessionId] = await readdir(path.join(home, "sessions"));
    const header = JSON.parse(
      await readFile(path.join(home, "sessions", sessionId, "header.json"), "utf8"),
    );
    // The kernel records the run's cwd as the session's workdir; if the host
    // did not pass it, the run would have happened in the host's own folder
    // and the sidebar would group the session under the wrong project.
    expect(header.workdir).toBe(path.resolve(workspace));
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

  /**
   * True once a `session_loaded` has been followed by a `state`.
   *
   * The `state` that matters is the one `loadSession` emits *after* replaying
   * the transcript; the boot handshake already sent one for the host's own
   * workspace, so "a state exists" would not prove anything.
   */
  function loadedThenState(all) {
    const loadedAt = all.findIndex((event) => event.type === "session_loaded");
    return loadedAt >= 0 && all.slice(loadedAt).some((event) => event.type === "state");
  }

  it("loadSession 把会话记录的工作目录切换为当前工作目录", async () => {
    const home = await tempHome();
    const project = await mkdtemp(path.join(tmpdir(), "eam-open-project-"));
    tempDirs.push(project);
    await writeFile(path.join(project, "main.c"), "int main(void){}\n", "utf8");
    const workdir = path.resolve(project);
    const sessionId = "sess-opened-in-project";
    await writeSession(home, { id: sessionId, workdir, text: "上个项目的问题" });

    const events = await runHost(
      home,
      [
        // The window boots in `home`; the conversation was recorded in `project`.
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: sessionId },
        { cmd: "getTree", path: "." },
        { cmd: "getFile", path: "main.c" },
      ],
      // Queued commands still run before the shutdown line behind them, so the
      // tree/file replies are read below without waiting on them here.
      { until: loadedThenState },
    );

    const loaded = events.find((event) => event.type === "session_loaded");
    expect(loaded.cwd).toBe(workdir);
    // The `state` that follows the replay is what the renderer's topbar obeys.
    const afterLoad = events.slice(events.indexOf(loaded)).filter((event) => event.type === "state");
    expect(afterLoad.at(-1).cwd).toBe(workdir);
    // And it stays that way: no later state falls back to the boot folder.
    expect(events.filter((event) => event.type === "state").at(-1).cwd).toBe(workdir);

    // The connected symptoms: `.` and a relative file name resolve against the
    // conversation's own project, not the folder the window happened to open in.
    const tree = events.find((event) => event.type === "tree");
    expect(tree.nodes.map((node) => node.name)).toContain("main.c");
    const file = events.find((event) => event.type === "file");
    expect(file.file).toStrictEqual({
      path: "main.c",
      content: "int main(void){}\n",
      truncated: false,
      binary: false,
    });
  }, HOST_TIMEOUT_MS);

  it("会话记录的工作目录已不存在时，保留原 cwd 并显式 warn", async () => {
    const home = await tempHome();
    const gone = path.join(home, "deleted-project");
    const sessionId = "sess-workdir-gone";
    await writeSession(home, { id: sessionId, workdir: gone, text: "项目已被删除" });

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: sessionId },
      ],
      { until: loadedThenState },
    );

    // R3: the mismatch is said out loud, with the path that no longer exists.
    const warning = events.find(
      (event) => event.type === "notice" && event.level === "warn" && event.text.includes(gone),
    );
    expect(warning).toBeDefined();
    // The transcript still opens; the record is honest about its own workdir.
    const loaded = events.find((event) => event.type === "session_loaded");
    expect(loaded).toBeDefined();
    expect(loaded.cwd).toBe(gone);
    // But the host does not point itself at a directory that is not there.
    expect(events.filter((event) => event.type === "state").at(-1).cwd).toBe(path.resolve(home));
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

  it("saveProviders 写盘后可读回，并回带 providerConfig 的 settings", async () => {
    const home = await tempHome();
    const baseUrl = await failingGateway();
    const providers = {
      gw: {
        protocol: "openai-chat-completions",
        baseUrl,
        models: { flash: { contextWindow: 8192, maxOutput: 512 } },
      },
    };
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        {
          cmd: "saveProviders",
          providers: {
            gw: providers.gw,
            backup: {
              protocol: "openai-chat-completions",
              baseUrl,
              models: { slow: { contextWindow: 4096, maxOutput: 256 } },
            },
          },
        },
      ],
      {
        until: (all) =>
          all.some(
            (event) =>
              event.type === "settings"
              && Object.keys(event.settings.providerConfig ?? {}).length === 2,
          ),
      },
    );

    // The file is the contract: a save that only updated memory would be lost
    // on the next boot.
    const onDisk = JSON.parse(await readFile(path.join(home, "providers.json"), "utf8"));
    expect(Object.keys(onDisk)).toStrictEqual(["gw", "backup"]);
    expect(onDisk.backup.models.slow.contextWindow).toBe(4096);

    const settings = events
      .filter((event) => event.type === "settings")
      .find((event) => Object.keys(event.settings.providerConfig ?? {}).length === 2);
    expect(settings.settings.providerConfig).toStrictEqual(onDisk);
    // `providers` stays the picker's flat list: `providerConfig` is the raw
    // object and the two must not collide.
    expect(settings.settings.providers.map((entry) => entry.id)).toStrictEqual(["gw", "backup"]);
    expect(settings.settings.configPaths.providers).toContain("providers.json");

    // The new model reaches the picker without a separate refreshModels.
    const models = events.filter((event) => event.type === "models").at(-1);
    expect(models.models.map((model) => model.id)).toContain("backup/slow");
  }, HOST_TIMEOUT_MS);

  it("saveProviders 收到非法对象时回 warn，磁盘原文件不变", async () => {
    const home = await tempHome();
    const before = await readFile(path.join(home, "providers.json"), "utf8");
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        // `protocol` is required and must be the one the adapter speaks.
        {
          cmd: "saveProviders",
          providers: { gw: { baseUrl: "not-a-url", models: {} } },
        },
        { cmd: "listSessions" },
      ],
      { until: (all) => all.some((event) => event.type === "sessions") },
    );
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("模型配置未保存");
    // Writing an invalid object over a working file would leave the user with
    // no model at all and no way back through the UI.
    expect(await readFile(path.join(home, "providers.json"), "utf8")).toBe(before);
    // A failed save does not claim success with a fresh settings snapshot.
    expect(
      events.filter((event) => event.type === "settings").length,
    ).toBe(0);
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

  it("getTree 在临时目录上返回真实子项，目录在前", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, "sessions"), { recursive: true });
    await mkdir(path.join(home, "src"), { recursive: true });
    await writeFile(path.join(home, "readme.md"), "# hi\n", "utf8");

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        // `.` means "the workspace", which is what the renderer sends on boot
        // and when the files pane opens.
        { cmd: "getTree", path: "." },
      ],
      { until: (all) => all.some((event) => event.type === "tree") },
    );
    const tree = events.find((event) => event.type === "tree");
    expect(tree.truncated).toBe(false);
    const names = tree.nodes.map((node) => node.name);
    expect(names).toContain("src");
    expect(names).toContain("readme.md");
    // Directories first: a flat list buried the folders the operator was
    // drilling into below every file in the folder.
    const types = tree.nodes.map((node) => node.type);
    expect(types.indexOf("file")).toBeGreaterThan(types.lastIndexOf("dir"));
    expect(tree.nodes.find((node) => node.name === "src")).toStrictEqual({
      name: "src",
      path: path.join(home, "src"),
      type: "dir",
    });
  }, HOST_TIMEOUT_MS);

  it("getTree 越界时既发 warn 又发 tree 事件（不假装空目录）", async () => {
    const home = await tempHome();
    const outside = await mkdtemp(path.join(tmpdir(), "eam-tree-outside-"));
    tempDirs.push(outside);
    await mkdir(path.join(outside, "secret"), { recursive: true });

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "getTree", path: outside },
      ],
      {
        until: (all) =>
          all.some((event) => event.type === "notice" && event.text.includes("目录读取失败"))
          && all.some((event) => event.type === "tree"),
      },
    );
    // R3: the notice carries the reason. The empty tree alone would read as
    // "this folder is empty" rather than "this folder was refused".
    const notice = events.find((event) => event.type === "notice");
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("目录读取失败");
    const tree = events.find((event) => event.type === "tree");
    // The empty tree is still required: the renderer parks `pendingTreeTarget`
    // until one arrives, so the expanded node would spin forever without it.
    expect(tree.nodes).toStrictEqual([]);
    expect(
      events.some((event) => event.type === "tree" && event.nodes.length > 0),
    ).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("setWorkspace 登记目录后 getTree 能列出它", async () => {
    const home = await tempHome();
    const workspace = await mkdtemp(path.join(tmpdir(), "eam-workspace-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "drivers"), { recursive: true });
    await writeFile(path.join(workspace, "main.c"), "int main(void){}\n", "utf8");

    // Before registration the folder is not browsable.
    const before = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "getTree", path: workspace },
      ],
      {
        until: (all) =>
          all.some((event) => event.type === "notice" && event.text.includes("目录读取失败")),
      },
    );
    expect(before.find((event) => event.type === "tree").nodes).toStrictEqual([]);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setWorkspace", path: workspace },
        { cmd: "getTree", path: workspace },
      ],
      {
        until: (all) => all.some((event) => event.type === "tree" && event.nodes.length > 0),
      },
    );
    const state = events.filter((event) => event.type === "state").at(-1);
    // The registered folder is also where the next session runs: the workspace
    // and the cwd must not be two different places.
    expect(state.cwd).toBe(path.resolve(workspace));

    const tree = events.filter((event) => event.type === "tree").at(-1);
    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "drivers", type: "dir" }),
        expect.objectContaining({ name: "main.c", type: "file" }),
      ]),
    );
  }, HOST_TIMEOUT_MS);

  it("setWorkspace 对不存在的目录回 warn 且不改 cwd", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setWorkspace", path: path.join(home, "no-such-folder") },
        { cmd: "listSessions" },
      ],
      { until: (all) => all.some((event) => event.type === "sessions") },
    );
    const notice = events.filter((event) => event.type === "notice").at(-1);
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("工作区切换失败");
    // Only the boot state: a refused switch must not move the topbar.
    const states = events.filter((event) => event.type === "state");
    expect(states).toHaveLength(1);
    expect(states[0].cwd).toBe(path.resolve(home));
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

  it("已构建过的 dist 里不能缺少 probe.js（陈旧构建）", () => {
    // A `dist/` that predates `src/model/probe.ts` answers every probe with
    // "not compiled" while the source says otherwise. A fresh clone has no
    // `dist/` at all and is not this case; this one is a build that must be
    // re-run, so it fails loudly instead of quietly skipping.
    const stale = DIST_BUILT && existsSync(PROBE_SOURCE) && !PROBE_BUILT;
    expect(stale).toBe(false);
  }, HOST_TIMEOUT_MS);

  it.skipIf(!PROBE_BUILT)("testProvider 打到本地假网关，回 provider_test 且带模型列表", async () => {
    const home = await tempHome();
    const { baseUrl } = await healthyGateway();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "testProvider", baseUrl, model: "flash" },
      ],
      {
        until: (all) => all.some((event) => event.type === "provider_test"),
        timeoutMs: 30_000,
      },
    );
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event).toBeDefined();
    expect(event.ok).toBe(true);
    // The address the operator typed is what the settings page matches on.
    expect(event.baseUrl).toBe(baseUrl);
    expect(event.models).toContain("flash");
    expect(event.models).toContain("pro");
    expect(typeof event.latencyMs).toBe("number");
  }, HOST_TIMEOUT_MS);

  it.skipIf(!PROBE_FORWARDS_API_KEY)("testProvider 把 apiKey 送进 Authorization 头，事件里不回显", async () => {
    const key = "sk-host-probe-0123456789abcdef";
    const home = await tempHome();
    const { baseUrl, requests } = await healthyGateway();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "testProvider", baseUrl, apiKey: key },
      ],
      {
        until: (all) => all.some((event) => event.type === "provider_test"),
        timeoutMs: 30_000,
      },
    );

    // The wire is the evidence: the fake gateway has to have received exactly
    // this header, or the key never left the host.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].headers.authorization).toBe(`Bearer ${key}`);

    const event = events.find((entry) => entry.type === "provider_test");
    expect(event.ok).toBe(true);
    expect(event.baseUrl).toBe(baseUrl);
    // Write-only: no event, on any path, carries the key back.
    expect(JSON.stringify(events)).not.toContain(key);
  }, HOST_TIMEOUT_MS);

  it.skipIf(!PROBE_FORWARDS_API_KEY)("apiKey 被网关拒绝时，失败原因里没有密钥原文", async () => {
    // A 401 on a directly-typed key is the case where a careless error path
    // would echo the credential into the event stream; the host must report
    // the reason without it.
    const key = "sk-rejected-0123456789abcdef";
    const rejected = createServer((req, res) => {
      req.resume();
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });
    servers.push(rejected);
    await new Promise((resolve) => rejected.listen(0, "127.0.0.1", resolve));
    const { port } = rejected.address();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "testProvider", baseUrl, apiKey: key },
      ],
      {
        until: (all) => all.some((event) => event.type === "provider_test"),
        timeoutMs: 30_000,
      },
    );

    const event = events.find((entry) => entry.type === "provider_test");
    expect(event.ok).toBe(false);
    expect(event.code).toBe("unauthorized");
    expect(typeof event.error).toBe("string");
    expect(event.error).toContain("401");
    expect(JSON.stringify(events)).not.toContain(key);
  }, HOST_TIMEOUT_MS);

  it.skipIf(!CONFIG_ACCEPTS_API_KEY)("apiKey 保存在 providers.json 时，saveProviders 读回与 settings 都原样带上", async () => {
    // The key is part of the file, not a side channel: the settings page saves
    // it with `saveProviders` and must read it back from `providerConfig`, or
    // the operator retypes a key the app already has. This does not probe.
    const key = "sk-file-backed-0123456789";
    const home = await tempHome();
    const baseUrl = await failingGateway();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        {
          cmd: "saveProviders",
          providers: {
            gw: {
              protocol: "openai-chat-completions",
              baseUrl,
              apiKey: key,
              models: { flash: { contextWindow: 8192, maxOutput: 512 } },
            },
          },
        },
      ],
      {
        until: (all) =>
          all.some(
            (event) =>
              event.type === "settings"
              && event.settings?.providerConfig?.gw?.apiKey === key,
          ),
      },
    );

    const onDisk = JSON.parse(await readFile(path.join(home, "providers.json"), "utf8"));
    expect(onDisk.gw.apiKey).toBe(key);
    const settings = events.find(
      (event) => event.type === "settings" && event.settings?.providerConfig?.gw?.apiKey === key,
    );
    expect(settings).toBeDefined();
    // The picker's flat list stays flat: it carries the address, not the key.
    expect(settings.settings.providers).toStrictEqual([{ id: "gw", baseUrl }]);
  }, HOST_TIMEOUT_MS);

  it.skipIf(!PROBE_BUILT)("testProvider 指向不可达地址时回 ok:false 且 error 非空", async () => {
    const home = await tempHome();
    const baseUrl = unreachableBaseUrl();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "testProvider", baseUrl },
      ],
      {
        until: (all) => all.some((event) => event.type === "provider_test"),
        timeoutMs: 30_000,
      },
    );
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event).toBeDefined();
    // A refused connection is not a working gateway; claiming `ok` without a
    // probe would put a green card on a dead address (R3).
    expect(event.ok).toBe(false);
    expect(event.baseUrl).toBe(baseUrl);
    expect(typeof event.error).toBe("string");
    expect(event.error.trim()).not.toBe("");
    // And the failure has to be the gateway's, not "the probe was never
    // compiled": the degraded answer is a different fact, and letting it stand
    // in here would leave this test green with no probe implemented at all.
    expect(event.error).not.toContain("未编译");
    expect(event.models).toBeUndefined();
  }, HOST_TIMEOUT_MS);

  it.runIf(!PROBE_BUILT)("probe 未编译时回 ok:false 并说明先 npm run build", async () => {
    // The degraded path is a supported state during the window where the host
    // ships ahead of the kernel: the rest of the host keeps working and the
    // one command that cannot run says why, instead of killing the process at
    // import time.
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "testProvider", baseUrl: "http://127.0.0.1:1/v1" },
      ],
      {
        until: (all) => all.some((event) => event.type === "provider_test"),
        timeoutMs: 30_000,
      },
    );
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event).toMatchObject({
      type: "provider_test",
      ok: false,
      baseUrl: "http://127.0.0.1:1/v1",
    });
    expect(event.error).toContain("npm run build");
    // The handshake still completed: a missing optional module is not fatal.
    expect(events.some((entry) => entry.type === "ready")).toBe(true);
  }, HOST_TIMEOUT_MS);

  it("testProvider 缺少 baseUrl 时回 ok:false，不去探测", async () => {
    const home = await tempHome();
    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "testProvider", baseUrl: "" },
      ],
      {
        until: (all) => all.some((event) => event.type === "provider_test"),
        timeoutMs: 30_000,
      },
    );
    const event = events.find((entry) => entry.type === "provider_test");
    expect(event.ok).toBe(false);
    expect(event.baseUrl).toBe("");
    expect(event.error).toContain("baseUrl");
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

  /**
   * Whether the locator this test is about has been compiled.
   *
   * `getKb` imports `dist/server/kb-locate.js` lazily for exactly this reason:
   * a `dist/` from before the locator landed still boots, and the command says
   * "not built" instead. Both states are asserted, so neither can pass as the
   * other — same split as the probe tests above.
   */
  it.runIf(KB_MODULE_BUILT)("getKb 按 KB_ROOT 报告根与树，失败不崩宿主", async () => {
    const home = await tempHome();
    const kbRoot = await mkdtemp(path.join(tmpdir(), "eam-host-kb-"));
    tempDirs.push(kbRoot);
    await mkdir(path.join(kbRoot, "protocols"), { recursive: true });
    await writeFile(path.join(kbRoot, "protocols", "uart.md"), "# uart\n");
    await writeFile(path.join(kbRoot, "top.md"), "# top\n");
    await writeFile(path.join(kbRoot, "index.yaml"), "entries: []\n");

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getKb" }], {
      env: { KB_ROOT: kbRoot },
      until: (all) => all.some((event) => event.type === "kb"),
    });
    const event = events.find((entry) => entry.type === "kb");
    expect(event.kb).toMatchObject({
      root: path.resolve(kbRoot),
      source: "env",
      fileCount: 2,
      indexPresent: true,
      truncated: false,
    });
    expect(event.kb.error).toBeUndefined();
    expect(event.kb.tree.map((node) => [node.name, node.kind])).toStrictEqual([
      ["protocols", "dir"],
      ["index.yaml", "file"],
      ["top.md", "file"],
    ]);
  }, HOST_TIMEOUT_MS);

  it.runIf(KB_MODULE_BUILT)("getKb 的根不存在时保留候选并说明，而不是回空知识库", async () => {
    const home = await tempHome();
    const missing = path.join(tmpdir(), `eam-host-kb-missing-${Date.now()}`);
    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getKb" }], {
      env: { KB_ROOT: missing },
      until: (all) => all.some((event) => event.type === "kb"),
    });
    const event = events.find((entry) => entry.type === "kb");
    expect(event.kb.root).toBe(path.resolve(missing));
    expect(event.kb.source).toBe("env");
    expect(event.kb.note).toContain("目录不存在");
    expect(event.kb.tree).toStrictEqual([]);
    expect(events.some((entry) => entry.type === "ready")).toBe(true);
  }, HOST_TIMEOUT_MS);

  it.runIf(!KB_MODULE_BUILT)("kb 未编译时 getKb 说明先 build，宿主照常握手", async () => {
    const home = await tempHome();
    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getKb" }], {
      until: (all) => all.some((event) => event.type === "kb"),
    });
    const notice = events.find(
      (entry) => entry.type === "notice" && entry.text.includes("知识库不可用"),
    );
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("npm run build");
    const event = events.find((entry) => entry.type === "kb");
    expect(event.kb).toMatchObject({ root: "", source: "none", tree: [] });
    expect(events.some((entry) => entry.type === "ready")).toBe(true);
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
