# RAG vs Agentic Search 对照实验设计

> 日期：2026-10-19 · 状态：**待用户复核本文档**（设计要点已于同日口头确认“按推荐”；书面 spec 尚未逐节复核） · 上游：[rag-vs-agentic-search-todo.md](../../rag-vs-agentic-search-todo.md)（H1-H7、§6 指标与判定）、[m2-roadmap.md](../../m2-roadmap.md) 工作流 H、[BRD.md](../../BRD.md) BR-3 / §14、[ontology-scope-note.md](../../ontology-scope-note.md)（Ontology 不纳入本实验）。
>
> 本设计的交付边界：**只定义实验，不实现、不跑批、不产出任何结果**。实现计划在素材到位且本设计评审通过后另写。评测语料与 274 条查询属于 Phase 0 内容资产，当前未取得，`STATUS.md` 必须标记 `BLOCKED`，不得用合成占位结果替代。

## 1. 意图与为什么

决策点 #2（KB 渐进加载载体）需要一个可复现、可审计的对照实验来回答：在本项目语料与查询分布上，向量 RAG（A）、agentic search（B）、现状 index+grep（C）、BM25+grep（C′）以及混合（D）谁的第一跳检索更准、更稳、更便宜。

todo 已给出假设与判定阈值，但**没有定义如何防止实验本身偏袒某个方案**。若不补这层，最可能出现的失败不是代码错误，而是：

- 在测试查询上调参，A 或 B 被“调”到赢；
- B 用自由文本回答、A/C 用结构化候选，计分口径不同；
- 语料或 gold 标注在实验中途变化，各方案看到的不是同一份世界；
- 274 条查询的样本量不足以支撑 10 个百分点的判定，却被当成确定结论。

因此本设计的核心不是“再列一遍方案”，而是**公平性协议 + 可执行的运行门禁**。方案定义、指标公式仍以 todo §2/§6 为准，本设计只做消歧与固化。

## 2. 目标

1. 定义一套威胁模型与控制措施，使“在测试集上调参”“模型货比三家”“计分口径不一致”三类偏差在流程上不可发生，或至少可被审计发现。
2. 固化评测资产导入契约：语料快照、查询/gold JSONL、切分、扰动集、负样本、多 gold 标注。
3. 为 A/B/C/C′/D 定义**同一输出契约、同一计分口径、同一 LLM/同一预算**的可执行规格。
4. 定义运行协议（G0-G4）、预注册内容、封存与解封规则、运行环境记录与可复现标识。
5. 定义指标、统计检验、检验功效说明与决策映射；证据不足时明确输出“未决”。
6. 定义独立实验目录结构、依赖管理（uv）、独立 README 与图表/表格清单。
7. 明确与主仓库的隔离边界：不进入根 `tsconfig`/`vitest` 收集范围，不改变主仓库构建与测试。
8. 定义“决策映射”：跑完后如何把结果映射回 todo §6.2 的决策表，并在证据不足时输出未决。

## 3. 非目标

- 不实现实验代码、不建 `experiments/` 目录（本设计只定义）。
- 不重新定义 H1-H7 或 todo §6.2 的判定阈值。
- 不评估 Ontology/GraphRAG（见 `ontology-scope-note.md` 的范围决策）。
- 不评估产品化的分块缓存、增量索引、多租户、权限等工程能力。
- 不把实验结论直接等同于 BR-3 上线实现；结论只关闭决策点 #2，具体实现另立 plan。
- 不做多标注者一致性研究（若只有一名标注者，按 §6.5 披露限制）。

## 4. 反目标

- 任何方案在 test 集上迭代提示词、参数、分词器或切块策略。
- 为某方案定制查询措辞、gold 标注或扰动生成规则。
- 只在成功返回的查询上计分，把超时/解析失败从分母里剔除。
- 用“最优一次运行”代表 agentic 方案，而不报告运行间方差。
- 在样本量不足时用点估计强行给出“A 胜/败”的结论。
- 把 `index.yaml` 的结构优势同时提供给其他方案，却不做说明（或反过来，禁止 C 使用它）；两种做法都必须显式声明并进入消融。
- 素材未到位时生成占位语料或占位 gold，并让报告看起来像有结论。

## 5. 事实与前置资产

### 5.1 已知事实（来自本仓库文档）

| 事实 | 来源 | 对实验的影响 |
|---|---|---|
| KB 103 文件（52 症状四段式 / 39 reference / 其他）、`index.yaml` 85 条目 | BRD BR-3、work-summary §3.1 | 语料规模约 500KB，需冻结快照 |
| 回归双轨 172 index + 102 search，预期答案现成 | todo §4、BRD R6 | 274 条查询可直接作为评测集，但需导入校验 |
| kb-mcp 现行工具：`kb_lookup`（index 关键词路由 top-2）、`kb_read`、`kb_search`（精确 token grep） | work-summary §2.3 | C 的忠实复现对象 |
| 设计结论 4“不用向量 RAG”是推理结论 | BRD §14、todo §1 | 本实验的立项理由 |
| 本机 Python 3.13.5、uv 0.11.3；numpy/scipy/matplotlib 可用 | 本机核验（2026-10-19） | 实验栈选择 Python + uv |
| 本地模型网关当前不可达（`127.0.0.1:8080` 拒连） | 本机核验 | B/D 的 live 运行依赖用户提供端点 |

### 5.2 待获取材料（阻塞项）

| # | 材料 | 用途 | 缺失时的状态 |
|---|---|---|---|
| M1 | Phase 0 KB 103 文件 + `index.yaml` + 来源许可登记 | 语料本体 | `BLOCKED` |
| M2 | `regression.py` 导出的 274 条查询与预期文件 | 评测主集 | `BLOCKED` |
| M3 | kb-mcp 源码或精确算法说明（lookup 匹配、token 提取规则） | C 的忠实复现与 172/102 基线复跑 | `BLOCKED`（C 不可信） |
| M4 | LLM 网关地址/密钥/模型名；embedding 模型（本地或 API） | A/B/D 的 live 运行 | A/C/C′ 可先跑；B/D、A 的 API 候选 `BLOCKED` |
| M5 | 标注工时：多 gold（172 条过一遍，增强项）、扰动 150 条、负样本 20-30 条 | H6/H7/nDCG | 多 gold 缺失不阻塞主实验（nDCG 标低置信）；扰动/负样本缺失则 H6/H7 `BLOCKED` |

**导入失败即中止**：任何一项校验失败（gold 路径不存在、查询重复、语料 hash 不符、切分泄漏）都必须以非零退出码终止，并写 `results/intake_failures.json`；不得跳过坏样本继续跑。

## 6. 公平性协议

### 6.1 威胁模型与控制

| # | 威胁 | 控制措施 | 可审计证据 |
|---|---|---|---|
| T1 | 各方案看到的语料不同 | 语料快照 + `corpus/manifest.sha256`（逐文件 SHA-256）；每次运行前校验，不符即中止 | `results/runs/<id>/env.json` 记录 manifest 哈希 |
| T2 | 在 test 集上调参 | 参数与提示词只在 dev 上选；test 结果只用于确认与偏差检查；`score` 命令默认拒绝 test，需 `--confirmatory` | `PREREGISTRATION.md` 哈希 + `config/resolved/*.json` |
| T3 | 调参预算不对称 | 每方案预注册**固定小网格**（§6.3），报告网格内全部结果而非只报最优 | `results/tables/grid_search.csv` |
| T4 | 模型/embedding 在 test 上货比三家 | 候选模型在预注册中列全；选择规则写死（§6.3）；dev 差距 < 2pp 时优先本地/低成本 | `PREREGISTRATION.md` §模型选择规则 |
| T5 | B 与一次性检索计分口径不同 | 统一输出契约（§8.1）；B 必须调用 `submit`；未提交/超时/解析失败按 miss 计（ITT） | `per_query.jsonl` 的 `status` 字段 + `raw/` trace |
| T6 | 失败被静默剔除 | ITT：分母固定为查询总数；另报失败率与失败类型 | `results/tables/failures.csv` |
| T7 | 标注偏向某方案 | 多 gold 盲标：标注者只看查询与语料；扰动/负样本一次生成、全方案共享；生成规则先冻结 | `data/annotation_log.jsonl`（`blind: true`） |
| T8 | 指标挑选 | 主指标 Recall@2 预注册；全部指标全量报告；比较族固定并做 Holm 校正 | `results/summary.json` + 预注册哈希 |
| T9 | 运行环境漂移 | 记录 Python/uv/依赖锁、模型版本、网关地址（不含密钥）、随机种子、机器与日期 | `env.json` |
| T10 | 提示词泄漏评测信息 | B 的 system prompt 不含 `index.yaml`、轨标签、gold 路径或查询来源；提示词全文入预注册 | `config/prompts/agentic_system.txt` 哈希 |
| T11 | 导航文件污染候选或制造隐性优势 | `index.yaml` / `_vendor-index.md` / `_sources.md` 属**导航文件**：所有方案都可把它们当作内部结构读取（C 本来就依赖 `kb_lookup`），但**任何方案都不得把它们作为候选输出**；预注册导航文件清单，评分时统一过滤 | `config/navigation_files.txt` + `per_query.jsonl` 过滤日志 |
| T12 | C 只能返回 top-2，Recall@5 结构性吃亏 | C 的部署形态为 top-2；Recall@5 另报“同排序扩展 top-5”一行并显式标注 `extended`，主判定仍用 Recall@2；不把低 Recall@5 当作 C 的能力结论 | `by_scheme.csv` 的 `candidate_policy` 字段 |
| T13 | **C 在评测集上已被迭代过**（`index.yaml` 与 kb-mcp 曾按 172+102 回归调到全绿），相当于训练集=测试集 | ① 报告中把 C 的成绩标注为“乐观上界（已被该集合调过）”；② C-no-index 消融；③ 可选构建**盲写查询集**：在 C 冻结后由未看过回归集的人另写 50-100 条查询，全部方案同跑，作为敏感性分析；④ 主判定不得因为 C 高而否定 A/B，必须同时看 C-no-index 与盲写集 | `results/tables/c_optimism.csv` + 盲写集单独 `run_id` |

### 6.2 冻结与封存

1. **语料冻结**：导入后生成 manifest 并只读；任何语料修改视为新实验，必须换 `run_id` 前缀。
2. **配置冻结**：dev 调参结束后写 `config/resolved/<scheme>.json`，计算 SHA-256，写入 `PREREGISTRATION.md`；此后任何改动只能作为 post-hoc 分析并显式标注。
3. **test 封存**：dev 调参与任何配置选择脚本不得读取 test 分区；对 test 的评分只允许在配置冻结后以 `--confirmatory` 执行（可只评 test，也可全量评分），并强制校验预注册哈希。评分后不得再改任何配置。
4. **运行记录**：`run_id = sha256(config + corpus_manifest + queries + code_git_sha + seed)[:12]`；重复运行同配置产生独立 `repetition` 字段。

### 6.3 调参预算（预注册网格）

| 方案 | 网格 | 选择规则 |
|---|---|---|
| A | 切块 ∈ {整文件, 按 section} × embedder ∈ {本地候选 1, API 候选 1} | dev Recall@2 最高；并列时取切块更简单者（整文件），再并列取本地 embedder（成本更低） |
| B | 最大工具轮数 ∈ {6, 12, 20}，其余参数固定 | 取 dev Recall@2 首次达到网格最高值 -1pp 的最小轮数（省成本） |
| C | 无参数可调（忠实复现） | — |
| C′ | 切块 ∈ {整文件, 按 section} × 分词 ∈ {CJK 二元字符, jieba} × k1 ∈ {0.9, 1.5} × b ∈ {0.5, 0.75} | dev Recall@2 最高；并列取更小 k1 与 b=0.75（更平滑） |
| D | 仅两种预注册变体（§8.6） | 只在 H5 有信号时运行；配置与 B 同预算 |

网格内每个配置都必须产生一行 `grid_search.csv`；报告正文展示最优配置及网格分布，不只展示最优值。

### 6.4 B 的可比性保障

- B 与 A/C/C′ 使用同一查询文本，不做 LLM 查询改写或拼写纠正。
- B 的工具面固定为 `glob` / `grep` / `read` / `submit`，与产品内置工具语义一致（读取上限 2000 行 / 256 KiB，`grep` 结果上限与截断规则固定）。
- B 不获得 index 结构、主题域、轨标签或候选提示；语料根目录是唯一入口。
- B 的最终候选只能来自 `submit`；中途读过又放弃的文件不计命中（todo §6.1 口径）。
- LLM temperature=0；若网关支持 seed 则固定，否则每查询重复 3 次，查询级命中按 2/3 多数判定，并报告逐次方差。
- B 的 token 成本按网关返回 `usage` 计；网关不返回 usage 时用固定分词器估算并在报告中标记 `estimated`。

### 6.5 标注独立性

- 多 gold 标注：172 条 index case 由标注者逐条阅读语料后补全 gold 文件集合；标注界面/表格不包含任何方案输出、得分或排名。
- 若只有一名标注者：报告必须写明“单标注者、无一致性系数”，并把多 gold 相关指标（nDCG@5）标为**低置信**；若后续有第二名标注者，抽取 10% 双标并报告 Cohen's κ。
- 扰动集与负样本由预注册规则生成后人工过目；过目者不得同时调整方案参数。

### 6.6 残留偏差与披露

| 残留偏差 | 披露方式 |
|---|---|
| `index.yaml` 是人工为 C 构建的路由结构，且 C 已在该回归集上调到全绿（T13） | 按查询轨分层报告；C-no-index 消融单列；报告把 C 标为乐观上界；可选“盲写查询集”作敏感性分析；主判定同时参考消融与盲写结果 |
| 274 条查询来自 Phase 0 回归，可能偏向既有 KB 写法 | 报告列出查询来源与缺失的真实诊断日志样本；不据此外推到全部诊断查询 |
| 单标注者、单机器、单网关 | `env.json` 与“限制”章节完整披露 |
| 合成 10x/100x 语料非真实分布 | H3 结论只用于阈值提示，不作上线判据 |

## 7. 语料与评测集

### 7.1 目录与导入契约

实验不复制语料进版本库。导入命令把外部资产同步到 `corpus/`（本实验 `.gitignore` 忽略），并生成 manifest。

```
corpus/
├── kb/                    # 103 文件，保持原始相对路径
├── index.yaml
└── manifest.sha256        # 每行 "<sha256>  <posix相对路径>"，按路径排序
```

评测数据（**进版本库**，不含受版权限制的语料正文）：

```
data/
├── queries.jsonl
├── perturbations.jsonl
├── negatives.jsonl
├── splits.json
├── annotation_multi_gold.jsonl
└── README.md              # 字段说明与许可声明
```

### 7.2 JSONL schema（导入即校验，失败中止）

**`queries.jsonl`**

```json
{"id": "idx-001", "track": "index", "text": "串口收不到数据但发送正常", "gold": ["protocols/uart-no-rx.md"], "topic": "protocols", "lang": "zh", "source": "regression.py"}
```

- `id`：唯一，`^[a-z]+-[0-9]{3,}$`；`track ∈ {index, search}`。
- `gold`：至少 1 个语料内相对路径（POSIX 风格）；导入时逐一 `stat`。
- `topic`：取自 todo §6.1 的七个主题域；未知值导入失败。
- `source`：`regression.py` 或 `manual`。

**`perturbations.jsonl`**

```json
{"id": "syn-014", "base_id": "idx-014", "kind": "syn_rewrite", "text": "……", "generator": "human", "reviewed": true}
```

- `kind ∈ {syn_rewrite, typo, colloquial}`，三档各 50 条（从 274 条中预注册抽样，固定 seed）。
- 生成规则先冻结（同义改写不改术语、错别字只改非 token 字符、口语化不引入新事实），再生成；`reviewed` 必须为 true 才进入评分。

**`negatives.jsonl`**

```json
{"id": "neg-003", "text": "i.MX RT1170 双核间 MU 中断丢消息", "reason": "KB 未覆盖该型号与外设", "near_domain": true}
```

- 20-30 条，人工构造，必须“领域相近但 KB 未覆盖”；导入时人工复核记录。

**`splits.json`**

```json
{"seed": 20261019, "stratify_by": ["track", "topic", "n_gold"], "dev": ["idx-001"], "test": ["idx-002"]}
```

**`annotation_multi_gold.jsonl`**

```json
{"query_id": "idx-001", "gold": ["protocols/a.md", "reference/b.md"], "annotator": "owner", "annotated_at": "2026-10-20T10:00:00+08:00", "blind": true}
```

### 7.3 校验项（G0 门禁）

1. 每个 `gold` 路径存在且位于 `corpus/kb/` 内；大小写与分隔符按 POSIX 归一。
2. 查询文本去重（归一化空白后）；重复即失败并列出冲突 id。
3. 语料 manifest 与当前文件一致；`index.yaml` 条目数记录（预期 85，允许差异但需说明）。
4. dev/test 近重复检查：字符 5-gram Jaccard > 0.8 的跨集对必须列出；同一 base 查询的扰动只允许与其 base 同侧。
5. 主 gold 覆盖：全部 274 条查询至少 1 个 gold 路径；主判定只用导入的原始 gold。多 gold 补标是**增强项**：若未提供，nDCG@5 按单 gold 计算并在报告中标记“低置信”，不阻塞主实验；若提供，必须覆盖 172 条 index case 才进入 nDCG 计算。
6. 负样本不得出现在 `queries.jsonl` 的 gold 中；否则人工复核来源。
7. 规模实验（若启用）合成文件不得包含任一 gold 文件的长 n-gram（长度 ≥ 8 字符）超过阈值（0.5% 文件 token）；违规文件重新生成。
8. **查询文本不得包含 gold 文件路径、文件名或导航文件条目名**；导入时做子串检查并人工复核命中项（防止“答案写在问题里”）。
9. 语料中每个文件的编码可解码为 UTF-8；不可解码文件列入 `intake_report.json` 并人工决定是否排除。

### 7.4 dev/test 切分与统计功效

**切分**：按 `track × topic × n_gold` 分层，70% dev / 30% test，固定 seed。扰动集跟随其 base 查询所在侧；负样本按 70/30 切分。

**功效说明（设计期估算，非实测）**：以 McNemar 精确检验、双侧 α=0.05、真实效应 10pp，对不一致对比例（discordance）做情景假设：

| 评测范围 | 查询数 | discordance 20% | discordance 30% |
|---|---|---|---|
| 全量 274 | 274 | 功效 ≈ 0.96 | 功效 ≈ 0.84 |
| 仅 test（30%） | 82 | 功效 ≈ 0.40 | 功效 ≈ 0.37 |

结论：**把主判定放在仅仅 82 条的 test 上，功效不足**。因此本设计采用：

- **主分析**：在**全量 274** 上评估 dev 冻结后的配置；
- **偏差检查**：test 子集结果必须落在全量估计的 95% CI 内；若显著背离，结论降级为“未决”并记录原因；
- 所有结论同时报告“仅 dev”“仅 test”“全量”三列，读者可自行核对乐观程度。

这是对 2026-10-19 讨论中 70/30 test-only 判定方案的**修订**：封存仍然存在（test 不参与任何选择），但主判定不用 82 条小样本硬判。若坚持 test-only 判定，则必须在预注册中把最小可检测效应上调，并接受“多数结果将为未决”。

### 7.5 多 gold 标注

- 范围：172 条 index case；search case 暂不标注（精确 token 查询通常单 gold），若有明显多文件答案可在标注中追加。
- 方法：标注者仅拿查询文本与语料树，逐条判断“回答该症状需要读哪些文件”，记录全部相关文件；不排序、不分级（nDCG 用二值相关）。
- 时间盒：1-2 小时/全量；导入后冻结，任何修改产生新版本号 `annotation_v2` 并记录。

### 7.6 扰动集

| 档位 | 规则（预注册） | 禁止 |
|---|---|---|
| 同义改写 | 替换非术语措辞（如“收不到”→“没有收到”），保留寄存器名/错误码/外设名原样 | 改变查询意图、增加或删除关键实体 |
| 错别字 | 仅对中文非 token 字符做 1-2 处形近替换（如“串口”→“串囗”） | 修改英文标识符、十六进制值、型号 |
| 口语化 | 加入口语连接词与冗余表达，不引入新事实 | 增加症状细节、改变问句目标 |

三档各从 274 条中分层抽 50 条（固定 seed）；同一 base 可出现在多档，但每档独立评分。生成后人工过目，`reviewed=true` 才计入。

### 7.7 负样本

- 20-30 条，覆盖“KB 有相近主题但无对应症状文件”“型号/外设未覆盖”“问题本身非 KB 可答（纯硬件测量）”三类。
- 判据：所有方案都不得返回与查询主题无关的假候选；正确行为是显式“无匹配/低置信”。
- **阈值选择**：各方案的拒答阈值只在 **dev 负样本**上选择（固定规则：使 dev 正确拒答率 ≥ 80% 的最低阈值），冻结后再用于 test；阈值与选择记录写入预注册。
- 评分：在 test 负样本上报告假候选率、正确拒答率、AUROC（用候选分数区分正/负查询）。

### 7.8 规模实验（H3，可选阶段）

- 目标规模：1x（103）/10x（约 1030）/100x（约 10300）。
- 合成方法：以非 gold 的 reference/system 文本为模板，重排段落、替换厂商名与寄存器命名空间，生成干扰文件；不复制 gold 文件内容。
- 泄漏守卫：§7.3 第 7 项；每次扩容重新校验。
- 成本：100x 下 B 的工具循环成本与 A 的索引构建成本单独报告；若成本不可接受，H3 只报 C/C′ 的退化曲线并注明 B 未跑。

## 8. 方案定义

### 8.1 统一输出契约

每个方案对每个查询输出：

```json
{
  "query_id": "idx-001",
  "scheme": "A",
  "status": "ok | no_match | error | timeout",
  "candidates": [{"path": "protocols/uart-no-rx.md", "score": 0.83}],
  "latency_ms": 1234,
  "cost": {"input_tokens": 0, "output_tokens": 0, "estimated": false},
  "trace_path": "results/runs/<id>/raw/A/idx-001.jsonl"
}
```

- `candidates` 按方案自己的排序输出；评分时**不重排**。
- 分数仅用于拒答阈值与 AUROC；不同方案分数不可直接比较。
- 并列分数按路径字典序（POSIX）打破，所有方案一致。
- 输出路径统一相对 `corpus/kb/` 的 POSIX 形式；解析失败或越界路径视为 `error`。
- 导航文件（`index.yaml`、`_vendor-index.md`、`_sources.md`）在评分前统一从候选里移除，所有方案同规则（T11）。
- `status != ok` 一律按 ITT 计 miss，并计入失败率。

### 8.2 A：向量 RAG

- 切块：整文件或按 Markdown section（标题层级），二选一由 dev 决定；chunk 上限 1200 字符、重叠 100 字符（预注册）。
- Embedding：候选 1 本地 `BAAI/bge-m3` 类多语模型；候选 2 OpenAI 兼容 `/v1/embeddings`；向量 L2 归一化，余弦相似度。
- 聚合：同一文件取 chunk 最大相似度作为文件分数；文件排序后取前 5。
- 查询：原文直接编码，不做改写；不拼接主题域。
- 索引构建时间单独记录，不计入查询延迟。

### 8.3 B：Agentic search

- 工具面：`glob(pattern)`、`grep(pattern, glob?, max_results=100)`、`read(path, offset?, limit?)`、`submit(paths[], confidence, reason)`。
- 路径限制：所有工具只能访问 `corpus/kb/`；越界返回结构化错误。
- System prompt（预注册全文）：说明这是知识库检索任务、工具语义、候选数量上限（5）、必须调用 `submit`、禁止猜测。不含轨标签、主题域、index 结构。
- 轮数：最大工具调用轮数由 dev 网格决定；达到上限未提交 → `status=timeout`，计 miss。
- 读取截断：2000 行 / 256 KiB；`grep` 返回上限 100 条，超出标注截断。
- LLM：temperature=0；重复 3 次（或固定 seed）；成本按 usage 计。

### 8.4 C：现状基线（index + grep）

- 忠实复现 kb-mcp：
  1. `kb_lookup(query)`：按 `index.yaml` 关键词命中打分，返回 top-2；
  2. 若 lookup 无命中，`kb_search(query)`：提取精确 token（大写标识符、十六进制、已知错误码/flag 名）后 grep，返回命中文件。
- **统一 dispatch**：不读取轨标签。规则固定为“`kb_lookup` 存在关键词得分 > 0 的条目则取 top-2，否则对查询提取精确 token 并走 `kb_search`”；预注册。`kb_lookup` 无得分条目时不得返回任意候选。
- **候选数量口径**：部署形态只返回 top-2；Recall@5 的“扩展 top-5”从同一排序截取，报告中标 `extended`，不与 A/C′/B 的原生 top-5 混为一谈（T12）。
- 诊断项（不作主结果）：按 `track` 选择工具的 “oracle dispatch” 单列，用于量化“如果知道查询类型，C 能好多少”。
- 消融：C-no-index（跳过 lookup，仅 search）。

### 8.5 C′：BM25 + grep

- 切块：整文件或按 section（dev 选择）。
- 分词：中文用 CJK 二元字符或 jieba（dev 选择）；英文/标识符用正则 token（`[A-Za-z_][A-Za-z0-9_]*`、十六进制、`0x[0-9A-Fa-f]+`）；大小写不敏感但保留原名。
- BM25：k1 ∈ {0.9, 1.5}、b ∈ {0.5, 0.75}（dev 选择）；文件分数取 chunk 最大分。
- grep 复核：对 top-20 chunk 中的精确 token 做二次命中，命中文件加固定小分（预注册 `+0.05`，仅用于打破近分并列）；不改变 top-2 之外文件的进入资格。
- 输出前 5 个文件。

### 8.6 D：混合（条件启用）

两个预注册变体：

- **D1**：C′ top-3 文件 → B 精读（工具轮数预算减半）→ `submit`；
- **D2**：A 与 C′ 各取 top-5 → 合并去重 → B 按同预算重排 → `submit`。

只在 H5 有信号时运行。**H5 信号的预注册判据**（任意一条成立）：

1. A 与 B 在“自然语言症状”与“精确 token”两类查询上的 Recall@2 差距方向相反，且两侧差距均 ≥ 5pp；
2. 某一方案在某一类查询上比该类最优方案低 ≥ 10pp，且其 95% CI 上界仍低于最优方案的点估计；
3. 任一方案在某类查询上 `status != ok` 的比例 ≥ 10%，而另一方案 < 3%。

不满足则不运行 D，报告中写明“H5 无信号，D 未运行”，不得事后凑判据。

### 8.7 消融项（预注册，不作主判定）

| 消融 | 目的 |
|---|---|
| C-no-index | 量化 `index.yaml` 结构的贡献 |
| A-no-chunk（整文件）vs A-section | 量化切块影响 |
| B-no-grep（仅 glob+read） | 量化精确 token 工具的价值 |
| C′ 去 grep 复核 | 量化二次复核贡献 |

## 9. 运行协议

### 9.1 阶段门禁

| 门 | 内容 | 通过条件 |
|---|---|---|
| G0 资产导入 | 同步语料、导入 JSONL、生成 manifest、校验、切分 | §7.3 全部通过；`intake_report.json` 无 error；`PREREGISTRATION.md` 冻结并记哈希 |
| G1 dev 调参 | 按 §6.3 网格跑 dev；记录全部配置；冻结 resolved 配置 | 网格结果完整；resolved 配置哈希追加进预注册 |
| G2 确认性评测 | 只跑冻结配置；B/D 重复 3 次 | 配置哈希校验通过；无任何配置改动 |
| G3 分析 | 指标、统计、失败归因、图表 | 所有图表的底层 CSV 存在；失败抽样可复现 |
| G4 决策与报告 | 按 todo §6.2 映射；写报告与 README | 结论含“证据强度”一栏 |

### 9.2 环境与可复现

- **运行环境**：实验是独立 uv 项目，自带 `.venv/`（由实验目录 `.gitignore` 忽略），与主仓库的 Node 项目互不影响，也不共享主仓库依赖。
- 依赖声明与锁定：`experiments/rag-vs-agentic-search/pyproject.toml` + `uv.lock` 进版本库；`.venv/` 不进库。
- **依赖安装禁令适用**：agent 不得执行 `uv sync` / `uv add` / `uv pip install` / 模型下载；只把命令输出给用户，确认完成后再继续。`uv run` 会在缺失环境时自动装包，因此 agent 也不得在环境未就绪时直接运行 `uv run`。
- Python ≥3.11（本机 3.13.5）；环境就绪后，运行命令统一为 `uv run <cmd>`（在实验目录内执行）。
- **依赖安装禁令适用**：agent 不得执行 `uv sync` / `uv add` / 模型下载；只输出命令给用户执行。
- 每次运行写 `env.json`：OS、CPU、Python、uv、锁文件哈希、模型名与版本、网关 base URL（不含密钥）、语料 manifest 哈希、代码 git SHA、种子。
- 网络：单元测试离线；live 运行必须显式设置 `RAGLAB_LIVE=1`，缺省跳过并标记 `skipped_no_model`。
- Windows 路径：内部一律 POSIX 相对路径；读写磁盘时转换；测试覆盖盘符与反斜杠输入。

### 9.3 run_id 与缓存

- `run_id` 计算见 §6.2；同一 `run_id` 重复运行追加 `repetition`。
- Embedding 缓存：键为 `sha256(chunk_text) + model_id`；缓存命中不改变结果，只影响延迟统计（延迟报告必须标注是否含缓存）。
- LLM 调用不缓存（避免把重试/波动藏起来）；原始响应全文落 `raw/`。

### 9.4 失败处理

- 单查询失败不中止整批；写入 `errors.jsonl` 并继续，最终按 ITT 计分。
- 连续 5 次网关错误中止整批并保留已完成结果；退出码非零。
- 超时：A 单查询 30s；B 单查询 300s（含 LLM）；C/C′ 10s；可在配置中收紧但需预注册。

## 10. 指标与统计

### 10.1 指标定义（与 todo §6.1 对齐，消歧）

| 指标 | 口径 |
|---|---|
| Recall@k | gold 集合与 top-k 的交集数 ≥ min(k, |gold|) 记为命中；多 gold 同时报“分数型召回”（交集/|gold|）作辅助 |
| Hit@1 | top-1 属于 gold |
| MRR | 1/首个 gold 的名次；无命中记 0 |
| nDCG@5 | 二值相关（gold=1），DCG=Σ rel_i/log2(i+1)，IDCG 按 gold 数计算 |
| 假候选率 | 负样本中 `status=ok` 且候选非空的占比 |
| 正确拒答率 | 负样本中 `status=no_match` 或分数低于预注册阈值的占比 |
| AUROC | 用“正查询的候选最高分”与“负查询的候选最高分”计算；无候选记 0 |
| 延迟 | 单查询墙钟时间，P50/P95；索引构建时间单列 |
| token 成本 | 输入/输出/缓存 token；无 usage 时估算并标记 |
| 扰动衰减率 | (干净 Recall@2 − 扰动 Recall@2) / 干净 Recall@2，按档位报告 |

### 10.2 统计方法

- 配对 bootstrap（10,000 次，按 `track` 分层）估计指标差的 95% CI。
- 二值主指标（Recall@2）用 McNemar 精确检验；比较族固定为：A vs C′、A vs B、C′ vs C、D vs 最优单一方案；Holm 校正。
  - **族大小固定为 4，不因缺数据而缩小**：缺席的族内比较按 p = 1 计入 Holm 的族大小。
    2026-10-21 实测踩到过：缺席项原先被直接剔除，Holm 的乘数从 4 掉到 2，
    校正后 p 值凭空小一半（C′ vs C 从 9.9e−07 变成 4.9e−07）。
    **族是预注册时定死的，缺数据不会让它变小**——让族变小等于让数据缺失的那一项
    「白赚」一个校正系数。
  - **配对必须先校验**：McNemar 与配对 bootstrap 要求两方案在**同一批查询、同序**上比较。
    跑批文件顺序不保证一致（续跑出来的可能不同），不校验就会算出
    「A 的第 3 条 vs B 的第 7 条」这种无意义比较，**而且 p 值看上去还挺正常**——
    不会报错，只会是错的。实现见 `report/analysis.py` 的 `check_alignment`。
- 子组分析（自然语言 vs 精确 token、主题域、单/多 gold）只报效应量与 CI，不做多重比较后的强结论。
- 未达到预注册判定条件时，结论写“未决（insufficient evidence）”，不得四舍五入成方向性结论。

### 10.3 失败归因

- 从各方案 miss 中按固定 seed 抽 30 条，人工归类：查询歧义 / 术语不匹配 / 排序失败（候选内但排名低）/ 未召回 / 工具或超时失败 / 拒答误判 / 多 gold 覆盖不足。
- 归因表进 `results/tables/failure_attribution.csv`；抽中的查询 id 与 rubric 版本记录在案。

### 10.4 决策映射（跑完后如何落到 todo §6.2）

| todo §6.2 条目 | 本实验的判定输入 | 输出写法 |
|---|---|---|
| B/C/C′ 对 A：Recall@2 ≥ A 且 Hit@1 ≥ A，H4 通过 | 全量 Recall@2/Hit@1 差的 95% CI；B 的 token 成本与 P95 延迟 | 写“维持无 RAG”，并注明是哪一个稀疏方案胜出、差距与 CI |
| A 在自然语言查询上领先最优稀疏 ≥ 10pp | 自然语言子组的点估计与 CI；若 CI 下界 < 10pp，不判 | 不满足则写“未达 10pp 或证据不足”，不写“接近” |
| C′ 较 C 提升 ≥ 5pp 且无 RAG 依赖 | 全量 Recall@2 差 + McNemar 校正后 p 值 | 写“C′ 上位 / 保留 C 兜底”及具体配置 |
| H3 规模阈值（10x/100x 跌破 85%） | 规模曲线；若 B 未跑需注明 | 写“阈值点或未观察到阈值”，并标注合成语料的限制 |
| P95 延迟 > 3s | 各方案 P50/P95 | 写“只用于夜批/离线”，并给出实测值 |
| H6 扰动衰减 > 15pp | 三档各自的衰减率 | 写“需前置查询归一化”，列出触发档位 |
| H7 假候选率 > 20% 或无拒答通道 | test 负样本指标 + 阈值来源 | 写“必须加置信阈值/显式无匹配”，若已具备则记录阈值 |
  - **阈值按方案各自选**，不可跨方案共用（各方案分数量纲不同）。
  - **某方案没有负样本跑批实现时，整块 H7 标「不报」**，不得用「没人跑过」
    换来的 `no_match` 充当成绩——「没跑」和「跑出来满分」在报告里长得一模一样。
    2026-10-20 实测踩到过：方案 B 被算成「正确拒答率 100%」，实际只是没跑过。

每个条目必须同时给出：**效应量、95% CI、样本量、是否达到预注册条件、最终判定（采纳/未决）**。任何一条不满足显著性要求时，只能写“未决”，并在结论汇总表里保留原假设编号。

## 11. 图表与表格

图由 `src/raglab/report/charts.py` 从 `results/scored/*.csv` 生成；每张图对应一份底层 CSV。

| 文件 | 内容 | 关联假设 |
|---|---|---|
| `fig1_recall_by_type.png` | 两类查询 × 方案 Recall@2，95% CI | H1/H2 |
| `fig2_metrics_overall.png` | Recall@2/5、Hit@1、MRR、nDCG@5 分组柱状 | 主指标 |
| `fig3_latency_cdf.png` | 延迟 CDF，标注 P50/P95 | H4 |
| `fig4_cost_quality.png` | token 成本 vs Recall@2 散点（B/D） | H4 |
| `fig5_perturbation_decay.png` | 三档扰动 ΔRecall@2 | H6 |
| `fig6_rejection_roc.png` | 拒答 ROC + 假候选率 | H7 |
| `fig7_scale_recall.png` | 1x/10x/100x 规模曲线 | H3 |
| `fig8_domain_heatmap.png` | 主题域 × 方案 Recall@2 热力图 | 弱域定位 |

表格（CSV + Markdown 双份）：`overall.csv`、`by_track.csv`、`by_topic.csv`、`by_gold_count.csv`、`cost.csv`、`failures.csv`、`grid_search.csv`、`decision_matrix.csv`。

风格约束：单图只表达一个结论；坐标轴带单位与样本量；CI 以误差线表示；黑白打印可区分（线型/标记区分，不只靠颜色）；图注写明方案、数据切分与运行次数。

## 12. 目录结构与独立 README

目录位于主仓库根目录下，是**自包含的独立项目**：拥有自己的 `README.md`、`docs/` 与 `.gitignore`。

```
experiments/rag-vs-agentic-search/
├── README.md                 # 独立入口（大纲见下）
├── STATUS.md                 # READY / BLOCKED(<材料编号>) / RUNNING / DONE
├── .gitignore                # 语料、.venv、results/runs、缓存不进库
├── docs/                     # 实验自己的文档目录
│   ├── README.md            # 文档入口（指向主仓库设计文档，不复制内容）
│   ├── fairness-protocol.md
│   ├── metric-definitions.md
│   ├── annotation-guide.md
│   └── runbook.md
├── PREREGISTRATION.md        # 假设、指标、阈值、切分、网格、提示词哈希
├── pyproject.toml
├── uv.lock
├── config/
│   ├── experiment.yaml
│   ├── models.yaml
│   ├── schemes/{vector,agentic,index_grep,bm25_grep,hybrid}.yaml
│   └── prompts/agentic_system.txt
├── corpus/                   # 导入，不进库
├── data/                     # 评测集，进库
├── src/raglab/
│   ├── corpus.py  queries.py  metrics.py  stats.py  llm.py  embedding.py
│   ├── schemes/{base,vector_rag,agentic,index_grep,bm25_grep,hybrid}.py
│   ├── report/{charts,tables}.py
│   └── __main__.py           # import / split / index / run / score / report
├── tests/                    # pytest：指标、切分、防泄漏、导入校验
└── results/
    ├── runs/<run_id>/        # 原始 trace 与逐查询结果
    ├── scored/               # 评分后数据
    ├── figures/              # PNG
    ├── tables/               # CSV / Markdown
    └── summary.json
```

**当前骨架**（2026-10-19）：已建立 `README.md`、`STATUS.md`、`.gitignore`、`docs/README.md`；其余文件在实现阶段按本设计创建。`STATUS.md` 为 `BLOCKED`。

**独立 README 大纲**：实验问题与决策目标 → 当前状态（`BLOCKED` 时列出缺失材料）→ 目录说明 → 安装与运行（`uv sync` 等命令由用户执行）→ 复现步骤（import → split → index → run → score → report）→ 公平性协议摘要与预注册链接 → 方案与参数 → 指标定义 → 结果图表（跑完后嵌入）→ 决策结论 → 环境与限制。

**与主仓库隔离**：只有 `.py`/`.md`/`.yaml` 文件；不进入根 `tsconfig.json` 与 `vitest.config.ts` 的 include；根 `npm test`/`npm run build` 不受影响。实验目录自带的 `.gitignore` 忽略语料、虚拟环境、原始 trace 与缓存。**`node_modules` 与根 `.venv` 互不引用**；实验不修改根 `package.json`。

## 13. 工程约束

- Python ≥3.11，ESM 无关；依赖：numpy、scipy、matplotlib、pyyaml、jieba、httpx；可选组 `local-embed`（sentence-transformers）与 `api-embed`。
- BM25 自实现（约 60 行），不引入第三方 BM25 库，保证参数与打分公式完全可控。
- LLM 与 embedding 走裸 HTTP（OpenAI 兼容），不引入厂商 SDK，避免版本漂移改变调用行为。
- 测试用 pytest，默认离线；指标与切分逻辑必须有单测；导入校验必须有坏样本用例。
- 任何安装/下载命令只输出给用户，agent 不执行（AGENTS.md 依赖安装禁令）。
- 不真实执行危险命令（本实验不涉及 shell 工具；B 工具面不含 shell）。

## 14. 风险与限制

| 风险 | 影响 | 缓解 |
|---|---|---|
| 素材缺失 | 实验无法启动 | `STATUS.md=BLOCKED`；本设计不产出占位结果 |
| 274 条查询功效有限 | 10pp 以下差异难判定 | 预注册功效说明；结论允许“未决”；子组只报 CI |
| `index.yaml` 偏袒 C，且 C 已在该回归集上调参（T13） | C 可能被显著高估 | 分层报告 + C-no-index 消融 + 盲写敏感性分析 + 报告标注“乐观上界” |
| 单标注者 | nDCG 可信度低 | 披露；可选 10% 双标 |
| 合成规模语料失真 | H3 外推受限 | 只作阈值提示，不作上线判据 |
| 网关波动/不可达 | B/D 无法运行 | live 显式开关；`skipped_no_model`；不伪造结果 |
| 缓存影响延迟 | 延迟被低估 | 延迟报告标注缓存命中；冷/热分别报告 |

## 15. 验收（本设计交付物）

1. 本文件通过评审，且 §6 的威胁-控制表、§7 的导入契约、§10 的统计口径完整（无未决占位）。
2. `dev-notes/M2-RAG对照实验.md` 记录本轮决策与用户原话。
3. 实验目录骨架位于 `experiments/rag-vs-agentic-search/`，含独立 `README.md`、`docs/`、`.gitignore` 与 `STATUS.md=BLOCKED`；不写实验代码、不装依赖、不产出结果。
4. 后续实现以本文件为 spec 另写 plan；素材到位前不启动实现。

## 16. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-19 | 初版：确立公平性协议、资产阻塞项、dev/test 与功效修订、方案与运行门禁、图表与 README 规格 |
| 2026-10-19 | 自审修订：补 T11-T13（导航文件、C 的 top-2 口径、C 的调参乐观偏差）；补 §10.4 决策映射；负样本阈值改为 dev 选；多 gold 改为增强项；依赖禁令扩展到 uv；统一 §6.3/§8.1/§8.6 交叉引用 |
