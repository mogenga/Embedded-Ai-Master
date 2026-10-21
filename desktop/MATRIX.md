# 前端能力矩阵

本文件是 `desktop/` 前端与当前内核之间的契约表：哪些命令/事件已接通、哪些被隐藏、为什么。

- **协议层**：`desktop/renderer/protocol.js` —— 内核 `SessionEvent` → 渲染器事件的纯函数映射，桌面宿主与浏览器 bridge 共用。
- **桌面宿主**：`desktop/host/host.js` —— NDJSON 分发器，复用 `dist/` 下的内核模块。
- **浏览器 bridge**：`desktop/renderer/bridge.js` —— 没有 preload 时注入 `window.prometheus`，把命令映射到 `/api/*`。

## 命令（renderer → 宿主）

| 命令 | 桌面 | 浏览器 | 说明 |
|---|---|---|---|
| `init` | ✅ | —（bridge 自启动） | 握手：providers、模型列表、runner、事件源 |
| `prompt` | ✅ | ✅ | 走 `runner.start`，权限与审批在内核 |
| `abort` | ✅ | ✅ | 桌面走 `runner.abort`；浏览器走 `POST /api/abort` |
| `permission` | ✅ | ✅ | `yes`/`no` → allow/deny；`always` 降级为本次 allow 并显式提示 |
| `newSession` | ✅ | ✅ | 清空转录，会话 id 留到首个 prompt 才产生 |
| `loadSession` | ✅ | ✅ | 读整篇日志重建转录 |
| `listSessions` | ✅ | ✅ | 标题取首条 user 事件（缓存，最多扫 30 条）。支持 `includeArchived` / `cwd` / `limit`：归档行默认隐藏，`total` 是过滤后的总数（`slice` 前算），分页按 `updatedAt` 倒序稳定切片。`status` 筛选在桌面侧只认 `working`，浏览器侧回一条 dim notice 说明不可用 |
| `getSettings` | ✅ | ✅ | UI 偏好 + provider 列表 + 三份配置文件（`mcpServers` / `permissions` / `run`）及其路径 |
| `saveMcpServer` | ✅ | ✅ | 合并同名项后整份写 `mcp.json`；桌面直写，浏览器走 `PUT /api/config` |
| `removeMcpServer` | ✅ | ✅ | 按 name 删除 |
| `savePermissions` | ✅ | ✅ | 整份写 `permissions.json`（`preset` / `approvalTimeoutMs` / `rules`） |
| `saveRunLimits` | ✅ | ✅ | 整份写 `run.json`（`maxTurns` / `maxCostUsd` / `timeoutMs` / `systemPrompt`），下一回合生效 |
| `sessionFlags` | ✅ | ✅ | 改名/置顶/归档，写旁挂 `meta.json`（header 校验会丢弃未知字段） |
| `deleteSession` | ✅ | ✅ | 删除会话目录；锁被占用时 409。拒绝删除当前打开的会话 |
| `forkSession` | ✅ | ✅ | `forkSession(dir, atSeq)`，分叉后直接打开新会话 |
| `exportSession` | ✅ | ✅ | 读日志渲染 Markdown；桌面走 `saveFile`，浏览器走下载 |
| `revealArtifact` | ✅（preload） | ✅（notice） | 桌面经 preload 的 `revealArtifact` 在文件管理器中选中；浏览器只能回一条含路径的 notice |
| `setUiPreference` | ✅ | ✅ | 回显，localStorage 是事实源 |
| `setLocale` | ✅ | ✅ | |
| `setMode` | ✅ | ✅ | 映射内核四预设；运行中拒绝切换并说明原因。浏览器形态随 `POST /api/actions` 的 `mode` 字段下发给内核，不再只是改本地状态 |
| `setModel` | ✅ | — | 仅接受 `providers.json` 中存在的引用；只对新建会话生效。浏览器形态改不了服务端配置，回显式 `notice` |
| `refreshModels` | ✅ | — | 重读 `providers.json` 并广播 `models`；读取失败保留原列表 |
| `setCwd` | ✅（需先新建会话） | — | 仅在无会话时切换；内核把 workdir 固定在 header 里，不能中途改 |
| `getUsage` | ✅ | ✅ | 汇总当前会话的 `usage` 事件 |
| `getSetupChecklist` | ✅ | ✅ | 只报真实检查项（providers、模型引用） |
| `listCommands` | ✅ | ✅ | 内核无斜杠命令，返回空列表 |
| `getFile` | ✅ | ✅ | 只读预览一个文本文件，256 KiB 上限；越界（工作目录与会话目录之外）、符号链接、目录一律拒绝并说明原因；含 NUL 字节按二进制处理且不给文本预览 |
| `getArtifacts` | ✅ | ✅ | 列当前会话 `artifacts/` 下的普通文件（跳过目录与符号链接）；目录不存在或没有打开的会话 → 空列表 |
| `getArtifact` | ✅ | ✅ | 读一个产物文件；只允许当前会话 artifacts 目录内的路径 |
| `setEffort` | ✅（如实拒绝） | ✅（如实拒绝） | 内核模型适配层不发 reasoning effort 参数。回 warn notice，**不发 `state`** —— 假装生效比不支持更糟 |
| `saveSettings` | ✅（窄） | ✅（窄） | 只接 `settings.locale`（en/zh），转调 `setLocale`；其他字段回 warn。不提供万能写配置入口——配置写入口是 `saveMcpServer`/`savePermissions`/`saveRunLimits` |
| `getTree` | ✅（空树） | ✅（空树） | 内核无文件树 API |
| `searchFiles` | ✅（空匹配） | ✅（空匹配） | 同上；不每键刷警告 |
| `searchSessions` | ✅ | ✅（已加载的列表） | 桌面按标题/工作目录/id 搜索；浏览器只过滤已加载的行（HTTP API 无查询参数） |
| `shutdown` | ✅ | — | 桌面宿主退出 |

### 已隐藏（前端不渲染入口，宿主/bridge 回显式 `notice`）

git（`gitStatus`/`gitCommit`）、PR（`prStatus`/`createPr`/`prRerun`/`prFixCi`）、终端（`terminalOpen`/`terminalRun`/`terminalInterrupt`/`terminalRestart`）、worktree（`worktreeStart`/`worktreeMerge`/`worktreeDiscard`/`worktreeDiff`）、packs（`getPacks`/`installPack`/…）、browser（`browserOpen`/`browserNavigate`/…）、skills / memory / instructions / hooks、subagents、goals、检查点（`getCheckpoints`/`restoreCheckpoint`/`restoreFile`）、压缩（`compact`）、板卡/串口控制（`getBoardState`/`serialOpen`/…）。

串口监视器同样隐藏：`serialOpen` / `serialStatus` / `serialRead` 没有宿主实现，内核只把串口能力暴露为模型调用的 MCP 工具，探针的串口状态改在板卡面板「设备」段显示。工作台有 Board / File / Artifact 三个 tab——后两个由动作打开（点工具行、点产物），不在 tab 条上常驻。

原因逐项登记在 `docs/deferred-issues.md` 的 D-166 与 D-169。

> 2026-10-21 复核：`setModel` / `refreshModels` / `setCwd` 已从隐藏清单移出（见上表），`device_status` 改为独立事件。同日第三轮：`getFile`/`getArtifacts`/`getArtifact` 接上（只读预览 + 产物列表，桌面临时目录内、浏览器走 `GET /api/file` 与 `GET /api/sessions/:id/artifacts`），`setEffort` 改为如实拒绝，`listSessions` 支持归档/工作目录/分页筛选，工具注解随 `tool_started` 下发。同日第二轮：MCP 配置页与权限/运行参数页接回 `PUT /api/config`，会话改名/置顶/归档/删除/分叉/导出接上内核的 `meta.json` 与 `session-admin`；仍隐藏的是内核本身就没有的能力（git/终端/文件树/检查点/产物列表）与只存在于旧前端的 UI（分屏、新窗口——本外壳单实例单窗口）。

## 事件（宿主 → renderer）

| 内核事件 | 渲染器事件 |
|---|---|
| `assistant_delta` | `assistant_delta{text}`（流式片段，追加到当前气泡） |
| `assistant` | `assistant_start` → 补齐尚未流式过的部分 → `assistant_end`（不重复已流式的文本） |
| `tool_started` | `tool_start{name, summary, id, annotations?}`（summary 取 assistant 事件的 `toolCalls` 参数）。`annotations` 只带值为 `true` 的 `readOnly`/`destructive`/`evidence`；缺省即「未声明」，渲染器据此不画徽标——全 false 与不存在不能混为一谈 |
| `tool_result` | `tool_end{name, ok, summary, id}` +（成功时）`tool_output{name, content, artifactPath?}`；未被 `tool_started` 覆盖时先补一行 `tool_start`（被拒的调用也要留痕）。`artifactPath` 存在时输出块底部出现「打开产物」按钮 |
| `approval_request` | `permission_request{id, question, detail}` |
| `permission_decision` | `permission_closed{id}`（审批超时/中止时收起审批条）+ 拒绝时 `notice{warn}` |
| `device_status` | `device_status{device, server, tool}`（板卡面板的「设备」段与 chip；不再伪装成 `board_state`，两者字段集不同） |
| `mcp_status` | `notice{dim\|warn}` |
| `usage` | `usage{usage, context?, costUsd?}`——`context` 是上下文占用（tokens/percent/window），`costUsd` 是会话累计成本；两者缺失时字段不存在，渲染器据此隐藏而不是显示 0 |
| `status{done}` | `run_end` |
| `status{usage_missing\|device_status_invalid\|permissions_project_config_skipped}` | `notice` |
| `interrupted` | `notice{warn}` + `run_end` |
| `compaction` | `compacted`（summary）/ `notice`（failed） |
| `system` / `user` / `checkpoint` / `tool_call` | 不产出（用户消息在提交时已回显） || 未知类型 | `notice{warn}`（R3，不静默） |

宿主另发：`hello`、`ready`、`state`、`sessions`、`session_loaded`、`session_matches`、`commands`、`setup_checklist`、`settings`、`usage_summary`、`models`、`locale`、`ui_preference`、`tree`、`file_matches`、`export_ready`、`notice`、`error`、`fatal`、`run_start`、`run_end`、`permission_closed`。

## 阶段 4 交互层

`docs/superpowers/specs/2026-10-20-m2-stage4-interaction-design.md` 的 §7（回放）、§8（导出）、§9（设备控制）原设计基于已删除的 `src/ui`，需按本前端重写。三项在当前内核上都是可做的：回放只需按事件下标截断后重建消息列表；导出读 `GET /api/sessions/:id`；设备控制把预置指令发进会话、仍经权限与审批。详见 D-166。
