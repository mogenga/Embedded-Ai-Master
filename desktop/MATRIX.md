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
| `listSessions` | ✅ | ✅ | 标题取首条 user 事件（缓存，最多扫 30 条） |
| `getSettings` | ✅ | ✅ | 只读：UI 偏好 + provider 列表 |
| `setUiPreference` | ✅ | ✅ | 回显，localStorage 是事实源 |
| `setLocale` | ✅ | ✅ | |
| `setMode` | ✅ | ✅ | 映射内核四预设；运行中拒绝切换并说明原因 |
| `getUsage` | ✅ | ✅ | 汇总当前会话的 `usage` 事件 |
| `getSetupChecklist` | ✅ | ✅ | 只报真实检查项（providers、模型引用） |
| `listCommands` | ✅ | ✅ | 内核无斜杠命令，返回空列表 |
| `getTree` | ✅（空树） | ✅（空树） | 内核无文件树 API |
| `searchFiles` | ✅（空匹配） | ✅（空匹配） | 同上；不每键刷警告 |
| `searchSessions` | ✅（本地过滤） | ✅（本地过滤） | |
| `shutdown` | ✅ | — | 桌面宿主退出 |

### 已隐藏（前端不渲染入口，宿主/bridge 回显式 `notice`）

git（`gitStatus`/`gitCommit`）、PR（`prStatus`/`createPr`/`prRerun`/`prFixCi`）、终端（`terminalOpen`/`terminalRun`/`terminalInterrupt`/`terminalRestart`）、worktree（`worktreeStart`/`worktreeMerge`/`worktreeDiscard`/`worktreeDiff`）、packs（`getPacks`/`installPack`/…）、browser（`browserOpen`/`browserNavigate`/…）、skills / memory / instructions / hooks、subagents、goals、文件读写预览（`getFile`）、检查点（`getCheckpoints`/`restoreCheckpoint`/`restoreFile`）、产物（`getArtifacts`/`getArtifact`）、导出（`exportSession`）、会话分叉/删除/改名/搜索（`forkSession`/`deleteSession`/`sessionFlags`）、压缩（`compact`）、工作目录切换（`setCwd`）、板卡/串口控制（`getBoardState`/`serialOpen`/…）、模型与 effort 直设（`setModel`/`setEffort`）。

原因逐项登记在 `docs/deferred-issues.md` 的 D-166。

## 事件（宿主 → renderer）

| 内核事件 | 渲染器事件 |
|---|---|
| `assistant_delta` | `assistant_delta{text}`（流式片段，追加到当前气泡） |
| `assistant` | `assistant_start` → 补齐尚未流式过的部分 → `assistant_end`（不重复已流式的文本） |
| `tool_started` | `tool_start{name, summary, id}`（summary 取 assistant 事件的 `toolCalls` 参数） |
| `tool_result` | `tool_end{name, ok, summary, id}` +（成功时）`tool_output{name, content}`；未被 `tool_started` 覆盖时先补一行 `tool_start`（被拒的调用也要留痕） |
| `approval_request` | `permission_request{id, question, detail}` |
| `permission_decision` | `permission_closed{id}`（审批超时/中止时收起审批条）+ 拒绝时 `notice{warn}` |
| `device_status` | `board_state{state}`（供板卡面板与 chip） |
| `mcp_status` | `notice{dim\|warn}` |
| `usage` | `usage{usage}` |
| `status{done}` | `run_end` |
| `status{usage_missing\|device_status_invalid\|permissions_project_config_skipped}` | `notice` |
| `interrupted` | `notice{warn}` + `run_end` |
| `compaction` | `compacted`（summary）/ `notice`（failed） |
| `system` / `user` / `checkpoint` / `tool_call` | 不产出（用户消息在提交时已回显） || 未知类型 | `notice{warn}`（R3，不静默） |

宿主另发：`hello`、`ready`、`state`、`sessions`、`session_loaded`、`session_matches`、`commands`、`setup_checklist`、`settings`、`usage_summary`、`locale`、`ui_preference`、`tree`、`file_matches`、`notice`、`error`、`fatal`、`run_start`、`run_end`、`permission_closed`。

## 阶段 4 交互层

`docs/superpowers/specs/2026-10-20-m2-stage4-interaction-design.md` 的 §7（回放）、§8（导出）、§9（设备控制）原设计基于已删除的 `src/ui`，需按本前端重写。三项在当前内核上都是可做的：回放只需按事件下标截断后重建消息列表；导出读 `GET /api/sessions/:id`；设备控制把预置指令发进会话、仍经权限与审批。详见 D-166。
