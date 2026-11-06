# 功能优化与新增 · 审计汇总（2026-11-06）

> 分支：`feat/feature-optimization`（基于 `main` @ `df1fb89`）
> 方法：5 路只读子代理分域审计（内核 / 桌面 / 领域 MCP / 文档与需求 / 工程与发布），
> 汇总时对冲突条目做定点复核；每条给出证据位置、价值、成本与优先级。
> 分域原始报告在 `.tmp/optimization-audit/*.md`（该目录被 gitignore，不进版本库）；
> 本文是自包含的汇总，不依赖原始报告。
>
> **状态更新（2026-11-06 稍晚）：批次 1 已实现**，详见 §10。OPT-05/06/07/08/09 均已落地并通过合并验证。

---

## 0. 摘要

- 共收敛 **44 项**：P0 9 项、P1 17 项、P2 18 项（含 1 项候选）。
- 其中 **3 项是审计过程中被证伪或降级的判断**（见 §9），已按实测证据改写。
- 最高密度的问题不是「缺功能」，而是 **R3 诚实性违约**与 **事实源漂移**：
  - 界面承诺的排队与附件并未发送（用户输入被丢弃）；
  - Keil 把 64 字节抽检说成整镜像校验、全 0 无警告、声明「自动备份」但无备份；
  - KB 语料引用的 49 处工具名在当前工具面不存在；
  - `desktop/MATRIX.md` 与 `docs/frontend-design.md` 在能力清单、事件模型上与实现相反；
  - `docs/deferred-issues.md` 至少 7 条描述的对象已不存在或已修复。
- 最高价值的**结构性缺口**：
  - 内核没有内置系统提示词（D-221），模型行为上限被锁死；
  - MCP 连接是「每条用户消息一份」而非会话级，正常关闭不回收进程树；
  - 没有整跑墙钟超时（D-189），无人值守没有保险丝；
  - 产物（artifacts）两侧都拿不到：模型 `read` 越界，界面无入口。

---

## 1. 口径与核实标记

- **已复核**：本次汇总时亲自读代码或跑单测确认。
- **未复核**：沿用分域审计证据，未逐条再读；位置与判断来自只读审计。
- 唯一运行的测试：`npx vitest run tests/desktop/serial-bridge.test.js`（30 例全绿），
  用于核验一条「假覆盖」指控，见 §9。
- 未运行构建、安装、e2e、联网或真实硬件操作。

---

## 2. P0（建议本轮先做）

| ID | 项 | 域 | 类型 | 证据 | 价值 | 成本 | 来源 |
|---|---|---|---|---|---|---|---|
| OPT-01 | 内置系统提示词：先落 `base` + `environment` 两节，投影期注入 | 内核 | 需求差距 | `src/index.ts:710-724` 生产路径从不设 `systemPrompt`；`docs/system-prompt-design.md` §8 已评审未实现 | 高 | M | D-221 / DOC-04 / DOC-11 |
| OPT-02 | 整跑墙钟超时 `deadlineMs`，落 `interrupted{reason:"deadline"}` | 内核 | 优化 | `src/loop/query.ts`、`src/index.ts`、`src/config/app-config.ts` 无 `deadline`/`AbortSignal.timeout`（grep 零命中）；`timeoutMs` 只到单次工具 | 高 | S | D-189 / DOC-12 |
| OPT-03 | MCP 连接改会话级持有；正常关闭回收进程树 | 内核 | 优化 | `src/index.ts:653-699` 在 `runSession` 内 `new McpManager` + `connectAll`；`desktop/host/host.js:1685` 每条 prompt 一次 `runner.start`；`src/mcp/manager.ts:772-786` close 只 `client.close` | 高 | M | 新（KERNEL-2） |
| OPT-04 | 产物全链路：模型可读 `artifacts/`，界面可打开产物面板 | 内核+桌面 | 新增 | `src/tools/pipeline.ts:266-272` 只回路径；`src/tools/path-safety.ts:55-72` 锁 `ctx.cwd`，而 `artifactDir` 在 `session.dir` 下；桌面 `openWorkbench("artifact")` 唯一调用点 `app.js:5488` 不可达 | 高 | S+S | KERNEL-7 / DESKTOP-5 |
| OPT-05 | KB 语料工具名对齐真实工具面 | 领域 | 优化 | `mcp-servers/kb/kb/debug/swd/no-connect.md:6` 写 `probe_attach`，实际工具名是 `attach`（`mcp-servers/probe/tools.ts:184`）；全库 36 文件 / 49 处同类引用 | 高 | M | MCP-1 |
| OPT-06 | Keil 证据诚实三连：抽检范围、全 0 警告、「自动备份」 | 领域 | 优化（R3） | `keilSession.ts:1791` `bytes = 64` 且 `tools.ts:1051` 不传参；`tools.ts:783-794` 无 `allZero`（probe 侧有：`openocd.ts:105-112`）；`declarations.ts:37` 称自动备份，备份函数无生产调用 | 高 | S-M | MCP-2/3/10 |
| OPT-07 | 停掉假排队与图片静默丢弃 | 桌面 | 优化（R3） | `i18n.js:460`「排队到本轮」、`app.js:554-562` 排队标签；`app.js:6097` 注释自承图片「stays in the strip and is not sent」 | 高 | S | D-186 / D-188 / DESKTOP-2 |
| OPT-08 | 设置页保存失败就地可见 | 桌面 | 优化（R3） | `desktop/host/host.js:3074` 等四个保存 handler 失败只发 `notice` 进转录；设置页是 `showModal()`，提示被遮住（`app.js:3759-3769`） | 高 | S | DESKTOP-1 |
| OPT-09 | 发布链路自洽：产物名从 `artifactName` 派生 + 构建前清理 `dist/` | 工程 | 优化 | `scripts/release.mjs:521` 拼 `Embedded AI Master Setup 0.1.5.exe`，盘上实际是 `Embedded-AI-Master-Setup-0.1.5.exe`（`desktop/package.json:65`）；`dist/server/{api,body,config-api,event-stream,http,serve}.js` 与 `dist-mcp/{cubeide,espidf,arduino}` 无对应源码 | 高 | S | ENG-2/3 / D-208 / D-212 |

---

## 3. P1（本轮或下一轮）

| ID | 项 | 域 | 证据 | 价值 | 成本 | 来源 |
|---|---|---|---|---|---|---|
| OPT-10 | 截断续写加次数上限，防网关坏时无限自续 | 内核 | `src/loop/query.ts:515-516`、`:611` 两处 `continue`；无续写计数 | 高 | S | KERNEL-4 |
| OPT-11 | 服务端 `context_length_exceeded` 的恢复路径 | 内核 | `src/model/openai.ts:644-670` 4xx → `ModelFatalError`；`grep context_length src/` 零命中 | 高 | M | KERNEL-5 |
| OPT-12 | 预算与占用率计入 tool schemas | 内核 | `src/model/count.ts:10-17` 只算 content + tool_calls；`src/tools/registry.ts:24` 每轮重建 schema | 高 | M | KERNEL-6 |
| OPT-13 | 长任务超时出口：MCP 120s 硬顶 vs Keil 10min 构建 | 内核+领域 | `src/mcp/manager.ts:340-343` `min(config.timeoutMs, 120s)`；`keilSession.ts:1642` 构建 10min | 高 | M | KERNEL-9 / MCP-6 |
| OPT-14 | CJK token 低估 + 压缩尾界绕过 TokenMeter | 内核 | `src/context/compact.ts:124-141` 不用 `meter.ratio`；`count.ts` UTF-16 ÷4 | 中高 | S | D-005 / D-093 |
| OPT-15 | 进程内事件通道替代 200ms 日志轮询 | 桌面 | `src/events/log-tail.ts:21` `DEFAULT_POLL_MS = 200`；`src/server/runner.ts:436-439` 丢弃 generator 事件 | 高 | M | D-134 / DESKTOP-3 |
| OPT-16 | 会话列表与标题读取改增量/懒读 | 桌面 | `host.js:1063-1094` 每回合同步 `readdirSync` + 逐目录读；`host.js:622-636` `titleOf` 读整份日志 | 高 | M | DESKTOP-6 |
| OPT-17 | 宿主/协议文案 i18n（先补高频 10 条） | 桌面 | `host.js` 约 106 条中文文案；`protocol.js:523/792/863`；宿主保存 `locale` 却不参与文案 | 高 | M/S | DESKTOP-4 |
| OPT-18 | `turn_progress` 接上工具名（当前零生产者） | 桌面 | `app.js:3884-3905` 唯一数据来源；全仓 grep 只命中渲染器 | 中高 | S | DESKTOP-7 |
| OPT-19 | evidence 展示与筛选出口 | 桌面 | `protocol.js:640-656` 未透传 `payload.evidence`；`pipeline.ts:495` 有生产者 | 中高 | M | DESKTOP-10 |
| OPT-20 | Renode 固件装载 + 最小故障注入（BR-2 验收③） | 领域 | `renode-backend.ts:208-209` 只 `mach create` + `LoadPlatformDescription`，全仓无 `LoadELF`；`BRD.md:145` | 高 | M | DOC-02 / MCP-5 |
| OPT-21 | Keil 工具面读写分拆（注解粒度） | 领域 | `keil/tools.ts:1341-1349` 整个 `keil_debug` 标 write + evidence；`src/permissions/policy.ts:88-93` | 高 | M | MCP-4 |
| OPT-22 | datasheet 三处静默截断披露 | 领域 | `service.ts:270` 忽略 `walkPdfFiles().truncated`；`:567-585` 超深目录不置位；`:317` hits 裁剪无标记 | 中 | S | MCP-9 |
| OPT-23 | KB 拒答扩展到 grep/glob 并重测拒答率 | 领域 | `service.ts:524-575` 拒答只在 lookup 首跳；D-159 基线 21/25 | 中高 | M | D-159 / D-179 / MCP-18 |
| OPT-24 | 合成语料 + 等价查询集进 CI | 工程 | `.gitignore:26-27`；`mcp-servers/kb/tests/regression.test.ts` 缺资产即整组 skip | 高 | M-L | D-158 / DOC-14 / ENG-13 |
| OPT-25 | 统一 `verify` 命令 + Windows job 补 typecheck | 工程 | `package.json:9-27` 五条命令靠手记；`.github/workflows/ci.yml:24-48` typecheck 只在 ubuntu | 中高 | S | ENG-7/8 |
| OPT-26 | 覆盖率纳入 `mcp-servers/**` | 工程 | `vitest.config.ts:17-24` 只统计 `src/**`；领域层 39 个测试文件零闸门 | 中高 | M | ENG-9 |
| OPT-27 | `maxCostUsd` 在 provider 未定价时显式披露或拒绝 | 内核 | `src/loop/breakers.ts:55` `costTracked=false`；`settings.js:1557-1587` 已删价格入口 | 中高 | S | KERNEL-8 |
| OPT-28 | 文档事实源对齐 | 文档 | `desktop/MATRIX.md` 命令表少于宿主 handlers（本次枚举宿主 61 个）；`docs/frontend-design.md` tab/隐藏能力/事件模型三处与实现相反；`m2-roadmap.md` 仍规划已删除的 HTTP 层；`deferred-issues.md` ≥7 条状态过时 | 高 | S | DOC-06/07/08/10、DESKTOP-12、MCP-11 |

---

## 4. P2（触发式或批量清理）

| ID | 项 | 域 | 证据 | 价值 | 成本 |
|---|---|---|---|---|---|
| OPT-29 | `shell` / `terminal_bg` 环境继承与 MCP 白名单不对称，至少披露 | 内核 | `src/tools/shell.ts:540-545`、`background.ts:445-451` 继承完整 `process.env`；`manager.ts:153-173` 有 13 项白名单 | 中 | M |
| OPT-30 | 重复小工具收敛（`isRecord` ×15、`errorMessage` ×11、`terminateTree` ×2 等） | 内核 | `session/persistence.ts:51`、`session/metadata.ts:34`、`tools/shell.ts:53` / `background.ts:115` | 中 | M |
| OPT-31 | 每条事件 fsync + 每轮多次全量投影的性能 | 内核 | `src/session/handle.ts:97-119`、`:211-243`；`query.ts:384/398`；`compact.ts:213/251/352` | 中 | M |
| OPT-32 | MCP server stderr 进环形缓冲并随错误披露 | 内核 | `src/mcp/manager.ts:514-519` 未传 stderr，SDK 默认 inherit | 中 | S |
| OPT-33 | MCP `instructions` 读取并注入系统提示 | 内核 | `grep getInstructions src/` 零命中；`p0-kernel-design.md:247` 要求 | 中 | S |
| OPT-34 | 并发只读分支收集 `pending`，补残留执行屏障 | 内核 | `src/tools/pipeline.ts:642-653` 对比串行 `:656-673` | 中 | S |
| OPT-35 | 死代码清理（`turn_end`、`exitReason:"consumer"`、`LoopCtx.systemPrompt` 等） | 内核 | `src/loop/events.ts:9`、`query.ts:57`、`model/protocol.ts:68`、`tools/registry.ts:68-71` | 低 | S |
| OPT-36 | 设置页侧栏 `role="tablist"` 补键盘模型 | 桌面 | `index.html:614`；`settings.js:5003-5018` 无方向键/roving tabindex | 中 | S |
| OPT-37 | 串口三个未接：500 行替换提示、运行中波特率、分叉 `atSeq` | 桌面 | `app.js:3093-3110`、`host.js:4175`；`host.js:4223-4232` vs `app.js:4580-4581`；`host.js:3600-3617` 只传 `id` | 中 | S-M |
| OPT-38 | 死 UI / 未挂载 builder 清理 | 桌面 | `index.html:456-589`；`app.js` 39 个无生产者事件分支；`settings.js` 六个 builder 未挂载 | 中 | M |
| OPT-39 | 设置页 Esc/遮罩丢未保存草稿 | 桌面 | `settings.js:1491/5338/5120`；`app.js:6225-6227` | 中 | S |
| OPT-40 | Electron `will-navigate` 守卫 + `openExternal` 白名单 | 桌面 | `desktop/main.js:311-334` 无守卫；`app.js:7788-7795` 只拦转录 | 中 | S |
| OPT-41 | 深色高亮行对比度 4.13:1 → 换 `--text-secondary` | 桌面 | `styles.css:21/28/5335-5338`；`docs/ui-polish-shared.md` 已标未修 | 中 | S |
| OPT-42 | 工程卫生：`.npmrc`、`.node-version`、dependabot、npm script 入口 | 工程 | `package-lock.json` 396 条 npmmirror；无 `.nvmrc`；无 `.github/dependabot.yml`；发布脚本无 npm 入口 | 中 | S |
| OPT-43 | 领域小项：错误码词表、`kb_search` count/truncated、serial 权限模板、embedded 模板错名 | 领域 | `keil/tools.ts:1318-1326`；`kb/service.ts:718-764`；`mcp-servers/serial/` 无模板；`embedded/permissions.example.json:37` `embed_pack` vs `embed_packs` | 中 | S |
| OPT-44 | BR-7 夜批管线（夹具格式 + 幂等 + 整跑超时 + exit code 表） | 领域 | `BRD.md:189-192`；仓库只有单场景 `scripts/diagnosis-e2e.mjs` | 中（M3 前） | L |

---

## 5. 建议批次

| 批次 | 内容 | 目标 | 验收 |
|---|---|---|---|
| 1. 信任修复 | OPT-05/06/07/08/09 | 界面与工具输出不再骗人；发布包等于源码 | 语料工具名回归断言全绿；Keil 三条输出如实；排队/附件入口删除并提示；`node scripts/release.mjs --check` 0 失败且产物名自洽 |
| 2. 内核边界 | OPT-01/02/03/10/11 | 无人值守有保险丝；MCP 生命周期符合设计 | 新会话首条消息带 environment 节；`deadlineMs` 触发 `interrupted{reason:"deadline"}`；连续截断 3 次自停；MCP 进程树在关闭后无残留 |
| 3. 能力补齐 | OPT-04/20/15/18/19 | 证据链可达、可筛选、可观察 | 模型能读回 artifact；Renode 能装 ELF 并注入一次故障；UI 无 200ms 延迟；进度行显示工具名 |

---

## 6. 已解决 / 已作废（不得再当新发现）

| 条目 | 结论 | 证据 |
|---|---|---|
| D-164 流式 | 已解决 | `src/loop/assistant-delta.ts`；`model/openai.ts` 请求 `stream:true` |
| D-165 / D-195 占用率 | 已解决 | `src/loop/query.ts` 发请求前测量（`measureRequestContext`） |
| D-183 最大轮数 | 已解决，默认不限 | `src/index.ts:727-742` 只在给定上限时传 |
| D-191 contextBreakdown | 已解决，有生产者 | `src/loop/query.ts:473` `buildContextBreakdown` |
| D-197 会话标题负缓存 | 已解决 | `host.js:1001-1022` 只缓存命中 |
| D-214 / D-215 启动恢复与错误分类 | 已解决 | `app.js:2991-3011`；`host.js:2072-2110` |
| D-143 全量重算转录 | 已失效 | 新前端为增量 DOM |
| D-210 serial 测试断言 | 已修复，文档未关闭 | `mcp-servers/serial/tests/embed-serial.test.ts:62` 已是六项 |
| D-202~D-205 | **已作废** | 对象随 `f03473b` 从 `mcp-servers/` 移除 |
| D-163 桌面未实机验证 | 状态待更新 | `README.md:771`：v0.1.5 已在干净机器完成安装验证（2026-11-03）；运行期验证仍需用户确认 |
| D-187 检查更新 | 已实现 | `desktop/preload.cjs:46`、`main.js:99` 有 `updateCheck` |

---

## 7. 判定不提升的既有条目

| 条目 | 判定 | 理由 |
|---|---|---|
| D-190 MCP HTTP transport | 不提升 | 五台领域 server 全是本地进程，触发条件未出现；引入 HTTP 生命周期与鉴权面，成本 M |
| D-109 in-process 工具 worker 隔离 | 不提升 | 内核当前无第三方 in-process 工具；领域能力一律走 MCP 独立进程（`m2-roadmap.md` §4） |
| D-091~D-098 压缩质量 | 不提升 | 缺真实长会话数据；桌面已能区分压缩成败（`protocol.js:830-866`） |
| D-083/087/088 shell 黑名单绕过 | 不提升 | 黑名单不是安全边界，由权限层兜底（`m2-roadmap.md` §4） |
| D-022 超时≠强制终止 | 拆解 | 串行已缓解；剩余归入 OPT-34（并发只读）与 OPT-13（长任务） |
| D-006 lint 等同 tsc | 已并入 OPT-25 | 用统一 `verify` 承载，不单独立项 |

---

## 8. 待验证（不得当作事实）

1. CJK 实际 token 倍数，以及 `TokenMeter` 的 `[0.5, 2]` 钳制是否够用（需真实 usage 对照）。
2. Renode/OpenOCD 孙进程在 Windows 上是否随父退出（SDK 只杀直接子进程是确定的；孤儿需实测）。
3. 网关是否真的会持续返回 `finish_reason:"length"` 且内容为空（代码路径可证，触发条件未实测）。
4. `context_length_exceeded` 的响应体形状（各家网关不一致，需 live 验证）。
5. 领域 server 是否愿意提供 MCP `instructions`（OPT-33 的收益取决于此）。
6. Keil 整镜像回读在 `0x2000` 字节单次上限下的分段耗时（OPT-06 的整镜像方案需实测）。

---

## 9. 审计过程中的纠偏记录

| 原判断 | 复核结果 | 处理 |
|---|---|---|
| `tests/desktop/serial-bridge.test.js` 的 `../../../../desktop/...` 多了一级，41 条断言「从未加载」 | **证伪**：单跑该文件 30 例全绿；另建探针证明 vitest 把越界遍历钳制在项目根，四级与五级都能解析到同一文件 | 降级为 P2 卫生项（路径写法不依赖钳制行为），不计入假覆盖 |
| 宿主 handlers 数量「63 个」 | 本次枚举为 **61 个**（`desktop/host/host.js:2814-4493`） | 文档采用「61（本次枚举）」并保留 MATRIX 未覆盖的结论 |
| `docs/deferred-issues.md` 未解决条目数 | 分域统计口径不一（98 已解决 / 68 未解决 / 40 无状态行等） | 本文不引用单一总数，只按条目逐一判定 |

---

## 10. 批次 1 落地记录（2026-11-06）

四个实现子代理并行，文件域互不重叠；合并后 `npm test` **3633 passed / 5 skipped**，`typecheck` 与 `check:js` 均通过。

| 项 | 落地内容 | 关键文件 | 回归 |
|---|---|---|---|
| OPT-05 | 39 个语料文件、约 100 处旧工具名对齐真实工具面；无等价工具的改写为「能力 + 现有替代路径」；`manifest.sha256` 按新内容重算（108/108） | `mcp-servers/kb/kb/**`、`mcp-servers/kb/tests/kb-tool-names.test.ts`（新增 3 例） | `mcp-servers/kb` 160 例全绿 |
| OPT-06 | `flash` 抽检范围进 `flashVerify.scope`（spot/full/none）、`count` 可请求更大窗口（上限 8192）；Keil `read` 补 `keil_all_zero_or_unmapped` 与 `memoryRead.reliable`；工程编辑前真备份 `.prometheus.bak`，失败即拒绝编辑 | `mcp-servers/keil/{keilSession,tools,keilProjectFile,declarations,actions}.ts`、三个新测试文件（17 例） | `mcp-servers/keil` 171 例全绿 |
| OPT-07 | 删除假排队全部 UI 与死代码；`state.busy` 时 `submit()`/`runSlashCommand()` 给 warn 并保留草稿；有附件时拒绝发送并保留附件条；删除 `imageOnlyPrompt` | `desktop/renderer/{app.js,i18n.js,index.html,styles.css}`、`tests/desktop/composer-copy.test.js`（新增 3 例） | `tests/desktop` 548 例全绿 |
| OPT-08 | 宿主新增 `settingsNotice(page, text)`，五个保存 handler 失败带 `domain:"settings"`；设置页 `settingsFailure` 纯函数路由 + 就地 `role="alert"` 错误条，不跨页串扰 | `desktop/host/host.js`、`desktop/renderer/settings.js`、`tests/desktop/settings-save-error.test.js`（新增 8 例） | 同上 |
| OPT-09 | 产物名从 `desktop/package.json` 的 `build.win.artifactName` 派生（0.1.5 → `Embedded-AI-Master-Setup-0.1.5.exe`）；新增 `scripts/clean.mjs` 单参数白名单清理，`build`/`build:mcp` 各清各的 | `scripts/release.mjs`、`scripts/clean.mjs`（新增）、`package.json`、`tests/clean-dist.test.ts`（新增 26 例） | `tests/release-check` + `tests/clean-dist` 98 例全绿；`dist`/`dist-mcp` 实测孤儿产物消失 |

**登记结果**（`docs/deferred-issues.md`）：
- 关闭：D-186、D-188（短期方案）、D-210、D-187、D-193（失效）、D-202~D-205（作废）、D-163（部分解决）。
- 新增：**D-222**（语料已改但 `latest.json` 仍是旧签名，下一次打包/OTA 必然失败）、**D-223**（Keil 整镜像回读未实现）、**D-224**（切换会话不清附件条，新会话发送被挡）。
- 同步：`docs/release.md` §2 补「两条 build 各清各的目录」、`desktop/MATRIX.md` 的 `prompt` / 五个保存命令 / `device_status` / `notice` 路由。

**未做**（仍属批次 2/3 或需用户决定）：
- 真正的渲染器队列（D-186 建议 ②）、内核多模态图片输入（D-188 长期方案）。
- `_inbox.md` 的 13 处旧工具名与两处 front matter 触发词：按「本地沉淀、不参与检索」保留。

**语料 OTA（D-222）已闭环（2026-11-06 稍晚）**：`corpusVersion=2` 已签名并上传，桶上清单与本地产物逐字节相同，108/108 文件 sha256 在桶上实测匹配；`package-prepare` 不带 `--manifest` 已能端到端装配 v2 随包语料（109 文件）。详见 `docs/deferred-issues.md` D-222 状态段。

---

## 11. OPT-20 落地记录（2026-11-06）

**固件装载**：新增 `renode_load`（`mcp-servers/probe/tools.ts`），后端 `RenodeBackend.loadFirmware`（`renode-backend.ts`）。
- 实发 `sysbus LoadELF @<绝对路径>`；只接受绝对路径、必须存在且为普通文件（`stat().isFile()`）。
- 路径按 monitor 的 `path` 类型转换：Windows 反斜杠改成正斜杠、空格转义为 `\ `（Renode 文档 `monitor-syntax.md` 的 path 类型只文档化了这一种写法）。控制字符、引号、反引号、`#` 直接拒绝，避免路径被解析成额外命令。
- 标 `destructiveHint`：装载会覆盖目标内存。返回 `declaration` + 加载的文件名/大小 + monitor 原文；monitor 输出为空时附 `renode_load_no_monitor_output` 警告，不把静默当成功；输出含加载失败措辞时抛 `backend_error`。
- 仅当本后端确实 `resume` 过（`cpu === "running"`）时先发 `pause`；attach 后的机器本来就未启动，没有依赖「pause 在未启动时是否幂等」。
- OpenOCD 后端的 `loadFirmware` 显式 `not_supported`（真硬件烧录走 Keil），不发任何命令。

**最小故障注入**：不新增工具。`mem_write` 已经是逐字节写 + 回读校验 + `declaration`（`renode-backend.ts` 的 `writeMemory`），足以表达位翻转：`mem_read` 读字节 → 与 `1 << bit` 异或 → `mem_write` 写回。README「探针」一节给出可直接照做的参数示例；探针权限模板新增 `renode_load` 的目录 glob 规则示例。

**待真机验证**（代码里没有臆造语法，按 KB 语料与官方文档实现）：Renode 1.16 上 `sysbus LoadELF` 的成功/失败输出文案未实测，`LOAD_FAILURE_PATTERN` 是保守措辞匹配；`pause` 在已暂停机器上的行为也未实测（当前实现只在 running 时发）。`npm run probe:e2e` 未在本轮执行（需要真实 Renode 与构建产物）。
