# BR-2/BR-3 领域 MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以独立 MCP server 提供 BR-2 取证工具（Renode 端到端 + OpenOCD 适配）与 BR-3 知识库工具（lookup/read/search + 本地回归），内核不引入领域逻辑。

**Architecture:** 新增 `mcp-servers/probe` 与 `mcp-servers/kb` 两个独立进程；probe 通过 `ProbeBackend` 接口隔离 Renode/OpenOCD 后端，Renode 用 monitor TCP 协议，OpenOCD 用 telnet 命令映射；kb 用 `KbService` 解析 `index.yaml` 并做关键词/字面检索。测试通过注入 fake 后端/传输层完成，真实 Renode 只在 e2e 脚本中启动。

**Tech Stack:** TypeScript + Node 24（ESM-only）、`@modelcontextprotocol/server` v2、Zod v4、vitest、Renode 1.16（本地）。

**Spec:** `docs/superpowers/specs/2026-10-20-br2-br3-domain-mcp-design.md`

## Global Constraints

- ESM-only；相对导入带 `.js`；`strict`；不新增依赖。
- 内核不含领域逻辑：`src/` 不新增任何 probe/kb 代码；领域代码只在 `mcp-servers/`。
- 危险命令禁令：单测不得启动真实 Renode/OpenOCD，不得执行破坏性命令；仅 `scripts/probe-e2e.mjs` 可启动 Renode，且只操作仿真内存。
- R1：不暴露仪器控制；R2：`mem_write`/`serial_write`/`reset` 必须返回 `declaration` 且标 `destructiveHint`；R3：失败显式报错，全 0 不推断无故障，串口超时不伪造数据。
- 语料与查询集只作本地资产：`mcp-servers/kb/kb/`、`mcp-servers/kb/data/` 加入 `.gitignore`，不提交；测试缺失时 `describe.skip`。
- 复验策略（用户指定）：每个 Task 完成只做一轮简单复验（定向测试 + 必要 typecheck）；允许合并相邻 Task 复验；全部完成后执行标准两轮核验（Task 12）。
- 提交格式 `type(scope): 中文描述`，不合并 `main`。

## Review Focus

1. 领域代码不得进入 `src/`；`src/index.ts` 不得新增对 `mcp-servers` 的 import。
2. Renode 命令队列必须串行且能识别错误输出；失败不得伪装成功。
3. `mem_read` 全 0 必须返回 `allZero` 与 warning；`serial_read` 超时必须 `timedOut`。
4. `mem_write`/`reset`/`serial_write` 的 MCP 注解必须能被 manager 映射为 `write`，从而在 `diagnose` 下 `ask`。
5. KB 路径必须限制在 KB 根内；`_inbox.md` 不得被检索；无命中必须显式拒答。
6. 语料/查询集不得被 `git add`；提交前用 `git status` 检查。

---

### Task 1: MCP 领域层基建

**Files:**
- Create: `mcp-servers/probe/.gitkeep`, `mcp-servers/kb/.gitkeep`
- Create: `tsconfig.mcp.json`
- Modify: `tsconfig.json`, `vitest.config.ts`, `package.json`, `.gitignore`
- Test: `mcp-servers/probe/tests/bootstrap.test.ts`

**Interfaces:**
- 产出脚本：`build:mcp`、`test:mcp`、`probe:e2e`、`kb:regression`。
- `tsconfig.mcp.json`：`extends ./tsconfig.json`，`include ["mcp-servers"]`，`compilerOptions.outDir dist-mcp`，`exclude ["**/tests/**"]`。

- [ ] **Step 1: 写基建测试**

创建 `mcp-servers/probe/tests/bootstrap.test.ts`：

```ts
import { describe, expect, it } from "vitest";

describe("mcp-servers bootstrap", () => {
  it("keeps domain code outside src", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:mcp"]).toContain("tsconfig.mcp.json");
    expect(pkg.scripts["test:mcp"]).toContain("mcp-servers");
    expect(fs.existsSync("mcp-servers/probe")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run mcp-servers/probe/tests/bootstrap.test.ts`
Expected: FAIL，`build:mcp` undefined 或目录缺失。

- [ ] **Step 3: 修改配置**

- `tsconfig.mcp.json`：
  ```json
  {
    "extends": "./tsconfig.json",
    "compilerOptions": { "outDir": "dist-mcp", "rootDir": "." },
    "include": ["mcp-servers"],
    "exclude": ["mcp-servers/**/tests/**"]
  }
  ```
- 根 `tsconfig.json` 的 `include` 改为 `["src", "tests", "mcp-servers"]`。
- `vitest.config.ts` 的 `include` 增加 `'mcp-servers/**/*.test.ts'`。
- `package.json` scripts 增加：
  ```json
  "build:mcp": "tsc -p tsconfig.mcp.json",
  "test:mcp": "vitest run mcp-servers",
  "probe:e2e": "node scripts/probe-e2e.mjs",
  "kb:regression": "node scripts/kb-regression.mjs"
  ```
- `.gitignore` 增加：
  ```text
  dist-mcp/
  mcp-servers/kb/kb/
  mcp-servers/kb/data/
  ```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run mcp-servers/probe/tests/bootstrap.test.ts && npm run typecheck`
Expected: PASS；typecheck 无新增错误。

- [ ] **Step 5: 提交**

```bash
git add mcp-servers tsconfig.mcp.json tsconfig.json vitest.config.ts package.json .gitignore
git commit -m "chore(mcp): 搭建领域 MCP 构建骨架"
```

---

### Task 2: Renode monitor 客户端

**Files:**
- Create: `mcp-servers/probe/renode.ts`
- Test: `mcp-servers/probe/tests/renode-monitor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MonitorSocket {
    write(data: string): void;
    onData(listener: (chunk: string) => void): void;
    onClose(listener: () => void): void;
    close(): void;
  }
  export interface RenodeMonitorOptions {
    renodePath: string;
    monitorPort: number;
    platform: string;
    spawnImpl?: (command: string, args: string[]) => { kill(): void; onExit(listener: () => void): void };
    connectImpl?: (port: number) => Promise<MonitorSocket>;
    commandTimeoutMs?: number;
  }
  export class RenodeMonitor {
    start(): Promise<void>;
    send(command: string): Promise<string>;
    stop(): Promise<void>;
    get connected(): boolean;
  }
  ```
- `send` 串行队列；输出去掉命令回显与提示符；错误输出抛 `RenodeCommandError`（含 `command` 与 `output`）。

- [ ] **Step 1: 写失败测试**

用 fake socket 覆盖：
- 连续两次 `send` 只在前一次完成后发第二次；
- 提示符分片到达（`(machine-0` + `) `）仍能正确结束；
- 输出含 `No such command` 时 reject，错误含原始输出；
- `stop` 关闭 socket 并 kill 进程。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run mcp-servers/probe/tests/renode-monitor.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- 默认 `spawnImpl` 用 `node:child_process.spawn`，参数 `["-P", String(port), "--disable-gui", "--hide-log", "--plain"]`；stdio 忽略。
- 默认 `connectImpl` 用 `node:net.connect(port, "127.0.0.1")`，连接重试 60 次 × 250ms。
- 发送时记录 `pending`，累积 buffer；匹配最后一个 `\(machine-\d+\) `；截取后移除首行回显（等于命令）与尾部提示符。
- 错误模式：`No such command` / `There was an error executing command` / `does not provide` / `Parameters did not match` / `Renode is quitting`。
- 超时 reject；`stop` 幂等，socket 关闭后 kill，2s 后不再等待。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run mcp-servers/probe/tests/renode-monitor.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add mcp-servers/probe/renode.ts mcp-servers/probe/tests/renode-monitor.test.ts
git commit -m "feat(probe): 实现 Renode monitor 客户端"
```

---

### Task 3: Renode 后端

**Files:**
- Create: `mcp-servers/probe/backend.ts`, `mcp-servers/probe/renode-backend.ts`
- Test: `mcp-servers/probe/tests/renode-backend.test.ts`

**Interfaces:**
- Produces：
  ```ts
  export type ProbeBackendKind = "renode" | "openocd";
  export interface Declaration { operation: string; effect: string; address?: number; length?: number; }
  export interface MemoryReadResult { address: number; bytes: number[]; hex: string; allZero: boolean; warning?: string; }
  export interface SerialStatus { open: boolean; host?: string; port?: number; bytesRead: number; bytesWritten: number; }
  export interface DeviceStatus { backend: ProbeBackendKind | "none"; probe: "attached" | "detached"; cpu: "halted" | "running" | "unknown"; serial: "open" | "closed"; }
  export interface ProbeBackend {
    readonly kind: ProbeBackendKind;
    attach(options: AttachOptions): Promise<DeviceStatus>;
    detach(): Promise<void>;
    halt(): Promise<void>;
    resume(): Promise<void>;
    reset(): Promise<{ declaration: Declaration }>;
    readMemory(address: number, length: number): Promise<MemoryReadResult>;
    writeMemory(address: number, bytes: number[]): Promise<{ declaration: Declaration; verified: MemoryReadResult }>;
    serialOpen(host: string, port: number): Promise<SerialStatus>;
    serialRead(maxBytes: number, timeoutMs: number): Promise<{ bytes: number[]; hex: string; text: string; timedOut: boolean; warning?: string }>;
    serialWrite(data: Buffer): Promise<{ declaration: Declaration; bytesWritten: number }>;
    serialClose(): Promise<SerialStatus>;
    serialStatus(): SerialStatus;
    status(): DeviceStatus;
  }
  export class RenodeBackend implements ProbeBackend { constructor(env?: { renodePath?: string; monitorFactory?: (o) => RenodeMonitor }) }
  ```

- [ ] **Step 1: 写失败测试**

注入 fake monitor（记录命令、返回预设输出）：
- attach 发送 `mach create` 与 `machine LoadPlatformDescription @...`；
- halt/resume/reset 分别发送 `pause`/`start`/`machine Reset`；
- `readMemory(0x20000000, 4)` 发送 `sysbus ReadByte` 4 次并按小端拼 `0x78563412`；
- 全 0 结果 `allZero: true` 且 `warning` 存在；
- `writeMemory` 返回 declaration，写后回读；
- monitor 报错时 reject（不吞错）；
- 未 attach 调用 `readMemory` 抛 `not_attached`；
- detach 后 `status().probe === "detached"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run mcp-servers/probe/tests/renode-backend.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- 地址与长度校验：`Number.isInteger(address)` 且 `0 <= address <= 0xffffffff`；`length` 1..256。
- 字节序：`ReadByte` 结果按地址升序，`u32` 小端拼接（用于展示）。
- 写前 declaration；写后立即 `readMemory` 校验，不一致时抛错（不返回成功）。
- 串口部分在 Task 5 实现，本 Task 先抛 `not_implemented` 占位并测试该路径。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run mcp-servers/probe/tests/renode-backend.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add mcp-servers/probe/backend.ts mcp-servers/probe/renode-backend.ts mcp-servers/probe/tests/renode-backend.test.ts
git commit -m "feat(probe): 实现 Renode 后端与内存读写"
```

---

### Task 4: 探针工具面与 stdio server

**Files:**
- Create: `mcp-servers/probe/tools.ts`, `mcp-servers/probe/server.ts`
- Test: `mcp-servers/probe/tests/probe-tools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProbeToolSpec {
    name: string;
    description: string;
    inputSchema?: z.ZodTypeAny;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    meta?: Record<string, unknown>;
    handler: (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }>;
  }
  export function probeTools(backend: ProbeBackend): ProbeToolSpec[];
  ```
- `server.ts` 遍历 `probeTools(new RenodeBackend())` 注册到 `McpServer`，连接 `StdioServerTransport`。

- [ ] **Step 1: 写失败测试**

- 工具名集合等于 15 个：`device_list/device_status/attach/detach/halt/resume/reset/mem_read/mem_write/serial_open/serial_status/serial_read/serial_write/serial_close` + `probe_info`（第 15 个为 `probe_info`，返回后端能力）；
- `mem_write`/`reset`/`serial_write` 的 `annotations.destructiveHint === true`；
- `mem_read` 的 `meta.evidence === true`；
- 未 attach 时 `mem_read` handler 返回 `isError: true` 且 `structuredContent.code === "not_attached"`；
- 参数非法返回 `invalid_argument`；
- `device_status` 返回 `structuredContent.deviceStatus`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run mcp-servers/probe/tests/probe-tools.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- 统一 `ok(data)` / `fail(code, message)` 包装；`fail` 返回 `isError: true`。
- Zod schema：`mem_read {address: z.number().int(), length: z.number().int().min(1).max(256)}`；`mem_write {address, bytes: z.array(z.number().int().min(0).max(255)).min(1).max(256)}`；`serial_write {data: z.string()}`。
- 所有 handler 捕获异常并转为 `fail("backend_error", message)`，不吞掉。
- `server.ts` 只做注册与连接，不含业务逻辑。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run mcp-servers/probe/tests/probe-tools.test.ts && npm run build:mcp`
Expected: PASS；`dist-mcp/probe/server.js` 生成。

- [ ] **Step 5: 提交**

```bash
git add mcp-servers/probe/tools.ts mcp-servers/probe/server.ts mcp-servers/probe/tests/probe-tools.test.ts
git commit -m "feat(probe): 暴露取证工具面"
```

---

### Task 5: 串口通道

**Files:**
- Create: `mcp-servers/probe/serial.ts`
- Modify: `mcp-servers/probe/renode-backend.ts`, `mcp-servers/probe/tools.ts`
- Test: `mcp-servers/probe/tests/serial.test.ts`, `mcp-servers/probe/tests/probe-tools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class TcpSerial {
    constructor(connectImpl?: (host: string, port: number) => Promise<SerialSocket>);
    open(host: string, port: number): Promise<void>;
    read(maxBytes: number, timeoutMs: number): Promise<{ bytes: number[]; timedOut: boolean }>;
    write(data: Buffer): Promise<number>;
    close(): Promise<void>;
    status(): SerialStatus;
  }
  ```
- Renode 串口桥接：`serial_open` 时若尚未创建 socket 终端，先发送
  `emulation CreateServerSocketTerminal <port> "cli"` 与 `connector Connect sysbus.usart2 cli`。

- [ ] **Step 1: 写失败测试**

- fake socket 推送分片数据，`read` 在超时内返回已到字节；
- 无数据时 `read` 返回 `timedOut: true` 且字节为空；
- `write` 返回写入长度；
- `close` 后 `status().open === false`；
- `serial_open` 时 Renode 发送两条 socket 终端命令；
- `serial_write` 结果含 declaration；`serial_read` 的 `meta.evidence === true`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run mcp-servers/probe/tests/serial.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `TcpSerial` 用 `node:net`；数据缓冲上限 64 KiB，超出丢弃最旧并置 `overflow` 标志（返回体 warning）。
- `read` 等待 `data` 或超时；返回 `bytes`（最多 `maxBytes`），剩余留在缓冲。
- Renode 侧端口由 `serial_open` 参数给出；host 默认 `127.0.0.1`。
- 无固件时返回 `warning: "renode_uart_uninitialized"`（Renode 后端在 read 结果上附加），不影响 `timedOut` 语义。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run mcp-servers/probe/tests/serial.test.ts mcp-servers/probe/tests/probe-tools.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add mcp-servers/probe/serial.ts mcp-servers/probe/renode-backend.ts mcp-servers/probe/tools.ts mcp-servers/probe/tests
git commit -m "feat(probe): 实现仿真串口通道"
```

---

### Task 6: OpenOCD 适配层

**Files:**
- Create: `mcp-servers/probe/openocd.ts`
- Test: `mcp-servers/probe/tests/openocd.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TelnetTransport {
    send(command: string): Promise<string>;
    close(): Promise<void>;
  }
  export class OpenOcdBackend implements ProbeBackend {
    constructor(options: { transportFactory?: (host: string, port: number) => Promise<TelnetTransport> });
  }
  ```

- [ ] **Step 1: 写失败测试**

注入 fake transport：
- `halt` → `halt`；`resume` → `resume`；`reset` → `reset halt`；
- `readMemory(0x20000000, 4)` → `mdw 0x20000000 1`，解析 `0x20000000: 12345678` 为小端字节 `[0x78,0x56,0x34,0x12]`；
- 尾字节 `readMemory(0x20000000, 3)` → `mdw` + `mdb` 组合；
- `writeMemory` → `mww`/`mwb`，写后回读；
- transport 报错时 reject，错误含命令；
- `device_list` 能力：`openocd` 可用性由 `openocdPath` 存在性决定（注入 `existsImpl`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run mcp-servers/probe/tests/openocd.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `attach` 只建立 transport（不真实 spawn）；`startProcess` 方法留空/注入，真机实现在 deferred。
- 输出解析：`mdw` 行格式 `0x<addr>: <hex> <hex>`；按空格拆分，忽略非 hex。
- 字节序：OpenOCD 输出的是目标字节序（默认小端），按小端转换。
- 未 attach 时命令抛 `not_attached`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run mcp-servers/probe/tests/openocd.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add mcp-servers/probe/openocd.ts mcp-servers/probe/tests/openocd.test.ts
git commit -m "feat(probe): 实现 OpenOCD 命令适配层"
```

---

### Task 7: Renode 端到端脚本与权限验证

**Files:**
- Create: `scripts/probe-e2e.mjs`
- Create: `mcp-servers/probe/tests/probe-permissions.test.ts`
- Modify: `README.md`（新增 BR-2 配置与演示段落）

**Interfaces:**
- `probe-e2e.mjs` 输出 JSON：
  ```json
  { "backend": "renode", "attach": true, "halt": true, "read": "0x...", "writeVerified": true, "reset": true, "detach": true }
  ```
- 权限测试用 `evaluatePolicy` + `createMcpTools` 或直接构造 `ToolDef`，断言：
  - `mem_write`/`reset`/`serial_write` → `ask`（diagnose）；
  - `mem_read` → `allow`；
  - headless gate 不执行工具（mock execute 未调用）。

- [ ] **Step 1: 写脚本与失败测试**

`probe-e2e.mjs` 直接调用 `dist-mcp/probe/` 的 `RenodeBackend`（先 `npm run build:mcp`），流程：
1. attach `stm32f4_discovery-kit`；
2. halt；
3. `readMemory(0x20000000, 4)` 记录原值；
4. `writeMemory(0x20000000, [0x78,0x56,0x34,0x12])`；
5. 回读断言一致；
6. reset；
7. detach；
8. 恢复原值（若原值可写）并退出。

权限测试先写失败用例。

- [ ] **Step 2: 跑测试/脚本确认失败**

Run: `npx vitest run mcp-servers/probe/tests/probe-permissions.test.ts`
Expected: FAIL（工具未注册或策略动作不符）。

- [ ] **Step 3: 实现脚本与测试**

- 脚本用 `getFreePort` 分配 monitor 端口；`RENODE_PATH` 可覆盖；任何一步失败打印错误并以非 0 退出。
- 权限测试复用现有 `src/permissions/policy.ts`，构造与 `probe` 工具同名的 `ToolDef`（name `mcp__probe__mem_write`，annotations destructive），断言 `evaluatePolicy` 返回 `ask`。
- headless 断言：`PermissionGate` 无 prompter 时 `ask` → deny，mock `execute` 未被调用（只断言，不执行）。

- [ ] **Step 4: 跑复验**

Run: `npx vitest run mcp-servers/probe/tests/probe-permissions.test.ts && npm run build:mcp && npm run probe:e2e`
Expected: PASS；e2e 输出 `writeVerified: true`。

- [ ] **Step 5: 提交**

```bash
git add scripts/probe-e2e.mjs mcp-servers/probe/tests/probe-permissions.test.ts README.md
git commit -m "test(probe): 补齐 Renode 闭环与权限验证"
```

---

### Task 8: KB 语料迁移与 YAML 解析

**Files:**
- Create: `mcp-servers/kb/yaml.ts`
- Create: `mcp-servers/kb/tests/yaml.test.ts`
- Local assets (gitignored): `mcp-servers/kb/kb/`, `mcp-servers/kb/data/`
- Create: `mcp-servers/kb/README.md`

**Interfaces:**
- Produces:
  ```ts
  export interface IndexEntry { id: string; title: string; path: string; tags: string[]; keywords: string[]; summary: string; }
  export function parseIndexYaml(text: string): IndexEntry[];
  export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string; parsed: boolean };
  ```

- [ ] **Step 1: 迁移本地资产（只读复制）**

从 `.worktrees/feat-rag-experiment/experiments/rag-vs-agentic-search/` 复制：
- `corpus/kb/` → `mcp-servers/kb/kb/`
- `data/queries.jsonl`、`data/negatives.jsonl` → `mcp-servers/kb/data/`

复制后：
```bash
find mcp-servers/kb/kb -type f | wc -l
sha256sum -c mcp-servers/kb/kb/manifest.sha256   # 或逐文件比对
git status --short                                # 确认无 kb/ 与 data/ 文件被跟踪
```

- [ ] **Step 2: 写失败测试**

用内联夹具（不依赖本地语料）：
- 解析 `entries:` 列表、单行数组、引号、注释；
- 缺少必填字段抛错；
- frontmatter 含冒号值时 `parsed: false` 但 body 正确；
- 空文件返回空数组。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run mcp-servers/kb/tests/yaml.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现**

- 只支持 `index.yaml` 子集：顶层 `entries:`、`- ` 列表项、缩进键值、`[a, b]` 数组、单双引号、`#` 注释。
- 值中冒号不加引号时，仅在 `key: value` 的首个冒号分割；frontmatter 解析失败时 `parsed: false`，不抛错。
- 不引入 YAML 依赖。

- [ ] **Step 5: 跑测试确认通过并提交**

Run: `npx vitest run mcp-servers/kb/tests/yaml.test.ts && npm run typecheck`
Expected: PASS。

```bash
git add mcp-servers/kb/yaml.ts mcp-servers/kb/tests/yaml.test.ts mcp-servers/kb/README.md
git commit -m "feat(kb): 迁移语料并实现索引解析"
```

---

### Task 9: KbService

**Files:**
- Create: `mcp-servers/kb/service.ts`
- Test: `mcp-servers/kb/tests/service.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KbLookupResult { found: boolean; candidates: Array<{ path: string; title: string; summary: string; score: number }>; reason?: "no_match" | "empty_query" | "index_missing"; }
  export interface KbSearchHit { path: string; line: number; text: string; token: string; }
  export class KbService {
    constructor(root: string);
    lookup(query: string, limit?: number): KbLookupResult;
    read(relativePath: string): { path: string; content: string; frontmatter?: Record<string, string | string[]>; frontmatterParsed: boolean; reviewStatus: "reviewed" | "unreviewed" };
    search(tokens: string[], limit?: number): { found: boolean; hits: KbSearchHit[] };
    status(): { root: string; fileCount: number; indexEntries: number; indexPresent: boolean };
  }
  ```

- [ ] **Step 1: 写失败测试（临时夹具 KB）**

- `lookup("串口没输出")` 命中 `protocols/uart/no-output.md`，top-1；
- 空查询 `reason: "empty_query"`；无命中 `no_match`；
- `read("../secret.md")` 抛 `path_denied`；绝对路径拒绝；
- `read("protocols/uart/no-output.md")` 返回内容；
- `read("_inbox.md")` 返回 `reviewStatus: "unreviewed"`；
- `search(["UART"])` 大小写不敏感，返回行号；
- 排除 `_inbox.md`、`_about.md`、`index.yaml`；
- `status()` 统计文件数与索引条目。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run mcp-servers/kb/tests/service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- 用 `fs.realpathSync` 校验根与目标路径，目标必须以根 + `path.sep` 开头；拒绝符号链接逃逸。
- 文件读取上限 1 MiB；只允许 `.md`/`.yaml`。
- lookup 评分：`Σ 命中 keyword 长度 + 3 × 命中 tag 数`；`score > 0` 才返回；同分按 path。
- search 排除导航文件；逐行匹配，返回前后各 1 行上下文，`limit` 截断。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run mcp-servers/kb/tests/service.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add mcp-servers/kb/service.ts mcp-servers/kb/tests/service.test.ts
git commit -m "feat(kb): 实现检索与路径安全"
```

---

### Task 10: KB MCP 工具与 server

**Files:**
- Create: `mcp-servers/kb/tools.ts`, `mcp-servers/kb/server.ts`
- Test: `mcp-servers/kb/tests/kb-tools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KbToolSpec { name: string; description: string; inputSchema?: z.ZodTypeAny; annotations?: { readOnlyHint?: boolean }; meta?: Record<string, unknown>; handler: (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean }>; }
  export function kbTools(service: KbService): KbToolSpec[];
  ```
- `server.ts` 用 `KB_ROOT` 环境变量（缺省 `mcp-servers/kb/kb`）构造 service，注册 4 个工具并连接 stdio。

- [ ] **Step 1: 写失败测试**

- 工具名集合 `kb_lookup/kb_read/kb_search/kb_status`；
- 全部 `readOnlyHint: true`；`kb_read` 的 `meta.evidence === true`；
- 无命中返回 `structuredContent.found === false` 且 `reason === "no_match"`；
- 越界路径返回 `isError: true`、`code === "path_denied"`；
- 空 query 返回 `empty_query`；
- `KB_ROOT` 不存在时 `kb_status` 返回 `indexPresent: false`，不崩溃。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run mcp-servers/kb/tests/kb-tools.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- Zod schema：`kb_lookup {query: z.string(), limit: z.number().int().min(1).max(10).optional()}`；`kb_read {path: z.string()}`；`kb_search {tokens: z.array(z.string()).min(1).max(8), limit?: z.number().int().min(1).max(100)}`。
- 错误统一 `{ isError: true, structuredContent: { code, message } }`。
- 工具描述明确“无命中返回 found=false，不要编造”。

- [ ] **Step 4: 跑测试确认通过并构建**

Run: `npx vitest run mcp-servers/kb/tests/kb-tools.test.ts && npm run build:mcp`
Expected: PASS；`dist-mcp/kb/server.js` 生成。

- [ ] **Step 5: 提交**

```bash
git add mcp-servers/kb/tools.ts mcp-servers/kb/server.ts mcp-servers/kb/tests/kb-tools.test.ts
git commit -m "feat(kb): 暴露知识库 MCP 工具"
```

---

### Task 11: KB 回归与文档

**Files:**
- Create: `scripts/kb-regression.mjs`
- Create: `mcp-servers/kb/tests/regression.test.ts`
- Create: `mcp-servers/kb/tests/regression-baseline.json`
- Modify: `README.md`, `docs/deferred-issues.md`

**Interfaces:**
- 回归报告 JSON：
  ```json
  {
    "index": { "total": 50, "recallAt2": 0.0, "hitAt1": 0.0, "mrr": 0.0, "misses": [] },
    "search": { "total": 30, "hitAt1": 0.0, "misses": [] },
    "negatives": { "total": 25, "refusalRate": 0.0, "falsePositives": [] },
    "layers": { "goldIndexed": 0, "goldNotIndexed": 0 }
  }
  ```

- [ ] **Step 1: 写回归脚本**

- 读取 `mcp-servers/kb/kb` 与 `mcp-servers/kb/data/queries.jsonl`、`negatives.jsonl`；缺失时退出码 2。
- index 轨：`lookup(query, 2)` 的候选 path 包含 gold 即命中；计算 Recall@2、Hit@1、MRR。
- search 轨：用 gold 文件路径中的 token（查询自带 `tokens` 字段时优先）调用 `search`，命中 gold 即成功；无 `tokens` 时从 query 提取 ASCII token/十六进制。
- 负样本：`lookup` 返回 `found: false` 计为正确拒答。
- 输出表格与 JSON；不设通过阈值，退出码仅反映执行失败。

- [ ] **Step 2: 跑首次基线**

Run: `npm run build:mcp && npm run kb:regression`
记录实测指标；把指标写入 `regression-baseline.json`（只含数字与计数），并写入 dev-notes。

- [ ] **Step 3: 写回归测试**

- 语料/查询集缺失时 `describe.skip`；
- 存在时读取 baseline，断言 `recallAt2 >= baseline.index.recallAt2`、`hitAt1 >= baseline.search.hitAt1`、`refusalRate >= baseline.negatives.refusalRate`；
- 不硬编码未实测的阈值。

- [ ] **Step 4: 跑复验**

Run: `npx vitest run mcp-servers/kb/tests/regression.test.ts && npm run kb:regression`
Expected: PASS；报告与 baseline 一致。

- [ ] **Step 5: 更新文档并提交**

README 增加：
- BR-2/BR-3 的 MCP 配置示例、演示命令、Renode 路径；
- 语料本地资产说明与偏差（108/103、90/85、80 条自建集、11/80 未索引）；
- OpenOCD/真串口/真机未实测，登记 `docs/deferred-issues.md`（新增 D-112：真串口与真机 OpenOCD 验证；D-113：KB 语料不入库导致的 CI 覆盖缺口）。

```bash
git add scripts/kb-regression.mjs mcp-servers/kb/tests README.md docs/deferred-issues.md dev-notes/M2-BR23.md
git commit -m "test(kb): 建立双轨回归与文档"
```

---

### Task 12: 标准两轮核验

**Files:**
- Modify: `dev-notes/M2-BR23.md`（核验结论）

- [ ] **Step 1: 第一轮独立审查**

派发 reviewer 子代理，输入 spec、plan、`git diff main...HEAD`，按 Review Focus 1-6 逐条给结论；重点检查：
- `src/` 是否被污染；
- 单测是否真实覆盖失败路径、是否启动真实进程；
- R1-R3 与危险命令禁令；
- KB 路径逃逸与 `_inbox.md` 排除；
- 语料/查询集是否误提交。

- [ ] **Step 2: 修复第一轮问题并复验**

按审查结论修复；每项修复跑对应定向测试。

- [ ] **Step 3: 第二轮复核 + 全量验证**

Run:
```bash
npm test
npm run typecheck
npm run build:mcp
npm run probe:e2e
npm run kb:regression
```
第二轮 reviewer 复核第一轮结论与上述输出；记录最终结论到 dev-notes。

- [ ] **Step 4: 提交**

```bash
git add dev-notes/M2-BR23.md
git commit -m "docs(br2-br3): 记录两轮核验结论"
```