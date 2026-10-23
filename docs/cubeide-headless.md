# CubeIDE 无头调试使用指南

本文面向第一次使用 CubeIDE 集成的人。能力来源是 STM32CubeIDE 自带的公开工具链（Eclipse headlessbuild、arm-none-eabi-gdb 的 GDB/MI、ST-LINK_gdbserver、STM32_Programmer_CLI），**不下载、不捆绑、不重分发任何 ST 组件**，用的就是你本机已安装的 CubeIDE。

与 [keil-headless.md](keil-headless.md) 是并列关系：同一个工程不可能同时是两种格式，但两台不同的机器可能只装了其中一种 IDE。

---

## 一、先确认本机有什么

| 需要 | 怎么确认 | 没有会怎样 |
|---|---|---|
| STM32CubeIDE（含 `stm32cubeidec.exe` 与 `plugins\`） | 默认装在 `C:\ST\STM32CubeIDE_<版本>\STM32CubeIDE`；装在别处（本机实测在 `G:\software\STM32CubeIDE_2.2.0`）时设环境变量 `CUBEIDE_HOME` 指向安装根 | 所有动作返回「STM32CubeIDE is not installed」 |
| Eclipse 工程（`.project` + `.cproject`） | 工程目录里有这一对文件 | 识别为「非 CubeIDE 工程」，诚实报错并列出目录线索 |
| ST-Link / J-Link 探针 | 插上即可；`probe` 动作可查询 | `flash` / `erase` / 调试连接失败，日志里能看到 |

设置 `CUBEIDE_HOME` 后**重启宿主**才生效（MCP server 是宿主启动时拉起的子进程）。

装好 CubeIDE 以下二进制必然存在（服务从 `plugins\` 里按插件目录名 glob，不写死版本号）：

- `arm-none-eabi-gdb.exe`（调试器，GDB/MI 协议）
- `ST-LINK_gdbserver.exe`（探针的 GDB 服务器）
- `STM32_Programmer_CLI.exe`（烧录 / 整片擦除）
- `openocd.exe` / JLink 套件（后续后端扩展用，当前接入未走）

---

## 二、两种接法

### 接法 A：统一路由门面（推荐）

模型只调 `embed_project`，由门面识别工程类型后自动分发：

- 目录里有 `.uvprojx` → 走 Keil 后端（`keil_debug` / `keil_project`）
- 目录里有 `.project` + `.cproject` → 走 CubeIDE 后端（`cubeide_debug` / `cubeide_build`)
- 两种都有 → 拒绝执行，列出全部，要求显式 `project` 参数
- 都没有 → 诚实报错，附目录里的构建系统线索（Makefile / CMakeLists 等）

先调一次 `{ "action": "identify" }` 可以只问「这是什么工程」而不执行任何东西。

接线：`embed_project` 同时挂在 keil 和 cubeide 两个 server 里，接哪个都能路由（推荐两个都接，见下）。

### 接法 B：直接调后端工具

`mcp__cubeide__cubeide_debug` / `mcp__cubeide__cubeide_build`（以及 keil 侧同名工具）。适合已经知道工程类型、想省一次识别的场景。

---

## 三、mcp.json

编辑 `$HARNESS_HOME/mcp.json`（Windows 通常是 `C:\Users\<你>\.harness\mcp.json`）：

```json
{
  "mcpServers": {
    "keil": {
      "command": "node",
      "args": ["G:/Develop/AImaster/Embedded-Ai-Master/dist-mcp/keil/server.js"],
      "timeoutMs": 120000
    },
    "cubeide": {
      "command": "node",
      "args": ["G:/Develop/AImaster/Embedded-Ai-Master/dist-mcp/cubeide/server.js"],
      "timeoutMs": 180000
    }
  }
}
```

路径用**绝对路径**，指向 `dist-mcp`（不是 `mcp-servers` 源码目录）。构建：仓库根目录 `npm run build:mcp`。

---

## 四、cubeide_build 动作面

```jsonc
{ "action": "info", "project": "D:/work/blink" }   // 工程概要（project 是目录！）
{ "action": "probe" }                              // 列探针（-l），不碰芯片
{ "action": "build", "project": "D:/work/blink" }             // 增量构建
{ "action": "rebuild", "project": "D:/work/blink", "config": "Debug" }  // 清了重编
{ "action": "flash", "project": "D:/work/blink", "image": "D:/work/blink/Debug/blink.elf" }  // 烧录+回读校验
{ "action": "erase", "project": "D:/work/blink" }  // **整片擦除**（-e all）
```

要点：

1. **`project` 是工程目录**（含 `.project` 的那个目录），不是 keil 侧的单文件路径。不传就从工作目录自动识别。
2. 构建走 Eclipse headlessbuild，每次用独立临时 workspace，构建完删除；`-printErrorMarkers` 会把错误标记打进日志。
3. `flash` / `erase` 会先**自动关闭打开的调试会话**（一个探针不能同时给 gdbserver 和 Programmer CLI 用）——断点会丢，烧完要重新 `open`。
4. **`erase` 在这里可用**（keil 侧因 UVSOCK 的 PRJ_FLASH_ERASE 无响应不可用，见 D-201/D-202）。整片擦除 = 芯片上全部内容丢失，声明会写明。

---

## 五、cubeide_debug 动作面

```jsonc
{ "action": "open", "project": "D:/work/blink" }   // 起 gdbserver + gdb，下载镜像
{ "action": "breakpoint_add", "location": "main" }
{ "action": "run" }
{ "action": "halt" }
{ "action": "registers" }                          // 全部核心寄存器
{ "action": "evaluate", "expression": "counter" }  // 读变量
{ "action": "read", "address": 536870912, "width": "u32", "count": 4 }  // 读内存
{ "action": "write", "address": 536870912, "value": 42 }  // 写内存（回读校验，声明先行）
{ "action": "stack" }
{ "action": "disassemble" }
{ "action": "status" }
{ "action": "close" }                              // 释放探针
```

要点：

1. `open` 默认会 `-target-download`（把镜像烧进去再调试，与 CubeIDE 的调试按钮语义一致）。传 `"load": false` 跳过下载。
2. 会话在工具调用之间保持——重开一个会复位目标、丢断点。
3. `run` 是"执行直到有事停下它"：没有断点的 run 会一直跑（这是成功，不是卡死）；要停用 `halt`。
4. 地址用十进制传（`0x20000000` = `536870912`）。
5. 写内存/寄存器/变量、断点增删、run/step/reset 都有写前声明；取证读数（registers/variables/read/stack 等）带 evidence 标记。
6. 没有仿真器：CubeIDE 不提供指令集仿真，`target` 参数不存在，调试永远走探针。

---

## 六、安全模型

与 keil 侧同一套（keil-porting-spec.md §7）：破坏性动作先声明、`ask` 在 headless 环境降级为拒绝、取证读数标 evidence 不被上下文压缩吞掉。动作白名单见 `mcp-servers/cubeide/actions.ts`。

---

## 七、故障排查

| 现象 | 先查什么 | 通常原因 |
|---|---|---|
| 「STM32CubeIDE is not installed」 | `CUBEIDE_HOME` 是否指向安装根（含 `stm32cubeidec.exe` 的那层） | 装在非默认路径且没设环境变量；设完没重启宿主 |
| 「no .project/.cproject」 | 工程目录对不对 | 传成了父目录或 `.uvprojx` 的路径 |
| gdbserver 起不来（port timeout） | 日志尾部会带上 gdbserver 的最后几行 | 探针被别的进程占用（ST-Link Utility、另一个 gdbserver、uVision）；先关掉 |
| `flash` 说 flash FAILED | 错误信息里带 CLI 日志尾部 | 读保护、芯片型号不匹配；`probe` 先看探针在不在 |
| gdb 连不上 target | gdbserver 是否真的在监听 | 上一个调试会话没 `close` |
| 构建失败只有日志尾部 | `-printErrorMarkers` 的输出在完整日志里 | 构建错误本身；日志尾部保留最后 12 行 |
| 中文路径乱码 | 工程目录 | Eclipse 工程建议纯 ASCII 路径 |

---

## 八、已知限制

1. J-Link gdbserver 路线未接入（插件里的二进制已定位，动作面只接了 ST-Link）。
2. openocd 路线未接入（同上；probe MCP 已有 openocd 后端，可先用那个）。
3. 工程编辑（加组/加文件/改编译选项）未实现——CubeIDE 的 `.cproject` 编辑比 keil 侧复杂，当前只有读（`info`）。需要改工程请用 CubeIDE IDE 本体。
4. 构建诊断只保留日志尾部，没做结构化「文件:行号」。
5. keil 与 cubeide 工程格式不互通：同一个实验工程只能按它本来的格式调试。

条目登记在 `docs/deferred-issues.md`（D-202 起）。
