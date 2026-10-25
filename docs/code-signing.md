# Windows 代码签名

> 建立：2026-10-25。发布渠道已定：**GitHub Releases**，本机手工执行（仓库里**没有** GitHub Actions workflow，本文不提供 CI 配置）。
> 事实基准：`electron-builder` **26.15.3**，用的是 **v26 配置格式**（`win.signtoolOptions`）。v27 把 Windows 签名统一成 `win.sign` 判别联合，那份文档不适用于本仓库；升级 electron-builder 大版本时本文的配置项要整体重写。

## 1. 为什么需要签名

不签名的安装包，用户双击后会看到 SmartScreen 的整屏红色警告：

> Windows 已保护你的电脑
> 应用: Embedded AI Master Setup 0.1.0.exe
> 发布者: 未知发布者

默认按钮是**「不运行」**，「更多信息 → 仍要运行」藏在二级。大多数用户到这一步就放弃了——不是「体验差一点」，是**装不上**。

签名的另外两个作用，与本项目直接相关：

- **`app-update.yml` 的更新校验**：`electron-updater` 会拿这个文件里的 `publisherName` 与下载回来的安装包的签名主体比对。`desktop/package.json` 已配置 `publish`（github provider），NSIS 目标会写出 `app-update.yml`。没签名时这个字段没有值可填。
- **篡改检测**：下载环节被替换的安装包，签名验证会失败。

### 必须说清的一件事：**签名不等于没有警告**

**新签发的证书不会立刻消除 SmartScreen 警告。** SmartScreen 的信誉按证书（以及文件哈希）累积，来源是下载量与时间：

- **OV 证书**：信誉从零开始，通常需要数周到数月、攒到足够的干净下载量，警告才会逐步消失。期间用户仍会看到警告，只是可能从「未知发布者」变成有名字的发布者。
- **EV 证书**：微软对 EV 有更快的信誉通道，通常几天内就能摆脱警告，但**不是签完立刻生效**。

不要向用户承诺「签了就没警告」。准确的说法是：**签名把「未知发布者」变成「有名字的发布者」，并为 SmartScreen 信誉累积提供起点；警告何时消失取决于下载量与时间，不由签名本身决定。**

## 2. 两条可选路径

### ① 传统证书（OV / EV）

| | OV | EV |
|---|---|---|
| 年费（量级） | 约 ¥1000 | 约 ¥3000–5000 |
| 签发方式 | 线上验证企业/个人信息，`.pfx` 直接下发 | 需硬件令牌（USB Key / HSM），私钥不可导出 |
| SmartScreen 信誉 | 慢（数周到数月） | 快（通常数天） |
| 与 electron-builder 的配合 | 最顺，`WIN_CSC_LINK` 指向 `.pfx` | 需要 `certificateSubjectName` 从证书存储里选，见下 |

**OV 的操作步骤**（拿到 `.pfx` 之后）：

```bash
# 证书放在仓库之外，例如 C:\Users\<you>\certs\embedded-ai-master.pfx
export WIN_CSC_LINK="C:\\Users\\<you>\\certs\\embedded-ai-master.pfx"
export WIN_CSC_KEY_PASSWORD="<pfx password>"

npm --prefix desktop run dist
```

**不需要改任何构建配置**——electron-builder 自己发现 `WIN_CSC_LINK`。`WIN_CSC_LINK` 接受三种形态：**文件路径**、`https://` URL、**base64 编码的证书**。CI secret 场景用 base64（`WIN_CSC_LINK` 值直接放 base64 串即可）。

**EV 的差别**：私钥在令牌里，没有 `.pfx` 可指。做法是把证书装进 Windows 证书存储，然后配置 `certificateSubjectName`（或 `certificateSha1` 区分多张同名证书），让 signtool 从存储里选。这两个字段因证书而异，**不写进 `desktop/package.json`**，用环境变量或本地覆盖配置传（见 §4）。

### ② Azure Trusted Signing

按量计费，比买 OV/EV 便宜得多（月费 + 每次签名少量费用，具体价格看 Azure 当期价目表）。代价是前置步骤多，而且**证书不在你手里**——微软托管，签名通过 Azure API 完成。

前置：

1. 一个 Azure 订阅；
2. 一个 **Entra ID App registration**（客户端 ID + 租户 ID + client secret）；
3. 一个 **Trusted Signing Account**（选区域）；
4. 在该账号下建一个 **Certificate Profile**（类型可选 Public Trust 等）。

v26 的配置位置是 `win.azureSignOptions`（注意：**与 `signtoolOptions` 二选一**，两者同时存在时 electron-builder 会打印 `ignoring signtool options, using Azure Trusted Signing` 并走 Azure）：

```json
"win": {
  "target": "nsis",
  "azureSignOptions": {
    "endpoint": "https://<region>.codesigning.azure.net",
    "codeSigningAccountName": "<trusted signing account name>",
    "certificateProfileName": "<certificate profile name>",
    "publisherName": "CN=<your org>, O=<your org>, C=<country>"
  }
}
```

- `endpoint` / `codeSigningAccountName` / `certificateProfileName` / `publisherName` 四项在 v26 的 schema 里是**必填**（缺一项 schema 校验就不过）。
- 认证靠 `Azure.Identity.EnvironmentCredential`，需要环境变量 `AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET`（若改用证书认证，则是 `AZURE_CLIENT_CERTIFICATE_PATH` + `AZURE_CLIENT_SEND_CERTIFICATE_CHAIN`）。
- v26 走的还是 PowerShell 集成：构建时会 `Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Scope CurrentUser`。**第一次跑需要联网**并且当前用户能装 PSGallery 模块。
- `publisherName` **必须与 Azure 证书的 Subject 完全一致**，因为它会被写进 `app-update.yml`，`electron-updater` 逐字符比对。

**为什么 Azure 路径的 `publisherName` 必须显式配**：在 v26 里，Azure 管理器不做证书反查——`WindowsSignAzureManager.computedPublisherName` 只读 `azureSignOptions.publisherName`，没有就从签名结果里推不出来。而 signtool 路径可以靠读 `.pfx` 的 CN 自动填。

## 3. 当前配置：只放时间戳，不放证书

`desktop/package.json` 的 `win` 段现在是：

```json
"win": {
  "target": "nsis",
  "signtoolOptions": {
    "timeStampServer": "http://timestamp.digicert.com",
    "rfc3161TimeStampServer": "http://timestamp.digicert.com"
  }
}
```

只加时间戳服务器，**刻意不加** `certificateFile` / `certificatePassword` / `certificateSubjectName` / `publisherName`——这些值因证书而异，写进仓库等于把「这台机器的证书」固化成项目配置；换人、换证书、换 CI 都要改代码。正确的位置是环境变量（`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`）或 CI secret。

### 时间戳为什么必须配

签名带时间戳 = 「这个文件在某个时刻是有效的」。**不带时间戳的签名，证书一过期，所有旧安装包的签名一起失效**——用户装 2 年前下载的版本会看到签名无效。RFC3161 时间戳由可信时间源背书，让旧签名在证书过期后仍然可验证。

v26 的两个字段都指向同一个服务器，但用途不同：

| 字段 | signtool 参数 | 何时用 |
|---|---|---|
| `rfc3161TimeStampServer` | `/tr` | SHA-256 签名与嵌套签名 |
| `timeStampServer` | `/t` | SHA-1 签名 |

`computeWindowsSignArgs` 按当前这一轮的 hash 算法二选一。**默认 `signingHashAlgorithms` 是 `['sha1', 'sha256']`（双签）**，所以签一次文件会走两轮：第一轮 SHA-1 用 `/t` + `timeStampServer`，第二轮 SHA-256 用 `/tr` + `rfc3161TimeStampServer`。两个字段都会实际生效。

两个都配成 `http://timestamp.digicert.com`，是因为只配一个会让另一轮回落到内置默认值。而内置默认值恰好也是这个地址，所以**当前配置在行为上等价于不配**——显式写出来是为了「换时间源时有唯一一处可改」，以及防止将来默认值变化造成「另一轮悄悄用了别的服务器」。

### 环境变量方案不需要任何配置

这一点值得单独强调，因为它经常被误解：**只要设了 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`，哪怕 `signtoolOptions` 里什么都不写，electron-builder 也会签名。** 依据是 `WindowsSignToolManager.cscInfo` 的解析顺序（从 `node_modules/app-builder-lib/out/codeSign/windowsSignToolManager.js` 读出）：

1. `signtoolOptions.certificateSubjectName` 或 `certificateSha1` → 从 Windows 证书存储取；
2. `signtoolOptions.certificateFile` → 用 `certificatePassword` 或 `WIN_CSC_KEY_PASSWORD` 开；
3. `WIN_CSC_LINK`（回落到 `CSC_LINK`）→ 导入到临时目录再签；
4. 全都没有 → `null`，跳过签名。

密码的解析顺序是 `signtoolOptions.certificatePassword` → `WIN_CSC_KEY_PASSWORD` → `CSC_KEY_PASSWORD`。

## 4. 如果以后要固定 `publisherName`

需要固定的场景是 **Azure 路径**（见 §2）以及 **自定义签名钩子**（`signtoolOptions.sign`，electron-builder 读不到钩子用的证书）。**signtool + `.pfx` 路径不需要**——它会自动从证书 CN 取值。

- **写在哪**：`desktop/package.json` → `build.win.signtoolOptions.publisherName`（signtool 路径）；或 `build.win.azureSignOptions.publisherName`（Azure 路径）。两者位置不同，别混。
- **从哪取值**：拿一个已经签好名的二进制，读它的签名主体。Windows 上是
  `(Get-AuthenticodeSignature .\<App>.exe).SignerCertificate.Subject`——**但本机该 cmdlet 加载失败**（见 §6），所以退一步用 `signtool verify /pa /v` 看输出，或直接从签发证书的 Subject 字段抄。
- **格式**：必须与证书 Subject 逐字符一致，通常是 `CN=<name>, O=<org>, C=<country>` 形式。写错一个字符，安装后的应用会拒绝**之后每一个**更新。
- **它进了 `app-update.yml`**：阅读 `PublishManager.getAppUpdatePublishConfiguration` 可知，Windows 平台的 `publishConfig.publisherName` 默认由 `signingManager.computedPublisherName` 填入（当 `win.verifyUpdateCodeSignature !== false`，即默认）。这个值随安装包分发，是更新校验的锚点。

## 5. 证书绝不能进仓库

`.gitignore` 已有这一组（见「密钥与证书」段落）：

```
*.pem
*.key
*.p12
*.pfx
*.jks
*.keystore
*.asc
*.sig
id_rsa* / id_ed25519* / id_ecdsa* / id_dsa*
```

**为什么不能靠「记得别提交」**：

- 一次 `git add -A` 就会带上未跟踪的 `.pfx`；
- **git 历史里的文件删不掉**：`git rm` 只删工作区与最新提交，历史提交仍可被 clone。要真正清除得 rewrite history + 强推 + 所有 fork/缓存失效——代价远高于重新签发；
- 私钥泄露 = 他人可以冒用你的身份签名恶意程序，且**证书吊销（CRL）传播需要时间**，期间所有旧安装包的信任都会被牵连；
- 本仓库会分发到 GitHub Releases，一旦推上去就在别人的 clone 里了。

**正确做法**：证书放在仓库**之外**的目录（例如 `C:\Users\<you>\certs\`），通过环境变量引用；CI 场景放 secret。文件名用 `.pfx` 后缀能享受上述 gitignore 规则，但**不要依赖它**——它防的是误 `git add`，防不住 `git add -f`、也防不住把内容粘进 `.env.example` 或文档。

## 6. 如何验证签名真的生效

### 首选：本仓库的脚本

```bash
node scripts/verify-signature.mjs "desktop/dist-installer/win-unpacked/Embedded AI Master.exe"
```

退出码：`0` 全部已签名 / `1` 任一未签名 / `2` 任一无法检查（文件不存在、不是 PE、读失败）。可直接当发布门禁：

```bash
node scripts/verify-signature.mjs "desktop/dist-installer/Embedded AI Master Setup 0.1.0.exe" \
  && echo "签名验证通过"
```

脚本只读 PE 头的 Security Directory（数据目录第 4 项）的 Size 字段，`size > 0` 即「有证书表」。

**它验证的是「有没有签名」，不是「签名有没有效」**——不校验证书链、摘要、时间戳。要判有效性，用下面的手段。

### `Get-AuthenticodeSignature` 在本机不可用

本机 PowerShell 加载该 cmdlet 失败：

```
Get-AuthenticodeSignature : 在模块"Microsoft.PowerShell.Security"中找不到
Get-AuthenticodeSignature 命令，但无法重复模块……
FullyQualifiedErrorId : CouldNotAutoloadMatchingModule
```

这是 PowerShell 模块加载环境的问题，不是签名的问题。所以本文的验证路径以脚本与 `signtool` 为准。

### `signtool verify`

Windows SDK 自带。本机装了多个版本：

```bash
"/c/Program Files (x86)/Windows Kits/10/bin/10.0.22621.0/x64/signtool.exe" verify /pa /v "<file>"
```

- 已签名且有效：`Number of files successfully Verified: 1`，退出码 0，并列出 Algorithm / Timestamp。
- 未签名：`SignTool Error: No signature found.`，退出码 1。
- **git-bash 用户注意**：`/pa` 会被 MSYS 当成路径转换（错误会变成 `File not found: D:/Git/pa`）。加 `MSYS_NO_PATHCONV=1` 前缀，或在 PowerShell / cmd 里跑。

## 7. 无证书时的行为

**这是最容易误解的一点，必须写清。**

没有证书（没有 `WIN_CSC_LINK`、没有 `signtoolOptions.certificateFile`、没有 `certificateSubjectName`）时，构建日志会出现：

```
• signing with signtool.exe  path=dist-installer\win-unpacked\Embedded AI Master.exe
```

**这一行不代表签了名。** `signWindows()` 在调用签名管理器之前就无条件打印这行（`windowsCodeSign.js:13`），而真正判断签不签的逻辑在后面：`signFile()` 里 `cscInfo` 为 `null` 且没有自定义 `sign` 钩子时，打印的是

```
• no signing info identified, signing is skipped
```

……然后 `return false`，`doSign` 根本没被调用，**signtool.exe 从未执行**。2026-10-25 实测（`DEBUG=electron-builder`）：

```
• signing with signtool.exe  path=dist-installer\win-unpacked\Embedded AI Master.exe
• no signing info identified, signing is skipped  signHook=false cscInfo=null
```

产物用 `scripts/verify-signature.mjs` 检查：

```
[未签名] desktop/dist-installer/win-unpacked/Embedded AI Master.exe
         PE32+  Security Directory: size=0（0x0）
```

退出码 1。所以判据只有两个：**脚本的退出码**，或者日志里的 `no signing info identified` 那一行。看到 `signing with signtool.exe` 就当签过了，是错的。

（附带的好处：`--dir` 构建在无证书时**不会**去下载 winCodeSign 工具链——它在 `doSign` 里才需要。所以没证书时 `--dir` 构建是纯离线的。）

### 想让「忘配证书」变成硬失败

`win.forceCodeSigning: true` 会让 `signIf` 在未签名时抛 `InvalidConfigurationError`。**当前没有开启**——本机无证书，开了会让日常构建直接失败。等证书就位、每次构建都应当签名时再开，这是让「签名静默跳过」无法被忽略的唯一开关。

## 8. 发布流程（当前状态）

1. `npm run build` 与 `npm run build:mcp`（生成 `dist/`、`dist-mcp/`）；
2. `node scripts/corpus-stage.mjs ...` 暂存语料到 `desktop/build/corpus/`；
3. 设置 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`（有证书时）；
4. `npm --prefix desktop run dist`（内部先跑 `scripts/package-prepare.mjs`，再 `electron-builder`）；
5. `node scripts/verify-signature.mjs "desktop/dist-installer/Embedded AI Master Setup <ver>.exe"`，退出码必须是 0；
6. 把 `desktop/dist-installer/` 下的安装包与 `.blockmap` 传到 GitHub Releases。

**本仓库暂无 GitHub Actions workflow，发布目前是本地手工执行。** 第 3 步的变量只存在于执行者的 shell 会话里，不要在仓库里建 `.env` 保存它们——`.gitignore` 虽然忽略 `.env`，但那仍是把秘密放进了工作区。

## 9. 相关条目

- `docs/deferred-issues.md` **D-211**：签名配置就位但从未验证过真实签名（本机无证书）。
- `docs/deferred-issues.md` **D-208**：真实安装包从未产出。
- `scripts/verify-signature.mjs`、`tests/verify-signature.test.ts`：签名检查脚本与其测试。
