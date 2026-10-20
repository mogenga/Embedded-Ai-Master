# M2 阶段 3 领域闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 BR-4 参数级策略、BR-5 沉淀闭环与 Renode 端到端诊断验收。

**Architecture:** 权限层只增加通用“区间 + 跨度”语义，领域边界通过 probe 权限模板配置化；KB 侧新增 inbox 写入模块、`kb_propose` 工具与审核脚本，审核以回归基线为门禁；端到端脚本用真实 Renode + 真实 KB + 真实内核事件日志，纯函数负责证据对表。

**Tech Stack:** TypeScript + Node 24（ESM-only）、MCP SDK v2、Zod v4、vitest、Preact 仅用于既有 Web，不涉及前端改动。

**Spec:** `docs/superpowers/specs/2026-10-20-m2-stage3-domain-loop-design.md`

## Global Constraints

- TypeScript + Node 24，ESM-only；不得新增依赖；不得执行 `npm install` / `npm ci`。
- 内核 `src/` 不得含嵌入式领域逻辑；地址/串口/复位语义只能配置化。
- 危险命令测试只做纯函数断言或注入 mock，禁止真实执行。
- 不修改 `mcp-servers/kb/kb/` 与 `mcp-servers/kb/data/`（本地资产不入库）。
- 不降低 `mcp-servers/kb/tests/regression-baseline.json`。
- 不使用 `git worktree`。
- 审查安排：Task 1-4 全部完成后合并做**一轮**独立核验；修复后再做**最终二轮**复核。

## Review Focus

1. `extentKey` 指向数组时取长度、指向数字时取数值；缺失或非法必须 fail closed，不能默认放行。
2. 领域权限模板不得被误加载为默认策略；headless 下未匹配的写/复位仍必须是 deny。
3. `kb_propose` 只写 `_inbox.md`，不得让未审内容进入 `kb_lookup`/`kb_search`；写入失败必须显式报错。
4. 审核脚本在回归下降时必须保持 inbox 不变；不能用“脚本成功”掩盖指标下降。
5. 诊断脚本不得把 Renode 复位基线表述为真实板卡故障；VTOR=0 只能说明未加载固件。

---

### Task 1: 权限区间语义与 probe 领域策略模板

**Files:**
- Modify: `src/permissions/types.ts`
- Modify: `src/permissions/config.ts`
- Modify: `src/permissions/rules.ts`
- Create: `mcp-servers/probe/permissions.example.json`
- Create: `tests/permissions-domain.test.ts`
- Modify: `tests/permissions-rules.test.ts`
- Modify: `tests/permissions-config.test.ts`
- Modify: `README.md`（权限配置节）

**Interfaces:**
- Produces: `ParamMatcher.extentKey?: string`；`matchParam` 对 `range` 的跨度语义；`permissions.example.json` 作为可复制模板。

- [ ] **Step 1: 写失败测试**：在 `tests/permissions-rules.test.ts` 增加用例——`range [0x20000000, 0x2000000f]` + `extentKey: "bytes"`，`bytes` 为 8 字节数组时匹配，16 字节时不匹配；`extentKey` 指向数字 8 时匹配；指向缺失/字符串/0 长度时不匹配。
- [ ] **Step 2: 运行测试确认失败**：`npx vitest run tests/permissions-rules.test.ts`，预期因 `extentKey` 未实现而失败。
- [ ] **Step 3: 实现**：`types.ts` 加可选 `extentKey`；`rules.ts` 在 range 分支读取 extent（数组取 `length`，数字取本身），要求有限、`>=1`、`value + extent <= upper`；`config.ts` 的 `MatcherSchema` 加 `extentKey`，复用 `KeySchema`，并拒绝 `extentKey` 与 `eq/glob/in` 同用、拒绝 `extentKey` 无 `range`。
- [ ] **Step 4: 写领域模板测试**：`tests/permissions-domain.test.ts` 读取 `mcp-servers/probe/permissions.example.json`，`loadPermissionConfig({ home, workdir, inline: 模板 })` + `evaluatePolicy` 断言 spec §4.3 的 6 条。
- [ ] **Step 5: 创建模板与文档**：`permissions.example.json` 按 spec §4.2；README 增加“复制到 `.harness/permissions.json` 才生效”的说明。
- [ ] **Step 6: 验证**：`npx vitest run tests/permissions-rules.test.ts tests/permissions-config.test.ts tests/permissions-domain.test.ts`、`npm run typecheck`。
- [ ] **Step 7: 提交**：`feat(permissions): 支持参数区间跨度与 probe 领域策略模板`。

---

### Task 2: KB inbox 模块与 `kb_propose` 工具

**Files:**
- Create: `mcp-servers/kb/inbox.ts`
- Modify: `mcp-servers/kb/tools.ts`
- Modify: `mcp-servers/kb/service.ts`（`KbStatus.inboxPending`）
- Create: `mcp-servers/kb/tests/inbox.test.ts`
- Create: `mcp-servers/kb/tests/kb-propose.test.ts`
- Modify: `mcp-servers/kb/tests/kb-tools.test.ts`（若存在）
- Modify: `mcp-servers/kb/README.md`

**Interfaces:**
- Produces: `parseInbox(text): KbProposal[]`、`formatProposal`、`proposalDigest`、`appendProposal(root, proposal)`、`removeProposal(root, id)`、`appendReviewed(root, entry)`；`kb_propose` 工具；`KbStatus.inboxPending`。

- [ ] **Step 1: 写 inbox 失败测试**：解析含旧块（无 id）与带 id 块的夹具；追加后解析往返；重复 content 不写；remove 保留头部与其他块；`appendReviewed` 创建 `_reviewed.md`。
- [ ] **Step 2: 运行确认失败**：`npx vitest run mcp-servers/kb/tests/inbox.test.ts`。
- [ ] **Step 3: 实现 `inbox.ts`**：按 spec §5.1；ID 使用 `YYYYMMDD-HHmmss-<6hex>`；旧块生成 `legacy-<n>`；重复判定用 `kind + domain + content` 的 sha256。
- [ ] **Step 4: 实现 `kb_propose`**：按 spec §5.2；`withSchema` 校验；写失败返回 `proposal_failed`；`kb_status` 增加 `inboxPending`。
- [ ] **Step 5: 写工具测试**：写入成功/重复/空内容/超长/写入失败（mock `appendProposal` 抛错）/未审内容不被 `lookup`/`search` 命中。
- [ ] **Step 6: 更新 README**：说明 `kb_propose` 只写 inbox、审核流程与 `_reviewed.md`。
- [ ] **Step 7: 验证**：`npx vitest run mcp-servers/kb`、`npm run typecheck`、`npm run build:mcp`。
- [ ] **Step 8: 提交**：`feat(kb): 增加 kb_propose 与待审 inbox`。

---

### Task 3: KB 审核脚本与回归门禁

**Files:**
- Create: `mcp-servers/kb/regression-gate.ts`
- Create: `mcp-servers/kb/tests/regression-gate.test.ts`
- Create: `scripts/kb-review.mjs`
- Modify: `package.json`（`kb:review`）
- Modify: `mcp-servers/kb/README.md`

**Interfaces:**
- Consumes: Task 2 的 `parseInbox` / `removeProposal` / `appendReviewed`。
- Produces: `compareRegression(report, baseline): RegressionGateResult`；`npm run kb:review`。

- [ ] **Step 1: 写门禁测试**：等于基线通过、提升通过、任一指标下降失败、总数变化失败、缺字段/非法 JSON 失败。
- [ ] **Step 2: 运行确认失败**：`npx vitest run mcp-servers/kb/tests/regression-gate.test.ts`。
- [ ] **Step 3: 实现 `regression-gate.ts`**：按 spec §5.4，浮点比较用 `actual >= expected - 1e-9`；结构不合法 fail closed。
- [ ] **Step 4: 实现 `scripts/kb-review.mjs`**：
  - `--list`；
  - `--accept <id> --target <path> [--note]`：校验 target、读取 inbox 前后 mtime/size、spawn `scripts/kb-regression.mjs --json`、比较 baseline、失败不改 inbox；
  - `--reject <id> --reason`；
  - 缺 dist/baseline/KB/inbox 退出码 2。
- [ ] **Step 5: 更新 package.json 与 README**：`"kb:review": "node scripts/kb-review.mjs"`；README 给出三条命令。
- [ ] **Step 6: 验证**：单元测试 + `node scripts/kb-review.mjs --list`（真实语料存在时）+ `npm run typecheck`。
- [ ] **Step 7: 提交**：`feat(kb): 增加审核脚本与回归门禁`。

---

### Task 4: 诊断分析纯函数与 Renode 端到端脚本

**Files:**
- Create: `mcp-servers/probe/diagnosis.ts`
- Create: `mcp-servers/probe/tests/diagnosis.test.ts`
- Create: `scripts/diagnosis-e2e.mjs`
- Modify: `package.json`（`diagnosis:e2e`）
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2/3 的 KB 工具；`runSession`、`LogTailEventSource`、`RenodeBackend` 构建产物。
- Produces: `analyzeUartBaseline(registers): DiagnosisVerdict`；`npm run diagnosis:e2e`。

- [ ] **Step 1: 写诊断纯函数测试**：复位基线 → 根因“未初始化”、matchedKbSteps `[7,8]`；已初始化基线 → 不宣称根因、limitations 要求真板；混合状态 → 列出未满足项；所有分支 limitations 含“复位基线不等同真实故障”。
- [ ] **Step 2: 运行确认失败**：`npx vitest run mcp-servers/probe/tests/diagnosis.test.ts`。
- [ ] **Step 3: 实现 `diagnosis.ts`**：按 spec §6.1 的位定义与措辞。
- [ ] **Step 4: 实现 `scripts/diagnosis-e2e.mjs`**：按 spec §6.2；mock 模型固定工具序列；真实 Renode monitor 端口用空闲端口；MCP 配置写临时 home；从事件日志提取 `mem_read` hex；调用纯函数；用 `LogTailEventSource` 回放并断言。
- [ ] **Step 5: 验证**：`npx vitest run mcp-servers/probe/tests/diagnosis.test.ts`、`npm run build`、`npm run build:mcp`、`npm run diagnosis:e2e`（有 Renode 时必须通过；无 Renode 时确认退出码非 0 且信息明确）。
- [ ] **Step 6: 更新 README**：脚本用途、依赖、范围声明（仿真基线不是真实故障）。
- [ ] **Step 7: 提交**：`feat(probe): 增加 Renode 端到端诊断验收`。

---

### Task 5: 合并核验与最终复核（不写产品代码）

- [ ] **Step 1:** 运行全量验证：`npm test`、`npm run typecheck`、`npm run build`、`npm run build:mcp`、`npm run kb:regression -- --baseline`、`npm run diagnosis:e2e`。
- [ ] **Step 2:** 派发一个独立 reviewer 子代理，审查 Task 1-4 的全部 diff，输出 `final-review-1.md`（只读，不改文件）。
- [ ] **Step 3:** 按 reviewer findings 修复，复跑相关测试；在 `dev-notes/M2-阶段3.md` 记录。
- [ ] **Step 4:** 派发第二个独立 reviewer 做最终复核，输出 `final-review-2.md`；APPROVE 后更新 `docs/deferred-issues.md`（新增残余项）与 dev-notes。
- [ ] **Step 5:** 提交文档与留痕。