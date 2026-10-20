#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INDEX_MODULE = path.join(ROOT, "dist", "index.js");
const LOG_TAIL_MODULE = path.join(ROOT, "dist", "events", "log-tail.js");
const DIAGNOSIS_MODULE = path.join(ROOT, "dist-mcp", "probe", "diagnosis.js");
const PROBE_SERVER = path.join(ROOT, "dist-mcp", "probe", "server.js");
const KB_SERVER = path.join(ROOT, "dist-mcp", "kb", "server.js");
const DEFAULT_RENODE_PATH = "C:/Program Files/Renode/bin/Renode.exe";
const DEFAULT_KB_ROOT = path.join(ROOT, "mcp-servers", "kb", "kb");
const PLATFORM = "platforms/boards/stm32f4_discovery-kit.repl";
const SESSION_ID = "diagnosis-e2e";
const KB_ENTRY = "protocols/uart/no-output.md";

const REGISTERS = {
  vtor: 0xe000ed08,
  apb1enr: 0x40023840,
  gpioaModer: 0x40020000,
  usartCr1: 0x40004400,
  usartBrr: 0x40004408,
};

const FINAL_TEXT = [
  "根因：USART2 未初始化（RCC 时钟未使能、PA2/PA3 未复用、CR1 UE/TE 未置位、BRR 为 0）。",
  "可证伪预测：若在固件中使能 USART2 时钟、将 PA2/PA3 配为 AF7、置 UE|TE 并写入与 PCLK 匹配的 BRR，则 TX 应产生字节；若仍无输出，则本根因判断被证伪。",
].join("\n");

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function providersText() {
  return JSON.stringify({
    gw: {
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      models: { flash: { contextWindow: 16384, maxOutput: 1024 } },
      pricePerMillion: { input: 1, output: 1 },
    },
  });
}

function toolCall(id, name, args) {
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
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}

function doneResponse() {
  return {
    choices: [{ message: { content: FINAL_TEXT }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  };
}

function mockFetch(bodies) {
  let index = 0;
  return async () => {
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function readEvents(sessionDir) {
  const file = path.join(sessionDir, "session.v1.jsonl");
  if (!existsSync(file)) throw new Error(`会话日志不存在: ${file}`);
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function parseText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hexToInt(hex) {
  // Renode 对外设寄存器的 ReadByte 返回寄存器显示顺序（实测 USART2.CR1 为
  // "c0000000" 对应 0xC0000000），因此按大端解析 hex 得到寄存器值。内存读写
  // 的字节序不在本脚本范围；这里只读 STM32 外设寄存器。
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value)) throw new Error(`无法解析 hex: ${hex}`);
  return value;
}

function requireToolResult(events, toolName, count) {
  const results = events.filter(
    (event) => event.type === "tool_result" && event.payload?.toolName === toolName,
  );
  if (results.length !== count) {
    throw new Error(`${toolName} 期望 ${count} 次结果，实际 ${results.length} 次`);
  }
  return results;
}

function registerSnapshot(events) {
  const byAddress = new Map();
  const warnings = [];
  for (const event of requireToolResult(events, "mcp__probe__mem_read", 5)) {
    const parsed = parseText(event.payload.text);
    const memory = parsed?.memory;
    if (memory === undefined || typeof memory.address !== "number" || typeof memory.hex !== "string") {
      throw new Error(`mem_read 结果缺少 memory.address/hex: ${event.payload.text}`);
    }
    if (memory.allZero === true) {
      warnings.push({
        address: `0x${memory.address.toString(16)}`,
        warning: typeof memory.warning === "string" ? memory.warning : "all_zero",
      });
    }
    byAddress.set(memory.address, hexToInt(memory.hex));
  }
  const snapshot = {};
  for (const [name, address] of Object.entries(REGISTERS)) {
    const value = byAddress.get(address);
    if (value === undefined) throw new Error(`缺少地址 0x${address.toString(16)} 的读数`);
    snapshot[name] = value;
  }
  return { snapshot, warnings };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!existsSync(INDEX_MODULE)) {
    console.error("diagnosis e2e: 未找到 dist/index.js；请先运行 npm run build");
    process.exitCode = 2;
    return;
  }
  for (const [label, file] of [
    ["probe server", PROBE_SERVER],
    ["kb server", KB_SERVER],
    ["diagnosis module", DIAGNOSIS_MODULE],
    ["log-tail module", LOG_TAIL_MODULE],
  ]) {
    if (!existsSync(file)) {
      console.error(`diagnosis e2e: 未找到 ${label}（${file}）；请先运行 npm run build:mcp`);
      process.exitCode = 2;
      return;
    }
  }

  const renodePath = process.env.RENODE_PATH?.trim() || DEFAULT_RENODE_PATH;
  if (!existsSync(renodePath)) {
    console.error(`diagnosis e2e: 未找到 Renode 可执行文件: ${renodePath}（可用 RENODE_PATH 覆盖）`);
    process.exitCode = 1;
    return;
  }

  const kbRoot = process.env.KB_ROOT?.trim() || DEFAULT_KB_ROOT;
  if (!existsSync(path.join(kbRoot, "index.yaml"))) {
    console.error(`diagnosis e2e: KB 根缺少 index.yaml: ${kbRoot}`);
    process.exitCode = 2;
    return;
  }

  const { runSession } = await import(pathToFileURL(INDEX_MODULE).href);
  const { analyzeUartBaseline } = await import(pathToFileURL(DIAGNOSIS_MODULE).href);
  const { createLogTailEventSource } = await import(pathToFileURL(LOG_TAIL_MODULE).href);

  const home = mkdtempSync(path.join(tmpdir(), "eam-diagnosis-e2e-"));
  const sessionDir = path.join(home, "sessions", SESSION_ID);
  writeFileSync(
    path.join(home, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          kb: {
            command: process.execPath,
            args: [KB_SERVER],
            env: { KB_ROOT: kbRoot },
          },
          probe: {
            command: process.execPath,
            args: [PROBE_SERVER],
            env: { RENODE_PATH: renodePath },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const monitorPort = await getFreePort();
  const toolSteps = [
    ["call-kb-lookup", "mcp__kb__kb_lookup", { query: "串口没输出", limit: 2 }],
    ["call-kb-read", "mcp__kb__kb_read", { path: KB_ENTRY }],
    [
      "call-probe-attach",
      "mcp__probe__attach",
      { backend: "renode", platform: PLATFORM, monitorPort },
    ],
    ["call-probe-halt", "mcp__probe__halt", {}],
    ["call-vtor", "mcp__probe__mem_read", { address: REGISTERS.vtor, length: 4 }],
    ["call-apb1enr", "mcp__probe__mem_read", { address: REGISTERS.apb1enr, length: 4 }],
    ["call-gpioa", "mcp__probe__mem_read", { address: REGISTERS.gpioaModer, length: 4 }],
    ["call-usart-cr1", "mcp__probe__mem_read", { address: REGISTERS.usartCr1, length: 4 }],
    ["call-usart-brr", "mcp__probe__mem_read", { address: REGISTERS.usartBrr, length: 4 }],
    ["call-probe-detach", "mcp__probe__detach", {}],
  ];
  const bodies = toolSteps.map(([id, name, args]) => toolCall(id, name, args));
  bodies.push(doneResponse());

  let onlineEvents;
  try {
    for await (const _event of runSession({
      input: "诊断：板子串口完全没输出",
      model: "gw/flash",
      providersText: providersText(),
      sessionId: SESSION_ID,
      sessionDir,
      home,
      cwd: ROOT,
      fetchImpl: mockFetch(bodies),
      mcp: {},
      permissions: { preset: "diagnose" },
    })) {
      // 事件同时写入 session.v1.jsonl，循环本身不承担断言。
    }
    onlineEvents = readEvents(sessionDir);

    const lookup = requireToolResult(onlineEvents, "mcp__kb__kb_lookup", 1)[0];
    const lookupData = parseText(lookup.payload.text);
    assert(lookupData?.found === true, "kb_lookup 未命中");
    assert(
      lookupData?.candidates?.[0]?.path === KB_ENTRY,
      `kb_lookup 首候选不是 ${KB_ENTRY}: ${JSON.stringify(lookupData?.candidates)}`,
    );

    const read = requireToolResult(onlineEvents, "mcp__kb__kb_read", 1)[0];
    const readData = parseText(read.payload.text);
    for (const needle of ["probe_attach", "pinmux", "GPIO MODER"]) {
      assert(
        typeof readData?.content === "string" && readData.content.includes(needle),
        `kb_read 内容缺少 ${needle}`,
      );
    }

    const memResults = requireToolResult(onlineEvents, "mcp__probe__mem_read", 5);
    for (const result of memResults) {
      assert(result.payload.evidence === true, `mem_read ${result.payload.id} 未标记 evidence`);
    }

    const { snapshot, warnings: registerWarnings } = registerSnapshot(onlineEvents);
    const warningFields = {};
    for (const warning of registerWarnings) {
      for (const [name, address] of Object.entries(REGISTERS)) {
        if (warning.address === `0x${address.toString(16)}`) warningFields[name] = true;
      }
    }
    const verdict = analyzeUartBaseline({ ...snapshot, warnings: warningFields });
    assert(
      verdict.rootCause.includes("未初始化") || verdict.rootCause.includes("证据不足"),
      `根因不符合预期: ${verdict.rootCause}`,
    );
    assert(verdict.matchedKbSteps.length > 0, "根因未匹配任何 KB 鉴别步骤");
    assert(verdict.falsifiablePrediction.length > 0, "缺少可证伪预测");
    assert(
      verdict.limitations.some((item) => item.includes("复位基线")),
      "缺少仿真复位基线局限声明",
    );
    assert(
      verdict.limitations.some((item) => item.includes("全 0")),
      "缺少全 0/未映射读数局限声明",
    );

    const lifecycle = onlineEvents.filter((event) =>
      ["permission_decision", "tool_started", "tool_result"].includes(event.type),
    );
    const allowed = new Set();
    for (const event of lifecycle) {
      if (event.type === "permission_decision" && event.payload.effective === "allow") {
        allowed.add(event.payload.callId);
      }
      if (event.type === "tool_started") {
        assert(
          allowed.has(event.payload.callId),
          `tool_started ${event.payload.callId} 之前没有 allow 的权限决策`,
        );
      }
    }

    const source = createLogTailEventSource({ sessionsRoot: path.join(home, "sessions") });
    const replay = await source.read(SESSION_ID, -1);
    const missing = onlineEvents.filter(
      (event) => !replay.events.some((replayed) => replayed.seq === event.seq),
    );
    assert(
      replay.events.length === onlineEvents.length,
      `回放事件数 ${replay.events.length} 与在线 ${onlineEvents.length} 不一致；缺失 ${JSON.stringify(
        missing.map((event) => ({ seq: event.seq, type: event.type })),
      )}`,
    );
    assert(
      replay.events.every((event, index) => event.seq === onlineEvents[index]?.seq),
      "回放事件 seq 与在线日志不一致",
    );
    const onlineTools = onlineEvents
      .filter((event) => event.type === "tool_result")
      .map((event) => event.payload.toolName);
    const replayTools = replay.events
      .filter((event) => event.type === "tool_result")
      .map((event) => event.payload.toolName);
    assert(
      JSON.stringify(onlineTools) === JSON.stringify(replayTools),
      "回放工具序列与在线不一致",
    );

    console.log(
      JSON.stringify({
        symptom: "串口没输出",
        kbEntry: KB_ENTRY,
        rootCause: verdict.rootCause,
        matchedKbSteps: verdict.matchedKbSteps,
        evidence: verdict.checks,
        falsifiablePrediction: verdict.falsifiablePrediction,
        limitations: verdict.limitations,
        registers: Object.fromEntries(
          Object.entries(snapshot).map(([key, value]) => [key, `0x${value.toString(16)}`]),
        ),
        registerWarnings,
        replayEvents: replay.events.length,
        toolSequence: onlineTools,
      }),
    );
  } catch (error) {
    console.error(`diagnosis e2e: ${errorMessage(error)}`);
    if (onlineEvents !== undefined) {
      const failures = onlineEvents
        .filter((event) => event.type === "tool_result" && event.payload?.ok === false)
        .map((event) => `${event.payload.toolName}: ${event.payload.code} ${event.payload.text}`);
      for (const failure of failures) console.error(`  ${failure}`);
    }
    process.exitCode = 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

await main();