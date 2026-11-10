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

/**
 * A gateway that answers both `/v1/models` (with capability fields) and the
 * chat endpoint.
 *
 * 2026-11-10: the operator's gateway reports `reasoning_efforts` per model, and
 * the host now reads it. This fixture is the smallest shape that proves the
 * handshake picks it up — a capability table the model's own `providers.json`
 * entry deliberately contradicts, so a green assertion cannot come from the
 * config path instead.
 */
async function catalogGateway(entries) {
  const bodies = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: entries }));
      return;
    }
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
      res.end(JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
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

/** 两个 provider，各自一个网关，用来测「换 provider 也要换能力表」。 */
async function twoProviderHome(first, second) {
  const dir = await mkdtemp(path.join(tmpdir(), "eam-effort-host-"));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, "providers.json"),
    JSON.stringify({
      alpha: {
        protocol: "openai-chat-completions",
        baseUrl: first.baseUrl,
        models: first.models,
      },
      beta: {
        protocol: "openai-chat-completions",
        baseUrl: second.baseUrl,
        models: second.models,
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
    let lastCommand;
    const timer = setTimeout(() => {
      child.kill();
      // Name the last command, the last three events and whether the process is
      // still alive: "events: a,b,c" alone cannot tell a host that never booted
      // from one that booted and stalled on the command just sent.
      const tail = events.slice(-3).map((event) => JSON.stringify(event).slice(0, 300));
      reject(new Error([
        "host timed out",
        `last command: ${JSON.stringify(lastCommand)}`,
        `last events (${events.length} total): ${tail.join(" | ") || "(none)"}`,
        `process alive: ${child.exitCode === null && child.signalCode === null} (code ${child.exitCode}, signal ${child.signalCode})`,
      ].join("\n")));
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

    for (const command of commands) {
      lastCommand = command;
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }
  });
}

const states = (events) => events.filter((event) => event.type === "state");
const notices = (events) => events.filter((event) => event.type === "notice");

/** 六档的固定顺序（2026-11-10）：「永远六格」+「AUTO删掉」= 正好这六个。 */
const SIX = ["low", "medium", "high", "extra", "max", "galaxy"];

const PLAIN_MODELS = { flash: { contextWindow: 8192, maxOutput: 512 } };
const REASONING_MODELS = {
  flash: { contextWindow: 8192, maxOutput: 512, supportsReasoning: true },
};

describe("desktop host 的推理强度", () => {
  it("模型未声明支持时只剩一档 Off，且能拖的档位数为零", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(PLAIN_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const state = states(events)[0];

    // 2026-11-09 用户决定（自适应映射 +「只剩一档，拖不动」）：
    // 控件的长度就是能力声明，所以这个模型只给一个停在原地的档位。
    // 以前这里是六档 + 一句 note，那句 note 现在删了 —— 既然拖不到任何
    // 别的地方，就没有需要道歉的东西。
    expect(state.effortChoices.stops).toStrictEqual([
      { value: "low", label: "Low", sends: null },
    ]);
    expect(state.effort).toBe("auto");
    expect(state.effortChoices.note).toBe("");
    // The flag stays: it is a fact about the model, not about the slider.
    expect(state.effortChoices.unsupported).toBe(true);
    expect(state.models[0].supportsReasoning).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("模型声明支持时提供六档，并如实报告能力", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const state = states(events)[0];

    // Six tiers since 2026-11-09, not the four protocol levels: the slider's
    // stops are tiers, and a protocol value in this list would be a stop the
    // control cannot reach.
    expect(state.effortChoices.levels).toStrictEqual(["low", "medium", "high", "extra", "max", "galaxy"]);
    expect(state.effort).toBe("auto");
    expect(state.models[0].supportsReasoning).toBe(true);
    // A declared model carries no caveat.
    expect(state.effortChoices.unsupported).toBe(false);
    expect(state.effortChoices.note).toBe("");
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

  it("非法值回 warn 并列出合法值（两套词汇都列出）", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        // `max` was the example here before the six tiers landed; it is a real
        // tier now, so the case needs a value that is in neither vocabulary.
        { cmd: "setEffort", effort: "turbo" },
        { cmd: "listSessions" },
      ],
      { until: (all) => all.some((event) => event.type === "sessions") },
    );

    const warn = notices(events).at(-1);
    expect(warn.level).toBe("warn");
    expect(warn.text).toContain("turbo");
    // Both halves of the accepted set are named, or an operator holding an old
    // run.json value would read the message as "your saved choice is invalid".
    expect(warn.text).toContain("minimal");
    expect(warn.text).toContain("galaxy");
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
    expect(state.effortChoices.levels).toStrictEqual(["low", "medium", "high", "extra", "max", "galaxy"]);
    expect(state.models[0].supportsReasoning).toBe(true);
  }, HOST_TIMEOUT_MS);
});

/**
 * 三级回退的第 1 级：网关目录（2026-11-10）。
 *
 * 这组测的是**宿主真的读了 `/v1/models`**，而不是只把内核的解析函数测了一遍。
 * 判据是配置与目录故意冲突：`providers.json` 里这个模型只声明了
 * `supportsReasoning: true`（没有任何档位信息），而网关说它接受
 * `low/medium/high/xhigh/max`。停靠站里出现 `extra` 只可能来自目录。
 */
describe("网关目录优先于缺省映射", () => {
  it("模型没有声明 supportsReasoning，但网关报了能力 → 仍然六格，映射按网关", async () => {
    // 2026-11-10 用户决定：「永远六格，各家模型适配做映射」。
    // 轨道长度不再随模型变化，变的是每一档映射到哪个协议值。
    const gateway = await catalogGateway([
      {
        id: "flash",
        reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
        reasoning_default_effort: "max",
      },
    ]);
    const home = await tempHome(PLAIN_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => states(all).some(
        (event) => (event.effortChoices?.stops ?? []).some((stop) => stop.sends === "xhigh"),
      ),
      timeoutMs: 25_000,
    });

    const last = states(events).at(-1).effortChoices;
    expect(last.stops.map((stop) => stop.value)).toStrictEqual(SIX);
    // 目录推翻了「不支持」的判断，所以那个标记不该再亮着。
    expect(last.unsupported).toBe(false);
    // 映射跟着网关走：`extra` 在这个模型上发 `xhigh`，而缺省映射只会发 `high`。
    const byTier = Object.fromEntries(last.stops.map((stop) => [stop.value, stop.sends]));
    expect(byTier.extra).toBe("xhigh");
    expect(byTier.max).toBe("max");
    expect(byTier.galaxy).toBe("max");
  }, HOST_TIMEOUT_MS);

  it("目录报五档时，轨道仍是六格，但 extra 发 xhigh 而不是 high", async () => {
    const gateway = await catalogGateway([
      {
        id: "flash",
        supports_reasoning: true,
        reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
        reasoning_default_effort: "max",
      },
    ]);
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => states(all).some(
        (event) => (event.effortChoices?.stops ?? []).some((stop) => stop.sends === "xhigh"),
      ),
      timeoutMs: 25_000,
    });

    const stops = states(events).at(-1).effortChoices.stops;
    expect(stops.map((stop) => stop.value)).toStrictEqual(SIX);
    const sends = Object.fromEntries(stops.map((stop) => [stop.value, stop.sends]));
    // `xhigh` 只有目录知道 —— 缺省映射永远算不出它。
    expect(sends.extra).toBe("xhigh");
    expect(sends.galaxy).toBe("max");
    // 轨道上没有 `auto`（2026-11-10 用户决定删掉），所以它不在这里。
    expect(stops.some((stop) => stop.value === "auto")).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("目录说只有 high/xhigh 时，低档仍在轨道上但标为「没有请求值」", async () => {
    // 固定六格的代价：一个最低只到 `high` 的模型，`low` / `medium` 没有对应的
    // 请求值。它们**保留在轨道上**（尺度固定），但 `sends` 是 null —— 界面据此
    // 知道拖到那里不会有请求，而不是假装它能发什么。
    const gateway = await catalogGateway([
      { id: "flash", supports_reasoning: true, reasoning_efforts: ["high", "xhigh"] },
    ]);
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => states(all).some(
        (event) => (event.effortChoices?.stops ?? []).some((stop) => stop.sends === "xhigh"),
      ),
      timeoutMs: 25_000,
    });

    const stops = states(events).at(-1).effortChoices.stops;
    expect(stops.map((stop) => stop.value)).toStrictEqual(SIX);
    const sends = Object.fromEntries(stops.map((stop) => [stop.value, stop.sends]));
    expect(sends.low).toBeNull();
    expect(sends.medium).toBeNull();
    expect(sends.high).toBe("high");
    expect(sends.extra).toBe("xhigh");
  }, HOST_TIMEOUT_MS);

  it("目录报的 xhigh 真的上线（适配层不再按旧白名单拒绝）", async () => {
    const gateway = await catalogGateway([
      { id: "flash", supports_reasoning: true, reasoning_efforts: ["low", "high", "xhigh"] },
    ]);
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    // `setEffort` 与 `prompt` 必须在目录到达**之后**发。命令是排队执行的，
    // 而目录抓取是 `ready` 之后才发的异步请求 —— 一次性灌进去就等于在目录
    // 还空着的时候选了 `extra`，它会按第 3 级折算成 `high`。
    // 这里先等到目录那个 `state`（stops 里出现 `extra`），再发后续命令。
    await runHost(
      home,
      [{ cmd: "init", cwd: home }],
      {
        until: (all) => states(all).some(
          (event) => (event.effortChoices?.stops ?? []).some((stop) => stop.value === "extra"),
        ),
        timeoutMs: 25_000,
      },
    );
    // 上一步已经退出进程；重开一次，此时目录已落盘缓存，`ready` 之前就能用。
    await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setEffort", effort: "extra" },
        { cmd: "prompt", text: "hi" },
      ],
      { until: (all) => all.some((event) => event.type === "run_end"), timeoutMs: 30_000 },
    );

    // `extra` 在目录能力下解析成 `xhigh`；它超出内核原来的五个安全值，
    // 能出现在请求体里就说明适配层已经不再用它那份白名单二次拦截。
    expect(gateway.bodies).toHaveLength(1);
    expect(gateway.bodies[0].reasoning_effort).toBe("xhigh");
  }, HOST_TIMEOUT_MS);
});

describe("能力表按 provider 分开（2026-11-10）", () => {
  it("换到另一个 provider 的模型时，用的是那个网关的能力，不是上一个的", async () => {
    // 真机上的形态：`wb` 报五档、`deepseek` 报三档。同进程里切模型必须重取，
    // 否则第二个 provider 的模型会一直查不到能力、退回缺省映射。
    const alpha = await catalogGateway([
      { id: "a1", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] },
    ]);
    const beta = await catalogGateway([
      { id: "b1", effort: { supported_levels: ["low", "high", "max"] } },
    ]);
    const home = await twoProviderHome(
      { baseUrl: alpha.baseUrl, models: { a1: { contextWindow: 8192, maxOutput: 512 } } },
      { baseUrl: beta.baseUrl, models: { b1: { contextWindow: 8192, maxOutput: 512 } } },
    );

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        // 等 `alpha` 的能力到位再切：`extra` 发 `xhigh` 只可能来自那个目录。
        { cmd: "setModel", model: "beta/b1" },
      ],
      {
        // 判据是 **beta 的能力生效**，不是"已经切到 beta"：切模型与取能力是
        // 两个异步步骤，中间那个 `state` 用的是缺省映射（`extra → high`），
        // 正好与目标值相同 —— 按它判会早一步收工。这里等 `medium → low`，
        // 那是 beta 独有的结果（缺省映射里 medium 发 medium）。
        until: (all) => {
          const last = states(all).at(-1);
          const stops = last?.effortChoices?.stops ?? [];
          return last?.model === "beta/b1"
            && stops.some((stop) => stop.value === "medium" && stop.sends === "low");
        },
        timeoutMs: 30_000,
      },
    );

    const stops = states(events).at(-1).effortChoices.stops;
    const byTier = Object.fromEntries(stops.map((stop) => [stop.value, stop.sends]));
    // `beta` 只报 {low, high, max}。按「秩 ≤ 该档的最高者」：
    //   medium(3) → low(2)    extra(5) → high(4)
    //   high(4) → high(4)     max(6)/galaxy(7) → max(6)
    // 关键判据是 `extra`：`alpha` 的表会把它算成 `xhigh`，`beta` 的表算成
    // `high`。两种结果不同，所以这条能抓住「还在用上一个 provider 的表」。
    expect(byTier.medium).toBe("low");
    expect(byTier.extra).toBe("high");
    expect(byTier.max).toBe("max");
    // `xhigh` 只可能来自 `alpha`，它不该出现在 `beta` 的结果里。
    expect(stops.some((stop) => stop.sends === "xhigh")).toBe(false);
  }, HOST_TIMEOUT_MS);
});

/**
 * What each tier will actually put on the wire, per model.
 *
 * This is the half of the feature the six tiers cannot carry on their own: the
 * stops are UI language, and for a model with no `effortMap` the top three all
 * send `high`. Without `resolved` the panel can only say "Galaxy", and the
 * operator has to guess whether the top of the track does anything at all.
 */
describe("宿主报告每一档实际会发的协议值", () => {
  it("没有 effortMap 的模型：六档各自折算，后三档都是 high", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const state = states(events)[0];

    expect(state.effortChoices.resolved).toStrictEqual({
      low: "low",
      medium: "medium",
      high: "high",
      extra: "high",
      max: "high",
      galaxy: "high",
    });
    // One key per offered tier and no others: a resolved entry for a tier the
    // menu does not offer would be a value nothing can select.
    expect(Object.keys(state.effortChoices.resolved).sort())
      .toStrictEqual([...state.effortChoices.levels].sort());
  }, HOST_TIMEOUT_MS);

  it("手写 effortMap 覆盖后，报告的折算结果跟着改", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(
      {
        flash: {
          contextWindow: 8192,
          maxOutput: 512,
          supportsReasoning: true,
          // Only one tier overridden: the rest must fall back to the default
          // map, not to `undefined` and not to the override.
          effortMap: { extra: "medium" },
        },
      },
      gateway.baseUrl,
    );

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const resolved = states(events)[0].effortChoices.resolved;

    expect(resolved.extra).toBe("medium");
    expect(resolved.high).toBe("high");
    expect(resolved.max).toBe("high");
    expect(resolved.galaxy).toBe("high");
  }, HOST_TIMEOUT_MS);

  it("默认映射下六格都在，后三格都报 high（映射表要如实说出来）", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const stops = states(events)[0].effortChoices.stops;

    // 六格固定（2026-11-10），但 `sends` 如实报告每一格实际发什么：
    // 缺省映射把 extra / max / galaxy 都折成 high，所以它们必须**都**写
    // `high` —— 面板据此显示「sends high」，不让三格看起来像三种强度。
    expect(stops.map((stop) => stop.value)).toStrictEqual(SIX);
    const sends = Object.fromEntries(stops.map((stop) => [stop.value, stop.sends]));
    expect(sends.low).toBe("low");
    expect(sends.medium).toBe("medium");
    expect(sends.high).toBe("high");
    expect(sends.extra).toBe("high");
    expect(sends.max).toBe("high");
    expect(sends.galaxy).toBe("high");
  }, HOST_TIMEOUT_MS);

  it("effortMap 改过之后，六格里对应那几格的 sends 跟着改", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(
      {
        flash: {
          contextWindow: 8192,
          maxOutput: 512,
          supportsReasoning: true,
          // 一个能区分更多档的映射：extra/max 各自发不同的值。
          effortMap: { extra: "minimal", max: "none", galaxy: "high" },
        },
      },
      gateway.baseUrl,
    );

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const stops = states(events)[0].effortChoices.stops;

    // 轨道长度不变（六格），变的是每格发什么 —— 这就是「映射做适配」。
    expect(stops.map((stop) => stop.value)).toStrictEqual(SIX);
    const sends = Object.fromEntries(stops.map((stop) => [stop.value, stop.sends]));
    expect(sends.extra).toBe("minimal");
    expect(sends.max).toBe("none");
    expect(sends.galaxy).toBe("high");
  }, HOST_TIMEOUT_MS);

  it("不支持推理的模型也给折算表，另带 unsupported 说明", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(PLAIN_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const state = states(events)[0];

    // 2026-11-09：档位与折算表**照报**。它们是档位列表的性质，不是这个模型
    // 声明的性质——「这个模型收不到」由 `unsupported` 与 `note` 说出来，
    // 而不是靠把控件藏掉（用户原话：「思考强度应该始终显示」）。
    expect(state.effortChoices.levels).toStrictEqual(["low", "medium", "high", "extra", "max", "galaxy"]);
    expect(state.effortChoices.resolved).toStrictEqual({
      low: "low", medium: "medium", high: "high",
      extra: "high", max: "high", galaxy: "high",
    });
    expect(state.effortChoices.unsupported).toBe(true);
  }, HOST_TIMEOUT_MS);
});

describe("setEffort 接受档位，档位原样落盘、按映射上线", () => {
  it("选 Galaxy：state 回报 galaxy，run.json 存档位名而不是折算后的 high", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "setEffort", effort: "galaxy" }],
      { until: (all) => states(all).some((event) => event.effort === "galaxy") },
    );

    expect(notices(events).some((notice) => notice.level === "warn")).toBe(false);
    expect(states(events).at(-1).effort).toBe("galaxy");
    // Stored as the tier, not folded: the folding needs the model's map *at
    // run time*, and a stored `high` could never follow a later map edit.
    const run = JSON.parse(await readFile(path.join(home, "run.json"), "utf8"));
    expect(run.reasoningEffortByModel).toStrictEqual({ "gw/flash": "galaxy" });
  }, HOST_TIMEOUT_MS);

  it("档位真的上线：默认映射下 Galaxy 发的是 high", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setEffort", effort: "galaxy" },
        { cmd: "prompt", text: "hi" },
      ],
      { until: (all) => all.some((event) => event.type === "run_end") },
    );

    expect(gateway.bodies).toHaveLength(1);
    // The tier never reaches the wire — the kernel's whitelist is unchanged.
    expect(gateway.bodies[0].reasoning_effort).toBe("high");
  }, HOST_TIMEOUT_MS);

  it("模型的 effortMap 决定上线值：Galaxy 映射到 medium 就发 medium", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(
      {
        flash: {
          contextWindow: 8192,
          maxOutput: 512,
          supportsReasoning: true,
          effortMap: { galaxy: "medium" },
        },
      },
      gateway.baseUrl,
    );

    await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "setEffort", effort: "galaxy" },
        { cmd: "prompt", text: "hi" },
      ],
      { until: (all) => all.some((event) => event.type === "run_end") },
    );

    expect(gateway.bodies[0].reasoning_effort).toBe("medium");
  }, HOST_TIMEOUT_MS);

  it("协议值仍然接受（旧 run.json 的选择不会被判非法）", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "setEffort", effort: "minimal" }],
      { until: (all) => states(all).some((event) => event.effort === "minimal") },
    );

    // `minimal` has no tier; refusing it would strand a choice a previous
    // build wrote and the kernel can still send.
    expect(notices(events).some((notice) => notice.level === "warn")).toBe(false);
    expect(states(events).at(-1).effort).toBe("minimal");
  }, HOST_TIMEOUT_MS);
});
