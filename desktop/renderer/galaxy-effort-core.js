/**
 * 脑形思考强度滑块里所有能脱离 DOM 断言的数学。
 *
 * 事实源是 `docs/specs/galaxy-effort-slider.md`（§2 的褶皱分层、§4 的弹簧与
 * 取色、§5 的确定性哈希）。组件本体（`galaxy-effort.js`）与两个 Canvas 图层
 * （`galaxy-effort-layers.js`）都从这里取同一份实现——复制一份到别处的后果不是
 * "多写了几行"，而是同一次拖拽里脑形、轨道填充与粒子各自按不同公式走：那种
 * 偏差肉眼就能看见，却没有哪一条测试抓得住。
 *
 * 常量是规格的**逐字抄写**，没有在这里重新推导或"优化"。颜色与尺寸是用户逐条
 * 核对的验收依据，调参属于改规格，不属于改实现。
 *
 * 顶层只有常量、函数声明与 import，不碰 `document` / `window` /
 * `requestAnimationFrame`：`tests/desktop/*` 会静态 import 本文件，那里没有 DOM。
 */

/** 六个档位名，索引与轨道从左到右的六格一一对应（规格 §3）。 */
export const TIER_NAMES = ["Low", "Medium", "High", "Extra", "Max", "Galaxy"];

/**
 * 递增褶皱的五层，逐字来自规格 §2 的 JSON。
 *
 * `paths` 里的每条路径在**左右半球各实例化一次**，所以一层的路径贡献要乘 2；
 * `width` 是该层描边宽度（2.8 递减到 1.9），主沟的 4.2 是另一条固定路径，不在这
 * 张表里。
 */
export const FOLD_LEVELS = [
  { level: 1, width: 2.8, paths: ["M29 25Q28 21 24 21C20 21 18 17 21 14"] },
  { level: 2, width: 2.6, paths: ["M28 42C23 39 19 41 20 45Q21 48 25 47"] },
  { level: 3, width: 2.5, paths: ["M12 28C15 25 19 26 20 29Q21 33 17 34"] },
  { level: 4, width: 2.2, paths: ["M21 21Q18 19 15 22", "M20 53Q24 55 27 51"] },
  { level: 5, width: 1.9, paths: ["M10 36Q13 34 16 37", "M24 35Q27 37 25 40"] },
];

/**
 * 轨道填充的四组五色标，逐字来自规格 §4 的 JSON。
 *
 * 四组依次对应 Medium、High、Extra、Max；Low 到 Medium 用第一组，Max 到
 * Galaxy 用第四组再配 `1 - g` 淡出。每组五个色标固定落在
 * 0% / 30% / 60% / 90% / 100%，所以这里只存颜色、不存位置——位置一旦写进
 * 数据结构，两个消费者（渐变与测试）就有机会各写一套。
 */
export const TRACK_PALETTES = [
  [[49, 42, 45], [86, 57, 76], [125, 73, 112], [161, 89, 146], [175, 94, 157]],
  [[49, 42, 45], [81, 55, 76], [112, 69, 107], [143, 83, 139], [153, 87, 150]],
  [[49, 42, 45], [78, 56, 74], [108, 69, 110], [129, 84, 149], [136, 90, 163]],
  [[49, 42, 45], [77, 56, 74], [102, 67, 111], [118, 84, 153], [124, 90, 167]],
];

/**
 * 像素层与放射粒子的六色循环（规格 §5）。
 *
 * 用十六进制字符串而不是 RGB 三元组：两个 Canvas 图层直接把它赋给
 * `ctx.fillStyle`，中间再转一次只会多一个出错的地方。
 */
export const PIXEL_PALETTE = ["#80d5d8", "#dc8cd5", "#b3a3e8", "#7061b5", "#f4c1eb", "#6656a0"];

/**
 * 主沟的路径数。
 *
 * 左右半球各一条复合路径（`M30 27…M10 43…M16 12…` 是**一条** path 里的三个
 * 子路径，不是三条）。它不属于任何一层褶皱、也不随档位增减，但规格 §4 的
 * "可见褶皱路径数"把它算在内，所以每一档的计数都从 2 起头。
 */
const BASE_FOLD_PATHS = 2;

/**
 * 一层褶皱从"还没画出来"变成"算一条可见路径"的那一点。
 *
 * 六档静止时每层的 `reveal` 恰好是 0 或 1（窗口两端都在整数档位之外），所以
 * 任何严格落在 `(0, 1)` 里的阈值都会得到 2 / 4 / 6 / 8 / 12 / 16 这六个同样的
 * 数字——阈值本身不改变六档的验收值。取 `.5` 是因为它是 smoothstep 的对称点，
 * 把切换放在相邻两档的正中（`position = level - .5`），拖动时计数在两档中间
 * 换手，而不是贴着某一档才开始。
 */
const VISIBLE_REVEAL = 0.5;

/** 把数值钳进 `[min, max]`。 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 把连续位置折到最近的档位索引。
 *
 * 用 `round` 而不是 `floor`：位置 4.6 在视觉上已经属于 Galaxy（脑形停在两格之间
 * 靠右的地方），向下取整会让标签停在上一个档位、和用户看到的位置对不上。
 */
export function tierIndex(position) {
  return Math.round(clamp(position, 0, TIER_NAMES.length - 1));
}

/**
 * 档位名，越界钳到两端。
 *
 * 先取整再查表：`TIER_NAMES[2.7]` 是 `undefined`，而标签一旦拿到 `undefined`
 * 就会把它打印进界面（R3）。主要调用方 `tierIndex` 已经交出整数，这里的取整是
 * 对**接口**的防御——参数名就叫 `index`，别人也会照着传小数进来。
 */
export function tierName(index) {
  const position = Math.round(clamp(Number(index), 0, TIER_NAMES.length - 1));
  return TIER_NAMES[Number.isFinite(position) ? position : 0];
}

/**
 * 轨道内的横坐标：`16 + position/5 × 358`（规格 §4）。
 *
 * 刻度圆点与脑形中心共用这一条映射，所以它只能有一份实现。
 */
export function trackX(position) {
  return 16 + clamp(position, 0, 5) / 5 * 358;
}

/**
 * 某一层褶皱的揭示程度，`0` 到 `1`。
 *
 * `u = clamp((p - level + .85) / .7, 0, 1)`，再过一个 smoothstep
 * `u²(3 - 2u)`：两端速度为零，线条"起笔"和"收笔"都不会突然跳。
 * 每层因此有一段 0.7 宽的展开窗口（第 1 层 0.15→0.85，第 2 层 1.15→1.85……）。
 * 窗口**互不相交**：第 N 层在 `N - 0.15` 收笔，第 N+1 层要到 `N + 0.15` 才起笔，
 * 中间空 0.3。所以任一时刻最多只有一层在生长，不会出现两层同时半透明、看起来
 * 比两端都淡的中间态。
 *
 * 回拉不需要另一套公式：这里是位置的无状态函数，位置减小它就自己收回去。
 */
export function foldReveal(position, level) {
  const p = clamp(position, 0, 5);
  const u = clamp((p - level + 0.85) / 0.7, 0, 1);
  return u * u * (3 - 2 * u);
}

/**
 * 当前可见的褶皱路径数（规格 §4：六档为 2、4、6、8、12、16）。
 *
 * 数的是**路径**而不是层：第 4、5 层各有两条路径，且每条都在左右半球各画一次，
 * 所以一层贡献 `paths.length × 2`。推导方式是"基础 2 条 + 已揭示各层的贡献"，
 * 没有一张 2/4/6/8/12/16 的查表——查表会在改 FOLD_LEVELS 时悄悄说错话。
 *
 * 左右镜像**不额外乘 2**：×2 已经在上面的 `paths.length × 2` 里，并且基础主沟
 * 的 2 也是左右各一条。这个数列本身就是最终可见路径数。
 */
export function foldVisibleCount(position) {
  let paths = BASE_FOLD_PATHS;
  for (const tier of FOLD_LEVELS) {
    if (foldReveal(position, tier.level) >= VISIBLE_REVEAL) paths += tier.paths.length * 2;
  }
  return paths;
}

/**
 * 确定性伪随机：`fract(sin(n × 127.1 + 311.7) × 43758.5453)`（规格 §5）。
 *
 * 不用 `Math.random()`：两个 Canvas 图层每帧都要问"这一格该不该画"。随机源一旦
 * 不确定，同一 `clock` 画两次就会得到两张不同的图——测试无法复现，动画也会
 * 变成每秒 60 次重新掷骰子，而不是"闪动"。
 *
 * `x - Math.floor(x)` 而不是 `x % 1`：`sin` 为负时后者返回负数，`[0, 1)` 的值域
 * 会被悄悄撑成 `(-1, 1)`，密度与色板索引都会算错。
 */
export function hash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * `rgb(r, g, b)` 字符串。
 *
 * 三个通道取整：CSS 也接受小数通道，但 `rgb(212.5, 148, 225.5)` 这种字符串
 * 在下游（SVG 属性、渐变拼接、测试断言、日志）只会变成难以比较的东西，而这点
 * 小数在这个对比度下看不出来。
 */
function rgbString(r, g, b) {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/**
 * 轨道填充的五个色标，位置依次是 0% / 30% / 60% / 90% / 100%（规格 §4）。
 *
 * `t = clamp(position - 1, 0, 3)`、`index = min(2, floor(t))`、`blend = t - index`，
 * 逐通道在 `palette[index]` 与 `palette[index + 1]` 之间线性插值。
 *
 * 注意 `index` 封顶在 2 而 `index + 1` 因此能取到 3：`t` 走到 3 时混合的是第三组
 * 与第四组，`blend` 正好到 1，落点就是第四组本身。四组色板正好够用，不需要第五组。
 *
 * 颜色随连续位置走、不随标签跳：拖到一半反向时，前缘颜色必须从它当时所在的
 * 位置顺势回去，而不是先跳到某个档位再回来。
 */
export function trackFillStops(position) {
  const t = clamp(position - 1, 0, 3);
  const index = Math.min(2, Math.floor(t));
  const blend = t - index;
  const from = TRACK_PALETTES[index];
  const to = TRACK_PALETTES[index + 1];
  return from.map((stop, i) => rgbString(
    stop[0] + (to[i][0] - stop[0]) * blend,
    stop[1] + (to[i][1] - stop[1]) * blend,
    stop[2] + (to[i][2] - stop[2]) * blend,
  ));
}

/**
 * 普通渐变的不透明度：`1 - g`（规格 §4「Galaxy 填充透明度 `g`，普通渐变
 * 透明度 `1 - g`」）。
 *
 * 参数是 **`g`**（Galaxy 弹簧的当前值）而不是 `position`：轨道上同时有两个连续
 * 量——档位位置和 Galaxy 强度，它们是两条独立的弹簧，进入/离开 Galaxy 时 `g`
 * 会比位置晚一步到位。如果这里收 `position` 再自己折成 `g`，两个值就会在过渡
 * 期间说不同的话：填充按位置淡出、脑形按 `g` 放大，中间那几帧的配色没有依据。
 */
export function trackFillOpacity(g) {
  return 1 - clamp(g, 0, 1);
}

/**
 * 走一帧弹簧，返回 `[position, velocity]`。
 *
 * `dt` 已由调用方钳到 `min(.032, 实际秒数)`；这里把这一帧拆成**三个**
 * `dt / 3` 的子步，每个子步先积分速度再积分位置（半隐式欧拉）。
 *
 * 为什么非拆不可：实测同样一帧 32 ms、`k=420`、`damping=32`，单步会冲出
 * 1.086 → **2.150**，三个子步是 1.086 → 1.086——单步在 30 fps 下会把"平滑跟随"
 * 变成"每帧甩过头再弹回来"，而 32 ms 的钳位正是为慢帧准备的。子步数写死 3
 * 而不是按 `dt` 动态拆：固定拆分的轨迹在 60 fps 与 30 fps 下形状一致，动态拆分
 * 会让同一个拖拽在两个刷新率上走出两条曲线。
 *
 * 吸附条件 `|target - p| < .0002 && |v| < .002` 时直接返回 `[target, 0]`：弹簧
 * 尾巴是指数衰减，不吸附就永远差一点，普通档位也就永远停不下 RAF。
 *
 * 纯函数：不改入参（数字本来就是值），只返回新的一对数。
 */
export function stepSpring(position, velocity, target, dt, k, damping) {
  const step = dt / 3;
  let p = position;
  let v = velocity;
  for (let i = 0; i < 3; i += 1) {
    v += ((target - p) * k - v * damping) * step;
    p += v * step;
  }
  if (Math.abs(target - p) < 0.0002 && Math.abs(v) < 0.002) return [target, 0];
  return [p, v];
}

/**
 * Galaxy 档位的全部派生状态（规格 §4）。
 *
 * `g = clamp(galaxy, 0, 1)`、`age = max(0, clock - enteredAt)`、
 * `burst = exp(-age × 6) × g`——进入瞬间的爆发，之后按指数退去；`scale` 与
 * `glow` 都由它额外加成，所以"放大并发光"和"短促震动"是同一个衰减源的三种表现，
 * 不会出现一个已经停了、另一个还在动。
 *
 * `age` 取 `max(0, …)`：`enteredAt` 由进入 Galaxy 的那一帧写入，时钟若因暂停恢复
 * 而落在它前面，负的 `age` 会让 `exp` 变成 > 1 的放大系数，卡片反而越震越猛。
 *
 * `fill` / `stroke` 直接是 CSS `rgb()` 字符串：它们要进 SVG 的 `fill` /
 * `stroke` 属性，调用方不该再做一次格式转换。
 */
export function galaxyState(galaxy, clock, enteredAt) {
  const g = clamp(galaxy, 0, 1);
  const age = Math.max(0, clock - enteredAt);
  const burst = Math.exp(-age * 6) * g;
  return {
    g,
    age,
    burst,
    scale: 1 + 0.25 * g + 0.2 * burst,
    fill: rgbString(255 - 85 * g, 146 + 4 * g, 206 + 39 * g),
    stroke: rgbString(101 - 45 * g, 14 + 2 * g, 60 + 77 * g),
    glow: [4 + 10 * burst, 9 + 15 * burst],
    shake: g * (0.28 + Math.exp(-age * 7) * 2.1),
  };
}
