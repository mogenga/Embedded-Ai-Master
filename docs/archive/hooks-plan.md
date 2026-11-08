# 批次 9 · 9.4 hooks（外部命令钩子）—— 实施计划（2026-11-08）

> 来源：`docs/BACKLOG.md` 批次 9 的 9.4。用户 2026-11-08 选定：
> **「外部命令钩子」** —— 钩子是配置里的**一条命令**，工具调用的 JSON 走它的 stdin。
> `preToolUse` 退出码 2 = 阻断并把 stderr 回给模型；`postToolUse` 的 stdout 落进结果。
> 钩子**只在权限层放行之后**运行，因此永远只能收紧，不能放行。

## 事实依据（已核对代码）

| 事实 | 证据 |
|---|---|
| 权限层已经覆盖「调用前 allow/ask/deny」，且 `evaluatePolicy` 的异常分支是 **deny**（fail-closed） | `src/permissions/policy.ts:161`、`gate.ts:217` |
| `executeBatch` 的授权与执行是两段：`authorizeOne` → `executeAuthorized`，中间隔着 `onToolStarted` 回调 | `src/tools/pipeline.ts:398,466,578` |
| `onToolStarted` 写 `tool_started` 事件；授权阶段刻意**不**预写它（注释写明「避免留下已 started 但从未执行」） | `src/tools/pipeline.ts:437-439`、`src/loop/query.ts:705` |
| 结果后处理统一在 `finalizeResult`：超过 8000 token 落 artifact、正文截到 25000 token | `src/tools/pipeline.ts:311` |
| `ToolResult` 已有 `detail` 通道，`query` 原样写进 `tool_result` 事件；但 `buildMessages` **只**把 `text` 投给模型 | `src/tools/types.ts:15`、`src/loop/query.ts:267`、`src/context/build.ts:295` |
| `evidence: true` 的结果参与压缩保护（`summaryCoversEvidence` / `canElideEvidence`） | `src/context/build.ts:95,120` |
| `matchToolPattern` 已实现 `*` / `?` 通配，长度上限 200 | `src/permissions/rules.ts:27` |
| MCP server 的子进程 env 走 `buildEnv`：默认只继承白名单，`inheritEnv: true` 才全量 | `src/mcp/manager.ts:205` |
| 项目级配置的既有信任门：`trustProjectConfig` 或显式 `projectConfigPath` 才读 `.harness/mcp.json` | `src/index.ts:673-681` |
| `spawn` 一次 `node` 空跑的固定成本约 **120 ms**（本机实测） | `node -e` 计时 |

## 约束（每个任务的 brief 都原样带着）

- **禁止任何依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。需要装东西就停下来报告。
- **禁止在宿主机真实执行危险命令做测试**；危险命令用例只能靠纯函数断言或注入 mock 制造 RED。钩子测试用的命令必须是**无害、跨平台、限定在临时目录内**的（把 `node script.mjs` 的脚本写进临时目录再执行，不要用 `node -e` 拼多行文本）。
- **子代理不得执行任何 git 写操作**（`add` / `commit` / `reset` / `checkout` / `stash` / `switch` / `branch` / `worktree` / `merge`）。只读的 `git status` / `git diff` / `git log` 可以。
- **写文件只用 Write/Edit 工具**，不要用 `node -e` / `bash -c` 拼含反引号、`$()`、`${}` 的文本。
- 不得调大 `vitest.config.ts` 的超时，不得删改既有断言（可以新增）。
- **不得真实调用外部模型网关 / 触网**。
- 不得修改 `docs/BACKLOG.md`、`AGENTS.md`、`dev-notes/` —— 那三处由控制器在两条分支都合并后统一写。
  （`AGENTS.md` 里「没有子代理 / 钩子、「`grep -rn "subagent|hook" src/` 零命中」会被这两批同时
  变成假话，两条分支各改一次必然冲突，所以统一留给控制器。）

---

### Task 1 · 内核钩子层（`src/hooks/`）

**目标**：`$HARNESS_HOME/hooks.json`（用户级）与 `<workdir>/.harness/hooks.json`（项目级，
需信任）里的命令钩子，在工具调用前后执行，能阻断、能追加说明，且**不能**放行被权限层拒绝的调用。

**新增模块**（全为新文件，`src/tools/pipeline.ts` 只加最小接线）：

- `src/hooks/types.ts`
  ```ts
  export type HookEvent = "preToolUse" | "postToolUse";
  export interface HookDef {
    event: HookEvent;
    /** 工具名模式，语法与权限规则一致（`*` / `?`）。缺省匹配全部工具。 */
    matcher?: string;
    command: string;
    args?: string[];
    timeoutMs?: number;
    /** 来源，用于错误信息里说清是哪份文件配的。 */
    source: "user" | "project";
    /** 配置里这条规则的序号 + 文件，错误信息要能指回去。 */
    index: number;
  }
  export interface HookOutcome {
    event: HookEvent;
    command: string;
    /** 进程退出码；起不来或超时是 undefined。 */
    exitCode?: number;
    /** preToolUse 的 exit 2 是「阻断」，这是唯一会被当成决定的退出码。 */
    blocked: boolean;
    /** stdout / stderr，各截到 8000 字符（见 MAX_HOOK_OUTPUT_CHARS）。 */
    stdout: string;
    stderr: string;
    /** 钩子本身没跑成（spawn 失败 / 超时 / 非 0 非 2 退出）。 */
    failure?: string;
    durationMs: number;
  }
  export interface HookRunner {
    /** 返回本次调用的全部钩子结果；空数组表示没有配钩子。 */
    run(event: HookEvent, tool: string, payload: unknown, signal: AbortSignal): Promise<HookOutcome[]>;
  }
  ```
- `src/hooks/config.ts` —— 读取 + 严格校验（zod，未知字段拒绝，与 `app-config.ts` 同一姿态）。
- `src/hooks/run.ts` —— 执行一条钩子（`spawn` + stdin 写入 + 超时 + 输出截断）。
- `src/tools/pipeline.ts` 接线（唯一的既有文件改动）。

**配置格式**（`hooks.json`）：

```json
{
  "version": 1,
  "hooks": [
    { "event": "preToolUse", "matcher": "shell", "command": "node", "args": ["C:/hooks/deny-rm.mjs"], "timeoutMs": 5000 },
    { "event": "postToolUse", "matcher": "mcp__keil__*", "command": "node", "args": ["C:/hooks/note.mjs"] }
  ]
}
```

- `version` 必须是 `1`；`hooks` 必须是数组。
- `event` ∈ `preToolUse` / `postToolUse`；`matcher` 缺省 = 匹配全部；`command` 必须非空；
  `args` 必须是字符串数组；`timeoutMs` 必须是 1..60000 的整数，缺省 **5000**。
- 未知字段**直接报错**，不静默忽略（拼错的 `macher` 会让一条安全钩子从不运行）。
- 项目级（`<workdir>/.harness/hooks.json`）与 `mcp.json` 同一信任规则：`includeProject` 为真才读；
  跳过时发一条 `status` 事件说明，措辞照 `permissions_project_config_skipped` 的形状
  （`hooks_project_config_skipped`）。

**执行语义（每一条都要有断言）**：

1. **钩子命令的 env 是指定的最小集**：`PATH`、`PATHEXT`（Windows）、`HOME` / `USERPROFILE`、
   `TEMP` / `TMP`、`SystemRoot` / `COMSPEC`（Windows）。**不继承**其它环境变量
   —— 模型密钥（`apiKeyEnv` 指向的变量）绝不能进到一条用户可写的命令里。
   与 `buildEnv` 的默认白名单同一姿态，但这里是硬编码常量。
2. **stdin 是这次调用的 JSON**：`{ tool, callId, sessionId, cwd, input }`
   （`postToolUse` 再加 `result: { isError, code, message, text }`）。写完 stdin 后关闭。
   序列化失败（循环引用）→ 这条钩子记 `failure`，按下面的失败语义处理。
3. **`preToolUse` 的退出码**：
   - `0` → 放行，stdout 忽略。
   - `2` → **阻断**。工具不执行，结果是一份 `isError: true` / `code: "hook_blocked"` 的
     `ToolResult`，`text` = stderr（截断后；为空时给一句固定说明）。
   - 其它退出码 / 超时 / spawn 失败 → **阻断**（fail-closed），`code: "hook_failed"`，
     `text` 说明是哪条钩子、为什么失败。理由：`preToolUse` 存在的意义就是拦截；
     一个无法求值的闸门不能被当成开着的。这与 `evaluatePolicy` 的 catch → deny 同一姿态。
   - **多条钩子全部执行**，不是短路：第一条阻断后仍跑完其余并记录结果，
     这样一次调用就能看到所有反对意见。最终决定 = 任一阻断即阻断。
4. **`postToolUse` 的退出码**：`0` 且 stdout 非空 → 追加到结果正文（见第 5 条）；
   非 `0` → 只记 `failure`，**不改变结果**，也**不**把工具判成失败——工具确实成功了，
   是钩子没跑成。这条要在 stdout 里说清（`isError` 保持工具自己的值）。
5. **`postToolUse` 的 stdout 是追加不是替换**，写成：

   ```
   <原正文>

   --- hook: <command> ---
   <钩子的 stdout>
   ```

   **`evidence` 降级**：原结果 `evidence === true` 时，追加后把 `evidence` 改成 `false`，
   并在 `detail.hooks[].evidenceDropped = true`。理由：`evidence` 参与压缩保护，
   主张的是「这是工具的原始输出」；一段由钩子写进去的话不在这个主张范围内（R3）。
6. **全部结果进 `detail.hooks`**：`ToolOutcome` 数组原样落进 `ToolResult.detail.hooks`
   （`detail` 已有就别覆盖，见 `mergeArtifactError` 的既有合并写法）。
   `detail` 不进模型上下文，所以模型实际看到的只有第 5 条的追加正文与第 3 条的阻断说明。
7. **只在权限放行之后**：`preToolUse` 与 `postToolUse` 都挂在
   `src/tools/pipeline.ts` 的 `executeAuthorized` 上——`preToolUse` 在函数开头
   的两道 abort 复查之后、`onToolStarted` 之前；`postToolUse` 在
   `Promise.race` 拿到结果之后、**返回给 `finalizeResult` 之前**。
   - 选这个位置而不是 `executeBatch`，是因为并发分支与串行分支都经过
     `executeAuthorized`（`pipeline.ts:578` 与 `:730`），挂在别处必然要写两遍，
     而两遍就会有一遍忘了改。
   - 放在 `finalizeResult` 之前，追加进正文的钩子输出才会计入 8000 token 的
     落盘阈值、25000 token 的截断，并随正文一起进 artifact。放在之后再改
     `text`，就会出现「artifact 里是旧正文、日志里是新正文」。
   - 被权限层拒绝的调用在 `authorizeOne` 就返回了，`executeAuthorized` 根本不会
     被调用，所以**一条钩子都不跑**——钩子没有机会把它放行。这条要有断言
     （deny 的调用，钩子脚本一次都没被 spawn）。
8. **钩子不参与并发判定**：`executeBatch` 的只读并发分支与串行分支都走同一条
   `preToolUse` 路径；不要在并发分支里跳过钩子（那会让「加个钩子」变成「有并发时失效」）。
   钩子是串行执行的：同一次调用里的多条钩子按配置顺序一条一条跑，输出顺序可预测。
9. **超时用 `AbortSignal`**：`AbortSignal.any([外层 signal, AbortSignal.timeout(timeoutMs)])`；
   外层中止时钩子进程用 `signalProcessTree` 收（`src/tools/process-tree.ts:35`），
   **不要**新写一份杀进程逻辑。

**接线签名**（`src/tools/pipeline.ts`，改动要小）：

- `BatchOptionsCommon` 增可选 `hooks?: HookRunner`。缺省 `undefined` = 零行为变化
  （与 `permission?` 不同，钩子是**可选**的：没有钩子配置本来就没有可执行的东西，
  而「不经权限层」是另一回事，那仍然必须显式二选一）。
- `LoopCtxCommon` 增可选 `hooks?: HookRunner`，`src/loop/query.ts` 原样透传给 `batchOptionsBase`。
- `src/index.ts` 的 `RunOptions` 增 `hooks?: { userConfigPath?: string; projectConfigPath?: string; trustProjectConfig?: boolean }`，
  与 `mcp` 那组同形；读配置失败时发 `status`（`hooks_config_failed`）并**不阻止运行**
  ——钩子是加固，不是运行的前提。没有配置文件时 `hooks` 为 `undefined`，行为与现在逐字节一致。

**验收**（`tests/hooks.test.ts`，全部离线；钩子脚本写进临时目录再 `node <path>` 执行）：

| 用例 | 断言 |
|---|---|
| 没有钩子时零变化 | `createBuiltinTools()` 的一个工具照常执行，`executeBatch` 结果逐字段与不传 `hooks` 时相同 |
| preToolUse 放行 | 钩子 `process.exit(0)` → 工具真的执行了（副作用可观察，如临时文件被写入） |
| preToolUse 阻断 | 钩子 `process.exit(2)` 且 stderr 有内容 → 结果 `hook_blocked`，`text` 含 stderr，**工具没有执行**（目标文件不存在） |
| 多条钩子都跑 | 两条钩子各写一行到同一个文件 → 文件里两行都在（证明没短路） |
| 钩子失败是 fail-closed | 钩子 `process.exit(1)` → 结果是 `hook_failed` 且工具没有执行 |
| 钩子起不来 | `command` 指向不存在的可执行文件 → `hook_failed`，工具没有执行 |
| 钩子超时 | 钩子 `setTimeout(()=>{}, 60000)` 且 `timeoutMs: 200` → `hook_failed`，且**在 2 s 内**返回 |
| 权限拒绝时钩子一次都不跑 | gate 判 deny → 结果 `permission_denied`，钩子脚本的副作用文件**不存在** |
| postToolUse 追加 | 钩子 stdout 是 `hello` → 结果正文含 `--- hook: ` 与 `hello`，且原正文仍在前面 |
| postToolUse 不改判 | 钩子 `exit 1` → 工具结果仍是 `isError: false`，`detail.hooks` 里有 `failure` |
| evidence 降级 | 一个 `annotations.evidence: true` 的假工具 + 有 stdout 的钩子 → `evidence === false`，`detail.hooks[0].evidenceDropped === true` |
| stdin 契约 | 钩子把 stdin 原样写到文件 → JSON 可解析，含 `tool` / `callId` / `sessionId` / `cwd` / `input`（post 还有 `result`） |
| env 最小集 | 钩子把 `process.env` 写成 JSON → **不含**测试进程里注入的哨兵变量（设一个 `HOOK_SENTINEL_SECRET` 再断言它不在） |
| matcher 通配 | `matcher: "mcp__keil__*"` 匹配 `mcp__keil__x`、不匹配 `shell` |
| 配置校验 | 未知字段 / 非法 `event` / 超范围 `timeoutMs` 各报错，错误信息含文件与序号 |

**另外**：`tests/tools.test.ts` 里「按固定顺序返回 13 个内置工具」只在子代理那条分支加工具时改，
本任务不动它。

---

### Task 2 · 宿主接线与文档（`desktop/` + `docs/`）

**目标**：桌面宿主真正读 `hooks.json` 并把它交给内核；操作手册写清契约；能力矩阵同步。

1. `desktop/host/host.js`：建 runner / 发 `prompt` 时把 `hooks` 选项传进 `runSession`
   （照 `permissions` 那一组现有的传法，`host.js:976`）。**不要**在宿主里再校验一遍配置
   ——校验归 `src/hooks/config.ts`，两处各判一次迟早给出两个结论。
2. `desktop/renderer/protocol.js`：`case "status"` 增两个分支
   ——`hooks_config_failed`（warn，说明哪份文件坏了）与 `hooks_project_config_skipped`
   （warn，说明项目级钩子未加载、怎么信任）。**不新增事件类型**：钩子结果已经在
   `tool_result.detail.hooks` 里，工具行展开可见，另起一种事件是同一事实的第二份定义。
3. `desktop/renderer/protocol.js`：工具行在有 `detail.hooks` 且其中 `blocked` 或
   `failure` 时，给一行附加说明（例如「被钩子拦截」「钩子未运行」）。
   写法照既有 `tool_result` 分支，**不要**为它新建面板。
4. `docs/operations/hooks.md`（新建，契约唯一源）：配置格式与每一档退出码的含义、
   为什么 fail-closed、为什么 stdout 是追加不是替换、`evidence` 为什么会降级、
   钩子拿到的 env 为什么是最小集、项目级配置的信任规则、已知边界
   （钩子不参与并发判定；钩子只能收紧不能放行；钩子的输出不进模型上下文，
   进上下文的是它被追加进正文的那一段）。写完 `npm run check:docs` 必须通过。
5. `desktop/MATRIX.md`：`hooks` 从「已隐藏 / 内核没有这个能力」的清单里移出，
   写明现在的形态（配置命令钩子，无 UI 页面）。找到列举 memory / instructions / hooks
   的那一行改，别重写整段。

**验收**：

```bash
npx vitest run tests/desktop/hooks-host.test.js tests/desktop/protocol.test.js
npm run check:js
npm run check:docs
```

`tests/desktop/hooks-host.test.js`：

| 用例 | 断言 |
|---|---|
| 宿主透传 | 静态断言 `host.js` 把 `hooks` 传进了 `runSession` 的入参（与 `permissions` 同一处） |
| 两种状态各有分支 | `protocol.js` 的 `case "status"` 里含 `hooks_config_failed` 与 `hooks_project_config_skipped` 两个字符串 |
| 状态能画 | `sessionEventToHostEvents` 对这两条 status 各给一条 `warn` notice |
| 钩子拦截可见 | 一个带 `detail.hooks[{blocked:true}]` 的 `tool_result` 经协议层后带一行附加说明 |
| 没钩子时不变 | 没有 `detail.hooks` 的 `tool_result` 输出与现在逐字段相同（证明不是无条件加字段） |

---

## 顺序与并发

- **Task 1 → Task 2 串行**：Task 2 依赖 Task 1 定下的 status 取值与 `detail.hooks` 形状。
- 同一分支内由同一个子代理连续做两个任务，每个任务单独提交。

## 明确不做

| 项 | 理由 |
|---|---|
| 进程内 JS 钩子（`.harness/hooks.mjs`） | 用户选的是外部命令。模块钩子把任意代码直接载入宿主进程，加载失败语义与热更新都要另定 |
| 钩子能放行被权限层拒绝的调用 | 结构上就不给这个位置：钩子接在 `authorizeOne` 之后 |
| 钩子改写入参 | `PreToolUse` 的 `updatedInput` 会让「模型说要写 A」变成「实际写了 B」，审批摘要对不上；本任务只做阻断 |
| 钩子替换结果正文 | 替换会让日志主张工具返回了它没返回的东西（R3）；只做追加并降级 `evidence` |
| 钩子的 UI 配置页 | 设置页要四个新读写命令 + 表单；配置是手编文件，先有契约 |
| 钩子并发运行 | 一次调用里的钩子串行执行，输出顺序可预测；并发会让「第一条阻断」变得不确定 |
