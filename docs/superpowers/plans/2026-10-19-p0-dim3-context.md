# P0 维度 3 上下文三级压缩实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有"工具结果落盘"之上补二级 microcompact 与三级 autocompact，接入 `query`/`runSession`，压缩只追加 `compaction` 事件、不改日志与 artifacts。

**Architecture:** `buildMessages` 从日志中的 `compaction` 事件重建压缩视图；`TokenMeter` 用真实 usage 锚定启发式；`compactSession` 先修剪旧工具结果，仍超阈值再调用同一模型摘要；`runSession` 注入 meter/compactor/budget。

**Tech Stack:** TypeScript + Node 24(ESM-only)、Zod v4、vitest v4。不新增依赖。

**Spec:** [2026-10-19-p0-dim3-context-design.md](../specs/2026-10-19-p0-dim3-context-design.md)

## Global Constraints

- Node >= 24, ESM-only, strict, 相对导入 `.js`; 不新增依赖; 不加代码注释。
- 压缩只追加 `compaction` 事件; 不修改/删除历史事件与 artifacts; 日志是唯一事实源。
- evidence 工具结果不修剪; summary 边界不得覆盖 evidence。
- 尾部 16% verbatim; 不切断 assistant/tool_result 批次。
- 摘要请求不携带工具; `maxOutputTokens = min(2048, modelCfg.maxOutput)`。
- 每任务 TDD; 分支 `feat/p0-dim3-context`; 不合并 `main`。

## Review Focus

1. microcompact 不得 elide evidence；投影层对日志中错误 elide 做防御。→ Task 1
2. summary 必须保留所有 system 事件与尾部 16%。→ Task 1/3
3. `coversUpToSeq` 落批次中间或覆盖 evidence 时回退/失败，不产出不可投影视图。→ Task 3
4. 摘要 usage 必须计入 `usageTotals` 与成本。→ Task 3/4
5. 未超阈值不压缩；二级后仍超才摘要；重复调用幂等。→ Task 3
6. `compaction.enabled:false` 保留旧行为。→ Task 4
7. 摘要失败/取消不静默。→ Task 3/4

---

### Task 1: 事件字段与 `buildMessages` 压缩视图

**Files:**
- Modify: `src/session/types.ts`
- Modify: `src/tools/types.ts`
- Modify: `src/tools/pipeline.ts`
- Modify: `src/loop/query.ts`
- Modify: `src/context/build.ts`
- Test: `tests/build.test.ts`、`tests/pipeline.test.ts`

**Interfaces:**
- Consumes: 现有 `SessionEvent/ToolResultPayload`、`buildMessages`
- Produces:
  - `ToolResultPayload` 增加 `evidence?: boolean; toolName?: string`
  - `ToolResult` 增加 `evidence?: boolean`
  - `CompactionPayload` 联合(`microcompact`/`summary`/`failed`)
  - `buildMessages(events)` 应用 compaction 事件

- [ ] **Step 1: 写失败测试**

```ts
it("microcompact 替换指定 tool_result，evidence 跳过", () => {
  // events: assistant(tool_calls c1,c2) + tool_result(c1 evidence:true) + tool_result(c2)
  // compaction microcompact elidedSeqs:[c1seq,c2seq]
  // 断言 c1 原文保留、c2 为 elided 占位
});
it("summary 保留 system 与尾部，丢弃 coversUpToSeq 之前非 system", () => {});
it("summary 边界落批次中间时忽略该 summary", () => {});
it("pipeline 写入 evidence/toolName", async () => {});
```

- [ ] **Step 2: RED**

Run: `node ./node_modules/vitest/vitest.mjs run tests/build.test.ts tests/pipeline.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`pipeline` 在结果规范化后写 `evidence = tool.annotations?.evidence === true`；`query.toResultPayload` 写 `toolName`/`evidence`；`buildMessages` 先收集 compaction：microcompact 只替换非 evidence 的 tool 消息，summary 保留 system、过滤非 system、插入摘要 system 消息，批次不完整则忽略 summary。

- [ ] **Step 4: 验证**

Run: `node ./node_modules/vitest/vitest.mjs run tests/build.test.ts tests/pipeline.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/session/types.ts src/tools/types.ts src/tools/pipeline.ts src/loop/query.ts src/context/build.ts tests/build.test.ts tests/pipeline.test.ts
git commit -m "feat(context): 压缩事件投影与evidence标记"
```

---

### Task 2: TokenMeter 与预算入口

**Files:**
- Create: `src/context/token-meter.ts`
- Modify: `src/context/budget.ts`
- Test: `tests/token-meter.test.ts`、`tests/budget.test.ts`

**Interfaces:**
- Consumes: `heuristicCountTokens`
- Produces:
  - `createTokenMeter(heuristic): TokenMeter`(measure/observe/ratio)
  - `checkBudgetTokens(tokens, contextWindow, softRatio=0.8): {over,tokens,softLimit}`

- [ ] **Step 1: 写失败测试**

```ts
it("初始 ratio=1，observe 后按 EMA 锚定", () => {});
it("clamp [0.5,2.0]，非法 usage 不更新", () => {});
it("checkBudgetTokens 使用 softRatio", () => {});
```

- [ ] **Step 2: RED**

Run: `node ./node_modules/vitest/vitest.mjs run tests/token-meter.test.ts tests/budget.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`observe` 用 `promptTokens / max(1, heuristic(messages))`，clamp + EMA；`measure = ceil(heuristic*ratio)`；`checkBudgetTokens` 与现有 `checkBudget` 同义但接受 tokens/softRatio。

- [ ] **Step 4: 验证**

Run: `node ./node_modules/vitest/vitest.mjs run tests/token-meter.test.ts tests/budget.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/context/token-meter.ts src/context/budget.ts tests/token-meter.test.ts tests/budget.test.ts
git commit -m "feat(context): usage锚定token计数"
```

---

### Task 3: `compactSession` 二级/三级压缩

**Files:**
- Create: `src/context/compact.ts`
- Test: `tests/compact.test.ts`

**Interfaces:**
- Consumes: Task 1 compaction 事件、Task 2 TokenMeter、`buildMessages`、`SessionHandle`、`ModelProtocol`
- Produces:
  - `compactSession(opts: CompactOptions): Promise<void>`
  - `CompactOptions { session, model, modelCfg, keepRecentTurns?, keepTailRatio?, softRatio?, meter, signal }`

- [ ] **Step 1: 写失败测试**

```ts
it("未超阈值不追加事件", async () => {});
it("二级 elide 非 evidence、非最近轮，并保留 artifact 引用", async () => {});
it("二级后仍超 → 摘要请求，append usage + summary，尾部保留", async () => {});
it("summary 边界不覆盖 evidence；无法摘要时 append failed", async () => {});
it("摘要失败 append failed；取消传播", async () => {});
it("重复调用不重复 elide", async () => {});
```

- [ ] **Step 2: RED**

Run: `node ./node_modules/vitest/vitest.mjs run tests/compact.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

按设计 §4.4：候选 seq 过滤、append microcompact、重新 measure；仍超计算 `coversUpToSeq`（尾部 16%、批次边界、evidence 回退），摘要 transcript 截断 60%，`model.complete` 不带 tools；成功先 append usage 再 append summary；失败/取消记录。

- [ ] **Step 4: 验证**

Run: `node ./node_modules/vitest/vitest.mjs run tests/compact.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/context/compact.ts tests/compact.test.ts
git commit -m "feat(context): 二级修剪与三级摘要"
```

---

### Task 4: `query`/`runSession` 接入

**Files:**
- Modify: `src/loop/query.ts`
- Modify: `src/index.ts`
- Modify: `src/session/errors.ts`(如需)
- Test: `tests/query.test.ts`、`tests/integration.test.ts`

**Interfaces:**
- Consumes: Task 2/3、现有 `LoopCtx.budget/compactor`
- Produces:
  - `LoopCtx.meter?: TokenMeter`
  - query 在 compactor 后重算 `costUsd`
  - `RunOptions.compaction?: { enabled?, keepRecentTurns?, keepTailRatio?, softRatio? }`
  - `runSession` 注入 meter/budget/compactor

- [ ] **Step 1: 写失败测试**

```ts
it("超阈值触发 compactor，compacted 事件后视图含摘要/占位", async () => {});
it("摘要 usage 计入 maxCostUsd", async () => {});
it("compaction.enabled:false 不注入、不压缩", async () => {});
it("meter.observe 在 complete 后更新预算", async () => {});
```

- [ ] **Step 2: RED**

Run: `node ./node_modules/vitest/vitest.mjs run tests/query.test.ts tests/integration.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

query: 每轮用 `ctx.budget(messages)`；compactor 后重建 messages 并重算 cost；complete 后 `meter.observe`。runSession: 创建 meter、budget、compactor；`compaction.enabled:false` 时用旧 `checkBudget` 且不注入 compactor。

- [ ] **Step 4: 验证**

Run: `node ./node_modules/vitest/vitest.mjs run tests/query.test.ts tests/integration.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/loop/query.ts src/index.ts tests/query.test.ts tests/integration.test.ts
git commit -m "feat(context): 接入主循环与runSession"
```

---

### Task 5: 收尾

**Files:**
- Modify: `README.md`、`docs/deferred-issues.md`
- Create: `dev-notes/P0-维度3.md`
- Test: 全量

- [ ] **Step 1: 全量验证**

Run: `npm test && npm run coverage && npm run lint && npm run typecheck && npm run build`
Expected: 全绿; lines ≥85%; 新增代码 line ≥90%。

- [ ] **Step 2: README/deferred/留痕**

README 补三级压缩、`RunOptions.compaction`、evidence 保护、摘要成本；deferred 登记 prompt cache 断裂告警、摘要质量、逐事件估算等；dev-notes 四要素。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/deferred-issues.md dev-notes/P0-维度3.md
git commit -m "docs(context): 补维度3说明与留痕"
```

---

## Self-Review

- **Spec coverage**: §4.1→Task1; §4.2→Task1; §4.3→Task2; §4.4→Task3; §4.5/4.6→Task4; §5/§6→各任务测试+Task5。无缺口。
- **Type consistency**: `TokenMeter` Task2 定义、Task3/4 消费；`CompactionPayload` Task1 定义、Task3 写入；`checkBudgetTokens` Task2 定义、Task4 装配。
- **Review Focus**: 7 条已归入 Task1/3/4 测试。
- **Proportion**: 5 个任务，代码块仅断言与签名。