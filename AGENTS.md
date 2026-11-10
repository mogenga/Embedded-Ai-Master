# AGENTS.md — Embedded-Ai-Master

面向嵌入式调试场景的 agent 工具。当前已发布 **v0.3.2**（2026-11-10）：P0 内核（`src/`）、桌面前端（`desktop/`）与领域层 MCP server（`mcp-servers/`：probe / serial / keil / kb / embedded / datasheet）均已实现，测试在 `tests/`（`tests/desktop` 为协议层与宿主，`mcp-servers/*/tests` 为领域层）。按 `docs/BRD.md` 的里程碑口径，M2（领域层建设 + 扩展与安全）的主体已落地，**当前推进的是 M3**（交互与自动化：观测、todo 外化、BR-6 设备面板、BR-7 夜批管线，见「M3 剩余范围」）；阶段判断以用户确认为准，不要自行宣布进入下一阶段。构建与脚本配置见 `package.json` / `tsconfig*.json` / `vitest.config.ts`；剩余修复与外部验证项见 `docs/ledgers/deferred-issues.md`。技术栈与命令以 `package.json` 与 `README.md` 为准，不要臆造。

## 事实源（先读这些，别猜）

`docs/` 自 2026-11-07 起按角色分四个子目录，索引见 `docs/README.md`：`specs/`（设计与规范）、`operations/`（操作手册与契约）、`ledgers/`（台账）、`archive/`（已完成的任务书）。`docs/` 根只放 `BACKLOG.md`、`BRD.md`、`README.md`。

- **`docs/BACKLOG.md` — 待实现功能的唯一排期入口**（批次 4~10）。要开工先在这里找批次，不要在台账里随手挑一条。
- `docs/BRD.md` — 业务需求（领域层 BR-xx / 平台层 PLAT-xx）、硬性规则 R1-R9、路线图 M1-M4。
- `docs/specs/p0-kernel-design.md` — 当前 M1 设计稿（harness 内核六项：主循环 / 模型接入 / 上下文 / 工具系统 / MCP 客户端 / 会话）。
- `docs/specs/framework-architecture-inventory.md` — 框架能力清单 24 项 + 10 个决策点。
- `docs/specs/harness-comparison.md` — Claude Code / dsh / Codex / Gemini CLI / opencode / goose / pi 横向调研。
- `docs/ledgers/rag-vs-agentic-search-todo.md` — 待办对照实验（决策点 #2 的判据）。**决策点 #2 至今未关闭**：结果为 exploratory，多 gold 标注、扰动集 H6、B 的 H7 跑批与 10x 规模验证均未做。
- `docs/specs/ontology-scope-note.md` — Ontology 暂缓纳入检索比对的**范围决策**与重启条件（2026-10-19）。它不是待办缺陷，不登记进 `deferred-issues.md`；未经重启条件触发，不要主动把它并入方案比对。
- `docs/specs/m2-roadmap.md` — M2 路线图（决策点 #5/#9 已关闭项、M2 任务分期）。**文首有 2026-11-07 现状说明**：文中「Web + HTTP API / SSE」的形态已不存在，交互形态是桌面 Electron 宿主。
- `docs/specs/frontend-design.md` — 前端设计规范（布局、令牌、组件、验收口径）。**v2.0 起以 `desktop/renderer/` 的实现为准**；v1.4 及更早基于已删除的 Preact 工作台，仅历史留档。
- `desktop/MATRIX.md` — 前端命令/事件能力矩阵（已支持 / 隐藏 / 原因），是前端能力边界的事实源。
- `docs/specs/system-prompt-design.md` — 系统提示词分节组装设计（六节，稳定性降序）。**只实现了 `environment` 一节**（P0 切片）；`base` / `tools` / `instructions` / `memory` 的措辞属产品决定，未定稿前不得凭空补写（D-221 的教训）。
- `docs/ledgers/optimization-and-new-features.md` — 2026-11-06 的 44 项审计汇总。**§12 是当前有效的落地对照表**（16 项已落地 + 2 项部分 + 剩余项）；§§2–4 保留审计当时的位置与判断，不要当排期依据。
- `docs/ledgers/deferred-issues.md` — 已知但暂不修的缺陷与覆盖缺口，含升级触发条件；改动前先查，避免重复发现。
- `docs/ledgers/embedded-defects-todolist.md` — 嵌入式子系统的缺陷复查台账（T-xxx），与 D-xxx 分开编号；台账未结项只剩 T-035 与 T-040。**注意 T-035 台账写「待修」，但代码已改成赋值**（`desktop/renderer/app.js:3281`：`state.serial.dropped = message.dropped ?? …`，注释写明「assign, don't accumulate」，随 `dbb8226` 合入），缺的是把这条决定用断言钉住——不要因为台账写着「待修」就重复改一遍。
- 领域 MCP 的设计与操作手册：`docs/operations/keil-headless.md`（Keil 接线、57 个调试动作、已知限制）、`docs/operations/datasheet-mcp.md`（PDF 检索与寄存器提取）、`docs/operations/serial-panel-spec.md`（串口助手，含事后结论）、`docs/operations/toolchain-packs.md`（包管理器不变量与权限语义）、`docs/operations/corpus-ota.md`（语料 OTA 契约，唯一契约源）。
- 发布与签名：`docs/operations/release.md`（发布流程唯一操作手册）、`docs/operations/code-signing.md`。

架构为两层：**平台层**（领域无关 harness，模型接入/上下文/工具/会话/权限）与**领域层**（嵌入式调试能力，经 MCP / 插件挂载）。内核代码不得含领域逻辑——嵌入式取证一律走 MCP，不进内核。

**只有一种交互形态：桌面 Electron 宿主。** 2026-10-22 起浏览器形态下线，`desktop/renderer/bridge.js`、`src/server` 的 HTTP 层与 `tests/server/*` 已删除。宿主 ⇄ 渲染器是 NDJSON over stdio，审批走宿主 `permission` 命令，事件走宿主进程内加速通道 + 日志跟随兜底。任何文档里出现 `/api/*`、SSE、`EventSource` 都是历史留档。

## 常用命令（以 `package.json` 与 `README.md` 为准）

- 测试：`npm test`（vitest run，不触网，约 **4650 例** / 60–130 s）、`npm run coverage`（`lines ≥ 85%`，当前实测 90.21%）、`npm run test:desktop`（协议层与宿主）、`npm run test:mcp`（领域层）。
- **覆盖率口径**：`src/**` + `mcp-servers/{kb,datasheet,probe}/**`，排除 `**/tests/**`。`keil` / `serial` / `embedded` **刻意不纳入**——剩余路径必须连真实 uVision（UVSOCK 4823）或真实 COM 口，纳入只能靠豁免或造假。**不纳入 ≠ 已验证**：这两块仍由 D-157 的真机验证跟踪。理由与实测数字见 `vitest.config.ts` 的 `coverage` 注释。
- 静态检查：`npm run typecheck`；`npm run check:js`（`desktop/` 与 `scripts/` 的 JS 语法，补 `tsc` 的盲区）；`npm run check:docs`（markdown 本地链接与 `<img src>`，移动/改名文档后必跑）；`npm run check:ledgers`（台账内部自洽）。**`npm run lint` 等同 `tsc --noEmit`**（D-006），不是独立检查。
- **完整验证：`npm run verify`** —— typecheck + check:js + check:docs + check:ledgers + test 一次跑完。交付前用它，而不是只跑 `npm test`。
- **`check:ledgers` 的能力边界**：只对齐台账**内部文字**（顶部复核注记 vs 状态行、状态块内前后判词）。它**不读 `src/` 与 `desktop/`**，所以绿灯只意味着「没有条目自相矛盾」，**不意味着每个状态对代码都为真**。后者仍需人工逐条核对代码——2026-11-07 的审计做的是后者。
- 构建：`npm run build`（先清 `dist/`）、`npm run build:mcp`（先清 `dist-mcp/`）；两条各清各的目录，不要交叉清理。
- 端到端（需环境，默认不在 CI）：`npm run probe:e2e`（真实 Renode）、`npm run diagnosis:e2e`、`npm run packs:e2e`、`npm run kb:regression`、`npm run kb:review`、`npm run datasheet:regression`、`npm run datasheet:corpus`。
- 桌面形态：用户先执行 `npm --prefix desktop install`，再 `npm --prefix desktop run desktop`。**agent 不代为执行任何 install**（见下文禁令）。
- live 测试默认跳过；开启方式见 README「live 测试」。
- **并行负载下的偶发红**：本机默认并行度下 `background-terminal` / `mcp-manager` / `ls` / `files-api` / `glob` / `shell` 偶发超时（单跑必绿，每次红的用例都不同）。稳定口径是 `npx vitest run --maxWorkers=4`。判断「是不是真回归」时先单跑那条用例，再按稳定口径复跑一次。
  **判断方法**：单文件跑 `npx vitest run <file>` 全绿 + 全量跑只红那一条 = 负载，不是回归。不要为了让它绿去调大测试的超时阈值——那会把真实的慢也一起藏掉。

> [!IMPORTANT]
> **这一类红的机制已查清（2026-11-08，D-229），此前两版说明都不完整。**
>
> **`taskkill /T /F` 的启动成本固定约 1 s**，与负载无关：对**不存在的 pid** 实测 10 次也要 953–1218 ms。那是进程创建 + 杀软扫描的成本。
>
> **旧实现用 `spawnSync` 调它，同步阻塞事件循环。** 阻塞期间测试自己的 25 ms 轮询（`waitForExit`）一次都跑不动，它的 10 s 预算在阻塞里花光——出来就报 `process N still running`。所以「偶发红」不是机器慢，是**同步等待 + 轮询被自己的阻塞饿死**。
>
> **并行全量下还会再翻一个数量级**：同时挂着十几个真实进程树时，`taskkill` 要排队等一个进程创建名额。实测「发出信号 → 进程真的消失」5 次为 **1.1 / 1.1 / 1.6 / 8.8 / 15.2 s**（空闲时 0.7–0.95 s）。
>
> **已修的三层**（D-229）：
> 1. 新增 `src/tools/process-tree.ts` 的 `signalProcessTree`：异步 `spawn` + `unref`，调用从约 1000 ms 降到 **8–21 ms**。
> 2. `background.ts` / `shell.ts` 各自的私有 `terminateTree` 删掉，共用上面那一份。
> 3. 去掉重复 kill：`killAllBackgroundJobs` 每作业从两次改一次；`stopJob` 的 escalate 只在进程仍存活时才重发。
>
> **测试侧**：`background-terminal` 里 7 条只验语义的用例改用假子进程（`scriptedChild`），该文件单跑从 **20.98 s → 4.42 s**。
>
> **仍然会偶尔红的是两条真进程用例**，它们**必须**用真进程（「进程真的没了」就是断言本身）：`kill 请求真实结束进程`、`process-tree-terminate` 的「整棵树最终真的会消失」。把这两条也换成假子进程，等于让它们变成自我印证的空测试。
>
> **改前 vs 改后**（全量 `--maxWorkers=4`，各 10 轮）：改前约 2/3 的轮次会红、单轮红 6–13 条；改后约 1/3 的轮次红、单轮红 1–2 条。
>
> **如果要求「全量永远 0 红」**：把这两个文件放进独立串行组（`vitest.config.ts` 的 project 配置），代价是全量多花约 15 s。当前**没有**这么做——保留真进程验证比「绿灯好看」更重要。
- CI（`.github/workflows/ci.yml`）只有两个 job：`typecheck + syntax (fast)`（ubuntu，`typecheck` + `check:js`）与 `build + test (offline)`（windows，`build` + `build:mcp` + `coverage`）。**覆盖率闸门只在 `--coverage` 下生效**，所以 offline job 不单独跑 `npm test`。
- 本地资产缺失时（KB 语料、查询集、真实 `index.yaml`、`dist-mcp/kb/inbox.js`）相关用例 `skipIf`，**不是覆盖下降**；CI 恒比本地多 skip 5 例。

## 硬约束（不可违反）
1. **技术栈已定案（2026-10-16，决策点 #1 关闭），完整约束如下**：
   - **语言与运行时**：TypeScript + Node 24（ESM-only，禁止 CommonJS 混用）。本机已具备 Node 24.14.1，package.json 用 `"engines": { "node": ">=24" }` 声明。
   - **协议层（可复用，不得自研）**：MCP 官方 TS SDK v2——`@modelcontextprotocol/client`（harness 侧客户端）、`@modelcontextprotocol/server`（MCP server 入口，测试夹具用）、`@modelcontextprotocol/server/stdio`（stdio 传输）；工具与消息 schema 用 **Zod v4**（MCP SDK v2 走 Standard Schema，Zod v4 为首选接线）。
   - **内核（必须自研，禁止整体引入现成 harness）**：主循环 / 会话 / 工具系统 / 上下文管理 / MCP 生命周期。可借鉴 Claude Code / dsh / opencode 源码语义，但不得 vendor 任何现成 harness。
   - **模型适配层（必须自研）**：极简适配器，仅 `complete` / `countTokens` 两方法；P0 只实现 OpenAI 兼容（`/v1/chat/completions`）；可借鉴 dsh llm-pi-ai 语法，但不整体引 pi-ai。
   - **测试**：vitest。
   - **前端（2026-10-20 移植定案）**：纯 ES 模块，**无框架、无打包器、无构建步骤**——`desktop/renderer/` 直接被 Electron 加载，渲染层是 JavaScript（内核才是 TypeScript）。不要引入 Vite/Preact/React 等构建链或 UI 框架。桌面形态经 `desktop/host/host.js`（NDJSON over stdio）接内核，宿主与渲染器共用 `desktop/renderer/protocol.js` 这一层纯映射。内核不支持的能力**隐藏入口**而不是伪造（宿主回显式 `notice`，R3）。
   - **模型协议范围（P0）**：适配层只实现 OpenAI 兼容（`/v1/chat/completions`），`providers.json` 的 `protocol` 字段是字面量 `"openai-chat-completions"`——没有 Anthropic / Gemini 原生协议。新增协议要改 schema 与适配层，不能只在配置里写一个新值。
   - **查证规则**：凡涉及库/框架用法（含上列已定案库的 API 细节），**必须先经 Context7 MCP 查证**（已配置：`.codeartsdoer/mcp/mcp_settings.json` → context7）核实版本、运行时要求与用法后再引入；禁止凭记忆臆造任何 API、版本号或配置项。
2. 安全边界（散见于 BRD §8）：R1 LLM 永不直接控制仪器；R2 探针写内存/复位前先声明；R3 工具必须诚实（读失败显式报错、全 0 不得解码为"无故障"）。

## 当前能力边界（别把没有的当有）

这份清单是**写代码前的事实核对表**；每一项都对应 `src/` 或 `desktop/` 的真实代码，细节与原因见 `docs/ledgers/deferred-issues.md`。

**内核有**

- 12 个内置工具（顺序固定）：`echo` / `read` / `ls` / `todo_write` / `write` / `edit` / `multiedit` / `shell` / `terminal_bg` / `terminal_bg_check` / `glob` / `grep`（`src/tools/builtin.ts`）。**`artifact` 工具已于 2026-11-09 随产物面板一起删除**——内核仍把超大输出落盘，但没有工具或界面再读回它。
  **另有 2 个子代理工具不在这个清单里**：`subagent` / `subagent_check`（`src/subagent/tools.ts`）需要 `model` / `registry` / 权限规则，所以由 `src/index.ts` 与内置工具**并列装配**（两条 `ToolRegistry` 构造路径都要，漏 `registry.replace` 那一处会让它们在一次 MCP 工具刷新后消失）。`createBuiltinTools()` 仍然返回 13 个，`tests/tools.test.ts` 钉着这个数。
- 会话级 MCP 连接、工具名命名空间、权限四档预设（`read-only` / `workspace-write` / `diagnose` / `danger-full-access`）、参数级规则。
- **只读子代理**：同进程嵌套 `query()`，工具面由 `read-only` 预设钉死（不是第二张白名单），最多 4 并发、**轮数与寿命缺省不限**（2026-11-09；原来的 30 轮 / 10 分钟默认值已删除），子会话落在 `<父会话目录>/subagents/<id>`，开跑写 `subagent_started`、完成写 `subagent_result`。契约见 `docs/operations/subagent.md`。**父轮次结束不杀子代理**；子代理的产物根是它自己的 `<childDir>/artifacts`（父会话的不可见）。
  **界面**：对话区上方一行子代理条（几个在跑、各跑了多久），展开后逐条可点；点开是子会话的**只读回放**（宿主 `sessionId` 留在父会话，`prompt` 被拒），顶部有返回父会话的提示。路径由 `desktop/host/subagent-session.js` 解析——父子 id 各自过 `isValidSessionId`，`subagents` 是字面量。
- **外部命令钩子**：`$HARNESS_HOME/hooks.json` 的 `preToolUse` / `postToolUse`，退出码 2 阻断、其它非 0 fail-closed，`postToolUse` 的 stdout 追加进结果正文并把 `evidence` 降为 false。接在权限层**之后**（`executeAuthorized`），所以只能收紧不能放行。契约见 `docs/operations/hooks.md`。**桌面形态不加载项目级钩子**（与 MCP / permissions 同一姿态：宿主不传 `trustProjectConfig`）。**`/hook` 列出当前生效的条目，`/hook reload` 重读——只重读给界面看，正在跑的会话仍用它启动时那份。**
- 主循环：流式片段落盘、`thinking_delta` 推理通道、三级上下文压缩、`deadlineMs` 整跑墙钟、连续截断上限 3 次、`context_length_exceeded` 恢复一次。
- **推理强度：三级回退**（2026-11-10）。解析某档实际发什么，依次看 ① 网关 `GET /v1/models` 报的能力（`reasoning_efforts` / `effort.supported_levels`，字段名有别名表，见 `src/model/catalog.ts`）→ ② `providers.json` 的 `reasoningLevels` → ③ `effortMap` / `DEFAULT_EFFORT_MAP`。规则是「取 ≤ 该档的最高可用值」（`resolveTierAgainst`），与 Claude Code 文档同一条。**`supportsReasoning: false` 仍最优先**；目录能推翻「用户没声明」，因为它是执行方。宿主把目录按 provider 分开缓存 24h（`$HARNESS_HOME/model-catalog.json` v2），换 provider 时作废在途抓取（代次号）。
  **界面**：脑形滑块卡片，**固定六格**（Low/Medium/High/Extra/Max/Galaxy，`auto` 不占格）。每格下方标出该模型实际会发的协议值；没有对应值的格画 `—` 并吸附到最近可用档。契约见 `docs/specs/effort-tiers.md`。
- 系统提示词**只有 `environment` 一节**（工作目录 / 平台 / shell / 会话日期），投影期注入、不写日志。

**内核没有（不要假装有）**

- **没有 `base` / `tools` / `instructions` / `memory` 四节系统提示词**——措辞是产品决定（D-221），未定稿前不要凭空补写。
- **没有记忆系统**：内核没有持久记忆、没有 CLAUDE.md 式项目记忆、没有跨会话沉淀通道。
- **子代理与钩子已在 2026-11-09 落地，但形态与 Claude Code 那套不同**（见下面「当前能力边界」的补充说明）：子代理是**只读**的（`src/subagent/`，`subagent` / `subagent_check` 两个工具），钩子是**外部命令**（`src/hooks/`，`hooks.json` 里的命令，不是进程内 JS 模块）。渲染层里 `goal_*` / `checkpoints` 仍是死 UI（D-185），旧的 `subagent_*` 卡片 UI 已整块删除且**没有**被捡回来。
- **没有多模态输入**：`ModelChatMessage.content` 是 `string`，图片发不出去（D-188 短期方案：有附件即拒绝发送）。
- **没有多会话并发**：`runner.start` 单会话串行，运行中追加/取消都不支持（D-148）。
- **MCP 只有 stdio transport**，没有 HTTP（D-190）。
- **没有整片擦除**：`PRJ_FLASH_ERASE` 在 MDK 5.43 无响应（D-201）。

**领域层 MCP（`mcp-servers/`）**

| server | 工具数 | 说明 |
|---|---|---|
| `probe` | 15 | Renode / OpenOCD 后端；`renode_load` 装 ELF |
| `serial` | 1 | `embed_serial`，读面板环形缓冲或一次性捕获 |
| `keil` | 2 | `keil_debug` / `keil_project`（动作多面） |
| `kb` | 7 | `kb_lookup` / `kb_read` / `kb_search` / `kb_grep` / `kb_glob` / `kb_status` / `kb_propose` |
| `embedded` | 8 | 统一门面（Keil 路由 / 工具链 packs） |
| `datasheet` | 4 | `datasheet_search` / `datasheet_read` / `datasheet_registers` / `datasheet_status` |

**首启自动接入四台**（`kb` / `serial` / `keil` / `datasheet`）：桌面宿主第一次启动时按「产物存在就写、用户已配不覆盖、失败如实上报」写进用户 `mcp.json`。**`probe` 不在种子清单里**——探针要用户自己配（需要真实后端路径与权限模板）。`embedded` 是统一门面，经 Keil 路由与工具链 packs 挂载。

**桌面前端**：工作台两 pane（`serial` 常驻；`file` 由动作打开）。**产物面板已于 2026-11-09 删除**。没有文件树、没有板卡面板、没有终端面板。

## M3 剩余范围（BRD M3 里程碑，未完成部分）

按 `docs/BRD.md` §12 的 M3 定义，以下仍是缺口，**不要当作已实现**：

- **BR-6 诊断过程可视化**：设备面板已删（不是「隐藏」），会话打开即从日志重建转录。**顶部事件回放控件已于 2026-11-09 按用户要求移除**（`#replay-bar` 整套 UI 与渲染层状态；`atSeq` 参数保留）。BR-6 验收①早已随面板删除作废（`docs/specs/device-state-surface.md`）。
- **BR-7 夜批管线**：离线部分已落地（`scripts/nightly-batch.mjs` + `docs/operations/nightly-batch.md`，夹具格式 / 幂等 / 双层超时 / exit code 表齐备）。**从未接过真实 Renode 或真实模型**——夹具里的模型由注入的 `fetchImpl` 合成。
- **P2 其余项**：子代理与 hooks 已落地（见下），**观测里的工具 trace 未建且用户明确不做**（2026-11-08，`docs/BACKLOG.md` 批次 9 已摘除）。
- **外部验证**（D-111 / D-157 / D-211，D-212 已关）：
  - **仍未实测**：live 网关、真实第三方 MCP、真机串口与 OpenOCD（D-111 / D-157）、Windows 代码签名（D-211）。任何「Keil / 串口链路已验证」「签名已生效」的说法在这些条目关闭前**都不成立**。
  - **2026-11-09 已实测**：干净机器安装 v0.3.0 通过；一次真实的应用内更新跑通（旧版收到 v0.3.0 提示 → 下载 → 重启安装完成），D-212 随之关闭。**只跑过一次**，后续版本仍应在发布后各验一次。
  - **v0.3.1 与 v0.3.2 均未做上面两项验证**（2026-11-10 仅完成打包与发布）。
  - **批次 10 已标「不做」（2026-11-09）**，退出排期——但标注不改变上面那张「未实测」清单，详见 `docs/BACKLOG.md` 批次 10 的 WARNING 块。

## 危险命令测试禁令（强制，2026-10-18 事故后新增）

任何测试、探针、演示、子代理任务都**禁止在宿主机真实执行可能造成破坏的命令**，包括但不限于：`del /s /q <盘符根>`、`rm -rf /`、`rm -rf ~`、`format`、`diskpart`、`mkfs*`、`dd ... of=/dev/...`、`shutdown`/`reboot`/`poweroff`/`halt`、fork bomb、`reg delete HKLM`、`bcdedit`、`cipher /w`。

危险命令测试必须分两层，缺一不可：

1. 纯函数断言拦截器识别（如 `expect(isDangerousCommand(cmd)).toBe(true)`）；
2. 若测试 `execute`，必须先完成第 1 层断言，再调用 `execute`，并断言底层 `spawn`/`exec` **未被调用**。

- 禁止为制造 RED 而真实执行危险命令；RED 只能由纯函数断言或注入 mock 产生。
- 真实命令测试只允许无害、跨平台、无副作用的命令（如 `node -e "console.log(...)"`、临时目录内读写），并限定在临时 workdir。
- 子代理 brief 必须原样包含本节约束；reviewer 必须检查测试是否存在真实执行危险命令的路径。
- 违反即停止：立即停止当前任务、报告用户、不得重试，并把事故写入 `dev-notes`。

**事故记录（2026-10-18）**：维度 4 `shell` 工具的 RED 测试未先断言拦截器，直接调用 `execute`，真实执行了 `del /s /q C:\*.*`（约 5 秒）。无法确认删除范围；`del` 默认不进回收站。教训：危险命令用例的 RED 不能靠真实执行来制造，必须先证明拦截器识别、再证明未 spawn。

## 依赖安装禁令（强制，2026-10-19 事故后新增）

- **agent 禁止执行任何依赖安装/变更命令**：`npm install`、`npm ci`、`npm update`、`yarn`、`pnpm`、`bun install` 等。只能把命令原样输出给用户，等用户确认完成后再继续。
- 原因：沙箱曾出现 EPERM/超时；本次事故中 `node -e "..."` 的反引号被 bash 命令替换，误执行了一次 `npm install`。
- 写文档/文件禁止用 `node -e`、`bash -c` 拼接含反引号、`$()`、`${}` 的文本；一律用 Write/Edit 工具或独立脚本文件。
- 违反即停止：报告用户、记录 `dev-notes`、不得重试。
- **事故记录（2026-10-19）**：维度 5 Task2 追加 dev-notes 时 `node -e` 含 Markdown 反引号，被 shell 展开误执行 `npm install`；事后核对 `package-lock.json`/`node_modules` 未观察到变化。

## 开发与审查原则

开发和代码审查须遵循第一性原理：从需求目标、约束和可验证事实出发，明确假设与因果链；不以惯例、类比或既有方案代替论证。审查结论须指出可复现的依据及其对需求/约束的影响；无法验证的判断应标明不确定性，不得当作事实。

## Git 协作约束

未经用户明确特批，禁止使用 `git worktree` 进行开发；开发任务只能在当前工作区通过创建或切换 Git 分支完成。

## 过程留痕（每阶段必做，禁止收尾一次性补记）
在 `dev-notes/{开发阶段}.md`（如 `dev-notes/P0-主循环.md`）**增量**追记。每完成一个阶段——定稿、计划评审通过、每个任务完成、code review 结论、finish——就补一段，每段记四样：用户关键原话、关键产出（spec / plan 路径、评审结论）、被拒绝或纠偏的内容、翻车与返工。

## 子代理派发（SDD / subagent-driven-development）

用 `superpowers:subagent-driven-development` 按计划逐任务派发子代理时，**brief 必须先用技能自带脚本生成，再派发**：

```bash
bash "<skills-dir>/subagent-driven-development/scripts/task-brief" <plan.md> <N>
```

- 脚本按 `### Task N` 标题抽取该节全文，写入 `.superpowers/sdd/<plan-basename>/task-N-brief.md` 并打印路径；该目录已由 `.superpowers/sdd/.gitignore`（内容 `*`）整体忽略，不进版本库。
- 派发提示里只给 brief 路径（"read this first — it is your requirements"）+ report 路径 + 前序任务接口，**禁止把整份 plan 塞给子代理**，也禁止手写/口述 brief 代替脚本产物。
- **brief 不存在就不得派发**。若脚本以 exit 3 报 `task N not found`，说明 plan 的标题格式不匹配——修正 plan 标题，不要绕过。
- 已发生事故（2026-10-16/17）：Task 2、Task 3 派发时 brief 从未生成，子代理如实报告"brief 不存在"后自行降级去读整份 plan；`task-1/2-brief.md` 的出生时间晚于对应 report，属事后补写，实施需求因此未被 brief 约束。核验任务时把 brief 的出生时间与 report 对照，可发现此类偏差。

## 提交信息规范
- 格式 `type(scope): description`。
- `type` 仅限：`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `chore`。
- `scope` 用真实模块名（如 `hal`、`uart`、`debug`、`cli`），禁止 `misc` / `stuff`。
- `description` 用中文，不加句号，≤ 50 字。
- 破坏性变更：`feat(scope)!:` 或脚注 `BREAKING CHANGE:`。

## 完结交付
每个功能完结时交付三样：**功能演示命令、测试结果、dev-notes 路径**。

## 环境注意
Windows 为一等公民（git-bash）。已知坑（详见 BRD §13 / §11.2）：Kaspersky 启发式会静默删除 ELF；pyOCD USB 枚举死锁，真硬件后端必须用 OpenOCD；内部路径按 POSIX 风格统一表示，出口再转换。

- **本机 `gh` 不在 `PATH`**：`C:\Program Files\GitHub CLI\gh.exe`（已登录，账号 `mogenga`）。查发布状态时用绝对路径。
- **路径大小写与形式**：Windows 上 mock/断言判据用 `path.basename` 而不是拼接字符串；同一文件可能以 `E:\…`、`/e/…`、`file:///E:/…` 三种形式出现（`9c2166e` 的教训）。
- **行尾**：仓库有 `.gitattributes`，部分文档在工作区是 CRLF、入库转 LF；`git diff` 的 CRLF 警告不是改动。
- **不要用 `node -e` / `bash -c` 拼含反引号或 `$()` 的文本**（见下文依赖禁令的事故记录）；写文件一律走 Write/Edit。

## 实现期注意事项

- **先查 `docs/ledgers/deferred-issues.md` 再动手**：已知缺陷有编号（D-xxx），修复后标注「已解决」并保留条目，不要删除。
- **`npm run lint` 等同 `tsc --noEmit`**（D-006），不要把它当作独立静态检查的证据。
- **测试不得触网**：live 测试由 `HARNESS_COMPAT_LIVE=1` 显式开启；默认 `npm test` 必须离线通过。
- **工具必须诚实（R3）**：新增工具或错误路径时，失败要显式返回错误码，不得静默吞掉或把失败伪装成成功；界面也不得伪造提交成功。
- **改文档前先确认它是「事实源」还是「历史留档」**：现在有多处描述已被实现推翻（`m2-roadmap.md` 的 Web/HTTP、`frontend-design.md` v1.4 及更早、`MATRIX.md` 的历史轮次记录）。事实源写事实，历史留档加日期注记、保留原文；两类都不要改写对方的语气。
- **`docs/ledgers/deferred-issues.md` 的状态行不是单一事实源**：条目顶部可能有 `> **YYYY-MM-DD 复核：…**` 的注记，两者矛盾时以正文证据为准（2026-11-07 就核出 6 处状态行落后于正文）。改状态前先读条目全文。
- **超时/取消的语义**：新增工具须响应 `AbortSignal`；超时后不得让残留调用与后续调用重叠（D-022 已缓解，新增写工具前重读）。**`deadlineMs` 到点只是不再发起新调用**，不强制终止正在执行的工具——不要把它宣传成硬杀。
- **内核不含领域逻辑**：探针 / 串口 / KB 等嵌入式能力一律经 MCP 挂载；`src/` 只放平台层能力。
- **新增会话事件类型 = 四处同步**：`src/session/types.ts` 的 `EventType`、`src/session/persistence.ts` 的 `EVENT_TYPES`（读盘白名单）、`src/context/build.ts` 的投影 `switch`、`desktop/renderer/protocol.js` 的 `KNOWN_TYPES`，另加事件能力矩阵 `desktop/MATRIX.md`。少一处就是「整份日志读不出来」或「整屏未识别事件」。
- **新增前端能力前先看 `desktop/MATRIX.md`**：内核没有的能力隐藏入口（宿主回 `notice`），不要画一个点了会报错的按钮。
- **新增一个渲染层模块要过两道门**：`npm run check:js` 会真的 `link()` 一遍相对 import，缺导出会当场失败（2026-11-09 事故 `main.js` 的悬空 import 之后加的）；但它**不查作用域**——模块里引用了未声明的常量只有真实窗口能发现，写测试时用「常量既都有声明、也都真的被用到」那类静态断言兜（`tests/desktop/galaxy-effort.test.js` 是范例）。
- **`desktop/renderer/styles.css` 有一条全局 `svg { width:16px; height:16px }`**（应用自己的图标语言）。组件里的 SVG **必须显式写回尺寸**，否则会被压成 16px 且没有任何报错——脑形滑块踩过（2026-11-10）。同理，组件样式用 `.ge-` 之类的前缀，别用会被 `styles.css` 命中的裸类名。
- **工具链包管理**（`src/packs/`）是平台层，不属于领域层 MCP；其权限语义（`installPack` 允许、`removePack` 恒需审批）见 `docs/operations/toolchain-packs.md`。
