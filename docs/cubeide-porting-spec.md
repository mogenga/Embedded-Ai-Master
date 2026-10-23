# CubeIDE 接入 + 工程路由门面 — 实施规格

日期：2026-10-23。决策：方案 A（统一门面按工程类型路由），用户已确认。

## 目标

1. 新增 `mcp-servers/cubeide/`：把 STM32CubeIDE 2.2 的构建、烧录、擦除、调试能力做成 MCP server，机制全部公开（Eclipse headlessbuild / GDB/MI / STM32_Programmer_CLI），无逆向协议。
2. 新增统一路由门面：模型只调一个 `embed_project` 工具，门面识别目录里的工程类型，分发到 keil 或 cubeide 后端。

## 本机实测事实（设计依据）

- CubeIDE 2.2.0 在 `G:\software\STM32CubeIDE_2.2.0\STM32CubeIDE\`（非默认路径 → 发现逻辑不能只猜 C 盘）。
- `headless-build.bat -help` 可用；构建入口为 `stm32cubeidec.exe -data <ws> -application org.eclipse.cdt.managedbuilder.core.headlessbuild -import <dir> -build all`。
- 插件目录含（版本号目录，必须 glob 不能写死）：
  - `com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.*.win32_*` → `tools/bin/arm-none-eabi-gdb.exe`（15.2）、`nm/objdump/objcopy`
  - `...stlink-gdb-server.win32_*` → `tools/bin/ST-LINK_gdbserver.exe`（7.14，`-p`、`-cp <cubeprogrammer bin>`、`--erase-all`）
  - `...openocd.win32_*` → `tools/bin/openocd.exe`
  - `...jlink.win32_*` → `tools/bin`（JLink gdbserver）
  - `...cubeprogrammer.win32_*` → `tools/bin/STM32_Programmer_CLI.exe`（2.23，`-w`、`-e all`、`-c SWD`）
- ST gdbserver 依赖 `-cp` 指向 CubeProgrammer bin（config.txt 示例原话）。
- 本机另有独立安装的 CubeProgrammer 2.7.0（`C:\Program Files\STMicroelectronics\...`）——**不用它**，只用 IDE 内置那份，保持"装了 IDE 就有全部二进制"。
- 当前无 ST-Link 接入（真机验证步骤要留到板子插上后）。
- 实验工程（qianrushishiyan）全部是 Keil 格式；CubeIDE 工程另行准备（CubeIDE 新建工程即可产出 .project/.cproject）。

## 工程识别规则（路由表）

| 判据（按顺序） | 类型 | 后端 |
|---|---|---|
| `*.uvprojx` / `*.uvproj` | Keil MDK | keil |
| `.project` + `.cproject` 同目录 | Eclipse CDT / CubeIDE | cubeide |
| 两者都在（或各在不同子层） | 混合 | 列出全部，报 `mixed`，要求显式 `project` 参数 |
| 都没有 | 未知 | 诚实报错 + 列目录线索（Makefile/CMakeLists 等） |

复用 `findUvprojx` 的两条硬规则：备份文件不算工程；不进 OBJ/build/DebugConfig/RTE/点开头目录。Eclipse 搜索深度同 findUvprojx（本层→下一层）。

## 模块划分

### cubeide 后端（mcp-servers/cubeide/）

- `cubeideInstall.ts` — 发现：环境变量 `CUBEIDE_HOME`（用户可指定）→ 注册表 `HKLM\SOFTWARE\STMicroelectronics\STM32CubeIDE*`（实测确认键名后再写死，先实现 env + 常见路径 + 驱动器扫描兜底）→ 找含 `stm32cubeidec.exe` + `plugins/` 的目录。glob 出五个 externaltools 插件路径。
- `cubeideCli.ts` — headless 构建：`stm32cubeidec.exe --launcher.suppressErrors -nosplash -application org.eclipse.cdt.managedbuilder.core.headlessbuild -data <tmp-ws> -import <projdir> [-cleanBuild|-build] <project>[/<config>] -printErrorMarkers`；每次构建用独立 workspace 目录（避免锁）。
- `cubeideFlash.ts` — `STM32_Programmer_CLI -c SWD [-e all] [-w image 0x08000000 -v]`；image 路径来自 .cproject 构建产物或显式参数。
- `gdbMi.ts` — GDB/MI over stdio：spawn `arm-none-eabi-gdb --interpreter=mi2`，`-target-select remote <host>:<port>`。实现：break-insert/delete、exec-continue/interrupt/step/next/finish、data-evaluate-expression、stack-list-frames、data-list-register-names/values、memory read/write（`-data-read-memory-bytes`/`-data-write-memory-bytes`）、target-download、target-reset、gdb-exit。停帧解析 =^stopped 的 reason/addr/frame。
- `gdbserver.ts` — spawn ST-LINK_gdbserver（`-p 61234 -cp <cp bin> -g`）或 openocd（`-c "gdb_port <port>"` + 板级配置由调用方给）；探针独占性：启动前报告已有会话。
- `gdbSession.ts` — 会话生命周期（单会话即可，语义同 keilSession 但简单得多）：ensureSession/listSessions/close，全部动作按 action 名分发，产物是文本行 + data。
- `actions.ts` — `CUBEIDE_DEBUG_ACTIONS` / `CUBEIDE_PROJECT_ACTIONS`、evidence/destructive/readonly 三张白名单、zod schema（形状与 keil 的 debugInputSchema 对齐，工程参数为目录或 .project 路径）。
- `declarations.ts` — 照 keil 的 declarationFor：写内存/写寄存器/变量、断点增删、run control、flash（烧写镜像扇区）、chip_erase（整片）、build/clean。
- `tools.ts` — `cubeide_debug`（调试动作面）+ `cubeide_build`（构建/烧录/擦除动作面），返回形状对齐 keil 的 LegacyResult→ProbeToolSpec 转换；`_meta.evidence` + 动作白名单同构。
- `server.ts` — 照 keil/server.ts。
- `route.ts`（门面，可放独立 `mcp-servers/embedded/` 或 cubeide 目录内）— `embed_project` 工具：identify → 若单类型直接转发对应后端 tool spec；`identify` action 返回工程类型与文件清单。

### 路由门面动作面（embed_project）

```
action=identify   → 不执行，只报 { kind: keil|cubeide|mixed|none, files: [...] }
其余 action       → 识别后按 kind 转发 keil_debug/keil_project/cubeide_debug/cubeide_build 的同名 action
```
门面透传 `project`（uvprojx 或工程目录），参数 schema 是宽松 object（子 schema 校验留给后端）。

## 端口与会话约定

- ST gdbserver 默认 61234，openocd 默认 3333；gdb 用 MI 的 `-target-select remote`。
- 调试会话：spawn gdbserver（若未在跑）→ spawn gdb MI → attach。`close` 时按 gdb-exit → 杀 gdbserver 树（复用 killTree 模式）。
- 烧录与调试互斥：flash 前要求无活动调试会话（同 keil 的 forDownload 语义：先自动 close 调试会话，报告断点丢失）。

## 安全模型（照 keil §7）

- evidence：registers/variables/stack/read/disassemble/frames/flash 回读。
- destructive：写内存/寄存器/变量、断点/观察点、run/step/reset、flash/erase、build/clean。
- 写前声明 declarationFor 一条不缺；ask 在 headless 降级为拒绝（继承现有审批层行为）。
- R3：识别失败诚实报；gdbserver 启动失败带 stderr 原文；全 0 读数带警告（probe 的 allZero 模式）。

## 测试

- 单元：识别路由表（fixture 目录：keil-only / cubeide-only / mixed / none / 备份文件排除）、gdbMi 帧解析（MI 输出样例字符串）、declarations 覆盖全部 destructive、安装发现（注入 env 与 fake fs 或 existsImpl 注入）。
- 离线可跑：所有单测不触硬件；gdbMi 用注入的 fake gdb 进程（提供 transportFactory 同 probe 模式）。
- live（板子接入后，`HARNESS_COMPAT_LIVE=1`）：headless build 一个最小 CubeIDE 工程 → flash → open → registers → close。

## 文档与留痕

- `docs/cubeide-headless.md`（照 keil-headless.md 结构）。
- `docs/deferred-issues.md` 登记：路由 mixed 时的 UX、openocd 板级配置无默认、JLink 路线未实测。
- `dev-notes/M2-阶段3.md`（或现有对应文件）增量追记。
