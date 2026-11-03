# 右侧面板串口助手 — 调研报告与实现方案

日期：2026-10-23。目标：右侧工作台内嵌一个功能完善的串口助手，**人能看、agent 也能读**。

> **2026-11-03 状态说明（读本文前先看这条）**：本文是 **2026-10-23 一期的调研与决策记录**，其中「方案 B：PowerShell 数据泵、零 npm 依赖」是当时的选择，**已于 2026-10-24 被弃用**（`3530fac`）。现实现是**方案 A：宿主进程内直接用 `serialport` 13**（见 `desktop/host/serial-bridge.js` 文件头注释与 `dev-notes/M3-串口面板.md`）：PS 泵在实机上被杀软间歇击杀、UTF-8 分块乱码、二进制不安全、孤儿进程攥口四类问题击穿。文中描述的宿主命令集与「不共口、镜像 ring.json」的架构仍然成立，只有「后端是什么」这一层变了；agent 侧的 `embed_serial` 临时捕获仍用 PowerShell 泵（MCP server 进程不能引内核的原生依赖）。

## 一、现状盘点（全部实测）

### 渲染层：UI 是现成的，90% 不用写

`desktop/renderer/index.html` 的 `#serial-root` 段保留着完整串口面板 DOM：端口/波特率选择、Start、All/Warnings/Errors 过滤、暂停/清除/导出/Follow、状态行、输出窗。`app.js` 有 136 处 serial 引用，包括：

- 四个事件处理器已就位：`serial_snapshot` / `serial_state` / `serial_lines` / `serial_cleared`（app.js:2660-2695）
- 命令发送端已就位：`serialOpen{port,baud}` / `serialStatus` / `serialClear`（app.js:4566/4377/4583）
- 唯一缺的 tab 入口：`SUPPORTED_PANES = new Set(["board","file","files","artifact"])`（app.js:3704），加 `"serial"` 一项即可

### 宿主：一行都没有

`host.js` 的 `handlers`（30 个键）没有任何 serial 命令；MATRIX.md 明确记载隐藏原因：「serialOpen/serialStatus/serialRead 没有宿主实现」（D-166/D-169）。

### 内核：事件通路已通

`device_status` 的既有链路证明 MCP 工具结果可以直接变成前端事件：`mcp-servers/probe/tools.ts` 返回 `deviceStatus` → `src/tools/types.ts:17` 的 `ToolResult.deviceStatus` → `src/loop/query.ts:316` 写 `device_status` 事件 → 渲染层 `case "device_status"` 更新板卡面板。**串口数据流可以走同一机制**。

### 串口后端：probe 的两处都不适合

- `probe/openocd.ts:475`：serialOpen 直接 throw（串口不支持）
- `probe/renode-backend.ts:343`：TCP 虚拟串口（Renode 仿真用），不是真实 COM 口
- **没有任何地方实现真实 COM 口读写**。本机依赖调研：`desktop/node_modules` 无 serialport；pyOCD 0.45.1 在（Python，全局可用）

## 二、业界形态（调研结论）

| 工具 | 形态 | 对我们的启示 |
|---|---|---|
| [Arduino IDE 2](https://github.com/arduino/arduino-ide) | Theia 前后端服务，monitor 是后端服务的一部分，前端只是视图 | **串口服务放 host 层**，渲染层纯视图——与本项目"宿主持有能力、renderer 映射"的架构一致 |
| [VS Code Embedded Tools](https://github.com/microsoft/vscode-embedded-tools) | Serial Monitor 视图 + output channel + 自动重连；[Issue #164](https://github.com/microsoft/vscode-embedded-tools/issues/164) 在做 SerialMonitorService API 给程序化访问 | 提供**服务化 API** 而不仅是 UI——正是"agent 直接读取"的诉求 |
| [Cortex-Debug](https://cortex-debug.readthedocs.io/en/latest/) | SWO/ITM/semihosting → socket 桥 | 调试期日志的进阶路线（SWO），一期不做 |
| [AI-Arduino 扩展](https://www.hackster.io/news/rui-vitor-and-hugo-silva-s-visual-studio-code-ai-extension-for-arduino-5b0b6ec10d66) | agent 直接读 CLI 的串口流来自主调试 | agent 读取做成 **MCP 工具**，与面板共享同一后端 |

## 三、方案

### 数据通路（复用 kernel 既有机制，内核零改动或极小改动）

```
host.js（宿主进程）
  serial bridge（新模块 desktop/host/serial-bridge.js）
    ├─ 打开 COM 口（二选一，见下）
    ├─ 行分割/环形缓冲（渲染层 serial_lines 语义已定义好）
    └─ send({ type: "serial_lines"|"serial_state"|"serial_snapshot", ... })
renderer（零改动或只加 tab 入口）
  既有 case "serial_lines" 等处理器直接吃
agent（MCP）
  probe server 的 serial_* 工具升级 / 新 serial MCP server，
  与 host bridge 共享同一 COM 口句柄？→ 不共享：见"双通道"设计
```

### COM 口实现：两个选项

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. node-serialport**（`npm --prefix desktop install serialport`，用户执行） | 事件驱动、原生性能、端口枚举成熟 | 需要一次依赖安装（AGENTS 禁令：命令只能输出给用户）；native 模块要匹配 Electron ABI（`electron-rebuild` 或用 prebuilt） |
| **B. PowerShell .NET SerialPort 数据泵**（零依赖） | 本机实测可用（调试时反复用它开 COM7）；无 ABI 问题 | 子进程 JSON-over-stdio 泵要自己写；速率上限低（实测 ~KB/s 级够用）；Windows-only（本项目 Windows 一等公民，可接受） |

**当时的建议：一期 B（零依赖立即能用），二期补 A 作为可选加速。B 的实现是 ~150 行的 `serial-bridge.js`：spawn `powershell -NoProfile -Command <泵脚本>`，泵脚本用 .NET `SerialPort` 事件把收到的字节按行写 stdout（NDJSON），host 读 stdout → 环形缓冲（500 行）→ 推 `serial_lines`；发送则 host → stdin → 泵写串口。**

**事后结论（2026-10-24，`3530fac`）**：上面的顺序被反过来了——一期就换成了方案 A。B 在实机上被四类问题击穿：杀软间歇击杀 PS 子进程、UTF-8 多字节字符跨 read 边界被截断、二进制不安全、宿主死后孤儿泵攥住 COM 口（最后一条后来靠父 PID 看门狗缓解，但仍不足以救回这条路）。方案 A 的「native 模块要匹配 Electron ABI」在 `serialport` 13 的 prebuild 下没有成为问题（打包时打进 `app.asar.unpacked`）。

### "agent 直接读取"：双通道设计

关键决策：**agent 和面板共享数据，但不共享口**。COM 口独占，谁打开谁持有：

- **面板打开的口**：host bridge 持有；agent 经 `embed_serial`（新 MCP 工具，见下）读 bridge 的**环形缓冲副本**——不碰句柄。缓冲持续积累，agent 随时 `serial_read` 拿最近的 N 行（evidence 标记，进 tool_result 的 evidence 通道，`src/context/build.ts:106` 已有保护）。
- **agent 主动打开的口**（面板没开时）：MCP 工具自己开、自己读、报完即关，面板通过 `serial_state` 事件看到「agent 正在使用 COM7」。
- 冲突规则：两边同时要同一个口 → 后到者收到明确错误（"面板正在使用 COM7；读取面板缓冲请用 serial_read 不带 port 参数"）。

`embed_serial` 动作面（**最终落在独立的 `serial` server**，2026-10-25 从 cubeide 拆出：串口是平台级能力，绑在厂商后端上等于没装 CubeIDE 的机器就管不了串口）：

```
{ action: "read",  maxLines?: number, since?: number }  → 面板缓冲尾部（evidence）
{ action: "read",  port, baud, durationMs }             → 主动开一口读一段（evidence，destructive-open 声明）
{ action: "write", port, data }                          → 发送（destructive，声明）
{ action: "ports" }                                      → 枚举（PowerShell Get-CimInstance 或泵自报）
```

### 宿主命令面（补齐渲染层已在等的四个）

| 命令 | 行为 |
|---|---|
| `serialOpen {port, baud, encoding?}` | 开缓冲、回 `serial_snapshot` |
| `serialStatus {port?}` | 回 `serial_snapshot`（带 ring 尾部，否则切 tab 回来会清屏） |
| `serialClear {port?}` | 清缓冲、广播 `serial_cleared` |
| `serialClose` | 关全部打开的口、回 `serial_state` |
| `serialWrite {port?, data, hex?}` | 写串口；`hex` 走原始字节 |
| `serialLine {port?, line, value}` | **DTR/RTS** 手动控制（板子复位手势） |
| `serialBaud {port?, baud}` | 运行中改波特率，不断链路 |
| `serialEncoding {encoding}` | 运行中切换文本编码（utf-8 / gbk） |
| `listSerialPorts` | 渲染层 `fillSerialControls()` 的端口下拉需要它 |

> 上表是**最终实现**的命令集（2026-11-03 按 `desktop/host/host.js` 校正）；本文一期只规划了前六项，DTR/RTS、热切波特率与编码是后续轮次加的。

### 渲染层改动清单（极小）

1. `SUPPORTED_PANES` 加 `"serial"`，tab 条加常驻按钮（或从 board 面板的设备段跳转）
2. `fillSerialControls()` 接上 `listSerialPorts` 回填
3. i18n 键补齐（多数已存在）

### 内核改动

理论上零改动——`serial_lines` 等事件由 host 直接产生（同 notice 的路径），不进会话日志（串口流量不该进 transcript；agent 读取的部分作为 tool_result 自然落盘）。需要核对的一点：host `send()` 白名单是否限制事件类型，若有需加四个 serial 事件名。

## 四、工作量与顺序

1. `desktop/host/serial-bridge.js`（PowerShell 泵 + 环形缓冲 + NDJSON）~200 行
2. `host.js` handlers 补 6 个命令 ~120 行
3. `mcp-servers/cubeide/` 加 `embed_serial` 工具（read 缓冲/主动读/写/枚举 + 声明 + evidence）~250 行
4. 渲染层 tab 入口 + 端口下拉 ~40 行
5. 测试：bridge 泵的假进程注入测试（照 probe tests 模式）+ MCP 工具 schema 测试

一期不做：SWO/ITM（Cortex-Debug 路线）、hex 显示、时间戳过滤增强、多口同时监视。

## 五、风险

- **PowerShell 泵的 启动延迟**（~500ms）在"打开串口"操作里可接受；丢数据窗口从打开到泵就绪——泵脚本先开串口再发 ready 行，host 缓冲 ready 前的字节。
- **agent 读面板缓冲**的行数上限：环形缓冲 500 行 × 8KB 上限（照 device-status 的 8192B 限制模式），evidence 事件体积可控。
- **electron ABI**：一期不碰 native 模块，风险留给二期 A。
