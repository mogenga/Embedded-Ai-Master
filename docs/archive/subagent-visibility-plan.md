# 子代理可见性与 `/hook` 命令 —— 实施计划（2026-11-09）

> 来源：用户在批次 9.4 合并后提出的三个问题。原文：
> 「1.子代理运行时，对话框处是否有显示有哪些子代理正在运行，已运行了多久，和点击切换到子代理对话页面。2.是否有/hook命令」
> 用户决定：**按建议做**，子会话打开后是**只读回放**。

## 事实依据（已核对代码，2026-11-09）

| 事实 | 证据 |
|---|---|
| 渲染器里 `grep -c "subagent" app.js` = **0** | 只 `protocol.js` 有 `subagent_result` 一行、`settings.js` 有一个无生产者的用量标签 |
| 子会话落在 `<父会话目录>/subagents/<id>` | `src/subagent/runner.ts` 的 `sessionDir` |
| 会话列表只枚举 `sessions/` 的直接子目录，`subagents/` 整个不在扫描范围 | `desktop/host/host.js:705` 的 `readdirSync` + `isValidSessionId` |
| `detailTolerant(id)` 直接 `path.join(sessionsRoot, id)`，**不做越界校验** | `host.js:748` |
| 宿主已有 `loadSession` 的 `atSeq` 截断入口，越界抛错不钳位 | `host.js:2469`、`protocol.js` 的 `sessionLoadedEvent` |
| 内置斜杠命令硬编码三个：`clear` / `context` / `compact` | `host.js:1750` 的 `builtinCommands()`、`app.js:1915` 的 `RUNNABLE_COMMANDS` |
| `commands.js` 的 `COMMANDS` 是**渲染层自己的**目录，与宿主各一份 | `desktop/renderer/commands.js:9` |
| 计划条 `#plan-strip` 是「输入框上方一行、折叠态显示计数与当前项」的现成形态 | `app.js:1508`、`index.html` |
| `renderComposerLock()` 是回放态禁用输入框并显示原因的既有入口 | `app.js:933` |
| 钩子配置读取与校验是 `src/hooks/config.ts` 的 `loadHookConfig`，错误带文件与 `hooks[N]` | `src/hooks/config.ts:154`、`102` |
| 钩子结果只在 `tool_result.detail.hooks`，没有别的出口 | `src/tools/pipeline.ts` 的 `applyPostToolHooks` |

## 约束（每个任务的 brief 都原样带着）

- **禁止任何依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。需要装东西就停下来报告。
- **禁止在宿主机真实执行危险命令做测试**；本轮不涉及，但要记住：任何测试都不得真跑破坏性命令。
- **子代理不得执行任何 git 写操作**（`add` / `commit` / `reset` / `checkout` / `stash` / `switch` / `branch` / `worktree` / `merge`）。只读的 `git status` / `git diff` / `git log` 可以。
- **写文件只用 Write/Edit 工具**，不要用 `node -e` / `bash -c` 拼含反引号、`$()`、`${}` 的文本。
- 不得调大 `vitest.config.ts` 的超时，不得删改既有断言（可以新增）。
- **不得真实调用外部模型网关 / 触网**。
- 不得修改 `docs/BACKLOG.md`、`AGENTS.md`、`dev-notes/`、`docs/archive/**`。
- 渲染层没有 jsdom，也没有打包器：**只能**用协议层纯函数断言 + 源码静态断言（写法见 `tests/desktop/subagent-result.test.js`、`renderer-reachability.test.js`）。

---

### Task 1 · 内核：子代理的生命周期事件

**问题**：渲染器现在**只在子代理结束时**收到东西。要显示「正在跑哪些、跑了多久」，必须有一个**开始**事件，否则运行时那一侧根本不知道有过这个子代理。

**要改的全部在 `src/subagent/`**（`src/session/types.ts` 只加事件类型）：

1. `src/session/types.ts`：`EventType` 增 `"subagent_started"`；新增
   ```ts
   export interface SubagentStartedPayload {
     id: string;
     sessionDir: string;
     promptPreview: string;
     label?: string;
     startedAt: string;
     /** 真正生效的两个上限，不是用户填的原值（填 0 会被夹到边界）。 */
     maxTurns: number;
     timeoutMs: number;
   }
   ```
   `src/session/persistence.ts` 的 `EVENT_TYPES` 增同名键。
   `src/context/build.ts` 的投影 switch 把 `subagent_started` 与 `subagent_result` 归到**同一个**跳过分支（理由相同：它是事实记录，不是模型说过的话；而且它可能落在工具批次未闭合的窗口里）。

2. `src/subagent/runner.ts`：`startSubagent` 在 `jobs.set(job.id, job)` **之后**、`void runJob(...)` **之前**，把开始事件交给调用方。因为 runner 没有 session handle，改由 deps 回调：
   ```ts
   export interface SubagentDeps {
     // ...既有字段
     /** 子代理开跑时写一条 `subagent_started`。失败不阻止启动（见实现注释）。 */
     onStarted?: (payload: SubagentStartedPayload) => Promise<void>;
   }
   ```
   `startSubagent` 是 `async` 的，直接 `await deps.onStarted?.(...)`——但要**在返回 id 之前**完成，否则渲染器可能先收到完成事件。
   `maxTurns` / `timeoutMs` 用 `resolveSubagentMaxTurns` / `resolveSubagentTimeoutMs` 的结果，与 `subagent` 工具正文报的**同一对数字**（不要各算一次）。

3. `src/index.ts`：`createSubagentTools` 的 deps 里接上 `onStarted`：
   ```ts
   onStarted: async (payload) => {
     await session.append({ type: "subagent_started", payload });
   },
   ```
   写入失败**要让 `startSubagent` 抛错吗？不**——子代理已经起好了，一条日志写失败不该把它取消。但**也不能静默**：写失败时 `console.error` 一行 `[subagent] started event append failed`。这是既有的 `appendMcpStatus` 姿态（MCP 状态是观测性数据，写失败只降级）。

4. `desktop/renderer/protocol.js`：`KNOWN_TYPES` 增 `"subagent_started"`（**只登记，不出消息**——绘制在 Task 2）。

**验收**（`tests/subagent.test.ts` 追加，不改既有用例）：

| 用例 | 断言 |
|---|---|
| 开始事件先于完成事件 | 子会话完成后，父会话日志里 `subagent_started` 的 seq **小于** `subagent_result` 的 seq |
| 开始事件带真正生效的上限 | 传 `maxTurns: 0` + `timeoutMs: 0` → payload 里是默认值 30 / 600000，不是 0 |
| 开始事件可以没有 | 不传 `onStarted` 时 `startSubagent` 照常工作（既有用例已经覆盖，新增一条明确断言） |
| 写失败不阻止启动 | `onStarted` 抛错 → `startSubagent` **仍返回 id**，子代理照常跑完并进入完成队列 |
| 投影跳过 | `buildMessages` 对 `subagent_started` 不抛错，且它能落在 assistant 与 tool_result 之间 |

---

### Task 2 · 渲染器：运行中的子代理条 + 只读回放子会话

**问题**：这是用户问题的正面回答——「有哪些在跑、跑了多久、点一下能进去看」。

1. **`desktop/renderer/protocol.js`**：新增纯函数
   ```js
   /** 一条 `subagent_started` → 一行内部消息；缺字段时不画。 */
   export function subagentStartedEvent(payload) → { type: "subagent_started", id, label, promptPreview, startedAt, maxTurns, timeoutMs } | null
   ```
   并在 `case "subagent_started"` 里 `out.push(...)`。**不要**在这里算「跑了多久」——时间是每秒变的，纯函数里算出来一秒后就过期了。

2. **`desktop/renderer/app.js`**：新增 `#subagent-strip`，形态照 `#plan-strip`（输入框上方一行）：
   - **折叠态一行**：`2 个子代理运行中 · sa_a1b2 已跑 1:23 · +1`
   - **展开**：每个一行 `sa_a1b2「UART 排查」已跑 1:23 / 上限 30 轮、10 分钟`，每行**可点**，点击调 `loadSubagent(id)`。
   - **运行中的来源**：`state.subagents` 是 `Map<id, {label, startedAt, sessionDir}>`，在 `subagent_started` 时加入、在 `subagent_result` 时移除。
   - **计时**：一个 1 s 的 `setInterval`，只在 `state.subagents.size > 0` 时存在，清空时 `clearInterval`。**不要**在每次 tick 里重建 DOM——只更新计数与每个 id 的时长文本（与 `#plan-strip` 的原地更新同一姿态）。时长按 `Date.now() - Date.parse(startedAt)` 算，`startedAt` 解析失败就显示「已跑 ?」而不是 0。
   - **没有任何子代理时整个条 `hidden`**（不占位）。
   - **回放态隐藏**：`isReplaying()` 时条不可见——回放看到的是过去，那里的「正在运行」是一个假陈述。

3. **宿主 `desktop/host/host.js`：新增 `loadSubagent` 命令**。

   **这是本任务唯一的边界改动，必须小心。** 现在的 `detailTolerant(id)` 直接 `path.join(sessionsRoot, id)`，而 `isValidSessionId` 允许 `..` 之外的字符但**不允许** `/`，所以今天没有越界；但子会话路径是 `<parentId>/subagents/<childId>` 两段，**不能**直接 `path.join(sessionsRoot, id)`。

   做法：新增一个**显式两段式**路径解析，不把用户字符串拼接成路径片段：
   ```js
   // 父会话与子会话 id 各自都必须匹配 isValidSessionId；两段之间的 subagents
   // 是字面量，不是用户输入。
   function subagentSessionDir(parentId, childId) {
     if (!kernel.isValidSessionId(parentId) || !kernel.isValidSessionId(childId)) return undefined;
     return path.join(sessionsRoot, parentId, "subagents", childId);
   }
   ```
   `loadSubagent({ parentId, childId, atSeq })` 的逻辑**照抄** `handleLoadSession`（`host.js:2469`），只把路径换成上面这个、其余一律不改：`ctx.running` 拒绝、`stopFollow()`、`detailTolerant` 同款容错读取、`sessionLoadedEvent` 同一个截断入口、失败发 warn notice 不换会话。

   **只读**：`loadSubagent` 打开后把宿主的 `sessionId` 设为**父会话的 id**（不是子会话），并置一个 `state.readonlySession = { parentId, childId }` 标记。理由：子代理已经结束，往里发消息不会有任何东西消费它；而把 `sessionId` 改成子会话会让后续 `prompt` 往一个没有 runner 的目录里写。**`prompt` 在 `readonlySession` 非空时必须拒绝**，并说清原因（与回放锁同一措辞风格）。

   > **不要**允许从子会话再跳子会话：`subagentSessionDir` 的两段都是 id，没有第三段。

4. **`desktop/renderer/app.js` 的 `loadSubagent` 调用**：与 `loadSession` 同一条通路，但带 `{ parentId, childId }`。顶部给一条**常驻提示**（不可关闭，直到切回父会话）：「正在查看子代理 sa_xxx 的会话记录（只读）· 返回父会话」。点它回父会话（`loadSession(parentId)`）。

5. **`desktop/MATRIX.md`**：命令表补 `loadSubagent`；事件表补 `subagent_started`。

**验收**（`tests/desktop/subagent-strip.test.js`，纯函数 + 静态断言）：

| 用例 | 断言 |
|---|---|
| `subagentStartedEvent` 映射 | 完整 payload → 五个字段齐全；缺 `id` → `null` |
| 不画已完成的 | payload 带 `status` 字段时仍按开始处理（完成走 `subagent_result`），但 `app.js` 的静态断言里 `subagent_result` 必须**移除** `state.subagents` 的同 id |
| 计时器只在有子代理时存在 | 静态：`setInterval` 的创建点受 `state.subagents.size > 0` 保护；清空处有 `clearInterval` |
| 回放态隐藏 | 静态：`renderSubagentStrip` 里 `isReplaying()` 为真时 `hidden = true` |
| 路径不拼接用户输入 | **`subagentSessionDir` 的单元断言**：`("a/../b", "c")` / `("../a", "b")` / `("a", "../b")` 全部返回 `undefined`（`isValidSessionId` 拒绝 `/` 与 `..` 之外的形状要逐条验证）；合法输入返回 `<root>/a/subagents/b` |
| 只读不冒充 | 静态：`prompt` 分支里有 `readonlySession` 拒绝，且措辞含「只读」 |
| 事件登记 | `KNOWN_TYPES` 含 `subagent_started` |

---

### Task 3 · `/hook` 命令

**问题**：钩子只能用编辑器改 `~/.harness/hooks.json`，写错了要等下一轮跑起来才知道。

**范围**：`/hook`（列出当前生效的钩子 + 校验结果）与 `/hook reload`（重读配置）。**不提供编辑**——编辑仍然是手改文件。

1. **宿主新增 `getHooks` 命令**（`desktop/host/host.js`）：
   ```js
   getHooks() {
     // 与 runSession 完全同一套读取：同 home、同 workdir、同信任门。
     // 不要在这里另写一遍 schema 校验。
     const loaded = kernel.hooks?.loadHookConfig?.({ home: harnessHome, workdir: cwd, includeProject: false });
     ...
   }
   ```
   - `kernel.hooks` 走**惰性 import**（`import(dist("hooks/config.js")).catch(() => undefined)`），与 `skills` / `background` / `subagent` 同一写法。旧 `dist/` 缺这个模块时回一条 warn「请先 npm run build」**再回一条空的 `hooks` 事件**，不让渲染器等下去。
   - 回 `hooks` 事件：`{ hooks: [{ event, matcher, command, source, index, timeoutMs }], userConfigPath, projectConfigPath, projectSkipped?, error? }`。
   - **配置坏了要回 `error` 而不是空列表**（R3）：「没有钩子」与「配置读不出来」是两件事。
   - `includeProject: false` 是刻意的：桌面形态本来就不加载项目级钩子（与 MCP / permissions 同一姿态，见 `docs/operations/hooks.md` 的已知边界）。要如实把 `projectSkipped` 一起回给界面，让用户看到「有个文件在这儿，但没被加载」。

2. **渲染层 `desktop/renderer/commands.js`**：`COMMANDS` 增一行
   ```js
   { name: "hook", description: { zh: "查看已配置的钩子", en: "List configured hooks" }, argumentHint: "[reload]" }
   ```
   并让 `parseSlashText("/hook reload")` 正常还原（它是既有纯函数，应该不用改，但要有断言钉住）。
   `desktop/host/host.js` 的 `builtinCommands()` 也增 `{ name: "hook" }`——两处各一份是既有现实（渲染层与宿主各一份目录），本轮不合并它们，但要**在两处都加**，否则命令能敲出来却不被路由。

3. **`desktop/renderer/app.js`**：`RUNNABLE_COMMANDS` 增 `"hook"`；`runSlashCommand` 的 switch 增
   ```js
   case "hook":
     if (String(args ?? "").trim() === "reload") { api.send({ cmd: "getHooks", reload: true }); return "ran"; }
     if (String(args ?? "").trim() !== "") { /* 只说 reload 一个参数 */ }
     api.send({ cmd: "getHooks" });
     return "ran";
   ```
   收到 `hooks` 事件后画成转录里的一段（不是 notice）：每行 `preToolUse  shell   node deny-rm.mjs   [user #0]`；坏配置时一段 warn 说明文件与 `hooks[N]`。

4. **`docs/operations/hooks.md`**：新增一节「用 `/hook` 查看」，说明它会显示什么、`reload` 只是**重读给界面看**（真正生效仍在下一轮 `runSession`），以及它**不会**替你改文件。

**验收**（`tests/desktop/hook-command.test.js`）：

| 用例 | 断言 |
|---|---|
| 命令存在且两处一致 | `commands.js` 的 `COMMANDS` 与 `host.js` 的 `builtinCommands()` 都含 `hook` |
| 参数解析 | `parseSlashText("/hook")` / `"/hook reload"` 各自还原；`"/hook foo"` 被 `runSlashCommand` 拒绝并说明只支持 `reload` |
| 宿主惰性加载 | 静态：`getHooks` 走 `kernel.hooks` 且对 `undefined` 有 warn + 空事件（不只是报错） |
| 坏配置如实报 | 静态：`getHooks` 的 catch 里回 `error` 而不是 `hooks: []` |
| 项目级如实披露 | 静态：`includeProject: false` 且 `projectSkipped` 出现在事件里 |
| 不提供写操作 | 静态：整个 `getHooks` 里不出现 `writeFile` / `rm` / `rename` |

---

## 顺序与并发

- **Task 1 → Task 2 串行**：Task 2 依赖 `subagent_started` 的字段名。
- **Task 3 与 Task 1/2 文件重叠极少**，但同样改 `host.js` 与 `app.js`、`commands.js`，**仍然串行**做，避免同一文件两处半成品互相破坏。
- 子代理只写工作区、不做任何 git 写操作；每个任务由控制器单独提交。

## 明确不做

| 项 | 理由 |
|---|---|
| 在子会话里继续对话 | 用户选定只读。子代理已结束，没有东西会消费那条消息；把 `sessionId` 换成子会话还会让 `prompt` 往一个没有 runner 的目录里写 |
| 子代理面板（独立 pane） | 一行条 + 点击跳转已经回答了用户的问题；独立 pane 是 D-185 删掉的那种大块 UI |
| `/hook` 的编辑能力 | 编辑仍是手改文件；一个能改配置的斜杠命令等于给权限层之外又开一个写入面 |
| 合并渲染层与宿主的命令目录 | 两处各一份是既有现实，合并是另一件事；本轮只在两处都加 `hook` |
| 从子会话再跳子会话 | `subagentSessionDir` 的路径是固定两段，没有第三段 |
