/**
 * 脑形思考强度滑块（Galaxy Effort Slider）—— 组件本体。
 *
 * 事实源是 `docs/specs/galaxy-effort-slider.md`：§1 的结构与尺寸、§2 的脑形
 * 与褶皱、§3 的输入与无障碍、§4 的运动、§6 的清理。所有数学（弹簧、褶皱
 * 揭示、色板插值、Galaxy 派生量）都在 `./galaxy-effort-core.js` 里，两个
 * Canvas 图层在 `./galaxy-effort-layers.js` 里——本文件不重写公式、不复制常量。
 * 复制一份的后果不是多写几行：同一次拖拽里脑形、轨道填充与粒子会各按不同公式
 * 走，那种偏差肉眼可见，却没有哪条测试抓得住。
 *
 * 顶层只有 import、常量与函数声明，不碰 `document` / `window` /
 * `requestAnimationFrame`。这不只是洁癖：`tests/desktop/*` 会在 Node 里静态
 * import 本文件，顶层一句 `document.createElement` 就让整组测试炸掉，而报错
 * 位置指的是 import 行，不是那行 DOM 代码。
 */

import {
  FOLD_LEVELS,
  TIER_NAMES,
  clamp,
  foldReveal,
  galaxyState,
  stepSpring,
  tierIndex,
  trackFillOpacity,
  trackFillStops,
  trackX,
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
 * tooltip 默认文案，逐字来自规格 §3。
 *
 * 它是**默认值**而不是硬编码：宿主可以传 `tooltip` 覆盖成已本地化的句子。默认
 * 值必须是规格原文，因为这段文字本身就是验收项。
 */
const DEFAULT_TOOLTIP = "Drag the brain or use arrow keys to choose Low, Medium, High, Extra, Max or Galaxy. Higher effort adds brain folds; Galaxy adds particles. This control uses local demo state.";

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
 * 六个刻度圆点的左右端（规格 §1：`16 + i×358/5`）。
 *
 * 与 `trackX` 共用同一对端点：刻度与脑形中心必须落在同一条映射上，两处各写
 * 一套数字的后果是脑形停在两粒刻度之间，而看起来"差不多对"。
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
 * 只留下不随位置变化的那部分：横坐标把 `16 + position/5×358` 让给
 * `trackX(position)`（那是轨道与脑形共用的唯一一份映射），常量只剩 `100 + 22`；
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

/** 轨道最右一格的下标。写成 `TIER_NAMES.length - 1`，增删档位时不用再找一遍。 */
const LAST_TIER = TIER_NAMES.length - 1;

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

/** 把任意输入折成 0..5 的整数档位（提交与外部回写用）。 */
function normaliseValue(raw) {
  const number = Number(raw);
  if (!Number.isFinite(number)) return 0;
  return clamp(Math.round(number), 0, LAST_TIER);
}

/**
 * 拖拽途中的目标：钳进 0..5，但**保留小数**。
 *
 * 拖动是连续量。在这里取整会让轨道填充与褶皱一格一格地跳，弹簧也跟着变成
 * 六段阶梯——规格 §4 的"禁止用两张静帧淡入冒充移动"说的正是这件事。
 */
function clampPosition(raw) {
  const number = Number(raw);
  if (!Number.isFinite(number)) return 0;
  return clamp(number, 0, LAST_TIER);
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
 * @param {{
 *   mount: Element | string,
 *   value?: number,
 *   reducedMotion?: boolean,
 *   tooltip?: string,
 *   onChange?: (detail: { value: number, level: string }) => void,
 * }} options
 * @returns {{
 *   setValue: (value: number, settings?: { silent?: boolean }) => void,
 *   getValue: () => number,
 *   destroy: () => void,
 * }}
 */
export function createGalaxyEffort(options = {}) {
  const {
    mount,
    value = 0,
    reducedMotion = false,
    tooltip = DEFAULT_TOOLTIP,
    onChange,
  } = options;

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
  const card = element("div", "ge-card");

  const title = element("div", "ge-title");
  const titleName = element("span", "ge-title-name");
  titleName.textContent = "Effort";
  const tierLabel = element("span", "ge-tier");
  tierLabel.textContent = TIER_NAMES[0];
  title.append(titleName, tierLabel);

  const help = element("button", "ge-help");
  help.type = "button";
  help.setAttribute("aria-expanded", "false");
  help.append(buildHelpIcon());

  const bubble = element("div", "ge-tooltip");
  bubble.id = "ge-tooltip-" + Math.random().toString(36).slice(2, 9);
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  bubble.textContent = tooltip;
  help.setAttribute("aria-controls", bubble.id);

  const scale = element("div", "ge-scale");
  const faster = element("span", "ge-faster");
  faster.textContent = "Faster";
  const smarter = element("span", "ge-smarter");
  smarter.textContent = "Smarter";
  scale.append(faster, smarter);

  const recommended = element("div", "ge-recommended");
  recommended.textContent = "Recommended";

  const slider = element("div", "ge-slider");
  // 触屏上必须自己吃掉手势，否则拖动会先滚动页面、`pointermove` 中途被取消。
  // 写在元素上而不是只靠 CSS：这是**行为**而不是外观，样式表没加载时拖拽也得能用。
  slider.style.touchAction = "none";
  slider.setAttribute("role", "slider");
  slider.setAttribute("tabindex", "0");
  slider.setAttribute("aria-valuemin", "0");
  slider.setAttribute("aria-valuemax", String(LAST_TIER));
  slider.setAttribute("aria-valuenow", "0");
  slider.setAttribute("aria-valuetext", TIER_NAMES[0]);
  slider.setAttribute("aria-orientation", "horizontal");
  slider.setAttribute("aria-label", "Effort");

  const track = element("div", "ge-track");
  // 轨道在命中区里的上偏移写在元素上，与 CSS 里的 `top: 15px` 同源（`TRACK_TOP`）
  // ——两处各写一个 15 的话，改规格时只改一处，脑形与轨道就会错开一格。
  track.style.top = `${TRACK_TOP}px`;
  const trackFill = element("div", "ge-track-fill");
  const dots = element("div", "ge-track-dots");
  for (let index = 0; index <= LAST_TIER; index += 1) {
    const dot = element("i", index === 1 ? "ge-dot ge-dot-tall" : "ge-dot");
    dot.style.left = `${TRACK_START_X + index * (TRACK_END_X - TRACK_START_X) / LAST_TIER - 3}px`;
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
  card.append(title, help, bubble, scale, recommended, radialCanvas, slider);
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
    const x = trackX(position);
    const index = tierIndex(target);

    // 轨道填充：宽度跟着连续位置走，颜色是五个色标的横向渐变。
    // 两件事都不能"只在换档时刷"——规格 §4 要的是随实际位置连续变化，
    // 中途反向时前缘颜色要顺着当时的颜色回去，不能先跳档再回来。
    const stops = trackFillStops(position);
    trackFill.style.width = `${x}px`;
    trackFill.style.opacity = String(trackFillOpacity(state.g));
    trackFill.style.background = `linear-gradient(90deg, ${stops[0]} 0%, ${stops[1]} 30%, ${stops[2]} 60%, ${stops[3]} 90%, ${stops[4]} 100%)`;

    // 脑形：始终是同一个 SVG，只改派生属性（规格 §4「进出保留同一 SVG」）。
    // 坐标相对**命中区**（脑形的父节点），`trackX` 给的正是命中区内的横坐标；
    // 减去半径让 48px 的盒子以中心对齐。
    brain.wrap.style.left = `${x - BRAIN_HALF}px`;
    brain.wrap.style.top = `${BRAIN_CENTER_Y - BRAIN_HALF}px`;
    brain.wrap.style.transform = `scale(${state.scale})`;
    brain.wrap.style.setProperty("--ge-brain-fill", state.fill);
    brain.wrap.style.setProperty("--ge-brain-stroke", state.stroke);
    brain.wrap.style.setProperty("--ge-glow-a", `${state.glow[0]}px`);
    brain.wrap.style.setProperty("--ge-glow-b", `${state.glow[1]}px`);
    brain.wrap.style.setProperty("--ge-glow-strength", String(state.g));

    // 褶皱：同一批节点，只改 opacity 与 --ge-fold-hidden。第 N 层的 level 就是
    // 它的展开窗口中心，所以每层都拿同一个 position 各自算一次 reveal。
    for (const group of brain.folds) {
      const reveal = foldReveal(position, Number(group.dataset.tier));
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
      if (animateLabel) animateLabelTo(TIER_NAMES[index]);
      else setLabel(TIER_NAMES[index]);
    }
    const label = TIER_NAMES[index];
    tierLabel.classList.toggle("ge-tier-galaxy", index === LAST_TIER);
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
    const spans = [];
    for (const char of text) {
      const span = element("span", "ge-char");
      span.textContent = char;
      spans.push(span);
      tierLabel.append(span);
    }
    spans.forEach((span, index) => {
      const timer = setTimeout(() => {
        if (run !== labelRun || !ready) return;
        span.classList.add("ge-char-in");
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
   */
  function commit(next) {
    const index = normaliseValue(next);
    const detail = { value: index, level: TIER_NAMES[index] };
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
   */
  function setTarget(index, { animate = true } = {}) {
    const next = clampPosition(index);
    const wasGalaxy = galaxyTarget === 1;
    // 判据是**最近档位**而不是"位置正好等于 5"：规格 §4 写的是「当最近档位进入
    // Galaxy 时」，而拖动中的位置是连续值，4.6 已经在视觉上属于 Galaxy（标签也
    // 已经换了），等它精确到 5 才变形会让标签先到、脑形后到。
    const isGalaxy = tierIndex(next) === LAST_TIER;
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
   * 指针在轨道内的横坐标换算成 0..5（规格 §3 的公式，逐字）。
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
    return clamp((x - TRACK_START_X) / (TRACK_END_X - TRACK_START_X) * LAST_TIER, 0, LAST_TIER);
  }

  function onPointerDown(event) {
    // 已有一个指针在拖时不抢占（规格 §3「重复触摸不抢占」）：第二根手指按下来
    // 只会让第一根还在走的那次拖拽跳一下。
    if (activePointer !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    activePointer = event.pointerId;
    startTier = tierIndex(target);
    slider.focus();
    slider.setPointerCapture(event.pointerId);
    // 按下就跟随指针，取的是**连续值**而不是最近档：这一下既可能是点击（松手
    // 时才吸附并提交），也可能是拖拽的起点——按下先取整会让拖拽从一格半格
    // 之外弹一下再开始。
    setTarget(clampPosition(valueAtPointer(event)));
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
    const index = Math.round(valueAtPointer(event));
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
    const next = clamp(index, 0, LAST_TIER);
    setTarget(next);
    commit(next);
  }

  function onKeyDown(event) {
    // 拖动中按键盘接管：先把捕获还回去，否则松手事件还会落在这个滑块上，
    // 用户已经用键盘选完了，松手却把它再改一次。
    if (activePointer !== null) {
      if (slider.hasPointerCapture(activePointer)) slider.releasePointerCapture(activePointer);
      activePointer = null;
    }
    const current = tierIndex(target);
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
        next = LAST_TIER;
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
      setLabel(TIER_NAMES[tierIndex(target)]);
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
   * 外部设置档位（宿主回写用）。
   *
   * 设置的是**整数档**：这个控件的对外值域就是 0..5，接受一个 2.6 会让界面停在
   * 半格上而 `getValue()` 说出另一个数。`position` 与 `target` 一起设，这样
   * 宿主回写不会先播一段别人没要求的动画——回写是"确认"，不是"用户操作"。
   *
   * Galaxy 的两条弹簧照常分工：普通模式下交给弹簧（脑形会从当前位置长过去），
   * 减少动态模式下直接吸附。
   */
  function setValue(next, settings = {}) {
    if (!ready) return;
    const index = normaliseValue(next);
    const wasGalaxy = galaxyTarget === 1;
    const isGalaxy = index === LAST_TIER;
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
    return tierIndex(target);
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


