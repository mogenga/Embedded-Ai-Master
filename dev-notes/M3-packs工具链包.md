# packs 工具链包管理器移植（Prometheus → Embedded-Ai-Master）

> 2026-10-25 执行完毕。任务依据：`docs/packs-porting-todolist.md`（T1–T15）。
> 提交：`9d30946`（阶段一 src/packs）→ `3694044`（阶段二 宿主接线）→
> `1ab0b05`（阶段三 文档/e2e）→ `5136549`（协议测试超时修复）。全部在本地
> debug 分支，**未推送**。

## 关键决策与产出

- **分层**：packs 是平台层（多 MCP server 共用基础设施），进 `src/packs/`，
  不进 `mcp-servers/`（与 keil 移植的「不动 src/」红线区分开——那条只约束
  领域能力）。bootstrap 红线未破坏。
- **命名适配**：`PROMETHEUS_TOOLCHAIN_HOME` → `HARNESS_TOOLCHAIN_HOME`；
  默认根 `%LOCALAPPDATA%\Embedded-Ai-Master\toolchains`；测试进程未设变量
  时 `packsRoot()` 直接抛错（复用 `harness-home.ts` 导出的 `testRunner`，
  D-170 同源约定）。
- **catalog 哈希钉死**：9 条 Windows x64 条目 URL/SHA-256/字节数原值搬运，
  不重算、不裁剪（todolist T5 允许裁剪非必需条目，选择保留——零运行时
  成本，probe/cubeide 消费时免重测）。
- **宿主协议以 settings.js 为准**（任务红线）：7 个 handler（比 todolist
  写的 4 个多——渲染器实际还消费 verifyPack/prunePacks/installFromManifest，
  UI 已在等，不做半接）。`packs` 事件合并探测表 + 磁盘占用。
- **toolEnv 接回用注入而非 import**：keil 构建 rootDir=mcp-servers，不能
  静态 import 内核 src/；`server.ts` 入口从 `dist/packs/registry.js` 动态
  加载并 `setPackBinDirsProvider` 注入。`process.env` 永不被写的断言随迁
  （`mcp-servers/keil/tests/tool-env.test.ts` 6 例）。
- **探测表**：新增 `desktop/host/toolchains.js`（pack 目录 → PATH，Keil 走
  注册表发现借 dist-mcp 的 findUv4；IAR 按「未安装」诚实上报，Phase 3 全量
  探测接入前不猜）。

## 测试与验收数字

- `src/packs/packs.test.ts` 68 例 = A 侧 41 例（断言语义不变）+ 27 例 B 侧
  补充（真实系统 tar、注入 fetch、真实可执行验证、D-170）。
- `tests/desktop/host-packs.test.js` 7 例：真宿主进程 + 离线安装完整事务
  （进度序列 preflight→…→commit 钉死），不触网。
- coverage：全局 Lines 90.74%（阈值 85%），src/packs 自身 88.78%。
- `npm run packs:e2e`：真实下载 Ninja（291,570 字节，哈希与目录一致）→
  ninja.exe 1.13.2 → 卸载无残留。终验时复跑一度报 `fetch failed`，当时误判
  为「本机断网」；实际原因是本机出外网依赖 clash 代理且 Node 内置 fetch
  默认不读代理变量 + 节点瞬态波动。修正结论：**零代码改动**，代理环境用
  `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 npm run packs:e2e`
  （本机 clash-verge 混合端口从系统代理注册表读到 7897，不是默认 7890）。
  两条路径（网络恢复后裸跑 / 走代理）均复验通过，verdict 一致。用法已写进
  README 与 docs/toolchain-packs.md。
- 验收 #3 实测（`.smoke/packs-final-a-b.mjs`，临时脚本未入库）：PATH 仅含
  pack 目录的裸环境里 `spawn("ninja", ["--version"])` 跑出 1.13.2。
- 验收 #4 三连破坏性测试（`.smoke/packs-final-c.mjs`）：断下载（无半装/
  无残留/锁释放）、死 pid 锁自愈、删目录无孤儿（半删 broken 上报）。

## 翻车与返工（必须留痕的事故）

1. **块 C 首跑误触用户真实根**：终验脚本调 `installPack` 时忘传 `root`，
   事务落进默认根 `%LOCALAPPDATA%\Embedded-Ai-Master\toolchains`，留下空
   骨架（root.json + 空 packs/tmp，无 pack 无锁——取消路径的 finally 把
   txn 和锁清干净了，契约本身没破）。发现后已整目录删除恢复原状，脚本
   修正（root 显式传参）。教训：**调 packs 模块的脚本必须显式传 root 或
   先设 HARNESS_TOOLCHAIN_HOME**，`installPack` 的 root 参数缺省是
   `packsRoot()` 即真实根——测试进程外的裸 node 脚本没有 D-170 抛错保护。
2. **host-packs 协议测试全量并行下超时**：vitest 默认单测 5s，全量套件里
   机器负载高，getPacks 的 27 项探测超时（单独跑稳定全过，险些当成「偶
   发 flaky」放过）。修复：7 个 it 补 `HOST_TIMEOUT_MS` 尾参（5136549），
   与 host-corpus.test.js 既有风格一致。
3. **server.ts 提交混入用户进行中改动**：工作树上 server.ts 已有用户未
   提交的 embed_project 门面下线改动；直接 add 会把它们带进我的提交。手
   术：备份工作树版 → checkout HEAD → 只重放 wirePackBinDirs 三处 →
   staged 提交版 → 恢复用户工作树版。diff 核对：staged 仅 +26 行我的改动。
4. **e2e 网络失败误判为断网**：复跑报 `fetch failed` 时用 `curl example.com`
   直连也 000，据此写了「本机断网」。用户指出 curl 需走 clash 后重查：clash
   系统代理在（注册表 127.0.0.1:7897），Node fetch 不读代理变量才是根因；
   且事后直连 github 也恢复 200，说明叠加了节点瞬态。教训：**判断"网络不
   通"前先查系统代理注册表**（本机出网常态就是代理模式），curl 直连失败
   ≠ 断网。

## 偏差清单（实测与 todolist 描述不符处，未静默改设计）

- T11 的「打开目录」按钮：settings.js Tools 页**没有**该按钮（只有 license
  链接 openExternal）。按「UI 是既成事实」红线未新增 UI。
- todolist 写 A 侧 42 例，实测 `packs.test.ts` 为 41 个 test()；其中 2 例
  断言源适配（INSTALL_HINTS 未迁移、TOOLCHAIN_INFO 改引 keil 侧）。
- `round11-keil-packs.test.ts`（CMSIS 设备包）不在 todolist 移植范围，未迁。