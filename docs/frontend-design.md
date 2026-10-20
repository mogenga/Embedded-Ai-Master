# 前端设计文档 · 诊断工作台

> 版本 v1.1 · 2026-10-18 · 状态：**设计基线，前端选型已定**
> 视觉基线：`prototypes/index.html`（单文件、零外部依赖，所有令牌与尺寸已内联于本文，不依赖打开原型）
> 业务依据：症状驱动诊断闭环、诊断过程可视化与会话回放、动作三类归属与安全边界（写内存/复位前先声明、工具必须诚实）
> 本文边界：只定义前端的设计契约、组件规格与验收口径；不定义内核实现，不定义 MCP server 的工具清单。

---

## 1. 目标与范围

### 1.1 设计目标

1. **一眼看懂诊断处于哪一步**：症状、分流提问、KB 检索、探针取证、根因判决构成一条可读的路径，而不是一屏散落的日志。
2. **证据优先**：工具调用不是"正在调用某工具"的黑盒，而是可核对的读数（地址、值、字段、判定），支撑「可证伪」的诊断结论。
3. **调试坞随开随用**：设备监控、端口设置、调试日志在右侧按需展开，不打断主对话的阅读动线。
4. **专业、克制、可长时间注视**：以仪器面板的克制语言为主，不用装饰性图形、不用 emoji、不用大面积高饱和色。
5. **回放可复现**：界面状态必须能从会话日志重建，禁止"只能靠重新查硬件才能显示"的状态。

### 1.2 范围内

- 三栏工作台布局与响应式降级；
- 日间 / 夜间 / 跟随系统三态主题；
- 诊断会话的消息流、工具取证卡、证据表、根因判决卡、动作归属与安全提示；
- 左栏知识库检索与树形浏览、诊断会话列表；
- 右侧调试坞：设备监控、端口设置、调试日志；
- 状态栏、键盘操作、可访问性、视觉验收口径。

### 1.3 非目标

- 不在界面内直接控制仪器（逻辑分析仪 / 示波器 / 程控电源）；界面只呈现建议步骤，由人执行。
- 不做实时波形与逻辑分析仪时序图；信号物理层诊断属人工执行域，仪器联锁不在 M3 范围（结论见 §13）。
- 不做多语言；文案当前仅简体中文。
- 不做移动端优先布局；窄屏只保证"可用降级"，不是主场景。

---

## 2. 技术约束（内联，完整）

以下为已定案、实施时不得自行更改的约束：

- **语言与运行时**：TypeScript + Node 24，ESM-only，禁止 CommonJS 混用；`package.json` 声明 `"engines": { "node": ">=24" }`。
- **协议层**：MCP 官方 TypeScript SDK v2——`@modelcontextprotocol/client`、`@modelcontextprotocol/server`、`@modelcontextprotocol/server/stdio`。
- **Schema**：Zod v4（MCP SDK v2 走 Standard Schema）。
- **测试**：vitest（当前仓库 `vitest ^4.1.6`）。
- **模型适配层**：自研极简适配器，仅 `complete` / `countTokens`；P0 只实现 OpenAI 兼容端点。
- **内核**：主循环、会话、工具系统、上下文、MCP 生命周期全部自研，不引入现成 harness。
- **前端框架**：**Preact + Vite**（2026-10-18 定案）。Preact 只承担组件化与增量 diff；会话状态必须留在纯函数投影（§8.2 的 `TranscriptView`）中，不得塞进组件内部状态。构建产物为 ESM，与 Node 24 内核同构；Vite 仅用于开发期与打包，不引入第二套模块系统。
- **实时通道**：**SSE + HTTP POST**（2026-10-18 定案）。服务端经 SSE 推送与 `LoopEvent` 同构的事件，客户端动作走 HTTP POST；客户端保留 `EventSource` 抽象，便于未来替换为进程内实现。
- **浏览器基线**：Chromium 系（含桌面端内置 WebView）与 Firefox 当前稳定版；主题与滚动条使用 CSS 标准属性，旧 Chromium / Safari 降级到 `::-webkit-scrollbar`。
- **零 emoji**：界面图标一律为内联 SVG（页内 `<symbol>` sprite + `<use>`）；状态点、连接线、分隔线用 CSS 绘制；文案中不使用 emoji。
- **安全边界落到界面**：写内存 / 复位类操作在界面上必须呈现"待确认"状态并展示目标地址与值；只读工具不得渲染为危险操作；工具失败必须显式展示错误，不得以空值或全 0 读数伪装成正常。

---

## 3. 信息架构

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ A 顶栏  品牌 │ 目标芯片 · 分支 · 后端 │            主题三态 │ 调试坞开关      │ 48
├──────────────┬────────────────────────────────────────────┬──────────────────┤
│ B 左栏 264   │ C 主对话区（自适应）                        │ D 调试坞 404     │
│              │                                            │                  │
│ 知识库        │ 会话头（标题 / 状态 / 回放 / 导出）         │ 设备监控          │
│  检索         │ 诊断路径条（5 步）                          │  目标/探针/CPU    │
│  厂商树       │                                            │  控制按钮         │
│              │ 消息流                                     │  寄存器表         │
│ 诊断会话      │  用户气泡                                   │                  │
│  进行中       │  agent 回复 / 澄清提问                      │ 端口设置          │
│  历史         │  工具调用卡（读数 + 证据表）                │  端口/波特率      │
│              │  根因判决卡（根因/证据/预测/归属）           │  收发统计         │
│              │  安全提示                                   │                  │
│              │ 输入栏                                      │ 调试日志          │
├──────────────┴────────────────────────────────────────────┴──────────────────┤
│ E 状态栏  探针 / 串口 / 告警          会话号 · 上下文 · 费用 · 平台            │ 26
└──────────────────────────────────────────────────────────────────────────────┘
```

组件树：

```
App
├─ TopBar
│  ├─ Brand
│  ├─ TargetChips（芯片 / 分支 / 后端）
│  ├─ ThemeSwitch（light | system | dark）
│  └─ DockToggle
├─ Workspace
│  ├─ Rail
│  │  ├─ KnowledgePane（Search + Tree）
│  │  └─ SessionPane（List）
│  ├─ Conversation
│  │  ├─ ConversationHeader
│  │  ├─ PathLine（Step × 5）
│  │  ├─ MessageStream
│  │  │  ├─ UserTurn
│  │  │  ├─ AgentTurn
│  │  │  │  ├─ AskBlock（第 0 步分流）
│  │  │  │  ├─ ToolCard（readout | hitlist | evidence）
│  │  │  │  ├─ VerdictCard（rootCause / evidence / prediction / ownership）
│  │  │  │  └─ GuardNotice（R2）
│  │  └─ Composer
│  └─ Dock
│     ├─ DeviceMonitor
│     ├─ PortSettings
│     └─ DebugLog
└─ StatusBar
```

---

## 4. 布局与栅格

### 4.1 三栏尺寸

| 区域 | 宽度 | 行为 |
|---|---|---|
| 左栏 Rail | 264px 固定 | 窗口 < 1020px 隐藏 |
| 主区 Conversation | `minmax(0, 1fr)` | 自适应；内部内容左右各 20px 内边距 |
| 右栏 Dock | 404px（窗口 < 1180px 时 340px） | 可整体折叠；窗口 < 820px 隐藏 |

### 4.2 行高体系（硬性）

| 行 | 高度 | 说明 |
|---|---|---|
| 顶栏 TopBar | 48px | 与左栏品牌区共用 264px 栅格列 |
| 栏头 PaneHead / ConversationHeader | **40px** | 左、中、右三栏必须同高同基线，顶部线对齐于 48px |
| 诊断路径条 PathLine | 45px（24px 步高 + 上下 10px） | 与主区左右 20px 内边距对齐 |
| 状态栏 StatusBar | 26px | 贴底 |
| 列表行 TreeRow | 32px | 左栏统一行高 |
| 工具卡头 ToolHead | 34px | |
| 调试坞分区头 | 38px | |

### 4.3 间距与对齐规则

- 基准间距：4 / 6 / 8 / 10 / 12 / 16 / 20 / 24。
- 水平内边距：左栏与右栏 16px；主区 20px；工具卡与气泡内部 12–14px。
- 顶部对齐：三栏头部同为 40px，其下边框必须落在同一条水平线上（基准视口实测 y=48、h=40）。
- 右对齐：所有表头与数值列使用 `font-variant-numeric: tabular-nums`，数字右对齐。
- 主区内容宽度必须等于"主区宽 − 40px"，与会话头的左内边距一致；不允许出现内容比头部窄一截的孤立留白。
- 跨栏垂直分隔只用 1px 边框（`--border`），不使用阴影分隔栏。

### 4.4 滚动策略

- 顶栏、状态栏不滚动；三栏各自独立滚动。
- 左栏知识库区固定占左栏 58%（建议值），内部滚动；会话列表占据剩余空间并独立滚动。
- 主区只有消息流滚动，会话头、路径条、输入栏固定。
- 调试坞整坞滚动，各分区可独立折叠。
- 滚动条宽度 10–11px，轨道透明；见 §5.4。

---

## 5. 设计令牌

所有颜色必须经 CSS 变量引用，禁止在组件中硬编码十六进制值。

### 5.1 颜色

**夜间（默认基线）**

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg-canvas` | `#0e131a` | 主区画布 |
| `--bg-panel` | `#141b23` | 左栏、右栏、顶栏、状态栏、卡片 |
| `--bg-elevated` | `#1a232d` | 浮层、聚焦态输入 |
| `--bg-inset` | `#0a0f15` | 输入框、表格内凹、按钮底 |
| `--bg-hover` | `#1e2834` | 悬停 |
| `--bg-active` | `#26333f` | 选中、当前步、用户气泡 |
| `--bg-sunken` | `#111922` | 内嵌区块 |
| `--border` | `#232e3a` | 结构分隔 |
| `--border-soft` | `#1c2630` | 次级分隔 |
| `--border-strong` | `#35424f` | 强调边框、路径连接线 |
| `--text-1` | `#e4ecf2` | 主文本 |
| `--text-2` | `#9aa8b6` | 次文本 |
| `--text-3` | `#68757f` | 弱文本、元信息 |
| `--text-inverse` | `#08171a` | 主色底上的文字 |
| `--accent` | `#35d2c0` | 品牌主色、活跃状态、证据通过 |
| `--accent-strong` | `#2bb6a6` | 主色悬停 |
| `--accent-soft` | `rgba(53,210,192,.12)` | 主色浅底 |
| `--accent-line` | `rgba(53,210,192,.32)` | 主色描边 |
| `--warn` | `#e3a94e` | 告警、仿真边界、待确认 |
| `--warn-soft` | `rgba(227,169,78,.13)` | 告警浅底 |
| `--danger` | `#e86c5d` | 失败、写操作、违例 |
| `--danger-soft` | `rgba(232,108,93,.13)` | 危险浅底 |
| `--info` | `#7fb2e5` | 提问、提示、串口发送 |
| `--info-soft` | `rgba(127,178,229,.13)` | 信息浅底 |
| `--wave-1` | `#35d2c0` | 通道色 1 / KB 命中第一条 |
| `--wave-2` | `#e3a94e` | 通道色 2 / 第二候选 |
| `--wave-3` | `#d97bab` | 通道色 3 |
| `--wave-4` | `#7fb2e5` | 通道色 4 |

**日间**

| 变量 | 值 |
|---|---|
| `--bg-canvas` | `#eaeef1` |
| `--bg-panel` | `#ffffff` |
| `--bg-elevated` | `#ffffff` |
| `--bg-inset` | `#f4f7f9` |
| `--bg-hover` | `#eef3f6` |
| `--bg-active` | `#e2eaef` |
| `--bg-sunken` | `#f2f5f7` |
| `--border` | `#d8e0e6` |
| `--border-soft` | `#e6ecf0` |
| `--border-strong` | `#bcc8d2` |
| `--text-1` | `#15202b` |
| `--text-2` | `#4d5b69` |
| `--text-3` | `#7c8894` |
| `--text-inverse` | `#ffffff` |
| `--accent` | `#0f9d8d` |
| `--accent-strong` | `#0b8276` |
| `--accent-soft` | `rgba(15,157,141,.1)` |
| `--accent-line` | `rgba(15,157,141,.34)` |
| `--warn` | `#a9701a` |
| `--warn-soft` | `rgba(169,112,26,.12)` |
| `--danger` | `#c1443a` |
| `--danger-soft` | `rgba(193,68,58,.1)` |
| `--info` | `#2c6db0` |
| `--info-soft` | `rgba(44,109,176,.1)` |
| `--wave-1..4` | `#0f9d8d` / `#a9701a` / `#b04d80` / `#2c6db0` |

**语义映射（不得混用）**

| 语义 | 颜色 | 典型场景 |
|---|---|---|
| 正常 / 通过 / 活跃 | `--accent` | 探针已连接、证据验证通过、当前诊断步 |
| 警告 / 待确认 / 仿真边界 | `--warn` | HSE 未起振、写操作待确认、Renode 未建模 |
| 失败 / 危险 / 违例 | `--danger` | 读数与预期不符、错误帧、复位按钮 |
| 信息 / 提问 / 收数据 | `--info` | 第 0 步分流提问、串口接收 |

### 5.2 字体

```
--font-ui: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system,
           "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
--font-mono: "Cascadia Code", "JetBrains Mono", "SFMono-Regular", Consolas,
             "Liberation Mono", monospace;
```

- UI 与正文同一字族；数据、地址、寄存器、日志、路径、计数一律等宽。
- 字号阶：10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 15。
- 正文行高 1.5；气泡正文 1.65；数字使用 `tabular-nums`。
- 不使用全大写英文作为装饰性标签；栏头中文直接使用，英文 scope 保留原样（如 `vendor/`）。

### 5.3 形状与阴影

| 令牌 | 值 |
|---|---|
| `--radius` | 8px |
| `--radius-sm` | 6px |
| `--row` | 32px（列表行高） |
| `--gutter` | 16px（左右栏水平内边距） |
| 胶囊 / 徽标 | 999px |
| `--shadow`（夜间） | `0 12px 32px rgba(0,0,0,.38)` |
| `--shadow`（日间） | `0 10px 28px rgba(23,42,58,.14)` |

阴影只用于浮层与弹层，不用于普通卡片；卡片靠 1px 边框与底色分层。

### 5.4 滚动条

| 变量 | 夜间 | 日间 |
|---|---|---|
| `--scroll-thumb` | `#2f3d4b` | `#c6d0d9` |
| `--scroll-thumb-hover` | `#41546a` | `#a8b5c0` |
| `--scroll-track` | `transparent` | `transparent` |

实现要求：

```css
* { scrollbar-color: var(--scroll-thumb) var(--scroll-track); scrollbar-width: thin; }
::-webkit-scrollbar { width: 11px; height: 11px; }
::-webkit-scrollbar-track { background: var(--scroll-track); }
::-webkit-scrollbar-thumb {
  background: var(--scroll-thumb);
  border: 3px solid transparent;      /* 内缩，视觉宽度约 5px */
  background-clip: padding-box;
  border-radius: 999px;
}
::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); background-clip: padding-box; }
::-webkit-scrollbar-corner { background: transparent; }
```

标准属性与伪元素同时书写：支持 `scrollbar-color` 的浏览器走标准属性，旧浏览器走伪元素，二者不冲突。

### 5.5 图标

- 统一 24×24 viewBox、`stroke="currentColor"`、`stroke-width` 1.6–1.8、圆头圆角连接。
- 渲染尺寸：14 / 15 / 16px，由使用位置决定。
- 图标只表达动作或对象，不做装饰；同一动作在全站使用同一图标。
- 禁止 emoji、禁止图标字体、禁止内联位图。

---

## 6. 主题系统

### 6.1 三态

| 状态 | `data-theme` | 行为 |
|---|---|---|
| 日间 | `light` | 强制浅色令牌 |
| 夜间 | `dark` | 强制深色令牌 |
| 跟随系统 | `system` | 由 `prefers-color-scheme` 决定；系统切换时实时生效 |

### 6.2 实现规则

- 令牌定义在 `:root`（夜间基线）；日间令牌同时定义在 `[data-theme="light"]` 与 `@media (prefers-color-scheme: light) { [data-theme="system"] }`。
- 用户选择写入 `localStorage`（键名 `eam-theme`，值 `light | system | dark`），首屏读取后应用到 `documentElement`。
- 默认值为 `system`，不得默认写死浅色或深色。
- 切换控件为三段式图标按钮组（日 / 系统 / 夜），当前项 `aria-pressed="true"`，并带有 `aria-label` 与 `title`。
- 切换不得触发整页重载；切换后滚动位置与对话状态保持不变。
- 禁止在组件内直接写死后备颜色值；新增颜色必须先加令牌，并在两套主题中都给出取值。

### 6.3 对比度

- 正文（`--text-1` 于 `--bg-panel` / `--bg-canvas`）≥ 7:1。
- 次级文本（`--text-2`）≥ 4.5:1；弱文本（`--text-3`）仅用于元信息，不得承载关键结论。
- 状态不得只靠颜色区分，必须同时有文字、图标或形状（见 §10）。

---

## 7. 组件规格

> 下列"数据来源"指运行时数据的语义来源，示例值仅用于说明形态，不是接口契约。

### 7.1 TopBar 顶栏

- 高度 48px，三段栅格：`264px | 1fr | auto`。
- Brand：26×26 图标块 + 产品名 + 一行副标题；图标块使用 `--accent-soft` 底与 `--accent-line` 描边。
- TargetChips：三个可点击胶囊，分别为「芯片型号」「分支」「后端（OpenOCD · 真机 / Renode）」。后端为连接态时使用 `--accent` 系；未连接时降为 `--text-2`。
- ThemeSwitch：三段图标按钮，宽 30×24，选中项背景 `--bg-active`、图标 `--accent`。
- DockToggle：30×30 图标按钮，`aria-pressed` 反映调试坞展开状态。

### 7.2 KnowledgePane 知识库

- 位置：左栏顶部，占左栏 58%。
- 栏头：图标 + 「知识库」+ 文件计数胶囊 + 展开/收起。
- 检索框：高 30px，左侧放大镜图标，占位文案「kb_lookup · 寄存器名 / 错误码 / 症状」。
- 树：行高 32px；可展开项带右向 chevron（展开时旋转 90°）；子层缩进 14px + 1px 左导线；每行右侧可显示计数胶囊。
- 状态：默认展开「厂商分流」；当前厂商行使用 `--accent-soft` 底与 `--accent` 前景。
- 交互：整行可点；键盘 Enter/Space 展开或收起；树容器可滚动，栏头 sticky。

### 7.3 SessionPane 诊断会话

- 位置：左栏剩余空间，独立滚动。
- 栏头：图标 + 「诊断会话」+ 新建按钮。
- 分组：「进行中」「历史」，分组标题 10.5px、弱色、字距 `.06em`。
- 会话行：状态点 + 标题（单行省略）+ 编号/时间；高三段式。
- 状态点语义：运行中（`--accent` + 3px 光环）、需注意（`--warn`）、空闲（`--border-strong`）。
- 当前会话使用 `--bg-active` 底 + 1px `--border` 描边。

### 7.4 ConversationHeader 会话头

- 高 40px，左：会话标题（单行省略）+ 诊断状态胶囊；右：「回放」「导出 transcript」两个次级按钮。
- 状态胶囊：`诊断中`（accent）/ `已完成` / `已中断`，带 6px 状态点。

### 7.5 PathLine 诊断路径

五步固定序列：`报症状 → 分流提问 → 检索 KB → 探针取证 → 根因判决`。

| 状态 | 表现 |
|---|---|
| 已完成 | 序号圈 `--accent-soft` 底、`--accent` 字；文字 `--text-2` |
| 当前 | 胶囊底 `--bg-active`；序号圈 `--accent` 描边 + 3px 光环；文字 `--text-1` |
| 未开始 | 序号圈 `--border-strong`；文字 `--text-3` |

步间连接线 14×1px `--border-strong`。窄屏时整条横向滚动，不换行。

### 7.6 MessageStream 消息流

- 容器内边距 20px，条目间距 20px；用户条目靠右（最大宽 540px），agent 条目占满可用宽。
- 角色行：20×20 头像块 + 角色名（agent 为产品名，使用 `--accent` 系；用户为「你」）。
- 用户气泡：`--bg-active` 底 + `--border-strong` 边。
- agent 普通气泡：`--bg-panel` 底 + `--border` 边，圆角 8px，内边距 12×14。
- AskBlock（第 0 步分流）：左侧 2px `--info` 竖条 + `--info-soft` 浅底；顶部小标签「第 0 步分流 · 一次只问一个问题」；结尾 `note` 使用 11.5px 弱色说明信息增益理由。
- 行内代码（寄存器名、地址、值）：等宽 12px，`--bg-inset` 底 + `--border-soft` 边 + 4px 圆角。

### 7.7 ToolCard 工具调用卡

结构：卡头 + 卡体。卡头高 34px、`--bg-inset` 底、底部 1px 分隔；左侧工具图标 + 工具名（等宽）+ 参数摘要（等宽、单行省略）；右侧结果标记（成功勾 + 耗时）。

卡体按内容形态分三种：

1. **readout（读数）**：三列 `标签 | 值 | 说明`，标签 11px 弱色，值等宽 12px；长说明跨列。
2. **hitlist（KB 命中）**：每条命中左侧 3px 通道色条（`--wave-1` / `--wave-2` …），路径等宽，描述 11.5px，score 行 11px 弱色。
3. **evidence（证据表）**：行三列 `名称 + 地址码 | 读回值 | 判定标签`；判定标签为胶囊，`bad`（`--danger`）/ `warn`（`--warn`）/ `ok`（`--accent`），必须带图标或文字，不只靠颜色。

约束：

- 工具失败时卡头右侧显示 `--danger` 错误标记，卡体展示结构化错误码与文本；不得渲染空白读数。
- 只读工具卡不出现红色危险语义；写操作卡见 §7.10。
- 大输出（内存 dump、反汇编、长串口捕获）默认折叠为「摘要 + 行数/字节数 + 展开」，展开后由会话 artifact 提供全文。

### 7.8 VerdictCard 根因判决卡

- 外框：`--accent-line` 1px 边 + 8px 圆角；卡头 `--accent-soft` 底，含图标、「根因判决」、右侧置信度标签。
- 四个区块，以 1px `--border-soft` 分隔：根因、证据链、可证伪的修复建议、动作归属。
- 根因：一段结论文字，寄存器与值用行内代码。
- 证据链：复用 §7.7 的 evidence 表，逐条列出「读回值 → 判定」。
- 可证伪预测：虚线边框 + `--bg-inset` 底，必须包含"若预测不成立则如何推翻"的条件句。
- 动作归属：三列等宽卡片，分别是「agent 自己做」（accent）、「需要你回答」（info）、「建议你执行」（warn）；每列含图标、标题、一句说明。
- 置信度标签：`高` / `中` / `低`；低置信度不得省略不确定性说明。

### 7.9 GuardNotice 安全提示

- `--warn` 1px 边 + `--warn-soft` 底 + 6px 圆角，左侧 15px 警示图标。
- 文案必须写明：操作类型、目标地址、写入值、当前状态（待确认 / 已拒绝 / 已执行）。
- 未确认的写操作不得在界面上表现为已生效；确认入口必须独立于普通发送按钮。

### 7.10 Composer 输入栏

- 外框 1px `--border-strong`、10px 圆角；聚焦时 `--accent-line` 边 + 3px `--accent-soft` 光环。
- 文本域高度 22px 起，随内容增长至 120px 上限，不出现内部滚动条。
- 工具行：上下文按钮、工具集按钮（如「探针 + 串口 + KB」）、右侧快捷键提示、30×30 主色发送按钮。
- Enter 发送，Shift+Enter 换行；发送后清空并回到底部。
- 发送按钮在空输入时禁用（视觉降饱和），不得静默丢弃输入。

### 7.11 Dock 调试坞容器

- 宽 404px（<1180px 时 340px），左侧 1px `--border`。
- 栏头 40px：图标 + 「调试坞」+ 右侧「按需展开」计数胶囊。
- 分区头 38px，可折叠；chevron 收起时旋转 −90°；`aria-expanded` 同步。
- 顶栏 DockToggle 可整体隐藏/显示调试坞，隐藏后主区自动占满，不留空白列。

### 7.12 DeviceMonitor 设备监控

- 字段行：标签列 96px + 值列；字段：目标芯片、探针、CPU 状态、仿真后端。
- 连接状态用胶囊 + 状态点：已连接（accent）、未连接（中性）、仿真（中性）。
- 控制按钮：暂停（主色）、继续（中性）、复位（危险色）。复位按钮必须带危险语义，点击进入确认流程（R2）。
- 寄存器表：两列「寄存器 / 值」，等宽；异常值（如 `RCC_CFGR` 为 0）用 `--warn`，不得只靠颜色——同时保留原值文本。
- 数据来源：只消费 MCP 工具显式发布的 `device_status.payload.state`，按 `seq` 做字段 patch；缺失字段保留上一个值，未知键忽略。页面加载 / 缺口重拉时从完整历史重建；无 `device_status` 时才回退 `/api/device`。禁止从工具名、参数或文本推断，也禁止在加载阶段直接重新查询硬件。

### 7.13 PortSettings 端口设置

- 表单两列（标签 96px + 控件）：端口、波特率、数据帧。
- 端口与波特率为原生 `select`，数据帧为只读输入（如 `8 N 1 · 无流控`）。
- 按钮：打开端口（主色）、关闭（中性）。
- 统计三卡：接收 / 发送 / 错误帧，数值等宽 15px；错误帧非 0 时使用 `--danger` 语义并保留数字。
- 未打开端口时统计显示 `—` 而非 `0`，避免"0 错误"的误导。

### 7.14 DebugLog 调试日志

- 等宽 11.5px，每行三列：时间（56px）、类型标记（6×6 方块）、文本。
- 类型标记色：发送 `--wave-4`、接收 `--wave-1`、KB `--wave-2`、错误 `--danger`。
- 文本中的路径与工具名用 `--accent` 或高亮，数值加粗。
- 只追加不覆盖；自动滚动到底部，但用户上滚后暂停自动滚动。
- 日志与会话事件同源，回放时按 `seq` 顺序重建。
- MCP 状态区消费 `mcp_status`（含旧日志 `status` + `mcp_` 前缀）；状态缓冲保留最近 20 条，调试坞展示最近 5 条。展示 `kind`、server/tool、`toolCount` 与 `message`；`attempts`、`name/originalName`、`scope` 保留在 payload，当前未渲染。不进入对话正文。

### 7.15 StatusBar 状态栏

- 高 26px，左：探针状态、串口状态、告警；右：会话号、上下文占用、本会话费用、平台。
- 每项"状态点 + 文本"，状态点颜色遵循 §5.1 语义。
- 数值全部等宽并 `tabular-nums`。

---

## 8. 数据契约与状态投影

### 8.1 事件模型与两条通道

**持久化会话事件**（会话日志，回放与实时流的唯一事实源）：

```ts
type EventType =
  | "system" | "user" | "assistant" | "tool_call" | "tool_started"
  | "tool_result" | "usage" | "checkpoint" | "status" | "mcp_status"
  | "device_status" | "interrupted" | "compaction" | "permission_decision";

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

interface ToolStartedPayload {
  callId: string;
  tool: string;
  access?: ToolAccess;
}

interface McpStatusPayload {
  kind:
    | "connected" | "connect_failed" | "tools_changed" | "tools_refresh_failed"
    | "tool_invalid_schema" | "listener_failed" | "call_failed"
    | "config_failed" | "config_warning" | "project_config_skipped"
    | "tool_name_renamed";
  server?: string;
  tool?: string;
  toolCount?: number;
  message?: string;
  attempts?: number;
  name?: string;
  originalName?: string;
  scope?: "global";
}

interface DeviceStatusPayload {
  callId: string;
  server: string;
  tool: string;
  state: Record<string, unknown>;
}

interface AssistantPayload {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown> | { error: "invalid_json"; raw: string };
  }>;
}

interface ToolResultPayload {
  id: string;
  ok: boolean;
  text: string;
  artifactPath?: string;
  code?: string;
  detail?: unknown;
  evidence?: boolean;
  toolName?: string;
}
```

`tool_call` 仅用于旧日志回放，新代码不再产生；允许路径使用 `permission_decision → tool_started → tool_result`，拒绝/校验失败路径为 `permission_decision → tool_result`（不写 `tool_started`）。旧日志中的 MCP `status` 事件继续按 `mcp_` 前缀识别，新代码只写 `mcp_status`。

**运行时循环事件**（库 API 与 demo 使用；Web 工作台实时渲染改由 §8.6 的 SSE 事件流驱动）：

```ts
type LoopEvent =
  | { kind: "model_message"; content: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; ok: boolean; text: string }
  | { kind: "turn_end"; turn: number; costUsd?: number }
  | { kind: "compacted" }
  | { kind: "interrupted"; reason: string }
  | { kind: "done"; finishReason: "no_tool_calls" | "max_turns" | "max_cost_usd" | "aborted" };
```

### 8.2 投影规则

前端只维护一个视图模型 `TranscriptView`，由事件序列归约得到；UI 不持有"无法从事件还原"的状态。

| 事件 | UI 产物 |
|---|---|
| `user` | 用户气泡 |
| `assistant`（content 非空） | agent 气泡 |
| `assistant`（toolCalls） | 工具卡骨架（待执行） |
| `tool_started` | 对应工具卡进入「执行中」；`access` 仅用于展示授权口径，不推断设备状态 |
| `tool_result` | 工具卡结果区（读数 / 命中 / 证据 / 错误） |
| `permission_decision` | 会话内的权限条目：工具、动作、`effective`、理由；`action=ask,effective=deny` 显示「拒绝 / 未执行」 |
| `mcp_status` | 调试坞 MCP 状态区，不进入对话正文 |
| `device_status` | 设备面板 patch（§8.6），不进入对话正文 |
| `usage` | 状态栏与费用统计 |
| `status` | 诊断状态胶囊、状态栏；`device_status_invalid` 保留为显式状态事件（当前未单独渲染告警） |
| `interrupted` | 中断提示（`--danger`），保留已产生的证据 |
| `checkpoint` | 回放锚点，不直接渲染 |
| `compaction` | 当前仅保留在事件数组，不进入 UI 投影（后续再补提示） |

工具卡的结果渲染优先级：`detail`（结构化）> `text`（纯文本）> 错误占位。`ok=false` 时必须渲染 `code` 与错误文本。证据只来自 `tool_result.payload` 的 `evidence/artifactPath/detail`，不单列事件。

### 8.3 工具语义标记

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
| `evidence: true` | 结果进入"证据链"视觉（读数/判定标签） |
| `destructive: true` | 卡头与操作按钮使用 `--danger`，触发确认流程 |

### 8.4 回放

- 页面加载时先读取会话日志，按 `seq` 归约出 `TranscriptView` 并渲染；**不得**在加载阶段调用探针重新查询设备。
- 回放与实时渲染必须复用同一个归约函数，避免两套渲染路径产生差异。
- 回放完成的会话，输入栏进入只读或"派生新会话"模式（会话 fork）。

### 8.5 已决：扩展 LoopEvent 透传结构化结果

- 现状：`toResultPayload()` 已把完整 `ToolResultPayload`（含 `code` / `detail` / `artifactPath`）写入会话日志，但 `LoopEvent.tool_result` 只 yield `{ id, ok, text }`，实时渲染缺少证据表与错误码所需字段。
- 决策（2026-10-18）：**扩展 `LoopEvent.tool_result`**，使其与 `ToolResultPayload` 字段对齐，而不是让 UI 维护第二套投影。
- 实施要求：`session.append` 与 yield 必须由同一份字段构造（避免两处漂移）；扩展后实时渲染与回放渲染共用 §8.2 的同一个归约函数，V13 才可验证。

### 8.6 实时事件流与合并

**通道与游标**

- 实时通道为 SSE：`GET /api/events?sessionId=<id>&since=<seq>`；`since` 缺省读 `Last-Event-ID`，都缺省按 `-1` 从头补播。普通帧 `id: <seq>` + `data: <SessionEventEnvelope JSON>`，心跳 `: ping`。
- 一条连接只绑定一个会话；切换会话必须先 `close()` 旧流，再以新会话历史末 `seq` 建流。游标由事件流客户端独占，`state` 只接收已接受的事件。
- 首屏：先 `GET /api/sessions/:id` 取历史事件与 `lastSeq`，再以 `since=lastSeq` 打开 SSE；加载期间不因实时流提前改写历史数组。

**统一事件数组**

- `WorkbenchState.events: SessionEvent[]` 是唯一视图输入：历史与实时都追加到同一数组，统一交给 `transcriptFromSession` 投影；不保留 `liveView` / `replayView` 两套状态。
- 接受事件前校验 `event.sessionId === activeSessionId`；`seq <= lastSeq` 直接丢弃（去重）；接受成功后 `lastSeq = event.seq`。游标只在投影成功后推进。
- `tool_started` 与 `tool_result` 共用工具卡：前者进入 `running`，后者落在 `done/failed`；`permission_decision` 渲染为权限条目；`mcp_status` 只进调试坞；`device_status` 只更新设备面板。

**缺口与重连**

- `seq > lastSeq + 1`：关闭流，触发整量重拉（重新请求历史并重建视图），每次订阅最多 3 次（`start` 时重置）；超过后显示「实时事件流缺口过多，请重试」，不允许在缺口上继续拼接。
- 连接断开 / `stream_error`：保留 `lastSeq` 并重连；连续 3 次未成功建流后报错（成功 `open` 后计数重置），客户端自行重连，间隔默认 1s，可注入测试值。`stream_end` 表示会话已关闭且补播完成，停止重连。
- 重拉单飞按 `sessionId` 隔离；切换会话时旧流的回调一律通过 generation 令牌失效，避免旧会话事件写入新视图。

**设备面板：patch 与重载重建**

- `deviceFromSession(events)` 按 `seq` 顺序折叠 `device_status.payload.state`；每次 `state` 是部分更新：已知字段为字符串时覆盖，缺失字段保留，未知键与非字符串值忽略。设备字段固定为 `probe/serial/cpu/backend`。
- 切换会话 / 新建会话从四个 `unknown` 开始，不继承上一会话；页面重载或缺口重拉时，先用完整历史重建，再接入 SSE。
- `/api/device` 仅作为「没有 `device_status` 事件」时的兼容回退；已有事件投影不得被恒为 `unknown` 的接口结果覆盖。设备状态不从工具名、参数或文本推断（R3）。

**权限与 MCP 状态的展示位置**

- `permission_decision` 进入消息流/守卫区，展示工具、动作、`effective` 与理由；`action=ask,effective=deny` 必须显示「拒绝 / 未执行」，不能伪装成成功或静默跳过。
- `mcp_status` 进入调试坞状态区（状态缓冲最近 20 条，展示最近 5 条），展示 `kind`、server/tool、`toolCount` 与 `message`；`attempts`、`name/originalName`、`scope` 保留在 payload，当前未渲染。不重复合成旧 `status` 条目。
- 本轮不提供 Web 审批按钮或审批 API；`approval_request` 仅为阶段 2 保留类型，实时流只透传已落日志的 `permission_decision`。

---

## 9. 交互规范

| 操作 | 行为 |
|---|---|
| 主题切换 | 即时生效，写入本地存储，不重载 |
| 调试坞开关 | 隐藏/显示右栏，主区宽度自适应 |
| 分区/树节点折叠 | 点击整行；`aria-expanded` 同步；chevron 旋转 160ms |
| 发送消息 | Enter 发送，Shift+Enter 换行；空输入禁用发送 |
| 回放 | 从会话日志重建；显示"回放中"状态，禁止并发查询硬件 |
| 实时事件 | 只订阅当前会话；按 `seq` 去重后追加到统一事件数组；`tool_started` 立即进入执行中 |
| 断线续传 | 以 `lastSeq` 重连，最多 3 次；`stream_end` 停止，缺口触发整量重拉 |
| 权限拒绝 | `action=ask,effective=deny` 显示「拒绝 / 未执行」；本轮无 Web 审批按钮 |
| 复位 / 写内存 | 二次确认，展示目标地址与值；确认后按钮进入执行中态 |
| 长输出展开 | 折叠态显示摘要与规模；展开不改变消息流顺序 |
| 滚动 | 日志与消息流在用户上滚后暂停自动跟随 |

动效：

- 仅使用 160ms 的展开/折叠与 chevron 旋转；
- 尊重 `prefers-reduced-motion: reduce`，关闭过渡与平滑滚动；
- 不使用入场动画、悬浮位移、渐变装饰。

---

## 10. 可访问性

- 所有可交互元素可 Tab 到达，焦点可见（2px `--accent` 描边，偏移 1px）。
- 图标按钮必须有 `aria-label`；仅图标不承载唯一语义。
- 折叠控件使用 `aria-expanded`；主题按钮使用 `aria-pressed`；调试坞开关使用 `aria-pressed`。
- 状态不得只靠颜色：同时提供文字标签、图标或形状。
- 正文对比度 ≥ 7:1，次级文本 ≥ 4.5:1。
- 输入框有可见标签或 `aria-label`；表单控件使用原生元素。
- 支持系统减少动效偏好。
- 字号最小 10.5px 且仅用于元信息；关键结论不小于 12.5px。

---

## 11. 响应式

| 断点 | 变化 |
|---|---|
| ≥ 1180px | 左 264 / 主区自适应 / 右 404 |
| 1020–1180px | 右栏收窄至 340 |
| 820–1020px | 隐藏左栏；顶栏品牌区改为自适应首列 |
| < 820px | 隐藏调试坞；仅保留主区；顶栏目标胶囊可横向滚动 |

降级原则：优先保证"诊断对话 + 证据"可读，其次才是知识库与调试坞；隐藏的栏位不丢失状态，恢复宽度后原状还原。

---

## 12. 视觉验收清单

基准视口 1600×1000（Chromium 无头实测口径）。实现后须逐项通过：

| # | 检查项 | 通过标准 |
|---|---|---|
| V1 | 三栏头部对齐 | 左/中/右栏头 `y=48`、`height=40`，三者一致 |
| V2 | 栏宽 | 左 264、右 404；主区 = 视口 − 668（264 + 404） |
| V3 | 内容对齐 | 主区内容可用宽 = 主区宽 − 40 − 滚动条占位（V8），与会话头内边距同边界 |
| V4 | 无横向溢出 | `document.scrollWidth === window.innerWidth` |
| V5 | 无文本截断 | 关键文本元素 `scrollWidth ≤ clientWidth + 1` |
| V6 | 知识库树完整 | 在 717px 高工作区下，默认展开的厂商分流子树完整可见（树内容 334px，整树超出时知识库区内部滚动） |
| V7 | 滚动条配色 | 夜间 thumb `rgb(47,61,75)`、日间 `rgb(198,208,217)`，track 透明，宽度 `thin` |
| V8 | 滚动条占位 | 出现滚动条时实占 10px，不产生横向溢出 |
| V9 | 三主题解析 | `light` / `dark` / `system` 的 canvas 与 accent 计算值符合 §5.1 |
| V10 | 无 emoji | 页面文本与图标中不存在 emoji 字符 |
| V11 | 焦点可见 | Tab 遍历所有页面内控件（含原生 input/select/textarea），均有可见焦点环 |
| V12 | 减少动效 | 开启 reduce 后无过渡与平滑滚动 |
| V13 | 回放一致性 | 同一会话实时渲染与回放渲染的组件序列一致 |
| V14 | 写操作确认 | 复位/写内存未确认时，界面不显示"已执行" |

---

## 13. 决策结论

| ID | 结论 | 日期 | 依据 |
|---|---|---|---|
| OPEN-UI-01 | **Preact + Vite** | 2026-10-18 | 轻量组件化，保留纯函数投影；不引入与 Node 24 / ESM 冲突的构建链 |
| OPEN-UI-02 | **扩展 `LoopEvent.tool_result`**，透传 `code` / `detail` / `artifactPath` | 2026-10-18 | 实时与回放共用同一归约函数（V13）；改动仅类型与两处 yield |
| OPEN-UI-03 | **SSE + HTTP POST** | 2026-10-18 | 事件单向、低频；自动重连、可 curl 调试；保留 `EventSource` 抽象 |
| OPEN-UI-04 | **不做**实时波形与仪器联锁 | 2026-10-18 | R1 禁止 LLM 直接控制仪器；信号物理层诊断属人工执行域 |
| OPEN-UI-05 | **暂不做**虚拟滚动；触发条件：单会话 DOM 节点 > 5000 或渲染帧 > 50ms | 2026-10-18 | 消息流 append-only；避免破坏查找、折叠与可访问性 |
| OPEN-UI-06 | M3 只做**派生入口 + 来源标记**（`#129 ← #128`），树形导航后置 | 2026-10-18 | `SessionEvent.parent` 已具备，无需提前设计树形 UI |

> 后续新增前端决策沿用 `OPEN-UI-xx` 编号；已关闭项保留在本表，不删除。

---

## 14. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-10-18 | 首版：从 `prototypes/index.html` 提取令牌、栅格、组件与验收口径；对齐 `SessionEvent` / `LoopEvent` / `ToolResultPayload` / `ToolAnnotations` 实际类型；登记 6 项前端待决策 |
| v1.1 | 2026-10-18 | 关闭 6 项决策：前端定为 Preact + Vite；实时通道定为 SSE + HTTP POST；决定扩展 `LoopEvent.tool_result`；波形与仪器联锁列为不做；虚拟滚动设触发条件；fork 仅做派生入口 |
| v1.2 | 2026-10-18 | Task 10 视觉验收落地：V2 主区公式由笔误 `−664` 修正为 `−668`（264 + 404）；V3 明确滚动条占位从内容宽中扣除；V6 明确验收对象为厂商分流子树、整树超出走知识库区内部滚动；V11 明确覆盖原生表单控件；`applyTheme` 保留 `data-theme="system"` 交由 CSS 媒体查询解析 |
| v1.3 | 2026-10-20 | 事件总线：事件模型补 `tool_started` / `mcp_status` / `device_status` / `permission_decision` 与对应 payload；明确统一事件数组、游标去重、缺口整量重拉、断线上限；设备面板按 `device_status` patch 并在重载时从历史重建；权限条目进消息流、MCP 状态进调试坞；本轮不含 Web 审批 |