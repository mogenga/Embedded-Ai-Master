# M2 Web 审批闭环

## 2026-10-20 · 范围确认与设计定稿

**用户关键原话**

- `推进权限引擎实现 + Web 审批 API`
- 范围选择：`完整闭环（推荐）`——最小 Web 会话运行器（发起会话/追加输入）+ `approval_request` 事件 + `POST /api/approvals` + 最简审批 UI，顺带落地 D-139 `/api/actions`。
- 安全选择：`强制 Origin + 本地校验（推荐）`——沿用 `requireLocalRequest`，写端点缺少 Origin 时拒绝；不引入 token。

**侦察结论**

- 阶段 1 权限引擎已完成；D-112 的库层 `PermissionPrompter` 与会话审计可复用。
- 关键缺口不是单个端点：`src/server/serve.ts` 不运行 `runSession`，`/api/events` 只是日志只读投影，`approval_request` 不在事件白名单，前端没有待审批状态。
- 因此完整闭环必须补：会话运行器、审批桥（含 requestId/deadline）、`approval_request` 事件、审批 HTTP 回传、审批 UI。

**关键产出**

- 设计文档：`docs/superpowers/specs/2026-10-20-web-approval-design.md`（待用户批准）。
- 覆盖 `POST /api/actions`（D-139）、`POST /api/approvals`（D-137）、最小 UI、崩溃恢复、强制 Origin 与 dev 代理改写。
- 明确复用 gate 串行队列与超时，不新造权限模型；`approval_request` 先落日志再由 SSE 投影。

**Builder check（子代理）提出的 5 个问题与处理**

1. `start` 何时算受理 → 必须等 header 落盘（`onSession` readiness）再返回 202，新增 `readyTimeoutMs`/`session_start_timeout`。
2. 追加会话的 model 与 cwd → 用 `header.model`、省略 `cwd` 让 `runSession` 回落到 `header.workdir`。
3. `HARNESS_HOME` 双源 → 给 `RunOptions` 增加 `home`，runner 显式传入，避免 header 检查与实际写入分叉。
4. providers 错误码 → 统一 503 `model_unavailable`，删除原稿“503/500”的歧义。
5. abort 后卡片状态 → 新增 `aborted`，与 `expired` 区分。

**被拒绝或纠偏的内容**

- 未按“只做审批 API”推进：确认了 Web 进程不运行会话时审批永远不会产生，范围必须包含最小运行器。
- 未引入 token：按用户选择只用强制 Origin + loopback 校验，token 作为后续边界登记。
- 未把审批结果写回 HTTP 响应：202 只表示送达 gate，最终结果以 `permission_decision` 为准。

**翻车与返工**

- 设计稿初版 §7.2 引用了不存在的 §9.3，且 providers 错误码前后不一致；builder check 发现后修正。
- 初版未规定受理边界，导致前端拿到 `sessionId` 时 header 可能尚未落盘；已补 readiness 语义。

**下一步**

- 等用户批准设计文档后，用 `superpowers:writing-plans` 出实施计划，再按任务派发与两轮审查。
## 2026-10-20 · 计划评审准备

**用户关键原话**：`批准，开始出计划（推荐）`

**关键产出**

- 实施计划：`docs/superpowers/plans/2026-10-20-web-approval.md`，共 10 个任务：审批契约扩展、事件与崩溃恢复、审批桥、runSession 注入、会话运行器、HTTP 路由、前端投影、审批卡片与接线、端到端闭环、文档与两轮审查。
- 每个任务含 Files / Interfaces / TDD 步骤 / 验证命令 / 提交信息。

**被拒绝或纠偏的内容**

- 计划自审时发现 spec 说 `approval_request` 的 `parent` 取 assistant seq，但 `BatchCall` 不含 parent，prompter 也拿不到；已改 spec 为省略 `parent`，不影响投影。
- 计划初稿引用不存在的 `tests/context-build.test.ts`，已改为实际存在的 `tests/build.test.ts`。
- 明确 `createApiHandler` 缺 runner 返回 503，`createUiServer` 内部创建默认 runner；避免测试语义混淆。

**翻车与返工**

- 无代码改动；仅文档。
