# P0 维度 6 可实现设计(会话管理与隔离)

> 日期: 2026-10-18 · 状态: 草稿待评审 · 上游: [p0-kernel-design.md](../../p0-kernel-design.md) §6, [BRD.md](../../BRD.md) PLAT-2/BR-6。
> 本轮交付终点: 可运行代码 + 单测, 通过两轮独立审查后合并 `feat/p0`。不合并 `main`。

## 1. 意图与为什么

现有会话层只覆盖维度 1+2 所需的最小集: append-only JSONL、system 首条、seq/parent、深冻结、close 等。维度 6 要把它补成可恢复、可派生、可审计的会话事实源, 满足:

- PLAT-2: transcript 持久化、恢复/继续/派生、会话间隔离。
- BR-6: 设备面板/回放从 transcript 重建, 不重新查硬件。
- NFR-3/NFR-5: 可复现; 证据链在压缩中受保护(压缩投影由 #3 实现, 本维度只保证日志不可变)。

维度 6 是 **#3 上下文压缩** 与 **#5 MCP 会话级生命周期** 的基础: 压缩只改投影不改日志; MCP 连接随会话启动/回收。

## 2. 目标 / 非目标 / 反目标

### 目标

1. **header 生命周期**: `open`/`closed`, `close()` 原子更新; 记录 `provider`/`model`/`workdir` 元数据(可选)。
2. **resume**: 从会话目录恢复 `SessionHandle`, 校验 header 与事件流, 续写 seq 连续; 任何损坏 fail-closed。
3. **fork**: 在 turn 边界派生新会话, 保留前缀事件与 `parent` 关系, 新 header 记录 `forkedFrom`; 原会话与新会话完全独立。
4. **checkpoint**: 每次模型请求前追加 `checkpoint` 事件(由 `query` 接入)。
5. **分代 rollover**: 单个 JSONL 超过阈值(可注入, 默认 50 MiB)时创建 `session.vN+1.jsonl`; 读取按代顺序合并。
6. **usage 汇总**: `usageTotals()` 从日志重放 `usage` 事件; `query` 用它初始化会话级成本, 使 `maxCostUsd` 跨 resume 生效。
7. **隔离**: 两个 handle(含 fork 后的两个会话)并发追加互不影响, 无全局可变状态。

### 非目标

- FTS5 全文搜索、zstd 压缩、会话树导航/分支摘要(P2/backlog)。
- 跨会话知识沉淀(BR-5 inbox, 人工审核通道)。
- MCP 连接隔离实现(#5; 本维度只保证会话目录与内存状态独立)。
- 事件形状的全量 Zod 校验: P0 只做结构关键字段与顺序校验; 领域 payload 由各写入方负责。

### 反目标

- 为了"修复"坏日志而跳过坏行、重写历史(违反 fail-closed 与 R3)。
- resume 时重复写 header/事件, 或把旧事件复制进新代。
- fork 后两个会话共享可变数组/文件句柄。
- close 失败却标记 `closed`。

## 3. 约束

- TypeScript + Node 24 ESM-only, strict, 相对导入 `.js`; 不新增依赖。
- 日志是唯一事实源: 任何 resume/fork 后的模型可见内容必须能从新目录的日志重建。
- append-only: 既有事件不可修改/删除; rollover 只切换文件, 不重写旧文件。
- fail-closed: 坏 header、坏 JSON 行、seq 不递增、未知事件类型 → 抛结构化 `SessionCorruptionError`, 不静默恢复。
- Windows 一等公民: 文件名/路径使用 `node:path`; header 原子写使用同目录临时文件 + rename。
- 提交 `feat(session): ...`; 每任务 TDD; 两轮独立审查(实现 + 整合/红队)。

## 4. 接口与行为

### 4.1 存储布局

```
<sessionDir>/
├── header.json
├── session.v1.jsonl
├── session.v2.jsonl      # 仅在 rollover 后存在
├── ...
└── artifacts/
```

### 4.2 header 形状

```ts
interface SessionHeader {
  id: string;                 // ^[a-zA-Z0-9_-]{1,128}$, 且非 Windows 保留名
  createdAt: string;          // ISO
  status: "open" | "closed";
  provider?: string;
  model?: string;
  workdir?: string;
  forkedFrom?: { sessionId: string; seq: number };
}
```

- `createSession(dir, opts)` 的 `opts` 扩展: `provider?/model?/workdir?`, 以及 `generationThresholdBytes?: number`(默认 50 MiB, 测试注入)。
- `close()` 将 `status` 原子更新为 `closed`; 重复 close 幂等。
- `resumeSession(dir, opts?)` 读取 header; `status === "closed"` 也允许 resume(继续写, 状态改回 open? **裁定: resume 后状态设为 open**, 因为会话已重新活跃; 写入 header)。

### 4.3 事件读取

- `readSessionDir(dir): { header: SessionHeader; events: SessionEvent[] }`
  - 列 `session.v*.jsonl`, 按数字升序读取;
  - 对 `header.json` 与每个 `session.vN.jsonl` 先 `lstat`: 符号链接、目录或其他非普通文件 → `SessionCorruptionError`(header 用 `invalid_header`, 事件文件用 `invalid_event_line`), 不跟随链接读取;
  - 每行 JSON.parse; 空行跳过; `payload` 必须为对象, 否则 `invalid_event_line`;
  - 校验 seq 全局严格递增且从 0 开始(跨代连续);
  - 校验 event.type 属于 `EventType`; 否则 fail-closed;
  - header JSON 解析/字段校验失败 → `SessionCorruptionError("invalid_header")`;
  - 坏行 → `SessionCorruptionError("invalid_event_line")`, `detail` 含代文件与行号;
  - seq 不连续 → `SessionCorruptionError("invalid_seq")`。
- `SessionHandle.append` 写当前代文件前先 `lstat`: 符号链接或非普通文件 → `SessionCorruptionError("invalid_event_line")`, 不写外部文件。
- 保留现有 `readSessionFile(path)` 供单文件测试, 同样拒绝符号链接/非普通文件; 新增 `readSessionDir`。

### 4.4 resumeSession

```ts
resumeSession(sessionDir: string, opts?: { generationThresholdBytes?: number }): Promise<SessionHandle>
```

- `sessionDir === ""` 或路径存在但不是目录 → `SessionResumeError("invalid_target")`; 目录/header 缺失 → `missing_session_dir`。
- 读取 header + 全部事件;
- **崩溃尾部恢复**: 读取后先尝试 `buildMessages(events)`。若唯一的可恢复情形是「最后一个 assistant 批次的 toolCalls 缺少 tool_result」, 则为新 handle 按 toolCalls 原顺序补齐缺失的 `tool_result`(`payload.code = "tool_result_lost"`, `payload.text = "result lost due to crash"`, `parent = assistant.seq`, `detail.crashRecovery = true`), 再追加 `interrupted { reason: "crash_recovery" }`; 其他投影错误仍 fail-closed, 不改 header/历史事件。
- **恢复幂等与失败补偿**: 先读原 `header.status`; append 顺序为「缺失 tool_result(按 toolCalls 顺序) → interrupted → 原子写 header open」。任一步失败时把 header 原子恢复为原 status(原为 `closed` 时)并抛原错误, 已 append 的事件保留; 下一次 resume 若发现已有 `detail.crashRecovery=true` 的 `tool_result_lost` 但其后缺少 `interrupted{reason:"crash_recovery"}`, 只补 interrupted; 已有则不再重复追加。
- 重建 `eventList` 与 `nextSeq = lastSeq + 1`;
- 打开最后一个代文件用于追加(不截断); 若目录中无日志文件 → fail-closed;
- `close()` 行为与 createSession 相同;
- 不重新追加 `system`/`user`; 不修改历史事件;
- `usageTotals()` 从事件重放。

### 4.4.1 runSession 接入 resume

- `RunOptions` 增加 `resume?: boolean`(默认 false)。
- `resume: true` 时必须提供 `sessionDir`; 调用 `resumeSession(sessionDir)` 而不是 `createSession`。
- resume 时:
  - `opts.model` 必须与 `header.model`(若存在)一致, 否则抛 `SessionResumeError("model_mismatch")`;
  - 显式传入的 `opts.sessionId` 与 `header.id` 不一致 → 抛 `SessionResumeError("session_id_mismatch")`;
  - `opts.sessionDir === ""` 或路径不是目录 → 抛 `SessionResumeError("invalid_target")`;
  - `opts.systemPrompt` 若提供且与已有 system 事件内容不同 → 抛 `SessionResumeError("system_prompt_mismatch")`; 相同/缺省沿用旧值;
  - 不重复写 system/user。
- create 路径把 `provider`/`model`/`workdir` 写入 header。
- fork 本轮只提供库 API, 不接入 CLI/runSession(后续 UI/CLI 接入)。

### 4.5 forkSession

```ts
forkSession(
  sourceDir: string,
  atSeq: number,
  opts?: { targetDir?: string; id?: string; generationThresholdBytes?: number },
): Promise<SessionHandle>
```

- `atSeq` 必须使 `events[0..atSeq]` **可被 `buildMessages` 投影**(批次闭合), 不再按事件类型判断: 批中 `usage`、部分 `tool_result`、未闭合的 assistant 批次、越界/负数/非整数一律 → `SessionForkError("not_turn_boundary")`; 无工具轮的 `usage` 前缀与普通 user 前缀可通过。
- 前缀 = `events[0..atSeq]`(含 atSeq), **保留原 seq 与 parent**, 不重编号; fork 成功后 `events()` 必须可再次投影。
- 新目录缺省 `$HARNESS_HOME/sessions/<newId>`; `opts.id` 提供时校验 id 规则, 缺省随机生成; `opts.id` 不得等于源会话 id。
- `targetDir` 不得位于源会话目录内(含等于源目录), 否则 `SessionForkError("invalid_target")`; 源存在时对 source/target 及 target 的已存在祖先做 `realpath` 后判定, 阻断经符号链接/junction 的等价路径。源目录本身为符号链接 → `invalid_target`。
- header: 新 `id`、`createdAt`、`status:"open"`、`forkedFrom:{sessionId, seq:atSeq}`; 复制 `provider/model/workdir`(若存在); `forkedFrom.sessionId` 复用 `isValidSessionId` 校验。
- **artifact 自包含**: 前缀中 `tool_result.payload.artifactPath` 指向的文件若存在, 复制到新会话 `artifacts/` 并重写事件中的路径; 文件缺失时保留原路径, 并在该事件 `payload.detail.artifactMissing = true` 标记, 不阻塞 fork。词法边界检查后对源根与 artifact 再做 `realpath` 比较, 符号链接越界按缺失处理(TOCTOU/短名缺口见 D-040/D-047)。
- 事件写入 `session.v1.jsonl`(逐行 append 前缀); 之后 append 从 `atSeq+1` 开始。
- 原会话不受影响; 两个 handle 可并发追加。
- **目标目录占位**: 先对父目录 `mkdir`(recursive) 创建缺失层级; 再对 `targetDir` 使用**非递归 `mkdir`** 做原子占位。
- `targetDir` 已存在(含空目录)一律 → `SessionForkError("target_not_empty")`, 不写入、不覆盖; `targetDir` 为文件或父路径为文件(`EEXIST`/`ENOTDIR`) → `SessionForkError("invalid_target")`。

### 4.6 rollover

- 默认阈值 `generationThresholdBytes = 50 MiB`; `createSession`/`resumeSession`/`forkSession` 统一接线, 非法值(非有限、非整数、<= 0) → `TypeError`。
- `SessionHandle` 维护当前代文件与当前字节数; 每次 append 前计算 `lineBytes`; 仅当 `currentBytes > 0 && lineBytes <= threshold && currentBytes + lineBytes > threshold` → 打开下一代 `session.v(N+1).jsonl`(`wx`), 从该文件继续; 旧文件不改。
- 当前代为空时不切换(避免刚建 `v1` 空文件就产生 `v2`); 单条事件本身超过阈值时仍写入当前代(不切换、不拆分一行)。
- `resumeSession` 用最后一个代文件 `stat().size` 校准 `currentBytes`; `forkSession` 只写新的 `session.v1.jsonl`(不复制源的多代), 并以该文件实际大小校准。
- 跨代读取按数字顺序; seq 继续递增。

### 4.7 checkpoint 接入

- `LoopCtx` 增加可选 `checkpoint?: () => Promise<void>`? **裁定**: 直接由 `query` 调用 `session.append({type:"checkpoint", payload:{turn}})` 在每次 `complete` 前; 不在 `LoopCtx` 加字段。
- `EventType` 增加 `"compaction"`(为 #3 预留; 本维度不写该事件)。
- 测试: query 第 1/2 轮各有一条 checkpoint, 顺序在 assistant 之前、user 之后。

### 4.8 usage 汇总与成本

- `SessionHandle.usageTotals(): {promptTokens; completionTokens; cachedTokens}` 从 `usage` 事件累加; 忽略缺失字段。
- `query` 初始化 `costUsd = computeCostUsd(usageTotals, price)`(price 缺省 0); 这样 resume 后 `maxCostUsd` 包含历史成本。
- 注意: `maxTurns` 仍是单次 query 轮次预算, 不跨 resume 累计(写入设计)。

### 4.9 隔离与并发

- `createSession`/`resumeSession`/`forkSession` 返回的 handle 各自持有独立事件数组、队列、文件路径; 测试用两个 handle 并发 append 到不同目录, 断言互不影响。
- 同一目录重复 `createSession` 仍拒绝(现有 `wx` 逻辑保留); resume 允许同一目录只有一个活跃 handle 的约定, P0 不做跨进程锁(登记 deferred)。

## 5. 测试策略

全部单测, 不触网; 临时目录 `mkdtemp` + `afterEach` 清理。

- header: create open → close closed(原子写); 重复 close 幂等; resume closed 目录后状态 open。
- resume: 正常恢复续写; seq 连续; 坏 header/坏行/seq 跳号/未知类型 → `SessionCorruptionError` 对应 code; 空目录 → 错; runSession `resume:true` 缺 sessionDir → 错; model 不一致 → `SessionResumeError`; systemPrompt 不一致 → 错。
- fork: `atSeq` 使前缀可被 `buildMessages` 投影时成功(含 tool_result/usage/user/无工具轮 assistant 前缀); 前缀不可投影(批中 usage、部分 result、未闭合批次)、越界/负数/非整数 → `SessionForkError`; 前缀事件与 parent 保留; 新 header.forkedFrom; 原会话追加不受影响; targetDir 非空 → 错; 被引用 artifact 复制并重写路径, 缺失/越界时 `artifactMissing`。
- rollover: 阈值 1KB, 写入多事件产生 v1/v2; 读取合并顺序与 seq 正确; 旧文件内容不变。
- checkpoint: query 两轮各有 checkpoint, 位置正确。
- usageTotals: 多 usage 累加; 缺字段按 0; resume 后 query 的 cost 包含历史(用 maxCostUsd 触发验证)。
- 隔离: 两个 fork 会话并发追加, 各自日志独立。
- 覆盖率: 新增代码 line ≥ 90%。

## 6. 验收口径

1. `npm test` 全绿; `npm run coverage` lines ≥ 85%; lint/typecheck/build 通过。
2. resume/fork 的会话可被 `buildMessages` 投影, 且 fork 前缀与源会话逐事件一致(seq/parent); 崩溃尾部恢复后(`tool_result_lost` + `interrupted`)同样可投影。
3. 坏日志 fail-closed, 不静默跳过。
4. 无新增运行时依赖; 不修改既有事件语义(仅新增 checkpoint/compaction 类型与 header 字段)。
5. 两轮独立审查通过; `dev-notes` 增量留痕。

## 7. 留给实现的自由

- `SessionCorruptionError`/`SessionForkError` 的类名与 code 字面量(需稳定, 测试钉死)。
- rollover 的字节计数实现(内存计数 vs `stat`); 倾向内存计数 + 首次 `stat` 校准。
- header 原子写的临时文件命名。
- fork 的 `targetDir` 缺省是否使用 `HARNESS_HOME`(倾向是, 但接口允许注入以避免测试依赖全局)。
- 同一目录跨进程锁(P0 不做, 登记 deferred)。