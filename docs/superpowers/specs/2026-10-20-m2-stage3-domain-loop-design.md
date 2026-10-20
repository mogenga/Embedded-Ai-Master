# M2 阶段 3 领域闭环设计（BR-4 / BR-5 / 端到端诊断）

> 版本：v1.0 · 日期：2026-10-20 · 状态：待实现
> 上游：`docs/BRD.md` BR-4/BR-5、`docs/m2-roadmap.md` 阶段 3、`docs/deferred-issues.md` D-157/D-158/D-159。

## 1. 意图与目标

阶段 2 已交付 BR-2 取证 MCP（Renode/OpenOCD/串口）与 BR-3 KB MCP（lookup/read/search），但三块仍是分离的：权限层能表达单字段范围，却不能约束 `mem_write` 的“起始地址 + 长度”跨度；KB 只能读，agent 发现的新知识无法写入待审通道；没有一条把“症状 → KB → 探针取证 → 证据对表 → 结论 → 回放”串起来的可执行验收。

阶段 3 的目标是让领域闭环**可执行、可验证、可拦截**：

1. **BR-4**：在权限引擎内提供参数级区间语义，并用一份 probe 领域策略模板证明地址窗口、串口白名单、复位门禁都能被独立 allow/ask/deny。
2. **BR-5**：新增 `kb_propose` 写入待审 inbox；新增人工审核脚本，只有回归不低于基线时才允许把提案标记为 accepted。
3. **端到端验收**：用真实 Renode、真实 KB、真实内核事件日志跑一次只读取证诊断，产出证据对表、根因与可证伪预测，并用 `LogTailEventSource` 回放同一事件序列。

## 2. 非目标

- 不做 Web 实时审批、设备面板、可交互回放控件（M3；`docs/m2-roadmap.md` 阶段 4）。
- 不做真机 OpenOCD / 真实 COM 串口验证（D-157）。
- 不自动把提案写进正式 KB 条目，也不自动生成/重排 `index.yaml`——语义合并必须人工完成。
- 不把 KB 语料或回归查询集纳入版本库（R7 / D-158）。
- 不改变默认 `diagnose` 预设的既有行为；领域策略以**示例模板**提供，用户显式复制到 `.harness/permissions.json` 后生效。

## 3. 约束

- TypeScript + Node 24，ESM-only；MCP 使用官方 SDK v2，schema 使用 Zod v4；测试框架 vitest。
- 内核（`src/`）不得含嵌入式领域逻辑；地址窗口、串口白名单、复位门禁只能以**通用参数语义 + 配置**表达。
- R1：LLM 永不直接控制仪器；所有写/复位仍先过权限 gate。
- R2：写/复位前声明；阶段 3 不削弱现有 `declaration` 语义。
- R3：证据必须诚实；复位基线不得被表述为“真实板卡故障”；全 0 不得解码为“无故障”。
- 危险命令测试禁令：只做纯函数断言或注入 mock，禁止真实执行破坏性命令。
- 依赖安装禁令：不执行 `npm install` / `npm ci` 等；需要新增依赖时只输出命令给用户。
- 禁止 `git worktree`；只在当前工作区分支开发。

## 4. BR-4：参数级策略

### 4.1 通用区间语义 `extentKey`

在 `ParamMatcher` 增加可选字段 `extentKey`，只在 `range` 操作符下生效：

```json
{
  "tool": "mcp__probe__mem_write",
  "params": [
    { "key": "address", "range": [536870912, 536903679], "extentKey": "bytes" }
  ],
  "action": "allow",
  "reason": "SRAM 可写窗口"
}
```

语义：

- `range` 是允许的**整个区间**闭区间 `[lower, upper]`。
- `extentKey` 是相对同一 `args` 的点路径；值为有限数字时取该数字，值为数组时取 `length`，其他情况匹配失败（fail closed）。
- 匹配条件：`value >= lower && value + extent - 1 <= upper && extent >= 1`。
- `extentKey` 缺失时保持现有单值 `range` 语义。
- `extentKey` 与 `eq/glob/in` 同用属于配置错误；配置加载时拒绝。

这是通用“区间 + 跨度”语义，不含任何地址/寄存器知识。

### 4.2 probe 领域策略模板

新增 `mcp-servers/probe/permissions.example.json`，内容固定为：

- `preset: "diagnose"`；
- `mcp__probe__mem_write` 的 `address` 允许 `[0x20000000, 0x2001FFFF]`（STM32F4 SRAM 128 KiB），`extentKey: "bytes"`，action `allow`；
- `mcp__probe__serial_open` 的 `host in ["127.0.0.1"]` 且 `port in [3456, 3457]`，action `allow`；
- `serial_open` 标为非只读（access=`unknown`）：未显式 allow 时 `diagnose` 默认 deny；这是相对阶段 2 的安全收紧；
- `mcp__probe__reset` action `deny`，reason 明确“示例默认禁止复位，需人工改配置”；
- 其余写/复位回落 `diagnose` 的 `ask`（headless 下 `approval_unavailable` → deny）。

模板不自动加载；README 说明复制到 `.harness/permissions.json` 或在 `runSession({ permissions })` 内联使用。

### 4.3 验收

- `extentKey` 纯函数测试：窗口内、恰好到上界、跨界、长度缺失、长度为 0、非数组/非数字、与 `eq` 同用被配置拒绝。
- 领域模板测试：用 `loadPermissionConfig({ inline })` 加载模板，`evaluatePolicy` 断言：
  - SRAM 内 `mem_write` → allow；
  - `0x2001FFF0` + 32 字节 → 不命中 allow，回落 ask；
  - `0x08000000` → ask；
  - `serial_open` 白名单 → allow，非白名单 → deny；
  - `reset` → deny；
  - `serial_write` → ask。
- 测试只构造 `ToolDef` 假对象，不执行 probe 后端，不 spawn 进程。

## 5. BR-5：知识沉淀闭环

### 5.1 inbox 数据模型

新增 `mcp-servers/kb/inbox.ts`：

```ts
export interface KbProposal {
  id: string;
  date: string;
  kind: "trap" | "correction" | "reference" | "case";
  domain: string;
  source: string;
  content: string;
  title?: string;
}

export function parseInbox(text: string): KbProposal[];
export function formatProposal(proposal: KbProposal): string;
export function proposalDigest(proposal: KbProposal): string;
export function appendProposal(root: string, proposal: KbProposal): { path: string; duplicateOf?: string };
export function removeProposal(root: string, id: string): KbProposal | undefined;
export function appendReviewed(root: string, entry: ReviewedEntry): string;
```

- 文件固定为 `<root>/_inbox.md`，追加在文件末尾。
- 新提案块格式与现有块一致（`---` 分隔的 YAML 子集），并新增 `id` 与可选 `title`。
- 旧块没有 `id` 时，`parseInbox` 生成稳定 `legacy-<n>`（按出现顺序，从 1 开始）。
- 重复判定：`kind + domain + content` 的 sha256 与现有提案相同；重复时不写文件，返回已有 id。
- `removeProposal` 重写 `_inbox.md`，保留头部注释与其他块，不改动内容。
- `appendReviewed` 追加到 `<root>/_reviewed.md`，记录 `id/status/reviewedAt/target/reason`；文件不存在时创建，头部固定一行说明。

并发：MCP server 单实例、审核脚本人工执行；使用 `appendFile` 的 O_APPEND 语义，不做跨进程锁。审核脚本先读后写，若 `_inbox.md` 在读取后变化（mtime/size 变化），拒绝执行并提示重试。

### 5.2 `kb_propose` 工具

在 `mcp-servers/kb/tools.ts` 新增：

```ts
name: "kb_propose"
input: {
  kind: "trap" | "correction" | "reference" | "case",
  domain: string,        // 1..64
  source: string,        // 1..200，必填
  content: string,       // 1..8000
  title?: string         // 1..200
}
annotations: { readOnlyHint: false, destructiveHint: true }
meta: { evidence: false }
```

返回 `{ proposalId, inboxPath: "_inbox.md", status: "pending_review", duplicate?: true }`。

- 写入失败显式返回 `proposal_failed`，不得伪装成功。
- 工具描述必须写明：只进入待审 inbox，不参与检索，必须人工审核后合并。
- `kb_status` 增加 `inboxPending: number`（`parseInbox` 的条数）。这是新增字段，不改变既有字段。

### 5.3 审核脚本

新增 `scripts/kb-review.mjs`（npm script `kb:review`）：

```bash
node scripts/kb-review.mjs --list
node scripts/kb-review.mjs --accept <id> --target protocols/uart/no-output.md [--note "..."]
node scripts/kb-review.mjs --reject <id> --reason "..."
```

- `--list`：输出 `id/date/kind/domain/source/摘要`，只读。
- `--accept`：**人工已把内容合并进 `--target` 正式文件**；脚本只做门禁与状态流转：
  1. 校验 target 是 KB 根内 `.md`，存在且非 `_inbox.md` / `_reviewed.md`；
  2. 运行 `scripts/kb-regression.mjs --json`，解析报告；
  3. 用 `regression-gate.ts` 的 `compareRegression(report, baseline)` 比较；
  4. 任一指标低于 baseline 或总数变化 → 退出码 1，inbox 不变；
  5. 全绿 → 从 `_inbox.md` 移除提案，追加 `_reviewed.md`（status=accepted, target）。
- `--reject`：移除提案并追加 `_reviewed.md`（status=rejected, reason），不跑回归。
- 缺少 `dist-mcp`、baseline、KB 根、inbox 时退出码 2，并给出可操作提示。
- 不自动编辑正式条目或 `index.yaml`；target 不在 `index.yaml` 时输出 warning（不阻塞，reference 条目可能不入索引）。

### 5.4 回归门禁

新增 `mcp-servers/kb/regression-gate.ts`：

```ts
export interface RegressionBaseline {
  index: { total: number; recallAt2: number; hitAt1: number; mrr: number };
  search: { total: number; hitAt1: number; goldInTop20: number };
  negatives: { total: number; refusalRate: number };
}
export interface RegressionGateResult {
  ok: boolean;
  failures: Array<{ metric: string; expected: number; actual: number }>;
}
export function compareRegression(report: unknown, baseline: RegressionBaseline): RegressionGateResult;
```

- 比较规则与 `mcp-servers/kb/tests/regression.test.ts` 现有断言一致：总数必须相等，各指标 `actual >= expected - 1e-9`。
- 报告结构不合法 → `failures` 含 `"invalid_report"`，`ok: false`（fail closed）。
- 脚本与测试共用该纯函数。

### 5.5 验收

- inbox 纯函数测试：解析旧块、追加/移除往返、重复检测、`_reviewed.md` 创建。
- `kb_propose` 工具测试：写入成功、重复不重复写、超长/空内容拒绝、写入失败返回 `proposal_failed`。
- `regression-gate` 测试：不低于基线通过、单项下降失败、总数变化失败、非法报告失败。
- 脚本手工验收：`--list` 能列出真实 inbox；`--accept` 在人为降低指标时拒绝（用 fixture 报告单测覆盖，不修改真实 baseline）。

## 6. 端到端诊断验收

### 6.1 诊断分析纯函数

新增 `mcp-servers/probe/diagnosis.ts`：

```ts
export interface UartBaselineRegisters {
  vtor: number;        // 0xE000ED08
  apb1enr: number;     // 0x40023840
  gpioaModer: number;  // 0x40020000
  usartCr1: number;    // 0x40004400
  usartBrr: number;    // 0x40004408
}
export interface DiagnosisVerdict {
  rootCause: string;
  matchedKbSteps: number[];   // 对应 no-output.md 的 #3/#7/#8
  checks: Array<{ name: string; value: string; expected: string; ok: boolean }>;
  falsifiablePrediction: string;
  limitations: string[];
}
export function analyzeUartBaseline(input: UartBaselineRegisters): DiagnosisVerdict;
```

判定：

- `USART2EN = (apb1enr >> 17) & 1`；
- `PA2_MODE = (gpioaModer >> 4) & 3`，`PA3_MODE = (gpioaModer >> 6) & 3`；
- `UE = (usartCr1 >> 13) & 1`，`TE = (usartCr1 >> 3) & 1`；
- 全部复位态（EN=0、PA2/PA3 非 AF、UE=0、TE=0、BRR=0，且关键读数无 all-zero warning）→ 根因“USART2 未初始化（时钟/引脚/波特率均未配置）”，matchedKbSteps `[7, 8]`；
- 已初始化（EN=1、PA2/PA3 至少一个 AF、UE=1、BRR>0）→ 根因“仿真基线显示 USART2 已初始化，本证据不能证明线序/共地/电平正常”，matchedKbSteps `[]`，limitations 明确要求真板继续排查；
- 关键读数（APB1ENR/GPIOA_MODER/BRR）带 all-zero warning → 不得把 0 解码为“未配置”；根因改为“仿真基线证据不足”，matchedKbSteps `[3]`，并列出仍可信的证据（如 CR1 的 UE/TE=0）；
- 混合状态 → 根因“USART2 初始化不完整”，列出未满足项；
- 无论哪种情况，`limitations` 都包含“Renode 复位基线不等于真实板卡故障；VTOR=0 表示未加载固件”“全 0 读数可能来自未映射地址，不能单独证明寄存器值为 0”。

可证伪预测固定为：“若在固件中使能 USART2 时钟、将 PA2/PA3 配为 AF7、置 UE|TE 并写入与 PCLK 匹配的 BRR，则 TX 应产生字节；若仍无输出，则本根因判断被证伪。”

### 6.2 端到端脚本

新增 `scripts/diagnosis-e2e.mjs`（npm script `diagnosis:e2e`，默认不进入 `npm test`）：

1. 检查 `dist/`、`dist-mcp/`、Renode 可执行文件；缺失退出码 2/1。
2. 创建临时 `HARNESS_HOME`，写 `providers.json` 与 `mcp.json`：
   - `probe`：`node dist-mcp/probe/server.js`，env `RENODE_PATH`；
   - `kb`：`node dist-mcp/kb/server.js`，env `KB_ROOT=<repo>/mcp-servers/kb/kb`。
3. 用 `runSession` + mock `fetchImpl` 按固定顺序返回工具调用：
   `kb_lookup("串口没输出")` → `kb_read("protocols/uart/no-output.md")` → `probe.attach` → `probe.halt` → 5 次 `probe.mem_read`（VTOR/APB1ENR/GPIOA_MODER/USART2_CR1/USART2_BRR）→ 最终 stop 文本。
4. 从会话日志读取 `tool_result`，提取 hex，调用 `analyzeUartBaseline` 生成结构化结论。
5. 断言：
   - `kb_lookup` `found=true` 且首候选为 `protocols/uart/no-output.md`；
   - `kb_read` 内容包含 `probe_attach`、`BRR`、`pinmux`；
   - 5 个 `mem_read` 都有 `evidence: true`；
   - 根因包含“未初始化”或“证据不足”，`matchedKbSteps` 非空（全 0 warning 时为 #3）；
   - 结论含可证伪预测；
   - `LogTailEventSource.read(sessionId, -1)` 的事件 seq 连续（`since=0` 会排除 seq 0），工具调用序列与在线一致，`permission_decision` 先于对应 `tool_started`。
6. 输出一行 JSON（`symptom/kbEntry/rootCause/evidence/replayEvents`）；任何断言失败退出码 1。
7. 范围声明：这是**仿真复位基线取证**，不是真实板卡故障复现；报告中必须带 `limitations`。

## 7. 验收锚点

- `npm test` 离线全绿；新增测试覆盖上述纯函数与工具面。
- `npm run typecheck`、`npm run build`、`npm run build:mcp` 通过。
- `npm run kb:regression -- --baseline` 与 `regression-baseline.json` 逐项一致（不因新增代码改变检索指标）。
- 有 Renode 的机器上 `npm run diagnosis:e2e` 退出码 0，输出含根因/预测/回放事件数。
- 无 Renode 时脚本明确退出码 1/2，不伪装成功。

## 8. 风险与已知限制

| 风险 | 处理 |
|---|---|
| `extentKey` 让配置语义变复杂 | 仅允许与 `range` 同用；配置校验拒绝其他组合 |
| 领域模板被误认为默认生效 | 文件名 `permissions.example.json`，README 明确“不自动加载” |
| inbox 无跨进程锁 | 审核脚本检测文件 mtime/size 变化后拒绝；MCP 写入用 O_APPEND |
| 自动合并 KB 语义有风险 | 脚本只做状态流转与回归门禁，正文由人工合并 |
| 端到端依赖 Renode 与本地语料 | 脚本显式检查依赖并返回非零；不进入默认测试 |
| 复位基线被误读为真实故障 | `limitations` 固定输出，结论措辞限定在仿真基线 |
| 回归指标下降导致无法接受提案 | 按设计拒绝；人工需先修正语料/索引，不降低 baseline |