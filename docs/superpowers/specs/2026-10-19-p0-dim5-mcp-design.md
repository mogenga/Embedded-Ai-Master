# P0 维度 5 可实现设计(MCP 客户端)

> 日期: 2026-10-19 · 状态: 草稿待评审 · 上游: [p0-kernel-design.md](../../p0-kernel-design.md) §5, [BRD.md](../../BRD.md) PLAT-4/PLAT-5。
> 本轮交付终点: MCP stdio 客户端、会话级生命周期、user/project 配置、命名空间工具、失败隔离与 list_changed 刷新; 单测+集成测试; 每个 Task 完成后两轮独立 review; 合并 `feat/p0`, 不合并 `main`。

## 1. 意图与为什么

嵌入式取证全部经 MCP(串口、探针、KB), 内核不得含领域逻辑。维度 5 把 MCP server 挂到现有工具系统: 连接、发现工具、命名空间注册、调用/结果映射、断线重连、工具列表变更。这是"领域能力外置"的物理入口。

MCP SDK v2 已用 Context7 查证(2026-10-19):

- 运行时依赖 `@modelcontextprotocol/client` ^2.3.1; `StdioClientTransport` 从 `@modelcontextprotocol/client/stdio` 导入。
- `new Client({name,version})` → `client.connect(transport)` → `client.listTools()` → `client.callTool({name,arguments}, {timeout?})`。
- list_changed 用 `new Client(info, { listChanged: { tools: { autoRefresh:false, debounceMs, onChanged } } })`。`onChanged(error, items)` 在 `autoRefresh:false` 时 `items` 为 `null`，由调用方自行刷新。`client.listen(filter)` 是 2026-07-28 的 `subscriptions/listen`；SDK 默认 legacy 握手协商 2025-11-25，调用会抛 `MethodNotSupportedByProtocolVersion`；SDK 可通过 `versionNegotiation` pin 2026-07-28，但 P0 不启用，故不使用 `listen`。
- 测试 server 用 `@modelcontextprotocol/server`(devDependency) + `@modelcontextprotocol/server/stdio`; `McpServer.registerTool(name,{description,inputSchema},handler)`。
- 工具注解 `annotations.readOnlyHint/destructiveHint`。

## 2. 目标 / 非目标 / 反目标

### 目标

1. 配置: `$HARNESS_HOME/mcp.json`(user) 与 `<workdir>/.harness/mcp.json`(project), project 覆盖同名 server; `disabled:true` 跳过。
2. 会话级 `McpManager`: `connectAll()` 并行连接, 单 server 失败不阻塞其他; 连接超时 15s; `close()` 断开全部。
3. 工具注册: `mcp__<server>__<tool>` 命名空间, 名称 sanitize 与 64 字符限制; 名称冲突基于原 identity 确定性追加 `_<hash6>` 改名并记 `mcp_tool_name_renamed`; annotations 映射。
4. 调用: `callTool` 透传参数; text content 拼接; 非 text content JSON 化; `isError` 映射; 超时/取消映射。
5. 断线恢复: 连接类失败重连一次并重试; 仍失败返回 `mcp_unavailable`, 记录 status。
6. list_changed: 监听并刷新工具集合; 新工具进入后续请求, 移除工具不再调用; 记录 status。
7. 会话日志: 连接/失败/工具变更写 `status` 事件; 工具结果走现有 `tool_result`。
8. `runSession` 装配: 默认启用 MCP(无配置则跳过); `RunOptions.mcp?: {enabled?, userConfigPath?, projectConfigPath?}`; close 在 finally。

### 非目标

- HTTP/SSE transport、OAuth、sampling、elicitation、resources/prompts(P1)。
- 实现 MCP server(测试用 SDK server 包)。
- 权限/审批(MCP 工具默认按现有管线; P1)。
- 工具级并发/隔离(单会话共享 client; 调用串行由管线保证)。
- 跨会话连接池/守护进程。

### 反目标

- 把 MCP server 命令/配置暴露给模型决定。
- 连接失败静默当作“无工具”而不记录。
- 工具名冲突时静默覆盖。
- 断线后无限重连/重试。
- 修改/删除其他 server 的工具。

## 3. 约束

- TypeScript + Node 24 ESM-only, strict, 相对导入 `.js`; 不新增除 MCP SDK 外的依赖。
- **依赖由用户手动安装**: `npm install @modelcontextprotocol/client`; `npm install -D @modelcontextprotocol/server`。agent 不执行安装。
- 配置命令来自用户文件; 不拼接模型输入到 command/args/env。
- 工具名 `^[a-zA-Z0-9_-]{1,64}$`; 超长截断并加短 hash。
- 连接/调用错误结构化; 不抛裸异常; 单 server 失败不阻塞其他 server。
- 每个 Task 完成后两轮独立 review: 第一轮实现审查→修复; 第二轮独立复核/红队→通过才进入下一 Task。
- 不合并 `main`; 提交规范 `feat(mcp): ...`。

## 4. 接口与行为

### 4.1 配置

```ts
// src/mcp/config.ts
interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;   // 默认 15_000
  disabled?: boolean;
}
interface McpConfigFile { mcpServers: Record<string, Omit<McpServerConfig, "name">>; }

loadMcpConfig(opts: { home: string; workdir: string; userConfigPath?: string; projectConfigPath?: string }): McpServerConfig[];
```

- user 路径缺省 `$HARNESS_HOME/mcp.json`; project 路径缺省 `<workdir>/.harness/mcp.json`。
- 文件缺失 → 空数组(不报错); 文件存在但 JSON/schema 非法 → `McpConfigError`。
- 合并: **字段级合并**; 同名 server `{...user, ...project, env: {...user.env, ...project.env}}`; project 只写 `{disabled:true}` 时继承 user 的 command/args; 最终 `disabled:true` 跳过。
- 未知字段宽松忽略(兼容 `type`/`description` 等); 必填 `command` 严格校验; 名称 `^[a-zA-Z0-9_-]{1,64}$`。
- 校验: command 非空字符串; args 字符串数组; env 字符串 map; cwd 可选; timeoutMs 正整数(默认 15_000)。
- `env`: 启动时合并 `{...process.env, ...config.env}`(PATH/HOME 必需); 敏感环境变量暴露给第三方 server 的风险登记 deferred。
- `cwd`: 相对**配置文件所在目录**解析; 未指定时用 `workdir`。

### 4.2 `McpManager`

```ts
// src/mcp/manager.ts
interface McpToolInfo {
  server: string; tool: string; description: string;
  inputSchema: unknown;
  readOnly?: boolean; destructive?: boolean;
}
class McpManager {
  constructor(servers: McpServerConfig[], opts?: { connectTimeoutMs?: number; logger?: (e: McpStatusEvent) => void });
  connectAll(): Promise<void>;                 // 并行; 单失败不抛
  tools(): McpToolInfo[];                      // 当前可用工具
  call(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  onToolsChanged(listener: (server: string) => void): void;
  close(): Promise<void>;
}
interface McpCallResult { isError: boolean; code: string; message: string; detail?: unknown; text: string; }
interface McpStatusEvent {
  kind: "connected" | "connect_failed" | "tools_changed" | "tools_refresh_failed" | "listener_failed" | "call_failed";
  server: string; toolCount?: number; message?: string;
}
```

- `connectAll`: 每个 server `new Client(...)` + `StdioClientTransport({command,args,env,cwd})`; `Promise.allSettled`; 失败记录 status 并继续; 成功 `listTools()` 缓存。
- **per-server 串行队列**: 同一 server 的所有 `call` 串行执行(即使 `readOnlyHint:true`), 避免探针/串口类工具被管线并发; 不同 server 可并行。该保证**只覆盖已返回的调用**: timeout/abort 经 `Promise.race` 提前返回后, 底层 `callTool` 可能仍在执行, 队列不会等待它, 后续调用可能与之重叠; 写工具接入前必须引入可等待的终止/隔离机制(见 deferred D-022)。
- `call`: 查找 server/tool; 脱线或调用抛连接类错误 → `reconnect(server)` 一次 → 重试一次; 仍失败 `{isError:true, code:"mcp_unavailable"}`; `callTool` timeout 用 `min(server.timeoutMs, 120000)`; `signal` abort → `mcp_aborted`。
- **超时/取消语义**: SDK 只提供 timeout, 无 signal 中止保证; P0 用 `Promise.race` 停止等待并返回 `mcp_timeout`/`mcp_aborted`, **不强制 close 连接**(避免影响同 server 其他调用); 写工具取消后 server 可能继续执行, 且不再保证与后续调用的串行性, 登记 deferred D-022(P1 审批/隔离)。
- 外层 pipeline 的 120s 与 server timeout 竞争时, 可能先返回 `tool_timeout`; manager 层测试断言 `mcp_timeout`, 集成层允许 `tool_timeout`。
- `isError` 结果: `{isError:true, code:"mcp_tool_error", message, detail:{content}, text}`。
- list_changed: `ClientOptions.listChanged.tools.onChanged`(配置 `autoRefresh:false`、`debounceMs:0`)，在回调中把刷新任务投递到该 server 的串行队列; 刷新成功触发 `tools_changed` 与 `onToolsChanged`; 失败保留旧缓存并记 `tools_refresh_failed`。
- **listener 隔离**: `onToolsChanged` 逐个调用并 `try/catch`; 单个 listener 抛错记 `listener_failed`，继续调用其他 listener，不得让异常逃逸为未处理 rejection。
- **重连后刷新**: 重连成功刷新工具集后触发 `tools_changed` 与 `onToolsChanged`(首次 `connectAll` 成功不触发，由调用方在连接后读取 `tools()`; 首连失败后经 `call` 恢复成功视为重连，触发通知); 保证 registry 与 `manager.tools()` 一致。
- **close 竞态**: `close()` 后在途 `connect`/`loadTools` 不得再把状态置为 connected，也不得 emit `connected`/`connect_failed`; 在途 refresh 不得写回 `state.tools`，也不得 emit `tools_refresh_failed`; 已关闭时立即 dispose 并返回失败。
- **刷新失败**: `listTools()` 抛错时保留旧工具缓存并记录 `tools_refresh_failed`; 不立即清空(避免抖动误伤)。
- **工具缓存生命周期**: 重连前的临时 dispose 不清空旧工具缓存(重连失败仍保留); 只有最终 `close()` 清空。
- `close`: 对每个 client `close()`; 清除定时器/监听; 清空工具缓存。

### 4.3 工具适配

```ts
// src/mcp/tools.ts
function createMcpTools(manager: McpManager): ToolDef<unknown>[];
function mcpToolName(server: string, tool: string): string; // mcp__<sanitized server>__<sanitized tool>
```

- schema 用 `z.unknown()`(MCP server 校验; 管线仅透传); `ToolDef` 增加可选 `modelSchema?: unknown`, `toModelToolSchemas` 优先使用它透传 MCP server 的真实 `inputSchema`(否则 `z.toJSONSchema` 对 `z.unknown()` 根类型不是 object 会抛错)。
- `annotations: { readOnly: info.readOnly === true, destructive: info.destructive === true, evidence: info.evidence === true }`。
- execute: `manager.call(server, tool, input, signal)` → `ToolResult`。
- 名称冲突: sanitize/64 截断后若与已占用名冲突, 基于未 sanitize 的 `mcp__<server>__<tool>` 追加 `_<hash6>` **确定性消歧**, 不丢弃工具、不阻塞会话/其他 server; 每发生一次改名通过 `onStatus` 记录 `mcp_tool_name_renamed`(含 `originalName` 与最终 `name`)。同一 identity 再次冲突时追加 `#<attempt>` 重算, 循环保证 ≤64 且全局唯一。
- 消歧顺序边界: 改名占用可能使后续工具的基础名再次冲突并连锁改名; 结果仍全局唯一, 且对同一 `tools()` 输入列表确定, 但依赖 server 返回顺序(见 D-100)。
- 名称占用预置: `createMcpTools(manager, { reservedNames })` 先占位内置工具名, 避免未来内置工具使用 `mcp__` 前缀时与 MCP 工具冲突。
- inputSchema 根非 object: manager 的 `loadTools` 与 `createMcpTools` 双重防御, 跳过该工具并通过 `onStatus` 记 `mcp_tool_invalid_schema`(含 server/tool), 保证 registry 不因单个坏工具整体重建失败。MCP client 自身会先做 `inputSchema.type === "object"` 校验, 因此真实链路通常落到 `tools_refresh_failed` 并保留旧缓存。
- 超长名称: sanitize 后截断到 64 并追加 6 位 hash。

### 4.4 `runSession` 装配

- `RunOptions.mcp?: { enabled?: boolean; userConfigPath?: string; projectConfigPath?: string }`; 默认 `enabled:true`; `enabled` 非布尔抛 `TypeError`。
- 启动: `loadMcpConfig` + `new McpManager` + `connectAll()`; 工具 = `[...createBuiltinTools(), ...createMcpTools(manager, { reservedNames: 内置工具名 })]`。
- status 事件: `session.append({type:"status", payload:{status:"mcp_connected"|"mcp_connect_failed"|"mcp_tools_changed"|"mcp_tools_refresh_failed"|"mcp_tool_invalid_schema"|"mcp_tool_name_renamed"|"mcp_config_failed", server?, tool?, name?, originalName?, scope?, toolCount?, message?}})`。
- 同一 `server/tool/name` 的 `mcp_tool_name_renamed` 与同一 `server/tool` 的 `mcp_tool_invalid_schema` 在会话内只记一次, 避免每次 list_changed 重建产生重复审计噪声。
- list_changed 时刷新 registry: `ToolRegistry.replace(tools)` 全量重建, 只替换 MCP 命名空间工具, 保留内置工具; 刷新失败保留旧集合并记 `mcp_tools_refresh_failed`; registry 整体重建失败(无法归因单个 server)带 `scope:"global"`。
- close: finally 中 `await manager.close()`; 不覆盖主错误。
- 无配置/全部 disabled → 不连接, 不写 status。

### 4.5 错误码与 status

- `McpCallResult.code`: `ok`、`mcp_unavailable`、`mcp_tool_error`、`mcp_timeout`、`mcp_aborted`。
- 配置错误(Task1): `mcp_config_invalid`(`McpConfigError`)。
- status 事件 kind(manager 层): `connected`、`connect_failed`、`tools_changed`、`tools_refresh_failed`、`tool_invalid_schema`、`listener_failed`、`call_failed`。
- runSession 落会话日志的 status 子集: `mcp_connected`、`mcp_connect_failed`、`mcp_tools_changed`、`mcp_tools_refresh_failed`、`mcp_tool_invalid_schema`、`mcp_tool_name_renamed`、`mcp_config_failed`; 配置错误隔离为 status, 不冒泡、不阻塞主会话。
- 连接失败/刷新失败通过 status 表达，不进入 `McpCallResult.code`; 调用侧连接失败统一 `mcp_unavailable`。不再使用 `mcp_connect_failed`、`mcp_reconnect_failed`、`mcp_tools_refresh_failed` 作为 code。
- 登记 deferred: 超时/取消不强制终止 server 端执行(写工具 P1)、敏感 env 暴露、未知字段宽松可能掩盖 typo。

## 5. 测试策略

- config: user/project 合并、project 覆盖、disabled、缺失文件、坏 JSON/schema、名称校验。
- manager: 用 `@modelcontextprotocol/server` 启动真实 stdio echo server(测试脚本); connectAll 成功/单失败隔离/并行时序/连接超时回收子进程; listTools; call 成功/文本拼接/非 text/isError/timeout/abort; env 继承与 `config.env` 覆盖、cwd 透传; 断线重连一次且重连后触发 `onToolsChanged`; close 与 connect 并发不产生状态事件; listener 抛错不中断其他 listener/后续调用。
- tools: 命名/ sanitize/截断/冲突; annotations 映射; schema `z.unknown()`。
- runSession: 集成 MCP echo server, 请求 tools 含 `mcp__echo__echo`; 调用闭环; status 事件; enabled:false/无配置不启动; close 后子进程退出。
- list_changed: test server 动态注册工具 → client 刷新(成功/失败保留旧缓存); registry 更新。
- 覆盖率: 新增代码 line ≥90%。

## 6. 验收口径

1. 依赖安装后 `npm test` 全绿; coverage lines ≥85%; lint/typecheck/build 通过。
2. MCP echo server 的工具出现在模型请求中, 调用闭环。
3. 单 server 连接失败不阻塞其他; 断线一次重连; 工具名冲突不覆盖。
4. 连接/失败/工具变更可审计(status 事件); close 回收子进程。
5. 每个 Task 两轮 review 通过; dev-notes 增量留痕。

## 7. 留给实现的自由

- 连接超时/重试的具体退避(仅一次重连)。
- 非 text content 的 JSON 化格式。
- list_changed 刷新时 registry 的实现(replace/重建)。
- 测试 server 脚本的存放位置与启动方式。
- status 事件 payload 的附加字段。