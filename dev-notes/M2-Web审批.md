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

## 2026-10-20 · 实现与交付

**用户关键原话**

- `你是本项目的文档子代理…只做文档更新，不改生产代码或测试`
- 文档要求：README 新增「Web 会话与审批」；`frontend-design` 补审批卡片与状态机；`deferred-issues` 关闭 D-137/D-139 并登记边界；`dev-notes` 增量记录；`不要提交（由我统一提交）`。

**关键产出**

- 实现任务（任务 1-9，均已提交）：
  1. 权限契约扩展：`PermissionPromptRequest` 补 `requestId`/`callId`/`deadlineAt`/摘要字段（`src/permissions/types.ts`、`gate.ts`）。
  2. `approval_request` 事件与崩溃恢复：`src/session/types.ts`、`persistence.ts`、`session.ts`；`context/build.ts` 忽略该类型。
  3. 审批桥：`src/server/approvals.ts`，落盘后等待、pending/settled 表、重复/相反/过期判定。
  4. `runSession` 注入点：`RunOptions.home` / `onSession`（`src/index.ts`）。
  5. 会话运行器：`src/server/runner.ts`，就绪竞速、`session_busy`、模型解析、`close()`。
  6. HTTP：`src/server/api.ts` 落地 `/api/actions`、`/api/approvals`，`src/server/body.ts` 限制 8 KiB/5s/JSON；`vite.config.ts` 代理改写 `Origin`。
  7. 前端投影：`src/ui/view/transcript.ts` 的 `ApprovalModel` 与状态映射。
  8. 审批卡片与接线：`approval-notice.tsx`、`messages.tsx`、`header.tsx`（新会话）、`main.tsx`（发送/决策/epoch）、`styles.css`。
  9. 端到端：`tests/web-approval-e2e.test.ts` 覆盖批准、拒绝、超时、无模型配置。
- 文档（任务 10）：README「Web 会话与审批」；`frontend-design` §7.16 与状态机、§8.1/§8.2/§8.6/§9；`deferred-issues` D-137/D-139/D-112 已解决、新增 D-145 ~ D-152 与变更记录。

**关键提交**（`d12d7c5..b2c31a4`）

`a121445` 审批上下文 → `910f735` 审批事件与恢复 → `eb3c148` 审批桥 → `b8d226a` 落盘后再接受决策 → `47b3308` home/onSession 注入 → `1215beb` 恢复预设校验 → `77df12b` 重复请求与关闭语义 → `84fdfef` 会话运行器 → `03899fe` 动作与审批接口 → `dd46c57` 入参校验 → `53aac59` 审批投影 → `fd103e1` 事件占位分支 → `0d8f9a2` 审批卡片与接线 → `2937e80` 新会话残留状态 → `93b906a` 端到端闭环 → `a61318c` 错误码契约 → `e1c4a04` 启动失败原因 → `5fc8887` 审批终态与发送竞态 → `b2c31a4` 端到端断言加固。

**验证结果**（2026-10-20 复核，全部通过）

- `npm test`：71 files / 1769 passed，1 skipped。
- `npm run coverage`：lines 91.32%、branches 83.35%、statements 88.75%、functions 91.32%（lines 阈值 85%）。
- `npm run typecheck`、`npm run lint`（同 `tsc --noEmit`）、`npm run typecheck:web`：无错误输出。
- `npm run build`：成功；`npm run build:web`：37 modules，`dist-web` JS 72.06 kB / CSS 32.67 kB。
- `npm run test:ui`：22 files / 223 passed。

**偏差与未修项**

- `/api/approvals` 的 200 响应实际为 `{ requestId, decision }`，未包含 spec §10.3 表格中的 `duplicate: true`；实现为准，文档按实现书写。
- 审批端点额外返回 400 `invalid_request_id`（`requestId` 不在 1..200 字符），spec 错误表未列；`invalid_body` 同时覆盖字段缺失与类型错误。
- 迟到决策：会话仍在运行但已超时/中断返回 410 `approval_expired`；会话已结束后注册表无该项，返回 404 `unknown_session`（spec 表格只写 410）。
- 前端收到 409/410 时只显示错误并禁用按钮，不修改 `ApprovalModel.status`；终态仍等 `permission_decision`，因此「已决」文案由服务端消息承载。
- 未修项已登记 `deferred-issues.md` D-145 ~ D-152：重启丢失 pending、仅 Origin 校验、摘要敏感片段、单会话串行、SSE 200ms 延迟、迟到决策 404/410 不一致、未响应 abort 占用 `session_busy`、在途发送切回会话。

**被拒绝或纠偏的内容**

- 未改生产代码与测试，也未提交；提交留给用户统一处理。
- spec 与实际响应体/错误码不一致时，选择按已实现行为写文档并在本条与 README 标注偏差，而非改代码迎合文档。

**翻车与返工**

- 编辑 `frontend-design` §9 交互表时一次替换误删「回放 / 实时事件 / 断线续传」三行，随即补回并核对整表；无其他返工。
- 追加本段时用 `cat >> … << 'EOF'` 写入含反引号的 Markdown，违反 AGENTS.md「写文档一律用 Write/Edit」的约束（引号 heredoc 未发生命令展开，已核对写入内容无误）；此后改用 Edit，教训是不用 shell 拼接文档正文。
