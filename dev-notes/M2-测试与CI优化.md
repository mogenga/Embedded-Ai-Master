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

## 2026-11-07 · 台账状态守护（BACKLOG 4.5）

**用户关键原话**
- 「Build an automated guard that detects **internal contradictions in the ledger documents** — the class of bug that was found by hand on 2026-11-07 and fixed in commit `c8948a3`.」
- 约束原话：「A check that always passes is worse than no check — it manufactures false confidence.」，以及「**Prove it goes red.**」与「**Measure false positives on the CURRENT tree.**」

**关键产出**
- `scripts/check-ledger-status.mjs`（+ `scripts/check-ledger-status.d.mts`）。扫 `docs/ledgers/*.md`，报两类**台账内部**矛盾：
  1. **顶部注记 vs 状态行**：条目带有 `> **YYYY-MM-DD 复核：…**` / `> **YYYY-MM-DD 已解决**：…` 注记，注记里写 已解决 / 已作废 / 已失效 / 已把决定用断言钉住，而该条 `- **状态**:` 仍以 未解决 / 仍未解决 / 待修 / 未修 开头。
  2. **状态行自相矛盾**：同一条状态块（状态行 + 缩进续行）里前后判词相反——「未解决…已解决」或「已解决…仍未解决」。
  输出沿用 `check-doc-links.mjs` 的约定：`walk` + 同一份 `SKIP_DIRS`、中文摘要行 `check-ledger-status: N 个台账、M 条状态行，无自相矛盾`、有命中时 `file:line id [rule] detail` 逐条点名，exit 1 / 0。
- 接线：`package.json` 新增 `check:ledgers`，并插进 `verify`（typecheck → check:js → check:docs → check:ledgers → test）；`.github/workflows/ci.yml` 的 quick job 在 `check:docs` 之后加同名 step。
- `tests/check-ledger-status.test.ts`（26 条）：合成夹具覆盖每种必须抓的形状与每种不得误报的形状；另从 `9c2166e:docs/deferred-issues.md` **原样抄下** D-134 / D-189 / D-193 / D-224 / D-202~205 的条目文本作为真实历史夹具，注释标明出处与提交。
- `docs/BACKLOG.md` 4.5 标完成并写明实际检查范围与边界。

**检查范围（明确写了不做什么）**
- 脚本头注释与 BACKLOG 都写明：**只台账内部一致**，不读 `src/` / `desktop/`，因此**无法**判断状态对代码是否为真。绿色只意味着「没有条目自相矛盾」。
- 这条边界在测试里也被钉住：D-134 与 D-189 的历史片段**断言零命中**，注释说明它们属于「状态行 vs 代码」的矛盾，`c8948a3` 靠读 `host.js` / `query.ts` 才发现，本脚本按设计抓不到。

**历史命中数（我自己测的，不是转述）**
- 对 `git show 9c2166e:docs/deferred-issues.md` 抽出的 2465 行文件跑：**6 处**，exit 1。全部是规则 1（顶部注记 vs 状态行）：
  - `D-193`（第 1607 行，注记「本条已失效」+ 状态行「未解决（已登记）」）
  - `D-202` / `D-203` / `D-204` / `D-205`（第 1973 / 1984 / 1995 / 2006 行，注记「已作废」+ 状态行「未解决。」）
  - `D-224`（第 2340 行，注记「2026-11-06 已解决」+ 状态行「未解决（既有行为，本批次未改）」）
- **任务 brief 里给的清单我没照抄，是自己跑出来的**。核对结果：brief 列的 D-134 / D-189 与 D-221 **不在命中里**，原因见上「范围」——它们的矛盾对象是代码，不是正文。brief 列的 D-193 / D-202 / D-203 / D-204 / D-205 / D-224 **全部命中**。另有一条 `9c2166e` 里已带注记但不是矛盾的（D-212「两半都已落地」但明说「一次真实更新从未跑过」），按设计不报。

**当前树命中数**
- `node scripts/check-ledger-status.mjs` → `4 个台账、247 条状态行，无自相矛盾`，exit 0。**零命中**，因为 `c8948a3` 已把那 6 条的状态行改对。
- 没有发现新的遗留矛盾。台账内容一行未改。

**误报分析（逐条核对过的合法形状）**
- **`部分解决`**：D-003 / D-005 / T-040 的形状是「开头就写明只完成一部分 + 后面列剩下的」。规则只在**开头是绝对判词**（未解决/已解决）时才判矛盾，且反证前若出现 `部分 / 大部分 / 前两项 / 第 N 项 / ①②③` 就按子项口径放过。
- **引用别的条目**：`未解决；与 D-134 同根因（D-134 已解决）` 说的是另一条。两条豁免：直角引号/括注内的内容算引用；标记前 16 字符里紧贴 `D-xxx` 编号的也算引用。
- **引用旧状态**：D-224 修好后的写法 `（原始记录：「未解决（既有行为）」是修复前写下的。）`。含 `原始记录 / 原始状态 / 原记录 / 原状态 / 修复前 / 此前 / 历史` 的括注算引用；`**原始状态**：仍未解决` 这种不带括号的，看标记前缀。
- **`已作废` / `已失效` 不算与 `未解决` 反证**：台账惯例是「先说本轮未解决，再说对象已随某次删除作废」。这两词是历史终止而不是另一种并存的判词，报它会把 6 条历史条目里的 D-134 一族（`状态行内部`）全变成误报。**这是本轮唯一一处放宽度**：如果将来出现「已作废 + 已解决」并列，会漏报——判断依据是这两词在台账里从来没有和「已解决」混用过。
- **CRLF**：`embedded-defects-todolist.md` 是 CRLF。第一版没归一化换行，`.*$` 匹配不到 `\r` 结尾的行，**20 条状态行整批消失**，表现为「零命中」——正是脚本最不该有的假绿。已加 `.replace(/\r\n?/g, "\n")`，并补了一条测试断言该文件的 `statusLines === 20`。
- **规则 1 的已知残留风险（今天没有实例）**：注记只要提到 已解决 / 已作废 / 已失效 / 已把决定用断言钉住 就算「已了结」，不看它是否只覆盖某个子项。因此「注记说 X 子项已解决、状态行说主项未解决」这种合法写法会被误报。当前四个台账里没有这个形状（逐条核过 11 个同时含两组词的串块，全部是引用旧状态、子项口径或 `已作废` 终止）。若将来出现，先判断它是误报还是真矛盾，再决定是否要收窄——不要直接把条目改掉。
- **当今树的全量核对**：把四个台账里**同时**出现「未解决/仍未解决/未修/待修」与「已解决/已作废/已失效/已修复/已把决定用断言钉住」的状态块全部列出来（11 处），逐条确认本脚本的处理正确：6 处是「未解决 + 已作废」（按 2.c 放过）、1 处是 D-134 的「桌面宿主侧已解决 / 内核侧仍未解决」（合法的分侧口径，开头不是绝对判词）、1 处是 D-221 的「前两项已解决」（子项口径）、1 处是「已知限制…未修复…已作废」、2 处是「已解决 + 引号里的旧状态」（`「待修」` / `「未解决（既有行为）」`）。**没有一处需要放过但会误报，也没有一处应该报却放过。**

**被拒绝或纠偏的内容**
- 拒绝把「顶部注记提到已解决，状态行仍写未解决」以外的形状扩大成宽泛的关键词扫描。第一版试过「状态块里出现任何已解决即命中」，实测在当前树上就有假阳性（D-005 的 `**仍未解决**的是「冷启动」` 是合法的分项说明），最终收窄为「只在开头判词与后续强反证之间判矛盾」。
- 没有为了让 D-134 / D-189 变成命中而去改规则。它们是「状态行 vs 代码」的矛盾，任何基于台账文本的规则都只能靠猜，猜出来的是假阳性。选择在脚本头、BACKLOG 和测试注释三处把边界写清楚。
- 没有在 `checkText` 里对「已解决开头」跳过规则 2。第一版写了 `if (resolved === undefined) continue;`，结果 D-901 形状（已解决…仍未解决）漏报；测试的自查发现后改成两个方向都判。

**翻车与返工**
- 第一版把整行（含 `- **状态**: ` 前缀）当判词正文传给 `contradictionOf`，于是 `startsWith("未解决")` 恒 false——历史文件「零命中」，看起来像「历史数据是干净的」。是手工跑第二遍才发现的：把正文剥出来之后立刻变成 6 条。**这个 bug 的形状就是假绿本身**，写进了测试（每条命中用例都断言 `detail` 里出现具体判词，而不只是 `problems.length > 0`）。
- 第一版 `checkPaths` 忽略命令行参数，对着 `9c2166e` 的文件跑实际扫的是 `docs/ledgers/`。加了路径参数（默认仍是 `docs/ledgers`）。
- 两处历史夹具的行号预期写错了（D-193 期望 9 实际 8，D-224 期望 10 实际 9），是目数行数时把手写夹具的头部行算多了。按真实夹具重算。

**RED 证据（每种形状都真跑过）**
- 形状 1（顶部注记 vs 状态行）：把当前树 D-193 的状态行改回 `未解决（已登记）。` 后 `node scripts/check-ledger-status.mjs .tmp/red-topnote.md` → exit 1，`check-ledger-status: 1 处状态自相矛盾（共 227 条状态行）` / `…:1609 D-193 [top-note] 第 1601 行注记写「**2026-11-06 复核：本条已失效。** …」，状态行仍以「未解决」开头`。还原后零命中。
- 形状 2a（未解决…已解决）：`.tmp/red-statusline.md` → exit 1，`D-900 [status-line] 状态行以「未解决」开头，后面又写「已解决」`。
- 形状 2b（已解决…仍未解决）：同一夹具 → `D-901 [status-line] 状态行以「已解决」开头，后面又写「仍未解决」`。
- 同夹具里的 D-902（`部分解决`）与 D-903（引用 D-134）**未被点名**——误报豁免在同一份夹具里被同时验证。

**验证（真实输出）**
- `node scripts/check-ledger-status.mjs` → `check-ledger-status: 4 个台账、247 条状态行，无自相矛盾`，exit 0。
- `node scripts/check-ledger-status.mjs .tmp/ledger-hist/deferred-issues.md`（`9c2166e` 抽取件）→ `6 处状态自相矛盾（共 227 条状态行）`，exit 1。
- `npx vitest run tests/check-ledger-status.test.ts` → `26 passed (26)`。
- `npm run typecheck` → exit 0；`npm run check:js` → `41 个文件全部通过`（新增的 `.mjs` + `.d.mts` 也在内）。
- `npm run check:docs` → 通过（BACKLOG / dev-notes 的新增引用都能解析）。
- `npm run verify` → exit 0，见下方命令输出。

**主代理复核（2026-11-07，不采信代理自述）**

- 亲自跑 `node scripts/check-ledger-status.mjs` → exit 0，4 个台账 / 247 条状态行 / 零命中。
- 亲自抽取 `git show 9c2166e:docs/deferred-issues.md` 跑检查器 → **6 处命中**，exit 1，与代理报告的条目一致（D-193 / D-202 / D-203 / D-204 / D-205 / D-224）。
- **核实了它对 brief 的纠正**：我在 brief 里要求抓到 D-134 / D-189，实测修复前这两条**没有顶部注记**，状态行原文就是 `未解决;…` / `未解决（已登记；…）`——矛盾在「状态行 vs 代码」，文本规则抓不到。**代理是对的，我的 brief 错了。** 它没有为迎合 brief 去加规则，而是把边界写进脚本头、BACKLOG、CI 注释、测试头四处。
- 亲自跑 `npx vitest run tests/check-ledger-status.test.ts` → 26 passed；`npm run verify` → exit 0（check:js 41 文件、check:docs 97 链接、check:ledgers 绿、3815 passed / 5 skipped）。
- 读过两个「假绿」的测试钉子：每条命中用例都断言 `detail` 含具体判词（不只是 `problems.length > 0`），CRLF 用例断言 `statusLines === 20`。这两条正好对应代理自述的两次翻车，是把教训钉住了，不是口头承诺。
- 唯一声明的松化（`已作废`/`已失效` 不算与 `未解决` 反证）我接受：当前台账里没有「已作废 + 已解决」并列的实例，预先猜形状只会引入假阳性。

**同步的文档**
- `AGENTS.md`：静态检查段补 `check:ledgers`；`verify` 补全五项；新增一段写死能力边界（绿灯 ≠ 状态准确）。
- `README.md`：命令表补 `check:ledgers`，`verify` 说明改为「上面五项」。
- `docs/BACKLOG.md`：4.5 标完成并写明两类检查与边界。
