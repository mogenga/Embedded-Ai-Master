# 发布到 GitHub Releases

本文件是发布流程的唯一操作手册。发布渠道是 **GitHub Releases**（不是 npm、不是自建更新服务器）。

相关文档：

- `docs/operations/code-signing.md` —— Windows 代码签名（证书从哪来、怎么配、怎么验）。
- `docs/ledgers/deferred-issues.md` **D-212** —— 发布链路已跑通（`v0.1.0`–`v0.3.0` 八个 release）；应用内自动更新**已接入且跑通过一次真实更新**（2026-11-09，见 §12），残余边界见 §12.6。
- `docs/ledgers/deferred-issues.md` **D-217** —— 未签名构建下，下载到的更新包不做签名校验。
- `docs/ledgers/deferred-issues.md` **D-211** —— 签名配置就位但从未验证过真实签名。
- `docs/ledgers/deferred-issues.md` **D-209** —— 根与 `desktop/` 的 Electron 版本不一致。
- `docs/ledgers/deferred-issues.md` **D-213** —— `resources/` 缺 `{ "type": "module" }`，所有安装用户多付一次重解析（已修，原因见 §11）。

---

## 1. 当前状态（2026-11-09 更新）

> 下表保留 2026-10-25 的实测依据；`Releases` 与 `干净机器安装` 两行已于 2026-11-09 按 `v0.3.0` 改写，`应用内自动更新` 一行同日由「已接入」改为「已跑通」。`签名` 一行沿用旧结论（仍未签）。

| 项 | 状态 | 依据 |
|---|---|---|
| 仓库 | `mogenga/Embedded-Ai-Master`，**public** | GitHub API 实测 `private: false`、`visibility: public` |
| Releases | **`v0.3.0` 为最新**（`v0.1.0`–`v0.3.0` 八个 release，各含安装包 / `.blockmap` / `latest.yml` 三个资产；`v0.3.0` 的安装包 118,399,565 字节） | `gh release view v0.3.0 --json assets` 实测（2026-11-09）：三个资产均为 `uploaded`，sha512 与 `latest.yml` 逐字一致 |
| 干净机器安装 | **已通过**：v0.1.5（2026-11-03）、**v0.3.0（2026-11-09）**。v0.2.0 未单独验证 | 用户报告；D-208 关闭 |
| `desktop/package.json` 的 `build.publish` | 已配置 GitHub provider | `npx electron-builder --win --x64 --dir` 退出 0，schema 接受 |
| `gh` CLI | **已安装且已登录**，但**不在 `PATH` 里** | 版本 2.103.2，路径 `C:\Program Files\GitHub CLI\gh.exe`；`gh auth status` 退出 0，账号 `mogenga` |
| `electron-updater` | **已安装（6.8.11）** | 声明在 `desktop/package.json`（`^6.8.11`），`desktop/node_modules/electron-updater/package.json` 实测为该版本 |
| 应用内自动更新 | **已接入并跑通一次真实更新**（`desktop/updater.js` + 主进程 IPC + 关于页） | 用户实测（2026-11-09）：旧版收到新版提示 → 下载 → 重启安装完成。实现见 §12，边界见 §12.6 |
| 签名 | 配置就位，**从未真实签过** | 本机无证书，见 `docs/operations/code-signing.md` §7 |
| 图标 | 已配置 `build/icon.ico` | `desktop/package.json` 的 `win.icon` |

**三条由此推出的结论，写在这里免得被误解：**

1. **用户能收到应用内更新提醒，但需要手动确认。** 关于页会显示有没有新版；**下载与安装各需一次点击**，不会静默发生（§12.3）。
2. **`latest.yml` 不再是死文件。** `electron-updater` 读它判断版本与文件哈希。因此**每次发布都必须上传它**，否则用户看到的是「该 release 缺少更新清单」。
3. **未签名期间下载到的更新包不做签名校验。** 完整性只靠 `latest.yml` 的 sha512，见 D-217 与 §12.6。


### `gh` 为什么不在 PATH 里

Windows 的 GUI 安装器（winget / msi）不保证把 `GitHub CLI` 目录写进 `PATH`。本机就是这种情况：`which gh` 为空，但可执行文件在。

需要时用完整路径（git-bash）：

```bash
"/c/Program Files/GitHub CLI/gh.exe" --version
```

或者临时加进当前会话（**只对当前 shell 有效**，不要写进仓库里的任何文件）：

```bash
export PATH="$PATH:/c/Program Files/GitHub CLI"
gh auth status
```

`scripts/release.mjs` 两种方式都会试（先试 `gh`，再试 `C:\Program Files\GitHub CLI\gh.exe` 等候选），也可以用环境变量 `GH_EXE` 显式指定。

---

## 2. 一条命令的发布流程

前提：Node 24、`npm install` 与 `npm --prefix desktop install` 都已完成（agent 不代为执行安装）。

```bash
# 0) 前置检查——必须是 0 失败
node scripts/release.mjs --check

# 1) 构建内核与 MCP 产物
#    两条命令各自先删除自己的输出目录（scripts/clean.mjs dist / dist-mcp），
#    顺序任意、互不影响。不要手动交叉清理，也不要一次清两个。
npm run build
npm run build:mcp

# 2) 装配打包前置（运行时依赖闭包 + 语料）
node scripts/package-prepare.mjs

# 3) 完整 NSIS 打包（不加 --publish：只出本地产物，不上传）
cd desktop && npx electron-builder --win --x64 && cd ..

# 4) 确认三个附件都在，且大小非零
ls -la desktop/dist-installer/

# 5) 打 tag 并推送
git tag -a v0.1.0 -m "Embedded AI Master v0.1.0"
git push origin v0.1.0

# 6) 创建 release 并上传三个附件
gh release create v0.1.0 \
  "desktop/dist-installer/Embedded-AI-Master-Setup-0.1.0.exe" \
  "desktop/dist-installer/latest.yml" \
  "desktop/dist-installer/Embedded-AI-Master-Setup-0.1.0.exe.blockmap" \
  --title "Embedded AI Master v0.1.0" \
  --notes "首个发布版本。"

# 7) 复验
gh release view v0.1.0
node scripts/release.mjs --check
```

`node scripts/release.mjs`（不带 `--check`）会把上面这套命令**按当前版本号拼好并打印出来**，可以直接复制。它不执行任何一步。

### 第 5 步与第 6 步的顺序不能反

**必须先推 tag，再创建 release。**

`gh release create <tag>` 在 tag 不存在时会从**仓库默认分支的 HEAD** 新建一个 tag。如果你在本地构建后先建 release，那个 tag 指向的是远端 `main` 的当前提交，不一定是你刚构建的那个提交——包与源码就对不上了。

想强制这一点，给 `gh` 加 `--verify-tag`：

```bash
gh release create v0.1.0 ... --verify-tag
```

这样 tag 不存在时 `gh` 直接失败，而不是替你造一个。

### 三个附件分别是什么

| 文件 | 作用 | 大小（0.1.0 实测） |
|---|---|---|
| `Embedded-AI-Master-Setup-0.1.0.exe` | NSIS 安装包 | ~113 MB |
| `Embedded-AI-Master-Setup-0.1.0.exe.blockmap` | 差量更新用的块索引；`electron-updater` 靠它只下载变化的块 | ~123 KB |
| `latest.yml` | 更新描述文件，见 §4 | ~0.5 KB |

### 手动上传时要注意文件名不一致（实测发现）

**这一段是手动上传路径的一个真实陷阱，`gh release create` 与网页上传都会碰到。**

**产物名必须不含空格和中文。** GitHub 只接受 `[0-9A-Za-z._-]` 的资产名（`app-builder-lib/out/platformPackager.js` 的 `isSafeGithubName`）。默认产物名由 `productName` + version 拼成（`Embedded AI Master Setup 0.1.0.exe`，含空格），electron-builder 会把 `latest.yml` 里的 `url`/`path` 改写成连字符版本——**而磁盘上仍是带空格的原名**，手动上传后两者对不上，将来 `electron-updater` 会去下载一个不存在的资产。

2026-10-25 已从源头修掉，`desktop/package.json` 显式指定：

```json
"win": {
  "artifactName": "Embedded-AI-Master-Setup-${version}.${ext}"
}
```

现在磁盘名与 `latest.yml` 天然一致：

```
dist-installer/Embedded-AI-Master-Setup-0.1.0.exe
latest.yml → url: Embedded-AI-Master-Setup-0.1.0.exe
```

`node scripts/release.mjs --check` 有一项专门比对这两者，改名前它报 WARN，现在报 OK。**改 `artifactName` 前必须重新打包**，旧产物仍然带着空格的名字。

注意：`artifactName` 只影响**安装包**文件名，不影响解压后目录里的 `Embedded AI Master.exe`（那个由 `productName` 决定）。

---

## 3. 手动备选（`gh` 不可用时）

`gh` 可能换机器、可能没登录、将来也可能不再装。兜底路径是网页手动上传，不需要任何 CLI：

1. 打开 `https://github.com/mogenga/Embedded-Ai-Master/releases/new?tag=v0.1.0`
2. **Tag** 选已存在的 `v0.1.0`（第 5 步已推上去的那个），不要在这里新建
3. **Title** 填 `Embedded AI Master v0.1.0`
4. 上传三个文件：`.exe`、`latest.yml`、`.exe.blockmap`
5. 按需勾选 "Set as the latest release"
6. 点 Publish release

上传后**核对文件名没被浏览器改写**：GitHub 会把空格保留为空格，但下载时 URL 里是 `%20`。`latest.yml` 里的 `path` 字段必须与远端资产名逐字一致（含空格），否则 `electron-updater` 将来会 404。

### 另一条备选：electron-builder 直接发布

```bash
GH_TOKEN=<your-gh-token> npx electron-builder --win --x64 --publish always
```

`GH_TOKEN` 是 GitHub Personal Access Token：

- classic token 需要 `repo` scope；**public 仓库实际用 `public_repo` 就够**。
- fine-grained token 需要该仓库的 **Contents: Read and write** 权限。
- **绝不能进仓库。** 不要写进 `package.json`、不要写进 `.env` 并提交、不要贴进 issue 或聊天记录。它一旦泄露，任何人都能往你的 release 里塞东西。

**这条路不作为主推荐**，原因有两条，都是可观察的：

1. 它把「构建」和「发布」合成一步。构建到一半失败（网络、签名、磁盘）会留下一个只传了一半的 release，而 release 一旦公开就有人能看到。
2. 它**不跑任何发布前检查**——不检查工作区是否干净、不检查签名、不检查版本号。`gh` 那条路可以在发布前用 `--check` 拦住问题。

---

## 4. `latest.yml` 是干什么的

`latest.yml` 是 **`electron-updater` 的更新描述文件**。`electron-updater` 启动时从 `https://github.com/<owner>/<repo>/releases/latest/download/latest.yml` 取这一份，读里面的 `version` 与文件信息，决定要不要下载新版本。

内容大致长这样（字段来自 electron-builder 的 `updateInfoBuilder`）：

```yaml
version: 0.1.0
files:
  - url: Embedded-AI-Master-Setup-0.1.0.exe   # 注意：空格已被换成连字符
    sha512: <base64>
    size: 117531851
path: Embedded-AI-Master-Setup-0.1.0.exe      # 兼容旧版 electron-updater
sha512: <base64>
releaseDate: '2026-10-25T...'
```

（上面是按源码换算出的预期形状，`url` / `path` 的名字规则见 §2 末。`v0.1.0` 的完整 NSIS 打包已产出该文件，实测内容与预期一致：`url` 与 `path` 都是 `Embedded-AI-Master-Setup-0.1.0.exe`。）

**`latest.yml` 现在是活的：`electron-updater` 读它**（§12.2）。它必须与安装包一起上传，且里面的 `sha512` / `size` 必须与那个包一致——`electron-updater` 会用 `sha512` 校验下载到的文件。

同一个 `publish` 配置还会让 electron-builder 在安装包的 `resources/` 下写一份 `app-update.yml`（内容是本机的 provider 配置副本，供 `electron-updater` 读取）。**`--dir` 构建不会写它**——`--dir` 的 target 不是 NSIS，`PublishManager.onAfterPack` 里的 `isSuitableWindowsTarget` 判断为假就直接返回了。完整 NSIS 打包才会出现。

### `latest.yml` 只在完整 NSIS 打包时产生

`--dir` **不产** `latest.yml`。它是 NSIS 目标在 `isWriteUpdateInfo` 为真时才生成的（`NsisTarget.js` → `PublishManager` → `updateInfoBuilder.writeUpdateInfoFiles`）。

验证配置合法性用 `--dir` 就够（快、不下载 winCodeSign），但**要发布必须跑完整 NSIS**。

---

## 5. 默认构建会上传吗？

**本地默认不会。** 不加 `--publish` 时，electron-builder 只写 `latest.yml` 到 `desktop/dist-installer/`，不上传任何东西。

依据（`node_modules/app-builder-lib/out/publish/PublishManager.js`）：`publishOptions.publish` 为 `undefined` 且没有 CI / CI tag / `npm run release` 触发时，`this.isPublish` 为 `false`，`scheduleUpload` 不会被调用；但 `createUpdateInfoTasks` 仍然执行，所以 `latest.yml` 照写。

### 三个会让「默认构建」变成「自动上传」的隐式触发（要知道）

同一段源码里有三条隐式规则，`publish` 未显式指定时生效：

| 触发条件 | 结果 |
|---|---|
| 通过名为 `release` 的 npm script 运行（`npm_lifecycle_event === "release"`） | `publish = "always"`，**直接上传** |
| 环境里有 CI tag（`TRAVIS_TAG` / `GITHUB_REF_TYPE=tag` 等） | `publish = "onTag"` |
| 被识别为 CI（`ci-info` 判定） | `publish = "onTagOrDraft"` |

本地 PowerShell / git-bash 直接跑 `npx electron-builder` 时三条都不成立（实测 `ci-info` 报 `isCI: false`），所以安全。**但如果将来加 CI，默认行为就变了** —— 那时必须显式写 `--publish never`，或者干脆不配 CI 发布。

本仓库目前**没有** GitHub Actions workflow，也没有叫 `release` 的 npm script，所以现在不存在这个风险。

### 想做一次「只验证配置、不碰产物」的检查

```bash
cd desktop && npx electron-builder --win --x64 --dir
```

退出码 0 就说明 `build.publish` 被 schema 接受。这条命令**不下载 winCodeSign**（没证书时签名在 `cscInfo == null` 处就返回了），但会重新生成 `dist-installer/win-unpacked/`。

---

## 6. 发布前检查清单

逐项都要过。`node scripts/release.mjs --check` 覆盖了标 ✅ 的项。

- [ ] ✅ `node scripts/release.mjs --check` 输出 **0 失败**
- [ ] ✅ `desktop/package.json` 的 `version` 是合法 semver（不带 `v` 前缀）
- [ ] ✅ `dist/` 与 `dist-mcp/` 存在且非空（`npm run build` + `npm run build:mcp` 跑过）
- [ ] ✅ `desktop/build/node_modules/` 与 `desktop/build/corpus/` 存在（`package-prepare` 跑过）
- [ ] ✅ `desktop/dist-installer/*.exe` 存在（完整 NSIS 打包跑过）
- [ ] ✅ 安装包**已签名**（`scripts/verify-signature.mjs` 退出码 0）
- [ ] ✅ `gh` 可用且已登录（或已确认走网页手动上传）
- [ ] ✅ git 工作区干净（`git status --porcelain` 为空）
- [ ] ✅ HEAD 已打目标 tag（或确认这一步即将执行）
- [ ] `npm test` 通过（`--check` 不跑测试，它是独立的一项）
- [ ] `npm run build` 与 `npm run build:mcp` 通过
- [ ] `node scripts/package-prepare.mjs` 跑过
- [ ] 在干净机器上装一遍，确认能启动、能连 MCP、随包语料可见

**为什么要工作区干净**：发布必须对应一个确定的提交。带着未提交改动打出来的包，事后无法从 tag 复现——出了问题也查不到「当时到底是哪版代码」。

### `--check` 的状态含义

| 标签 | 含义 | 影响退出码 |
|---|---|---|
| `OK` | 通过 | 否 |
| `WARN` | 还没到那一步，不算缺陷（例如 HEAD 尚无 tag） | 否 |
| `FAIL` | 检查失败或无法确认 | **是** |

退出码：全部通过（含只有 WARN）→ `0`；任一 `FAIL` → `1`。

`FAIL` 里有一条值得单独说：**签名验证脚本缺失时 `--check` 报 FAIL，而不是跳过。** 「没检查」不等于「检查通过」（R3）。

---

## 7. 版本号怎么升

**`desktop/package.json` 的 `version` 是发布版本的唯一来源。** 安装包名、`latest.yml` 的 `version`、`gh release create` 的默认 tag 全部从它推出来。

根 `package.json` 也有一个 `version`（当前也是 `0.1.0`），但**打包不用它**。

### 两个 version 不一致是个隐患

现在两处恰好都是 `0.1.0`，看起来无害。但根 `package.json` 的 version 没有任何代码读它来发布——它只出现在 `npm` 的输出里。如果有人只改了根那份，会得到「以为发布了 0.2.0、实际安装包还是 0.1.0」的结果，而且**没有任何报错**。

规则很硬，写在这里：

> **升版本只改 `desktop/package.json` 的 `version`。** 改完顺手把根那份也对齐，但不要指望它生效。

`node scripts/release.mjs --check` 会读 `desktop/` 那份，`--check` 通过就说明用于发布的那份是合法的。

### 升版本的最短流程

1. 改 `desktop/package.json` 的 `version`（顺手对齐根 `package.json`）
2. 提交这次改动（发布必须对应确定提交）
3. `node scripts/release.mjs --check` —— 此时 tag 项会报 WARN（新版本还没打 tag），这是预期的
4. 按 §2 的流程往下走

---

## 8. 签名状态

**当前产物是未签名的。** 用户双击安装包会看到 SmartScreen 的整屏警告（"Windows 已保护你的电脑" → 「仍要运行」）。

签名怎么做、证书从哪来、怎么验证是否签上，全部在 **`docs/operations/code-signing.md`**。要点复述三条：

1. 配 `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` 就会自动签，**不需要改任何构建配置**。
2. 证书**绝不能进仓库**（`.gitignore` 已忽略 `*.pfx` / `*.p12` 等）。
3. **签名不等于没有警告**：新证书的 SmartScreen 信誉从零累积，OV 要数周到数月、EV 通常数天。不要向用户承诺「签完就没警告」。

发布前用下面这条确认签名状态：

```bash
node scripts/verify-signature.mjs "desktop/dist-installer/Embedded-AI-Master-Setup-0.1.0.exe"
```

退出码 `0` = 有证书表，`1` = 未签名，`2` = 无法检查。注意它**只回答「有没有证书表」**，不验证证书链与时间戳（那条边界写在脚本头部）。

---

## 9. 与 D-209 的关系（Electron 版本）

根 `package.json` 声明 `electron: ^45.0.0`，`desktop/package.json` 声明 `^44.9.0`。**打包用的是 `desktop/` 那一份**（实测 `electron-builder` 日志 `electron=44.9.1`）。

所以：

- 发布形态跑在 Electron **44.9.1** 上；
- `npm run desktop` 在开发时用哪一份，取决于启动方式；
- 两者不一致会在升级时咬人（ABI / API 差异表现为「开发能跑、装完不能跑」）。

统一需要一个 `npm install`（agent 不代为执行），见 **D-209**。

---

## 10. 当前已知的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `which gh` 为空 | GUI 安装器没写 PATH | 用完整路径或临时 `export PATH`，见 §1 |
| `--dir` 没产 `latest.yml` | 那是 NSIS 目标的产物 | 发布必须跑完整 NSIS |
| `--dir` 的 `resources/` 里没有 `app-update.yml` | `--dir` 的 target 不是 NSIS | 完整 NSIS 才有 |
| 构建日志有 `signing with signtool.exe` 但产物未签名 | 那行在判断之前无条件打印 | 以 `verify-signature.mjs` 的结果为准，见 `docs/operations/code-signing.md` §7 |
| `gh release create` 后 tag 指向了别的提交 | 先建 release 后打 tag | 先推 tag，或加 `--verify-tag`，见 §2 |
| 手动上传后远端资产名与 `latest.yml` 里的不一致 | GitHub 把空格改写为连字符 | 见 §2 末「手动上传时要注意文件名不一致」 |
| 关于页显示「当前构建缺少更新模块」 | 打包时 `electron-updater` 没进 `resources/node_modules` | 跑 `npm --prefix desktop install` 后重新完整打包（§12.6 第 5 条） |
| 关于页显示「开发形态不提供更新」 | 从源码跑（`app.isPackaged === false`） | 不是 bug：`app-update.yml` 只在安装版里（§12.5） |
| 关于页显示「该 release 缺少更新清单（latest.yml）」 | 发布时忘传 `latest.yml` | 补传后重试；不是「没有新版本」（§12.4） |
| 用户说「检查更新失败：连不上更新服务器」 | 网络 / 代理 / DNS | 与发布无关，先确认能打开 `github.com` |
| 首次启动 stderr 有 `MODULE_TYPELESS_PACKAGE_JSON` 警告 | `resources/` 缺 `package.json` | 已修（见 §11）；若复现说明 `resources/package.json` 丢了 |
| 启动时的重解析开销（无警告，只是变慢） | 同上，警告按进程只报一次且 `node_modules` 下不报 | 已修（见 §11） |

---

## 11. `resources/package.json` 为什么必须存在（不要删）

安装目录的 `resources/` 根下有一份只有一行的文件：

```json
{ "type": "module" }
```

**它在仓库里的源文件是 `desktop/resources-package.json`**，由 `desktop/package.json` 的 `extraResources` 搬到 `resources/package.json`。它看起来像个莫名其妙的多余文件，**清理无用文件时一定会被盯上**，所以这里把原因写清楚。

### 11.1 Node 怎么判定一个 `.js` 是 ESM 还是 CJS

`.js` 文件的模块类型不写在文件里，而是由**最近的 `package.json` 的 `type` 字段**决定（Node 源码 `internal/modules/esm/get_format.js` 的 `getFileProtocolModuleFormat`，经由 `getPackageScopeConfig` 实现）：

- 从该 `.js` 所在目录起，**逐级向上**找第一个能找到的 `package.json`；
- 那份就是「控制文件」（package scope）。`type: "module"` → ESM；`type: "commonjs"` 或**没有 `type` 字段** → 先按 CJS 解析；
- 若那份 `package.json` 没有 `type`，Node 会读源码**检测**语法：查到 `import`/`export` 就重解析为 ESM。这次「先试再重解析」就是代价。

语法检测（`--experimental-detect-module`）在 Node 22.7+ 起默认开启，实测 Node 24.14.1 不加任何 flag 就会出现本节的警告；`node --help` 里只有关闭开关 `--no-experimental-detect-module`，也印证默认是开的。

### 11.2 为什么打包形态下会一路找到用户家目录

安装后 `resources/dist/` 里全是编译出来的 ESM（`dist/server/runner.js` 等）。它向上查找的顺序是：

```
...\embedded-ai-master-desktop\resources\dist\   ← 从这里起
...\embedded-ai-master-desktop\resources\        ← 没有 package.json（修复前）
...\embedded-ai-master-desktop\                  ← 没有（只有 app.asar，见下）
...\Local\Programs\                              ← 没有
...\AppData\Local\                               ← 没有
...\mogen\                                       ← C:\Users\mogen\package.json（如果有）
C:\                                              ← 没有
```

**关键点：`app.asar` 挡住的那一层，是「asar 里的 `package.json` 只管 asar 里面的文件」。** 安装目录下确实有一份 `app.asar`，它**内部**也有 `package.json`（就是 `desktop/package.json` 打进去的那份，含 `"type": "module"`）。但 Electron 的 asar 支持是按**路径**生效的：只有 URL 落在 `...\app.asar\...` 里的文件才会走 asar 的 `fs` 补丁、才看得见 asar 里的那份 `package.json`。

`resources/dist/` 与 `resources/dist-mcp/` 是 asar **外面**的普通磁盘文件，向上查找时 `app.asar` 对它们只是一个叫 `app.asar` 的**文件**，路径不是 `app.asar/...`，asar 补丁不介入，所以那份 `"type": "module"` 对它们不可见。祖先链于是越过整个安装目录，落到用户家目录、甚至盘根。

（实测佐证，2026-10-25：用打包产物的 exe 以 `ELECTRON_RUN_AS_NODE=1` 导入 `t.asar/lib/q.js`，警告文案是 `add "type": "module" to \\?\...\t.asar\package.json`——asar **内部**的 `package.json` 确实被读到了；把 asar 根改成 `{ "type": "module" }` 后同一 import 直接按 ESM 加载、无警告。同一 `import` 用系统 Node 跑则是 `ERR_MODULE_NOT_FOUND`。可见「进得去 asar」与「asar 的声明管到外面」是两回事。）

- 家目录**有** `package.json` 且没有 `type`：行为是「先 CJS、失败、重解析」，并弹一条点名**用户家目录**的警告——对用户完全无意义，像是安装包在抱怨他家目录里有个无关文件。
- 家目录**没有** `package.json`（干净机器）：查找一路到盘根都没有，行为**一样**是先 CJS 再重解析，只是不发那条警告（源码里 `foundPackageJson` 为假时不警告）。

**两种机器都付了重解析的代价。** 这不是某台机器脏了，是安装包缺了这份声明。

### 11.3 缺了会怎样（两句实话）

1. **性能**：每个 `.js` 都要先当 CJS 试一遍、发现语法是 ESM 再换解析器。
2. **误导性警告**：警告文案是 `To eliminate this warning, add "type": "module" to C:\Users\<用户名>\package.json`。用户按提示去改家目录的 `package.json` 也不会好——不是那个文件的事。

### 11.4 为什么放在 `resources/` 根，而不是 `dist/` 里

`resources/` 下有三个目录与模块类型有关，但**只有前两个需要救**：

| 目录 | 内容 | 修复前最近的 `package.json` | 需要 `resources/package.json`？ |
|---|---|---|---|
| `resources/dist/` | 内核编译产物 | 用户家目录（或没有） | **是** |
| `resources/dist-mcp/` | MCP server 编译产物 | 同上 | **是** |
| `resources/node_modules/` | 运行时依赖闭包 | 各包自己的 | 否（见 11.5） |

一份 `resources/package.json` 就位于前两个目录的**共同祖先**上，两者向上找都会先命中它。**逐文件实测过**（2026-10-25）：`resources/dist/server/y.js` 与 `resources/dist-mcp/arduino/x.js`，有该文件时各 0 条警告、删掉后各 1 条。放在 `dist/` 里就只能救 `dist/`，`dist-mcp/` 照旧。

`node_modules/` 也在同一层祖先下（`resources/package.json` 对它同样「最近」），但它**本来就不需要**这份声明，见下。

### 11.5 为什么它实际上不影响 `node_modules/` 里的第三方包

两层原因，第二层是这次读源码才知道的：

1. **Node 取的是最近的 `package.json`，不是最上面那份。** 第三方包各自带着自己的 `package.json`（`serialport`、`@serialport/*`、`@modelcontextprotocol/*` 全都有），查找在包的根目录就停下。实测：`resources/package.json` 声明 `type: module` 时，一个自己声明 `type: "commonjs"` 的包里的 ESM 语法文件**仍然报错**——控制权确实在包自己手里。
2. **`node_modules` 下的文件根本不会发这条警告。** `internal/modules/esm/get_format.js` 的 `warnTypelessPackageJsonFile` 第一句就是 `if (!underNodeModules(url) && !typelessPackageJsonFilesWarnedAbout.has(pjsonPath))`——URL 路径含 `/node_modules/` 时，即使控制它的 `package.json` 无 `type`、即使要重解析，也**静默**。实测：单独导入 `node_modules/<包>/lib/index.js`（包内 `package.json` 无 `type`、文件是 ESM 语法），有/无 `resources/package.json` 都是 0 条警告、都能加载。

所以 `node_modules/` 那一格既不会因为缺 `resources/package.json` 出问题，也不会因为多了它而出问题。**重解析的代价照旧存在**（`node_modules` 里只是不报警），这也是为什么真正要覆盖的是 `dist/` 与 `dist-mcp/`。

### 11.6 但 `node_modules/` 里确实有一个包**没有** `package.json`

`desktop/build/node_modules/@modelcontextprotocol/` 是**作用域目录**（scoped package 的父目录），它本身不是包，本来就不该有 `package.json`。真正的包在它下面（`client/`、`core/`、`server/`），三者的 `package.json` 齐全且都带 `type` 字段。这一条不是缺陷，只是提醒：看到 `@scope/` 下没有 `package.json` 不要误判。

### 11.7 一个容易误判的验证陷阱（实测踩过）

**在仓库里跑验证命令，测不出这个问题。** `desktop/dist-installer/win-unpacked/resources/` 位于仓库内部，它的祖先链上有 `desktop/package.json`（`"type": "module"`），所以即使在**删掉** `resources/package.json` 之后，警告计数依然为 **0**——看起来「没问题」，实际什么都没验证到。

实测确认过这个假阴性：删掉 `win-unpacked/resources/package.json`，再跑一遍那条验证命令，仍然得到 0。**所以「0」在仓库内不构成任何证据。**

要复现真实安装布局，必须把 `resources/` 复制到**仓库之外**的位置（且祖先链上不能有带 `type: module` 的 `package.json`），例如 `%TEMP%`。验证记录见 D-213。

### 11.7.1 顺便记住：警告是去重的

`typelessPackageJsonFilesWarnedAbout` 是一个 `SafeSet`，键是**控制文件 `package.json` 的路径**。一个进程里同一份 `package.json` 只报一次警告（实测：一个进程导入两个不同目录的 ESM `.js`，只报第一条）。

**去重只作用于文案，不作用于代价。** 每个 `.js` 的格式探测照旧逐个发生。所以「只看到一条警告」不等于「只有一个文件被重解析」，不能拿警告条数当受影响的文件数。

### 11.8 谁负责把它带进产物

`desktop/package.json`：

```json
"extraResources": [
  ...
  { "from": "resources-package.json", "to": "package.json" }
]
```

`to` 相对 `resources/`，所以落在 `resources/package.json`。**源文件名刻意不叫 `package.json`**——`desktop/` 下已经有一个给 electron-builder 读的 `package.json`（应用的 `main`、`build` 配置都在里面），同名会覆盖或混淆。

**改完必须重新完整打包才有产物证据**，`--dir` 也够验证布局（它同样会复制 `extraResources`），但发布前按 §2 跑完整 NSIS。

---

## 12. 应用内自动更新

用户装过一版之后，新版本**从应用里就能装**，不必再回 Releases 页面下载安装包。

### 12.1 用户怎么收到新版

三层，全部在**设置 → 关于**页：

| 环节 | 谁触发 | 用户看到 |
|---|---|---|
| 检查 | 启动时（可关，见「行为」页的「启动时检查更新」）或点「检查更新」 | 「正在检查…」→「已是最新版本。」/「有新版本：0.2.0」/ 失败原因 |
| 下载 | **只有用户点「下载」** | 「正在下载 42.3%」→「已下载；安装会重启应用。」 |
| 安装 | **只有用户点「重启并安装」** | 应用退出，NSIS 安装，装完自动启动新版本 |

有新版时，转录里还会多一行提示（`Embedded AI Master 0.2.0 is available (About → Check for updates).`）——同一个版本只提示一次。

### 12.2 更新源是什么

**GitHub Releases**，就是 §1 那个仓库，没有另设更新服务器。

安装版里有一份 `resources/app-update.yml`（由 `build.publish` 生成，完整 NSIS 打包才有，§4 讲过）：

```yaml
owner: mogenga
repo: Embedded-Ai-Master
provider: github
releaseType: release
updaterCacheDirName: embedded-ai-master-desktop-updater
```

`electron-updater` 24 小时最多查一次（库自己的节流），从
`https://github.com/mogenga/Embedded-Ai-Master/releases/latest/download/latest.yml` 读版本号与文件信息。**所以「发一个 release」就是「发一个新版本」**——`releaseType` 显式写的是 `release` 而不是默认的 `draft`，草稿不会出现在 `releases/latest`，因此也不会被更新器看到。

**发布流程本身不变**（§2）。唯一新增的约束：`latest.yml` 必须随 release 上传，否则用户会看到「该 release 缺少更新清单（latest.yml）」——那是发布事故，不是「没有新版本」。

### 12.3 为什么不做静默更新

这是刻意的，不是没做：

**检查可以自动，下载和安装不能。**

1. **用户可能正在长任务里。** 装更新要先退出应用；一次跑了十几分钟的构建或调试会话没有理由被一个后台动作打断。
2. **静默变更让「同一问题回答不同」无法解释。** 这条理由与 `docs/operations/corpus-ota.md` §6 对语料 OTA 的结论是同一个：如果某天回答开始不一样，而用户没做任何事，他就失去了唯一的解释线索。应用升级比语料替换动的东西更多。
3. **下载要占带宽和磁盘。** 安装包 113 MB；用户的网络可能是计费的。

代码上不是「默认关掉」而是**显式关掉**：

```js
updater.autoDownload = false;          // 库默认 true：检查到就下
updater.autoInstallOnAppQuit = false;  // 库默认 true：正常退出就装
```

两个开关都在 `desktop/updater.js` 的 `ensureUpdater()` 里，测试 `tests/desktop/updater.test.js` 有一条专门断言它们被设成 `false`。

### 12.4 失败时用户看到什么

**每一类失败都有自己的句子，绝不会把失败显示成「已是最新版本」（R3）。**

| 状态 | 页面上的文案 | 通常意味着 |
|---|---|---|
| 网络失败 | 「检查更新失败：连不上更新服务器。」 | 断网、代理、DNS |
| 没有 release | 「…没有找到已发布的版本。」 | 仓库还没有正式 release |
| 缺 `latest.yml` | 「…该 release 缺少更新清单（latest.yml）。」 | **发布事故**：附件漏传 |
| 签名不符 | 「…下载到的更新未由发布者签名。」 | 证书换了或包被替换 |
| 校验和不符 | 「…下载的文件与其校验和不符。」 | 传输损坏或清单与包不一致 |
| 下载失败 | 「…更新文件下载失败。」 | 资产 404、磁盘满、被中断 |
| 配置错误 | 「…更新源配置不正确。」 | `app-update.yml` 缺失或 provider 不合法 |
| 清单格式错误 | 「…release 清单格式不正确。」 | `latest.yml` 内容坏了 |
| 无法识别 | 「…更新模块报了一个无法识别的错误。」 | 库新增了错误码 |
| 开发形态 | 「开发形态不提供更新：更新源只存在于安装后的版本里。」 | 从源码跑 `npm run desktop` |
| 缺依赖 | 「当前构建缺少更新模块，无法检查更新。」 | `electron-updater` 没装进包 |

错误后面还会跟一段括号里的原始信息（已脱敏：URL 的 query 与 token 值被抹掉）。**开发形态与缺依赖这两条不画按钮**——按了也只会得到同一句话，那是 D-188 那类假控件。

### 12.5 为什么不在宿主里做

**宿主进程里做不了。** `desktop/host/host.js` 是以 `ELECTRON_RUN_AS_NODE=1` 启动的普通 Node 进程，没有 Electron API；`electron-updater` 的 `ElectronAppAdapter` 第一行就是 `require("electron").app`。所以更新器放在 `desktop/main.js`（Electron 主进程）里，宿主完全不知道有这回事。

链路：

```
main.js ──createUpdater()──> updater.js ──> electron-updater
   │                                            │
   └─ ipcMain.handle: update-check/-download/-install
   │
   └─ BrowserWindow.webContents.send("host-event", {type:"update_status", status})
                         │
              preload.cjs 白名单: updateStatus/updateCheck/updateDownload/updateInstall
                         │
              renderer: 设置 → 关于
```

**状态走的是宿主同一条 `host-event` 通道**，没有第二根管子：渲染层只有一处读事件的地方，也就不存在「两条通道的顺序谁先」的问题。

### 12.6 已知边界

1. ~~**一次真实的更新从未跑过。**~~ **2026-11-09 已跑通**：旧版收到新版提示 → 下载 → 重启安装完成，用户实测。D-212 的这条残余关闭。**但只跑过一次**——一次成功不等于这条路径在各个中间版本、各种网络条件下都稳；后续版本仍应在发布后做一次同样的验证。
2. **未签名期间，下载到的更新包不做签名校验。** `electron-updater` 在 `app-update.yml` 没有 `publisherName` 时直接放行；而 `publisherName` 只在有证书时才写得进去。完整性目前只靠 `latest.yml` 的 `sha512`。见 **D-217**。
3. **`quitAndInstall` 的 NSIS 行为**：调用是非静默的（`quitAndInstall(false, true)`），用户看得见安装进度；安装器收到 `--updated` 后走「等待应用退出 → 仍在就结束进程」的免确认路径。**2026-11-09 的那次真实更新走过这条路径**，与源码推断一致。
4. **更新要重启应用。** 没有热替换；正在跑的回合会随退出结束。
5. **`electron-updater` 是运行时依赖，必须真的装进包。** `desktop/package.json` 的 `build.files` 里已加 `updater.js`；依赖本身由 `scripts/package-prepare.mjs` 的运行时闭包带进 `resources/node_modules`（与内核依赖同一条路）。**装完 `npm --prefix desktop install` 后要重新完整打包**，否则旧包里没有它，用户会看到「当前构建缺少更新模块」。

---

## 13. 相关条目

- **D-212** —— 发布链路已跑通（`v0.1.0`–`v0.3.0` 八个 release）；应用内自动更新已接入（**2026-10-25 已解决**），**一次真实的更新已于 2026-11-09 跑通**，残余见 §12.6。
- **D-217** —— 未签名构建下 `publisherName == null` 时下载包不做签名校验。
- **D-211** —— 签名配置就位但从未验证过真实签名。
- **D-208** —— 真实安装包从未产出（**2026-11-03 已解决**：v0.1.5 安装包在干净机器上安装验证通过）。
- **D-209** —— 根与 `desktop/` 的 Electron 版本不一致。
- **D-213** —— `resources/` 缺 ESM 模块声明，所有安装用户多付一次重解析（2026-10-25 已修，见 §11）。
