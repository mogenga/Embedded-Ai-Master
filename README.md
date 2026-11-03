<div align="center">

<img src="docs/assets/icon.png" width="128" alt="Embedded AI Master">

# Embedded AI Master

**面向嵌入式调试的 agent 工作台**

用一个能读懂工程、能操作探针、能查故障库和数据手册的 agent，替代「翻手册 → 猜原因 → 反复试」的排查循环。

[![Release](https://img.shields.io/github/v/release/mogenga/Embedded-Ai-Master?include_prereleases&color=blue)](https://github.com/mogenga/Embedded-Ai-Master/releases)
[![Download](https://img.shields.io/badge/download-Windows%20x64-2ea44f)](https://github.com/mogenga/Embedded-Ai-Master/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org)

[下载](#下载) · [能做什么](#能做什么) · [快速开始](#快速开始) · [文档](#文档地图)

</div>

---

## 下载

最新版 **v0.1.5**（2026-10-26）：Windows x64 NSIS 安装包约 113 MiB，在 [Releases](https://github.com/mogenga/Embedded-Ai-Master/releases/latest) 页。

> **安装包未做代码签名。** 首次运行 Windows 会显示「未知发布者」的 SmartScreen 提示——点「更多信息」→「仍要运行」。这是缺少签名证书所致（见 [`docs/code-signing.md`](docs/code-signing.md)），不是文件损坏。未签名构建里，应用内更新下载到的包也不做签名校验（D-217）。

## 能做什么

| | 能力 | 说明 |
|---|---|---|
| 🔌 | **接真实硬件** | 经 MCP 挂载探针后端：Renode 仿真、已运行的 OpenOCD。读写内存、复位、串口收发都要先声明（探针 server 需手工接入，见「领域 MCP」） |
| 🧰 | **驱动 Keil 工具链** | Keil uVision（UVSOCK）：`keil_debug` 57 个动作 + `keil_project` 14 个动作。只驱动本机已装的 MDK，不下载不捆绑 |
| 📚 | **查本地故障库** | 108 篇嵌入式调试语料 / 90 条索引；`kb_lookup` 首跳 + `kb_grep`/`kb_glob`/`kb_read` 的 agentic 检索循环（共 7 个工具） |
| 📄 | **查数据手册** | 工作区里的芯片 PDF：BM25 + 短语混合检索、整页读取、寄存器表启发式提取（4 个工具，依赖 `pdftotext`） |
| 🖥️ | **桌面诊断工作台** | 会话、文件树、串口助手、知识库、工具链包管理、计划条、托盘与应用内更新。纯 ES 模块，无框架无打包器 |
| 🔐 | **权限与审批** | `read-only` / `workspace-write` / `diagnose` / `danger-full-access` 四档预设，写操作逐次审批，决策写入会话日志 |
| 🌐 | **语料 OTA** | Ed25519 签名保证完整性；不自动应用，用户确认才下载——静默换语料会让「同一问题回答不同」不可解释 |

**它不做的事**：不代替人做安全判断（探针写内存前必须声明意图）、不猜故障（全 0 读数只报警告，不推断「无故障」）、不伪造能力（前端没有的内核能力就隐藏入口，不画假按钮）。工具链只保 Keil 一条链路——CubeIDE / ESP-IDF / Arduino 三套后端已于 2026-10-25 移除，不会出现在界面或工具列表里。

## 技术栈

- TypeScript + Node.js ≥ 24（ESM-only，禁止 CommonJS 混用）
- MCP 官方 TS SDK v2（`@modelcontextprotocol/client` / `server` / `server/stdio`）、Zod v4、Vitest v4
- 前端：纯 ES 模块（无框架、无打包器、无构建步骤），由 Electron 承载（打包用 `desktop/` 的 Electron 44；根 `package.json` 声明 45，见 D-209）
- 串口：宿主进程内直接用 `serialport` 13（原生模块，N-API）；agent 侧 `embed_serial` 仍走 PowerShell 泵
- 实时通道：NDJSON over stdio（桌面宿主 ⇄ 渲染器）

## Agent 主循环

内核是一台 **Query 生成器循环**（`src/loop/query.ts`，646 行）：一次会话的执行体本身是一个 `async function*`，向消费者流式吐事件。

```ts
async function* query(session, input, cfg) {
  await session.append(userEvent(input));            // 先落日志：model-visible 必须已 logged
  let turn = 0;
  while (true) {
    assertBreakers(cfg, ++turn, session.costUsed);   // 熔断：maxTurns / maxCostUsd
    const resp = await provider.complete(session.context(), signal);
    await session.append(assistantEvent(resp));
    yield* emit(resp);                               // 流式吐给 UI / headless
    const calls = collectToolUses(resp);
    if (calls.length === 0) return finish(session);  // 终止：模型不再调工具
    for await (const r of toolSystem.executeBatch(calls, signal))
      await session.append(toolResultEvent(r));
    if (contextOverBudget(session)) { await compaction.run(session); continue; }  // 续跑点 A
    if (resp.truncatedByMaxTokens) continue;                                     // 续跑点 B
  }
}
```

四个设计取舍：

| 决策 | 做法 | 为什么 |
|---|---|---|
| **状态机即循环** | `while (true)` 直到模型无工具调用；没有独立状态机类，turn 状态由循环变量 + 会话日志承载 | 日志即真相：进程崩了重放日志就能恢复，不用序列化一个状态机 |
| **续跑点只有 2 个** | 上下文超限 → 压缩后 continue；输出被 `max_output_tokens` 截断 → continue 让模型续写 | Claude Code 有 7 个，其中 5 个依赖 Anthropic 服务端特性（cache_edits 等），OpenAI 兼容协议下不存在 |
| **取消一条线贯穿** | `AbortController` 在循环入口创建，贯穿模型请求、工具执行、MCP 子进程 | 嵌入式串口是长读，用户取消必须**立刻**打断，不能等超时 |
| **批内只读并行** | 模型一次声明的多个 `tool_use` 为一批；批内只读工具并行、含写工具串行（判据是工具的 `readOnly` 标注） | 母本的读写分区 + 流式投机执行是给 60+ 工具设计的，我们内置 12 个 + MCP，收益不抵复杂度 |

同一条循环喂给两种形态，差别只在事件流的消费者：**headless CLI**（`src/demo/`）与**桌面工作台**（NDJSON over stdio）。这就是「一次诊断的日志能被原样回放」的结构基础。

细节见 `docs/p0-kernel-design.md` §1。

## Agentic Search 实验结论

**问题**：本地故障库检索该用向量 RAG，还是让 agent 自己多轮 grep？

2026-10-21 跑了一轮对照实验，四方案、80 条自建查询、单标注者（完整报告见 `experiments/rag-vs-agentic-search/docs/experiment-report.md`）：

| 方案 | Recall@2 | Hit@1 | MRR | P50 | P95 | 失败率 |
|---|---|---|---|---|---|---|
| **B Agentic search**（多轮 grep + 读） | **0.925** | **0.875** | **0.907** | 65.0 s | 101.5 s | 2.5% |
| A 向量 RAG | 0.800 | 0.725 | 0.796 | 106 ms | 136 ms | 0% |
| C′ BM25 + grep | 0.800 | 0.625 | 0.730 | **0.6 ms** | **1.1 ms** | 0% |
| C 现状基线 | 0.450 | 0.350 | 0.400 | 1.7 ms | 87 ms | 15% |

![四方案检索质量对比](experiments/rag-vs-agentic-search/results/diagnostic/c-diag/figures/fig4_schemes_quality.png)

![四方案延迟对比（对数轴）](experiments/rag-vs-agentic-search/results/diagnostic/c-diag/figures/fig5_schemes_latency.png)

两张图由 `experiments/rag-vs-agentic-search/scripts/plot_scheme_comparison.py` 从 `results/scored/main/overall.csv` 直接生成，不手录数字。

三条结论：前两条改变产品，第三条没有。

1. **维持无 RAG**——不引入向量召回层。理由比原计划更强：不是「A 没赢稀疏方案」（A 与 C′ 完全打平，差值 0.0pp），而是 **agentic 检索显著优于向量检索**（B 比 A 高 12.5pp，p_adj = 0.039）。
2. **实验里的 C′ 显著优于现状基线 C**（+35.0pp，p_adj = 9.9e−07），证明「廉价首跳 + 精确检索」这条路值得走；但它在本仓库的落地形态是**索引关键词首跳 + `kb_grep`/`kb_glob`/`kb_read` 循环**，不是实验里那个自实现的 BM25。
3. **B 的代价决定它只能离线跑**（P95 101.5 秒，每条约 1.9 万输入 token）。本产品**没有**实现「夜批 B」这条链路：`kb_grep` / `kb_glob` 的多轮检索是模型在交互回合里自己发起的，不等同于 B。

| | 交互链路（已部署） | 离线批量（仅实验） |
|---|---|---|
| **选谁** | 索引首跳 + KB 工具循环 | B Agentic search |
| **延迟** | 首跳 1 ms 级 | P95 101.5 s |
| **Recall@2** | 未在本部署协议下测量 | 0.925 |

**这不是「谁更好」的问题，是两个不同的点**：交互链路毫秒级拿到 0.8 的召回（实验中的 C′），B 用 100 秒换到 0.925。交互链路里 100 秒等于不可用，批处理里 1 毫秒的优点没有意义。

**部署形态与实验形态必须分开说**：实验里的 B 工具面只有 `glob`/`grep`/`read`、**没有 `kb_lookup`**，所以 **B 的 0.925 不能当作本部署的成绩**；B 的 H7（KB 外查询拒答）整块未评估。缺口登记在 D-179，KB 目录的 README 里也有同一句披露。

**B 的优势不来自评测集与语料同源**——已用覆盖率分层排除：低覆盖层 +18.8pp、高覆盖层 +23.5pp，相关系数 −0.018；而对照组 C′ 呈现典型的词频红利形态（低覆盖层 −12.5pp）。

> **这是探索性结果，不是确认性结论。** 预注册未冻结哈希，`score --confirmatory` 拒绝执行；样本 80 条（原设计 274 条），单标注者、无一致性系数。**方向已关闭，决策点 #2 未关闭**——剩余缺口见 `docs/rag-vs-agentic-search-todo.md` §7.4。

## 快速开始

```bash
npm install                 # 依赖（由你执行，本仓库的 agent 不代为安装）
npm run build               # 内核 → dist/
npm run build:mcp           # 领域 MCP → dist-mcp/
npm test                    # 全量测试（不触网）
```

桌面形态：

```bash
npm --prefix desktop install   # 一次性
npm --prefix desktop run desktop
```

headless demo（需要一个 OpenAI 兼容网关）：

```bash
HARNESS_COMPAT_MODEL=<provider>/<model> node dist/demo/run.js "读取平台信息后结束"
```

| 变量 | 说明 |
|---|---|
| `HARNESS_COMPAT_MODEL` | 必填，`<provider>/<model>` |
| `HARNESS_HOME` | harness 数据目录 |
| `HARNESS_COMPAT_BASE_URL` | 可选，覆盖 provider 的 `baseUrl` |
| `HARNESS_COMPAT_API_KEY_ENV` | 可选，覆盖 provider 的 `apiKeyEnv` |

退出码：`0` 正常完成（`finishReason: no_tool_calls`）/ `1` 熔断或非正常收尾 / `130` 取消 / `2` 用法或装配错误。demo 不读 `HARNESS_COMPAT_API_KEY`（该变量仅 live 测试使用）；密钥来自 `HARNESS_COMPAT_API_KEY_ENV` 指向的环境变量，也可以直接写进 `providers.json` 的 `apiKey`。

## 目录结构

```
src/                 内核（平台层，不含领域逻辑）
├── config/          providers.json / app-config / corpus.json 加载
├── context/         消息投影、上下文预算、三级压缩
├── corpus/          语料 OTA：manifest 验签、快照、更新、首次种子化
├── demo/            headless CLI 入口
├── events/          会话日志跟随（LogTailEventSource）
├── loop/            query 主循环（生成器）、事件类型、熔断、流式写入
├── mcp/             MCP stdio 客户端：配置合并、生命周期、工具适配
├── model/           OpenAI 兼容适配器、重试、token 估算、服务探测
├── permissions/     规则匹配、预设、审批 gate、审计
├── packs/           工具链包管理器（下载/校验/九阶段事务/注册表）
├── server/          宿主库层：会话运行器、审批桥、会话管理、KB 定位、文件 API
├── session/         append-only 分代 JSONL 会话
├── skills/          技能存储（提示词模板，四根两作用域）
├── tools/           工具契约与注册表、12 个内置工具、五阶段管线
└── index.ts         runSession 装配
mcp-servers/         领域 MCP server（probe / kb / serial / keil / datasheet）
                    embedded/ 是移植骨架，未注册工具、不随包种子
desktop/
├── main.js          Electron 主进程（窗口、IPC、宿主生命周期）
├── preload.cjs      contextBridge 桥
├── host/            host.js（NDJSON 分发器）、roots.js、serial-bridge.js、toolchains.js（Tools 页工具链探测）
├── renderer/        纯 ES 模块前端（app / protocol / settings / markdown / i18n / plan-summary）
└── MATRIX.md        前端命令/事件能力矩阵
scripts/             端到端脚本（probe、diagnosis、packs、kb/datasheet 回归、语料与签名发布）
config/              corpus.json（随包默认值）与 corpus.example.json（模板）
experiments/         RAG 对照实验的完整资产（Python，不进 npm 测试）
tests/               Vitest（tests/desktop 为桌面宿主与协议层）
docs/                设计、契约与已知问题
```

## 配置

全部配置都在 `$HARNESS_HOME` 下，缺省 `%USERPROFILE%/.harness`（Windows）或 `~/.harness`。

| 文件 | 内容 |
|---|---|
| `providers.json` | 模型服务：`protocol` / `baseUrl` / `apiKey` / `apiKeyEnv` / `models` / `requestTimeoutMs` / `maxResponseBytes` / `pricePerMillion` |
| `mcp.json` | `{ "mcpServers": { "<name>": { "command", "args", "env", "envAllowlist", "inheritEnv", "cwd", "timeoutMs", "disabled" } } }` |
| `permissions.json` | `{ "version": 1, "preset", "rules": [...], "approvalTimeoutMs" }` |
| `run.json` | `{ "maxTurns", "maxCostUsd", "timeoutMs", "systemPrompt", "reasoningEffortByModel" }` |
| `corpus.json` | 语料 OTA 的桶地址与 Ed25519 公钥（见「语料 OTA」） |

```json
{
  "local-gw": {
    "protocol": "openai-chat-completions",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "apiKey": "sk-…",
    "apiKeyEnv": "LOCAL_GW_KEY",
    "models": {
      "flash": {
        "contextWindow": 128000,
        "maxOutput": 8192,
        "supportsReasoning": true,
        "reasoningEffort": "medium"
      }
    },
    "requestTimeoutMs": 120000,
    "maxResponseBytes": 8388608,
    "pricePerMillion": { "input": 1, "output": 1, "cachedInput": 0.1 }
  }
}
```

- 模型引用是 `provider/model`。密钥解析优先直接填写的 `apiKey`，其次 `apiKeyEnv` 指向的环境变量；两者都拿不到非空值就**不发** `Authorization` 头（本地网关可空跑）。空字符串等于没填。
- 推理强度按 `provider/model` 单独存进 `run.json` 的 `reasoningEffortByModel`，缺席即 auto——请求体里完全不出现该字段，与显式 `"none"`（明确不要推理）不同。
- `apiKey` 是明文存放在本机配置文件里的，威胁模型与 `~/.ssh/id_*` 同级；它只进请求头，不进日志/事件/错误文案。
- `supportsReasoning` 缺省即「未声明」，界面不摆出会被丢掉的推理档位；`none` 与「字段缺席」是两件事（前者显式关闭，后者用服务商默认）。
- `pricePerMillion` 缺省时只统计 token、**不启用** `maxCostUsd` 熔断，`usage` 里也不会出现 `costUsd`——**未定价与「成本为 0」是两件事**。
- `contextWindow` 在设置页里有下拉（32K / 64K / 128K / 200K / 256K / 1M + 当前值），不在档位里的手写值会作为「自定义」选项保留；`maxOutput` 仍只走文件，表单保存时原样透传。未填时按估算默认值 128000 / 4096。
- **应用会写的四份配置（`providers.json` / `mcp.json` / `permissions.json` / `run.json`）都由「临时文件 + fsync + rename」原子替换**；内容非法时报错并保留原文件，不写坏。`corpus.json` 只读不写（手编或用模板）。设置页可直接编辑，不必手编。

项目级配置 `<工作目录>/.harness/mcp.json` 与 `.harness/permissions.json` **默认不加载**，需要 `trustProjectConfig: true` 或显式传路径；跳过时写一条 status 事件，不静默。

## 命令

```bash
npm test              # 全量单元/集成测试（不触网）
npm run test:watch    # 监听模式
npm run test:desktop  # 桌面宿主与协议层（tests/desktop）
npm run test:mcp      # 领域 MCP server 测试
npm run coverage      # 覆盖率（lines 阈值 85%）
npm run typecheck     # tsc --noEmit
npm run lint          # 目前等同 tsc --noEmit（D-006）
npm run build         # 内核 → dist/
npm run build:mcp     # 领域 MCP → dist-mcp/

npm run probe:e2e         # Renode 端到端：attach → 读 → 写 → 回读 → reset
npm run diagnosis:e2e     # 仿真复位基线取证（KB → probe → 权限 → 会话日志）
npm run packs:e2e         # 工具链包：装 → 验证可执行 → 卸 → 无残留（会真实下载）
npm run kb:regression     # KB 双轨回归（需要本地语料与查询集），--json / --baseline
npm run kb:review         # 知识沉淀的审核门禁
npm run datasheet:corpus  # 下载数据手册回归语料（需出网）
npm run datasheet:regression  # 数据手册检索回归（对基线比较）
node scripts/corpus-publish.mjs --help   # 语料签名发布
```

> `packs:e2e` 的默认条目是 pyOCD（目录里最小的可装条目，约 35 MiB）。2026-11-03 之前默认值是被 `f03473b` 移除的 Ninja，脚本每次都以「目录里没有」退出 1，现已改掉。

live 测试默认跳过，`HARNESS_COMPAT_LIVE=1` 显式开启：

```bash
# git-bash
HARNESS_COMPAT_LIVE=1 HARNESS_COMPAT_MODEL=local-gw/flash \
HARNESS_COMPAT_BASE_URL=http://127.0.0.1:8080/v1 \
HARNESS_COMPAT_API_KEY=your-key npm test

# PowerShell
$env:HARNESS_COMPAT_LIVE="1"; $env:HARNESS_COMPAT_MODEL="local-gw/flash"; $env:HARNESS_COMPAT_BASE_URL="http://127.0.0.1:8080/v1"; $env:HARNESS_COMPAT_API_KEY="your-key"; npm test
```

`HARNESS_COMPAT_API_KEY` 优先于 `apiKeyEnv`；headless demo 不读这个变量。

## 内置工具

`runSession` 默认注册 12 个工具（`createBuiltinTools()`，顺序固定：读类在前，写工具按改动范围从小到大）：

| 工具 | 能力 | 注解 |
|---|---|---|
| `echo` | 回显输入，连通性验证 | 只读 |
| `read` | 读文本文件（带行号，可分页） | 只读 |
| `ls` | 列一个目录的直接子项（不递归） | 只读 |
| `todo_write` | 替换整份待办列表 | 无注解，`access()` 固定 read |
| `write` / `edit` / `multiedit` | 覆盖写 / 单处替换 / 多处替换（全成或全不改） | 非只读、destructive |
| `shell` | 执行 shell 命令（**非沙箱**） | 非只读、destructive |
| `terminal_bg` / `terminal_bg_check` | 后台作业：启动即返回、按需查/杀 | bg 为 destructive；check 按输入动态判定 |
| `glob` / `grep` | 按模式找文件 / 按正则搜内容 | 只读 |

工具根（`ToolCtx.cwd`）是 `opts.cwd ?? header.workdir ?? process.cwd()`；新建会话时 `opts.cwd` 同时写入 `header.workdir`，resume 未传且与 header 不一致时抛 `SessionResumeError("workdir_mismatch")`。所有相对路径按工具根解析。

### 文件工具

- `read`：`path` + 可选 `offset`（0 起）/`limit`（≤2000 行）；单次最多 2000 行、256 KiB，超出以 `[truncated]` 标记并给 `detail.nextOffset`；`offset` 越界返回 `(no lines at offset)`。
- `ls`：逐行 `d <name>/` / `f <size> <name>` / `l <name>`（符号链接只标记**不跟随**） / `? <name>`，目录在前，最多 500 条。空目录返回 `(empty directory)` 而**不是空字符串**——否则与失败无法区分。刻意不套 `glob`/`grep` 的忽略清单：`ls` 是点名要看这个目录。
- `write` 自动建父目录，`content: ""` 是合法的空文件写入。`edit` 要求 `oldText` 唯一命中（`edit_not_found` / `edit_not_unique`），按文件现有 CRLF/LF 风格写。`multiedit` 按顺序应用，任一失败就一个字节都不改，`detail.index` 指出第几处。
- 路径越界（`..`、绝对路径、symlink/junction 逃逸）→ `path_outside_workdir`；Windows 保留设备名 → `reserved_name`；读类工具目标不是普通文件 → `not_a_file`。
- 四者都响应 `AbortSignal`，取消返回 `aborted`（写类会提示可能留下部分文件）。
- `todo_write` 只往会话日志里写一条 `todos` 事件、一个字节的文件都不碰（而每次工具调用本来就在写日志），所以用 `access: () => "read"` 覆盖注解推导，判为 read——判成 write 会让 `read-only` / `diagnose` 下的计划功能直接不可用，换不来任何安全收益。它替换整份列表，空数组表示「没有待办了」。
- **`fs` 已删除，不保留别名。** 旧版单工具用 `op` 分派读写，权限规则一旦漏写 `params`，一条读规则就会放行写。迁移：`{"tool":"fs","params":[{"key":"op","eq":"write"}]}` → `{"tool":"write"}`。

### `shell`

- **非沙箱**：交给系统 shell（`spawn(command, { shell: true })`），只对已知高危命令做黑名单拦截。`cwd` 必须位于工具根内，否则 `cwd_invalid`。
- 判定是「切段 → 剥包装 → 对内层串重新评估」的递归过程：`cmd /c`、`bash -c` / `sh -c` / `powershell -Command`（含无 `-Command` 的裸 powershell）、`env` / `nohup` / `timeout` / `nice` / `setsid` / `xargs` 都会被剥开；反引号与 `$()` 里的内层命令单独成段再判一次。
- 拦截前移除 token 内所有引号再归一目标（覆盖 `rm -rf "/"*`、`del /s /q "C:\"*`）；`rm` 带 `-r`/`--recursive` 或 `-f`/`--force` 且打 `/`、`~`、`$HOME`、多级 `..`、盘符根即拦截；初始位置按 **spawn 的真实 cwd** 判定（工作区根即视为根），`cd` / `pushd` / `chdir` / `Set-Location` 的状态是**粘性**的（`cd .` / `cd ..` 不会把位置洗回安全区）；`mkfs*`、`format <盘符>:`、`diskpart`、`bcdedit`、`shutdown`/`reboot`、`dd of=/dev/*`、`reg delete HKLM`、`cipher /w`、PowerShell `Remove-Item`、fork bomb 命中即返 `dangerous_command` 且**不 spawn**。
- 退出语义：跑完即 `isError:false`，首行 `exit=<code>`；**非零退出码不算工具错误**。被信号终止 → `shell_terminated`（`exitCode` 可能为 `null`）；spawn 失败 → `shell_spawn_failed`。
- 取消：Windows 用 `taskkill /T /F`、POSIX 杀 detached 进程组；1s 后升级，3s 仍未确认则返回 `shell_aborted` 并写 `abortEscalated`，Promise 必定 settle。
- stdout / stderr 各截断 1 MiB；`detail.stdout` / `detail.stderr` 只保留前 4096 字符摘要，完整输出在 `text`。
- 仍然是启发式：包装层剥了三轮补强，但 `env -C /`、`sudo -D /`、`git -C /` 一类改目录方式（D-087）与 `$'/'` / `${HOME:?}` / `$(...)` 这类 shell 展开（D-088）不在判定范围内；D-083 记录的总边界不变——**不能当作安全边界**。

### 后台作业

`terminal_bg` 立即返回，作业 `detached` 启动；`timeoutMs` 缺省 10 分钟、上限 24 小时，到点终止整棵进程树。输出只留 **64 KiB 尾巴**并同时报总字节与保留字节（只报保留量会让人把一段尾巴当成全部输出）。完成结果经 `background_result` 事件**写进会话日志**而不是临时提示——作业按定义比它所属的回合长，十分钟后的构建结果必须留到下次开窗。

`terminal_bg_check` 刻意不声明静态注解：注解描述不了「只有带 `kill: true` 才是破坏性」，声明 `readOnly` 会对 kill 路径说谎，声明 `destructive` 会把一次纯状态查询标成破坏操作。它改用 `access(input)` 按本次输入回答（`kill` → write，否则 read），权限门控优先读这个函数。

### `glob` / `grep`

- `glob`：pattern 匹配**相对工具根**的 POSIX 路径，`*` 不跨 `/`、`**/` 匹配任意层、段尾 `**` 匹配剩余；长度 ≤256、段数 ≤64，超限视为非法。返回字典序路径，最多 200 条；扫描上限 5000 个文件。
- `grep`：`pattern` 为正则（可选 `ignoreCase`），可加 `glob` 过滤与 `maxResults`（1–1000，默认 200）；`glob` 非法 → `invalid_pattern`，不静默无匹配。输出 `<路径>:<行号>:<文本>`。
- 遍历是**广度优先**且同层按名排序：预算耗尽时先覆盖的是根与浅层。旧的深度优先实现里，根目录靠前的缓存目录会吃光预算，`glob "**/README.md"` 会返回 `(no matches)`——看起来像「项目里没有这个文件」。截断时额外追加一行明确「结果不完整」并给出收窄做法。
- 跳过 `.git`、`node_modules`、`.harness`、`dist`、`coverage`、`build`、`out`、`target`、`.pio`、`cmake-build-*` 与常见语言缓存/虚拟环境（`.venv`、`__pycache__`、`.gradle`、`.next` …）。`.vscode` 与 `vendor` **不**跳过。清单是列举式的，新缓存目录不会自动被跳过。
- `grep` 只读 ≤2 MiB 的文件，含 NUL 视为二进制；跳过项分别计数并披露（不列具体路径，D-084）。`grep` 先收集全部命中再截断（D-078），正则同步执行、ReDoS 不可中断（D-085）。

## MCP 客户端

默认启用（stdio），启动时读取两级配置并连接所有未禁用的 server：用户级 `$HARNESS_HOME/mcp.json`、项目级 `<工具根>/.harness/mcp.json`（默认不加载）。

```json
{
  "mcpServers": {
    "probe": {
      "command": "node",
      "args": ["<仓库根>/dist-mcp/probe/server.js"],
      "env": { "RENODE_PATH": "D:/Renode/bin/Renode.exe" },
      "timeoutMs": 15000
    }
  }
}
```

- 字段级合并：同名 server 以 project 覆盖 user，`env` 按键合并；`cwd` 相对配置文件所在目录解析；`timeoutMs` 缺省 15000。未知字段经 `mcp_config_warning` 披露，不静默忽略。
- **环境变量默认只传** `PATH`/`HOME`/`USERPROFILE`/`SystemRoot`/`SystemDrive`/`windir`/`TEMP`/`TMP`/`PATHEXT`/`COMSPEC`/`SHELL`/`LANG`/`LC_ALL`/`TERM`。`inheritEnv: true` 恢复完整继承，`envAllowlist: ["KEY"]` 显式放行；`config.env` 始终覆盖。第三方 server 不应默认看到 provider API key。
- 连接失败只影响该 server（`mcp_connect_failed`），其余照常；配置 schema 非法记 `mcp_config_failed` 并跳过全部 MCP。所有状态都写进会话日志的 `mcp_status` 事件，宿主转为 dim/warn 提示。
- 工具暴露为 `mcp__<server>__<tool>`；非 `[a-zA-Z0-9_-]` 替换为 `_`，超 64 字符或与已有工具冲突时追加 `_<hash6>` 并记 `mcp_tool_name_renamed`。`_meta.evidence === true` 映射为证据结果，参与上下文压缩保护。
- 调用超时取 `min(timeoutMs, 120000)`；握手与 `listTools()` 各 15s。同一 server 串行、不同 server 并行。**超时/取消会终止 transport 并断开连接**，下次调用重连，避免残留调用与后续调用重叠。
- 破坏性工具在连接类错误后**不自动重试**（server 可能已执行但响应丢失），返回 `mcp_uncertain`，需重连并复核设备状态。非破坏性工具保持一次重连重试。
- 输出上限：单次调用合计最多 1 MiB，超出截断并标记；`inputSchema` 超过 64 KiB 的工具跳过并记 `mcp_tool_invalid_schema`；`description` 超过 4096 字符截断。
- `list_changed` 后刷新工具列表（3 次有界退避），失败保留旧集合并记 `mcp_tools_refresh_failed`。
- 仅支持 stdio；未启用 `subscriptions/listen`（D-190）。

## 权限与审批

权限层在工具执行前判定 `allow` / `ask` / `deny`，默认预设 `diagnose`。判定只决定是否调用工具——`allow` 之后仍然要过 `shell` 的黑名单与文件工具的路径边界。**权限规则是声明式匹配而非沙箱**（D-114）。

| 预设 | 只读 | 写 | 未知 |
|---|---|---|---|
| `read-only` | allow | deny | deny |
| `workspace-write` | allow | allow（仅 `write`/`edit`/`multiedit`；其余写仍 ask） | deny |
| `diagnose`（默认） | allow | ask | deny |
| `danger-full-access` | allow | allow | allow |

**工具属于哪一类**由注解推导：`destructive` → write，`readOnly` → read，两者都没声明（或同时声明）→ **unknown**；工具也可以提供 `access(input)` 按本次输入动态回答，此时优先读它。`diagnose` 下 unknown 是 **deny**，所以被默认拒绝的不只是写工具，还有所有没声明注解的 MCP 工具。探针的 `serial_open` 就是这类：它只写了 `readOnlyHint: false`、没写 `destructiveHint`，`diagnose` 下未显式授权时**直接拒绝**，不会弹审批——要放行就在 `permissions.json` 里给它一条 `allow`。`embed_serial` 反过来声明了 `destructiveHint` 并按动作给出证据/破坏性集合，`diagnose` 下走 `ask`。

规则按 inline → project → user 拼接，再追加预置的内置规则；求值时 `deny` 优先于 `ask`，`ask` 优先于 `allow`，同优先级取最靠前一条（`danger-full-access` 跳过 `ask`，但 `deny` 仍然生效）。规则语法：`tool` 支持 `*` / `?` 通配；`params` 是 `{key, eq|glob|in|range}` 谓词列表，四个操作符**必须且只能选一个**，`extentKey` 只能与 `range` 一起用（表示「从 `key` 起、跨 `extentKey` 个单位的区间」）。`key` 支持点号下钻与数组下标。配置由 Zod strict schema 校验，未知字段直接报错；错误抛 `PermissionConfigError`，`runSession` 启动失败，不忽略后继续。

```json
{
  "version": 1,
  "preset": "diagnose",
  "approvalTimeoutMs": 120000,
  "rules": [
    { "tool": "mcp__probe__mem_write",
      "params": [{ "key": "address", "range": [536870912, 536903679], "extentKey": "bytes" }],
      "action": "allow", "reason": "SRAM 调试窗口" },
    { "tool": "mcp__probe__reset", "action": "deny", "reason": "无人值守禁止复位" }
  ]
}
```

- `ask` 且有 `prompter`：等待审批，默认 120s，超时按拒绝；同一 gate 内串行。每次审批生成独立 UUID `requestId`，`callId` 保持模型原值——`requestId` 是审批与决策的唯一配对键。
- `ask` 且没有 `prompter`（headless、未注入审批桥）：一律 `effective: "deny"`、`reason: "approval_unavailable"`，工具不执行。
- 审批器返回的映射：批准 → `approval_granted`；拒绝 → `approval_denied`；超时 → `approval_timeout`；取消 → `approval_aborted`；审批器异常 → `approval_error`。
- **审计**：每次进入判定的调用先写 `permission_decision` 事件再执行。payload 含 `requestId` / `callId` / `tool` / `action` / `effective` / `reason` / `preset` / `source` / `paramsDigest`（参数规范化的 SHA-256 前 16 位）/ `paramsKeys` / 可选 `paramsPreview`（可能含敏感片段，D-113）/ `access`。该事件不进模型上下文，回放时忽略。
- MCP 工具参数 schema 是 `z.unknown()`，不应用 server `inputSchema` 的默认值。需要按默认值判定时必须在规则或提示里要求模型显式提供（D-117）。
- 领域策略模板（SRAM 写窗口、串口白名单、复位拒绝）见 `mcp-servers/probe/permissions.example.json`；模板**不会自动加载**，复制到 `.harness/permissions.json` 后才生效。

## 上下文压缩

长会话三级处理，**只改模型视图，不删改会话日志与 artifacts**：

1. **一级落盘**：单个工具结果超过 8000 tokens（UTF-16 长度 / 4 估算）写入会话目录 `artifacts/`，模型消息截断到约 25000 tokens 并附完整路径。
2. **二级 microcompact**：估算 token 超过 `contextWindow * softRatio`（0.8）后，把**非 evidence**、非最近 `keepRecentTurns`（2）轮、未 elide 的工具结果替换为占位（有 `artifactPath` 保留路径，否则保留 `<toolName>: <首行 120 字符>`）。只追加 `compaction` 事件，原始 `tool_result` 仍在。
3. **三级 autocompact**：仍超阈值时用同一模型把 `coversUpToSeq` 之前的历史摘要为纯文本，尾部按 `keepTailRatio`（0.16）保留 verbatim。摘要写成 `role: system` 的 `[Conversation summary]`。边界若落在批次中间或会覆盖 evidence 则回退；失败追加 `compaction {kind:"failed"}`，不静默成功。摘要落日志后重新测量，仍超则执行 **emergency microcompact**（忽略 `keepRecentTurns`，仍排除 evidence），再超才 `failed{reason:"still_over_budget"}`。

- evidence 保护：`ToolResultPayload.evidence === true` 的结果不被二级/三级修剪；投影层拒绝覆盖 evidence 的 summary。MCP 工具经 `_meta.evidence` 同路径保护。
- 参数校验：`0 < keepTailRatio < softRatio < 1`，`keepRecentTurns` 非负整数，否则入口抛 `TypeError`。`compaction.enabled: false` 只保留原有预算检查。
- 压缩会改变消息前缀，可能打断 provider 的 prompt cache（D-091）；摘要无完整性校验（D-092）。完整算法与失败语义见 `docs/p0-kernel-design.md` §3。

## 系统提示词（当前没有）

**内核不内置系统提示词。** 默认新会话发给模型的请求里一条 `system` 消息都没有，`messages` 直接从 `user` 开始——模型收到的全部指令就是工具描述加上用户敲的话（D-221 有抓包证据）。

设置页「行为 → 系统提示词」填的内容就是唯一的一条 `system` 消息，规则是：

- **只对新会话生效**。内核不允许给「日志里没有 `system` 事件的历史会话」凭空补一条（同一份日志的两次投影会得到不同输入），所以填了之后**旧会话一律续不上**，报 `system_prompt_mismatch`。要先清空这个设置，或者新建会话。
- 一旦某个会话写下 `system` 事件，之后每次 resume 都必须传**完全相同**的文本，否则同样报错。
- 分节组装（base / environment / tools / instructions / memory / summary）的设计草案在 `docs/system-prompt-design.md`（v0.2，2026-11-01 定稿，**尚未实现**）。

## 会话

```
$HARNESS_HOME/sessions/<id>/
├── header.json          # id、createdAt、status、provider、model、workdir、forkedFrom
├── meta.json            # 界面侧：标题、置顶、归档（与 header 分离）
├── session.v1.jsonl     # 首代事件日志
├── session.vN.jsonl     # 单代超过 50 MiB 后按需生成
└── artifacts/           # 工具产物
```

- **append-only + 投影**：重建给模型的每一个 token 都能从日志派生，回放、恢复、可复现因此是同一份事实的不同读法。压缩也只改投影。
- 分代：append 前按字节判断，仅当当前代非空且追加后会越阈值才新建；代编号必须从 v1 连续，缺档抛 `SessionCorruptionError`。
- 目录锁：`createSession` / `resumeSession` / `forkSession` 持有 `session.lock`（`O_EXCL`）直到 `close()`；另一存活进程持锁 → `session_locked`；持有者崩溃后按 PID 存活自动回收。
- `header.status` 为 `open` / `closed`，`close()` 用临时文件 + `fsync` + rename 原子写，重复 close 幂等。
- **resume**：必须显式给 `sessionDir`。`model` 与 `header.model` 不一致 → `model_mismatch`；`sessionId` 不一致 → `session_id_mismatch`；`systemPrompt` 冲突 → `system_prompt_mismatch`；均在最首个 `next()` 前抛出、不写 header/日志。崩溃尾部恢复：最后一个 assistant 批次的 `toolCalls` 缺 `tool_result` 时按原顺序补 `tool_result_lost` 并追加 `interrupted {reason:"crash_recovery"}`。
- **fork**（桌面右键「复制为新会话」走 `session-admin`；库 API 是 `forkSession`，`runSession` 没有这一步）：`atSeq` 必须使前缀可被 `buildMessages` 投影（批次闭合），否则 `not_turn_boundary`；artifact 复制到新会话并重写路径。

```ts
// resume：sessionDir 必填
for await (const event of runSession({ input: "继续排查", model: "local-gw/flash", resume: true, sessionDir: "…/sessions/<id>" })) { /* ... */ }

// fork：构建后为 dist/session/persistence.js
const child = await forkSession(sourceDir, atSeq, { id: "branch-1", targetDir: "…/branch-1" });
```

fork 的 `opts.id` 不得与源会话相同，`targetDir` 不得位于源目录内（否则 `invalid_target`）；target 已存在（含空目录）→ `target_not_empty`，失败时回滚本次写入并释放锁。源 artifact 缺失标 `detail.artifactMissing = true`，越界/非普通文件标 `detail.artifactRejected = true`，都保留原路径且不阻塞 fork。
- 运行器：同一会话同时只允许一次运行；`maxTurns` **默认不限制**，填正整数才生效（0 / 负数 / 非整数以 `invalid_run_limits` 拒绝，不静默当成「不限」）；`maxCostUsd` 是**会话总预算**，会把历史 `usage` 算进去。

运行请求 `{ "text", "sessionId"?, "mode"?, "maxTurns": null, "maxCostUsd": 0.5, "timeoutMs": 60000, "systemPrompt"? }`；`mode` 只对这一次 run 生效。

| `RunnerError.code` | 条件 |
|---|---|
| `invalid_text` | `text` 为空/纯空白、超过 8000 字符 |
| `invalid_session_id` / `invalid_mode` / `invalid_model` | 会话 id、权限预设、模型引用非法 |
| `invalid_run_limits` | `maxTurns` 非正整数（`null` 合法）/ `maxCostUsd` / `timeoutMs` 非正，`systemPrompt` 非字符串 |
| `invalid_cwd` | `cwd` 不是已存在的绝对路径目录 |
| `unknown_session` / `session_corrupt` / `session_unreadable` | 会话不存在 / header 损坏 / header 不可读 |
| `session_busy` | 同会话正在运行 |
| `model_unavailable` | providers 缺失/无效/引用无效（消息里 home 路径脱敏为 `HARNESS_HOME`） |
| `session_start_timeout` / `runner_unavailable` | header 未能 10s 内落盘 / 运行器已关闭 |

`runner.decide(sessionId, requestId, "allow"|"deny")` 的 `kind`：`accepted` / `duplicate` / `unknown_request` / `expired` / `already_decided` / `unknown_session` / `runner_unavailable`。**`accepted` 只表示决策已送达 gate，不表示工具已执行**——终态以会话日志的 `permission_decision` 为准，渲染器不本地伪造。服务重启后未决审批丢失，`resumeSession` 会补 `approval_aborted: crash_recovery`。

## 领域 MCP

内核不含领域逻辑；探针、知识库、串口、Keil、数据手册一律经 MCP 挂载。全部先 `npm run build:mcp`，再把 `dist-mcp/<server>/server.js` 的绝对路径写进 `mcp.json`。

**首启自动接入**：桌面宿主第一次启动时，按「产物存在就写、用户已配不覆盖、失败如实上报」的规矩把 `kb`、`serial`、`keil`、`datasheet` 四台 server 写进 `$HARNESS_HOME/mcp.json`。`probe` **不在种子清单里**，要自己配（下面「探针」一节有示例）。

| server | 工具 | 能力来源 |
|---|---|---|
| `probe` | 14 个（`device_list` / `attach` / `halt` / `resume` / `reset` / `mem_read` / `mem_write` / `serial_*` …） | Renode 仿真、已运行的 OpenOCD telnet |
| `kb` | 7 个（`kb_lookup` / `kb_glob` / `kb_grep` / `kb_read` / `kb_search` / `kb_status` / `kb_propose`） | 本地语料快照 + `index.yaml` |
| `serial` | `embed_serial`（read / write / ports / status / open / close） | 面板环形缓冲镜像，或自己开一次性捕获 |
| `keil` | `keil_debug`（57 动作）、`keil_project`（14 动作） | 本机 UV4.exe + UVSOCK |
| `datasheet` | 4 个（`datasheet_search` / `datasheet_read` / `datasheet_registers` / `datasheet_status`） | 工作区 PDF + `pdftotext` |

> CubeIDE / ESP-IDF / Arduino 三套后端与 `embed_project` 路由门面已于 2026-10-25 从产品移除（`f03473b`，breaking）。`mcp-servers/embedded/` 是移植骨架：只有 schema 与阶段表，**没有注册任何工具、也不在任何种子清单里**，不要把它当成可用的 server。

### 探针（BR-2）

写内存、复位、串口写入标了 `destructiveHint`，`diagnose` 下为 `ask`，headless 降级为拒绝。写操作返回 `declaration` 声明；`mem_read` 全 0 只返回警告，**不推断「无故障」**。`serial_read` 响应取消，abort 后返回 `aborted`。`serial_open` 只写了 `readOnlyHint: false`（没写 destructive），属于 unknown 类——`diagnose` 下**直接拒绝**，要放行须在 `permissions.json` 里给它一条 `allow`（模板见 `mcp-servers/probe/permissions.example.json`）。

**探针 server 不在首启种子清单里**，需要手工加进 `mcp.json`（见上一节的配置示例）。面板的 Serial tab 不依赖它——那条链路走宿主进程内的 `serialport`。

```bash
npm run probe:e2e   # Renode：attach → 读 0x20000000 → 写 78 56 34 12 → 回读 → reset → detach
```

成功输出 `{"backend":"renode","attach":true,...,"writeVerified":true,...}`；`dist-mcp/` 缺失退出码 2，其余失败退出码 1。OpenOCD 后端本轮只做「连接已运行的 telnet」（`attach` 不 spawn），真机验证登记 D-157。

### 知识库（BR-3）

部署形态是 **lookup 首跳 + glob/grep/read 的 agentic 循环**，不等同于对照实验里被测量的方案 B（B 没有 `kb_lookup`）。实验里 B 的 Recall@2 0.925 不能算到本部署头上，B 的 H7（KB 外查询拒答）也未评估——这个缺口仍在（D-179）。

- `kb_lookup` 用关键词打分做廉价首跳，可能漏召回；未命中应继续用 `kb_grep` / `kb_glob`，不要断言 KB 没有相关内容。
- `kb_glob` / `kb_grep` 单次最多 100 条；`truncated`（返回条数被截）与 `scanTruncated`（遍历预算 20000 文件用尽）是两件事，后者意味着未命中不代表不存在。
- `kb_read` 分页（默认且上限 2000 行），标 evidence。
- `kb_propose` 只追加待审 inbox；未审内容不参与检索。inbox 位置可经 `KB_INBOX_PATH` 配到语料根之外（OTA 形态），`kb_status` 用 `inboxPath` / `inboxExternal` 如实回报。
- `_inbox.md` 与 `_reviewed.md` 永不进快照、永不被替换；发布侧跳过、验签侧硬拒。

语料与查询集是**本地资产，不进版本库**（`.gitignore` 已忽略 `mcp-servers/kb/kb/` 与 `mcp-servers/kb/data/`），重新获取方式见 `mcp-servers/kb/README.md`。当前实测 108 个 md / 90 条索引（BRD 基线 103 / 85），自建查询 80 条、负样本 25 条。

```bash
npm run kb:regression -- --json     # 双轨指标
npm run kb:review -- --list         # 待审提案
npm run kb:review -- --accept <id> --target <正式条目>   # 指标不降才接受
```

2026-10-20 基线（下限，非目标）：index 轨 Recall@2 0.44 / Hit@1 0.38 / MRR 0.41；search 轨严格 Hit@1 0.1333 / `goldInTop20` 0.4333；负样本拒答率 0.84。`kb_lookup` 对英文用 ASCII 词边界、按未登录 token 比例折减，折减后低于 1.75 返回 `low_confidence`；`优化`、`对齐` 这类孤立短词会拒答，`串口没输出` 仍可命中。详见 `mcp-servers/kb/README.md`。

### Keil 工具链（BR-4）

`keil` server 只服务 Keil MDK 一条链路：`keil_debug` 57 个动作、`keil_project` 14 个，驱动本机已授权的 `UV4.exe` 与 UVSOCK。不下载、不捆绑、不重分发任何 Keil 组件。

- **工程发现**：先找 `.uvprojx`（含 `.uvproj`），跳过 `OBJ` / `build` / `DebugConfig` / `RTE` 等输出目录，也跳过 `.orig` / `.bak` 备份。
- **工程编辑要等 uVision 退出才落盘**：`add_group` / `add_file` / `set_option` 在 uVision 关闭时才写回 `.uvprojx`——`SUCCESS` 不代表文件已变，这是 uVision 的行为。
- **烧录会自动让出探针**：`flash` 前先关闭同工程的调试会话（否则两个 uVision 抢同一个 ST-Link），下载后回读校验；调试状态（断点、运行位置）因此会丢，需要重新 `open`。
- **整片擦除不可用**：`PRJ_FLASH_ERASE` 在 MDK 5.43.1 上无响应（无回复、无错误帧、无弹窗），`erase` 如实报错而不是伪装成功；`flash` 只擦除镜像自身占用的扇区（实测 0x08010000 处的标记在 `UV4 -f` 后仍在）。`capabilities` 会列出 14 条实测不可用的操作。
- **只回传日志原文**：构建诊断不做「文件:行号」结构化解析。
- 见 `docs/keil-headless.md`。

`diagnose` 下运行控制、烧录、擦除、写参数、改工程为 `ask`，headless 降级为拒绝；取证读数带 `evidence`（`registers` / `variables` / `stack` / `read` / `disassemble` / `flash` …），破坏性动作带 `declaration`。

### 数据手册（PDF 检索）

把工作区里的芯片数据手册 / 参考手册变成可检索、可整页读取的 MCP 工具。语料由你放进工作区（`DATASHEET_ROOT`，缺省进程 cwd），**不联网下载厂商 PDF**。

- `datasheet_search`：**BM25 词频 + 整短语加成的混合排序**，零依赖手写；每份文件报最高分页。查询的每个 token 都必须至少在一份手册里按词边界出现过，否则如实返回无命中——乱拼的寄存器名不会拿泛词页凑数。
- `datasheet_read`：按相对路径 + 1-based 页码读整页文本（`pdftotext -layout`，保留列对齐），单次至多 50 页 / 512 KiB。
- `datasheet_registers`：从页文本按三个稳定版式（标题行 / `Address offset` / `Bit` 行）启发式提取结构化寄存器表，低置信度的表直接丢弃，每张表带 `sourcePage`。**引用位定义或复位值前必须用 `datasheet_read` 读原页核对**——表格换行会把位域描述拆断。
- `datasheet_status`：检索根、`pdftotext` 是否可用、缓存统计。**缺 `pdftotext` 时其余工具返回带安装指引的显式错误，不是「无命中」**；扫描件（无文本层）在 `skipped` 里如实报。
- 页级缓存放在 `<root>/.datasheet-mcp/`，可用 `DATASHEET_CACHE_DIR` 挪走；缓存纯加速，删掉行为一致。

```bash
winget install oschwartz10612.Poppler     # Windows 装 pdftotext
npm run datasheet:corpus                  # 下载回归语料（需出网）
npm run datasheet:regression              # 跑批 + 与基线比较
```

基线（2026-10-24，RM0008 + RM0090，50 条金查询 / 25 条负例）：R@2 1.0 / Hit@1 1.0 / MRR 1.0 / 负例误报 1/25。**R@2 = 1.0 的口径必须如实说**：gold 页码取自首跑 top-1（自标注），它防的是未来改动退化，不是独立人工标注的绝对质量。详见 `docs/datasheet-mcp.md` 与 `mcp-servers/datasheet/README.md`。


## 工具链包管理器

`src/packs/`（平台层，多 MCP server 共用的基础设施）实现按需下载的编译工具链包。当前目录是 **4 条 Windows x64 条目**：Arm GNU Toolchain 15.3.rel2、Arm GNU（xPack 14.2.1）、CMake 4.2.3、pyOCD 0.46.0，URL 与 SHA-256 全部钉死。安装是九阶段事务（preflight → lock → download → verify → list → extract → inspect → validate → commit），半装状态不可见、断电可恢复、根目录级 `.lock` 防 CLI 与桌面双入口竞争。桌面设置页 Tools 已接通装/卸/进度/磁盘统计；keil MCP server 经注入读取已装 pack 的 bin 目录（无系统 PATH 也能找到工具链）。结构、不变量与权限语义见 `docs/toolchain-packs.md`。

```bash
npm run packs:e2e   # 默认装 pyOCD（~35 MiB 真实下载）→ 验证可执行 → 卸 → 无残留
```

根目录由 `HARNESS_TOOLCHAIN_HOME` 覆盖（默认 `%LOCALAPPDATA%\Embedded-Ai-Master\toolchains`）；`dist/` 缺失时退出码 2 并提示 `npm run build`。默认测试不触网，该脚本是验收动作。出网需代理的机器上加 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897`（Node 内置 fetch 默认不读代理变量，端口以本机为准，详见 `docs/toolchain-packs.md`）。

## 桌面工作台

`desktop/renderer/` 是纯 ES 模块，只跑在 Electron 里：Electron 窗口 + `desktop/host/host.js` 宿主进程（NDJSON over stdio），宿主复用 `dist/`（打包形态下是 `resources/`）的内核模块。**无框架、无打包器、无构建步骤。**

- **设置页九项**：通用 / 模型服务 / 外观 / 行为 / MCP 服务器 / 技能 / 知识库 / 工具链 / 关于。模型服务页每张卡片有「测试连接」：先 `GET {baseUrl}/models`，非 2xx 且填了模型名时退一步打一次 `max_tokens: 1`；失败原因分「地址不通 / 鉴权失败 / HTTP 错误 / 地址非法」，鉴权失败还区分「直接填的密钥被拒」「环境变量没设置」「填错字段（把密钥填进了变量名）」。已添加的模型画成禁用态 chip，不静默丢弃。上下文窗口有下拉（32K–1M + 自定义保留）。
- **会话管理**：右键改名、置顶、归档、删除、复制为新会话；标题存 `meta.json`。`loadSession` 会把会话记录的工作目录采纳为当前 cwd（顶栏、文件树、`getFile` 边界三处一起跟随），目录消失时不改 cwd 并说明原因。
- **输入框两个前缀**：`@` 打开文件名补全；`/` 打开命令补全——内置 `/clear`、`/context`、`/compact` 三个，其后是你保存的技能。三个内置命令都不接受参数。
- **计划条**：`todo_write` 写的计划同时出现在消息里的计划卡与输入框上方的 `#plan-strip`（折叠态一行：计数 + 当前步，点击展开），两处共用同一份状态。
- **流式与实时**：模型适配层默认请求 SSE 流式响应，增量写 `assistant_delta`（按批落盘：60ms 或 400 字符），`assistant` 仍承载完整内容并用于重建上下文。宿主以 200ms 轮询跟随日志，实际延迟约 200–250ms（D-134）。
- **设备状态契约**：MCP 工具在成功结果的 `structuredContent.deviceStatus` 返回普通 JSON 对象（≤8 KiB、深度 ≤4）；内核校验后写 `device_status`。`state` 的键值完全由 server 决定，内核与 UI 不解释、不补全、不推断。失败、权限拒绝、超时/取消不产生该事件。**目标板页面已于 2026-10-26 整页删除**，这个事件现在被消费但不画任何东西——设备信息只体现在工具行与其输出里。
- **托盘与关窗**：关窗默认最小化到托盘（可在设置 → 通用里改成直接退出），托盘常驻菜单可恢复窗口或退出。
- **应用内更新**：About 页读主进程的更新状态；检查 / 下载 / 安装是三个独立按钮，`autoDownload` 与 `autoInstallOnAppQuit` 都关掉。失败按九类原因如实显示，未知错误码保持 `unknown`，不会折叠成「已是最新」（R3）。开发形态与缺模块时状态是 `unsupported` 并说明是哪一种。
- **诚实边界**：内核没有的能力（git/PR、终端面板、worktree、memory/hooks、subagents、检查点恢复）在前端隐藏入口，宿主收到对应命令时回显式 `notice`，不静默吞掉。完整能力矩阵见 `desktop/MATRIX.md`。（`packs` 已不在这个清单里——工具链包管理器已落地，入口在设置 → 工具链。）

### 串口助手

右侧工作台常驻 Serial tab。**双通道不共口**：面板（宿主进程）持口并镜像环形缓冲（500 行、溢出计 `dropped`）到 `$HARNESS_HOME/serial/ring.json`，agent 经 `embed_serial`（**独立的 `serial` server**，2026-10-25 从 cubeide 拆出）读同一份镜像、借用面板会话写入，或在面板没占口时自己开一次性捕获。端口独占靠镜像里的 `ports[]` 判定，冲突时诚实报 `port_busy`。

宿主命令 `serialOpen` / `serialClose` / `serialStatus` / `serialClear` / `serialWrite` / `serialLine`（DTR/RTS）/ `serialBaud` / `serialEncoding` / `listSerialPorts`，事件 `serial_snapshot` / `serial_lines` / `serial_state` / `serial_cleared` / `serial_ports` / `serial_stats` / `serial_agent_write`。

- **面板侧**用 `serialport` 13 在宿主进程内直开 COM 口（原生模块，N-API）；编码支持 UTF-8 / GBK / 自动探测，运行中可切波特率与编码而不丢行。2026-10-24 从 PowerShell 泵换过来——PS 泵在实机上被四类问题击穿（杀软间歇击杀、UTF-8 分块乱码、二进制不安全、孤儿进程攥口）。
- **agent 侧**`embed_serial` 的临时捕获仍走 PowerShell `.NET SerialPort`（MCP server 进程不能引内核的原生依赖），同一台机器上两条通道读同一个口。
- agent 的写入经 `$HARNESS_HOME/serial/requests/` 邮箱交给持口的面板执行（一个文件一个消费者），面板把它作为 `serial_agent_write` 回放进转录并标注来源。
- 串口流量不进 transcript；agent 读到的部分作为 `tool_result` 自然落盘。方案与实测坑见 `docs/serial-panel-spec.md`。

### 技能

技能就是一个 Markdown 文件，正文是提示词模板；输入框敲 `/名字 参数` 时，正文被展开成一条普通消息发给模型。

| 作用域 | 位置 |
|---|---|
| 用户 | `$HARNESS_HOME/skills/<name>.md`（另有 CLI 库 `~/.agents/skills`） |
| 项目 | `<工作目录>/.harness/skills/<name>.md`（另有 `<workdir>/.agents/skills`） |

- 同名时**项目覆盖用户**，同层里 CLI 压应用。可选的 frontmatter 只认 `description` 与 `argument-hint`；**没有 frontmatter 也是合法技能**。
- 名字：小写字母开头，只含小写字母、数字、`-`、`_`，最长 64 字符；不能叫 `clear` / `context` / `compact`（与内置命令同名，永远轮不到执行）。
- `$ARGUMENTS` 是唯一占位符；正文里没有它时，参数作为追加的一段接在正文后面。
- 技能是**提示词模板，不绕过权限**：正文里劝模型去用的工具仍然逐个过权限与审批。**只有敲 `/名字` 才会触发**，模型看不到技能清单，也不能自己挑一个用。
- 设置 →「技能」页可新建、编辑、删除；`problems` 与 `skills` 分开展示（frontmatter 没闭合是可修的文件，并进空列表会让技能库读成「什么都没有」）。保存被拒时表单不关闭，草稿留在原处。

## 语料 OTA

语料随安装包发（初版），OTA 做更新。安装包公开分发 → 语料公开 → OTA 无需鉴权 → 凭据问题不存在；完整性由 **Ed25519 签名**保证——sha256 清单挡不住与语料一起被改，签名挡得住，因为私钥不在桶里。被篡改的语料不是解析错误，而是一次**提示注入**（例如诱导 `mem_write` 后报告无故障），直接撞 R1/R2/R3。

| 位置 | 用途 | 进仓库 |
|---|---|---|
| `$HARNESS_HOME/corpus.json` | 运行时覆盖；改了它换源不必发版 | 否 |
| `config/corpus.json` | 源码形态读这份 | **是** |
| `<安装目录>/resources/corpus.json` | 打包形态读这份；由上面那份经 `extraResources` 拷来 | 是（同一个文件） |

默认值进仓库是有意的（2026-10-25 改）：这两个值不可能保密——安装包必须带它们才能连上更新源，而桶是匿名可读的。原先「读 gitignore 的 `config/corpus.local.json` 生成 `resources/corpus.json`」的那个构建脚本从未存在，`corpus.local.json` 也没有任何代码读过，结果是别人 clone 下来只会看到「没有语料更新配置」。真正需要保住的性质是**可换性**，那由 `$HARNESS_HOME` 那一级保证。

```json
{ "version": 1, "updateBaseUrl": "https://<桶域名>/", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n<base64>\n-----END PUBLIC KEY-----\n" }
```

- 对象直接放在桶根下、不加前缀；`updateBaseUrl` 必须以 `/` 结尾。
- 缺失或不合法时**不静默降级**：知识库照常可用（内置快照），更新功能报 `config_invalid` 并在设置页如实展示。
- 布局：`$HARNESS_HOME/kb/{snapshots/v<N>, current(junction), inbox/, state.json}`，`KB_ROOT` 指向 `kb/current`。`KbService` 构造时 `realpathSync` 把 `current` 解析成具体快照 → 运行中的 server 锁在旧快照，新会话指向新快照——这就是「更新在会话边界生效」，不需要热切换。
- 流程：读配置 → `GET latest.json` → 验签 → 比版本 → **用户点确认才下载**（不自动应用：静默换语料会让「同一问题回答不同」不可解释）→ 逐文件下载并校验 sha256 → 全部通过才切指针 → 保留上一版。任一步失败删除半成品，`current` 不动，如实报原因。
- 首次启动把内置语料物化成 `snapshots/v<N>` 并写入 `mcp.json` 的 `kb` server。绝不覆盖用户已有的 `current` 或同名 server；内置语料缺 `latest.json` 时只复制文件、不现算清单（现算的没有签名，验不过）。
- **华为云 OBS 语义**：桶只授予 `GetObject` 时，不存在的对象返回 **403 而不是 404**。因此 200 → 解析验签；403/404 → 一律按「源上没有该文件」记 `check_failed` 并给出原因，**绝不显示成「已是最新」**。
- 设置页知识库页区分七种状态：`bundled` / `up_to_date` / `update_available` / `check_failed` / `verify_failed` / `config_invalid` / `unavailable`。
- 发布：`node scripts/corpus-publish.mjs --corpus <目录> --key <私钥> --version <N> --out <目录> [--base-url <桶地址>]`，先生成带签名的 `latest.json` 再上传，**先传文件、最后传清单**。私钥已由 `.gitignore` 的 `*.key` 覆盖。

完整契约（`latest.json` 格式、规范 JSON、状态机、发布侧职责）见 `docs/corpus-ota.md`。

### 打包

```bash
npm run build && npm run build:mcp        # 内核 + 领域 MCP 产物
npm --prefix desktop install              # desktop/ 自己的依赖（serialport、electron-updater）
npm --prefix desktop run dist             # 前置装配 + electron-builder
```

`dist` 脚本先跑 `scripts/package-prepare.mjs`，它准备两个 `extraResources` 源：

| 产物 | 装到 | 谁用 |
|---|---|---|
| `desktop/build/node_modules` | `resources/node_modules` | 内核的裸说明符 import（`zod` 等）。**缺了包就打不开** |
| `desktop/build/corpus` | `resources/corpus` | 首次启动物化成快照 |
| （直接引用）`../dist`、`../dist-mcp` | `resources/dist`、`resources/dist-mcp` | 内核与 MCP server |
| （直接引用）`../config/corpus.json` | `resources/corpus.json` | 语料更新源地址 |

`node_modules` 那一项不显然但必要：产物保留 `import { z } from "zod"` 这类裸说明符，宿主用绝对 file URL 动态 import 内核，Node 从 `resources/dist/` 向上找 `node_modules`——`resources/` 下没有它，宿主会以 `Cannot find package 'zod'` 退出。闭包由 `scripts/runtime-deps.mjs` 从 `package-lock.json` 算出（14 个包、约 23 MB），不装 electron-builder / typescript / vitest；桌面自己的 `serialport`（含 `@serialport/bindings-cpp` 预编译二进制）与 `electron-updater` 由 electron-builder 打进 `app.asar` / `app.asar.unpacked`。

**安装包已产出并发布到 v0.1.5**（`Embedded-AI-Master-Setup-0.1.5.exe`，118,411,240 字节，随包 `latest.yml` + `.blockmap`），**并已在干净机器上完成安装验证**（2026-11-03，D-208 关闭）。仍未关闭的是签名相关项：代码签名从未真实执行过（D-211），未签名构建里应用内更新下载到的包也不做签名校验（D-217）。发布流程见 `docs/release.md`。

## 验证边界

- Renode 探针路径已由 `npm run probe:e2e` 真实执行（只操作仿真内存）。
- `npm run diagnosis:e2e` 已真实执行只读取证与事件回放，覆盖 KB → probe → 权限 → 会话日志链路。它是**仿真复位基线取证**，不是真实板卡故障复现，结论不能外推到线序、共地、电平等真板问题。
- OpenOCD 后端只完成可用性检测与错误路径验证，未连接真机；真串口与真机 OpenOCD 验证登记 D-157。
- **安装包**：v0.1.5 的 NSIS 安装包已在干净机器上安装通过（D-208 关闭）——宿主启动链路、`resources/node_modules` 闭包、随包语料物化都在同一条启动路径上，但没有逐项的独立断言记录。
- **串口**：双 CH340 交叉互发、中文往返、孤儿泵自退、桌面 Start 都做过实机验证；那是 PowerShell 泵时代。2026-10-24 换成 `serialport` 后做过 350 帧压力测试。
- **Keil**：`UVSOCK` 的偏移、状态码、14 条「不支持」与整片擦除的结论都来自 **MDK 5.43a + STM32F429 真机实测**（不是推测）。但这条链路没有像 `probe:e2e` 那样的可复跑端到端脚本，真机回归目前靠人工。
- KB 语料/查询集不入库导致 CI 无法运行回归（D-158）；datasheet 语料同理。
- **渲染层只测纯函数**：vitest 无 DOM 环境，有测试的是 `protocol.js`、`markdown.js`、`settings-models.js`、`commands.js`、`plan-summary.js`、`thinking-view.js` 与宿主侧几个纯模块；`app.js` 与 `settings.js` 顶层依赖 `localStorage`/DOM、零导出，因此**所有界面改动仍需手动验收**。

## 已知限制

完整清单（有编号、触发升级条件、修复建议）见 `docs/deferred-issues.md`。用户会直接撞到的：

- **没有内置系统提示词**（D-221）：默认请求里一条 `system` 消息都没有，模型只看得到工具描述和你写的那句话；设置页填了系统提示词后，**旧会话就续不上了**（`system_prompt_mismatch`）。
- 运行中给发送按钮标的「排队」是假的：气泡显示「排队中」，消息仍被拒绝并丢弃（D-186）。
- 粘贴的图片附件**仍然不发送**：缩略图留在输入框上，消息里只包含文字（D-188）；拖入的文本/日志文件按路径附在消息末尾，这条是通的。
- `@` 搜索不返回目录（D-184）；`kb_grep` / `kb_glob` 仍无拒答机制（D-179）。
- 后台作业的完成结果只活在进程里，宿主重启会丢掉还没落盘的那一条，作业表也从不淘汰（D-199）。
- `Ctrl+Shift+E` 与 `Ctrl+E` 现在是同一个动作（切换思考强度），这是 2026-10-26 删掉无实现快捷键时接受的后果（D-192，已解决）。
- 杀软/策略可能拦截 `node file.mjs` 进程链下 spawn PowerShell（D-206）；Electron 主进程链实测不受影响。
- D-187 里的 `api.browserOpen`（四个调用点无 preload 成员）仍在，只是入口被 `SUPPORTED_PANES` 挡住，当前不可达。

其余高频项：超时/取消后不响应 signal 的残留工具仍可能在后台继续（D-022 已缓解）；网关不返回 `usage` 时 `maxCostUsd` 无法生效（D-027）；token 估算按 UTF-16 / 4，CJK 偏低（D-005）；`shell` 黑名单是启发式（D-083 / D-087 / D-088）；MCP 只有 stdio（D-190）；根与 `desktop/` 的 Electron 版本不一致（D-209）。

## 文档地图

| 文档 | 角色 |
|---|---|
| `docs/BRD.md` | 业务需求（BR-xx / PLAT-xx）、硬性规则 R1–R9、路线图 |
| `docs/p0-kernel-design.md` | 内核六项设计（主循环 / 模型 / 上下文 / 工具 / MCP / 会话） |
| `docs/frontend-design.md` | 前端设计规范（v2.0 起以 `desktop/renderer/` 实现为准） |
| `desktop/MATRIX.md` | 前端命令/事件能力矩阵（已支持 / 隐藏 / 原因） |
| `docs/corpus-ota.md` | 语料 OTA 的接口契约（唯一契约源） |
| `docs/serial-panel-spec.md` | 串口助手调研与实现方案 |
| `docs/keil-headless.md` | Keil 后端的接线与使用 |
| `docs/datasheet-mcp.md` / `mcp-servers/datasheet/README.md` | 数据手册检索的设计与工具面 |
| `docs/toolchain-packs.md` | 工具链包管理器的结构、不变量与权限语义 |
| `docs/release.md` | 发布流程（GitHub Releases）与打包契约 |
| `docs/code-signing.md` | Windows 代码签名：证书从哪来、怎么配、怎么验 |
| `docs/system-prompt-design.md` | 系统提示词分节组装草案（v0.2，未实现，D-221） |
| `docs/m2-roadmap.md` | M2 任务分期与决策记录 |
| `docs/deferred-issues.md` | 已知问题与升级条件（D-xxx，改代码前先查） |
| `docs/embedded-defects-todolist.md` | 嵌入式子系统的缺陷复查与修复台账（T-xxx） |
| `docs/harness-comparison.md` / `framework-architecture-inventory.md` | 横向调研与框架能力清单 |
| `docs/rag-vs-agentic-search-todo.md` | 检索层对照实验的判据与实测结论（§7 是结果） |
| `docs/ontology-scope-note.md` | Ontology 暂缓纳入检索比对的**范围决策**与重启条件 |
| `experiments/rag-vs-agentic-search/` | 该实验的完整资产：报告、评测脚本、查询集、跑批脚本 |
| `dev-notes/` | 按阶段增量追记的过程留痕 |

> `docs/cubeide-headless.md` / `espidf-headless.md` / `arduino-headless.md` 仍留在仓库里，但描述的是**已移除**的三套后端，只作历史留档。原 `docs/superpowers/specs/` 与 `plans/` 已于 2026-10-25 整体删除（`dbb8226`），实现设计改以 `docs/p0-kernel-design.md` 与各模块 README 为准。
