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
      { value: "auto", label: "Off", sends: null },
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
  it("模型没有声明 supportsReasoning，但网关报了能力 → 用网关的", async () => {
    // 用户这台网关的真实状态：`providers.json` 里每个模型只有 contextWindow，
    // 一个推理字段都没有，而 `/v1/models` 逐个报 reasoning_efforts。
    // 「用户没声明」不等于「模型不支持」—— 这条钉住这个区别，否则一次重构
    // 把 `supportsReasoning` 的判断放回目录之前，滑块就会永远停在 Off。
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
        (event) => (event.effortChoices?.stops ?? []).some((stop) => stop.value === "extra"),
      ),
      timeoutMs: 25_000,
    });

    const stops = states(events).at(-1).effortChoices.stops;
    expect(stops.map((stop) => stop.value)).toStrictEqual([
      "auto", "low", "medium", "high", "extra", "max",
    ]);
    // 目录推翻了「不支持」的判断，所以那个标记不该再亮着。
    expect(states(events).at(-1).effortChoices.unsupported).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("目录报五档时，停靠站跟着变成五档而不是三档", async () => {
    const gateway = await catalogGateway([
      {
        id: "flash",
        supports_reasoning: true,
        reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
        reasoning_default_effort: "max",
      },
    ]);
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    // The catalog is fetched after `ready`, so the stop list arrives in a
    // **second** `state`. Waiting for "more stops" would deadlock on a gateway
    // whose catalog does not change the list; wait for the second state and
    // assert on what it says.
    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      // The catalog fetch is fire-and-forget after `ready`, so the second
      // `state` is the one that carries it. Waiting for the *content* rather
      // than for a count keeps this honest: if the follow-up event stopped
      // arriving, the test would time out instead of passing on a count.
      until: (all) => states(all).some(
        (event) => (event.effortChoices?.stops ?? []).some((stop) => stop.value === "extra"),
      ),
      timeoutMs: 25_000,
    });

    const stops = states(events).at(-1).effortChoices.stops;
    // `xhigh` 只有目录知道，缺省映射永远算不出它 → `extra` 这一档存在就是证据。
    expect(stops.map((stop) => stop.value)).toStrictEqual([
      "auto", "low", "medium", "high", "extra", "max",
    ]);
    expect(stops.find((stop) => stop.value === "extra").sends).toBe("xhigh");
    expect(stops.find((stop) => stop.value === "max").sends).toBe("max");
    // galaxy 落在 max 上，与 max 重复，不该单独占一格。
    expect(stops.some((stop) => stop.value === "galaxy")).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("目录说只有 high/xhigh 时，低档不出现（拖不到就发不出去）", async () => {
    const gateway = await catalogGateway([
      { id: "flash", supports_reasoning: true, reasoning_efforts: ["high", "xhigh"] },
    ]);
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      // 目录到达后 `low`/`medium` 会消失 —— 那才是这次要等的形状变化。
      // 按 "有 high" 等会在第一个 `state` 上就命中，等于没等。
      until: (all) => {
        const last = states(all).at(-1);
        if (last === undefined) return false;
        const values = (last.effortChoices?.stops ?? []).map((stop) => stop.value);
        return values.includes("auto") && !values.includes("low");
      },
      timeoutMs: 25_000,
    });

    const stops = states(events).at(-1).effortChoices.stops;
    // 秩 ≤ low / medium 的值一个都没有，所以那两档不可用 —— 停靠站从 high 起。
    expect(stops.map((stop) => stop.value)).toStrictEqual(["auto", "high", "extra"]);
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

  it("默认映射下只给三档：Extra / Max / Galaxy 都发 high，不该各占一格", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(REASONING_MODELS, gateway.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const stops = states(events)[0].effortChoices.stops;

    // 2026-11-09 自适应映射：滑块的每一档必须发一个**不同**的值。
    // 默认映射把 extra / max / galaxy 全折成 high，所以它们不能各占一格
    // —— 那会是三个名字对一个请求，正是以前要补一句声明的原因。
    expect(stops).toStrictEqual([
      { value: "auto", label: "Auto", sends: null },
      { value: "low", label: "Low", sends: "low" },
      { value: "medium", label: "Medium", sends: "medium" },
      { value: "high", label: "High", sends: "high" },
    ]);
    // `sends` 是给人看的，但它的**去重**性质是可断言的核心：没有两个档位
    // 指向同一个值。
    const sends = stops.filter((stop) => stop.sends !== null).map((stop) => stop.sends);
    expect(new Set(sends).size).toBe(sends.length);
  }, HOST_TIMEOUT_MS);

  it("模型把 galaxy 映到独立值时，Galaxy 才作为最高档出现", async () => {
    const gateway = await completionGateway();
    const home = await tempHome(
      {
        flash: {
          contextWindow: 8192,
          maxOutput: 512,
          supportsReasoning: true,
          // 一个真的能区分六档的模型：每档发不同的值。
          effortMap: { extra: "minimal", max: "none", galaxy: "high" },
        },
      },
      gateway.baseUrl,
    );

    const events = await runHost(home, [{ cmd: "init", cwd: home }], {
      until: (all) => all.some((event) => event.type === "ready"),
    });
    const stops = states(events)[0].effortChoices.stops;

    // 六档里有五档发不同的值（high 只出现一次），所以轨道是 Auto + 5 档。
    // `galaxy` 映射到 high，而 high 已经被 `high` 那一档占了 —— 按「第一个
    // 产生该值的档位」规则，Galaxy 不该出现。
    expect(stops.map((stop) => stop.value)).toStrictEqual([
      "auto", "low", "medium", "high", "extra", "max",
    ]);
    expect(stops.at(-1).sends).toBe("none");
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
