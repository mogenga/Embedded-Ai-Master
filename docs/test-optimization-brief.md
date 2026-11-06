# Task Brief — 优化 `npm test`：更快、更稳、失败可读

仓库：`E:\Project\personal\Embedded-Ai-Master`，当前分支 `main`（已合并 `feat/page-optimization`）。
**不要建分支、不要 worktree、不要提交、不要 push。**

## 用户原话

> 发子代理，优化 npm test

## 先量，别猜

我已经跑了一次全量并导出了逐文件耗时（`--reporter=json`）。**基线数字如下，可以直接用，但每一项都要你自己复现一次再动手**：

```
全量: 130 个文件 / 3571 例 / 46.61s wall / 269.73s 测试时间总和
```

**最慢的 12 个文件（毫秒）**

| 文件 | 耗时 | 主要成本 |
|---|---:|---|
| `tests/desktop/host.test.js` | 44 776 | **56 例 × 每例 spawn 一个宿主进程**，单例 ~350ms 起步 |
| `tests/mcp-manager.test.ts` | 29 222 | 41 例，每例起 MCP 子进程；有 `setTimeout(150)` / `setTimeout(500)` 真等 |
| `mcp-servers/keil/tests/exit-settle.test.ts` | 24 594 | 真等 settle 窗（最长 10s 超时），4 例 |
| `tests/background-terminal.test.ts` | 19 092 | `waitFor` 轮询 25ms 间隔 + 真跑后台进程 |
| `tests/desktop/host-corpus.test.js` | 16 015 | 同 host，spawn |
| `tests/integration.test.ts` | 15 751 | 全链路 |
| `tests/effort-host.test.js` | 14 626 | 同 host，spawn |
| `tests/desktop/host-packs.test.js` | 13 023 | 同 host，spawn |
| `tests/ls.test.ts` | 6 128 | 造 500+ 个文件 |
| `mcp-servers/kb/tests/service.test.ts` | 5 882 | — |

**最慢的单个用例**

```
6963ms  exit settlePath 工程文件持续变化时，杀进程被推迟到 settle 或超时
6797ms  exit settlePath 工程文件已稳定时快速返回（等满 1s 稳定窗）
5732ms  exit settlePath 无 settlePath 时不进入 settle 轮询
5100ms  exit settlePath 文件不存在时不挂死，超时兜底照常 close
4919ms  packs: offline install transaction 装好的 pack 出现在 packs 消息里
4583ms  后台作业执行 立即返回 job id，不等待命令结束
3843ms  terminal_bg_check 查询 不带 id 时列出本会话的作业
```

## 已知的另一半问题：偶发失败

这台机器上并行负载高时，下面这几组**偶发**超时（单独跑必绿，全量跑在并发下偶尔红）：

- `tests/ls.test.ts` 的 500 条目用例
- `tests/background-terminal.test.ts`
- `tests/mcp-manager.test.ts`
- `mcp-servers/keil/tests/exit-settle.test.ts`
- `tests/server/files-api.test.ts` 的截断用例（2026-11-06 实测）
- `tests/glob.test.ts` 的 200 条上限用例（2026-11-06 实测）

**2026-11-06 复核**：全量默认并行度下每次红的具体用例都不一样（4 次全量分别是
`[killAll, 别的会话]`、`[kill, killAll]`、`[killAll, 别的会话, 不带 id]`、
`[files-api, glob, killAll]`），而 `npx vitest run --maxWorkers=4` **稳定全绿**
（3782 passed / 111s）。因此这些是**并行度 + 本机负载**的产物，不是代码缺陷；
`--maxWorkers=4` 可作为 CI 与本地的稳定口径。未改 `vitest.config.ts`（会改变全仓
测试行为），留作可选命令。

**这不是要你「把超时调大」了事。** 先判断每一处是「测试写得脆」还是「真实的竞态」。写脆的（依赖墙钟、依赖调度顺序、轮询间隔太粗）改成事件驱动；真竞态的记进报告，不要掩盖。

## 目标（按优先级）

### 1. 缩短墙钟时间，但不减少覆盖面

**单个用例的断言一条都不许删。** 允许的手段：

- **宿主进程复用**：`tests/desktop/host.test.js`、`host-corpus`、`host-packs`、`effort-host` 四组各 spawn 几十个宿主进程。看看能否在一个 `beforeAll` 里起一个宿主，每例发命令、读事件、最后关掉；**但必须先确认宿主是否可重入**（同一进程内连续 `saveProviders` → `listSessions` → `getKb` 会不会互相污染 `HARNESS_HOME`）。如果不可行，就明确写进报告「为什么不能」，不要硬凑。
- **等待改成事件驱动**：`setTimeout(150)` / `setTimeout(500)` / 25ms 轮询 —— 改成等真实信号（进程退出事件、stdout 行、Promise settle）。凡是「等一会儿再看」的地方都是脆的。
- **固定延时改成可注入的假时钟**：`keil/exit-settle` 的 settle 窗是真实的 mtime 轮询。如果 `settlePath` 的实现接受注入的 `sleep` / `now`，测试就能用假时钟把 4×6s 压到毫秒级，且**断言更准**（能精确验证轮询次数）。先读 `mcp-servers/keil/` 里 settle 的实现再决定。
- **并发**：`vitest.config.ts` 目前没设 `pool` / `maxWorkers`。跑一次 `--pool=threads --maxWorkers=4` 与默认对比，把结果写进报告。**但并发本身是偶发失败的来源**，所以要连同第 2 条一起看。

### 2. 消除偶发失败

对上面四组各跑 3 次全量 + 3 次单文件，贴真实输出。找出**根因**（不是超时阈值）：

- 是共享临时目录撞名？
- 是依赖 `process.cwd()`？
- 是端口/管道争用？
- 是轮询间隔比机器调度还粗？

找到根因才改。

### 3. 失败信息可读

现在宿主测试超时只说 `host timed out; events: a,b,c`。判断哪些失败信息不够定位，补上**当时最后一条命令、收到的最后 3 条事件、以及进程是否还活着**。

## 硬性约束

- **不改内核行为**（`src/`）。允许的改动：如果某个模块（如 settle）**已经支持**注入依赖，测试侧用它；如果**不支持**，写进报告建议，不要为了测试去改生产代码。
- **不删断言、不跳过用例**（`describe.skip` / `it.skip` 一个都不许新增；现有的 5 个跳过保持原样）。
- **不新增依赖**。没装 `fake-timers` 之类就自己写一个最小实现，或用 vitest 内置的 `vi.useFakeTimers()`（先查它在这个版本里对 `setTimeout` + `await` 的行为）。
- **测试不得触网**（现有约定，保持）。
- **危险命令测试禁令（强制）**：任何测试、探针、演示、子代理任务都**禁止在宿主机真实执行可能造成破坏的命令**，包括但不限于：`del /s /q <盘符根>`、`rm -rf /`、`rm -rf ~`、`format`、`diskpart`、`mkfs*`、`dd ... of=/dev/...`、`shutdown`/`reboot`/`poweroff`/`halt`、fork bomb、`reg delete HKLM`、`bcdedit`、`cipher /w`。危险命令测试必须分两层：先断言拦截器识别，再断言底层 `spawn`/`exec` 未被调用。
- **依赖安装禁令（强制）**：禁止执行 `npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`。需要新依赖就把命令写进报告，等用户决定。
- 写文件禁止用 `node -e` / `bash -c` 拼接含反引号、`$()`、`${}` 的文本。
- **不要写用户的真实配置**：任何会用 `HARNESS_HOME` 的测试必须指向临时目录（现有测试都已经是这样，别破坏）。

## 文件所有权

你这轮**独占** `tests/` 与 `vitest.config.ts`、`package.json` 的 `scripts` 段。
**不要碰** `src/`、`mcp-servers/*/` 的生产代码（`mcp-servers/*/tests/` 可以改）、`desktop/`、`docs/`（最后一段除外）。

## 自测（必须贴真实输出）

1. `npm run check:js`
2. `npm test` —— **连跑 3 次**，贴每次的 `Duration` 与通过数
3. `npm run coverage` —— 覆盖率闸门（lines ≥ 85%）必须仍然通过
4. 四个慢文件各自单跑 3 次，贴耗时

## 交付

不要提交。报告：基线 vs 优化后的真实数字（wall time、逐文件耗时）、每项改动对应哪条根因、偶发失败的真实根因分析、**被拒绝的做法与理由**（例如「宿主不可重入所以没复用」）、「需要人看的地方」。
