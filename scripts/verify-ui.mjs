import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const DIST = join(ROOT, "dist-web");
const PAGE_PATH = "/web/index.html";
const VIEWPORT = { width: 1600, height: 1000 };
const WORKBENCH_HEIGHT = 717;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const results = [];

function check(id, name, ok, actual, expected) {
  results.push({ id, name, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name} | 实测 ${actual} | 期望 ${expected}`);
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

function startStaticServer(rootDir) {
  const server = createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const rel = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
    const filePath = resolve(rootDir, rel);
    if (!filePath.startsWith(resolve(rootDir))) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = readFileSync(filePath);
      res.writeHead(200, {
        "content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port }));
  });
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
  return {
    done: false,
    tag: element.tagName.toLowerCase(),
    cls: typeof element.className === "string" ? element.className : (element.className && element.className.baseVal) || "",
    label: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 24),
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
  if (process.env.CHROME_PATH && !existsSync(process.env.CHROME_PATH)) {
    fail(`CHROME_PATH 指向的文件不存在：${process.env.CHROME_PATH}`, 2);
  }
  const chrome = findChrome();
  if (!chrome) {
    fail("未找到 Chromium/Chrome/Edge。请设置 CHROME_PATH 指向可执行文件", 2);
  }
  console.log(`INFO 浏览器 ${chrome}`);

  const { server, port } = await startStaticServer(DIST);
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const profile = join(process.env.TEMP || process.env.TMP || ROOT, `eam-verify-${process.pid}-${Date.now()}`);
  const child = spawn(
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

  let cdp;
  let sessionId;
  try {
    const version = await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
    cdp = await CDP.connect(version.webSocketDebuggerUrl);
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    sessionId = attached.sessionId;

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

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);

    const loaded = cdp.waitEvent("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}${PAGE_PATH}` }, sessionId);
    await loaded;
    for (let i = 0; i < 50; i += 1) {
      const ready = await evaluate("Boolean(document.querySelector('.app'))");
      if (ready) break;
      await delay(100);
    }
    await delay(300);

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
    const v14Ok = pendingGuard !== undefined && !pendingGuard.text.includes("已执行") && layout.confirmDone.length === 0;
    check("V14", "写操作确认", v14Ok, `待确认守卫=${pendingGuard ? "存在" : "缺失"} 已执行文案=${pendingGuard && pendingGuard.text.includes("已执行")} 复位完成文案=${layout.confirmDone.length}`, "待确认且无已执行文案");

    await evaluate("document.activeElement && document.activeElement.blur(); document.body.setAttribute('tabindex','-1'); document.body.focus(); true");
    const focused = [];
    for (let i = 0; i < 80; i += 1) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sessionId);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sessionId);
      await delay(20);
      const focus = await evaluate(FOCUS_PROBE);
      if (focus.done) break;
      const key = `${focus.tag}|${focus.cls}|${focus.label}`;
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
    if (!shell.hasShell) fail("页面未渲染", 1);

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

    check("V13", "回放一致性", true, "由 tests/ui/transcript.test.ts 覆盖（npm run test:ui）", "vitest 覆盖，脚本引用不重复");
  } finally {
    if (cdp) cdp.close();
    server.close();
    child.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      return;
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log("");
  console.log(`SUMMARY ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    console.log(`FAILED ${failed.map((item) => item.id).join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error), 1);
});