# P0 维度 3 可实现设计(上下文三级压缩)

> 日期: 2026-10-19 · 状态: 草稿待评审 · 上游: [p0-kernel-design.md](../../p0-kernel-design.md) §3, [BRD.md](../../BRD.md) NFR-5。
> 本轮交付终点: 二级修剪 + 三级 autocompact + usage 锚定, 接入 `query`/`runSession`, 单测+集成测试, 两轮独立审查后合并 `feat/p0`。不合并 `main`。

## 1. 意图与为什么

P0 已有一级"工具结果落盘"(超 8k tokens 写 `artifacts/`、上下文内截断), 但长会话仍会线性膨胀直到触窗。维度 3 补两级**只改模型视图、不改日志**的压缩:

- 二级 microcompact: 把更早轮次、未受保护的工具结果替换为占位, 保留工具名/一行摘要/artifact 引用。
- 三级 autocompact: 达 0.8 软阈值后, 用同一模型把老历史摘要为一条 summary, **尾部 16% verbatim 保留**。
- usage 锚定: 用真实 `prompt_tokens` 校准 4 字符/token 启发式。

证据链保护: `annotations.evidence` 的工具结果免修剪; 一切压缩只追加 `compaction` 事件, 原始事件永远在日志, 回放可复原。

## 2. 目标 / 非目标 / 反目标

### 目标

1. `buildMessages` 支持从日志中的 `compaction` 事件重建压缩视图:
   - `microcompact` 事件: 指定 `elidedSeqs` 的 tool_result 文本替换为占位;
   - `summary` 事件: 丢弃 `coversUpToSeq` 之前的事件, 插入一条摘要消息; 尾部 verbatim。
2. 工具结果携带 `evidence` 标记(来自 `ToolDef.annotations.evidence`), 供修剪保护。
3. `compactSession`(注入 `query.compactor`):
   - 超 0.8 软阈值 → 先追加 microcompact 事件;
   - 仍超 → 调同一模型摘要, 追加 summary 事件;
   - 摘要失败不阻塞主循环, 追加 `status`/`compaction_failed` 记录; 取消则传播。
4. `TokenMeter`: 启发式 + usage 锚定(EMA, clamp), 预算检查使用锚定值。
5. `runSession` 默认注入 compactor; `query` 在压缩后重新计算成本(摘要 usage 计入)。
6. 所有压缩可回放: 同一日志 + `buildMessages` 产生同一视图。

### 非目标

- 服务端 cache_edits / prompt cache 修复(P0 协议无); 只记录 `cached_tokens` 突降为告警(deferred)。
- 子代理 fork 摘要(P0 无子代理); 摘要用同模型独立请求。
- history snip / context collapse 的独立实现(并入二级/三级)。
- 压缩策略的 UI/配置面板; 本轮只提供代码默认值与可选注入。
- 改写历史事件或删除 artifacts。

### 反目标

- 压缩时修改/删除原始事件或 artifact。
- 修剪 `evidence:true` 的结果; 或直接丢弃未落盘的大输出。
- 摘要请求失败后静默假装成功(必须记录失败)。
- 把压缩后的视图写回日志(日志只追加 compaction 元数据)。

## 3. 约束

- TypeScript + Node 24 ESM-only, strict, 相对导入 `.js`; 不新增依赖。
- 日志唯一事实源; append-only; 压缩只追加 `compaction` 事件。
- 尾部 16% 按 token 估算保留, 且不得切断 assistant/tool_result 批次(复用 `buildMessages` 的批次完整性)。
- 摘要请求不携带工具; `maxOutputTokens` 取 `min(2048, modelCfg.maxOutput)`。
- 证据保护: `ToolResultPayload.evidence === true` 不修剪; 若 autocompact 仍需丢弃, 先确保其 `artifactPath` 存在(一级落盘), 否则保留。
- Windows 一等公民; 无新依赖; 每任务 TDD; 两轮独立审查。

## 4. 接口与行为

### 4.1 事件与类型

```ts
// src/session/types.ts
interface ToolResultPayload {
  id: string; ok: boolean; text: string;
  artifactPath?: string;
  code?: string; detail?: unknown;
  evidence?: boolean;      // 新增
  toolName?: string;       // 新增, 用于占位显示
}

type CompactionPayload =
  | { kind: "microcompact"; elidedSeqs: number[]; note: string }
  | { kind: "summary"; summary: string; coversUpToSeq: number } // 摘要 usage 另写独立 usage 事件
  | { kind: "failed"; reason: string; stage: "microcompact" | "summary" };
```

- `EventType` 已有 `compaction`(维度 6 预留)。
- 写入分工: pipeline 的 `runOne` 与重复 id 分支按工具名查询 `ToolDef.annotations.evidence`, 在结果中显式写 `evidence: boolean`(未注册或未标注时为 `false`), 不写 `toolName`; `query.toResultPayload` 写 `toolName: call.name`, 并在 `evidence !== undefined` 时透传 pipeline 的 `evidence`。
- `query` 把 `BatchResult` 转为 payload 时保留这两个字段(现有 `toResultPayload` 扩展)。

### 4.2 `buildMessages` 压缩视图

签名保持 `buildMessages(events: readonly SessionEvent[]): ModelChatMessage[]`; 内部先扫描 `compaction` 事件:

1. 收集所有 `microcompact` 的 `elidedSeqs` 并集(仅接受整数 seq, NaN/浮点忽略); 投影 tool_result 时若 seq 命中且 `payload.evidence !== true`, 且有收益(占位短于原文)才替换:
   - 有 `artifactPath` → `[tool result elided; full output at <artifactPath>]`
   - 否则 → `[tool result elided; <toolName>: <首行 120 字符>]`; `toolName` 缺失时回退为 `tool`
   - 若占位不短于原文 → **保留原文**; 若 `payload.evidence === true` → **跳过替换, 投影原文**(投影层防御, 即使日志被旧版本/手工写入错误 elide, 即使同时带 `artifactPath`)。
2. 按事件顺序扫描 `summary` 事件, 只采信同时满足以下条件的项, 并保持 `coversUpToSeq` 不倒退:
   - 非空 summary; `coversUpToSeq` 为 `0..lastSeq` 且**小于 summary 事件自身 seq** 的整数(否则会覆盖摘要写入之后的事件);
   - 不落在批次中间(边界覆盖的 assistant 批次仍有 tool_result 在边界之后);
   - 不覆盖任何 `evidence` 结果。
   坏或倒退的 summary 被忽略, **回退到上一条已采信的有效 summary**(无则原视图); 不抛错、不写 stderr。
   - **所有 `system` 事件始终保留**; 非 system 事件只投影 `seq > coversUpToSeq`(尾部 verbatim);
   - 在最后一个 system 消息之后插入 `{ role:"system", content:"[Conversation summary]\n"+summary }`;
   - 被 summary 丢弃的前缀不再做 system 位置/工具批次校验, 只校验保留下来的尾部与始终保留的 system; 因此旧日志中不完整的前缀不会阻止投影。
3. `compaction` 事件本身不进入消息; `failed` 事件忽略。
4. 既有 system/user/assistant/tool_result 校验对投影后的视图保持不变; microcompact 只改 tool 消息的 content, 不改顺序。

### 4.3 `TokenMeter`

```ts
// src/context/token-meter.ts
interface TokenMeter {
  measure(messages: ModelChatMessage[]): number;       // 锚定后的估算
  observe(promptTokens: number, messages: ModelChatMessage[]): void;
  ratio(): number;
}
createTokenMeter(heuristic: (m: ModelChatMessage[]) => number): TokenMeter;
```

- 初始 ratio = 1; `observe`: `raw = promptTokens / max(1, heuristic(messages))`, clamp `[0.5, 2.0]`, EMA `ratio = 0.5*ratio + 0.5*raw`; `measure = ceil(heuristic * ratio)`。
- `promptTokens <= 0`/非有限 → 不更新。
- `query` 每次 complete 成功后 `meter.observe(resp.usage.promptTokens, messages)`; 预算统一走 `LoopCtx.budget`(签名不变, 唯一入口), 由装配层注入 `(m) => checkBudgetTokens(meter.measure(m), contextWindow, softRatio)`。
- **裁定**: 新增 `checkBudgetTokens(tokens, contextWindow, softRatio=0.8)`; `LoopCtx.budget` 保持 `(messages) => {over,tokens,softLimit}`; query 不硬编码 0.8; 保留 `checkBudget` 供旧测试/调用。

### 4.4 `compactSession`

```ts
// src/context/compact.ts
interface CompactOptions {
  session: SessionHandle;
  model: ModelProtocol;
  modelCfg: ModelCfg;
  pricePerMillion?: PriceTable;
  keepRecentTurns?: number;    // 默认 2
  keepTailRatio?: number;      // 默认 0.16
  softRatio?: number;          // 默认 0.8
  meter?: TokenMeter;
  signal: AbortSignal;
}
async function compactSession(opts: CompactOptions): Promise<void>;
```

流程:
1. `messages = buildMessages(session.events())`; `tokens = meter.measure(messages)`; 若 `tokens <= floor(contextWindow*softRatio)` → 返回(不压缩)。
2. **二级**: 计算候选 tool_result seq:
   - 只考虑非 evidence、非最近 `keepRecentTurns` 轮的 tool_result;
   - 已 elided 的不重复;
   - 若候选非空 → append `compaction {kind:"microcompact", elidedSeqs, note}`;
   - 重新 `buildMessages` + measure; 仍不超 → 返回。
3. **三级**: 计算 `coversUpToSeq`:
   - 从最新事件往前累计 token(简化: 按事件文本长度/4 累计), 直到累计 ≥ `contextWindow*keepTailRatio`;
   - 边界必须落在完整 turn(前缀可被 `buildMessages` 投影), 且**不得覆盖任何 evidence tool_result**; 若边界会覆盖 evidence, 回退到该 evidence 事件之前;
   - 若回退后没有可摘要内容 → append `compaction {kind:"failed", reason, stage:"summary"}` 并返回;
   - 摘要输入 = `buildMessages(events[0..coversUpToSeq])`, 转成纯文本 transcript(role: content, tool calls 简述), 截断到 `contextWindow*0.6` token;
   - `model.complete([{role:"system",content:SUMMARY_PROMPT},{role:"user",content:transcript}], [], {signal, maxOutputTokens: min(2048,maxOutput)})`;
   - 成功 → 先 append 独立 `usage` 事件(摘要的 prompt/completion/cached), 再 append `compaction {kind:"summary", summary, coversUpToSeq}`; 失败(非取消) → append `compaction {kind:"failed", reason, stage:"summary"}` 并返回; 取消 → 抛。
4. 摘要 prompt: "Summarize the conversation for continuation. Preserve: user goals, decisions, tool evidence references, open questions, and exact identifiers. Do not invent facts. Output plain text."
5. 摘要成功后不修改历史事件; 下一次 `buildMessages` 自动应用。

### 4.5 `query` 接入

- `LoopCtx` 增加可选 `meter?: TokenMeter` 和 `compactor?: (session) => Promise<void>`(已有)。
- 每轮:
  - `messages = buildMessages(session.events())`;
  - `if (ctx.budget(messages).over && ctx.compactor) { await ctx.compactor(session); messages = buildMessages(...); }`
  - complete 后 `ctx.meter?.observe(resp.usage?.promptTokens, messages)`。
- `costUsd` 在 compactor 调用后重新计算 `computeCostUsd(session.usageTotals(), price)`(摘要 usage 已作为独立 usage 事件落日志); `usageTotals` 是会话累计, `costUsd` 直接赋值, 不累加。
- `compactor` 抛取消 → 走 interrupted(aborted); 其他错误 → 主循环上抛? **裁定**: compactor 的 `failed` 已在内部记录并返回; 未捕获的异常按主循环错误上抛。

### 4.6 `runSession` 装配

- `createTokenMeter(heuristicCountTokens)`; `compactor: (session) => compactSession({session, model, modelCfg, pricePerMillion, signal, meter, ...})`。
- `RunOptions.compaction?: { enabled?: boolean; keepRecentTurns?: number; keepTailRatio?: number; softRatio?: number }`; 缺省 `enabled:true`, 其余默认值如上。
- `enabled:false` 时不注入 compactor/meter, 保留现有行为; `budget` 仍用 `checkBudget`(启发式)。

### 4.7 一级落盘边界

一级已由 pipeline 实现(>8k tokens 落盘、text 截断 25k); 本维度不重复。microcompact 对已有 `artifactPath` 的结果保留引用; 无 artifact 的非 evidence 结果才用首行占位。

## 5. 测试策略

- buildMessages: microcompact 替换指定 seq; evidence/最近轮不修剪; summary 过滤旧事件 + 插入摘要; coversUpToSeq 落批次中间时忽略; compaction 不进消息; 回放幂等。
- TokenMeter: 初始 1; observe 正常/异常; clamp; EMA; measure。
- compactSession: 未超不压缩; 二级修剪候选/evidence 保护/最近轮; 二级后仍超 → 摘要; 尾部 16% 边界; 摘要失败记录; 取消传播; usage 落日志; 幂等(重复调用不重复 elide)。
- query: 注入 compactor 触发/compacted 事件; 压缩后消息不含旧结果; cost 含摘要 usage; compaction off 不触发。
- pipeline: tool_result payload 带 evidence/toolName。
- 集成: mock 模型摘要 + 多轮工具结果; 断言模型收到的 messages 含 summary 与尾部。
- 覆盖率: 新增代码 line ≥90%。

## 6. 验收口径

1. `npm test` 全绿; coverage lines ≥85%; lint/typecheck/build 通过。
2. 超阈值时先 microcompact、仍超再 summary; evidence 结果不被修剪。
3. 日志可回放: 同一日志 `buildMessages` 结果稳定; 原始事件/artifacts 不被修改。
4. 摘要失败/取消有明确记录/传播; 不静默。
5. 两轮独立审查通过; dev-notes 增量留痕。

## 7. 留给实现的自由

- 逐事件 token 估算的具体算法(可复用 4 字符/token)。
- summary 消息用 system 还是 user role(倾向 system, 置于原 system 后)。
- 摘要 prompt 的具体措辞。
- `keepRecentTurns` 的轮次定义(assistant 批次为一轮)。
- `compaction` 事件的 note 文案。