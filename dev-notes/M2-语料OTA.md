# M2 · 语料 OTA

> 增量追记，每完成一个阶段补一段。契约源：`docs/corpus-ota.md`；计划：`docs/superpowers/plans/2026-10-23-corpus-ota.md`。

## 2026-10-23 定案与首轮派发

**用户关键原话**
- 「语料库迁移至VPS。风险问题：VPS的IP、用户名和密码不能上传，如何保证用户安装系统后可以调用到VPS的语料库。」
- 「初版语料随安装包发；OTA做更新。这个方案可以吗」
- 「安装包是公开的」
- 「启动时静默检查 + 提示，不走superpowers」
- 「保留公钥。分发子代理推进，不走superpowers。需要我操作的发给我。不得执行git提交」
- 「A；建配置文件；传测试文件；之前未完成的继续派发子代理，不得提交」（A = 保留 electron-builder 安装）

**被拒绝或纠偏的内容**
- 初版方案考虑过 Cloudflare Tunnel / VPS 自建静态站，用户最终选 OBS。因安装包公开 → 语料公开 → OTA 无需鉴权，VPS 的 IP/用户名/密码问题从根上消失，不是被隐藏。
- 我最初把「隐藏 IP」讲成安全控制，被自己纠正为：IP 是寻址必需，能做的只是不进仓库/不进安装包；DNS 解析公开，隐藏最多是加固。
- 用户否掉了「语料全靠 OTA」形态，改为「初版随包 + OTA 更新」。

**关键产出**
- `docs/corpus-ota.md` —— 接口契约（唯一格式源）。
- `docs/superpowers/plans/2026-10-23-corpus-ota.md` —— T1–T10 依赖图。
- `config/corpus.local.json` —— 真实桶地址与公钥，已被 `.gitignore` 忽略。
- `.gitignore` 补 17 类密钥/证书规则（`*.pem` / `*.key` / `id_ed25519` 等）。

**翻车与返工**

1. **首轮 5 个子代理全部因 API 连接错误（ECONNREFUSED）中断**。落盘的只有 T1（配置层）与 T3（快照指针）：
   - T1：`src/config/corpus-config.ts` + `tests/corpus-config.test.ts`，11 用例通过。
   - T3：`src/corpus/snapshot.ts` + `tests/corpus-snapshot.test.ts`，31 用例通过。
   - T2 / T4 / T8 未落盘，重新派发。T8 留下探针文件 `.tmp-probe-defaultapp.mjs`，要求其清理。

2. **依赖安装禁令事故（第二次）**：某子代理执行了 `npm install`，`package.json` 与 `package-lock.json` 被改动，`node_modules/electron-builder/` 已存在。派发 brief 中明确禁止该命令，属子代理未遵守。
   - **用户决定：保留（选项 A）**。理由是 T10 打包确实需要 electron-builder，且已装好。
   - 未撤销：`package.json` 的 `electron-builder: ^26.15.3` 与 lock 变更保留在worktree中，未提交。
   - 教训：brief 里的禁令不足以约束子代理；后续若再遇同类事件，应考虑在派发前把需要的依赖一次性列给用户、由用户装完再派发，避免子代理有动机自己装。

3. **`npx tsc --noEmit` 有 7 个错误**，全部位于 `mcp-servers/cubeide/tests/cubeide.test.ts`、`mcp-servers/keil/tests/*.test.ts`（含 `node:expat` 模块缺失）。这些文件在工作区**未修改**，属 HEAD 上的既有问题，与语料 OTA 无关，本次不顺手修。

**实测结论（不能凭记忆断言的部分）**
- Windows 上覆盖 junction 必须「先停放旧链接再 rename」，直接 rename 覆盖既有 junction 会报 EPERM（T3 子代理实测确认，禁用该回退路径可复现）。

**用户提供的资产**
- OBS 终端节点：`obs.cn-east-3.myhuaweicloud.com`
- 访问域名：`embedded-ai-master-kb.obs.cn-east-3.myhuaweicloud.com`（不绑自定义域名）
- Ed25519 公钥（SPKI base64）：`MCowBQYDK2VwAyEAtxuwkiAsf7RXEkOHYkm0s1M/1qN2xNiwPhGxnRHdr+U=`
- 私钥由用户在本机离线保管，未进入仓库。

## 2026-10-23 T4：`_inbox.md` 移出受管集合

**用户关键原话**
- 「`kb_propose` 把提案写到 `<KB 根>/_inbox.md`，而 `_inbox.md` 是语料 `manifest.sha256` 的第一行——**OTA 换快照会冲掉用户的沉淀提案**，或者反过来让新快照校验失败。这是会造成用户数据丢失的设计缺陷。」
- 「不传时保持现有行为。向后兼容是硬要求——`scripts/kb-regression.mjs`、既有测试与已部署配置都依赖当前行为。」
- 「想清楚你的取舍：是让 inbox 不可经 `kb_read` 读取（可接受，因为它是待审区），还是放宽校验（**不要**放宽成任意路径可读）。」

**关键产出**
- `mcp-servers/kb/inbox.ts`：新增 `defaultInboxFile(root)`、`MANAGED_CORPUS_EXCLUDES`（`_inbox.md` 第一项 + `_reviewed.md`），以及按文件路径操作的一组变体 `appendProposalTo` / `removeProposalFrom` / `appendReviewedTo`。原有的 `appendProposal(root, …)` / `removeProposal(root, id)` / `appendReviewed(root, entry)` 全部保留，转为默认位置的薄封装——调用签名与行为逐字不变，`scripts/kb-regression.mjs` 与既有测试无需改动。
- `mcp-servers/kb/service.ts`：`KbServiceOptions.inboxPath`（可选，不传即老行为）；`KbService.inboxPath` / `inboxLabel()`；`KbStatus` 新增必填 `inboxPath` 与 `inboxExternal`；`status()` 的读取位置改为 `this.inboxFile`。
- `mcp-servers/kb/tools.ts`：`kb_propose` 改写 `appendProposalTo(service.inboxPath, …)`，回报 `service.inboxLabel()`；`kb_propose` / `kb_status` 的描述补上 `inboxPath` / `inboxExternal`。
- `mcp-servers/kb/server.ts`：新增 `resolveKbInboxPath()` 与环境变量 `KB_INBOX_PATH`，由 `createKbService` 接线——否则 `inboxPath` 只有测试能用，真实 server 进程永远写不出去。
- `scripts/kb-review.mjs`：新增可选 `--inbox <路径>`，回退到 `KB_INBOX_PATH`，再回退到 `<KB 根>/_inbox.md`；`removeProposal` / `appendReviewed` / `appendProposal` 全部换成路径变体，审核记录跟着 inbox 走（`_reviewed.md` 与 inbox 同目录）。现有调用方式（无 `--inbox`）逐字不变。
- 测试：新增 `mcp-servers/kb/tests/kb-inbox-location.test.ts`（10 例）；`kb-tools.test.ts` 补 `KB_INBOX_PATH` 3 例；`kb-review-script.test.ts` 补 `--inbox` / 环境变量 / 向后兼容 3 例；`service.test.ts` 两处 `toEqual` 全量形状断言补上新增字段。

**`isWithin` 的取舍（按要求明写）**
- **选择：外部 inbox 不经 `kb_read` 暴露。** 不改 `resolveRelative` 的 `isWithin(this.root, real)`，在代码注释里写明理由。
- 理由：`kb_read` 的返回值原样进模型上下文并被标成 `reviewStatus: reviewed`。为读自家待审 inbox 而开一个「根外路径也可读」的口子，等于把 `kb_read` 变成任意文件读取；而 inbox 本来就是待审区，读不到不损失任何审核能力——`kb-review.mjs` 直接按 `KbService.inboxPath` 同一位置读文件，人工流程不受影响。
- 已用测试钉住：`service.read(外部绝对路径)` 抛 `path_denied`；`service.read('_inbox.md')` 在外部形态下抛「不存在」（根内确实没有这个文件）。

**向后兼容的处理方式**
- 不传 `inboxPath`（且不设 `KB_INBOX_PATH`）时：写 `<root>/_inbox.md`，`kb_propose` 回报 `inboxPath: "_inbox.md"`，`kb_status` 报 `inboxPath: "_inbox.md"` / `inboxExternal: false`。既有用例除两处全量形状断言外零改动。
- `kb_status` 新增的两个字段是**必填**而非可选：形状断言能持续覆盖它们；可选字段会让「忘了接线」静默通过。
- `inboxPath` 显式指向语料根内时按根内处理（`inboxExternal: false`，报相对路径）——位置语义跟着实际所在，不跟着参数是否传了。

**明确没做的事**
- 未改 `mcp-servers/kb/kb/manifest.sha256`（本地语料，已 gitignore）。
- 未生成 manifest，只提供 `MANAGED_CORPUS_EXCLUDES` 常量供 T9 与 manifest 生成使用。
- `NAVIGATION_FILES` 与 `kb_lookup` / `kb_search` / `kb_grep` / `kb_glob` 的排除逻辑一字未动。

**验证（实跑输出）**
- `npm run typecheck`：7 个错误，全部在 `mcp-servers/cubeide/tests/cubeide.test.ts` 与 `mcp-servers/keil/tests/*.test.ts`，与改动前同一批（未修）。过程中新测试自己引入过 2 个类型错误（`process.env` 展开后的 `delete` 与隐式 `any`），已修掉。
- `npx vitest run mcp-servers/kb`：9 files / **157 passed**。
- `npm run test:mcp`：26 files / **431 passed**。
- `npx vitest run`（全量）：95 files / **2693 passed / 4 skipped**。4 条 skip 均为既有条件跳过（live 网关 1 条、`tests/desktop/host.test.js` 依赖未编译产物 3 条），与本次改动无关。
- `npm run build:mcp`：通过。
- `npm run kb:regression`：**未 skip**，本地语料存在（108 md / 90 index entries / 80 查询 + 25 负样本）。指标 `Recall@2 0.4400 / Hit@1 0.3800 / MRR 0.4100 / search Hit@1 0.1333 / goldInTop20 0.4333 / refusalRate 0.8400`，与 `tests/regression-baseline.json` 逐项一致——说明默认路径下检索语义未被本次改动触碰。

**翻车与返工**
1. 第一版 `appendProposalTo` / `appendReviewedTo` 里加了 `mkdirSync(dirname, { recursive: true })`，想「顺手」避免外部 inbox 首次写入 ENOENT。随即发现这会破坏既有语义：`kb-propose.test.ts` 的「写入失败显式返回 `proposal_failed`」正是靠父目录不存在触发 ENOENT；自动补目录会把「路径配错」伪装成写入成功（R3）。已撤销，并在注释里写明目录应由部署层（快照种子化）负责。
2. `status()` 新增必填字段后，`service.test.ts` 两处 `toEqual` 全量形状断言先红。这不是回归，是断言在正确工作——补上字段而不是改成 `toMatchObject` 弱化它。

## 2026-10-23 T8 host 路径（重新派发落盘）

**用户关键原话**
- 「`desktop/host/host.js:32` 用 `const repoRoot = path.resolve(here, "..", "..")` 推断仓库根…用 electron-builder 打包后目录布局会变…该推断失效」
- 「**先读它、用它跑一次实测**，确认 `ELECTRON_RUN_AS_NODE` 子进程里 `process.resourcesPath` 是否可见」
- 「**跑完探针后删除 `.tmp-probe-defaultapp.mjs`**——不要留在仓库里」
- 「如果导出会破坏宿主「单入口脚本」的性质…用条件导出或独立模块，**不要改变运行方式**」
- 「禁止以任何方式改动 `package.json`、`package-lock.json`、`node_modules/`」

**关键产出**
- 新增 `desktop/host/roots.js`：`resolveRoots({ here, resourcesPath, env })` + `kernelMissingMessage(form, entry)`，纯函数、无副作用，可独立 import，不改宿主运行方式。
  - 返回值命名 `distParent` 而非 `repoRoot`——它要的是「`dist/` 的父目录」，开发形态是仓库根、打包形态是 `resources/`，二者只是碰巧在开发形态重合。
  - 判定顺序：`HARNESS_KERNEL_ROOT`（新增，操作员显式指定）→ `HARNESS_RESOURCES_PATH`（主进程传入）→ `path.resolve(here, "..", "..")`。
  - 空白值一律视同未设置，避免 `HARNESS_KERNEL_ROOT=""` 把根解析成进程 cwd。
- `desktop/host/host.js`：`dist()` 改从 `roots.distDir` 取；保留 `pathToFileURL` 转换（Windows 盘符会被当协议名）；启动早期 `existsSync(roots.entry)` 不通过即 `fatal` 并以 1 退出；`repoRoot` 改为 `roots.distParent` 供 `getKb` 用。
- `desktop/main.js`：`spawn` 时仅在 `app.isPackaged` 时传 `HARNESS_RESOURCES_PATH: process.resourcesPath`。
- 新增 `tests/desktop/host-roots.test.js`（8 用例）：5 个纯函数用例（含覆盖优先级、空白值、三形态措辞）+ 3 个起真实宿主进程的用例（缺内核发 fatal 且退出码 1、打包形态措辞、覆盖生效时能加载）。

**实测结论（本任务最需要实证的一点）**
- 探针 `.tmp-probe-defaultapp.mjs` 在 `ELECTRON_RUN_AS_NODE=1` 下的真实输出（electron 44.9.1）：
  `{"defaultApp":null,"resourcesPath":"E:\\...\\desktop\\node_modules\\electron\\dist\\resources","execPath":"E:\\...\\electron.exe","electron":"44.9.1"}`
- 结论 1：`process.resourcesPath` **可见**（非 undefined），`process.defaultApp` 为 `null`。
- 结论 2（决定性）：这个可见值指向 **Electron 自己的** `dist/resources`（内容只有 `default_app.asar`，无 `dist/`），不是本应用的 `resources/`。所以「是否可见」不足以判断打包形态——若宿主直接读它，开发形态每次都会走打包分支、报「请重新安装」。因此改由 `main.js` 按 `app.isPackaged` 决定是否传入，宿主绝不 `import("electron")`。
- 探针已删除，`git status` 中不再出现。

**被拒绝或纠偏的内容**
- 一度写下 `HARNESS_KERNEL_DEV` 反向标记，随即删除：用「只在打包时传 resourcesPath」表达同一事实，少一个状态变量、少一处可能不一致。
- 首版 `exitAfterFlush` 写成同步函数、在回调里 `process.exit`。实测指出问题：`process.exit` 在写回调里执行属于后续事件循环轮次，同步返回会让模块继续往下 import 一个刚被判定缺失的 `dist/`。改为返回永不 resolve 的 Promise，调用处 `await`，用顶层 await 停住文件其余部分；同一问题也顺手修了既有的「内核未构建」分支（原来 `fatal()` 后直接 `process.exit(1)`，管道写可能被截断）。
- 新测试首版起宿主时没设 `HARNESS_HOME`/`AGENTS_HOME`，会读真实 `~/.harness`。虽单看断言无碍，但与 `host.test.js` 的隔离规则相悖，已补齐。

**翻车与返工**
- 上一轮同一任务因 API 连接错误中断，未落盘，只留下探针文件；本轮先读探针、跑实测、再删除。
- `npm run test:desktop` 未因缺 `dist/` 失败（工作区已有构建），无需先 `npm run build`。
- `npm run typecheck` 仍是 7 个既有错误，全在 `mcp-servers/cubeide`、`mcp-servers/keil` 的测试文件；`desktop/` 为纯 JS 不进 tsconfig（`include: ["src","tests","mcp-servers"]`），本轮 0 新增。

---

## T9 发布脚本（2026-10-23）

**用户关键原话**
- 「这是一个**纯 Node ESM 脚本**（`.mjs`，不是 TypeScript）……从 `dist/` 里导入已编译的 `src/corpus/manifest.js`」
- 「**不要跳过这一步**——发布脚本生成一份客户端必然拒绝的清单是最坏情况」
- 「任何情况下**不得**把私钥内容打印到 stdout/stderr」
- 「把核心逻辑抽成可导入函数再单测（**推荐后者**，子进程测试慢且难定位）」

**关键产出**
- `scripts/corpus-publish-lib.mjs`（新）：`publishCorpus(options)` 核心逻辑，`manifestApi` 由调用方注入——单测传 `src/`、CLI 传 `dist/`，发布与验证因此不可能各跑一套实现。
- `scripts/corpus-publish.mjs`（新）：只做参数解析、读私钥、打印上传指引，风格跟随 `kb-review.mjs`（`fail()` + `process.exitCode`、未知参数 exit 2）。
- `tests/corpus-publish.test.js`（新，15 用例）：10 个直接单测 + 5 个 CLI 子进程用例（缺参/坏 version/私钥缺失/私钥不外泄/坏私钥）。
- 排除名单从 `dist-mcp/kb/inbox.js` 的 `MANAGED_CORPUS_EXCLUDES` 动态取，不在脚本里抄第二份。
- 实测（真实 CLI + 临时密钥 + 临时语料）：`corpusVersion=5`、3 文件、`_inbox.md` 被跳过且未复制进输出；用 `dist/corpus/manifest.js` 独立复核：`parseManifest` OK、正确公钥验签 true、错误公钥 false、篡改 `corpusVersion` 后 false、三个文件 sha256 全部 MATCH、清单顺序 `getting-started.md, index.yaml, protocols/uart/no-output.md`（字典序）。
- 同一 `--out` 连跑两次成功，清单未被上一次产物污染。
- `npm test` 96 文件 / 2708 通过 4 跳过；`npm run typecheck` 仍只有 7 个既有错误（`cubeide`/`keil` 测试），0 新增——`.mjs`/`.js` 不进 tsconfig 的 `include`。

**被拒绝或纠偏的内容**
- 一度让 `collectFiles` 静默跳过指向目录的符号链接，自查后改为**显式报错**：静默跳过会让文件从清单里无声消失，用户只会发现「更新后少了几篇」，而发布侧一切正常。跟随目录链接同样拒绝（要处理环，且会把语料根之外的内容写进签名清单）。
- 自校验里额外加了一条 `canonicalize(reparsed) === canonicalize(manifest)`：`parseManifest` 只保证结构与 `signature` 合法，不保证「写盘字节 ↔ 被签字节」一致，补这条才真正覆盖落盘往返。
- `--version` 的初版正则允许负数（`/^-?\d+$/`），会让 `-1` 走到较晚的通用报错；改为 `/^\d+$/` + `>= 1` 前置判定，报错能直接指出是哪一项。

**翻车与返工**
- 首次冒烟脚本里误写了一个返回空串的辅助函数，导致 `createPublicKey('')` 抛 `ERR_OSSL_UNSUPPORTED`。那是核对脚本自身的笔误，与产品代码无关；删掉后重跑全绿。教训：核对脚本也要写得像核对脚本，不能夹带临时拼凑的表达式。
- 冒烟临时目录已全部删除，`git status` 只多出三份预期新文件；`package.json`/`package-lock.json` 的改动是本任务之前既有的（`electron-builder`，T10 前置），本轮未触碰。

---

## T7 设置页（2026-10-23）

**用户关键原话**
- 「入口放在知识库页（`settings.js:316` 的 `buildKbPage`），加一行/一个区块；**不做独立页面**」
- 「设置页打开时不要主动再检查更新。启动时静默检查（已有设计），页面只展示 `readCorpusStatus` 的结果。用户要检查就点按钮」
- 「`update_available` 才显示「立即更新」按钮，其余状态不显示（不要给一个点了必然失败的按钮）」；「另有一个「检查更新」按钮，**任何状态都可用**（`unavailable` 时也可用——用户可能想确认源是否可达）」
- 「更新进行中：按钮禁用 + 显示进度…**不要做假的进度条**」；「失败要显示原因」「`check_failed` / `verify_failed` / `config_invalid` 的原因**必须显示原文**」
- 「`applyUpdate` 接收的是已解析的 `manifest`。你要判断哪种做法更简单可靠，并说明理由」
- 「**测试不得触网**，这点是硬要求」；「禁止执行任何依赖安装/变更命令，禁止改动 `package.json`/`package-lock.json`/`node_modules/`」

**关键产出**
- `desktop/host/host.js`：新增 `getCorpusStatus` / `checkCorpusUpdate` / `applyCorpusUpdate` 三条命令 + `corpusModule()` 惰性三模块 import（`corpus/update.js`、`config/corpus-config.js`、`corpus/manifest.js`），与 `kbModule()` 同一套「旧 `dist/` 也要能开机」的理由。
- `desktop/renderer/settings.js`：`buildKbPage` 里新增 `updateGroup()`，「状态组」之后；七种状态各一句文案，原因原样展示；三处调用点（`kb === null` 加载中、`missing` 无根、正常）都画——更新组的 `$HARNESS_HOME/kb` 与工具读的目录是两个位置，「这里没目录」不回答「这台机器能不能连上更新源」。
- `desktop/renderer/settings-i18n.js`：中英各 30 条键，`kb` 段之后。
- `desktop/renderer/settings.css`：`.kb-update-*` 六个类（原因行整宽换行、动作行、进度/成功/失败行）。
- `desktop/MATRIX.md`：三条命令登记进命令表。
- `tests/desktop/host-corpus.test.js`（新，14 例）：起真实宿主进程，全程只连本机 `127.0.0.1` 上自建的 server 或永不被绑定的 `127.0.0.1:1`。

**`applyUpdate` 的 manifest 从哪来（本任务的核心取舍）**
- **采用：check 时截获 + 缓存；缓存未命中时再走一次同样的截获式 check。** 不是「重跑 `checkForUpdate` 拿状态就算了」，也不是「宿主自己再 fetch 一次 `latest.json`」。
- 理由：`checkForUpdate` 返回的是**状态**不是清单，而 `applyUpdate` 要的是已解析的 `manifest`（它内部还会 `parseManifest` + `verifyManifestSignature` 再验一次）。若宿主自己 fetch，就必须在这里重新实现契约 §6.1 的 HTTP 状态语义——尤其是「OBS 上不存在的对象返回 403 而不是 404，绝不能当成已是最新」。**那条规则不能有两份实现**。所以做法是在 `fetchImpl` 外面套一层：请求打到 `latest.json` 且状态 200 时 `response.clone().text()` 留一份，响应仍原样交给 `checkForUpdate` 去读；只有 check 自己得出 `update_available` 时才启用这份文本——也就是那串字节已经被内核解析并验签过了。验不过的内容永远走不到 `applyUpdate`。
- 缓存按 `updateBaseUrl + publicKeyPem` 指纹失效：改了任一项，缓存下来的清单就是关于另一个源的断言，装上去等于信任当前配置从未背书过的字节。装成功后清缓存（否则会再提示装同一版）。
- 缓存未命中时（页面开着、后台已发布新版）走 `resolveCorpusManifest` 里的第二次截获式 check，**由内核判断有没有可装的版本**，失败就转述内核自己的状态原因，宿主不另写一套措辞。

**开发/打包形态的配置差异**
- `corpusResourcesRoot = roots.form === "packaged" ? roots.distParent : undefined`。打包形态 `roots.distParent` 就是 `resources/`，正是契约 §2 说的构建注入位置；开发形态它是仓库根，那里放的是 `config/corpus.local.json` 而不是 `corpus.json`，指过去只会得到「文件不存在」。
- **开发与测试形态用优先级更高的那一级**：`$HARNESS_HOME/corpus.json`（契约 §2 第一位）。把 `HARNESS_HOME` 指向临时目录、往里丢一个 `corpus.json`，整条 check/apply 路径就都跑那份文件——不需要新环境变量，宿主里也不会出现第二个校验器。
- **`HARNESS_CORPUS_CONFIG` 考虑过并明确不加**：它必须在宿主里重新实现 `loadCorpusConfig` 的校验（否则「指向的文件坏了」会被报成「没配置」），而同一个文件两套校验器迟早会对「什么算已配置」给出两个结论。打包形态行为完全不变。

**七状态在页面上的区分方式**
- `status.kind` 是内核的判别联合，宿主**原样转发、不重新推导**（宿主里再写一份 switch 迟早会和写 `state.json` 的那份分叉）。
- 渲染侧一张 descriptor 表（`badge` / `title` / `desc` / `reason` / `facts` / `path`），七种状态各一行：`bundled` 与 `unavailable` 用 `muted` 徽标 + 各自一句（两者都不是失败：一个是「只有内置」、一个是「本机没有语料」）；`up_to_date` 用 `ok` + 版本 + 上次检查时间；`update_available` 用默认徽标 + 版本 + 文件数 + 上次检查时间 + 「立即更新」；`check_failed` / `verify_failed` / `config_invalid` 用 `warn` 徽标 + **原因原文整行**（`config_invalid` 另给 `configPath`）。
- `unknown` 的 `kind` 落进 `default`：显示「检查更新失败」并**引号带出原判别值**，不猜它是七种里的哪一种。
- 「立即更新」只在 `update_available` 出现；「检查更新」任何状态都在（含 `unavailable`）。
- 更新中：两个按钮都禁用，标签各说各的命令（`check` → 「正在检查…」、`apply` → 「正在更新…」）；进度来自内核 `onProgress` 的逐文件计数，无定时器、无估算百分比。失败分两行：标签行 + 原因原文行（不把译文标签和内核中文句子用标点粘在一起——那个标点在两种语言里必有一边是错的）。

**测试（实跑结果）**
- `npx vitest run tests/desktop/host-corpus.test.js`：**14 passed**。覆盖：空 home → `unavailable`；`state.json` 的 `up_to_date` 如实映射（含 `checkedAt`）；`update_available` 的版本号与 `fileCount` 完整还原；早期状态文件缺 `fileCount` → 如实降级 `check_failed` 且原因带「文件数 / 重新检查」、`fileCount` 字段不出现；无配置 → `config_invalid` + `configPath`；**`getCorpusStatus` 零请求**（配置指向记录请求的本地 403 服务器，答案仍是 `bundled`，`requests` 为空数组）；无配置时 check 不请求不崩；403 → `check_failed` + 含 `403` / `GetObject`，且断言 `not.toBe("up_to_date")`；不可达 → 含「网络请求失败」「版本保持不变」；apply 无配置明确拒绝；apply 遇 403 拒绝且 `requests` 恰为 `["/latest.json"]`；**检查→更新全流程**（`current` 指向 v2、文件落盘、保留 v1、`/latest.json` 只请求 **1** 次、进度两条都 `downloaded`）；装完再点不重复下载；错签名 → `verify_failed`、只请求清单、指针不动。
- `npm run test:desktop`：7 files / **223 passed | 3 skipped**。
- `npm test`（全量）：96 passed / 2 failed，失败在 `mcp-servers/cubeide/tests/cubeide.test.ts` 与 `mcp-servers/keil/tests/uvsock-protocol.test.ts`（超时），**单独跑这两个文件分别 20 passed / 76 passed**——是并行满载下的既有超时，两处文件本轮未改（`git status` 无它们）。
- `npm run typecheck`：**仍只有 7 个既有错误**（`cubeide`、`keil` 测试），0 新增。`desktop/` 是纯 JS，不进 tsconfig 的 `include`。
- `npm run build`：通过。

**被拒绝或纠偏的内容**
- 一度把忙碌标记做成 `corpusChecking` / `corpusApplying` 两个布尔 + 「忙就拒绝」的 notice。写全流程测试时暴露问题：`check` 与 `apply` 是两条 fire-and-forget 命令，用户「点检查、马上点更新」会让 apply 自己再 fetch 一次 `latest.json`——测试断言「清单只取一次」直接红。改成**一条串行队列**（`enqueueCorpus`）：三条命令共用 `state.json` 与 manifest 缓存，排队而不是拒绝，「点检查再点更新」本来就是正常操作。
- 忙碌标记第二版是布尔 `state.corpusBusy = false`，配合「两个按钮都禁用」。自查发现 `busy === "check"` 这类判断会永远为假（`false !== ""`），按钮会永久禁用。改成三值字符串 `""` / `"check"` / `"apply"`，每个按钮的标签只描述自己那条命令——在只取清单的 check 上显示「正在更新…」是给没发生的事贴标签。
- 失败文案首版是 `` `${s.kbUpdateFailed}：${result.reason}` ``，硬编码了中文全角冒号。英文界面会出现 "Update did not take effect：Update failed: ..."。改成两行，标签与原因各自成句。
- 状态徽标首版每个分支各写一遍 `row(label, badge)`，导致状态名同时出现在 label 和 control 两处（同一个句子读了两遍）。改成一张 descriptor 表 + 一处统一布局，七个状态只在「说什么」上不同。
- `resolveCorpusManifest` 的返回值里带了个 `from: "cache" | "check"` 字段，原本想写进日志。自查后保留但只用于测试可读性——产品代码不读它，注释里写明这一点，避免它被当成第二个事实源。

**明确没做的事**
- 没有渲染器侧自动化测试：`tests/desktop/` 里只有协议层与宿主测试，没有 DOM 测试框架，按要求**不为这一页新造一个**。渲染器改动靠人工核对（本任务未在 Electron 里实际打开过页面，见「需主代理决策」）。
- 没有真实联调 OBS：按禁令全程不触网，真实桶的 200 / 403 行为由主代理验证。
- 没改 `docs/corpus-ota.md`（契约源，只读）、没碰 `package.json` / lock / `node_modules`、没做任何 git 写操作。

## 2026-10-23 T5 首次种子化与 KB 接线

**用户关键原话**
- 「派T5，刚测试完，可以拉取」
- （前序）「那其他人拿到打包的安装包，获取的知识库是存放在哪里」
- （前序）「一直显示正在读取知识库…，正在检查也响应太慢」
- （前序）「问题1：知识库页面没做视觉对齐；问题2：模型配置测试，测试按键与测试结果相距太远，不合理」

**关键产出**
- 新增 `src/corpus/seed.ts`：`seedCorpus` + `seedKbMcpEntry`，复用 `snapshot.ts` 的 `getKbLayout` / `ensureSnapshotDir` / `setCurrent` / `readCurrentVersion`，不自写 symlink。
- `desktop/host/host.js`：`seedFirstRun()` 在 `init` 末尾以 `void` 启动（不阻塞握手）；`handleCorpusStatus` / `handleCorpusCheck` / `handleCorpusApply` / `getKb` 各自先 `await seedFirstRunPromise`，消除「页面在种子化中途打开」的竞态。
- 新增 `tests/corpus-seed.test.ts`（26 例）+ `tests/desktop/host-seed.test.js`（4 例）。

**主代理实测（真实环境，非 mock）**
- 宿主启动后 `C:\Users\mogen\.harness\mcp.json` 被正确写入：
  `command: D:\nvm4w\nodejs\node.exe`、`args: [.../dist-mcp/kb/server.js]`、`env: { KB_ROOT: ...\kb\current, KB_INBOX_PATH: ...\kb\inbox\_inbox.md, ELECTRON_RUN_AS_NODE: "1" }`。
- `getKb` 从此前的 `source: "default"`（仓库目录，108 文件）变为 `source: "mcp.json"`、根 `C:\Users\mogen\.harness\kb\current`、**fileCount 107**。
- 107 不是 108：清单 108 = 107 个 `.md` + 1 个 `.yaml`（`index.yaml`），而 `getKb` 的 `fileCount` 只数 `.md`。两处口径不同，非缺陷。

**被拒绝或纠偏的内容**
- 首版 `appendProposalTo` 自动 `mkdirSync` 被撤销（见 T4 段）——本次种子化正是那个「目录归部署层负责」的实现者。
- 子代理在我的 brief 之外自行加了两个跳过条件：`kb_root_env_override`（`process.env.KB_ROOT` 非空则不写，否则 env 与 `mcp.json` 会指向不同根）、`kb_server_missing`（`dist-mcp/kb/server.js` 不存在则不写，否则每次会话多一条必然失败的 `connect_failed`）。**主代理确认保留**——两个都指向「写进去只会产生两种互相矛盾的说法」。
- `writeMcpServers` 会丢掉其它 server 条目上的未知字段（只序列化白名单）。子代理选择复用它而不是自写第二套读写，理由与设置页 `saveMcpServer` 的既有行为一致。**接受**。

**翻车与返工**
- 首次验证 `mcp.json` 未生成，误判为种子化失败。实际原因是我用 `printf | node` 管道跑宿主，stdin 立刻关闭触发 `rl.on("close")` 流程，`void` 启动的种子化没跑完就退出了。改为保持 stdin 打开 4 秒后，`mcp.json` 正常写出。**这是验证方法的问题，不是代码的问题**——但它暴露了一个真实风险：宿主在 stdin 关闭时会立即退出，可能中断正在进行的种子化。若将来种子化变慢（语料变大），需要考虑退出前等待。

**遗留（未做）**
- 打包配置（T10）仍暂缓：`seedCorpus` 在开发形态返回 `no_bundled_corpus`，其「物化内置语料」路径只在 `tests/desktop/host-seed.test.js` 里用合成语料验证过，**未在真实打包产物上跑过**。
- 渲染器无自动化测试，知识库页视觉对齐与模型测试按钮位置两处改动只能人工验收。
