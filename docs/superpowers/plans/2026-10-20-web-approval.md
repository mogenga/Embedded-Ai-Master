# Web 审批闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web 工作台能发起/追加会话，并在浏览器内批准或拒绝 `ask` 工具调用，形成 `approval_request → permission_decision → 执行` 的完整审计闭环。

**Architecture:** Web 服务进程内新增会话运行器与审批桥；gate 通过扩展后的 `PermissionPrompter` 写入 `approval_request` 日志事件并等待 HTTP 决策；SSE 仍只读日志投影；前端新增待审批卡片与提交接线。

**Tech Stack:** TypeScript + Node 24（ESM）、Preact、vitest、现有 MCP SDK/Zod。

**Spec:** `docs/superpowers/specs/2026-10-20-web-approval-design.md`

## Global Constraints

- ESM-only，相对导入带 `.js`，strict；不新增依赖。
- 日志是唯一事实源：`approval_request` 先 `append` 成功才等待审批；audit 失败不得执行工具。
- 复用 `gate.ts` 的串行队列、入队计时与 abort 语义，不复制第二套审批状态机。
- 危险命令测试禁令：不真实执行破坏性命令；deny 用例只断言 mock `execute`/`manager.call` 未被调用。
- 写端点强制 `Origin` 为 loopback 且端口匹配；只读端点行为不变。
- 内核不含领域逻辑；`src/index.ts` 不 import `src/server`。
- 提交格式 `type(scope): 中文描述`，不合并 `main`。

## Review Focus

1. 审批请求必须在 gate 等待期间可见（`approval_request` 先落盘，SSE 轮询延迟 ≤ 250ms），不能等 `permission_decision` 才出现。
2. 重复/迟到/相反决策不得二次执行或伪造成功：202 只表示送达，最终以 `permission_decision` 为准。
3. `/api/actions` 返回 202 时会话 header 必须已落盘，否则前端订阅 404；就绪超时必须显式失败。
4. 追加会话必须使用 `header.model` 且不传 `cwd`，避免 202 后 `model_mismatch`/`workdir_mismatch` 静默失败。
5. 写端点缺少 `Origin` 或跨源必须 403；只读端点不受影响。

---

### Task 1: 扩展 PermissionPrompter 契约

**Files:**
- Modify: `src/permissions/types.ts`
- Modify: `src/permissions/gate.ts`
- Test: `tests/permissions-gate.test.ts`

**Interfaces:**
- Consumes: 既有 `PermissionGateOptions`、`PermissionRequest`。
- Produces:
  ```ts
  export interface PermissionPromptRequest {
    requestId: string;
    callId: string;
    tool: string;
    args: unknown;
    reason: string;
    preset: PermissionPreset;
    access: ToolAccess;
    deadlineAt: string;
    paramsDigest: string;
    paramsKeys: string[];
    paramsPreview?: Record<string, unknown>;
    signal: AbortSignal;
  }
  export interface PermissionPrompter {
    request(req: PermissionPromptRequest): Promise<"allow" | "deny">;
  }
  ```

- [ ] **Step 1: 写失败测试**

在 `tests/permissions-gate.test.ts` 增加一个用例：用 `deferredPrompter` 捕获请求，构造 `ask` 工具并 `check`，断言：

```ts
const captured = await firstPromptRequest();
expect(captured.requestId).toBe("call-1");
expect(captured.callId).toBe("call-1");
expect(captured.access).toBe("write");
expect(captured.deadlineAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
expect(Date.parse(captured.deadlineAt)).toBeGreaterThan(Date.now());
expect(captured.paramsDigest).toMatch(/^[a-f0-9]{16}$/);
expect(captured.paramsKeys).toEqual(["op"]);
expect(captured.paramsPreview).toEqual({ op: "write" });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/permissions-gate.test.ts`
Expected: FAIL，`requestId`/`access`/`deadlineAt` 为 `undefined`。

- [ ] **Step 3: 实现**

`types.ts` 用 `PermissionPromptRequest` 替换 `PermissionPrompter.request` 的匿名入参类型。`gate.ts` 的 `requestApproval` 在 `start()` 内组装完整请求：

```ts
const promptReq: PermissionPromptRequest = {
  requestId: base.callId,
  callId: base.callId,
  tool: base.tool,
  args: base.args,
  reason: base.reason,
  preset: base.preset,
  access: base.access,
  deadlineAt: new Date(deadline).toISOString(),
  paramsDigest: base.paramsDigest,
  paramsKeys: base.paramsKeys,
  ...(base.paramsPreview === undefined ? {} : { paramsPreview: base.paramsPreview }),
  signal: controller.signal,
};
```

`base` 从 `check` 的 `evaluation` 与 `summary` 构造后传入 `requestApproval`；不改变队列/超时/abort 逻辑。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/permissions-gate.test.ts`
Expected: PASS。同步修正因精确断言入参而失败的既有用例（只补新字段，不放宽断言）。

- [ ] **Step 5: 提交**

```bash
git add src/permissions/types.ts src/permissions/gate.ts tests/permissions-gate.test.ts
git commit -m "feat(permissions): 扩展审批请求上下文"
```

---

### Task 2: `approval_request` 事件与崩溃恢复

**Files:**
- Modify: `src/session/types.ts`
- Modify: `src/session/persistence.ts`
- Modify: `src/context/build.ts`
- Modify: `src/session/session.ts`
- Test: `tests/session-persistence.test.ts`
- Test: `tests/build.test.ts`

**Interfaces:**
- Consumes: `ToolAccess`、`PermissionPreset`、`ToolAccess` 类型。
- Produces:
  ```ts
  export type EventType = /* 既有 */ | "approval_request";

  export interface ApprovalRequestPayload {
    requestId: string;
    callId: string;
    tool: string;
    action: "ask";
    access?: ToolAccess;
    reason: string;
    preset: PermissionPreset;
    paramsDigest: string;
    paramsKeys: string[];
    paramsPreview?: Record<string, unknown>;
    deadlineAt: string;
  }
  ```

- [ ] **Step 1: 写失败测试**

在 `tests/session-persistence.test.ts` 增加：写入含 `approval_request` 的日志后可读取，且 `readSessionSnapshot` 不抛 `unknown_event_type`。

在 `tests/build.test.ts` 增加：含 `approval_request` 的事件数组经 `buildMessages` 不抛错，且不产生消息。

在 `tests/session-persistence.test.ts` 增加崩溃恢复用例：

```ts
// createSession → append assistant(toolCalls:[{id:"call-1",...}]) → append approval_request(callId:"call-1") → close → resumeSession
const resumed = await resumeSession(dir);
const events = resumed.events();
expect(events.some((e) => e.type === "permission_decision" && e.payload.callId === "call-1"
  && e.payload.effective === "deny" && e.payload.reason === "approval_aborted: crash_recovery")).toBe(true);
await resumed.close();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/session-persistence.test.ts tests/build.test.ts`
Expected: FAIL，`unknown_event_type` 或缺少补写的 `permission_decision`。

- [ ] **Step 3: 实现**

- `types.ts`：EventType 加入 `"approval_request"`，新增 `ApprovalRequestPayload`。
- `persistence.ts`：`EVENT_TYPES` 同步加入。
- `build.ts`：`permission_decision` 的 case 改为同时匹配 `approval_request`（忽略）。
- `session.ts`：
  - 新增 `PendingApproval` 与 `findUnresolvedApprovals(events)`：按 `callId` 收集 `approval_request` 与 `permission_decision`，返回未决项。
  - `CrashRecoveryPlan` 增加 `approvals: PendingApproval[]`。
  - `planCrashRecovery` 在 `buildMessages` 成功的分支也返回 plan（当存在未决审批）；失败分支同时携带未决审批。
  - `resumeSession` 在补 `tool_result`/`interrupted` 前，为每个未决审批 append `permission_decision`（action `ask`、effective `deny`、reason `approval_aborted: crash_recovery`、preset/source/paramsDigest/paramsKeys 来自 payload；不设置 `parent`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/session-persistence.test.ts tests/build.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/session/types.ts src/session/persistence.ts src/context/build.ts src/session/session.ts tests/session-persistence.test.ts tests/build.test.ts
git commit -m "feat(session): 新增审批请求事件与恢复"
```

---

### Task 3: ApprovalBridge

**Files:**
- Create: `src/server/approvals.ts`
- Test: `tests/approvals-bridge.test.ts`

**Interfaces:**
- Consumes: `PermissionPrompter`、`PermissionPromptRequest`（Task 1）、`ApprovalRequestPayload`（Task 2）。
- Produces:
  ```ts
  export type DecideOutcome =
    | { kind: "accepted" }
    | { kind: "duplicate" }
    | { kind: "unknown_request" }
    | { kind: "expired" }
    | { kind: "already_decided" };

  export interface ApprovalBridge extends PermissionPrompter {
    bindSession(session: Pick<SessionHandle, "append">): void;
    decide(requestId: string, decision: "allow" | "deny"): DecideOutcome;
    pendingCount(): number;
    close(): void;
  }

  export function createApprovalBridge(opts?: {
    settledTtlMs?: number;   // 默认 300000
    settledMax?: number;     // 默认 256
  }): ApprovalBridge;
  ```

- [ ] **Step 1: 写失败测试**

`tests/approvals-bridge.test.ts` 用 fake handle（`append: vi.fn(async (ev) => ({ ...ev, seq: 0, ts: "" }))`）：

```ts
it("先写 approval_request 再等待决策", async () => {
  const bridge = createApprovalBridge();
  bridge.bindSession(fakeHandle);
  const promise = bridge.request(promptReq("call-1"));
  expect(fakeHandle.append).toHaveBeenCalledWith(expect.objectContaining({
    type: "approval_request",
    payload: expect.objectContaining({
      requestId: "call-1", callId: "call-1", action: "ask", deadlineAt: promptReq("call-1").deadlineAt,
    }),
  }));
  expect(bridge.decide("call-1", "allow")).toEqual({ kind: "accepted" });
  await expect(promise).resolves.toBe("allow");
});
```

补充用例：deny、signal abort 清理并返回 `deny`、append reject 使 `request` reject、重复相同决策 `duplicate`、相反 `already_decided`、未知 `unknown_request`、超时后 `expired`、`close` 清理、未绑定 session 返回 `deny` 且不写日志。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/approvals-bridge.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `request`：未绑定 → `"deny"`；构造 payload（复制 requestId/callId/tool/access/reason/preset/paramsDigest/paramsKeys/paramsPreview/deadlineAt）；`await session.append({ type: "approval_request", payload })`；登记 pending 与 signal listener；返回 Promise。
- signal abort：从 pending 移除、写入 settled（无决策）、resolve `"deny"`。
- `decide`：pending → accepted；settled 同决策 → duplicate；settled 相反 → already_decided；settled 无决策 → expired；未知 → unknown_request。
- settled 表按时间清理，超过 `settledMax` 丢弃最旧。
- `close`：清 pending 并 resolve `"deny"`，清 settled。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/approvals-bridge.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/approvals.ts tests/approvals-bridge.test.ts
git commit -m "feat(approvals): 新增审批桥"
```

---

### Task 4: `runSession` 注入点

**Files:**
- Modify: `src/index.ts`
- Test: `tests/integration.test.ts`

**Interfaces:**
- Consumes: `SessionHandle`、`resolveHarnessHome`。
- Produces:
  ```ts
  export interface RunOptions {
    // ...既有字段
    home?: string;
    onSession?: (session: SessionHandle) => void;
  }
  ```

- [ ] **Step 1: 写失败测试**

在 `tests/integration.test.ts` 增加：

```ts
it("home 显式注入时会话写入该目录", async () => {
  const home = await tempHome();
  const events = [];
  for await (const _ of runSession({ ...baseOpts, home })) { /* drain */ }
  expect(existsSync(path.join(home, "sessions"))).toBe(true);
});

it("onSession 在会话创建后、首个业务事件前调用", async () => {
  let seen: string | undefined;
  for await (const _ of runSession({ ...baseOpts, onSession: (s) => { seen = s.id; } })) {}
  expect(seen).toBe(sessionId);
});
```

`baseOpts` 复用该文件既有 fake model/providers 辅助。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/integration.test.ts -t "home 显式注入|onSession"`
Expected: FAIL（`home` 不生效或回调未调用）。

- [ ] **Step 3: 实现**

- `const home = opts.home ?? resolveHarnessHome();`
- 在 `try {` 的第一行调用 `opts.onSession?.(session);`，位于 `systemPromptToAppend` 与 `permissions_project_config_skipped` 写入之前。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/integration.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/index.ts tests/integration.test.ts
git commit -m "feat(session): 支持 home 与 onSession 注入"
```

---

### Task 5: SessionRunner

**Files:**
- Create: `src/server/runner.ts`
- Test: `tests/server/runner.test.ts`

**Interfaces:**
- Consumes: `createApprovalBridge`（Task 3）、`runSession`/`RunOptions`（Task 4）、`loadProviders`/`parseProviders`/`resolveModelRef`、`readSessionDir`。
- Produces:
  ```ts
  export interface ActionInput { text: string; sessionId?: string }
  export type ActionOutcome = { sessionId: string; created: boolean };
  export class RunnerError extends Error {
    constructor(readonly code:
      | "invalid_text" | "invalid_session_id" | "unknown_session"
      | "session_busy" | "model_unavailable" | "session_start_timeout",
      message: string);
  }
  export interface SessionRunner {
    start(input: ActionInput): Promise<ActionOutcome>;
    decide(sessionId: string, requestId: string, decision: "allow" | "deny"): Promise<DecideOutcome>;
    close(): Promise<void>;
  }
  export function createSessionRunner(opts: {
    harnessHome: string;
    model?: string;
    providersText?: string;
    fetchImpl?: typeof fetch;
    maxTextLength?: number;      // 8000
    readyTimeoutMs?: number;     // 10000
    runSessionImpl?: typeof runSession;
    cwd?: string;
  }): SessionRunner;
  ```

- [ ] **Step 1: 写失败测试**

`tests/server/runner.test.ts` 使用 fake `runSessionImpl`（async generator，先调用 `opts.onSession(fakeHandle)` 再 yield）：

- 新建：`start({ text: "hi" })` 返回 `created: true`，`runSessionImpl` 收到 `sessionId`、`input`、`home`、`providersText`、`permissions.prompter`。
- 就绪：fake 延迟 50ms 调 `onSession`，断言 `start` 在 50ms 后才 resolve。
- 超时：fake 永不调 `onSession`，`readyTimeoutMs: 20` → `RunnerError("session_start_timeout")`。
- 追加：预写 header（`createSession` 后 close），`start({ text, sessionId })` 的调用参数含 `resume: true`、`sessionDir`、`model === header.model`，且不含 `cwd`。
- 并发：fake 挂起，第二次 start → `session_busy`；完成后可再次 start。
- 校验：空/空白/超长 → `invalid_text`；非法 id → `invalid_session_id`；不存在的 id → `unknown_session`。
- 模型：无 providers → `model_unavailable`；坏 JSON → `model_unavailable`；`HARNESS_WEB_MODEL` 覆盖；默认第一个引用。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/server/runner.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- 预加载 providers：`opts.providersText ? parseProviders(...) : loadProviders(opts.harnessHome)`；`modelRef = header?.model ?? opts.model ?? process.env.HARNESS_WEB_MODEL ?? firstReference(providers)`；`resolveModelRef` 校验；失败抛 `RunnerError("model_unavailable", ...)`。
- 传给 `runSession`：`home: harnessHome`、`providersText: JSON.stringify(providers)`、`fetchImpl`、`model: modelRef`、`permissions: { prompter: bridge }`、`onSession`（bind + readyResolve）。
- 新建传 `sessionId`，追加传 `resume: true`+`sessionDir` 且不传 `cwd`。
- registry：`Map<sessionId, { controller, completion, bridge }>`；`start` 先查重；后台消费 generator；`finally` 删除。
- `start` 等待 `Promise.race([ready, timeout(readyTimeoutMs)])`；超时 abort + `session_start_timeout`；generator 在 ready 前 reject 时把错误抛出（`RunnerError` 原样或包装）。
- `decide`：registry 无会话 → `{kind:"unknown_session"}`；否则委托 bridge。
- `close`：abort 全部，`Promise.allSettled` + 5s 上限。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/server/runner.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/runner.ts tests/server/runner.test.ts
git commit -m "feat(server): 新增 Web 会话运行器"
```

---

### Task 6: HTTP 写请求与审批路由

**Files:**
- Create: `src/server/body.ts`
- Modify: `src/server/api.ts`
- Modify: `src/server/serve.ts`（仅在需要传 model/env 时）
- Test: `tests/server/api.test.ts`
- Test: `tests/server/approvals-api.test.ts`

**Interfaces:**
- Consumes: `SessionRunner`/`RunnerError`（Task 5）。
- Produces:
  ```ts
  // src/server/body.ts
  export async function readJsonBody(
    req: IncomingMessage,
    limitBytes?: number,
  ): Promise<Record<string, unknown>>;

  // src/server/api.ts
  export interface ApiOptions {
    // ...既有字段
    runner?: SessionRunner;
  }
  ```

- [ ] **Step 1: 写失败测试**

`tests/server/api.test.ts` 更新既有 `/api/actions` 501 用例，改为注入 fake runner 后断言 202；并新增：

- 缺 `Origin` 的 POST → 403 `forbidden_origin`。
- 跨源 Origin → 403。
- `GET /api/actions` → 405。
- 无 runner → 503 `runner_unavailable`。
- Body 非法 JSON → 400 `invalid_body`；`Content-Type: text/plain` → 415；超 8 KiB → 413。

`tests/server/approvals-api.test.ts` 用 fake runner 覆盖：

```ts
expect(status).toBe(202); // accepted
expect(status).toBe(200); // duplicate
expect(status).toBe(404); // unknown_request / unknown_session
expect(status).toBe(409); // already_decided
expect(status).toBe(410); // expired
expect(status).toBe(400); // invalid_decision
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/server/api.test.ts tests/server/approvals-api.test.ts`
Expected: FAIL（501 / 模块不存在）。

- [ ] **Step 3: 实现**

- `body.ts`：校验 method 由调用方负责；`Content-Type` 以 `application/json` 开头，否则 415；`for await` 累加 Buffer，超限 413；5s 超时；JSON.parse 失败或非普通对象 → 400 `invalid_body`。
- `api.ts`：
  - 新增 `requireWriteRequest(req, port)`：调用 `requireLocalRequest` 后，`req.headers.origin === undefined` → 403 `forbidden_origin`。
  - `/api/actions`：`requireMethod("POST")` → `requireWriteRequest` → `readJsonBody` → 校验 `text`/`sessionId` → `runner.start` → 202 `{sessionId, created}`。
  - `/api/approvals`：同样前置校验 → 校验 `sessionId`/`requestId`/`decision` → `runner.decide` → 映射（accepted 202、duplicate 200、unknown_session/unknown_request 404、already_decided 409、expired 410）。
  - `RunnerError` 映射：`invalid_text`/`invalid_session_id` 400、`unknown_session` 404、`session_busy` 409、`model_unavailable`/`session_start_timeout` 503。
  - `createApiHandler` 的 `runner` 缺失 → 503 `runner_unavailable`（该用例直接调 handler，不经过 `createUiServer`）。
  - `createUiServer`：未注入 runner 时创建默认 runner（`harnessHome`、`model`、`fetchImpl` 透传），`close` 时仅关闭内部创建的 runner；注入的 runner 由调用方负责关闭。
- `serve.ts`：若默认 runner 需要 `HARNESS_WEB_MODEL`，直接由 `createUiServer` 读取，无需额外改动。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/server/api.test.ts tests/server/approvals-api.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/body.ts src/server/api.ts src/server/serve.ts tests/server/api.test.ts tests/server/approvals-api.test.ts
git commit -m "feat(server): 新增动作与审批接口"
```

---

### Task 7: 前端审批投影

**Files:**
- Modify: `src/ui/view/transcript.ts`
- Test: `tests/ui/transcript.test.ts`

**Interfaces:**
- Consumes: `ApprovalRequestPayload`（Task 2）。
- Produces:
  ```ts
  export interface ApprovalModel {
    requestId: string;
    callId: string;
    tool: string;
    reason: string;
    preset: string;
    paramsPreviewText?: string;
    deadlineAt?: string;
    status: "pending" | "allowed" | "denied" | "expired" | "aborted";
  }
  export type TranscriptEvent =
    | /* 既有 */
    | { id: string; kind: "approval"; approval: ApprovalModel };
  ```

- [ ] **Step 1: 写失败测试**

`tests/ui/transcript.test.ts` 增加：

- `approval_request` → 一个 `kind:"approval"`、`status:"pending"` 的事件，含 tool/reason/deadlineAt。
- `paramsPreview` 扁平化为 `paramsPreviewText`，最多 8 个键、单值 200 字符。
- 后续 `permission_decision`（allow）→ 同一事件 status `allowed`，且不新增 `permission` 事件。
- `approval_timeout`/`approval_aborted`/其他 deny → `expired`/`aborted`/`denied`。
- 无对应 approval 的 `permission_decision` 仍生成 `permission` 事件（回归）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/transcript.test.ts`
Expected: FAIL，无 `approval` 事件。

- [ ] **Step 3: 实现**

- 在 `transcriptFromSession` 增加 `approval_request` case，push approval 事件并记入 `Map<callId, ApprovalEvent>`。
- `permission_decision` case 先查 Map；命中则更新 status 并跳过 permission push；未命中保持原逻辑。
- 新增 `flattenPreview(preview)` 工具；不写回日志。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/transcript.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/view/transcript.ts tests/ui/transcript.test.ts
git commit -m "feat(ui): 投影审批请求状态"
```

---

### Task 8: 审批卡片与前端接线

**Files:**
- Create: `src/ui/components/conversation/approval-notice.tsx`
- Modify: `src/ui/components/conversation/messages.tsx`
- Modify: `src/ui/components/conversation/stream.tsx`
- Modify: `src/ui/components/conversation/header.tsx`
- Modify: `src/ui/components/conversation/composer.tsx`
- Modify: `src/ui/app.tsx`
- Modify: `src/ui/main.tsx`
- Modify: `src/ui/styles.css`
- Modify: `vite.config.ts`
- Test: `tests/ui/components/approval-notice.test.tsx`
- Test: `tests/ui/components/conversation.test.tsx`
- Test: `tests/ui/components/composer-dock.test.tsx`

**Interfaces:**
- Consumes: `ApprovalModel`（Task 7）、`postAction`。
- Produces:
  ```ts
  export function ApprovalNotice(props: {
    approval: ApprovalModel;
    sessionId?: string;
    onDecision?: (sessionId: string, requestId: string, decision: "allow" | "deny") => Promise<void>;
  }): JSX.Element;

  // AppProps
  onApprovalDecision?: (sessionId: string, requestId: string, decision: "allow" | "deny") => Promise<void>;
  onNewSession?: () => void;
  sendError?: string;
  ```

- [ ] **Step 1: 写失败测试**

`tests/ui/components/approval-notice.test.tsx`（`// @vitest-environment happy-dom`）：

- pending 显示工具名、理由、参数摘要、截止时间与两个按钮。
- 点击「批准」调用 `onDecision(sessionId, requestId, "allow")`；提交中按钮禁用；成功后显示「已提交，等待确认」。
- `onDecision` reject → 显示错误文本，按钮恢复。
- `deadlineAt` 已过期 → 按钮禁用、显示「已过期」。
- status `allowed`/`denied`/`aborted` → 无按钮，显示对应文案。

`tests/ui/components/conversation.test.tsx`：`approval` 事件渲染为审批卡片；`onApprovalDecision` 贯通。

`tests/ui/components/composer-dock.test.tsx`：`sendError` 显示在 Composer 区域。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui`
Expected: FAIL，模块/分支不存在。

- [ ] **Step 3: 实现**

- `approval-notice.tsx`：本地 `submitting`/`error`/`submitted`；`status !== "pending"` 或 `deadlineAt` 过期时禁用；`useEffect` 每秒检查过期；成功不本地改 allowed（等待事件）。
- `messages.tsx`：`renderEvent` 增加 `approval` 分支；`MessageStream` 透传 `sessionId`/`onApprovalDecision`。
- `stream.tsx`/`app.tsx`：透传新 props；`ConversationHeader` 增加可选「新会话」按钮。
- `composer.tsx`：新增 `errorMessage?: string`，失败时展示文本（保留现有 `failed` 行为）。
- `main.tsx`：
  - `actionUrl = VITE_ACTION_URL ?? "/api/actions"`，`approvalUrl = VITE_APPROVAL_URL ?? "/api/approvals"`。
  - `onSend`：`postAction<{sessionId:string}>(actionUrl, { text, ...(sessionId ? {sessionId} : {}) })`；成功后先 `const { sessions, errors } = await fetchSessions({ fetchImpl })`，用 `state = { ...state, sessions, sessionErrors: errors }` 刷新列表（不重置视图），再 `selectSession(result.sessionId)`；失败把 `HttpError`（非 `Error` 实例，读 `status`/`text`）转为可读文本写入 `sendError`。
  - `onApprovalDecision`：`postAction(approvalUrl, { sessionId, requestId, decision })`；失败抛错。
  - `onNewSession`：清空 `activeSessionId`/`events`/`view`/`lastSeq`，`controller.close()`，`sendError=undefined`。
- `styles.css`：新增 `.approval*`，复用 `.guard*` 的边框/间距，不引入新布局。
- `vite.config.ts`：代理增加 `changeOrigin: true`，`proxyReq` 设置 `origin: http://127.0.0.1:<port>`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui && npm run typecheck:web`
Expected: PASS / 0 error。

- [ ] **Step 5: 提交**

```bash
git add src/ui vite.config.ts tests/ui
git commit -m "feat(ui): 新增审批卡片与发送接线"
```

---

### Task 9: 端到端闭环

**Files:**
- Create: `tests/web-approval-e2e.test.ts`
- Test: `tests/web-approval-e2e.test.ts`

**Interfaces:**
- Consumes: 全部前置任务。
- Produces: 无新公共接口。

- [ ] **Step 1: 写失败测试**

参考 `tests/events-e2e.test.ts` 的 fake model、temp home、`freePort`、`parseFrames`，构造：

1. providers + `HARNESS_HOME`；`createSessionRunner({ harnessHome, providersText, fetchImpl: mockFetch, model: "gw/flash" })`；`createUiServer({ harnessHome, runner, port })`。
2. `POST /api/actions`（带同源 Origin）→ 202，返回 sessionId。
3. 读取 SSE（`/api/events?sessionId=...`）直到出现 `approval_request`；断言此时没有同 callId 的 `permission_decision`。
4. `POST /api/approvals` allow → 202。
5. 继续读流，断言顺序 `approval_request → permission_decision(reason 含 approval_granted, effective allow) → tool_started → tool_result`。
6. 拒绝路径：第二次 action 返回另一个工具调用，POST deny → `effective deny`，无 `tool_started`。
7. 超时路径：会话配置 `approvalTimeoutMs: 200`（通过 `HARNESS_HOME/permissions.json`），不提交 → `approval_timeout`；迟到 POST → 410。
8. 缺 Origin 的 approvals POST → 403。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web-approval-e2e.test.ts`
Expected: FAIL（闭环未打通）。

- [ ] **Step 3: 修正实现**

只修测试暴露的真实缺陷；不改测试断言来迁就实现。若发现 SSE 在 gate 等待期间拿不到 `approval_request`，检查 `append` 是否在 prompter 调用前、log-tail 是否读取新增行。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/web-approval-e2e.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add tests/web-approval-e2e.test.ts
git commit -m "test(approvals): 新增 Web 审批端到端闭环"
```

---

### Task 10: 文档、登记与两轮审查

**Files:**
- Modify: `README.md`
- Modify: `docs/frontend-design.md`
- Modify: `docs/deferred-issues.md`
- Modify: `dev-notes/M2-Web审批.md`

**Interfaces:**
- Consumes: 前序任务交付。
- Produces: 文档与验证结论。

- [ ] **Step 1: 更新文档**

- README 新增「Web 会话与审批」：`HARNESS_WEB_MODEL`、`/api/actions`、`/api/approvals`、202 语义、超时/错误码、`Origin` 要求、开发代理说明。
- `frontend-design.md`：审批卡片字段、状态机（pending/allowed/denied/expired/aborted）、不本地伪造结果、新会话按钮。
- `deferred-issues.md`：
  - D-137 / D-139 标注**已解决**（保留条目），写明本轮实现与测试。
  - 新增边界：服务重启 pending 丢失、无 token、审批摘要可能含敏感片段、单会话串行、SSE 200ms 延迟。
- `dev-notes/M2-Web审批.md` 增量记录实现、验证、偏差。

- [ ] **Step 2: 第一轮代码审查**

逐任务核对 spec：契约字段、事件白名单四处同步、错误码、202 语义、Origin 校验、前端状态机。列出发现并修复；修复后重跑受影响定向测试。

- [ ] **Step 3: 第二轮红队审查**

重点：重复/迟到/相反决策、服务重启、浏览器断开、会话 abort、append 失败、模型配置错误、`header.model` 不一致、并发 action、body 上限、危险命令未真实执行、前端不伪造成功。发现即修，修后重跑。

- [ ] **Step 4: 全量验证**

Run:
```bash
npm test
npm run coverage
npm run typecheck
npm run lint
npm run build
npm run test:ui
npm run typecheck:web
npm run build:web
```
Expected: 全部通过；coverage lines ≥ 85%。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/frontend-design.md docs/deferred-issues.md dev-notes/M2-Web审批.md
git commit -m "docs(approvals): 补充 Web 审批说明与边界"
```

## 完成标准

- 功能演示：`npm run build:web && npm run build && npm run serve:ui`，打开 `http://127.0.0.1:5174/`，发送需要 `ask` 的指令，页面出现审批卡片；批准后工具执行，拒绝后不执行。
- 交付三样：演示命令、测试结果、`dev-notes/M2-Web审批.md` 路径。
- 不合并 `main`，等用户确认。