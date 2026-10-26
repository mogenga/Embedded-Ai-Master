import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 主进程脚本的**作用域**回归测试。
 *
 * 背景（2026-10-26 线上缺陷）：`app.on("window-all-closed", …)` 在**模块作用域**
 * 里调了 `stopHost()`，而 `stopHost` 是 `startWindow` 里的内部函数。关窗时抛
 * `ReferenceError: stopHost is not defined`（Electron 弹「A JavaScript error
 * occurred in the main process」），**后面的 `app.quit()` 从未被安排**——主进程
 * 无窗口挂着不退，单实例锁又让再次启动静默退出，用户只能去任务管理器杀进程。
 *
 * 这类错误 `tsc --noEmit` 看不见（`main.js` 是纯 JS，不在 `tsconfig.json` 的
 * `include` 里），也没有任何运行时测试覆盖 `main.js`（它 `import { app } from
 * "electron"`，在 vitest 里加载不了）。所以这里用**静态解析**补上这一层：
 *
 *   1. 按大括号配对切出 `startWindow` 的函数体；
 *   2. 剩下的部分就是模块作用域；
 *   3. 收集模块作用域里所有**裸标识符调用**（排除 `x.foo(` 这种成员调用与关键字）；
 *   4. 断言每一个都在「模块作用域已声明 / 已 import / 运行时全局」里。
 *
 * 它抓的是**一整类**错误，不只是 `stopHost`：将来谁在 `app.on(...)` 里调一个
 * 窗口作用域的函数，都会在这里红。已声明的名字是**从文件里解析出来的**，不是
 * 手写白名单——加一个 import 不需要同步改测试。
 *
 * 局限（如实写明）：文本级分析，不做词法作用域推导。注释与字符串内容会被清空
 * （保持字符位置不变，便于结构正则），所以 `"foo("` 这类内容不会造成假阳性；
 * 但模板字符串里的 `${ … }` 不展开——当前 `main.js` 的模块作用域没有这种插值。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.resolve(HERE, "../../desktop/main.js");

/** JS 关键字/运算符：正则会把 `if (` / `async (` / `new X(` 也当成「调用」。 */
const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "catch",
  "finally",
  "try",
  "function",
  "return",
  "typeof",
  "instanceof",
  "new",
  "delete",
  "void",
  "async",
  "await",
  "yield",
  "throw",
]);

/** 运行时全局（Node / V8 自带，任何作用域都够得着）。 */
const RUNTIME_GLOBALS = new Set([
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "setImmediate",
  "queueMicrotask",
  "JSON",
  "process",
  "console",
  "Buffer",
  "URL",
  "Set",
  "Map",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "function",
]);

/**
 * 把注释与（可选的）字符串内容替换成空格，**保留换行与全部字符位置**。
 *
 * 两份视图，用途不同，缺一不可：
 *
 * - `blankComments(raw)` —— 注释清空、**字符串保留**。结构定位（`win.on("closed"`）
 *   要能读到 `"closed"` 这几个字，所以字符串内容必须留着。
 * - `blankComments(blankComments(raw))` 不行；调用分析要连字符串内容一起清掉，
 *   否则 `"…kill()…"` 这样的字面量会被当成一次调用。这个视图由 `forCalls` 提供。
 *
 * 位置不变是刻意的：`findFunctionBody` / `findCallbackBody` 在切片上工作，长度
 * 一改下标就错位。
 */
function blankComments(source, { blankStrings = false } = {}) {
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      while (index < source.length && source[index] !== "\n") {
        out[index] = " ";
        index += 1;
      }
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let i = index; i < stop; i += 1) {
        if (out[i] !== "\n") out[i] = " ";
      }
      index = stop;
      continue;
    }
    if (source[index] === '"' || source[index] === "'" || source[index] === "`") {
      const quote = source[index];
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          if (blankStrings) out[index] = " ";
          index += 1;
        }
        if (index < source.length) {
          out[index] = blankStrings && source[index] !== "\n" ? " " : source[index];
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/** 从 `function NAME(` 开始，跳过参数表（可能含 `{}` 默认值），再按大括号配对取函数体。 */
function findFunctionBody(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (match === null) return null;
  // 1. 跨过参数表：按圆括号配对，参数默认值里可能有 `{}` / `()`。
  let index = source.indexOf("(", match.index);
  let parenDepth = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === "(") parenDepth += 1;
    else if (source[index] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        index += 1;
        break;
      }
    }
  }
  // 2. 参数表之后第一个 `{` 才是函数体（跳过 `: Type` 之类的 TS 残留，本文件没有）。
  const bodyStart = source.indexOf("{", index);
  if (bodyStart === -1) return null;
  let depth = 0;
  for (let cursor = bodyStart; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return [bodyStart + 1, cursor];
    }
  }
  return null;
}

/**
 * 取某个记号之后的回调函数体（`marker` 后第一个 `{` 到配对的 `}`）。
 *
 * 用大括号配对而不是正则：回调体里还会嵌套 `{ … }`（`if`、对象字面量），
 * 非贪婪正则到第一个 `});` 就断，会切出半截。
 *
 * @returns {string | null}
 */
function findCallbackBody(source, marker) {
  const at = source.indexOf(marker);
  if (at === -1) return null;
  const braceStart = source.indexOf("{", at + marker.length);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let cursor = braceStart; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, cursor);
    }
  }
  return null;
}

/** 收集源码里的裸标识符调用（`name(`，且前面最近的非空白字符不是 `.`）。 */
function collectCalls(source) {
  const calls = new Set();
  const pattern = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    let before = match.index - 1;
    while (before >= 0 && /\s/.test(source[before])) before -= 1;
    if (before >= 0 && source[before] === ".") continue;
    const name = match[1];
    if (KEYWORDS.has(name)) continue;
    calls.add(name);
  }
  return calls;
}

/** 把 `startWindow` 的函数体挖掉，剩下的就是模块作用域。 */
function moduleScopeSource(source) {
  const body = findFunctionBody(source, "startWindow");
  expect(body, "main.js 里找不到 startWindow 的函数体，测试的前提已失效").not.toBeNull();
  const [start, end] = body;
  return source.slice(0, start) + source.slice(end);
}

/**
 * 模块作用域里「够得着」的名字：import 进来的 + 在模块作用域内任意深度声明的。
 *
 * **为什么不限第一层**：模块作用域里还有回调（`app.on(...)`、`for (const stop of …)`），
 * 它们内部声明的名字在那段回调里是合法的。只看第一层会把 `for (const stop of
 * hostStoppers) stop()` 里的 `stop` 误判成未声明——那个误判真的发生过。
 *
 * 代价：某个分支里声明过的名字，在另一个分支里被调用时也会放过。这是刻意的放宽：
 * 本测试要抓的是「调用了 `startWindow` 内部才有的函数」（`stopHost` 就是），而那类
 * 名字**整份模块作用域里都不存在**，因为它们在 `startWindow` 的函数体里，已被挖掉。
 */
function moduleScopeNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  // `for (const stop of …)` 上面那条已经覆盖（`const stop` 就在文本里）。
  // 解构：`const { a, b } = x` / `const [a, b] = x`
  for (const match of source.matchAll(/\bconst\s*\{([^}]*)\}\s*=/g)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().split(":").pop().trim();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/\bconst\s*\[([^\]]*)\]\s*=/g)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

describe("desktop/main.js 的作用域", () => {
  const raw = readFileSync(MAIN_JS, "utf8");
  /** 结构视图：注释清空，字符串保留（定位 `"closed"` / `"window-all-closed"` 要用）。 */
  const code = blankComments(raw);
  /** 调用视图：字符串内容也清空，避免字面量里的 `kill()` 被当成调用。 */
  const forCalls = blankComments(raw, { blankStrings: true });

  it("能切出 startWindow 的函数体（否则后面的断言没有意义）", () => {
    const body = findFunctionBody(code, "startWindow");
    expect(body).not.toBeNull();
    const inside = code.slice(body[0], body[1]);
    expect(inside).toContain("new BrowserWindow");
    expect(inside).toContain("function stopHost");
    // 切出来的必须真的止于 startWindow 的结尾，而不是被参数默认值提前截断
    expect(inside.length).toBeGreaterThan(4000);
  });

  it("模块作用域不调用 startWindow 里的内部函数", () => {
    const scope = moduleScopeSource(forCalls);
    // 判「声明了没有」也要在调用视图上做：`const NAME = "x"` 里的字符串不影响名字
    const reachable = new Set([...moduleScopeNames(scope), ...RUNTIME_GLOBALS]);
    const offenders = [...collectCalls(scope)].filter((name) => !reachable.has(name)).sort();
    expect(
      offenders,
      `模块作用域调用了未在模块作用域声明/导入的标识符：${offenders.join(", ")}。` +
        "它们在运行时是 ReferenceError，而 tsc 看不到（main.js 是纯 JS，不在 tsconfig include 里）。" +
        "正确做法是把逻辑放进 startWindow 内的监听器，或把函数提到模块作用域。",
    ).toEqual([]);
  });

  it("stopHost 不在模块作用域被调用（这条缺陷的直接回归）", () => {
    const scope = moduleScopeSource(forCalls);
    expect(collectCalls(scope).has("stopHost")).toBe(false);
  });

  it("stopHost 仍在 startWindow 内部被调用（否则关窗不再停宿主，孤儿进程会回来）", () => {
    const body = findFunctionBody(forCalls, "startWindow");
    const inside = forCalls.slice(body[0], body[1]);
    expect(collectCalls(inside).has("stopHost")).toBe(true);
  });

  it("window-all-closed 里安排了 app.quit（否则主进程不退出）", () => {
    const scope = moduleScopeSource(code);
    const handler = findCallbackBody(scope, 'app.on("window-all-closed"');
    expect(handler, "找不到 window-all-closed 的处理器").not.toBeNull();
    expect(handler).toContain("app.quit()");
  });

  it("window-all-closed 只在非 darwin 上退出（macOS 关窗不结束应用）", () => {
    const scope = moduleScopeSource(code);
    const handler = findCallbackBody(scope, 'app.on("window-all-closed"');
    expect(handler, "找不到 window-all-closed 的处理器").not.toBeNull();
    expect(handler).toContain('process.platform !== "darwin"');
  });

  it("每个窗口的 closed 处理器都会停宿主（这是 window-all-closed 不再停它的前提）", () => {
    const body = findFunctionBody(code, "startWindow");
    const inside = code.slice(body[0], body[1]);
    const closedHandler = findCallbackBody(inside, 'win.on("closed"');
    expect(closedHandler, '找不到 win.on("closed") 的处理器').not.toBeNull();
    expect(closedHandler).toContain("stopHost()");
  });
});
