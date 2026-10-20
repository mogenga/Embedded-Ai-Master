# M2 事件总线设计（工作流 C）

> **注（2026-10-20 前端移植后）**：本 spec 的内核侧设计（事件模型、事件总线、SSE 服务端协议、MCP 设备状态发布）**已实现且仍然有效**；但文中引用的 `src/ui/**` 前端文件与 `npm run test:ui` / `typecheck:web` / `build:web` / `verify:ui` 命令**已随 Preact 工作台整体删除**。当前前端的事实源是 `docs/frontend-design.md` v2.0 与 `desktop/MATRIX.md`，前端测试命令是 `npm run test:desktop`。

> 日期：2026-10-19 · 状态：待评审 · 上游：[m2-roadmap.md](../../m2-roadmap.md) 阶段 1 第 3 项、[BRD.md](../../BRD.md) PLAT-8、[p0-kernel-design.md](../../p0-kernel-design.md) 事件流、[frontend-design.md](../../frontend-design.md) 实时/回放切换。
> 本轮交付终点：事件模型与新增事件类型、日志投影式事件总线、SSE 服务端协议、客户端游标/续传/合并、MCP 显式设备状态发布、实时工具/权限/MCP/设备状态投影与测试。不实现 Web 审批 API/UI。

## 1. 意图与为什么

诊断会话进行中，Web 工作台目前只能看到模型文本和工具结果；权限决策、MCP 连接状态、设备状态要等会话结束或重新拉取日志才可见。M2 要建立一条**实时、可续传、与回放同源**的事件通道，让操作者在探针/串口动作发生时立刻看到“谁在执行、是否被权限拦下、设备当前处于什么状态”。

已确认的产品决策（2026-10-19）：

- 事件总线**只做投影，不做推断**：设备状态由 MCP 工具显式发布，不从工具名、参数或结果文本猜测。
- 诊断过程中优先看到工具/权限/设备状态；回放是同一事件流的降级能力，不是另一套模型。
- 本轮只定义审批请求接口，不实现 Web 实时审批（按 m2-roadmap 阶段 2）。

## 2. 我的判断（用户未逐条确认，可被推翻）

1. **总线实现为“会话日志投影”**：`SessionHandle.append` 是唯一发布点，SSE 服务端读取/跟随 JSONL 日志。当前 `serve` 是独立只读进程，日志投影天然支持外部 `runSession` 进程，不需要先引入进程内 EventEmitter 或共享内存。未来需要更低延迟时可在同一 `SessionEventSource` 接口下增加进程内适配器。
2. **SSE 透传全部会话事件**，不另造一套“总线事件”联合类型；工具/权限/MCP/设备状态通过新增 `EventType` 表达。这样实时流与回放共用同一投影，避免两套字段漂移。
3. **设备状态载荷保持领域无关**：`device_status.payload.state` 是 MCP 工具显式给出的 JSON 对象；内核不解释 `probe/serial/cpu/backend`。UI 投影层读取它认识的字段，未知字段忽略。
4. **只做单会话流**：`/api/events` 必须带 `sessionId`；多会话复用/全局流留到需要时。
5. **轮询跟随**：默认 200ms 轮询日志新增内容，不依赖 `fs.watch`（Windows/网络盘行为不一致）；延迟上限约 250ms，满足“诊断过程中实时”。

## 3. 目标

1. 统一事件信封：`sessionId + seq + ts + type + payload + parent?`，SSE 每条事件带 `id: seq`。
2. 新增事件类型：`tool_started`、`mcp_status`、`device_status`；复用既有 `tool_result`、`permission_decision`。
3. 日志投影总线：从会话目录读取历史事件并跟随新增事件，支持 `since` / `Last-Event-ID` 游标、日志分代、会话关闭。
4. SSE 服务端：`GET /api/events?sessionId=...&since=...`，先补播再跟随；heartbeat、背压、显式错误与结束事件。
5. Web 客户端：按会话绑定、保存 `lastSeq`、断线续传、按 `seq` 去重、seq 缺口时重拉；实时事件合并进当前会话视图。
6. MCP 显式发布设备状态：工具通过 `structuredContent.deviceStatus` 提供状态对象；适配器校验后落 `device_status` 事件；不满足契约时显式记录状态，不猜测。
7. MCP 状态完整实时化：所有 `McpStatusKind`（含 `call_failed`、`listener_failed`、`attempts`）进入 `mcp_status` 事件。
8. 工具生命周期实时化：授权通过后、执行前写 `tool_started`；`tool_result` 保持既有日志字段（含 `toolName`、`evidence`、`artifactPath`）。

## 4. 非目标

- Web 审批按钮、`POST /api/approvals`、`approval_request` 的端到端审批（阶段 2 / D-112）。
- 进程间消息队列、Redis/NATS、多进程 fan-out、全局多会话事件流。
- 设备状态推断（从工具名、参数、文本结果、日志关键字推导）。
- 新的领域 MCP server；BR-2 的探针/串口实现。
- 修改 `LoopEvent` 的现有语义；demo 仍可用 `LoopEvent`。
- 历史日志迁移/重写；只保证旧日志可读。
- 事件保留策略、归档、跨机器同步。

## 5. 反目标

- 实时流与回放使用不同事件模型，导致同一动作两种字段。
- 断线后静默丢事件，或重连后重复插入。
- 无界内存队列；慢客户端拖垮服务端。
- 从工具名/参数推断设备状态并展示为事实。
- 项目级/第三方输入让 SSE 读取任意路径。
- 在 `tool_started` 写失败后仍执行工具。
- 把 `done` 当作流结束；迟到的 MCP 状态被丢弃。

## 6. 约束

- TypeScript + Node 24，ESM-only，相对导入 `.js`，strict；不新增依赖。
- 日志是唯一事实源；所有实时事件必须先成功落日志（`append` + fsync 尽力）再投影。
- 会话目录、ID 校验、日志分代与 seq 连续性沿用 `session/persistence.ts` 的既有规则。
- SSE 只绑定 `127.0.0.1` 的本地服务；不新增鉴权模型，但必须防路径穿越。
- 内核不含领域逻辑；设备状态字段名不进入内核解释。
- 测试默认离线；不得真实执行危险命令。

## 7. 事件模型

### 7.1 信封

```ts
export interface SessionEventEnvelope extends SessionEvent {
  sessionId: string;
}
```

`SessionEvent` 已含 `seq`、`ts`、`type`、`payload`、可选 `parent`。SSE 的 `data` 为信封 JSON；`id` 为 `seq`。`seq` 在会话内单调递增且跨日志代连续；实时流与回放的 `seq` 必须一一对应。

### 7.2 新增事件类型

```ts
export type EventType =
  | "system" | "user" | "assistant" | "tool_call" | "tool_started"
  | "tool_result" | "usage" | "checkpoint" | "status" | "mcp_status"
  | "device_status" | "interrupted" | "compaction" | "permission_decision";
```

- `tool_call` 保留为历史只读类型，不再产生新事件；新生命周期使用 `tool_started`。
- `tool_started` payload：

```ts
{ callId: string; tool: string; access?: ToolAccess }
```

- `mcp_status` payload：直接映射 `McpStatusEvent`，保留 `kind/server/tool/toolCount/message/attempts`。

```ts
interface McpStatusPayload {
  kind:
    | "connected" | "connect_failed" | "tools_changed" | "tools_refresh_failed"
    | "tool_invalid_schema" | "listener_failed" | "call_failed"
    | "config_failed" | "config_warning" | "project_config_skipped"
    | "tool_name_renamed";
  server?: string;
  tool?: string;
  toolCount?: number;
  message?: string;
  attempts?: number;
  name?: string;          // tool_name_renamed: 新名称
  originalName?: string;  // tool_name_renamed: 原名称
  scope?: "global";       // 全局工具刷新失败
}
```

后四类来自现有 `runSession` 的 MCP 配置/命名状态（`mcp_config_failed`、`mcp_config_warning`、`mcp_project_config_skipped`、`mcp_tool_name_renamed`），迁移时去掉 `mcp_` 前缀并把其余部分作为 `kind`；`message` 保留原值。

- `device_status` payload：

```ts
interface DeviceStatusPayload {
  callId: string;
  server: string;
  tool: string;                    // 完整工具名 mcp__server__tool
  state: Record<string, unknown>;  // MCP 显式给出的 JSON 对象，内核不解释
}
```

### 7.3 顺序

一次允许的工具调用在日志中的顺序：

1. `permission_decision`（允许/拒绝；由权限层保证）
2. `tool_started`（仅允许时；写失败则不执行）
3. `tool_result`
4. `device_status`（仅当工具显式发布且结果成功；在 `tool_result` 之后）

`mcp_status` 与调用生命周期可交错；`done`/`interrupted` 之后仍可能出现迟到的 `mcp_status`（`statusQueue` 串行、query 不等待）。客户端以 `stream_end`/header 关闭作为流结束，不以 `done` 判断。

## 8. 生产点

### 8.1 会话写入

`SessionHandle.append` 仍是唯一写入点；投影层只读日志，不订阅 `append` 回调。这样 `runSession` 在独立进程时也能被 `serve` 实时读取。

### 8.2 工具生命周期

- `tool_started`：在**每个调用真正执行前**通过 `onToolStarted(call, access)` 写日志，位置在 `executeAuthorized` 内、`execute` 之前（不是授权阶段的批量预写）。回调失败时该调用不执行，异常上抛；已开始的其他并发调用可能已执行，但不会留下“写了 started 却从未执行”的孤儿事件。`access` 来自 `decision.access`；没有 permission gate 时用 `tool.access?.(parsed.data) ?? "unknown"`。
- 拒绝/Ignored/skipped 的调用不写 `tool_started`。
- 并发批次中多个 `tool_started` 可在授权完成后交错写入；每个调用的相对顺序仍是 `permission_decision → tool_started → tool_result`。
- `tool_result` 沿用现有 payload，保留 `toolName/evidence/artifactPath/detail`；SSE 不再经过 `LoopEvent` 的有损转换。

### 8.3 权限

`permission_decision` 已落日志，投影层直接发送。`approval_request` 仅作为阶段 2 的保留类型，不在本轮产生；库层 `PermissionPrompter` 的等待不改变日志投影语义。

### 8.4 MCP 状态

- `runSession` 的 MCP 状态写入从通用 `status` 改为 `mcp_status`，payload 使用 `kind` 而非 `status` 字符串。
- 补齐当前被丢弃的 `call_failed`、`listener_failed`，保留 `attempts`；`tool_invalid_schema`、`tools_refresh_failed`、`tools_changed` 等全部进入流。
- 迁移器输入同时接受 `McpStatusEvent`（manager 的 7 种）与 `runSession` 的 `McpSessionStatus`（`mcp_config_failed` 等 4 种）；`tool_name_renamed` 保留 `name/originalName`，全局刷新失败保留 `scope: "global"`。
- 旧日志中的 `status` + `mcp_*` 仍可读；UI 同时识别两种形式。新代码不再写旧的 MCP `status`。

### 8.5 设备状态

见 §10。生产点必须在 MCP 适配器/查询层，不能在总线里从工具名或参数推断。

## 9. 日志投影总线

### 9.1 接口

```ts
export interface SessionEventSource {
  read(sessionId: string, since: number): Promise<{
    header: SessionHeader;
    events: SessionEventEnvelope[];
  }>;
  follow(
    sessionId: string,
    since: number,
    signal: AbortSignal,
  ): AsyncIterable<SessionEventEnvelope>;
}
```

- `since` 为**排他**游标：返回 `seq > since` 的事件；`-1` 表示从头。
- `read` 用于首连补播与 404/损坏判断；`follow` **先发出自己快照中 `seq > since` 的事件**（覆盖 `read` 与 `follow` 之间新增的事件），再进入增量读取。两个方法各自独立取快照，允许少量重复，由客户端按 `seq` 去重；禁止出现缺口。
- `follow` 初始化时必须读取容错快照的 `pendingTail`，把该代 offset 回退到半行起始位置并放入行缓冲；不得把 offset 直接设到文件末尾，否则半行补全后会漏事件。

### 9.2 LogTailEventSource（本轮唯一实现）

- 会话目录：`$HARNESS_HOME/sessions/<id>`。先对 `sessionsRoot` 与目标目录做 `realpath`，用与 `GET /api/sessions/:id` 相同的包含性判断（目标必须是 `sessionsRoot` 的直接子目录），拒绝 symlink/junction 逃逸；拒绝时不暴露真实路径。
- 首连：读取 header 与所有完整事件行，过滤 `seq > since`，并记录每代文件的**完整事件末尾 offset** 与尾部半行的起始 offset；`follow` 必须使用这份快照 offset，不能事后 `stat` 现推。**允许一个尾部未完成行**（无换行且 JSON 不完整）：header 为 `open` 时把它留作跟随阶段的缓冲，不判损坏；header 为 `closed` 时，若最后一行无换行但能完整解析为 JSON 事件则按完整事件处理，只有 JSON 不完整才按 `SessionCorruptionError` 处理。`GET /api/sessions/:id` 对 open 会话也使用容错快照（closed 仍严格），否则运行中首次打开 Web 会先在详情接口 500。
- 跟随：默认 200ms 轮询当前代文件的新增字节；维护 `{generation, offset}`，只解析完整行；不足一行时保留缓冲。读取用 `Buffer` 累积，只在最后一个 `0x0A` 处分行后按 UTF-8 解码，避免中文多字节字符跨块被截断。
- 分代：检测到 `session.v(N+1).jsonl` 时从新代 offset 0 继续；seq 必须连续，否则抛 `SessionCorruptionError`。
- 截断：检测到当前代文件小于已记录 offset 时从该代 offset 0 重扫；按 `seq` 去重，不因重复 seq 报错（仅对新增事件要求连续）。
- 关闭：header `status === "closed"` 且已读完所有代的新增内容后结束迭代；不因 `done` 事件提前结束。
- 损坏：完整行解析失败、seq 不连续、closed 会话的尾部不完整，均抛错；SSE 转成 `stream_error` 并关闭，客户端重连后重新校验。
- 性能：轮询只读增量字节；大日志不重复全量解析。若文件被外部截断（非正常使用），从该代 offset 0 重扫并依赖 seq 去重。

### 9.3 进程内低延迟（非目标）

本轮不引入 `EventEmitter`/共享注册表；未来可在 `SessionEventSource` 下增加进程内适配器，SSE 与客户端不变。

## 10. MCP 显式设备状态契约

### 10.1 发布格式

MCP 工具在**成功**结果（`isError !== true`）的 `structuredContent` 中返回：

```json
{
  "deviceStatus": {
    "probe": "attached",
    "serial": "open",
    "cpu": "halted",
    "backend": "renode"
  }
}
```

- 仅当 `structuredContent` 是对象且存在 `deviceStatus` 键时进入校验：`deviceStatus` 必须是普通 JSON 对象（非数组/null）。
- 序列化后 ≤ 8 KiB、嵌套深度 ≤ 4；超出或类型不符时不产生 `device_status`，并写 `status` 事件 `{status:"device_status_invalid", tool, message}`（显式、可审计）。
- `structuredContent` 非对象或缺少 `deviceStatus` 键时静默跳过，不产生任何状态事件。
- `state` 的键与值完全由 MCP server 决定；内核与总线不解释、不补全、不推断。
- 可选的 `outputSchema` 由 server 自行声明；客户端仍执行上述信封校验，避免信任第三方 schema。

### 10.2 适配与落盘

- `McpManager` 的 `McpCallResult` 新增 `structuredContent?: unknown`，在 `callTool` 结果转换时原样透传；保留既有“content 为空时把 structuredContent 序列化进 text”的兼容行为，模型仍能看到结构化输出，设备状态改用 raw 通道而非从 text 反解。`mcp/tools.ts` 在成功时读取 `structuredContent.deviceStatus`，校验后附加到工具结果（`ToolResult.deviceStatus = { server, state }`）。
- `query` 在写 `tool_result` 后写 `device_status`，`parent` 指向同一 assistant 事件；`server` 来自 MCP 工具身份，`tool` 为该工具注册后的完整名称（冲突重命名时可能是 `..._<hash>`）。跨层关联以 `callId` 为准，不以工具名反推原始身份。
- 工具失败、被权限拒绝、超时、取消：不产生 `device_status`。
- UI 只消费 `device_status`，不从 `attach/reset/mem_read` 等工具名推导状态。

## 11. SSE 协议

### 11.1 端点

`GET /api/events?sessionId=<id>&since=<seq>`

- `sessionId` 必填；非法 ID → 400 `invalid_session_id`。ID 规则统一使用 `session/handle.ts` 的 `isValidSessionId`（比现有 API 的宽松正则更严格，`.`/`..` 与 symlink 均拒绝）。
- `since` 可选，整数 ≥ -1；非法 → 400 `invalid_cursor`。`since` 大于会话当前最大 `seq` 时夹紧到该 `seq`（从尾部继续跟随），不报错。
- 无 `since` 时读取 `Last-Event-ID`；两者都有时 query 优先；两者都缺省时 `since = -1`。
- `Last-Event-ID` 非法（非整数、<-1）→ 400 `invalid_cursor`，不回退为 -1。
- 会话不存在 → 404 `session_not_found`；日志损坏 → 500 `session_corrupt`（与现有 API 错误模型一致）。
- 仅本地服务；响应头：

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

### 11.2 帧格式

```
retry: 1000

id: 12
data: {"sessionId":"...","seq":12,"ts":"...","type":"tool_started","payload":{...}}

: ping

event: stream_end
data: {"lastSeq":42}

event: stream_error
data: {"code":"slow_consumer","lastSeq":37}
```

- 普通事件使用默认 `message` 事件类型；`id` 为 `seq`；`data` 为单行 JSON。
- 心跳每 15s 一条注释 `: ping`；写失败即关闭。
- 会话关闭且补播完成后发 `stream_end` 并关闭；客户端主动断开/abort 不发送 `stream_end`。
- `follow` 迭代中抛错（损坏、seq 不连续、closed 尾部不完整）→ 发 `stream_error` `{code:"session_corrupt"|"internal_error", lastSeq}` 后关闭；不得只关闭连接。
- **`lastSeq` 是已成功写入并 flush/drain 的最大 seq**，不是从日志读到的最新 seq；慢消费者重连时从真正送达的位置补播。
- **补播与实时增量的背压分开**：补播阶段直接写响应并等待 `drain`，不进入 500 条队列，避免长断线后“补播再次溢出”的活锁；实时增量使用每连接有界队列 500 条，溢出发送 `stream_error` `{code:"slow_consumer", lastSeq}` 后关闭。客户端用 `lastSeq` 重连补播，不丢数据。
- **实时阶段单帧写超时**：实时增量同样给每一帧写入设超时（默认取补播超时，30s）。到期即按慢客户端处理——发 `stream_error` `{code:"slow_consumer", lastSeq}` 后关闭。没有这条，完全不读的客户端会让 `drain` 等待永不返回，队列溢出分支永远不可达，`slow_consumer` 与连接关闭都不会发生（2026-10-20 复验修复）。
- 补播本身受客户端断开信号约束：等待 `drain` 必须与 `AbortSignal` 竞速，断开时立即停止写入并走 `finally` 清理；补播阶段每帧同样有写超时，超时即关闭连接。
- 客户端断开通过 `AbortSignal` 终止轮询与文件读取；handler 在 `finally` 清理心跳 timer、队列与监听器。

## 12. 客户端

### 12.1 连接与游标

- 每个活动会话一个流；URL 用 `URL`/`searchParams` 追加 `sessionId` 与 `since`，已有查询参数不得被覆盖。
- 连接顺序：`GET /api/sessions/:id`（open 会话使用容错读取）取得历史事件 → 记录 `lastSeq` → 打开 SSE `since=lastSeq`。历史与实时之间的窗口由 `follow` 的快照+增量补齐。
- **游标由事件流客户端独占**：它维护 `lastSeq`、按 `seq` 去重、检测缺口、决定重连 `since`；`state` 只接收已接受事件并追加，不重复维护游标。流的接口提供 `initialSince` 与可注入的 `EventSourceCtor`/`retryMs` 测试 seam。
- 重连：保留 `lastSeq`，重新建流；按 `seq <= lastSeq` 丢弃重复。
- 缺口：收到 `seq > lastSeq + 1` 时触发 `onGap`，关闭流并由上层重新拉取整个会话，避免静默拼接错误。
- 切换会话/卸载：`main.tsx` 必须 `close()` 旧流；`applySessionEvent` 首行检查 `event.sessionId === activeSessionId`，不匹配直接忽略；重置事件数组、`lastSeq=-1`、设备为 unknown。
- `stream_end`：停止重连，显示完成态；`stream_error`：显示错误并按上限重连。连接错误与 seq 缺口使用不同回调（`onError` / `onGap`）。
- `LoadedWorkbench`/`loadSessionView` 明确返回 `events: SessionEvent[]` 与 `lastSeq: number`，供 `main.tsx` 建立流与 `deviceFromSession` 使用。

### 12.2 视图合并

- 以当前会话的 `SessionEvent[]` 为唯一视图输入，历史与实时都追加到同一数组，统一交给 `transcriptFromSession` 投影；移除 `liveView` 与 `replayView` 两套互相覆盖的状态。
- `tool_started`：对应工具卡进入“执行中”；`tool_result` 完成/失败。
- `permission_decision`：在会话/守卫区显示工具、动作、最终结果与理由；`action=ask,effective=deny` 需能看出是被拒绝而非未执行。
- `mcp_status`：进入调试坞/状态区，不进入对话正文。
- `device_status`：新增纯投影 `deviceFromSession(events)`，按 `seq` 顺序折叠 `state`；每个 `state` 是**部分更新**（patch）：提供的已知字段覆盖，缺失字段保留；新会话/切换会话从四个 `unknown` 开始，不继承上一会话。`DeviceStatus` 仍是 `probe/serial/cpu/backend` 四个字符串字段，已知字段的非字符串值忽略，未知键忽略；不推断。
- 页面重载：先由历史事件的 `deviceFromSession` 重建设备面板，再接入 SSE；不得用恒为 unknown 的 `/api/device` 覆盖已有事件投影。`/api/device` 仅作为“未选中会话/尚无 device_status”时的兼容占位。
- `tool_result`/`assistant` 的既有投影保持不变。

## 13. 兼容性与失败语义

- 旧日志：无 `tool_started/mcp_status/device_status` 时正常回放；旧 MCP `status` 继续识别。
- 新事件类型必须加入持久化白名单、`buildMessages` 忽略分支、前端投影；任一遗漏都会导致下一轮/回放失败。
- `tool_started` 写失败：该调用不执行，异常上抛；并发批次中已开始的其他调用可能已执行，但不会为失败调用留下“已 started 未执行”的孤儿。
- `device_status` 写失败：工具已执行但事件未落盘；按会话持久化失败处理，不伪造状态。实现顺序必须是：写 `tool_result` → 从 `pending` 账本移除该 call（或记录 `writtenResultIds`）→ 写 `device_status`。这样 `device_status` 失败时 catch 不会为同一 call 再补一条 `tool_result_lost`，日志仍可回放（每个 call 恰好一条 `tool_result`）。
- `mcp_status` 写失败：按**观测性降级**处理——`appendMcpStatus` 返回可观测的失败结果并写 stderr，会话继续；MCP 状态不是权限/工具审计，不能因诊断通道故障中止正在进行的诊断。测试通过注入/fake session 让 `mcp_status` 单独失败，断言工具继续执行、会话不中止、失败可观测。
- **证据不单列事件**：本轮的 evidence 由 `tool_result.payload.evidence/artifactPath/detail` 承载，SSE 直接透传；不新增 `evidence` 事件，避免与 `tool_result` 重复。若后续证据面板需要独立订阅/分页，再增加 `evidence` 类型（登记 deferred）。
- SSE 只读日志，不修改会话；断线不丢事件。
- 设备状态事件来自非可信 MCP server：只接受满足契约的对象，永不执行其内容。

## 14. 测试策略

### 14.1 单元

- `LogTailEventSource`：首连过滤、增量追加、分代切换、半行缓冲、文件截断重扫、关闭结束、损坏抛错；open 会话的尾部半行不报错、closed 会话的尾部半行报错（可完整解析但无换行按完整事件处理）。
- 交接窗口：`read` 之后、`follow` 之前追加事件，`follow` 必须首先发出该事件；`pendingTail` 补全后不得漏事件。
- 中文多字节字符跨读取块：按完整行/UTF-8 解码后不出现替换字符或误判损坏。
- 路径安全：symlink/junction 会话目录被拒绝（参考 `tests/server/api.test.ts`）。
- SSE：首连补播、`Last-Event-ID`、query 优先、非法 cursor/header、404、心跳、慢客户端溢出、`stream_end`、断开清理；大补播不受 500 条队列限制；`follow` 迭代中损坏 → `stream_error`；`lastSeq` 是已写出并 flush 的最大 seq。
- 客户端：去重、缺口 `onGap` 重拉、`onError` 重连、会话切换关闭旧流并按 `sessionId` 过滤、URL 查询参数合并、`stream_end` 停止重连；设备投影按 patch 折叠、重载重建、切换会话归零。
- 设备状态：合法对象、非对象、数组、超大（>8KiB）、深嵌套、失败结果不发布、非法时状态事件、`state` 原样透传、patch/缺字段保留语义。
- MCP 状态：11 种 kind（7 种运行时 + 4 种配置/命名）全部产生 `mcp_status`，`attempts/name/originalName/scope` 保留；写失败可观测且不影响工具执行；迟到 `mcp_status` 仍被流接收。

### 14.2 集成

- `runSession`（fake model + fake MCP source）产生 `permission_decision → tool_started → tool_result → device_status`，写入真实临时 `HARNESS_HOME`。
- 用真实 `createUiServer` + `LogTailEventSource` 读取该会话，`fetch /api/events` 断言顺序；断开后带 `since` 重连不重复、不丢。
- 同一会话的 SSE 合并结果与 `transcriptFromSession(events)` 一致；切换会话不串台。
- MCP fake source 返回 `structuredContent.deviceStatus`，经真实工具管线与查询层落 `device_status`；非法状态产生 `device_status_invalid`。
- UI：含全部新事件类型的会话可投影；权限拒绝/允许可见；MCP 状态进入调试坞；设备面板随事件更新。

### 14.3 验证命令

`npm test`、`npm run coverage`（lines ≥85%）、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:ui`、`npm run typecheck:web`、`npm run build:web`；UI 改动较大时运行 `npm run verify:ui`（需 Chrome/Edge）。

## 15. 交付边界

- 代码：`src/session/types.ts`、`src/session/persistence.ts`、`src/context/build.ts`、`src/loop/query.ts`、`src/tools/pipeline.ts`、`src/mcp/tools.ts`、`src/mcp/manager.ts`、`src/index.ts`、`src/server/*`、`src/ui/api/*`、`src/ui/state.ts`、`src/ui/view/*`。
- 新模块建议：`src/events/`（信封、source、log-tail）或 `src/server/event-stream.ts` + `src/ui/api/event-stream.ts`。
- 文档：README 事件流章节、`docs/frontend-design.md` 的实时投影、`docs/deferred-issues.md` 登记性能/多会话/进程内低延迟/独立 evidence 事件/Web 审批后续项。
- 不实现 Web 审批 API/UI；不合并 `main` 前需用户确认。

## 16. 验收锚点

1. 诊断会话运行中打开 Web：工具开始/完成、权限拒绝/允许、MCP 状态、设备状态在 ≤1s 内出现。
2. 断线后重连带 `since`：不重复、不丢事件；seq 缺口触发重拉。
3. 回放与实时对同一会话产生一致的 `TranscriptView`；旧会话可读。
4. 设备面板只随 `device_status` 变化；patch 缺字段保留、切换会话归零、页面重载可从日志重建；没有显式状态时保持 unknown。
5. `mcp_status` 覆盖全部 11 种 kind；`call_failed/listener_failed` 不再丢失；状态写入失败不中止诊断。
6. 慢客户端不会拖垮服务端；大补播不受实时队列限制；溢出后可通过 `lastSeq` 重连补齐。
7. 会话运行中首次打开 Web（详情接口 + SSE）不因尾部半行返回 `session_corrupt`。
8. `read` 与 `follow` 交接窗口不丢事件；`follow` 先发出快照中 `seq > since` 的事件。
9. symlink/junction 会话目录被事件源拒绝，不读取外部文件。
10. 全部验证命令通过；危险命令测试禁令未被违反。

## 17. 留给实现者

- `LogTailEventSource` 的文件增量读取与分代检测实现细节（建议每代维护 offset，完整行缓冲）。
- SSE 写入背压的具体实现（`ServerResponse.write` 返回值 + drain/队列）。
- 客户端重连退避策略（当前 1s 固定；可加指数退避上限）。
- 事件投影到 `TranscriptView` 的具体组件形态。