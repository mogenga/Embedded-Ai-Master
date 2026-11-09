import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGalaxyEffort } from "../../desktop/renderer/galaxy-effort.js";

/**
 * 脑形滑块的组件本体（`docs/specs/galaxy-effort-slider.md` §1–§4、§6）。
 *
 * 仓库没有 jsdom，也不打算为此引入依赖。所以这里能诚实断言的只有两类：
 *
 * 1. **导出与顶层纯度**：模块能被 Node 静态 import，且顶层不碰 DOM。
 * 2. **接线**：读源码文本，断言那些"少了就会静默坏掉"的东西确实在——指针捕获、
 *    `aria-*`、冒泡且 composed 的自定义事件、`destroy` 里逐个释放、CSS 的关键
 *    数值与前缀。
 *
 * **这些静态断言不能证明的东西，写在这里免得有人把绿灯读成"控件能用"**：脑形
 * 长出来的样子、粒子在不在流、拖拽手感、震动幅度、拆字动画的观感，以及
 * `pointerdown → pointermove → pointerup` 这条链在真实浏览器里的行为。那些只有
 * 真窗口能验，本文件不假装覆盖。
 *
 * 纯函数（弹簧、褶皱揭示、色板插值、Galaxy 派生量）在
 * `galaxy-effort-core.test.js`，两个 Canvas 图层在 `galaxy-effort-layers.test.js`
 * ——它们不在这里重测。
 */

const ROOT = path.join(import.meta.dirname, "..", "..");
const RENDERER = path.join(ROOT, "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

const SOURCE = read("galaxy-effort.js");
const CSS = read("galaxy-effort.css");

/**
 * 去掉注释后的源码。
 *
 * 注释里提到 `document` 是在**解释**为什么不能碰它，不是碰了它。按纯文本搜索
 * 会把说明当成违规，于是唯一让检查变绿的办法是删掉解释——那正好删掉最有用的
 * 部分。这个做法与 `galaxy-effort-core.test.js` 一致。
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** 指标识别符（含 `.`）——用来找"这个词作为标识符出现"，而不是出现在注释里。 */
const identifier = (name) => new RegExp(`(^|[^\\w.$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);

/**
 * 模块顶层会**在 import 求值时执行**的那些行。
 *
 * 判据是行首缩进：本文件顶层语句全部从第 0 列开始，函数体一律缩进。所以"行首
 * 没有空白的行"就是求值期会跑到的语句——常量声明、`export function` 的签名，
 * 以及（如果哪天有人加的话）一句 `document.createElement`。函数里怎么用 DOM 都
 * 不算数：那些行要么缩进、要么是跨行的参数表。
 *
 * 不去做真正的作用域分析：这个文件的手写结构就是这个形状，而判据正是要防的
 * 那件事本身。
 */
function topLevelLines() {
  return CODE.split("\n").filter((line) => line !== "" && !/^[ \t]/.test(line));
}

/**
 * 把字符串字面量的**内容**换成空格，长度与换行保持不变。
 *
 * 只为了下面那条常量检查服务：剥离之后剩下的标识符才是"代码里引用了谁"。
 * 模板字面量的 `${…}` 是表达式而不是文本，所以它被原样保留（含其中嵌套的
 * 字符串，递归处理）。
 */
function stripStrings(source) {
  let out = "";
  let index = 0;
  /** 从 `index` 处的引号开始，跳过整个字面量；返回结束后的位置。 */
  function skipQuoted(quote, allowNewline) {
    let cursor = index + 1;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "\\") { cursor += 2; continue; }
      if (char === quote) return cursor + 1;
      if (char === "\n" && !allowNewline) return cursor;
      cursor += 1;
    }
    return cursor;
  }
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      const end = skipQuoted(char, false);
      // 保留换行，否则下面的行结构会变（这里其实不按行看，但保持一致）。
      out += source.slice(index, end).replace(/[^\n]/g, " ");
      index = end;
      continue;
    }
    if (char === "`") {
      out += "`";
      index += 1;
      while (index < source.length && source[index] !== "`") {
        if (source[index] === "\\") { out += "  "; index += 2; continue; }
        if (source[index] === "$" && source[index + 1] === "{") {
          // 插值：原样保留其中的表达式（含里面的字符串剥离）。
          let depth = 1;
          let cursor = index + 2;
          const start = cursor;
          while (cursor < source.length && depth > 0) {
            const inner = source[cursor];
            if (inner === "\\") { cursor += 2; continue; }
            if (inner === "{") depth += 1;
            else if (inner === "}") depth -= 1;
            if (depth > 0) cursor += 1;
          }
          out += ` ${stripStrings(source.slice(start, cursor))} `;
          index = cursor + 1;
          continue;
        }
        out += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      out += "`";
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

const cssHas = (needle) => CSS.includes(needle);

describe("导出与顶层纯度", () => {
  it("createGalaxyEffort 是函数", () => {
    expect(typeof createGalaxyEffort).toBe("function");
  });

  it("顶层不碰 document / window / requestAnimationFrame", () => {
    // 静态 import 本文件的是 Node 里的测试进程，那里没有 DOM。顶层一句
    // `document.createElement` 会让所有 import 它的测试在加载期就炸，报错指的
    // 是 import 行而不是那行 DOM 代码——排查成本全在这里。
    const top = topLevelLines().join("\n");
    expect(top.length, "顶层为空说明判据本身坏了").toBeGreaterThan(200);
    for (const name of ["document", "window", "requestAnimationFrame", "performance"]) {
      expect(identifier(name).test(top), `顶层出现了 ${name}`).toBe(false);
    }
  });

  it("DOM 的使用全部发生在函数体内", () => {
    // 反向证据：函数体里确实在用它们——否则上一条可以用"整个文件都不碰 DOM"
    // 通过，而那样的实现根本画不出东西。
    const body = CODE.slice(CODE.indexOf("export function createGalaxyEffort"));
    expect(body).toContain("document.");
    expect(body).toContain("requestAnimationFrame");
  });

  it("常量既都有声明、也都真的被用到（`node --check` 抓不到这两类）", () => {
    // 实测抓到了一个真的：`TRACK_START_X` / `TRACK_END_X` 在刻度布局里被用了，
    // 但从来没有声明过。语法检查全绿、测试全绿，控件一创建就 ReferenceError。
    // 这里只查全大写常量名——它们数量有限、来源唯一（模块顶层 const）。
    const declared = new Set(
      [...CODE.matchAll(/^const ([A-Z][A-Z0-9_]*)\s*=/gm)].map((match) => match[1]),
    );
    // 先剥掉字符串内容，否则路径数据（`M30 27Q…`）会被当成常量名。
    //
    // 手写扫描器而不是正则：模板字面量里的 `${TRACK_TOP}px` 是对常量的**真实**
    // 引用，整段删掉会把在用的常量判成死代码；而正则要区分"字面量文本"与
    // "插值表达式"就得数花括号，那已经开始写词法器了。这二十行把三种引号按
    // 实际嵌套处理，比一条"看起来对"的正则可靠。
    const bare = stripStrings(CODE);
    const used = new Set([...bare.matchAll(/(^|[^\w.$])([A-Z][A-Z0-9_]{2,})(?![\w$])/g)]
      .map((match) => match[2]));
    // 上游模块里的常量由它们自己声明；`NaN` 之类是语言内建的。
    const externals = new Set([
      "FOLD_LEVELS", "TIER_NAMES", "PIXEL_PALETTE", "TRACK_PALETTES", "NaN", "Infinity",
    ]);
    const missing = [...used].filter((name) => !declared.has(name) && !externals.has(name));
    expect(missing, `引用了未声明的常量：${missing.join(", ")}`).toStrictEqual([]);

    // 另一半：声明了却没人用。本轮真出现过——`CARD_WIDTH` / `CARD_HEIGHT` 是编辑
    // 中途留下的死常量，语法检查不会说话，测试也不会。它本身无害，但两个同义
    // 数字并存时，改规格的人会先改错那个。
    const unused = [...declared].filter((name) => {
      const references = bare.match(new RegExp(`(^|[^\\w.$])${name}(?![\\w$])`, "g")) ?? [];
      return references.length < 2;
    });
    expect(unused, `声明了但没用到：${unused.join(", ")}`).toStrictEqual([]);
  });

  it("没有模块级的可变状态（同页两个实例才可能互不干扰）", () => {
    // 顶层只允许 `const` / 函数声明 / import。一个模块级 `let` 就是两个实例共享
    // 的变量：典型的后果是一个的 clock 被另一个推着走，或者一个 destroy 之后
    // 另一个再也排不上帧。这类串扰在单实例验收里完全看不出来。
    const top = topLevelLines().join("\n");
    expect(/(^|[^\w.])let\s/.test(top), "顶层出现了 let").toBe(false);
    expect(/(^|[^\w.])var\s/.test(top), "顶层出现了 var").toBe(false);
  });
});

describe("数学与图层都来自上游模块，不在这里重写", () => {
  it("import 了 core 与 layers 的既有导出", () => {
    // 接线的证据：这几个名字必须从上游来。若本文件自己再实现一份 `foldReveal`，
    // 拖拽时脑形与轨道填充就会各按一套公式走——肉眼可见，却抓不住。
    expect(SOURCE).toContain('from "./galaxy-effort-core.js"');
    expect(SOURCE).toContain('from "./galaxy-effort-layers.js"');
    for (const name of [
      "FOLD_LEVELS", "TIER_NAMES", "foldReveal", "galaxyState", "stepSpring",
      "tierIndex", "trackFillOpacity", "trackFillStops", "trackX", "clamp",
    ]) {
      expect(SOURCE, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
    for (const name of ["createPixelLayer", "createRadialLayer"]) {
      expect(SOURCE, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it("真的调用了上游函数，而不只是 import 了名字", () => {
    for (const call of [
      "trackFillStops(", "trackFillOpacity(", "stepSpring(", "galaxyState(",
      "createPixelLayer(", "createRadialLayer(", "foldReveal(", "trackX(",
    ]) {
      expect(CODE, call).toContain(call);
    }
  });

  it("褶皱层逐层取自 FOLD_LEVELS，没有另抄一张路径表", () => {
    expect(CODE).toContain("for (const tier of FOLD_LEVELS)");
    // 主沟是一条 path、三个子路径（规格 §2）。拆成三条后可见路径数会从
    // 2/4/6/8/12/16 变成 4/6/8/10/14/18，而脑形看起来一模一样。
    expect(CODE).toContain('const BRAIN_MAIN_FOLD = "M30 27Q28 35 22 35M10 43Q15 44 17 48M16 12Q13 17 16 20"');
  });

  it("弹簧每帧只调一次 stepSpring（三次子步在它内部）", () => {
    // 来源里 `stepSpring(` 每出现两次就是一对（普通弹簧 + Galaxy 弹簧），
    // 而且都在 `step()` 里。调用方再拆一次等于九个 子步，同一个 k 会走出另一条
    // 曲线——那是"看起来差不多、动起来不一样"的错误。
    const calls = CODE.match(/stepSpring\(/g) ?? [];
    expect(calls).toHaveLength(2);
    const body = bodyOf(SOURCE, "  function step(dt) {");
    expect(body).toContain("POSITION_K");
    expect(body).toContain("POSITION_DAMPING");
    expect(body).toContain("GALAXY_K");
    expect(body).toContain("GALAXY_DAMPING");
  });
});

/**
 * 与 `effort-slider.test.js` 同一条规则：从 `header` 起到本缩进层的 `}` 行止。
 *
 * 头部**去掉自己行首的缩进**再找：带着缩进去找，匹配位置就落在那行缩进的第一个
 * 空格上，`lineStart` 与它重合，缩进算成空串，于是这个函数会把"从这一行到文件
 * 末尾"整段当成函数体——它仍然"通过"，只是断言全部落在错误的文本上。实测这样
 * 会让三条本该红的用例悄悄变绿。
 */
function bodyOf(text, header) {
  const needle = header.replace(/^[ \t]+/, "");
  const start = text.indexOf(needle);
  expect(start, `${header} not found`).toBeGreaterThan(-1);
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const indent = text.slice(lineStart, start);
  expect(indent.trim(), `${header} must start its line`).toBe("");
  let cursor = text.indexOf("\n", start);
  while (cursor !== -1) {
    const next = text.indexOf("\n", cursor + 1);
    const line = text.slice(cursor + 1, next === -1 ? text.length : next);
    if (line.startsWith(`${indent}}`)) return text.slice(start, next === -1 ? text.length : next);
    cursor = next;
  }
  throw new Error(`unterminated ${header}`);
}

describe("指针交互（规格 §3）", () => {
  it("pointerdown 取指针、并做 pointer capture", () => {
    const body = bodyOf(SOURCE, "  function onPointerDown(event) {");
    expect(body).toContain("setPointerCapture");
    // 焦点要跟着按下走：不聚焦的话键盘操作会落在别处，而用户以为自己已经选中了
    // 这个滑块。
    expect(body).toContain("slider.focus()");
  });

  it("pointerup 释放捕获，pointercancel 也释放", () => {
    for (const header of [
      "  function onPointerUp(event) {",
      "  function onPointerCancel(event) {",
    ]) {
      const body = bodyOf(SOURCE, header);
      expect(body, header).toContain("releasePointerCapture");
      expect(body, header).toContain("hasPointerCapture");
    }
  });

  it("重复触摸不抢占：已有指针在拖时，新的 pointerdown 直接返回", () => {
    const body = bodyOf(SOURCE, "  function onPointerDown(event) {");
    expect(body).toContain("activePointer !== null");
    expect(body.indexOf("activePointer !== null")).toBeLessThan(body.indexOf("setPointerCapture"));
  });

  it("touch-action: none 写在命中区上", () => {
    // 不给的话触屏拖动会先被浏览器当成滚动手势，`pointermove` 中途收到取消。
    expect(CODE).toContain('slider.style.touchAction = "none"');
    expect(CSS).toMatch(/\.ge-slider\s*\{[^}]*touch-action:\s*none/);
  });

  it("拖动换算是 (x - 16) / 358 × 5", () => {
    const body = bodyOf(SOURCE, "  function valueAtPointer(event) {");
    expect(body).toContain("(x - 16) / 358");
    expect(body).toContain("LAST_TIER");
  });

  it("拖动中间值不提交；松手才提交", () => {
    const move = bodyOf(SOURCE, "  function onPointerMove(event) {");
    // 规格 §3 的明文：中间值只更新视觉。一次拖拽提交上百次会让宿主排队上百条
    // 命令，而每一条都在改同一个设置。
    expect(move).not.toContain("commit(");
    const up = bodyOf(SOURCE, "  function onPointerUp(event) {");
    expect(up).toContain("commit(");
  });

  it("pointercancel 回到按下时的档位，且不提交", () => {
    const body = bodyOf(SOURCE, "  function onPointerCancel(event) {");
    expect(body).toContain("startTier");
    expect(body).not.toContain("commit(");
  });
});

describe("键盘（规格 §3）", () => {
  const body = bodyOf(SOURCE, "  function onKeyDown(event) {");

  it("六种按键全部接上", () => {
    for (const key of [
      "ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp",
      "Home", "Escape", "End", "PageUp", "PageDown",
    ]) {
      expect(body, key).toContain(`case "${key}"`);
    }
  });

  it("方向键 ±1、PageUp/PageDown ±2、Home/Escape 到 0、End 到 5", () => {
    expect(body).toContain("next = current - 1");
    expect(body).toContain("next = current + 1");
    expect(body).toContain("next = current + 2");
    expect(body).toContain("next = current - 2");
    expect(body).toContain("next = 0");
    expect(body).toContain("next = LAST_TIER");
  });

  it("全部 preventDefault（方向键会滚动页面）", () => {
    expect(body).toContain("event.preventDefault()");
  });

  it("键盘接管时释放指针捕获", () => {
    // 不释放的话，用户已经用键盘选完，抬手时 pointerup 又按指针位置改一次。
    expect(body).toContain("releasePointerCapture");
  });

  it("焦点轮廓 2px #b591ff、offset 4", () => {
    expect(CSS).toMatch(/\.ge-slider:focus-visible\s*\{[^}]*outline:\s*2px solid #b591ff/);
    expect(CSS).toMatch(/\.ge-slider:focus-visible\s*\{[^}]*outline-offset:\s*4px/);
  });
});

describe("无障碍（规格 §3）", () => {
  it("role=slider 与完整的 aria 数值集", () => {
    expect(CODE).toContain('slider.setAttribute("role", "slider")');
    expect(CODE).toContain('slider.setAttribute("tabindex", "0")');
    expect(CODE).toContain('"aria-valuemin", "0"');
    expect(CODE).toContain('"aria-valuemax", String(LAST_TIER)');
    expect(CODE).toContain('slider.setAttribute("aria-valuenow"');
    expect(CODE).toContain('slider.setAttribute("aria-valuetext"');
    expect(CODE).toContain('"aria-orientation", "horizontal"');
  });

  it("aria-valuenow 与 valuetext 在绘制里同步更新", () => {
    // 只在创建时写一次的话，拖到 Galaxy 屏幕阅读器仍会念 Low。
    const body = bodyOf(SOURCE, "  function paint(animateLabel) {");
    expect(body).toContain('setAttribute("aria-valuenow"');
    expect(body).toContain('setAttribute("aria-valuetext"');
  });

  it("帮助按钮有 aria-expanded 与 aria-controls，气泡是 role=tooltip", () => {
    expect(CODE).toContain('help.setAttribute("aria-expanded"');
    expect(CODE).toContain('help.setAttribute("aria-controls"');
    expect(CODE).toContain('bubble.setAttribute("role", "tooltip")');
    // 切换是相对当前状态取反，不是每次点击都打开。
    const click = bodyOf(SOURCE, "  function onHelpClick(event) {");
    expect(click).toContain("bubblePinned");
  });
});

describe("提交与外部接口", () => {
  it("effort-change 冒泡且 composed，detail 是 { value, level }", () => {
    const body = bodyOf(SOURCE, "  function commit(next) {");
    expect(body).toContain('new CustomEvent("effort-change"');
    expect(body).toContain("bubbles: true");
    expect(body).toContain("composed: true");
    expect(body).toContain("const detail = { value: index, level: TIER_NAMES[index] }");
    // 事件从根节点派发：宿主把卡片挂在哪就在哪捕获，不需要知道内部结构。
    expect(body).toContain("root.dispatchEvent");
  });

  it("onChange 与事件同参数", () => {
    const body = bodyOf(SOURCE, "  function commit(next) {");
    expect(body).toContain("onChange(detail)");
  });

  it("setValue 吸附整数档、清速度，并按 silent 决定是否提交", () => {
    const body = bodyOf(SOURCE, "  function setValue(next, settings = {}) {");
    expect(body).toContain("normaliseValue(next)");
    expect(body).toContain("position = index");
    expect(body).toContain("velocity = 0");
    expect(body).toContain('settings.silent !== true');
    expect(body).toContain("commit(index)");
  });

  it("创建时的初始值走 silent，不假装用户选了一档", () => {
    expect(CODE).toContain("setValue(value, { silent: true })");
  });

  it("对外返回 setValue / getValue / destroy", () => {
    expect(CODE).toContain("return { setValue, getValue, destroy }");
    expect(CODE).toContain("function getValue()");
  });

  it("mount 接受元素或选择器字符串，找不到就报错", () => {
    const body = bodyOf(SOURCE, "function resolveMount(mount) {");
    expect(body).toContain("querySelector");
    expect(body).toContain("throw new Error");
  });
});

describe("一个 RAF 循环与它的启停（规格 §4 / §6）", () => {
  it("dt 钳到 min(.032, 实际秒数)", () => {
    expect(CODE).toContain("const MAX_DT = 0.032");
    const body = bodyOf(SOURCE, "  function frame(stamp) {");
    expect(body).toContain("Math.min(MAX_DT");
  });

  it("只有一个环形排帧点：frame 末尾再排", () => {
    // 两个独立的 RAF 循环会让两条弹簧按不同节奏走。
    const schedules = CODE.match(/requestAnimationFrame\(/g) ?? [];
    // 一处是 `schedule()` 里的排帧，另一处是 `resume` 对可用性的判断。
    expect(schedules.length).toBeLessThanOrEqual(2);
    const frameBody = bodyOf(SOURCE, "  function frame(stamp) {");
    expect(frameBody).toContain("schedule()");
    expect(frameBody).toContain("paint(");
  });

  it("停帧条件：位置吸附 + g 归零", () => {
    const body = bodyOf(SOURCE, "  function wantsFrames() {");
    // Galaxy 期间必须继续：像素要闪、粒子要流、卡片要微震——这些都不在弹簧里。
    expect(body).toContain("if (galaxy > 0) return true");
    expect(body).toContain("position === target");
    expect(body).toContain("velocity === 0");
    expect(body).toContain("galaxy === galaxyTarget");
  });

  it("减少动态时不排帧", () => {
    const body = bodyOf(SOURCE, "  function wantsFrames() {");
    expect(body).toContain("reduceMotion()");
  });

  it("暂停后恢复不补算时间：lastStamp 置空，下一帧只记基准", () => {
    // 这是"暂停时间不计入积分"的全部实现。补算的话，恢复的第一帧 dt 会是几秒，
    // 钳到 .032 也还是把弹簧打飞；不钳的话直接冲出轨道。
    const resumeBody = bodyOf(SOURCE, "  function resume() {");
    expect(resumeBody).toContain("lastStamp = null");
    const frameBody = bodyOf(SOURCE, "  function frame(stamp) {");
    expect(frameBody).toContain("if (lastStamp === null)");
    expect(frameBody).toContain("lastStamp = stamp");
  });

  it("clock 只按帧累加（不是绝对时间），enteredAt 与它同一时基", () => {
    const frameBody = bodyOf(SOURCE, "  function frame(stamp) {");
    expect(frameBody).toContain("clock += dt");
    // 绝对时间当 clock 会让暂停变成"时间照样流走"，age 一恢复就巨大。
    expect(CODE).not.toContain("performance.now() / 1000");
    expect(CODE).toContain("enteredAt = clock");
  });

  it("文档隐藏与离屏都停帧", () => {
    expect(CODE).toContain('document.addEventListener("visibilitychange"');
    expect(CODE).toContain("document.hidden");
    expect(CODE).toContain("new IntersectionObserver(");
  });
});

describe("褶皱、填充与标题动画（规格 §2 / §4）", () => {
  it("新增 path 设了 pathLength=1 与 stroke-dasharray=1", () => {
    const body = bodyOf(SOURCE, "function foldPath(width, d) {");
    expect(body).toContain("pathLength: 1");
    expect(body).toContain('"stroke-dasharray": 1');
  });

  it("褶皱组带 data-tier，初始 opacity=0、--ge-fold-hidden=1", () => {
    expect(CODE).toContain('"data-tier": tier.level');
    expect(CODE).toContain('opacity: 0');
    expect(CODE).toContain('setProperty("--ge-fold-hidden", "1")');
    expect(CSS).toContain("stroke-dashoffset: var(--ge-fold-hidden, 1)");
  });

  it("每层都保留全部节点，绘制时只改 opacity 与变量", () => {
    const body = bodyOf(SOURCE, "  function paint(animateLabel) {");
    expect(body).toContain("foldReveal(position");
    expect(body).toContain('setAttribute("opacity"');
    expect(body).toContain('setProperty("--ge-fold-hidden"');
    // 没有任何一处按档位重建褶皱节点——重建会让画到一半的线凭空消失。
    expect(body).not.toContain("remove()");
    expect(body).not.toContain("createElementNS");
  });

  it("右半球是镜像复用，不是第二份路径数据", () => {
    expect(CODE).toContain('const MIRROR_TRANSFORM = "translate(64 0) scale(-1 1)"');
    // 两条路径数据各只出现一次：轮廓与主沟都是常量，左右两半共用。第二条会
    // 出现在右半球的节点上——不是抄一份路径，而是给同一组 `d` 加镜像变换。
    expect((CODE.match(/M30 14C30 5 20 4 16 12/g) ?? []).length).toBe(1);
    expect((CODE.match(/M30 27Q28 35 22 35/g) ?? []).length).toBe(1);
    // 镜像常量被用在**两处**：右半球轮廓组、以及每层褶皱的镜像组。
    expect((CODE.match(/MIRROR_TRANSFORM/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("轨道填充：五个色标 + width = trackX(position)", () => {
    const body = bodyOf(SOURCE, "  function paint(animateLabel) {");
    expect(body).toContain("trackFillStops(position)");
    expect(body).toContain("linear-gradient(90deg");
    for (const stop of ["0%", "30%", "60%", "90%", "100%"]) {
      expect(body, stop).toContain(stop);
    }
    expect(body).toContain("trackFill.style.width");
    expect(body).toContain("trackFillOpacity(state.g)");
  });

  it("标题变档：拆字符、间隔 15ms、快速改档取消旧的", () => {
    expect(CODE).toContain("const CHAR_STAGGER_MS = 15");
    const body = bodyOf(SOURCE, "  function animateLabelTo(text) {");
    expect(body).toContain("clearCharTimers()");
    expect(body).toContain("setTimeout(");
    expect(body).toContain("index * CHAR_STAGGER_MS");
    // 每字 220ms 在 CSS 里（时长要能被 prefers-reduced-motion 关掉）。
    expect(CSS).toContain("220ms cubic-bezier(.2, .7, .2, 1)");
    expect(CSS).toContain("filter: blur(4px)");
    expect(CSS).toContain("translateY(5px)");
  });

  it("只在新旧档位名不同时触发", () => {
    const body = bodyOf(SOURCE, "  function paint(animateLabel) {");
    expect(body).toContain("if (index !== labelIndex)");
  });
});

describe("Galaxy 与减少动态（规格 §4 / §6）", () => {
  it("galaxyState 驱动 scale / fill / stroke / glow / shake", () => {
    const body = bodyOf(SOURCE, "  function paint(animateLabel) {");
    expect(body).toContain("galaxyState(galaxy, clock, enteredAt)");
    for (const part of ["state.scale", "state.fill", "state.stroke", "state.glow", "state.shake"]) {
      expect(body, part).toContain(part);
    }
    expect(body).toContain("Math.sin(clock * 93)");
    expect(body).toContain("Math.cos(clock * 117)");
  });

  it("进入 Galaxy 记 enteredAt，离开变 0", () => {
    const body = bodyOf(SOURCE, "  function setTarget(index, { animate = true } = {}) {");
    expect(body).toContain("enteredAt = clock");
    expect(body).toContain("galaxyTarget = 1");
    expect(body).toContain("galaxyTarget = 0");
  });

  it("判据是最近档位，不是位置精确等于 5", () => {
    // 规格 §4「当最近档位进入 Galaxy 时」。拖到 4.6 时标签已经换成 Galaxy，
    // 若要求位置精确到 5，脑形会在标签换掉之后还差半格才开始变形。
    const body = bodyOf(SOURCE, "  function setTarget(index, { animate = true } = {}) {");
    expect(body).toContain("tierIndex(next) === LAST_TIER");
  });

  it("两个 Canvas 图层都接上了", () => {
    expect(CODE).toContain("createPixelLayer(pixelCanvas");
    expect(CODE).toContain("createRadialLayer(radialCanvas");
    const body = bodyOf(SOURCE, "  function paint(animateLabel) {");
    expect(body).toContain("pixelLayer.draw(clock, state.g)");
    expect(body).toContain("radialLayer.draw(clock, state.g, state.age");
  });

  it("g 归零后再清一次屏（离开 Galaxy 要退干净）", () => {
    const body = bodyOf(SOURCE, "  function paint(animateLabel) {");
    expect(body).toContain("pixelsDirty");
    expect(body).toContain("radialDirty");
    expect(body).toContain("pixelLayer.draw(clock, 0)");
    expect(body).toContain("radialLayer.draw(clock, 0");
  });

  it("减少动态叠加：选项与 prefers-reduced-motion 任一为真", () => {
    expect(CODE).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
    expect(CODE).toContain("reducedMotion ||");
    expect(CODE).toContain("motionQuery.matches");
    expect(CSS).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("减少动态时 position 与 g 立即吸附、不震动", () => {
    const stepBody = bodyOf(SOURCE, "  function step(dt) {");
    expect(stepBody).toContain("position = target");
    expect(stepBody).toContain("galaxy = galaxyTarget");
    const paintBody = bodyOf(SOURCE, "  function paint(animateLabel) {");
    expect(paintBody).toContain("reduceMotion() ? 0 : state.shake");
  });

  it("切换偏好不丢当前档位（只重算呈现，不动 target）", () => {
    const body = bodyOf(SOURCE, "  function onMotionPreferenceChange() {");
    expect(body).toContain("position = target");
    // 关键：这个函数里没有给 target 赋值。
    expect(/(^|[^\w.])target\s*=(?!=)/.test(body)).toBe(false);
    expect(body).toContain("paint(false)");
  });
});

describe("destroy 逐项清理（规格 §6）", () => {
  const body = bodyOf(SOURCE, "  function destroy() {");

  it("取消 RAF 与文字动画", () => {
    expect(body).toContain("cancelAnimationFrame(raf)");
    expect(body).toContain("clearCharTimers()");
  });

  it("断开所有观察者", () => {
    expect(body).toContain("intersection.disconnect()");
    expect(body).toContain(".disconnect()");
  });

  it("移除全部监听器（元素、文档、媒体查询）", () => {
    expect(body).toContain("removeEventListener");
    expect((body.match(/removeEventListener\(/g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(body).toContain("motionQuery.removeEventListener");
  });

  it("把根节点从 DOM 摘掉，并先关掉 ready", () => {
    expect(body).toContain("root.remove()");
    expect(body.indexOf("ready = false")).toBeLessThan(body.indexOf("root.remove()"));
  });

  it("可以重复 destroy 而不重复清理", () => {
    expect(body).toContain("if (!ready) return");
  });

  it("ResizeObserver 与 MutationObserver 不是本组件的选项（规格 §6 的对应项）", () => {
    // 规格把这两项写成"若存在"。本组件的尺寸全是规格里的绝对像素，舞台缩放
    // 由宿主（演示页）负责，所以这里没有它们——少一个观察者就少一处要断开的
    // 连接，而不是漏了一项。
    expect(CODE).not.toContain("new ResizeObserver(");
    expect(CODE).not.toContain("new MutationObserver(");
  });
});

describe("CSS 落实规格 §1 的数值", () => {
  it("卡片：440×258、2px #292929、16px 圆角、#191919、阴影", () => {
    const card = CSS.slice(CSS.indexOf(".ge-card {"), CSS.indexOf(".ge-title {"));
    expect(card).toContain("width: 440px");
    expect(card).toContain("height: 258px");
    expect(card).toContain("border: 2px solid #292929");
    expect(card).toContain("border-radius: 16px");
    expect(card).toContain("background: #191919");
    expect(card).toContain("box-shadow: 0 18px 28px -12px #0003");
  });

  it("标题与档位名的三种颜色", () => {
    expect(CSS).toContain("#848484");
    expect(CSS).toMatch(/\.ge-tier\s*\{\s*color:\s*#e1e1e1/);
    expect(CSS).toMatch(/\.ge-tier\.ge-tier-galaxy\s*\{\s*color:\s*#9dcef3/);
  });

  it("帮助按钮 70×70 右 3 上 7、内边距 23", () => {
    const help = CSS.slice(CSS.indexOf(".ge-help {"), CSS.indexOf(".ge-help:hover"));
    expect(help).toContain("right: 3px");
    expect(help).toContain("top: 7px");
    expect(help).toContain("width: 70px");
    expect(help).toContain("height: 70px");
    expect(help).toContain("padding: 23px");
  });

  it("Faster / Smarter 上 97 左右 22、24px/29px；Recommended 左 47 上 205", () => {
    const scale = CSS.slice(CSS.indexOf(".ge-scale {"), CSS.indexOf(".ge-recommended {"));
    expect(scale).toContain("top: 97px");
    expect(scale).toContain("left: 22px");
    expect(scale).toContain("font-size: 24px");
    expect(scale).toContain("line-height: 29px");
    const recommended = CSS.slice(CSS.indexOf(".ge-recommended {"), CSS.indexOf(".ge-slider {"));
    expect(recommended).toContain("left: 47px");
    expect(recommended).toContain("top: 205px");
  });

  it("轨道 392×40、#272727、圆角 10，命中区上 133 高 72", () => {
    const track = CSS.slice(CSS.indexOf(".ge-track {"), CSS.indexOf(".ge-track-fill {"));
    expect(track).toContain("width: 392px");
    expect(track).toContain("height: 40px");
    expect(track).toContain("background: #272727");
    expect(track).toContain("border-radius: 10px");
    expect(track).toContain("overflow: hidden");
    const slider = CSS.slice(CSS.indexOf(".ge-slider {"), CSS.indexOf(".ge-slider:focus"));
    expect(slider).toContain("top: 133px");
    expect(slider).toContain("height: 72px");
    expect(slider).toContain("border-radius: 12px");
  });

  it("刻度叠在像素网格之上（进入 Galaxy 时六个档位点不能被盖掉）", () => {
    // 规格 §1「刻度始终保留，像素层下方绘制」。DOM 顺序 + `z-index` 两道都要：
    // 只靠顺序，画布被提升成合成层时就会翻到刻度上面。
    const order = 'track.append(trackFill, pixelCanvas, dots)';
    expect(CODE, "像素画布必须排在刻度之前").toContain(order);
    expect(CSS).toMatch(/\.ge-track-dots\s*\{[^}]*z-index:\s*1/);
  });

  it("刻度圆点两档：6×6 与 6×20", () => {
    const dot = CSS.slice(CSS.indexOf(".ge-dot {"), CSS.indexOf(".ge-dot-tall {"));
    expect(dot).toContain("width: 6px");
    expect(dot).toContain("height: 6px");
    expect(dot).toContain("top: 18px");
    expect(dot).toContain("rgba(255, 255, 255, .20)");
    const tall = CSS.slice(CSS.indexOf(".ge-dot-tall {"));
    expect(tall).toContain("height: 20px");
    expect(tall).toContain("border-radius: 3px");
    expect(tall).toContain("rgba(255, 255, 255, .27)");
  });

  it("tooltip 的全部数值", () => {
    const tip = CSS.slice(CSS.indexOf(".ge-tooltip {"), CSS.indexOf(".ge-tooltip[hidden]"));
    expect(tip).toContain("padding: 12px 14px");
    expect(tip).toContain("border: 1px solid #444");
    expect(tip).toContain("border-radius: 9px");
    expect(tip).toContain("background: #242424");
    expect(tip).toContain("color: #dedede");
    expect(tip).toContain("font-size: 14px");
    expect(tip).toContain("line-height: 20px");
    expect(tip).toContain("box-shadow: 0 6px 24px #0005");
  });

  it("全部类名都是 .ge- 前缀，没有会撞车的裸 .effort-*", () => {
    expect(CSS).toContain(".ge-card");
    expect(CSS).toContain(".ge-track");
    expect(CSS).toContain(".ge-brain");
    expect(CSS).toContain(".ge-pixel");
    expect(CSS).toContain(".ge-radial");
    expect(CSS).toContain(".ge-tooltip");
    // `styles.css` 里已经有一整套 `.effort-*`（旧的六档 range 面板）。这里出现
    // 任何一个裸 `.effort-` 类都会同时命中两个组件。
    expect(CSS).not.toMatch(/(^|[\s,{])\.effort-/);
    expect(CSS).not.toMatch(/(^|[\s,{])\.effort-panel/);
  });
});
