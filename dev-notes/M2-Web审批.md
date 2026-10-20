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
  9. 端到端：`tests/web-approval-e2e.test.ts` 覆盖批准、拒绝、超时与缺少 Origin 的 403。
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

- `/api/approvals` 的 200 响应为 `{ requestId, decision, duplicate: true }`，与 spec §10.3 表格一致。
- 审批端点的 `requestId` 校验失败统一返回 400 `invalid_body`（长度 1..200 且仅可打印 ASCII）；`invalid_body` 同时覆盖字段缺失与类型错误，不再有独立的 `invalid_request_id`。
- 迟到决策：会话仍在运行但已超时/中断返回 410 `approval_expired`；会话已结束后注册表无该项，返回 404 `unknown_session`（spec 表格只写 410）。
- 前端收到 409/410 时只显示错误并禁用按钮，不修改 `ApprovalModel.status`；终态仍等 `permission_decision`，因此「已决」文案由服务端消息承载。
- 未修项已登记 `deferred-issues.md` D-145 ~ D-152：重启丢失 pending、仅 Origin 校验、摘要敏感片段、单会话串行、SSE 200ms 延迟、迟到决策 404/410 不一致、未响应 abort 占用 `session_busy`、在途发送切回会话。

**被拒绝或纠偏的内容**

- 未改生产代码与测试，也未提交；提交留给用户统一处理。
- spec 与实际响应体/错误码不一致时，选择按已实现行为写文档并在本条与 README 标注偏差，而非改代码迎合文档。

**翻车与返工**

- 编辑 `frontend-design` §9 交互表时一次替换误删「回放 / 实时事件 / 断线续传」三行，随即补回并核对整表；无其他返工。
- 追加本段时用 `cat >> … << 'EOF'` 写入含反引号的 Markdown，违反 AGENTS.md「写文档一律用 Write/Edit」的约束（引号 heredoc 未发生命令展开，已核对写入内容无误）；此后改用 Edit，教训是不用 shell 拼接文档正文。
## 2026-10-20 · 最终审查修复

**用户关键原话**

- `Web 审批闭环已实现并通过全量测试，最终审查发现以下问题。请一次性修复`——清单 A-F：runner 错误披露、HTTP 契约、前端竞态、投影截断、测试稳定性、文档同步。

**关键产出**

- A. Runner 错误披露：追加会话读 header 先于 providers 解析；`ENOENT`/`ENOTDIR` → `unknown_session`（404），`SessionCorruptionError` → `session_corrupt`（500），`EACCES`/`EPERM` → `session_unreadable`（500），其他错误原样抛出；`close()` 后 `start` 抛 `runner_unavailable`（503）。
- B. HTTP 契约：body 上限 32 KiB；`Content-Type` 仅接受 `application/json` 或 `application/json;` 前缀；`requestId` 限 1..200 个可打印 ASCII，违规统一 400 `invalid_body`。
- C. 前端：`newSession()` 调用 `gate.begin()` 使在途加载失效；`send()` 仅在提交前无活动会话（新建）时 `selectSession`，追加只刷新列表并保持视图与 SSE；`ApprovalNotice` 到截止时间后停止 interval；修复 conversation 测试的一行格式。
- D. 投影：`paramsPreviewText` 改为按 Unicode 码点截断，避免切断代理对。
- E. e2e 超时用例 `approvalTimeoutMs` 300 → 1500，保留 deferred 门控与迟到 410 断言。
- F. 文档：README/spec/`frontend-design`/`deferred-issues`/本文件按修复后实现同步；D-051 标已解决并指向 D-139。

**验证结果**

- `npx vitest run tests/server tests/web-approval-e2e.test.ts tests/ui`：28 files / 336 passed。
- `npm run typecheck`、`npm run typecheck:web`：无错误输出。

**被拒绝或纠偏的内容**

- 未新增依赖、未执行危险命令、未派发子代理；只改清单涉及文件。

**翻车与返工**

- 首版 `errnoOf` 先读取顶层 `error.code`，导致 `SessionCorruptionError` 包裹的 `ENOENT` 被误判为 `session_corrupt`；测试失败后改为优先读取 `detail.cause.code`，未知会话恢复 404。

**残余与冲突确认**

- D-145 ~ D-152 与新错误码不冲突：D-150 的 404/410 判定仍在 `decide` 路径，本轮未改；D-151 仍是 `session_busy`；D-152（发送在途手动切换仍可能切回）未被本轮消除。
- spec §10.3 按清单补了 `session_corrupt`/`session_unreadable`；审批端点本身不读 header，这两个码实际只由 `/api/actions` 的追加路径产生。

## 红队修复（2026-10-20，第二轮最终审查后）

**用户关键原话**

- `审批 requestId 与 callId 解耦（Critical）`；`408 实际可达`；`拒绝浏览器跨源写请求`；`启动阶段失败写审计`；`Minor: runner 错误不含绝对路径 / send 清空 sendError / D-146 补面`；`不要新增依赖；不真实执行危险命令；不派发子代理`。

**关键产出**

- A. `permissions/gate.ts` 每次 `check` 生成 `randomUUID()` 作为 `requestId`，`callId` 保留模型原值；`PermissionRequest` 增加 `requestId`；`PermissionDecisionPayload` 增加可选 `requestId`；`query.ts` 写入；`session.ts` 的崩溃恢复按 `requestId` 配对并补写 `requestId`，缺失非空 `requestId` 的旧审批跳过；`transcript.ts` 优先按 `requestId` 匹配，旧日志无 `requestId` 时回退同 `callId` 最近 pending，工具卡仍按 `callId`。
- B. `server/body.ts` 增加 `timeoutMs` 参数；超时只 reject 408，不再 `req.destroy()`，由 handler 的 `req.resume()` 丢弃剩余 body。
- C. `server/api.ts` 写端点拒绝 `Sec-Fetch-Site: cross-site`（403 `forbidden_origin`）。
- D. `index.ts` 增加 `queryStarted`，`yield* query` 前置 true；catch 中若启动前失败则追加 `interrupted(start_failed)`，append 错误被吞掉以保留原始错误。
- E. runner 的 `model_unavailable` 消息把 home 路径脱敏为 `HARNESS_HOME` 并固定提示 `HARNESS_HOME/providers.json` 与 `HARNESS_WEB_MODEL`；`session_unreadable` 只返回「会话不可读」；`ui/main.tsx` 的 `send` 开始时清空 `sendError`。
- F. 文档：spec §7.2/§8.1/§9.1/§9.2/§10.1/§10.3、README 审批与错误段、`deferred-issues` D-146/D-153/D-154、本文件同步。

**RED/GREEN 证据**

- RED：gate `requestId === callId`、transcript 同 callId 第二条审批被误更新、session-persistence 同 callId 第二轮审批未配对、body 超时挂起、api cross-site 返回 202、startup 审计无 `interrupted`、runner 消息含临时 home 绝对路径。
- GREEN：`tests/permissions-gate.test.ts`、`tests/session-persistence.test.ts`、`tests/approvals-bridge.test.ts`、`tests/ui/transcript.test.ts` 共 173 passed；`tests/server`（body/startup-audit/api/runner）67 passed。

**被拒绝或纠偏的内容**

- 未新增依赖、未真实执行危险命令、未派发子代理。
- 未把崩溃恢复的 `permission_decision` 兼容回退到 `callId`：按任务要求只用 `requestId` 配对，旧日志若缺 `requestId` 则跳过；transcript 才保留旧日志回退。

**翻车与返工**

- session-persistence 首版用例让第一轮 assistant 缺 `tool_result`，`buildMessages` 无法投影导致恢复分支 fail-closed；补第一轮 `tool_result` 后恢复路径才可执行。
- spec 文档一度把 body 上限误写为 32 KiB，核对 `body.ts` 后恢复为 64 KiB。

**残余**

- D-153（`port: 0` 时写端点 403）、D-154（runner 关闭后 decide 返回 404）本轮只登记未修；D-150/D-151/D-152 不变。

## 升级兼容修复（2026-10-20，复验后）

**用户关键原话**

- `复验发现一个升级兼容 Important`；`旧格式（approval_request.requestId === callId，permission_decision 无 requestId）会导致所有历史已决审批被误判为未决`；改为顺序配对，并补三种用例。

**关键产出**

- `findUnresolvedApprovals` 改为按事件顺序配对：`approval_request` 同时进 `requestId`/`callId` 待决队列；`permission_decision` 优先按 `requestId` 匹配，否则按 `callId` 取最早未匹配；返回未匹配条目并保持事件顺序。
- 新增旧格式单轮、旧格式跨轮用例，均含二次 resume 幂等断言；新格式跨轮沿用既有用例。
- README / D-146 / spec §10.1 修正 `Sec-Fetch-Site` 措辞：它拦真正跨站；同 site 不同端口由 `Origin` 端口校验拦截。spec §9.2 同步顺序配对语义。

**RED/GREEN**

- RED（stash 实现）：旧格式两用例失败，跨轮补的是 `digest-1` 而非 `digest-2`。
- GREEN：`tests/session-persistence.test.ts` + `tests/web-approval-e2e.test.ts` 89 passed；`npm run typecheck` 通过。

**翻车与返工**

- 首版算法若只维护 `requestId` 单值表，旧格式跨轮会互相覆盖且二次 resume 不幂等；改为按 requestId 的待决队列 + `matched` 标记后解决。

**残余**

- 全量 `npm test` 中 `tests/mcp-manager.test.ts` 在并行负载下 3 个时间阈值用例超时，单独复跑 36 passed，与本轮无关。
## 2026-10-20 · 最终两轮核验与收尾

**第一轮标准审查**

- 结论：With fixes。核心安全属性成立（先落盘、fail-closed、202 不预判、拒绝/超时/中断不执行）。
- 修复：runner header 错误分型（session_corrupt/session_unreadable）、newSession 使在途加载失效、README/dev-notes 契约纠偏、body 上限与 8000 字符兼容、e2e 超时窗口、追加输入保持 SSE。
- 提交：`9943374`、`107225f`。

**第二轮红队审查**

- 发现 Critical：callId 跨轮复用导致崩溃恢复配对失效、迟到决策可能命中新调用。
- 修复：gate 生成独立 `requestId`（UUID），`permission_decision` 携带 requestId；恢复与 bridge 全按 requestId；408 不再 destroy socket；写端点拒绝 `Sec-Fetch-Site: cross-site`；query 前启动失败写 `interrupted`。
- 复验发现旧格式恢复回归：改为 requestId 优先、callId FIFO 兜底的顺序配对。
- 提交：`9571b2b`、`e0a719d`、`fd0bb84`（静默正常关闭的中止日志）。

**最终验证（fresh）**

- `npm test`：73 files / **1792 passed**，1 skipped。
- `npm run coverage`：lines **91.32%**、branches 83.48%、statements 88.73%、functions 91.50%（lines 阈值 85%）。
- `npm run typecheck` / `npm run lint` / `npm run build`：exit 0。
- `npm run test:ui`：22 files / **225 passed**；`npm run typecheck:web` / `npm run build:web`：exit 0（37 modules，JS 72.42 kB / CSS 32.67 kB）。

**未合并 / 已知边界**

- 分支 `feat/m2-web-approval` 未合并 main，等用户确认。
- 已登记 D-145 ~ D-154：重启丢失 pending、仅 Origin 校验（含 dev 代理面）、摘要敏感片段、单会话串行、SSE 200ms 延迟、迟到决策 404/410、abort 不响应占用 session_busy、发送在途切会话、port 0 写端点 403、关闭后 decide 404。
- 旧格式跨轮审批共享同一 requestId，只能按 callId FIFO 配对；极端乱序历史日志可能偏移，属于旧格式固有限制。

## 2026-10-20 · 全量复验（权限引擎 + Web 审批 API）

**用户关键原话**

- `全量复验权限引擎与web审批api`
- 复验前 `/compact`，要求删除关于邮件的会话上下文；本轮只做技术复验。

**基线**

- 分支 `feat/m2-web-approval`，HEAD `f328bcd`，工作区干净。
- 复验对象：权限引擎（`src/permissions/`、管线接入、审计、配置加载）+ Web 审批（`src/server/{runner,approvals,api,body}.ts`、审批事件与崩溃恢复、UI 投影与卡片）。

**验证命令与结果（fresh）**

- `npm test`：73 files / **1792 passed + 1 skipped**（live 网关用例）。复跑 3 次，其中 1 次（coverage 运行）`tests/mcp-manager.test.ts` 2 个时间阈值用例失败，单独复跑 36/36 通过。
- `npm run coverage`：lines **91.32%**（5086/5569，阈值 85%）、statements 88.73%、branches 83.52%、functions 91.5%；`src/permissions` lines 97.84%，`src/server` lines 90.97%，`transcript.ts` lines 93.95%。
- `npm run typecheck` / `npm run lint` / `npm run build`：exit 0。
- `npm run test:ui`：22 files / **225 passed**；`npm run typecheck:web` / `npm run build:web`：exit 0（37 modules，JS 72.42 kB）。
- `npm run verify:ui`：**14/14 PASS**，V0 附加 1/1 PASS。

**构建产物探针（只用 `dist/`，不依赖测试夹具；假模型为本地 HTTP 服务，不触网）**

共 135 项断言通过；另有 2 项失败经定位为探针自身时序误用（见本节末「探针自身修正」），不是产品缺陷。逐组：

1. 权限锚点（24 项）：默认 `diagnose` 下 fs 读/glob/grep allow、fs 写/shell deny 且 `execute` 未调用（无 marker 文件、无写文件）、headless `ask → approval_unavailable` 150ms 内结束不挂起、每次判定恰好一条审计且字段完整（`requestId` 为独立 UUID ≠ `callId`）、审计先于 `tool_result`、MCP readOnly/destructive/unknown 映射为 allow/deny/deny 且 destructive 未调用 `call`、参数规则 allow 覆盖预设并保留 `source=user`/`ruleIndex=0`、坏配置在创建会话前失败且不留目录。
2. Web 审批 HTTP（24 + 33 项）：actions 202 + header 已落盘、approval_request 不含参数原文、缺 Origin 403、批准后事件顺序 `approval_request → permission_decision(allow, approval_granted) → tool_started → tool_result`、拒绝不产生 `tool_started` 且结果 `permission_denied`、超时审计 `approval_timeout`、同会话并发审批串行（同一时刻只有一个待审批）、重复决策 200 `duplicate`、相反决策 409、未知 requestId 404、`session_busy` 409 且结束后可追加、规则 allow 不产生审批、参数谓词 deny 不执行、read-only 下 fs 写直接 deny、跨站 403 / 415 / 413 / 405 / 坏 JSON 400、跨源 Origin 403。
3. MCP 经真实审批链路（11 项）：`mem_read` allow 执行、`mem_write` 产生 `approval_request(access=write)` 批准后执行、无标注工具 `preset:diagnose:unknown` 直接 deny 且无 `tool_started`。
4. 浏览器闭环（20 项，无头 Chrome + CDP）：空态文案、发送按钮、审批卡片 pending 展示工具/ask/理由/参数/截止时间、等待期间不伪造成功、点击批准后卡片 `allowed`、工具真实输出 `ui-probe` 出现在页面、最终回答出现、“新会话”后第二轮卡片出现、拒绝后卡片 `denied` 且工具卡 `permission_denied`、无 `exit=0`。
5. 跨会话隔离（11 项）：两会话并行各自待审批、用 B 的 `sessionId` 提交 A 的 `requestId` 返回 404 且不改变 A 的审计、A 批准执行、B 拒绝不执行。
6. 复用与预设（19 项）：同一 `callId` 跨轮复用两次审批 `requestId` 不同，旧 `requestId` 迟到决策返回 409 且不命中新审批，两轮各自审计正确；超时后旧 `requestId` 410、新 `requestId` 202；workspace-write 的 fs 写按内置规则 allow；danger-full-access 不产生审批且 shell 执行。
7. 崩溃恢复（7 项）：SIGKILL 服务后重启 resume，补写 `approval_aborted: crash_recovery` 且保留 `requestId` 配对、工具未执行、二次 resume 不重复补写。
8. 回放（6 项）：HTTP 详情与 SSE 补播均含 `approval_request`/`permission_decision` 且顺序正确、`stream_end` 收尾、seq 单调。

探针自身修正两处，均非产品缺陷：① 超时场景在会话 `done` 之后才提交迟到决策，命中 D-150 的「会话结束后 404」，改为会话仍在运行时断言 410；② 优雅 `close()` 已由 abort 路径写 `approval_aborted`，不能用来验证「崩溃恢复」，改为 `SIGKILL` 强杀。

**发现的问题（本轮未改生产代码，等授权）**

1. **D-154 可复现，且与 README/spec 措辞冲突**：`runner.close()` 之后 `/api/approvals` 返回 404 `unknown_session`，`/api/actions` 返回 503 `runner_unavailable`；README 与 spec 的审批错误表都写「运行器已关闭或未注入 → 503」。构建产物探针实测：`approvals after close: 404`、`actions after close: 503`。
2. **spec 残留 `requestId === callId` 的旧描述**：`2026-10-20-web-approval-design.md` §6 第 71 行、§7.3 第 146 行、§13.1 第 373 行仍写「`requestId` 即 `callId` / `requestId = req.callId`」，与 §8.1（gate 生成 `randomUUID()`）矛盾。红队修复只同步了 §7.2/§8.1/§9.1/§9.2/§10.1/§10.3。
3. **`tests/mcp-manager.test.ts` 的时间阈值用例在并行负载下不稳定**：`单个 server 失败不阻塞其他 server`（默认 5s 超时）与 `连接超时可注入…`（`Date.now() - started < 3000`）在 coverage/全量并行时偶发失败，单独复跑 36/36 通过。dev-notes 上一轮已记录同类现象，但未登记到 `deferred-issues.md`。

**被拒绝或纠偏的内容**

- 未改生产代码、未新增依赖、未派发子代理；所有探针在 `.tmp/`（已 gitignore），使用本地假模型与无头浏览器，未触网、未执行危险命令。
- 未把探针失败当作产品缺陷：两处失败经定位均为探针时序或关闭语义误用，见上。

**下一步**

- 等用户决定是否修 D-154（`decide` 先检查 `closed` 返回 `runner_unavailable`）与同步 spec 三处残留；测试不稳定项登记 deferred。

## 2026-10-20 · 三项修复（D-154 / D-155 / D-156）

**用户关键原话**

- `修三项`

**D-154 · close 后 decide 返回 503**

- TDD：先在 `tests/server/runner.test.ts` 加 `close 后 decide 返回 runner_unavailable 而不是 unknown_session`，跑出 RED（`expected { kind: 'unknown_session' } to deeply equal { kind: 'runner_unavailable' }`）。
- 实现：`RunnerDecideOutcome` 增加 `{ kind: "runner_unavailable" }`；`decide` 在查注册表前先判 `closed`；`src/server/api.ts` 的 `handleApproval` switch 增加 503 映射。
- HTTP 层：`tests/server/approvals-api.test.ts` 新增「运行器已关闭返回 503」；变异验证——临时删掉 `api.ts` 的新增 case 后该用例 RED，恢复后 23/23 通过。
- 构建产物复验：`runner.close()` 后 `/api/approvals` 与 `/api/actions` 均返回 503 `runner_unavailable`（修复前 approvals 为 404）。

**D-155 · spec 三处 `requestId === callId`**

- §6 改为「gate 生成的独立 UUID，与 `callId` 解耦」；§7.3 第 1 步 `requestId = req.callId` → `req.requestId`；§13.1 改为「独立 UUID（不等于 `callId`）」并补断言要求。
- 顺带把 `runner_unavailable` 补进 §7.1 `DecideOutcome` 与 §7.2 的 close 语义，避免 spec 与 D-154 修复再次分叉。

**D-156 · mcp-manager 时间阈值用例**

- `单个 server 失败不阻塞其他 server`：加 30s `testTimeout`。断言本体（echo 成功、broken 失败、含 `connect_failed`）未动，测的是故障隔离而非耗时。
- `连接超时可注入…`：耗时上限 3000ms → 10000ms，并加 30s `testTimeout`。注入值 300ms、默认值 15s，10s 仍能区分「注入生效」与「走默认超时」。
- 变异验证：临时删掉 `connectTimeoutMs: 300` 后该用例 RED（`expected 17054 to be less than 10000`，即回落到默认 15s），恢复后 GREEN——证明放宽后仍看守「注入生效」这一行为。
- 未改任何生产代码。

**验证结果（fresh）**

- `npm test`：73 files / **1794 passed + 1 skipped**（新增 2 条用例），exit 0。
- `npm run coverage`：73 files 全通过，lines **91.33%**、statements 88.74%、branches 83.49%、functions 91.50%；`src/server` lines 90.99%。
- `npm run typecheck` / `lint` / `typecheck:web` / `build`：exit 0。
- `npm run test:ui`：22 files / 225 passed；`npm run verify:ui`：**14/14 PASS** + V0 1/1。
- 构建产物探针 8 组 **141 项断言全通过**（含浏览器闭环 20 项）；修复后重跑全部通过。

**探针修正（本轮，非产品问题）**

- `verify-approval-artifacts.mjs` 的「迟到决策 410」原先让模型第二轮返回 `done`，会话先结束，命中 D-150 的 404；改为模型始终返回工具调用，使会话在提交迟到决策时仍在运行。
- `verify-approval-artifacts-2.mjs` 的「崩溃恢复」用优雅 `close()` 验证，实际走 abort 路径（写 `approval_aborted`，不产生未配对审批）；改为断言优雅关闭语义，真正的 SIGKILL 恢复交由 `verify-crash-recovery.mjs`。

**被拒绝或纠偏的内容**

- 未改 `@vitest` 全局 `testTimeout`：只对两条负载敏感用例单独放宽，避免掩盖其他用例的慢路径。
- 未把 D-156 的断言改成「相对并发耗时」：需要引入基准对比与更多时序耦合，收益不抵复杂度；放宽上限 + 说明语义已足够。

**残余**

- 工作区 8 个文件未提交（2 个源文件、3 个测试、3 个文档），按「未授权不提交」等待用户指令。

