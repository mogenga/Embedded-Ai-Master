# 语料 OTA 实施计划

> 建立：2026-10-23。契约见 `docs/corpus-ota.md`（唯一格式源）。
> 约束：不走 superpowers；**agent 不得执行 git 提交，不得代为安装依赖**。

## 任务依赖图

```
T1 配置层 ─────────────┐
T2 manifest + 验签 ────┤
T3 快照与指针 ─────────┼──→ T5 首次种子化 ──→ T6 OTA 客户端 ──→ T7 设置页
T4 _inbox 分离 ────────┘
T8 host 路径 ──────────┘
T9 发布脚本（依赖 T2）
T10 打包配置（依赖 T5；需用户安装 electron-builder）
```

## 任务清单

### T1 配置层（无依赖）
新建 `src/config/corpus-config.ts`：读取并校验 `corpus.json`；优先级 `$HARNESS_HOME/corpus.json` → `<resources>/corpus.json` → 无。
新建 `config/corpus.example.json`（只有占位符）；`.gitignore` 增加 `config/corpus.local.json`。
失败语义：不静默降级，返回 `config_invalid` + 原因。
测试：`tests/corpus-config.test.ts`。

### T2 manifest 与验签（无依赖）
新建 `src/corpus/manifest.ts`：规范 JSON（递归键排序）、sha256 清单、Ed25519 验签（`node:crypto`，不引依赖）、版本比较（防回滚）、路径校验（拒 `..` 与绝对路径）。
测试：`tests/corpus-manifest.test.ts`（含篡改检测、路径穿越、旧版本拒绝）。

### T3 快照与指针（无依赖）
新建 `src/corpus/snapshot.ts`：物化内置快照到 `snapshots/v<N>`、junction `current`、原子切换、保留上一版、清理更早、单实例锁。
测试：`tests/corpus-snapshot.test.ts`（临时目录，不碰真实 `$HARNESS_HOME`）。

### T4 `_inbox.md` 移出受管集合（无依赖）
`mcp-servers/kb/service.ts`：新增 `inboxPath` 选项，`kb_propose` 写 `$HARNESS_HOME/kb/inbox/_inbox.md`，不再写语料根。
`manifest.sha256` 与 OTA 清单一律不含 `_inbox.md`。
测试：`mcp-servers/kb/tests/` 补用例；确认 `kb_lookup` 仍排除 inbox。

### T5 首次种子化（依赖 T1/T3）
新增首次启动流程：物化内置快照 → 建 `current` → 若 `mcp.json` 无 `kb` 条目则写入（`command: process.execPath`、`args: [<resources>/dist-mcp/kb/server.js]`、`env.KB_ROOT`、`env.ELECTRON_RUN_AS_NODE=1`）。已有条目不动。

### T6 OTA 客户端（依赖 T1/T2/T3）
新建 `src/corpus/update.ts`：检查 → 验签 → 版本比较 → 下载变更文件 → 校验 → 切指针。启动时静默检查、失败不打扰；应用需用户确认。

### T7 设置页（依赖 T6）
`desktop/renderer/settings.js` 知识库页增加七种状态展示与更新入口；`desktop/host/host.js` 增加命令；`settings-i18n.js` 补中英文案。

### T8 host 路径（无依赖）
`desktop/host/host.js:32` 的 `repoRoot` 在打包形态改读 `process.resourcesPath`；开发形态保持现状。

### T9 发布脚本（依赖 T2）
新建 `scripts/corpus-publish.mjs`：遍历语料（跳过 `_inbox.md`）→ sha256 → 生成 `latest.json` → 签名 → 输出待上传目录。私钥路径由参数给，绝不写进仓库。

### T10 打包配置（依赖 T5；需用户先安装）
`desktop/package.json` 引入 electron-builder；语料与 `dist/`、`dist-mcp/` 走 `extraResources`；统一 electron 版本（根 `^45.0.0` vs desktop `^44.9.0`）。

## 需要用户操作（agent 不代做）

1. `npm install -D electron-builder`（T10 前置）
2. 生成 Ed25519 密钥对，**只提供公钥**
3. 把真实桶地址写进 `config/corpus.local.json`（模板见 `config/corpus.example.json`）
4. 上传语料与 `latest.json` 到 OBS（可用 T9 产物）

## 完成标准

- `npm test`、`npm run typecheck`、`npm run build`、`npm run build:mcp` 全绿
- 不触网（live 测试默认跳过）
- 每任务完成后在 `dev-notes/M2-语料OTA.md` 增量追记
