# 底层框架架构内容清单(调研阶段)

> 更新: 2026-10-15(v1.1)。状态: **调研输入,只列内容不做设计**——每条只回答"框架需要什么",不回答"怎么做"。
> 背景: 方向变更(2026-10-15)——不再基于 dsh 二次开发,改为**独立开发底层 agent 框架(harness 层)**;嵌入式调试能力(取证工具 / 知识库 / 诊断 UI / 验证管线)按 BRD 全新建设,以 MCP / 插件形式接入。**v1.1 修订: dsh 阶段实现资产不作为复用输入**——下文"现有资产映射"改为"Phase 0 经验映射",仅作需求锚点。
> 参考对象: dsh(与本项目结构最接近:双模式 + 插件树 + preset)、Claude Code(组件最全:compaction / skills / hooks / subagents / 权限 / 沙箱),调研阶段继续补充其他开源 harness。
> **2026-10-15 补充**: 七工具横向调研已完成(Claude Code / dsh / Codex / Gemini CLI / opencode / goose / pi,含本清单 24 项逐维度矩阵与 10 决策点逐条启示),见 [harness-comparison.md](harness-comparison.md)。

---

## 0. 定位与横切约束

- **框架定位**: 领域无关的 agent harness——负责模型接入、上下文、工具、会话、扩展机制;所有嵌入式调试能力通过 MCP / 插件 / Skills 挂载,框架本体不含领域逻辑。
- **横切安全约束**(不可妥协,来自项目安全边界,直接影响 #7):
  - LLM 永不直接控制仪器(只提议操作步骤,人工执行);
  - 探针写内存 / 复位前先声明。
  - 推论: 权限门禁需要**工具类 / 参数级**粒度,不能只有全有全无。

## 1. Phase 0 经验 → 框架能力映射

| Phase 0 验证过的能力需求(曾在 dsh 上实现) | 对框架的要求 | 对应条目 |
|---|---|---|
| 取证工具经 MCP 接入(探针/串口/KB 检索) | MCP 客户端 | #5 |
| 会话日志回放(设备面板重载可复现) | transcript 持久化 + 回放协议 | #6, #18 |
| persona 注入(系统提示词插件) | 系统提示词组装 | #8 |
| preset(子插件树)+ patch 挂载 | 插件系统 + 配置 | #10, #11 |
| headless 无审批策略(approval: never 卡死教训) | 权限策略预设 | #7 |
| KB 三级渐进加载 | Skills 式渐进加载 | #9 |
| 设备面板实时状态(observer 监听工具结果) | 事件总线 + client 插件 | #13, #15 |
| headless 盲测管线(夜批) | headless 模式 + exit code 约定 | #16 |
| 夜批无人值守 | 观测与超时控制 | #18 |

## 2. 架构内容清单(按优先级)

优先级含义:

- **P0 内核** — 缺一则无法完成一次"对话 + 工具调用"的最小闭环;
- **P1 扩展与安全** — preset / persona / KB / 安全边界依赖,决定框架能否承载领域资产;
- **P2 交互与自动化** — 日常使用体验与夜批验证管线;
- **P3 远期/冻结** — 方向重启时再启用。

### P0 内核(6 项)

| # | 内容 | 职责一句话 | 参考 / 需求锚点 |
|---|---|---|---|
| 1 | Agent 主循环 | LLM↔工具迭代循环、tool-call 解析与分发、多轮续跑、用户中断与取消传播 | Claude Code 主循环;dsh 会话循环 |
| 2 | 模型接入层 | 多 provider 统一适配(OpenAI 兼容 / Anthropic / 本地网关)、流式、重试与超时、用量统计、模型降级 | deepseek-v4.1-flash 走本地网关,未来可能多模型并存 |
| 3 | 上下文管理 | 消息历史结构、窗口预算、历史压缩(compaction)、token 计数、prompt cache 友好的稳定前缀 | Claude Code auto/micro-compaction;长诊断会话的成本控制 |
| 4 | 工具系统 | 工具注册与 JSON Schema、执行器(超时 / 取消 / 大输出截断)、并行调用、错误结构化回传;内置最小工具集(fs / shell / glob / grep) | "工具必须诚实"(设计结论 6)→ 错误要结构化回传,不许静默吞错 |
| 5 | MCP 客户端 | stdio / HTTP transport、server 进程生命周期、工具发现与命名空间(mcp__server__tool)、资源与提示 | 领域取证/KB 工具按 MCP 接入的硬依赖(BRD BR-2/BR-3) |
| 6 | 会话管理与隔离 | 会话生命周期、transcript 持久化(JSONL)、恢复 / 继续 / 派生、**会话间上下文与 MCP 连接隔离** | 用户点名"会话记忆隔离";诊断 UI 会话日志回放依赖持久化(BRD BR-6) |

### P1 扩展与安全(7 项)

| # | 内容 | 职责一句话 | 参考 / 需求锚点 |
|---|---|---|---|
| 7 | 权限与审批 | 工具级 / 参数级 allow-ask-deny、交互审批通道、策略预设(workspace-write / danger-full-access)、headless 无审批时的策略 | headless approval: never 踩坑;安全边界要求 mem_write / 复位类细粒度门禁 |
| 8 | 系统提示词组装 | 分节组装(基础 / persona / 环境信息 / 工具说明)、personaPrefix 注入、指令冲突消解 | headless 下另挂 persona 插件与 base 段冲突失效的教训 |
| 9 | Skills 与渐进加载 | SKILL.md 式技能包(frontmatter 索引 → 按需读正文 → reference)、技能发现与触发 | KB 三级渐进加载与 Anthropic Agent Skills 同构(设计结论 3);决策点:KB 走 Skills 还是保留检索工具 |
| 10 | 插件系统 | 插件挂载树(host / client / prompt / MCP)、生命周期、依赖与冲突检测 | dsh 的 preset=子插件树;web 与 headless 挂载方式相反的踩坑 |
| 11 | 配置与 preset | 分层配置(默认 / 用户 / 项目 / CLI 参数)、preset 组合、patch / override 机制 | embedded-preset.patch.yml |
| 12 | 记忆系统 | 项目级持久记忆(CLAUDE.md 式)、会话记忆隔离边界、跨会话显式沉淀通道 | 用户点名"会话记忆隔离";知识沉淀 inbox 模式(沉淀→人工审核,BRD BR-5) |
| 13 | 钩子与事件总线 | 工具调用前后拦截、事件发布订阅(工具结果 → 外部观察者) | 诊断 UI 监听取证工具结果发布设备状态(BRD BR-6) |

### P2 交互与自动化(6 项)

| # | 内容 | 职责一句话 | 参考 / 需求锚点 |
|---|---|---|---|
| 14 | CLI/TUI 交互层 | REPL、流式 Markdown 渲染、slash 命令、@引用 / 附件、计划等交互模式 | Claude Code REPL;诊断"先出方案再执行"可复用计划模式 |
| 15 | Web UI 与状态通道 | web server、会话列表、client 插件机制、状态发布通道 | 诊断设备管理面板(BRD BR-6,新建) |
| 16 | Headless 模式 | 一次性任务执行、exit code 约定、无人值守权限策略、单轮超时控制 | 夜批盲测管线硬依赖(BRD BR-7;Phase 0 基准上需自补整跑超时与完整 exit code 表) |
| 17 | 子代理 | 后台任务、上下文隔离的分派、完成通知 | Claude Code Task;可用于并行调研 / 批量夹具验证 |
| 18 | 观测与调试 | 工具调用 trace、token / 费用统计、debug 日志、回放协议 | 夜批无人值守排障;与 #6 持久化联动实现会话回放 |
| 19 | 任务外化(todo) | agent 计划外化为可见待办,用户可跟踪进度 | Claude Code TodoWrite(可选) |

### P3 远期/冻结(5 项)

| # | 内容 | 职责一句话 | 参考 / 需求锚点 |
|---|---|---|---|
| 20 | 仪器联锁 UI | LLM 提议 / 人工执行的仪表设置面板 | 冻结存档(instrument-research.md),方向重启时启用 |
| 21 | 评估 / 回归集成 | 回归测试、盲测夹具管理、夜批调度与框架本体集成 | 夜批为外部脚本先行,框架化后可内置 |
| 22 | OS 级沙箱 | 进程 / 文件系统 / 网络隔离 | Claude Code sandbox;权限模型(#7)先行可覆盖多数场景 |
| 23 | 多模态 | 截图 / 波形图 / 图片输入 | Saleae 导出、界面截图诊断 |
| 24 | 远程与多端 | A2A / 云端会话 / 远程控制 | 远期 |

## 3. 待调研决策点(进入设计前必须回答)

1. **语言栈与复用边界**: ~~TS(贴近 CLI / UI 同构生态,七工具调研 5/7 为 TS)vs Python(贴近取证工具与科学计算);MCP SDK 等协议库可复用,harness 本体自研的边界画在哪。~~ **已关闭(2026-10-16)**: TypeScript + **Node 24**(ESM-only,本机 24.14.1 已具备);复用边界 = 协议层复用(MCP 官方 TS SDK v2 / Zod v4),内核(主循环/会话/工具/上下文/MCP 生命周期)自研,模型适配层自研极简适配器(仅 complete/countTokens,语法借鉴 dsh llm-pi-ai,不整体引第三方),测试用 vitest。依据: 七工具调研 5/7 TS + Context7 查证 MCP SDK v2 官方支持 Node 20+(开发环境要求 Node 24.x + npm 11.x,与本机相符)。详见 [p0-kernel-design.md §0](p0-kernel-design.md)。
2. **KB 渐进加载的载体**: Skills 机制 vs 独立检索工具 vs 两者并存——决定知识层接口形态。
3. **内置工具集最小范围**: fs / shell / edit / glob / grep 哪些进内核,哪些挂插件。
4. **会话存储与回放协议**: transcript 格式,UI 如何从日志重建工具结果状态(设备面板依赖)。
5. **权限粒度**: 工具级 vs 参数级(如 mem_write 地址范围、serial_write 目标白名单)。
6. **上下文压缩策略**: 触发阈值、摘要 vs 截断、诊断证据链是否列入压缩保护(证据链不能丢)。
7. **多模型并存**: 本地网关 + 云 API 的路由与降级策略。
8. **MCP 连接生命周期**: 会话级 vs 全局级,健康检查与自动重启。
9. **UI 形态优先级**: CLI 先行还是 Web 先行(诊断设备面板为 Web 侧需求,BRD BR-6)。
10. **跨平台基线**: Windows 一等公民——历史踩坑全部来自 Windows(POSIX 路径、Kaspersky 误杀、pyOCD USB 死锁),框架的进程 / 路径 / 编码处理必须以此为基线。
