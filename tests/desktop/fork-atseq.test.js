import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * BACKLOG 5.6 / OPT-37: `forkSession` must forward `atSeq`.
 *
 * The kernel already supports it — `createSessionAdmin.fork(id, atSeq)` slices
 * the log at the given position and validates it against the last seq — but
 * the host called `admin.fork(id)` and dropped the field, so every fork was
 * "at the end" even when the caller asked for an earlier turn. The commands
 * are driven through a real host process: the handler is not importable, and
 * the fixture (a hand-written log) is what makes the two event counts differ.
 */
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const HOST = path.join(REPO_ROOT, "desktop", "host", "host.js");
const DIST_BUILT = existsSync(path.join(REPO_ROOT, "dist", "index.js"));
const HOST_TIMEOUT_MS = 30_000;
const tempDirs = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempHome() {
  const dir = await mkdtemp(path.join(tmpdir(), "eam-fork-"));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, "providers.json"),
    JSON.stringify({
      gw: {
        protocol: "openai-chat-completions",
        // Never contacted: fork and load are filesystem operations.
        baseUrl: "http://127.0.0.1:1/v1",
        models: { flash: { contextWindow: 8192, maxOutput: 512 } },
      },
    }),
    "utf8",
  );
  return dir;
}

/**
 * A closed session with four events: user, assistant, user, assistant.
 *
 * Every prefix is projectable (`buildMessages` accepts user and assistant
 * alone), so seq 1 is a legal fork position. `atSeq: 1` therefore yields a
 * two-event log while an absent `atSeq` copies all four — the counts cannot be
 * confused with each other.
 */
async function writeSourceSession(home, id = "src-session") {
  const dir = path.join(home, "sessions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "header.json"),
    JSON.stringify({ id, createdAt: new Date().toISOString(), status: "closed" }),
    "utf8",
  );
  const events = [
    { type: "user", payload: { content: "第一问" } },
    { type: "assistant", payload: { content: "第一答", toolCalls: [] } },
    { type: "user", payload: { content: "第二问" } },
    { type: "assistant", payload: { content: "第二答", toolCalls: [] } },
  ];
  const lines = events.map((event, index) =>
    JSON.stringify({ seq: index, ts: new Date().toISOString(), ...event }),
  );
  await writeFile(path.join(dir, "session.v1.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return dir;
}

function runHost(home, commands, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: path.dirname(HOST),
      env: {
        ...process.env,
        HARNESS_HOME: home,
        AGENTS_HOME: path.join(home, ".agents-fixture"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let buffer = "";
    let lastCommand;
    const timer = setTimeout(() => {
      child.kill();
      const tail = events.slice(-3).map((event) => JSON.stringify(event).slice(0, 300));
      reject(new Error([
        "host timed out",
        `last command: ${JSON.stringify(lastCommand)}`,
        `last events (${events.length} total): ${tail.join(" | ") || "(none)"}`,
      ].join("\n")));
    }, HOST_TIMEOUT_MS);

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
    child.stderr.on("data", (chunk) => events.push({ type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(events);
    });

    for (const command of commands) {
      lastCommand = command;
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }
  });
}

/** The id the host named in `已从该会话分叉出 <id>`. */
function forkedId(notice) {
  const match = /已从该会话分叉出\s+(\S+)/.exec(String(notice.text ?? ""));
  expect(match, `unexpected notice: ${JSON.stringify(notice)}`).not.toBeNull();
  return match[1];
}

async function readFork(home, id) {
  const dir = path.join(home, "sessions", id);
  const header = JSON.parse(await readFile(path.join(dir, "header.json"), "utf8"));
  const log = await readFile(path.join(dir, "session.v1.jsonl"), "utf8");
  return { header, lines: log.split("\n").filter((line) => line.trim() !== "") };
}

describe.skipIf(!DIST_BUILT)("forkSession 透传 atSeq（BACKLOG 5.6）", () => {
  it("带 atSeq 在指定位置分叉，缺省仍在日志末尾分叉", async () => {
    const home = await tempHome();
    await writeSourceSession(home);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "forkSession", id: "src-session", atSeq: 1 },
        { cmd: "forkSession", id: "src-session" },
      ],
      {
        until: (all) =>
          all.filter((event) => event.type === "notice" && String(event.text).includes("已从该会话分叉出"))
            .length === 2,
      },
    );

    const notices = events.filter(
      (event) => event.type === "notice" && String(event.text).includes("已从该会话分叉出"),
    );
    expect(notices).toHaveLength(2);
    const [shorterId, fullId] = notices.map(forkedId);

    const shorter = await readFork(home, shorterId);
    const full = await readFork(home, fullId);
    // seq 1 is user+assistant: two events, not the four at the end of the log.
    expect(shorter.lines).toHaveLength(2);
    expect(shorter.header.forkedFrom).toEqual({ sessionId: "src-session", seq: 1 });
    // Absent atSeq must keep the old behaviour: the whole log.
    expect(full.lines).toHaveLength(4);
    expect(full.header.forkedFrom).toEqual({ sessionId: "src-session", seq: 3 });
    // Each fork was opened for the operator, as before.
    expect(events.filter((event) => event.type === "session_loaded").length).toBeGreaterThanOrEqual(2);
  }, HOST_TIMEOUT_MS);

  it("atSeq 超出日志范围时把内核的原文带回给用户，且不产生新会话", async () => {
    const home = await tempHome();
    await writeSourceSession(home);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "forkSession", id: "src-session", atSeq: 99 },
      ],
      { until: (all) => all.some((event) => event.type === "notice" && String(event.text).includes("会话未分叉")) },
    );

    const notice = events
      .filter((event) => event.type === "notice" && String(event.text).includes("会话未分叉"))
      .at(-1);
    // The bound is the kernel's fact (last seq 3), not one the host re-derives.
    expect(notice.text).toContain("atSeq 必须是 0..3 之间的整数");
    const dirs = await readdir(path.join(home, "sessions"));
    expect(dirs).toStrictEqual(["src-session"]);
  }, HOST_TIMEOUT_MS);

  it("atSeq 不是非负整数时在宿主侧拒绝，不静默退回「分叉到末尾」", async () => {
    const home = await tempHome();
    await writeSourceSession(home);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "forkSession", id: "src-session", atSeq: -1 },
        { cmd: "forkSession", id: "src-session", atSeq: 1.5 },
      ],
      {
        until: (all) =>
          all.filter((event) => event.type === "notice" && String(event.text).includes("atSeq 必须是非负整数"))
            .length === 2,
      },
    );

    const warnings = events.filter(
      (event) => event.type === "notice" && String(event.text).includes("atSeq 必须是非负整数"),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.every((event) => event.level === "warn")).toBe(true);
    const dirs = await readdir(path.join(home, "sessions"));
    expect(dirs).toStrictEqual(["src-session"]);
  }, HOST_TIMEOUT_MS);
});
