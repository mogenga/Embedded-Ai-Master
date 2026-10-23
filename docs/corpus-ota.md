# 语料 OTA：接口契约

> 建立：2026-10-23。本文是分发实现任务的**唯一契约源**——多个子任务并行时以此为准，不要各自发明格式。
> 前提：安装包公开分发 → 语料随包发 = 语料公开 → OTA 无需鉴权 → 凭据问题不存在；完整性由 Ed25519 签名保证。

## 1. 为什么需要签名

`kb_read` 返回的语料原文会直接进模型上下文。被篡改的语料不是解析错误，而是**提示注入**（例如诱导 `probe_write_memory` 后报告无故障），直接撞 R1/R2/R3。

sha256 清单**挡不住**这种攻击：能写桶的人同时改文件和清单。签名挡得住，因为私钥不在桶里。

## 2. 地址与公钥：配置文件，不硬编码

真实值不进仓库。三个位置，优先级从高到低：

| 位置 | 用途 | 进仓库 |
|---|---|---|
| `$HARNESS_HOME/corpus.json` | 用户/运维运行时覆盖 | 否 |
| `<安装目录>/resources/corpus.json` | 构建时注入，随安装包分发 | 否（由 gitignore 的 `config/corpus.local.json` 生成） |
| 源码内无默认值 | — | — |

`config/corpus.example.json` 只有占位符，进仓库。`config/corpus.local.json` 被 gitignore 忽略，构建脚本读它生成 `resources/corpus.json`。

模板里 `updateBaseUrl` 是 `https://example.invalid/`、`publicKeyPem` 是 `-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n`——前者故意用不可解析的 `.invalid` 域名，后者故意不是真密钥。**这两个占位值必须替换**，否则验签必然失败。JSON 不支持注释，因此使用说明只能写在这里：复制 `config/corpus.example.json` 为 `config/corpus.local.json` 后按下方格式填入真实值。

### 格式

```json
{
  "version": 1,
  "updateBaseUrl": "https://<桶域名>/",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n<base64>\n-----END PUBLIC KEY-----\n"
}
```

- `updateBaseUrl` 必须以 `/` 结尾；客户端拼 `latest.json` 与相对路径。
- **对象直接放在桶根下**，不加前缀（2026-10-23 定案：`latest.json`、`index.yaml`、`protocols/uart/no-output.md` 都是桶根下的键）。因此 `updateBaseUrl` 形如 `https://<桶域名>/`。
- `publicKeyPem` 是 Ed25519 公钥（SPKI PEM）。公钥不是秘密，可进安装包。
- 缺失或不合法时：**不静默降级**。知识库照常可用（内置快照），但更新功能报 `corpus_config_invalid` 并在设置页如实展示（R3）。

## 3. 目录布局

```
$HARNESS_HOME/kb/
├── snapshots/
│   └── v<N>/           完整语料快照，只读
├── current             junction → snapshots/v<N>
├── inbox/
│   └── _inbox.md       本地沉淀，永不进快照、永不被覆盖
└── state.json          上次检查时间、上次检查结果
```

- `KB_ROOT` 指向 `kb/current`。
- `current` 用 **junction**（`fs.symlink(target, path, 'junction')`）。Windows 上 junction 不需要开发者模式；symlink 需要。
- `KbService` 构造时 `realpathSync` 会把 `current` 解析成具体快照路径 → 运行中的 server 锁在旧快照，新会话指向新快照。这正是「更新在会话边界生效」的语义，不需要热切换代码。

## 4. `latest.json`（发布到 OBS，也在安装包内置一份）

```json
{
  "manifestVersion": 1,
  "corpusVersion": 2,
  "publishedAt": "2026-10-23T12:00:00Z",
  "files": [
    { "path": "index.yaml", "sha256": "<hex>" },
    { "path": "protocols/uart/no-output.md", "sha256": "<hex>" }
  ],
  "signature": "<base64(Ed25519(canonicalPayload))>"
}
```

- `canonicalPayload` = 除 `signature` 外所有字段的 **规范 JSON**：键按字典序递归排序、无多余空白（`JSON.stringify` 递归排序后的对象）、UTF-8。
- `path` 一律 POSIX 相对路径，禁止 `..` 与绝对路径。
- `corpusVersion` 是**内容版本**（与 `index.yaml` 里 `version: 1` 的 schema 版本无关），单调递增整数。
- 防回滚：`corpusVersion <= 本地当前版本` 时拒绝。
- **受管排除项**：`_inbox.md` 与 `_reviewed.md` 不得出现在 `files` 里。发布侧（`scripts/corpus-publish.mjs`）跳过它们，验证侧（`src/corpus/manifest.ts`）硬性拒绝——两边名单必须一致。两份常量不能互相 import（MCP server 不能引内核，见 D-086），各自写一份并在注释里互相点名。

## 5. 内置快照 = 一份合法的签名清单

安装包里带 `resources/corpus/`（语料正文）与 `resources/corpus/latest.json`（同格式，`corpusVersion` 为出厂版本）。首次启动把它物化成 `snapshots/v<N>`。

好处：物化与 OTA 走同一条校验路径，不需要第二套逻辑。

## 6. 更新流程（状态机）

```
读配置 → 无配置/不合法 → 状态 unavailable（不打扰）
GET <base>/latest.json
  ├─ 网络失败 → checked 失败，保留当前版本，不提示
  ├─ 验签失败 → 拒绝，state.json 记录，设置页显示原因
  ├─ corpusVersion <= 本地 → 已是最新
  └─ 有新版 → 显示更新入口（用户点确认才下载）
        ↓ 用户确认
逐文件下载到 snapshots/v<N>/（只下 sha256 变化的）
  → 逐文件校验 sha256
  → 全部通过 → 切 current 指针
  → 保留上一版；清理更早的
任一步失败 → 删除半成品，current 不动，如实报原因
```

- **不自动应用**：`kb_read` 原文进上下文，静默换语料会让「同一问题回答不同」不可解释，也破坏会话回放（BR-6）。
- **启动时静默检查**，失败不打扰（无网是常态）。
- 发布侧顺序：**先传文件，最后传 `latest.json`**。

### 6.1 华为云 OBS 的 HTTP 状态语义（2026-10-23 实测，必须按此实现）

桶只授予 `GetObject`、不授予 `ListBucket` 时，OBS **不区分「没有权限」与「对象不存在」**：

| 请求 | 实测响应 |
|---|---|
| 已存在的对象 | `200` |
| **不存在的对象** | **`403 AccessDenied`（不是 404）** |
| 桶根（列对象） | `403 AccessDenied` |
| 匿名 PUT / DELETE | `403 AccessDenied` |

因此客户端**不能**用 404 判断「`latest.json` 还没发布」：

- `200` → 解析并验签
- `403` / `404` → 一律按「源上没有该文件」处理，状态记 `check_failed` 并给出原因（例如「更新源返回 403，可能是尚未发布或桶策略未授予 GetObject」），**不得**显示成「已是最新」（R3）
- 网络错误 / 超时 → `check_failed`，保留当前版本
- `5xx` → `check_failed`，可重试

## 7. 诚实性要求（R3）

设置页知识库页必须能区分并如实展示：

| 状态 | 含义 |
|---|---|
| `bundled` | 只有内置快照，从未检查过更新 |
| `up_to_date` | 已检查，当前是最新 |
| `update_available` | 有新版（版本号、文件数） |
| `check_failed` | 检查失败 + 原因 |
| `verify_failed` | 验签失败 + 原因 |
| `config_invalid` | 配置缺失或不合法 |
| `unavailable` | 没有 KB 根 |

绝不允许「更新失败显示成功」，也绝不允许语料缺失时显示成「空知识库、无故障」。

工具结果与 `kb_status` 需带 `corpusVersion` 与 `source`（`bundled` / `ota`），使会话可复现。

`CorpusState`（`state.json`）为此保存 `fileCount`：`readCorpusStatus` 要能把存储的 `update_available` 完整还原，否则只能拿 `fileCount: 0` 顶上，那是撒谎。早期状态文件没有该字段时，如实降级成 `check_failed` 并说明「记录不完整，请重新检查」。

## 8. 发布侧

签名在一台离线机器上做，CI 只验签不签名。私钥文件 `corpus-signing.key` 已被 `.gitignore` 的 `*.key` 覆盖。

发布脚本职责（`scripts/corpus-publish.mjs`）：遍历语料目录（跳过 `_inbox.md`）→ 算 sha256 → 生成 `latest.json` → 签名 → 上传（先文件后清单）。

## 9. 待实测（不能凭记忆断言）

1. Electron 打包后能否从 asar 内 `import()` ESM（内核是 ESM + 动态 import）。倾向把 `dist/` 放 `extraResources` 绕开，但必须在真实打包产物上验证。
2. junction 在 NSIS 安装到 `%LOCALAPPDATA%` 后的创建与访问权限。
