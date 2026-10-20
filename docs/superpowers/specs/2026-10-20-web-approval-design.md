# M2 Web 审批闭环设计（PLAT-5 阶段 2）

> 日期：2026-10-20 · 状态：待评审 · 上游：[m2-roadmap.md](../../m2-roadmap.md) 阶段 2 第 4 项、[BRD.md](../../BRD.md) PLAT-5 / R2 / R3、[permission-system-design.md](./2026-10-19-permission-system-design.md) 阶段 1、[event-bus-design.md](./2026-10-19-event-bus-design.md) 实时流、[deferred-issues.md](../../deferred-issues.md) D-112 / D-137 / D-139。
> 本轮交付终点：Web 进程内最小会话运行器（发起会话 / 追加输入）、`approval_request` 事件、`POST /api/approvals` 回传、最简审批 UI，以及 `POST /api/actions` 从 501 落地。审批沿用既有 gate 队列、超时与 `permission_decision` 审计，不新造权限模型。

## 1. 意图与为什么

阶段 1 已把“是否允许执行”变成真实安全边界，但审批通道只有库层 `PermissionPrompter`：headless 与 Web 后端都没有注入器，`ask` 直接落 `approval_unavailable` 的 deny。Web 工作台只读日志，既不能发起会话，也不能在诊断过程中批准一次写内存或复位。

本轮要让操作者在浏览器里完成一次真实的审批闭环：模型发起 `ask` 工具 → 页面出现待审批卡片 → 点击批准 → 工具执行并留下完整审计；拒绝、超时、会话中断都必须在页面上有明确结果，不能伪装成成功或静默消失。

已确认的产品决策（2026-10-20）：

- **范围**：完整闭环，包含最小 Web 会话运行器；顺带落地 D-139 `/api/actions`。
- **安全**：审批与动作端点沿用 loopback `Host`/`Origin` 校验，但写端点**强制要求 `Origin` 存在且为 loopback**，不引入 token。
- **UI**：最简实现，复用现有守卫区视觉，不追求新布局。
- **审批语义**：复用阶段 1 的 gate；deny 恒胜、审计先于执行、超时/取消 fail-closed 均不变。

## 2. 目标

1. Web 进程内最小运行器：按会话串行运行 `runSession`，支持新建会话与对已有会话追加输入；同一会话并发请求显式拒绝。
2. `approval_request` 成为正式会话事件并先落日志，再由 SSE 投影到浏览器；payload 不含参数原文，只用既有参数摘要。
3. `POST /api/approvals` 接受 `{ sessionId, requestId, decision }`，把决策送回正在等待的 gate；超时、已决、未知请求有稳定错误码。
4. `POST /api/actions` 接受 `{ text, sessionId? }`，返回 202 与 `sessionId`；缺省新建，带 `sessionId` 则对该会话追加输入。
5. 前端新增待审批卡片：工具、动作、理由、参数摘要、截止时间；批准/拒绝按钮有提交中与失败态；最终状态以 `permission_decision` 为准。
6. 运行器在缺少模型配置时显式失败（503），不得伪造受理成功。
7. 测试覆盖运行器、审批桥、HTTP、事件投影、UI 与真实 `runSession` 的端到端闭环。

## 3. 非目标

- 审批记忆（allow for session / always）与持久化授权。
- 多用户、远程访问、token/CSRF 之外的更强鉴权。
- 审批队列可视化排序（gate 本身串行，同一会话一次最多一个待审批请求）。
- 浏览器断开即取消审批；以 gate 的 `approvalTimeoutMs` 兜底。
- 多会话全局事件流、`/api/sessions` 实时推送、会话重命名/删除。
- Web 端模型/权限配置编辑器；模型与权限仍由 `HARNESS_HOME` 配置文件决定。
- 领域工具与设备后端（BR-2）；审批只作用于已注册工具。

## 4. 反目标

- 为了让审批可用而放宽默认 `diagnose` 预设或让 `ask` 在无通道时挂起。
- HTTP 受理后不落日志、不执行却返回“已批准”；或审批成功但缺少 `permission_decision`。
- 重复提交同一审批造成二次执行，或把超时后的迟到决策当作有效。
- 审批事件包含完整参数原文、文件内容或凭据。
- 任意网页通过跨源 POST 驱动本地审批。
- 会话运行失败时静默丢弃；页面停留在“运行中”而无任何错误披露。

## 5. 约束

- TypeScript + Node 24，ESM-only，相对导入 `.js`，strict；不新增依赖。
- 只改平台层；审批桥与运行器不得含嵌入式领域逻辑。
- 日志是唯一事实源：`approval_request` 必须先成功 `append` 才能等待审批；`append` 失败按 `approval_error` deny。
- 复用 `gate.ts` 的串行队列、入队计时、abort 传播；不复制第二套审批状态机。
- 危险命令测试禁令继续生效：审批拒绝用例只断言 mock `execute`/`manager.call` 未被调用。
- 内核 `src/index.ts` 只增加最小注入点，不 imports `src/server`。

## 6. 总体数据流

```
POST /api/actions ──► SessionRunner ──► runSession(generator)
                                          │
                                          ├─ gate.check(action=ask)
                                          │     ├─ append approval_request  ──► 日志 ──► SSE ──► UI 卡片
                                          │     └─ WebPrompter 等待 ◄── POST /api/approvals ◄── 点击
                                          ├─ append permission_decision
                                          └─ execute 工具（仅 allow）
```

- 运行器与审批桥都在 Web 服务进程内；SSE 仍只读日志，不新增推送通道。
- 每次 `POST /api/actions` 触发一次 `runSession`；同一会话的多次请求按到达顺序串行，运行期间再次提交返回 409。
- `requestId` 即工具调用的 `callId`；同一会话内由模型工具调用 id 唯一性保证。

## 7. 会话运行器

### 7.1 模块与接口

新增 `src/server/runner.ts`：

```ts
export interface SessionRunnerOptions {
  harnessHome: string;                 // 同时传给 runSession.home，保证读写同源
  model?: string;                      // 缺省 HARNESS_WEB_MODEL 或 providers 第一个引用
  providersText?: string;              // 测试注入
  fetchImpl?: typeof fetch;            // 测试注入
  maxTextLength?: number;              // 默认 8000 字符
  readyTimeoutMs?: number;             // 默认 10000
  runSessionImpl?: typeof runSession;  // 测试注入
  cwd?: string;                        // 仅新会话生效；追加会话回落到 header.workdir
}

export interface ActionInput {
  text: string;
  sessionId?: string;                  // 缺省 = 新建会话
}

export type ActionOutcome = { sessionId: string; created: boolean };

export type DecideOutcome =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  | { kind: "unknown_session" }
  | { kind: "unknown_request" }
  | { kind: "expired" }
  | { kind: "already_decided" };

export interface SessionRunner {
  start(input: ActionInput): Promise<ActionOutcome>;
  decide(sessionId: string, requestId: string, decision: "allow" | "deny"): Promise<DecideOutcome>;
  close(): Promise<void>;
}

export function createSessionRunner(opts: SessionRunnerOptions): SessionRunner;
```

### 7.2 行为

- `start` 校验：`text` 为字符串、去空白后非空、长度 ≤ `maxTextLength`（默认 8000）；否则抛 `RunnerInputError(code: "invalid_text")`。HTTP body 上限为 64 KiB，足以容纳 8000 个 UTF-16 单元的最坏 JSON 转义（约 48 KiB），因此上限不会在校验前误伤合法输入。
- **受理边界**：`start` 必须等到会话 `header.json` 已落盘（即 `runSession` 调用 `onSession` 之后）才返回 202。实现用 readiness promise + 运行 promise 竞速；`readyTimeoutMs`（默认 10s）内未就绪则 abort 并抛 `session_start_timeout`。generator 在就绪前失败时把错误映射为对应的受理前错误（模型/配置），不留半成品会话目录由 `runSession` 自身清理。无法归类的启动失败（会话锁冲突、日志损坏、IO）保留现有 `model_unavailable` HTTP code 以维持契约，但 message 必须明确「会话启动失败」而不是声称模型不可用。
- `sessionId` 缺省：生成 `randomUUID()`，作为新会话 id 传给 `runSession({ sessionId })`，返回 `created: true`。
- 带 `sessionId`：先校验 `isValidSessionId`，再检查 `<harnessHome>/sessions/<id>/header.json` 是否存在；**header 检查先于 providers 解析**，未知会话优先返回 404，而不是 providers 缺失的 503。错误分型：`ENOENT` / `ENOTDIR` → `unknown_session`；header 损坏（`SessionCorruptionError`）→ `session_corrupt`（message 以「会话 header 损坏」开头）；`EACCES` / `EPERM` → `session_unreadable`（message 固定为「会话不可读」，不回传底层错误文本）；其他错误原样抛出，不伪装成未知会话。存在则读取 header，**使用 `header.model` 作为模型引用、省略 `cwd`**（让 `runSession` 回落到 `header.workdir`），调用 `runSession({ resume: true, sessionDir, sessionId })`，返回 `created: false`。header 无 `model` 时回落到默认模型。
- 同一 `sessionId` 已有运行中的 promise → `session_busy`；运行 promise settle 后从注册表移除，并允许下一次追加。
- `close()` 之后的 `start` 抛 `runner_unavailable`（HTTP 503），与未注入 runner 的场景共用同一 code。
- 运行器维护 `Map<sessionId, RunningSession>`，`RunningSession` 含 `controller: AbortController`、`completion: Promise<void>`、`ready: Promise<void>`、`bridge: ApprovalBridge`。
- 模型：`model` 选项 > `HARNESS_WEB_MODEL` > `providers.json` 中按 `Object.keys` 顺序的第一个 `<provider>/<model>`；追加会话优先用 `header.model`。runner 在受理前预加载 providers 并 `resolveModelRef` 校验，结果通过 `providersText` 传给 `runSession`，避免受理后才发现配置错误。providers 缺失、JSON/schema 错误、引用无效统一映射为 503 `model_unavailable`（message 区分原因）；不返回 500。
- home：runner 把自己解析出的 `harnessHome` 通过新增的 `RunOptions.home` 传给 `runSession`，保证 header 检查、会话目录、providers 读取同源；不要依赖 `resolveHarnessHome()` 的隐式环境变量。
- cwd：新会话用 `cwd` 选项 > `process.cwd()`；追加会话不传 `cwd`。新会话 workdir 由 `runSession` 写入 header。
- 运行：后台 `for await (const _ of runSessionImpl(...))` 消费 generator，事件已由 `runSession` 写入日志；运行错误写入 `process.stderr`（含 sessionId 与 message），不向 HTTP 响应回传，也不伪造日志。`runSession` 自身在错误路径写 `interrupted`。
- `close()`：abort 所有运行中会话并等待其 completion，最长 5s；超时后放弃等待并返回。用于 `createUiServer` 关闭。

### 7.3 审批桥

新增 `src/server/approvals.ts`（可与 runner 同文件，实现者决定）：

```ts
export interface ApprovalBridge extends PermissionPrompter {
  bindSession(session: SessionHandle): void;
  decide(requestId: string, decision: "allow" | "deny"): DecideOutcome;
  pendingCount(): number;
  close(): void;
}
```

- 每个运行中的会话一个 bridge，作为 `permissions.prompter` 传入 `runSession`。
- `bindSession` 由 `runSession` 新增的 `onSession` 回调触发；未绑定即收到审批请求时返回 `deny`（fail-closed），不写事件。
- `request` 流程：
  1. 用 `requestId = req.callId`；若已存在同 id pending，按内部错误 deny（防御）。
  2. `session.append({ type: "approval_request", payload })`；失败则抛错（gate 映射 `approval_error`，工具不执行）。
  3. 登记 pending `{ resolve, requestId, deadlineAt, settled: false }`，监听 `req.signal`。
  4. 返回一个 Promise，只可能以 `"allow"` / `"deny"` settle；signal abort 时清理并 resolve `deny`（gate 的 race 已先行 settle，迟到结果被忽略）。
- `decide`：
  - pending 存在 → 标记 settled、clear pending、resolve 决策，返回 `accepted`。
  - 不存在但本会话 `settled` 表中有同 id → 与首次决策相同返回 `duplicate`，不同返回 `already_decided`。
  - 不存在且未记录 → `expired`（若该 id 曾登记但已因超时清理）或 `unknown_request`。实现用「settled 表（保留 5 分钟 / 最多 256 条）+ pending 表」区分：超时/abort 时写入 settled 表（outcome 非用户决策），用户决策也写入。
  - 会话不在运行器注册表 → `unknown_session`（由 runner 层返回）。
- `close`：清理所有 pending（不再 resolve 用户决策，由 abort 路径统一 deny），清空 settled 表。
- 参数摘要复用 `PermissionPrompter` 扩展后传入的 `paramsDigest/paramsKeys/paramsPreview`，bridge 不重新计算。

## 8. 权限层最小扩展

### 8.1 `PermissionPrompter` 入参

```ts
export interface PermissionPromptRequest {
  requestId: string;        // 每次 check 生成的独立 UUID，与 callId 解耦
  callId: string;           // 模型工具调用 id，可跨轮复用
  tool: string;
  args: unknown;
  reason: string;
  preset: PermissionPreset;
  access: ToolAccess;
  deadlineAt: string;       // ISO；gate 入队时计算
  paramsDigest: string;
  paramsKeys: string[];
  paramsPreview?: Record<string, unknown>;
  signal: AbortSignal;
}
```

- `gate.ts` 在 `check` 中为每次审批生成 `requestId = randomUUID()`；`callId` 保持模型原始值。同一 `callId` 跨轮复用不会让两次审批共享标识（迟到决策、崩溃恢复配对都按 `requestId`）。
- `PermissionRequest` 同步增加 `requestId: string`，`permission_decision` 写入该值。
- `gate.ts` 在调用 prompter 时传入上述完整对象；`deadlineAt` 由入队时计算出的 deadline 转 ISO。
- 这是 additive 扩展：现有 prompter 实现忽略额外字段仍可用。既有精确断言需同步更新。
- `approvalTimeoutMs`、串行队列、abort、错误限长逻辑不变。

### 8.2 `runSession` 注入点

```ts
export interface RunOptions {
  // ...既有字段
  home?: string;                        // 缺省 resolveHarnessHome()
  onSession?: (session: SessionHandle) => void;
}
```

- `home` 用于让宿主显式指定 `HARNESS_HOME`，`runSession` 内部所有 `resolveHarnessHome()` 调用改用它；缺省行为不变。
- `onSession` 在 `createSession` / `resumeSession` 成功后、首个 `append` 之前、`try` 块内调用；回调抛错按启动失败处理，`finally` 负责关闭会话与释放锁。失败发生在 `query` 启动前时，`runSession` 在会话日志追加 `{ type: "interrupted", payload: { reason: "start_failed" } }`（append 自身失败被吞掉，不覆盖原始错误）。
- 仅用于宿主绑定会话（本轮是 Web 审批桥），不加领域逻辑；`docs/deferred-issues.md` 记录“暴露 handle 给宿主”的边界。

## 9. 事件模型

### 9.1 新增 `approval_request`

`EventType` 与 `persistence.EVENT_TYPES` 同步加入 `"approval_request"`。

```ts
export interface ApprovalRequestPayload {
  requestId: string;
  callId: string;
  tool: string;
  action: "ask";
  effective?: never;                 // 不预判结果
  access?: ToolAccess;
  reason: string;
  preset: PermissionPreset;
  paramsDigest: string;
  paramsKeys: string[];
  paramsPreview?: Record<string, unknown>;
  deadlineAt: string;
}
```

- 不包含 `args` 原文；`reason` 非空；`paramsPreview` 沿用阶段 1 的 4096 字节预算与 `previewTruncated` 标记。
- 顺序：`approval_request` → （等待）→ `permission_decision` → `tool_started` → `tool_result`。
- `context/build.ts` 忽略该类型（与 `permission_decision` 同组），不进入模型消息。
- `ui/view/transcript.ts` 投影规则：
  - `approval_request` → `{ kind: "approval", approval: { requestId, callId, tool, reason, preset, paramsPreviewText?, deadlineAt, status: "pending" } }`。
  - `permission_decision` 到达时优先按 `payload.requestId` 匹配 pending approval：更新其 `status`（`allow` → `allowed`；`deny` 且 `reason` 以 `approval_timeout` 开头 → `expired`；`deny` 且 `reason` 以 `approval_aborted` 开头 → `aborted`；其他 deny → `denied`），不再额外生成 `permission` 事件。只有旧日志缺 `requestId` 时才回退到同 `callId` 最近一个 pending approval；工具卡片始终按 `callId` 更新。
  - 找不到对应 approval 时保持现有 `permission` 事件行为。
- `paramsPreviewText` 由投影层把 `paramsPreview` 扁平化为 `key=value` 文本（字符串截断 200 字符，最多 8 个键），仅用于展示，不写回日志。

### 9.2 崩溃恢复

- `planCrashRecovery` 增加：扫描日志中无对应 `permission_decision` 的 `approval_request`，在既有恢复批次中补一条：
  ```ts
  { type: "permission_decision", payload: {
      requestId, callId, tool, action: "ask", effective: "deny",
      reason: "approval_aborted: crash_recovery", preset, source: "builtin",
      paramsDigest, paramsKeys
  } }
  ```
  配对按事件顺序进行：`approval_request` 同时登记到 `requestId` 与 `callId` 两张待决表；`permission_decision` 有 `requestId` 且能命中时移除该待决，否则按 `callId` 移除最早一条待决（兼容旧日志 `requestId === callId`、`permission_decision` 无 `requestId` 的格式）。遍历结束仍未配对的审批按事件顺序补 deny；`approval_request` 缺非空 `requestId` 时跳过。写入时同时带 `requestId`，保证新旧格式再次 resume 都不会重复补写。
  不设置 `parent`：`approval_request` 由 prompter 写入，`BatchCall` 不含 assistant seq；`parent` 是可选字段，`buildMessages` 忽略该事件类型，不影响投影。不新增 `interrupted` 语义；已有 `interrupted` 补写逻辑保持不变。
- 该恢复只在 `resumeSession` 时发生；Web 页面在服务未运行时按 `deadlineAt` 显示过期提示，不伪造决策。

## 10. HTTP API

### 10.1 写请求通用约束

- `POST /api/actions` 与 `POST /api/approvals` 必须带 `Origin`，且 `Origin` 为 loopback、端口等于监听端口（`requireWriteRequest`）。缺少 `Origin` → 403 `forbidden_origin`；非 POST → 405 `method_not_allowed`。
- 浏览器跨源：请求携带 `Sec-Fetch-Site: cross-site`（不同 site）时直接 403 `forbidden_origin`；同 site 不同端口（如 `localhost:5173` 页面写 `127.0.0.1:5174`）通常标记为 `same-site`，由 `Origin` 的 loopback + 端口一致性校验拦截。该头由浏览器自动发送；非浏览器客户端不发送，仍由 `Origin` 校验兜底。
- `Content-Type` 必须为 `application/json` 或 `application/json;` 前缀（允许 `; charset=utf-8` 等参数；`application/jsonp` 不放行），否则 415 `unsupported_media_type`。
- Body 上限 64 KiB；超出 413 `payload_too_large`；JSON 解析失败或非普通对象 → 400 `invalid_body`。`text` 的 8000 字符上限不变；64 KiB 覆盖其最坏 JSON 转义（每 UTF-16 单元最多 6 字节，约 48 KiB）。
- 读取超时 5s → 408 `request_timeout`：超时只让 `readJsonBody` 以 408 拒绝，不销毁 socket；handler 的 catch 执行 `req.resume()` 丢弃剩余 body 后写出 408 响应。客户端断开按 400/无响应处理，不留下 pending。
- 成功统一 202 + JSON；错误复用 `{ error: { code, message } }`。
- 现有只读路由的 `requireLocalRequest` 行为不变。

开发代理：`vite.config.ts` 对 `/api` 增加 `changeOrigin: true`，并在 `proxyReq` 中把 `Origin` 改写为 `http://127.0.0.1:<监听端口>`；生产同源不需要改写。

### 10.2 `POST /api/actions`

请求：

```json
{ "text": "读取 0x20000000 的 4 字节", "sessionId": "可选" }
```

响应 202：

```json
{ "sessionId": "uuid", "created": true }
```

错误：

| 状态 | code | 条件 |
|---|---|---|
| 400 | `invalid_body` | 非对象、缺 `text`、`text` 非字符串 |
| 400 | `invalid_text` | 空/纯空白、超过 8000 字符 |
| 400 | `invalid_session_id` | `sessionId` 非法 |
| 404 | `unknown_session` | 指定会话不存在 |
| 409 | `session_busy` | 同会话正在运行 |
| 500 | `session_corrupt` | 追加会话的 header 损坏 |
| 500 | `session_unreadable` | 追加会话的 header 不可读（EACCES/EPERM） |
| 503 | `model_unavailable` | providers 缺失/无效/引用无效 |
| 503 | `session_start_timeout` | `readyTimeoutMs` 内会话未就绪（runner 已 abort） |
| 503 | `runner_unavailable` | 运行器已关闭或未注入 |

`model_unavailable` 的 message 必须说明检查 `HARNESS_HOME/providers.json` 与 `HARNESS_WEB_MODEL`，且不得包含本机绝对路径（home 路径在消息中脱敏为 `HARNESS_HOME`）；`session_start_timeout` 的 message 说明会话未创建成功。`session_unreadable` 只返回「会话不可读」，不回传底层 `EACCES` 详情。

### 10.3 `POST /api/approvals`

请求：

```json
{ "sessionId": "uuid", "requestId": "6f1c2b0e-...", "decision": "allow" }
```

响应：

| 状态 | body | 条件 |
|---|---|---|
| 202 | `{ requestId, decision }` | 首次受理，已 resolve |
| 200 | `{ requestId, decision, duplicate: true }` | 同决策重复提交 |
| 400 | `invalid_body` / `invalid_decision` | 字段缺失/类型错误/`requestId` 不是 1..200 个可打印 ASCII 字符、`decision` 不是 allow/deny |
| 404 | `unknown_session` | 会话不在运行器注册表（含会话已结束） |
| 404 | `unknown_request` | 运行中会话但从未见过该 requestId |
| 408 | `request_timeout` | 读取请求体超过 5s |
| 409 | `already_decided` | 已用相反决策结束 |
| 410 | `approval_expired` | 会话仍在运行，但请求已超时/中断，当前不可再决 |
| 500 | `session_corrupt` | 追加会话的 header 损坏 |
| 500 | `session_unreadable` | 追加会话的 header 不可读（EACCES/EPERM） |
| 503 | `runner_unavailable` | 运行器已关闭或未注入 |

- `requestId` 是权限 gate 为每次审批生成的独立 UUID（与模型 `callId` 解耦，`callId` 可在跨轮复用）；只允许 1..200 个可打印 ASCII 字符（`\x20-\x7E`）。`sessionId` 用 `isValidSessionId`。两者校验失败均为 400 `invalid_body` / `invalid_session_id`。
- 202 只表示决策已送达 gate；最终结果以 `permission_decision` 事件为准，HTTP 不返回 `effective`。
- 不记录请求 body 到日志。

## 11. 前端

### 11.1 数据与投影

- `TranscriptEvent` 新增：
  ```ts
  { id: string; kind: "approval"; approval: ApprovalModel }
  ```
- `ApprovalModel.status: "pending" | "allowed" | "denied" | "expired" | "aborted"`；字段见 §9.1。
- `permission_decision` 到达后更新同 `callId` 的 approval，工具卡仍按现有逻辑置 `failed`（deny）。
- `TRANSCRIPT_KINDS`（若存在）同步加入 `approval`。

### 11.2 组件

- 新增 `ApprovalNotice`（`src/ui/components/conversation/approval-notice.tsx`）：
  - 头部：工具名、`ask`、待审批/允许/拒绝/已过期/已中断。
  - 正文：理由、参数摘要（`paramsPreviewText`）、截止时间（本地时间 HH:MM:SS）。
  - pending 且未超过 `deadlineAt` 且未提交时显示「批准」「拒绝」按钮；点击后进入提交中，按钮禁用。
  - 提交成功显示「已提交，等待确认」；提交失败显示错误码/消息，按钮恢复可用（若未超时）。
  - 超过 `deadlineAt` 后按钮禁用，显示「已过期」；最终以 `permission_decision` 更新。
  - 组件不自行把状态改为 allowed/denied；只维护 `submitting`/`error` 本地状态。
- `messages.tsx` 增加 `approval` 分支；`AppProps` 增加 `onApprovalDecision?: (sessionId, requestId, decision) => Promise<void>`，透传到消息流。
- 图标使用现有内联 SVG（`i-alert` / `i-check`），不使用 emoji。
- 样式新增 `.approval*`，复用 `.guard*` 的间距与边框；不要求新布局。

### 11.3 接线

- `main.tsx`：
  - `actionUrl = VITE_ACTION_URL ?? "/api/actions"`，`approvalUrl = VITE_APPROVAL_URL ?? "/api/approvals"`。
  - `onSend(text)`：调用 `POST /api/actions`，body 为 `{ text, sessionId: state.activeSessionId }`（无活动会话时省略）。成功后刷新会话列表；**仅当提交前没有活动会话（新建）才 `selectSession(result.sessionId)`**，追加输入保持当前视图与 SSE 连接，不重载。失败在 Composer 显示错误（复用现有错误处理）。
  - `onApprovalDecision(sessionId, requestId, decision)`：调用 `POST /api/approvals`；失败抛错给组件展示。
  - 「新会话」按钮（最小）：清空 `activeSessionId`、`events`、`view`，关闭 SSE；Composer 之后的发送走新建。按钮放在会话头部或 Composer 旁，文案「新会话」。点击时使在途 `load()`/`selectSession()` 失效（请求代次），避免旧加载覆盖新会话。
- 追加输入时保持当前 SSE 连接；新会话创建后按返回的 `sessionId` 重新加载并订阅。
- 不本地伪造 `permission_decision`；只等待 SSE 更新。

## 12. 超时、取消与失败语义

| 场景 | gate / bridge | HTTP | UI |
|---|---|---|---|
| 用户批准 | `effective=allow`，reason 追加 `approval_granted` | 202 | 卡片变允许，工具执行 |
| 用户拒绝 | `effective=deny`，`approval_denied` | 202 | 卡片变拒绝/未执行 |
| 超时 | `approval_timeout` deny；bridge 清 pending | 迟到 410 | 卡片变已过期 |
| 会话 abort | `approval_aborted` deny | 迟到 410 | 卡片变已中断（`aborted`） |
| append 失败 | `approval_error` deny，工具不执行 | 无请求可决 | 无卡片，事件流显示 interrupted |
| 重复相同决策 | 首次已 resolve，第二次忽略 | 200 duplicate | 状态不变 |
| 相反决策 | 忽略 | 409 | 显示“已决” |
| 服务重启 | pending 丢失 | 404/410 | 卡片超时后变已过期；resume 补审计 |

- bridge 不得自行把允许结果提前写入 `permission_decision`；审计写入仍由 `executeBatch` 的 `onDecision` 完成。
- `approval_request` 已落盘但 gate 因超时结束时，`permission_decision` 仍由 `onDecision` 写入，日志配对完整。

## 13. 测试策略

### 13.1 权限与桥

- `PermissionPrompter` 新字段：gate 传出 `requestId=callId`、`deadlineAt`、摘要字段；现有 allow/deny/timeout/abort/串行用例保持通过。
- bridge：写 `approval_request` 的顺序与 payload；allow/deny resolve；signal abort 清理；append 失败抛错；重复/相反/未知/过期 decide；settled 表上限；`close` 清理。
- 崩溃恢复：带未决 `approval_request` 的会话 resume 后补 `permission_decision`，`buildMessages` 可投影，重复 resume 不重复补。

### 13.2 运行器

- 新建：返回 uuid、`created=true`、`runSessionImpl` 收到 `sessionId`、input 与 `home`；返回时 header 已存在。
- 追加：存在 header 时以 `resume:true` + 正确 `sessionDir` 调用，且 `model` 等于 `header.model`、不传 `cwd`；不存在返回 `unknown_session`。
- 就绪：fake `runSessionImpl` 延迟调用 `onSession` 时 `start` 不提前返回；超过 `readyTimeoutMs` 返回 `session_start_timeout` 并 abort；首错在就绪前返回时映射为受理前错误。
- 并发：第二次 start 返回 `session_busy`；完成后可再次追加。
- 校验：空文本、超长、非法 id。
- 模型：无 providers → `model_unavailable`；坏 JSON/schema → `model_unavailable`；`HARNESS_WEB_MODEL` 覆盖；默认取第一个引用；追加会话用 header.model。
- close：abort 所有运行并等待完成。

### 13.3 HTTP

- `/api/actions`：202（新建/追加）、400/404/409/503、415、413、非法 JSON；写端点无 Origin → 403；跨源 Origin → 403；GET → 405。
- `/api/approvals`：202/200 duplicate/400/404×2/409/410；同一 requestId 的幂等；body 上限。
- 继续使用现有 `rawRequest` 与 `freePort`，测试显式设置 `Origin`。
- `createUiServer` 注入 fake runner；不触网。

### 13.4 UI

- 投影：`approval_request` 生成 pending approval；`permission_decision` 更新为 allowed/denied/expired；非 ask 的 decision 仍生成 permission 事件。
- 组件：pending 显示按钮；提交中禁用；成功显示等待确认；失败显示错误；过期禁用。
- 状态：`applySessionEvent` 接收 `approval_request` 后视图含 pending；duplicate seq 不重复。
- 既有 transcript/messages 用例保持。

### 13.5 端到端

- 真实 `runSession` + fake model + 临时 `HARNESS_HOME` + 真实 `createUiServer` + 真实 runner：
  1. `POST /api/actions` 启动会话，fake model 返回 `shell` 工具调用（`ask`）。
  2. SSE 收到 `approval_request`（含 requestId），断言 `permission_decision` 尚未出现。
  3. `POST /api/approvals allow` → 202。
  4. SSE 收到 `permission_decision`（`approval_granted`、effective allow）、`tool_started`、`tool_result`。
  5. 拒绝路径：工具未执行（使用只读 mock 或断言 `tool_started` 不出现），`permission_decision` effective deny。
  6. 超时路径：`approvalTimeoutMs` 设 200ms，不提交，收到 `approval_timeout`；迟到 POST 返回 410。
- 不真实执行危险命令；`shell` 用例使用无害命令或在 `execute` 前被拒。

### 13.6 验证命令

`npm test`、`npm run coverage`（lines ≥ 85%）、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:ui`、`npm run typecheck:web`、`npm run build:web`。`npm run verify:ui` 作为回归，不新增 V 用例。

## 14. 交付边界与文档

- 代码：
  - 新增 `src/server/runner.ts`、`src/server/approvals.ts`（或合并）、`src/ui/components/conversation/approval-notice.tsx`。
  - 修改 `src/server/api.ts`、`src/server/serve.ts`（创建 runner、关闭）、`src/permissions/types.ts`、`src/permissions/gate.ts`、`src/index.ts`（`home` / `onSession`）、`src/session/types.ts`、`src/session/persistence.ts`、`src/session/session.ts`（崩溃恢复）、`src/context/build.ts`、`src/ui/view/transcript.ts`、`src/ui/components/conversation/messages.tsx`、`src/ui/app.tsx`、`src/ui/main.tsx`、`src/ui/styles.css`、`vite.config.ts`。
- 测试：`tests/server/runner.test.ts`、`tests/server/approvals-api.test.ts`、`tests/approvals-bridge.test.ts`、`tests/web-approval-e2e.test.ts`，补充 transcript/messages/state/session-persistence。
- 文档：README 新增「Web 会话与审批」；`docs/frontend-design.md` 补审批卡片与状态机；`docs/deferred-issues.md` 关闭 D-137/D-139，登记本轮边界（服务重启 pending 丢失、无 token、审批摘要敏感片段、单会话串行、SSE 200ms 延迟）。
- 功能演示命令：`npm run build:web && npm run build && npm run serve:ui`，浏览器打开 `http://127.0.0.1:5174/`。
- 不合并 `main`；提交规范 `feat(approvals): ...`。

## 15. 验收锚点

1. `POST /api/actions` 能新建会话并在默认 `diagnose` 下触发 `ask`；请求返回 `sessionId`，页面能订阅到后续事件。
2. `ask` 产生 `approval_request`，SSE 在等待期间即可见；payload 无参数原文。
3. 浏览器批准后工具执行，且日志顺序为 `approval_request → permission_decision(allow, approval_granted) → tool_started → tool_result`。
4. 拒绝/超时/中断均不执行工具，日志以 deny 结束；迟到决策返回 410 或 409，不二次执行。
5. 无模型配置时 `/api/actions` 返回 503 且页面显示原因，不出现“已受理”假象。
6. 写端点缺少 Origin 或跨源时返回 403；只读端点行为不变。
7. `npm test` / coverage / typecheck / lint / build / test:ui / typecheck:web / build:web 全绿；危险命令未被真实执行。

## 16. 留给实现者的决定

- `runner.ts` 与 `approvals.ts` 是否合并；`DecideOutcome` 的内部表示。
- readiness promise 的实现方式（`onSession` resolve + 首错 reject + 超时 abort 的具体组合）。
- settled 表的具体数据结构与清理时机（建议 Map + 时间戳，5 分钟/256 条上限）。
- body 读取的缓冲实现（`for await` 或 `data` 事件）与超时细节。
- 参数摘要扁平化为 `paramsPreviewText` 的具体格式（建议 `key=value`，逗号分隔）。
- 新会话按钮的放置位置（会话头部或 Composer 旁），以最小改动为准。
- 运行错误写入 stderr 的格式；是否在会话列表暴露 runner 错误（本轮不暴露）。