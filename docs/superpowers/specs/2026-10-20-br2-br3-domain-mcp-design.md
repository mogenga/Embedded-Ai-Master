# BR-2/BR-3 领域 MCP 设计（取证工具 + 诊断知识库）

> 版本：v1.0 · 日期：2026-10-20 · 状态：待实现
> 上游：`docs/BRD.md` §6 BR-2/BR-3、§11.2、§12；`docs/m2-roadmap.md` §3 阶段 2 任务 5/6。
> 本轮范围：BR-2 MVP（Renode 端到端 + OpenOCD 适配层）与 BR-3 骨架（KB 工具 + 回归）。BR-4 参数级策略、BR-5 沉淀闭环不在本轮。

## 1. 目标与非目标

### 目标

1. 以**独立 MCP server 进程**提供 BR-2 取证工具面与 BR-3 知识库工具面，内核 `src/` 不引入任何领域逻辑。
2. BR-2 在 Renode 上完成 `attach → halt → mem_read → mem_write（写前声明）→ reset → detach` 闭环，并能在 MCP 客户端经权限层调用。
3. BR-2 串口通道在 Renode socket 终端上完成 `serial_open → serial_status → serial_write → serial_read → serial_close` 通道闭环。
4. BR-3 迁移 Phase 0 KB 语料到本地资产目录，提供 `kb_lookup` / `kb_read` / `kb_search` / `kb_status`，无命中显式拒答。
5. BR-3 用本地回归集跑双轨指标（index / search）并输出可复现报告；语料缺失时测试显式 skip，不伪造结果。

### 非目标

- 不实现 BR-4 地址范围/端口白名单/复位门禁的参数级规则（M2 阶段 3）。
- 不实现 BR-5 `kb_propose` 沉淀闭环。
- 不实现真串口（`serialport` 原生依赖）与真机 OpenOCD 实测；只实现 OpenOCD 命令适配层与注入式单测。
- 不实现 Web 设备面板/回放（M3）。
- 不引入新运行时依赖；YAML 只解析 `index.yaml` 所需子集。

## 2. 技术栈与硬约束

- TypeScript + Node 24，ESM-only；相对导入带 `.js`；`strict`。
- MCP server 用 `@modelcontextprotocol/server` v2 + `@modelcontextprotocol/server/stdio` + Zod v4（已在 devDependencies）。
- 测试用 vitest；不触网；Renode 真实调用只在显式标记的 e2e 测试/脚本中执行。
- **危险命令禁令**：不得真实执行破坏性命令；OpenOCD/Renode 的进程调用在单测中一律注入 fake，只有 e2e 脚本可启动 Renode，且只操作仿真内存。
- **R1** LLM 永不直接控制仪器：工具只暴露仿真/调试探针操作，不暴露示波器/电源控制。
- **R2** 写前声明：`mem_write`、`serial_write`、`reset` 的返回体必须含 `declaration`，工具注解 `destructiveHint: true`。
- **R3** 工具诚实：读失败显式 `isError: true`；全 0 返回 `allZero: true` 且不得推断“无故障”；串口读超时返回 `timedOut: true` 且不伪造数据。
- 语料与查询集**只作本地资产**，加入 `.gitignore`，不提交；仓库不自包含 KB 内容。

## 3. 目录与构建

```text
mcp-servers/
  probe/
    server.ts          # stdio MCP 入口
    tools.ts           # 工具注册（纯函数，便于单测）
    backend.ts         # ProbeBackend 接口与共享类型
    renode.ts          # RenodeBackend + RenodeMonitor
    openocd.ts         # OpenOcdBackend + telnet transport
    serial.ts          # TcpSerial 通道
    fake.ts            # 测试用注入后端
    tests/*.test.ts
  kb/
    server.ts          # stdio MCP 入口
    tools.ts           # 工具注册
    service.ts         # KbService（index 解析 / lookup / read / search）
    yaml.ts            # index.yaml 子集解析器
    tests/*.test.ts
    kb/                # 本地语料（gitignore）
    data/              # 本地回归查询集（gitignore）
scripts/
  kb-regression.mjs    # 本地回归报告
  probe-e2e.mjs        # Renode 端到端演示/验证
```

- 新增 `tsconfig.mcp.json`：`include: ["mcp-servers"]`，`outDir: "dist-mcp"`，`noEmit: false`。
- 根 `tsconfig.json` 的 `include` 增加 `mcp-servers`，使 `npm run typecheck` 覆盖。
- `vitest.config.ts` 的 `include` 增加 `mcp-servers/**/*.test.ts`；coverage 阈值仍只统计 `src/**`，MCP server 覆盖率登记为后续项。
- `package.json` 新增脚本（不新增依赖）：
  - `"build:mcp": "tsc -p tsconfig.mcp.json"`
  - `"test:mcp": "vitest run mcp-servers"`
  - `"probe:e2e": "node scripts/probe-e2e.mjs"`
  - `"kb:regression": "node scripts/kb-regression.mjs"`
- MCP 配置示例（`<harness-home>/mcp.json`）：
  ```json
  {
    "mcpServers": {
      "probe": {
        "command": "node",
        "args": ["dist-mcp/probe/server.js"],
        "env": { "RENODE_PATH": "C:/Program Files/Renode/bin/Renode.exe" }
      },
      "kb": {
        "command": "node",
        "args": ["dist-mcp/kb/server.js"],
        "env": { "KB_ROOT": "mcp-servers/kb/kb" }
      }
    }
  }
  ```

## 4. BR-2 取证 MCP

### 4.1 工具面与注解

| 工具 | 输入 | 输出要点 | 注解 |
|---|---|---|---|
| `device_list` | 无 | 可用后端（renode/openocd）与可用性 | `readOnlyHint: true` |
| `device_status` | 无 | `structuredContent.deviceStatus`：backend/probe/serial/cpu | `readOnlyHint: true` |
| `attach` | `backend`、`platform?`、`monitorPort?` | 已连接设备信息 | `readOnlyHint: true`（只建连接，不改目标状态） |
| `detach` | 无 | 已断开 | `readOnlyHint: true` |
| `halt` | 无 | CPU 暂停 | `readOnlyHint: true`（观察性控制） |
| `resume` | 无 | CPU 恢复 | `readOnlyHint: true` |
| `reset` | 无 | `declaration` + 复位完成 | `destructiveHint: true` |
| `mem_read` | `address`、`length`（1..256） | bytes/hex/u32、`allZero`、`warning?` | `readOnlyHint: true`、`_meta.evidence: true` |
| `mem_write` | `address`、`bytes`（1..256） | `declaration` + 写后回读校验 | `destructiveHint: true` |
| `serial_open` | `port`、`host?` | 通道已打开 | `readOnlyHint: true` |
| `serial_status` | 无 | open/host/port/bytesRead/bytesWritten | `readOnlyHint: true` |
| `serial_read` | `maxBytes?`（1..4096）、`timeoutMs?`（0..10000） | hex/text/`timedOut` | `readOnlyHint: true`、`_meta.evidence: true` |
| `serial_write` | `data`（UTF-8 字符串） | `declaration` + bytesWritten | `destructiveHint: true` |
| `serial_close` | 无 | 已关闭 | `readOnlyHint: true` |

- `attach` 必须幂等：已连接时返回当前设备，不重复 spawn。
- `mem_write` 的 `declaration`：`{ operation: "mem_write", address, length, effect: "overwrite target memory" }`。
- `serial_write` 的 `declaration`：`{ operation: "serial_write", length, effect: "write bytes to serial peer" }`。
- `reset` 的 `declaration`：`{ operation: "reset", effect: "reset target CPU and peripherals" }`。
- 所有工具返回 `content: [{ type: "text", text: <JSON> }]` + `structuredContent`；错误返回 `{ isError: true, structuredContent: { code, message } }`。
- 未 attach 时调用设备工具返回 `code: "not_attached"`，不 spawn。
- 地址/长度非法返回 `code: "invalid_argument"`；读 Renode 命令失败返回 `code: "backend_error"` 并附原始输出（截断）。

### 4.2 Renode 后端

- 启动：`spawn(RENODE_PATH, ["-P", monitorPort, "--disable-gui", "--hide-log", "--plain"])`；`RENODE_PATH` 缺省 `C:/Program Files/Renode/bin/Renode.exe`。
- monitor 端口缺省用空闲端口（`net` 监听 0 后释放）；连接重试上限 15s。
- 命令协议：TCP 文本行，提示符 `(machine-0) `；串行队列，单命令超时 5s；错误识别 `No such command`、`There was an error executing command`、`does not provide`、`Parameters did not match`。
- attach 命令序列：
  ```text
  mach create
  machine LoadPlatformDescription @platforms/boards/stm32f4_discovery-kit.repl
  ```
  `platform` 参数可覆盖（相对 Renode 根目录或 `@` 开头）。
- halt=`pause`，resume=`start`，reset=`machine Reset`。
- 内存：按字节 `sysbus ReadByte 0x<hex>` / `sysbus WriteByte 0x<hex> 0x<hex>`；每 16 字节批量拼接，失败即中止并报错。
- Renode 对未映射地址返回 `0x00` 而非错误：`mem_read` 必须返回 `warning: "renode_all_zero_or_unmapped"` 当整段全 0，且 `allZero: true`；不得据此断言“无故障”。
- detach：发送 `quit`（容错），关闭 socket，`kill` 子进程，等待退出（2s 上限后强杀）。
- 进程退出/连接断开后，后续工具返回 `code: "backend_unavailable"`，状态回到 detached。
- 串口：`emulation CreateServerSocketTerminal <port> "cli"` + `connector Connect sysbus.usart2 cli`；MCP 侧 `serial_open` 连接 `host:port` TCP。无固件时读到的字节可能是 UART 噪声，返回体标注 `warning: "renode_uart_uninitialized"`，不得当证据。

### 4.3 OpenOCD 适配层

- `OpenOcdBackend` 实现同一 `ProbeBackend` 接口。**本轮 `attach` 只建立 telnet transport（127.0.0.1:4444 或缺省端口），不 spawn OpenOCD 进程**；使用前必须由用户自行启动 `openocd -f <config>`。原 `openocdConfig` 死参数已从 `AttachOptions` 移除，避免误导。
- 真机 OpenOCD 启动与板卡验证不在本轮范围，登记 D-157。
- 命令映射：
  - `halt` → `halt`
  - `resume` → `resume`
  - `reset` → `reset halt`
  - `mem_read` → `mdw 0x<addr> <words>`，解析 `0x<addr>: <hex words>`；尾字节用 `mdb`。
  - `mem_write` → `mww 0x<addr> 0x<word>`，尾字节用 `mwb`。
- 本轮只做命令构造与输出解析的单测（注入 fake transport），不启动真实 OpenOCD；真机实测登记 deferred（D-111 同类）。
- `openocd` 不可用时 `device_list` 返回 `available: false`，`attach` 返回 `code: "backend_unavailable"`。

## 5. BR-3 KB MCP

### 5.1 语料与索引

- 本地语料来源：`.worktrees/feat-rag-experiment/experiments/rag-vs-agentic-search/corpus/kb`（实测 108 个 md + `index.yaml` 90 条目 + `manifest.sha256`）。
- 迁移到 `mcp-servers/kb/kb/`，复制后逐文件比对 SHA-256，与 `manifest.sha256` 一致；不提交，`.gitignore` 忽略。
- 回归查询集来源：同目录 `data/queries.jsonl`（80 条：index 50 / search 30）、`data/negatives.jsonl`（25 条）；复制到 `mcp-servers/kb/data/`，同样不提交。
- 语料偏差必须记录在 README：108 md vs BRD 103；index 90 条 vs 85；11/80 gold 不在 index.yaml；46 个 frontmatter 非标准 YAML。
- `_inbox.md`、`cases/_about.md` 作为导航文件不参与检索；`kb_read` 可读但返回 `reviewStatus: "unreviewed"`。

### 5.2 工具

| 工具 | 输入 | 输出 |
|---|---|---|
| `kb_lookup` | `query`（非空）、`limit?`（1..10，默认 2） | `found`、`candidates[{path,title,summary,score}]`、无命中 `reason: "no_match"` |
| `kb_read` | `path`（相对 KB 根） | `path`、`content`、`frontmatter?`、`reviewStatus` |
| `kb_search` | `tokens`（1..8 个非空字符串）、`limit?`（默认 20） | `found`、`hits[{path,line,text,token}]` |
| `kb_status` | 无 | `root`、`fileCount`、`indexEntries`、`indexPresent` |

- 全部 `readOnlyHint: true`；`kb_read` 的 `_meta.evidence: true`（读到的内容可作为证据引用）。
- 路径安全：拒绝绝对路径、`..`、空路径、解析后不在 KB 根内、非 `.md`/`.yaml`、超过 1 MiB；错误 `code: "path_denied"` / `file_too_large` / `not_found`。
- `kb_lookup` 评分：对每个索引条目，`score = Σ(命中 keyword 的字符长度) + 2 × 命中 tag 数`；只做小写子串匹配（中文无需分词）；同分按 path 字典序稳定排序；`score = 0` 不返回。
- 技术 token 覆盖度：从 query 提取 ASCII token / 十六进制 / 型号，过滤英文停用词与 `CPU`/`MCU`/`SoC` 等泛指词。候选条目必须在 title/summary/path/keywords/tags 中覆盖技术 token；单个技术 token 必须命中，多个技术 token 必须覆盖超过一半。仅命中中文通用词（如“优化”“内存”“对齐”“没反应”）不足以支撑 `found: true`，此时按 `low_confidence` 拒答。
- `kb_search`：大小写不敏感逐行匹配；返回行号（1-based）与前后各 1 行上下文；排除 `index.yaml`、`_inbox.md`、`_about.md`；token 只做字面匹配，不做正则。
- 拒答：`kb_lookup` 空查询返回 `reason: "empty_query"`；无命中 `reason: "no_match"`；`kb_search` 无命中 `found: false`。不得返回编造内容。

### 5.3 回归

- `scripts/kb-regression.mjs`：读取 `KB_ROOT` 与 `mcp-servers/kb/data/queries.jsonl`、`negatives.jsonl`，输出 JSON 报告：
  - index 轨：Recall@2、严格 Hit@1（第一条候选命中 gold）、MRR、未命中列表；
  - search 轨：严格 Hit@1（第一条 hit 命中 gold）与 `goldInTop20`（gold 出现在 `search(tokens, 20)` 的任意命中中，不承诺排序）、未命中列表；
  - 负样本：拒答率、误报列表；
  - 分层：gold 是否在 `index.yaml` 中。
- 语料或查询集缺失时脚本退出码 2 并打印明确原因；测试文件在缺失时 `describe.skip`。
- 首次运行后把实测基线写入 `mcp-servers/kb/tests/regression-baseline.json`（只含计数与指标，不含语料），测试断言不低于基线。基线值必须在本地实测后填写，不得预设。

## 6. 验收

### BR-2

1. `npm run test:mcp` 全绿（含 Renode 命令构造、内存读写、错误路径、串口通道、OpenOCD 映射的注入单测）。
2. `npm run build:mcp` 通过；`node dist-mcp/probe/server.js` 能被 MCP 客户端列出 14 个工具。
3. `npm run probe:e2e` 在真实 Renode 上完成 attach → halt → read → write → reset → detach，输出 JSON 结果；写前后回读值一致。
4. 权限层验证：`mem_write`/`reset`/`serial_write` 在 `diagnose` 预设下评估为 `ask`（headless 为 deny），`mem_read` 为 `allow`；不真实执行危险命令。
5. 全 0 读取返回 `allZero: true` 与 warning，不输出“无故障”。

### BR-3

1. `npm run test:mcp` 中 KB 单测全绿（临时夹具 KB；含路径逃逸、空查询、无命中、frontmatter 容错）。
2. 本地语料存在时 `npm run kb:regression` 输出 index/search/负样本指标，且 index 与 search 轨不低于实测基线。**负样本拒答率 100% 是 BR-3 目标；2026-10-20 本轮实测为 84%（21/25），残余 4 条主题相邻但细节未覆盖的误报，差距与后续语义检索计划见 D-159。不得把 84% 声称为 100%。**
3. `kb_read` 拒绝越界路径；`kb_lookup` 无命中显式 `no_match`。
4. README 记录语料偏差与本地资产说明。

### 复验策略（本轮用户指定）

- 每个 Task 完成只做**一轮简单复验**：定向测试 + 必要类型检查；不派发完整 review。
- 允许把相邻 Task 合并复验。
- 全部 Task 完成后执行**标准两轮核验**：
  1. 第一轮：独立 reviewer 按本 spec + plan 审查（含测试诚实性、危险命令禁令、R1-R3）；
  2. 第二轮：复核第一轮结论 + 全量 `npm test`、`npm run typecheck`、`npm run build:mcp`、Renode e2e、KB 回归。

## 7. 风险与 deferred

| 项 | 处理 |
|---|---|
| 真串口需要 `serialport` 原生依赖 | 本轮不做；登记 deferred，安装命令交用户执行 |
| OpenOCD 未安装/无板卡 | 只做适配层 + 注入单测；真机实测登记 D-111 |
| Renode 无固件，串口无回显 | 通道闭环可验证；数据往返由固件/夹具提供，登记 deferred；UART 噪声标注 warning |
| KB 语料不入库 | 本地资产 + gitignore；README 说明；CI 中 KB 回归 skip |
| 仅 80 条自建回归集（BRD 基准 172+102） | 报告实测指标与分层偏差，不声称达到 BRD 全量基准 |
| `index.yaml` 90 条 vs BRD 85 条 | 按实测记录，不修改语料 |
| 46 个 frontmatter 非标准 YAML | `kb_read` 尽力解析，失败时保留原文并标注 `frontmatterParsed: false` |