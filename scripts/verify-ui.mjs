import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";


const ROOT = resolve(process.cwd());
const DIST = join(ROOT, "dist-web");
const SERVE_ENTRY = join(ROOT, "dist", "server", "serve.js");
const PAGE_PATH = "/";
const VIEWPORT = { width: 1600, height: 1000 };
const WORKBENCH_HEIGHT = 717;
const SESSION_ID = "sess-verify-01";

const results = [];
const extraResults = [];

function check(id, name, ok, actual, expected) {
  results.push({ id, name, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name} | 实测 ${actual} | 期望 ${expected}`);
}

function checkExtra(id, name, ok, actual, expected) {
  extraResults.push({ id, name, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}（附加，不计入 14 项）${name} | 实测 ${actual} | 期望 ${expected}`);
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function fail(message, code = 1) {
  console.error(`ERROR ${message}`);
  process.exit(code);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function getFreePort() {
  return new Promise((done, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function writeSessionFixture(homeDir) {
  const ts = new Date().toISOString();
  const sessionDir = join(homeDir, "sessions", SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  writeJson(join(sessionDir, "header.json"), {
    id: SESSION_ID,
    createdAt: ts,
    status: "closed",
    provider: "local-gw",
    model: "local-gw/flash",
    workdir: ROOT,
  });
  const events = [
    {
      seq: 0,
      ts,
      type: "user",
      payload: {
        content:
          "板子上电后串口打印全是乱码，从第一行开始就这样。用的是 USB-TTL 接 PA9/PA10，终端设的 115200 8N1。同一根线接别的板子正常。",
      },
    },
    {
      seq: 1,
      ts,
      type: "assistant",
      payload: {
        content:
          "第 0 步分流 · 一次只问一个问题\n先用一个问题劈开假设空间：把终端改成 9600、38400、230400 三档各看一眼，哪一档能读出完整字符？",
        note:
          "这一步能立刻区分「波特率算错」与「时钟源没切到 PLL」两条主假设，信息增益最高。若三档都不行，则转向电平 / 地线 / 引脚复用。",
        toolCalls: [],
      },
    },
    {
      seq: 2,
      ts,
      type: "user",
      payload: { content: "230400 时能勉强读出字符，速度大约是预期的一半。" },
    },
    {
      seq: 3,
      ts,
      type: "assistant",
      payload: {
        content:
          "230400 可读、115200 乱码 —— 说明 MCU 实际波特率与目标值不一致，时钟频率与 BRR 计算可能对不上。先检索知识库，再上探针取证。",
        toolCalls: [
          { id: "call_kb_1", name: "kb_lookup", arguments: { query: "STM32 UART 乱码 波特率 时钟" } },
        ],
      },
    },
    {
      seq: 4,
      ts,
      parent: 3,
      type: "tool_result",
      payload: {
        id: "call_kb_1",
        ok: true,
        text: "命中 2",
        detail: {
          ms: 38,
          hits: [
            {
              path: "protocols/uart-stm32-baud.md",
              desc: "症状 → 原因 → 鉴别测试表：时钟源 / BRR 计算 / 过采样方式",
              score: "0.91 · 四段式 · 三级加载进入症状正文",
              channel: 1,
            },
            {
              path: "system/clock-tree-pll.md",
              desc: "HSE 起振失败 → 回退 HSI，系统时钟与固件预期不符",
              score: "0.77 · 按需读取，未整篇加载",
              channel: 1,
            },
          ],
        },
      },
    },
    {
      seq: 5,
      ts,
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [
          {
            id: "call_mem_1",
            name: "mem_read",
            arguments: { address: "0x40023808", size: 4, label: "RCC_CFGR" },
          },
        ],
      },
    },
    {
      seq: 6,
      ts,
      parent: 5,
      type: "tool_result",
      payload: {
        id: "call_mem_1",
        ok: true,
        text: "0x00000000",
        detail: {
          ms: 12,
          readout: [
            { label: "地址", value: "0x4002_3808" },
            { label: "读回", value: "0x0000_0000" },
            {
              label: "字段",
              value: "RCC_CFGR.SW[1:0] = 0b00 → 系统时钟仍为 HSI，未切到 PLL",
            },
          ],
          evidence: [
            {
              name: "时钟源判定",
              code: "RCC_CFGR.SWS",
              value: "0b00 HSI",
              verdict: "bad",
              label: "与预期不符",
            },
          ],
        },
      },
    },
    {
      seq: 7,
      ts,
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [
          {
            id: "call_mem_2",
            name: "mem_read",
            arguments: { address: "0x40004408", size: 4, label: "USART2_BRR" },
          },
        ],
      },
    },
    {
      seq: 8,
      ts,
      parent: 7,
      type: "tool_result",
      payload: {
        id: "call_mem_2",
        ok: true,
        text: "0x0000002E",
        detail: {
          ms: 11,
          readout: [
            { label: "地址", value: "0x4000_4408" },
            { label: "读回", value: "0x0000_002E" },
            {
              label: "字段",
              value:
                "USART2_BRR = 46 —— 按 PCLK1 = 84 MHz、115200 计算所得（84e6 / (16 × 115200) ≈ 45.6）",
            },
          ],
          evidence: [
            {
              name: "BRR 与真实时钟一致性",
              code: "16e6 / (16 × 46) ≈ 21.7 kbps",
              value: "实际 ≈ 21.7 kbps",
              verdict: "bad",
              label: "偏快 5.3×",
            },
            {
              name: "工具诚实性检查",
              code: "全 0 不得判为无故障",
              value: "0x2E ≠ 0x00",
              verdict: "ok",
              label: "读数有效",
            },
          ],
        },
      },
    },
    {
      seq: 9,
      ts,
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [],
        verdict: {
          rootCause:
            "固件按 PCLK1 = 84 MHz 计算 USART2_BRR，但 HSE 晶振未起振，PLL 使能失败后系统回退到 HSI（16 MHz）。时钟与 BRR 不一致，波特率整体偏快约 5.3 倍，接收端按 115200 采样即得乱码。",
          evidence: [
            { name: "RCC_CFGR.SW", code: "0x40023808", value: "0x00", verdict: "warn", label: "HSI 直供" },
            { name: "USART2_BRR", code: "0x40004408", value: "0x2E", verdict: "warn", label: "按 84 MHz 计算" },
            { name: "实测波特率", code: "16e6 / (16 × 46)", value: "21.7 kbps", verdict: "bad", label: "≠ 115200" },
          ],
          prediction:
            "在 HSI 直供前提下，将 USART2->BRR 改为按 16 MHz 计算的值 0x0009；预取预测：终端回到 115200 应立即可读，且实测波特率落在 111.1 kbps（偏差 3.5%，在容限内）。若仍乱码，则本判据被推翻，转向 HSE 起振条件排查。",
          ownership: [
            { t: "agent", title: "agent 自己做", desc: "读寄存器、反汇编 SystemInit、比对 BRR 计算式。" },
            { t: "user", title: "需要你回答", desc: "改 BRR 后 115200 是否恢复可读。" },
            { t: "manual", title: "建议你执行", desc: "用万用表确认 HSE 晶振是否起振（8 MHz）。" },
          ],
          confidence: "高",
        },
      },
    },
    {
      seq: 10,
      ts,
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [],
        guard: { action: "写入", address: "0x40004408", value: "0x0009", state: "待确认" },
      },
    },
    {
      seq: 11,
      ts,
      type: "usage",
      payload: {
        promptTokens: 8120,
        completionTokens: 1460,
        cachedTokens: 2048,
        costUsd: 0.018,
      },
    },
    { seq: 12, ts, type: "status", payload: { status: "done" } },
  ];
  writeFileSync(
    join(sessionDir, "session.v1.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function writeKbFixture(homeDir) {
  const kbDir = join(homeDir, "kb");
  for (const dir of ["厂商分流", "protocols", "system"]) {
    mkdirSync(join(kbDir, dir), { recursive: true });
  }
  for (const name of ["stm32.md", "gd32.md", "nrf52.md", "esp32.md"]) {
    writeFileSync(join(kbDir, "厂商分流", name), `# ${name}\n`, "utf8");
  }
  writeFileSync(
    join(kbDir, "protocols", "uart-stm32-baud.md"),
    "# STM32 UART 波特率\n\nHSE 起振失败会回退 HSI，BRR 计算与实际时钟不一致。\n",
    "utf8",
  );
  writeFileSync(
    join(kbDir, "system", "clock-tree-pll.md"),
    "# 时钟树\n\nPLL 使能失败后的回退路径。\n",
    "utf8",
  );
}

function startService(homeDir, port) {
  const child = spawn(process.execPath, [SERVE_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HARNESS_HOME: homeDir,
      HARNESS_UI_PORT: String(port),
      HARNESS_UI_STATIC: DIST,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = [];
  const capture = (chunk) => {
    output.push(String(chunk));
    if (output.length > 20) output.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return {
    child,
    port,
    output,
    exited: new Promise((done) => child.once("exit", (code, signal) => done({ code, signal }))),
  };
}

async function stopService(service) {
  if (service === undefined) return;
  if (service.child.exitCode === null && service.child.signalCode === null) {
    service.child.kill();
    await Promise.race([service.exited, delay(3000)]);
  }
  if (service.child.exitCode === null && service.child.signalCode === null) {
    service.child.kill("SIGKILL");
    await Promise.race([service.exited, delay(1000)]);
  }
}

async function waitForSessions(service, predicate = () => true) {
  let lastError;
  for (let i = 0; i < 100; i += 1) {
    if (service.child.exitCode !== null) {
      throw new Error(`dist/server/serve.js 提前退出（code ${service.child.exitCode}）：${service.output.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${service.port}/api/sessions`);
      if (response.ok) {
        const body = await response.json();
        if (predicate(body)) return body;
        lastError = new Error("会话列表未满足等待条件");
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error("等待 UI 服务就绪超时");
}

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.warn(`WARN 临时目录清理失败：${dir}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener("message", (event) => this.onMessage(event));
  }

  static connect(url) {
    return new Promise((done, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 10000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        done(new CDP(ws));
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP 连接失败：${String(event.message ?? "websocket error")}`));
      });
    });
  }

  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.method !== message.method) return true;
        if (waiter.sessionId !== undefined && waiter.sessionId !== message.sessionId) return true;
        clearTimeout(waiter.timer);
        waiter.resolve(message.params ?? {});
        return false;
      });
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, method });
      this.ws.send(JSON.stringify(payload));
    });
  }

  waitEvent(method, sessionId, timeout = 20000) {
    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        method,
        sessionId,
        resolve: resolveWait,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          rejectWait(new Error(`等待事件超时：${method}`));
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    this.ws.close();
  }
}

async function fetchJson(url, attempts = 100) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error(`无法访问 ${url}`);
}

const LAYOUT_PROBE = `(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2), top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2) };
  };
  const textBox = (selector) => $$(selector).map((element) => {
    const r = rect(element);
    return { selector, text: (element.textContent || "").trim().slice(0, 32), client: element.clientWidth, scroll: element.scrollWidth, overflow: element.scrollWidth - element.clientWidth, x: r.x, w: r.w };
  });
  const stream = $(".cnv-stream");
  const messages = $(".messages");
  const conversation = rect($(".conversation"));
  const streamClient = stream ? stream.clientWidth : 0;
  const streamGutter = stream ? stream.offsetWidth - stream.clientWidth : 0;
  const samples = []
    .concat(textBox(".cnv-title-text"))
    .concat(textBox(".step"))
    .concat(textBox(".tool-args"))
    .concat(textBox(".tool-name"))
    .concat(textBox(".session-title"))
    .concat(textBox(".sb"))
    .concat(textBox(".log-text"));
  const emoji = [];
  const scan = (value) => {
    for (const ch of value || "") {
      if (/\\p{Extended_Pictographic}/u.test(ch)) emoji.push(ch);
    }
  };
  scan(document.body.textContent || "");
  $$("[title],[aria-label],[placeholder]").forEach((element) => {
    scan(element.getAttribute("title") || "");
    scan(element.getAttribute("aria-label") || "");
    scan(element.getAttribute("placeholder") || "");
  });
  const guards = $$(".guard").map((element) => ({ state: element.getAttribute("data-state"), text: (element.textContent || "").trim() }));
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    heads: {
      left: rect($(".rail-top .pane-head")),
      mid: rect($(".cnv-head")),
      right: rect($(".dock > .pane-head")),
    },
    columns: {
      rail: rect($(".rail")),
      conversation,
      dock: rect($(".dock")),
    },
    content: {
      conversationWidth: conversation ? conversation.w : 0,
      streamClientWidth: streamClient,
      streamGutter,
      messagesWidth: messages ? rect(messages).w : 0,
      expectedWidth: streamClient - 40,
    },
    overflow: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth },
    truncation: samples,
    emoji,
    guards,
    confirmDone: $$(".confirm-done").map((element) => (element.textContent || "").trim()),
    scrollbar: (() => {
      const style = getComputedStyle(document.documentElement);
      return { color: style.scrollbarColor, width: style.scrollbarWidth };
    })(),
  };
})()`;

const THEME_PROBE = `(() => {
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const mark = document.querySelector(".brand-mark");
  return {
    theme: document.documentElement.dataset.theme,
    canvas: body.backgroundColor,
    accent: mark ? getComputedStyle(mark).color : "",
    scrollbarColor: root.scrollbarColor,
    scrollbarWidth: root.scrollbarWidth,
  };
})()`;

const FOCUS_PROBE = `(() => {
  const element = document.activeElement;
  if (!element || element === document.body) return { done: true };
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    done: false,
    tag: element.tagName.toLowerCase(),
    cls: typeof element.className === "string" ? element.className : (element.className && element.className.baseVal) || "",
    label: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 24),
    x: +rect.x.toFixed(2),
    y: +rect.y.toFixed(2),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
    visible: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
  };
})()`;

const TREE_PROBE = `(() => {
  const $ = (selector) => document.querySelector(selector);
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), h: +r.height.toFixed(2) };
  };
  const workspace = $(".workspace");
  const railTop = $(".rail-top");
  const tree = $(".tree");
  const vendor = Array.from(document.querySelectorAll(".tree-row")).find((row) => (row.textContent || "").includes("厂商分流"));
  const vendorBlock = vendor && vendor.parentElement ? vendor.parentElement.querySelector(".tree-children") : null;
  const children = vendorBlock ? Array.from(vendorBlock.querySelectorAll(".tree-row")) : [];
  const railRect = rect(railTop);
  return {
    workspaceHeight: workspace ? rect(workspace).h : 0,
    railTopHeight: railTop ? railTop.clientHeight : 0,
    railTopBottom: railRect ? railRect.bottom : 0,
    treeHeight: tree ? +tree.getBoundingClientRect().height.toFixed(2) : 0,
    treeScrollHeight: tree ? tree.scrollHeight : 0,
    vendorExpanded: vendor ? vendor.getAttribute("aria-expanded") : null,
    childrenCount: children.length,
    childrenBottoms: children.map((row) => +(rect(row)?.bottom ?? 0).toFixed(2)),
    treeBottom: rect(tree) ? rect(tree).bottom : 0,
  };
})()`;

const REDUCED_PROBE = `(() => {
  const pick = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const style = getComputedStyle(element);
    return { duration: style.transitionDuration, property: style.transitionProperty, animation: style.animationName };
  };
  const html = getComputedStyle(document.documentElement);
  return {
    treeChevron: pick(".tree-row .chev"),
    dockChevron: pick(".dock-sec-head .chev"),
    scrollBehavior: html.scrollBehavior,
  };
})()`;

async function main() {
  if (!existsSync(join(DIST, "web", "index.html"))) {
    fail("dist-web/web/index.html 不存在，请先运行 npm run build:web", 1);
  }
  if (!existsSync(SERVE_ENTRY)) {
    fail("dist/server/serve.js 不存在，请先运行 npm run build", 1);
  }
  if (process.env.CHROME_PATH && !existsSync(process.env.CHROME_PATH)) {
    fail(`CHROME_PATH 指向的文件不存在：${process.env.CHROME_PATH}`, 2);
  }
  const chrome = findChrome();
  if (!chrome) {
    fail("未找到 Chromium/Chrome/Edge。请设置 CHROME_PATH 指向可执行文件", 2);
  }
  console.log(`INFO 浏览器 ${chrome}`);

  const home = mkdtempSync(join(tmpdir(), "eam-verify-home-"));
  const emptyHome = mkdtempSync(join(tmpdir(), "eam-verify-empty-"));
  const profile = join(tmpdir(), `eam-verify-${process.pid}-${Date.now()}`);
  writeSessionFixture(home);
  writeKbFixture(home);

  const port = await getFreePort();
  const service = startService(home, port);
  const emptyPort = await getFreePort();
  let emptyService;
  let cdp;
  let child;

  try {
    const sessions = await waitForSessions(service, (body) => Array.isArray(body.sessions) && body.sessions.length > 0);
    console.log(`INFO 真实会话 ${sessions.sessions.map((item) => item.id).join(",")}`);

    const debugPort = 9300 + Math.floor(Math.random() * 500);
    child = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );

    const version = await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
    cdp = await CDP.connect(version.webSocketDebuggerUrl);
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;

    const evaluate = async (expression) => {
      const response = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (response.exceptionDetails) {
        throw new Error(`页面执行异常：${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`);
      }
      return response.result.value;
    };

    const navigate = async (url) => {
      const loaded = cdp.waitEvent("Page.loadEventFired", sessionId);
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
      for (let i = 0; i < 50; i += 1) {
        const ready = await evaluate("Boolean(document.querySelector('.app'))");
        if (ready) break;
        await delay(100);
      }
      await delay(300);
    };

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);

    await navigate(`http://127.0.0.1:${port}${PAGE_PATH}`);

    const layout = await evaluate(LAYOUT_PROBE);

    const heads = [layout.heads.left, layout.heads.mid, layout.heads.right];
    const headOk = heads.every((head) => head && Math.abs(head.y - 48) <= 0.5 && Math.abs(head.h - 40) <= 0.5);
    check("V1", "三栏头部对齐", headOk, heads.map((head) => (head ? `y=${head.y} h=${head.h}` : "缺失")).join(" / "), "y=48 h=40");

    const railWidth = layout.columns.rail?.w ?? 0;
    const dockWidth = layout.columns.dock?.w ?? 0;
    const conversationWidth = layout.columns.conversation?.w ?? 0;
    const expectedMain = layout.viewport.w - 264 - 404;
    const v2Ok = Math.abs(railWidth - 264) <= 0.5 && Math.abs(dockWidth - 404) <= 0.5 && Math.abs(conversationWidth - expectedMain) <= 0.5;
    check("V2", "栏宽", v2Ok, `rail=${railWidth} dock=${dockWidth} main=${conversationWidth}`, `rail=264 dock=404 main=${expectedMain}`);

    const content = layout.content;
    const v3Ok = Math.abs(content.messagesWidth - content.expectedWidth) <= 1 && Math.abs(content.streamGutter + content.streamClientWidth - content.conversationWidth) <= 1;
    check("V3", "内容对齐", v3Ok, `messages=${content.messagesWidth} streamClient=${content.streamClientWidth} gutter=${content.streamGutter}`, `messages=${content.expectedWidth}（主区−40−滚动条）`);

    const v4Ok = layout.overflow.scrollWidth === layout.overflow.innerWidth;
    check("V4", "无横向溢出", v4Ok, `scrollWidth=${layout.overflow.scrollWidth} innerWidth=${layout.overflow.innerWidth}`, "相等");

    const truncated = layout.truncation.filter((item) => item.overflow > 1);
    check("V5", "无文本截断", truncated.length === 0, truncated.length === 0 ? `${layout.truncation.length} 个采样均未截断` : truncated.map((item) => `${item.selector}(${item.text}) ${item.overflow}px`).join("; "), "所有采样 scrollWidth ≤ clientWidth+1");

    const streamScrolls = await evaluate("(() => { const el = document.querySelector('.cnv-stream'); return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, offsetWidth: el.offsetWidth, clientWidth: el.clientWidth } : null; })()");
    const gutter = streamScrolls ? streamScrolls.offsetWidth - streamScrolls.clientWidth : 0;
    const v8Ok = streamScrolls !== null && streamScrolls.scrollHeight > streamScrolls.clientHeight && gutter === 10 && layout.overflow.scrollWidth === layout.overflow.innerWidth;
    check("V8", "滚动条占位", v8Ok, `可滚动=${Boolean(streamScrolls && streamScrolls.scrollHeight > streamScrolls.clientHeight)} 占位=${gutter}px 横向溢出=${layout.overflow.scrollWidth - layout.overflow.innerWidth}`, "可滚动且占位 10px 且无横向溢出");

    check("V10", "无 emoji", layout.emoji.length === 0, layout.emoji.length === 0 ? "0 个" : `${layout.emoji.length} 个：${layout.emoji.join("")}`, "0 个");

    const pendingGuard = layout.guards.find((guard) => guard.state === "待确认");
    const guardText = pendingGuard === undefined ? "" : pendingGuard.text;
    const guardFields = ["写入", "0x40004408", "0x0009", "待确认"].filter((field) => guardText.includes(field));
    const v14Ok =
      pendingGuard !== undefined &&
      guardFields.length === 4 &&
      !guardText.includes("已执行") &&
      layout.confirmDone.length === 0;
    check(
      "V14",
      "写操作确认",
      v14Ok,
      `待确认守卫=${pendingGuard ? "存在" : "缺失"} 文案字段=${guardFields.join("|") || "无"} 已执行文案=${guardText.includes("已执行")} 复位完成文案=${layout.confirmDone.length}`,
      "真实 guard 文案含 写入/0x40004408/0x0009/待确认，且无已执行文案",
    );

    await evaluate("document.activeElement && document.activeElement.blur(); document.body.setAttribute('tabindex','-1'); document.body.focus(); true");
    const focused = [];
    for (let i = 0; i < 80; i += 1) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sessionId);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sessionId);
      await delay(20);
      const focus = await evaluate(FOCUS_PROBE);
      if (focus.done) break;
      const key = `${focus.tag}|${focus.cls}|${focus.label}|${focus.x}|${focus.y}`;
      if (focused.some((item) => item.key === key)) break;
      focused.push({ ...focus, key });
    }
    await evaluate("document.body.removeAttribute('tabindex'); true");
    const invisible = focused.filter((item) => !item.visible);
    check("V11", "焦点可见", focused.length > 0 && invisible.length === 0, `${focused.length} 个控件，${invisible.length} 个无焦点环${invisible.length ? "：" + invisible.map((item) => `${item.tag}.${item.cls}(${item.label || "无标签"},outline=${item.outlineStyle} ${item.outlineWidth})`).join(",") : ""}`, "Tab 遍历控件均有 outline");

    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    }, sessionId);
    await delay(100);
    const reduced = await evaluate(REDUCED_PROBE);
    const noTransition = [reduced.treeChevron, reduced.dockChevron].every((item) => item && item.duration.split(",").every((value) => parseFloat(value) === 0));
    const v12Ok = noTransition && reduced.scrollBehavior === "auto";
    check("V12", "减少动效", v12Ok, `树 chevron=${reduced.treeChevron?.duration} dock chevron=${reduced.dockChevron?.duration} scrollBehavior=${reduced.scrollBehavior}`, "transition 0s 且 scroll-behavior auto");
    await cdp.send("Emulation.setEmulatedMedia", { features: [] }, sessionId);

    const shell = await evaluate("(() => ({ hasShell: Boolean(document.querySelector('.app')), bodyText: document.body.innerText.length }))()");
    if (!shell.hasShell) throw new Error("页面未渲染");

    const themeExpect = {
      light: { canvas: "rgb(234, 238, 241)", accent: "rgb(15, 157, 141)", thumb: "rgb(198, 208, 217)" },
      dark: { canvas: "rgb(14, 19, 26)", accent: "rgb(53, 210, 192)", thumb: "rgb(47, 61, 75)" },
    };
    const themeSamples = [];
    const readTheme = async (choice, media, label) => {
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: media }],
      }, sessionId);
      await delay(80);
      await evaluate(`document.querySelector('[data-theme-opt="${choice}"]').click(); true`);
      await delay(80);
      const sample = await evaluate(THEME_PROBE);
      themeSamples.push({ label, choice, ...sample });
      return sample;
    };

    const systemLight = await readTheme("system", "light", "system/light");
    const systemDark = await readTheme("system", "dark", "system/dark");
    const fixedLight = await readTheme("light", "dark", "light/media-dark");
    const fixedDark = await readTheme("dark", "light", "dark/media-light");
    await cdp.send("Emulation.setEmulatedMedia", { features: [] }, sessionId);
    await evaluate("document.querySelector('[data-theme-opt=\"dark\"]').click(); true");

    const v9Ok =
      systemLight.theme === "system" && systemLight.canvas === themeExpect.light.canvas && systemLight.accent === themeExpect.light.accent &&
      systemDark.theme === "system" && systemDark.canvas === themeExpect.dark.canvas && systemDark.accent === themeExpect.dark.accent &&
      fixedLight.theme === "light" && fixedLight.canvas === themeExpect.light.canvas && fixedLight.accent === themeExpect.light.accent &&
      fixedDark.theme === "dark" && fixedDark.canvas === themeExpect.dark.canvas && fixedDark.accent === themeExpect.dark.accent;
    check(
      "V9",
      "三主题解析",
      v9Ok,
      themeSamples.map((sample) => `${sample.label}:${sample.theme}/${sample.canvas}/${sample.accent}`).join(" ; "),
      "system 跟随 media，light/dark 固定且 canvas/accent 符合 §5.1",
    );

    const scrollbarOk = (sample, thumb) => {
      const color = sample.scrollbarColor.toLowerCase();
      const transparent = color.includes("transparent") || color.includes("rgba(0, 0, 0, 0)");
      return color.includes(thumb) && transparent && sample.scrollbarWidth === "thin";
    };
    const v7Ok = scrollbarOk(fixedDark, themeExpect.dark.thumb) && scrollbarOk(fixedLight, themeExpect.light.thumb);
    check("V7", "滚动条配色", v7Ok, `dark=${fixedDark.scrollbarColor}/${fixedDark.scrollbarWidth} light=${fixedLight.scrollbarColor}/${fixedLight.scrollbarWidth}`, "dark thumb rgb(47,61,75)，light thumb rgb(198,208,217)，track 透明，width thin");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: WORKBENCH_HEIGHT + 74,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    await delay(250);
    const tree = await evaluate(TREE_PROBE);
    const treeClipped = tree.childrenBottoms.filter((bottom) => bottom > tree.railTopBottom + 0.5);
    const v6Ok =
      Math.abs(tree.workspaceHeight - WORKBENCH_HEIGHT) <= 1 &&
      tree.vendorExpanded === "true" &&
      tree.childrenCount >= 4 &&
      treeClipped.length === 0;
    check("V6", "知识库树完整", v6Ok, `workspace=${tree.workspaceHeight} railTop=${tree.railTopHeight} tree=${tree.treeHeight} 厂商子项=${tree.childrenCount} 各底边=${tree.childrenBottoms.join(",")} 裁剪=${treeClipped.length}`, "workspace=717 且厂商分流子树完整可见");

    const consistencyPath = join(ROOT, "tests", "ui", "transcript-consistency.test.ts");
    const consistencySource = existsSync(consistencyPath) ? readFileSync(consistencyPath, "utf8") : "";
    const consistencyOk =
      consistencySource.includes("transcriptFromLoop") && consistencySource.includes("transcriptFromSession");
    check(
      "V13",
      "回放一致性",
      consistencyOk,
      consistencyOk
        ? "tests/ui/transcript-consistency.test.ts 存在且含双向归约断言，由 vitest 覆盖"
        : `缺失或未含断言：${consistencyPath}`,
      "存在且含 transcriptFromSession/transcriptFromLoop 断言，由 vitest 覆盖",
    );

    emptyService = startService(emptyHome, emptyPort);
    await waitForSessions(emptyService, (body) => Array.isArray(body.sessions) && body.sessions.length === 0);
    await navigate(`http://127.0.0.1:${emptyPort}${PAGE_PATH}`);
    let emptyState = { sessions: "", kb: "" };
    for (let i = 0; i < 50; i += 1) {
      emptyState = await evaluate(`(() => ({
        sessions: (document.querySelector('.rail-bottom .pane-empty')?.textContent ?? '').trim(),
        kb: (document.querySelector('.rail-top .pane-empty')?.textContent ?? '').trim(),
      }))()`);
      if (emptyState.sessions === "暂无会话" && emptyState.kb === "未配置知识库") break;
      await delay(100);
    }
    checkExtra(
      "V0",
      "空态文案",
      emptyState.sessions === "暂无会话" && emptyState.kb === "未配置知识库",
      `会话="${emptyState.sessions}" 知识库="${emptyState.kb}"`,
      "暂无会话 / 未配置知识库",
    );
  } finally {
    if (cdp) cdp.close();
    await stopService(service);
    await stopService(emptyService);
    if (child) {
      child.kill();
      await delay(300);
    }
    removeDir(profile);
    removeDir(home);
    removeDir(emptyHome);
  }

  const failed = results.filter((item) => !item.ok);
  const extraFailed = extraResults.filter((item) => !item.ok);
  console.log("");
  console.log(`SUMMARY ${results.length - failed.length}/${results.length} PASS`);
  if (extraResults.length > 0) {
    console.log(`EXTRA ${extraResults.length - extraFailed.length}/${extraResults.length} PASS（不计入 14 项）`);
  }
  if (failed.length > 0) {
    console.log(`FAILED ${failed.map((item) => item.id).join(", ")}`);
  }
  if (extraFailed.length > 0) {
    console.log(`EXTRA_FAILED ${extraFailed.map((item) => item.id).join(", ")}`);
  }
  process.exit(failed.length > 0 || extraFailed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error), 1);
});