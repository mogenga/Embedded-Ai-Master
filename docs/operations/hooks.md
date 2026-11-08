# 外部命令钩子（`hooks.json`）

> **本文是钩子配置格式、退出码语义与边界的唯一契约源。**
> 实现：
> [`src/hooks/types.ts`](../../src/hooks/types.ts)（`HookDef` / `HookOutcome` / `HookRunner`）、
> [`src/hooks/config.ts`](../../src/hooks/config.ts)（读取、严格校验、信任门）、
> [`src/hooks/run.ts`](../../src/hooks/run.ts)（spawn、stdin、超时、输出截断、env 最小集）、
> 挂点 [`src/tools/pipeline.ts`](../../src/tools/pipeline.ts) 的 `executeAuthorized`、
> 事件 [`src/index.ts`](../../src/index.ts) 的 `runSession`、
> 绘制 [`desktop/renderer/protocol.js`](../../desktop/renderer/protocol.js) 的
> `case "status"` / `summarizeHookDetail`。
> 改实现要同步改本文；改本文要同步改 `desktop/MATRIX.md` 的对应行。

## 这是什么，不是什么

钩子是**配置文件里的一条命令**。工具调用发生前后，内核把这次调用的 JSON 写进那条
命令的 stdin；退出码决定它是放行、阻断，还是「没跑成」。

```
模型要调 shell
  → 权限层 allow/ask/deny 裁决
  → （放行后）preToolUse 钩子们依次跑
  → 工具执行
  → postToolUse 钩子们依次跑
  → 结果写进会话日志
```

**它只能收紧，不能放行。** 钩子接在权限层**之后**（`executeAuthorized`），被权限层
拒绝的调用根本走不到那里——这不是约定，是结构：那条路径上不存在「钩子说可以」这个
判断点。想放宽某条规则，改的是权限配置，不是钩子。

**它没有 UI 页面。** 配置是手编文件，没有设置页表单，宿主也没有任何写钩子的命令。
理由很直接：先有契约，UI 才有内容可编辑；一个现在就能打开却保存不了的表单，是这个
仓库反复删掉的那种死界面（D-185）。

| 不做 | 理由 |
|---|---|
| 进程内 JS 钩子（`.harness/hooks.mjs`） | 用户选的是外部命令。模块钩子把任意代码直接载入宿主进程，加载失败语义与热更新都要另定 |
| 钩子放行被权限层拒绝的调用 | 结构上不给这个位置（见上） |
| 钩子改写入参 | `PreToolUse` 的 `updatedInput` 会让「模型说要写 A」变成「实际写了 B」，审批摘要对不上；本版只做阻断 |
| 钩子替换结果正文 | 替换会让日志主张工具返回了它没返回的东西（R3）；只做追加并降级 `evidence` |
| 钩子之间的并发 | 一次调用里的钩子按配置顺序**串行**跑，输出顺序可预测；并发会让「第一条阻断」变得不确定 |
| 钩子输出进模型上下文 | 进上下文的是**被追加进正文的那一段**，`detail.hooks` 整个不进（见「已知边界」） |

## 配置文件

用户级 `$HARNESS_HOME/hooks.json`（默认 `~/.harness/hooks.json`）。
项目级 `<workdir>/.harness/hooks.json`。

```jsonc
{
  "version": 1,
  "hooks": [
    {
      "event": "preToolUse",          // 必填：preToolUse | postToolUse
      "matcher": "shell",             // 可选：工具名模式，缺省 = 全部工具
      "command": "node",              // 必填：非空、非纯空白
      "args": ["C:/hooks/deny-rm.mjs"],// 可选：字符串数组
      "timeoutMs": 5000               // 可选：1..60000 整数，缺省 5000
    }
  ]
}
```

| 字段 | 规则 | 违反时 |
|---|---|---|
| `version` | 必须是字面量 `1` | `unsupported_version` |
| `hooks` | 必须是数组（可为空） | `invalid_schema` |
| `event` | `preToolUse` / `postToolUse` | `invalid_schema`，消息含 `hooks[N]` |
| `matcher` | 1..200 字符，语法同权限规则（`*` / `?`），非纯空白 | `invalid_schema` |
| `command` | 非空、非纯空白 | `invalid_schema` |
| `args` | 字符串数组 | `invalid_schema` |
| `timeoutMs` | 1..60000 的整数 | `invalid_schema` |
| **未知字段** | **直接报错** | `invalid_schema`，消息含字段名 |

未知字段是错误而不是忽略：拼错的 `macher` 会让一条安全钩子**从不运行**，而日志上
看不出少了什么（R3）。错误消息形如
`钩子配置无效: E:/home/hooks.json（hooks[0]: 未知字段 "macher"）`——文件名与
`hooks[N]` 都能指回用户手里的那几行。

`matcher` 与权限规则共用 `matchToolPattern`（`src/permissions/rules.ts`）：MCP 工具
的命名空间形如 `mcp__keil__*`，`*` 只匹配该段，不跨工具名。

### 两份文件怎么合并

用户级在前、项目级在后，**同一份 `detail.hooks` 里按这个顺序排列**，执行也按这个顺序
（`pre` 全部跑完才轮到工具，`post` 在工具之后）。

`source`（`user` / `project`）与 `index`（**该条在它所属的那份文件里的序号**，不是
合并后的全局下标）随每条结果一起记录，错误信息据此指回具体文件的具体几行。

### 项目级配置的信任规则

与 `mcp.json` / `permissions.json` 同一道门：只有 `trustProjectConfig: true`
**或**显式给出 `projectConfigPath` 时，才读 `<workdir>/.harness/hooks.json`。

未信任而文件存在时，内核发一条 `status: hooks_project_config_skipped`（载荷是被跳过
的绝对路径），协议层把它画成一条 warn：「未信任该工作区」。这不是错误——文件可能完全
合法，只是**一个 checkout 附带的命令不该默认以你的身份运行**。

桌面宿主**不**替你做这个决定：它从不传 `trustProjectConfig`，也不传
`projectConfigPath`。所以今天在桌面形态下**项目级钩子不会被加载**，每次会看到那条
warn。用户级钩子不受影响（内核默认读 `$HARNESS_HOME/hooks.json`，宿主把
`harnessHome` 交给 runner 就够了）。要信任某个工作区的项目钩子，目前只有非桌面路径
（`runSession({ hooks: { trustProjectConfig: true } })`，如夜批脚本）；桌面侧还没有
「信任此工作区」的入口。

## stdin：钩子拿到什么

一次调用写一行 JSON，写完即关（钩子读到 EOF）。

```jsonc
{
  "tool": "shell",                 // 工具名
  "callId": "call_abc",            // 本次调用的 id
  "sessionId": "0f3c…",            // 会话 id
  "cwd": "E:/work",                // 工具工作目录
  "input": { "command": "make" },  // 工具参数，原样
  // 仅 postToolUse 追加：
  "result": {
    "isError": false,
    "code": "ok",
    "message": "",
    "text": "…工具的正文…"
  }
}
```

`result` **不含** `detail` / `evidence` / `artifactPath`：钩子不该看到一份比模型更
完整的结果，否则「钩子看到的就是模型看到的」不再成立。

序列化失败（循环引用等）→ 这条钩子记 `failure`，按「钩子没能求值」处理（pre 失败即
阻断，见下）。

## env：最小集，没有开关

钩子进程能看到的环境变量是**硬编码**的这几个：

```
PATH  PATHEXT  HOME  USERPROFILE  TEMP  TMP  SystemRoot  COMSPEC
```

取不到的自然缺席（`PATHEXT` / `SystemRoot` / `COMSPEC` 只在 Windows 有）。

**不继承 `process.env`，也没有 `inheritEnv`。** 模型的密钥（`providers.json` 的
`apiKey`，或 `apiKeyEnv` 指向的变量）绝不能被一条用户可写的命令读到——那等于把密钥
交给一个只看配置、不看代码的人。MCP server 那边可以配 `inheritEnv`，因为 server 是
用户自己配的可执行程序，放宽是用户的决定；钩子的定位是「一条能看工具调用的命令」，
它没有理由需要密钥。

代价要认：钩子拿不到你在 shell 里 `export` 的任何东西。需要某个值时，把它写进命令的
`args`。

## 退出码：每一档的含义

### `preToolUse`

| 退出码 | 语义 | 工具执行了吗 | 模型看到什么 |
|---|---|---|---|
| `0` | 放行 | 是 | 什么都不多（stdout 只进 `detail.hooks`） |
| `2` | **阻断** | 否 | 钩子的 **stderr**（trim 后）；stderr 为空时给一句固定说明 |
| 其它非 0 | **阻断**（fail-closed） | 否 | `hook failed: <原因>`，stderr 非空时后面附上 |
| 超时 | **阻断**（fail-closed） | 否 | 同上，原因为 `timed out after <N>ms` |
| 起不来（spawn 失败） | **阻断**（fail-closed） | 否 | 同上 |
| 被信号杀死 | **阻断**（fail-closed） | 否 | 同上 |

结果码：阻断 → `hook_blocked`；其余失败 → `hook_failed`。两者都是 `isError: true`。

**为什么 fail-closed。** 一个无法求值的闸门不能被当成开着的。这与
`evaluatePolicy` 的 `catch → deny`、`permissionDenied` 是同一姿态；区别只在这条是
钩子自己坏了，不是权限规则。反过来做（失败即放行）意味着**只要能让钩子崩掉，就能
绕过它**——那让钩子变成装饰。

`2` 是唯一被当成决定的退出码，也是 Claude Code 的既有约定，所以钩子作者写的理由
（stderr）原样交给模型：他要说的话就是模型唯一需要的信号，不需要我们替他概括。

**多条钩子全部执行，不短路。** 第一条阻断之后其余的照跑，一次调用就能看到所有反对
意见；最终决定是「任一阻断即阻断」，不会因为后面的钩子跑成功而改变。

被钩子拦下的调用**不会**留下 `tool_started` 事件——「已 started 但从未执行」是授权
阶段刻意避免的那种谎。

### `postToolUse`

| 退出码 | 语义 |
|---|---|
| `0` 且 stdout 非空 | 追加进结果正文（见下） |
| `0` 且 stdout 为空 | 什么都不做，只留 `detail.hooks` 记录 |
| 非 0 / 超时 / 起不来 | **只记 `failure`**：工具结果的 `isError` / `code` / `message` 全部保持工具自己的值 |

`postToolUse` **不产生新的结果码**。工具确实成功了，是钩子没跑成——把工具判成失败会
让模型以为操作没发生。

一个 `exit 1` 却写了 stdout 的钩子，它的 stdout **也不追加**：否则模型会同时拿到
「工具成功」和一段没人说得清出处的话。

## stdout 是追加，不是替换

post 钩子的 stdout 被追加到正文末尾：

```
<工具原本的正文>

--- hook: <command> ---
<钩子 stdout 全文>
```

**为什么不替换。** 替换会让会话日志主张「工具返回了它没返回的东西」——日志是唯一
事实源，一份被钩子改写的正文无法与「工具真的这么说了」区分（R3）。

追加发生在 `finalizeResult` **之前**，所以它计入 8000 token 的落盘阈值与 25000 token
的截断，并随正文一起进 artifact。放之后再改 `text`，会得到「artifact 里是旧正文、
日志里是新正文」。

### `evidence` 为什么会降级

工具带 `annotations.evidence: true` 时，它的结果参与压缩保护——那条保护的主张是
**「这是工具的原始输出」**。一段由钩子写进去的话不在这个主张范围内。

所以一旦有钩子输出被追加进正文，结果的 `evidence` 变成 `false`，并在那条钩子的
`detail.hooks[].evidenceDropped` 上记 `true`。原文仍在正文里，只是这个结果不再声称
自己是未经加工的原始输出。

注意这条撤回**不是**在钩子层写的：`evidence` 由调用方在 `finalizeResult` 之后按工具
注解赋值，所以管线传出一个 `evidenceDropped` 信号，串行与并发两个分支各按它把
`evidence` 置 false。

## `detail.hooks`：每条结果都留痕

所有执行结果原样落进 `ToolResult.detail.hooks`（数组，pre 在前、post 在后）：

```ts
{
  event: "preToolUse" | "postToolUse",
  command: string,
  source: "user" | "project",
  index: number,          // 该条在它自己那份文件里的序号
  exitCode?: number,      // 起不来 / 超时 / 被信号杀：缺席
  blocked: boolean,       // 只有 preToolUse 的 exit 2 为 true
  stdout: string,         // 各截到 8000 字符，截断时末尾 `…[truncated]`
  stderr: string,
  failure?: string,       // 钩子本身没跑成；含 `hook #N (source) <command>` 前缀
  evidenceDropped?: true, // 仅「这段 stdout 被追加进正文且原结果主张 evidence」
  durationMs: number
}
```

已有 `detail` 时摊平合并（保留原键），不是普通对象时收进 `originalDetail`，没有则
新建——与 `mergeArtifactError` 同一写法。**没有配钩子时 `detail` 整个不出现。**

放行的 pre 钩子也留痕（`blocked: false, exitCode: 0`）：否则日志里看不出它跑过。

## 边界：`detail.hooks` 不进模型上下文

投影（`src/context/build.ts` 的 `tool_result` 分支）只取 `payload.text`。所以模型
实际能看到的只有两处：

1. `hook_blocked` / `hook_failed` 的**正文**（也就是上面表格里「模型看到什么」那列）；
2. post 钩子追加在正文里的 `--- hook: <command> ---` 段。

`detail.hooks` 只进会话日志与界面。这是刻意的：钩子的诊断信息（耗时、退出码、被截断
的 stdout）对一个排障的人有用，对模型是噪音——它已经拿到了「被拦下，理由是这段」。

## 界面

**没有钩子面板，也没有设置页。** 钩子结果通过两条既有通道到达界面：

| 通道 | 形态 |
|---|---|
| 工具行 | 有 `blocked` 或 `failure` 时，行下多一行说明（`被钩子拦截：<command>` / `钩子未跑成…`）。重开会话后仍在（回放读同一个 `detail`） |
| 状态 notice | `hooks_config_failed` → warn，带内核给的文件名与 `hooks[N]`；`hooks_project_config_skipped` → warn，说明是「未信任」而不是「坏了」 |

两条都**不新增事件类型**：钩子结果已经在 `tool_result.detail.hooks` 里，另起一种
事件是同一事实的第二份定义。

## 已知边界

| 边界 | 说明 |
|---|---|
| 钩子不参与并发判定 | 只读工具会并发执行，钩子对每个调用各跑一次；钩子本身在**一次调用内**串行。加个钩子不会让并发失效，也不会让钩子之间有序 |
| 钩子只能收紧，不能放行 | 接在权限层之后，结构上没有放行的位置 |
| 钩子不能改写入参、不能替换结果 | 见上文「不做」表 |
| 钩子的输出不进模型上下文 | 进上下文的是被追加进正文的那一段；`detail.hooks` 不进 |
| 桌面形态不加载项目级钩子 | 宿主不传 `trustProjectConfig`，也没有信任入口；只能看到 `hooks_project_config_skipped` |
| 坏掉的配置不阻止运行 | 钩子是加固，不是运行的前提。一个坏掉的 `hooks.json` 发一条 status 就继续跑 |
| 钩子的 env 是最小集 | 没有 `inheritEnv`；密钥永远进不去 |
| 输出上限 8000 字符 | stdout / stderr 各自截断，末尾标 `…[truncated]`（R3：不许把不完整的说成完整的） |
| 超时用 `signalProcessTree` 收进程 | 与后台终端共用同一份（D-229），没有第二份杀进程实现。发信号不等于进程已消失 |
| 没有 POSIX 实测 | 本仓库只在 Windows 上跑过；`detached` 与 `PATHEXT` / `COMSPEC` 的缺席未在 POSIX 上验证 |

## 状态事件

内核在 `runSession` 里读配置，两种结果各发一条 `status`（都**不阻止运行**）：

| status | 何时 | `message` | 界面 |
|---|---|---|---|
| `hooks_config_failed` | 文件读到但 JSON 坏 / schema 坏 / 不可读 | `HookConfigError.message`（含路径与 `hooks[N]`） | warn notice |
| `hooks_project_config_skipped` | 项目级文件存在但未信任 | 被跳过的绝对路径 | warn notice |

没有 `hooks.json` 时两条都不发——零新事件。

## 写一条钩子的最小例子

拒绝所有 `shell` 里含 `rm -rf` 的调用：

```js
// deny-rm.mjs
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const { tool, input } = JSON.parse(raw);
if (tool === "shell" && String(input?.command ?? "").includes("rm -rf")) {
  process.stderr.write("这个工作区不允许 rm -rf：请删具体的构建目录");
  process.exit(2);
}
process.exit(0);
```

```jsonc
// $HARNESS_HOME/hooks.json
{
  "version": 1,
  "hooks": [
    { "event": "preToolUse", "matcher": "shell", "command": "node", "args": ["C:/hooks/deny-rm.mjs"] }
  ]
}
```

模型会收到那条 stderr 作为工具结果正文；界面上的工具行多一行「被钩子拦截：node」。
