# P0 维度 6 会话管理实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 append-only 会话层补成可 resume、可 fork、可审计、可分代的事实源, 并接入 `runSession` 与 `query` 的 checkpoint/成本累计。

**Architecture:** 在 `src/session/` 下拆出 `errors.ts`(结构化错误)、`persistence.ts`(读取/resume/fork), `session.ts` 保留 create/append/close/rollover; `query` 在每次 `complete` 前写 checkpoint, 并用 `usageTotals()` 初始化会话级成本; `runSession` 增加 `resume` 入口。

**Tech Stack:** TypeScript + Node 24(ESM-only)、Zod v4(已有)、vitest v4。不新增依赖。

**Spec:** [2026-10-18-p0-dim6-session-design.md](../specs/2026-10-18-p0-dim6-session-design.md)

## Global Constraints

- Node >= 24, ESM-only, strict, 相对导入 `.js`; 不新增运行时依赖; 不加代码注释。
- 日志是唯一事实源: resume/fork 后模型可见内容必须能从新目录日志重建。
- append-only: 既有事件不可修改/删除; rollover 只切换文件。
- fail-closed: 坏 header/坏行/seq 不递增/未知 type → `SessionCorruptionError`, 不静默跳过。
- Windows 一等公民: header 原子写用同目录临时文件 + rename; 路径用 `node:path`。
- 每个任务 TDD: 先写失败测试 → RED → 最小实现 → GREEN → 全量验证 → 提交。
- 分支 `feat/p0-dim6-session`; 不合并 `main`; 依赖安装由用户手动执行。

## Review Focus

1. resume 的旧 header 没有 `model` 字段 → 不比较, 允许 resume。→ Task 6
2. fork 的 `atSeq` 为负数/越界/使前缀不可被 `buildMessages` 投影 → `SessionForkError`, 不写任何文件。→ Task 5
3. fork 的 `artifactPath` 指向不存在/源目录外/相对路径 → 不复制、标记 `artifactMissing`, 不越界写。→ Task 5
4. rollover 阈值极小或单条事件超过阈值 → 仍写当前代, 不拆分一行、不无限建文件。→ Task 5
5. resume 后日志尾部是坏行/半行 → fail-closed, 不吞掉。→ Task 3
6. close 的 header 原子写失败 → 抛错且不标记 closed。→ Task 2
7. `runSession` resume 时 model/systemPrompt 与 header 不一致 → 结构化错误, 不静默沿用。→ Task 6
8. checkpoint 不进入 `LoopEvent` 流, 只落日志; 现有事件序列断言不应改变。→ Task 7

---

### Task 1: 会话类型、header 与结构化错误

**Files:**
- Modify: `src/session/types.ts`
- Create: `src/session/errors.ts`
- Modify: `src/session/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface SessionHeader { id: string; createdAt: string; status: "open" | "closed"; provider?: string; model?: string; workdir?: string; forkedFrom?: { sessionId: string; seq: number } }`
  - `EventType` 增加 `"compaction"`
  - `class SessionCorruptionError extends Error { code: "invalid_header" | "invalid_event_line" | "invalid_seq" | "unknown_event_type" }`
  - `class SessionForkError extends Error { code: "not_turn_boundary" | "target_not_empty" | "invalid_target" }`
  - `class SessionResumeError extends Error { code: "model_mismatch" | "system_prompt_mismatch" | "missing_session_dir" }`
  - `createSession(dir, opts?: { systemPrompt?: string; id?: string; provider?: string; model?: string; workdir?: string; generationThresholdBytes?: number })`
  - `SessionHandle.header: SessionHeader`
  - `close()` 原子更新 `status:"closed"`; 重复 close 幂等

- [ ] **Step 1: 写失败测试**

```ts
it("createSession 写入 header 元数据且状态 open", async () => {
  const s = await createSession(tmp, { provider: "gw", model: "flash", workdir: "/w" });
  expect(s.header).toMatchObject({ id: s.id, status: "open", provider: "gw", model: "flash", workdir: "/w" });
  const onDisk = JSON.parse(readFileSync(path.join(tmp, "header.json"), "utf8"));
  expect(onDisk.status).toBe("open");
});
it("close 原子更新 status 为 closed 且幂等", async () => {
  const s = await createSession(tmp);
  await s.close(); await s.close();
  expect(JSON.parse(readFileSync(path.join(tmp, "header.json"), "utf8")).status).toBe("closed");
});
it("close 后 append 拒绝", async () => {
  const s = await createSession(tmp); await s.close();
  await expect(s.append({ type: "user", payload: { content: "x" } })).rejects.toThrow();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session.test.ts`
Expected: FAIL(header 元数据/closed 断言失败)。

- [ ] **Step 3: 实现 types/errors 与 session.close**

`types.ts` 定义 `SessionHeader` 并让 `EventType` 含 `compaction`; `session.ts` 的 header 改为 `SessionHeader`, `close()` 先 `pending` 排空, 再用 `writeFile(tmp) -> rename` 原子写 closed; 写失败时抛错且保留原 header。重复 close 返回同一 promise。

- [ ] **Step 4: 验证通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/session tests/session.test.ts
git commit -m "feat(session): 补齐header生命周期与结构化错误"
```

---

### Task 2: readSessionDir 与损坏 fail-closed

**Files:**
- Create: `src/session/persistence.ts`
- Test: `tests/session-persistence.test.ts`

**Interfaces:**
- Consumes: Task 1 `SessionHeader`, `SessionCorruptionError`, `EventType`
- Produces:
  - `readSessionDir(dir: string): { header: SessionHeader; events: SessionEvent[] }`
  - 规则: 列 `session.v*.jsonl` 按数字升序; 空行跳过; seq 全局严格递增且从 0 开始; type 属于 `EventType`; 否则抛对应 `SessionCorruptionError`(detail 含文件与行号)

- [ ] **Step 1: 写失败测试**

```ts
it("读取单代事件并按 seq 校验", async () => { /* createSession + append 2 条, readSessionDir 断言 */ });
it("跨代读取按 v1/v2 顺序合并", async () => { /* 手工写 session.v1.jsonl 与 session.v2.jsonl, seq 连续 */ });
it("坏 header → invalid_header", async () => { /* 写 "{bad" */ });
it("坏行 → invalid_event_line 且 detail 含文件/行号", async () => {});
it("seq 跳号 → invalid_seq", async () => {});
it("未知 type → unknown_event_type", async () => {});
it("空目录/无日志 → 抛错", async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session-persistence.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 persistence.ts**

用 `readdir(dir)` 过滤 `^session\.v(\d+)\.jsonl$`, 数字排序; `readFileSync` 逐行; header 用 `JSON.parse` + 字段校验 `id/createdAt/status`; 错误 detail 为 `{file, line}`。

- [ ] **Step 4: 验证通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session-persistence.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/session/persistence.ts tests/session-persistence.test.ts
git commit -m "feat(session): 读取目录并fail-closed校验"
```

---

### Task 3: resumeSession 与 usageTotals

**Files:**
- Modify: `src/session/session.ts`
- Modify: `src/session/persistence.ts`
- Test: `tests/session-persistence.test.ts`、`tests/session.test.ts`

**Interfaces:**
- Consumes: Task 2 `readSessionDir`
- Produces:
  - `resumeSession(dir: string, opts?: { generationThresholdBytes?: number }): Promise<SessionHandle>`
  - `SessionHandle.usageTotals(): { promptTokens: number; completionTokens: number; cachedTokens: number }`
  - 规则: `nextSeq = lastSeq + 1`; 追加到最后一个代文件; header status 改回 open; 空目录/无日志抛错

- [ ] **Step 1: 写失败测试**

```ts
it("resume 恢复事件并续写 seq", async () => {
  const s = await createSession(tmp); await s.append({ type: "user", payload: { content: "a" } }); await s.close();
  const r = await resumeSession(tmp);
  expect(r.events().map(e => e.seq)).toEqual([0]);
  const ev = await r.append({ type: "user", payload: { content: "b" } });
  expect(ev.seq).toBe(1);
});
it("resume closed 目录后 header 改回 open", async () => {});
it("usageTotals 累加并忽略缺失字段", async () => {
  // append usage 两次, 一次缺 cachedTokens
});
it("resume 空目录抛错", async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session-persistence.test.ts tests/session.test.ts`
Expected: FAIL(resumeSession 不存在)。

- [ ] **Step 3: 实现**

从 `createSession` 抽出内部 `createHandle(dir, header, eventList, nextSeq, threshold)` 供 create/resume 共用; `usageTotals` 遍历 `events()` 的 `usage` payload 累加有限数字。resume 读取后原子写 header `status:"open"`。

- [ ] **Step 4: 验证通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session-persistence.test.ts tests/session.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/session tests/session-persistence.test.ts tests/session.test.ts
git commit -m "feat(session): resume恢复与usage汇总"
```

---

### Task 4: forkSession 与 artifact 自包含

**Files:**
- Modify: `src/session/persistence.ts`
- Test: `tests/session-persistence.test.ts`

**Interfaces:**
- Consumes: Task 2 `readSessionDir`, Task 3 内部 handle 构造
- Produces:
  - `forkSession(sourceDir: string, atSeq: number, opts?: { targetDir?: string; id?: string }): Promise<SessionHandle>`
  - 规则: `atSeq` 必须使 `events[0..atSeq]` 可被 `buildMessages` 投影(批次闭合); 前缀保留 seq/parent; `header.forkedFrom={sessionId,seq}`; target 非空抛 `target_not_empty`; artifact 复制并重写路径, 缺失标记 `detail.artifactMissing=true`

- [ ] **Step 1: 写失败测试**

```ts
it("在 tool_result 边界 fork 并保留前缀/ parent", async () => { /* 构造 user/assistant/tool_result, fork */ });
it("在前缀不可投影(批中 usage/部分 result/未闭合批次)/越界/负数 fork → not_turn_boundary", async () => {});
it("fork header.forkedFrom 正确且原会话不受影响", async () => {
  // fork 后向新会话 append, 原会话 events 不变
});
it("artifact 复制并重写路径", async () => {
  // tool_result payload.artifactPath 指向源 artifacts 文件
});
it("artifact 缺失 → 保留原路径并标记", async () => {});
it("targetDir 非空 → target_not_empty", async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session-persistence.test.ts`
Expected: FAIL(forkSession 不存在)。

- [ ] **Step 3: 实现**

校验 atSeq 边界并用 `buildMessages` 校验前缀可投影; 克隆前缀事件(深拷贝), 对 `tool_result.payload.artifactPath` 用 `path.basename` 复制到新 `artifacts/`; 若源文件不存在则标记。写 header 与新 `session.v1.jsonl`, 用 Task 3 的 handle 构造, `nextSeq=atSeq+1`。

- [ ] **Step 4: 验证通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session-persistence.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/session/persistence.ts tests/session-persistence.test.ts
git commit -m "feat(session): turn边界fork与artifact自包含"
```

---

### Task 5: 分代 rollover

**Files:**
- Modify: `src/session/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: Task 1 `createSession` opts、Task 2 `readSessionDir`
- Produces:
  - append 前按 `generationThresholdBytes`(默认 50MiB)切换 `session.vN+1.jsonl`; 当前文件非空且 `bytes + line > threshold` 才切换; 单条超阈值仍写当前代
  - 非法阈值 → `TypeError`

- [ ] **Step 1: 写失败测试**

```ts
it("阈值 1KB 时写入跨代, 读取合并且 seq 连续", async () => {
  const s = await createSession(tmp, { generationThresholdBytes: 1024 });
  for (let i = 0; i < 20; i++) await s.append({ type: "user", payload: { content: "x".repeat(200) } });
  await s.close();
  const { events } = readSessionDir(tmp);
  expect(events.map(e => e.seq)).toEqual([...Array(20).keys()]);
  expect(existsSync(path.join(tmp, "session.v2.jsonl"))).toBe(true);
});
it("非法阈值抛 TypeError", async () => {
  await expect(createSession(tmp, { generationThresholdBytes: 0 })).rejects.toBeInstanceOf(TypeError);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session.test.ts`
Expected: FAIL(未跨代)。

- [ ] **Step 3: 实现**

handle 维护 `currentFile`、`currentBytes`; 首次创建/恢复时 `stat` 校准; append 计算 `line = JSON.stringify(event) + "\n"` 字节数; 超阈值时 `open("wx")` 下一代。`close` 更新 header 不变。

- [ ] **Step 4: 验证通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/session.test.ts tests/session-persistence.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/session/session.ts tests/session.test.ts
git commit -m "feat(session): JSONL分代rollover"
```

---

### Task 6: runSession resume 接入

**Files:**
- Modify: `src/index.ts`
- Test: `tests/integration.test.ts`

**Interfaces:**
- Consumes: Task 3 `resumeSession`, `SessionResumeError`; 现有 `createSession`
- Produces:
  - `RunOptions.resume?: boolean`; `resume:true` 时 `sessionDir` 必填
  - create 时 header 写 `provider/model/workdir`
  - resume 时 model 与 header.model 不一致 → `SessionResumeError("model_mismatch")`; systemPrompt 不一致 → `SessionResumeError("system_prompt_mismatch")`

- [ ] **Step 1: 写失败测试**

```ts
it("resume:true 继续同一会话并续写事件", async () => {
  // 第一次 runSession 产生日志, 第二次 resume:true 继续
});
it("resume:true 缺 sessionDir → SessionResumeError", async () => {});
it("resume:true 且 model 不一致 → model_mismatch", async () => {});
it("resume:true 且 systemPrompt 不一致 → system_prompt_mismatch", async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/integration.test.ts`
Expected: FAIL(resume 未实现)。

- [ ] **Step 3: 实现**

`runSession` 在 providers 解析后: 若 `resume` 则 `resumeSession(sessionDir)`, 比较 `header.model`(存在时)与 `opts.model`; 比较已有 system 内容与 `opts.systemPrompt`(提供时)。create 路径传 provider/model/workdir 给 `createSession`。

- [ ] **Step 4: 验证通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/integration.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/index.ts tests/integration.test.ts
git commit -m "feat(session): runSession接入resume"
```

---

### Task 7: query checkpoint 与会话级成本

**Files:**
- Modify: `src/loop/query.ts`
- Test: `tests/query.test.ts`

**Interfaces:**
- Consumes: Task 1 `EventType`(checkpoint)、Task 3 `usageTotals`
- Produces:
  - 每次 `complete` 前 `session.append({ type:"checkpoint", payload:{ turn } })`
  - `costUsd` 初始化为 `computeCostUsd(session.usageTotals(), ctx.pricePerMillion)`
  - checkpoint 不进入 `LoopEvent` 流

- [ ] **Step 1: 写失败测试**

```ts
it("每轮 complete 前落 checkpoint 且不进入事件流", async () => {
  // 两轮 provider, 断言 session.events 中 checkpoint 位于各轮 assistant 之前
  // 断言 collect(query) 的 kind 序列没有 checkpoint
});
it("resume 会话的 maxCostUsd 计入历史 usage", async () => {
  // 先写一条 usage 事件, 再 query 且 maxCostUsd 极小 → done(max_cost_usd)
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/query.test.ts`
Expected: FAIL(无 checkpoint/历史成本)。

- [ ] **Step 3: 实现**

在每轮 breakers 检查后、`buildMessages` 前 append checkpoint; `costUsd = computeCostUsd(session.usageTotals(), ctx.pricePerMillion)` 替换 `let costUsd = 0`。

- [ ] **Step 4: 验证通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/query.test.ts tests/integration.test.ts && npm run typecheck`
Expected: PASS; 既有事件序列断言不变(若因日志断言失败, 只更新预期, 不改语义)。

- [ ] **Step 5: 提交**

```bash
git add src/loop/query.ts tests/query.test.ts
git commit -m "feat(loop): 写checkpoint并累计会话成本"
```

---

### Task 8: 收尾

**Files:**
- Modify: `README.md`
- Modify: `docs/deferred-issues.md`
- Modify: `dev-notes/P0-维度6.md`
- Test: 全量

**Interfaces:**
- Consumes: 全部
- Produces: 可交接文档

- [ ] **Step 1: 全量验证与覆盖率**

Run: `npm test && npm run coverage && npm run lint && npm run typecheck && npm run build`
Expected: 全绿; lines ≥85%; 新增代码 line ≥90%。

- [ ] **Step 2: 更新 README**

补 resume 用法(`RunOptions.resume`)、fork 库 API、header 状态、分代文件、checkpoint; 不写未实现功能。

- [ ] **Step 3: 更新 deferred 与 dev-notes**

deferred: 跨进程会话锁、fork 树导航、FTS5、zstd 等(若未登记)。dev-notes 按四要素记录: 用户原话“推进剩下4个维度”、关键产出、纠偏、翻车。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/deferred-issues.md dev-notes/P0-维度6.md
git commit -m "docs(session): 补维度6说明与留痕"
```

---

## Self-Review

- **Spec coverage**: 目标 1→Task 1; 2→Task 3; 3→Task 4; 4→Task 7; 5→Task 5; 6→Task 3/7; 7→Task 4/6 测试; 4.4.1→Task 6; 4.5 artifact→Task 4; 4.9 隔离→Task 4 测试。无缺口。
- **Type consistency**: `SessionHeader` 贯穿 Task 1/2/3/4; `usageTotals()` 在 Task 3 定义、Task 7 消费; `resumeSession` Task 3 定义、Task 6 消费; `SessionCorruptionError/ForkError/ResumeError` 在 Task 1 定义。
- **Review Focus**: 8 条均已归入对应任务测试(Task 2/3/4/5/6/7)。
- **Proportion**: 8 个任务, 代码块仅测试断言与签名, 未写实现体。