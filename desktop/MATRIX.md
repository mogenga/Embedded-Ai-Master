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
| `loadSession` | ✅ | ✅ | 读整篇日志重建转录。桌面端另把**会话记录的工作目录采纳为当前 cwd**（`adoptSessionWorkdir`）：顶栏、文件树、`getFile` 边界三处一起跟随；目录已消失/不是目录/读不了时**不改 cwd** 并发 warn notice（「已不存在」与「无法访问」分开说）。浏览器形态只有 `currentCwd = header.workdir`，对已消失目录不校验（D-182 记录了这处两端不一致） |
| `listSessions` | ✅ | ✅ | 标题取首条 user 事件（缓存，最多扫 30 条）。支持 `includeArchived` / `cwd` / `limit`：归档行默认隐藏，`total` 是过滤后的总数（`slice` 前算），分页按 `updatedAt` 倒序稳定切片。`status` 筛选在桌面侧只认 `working`，浏览器侧回一条 dim notice 说明不可用 |
| `getSettings` | ✅ | ✅ | UI 偏好 + 三份配置文件（`mcpServers` / `permissions` / `run`）及其路径，外加模型服务的两种形状：`providers`（选单用的扁平列表）与 `providerConfig`（`providers.json` 本身，设置页整份写回）。`providersError` 在文件读坏时给出原因，页面据此说明为什么表单是空的 |
| `saveProviders` | ✅ | ✅ | 整份写 `providers.json`；桌面直写（写完从磁盘重新 `loadProviders`，不信任入参），浏览器走 `PUT /api/config`。模型引用失效时自动回退到首个可用引用并重建 runner |
| `testProvider` | ✅ | ✅ | 探测一个模型服务：桌面调内核 `probeProvider`（`dist/model/probe.js`，缺失时回「未编译，请先 build」而不是崩宿主），浏览器走 `POST /api/providers/test`。回 `provider_test{ok, baseUrl, models?, error?, code?, latencyMs?}`；`models` 拿不到时字段不存在。**不进命令队列**，探测可能占用 10s，不能把 abort 堵在后面 |
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
| `saveSettings` | ✅（窄） | ✅（窄） | 只接 `settings.locale`（en/zh），转调 `setLocale`；其他字段回 warn。不提供万能写配置入口——配置写入口是 `saveProviders`/`saveMcpServer`/`savePermissions`/`saveRunLimits` |
| `getTree` | ✅ | ✅ | 列一层子项（`listDirectory` / `GET /api/tree`）。边界＝已登记工作区 ∪ 会话目录 ∪ 会话工作目录，`realpath` 后判定；目录在前、按名排序、跳过符号链接、超 500 项截断。失败先发 warn notice **再**发空 `tree`——空树是释放 `pendingTreeTarget` 的信号，不是「目录是空的」 |
| `getKb` | ✅ | ✅ | 知识库定位 + 树（`dist/server/kb-locate.js` / `GET /api/kb`）。根解析优先级：`KB_ROOT` 环境变量 → `$HARNESS_HOME/mcp.json` 里任一 server 的 `env.KB_ROOT` → 仓库默认 `mcp-servers/kb/kb`；`source` 如实回报来自哪一级，`note` 说明选择理由。根不存在时**保留候选路径** + 空树 + `note`（「没找到」≠「是空的」）。`fileCount` 只数 `.md`；`truncated` 表示触顶（深度 8 / 条目 2000 / 文件数 20000），此时 `fileCount` 是「至少 N」而不是精确值。桌面端惰性 import：旧 `dist/` 缺该模块时回 warn「请先 npm run build」并回空 `kb`，不崩宿主 |
| `setWorkspace` | ✅ | ✅ | 发 `POST /api/workspace` 登记，再委托给 `setCwd` 的全部语义（运行中拒绝、仅新建会话生效）。登记是进程内的，重启失效 |
| `searchFiles` | ✅（空匹配） | ✅（空匹配） | 内核没有文件名搜索 API（无索引、无 walker）；不每键刷警告，理由写在宿主代码里 |
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

> 2026-10-21 第四轮（用户「模型配置没有、无法打开本地文件夹」）：新增 `saveProviders`（整份写 `providers.json`）、`setWorkspace`（登记目录后委托 `setCwd`）、真实 `getTree`（接 `listDirectory` / `GET /api/tree`）；`searchFiles` 仍是空匹配，原因改为写在代码里。设置页恢复「模型服务」页，`apiKeyEnv` 明确标注为环境变量名、未定价时成本显示「未知」。浏览器形态的 `pickDirectory` 不再静默返回 `null`，改为说明拿不到绝对路径并提示手输。

> 2026-10-21 第五轮（用户「模型配置为什么叫连接？而且也无法进行配置操作」）：两处独立缺陷。①**命名**——设置页沿用了移植前端的 `Connection`，而应用其他位置（宿主提示「设置 → 模型服务」、README、页面标题 `connEmptyTitle`）都叫「模型服务」；现统一为「模型服务 / Model services」，首启提示与 `openSetup` 文案一并改掉旧的「填 API 密钥」（密钥本就只存环境变量名）。内部 id `connection` 保留，它不出现在界面上。②**配置页在浏览器形态下是空的**——`bridge.emitSettings()` 从不发 `providerConfig`，`buildConnectionPage` 因此走 `connUnsupported` 分支直接返回，没有卡片、没有「添加」、没有「保存」；桌面宿主发这个字段，但 Electron 未安装，实际能跑的是浏览器形态。现由 `protocol.providersEvent()` 一次给出两种形状（扁平列表 + 文件本体），`modelsOf()` 把文件展开成 `provider/model` 选单条目；`refreshConfig` 与 `putConfig("providers")` 之后都广播 `models`，否则选单停在「正在加载模型…」而 `providers.json` 明明有模型。

> 2026-10-21 第六轮（用户「contextWindow和maxOutput直接删掉」「每百万Token价格直接删掉」「缺少测试连接」「选择本地文件夹应该在侧边栏也可进行」）：①`contextWindow`/`maxOutput` 不再由用户在表单里填，内核改用具名估算默认值（128000 / 4096）；表单保存时**旧值原样透传**，不因界面不显示就抹掉。②「每百万 token 价格」整区删除，旧 `pricePerMillion` 同样透传。③新增 `testProvider`（见上表）：设置页每张卡片一个「测试连接」按钮，15s 超时、按 `baseUrl` 匹配回包、页面重建时用 build 快照丢弃孤儿回包。④侧边栏新增工作区入口，显示当前文件夹名，与顶栏共用同一个 `chooseWorkspace()`——两条路径规则完全一致，没有复制一份。**接缝修复**：`app.js` 的 `handleEvent` 原本没有 `provider_test` 分支，事件会被静默丢弃、按钮只能靠 15s 超时以「没有响应」收场，已补上转发。

> 2026-10-22 第十三轮（用户「删除语言输入UI」「选择会话，上方的文件夹不会随会话所在文件夹变化」「会话操作与时间重合」「桌面宿主暂不支持该命令：rewindTo，无法回退」「表格、分割线 md 语法渲染有误」「会话我输入查找README.md，似乎并没有从项目文件夹开始找」「继续完善 Agentic Search」）：①**删除语音输入**——麦克风按钮、`setupVoice`/`stopVoice` 整块、录音动画与 `voiceStart`/`voiceStop` 文案、`#i-mic` 图标一并删除（用户确认「语言输入」指的是这个按钮，不是界面语言切换——后者保留）。②**`loadSession` 采纳会话目录**（见上表；根因 D-182）。③**会话行右边缘**——`.session-meta` 与 `.session-more` 原来同时钉在右边缘，悬停时 20px 的三点按钮正好压住日期；现在 `:hover` / `:focus-within` 时日期让位 `right: calc(9px + 20px + 6px)`，实测两矩形由相交 20px 变为留 6px 间隙（CDP `CSS.forcePseudoState` 强制真实 `:hover` 后量取，1280 / 900 两个视口一致）。④**删除「回退到这里」**——内核没有 rewind / 文件快照 / 检查点恢复能力，按 R3 删按钮而不是伪造成功。检查点面板整块仍是死代码（`getCheckpoints` 等无 handler，`history` 不在 `SUPPORTED_PANES`），未动，记录在案。⑤**Markdown 表格与分割线**——渲染器原本不产出 `<table>` 与 `<hr>`（`.markdown table` 的样式一直是死代码）；现支持 GFM 最小集（`|` 切列走状态机，`\|` 与 code-span 内的 `|` 不拆列，对齐三态，短行补齐/长行截断）与 `---` / `***` / `___` 分割线（段落中间不算，围栏内不算）。新增 `tests/desktop/markdown.test.js` 26 例。⑥**`glob` / `grep` 从项目根开始**——见 D-181：遍历改惰性 BFS、忽略清单扩到 24 项 + `*.egg-info`、截断时给可行动提示。⑦**Agentic Search**——按 D-179 的建议 ①②：`kb_grep` 增加 `fileCount`/`files` 命中文件分布，工具描述写死「命中只是候选，断言前必须 `kb_read` 原文确认」；KB 遍历加上限与忽略清单、`scanTruncated` 与 `truncated` 分开。**没有**设拒答阈值（D-179 ③ 未做，状态仍是未解决）。
