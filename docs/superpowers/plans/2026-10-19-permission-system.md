# M2 权限系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P0 工具管线中的权限占位替换为可配置的 allow/ask/deny 策略层，默认 `diagnose` 预设，写入 `permission_decision` 审计事件，并保证 deny 不执行、ask 无通道不挂起。

**Architecture:** 新增 `src/permissions/` 纯函数模块（规则匹配、配置加载、预设求值、审计摘要、审批 gate），在 `executeBatch` 的 schema 校验之后、`execute` 之前接入；`runSession` 加载配置并构造 gate，`query` 把判定结果写成会话事件。并发只读批次先串行授权并审计，再并发执行。

**Tech Stack:** TypeScript + Node 24（ESM-only）、Zod v4、vitest；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-19-permission-system-design.md`

## Global Constraints

- TypeScript + Node 24，ESM-only，相对导入必须带 `.js`，strict；不引入 CommonJS。
- 不新增依赖；配置校验使用已有 Zod v4；测试使用 vitest，默认离线。
- 内核不含领域逻辑；权限引擎只做通用规则匹配，不实现地址/端口语义。
- 默认预设 `diagnose`；项目级配置默认不加载，显式 trust 后生效。
- `deny` 绝不调用 `execute`/`spawn`；`ask` 在无通道、超时、取消、异常时一律 deny，不挂起。
- 审计事件先于执行写入；审计写失败不得继续执行。
- 危险命令测试禁令：不得真实执行破坏性命令；拒绝路径用 mock `ToolDef.execute` 或临时目录内的无害操作断言。
- 不自行提交：每个任务以测试/typecheck 通过为完成门禁；commit 仅在用户明确授权后执行。
- 每个任务完成后执行两轮独立 review：第一轮实现审查并修复；第二轮独立复核/红队通过后才进入下一任务。
- 覆盖率阈值沿用 `npm run coverage` 的 lines ≥ 85%。

## Review Focus

1. deny 路径仍调用 `execute` 或 `spawn`（尤其 shell 与 MCP 写工具）——Task 5 用 mock 断言未调用。
2. 项目级 `permissions.json` 未 trust 时生效，或未知字段/拼写错误被静默忽略——Task 2 与 Task 7 覆盖。
3. `ask` 在 headless、超时、取消或 prompter 异常时挂起或误放行——Task 4 覆盖。
4. 审计先于执行被破坏，或 `callId` 与 `tool_result.id` 失配导致回放无法关联——Task 5 / Task 6 覆盖。
5. 并发只读批次中审批乱序、授权失败仍有工具执行，或新事件类型让旧日志/前端不可读——Task 4 / Task 5 / Task 6 覆盖。

---

### Task 1: 规则类型与匹配器

**Files:**
- Modify: `src/tools/types.ts`（新增 `ToolAccess` 与可选 `access`）
- Create: `src/permissions/types.ts`
- Create: `src/permissions/rules.ts`
- Test: `tests/permissions-rules.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `ToolAccess = "read" | "write" | "unknown"`（定义在 `src/tools/types.ts`，permissions 从 tools 导入，避免类型环）
  - `ToolDef<I>` 新增可选 `access?: (input: I) => ToolAccess`
  - `PermissionAction = "allow" | "ask" | "deny"`
  - `PermissionPreset = "read-only" | "workspace-write" | "diagnose" | "danger-full-access"`
  - `PermissionSource = "inline" | "project" | "user" | "builtin"`
  - `ParamMatcher { key: string; eq?: string | number | boolean | null; glob?: string; in?: Array<string | number | boolean | null>; range?: [number, number] }`
  - `PermissionRule { tool: string; params?: ParamMatcher[]; action: PermissionAction; reason?: string }`
  - `SourcedRule { rule: PermissionRule; source: PermissionSource }`
  - `PermissionConfig { version: 1; preset?: PermissionPreset; rules?: PermissionRule[]; approvalTimeoutMs?: number }`
  - `PermissionCheckInput { callId: string; tool: ToolDef<any>; args: unknown; signal: AbortSignal }`（`ToolDef` 从 `../tools/types.js` 类型导入）
  - `PermissionRequest { callId: string; tool: string; args: unknown; access: ToolAccess; action: PermissionAction; effective: "allow" | "deny"; reason: string; preset: PermissionPreset; source: PermissionSource; ruleIndex?: number; paramsDigest: string; paramsKeys: string[]; paramsPreview?: Record<string, unknown> }`
  - `PermissionGate { check(input: PermissionCheckInput): Promise<PermissionRequest> }`
  - `PermissionPrompter { request(req: { tool: string; args: unknown; reason: string; preset: PermissionPreset; signal: AbortSignal }): Promise<"allow" | "deny"> }`
  - `matchToolPattern(pattern: string, name: string): boolean`
  - `readPath(input: unknown, key: string): { found: boolean; value?: unknown }`
  - `matchParam(matcher: ParamMatcher, input: unknown): boolean`
  - `matchParams(matchers: readonly ParamMatcher[] | undefined, input: unknown): boolean`

- [ ] **Step 1: 写失败测试 `tests/permissions-rules.test.ts`**

断言至少包含：

```ts
expect(matchToolPattern("fs", "fs")).toBe(true);
expect(matchToolPattern("mcp__*__mem_*", "mcp__probe__mem_write")).toBe(true);
expect(matchToolPattern("fs?", "fsw")).toBe(true);
expect(matchToolPattern("*", "anything")).toBe(true);
expect(matchToolPattern("fs", "fss")).toBe(false);
expect(matchToolPattern("FS", "fs")).toBe(false);
expect(matchParam({ key: "op", eq: "read" }, { op: "read" })).toBe(true);
expect(matchParam({ key: "op", eq: 1 }, { op: "1" })).toBe(false);
expect(matchParam({ key: "path", glob: "src/*.ts" }, { path: "src/a.ts" })).toBe(true);
expect(matchParam({ key: "port", in: ["COM3", "/dev/ttyUSB0"] }, { port: "COM3" })).toBe(true);
expect(matchParam({ key: "address", range: [0x20000000, 0x2000001f] }, { address: 0x2000001f })).toBe(true);
expect(readPath({ a: { b: ["x"] } }, "a.b.0")).toEqual({ found: true, value: "x" });
expect(readPath({ a: 1 }, "a.b").found).toBe(false);
expect(matchParams([{ key: "op", eq: "write" }, { key: "path", glob: "src/*" }], { op: "write", path: "src/a.ts" })).toBe(true);
expect(matchParams([{ key: "op", eq: "write" }, { key: "path", glob: "src/*" }], { op: "write", path: "lib/a.ts" })).toBe(false);
expect(matchParam({ key: "v", eq: 0 }, { v: -0 })).toBe(true);
expect(matchParam({ key: "v", eq: null }, { v: null })).toBe(true);
expect(matchParam({ key: "v", glob: "*" }, { v: 1 })).toBe(false);
expect(matchParam({ key: "v", in: [] }, { v: 1 })).toBe(false);
expect(matchParam({ key: "v", range: [0, 1] }, { v: "1" })).toBe(false);
expect(matchParams([], {})).toBe(true);
expect(matchParam({ key: "v", range: [5, 5] }, { v: 5 })).toBe(true);
expect(matchToolPattern("", "x")).toBe(false);
expect(matchToolPattern("a".repeat(201), "a".repeat(201))).toBe(false);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/permissions-rules.test.ts`
Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现 `types.ts` 与 `rules.ts`**

- `matchToolPattern`：把 `*` 转 `.*`、`?` 转 `.`，其余正则元字符转义，整串锚定；大小写敏感；空串或长度 > 200 返回 false。
- `readPath`：按 `.` 分段；对象取自有键，数组只接受十进制数字段；空 key 或空段返回未找到。
- `matchParam`：`eq` 用严格类型比较（`null` 严格；number 先把 `-0` 归一为 `0`）、`glob` 仅字符串、`in` 用同样的严格比较、`range` 仅有限 number 且闭区间。
- `matchParams`：`undefined` 或空数组视为匹配；否则全部 matcher 匹配。单个 matcher 多于一个操作符或 `range` 反向属于配置错误，由 Task 2 的 Zod 校验拒绝，运行时按不匹配处理。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/permissions-rules.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 0 error。

- [ ] **Step 6: 两轮 review gate**

第一轮审查类型命名、点路径与类型严格性、`-0` 归一；第二轮红队 `*`/`?` 转义、空段、数组越界、超长 tool、`in: []`、`range` 反向。修复后重跑 Step 4-5。

---

### Task 2: 配置解析、加载与合并

**Files:**
- Create: `src/permissions/errors.ts`
- Create: `src/permissions/config.ts`
- Test: `tests/permissions-config.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PermissionConfig`、`PermissionRule`、`SourcedRule`、`PermissionPreset`。
- Produces:
  - `class PermissionConfigError extends Error { readonly code: string; readonly detail?: unknown }`，code ∈ `invalid_json | invalid_schema | unsupported_version | read_failed`
  - `interface InlinePermissionConfig { preset?: PermissionPreset; rules?: PermissionRule[]; approvalTimeoutMs?: number }`
  - `interface LoadPermissionOptions { home: string; workdir: string; inline?: InlinePermissionConfig; userConfigPath?: string; projectConfigPath?: string; trustProjectConfig?: boolean }`
  - `interface LoadedPermissionConfig { preset: PermissionPreset; rules: SourcedRule[]; approvalTimeoutMs: number; projectSkipped?: string; userConfigPath?: string; projectConfigPath?: string }`
  - `parsePermissionConfig(text: string, file: string): PermissionConfig`
  - `parseInlinePermissionConfig(inline: unknown): InlinePermissionConfig`
  - `loadPermissionConfig(opts: LoadPermissionOptions): LoadedPermissionConfig`

- [ ] **Step 1: 写失败测试 `tests/permissions-config.test.ts`**

覆盖：

```ts
expect(loadPermissionConfig({ home, workdir }).preset).toBe("diagnose");
expect(loadPermissionConfig({ home, workdir }).approvalTimeoutMs).toBe(120000);
expect(() => parsePermissionConfig("{", "p.json")).toThrow(PermissionConfigError);
expect(() => parsePermissionConfig(JSON.stringify({ version: 2 }), "p.json")).toThrow(
  expect.objectContaining({ code: "unsupported_version" }),
);
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, extra: true }), "p.json")).toThrow(/extra/);
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, rules: [{ tool: "", action: "allow" }] }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, rules: [{ tool: "fs", reason: "", action: "allow" }] }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, rules: [{ tool: "a".repeat(201), action: "allow" }] }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, approvalTimeoutMs: 0 }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, preset: "yolo" }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, rules: [{ tool: "fs", params: [{ key: "op", eq: "read", glob: "*" }], action: "allow" }] }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, rules: [{ tool: "fs", params: [{ key: "address", range: [10, 1] }], action: "allow" }] }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, rules: [{ tool: "fs", params: [{ key: "port", in: [] }], action: "allow" }] }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, rules: [{ tool: "fs", params: [{ key: "a..b", eq: 1 }], action: "allow" }] }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, rules: [{ tool: "fs", params: [{ key: "p", glob: "" }], action: "allow" }] }), "p.json")).toThrow();
expect(() => parsePermissionConfig(JSON.stringify({ version: 1, rules: [{ tool: "fs", params: [{ key: "p", glob: "a".repeat(201) }], action: "allow" }] }), "p.json")).toThrow();
expect(() => parseInlinePermissionConfig({ rules: [{ tool: "", action: "allow" }] })).toThrow(PermissionConfigError);
expect(() => parseInlinePermissionConfig({ extra: true })).toThrow(/extra/);
```

并断言：project 未 trust 时返回 `projectSkipped` 且 project 规则不生效；`trustProjectConfig:true` 或显式 `projectConfigPath` 时生效；规则顺序为 `inline → project → user`，每条带正确 `source`；inline `preset` 覆盖文件；缺文件不报错；坏文件错误信息含路径；`{}` 与缺 `version` 均被拒绝。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/permissions-config.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现配置模块**

- 解析前先判断 `version !== 1`（含缺失/非数字）并抛 `unsupported_version`；其余用 Zod v4 `z.strictObject` 校验根、rule、matcher。matcher 用 `superRefine` 要求恰好一个操作符；`range` 校验 `min <= max` 且有限；`in` 非空；`glob` 非空且 ≤ 200；`key` 非空、点分段均非空、≤ 200；`tool` 非空且 ≤ 200；`reason` 非空；`approvalTimeoutMs` 为 1..2147483647 的整数。错误信息拼接文件路径与字段路径。
- `parseInlinePermissionConfig`：把一个 `{ version: 1, ...inline }` 对象交给同一套 schema；未知字段、非法规则、非法 preset 均抛 `PermissionConfigError`。
- `loadPermissionConfig`：user 路径默认 `path.join(home, "permissions.json")`；project 默认 `path.join(workdir, ".harness", "permissions.json")`。文件存在且未 trust 时只返回 `projectSkipped`，不读取内容。读取失败区分 ENOENT（忽略）与其他（`read_failed`）。
- 合并：`preset = inline?.preset ?? project?.preset ?? user?.preset ?? "diagnose"`；timeout 同序；rules 按 inline、project、user 拼接。
- 不追加内置规则（Task 3 的 `evaluatePolicy` 负责）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/permissions-config.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 0 error。

- [ ] **Step 6: 两轮 review gate**

第一轮审查 strict 字段、错误码与路径信息、缺省值；第二轮红队未知字段、空规则、project 跳过、EACCES、内联覆盖。修复后重跑 Step 4-5。

---

### Task 3: 能力推导与预设求值

**Files:**
- Modify: `src/tools/fs.ts`（声明 `access`）
- Modify: `src/tools/shell.ts`（声明 `access`）
- Create: `src/permissions/policy.ts`
- Test: `tests/permissions-policy.test.ts`
- Test: `tests/permissions-mcp.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SourcedRule`、`PermissionRule`、`PermissionPreset`、`ToolAccess`、`ToolDef.access`；Task 2 的 `LoadedPermissionConfig.rules`。
- Produces:
  - `builtinRules(preset: PermissionPreset): SourcedRule[]`
  - `toolAccess(tool: ToolDef<any>, args: unknown): ToolAccess`
  - `interface PolicyEvaluation { action: PermissionAction; reason: string; preset: PermissionPreset; source: PermissionSource; ruleIndex?: number; access: ToolAccess }`
  - `evaluatePolicy(input: { preset: PermissionPreset; rules: readonly SourcedRule[]; tool: ToolDef<any>; args: unknown }): PolicyEvaluation`

- [ ] **Step 1: 写失败测试 `tests/permissions-policy.test.ts`**

覆盖：

```ts
const readTool = { name: "grep", annotations: { readOnly: true } } as ToolDef<any>;
const shell = { name: "shell", annotations: { destructive: true } } as ToolDef<any>;
const fsTool = { name: "fs", access: (input: any) => input.op === "read" ? "read" : "write" } as ToolDef<any>;

expect(toolAccess(readTool, {})).toBe("read");
expect(toolAccess(shell, {})).toBe("write");
expect(toolAccess({ name: "mcp__x__y", annotations: {} } as ToolDef<any>, {})).toBe("unknown");
expect(toolAccess(fsTool, { op: "read" })).toBe("read");
expect(toolAccess(fsTool, { op: "write" })).toBe("write");

expect(evaluatePolicy({ preset: "diagnose", rules: [], tool: readTool, args: {} }).action).toBe("allow");
expect(evaluatePolicy({ preset: "diagnose", rules: [], tool: shell, args: {} }).action).toBe("ask");
expect(evaluatePolicy({ preset: "diagnose", rules: [], tool: { name: "mcp__x__y", annotations: {} } as ToolDef<any>, args: {} }).action).toBe("deny");
expect(evaluatePolicy({ preset: "read-only", rules: [], tool: shell, args: {} }).action).toBe("deny");
expect(evaluatePolicy({ preset: "danger-full-access", rules: [], tool: shell, args: {} }).action).toBe("allow");
```

另断言：

- `workspace-write` 下 `fs` 写 allow、`shell` ask；`diagnose` 下 `fs` 写 ask。
- 用户规则 allow 可覆盖预设 ask；用户规则 ask 可覆盖预设 allow。
- 用户 deny 与 allow 同时匹配时 deny 恒胜。
- 多个匹配同动作时取顺序最前，`source`/`ruleIndex` 正确；`ruleIndex` 计入追加在末尾的内置规则。
- 无匹配时 `source = "builtin"`、`ruleIndex === undefined`、`reason = "preset:diagnose:write"` 形式。
- 规则 `reason` 优先于默认 `rule:<action>`。

同时在 `tests/permissions-mcp.test.ts` 用 `createMcpTools` + fake `McpToolSource` 覆盖能力映射：`readOnly:true` → read → allow；`destructive:true` → write → ask；两者同时 true → unknown → deny；两者都非 true → unknown → deny。“deny 时 `source.call` 未被调用”的端到端断言放在 Task 5（需要 `executeBatch`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/permissions-policy.test.ts tests/permissions-mcp.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现能力推导与求值**

- `toolAccess`：优先 `tool.access?.(args)`，并校验返回值只能是 `read`/`write`/`unknown`，其他值（`"admin"`、`undefined`、Promise）抛错，由 `evaluatePolicy` 统一按 deny 处理；否则 `annotations.destructive === true` → write（优先）、`annotations.readOnly === true` → read、其余 unknown；两者同时 true → unknown。
- `builtinRules("workspace-write")` 返回一条 `{ rule: { tool: "fs", params: [{ key: "op", in: ["write", "edit"] }], action: "allow", reason: "preset:workspace-write:fs-write" }, source: "builtin" }`；其他预设返回空数组。
- `evaluatePolicy`：`all = [...rules, ...builtinRules(preset)]`；按 `matchToolPattern` + `matchParams` 收集匹配；先取第一个 deny，再第一个 ask，再第一个 allow；未命中原规则时按预设矩阵返回默认动作与 `reason = "preset:<preset>:<access>"`。
- 整个求值包在 try/catch：`toolAccess` 或匹配器抛错时返回 `action: "deny"`、`source: "builtin"`、无 `ruleIndex`、`reason = "permission_error:<截断到 200 字符的错误信息>"`；不得降级为 `unknown`。`access` 返回非法值（`"admin"`、`undefined`、Promise）按求值异常处理为 deny，`danger-full-access` 下也必须 deny。测试分别断言抛错与非法返回值。
- 在 `src/tools/fs.ts` 的 `fsTool` 增加 `access: (input) => (input.op === "read" ? "read" : "write")`；在 `src/tools/shell.ts` 的 `shellTool` 增加 `access: () => "write"`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/permissions-policy.test.ts tests/permissions-mcp.test.ts`
Expected: PASS。

- [ ] **Step 5: 回归既有工具测试与类型检查**

Run: `npm test -- tests/tools.test.ts tests/fs.test.ts tests/shell.test.ts && npm run typecheck`
Expected: PASS，0 error。

- [ ] **Step 6: 两轮 review gate**

第一轮审查预设矩阵与 deny 恒胜、`ruleIndex` 基准、MCP annotations 映射；第二轮红队 annotations 缺失/冲突、`access` 抛错与非法返回值（含 `danger-full-access`）、规则放宽与内置规则冲突、shell 未显式声明 access。修复后重跑 Step 4-5。

---

### Task 4: 审计摘要与审批 gate

**Files:**
- Create: `src/permissions/audit.ts`
- Create: `src/permissions/gate.ts`
- Test: `tests/permissions-audit.test.ts`
- Test: `tests/permissions-gate.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PermissionRequest`、`PermissionPrompter`、`PermissionGate`、`PermissionCheckInput`；Task 2 的 `LoadedPermissionConfig`；Task 3 的 `evaluatePolicy`。
- Produces:
  - `stableStringify(value: unknown): string`
  - `digestParams(args: unknown): string`
  - `summarizeParams(args: unknown): { keys: string[]; preview?: Record<string, unknown> }`
  - `interface PermissionGateOptions { preset: PermissionPreset; rules: readonly SourcedRule[]; prompter?: PermissionPrompter; approvalTimeoutMs?: number }`
  - `createPermissionGate(opts: PermissionGateOptions): PermissionGate`

- [ ] **Step 1: 写失败测试 `tests/permissions-audit.test.ts`**

断言：

```ts
expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
expect(digestParams({ a: 1, b: 2 })).toBe(digestParams({ b: 2, a: 1 }));
expect(digestParams({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
expect(summarizeParams({ path: "src/a.ts", op: "read" }).keys).toEqual(["op", "path"]);
expect(summarizeParams({ content: "x".repeat(500) }).preview?.content).toHaveLength(120);
```

另断言：数组/对象摘要为 `{ type, size }`；number/boolean/null 原样；`undefined` 与不可序列化值有确定表示；超过 4096 个 UTF-8 字节时出现 `truncated: true` 且最终对象仍在预算内；代理对不被切断；顶层非对象参数返回空 keys；超过 32 个键只保留前 32 个；单个键超过 100 字符被截断。

- [ ] **Step 2: 写失败测试 `tests/permissions-gate.test.ts`**

用 `vi.fn()` 构造 prompter，覆盖：

- `gate.check({ callId: "c1", tool: shell, args: {}, signal })` 在无 prompter 时返回 `action: "ask"`、`effective: "deny"`、`reason: "approval_unavailable"`，且不挂起。
- prompter 返回 `"allow"` → `effective: "allow"`，reason 含 `approval_granted`；返回 `"deny"` → deny + `approval_denied`。
- prompter 永不 resolve 时，用 fake timers 推进 `approvalTimeoutMs` → deny + `approval_timeout`。
- 已中止 signal → `approval_aborted`，prompter 未被调用。
- prompter reject → `approval_error`，错误信息限长。
- 两个并发 `check` 都进入 ask 时，prompter 第二个调用要等第一个 settle 后才发生（用 deferred promise 断言调用顺序）。
- 排队期间 abort：第二个 check 立即返回 `approval_aborted`，prompter 从未收到它的请求。
- 超时从入队开始：第一个审批未 settle 时，第二个在 `approvalTimeoutMs` 到达后即超时，不等待第一个。
- 第一个 prompter reject 后，第二个审批仍能正常发起并返回结果（队列不被 rejection 毒化）。
- 允许场景下 `check` 返回 `paramsDigest`、`paramsKeys`、`paramsPreview`，`callId` 原样透传；`action` 为 allow 或 deny 时 prompter 完全不被调用。
- 超时后 prompter 迟到 resolve/reject 不改变已返回的 deny 结果。
- prompter 返回 `"maybe"` 等非法值时按 `approval_error` deny。
- `createPermissionGate({ approvalTimeoutMs: 0 })`、负数、小数、超上限时抛 `PermissionConfigError`，不得静默取默认值。

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- tests/permissions-audit.test.ts tests/permissions-gate.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现审计与 gate**

- `stableStringify`：递归排序对象键，数组保序，处理 `undefined`（对象中省略）与 JSON 不可序列化值的字符串化兜底。
- `summarizeParams`：按 §9.2 的键/预览/4096 UTF-8 字节规则实现；字符串按码点截断，不切断代理对。
- `createPermissionGate`：`evaluatePolicy` → 计算摘要 → 若 `action === "ask"`：无 prompter 立即 deny；有 prompter 进入 gate 内部串行队列，按批准/拒绝/超时/取消/异常映射 `effective` 与 reason。`allow` 直接返回。
- 超时用 `setTimeout` + `AbortController` 包装（不依赖 `AbortSignal.timeout` 内部计时器），与调用方 signal 合并；settle 后必须清理 timer 与 listener，迟到结果被忽略。prompter 返回非 `"allow"`/`"deny"` 视为 `approval_error`。
- 串行队列：每个排队项同时 race「前一项 settle」「从入队开始的超时」「调用方 abort」；队列链用 `.then(..., ...)` 或 `.finally` 保证 rejection 不毒化下一项；settle 后清理 timer/listener。
- gate 对 evaluatePolicy 返回的非 allow/ask/deny 动作按 deny 处理。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- tests/permissions-audit.test.ts tests/permissions-gate.test.ts`
Expected: PASS。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 0 error。

- [ ] **Step 7: 两轮 review gate**

第一轮审查 timer/listener 清理、审批准入顺序、摘要上限、UTF-8 字节预算、队列 rejection 处理；第二轮红队 abort 竞态、排队 abort/入队超时、前项 reject 毒化、prompter 抛错/非法返回值、超时后迟到 resolve、4096 字节边界、代理对切断、非法 action。修复后重跑 Step 5-6。

---

### Task 5: 工具管线接入

**Files:**
- Modify: `src/tools/pipeline.ts`
- Test: `tests/permissions-pipeline.test.ts`
- Test: `tests/pipeline.test.ts`（既有回归）

**Interfaces:**
- Consumes: Task 1 的 `PermissionCheckInput`、`PermissionRequest`、`PermissionGate`；Task 4 的 `createPermissionGate`（仅测试中使用）。
- Produces:
  - `interface PermissionOptions { gate: PermissionGate; onDecision: (call: BatchCall, decision: PermissionRequest) => Promise<void> }`
  - `BatchOptions.permission?: PermissionOptions`

- [ ] **Step 1: 写失败测试 `tests/permissions-pipeline.test.ts`**

用 `ToolDef` mock 与 `ToolRegistry` 构造批次，覆盖：

```ts
const execute = vi.fn(async () => ({ isError: false, code: "ok", message: "", text: "done" }));
const tool: ToolDef<{ op: string }> = { name: "fs", description: "", schema: z.object({ op: z.string() }), annotations: { readOnly: false }, execute };

// deny
const decision = { callId: "c1", tool: "fs", args: {}, action: "deny", effective: "deny", reason: "rule:deny", preset: "diagnose", source: "user", access: "write", paramsDigest: "x", paramsKeys: [] } satisfies PermissionRequest;
expect(execute).not.toHaveBeenCalled();
expect(onDecision).toHaveBeenCalledTimes(1);
expect(results[0].result.code).toBe("permission_denied");

// allow：审计先于执行
const order: string[] = [];
onDecision = async () => { order.push("audit"); };
execute.mockImplementation(async () => { order.push("execute"); return ok; });
expect(order).toEqual(["audit", "execute"]);
```

另断言：

- deny / allow / ask 每个用例都断言 `onDecision` 恰好调用一次，参数中的 `callId`、`action`、`effective` 正确。
- ask 无通道 → execute 未调用，`action: "ask"`、`effective: "deny"` 出现在审计回调参数中。
- `onDecision` 抛错 → 当前工具未执行；并发批次中所有工具均未执行。
- 并发只读批次：授权阶段按调用顺序串行回调；全部授权后 execute 才并发发生（用调用顺序数组断言）。
- `callId` 与 `BatchCall.id` 一致；deny 结果为 `isError: true`、`detail` 完整包含 `action`、`effective`、`reason`、`preset`、`source`，命中规则时含 `ruleIndex`。
- 混合并发批次：一个 deny + 一个 allow 时，allow 的 execute 正常调用，deny 的 execute 未调用，两者各写一条审计。
- 不产生审计的路径：工具不存在、schema 失败、signal 已中止、重复 id、非法 id、超时跳过，均断言 `onDecision` 与 `execute` 未被调用，并断言对应结果码。
- MCP 端到端：`createMcpTools` + fake `McpToolSource` 注册到 registry，经 `executeBatch` 判定 destructive/unknown 为 deny 时 `source.call` 未被调用；readOnly 为 allow 时 `source.call` 调用一次。
- 未提供 `permission` 的既有调用路径保持 P0 行为（回归 `tests/pipeline.test.ts`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/permissions-pipeline.test.ts`
Expected: FAIL。

- [ ] **Step 3: 重构 `pipeline.ts`**

- 抽出 `authorizeOne(tools, call, opts)`：lookup → schema → signal → `opts.permission.gate.check({ callId: call.id, tool, args: parsed.data, signal: opts.signal })` → `await opts.permission.onDecision(call, decision)`；返回授权后的 `{ tool, input }` 或拒绝结果。
- 抽出 `executeAuthorized(...)`：保留现有超时、取消、并行/串行与后处理逻辑；权限判定不得创建执行计时器。
- 串行批次：逐条 `authorizeOne` → 拒绝则 finalize 结果 → 允许则 `executeAuthorized`。
- 并发批次：先按调用顺序逐条 `authorizeOne`（全部完成后才执行）。这里的“失败”仅指 `gate.check` 或 `onDecision` **抛异常**：此时直接上抛且不执行任何工具。逐调用返回 `deny` 是正常结果，用 finalize 后的失败结果占位，同批其他 `allow` 调用继续并发执行。
- `permission` 缺省时完全跳过授权，保持既有行为。
- `tool_skipped_after_timeout`、`duplicate_call_id`、`invalid tool call id` 路径不进入授权。

- [ ] **Step 4: 运行管线测试与既有回归**

Run: `npm test -- tests/permissions-pipeline.test.ts tests/pipeline.test.ts tests/shell.test.ts tests/fs.test.ts`
Expected: PASS；权限 allow 不改变 shell 危险命令拦截与 fs 路径边界。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 0 error。

- [ ] **Step 6: 两轮 review gate**

第一轮审查授权/执行边界、并发两阶段、既有超时屏障未回归、MCP source.call 未调用；第二轮红队 deny 仍执行、审计失败仍执行、重复 id/非法 id 绕过、readOnly 批次并发顺序、逐调用 deny 被误当成整批失败。修复后重跑 Step 4-5。

---

### Task 6: 会话事件与主循环审计

**Files:**
- Modify: `src/session/types.ts`
- Modify: `src/session/persistence.ts`
- Modify: `src/context/build.ts`（投影忽略 `permission_decision`）
- Modify: `src/loop/query.ts`
- Modify: `tests/session-persistence.test.ts`
- Test: `tests/permissions-query.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PermissionRequest`；Task 5 的 `BatchOptions.permission`。
- Produces:
  - `EventType` 增加 `"permission_decision"`
  - `interface PermissionDecisionPayload { callId: string; tool: string; action: PermissionAction; effective: "allow" | "deny"; reason: string; preset: PermissionPreset; source: PermissionSource; ruleIndex?: number; paramsDigest: string; paramsKeys: string[]; paramsPreview?: Record<string, unknown>; access?: ToolAccess }`
  - `LoopCtx.permissionGate?: PermissionGate`

- [ ] **Step 1: 写失败测试 `tests/permissions-query.test.ts`**

沿用 `tests/query.test.ts` 的 fake model / registry 模式，断言：

- `permission_decision` 事件先于对应 `tool_result` 落日志，二者 `parent` 都等于 assistant seq。
- payload 的 `callId` 等于 `tool_result.id`，`tool/action/effective/reason/preset/source/paramsDigest/paramsKeys` 完整。
- deny 时 `tool_result.code === "permission_denied"` 且 tool 的 execute 未被调用。
- 同一 assistant 批次多个同名调用可按 `callId` 区分审计。
- 未提供 `permissionGate` 时行为与既有测试一致（P0 兼容）。
- `buildMessages` 对含 `permission_decision` 的日志连续调用两轮均不抛错，投影消息中不含该事件；含该事件的会话可 resume、可 fork。

持久化测试补充：写一条 `permission_decision` 事件后可读；不认识的事件类型仍报 `unknown_event_type`；旧日志（无该类型）读取正常。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/permissions-query.test.ts tests/session-persistence.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现事件类型与主循环写入**

- `session/types.ts`：新增 `PermissionDecisionPayload` 与 `EventType` 成员；不修改既有 payload。
- `session/persistence.ts`：`EVENT_TYPES` 白名单加入 `permission_decision`。
- `context/build.ts`：把 `permission_decision` 加入 `tool_call`/`usage`/`checkpoint`/`status`/`interrupted`/`compaction` 的忽略分支；否则下一轮投影会抛 `unknown session event type`，resume/fork 也会失败。
- `loop/query.ts`：`LoopCtx` 增加 `permissionGate`；在 `executeBatch` 调用处传入：

```ts
permission: {
  gate: ctx.permissionGate,
  onDecision: async (call, decision) => {
    await session.append({
      type: "permission_decision",
      payload: {
        callId: decision.callId,
        tool: decision.tool,
        action: decision.action,
        effective: decision.effective,
        reason: decision.reason,
        preset: decision.preset,
        source: decision.source,
        ...(decision.ruleIndex === undefined ? {} : { ruleIndex: decision.ruleIndex }),
        paramsDigest: decision.paramsDigest,
        paramsKeys: decision.paramsKeys,
        ...(decision.paramsPreview === undefined ? {} : { paramsPreview: decision.paramsPreview }),
        access: decision.access,
      },
      parent: assistantEvent.seq,
    });
  },
}
```

仅当 `ctx.permissionGate !== undefined` 时添加该字段。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/permissions-query.test.ts tests/session-persistence.test.ts tests/query.test.ts tests/build.test.ts tests/session.test.ts`
Expected: PASS。

- [ ] **Step 5: 前端回放回归**

在 `tests/ui/transcript.test.ts` 新增一条含 `permission_decision` 的事件序列（assistant → permission_decision → tool_result），断言不抛错、不产生额外卡片、状态不变；再运行：

Run: `npm test -- tests/ui/transcript.test.ts tests/ui/transcript-consistency.test.ts`
Expected: PASS；新事件类型被 default 分支忽略。只跑旧 fixture 不能证明这一点。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 0 error。

- [ ] **Step 7: 两轮 review gate**

第一轮审查事件顺序、parent、payload 字段与日志兼容、`buildMessages` 忽略分支；第二轮红队重复 callId、缺失字段、旧日志、前端新 fixture、审计写失败路径、resume 投影。修复后重跑 Step 4-6。

---

### Task 7: `runSession` 装配与配置加载时机

**Files:**
- Modify: `src/index.ts`
- Test: `tests/permissions-integration.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `loadPermissionConfig`、`PermissionConfigError`；Task 4 的 `createPermissionGate`；Task 6 的 `LoopCtx.permissionGate`。
- Produces:
  - `RunOptions.permissions?: { userConfigPath?: string; projectConfigPath?: string; trustProjectConfig?: boolean; preset?: PermissionPreset; rules?: PermissionRule[]; approvalTimeoutMs?: number; prompter?: PermissionPrompter }`
  - 新建/恢复会话均向 `LoopCtx` 传入 gate；project 跳过时写 `status` 事件 `{ status: "permissions_project_config_skipped", message: <path> }`。

- [ ] **Step 1: 写失败测试 `tests/permissions-integration.test.ts`**

沿用 `tests/integration.test.ts` 的临时 home/workdir 与 fake model 模式，覆盖：

- 不传 `permissions`：user 配置缺失时仍为 `diagnose`；模型请求 `fs` 写 → `tool_result.code === "permission_denied"`，目标文件不存在；模型请求 `fs` 读 → 成功。
- user `permissions.json` 存在 `preset: "danger-full-access"` 且不传 `permissions`：`fs` 写成功，证明 user 配置默认加载。
- 传 `permissions.preset: "danger-full-access"`：同一 `fs` 写成功（文件出现在临时 workdir）。
- 项目级 `.harness/permissions.json` 存在但未 trust：不生效，日志出现 `permissions_project_config_skipped`，且其中 allow 规则没有放宽默认 deny（`fs` 写仍被拒绝）。
- `permissions.trustProjectConfig: true`：项目规则生效。
- `mcp.trustProjectConfig: true` 且项目 permissions 含 allow 规则：project permissions 仍不加载，`fs` 写仍拒绝并出现 skipped，证明两套 trust 相互独立。
- 坏的 user/project 配置：`runSession` 抛 `PermissionConfigError`；新建会话目录不存在。
- resume 时权限配置加载失败：使用带“不完整 assistant 批次”的会话（会触发 crash recovery）与坏配置；断言抛错后日志长度与内容完全不变、锁可重新获取。若实现先 resume 再加载，该测试必须失败。
- 内联 `rules` 与 `preset` 优先于文件；内联 `preset` 非字符串 → `TypeError`，字符串但不在枚举 → `PermissionConfigError`；`approvalTimeoutMs: 0` → `PermissionConfigError`；`permissions` 外层未知键 `rule` → `PermissionConfigError`。
- 默认 `diagnose` 下 `shell` 调用（无害命令，如 `node -e "process.exit(0)"`）返回 `permission_denied`；用 spy 断言 `shellTool.execute` 未被调用（不是仅看结果码）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/permissions-integration.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现装配**

- 在 `runSession` 开头校验 `opts.permissions`：必须是普通对象（非 null/数组/异常 prototype），且只允许 `userConfigPath`、`projectConfigPath`、`trustProjectConfig`、`preset`、`rules`、`approvalTimeoutMs`、`prompter` 七个键；未知键抛 `PermissionConfigError("invalid_schema")`。
- 已知字段的**类型**错误抛 `TypeError`（路径非字符串、trust 非布尔、rules 非数组、timeout 非 number、prompter 非带 `request` 函数的对象）；`preset` 非字符串也抛 `TypeError`。
- 内联语义错误交给 `parseInlinePermissionConfig`：preset 字符串不在枚举、timeout 非整数或越界、规则内容/未知字段错误，均抛 `PermissionConfigError("invalid_schema")`，不得绕过校验。
- 新建会话：先计算 `runCwd = path.resolve(opts.cwd ?? process.cwd())`，调用 `loadPermissionConfig({ home, workdir: runCwd, inline, ...paths })`，再 `createSession`；失败不创建目录。
- resume：先 `readSessionDir(resumeDir)` 只读取得 header，计算 `cwd = path.resolve(opts.cwd ?? header.workdir ?? process.cwd())` 并加载配置；**加载成功后才调用 `planResume`/`resumeSession`**。失败直接抛出，不打开 handle、不触发 crash recovery、不追加事件。
- 构造 `gate = createPermissionGate({ preset, rules, prompter, approvalTimeoutMs })`，始终传入 `LoopCtx.permissionGate`。
- `projectSkipped` 的 `status` 追加放在既有 `try` 内、`systemPromptToAppend` 之后；写入失败走 `finally` 关闭会话并释放锁。
- 不提供关闭权限层的选项；`permissions` 缺省仍启用 diagnose。

- [ ] **Step 4: 迁移既有集成测试**

`tests/integration.test.ts` 中验证非权限行为的用例（`shell` cwd 用例、MCP `grow`/`grow-broken`/`bad-schema`/`shrink` 等无 `readOnlyHint` 的工具）在默认 `diagnose` 下会被 deny。逐条显式传 `permissions: { preset: "danger-full-access" }`（或最小 allow 规则）；不要为通过旧测试放宽默认预设。`mcp__echo__echo` 已声明 `readOnlyHint: true`，无需修改。运行全量 `npm test` 确认其余用例不受影响。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- tests/permissions-integration.test.ts tests/integration.test.ts`
Expected: PASS；随后 Run: `npm test`，Expected: 全部通过。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 0 error。

- [ ] **Step 7: 两轮 review gate**

第一轮审查装配顺序、失败清理、默认启用、外层 strict、旧测试迁移是否掩盖权限回归；第二轮红队 project trust 绕过、MCP trust 串扰、resume 前加载与 crash recovery 日志不变、resume 锁泄漏、内联覆盖/错误类型、空 workdir、配置错误后残留会话、`projectSkipped` 写失败与锁释放。修复后重跑 Step 5-6。

---

### Task 8: 文档、已知边界与整体验证

**Files:**
- Modify: `README.md`
- Modify: `docs/deferred-issues.md`
- Create: `dev-notes/M2-权限系统.md`
- Verify: 全量命令与两轮整体 review

**Interfaces:**
- Consumes: Task 1-7 的全部交付。
- Produces: 用户可操作的权限配置说明、已知边界登记、验证证据。

- [ ] **Step 1: 更新 README**

新增“权限与审批”章节，写明：配置文件路径与 trust 语义、四个预设、规则示例（含 `eq/glob/in/range`）、headless 下 ask→deny、审计事件、`RunOptions.permissions`、本轮不含 Web 审批。

- [ ] **Step 2: 登记 deferred-issues**

按现有编号续接（当前最大 D-111）新增六条，保留“触发升级条件”格式：

- `D-112` 阶段 1 审批通道只有库层接口，Web/SSE 未实现；ask 在 headless 一律 deny。
- `D-113` `paramsPreview` 可能包含最多 120 字符的敏感参数片段；需要脱敏策略时升级。
- `D-114` 权限规则是声明式匹配而非沙箱，不替代 shell 黑名单、fs 路径安全或 OS 隔离；需要强隔离时升级。
- `D-115` 串行批次第 N 条审计写失败时，前 N−1 条已执行但结果可能未落日志（崩溃窗口）；不声称端到端原子。
- `D-116` `executeBatch` / `query` 是内部 API，直接调用可绕过权限层（缺省 `permission` 保持 P0 行为）；安全边界入口是 `runSession`。
- `D-117` MCP 工具参数不应用 server `inputSchema` 默认值，参数规则只匹配模型实际提交的值。

- [ ] **Step 3: 追记 dev-notes**

在 `dev-notes/M2-权限系统.md` 增量记录：用户关键原话、spec/plan 路径、评审结论、被拒绝或纠偏的内容、翻车与返工。不得收尾一次性补记。

- [ ] **Step 4: 跑全量验证**

Run: `npm test`
Expected: 全部通过，live 测试跳过。

Run: `npm run coverage`
Expected: lines ≥ 85%。

Run: `npm run typecheck && npm run lint && npm run build`
Expected: 均 0 error。

Run: `npm run test:ui && npm run typecheck:web && npm run build:web`
Expected: 全部通过。

- [ ] **Step 5: 整体两轮 review**

第一轮：按 spec 逐节核对实现覆盖（规则、预设、管线、审计、配置、装配、失败路径），列出偏差并修复。
第二轮：独立红队，重点检查 Review Focus 五项、危险命令测试禁令、日志兼容与两轮 review 自身的证据（测试输出、覆盖率、文件路径）。

- [ ] **Step 6: 交付**

向用户汇报：

- 离线演示：`npm test -- tests/permissions-integration.test.ts`（诊断预设拒绝 fs 写 / danger-full-access 放行 / project 未 trust 跳过）。
- live 演示模板（需用户自备网关与模型）：

```bash
HARNESS_HOME=/tmp/harness-demo \
HARNESS_COMPAT_MODEL=<provider>/<model> \
node dist/demo/run.js "在当前目录写入 demo.txt"
```

默认 `diagnose` 下该调用返回 `permission_denied`；把 `$HARNESS_HOME/permissions.json` 设为 `{"version":1,"preset":"danger-full-access"}` 后重跑则写入成功。Windows 用临时目录的等价写法。

- 测试结果、覆盖率、dev-notes 路径、未提交说明。等待用户明确授权后再提交。

---

## Self-Review

- **Spec coverage:** §6 规则模型 → Task 1/2；§7 预设 → Task 3；§8 管线 → Task 5；§9 审计 → Task 4/6（含 `buildMessages` 忽略）；§10 配置与装配 → Task 2/7；§11 关系 → Task 3/5/6/8；§12 测试 → 各 Task；§13 交付 → Task 8。
- **Type consistency:** `ToolAccess` 在 `src/tools/types.ts` 定义、permissions 导入；`SourcedRule` 在 Task 1 定义、Task 2 产出、Task 3 消费；`PermissionCheckInput` 在 Task 1 定义、Task 5 调用；`PermissionDecisionPayload` 在 Task 6 定义并映射；`BatchOptions.permission` 在 Task 5 定义、Task 6 使用。
- **Review Focus coverage:** deny 不执行（Task 5）、project trust 与 MCP trust 独立（Task 2/7）、ask 不挂起（Task 4）、审计先于执行与 callId（Task 5/6）、并发、日志投影与前后端兼容（Task 4/5/6）。
- **Proportion:** 计划只固定接口、测试断言与关键算法，不复写实现代码。
