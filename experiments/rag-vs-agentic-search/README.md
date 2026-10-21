# RAG vs Agentic Search 对照实验

> 状态：**PARTIAL（方案 A / B / C / C′ 已实现并跑完全量 80 条；D 本轮不跑；预注册未冻结）** · 建立：2026-10-19 · 全量跑批完成：2026-10-21
>
> 本目录是独立实验项目，位于主仓库根目录下的 `experiments/rag-vs-agentic-search/`，拥有自己的 `README.md`、`docs/` 与 `.gitignore`，不进入主仓库的 TypeScript 构建与测试收集范围。

## 结论速览（2026-10-21）

| 方案 | Recall@2 | Hit@1 | P50 | P95 | 状态 |
|---|---|---|---|---|---|
| **B** Agentic search | **0.9250** | **0.8750** | 65.0 s | 101.5 s | 最强，但只能做夜批 |
| A 向量 RAG | 0.8000 | 0.7250 | 106 ms | 136 ms | 可进交互链路 |
| C′ BM25 + grep | 0.8000 | 0.6250 | 0.6 ms | 1.1 ms | **唯一既快又不弱的交互方案** |
| C 现状基线 | 0.4500 | 0.3500 | 1.7 ms | 87 ms | 现状 |
| D 混合 | — | — | — | — | 仅实现 + 冒烟，本轮不跑 |

- **C′ 显著优于 C**（+35.0pp，p_adj = 9.9e−07）→ C′ 成为默认检索实现，C 保留为兜底。
- **B 显著优于 A**（+12.5pp，p_adj = 0.039）→ **不引入向量召回层的理由变强**：agentic 检索比向量检索强，而代价是慢 600 倍。
- **A 未领先稀疏方案**（index 轨 0.70 < C′ 的 0.72）→ 「引入向量层」不成立。

完整报告见 [`docs/experiment-report.md`](docs/experiment-report.md)。**全部为探索性结果**——预注册未冻结，不构成主判定。

## 当前状态：PARTIAL

素材与实现状态：

| # | 材料 | 状态 |
|---|---|---|
| M1 | Phase 0 KB + `index.yaml` | **已取得**（108 md / 90 条目，见 `STATUS.md`） |
| M2 | 回归查询与预期文件 | **已替换为自建查询集**（80 条；原 274 条确认拿不到） |
| M3 | kb-mcp 源码或精确算法说明 | **已取得**（`c529dcd`）；基线复现一致，dispatch 口径已钉死（`deployed`） |
| M4 | LLM / embedding 端点 | **已实测可用**（`raglab models` 显示 1+1 可用） |
| M5 | 多 gold、扰动集、负样本 | 负样本 25 条已完成；扰动集与多 gold 未建 |

**五个方案全部有实现**（A/B/C/C′/D），D 因 H5 门槛与收益有限本轮不跑。396 项 pytest 全覆盖。

```
src/raglab/
├── paths.py       # POSIX 归一化与越界防护
├── corpus.py      # manifest 生成/校验（T1）
├── assets.py      # JSONL schema + G0 交叉校验
├── intake.py      # 导入门禁编排（失败即中止）
├── splitting.py   # dev/test 分层切分（§7.4）
├── metrics.py     # Recall/Hit/MRR/nDCG/假候选/拒答/AUROC
├── scoring.py     # 逐查询评分 + 分组汇总
├── stats.py       # McNemar 精确检验、配对 bootstrap、Holm
├── prereg.py      # 预注册哈希 + confirmatory 门禁（T2）
├── env.py         # env.json 环境记录（T9）
├── llm.py         # OpenAI 兼容客户端 + live 门禁
├── chat_endpoint.py # LLM 端点接线（限流退避按网关自报的 retry_after）
├── embedding.py   # embedding 端点接线
├── tools.py       # B 的工具面（glob/grep/read/submit）
├── config.py      # experiment.yaml / models.yaml / schemes/*.yaml
├── runner.py      # 统一契约跑批（ITT、连续网关错误中止、逐条落盘、断点续跑）
├── retrieval/     # 切块 / 分词 / BM25 / 向量索引（A 与 C′ 共用）
├── schemes/       # A / B / C / C′ / D 五个方案实现
└── report/        # 表格、诊断报告、图表、H5 / H7 / 敏感性 / 显著性分析
```

已实现的 CLI 子命令：`import`、`split`、`index`、`grid`、`run`、`diagnose`、`score`、`report`、`env`、`models`、`h5`、`analyze`、`sensitivity`。

**配置分两处，职责不重叠**：`config/experiment.yaml` 放实验设计；M4 端点与密钥只在本地 `config/models.yaml`（已 gitignore，模板 `models.example.yaml`）。`experiment.yaml` 出现 `model` 段会直接报错，避免"实际用了哪个端点"不可判定。

## 这个实验回答什么

在本项目的嵌入式调试知识库语料与查询分布上，比较五种"第一跳找对文件"的检索方案：

| 方案 | 形态 |
|---|---|
| A 向量 RAG | 切块 → embedding → 相似度 top-k |
| B Agentic search | LLM 多轮 `glob`/`grep`/`read` → `submit` 候选 |
| C 现状基线 | `kb_lookup`（index.yaml 关键词路由）+ `kb_search`（精确 token） |
| C′ BM25 + grep | 稀疏召回 + 精确 token 复核 |
| D 混合 | C′ 或 A 召回 + B 精读（条件启用） |

目标是关闭决策点 #2（KB 渐进加载载体），判定口径见主仓库 `docs/rag-vs-agentic-search-todo.md` §6。

## 目录

```
experiments/rag-vs-agentic-search/
├── README.md            # 本文件：独立入口
├── STATUS.md            # 状态与阻塞项
├── PREREGISTRATION.md   # 预注册（含多轮预算修订与披露义务）
├── docs/                # experiment-report.md（完整报告）、协议、runbook
├── .gitignore           # 忽略语料、虚拟环境、原始 trace 与缓存
├── pyproject.toml       # uv 项目与依赖声明
├── config/              # experiment.yaml / models.example.yaml / schemes/*.yaml / prompts/
│                        # 本地 models.yaml 含密钥，已被 .gitignore 忽略
│                        # resolved/<方案>.json 是网格搜索选定的冻结值
├── corpus/              # 导入的语料，不进版本库
├── data/                # 评测集 JSONL，进版本库
├── src/raglab/          # 实验代码
├── scripts/             # 人工工具（端点探针；不属于跑批路径）
├── tests/               # pytest 离线单测
└── results/             # runs/、scored/、analysis/、diagnostic/、tables/
                         # diagnostic/<id>/ 的 report.md + 图入库；逐条 jsonl 忽略
```

## 权威设计

完整设计（公平性协议 T1-T13、资产导入契约、方案定义、运行门禁、指标与决策映射、图表清单）见主仓库：

- [`docs/superpowers/specs/2026-10-19-rag-vs-agentic-search-experiment-design.md`](../../docs/superpowers/specs/2026-10-19-rag-vs-agentic-search-experiment-design.md)
- 上游待办：[`docs/rag-vs-agentic-search-todo.md`](../../docs/rag-vs-agentic-search-todo.md)
- M2 路线图：[`docs/m2-roadmap.md`](../../docs/m2-roadmap.md)

## 设计期已确定的公平性底线（摘要）

- 语料快照 SHA-256 校验，所有方案看到同一份世界。
- 参数与提示词只在 dev 上选，test 不参与任何选择。
- 所有方案输出同一候选契约；B 必须 `submit`，未提交/超时按 miss 计（ITT）。
- 预注册网格与模型候选，报告网格全部结果，不只报最优。
- C 已在该回归集上调到全绿，其成绩标注为"乐观上界"，并配 C-no-index 消融与可选盲写查询集。
- 证据不足时输出"未决"，不把点估计写成方向性结论。

## 安装与运行

依赖安装由用户执行，agent 不代为安装：

```bash
cd experiments/rag-vs-agentic-search
uv sync
```

常用命令（细节见 [`docs/runbook.md`](docs/runbook.md)）：

```bash
uv run raglab import      # 导入语料与评测集，校验并生成 manifest
uv run raglab split       # 分层切分 dev/test
uv run raglab index --scheme A   # 构建 A 的向量索引（触网）
uv run raglab grid --scheme C_prime --write-resolved  # 网格搜索并冻结选值
uv run raglab run --run-id main --scheme C_prime
# B 触网约 1.8 小时：两个 spacing 缺一不可，--resume 断点续跑
uv run raglab run --run-id main --scheme B --spacing 15 --query-spacing 15 --resume
uv run raglab h5 --a-run-id main --b-run-id main   # H5 判定（D 的准入门槛）
uv run raglab analyze --run-id main                # H7 拒答 + H4 延迟 + 显著性
uv run raglab sensitivity --from-runs              # 覆盖率分层（离线，不重跑）
uv run raglab score --run-id main                  # 评分
```

## 尚未关闭的项

- **预注册未冻结**（无哈希）→ `score --confirmatory` 拒绝执行，全部结果为 exploratory。
- **独立盲写查询**未做——当前 20 条"盲写"是同一人换措辞，不是独立标注。
- **多 gold 标注**未做——当前全部单 gold，nDCG@5 的信息量有限。
- **B 的 H7 无法评估**——没有负样本跑批实现，"KB 外查询会不会被瞎猜"未答。
- **B 的运行间波动**未量化（正文 `repeat: 1`）。

## 许可与数据

评测语料与查询集来自 Phase 0 内容资产，导入后不进入版本库；`data/` 中的标注文件随实验版本库保存。来源许可按主仓库 BRD R7 执行。
