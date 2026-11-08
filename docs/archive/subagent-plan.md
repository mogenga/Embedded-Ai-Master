# 批次 9 · 9.4 子代理（只读 + 后台并发）—— 实施计划（2026-11-08）

> 来源：`docs/BACKLOG.md` 批次 9 的 9.4。用户 2026-11-08 选定：
> **「只读 + 后台并发」** —— 同进程跑嵌套 `query()`，工具面由权限层钉死在
> `read-only`；子代理在后台跑，`subagent` 立即返回 id，完成后由宿主写一条
> `subagent_result` 事件，父轮次用 `subagent_check` 取结果。
> 不做：可写子代理、审批递归、子代理专用面板。

## 事实依据（已核对代码，不是推测）

| 事实 | 证据 |
|---|---|
| `createBuiltinTools()` **不接参数**，返回 13 个纯对象工具 | `src/tools/builtin.ts:28` |
| `ToolCtx` 只有 `sessionId / cwd / artifactDir`，**没有** model / registry / session | `src/tools/types.ts:4` |
| `query(ctx: LoopCtx, input, cfg)` 是唯一的循环入口，`LoopCtx` 需要 session / model / modelCfg / tools / budget / permissionGate / signal / artifactDir | `src/loop/query.ts:30,68,335` |
| `runSession` 会重新读 providers、重连 MCP、新建 registry —— 子代理**不能**走它 | `src/index.ts:426,490,667` |
| `compactSession({session})` 按参数取目标会话，同一份 compactor 可用于子会话 | `src/index.ts:646` |
| `evaluatePolicy` 的 `read-only` 预设 = `{read: allow, write: deny, unknown: deny}` | `src/permissions/policy.ts:13` |
| `toolAccess()` 优先用 `tool.access(input)`，否则用注解推导 | `src/permissions/policy.ts:75` |
| `terminal_bg` 的既有姿态：起作业后立即返回 id，`takeBackgroundCompletions` 由宿主取走写成事件 | `src/tools/background.ts:242`、`desktop/host/host.js:1470` |
| 新事件类型 = **五处**同步（`EventType` / `EVENT_TYPES` / `build.ts` switch / `protocol.js` `KNOWN_TYPES` / `MATRIX.md`） | `AGENTS.md`「新增会话事件类型 = 四处同步」+ `desktop/MATRIX.md` |
| `usage` 事件的 `promptTokens/completionTokens` 由 `session.usageTotals()` 汇总；父会话的 `costUsd` 只读**父日志** | `src/session/handle.ts:247`、`src/loop/query.ts:393,522,584` |
| 设置页「按来源分组」的 `subagent` 标签**没有生产者**（`summary.sources` 从未下发） | `desktop/renderer/settings.js:1425`、`host.js:4189` |
| 进程树终止已有不阻塞实现 | `src/tools/process-tree.ts:35` |

## 约束（每个任务的 brief 都原样带着）

- **禁止任何依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。需要装东西就停下来报告。
- **禁止在宿主机真实执行危险命令做测试**；危险命令用例只能靠纯函数断言或注入 mock 制造 RED。真实命令只允许无害、跨平台、限定在临时目录内的（如 `node -e "console.log(...)"`）。
- **子代理不得执行任何 git 写操作**（`add` / `commit` / `reset` / `checkout` / `stash` / `switch` / `branch` / `worktree` / `merge`）。只读的 `git status` / `git diff` / `git log` 可以。
- **写文件只用 Write/Edit 工具**，不要用 `node -e` / `bash -c` 拼含反引号、`$()`、`${}` 的文本。
- 不得调大 `vitest.config.ts` 的超时，不得删改既有断言（可以新增）。
- **不得真实调用外部模型网关 / 触网**：所有用例用注入的 `fetchImpl`（写法见 `tests/integration.test.ts` 的 `mockFetch`）。
- 不得修改 `docs/BACKLOG.md`、`AGENTS.md`、`dev-notes/` —— 那三处由控制器在合并后统一写。

---

### Task 1 · 内核子代理运行时（`src/subagent/`）

**目标**：新增 `subagent` / `subagent_check` 两个工具，子代理在同一进程里跑嵌套
`query()`，工具面由权限层钉死为只读，运行在后台，父轮次不阻塞。

**新增模块**（全部新文件，不要动 `src/tools/builtin.ts`）。

> **工具装配的位置是刻意的**：`createBuiltinTools()` **不接参数**，`tests/tools.test.ts`
> 钉着它返回 13 个纯对象工具。子代理工具需要 `model` / `registry` / `permissionGate`，
> 所以它们**不进 `createBuiltinTools()`**，改在 `src/index.ts` 里与内置工具并列组装：
>
> ```ts
> const builtinTools = createBuiltinTools();
> const subagentTools = createSubagentTools(deps);      // 见下
> const registry = new ToolRegistry([...builtinTools, ...subagentTools]);
> // ...
> registry.replace([...builtinTools, ...subagentTools, ...mcpTools]);
> ```
>
> 两条 `ToolRegistry` 构造路径都要加，`rebuildMcpTools` 里的 `replace` 漏掉一处，
> 一次 MCP 工具刷新就会让 `subagent` 从模型视野里消失。内置工具数的既有断言
> （13）因此**保持不变**——这不是「改了数字」，是子代理工具本来就不属于内置工具集。
>
> **`deps.registry` 必须是取值函数而不是注册表本身**：`src/index.ts` 里 registry
> 先于 MCP 工具建好，而 `createSubagentTools` 要在**那之后**才拿到一份指向最终表的
> 引用。传 `() => registry` 让子代理在启动那一刻看到当时的完整工具面（含 MCP 工具）。
> 子代理的权限层会把非只读的挡掉，所以「MCP 工具也在表里」不是漏洞，反而是必要的
> ——`kb_lookup` / `datasheet_search` 这类只读领域工具正是子代理最有用的东西。

- `src/subagent/types.ts`
  ```ts
  export type SubagentStatus = "running" | "finished" | "failed" | "killed" | "timed_out";
  export interface SubagentSummary {
    id: string;
    sessionDir: string;
    status: SubagentStatus;
    startedAt: string;
    finishedAt?: string;
    turns: number;
    toolCalls: number;
    promptTokens: number;
    completionTokens: number;
    costUsd?: number;
    text: string;          // 子会话最后一条 assistant 正文（截断后）
    error?: string;        // failed 时的原因；status 不是 failed 时不出现
    truncated?: boolean;   // text 被截断
    killedBy?: "kill" | "timeout" | "abort";
  }
  ```
- `src/subagent/runner.ts` —— 作业表 + 启动 + 查询 + 终止 + 完成队列。
- `src/subagent/tools.ts` —— `createSubagentTools(deps)` 返回两个 `ToolDef`。

**`src/subagent/runner.ts` 的接口**（名字固定，Task 2 与宿主依赖它们）：

```ts
export interface SubagentDeps {
  model: ModelProtocol;
  modelCfg: ModelCfg;
  registry: () => ToolRegistry;          // 惰性：runSession 里 registry 后建
  budget: (messages: ModelChatMessage[]) => { over: boolean; tokens: number; softLimit: number };
  compactor?: (session: SessionHandle) => Promise<void>;
  permissionGate: PermissionGate;        // 父门的副本，只取 preset 与 deny 规则
  cwd: string;
  artifactRoot: string;                  // 父会话的 artifacts 目录（子代理只读不到它，见下）
  timeoutMs?: number;                    // 子代理单次工具调用的预算，沿用父的
  systemSections?: SystemSections;
  pricePerMillion?: PricePerMillion;
  onSpend: (usd: number) => void;        // 计入父会话的成本上限
}

export function startSubagent(parentSessionId: string, parentDir: string, prompt: string, opts: {
  label?: string;
  maxTurns?: number;
  timeoutMs?: number;
  deps: SubagentDeps;
}): Promise<{ id: string } | { error: string; code: string }>;

export function getSubagent(parentSessionId: string, id: string): SubagentSummary | undefined;
export function listSubagents(parentSessionId: string): SubagentSummary[];
export function killSubagent(parentSessionId: string, id: string): boolean;
export function takeSubagentCompletions(parentSessionId: string): SubagentSummary[];
export function killAllSubagents(): void;   // 宿主退出时用
```

**运行语义（逐条都要有断言）**：

1. **立即返回**：`startSubagent` 只做「建子会话 + 起一个不 await 的异步任务」，
   在 200 ms 内返回 id。子会话用 `createSession(path.join(parentDir, "subagents", id), {...})`
   —— 目录在父会话目录**下面**，所以 `sessions.list()` 不会把它列成独立会话。
2. **子会话是真会话**：有自己的 `header.json` / `session.v1.jsonl`，
   子代理跑完 `close()`。日志是唯一事实源，子代理的每一步都能事后回读。
3. **只读是权限层保证的，不是另一张白名单**：
   子代理的 gate 由 `createPermissionGate({ preset: "read-only", rules })` 构造，
   `rules` = 父规则里 `action === "deny"` 的那些（只收紧、不放行）。
   **不要**在子代理里手写「允许的工具名清单」——那会成为「只读」的第二份定义。
   工具描述里写明「你没有写权限，写操作会被权限层拒绝」。
4. **子代理由 `query()` 驱动**，`unsafeSkipPermission` 不出现（必须给 `permissionGate`）。
   `maxTurns` 缺省 **30**（子代理是被分派的子任务，不是操作者自己的长诊断；
   这是与本项目「主循环无默认轮数上限」的**有意偏离**，注释里写明理由）。
   `deadlineMs` 缺省 **10 分钟**（与 `terminal_bg` 的 `DEFAULT_TIMEOUT_MS` 同值）。
5. **终止**：`killSubagent` 触发子 `AbortController`；`query` 收到 abort 会自己收尾。
   超时由 runner 自己的定时器触发同一个 abort，`killedBy: "timeout"`。
   进程级 `killAllSubagents()` 供宿主退出时调用（`query` 是异步的，这里只能 abort，
   不要伪造「已结束」）。
6. **完成队列**：终局（`finished` / `failed` / `killed` / `timed_out`）各推一条进
   按父会话分组的队列，`takeSubagentCompletions` 取出即清空——与
   `takeBackgroundCompletions` 同一语义，同一个终局不会写两遍。
7. **成本计入父会话**：子代理结束时用子会话的 `usageTotals()` +
   `computeCostUsd(..., pricePerMillion)` 算出花费，调 `deps.onSpend(usd)`。
   父会话的 `LoopCtx` 新增可选 `externalCostUsd?: () => number`，`query.ts` 在
   三处重算成本的地方把它的值加进去（`src/loop/query.ts:393`、`:522`、`:584`），
   于是 `maxCostUsd` 熔断看得见子代理的开销。**没有价格就不加 0**：`pricePerMillion`
   缺省时 `onSpend` 不调用、`costUsd` 字段不出现（与 `usage` 事件的既有约定一致）。
8. **并发上限 4**：第 5 个 `startSubagent` 返回
   `{ error: "too many running subagents (max 4)", code: "subagent_limit" }`，
   工具层转成 `failure("subagent_limit", ...)`。上限是常量，不做成配置项。
9. **子代理读不到父会话的 artifacts**：`artifactDir` 用子会话自己的
   `path.join(childDir, "artifacts")`；父会话产物对子代理不可见。这是有意的
   ——`artifact` 工具的边界就是「当前会话的产物」。

**子代理的 system 提示词**（`createSession(..., { systemPrompt })`，写进子会话日志）：
```
你是一个只读子代理，由主线程分派来调查一件事。你只能使用读取类工具，写操作会被权限层拒绝。
把结论写成一段话：先说结论，再列支撑它的具体证据（文件路径、行号、命令输出）。
不要复述你的调查过程。调查完毕就结束，不要提出下一步计划等待批准。
```

措辞是**产品决定**：子代理不知道自己只读时会浪费回合去试写工具。定稿后写进
`docs/operations/` 的说明里（Task 2 做）。

**`src/subagent/tools.ts`**：

- `subagent`：`{ prompt: string, label?: string, maxTurns?: number, timeoutMs?: number }`。
  `access: () => "write"`（它要花模型的钱、起一个会写日志的会话，不是只读），
  `annotations: { readOnly: false }`——**不要**声明 `destructive`（它不破坏任何东西，
  声明了会让它在 `diagnose` 预设下变成无条件审批）。返回 `detail: { id, sessionDir, status: "running" }`，
  `text` 说明「已启动，用 subagent_check 取结果」。
- `subagent_check`：`{ id?: string, kill?: boolean }`，与 `terminal_bg_check` 同形同姿态：
  `access: (input) => input.kill === true ? "write" : "read"`；不给 id 时列本会话
  全部子代理；`kill` 必须带 id（否则 `invalid_input`）；跨父会话的 id 一律按
  「不存在」处理（`subagent_unknown`），理由与 `background.ts:559` 相同。

**事件与投影（五处同步，缺一处就是警告行或整份日志读不出来）**：

- `src/session/types.ts` 的 `EventType` 增 `"subagent_result"`；payload 类型
  `SubagentResultPayload` 就是 `SubagentSummary`（`text` 已截断，另带
  `textBytes` / `capturedBytes` 表示是否截断，与 `background_result` 同一诚实口径）。
- `src/session/persistence.ts` 的 `EVENT_TYPES` 增同名键。
- `src/context/build.ts` 的 switch 把 `subagent_result` 归到与 `background_result`
  同一个「跳过」分支（**不要**并进 user/assistant 那类，工具批次未闭合时会撞守卫）。
- `desktop/renderer/protocol.js` 的 `KNOWN_TYPES` 增同名项（渲染在 Task 2）。

**验收**（`tests/subagent.test.ts`，全部离线、注入 `fetchImpl`）：

| 用例 | 断言 |
|---|---|
| 立即返回 | 模型请求被挂住（一个手动 resolve 的 Promise）时 `startSubagent` 仍 < 200 ms 返回 id |
| 只读由权限层保证 | 子代理的模型请求让子代理调 `write` → 结果是 `permission_denied`，且目标文件**不存在** |
| 子会话是真会话 | 父目录下 `subagents/<id>/header.json` 与 `session.v1.jsonl` 存在，`readSessionDir` 能读 |
| 只读工具可用 | 子代理调 `read` 读一个临时文件 → `ok`，正文含文件内容 |
| 完成与取结果 | 子代理结束 → `getSubagent` 为 `finished`，`text` 非空；`takeSubagentCompletions` 恰好一条，第二次取为空 |
| 成本计入父会话 | 父会话设极小 `maxCostUsd`，子代理花掉后父的一轮在发请求前熔断为 `max_cost_usd` |
| 并发上限 | 同时起 4 个（模型挂住）后第 5 个返回 `subagent_limit` |
| 终止 | `killSubagent` → 状态 `killed`，`killedBy: "kill"` |
| 跨会话不可见 | 用另一个 parentSessionId 查同一个 id → `undefined` |
| 子代理读不到父产物 | 父会话 artifacts 里放一个文件，子代理 `artifact` 读它 → 明确错误码 |

**另外**：`tests/event-types.test.ts` 的既有断言要跟着扩（它枚举了事件类型的地方），
但**不要**删掉任何既有断言。

---

### Task 2 · 宿主抽取与渲染（`desktop/`）

**目标**：子代理结束时宿主把终局写成 `subagent_result` 事件，渲染器画一行提示；
能力矩阵与操作手册同步。

1. `desktop/host/host.js`：仿 `pumpBackgroundResults`（`host.js:1470`）新增
   `pumpSubagentResults`，在同一处 tick 里调用。写入失败要如实发 notice，
   会话被占用时说明「结果未能写入日志」（R3）——直接抄 `pumpBackgroundResults`
   的三条失败路径，不要另发明措辞。
2. `desktop/renderer/protocol.js`：`case "subagent_result"` 画**一行** `notice`
   （例如 `子代理「<label>」完成：<首行摘要>`；`failed` / `killed` / `timed_out`
   用 warn 级并说明原因）。**不要**画子代理面板——渲染器没有子代理视图，
   画一个没有内容的卡片就是又一个死 UI。
3. `desktop/MATRIX.md`：事件表补 `subagent_result` 一行，命令表补
   `subagent` / `subagent_check` 两个工具（工具不在命令表里，写到「工具」相关
   的段落或事件表下方的说明里，按文件既有结构找位置）。
4. `docs/operations/subagent.md`（新建）：契约唯一源——工具参数与返回字段、
   只读边界的**理由**（为什么是权限层而不是白名单）、子会话目录布局、
   完成事件的字段与截断口径、成本如何计入父会话、已知边界
   （父轮次结束不杀子代理；子代理读不到父产物；没有子代理专用 UI）。
   写完 `npm run check:docs` 必须通过。

**验收**：

```bash
npx vitest run tests/desktop/subagent-result.test.js tests/desktop/protocol.test.js
npm run check:js
npm run check:docs
```

`tests/desktop/subagent-result.test.js` 用 `protocol.js` 的纯函数断言（这个仓库
没有 jsdom，渲染层一律静态或纯函数断言，写法见 `tests/desktop/replay-scrubber.test.js`）：

| 用例 | 断言 |
|---|---|
| 事件能画 | `sessionEventToHostEvents` 对 `subagent_result` 给出一条 `notice`，不含「未识别的事件类型」 |
| 成功/失败语气 | `finished` 是普通 notice，`failed` / `killed` / `timed_out` 是 `warn` 且正文含原因 |
| 未知事件守卫 | 把类型改成 `subagent_resultt` 时仍产出 warn notice（证明这条分支不是兜底吞掉） |
| 宿主抽取 | `pumpSubagentResults` 存在且调用 `takeSubagentCompletions`，失败路径发 notice（静态断言，与 `tests/desktop/host.test.js` 的既有写法一致） |

---

## 顺序与并发

- **Task 1 → Task 2 串行**：Task 2 依赖 Task 1 定下的字段名与完成队列语义。
- 同一分支内由同一个子代理连续做两个任务，每个任务单独提交。
- 子代理**只写工作区**，不做任何 git 写操作；提交由控制器做。

## 明确不做

| 项 | 理由 |
|---|---|
| 可写子代理 | 用户选的是只读。写操作要接审批递归（子代理的审批弹到谁的框？），是另一个设计 |
| 子代理专用 UI / 面板 | 渲染器连子代理列表都没有；一行完成提示已经能让人知道「它跑完了、结论是什么」 |
| 子代理能读父会话 artifacts | `artifact` 工具的边界就是当前会话产物；放宽它等于让 `artifactDir` 不再是一个边界 |
| 子代理之间互相通信 | 没有需求；队列与 `subagent_check` 已经够取结论 |
| `summary.sources` 的生产者 | 设置页那块 UI 目前没有生产者（`host.js:4189` 从来没下发 `sources`），补它要连带做用量页，超出本任务 |
