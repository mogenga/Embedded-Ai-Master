# Task B — 主窗口样式：浏览器表面、提示条、节奏

先读 `docs/ui-polish-shared.md`（共享方向、硬约束、端口分配、自测口径），那是你的第一份需求。

## 用户原话

> 分发多个子代理全面优化界面

## 你独占的文件

- `desktop/renderer/styles.css`（6320 行）

**不要碰** `settings.css`、`settings.js`、`index.html`、`app.js`、`i18n.js`。大文件用 Edit 精确替换，**禁止整文件重写**。

## 只改样式，不改结构

你**没有** `app.js` / `index.html` 的所有权。如果某个修复必须有结构变化（例如需要一个包裹元素才能画的角标），**写进报告的「需要人看的地方」**，不要自己加类名到 HTML —— 另一个代理在同一时刻改那两个文件。

现有的选择器已经足够做下面三件事。

## 你要做的三件事

### 1. 接管浏览器默认表面（最优先）

现在全仓库：

- `::selection` **0 条规则** → 深色下选中文字是系统蓝；
- `caret-color` 只有 1 处（`.serial-send-input.agent-typing`，`styles.css:6307`）；
- 滚动条只美化了 `.session-list`（`styles.css:1169`）与 `.transcript`（`styles.css:2132`）两个；
- 没有 `::marker`、没有 `text-underline-offset` 的全局口径。

要做：

- 全局 `::selection`：背景用 `--accent-soft` 的加强版或 `--accent`，前景保持可读。四套主题（`dark` / `light` / `contrast` / `light-contrast`）都要验。
- 全局 `caret-color: var(--accent)`（保留 `.agent-typing` 那条不动）。
- 给**所有可滚动容器**补滚动条：`.settings-*` 之外的都在你这——`.tool-output`、`.terminal-output`、`.command-palette` 列表、`.model-menu`、`.mode-menu`、`.effort-menu`、`.plus-menu`、`.serial-*`、`.workbench` 内容区。口径照现有两条：轨道透明、thumb `--border`、hover `--border-strong`、`border-radius: var(--radius-sm)`、thumb 内 3px 透明边。
- `.markdown ul/ol` 的 `::marker` 与列表缩进、`.markdown a` 的 `text-underline-offset`（现有 3px 只在 `.markdown a` 一处，确认全站链接一致）。

### 2. 去掉提示条上的彩色竖线

`.notice.setup`（`styles.css:3030`）、`.notice.recovery`（`3070`）、内联 diff 评论（`4230`）、子代理分组（`4417`）、`.notice` 本身——现在全靠 `border-left: 2px`。

改成：**中性表面（`--surface` 底）+ 一个明确的语义标记**。可选做法（自己判断哪个最适合）：

- 首行一个 24×24 sprite 图标（`icons.js` 里有 `alert` / `info` / `shield` / `check`），图标保留语义色，正文用 `--text` / `--text-secondary`；
- 或左上角一个小标签（caps 小字 + 语义色），正文中性；
- 或 `--surface` 底 + 语义色**只**出现在图标与首行文字上。

**三个必须保留**：

- `.serial-line.rx` / `.serial-line.tx`（`styles.css:6116` / `6121`）的左侧色条**保留原样**。串口方向在滚动中必须一眼可辨，这是功能不是装饰。
- `.markdown blockquote`（`2346`）的左边线是引用语义，**保留**。
- 状态仍然不得只靠颜色（色盲 + 高对比主题）。

### 3. 节奏收敛

`styles.css` 里存在零散的 margin/padding 值。收敛方向：

- 同类元素的上/下间距来自同一套：4 / 8 / 12 / 16 / 24 / 32；
- **标题上方永远比下方松**（读当前计算值确认，别只看源码）；
- 转录轮次之间、工具行之间、卡片之间的间距要有明显层级（轮次 > 工具行 > 卡片内元素）。

**不要**为此重排任何组件的位置或尺寸——只调间距值。如果发现某个间距是靠 `gap` 而非 `margin` 实现的，改 `gap`。

## 你已经知道现状的（别重复测）

- 四套主题的令牌块在 `styles.css:102`(contrast) / `132`(light-contrast) / `163`(light)，`:root` 是 dark。
- 圆角三档、字号六档都在 `:root`（第 15–80 行）。
- `prefers-reduced-motion` 已有全局兜底（`2182` / `6148`），不用动。
- 动效时长有 9 种（90–300ms），收敛到 `--fast`(110) / `--normal`(170) 两档；`width 300ms` 这种面板开合可以保留 `--normal`。

## 自测

1. `npm run check:js`（不扫 CSS，但确认你没误改 JS）。
2. Electron 实测（隔离，端口 **9372**）：主窗口空态、有会话时的转录（需要先在界面里发一条消息或用一个已有会话）、模型面板打开、命令面板、工具行、串口面板。
3. 截图：**1440×900 与 1100×800**，**深色与浅色**（有条件加高对比）。
4. 对比度：改完用 CDP 实测 `::selection` 的前景/背景在四套主题下的对比，贴数字。

## 交付

不要提交。报告按共享文档的「交付格式」写。
