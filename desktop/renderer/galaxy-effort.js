/**
 * 脑形思考强度滑块（Galaxy Effort Slider）—— 组件本体。
 *
 * 事实源是 `docs/specs/galaxy-effort-slider.md`：§1 的结构与尺寸、§2 的脑形
 * 与褶皱、§3 的输入与无障碍、§4 的运动、§6 的清理。弹簧、色板插值、Galaxy
 * 派生量与 Canvas 图层仍来自 `./galaxy-effort-core.js` 与
 * `./galaxy-effort-layers.js`——本文件不重写它们。
 *
 * **例外是两处把档位数写进定义域的纯函数**：core 的 `trackX` 与 `foldReveal`
 * 把位置钳在 0..5 再除以 5 / 把 level 当位置用，那是六档验收的产物；档位改成
 * 由宿主决定之后，这里的 `trackXAt` 与 `foldRevealAt` 按当前跨度重算了同样的
 * 公式（两处都有注释说明推导）。core 一个字符都没改——它被 51 条测试钉着。
 *
 * 顶层只有 import、常量与函数声明，不碰 `document` / `window` /
 * `requestAnimationFrame`。这不只是洁癖：`tests/desktop/*` 会在 Node 里静态
 * import 本文件，顶层一句 `document.createElement` 就让整组测试炸掉，而报错
 * 位置指的是 import 行，不是那行 DOM 代码。
 */

import {
  FOLD_LEVELS,
  clamp,
  galaxyState,
  stepSpring,
  trackFillOpacity,
  trackFillStops,
} from "./galaxy-effort-core.js";
import { createPixelLayer, createRadialLayer } from "./galaxy-effort-layers.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** 左半球轮廓与主沟（规格 §2）。右半球靠镜像复用这两条，不另画一份数据。 */
const BRAIN_OUTLINE = "M30 14C30 5 20 4 16 12C9 11 5 20 9 26C2 30 3 39 10 43C6 50 11 59 19 57C24 63 30 58 30 52Z";

/**
 * 主沟：**一条 path 里的三个子路径**，不是三条。
 *
 * `foldVisibleCount` 的计数口径（每一档从 2 起头）依赖它是一条：拆成三条后
 * 六档的可见路径数会从 2/4/6/8/12/16 变成 4/6/8/10/14/18，而脑形看起来一模一样
 * ——一个只在计数上成立、视觉上抓不到的回归。
 */
const BRAIN_MAIN_FOLD = "M30 27Q28 35 22 35M10 43Q15 44 17 48M16 12Q13 17 16 20";
const MAIN_FOLD_WIDTH = 4.2;

/** 脑形的显示尺寸与镜像变换。48px 显示、64 单位坐标系（规格 §2）。 */
const BRAIN_SIZE = 48;
const BRAIN_HALF = BRAIN_SIZE / 2;
const MIRROR_TRANSFORM = "translate(64 0) scale(-1 1)";

/**
 * tooltip 的默认文案。
 *
 * 六档时逐字等于规格 §3 的原文（`Low, Medium, High, Extra, Max or Galaxy`）；
 * 档位由宿主决定之后，默认句只能从 `stops` 的标签拼出来——写死六个名字会在
 * 三档或一档的模型上说出根本不存在的档（R3）。宿主仍可以传 `tooltip` 覆盖成
 * 已本地化的句子。
 */
function listLabels(labels) {
  if (labels.length <= 1) return labels.join("");
  if (labels.length === 2) return labels[0] + " or " + labels[1];
  return labels.slice(0, -1).join(", ") + " or " + labels[labels.length - 1];
}

/**
 * 默认 tooltip：把档位名逐个列出来。
 *
 * 导出是为了让测试能在 Node 里直接断言六档时它逐字等于规格 §3 的原文——
 * 那段文字本身是验收项，而档位名改成动态拼接之后，它只能靠一条断言钉住。
 */
export function defaultTooltip(stops) {
  return "Drag the brain or use arrow keys to choose " + listLabels(stops.map((stop) => stop.label))
    + ". Higher effort adds brain folds; Galaxy adds particles. This control uses local demo state.";
}

/** 普通档位弹簧（规格 §4）：k=420、damping=32。 */
const POSITION_K = 420;
const POSITION_DAMPING = 32;

/** Galaxy 弹簧（规格 §4）：k=190、damping=25。同一套积分、不同的刚度。 */
const GALAXY_K = 190;
const GALAXY_DAMPING = 25;

/**
 * 一帧最多积分多少秒（规格 §4）。
 *
 * 32 ms 的钳位不是对慢机器的宽容，是给弹簧保命：`stepSpring` 的注释里有实测，
 * 同样一帧 32 ms 下单步欧拉会把位置从 1.086 甩到 2.150。标签页从后台回来、
 * 或一次长 GC 之后，实际帧间隔可能是好几秒；不钳位第一帧就会把脑形弹到轨道外。
 */
const MAX_DT = 0.032;

/** 轨道与命中区的几何（规格 §1），单位是卡片内的像素。卡片本身 440×258 只在
 *  CSS 里出现一次：JS 不读它，抄一份常量只会多一个改规格时忘掉的数字。 */
const TRACK_WIDTH = 392;
const TRACK_HEIGHT = 40;
/** 轨道在命中区内的上偏移（规格 §1：上 15、下 17、高 40，命中区高 72）。 */
const TRACK_TOP = 15;
/**
 * 刻度圆点的左右端（规格 §1：`16 + i×358/5`，六档时）。
 *
 * 与 `trackXAt` 共用同一对端点：刻度与脑形中心必须落在同一条映射上，两处各写
 * 一套数字的后果是脑形停在两粒刻度之间，而看起来"差不多对"。端点**不随档位数
 * 变**（轨道还是那条轨道），变的只是中间分几格。
 */
const TRACK_START_X = 16;
const TRACK_END_X = TRACK_START_X + 358;
/** 命中区左边距；轨道左端从 22 起，与卡片左边距同值。 */
const HIT_LEFT = 22;
/** 脑形中心在命中区内的纵坐标（规格 §2：命中区 (16,36)），换算到轨道内是 21。 */
const BRAIN_CENTER_Y = 36;

/** 放射画布的尺寸（规格 §5：640×390；画布本身用 CSS 定位到卡片左上外）。 */
const RADIAL_WIDTH = 640;
const RADIAL_HEIGHT = 390;

/**
 * 粒子中心在**放射画布**里的坐标（规格 §5：`(100+22+16 + position/5×358, 60+141+28)`）。
 *
 * 只留下不随位置变化的那部分：横坐标把 `16 + position/span×358` 让给
 * `trackXAt(position, span)`（那是轨道、刻度与脑形共用的唯一一份映射），常量只剩
 * `100 + 22`；
 * 纵坐标是规格原文的三个数之和 `60 + 141 + 28 = 229`，原样抄写、不在这里
 * 重新拆成"命中区 + 轨道偏移"。粒子必须跟着脑形走——脑形一到 Galaxy 就停在
 * 最右侧，中心写死会让粒子从空处喷出来。
 */
const RADIAL_CENTER_BASE_X = 100 + HIT_LEFT;
const RADIAL_CENTER_BASE_Y = 60 + 141 + 28;

/**
 * 标题拆字的**间隔**（规格 §4:15ms）。每字 220ms 的时长在 CSS 的动画里，
 * 这里只负责节奏；两处分开是因为时长要能走 `prefers-reduced-motion`，间隔不能。
 */
const CHAR_STAGGER_MS = 15;

/**
 * 一档褶皱展开窗口的半宽与宽度（规格 §4）：`u = (p - levelPos + .85) / .7`。
 *
 * 单档或三档时 `levelPos` 不再是整数 1..5（见 `foldRevealAt`），但窗口本身的形状
 * 是规格给的，不随档位数改。
 *
 * **已知后果（2026-11-09，未修，留给产品决定）**：五层按 `span` 均分，档位越少，
 * 最低档的褶皱越多。三档时 p=0 处第 1 层的 reveal 是 0.7085（六档时是 0）——最低档
 * 不再是「只有主沟」。要让它仍是主沟，得改成按比例只启用前 N 层，那是改规格。
 */
const FOLD_WINDOW_LEAD = 0.85;
const FOLD_WINDOW_WIDTH = 0.7;

/**
 * 建一个 SVG 节点并写属性。
 *
 * SVG 的属性名区分大小写（`pathLength`、`viewBox`），用 `setAttribute` 逐个
 * 写而不是拼 `innerHTML`：拼字符串会把属性值与路径数据混进同一段文本，
 * 一旦哪里漏了引号，坏掉的是整棵子树而不是一个属性，而且没有报错。
 */
function svgElement(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes ?? {})) node.setAttribute(key, String(value));
  return node;
}

/** 建一个 HTML 节点。 */
function element(tag, className) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

/**
 * 把 `mount` 解析成宿主元素。
 *
 * 找不到就抛错而不是静默返回：一个没挂上的控件在页面上什么也不显示，调用方却
 * 拿到一个"能用"的实例，这种失败要等到用户点它才被发现（R3）。
 */
function resolveMount(mount) {
  if (typeof mount === "string") {
    const found = document.querySelector(mount);
    if (found !== null) return found;
    throw new Error("createGalaxyEffort: mount not found: " + mount);
  }
  if (mount !== null && typeof mount === "object" && typeof mount.appendChild === "function") {
    return mount;
  }
  throw new Error("createGalaxyEffort: mount must be an element or a selector string");
}

/**
 * 校验并拷贝宿主给的档位表。
 *
 * `stops` 是**必填**的：档位由模型能力决定，正是这次改动的全部意义。缺省时
 * 兜底成三档会让"宿主漏传"看起来像"控件能用、只是档位不对"——那种错要等到
 * 用户发现标签和请求不符才会被查出来（R3）。所以缺省、空表、形状不对一律抛错。
 *
 * 拷贝一份：宿主每次回答都可能重建自己那份数组，组件内部的刻度、标签与判定
 * 必须来自同一份快照；否则宿主刷新一次，刻度和标签就会各说一套。
 *
 * 导出是为了让 `tests/desktop/*` 在没有 DOM 的 Node 里直接断言校验规则
 * （规格 §7：可脱离 DOM 的部分导出成纯函数）。
 */
export function normaliseStops(stops) {
  if (!Array.isArray(stops) || stops.length === 0) {
    throw new Error("createGalaxyEffort: stops must be a non-empty array of { value, label }");
  }
  return stops.map((stop, index) => {
    if (stop === null || typeof stop !== "object"
      || typeof stop.value !== "string" || typeof stop.label !== "string" || stop.label === "") {
      throw new Error(`createGalaxyEffort: stops[${index}] must be { value: string, label: string }`);
    }
    // `sends` 是可选的第 3 个字段：宿主用它告诉界面这一格实际发什么。
    // 缺省（演示页那种只给 value/label 的调用）不报一个编出来的值。
    const sends = typeof stop.sends === "string" ? stop.sends : (stop.sends === null ? null : undefined);
    return { value: stop.value, label: stop.label, ...(sends === undefined ? {} : { sends }) };
  });
}

/** 把任意输入折成 0..span 的整数档位（提交与外部回写用）。 */
function normaliseValue(raw, span) {
  const number = Number(raw);
  if (!Number.isFinite(number)) return 0;
  return clamp(Math.round(number), 0, span);
}

/**
 * 拖拽途中的目标：钳进 0..span，但**保留小数**。
 *
 * 拖动是连续量。在这里取整会让轨道填充与褶皱一格一格地跳，弹簧也会跟着变成
 * 阶梯——规格 §4 的"禁止用两张静帧淡入冒充移动"说的正是这件事。
 */
function clampPosition(raw, span) {
  const number = Number(raw);
  if (!Number.isFinite(number)) return 0;
  return clamp(number, 0, span);
}

/**
 * 连续位置 → 最近的整数档位。
 *
 * 用 `round` 而不是 `floor`：位置 4.6 在视觉上已经属于最高档（脑形停在两格之间
 * 靠右的地方），向下取整会让标签停在上一个档位、和用户看到的位置对不上。
 * 与 core 的 `tierIndex` 同一套取整，只是上界由写死的 5 换成当前的 `span`。
 */
function indexAt(position, span) {
  const number = Number(position);
  if (!Number.isFinite(number)) return 0;
  return clamp(Math.round(number), 0, span);
}

/**
 * 轨道内的横坐标：`TRACK_START_X + position / span × (TRACK_END_X - TRACK_START_X)`。
 *
 * 不调 core 的 `trackX`：那个把位置钳在 0..5 再除以 5，是六档验收的产物。宿主给
 * 三档时 `position = 2` 就是满档，用 core 的会把它画在轨道的 40% 处——脑形与刻度
 * 就此分家。端点常量与 core 相同（`16` 与 `16 + 358`），只有分母换成当前跨度。
 */
export function trackXAt(position, span) {
  if (span <= 0) return TRACK_START_X;
  return TRACK_START_X + clamp(position, 0, span) / span * (TRACK_END_X - TRACK_START_X);
}

/**
 * 某一层褶皱在当前位置的揭示程度，`0` 到 `1`。
 *
 * 公式是规格 §4 的 `u = clamp((p - level + .85) / .7, 0, 1)` 加 smoothstep，
 * **内联在这里而不是调 core 的 `foldReveal`**：core 把位置钳在 0..5、把 level 当
 * 位置用，那是六档验收的产物，定义域与档位数绑死；档位一旦由宿主决定，第 f 层
 * 的展开中心要落在 `f × span / 5`（三档时是 .4/.8/1.2/1.6/2），超出 0..5 的
 * 语义。core 那个纯函数有 51 条测试钉着，不能为了这里去改它。
 *
 * 窗口宽度不变：第 5 层在 `span` 处 `u = (span - span + .85) / .7 > 1`，所以满档
 * 时五层全开——这正是"最高档要看到全部褶皱"。
 */
export function foldRevealAt(position, levelPos, span) {
  const p = clamp(position, 0, span);
  const u = clamp((p - levelPos + FOLD_WINDOW_LEAD) / FOLD_WINDOW_WIDTH, 0, 1);
  return u * u * (3 - 2 * u);
}

/**
 * Galaxy 在哪一档生效：只有它是**最高一档**时返回它的下标，否则返回 -1。
 *
 * 理由是没有比 Galaxy 更强的请求可发的那种模型不该出现 Galaxy 效果——默认映射
 * 下最高档是 `high`，列表里可能仍有 `galaxy`（旧 `run.json` 里存的档位），此时
 * 整套像素层、放射层与放大都不跑。宿主不会故意造"galaxy 在中间"的表，但组件
 * 不能因此崩：按"不在最高位就不启用"处理。
 *
 * 单档且那一档就是 `galaxy` 时返回 0（它同时是最高档）；这是规则的直接结果，
 * 不是特例。
 */
export function galaxyIndexOf(stops) {
  const index = stops.findIndex((stop) => stop.value === "galaxy");
  return index !== -1 && index === stops.length - 1 ? index : -1;
}

/** 帮助按钮里的 24×24 圆圈问号（规格 §1 的路径逐字）。描边颜色由 CSS 给。 */
function buildHelpIcon() {
  const svg = svgElement("svg", {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    "aria-hidden": "true",
    focusable: "false",
  });
  const circle = svgElement("circle", { cx: 12, cy: 12, r: 10, fill: "none", "stroke-width": 2 });
  const mark = svgElement("path", {
    d: "M9.5 8.2a2.6 2.6 0 0 1 5 .8c0 2-2.5 2.2-2.5 4",
    fill: "none",
    "stroke-width": 2,
    "stroke-linecap": "round",
  });
  const dot = svgElement("path", {
    d: "M12 16.5h.01",
    fill: "none",
    "stroke-width": 2,
    "stroke-linecap": "round",
  });
  svg.append(circle, mark, dot);
  return svg;
}

/**
 * 一条新增褶皱。
 *
 * `pathLength="1"` 把任意长度的路径归一成 1 个单位，于是 `stroke-dasharray="1"`
 * 正好是"整条虚线"，`stroke-dashoffset` 从 1 走到 0 就是沿路径一笔画出来。
 * 不归一的话每条路径要各自的长度，数字全得手算，而改一条曲线就得重算一次。
 */
function foldPath(width, d) {
  return svgElement("path", {
    class: "ge-fold-path",
    d,
    fill: "none",
    "stroke-width": width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    pathLength: 1,
    "stroke-dasharray": 1,
  });
}

/**
 * 脑形 SVG：左右半球各一份轮廓 + 主沟，五层褶皱各自成组。
 *
 * 所有节点**只在创建时建一次**，之后只改 opacity 与 `--ge-fold-hidden`
 * （规格 §4「始终保留相同 SVG 及所有路径节点」）。按档位重建节点会让正在画到
 * 一半的线条凭空消失，而"生长"正是这个控件要表达的东西。
 */
function buildBrain() {
  const wrap = element("div", "ge-brain");
  const svg = svgElement("svg", {
    viewBox: "0 0 64 64",
    width: BRAIN_SIZE,
    height: BRAIN_SIZE,
    "aria-hidden": "true",
    focusable: "false",
  });

  const halves = svgElement("g", { class: "ge-brain-halves" });
  const left = svgElement("g", { class: "ge-brain-half" });
  left.append(
    svgElement("path", { class: "ge-brain-outline", d: BRAIN_OUTLINE }),
    svgElement("path", {
      class: "ge-brain-fold ge-brain-main",
      d: BRAIN_MAIN_FOLD,
      fill: "none",
      "stroke-width": MAIN_FOLD_WIDTH,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  const right = svgElement("g", { class: "ge-brain-half", transform: MIRROR_TRANSFORM });
  right.append(
    svgElement("path", { class: "ge-brain-outline", d: BRAIN_OUTLINE }),
    svgElement("path", {
      class: "ge-brain-fold ge-brain-main",
      d: BRAIN_MAIN_FOLD,
      fill: "none",
      "stroke-width": MAIN_FOLD_WIDTH,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  halves.append(left, right);
  svg.append(halves);

  const folds = [];
  for (const tier of FOLD_LEVELS) {
    const group = svgElement("g", { class: "ge-fold", "data-tier": tier.level, opacity: 0 });
    group.style.setProperty("--ge-fold-hidden", "1");
    for (const d of tier.paths) group.append(foldPath(tier.width, d));
    // 右半球是同一组路径的镜像：数据只有一份，镜像只发生在渲染期。
    const mirrored = svgElement("g", { transform: MIRROR_TRANSFORM });
    for (const d of tier.paths) mirrored.append(foldPath(tier.width, d));
    group.append(mirrored);
    folds.push(group);
    svg.append(group);
  }

  wrap.append(svg);
  return { wrap, svg, folds };
}

/**
 * 组件工厂。
 *
 * 所有状态都收在这个闭包里：模块顶层没有可变状态，否则同页两个实例会共享一个
 * `clock` 或一条弹簧，拖一个另一个跟着动，而这类串扰在单实例验收里完全看不出来。
 *
 * `stops` 是**必填**的档位表（见 `normaliseStops`）。`value` 是**下标**而不是
 * 档位名：同一个名字（例如 `auto`）在不同模型上落在不同位置，下标才是轨道上的
 * 位置本身。
 *
 * @param {{
 *   mount: Element | string,
 *   stops: Array<{ value: string, label: string }>,
 *   value?: number,
 *   reducedMotion?: boolean,
 *   tooltip?: string,
 *   onChange?: (detail: { index: number, value: string, label: string }) => void,
 * }} options
 * @returns {{
 *   setValue: (index: number, settings?: { silent?: boolean }) => void,
 *   getValue: () => number,
 *   destroy: () => void,
 * }}
 */
export function createGalaxyEffort(options = {}) {
  const {
    mount,
    stops: rawStops,
    value = 0,
    reducedMotion = false,
    tooltip,
    onChange,
  } = options;

  const stops = normaliseStops(rawStops);
  /** 位置的最大值：档位表的长度减一。所有"上界"从它来，不再写死 5。 */
  const span = stops.length - 1;
  /** 只有一个档位时整条轨道不可拖（规格：`aria-valuemax = 0`，冻结）。 */
  const single = span === 0;
  /** Galaxy 生效的档位下标；-1 表示不启用（不在最高位或根本没有）。 */
  const galaxyIndex = galaxyIndexOf(stops);

  const mountNode = resolveMount(mount);

  /**
   * 内部运动状态（规格 §3：全部初始 0）。
   *
   * `position` 是弹簧追出来的连续值，`target` 是它要去的地方。两者分开是
   * "拖到一半反向时保留当前速度"（规格 §4）能成立的前提。
   */
  let position = 0;
  let velocity = 0;
  let target = 0;
  let galaxy = 0;
  let galaxyVelocity = 0;
  let galaxyTarget = 0;
  let enteredAt = 0;

  /**
   * `clock` 是从创建起累计的动画秒数、减去所有暂停（规格 §6：暂停时间不计入
   * 积分）。它正是 `performance.now()/1000` 的反面：后者是绝对时间，标签页藏
   * 十分钟再回来，`age` 会直接跳到十分钟，进入 Galaxy 的爆发在第一帧就没了。
   * 这里靠"每帧只加 dt"实现——不排帧就不加时间，暂停因此天然不计入；
   * `enteredAt` 与它同处一个时基，不需要额外平移。
   */
  let clock = 0;
  /** 上一帧的时间戳；`null` 表示"基准已重置，下一帧只记基准、不积分"。 */
  let lastStamp = null;
  let raf = null;
  /** destroy 之后不再排帧、不再写 DOM。 */
  let ready = true;

  /** 正在被捕获的指针 id；非空时新的触摸不抢占（规格 §3）。 */
  let activePointer = null;
  /** 按下时的档位：`pointercancel` 回到这里，且不提交。 */
  let startTier = 0;
  /** 当前标签/无障碍名对应的整数档位；-1 保证首次同步一定发生。 */
  let labelIndex = -1;

  /** 图层上是否已有内容：`g` 掉到 0 时靠它决定还要不要再清一次屏。 */
  let pixelsDirty = false;
  let radialDirty = false;
  /** 组件是否在视口内（IntersectionObserver）。 */
  let onScreen = true;

  const motionQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

  /** 减少动态：任一个为真即生效（规格 §6：两者叠加，不是二选一）。 */
  const reduceMotion = () => reducedMotion || (motionQuery !== null && motionQuery.matches);

  /* ---------- DOM ---------- */

  const root = element("div", "ge-root");
  // 单档时整条轨道不可拖。视觉上的"没有手柄、光标是默认箭头"全在 CSS 里，这个
  // 属性是给 CSS 的钩子；JS 侧另外还有一层（`single` 挡掉 setTarget / 指针 /
  // 键盘 / commit），因为 `pointer-events: none` 挡不住键盘，也不该是唯一那道锁。
  if (single) root.dataset.single = "true";
  const card = element("div", "ge-card");

  const title = element("div", "ge-title");
  const titleName = element("span", "ge-title-name");
  titleName.textContent = "Effort";
  const tierLabel = element("span", "ge-tier");
  tierLabel.textContent = stops[0].label;
  title.append(titleName, tierLabel);

  const help = element("button", "ge-help");
  help.type = "button";
  help.setAttribute("aria-expanded", "false");
  help.append(buildHelpIcon());

  const bubble = element("div", "ge-tooltip");
  bubble.id = "ge-tooltip-" + Math.random().toString(36).slice(2, 9);
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  bubble.textContent = tooltip ?? defaultTooltip(stops);
  help.setAttribute("aria-controls", bubble.id);

  const scale = element("div", "ge-scale");
  const faster = element("span", "ge-faster");
  faster.textContent = "Faster";
  const smarter = element("span", "ge-smarter");
  smarter.textContent = "Smarter";
  scale.append(faster, smarter);

  const recommended = element("div", "ge-recommended");
  recommended.textContent = "Recommended";

  /**
   * 每格实际会发的协议值，画在轨道下方一行（2026-11-10 用户决定）。
   *
   * 固定六格之后，同一个值会被多个档位发出去：缺省映射把 `extra` / `max` /
   * `galaxy` 全折成 `high`；一个最低只到 `high` 的模型，`low` 与 `medium` 也
   * 发 `high`。只在选中时给一句 hint 不够——**没选中时看不出来**，于是六格
   * 看起来像六种强度。
   *
   * 这一行把每一格的真值直接印在它下面。它与轨道同宽、同样按 `span` 均分，
   * 位置算法与刻度点完全一致（`TRACK_START_X + i × 358 / span`），所以两者
   * 永远对得上；`paint()` 每帧只改文本，不改布局。
   */
  const sendLabels = element("div", "ge-sends");
  const sendLabelNodes = [];
  for (let index = 0; index < stops.length; index += 1) {
    const node = element("span", "ge-send");
    // `sends === null` 表示这一档在这个模型上没有请求值（网关不提供 ≤ 它的
    // 任何档）。画一个短横而不是编一个值：这一格拖过去会吸附到最近的可用档，
    // 但「它自己发什么」的答案是"没有"。
    // 三种情况要分开说：
    //   `undefined` —— 调用方没提供 sends（演示页那种），这一行不该编一个值；
    //   `null`      —— 这一档在这个模型上没有请求值，画短横；
    //   字符串      —— 实际会发的东西。
    // `auto` 走的是第 3 种里的特例：它**有意不发**字段，所以文字写 `none`
    // 会被读成协议值 `none`（那是"明确关闭推理"，与"不提要求"不是一回事）。
    // 用 `—` 但**不加** `ge-send-none` 类：那一格的语义是"什么都不发"，不是
    // "这个模型不支持"。
    const sends = stops[index].sends;
    // `auto` 与「无请求值」都是 `sends: null`，但说的是两件事：
    // `auto` 是**用户主动选的"不提要求"**（这一格永远可用），
    // 无值档是**这个模型给不了这么低**（拖过去会吸附走）。
    // 前者不标灰，后者标灰 —— 靠 `value` 而不是靠 `sends` 分辨。
    const isAuto = stops[index].value === "auto";
    if (sends === undefined) {
      node.textContent = "";
    } else if (sends === null) {
      node.textContent = isAuto ? "none" : "—";
      if (!isAuto) node.classList.add("ge-send-none");
    } else {
      node.textContent = sends;
    }
    const nodeX = single ? TRACK_START_X : TRACK_START_X + index * (TRACK_END_X - TRACK_START_X) / span;
    node.style.left = `${nodeX}px`;
    sendLabelNodes.push(node);
    sendLabels.append(node);
  }

  const slider = element("div", "ge-slider");
  // 触屏上必须自己吃掉手势，否则拖动会先滚动页面、`pointermove` 中途被取消。
  // 写在元素上而不是只靠 CSS：这是**行为**而不是外观，样式表没加载时拖拽也得能用。
  slider.style.touchAction = "none";
  slider.setAttribute("role", "slider");
  slider.setAttribute("tabindex", "0");
  slider.setAttribute("aria-valuemin", "0");
  // 单档时 upper bound 是 0：读屏会说"0 到 0"，与"拖不动"一致。
  slider.setAttribute("aria-valuemax", String(span));
  slider.setAttribute("aria-valuenow", "0");
  slider.setAttribute("aria-valuetext", stops[0].label);
  slider.setAttribute("aria-orientation", "horizontal");
  slider.setAttribute("aria-label", "Effort");

  const track = element("div", "ge-track");
  // 轨道在命中区里的上偏移写在元素上，与 CSS 里的 `top: 15px` 同源（`TRACK_TOP`）
  // ——两处各写一个 15 的话，改规格时只改一处，脑形与轨道就会错开一格。
  track.style.top = `${TRACK_TOP}px`;
  const trackFill = element("div", "ge-track-fill");
  const dots = element("div", "ge-track-dots");
  // 刻度点数量就是档位数，位置由同一个跨度均分。单档时只有一个点、落在左端
  // （除数 `span` 为 0，不能套那条公式）；也不给长刻度——长刻度是"第二档这个
  // 推荐位置"的记号，一档的表里没有第二个位置可指。
  for (let index = 0; index < stops.length; index += 1) {
    const dot = element("i", index === 1 ? "ge-dot ge-dot-tall" : "ge-dot");
    const dotX = single ? TRACK_START_X : TRACK_START_X + index * (TRACK_END_X - TRACK_START_X) / span;
    dot.style.left = `${dotX - 3}px`;
    dots.append(dot);
  }

  const pixelCanvas = element("canvas", "ge-pixel");
  // 叠放顺序就是规格 §1 的层次：灰底 → 紫色填充 → 像素网格 → 刻度。
  // 刻度**始终在最上层**（"刻度始终保留，像素层下方绘制"）：像素网格透明度最高
  // 能到 0.9，把它放在刻度之上，进入 Galaxy 时六个档位点就会被闪动的方块盖掉
  // ——刻度是位置参照，不能随装饰一起消失。
  track.append(trackFill, pixelCanvas, dots);

  // 脑形挂在**命中区**上而不是轨道里：轨道有 `overflow: hidden`（它是裁切像素
  // 与填充圆角的地方），而脑形中心在轨道顶边之上、Galaxy 时还要放大 1.45 倍，
  // 放进轨道会被削掉顶部。规格 §1 说的是"裁剪轨道内部"，不是裁剪脑形。
  const brain = buildBrain();

  const radialCanvas = element("canvas", "ge-radial");

  slider.append(track, brain.wrap);
  card.append(title, help, bubble, scale, recommended, sendLabels, radialCanvas, slider);
  root.append(card);
  mountNode.append(root);

  /* ---------- 画布图层 ---------- */

  /**
   * 两个 Canvas 都按设备像素比放大，再用 `ctx.scale` 把逻辑坐标缩回去。
   *
   * 不这么做的话，在 2x 屏上 5.1px 的方块会落在半像素上，画出来是糊的——而这
   * 个控件的辨识度就靠那些小方块的锐角。图层自己用逻辑尺寸 `clearRect`
   * （见 `galaxy-effort-layers.js` 的注释），所以缩放必须在这里设。
   */
  const ratio = Math.min(3, Math.max(1, typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1));

  function prepareCanvas(canvas, width, height) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    if (context !== null) context.scale(ratio, ratio);
    return context ?? undefined;
  }

  const pixelContext = prepareCanvas(pixelCanvas, TRACK_WIDTH, TRACK_HEIGHT);
  const radialContext = prepareCanvas(radialCanvas, RADIAL_WIDTH, RADIAL_HEIGHT);
  const pixelLayer = createPixelLayer(pixelCanvas, pixelContext);
  const radialLayer = createRadialLayer(radialCanvas, radialContext);

  /* ---------- 绘制 ---------- */

  /**
   * 把当前 `position` / `galaxy` 画进 DOM。这是唯一写视觉状态的地方：
   * 拖拽、键盘、`setValue` 与动画帧最后都落到这里，所以不存在"某个入口少更新
   * 一层"的可能。
   *
   * @param {boolean} animateLabel 档位名变了要不要走拆字动画
   */
  function paint(animateLabel) {
    const state = galaxyState(galaxy, clock, enteredAt);
    const x = trackXAt(position, span);
    const index = indexAt(target, span);

    // 轨道填充：宽度跟着连续位置走，颜色是五个色标的横向渐变。
    // 两件事都不能"只在换档时刷"——规格 §4 要的是随实际位置连续变化，
    // 中途反向时前缘颜色要顺着当时的颜色回去，不能先跳档再回来。
    //
    // 色标**按归一化位置取**：core 的 `trackFillStops` 把 p-1 当色板下标，
    // 定义域是六档的 0..5。三档时满档是 2，直接传会让整条轨道只用第一组色板、
    // 右端永远不偏冷紫——"强度越高前缘越冷"是规格 §4 的验收项。先把当前位置
    // 折成等价的六档位置（`position × 5 / span`）再取；单档（span = 0）没有
    // "更高"可言，取 0。六档下 `5 / span === 1`，与原实现逐位相同。
    const fillPosition = span === 0 ? 0 : position * (5 / span);
    const fillStops = trackFillStops(fillPosition);
    trackFill.style.width = `${x}px`;
    trackFill.style.opacity = String(trackFillOpacity(state.g));
    trackFill.style.background = `linear-gradient(90deg, ${fillStops[0]} 0%, ${fillStops[1]} 30%, ${fillStops[2]} 60%, ${fillStops[3]} 90%, ${fillStops[4]} 100%)`;

    // 脑形：始终是同一个 SVG，只改派生属性（规格 §4「进出保留同一 SVG」）。
    // 坐标相对**命中区**（脑形的父节点），`trackXAt` 给的正是命中区内的横坐标；
    // 减去半径让 48px 的盒子以中心对齐。
    brain.wrap.style.left = `${x - BRAIN_HALF}px`;
    brain.wrap.style.top = `${BRAIN_CENTER_Y - BRAIN_HALF}px`;
    brain.wrap.style.transform = `scale(${state.scale})`;
    brain.wrap.style.setProperty("--ge-brain-fill", state.fill);
    brain.wrap.style.setProperty("--ge-brain-stroke", state.stroke);
    brain.wrap.style.setProperty("--ge-glow-a", `${state.glow[0]}px`);
    brain.wrap.style.setProperty("--ge-glow-b", `${state.glow[1]}px`);
    brain.wrap.style.setProperty("--ge-glow-strength", String(state.g));

    // 褶皱：同一批节点，只改 opacity 与 --ge-fold-hidden。每层在档位表上的
    // 展开中心是 `level × span / 5`——五层均匀铺满整条轨道，档位越少层与层
    // 之间越近（三档时第 2 层与第 1 层只差 0.4 格）。位置换算交给
    // `foldRevealAt`，那里说明了为什么不能直接调 core 的 `foldReveal`。
    for (const group of brain.folds) {
      const levelPos = Number(group.dataset.tier) * span / 5;
      const reveal = foldRevealAt(position, levelPos, span);
      group.setAttribute("opacity", String(reveal));
      group.style.setProperty("--ge-fold-hidden", String(1 - reveal));
    }

    // 震动：横向主、纵向少一点（规格 §4 的 .65）。减少动态时振幅为 0——
    // 不是"跳过这一帧"，而是彻底不抖。
    const shake = reduceMotion() ? 0 : state.shake;
    const shakeX = Math.sin(clock * 93) * shake;
    const shakeY = Math.cos(clock * 117) * shake * 0.65;
    card.style.transform = `translate3d(${shakeX}px, ${shakeY}px, 0)`;

    if (index !== labelIndex) {
      labelIndex = index;
      if (animateLabel) animateLabelTo(stops[index].label);
      else setLabel(stops[index].label);
    }
    const label = stops[index].label;
    // 淡蓝只给**真正启用的** Galaxy：宿主把 `galaxy` 放在中间档时那档没有
    // Galaxy 效果，标签再染成蓝色就是在指一个不存在的东西。
    tierLabel.classList.toggle("ge-tier-galaxy", galaxyIndex !== -1 && index === galaxyIndex);
    slider.setAttribute("aria-valuenow", String(index));
    slider.setAttribute("aria-valuetext", label);

    // Galaxy 的两个图层：`g > 0` 才画。`g` 掉到 0 时还要再清一次屏，
    // 否则最后一帧的像素会永远留在画布上——"离开 Galaxy 要退干净"。
    //
    // 减少动态时**只留静态像素**（规格 §6）：像素层照画（`clock` 不前进，所以
    // 网格是定住的），放射层不画——"放射流动"正是这一设置要取消的东西，
    // 画一帧然后冻住也还是流动的样子。
    const centerX = RADIAL_CENTER_BASE_X + x;
    const centerY = RADIAL_CENTER_BASE_Y;
    const reduced = reduceMotion();
    if (state.g > 0) {
      pixelLayer.draw(clock, state.g);
      pixelsDirty = true;
      if (!reduced) {
        radialLayer.draw(clock, state.g, state.age, centerX, centerY);
        radialDirty = true;
      } else if (radialDirty) {
        radialLayer.draw(clock, 0, state.age, centerX, centerY);
        radialDirty = false;
      }
    } else {
      if (pixelsDirty) pixelLayer.draw(clock, 0);
      if (radialDirty) radialLayer.draw(clock, 0, state.age, centerX, centerY);
      pixelsDirty = false;
      radialDirty = false;
    }
  }

  /* ---------- 标题变档动画 ---------- */

  /** 待执行的拆字 timeout：快速改档时全部清掉，旧动画不会和新动画叠在一起。 */
  const charTimers = [];
  /** 当前这轮拆字动画的 token；异步回调醒来时比对，晚到的旧回调直接退场。 */
  let labelRun = 0;

  function clearCharTimers() {
    for (const timer of charTimers) clearTimeout(timer);
    charTimers.length = 0;
  }

  /** 把档位名直接写成文本，不做动画（减少动态与首次同步都走这里）。 */
  function setLabel(text) {
    clearCharTimers();
    labelRun += 1;
    tierLabel.textContent = text;
  }

  /**
   * 拆成字符 span 逐个进场（规格 §4：每字 220ms、间隔 15ms）。
   *
   * 拆成 span 而不是整块淡入：规格明确写了"不是整个标题或卡片淡入淡出"。
   * 每个 span 的进场靠 CSS 类触发，时长与缓动都在 `galaxy-effort.css` 里，
   * 这里只负责节奏（间隔）与取消。
   *
   * 取消是**必须**的：快速从 Medium 拖到 Galaxy 会连续触发四次，旧的一批 span
   * 若还在跑，标签会同时显示好几个半透明的档位名。
   */
  function animateLabelTo(text) {
    clearCharTimers();
    labelRun += 1;
    const run = labelRun;
    tierLabel.textContent = "";
    const letters = [];
    for (const char of text) {
      // 不叫 `span`：外层闭包里 `span` 是档位跨度（`stops.length - 1`）。同名
      // 局部变量会把那个数字遮住，将来在这里多读一次"第几档"就会拿到一个
      // DOM 节点，而这种错不会报错，只会让动画按一个对象去算。
      const letter = element("span", "ge-char");
      letter.textContent = char;
      letters.push(letter);
      tierLabel.append(letter);
    }
    letters.forEach((letter, index) => {
      const timer = setTimeout(() => {
        if (run !== labelRun || !ready) return;
        letter.classList.add("ge-char-in");
      }, index * CHAR_STAGGER_MS);
      charTimers.push(timer);
    });
  }

  /* ---------- 动画帧 ---------- */

  /**
   * 还要不要继续排帧。
   *
   * **停的条件**：位置已吸附（`position === target` 且 `velocity === 0`）、
   * Galaxy 弹簧也已吸附（`g === galaxyTarget`）、并且 `g === 0`。前两条是"这两条
   * 弹簧都不动了"，第三条是"没有东西要持续绘制"。
   *
   * 为什么不只看前两条：Galaxy 档位停下来时 `g === 1`，两条弹簧都吸附了，但像素
   * 网格仍在闪、放射粒子仍在流、卡片仍有微震——全都要每帧重画。规格 §6 的
   * "普通档位停稳后无 RAF；Galaxy 需要持续绘制"就是这句话。所以只要 `g > 0`
   * 就继续跑，直到离开 Galaxy、`g` 衰减回 0 才停。
   *
   * 减少动态时根本不排帧（规格 §6：立刻吸附、取消流动）；`paint()` 会被
   * 事件直接调一次，静态像素由它画。
   */
  function wantsFrames() {
    if (!ready || reduceMotion()) return false;
    if (galaxy > 0) return true;
    return !(position === target && velocity === 0 && galaxy === galaxyTarget);
  }

  /**
   * 排下一帧。`lastStamp === null` 表示"基准待重置"：帧回调只记时间戳、不积分，
   * 于是暂停的那段（文档隐藏、离屏、减少动态切回）不会被算进 `dt`——
   * 恢复时不会出现一个几秒宽的 dt 把弹簧打飞，`clock` 与 `enteredAt` 也一直
   * 停在同一条时间线上，回来时 `age` 不会突然巨大、爆发不会凭空消失。
   */
  function schedule() {
    if (raf !== null || !wantsFrames()) return;
    raf = requestAnimationFrame(frame);
  }

  function frame(stamp) {
    raf = null;
    if (!ready) return;
    if (lastStamp === null) {
      lastStamp = stamp;
      schedule();
      return;
    }
    const dt = Math.min(MAX_DT, Math.max(0, (stamp - lastStamp) / 1000));
    lastStamp = stamp;
    clock += dt;
    step(dt);
    paint(!reduceMotion());
    schedule();
  }

  /**
   * 推进一帧的状态。
   *
   * 每条弹簧每帧只调**一次** `stepSpring`——三次子步在它内部，调用方再拆一次
   * 等于九个子步，同一个 `k` 会走出另一条曲线（见 `galaxy-effort-core.js`）。
   */
  function step(dt) {
    if (reduceMotion()) {
      position = target;
      velocity = 0;
      galaxy = galaxyTarget;
      galaxyVelocity = 0;
      return;
    }
    [position, velocity] = stepSpring(position, velocity, target, dt, POSITION_K, POSITION_DAMPING);
    [galaxy, galaxyVelocity] = stepSpring(galaxy, galaxyVelocity, galaxyTarget, dt, GALAXY_K, GALAXY_DAMPING);
  }

  /** 恢复排帧：重置时间基准（`lastStamp = null`）后再排。 */
  function resume() {
    if (!ready || raf !== null || typeof requestAnimationFrame !== "function") return;
    lastStamp = null;
    schedule();
  }

  /* ---------- 提交与档位 ---------- */

  /**
   * 提交一个整数档位：派发事件、调 `onChange`、并把内部目标指过去。
   *
   * "提交"专指用户真的选定了一档（松手、点击、键盘、`setValue` 且未 `silent`）。
   * 拖动途中的连续值只改视觉，不经过这里——否则一次拖拽会排出上百条命令。
   *
   * 单档时直接不派发：位置不可能变，发一条"用户选了那唯一一档"的命令只会让
   * 宿主以为发生过一次选择（对话框、日志、`run.json` 都会留下一条假记录）。
   */
  /**
   * 从某一格出发，落到**最近的、真的能发东西的**那一格。
   *
   * 2026-11-10 用户决定：固定六格之后，一个最低只到 `high` 的模型会在最左边
   * 留下两格没有请求值（`sends: null`）。拖到那里**吸附**到最近的可用档，而不是
   * 发一个空请求，也不是拒绝拖动——拒绝会让这两格看起来像坏掉的控件。
   *
   * 先向**上**找（更强的档），再向**下**找。向上的理由：用户拖到 `Low` 是想要
   * 更省，这个模型给不了；给它能给的最省（`high`）比回到 `Auto`（完全不提要求）
   * 更接近意图。全都不可用时退回 0（`Auto`），那是唯一永远成立的一格。
   */
  function nearestAvailable(index) {
    const at = clamp(index, 0, span);
    if (stops[at].sends !== null && stops[at].sends !== undefined) return at;
    for (let step = 1; step <= span; step += 1) {
      const up = at + step;
      if (up <= span && stops[up].sends != null) return up;
      const down = at - step;
      if (down >= 0 && stops[down].sends != null) return down;
    }
    return 0;
  }

  function commit(next) {
    if (single) return;
    const index = normaliseValue(nearestAvailable(normaliseValue(next, span)), span);
    const detail = { index, value: stops[index].value, label: stops[index].label };
    root.dispatchEvent(new CustomEvent("effort-change", {
      detail,
      bubbles: true,
      composed: true,
    }));
    if (typeof onChange === "function") onChange(detail);
  }

  /**
   * 把目标档位指到 `index`，并处理 Galaxy 的进入/离开。
   *
   * `enteredAt` 只在**进入**那一帧写一次：它定义 `age = clock - enteredAt`，
   * 每帧重写会让爆发永远停在最强的一帧，而规格 §4 要的是"进入时强而短、
   * 随后微弱"。
   *
   * 单档时是一个纯粹的赋值：目标恒为 0、`galaxyTarget` 恒为 0，指针与键盘都
   * 改不动它（入口处挡住了，这里再挡一次是因为 `setValue` 也走这条路）。
   */
  function setTarget(index, { animate = true } = {}) {
    const next = single ? 0 : clampPosition(index, span);
    const wasGalaxy = galaxyTarget === 1;
    // 判据是**最近档位**而不是"位置正好等于最高"：规格 §4 写的是「当最近档位
    // 进入 Galaxy 时」，而拖动中的位置是连续值，5.6 在六档下已经在视觉上属于
    // Galaxy（标签也已经换了），等它精确到端点才变形会让标签先到、脑形后到。
    // `galaxyIndex === -1`（没有 Galaxy 档、或它不在最高位）时整条 Galaxy 路径
    // 不跑，`galaxyTarget` 恒为 0。
    const isGalaxy = galaxyIndex !== -1 && indexAt(next, span) === galaxyIndex;
    target = next;
    if (isGalaxy && !wasGalaxy) {
      enteredAt = clock;
      galaxyTarget = 1;
    } else if (!isGalaxy) {
      galaxyTarget = 0;
    }
    if (reduceMotion()) {
      position = target;
      velocity = 0;
      galaxy = galaxyTarget;
      galaxyVelocity = 0;
      paint(false);
      return;
    }
    paint(animate);
    resume();
  }

  /* ---------- 指针 ---------- */

  /**
   * 指针在轨道内的横坐标换算成 0..span（规格 §3 的公式，上界换成当前跨度）。
   *
   * **除以实测宽度而不是写死 392**。宿主把这个控件整体 `transform: scale()`
   * 缩小时（2026-11-09：composer 里按 0.68 显示），`getBoundingClientRect()`
   * 给的是**缩放后**的尺寸，而公式里的 16 / 358 是组件自身的逻辑坐标。直接拿
   * 缩放后的 x 减 16，等于把像素和逻辑单位混着算——缩小越多，拖到同样的视觉
   * 位置得到的档位越靠右，而且只有真拖才看得出来。先按 `rect.width / 392`
   * 的比值把 x 折回逻辑坐标，缩放就与拖动无关了。
   */
  function valueAtPointer(event) {
    const rect = track.getBoundingClientRect();
    const scale = rect.width > 0 ? rect.width / TRACK_WIDTH : 1;
    const x = (event.clientX - rect.left) / scale;
    // 分子用 0..span 而不是写死 0..5：换算的是"在多少档之间取哪一档"，跨度
    // 必须与刻度、脑形用的是同一个。
    const at = span === 0 ? 0 : (x - TRACK_START_X) / (TRACK_END_X - TRACK_START_X) * span;
    return clamp(at, 0, span);
  }

  function onPointerDown(event) {
    // 单档时整条轨道不接受指针：拖不动、点不动，也不抢焦点与 pointer capture。
    // CSS 的 `pointer-events: none` 只挡真指针，键盘与脚本仍能进来，所以这里
    // 还有一道 JS 的锁。
    if (single) return;
    // 已有一个指针在拖时不抢占（规格 §3「重复触摸不抢占」）：第二根手指按下来
    // 只会让第一根还在走的那次拖拽跳一下。
    if (activePointer !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    activePointer = event.pointerId;
    startTier = indexAt(target, span);
    slider.focus();
    slider.setPointerCapture(event.pointerId);
    // 按下就跟随指针，取的是**连续值**而不是最近档：这一下既可能是点击（松手
    // 时才吸附并提交），也可能是拖拽的起点——按下先取整会让拖拽从一格半格
    // 之外弹一下再开始。`setTarget` 自己会钳进 0..span，这里不重复钳。
    setTarget(valueAtPointer(event));
  }

  function onPointerMove(event) {
    if (activePointer !== event.pointerId) return;
    event.preventDefault();
    // 拖动期间只改目标，不提交：中间值只更新视觉。
    setTarget(valueAtPointer(event));
  }

  function onPointerUp(event) {
    if (activePointer !== event.pointerId) return;
    event.preventDefault();
    activePointer = null;
    if (slider.hasPointerCapture(event.pointerId)) slider.releasePointerCapture(event.pointerId);
    // 先吸附再落位：`setTarget` 决定脑形停在哪，`commit` 决定发什么。两处
    // 用不同的下标会让脑形停在一个没有请求值的格子上，而界面显示的是另一档。
    const index = nearestAvailable(Math.round(valueAtPointer(event)));
    setTarget(index);
    commit(index);
  }

  function onPointerCancel(event) {
    if (activePointer !== event.pointerId) return;
    activePointer = null;
    if (slider.hasPointerCapture(event.pointerId)) slider.releasePointerCapture(event.pointerId);
    // 取消回到按下时的档位，且**不提交**（规格 §3）。
    setTarget(startTier);
  }

  /* ---------- 键盘 ---------- */

  /**
   * 键盘提交一档。
   *
   * 每次按键都是一个完整的提交：方向键在滑块上就是"选定这一档"，不存在
   * "按住方向键拖到一半"的中间态，所以这里直接走 `commit`。
   */
  function keyboardTo(index) {
    if (single) return;
    // 键盘与指针走同一条吸附：方向键按到没有请求值的那一格时，落点与提交
    // 都挪到最近的可用档，而不是停在空档上。
    const next = nearestAvailable(clamp(index, 0, span));
    setTarget(next);
    commit(next);
  }

  function onKeyDown(event) {
    // 单档时键盘全部无效，也不阻止默认：Tab / 空格 / 方向键在这个控件上
    // 本来就该交给页面（阻止了反而是"吞键"）。
    if (single) return;
    // 拖动中按键盘接管：先把捕获还回去，否则松手事件还会落在这个滑块上，
    // 用户已经用键盘选完了，松手却把它再改一次。
    if (activePointer !== null) {
      if (slider.hasPointerCapture(activePointer)) slider.releasePointerCapture(activePointer);
      activePointer = null;
    }
    const current = indexAt(target, span);
    let next = null;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = current - 1;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = current + 1;
        break;
      case "Home":
      case "Escape":
        next = 0;
        break;
      case "End":
        next = span;
        break;
      case "PageUp":
        next = current + 2;
        break;
      case "PageDown":
        next = current - 2;
        break;
      default:
        return;
    }
    // 全部阻止默认：方向键会滚动页面，而这里的方向键是滑块自己的。
    event.preventDefault();
    keyboardTo(next);
  }

  /* ---------- 帮助气泡 ---------- */

  /** 气泡是不是被"点击钉住"了。钉住时不因指针移开而收起。 */
  let bubblePinned = false;

  function setBubble(open) {
    bubble.hidden = !open;
    help.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) bubblePinned = false;
  }

  function onHelpClick(event) {
    event.preventDefault();
    // 点击是切换：钉住再点一次收起。指针移开不会关掉一个被点开的气泡，
    // 否则触屏上它会在抬手的那一瞬消失。
    bubblePinned = bubble.hidden;
    setBubble(bubble.hidden);
  }

  function onHelpEnter() {
    if (!bubblePinned) setBubble(true);
  }

  function onHelpLeave() {
    if (!bubblePinned) setBubble(false);
  }

  function onHelpFocus() {
    setBubble(true);
  }

  function onHelpBlur() {
    if (!bubblePinned) setBubble(false);
  }

  function onDocumentKeyDown(event) {
    if (event.key === "Escape" && !bubble.hidden) {
      setBubble(false);
      bubblePinned = false;
    }
  }

  /* ---------- 监听与观察者 ---------- */

  slider.addEventListener("pointerdown", onPointerDown);
  slider.addEventListener("pointermove", onPointerMove);
  slider.addEventListener("pointerup", onPointerUp);
  slider.addEventListener("pointercancel", onPointerCancel);
  slider.addEventListener("keydown", onKeyDown);
  slider.addEventListener("lostpointercapture", onPointerCancel);
  help.addEventListener("click", onHelpClick);
  help.addEventListener("pointerenter", onHelpEnter);
  help.addEventListener("pointerleave", onHelpLeave);
  help.addEventListener("focus", onHelpFocus);
  help.addEventListener("blur", onHelpBlur);
  document.addEventListener("keydown", onDocumentKeyDown);

  /** 文档隐藏时暂停：后台标签页里排帧只会白烧 CPU，而画出来的东西没人看。 */
  function onVisibilityChange() {
    if (document.hidden) {
      // 停帧；`lastStamp` 留给下一次 `resume` 重置（那才是"不补算"的地方）。
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    } else {
      resume();
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  /** 媒体查询变化：偏好翻了就按新偏好重算，但**不动** `target`（规格 §6）。 */
  function onMotionPreferenceChange() {
    if (reduceMotion()) {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      position = target;
      velocity = 0;
      galaxy = galaxyTarget;
      galaxyVelocity = 0;
      // 文字动画直接切到终态：一个已经在放拆字动画的标签在减少动态下继续
      // 一帧一帧地进，等于把设置关掉了一半。
      setLabel(stops[indexAt(target, span)].label);
      paint(false);
      return;
    }
    resume();
  }
  if (motionQuery !== null) {
    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", onMotionPreferenceChange);
    } else if (typeof motionQuery.addListener === "function") {
      motionQuery.addListener(onMotionPreferenceChange);
    }
  }

  /**
   * 离屏就停帧（规格 §6）。用 `threshold: 0` 是为了"露出一个像素就算在屏上"：
   * 只在完全不可见时暂停，滚动到一半的控件不会突然卡在半路。
   */
  const intersection = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) onScreen = entry.isIntersecting;
      if (onScreen) resume();
      else if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    }, { threshold: 0 })
    : null;
  if (intersection !== null) intersection.observe(root);

  /* ---------- 对外接口 ---------- */

  /**
   * 外部设置档位（宿主回写用），参数是**下标**。
   *
   * 设置的是**整数档**：这个控件的对外值域是 0..`span`，接受一个 2.6 会让界面
   * 停在半格上而 `getValue()` 说出另一个数。`position` 与 `target` 一起设，这样
   * 宿主回写不会先播一段别人没要求的动画——回写是"确认"，不是"用户操作"。
   *
   * Galaxy 的两条弹簧照常分工：普通模式下交给弹簧（脑形会从当前位置长过去），
   * 减少动态模式下直接吸附。单档时下标恒为 0，也不派发事件。
   */
  function setValue(next, settings = {}) {
    if (!ready) return;
    const index = single ? 0 : normaliseValue(next, span);
    const wasGalaxy = galaxyTarget === 1;
    const isGalaxy = galaxyIndex !== -1 && index === galaxyIndex;
    target = index;
    position = index;
    velocity = 0;
    if (isGalaxy && !wasGalaxy) enteredAt = clock;
    galaxyTarget = isGalaxy ? 1 : 0;
    if (reduceMotion()) {
      galaxy = galaxyTarget;
      galaxyVelocity = 0;
    }
    labelIndex = -1;
    paint(false);
    resume();
    if (settings.silent !== true) commit(index);
  }

  function getValue() {
    return indexAt(target, span);
  }

  /**
   * 卸载：把排帧、定时器、观察者与所有监听器放开，并把 DOM 摘掉。
   *
   * 顺序是先设 `ready = false`：观察者与定时器的回调可能已经在队列里，它们醒来
   * 时看到的第一个状态必须是"这个实例已经不在了"，否则一次晚到的 `paint` 会
   * 往已经摘掉的节点上写字，或者重新排一帧——卸载后仍在跑的东西是最难查的一类。
   */
  function destroy() {
    if (!ready) return;
    ready = false;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    clearCharTimers();
    if (intersection !== null) intersection.disconnect();
    if (motionQuery !== null) {
      if (typeof motionQuery.removeEventListener === "function") {
        motionQuery.removeEventListener("change", onMotionPreferenceChange);
      } else if (typeof motionQuery.removeListener === "function") {
        motionQuery.removeListener(onMotionPreferenceChange);
      }
    }
    slider.removeEventListener("pointerdown", onPointerDown);
    slider.removeEventListener("pointermove", onPointerMove);
    slider.removeEventListener("pointerup", onPointerUp);
    slider.removeEventListener("pointercancel", onPointerCancel);
    slider.removeEventListener("keydown", onKeyDown);
    slider.removeEventListener("lostpointercapture", onPointerCancel);
    help.removeEventListener("click", onHelpClick);
    help.removeEventListener("pointerenter", onHelpEnter);
    help.removeEventListener("pointerleave", onHelpLeave);
    help.removeEventListener("focus", onHelpFocus);
    help.removeEventListener("blur", onHelpBlur);
    document.removeEventListener("keydown", onDocumentKeyDown);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    root.remove();
  }

  /* ---------- 初始状态 ---------- */

  // 初始值也走 `setValue`：否则首次渲染与外部回写是两条路径，两处各要记得
  // 同步一次标签、无障碍名与弹簧，早晚会有一处漏掉。`silent` —— 创建控件不是
  // 用户改档，派发一个 `effort-change` 会让宿主以为用户刚选了一档。
  setValue(value, { silent: true });

  return { setValue, getValue, destroy };
}


