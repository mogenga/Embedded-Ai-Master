# RAG vs Agentic Search 对照实验

> 状态：**BLOCKED（评测资产未到位，未实现、未跑批、无结果）** · 建立：2026-10-19
>
> 本目录是独立实验项目，位于主仓库根目录下的 `experiments/rag-vs-agentic-search/`，拥有自己的 `README.md`、`docs/` 与 `.gitignore`，不进入主仓库的 TypeScript 构建与测试收集范围。

## 骨架状态（2026-10-20）

素材（M1-M5）仍未到位。**不依赖素材的后段链路已闭环**：导入校验 → 分层切分 → 评分 → 表格，全部可离线运行并有 143 项 pytest 覆盖。五个方案与图表仍为**显式占位**，调用即抛 `FeatureNotImplemented`，不会返回空候选冒充结果。

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
├── config.py      # experiment.yaml / schemes/*.yaml
├── runner.py      # 统一契约跑批骨架（ITT、连续网关错误中止）
├── schemes/       # 五个方案（占位）
└── report/        # 表格写入（已实现）/ 图表（占位）
```

已实现的 CLI 子命令：`import`、`split`、`score`、`report`、`env`。仍阻塞：`index`（需 M1+M4）、`run`（需方案实现）。

## 这个实验回答什么

在本项目的嵌入式调试知识库语料与查询分布上，比较五种“第一跳找对文件”的检索方案：

| 方案 | 形态 |
|---|---|
| A 向量 RAG | 切块 → embedding → 相似度 top-k |
| B Agentic search | LLM 多轮 `glob`/`grep`/`read` → `submit` 候选 |
| C 现状基线 | `kb_lookup`（index.yaml 关键词路由）+ `kb_search`（精确 token） |
| C′ BM25 + grep | 稀疏召回 + 精确 token 复核 |
| D 混合 | C′ 或 A 召回 + B 精读（条件启用） |

目标是关闭决策点 #2（KB 渐进加载载体），判定口径见主仓库 `docs/rag-vs-agentic-search-todo.md` §6。

## 当前状态：BLOCKED

以下材料尚未取得，实验不得启动，也不得用占位语料或占位 gold 生成“结果”：

| # | 缺失材料 |
|---|---|
| M1 | Phase 0 KB 103 文件 + `index.yaml` + 来源许可登记 |
| M2 | `regression.py` 导出的 274 条查询与预期文件 |
| M3 | kb-mcp 源码或精确算法说明（C 的忠实复现） |
| M4 | LLM 网关地址/密钥/模型名；embedding 模型 |
| M5 | 多 gold 标注（增强项）、扰动集 150 条、负样本 20-30 条 |

素材到位后先完成导入与校验（G0），再按设计文档的 G1-G4 推进。

## 目录

```
experiments/rag-vs-agentic-search/
├── README.md            # 本文件：独立入口
├── STATUS.md            # 状态与阻塞项（素材到位后更新）
├── PREREGISTRATION.md   # 预注册模板（DRAFT，G0 通过后冻结并记哈希）
├── docs/                # 实验自己的文档（协议清单、指标映射、标注指南、runbook）
├── .gitignore           # 忽略语料、虚拟环境、原始 trace 与缓存
├── pyproject.toml       # uv 项目与依赖声明
├── config/              # experiment.yaml / models.yaml / schemes/*.yaml / prompts/
├── corpus/              # 导入的语料，不进版本库
├── data/                # 评测集 JSONL，进版本库（当前只有 README，无占位数据）
├── src/raglab/          # 实验代码（纯逻辑已实现，方案为占位）
├── tests/               # pytest 离线单测
└── results/             # runs/、scored/、figures/、tables/（待跑批后生成）
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
- C 已在该回归集上调到全绿，其成绩标注为“乐观上界”，并配 C-no-index 消融与可选盲写查询集。
- 证据不足时输出“未决”，不把点估计写成方向性结论。

## 安装与运行（素材到位、实现完成后）

依赖安装由用户执行，agent 不代为安装：

```bash
cd experiments/rag-vs-agentic-search
uv sync
```

计划命令（尚未实现）：

```bash
uv run raglab import      # 导入语料与评测集，校验并生成 manifest
uv run raglab split       # 分层切分 dev/test
uv run raglab index       # 构建 A / C′ 索引
uv run raglab run         # 跑指定方案
uv run raglab score       # 评分（test 需 --confirmatory）
uv run raglab report      # 生成图表与表格
```

## 许可与数据

评测语料与查询集来自 Phase 0 内容资产，导入后不进入版本库；`data/` 中的标注文件随实验版本库保存。来源许可按主仓库 BRD R7 执行。
