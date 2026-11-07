import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * BACKLOG 5.2 / D-221 建议 ②: `system_prompt_mismatch` needs a readable exit.
 *
 * The kernel rule is deliberate (`src/index.ts`: a log with no `system` event
 * may not gain one on resume, or two projections of the same log would produce
 * different model input). What is missing is a sentence the operator can act
 * on: the settings-page input that used to cause this is gone, so the only way
 * left to hit it is a hand-edited `run.json`, and the answer must name both
 * ways out and the file to edit.
 *
 * The host is spawned for real because the mapping lives in its prompt path
 * (`handlePrompt`), not in a pure function: `host.js` is a program whose module
 * body boots the NDJSON loop, so it cannot be imported by a test. A temp
 * `HARNESS_HOME` keeps every write inside `os.tmpdir()`.
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
  const dir = await mkdtemp(path.join(tmpdir(), "eam-system-prompt-"));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, "providers.json"),
    JSON.stringify({
      gw: {
        protocol: "openai-chat-completions",
        // Never contacted: the resume check throws before the model call.
        baseUrl: "http://127.0.0.1:1/v1",
        models: { flash: { contextWindow: 8192, maxOutput: 512 } },
      },
    }),
    "utf8",
  );
  return dir;
}

/**
 * Write a saved conversation by hand: one header and the given events.
 *
 * `events[0]` defaults to a user event; callers append whatever the case needs
 * (a `system` event for the other mismatch shape, for instance). The host is
 * not the only author of a session file, and creating these through a run would
 * tie them to an id the test cannot predict.
 */
async function writeSession(home, { id, events = [{ type: "user", payload: { content: "旧会话" } }] }) {
  const dir = path.join(home, "sessions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "header.json"),
    JSON.stringify({ id, createdAt: new Date().toISOString(), status: "closed" }),
    "utf8",
  );
  const lines = events.map((event, index) =>
    JSON.stringify({ seq: index, ts: new Date().toISOString(), ...event }),
  );
  await writeFile(path.join(dir, "session.v1.jsonl"), `${lines.join("\n")}\n`, "utf8");
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

/** The `error` event, with the surrounding notices in the failure message. */
function failureOf(events) {
  const error = events.find((event) => event.type === "error");
  expect(
    error,
    `no error event; got: ${JSON.stringify(events.filter((e) => e.type === "notice" || e.type === "error"))}`,
  ).toBeDefined();
  return error;
}

describe.skipIf(!DIST_BUILT)("system_prompt_mismatch 的人话出路（BACKLOG 5.2）", () => {
  it("旧会话没有 system 事件时：中文说明 + 两条出路 + run.json 路径，不是英文原文", async () => {
    const home = await tempHome();
    await writeSession(home, { id: "sess-no-system" });
    const runJson = path.join(home, "run.json");
    await writeFile(runJson, JSON.stringify({ systemPrompt: "你是调试助手" }), "utf8");

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: "sess-no-system" },
        { cmd: "prompt", text: "继续" },
      ],
      { until: (all) => all.some((event) => event.type === "run_end") },
    );

    const failure = failureOf(events);
    // The situation: this session recorded no system prompt.
    expect(failure.message).toContain("没有记录系统提示词");
    expect(failure.message).toContain("不能补写");
    // Remedy 1 and remedy 2, with the file the host actually reads.
    expect(failure.message).toContain("新建会话");
    expect(failure.message).toContain("run.json");
    expect(failure.message).toContain(runJson);
    expect(failure.message).toContain("systemPrompt");
    // The kernel's English exception must not be the thing the user reads.
    expect(failure.message).not.toContain("Cannot add a system prompt");
  }, HOST_TIMEOUT_MS);

  it("另一种 system_prompt_mismatch（已有 system 事件、内容不同）保持原行为，不谎称「没有记录」", async () => {
    const home = await tempHome();
    await writeSession(home, {
      id: "sess-system-differs",
      events: [
        { type: "user", payload: { content: "旧会话" } },
        { type: "system", payload: { content: "旧提示词" } },
      ],
    });
    await writeFile(
      path.join(home, "run.json"),
      JSON.stringify({ systemPrompt: "你是调试助手" }),
      "utf8",
    );

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: "sess-system-differs" },
        { cmd: "prompt", text: "继续" },
      ],
      { until: (all) => all.some((event) => event.type === "run_end") },
    );

    const failure = failureOf(events);
    // Still today's behaviour: no mapping, the kernel's own sentence surfaces.
    expect(failure.message).toContain("Session system prompt does not match");
    // The "cannot add" explanation would be a lie here: a prompt *is* recorded.
    expect(failure.message).not.toContain("没有记录系统提示词");
  }, HOST_TIMEOUT_MS);
});
