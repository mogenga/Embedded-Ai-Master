# M2 权限系统设计（PLAT-5 阶段 1）

> **注（2026-10-20 前端移植后）**：本 spec 的内核侧设计（策略规则、四个预设、管线接入、`permission_decision` 审计、审批通道）**已实现且仍然有效**；文中引用的 `src/ui/**` 前端文件与 `npm run test:ui` / `typecheck:web` / `build:web` 命令**已随 Preact 工作台整体删除**。当前前端的事实源是 `docs/frontend-design.md` v2.0 与 `desktop/MATRIX.md`，前端测试命令是 `npm run test:desktop`。

> 日期：2026-10-19 · 状态：待评审 · 上游：[m2-roadmap.md](../../m2-roadmap.md) 阶段 1 第 1 项、[BRD.md](../../BRD.md) PLAT-5 / R2 / R3、[p0-kernel-design.md](../../p0-kernel-design.md) §4。
> 本轮交付终点：策略规则模型、四个预设、管线接入（schema 校验后、execute 前）、`permission_decision` 审计事件、库层审批通道接口、headless `ask → deny`、配置加载与测试。不实现 Web 审批 API、SSE 与审批 UI。

## 1. 意图与为什么

P0 的工具管线在 schema 校验与 `execute` 之间留了权限占位，恒为 allow。M2 要把它变成真实的安全边界：LLM 决定调用什么工具，但“是否允许执行”由用户可配置的策略决定；写内存、复位、串口写等破坏性动作在无人值守时必须显式拒绝，而不是挂起等审批。

这是 BRD PLAT-5（工具级/参数级 allow-ask-deny）与 R2（写/复位前声明可审计）在框架层的落点，也是后续 BR-4（地址范围、串口端口白名单）与 Web 审批（阶段 2）的共同底座。权限层不是 OS 沙箱；shell 危险命令黑名单仍保留为第二道启发式拦截，二者互不替代。

已确认的产品决策（2026-10-19）：

- 默认预设 `diagnose`。
- 规则来源：用户级配置默认加载；项目级配置默认不加载，显式 trust 后生效。
- 参数级规则使用通用声明式谓词 `eq / glob / in / range`，不解析领域语义。
- 本轮只做阶段 1 权限引擎；Web 审批 API 与 UI 留到阶段 2。

## 2. 目标

1. 规则模型：`tool`（名称 glob）+ `params`（参数谓词 AND）+ `action`（allow/ask/deny）+ `reason`。
2. 预设：`read-only` / `workspace-write` / `diagnose`（默认）/ `danger-full-access`。
3. 管线接入：schema 校验成功之后、`execute` 之前判定；`deny` 绝不调用 `execute`。
4. `ask` 语义：有审批通道时等待用户决定；无通道、超时、取消或通道异常一律按 deny 处理，不挂起。
5. 审计：每次进入权限判定的调用写一条 `permission_decision` 会话事件，含工具、动作、最终结果、理由、预设、规则来源与参数摘要。
6. 配置：`~/.harness/permissions.json`（user）与 `<workdir>/.harness/permissions.json`（project，默认跳过）两级；支持 `RunOptions` 内联规则/预设覆盖；配置错误显式失败。
7. 测试：规则与预设的纯函数覆盖、管线“deny 不执行”断言、配置与审计事件覆盖，整体行覆盖率不低于既有 85% 阈值。

## 3. 非目标

- Web 审批 API（`POST /api/approvals`）、SSE `approval_request`、审批面板（阶段 2 / M3）。
- OS 级沙箱、shell AST 分析、网络隔离。
- 审批结果记忆（allow for session / always）与持久化授权。
- 规则热更新、多用户、企业托管策略。
- 领域参数语义（地址对齐、端口白名单、复位门禁）；BR-4 用本设计的谓词表达，不修改引擎。
- 事件总线与实时订阅（工作流 C）。

## 4. 反目标

- `ask` 在 headless 下挂起等待（Phase 0 事故模式）。
- `deny` 之后仍调用工具、`spawn` 子进程或触碰设备。
- 项目级配置在未 trust 时生效，让不可信仓库自行提权。
- 配置未知字段被静默忽略，导致规则看似生效实则失效。
- 审计事件记录完整参数原文或大块文件内容。
- 无匹配规则时默认 allow。
- 权限层被当作沙箱，替代 shell 黑名单或路径安全。

## 5. 约束

- TypeScript + Node 24，ESM-only，相对导入 `.js`，strict；不新增依赖，配置校验使用已有 Zod v4；测试用 vitest，默认离线。
- 依赖安装仍由用户手动执行；本设计不需要安装任何新依赖。
- 只改平台层 `src/`，不引入嵌入式领域逻辑。
- 工具身份使用注册后的最终名称（内置裸名、MCP `mcp__<server>__<tool>`）；命名稳定性沿用 D-100 修复后的确定性排序。
- 危险命令测试禁令：任何测试不得真实执行破坏性命令；权限拒绝用例用 mock `ToolDef.execute` 断言未调用。
- 日志是唯一事实源：审计事件必须进入会话日志；审计写失败时停止执行，不得出现“执行了但没有审计”的路径。

## 6. 规则模型

### 6.1 类型

```ts
export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionPreset =
  | "read-only"
  | "workspace-write"
  | "diagnose"
  | "danger-full-access";
export type PermissionSource = "inline" | "project" | "user" | "builtin";
// ToolAccess 定义在 src/tools/types.ts，避免 tools 与 permissions 的类型环。

export interface ParamMatcher {
  key: string;                                        // 点路径，如 "op" / "target.port" / "items.0"
  eq?: string | number | boolean | null;
  glob?: string;
  in?: Array<string | number | boolean | null>;
  range?: [number, number];                           // 闭区间，仅 number
}

export interface PermissionRule {
  tool: string;                                       // glob：* 任意串，? 单字符
  params?: ParamMatcher[];                            // 全部满足才匹配（AND）
  action: PermissionAction;
  reason?: string;
}

export interface PermissionConfig {
  version: 1;
  preset?: PermissionPreset;
  rules?: PermissionRule[];
  approvalTimeoutMs?: number;
}
```

### 6.2 匹配语义

- `tool`：整串匹配，大小写敏感；`*` 匹配任意长度（含 `__`），`?` 匹配单个字符；其余字符字面量。空串、长度超过 200 拒绝。
- `params`：`key` 按点路径读取 schema 校验后的输入（数组用数字段）；缺失视为不匹配。同一规则内多个 matcher 全部满足；每个 matcher 必须且只能提供一个操作符。`key` 非空、点分段均非空、总长 ≤ 200。
- `eq`：JSON 类型严格相等（`1` 不等于 `"1"`，`null` 只等于 `null`）；数值比较把 `-0` 归一为 `0`。
- `glob`：对字符串值整串匹配，规则同 `tool`；非字符串不匹配；`glob` 非空且 ≤ 200。
- `in`：数组非空，成员类型严格相等（同样归一 `-0`）。
- `range`：`[min, max]`，`min <= max`，仅接受有限 number；非 number 不匹配。
- 参数取 `safeParse` 之后的输出（含内置工具 schema 默认值），不匹配原始模型 JSON。
- **MCP 参数边界**：MCP 工具的 Zod schema 是 `z.unknown()`，`safeParse` 不应用 server 的 `inputSchema` 默认值或类型转换。参数规则只匹配模型实际提交的原始参数，不能依赖 server 端会补的默认值；需要按默认值判定时必须显式要求模型提供。该边界登记为已知限制。

### 6.3 求值顺序与优先级

1. 收集所有来源的规则，顺序固定为：`inline` → `project`（仅 trust 时存在）→ `user` → `builtin`（预设附带规则）。
2. 在所有匹配规则中按动作求值：**任一匹配的 deny 即 deny（deny 恒胜）**；否则任一匹配的 ask 即 ask；否则任一匹配的 allow 即 allow。
3. 同一优先级动作取顺序最靠前的一条作为理由与来源（`source` + `ruleIndex`）。`ruleIndex` 是合并后**全局**规则数组的下标：inline、project、user、builtin 依次拼接，从 0 开始；省略表示未命中任何规则。
4. 没有任何规则匹配时，使用预设的能力默认动作（见 §7），`source = "builtin"`、省略 `ruleIndex`、`reason = "preset:<preset>:<access>"`。
5. 规则命中时 `reason = rule.reason ?? "rule:<action>"`；内置 workspace-write 的 fs 写规则使用固定理由 `preset:workspace-write:fs-write`。
6. 规则可以放宽预设默认（例如 user 规则 allow `fs` 写），但不能推翻 deny（包括其他来源的 deny）。
7. 规则求值异常（包括 `tool.access` 抛错、匹配器异常）一律按 deny 处理，不得降级为 `unknown`（否则 `danger-full-access` 会 fail-open）；`source = "builtin"`、省略 `ruleIndex`、`reason = "permission_error:<截断后的错误信息>"`（总长 ≤ 200 字符）。

### 6.4 配置示例

```json
{
  "version": 1,
  "preset": "diagnose",
  "approvalTimeoutMs": 120000,
  "rules": [
    {
      "tool": "mcp__probe__mem_write",
      "params": [{ "key": "address", "range": [536870912, 536870943] }],
      "action": "allow",
      "reason": "SRAM 调试窗口"
    },
    {
      "tool": "mcp__serial__write",
      "params": [{ "key": "port", "in": ["COM3", "/dev/ttyUSB0"] }],
      "action": "ask"
    },
    { "tool": "mcp__probe__reset", "action": "deny", "reason": "无人值守禁止复位" }
  ]
}
```

## 7. 预设

### 7.1 能力推导

权限判定的输入是工具最终名称、`ToolDef.annotations`、schema 校验后的参数。

- `ToolDef` 新增可选 `access?: (input: I) => ToolAccess`，用于把同一工具的不同操作分类：
  - `fs`：`op === "read"` → `read`；`write` / `edit` → `write`。
  - `shell`：固定 `write`（其自身危险命令拦截仍在 execute 内生效）。
- 未提供 `access` 时按 annotations 推导：`destructive === true` → `write`（优先）；否则 `readOnly === true` → `read`；否则 `unknown`。
- 同时声明 `readOnly === true` 与 `destructive === true` 的冲突注解归 `unknown`（`diagnose` 下 deny），不信任 server 自相矛盾的声明。
- `access` 的运行时返回值必须是 `read` / `write` / `unknown`；其他值（包括 `undefined`、Promise、未知字符串）视为求值异常，按 deny 处理（`reason = "permission_error:..."`），不得降级为 `unknown`，也不得 fail-open。
- MCP 适配器：`destructive === true` → `write`；两者同时 true → `unknown`；仅 `readOnly === true` → `read`；两者都非 true → `unknown`（即“未知 MCP 工具”）。
- 未知 in-process 工具同样归 `unknown`，不因“不是 MCP”而放宽。

### 7.2 预设矩阵

| 能力 | read-only | workspace-write | diagnose（默认） | danger-full-access |
|---|---|---|---|---|
| `read` | allow | allow | allow | allow |
| `write` | deny | ask | ask | allow |
| `unknown` | deny | deny | deny | allow |

`workspace-write` 附带一条内置规则：`fs` 的 `write`/`edit` → allow，理由 `preset:workspace-write:fs-write`。其他写工具（shell、MCP destructive）仍为 ask。内置规则位于规则序列末尾，可被用户 ask/deny 覆盖；deny 恒胜。

`diagnose` 下：`fs` 读、`glob`、`grep`、`echo`、MCP readOnly 工具 allow；`fs` 写/edit、`shell`、MCP destructive 工具 ask（headless 即 deny）；未知 MCP 工具 deny。

## 8. 管线接入

### 8.1 判定点

`executeOne` 的顺序改为：

1. 查找工具。
2. Zod `safeParse`。
3. 检查调用方 `signal`（已中止则 `tool_aborted`，不进入权限判定）。
4. 权限判定（见 §8.2）。
5. `allow` 后执行；超时、取消、后处理保持不变。

查找失败与 schema 失败发生在权限判定之前，不产生 `permission_decision`。批次内因前序超时被跳过的调用不进入判定，也不产生事件。

### 8.2 接口

```ts
export interface PermissionRequest {
  callId: string;
  tool: string;
  args: unknown;
  access: ToolAccess;
  action: PermissionAction;
  effective: "allow" | "deny";
  reason: string;
  preset: PermissionPreset;
  source: PermissionSource;
  ruleIndex?: number;
  paramsDigest: string;
  paramsKeys: string[];
  paramsPreview?: Record<string, unknown>;
}

export interface PermissionCheckInput {
  callId: string;
  tool: ToolDef<any>;   // 工具输入类型各异；判定只读 schema 输出与 annotations/access
  args: unknown;
  signal: AbortSignal;
}

export interface PermissionGate {
  check(input: PermissionCheckInput): Promise<PermissionRequest>;
}

export interface PermissionPrompter {
  request(req: {
    tool: string;
    args: unknown;
    reason: string;
    preset: PermissionPreset;
    signal: AbortSignal;
  }): Promise<"allow" | "deny">;
}
```

- `PermissionGate.check` 内部完成规则求值；动作为 `ask` 且存在 prompter 时，用 `approvalTimeoutMs` 包装并等待结果；否则 `ask` 立即转 deny，`reason = "approval_unavailable"`。
- 审批结果映射：批准 → `effective = "allow"`，理由保留规则/预设理由并追加 `approval_granted`；拒绝 → `"approval_denied"`；超时 → `"approval_timeout"`；signal 中止 → `"approval_aborted"`；prompter 抛错 → `"approval_error"`（错误信息限长）。
- `check` 返回的 `effective` 是最终结果；`action` 保留规则原始动作（ask 仍记 ask），供审计解释。
- 同一 gate 内的 prompter 调用**串行**：按 `check` 到达顺序排队，前一个审批结束后才发起下一个。超时从进入队列开始计时，排队期间收到 signal 中止则立即按 `approval_aborted` 结束；避免并发 readOnly 批次同时弹出多个审批或排队无限挂起。规则求值本身不串行。
- `approvalTimeoutMs` 默认 120000，限制在 1..2147483647；`createPermissionGate` 收到非法值时抛 `PermissionConfigError`，不得静默取默认。
- `paramsDigest` / `paramsKeys` / `paramsPreview` 由 gate 在判定时基于 schema 解析后的参数计算，主循环不重新计算，保证审计与实际判定输入一致。
- gate 对规则求值返回的任何非 `allow` / `ask` / `deny` 动作按 `deny` 处理（运行时防御，不依赖 TypeScript 类型）。

### 8.3 管线选项与审计写入

```ts
export interface PermissionOptions {
  gate: PermissionGate;
  onDecision: (call: BatchCall, decision: PermissionRequest) => Promise<void>;
}

export interface BatchOptions {
  // ...既有字段
  permission?: PermissionOptions;   // 成对提供；缺省 = 不做权限判定（P0 兼容）
}
```

- `executeBatch` 是底层库 API。缺省 `permission` 时保持 P0 行为（不判定），仅为既有测试与直接调用方兼容；**安全边界入口是 `runSession`**，`query` 始终传入由配置构造的 `permission`，并由集成测试断言默认装配不会遗漏。
- 判定完成后、执行前调用 `onDecision`；成功返回后才执行。
- 回调抛错时**不执行**该工具，异常向上传播，由主循环按运行期错误处理（`interrupted`），避免“执行了但无审计”。
- `effective === "deny"` 时仍先写审计，再返回结构化失败：`isError: true`、`code: "permission_denied"`、`detail: { action, effective, reason, preset, source, ruleIndex? }`，不创建超时计时器、不调用 `execute`。
- 并发批次（全部 `readOnly`）拆成两阶段：先按调用顺序完成所有 lookup / schema / 权限判定 / 审计，然后并发执行。这里的“授权失败”仅指 gate 求值或审计回调**抛错**：此时不执行任何调用，异常向上传播；逐调用返回 `deny` 是正常结果，用失败结果占位，同批其他 `allow` 调用继续执行。审批等待仍由 gate 串行化。
- 串行批次逐条“授权 → 审计 → 执行”。第 N 条审计失败时，前 N−1 条已执行；异常向上传播后主循环按既有逻辑补 `tool_result_lost`。这会产生“已执行但结果未落日志”的极端窗口，登记为已知边界，不声称端到端原子。
- 主循环在 `executeBatch` 调用点提供 `onDecision`，写入 `permission_decision` 事件，`parent` 为对应 assistant 事件 seq，payload 带 `callId` 以便与 `tool_result` 一一对应。

## 9. 审计事件

### 9.1 事件类型

`EventType` 新增 `"permission_decision"`，`persistence.ts` 白名单同步；旧日志不含该类型，读取与回放不受影响。`buildMessages` 与前端 `transcriptFromSession` 忽略该类型（前端 switch 已有 default）。

### 9.2 payload

```ts
export interface PermissionDecisionPayload {
  callId: string;
  tool: string;
  action: PermissionAction;
  effective: "allow" | "deny";
  reason: string;
  preset: PermissionPreset;
  source: PermissionSource;
  ruleIndex?: number;
  paramsDigest: string;
  paramsKeys: string[];
  paramsPreview?: Record<string, unknown>;
  access?: ToolAccess;
}
```

- `callId` 与对应 `tool_result.id` 相同，用于并发批次与回放关联；同一 assistant 的多次同名调用也能区分。
- `paramsDigest`：对参数做稳定序列化（对象键排序、数组保序）后取 SHA-256 前 16 位十六进制。
- `paramsKeys`：顶层键排序，最多 32 个，单个截断 100 字符；由 gate 基于解析后参数计算并写入 `PermissionRequest`，主循环不再从原始输入重算。
- `paramsPreview`：顶层键的值摘要；字符串截断到 120 个码点（不切断代理对），数字/布尔/null 原样，对象/数组记为 `{ type, size }`；整体 JSON 序列化后的 UTF-8 字节数不超过 4096，超出时丢弃后续键，并保证最终对象仍能容纳 `previewTruncated: true`（先预留该键的预算）。标记键不用 `truncated`，因为参数本身可能含同名键（D-119）。
- `reason` 来自规则、预设默认或审批结果；不得为空。
- 事件写入顺序：先 `permission_decision`，后（若执行）`tool_result`，两者 `parent` 均为同一 assistant seq。

## 10. 配置加载与信任

### 10.1 路径与顺序

- user：`$HARNESS_HOME/permissions.json`（默认 `~/.harness/permissions.json`），默认加载。
- project：`<workdir>/.harness/permissions.json`，默认**不加载**；显式 `permissions.trustProjectConfig === true` 或提供 `permissions.projectConfigPath` 时加载。
- 默认跳过时写 `status` 事件：`{ status: "permissions_project_config_skipped", message: <path> }`，与 MCP 的跳过披露一致。
- 与 `mcp.trustProjectConfig` **相互独立**：信任项目 MCP 配置不应同时放宽权限。
- `RunOptions`：

```ts
permissions?: {
  userConfigPath?: string;
  projectConfigPath?: string;
  trustProjectConfig?: boolean;
  preset?: PermissionPreset;
  rules?: PermissionRule[];
  approvalTimeoutMs?: number;
  prompter?: PermissionPrompter;
};
```

内联字段优先级最高；文件规则依次为 project、user。`permissions` 未提供时仍启用权限层并加载 user 配置，默认预设 `diagnose`。

### 10.2 合并

- `preset`：inline ?? project ?? user ?? `"diagnose"`。
- `approvalTimeoutMs`：inline ?? project ?? user ?? 120000。
- `rules`：inline → project → user 顺序拼接；内置预设规则（workspace-write 的 fs 写）追加在末尾。
- 不提供全局关闭权限层的开关。

### 10.3 错误处理（fail-closed）

- 文件不存在：视为未配置，不报错。
- JSON 解析失败、Zod 校验失败、`version` 非 1、未知字段、非法 glob/谓词/预设/超时：抛出 `PermissionConfigError`（新错误类型，含文件路径与字段路径），`runSession` 启动失败，进程退出码 2。
- 未知字段一律拒绝，不采用 MCP 配置的“警告后忽略”，因为权限规则拼写错误会静默改变安全边界。
- 配置文件读取的 EACCES/EPERM 等不吞掉，按启动错误抛出。
- 内联配置复用与文件相同的 Zod 校验（版本固定 1）：`RunOptions.permissions` 本身及已知字段的**类型/外形**错误（非普通对象、数组、非字符串路径、非布尔、非数组规则、非对象 prompter）抛 `TypeError`；`permissions` 外层未知键、规则内容、未知字段、非法 preset/timeout/谓词错误抛 `PermissionConfigError`（`invalid_schema`）。禁止内联规则绕过校验。
- `permissions_project_config_skipped` 的 `status` 写入失败按启动失败处理（fail-closed）；写入位置在既有 `try` 内、`systemPromptToAppend` 之后，失败仍走 `finally` 关闭会话并释放锁。
- 加载时机：user 配置不依赖工作目录，先加载；project 配置在 `runCwd` 确定后加载。新建会话在 `createSession` **之前**完成加载，失败不创建会话目录。resume 必须先只读读取 `header.json`（`readSessionDir`）确定 `runCwd` 并在调用 `resumeSession` **之前**完成加载：`resumeSession` 内部会执行 crash recovery 并追加事件，若加载失败会发生“配置坏但日志已被修改”。失败时不打开 handle、不追加任何事件；已有会话目录保持原状，不删除。

## 11. 与既有机制的关系

- **shell 黑名单**：权限判定先于 `shell.execute`；allow 后仍经过 `isDangerousCommand`。黑名单不是安全边界（D-083/087/088），权限层规则匹配也不是；真正的强隔离仍留 OS 沙箱（P3）。
- **fs 路径安全**：权限规则不能绕过 `resolveInWorkdir`；allow 只是允许调用，路径越界仍由工具自身拒绝。
- **MCP 生命周期**：权限只决定调用是否执行，不改变连接、重连、工具刷新语义；未知/已移除工具仍走 `tool_not_found`。
- **上下文压缩**：`permission_decision` 不进入模型消息，不参与 token 预算；投影忽略不影响“日志是唯一事实源”。
- **Web 回放**：阶段 2 可从日志重建审批记录；本设计不新增实时推送。

## 12. 测试策略

### 12.1 纯函数与配置

- tool glob：`*`、`?`、大小写、MCP 双下划线、空串/超长拒绝。
- 参数谓词：eq 类型严格、glob、in、range 边界（含 min=max）、缺失路径、数组索引、多 matcher AND、非法 matcher（多于一个操作符/range 反向）。
- 求值：deny 恒胜、ask 优先于 allow、来源顺序、ruleIndex 指向正确规则、无匹配回落预设。
- 预设矩阵：四个预设 × 三种能力；workspace-write 的 fs 写 allow、shell ask。
- 配置：缺失、空对象、未知字段（含 `RunOptions.permissions` 外层未知键）、坏 JSON、version=2、非法预设/超时/glob/key、project 默认跳过、trust 后加载、显式路径、inline 合并与优先级、inline 与文件错误类型一致。
- 审计摘要：稳定 digest（键顺序无关）、截断代理对安全、4096 UTF-8 字节上限、未知值类型、key 数量上限。

### 12.2 管线与主循环

- deny：mock `ToolDef.execute` 为 `vi.fn()`，断言未调用；结果为 `permission_denied`；审计回调被调用一次。
- allow：execute 调用一次；审计先于 execute（用调用顺序数组断言）。
- ask 无 prompter：execute 未调用，`reason = approval_unavailable`，`action = ask`、`effective = deny`。
- ask + prompter：批准执行、拒绝不执行；超时、abort、prompter 抛错均不执行。
- 审批串行：两个 readOnly 调用同时进入审批时，prompter 第二个请求在第一个结束后才发出；排队期间 abort 立即结束且 prompter 不被调用；超时从入队开始计算；第一个 prompter 抛错不毒化后续审批。
- 审计回调抛错：串行用例断言当前工具未执行；并发用例断言整批工具均未执行（两阶段授权）。
- MCP 执行边界：`createMcpTools` + `executeBatch` 下，destructive/unknown 被拒时 `source.call` 未被调用；readOnly 正常调用。
- 默认 `diagnose` 装配：headless 下 `shell` 调用返回 `permission_denied` 且未产生副作用；MCP 的 readOnly/destructive/unknown 动作由同节的 `executeBatch` 执行边界用例覆盖。
- 前端：含 `permission_decision` 的会话投影不抛错、不产生卡片、状态不变。
- resume：带不完整 assistant 批次的会话 + 坏权限配置时，日志长度与内容不变。
- 主循环：`permission_decision` 与 `tool_result` 均落日志，`callId` 与 `tool_result.id` 对应、parent 正确；旧日志可读；新日志投影/回放不抛错。
- 事件投影：`buildMessages` 连续两轮忽略 `permission_decision`；含该事件的会话可 resume、可 fork。
- 不产生判定的路径：工具不存在、schema 失败、signal 已中止、重复/非法 call id、超时跳过，均断言 `onDecision` 与 `execute` 未被调用。
- 混合并发批次：一个 `deny` + 一个 `allow` 时，`allow` 正常执行、`deny` 占位，审计各一条。
- MCP 映射：`createMcpTools` 的 readOnly → allow、destructive → ask（无通道 deny）、无标注 → deny，且 deny 时 `manager.call` 未被调用。
- 装配：不传 `permissions` 时 `runSession` 仍使用 diagnose 并加载 user 配置；user 配置可生效；`mcp.trustProjectConfig` 不加载 project permissions；project 未 trust 的 allow 规则不放宽默认 deny；配置加载失败不创建新会话目录，resume 失败释放锁。
- 危险命令不真实执行；仅纯函数断言与 mock 断言。

### 12.3 验证命令

`npm test`、`npm run coverage`（lines ≥ 85%）、`npm run typecheck`、`npm run lint`、`npm run build`；前端需跑 `npm run test:ui`、`npm run typecheck:web`、`npm run build:web`，确认新增事件类型未破坏回放与构建。

## 13. 交付边界与文档

- 代码：`src/permissions/`（规则、配置、策略、审计、类型）、`src/tools/pipeline.ts`、`src/tools/types.ts`、`src/tools/fs.ts`、`src/tools/shell.ts`、`src/context/build.ts`、`src/loop/query.ts`、`src/session/types.ts`、`src/session/persistence.ts`、`src/index.ts`。
- 测试：`tests/permissions-*.test.ts` 与既有 pipeline/query/persistence/build/ui 测试补充；`tests/integration.test.ts` 中非权限用例显式切换到 `danger-full-access`，不为过测试放宽默认。
- 文档：README 增权限配置章节（路径、预设、规则示例、headless 语义）；`docs/deferred-issues.md` 登记本轮已知边界（审批通道阶段 1 只有库层接口、参数预览可能包含敏感片段、规则不是沙箱、串行审计失败与崩溃的极端窗口、`executeBatch`/`query` 作为内部 API 可绕过权限、MCP 参数默认值不参与规则匹配）。
- 不合并 `main`；提交规范 `feat(permissions): ...`。

## 14. 验收锚点

1. 默认 `diagnose`、headless：`fs` 写/edit、`shell`、MCP destructive deny；`fs` 读、`glob`、`grep`、`echo`、MCP readOnly allow；未知 MCP deny。
2. 任一 deny 路径断言 `execute` 未调用；审计事件先于执行写入。
3. 每条进入权限判定的调用恰好一条 `permission_decision`，字段完整且参数摘要受限。
4. `ask` 在无通道、超时、取消、异常下均不挂起、不执行。
5. 项目级配置未 trust 时不生效，并写入 `permissions_project_config_skipped`。
6. 旧会话可读、新会话可回放；`npm test` / coverage / typecheck / lint / build 全绿。

## 15. 留给实现者的决定

- 模块内部拆分与文件名（建议 `types.ts` / `rules.ts` / `config.ts` / `policy.ts` / `audit.ts`）。
- 稳定序列化的具体实现（递归排序键）与摘要截断工具复用方式。
- 审批超时计时器的实现细节：使用 `setTimeout` + `AbortController` 包装（不依赖 `AbortSignal.timeout` 的内部计时器），确保 vitest fake timers 可稳定推进并清理 listener/timer。
- 测试文件名与 fixture 组织。
