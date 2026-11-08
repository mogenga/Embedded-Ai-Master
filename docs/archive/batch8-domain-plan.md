# 批次 8 · 领域能力补齐 —— 实施计划（2026-11-08）

> 来源：`docs/BACKLOG.md` 批次 8。用户选定范围：「四项（推荐）」——8.1 / 8.2 / 8.3 / 8.5。
> 8.4（KB 拒答实测）与 8.6（整片擦除）本轮不开工，理由见文末。

## 事实依据（2026-11-08 实测）

| 事实 | 证据 |
|---|---|
| 本机**没有**可用的 Keil：注册表 `HKLM\SOFTWARE\WOW6432Node\Keil\Products\MDK` 只有 `Version = V5.24a`，**没有 `Path`**；`C:\Keil_v5`、`G:\software\keil5`、`D:\Keil_v5` 均不存在 | 注册表查询 + 目录存在性检查 |
| 仓库里**没有任何一份真实 UV4 构建日志**（`.log` 文件零命中） | `find . -name "*.log"` 只命中 node_modules |
| 因此 8.2 的解析器只能按 **ARMCC/ARMCLANG 文档化的输出格式**写，并用自造夹具测；真实日志能否被它解析**本轮无法证明** | — |
| `DESTRUCTIVE_ACTIONS`（36 项）与 `READONLY_ACTIONS`（28 项）覆盖 71 个动作里的 **65 个**，另有 **6 个两边都没有**：`open` / `halt` / `evaluate` / `trace` / `trace_set` / `window` | 探针脚本扫 `actions.ts` 的两个集合 |
| `READONLY_ACTIONS` 是**死代码**：全仓零消费点 | `grep -rn READONLY_ACTIONS` 只命中定义行 |
| keil 的 `meta` 里已经有 `destructiveActions`，但**内核不读**：`src/mcp/manager.ts` 只取 `readOnlyHint` / `destructiveHint` / `_meta.evidence` 三项 | `src/mcp/manager.ts:679-686` |
| `verifyFlash` 的单次窗口被 `readMemory` 的 `0x2000` 钳住，大镜像永远是 `spot` | `mcp-servers/keil/keilSession.ts:1272`、`:1790`、`:1864` |
| `kb_search` 返回 `found` / `hits` / `scanTruncated`，**没有** `count` / `truncated`；而 `kb_grep` / `kb_glob` 都有 | `mcp-servers/kb/service.ts:718-764` vs `:643`、`:616` |
| `mcp-servers/serial/` 下没有任何 `permissions.example.json` | 目录清单 |
| `mcp-servers/embedded/permissions.example.json:37` 写 `mcp__embedded__embed_pack`，真实工具名是 `embed_packs` | `mcp-servers/embedded/server.ts:106` |

---

## 约束（每个任务的 brief 都原样带着）

- **禁止任何依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。需要装东西就停下来报告。
- **禁止在宿主机真实执行危险命令做测试**；危险命令用例只能靠纯函数断言或注入 mock 制造 RED。
- **子代理不得执行任何 git 写操作**（`add` / `commit` / `reset` / `checkout` / `stash` / `switch` / `branch` / `worktree` / `merge`）。只读的 `git status` / `git diff` / `git log` 可以。
- **写文件只用 Write/Edit 工具**，不要用 `node -e` / `bash -c` 拼含反引号或 `$()` 的文本。
- 不得调大 `vitest.config.ts` 的超时，不得删改既有断言。
- **涉及权限语义的改动必须 fail-closed**：拿不准的动作归 `unknown`（`diagnose` 预设下 deny），不能归 `read`。

---

### Task 1 · Keil 整镜像分段回读（8.1 / D-223）

**问题**：`verifyFlash` 一次只读 `min(requestedBytes, 0x2000, 剩余)` 字节并比较，大于 8192 字节的镜像永远是 `scope: "spot"`。镜像后段损坏（烧录中途掉电、flash 坏块）不会被发现。

**目标**：`count` 请求超过 8192 时，按 `0x2000` 分段循环读回**整张镜像**并逐段比较；新增 `scope: "segmented-full"`；中途任一段失败要如实说明「已比到第几段」。

**改动面**：`mcp-servers/keil/keilSession.ts`（`verifyFlash`）、`mcp-servers/keil/tools.ts`（flash 分支的 `verifyBytes` 钳位与 `flashVerify` 结构化字段）、`mcp-servers/keil/tests/flash-verify.test.ts`。

**实现要求**

1. `FLASH_VERIFY_MAX_BYTES`（0x2000）保留原名与值，语义从「总上限」改成**单段上限**；注释必须改写，不能留下与新行为矛盾的旧说明。
2. `verifyFlash` 的新语义：
   - `requestedBytes <= 0x2000`：行为与今天**逐字节相同**（`spot` / `full` 的判定不变，既有 6 条测试一行不改）。
   - `requestedBytes > 0x2000`：从镜像最低地址起，按连续段（遇地址空洞就停，与今天的「连续段」口径一致）分段读，每段 ≤ `0x2000`。
   - 全部段都比完且覆盖了整张镜像 → `scope: "segmented-full"`。
   - 只覆盖了一部分（遇到空洞、或段数被预算截断）→ `scope: "spot"`，`detail` 写明比到第几段、共多少字节。
   - 任一段读回失败 → `scope: "none"`，`bytes` 报告**已经比对成功的字节数**（不是 0），`detail` 说明「第 N 段读不回」。**不得**把部分结果报成成功。
   - 任一段内容不匹配 → `ok: false`，`detail` 给出全局字节偏移（不是段内偏移）。
3. **时间预算**：每段一次 `readMemory`（内部 12 s 超时）。整次回读加一个总预算 `FLASH_VERIFY_BUDGET_MS = 60_000`；超预算就停止继续读，按「部分」处理（`scope: "spot"` + 说明）。预算常量导出，测试用注入的时钟或小镜像避免真的等 60 s。
4. `FlashVerifyResult` 增加 `segments?: number`（实际读过几段）。`requestedBytes` / `imageBytes` 语义不变。
5. `tools.ts` 的 flash 分支：删掉 `Math.min(FLASH_VERIFY_MAX_BYTES, ...)` 钳位（那是旧语义），`count` 直接传给 `verifyFlash`；`flashVerify` 结构化字段补 `segments`；`scope` 的三态判断加 `segmented-full` 的文案（`"whole image (segmented)"` 之类），**不能让分段全量读在界面上看起来和抽检一样**。
6. `actions.ts` 的 `DEBUG_DESCRIPTION` 与 `tools.ts:462` 的 `count` 参数说明都要改：不再说「max 8192」，改成「默认 64；更大时按 0x2000 分段读完整张镜像」。

**测试**（`flash-verify.test.ts` 追加，既有 6 条不改）

| 用例 | 断言 |
|---|---|
| 32 KiB 镜像 + `count: 32768` | `scope: "segmented-full"`、`bytes === 32768`、`segments === 4`、`ok: true` |
| 同上但第 3 段有一字节损坏 | `ok: false`，`detail` 里的偏移落在第 3 段的全局位置上 |
| 第 2 段读回失败 | `scope: "none"`、`bytes` 是第 1 段成功的字节数、`detail` 说明第 2 段读不回 |
| 镜像中间有地址空洞 | 停在空洞处，`scope: "spot"`，`detail` 说明只覆盖到空洞前 |
| `count` 超过镜像长度 | 不比镜像外的地址，`scope` 仍是 full 或 segmented-full 之一，`bytes === imageBytes` |
| 请求 5000（< 0x2000） | 与今天完全一致（回归，不应出现 `segmented-full`） |

**验收**

```bash
npx vitest run mcp-servers/keil/tests/flash-verify.test.ts
npm run typecheck
```

---

### Task 2 · Keil 工具面读写分拆（8.3 / OPT-21）

**问题**：`keil_debug` 与 `keil_project` 在 MCP 上都只标 `destructiveHint: true`，于是 `diagnose` 预设下**连读一个寄存器都要审批**。`READONLY_ACTIONS` 早就写好了 28 个只读动作，`meta.destructiveActions` 也已经在发，但**内核不读**——`src/mcp/manager.ts` 只取 `readOnlyHint` / `destructiveHint` / `_meta.evidence` 三项，`ToolDef.access` 对 MCP 工具从未被设置。

**目标**：MCP 工具可以按**本次输入**决定读写；keil 的只读动作在 `diagnose` 预设下直接放行，破坏性动作仍然审批。

**改动面**：`src/mcp/manager.ts`、`src/mcp/tools.ts`，以及**由控制器单独完成**的一行 `mcp-servers/keil/tools.ts`（往 `meta` 里补 `readOnlyActions`——这行已经加好，你不需要动 `mcp-servers/`）。

**实现要求**

1. `src/mcp/manager.ts` 的 `McpToolInfo` 增加 `readOnlyActions?: string[]` 与 `destructiveActions?: string[]`；`loadTools` 从 `tool._meta` 读取，**只接受字符串数组**，其他形状忽略（不抛错——一个坏 server 不该让整个工具面消失）。
2. `src/mcp/tools.ts` 生成的 `ToolDef` 增加 `access(input)`：
   - 两个白名单都缺失 → 不声明 `access`（保持今天的注解行为，零行为变化）；
   - 取 `input.action`（字符串）：
     - 在 `destructiveActions` 里 → `"write"`
     - 在 `readOnlyActions` 里 → `"read"`
     - **两边都在** → `"unknown"`（fail-closed，并写注释说明为什么不选任何一个）
     - 都不在 / 没有 `action` 字段 / `action` 不是字符串 → `"unknown"`
3. **不要**因为 `access` 存在就改 `annotations`：`annotations.destructive` 仍然照旧（它描述的是「这个工具可能有破坏性」，是给 UI 和策略表看的）；`access` 描述的是「这一次调用是哪种」。两者同时存在时 `src/permissions/policy.ts` 的 `toolAccess` 优先用 `access`——那是既有行为，读一遍 `policy.ts:74-87` 确认后再动手。
4. **动作分类的补全**（`mcp-servers/keil/actions.ts`，**控制器已经做完了，你不用动这个文件**）：
   - 新增 `STATEFUL_ACTIONS` = `open` / `halt` / `evaluate` / `trace` / `trace_set` / `window`。这六个既不是只读，也不对应「向目标写入什么」，所以**没有**塞进 `DESTRUCTIVE_ACTIONS`——那个集合的契约是「每条都必须能给出 `declaration`」，由 `tools.test.ts` 的「每个破坏性动作都有写前声明」钉着，塞进去会让那条测试红。
   - `mcp-servers/keil/tools.ts` 的 `meta.destructiveActions` 现在是 `[...DESTRUCTIVE_ACTIONS, ...STATEFUL_ACTIONS]`，`meta.readOnlyActions` 是 `[...READONLY_ACTIONS]`。所以你的内核实现看到的是**两份不相交的白名单**，加起来覆盖 71 个动作里的全部 71 个——不存在「两边都不在」的动作。

**测试**（新增 `tests/mcp-tool-access.test.ts`）

| 用例 | 断言 |
|---|---|
| 只有 `action` 在 `destructiveActions` | `access({action})` 返回 `"write"` |
| 只有 `action` 在 `readOnlyActions` | 返回 `"read"` |
| `action` 两边都在 | 返回 `"unknown"` |
| `action` 两边都不在 / 缺 `action` / `action` 是数字 | 返回 `"unknown"` |
| 两个白名单都缺失 | 生成的 `ToolDef` **没有** `access` 属性（`"access" in tool === false`），注解行为与今天一致 |
| `_meta` 里的数组含非字符串 | 忽略该项，其余字符串仍然生效（不抛错） |
| 端到端（用 `evaluatePolicy`） | `diagnose` 预设下：`action` 为只读 → `allow`；为破坏性 → `ask`；为未知 → `deny` |

**验收**

```bash
npx vitest run tests/mcp-tool-access.test.ts tests/permissions-policy.test.ts
npm run typecheck
```

---

### Task 3 · 领域小项四件（8.5 / OPT-43）

四个互不相关的小口子，一起做完。

**改动面**：`mcp-servers/kb/service.ts` + `mcp-servers/kb/tools.ts`、`mcp-servers/serial/permissions.example.json`（新建）、`mcp-servers/embedded/permissions.example.json`。**不要动 `mcp-servers/keil/`**。

**3a · `kb_search` 补 `count` / `truncated`**

- `KbSearchResult` 增加 `count: number`（真实命中总数，可以大于返回条数）与 `truncated: boolean`（`hits` 被 `limit` 截了）。
- 实现要求与 `kb_grep` **同一口径**（读 `service.ts:643-715` 的注释：`count` 要报真实总数，但**不为此把每一行都留在内存里**——超过返回上限就只计数、不再保存文本）。
- `kb_search` 的 `description` 补一句 `truncated: true` 的语义（与 `kb_read` / `kb_grep` 的措辞一致：被截了就要收窄或加 limit，不要当成「只有这些」）。
- 既有 `found` / `hits` / `scanTruncated` 语义不变。

**3b · serial 权限模板**

- 新建 `mcp-servers/serial/permissions.example.json`，结构对齐 `mcp-servers/probe/permissions.example.json`（先读它）。
- `embed_serial` 一个工具，但动作分读写：`read` 只读；`write` 与 `open` / `close` 是破坏性。模板默认 `preset: "diagnose"`，把 `read` 放行、其余 `ask`，并在 `reason` 里说明「可仿照 probe 示例按端口白名单收窄为 allow」（与 embedded 模板的措辞保持一致）。
- **必须验证模板能被真实加载**：`src/permissions/` 里读模板的那条路径能被 `loadPermissions` 解析通过。写一个测试，用 `loadPermissions`（或等价的 zod 校验）加载这份新模板，断言规则数与动作名。

**3c · embedded 模板错名**

- `mcp-servers/embedded/permissions.example.json:37` 的 `mcp__embedded__embed_pack` 改成 `mcp__embedded__embed_packs`。
- 顺带核对整份模板的工具名与 `mcp-servers/embedded/server.ts:100-107` 的清单**逐一对应**（现在有 7 条规则、8 个工具——`embed_identify` 缺一条）。补齐缺的那条（只读，`allow`），并在测试里断言「模板里的工具名 ⊆ 真实工具名」且「真实工具名 ⊆ 模板工具名」。

**3d · keil 错误码词表**

- 现状：`mcp-servers/keil/tools.ts:1402` 的 `failResult` 只对**抛异常**这一条路给了 `code: "keil_error"`；正常返回的 `isError: true` 结果（`failure` 变量那条路）在结构化结果里**没有 `code`**，调用方无法按码分支。而 probe / kb / serial 的失败结果都带 `code`。
- 加一个最小的错误码词表（`mcp-servers/keil/errors.ts` 或 `actions.ts` 里的一段，你自己选，但**只能有一处定义**），至少覆盖：`keil_error`（内部异常）、`keil_not_installed`、`keil_unsupported_action`（`UNSUPPORTED_ON_MDK_5_43` 命中）、`keil_not_debugging`、`keil_erase_unavailable`、`keil_verify_failed`、`keil_build_failed`、`keil_action_failed`（其余 `failure` 路径的兜底）。
- `fail(...)` 那条路要把码带进 `structuredContent.code`；**不能**只改文本。
- **不要**为了配码而改任何一条失败文案的措辞——文案已经有测试和文档引用。

**测试**

| 用例 | 断言 |
|---|---|
| `kb_search` 命中数 > limit | `count` 是真实总数、`truncated: true`、`hits.length === limit` |
| `kb_search` 命中数 ≤ limit | `truncated: false`、`count === hits.length` |
| serial 模板 | `loadPermissions` 能加载；`embed_serial` 的 read 规则是 allow、write 是 ask |
| embedded 模板 | 工具名与 `server.ts` 清单双向相等；`embed_packs` 拼写正确 |
| keil 错误码 | 至少两条路径（未安装、未知动作）的 `structuredContent.code` 是词表里的值；其余失败路径的 `code` 非空 |

**验收**

```bash
npx vitest run mcp-servers/kb/tests mcp-servers/serial/tests
npm run typecheck
```

---

### Task 4 · Keil 构建诊断结构化（8.2 / D-200）

> **这一项的前提必须先说清**：本机没有可用的 Keil，仓库里也没有一份真实 UV4 构建日志。下面的解析规则来自 **ARMCC / ARMCLANG 的文档化输出格式**，不是实测样本。做的价值是「模型不必自己从日志里刮」+「同一根因只报一次」；**不能**宣称它已在真实工程上验证过。

**问题**：`build` / `rebuild` 失败时只回传日志原文与 `UVBUILDCODES`。模型要自己刮文件名与行号，长日志还会挤占上下文。

**改动面**：新建 `mcp-servers/keil/diagnostics.ts`（纯函数，零 I/O），`mcp-servers/keil/tools.ts` 的 build 分支，新增 `mcp-servers/keil/tests/diagnostics.test.ts`。

**要解析的形状**（ARMCC 与 ARMCLANG 两代，都要覆盖）

```
..\USER\main.c(36): error:  #20: identifier "HAL_Init" is undefined
..\USER\main.c(36): warning:  #177-D: variable "x" was declared but never referenced
..\USER\app.c(12): error:  #5: cannot open source input file "foo.h": No such file or directory
Error: L6218E: Undefined symbol HAL_Init (referred from main.o).
.\Objects\demo.axf: Error: L6218E: Undefined symbol foo (referred from bar.o).
```

**实现要求**

1. 纯函数 `parseDiagnostics(log: string): Diagnostic[]`，`Diagnostic = { file?: string; line?: number; severity: "error" | "warning"; code?: string; message: string; raw: string }`。
   - 文件:行号两种写法都认：`file(line)` 与 `file:line`（**复用 `keilSession.ts` 已有的 `parseFileLine`，不要写第二份**）。
   - 编译器码形如 `#20` / `#177-D`；链接器码形如 `L6218E`；解析不到就留空。
   - 反斜杠路径归一为 `/`（与 `parseFileLine` 一致）。
2. `collapseCascades(diagnostics)`：一条根因引发的多条**链接错误**折叠成一条。判据必须窄——只折叠「同一条 `L6218E` 且它引用的目标与前面某条 error 的消息重复」的情形；**编译器错误一律不折叠**。折叠掉的条数要在结果里计数（`collapsed: number`），不许静默丢。
3. `tools.ts` 的 build 分支：失败时先追加结构化诊断（最多前 20 条，超出说明「还有 N 条」），再追加**原有的日志原文尾部**（保留既有 60 行的行为）。成功时行为不变。
4. 诊断要有 `detail` / `structuredContent` 出口（`buildDiagnostics`），让调用方不必解析文本。字段与 `flashVerify` 同级放在 `structured` 里。
5. **零 I/O、零依赖**。不读文件、不 spawn。

**测试**

| 用例 | 断言 |
|---|---|
| ARMCC 的 `error: #20` | `file` / `line` / `code` / `severity` 全部正确 |
| ARMCLANG 的 `warning: #177-D` | `severity: "warning"`、`code: "#177-D"` |
| 反斜杠路径 | 归一为 `/` |
| 同一根因引起的 3 条 `L6218E` | 折叠成 1 条，`collapsed === 2` |
| 编译器错误不折叠 | 3 条编译器错误仍是 3 条 |
| 日志里混着 `Build target` / `Program Size` 等非诊断行 | 不进 `Diagnostic[]`，也不影响解析 |
| 空日志 / 只有噪声 | 返回 `[]`，不抛错 |
| 一条 `file(line)` 出现在别的路径里（例如消息正文引用） | 不误判（用行首锚定） |

**验收**

```bash
npx vitest run mcp-servers/keil/tests/diagnostics.test.ts mcp-servers/keil/tests/tools.test.ts
npm run typecheck
```

---

## 不做的那两项

| 项 | 为什么不做 |
|---|---|
| 8.4 KB 拒答扩展到 `kb_grep` / `kb_glob` 并重测拒答率 | 语料与 25 条负样本都在本地，判据也可复用 `regression.test.ts` 的负样本轨。但台账 D-179 **明写「不要未测先调阈值」**，而「只出数字不设阈值」这件事没有验收对象——这一项要么落到一个阈值（需要评测协议），要么就是一次性的测量报告。用户本轮选了四项，这一项留到有评测协议时再做 |
| 8.6 整片擦除（非 ST 芯片走厂商 CLI，或明确只支持 STM32） | 需要外部 CLI 与真实硬件才能验证；`mcp-servers/keil` 当前**已经如实说明**「整片擦除不可用」（`FLASH_ERASE_LIMITATION`，README 与操作手册都有）。剩下的是能力扩展，不是缺陷修复 |

---

## 顺序与并发

- **Round A（并行）**：Task 1（`mcp-servers/keil/keilSession.ts` + `tools.ts` 的 flash 分支 + `flash-verify.test.ts`）、Task 2（**只动 `src/`**）、Task 3（`mcp-servers/kb`、`serial`、`embedded`）。
- **Round B（单独）**：Task 4（新建 `diagnostics.ts` + `tools.ts` 的 build 分支）。它与 Task 1 同处 `tools.ts`，必须串行。
- 子代理只写工作区、不做任何 git 写操作；每个任务由控制器单独提交并复核。
