# Embedded-Ai-Master

面向嵌入式调试场景的 agent 内核，附带一个可运行的 Web 诊断工作台。当前交付 P0 内核（主循环与模型接入、会话事实源、内置工具、headless demo）与前端工作台（三栏布局、三态主题、消息流、调试坞、真实会话/知识库/设备状态读取）。

## 技术栈

- TypeScript + Node.js >= 24（ESM-only）
- Zod v4
- Vitest v4
- Preact 10 + Vite 8（前端工作台；`@preact/preset-vite`、happy-dom 仅用于构建与测试）
- 实时通道：SSE + HTTP POST（前端保留 `EventSource` 替换点，当前交付抽象层）

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

npm run dev:web       # 启动前端开发服务器（Vite）
npm run build:web     # 构建前端到 dist-web/
npm run test:ui       # 仅跑前端测试（tests/ui）
npm run typecheck:web # 前端类型检查（tsconfig.web.json）
npm run verify:ui     # V1-V14 浏览器视觉验收（需 Chrome/Edge）
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
├── server/       只读 HTTP API（会话 / 知识库 / 设备）与静态资源服务
├── tools/        工具契约、注册表、echo/fs/shell/glob/grep、五阶段执行管线
├── ui/           前端工作台（Preact 组件、TranscriptView 投影、SSE 抽象）
└── index.ts      runSession 装配
web/              Vite 入口 HTML
scripts/          verify-ui.mjs 浏览器视觉验收
tests/            Vitest 测试（tests/ui 为前端测试）
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

模型引用为 `provider/model`（如 `local-gw/flash`）。`apiKeyEnv` 指向的环境变量存在且非空时发送 `Authorization: Bearer <key>`；否则不发送该头（本地网关可空跑）。`pricePerMillion` 缺省时只统计 token，不启用 `maxCostUsd` 熔断。`requestTimeoutMs` 默认 120000，超时抛可重试的 `RequestTimeoutError`；`maxResponseBytes` 默认 8388608（8 MiB），流式读取超限即取消并抛 `invalid_response`。

## 内置工具

`runSession` 默认注册 `echo` / `fs` / `shell` / `glob` / `grep` 五个工具（`createBuiltinTools()`，顺序固定）。工具根（`ToolCtx.cwd`）为 `opts.cwd ?? header.workdir ?? process.cwd()`：创建会话时 `opts.cwd`（缺省 `process.cwd()`）同时写入 `header.workdir`；resume 未传 `opts.cwd` 时沿用 `header.workdir`，两者都提供且不一致时抛 `SessionResumeError("workdir_mismatch")`，失败不写 header/日志。所有相对路径按工具根解析。

| 工具 | 能力 | 注解 |
|---|---|---|
| `echo` | 回显输入，用于连通性验证 | 只读 |
| `fs` | `read` / `write` / `edit` 文本文件 | 非只读、destructive |
| `shell` | 执行 shell 命令（非沙箱） | 非只读、destructive |
| `glob` | 按 glob 模式查找文件 | 只读 |
| `grep` | 按正则搜索文件内容 | 只读 |

### `fs`

- `read`：`path` + 可选 `offset`（0 起行号）/`limit`（≤2000 行）；单次最多 2000 行、256 KiB，超出以 `[truncated]` 标记，`detail.nextOffset` 给出继续读取的位置；`offset` 越界返回 `(no lines at offset)`。
- `write`：`path` + `content`，自动创建父目录。
- `edit`：`path` + 非空 `oldText` + `newText`；`oldText` 必须唯一命中，否则 `edit_not_found` / `edit_not_unique`；按文件现有 CRLF/LF 风格写入。
- workdir 限制：解析到工具根之外（含 `..`、绝对路径、symlink/junction 逃逸）→ `path_outside_workdir`；Windows 保留设备名 → `reserved_name`；`read` / `edit` 目标不是普通文件 → `not_a_file`；`write` 目标为目录或底层写入失败 → `write_failed`。
- `fs` 响应 `AbortSignal`：read 的流、write/edit 的 `readFile`/`writeFile` 都接 signal；取消返回 `aborted`，write/edit 会提示可能留下部分文件。

### `shell`

- **非沙箱**：命令交给系统 shell（`spawn(command, { shell: true })`）执行，仅对已知高危命令做黑名单拦截，不限制其余命令的读写范围；`cwd` 必须位于工具根内，越界 / 不存在 / 非目录 → `cwd_invalid`。
- 拦截：判定前移除 token 内所有 `'`/`"` 再归一目标（覆盖 `rm -rf "/"*`、`rm -rf "$HOME"/*`、`del /s /q "C:\"*`）；`rm` 带 `-r`/`-R`/`--recursive` **或** `-f`/`--force` 任一且打 `/`、`~`、`$HOME`、多级 `..`、盘符根及其归一化变体（如 `../*`、`~/..`、`/tmp/../*`、`C:/..`）即拦截，`--no-preserve-root` 一律危险；跟踪 `cd` / `pushd` / `chdir` / `Set-Location` 的根目标（无参 `cd` / `chdir` / `pushd` 均保守视为根），后续 `rm -r *` / `rm -f *` / `del /s /q *` 一并拦截；`mkfs*`、`format <盘符>:`、`diskpart`、`bcdedit`、`shutdown` / `reboot` / `poweroff` / `halt`、`dd of=/dev/*`、`del|erase|rd|rmdir /s` 打盘符根、`reg delete HKLM`、`cipher /w`、fork bomb；命中返回 `dangerous_command` 且不 spawn。
- 退出语义：命令跑完即 `isError:false`，`text` 首行 `exit=<code>`；**非零退出码不算工具错误**，由模型读 `detail.exitCode` 判断。被信号终止 → `shell_terminated`（`detail.exitCode` 可能为 `null`）；`spawn` 失败 → `shell_spawn_failed`。
- 取消：`signal` abort 后 Windows 用 `taskkill /T /F`、POSIX 杀 detached 进程组；1s 后升级 `SIGKILL`/再次 `taskkill`，3s 仍未确认退出则返回 `shell_aborted` 并写 `detail.abortEscalated`/`terminateFailed`，Promise 必定 settle（文本会明确“process termination not confirmed”）。stdout / stderr 各截断到 1 MiB 并标记；`detail.stdout` / `detail.stderr` 只保留前 4096 字符摘要（不切断代理对），完整输出在 `text`，由管线按需截断或落盘；`detail` 另含 `stdoutBytes` / `stderrBytes` 与截断标记。
- 黑名单是启发式（`env`、`bash -c`、`xargs` 等可绕过；改目录方式与 shell 展开仍未覆盖，D-083/D-087/D-088），不能当作安全边界。

### `glob` / `grep`

- `glob`：`pattern` 匹配**相对工具根**的 POSIX 路径（不是 `path` 根）；`*` 不跨 `/`、`?` 匹配单字符、`**/` 匹配任意层目录、段尾 `**` 匹配剩余路径，其余字符按字面量；反斜杠按 `/` 处理；大小写敏感。pattern 长度 ≤256、段数 ≤64，连续 `**/` 会折叠；超限视为非法。返回字典序路径，最多 200 条，超出 `[truncated]`；扫描上限 5000 个文件，超出 `[scan truncated at 5000 files]`。
- `grep`：`pattern` 为正则（`ignoreCase` 可选），可加 `glob` 过滤、`maxResults`（1–1000，默认 200）；`glob` 非法（空 / NUL / 超长 / 超段数）→ `invalid_pattern`，不静默无匹配。输出 `<相对路径>:<行号>:<文本>`，按路径与行号排序，超出 `[truncated]`。扫描达到 5000 个文件时追加 `[scan truncated at 5000 files]`；单行超过 1 MiB 时跳过并追加 `[skipped N lines longer than 1 MiB]`。
- 两者都只遍历工具根内：跳过 `.git`、`node_modules`、`.harness`、`dist`、`coverage`、`build`、`out`、`target`、`.pio`、`cmake-build-*`；遍历中遇到的 symlink 文件 / 目录都不跟随（显式 `path` 根为 symlink 时仍会跟随，D-079）。
- `grep` 只读 ≤2 MiB 的文件，含 NUL 视为二进制；跳过项分别计数并披露为 `[skipped N entries (X files, Y unreadable directories)]`，`detail.skipped` 区分 `binary` / `tooLarge` / `unreadableFiles` / `unreadableDirectories`，不列具体路径（D-084 仍跟踪路径披露）。
- 两者都响应 `AbortSignal`：`walkFiles` 在每个条目/递归前检查，`grep` 在文件读取前与每 256 行检查，取消返回 `aborted`。`grep` 先收集全部命中再截断，命中集很大时内存占用随结果增长（D-078）；`grep` 正则同步执行，ReDoS 不可中断（D-085），glob 编译仍有回溯风险（D-086）。

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

## 权限与审批

权限层在工具执行前判定 `allow` / `ask` / `deny`，默认预设为 `diagnose`。判定只决定是否调用工具；`allow` 后仍会经过 `shell` 危险命令黑名单与 `fs` 路径边界检查。权限规则是声明式匹配而非沙箱（D-114）。

**配置路径与 trust 语义**

- 用户级：`$HARNESS_HOME/permissions.json`（默认 `~/.harness/permissions.json`），默认加载。
- 项目级：`<工具根>/.harness/permissions.json`，**默认不加载**；只有 `permissions.trustProjectConfig === true` 或显式提供 `permissions.projectConfigPath` 才读取（显式路径即视为信任）。文件存在但未信任时写 `status: permissions_project_config_skipped`，`message` 为路径。
- 与 `mcp.trustProjectConfig` **相互独立**：信任项目 MCP 配置不会放宽权限。
- 合并：`preset` / `approvalTimeoutMs` 取 inline → project → user → 默认（`diagnose` / 120000）；规则按 inline → project → user → 内置预设规则拼接。任一匹配规则为 `deny` 即拒绝，其次 `ask`，最后 `allow`；同优先级取最靠前一条（`source` + 全局 `ruleIndex`）。
- 配置错误（JSON / schema / 版本 / 未知字段 / 非法谓词）抛 `PermissionConfigError`，`runSession` 启动失败（demo 退出码 2），不会忽略后继续。

| 预设 | 只读 | 写 | 未知 |
|---|---|---|---|
| `read-only` | allow | deny | deny |
| `workspace-write` | allow | ask（`fs` 的 `write`/`edit` 内置 allow） | deny |
| `diagnose`（默认） | allow | ask | deny |
| `danger-full-access` | allow | allow | allow |

规则 `tool` 支持 `*`（任意串）与 `?`（单字符），整串大小写敏感匹配；`params` 为 AND，`key` 是点路径（如 `target.port`、`items.0`），每个 matcher 必须且只能提供 `eq` / `glob` / `in` / `range` 之一。`eq` 为 JSON 严格相等，`glob` 只匹配字符串，`in` 为非空数组，`range` 为闭区间且仅匹配有限 number。

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
      "tool": "mcp__serial__open",
      "params": [{ "key": "port", "glob": "COM?" }],
      "action": "allow"
    },
    {
      "tool": "mcp__serial__write",
      "params": [{ "key": "port", "in": ["COM3", "/dev/ttyUSB0"] }],
      "action": "ask"
    },
    {
      "tool": "fs",
      "params": [{ "key": "op", "eq": "write" }],
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
    rules: [{ tool: "fs", params: [{ key: "op", eq: "read" }], action: "allow" }],
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
- Web 工作台由服务进程注入审批桥，经 `POST /api/approvals` 回传决策，见「Web 会话与审批」；headless 仍是 `ask` → deny。

**审计事件**

进入权限判定的每次调用都先写 `permission_decision` 会话事件，之后才执行或返回拒绝。payload 含 `requestId`（本次审批的独立 UUID）、`callId`（与 `tool_result.id` 相同）、`tool`、`action`（规则原动作，`ask` 仍记 `ask`）、`effective`、`reason`、`preset`、`source`、可选 `ruleIndex`、`paramsDigest`（稳定序列化后 SHA-256 前 16 位）、`paramsKeys`（顶层键排序，最多 32 个，单键最多 100 码点）、可选 `paramsPreview`（字符串最多 120 码点，整体 4096 字节；超出预算时丢弃后续键并置 `previewTruncated: true`；可能含敏感片段，D-113）、`access`（`read` / `write` / `unknown`）。事件 `parent` 指向对应 assistant 事件，`tool_result` 在其后；`buildMessages` 与前端回放忽略该事件，不占模型上下文。旧日志的 `permission_decision` 可能没有 `requestId`，前端回放才回退按 `callId` 配对。

**MCP 参数边界**

MCP 工具参数 schema 为 `z.unknown()`，不会应用 server `inputSchema` 的默认值或类型转换。参数规则只匹配模型**实际提交**的参数；需要按默认值判定时，必须在提示或规则中要求模型显式提供（D-117）。

**权限演示**

离线（不触网）：

```bash
npm test -- tests/permissions-integration.test.ts
```

覆盖 diagnose 拒绝 `fs` 写、`danger-full-access` 放行，以及项目配置未 trust 时跳过。

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

evidence 保护：`ToolResultPayload.evidence === true` 的结果不会被二级/三级修剪；投影层会拒绝覆盖 evidence 的 summary（回退上一条有效 summary 或原视图）。MCP 工具可在注册时通过 `_meta: { evidence: true }` 声明证据工具；适配层将其映射为 `annotations.evidence`，与内置工具走同一保护路径。旧日志中没有 `evidence` 字段的 `tool_result` 按非 evidence 处理（P0 未发布，不做迁移）。摘要请求的 usage 作为独立 `usage` 事件落日志（cached 字段经 `normalizeUsage` 归一化），`query` 在压缩后按会话累计 usage 重算 `costUsd`，因此计入 `maxCostUsd` 熔断。

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
| 1 | 熔断（`maxTurns` / `maxCostUsd`） |
| 130 | 取消（SIGINT/SIGTERM） |
| 2 | 用法或装配错误（含运行期未恢复错误：模型 4xx/网络/响应非法/会话写入失败） |

会话写入 `$HARNESS_HOME/sessions/<id>/`：`header.json`、`session.v1.jsonl`、按需生成 `session.vN.jsonl` 与 `artifacts/`。

## Web 工作台

工作台没有演示数据：页面启动后从本地服务的 `/api/*` 读取真实会话、知识库与设备状态。

```bash
npm run build       # 内核产物 dist/server/serve.js
npm run build:web   # 前端产物 dist-web/
npm run serve:ui    # 真实数据服务，默认 http://127.0.0.1:5174/
```

- **环境变量**：`HARNESS_UI_PORT` 改监听端口（默认 `5174`）；`HARNESS_HOME` 指定会话与知识库根目录（默认 `~/.harness`）；`HARNESS_UI_STATIC` 指定前端静态产物目录（默认 `dist-web`）；`HARNESS_WEB_MODEL` 指定 Web 会话默认模型引用；`VITE_EVENT_STREAM_URL` 覆盖事件流地址（默认 `/api/events`）。服务只监听 `127.0.0.1`。
- **本机边界**：`/api/*` 校验 `Host` / `Origin` 必须为 `127.0.0.1` / `localhost` / `::1` 且端口等于监听端口；跨源返回 403 `forbidden_host` / `forbidden_origin`，用于阻断 DNS rebinding 与跨源读取（D-067 已解决）。写端点额外拒绝浏览器自动发送的 `Sec-Fetch-Site: cross-site`（403 `forbidden_origin`），覆盖另一个 loopback 页面经 dev 代理发起的跨源写请求；非浏览器客户端不发送该头，仍以 `Origin` 为准（D-146）。
- **架构**：Preact 只承担组件化与增量 diff；全部业务状态经 `src/ui/view/transcript.ts` 的纯函数投影 `TranscriptView`。前端类型直接复用内核 `SessionEvent` / `LoopEvent` / `ToolResultPayload` / `ToolAnnotations`，不维护第二套事件模型。
- **数据加载**：首屏并行请求 `/api/sessions`、`/api/kb`、`/api/device`，再按会话列表首项请求 `/api/sessions/<id>` 的真实事件日志；切换会话重新拉取。调试坞的寄存器与日志由工具卡投影，不再使用静态演示数据。
- **API**：

  | 方法 | 路径 | 行为 |
  |---|---|---|
  | GET | `/api/sessions` | `{ sessions: [{ id, createdAt, status, model?, workdir? }], errors: [{ dir, code }] }`；坏会话目录进 `errors` 而不是中断列表，符号链接 / junction 目录记 `skipped_link` |
  | GET | `/api/sessions/:id` | `{ header, events }`；非法 id 400，不存在 404，损坏会话 500 `session_corrupt` |
  | GET | `/api/kb` | `{ root, tree }`；未配置 `kb/` 时返回 `{ root: null, tree: [] }` |
  | GET | `/api/device` | 当前恒为 `{ probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" }` |
  | POST | `/api/actions` | 发起会话或追加输入，202 `{ sessionId, created }`；错误码见「Web 会话与审批」 |
  | POST | `/api/approvals` | 回传审批决策，202/200；错误码见「Web 会话与审批」 |
  | GET | `/api/events` | SSE 单会话事件流，见「实时事件流」；非法 id/cursor 400，不存在 404，损坏 500 |

- **诚实边界**：写端点必须带 loopback `Origin`；提交失败在输入栏下方显示错误并保留输入。202 只表示受理/送达，工具是否执行以会话日志的 `permission_decision` 与 `tool_result` 为准，前端不伪造成功。`VITE_ACTION_URL` / `VITE_APPROVAL_URL` 可覆盖默认端点；实时事件流默认连接 `/api/events`。
- **空态**：无会话显示「暂无会话」，未配置 `$HARNESS_HOME/kb/` 显示「未配置知识库」；设备字段为 `unknown` 时 StatusBar 显示「—」，TopBar / DeviceMonitor / PortSettings 显示「未接入」。
- **主题**：`light` / `system` / `dark` 三态，`localStorage` 键 `eam-theme`，默认 `system`；切换不重载页面。所有颜色经 CSS 变量，图标为内联 SVG sprite。
- **验收**：`npm run verify:ui` 先要求 `dist-web/` 与 `dist/server/serve.js` 已构建，然后创建临时 `HARNESS_HOME`（写入一条真实会话日志与示例知识库目录），启动 `dist/server/serve.js`，用无头 Chromium 经 CDP 实测 V1-V14（三栏几何、无溢出/截断、滚动条配色与占位、三主题解析、无 emoji、焦点可见、减少动效、回放一致性、真实写操作确认文案）；另以空 `HARNESS_HOME` 起第二个服务检查空态文案（V0，附加项不计入 14 项）。结束后关闭服务并清理临时目录，清理失败仅 warning。浏览器探测优先 `CHROME_PATH`，其次 Chrome/Edge 常见安装路径；找不到时以 exit 2 明确失败。
- **安全边界**：写内存/复位需显式确认，确认后仅进入「执行中，等待工具结果」，不会在前端伪造「已执行」（R2）；工具失败显式展示错误码与文本（R3）。

## 实时事件流

Web 工作台通过 SSE 订阅单个会话的日志投影。实时流与回放共用同一份 `SessionEvent`，不维护第二套事件模型；所有实时事件必须先成功落会话日志再被投影。

- **端点**：`GET /api/events?sessionId=<id>&since=<seq>`。`sessionId` 必填（规则同 `isValidSessionId`）；`since` 为不小于 `-1` 的整数，缺省时读取 `Last-Event-ID`，两者都缺省按 `-1` 从头补播；query 优先于 header。`since` 大于会话当前最大 `seq` 时按该 `seq` 夹紧（等价于从尾部继续跟随），不报错。非法 id / cursor 返回 400（`invalid_session_id` / `invalid_cursor`），会话不存在 404 `session_not_found`，日志损坏 500 `session_corrupt`。
- **单会话绑定**：每条连接只跟随一个会话；切换会话必须关闭旧流，并以新会话的 `lastSeq` 重新建流。多会话复用与全局流未实现（D-133）。
- **帧格式**：普通事件为 `id: <seq>` + `data: <SessionEventEnvelope JSON>`；`retry: 3000`；每 15s 一条注释心跳 `: ping`；会话已关闭且补播完成后发 `event: stream_end`（`data: {"lastSeq":N}`）；异常发 `event: stream_error`（`data: {"code","lastSeq"}`）后关闭。
- **事件类型**：`approval_request`（参数摘要与截止时间，不含参数原文）、`tool_started`（`{callId,tool,access?}`）、`tool_result`、`permission_decision`、`mcp_status`、`device_status`，以及既有 `system/user/assistant/usage/checkpoint/status/interrupted/compaction`。`tool_call` 仅用于旧日志回放，新代码不再产生。`permission_decision` 中 `action=ask,effective=deny` 表示最终未获批准且工具未执行（原因可能是 `approval_unavailable` / `approval_denied` / `approval_timeout` / `approval_aborted`，需看 `reason`）；`mcp_status` 的 `kind` 覆盖 `connected/connect_failed/tools_changed/tools_refresh_failed/tool_invalid_schema/listener_failed/call_failed/config_failed/config_warning/project_config_skipped/tool_name_renamed`。
- **设备状态契约**：MCP 工具在**成功**结果（`isError !== true`）的 `structuredContent.deviceStatus` 返回普通 JSON 对象；序列化后 ≤ 8 KiB、深度 ≤ 4。内核校验后写 `device_status`，payload 为 `{callId, server, tool, state}`。`state` 的键与值完全由 MCP server 决定，内核与 UI 不解释、不补全、不推断；UI 只 patch 已知字符串字段 `probe/serial/cpu/backend`，未知键与非字符串值忽略。失败、权限拒绝、超时/取消不产生 `device_status`；`deviceStatus` 存在但解析失败（非普通对象、超限、访问器/循环等）时写 `status {status:"device_status_invalid", tool, message}` 显式审计；`structuredContent` 非对象或缺少 `deviceStatus` 键时静默跳过，不猜测状态。
- **断线续传**：客户端独占游标 `lastSeq`，重连以 `since=lastSeq` 建流并按 `seq` 去重；连续 3 次未成功建流后显示流错误（成功 `open` 后计数重置）。收到 `seq > lastSeq + 1` 视为缺口，关闭流并整量重拉会话（每次订阅最多 3 次），避免静默拼接错误；`stream_end` 停止重连，`stream_error` 按同一上限重连。
- **慢客户端**：服务端实时队列上限 500 条；实时阶段单帧写超时（默认同补播超时，30s）到期即视为慢客户端，或队列溢出时同样处理：发 `stream_error {code:"slow_consumer", lastSeq}` 并关闭连接，客户端凭游标重连续传。补播阶段每帧也有写超时，完全不读响应体的连接会被关闭；大日志 / 长断线补播的性能上限未压测（D-136）。
- **延迟与证据**：当前由 200ms 日志轮询跟随，实际延迟还受文件读取与事件循环调度影响，无硬上限，也未压测；进程内低延迟适配器未实现（D-134）。证据由 `tool_result.payload` 的 `evidence/artifactPath/detail` 承载，没有独立 `evidence` 事件（D-135）。
- **审批事件**：`approval_request` 由审批桥在等待前写入日志，再由 SSE 投影为待审批卡片；决策与执行结果见「Web 会话与审批」。

## Web 会话与审批

Web 进程内运行最小会话运行器：`POST /api/actions` 发起会话或追加输入，`ask` 工具产生 `approval_request`，浏览器经 `POST /api/approvals` 回传决策。

```bash
npm run build:web && npm run build && npm run serve:ui
# 打开 http://127.0.0.1:5174/
```

开发期用 `npm run dev:web`：Vite 把 `/api` 代理到 `HARNESS_UI_PORT`（默认 5174），并在 `proxyReq` 把 `Origin` 改写为 `http://127.0.0.1:<端口>`，以满足写端点的 Origin 要求；生产同源不需要改写。

**模型**

- 读取 `$HARNESS_HOME/providers.json`；模型引用按 `HARNESS_WEB_MODEL` → providers 中第一个 `<provider>/<model>` 的顺序回退（运行器显式 `model` 选项优先）。
- 追加输入时优先使用会话 `header.model`；`header` 无模型时与新建会话相同，回退到 `HARNESS_WEB_MODEL` 与 providers 第一个引用。
- providers 缺失、JSON/schema 错误或引用无效统一返回 503 `model_unavailable`，message 说明检查 `HARNESS_HOME/providers.json` 与 `HARNESS_WEB_MODEL`，且不包含本机绝对路径（home 路径脱敏为 `HARNESS_HOME`）；`session_unreadable` 只返回「会话不可读」。

**运行器语义**

- 同一会话同一时间只允许一次运行；运行期间再次提交返回 409 `session_busy`。
- 202 返回前会话 `header.json` 必须已落盘；默认 10s 内未就绪则 abort 并返回 503 `session_start_timeout`。
- 运行错误写入 stderr 并留在会话日志，不回传 HTTP 响应。

### POST /api/actions

请求：

```json
{ "text": "读取 0x20000000 的 4 字节", "sessionId": "可选" }
```

缺省 `sessionId` 新建会话；带 `sessionId` 时向该会话追加输入（使用 `header.model` 与 `header.workdir`）。

202 响应：

```json
{ "sessionId": "uuid", "created": true }
```

| 状态 | code | 条件 |
|---|---|---|
| 400 | `invalid_body` | 非 JSON 对象、缺 `text`、`text` 非字符串 |
| 400 | `invalid_text` | `text` 为空/纯空白、超过 8000 字符 |
| 400 | `invalid_session_id` | `sessionId` 非法 |
| 404 | `unknown_session` | 指定会话不存在 |
| 409 | `session_busy` | 同会话正在运行 |
| 500 | `session_corrupt` | 追加会话的 header 损坏 |
| 500 | `session_unreadable` | 追加会话的 header 不可读（EACCES/EPERM） |
| 503 | `model_unavailable` | providers 缺失/无效/引用无效 |
| 503 | `session_start_timeout` | 就绪超时（运行器已 abort） |
| 503 | `runner_unavailable` | 运行器已关闭或未注入 |

### POST /api/approvals

请求：

```json
{ "sessionId": "uuid", "requestId": "6f1c2b0e-...", "decision": "allow" }
```

`requestId` 是权限 gate 为每次审批生成的独立 UUID，与模型工具调用 `callId` 解耦：同一 `callId` 跨轮复用时两次审批的 `requestId` 不同，迟到决策不会命中更新的审批。

| 状态 | body | 条件 |
|---|---|---|
| 202 | `{ requestId, decision }` | 首次受理，决策已送达等待中的 gate |
| 200 | `{ requestId, decision, duplicate: true }` | 同决策重复提交 |
| 400 | `invalid_body` / `invalid_session_id` / `invalid_decision` | 字段缺失或类型错误、id 非法、`requestId` 不是 1..200 个可打印 ASCII 字符、决策不是 `allow`/`deny` |
| 404 | `unknown_session` / `unknown_request` | 会话不在运行器注册表 / 运行中但从未见过该 `requestId` |
| 408 | `request_timeout` | 读取请求体超过 5s（返回响应后丢弃剩余 body） |
| 409 | `already_decided` | 已用相反决策结束 |
| 410 | `approval_expired` | 已超时或中断，不可再决 |
| 503 | `runner_unavailable` | 运行器已关闭或未注入 |

**202 语义**：只表示决策已送达 gate，不表示工具已执行；最终结果以会话日志的 `permission_decision` 为准（批准为 `effective: "allow"` 且 reason 含 `approval_granted`，拒绝为 deny）。HTTP 不返回 `effective`，前端也不本地伪造终态，等待 SSE 更新。

**写端点通用约束**：`POST /api/actions` 与 `POST /api/approvals` 必须携带 `Origin`，且为 loopback、端口等于监听端口，否则 403 `forbidden_origin`；浏览器带 `Sec-Fetch-Site: cross-site` 时同样 403（即使 Origin 是另一个 loopback 页面），非浏览器客户端仍以 `Origin` 为准。`Content-Type` 必须为 `application/json` 或 `application/json;` 前缀（接受 `charset` 等参数，415），body 上限 64 KiB（413），读取超时 5s（408 `request_timeout`）。超时只返回 408，不销毁连接；handler 丢弃剩余 body。`text` 仍保留 8000 字符上限；64 KiB 足以覆盖其最坏 JSON 转义（约 48 KiB）。只读端点仍只校验 `Host` / `Origin`。

**前端发送语义**：追加输入成功后只刷新会话列表，保持当前视图与 SSE 连接，不重载会话；只有新建会话（提交前没有 `activeSessionId`）才按返回的 `sessionId` 切换并订阅。

**失败语义**：审批超时（`approvalTimeoutMs`，默认 120000ms）、用户拒绝、会话中断均不执行工具，日志以 `permission_decision` deny 收尾；迟到决策在运行中返回 410，会话结束后返回 404。服务重启后未决审批丢失，`resumeSession` 会补 `approval_aborted: crash_recovery` 审计（按 `requestId` 配对，同 `callId` 的已决审批不会重复补写）。`query` 启动前的失败会写 `interrupted`（`reason: "start_failed"`）。headless demo 与未注入审批桥的库调用仍是 `ask` → deny（`approval_unavailable`）。

**演示**：启动后在输入栏发送需要 `ask` 的指令（默认 `diagnose` 下让 `shell` 执行无害命令，或让 `fs` 写临时文件），页面出现审批卡片；批准后工具执行，拒绝后不执行。过程记录见 `dev-notes/M2-Web审批.md`。

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

- 超时/取消会终止 transport、轮询 PID 确认退出后再允许重连；终止未确认时返回 `mcp_uncertain` 并拒绝重连。内置 `fs`/`glob`/`grep`/`shell` 均已响应 signal；剩余风险仅限自定义/第三方 in-process 工具故意忽略 signal（D-022 已缓解，D-071/D-077 已解决）。
- 默认 env 白名单可通过 `inheritEnv: true` 或 `envAllowlist` 放宽；放开后第三方 server 可读取相应父进程变量（D-102 已解决，配置方需知悉）。
- 配置未知字段（含 typo）静默忽略（D-103）；刷新失败保留旧缓存且不自动重试（D-104）。
- 工具名消歧依赖 server 返回顺序，跨会话稳定性未保证（D-100）；会话结束与 list_changed 重叠时可能丢失最后一条 status 审计（D-101）。
- 仅支持 stdio；未启用 2026-07-28 协议的 `subscriptions/listen`。

前端工作台：

- SSE 实时事件流已实现（单会话、`since`/`Last-Event-ID` 续传）；写操作与审批已落地，见「Web 会话与审批」（D-137/D-139 已解决；D-051 的 action 契约已收敛为 `text` + 可选 `sessionId`）。
- 实时总线只做日志投影：延迟约 200-250ms，无进程内低延迟适配器（D-134）；只支持单会话流（D-133）。
- 设备面板只消费 MCP 显式发布的 `device_status`，无该事件时 `/api/device` 仍恒为 `unknown`，缺少显式连接状态枚举（D-052、D-058）。
- 回放/导出按钮已渲染但未接行为（D-059）。
- 会话列表的坏目录进 `errors`，界面在会话面板底部显示「N 个会话目录不可读」（D-065 已解决）。
- 知识库扫描深度上限 8、条目上限 2000，超出会静默截断（D-064）。
- 717px 工作区下知识库整树需内部滚动（D-054）；V3/V11 的验收口径边界见 D-055、D-056。
- Chromium 非标准安装需设置 `CHROME_PATH`（D-057）。

## 设计文档

- `docs/BRD.md` — 业务需求与路线图
- `docs/p0-kernel-design.md` — P0 内核设计
- `docs/frontend-design.md` — 前端设计规范（布局、令牌、组件、验收）
- `docs/superpowers/specs/2026-10-16-p0-kernel-dims-1-2-design.md` — 维度 1+2 可实现设计
- `docs/superpowers/plans/2026-10-16-p0-kernel-dims-1-2.md` — 实现计划
- `docs/superpowers/specs/2026-10-18-ui-workbench-design.md` — 前端工程实现设计
- `docs/superpowers/plans/2026-10-18-ui-workbench.md` — 前端实现计划
- `docs/deferred-issues.md` — 已知问题与升级条件
