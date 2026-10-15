# Agent Harness 横向调研报告:Claude Code / dsh / Codex / Gemini CLI / opencode / goose / pi

> 日期: 2026-10-15。状态: **调研完成,支撑架构选型**。
> 关联: [framework-architecture-inventory.md](framework-architecture-inventory.md)(架构清单 24 项 + 10 决策点,本文逐项映射)、[BRD.md](BRD.md)(BR/PLAT 需求编号沿用)。
> 调研对象由用户指定:Claude Code(解析文章 diwang.info/how-claude-code-works)、dsh(github.com/deepseek-ai/deepseek-harness)、Codex 等,其余为补充。

---

## 0. 调研方法与可信度

- 五路并行调研,一手来源优先(官方仓库源码 / 官方文档),二手解析均标注。
- **Claude Code 闭源**:用户指定解析文章为 Docsify SPA,已溯源到原版(Windy3f3f3f3f/how-claude-code-works,GitHub Pages)并全文解析。注意:该文是**基于泄露的 v1.0.33 源码快照的社区逆向**,结论已与官方文档(code.claude.com/docs)交叉核对,标注二手。
- **dsh**:开源仓库源码 + 文档站直读;并带回一份特殊成果——**我们在 dsh 上二次开发时的 9 条现场经验逐条核实,全部证实且机制更精确**(见 §1.2),原踩坑记录从"现象描述"升级为"机制解释"。
- 其余(Codex / Gemini CLI / opencode / goose / pi)全部以仓库与官方文档为一手来源,无二手依赖。
- 时效:Codex 0.162.1(2026-10-09,alpha 日更)、Gemini CLI v0.64.0、opencode v2(2026-Q4)、dsh 0.2.1-alpha.3(developer preview)、goose v1.10+、pi 已迁移 earendil-works/pi。**本领域版本漂移极快,引用前先核对。**

---

## 1. 七工具架构画像

### 1.1 Claude Code(Anthropic)—— 闭源标杆,权限/上下文工程最强

TypeScript + Bun,React+Ink 自研终端渲染,Zod/tree-sitter/ripgrep 内置;核心为 QueryEngine 驱动 `query()` async generator 主循环(~1700 行)。闭源分发原生二进制,成熟度业界最高,已官方抽为 **Claude Agent SDK** 供第三方复用。

- **亮点**:① 权限七层纵深(allow/ask/deny × **参数级规则** `Bash(npm:*)`/`Edit(src/**)` + Bash AST 语义分析 + 沙箱 + ask 安全阀 + 企业 policy 不可覆盖);② 五级上下文压缩(工具结果落盘→snip→microcompact(缓存热时走 API `cache_edits` 服务端就地删)→collapse→autocompact),压缩不破坏 prompt cache;③ 扩展三层完备(MCP 6 transport / 插件 8 类组件+marketplace 全命名空间化 / Skills 渐进加载+模型自动触发);④ Headless 一等公民(stream-json 双向流、`--max-turns/--max-budget-usd` 熔断、exit code 契约)。
- **短板**:① 模型绑 Anthropic,多 provider 仅兼容网关,defer_loading/cache_edits 依赖其 API 服务端;② 闭源只能逆向,版本演进快结论易过期;③ 压缩策略不可配置;④ **Windows 原生无沙箱(需 WSL2)**。

### 1.2 dsh(DeepSeek Harness)—— "Everything is a Plugin",与本项目渊源最深

TypeScript(MIT,developer preview v0.2.1-alpha.3),**vendor 了 Cordis 4.0.0-rc.7 插件框架**,产品自身(模型适配/工具注册/会话日志/agent loop)全是插件。pnpm monorepo ~340 包,Node ≥22.19,Electron 44 桌面壳 + web(127.0.0.1:3080)+ headless + sdk/acp 五 profile。四层 patch 组装(bundle→profile→home→`--patch`)按行 id 后写胜出。仓库带架构决策笔记与生成式文档门禁,工程质量极高。

- **亮点**:① agent loop/LLM/权限/持久化全部可插拔,patch 定点覆盖 + preset isolate realm——web 与 headless 挂载差异由同一机制自然表达(我们的踩坑其实是机制使然,见 §1.3);② **会话日志即真相**:append-only 事件日志派生模型历史/恢复/fork/遥测/回放,"model-visible means logged" + 分代 JSONL(`session.vN.jsonl[.zstd]`)显式迁移链、损坏 fail-closed;③ prompt cache 意识贯穿(system prompt = surface node 0、in-history 更新、runtime context 出缓存);④ **三平台 OS 级沙箱 fail-closed**:Linux bwrap→Landlock、macOS Seatbelt、**Windows ACL 受限令牌(每 workspace 写 SID + 每会话随机私有 temp SID)**;⑤ hooks-claude-code / hooks-codex 桥直接复用既有 hook 配置,subagent 可委派外部产品,互操作开放。
- **短板**:① developer preview 破坏性变更频繁(会话格式已 v0→v4 迁移史);② 深度绑 Cordis(学习曲线陡,有 cordis-primer 专文)与 DeepSeek 模型目录;③ 无内置跨会话记忆(推 MCP 外挂)、无跨 provider 自动降级、headless 无整跑超时;④ ~340 包复杂度,自研同等机制维护面大。

### 1.3 Codex CLI(OpenAI)—— Rust,权限/沙箱纵深最完整

Rust 2024 + tokio,~140 crate workspace("核心线程 + 多前端":TUI/VS Code/桌面全走 `codex app-server` JSON-RPC,自动化走 `codex exec` + TS/Python SDK)。Apache-2.0,稳定版数日一发,不接受外部 PR。

- **亮点**:① **权限五层独立收紧**:OS 沙箱(Seatbelt/bwrap/**Windows 原生沙箱服务**,elevated/legacy 双路径)× approval 三档 × Starlark execpolicy 前缀规则(allow/prompt/forbidden)× 命名权限 profile(filesystem glob + 网络域 allow/deny,deny 恒胜)× 企业 requirements.toml 锁定;`codex sandbox macos|linux|windows` 可单测沙箱;② Skills 渐进加载,预算 = 上下文 2%(上限 10k tokens);③ hooks 语义精细(PreToolUse 可 allow+改写参数 `updatedInput`、PostToolUse 可替换工具结果、Stop block 即续跑);④ Headless/CI 工程化(JSONL 事件流、`--output-schema` 校验、官方 GitHub Action 且密钥不进 job 环境);⑤ 会话 rollout JSONL(可 jq 回放)+ SQLite 状态库。
- **短板**:① wire_api 仅 responses 协议强绑 OpenAI,第三方 provider 需自建网关,无自动降级;② `codex mcp-server` 已移除,被编排只能对接 app-server 私有 JSON-RPC;③ 文档/实现漂移快(profile 语法 0.134 破坏性变更),无 exit code 完整表。

### 1.4 Gemini CLI(Google)—— 安全纵深 + 双协议集成

TS monorepo(core/cli/a2a-server/sdk 等 7 包),单进程 Node,React Ink TUI。Apache-2.0。

- **亮点**:① 安全栈最重:Policy Engine(TOML 五层优先级,Admin 恒胜,deny 的工具直接从上下文剔除)+ Folder Trust(未信任强制逐次审批)+ **六种沙箱后端**(docker/podman/Seatbelt 6 档/gVisor/LXC/**Windows 低完整性**);② hooks 完整(Before/AfterAgent/Model/Tool、PreCompress,可改参/换模型/阻断);③ **ACP + A2A 双协议**,既是客户端也是被集成方;④ Skills 按 agentskills.io 标准二级渐进加载;⑤ 原生 OTel(`gen_ai.*` 语义约定)。
- **短板**:① 模型封闭(仅 Gemini 系,无 OpenAI 兼容层,本地模型仅实验性 Gemma 路由);② 单进程无 client/server 拆分,程序化集成只有 headless JSON 与 SDK 封装;③ 部分能力停在 experimental,policy workspace 层尚不可用。

### 1.5 opencode(SST/Anomaly)—— 唯一真 client/server,协议解耦范式

全 TS + Bun(36 包,Effect 生态),**server 暴露 OpenAPI 3.1 + SSE,TUI/Desktop/Web/IDE/GitHub App 共用一套 API,SDK 由 OpenAPI 自动生成**。v2 将 v1 的 Go TUI 重写为 TS(OpenTUI+SolidJS)——注:server 始终是 TS,并非"Go server"。Vercel AI SDK + models.dev 接 **75+ provider**,本地 Ollama/LM Studio 走 OpenAI 兼容。

- **亮点**:① 多客户端 harness 形态最贴合"嵌入式集成"(设备面板可作为纯客户端订阅 SSE);② 模型与扩展最开放(75+ provider、npm 插件 ~30 个生命周期钩子事件粒度到 message.part);③ 权限参数感知(`git status *` last-match-wins)+ `doom_loop` 防环(重复 3 次自动转 ask)+ `.env` 默认禁读。
- **短板**:① 无 OS 沙箱、无原生 OTel,安全与观测靠外挂;② 迭代极快且 breaking(1→2 命令不并存),无 profile 机制,配置八层合并心智负担高;③ **Windows 原生支持弱(官方建议 WSL)**。

### 1.6 goose(Block/Square)—— 平台级全家桶,已捐 Linux 基金会

Rust workspace + Tauri 桌面 + goosed 后台服务。定位 "distro":可打包自定义发行版。**所有 extensions 都走 MCP**(builtin 也是内置 MCP server),70+ 官方扩展;Skills 走 "Skills platform extension" 注入。

- **亮点**:① 20 维度覆盖最全(headless/调度/桌面/权限/钩子/Recipe);② **权限双层**:会话级四模式(auto/approve/smart_approve/chat)× 工具级三档(always/ask/never),运行时决策自动持久化(批一次不再问);企业治理链(allowlist 精确匹配、API key 强制 keyring、SEC-uuid 审计日志);③ hooks 13 事件,PreToolUse exit 2 拦截,默认 fail-open 可配 fail-closed;④ Recipe YAML 可复现工作流(参数/子流程/retry/json_schema 输出)。
- **短板**:① 一切经 MCP 的 token 膨胀(官方自推 code-mode 缓解);② Rust 二开门槛高(5.8k commits);③ 读写分类是 LLM best-effort"非保证",默认 auto 模式偏激进;④ 无 OS 级沙箱(推 Docker/container-use)。

### 1.7 pi(Mario Zechner / earendil-works)—— 极简 harness 哲学,对自研最有启发

TS monorepo(pi-ai 统一多 provider API / pi-agent-core / pi-tui / pi-coding-agent),MIT。口号 "minimal, extensible agent harness that you can make your own";系统 prompt + 工具定义 **<1000 token**,代码量"一个下午能读完",仍打进 Terminal-Bench 前列。

- **亮点**:① **会话树**(JSONL entry 带 id/parent 指针,分支不删除、弃用分支自动摘要、`/tree` 导航)是本次调研最优雅的上下文设计;② 扩展 = 进程内 TS 单文件(jiti 免编译、热重载),领域资产挂载成本极低;③ 事件粒度细(before_agent_start 可改 prompt、tool_call 可改参/拦截、cache_warming_decision);④ pi-ai 统一 4 家底层 API + 跨 provider 上下文交接。
- **短板**:① **刻意无权限/审批系统**(作者称 "security theater",安全推 OS/容器层)——仅 project trust 一层;② 刻意不做子代理(用 bash spawn `pi --print` 替代);③ MCP "支持但不推崇"(默认姿势 CLI 脚本 + Skills);④ 无桌面/团队协作,生态靠作者个人影响力。

### 1.8 快扫:OpenHands / Aider / Cline

| 工具 | 判断 | 说明 |
|---|---|---|
| OpenHands | **不入榜** | 平台应用(Agent Canvas + Python SDK + Agent Server),SDK 化中但主体是产品;事件流架构可作二手参考 |
| Aider | **不入榜** | 终端 pair-programming 工具,深绑 git,无 harness 化意图;**repo map 思路单点借鉴** |
| Cline | **候选入榜** | VS Code/JetBrains/CLI/桌面多端 + `@cline/sdk`(Node agent API、createTool、hooks)+ headless JSON + plan/act/checkpoint;"产品 + harness 双形态",如需第三参照可补深调 |

---

## 1.9 dsh 现场经验核实(全部证实,机制升级)

我们在 dsh 上二次开发时记录的踩坑/经验,本次经仓库源码核实,全部成立且获得机制级解释:

| 现场经验 | 核实结果(机制) |
|---|---|
| Electron 桌面 + web 模式 + headless CLI(`apps/cli/src/bin.ts`) | 证实。bin.ts 唯一启动器;桌面 Electron + 私有 Desktop Host 加载打包 web 资产(本机安装的 v44 即此壳,版本号与仓库 0.2.x 系两套编号) |
| 插件树分 host/client/prompt/MCP;client 插件经 `dsh.client` export | 证实。package.json `dsh.client` 声明 → client-modules 组装 boot graph 经 /plugins 下发,懒加载进 `window.__DSH_BOOT__` |
| preset = 子插件列表,composer 下拉切换;`--patch` 机制 | 证实。`dsh-agent-preset` 行(plugins 数组 + isolate realm),内置 standard/ptc/minimal/cordis 四预设;`--patch` 为四层组装最外层 |
| **web 模式 MCP 挂 preset 子树、headless 挂顶层(相反)** | 证实并升级:web-app 把 agent-plane 工具行在 host 层全部 disabled、preset 内挂载;headless 直接用顶层行。**根因 = MCP client 按"配置所在 Cordis scope"生效**——当时误判为"挂载方式相反",实为同一 scope 语义的两种表现 |
| persona 经 system-prompt 的 `config.personaPrefix` 覆盖 | 证实。`deployment:persona-prefix/suffix` 有序 section;preset 内 persona 行按 scope 遮蔽全局注册,**冲突会 fail loud**——headless 下另挂 persona 插件失效即此机制 |
| 权限 workspace-write / danger-full-access + approval 策略 | 证实。SandboxMode 三档 × approval(ask/never)组合成 permission-presets 三预设,`DSH_PERMISSION_MODE` 可切;headless 关闭 credentials/authorization,策略由环境变量决定 |
| `@deepseek-ai/dsh-session-log-export` 会话导出 | 证实。packages/session-query/session-log-export,Web 侧 /export 命令 + 下载对话框 |
| 依赖 cordis(cordis.yml) | 证实。vendor/README 记录 cordis 4.0.0-rc.7 等 9 个上游包,MIT 保留,manifest 含上游 commit |
| 模型走本地网关(deepseek-v4.1-flash) | 部分证实。模型目录确认 DeepSeek-V4.1-Flash;"本地网关"非内置,官方 adapter 走 DeepSeek API,自定义网关由 llm-pi-ai 的 Custom model API 支持(openai-completions / openai-responses / anthropic-messages 三协议)——我们当时正是走这条路 |

> 迁移价值:这些机制级结论可直接用于新框架的需求验收——新框架若不能比"scope 决定挂载位置 + section 冲突 fail loud"更简单,就是退步。

---

## 2. 架构清单维度横向矩阵

评级:★★★ 领先 / ★★ 完整 / ★ 有基础 / — 无或弱。行为 framework-architecture-inventory.md 的条目(合并同源维度),列内简评。

### P0 内核

| # | 维度 | Claude Code | dsh | Codex | Gemini | opencode | goose | pi |
|---|---|---|---|---|---|---|---|---|
| 1 | 主循环 | ★★★ 生成器状态机,7 个续跑点,错误扣留 | ★★★ turn 模型,waterfall 前后钩,崩溃 resume | ★★★ Thread/Turn/Item,steer/interrupt | ★★ turn loop,maxSessionTurns | ★★ EffectTS,steps 上限 | ★★ 标准 loop | ★★ 直白 turn 循环 |
| 2 | 模型接入 | ★ 绑 Anthropic(Bedrock/Vertex/降级链) | ★★★ 双轨:官方 + pi-ai 孪生三协议,热改路由 | ★ 单 responses 协议,provider 可配 | ★ 仅 Gemini 系 | ★★★ AI SDK + 75+ provider | ★★ 15+ provider + ACP | ★★ 统一 4 家 API,可寄端点 |
| 3 | 上下文管理 | ★★★ 五级压缩,服务端 cache_edits | ★★★ 0.8 阈值 + verbatim 尾部 + pruner + spill,缓存感知 | ★★ auto-compact 阈值可配,Pre/PostCompact | ★★ 压缩服务(checkpoint 默认关) | ★★ 隐藏 compaction agent + 钩子 | ★★ auto-compaction + 溢出策略 | ★★ 会话树摘要,原始保留 |
| 4 | 工具系统 | ★★★ 60+ 工具,八阶段管线,读写分区并发 | ★★★ defineTool + 多段 waterfall + PTC | ★★ 独立 tools crate,逐工具审批 | ★★ ~20 内置 + 发现命令 | ★★ 自定义 .ts 工具可覆盖内置 | ★★ 工具属扩展,code-mode | ★ 四件套,暴露级别控制 |
| 5 | MCP 客户端 | ★★★ 6 transport + OAuth + 4 级 scope | ★★ stdio/HTTP,每 server 一插件,重连+变更通知 | ★★ stdio/HTTP+OAuth,黑白名单(**不再对外当 server**) | ★★ 三传输+OAuth,命名空间严格 | ★★ 双类型+OAuth 自动检测 | ★★★ 一切皆 MCP(也是负担) | ★ 务实支持但反对哲学 |
| 6 | 会话管理与隔离 | ★★ JSONL per project,resume/fork/branch | ★★★ **model-visible means logged**,分代 JSONL 迁移链 | ★★ rollout JSONL + SQLite 状态 | ★★ 按项目哈希,/rewind 三维回滚 | ★★ server 持有,share/attach | ★★ SQLite(v1.10),共库 | ★★★ **会话树**(parent 指针) |

### P1 扩展与安全

| # | 维度 | Claude Code | dsh | Codex | Gemini | opencode | goose | pi |
|---|---|---|---|---|---|---|---|---|
| 7 | 权限与审批 | ★★★ 参数级规则+AST+模式,企业 policy 不可覆盖 | ★★ 三预设+审计,**粒度=工具调用级** | ★★★ **五层纵深,网络域 deny 恒胜** | ★★ Policy Engine TOML+Folder Trust | ★★ 参数感知 last-match-wins+doom_loop | ★★ 双层模式×三档,决策持久化 | — 无(仅 project trust) |
| 8 | 提示词组装 | ★★ 15+ 节,近因效应排序,规则文件 | ★★★ ~30 个中央分配 section,{{变量}}严格插值 | ★★ AGENTS.md 链 32KiB,可整体替换 | ★★ GEMINI.md 三层+占位符 | ★★ AGENTS.md 首中+instructions glob | ★★ 多源拼装 | ★ ~30 行基础 prompt |
| 9 | Skills 渐进加载 | ★★★ 摘要注入+预算+双触发+fork 执行 | ★★ catalog 进 prompt,正文按需 | ★★ 标准实现,预算=上下文 2%/10k | ★★ 标准二级加载,四层发现域 | ★★ 标准+permission.skill 三级 | ★★ 开放规范实现,兼容 .claude | ★★ 完整规范,渐进披露 |
| 10 | 插件系统 | ★★ 8 类组件+marketplace,全命名空间化 | ★★★ **Cordis 全插件,inject/typed events/scope 链/isolate realm** | ★★ plugin=skills+MCP+hooks 打包 | ★★ Extensions 复制安装,冲突加前缀 | ★★ TS 插件 ~30 钩子,npm 自动装 | ★★ MCP 扩展+Open Plugins+Recipe | ★★ 进程内 TS 单文件,热重载 |
| 11 | 配置与 preset | ★★ 五层优先级,preset 弱 | ★★★ 四层 patch 按行 id 胜出,isolate realm | ★★ 分层 config.toml + 独立 profile 文件 | ★★ settings 分层 + alias 继承链 | ★ 八层合并,无 profile | ★★ config/permission/secrets 分离 | ★ settings/models/auth/mcp 四件 |
| 12 | 记忆系统 | ★★★ 自动记忆目录+后台提取,防恶意仓库 | ★ 无内置(AGENTS.md + MCP 外挂) | ★★ AGENTS.md + memories 双轨(默认关) | ★★ GEMINI.md 路由 + auto-memory(实验) | ★ AGENTS.md 手工 | ★ memory MCP 扩展 | — 无(外化到文件) |
| 13 | 钩子与事件 | ★★★ 27 事件×6 类型,JSON 可阻断/改写 | ★★★ **一切扩展点即事件**(typed events 五种派发) | ★★ 12 类事件,updatedInput 精细 | ★★ 完整生命周期,仅 command 型 | ★★ server SSE + 插件钩子双层 | ★★ 13 事件,fail-open/closed 可选 | ★★ 事件细但面窄 |

### P2 交互与自动化

| # | 维度 | Claude Code | dsh | Codex | Gemini | opencode | goose | pi |
|---|---|---|---|---|---|---|---|---|
| 14 | CLI/TUI | ★★★ React+Ink 自研渲染,slash/IDE/Desktop | ★★ Web 主形态,无 TUI(桌面 Terminal 侧栏) | ★★ ratatui TUI 主形态 | ★★ React Ink TUI | ★★ OpenTUI+SolidJS | ★★ Desktop/CLI 全形态 | ★★ pi-tui 差分渲染 |
| 15 | Web UI 与状态通道 | ★★ Web 版(cloud sessions) | ★★★ web 127.0.0.1:3080 + client 插件下发 | — 无 web(app-server 自有协议) | — 无 | ★★★ **OpenAPI 3.1+SSE,多端同构** | ★★ Desktop + REST SDK | ★ RPC 模式 + HTML 导出 |
| 16 | Headless | ★★★ stream-json 双向,预算/轮次熔断 | ★★ one-shot NDJSON,exit 0/1,**无整跑超时** | ★★★ exec + schema 校验 + CI Action | ★★ -p + json,exit code 语义明确 | ★★ run + serve + SDK | ★★ run -t + REST + ACP | ★★ --print/--mode json/rpc |
| 17 | 子代理 | ★★★ 三模式(子代理/协调器/Swarm 团队) | ★★ spawn/fork-in-process(保 KV-cache)/ACP/外部桥 | ★★ 角色 TOML,继承父权限,摘要回流 | ★★ agents/*.md + A2A remote,禁递归 | ★★ primary/subagent,限深 | ★★ lead-worker + 教程模式 | — 刻意不做(bash spawn 替代) |
| 18 | 观测与调试 | ★★ OTel beta + transcript + doctor | ★★★ OTLP + inspector + llm-replay + 快照测试 | ★★ OTel 百级指标 + rollout 即 replay | ★★ 原生 OTel gen_ai 语义 | ★ 无 OTel,http-recorder 补 | ★★ 日志分层 + Langfuse 教程 | ★ pi-telemetry 契约+测试 |
| 19 | 任务外化 | ★★ TodoWrite(内置) | ★★ todo/goal 工具内建 | ★★ plan 工具 + update_plan | ★★ todos/tracker 工具 | ★★ 内置 todo | ★ 工具/Recipe | — 无 |

### 横切

| # | 维度 | Claude Code | dsh | Codex | Gemini | opencode | goose | pi |
|---|---|---|---|---|---|---|---|---|
| 22 | OS 级沙箱 | ★★ Seatbelt/bubblewrap,**Windows 需 WSL2** | ★★★ bwrap/Landlock/Seatbelt/**Windows ACL 受限令牌**,fail-closed | ★★★ Seatbelt/bwrap/**Windows 原生服务**,网络域代理 | ★★ 六后端含 **Windows 低完整性** | — 纯权限模型 | — 推 Docker | — 推容器/VM |
| 23 | 多模态 | ★★ 图片/PDF,自动剥离防重复 | ★★ 图片完整(内容寻址+视觉计价),语音实验 | ★ 图片输入 | ★★ 图片/音频/PDF | ★ 拖拽图片 | ★ provider 层 | ★ 消息内图片 |
| 20 | 技术栈 | TS+Bun,闭源二进制 | TS,vendor Cordis,~340 包 | Rust,~140 crate | TS,7 包 | TS+Bun,36 包 | Rust + v8 | TS,极小 |
| 24 | 远程与多端 | ★★ cloud sessions/远程控制 | ★ ACP/SDK | ★ --remote ws:// | ★★ ACP+A2A 双协议 | ★★ 多客户端 attach + GitHub App | ★★ 移动端/Telegram 网关 | ★ RPC |

---

## 3. 谁在哪个维度最强(速查)

| 维度 | 最强参照 | 次强 |
|---|---|---|
| 主循环健壮性 | Claude Code(续跑点/错误扣留) | dsh、Codex |
| 多 provider / 本地网关 | opencode(75+) | dsh(pi-ai 孪生三协议)、goose |
| 上下文压缩 | Claude Code(五级+服务端编辑) | dsh(缓存感知精细)、pi(会话树) |
| 会话存储可靠性 | dsh("model-visible means logged" + 迁移链) | pi(会话树)、Codex(rollout+SQLite) |
| 权限粒度(参数级) | Codex(五层,网络域 deny 恒胜)、Claude Code(`Bash(npm:*)`) | opencode、Gemini |
| OS 沙箱 × Windows | dsh(ACL 受限令牌)≈ Codex(原生沙箱服务) | Gemini(低完整性) |
| 插件系统 | dsh(Cordis:inject/typed events/scope/realm) | Claude Code(组件命名空间化)、opencode |
| 配置/preset/patch | dsh(四层 patch 行 id 胜出) | Codex(独立 profile 文件) |
| Skills 渐进加载 | Claude Code(预算+双触发+fork) | Codex(2% 预算)、Gemini/opencode/goose(标准) |
| Headless/CI | Claude Code(stream-json 双向+预算熔断)、Codex(exec+schema+Action) | Gemini(exit code 语义) |
| Web 状态通道 | opencode(OpenAPI+SSE 多端) | dsh(web+client 插件,我们已验证) |
| 钩子/事件 | Claude Code(27×6)≈ dsh(一切即事件) | Codex(updatedInput) |
| 观测/回放 | dsh(inspector + llm-replay) | Codex(rollout 即 replay) |
| 极简可读性 | pi(<1000 token prompt,一下午读完) | — |

---

## 4. 对 10 个决策点的启示(逐条)

> 决策点编号 = framework-architecture-inventory.md §3。每条给"证据 → 倾向",最终由设计阶段拍板。

**#1 语言栈与复用边界 → 证据强倾向 TS**
7 家中 5 家 TS(Claude Code/dsh/Gemini/opencode/pi),2 家 Rust(Codex/goose)。我们的领域资产本就是 TS(embedded-ui 591 行)+ Python MCP(MCP 协议天然跨语言,不受影响)。TS 生态的同构收益:CLI/UI/server 共享类型(opencode 全栈 TS/Bun 已验证)、Cordis 等框架可 vendor(dsh 已示范)。复用边界:dsh 的 pi-ai 孪生证明"多 provider 适配层"可整体复用第三方库(pi-ai 本身就是开源的);协议层(MCP SDK/JSON Schema)必复用;harness 本体自研。

**#2 KB 渐进加载载体 → Skills 已是事实标准,但检索层独立**
SKILL.md 标准(agentskills.io)已被 Claude Code/Codex/Gemini/opencode/goose/pi 六家实现,渐进加载模式高度趋同(摘要注入 + 预算 + 按需读正文)。我们 KB 的三级跳法(索引→症状→reference)与其同构,迁移动作小。**但**:pi 对 MCP 的批判(21 工具 13.7k token)对我们 kb-mcp(仅 4 工具)不构成威胁,而 kb_search 的精确 token grep 恰是 Skills 纯文件加载不擅长的。倾向:**KB 正文走 Skills 载体,精确 token 检索保留 kb_search**(内置工具或 MCP 待定),最终由 RAG 对照实验(决策依据已在 rag-vs-agentic-search-todo.md 固化)数据拍板。

**#3 内置工具集最小范围 → pi 四件套为下界,dsh 全家桶为上界**
光谱:pi(read/write/edit/bash)↔ dsh(bash/pwsh/fs/fs-search/jobs/todo/web-search/LSP…)↔ Claude Code(60+)。我们场景建议:fs/shell/glob/grep + serial 类纳入内核考量(高频取证),其余插件化。

**#4 会话存储与回放协议 → dsh 原则 + pi 树结构**
dsh 的 "model-visible means logged"(append-only 事件日志派生一切)+ 分代迁移链 + fail-closed,是可靠性标杆;embedded-ui 回放(BR-6)依赖的正是"从日志重建工具结果状态",dsh 的 SessionEvent 设计直接可抄。pi 的会话树(parent 指针)对诊断场景额外有价值:**分支实验**(如 BR-1 的"可证伪预测→验证"可自然成为分支)。倾向:JSONL 事件流 + 树状 entry,格式对齐 opencode 的 NDJSON 事件命名(session/text/tool_call/tool_result)便于复用夜批解析。

**#5 权限粒度 → 必须参数级,Codex/Claude Code 是模板**
R1/R2(永不控仪器、写前声明)在工具调用级(dsh 现状)只能做到"整体开关",做不到"mem_write 允许 0x40000000-0x40007FFF 但禁 0xE000EDF0"这类表达。Codex 的命名 profile(filesystem glob + 网络域 allow/deny,deny 恒胜)与 Claude Code 的 `Tool(pattern)` 规则语言是两个可直接借鉴的语法。另注意:dsh headless `approval: never` 卡死工具调用的踩坑,机制是"missing answerer 返回 unavailable 即 fail-closed"——新框架的 headless 策略必须是**显式预设**而非"无审批通道时的意外行为"。

**#6 上下文压缩策略 → verbatim 尾部 + 白名单保护**
dsh(阈值 0.8 + 保留 verbatim 尾部 0.16)与 pi(摘要替换但原始 entry 永不删除)分别给出"压缩时保证据"的两个机制。诊断证据链(NFR-5"不能丢")落地:压缩白名单(工具结果证据类 entry 标记为压缩保护)+ 会话树保底(原始数据永远可回溯)。Claude Code 的"压缩不破坏 prompt cache"是工程红线,设计时必须继承。

**#7 多模型路由与降级 → dsh 三协议 + opencode provider 注册表**
本地网关(现 deepseek-v4.1-flash)+ 未来云 API 并存,需要:OpenAI-completions / OpenAI-responses / Anthropic-messages 三协议适配(dsh llm-pi-ai 已验证此分类完备)+ 声明式 provider 注册(opencode models.dev 模式)。全自动降级链(生成式模型 fallback)仅 Claude Code 有,可后置。

**#8 MCP 连接生命周期 → dsh 的 scope 语义**
dsh "MCP client 按配置所在 Cordis scope 生效"一个机制同时解决了我们的 web/headless 挂载差异与生命周期问题。会话隔离(BR/PLAT-2 点名)倾向:连接随 scope,默认会话级、全局级可配;必须有健康检查与工具列表变更通知(dsh 均已内建)。

**#9 UI 形态优先级 → Web 先行(资产决定),形态学 opencode**
embedded-ui(591 行)是 web 资产、设备面板依赖实时工具结果流(BR-6)→ Web 先行几乎注定。形态选择:opencode 的 server-first(OpenAPI+SSE,前端只是客户端)比 dsh 的 web-app 单体更契合"设备面板作为独立客户端订阅状态"——但 dsh 的 client 插件下发机制我们已跑通,迁移成本更低。倾向:自研采用 server-first 架构,但保留 client 插件式的挂载接口。

**#10 跨平台基线 → Windows 原生方案仅两例,均需重点研究**
全部踩坑来自 Windows(POSIX 路径/Kaspersky/pyOCD)。OS 沙箱的 Windows 原生实现全场仅两家:**dsh(ACL 受限令牌,每 workspace 写 SID + 每会话随机私有 temp SID,fail-closed)** 与 **Codex(Windows 沙箱服务,elevated/legacy 双路径)**;Gemini 有 Windows 低完整性档。Claude Code/opencode/pi 均实质放弃 Windows 原生(WSL2)。这既是自研的最大风险点,也是与 dsh 经验接续最紧的地方(其沙箱策略已在我们环境验证过)。

---

## 5. 战略观察:自研路线光谱

dsh **已开源(MIT)** 这一事实值得显式纳入决策——"不再基于 dsh 二次开发"的方向变更发生在其开源之前(2026-10-15 当天),本报告不推翻该决策,但补全证据面。三条路线:

| 路线 | 内容 | 优势 | 代价/风险 |
|---|---|---|---|
| A. vendor/fork dsh | 以 dsh 为底座,裁剪 + 领域资产挂载 | 复用度最高;其 prompt cache 意识/会话可靠性/Windows ACL 沙箱直接命中我们的三大难点;现场经验全部接续 | developer preview 破坏性变更;~340 包学习与维护面;绑 Cordis;上游 Fast-follow 成本 |
| B. 借鉴式自研(全量) | 按 P0-P2 清单自建,机制逐一参照最强者(dsh 会话/Codex 权限/opencode 通道…) | 完全可控,无上游风险;可裁掉不需要的 80% | 工程量最大;prompt cache/压缩等细节需自踩坑;Windows 沙箱需从零研究 |
| C. 极简自研(pi 路线) | loop + 四工具 + 树状会话 + Skills,领域资产为主角 | 核心极小可维护;pi 证明可打一线;嵌入式工具做成脚本库 + SKILL.md 可能够用 | 权限/审批需自建(R1/R2 硬需求,pi 明确不提供);Web UI/事件通道自建;无沙箱 |

**我们场景的三个特殊约束**(各家均无现成组合):
1. **R1/R2 安全边界要求参数级权限**(mem_write 地址范围)——排除纯 pi 路线,权限层是刚需;
2. **夜批 headless 一等公民**(BR-7)——要求 exit code/超时/事件流契约完整,dsh 无整跑超时、Codex 无 exit code 表,需自补;
3. **Windows 一等公民**(PLAT-9)——只有 dsh/Codex 路线有原生沙箱参照。

一个务实的混合判断(供讨论,非结论):**B 路线 + 局部 vendor**——TS 自研内核(loop/会话/工具/权限),直接复用 pi-ai(模型适配)、MCP SDK(协议)、Skills 标准(知识载体);会话格式抄 dsh、权限语法抄 Codex、事件通道学 opencode。这与"决策点 #1 复用边界"的答案自洽。

---

## 6. 各工具来源(去重后主要入口)

- Claude Code:code.claude.com/docs(cli-reference/headless/sandboxing/mcp/sessions/plugins-reference/settings/hooks);diwang.info/how-claude-code-works(社区逆向,二手);anthropics/claude-code
- dsh:github.com/deepseek-ai/deepseek-harness(architecture.md / cordis-primer.md / subsystems/mcp.md / event-producer-consumer.md / packages/* 源码);deepseek-harness.github.io;arXiv:2608.25512(设计论文)
- Codex:github.com/openai/codex(源码);learn.chatgpt.com/docs(codex/cli、sandboxing、agent-approvals-security、hooks、build-skills、app-server、config-*)
- Gemini CLI:github.com/google-gemini/gemini-cli docs/(headless/skills/policy-engine/sandbox/subagents/hooks/telemetry 等)
- opencode:opencode.ai/docs(/docs /server /agents /config /plugins /mcp-servers /permissions /skills)+ github.com/sst/opencode(v2 分支)
- goose:goose-docs.ai(architecture / goose-permissions / recipes / hooks / sessions / headless-gose 等);github.com/block/goose
- pi:pi.dev/docs(extensions/skills/sessions/how-pi-works/security/rpc);mariozechner.at(what-if-you-dont-need-mcp / pi-coding-agent);github.com/badlogic/pi-mono
- 快扫:github.com/cline/cline、aider.chat/docs、github.com/OpenHands/docs
