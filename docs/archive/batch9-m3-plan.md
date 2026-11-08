# 批次 9 · M3 里程碑剩余 —— 实施计划（2026-11-08）

> 来源：`docs/BACKLOG.md` 批次 9。用户选定：
> - **9.1 只做离线可验的部分**（夹具格式 + 幂等 + 整跑超时 + exit code 表），真实 Renode 跑 10 条仿真用例留给批次 10；
> - **9.2 回放控件 + 9.3 面板决策**；
> - **9.4 的子代理与 hooks 延后（不是取消）**；**工具 trace 用户明确不做**（2026-11-08）。

## 事实依据（2026-11-08 实测）

| 事实 | 证据 |
|---|---|
| 本机**没有 Renode**：`C:\Program Files\Renode\bin\Renode.exe` 不存在，PATH 里也没有 | 目录检查 + `which Renode` |
| 本地模型网关 **在监听**：`127.0.0.1:8788` 可连，`providers.json` 里 `wb` 有两个模型 | TCP 探测 + 读配置（未打印 key） |
| `scripts/diagnosis-e2e.mjs` 是**单场景**脚本，382 行，硬依赖 Renode，`process.exitCode` 只用了 1 和 2 | 阅读 + grep |
| 内核**已有**整跑墙钟 `deadlineMs`（`src/loop/query.ts:50`、`finishReason: "deadline"`） | 读源码 |
| 内核**已有** `resolveExitCode`（`src/demo/run.ts:116`）：0 / 1 / 2 / 130 四档 | 读源码 + `tests/demo.test.ts:255` |
| 内核**已有** `forkSession atSeq`（宿主 `host.js:3904` 透传，`admin.fork(id, atSeq)`） | 读源码 + `tests/desktop/fork-atseq.test.js` |
| `sessionEventsToMessages`（`protocol.js:323`）已能从事件数组重建转录，但**没有**「截到第 N 条」的入口 | 读源码 |
| 设备面板已删（D-193），`SUPPORTED_PANES = {file, artifact, serial}` | `app.js:4276` |
| `device_status` 事件仍由内核产出，渲染器 `case "device_status"` 刻意不画 | `app.js:3290`、`query.ts:441` |
| 会话日志里**已有**工具调用的 `tool_use`（id/name/input）与 `tool_result`（ok/code/toolName/ts），**没有**每次调用的耗时字段 | 真实会话日志 + `src/session/types.ts:213` |

---

## 约束（每个任务的 brief 都原样带着）

- **禁止任何依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。需要装东西就停下来报告。
- **禁止在宿主机真实执行危险命令做测试**；危险命令用例只能靠纯函数断言或注入 mock 制造 RED。
- **子代理不得执行任何 git 写操作**（`add` / `commit` / `reset` / `checkout` / `stash` / `switch` / `branch` / `worktree` / `merge`）。只读的 `git status` / `git diff` / `git log` 可以。
- **写文件只用 Write/Edit 工具**，不要用 `node -e` / `bash -c` 拼含反引号或 `$()` 的文本。
- 不得调大 `vitest.config.ts` 的超时，不得删改既有断言。
- **不得真实调用外部模型网关**：夜批的端到端用例必须用注入的 `fetchImpl`（`tests/demo.test.ts` 与 `scripts/diagnosis-e2e.mjs` 都有现成写法）。
- **危险命令禁令同样适用于夜批**：夹具里的「命令」字段只用于断言解析，任何测试都不得把夹具内容真的交给 `shell` 执行。

---

### Task 1 · BR-7 夜批管线（9.1 的离线部分）

**问题**：仓库里只有 `scripts/diagnosis-e2e.mjs`——一个硬编码单场景、硬依赖 Renode 的脚本。BR-7 要的是**一批**用例、可判失败、可重复跑不重复产出。缺四样：夹具格式、幂等、整跑超时、exit code 表。

**目标**：新增 `scripts/nightly-batch.mjs`，它读一个夹具目录、对每条用例跑一次 `runSession`、按一张固定表给出退出码、并把结果写到不会被重复覆盖的地方。**本轮不接 Renode**：夹具的 `tools` 段落描述期望的工具调用序列，`fetchImpl` 由 mock 提供，所以整条管线可以在没有硬件、没有网络的机器上跑完。

**改动面**：新建 `scripts/nightly-batch.mjs`、`docs/operations/nightly-batch.md`（夹具格式与 exit code 表的**唯一契约源**）、`tests/nightly-batch.test.ts`、`tests/fixtures/nightly/<batch>/…` 示例夹具，以及 `.gitignore` 里加一条 **只** 忽略产物目录的行（见下）。**不得改 `src/`**。

> **夹具放 `tests/fixtures/nightly/` 而不是顶层的 `fixtures/`**：仓库里现有夹具都在 `tests/fixtures/`（`mcp-echo-server.mjs`），没有顶层 `fixtures/` 目录；新增一个顶层目录会让「夹具在哪」出现两种答案。

**1. 夹具格式（写进 `docs/operations/nightly-batch.md`，作为契约）**

一个批次是一个目录，**问题与答案分开放**（BR-7 验收③「防泄题」）：

```
tests/fixtures/nightly/<batch>/
  batch.json                 # { name, description, cases: ["case-a", ...] }
  cases/<id>.json            # 给 agent 看的：symptom、预算
  answers/<id>.json          # 评分用：期望根因、必须出现的证据、禁止出现的断言
  runs/<id>/<round>.json     # 运行产物 —— 唯一被 gitignore 的子目录
```

`.gitignore` 只加一条 `tests/fixtures/nightly/**/runs/`。**不要**把整个 `tests/fixtures/` 忽略掉——`mcp-echo-server.mjs` 是进版本库的测试夹具。

`cases/<id>.json` 的字段（**zod 校验，形状错就是夹具错误，不是运行错误**）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 必须与文件名一致 |
| `symptom` | string | 交给模型的用户消息，非空 |
| `maxTurns` | 正整数 | 必填，不设默认——隐式上限会静默截断长诊断（D-183 的教训） |
| `deadlineMs` | 正整数 | 必填，单轮整跑上限；BR-7 基准是 25 分钟 = `1_500_000` |
| `script` | 数组 | mock 模型按顺序返回的工具调用，见下 |
| `expectToolFailure` | 布尔，可选 | 允许某轮工具失败（默认不允许） |

`script[i]` 是 `{ tool: string, args: object }` 或 `{ done: string }`。

`answers/<id>.json`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `rootCause` | string | 期望根因关键词（**子串匹配**，大小写不敏感） |
| `requiredTools` | string[] | 最终文本之外必须被调用过的工具名 |
| `forbiddenClaims` | string[] | 出现即判失败的说法（例如「一定是硬件坏了」） |

**2. 幂等（BR-7 关键规则）**

- 每轮的产物写到 `runs/<id>/<round>.json`，`<round>` 由 `--round <n>` 指定，缺省 `1`。
- **同一 `(batch, case, round)` 已存在就拒绝跑**，退出码 `5`，错误信息写明已有文件的路径与你该用哪个 `--round`。不覆盖、不静默跳过——静默跳过会让「这一轮没跑」看起来像「这一轮通过」。
- `--force` 才允许覆盖，且覆盖前把旧文件改名成 `<round>.json.bak`（保留证据）。
- 产物的 `caseDir` 是临时目录（每次跑新的），**不复用**：复用会让上一次的会话日志渗进这一次的判分。

**3. 整跑超时（两层）**

- **单例层**：把夹具的 `deadlineMs` 传给 `runSession`，用例级超时由内核自己收尾（`finishReason: "deadline"`）。
- **批次层**：脚本自己带一个总墙钟 `--timeout-ms`（缺省 `30 * 60_000`）；到点后不再启动新用例，已启动的那条被 `AbortController` 打断。收尾时必须写明「因批次墙钟到点，N 条未跑」——**不得**把未跑说成通过。
- 夹具**预检**（BR-7「有界预检（防 hang）」）：启动任何模型调用**之前**先校验全部夹具。任何一条形状不合法 → 整批不跑，退出码 `3`，列出全部坏夹具（不是第一条）。理由：跑到第 7 条才发现第 3 条夹具写错，前 6 条的产物就得作废。

**4. exit code 表（写进契约文档，作为唯一出处）**

| 码 | 含义 | 判据 |
|---:|---|---|
| `0` | 整批通过 | 每条用例都跑完且判分通过 |
| `1` | 有用例未通过 | 至少一条判分失败（工具缺失 / 根因不含关键词 / 出现 forbiddenClaims / 模型侧 `finishReason` 不是 `no_tool_calls`） |
| `2` | 环境或内部错误 | 构建产物缺失、`dist/` 不存在、脚本自身抛异常 |
| `3` | 夹具错误 | 预检失败（形状不合法、id 与文件名不一致、缺字段） |
| `4` | 批次墙钟到点 | 还有用例没跑 |
| `5` | 幂等冲突 | 目标 round 已存在且未给 `--force` |
| `124` | 单例超时且**无**判分结论 | 该用例 `finishReason` 是 `deadline` 且没有产出任何 assistant 文本 |

`124` 沿用 GNU `timeout` 的约定；`0/1/2` 与既有 `resolveExitCode` 的语义**不冲突**（那个函数是单次 demo 的，本脚本有自己的表，两者不合并——合并会把 demo 的「2 = 任何异常」带进来，与本表的「2 = 环境错误、3 = 夹具错误」矛盾）。

**5. 判分**

- 从会话日志读出 `tool_result` 的 `toolName` 序列，断言 `requiredTools` 全部出现过（顺序不敏感）。
- 从最后的 assistant 文本断言 `rootCause` 关键词出现、`forbiddenClaims` 一个都没出现。
- **失败必须给出可判的原因**：每条未通过写明「缺哪个工具 / 缺哪个关键词 / 出现了哪句禁止说法」，不是只给一个 `false`。

**测试**（`tests/nightly-batch.test.ts`，全部离线，注入 `fetchImpl`）

| 用例 | 断言 |
|---|---|
| 一条通过的用例 | 退出码 `0`，产物文件里有 `passed: true` 与工具序列 |
| 缺工具 | 退出码 `1`，原因文本点名缺的工具 |
| 出现 forbiddenClaims | 退出码 `1`，原因文本引用那句话 |
| 夹具缺 `deadlineMs` | 退出码 `3`，**没有发起任何模型调用**（用 mock 计数断言） |
| 同一 round 跑两次 | 第二次退出码 `5`，第一次的产物字节未变 |
| `--force` | 退出码 `0`，旧产物改名成 `.bak` 仍在 |
| 批次墙钟很小（例如 1 ms）+ 3 条用例 | 退出码 `4`，产物写明未跑几条 |
| `finishReason: max_turns` | 退出码 `1`（不是通过） |

**验收**

```bash
npx vitest run tests/nightly-batch.test.ts
node scripts/nightly-batch.mjs --batch fixtures/nightly/smoke --round 1 --dry-run
npm run check:js
```

`--dry-run` 只做预检 + 打印将要跑什么，不调用模型、不写产物。

---

### Task 2 · 会话回放控件（9.2 / BR-6 验收②的延伸）

**问题**：`sessionEventsToMessages(events)` 能重建整条转录，但**没有**「只回到第 N 条事件」的入口。BR-6 要的是「按事件下标截断并回放」——现在只能整份打开。

**改动面**：`desktop/renderer/protocol.js`（`sessionLoadedEvent` 加截断）、`desktop/host/host.js`（`loadSession` 接受 `atSeq`）、`desktop/renderer/app.js` + `index.html` + `styles.css`（回放控件）、测试。**不得改 `src/`**。

**实现要求**

1. **截断只有一个入口**。`sessionLoadedEvent(events, options)` 增加 `atSeq?: number`：给了就只投影 `seq <= atSeq` 的事件，并且 `atSeq` 必须落在 `0..lastSeq` 内——越界**抛错**（宿主捕获后回一条 warn notice），不静默钳位。理由与 `forkSession` 相同：一个被静默钳位的下标会让「回放到第 3 条」看起来像「回放到最后一条」。
2. `host.js` 的 `loadSession(payload)` 透传 `payload.atSeq`；校验规则与 `forkSession` **共用同一段代码**（非负整数、上界交给内核/日志判定），不要写第二份。
3. **界面**：会话打开后，转录区顶部出现一条**回放条**，位置在现有顶栏下方、不遮挡内容。组成：
   - 一个 `<input type="range">`，`min=0`、`max=lastSeq`、步长 1；
   - 一个只读文本「第 N / M 条事件」；
   - 一个「回到最新」按钮，只在 `N < M` 时出现。
   拖动时**不重新读日志**（宿主已经持有这份事件数组），只重算投影并重绘。松手才发一次命令（`pointerup` / `change`），拖动过程中不发——每像素发一条命令会把 IPC 打满。
4. **回放态必须可见且可退出**：处于回放（`N < M`）时，输入框禁用并显示原因；点「回到最新」或按 Esc 退出回放、恢复输入。**不得**让用户在回放态里发消息而消息落到最新位置——那是两个时间点在打架。
5. 回放条只在**已打开的会话**上出现；新会话没有。
6. `device_status` / `todos` 这类界面状态也要跟着截断到同一下标（`sessionLoadedEvent` 已经分别投影，确保它们走同一个 `atSeq`）。

**测试**（`tests/desktop/replay-scrubber.test.js`，真实宿主 + 静态断言，混合）

| 用例 | 断言 |
|---|---|
| `sessionLoadedEvent` 带 `atSeq` | 只含 `seq <= atSeq` 对应的消息 |
| `atSeq = 0` | 只有第一条事件的内容 |
| `atSeq` 越界（负数 / 大于 lastSeq） | 抛错，错误信息含合法范围 |
| `atSeq` 落在工具调用中间（`tool_use` 有、`tool_result` 没有） | 不抛错，那条 tool 行不出现（不能画出半个调用） |
| 宿主 `loadSession` 带非法 `atSeq` | 回一条 warn notice，不换会话 |
| 回放控件 | 静态断言：`range` 的 `min/max/step`、`pointerup` 才发命令、回放态禁用输入框、Esc 退出 |

**验收**

```bash
npx vitest run tests/desktop/replay-scrubber.test.js tests/desktop/host.test.js tests/desktop/protocol.test.js
npm run check:js
```

---

### Task 3 · 设备面板形态决策（9.3）——**只写决策记录，不写代码**

**为什么是决策而不是实现**：BR-6 验收①写的是「设备面板实时反映工具结果」，但那个面板已在 2026-10-26 按用户决定整体删除（D-193），`SUPPORTED_PANES` 现为 `file` / `artifact` / `serial`。本任务只产出一份决策记录，**不改任何代码**。

**产出**：新建 `docs/specs/device-state-surface.md`，回答四个问题，每个都要有代码事实支撑：

1. **现在设备状态从哪来、到哪去**：`device_status` 由 `query.ts` 写在什么时候、payload 什么形状、渲染器为什么刻意不画（引用 `app.js:3290` 的注释）。给出真实会话里有没有这类事件的证据。
2. **BR-6 验收①还成立吗**：面板删了，这条验收要么改写要么落空。**必须明确选一个并写明理由**，不能两头都不认。候选：(a) 承认验收①已随面板删除作废，BR-6 收敛为「回放」一条；(b) 把「实时反映工具结果」改由**工具行**承载（MCP 工具的 `tool_result` 已经在转录里可见，`detail.deviceStatus` 也在）。
3. **不复活 `getBoardState`**：写下这条**具体**约束（D-193 的教训是「画一个需要扫描器才能填的面板」），以及将来若真要面板，前置条件是什么。
4. **与 `device_status` 事件的去留关系**：事件留着但没人画，是「预留」还是「死代码」，要说清并给触发升级条件。

**验收**：文档写完后，`npm run check:docs` 通过；`grep getBoardState` 仍为 0 处（不能因为写文档就把死命令写回来）。

---

## 不做的部分（写进台账，不写代码）

| 项 | 状态 | 理由 |
|---|---|---|
| 9.4 的子代理 | **延后**（用户明确：不是取消） | 框架清单 #17 的来源是 Claude Code Task，**不是** dsh（Phase 0 映射表里标 dsh 的是「事件总线」那半，即 #13/#15）。目前没有业务锚点，且成本是三项里最高的。等 BR-7 管线跑起来、确实出现「并行调研 / 批量夹具验证」的需求再做 |
| 9.4 的 hooks（工具调用前后拦截） | **延后**（用户明确：不是取消） | #13 的拦截半来自 Claude Code。权限层（`src/permissions/`）已经覆盖了「调用前 allow/ask/deny」，hooks 的增量价值在「调用后改写结果」与「外部可编程」——这两条目前没有需求 |
| 9.4 的工具 trace | **不做**（用户 2026-11-08 明确：「工具 trace不要」） | 前一轮我把它解释清楚之后用户仍然决定不做。已有的 `tool_use` / `tool_result` 事件足以支撑转录与夜批判分，缺的只有「按调用聚合的耗时视图」，而 PLAT-8 的锚点（夜批排障）已经有 exit code 与产物文件可用。**从批次 9 摘除，不留在排期里**。若将来夜批排障真的出现「不知道哪一步慢」的实测，按 D-xxx 重新登记 |
| 9.1 的 Renode 实跑 | 移到批次 10 | 本机没有 Renode。管线做成可注入后端的形状，真实跑通留给有环境的机器 |

---

## 顺序与并发

- **Task 1 ∥ Task 2**：一个在 `scripts/` + `fixtures/` + `tests/`，一个在 `desktop/`，文件不重叠。
- **Task 3 由控制器写**（纯文档，且需要读完上面两项的实际形状再定论）。
- 子代理只写工作区、不做任何 git 写操作。
