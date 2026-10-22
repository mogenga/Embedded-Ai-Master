# AGENTS.md — Embedded-Ai-Master

面向嵌入式调试场景的 agent 工具。当前处于 **M2 阶段 3 已合并**：P0 内核（`src/`）与桌面前端（`desktop/`）已实现，测试在 `tests/`（`tests/desktop` 为协议层与宿主），构建与脚本配置见 `package.json` / `tsconfig*.json` / `vitest.config.ts`；剩余修复与外部验证项见 `docs/deferred-issues.md`。技术栈与命令以 `package.json` 与 `README.md` 为准，不要臆造。

## 事实源（先读这些，别猜）
- `docs/BRD.md` — 业务需求（领域层 BR-xx / 平台层 PLAT-xx）、硬性规则 R1-R9、路线图 M1-M4。
- `docs/p0-kernel-design.md` — 当前 M1 设计稿（harness 内核六项：主循环 / 模型接入 / 上下文 / 工具系统 / MCP 客户端 / 会话）。
- `docs/framework-architecture-inventory.md` — 框架能力清单 24 项 + 10 个决策点。
- `docs/harness-comparison.md` — Claude Code / dsh / Codex / Gemini CLI / opencode / goose / pi 横向调研。
- `docs/rag-vs-agentic-search-todo.md` — 待办对照实验（决策点 #2 的判据）。
- `docs/ontology-scope-note.md` — Ontology 暂缓纳入检索比对的**范围决策**与重启条件（2026-10-19）。它不是待办缺陷，不登记进 `deferred-issues.md`；未经重启条件触发，不要主动把它并入方案比对。
- `docs/m2-roadmap.md` — M2 路线图（决策点 #5/#9 已关闭项、M2 任务分期）。
- `docs/frontend-design.md` — 前端设计规范（布局、令牌、组件、验收口径）。**v2.0 起以 `desktop/renderer/` 的实现为准**；v1.4 及更早基于已删除的 Preact 工作台，仅历史留档。
- `desktop/MATRIX.md` — 前端命令/事件能力矩阵（已支持 / 隐藏 / 原因），是前端能力边界的事实源。
- `docs/deferred-issues.md` — 已知但暂不修的缺陷与覆盖缺口，含升级触发条件；改动前先查，避免重复发现。

架构为两层：**平台层**（领域无关 harness，模型接入/上下文/工具/会话/权限）与**领域层**（嵌入式调试能力，经 MCP / 插件挂载）。内核代码不得含领域逻辑——嵌入式取证一律走 MCP，不进内核。

## 常用命令（以 `package.json` 与 `README.md` 为准）

- 测试与构建：`npm test`（vitest run，不触网）、`npm run coverage`（lines 阈值 85%）、`npm run typecheck`、`npm run lint`（当前等同 `tsc --noEmit`，见 D-006）、`npm run build`。
- 前端：`npm run test:desktop`（协议层与桌面宿主测试）；桌面形态需用户先执行 `npm --prefix desktop install`，再 `npm --prefix desktop run desktop`。
- live 测试默认跳过；开启方式见 README「live 测试」。
- **依赖安装禁令同样适用于此**：只输出命令给用户，不代为执行（见下文）。

## 硬约束（不可违反）
1. **技术栈已定案（2026-10-16，决策点 #1 关闭），完整约束如下**：
   - **语言与运行时**：TypeScript + Node 24（ESM-only，禁止 CommonJS 混用）。本机已具备 Node 24.14.1，package.json 用 `"engines": { "node": ">=24" }` 声明。
   - **协议层（可复用，不得自研）**：MCP 官方 TS SDK v2——`@modelcontextprotocol/client`（harness 侧客户端）、`@modelcontextprotocol/server`（MCP server 入口，测试夹具用）、`@modelcontextprotocol/server/stdio`（stdio 传输）；工具与消息 schema 用 **Zod v4**（MCP SDK v2 走 Standard Schema，Zod v4 为首选接线）。
   - **内核（必须自研，禁止整体引入现成 harness）**：主循环 / 会话 / 工具系统 / 上下文管理 / MCP 生命周期。可借鉴 Claude Code / dsh / opencode 源码语义，但不得 vendor 任何现成 harness。
   - **模型适配层（必须自研）**：极简适配器，仅 `complete` / `countTokens` 两方法；P0 只实现 OpenAI 兼容（`/v1/chat/completions`）；可借鉴 dsh llm-pi-ai 语法，但不整体引 pi-ai。
   - **测试**：vitest。
   - **前端（2026-10-20 移植定案）**：纯 ES 模块，**无框架、无打包器、无构建步骤**——`desktop/renderer/` 直接被 Electron 加载，渲染层是 JavaScript（内核才是 TypeScript）。不要引入 Vite/Preact/React 等构建链或 UI 框架。桌面形态经 `desktop/host/host.js`（NDJSON over stdio）接内核，宿主与渲染器共用 `desktop/renderer/protocol.js` 这一层纯映射。内核不支持的能力**隐藏入口**而不是伪造（宿主回显式 `notice`，R3）。
   - **查证规则**：凡涉及库/框架用法（含上列已定案库的 API 细节），**必须先经 Context7 MCP 查证**（已配置：`.codeartsdoer/mcp/mcp_settings.json` → context7）核实版本、运行时要求与用法后再引入；禁止凭记忆臆造任何 API、版本号或配置项。
2. 安全边界（散见于 BRD §8）：R1 LLM 永不直接控制仪器；R2 探针写内存/复位前先声明；R3 工具必须诚实（读失败显式报错、全 0 不得解码为"无故障"）。

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

## 实现期注意事项

- **先查 `docs/deferred-issues.md` 再动手**：已知缺陷有编号（D-xxx），修复后标注「已解决」并保留条目，不要删除。
- **`npm run lint` 等同 `tsc --noEmit`**（D-006），不要把它当作独立静态检查的证据。
- **测试不得触网**：live 测试由 `HARNESS_COMPAT_LIVE=1` 显式开启；默认 `npm test` 必须离线通过。
- **工具必须诚实（R3）**：新增工具或错误路径时，失败要显式返回错误码，不得静默吞掉或把失败伪装成成功；Web 端也不得伪造提交成功。
- **超时/取消的语义**：新增工具须响应 `AbortSignal`；超时后不得让残留调用与后续调用重叠（D-022 已缓解，新增写工具前重读）。
- **内核不含领域逻辑**：探针 / 串口 / KB 等嵌入式能力一律经 MCP 挂载；`src/` 只放平台层能力。
