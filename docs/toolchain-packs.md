# 工具链包（Toolchain packs）

Embedded-Ai-Master 的桌面应用是一个薄壳。编译器不进安装包；它们按需下载到
一个应用独占的目录里，用户随时可以整个删掉。

这个功能成败全在结构上。它要防的问题在本仓库的历史里就有实例：几 GB 的
过期构建产物散落各处。一个会把 300 MB–2 GB 编译器拉下来的功能，在别人的
磁盘上制造同样规模混乱的速度只会更快。

> 迁移注记：本模块整体迁移自 Prometheus 的 `src/packs/`（7 文件，事务契约
> 逐字保留）。与 A 的差异见文末的差异表。

## 不变量

**这个功能写下的每个字节都在一个根目录下，且每个 pack 都是一个删掉后
不留痕迹的目录。**

下面的一切都是为了让这条规则在中断、磁盘耗尽、损坏、取消与双窗口并发下
成立。

| 规则 | 如何保证 |
|---|---|
| 一个根 | `src/packs/paths.ts` 独占全部路径构造，别的代码不拼 |
| 不改宿主环境 | `mcp-servers/keil/toolEnv.ts` 为每次 spawn 构造独立环境；`process.env` 永不被写，有测试断言 |
| 一个 pack 一个目录 | `pack.json` 就在被它描述的目录里；没有会失步的索引文件 |
| 半装的东西不可见 | download → verify → 暂存解压 → 运行验证 → 原子改名 |
| 制品钉死 | 仅 https、SHA-256 必填、重定向主机白名单 |
| 数据不是代码 | 无安装脚本、无 post-install 钩子；只解压归档 |

## 磁盘布局

```
%LOCALAPPDATA%\Embedded-Ai-Master\toolchains\      ← 唯一的根
  root.json                                ← 所有权标记
  .lock                                    ← 同一时刻只允许一个安装
  packs\
    arm-gnu-15.3.rel2-win32-x64\           ← 一个 pack，可整体删除
      pack.json                            ← 这个 pack 的唯一记录
      NOTICE.md                            ← 许可与 GPL 源码邀约
      payload\                             ← 解压出的树，commit 后不可变
        bin\arm-none-eabi-gcc.exe
    .trash-<id>-<epoch>\                   ← 待删除
  tmp\
    txn-<random>\                          ← 进行中的安装事务
```

根目录是 OS 数据目录，**不是** `~/.harness`。后者放的是会随 Windows 配置
文件漫游、会被卷进备份的小型 JSON；把几个 GB 的编译器放进去会让每次备份
都昂贵。它也不是 Electron 的 `userData`——CLI 与桌面宿主共用同一个根，
谁都不依赖 Electron。

`HARNESS_TOOLCHAIN_HOME` 可以覆盖它。值必须是绝对路径：相对路径会在 CLI
和桌面应用里解析到不同的地方。

测试进程里（vitest / `NODE_ENV=test`）未设置该变量时，`packsRoot()` 直接
抛错而不是返回真实根目录——与 `src/config/harness-home.ts` 的 D-170 防污染
约定同源：测试 fixture 写穿用户真实目录的失败不可逆，把「忘了隔离」变成
硬失败比事后反推更诚实。

## 安装事务

`src/packs/install.ts`。九个阶段各自可以失败；**失败后留下什么**就是契约：

| 阶段 | 做什么 | 失败留下 |
|---|---|---|
| preflight | id、manifest、校验和、磁盘检查（`archive + unpacked × 1.15`） | 什么都没写 |
| lock | `<root>\.lock`，只在持有 pid 已死时才视为失效 | 一个锁文件 |
| download | 流式写入 `tmp\txn-*`，边写边哈希 | txn 里的半截归档 |
| verify | SHA-256；不匹配则删除归档 | staging 里什么都没有 |
| list | 每个成员在写入任何文件之前校验 | staging 里什么都没有 |
| extract | 解压进 `txn\payload`——树此刻就是最终形态 | txn |
| inspect | 遍历结果：指向 pack 外的符号链接、setuid 位、文件数 | txn |
| validate | 运行工具链并匹配输出；GCC 还要证明自己带 C 库 | txn |
| commit | 写 `pack.json` + `NOTICE.md`，然后一次原子改名 | 旧 pack，完好无损 |

两个容易做错、而且确实错过的细节：

- 事务目录在 `finally` 里**只在仍然存在时**删除。成功 commit 后 txn 已经
  *是*目标目录，无脑 `rm` 会删掉刚装好的 pack。
- 暂存的 `payload` 目录必须在解压之前建好：`tar -C` 需要它存在，而缺了它
  的报错出现在 30 分钟下载之后——最让人困惑的失败位置。

改名前断电留下一个 `txn` 目录（下次启动时清理）。改名期间断电是安全的，
因为 rename 是原子的：旧目录或新目录存在，绝无混合体。

## 锁

两个窗口就是两个宿主进程，而且都能触到 `installPack`。没有锁的话，同一
个 pack 的两次安装会暂存到不同的事务目录，然后在 commit 的改名上竞争：
一个赢，另一个在下完十分钟的包之后拿到 EPERM，落败方的暂存副本成为
孤儿。锁把这种情况变成一个零成本的拒绝。

失效由 **pid 决定，不由时长决定**：一次真实安装可以比任何值得写下的超时
都久，但死掉的 pid 永远不会回来。pid 属于活进程的记录——包括调用方自己
的——不算失效，否则一个挂住的宿主会永远锁死安装。

宿主侧还有第二层守卫：同一窗口内前一个安装未结束时，新请求直接回
`pack_error`（「另一个包安装正在进行中」），命令循环全程可响应。

## 零依赖解压

Windows 自带 `%SystemRoot%\System32\tar.exe`（bsdtar / libarchive），对
`.zip` 与 `.tar.xz` 的列表和解压都正常（本仓库迁移时在 B 机器实测：
bsdtar 3.5.2）。macOS 与 Linux 自带 `/usr/bin/tar`。

- 二进制永远解析成**绝对**路径。经 `PATH` 解析 `tar` 会让我无法控制的
  目录决定跑的是什么。
- 子进程环境里清掉 `TAR_OPTIONS`：它是注入向量，用户自己的设置不得悄悄
  改变我们解压的方式。
- 成员在解压前校验：拒绝绝对路径、盘符、两种分隔符拼的 `..`（`..\..\evil`
  是 Windows 的拼法）、NUL、超过 900 字符的名字。

## 发现与环境

Tools 设置页的探测顺序：**pack 目录 → PATH**；Keil 例外（注册表 +
TOOLS.INI 发现，见 `desktop/host/toolchains.js` 与 keil server 的
`keilInstall.ts`）。pack 是应用可以校验的显式安装；PATH 最不可信——
Homebrew 的 `arm-none-eabi-gcc` 是没有 C 库的编译器，找到它比找不到更糟。

pack 的二进制只通过**那一次 spawn 的环境**到达子进程
（`mcp-servers/keil/toolEnv.ts`）。值得说清为什么：写 `process.env.PATH`
短期看能工作，但会把 pack 泄漏给之后的所有子进程，包括用户自己的 shell
工具。keil server 在启动时从内核编译产物 `dist/packs/registry.js` 注入
`packBinDirs`（`server.ts` 的 `wirePackBinDirs`）——keil 的构建
（rootDir=mcp-servers）不能静态 import 内核 `src/`，注入是分层红线的
代价，也是解法。

## 宿主命令与事件（B 特有）

Tools 页（`desktop/renderer/settings.js`）经宿主 NDJSON 协议消费：

| 命令 | 事件 | 说明 |
|---|---|---|
| `getPacks` | `packs` | 已装列表 + 磁盘占用 + 本机探测 + 工具链元数据表，一条消息 |
| `getPackCatalog` | `pack_catalog` | 可安装条目（无哈希的也列出，标 `installable:false`） |
| `installPack {id}` | `pack_progress` → `pack_installed` / `pack_error` | 分钟级操作，进度边跑边发 |
| `installFromManifest {path, files}` | 同上 | 离线安装：同一个事务，字节来自本地 |
| `removePack {id}` | `packs`（刷新） | armed 两段式确认在渲染器 |
| `verifyPack {id}` | `pack_verified` | 浅检查：可执行文件都在、工具链还应答 |
| `prunePacks` | `pack_pruned` | 只删本应用创建且已过期的遗留 |

`pack_progress` 的 phase 枚举：`preflight / download / verify / extract /
inspect / validate / commit`；下载阶段附带 `received` / `total` 字节数。

## 权限（B 特有）

- **桌面命令不经过权限 preset**：`installPack` / `removePack` 是宿主命令，
  由用户点击发起，用户意图本身就是授权。删除的「审批」是渲染器的 armed
  两段式确认（首次点击进入 4 秒确认态，再次点击才真正发命令）。
- **agent 侧**：内核工具调用若触达 pack 安装（例如经 `shell` 跑本仓库的
  packs 模块），按现有 `permissions.json` 规则匹配 preset
  （`read-only` / `workspace-write` / `diagnose` / `danger-full-access`）。
  建议归类：安装属写操作（`workspace-write` 及以上允许、更低 preset 为
  ask）；卸载是删几百 MB 的破坏性操作，**恒需 ask**，与 preset 无关。
  示例规则（写入 `$HARNESS_HOME/permissions.json`）：

  ```jsonc
  {
    "version": 1,
    "rules": [
      { "tool": "shell",
        "params": [{ "key": "command", "contains": "packs-e2e" }],
        "action": "ask" }
    ]
  }
  ```

- **paramsDigest 审计**：`src/permissions/gate.ts` 对每次工具调用无条件
  生成参数摘要（`digestParams`），对任何暴露 `installPack {id}` 形状的
  工具天然生效——无需 packs 侧做任何事，本条为确认而非新增。

## 范围

只发 Windows（`win32`，x64）。其它平台解析出不同的根目录、机器本身也能
跑，但目录里没有它们的条目——可安装列表是对「制品已下载并哈希过」的承诺，
我们只对 Windows 做过这个承诺。`catalogFor` 按平台和架构过滤，将来加平台
意味着加实测过的条目，而不是改代码。

## 验收与运维

- `npm test`：`src/packs/packs.test.ts`（68 例：A 侧 41 例断言语义不变 +
  B 侧真实路径补充）。
- `npm run packs:e2e`：装（默认 Ninja，~300 KB 真实下载）→ 验证可执行 →
  卸载 → 无残留。验收动作用脚本，不是 CI 的一部分（默认测试不触网）。
- **代理环境**：Node 的内置 `fetch` 默认不读 `HTTP_PROXY`/`HTTPS_PROXY`。
  出网需走代理的机器（如 clash）上跑 e2e 或真实安装，用 Node 24 的环境
  变量开关（零代码改动）：

  ```bash
  NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 npm run packs:e2e
  ```

  端口以本机代理实际监听为准（clash-verge 混合端口见系统代理设置）。
- 手工破坏性测试契约（与 A 相同）：下载中途断网 → 无半装可见（txn 清理、
  packs/ 不出现）；`.lock` 留死 pid → 下次安装自愈；手动删 pack 目录 →
  枚举不出现孤儿记录（目录列表即索引）。

## 与 A（Prometheus）的差异表

| 项 | A | B | 原因 |
|---|---|---|---|
| 环境变量 | `PROMETHEUS_TOOLCHAIN_HOME` | `HARNESS_TOOLCHAIN_HOME` | 命名适配 |
| 默认根 | `%LOCALAPPDATA%\Prometheus\toolchains` | `%LOCALAPPDATA%\Embedded-Ai-Master\toolchains` | 命名适配 |
| 测试进程防污染 | 无 | 未设变量直接抛错（D-170 同源） | B 的防污染约定 |
| `packBinDirs` 消费方 | `src/embedded/toolEnv.ts`（静态 import） | `mcp-servers/keil/toolEnv.ts`（server 启动时从 `dist/packs` 注入） | B 的分层红线（keil 构建不能 import 内核 src/） |
| 代码位置 | `src/packs/`（与 embedded 同层） | `src/packs/`（平台层；领域代码不进 src/ 的红线靠注入绕开） | packs 是多 server 共用基础设施 |
| 探测顺序 | `PROMETHEUS_TOOLCHAINS` → packs → 安装根 → PATH | packs → PATH（+ Keil 注册表例外） | `PROMETHEUS_TOOLCHAINS` 对应物与全量安装根扫描属 Phase 3 |
| 目录条目 | 9 条 Windows x64 | 同 9 条，哈希/URL 原值不动 | 哈希钉死，重算只会引入错误 |
| 离线安装入口 | host 命令 + UI | host 命令 + UI（settings.js 既有离线安装段） | 协议形状以 settings.js 为准 |
| 测试 | node:test，41 例 | vitest，68 例（含真实 tar / 注入 fetch / 真实可执行验证） | B 的测试栈与覆盖率文化 |