# Embedded-Ai-Master

面向嵌入式调试场景的 agent 内核，附带一个可运行的诊断工作台。当前交付 P0 内核（主循环与模型接入、会话事实源、内置工具、headless demo）与桌面前端（会话、转录、工具卡、审批、板卡与串口面板、设置）。

## 技术栈

- TypeScript + Node.js >= 24（ESM-only）
- Zod v4
- Vitest v4
- 前端：纯 ES 模块（无框架、无打包器），由 Electron 承载
- 实时通道：NDJSON over stdio（桌面宿主与渲染器之间）

## 安装

```bash
npm install
```

## 命令

```bash
npm test            # 全量单元/集成测试（不触网）
npm run coverage    # 覆盖率（lines 阈值 85%）
npm run lint        # 当前为 tsc --noEmit
npm run typecheck   # tsc --noEmit（内核）
npm run build       # 编译到 dist/

npm run test:desktop  # 桌面宿主与协议层测试（tests/desktop）
```

桌面形态需要先安装 Electron（agent 不代为安装）：

```bash
npm --prefix desktop install
npm run build          # 桌面宿主复用 dist/
npm --prefix desktop run desktop
```

## 目录结构

```
src/
├── config/       providers.json 加载与模型引用解析
├── context/      日志投影（buildMessages）与上下文预算
├── demo/         headless CLI 入口
├── loop/         事件类型、熔断、query 主循环
├── mcp/          MCP stdio 客户端：配置合并、连接生命周期、工具适配
├── model/        模型协议、OpenAI 兼容适配器、重试、token 估算
├── session/      append-only JSONL 会话
├── server/       宿主调用的库层：会话运行器、审批桥、会话管理、文件与知识库扫描
├── skills/       技能（提示词模板）的存储与解析：两作用域读取、frontmatter、原子写
├── tools/        工具契约、注册表、echo/read/write/edit/multiedit/shell/glob/grep、五阶段执行管线
└── index.ts      runSession 装配
desktop/
├── main.js       Electron 主进程（窗口、IPC、宿主生命周期）
├── preload.cjs   contextBridge 桥
├── host/host.js  桌面宿主：NDJSON 分发器，复用 dist/ 下的内核模块
└── renderer/     纯 ES 模块前端（app.js / protocol.js / 样式与 i18n）
scripts/          端到端脚本（probe、diagnosis、kb 回归与审核）
tests/            Vitest 测试（tests/desktop 为桌面宿主与协议层）
docs/             设计、计划与已知问题
```

## 配置

默认读取 `$HARNESS_HOME/providers.json`；`HARNESS_HOME` 缺省为 `%USERPROFILE%/.harness`（Windows）或 `~/.harness`。

```json
{
  "local-gw": {
    "protocol": "openai-chat-completions",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "apiKeyEnv": "LOCAL_GW_KEY",
    "models": {
      "flash": { "contextWindow": 128000, "maxOutput": 8192 }
    },
    "requestTimeoutMs": 120000,
    "maxResponseBytes": 8388608,
    "pricePerMillion": { "input": 1, "output": 1, "cachedInput": 0.1 }
  }
}
```

模型引用为 `provider/model`（如 `local-gw/flash`）。`apiKeyEnv` 指向的环境变量存在且非空时发送 `Authorization: Bearer <key>`；否则不发送该头（本地网关可空跑）。`pricePerMillion` 缺省时只统计 token，不启用 `maxCostUsd` 熔断，`usage` 事件里也不会出现 `costUsd`（未定价与「成本为 0」是两件事）。`requestTimeoutMs` 默认 120000，超时抛可重试的 `RequestTimeoutError`；`maxResponseBytes` 默认 8388608（8 MiB），流式读取超限即取消并抛 `invalid_response`。

同目录下另有三份可选配置，设置页可直接编辑（不手编也行）：

| 文件 | 内容 |
|---|---|
| `mcp.json` | `{ "mcpServers": { "<name>": { "command", "args", "env", "cwd", "timeoutMs", "disabled" } } }` |
| `permissions.json` | `{ "version": 1, "preset", "rules": [{ "tool", "params", "action", "reason" }], "approvalTimeoutMs" }` |
| `run.json` | `{ "maxTurns", "maxCostUsd", "timeoutMs", "systemPrompt" }`；`null` 表示不限（`maxTurns` 的默认值就是 `null`，2026-10-22 起不再有默认轮数上限），`systemPrompt: ""` 表示用默认 |

三份文件都由「临时文件 + rename」原子替换；内容非法时报错并保留原文件，不会写坏。

## 内置工具

`runSession` 默认注册 `echo` / `read` / `ls` / `todo_write` / `write` / `edit` / `multiedit` / `shell` / `glob` / `grep` 十个工具（`createBuiltinTools()`，顺序固定）。工具根（`ToolCtx.cwd`）为 `opts.cwd ?? header.workdir ?? process.cwd()`：创建会话时 `opts.cwd`（缺省 `process.cwd()`）同时写入 `header.workdir`；resume 未传 `opts.cwd` 时沿用 `header.workdir`，两者都提供且不一致时抛 `SessionResumeError("workdir_mismatch")`，失败不写 header/日志。所有相对路径按工具根解析。

| 工具 | 能力 | 注解 |
|---|---|---|
| `echo` | 回显输入，用于连通性验证 | 只读 |
| `read` | 读取文本文件（带行号，可分页） | 只读 |
| `ls` | 列一个目录的直接子项（目录在前、不递归） | 只读 |
| `todo_write` | 替换整份待办列表（多步骤任务的计划） | 无注解，判为 read |
| `write` | 写入文本文件（覆盖，自动建父目录） | 非只读、destructive |
| `edit` | 单处唯一替换 | 非只读、destructive |
| `multiedit` | 同一文件多处替换（全成或全不改） | 非只读、destructive |
| `shell` | 执行 shell 命令（非沙箱） | 非只读、destructive |
| `glob` | 按 glob 模式查找文件 | 只读 |
| `grep` | 按正则搜索文件内容 | 只读 |

### `read` / `ls` / `todo_write` / `write` / `edit` / `multiedit`

- `read`：`path` + 可选 `offset`（0 起行号）/`limit`（≤2000 行）；单次最多 2000 行、256 KiB，超出以 `[truncated]` 标记，`detail.nextOffset` 给出继续读取的位置；`offset` 越界返回 `(no lines at offset)`。
- `todo_write`：`items`（0–50 条 `{content, status}`，`status` ∈ `pending` / `in_progress` / `completed`）。**替换整份列表，不是追加**；空数组表示「没有待办了」。它只写一条 `todos` 会话事件、不碰任何文件，所以判为 `read`——判成 `write` 会让 `read-only` / `diagnose` 预设下的计划功能直接不可用，换不来任何安全收益。该事件是界面状态、不进模型上下文，渲染器据它画计划卡并在执行中原地打勾。
- `ls`：`path` 可选（缺省工具根）。逐行输出 `d  <name>/` / `f  <size>  <name>` / `l  <name>`（符号链接只标记**不跟随**）/ `?  <name>`，目录在前、文件在后、组内按名排序。最多 500 条，超出置 `detail.truncated` 并追加 `[truncated]`；空目录返回 `(empty directory)`（**不是空字符串**，否则与失败无法区分）。`detail.entries[].size` 是原始字节数，人类可读单位只在文本层。**刻意不套 `glob`/`grep` 的忽略清单**——那是给大范围扫描用的，`ls` 是点名要看这个目录，`node_modules` 也如实列出。`not_found` / `not_a_directory` / `read_failed` / `aborted`，单个文件 `lstat` 失败时该行大小写 `-` 而不是 0。
- `write`：`path` + `content`，自动创建父目录；`content: ""` 会写出空文件，这是合法写入而不是错误。
- `edit`：`path` + 非空 `oldText` + `newText`；`oldText` 必须唯一命中，否则 `edit_not_found` / `edit_not_unique`；按文件现有 CRLF/LF 风格写入。
- `multiedit`：`path` + `edits`（1–50 条 `{oldText, newText}`）。按顺序应用，后一条在前一条的替换结果里查找；**要么全部成功、要么一个字节都不改**——任一 `oldText` 为空 / 找不到 / 不唯一就在内存里中止，文件从不打开写入，返回 `edit_not_found` 或 `edit_not_unique` 并带 `detail.index` 指明第几处。全部命中时只写一次盘，返回 `detail.occurrences` 为总替换数。
- workdir 限制：解析到工具根之外（含 `..`、绝对路径、symlink/junction 逃逸）→ `path_outside_workdir`；Windows 保留设备名 → `reserved_name`；`read` / `edit` / `multiedit` 目标不是普通文件 → `not_a_file`；`write` 目标为目录或底层写入失败 → `write_failed`。
- 四者都响应 `AbortSignal`：`read` 的流、`write`/`edit`/`multiedit` 的 `readFile`/`writeFile` 都接 signal；取消返回 `aborted`，写类工具会提示可能留下部分文件。
- **`fs` 已删除，不保留别名。** 旧版单一 `fs` 工具用 `op` 参数分派 `read`/`write`/`edit`，权限规则只能靠 `params` 里的 `op` 区分读写；一旦规则漏写 `params`，一条读规则就会顺带放行写，而写规则也可能被 `fs op=write` 绕过——那是静默绕过权限边界。拆成四个工具后按工具名匹配，最坏情况是旧的 `fs` 规则不再命中、退回预设行为（`workspace-write` 下写变成 `ask`），方向是可见且更严的。迁移：把规则里的 `{"tool": "fs", "params": [{"key": "op", "eq": "write"}]}` 改成 `{"tool": "write"}`；`edit` / `multiedit` 各自同理。

### `shell`

- **非沙箱**：命令交给系统 shell（`spawn(command, { shell: true })`）执行，仅对已知高危命令做黑名单拦截，不限制其余命令的读写范围；`cwd` 必须位于工具根内，越界 / 不存在 / 非目录 → `cwd_invalid`。
- 拦截：判定前移除 token 内所有 `'`/`"` 再归一目标（覆盖 `rm -rf "/"*`、`rm -rf "$HOME"/*`、`del /s /q "C:\"*`）；`rm` 带 `-r`/`-R`/`--recursive` **或** `-f`/`--force` 任一且打 `/`、`~`、`$HOME`、多级 `..`、盘符根及其归一化变体（如 `../*`、`~/..`、`/tmp/../*`、`C:/..`）即拦截，`--no-preserve-root` 一律危险；跟踪 `cd` / `pushd` / `chdir` / `Set-Location` 的根目标（无参 `cd` / `chdir` / `pushd` 均保守视为根），后续 `rm -r *` / `rm -f *` / `del /s /q *` 一并拦截；`mkfs*`、`format <盘符>:`、`diskpart`、`bcdedit`、`shutdown` / `reboot` / `poweroff` / `halt`、`dd of=/dev/*`、`del|erase|rd|rmdir /s` 打盘符根、`reg delete HKLM`、`cipher /w`、fork bomb；命中返回 `dangerous_command` 且不 spawn。
- 退出语义：命令跑完即 `isError:false`，`text` 首行 `exit=<code>`；**非零退出码不算工具错误**，由模型读 `detail.exitCode` 判断。被信号终止 → `shell_terminated`（`detail.exitCode` 可能为 `null`）；`spawn` 失败 → `shell_spawn_failed`。
- 取消：`signal` abort 后 Windows 用 `taskkill /T /F`、POSIX 杀 detached 进程组；1s 后升级 `SIGKILL`/再次 `taskkill`，3s 仍未确认退出则返回 `shell_aborted` 并写 `detail.abortEscalated`/`terminateFailed`，Promise 必定 settle（文本会明确“process termination not confirmed”）。stdout / stderr 各截断到 1 MiB 并标记；`detail.stdout` / `detail.stderr` 只保留前 4096 字符摘要（不切断代理对），完整输出在 `text`，由管线按需截断或落盘；`detail` 另含 `stdoutBytes` / `stderrBytes` 与截断标记。
- 黑名单是启发式（`env`、`bash -c`、`xargs` 等可绕过；改目录方式与 shell 展开仍未覆盖，D-083/D-087/D-088），不能当作安全边界。

### `glob` / `grep`

- `glob`：`pattern` 匹配**相对工具根**的 POSIX 路径（不是 `path` 根）；`*` 不跨 `/`、`?` 匹配单字符、`**/` 匹配任意层目录、段尾 `**` 匹配剩余路径，其余字符按字面量；反斜杠按 `/` 处理；大小写敏感。pattern 长度 ≤256、段数 ≤64，连续 `**/` 会折叠；超限视为非法。返回字典序路径，最多 200 条，超出 `[truncated]`；扫描上限 5000 个文件，超出 `[scan truncated at 5000 files]`。
- `grep`：`pattern` 为正则（`ignoreCase` 可选），可加 `glob` 过滤、`maxResults`（1–1000，默认 200）；`glob` 非法（空 / NUL / 超长 / 超段数）→ `invalid_pattern`，不静默无匹配。输出 `<相对路径>:<行号>:<文本>`，按路径与行号排序，超出 `[truncated]`。扫描达到 5000 个文件时追加 `[scan truncated at 5000 files]`；单行超过 1 MiB 时跳过并追加 `[skipped N lines longer than 1 MiB]`。
- 两者都只遍历工具根内：跳过 `.git`、`node_modules`、`.harness`、`dist`、`coverage`、`build`、`out`、`target`、`.pio`、`cmake-build-*`，以及语言/工具链缓存与虚拟环境（`.mypy_cache`、`__pycache__`、`.pytest_cache`、`.ruff_cache`、`.tox`、`.venv`、`venv`、`.next`、`.nuxt`、`.turbo`、`.cache`、`.parcel-cache`、`.gradle`、`.idea`、`.svelte-kit`、`*.egg-info`）。`.vscode` 与 `vendor` **不**跳过（可能是用户自己的配置与源码）；遍历中遇到的 symlink 文件 / 目录都不跟随（显式 `path` 根为 symlink 时仍会跟随，D-079）。
- **遍历是广度优先（层序），同一层内按名字排序。** 5000 个文件的预算耗尽时，先被覆盖的是根目录与浅层文件。旧实现是深度优先且 `readdir` 未排序，根条目里靠前的 `.mypy_cache` 之类会先被递归进去吃光预算，根目录的 `README.md` 根本没被访问到——`glob "**/README.md"` 会返回 `(no matches)` 加一行扫描截断，看起来像「项目里没有这个文件」。截断时会额外追加一行 `[the scan stopped before finishing - results are incomplete; narrow it with a subdirectory path or a glob filter]`，明确「结果不完整」并给出收窄做法。
- 忽略清单是**列举式**的：新出现的缓存目录不会自动被跳过，需要显式加入 `IGNORED_DIRS`。`IGNORED_DIR_SUFFIXES`（`.egg-info`）按后缀匹配目录名。
- `grep` 只读 ≤2 MiB 的文件，含 NUL 视为二进制；跳过项分别计数并披露为 `[skipped N entries (X files, Y unreadable directories)]`，`detail.skipped` 区分 `binary` / `tooLarge` / `unreadableFiles` / `unreadableDirectories`，不列具体路径（D-084 仍跟踪路径披露）。
- 两者都响应 `AbortSignal`：`walkFiles` 在每个条目/递归/访问前检查，`grep` 在文件读取前与每 256 行检查，取消返回 `aborted`。`grep` 先收集全部命中再截断，命中集很大时内存占用随结果增长（D-078）；`grep` 正则同步执行，ReDoS 不可中断（D-085），glob 编译仍有回溯风险（D-086）。

## MCP 客户端

`runSession` 默认启用 MCP（stdio），启动时读取两级配置并连接所有未禁用的 server：

- 用户级：`$HARNESS_HOME/mcp.json`
- 项目级：`<工具根>/.harness/mcp.json`（新建会话取 `opts.cwd` 或进程 cwd；resume 未传 `opts.cwd` 时取 `header.workdir`，缺失则回退进程 cwd）；**默认不加载**，需要 `mcp.trustProjectConfig: true` 显式信任，或由调用方显式传入 `projectConfigPath`；跳过时写 `mcp_project_config_skipped` status。未知字段经 `mcp_config_warning` status 披露，不再静默忽略。

```json
{
  "mcpServers": {
    "probe": {
      "command": "node",
      "args": ["C:/tools/probe-mcp/server.js"],
      "env": { "PROBE_PORT": "COM3" },
      "cwd": "C:/tools/probe-mcp",
      "timeoutMs": 15000
    }
  }
}
```

- 字段级合并：同名 server 以 project 覆盖 user，`env` 按键合并；project 只写 `disabled: true` 时沿用 user 的 command/args。`cwd` 相对配置文件所在目录解析，缺省为当前 workdir；`timeoutMs` 缺省 15000 ms。未知字段忽略，可选字段拼写错误会按缺省值继续，`command` 必填且缺失时报 `McpConfigError`，名称须匹配 `^[a-zA-Z0-9_-]{1,64}$`。
- 环境变量：默认只传 `PATH`/`HOME`/`USERPROFILE`/`SystemRoot`/`SystemDrive`/`windir`/`TEMP`/`TMP`/`PATHEXT`/`COMSPEC`/`SHELL`/`LANG`/`LC_ALL`/`TERM`；`inheritEnv: true` 恢复完整继承，`envAllowlist: ["KEY"]` 显式放行父进程变量；`config.env` 始终覆盖。第三方 server 不应默认看到 provider API key 等敏感变量。
- 连接失败只影响该 server：记录 `mcp_connect_failed`，其余 server 与主会话继续；配置 JSON/schema 非法记录 `mcp_config_failed` 并跳过全部 MCP。`mcp.enabled: false` 或未配置任何 server 时完全不启动客户端。
- 工具暴露为 `mcp__<server>__<tool>`；非 `[a-zA-Z0-9_-]` 字符替换为 `_`，超过 64 字符时截断并追加 `_<hash6>`；与内置/其他 MCP 工具冲突时同样以 `_<hash6>` 确定性改名并记 `mcp_tool_name_renamed`（仅冲突记录状态）。工具的 `_meta.evidence === true` 映射为证据结果，参与上下文压缩保护。
- 调用：文本内容拼接，非文本内容 JSON 化；`isError` 映射为工具失败；超时/取消分别返回 `mcp_timeout` / `mcp_aborted`。实际调用超时取 `min(timeoutMs, 120000)`；连接握手与 `listTools()` 工具发现都使用 15s 超时，外层工具管线默认 120s（可被 `runSession.timeoutMs` 覆盖）竞争，可能先返回 `tool_timeout`。同一 server 的调用串行，不同 server 可并行。**超时/取消会终止 server transport 并断开连接**，下一次调用重连，避免残留调用与后续调用重叠。
- 破坏性工具（`destructiveHint: true`）在连接类错误后**不自动重试**：server 可能已执行但响应丢失，重试会造成二次写/复位；此时返回 `mcp_uncertain`，需要重连并复核设备状态。非破坏性工具保持一次重连重试。
- 输出上限：单次调用 text/非 text/structuredContent 合计最多 1 MiB，超出截断并追加 `[MCP output truncated at 1 MiB]`、`detail.truncated=true`；`inputSchema` 超过 64 KiB 的工具跳过并记 `mcp_tool_invalid_schema`；`description` 超过 4096 字符截断。
- `list_changed`：工具列表变化后刷新 registry，后续轮次使用新集合；刷新失败保留旧集合并记 `mcp_tools_refresh_failed`（`scope: "global"` 表示整体重建失败）。会话结束时统一关闭全部子进程。

```ts
for await (const event of runSession({
  input: "读取目标寄存器",
  model: "local-gw/flash",
  mcp: {
    enabled: true,
    userConfigPath: "C:/Users/me/.harness/mcp.json",
    trustProjectConfig: true,
    projectConfigPath: "C:/work/project/.harness/mcp.json",
  },
})) {
  // ...
}
```

`mcp.enabled`、`mcp.trustProjectConfig` 必须是布尔值，`mcp` 必须是普通对象，否则在入口抛 `TypeError`。MCP server 由用户自行安装并在配置中给出 `command`；MCP SDK 包（`@modelcontextprotocol/client`，测试夹具用 `@modelcontextprotocol/server`）已写入 `package.json`，随用户执行 `npm install` 安装；本仓库的 agent 不执行任何依赖安装命令。运行期状态写入会话 `status` 事件（`mcp_connected` / `mcp_connect_failed` / `mcp_tools_changed` / `mcp_tools_refresh_failed` / `mcp_tool_name_renamed` / `mcp_tool_invalid_schema` / `mcp_config_failed` / `mcp_config_warning` / `mcp_project_config_skipped`）。未知配置字段不再静默：`loadMcpConfig` 通过 `onWarning` 交回，`runSession` 记一条 `mcp_config_warning`；`list_changed` 刷新失败会做 3 次有界退避重试，仍失败才保留旧缓存并记 `mcp_tools_refresh_failed`（含 `attempts`）。工具名按 `(server, tool)` 字典序稳定分配，不依赖 server 返回顺序。

## 领域 MCP：探针（BR-2）

`mcp-servers/probe` 提供 Renode / OpenOCD 探针工具（内存读写、复位、串口），以 stdio MCP server 挂载，内核不含领域逻辑。先构建再配置：

```bash
npm run build:mcp
```

```json
{
  "mcpServers": {
    "probe": {
      "command": "node",
      "args": ["<仓库根>/dist-mcp/probe/server.js"],
      "env": { "RENODE_PATH": "D:/Renode/bin/Renode.exe" }
    }
  }
}
```

`RENODE_PATH` 由 probe server 读取并传给 `RenodeBackend`（为空或未设置时使用默认 `C:/Program Files/Renode/bin/Renode.exe`）；`OPENOCD_PATH` 用于 OpenOCD 可用性检测。也可以直接在进程环境中设置。端到端演示会真实启动本机 Renode，只操作仿真内存：attach → halt → 读 `0x20000000` → 写 `78 56 34 12` → 回读校验 → reset → 恢复原值 → detach。

```bash
npm run probe:e2e
```

成功时输出 `{"backend":"renode","attach":true,...,"writeVerified":true,...}`；`dist-mcp/` 缺失时退出码 2 并提示 `npm run build:mcp`，其余失败退出码 1。写内存、复位与串口写入是破坏性操作，在 `diagnose` 预设下为 `ask`；headless（无审批器）时降级为拒绝且不执行工具。`serial_open` 不是只读工具，未显式授权时在 `diagnose` 下被拒绝；可复制 `mcp-servers/probe/permissions.example.json` 到 `.harness/permissions.json` 配置 SRAM 写窗口与串口白名单。写操作返回 `declaration` 声明；`mem_read` 全 0 只返回警告，不推断“无故障”。`serial_read` 响应 MCP 取消信号：abort 后返回 `aborted`，不再继续等待或消费缓冲。

OpenOCD 后端本轮只做“连接已运行的 OpenOCD telnet”，`attach` 不 spawn 进程；使用前请自行启动 `openocd -f <config>`（telnet 默认 `127.0.0.1:4444`）。`OPENOCD_PATH` 仅用于可用性检测；`openocdConfig` 参数已移除。真机验证登记 D-157。

## 领域 MCP：知识库（BR-3）

`mcp-servers/kb` 以 stdio MCP server 暴露 7 个工具：

| 工具 | 形态 | 说明 |
|---|---|---|
| `kb_lookup` | 索引首跳 | 关键词打分；可能漏召回，未命中应继续用 `kb_grep` / `kb_glob`，不要断言 KB 没有相关内容 |
| `kb_glob` | agentic | 按 `*` / `**` / `?` 通配符列路径，最多 100 条；`scanTruncated: true` 表示遍历被预算截停，未命中不等于不存在 |
| `kb_grep` | agentic | 逐行正则（大小写不敏感），可用 `glob` 限定文件，最多 100 条、命中行截断到 300 字符；`fileCount` + `files`（命中最多的前 10 个文件）显示命中是集中还是散落——**是线索，不是置信度** |
| `kb_read` | agentic | 读文件，`offset`（0-based）/`limit`（默认且上限 2000 行）分页；`truncated: true` 表示需续读 |
| `kb_search` | 字面检索 | 多 token 字面行检索，不支持正则 |
| `kb_status` | 只读 | 根路径、文件数、索引条目、待审数、inbox 实际位置（`inboxPath` / `inboxExternal`） |
| `kb_propose` | 写入 | 只追加待审 inbox，未审内容不参与检索，必须人工审核后合并；inbox 位置可经 `KB_INBOX_PATH` 配到语料根之外（OTA 形态），不配时仍是 `<KB 根>/_inbox.md` |

除 `kb_propose` 外全部只读，`kb_read` 标记为 evidence。`kb_glob` / `kb_grep` 与 `kb_search` 一样排除 `_inbox.md`、`_about.md` 与 `index.yaml`，并拒绝绝对路径与 `..` 越界；遍历另跳过 `.git`、`node_modules`、`__pycache__`、`.mypy_cache`、`.pytest_cache`、`.venv`、`venv`、`.next`、`.cache`、`dist`、`build`、`out`、`target`（KB_ROOT 被误指向大目录时不至于无限遍历），单次遍历上限 20000 个文件，触顶时 `scanTruncated: true` 且 `count` / `found` 只代表已扫描部分。

**部署形态是 lookup 首跳 + glob/grep/read 的 agentic 循环，不等同于对照实验里被测量的方案 B**（B 的工具面没有 `kb_lookup`）。实验里 B 的 Recall@2 0.925 不能当作本部署的成绩；B 的 H7（KB 外查询拒答）在实验中也未评估（见 `experiments/rag-vs-agentic-search/docs/experiment-report.md` §5 与 `docs/rag-vs-agentic-search-todo.md` §7.4），这个缺口仍在。详见 `mcp-servers/kb/README.md`。先构建再配置：

```bash
npm run build:mcp
```

```json
{
  "mcpServers": {
    "kb": {
      "command": "node",
      "args": ["<仓库根>/dist-mcp/kb/server.js"],
      "env": { "KB_ROOT": "<仓库根>/mcp-servers/kb/kb" }
    }
  }
}
```

`KB_ROOT` 缺省为相对 `process.cwd()` 的 `mcp-servers/kb/kb`；目录不存在时 server 仍可启动，`kb_status` 显式返回 `indexPresent: false`。

`KB_INBOX_PATH` 可选，指定待审 inbox 的写入位置（`kb_propose` 写、`kb_status` 读、`kb-review` 读同一个文件）。不设时沿用 `<KB 根>/_inbox.md`。OTA 部署把语料快照整份替换，用户沉淀必须放在根外，此时指向 `$HARNESS_HOME/kb/inbox/_inbox.md`；`kb-review` 用 `--inbox <路径>` 或同一环境变量跟过去。

### 本地语料与回归基线

语料与查询集是**本地资产，不进版本库**（`.gitignore` 已忽略 `mcp-servers/kb/kb/` 与 `mcp-servers/kb/data/`），重新获取方式见 `mcp-servers/kb/README.md`。当前实测：108 个 md / 90 条索引（BRD 基线为 103 / 85），自建查询 80 条（index 50 / search 30）与负样本 25 条；其中 11/80 的 gold 未进入 `index.yaml`（全部为 search 轨的 `reference/*.md`）。数字以实测为准，不裁剪语料。

```bash
npm run build:mcp
npm run kb:regression          # 表格 + JSON；--json 仅 JSON，--baseline 输出基线形状
```

脚本在缺少 `dist-mcp/kb/service.js`、`KB_ROOT`、`index.yaml` 或查询集时打印原因并以退出码 2 结束；脚本不设通过阈值。`mcp-servers/kb/tests/regression.test.ts` 直接 import `service.ts`、不启动 MCP server；语料或查询集缺失时 `describe.skip`，存在时断言各指标不低于 `regression-baseline.json`。

### 沉淀与人工审核

```bash
npm run kb:review -- --list
npm run kb:review -- --accept <id> --target protocols/uart/no-output.md
npm run kb:review -- --reject <id> --reason "重复条目"
```

`--accept` 要求人工**先把提案内容合并进正式条目**；脚本只做门禁与状态流转：校验 target 在 KB 根内、运行 `kb-regression --json`、按 `regression-baseline.json` 比较。任一指标下降或总数变化时退出码 1，`_inbox.md` 不变；全绿才移除提案并写入 `_reviewed.md`。脚本不自动编辑正式条目或 `index.yaml`，target 不在索引中只输出 warning。

2026-10-20 实测基线（只作下限，不是目标）：index 轨 Recall@2 0.44、Hit@1 0.38、MRR 0.41；search 轨严格 Hit@1 0.1333（第一条 hit 命中 gold）、`goldInTop20` 0.4333（gold 出现在 `search(tokens, 20)` 的任意命中中；引擎按路径排序，不承诺相关性 rank）；负样本拒答率 0.84（21/25 正确拒答）。`kb_lookup` 对英文 keyword/tag 使用 ASCII 词边界、忽略单字符英文 token，并按查询中未出现在索引词表的 token 比例折减分数；折减后最高分低于 1.75 时返回 `found: false`、`reason: "low_confidence"`。此外有两层覆盖度规则：**技术 token 覆盖度**从 query 提取 ASCII/十六进制/型号并过滤英文停用词与 `CPU`/`MCU`/`SoC` 等泛指词，单个技术 token 必须被条目覆盖，多个技术 token 必须覆盖超过一半；**中文覆盖度**只在查询没有 ASCII 技术 token 时生效，要求命中中文关键词字符数 ≥ 4，或命中 ≥ 2 个不同中文关键词，或关键词之外还有 ≥ 2 个中文字符上下文。因此 `优化`、`对齐`、`没反应` 这类孤立短词会按 `low_confidence` 拒答，而 `串口没输出`、`串口乱码` 与带上下文的长句仍可命中。相对上一版（Recall@2 0.46、Hit@1 0.40、MRR 0.43、拒答率 0.56、宽松 search Hit@1 0.4333），Recall@2 / Hit@1 / MRR 各下降 2pp，拒答率提升 28pp；search 轨严格 Hit@1 与 `goldInTop20` 分别披露排序与召回，避免再用宽松指标掩盖排序回归。残余 4 条误报中，3 条（neg-005、neg-008、neg-023）为主题相邻但细节未覆盖（`near_domain: true`），1 条 neg-011 为纯硬件供电问题（`near_domain: false`）；neg-011 是长句，中文覆盖度规则不会拒绝，差距与语义检索计划见 D-159。

### 端到端诊断验收（阶段 3）

```bash
npm run build && npm run build:mcp
npm run diagnosis:e2e
```

脚本用真实 Renode、真实 KB MCP 与真实内核事件日志跑一次只读取证：`kb_lookup("串口没输出")` → `kb_read` → `attach`/`halt` → 读 `VTOR`、`RCC_APB1ENR`、`GPIOA_MODER`、`USART2 CR1/BRR` → 证据对表 → 根因与可证伪预测 → `LogTailEventSource` 回放。输出 JSON 含 `rootCause`、`evidence`、`registerWarnings`、`falsifiablePrediction`、`limitations`、`replayEvents`；若关键读数带 all-zero/unmapped warning，根因降级为“证据不足”并匹配 KB 第 3 步，不把 0 解码为“未配置”。缺 `dist`/`dist-mcp` 或 KB 资产退出码 2，缺 Renode 或断言失败退出码 1。

该验收是**仿真复位基线取证**，不是真实板卡故障复现：`VTOR=0` 只表示未加载固件，结论不能外推到线序、共地、电平等真板问题。真机验证仍由 D-157 跟踪。

### 验证边界

- Renode 探针路径已由 `npm run probe:e2e` 真实执行（只操作仿真内存）；`RENODE_PATH` 可覆盖默认可执行文件路径。
- `npm run diagnosis:e2e` 已真实执行只读取证与事件回放，覆盖 KB → probe → 权限 → 会话日志链路。
- OpenOCD 后端只完成可用性检测、参数与错误路径验证，未连接真机；真串口设备同样未实测。
- 真串口与真机 OpenOCD 验证登记为 D-157；KB 语料/查询集不入库导致 CI 无法运行回归，登记为 D-158。

## 领域 MCP：Keil（BR-4）

`mcp-servers/keil` 以 stdio MCP server 暴露 Keil MDK 的无头调试与工程编辑（`keil_debug` 57 个动作、`keil_project` 14 个动作），驱动本机已授权的 `UV4.exe` 与 UVSOCK 接口，不下载、不捆绑任何 Keil 组件；内核不含领域逻辑。先构建再配置：

```bash
npm run build:mcp
```

```json
{
  "mcpServers": {
    "keil": { "command": "node", "args": ["<repo>/dist-mcp/keil/server.js"], "timeoutMs": 120000 }
  }
}
```

两次调用之间会话保持打开，`close` 释放探针；**工程编辑要到 uVision 退出时才写回 `.uvprojx`**，`SUCCESS` 不代表文件已变。整片擦除走 STM32CubeProgrammer（UVSOCK 的 `PRJ_FLASH_ERASE` 在 MDK 5.43a 无响应），未安装时明确拒绝而不是伪装成功。取证读数带 `evidence`、破坏性动作带 `declaration`；`diagnose` 预设下运行控制/烧录/擦除/写参数/改工程为 `ask`，headless 下降级为拒绝。权限模板见 `mcp-servers/keil/permissions.example.json`，使用与故障排查见 `docs/keil-headless.md`，已知限制见 `docs/deferred-issues.md`（D-200 / D-201）。

## 权限与审批

权限层在工具执行前判定 `allow` / `ask` / `deny`，默认预设为 `diagnose`。判定只决定是否调用工具；`allow` 后仍会经过 `shell` 危险命令黑名单与 `read`/`write`/`edit`/`multiedit` 的路径边界检查。权限规则是声明式匹配而非沙箱（D-114）。

**配置路径与 trust 语义**

- 用户级：`$HARNESS_HOME/permissions.json`（默认 `~/.harness/permissions.json`），默认加载。
- 项目级：`<工具根>/.harness/permissions.json`，**默认不加载**；只有 `permissions.trustProjectConfig === true` 或显式提供 `permissions.projectConfigPath` 才读取（显式路径即视为信任）。文件存在但未信任时写 `status: permissions_project_config_skipped`，`message` 为路径。
- 与 `mcp.trustProjectConfig` **相互独立**：信任项目 MCP 配置不会放宽权限。
- 合并：`preset` / `approvalTimeoutMs` 取 inline → project → user → 默认（`diagnose` / 120000）；规则按 inline → project → user → 内置预设规则拼接。任一匹配规则为 `deny` 即拒绝，其次 `ask`，最后 `allow`；同优先级取最靠前一条（`source` + 全局 `ruleIndex`）。
- 配置错误（JSON / schema / 版本 / 未知字段 / 非法谓词）抛 `PermissionConfigError`，`runSession` 启动失败（demo 退出码 2），不会忽略后继续。

| 预设 | 只读 | 写 | 未知 |
|---|---|---|---|
| `read-only` | allow | deny | deny |
| `workspace-write` | allow | allow（`write`/`edit`/`multiedit` 各有内置 allow；其余写工具仍 ask） | deny |
| `diagnose`（默认） | allow | ask | deny |
| `danger-full-access` | allow | allow | allow |

规则 `tool` 支持 `*`（任意串）与 `?`（单字符），整串大小写敏感匹配；`params` 为 AND，`key` 是点路径（如 `target.port`、`items.0`），每个 matcher 必须且只能提供 `eq` / `glob` / `in` / `range` 之一。`eq` 为 JSON 严格相等，`glob` 只匹配字符串，`in` 为非空数组，`range` 为闭区间且仅匹配有限 number。`range` 可附加 `extentKey`（点路径）表达“起始值 + 跨度”：值为数组时取 `length`，为数字时取数值，要求 `start >= lower` 且 `start + extent - 1 <= upper`；`extentKey` 只能与 `range` 同用。

`serial_open` 默认不是只读工具：`diagnose` 预设下未显式授权会被拒绝。可复制的 probe 领域策略模板见 `mcp-servers/probe/permissions.example.json`（SRAM 写窗口、串口白名单、复位拒绝）；模板**不会自动加载**，复制到 `.harness/permissions.json` 或通过 `permissions.rules` 内联后才生效。

```json
{
  "version": 1,
  "preset": "diagnose",
  "approvalTimeoutMs": 120000,
  "rules": [
    {
      "tool": "mcp__probe__mem_write",
      "params": [{ "key": "address", "range": [536870912, 536903679], "extentKey": "bytes" }],
      "action": "allow",
      "reason": "SRAM 调试窗口"
    },
    {
      "tool": "mcp__probe__serial_open",
      "params": [
        { "key": "host", "in": ["127.0.0.1"] },
        { "key": "port", "in": [3456, 3457] }
      ],
      "action": "allow"
    },
    {
      "tool": "write",
      "action": "ask"
    },
    { "tool": "mcp__probe__reset", "action": "deny", "reason": "无人值守禁止复位" }
  ]
}
```

`RunOptions.permissions` 可覆盖路径、信任、预设、规则、审批超时与审批器；内联值优先级最高，未提供时仍启用权限层并加载用户配置，没有全局关闭开关：

```ts
for await (const event of runSession({
  input: "读取目标寄存器",
  model: "local-gw/flash",
  permissions: {
    preset: "diagnose",
    rules: [{ tool: "read", action: "allow" }],
    approvalTimeoutMs: 60000,
    prompter: { request: async () => "deny" },
  },
})) {
  // ...
}
```

`permissions` 仅接受 `userConfigPath` / `projectConfigPath` / `trustProjectConfig` / `preset` / `rules` / `approvalTimeoutMs` / `prompter`；外层未知键与规则内容错误抛 `PermissionConfigError`，已知字段类型错误抛 `TypeError`。

**ask 与审批**

- `ask` 且提供 `prompter` 时等待审批，默认 120000 ms，超时按拒绝；同一 gate 内审批串行，按进入队列顺序执行。每次审批由 gate 生成独立 UUID `requestId`，`callId` 保持模型原值；`requestId` 是审批与决策的唯一配对键。
- `ask` 且没有 `prompter`（headless demo、未注入审批器的库调用）一律 `effective: "deny"`、`reason: "approval_unavailable"`，工具不执行。
- 审批结果映射：批准 → `effective: "allow"`（理由追加 `approval_granted`）；拒绝 → `approval_denied`；超时 → `approval_timeout`；取消 → `approval_aborted`；审批器异常 → `approval_error: ...`（限长）。
- 桌面宿主由会话运行器注入审批桥，经 `runner.decide()` 回传决策，见「会话运行器与审批」；headless 仍是 `ask` → deny。

**审计事件**

进入权限判定的每次调用都先写 `permission_decision` 会话事件，之后才执行或返回拒绝。payload 含 `requestId`（本次审批的独立 UUID）、`callId`（与 `tool_result.id` 相同）、`tool`、`action`（规则原动作，`ask` 仍记 `ask`）、`effective`、`reason`、`preset`、`source`、可选 `ruleIndex`、`paramsDigest`（稳定序列化后 SHA-256 前 16 位）、`paramsKeys`（顶层键排序，最多 32 个，单键最多 100 码点）、可选 `paramsPreview`（字符串最多 120 码点，整体 4096 字节；超出预算时丢弃后续键并置 `previewTruncated: true`；可能含敏感片段，D-113）、`access`（`read` / `write` / `unknown`）。事件 `parent` 指向对应 assistant 事件，`tool_result` 在其后；`buildMessages` 与前端回放忽略该事件，不占模型上下文。旧日志的 `permission_decision` 可能没有 `requestId`，前端回放才回退按 `callId` 配对。

**MCP 参数边界**

MCP 工具参数 schema 为 `z.unknown()`，不会应用 server `inputSchema` 的默认值或类型转换。参数规则只匹配模型**实际提交**的参数；需要按默认值判定时，必须在提示或规则中要求模型显式提供（D-117）。

**权限演示**

离线（不触网）：

```bash
npm test -- tests/permissions-integration.test.ts
```

覆盖 diagnose 拒绝 `write`、`danger-full-access` 放行，以及项目配置未 trust 时跳过。

live 演示需要用户自备 OpenAI 兼容网关与模型：

```bash
HARNESS_HOME=/tmp/harness-demo \
HARNESS_COMPAT_MODEL=<provider>/<model> \
node dist/demo/run.js "在当前目录写入 demo.txt"
```

默认 `diagnose` 下该写调用返回 `permission_denied`；把 `/tmp/harness-demo/permissions.json` 设为 `{"version":1,"preset":"danger-full-access"}` 后重跑即可写入成功。Windows 使用临时目录的等价写法（如 git-bash `/c/Users/<你>/AppData/Local/Temp/harness-demo`，PowerShell `$env:HARNESS_HOME="$env:TEMP\harness-demo"`）。

## 上下文压缩

长会话按三级处理，**只改变模型视图，不删除或改写会话日志与 artifacts**：

1. **一级落盘**：单条工具结果按 UTF-16 字符数 / 4 估算超过 8000 tokens 时写入会话目录 `artifacts/`，模型消息截断到约 25000 tokens（100000 UTF-16 字符）并附完整输出路径。
2. **二级 microcompact**：估算 token 超过 `contextWindow * softRatio`（默认 0.8）后，把**非 evidence**、非最近 `keepRecentTurns`（默认 2）轮、尚未 elide、且不在最后 summary 的 `coversUpToSeq` 覆盖范围内的工具结果替换为占位（仅当占位长度短于原文，避免短结果膨胀）：有 `artifactPath` 时保留路径引用，否则保留 `<toolName>: <首行 120 字符>`。只追加 `compaction` 事件，原始 `tool_result` 仍在日志。
3. **三级 autocompact**：二级后仍超阈值时，用同一模型把 `coversUpToSeq` 之前的历史摘要为纯文本；尾部按 `keepTailRatio`（默认 0.16）**不被 summary 覆盖**（`microcompact` 仍可能替换其中非 evidence 的工具结果），system 事件始终保留，摘要以 `role: system` 的 `[Conversation summary]` 消息插在最后一条 system 之后（无 system 事件时置顶）。边界若落在 assistant/tool_result 批次中间或会覆盖 evidence，则回退；没有可摘要内容、摘要为空或被 `maxOutputTokens` 截断、边界未超过旧 summary 事件（`no_progress`）、前缀投影失败、摘要调用失败时追加 `compaction {kind:"failed"}`，不静默成功；取消则传播。存在旧 summary 时，新摘要必须覆盖旧 summary 事件；旧摘要由 `buildMessages(prefix)` 注入一次，transcript 不再重复前置。投影层按事件顺序只采信 `coversUpToSeq` 不倒退的有效 summary。摘要落日志后重新测量；仍超阈值时先执行 **emergency microcompact**：忽略 `keepRecentTurns`（最近批次也可修剪）但仍排除 evidence，把非 evidence 工具结果替换为占位（`note` 含 `emergency`），降回阈值内则结束；仍超才追加 `failed{reason:"still_over_budget"}` 并返回。evidence-only 超窗仍无法自动降级（D-099 已缓解但未完全消除）。
   投影层只采用非空、`0 <= coversUpToSeq < summary 事件自身 seq`（因此 `coversUpToSeq === 最后 seq` 非法）、不切断工具批次且不覆盖 evidence 的 summary；非法 summary 回退上一条有效 summary。摘要调用缺 `usage` 时写 `status{status:"usage_missing",stage:"summary"}`，不写零 usage。
   `keepTailRatio` 与 `softRatio` 必须满足 `0 < keepTailRatio < softRatio < 1`，`keepRecentTurns` 必须是非负整数；启用压缩时在 `runSession` / `compactSession` 入口抛 `TypeError`。

evidence 保护：`ToolResultPayload.evidence === true` 的结果不会被二级/三级修剪；投影层会拒绝覆盖 evidence 的 summary（回退上一条有效 summary 或原视图）。MCP 工具可在注册时通过 `_meta: { evidence: true }` 声明证据工具；适配层将其映射为 `annotations.evidence` 与结果上的 `evidence: true`，与内置工具走同一保护路径并写入 `tool_result.payload.evidence`。旧日志中没有 `evidence` 字段的 `tool_result` 按非 evidence 处理（P0 未发布，不做迁移）。摘要请求的 usage 作为独立 `usage` 事件落日志（cached 字段经 `normalizeUsage` 归一化），`query` 在压缩后按会话累计 usage 重算 `costUsd`，因此计入 `maxCostUsd` 熔断。

`RunOptions.compaction`（缺省全开）：

```ts
for await (const event of runSession({
  input: "继续排查",
  model: "local-gw/flash",
  compaction: {
    enabled: true,        // false 时关闭二级/三级
    keepRecentTurns: 2,
    keepTailRatio: 0.16,
    softRatio: 0.8,
  },
})) {
  // ...
}
```

`compaction.enabled` 必须是布尔值，其他类型在入口抛 `TypeError`；配置校验发生在迭代器首次 `next()`（`runSession` 为 AsyncGenerator），未开始迭代时不会抛出。

`compaction.enabled: false` 不注入 compactor / TokenMeter，只保留原有 `checkBudget` 启发式预算检查，也不校验压缩比例与 `keepRecentTurns`。

压缩事件可回放：同一日志经 `buildMessages` 产生同一视图；同一会话重复调用不会重复 elide 已处理的 seq。`compacted` 循环事件只表示“本轮压缩尝试结束”，即使日志追加了 `failed` 也会发出；需要区分成功/失败时读取 `compaction` 事件（D-097）。

## headless demo

```bash
npm run build
node dist/demo/run.js "读取平台信息后结束"
```

环境变量：

| 变量 | 说明 |
|---|---|
| `HARNESS_COMPAT_MODEL` | 必填，`<provider>/<model>` |
| `HARNESS_HOME` | harness 数据目录 |
| `HARNESS_COMPAT_BASE_URL` | 可选，覆盖 provider 的 `baseUrl` |
| `HARNESS_COMPAT_API_KEY_ENV` | 可选，覆盖 provider 的 `apiKeyEnv` |

demo 不读取 `HARNESS_COMPAT_API_KEY`（该变量仅 live 测试使用）；demo 的密钥来自 `HARNESS_COMPAT_API_KEY_ENV` 指向的环境变量。

退出码：

| 码 | 含义 |
|---|---|
| 0 | 正常完成（模型无工具调用） |
| 1 | 熔断（`maxTurns` / `maxCostUsd`；`maxTurns` 默认不限制，只有显式配置时才会触发） |
| 130 | 取消（SIGINT/SIGTERM） |
| 2 | 用法或装配错误（含运行期未恢复错误：模型 4xx/网络/响应非法/会话写入失败） |

会话写入 `$HARNESS_HOME/sessions/<id>/`：`header.json`、`session.v1.jsonl`、按需生成 `session.vN.jsonl` 与 `artifacts/`。

## 工作台（桌面）

前端是 `desktop/renderer/` 下的一套纯 ES 模块，只跑在 Electron 里：Electron 窗口 + `desktop/host/host.js` 宿主进程（NDJSON over stdio），宿主复用 `dist/` 下的内核模块。渲染器的 `window.prometheus` 由 `desktop/preload.cjs` 注入。

> 2026-10-22：浏览器形态已下线，`desktop/renderer/bridge.js`、`src/server` 的 HTTP 层与 `serve:ui` 脚本一并删除。

```bash
npm run build          # 内核产物，桌面宿主依赖它

npm --prefix desktop install   # 桌面形态的一次性依赖安装（由用户执行）
npm --prefix desktop run desktop
```

- **环境变量**：`HARNESS_HOME` 指定会话与知识库根目录（默认 `~/.harness`）；`HARNESS_WEB_MODEL` 指定默认模型引用。
- **协议层**：`desktop/renderer/protocol.js` 把内核 `SessionEvent` 翻译成渲染器认识的事件（`assistant` → `start/delta/end`、`tool_started`+`tool_result` → 工具行、`approval_request` → 审批条等）。宿主与渲染器是两个进程，这一层是它们共用的映射。
- **输入框里的两个前缀**（2026-10-22）：`@` 打开文件名补全（内核 `searchFilesByName`，按「基名全等 → 前缀 → 包含 → 路径包含」分层排序，目录不在结果里）；`/` 打开命令补全，内置三个——`/clear`（新建会话）、`/context`（报当前上下文占用，未知时明说没测量而不是打印 0）、`/compact`（立即压缩，一律执行、不看阈值），**其后跟着你保存的技能**（见下节）。三个内置命令都**不接受参数**：内核压缩没有 focus / keep 选项；技能则相反，参数会被替换进正文。敲一个不认识的名字只会得到一条提示，草稿留在输入框里，不会被当成提示词发给模型。
- **配置**：设置页有「模型服务」「MCP 服务器」「行为」三页。模型服务读写 `$HARNESS_HOME/providers.json`（provider / `baseUrl` / `apiKeyEnv` / 模型名），首次启动缺这份文件时会提示去这里填，**不会**因它缺失而拒绝启动。「`apiKeyEnv` 填的是环境变量名，不是密钥」——应用本身不保存密钥，只在调用时从自己的运行环境读该变量。每张服务卡片有**「测试连接」**：请求 `GET {baseUrl}/models` 列出可用模型，非 2xx 且填了模型名时退一步打一次极小请求（`max_tokens: 1`）；失败原因分「地址不通 / 鉴权失败 / HTTP 错误 / 地址非法」并说清楚，鉴权失败还会区分「环境变量没设置」和「密钥被拒」。结果区（2026-10-22 重做）是一条状态行（勾选图标 + 「连接正常 · N 个模型可用」+ 单独的延迟数字），下面是「可用模型」标题与计数，再下面是可以直接点的模型 chip——**卡片上已经列出的模型不再被静默丢弃**，而是画成禁用态的「已添加」chip，否则结果块会少掉一半答案（R3）。端点可达但一个模型都没列出来时，勾选图标用警告色而不是成功色。`contextWindow` 与 `maxOutput` 不在表单里——OpenAI 兼容协议不提供真实值，内核按估算默认值处理（128000 / 4096），需要精确值时在 `providers.json` 里手写，**写入优先**。价格同理不再出现在界面，旧文件里已有的 `pricePerMillion` 保存时原样保留。桌面宿主直接写盘；`getSettings` 同时给出 `providers`（选单用的扁平列表）与 `providerConfig`（文件本体，设置页据此画表单并整份写回），文件读坏时带 `providersError` 说明原因，表单仍可编辑——保存即覆盖。MCP 页读写 `mcp.json`；行为页读写 `permissions.json`（预设 / 审批超时 / 审批规则）与 `run.json`（`maxTurns` / `maxCostUsd` / `timeoutMs` / `systemPrompt`）。运行上限由宿主从 `run.json` 读取后随每次 prompt 下发。改动在下一回合生效，不手编文件也能接上探针与模型。
- **会话管理**：侧栏右键可改名、置顶、归档、删除、复制为新会话；标题存 `meta.json`，与内核的 `header.json` 分离。列表按 `updatedAt` 倒序，改过名的会话不会被埋在新建会话下面。
- **导出**：顶栏「⋯」菜单导出当前对话为 Markdown，内容由会话日志渲染（不是抓 DOM），工具输出按 2000 字符截断。
- **工作区**：顶栏的工作区按钮可切换目录，弹系统目录选择框。选中的目录同时被登记为文件树的浏览边界，文件树（顶栏「⋯」→ 浏览工作区文件）只列已登记工作区、会话目录与会话工作目录内的路径。
- **诚实边界**：提交失败在转录中显示可读错误，不伪造成功。内核没有的能力（git/PR、终端、worktree、packs、memory/instructions/hooks、subagents、goals、`@` 提及的文件名搜索、检查点恢复）在前端隐藏入口，宿主收到对应命令时回显式 `notice`，不静默吞掉（R3）。目录列不出来时会先说明原因再给空树——空树是「渲染器可以收尾了」的信号，不是「这个目录是空的」的断言。
- **审批**：内核按单次请求审批，没有「始终允许」的持久规则；该按钮不渲染。审批条展示 `approval_request` 携带的 `paramsPreview`（这次调用要写入/执行的参数），并按 `deadlineAt` 显示剩余秒数——批准一次写操作时能看见写的是什么（R2）。审批超时/中止时由 `permission_decision` 触发 `permission_closed`，审批条自动收起。
- **空态**：无会话显示「暂无会话」；设备字段为 `unknown` 时显示「未接入」。
- **主题**：`light` / `system` / `dark` 三态，`localStorage` 键 `prometheus.theme`，默认 `dark`；所有颜色经 CSS 变量，图标为内联 SVG sprite。
- **验收**：`npm test` 覆盖协议层与宿主；桌面形态需本机安装 Electron 后手动验证。
- **安全边界**：写内存/复位需显式确认，确认后仅显示「等待工具结果」，不会在前端伪造「已执行」（R2）；工具失败显式展示错误码与文本（R3）。

### 技能（skills）

技能就是一个 Markdown 文件，正文是提示词模板；在输入框敲 `/名字 参数`，正文会被当成一条普通消息发给模型。

两个作用域，同名时**项目覆盖用户**：

| 作用域 | 位置 |
|---|---|
| 用户（这台电脑） | `$HARNESS_HOME/skills/<name>.md`（默认 `~/.harness/skills/`） |
| 项目（这个文件夹） | `<工作目录>/.harness/skills/<name>.md` |

文件格式：可选的 frontmatter（只认 `description` 与 `argument-hint`）加正文。**没有 frontmatter 也是合法技能**，整份文件就是正文。

```markdown
---
description: 审查当前的改动，列出有风险的地方
argument-hint: "[路径或分支]"
---
只读审查 $ARGUMENTS 的改动：逐项说明改了什么、可能影响哪些外设时序，
并列出需要人工确认的点。不要修改任何文件。
```

- **名字**：小写字母开头，只含小写字母、数字、`-`、`_`，最长 64 字符。不能叫 `clear` / `context` / `compact`——那是内置命令，同名技能永远轮不到执行，读取时会被报成问题并跳过。
- **`$ARGUMENTS`**：单个占位符，`/review src/uart.c` 把 `src/uart.c` 整段替进去。正文里没有这个占位符时，参数会作为**追加的一段**接在正文后面。没有命名参数，也没有参数校验。
- **调用**：在输入框敲 `/`，命令面板里技能与内置命令混排。写了 `argument-hint` 的技能点一下只把 `/名字 ` 插进输入框，等你把参数敲完再回车；没写 hint 的技能与内置命令一样点一下就跑（没有参数可等，空参数展开）。**只有你敲 `/名字` 才会触发技能**——模型看不到技能清单，也不能自己挑一个来用。
- **管理**：设置 →「技能」页可以新建、编辑、删除，列表上标着每个技能属于哪一层；frontmatter 没闭合、名字非法之类的文件会在页面顶部单独列出来并给出路径，不会让整个列表变空。**保存被拒时表单不关闭**，草稿留在原处，错误行就在页面顶部——设置页是盖在对话上面的对话框，把失败写进下面的转录等于没写（R3）。
- **边界**：技能是提示词模板，**不会绕过权限**。技能正文里劝模型去用的工具，仍然逐个经过内核的权限与审批（写内存、复位照旧要确认）。项目作用域的技能从工作目录直接读取，不需要信任确认——但在别人的仓库里打开时请留意同名技能会覆盖你自己的那一份。

## 实时事件流

工作台的实时事件来自会话日志本身：宿主用 `LogTailEventSource` 跟随当前会话的日志文件，经 NDJSON over stdio 推给渲染器。实时流与回放共用同一份 `SessionEvent`，不维护第二套事件模型；所有实时事件必须先成功落会话日志再被投影。

- **事件类型**：`approval_request`（参数摘要与截止时间，不含参数原文）、`tool_started`（`{callId,tool,access?}`）、`tool_result`、`permission_decision`、`mcp_status`、`device_status`，以及既有 `system/user/assistant/usage/checkpoint/status/interrupted/compaction`。`tool_call` 仅用于旧日志回放，新代码不再产生。`permission_decision` 中 `action=ask,effective=deny` 表示最终未获批准且工具未执行（原因可能是 `approval_unavailable` / `approval_denied` / `approval_timeout` / `approval_aborted`，需看 `reason`）；`mcp_status` 的 `kind` 覆盖 `connected/connect_failed/tools_changed/tools_refresh_failed/tool_invalid_schema/listener_failed/call_failed/config_failed/config_warning/project_config_skipped/tool_name_renamed`。
- **流式回答**：模型适配层默认请求 OpenAI 流式响应（`stream:true` + `stream_options.include_usage`），按 SSE 帧解析 `delta.content` 与 `delta.tool_calls`；网关拒绝流式时自动降级为一次性响应，该 provider 后续不再试探。内核把增量写进 `assistant_delta` 事件（`{text}`，按批落盘：默认 60ms 或 400 字符），`assistant` 事件仍承载这一轮的完整内容，投影层忽略 delta、只用 `assistant` 重建模型上下文。
- **设备状态契约**：MCP 工具在**成功**结果（`isError !== true`）的 `structuredContent.deviceStatus` 返回普通 JSON 对象；序列化后 ≤ 8 KiB、深度 ≤ 4。内核校验后写 `device_status`，payload 为 `{callId, server, tool, state}`。`state` 的键与值完全由 MCP server 决定，内核与 UI 不解释、不补全、不推断；UI 只 patch 已知字符串字段 `probe/serial/cpu/backend`，未知键与非字符串值忽略。失败、权限拒绝、超时/取消不产生 `device_status`；`deviceStatus` 存在但解析失败（非普通对象、超限、访问器/循环等）时写 `status {status:"device_status_invalid", tool, message}` 显式审计；`structuredContent` 非对象或缺少 `deviceStatus` 键时静默跳过，不猜测状态。
- **断线续传**：客户端独占游标 `lastSeq`，按 `seq` 去重（协议层丢弃 `seq <= lastSeq` 的事件）。桌面宿主按 `headSeq` 游标跟随本地日志，一轮结束（`status.done` 或日志被关闭）即收尾。**原先浏览器 bridge 的两层恢复——缺口检测（整量重拉会话）与 `stream_error` 续接——已随浏览器形态一起移除**；SSE 端点、帧格式、心跳与慢客户端处理（`slow_consumer`）同样不再存在，也不再需要。
- **延迟与证据**：宿主以 200ms 轮询日志跟随，实际延迟还受文件读取与事件循环调度影响，无硬上限，也未压测；进程内低延迟适配器未实现（D-134）。证据由 `tool_result.payload` 的 `evidence/artifactPath/detail` 承载，没有独立 `evidence` 事件（D-135）。
- **审批事件**：`approval_request` 由审批桥在等待前写入日志，再由宿主投影为待审批卡片；决策与执行结果见「会话运行器与审批」。

## 会话运行器与审批

> 2026-10-22：浏览器形态已下线，`src/server` 的 HTTP 层随之删除。本节保留会话运行器与审批的契约（模型回退、运行器语义、错误码、审批配对与失败语义）；桌面宿主经 `runner.start()` / `runner.decide()` 调用，错误以 `RunnerError.code` / `RunnerDecideOutcome.kind` 表达。

**模型**

- 读取 `$HARNESS_HOME/providers.json`；模型引用按 `HARNESS_WEB_MODEL` → providers 中第一个 `<provider>/<model>` 的顺序回退（运行器显式 `model` 选项优先）。
- 追加输入时优先使用会话 `header.model`；`header` 无模型时与新建会话相同，回退到 `HARNESS_WEB_MODEL` 与 providers 第一个引用。
- providers 缺失、JSON/schema 错误或引用无效统一以 `model_unavailable` 失败，message 说明检查 `HARNESS_HOME/providers.json` 与 `HARNESS_WEB_MODEL`，且不包含本机绝对路径（home 路径脱敏为 `HARNESS_HOME`）；`session_unreadable` 只给出「会话不可读」。

**运行器语义**

- 同一会话同一时间只允许一次运行；运行期间再次启动返回 `session_busy`（桌面宿主在前端就拦住并提示「当前回合尚未结束」）。
- 启动返回前会话 `header.json` 必须已落盘；默认 10s 内未就绪则 abort 并以 `session_start_timeout` 结束。
- 运行错误留在会话日志，由宿主推给渲染器；不再有 HTTP 响应可回传。

### 运行请求

请求：

```json
{ "text": "读取 0x20000000 的 4 字节", "sessionId": "可选", "mode": "可选",
  "maxTurns": null, "maxCostUsd": 0.5, "timeoutMs": 60000, "systemPrompt": "可选" }
```

缺省 `sessionId` 新建会话；带 `sessionId` 时向该会话追加输入（使用 `header.model` 与 `header.workdir`）。`mode` 是本次运行的权限预设（`read-only` / `workspace-write` / `diagnose` / `danger-full-access`），覆盖运行器构造时的预设，仅对这一次 run 生效。

`maxTurns` / `maxCostUsd` / `timeoutMs` / `systemPrompt` 是本次运行的上限，缺省时用内核默认值（**`maxTurns` 默认不限制**、无成本上限、provider 的 `requestTimeoutMs`、默认系统提示词）。`maxCostUsd` 只在 provider 配了 `pricePerMillion` 时生效。

**`maxTurns` 默认不限制，填了才生效**（D-183 补充，2026-10-22）：给一个正整数就按它截断，这一次运行以 `interrupted{reason:"max_turns"}` 结束，下一条消息重新从 1 开始；`null` 或不传等于不检查。**刻意没有默认上限**——任何隐式数字都会在长诊断里静默截断一次本来能跑完的运行，而用户真实遇到过 10 轮之后连提问都发不出去的会话。0 / 负数 / 非整数一律以 `invalid_run_limits` 拒绝，不静默当成「不限」。会话级的 `checkpoint.turn` 仍然跨消息单调递增（D-045）。`maxCostUsd` 相反——它是**会话总预算**，会把历史 `usage` 算进去，所以一次会话的花费越过上限后，后续消息会在首次模型调用之前就以 `max_cost_usd` 结束。

成功时运行器返回 `{ sessionId, created }`（`created` 表示这次新建了会话）。

调用失败时抛 `RunnerError`，`code` 取值与触发条件：

| code | 条件 |
|---|---|
| `invalid_text` | `text` 为空/纯空白、超过 8000 字符 |
| `invalid_session_id` | `sessionId` 非法 |
| `invalid_mode` | `mode` 不是四个预设之一 |
| `invalid_run_limits` | `maxTurns` 不是正整数（`null` 合法，表示不限）/ `maxCostUsd` / `timeoutMs` 非数字或非正，`systemPrompt` 非字符串 |
| `invalid_cwd` | `cwd` 不是已存在的绝对路径目录 |
| `invalid_model` | `model` 不是字符串 |
| `unknown_session` | 指定会话不存在 |
| `session_busy` | 同会话正在运行 |
| `session_corrupt` | 追加会话的 header 损坏 |
| `session_unreadable` | 追加会话的 header 不可读（EACCES/EPERM） |
| `model_unavailable` | providers 缺失/无效/引用无效 |
| `session_start_timeout` | 就绪超时（运行器已 abort） |
| `runner_unavailable` | 运行器已关闭或未注入 |

### 审批决策

宿主经 `runner.decide(sessionId, requestId, "allow" | "deny")` 回传决策，结果 `kind` 为 `accepted` / `duplicate` / `unknown_request` / `expired` / `already_decided` / `unknown_session` / `runner_unavailable`。

`requestId` 是权限 gate 为每次审批生成的独立 UUID，与模型工具调用 `callId` 解耦：同一 `callId` 跨轮复用时两次审批的 `requestId` 不同，迟到决策不会命中更新的审批。

**受理语义**：`accepted` 只表示决策已送达 gate，不表示工具已执行；最终结果以会话日志的 `permission_decision` 为准（批准为 `effective: "allow"` 且 reason 含 `approval_granted`，拒绝为 deny）。渲染器不本地伪造终态，等 `permission_closed` 收起审批条。

**前端发送语义**：追加输入成功后只刷新会话列表，保持当前视图与事件跟随，不重载会话；只有新建会话（提交前没有 `activeSessionId`）才按返回的 `sessionId` 切换。

**失败语义**：审批超时（`approvalTimeoutMs`，默认 120000ms）、用户拒绝、会话中断均不执行工具，日志以 `permission_decision` deny 收尾；迟到决策返回 `expired`，会话结束后返回 `unknown_session`。服务重启后未决审批丢失，`resumeSession` 会补 `approval_aborted: crash_recovery` 审计（按事件顺序配对：`requestId` 优先，旧日志无 `requestId` 时按 `callId` 配对最早一条待决；同 `callId` 的已决审批不会重复补写）。`query` 启动前的失败会写 `interrupted`（`reason: "start_failed"`）。headless demo 与未注入审批桥的库调用仍是 `ask` → deny（`approval_unavailable`）。

**演示**：启动桌面形态后在输入栏发送需要 `ask` 的指令（默认 `diagnose` 下让 `shell` 执行无害命令，或让 `write` 写临时文件），页面出现审批卡片；批准后工具执行，拒绝后不执行。过程记录见 `dev-notes/M2-Web审批.md`。

## 会话管理

```text
<sessionDir>/
├── header.json          # id、createdAt、status、provider、model、workdir、forkedFrom
├── session.v1.jsonl     # 首代事件日志
├── session.vN.jsonl     # 单代超过阈值（默认 50 MiB）后按需生成
└── artifacts/           # 工具产物（按需）
```

- `header.status` 取 `open` / `closed`：create/resume 后为 `open`，`close()` 用临时文件 + `fsync` + rename 原子写 `closed`，重复 close 幂等。
- create 把 `provider` / `model` / `workdir` 写入 header；`workdir` 记录创建时的进程 cwd。
- 分代：append 前按字节判断，仅当当前代非空且追加后会越过阈值才新建 `session.v(N+1).jsonl`；读取按代数字升序合并，seq 跨代连续；代编号必须从 v1 连续，缺档抛 `SessionCorruptionError(invalid_event_line)`。
- 目录锁：`createSession` / `resumeSession` / `forkSession` 在目录内以 `session.lock`（`O_EXCL`）持有单写者锁，直到 `close()`；另一存活进程持锁时抛 `SessionResumeError("session_locked")`；持有者崩溃后按 PID 存活自动回收。
- 每轮模型请求前由 `query` 追加 `checkpoint` 事件（`payload.turn`），只落会话日志，不进入 `LoopEvent` 流；`turn` 在同一会话内续编。

### resume

`runSession` 的 `RunOptions` 支持 `resume: true`，必须显式提供 `sessionDir`：

```ts
for await (const event of runSession({
  input: "继续排查",
  model: "local-gw/flash",
  resume: true,
  sessionDir: "C:/Users/me/.harness/sessions/<id>",
})) {
  // ...
}
```

前置与校验（均在首个 `next()` 前抛 `SessionResumeError`，失败不写 header/日志）：

- `sessionDir` 缺省、目录或 header 不存在 → `missing_session_dir`；`sessionDir` 为空或路径为文件 → `invalid_target`。
- `model` 与 `header.model`（存在时）不一致 → `model_mismatch`。
- 显式传入的 `sessionId` 与 `header.id` 不一致 → `session_id_mismatch`。
- 提供 `systemPrompt` 且已有 system 事件内容不同 → `system_prompt_mismatch`；非空会话无 system 事件时不允许补写，空会话可补写。
- 不重复写已有 system/user 事件；resume 后 `header.status` 改回 `open`。
- 崩溃尾部恢复：若日志最后一个 assistant 批次的 `toolCalls` 缺少 `tool_result`，resume 会按原调用顺序补写 `tool_result_lost`（`detail.crashRecovery = true`）并追加 `interrupted { reason: "crash_recovery" }`；其他投影错误仍 fail-closed。

### fork（仅库 API）

`forkSession` 位于 `src/session/persistence.ts`（构建后 `dist/session/persistence.js`），**尚未接入 CLI / `runSession`**：

```ts
import { forkSession } from "./dist/session/persistence.js";

const child = await forkSession(sourceDir, atSeq, {
  id: "branch-1",          // 可选，缺省随机
  targetDir: "…/branch-1", // 可选，缺省 $HARNESS_HOME/sessions/<id>
});
```

- `atSeq` 必须使 `events[0..atSeq]` 可被 `buildMessages` 投影（批次闭合），而非按事件类型判断：批中 `usage`、部分 `tool_result`、未闭合的 assistant 批次均 → `not_turn_boundary`；无工具轮的 `usage` 前缀与普通 user 前缀可通过。前缀含 `atSeq` 并保留原 `seq` / `parent`，新 header 写 `forkedFrom: { sessionId, seq }`。
- `opts.id` 不得与源会话 id 相同；`targetDir` 不得位于源会话目录内（含相同目录），否则 `invalid_target`。
- artifact 自包含：前缀中 `tool_result.payload.artifactPath` 指向的文件复制到新会话 `artifacts/` 并重写路径；源文件缺失标 `detail.artifactMissing = true`，越界/链接越界/非普通文件标 `detail.artifactRejected = true`，均保留原路径且不阻塞 fork。
- target 目录已存在（含空目录）→ `target_not_empty`；`targetDir` 或其父路径为文件 → `invalid_target`；失败时回滚本次写入并释放锁。
- 不同会话可并发追加、互不影响；同一目录由目录锁保证单写者（D-039 已解决）。

## live 测试

默认跳过，不触网。开启后使用真实 OpenAI 兼容网关（git-bash）：

```bash
# git-bash
HARNESS_COMPAT_LIVE=1 \
HARNESS_COMPAT_MODEL=local-gw/flash \
HARNESS_COMPAT_BASE_URL=http://127.0.0.1:8080/v1 \
HARNESS_COMPAT_API_KEY=your-key \
npm test
```

PowerShell：

```powershell
$env:HARNESS_COMPAT_LIVE="1"; $env:HARNESS_COMPAT_MODEL="local-gw/flash"; $env:HARNESS_COMPAT_BASE_URL="http://127.0.0.1:8080/v1"; $env:HARNESS_COMPAT_API_KEY="your-key"; npm test
```

`HARNESS_COMPAT_MODEL` 同样使用 `provider/model` 引用，测试会从 `providers.json` 解析出裸模型名与 `apiKeyEnv`；`HARNESS_COMPAT_BASE_URL` 可覆盖 `baseUrl`；`HARNESS_COMPAT_API_KEY` 优先于 `apiKeyEnv`。

## 已知限制

见 `docs/deferred-issues.md`。当前与 P0 直接相关的：

- 超时/取消已阻止同批后续写调用启动，但不响应 signal 的残留工具仍可能在后台继续（D-022 已缓解；D-071/D-077）。
- 网关不返回 `usage` 时 `maxCostUsd` 无法生效（D-027）。
- token 估算按 UTF-16 字符数 / 4，CJK 场景偏低（D-005）；`tool_calls` 已按序列化长度计入（D-033 已解决）。
- 会话 header 与日志已 fsync；极端断电仍可能留下半行，resume 会补齐末行换行并做崩溃尾部恢复（D-035 已解决）。
- 4xx 中 408/409/425 已按可重试处理，其余不重试（D-036 已解决）。
- 工具 JSON Schema 可能携带 `$schema`，严格网关兼容性待 live 验证（D-019）。

上下文压缩：

- 压缩会改变消息前缀，可能打断 provider 的 prompt cache；当前不修复、也未实现 `cached_tokens` 突降告警（D-091）。
- 摘要为同模型一次性生成，无完整性校验，可能遗漏细节（D-092）；逐事件 token 估算仍为近似值（D-093）。
- 摘要失败只记录 `compaction {kind:"failed"}`，不会自动重试（D-094）；`compaction` 事件会随会话持续增长（D-095）。
- `keepRecentTurns` 默认 2 轮未按模型/场景验证（D-096）。
- 无 `artifactPath` 的 evidence-only 超窗仍只能记录 `still_over_budget`/`no_progress`；非 evidence 结果与带 `artifactPath` 的 evidence 可在 emergency 阶段降级（D-099 已缓解）。

内置工具：

- `glob` / `grep` 已响应取消（D-077 已解决）；`grep` 仍先收集全部命中再截断（D-078）。
- `shell` 危险命令拦截是启发式、非沙箱，`env` / `bash -c` / `xargs` 等可绕过（D-083）；改目录方式与 shell 展开未覆盖（D-087、D-088）。
- `glob` 编译仍有正则回溯风险（D-086）；`grep` 的 `glob` 过滤已预编译（D-090 已解决）；跳过披露已区分文件与目录，仍未列具体路径（D-089 已解决，D-084 部分解决）。
- 工具根与 resume 的 workdir 只做词法比较，不解析 symlink / 8.3 短名（D-082）。

MCP：

- 超时/取消会终止 transport、轮询 PID 确认退出后再允许重连；终止未确认时返回 `mcp_uncertain` 并拒绝重连。内置 `read`/`write`/`edit`/`multiedit`/`glob`/`grep`/`shell` 均已响应 signal；剩余风险仅限自定义/第三方 in-process 工具故意忽略 signal（D-022 已缓解，D-071/D-077 已解决）。
- 默认 env 白名单可通过 `inheritEnv: true` 或 `envAllowlist` 放宽；放开后第三方 server 可读取相应父进程变量（D-102 已解决，配置方需知悉）。
- 配置未知字段（含 typo）静默忽略（D-103）；刷新失败保留旧缓存且不自动重试（D-104）。
- 工具名消歧依赖 server 返回顺序，跨会话稳定性未保证（D-100）；会话结束与 list_changed 重叠时可能丢失最后一条 status 审计（D-101）。
- 仅支持 stdio；未启用 2026-07-28 协议的 `subscriptions/listen`。

前端工作台：

- 实时事件由宿主跟随会话日志（NDJSON over stdio）推送，审批见「会话运行器与审批」。
- 日志跟随是 200ms 轮询投影：延迟约 200-250ms，无进程内低延迟适配器（D-134）。原先的单会话 SSE 流已随浏览器形态移除（D-133 一并作废）。
- 宿主按 `headSeq` 游标跟随本地日志，没有缺口检测与整量重拉。
- 设备面板只消费 MCP 显式发布的 `device_status`（板卡面板的「设备」段）；无该事件时设备字段恒为 `unknown`，缺少显式连接状态枚举（D-052、D-058）。
- 内核不支持的能力仍无前端入口：git/PR、终端、worktree、packs、浏览器、memory/hooks、goals、subagents、检查点恢复、会话回放；清单见 `desktop/MATRIX.md` 与 `docs/deferred-issues.md` D-166。（技能已在 2026-10-22 接通，边界见 D-198：它是提示词模板，不绕过权限，模型也不能自己挑。）
- **已登记的、用户会直接撞到的缺口**（2026-10-22 复核，D-184 ~ D-193）：
  - Board 面板是唯一常驻的工作台页签，但它发的 `getBoardState` 在桌面宿主里**没有 handler**（D-193）——点开只得到「暂不支持该命令」。板卡信息实际经 `device_status` 事件下发。
  - 运行中给发送按钮标的「排队」是**假的**：气泡显示「排队中」，消息仍被宿主拒绝并丢弃（D-186）。
  - 图片附件会被静默丢弃：缩略图留在输入框上，`submit()` 不读 `state.attachments`，内核也不支持图片输入（D-188）。
  - About 页的「检查更新」调用的 `api.checkUpdate` 桌面宿主没有提供，点一下必崩（D-187）。
  - 上下文弹层的「用了多少 / 被什么占的」已接通（`usage` 事件同时带 `context` 与 `contextBreakdown`，分段条与图例不再是死代码）。**D-195 修掉的那条要认真看**：占用率原先在 `usage` 落盘时重新投影日志来测，那一刻工具批次未闭合、必然抛错被吞，所以**每一条带工具调用的回合都没有占用率**——而本仓库几乎每轮都在调工具。现在测量移到发请求之前，量的是即将送出去的消息。
  - 快捷键表里的 `Ctrl+Shift+D`（Changes）不做事、`Ctrl+Shift+E`（Files）打开的是 Board、`` Ctrl+` ``（Terminal）被 `SUPPORTED_PANES` 挡掉（D-192）。
  - MCP 客户端只支持 stdio（D-190）；`timeoutMs` 只作用于单次工具调用，**没有整跑墙钟超时**（D-189）。
  - `@` 搜索不返回目录（D-184）；`kb_grep` / `kb_glob` 仍无拒答机制（D-179）。
- 会话列表的坏目录进 `errors`，界面在会话面板底部显示「N 个会话目录不可读」（D-065 已解决）。
- 知识库扫描深度上限 8、条目上限 2000、文件计数上限 20000；触顶时 `getKb` 返回的 `truncated` 为真，`fileCount` 只作「至少 N」读（D-064 的静默截断已消除，旧 `scanKb` 实现一并移除）。

## 设计文档

- `docs/BRD.md` — 业务需求与路线图
- `docs/p0-kernel-design.md` — P0 内核设计
- `docs/frontend-design.md` — 前端设计规范（布局、令牌、组件、验收；v2.0 以 `desktop/renderer` 实现为准）
- `desktop/MATRIX.md` — 前端命令/事件能力矩阵（已支持 / 隐藏 / 原因）
- `docs/superpowers/specs/2026-10-16-p0-kernel-dims-1-2-design.md` — 维度 1+2 可实现设计
- `docs/superpowers/plans/2026-10-16-p0-kernel-dims-1-2.md` — 实现计划
- `docs/deferred-issues.md` — 已知问题与升级条件
