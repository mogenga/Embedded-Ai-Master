# 系统提示词组装设计草案

> 版本: v0.2（骨架**已评审**，未开始实现） · 日期: 2026-11-01
> 触发: 用户问「当前主 Agent 的提示词是什么」，核实结果见 [deferred-issues.md](deferred-issues.md) **D-221**——内核没有内置系统提示词，请求体里 `messages` 直接以 `user` 开头。
> 定位: 关闭决策点 #8（`docs/framework-architecture-inventory.md:57`「分节组装(基础 / persona / 环境信息 / 工具说明)、personaPrefix 注入、指令冲突消解」）与 BRD **PLAT-6**（「系统提示词分节组装与冲突消解」）的设计稿。
> **本文只定分节、职责、注入时机与冲突规则，不写具体措辞。** 措辞属于产品决定，应在分节骨架评审通过后单独出稿。
>
> **v0.2 变更（2026-11-01 评审结论）**：Q1–Q6 六项全部拍板，见 §7.1。两处与 v0.1 实质不同：① **git 信息移出环境段**（§2.2，转待定项 T1——面向嵌入式开发，git 是否必要本身待议）；② **提示词哈希改写 `meta.json`**，不新增会话事件（§3.1）。`instructions` 节改为只读 `AGENTS.md` 并加 32 KiB 上限（§2.4）。**未开始实现。**

---

## 0. 结论先行

| 项 | 决定 | 理由 |
|---|---|---|
| 载体 | **投影期注入**，不写会话日志 | 避免全部历史会话触发 `system_prompt_mismatch`（`src/index.ts:372`），且已有同构先例（压缩摘要，`src/context/build.ts:322-328`） |
| 分节 | 六节：`base` / `environment` / `tools` / `instructions` / `memory` / `summary` | 见 §2；Claude Code 的八节里，`tone` 与 `doing tasks` 合并进 `base`，`harness` 并入 `base` |
| 顺序 | 固定的，且**按稳定性降序** | prompt cache 以稳定前缀为命中条件；越不常变越靠前（D-091 已登记压缩打断缓存） |
| 冲突 | 后节不得覆盖前节；同一 key 重复注册**抛错** | PLAT-6 原文「提示词段冲突必须显式报错而非静默失效」 |
| 空节 | **整节省略**，不留空标题 | 空标题会消耗 token 并让模型读到「这里本该有内容」的假承诺 |
| 用户 `systemPrompt` | 进 `instructions` 节**末尾**，排在项目指令之后 | 现设置页文案说「排在内置指令之前」，那会让用户无法覆盖默认行为；见 §6 |
| 项目指令文件 | **只读 `AGENTS.md`**，32 KiB 上限 | 七个 harness 里四个用它；本仓库自己也在用。见 §2.4 |
| git 信息 | **不写**（暂不支持） | 内核没有 git 工具，界面也没有；面向嵌入式开发是否需要 git 本身待议。见 §2.2 与 T1 |
| 提示词哈希 | 写 **`meta.json`**，不新增会话事件 | `EVENT_TYPES` 是读取时白名单，漏登记会让整份日志不可用。见 §3.1 |

---

## 1. 现状与要解决的问题

### 1.1 实测基线

一轮全新会话的真实请求体（`dist/` 直接抓取，见 D-221）：

```json
{
  "model": "...",
  "messages": [{ "role": "user", "content": "hi" }],
  "max_tokens": ..., "stream": true, "stream_options": { "include_usage": true },
  "tools": [ ... 12 个内置 + 7 个 kb ... ]
}
```

- `messages` 里 **0 条 `system`**。
- 模型能看到的全部「指令」是工具 `description`：内置 795 字符 + kb 1682 字符 = **2477 字符**。
- **`cwd`、`platform`、shell 类型全部不在请求里**——`cwd` 只存在于 `header.json`，从不发给模型。

### 1.2 已观测到的代价

真实会话 `~/.harness/sessions/715f0aba-…/session.v1.jsonl`（2026-10-25，用户输入「长思考」）：

| # | 调用 | 目的 |
|---|---|---|
| 1 | `mcp__kb__kb_status` | 猜这是哪儿 |
| 2 | `ls` | 猜工作目录 |
| 3 | `mcp__kb__kb_glob "**/*.md"` | 猜知识库 |
| 4 | `mcp__kb__kb_lookup "当前任务 上下文 待办"` | 猜用户要什么 |
| 5 | `shell "ls -la; file ... \| xxd \| head"` | **Unix 语法 → `exit=255`** |
| 6 | `shell "cmd /c dir"` | 靠报错才试出是 Windows |

前 4 次调用全部用于确定环境。第 5 次失败是因为 `spawn(..., {shell: true})` 在 Windows 上走 `COMSPEC`＝`cmd.exe`（已实测确认），而工具描述里没有一个字说明这一点。

同会话 `todo_write` 调用 **0 次**——尽管 `todo_write` 的描述里写着「多步骤任务开始时先列出计划」。

### 1.3 三处文案与实现矛盾（D-221 已登记）

| 位置 | 文案 | 实际 |
|---|---|---|
| `src/server/runner.ts:47` | `Replaces the built-in system prompt for this run.` | 没有可替换的东西 |
| `desktop/renderer/settings-i18n.js:305/791` | 「会加在每段新对话的最前面，**排在内置指令之前**。留空使用**默认提示词**。」 | 既无内置指令，也无默认提示词 |
| `src/config/app-config.ts:39` | 「系统提示词；`\"\"` 表示用内核默认提示词。」 | `\"\"` 在宿主被翻成「不发这个字段」（`host.js:788`），内核不追加任何 `system` 事件 |

---

## 2. 分节骨架

六节，按**稳定性降序**排列。稳定 = 一个会话从头到尾不变。

```figure
┌───────────────────────────────────────────────────────────┐
│ 1 base          身份 / 做事方式 / 工具用法 / 谨慎执行     │ 会话内恒定
├───────────────────────────────────────────────────────────┤
│ 2 environment   cwd / platform / shell / date             │ 会话内恒定
├───────────────────────────────────────────────────────────┤
│ 3 tools         工具使用准则（补描述，不重复描述）        │ 会话内恒定
├───────────────────────────────────────────────────────────┤
│ 4 instructions  AGENTS.md / 用户 systemPrompt             │ 会话内恒定
├───────────────────────────────────────────────────────────┤
│ 5 memory        $HARNESS_HOME 记忆文件                    │ 会话内恒定
├───────────────────────────────────────────────────────────┤
│ 6 summary       [Conversation summary]（压缩后才有）      │ 会话中会变
└───────────────────────────────────────────────────────────┘
   稳定 ───────────────────────────────────────────────► 易变
```

### 2.1 `base` — 身份与行事准则

**职责**：模型是谁、在为一个什么产品工作、基本行为约定。

对应 Claude Code 的 `Identity` + `Tone and style` + `Doing tasks` + `Executing actions with care` + `Harness` 五节合并。

候选子项（**只列职责，不写措辞**）：

| 子项 | 要回答的问题 | 对应本项目哪个已知问题 |
|---|---|---|
| 身份 | 你是什么、为谁工作 | 现在全靠模型「Claude Code」的先验 |
| 语言 | 跟随用户语言 | — |
| 回应风格 | 简短、直接、`path:line` 引用 | 转录里的回答长度现在完全由模型决定 |
| 计划 | 多步任务先列计划再动手 | `todo_write` 0 次调用（§1.2） |
| 工具偏好 | 专用工具优先于 shell | 现在 `shell "ls -la"` 和 `ls` 并存 |
| 并行 | 无依赖的调用并行发 | 现在永远串行 |
| 谨慎 | 破坏性操作先说再做；用户拒绝即调整不原样重试 | 权限门会拦，但模型不知道自己该先问 |
| R3 诚实 | 工具失败必须如实报告，不得把失败说成成功 | BRD §8 的核心约束，目前只在工具实现层强制（失败返回错误码），模型侧无约束 |

> **R3 是这一节里最重要的一条。** 现在「诚实」只由工具实现层保证（读失败显式返回错误码），但模型拿到错误码后仍可能把它写成人话里的成功。`base` 是唯一能约束到模型那一侧的地方。

### 2.2 `environment` — 环境事实

**职责**：只写事实，不写口味。这是**收益/成本比最高的一节**，也是唯一不牵动「内置提示词该写什么文风」这个产品决策的一节。

字段（全部来自运行期，不来自日志）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `working directory` | `runCwd`（`src/index.ts:530` 续聊 / `src/index.ts:539` 新建） | 出口转 POSIX 风格（AGENTS.md 环境注意） |
| `platform` | `process.platform` → `win32` / `darwin` / `linux` | |
| `shell` | `COMSPEC`（Win）／`$SHELL` | **直接消掉 §1.2 那次 `exit=255`** |
| `date` | 会话创建日期 | 只到日，不写时刻（否则每轮都变，破坏缓存） |

**关键约束**：本节必须**在会话内恒定**。日期取会话创建日而非当前时间；会话中途发生变化的事实**不刷新**——刷新会让前缀失效，代价大于收益。若确有需求，走独立的「环境更新」消息追加在对话尾部，不进前缀。

#### git 信息：暂不写入（评审决定 2026-11-01）

草案初稿把 `is git repo` 与 `git branch` 列为环境字段。**评审决定先不写**，理由有三层：

1. **内核没有 git 工具。** `src/tools/` 的 12 个工具里没有 git，桌面端 git 全套也在 `desktop/MATRIX.md:64` 的隐藏清单里（「顶栏与面板已在 2026-10-22 整块删除」）。提示词里写一个界面上不存在的事实，模型会据此规划出用户看不见也做不到的动作。
2. **面向嵌入式开发，git 是不是必要项本身待议。** 这条比第 1 条更根本：调试一个 Cortex-M 目标的固件问题时，需要的是内存布局、寄存器值、串口日志、反汇编，而不是分支名。把 git 当作默认环境信息，是从通用编程助手的先例里继承来的假设，没有经过本项目需求的验证。
3. **即便将来要，也不该进恒定前缀。** 分支在会话中途切换是常见操作，写进前缀就只能在「信息准确」与「缓存命中」之间二选一。真要提供，走「环境更新」尾部消息。

**重启条件**（三条同时满足才考虑）：① 内核或 MCP 有了让模型可用 git 的能力；② 出现「模型因不知道分支而做错事」的实际案例；③ 嵌入式调试场景确实需要版本信息（例如同一份参考手册在不同固件版本下的差异）。**未满足前不要加。**

> 待决见 §7 待定项 T1。

### 2.3 `tools` — 工具使用准则

**职责**：跨工具的通用规则。**不得重复工具描述里已有的内容**——那会让同一件事有两个事实源，改动其中一个就产生矛盾。

允许在这里出现的是「跨工具才有意义」的规则：

| 规则 | 为什么不能放工具描述里 |
|---|---|
| 无依赖的调用并行发 | 单条工具描述没法表达「和别的工具一起」 |
| 专用工具优先于 `shell` | 同上，是工具间关系 |
| 读失败时先检查路径边界再重试 | 跨越 `read` / `ls` / `glob` / `grep` |
| `tool_result` 里 `truncated: true` 意味着还有内容 | 多个工具都有这个字段，且含义一致 |

**工具名与描述仍走 API 的 `tools` 参数**，不进系统提示词。理由：API 原生支持，模型对 `tools` 参数的注意力分配优于正文里的列表，且不影响本节长度。

### 2.4 `instructions` — 项目与用户指令

**职责**：来自工作区与用户的、可随时编辑的指令。

| 来源 | 位置 | 现状 |
|---|---|---|
| 项目指令 | `<cwd>/AGENTS.md` | **内核完全不读**（`grep -rn 'AGENTS.md' src/` 为空，`src/` 里没有一处读项目指令文件） |
| 用户系统提示词 | `run.json` 的 `systemPrompt` | 现在作为日志 `system` 事件写入（`src/index.ts:547`） |

#### 只读 `AGENTS.md`（评审决定 2026-11-01）

草案初稿写的是「`AGENTS.md` + `CLAUDE.md` 都读」。**评审改为只读 `AGENTS.md`。**

依据是跨工具调研表（`docs/harness-comparison.md:120`）里七个 harness 的项目指令文件名：

| 工具 | 指令文件 |
|---|---|
| Codex | `AGENTS.md`（32 KiB 上限） |
| opencode | `AGENTS.md` |
| goose | `AGENTS.md` |
| pi | 外化到文件 |
| Claude Code | `CLAUDE.md` |
| Gemini CLI | `GEMINI.md` |

四个用 `AGENTS.md`，只有 Claude Code 用 `CLAUDE.md`。而本仓库自己就在用 `AGENTS.md`（根目录同名文件），`AGENTS.md` 在契约里已经是事实源清单的一员（见该文件「事实源（先读这些，别猜）」一节）。再加一条 `CLAUDE.md` 回退，等于为一个小众先例引入第二个事实源：两份文件都在时，它们可能说了相反的话，而按顺序拼接产生的矛盾是最难在界面上解释的。

**大小上限**：草案初稿没有规定任何一节的字符上限，这是缺陷——D-198 已把同类问题登记过（「技能文件目前没有大小与数量上限，一个几 MB 的 `.md` 会被整段展开进提示词」）。`instructions` 读的是用户工作区里的文件，风险一模一样。采用 Codex 的 **32 KiB**上限，超限时截断并在界面上说明截断了（R3：被截断的指令不得读成完整指令）。

**本节是唯一的顺序反转点**：用户 `systemPrompt` 排在项目指令**之后**，让用户能覆盖项目默认。现设置页文案说的是「排在内置指令之前」（§1.3），那句话必须改——否则用户可以「补充」但永远无法「覆盖」。

**冲突规则**：本节内的条目按「后出现者优先」，并且在发生覆盖时**在界面上标注被覆盖的是哪一条**（与 D-198 里技能覆盖问题的处理原则一致，见该条修复建议 (b)）。

### 2.5 `memory` — 长期记忆

**职责**：`$HARNESS_HOME/memory/` 下的记忆文件。

**现状：整块不存在。** 核实过三件事：

| 检查 | 结果 |
|---|---|
| `grep -rn "memory" --include=*.ts src/` | **零命中** |
| `~/.harness/memory/` | **目录不存在**（`~/.harness/` 下只有 `corpus.json` / `kb/` / `mcp.json` / `providers.json` / `serial/` / `sessions/`） |
| `desktop/MATRIX.md` 隐藏清单 | memory / instructions / hooks 一起列在「内核根本没有这个能力」里 |

所以本节与 `instructions` 不同：`instructions` 缺的是「读文件」这一步（文件本身普遍存在、格式清楚），`memory` 缺的是**整套系统**——存什么、什么时候提取、怎么去重、注入多少、怎么防恶意仓库投毒。

本草案只确定它的**位置与顺序**（在 `instructions` 之后、`summary` 之前），内容形态留给待定项 **T2**。评审已确认「后续肯定是要有记忆系统的」，所以这个位置是有意预留的，不是占位符式的敷衍。

### 2.6 `summary` — 压缩摘要

**职责**：把压缩摘要从「插在最后一条 `system` 之后」改为「本节的固定位置」。

现状实现（`src/context/build.ts:322-328`）：

```ts
const lastSystemIndex = messages.findLastIndex((message) => message.role === "system");
messages.splice(lastSystemIndex + 1, 0, {
  role: "system",
  content: `[Conversation summary]\n${effectiveSummary.summary}`,
});
```

这段逻辑在没有 system 事件时，`lastSystemIndex` 为 `-1`，摘要被插到**索引 0**——也就是最前面。实测验证过（用户 'hi' + 摘要 + 'next' 三条事件，产出 `[system, user]`，且原文 `hi` 被摘要过滤掉了，符合预期）。

分节化之后，摘要的位置由节顺序决定，不再依赖「最后一条 system」这个脆弱的查找。

---

## 3. 注入时机与载体

### 3.1 决定：投影期注入，不写日志

```figure
┌──────────── 方案 A：写日志（现状）────────────┐
│ createSession(systemPrompt)                   │
│   └─► session.append({type:"system",...})     │
│         └─► buildMessages 原样投影            │
│                                               │
│ ✗ 老会话没有 system 事件                       │
│   → resume 时补写即抛 system_prompt_mismatch  │
│   → 全部历史会话续不了（已复现）               │
│ ✗ 改提示词 = 改日志 = 改历史事实               │
└───────────────────────────────────────────────┘

┌──────────── 方案 B：投影期注入（决定）────────┐
│ buildMessages(events, { systemSections })     │
│   └─► 投影日志事件（原样）                     │
│         └─► 在固定位置拼入各节                 │
│                                               │
│ ✓ 老会话无需迁移，一律可续                     │
│ ✓ 改提示词不动日志，历史保持原样               │
│ ✓ 与压缩摘要同一套机制（已有先例）             │
│ ✗ 日志不再完整描述「模型看到了什么」           │
└───────────────────────────────────────────────┘
```

**代价与它的处理**：项目的第一原则是「会话日志是唯一事实源」。方案 B 让「模型看到什么」不再 100% 可从日志重建。处理办法：

1. **系统提示词的每一节内容本身可重建**——`environment` 来自 `header.json`（已有 `workdir`）＋ 平台（不变）＋ 会话日期（`header.createdAt`），全部可从日志目录推出。
2. **在 `meta.json` 里记各节的哈希与长度**（评审决定 2026-11-01，见下）。这样「这次请求的 base 段和上次是否相同」可查。
3. 若将来要让日志完全自描述，可再加一个「按需展开」命令从哈希反查——但不在本草案范围。

#### 哈希记 `meta.json`，不新增会话事件（评审决定 2026-11-01）

草案初稿写的是「加一条 `prompt_sections` 会话事件」。**评审改为写 `meta.json`**，两个原因：

**① 新增事件类型的代价比看起来大。** `src/session/persistence.ts:29-49` 的 `EVENT_TYPES` 是**读取时**白名单，不是写盘过滤器：漏登记不会让写入失败，而会让**下一次读盘抛 `unknown_event_type`，整份日志（含早先写入的真实工具结果）一起不可用**。这一条在三个测试文件里各写了一遍（`tests/session-persistence.test.ts:839`、`tests/event-types.test.ts:105`、`tests/desktop/protocol.test.js:742`），说明它是踩过的坑。渲染器侧 `KNOWN_TYPES` 同理，漏了就是每条记录都变成「未识别的事件类型」警告。为一个调试用的哈希付这个代价不划算。

**② `meta.json` 是旁挂文件，本来就不进日志。** 它已经承载 UI 元数据（`title` / `pinned` / `archived` / `updatedAt`，见 `src/session/metadata.ts:20-25`），再加一个 `promptSections` 字段不改变任何既有语义，日志体积零增长。

**⚠️ 这个改动必须三处同时改，否则写入的内容会被静默丢弃。**

`src/session/metadata.ts:108-118` 的写入是：

```ts
const current = readSessionMeta(dir);
const next: SessionMeta = { ...current, updatedAt: new Date().toISOString() };
```

而 `readSessionMeta`（第 52-76 行）**只返回四个已知字段，未知字段一律丢弃**。所以若只改 `writeSessionMeta`，用户随便改一次会话标题，这个字段就没了——而且不会有任何报错。

三处：

| 位置 | 改什么 |
|---|---|
| `SessionMeta` 接口（`:20-25`） | 新增 `promptSections?: Record<string, {hash: string; chars: number}>` |
| `readSessionMeta` 解析（`:52-76`） | 校验并读回该字段 |
| `SessionMetaPatch`（`:27-32`） | 允许写入该字段 |

`writeSessionMeta` 的 `{...current}` 展开会在前两处改完后自动正确。

### 3.2 接口改动

```ts
// src/context/build.ts
export interface SystemSections {
  base?: string;
  environment?: string;
  tools?: string;
  instructions?: string;
  memory?: string;
  summary?: string;
}

export function buildMessages(
  events: readonly SessionEvent[],
  options?: { systemSections?: SystemSections },   // 新增，可选
): ModelChatMessage[]
```

**向后兼容**：第二个参数缺省时行为与现在完全一致（只投影日志里的 `system` 事件 + 压缩摘要）。这样 9 个调用点（`src/loop/query.ts:384/398`、`src/context/compact.ts:213/280`、`src/session/persistence.ts:389`、`src/session/session.ts:199/270` 等）可以先全部不动，逐个迁移。

**迁移顺序**：只有 `query.ts` 的两处需要传 `systemSections`（那是真正发请求的地方）。`compact.ts` 的两处**也应该传**——否则摘要器看到的对话缺少系统提示词，摘要会丢掉「模型本来知道的事」。`persistence.ts:389` 与 `session.ts:199/270` 的三处**不传**：它们做的是日志合法性校验与崩溃恢复判定，与「模型看到什么」无关。

### 3.3 环境段的数据来源

`environment` 需要 `runCwd`、平台、shell、会话日期。这些在 `LoopCtx` 里只有 `cwd`（`src/loop/query.ts:39`）。选项：

| 方案 | 做法 | 权衡 |
|---|---|---|
| **A（推荐）** | 在 `runSession` 里组装好 `systemSections`，经 `RunOptions` 传入 `LoopCtx` | 组装只有一个地方；`query` 不需要知道平台与 shell 从哪来 |
| B | 给 `LoopCtx` 加 `platform` / `shell` 字段，`query` 自己组装 | 字段扩散；`LoopCtx` 会开始承载与循环逻辑无关的环境事实 |

> 四个字段里只有 `cwd` 是运行期参数，其余三个（平台、shell、创建日期）在进程内是常量或来自 `header.createdAt`，所以 A 的组装成本几乎为零。

选 A。新增 `RunOptions.systemPromptSections?: Partial<SystemSections>`（内部用，宿主不填），`runSession` 组装 `base` + `environment` 后与调用方传入的 `instructions` / `memory` 合并。

---

## 4. 冲突与节内顺序

### 4.1 同一 key 重复注册 → 抛错

```ts
throw new PromptsConfigError(
  "duplicate_section",
  `system section "${key}" registered twice: ${firstSource} / ${secondSource}`,
);
```

对应 PLAT-6「提示词段冲突必须显式报错而非静默失效」。**不合并、不后者胜**——合并会产生一段谁也不认识的内容。

### 4.2 节内冲突 → 后者优先，但必须可见

`instructions` 节里项目指令与用户 `systemPrompt` 可能说相反的话。规则：

1. 后者优先（用户 > 项目）。
2. **冲突必须在界面上标注**：设置页在 `systemPrompt` 输入框下方列出「这一条覆盖了项目 AGENTS.md 的哪一段」。
3. 无法自动判定「是否冲突」时，只标注**两者都存在且顺序**，不声称检测到了冲突——那是未经验证的判断。

### 4.3 空节 → 整节省略

某节内容为空字符串时，**不输出标题**。理由：

- 空标题消耗 token；
- 更糟的是它告诉模型「这里本该有内容」，模型会去猜缺了什么（§1.2 里那 4 次探索就是这种行为的实例）；
- 与 `breakdown.ts` 的现有行为一致：空桶直接不进 `parts`（实测验证过，`systemPrompt` 桶为空时 `parts` 只有 `messages`）。

---

## 5. 与现有组件的关系

### 5.1 context breakdown（`src/context/breakdown.ts`）

`systemPrompt` 桶现在**永远是空的**（实测：`parts: [{"key":"messages","tokens":100}]`）。分节化之后它会第一次有内容，界面的分段条也第一次能显示「系统提示词占了多少」。

**订单确认**：不需要改 `breakdown.ts`。它按 `message.role === "system"` 分桶，分节化后 system 消息变多，自然进桶。

### 5.2 压缩（`src/context/compact.ts`）

压缩摘要会占用 `contextWindow × 0.6` 的字符预算（`maxChars`）。分节化后系统提示词固定占用一部分窗口，压缩阈值必须把它算进去。现在 `budget` 量的是 `buildMessages` 的产出，分节化后**自然包含**——只要 `compact.ts` 的两处 `buildMessages` 也传 `systemSections`（§3.2）。

**不传的后果**：压缩器看不到系统提示词，会低估占用，导致压缩触发过晚。

### 5.3 权限门（`src/permissions/`）

系统提示词**不参与权限判定**。`base` 里写「破坏性操作先说再做」只是劝说，真正的拦截仍在 `permissionGate`。这一点必须写进文案，避免用户以为提示词是安全边界（与 D-198「技能是提示词模板，不是权限单元」同一原则）。

### 5.4 技能（`src/skills/`）

技能正文经 `/name` 展开成一条**普通 user 消息**（`commands.js:expandSkill`），不走系统提示词。保持不变——技能是「用户主动调用的模板」，放进系统提示词会让它常驻上下文。

---

## 6. 用户 `systemPrompt` 的位置变更（破坏性）

**现状**：写入日志的 `system` 事件，位置在对话最前。
**草案**：进 `instructions` 节末尾，排在项目指令之后。

**这是行为变更**，需要：

1. 设置页文案改掉「排在内置指令之前」「留空使用默认提示词」（`settings-i18n.js:305/791`）。
2. `runner.ts:47` 的 `Replaces the built-in system prompt` 改掉。
3. `app-config.ts:39` 的「`\"\"` 表示用内核默认提示词」改掉。
4. 老会话：`run.json` 里已有的 `systemPrompt` 值，续聊时**不再触发 `system_prompt_mismatch`**——因为不再写日志。这是本方案顺带修掉 D-221 第二个缺陷的地方。

> 第 4 点是本草案最大的收益：一处改动同时关掉「没有内置提示词」与「填了就不能续聊」两个问题。

---

## 7. 决策与待定

### 7.1 已定（2026-11-01 评审）

| # | 问题 | 决定 | 落点 |
|---|---|---|---|
| Q1 | `base` 的措辞由谁定 | **骨架通过后单独出稿**，不照搬 Claude Code | §2.1；P1 |
| Q2 | git 信息是否进环境段 | **暂不支持，先不写**；嵌入式场景是否需要 git 本身待议 | §2.2「git 信息」；待定项 T1 |
| Q3 | 项目指令读哪些文件 | **只读 `AGENTS.md`**，不读 `CLAUDE.md`；32 KiB 上限 | §2.4；P2 |
| Q4 | `memory` 节是否本轮实现 | **后续一定要有记忆系统，但不是本轮**；本节只留位置 | §2.5；待定项 T2 |
| Q5 | 提示词哈希记在哪 | **写 `meta.json`**，不新增会话事件；三处（`SessionMeta` / `readSessionMeta` / `SessionMetaPatch`）同改 | §3.1；P0 |
| Q6 | 是否内置离线降级 | **不做**——内核里没有离线分支（`grep -rniE "offline\|离线" src/` 只命中语料发布与 packs 安装） | 不在任何一期 |

### 7.2 待定

| # | 待定项 | 卡在什么上 | 重启条件 |
|---|---|---|---|
| **T1** | `environment` 是否加 git repo / 分支 | 用户评审原话：「git 功能暂不支持，写入文档，待定，而且这是面向嵌入式开发，是否需要 git 还有待商榷」 | 三条同时满足：① 内核或 MCP 有了让模型可用 git 的能力；② 出现「模型因不知道分支而做错事」的实际案例；③ 嵌入式调试场景确实需要版本信息（如同一份参考手册在不同固件版本下的差异） |
| **T2** | `memory` 节的内容形态与提取时机 | 用户评审原话：「后续肯定是要有记忆系统的，待定」。内核目前**一行读记忆的代码都没有**（`grep -rn "memory" src/` 为空），`~/.harness/memory/` 目录也不存在 | 记忆系统立项时。那时要一并定：提取时机（自动 / 手动）、去重、注入预算、防恶意仓库（Claude Code 有专门防护，见 `harness-comparison.md:124`） |

### 7.3 本轮不做但需要记住的两条

草案核对代码时发现、评审未单独讨论，但都属于**必须在实现前补上**的项：

| # | 问题 | 处理 |
|---|---|---|
| **A1** | **所有节都没有大小上限** | 已补：`instructions` 采用 Codex 的 32 KiB（§2.4）。其余各节（`base` / `environment` / `tools`）由内核自己生成，长度可控；`memory` 待 T2 定义时一并定 |
| **A2** | **节序与「近因效应排序」的关系没说清** | 本草案选**稳定性降序**（越不常变越靠前），理由是 prompt cache 以稳定前缀为命中条件。代价是 `instructions` 的注意力权重低于按近因排序的做法。若实测发现模型忽略项目规则，把它往后挪的成本很低（只剩 `memory` / `summary` 在它后面） |

---

## 8. 实施分期（若评审通过）

| 期 | 内容 | 可否独立交付 | 依赖 |
|---|---|---|---|
| **P0** | `environment` 单节 + 投影期注入机制 + `meta.json` 哈希（三处同改）+ 三处文案修正 | **可**——直接消掉 §1.2 的 `exit=255` 类失败，且不触碰「写什么措辞」的产品决定 | Q5（已定） |
| P1 | `base` 节（身份 / 风格 / 计划 / 工具偏好 / R3） | 可 | Q1 的措辞稿（已定方向，稿未出） |
| P2 | `instructions` 节（只读 `AGENTS.md` 32 KiB + 用户 prompt 移位） | 可——顺带关闭 D-221 第二个缺陷 | Q3（已定） |
| P3 | `tools` 节 | 可 | — |
| P4 | `summary` 节并入节序 | 可 | — |
| — | `memory` 节 | **不可** | 待定项 T2 |

**P0 是唯一的必做项**：它不需要产品决定，且已有实测证据说明它的收益。

**P0 不含 git**：§2.2 的 git 字段已按评审移出，P0 的环境段只有 `working directory` / `platform` / `shell` / `date` 四项。

---

## 9. 验收口径

| 项 | 判据 | 怎么测 |
|---|---|---|
| 请求里有系统提示词 | 新会话的 `messages[0].role === "system"` | 抓真实请求体（D-221 用过的方法） |
| 环境段正确 | `platform` / `shell` / `workdir` 与实际一致 | 同上 |
| 老会话可续 | 配置了 `systemPrompt` 后 resume 成功 | 复现 D-221 脚本，断言不再抛 `system_prompt_mismatch` |
| 节序固定 | 同一会话两次请求的 system 段逐字节相同 | 连续两轮抓包对比 |
| 空节省略 | 无 `memory` 时不出现空标题 | 单测 |
| 冲突抛错 | 重复注册同一 key 时抛 `duplicate_section` | 单测 |
| breakdown 有内容 | `systemPrompt` 桶 `tokens > 0` | 单测（现有实测为 0） |
| 日志不膨胀 | 会话日志**零新增字节**（哈希写 `meta.json`） | 对比会话目录里 `session.v1.jsonl` 的体积 |
| 哈希不丢 | 改一次会话标题后，`meta.json` 里的 `promptSections` 仍在 | 单测：`writeSessionMeta({title:"x"})` 之后读回 |
| 指令文件上限 | 超过 32 KiB 的 `AGENTS.md` 被截断且**界面说明已截断** | 单测 + 渲染层 |

---

## 10. 不做的事

- **不做 persona 插件系统**。决策点 #10 是插件树，那是 M2.5 之后的事。本草案只定「六节 + 顺序」，插件挂载时替换某一节即可。
- **不做提示词热重载**。改了要重启会话，这在 §2.2 的「会话内恒定」约束下是必然的。
- **不做提示词版本号与 A/B**。没有评测集，A/B 的结论不可信（同 D-200 的教训：未测先调）。
- **不把工具描述搬进系统提示词**。见 §2.3。
- **不写 git 信息**。见 §2.2 与待定项 T1。
- **不读 `CLAUDE.md`**。见 §2.4；`AGENTS.md` 是七个 harness 里四个的共同选择。
- **不做离线降级分支**（Q6）：内核里没有离线模式，为不存在的模式写规格是给不会走的代码写文档。

---

## 附：与 Claude Code 的对照

从本机 v2.1.312 可执行文件静态提取的节标题（提取方法与原文见会话记录）：

```
# Tone and style
# Doing tasks
# Using your tools
# Executing actions with care
# Harness
# Environment
# Memory
# Instructions
```

映射到本草案：

| Claude Code | 本草案 | 差异 |
|---|---|---|
| （身份句）| `base` | 合并 |
| `# Tone and style` | `base` | 合并 |
| `# Doing tasks` | `base` | 合并 |
| `# Using your tools` | `tools` | 拆出独立节 |
| `# Executing actions with care` | `base` | 合并 |
| `# Harness` | `base` | 合并 |
| `# Environment` | `environment` | 同名但内容不同：本草案**额外写 shell**，**不写 git**（Claude Code 写 `Is a git repository` / `Git user` / `Recent commits`；按 Q2 移出，见 §2.2） |
| `# Memory` | `memory` | 同名 |
| `# Instructions` | `instructions` | 同名 |
| （压缩摘要） | `summary` | Claude Code 无对应节（它的压缩机制不同） |

**三处刻意不同**：

1. **`environment` 写 shell，不写 git。** Claude Code 反着来：它的 `# Environment` 里是 `Is a git repository` / `Git user` / `Recent commits`，shell 类型交给 `Bash` 工具的描述去说。本项目两边都要换——`shell` 工具描述只有一句「在 workdir 内执行 shell 命令(非沙箱,仅拦截已知高危命令)」，没说 workdir 是什么、底层是什么 shell，而这不是靠工具描述补得上的（§1.2 的 `exit=255` 就是代价）；git 则按 Q2 移出（内核没有 git 工具，嵌入式场景是否需要 git 待议）。
2. **合并五节为 `base`**：Claude Code 的五节服务的是它自己的产品定位（通用编程助手 + 多 worker 编排）。本项目的 `base` 只需要回答「你是谁 / 在这个产品里怎么做事 / 工具怎么用 / 什么时候先问」，独立成五节会让每节都很短，反而稀释注意力。
3. **`instructions` 只读一个文件名**：Claude Code 读 `CLAUDE.md`，本草案读 `AGENTS.md`（Q3）。理由见 §2.4。
