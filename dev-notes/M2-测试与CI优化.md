# M2 · 测试与 CI 优化

> 阶段：工程效能。起止：2026-11-06。

## 2026-11-06 · 跟踪 CI run 42130273198 并修 `.cjs` 判据回归

**用户关键原话**

- 「你的任务:跟踪刚推上去的 CI 运行,修掉它暴露的问题。」
- 上下文：刚 push 的 `7196338..b666da6` 三个提交改动了 CI——删掉重复的 `npm test`、`check-js-syntax.mjs` 改单进程 `vm.SourceTextModule`、新增 `quick` job、`offline` 精简。

**关键产出**

- CI run `42130273198`（`b666da6`）**首轮全绿**，无失败项：
  - `typecheck + syntax (fast)` / ubuntu-latest / 27s（job 内：checkout 1s、setup-node 7s、npm ci 10s、typecheck 4s、check:js <1s）。
  - `build + test (offline)` / windows-latest / 1m56s（checkout 7s、setup-node 10s、npm ci 11s、build 7s、coverage 74s）。
- **两个高风险点均未触发**：Node 24.22.2 接受 `--disable-warning=ExperimentalWarning`；`vm.SourceTextModule` 在 ubuntu 上可用（check:js 单步 <1s、输出 `38 个文件全部通过`）。
- **覆盖面核对**：CI 显示 `3563 passed | 10 skipped (3573)`，本地 `3568 passed | 5 skipped (3573)`。差 5 例不是覆盖下降——上一轮带 `npm test` 的 run `42043083161` 同样是 `3561 passed | 10 skipped (3571)`，即 CI 一直比本地多 skip 5 例，全部是 `skipIf` 本地资产缺省（`mcp-servers/kb/data/queries.jsonl`、真实 `index.yaml`、`dist-mcp/kb/inbox.js`）。本轮总数因新增 2 条用例变为 3573。Lines 90.92% ≥ 85%。
- **本轮修掉的真实缺陷**（不在原 brief 的三个风险点里，是验证 `vm.SourceTextModule` 时挖出来的）：快路径把**所有**文件按 ESM 解析，包括 `.cjs`。CJS/ESM 语法规则在两个方向相反：
  - 顶层 `await`（ESM 合法 / CJS 非法）：旧 `node --check` 报错，新快路径**静默放过** —— 漏报；
  - 顶层 `return`（CJS 合法 / ESM 非法）：旧路径放过，新快路径**误报** `Illegal return statement`。
  - 受影响文件是 `desktop/preload.cjs`（Electron 预加载桥）——正是这个脚本存在的理由。
  - `vm.Script` 不能兜底：它按裸脚本编译，顶层 `return` 同样判非法，只有 `node --check` 按 CJS 包装函数解析。
  - 修法：`checkFile` 对 `.cjs` 不走快路径，仍走 `node --check`（一次进程启动，38 个文件里只有 1 个）。`.js`/`.mjs` 走 ESM 快路径有依据：仓库根与 `desktop/package.json` 都是 `"type": "module"`，这两个根下没有 CJS 的 `.js`。
- **测试**：新增 2 条用例（`tests/check-js-syntax.test.ts` 6 → 8）。关键点：vitest 里 `vm.SourceTextModule` 是 `undefined`，直接调 `checkRoots` 只走回退分支，证明不了快路径；因此第二条用例起带 `--experimental-vm-modules` 的子进程强制走快路径。
- **RED 证据**：临时把 `.cjs` 条件去掉后，子进程用例变红 `expected [ 'top-level-return.cjs' ] to strictly equal [ 'top-level-await.cjs' ]`，两个方向的判错都被复现。恢复后 8/8 绿。
- 提交 `941ff3a fix(scripts): .cjs 语法检查改回 node --check 的 CJS 判据`，已推 main。
- 新 CI run `42134802847`（`941ff3a`）**全绿**：quick 20s（较上轮 27s 快 7s，因 Ubuntu npm 缓存已建立），offline 1m35s（较上轮 1m56s 快 21s）。`Tests 3563 passed | 10 skipped (3573)`，Lines 90.92%。

**本地验证真实输出**

- `npm run check:js` → `check-js-syntax: 38 个文件全部通过`，exit 0，1.4s。
- `npm run coverage` → `Tests 3568 passed | 5 skipped (3573)`，`Lines 90.92% ( 6585/7242 )`，exit 0。
- `npx vitest run tests/check-js-syntax.test.ts` → `8 passed (8)`。
- `npm run typecheck` → exit 0。

**被拒绝或纠偏的内容**

- 没有为「保持数字一致」去改 skip 条件或补假语料：CI 少跑的 5 例是设计好的本地资产缺省，上一轮同样如此，不是本轮引入。
- 没有为了跑快路径而给 vitest 加 `--experimental-vm-modules`：那会改变整个测试运行时的语义，超出本任务范围；改用子进程隔离。
- 没有把 `.cjs` 也交给 `vm.Script`：实测它顶层 `return` 同样判非法，与 CJS 不等价。
- 没有动 `--disable-warning=ExperimentalWarning`：Node 24.22.2 与本地 24.14.1 都接受，无证据需要改。

**翻车与返工**

- 第一次写 `.cjs` 回归用例时直接调 `checkRoots`，以为能覆盖快路径；实测 vitest 里 `vm.SourceTextModule` 为 `undefined`，用例只走到回退分支，把修复回滚后**依然全绿**——假绿。补了子进程用例后才有真实的 RED。
- 提交信息第一次用 `@'...'@` here-string 写进 bash，被当成普通文本，subject 变成 `@ fix(...)` 且结尾多一个 `@`。用 `git commit --amend -F <file>` 修正。

**未做 / 没验证到的（如实留白）**

- 未在旧 Node（<24）上验证 `.cjs` 判据；`engines` 已声明 `>=24`。
- 未验证 `.js` 在「无 `"type": "module"` 的嵌套目录」下的语义。当前两个根下没有这种目录，将来若新增需重判。
- 分支保护仍要求状态检查 `typecheck + build + test (offline)`（拆分前的旧 job 名），而实际上报的是 `typecheck + syntax (fast)` 与 `build + test (offline)`。direct push 到 main 不受影响（PR 分支保护需要 PR），但**开 PR 会被卡在「expected」**。这是仓库设置，未擅自修改。

## 2026-11-07 · 覆盖率口径收窄（BACKLOG 4.4 / OPT-26）+ T-035 断言（4.6）

**用户关键原话**
- 「跑一次 coverage 看真实数字」
- 「按推荐发子代理」（推荐 = keil/serial 只登记不设闸门）

**关键产出**
- **覆盖率实测三档**（lines，按最终文件选择规则复跑三次一致）：
  - `src/**` 单独 → 90.99%（6837/7514）
  - `src/**` + 全部 `mcp-servers/**` → 78.43%（9979/12722），距 85% 差 835 行
  - `src/**` + `kb`/`datasheet`/`probe` → **90.15%（8778/9737）**，通过
- `vitest.config.ts`：`include` 改为上述三块，新增 `exclude: ['**/tests/**']`；阈值 85% **未动**。注释写明排除理由与每块 covered/total。
- `tests/desktop/serial-dropped.test.js`（B 代理）：2 条静态断言钉住 T-035 的赋值语义。
- 文档同步：`docs/BACKLOG.md`（4.4 / 4.6 标完成，附实测数据表）、`docs/ledgers/deferred-issues.md`（D-157 补「覆盖率数字不构成已验证证据」）、`docs/ledgers/optimization-and-new-features.md`（OPT-25 / OPT-26 状态）、`AGENTS.md` 与 `README.md`（覆盖率口径与 `check:docs` / `verify`）。

**被拒绝或纠偏的内容**
- **没有把阈值降到 78% 去容纳 keil/serial**：那是把「测不了」写成「合格」。改为口径收窄 + 如实登记缺口。
- **没有给 keil/serial 单独设低阈值**：低阈值容易被后人当成「达标」，比不设更糟。
- 子代理 A 建议按它的数字改注释，我复核后**同时保留了两套分母的解释**——它用 `mcp-servers/**`（12734 行，含 4 个 3 行 `.json`），我用 `**/*.ts`（12722 行）。覆盖行数相同（9979），差异纯在分母口径。最终统一为配置实际使用的 `**/*.ts` 口径。

**翻车与返工**
- **我先前的数字是错的**：报给子代理的 kb 90.61% / datasheet 92.55% / probe 81.03% 是在**未排除 `**/tests/**`** 的口径下测的。排除测试夹具后真实值是 91.30% / 93.18% / 81.28%。子代理指出偏差后我复测确认——**它是对的**。教训：给子代理的 brief 里写「实测数字」时，必须先确认那个数字和最终配置是同一条文件选择规则，否则差异会被当成测量误差传下去。
- 全量纳入口径的全模板 `mcp-servers/**` 会把 `.json` 也算进分母（4 个文件 12 行），产生 12734 vs 12722 的差异。已改为只取 `**/*.ts`。
- 第一次在子代理 brief 里写「`src/**` + 全部 `mcp-servers/**` = 78.49%，差 829 行」；按最终规则复算是 78.43% / 835 行。已全部改正并留下 covered/total 便于复核。

**验证（真实输出）**
- `npm run coverage` → exit 0，Lines 90.15%（8778/9737），无 "does not meet" 错误；表中无 keil / serial / embedded 模块行，无 `fixtures.ts`。
- 注入 `+=` 后 `npx vitest run tests/desktop/serial-dropped.test.js` → 1 failed（`expected '+=' to be '='`）；还原后 2 passed，`git diff desktop/renderer/app.js` 为空。
- `npm run verify` → check:js 40 文件、check:docs 177 文档/96 链接、`3789 passed | 5 skipped`。
