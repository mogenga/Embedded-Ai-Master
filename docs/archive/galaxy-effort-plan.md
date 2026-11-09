# 脑形思考强度滑块（Galaxy Effort Slider）—— 实施计划（2026-11-09）

> 用户原话（2026-11-09，逐字）：
> 「1. 思考强度面板：'''从零实现"脑形滑块粒子增强"。一个深灰设置卡片里，粉红脑形滑块依次经过
> Low、Medium、High、Extra、Max、Galaxy 六档；思考强度越高，脑形中的褶皱从主沟、支沟到细褶皱
> 逐层增加。进入 Galaxy 后，轨道变成闪动的紫蓝像素网格，脑形放大并发光，方形粒子沿多条射线向外
> 流动，卡片短促震动。此控件只保存本地设置，不执行真实推理请求。'''」（后附完整规格，见下）
>
> **完整规格（唯一事实源）**：`docs/specs/galaxy-effort-slider.md`。本文只定任务边界与接口，
> 数值、颜色、路径、算法一律以那份规格为准，不得自行"优化"。

## 已核对的仓库事实（2026-11-09）

| 事实 | 证据 |
|---|---|
| 渲染层是纯 ES 模块，无框架、无打包器、无构建步骤 | `AGENTS.md` 硬约束 |
| 现有思考强度控件是 `#effort-control` + `#effort-panel` 的六档 `<input type="range">` | `desktop/renderer/index.html:455-495`、`app.js:2906-3023` |
| 宿主已能报告六档、折算表与"不支持"说明 | `desktop/host/host.js:988` 的 `effortChoices()` |
| 仓库**没有 jsdom**，也不打算为此引入依赖 | `tests/desktop/effort-slider.test.js:16-26` 的注释 |
| `check:js` 会做模块导出链接检查，相对 import 缺文件会报错 | `scripts/check-js-syntax.mjs:173-212` |
| 渲染层文件在 `tsc` 与 `vitest` 之外，只有 `check:js` 兜语法 | 同上，文件头注释 |

## 本计划的范围

**只做组件本体与独立演示页，不接进 composer。** 理由：规格写的是 945×516 独立舞台 + 440×258
卡片，而 composer 里的弹出面板只有 268px 宽。把现有可用控件换成一个大卡片是产品决定，
未经确认不擅自替换。第 4 步做完后由用户看效果再决定是否接线。

## 约束（每个任务的 brief 都原样带着）

- **禁止任何依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。需要装东西就停下来报告。
- **禁止在宿主机真实执行危险命令做测试**；任何测试都不得真跑破坏性命令。
- **子代理不得执行任何 git 写操作**（`add` / `commit` / `reset` / `checkout` / `stash` / `switch` / `branch` / `worktree` / `merge`）。只读的 `git status` / `git diff` / `git log` 可以。
- **写文件只用 Write/Edit 工具**，不要用 `node -e` / `bash -c` 拼含反引号、`$()`、`${}` 的文本。
- 不得调大 `vitest.config.ts` 的超时，不得删改既有断言（可以新增）。
- **不得真实调用外部模型网关 / 触网**。
- 不得修改 `docs/BACKLOG.md`、`AGENTS.md`、`dev-notes/`、`docs/archive/**`、`docs/specs/**`、`desktop/renderer/app.js`、`desktop/renderer/index.html`、`desktop/host/**`。
- 渲染层**无框架、无打包器、无构建步骤**：不得引入 React/Vue/Svelte、不得引入 canvas 库或动画库。只用原生 DOM + CSS + Canvas 2D。
- **模块 import 时不得触碰 `document` / `window` / `requestAnimationFrame`**——所有 DOM 操作推迟到工厂函数调用时。否则 `tests/desktop/*` 静态导入会炸。

## 文件归属（并行任务之间不得写同一个文件）

| 任务 | 独占写入 |
|---|---|
| Task 1 | `desktop/renderer/galaxy-effort-core.js`、`tests/desktop/galaxy-effort-core.test.js` |
| Task 2 | `desktop/renderer/galaxy-effort-layers.js`、`tests/desktop/galaxy-effort-layers.test.js` |
| Task 3 | `desktop/renderer/galaxy-effort.js`、`desktop/renderer/galaxy-effort.css`、`tests/desktop/galaxy-effort.test.js` |
| Task 4 | `desktop/renderer/galaxy-effort-demo.html`、`tests/desktop/galaxy-effort-demo.test.js` |

---

### Task 1 · 纯函数核心（`galaxy-effort-core.js`）

**目标**：把规格里所有"能脱离 DOM 断言"的数学拆出来，成为其余三个任务共同依赖的唯一实现。
**不依赖任何其他新文件**，可以立刻开工。

必须导出（名字与签名固定，下游按这个写）：

```js
export const TIER_NAMES = ["Low", "Medium", "High", "Extra", "Max", "Galaxy"];
export const FOLD_LEVELS = [
  { level: 1, width: 2.8, paths: ["M29 25Q28 21 24 21C20 21 18 17 21 14"] },
  { level: 2, width: 2.6, paths: ["M28 42C23 39 19 41 20 45Q21 48 25 47"] },
  { level: 3, width: 2.5, paths: ["M12 28C15 25 19 26 20 29Q21 33 17 34"] },
  { level: 4, width: 2.2, paths: ["M21 21Q18 19 15 22", "M20 53Q24 55 27 51"] },
  { level: 5, width: 1.9, paths: ["M10 36Q13 34 16 37", "M24 35Q27 37 25 40"] },
];
export const TRACK_PALETTES = [ /* 四组五色标，见规格 §4 */ ];
export const PIXEL_PALETTE = ["#80d5d8", "#dc8cd5", "#b3a3e8", "#7061b5", "#f4c1eb", "#6656a0"];

export function clamp(value, min, max);
export function tierIndex(position);              // round(clamp(position, 0, 5))
export function tierName(index);                  // TIER_NAMES[clamp(index,0,5)]，越界钳位
export function trackX(position);                 // 16 + clamp(position,0,5)/5*358
export function foldReveal(position, level);      // u=clamp((p-level+.85)/.7,0,1); u*u*(3-2*u)
export function foldVisibleCount(position);       // 见下
export function hash01(n);                        // fract(sin(n*127.1+311.7)*43758.5453)
export function trackFillStops(position);         // 五个 "rgb(r, g, b)" 字符串
export function trackFillOpacity(position);       // Galaxy 时的 1-g，由调用方传 g；见规格 §4
export function stepSpring(position, velocity, target, dt, k, damping);  // -> [position, velocity]
export function galaxyState(galaxy, clock, enteredAt);                   // -> 见下
```

- `foldVisibleCount(position)`：静止在六档时可见褶皱**路径数**为 `2, 4, 6, 8, 12, 16`
  （含左右两条基础复合路径，不计脑形轮廓）。由 `foldReveal` 的阈值推导，不要写死数组以外的映射。
- `galaxyState(galaxy, clock, enteredAt)` 返回
  `{ g, age, burst, scale, fill, stroke, glow: [r1, r2], shake }`，数值按规格 §4 的公式：
  `g = clamp(galaxy,0,1)`、`age = max(0, clock-enteredAt)`、`burst = exp(-age*6)*g`、
  `scale = 1 + .25g + .2burst`、`fill = rgb(255-85g, 146+4g, 206+39g)`、
  `stroke = rgb(101-45g, 14+2g, 60+77g)`、`glow = [4+10burst, 9+15burst]`、
  `shake = g*(.28 + exp(-age*7)*2.1)`。
- `stepSpring` 必须是**纯函数**（返回新值，不改参数对象），且实现规格里的三次子步：
  `dt` 已在调用方被 `min(.032, 实际秒数)` 钳过，这里是 `dt/3` 三次。

**测试**（`tests/desktop/galaxy-effort-core.test.js`）：
- `hash01` 确定性：同输入同输出、值域 `[0,1)`、对 1000 个输入无 NaN。
- `stepSpring`：target=5 从 0 起，若干帧后单调逼近且不过冲；`dt=0` 不动；快速反向时速度不突变（连续性断言）。
- `foldReveal`：`position=1` 时 level 1 接近 1、level 2 为 0；`position=5` 时五层全开；回拉对称。
- `foldVisibleCount` 六档为 `2,4,6,8,12,16`。
- `trackFillStops`：`position=1` 用第一组、`position=4` 用第四组、`position=2.5` 是前两组按 `.5` 混合；
  每个色标是合法 `rgb()` 字符串；`position=0` 时首标接近 `rgb(49,42,45)`。
- `galaxyState`：`g=0` 时 `scale=1`、`shake=0`、fill 是 `rgb(255,146,206)`；
  `g=1, age=0` 时 `burst=1`、`scale=1.45`；`age` 很大时 `burst→0`、`shake→.28`。

---

### Task 2 · 两个 Canvas 图层（`galaxy-effort-layers.js`）

**目标**：把规格 §5 的像素网格与放射粒子做成两个可独立测试的图层。**不依赖 Task 1 之外的任何新文件**，
但**必须**从 `./galaxy-effort-core.js` import `hash01` 与 `PIXEL_PALETTE`（Task 1 同时开工，
接口已在上文钉死；如果 import 时报文件不存在，说明 Task 1 还没落盘，**等它**，不要自己复制一份常量）。

必须导出：

```js
export function createPixelLayer(canvas, ctx);   // -> { draw(clock, g) }
export function createRadialLayer(canvas, ctx);  // -> { draw(clock, g, age, centerX, centerY) }
```

- `ctx` 可省略（省略时 `canvas.getContext("2d")`）；传进来是为了测试。
- **像素层**：49 列 × 5 行、画布 392×40、`n=row*49+col`、`seed=hash01(n+7)`、
  `wave=.5+.5*sin(clock*(2+3*seed)+n*1.618)`、`density=.14+.78*(col/48)**1.6`、
  跳过条件 `seed > density + .16*sin(clock*1.8+col*.2)`、
  `alpha=g*(.18+.72*wave)*(.22+.78*col/48)`、颜色 `PIXEL_PALETTE[floor(hash01(n+211)*6)]`、
  位置 `(col*8+1, row*8+.5)`、圆角 1.3、边长 `seed>.74 ? 5.7 : 5.1`。
- **放射层**：画布 640×390、26 条射线、角度 `ray*2.399963`、`seed=hash01(ray+94)`、
  `speed=15+24*seed`、每条 7 个方块、`radius=27+((dot*13+clock*speed+seed*40)%87)+exp(-age*5)*dot*3`、
  `fade=(1-clamp((radius-27)/110,0,1))**1.6`、`pulse=.45+.55*sin(clock*4+ray+dot)**2`、
  边长 `seed>.65 ? 3 : 2`、`alpha=g*fade*pulse*(.4+.35*exp(-age*5))`、颜色按 `(ray+dot)%6` 循环。
- 每帧先 `clearRect` 整个画布。`g === 0` 时只清屏、不画任何方块（离开 Galaxy 要"退干净"）。
- 用 `ctx.roundRect` 若可用，否则退化为 `fillRect`（测试里给假 ctx，两种都要能跑）。

**测试**：用**假 ctx**（记录每次 `fillRect` / `roundRect` / `clearRect` / `fillStyle`），
不要真的画。
- `g=0`：`draw` 后只有 `clearRect`，零次 fill。
- `g=1`：像素层画出的方块数在合理区间（> 50 且 < 245），全部落在 392×40 内。
- 同一 `clock` 两次 `draw` 结果逐项相同（确定性）；不同 `clock` 结果不同（在动）。
- 放射层：26 条射线 × 7 方块最多 182 个，`g=1, age=0` 时数量显著多；全部坐标在 640×390 内。
- 色板取自 `PIXEL_PALETTE`（断言 `fillStyle` 落在该集合内）。

---

### Task 3 · 组件本体（`galaxy-effort.js` + `galaxy-effort.css`）

**依赖**：Task 1 与 Task 2 落盘后才能开工。
**目标**：规格 §1–§4、§6 的全部 DOM / 交互 / 运动 / 生命周期。

必须导出：

```js
export function createGalaxyEffort(options);
// options: { mount, value = 0, reducedMotion = false, tooltip = "…规格原文…", onChange }
// 返回: { setValue(v, { silent }), getValue(), destroy() }
```

- `mount` 可以是元素或选择器字符串。组件自建卡片、SVG、Canvas，不依赖宿主页样式。
- 交互：指针按下（轨道或脑形）、pointer capture、`touch-action:none`、拖动换算、松手吸附、
  `pointercancel` 回到按下档位、重复触摸不抢占；点击按最近档吸附；键盘
  ←/↓ 减一、→/↑ 加一、`Home`/`Escape` 回 0、`End` 到 5、`PageUp`/`PageDown` ±2，
  全部 `preventDefault`；焦点轮廓 `2px #b591ff` offset 4。
- 每次**提交**在根节点派发冒泡且 `composed: true` 的 `effort-change`，
  `detail = { value, level }`；拖动中间值不派发。
- `onChange` 选项存在时也调用（同参数）。
- 一个 `requestAnimationFrame` 循环：`dt = min(.032, 实际秒数)`，每帧三次子步（交给 `stepSpring`）。
  普通档位停稳后停 RAF；Galaxy 期间持续。`document.hidden` / 离屏（IntersectionObserver）时暂停，
  恢复时不补算暂停时间。
- 褶皱跟随实际 `position`（`foldReveal`），始终保留同一 SVG 与全部路径节点，
  `opacity = reveal`、`--ge-fold-hidden = 1 - reveal`。
- 轨道填充用 `trackFillStops` 生成 `linear-gradient`，宽度 `trackX(position)`。
- 标题变档：拆字符 span，220ms/字、15ms 间隔、blur(4px)→0、translateY 5px→0、
  `cubic-bezier(.2,.7,.2,1)`；快速改档取消旧动画。
- Galaxy：`galaxyState` 驱动 scale / fill / stroke / drop-shadow / 震动位移；
  Galaxy 填充 `opacity = g`、普通渐变 `opacity = 1-g`。
- `reducedMotion` 选项与 `prefers-reduced-motion` 叠加：立刻吸附 `position` 与 `g`，
  保留静态像素，取消文字动画/震动/放射流动，仍可交互；切换偏好不丢当前档位。
- `destroy()`：取消 RAF、文字动画、`ResizeObserver`、`IntersectionObserver`、
  `MutationObserver`（选项）、媒体查询监听、窗口/文档监听，移除实例 DOM。
  支持卸载后重新挂载、同页两个实例互不干扰。
- `setValue(v, { silent })`：外部设置档位（`silent` 时不派发事件），用于宿主回写。
- 帮助按钮与 tooltip 按规格 §3；`tooltip` 选项默认值就是规格里那段英文原文。
- import 时**不得**触碰 DOM。

**CSS**（`galaxy-effort.css`，由 `galaxy-effort-demo.html` 与未来的 composer 各自 `<link>`）：
规格 §1 的全部尺寸/颜色/阴影；`@media (prefers-reduced-motion: reduce)` 分支；
`.ge-*` 前缀的类名，避免与现有 `styles.css` 冲突。

**测试**（`tests/desktop/galaxy-effort.test.js`）：仓库无 jsdom，只能做静态断言。
- `galaxy-effort.js` 不含 `document`/`window`/`requestAnimationFrame` 的顶层引用
  （正则断言它们都出现在函数体内）。
- 关键接线存在：`setPointerCapture`、`releasePointerCapture`、`touch-action`、
  `role="slider"`、`aria-valuenow`、`aria-valuetext`、`aria-orientation`、
  `aria-valuemin`、`aria-valuemax`、`CustomEvent`、`composed: true`、`bubbles: true`。
- `destroy` 函数体里逐个出现 `cancelAnimationFrame`、`disconnect`、`removeEventListener`。
- CSS 里有 `prefers-reduced-motion` 分支与 `.ge-` 前缀（断言不出现裸 `.effort-panel` 之类会撞车的选择器）。
- 导出清单：`createGalaxyEffort` 是函数。

---

### Task 4 · 独立演示页（`galaxy-effort-demo.html`）

**依赖**：Task 3 落盘后才能开工。

- 单文件 HTML：`<link rel="stylesheet" href="./galaxy-effort.css">`、
  `<script type="module">import { createGalaxyEffort } from "./galaxy-effort.js";</script>`。
- 舞台：945×516 固定，`transform: scale(min(可用宽/945, 可用高/516))`，居中；外层 `#111111` 铺满。
  用 `ResizeObserver` 更新缩放，不重置状态。
- 页面挂两个实例（规格要求同页多实例），第二个默认值设为 5 以便肉眼比对 Galaxy。
- 页面上显示最近一次 `effort-change` 的 `detail`，用于验收"提交才派发、拖动不派发"。

**测试**（`tests/desktop/galaxy-effort-demo.test.js`，静态）：
- 文件存在、引用了正确的 css/js 相对路径。
- 出现 945、516、`#111111`、`ResizeObserver`、两个 `createGalaxyEffort(` 调用。
- 不出现 `http://` / `https://`（无远程素材）。

---

## 验收（每个任务交付时都要跑的）

1. `npx vitest run <本任务的测试文件>` — **看 `Test Files N passed` 那一行**，不看退出码
   （实测 vitest 对不存在的路径也会退出 0）。
2. `npm run check:js` — 0 个文件不通过。
3. 全量 `npx vitest run --maxWorkers=4` — 不比自己开工前多红（本仓库并行负载下有已知偶发红，
   见 `AGENTS.md`）。

## 交付物

- 三个渲染层模块 + 一份 CSS + 一个演示页 + 四份测试。
- 演示方式：Electron 里打开 `desktop/renderer/galaxy-effort-demo.html`，或任意浏览器直接打开
  （该文件不依赖 Electron API）。
