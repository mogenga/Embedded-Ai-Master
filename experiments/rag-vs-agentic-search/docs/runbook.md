# Runbook（骨架期）

> 权威设计：主仓库 spec §9。本文件只写**实际可执行的操作顺序**与骨架期边界，不复制设计内容。

## 环境准备（由用户执行，agent 不代为安装）

```bash
cd experiments/rag-vs-agentic-search
uv sync
```

首次 `uv sync` 会创建 `.venv/` 并生成 `uv.lock`（应提交）。

## 已实现的命令

```bash
uv run raglab import                          # G0 校验，写 results/intake_report.json
uv run raglab split [--dev-ratio 0.7] [--dry-run]   # 写 data/splits.json
uv run raglab score --run-id <id> [--partition dev|test|all] [--confirmatory]
uv run raglab report --run-id <id>            # 由 scored CSV 生成 results/tables/
uv run raglab env                             # 写 env.json（缺失项进 missing，不猜）
```

- `import` 失败即退出码 2，错误逐条列在 `errors`，不生成占位语料或占位 gold。
- `score` 默认 `mode=exploratory`，`summary.json` 带 warning，**不得**作主判定。
- `score --confirmatory` 要求：分区不是 dev、`PREREGISTRATION.md` 已冻结（无「未生成」占位符）、
  `config/resolved/<scheme>.json` 齐备。任一不满足即退出码 3。

## 仍未就绪（退出码 3）

```bash
uv run raglab index    # 需 M1 语料 + M4 embedding
uv run raglab run      # 需方案实现（五方案当前为占位）
```

两个命令在 stderr 打印未就绪原因，不写任何文件。

## 测试（离线）

```bash
uv run pytest
```

默认不触网：`raglab.llm` 在未设置 `RAGLAB_LIVE=1` 时抛 `LiveGateError`；客户端测试用 `httpx.MockTransport`。

## 配置模型端点与密钥（M4）

两种方式，二选一。**密钥永远不进版本库。**

### 方式一：本地 `config/models.yaml`（推荐）

该文件已被 `.gitignore` 忽略，模板是 `config/models.example.yaml`：

```bash
cd experiments/rag-vs-agentic-search
cp config/models.example.yaml config/models.yaml
```

然后编辑 `config/models.yaml`，填入 `base_url`、`model`、`api_key`：

```yaml
llm:
  candidates:
    - id: remote-llm-1
      kind: openai_compatible
      base_url: https://api.example.com/v1
      model: your-model-name
      api_key: sk-your-key
      temperature: 0.0
      repeat: 3
```

### 方式二：环境变量

```bash
export RAGLAB_LIVE=1
export RAGLAB_LLM_BASE_URL=https://api.example.com/v1
export RAGLAB_LLM_MODEL=<模型名>
export RAGLAB_LLM_API_KEY=<密钥>

# 方案 A 还需要 embedding 端点
export RAGLAB_EMBED_BASE_URL=https://api.example.com/v1
export RAGLAB_EMBED_MODEL=<embedding 模型名>
export RAGLAB_EMBED_API_KEY=<密钥>
```

PowerShell：

```powershell
$env:RAGLAB_LIVE = "1"
$env:RAGLAB_LLM_BASE_URL = "https://api.example.com/v1"
$env:RAGLAB_LLM_MODEL = "<模型名>"
$env:RAGLAB_LLM_API_KEY = "<密钥>"
```

### 校验与运行

```bash
uv run raglab run --scheme B
```

- `config/models.yaml` 缺失时加载为空配置（M4 未就绪的合法状态），不会报错。
- `env.json` 只记录 base URL、模型名与 `api_key_set: true/false`，**不记录密钥值**。
- 提交前自查：`git check-ignore -v config/models.yaml` 应输出匹配行。

- 未设置 API key 时客户端不发 `Authorization` 头（兼容本地网关）。
- `env.json` 只记录 base URL 与模型名，**不记录密钥**；有测试断言这一点。
- 环境变量名可在 `config/experiment.yaml` 的 `model.*_api_key_env` 中改写，但值本身永远不进配置。

## 常见失败

| 现象 | 原因 | 处置 |
|---|---|---|
| `缺少语料 manifest` | 未导入语料 | 导入语料后 `write_manifest()` 生成 `corpus/kb/manifest.sha256` |
| `语料不一致（changed/missing/unexpected）` | 语料被改动 | 视为新实验，换 `run_id` 并重生成 manifest |
| `gold 路径不存在` | 查询集与语料版本不匹配 | 核对 M1/M2 是否同一快照 |
| `live 调用被拒绝` | 未设 `RAGLAB_LIVE=1` | 显式开启；不要为了"跑通"关掉门禁 |
