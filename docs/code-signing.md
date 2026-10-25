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

#### 价格与购买（2026-10-25 查证，一手页面）

上表的人民币量级是**估算**，可核对的一手美元价如下。这些是**牌价/经销价，不是报价单**；实际成交价要询价，且会随时间与促销变化——**买之前自己去页面确认，不要拿这个数字做预算承诺**。

| 来源 | 产品 | 牌价 | 页面折后 |
|---|---|---|---|
| CodeSigningStore | DigiCert OV Code Signing | `$539/yr` | `$404/yr` |
| CodeSigningStore | Sectigo OV Code Signing | `$379/yr` | `$302.10/yr` |
| CodeSigningStore | （第三个 OV 档） | `$290.69/yr` | `$235/yr` |
| CodeSigningStore | DigiCert EV Code Signing | `$755/yr` | `$566/yr`（另加令牌运费 `$90–140`） |
| CodeSigningStore | Sectigo EV Code Signing | `$498/yr` | `$395.91/yr` |
| Sectigo 官网 FAQ | Code Signing（未区分 OV/EV） | — | 「starts at `$536.25` per year」（五年期折算） |

换算成人民币量级：OV 约 **¥1,700–3,900/年**，EV 约 **¥2,900–5,400/年**（按 7.2 粗算，未含令牌运费与税费）。原表「OV 约 ¥1000」**偏低**，实际入门档也在 ¥1,700 上下——买之前按 ¥2,000+ 预估。

**硬件令牌是所有证书的硬要求，不只是 EV。** CA/Browser Forum Code Signing Baseline Requirements §6.2.7.4.2（2023-06-01 生效）：「CAs **SHALL** ensure that the Subscriber's Private Key is generated, stored, and used in a suitable Hardware Crypto Module」——OV 与 EV 一视同仁。所以「OV 能直接拿到 `.pfx`」这个说法**只在「CA 提供了云签名/托管密钥」时有条件成立**；传统 OV 同样是一枚 USB 令牌，私钥不可导出。

这对本项目的直接影响：**`.pfx` 这条最顺的路，多数新签发的证书给不了你**。买之前先问清两件事：

1. 私钥是否可导出成 `.pfx`（可导出 → `WIN_CSC_LINK` 直接可用）；
2. 若不可导出，是否提供**云签名服务**（DigiCert KeyLocker / Sectigo 签名服务等）。这类服务各有自己的 CLI 与凭据，**不在 `WIN_CSC_LINK` 的能力范围内**，需要走 `signtoolOptions.sign` 自定义钩子或厂商的签名命令——这条本仓库**没有实现**。

**能否以个人身份买**：OV/EV 都要过组织/个人身份验证（营业执照或政府证件、可回拨电话、域名邮箱）。个人开发者可以买，但需要能证明「这个名字对应一个真实主体」的材料；不同 CA 对「个人」的接受度不同，**下单前直接问 CA**，不要照抄别人的经验。

**OV 的操作步骤**（拿到可导出的 `.pfx` 之后）：

```bash
# 证书放在仓库之外，例如 C:\Users\<you>\certs\embedded-ai-master.pfx
export WIN_CSC_LINK="C:\\Users\\<you>\\certs\\embedded-ai-master.pfx"
export WIN_CSC_KEY_PASSWORD="<pfx password>"

npm --prefix desktop run dist
```

**不需要改任何构建配置**——electron-builder 自己发现 `WIN_CSC_LINK`。`WIN_CSC_LINK` 接受三种形态：**文件路径**、`https://` URL、**base64 编码的证书**。CI secret 场景用 base64（`WIN_CSC_LINK` 值直接放 base64 串即可）。

**EV 的差别**：私钥在令牌里，没有 `.pfx` 可指。做法是把证书装进 Windows 证书存储，然后配置 `certificateSubjectName`（或 `certificateSha1` 区分多张同名证书），让 signtool 从存储里选。这两个字段因证书而异，**不写进 `desktop/package.json`**，用环境变量或本地覆盖配置传（见 §4）。

### ② Azure Trusted Signing（现名 **Artifact Signing**）

> **改名（2026-10-25 查证）**：微软已把该服务从 **Trusted Signing** 更名为 **Artifact Signing**，文档站 `/azure/trusted-signing/...` 301 到 `/azure/artifact-signing/...`，定价页 `pricing/details/trusted-signing/` 301 到 `pricing/details/artifact-signing/`。**electron-builder 26.15.3 仍用旧名**（配置键 `azureSignOptions`、PowerShell 模块 `TrustedSigning`、资源提供者 `Microsoft.CodeSigning`），所以本文的配置片段不变，只是别再照旧名去搜微软文档。

按量计费，比买 OV/EV 便宜得多。以下是 Azure 零售价 API（`prices.azure.com`，`serviceName eq 'Trusted Signing'`，2026-10-25 查询）返回的**确切数字**：

| | Basic | Premium |
|---|---|---|
| 月费 | **$9.99** | **$99.99** |
| 含签名数/月 | 5,000 | 100,000 |
| 超额 | **$0.005/次** | **$0.005/次** |

（单位 `1/Month`，货币 USD。）本项目每次发布签 3 个 PE，Basic 档的 5,000 次/月远超所需——**$9.99/月 ≈ ¥72/月 ≈ ¥860/年**，约为 OV 证书的一半到三分之一，且没有硬件令牌。

**前置**：

1. 一个 Azure 订阅；
2. 一个 **Entra ID App registration**（客户端 ID + 租户 ID + client secret）；
3. 一个 **Artifact Signing Account**（选区域，Basic 或 Premium SKU）；
4. 在该账号下建一个 **Certificate Profile**（类型可选 Public Trust 等）；
5. **Identity validation**（个人或组织）——这一步才是真正的门槛，见下。

**资格限制（这条最关键，2026-10-25 从 `learn.microsoft.com/azure/artifact-signing/quickstart` 的 Prerequisites 原文读出）**：

> Public Trust certificates are available to organizations in the United States, Canada, the European Union, the United Kingdom, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, and Israel. **Individual developers must be located in the United States or Canada.**

**中国大陆不在 Public Trust 的组织名单里，个人开发者仅限美国/加拿大。** 所以对本项目而言，Azure 这条路**当前走不通**——除非有上述国家/地区的实体，或改用 Private Trust（不受地域限制，但 Private Trust 签出来的东西只有自己信任的机器认，对公开分发无意义）。

另外两个容易踩的点（同页原文）：

- 个人身份验证的姓名与地址**取自 Azure 账单账户**，且账单账户的 `Account Type` 必须是 `Individual`；账单上的法定姓名与 sold-to 地址必须与政府证件一致，且**会出现在 Public Trust 证书里**。
- Artifact Signing 的证书**每天轮换、有效期仅 72 小时**。这意味着 `app-update.yml` 里的 `publisherName`（取自证书 CN）虽然是稳定的，但**任何「按指纹/公钥固定信任」的做法都会失效**——微软用自定义 EKU 做长期身份标识。对 `electron-updater` 无影响（它比的是 CN/DN）。

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

**`signtoolOptions` 与 `azureSignOptions` 互斥这条仍然成立**（2026-10-25 复核源码）：`windowsCodeSign.js:6-10` 在 `options.options.azureSignOptions` 存在时打印 `ignoring signtool options, using Azure Trusted Signing; please only configure one` 并走 Azure 分支。**注意这意味着一旦切到 Azure，上面刚加的 `signingHashAlgorithms: ["sha256"]` 会被整个忽略**——Azure 分支根本不读 `signtoolOptions`，它用自己的 `fileDigest` / `timestampDigest`（默认都是 `SHA256`）。所以走 Azure 时不需要、也不能靠那个字段来避免 SHA-1 问题。

**`app-update.yml` 里的 `publisherName` 长什么样（实测形状，不是推测）**：用一张 CN 为 `Embedded AI Master Test` 的临时自签名证书跑完整 NSIS 打包后，产物里的 `resources/app-update.yml` 是：

```yaml
owner: mogenga
repo: Embedded-Ai-Master
provider: github
releaseType: release
updaterCacheDirName: embedded-ai-master-desktop-updater
publisherName:
  - Embedded AI Master Test
```

即：**数组，值是证书 CN**（不是完整 DN）。`NsisUpdater.verifySignature` 读这个字段后调 `Get-AuthenticodeSignature` 比对——它支持完整 DN 逐项比对，也支持只比 CN（后者会打一条 `Signature validated using only CN ... Please add your full Distinguished Name (DN)` 的 warn）。所以**用 `.pfx` 自动填出来的 CN 是能通过校验的**，只是带一条警告；想消掉警告就在 `signtoolOptions.publisherName` 里写完整 DN。

## 3. 当前配置：只放时间戳与 hash 算法，不放证书

`desktop/package.json` 的 `win` 段现在是：

```json
"win": {
  "target": "nsis",
  "signtoolOptions": {
    "signingHashAlgorithms": ["sha256"],
    "timeStampServer": "http://timestamp.digicert.com",
    "rfc3161TimeStampServer": "http://timestamp.digicert.com"
  }
}
```

只加时间戳服务器与 hash 算法，**刻意不加** `certificateFile` / `certificatePassword` / `certificateSubjectName` / `publisherName`——这些值因证书而异，写进仓库等于把「这台机器的证书」固化成项目配置；换人、换证书、换 CI 都要改代码。正确的位置是环境变量（`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`）或 CI secret。

### 为什么显式写 `signingHashAlgorithms: ["sha256"]`（2026-10-25 实测）

**默认值是 `['sha1', 'sha256']`（双签），而它的第一轮在本机的新版 signtool 上直接失败。**

`computeWindowsSignArgs` 拼参数时，**只有 `options.hash !== "sha1"` 才 push `/fd`**。所以默认双签的第一轮是：

```
signtool sign /t http://timestamp.digicert.com /f <pfx> /d <name> /p <pwd> /debug <file>
```

拿本机 Windows Kits **10.0.22621.0** 的 `signtool.exe` 跑这条命令，退出码 1：

```
SignTool Error: No file digest algorithm specified. Please specify the digest algorithm with the /fd flag.
```

旧版 signtool 会隐式按 SHA-1 处理，所以这条只有在较新 SDK 上才会暴露。后果**不是「签名被跳过」而是整个打包失败**（`failedTask=build`）。实测：加上 `"signingHashAlgorithms": ["sha256"]` 后同一打包退出 0，`Embedded AI Master.exe` / `eam-Setup.exe` / `resources/elevate.exe` 三个 PE 全部带上证书表。

**取舍**：这样签名只覆盖 SHA-256 摘要（单签），不再有 SHA-1 老式签名。对 Windows 10 及以上没有影响；本项目的支持范围是 Windows 10+，因此接受这个取舍。若将来需要 SHA-1 兼容，把数组改回 `["sha1","sha256"]`，**同时**必须在能接受无 `/fd` 的旧 signtool 上构建（或改走 electron-builder 自带工具链），否则构建会失败。

**注意 electron-builder 自带的工具链未经本机验证**：它默认用 winCodeSign 包里 `windows-10/x64/signtool.exe`，本次实验尝试下载时遇到 `ECONNRESET`，改用 `SIGNTOOL_PATH` 指向本机 SDK 才跑通。所以上面这条错误是**本机 SDK 的行为**；自带工具链是否同样拒绝，未验证。

### 时间戳为什么必须配

签名带时间戳 = 「这个文件在某个时刻是有效的」。**不带时间戳的签名，证书一过期，所有旧安装包的签名一起失效**——用户装 2 年前下载的版本会看到签名无效。RFC3161 时间戳由可信时间源背书，让旧签名在证书过期后仍然可验证。

v26 的两个字段都指向同一个服务器，但用途不同：

| 字段 | signtool 参数 | 何时用 |
|---|---|---|
| `rfc3161TimeStampServer` | `/tr` | SHA-256 签名与嵌套签名 |
| `timeStampServer` | `/t` | SHA-1 签名 |

`computeWindowsSignArgs` 按当前这一轮的 hash 算法二选一。**默认 `signingHashAlgorithms` 是 `['sha1', 'sha256']`（双签）**，所以签一次文件会走两轮：第一轮 SHA-1 用 `/t` + `timeStampServer`，第二轮 SHA-256 用 `/tr` + `rfc3161TimeStampServer`。两个字段都会实际生效。

**但本仓库现在把 `signingHashAlgorithms` 显式设成 `["sha256"]`（单签），原因见下一节**——默认双签的第一轮会让构建直接失败。因此当前**只有 `rfc3161TimeStampServer`（`/tr`）会被实际使用**；`timeStampServer`（`/t`）保留是为了「哪天改回双签时参数已经在那儿」，当前配置下它是**不生效的**，别再把它当成「两个都在用」。

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
  `(Get-AuthenticodeSignature .\<App>.exe).SignerCertificate.Subject`——**在本机默认 shell 里该 cmdlet 会加载失败，但那是环境问题，可以修**（见 §6），所以这不是「用不了」，而是「用之前先清掉 `PSModulePath` 里的 PowerShell 7 目录」。
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
node scripts/verify-signature.mjs "desktop/dist-installer/Embedded-AI-Master-Setup-0.1.0.exe" \
  && echo "签名验证通过"
```

（安装包文件名自 `11d2884` 起是 **`Embedded-AI-Master-Setup-<ver>.exe`**，连字符、无空格——与 `latest.yml` 保持一致。旧的 `Embedded AI Master Setup <ver>.exe` 已不存在，照抄旧路径会得到退出码 2「无法访问」。）

脚本只读 PE 头的 Security Directory（数据目录第 4 项）的 Size 字段，`size > 0` 即「有证书表」。

**它验证的是「有没有签名」，不是「签名有没有效」**——不校验证书链、摘要、时间戳。要判有效性，用下面的手段。

### `Get-AuthenticodeSignature` 在本机默认 shell 里失败——根因是 `PSModulePath`，可修

（2026-10-25 实测更正。原文只记了「失败」，把原因归成「模块加载环境坏了」；实际是一个**可定位、可绕过**的路径污染。）

本机 PowerShell 加载该 cmdlet 失败：

```
Get-AuthenticodeSignature : 在模块"Microsoft.PowerShell.Security"中找不到
Get-AuthenticodeSignature 命令，但无法重复模块……
FullyQualifiedErrorId : CouldNotAutoloadMatchingModule
```

**根因**：本机的环境变量 `PSModulePath` 里混进了 PowerShell 7 的模块目录：

```
c:\program files\windowsapps\microsoft.powershell_7.6.7.0_x64__8wekyb3d8bbwe\Modules
```

那个目录下有一份 **PS7 版**的 `Microsoft.PowerShell.Security`。PowerShell 5.1 从 `PSModulePath` 找模块时先命中它，加载 PS7 编译的二进制，然后报「找不到命令、无法重复模块」。

**对照实验证据**（`powershell.exe` = 5.1.26100.8894，每次只改 `PSModulePath`）：

| `PSModulePath` | 结果 |
|---|---|
| 完整环境值（含 WindowsApps PS7 目录） | **FAILED** |
| 完整环境值**减去** WindowsApps 那一项 | `Valid` |
| 仅 `C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules` | `Valid` |
| 仅 WindowsApps PS7 目录 | **FAILED** |
| 系统目录在前 + PS7 目录在后 | `Valid`（先命中的赢） |
| PS7 目录在前 + 系统目录在后 | **FAILED** |

「先后顺序 + 哪份 `Microsoft.PowerShell.Security` 被加载」构成完整的因果链，不是猜测。

**三种可用做法**：

```bash
# 1) 只在这一次调用里清掉 PSModulePath（最简单）
PSModulePath= powershell.exe -NoProfile -Command "(Get-AuthenticodeSignature 'C:\path\app.exe').Status"
```

```powershell
# 2) 在 PowerShell 会话里把 WindowsApps 那项摘掉
$env:PSModulePath = ($env:PSModulePath -split ';' | Where-Object { $_ -notmatch 'WindowsApps' }) -join ';'
```

3) 直接看 `signtool verify /pa /v`，不碰 PowerShell。

**这条为什么重要**：`electron-updater` 的更新校验**就是**调 `Get-AuthenticodeSignature`（`windowsExecutableCodeSignatureVerifier.js`）。它已经做了防御——`set "PSModulePath=" & chcp 65001 >NUL & powershell.exe ...`，即先把 `PSModulePath` 清空再调。用同样的方式在本机实测，返回 `Status: 1`（`Valid`）。所以**自动更新的签名校验在本机是可用的**，不受上面这个环境问题影响；受影响的只是「你在 shell 里手动敲这条命令」。

**另外发现的一个陷阱**：拿 `C:\Windows\System32\notepad.exe` 的**逐字节副本**做实验时，`Get-AuthenticodeSignature` 会报 `Valid` 且 `IsOSBinary=True`、签名主体是 `Microsoft Windows`——因为**目录签名（catalog）按文件哈希匹配**，副本仍被 Windows 的 catalog 覆盖。**用系统文件复制品做签名实验会得出完全错误的结论。** 正确做法是往副本尾部追加一个字节改变哈希，使其脱离 catalog 覆盖，此时状态才是 `NotSigned`。

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
5. `node scripts/verify-signature.mjs "desktop/dist-installer/Embedded-AI-Master-Setup-<ver>.exe"`，退出码必须是 0；
6. 把 `desktop/dist-installer/` 下的安装包与 `.blockmap` 传到 GitHub Releases。

**本仓库暂无 GitHub Actions workflow，发布目前是本地手工执行。** 第 3 步的变量只存在于执行者的 shell 会话里，不要在仓库里建 `.env` 保存它们——`.gitignore` 虽然忽略 `.env`，但那仍是把秘密放进了工作区。

## 9. 拿到证书后的最短路径（清单）

按顺序做完这五步即可；每一步都有可验证的判据，不靠「看起来像成功了」。

1. **确认私钥形态**（买之前就该问清，见 §2 ①）：
   - 能导出 `.pfx` → 走第 2 步；
   - 只能在令牌/云 HSM 里 → `WIN_CSC_LINK` 用不了，需要 `certificateSubjectName`（证书已装进存储）或厂商的云签名工具。**后者本仓库未实现，是新增开发工作**。
2. **设两个环境变量**（证书放仓库外；`WIN_CSC_LINK` 接受路径 / `https://` URL / base64）：
   ```bash
   export WIN_CSC_LINK="C:\\Users\\<you>\\certs\\embedded-ai-master.pfx"
   export WIN_CSC_KEY_PASSWORD="<pfx password>"
   ```
3. **打包**：`npm --prefix desktop run dist`
   - 判据：日志里出现 `• signing  file=... certificateFile=...`（带 `certificateFile` 的那行才代表真的在签）；
   - **若出现 `SignTool Error: No file digest algorithm specified`**，说明 `signingHashAlgorithms` 又变回默认双签了——见 §3。
4. **验证签名存在**：
   ```bash
   node scripts/verify-signature.mjs "desktop/dist-installer/Embedded-AI-Master-Setup-<ver>.exe"
   echo $?   # 必须是 0
   ```
5. **验证签名有效**（脚本不校验这条，必须另做一次）：
   ```bash
   MSYS_NO_PATHCONV=1 "/c/Program Files (x86)/Windows Kits/10/bin/10.0.22621.0/x64/signtool.exe" verify /pa /v "desktop/dist-installer/Embedded-AI-Master-Setup-<ver>.exe"
   ```
   判据：`Number of files successfully Verified: 1`，且输出里有 `The signature is timestamped` 与 `Timestamp Verified by: DigiCert ...`。**没有时间戳行就是时间戳没打上**，别放过。
6. **核对 `publisherName`**（自动更新的命门）：
   ```bash
   cat desktop/dist-installer/win-unpacked/resources/app-update.yml
   ```
   里面应当有 `publisherName:` 与你的证书 CN。**把它与证书 Subject 逐字符比一遍**，写错一个字符，装了这个版本的用户此后收不到任何可用更新（`ERR_UPDATER_INVALID_SIGNATURE`）。

## 10. 为什么不做自签名（2026-10-25 实测后的否定结论）

**结论：不给本项目加自签名流程。** 下面是实测依据，不是推理——避免后来人再试一遍。

### 做了什么实验

1. `New-SelfSignedCertificate -Type CodeSigningCert` 生成一张自签名代码签名证书（一次性的，实验后已从证书存储与磁盘全部删除）；
2. 拿 `notepad.exe` 的副本、**追加一个字节改变哈希**（否则会被 Windows 的 catalog 签名覆盖，见 §6 的陷阱说明），得 `NotSigned` / `IsOSBinary=False` 的基线；
3. 用 `signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256` 给它签名 —— **签名本身成功**，DigiCert 时间戳也成功打上；
4. 用 `scripts/verify-signature.mjs` 与 `signtool verify /pa /v` 分别判；
5. 把自签名证书装进 `CurrentUser\Root`（模拟企业部署）后再判一次；
6. 用同一张证书驱动**真实 electron-builder** 跑 `--dir` 与完整 NSIS 打包，检查 `app-update.yml` 与三个 PE 的签名状态。

### 结果

| 判据 | 结果 |
|---|---|
| 签名可被写入 PE | 成功（Security Directory size=7920） |
| 时间戳 | 成功（DigiCert RFC3161，`The signature is timestamped` 有值） |
| `scripts/verify-signature.mjs` | **退出码 0，报「已签名」** |
| `signtool verify /pa`（未装证书时） | **失败**：`A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider.` |
| `Get-AuthenticodeSignature`（未装证书时） | `Status=UnknownError` |
| 把证书装进 `CurrentUser\Root` 后 | `signtool verify /pa` **通过**，`Get-AuthenticodeSignature` → `Valid` |
| 用自签名证书完整打 NSIS 包 | 成功，`app-update.yml` 写出 `publisherName: [Embedded AI Master Test]` |

### 为什么不值得做

- **对公开分发的用户零帮助。** 用户机器上没有这张证书的根，`signtool verify /pa` 明确判定不受信任；Windows 仍显示「未知发布者」，SmartScreen 仍按「无信誉的新文件」拦。要让它生效只能要求用户**手动把你的自签名证书装进「受信任的根证书颁发机构」**——而这正是钓鱼软件的典型要求，任何有安全意识的人都不该照做，我们也不该教用户这么干。
- **它不能让 UAC 提示显示发布者名。** `desktop/package.json` 是 `oneClick` + 默认 `perMachine: false`，NSIS 模板走 `RequestExecutionLevel user`（已用 `mt.exe` 从**实际产物**的清单里读出 `level="asInvoker"`），**根本没有 UAC 提权提示**。所以「自签名能改善 UAC 显示」这个设想在本项目的打包配置下不成立。
  - 附带一个反向发现：即使将来改成 `perMachine: true`（会变成 `RequestExecutionLevel admin`、会出现 UAC），**不受信任的发布者会让 UAC 提示显示成黄色警告样式**，比「未知发布者」更吓人，不是改善。
- **唯一真实用途是企业内部部署**：把自签名证书通过组策略/`certutil -addstore` 预装到受控机器的根证书存储。本项目面向公开下载（GitHub Releases），不是内网分发，这个场景不适用。
- **它会污染发布链路**：一旦构建流程里存在「没有真证书就退回自签名」的分支，`verify-signature.mjs` 会报「已签名」退出码 0，而实际用户看到的是不受信任——**这正是 R3 说的「把失败伪装成成功」**。发布门禁会因此失去意义。

### 一个必须记住的脚本行为

`scripts/verify-signature.mjs` 对自签名文件报「已签名」、退出码 0——**这是设计如此**（它只读 PE 头的证书表，脚本头部已写明不校验有效性）。所以：

- **它不能区分「真证书签的」与「随便一张自签名证书签的」**；
- 发布门禁要判「签名是否可信」，必须另加 `signtool verify /pa`，或读 `signtool verify` 的退出码；
- 不要因为脚本退出 0 就认为「签名没问题」——**它只回答「有没有证书表」**。

## 11. 相关条目

- `docs/deferred-issues.md` **D-211**：签名配置就位但从未验证过真实签名（本机无证书）。**2026-10-25 已补**：自签名实验跑通了真实签名链路，并修掉了会让构建直接失败的 `signingHashAlgorithms` 默认值问题。
- `docs/deferred-issues.md` **D-208**：真实安装包从未产出。
- `docs/deferred-issues.md` **D-217**：未签名期间 `electron-updater` 不做签名校验（`publisherName == null` 时视为通过）。
- `scripts/verify-signature.mjs`、`tests/verify-signature.test.ts`：签名检查脚本与其测试。
