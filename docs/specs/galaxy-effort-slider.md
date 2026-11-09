# 脑形思考强度滑块（Galaxy Effort Slider）

> **状态**：需求已由用户给出（2026-11-09），实现进行中。
> **来源**：用户提供的完整组件规格。下文的数值、颜色、文案与运动算法**以本文为准**，
> 实现方不得自行"优化"或替换。
> **性质声明**（用户原文）：递增褶皱是本实现的交互设计，不将其描述成原作者源码或真实
> 脑部生理变化；文中所有数值是自包含的重建参数，不宣称原作者使用这些算法。

## 本仓库的落地约束（优先于通用规格）

以下几条来自 `AGENTS.md` 的硬约束，与上面那段"六框架交付"的通用措辞冲突时，**以本节为准**：

1. **无框架、无打包器、无构建步骤**。交付形态是原生 ES 模块 + 一段 CSS + 内嵌 SVG + Canvas，
   由 `desktop/renderer/` 直接加载。不引入 React / Vue / Svelte / Preact / Lit / 任何 UI 库，
   也不引入构建链。
2. **零外部依赖**：不下载字体、图片、视频或任何远程素材；不发起网络请求；不调用真实模型。
3. **不做六框架版本**。只交付一个实现：原生 ES 模块。规格里"交付框架入口"按"导出
   `createGalaxyEffort()` 工厂"理解。
4. **颜色/尺寸用文中的字面值**，不要改写成设计令牌——这是用户逐条核对的验收依据。
5. **`prefers-reduced-motion` 必须真的处理**，且组件选项 `reducedMotion` 与之叠加。

## 交付物

| 文件 | 内容 |
|---|---|
| `desktop/renderer/galaxy-effort.js` | 组件本体：工厂 `createGalaxyEffort({ mount, value, reducedMotion, onChange })`，返回 `{ setValue, getValue, destroy }` |
| `desktop/renderer/galaxy-effort.css` | 样式（含 `@media (prefers-reduced-motion: reduce)`） |
| `desktop/renderer/galaxy-effort-demo.html` | 独立舞台：945×516 基准、`#111111` 底色、居中、按 `min(可用宽/945, 可用高/516)` 缩放 |
| `tests/desktop/galaxy-effort.test.js` | 静态与纯函数测试（仓库无 jsdom，见下） |

## 1. 结构、尺寸与文字

- 基准场景 **945×516**，纯色背景 `#111111`，水平垂直居中。独立舞台固定 945×516，缩放系数
  `min(可用宽/945, 可用高/516)`，位置居中，外层背景铺满，不依赖宿主页 body 或外部资源。
- 卡片：左 252.5、上 124、宽 440、高 258，`2px` 实线 `#292929`，`16px` 圆角，底色 `#191919`，
  阴影 `0 18px 28px -12px #0003`。尺寸含边框。卡片允许粒子溢出，场景边界裁切。
- 字体栈 `Arial, Helvetica, sans-serif`，正常字重 400。
- 标题：左 22、上 25，一行 35px，字号 26px，"Effort" 颜色 `#848484`；右侧隔 16px 显示当前档位，
  普通颜色 `#e1e1e1`，Galaxy 颜色 `#9dcef3`。无额外品牌或标题。
- 帮助按钮：卡片右 3、上 7 的 70×70，无底色、23px 内边距；增大透明命中区便于移动端操作，
  图标位置保持不变。24×24 圆圈问号图标，描边 `#848484`、`2px`：圆心 (12,12)、半径 10；
  问号路径 `M9.5 8.2a2.6 2.6 0 0 1 5 .8c0 2-2.5 2.2-2.5 4`，底点 `M12 16.5h.01`，圆端。
  hover 只改颜色 `#bfbfbf`，不位移或缩放。
- 上 97、左右 22 是一行 "Faster" 和 "Smarter"，分别左右对齐，24px/29px、`#848484`。
- 卡片左 47、上 205 显示 "Recommended"，同字号颜色，**不随档位改动**。它对应第二档的较长推荐刻度。
- 滑块透明命中区域：左 22、右 22、上 133、高 72、圆角 12，`role=slider`、`tabindex=0`。
- 轨道：位于命中区上 15、下 17，高 40、宽 392，底色 `#272727`、圆角 10、裁切内部像素。
  **轨道与脑形本身保持同一 DOM 身份**（不是两个可分离控件）。
- 六个刻度圆点直径 6，横坐标 `16 + i×358/5`（i=0..5），纵坐标 18，颜色
  `rgba(255,255,255,.20)`。第二项为高 20、宽 6、上 10、圆角 3、颜色 `rgba(255,255,255,.27)`
  的长刻度；其他是圆点。不加描边或阴影，刻度自然混合下方的灰色轨道、紫色填充或像素层，
  **不能**改成固定亮粉白色。刻度始终保留，像素层下方绘制，不能把 Galaxy 做成另一个独立控件。

## 2. 脑形 SVG

- 48×48、`viewBox 0 0 64 64`，中心初始位于命中区 (16,36)，DOM 居中偏移 `(-24,-24)`。
- 左右两半独立填充粉色 `#ff92ce`，深酒红描边 `#650e3c`、宽 5、圆端圆角。
- 左半 path：`M30 14C30 5 20 4 16 12C9 11 5 20 9 26C2 30 3 39 10 43C6 50 11 59 19 57C24 63 30 58 30 52Z`
- 内折痕 path：`M30 27Q28 35 22 35M10 43Q15 44 17 48M16 12Q13 17 16 20`，无填充、线宽 4.2
- 右半复用两条 path，`transform=translate(64 0) scale(-1 1)`。无需图标库或图片。
- 正常脑形不因 hover 上浮。

### 递增褶皱

保留上述同一轮廓与主沟，六档依次为：

| 档位 | 可见褶皱 |
|---|---|
| Low | 仅主沟 |
| Medium | 增加上部支沟 |
| High | 增加下部支沟 |
| Extra | 增加外侧支沟 |
| Max | 增加顶部和下部细分支 |
| Galaxy | 增加中部细褶皱 |

新增左半球路径的完整分层数据：

```json
[
  {"level":1,"width":2.8,"paths":["M29 25Q28 21 24 21C20 21 18 17 21 14"]},
  {"level":2,"width":2.6,"paths":["M28 42C23 39 19 41 20 45Q21 48 25 47"]},
  {"level":3,"width":2.5,"paths":["M12 28C15 25 19 26 20 29Q21 33 17 34"]},
  {"level":4,"width":2.2,"paths":["M21 21Q18 19 15 22","M20 53Q24 55 27 51"]},
  {"level":5,"width":1.9,"paths":["M10 36Q13 34 16 37","M24 35Q27 37 25 40"]}
]
```

- 每层在左右半球各实例化一次，右半球同样镜像；每条路径均无填充、使用深色轮廓变量作为描边、
  圆端圆角，线宽取该层 width，从 2.8 递减到 1.9，保留主沟更粗的 4.2 层级。
- 每条新增 path 设置 `pathLength=1`、`stroke-dasharray=1`；各层 `g` 设置 `data-tier` 为 level、
  初始 `opacity=0` 及 `--ge-fold-hidden=1`，path 的 `stroke-dashoffset` 读取该变量。

## 3. 数值、状态与输入

- 内部 `position`、`velocity`、`target`、`galaxy`、`galaxyVelocity` 独立保存，全部初始 0。
- 档位索引 `round(clamp(target, 0, 5))`；可见与无障碍名称按 `Low/Medium/High/Extra/Max/Galaxy` 同步。
- `aria-valuemin=0`、`aria-valuemax=5`、`aria-valuenow` 为当前档位、`aria-valuetext` 为上述英文名、
  `aria-orientation=horizontal`。
- 真实指针按下轨道或脑形后，聚焦滑块并获取 pointer capture，记录开始档位。触屏采用同一
  `PointerEvent` 链、`touch-action: none`。拖动换算
  `value = clamp((指针在轨道内的 x - 16) / 358 × 5, 0, 5)`，连续更新 target，标签按最近档切换，
  松手吸附 `round(target)`，`pointercancel` 回到按下时档位；重复触摸不抢占已进行的指针。
- 点击任意位置同样按最近档吸附。键盘：
  - 左 / 下 减一，右 / 上 加一
  - `Home` 及 `Escape` 回 Low，`End` 到 Galaxy
  - `PageUp` / `PageDown` 加减 2
  - 全部阻止默认页面滚动。键盘在拖动中接管时释放捕获。边缘钳制 0 到 5。
- 键盘焦点轮廓 `2px #b591ff`、offset 4，不使用无轮廓焦点。
- 每次用户提交档位，在根节点发送冒泡且 composed 的 `effort-change` 自定义事件，
  `detail = { value: 数字0到5, level: 英文档名 }`。**拖动中间值只更新视觉，松手提交。取消不提交。**
- 不同实例的值与事件互不干扰。
- 帮助按钮 hover 或 focus 显示一段 tooltip，点击切换、移开/失焦隐藏、`Escape` 关闭。文案完整为：

  > Drag the brain or use arrow keys to choose Low, Medium, High, Extra, Max or Galaxy. Higher
  > effort adds brain folds; Galaxy adds particles. This control uses local demo state.

  气泡在卡片上方 12px，左右 22，内边距 `12px 14px`，圆角 9、底 `#242424`、1px 边框 `#444`、
  文字 `#dedede` `14px/20px`、阴影 `0 6px 24px #0005`。帮助按钮有 `aria-expanded`、`aria-controls`，
  焦点轮廓 `2px #b591ff`。气泡是辅助适配，不影响滑块状态。

## 4. 连续移动和 Galaxy 变形

- **仅一个 `requestAnimationFrame` 循环**，帧间 `dt = min(.032, 实际秒数)`，每帧拆 3 子步。
- 普通移动弹簧 `k=420`、`damping=32`：
  `v += ((target-position)×k - v×damping) × dt/3`，然后 `position += v × dt/3`；
  误差 `< .0002` 且速度 `< .002` 时吸附。
- 横坐标 `16 + clamp(position,0,5)/5 × 358`，**禁止用两张静帧淡入冒充移动**。
- 快速反向保留当前位置和速度，只替换目标。
- 褶皱跟随同一弹簧的实际 position，而非整数标签或另一组计时器：令 `p=clamp(position,0,5)`，
  每层 tier 取其 level，`u = clamp((p - tier + .85) / .7, 0, 1)`，`reveal = u*u*(3-2*u)`。
  该层 `opacity = reveal`，`--ge-fold-hidden = 1 - reveal`，即线条沿路径逐步画出并渐显。
  第 1 层在 0.15 到 0.85 展开，第 2 层在 1.15 到 1.85 展开，依此类推到第 5 层 4.15 到 4.85；
  回拉用相同公式反向收回，**始终保留相同 SVG 及所有路径节点**。
- 静止在六档时可见褶皱路径数分别为 **2、4、6、8、12、16**（包含左右两条基础复合路径，
  不计脑形轮廓）。
- 减少动态效果时直接按目标档位绘制完整对应密度；**不能让高档位仍显示低档位的简脑，
  也不能用六张图交叉淡入代替生长**。

### 轨道填充

- 普通轨道填充左到脑形中心，宽 `16 + position/5 × 358`。视觉为灰底被莓紫逐渐染亮，
  强度越高，前缘越偏冷紫，**不能使用整条亮粉色渐变**。
- 用五个色标重建合成后的呈现色，位置依次为 0%、30%、60%、90%、100%。四组 RGB 色板依次
  对应 Medium、High、Extra、Max：

```json
[
  [[49,42,45],[86,57,76],[125,73,112],[161,89,146],[175,94,157]],
  [[49,42,45],[81,55,76],[112,69,107],[143,83,139],[153,87,150]],
  [[49,42,45],[78,56,74],[108,69,110],[129,84,149],[136,90,163]],
  [[49,42,45],[77,56,74],[102,67,111],[118,84,153],[124,90,167]]
]
```

- 每次绘制令 `t = clamp(position-1, 0, 3)`，`index = min(2, floor(t))`，`blend = t - index`；
  五个色标的每个 RGB 通道都取
  `round(palette[index] + (palette[index+1] - palette[index]) × blend)`，生成横向
  `linear-gradient`。颜色随实际连续位置变化，保留中途反向时的衔接，**不能只在标签改变时跳色**。
- Low 到 Medium 使用第一组，Max 到 Galaxy 使用第四组并配合 `1-g` 淡出；
  左侧始终保持 `#312a2d` 附近的暗灰紫。Max 的中段约 `#66436f`、90% 处约 `#765499`、
  最前缘约 `#7c5aa7`，脑形图标保留粉红色。

### 标题变档动画

将新词拆为字符 span，每字 220ms、间隔 15ms，opacity 从 0 到 1，`filter` `blur(4px)` 到 0，
`translateY` 从 5px 到 0，缓动 `cubic-bezier(.2,.7,.2,1)`。快速改档取消旧文字动画；
**不是整个标题或卡片淡入淡出**。

### Galaxy 变形

- 当最近档位进入 Galaxy 时记录进入时钟 `entered`，`galaxy` 目标变 1，离开变 0，
  使用 `k=190`、`damping=25` 的同一弹簧积分。
- `g = clamp(galaxy,0,1)`，`age = max(0, clock - entered)`，`burst = exp(-age×6) × g`。
- 脑形 `scale = 1 + .25g + .2burst`；填充 `rgb(255-85g, 146+4g, 206+39g)`，
  轮廓 `rgb(101-45g, 14+2g, 60+77g)`。
- 两层 `drop-shadow` 半径 `4+10burst`、`9+15burst`，颜色 `#8351ff` 及 `#7543fc70`。
- 进出保留同一 SVG 并反向衔接，不重建脑形。
- Galaxy 填充透明度 `g`，普通渐变透明度 `1-g`。
- 卡片震动振幅 `shake = g×(.28 + exp(-age×7)×2.1)`，`x = sin(clock×93)×shake`，
  `y = cos(clock×117)×shake×.65`，进入时强而短、随后微弱。

## 5. 轨道像素与放射粒子算法

### 像素 Canvas 392×40

- CSS 覆盖轨道，底色 `linear-gradient(90deg,#10091d,#25123f)`，**49 列 × 5 行**。
- 确定性 `hash(n) = fract(sin(n×127.1 + 311.7) × 43758.5453)`。
- 色板依次 `#80d5d8`、`#dc8cd5`、`#b3a3e8`、`#7061b5`、`#f4c1eb`、`#6656a0`，不使用噪声图片。
- 每帧清空像素，`n = row×49 + col`，`seed = hash(n+7)`，
  `wave = .5 + .5 sin(clock×(2+3seed) + n×1.618)`，`density = .14 + .78×(col/48)^1.6`。
  若 `seed > density + .16 sin(clock×1.8 + col×.2)` 跳过。否则
  `alpha = g × (.18+.72wave) × (.22+.78col/48)`，颜色取色板 `floor(hash(n+211)×6)`。
  在 `(col×8+1, row×8+.5)` 画圆角 1.3 方块，`seed > .74` 时边长 5.7，否则 5.1；
  右密左疏并持续闪动。

### 放射 Canvas 640×390

- 卡片左 -100、上 -60，`pointer-events: none`，不裁切在轨道内。
- 粒子中心 `(100+22+16 + position/5×358, 60+141+28)`，实时跟随脑形。
- 26 条射线角度 `ray×2.399963`，`seed = hash(ray+94)`，`speed = 15+24seed`，每条 7 个方块。
- `radius = 27 + ((dot×13 + clock×speed + seed×40) % 87) + exp(-age×5)×dot×3`；
  `fade = (1 - clamp((radius-27)/110, 0, 1))^1.6`；`pulse = .45 + .55 sin(clock×4 + ray + dot)^2`。
- 方块位置 `= center + (cos(angle), sin(angle)) × radius`，`seed > .65` 边长 3，否则 2；
  `alpha = g × fade × pulse × (.4 + .35 exp(-age×5))`，颜色依 `(ray+dot) % 6` 循环。
- 初次进入形成爆发，之后沿射线持续流动；离开 Galaxy 连同光晕和像素一起退去。

## 6. 适配、清理和验收

- 使用 `ResizeObserver` 更新舞台缩放，不重置状态。375、768、1440 宽下保留居中比例、
  完整底色，无水平溢出。
- Canvas 全部内嵌，无远程素材、网络请求、字体依赖或真实模型调用。
- 同时遵循 `prefers-reduced-motion` 和组件 `reducedMotion` 选项。减少动态效果时立刻把
  `position` 和 `g` 吸附目标，保留六档和静态像素，取消文字动画、震动、放射流动，
  仍可鼠标/键盘/触屏选择；切换偏好不丢当前档位。
- 普通档位停稳后**无 RAF**；Galaxy 需要持续绘制。离屏或文档隐藏停止 RAF，再可见时恢复，
  暂停时间不计入积分。
- 实例销毁清理 RAF、文字动画、ResizeObserver、IntersectionObserver、选项 MutationObserver、
  媒体查询及窗口/文档监听器，删除实例 DOM；支持卸载、重新挂载及同页两个实例。
- 测试：六档拖拽、轨道点击、全套键盘、触屏、取消、快速反向、进入及离开 Galaxy、帮助气泡、
  系统和选项减少动态效果、多实例、卸载。
- 验证 Galaxy 像素随时间变化、普通档位停止动画、卸载后无残留，**不能只验静态截图**。

## 7. 本仓库的测试现实

仓库没有 jsdom，也不打算为此引入依赖（用户未批准）。因此本组件的自动化测试只能是：

1. **纯函数测试**：把可脱离 DOM 的部分（`clamp`、`hash`、调色板插值、`reveal` 曲线、
   弹簧积分、档位 ↔ 名称映射）导出成纯函数，直接断言数值。
2. **静态结构断言**：读源码文本，断言关键接线存在（事件绑定、`destroy` 里释放了什么、
   `aria-*` 属性名、`touch-action`、`prefers-reduced-motion` 分支）。

模块本身必须**在 import 时不触碰 `document`**（否则 `tests/desktop/*` 静态导入会炸），
所有 DOM 操作推迟到 `createGalaxyEffort()` 调用时。
