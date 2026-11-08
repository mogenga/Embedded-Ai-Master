# 夜批管线契约（BR-7 离线部分）

> **本文是夹具格式、幂等规则、两层超时、exit code 表与判分规则的唯一契约源。**
> 实现是 [`scripts/nightly-batch.mjs`](../../scripts/nightly-batch.mjs)；
> 改实现要同步改本文，改本文要同步改实现与 `tests/nightly-batch.test.ts`。

## 这是什么

一个**离线**批处理：读一个夹具目录，对每条用例跑一次 `runSession`，按固定表给退出码，
把结果写到不会被重复覆盖的地方。

本轮**不接 Renode、不接真实模型**：夹具的 `script` 字段描述期望的工具调用序列，
`fetchImpl` 由 mock 按该序列合成。所以整条管线在没有硬件、没有网络的机器上能跑完，
CI 里也能跑。真机与仿真后端的接线不在本文范围内。

与 [`scripts/diagnosis-e2e.mjs`](../../scripts/diagnosis-e2e.mjs) 的区别：那个是硬编码
单场景、硬依赖 Renode 的端到端验证，只有一个场景；这是按夹具目录跑的批处理，
回答的是「这一批用例各自过没过」。

## 用法

```bash
node scripts/nightly-batch.mjs --batch tests/fixtures/nightly/smoke --round 1 --dry-run
node scripts/nightly-batch.mjs --batch tests/fixtures/nightly/smoke --round 1
```

| 参数 | 说明 |
|---|---|
| `--batch <dir>` | 批次目录，必填（含 `batch.json` / `cases/` / `answers/`） |
| `--round <n>` | 轮次，正整数，缺省 `1` |
| `--force` | 覆盖本轮已有产物（旧文件改名为 `<round>.json.bak`） |
| `--dry-run` | 只做预检并打印将要跑什么，不调用模型、不写产物 |
| `--timeout-ms <n>` | 批次总墙钟，正整数，缺省 `1800000`（30 分钟） |

未知参数直接报错（exit `2`），不静默忽略：拼错的 `--dryrun` 若被当成没有，整批就会
真跑一遍。

## 夹具格式

一个批次是一个目录，**问题与答案分开放**（BR-7 验收③「防泄题」）：

```
tests/fixtures/nightly/<batch>/
  batch.json                 # { name, description, cases: ["case-a", ...] }
  cases/<id>.json            # 给 agent 看的：symptom、预算
  answers/<id>.json          # 评分用：期望根因、必须出现的证据、禁止出现的断言
  runs/<id>/<round>.json     # 运行产物 —— 唯一被 gitignore 的子目录
  runs/<round>.summary.json  # 整批汇总
```

`runs/` 是产物目录。`.gitignore` 里只有一条 `tests/fixtures/nightly/**/runs/`；
**不要**把整个 `tests/fixtures/` 忽略掉——`mcp-echo-server.mjs` 是进版本库的测试夹具。

> 夹具放在 `tests/fixtures/nightly/` 而不是顶层 `fixtures/`：仓库里现有夹具都在
> `tests/fixtures/` 下，没有顶层 `fixtures/` 目录；新增一个顶层目录会让「夹具在哪」
> 出现两种答案。

### `batch.json`

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 批次名，非空。写进汇总 |
| `description` | string，可选 | 给人看的一段说明 |
| `cases` | string[] | 用例 id 列表，顺序即运行顺序。重复列出是夹具错误 |

### `cases/<id>.json`（给人之外的 agent 看）

**zod 校验，形状错就是夹具错误（exit `3`），不是运行错误。**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | **必须与文件名一致** |
| `symptom` | string | 交给模型的用户消息，非空白 |
| `maxTurns` | 正整数 | 必填，**不设默认**——隐式上限会静默截断长诊断（D-183 的教训） |
| `deadlineMs` | 正整数 | 必填，单例整跑上限；BR-7 基准是 25 分钟 = `1500000` |
| `script` | 数组，至少 1 步 | mock 模型按顺序返回的东西，见下 |
| `expectToolFailure` | 布尔，可选 | 允许工具失败（默认不允许：任何 `ok: false` 的 `tool_result` 都判失败） |

`script[i]` 二选一（`strictObject`，多余的键算夹具错误）：

- `{ "tool": string, "args": object }` —— 让 mock 模型返回一次这个工具调用；
- `{ "done": string }` —— 返回这段最终文本并收工。

`script` 用完后 mock **继续返回最后一步**：以 `done` 结尾就一直重复那段文本
（`maxTurns` 会先熔断，有用例判失败），以工具调用结尾就一直重复那个工具。

### `answers/<id>.json`（评分用，不给 agent 看）

| 字段 | 类型 | 说明 |
|---|---|---|
| `rootCause` | string | 期望根因关键词，**子串匹配、大小写不敏感** |
| `requiredTools` | string[] | 必须被调用过的工具名（`tool_result.toolName` 序列，顺序不敏感）。可以为空数组 |
| `forbiddenClaims` | string[] | 出现即判失败的说法（也是子串、大小写不敏感）。可以为空数组 |

三个字段都必填：漏写 `forbiddenClaims` 若被当成「没有禁止说法」，一条本该判失败的
用例会静默通过，而夹具看起来是完整的。

## 幂等

- 每轮的产物写到 `runs/<id>/<round>.json`，`<round>` 由 `--round <n>` 指定，缺省 `1`。
- **同一 `(batch, case, round)` 已存在就拒绝跑**，退出码 `5`，错误信息写明已有文件的
  完整路径与该用哪个 `--round`。不覆盖、也不静默跳过——静默跳过会让「这一轮没跑」
  看起来像「这一轮通过」。
- 冲突在**开跑前一次性查完**：跑到第 3 条才发现冲突时，前两条的产物已经写出去了，
  这一轮又没跑完，`runs/` 里会留下半新半旧的状态。
- `--force` 才允许覆盖，且覆盖前把旧文件改名成 `<round>.json.bak`（保留证据）。
  只保留最近一次前值：再冲突时旧的 `.bak` 会被覆盖。
- 产物的 `caseDir` 是**每次新建的临时目录**（`mkdtemp`），跑完即删，**不复用**：
  复用会让上一次的会话日志渗进这一次的评分为。

## 两层超时

这是两个不同的东西，**都必须可观测**：

1. **单例层**：夹具的 `deadlineMs` 原样传给 `runSession`。到点由内核自己收尾，
   报 `finishReason: "deadline"`（见 [`src/loop/query.ts`](../../src/loop/query.ts) 的
   `LoopCtx.deadlineMs`）。**`deadlineMs` 到点只是不再发起新调用，不强制终止正在执行
   的工具**——不要把它宣传成硬杀。
2. **批次层**：脚本自己的总墙钟 `--timeout-ms`，缺省 30 分钟。到点后：
   - **不再启动新用例**；
   - 已启动的那条被 `AbortController` 打断（否则一条卡住的用例会让整跑超时形同虚设）；
   - 收尾时写明「因批次墙钟到点，N 条未跑」，并把这些 id 列进汇总的 `notRun`。
     **不得**把未跑说成通过：未跑的用例不写产物。

**夹具预检**（BR-7「有界预检（防 hang）」）：启动任何模型调用**之前**先校验全部夹具。
任何一条形状不合法 → 整批不跑，退出码 `3`，**列出全部坏夹具**（不是第一条）。
理由：跑到第 7 条才发现第 3 条夹具写错时，前 6 条的产物就得作废，而 `runs/` 里那些
文件看起来和真跑出来的一样。

预检在加载构建产物**之前**完成：夹具写错时给的应该是 `3`（夹具错误），不是 `2`（环境错误）。

## exit code 表

| 码 | 含义 | 判据 |
|---:|---|---|
| `0` | 整批通过 | 每条用例都跑完且判分通过 |
| `1` | 有用例未通过 | 至少一条判分失败（工具缺失 / 根因不含关键词 / 出现 forbiddenClaims / 模型侧 `finishReason` 不是 `no_tool_calls`） |
| `2` | 环境或内部错误 | 构建产物缺失（`dist/index.js` 不存在）、参数错误、脚本自身抛异常 |
| `3` | 夹具错误 | 预检失败（形状不合法、id 与文件名不一致、缺字段、`batch.json` 坏、`--batch` 指向的目录不存在） |
| `4` | 批次墙钟到点 | 还有用例没跑 |
| `5` | 幂等冲突 | 目标 round 已存在且未给 `--force` |
| `124` | 单例超时且**无**判分结论 | 该用例 `finishReason` 是 `deadline` 且没有产出任何 assistant 文本 |

**优先级**（同时成立时取最高的）：`2` > `3` > `5` > `4` > `124` > `1` > `0`。
`3` 在 `2` 之前不成立——预检先于构建产物加载，缺 `dist/` 时夹具若同时写错，报 `3`。

`124` 沿用 GNU `timeout` 的约定。**`0/1/2` 与既有 `resolveExitCode`
（[`src/demo/run.ts`](../../src/demo/run.ts)）的语义不冲突也不合并**：那个函数是单次
demo 的（`2` = 任何异常、`130` = 用户取消），合并会把 demo 的「2 = 任何异常」带进来，
与本表的「2 = 环境错误、3 = 夹具错误」直接矛盾。本脚本有自己的表。

`--dry-run` 成功时返回 `0`；预检失败时返回 `3`（不是 `0`）。

## 判分

对每条用例：

1. 从会话日志读出 `tool_result` 的 `toolName` 序列，断言 `requiredTools` 全部出现过
   （顺序不敏感）。
2. 从**最后的** assistant 文本断言 `rootCause` 关键词出现、`forbiddenClaims` 一个都没出现
   （都是子串、大小写不敏感）。
3. `finishReason` 必须是 `no_tool_calls`。`max_turns` / `deadline` / `aborted` /
   `truncated` / `context_overflow` 都不是「跑完了」。
4. 除非夹具显式 `expectToolFailure: true`，任何 `ok: false` 的 `tool_result` 都判失败
   （R3：工具失败不能静默算过）。

**失败必须给出可判的原因**：产物里的 `reasons` 逐条写「缺哪个工具 / 缺哪个关键词 /
出现了哪句禁止说法 / finishReason 是什么」，不是只给一个 `false`。
`passed` 由 `reasons` 是否为空推导，不单独传——两处各写一次 `passed` 会出现
「passed: true 且带原因」这种自相矛盾的文件。

`runs/<id>/<round>.json` 的字段：

| 字段 | 说明 |
|---|---|
| `id` / `round` / `startedAt` / `finishedAt` | 身份与时间 |
| `passed` | 是否通过（`reasons.length === 0`） |
| `reasons` | 未通过的原因，逐条可判；通过时是空数组 |
| `finishReason` | 内核报的收尾原因；读不到时是 `null` |
| `modelCalls` | 本次用例的模型调用次数（mock 计数） |
| `toolSequence` | `tool_result.toolName` 序列，按日志顺序 |
| `finalText` | 最后的 assistant 文本 |
| `runError` | `runSession` 抛错时的错误消息（仅在那时出现） |

`runs/<round>.summary.json`：`{ batch, round, startedAt, finishedAt, total, passed,
failed: [id...], notRun: [id...], exitCode }`。

## 运行环境（每条用例）

| 项 | 值 | 理由 |
|---|---|---|
| `cwd` | 每次新建的临时目录 | 工具只能读到这个空目录；不碰工作区 |
| `home` / `sessionDir` | 同一个临时目录 | 不读仓库里的 `permissions.json` / `mcp.json` |
| `permissions.preset` | `read-only` | 写类工具一律拒绝；夜批不该改机器 |
| `mcp` | `{}`（不开 MCP） | 本轮不接领域层 |

临时目录在每条用例跑完后整个删掉，产物里只留评分需要的事实。

## 已知边界

- **只有 mock 模型**：`script` 是「模型会做什么」的剧本，不是真实模型的表现。它验证的是
  **管线**（夹具 → 会话 → 判分 → 退出码 → 产物），**不是诊断质量**。`smoke` 批次里的
  病例是管线夹具，不是 BR-7 说的 10 例仿真 + 3 例真机基准。
- **没有触网路径**：`fetchImpl` 永远由脚本注入；`providersText` 里的 `baseUrl` 是
  `http://127.0.0.1:9/v1`，就算注入漏了也落在本地。
- **不进覆盖率闸门**：`scripts/` 不在 `vitest.config.ts` 的 `coverage.include` 里。
- 真机与 Renode 后端的接线（BR-7 的另一半）尚未做；夹具格式本身不排除它——
  将来的后端要替换的是「工具从哪来」，不是夹具格式与判分规则。
