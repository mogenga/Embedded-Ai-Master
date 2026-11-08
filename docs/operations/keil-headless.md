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
         "timeoutMs": 600000
       }
     }
   }
   ```

   路径要用**绝对路径**，并且指向 `dist-mcp`（不是 `mcp-servers` 源码目录）。

   `timeoutMs` 写 **600000（10 分钟）**：`keil_debug` 的 `build` / `rebuild` 在 uVision 里内部就允许 10 分钟，而内核以前把上限钳在 120s——构建会在两分钟被掐断，且界面上表现为「MCP 连接断开」而不是「构建超时」。2026-11-07 起硬顶抬到 10 分钟，首启自动写入的种子配置也是这个值。改小它会让构建重新失败。

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

### 烧录

```jsonc
{ "action": "flash" }                    // UV4 -f；烧完从镜像起始处抽检前 64 字节
{ "action": "flash", "count": 1024 }     // 比对前 1024 字节
{ "action": "flash", "count": 65536 }    // 比完整张 64 KiB 镜像（按 0x2000 分段）
```

**回读覆盖多少，取决于 `count`，并且会如实写出来。** 下载完成后服务会打开调试会话，从镜像的起始地址（`.hex` 记录里的加载地址）回读并逐字节比对。默认只比**前 64 字节**；`count` 更大时，超过 8192 字节的部分按 `0x2000` 一段**继续读到镜像末尾**——所以 `count` 不小于镜像长度时，整张镜像都会被比过。

三种范围由 `structuredContent.flashVerify.scope` 区分，不必解析文本：`spot`（只覆盖一部分）、`full`（一次读就覆盖全镜像）、`segmented-full`（分段读覆盖了全镜像）、`none`（没比成，或某段读不回）。`segments` 字段只在分段时出现，`count` 在 8192 字节以内时它**根本不存在**——返回形状与以前一样。整次回读有 60 秒总预算，到点就停并报 `spot`，不会把没比过的部分说成通过。

抽检（`spot`）通过只说明被比过的那一段是对的；**剩下的部分没有读过，不能据此宣称整片 flash 与镜像一致**。整镜像校验请把 `count` 设成不小于镜像字节数。

**`flash` 会自动关闭同工程的调试会话**：下载跑在 plain 工程会话上，而一个 ST-Link 不能被两个 uVision 同时占用。服务会先结束调试会话、再启动下载，所以**断点与运行位置会丢失**，需要重新 `open`。

`flash` 只擦除镜像自身占用的扇区（Keil 的行为），不是整片。`erase` 在 MDK 5.43 上不可用（`PRJ_FLASH_ERASE` 无响应），整片擦除不在本工具的能力范围内——要清掉镜像外的扇区，用带全片擦除选项的外部工具自己操作。

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

**不关闭的后果**：探针被占用，其他工具（ST-Link Utility 等）连不上；工程编辑只留在 uVision 内存里，磁盘上的 `.uvprojx` 没变。

---

## 五、安全模型

- 每个破坏性动作执行前带 `declaration`：写内存会给出 `address` / `length`，擦除会说明是整片，工程编辑会说明「经 uVision 落盘、编辑前自动备份」。
- **工程编辑确实会先备份**：`add_group` / `add_file` / `remove_file` / `remove_group` / `set_option` / `set_target` / `set_output_name` 在派发前把 `.uvprojx`（以及存在时的 `.uvoptx`）复制为 `<文件>.prometheus.bak`，输出里报告备份路径。备份写在原文件旁边，不可能越出工程目录；后缀已被工程发现逻辑排除，不会被当成工程打开。**备份失败就不编辑**（fail-closed）。
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
| `Flash Download failed` | 芯片型号、Flash 算法、选项字节/读保护 | 用 `clean_rebuild` 后重试；仍失败看 uVision 日志 |
| `Target DLL has been cancelled` | 是否还有另一个 uVision 开着同一工程 | 探针被占用；本服务的 `flash` 会自动关调试会话，手动开着的 uVision 仍需先关 |
| `erase` 说不可用 | 预期行为 | `PRJ_FLASH_ERASE` 在 MDK 5.43 上无响应，整片擦除不在本工具范围内 |
| 中文组名/路径乱码 | 工程文件编码 | 协议按 GBK 编解码；工程文件本身若是 UTF-8，新建中文组名仍会按 GBK 发送 |

---

## 七、已知限制

1. 构建失败时的结构化诊断（`file:line`、`#20` / `L6218E` 码、同一符号的重复链接错误折叠）由 `mcp-servers/keil/diagnostics.ts` 按 **ARMCC / ARMCLANG / armlink 的文档化输出格式**解析，**没有在真实工程上验证过**——本机没有可用的 Keil，仓库里也没有真实 UV4 构建日志。认不出的行随日志原文尾部一并返回，不会丢。
2. 只支持 Keil 生态；Zephyr / ESP-IDF / PlatformIO / Arduino / Cargo / CMake / Make 不在本服务范围。
3. UVSOCK 是未公开协议，偏移来自 MDK 5.43a 实测；换版本需要重新验证。
4. 整片擦除不可用：`PRJ_FLASH_ERASE` 在 MDK 5.43 上无响应，本工具不做外部 CLI 替代；`flash` 只覆盖镜像自身扇区。

条目登记在 `docs/ledgers/deferred-issues.md`（D-199 起）。