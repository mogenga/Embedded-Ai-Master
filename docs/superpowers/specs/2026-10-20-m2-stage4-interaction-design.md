# M2 阶段 4 交互与外部验证设计（M3 衔接）

> **状态：待评审 · §7-§9 的前端接口需按新前端重写（2026-10-20 前端移植后）**
>
> 2026-10-20 的前端移植把 Preact 工作台（`src/ui/`）整体替换为 `desktop/renderer/`（Prometheus 渲染器，纯 ES 模块，无框架无打包器）。本 spec **§10 外部验证与 §5/§6 的内核侧约束仍然有效**，但 **§7 回放、§8 导出、§9 设备控制** 所依赖的前端 API 已不存在，必须按新前端重写后才能实施。
>
> 已删除的依赖（`src/ui/` 共 12 个文件、约 30 个导出符号）与其在新前端中的对应物：
>
> | 本 spec 引用（已删除） | 新前端的对应物 | 状态 |
> |---|---|---|
> | `src/ui/view/transcript.ts` 的 `transcriptFromSession` / `TranscriptView` / `ApprovalModel` / `PermissionModel` | `desktop/renderer/protocol.js` 的 `sessionEventsToMessages`（重建骨架）；`sessionEventToHostEvents`（实时增量） | **需新写**：新前端无归约层，回放需按 `seq` 截断后重放 `sessionEventToHostEvents` |
> | `src/ui/state.ts` 的 `WorkbenchState` / `applySessionEvent` / `applyStreamError` / `retryTarget` / `RequestGate` | `desktop/renderer/app.js` 的 `state` 对象 + 增量 DOM 操作 | **需新写**：无归约器，回放状态需自行建模 |
> | `src/ui/main.tsx`（定时器持有者）、`src/ui/app.tsx`（`onSend`） | `desktop/renderer/app.js` 的 `submit()` / `api.send({cmd:"prompt"})` | **需改写**：预置指令经 `api.send` 下发，非组件 props |
> | `src/ui/api/load.ts` 的 `loadSessionView` / `lastSeqOf` / `deviceForSession` / `loadWorkbench` | 桌面走 `loadSession` cmd；浏览器走 `GET /api/sessions/:id`（`bridge.js`） | **已有等价物**，需对齐形状 |
> | `src/ui/api/event-stream.ts` / `session-stream.ts`（缺口重拉、重连上限） | `bridge.js` 的 `openStream` / `_internal.getLastSeq()` | **缺口检测与重连上限未实现**（见 D-167） |
> | `src/ui/view/sse.ts` 的 `postAction` | `bridge.js` 的 `startPrompt`（`POST /api/actions`） | **已有等价物** |
> | `src/ui/view/device.ts` 的 `deviceFromSession` / `UNKNOWN_DEVICE` | `desktop/renderer/protocol.js` 的 `device_status` → `board_state` | **需改写**：`state.device` 原样透传，不做字段 patch |
> | `scripts/verify-ui.mjs` 与 `npm run test:ui` | `npm run test:desktop`（协议层与宿主） | **需新写**：视觉验收清单已随 §12 更换为 v2.0 的 V1–V15 |
>
> 重写时的前端事实源：`docs/frontend-design.md` v2.0（布局、令牌、组件、协议映射）与 `desktop/MATRIX.md`（命令/事件能力矩阵）。**不得**按本 spec 现存文字直接实施 §7-§9。

> 日期：2026-10-20 · 状态：待评审 · 上游：[m2-roadmap.md](../../m2-roadmap.md) 阶段 4、[BRD.md](../../BRD.md) BR-6 / PLAT-5 / R1-R3、[frontend-design.md](../../frontend-design.md) §8.6/§9、[deferred-issues.md](../../deferred-issues.md) D-052 / D-058 / D-059 / D-111 / D-166。
> 本轮交付终点：会话回放与 transcript 导出可用；设备面板的暂停/继续/复位经既有会话指令链路执行；D-111 的 live 网关、第三方 MCP、终止失败路径完成可执行部分，真机部分显式登记阻塞。

## 1. 意图与为什么

阶段 3 已把领域闭环（KB + probe MCP + Renode 端到端诊断）合并进 `main`；Web 审批闭环也已完成。阶段 4 剩下的不是新的诊断能力，而是让操作者能“看懂并复现”一次诊断：

- 诊断结束后，操作者需要按会话日志重放整个过程，确认每一步工具调用、证据与结论，而不是只能读静态终态。
- 操作者需要把一次会话导出，用于复盘、归档和跨机器比对。
- 设备面板目前只展示状态，暂停/继续/复位按钮没有行为；操作者需要一个入口把意图交给既有权限与审计链路，而不是让 UI 直接操作硬件。
- D-111 的外部验证长期悬空；本轮要把能在当前环境验证的部分做实，不能验证的部分明确写清原因与升级条件。

已确认的产品决策（2026-10-20）：

- **范围**：全阶段 4，包含回放、导出、设备控制接线与 D-111 外部验证。
- **设备控制**：按钮发送预置会话指令，由模型调用 probe MCP 并经权限/审批；不新增设备写端点，不允许 UI 绕过权限层直接操作硬件。
- **UI**：最简实现，不引入时间轴拖动、波形、仪器联锁。
- **审查节奏**：多个任务合并实现后做一轮核验，仅在最终复核做第二轮。

## 2. 目标

1. **回放**：从当前会话日志重建，按事件顺序逐步播放；可暂停/继续/退出；回放期间明确标记“回放中”，禁止发送、审批与设备命令，不触发任何工具或硬件查询。
2. **导出**：把活动会话的 header 与完整事件导出为 JSON 文件；导出失败显式提示，不伪造成功。
3. **设备控制**：暂停/继续/复位按钮把预置指令发到当前会话；无活动会话时禁用；复位保留二次确认；最终执行与拒绝只由会话事件投影决定。
4. **外部验证**：完成 live 网关真实往返、第三方 MCP server 真实接入、MCP 终止失败路径验证；真机探针/串口在缺少 OpenOCD 或设备身份不明时登记为阻塞，不擅自写入。
5. **可验证**：新增纯函数投影与 UI 测试、回放/导出集成测试、设备指令集成测试、外部验证记录；不新增依赖。

## 3. 非目标

- 时间轴拖动、倍速选择、逐帧步进、跨会话合并回放。
- 波形、信号级联、仪器联锁（OPEN-UI-04 仍有效）。
- 设备面板直接写寄存器/复位；所有写操作仍走模型工具调用与权限层。
- 新增 Web 鉴权模型（token/CSRF）；沿用 loopback + `Origin`/`Sec-Fetch-Site` 校验。
- 会话删除、重命名、分叉 UI。
- 真机 OpenOCD 安装或驱动配置；COM 口写入。
- 修改 KB 资产或诊断结论生成逻辑。

## 4. 反目标

- 回放时重新执行工具、重新查硬件、或把历史事件重新 append 到日志。
- 回放期间仍允许发送/审批，导致“看历史”和“改现场”混在一起。
- 导出内容与日志不一致，或失败时下载空文件/伪装成功。
- 设备按钮直接调用 MCP 工具或直接写寄存器，绕过权限、审批与审计。
- 回放/导出/设备指令在无活动会话时静默失败或抛未捕获异常。
- 外部验证用测试夹具冒充第三方 MCP，或把未验证项写成“通过”。

## 5. 约束

- TypeScript + Node 24，ESM-only，相对导入 `.js`，strict；不新增依赖。
- 内核不含领域逻辑：设备指令文本由前端常量提供，工具选择仍由模型与 probe MCP 决定；`src/index.ts` 不 import `src/server`。
- 日志是唯一事实源：回放只读 `state.events`；导出只读 `/api/sessions/:id`；设备命令只经 `POST /api/actions`。
- 安全边界 R1-R3 不变：LLM 不直接控制仪器；写/复位前由模型声明；工具失败显式报错。
- 危险命令测试禁令：设备指令测试只断言发出的文本与既有链路调用，不真实执行危险命令。
- 外部验证不得把真实写操作指向未知设备；COM7 身份未确认前禁止写入。

## 6. 总体数据流

```
回放：state.events ──slice(0,n)──► transcriptFromSession ──► view（只读）
导出：GET /api/sessions/:id ──► { header, events } ──► Blob 下载
设备：按钮 ──► onSend(预置文本) ──► POST /api/actions ──► runSession
                                              └─► 模型调用 probe MCP ──► 权限/审批 ──► 工具
```

- 回放不关闭日志、不写日志；回放期间关闭 SSE，退出后按 `lastSeq` 续传补播。
- 导出每次点击重新读取详情，避免内存与磁盘分叉。
- 设备指令与手动输入完全同一条路径，不新增 HTTP 端点。

## 7. 回放

### 7.1 状态模型

`WorkbenchState` 增加可选字段：

```ts
export interface ReplayState {
  index: number;      // 已投影事件数（0..events.length）
  playing: boolean;   // 是否自动推进
  total: number;      // 进入回放时的 events.length
}

export interface WorkbenchState {
  // ...既有字段
  replay?: ReplayState;
}
```

- `index` 是事件数组下标，不是 `seq`；日志允许 seq 不连续，回放以事件顺序为准。
- `total` 在进入回放时固定；回放期间 SSE 关闭，不会追加新事件。
- `view` 由 `transcriptFromSession(state.events.slice(0, replay.index))` 投影，`sessionId` 保持当前会话。
- 设备面板与调试坞也按截断后的事件投影，确保“回放到哪一步，面板就到哪一步”。

### 7.2 播放控制

- 进入：点击会话头「回放」。要求 `activeSessionId !== undefined` 且 `events.length > 0`，否则按钮禁用。
- 播放：固定间隔 250ms 推进一步；到 `total` 后自动停止（`playing=false`，`index=total`），显示「回放结束」。
- 暂停/继续：只改 `playing`，不改 `index`。
- 退出：清除 `replay`，`view` 恢复完整投影，重新打开 SSE（`since=lastSeq`）。
- 回放中切换会话或「新会话」：先退出回放，再执行原动作。
- 定时器由 `main.tsx` 持有；组件卸载/页面卸载/会话切换时清理。`prefers-reduced-motion` 不改变回放间隔（回放是功能而非动效）。

### 7.3 交互与禁用

- 会话头显示「回放中 x/y」与「退出回放」；「回放」按钮在回放中变为「暂停/继续」。
- 回放中：Composer 禁用并提示「回放中，退出后可继续发送」；审批卡片不提供操作按钮；设备面板控制按钮禁用。
- 回放中的审批卡片是历史记录，不得按当前时间重新判定过期：冻结 `deadlineAt` 倒计时，`pending` 显示「待审批（历史）」，不渲染「已过期」；已有终态（allowed/denied/expired/aborted）保持原状。
- 回放中仍可滚动、展开工具卡、切换主题与调试坞；这些不改变事件源。
- 回放不修改 `state.events`、`lastSeq`、`device` 的实时基准；退出后以完整事件重算。

### 7.4 边界

- 事件为空：回放按钮禁用，不进入 `replay`。
- 回放中收到 SSE 事件：不应发生（SSE 已关闭）；若竞态写入，`replay.total` 不变，退出后以完整事件重算。
- 会话加载失败/切换失败：清除回放状态，避免停留在半截视图。
- 回放不触发 `POST /api/actions` 或 `POST /api/approvals`。

## 8. 导出 transcript

- 点击会话头「导出 transcript」，调用 `fetchSession(id)` 读取 `{ header, events }`，序列化为：

```json
{
  "exportedAt": "2026-10-20T...",
  "sessionId": "<id>",
  "header": { "...": "..." },
  "events": [ { "...": "..." } ]
}
```

- 文件名 `<sessionId>.json`；使用 `Blob` + `URL.createObjectURL` 下载，随后 `revokeObjectURL`。
- 导出中按钮禁用并显示「导出中」；失败在会话区显示可读错误，不下载空文件。
- 无活动会话时按钮禁用。
- 导出内容不做二次投影，避免与日志分叉；字段顺序不保证，测试只断言结构。

## 9. 设备控制接线

### 9.1 指令文本

前端常量（不新增配置）：

| 动作 | 预置文本 |
|---|---|
| 暂停 | `使用 probe 工具暂停当前目标（halt），然后报告执行结果。` |
| 继续 | `使用 probe 工具恢复当前目标执行（resume），然后报告执行结果。` |
| 复位 | `使用 probe 工具复位当前目标（reset）；执行前先声明将写入的寄存器与值，然后报告执行结果。` |

- 文本只表达意图，不指定 server/tool 名以外的领域细节；工具选择与参数由模型决定。
- 不拼接用户输入；不做模板变量替换。

### 9.2 行为

- 暂停/继续：点击后直接调用 `onSend(text)`；按钮在提交期间禁用，失败经 `sendError` 展示。
- 复位：保留现有二次确认（目标、寄存器与值）；确认后调用 `onSend(text)`，关闭确认框，进入「已提交，等待工具结果」。
- 启用条件：必须有活动会话**且** `device.cpu` / `device.probe` 均不为 `unknown`（与现有 `connected` 判断一致）。`/api/device` 恒为 `unknown`，只有会话出现 `device_status` 后才可操作；未连接时禁用并提示「未接入设备，无法控制」。
- 无活动会话：三个按钮禁用，并在面板内提示「先创建或选择会话」。
- 连接状态仍来自 `device.cpu/probe` 保守判断；不因点击按钮本地改成「已执行」。
- 设备面板不直接调用 `POST /api/approvals`；审批仍由消息流中的卡片完成。
- 回放中禁用全部设备控制按钮。

### 9.3 安全

- 设备命令与普通消息同权：默认 `diagnose` 预设下 `halt`/`resume`/`reset` 由权限规则决定；写/复位需要审批时照常出现审批卡片。
- 模型若拒绝或工具失败，页面必须显示原始失败原因；不得用「已暂停/已复位」本地文案覆盖。
- 不在前端缓存设备终态；只认 `device_status` 与工具结果事件。

## 10. 外部验证（D-111）

### 10.1 验证矩阵

| 项 | 当前环境 | 本轮动作 | 失败处理 |
|---|---|---|---|
| live OpenAI 兼容网关 | `DASHSCOPE_API_KEY` 已设置；用户 home 下无 providers.json | 不写用户 home：用临时 `HARNESS_HOME`（如 `.tmp/live-home`）生成 providers.json（只引用环境变量，不写 key），`baseUrl=https://dashscope.aliyuncs.com/compatible-mode/v1`、默认模型 `qwen-turbo`（可用 `HARNESS_COMPAT_MODEL` 覆盖），运行 `HARNESS_COMPAT_LIVE=1` 的真实 `complete` 往返 | 记录 HTTP 错误/超时；不伪造通过 |
| 第三方 MCP server | `uvx` 可用；未安装第三方 filesystem server | 由用户执行安装/运行命令（agent 不执行安装），用临时 `HARNESS_HOME` 接入，验证 `list_tools`/`call`/超时/终止 | 安装或联网失败则登记阻塞 |
| 真机探针（OpenOCD） | 未安装 OpenOCD；无探针 | 不尝试安装；登记阻塞与升级条件 | 不写寄存器、不复位 |
| 真串口 | 存在 COM7，但设备身份未知 | 不打开、不写入；登记阻塞 | 不猜测设备 |
| MCP 终止失败路径 | win32 下 manager 用 `taskkill /T /F`，普通子进程无法真实“不响应”终止 | 以既有 `tests/mcp-manager.test.ts` 的存活 mock 用例作为 `mcp_uncertain` 逻辑覆盖证据；真实终止失败环境登记阻塞，不再新增不可复现的脚本 | 记录未覆盖分支与原因 |
| 崩溃恢复 / 回放 | Renode 可用 | 复用阶段 3 的 `diagnosis:e2e` 与回放输出，补充审批/设备指令场景 | 记录差异 |

### 10.2 记录要求

- 每条验证记录：命令、环境变量（脱敏）、退出码、关键输出、结论（通过/失败/阻塞）。
- 记录写入 `dev-notes/M2-阶段4.md`；新增/更新 `docs/deferred-issues.md` 中的 D-111 状态与阻塞原因。
- 外部验证不进入默认 `npm test`，不触网；live 用例仍由 `HARNESS_COMPAT_LIVE=1` 显式开启。

## 11. 测试策略

- 纯函数：`transcriptFromSession(events.slice(0,n))` 的截断投影、回放状态迁移（进入/暂停/继续/退出/结束）。
- UI：会话头回放/导出按钮状态；回放中 Composer/审批/设备按钮禁用；设备面板指令文本与二次确认；导出失败提示。
- 集成：`/api/actions` 收到设备指令文本并按既有链路运行（fake model 固定调用 probe 工具）；回放不产生 `POST`；导出读取真实会话目录。
- 外部验证：不作为默认测试；交付形态为「可复现命令 + dev-notes 记录」，不新增长期脚本；第三方 MCP 的安装/联网命令由用户执行。
- 回归：既有 1794+ 用例、`npm run test:ui`、`verify:ui` 全绿。

## 12. 验收

- 打开一个已有会话，点击「回放」：视图从空开始逐步出现事件，可暂停/继续/退出；退出后恢复完整视图并继续接收实时事件。
- 回放中发送框、审批按钮、设备按钮均不可用；页面明确显示「回放中」。
- 点击「导出 transcript」：下载 `<sessionId>.json`，包含 header 与全部事件；服务不可用时显示错误且不下载。
- 有活动会话且 `device_status` 已表明连接时，点击暂停/继续/复位：消息流出现对应用户指令，模型经 probe MCP 执行，权限/审批照常；无活动会话或未连接时按钮禁用。
- 外部验证记录覆盖 live 网关与第三方 MCP 的可执行项；真机与 COM7 明确登记阻塞，未发生写入。

## 13. 风险与边界

- 回放期间 SSE 关闭：若用户长时间停留，退出时需从 `lastSeq` 补播；补播上限与现有 3 次缺口重拉规则一致。
- 设备指令依赖模型理解；模型可能选择错误工具或拒绝执行。UI 不承诺“点击即执行”，只承诺“提交到会话并留下审计”。
- 导出可能含敏感参数摘要/工具输出；与 README 既有边界一致，不做脱敏，由操作者自行保管。
- 外部验证受网络、凭据、硬件限制；阻塞项必须显式登记，不能以“本地测试通过”替代。
- 回放只还原日志中已有事件；历史日志缺字段时按现有投影降级，不补造数据。

## 14. 已定案与留给实施者的决定

已定案（builder check 后补充）：

- 设备控制启用条件 = 活动会话 AND `cpu`/`probe` 均已知；测试夹具必须显式写入 `device_status`。
- 回放中的 `pending` 审批冻结过期判断，显示「待审批（历史）」，不提供操作。
- live 网关使用临时 `HARNESS_HOME`，不写用户 home；默认 `qwen-turbo`，可覆盖。
- 终止失败路径在 win32 以既有 mock 用例作为逻辑证据，真实环境登记阻塞。

留给实施者：

- 回放间隔是否固定 250ms（本设计采用固定值，不引入速度选择）。
- 导出按钮与回放按钮的视觉细节复用现有 `.btn-ghost`，不新增布局。
- 设备指令文本的具体措辞可按 probe 工具描述微调，但不得改变“经会话 + 权限”的路径。
- 外部验证中第三方 MCP 的具体包（filesystem/git）由实施时按可用性选择，必须是非本仓库实现。