# 前端设计文档 · 诊断工作台

> 版本 v2.0 · 2026-10-20 · 状态：**以实现为准的设计基线**（v1.4 及更早版本基于已删除的 Preact 工作台 `src/ui/`，整体作废，保留在 §13 决策表与 §14 变更记录中）
> 实现位置：`desktop/renderer/`（纯 ES 模块，无框架、无打包器、无构建步骤）
> 业务依据：症状驱动诊断闭环、动作三类归属与安全边界（写内存/复位前先声明、工具必须诚实）
> 本文边界：只定义前端的设计契约、组件规格与验收口径；不定义内核实现，不定义 MCP server 的工具清单。
> 能力清单的事实源是 `desktop/MATRIX.md`（逐条命令/事件的支持、隐藏与原因）。

---

## 0. 与 v1.4 的关系

v1.4 描述的是一套**从未按此实现**的设计基线（Preact + Vite、三栏诊断工作台、日/夜/跟随系统三态主题、纯简体中文、`TranscriptView` 归约模型）。2026-10-20 的前端移植把整套前端替换为 Prometheus 渲染器，v1.4 的 §2 技术约束、§3 信息架构、§4 布局、§5 令牌、§6 主题、§7 组件规格、§11 响应式、§12 验收清单**全部作废**。

仍然有效并保留在本版的有三块，它们描述的是**内核契约**而非前端实现：

- §8.1 的 `SessionEvent` 事件模型与 payload（内核事实源，前端只消费不改写）；
- §1.3 / §8.3 的安全边界（R1–R3）与工具语义标记；
- §13 决策表中除 OPEN-UI-01/02 外的结论。

本版按**已落地实现**重写，每条规格都能在 `desktop/renderer/` 里找到对应代码位置。

---

## 1. 目标与范围

### 1.1 设计目标

1. **一眼看懂诊断处于哪一步**：症状、分流提问、KB 检索、探针取证、根因判决构成一条可读的路径。
2. **证据优先**：工具调用不是"正在调用某工具"的黑盒，而是可核对的读数，支撑「可证伪」的诊断结论。
3. **诚实优先于完整**：内核没有的能力**隐藏入口**而不是伪造一个假的。点不动的按钮比会骗人的按钮好。
4. **专业、克制、可长时间注视**：以仪器面板的克制语言为主，不用装饰性图形、不用 emoji、不用大面积高饱和色。
5. **一套 UI**：renderer 只跑在 Electron 里（2026-10-22 起浏览器形态下线），对同一份会话日志给出同一套界面。

### 1.2 范围内

- 两栏布局（可拖拽侧栏 + 主对话区 + 可选工作台面板）与响应式降级；
- 四态主题（跟随系统 / 日间 / 夜间 / 高对比）与若干正交偏好（密度、宽度、视图、缩放、动效）；
- 会话列表（按工作目录分组、搜索、过滤、归档）、转录、工具行、审批条、消息流；
- 右侧工作台面板（板卡 / 串口两个 tab）；
- 设置页（通用 / 外观 / 关于）；
- 键盘操作、可访问性、视觉验收口径。

### 1.3 非目标

- **不在界面内直接控制仪器**（逻辑分析仪 / 示波器 / 程控电源）。R1 禁止 LLM 直接控制仪器；设备相关动作一律作为会话输入下发，仍经内核权限与审批。
- 不做实时波形与时序图；信号物理层诊断属人工执行域。
- **不做多窗口写同一会话**；桌面形态保持单窗口。
- 不做移动端优先布局；窄屏只保证"可用降级"。

### 1.4 明确不在范围内的能力（内核无后端，已隐藏）

以下入口在 DOM 中保留但带 `hidden`，宿主收到对应命令时回显式 `notice`（R3，不静默吞掉）。逐条见 `desktop/MATRIX.md`：

git / PR、终端、worktree、packs、browser、skills / memory / instructions / hooks、subagents、goals、检查点恢复、附件（图片）、板卡/串口的写操作、`effort` 直设（内核适配层不发该参数，如实拒绝而不是假装生效）。

> **已从本文档移出的能力**（2026-10-21 起陆续接通，此处列表曾长期未同步）：文件树、导出、会话 fork / 删除 / 改名、工作目录切换、模型直选、`@` 文件补全、斜杠命令（`/clear` `/context` `/compact`）、压缩（桌面形态）。它们现在在本文件 §7、§8 与 `desktop/MATRIX.md` 里按「已支持」描述。

> **「始终允许」按钮不渲染**：内核审批桥只有单次 allow/deny，没有持久规则。渲染出来就是一句兑现不了的承诺。

---

## 2. 技术约束（内联，完整）

以下为已定案、实施时不得自行更改的约束：

- **内核语言与运行时**：TypeScript + Node 24，ESM-only，禁止 CommonJS 混用；`package.json` 声明 `"engines": { "node": ">=24" }`。
- **协议层**：MCP 官方 TypeScript SDK v2——`@modelcontextprotocol/client`、`@modelcontextprotocol/server`、`@modelcontextprotocol/server/stdio`。
- **Schema**：Zod v4（MCP SDK v2 走 Standard Schema）。
- **测试**：vitest 4。前端测试位于 `tests/desktop/`，不混入 `tests/ui/`（后者已随 Preact 工作台删除）。
- **模型适配层**：自研极简适配器，仅 `complete` / `countTokens`；P0 只实现 OpenAI 兼容端点。
- **内核**：主循环、会话、工具系统、上下文、MCP 生命周期全部自研，不引入现成 harness。

### 2.1 前端技术栈（2026-10-20 移植定案）

- **无框架、无打包器、无构建步骤**：renderer 是原生 ES 模块，Electron 直接加载 `index.html` 里的 `<script type="module">`。
- **渲染层语言是 JavaScript，不是 TypeScript**：TypeScript 只用于内核 `src/` 与 MCP server。`desktop/renderer/*.js` 是 `.js` 文件，靠 `protocol.d.ts` 提供协议层的类型提示。**这条与 v1.4 相反**。
- **无 UI 框架、无组件系统**：`app.js`（5853 行）是命令式 DOM 操作（`addUserTurn` / `addAssistantTurn` / `addToolRow` / `attachToolOutput` …），状态在一个 `state` 对象里，没有 `TranscriptView` 那样的纯函数归约层。
- **样式**：手写 CSS 变量体系，两张表（`styles.css` 5473 行 + `settings.css` 1243 行），无 CSS 预处理器。
- **Markdown**：零依赖手写渲染器（`markdown.js`），带 `IncrementalRenderer` 增量 diff。支持的块级语法是围栏代码块、`#`~`######`（降到 h3）、无序/有序列表、`>` 引用、**GFM 最小集表格**（表头 + `:?-{3,}:?` 分隔行；切列走状态机，`\|` 与 code-span 内的 `\|` 不拆列；对齐三态用 `style="text-align"`；短行补空单元、长行截断，保证每行同列数）、**分割线**（`---` / `***` / `___` / `- - -`，仅在段落为空时产出 `<hr>`，所以 `上面一行\n---` 仍是正文——本渲染器没有 setext 标题）、**显示数学块**（`$$` 围栏：单行 `$$E=mc^2$$` 或多行 `$$`…`$$`；LaTeX 源原样转义显示、不做 TeX 排版、不做行内语法处理；未闭合宽容渲染到块尾；开/闭 `$$` 同行的内容并入公式体）。不支持嵌套表格、多行单元格、单元格内的块级语法、setext 标题、**行内 `$...$`**（调试输出里 `$sp`、`$1 = 0x2000` 高频，配对单 `$` 误伤面太大）。表格、`hr` 与数学块的样式在 `styles.css` 的 `.markdown table` / `.markdown hr` / `.markdown .math`（居中、衬线、`pre-wrap` 保留源换行）。
- **图标**：内联 SVG sprite（`icons.js`），单一 24×24 网格、`stroke-width: 1.75`。**零 emoji**。
- **i18n**：`i18n.js`（en 437 键 / zh 438 键）+ `settings-i18n.js`（604 行），中英双语，默认跟随系统语言。

> 根 `package.json` 的 `devDependencies` 里 `vite` 已是死依赖（仓库内无任何引用，`vite.config.ts` 已删），可清理；`vitest` 自身仍需要它。

### 2.2 实时通道

| 形态 | 传输 | 客户端动作 | 事件推送 |
|---|---|---|---|
| 桌面 | NDJSON over stdio | Electron IPC → 宿主 stdin | 宿主 stdout → IPC → 渲染器 |

宿主与渲染器**共用** `desktop/renderer/protocol.js` 这一层纯函数映射，保证同一份会话日志给出同一套 UI。

> 2026-10-22：浏览器形态下线，原先的 HTTP + SSE 通道（`EventSource` 订阅 `GET /api/events`）随 `desktop/renderer/bridge.js` 与 `src/server` 的 HTTP 层一并删除，此表只剩桌面一行。

### 2.3 安全边界落到界面

- 写内存 / 复位类操作在界面上必须呈现"待确认"状态；确认后只显示"等待工具结果"，**不得**在前端伪造"已执行"（R2）。
- 只读工具不得渲染为危险操作。
- 工具失败必须显式展示错误码与文本，不得以空值或全 0 读数伪装成正常（R3）。
- CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'`。**无 `unsafe-inline` 脚本、无 `unsafe-eval`**。

---

## 3. 信息架构

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TopBar  侧栏切换 │ cwd │ 状态点 · 状态文本 │ 设置 │ 窗口控件(仅桌面) │ 48
├────────────────────┬─────────────────────────────────────┬───────────────────┤
│ Sidebar 264px      │ Transcript（滚动）                  │ Workbench 420px   │
│  可拖拽调宽         │  find-bar（sticky）                 │  可拖拽 320–560   │
│  可折叠 / 窄屏抽屉 │  消息流：用户气泡 / agent 气泡      │  tab: 板卡 | 串口│
│                    │            工具行 / 审批条 / 提示   │                   │
│  新建会话          ├─────────────────────────────────────┤                   │
│  会话搜索          │ Composer                            │                   │
│  会话列表          │  审批条（需要时）                   │                   │
│  （按 cwd 分组）   │  输入框 + 停止 + 发送               │                   │
│                    │  模式 / 模型 / 用量胶囊             │                   │
└────────────────────┴─────────────────────────────────────┴───────────────────┘
```

### 3.1 与 v1.4 的结构差异

| v1.4 | v2.0 | 说明 |
|---|---|---|
| 三栏（左 264 / 主区 / 右 404 调试坞） | 两栏 + 可选工作台 | 工作台是 **tab 切换的检查器**，不是三段纵向分区 |
| 顶部 + 底部状态栏 | 状态在顶栏右侧 | **无独立状态栏**（StatusBar 组件不存在） |
| 左栏含知识库检索 + 厂商树 | 左栏只有会话 | 知识库面板不存在（内核无对应前端后端） |
| 诊断路径条 PathLine（5 步） | 无 | `transcriptFromSession` 的 `steps` 随 `src/ui` 删除 |
| VerdictCard / GuardNotice / AskBlock | 无 | 这三个组件随 `src/ui` 删除，内核事件不区分它们 |

### 3.2 DOM 骨架

| 区域 | 选择器 | 位置 |
|---|---|---|
| 根 | `.shell` | `index.html:18` |
| 侧栏 | `aside#sidebar.sidebar` | `index.html:20` |
| 主列 | `div.main` | `index.html:66` |
| 顶栏 | `header.topbar` | `index.html:67` |
| 主体 | `div.main-body` | `index.html:171` |
| 对话列 | `div.chat-column` | `index.html:172` |
| 转录 | `main#transcript.transcript` | `index.html:173` |
| 查找栏 | `div#find-bar.find-bar` | `index.html:174` |
| 滚动到底部 | `button#scroll-bottom` | `index.html:208` |
| 输入区 | `section#composer-region` | `index.html:213` |
| 审批条 | `div#pending-permission` | `index.html:214` |
| 输入框 | `div.composer` | `index.html:233` |
| 用量弹层 | `div#usage-popover` | `index.html:332` |
| 工作台 | `section#workbench` | `index.html:357` |
| 设置页 | `dialog#settings-dialog` | `index.html:513` |
| 命令面板 | `div#command-palette` | `index.html:544` |
| 快捷键 / 输入对话框 | `dialog#shortcuts-dialog` / `dialog#input-dialog` | `index.html:549,561` |

### 3.3 脚本加载顺序

`index.html:596`：

```html
<script type="module" src="app.js"></script>
```

只有一个模块脚本。`app.js` 在模块顶层读 `window.prometheus`，该对象由 `desktop/preload.cjs` 的 `contextBridge` 在页面脚本执行前注入。原先排在它之前的 `bridge.js` 已于 2026-10-22 随浏览器形态删除。

---

## 4. 布局与栅格

### 4.1 关键尺寸

| 区域 | 尺寸 | 位置 |
|---|---|---|
| 顶栏 TopBar | `height: 48px`，`padding: 0 14px` | `styles.css:1541` |
| 侧栏 | `var(--sidebar-drag-width, var(--sidebar-width))`，默认 `264px` | `styles.css:80, 262` |
| 侧栏拖拽条 | 6px，右侧边缘，`role="separator"` 且可 Tab 聚焦 | `styles.css:296` |
| 转录区 | `padding: 32px 16px 16px`，独立滚动 | `styles.css:1910` |
| 内容列宽 | `--column-width: min(var(--reading-width), calc(100vw - 120px))` | `styles.css:1998` |
| `--reading-width` | 默认 `780px`；narrow `620px` / wide `980px` | `styles.css:83, 1982` |
| 输入区 | `padding: 0 28px 16px` | `styles.css:2832` |
| 工作台 | `width: 420px; min-width: 320px; max-width: 560px` | `styles.css:679` |
| 查找栏 | sticky，`width: min(520px, calc(100% - 32px))` | `styles.css:1923` |
| 命令面板 | fixed，`top: 14vh`，`width: min(560px, calc(100vw - 40px))` | `styles.css:3459` |
| 设置页 | `width: min(1080px, 96vw); height: min(760px, 90vh)`；左栏 240px + 右 pane `max-width: 780px` | `styles.css:4874`, `settings.css:28,202` |

### 4.2 侧栏宽度与折叠

- 拖拽条写 `--sidebar-drag-width`（写在元素上，**不经过渡**，指针跟手）；落点记忆到 `prometheus.sidebarWidth`。
- 折叠：`.shell.collapsed .sidebar { width: 0; flex-basis: 0 }`（`styles.css:334`）。
- 窄屏（< 900px）：侧栏变为 fixed 抽屉（`position: fixed; inset: 0 auto 0 0; z-index: 12`），不是隐藏。

### 4.3 滚动策略

- 顶栏不滚动；侧栏、对话列、工作台各自独立滚动。
- **只有 `.transcript` 一个滚动容器**（`app.js:239` 的 `scrollTarget()` 返回 `transcript`）。`find-bar` 是 `position: sticky` 贴在转录顶部，随之滚动。
- 工作台 `.workbench-body` 内部滚动，各面板自行管理。
- 滚动条：`.transcript::-webkit-scrollbar { width: 10px }`，thumb 用 `var(--border)` + `3px solid var(--bg)` 内缩，**未使用 `scrollbar-color` 标准属性**（`styles.css:1969`）。
- 自动跟随：距底 < 140px 跟随，> 220px 显示「滚动到底部」按钮（`app.js:243-278`）。

### 4.4 断点

`styles.css` 只有三个媒体查询：

| 查询 | 位置 | 行为 |
|---|---|---|
| `max-width: 1500px` | `styles.css:744` | 仅收紧工作台 tab 的 padding / 字号，**不改栏宽** |
| `max-width: 900px` | `styles.css:4937` | `.main-body` 改纵向堆叠；工作台 `flex: 0 0 45%`；侧栏变 fixed 抽屉 |
| `prefers-reduced-motion: reduce` | `styles.css:2019, 5443` | 全局 `animation/transition: none !important` |

> v1.4 的 1180 / 1020 / 820 三个断点**不存在**。Electron 窗口 `minWidth: 900`（`main.js:29`），900px 是实际下限。

---

## 5. 设计令牌

所有颜色必须经 CSS 变量引用，禁止在组件中硬编码十六进制值。定义集中在 `styles.css` 的 `:root`（`styles.css:13-86`）。

### 5.1 颜色

**夜间（`:root` 默认，`color-scheme: dark`）**

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg` | `#0c0d10` | 主画布 |
| `--sidebar` | `#101216` | 侧栏 |
| `--surface` | `#15181d` | 卡片、输入框底 |
| `--surface-raised` | `#1b1f25` | 浮层 |
| `--surface-hover` | `#22272f` | 悬停 |
| `--border` | `#232830` | 结构分隔、滚动条 thumb |
| `--border-strong` | `#333a45` | 强调边框 |
| `--text` | `#e6e9ef` | 主文本 |
| `--text-secondary` | `#9aa3b2` | 次文本 |
| `--text-faint` | `#7d8797` | 弱文本、元信息 |
| `--accent` | `#4c9df0` | 品牌主色、活跃态 |
| `--accent-hover` | `#6cb0f5` | 主色悬停 |
| `--accent-soft` | `rgba(76,157,240,.14)` | 主色浅底 |
| `--accent-text` | `#8dc0f7` | 主色文字 |
| `--accent-warm` | `#c98b4b` | 用量分段第二色 |
| `--accent-2` | `#4b9ac9` | 用量分段第三色 |
| `--accent-3` | `#9a7bd1` | 用量分段第四色 |
| `--success` | `#4fb286` | 成功 |
| `--warn` | `#d6a244` | 告警、待确认 |
| `--danger` | `#e06a5e` | 失败、写操作、违例 |
| `--on-accent` | `#ffffff` | 主色底上的文字 |
| `--scrim` | `rgba(0,0,0,.55)` | 遮罩 |

配套浅底：`--danger-soft`、`--success-soft`、`--add-bg`、`--del-bg`、`--mark-bg`。

> **品牌色是蓝色**（`--accent: #4c9df0`），不是 v1.4 的青色 `#35d2c0`。v1.4 的 `--bg-canvas` / `--bg-panel` / `--text-1..3` / `--wave-1..4` / `--info` 这套变量名**不存在**，不要在新代码里用。

### 5.2 主题覆盖块

| `data-theme` | 位置 | 用途 |
|---|---|---|
| `dark` | `:root` 默认 | 夜间基线 |
| `light` | `styles.css:152` | 日间 |
| `contrast` | `styles.css:91` | 高对比（暗底） |
| `light-contrast` | `styles.css:121` | 高对比（亮底） |

`light` 覆盖：`--bg:#ffffff`、`--sidebar:#f6f7f9`、`--surface:#f2f4f7`、`--surface-raised:#ffffff`、`--text:#171b21`、`--accent:#1f6feb`、`--border:#e3e7ed`，并把阴影换成浅色版。

`contrast` / `light-contrast` 把所有文字与边框抬到最高对比（`--text:#ffffff` / `#000000`、`--border:#4a4a4a` / `#9a9a9a`）。

**已知不一致**：`contrast` 块未声明 `color-scheme: light`（继承 `:root` 的 dark），且两个高对比块都**不覆盖阴影**，浅底上沿用深色阴影。修这两处时应同时改三块。

### 5.3 字体与字号

```css
--mono:  "SF Mono", "Cascadia Code", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
--sans:  "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
```

- 数据、地址、寄存器、日志、路径、计数一律等宽。
- 字号阶：`--text-xs: 11px` / `--text-sm: 12px` / `--text-base: 13px` / `--text-md: 14px` / `--text-lg: 17px` / `--text-xl: 22px`，**全部乘 `--ui-scale`**。
- `--font-scale`（0.9 / 1 / 1.12）单独缩放转录正文，不影响界面 chrome。

> `--sans` 优先 Inter，**没有中文回退族**（v1.4 写的是 PingFang SC / Noto Sans SC / Microsoft YaHei）。中文靠系统回退渲染。

### 5.4 形状与阴影

| 令牌 | 值 |
|---|---|
| `--radius-sm` | 6px |
| `--radius` | 10px |
| `--radius-lg` | 14px |
| `--shadow-composer` | `0 10px 34px rgba(0,0,0,.42)` |
| `--shadow-popover` | `0 14px 40px rgba(0,0,0,.5)` |

圆角**只有三档**（源码注释：「three steps, no more」）。阴影只用于输入框与浮层，普通卡片靠 1px 边框分层。

### 5.5 动效

| 令牌 | 值 |
|---|---|
| `--ease` | `cubic-bezier(0.2, 0.7, 0.3, 1)` |
| `--fast` | 110ms |
| `--normal` | 170ms |

`prefers-reduced-motion: reduce` 时全局关闭动画与过渡。

### 5.6 缩放

`--ui-scale`（0.9 / 1 / 1.1 / 1.25）缩放整个界面 chrome（字号、间距），`--font-scale`（0.9 / 1 / 1.12）只缩放转录正文。两者都是根级 CSS 变量，由 `app.js:5824,5830` 写入。

---

## 6. 主题与偏好系统

### 6.1 主题：四态选择 → 五个 CSS 变体

用户可选 **4 种**（`index.html:138-141` 的 `#menu-theme`，设置页 `settings.js:403-412` 同款）：

| 选择 | 解析后 `data-theme` | 说明 |
|---|---|---|
| `system` | `light` / `dark` | 跟随系统 |
| `light` | `light` | 日间 |
| `dark` | `dark` | 夜间 |
| `high-contrast` | `light-contrast` / `contrast` | 高对比，底色跟随系统 |

解析函数 `resolvedTheme()`（`app.js:4425`）。所以 CSS 侧实际存在 5 个 `[data-theme]` 值。

### 6.2 存储与默认值

- 键名 **`prometheus.theme`**，存**用户原始选择**（不是解析后的 CSS 值）。
- 系统偏好变化时（`matchMedia("(prefers-color-scheme: light)")` 的 `change` 事件，`app.js:4416`），若当前是 `system` 或 `high-contrast` 则重新解析。
- 默认：`app.js:5809` 在**无记录或值为 `system`** 时按系统偏好解析为 `light`/`dark`，即默认跟随系统。

> **已知缺陷（待修）**：boot 时若 `prometheus.theme === "system"`，`state.theme` 被改写为 `light`/`dark`，随后 `setTheme(state.theme)`（`app.js:4449`）会把解析后的值**写回** localStorage —— 用户选的「跟随系统」在一次启动后被永久固化成具体主题。修复方向：boot 阶段不要用 `setTheme` 写回，或让 `state.theme` 与存储值解耦（存储原始选择，单独维护 `resolvedTheme` 的输出）。

### 6.3 正交偏好（`data-*` 属性）

| 属性 | 值 | 控制什么 | 存储键 |
|---|---|---|---|
| `data-motion` | `full` / `reduced` | 动效开关 | `prometheus.motion` |
| `data-density` | `balanced` / `compact` / `detailed` | 工具行密度 | `prometheus.density` |
| `data-width` | `standard` / `narrow` / `wide` | `--reading-width` 780 / 620 / 980 | `prometheus.width` |
| `data-view` | `normal` / `thinking` / `verbose` | 思考文本可见性 | `prometheus.view` |
| `--ui-scale` | 0.9 / 1 / 1.1 / 1.25 | 界面 chrome 缩放 | `prometheus.uiScale` |
| `--font-scale` | 0.9 / 1 / 1.12 | 转录正文缩放 | `prometheus.fontScale` |
| `--mono` | 字体栈 | 代码字体 | `prometheus.codeFont` |
| `--sidebar-width` | px | 侧栏宽 | `prometheus.sidebarWidth` |

### 6.4 完整存储键

```
prometheus.locale  theme  density  width  view  motion  uiScale  fontScale
prometheus.codeFont  sidebarWidth  sidebarCollapsed  lastSession  restartSession
prometheus.suggestions  updateCheck  setupDismissed  workbench  pane
prometheus.expandedProjects  collapsedProjects
```

> 键名前缀是 `prometheus.*`（**不是** v1.4 的 `eam-theme`；`eam-theme` 随 `src/ui/theme.ts` 删除）。

### 6.5 i18n

- 语言：`en` / `zh` 两套（`i18n.js` en 437 键 / zh 438 键，`settings-i18n.js` 独立一套）。
- 默认：`detectLocale()`（`i18n.js:927`）先读 `prometheus.locale`，否则看 `navigator.language`（`zh*` → `zh`，其余 → `en`）。**没有硬编码默认值**，跟随操作系统。
- 键是扁平 camelCase，值可以是字符串或带参函数。
- DOM 绑定：`applyLocale()`（`app.js:164`）扫描 `data-i18n`（textContent）、`data-prompt-key`（写 `dataset.prompt`）、`data-i18n-title`（title）、`data-i18n-placeholder`（placeholder）四类属性，外加一批手动补的节点。
- `i18n.js` 顶部注释提示与内核 `src/i18n.ts` 保持同步 —— **内核侧有第二份文案**，改动时两边都要对。

### 6.6 对比度

- 高对比主题（`contrast` / `light-contrast`）把所有文字与边框抬到最高对比，源码注释称在正文尺寸下满足 WCAG AA。
- 状态不得只靠颜色区分，必须同时有文字、图标或形状。

---

## 7. 组件与功能规格

> 「数据来源」指运行时数据的语义来源。示例值仅说明形态，不是接口契约。

### 7.1 TopBar 顶栏

- 高 48px。左侧：侧栏切换按钮、cwd 按钮；中间：goal 徽标（隐藏）、状态点 + 状态文本；右侧：changes / terminal / more（**均隐藏**）、设置按钮、窗口控件（**仅桌面**，`hidden`）。**worktree 按钮与面板已于 2026-10-22 整块删除**——内核没有 worktree 能力，点它只得到「桌面宿主暂不支持该命令」。
- 状态文本取值来自 `status` 事件与运行状态（如"starting"）。
- 主题与语言切换在 more 菜单里（`index.html:135-150`），但 more 按钮本身 `hidden` —— **该菜单当前无法打开**；设置页是它们的实际入口。

### 7.2 Sidebar 侧栏

- 宽 264px，可拖拽（6px 拖拽条，可 Tab 聚焦并用方向键调整），可折叠，窄屏变抽屉。
- 结构：品牌区 → 「新建会话」按钮 → 分组头（会话 / 过滤 / 归档 / 刷新）→ 搜索框 → 会话列表。
- **只有会话列表，没有知识库检索与厂商树**（v1.4 §7.2 整节作废）。
- 会话按 `cwd` 分组，可折叠（`prometheus.expandedProjects` / `collapsedProjects`）。**不是** v1.4 的「进行中 / 历史」分组。
- 会话状态二态：`working`（当前活动会话运行时）/ `ready`（其余）。**不是** v1.4 的三态。
- 标题：桌面宿主扫日志取首条 `user` 事件（截 80 字符，缓存 key = `id@createdAt`，最多扫 30 条）。

### 7.3 Transcript 转录

- 唯一滚动容器；`padding: 32px 16px 16px`。
- 内容列宽 `--column-width`，居中（`.turn { max-width: var(--column-width); margin: 0 auto 22px; padding: 0 28px }`）。
- 条目类型：
  - **用户气泡**：提交时本地回显（`addUserTurn`），左对齐。
  - **agent 气泡**：`addAssistantTurn()` 建 `<div class="turn assistant"><div class="markdown"></div></div>`，并在其后放一个**独立的** `<span class="caret">` 兄弟节点。
  - **工具行**：`addToolRow(name, summary)` + `attachToolOutput()`，只渲染工具名 + 参数摘要 + 输出文本，**不区分** readout / hitlist / evidence 三种卡体形态。
  - **审批条**：`div#pending-permission`，见 §7.7。
  - **提示**：`addNotice(level, text)`，级别 dim / warn。
  - **压缩接缝**：`.compact-marker`。
- 查找栏（Ctrl/Cmd+F）用 `TreeWalker` 全文标记并显示命中计数（`app.js:987-1088`）。

### 7.4 流式回答的渲染路径

这是 v2.0 新增的核心机制（对应已解决的 D-164）：

1. 内核写 `assistant_delta` 事件（`{text}`，按批落盘：默认 60ms 或 400 字符）。
2. 协议层把每个 delta 转成渲染器的 `assistant_delta{text}`。
3. `app.js:2035` 的处理：`current.text += message.text`；若当前没有待执行的 `requestAnimationFrame`，就排一帧。**一帧内多次 delta 合并为一次重绘**。
4. 帧回调里 `current.body.innerHTML = current.renderer.render(current.text)`（`IncrementalRenderer` 增量 diff），然后 `current.body.appendChild(current.caret)` —— **移动**同一个 caret 元素而不是重建，避免每帧重启它的闪烁动画。
5. 完整 `assistant` 事件到达时，协议层用 `ctx.streamedText` 比对，**只补齐尚未流式过的部分**，不重复已显示的文本（`protocol.js:223-248`）。
6. `assistant_end` → `flushAssistant()`：取消待执行 rAF、最后渲染一次、移除 caret、绑定代码复制；**若无正文则删除空气泡**。

> 协议层的 `ctx.streamedText` 是防重复的关键。若它为空而完整文本已到达，`missing` 退化为整段，renderer 会看到两次完整内容。

### 7.5 工具行

- 卡头：工具名 + 一行参数摘要。摘要由 `summarizeToolCall(name, args)`（`protocol.js:73`）生成：按 `["path","file","command","pattern","query","name","address","tool"]` 顺序取第一个字符串值（截 120 字符）或数字值；全落空则回退到工具名。
- 结果区：`tool_output` 携带 `content`，UTF-8 字节截断到 **8 KiB**（`MAX_TOOL_OUTPUT_BYTES`），截断时尾部补 `…[truncated]`。
- **失败的工具行保留错误标记**，不渲染空白读数。
- **被拒绝的调用也要留痕**：拒绝路径不写 `tool_started`，协议层会补发一行 `tool_start`（`protocol.js:270-281`）——否则转录会正好隐藏操作者最需要看到的那次调用。
- 写文件的行会把 diff 统计改写成「文件名 +15 −1」形式（`app.js:2160-2186`）。

### 7.6 Composer 输入栏

- 单框结构：输入框与所有控件在同一 frame 内（v1.4 的"上下文 / 工具集 / 快捷键 / 发送"四件套已改）。
- 控件行：模式选择器、模型选择器、用量胶囊（`#usage-meter`）。
- **模式选择器 = 内核四个权限预设**：`diagnose` / `read-only` / `workspace-write` / `danger-full-access`（`app.js:1452`）。默认 `diagnose`。
- 用量胶囊点击弹出 `usage-popover`：按输入 / 缓存 / 输出分段的色条 + 分类明细 + 本会话合计。
  > **上下文占用百分比自 2026-10-22 起可见**：内核早在 D-165 就随 `usage` 事件下发 `context{tokens,percent,window}`，但前端把 `#context-label` 写死成 `hidden` 且无人移除，百分比从未显示过。现在 `protocol.measuredContext()` 只在 `tokens` 与 `percent` 都是有限数时才认，否则 `null`（显式「未知」哨兵，**不是 0%**）；`updateMeter` 的三种输入各有语义——`undefined` 保留原值（`state` 事件只是换模式）、`null` 清除并隐藏、真实测量才显示。
  > **同日：D-195 修掉一个更要紧的问题。** `usage` 事件落盘时重新投影日志来测占用率，那一刻 assistant 已写、`tool_result` 未写，`buildMessages` 必然抛「工具批次未闭合」，被空 `catch` 吞掉——**每一条带工具调用的回合都没有占用率**（D-165 起即如此，而本仓库几乎每轮都在调工具）。现在测量移到**发请求之前**，量的是即将送出去的那份消息，这个数字也才真正表达它该表达的东西。
  > `contextBreakdown`（按类别拆分）同日起有生产者：`src/context/breakdown.ts` 的纯函数按 `systemPrompt` / `messages` / `toolResults` / `mcpTools` 分桶，各桶之和强制等于 `used`（等比缩放 + 余数补给最大桶），随同一条 `usage` 事件下发。分段条与图例不再是死代码。
- 文本域高度 `Math.min(220, scrollHeight)`（`app.js:4454`），无内部滚动条。
- 附件（图片）、`+` 菜单**均已隐藏**（无后端）。**语音输入（麦克风）已于 2026-10-22 整块删除**：按钮、`setupVoice`/`stopVoice`、录音动画、`voiceStart`/`voiceStop` 文案与 `#i-mic` 图标都不在了（Web Speech API 在 Electron 里通常不可用，留着一个永不出现的 `hidden` 空壳只是噪音）。
  > 图片粘贴/拖入的代码**仍在**（`addAttachment` / `renderAttachments`）且会画出缩略图，但 `submit()` 不读 `state.attachments`、内核 `ModelChatMessage.content` 也只是 `string`——所以图片在发送时被静默丢弃。这是 R3 缺口，登记为 **D-188**，不是「已支持」。
- **`@` 文件提及自 2026-10-22 起可用**：内核 `searchFilesByName` + 宿主 `searchFiles` 命令，沿用同一套遍历与边界规则（复用 D-181 的惰性 BFS 与 24 项忽略清单），按「基名全等 → 基名前缀 → 基名包含 → 路径包含」分层排序，层内短路径优先。目录不在结果里（D-184）。
- **斜杠命令自 2026-10-22 起可用**：`/clear`、`/context`、`/compact`；纯模块 `desktop/renderer/commands.js`（`mergeCommands` / `parseSlashText` / `contextReport`），`submit()` 先解析再决定发给模型还是本地执行。**命令执行时原文会作为一条用户消息留在转录里**；未知命令只提示、草稿留在框里，**不会**被当成提示词，也**不会**先留一条消息再报错。细节见 §8.3。

### 7.7 审批条

- 位置：输入区上方（`div#pending-permission`），不是消息流内。
- 内容：问题文本（`question`）+ 参数预览（`detail.paramsPreview`）+ 「Allow」/「Deny」两个按钮。
- **只有 yes / no**。「始终允许」按钮在 HTML 里带 `hidden`，`permission_request` 分支只显示这两个 —— v1.4 写"只显示 yes/no"的规则在此仍然成立，但实现路径不同。
- 终态由 `permission_closed{id}` 收起审批条（`app.js:2282`），协议层在 `permission_decision` 到达时发出 —— 审批超时或被内核自动拒绝时，条也会收起，不会留下一个点了没用的按钮。
- 拒绝时额外发一条 `notice{level:"warn"}`（协议层 `protocol.js:325-333`）。

### 7.8 Workbench 工作台

- 宽 420px（可拖 320–560），内部用 **tab 切换**，只有两个 tab：**板卡（board）** 与 **串口（serial）**。
- 其余 7 个面板（files / diff / history / tasks / artifact / terminal / browser）的 DOM 仍在 `index.html:381-501`，但**不在 tab 条里**，`openWorkbench()` 对非支持面板直接 return（`app.js:2654`）。空 tab 是死路，不是占位。
- 板卡面板消费 `board_state`（由内核 `device_status` 事件转换而来），`state.device` 原样透传，**内核与 UI 都不解释、不补全、不推断**。
- 串口面板有端口 / 波特率选择、过滤、暂停、清空、导出、跟随开关。
- **板卡/串口的写操作入口已隐藏**（`desktop/MATRIX.md`）。

### 7.9 设置页

全窗口 `<dialog>` 页面（不是模态卡片）：左侧 240px 分组栏（含搜索框）+ 右侧滚动 pane。

只有 **3 个页面**（`settings.js:71-73`）：

| id | 内容 |
|---|---|
| `general` | profile 卡（只读，显示 cwd）；语言选择；outputStyle、restartSession、suggestions、updateCheck、isolateByDefault 五个开关 |
| `appearance` | 主题（4 态，带预览色块）；字号、宽度、代码字体；视图模式、密度、减少动效；界面缩放 |
| `about` | 版本号、检查更新、数据目录（只读） |

> Provider keys / MCP servers / skills / memory / instructions / hooks / packs / system 等页面的 builder 仍留在 `settings.js` 里但**未注册** —— 它们需要内核未暴露的写 API，列出来只会产生"保存按钮无效"的表单。恢复只需在 `settingsPages()` 加一行。

### 7.10 命令面板与快捷键

- **Ctrl/Cmd+K** 打开命令面板（`paletteEntries()`，`app.js:4913`）。
- **Ctrl/Cmd+F** 打开查找栏。
- **Esc** 依次关闭：命令面板 → 查找栏 → 设置/快捷键对话框 → 顶栏菜单 → 模型菜单 → 审批条（**视为拒绝**）→ 中止运行。

### 7.11 空态与错误态

- 无会话：侧栏显示「暂无会话」；设备字段为 `unknown` 时显示「未接入」。
- 提交失败：在转录中显示可读错误，**不伪造成功**。
- 宿主接受 prompt 只表示发起了一次运行；工具是否执行以会话日志的 `permission_decision` 与 `tool_result` 为准。

---

## 8. 数据契约与状态投影

### 8.1 事件模型（内核事实源）

**持久化会话事件**（会话日志，回放与实时流的唯一事实源）：

```ts
type EventType =
  | "system" | "user" | "assistant" | "assistant_delta" | "tool_call" | "tool_started"
  | "tool_result" | "usage" | "checkpoint" | "status" | "mcp_status"
  | "device_status" | "interrupted" | "compaction" | "permission_decision"
  | "approval_request";
```

与 `src/session/types.ts` 逐字一致。

```ts
interface SessionEvent {
  seq: number;
  ts: string;
  type: EventType;
  payload: Record<string, unknown>;
  parent?: number;
}

interface SessionEventEnvelope extends SessionEvent {
  sessionId: string;
}
```

`tool_call` 仅用于旧日志回放，新代码不再产生；允许路径使用 `permission_decision → tool_started → tool_result`，拒绝/校验失败路径为 `permission_decision → tool_result`（不写 `tool_started`）。旧日志中的 MCP `status` 事件继续按 `mcp_` 前缀识别，新代码只写 `mcp_status`。

`assistant_delta` 是模型回答的流式片段（payload `{text}`），与 `assistant` 并存：`assistant` 是这一轮的最终结论（内容完整，用于重建模型上下文），`assistant_delta` 只用于实时显示。投影层忽略 delta，只用 `assistant` 重建上下文。增量按批落盘（默认 60ms 或 400 字符），不是逐 token —— 每条事件都要 fsync，逐 token 落盘会把一次回答变成上百次磁盘同步。

### 8.2 协议层：内核事件 → 渲染器事件

`desktop/renderer/protocol.js` 是**纯函数**层，不碰 DOM、文件系统与网络。宿主与渲染器是两个进程，这一层是它们共用的映射，保证同一份日志给出同一套 UI。

导出：

| 导出 | 签名 | 作用 |
|---|---|---|
| `MAX_TOOL_OUTPUT_BYTES` | `= 8 * 1024` | 工具输出进入 DOM 前的截断阈值 |
| `summarizeToolCall` | `(name, args) => string` | 工具行的一行参数摘要 |
| `sessionEventsToMessages` | `(events) => PublicMessage[]` | 从完整日志重建转录行 |
| `createContext` | `(options?) => ProtocolContext` | 每个打开会话一个翻译上下文 |
| `sessionEventToHostEvents` | `(event, ctx) => HostEvent[]` | 单个内核事件 → 0..N 个渲染器事件 |
| `initialState` | `(options?) => HostEvent` | boot 时的 `state` 事件 |
| `sessionsEvent` | `(summaries) => HostEvent` | `sessions` 事件 |
| `sessionLoadedEvent` | `(events, options?) => HostEvent` | `session_loaded` 事件 |
| `LAST_SESSION_STORAGE_KEY` | `= "prometheus.lastSession"` | 渲染器记忆上次会话的键 |

**`sessionEventToHostEvents` 完整映射**：

| 内核 type | → 渲染器事件 |
|---|---|
| `system` / `tool_call` / `checkpoint` | 不产出 |
| `user` | 不产出（渲染器提交时已回显） |
| `assistant_delta` | `assistant_delta{text}` |
| `assistant` | `assistant_start` → （补齐未流式部分）`assistant_delta{text}` → `assistant_end` |
| `tool_started` | `tool_start{name, summary, id}` |
| `tool_result` | `tool_end{name, ok, summary, id}`；成功时另加 `tool_output{name, content}`；此前无 `tool_started` 时补一行 `tool_start` |
| `approval_request` | `permission_request{id, question, detail:{tool, preset, paramsPreview, deadlineAt}}` |
| `permission_decision` | `permission_closed{id}`；`effective==="deny"` 时另发 `notice{level:"warn"}` |
| `device_status` | `board_state{state:{selection, projectKind, device, tool, updatedAt}}` |
| `mcp_status` | `notice{level:"dim"\|"warn"}`（`connected`/`tools_changed` 为 dim，其余 warn） |
| `usage` | `usage{usage:{inputTokens, outputTokens, cachedTokens}}` |
| `status` | `done` → `run_end`；`usage_missing` → `notice{dim}`；`device_status_invalid` / `permissions_project_config_skipped` → `notice{level:"warn"}` |
| `interrupted` | `notice{level:"warn"}`（文案按 reason 映射）+ `run_end` |
| `compaction` | `microcompact` → `compacted{removed, level:"micro"}`；`summary` → `compacted{level:"summary", before}`；`failed` → `notice{level:"warn"}` |
| 未知类型 | `notice{level:"warn", text:"未识别的事件类型: <type>"}`（R3，不静默） |

**去重**：`ctx.lastSeq` 单调递增，`event.seq <= ctx.lastSeq` 直接丢弃（`protocol.js:188-191`）。

**`sessionEventsToMessages` 产出的 message**：

| role | 字段 |
|---|---|
| `user` | `role`、`text`（`payload.content`）、`index`（自增）、`images: 0` |
| `assistant` | `role`、`text`（`payload.content`，trim 后非空才产出） |
| `tool` | `role`、`name`（`call.name` 或 `payload.toolName`）、`summary`、`ok`、`done: true` |

> 该函数**不产出** `assistant_delta`、审批、工具输出等行。它只用于打开会话时重建**骨架**；实时的富信息（工具输出全文、审批条）由后续事件补上。

### 8.3 桌面宿主（`desktop/host/host.js`）

NDJSON over stdio，Electron 主进程以 `ELECTRON_RUN_AS_NODE=1` spawn。宿主只从编译后的 `dist/` 导入内核模块；`dist/` 缺失时发 `fatal` 并 `exit(1)`。

**命令**：`init`、`prompt`、`abort`、`permission`、`newSession`、`loadSession`、`listSessions`、`setMode`、`setLocale`、`setUiPreference`、`getSettings`、`getUsage`、`getSetupChecklist`、`listCommands`、`getTree`、`searchFiles`、`searchSessions`、`compact`、`shutdown`。

**斜杠命令**（2026-10-22）：`listCommands` 回 `clear` / `context` / `compact` 三个。**命令真正执行时，敲进去的原文会作为一条普通用户消息留在转录里**（`/clear` 也一样，虽然它紧接着的 `session_loaded` 会清空转录）；未知命令与「带了参数被拒」的命令**不 echo**——先留一条消息再报错，会让人以为它跑过。`/clear` 在渲染器侧直接发 `newSession`；`/context` 由渲染器从内核自己的测量回答，逐行给出「用了多少 / 窗口 / 百分比」、每个类别占窗口的份额、剩余空间与压缩前余量，未知时明说「没有测量」而不是打印一页 0；`/compact` 走宿主的 `handleCompact`——用 `resumeSession` 打开会话、调内核 `compactSession({…, force: true})`。**不再看阈值**：用户显式要求压缩时，`force` 跳过软阈值提前返回与 microcompact 阶段，直接产出摘要；随后把新追加的 `compaction` 事件经 `sessionEventToHostEvents` 投影（复用既有的 `compacted` 标记），给出压缩前后的实测 token 数，并用新的测量刷新 `state.context` 与 `contextBreakdown`。压缩期间持有 `run_start`/`run_end` 与一个独立的 `AbortController`，`abort` 会先中止它。**三个命令都不接受参数**：内核 `compactSession` 没有 focus / keep 选项，`--keep N` 会是一个没人兑现的承诺（原 `parseCompactArgs` 已删）。`dist/` 缺 `context/compact.js` 或 `context/breakdown.js` 时回「请先 npm run build」而不是崩宿主。

**未列入的命令**统一回 `notice{level:"warn", text:"桌面宿主暂不支持该命令：<cmd>"}`。

**会话游标**：prompt 前用 `eventSource.read(sessionId, -1)` 取 `headSeq` 作 `since`，**在 `runner.start()` 之前捕获**；`startFollow` 在 `start()` 之后启动，保证本轮首批事件被包含。`follow` 只 yield `event.seq > cursor` 的事件；去重在协议层。

**providers 缺失**：`init` 中 `loadProviders` 抛错 → 发 `fatal` 并停止，**不发 `ready`/`state`/`sessions`**，渲染器停在"连接中"。

### 8.4 浏览器 bridge（`desktop/renderer/bridge.js`）——已删除，仅历史留档

> **2026-10-22 起本节描述的形态不存在。** `desktop/renderer/bridge.js`、`src/server` 的 HTTP 层（`api.ts` / `serve.ts` / `http.ts` / `body.ts` / `config-api.ts` / `event-stream.ts`）、`tests/desktop/bridge.test.js`、`tests/events-e2e.test.ts` 与 `tests/server/` 下的 HTTP 用例全部删除。`window.prometheus` 现在只有一个来源——`desktop/preload.cjs` 的 `contextBridge`。以下内容保留以便追溯，不要据此实施。

仅当 `window.prometheus === undefined` 时安装（Electron 下 preload 已提供，bridge 不覆盖）。

**`window.prometheus` 成员**：`send`、`onEvent`、`openExternal`、`pickDirectory`（恒 `null`）、`pickFile`（恒 `null`/`[]`）、`saveFile`（Blob 下载）、`appVersion`（恒 `"web"`）、`restartHost`（`location.reload()`）、`platform`（`undefined`）、可选 `notify`。

**命令 → 端点**：

| cmd | 端点 |
|---|---|
| `prompt` | `POST /api/actions`（`{text, sessionId?}`） |
| `permission` | `POST /api/approvals`（`{sessionId, requestId, decision}`） |
| `abort` | `POST /api/abort`（`{sessionId}`） |
| `listSessions` | `GET /api/sessions` |
| `loadSession` | `GET /api/sessions/:id` |
| 实时事件 | `GET /api/events?sessionId=&since=`（SSE） |

其余命令（`newSession`、`setMode`、`setLocale`、`setUiPreference`、`getSettings`、`getUsage`、`getSetupChecklist`、`listCommands`、`getTree`、`searchSessions`）**纯本地**，不发网络请求。

不在白名单内的命令回 `notice{level:"warn", text:"浏览器形态暂不支持该命令：<cmd>"}`。

**`searchFiles`**（2026-10-22 起真实实现）：不在 `supportedCommands` 里，但在 `send()` 的 switch 之前单独拦截，走 `GET /api/files/search?path=<currentCwd>&query=<q>`，把 `{files, truncated, scanned}` 映射成 `file_matches`。仍然不每字符回警告——补全弹窗每按一次键请求一次，按通用路径每字符一条 warn 会把整个转录埋掉；请求失败时安静回空（桌面宿主则在边界拒绝时发 `notice`）。

**`listCommands`** 回 `clear` / `context` 两个。**`/compact` 在浏览器形态刻意缺席**：HTTP 层没有压缩路由，伪造一条成功会违反 R3；用户仍能敲 `/compact`（`compact` 在白名单里，好让请求走到 switch 而不是落进「暂不支持」的通用文案），得到一条说明「浏览器形态无法压缩」的 warn，且**不发任何请求**（有用例断言 `/api/actions` 调用数为 0）。

### 8.5 两种形态的差异——已作废，仅历史留档

> 浏览器形态下线后这些维度只剩桌面一种取值，差异表失去对象。桌面侧行为即 `desktop/host/host.js` 的行为，见 §8.3。

| 维度 | 桌面 | 浏览器 |
|---|---|---|
| 模型列表 | 真实加载 `providers.json` | 恒 `[]` |
| `state.baseUrl` | 真实值 | 恒 `""` |
| `getUsage` | 真实累加当前会话 usage 事件 | 恒 `summary: null` |
| `getSetupChecklist` | 两项真实检查 | 恒 `checks: []` |
| `searchSessions` | 真实本地过滤 | 恒 `sessions: []` |
| `setMode` | 改内核权限预设并重建 runner | **仅本地状态，内核权限预设不变** |
| `setLocale` | 改宿主 locale | 写 `prometheus.locale` |
| 会话标题 | 服务端扫日志（≤30，带缓存） | 客户端逐个拉详情（≤30） |
| `pickDirectory` / `pickFile` | Electron 原生对话框 | 恒 `null` / `[]` |
| `saveFile` | Electron 写盘 | Blob 下载 |
| `platform` / `windowControl` / `notify` | 有 | 无 |
| 缺 provider | `fatal`，不发 `ready` | 无 providers 概念，恒空列表 |

> 表中「浏览器」列的 `setMode` 语义缺口（只改本地状态、内核预设不变）**已随 bridge 删除而不存在**；桌面宿主的 `setMode` 会 `runner.close()` 后重建 runner，下一次运行按新预设走。

### 8.6 实时事件流——SSE 端点已删除，仅历史留档

> 原先的 SSE 端点、`Last-Event-ID` 补播、`retry: 3000`、15s 心跳、`stream_end` / `stream_error`、500 条实时队列与 `slow_consumer` 单帧写超时全部随浏览器形态删除，不存在要遵守的协议。桌面侧实时链路见 §8.3「会话游标」——宿主跟随本地日志、按 `seq` 去重，**没有**缺口检测与整量重拉。

- 端点：`GET /api/events?sessionId=<id>&since=<seq>`。`since` 缺省读 `Last-Event-ID`，都缺省按 `-1` 从头补播；`since` 大于会话当前最大 `seq` 时按该 `seq` 夹紧。
- 帧格式：普通事件 `id: <seq>` + `data: <SessionEventEnvelope JSON>`；`retry: 3000`；每 15s 一条注释心跳 `: ping`；会话已关闭且补播完成后发 `event: stream_end`（`{"lastSeq":N}`）；异常发 `event: stream_error`（`{"code","lastSeq"}`）后关闭。
- 慢客户端：实时队列上限 500 条；实时阶段单帧写超时（默认 30s）或队列溢出 → `stream_error {code:"slow_consumer"}` 并关闭。

> **历史偏差记录（已无对象）**：当时 README 承诺的「缺口检测 → 整量重拉（每次订阅最多 3 次）」在 `bridge.js` 中一度不存在，后来补上；这些机制与桌面宿主都无关，现已随 bridge 一并删除。

### 8.7 工具语义标记

工具定义携带注解：

```ts
interface ToolAnnotations {
  readOnly?: boolean;
  evidence?: boolean;
  destructive?: boolean;
}
```

| 注解 | UI 行为 |
|---|---|
| `readOnly: true` | 卡头使用中性色，不出现危险语义 |
| `evidence: true` | 结果进入"证据链"视觉 |
| `destructive: true` | 卡头与操作按钮使用 `--danger`，触发确认流程 |

> 当前渲染器**未**消费这三个注解（工具行只渲染名称 + 摘要 + 输出）。这是一条待补的契约。

---

## 9. 交互规范

| 操作 | 行为 |
|---|---|
| 主题切换 | 即时生效，写入 `prometheus.theme`，不重载 |
| 侧栏折叠 / 拖拽 | 折叠写 `prometheus.sidebarCollapsed`；拖拽写 `prometheus.sidebarWidth` |
| 发送消息 | Enter 发送；空输入禁用发送按钮。**成功后不重载会话** —— 渲染器已回显用户消息，只有切换会话才重建转录 |
| 切换会话 | `session_loaded{messages}` → 清空转录 DOM 并按骨架重建 |
| 新建会话 | 清空活动会话与转录，关闭旧流 |
| 审批决定 | 卡片按钮经宿主 `permission` 命令走 `runner.decide`；终态只由 `permission_closed` 更新 |
| 权限拒绝 | 协议层发 `notice{level:"warn"}`，工具行保留失败标记 |
| 中止 | 「停止」按钮或 Esc → 宿主 `abort` → `runner.abort` |
| 权限模式 | 切换时若正在运行则拒绝并说明原因；切换会重建 runner |
| 滚动 | 距底 <140px 自动跟随，>220px 显示「滚动到底部」按钮 |
| 命令面板 | Ctrl/Cmd+K；查找 Ctrl/Cmd+F |

动效：

- 只使用 `--fast`（110ms）与 `--normal`（170ms）两档；
- `prefers-reduced-motion: reduce` 时全局关闭动画与过渡；
- 不使用入场动画、悬浮位移、渐变装饰。

---

## 10. 可访问性

- 所有可交互元素可 Tab 到达；`:focus-visible` 有可见焦点环（`styles.css:217-220, 310` 等）。
- 侧栏拖拽条是 `role="separator"` 且 `tabindex="0"`，键盘也能调宽。
- 折叠控件使用 `aria-expanded`；开关使用 `aria-pressed`；图标按钮用 `data-i18n-title` 提供可访问名。
- 状态不得只靠颜色：同时提供文字标签、图标或形状。
- 输入框有可见标签或 `aria-label`；表单控件使用原生元素。
- 支持系统减少动效偏好。
- 最小字号 11px（`--text-xs`）且仅用于元信息。

> **已知缺口**：多数图标按钮用 `title`（经 `data-i18n-title`）而非 `aria-label` 承载可访问名。`title` 在部分屏幕阅读器与触屏上不朗读，键盘用户需悬停才能看到。补 `aria-label` 时应与 i18n 键一起补。

---

## 11. 响应式

| 断点 | 变化 |
|---|---|
| > 1500px | 完整布局 |
| 900–1500px | 工作台 tab 收紧 padding / 字号；栏宽不变 |
| < 900px | `.main-body` 纵向堆叠；工作台占 45% 高度；侧栏变 fixed 抽屉 |

降级原则：优先保证"诊断对话 + 证据"可读；隐藏的栏位不丢失状态，恢复宽度后原状还原。

---

## 12. 视觉验收清单

基准视口 1600×1000（Chromium 无头实测口径）。实现后须逐项通过：

| # | 检查项 | 通过标准 |
|---|---|---|
| V1 | 顶栏高度 | `.topbar` 计算高 = 48px |
| V2 | 侧栏宽 | `.sidebar` 计算宽 = 264px（未拖拽时）；拖拽后 = `--sidebar-drag-width` |
| V3 | 内容列宽 | `.turn` 的 `max-width` = `--column-width` = `min(780px, 100vw − 120px)`（standard 档） |
| V4 | 无横向溢出 | `document.scrollWidth === window.innerWidth` |
| V5 | 工作台宽 | `.workbench` 计算宽 = 420px（未拖拽时） |
| V6 | 无文本截断 | 关键文本元素 `scrollWidth ≤ clientWidth + 1` |
| V7 | 主题令牌 | `dark` / `light` / `contrast` / `light-contrast` 四块的 `--bg` / `--accent` 计算值符合 §5.1、§5.2 |
| V8 | 无 emoji | 页面文本与图标中不存在 emoji 字符 |
| V9 | 焦点可见 | Tab 遍历所有页面内控件（含原生 input/select/textarea），均有可见焦点环 |
| V10 | 减少动效 | 开启 reduce 后无过渡与平滑滚动 |
| V11 | 流式不重复 | 一轮回答只产生**一个** assistant 气泡，正文 = 完整 `assistant` 事件内容（流式与完整不叠加） |
| V12 | 拒绝留痕 | 被拒绝的工具调用在转录里仍有一行可见的工具行 |
| V13 | 审批诚实 | 审批条只出现 Allow / Deny；内核自动拒绝后审批条自动收起 |
| V14 | 写操作确认 | 复位/写内存未确认时，界面不显示"已执行" |
| V15 | 诚实降级 | 内核未支持的能力入口不可见；宿主收到对应命令时给出显式 notice |

> v1.4 的 V1–V14 是基于三栏 Preact 布局的几何断言（栏头 y=48 h=40、主区 = 视口 − 668、知识库树 717px 可见、回放一致性 `transcript-consistency` 等），**已随旧实现整体作废**。旧 `scripts/verify-ui.mjs` 验收脚本随 `src/ui` 删除，本清单目前靠人工核对，尚无自动化脚本守护。

---

## 13. 决策结论

| ID | 结论 | 日期 | 依据 |
|---|---|---|---|
| OPEN-UI-01 | ~~**Preact + Vite**~~ → **作废** | 2026-10-18 | 2026-10-20 前端移植后被取代：改为纯 ES 模块，无框架、无打包器、无构建步骤（§2.1） |
| OPEN-UI-02 | ~~扩展 `LoopEvent.tool_result`~~ → **失去对象** | 2026-10-18 | 前端不再消费 `LoopEvent`，只消费 `SessionEvent`（§8.1、§8.2） |
| OPEN-UI-03 | ~~**SSE + HTTP POST**（浏览器形态）；桌面形态为 NDJSON over stdio~~ → **只剩桌面半条（2026-10-22 浏览器形态下线）** | 2026-10-18 | 事件单向、低频；自动重连、可 curl 调试。SSE 端点与 HTTP POST 已随 `bridge.js` 与 `src/server` HTTP 层删除（§2.2） |
| OPEN-UI-04 | **不做**实时波形与仪器联锁 | 2026-10-18 | R1 禁止 LLM 直接控制仪器；信号物理层诊断属人工执行域 |
| OPEN-UI-05 | 暂不做虚拟滚动；触发条件：单会话 DOM 节点 > 5000 或渲染帧 > 50ms | 2026-10-18 | 消息流 append-only；避免破坏查找、折叠与可访问性 |
| OPEN-UI-06 | M3 只做**派生入口 + 来源标记**，树形导航后置 | 2026-10-18 | `SessionEvent.parent` 已具备，无需提前设计树形 UI |
| OPEN-UI-07 | **前端为纯 ES 模块**，无框架无打包器 | 2026-10-20 | 前端移植；`desktop/renderer/` 直接由 Electron 加载，零构建 |
| OPEN-UI-08 | **内核不支持的能力隐藏入口**，宿主回显显式 notice | 2026-10-20 | R3 工具必须诚实：渲染一个只会报错的按钮比没有按钮更糟 |
| OPEN-UI-09 | **不渲染「始终允许」** | 2026-10-20 | 内核审批桥只有单次 allow/deny，无持久规则；按钮即失信的承诺 |
| OPEN-UI-10 | ~~**上下文占用百分比隐藏**~~ → **作废（2026-10-22）** | 2026-10-20 | 原理由「内核只报花费不报占用」早在 D-165 就已不成立（`usage` 事件带 `context{tokens,percent,window}`）；本轮才把 `#context-label` 的 `hidden` 真正解除。`null` 表示未知，**不是 0%** |

> 后续新增前端决策沿用 `OPEN-UI-xx` 编号；已关闭项保留在本表，不删除。

---

## 14. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-10-18 | 首版：从 `prototypes/index.html` 提取令牌、栅格、组件与验收口径；对齐 `SessionEvent` / `LoopEvent` / `ToolResultPayload` / `ToolAnnotations` 实际类型；登记 6 项前端待决策 |
| v1.1 | 2026-10-18 | 关闭 6 项决策：前端定为 Preact + Vite；实时通道定为 SSE + HTTP POST；决定扩展 `LoopEvent.tool_result`；波形与仪器联锁列为不做；虚拟滚动设触发条件；fork 仅做派生入口 |
| v1.2 | 2026-10-18 | Task 10 视觉验收落地：V2 主区公式由笔误 `−664` 修正为 `−668`；V3 明确滚动条占位从内容宽中扣除；V6 明确验收对象为厂商分流子树；V11 明确覆盖原生表单控件 |
| v1.3 | 2026-10-20 | 事件总线：事件模型补 `tool_started` / `mcp_status` / `device_status` / `permission_decision` 与对应 payload；明确统一事件数组、游标去重、缺口整量重拉、断线上限；设备面板按 `device_status` patch 并在重载时从历史重建 |
| v1.4 | 2026-10-20 | Web 审批：新增 `approval_request` 事件与 `ApprovalRequestPayload`，补 §7.16 审批卡片字段与状态机；明确新会话按钮与发送失败展示 |
| **v2.0** | **2026-10-20** | **前端移植后整体重写**：前端由 Preact 工作台（`src/ui/`，31 文件）替换为 Prometheus 渲染器（`desktop/renderer/`，纯 ES 模块）。作废 v1.4 的 §2 技术约束、§3 信息架构、§4 布局、§5 令牌、§6 主题、§7 组件规格、§11 响应式、§12 验收清单，改以实现为准重写；保留 §8.1 事件模型、§8.3 工具语义标记与 §13 中未失效的决策。新增 §7.4 流式渲染路径（D-164 修复）、§8.2 协议层映射表、§8.5 双形态差异表；登记 4 条已知偏差（bridge 无缺口重拉、浏览器形态 setMode 不改内核预设、`system` 主题在 boot 后被固化、图标按钮用 title 而非 aria-label）与 1 条死依赖（`vite`）** |
| **v2.1** | **2026-10-22** | **只保留桌面形态**：删除 `desktop/renderer/bridge.js` 与 `src/server` 的 HTTP 层（`api.ts` / `serve.ts` / `http.ts` / `body.ts` / `config-api.ts` / `event-stream.ts`），`serve:ui` 脚本移除。本文件相应改写：§1.1 第 5 条与 §2.1 / §2.2 去掉浏览器形态；§1.4 与 §2.3 去掉 bridge 与写端点 `Origin` 要求；§3.3 只剩一个 `<script type="module">`；§7.2 / §7.6 / §7.11 去掉 bridge 专属行为与「202 受理」措辞；§8.2 改为「宿主与渲染器共用」；§8.4 / §8.5 / §8.6 标注为历史留档；§9 / §12 V15 / §13 OPEN-UI-03·07·08 / §15 第 1·2·9 条同步。`/compact` 不再有「浏览器形态缺席」这一说 |

---

## 15. 已知偏差与待补清单

| # | 项 | 位置 | 建议 |
|---|---|---|---|
| 1 | ~~bridge 无缺口检测与重连上限~~ **已修（2026-10-21），后随浏览器形态下线作废（2026-10-22）** | `bridge.js`（已删除） | `seq > lastSeq + 1` 触发整量重拉（≤3 次）；`stream_error` 从实际游标续接（≤3 次）后明说停止。桌面宿主自始至终没有这套机制，按 `headSeq` 跟随本地日志 |
| 2 | ~~浏览器形态的 `setMode` 只改本地状态~~ **已修（2026-10-21），后随浏览器形态下线作废（2026-10-22）** | `bridge.js`（已删除） | 预设随 prompt 下发，runner 覆盖本次运行；未知值报 `invalid_mode`。桌面宿主由 `setMode` 重建 runner |
| 3 | ~~`system` 主题一次启动后被固化~~ **已修（2026-10-21）** | `app.js` `setTheme` / boot | `setTheme(theme, {remember:false})`：推导值不写回存储 |
| 4 | 图标按钮用 `title` 而非 `aria-label` 承载可访问名 | `index.html` 大量 `data-i18n-title` | 补 `aria-label`，与 i18n 键一起补 |
| 5 | ~~工具注解 `readOnly` / `evidence` / `destructive` 未被 UI 消费~~ **已修（2026-10-21）** | `src/loop/query.ts` → `protocol.js` → `app.js` `toolAnnotationBadges` | 注解随 `tool_started` 下发（只带 true 键），工具行在名字后画徽标；缺省不画徽标，因为「未声明」不等于「已确认安全」 |
| 6 | 视觉验收无自动化守护 | —— | 旧 `scripts/verify-ui.mjs` 已随 `src/ui` 删除；按 §12 新清单重写 |
| 7 | `vite` 是死依赖 | `package.json` devDependencies | 移除（`vitest` 自带所需版本） |
| 8 | 阶段 4 交互层（回放 / 导出 / 设备控制）未落地 | `docs/superpowers/specs/2026-10-20-m2-stage4-interaction-design.md` §7-§9 | 该 spec 的 §7-§9 依赖已删除的 `src/ui`（12 文件、约 30 个导出符号），需按本前端重写；详见 D-166 |
| 9 | ~~MCP / 权限规则 / 运行参数（systemPrompt、maxTurns、maxCostUsd、timeoutMs）无前端入口~~ **已修（2026-10-21）** | 内核 `src/config/app-config.ts` + 宿主命令 + `settings.js` | 设置页「MCP 服务器」与「行为」两页读写 `mcp.json` / `permissions.json` / `run.json`；运行上限由宿主从 `run.json` 读取后随每次 prompt 下发（原 `GET/PUT /api/config` 端点已随 HTTP 层删除） |
| 10 | 串口监视器已从工作台移除（工作台现有 Board / File / Artifact 三个 tab） | `index.html` 工作台 | `serialOpen`/`serialStatus`/`serialRead` 无宿主实现，内核只经 MCP 工具暴露串口；探针的串口状态在板卡面板「设备」段显示。恢复需要先给内核补串口命令 |

---

## 16. 相关文档

- `desktop/MATRIX.md` — 命令/事件能力矩阵（已支持 / 隐藏 / 原因），是 D-166 指定的事实源
- `docs/deferred-issues.md` — D-163（桌面未实机）、D-164（流式，已解决）、D-165（无上下文占用率）、D-166（未覆盖能力清单）
- `docs/BRD.md` — 业务需求与硬性规则 R1–R9
- `docs/p0-kernel-design.md` — 内核设计
- `docs/m2-roadmap.md` — M2 路线图
- `dev-notes/M2-前端移植.md` — 本次移植的过程留痕与翻车记录
