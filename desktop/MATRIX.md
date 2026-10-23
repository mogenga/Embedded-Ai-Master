# 前端能力矩阵

本文件是 `desktop/` 前端与当前内核之间的契约表：哪些命令/事件已接通、哪些被隐藏、为什么。

> **2026-10-22 起只保留桌面形态，浏览器 bridge 已删除。** 下表原先的「浏览器」一列随之移除；文中提到浏览器形态的补充说明保留为历史记录。

- **协议层**：`desktop/renderer/protocol.js` —— 内核 `SessionEvent` → 渲染器事件的纯函数映射，由桌面宿主与渲染器共用。
- **桌面宿主**：`desktop/host/host.js` —— NDJSON 分发器，复用 `dist/` 下的内核模块。
- **渲染器**：`desktop/renderer/app.js` —— 只跑在 Electron 里，`window.prometheus` 由 `desktop/preload.cjs` 注入。

## 命令（renderer → 宿主）

| 命令 | 说明 |
|---|---|
| `init` | 握手：providers、模型列表、runner、事件源 |
| `prompt` | 走 `runner.start`，权限与审批在内核 |
| `abort` | 走 `runner.abort` |
| `permission` | `yes`/`no` → allow/deny；`always` 降级为本次 allow 并显式提示 |
| `newSession` | 清空转录，会话 id 留到首个 prompt 才产生 |
| `loadSession` | 读整篇日志重建转录，并把**会话记录的工作目录采纳为当前 cwd**（`adoptSessionWorkdir`）：顶栏、文件树、`getFile` 边界三处一起跟随；目录已消失/不是目录/读不了时**不改 cwd** 并发 warn notice（「已不存在」与「无法访问」分开说） |
| `listSessions` | 标题取首条 user 事件（缓存，最多扫 30 条）。支持 `includeArchived` / `cwd` / `limit`：归档行默认隐藏，`total` 是过滤后的总数（`slice` 前算），分页按 `updatedAt` 倒序稳定切片。`status` 筛选只认 `working` |
| `getSettings` | UI 偏好 + 三份配置文件（`mcpServers` / `permissions` / `run`）及其路径，外加模型服务的两种形状：`providers`（选单用的扁平列表）与 `providerConfig`（`providers.json` 本身，设置页整份写回）。`providersError` 在文件读坏时给出原因，页面据此说明为什么表单是空的 |
| `saveProviders` | 整份写 `providers.json`，直写后从磁盘重新 `loadProviders`（不信任入参）。模型引用失效时自动回退到首个可用引用并重建 runner |
| `testProvider` | 探测一个模型服务：调内核 `probeProvider`（`dist/model/probe.js`，缺失时回「未编译，请先 build」而不是崩宿主）。回 `provider_test{ok, baseUrl, models?, error?, code?, latencyMs?}`；`models` 拿不到时字段不存在。**不进命令队列**，探测可能占用 10s，不能把 abort 堵在后面 |
| `saveMcpServer` | 合并同名项后整份写 `mcp.json` |
| `removeMcpServer` | 按 name 删除 |
| `savePermissions` | 整份写 `permissions.json`（`preset` / `approvalTimeoutMs` / `rules`） |
| `saveRunLimits` | 整份写 `run.json`（`maxTurns` / `maxCostUsd` / `timeoutMs` / `systemPrompt`），下一回合生效。`maxTurns: null` 表示**不限制轮数**（2026-10-22 起默认值就是 `null`，见 D-183 补充）；`0` / 负数 / 非整数仍会被拒绝——把笔误当「不限」会让用户以为上限生效了 |
| `sessionFlags` | 改名/置顶/归档，写旁挂 `meta.json`（header 校验会丢弃未知字段） |
| `deleteSession` | 删除会话目录；锁被占用时 409。拒绝删除当前打开的会话 |
| `forkSession` | `forkSession(dir, atSeq)`，分叉后直接打开新会话 |
| `exportSession` | 读日志渲染 Markdown，经 `saveFile` 存盘 |
| `revealArtifact` | 经 preload 的 `revealArtifact` 在文件管理器中选中；没有 preload 时会退化成一条含路径的 notice |
| `setUiPreference` | 回显，localStorage 是事实源 |
| `setLocale` | |
| `setMode` | 映射内核四预设；运行中拒绝切换并说明原因 |
| `setModel` | 仅接受 `providers.json` 中存在的引用；只对新建会话生效 |
| `refreshModels` | 重读 `providers.json` 并广播 `models`；读取失败保留原列表 |
| `setCwd` | 仅在无会话时切换；内核把 workdir 固定在 header 里，不能中途改 |
| `getUsage` | 汇总当前会话的 `usage` 事件 |
| `getSetupChecklist` | 只报真实检查项（providers、模型引用） |
| `listCommands` | 内核无斜杠命令，但前端内置三个：`clear` / `context` / `compact`，其后再跟每个技能一行（`source: "skill"`，带 `description` / `argumentHint`）。技能来源有四个根（见 `src/skills/store.ts` 头注释）：应用库 `$HARNESS_HOME/skills` 与 `<workdir>/.harness/skills`、skill CLI 库 `~/.agents/skills` 与 `<workdir>/.agents/skills`；项目级压用户级，同层里 CLI 压应用。CLI 的技能是**目录式**（`<name>/SKILL.md`），目录里其它文件不读。`/compact` **不接受参数**——内核 `compactSession` 没有 focus / keep 选项，`--keep N` 会是一个没人兑现的承诺。**命令真正执行时，敲进去的原文会作为一条普通用户消息留在转录里**（`/clear` 也一样，虽然它紧接着的 `session_loaded` 会清空转录）；未知命令与带参数被拒的命令**不 echo**，只出提示并把草稿留在输入框——先留消息再报错会让人以为它跑过。每次调用都重读磁盘，没有缓存：技能文件是可以手改的，缓存下来的清单描述的是一个没人重新列过的目录 |
| `getSkills` | 按需重读整份技能库，回 `skills` 事件：`skills[{name, description, argumentHint, scope, body}]` + `problems[{file, message}]`。**`problems` 与 `skills` 必须分开**——frontmatter 没闭合是可以修的文件，把它并进空列表会让技能库读成「什么都没有」（R3）。单文件读失败、名称非法、与内置命令同名都进 `problems` 并跳过该文件，其余技能照常可用；项目作用域同名覆盖用户作用域，`scope` 字段如实说是哪一份。内核没有技能存储（旧 `dist/`）时回 warn notice「请先 npm run build」**再发一条空 `skills`**——空事件是渲染器释放等待的信号，不能只报错不回答。渲染器在**每次打开「技能」页时**发这条命令：技能是手工可编辑的文件，开机时推的那一份是关于「一个没人重读过的目录」的断言，与知识库页打开即刷新是同一条理由 |
| `saveSkill` | 写一个技能文件，`skill{name, description, argumentHint, scope, body}`，落盘位置由 `scope` 决定（`user` → `$HARNESS_HOME/skills/`，`project` → `<cwd>/.harness/skills/`）。名称是文件名，所以**名字不合法就是路径问题**。宿主**不做第二份校验**：`SKILL_NAME_PATTERN` 与内置命令表都归存储层，宿主把 `name` / `scope` 原样交下去，让拥有这条约束的组件给出措辞——两处各判一次，迟早会给出两个结论（尤其 `scope`：把 `"projct"` 兜底成 `"user"` 会把技能写进错误的库，还不告诉任何人）。成功后**从磁盘重读**再广播 `skills` + `commands`，不把入参回显——存储会规范化 frontmatter 与正文，页面要显示的是下次启动会看到的东西。**失败什么都不广播**，只发一条带 `domain: "skills"` 的 warn notice 说明原因：先刷页面再报错，界面会像是保存成功了，而下一次读盘又把改动悄悄撤掉。`domain` 是路由键——设置页是 `showModal()` 的对话框，压在转录上面，普通 `notice` 会被写进用户看不见的转录（R3）；带这个标记的提示由 `settings.js` 就地显示在技能页，并且**表单不再关闭**，草稿留在原处 |
| `removeSkill` | 按 `{name, scope}` 删一个技能文件，两个字段都必填——同一个名字可能同时存在于两个作用域，只有被点的那一份该消失。存储回 `false`（文件已被手删）时**如实报「没有这个技能」**并把作用域写进提示，不静默重画：重画而没有提示，看起来就像删除成功了。成功同样重播 `skills` + `commands`。失败提示与 `saveSkill` 一样带 `domain: "skills"`，否则会落在被对话框遮住的转录里 |
| `getFile` | 只读预览一个文本文件，256 KiB 上限；越界（工作目录与会话目录之外）、符号链接、目录一律拒绝并说明原因；含 NUL 字节按二进制处理且不给文本预览 |
| `getArtifacts` | 列当前会话 `artifacts/` 下的普通文件（跳过目录与符号链接）；目录不存在或没有打开的会话 → 空列表 |
| `getArtifact` | 读一个产物文件；只允许当前会话 artifacts 目录内的路径 |
| `setEffort` | 已真正接通（2026-10-22 第十七轮）。模型在 `providers.json` 里声明 `supportsReasoning: true` 时才提供等级；`auto` 表示不覆盖、请求体里**完全不出现** `reasoning_effort`（缺席 ≠ 显式 `none`）。选择按 `provider/model` 存进 `run.json` 的 `reasoningEffortByModel`（缺席即 auto），跨重启保留，并**立即回一条 `state`**——此前这里回 warn「内核不支持」，而控件在界面上可见，正是 R3 说的假控件。未声明推理能力的模型仍拒绝，提示里点名是哪条模型引用 |
| `saveSettings` | 只接 `settings.locale`（en/zh），转调 `setLocale`；其他字段回 warn。不提供万能写配置入口——配置写入口是 `saveProviders`/`saveMcpServer`/`savePermissions`/`saveRunLimits` |
| `getTree` | 列一层子项（`listDirectory`）。边界＝已登记工作区 ∪ 会话目录 ∪ 会话工作目录，`realpath` 后判定；目录在前、按名排序、跳过符号链接、超 500 项截断。失败先发 warn notice **再**发空 `tree`——空树是释放 `pendingTreeTarget` 的信号，不是「目录是空的」 |
| `getKb` | 知识库定位 + 树（`dist/server/kb-locate.js`）。根解析优先级：`KB_ROOT` 环境变量 → `$HARNESS_HOME/mcp.json` 里任一 server 的 `env.KB_ROOT` → 仓库默认 `mcp-servers/kb/kb`；`source` 如实回报来自哪一级，`note` 说明选择理由。根不存在时**保留候选路径** + 空树 + `note`（「没找到」≠「是空的」）。`fileCount` 只数 `.md`；`truncated` 表示触顶（深度 8 / 条目 2000 / 文件数 20000），此时 `fileCount` 是「至少 N」而不是精确值。惰性 import：旧 `dist/` 缺该模块时回 warn「请先 npm run build」并回空 `kb`，不崩宿主 |
| `getCorpusStatus` | 语料 OTA 的只读状态（`dist/corpus/update.js` 的 `readCorpusStatus`）。**不联网**：只读 `$HARNESS_HOME/kb/state.json` 与 `current` 指针，回 `corpus_status{status}`。`status.kind` 是内核的七种状态判别联合（`bundled` / `up_to_date` / `update_available` / `check_failed` / `verify_failed` / `config_invalid` / `unavailable`），宿主**原样转发**、不重新推导（两份 switch 迟早会给出不同结论）。两条覆盖规则：`unavailable` 优先于配置结论（没有 `current` 就没有可更新的语料，先让用户看知识库状态），其余状态下若 `corpus.json` 缺失或不合法则报 `config_invalid`（契约 §2：知识库照常可用，更新功能如实报错）。附带 `configPath`（该改哪个文件）与 `configSource`（`home` / `resources`）。内核未编译时发 warn notice「请先 npm run build」**再发一条 `{error}`**——空应答会让页面永远等下去，但也不能编一个七状态之一充数 |
| `checkCorpusUpdate` | 请求更新源。**会触网**，只由用户点「检查更新」触发。走内核 `checkForUpdate`（403/404 一律 `check_failed` 并说明 OBS 的 GetObject 语义，**绝不当成已是最新**）。宿主在 fetch 外套一层：`latest.json` 的 200 响应 `clone()` 一份留着，但**只在 check 自己得出 `update_available` 时**才用——即那串字节已经被内核解析并验签过。缓存按 `updateBaseUrl + publicKeyPem` 指纹失效：改了任一项，旧清单就是关于另一个源的断言。回 `corpus_status{status, configPath}` |
| `applyCorpusUpdate` | 装上次检查到的版本。**会触网**（逐个下载变更文件），只由用户点「立即更新」触发（契约 §6：不自动应用）。manifest 来源两级：缓存命中就直接用（不重取 `latest.json`，「更新到你看到的那个版本」因此是字面意义）；缓存没有或配置变了就走一次**带捕获的** `checkForUpdate`，由内核判断有没有可装的版本，失败时把内核自己的状态原因转述回去。两条路径得到的文本都交给 `applyUpdate`，它会**再解析并再验签一次**才落盘。进度来自内核 `onProgress`，逐文件转成 `corpus_update_progress{completed,total,path,action}`——没有定时器、没有估算百分比。结果 `corpus_update_result{ok, corpusVersion?, reason?, corpusVersionUnchanged?}`，成功后再推一次 `corpus_status` 并重新 `getKb`（刚被换掉的语料，树也得重读）。三条命令**共用一条队列**串行执行（`enqueueCorpus`）：它们共用 `state.json` 与 manifest 缓存，「点检查、再点更新」是正常操作，排队而不是拒绝 |
| `setWorkspace` | 宿主登记目录后委托给 `setCwd` 的全部语义（运行中拒绝、仅新建会话生效）。登记是进程内的，重启失效 |
| `searchFiles` | `@` 提及的文件名搜索。内核 `searchFilesByName`（复用 `walkFiles` 的惰性 BFS / 24 项忽略清单 / 跳符号链接），根＝宿主当前 `cwd`。分层排序：基名全等 → 基名前缀 → 基名包含 → 路径包含，层内短路径优先，上限 20 条。回 `file_matches{query, files, truncated, scanned}`，`truncated` 取「命中超上限」与「遍历被预算截停」之或。**目录不在结果里**（walker 只访问文件，D-184）；边界拒绝发 warn notice，但**必回一条带 query 的 `file_matches`** —— 弹窗只在该事件上释放 |
| `searchSessions` | 按标题/工作目录/id 搜索 |
| `shutdown` | 宿主退出 |

### 已隐藏（前端不渲染入口，宿主回显式 `notice`）

git（`gitStatus`/`gitCommit`）、PR（`prStatus`/`createPr`/`prRerun`/`prFixCi`）、终端（`terminalOpen`/`terminalRun`/`terminalInterrupt`/`terminalRestart`）、worktree（`worktreeStart`/`worktreeMerge`/`worktreeDiscard`/`worktreeDiff`；**顶栏与面板已在 2026-10-22 整块删除**，用户点它只得到「桌面宿主暂不支持该命令」）、packs（`getPacks`/`installPack`/…）、browser（`browserOpen`/`browserNavigate`/…）、memory / instructions / hooks、subagents、goals、检查点（`getCheckpoints`/`restoreCheckpoint`/`restoreFile`）、压缩（`compact`）、板卡/串口控制（`getBoardState`/`serialOpen`/…）。

> **`skills` 已于 2026-10-22 第十六轮移出本清单**（见下表 `getSkills` / `saveSkill` / `removeSkill`）。它当初在这里的原因和别的项不一样：git/终端/worktree 那些是「内核有能力、前端没接」，技能是**内核根本没有这个能力**，所以这一轮先补内核再加前端入口。

串口监视器同样隐藏：`serialOpen` / `serialStatus` / `serialRead` 没有宿主实现，内核只把串口能力暴露为模型调用的 MCP 工具，探针的串口状态改在板卡面板「设备」段显示。工作台有 Board / File / Artifact 三个 tab——后两个由动作打开（点工具行、点产物），不在 tab 条上常驻。

原因逐项登记在 `docs/deferred-issues.md` 的 D-166 与 D-169。技能的边界（没有权限语义、模型不能自己挑、参数只有字符串替换、项目作用域没有信任门）另见 D-198。

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
| `usage` | `usage{usage, context?, contextBreakdown?, costUsd?}`——`context` 是上下文占用（tokens/percent/window），`contextBreakdown` 是同一份测量的按类别拆分（`{used, window, percent, compactAt, parts:[{key,tokens}]}`，key ∈ `systemPrompt`/`messages`/`toolResults`/`mcpTools`，`sum(parts.tokens) === used`），`costUsd` 是会话累计成本；缺失时字段不存在，渲染器据此隐藏而不是显示 0。**占用率在发请求之前测量**（D-195：原先在 `usage` 落盘时重新投影日志，那一刻工具批次未闭合、必然抛错被吞，导致每条带工具调用的回合都没有占用率）。**`state` 事件里的 `context` 用 `null` 表示「未知」**（`protocol.measuredContext()`），`undefined`（字段缺席）表示「这条事件不带占用，别动屏幕上的数字」——两者语义不同，不得互换。`contextBreakdown` 走 `protocol.measuredBreakdown()`，语义与 `context` 一致 |
| `status{done}` | `run_end` |
| `status{usage_missing\|device_status_invalid\|permissions_project_config_skipped}` | `notice` |
| `interrupted` | `notice{warn}` + `run_end` |
| `compaction` | `compacted`（microcompact / summary）/ `notice`（failed）。**`no_progress` 与 `no summarizable content` 降级为 dim 提示而不是 warn 失败**：`/compact` 现在一律执行（不再看阈值），小会话上必然撞到这两种「没什么可压」，把它们印成「压缩失败」是误报 |
| `todos` | `todos{items:[{content,status}]}`（`todo_write` 工具写的计划；渲染器画计划卡并在执行中原地打勾）。`status` 非法时该行按 `pending` 保留文字，坏项丢弃；空数组表示「清空计划」，渲染器据此移除卡片。`session_loaded` 额外带 `todos`（取最后一条 `todos` 事件），否则重开会话时计划卡会消失 |
| `background_result` | `notice{dim\|warn}`（后台终端作业结束）。退出码 0 用 dim，非零/被信号结束/超时用 warn；输出被截断时同一行同时给出**总字节数与保留字节数**——只报保留量会让人把一段尾巴当成全部输出（R3）。**写进会话日志而不是临时提示**：这类作业按定义比它所属的回合同长，十分钟的构建结束后用户可能已经重开窗口，只有日志能让那次结果留到下次。宿主用 1s 的泵轮询内核的完成队列，经 `resumeSession` 取锁后 append，再关掉句柄——与 `/compact` 取锁的方式一致 |
| `system` / `user` / `checkpoint` / `tool_call` | 不产出（用户消息在提交时已回显） || 未知类型 | `notice{warn}`（R3，不静默） |

宿主另发：`hello`、`ready`、`state`、`sessions`、`session_loaded`、`session_matches`、`commands`、`skills`、`setup_checklist`、`settings`、`usage_summary`、`models`、`locale`、`ui_preference`、`tree`、`file_matches`、`export_ready`、`notice`、`error`、`fatal`、`run_start`、`run_end`、`permission_closed`。

宿主另发的事件里只有两条带库状态，它们的职责不能互换：

| 事件 | 形状与语义 |
|---|---|
| `skills` | `{skills: [{name, description, argumentHint, scope, body}], problems: [{file, message}]}`。**不是内核 `SessionEvent`**——技能是磁盘上的文件，不是会话事实源的一部分，所以它不落会话日志、不参与回放。三个时机发：`init` 握手（与 `commands` 同一份快照，两处不能描述两个不同的库）、`getSkills`、`saveSkill` / `removeSkill` 成功之后（失败不发，见那两个命令的说明）。`problems` 非空时设置页在列表上方画一块问题区，逐条给文件路径与原因——那正是用户能去修的东西；技能是全局的、不属于任何会话，`session_loaded` 不清它 |
| `commands` | `[{name, description?, argumentHint?, source?: "skill"}]`。内置三条不带 `source`（渲染器缺省按 `builtin`），技能行带 `source: "skill"`。这个字段是「回车是运行还是插入」的唯一依据：只有**恰好**等于 `"skill"` 才算技能，缺省与可疑值一律按内置处理——否则一个拼错的值会打开展开路径，而 `/clear` 会跑去正文里找一个不存在的 body。`argumentHint` 决定点选行为：**空 hint 与内置命令一样点一下就跑**（没有参数可等，按空参数展开），非空 hint 只把 `/name ` 插进输入框等参数。与 `skills` 同源同刷，因为命令面板与设置页必须对「有哪些技能」说同一句话 |

**一条技能怎么到达模型**：`/name args`（用户在输入框敲的原文）→ `expandSkill(skill, args)` 在**渲染层**把正文里的 `$ARGUMENTS` 替换成 `args`（正文没有占位符时把 `args` 作为追加的一段）→ 发一条**普通 `prompt` 命令**，文本就是展开后的正文 → 内核照常写一条普通 `user` 事件。内核不认识 `$ARGUMENTS`，也不知道这条消息来自技能：展开放在内核之外是刻意的——把展开放进内核，「保存一段提示词」就会变成「运行一段脚本」。

**转录显示的是用户敲的那行，不是展开后的正文。** 因为展开结果进了 `user` 事件、会随会话一起落盘，也就能在回放与导出里被读到，此时再在转录里印一遍展开文等于同一段话出现两次；而用户需要能对上自己刚才的动作（「我敲了 `/review`」），展开文属于「模型看到了什么」，不属于「我做了什么」。代价是**转录里看不到 `$ARGUMENTS` 究竟被替换成了什么**——要查这一点只能看日志。若将来需要并排显示两者，应该加在工具行那种「可展开详情」的位置，而不是改写用户气泡。

## 阶段 4 交互层

`docs/superpowers/specs/2026-10-20-m2-stage4-interaction-design.md` 的 §7（回放）、§8（导出）、§9（设备控制）原设计基于已删除的 `src/ui`，需按本前端重写。三项在当前内核上都是可做的：回放只需按事件下标截断后重建消息列表；导出读 `GET /api/sessions/:id`；设备控制把预置指令发进会话、仍经权限与审批。详见 D-166。

> 2026-10-21 第四轮（用户「模型配置没有、无法打开本地文件夹」）：新增 `saveProviders`（整份写 `providers.json`）、`setWorkspace`（登记目录后委托 `setCwd`）、真实 `getTree`（接 `listDirectory` / `GET /api/tree`）；`searchFiles` 仍是空匹配，原因改为写在代码里。设置页恢复「模型服务」页，`apiKeyEnv` 明确标注为环境变量名、未定价时成本显示「未知」。浏览器形态的 `pickDirectory` 不再静默返回 `null`，改为说明拿不到绝对路径并提示手输。

> 2026-10-21 第五轮（用户「模型配置为什么叫连接？而且也无法进行配置操作」）：两处独立缺陷。①**命名**——设置页沿用了移植前端的 `Connection`，而应用其他位置（宿主提示「设置 → 模型服务」、README、页面标题 `connEmptyTitle`）都叫「模型服务」；现统一为「模型服务 / Model services」，首启提示与 `openSetup` 文案一并改掉旧的「填 API 密钥」（密钥本就只存环境变量名）。内部 id `connection` 保留，它不出现在界面上。②**配置页在浏览器形态下是空的**——`bridge.emitSettings()` 从不发 `providerConfig`，`buildConnectionPage` 因此走 `connUnsupported` 分支直接返回，没有卡片、没有「添加」、没有「保存」；桌面宿主发这个字段，但 Electron 未安装，实际能跑的是浏览器形态。现由 `protocol.providersEvent()` 一次给出两种形状（扁平列表 + 文件本体），`modelsOf()` 把文件展开成 `provider/model` 选单条目；`refreshConfig` 与 `putConfig("providers")` 之后都广播 `models`，否则选单停在「正在加载模型…」而 `providers.json` 明明有模型。

> 2026-10-21 第六轮（用户「contextWindow和maxOutput直接删掉」「每百万Token价格直接删掉」「缺少测试连接」「选择本地文件夹应该在侧边栏也可进行」）：①`contextWindow`/`maxOutput` 不再由用户在表单里填，内核改用具名估算默认值（128000 / 4096）；表单保存时**旧值原样透传**，不因界面不显示就抹掉。②「每百万 token 价格」整区删除，旧 `pricePerMillion` 同样透传。③新增 `testProvider`（见上表）：设置页每张卡片一个「测试连接」按钮，15s 超时、按 `baseUrl` 匹配回包、页面重建时用 build 快照丢弃孤儿回包。④侧边栏新增工作区入口，显示当前文件夹名，与顶栏共用同一个 `chooseWorkspace()`——两条路径规则完全一致，没有复制一份。**接缝修复**：`app.js` 的 `handleEvent` 原本没有 `provider_test` 分支，事件会被静默丢弃、按钮只能靠 15s 超时以「没有响应」收场，已补上转发。

> 2026-10-22 第十三轮（用户「删除语言输入UI」「选择会话，上方的文件夹不会随会话所在文件夹变化」「会话操作与时间重合」「桌面宿主暂不支持该命令：rewindTo，无法回退」「表格、分割线 md 语法渲染有误」「会话我输入查找README.md，似乎并没有从项目文件夹开始找」「继续完善 Agentic Search」）：①**删除语音输入**——麦克风按钮、`setupVoice`/`stopVoice` 整块、录音动画与 `voiceStart`/`voiceStop` 文案、`#i-mic` 图标一并删除（用户确认「语言输入」指的是这个按钮，不是界面语言切换——后者保留）。②**`loadSession` 采纳会话目录**（见上表；根因 D-182）。③**会话行右边缘**——`.session-meta` 与 `.session-more` 原来同时钉在右边缘，悬停时 20px 的三点按钮正好压住日期；现在 `:hover` / `:focus-within` 时日期让位 `right: calc(9px + 20px + 6px)`，实测两矩形由相交 20px 变为留 6px 间隙（CDP `CSS.forcePseudoState` 强制真实 `:hover` 后量取，1280 / 900 两个视口一致）。④**删除「回退到这里」**——内核没有 rewind / 文件快照 / 检查点恢复能力，按 R3 删按钮而不是伪造成功。检查点面板整块仍是死代码（`getCheckpoints` 等无 handler，`history` 不在 `SUPPORTED_PANES`），未动，记录在案。⑤**Markdown 表格与分割线**——渲染器原本不产出 `<table>` 与 `<hr>`（`.markdown table` 的样式一直是死代码）；现支持 GFM 最小集（`|` 切列走状态机，`\|` 与 code-span 内的 `|` 不拆列，对齐三态，短行补齐/长行截断）与 `---` / `***` / `___` 分割线（段落中间不算，围栏内不算）。新增 `tests/desktop/markdown.test.js` 26 例。⑥**`glob` / `grep` 从项目根开始**——见 D-181：遍历改惰性 BFS、忽略清单扩到 24 项 + `*.egg-info`、截断时给可行动提示。⑦**Agentic Search**——按 D-179 的建议 ①②：`kb_grep` 增加 `fileCount`/`files` 命中文件分布，工具描述写死「命中只是候选，断言前必须 `kb_read` 原文确认」；KB 遍历加上限与忽略清单、`scanTruncated` 与 `truncated` 分开。**没有**设拒答阈值（D-179 ③ 未做，状态仍是未解决）。

> 2026-10-22 第十四轮（用户「取消最大轮数限制」「测试连接显示的可以模型需进行展示美化」「上下文情况的获取」「@点名文件和/调取命令的实现（如/compact，/clear）」，并发 5 个子代理）：①**取消默认轮数上限**——`BreakerLimits.maxTurns` 改为可选，缺省即不检查；`AppRunLimits.maxTurns` 改为 `number | null` 且默认 `null`；`readRunLimits` / `readRunLimitsBody` 把 `null` 规范化成「字段缺席」。设置页留空＝不限制。0 / 负数 / 非整数仍拒绝。②**`@` 文件搜索接通**（见上表 `searchFiles`）。③**上下文占用百分比可见**——`#context-label` 的 `hidden` 此前从未被解除，百分比一直不可见；`initialState()` 的 `{tokens:0,percent:0}` 兜底会把「未知」画成「0%」。现在 `null` 是显式未知哨兵，`undefined` 表示「别动屏幕上的数字」。④**「测试连接」结果区重做**——状态行（勾选 + 摘要 + 独立延迟）+ 可用模型标题与计数 + 模型 chip 网格；已列出的模型不再被静默丢弃，改为禁用态的「已添加」chip（R3）。⑤**复核并登记 D-184 ~ D-193**：`getBoardState` 两端无 handler 而 Board 是唯一常驻页签、快捷键表三条键与实现不符、`contextBreakdown` 无生产者、MCP 仅 stdio、无整跑墙钟超时、图片附件静默丢弃、About 页 `checkUpdate` 必崩、「排队」标签是假的、goals/subagents/检查点三块死 UI。

> 2026-10-22 第十六轮（用户「接入skills功能，发子代理」，并发 4 个子代理：内核存储 / 宿主接线 / 渲染层展开 / 文档）：①**技能＝保存下来的提示词模板**，不是插件、不是沙箱。内核新增 `src/skills/`（`store.ts` / `types.ts`）：用户级 `$HARNESS_HOME/skills/<name>.md`、项目级 `<workdir>/.harness/skills/<name>.md`，frontmatter 只认 `description` / `argument-hint`（未知键当额外元数据），**没有 frontmatter 的文件也是合法技能**（整份就是正文）；名称须匹配 `/^[a-z][a-z0-9_-]{0,63}$/` 且不得与 `clear`/`context`/`compact` 同名——同名技能永远轮不到执行，所以读取时就报 problem 跳过；frontmatter 未闭合与单文件读失败一律进 `problems`，**不静默丢**（R3）；项目作用域同名覆盖用户作用域；写入走临时文件 + fsync + rename。②**宿主三个命令**（`getSkills` / `saveSkill` / `removeSkill`，见上表），`init` 与 `listCommands` 同时带上技能行；保存成功重播 `skills` + `commands`，**失败什么都不播**。③**渲染层**：`mergeCommands` 认 `source: "skill"`（只认这个精确值，其余按内置），新增纯函数 `expandSkill(skill, args)` 把正文里的 `$ARGUMENTS` 换成参数（正文没有占位符时把参数作为追加段落），敲 `/name args` 展开后按**普通 prompt** 发出；设置页恢复「技能」页（作用域标签、参数提示、问题区）。④**转录显示用户敲的那行而不是展开文**——展开结果已经作为 `user` 事件落盘，回放与导出都能读到，转录里再印一遍等于同一段话出现两次，而用户需要对上的是自己的动作。代价是看不到实际替换成了什么，需要时应加在可展开详情里而不是改写用户气泡。⑤**刻意不做**模型可调用的 `Skill` 工具：用户要的是技能，不是模型自选技能。⑥**登记 D-198**（四条边界），**`skills` 从隐藏清单移出**，D-166 其余各项未动。⑦**另修掉两处缺陷，都记在 D-198**：(a) 技能名允许 `_`，但 `parseSlashText` 的 `SLASH` 字符类不含 `_`，所以 `/review_diff` 在面板里列得出、插得进输入框，回车却按普通提示词原样发给模型（`parseSlashText("/review_diff")` 实测为 `null`）——根因是「能存在的名字」与「能敲出来的名字」由两份独立正则描述。**已修**：`SLASH` 字符类补 `_`（`/` 仍不允许，所以 `/usr_local/bin` 还是散文），那条把 bug 钉住的断言改成正例，并补了一条不变量测试——对 `SKILL_NAME_PATTERN` 接受的每个名字，`parseSlashText("/" + name)` 必须原样还原。(b) 保存/删除失败时宿主只发 `notice`，而 `app.js` 把 `notice` 一律写进转录，转录又在 `showModal()` 的设置页后面，`settings.js` 也没有 `notice` 分支——失败在用户看来是「点了没反应」，且表单已无条件关闭、草稿丢失。**已修**：失败提示带 `domain: "skills"` 由 `app.js` 转进设置页，技能页就地更新一行错误（不重建页面），保存按钮不再关闭表单——成功由 `skills` 广播重建页面带走表单，失败把草稿留在原处。
