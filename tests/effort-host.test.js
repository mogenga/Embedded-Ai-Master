import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The desktop host's reasoning-effort contract, end to end.
 *
 * These cases drive the real host process over NDJSON and look at three
 * separate facts, because the feature is only "real" when all three agree:
 *
 *   1. what the `state` event says the model accepts (`effortChoices`);
 *   2. what `setEffort` answers — a `state` when it applied, a warn when it
 *      refused — and what `run.json` then holds;
 *   3. what the gateway actually received (`reasoning_effort` on the wire, or
 *      the field's absence).
 *
 * The third one is the point: before this contract existed the host answered
 * every `setEffort` with a warning while the popover still moved, and the
 * request never carried the parameter at all.
 */

const HOST = path.join(import.meta.dirname, "..", "desktop", "host", "host.js");
const HOST_TIMEOUT_MS = 30_000;

const tempDirs = [];
const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve)).catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * A gateway that answers completions with a plain JSON body.
 *
 * A 200 with a JSON payload (rather than an SSE stream) is a shape the adapter
 * already accepts: it sniffs the first bytes and falls back to one-shot
 * parsing. That keeps the fixture to a single request per model call instead
 * of a stream-then-degrade dance, while still recording exactly what arrived.
 */
async function completionGateway() {
  const bodies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text !== "") {
        try {
          bodies.push(JSON.parse(text));
        } catch {
          bodies.push({ unparsed: text });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies };
}

async function tempHome(models, baseUrl) {
  const dir = await mkdtemp(path.join(tmpdir(), "eam-effort-host-"));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, "providers.json"),
    JSON.stringify({
      gw: {
        protocol: "openai-chat-completions",
        baseUrl,
        models,
      },
    }),
  );
  return dir;
}

function runHost(home, commands, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: path.dirname(HOST),
      env: {
        ...process.env,
        HARNESS_HOME: home,
        // Same rule as `HARNESS_HOME`: a test must never read the machine's
        // real `~/.agents/skills`.
        AGENTS_HOME: path.join(home, ".agents-fixture"),
        ...(options.env ?? {}),
      },
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

const states = (events) => events.filter((event) => event.type === "state");
const notices = (events) => events.filter((event) => event.type === "notice");

const PLAIN_MODELS = { flash: { contextWindow: 8192, maxOutput: 512 } };
const REASONING_MODELS = {
  flash: { contextWindow: 8192, maxOutput: 512, supportsReasoning: true },
};

describe("desktop host 的推理强度", () => {
  it("模型未声明支持时只提供 auto，并说明原因", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(PLAIN_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const state = states(events)[0];

    // 渲染器在 levels 前面自己补 "auto"，所以空 levels 就是「只有 auto」。
    expect(state.effortChoices.levels).toStrictEqual([]);
    expect(state.effort).toBe("auto");
    expect(state.effortChoices.note).toContain("supportsReasoning");
    // `supportsReasoning` 也只是转述配置，不再是写死的 false。
    expect(state.models[0].supportsReasoning).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("模型声明支持时提供四个等级，并如实报告能力", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const state = states(events)[0];

    expect(state.effortChoices.levels).toStrictEqual(["minimal", "low", "medium", "high"]);
    expect(state.effort).toBe("auto");
    expect(state.models[0].supportsReasoning).toBe(true);
  }, HOST_TIMEOUT_MS);

  it("setEffort 拒绝不支持的等级，且不改 state", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(PLAIN_MODELS, gateway.baseUrl);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setEffort", effort: "high" },
        // A later command marks the end of the queue: a `state` would have been
        // sent before it if `setEffort` had claimed to apply.
        { cmd: "listSessions" },
      ],
      { until: (all) => all.some((event) => event.type === "sessions") },
    );

    const warn = notices(events).at(-1);
    expect(warn.level).toBe("warn");
    // Names the model and what it does accept — "unsupported" alone would
    // leave the operator guessing whether a different name would work.
    expect(warn.text).toContain("gw/flash");
    expect(warn.text).toContain("auto");
    expect(states(events)).toHaveLength(1);

    // Nothing was written: a refused choice must not create a run.json that
    // records a decision the operator never successfully made.
    await expect(readFile(path.join(home, "run.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, HOST_TIMEOUT_MS);

  it("不支持推理的模型仍接受 auto（那正是它的请求做的事）", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(PLAIN_MODELS, gateway.baseUrl);

    const events = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "setEffort", effort: "auto" }],
      { until: (all) => states(all).length >= 2 },
    );

    // Refusing `auto` would contradict the warning above it, which says auto
    // is the only thing this model supports.
    expect(states(events).at(-1).effort).toBe("auto");
    expect(notices(events).some((notice) => notice.level === "warn")).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("setEffort 接受合法等级：写 run.json 并发 state", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setEffort", effort: "high" },
      ],
      { until: (all) => states(all).some((event) => event.effort === "high") },
    );

    expect(states(events).at(-1).effort).toBe("high");
    const run = JSON.parse(await readFile(path.join(home, "run.json"), "utf8"));
    expect(run.reasoningEffortByModel).toStrictEqual({ "gw/flash": "high" });
  }, HOST_TIMEOUT_MS);

  it("选择跨重启保留，auto 又把它清掉", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "setEffort", effort: "minimal" }], {
      until: (all) => states(all).some((event) => event.effort === "minimal"),
    });

    // A second, independent host process: this is the restart.
    const restarted = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    expect(states(restarted)[0].effort).toBe("minimal");

    const cleared = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "setEffort", effort: "auto" }], {
      until: (all) => states(all).length >= 2,
    });
    expect(states(cleared).at(-1).effort).toBe("auto");
    const run = JSON.parse(await readFile(path.join(home, "run.json"), "utf8"));
    expect(run.reasoningEffortByModel ?? {}).toStrictEqual({});
  }, HOST_TIMEOUT_MS);

  it("非法等级回 warn 并列出合法值", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setEffort", effort: "max" },
        { cmd: "listSessions" },
      ],
      { until: (all) => all.some((event) => event.type === "sessions") },
    );

    const warn = notices(events).at(-1);
    expect(warn.level).toBe("warn");
    expect(warn.text).toContain("max");
    expect(warn.text).toContain("minimal");
    expect(states(events)).toHaveLength(1);
  }, HOST_TIMEOUT_MS);

  it("选中的等级真的上线；未选时请求体里没有这个字段", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setEffort", effort: "medium" },
        { cmd: "prompt", text: "hi" },
      ],
      { until: (all) => all.some((event) => event.type === "run_end") },
    );

    expect(gateway.bodies).toHaveLength(1);
    expect(gateway.bodies[0].reasoning_effort).toBe("medium");

    // A model that never declared support gets no field, even though the
    // popover's last choice is still remembered for the other model.
    const plainHome = await tempHome(PLAIN_MODELS, gateway.baseUrl);
    await runHost(plainHome, [{ cmd: "init", cwd: plainHome }, { cmd: "prompt", text: "hi" }], {
      until: (all) => all.some((event) => event.type === "run_end"),
    });
    expect(Object.hasOwn(gateway.bodies.at(-1), "reasoning_effort")).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("选择后推送 settings，设置页手里的 run.json 副本不会过期", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    // Boot does not send `settings`; the first one here is the post-click push.
    const events = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "setEffort", effort: "low" }],
      { until: (all) => all.some((event) => event.type === "settings") },
    );

    // The settings page writes `run.json` whole for the controls it owns, so a
    // copy that predates this click would silently revert it on the next save.
    const settings = events.filter((event) => event.type === "settings").at(-1);
    expect(settings.settings.run.reasoningEffortByModel).toStrictEqual({ "gw/flash": "low" });
  }, HOST_TIMEOUT_MS);

  it("providers.json 里的默认等级会作为 Auto 的说明展示", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(
      { flash: { contextWindow: 8192, maxOutput: 512, reasoningEffort: "low" } },
      gateway.baseUrl,
    );

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const state = states(events)[0];

    // The level is a default, not a selection: `auto` stays selected and the
    // menu says which level auto will send.
    expect(state.effort).toBe("auto");
    expect(state.effortChoices.default).toBe("low");
    expect(state.effortChoices.levels).toStrictEqual(["minimal", "low", "medium", "high"]);
    expect(state.models[0].supportsReasoning).toBe(true);
  }, HOST_TIMEOUT_MS);
});
