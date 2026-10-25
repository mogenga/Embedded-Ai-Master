# 发布到 GitHub Releases

本文件是发布流程的唯一操作手册。发布渠道是 **GitHub Releases**（不是 npm、不是自建更新服务器）。

相关文档：

- `docs/code-signing.md` —— Windows 代码签名（证书从哪来、怎么配、怎么验）。
- `docs/deferred-issues.md` **D-212** —— 发布链路从未真正跑过一次，且没有应用内自动更新。
- `docs/deferred-issues.md` **D-211** —— 签名配置就位但从未验证过真实签名。
- `docs/deferred-issues.md` **D-209** —— 根与 `desktop/` 的 Electron 版本不一致。

---

## 1. 当前状态（2026-10-25 实测）

| 项 | 状态 | 依据 |
|---|---|---|
| 仓库 | `mogenga/Embedded-Ai-Master`，**public** | GitHub API 实测 `private: false`、`visibility: public` |
| Releases | **一条都没有** | `has_downloads: false`，从未发布过 |
| `desktop/package.json` 的 `build.publish` | 已配置 GitHub provider | `npx electron-builder --win --x64 --dir` 退出 0，schema 接受 |
| `gh` CLI | **已安装且已登录**，但**不在 `PATH` 里** | 版本 2.103.2，路径 `C:\Program Files\GitHub CLI\gh.exe`；`gh auth status` 退出 0，账号 `mogenga` |
| `electron-updater` | **未安装** | `package.json` / `desktop/package.json` 里都没有这个依赖 |
| 应用内自动更新 | **没有** | 宿主没有任何更新检查代码 |
| 签名 | 配置就位，**从未真实签过** | 本机无证书，见 `docs/code-signing.md` §7 |
| 图标 | 未设置 | 构建日志 `default Electron icon is used` |

**两条由此推出的结论，写在这里免得被误解：**

1. **用户收不到应用内更新提醒。** 没有 `electron-updater`，安装了旧版的用户不会被告知有新版本。他们只能自己去
   `https://github.com/mogenga/Embedded-Ai-Master/releases` 看。这是 D-212 的一半。
2. **`latest.yml` 目前是死文件。** 它由 electron-builder 生成、随 release 上传，但仓库里没有任何代码读它。先产出来不碍事——将来接了 `electron-updater` 就是现成的，不用回头重发旧版本。

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

（上面是按源码换算出的预期形状，`url` / `path` 的名字规则见 §2 末。因为从未跑过完整 NSIS 打包，**这份内容没有产物证据**，只有源码依据——D-212 记录了这一点。）

**本项目现在没有接 `electron-updater`，所以它暂时没用。** 先产出来不碍事：接了之后，已经发布的旧版本能直接指向这份文件，不必重发。这是 D-212 的另一半。

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

签名怎么做、证书从哪来、怎么验证是否签上，全部在 **`docs/code-signing.md`**。要点复述三条：

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
| 构建日志有 `signing with signtool.exe` 但产物未签名 | 那行在判断之前无条件打印 | 以 `verify-signature.mjs` 的结果为准，见 `docs/code-signing.md` §7 |
| `gh release create` 后 tag 指向了别的提交 | 先建 release 后打 tag | 先推 tag，或加 `--verify-tag`，见 §2 |
| 手动上传后远端资产名与 `latest.yml` 里的不一致 | GitHub 把空格改写为连字符 | 见 §2 末「手动上传时要注意文件名不一致」 |
| 用户说「我没收到更新提醒」 | 没有 `electron-updater` | 这是 D-212，不是 bug |

---

## 11. 相关条目

- **D-212** —— 发布链路从未真正跑过一次 release；`electron-updater` 未接入。
- **D-211** —— 签名配置就位但从未验证过真实签名。
- **D-208** —— 真实安装包从未产出（已被 2026-10-25 的 113 MB 产物部分关闭，仍缺干净机器安装验证）。
- **D-209** —— 根与 `desktop/` 的 Electron 版本不一致。
