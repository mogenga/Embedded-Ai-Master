# 工具链包管理器移植 Todolist(Prometheus → Embedded-Ai-Master)

> 状态:已完成（2026-10-25，三个阶段三次提交；验收记录见 `docs/toolchain-packs.md` 与各步勾选）。按 A(`Prometheus/src/packs`,2,293 行,7 文件)→ B 的移植路线编写。
> 前置事实(2026-10-24 实测):
> - B 的设置页 **Tools 页 UI 已经在等这个功能**:`buildToolsPage()` 渲染 pack 列表/安装/卸载按钮,`installPack`/`removePack` 命令已发、`packs`/`pack_catalog`/`pack_progress` 三个事件已消费([settings.js:3288-3530](desktop/renderer/settings.js)),但 `desktop/host/host.js` **没有任何生产端**——整页当前不可达(deferred-issues D 条隐藏清单中的一项)。
> - `mcp-servers/keil/toolEnv.ts:89` 留有 `packBinDirs()` 恒为空的 TODO(「Phase 3 接回」);`keilInstall.ts:10` 探测也标了 Phase 3。
> - A 侧 `src/embedded/toolEnv.ts` 依赖 `packs/registry.ts` 的 `packBinDirs`;B 的 `toolEnv.ts` 移植时已解耦注入,现在要接回。
> - 遵循 B 的分层原则:packs 是**平台层**(多 MCP server 共用的基础设施,非单领域),进 `src/packs/`,不进 `mcp-servers/`;bootstrap 红线不破坏。

## 0. 移植单元与依赖闭包(A 侧实测)

| A 文件 | 行数 | 内容 | 依赖(需处理的) |
|---|---|---|---|
| `paths.ts` | 240 | 根目录/lock/trash/txn 全部路径,`root.json` 所有权标记 | 仅 node:fs/path + `PROMETHEUS_TOOLCHAIN_HOME`;**零依赖,直接迁** |
| `manifest.ts` | 291 | `pack.json` 读写(装在目录内,无外部注册表) | `paths.ts` 的 `isInside`;直接迁 |
| `download.ts` | 184 | https 流式下载 + 边下边哈希 | node 内置;直接迁 |
| `archive.ts` | 357 | zip/tar.xz/tar.gz 列表+解压(成员先验证后落盘) | 需确认是否用系统 tar/unzip 或纯 JS;见步骤 3 |
| `install.ts` | 492 | 九阶段事务(preflight→lock→download→verify→list→extract→inspect→validate→commit) | `paths/manifest/download/archive`;直接迁 |
| `catalog.ts` | 457 | 内置目录(9 个 Windows x64 包:Arm GNU×2、OpenOCD、CMake、Ninja、probe-rs、pyOCD、esptool…) | 纯数据;直接迁 |
| `registry.ts` | 272 | 已装枚举、`packBinDirs()`、remove(trash→删除) | `paths/manifest`;直接迁 |

测试:`packs.test.ts`(A 侧 `tests/` 内,事务/锁/哈希/损坏用例)——**必迁**,这是整个功能的信心来源。

## 1. 目标形态

```
src/packs/            ← 平台层,7 文件 + paths.ts 适配
  (内容同 A,import 路径改相对、.ts 后缀按 B ESM 约定调整)
desktop/host/host.js  ← 新增 handlers:packs / pack_catalog / installPack /
                        removePack(emit packs、pack_catalog、pack_progress 事件)
mcp-servers/keil/toolEnv.ts ← packBinDirs() 从空 Map 接回真实实现(注入而非 import)
settings.js           ← 基本零改动(UI 已就位,验证即可)
```

命名:`PROMETHEUS_TOOLCHAIN_HOME` → `HARNESS_TOOLCHAIN_HOME`;根目录 `%LOCALAPPDATA%\Prometheus\toolchains` → `%LOCALAPPDATA%\Embedded-Ai-Master\toolchains`(与 `harness-home.ts` 的既有约定一致)。

## 2. 执行清单(按序,每步可验证)

### 阶段一:纯函数层(无 UI、无宿主)

- [x] **T1** 迁 `paths.ts` → `src/packs/paths.ts`。改名:`PROMETHEUS_TOOLCHAIN_HOME` → `HARNESS_TOOLCHAIN_HOME`,默认根改 `%LOCALAPPDATA%\Embedded-Ai-Master\toolchains`。保持「只有这个文件能构造 pack 路径」的不变量,文件头注释写明。
- [x] **T2** 迁 `manifest.ts`、`registry.ts`、`download.ts`。检查 A 侧对 `sandbox.ts`/`spill.ts` 的 import(若有)改为注入或删除。
- [x] **T3** 迁 `archive.ts`。已核实:A 侧**无第三方依赖**——调用系统 `tar.exe`(bsdtar,绝对路径,不经 PATH;已实测支持 zip/tar.xz 的列表+解压),自写成员验证(`..` 成员、剥前导 `/`、符号链接、绝对路径)补 bsdtar 的安全缺口。直接迁,零风险;唯一待办是把「tar.exe 已验证」的结论换成 B 机器上的实测记录。
- [x] **T4** 迁 `install.ts` 九阶段事务。逐条核对 A `docs/toolchain-packs.md` 的两个已知坑:txn 目录 `finally` 只在仍存在时删除(commit 后 txn **就是**目标);staging `payload` 必须先建再 `tar -C`。
- [x] **T5** 迁 `catalog.ts`(纯数据)。9 个包的 URL/SHA-256 保持 A 原值不动——哈希是钉死的,重算只会引入错误。首期可裁剪:B 实际会调用的 toolchain kind 优先(gcc-arm/openocd/cmake/ninja 先留,probe-rs/pyOCD/esptool 随 probe/cubeide 路线补),裁剪条目留注释。
- [x] **T6** 迁 A 侧 `packs.test.ts` → `src/packs/packs.test.ts`(B 是 vitest,断言改 `expect`;用例不减)。补一条 B 特有断言:`HARNESS_HOME` 未设时 packs 模块的行为(对齐 B「测试不设环境直接报错」的防污染约定)。
- [x] **T7** `npm test` + `npm run coverage` 过 85% 阈值;`typecheck` 过。

### 阶段二:接线(宿主 + toolEnv)

- [x] **T8** `desktop/host/host.js` 新增 4 个 handler:`packs`(枚举已装+磁盘占用+`toolchains` 探测表合并进同一条消息——settings.js 的 `case "packs"` 就这么预期的)、`pack_catalog`、`installPack {id}`、`removePack {id}`。事件协议照 settings.js 已消费的形状写:**先读 settings.js 的 case 分支,再定 emit 字段**,不要按 A 的 host.js 反推(A/B 消息名已漂移)。
- [x] **T9** `pack_progress` 事件:phase(preflight/download/verify/extract/validate/commit)+ 百分比。下载进度按已收字节/`bytes` 计算;阶段切换即时发。并发防护两层都要:B 宿主用 `running` 标志自守卫(`installPack` 是耗时操作,不能像快速命令那样同步返回;若做成异步任务则仿 `enqueueCorpus` 队列),`.lock` 文件(pid 活性检测)是第二道闸,防止 CLI 与桌面双入口。
- [x] **T10** `mcp-servers/keil/toolEnv.ts:89` 接回 `packBinDirs()`:从内核 `dist/` 读 registry(注入,不 import 源码),返回所有已装 pack 的 `payload\bin`。TODO 注释删除。**A 的测试断言 `process.env` 永不被写**——同样断言迁过来。
- [x] **T11** settings.js Tools 页实际打开验证:根目录/已用/剩余行、探测列表、目录列表、安装按钮(装一个最小的,如 Ninja ~1MB)、卸载(armed 两段式)、「打开目录」。死页转活的 deferred-issues 条目更新。
- [x] **T12** 桌面协议测试 `tests/desktop/`:packs 事件形状、installPack 排队、progress 序列、卸载确认流。

### 阶段三:权限与文档

- [x] **T13** 权限对齐:installPack/removePack 在 B 的预设模型里如何归类——建议 `workspace-write` 及以上允许 install,**remove 恒需审批**(删几百 MB 的破坏性操作);写进 `permissions` 规则示例与设置页说明。paramsDigest 审计对 `installPack {id}` 天然生效,确认即可。
- [x] **T14** 文档:B 仓库新增 `docs/toolchain-packs.md`(改写 A 版:目录名、环境变量、与 A 的差异表);README 功能清单补一行;deferred-issues.md 隐藏清单中 packs 项标记已解决;`keil-porting-spec.md` §5.2 的 Phase 3 TODO 勾销。
- [x] **T15** 端到端脚本:仿 `scripts/probe-e2e.mjs` 模式加 `scripts/packs-e2e.mjs`——装→验证可执行→卸→目录无残留,跑通后进 `package.json` scripts。

## 3. 明确不移植的清单

- A 的沙箱凭据/受管策略相关配置面(packs 在 A 与沙箱有耦合点,B 的权限体系用自己的)。
- A host.js 的 packs 命令分支(按 B 消息协议重写,见 T8)。
- Linux/macOS 路径分支(若 A 只支持 Windows x64 目录,B 首期同样只保 Windows;`paths.ts` 里的 POSIX 分支保留但标注未测)。
- 目录条目与 toolchain kind 的一一强制绑定:T5 裁剪的包,kind 探测不到不算缺陷。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| archive.ts 依赖不明导致 T3 卡住 | ~~已解除~~:A 用系统 `tar.exe` 绝对路径 + 自写成员验证,零第三方依赖,T3 是纯搬运 |
| 巨大下载失败残留 | 九阶段事务契约 + packs.test.ts 原用例(损坏/中断/磁盘满)保证;不许为省事砍 inspect/validate 阶段 |
| 内核不依赖 Electron 的约定 | packs 全部走 node,根目录不用 `userData`;`HARNESS_TOOLCHAIN_HOME` 必须绝对路径(沿用 A 的校验) |
| settings.js 期待的消息字段与实现漂移 | T8 明确「以 settings.js 为准」;T12 协议测试钉死字段 |

## 5. 验收标准

1. 全量 `npm test` 过,packs 用例数不少于 A 侧迁来数量;
2. Tools 设置页完整可用:装/卸/进度/磁盘统计/打开目录;
3. `mcp-servers/keil` 在仅装了 pack(无系统 PATH)的环境下能找到工具链(packBinDirs 接回生效);
4. 手工破坏性测试:下载中途断网、lock 文件留死 pid、手动删 pack 目录后枚举——三者行为与 A 的 `docs/toolchain-packs.md` 契约一致(无半装可见、无孤儿记录、锁可自愈);
5. `dist/` 构建产物下功能等价(B 走 tsc 构建,import 路径在构建后仍成立)。
