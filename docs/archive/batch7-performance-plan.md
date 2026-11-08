# 批次 7 · 性能与规模 —— 实施计划（2026-11-08）

> 来源：`docs/BACKLOG.md` 批次 7。用户选定范围：「有数据的三项」——7.1 / 7.3 / 7.4。
> 7.2 / 7.5 / 7.6 本轮不开工，理由与实测数字见文末「不做的那三项」。

## 事实依据（2026-11-08 实测，探针脚本不进仓库）

| 项 | 实测 |
|---|---|
| `titleOf` 读整份日志 | 30 行首屏 × 0.5 MiB 日志 = **66–95 ms**／每次列表推送；只读头 8 KiB = **13–15 ms** |
| 同一形状 5.13 MiB 真实日志 | 整份读 10.0 ms，读头 8 KiB **0.35 ms**（28×） |
| `sessions.list()` | 500 会话 **119–162 ms**，1000 会话 **226 ms**（每回合同步） |
| `grep` 全量收集 | 64 万命中 → **112 MiB 堆**（每命中约 170 B），只回 200 条 |
| `grep` 有界 top-N | 同样语料 **~0 堆增长**，结果逐条一致 |
| `grep` ReDoS | `(a+)+$` 对 30 字符输入 **>15 s**（被 kill）；`(a\|a)+$` 同 |
| `vm` + `timeout` 隔离 | 同一条正则 **213–258 ms 被中断**，同一 matcher 复用后正常 |
| `vm` 逐文件开销 | 100 µs／次；50 文件一批 → 2000 文件只慢 **+35%**（239 → 322 ms） |
| `glob` ReDoS | `**/a/`×12 组对 32 段路径 **>10 s**；×6 组 @64 段 **1.47 s**；现有上限（256 字符 / 64 段）**挡不住** |

**结论**：7.1 的代价在「读整份日志」不在 readdir；7.3 的代价在内存不在时间；7.4 的两个面（grep 任意正则、glob 编译出的正则）都真能冻住事件循环，且 `AbortSignal` 打不断它。

---

## 约束（每个任务都必须遵守，brief 原文带出）

- **禁止任何依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。需要装东西就停下来报告。
- **禁止在宿主机真实执行危险命令做测试**；危险命令用例只能靠纯函数断言或注入 mock 制造 RED。
- **子代理不得执行任何 git 写操作**（`add` / `commit` / `reset` / `checkout` / `stash` / `switch` / `branch` / `worktree`）。提交由控制器做。只读的 `git status` / `git diff` / `git log` 可以。
- **写文件只用 Write/Edit 工具**，不要用 `node -e` / `bash -c` 拼含反引号或 `$()` 的文本。
- 不得为了「让测试变绿」调大 `vitest.config.ts` 的超时，或删改既有断言。

---

### Task 1 · 会话标题的有界读取

**问题**：`desktop/host/host.js` 的 `sessions.titleOf(id)` 走 `sessions.detail(id)` → `kernel.readSessionDir(dir)`，把**全部世代的全部日志读进内存并逐行 JSON.parse**，只为拿第一条 `user` 事件的 `content`。`titleFor` 在每次列表推送时对最多 30 行调用它（`TITLE_SCAN_LIMIT`），而列表推送发生在每个回合结束、每次 flag 变更、每次命令回包。实测 30 行 × 0.5 MiB ≈ 70–95 ms 的同步阻塞，且随单会话日志线性增长。

**目标**：标题推导只读到「第一条合格 user 事件」为止，不再解析整份日志；输出行为（trim、80 字符截断加 `…`、找不到时回落 id）逐字符不变。

**改动面**：只允许 `desktop/host/host.js` 与新增测试文件。**不得改 `src/`**（改内核要重编 `dist/`，会让桌面测试的构建窗口判定复杂化，与本项无关）。

**实现要求**

1. 新增一个模块内函数（不需要导出给渲染器），按世代顺序（`session.v1.jsonl`、`v2`……）扫描每个日志文件，**增量读**：`openSync` + `readSync` 每次 64 KiB，解析完整行，命中第一条合格 `user` 事件立即返回，不再往下读。
2. 行切分必须处理跨块的行：块尾没有换行且未到 EOF 时，把残片留到下一块前面。`\r\n` 与 `\n` 都要认。
3. 合格判定与原实现一致：`event.type === "user"`、`event.payload.content` 是字符串、`trim()` 非空；返回 `trim()` 后截断到 80 字符并加 `…`（仅当超长）。JSON 解析失败的**当前行**跳过（继续找下一条），不得让整次推导失败——这与原来「整份日志读不出来就回落 id」不同，是**有意收紧为按行容错**，需在测试注释里写明这一行为变化。
4. 找不到时回落到 id（`titleOf` 现有契约），行为不变。
5. 每块读完检查是否已被外部关闭/文件消失：`readSync` 抛错就回落到 id，不要抛出到调用方（`titleOf` 现在的 `try/catch` 保留）。
6. 不要缓存「找不到」的结果（`titleFor` 现有注释说明：首条 user 事件可能在本回合稍后才落盘）。本任务**不碰** `titleCache`。

**测试**（新增 `tests/desktop/host-title-prefix.test.js`，用真实的 host 进程驱动，沿用 `host.test.js` 的 `tempHome` / `runHost` 风格）

| 用例 | 断言 |
|---|---|
| 首条 user 在日志开头 | 侧栏 `sessionList` 事件里该行 `title` 等于首条消息的 trim 结果（回归现有行为） |
| 首条 user 前有 40 条 `mcp_status` | 同上，且不因前置事件而漏读 |
| 超 80 字符 | `title` 以 `…` 结尾且长度 81 |
| 空白 `content` / 非字符串 `content` | 跳过它们，取第一条合格 user |
| `\r\n` 行尾 | 标题正确，且不带 `\r` |
| user 事件的行恰好跨 64 KiB 块边界 | 仍能找到（这是增量读最容易写错的地方） |
| 日志后段有一行坏 JSON | 仍能给出标题（**行为变化**：旧实现对整个日志 parse 失败会回落 id） |
| `v1` 没有 user、`v2` 有 | 按世代顺序继续读，给出 `v2` 的标题 |
| 完全没有 user 事件 | `title` 为 `""`（协议层把空标题渲染成「没有消息」，不是 id） |

**验收命令**

```bash
npx vitest run tests/desktop/host-title-prefix.test.js tests/desktop/host.test.js
npm run check:js
```

---

### Task 2 · `grep`：有界收集 + 可中断的正则求值

**问题 A（D-078，内存）**：`src/tools/grep.ts` 把所有命中压进 `matches`，遍历结束后 `sort` + `slice(0, limit)`。`maxResults` 只限返回条数，不限收集量；实测 64 万命中 = 112 MiB 堆。

**问题 B（D-085，事件循环）**：`regex.test(text)` 同步执行且不可中断。实测 `(a+)+$` 对 30 字符输入 >15 s，期间 `AbortSignal` 完全无效——管线超时只能让上层提前返回，正则仍在跑，整个宿主进程卡死。

**目标**

- 内存：收集量被 `maxResults` 上界约束（外加一个常数余量），不再随命中总数增长。
- 时间：正则求值有墙钟上界；超界时返回**显式错误**，不是静默空结果。
- 语义：输出（行内容、顺序、`[truncated]`、`detail.matched/returned/truncated`）与今天逐字节一致。

**改动面**：`src/tools/grep.ts` + 新增 `src/tools/interruptible-regex.ts` + 测试。**不得改 `src/tools/glob.ts`**（Task 3 负责）。

**实现要求 A —— 有界收集**

1. 维护一个容量为 `limit + 1` 的有序数组（`limit` = `input.maxResults ?? 200`）。候选按 `(file, line)` 升序插入；当数组已满且候选排在末尾之后时直接丢弃（O(1)）。
2. `detail.matched` 必须是**真实命中总数**——用一个独立计数器，不能取数组长度。
3. `truncated` = `matched > limit`，`returned` = 返回条数；两者语义与今天一致。
4. 排序必须与今天的 `sort((a,b) => a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line)` 同序（`tests/grep.test.ts` 有精确顺序断言）。
5. 数组容量取 `limit + 1` 而不是 `limit`，是为了不改动「命中数 > limit 才置 truncated」的边沿判断。

**实现要求 B —— 可中断求值**

1. 新增模块 `src/tools/interruptible-regex.ts`，导出工厂 `createInterruptibleMatcher(pattern, ignoreCase)`，返回 `{ testBatch(lines: string[]): { hits: number[] } | { timedOut: true } }` 或等价形状（命名可调整，但要**只暴露这一个职责**）。
2. 实现用 `node:vm`：一个长期存在的 context，一个预编译的 `vm.Script`，每次调用 `runInContext(ctx, { timeout })`。**必须在 spike 结论上落地**：实测 `timeout` 能中断灾难性回溯（213–258 ms），且中断后同一 matcher 可继续使用。
3. 批的粒度：最多 **50 个文件** 或 **4 MiB 文本**（先到为准）。理由：逐文件调用是 100 µs 固定开销（2000 文件 +550 ms，3×），成批后只慢 +35%；4 MiB 上限让超时预算是个常数而不是随仓库大小漂移。
4. 超时预算：**2000 ms／批**。实测正常正则处理 4 MiB 约 2–40 ms，余量 50–1000×；灾难性正则会在 2 s 内被打断，而不是 >15 s。
5. 超时时 `grep` 返回 `isError: true, code: "regex_timeout"`，文字里必须写明：命中的是哪个 pattern、在哪个文件附近被打断、以及「正则回溯过长」这一原因。**不得**把它伪装成 `(no matches)` 或 `aborted`。
6. `signal.throwIfAborted()` 仍然要在**每一批之前**检查；批内不再检查（批的墙钟上界已由 2 s 兜住）。
7. 正则的合法性校验保留在主线程（`compileRegex`）：非法 pattern 仍返回 `invalid_pattern`，不进入 vm。

**测试**

| 用例 | 断言 |
|---|---|
| 现有 `tests/grep.test.ts` 全绿 | 含 `matched: 201 / returned: 200 / truncated: true`、`matched: 1001` 两处精确断言 |
| 命中数远超 limit（合成 5000 行全命中） | `matched` 精确 = 命中总数，`returned` = limit，顺序与原生 sort 一致 |
| 灾难性正则 `(a+)+$` + 长 `a` 串 | 在 **< 10 s** 返回 `code: "regex_timeout"`（今天会 >15 s 卡死） |
| 同一文件里灾难性行之后的正常行 | 不返回部分结果（超时是整批作废，不是静默截断） |
| 普通正则大批量 | 结果与「逐行原生 `RegExp.test`」逐条相等（正确性对照） |
| 参数化：`ignoreCase`、跨文件顺序、`glob` 过滤同时存在 | 行为不变 |

**验收命令**

```bash
npx vitest run tests/grep.test.ts
npm run typecheck
```

---

### Task 3 · `glob`：非回溯匹配器

**问题（D-086）**：`compilePattern` 把每个段边界的 `**/` 编译成 `(?:.*/)?`，多个可选段在失败匹配时组合爆炸。实测 `**/a/`×12 组对 32 段路径 **>10 s**（单条路径！），×6 组 @64 段 **1.47 s**；现有上限（长度 ≤256、段数 ≤64）**拦不住**。`grep` 的 `glob` 过滤会对每个候选文件调用一次，5000 文件 × 数秒 = 会话级卡死。`AbortSignal` 同样打不断。

**目标**：匹配复杂度从「路径段数的指数」降到「模式段数 × 路径段数」，**语义逐条不变**。

**改动面**：`src/tools/glob.ts` + 测试。**不得改 `src/tools/grep.ts`**（Task 2 负责；`compileGlobMatcher` 的签名必须保持不变，grep 依赖它）。

**实现要求**

1. 保留 `isValidGlob` / `matchesGlob` / `compileGlobMatcher` 三个现有导出与签名。`compilePattern` 若不再需要可删（它是模块私有的），但**先确认没有任何测试 import 它**。
2. 匹配改为**按段 DP**：模式按 `/` 切段、路径按 `/` 切段；`**` 段匹配 0..n 个路径段（经典通配 DP），非 `**` 段内部用两指针通配（`*` 匹配任意长度、`?` 匹配恰好一个字符）。整体 O(模式段数 × 路径段数 × 段内长度)，无回溯。
3. **必须保住的既有语义**（`tests/glob.test.ts` 会逐条检查，先读懂再动手）：
   - `\` 先归一为 `/`；长度 ≤256、段数 ≤64、含 `\0` 一律非法；
   - 连续 `**/` 折叠为一个；
   - `*` 不跨 `/`；`**` 只在**整段**且其前后都是段边界时才是「任意多段」，否则退化为 `[^/]*`（例如 `a**b`）；
   - `?` 是「一个非 `/` 字符」；
   - 其余正则特殊字符当字面量；
   - `*` 也匹配以点开头的隐藏文件名；
   - 整串锚定（不是子串匹配）。
4. 旧的 `new RegExp` 路径可以从匹配里移除；`isValidGlob` 仍需对非法输入返回 false（不得因为换成 DP 就放宽接受范围）。

**测试**

| 用例 | 断言 |
|---|---|
| 现有 `tests/glob.test.ts` 全绿 | 641 行，逐条语义 |
| `**/a/` × 12 组对 32 段路径 | **< 50 ms**（今天 >10 s） |
| `**/a/` × 8 组对 48 段路径 | **< 50 ms** |
| `**/*a/` 连续 6 组 | **< 50 ms** |
| 同样形状但**应当匹配**的路径 | 返回 true（证明不是靠「一律不匹配」换速度） |
| 深度 64 的合法模式（段数上限内） | 不超时且结果正确 |
| `grep` 带 `glob` 过滤在深目录树上 | 现有 `tests/grep.test.ts` 的 glob 用例仍绿 |

**验收命令**

```bash
npx vitest run tests/glob.test.ts tests/grep.test.ts
npm run typecheck
```

---

## 不做的那三项（写进台账，不写代码）

| 项 | 实测 | 判定 |
|---|---|---|
| 7.2 每条事件 fsync + 每轮全量投影 | 每事件 fsync **1.16 ms**（append 本身 1.16 ms，其中 open+sync+close 约 1.25 ms）；真实会话每回合 **7–62 条事件**，即每回合 8–72 ms。`buildMessages` @10000 事件 **2.8 ms** | 收益在**毫秒级**，而 fsync 是断电后「日志不丢尾巴」的唯一保证（D-035），去掉它换不来可感知的速度。触发条件（「长回合明显卡顿」）不成立 |
| 7.5 压缩质量六项 | 无真实长会话 usage 数据；本机 3 个会话最长 105 行 | 触发条件不成立 |
| 7.6 预算与占用率计入 tool schemas | 内置工具 schema 合计 **6.3 KiB ≈ 1616 token**；MCP 侧 description 合计 1.4+1.6+2.9+0.3+0 KiB | 「schema 怎么算 token」的口径仍未定；且量级只有 ~2–4 K token，不是瓶颈 |

`sessions.list()` 本身（500 会话 119–162 ms）**不属于本轮 7.1**：本机真实会话数 3，触发条件（「数百」）未成立，且 stat 缓存只带来约 2× 收益。这一条连同数字记进台账，等会话数真的上去再做。

---

## 顺序与并发

- **Task 1 ∥ Task 2**：文件、测试、产物三方不重叠（`desktop/` vs `src/tools/`）。
- **Task 3 单独一轮**：它与 Task 2 同属 `src/tools/`，且 `grep.ts` 依赖 `glob.ts` 的导出；并行会让两边的测试互相看到半成品，重演批次 6 的「并发子代理互相破坏」。
- 子代理**只写工作区，不做任何 git 写操作**；每个任务完成后由控制器单独提交。
