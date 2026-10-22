# Keil / UVSOCK MCP server

把 Keil MDK 的无头调试与工程编辑能力，以独立 stdio MCP server 的形式挂到内核上。领域代码全部在本目录，`src/` 与 `desktop/` 零改动。

移植自 A 仓库（Prometheus）的 `src/embedded/`，规格书见工作区根目录的 `keil-porting-spec.md`。

## 工具

| 工具 | action | 说明 |
|---|---:|---|
| `keil_debug` | 57 | 会话进入/退出、运行控制、断点、寄存器、变量、栈、内存、反汇编、烧录与整片擦除、构建、能力报告 |
| `keil_project` | 14 | 工程结构（targets/groups/files）、增删组与文件、编译选项、切换 target、输出名 |

两次调用之间会话保持打开；`close` / `close_project` 结束会话。**工程编辑（`add_group` / `add_file` / `set_option` 等）在 uVision 退出时才写回 `.uvprojx`**——这是 uVision 的行为，不是本服务的缓冲，所以看到 `SUCCESS` 不代表文件已变。

**烧录会自动让出探针**：`flash` 跑在 plain 会话上，执行前会先关闭同工程的调试会话（否则两个 uVision 抢同一个 ST-Link，下载报 `Target DLL has been cancelled`），下载完成后回读校验。调试状态（断点、运行位置）会因此丢失，需要重新 `open`。

每个破坏性动作在执行前都带 `declaration`（operation / effect / address? / length?）。取证类动作（寄存器、变量、内存、栈等）在 `structuredContent.evidence === true`，参与上下文压缩保护。

## 构建

```bash
npm run build:mcp   # 输出到 dist-mcp/keil/server.js
```

本服务不执行任何依赖安装命令。

## 接线

`$HARNESS_HOME/mcp.json`（用户级）或 `<workdir>/.harness/mcp.json`（项目级）：

```json
{
  "mcpServers": {
    "keil": {
      "command": "node",
      "args": ["<repo>/dist-mcp/keil/server.js"],
      "timeoutMs": 120000
    }
  }
}
```

工具名在内核里是 `mcp__keil__keil_debug` / `mcp__keil__keil_project`。

服务级选中项可以通过环境变量下发（优先级低于显式参数）：

```json
{ "env": { "KEIL_SELECTION_JSON": "{\"project\":\"D:/proj/USER/APP.uvprojx\",\"backend\":\"simulator\",\"port\":4825}" } }
```

## 权限

`permissions.example.json` 是 `diagnose` 预设下的三组规则（取证读数 allow、运行控制/烧录/擦除/构建 ask、参数写入 ask、工程编辑 ask）。模板**不会自动加载**，复制到 `.harness/permissions.json` 或内联到 `permissions.rules` 后生效。

headless（无审批器）时 `ask` 降级为拒绝，工具不会执行。

## 测试

```bash
npm run test:mcp
npx vitest run mcp-servers/keil
```

- `uvsock-protocol.test.ts`：75 例报文与解析测试（framing、回复匹配、GBK、枚举流、寄存器、变量、栈、内存、菜单、trnOpt、构建命令、工程识别）
- `keil-project-file.test.ts`：13 例，含内置脱敏 fixture（BOM + GBK，中英文混合路径）
- `keil-selection.test.ts`：8 例选择项优先级与 `KEIL_SELECTION_JSON`
- `tools.test.ts`：action 枚举、写前声明覆盖、evidence 集合、权限模板一致性
- `bootstrap.test.ts`：领域代码不进 `src/` 的红线

## 已知限制

1. **整片擦除不走 UVSOCK**：`PRJ_FLASH_ERASE` 在 MDK 5.43a 上无响应，`erase` 改用 STM32_Programmer_CLI（需本机安装 STM32CubeProgrammer）。未安装时返回明确原因，不伪装成功。
2. **构建诊断只回传日志原文**：A 侧的编译诊断解析（`diagnostics.ts`）未迁移，`build` 失败时给出 UV4 日志与退出码，不做「文件:行号」结构化。
3. **只移植了 Keil 生态**：Zephyr / ESP-IDF / PlatformIO / Arduino / Cargo / CMake / Make 的工程识别与构建分支未迁移。
4. **UVSOCK 是未公开协议**：偏移与状态码来自 MDK 5.43a 的实测报文，`UNSUPPORTED_ON_MDK_5_43` 表记录了 14 条不可用操作及其原因；换 MDK 版本需要重新验证。

细节见 `docs/keil-headless.md`，限制登记见 `docs/deferred-issues.md`。