# 嵌入式能力移植计划(Prometheus → Embedded-Ai-Master)

> 状态:框架阶段。Keil 源头(Prometheus)尚在修 bug,本计划先立骨架,代码搬运待 bug 修复后执行。
> 本文件目前只在 B 仓库本地工作区,未提交、未推送。

## 0. 目标与红线

把 Prometheus(A)的嵌入式纵深(Keil/UVSOCK、SVD、烧录、构建、串口、工具链包)合并进 B 的主线,同时**不违反 B 的架构红线**:内核 `src/` 不含领域逻辑(`mcp-servers/probe/tests/bootstrap.test.ts` 强制)。因此落地形态是新增两个领域 MCP server:

- `mcp-servers/embedded/` — 通用嵌入式:芯片识别、目标表、SVD 寄存器、构建、烧录、串口、工具链包
- `mcp-servers/keil/` — Keil MDK 专栈:UVSOCK 调试(56 动作)、工程文件手术(14 动作)

已就位的骨架(未跟踪文件):
```
mcp-servers/embedded/server.ts        # 工具 spec 类型 + Phase1-4 schema 草案 + 分阶段工具清单
mcp-servers/embedded/toolTypes.ts     # 注解形状(readOnly/destructive/evidence)
mcp-servers/embedded/permissions.example.json
mcp-servers/keil/server.ts            # keil_debug/keil_project 计划面 + 移植注记
mcp-servers/keil/permissions.example.json
```

## 1. 源文件搬运清单(A → B,按依赖闭包)

### keil server(Phase 2,等 bug 修完)
| A 源(`G:/Develop/Prometheus`) | 行数 | 依赖闭包内 |
|---|---:|---|
| `src/embedded/uvsock.ts` | 1,112 | `toolEnv.ts`、`gbk.ts`、`winsandbox.ts`(仅 `killTree`) |
| `src/embedded/keilSession.ts` | 2,085 | 上者 + `uvsock` |
| `src/embedded/keilExtra.ts` | 526 | `uvsock` |
| `src/embedded/keilProjectFile.ts` | 232 | 无 |
| `src/embedded/keilCli.ts` | 237 | 无 |
| `src/embedded/gbk.ts` | — | 无 |
| 测试:`tests/round12-uvsock.test.ts`(76 例,报文级 mock,可进 CI)、`round13-keil-project-file/selection` | | |

搬运注意:`killTree` 单独抽出为本地 util(不要把整个 `winsandbox.ts` 带进来);`toolEnv` 若 Phase 3 packs 不迁可先内联一个空实现。

### embedded server
| Phase | A 源 | 说明 |
|---|---|---|
| 1(只读) | `identity.ts`(572)、`identifyGate.ts`、`probe.ts`、`svd.ts`(792)、`cmsisPack.ts`(417)、目标表逻辑 | evidence 注解;结构化 `deviceStatus` 走 B 现成链路点亮 Board 设备段 |
| 3(构建/烧录/包) | `project.ts`(659)、`build.ts`(682)、`diagnostics.ts`、`flash.ts`、`flashHistory.ts`、`debug.ts`(539)、`debugSession.ts`、`src/packs/`(2,293) | 破坏性 → declaration;packs 的锁/事务逻辑原样搬 |
| 4(串口) | `serial.ts`(697)、`serialStream.ts`(151) | Windows PowerShell 串口;失败信息按 R3 如实透出 |

**不搬**:`embeddedTools.ts`/`keilTools.ts`(适配层,与 B 的 ToolResult 协议不兼容,注册层照 probe 的 `tools.ts` 模式重写);`emulator.ts`(A 侧已核实为死代码)。

## 2. 适配点

1. **构建体系**:进 `tsconfig.mcp.json`(已 include `mcp-servers/**`,无需改);A 的 TS 扩展名 import(`./x.ts`)改为 ESM `.js` 后缀;Node ≥24。
2. **工具注册**:照 `mcp-servers/probe/server.ts` 的 `createProbeServer` 模式写 `createEmbeddedServer`/`createKeilServer`。
3. **权限**:
   - 注解:只读取证(evidence)、写/复位/烧录(destructive)。
   - 破坏性操作返回 `declaration {operation, effect, address?, length?}`(probe 已有模式)。
   - `permissions.example.json` 已给初版:embedded 默认 allow 只读、ask 构建/烧录/串口/包;keil 按动作名拆 allow(读)/ask(运行控制、下载)。
4. **deviceStatus**:工具结果 `structuredContent.deviceStatus` 会经 `src/mcp/device-status.ts` 校验(8KiB/4 层)转为 `device_status` 会话事件——Phase 1 就接上,Board 面板设备段零宿主改动点亮。
5. **配置**:A 的 board/keil 配置不迁 config;SVD 搜索目录用环境变量(`PROMETHEUS_SVD_DIRS` 改名)或后续 B 配置文件扩展,走 zod。

## 3. 测试迁移

- `node:test` → vitest:断言基本平移;round12 的报文 mock 不依赖真机,直接进 CI。
- 新增:`mcp-servers/embedded/tests/bootstrap.test.ts` 照 probe 抄一条("keeps domain code outside src")。
- 建议:借这次给 B 建 GitHub Actions(抄 A 的 Windows workflow),否则这批 Windows 重度代码没有闸门。

## 4. UI 放开(后续,可不做)

- 第一阶段不放开任何面板(device_status 自动点亮设备段,不需要动宿主)。
- Serial 监视器面板需要宿主加 `serial_*` 命令 + 改 `MATRIX.md`——放最后评估。

## 5. 执行顺序与当前状态

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 骨架 + 计划文档 + 权限示例 | ✅ 本地就位 |
| 1 | identity/targets/registers(SVD)/ports → deviceStatus 闭环 | 待做(不依赖 Keil bug 修复) |
| 2 | keil server(UVSOCK 全栈 + 报文测试) | **阻塞:A 侧 Keil bug 修复中** |
| 3 | build/flash/packs + declaration | 待做 |
| 4 | serial MCP 工具面 | 待做 |
| 5 | 评估放开 Serial 面板 + deferred-issues 登记 + MATRIX.md 更新 | 待做 |

每个 Phase 收尾:跑既有 probe/kb 回归 + 新迁测试,确认 bootstrap 红线测试仍绿。
