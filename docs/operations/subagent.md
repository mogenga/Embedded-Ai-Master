# 只读子代理（`subagent` / `subagent_check`）

> **本文是子代理工具面、事件契约与边界的唯一契约源。**
> 实现：内核 [`src/subagent/`](../../src/subagent/)（`runner.ts` / `tools.ts` / `types.ts`）、
> 宿主 `pumpCompletions`（[`desktop/host/host.js`](../../desktop/host/host.js)）、
> 协议层 `case "subagent_result"`（[`desktop/renderer/protocol.js`](../../desktop/renderer/protocol.js)）。
> 改实现要同步改本文；改本文要同步改 `desktop/MATRIX.md` 的对应两行。

## 这是什么，不是什么

模型可以把一件**只读**调查差事派给另一个自己：同进程里跑一次嵌套 `query()`，
拿到一个新会话、自己的产物目录、自己的轮数与时限。主线程不等它——`subagent`
立即返回 id，子代理在后台跑，结束时结果自动回来（一条 `subagent_result` 事件），
也可以用 `subagent_check` 按 id 取结论。

**不是** Claude Code 的 Task 那种可写子代理，也不是一个前端页面：

| 不做 | 理由 |
|---|---|
| 可写子代理 | 写操作要接审批递归（子代理的审批弹到谁的框？），是另一个设计 |
| 子代理专用 UI / 面板 | 渲染器连子代理列表都没有；一行完成提示已经能说明「跑完了、结论是什么」 |
| 子代理读父会话产物 | `artifact` 工具的边界就是当前会话产物；放宽它等于让 `artifactDir` 不再是一个边界 |
| 子代理之间互相通信 | 没有需求；完成队列与 `subagent_check` 已经够取结论 |
| 子代理的用量进入设置页「按来源分组」 | 那块 UI 依赖 `summary.sources`，它至今没有生产者；补它要连带做用量页，超出本功能 |

## 工具

### `subagent`

```jsonc
{
  "prompt":  "查一下 UART1 为什么没有输出",   // 必填，非空
  "label":   "UART 排查",                    // 可选，显示名；只用于完成提示与列表
  "maxTurns": 30,                            // 可选；不给 = 不限
  "timeoutMs": 600000                        // 可选；不给 = 不限（毫秒）
}
```

**两个上限都缺省不限**（2026-11-09 用户决定）。曾经有 30 轮 / 10 分钟的默认值，
理由是「子代理是没人盯着的差事」；那条理由被推翻了——静默截断一个跑偏的子代理，
比让它跑久一点更糟，因为交给父会话的结论会是半截的，而「为什么停了」只写在一条
`failed` 的 error 里。这与主循环「不填 `maxTurns` 就不检查轮数」是同一条语义。

终止仍有两条路，且都不受这两个值影响：`subagent_check { kill: true }`
与宿主退出时的 `killAllSubagents()`。

成功返回（`detail`）：

```jsonc
{ "id": "sa_0123456789ab", "sessionDir": "<父会话目录>/subagents/sa_0123456789ab", "status": "running" }
```

正文另外报告**真正生效**的两个值；没设时写 `no limit`，不会印出 0 或某个默认数字
（回显一个用户没写过的边界就是说谎）。填 0 或超范围的值按「没设」处理。

失败码：

| 码 | 含义 |
|---|---|
| `subagent_limit` | 本会话已有 4 个在跑（`MAX_RUNNING_SUBAGENTS`） |
| `subagent_aborted` | 调用时父轮次已被中止 |
| `subagent_unavailable` | 拿不到会话目录（没有 `ToolCtx.artifactDir`）——**不会**退而把子会话建到 cwd |
| `subagent_start_failed` | 启动阶段抛错，正文带原因 |

权限：`access: () => "write"`，注解 `readOnly: false`，**刻意不声明 `destructive`**。
它花钱、会起一个写日志的会话，所以不是只读；它不删除也不覆盖任何东西，声明
`destructive` 会让它在 `diagnose` 预设下变成无条件审批，而那个预设里「问一次再跑」
正是最常做的动作。

### `subagent_check`

```jsonc
{ "id": "sa_0123456789ab",  // 可选；不给就列出本会话全部子代理
  "kill": true }            // 可选；请求终止该子代理
```

`detail` 单条是扁平对象（`id` / `sessionDir` / `status` / `label` / `startedAt` /
`finishedAt` / `turns` / `toolCalls` / `promptTokens` / `completionTokens` /
`costUsd` / `textBytes` / `capturedBytes` / `truncated` / `killedBy` /
`killRequested`），列表是 `{ subagents: [...] }`。

`kill: true` 时正文只说「已请求终止」——`query()` 还要收尾（补 `tool_result`、写
`interrupted`），此刻宣布「已结束」就是伪造。终局由 `subagent_result` 给出。

权限按本次输入决定：`access: (input) => input.kill === true ? "write" : "read"`。
纯查询不该被 `read-only` / `diagnose` 拦下，`kill` 该算写操作。

失败码：`invalid_input`（`kill` 没有 `id`）、`subagent_unknown`（不存在**或**属于
别的父会话——同一句回答，一个 id 不该成为跨会话读取的旁路）、`subagent_aborted`。

## 只读边界：为什么是权限层，不是白名单

子代理拿到的是一张**新的 `read-only` 权限门**，规则上只继承父会话这一轮实际加载的
`deny` 规则：

```ts
// src/subagent/runner.ts  childPermissionGate()
createPermissionGate({ preset: "read-only", rules: denyRules });
```

这意味着：

- **允不允许写，由 `DEFAULT_ACTIONS["read-only"]` 决定**（`read: allow` /
  `write: deny` / `unknown: deny`），不在这里另写一张「允许调用的工具名」清单。
  第二张清单会成为「只读」的第二份定义，与预设各自演化，迟早给出两个结论。
- **继承只能收紧、不能放宽**：父的 `deny` 在子代理里照样生效；父的 `allow` 不会
  让一个写工具变成可写，因为预设已经把 `write` 判成 deny。
- 因此**新增任何工具都不需要改子代理**：它自动按自己的 `access()` 被拦或放行。

规则由调用方从 `LoadedPermissionConfig.rules` 直接传进 `SubagentDeps.inheritableRules`，
不经 `PermissionGate`：那个接口只有 `check()`，为了子代理去给一个公共类型加字段，
改动面比受益大。

## 会话目录布局

子代理是一个**真会话**（`createSession` 建的），不是内存里的临时循环：

```
<sessionsRoot>/<父会话 id>/
  header.json
  session.v1.jsonl
  artifacts/                        ← 父会话的产物根，子代理读不到
  subagents/
    sa_0123456789ab/                ← 一个子代理 = 一个会话目录
      header.json                   ← id 就是作业 id，状态最终为 closed
      session.v1.jsonl              ← 首条是 system（只读子代理提示词）
      artifacts/                    ← 它自己的产物根
```

- `sessionDir` 在 `subagent` 的返回值里给出，`subagent_check` 也会回报。
- 子代理的结论正文来自子会话最后一条 `assistant` 事件（不是另存一份）。
- **完成先于入队**：子会话 `close()` 之后终局才进完成队列，所以宿主拿到
  `subagent_result` 时锁已释放，可以立刻 `readSessionDir`。反过来的话，一条刚宣布
  「已完成」的会话会打不开。

## 完成事件 `subagent_result`

新事件类型按 `AGENTS.md` 的规则同步在**五处**：`EventType`（`src/session/types.ts`）、
`EVENT_TYPES`（`src/session/persistence.ts`）、投影 `switch`（`src/context/build.ts`，
与 `background_result` 同一个「跳过」分支）、`KNOWN_TYPES` 与 `case`（`desktop/renderer/protocol.js`）、
`desktop/MATRIX.md` 的事件表。少一处就是「整份日志读不出来」或「整屏未识别事件」。

**payload 就是 `SubagentSummary` 本身**——宿主原样 `handle.append({ type: "subagent_result", payload: summary })`，
不重组字段。字段表见 [`src/subagent/types.ts`](../../src/subagent/types.ts)：

| 字段 | 含义 |
|---|---|
| `status` | `running` / `finished` / `failed` / `killed` / `timed_out`；事件里只会出现后四种 |
| `text` / `textBytes` / `capturedBytes` / `truncated` | 见下「截断口径」 |
| `error` | **只在 `failed` 时出现**；`killed` / `timed_out` 的原因是 `killedBy` |
| `killedBy` | `kill` / `timeout` / `abort` |
| `label` | 调用方给过才出现——不拿 id 冒充名字 |
| `promptPreview` | prompt 单行化后截断到 120 字符（避免整段 prompt 在父日志里出现两遍） |
| `turns` / `toolCalls` / `promptTokens` / `completionTokens` / `costUsd` | 子会话自己的统计；**没有价格信息时 `costUsd` 不出现**（零美元 ≠ 免费） |

### 截断口径

子会话的结论最多保留 **8 KiB**（`MAX_SUMMARY_TEXT_BYTES`），按 UTF-8 字节切且不切
断字符边界。

- `textBytes` 是**原文**的字节数，`capturedBytes` 是**实际留下**的字节数；
  两者不等即 `truncated: true`。
- 只报留下多少会把截断说成完整（R3）。`subagent_check` 的正文另外再截到 4096 字符
  并明确写出 `[result, head of captured text]`。

### 渲染器画什么

**一行 `notice`，没有面板**（渲染器没有子代理视图，画一张没有内容的卡片就是又一个
死 UI）：

| `status` | 级别 | 正文 |
|---|---|---|
| `finished` | `dim` | `子代理「<label>」完成：<首行摘要>`（首行超过 120 字符截断；没有正文时说「没有留下结论正文」） |
| `failed` | `warn` | `子代理「<label>」失败：<error>`；`error` 缺失时说「未记录原因」 |
| `killed` | `warn` | `子代理「<label>」已终止：<收到终止请求 / 宿主中止 / 未记录原因>` |
| `timed_out` | `warn` | `子代理「<label>」超时被终止：跑满了自身时限` |

`dim` 是「普通的新闻」而不是 `warn`：渲染器的 `addNotice` 只画 `warn` / `error` /
`dim` 三档，任何别的值会被静默丢弃——后台作业干净退出用的也是 `dim`。

### 宿主怎么写它

`pumpCompletions`（`desktop/host/host.js`）**一个函数排空两条队列**——子代理与后台
作业共用它、共用一个 1s 定时器、共用一份 handle：

```
if (running) return                       ← 回合进行中，什么都别做
takeBackgroundCompletions(sessionId)      ← 拿到 handle 之后才取
takeSubagentCompletions(sessionId)
  → kernel.resumeSession(<会话目录>)      ← 短暂取锁
  → handle.append({ type: "background_result" | "subagent_result", payload })
  → handle.close()                        ← 释放锁
```

**为什么必须在回合进行中直接返回**（这条是踩出来的，不是设计洁癖）：

同进程的会话锁是**引用计数可重入**的（`src/session/lock.ts`）——同一进程对同一目录
再取一次锁会成功，而不是回 `session_locked`。于是「锁被占用就跳过」对回合进行中的
宿主从来不成立：泵会拿到**第二份 handle**，带着自己的一份事件数组，两个写入者各自
用 `eventList.length` 算 seq。实测：

```
run  -> seq 1
pump -> seq 1
→ readSessionDir: SessionCorruptionError: invalid_seq
```

日志从此**永久读不回来**。泵的 `close()` 还会把 `header.status` 写成 `"closed"`，
而那一轮根本没结束——`startFollow` 据此提前收尾，转录会在回答中间停住。

**为什么两条队列必须合成一个函数**：它们原本是两个函数挂在同一个 tick 上并排跑，
各自开一份 handle。同一份缺陷，只是低了一层：两边同时有完成项时照样相撞。

**为什么这不会丢结果**：完成事件没有截止时间。这一拍写不了就留在队列里，下一拍
（回合结束后）写。因为「太早」而丢掉一条已经承诺要留下的记录，才是真正的问题。

三条失败路径：

| 情形 | 表现 |
|---|---|
| 回合进行中 / 没有打开的会话 / 内核没有对应运行时（旧 `dist/`） | 安静跳过，**队列不动**——下一拍再来 |
| 拿不到 handle（锁在别的进程手里、目录读不了） | `dim` notice：「后台作业或子代理已结束，但会话被占用，结果未能写入日志：<原因>」，此时才消费队列 |
| `append` 抛错 | `warn` notice：「作业结果写入失败：<原因>」 |

**只有第一行不是失败**，而且它不丢数据。后两行发生时，`subagent_check` 仍能取到结果
（作业表在进程内存里），但父会话日志里没有那条记录——重开窗口就看不到了。这不是
可静默的行为，所以两种都明说。

> 这一段同时修掉了一个存在 18 天的缺陷：`kernel.resumeSession` 从来没有在宿主里定义过
> （2026-10-22 引入），所以后台泵的每次调用都抛 `TypeError`，被 `catch` 渲染成
> 「会话被占用」。**`background_result` 一条都没真正写进过日志**，措辞还让它看起来像
> 锁冲突。同一个 bug 也让上面那条 seq 相撞路径无法触发——修好它之后才暴露出来。

宿主退出（`shutdown` 命令 / stdin 关闭）时调 `kernel.subagent.killAllSubagents()`：
**只发 abort，不产出完成通知**，也不谎称「已全部结束」。

## 成本如何计入父会话

子代理的 `usage` 写在子会话日志里，父会话的 `usageTotals()` 看不到它。所以：

1. `runner.finalize()` 用 `pricePerMillion` 算 `costUsd`，加进**按父会话**累计的
   进程内账本（`spendByParent` / `subagentSpendUsd()`），再调 `deps.onSpend`。
2. `src/index.ts` 把 `subagentSpendUsd(session.id)` 接到 `LoopCtx.externalCostUsd`。
3. `query()` 在**三处重算**与**每轮开头**折入这笔外部开销，于是父会话的
   `maxCostUsd` 看得见子代理花掉的钱。

按父会话而不是按一次运行累计：父会话的 `costUsd` 语义是「整段会话的总预算」，
子代理的开销如果只活在一次 `runSession` 的局部变量里，下一条消息就又变成 0——
设了上限却只对「当轮起的子代理」有效。

**没有价格信息时不累加**（`costUsd` 不出现、`onSpend` 不调用）：零美元不等于免费。

## 已知边界

| 边界 | 含义 |
|---|---|
| **父轮次结束不杀子代理** | 它按自己的节奏跑下去——**缺省没有任何时限**——`abort` 只停当前轮，不停已派出去的差事。要停只能 `subagent_check { kill: true }` |
| **子代理读不到父产物** | 它有自己的 `<childDir>/artifacts`；`artifact` 工具的边界仍是「当前会话的产物」 |
| **跨父会话一律按「不存在」处理** | `getSubagent` / `listSubagents` / `takeSubagentCompletions` / `killSubagent` 都按父会话隔离；id 不是跨会话读取的旁路 |
| **没有子代理专用面板** | 输入框上方有一条运行条（几个在跑、跑了多久、点开只读回放）；结论另有一行完成提示。没有独立 pane |
| **作业表与完成队列在进程内存** | 宿主重启后它们一起消失。已经写进日志的 `subagent_result` 会留下来，跑着的不会再回来 |
| **最多 4 个并发**（`MAX_RUNNING_SUBAGENTS`） | 常量而不是配置项；上限检查与作业登记之间没有 `await`，否则同时到达的两个 start 都会看到「还差一个」 |
| **轮数与寿命都缺省不限** | 2026-11-09 用户决定。曾经的 30 轮 / 10 分钟默认值已删除：静默截断比跑久一点更糟（结论会是半截的）。显式给 `maxTurns` / `timeoutMs` 仍照用，那是调用方为自己的用例划的边界 |
| **只读是权限层保证的** | 见上；不是工具白名单，也不能通过父 `allow` 放宽 |
| **用量页「按来源分组」的 `subagent` 标签仍无生产者** | `summary.sources` 从未下发；本功能没有补它 |
| **完成提示只带首行摘要** | 完整结论在子会话日志里；这是刻意的，不是截断丢失 |

## 排障

| 现象 | 看哪里 |
|---|---|
| 模型说派了子代理，但没有任何提示 | 宿主是否在跑（泵在主循环里）；父会话日志里有没有 `subagent_result`；`subagent_check` 不带 id 列出本会话的作业 |
| 「结果未能写入日志」 | 同一会话被另一个宿主/回合占着锁；等那一轮结束后 `subagent_check` 仍能取到结论，但日志里不会有它 |
| 子代理 `failed` + `max_turns` | 只在**显式**设了 `maxTurns` 时会出现；给更大的值或去掉它（不限） |
| 子代理说被拒绝 | 权限层的 `read-only` 预设拒绝了写工具（这是设计），或继承了父会话的 `deny` 规则 |
| 旧 `dist/` 上工具不存在 | `src/subagent/` 未编译；`npm run build` |
