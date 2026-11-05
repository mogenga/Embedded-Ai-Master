# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

> 选 `web` 而不是 `adaptive`：渲染层是 Electron 里的 HTML/CSS（无原生控件），设计语言由自己的令牌体系决定，不随 OS 变形——「原生外壳包着网页」不构成原生设计语言（`init.md` 的原话）。`adaptive` 会错误地启用 iOS/Android 原生准则。
>
> **但目标 OS 只有 Windows**：`desktop/package.json` 只声明 `win` target（NSIS x64，未签名），README 下载区也只有 Windows x64。产品判断是「Windows 为准」，macOS / Linux 不在本轮计划内。设计可以依赖 Windows 的窗口习惯、字体栈与快捷键约定，不必为其它平台留兼容分支。将来真做 macOS 时改这一行，并重看窗口铬、快捷键与字体栈。

## Users

主要用户是**嵌入式开发者**（BRD 角色 U1）：手上一块板子，看到的是「串口乱码」「上电无输出」「间歇死机」这类症状，要的是根因而不是百科。单次使用是长时段、可长时间注视的桌面会话；他们会同时开 IDE、串口监视器、示波器截图，并在这些之间来回切换。

另外两个角色目前由同一个人承担，但按角色分离记录了需求：

- **U2 知识库维护者**：审核 agent 沉淀、维护 KB 质量、跑回归。
- **U3 无人值守管线**：CI 式批量盲测，要求幂等、超时受控、退出码可判。

## Product Purpose

用「探针取证 + 知识库推理」代替「翻手册 → 猜原因 → 反复试」的排查循环：用户报症状，agent 用探针工具取证、用本地故障库推理，给出**根因 + 证据链 + 可证伪的修复建议**。

成功标准（BRD §4）：诊断闭环给出可证伪预测；安全边界零违例；知识库四段式达标 100% 且回归全绿。

## Positioning

两层结构，这是别人抄不走的机制：

| 层 | 内容 |
|---|---|
| 平台层（harness） | 自研 agent 内核：主循环、模型接入、上下文、工具、会话、权限、MCP |
| 领域层 | 嵌入式能力经 MCP 挂载：探针、串口、Keil 工具链、故障库、数据手册 |

与相邻产品的差别：不是又一个聊天壳子，也不是又一个 MCP 工具集——它把**领域能力做成可替换的 MCP 层**，同时把**内核做成领域无关的平台**。内核里没有一行嵌入式逻辑，这是硬约束，也是这条定位能被验证的原因。

## Operating Context

- **桌面形态是主界面**：Electron 窗口 + 宿主进程（NDJSON over stdio）。同一内核另有 headless CLI 供 U3 夜批使用。
- **验收方式是看渲染结果，不是读代码**：主界面与设置页零导出、不在类型检查范围内，`npm run check:js` 只查语法。**所有界面改动必须手动在真实 Electron 里验收**，且明确要求「深色 / 浅色 / 高对比」三套主题与 1440 / 1100 两档宽度都过一遍。
- **界面依赖真实内核数据**：没有数据源的能力一律隐藏入口，不画假按钮。设计稿上的状态必须能在 `desktop/MATRIX.md` 里找到对应的命令/事件。
- **开发者的实际工作环境**：Windows 11 + git-bash；杀软（Kaspersky）会静默删除 ELF 并可能拦截 PowerShell 链路；探针 USB 枚举有已知死锁（必须用 OpenOCD 而非 pyOCD）。界面上的错误提示因此必须说清楚「是什么失败了」，不能只说「出错了」。

## Capabilities and Constraints

**已确认的技术约束（不可变更）**

- 渲染层：纯 ES 模块，**无框架、无打包器、无构建步骤**，Electron 直接加载 `index.html`。JavaScript，不是 TypeScript。
- 图标：内联 SVG sprite（`icons.js`），单一 24×24 网格，`stroke-width: 1.75`。**零 emoji**。
- 样式：手写 CSS 变量体系，无预处理器。**颜色只能通过语义 token**；圆角只有三档（`--radius-sm` 6 / `--radius` 10 / `--radius-lg` 20）。
- CSP：`script-src 'self'`，无 `unsafe-inline` 脚本、无 `unsafe-eval`。
- 内核：TypeScript + Node 24，ESM-only；MCP 官方 SDK v2；Zod v4；Vitest 4。禁止引入现成 harness。
- 模型适配层：只有 `openai-chat-completions` 一种协议。Anthropic Messages 未实现（T-02）。

**产品能力（已实现）**

会话管理、转录与流式、工具行、审批条、`@` 文件补全、`/` 命令补全、计划条、串口助手面板、知识库、工具链包管理、语料 OTA、七家厂商的模型服务配置（每张卡可测试连接）、应用内更新、托盘。

**明确不做**

- 界面内直接控制仪器（R1 硬规则）。
- 实时波形与时序图。
- 多窗口写同一会话。
- 移动端。
- 向量 RAG（实验结论：agentic 检索显著更优）。

## Brand Commitments

- **名称**：Embedded AI Master（仓库 `Embedded-Ai-Master`）。内部代号「Prometheus」出现在 localStorage 键前缀里（`prometheus.providerMeta` 等）——这是历史包袱，不是对外品牌，界面文案里不出现。
- **许可证**：MIT，Copyright (c) 2026 mogenga。
- **声音**：中文为准。直白、具体、不用营销词。错误提示说清「哪个环节失败、下一步能做什么」；能力不存在就藏掉入口而不是画灰。README 的写法就是产品的语气范本（「它不做的事」「诚实边界」）。
- **禁用**：emoji、装饰性图形、大面积高饱和色、伪造状态。

## Evidence on Hand

- **真实数据**：本地故障库 108 篇嵌入式调试语料 / 90 条索引（不入库，CI 跑不了这两条回归）。
- **真实测量**：RAG 对照实验四方案 80 条查询的完整 csv / 图 / 报告，位于 `experiments/rag-vs-agentic-search/`。README 里的两组图表由脚本从 `results/scored/main/overall.csv` 生成，不手录。
- **真实硬件结论**：Keil 协议偏移、状态码、整片擦除结论来自真机实测；Renode 探针端到端已跑通（仅仿真内存）。
- **发布物**：v0.1.5 Windows x64 NSIS 安装包，已在干净机器验证安装。**未签名**，SmartScreen 会拦。
- **不存在的东西**：没有客户案例、没有用户证言、没有自身性能基准（横向调研在 `docs/harness-comparison.md`，那是竞品分析不是自身基准）。**不得编造**。

## Product Principles

1. **诚实优先于完整**：内核没有的能力隐藏入口，不画假按钮；失败显式报错，不把全 0 读数当「无故障」（R3）。
2. **确定性事实进工具，因果推理进知识文件 + LLM**（R4）。界面同理：能用数据算出来的，不靠模型描述。
3. **一次修完，不挤牙膏**（R8）：发现质量缺口先全量审计，按清单一次修完。
4. **证据可核对**：工具调用不是黑盒，而是可以摊开读的读数；诊断结论必须能被用户推翻。
5. **克制、可长时间注视**：以仪器面板的语言为主，不用装饰性图形搏眼球。

## Accessibility & Inclusion

- 所有可交互元素可 Tab 到达，`:focus-visible` 有可见焦点环。
- 状态不得只靠颜色：同时提供文字标签、图标或形状（色盲用户与高对比主题都依赖这一条）。
- 支持系统减少动效偏好。
- 最小字号 12px 且仅用于元信息。
- **已知缺口**：多数图标按钮用 `title` 而非 `aria-label` 承载可访问名，部分屏幕阅读器与触屏上不朗读（`docs/frontend-design.md` §10）。
