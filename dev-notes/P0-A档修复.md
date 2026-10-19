# P0 A 档修复

## 2026-10-19 · 登记、标注与 A 档修复（fix/p0-a-tier）

- **用户关键原话**："登记并标注，然后修复A档（开fix分支），不准提交不准推送"。
- **分支与状态**：从 `feat/p0`（`df62151`）创建 `fix/p0-a-tier`；全部改动停留在工作区，**未提交、未推送**；未使用 worktree、未执行 `npm install`、未派生 agent、未真实执行危险命令。
- **登记与标注**：
  - `docs/deferred-issues.md` 新增 D-105（项目级 MCP 配置自动执行无信任门槛）、D-106（连接错误重试可能重复执行破坏性工具）、D-107（`listTools()` 无显式超时）、D-108（MCP content/schema 无大小上限）。
  - D-043 标注已解决（维度4 Task5 起 `runCwd = opts.cwd ?? process.cwd()` 同时用于 `header.workdir` 与 `LoopCtx.cwd`，resume 采用 `opts.cwd ?? header.workdir ?? process.cwd()`）。
  - A 档对应条目更新状态：D-022/D-099 标“已缓解”，D-031/D-032/D-067/D-075/D-102/D-105~D-108 标“已解决”；变更记录补一行。
- **A 档修复**：
  - **D-022**：`executeBatch` 串行分支在超时/取消后等待残留执行 `settleGraceMs`（默认 2s）；仍未结束则不再启动后续调用，剩余结果标 `tool_skipped_after_timeout`。MCP 超时/取消/破坏性断线后终止 transport、断开 client，下一次调用重连；pipeline 不再让同批后续写调用与残留执行重叠（MCP 终止失败时旧进程仍可能短暂残留）。
  - **D-031**：`openai` 响应体改为流式读取并累计字节，`maxResponseBytes` 默认 8 MiB；超限取消 reader 并抛 `invalid_response`，支持 `Content-Length` 预检；非 2xx 错误体也只读前 512 字节并取消流。
  - **D-032**：`requestTimeoutMs` 默认 120s；每次 attempt 独立 AbortController，超时抛可重试的 `RequestTimeoutError`；调用方 abort 仍透传 AbortError。
  - **D-067**：`/api/*` 校验 `Host`/`Origin` 必须为 loopback 且端口等于监听端口；跨源返回 403 `forbidden_host`/`forbidden_origin`，补 raw Host/Origin 测试。
  - **D-075**：shell abort 后 1s 升级 `SIGKILL`/再次 `taskkill`，3s 未确认则兜底返回 `shell_aborted`，`detail.abortEscalated`/`terminateFailed`，Promise 必定 settle。
  - **D-099**：摘要后仍超阈值时执行 emergency microcompact（忽略 `keepRecentTurns`、仍排除 evidence）；降回阈值内不再落 `still_over_budget`，evidence-only 超窗仍只能记录失败。
  - **D-102**：MCP 子进程默认只继承 env 白名单；新增 `inheritEnv`/`envAllowlist` 配置，`config.env` 始终覆盖。
  - **D-105**：项目级 `.harness/mcp.json` 默认不加载；需 `mcp.trustProjectConfig:true` 或显式 `projectConfigPath`，跳过时记 `mcp_project_config_skipped`。
  - **D-106**：`destructiveHint:true` 的 MCP 工具连接中断后不再自动重试，返回 `mcp_uncertain`；非破坏性工具保持一次重连。
  - **D-107**：`client.listTools()` 传入 `connectTimeoutMs`（默认 15s），连接与工具发现都有界。
  - **D-108**：MCP content 合计上限 1 MiB（截断并标记、`detail.truncated`）；`inputSchema` >64 KiB 跳过、`description` >4096 字符截断。
- **验证（最终工作区）**：`npm test` / `npm run coverage` 44 files / **1227 passed + 1 skipped**，coverage exit 0，statements **88.78%**、branches **84.12%**、functions **91.59%**、lines **90.65%**；`npm run lint`、`npm run typecheck`、`npm run build` 全部 exit 0；`npm run verify:ui` V1-V14 **14/14 PASS** + V0 1/1；`git diff --check` exit 0。
- **翻车与返工**：① 覆盖率复跑时 MCP abort 断言 `Date.now()-started < 600ms` 失败（671ms），原因是 Windows `spawnSync(taskkill)` 阻塞；改为异步 `spawn(taskkill)` 后恢复，同时保留 `client.close()` 异步清理。② 引入 emergency microcompact 后，3 个既有 compact 测试场景预期变化（近期非 evidence 大结果不再保留/会追加第二次 microcompact），按新语义改为 evidence 场景与“elided 集合不重复”断言。③ `readJsonBody` 替换 `response.json()` 后，两个既有测试的 mock/断言需同步（AbortError 从 `text()` 抛、signal 联动而非同一对象、流式 cancel 夹具改为持续产出）。
- **残余**：D-022 仍不保证不响应 signal 的工具停止（D-071/D-077）；D-099 evidence-only 超窗仍无法自动降级；D-102 放开 `inheritEnv` 后敏感变量风险回到配置方；未运行 live 网关与真实 MCP server。

## 2026-10-19 · B 档（内置工具取消、MCP 终止屏障、evidence+artifact 降级）

- **用户关键原话**："继续"（继续修复 A 档后列出的可修残余风险）。
- **关键产出**：
  - **D-071/D-077 已解决**：`fs.read` 把 signal 传给 `createReadStream` 并在读循环检查；`fs.write/edit` 在操作前后检查并把 signal 传给 `readFile`/`writeFile`，取消返回 `aborted`（write/edit 提示可能留下部分文件）。`walkFiles` 新增 signal 参数并在每个条目/递归/访问前 `throwIfAborted`；`glob`/`grep` 捕获 AbortError 返回 `aborted`，`grep` 在文件读取前与每 256 行检查。补 fs/glob/grep 取消测试与 `walkFiles` 遍历中 abort 测试。
  - **MCP 终止屏障**：`beginDispose` 终止 transport 后轮询 PID（`terminateTimeoutMs` 默认 2s）；确认退出后才允许重连；未确认时 `state.uncertain=true`，后续调用直接返回 `mcp_uncertain` 且不重连。新增“终止未确认拒绝重连”测试（spy `process.kill(pid,0)` 模拟进程仍存活）。
  - **D-099 进一步缓解**：emergency 阶段允许 `artifactPath` 存在的 evidence 降级为 `[tool result elided; full output at <path>]`；无 artifact 的 evidence 仍保留。`buildMessages` 的 evidence 投影条件同步允许 artifact 引用；新增 evidence+artifact 降级测试。
  - 文档同步：README、`docs/deferred-issues.md`、dim3/dim4/dim5 spec、`p0-kernel-design.md`。
- **验证（最终工作区）**：`npm test` / `npm run coverage` 44 files / **1235 passed + 1 skipped**，coverage exit 0，statements **88.4%**、branches **83.56%**、functions **91.25%**、lines **90.38%**；`npm run lint`、`npm run typecheck`、`npm run build` 全部 exit 0。
- **被拒绝或纠偏的内容**：未使用 worktree、未 `npm install`、未派生 agent、未真实执行危险命令；未提交、未推送；未把无 artifact 的 evidence 强制丢弃（保留设计约束）；未为第三方 in-process 工具引入 worker 隔离（更大架构改动，留 P1）。
- **翻车与返工**：`build.test.ts` 原“evidence + artifact 保留原文”用例与新语义冲突，改为断言 artifact 引用；MCP manager 的 `terminateAndWait` 因 `transport.pid` 可能为 `null` 触发 typecheck，已归一为 `undefined`。其余为预期 RED→GREEN。
- **残余**：自定义/第三方 in-process 工具故意忽略 signal 仍无法强制终止（需 worker/进程隔离）；无 artifact 的 evidence-only 超窗仍只能记录 `still_over_budget`/`no_progress`；`inheritEnv:true` 的敏感变量暴露是显式配置取舍；live 网关/真实 MCP/真机仍需外部环境验证。

## 未完成清单（已落 deferred）

截至 2026-10-19，A/B 档未覆盖、已登记为正式 deferred 项：

- **D-109**：自定义/第三方 in-process 工具缺少 worker/进程隔离；pipeline 屏障只防止后续写调用重叠，不能强制停止忽略 signal 的工具。P1 架构项。
- **D-110**：无 `artifactPath` 的 evidence 超窗仍无法 emergency 降级；需要强制落盘 + `CompactionPayload.microcompact.artifactPaths`（seq→path）投影扩展。
- **D-111**：外部环境验证缺口——live 网关三 env、真实第三方 MCP server、真机探针/串口、Windows 权限/PID 回收下的终止失败路径，均未在本地验证。
- **非未完成项**：`D-102` 的 `inheritEnv:true` 是显式放宽配置的设计取舍，默认白名单已安全；不计划移除该逃生口，除非产品决定只保留 `envAllowlist`。

以上均未在 `fix/p0-a-tier` 工作区实现；当前 35 项改动仅为 A/B 档修复与留痕，未提交、未推送。
