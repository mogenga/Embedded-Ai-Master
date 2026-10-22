# Keil 无头调试使用指南

本文面向第一次使用 Keil 集成的人：从安装检查到「构建 → 烧录 → 下断点 → 读寄存器 → 收尾」的完整流程，以及出错时先看哪里。

能力来源是 Keil 官方 `UV4.exe` 与 uVision 的 UVSOCK 接口，**不下载、不捆绑、不重分发任何 Keil 组件**，用的就是你本机已授权的 MDK。

---

## 一、先确认本机有什么

| 需要 | 怎么确认 | 没有会怎样 |
|---|---|---|
| Keil MDK（含 `UV4.exe`） | 一般在 `C:\Keil_v5\UV4\UV4.exe`，也可能装在别处（本项目实测在 `G:\software\keil5`） | `keil_debug` 所有动作返回「Keil MDK is not installed」 |
| 可用的 MDK License | 打开 uVision 能正常编译/调试 | 构建或调试被 Keil 拒绝，日志里能看到 |
| 调试探针（ST-Link / J-Link / ULINK） | `.uvoptx` 里配置的适配器 | 进入调试时报连接失败 |
| STM32CubeProgrammer（仅整片擦除需要） | `STM32_Programmer_CLI.exe` 在 PATH 或 `Program Files\STMicroelectronics\STM32Cube\STM32CubeProgrammer\bin` | `erase` 返回明确原因，其他动作不受影响 |

找到 `UV4.exe` 后，`fromelf.exe` 会自动在同一安装根下查找（AC6 在 `ARM\ARMCLANG\bin`，AC5 在 `ARM\ARM_Compiler_*\bin`），不需要单独配置。

---

## 二、三步接上

1. **构建服务**（仓库根目录）：

   ```bash
   npm run build:mcp
   ```

   成功后在 `dist-mcp/keil/server.js` 生成入口。

2. **写配置**：编辑 `$HARNESS_HOME/mcp.json`（Windows 通常是 `C:\Users\<你>\.harness\mcp.json`）：

   ```json
   {
     "mcpServers": {
       "keil": {
         "command": "node",
         "args": ["G:/Develop/AImaster/Embedded-Ai-Master/dist-mcp/keil/server.js"],
         "timeoutMs": 120000
       }
     }
   }
   ```

   路径要用**绝对路径**，并且指向 `dist-mcp`（不是 `mcp-servers` 源码目录）。

3. **复制权限模板**（可选但推荐）：

   ```bash
   copy mcp-servers\keil\permissions.example.json .harness\permissions.json
   ```

   模板里取证读数直接放行、运行/烧录/擦除/写参数/改工程默认都要确认。不复制也能用，但所有动作都会走默认策略（一般是拒绝）。

重启宿主后，工具列表里应出现 `mcp__keil__keil_debug` 与 `mcp__keil__keil_project`。

---

## 三、第一次调用：先看能力，再开会话

```jsonc
// 1) 确认这个 MDK 版本支持哪些操作
{ "action": "capabilities" }

// 2) 查看当前有没有会话（不会连接目标）
{ "action": "sessions" }

// 3) 打开调试会话，默认连真机
{ "action": "open", "project": "D:/proj/USER/APP.uvprojx" }

// 4) 读一个寄存器（最轻的取证）
{ "action": "registers" }
```

`capabilities` 会列出 14 条不可用操作及其实测原因。看到某条被标为不支持，不要重试——那是 MDK 5.43a 的行为。

---

## 四、典型流程

### 构建

```jsonc
{ "action": "build", "target_name": "Release" }   // 编译（-b）
{ "action": "rebuild", "target_name": "Release" } // 重译（-r）
{ "action": "clean" }                             // 清理（-c）
```

`target_name` 是多 Target 工程的 Keil `<TargetName>`，**不是** `target`（后者只选真机/仿真器）。不传就用工程当前 target。

### 烧录与整片擦除

```jsonc
{ "action": "flash" }   // UV4 -f，烧完回读校验
{ "action": "erase" }   // 整片擦除，走 STM32_Programmer_CLI
```

**`flash` 会自动关闭同工程的调试会话**：下载跑在 plain 工程会话上，而一个 ST-Link 不能被两个 uVision 同时占用。服务会先结束调试会话、再启动下载，所以**断点与运行位置会丢失**，需要重新 `open`。`erase` 同样会先关闭所有会话。

`flash` 只擦除镜像自身占用的扇区（Keil 的行为），不是整片。要整片必须 `erase`。

### 调试

```jsonc
{ "action": "breakpoint_add", "location": "main" }
{ "action": "run" }
{ "action": "variables" }
{ "action": "stack" }
{ "action": "where" }
{ "action": "read", "address": 1073741824, "width": "u32", "count": 4 }
{ "action": "step_instruction" }
{ "action": "halt" }
```

地址用十进制传（`0x40000000` = `1073741824`）。读寄存器、变量、内存都会带上当前 PC，便于回看。

### 收尾（重要）

```jsonc
{ "action": "close" }          // 结束会话，释放探针
{ "action": "close_project" }  // 关工程会话，并把编辑写回 .uvprojx
```

**不关闭的后果**：探针被占用，其他工具（ST-Link Utility、CubeProgrammer）连不上；工程编辑只留在 uVision 内存里，磁盘上的 `.uvprojx` 没变。

---

## 五、安全模型

- 每个破坏性动作执行前带 `declaration`：写内存会给出 `address` / `length`，擦除会说明是整片，工程编辑会说明「经 uVision 落盘、编辑前自动备份」。
- `ask` 在没有审批器的 headless 环境下**降级为拒绝**，工具不执行。
- 取证类动作标记 `evidence`，不会被上下文压缩吞掉，事后能回看原始读数。

---

## 六、故障排查

| 现象 | 先查什么 | 通常原因 |
|---|---|---|
| 工具没出现 | `mcp.json` 的 `args` 路径 | 指向了源码目录或仓库外的旧路径；`dist-mcp` 没构建 |
| `Keil MDK is not installed` | 注册表 `HKLM\SOFTWARE\WOW6432Node\Keil\Products\MDK` 的 `Path`，以及 `UV4\TOOLS.INI` | 装在非默认位置且注册表没写；本服务会读注册表与 `TOOLS.INI`，最后才试默认路径 |
| 连不上目标 | `.uvoptx` 里的适配器；探针是否被别的进程占用 | 上一次会话没 `close`；ST-Link Utility 开着 |
| `NOT_DEBUGGING` | 是否先调用了 `open` | 工程结构类动作需要进入调试模式后才能回答 |
| `Target is in debug mode` | 是否在调试会话里改工程 | 先 `close`，再改工程，再重新 `open` |
| 工程改了但文件没变 | 是否调用了 `close` / `close_project` | uVision 在退出时才写盘；本服务不会直接改 `.uvprojx` |
| `Flash Download failed` | 芯片型号、Flash 算法、是否整片擦除过 | 选项字节/读保护；先 `erase` 再 `flash` |
| `Target DLL has been cancelled` | 是否还有另一个 uVision 开着同一工程 | 探针被占用；本服务的 `flash` 会自动关调试会话，手动开着的 uVision 仍需先关 |
| `erase` 说不可用 | 是否装了 STM32CubeProgrammer | 整片擦除必须走 ST 的 CLI，UVSOCK 的擦除在 5.43a 无响应 |
| 中文组名/路径乱码 | 工程文件编码 | 协议按 GBK 编解码；工程文件本身若是 UTF-8，新建中文组名仍会按 GBK 发送 |

---

## 七、已知限制

1. 构建失败只给 UV4 日志原文与退出码，不做结构化的「文件:行号」（诊断解析未迁移）。
2. 只支持 Keil 生态；Zephyr / ESP-IDF / PlatformIO / Arduino / Cargo / CMake / Make 不在本服务范围。
3. UVSOCK 是未公开协议，偏移来自 MDK 5.43a 实测；换版本需要重新验证。
4. 整片擦除依赖外部 CLI，且会先关闭所有会话（一个探针不能被两个程序同时占用）。

条目登记在 `docs/deferred-issues.md`（D-199 起）。