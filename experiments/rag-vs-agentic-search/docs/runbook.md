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
uv run raglab models                          # 列出模型候选与可运行状态（不触网）
```

- `import` 失败即退出码 2，错误逐条列在 `errors`，不生成占位语料或占位 gold。
- `score` 默认 `mode=exploratory`，`summary.json` 带 warning，**不得**作主判定。
- `score --confirmatory` 要求：分区不是 dev、`PREREGISTRATION.md` 已冻结（无「未生成」占位符）、
  `config/resolved/<scheme>.json` 齐备。任一不满足即退出码 3。

## 仍未就绪（退出码 3）

```bash
uv run raglab index    # 需索引侧实现
uv run raglab run      # 需方案实现（五方案当前为占位）
```

两个命令在 stderr 打印未就绪原因，不写任何文件。

## 测试（离线）

```bash
uv run pytest
```

默认不触网：`raglab.llm` 在未设置 `RAGLAB_LIVE=1` 时抛 `LiveGateError`；客户端测试用 `httpx.MockTransport`。

## 配置模型端点与密钥（M4）

**唯一来源是本地 `config/models.yaml`**（已被 `.gitignore` 忽略）。`experiment.yaml` 不接受 `model` 段，出现即报错——两套端点配置并存会让"实际用了哪个端点"不可判定。

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

### 查看候选状态（不触网）

```bash
uv run raglab models
```

- 打印每个候选的 `usable` 与 `block_reason`，不发起任何请求。
- `openai_compatible` 候选要求 `base_url` 与 `model` 齐全。
- `local` 候选要求 `model` 齐全且 `requires` 声明的可选依赖组已安装。**当前没有本地候选**（原有两个因缺 `model` / 缺 `sentence-transformers` 已移除），该分支暂无人使用。
- 全部候选都不可用时退出码 3。
- `config/models.yaml` 缺失时返回空配置（M4 未就绪的合法状态），不报错。

### 端点连通性探针（触网，人工运行）

`raglab models` 只看配置字段，**不验证端点是否真的能连、能不能 tool calling、限流多严**。这些用独立脚本确认：

```bash
# PowerShell
$env:RAGLAB_LIVE = "1"
uv run python scripts/probe_endpoints.py

# 全量（追加确定性与限流探测，较慢）
uv run python scripts/probe_endpoints.py --determinism --rate --json
```

环境已就绪时也可直接调用 venv 解释器（此形式已实测通过，`uv run` 形式未单独验证）：

```powershell
$env:RAGLAB_LIVE = "1"
./.venv/Scripts/python.exe scripts/probe_endpoints.py
```

检查项：`llm.auth`（不带密钥应 401）、`llm.connect`、`llm.tool_calling`（方案 B 的前提）、`llm.multiturn`（工具结果回灌后能收敛到答案）、`embedding.auth`、`embedding.connect`（维度与是否已归一化）、`embedding.batch`。加了 `--determinism` / `--rate` 才跑对应两项。

- 未设 `RAGLAB_LIVE=1` 时退出码 2，与产品代码同一道门禁，脚本不绕过。
- 任一检查 fail 时退出码 1；warn 不阻断。
- 默认相邻调用间隔 15s，按实测限流设定；调小会自己撞 429，别把限流误读成端点故障。
- 输出只含 `api_key_set`，不含密钥；有单测把关。
- **这是人工确认工具，不属于跑批路径**，因此放在 `scripts/` 而不是 `src/raglab/`。

### 记录到 env.json（T9）

`uv run raglab env` 把 `models.yaml` 的**全部候选**（含不可用的，附 `block_reason`）写入 `env.json` 的 `model_candidates`，只含 `api_key_set: true/false`，**不记录密钥值**；有测试断言这一点。

提交前自查：`git check-ignore -v config/models.yaml` 应输出匹配行。

## 常见失败

| 现象 | 原因 | 处置 |
|---|---|---|
| `缺少语料 manifest` | 未导入语料 | 导入语料后 `write_manifest()` 生成 `corpus/kb/manifest.sha256` |
| `语料不一致（changed/missing/unexpected）` | 语料被改动 | 视为新实验，换 `run_id` 并重生成 manifest |
| `gold 路径不存在` | 查询集与语料版本不匹配 | 核对 M1/M2 是否同一快照 |
| `live 调用被拒绝` | 未设 `RAGLAB_LIVE=1` | 显式开启；不要为了"跑通"关掉门禁 |
