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

## live 运行（素材到位后）

```bash
export RAGLAB_LIVE=1
export RAGLAB_LLM_BASE_URL=...   # M4
export RAGLAB_LLM_MODEL=...
uv run raglab run --scheme B
```

## 常见失败

| 现象 | 原因 | 处置 |
|---|---|---|
| `缺少语料 manifest` | 未导入语料 | 导入语料后 `write_manifest()` 生成 `corpus/kb/manifest.sha256` |
| `语料不一致（changed/missing/unexpected）` | 语料被改动 | 视为新实验，换 `run_id` 并重生成 manifest |
| `gold 路径不存在` | 查询集与语料版本不匹配 | 核对 M1/M2 是否同一快照 |
| `live 调用被拒绝` | 未设 `RAGLAB_LIVE=1` | 显式开启；不要为了"跑通"关掉门禁 |
