# M2 RAG vs Agentic Search 对照实验

## 2026-10-19 · 设计阶段（只出设计，不实现）

**用户关键原话**：`@docs/rag-vs-agentic-search-todo.md @docs/m2-roadmap.md ,设计实验方案，尽可能保证公平。实验需要单独文件夹，需要输出相关数据图表比对，需要独立README`；随后确认：`暂时不考虑这些，可以落在文档中表示待获取材料`、`纯Python吧，不动本仓库，独立实验。依赖管理用uv`、目录选 `主仓库内新建 experiments/ 子目录`、`只出设计不实现`、模型策略 `可配置 + 预注册候选`、最终 `按推荐`。

**关键产出**

- Spec：`docs/superpowers/specs/2026-10-19-rag-vs-agentic-search-experiment-design.md`。
- 核心内容：§6 公平性威胁-控制表（T1-T10）、§7 语料/评测资产导入契约与校验门禁、§8 五方案统一输出契约与消融、§9 G0-G4 运行门禁、§10 指标与统计口径、§11 图表清单、§12 目录结构与独立 README 大纲。
- 素材状态：Phase 0 KB（103 文件 + index.yaml）与 274 条查询（regression.py）**未取得**，登记为 M1-M5 阻塞项；素材到位前 `STATUS.md` 必须是 `BLOCKED`，不得产出占位结果。

**被拒绝或纠偏的内容**

- 未按“四方案一起做”推进：用户选择先只出设计。
- 未采用“在 test 集上直接判定”：设计期功效估算显示 82 条 test 查询在 10pp 效应下功效仅约 0.37-0.40，改为“主分析用全量 dev 冻结配置 + test 做偏差检查”，封存仍保留。这是对先前 70/30 方案的修订，已在 spec §7.4 明示。
- 未给 C 提供轨标签：采用预注册统一 dispatch，另报 oracle dispatch 仅作诊断。
- 未让 B 自由文本作答：强制 `submit` 工具提交排序候选，未提交按 ITT 计 miss。
- 未引入第三方 BM25 库或厂商 SDK：BM25 自实现、模型走裸 HTTP，控制参数与版本漂移。
- 未创建 `experiments/` 目录、未安装任何依赖、未使用 `node -e` 拼接文档。

**翻车与返工**

- 论证“要不要 70/30 切分”时先按用户选项写了封存判定，随后用精确 McNemar 功效计算发现 test-only 判定不可行（82 条 test 在 10pp 效应、discordance 20-30% 时功效仅约 0.37-0.40），回改 spec 并显式标注为修订，避免把低功效设计包装成结论。
- 本机未找到 Phase 0 语料与回归脚本；按用户指示转为文档中的待获取材料清单，未用搜索结果或猜测替代。
- 自审发现三处公平性缺口并补进 spec：T11 导航文件不得作为候选、T12 C 的 top-2 部署口径与 Recall@5 扩展口径、T13 C 已在该回归集上调到全绿（训练集=测试集）的乐观偏差；另补 §10.4 决策映射、负样本阈值改为 dev 选、多 gold 改为增强项。

## 2026-10-20 · 开实验分支

**用户关键原话**：`开实验分支`。

**关键产出**：从 `main`（`8b45e52`）新建并切换到 `feat/rag-experiment`；工作区未跟踪文件（设计文档、dev-notes、`experiments/` 骨架）随工作区保留。未提交、未推送。

**被拒绝或纠偏的内容**：未从 `feat/m2-event-bus` 分支切出（该分支含事件总线未合并提交 `6101af2`，会污染实验分支基线）；按 AGENTS.md 不使用 `git worktree`。

**翻车与返工**：无。

## 2026-10-20 · 修 frontmatter + 自建查询集

**用户关键原话**：`修；自建查询集。给我提交信息我自行提交`。

**关键产出**

- **frontmatter 修复**（用户选择"修"）：
  - 46 个文件、46 行，只给含未加引号冒号的 `description`/`summary` 值加引号。
  - 修复后 **unparseable = 0**（66 个可解析 / 42 个无 frontmatter）。
  - 字节级读写，CRLF 文件未被改写；改动范围核对：仅 46 个 md、每文件 1 行、正文零改动。
  - `manifest.sha256` 已重算，`verify_corpus` 通过。
- **自建查询集**：
  - `data/queries.jsonl` 80 条：index 轨 50（自然语言症状，按语料正文的症状描述写，不照抄 index.yaml 关键词）+ search 轨 30（精确 token）。
  - `data/negatives.jsonl` 25 条，覆盖三类负样本。
  - `data/splits.json`：seed 20261019，dev 55 / test 25。
  - `raglab import` 通过（ok=True）；仅剩多 gold 与扰动集两条 warning。
- **intake 语义修正**：扰动集与负样本按 spec §5.2 降级为非必需资产——缺失只记 warning 并注明阻塞 H6/H7，不再阻断 G0；查询集与切分仍为 fatal。同时修复了一个真实缺陷：`load_perturbations`/`load_negatives` 的 warnings 未合并回主报告。
- **新增未索引 gold 检测**：`unindexed_gold_queries()`，导入时报告 "11/80 条查询的 gold 不在 index.yaml 中（方案 C 结构性无法命中）"。这是口径事实，不阻断导入。
- 测试从 143 增至 **148 passed**（新增 H6/H7 降级 2、必需资产仍 fatal 2、未索引 gold 1）。

**被拒绝或纠偏的内容**

- 未用 `index.yaml` 的 keywords 反推查询：那等于直接给方案 C 送分，会让实验系统性偏袒 C。
- 未把"11 条未索引 gold"删掉或改成已索引文件：那会人为抬高 C 的成绩；改为保留并强制在报告中分层。
- 未把扰动集/负样本缺失当 fatal：spec §5.2 明确它们只阻塞各自假设。
- 未在修复脚本里用 `read_text()`（会把 CRLF 静默转 LF），改用 `read_bytes`。

**翻车与返工**

- 首次写 `_read_jsonl` 时只加了 `required` 参数，却忘了把子报告的 warnings 合并回主报告，导致降级后的提示丢失；由新增测试抓出。
- 新增的两个测试最初复用了单查询 fixture，而 `splits.json` 引用了 `idx-002`，触发了分区校验错误——是 fixture 问题不是产品缺陷，已改用两查询 fixture。
- "未索引 gold"测试最初往语料里加了新文件却没重算 manifest，被 T1 的漂移校验正确拦下；补 `write_manifest` 后通过（这次拦截本身证明防线有效）。

**必须披露的偏差**

1. 单标注者（无一致性系数）。
2. 11/80 条 gold 不在索引中，方案 C 需分层报告。
3. 样本量 80 < 原设计 274，功效下降。

## 2026-10-20 · M1 语料体检与迁移；M2 确认缺失

**用户关键原话**：`@docs/kb-export k b-export拿到了，检查一下，先不要开始实验`；`查询集是必须的吗`；`拿不到，然后这些文件做一下整理，迁移走`。

**关键产出**

- 对 `docs/kb-export/` 做只读体检（未改任何文件）：
  - 108 md + 1 yaml，478 KB；全部合法 UTF-8、无 BOM、无空文件、无重复内容。
  - `index.yaml` 90 条目（spec 称 85），全部指向存在的文件，无越界路径。
  - 文件名全 ASCII、无空格、最长相对路径 47 字符，Windows MAX_PATH 无风险。
  - **46 个文件 frontmatter YAML 解析失败**：`description` 值含未加引号的冒号；仅 20 个可解析，42 个无 frontmatter。
  - 三种 frontmatter schema 并存（id/title 系 / name/description 系 / complexity/domain 系）。
  - `_inbox.md` 51 KB / 38 条未审阅条目；`cases/_about.md` 为使用说明，均不应作为可检索语料。
  - 15 个 reference 文件不在 index 中（reference 39 个，索引 24 个）。
- 迁移：`docs/kb-export/` → `experiments/rag-vs-agentic-search/corpus/kb/`（被实验 `.gitignore` 忽略）。迁移前后 109 个文件逐一 SHA-256 比对一致；`manifest.sha256` 已生成，`verify_corpus` 返回空。
- `config/experiment.yaml` 的 `navigation_files` 增加 `_inbox.md`、`_about.md`。
- `STATUS.md` 重写：记录 M1 实收偏差、M2 缺口与后果、允许/禁止动作。
- 143 项 pytest 仍全通过；`raglab import` 在语料侧无错误（仅剩 M2 相关的 queries/splits/negatives 三项缺失）。

**被拒绝或纠偏的内容**

- **未修改语料内容**（用户选择"不动内容"）：46 个坏 frontmatter 保持原样，因为按 spec T1 语料一旦修改即算新实验；修不修由用户在预注册中决定。
- **未用自检索/人工抽查冒充实验结果**：向用户明确了这些只是链路冒烟，不能用于方案比较，决策点 #2 无法据此关闭。
- 未把 `corpus/` 放进 `docs/`：按 spec §7.1 语料归 `corpus/kb/` 且不进版本库。

**翻车与返工**：无。

**遗留决策（待用户）**

1. 46 个坏 frontmatter 是否需要修复（会改变语料哈希，需换 `run_id`）。
2. M2 缺失是否走"自建查询集"路线（等同 M5 人工标注，单标注者需披露）。

## 2026-10-20 · 后段链路闭环（M1/M2 仍拿不到）

**用户关键原话**：`M1、M2暂时拿不到`（承前一条 `uv run pytest跑完了`）。

**关键产出**

- 新增三个纯逻辑模块：
  - `splitting.py`：`track × topic × n_gold` 分层切分，固定 seed 可复现；单条层整层进 dev；test 为空时报错而非静默产出空分区。
  - `scoring.py`：`score_one` 逐查询评分（ITT，非 ok 记 miss）+ `summarize` 固定维度分组汇总 + `read_results_jsonl`（坏行直接失败）。
  - `prereg.py`：预注册冻结判定（文件中无「未生成」占位符 + 存在「## 冻结记录」节）、`config/resolved/<scheme>.json` 校验、`require_confirmatory_ready`（禁止 dev、要求冻结）。
  - `env.py`：`env.json` 记录 OS/Python/uv 版本/uv.lock 哈希/manifest 哈希/git SHA/seed/网关地址；取不到的项进 `missing`，不伪造。
- CLI 从「只有 import 能跑」扩展为 `import / split / score / report / env` 全部可用；`index`/`run` 仍退出码 3。
- 测试从 105 增至 **143 passed**（新增 splitting 9 / prereg 10 / scoring 9 / env 5 / CLI 重写 12）。

**被拒绝或纠偏的内容**

- 未给 `score` 加"自动挑最优配置"之类便利：那等于在 test 上做选择。
- 未让 `score` 在缺 `splits.json` 时默认按全量评分：`--partition dev|test` 会显式要求切分文件，缺失即退出码 3。
- 未在 `env.json` 里写密钥：只记 base_url 与模型名，测试断言序列化结果不含 `api_key`。
- 未伪造 `git_sha`/`uv_version`：取不到就 `null` 并进 `missing`。

**翻车与返工**

- 重写 CLI 后，旧 `tests/test_cli.py` 仍断言 `split/score/report` 退出码 3，4 项失败；这些断言反映的是"实现前"的状态，已按新行为重写（新增 split 落盘、score 产出表格并标 exploratory、confirmatory 拒绝 dev、env 落盘等用例）。

## 2026-10-20 · 代码骨架（素材绕过）

**用户关键原话**：`素材可以先绕过去吗？把实验骨架搭好`。

**关键产出**

- 建立独立 uv 项目：`pyproject.toml`（hatchling 后端、`src/` 布局、pytest 离线配置）、`config/experiment.yaml`、`models.yaml`、`schemes/*.yaml` 五份、`prompts/agentic_system.txt`、`PREREGISTRATION.md`（DRAFT，未冻结）、`data/README.md`、`docs/` 四份（runbook / fairness-protocol / metric-definitions / annotation-guide）。
- 已实现的**纯逻辑**模块：`paths`（POSIX 归一化 + 越界防护）、`corpus`（manifest 生成/校验，T1）、`assets`（JSONL schema + G0 交叉校验）、`intake`（导入门禁编排）、`metrics`（Recall/Hit/MRR/nDCG/假候选/拒答/AUROC/衰减）、`stats`（McNemar 精确检验、配对分层 bootstrap、Holm）、`llm`（OpenAI 兼容客户端 + `RAGLAB_LIVE` 门禁）、`config`、`runner`（统一契约 + ITT + 连续网关错误中止）、`report/tables`。
- **显式占位**：五个方案（A/B/C/C′/D）与图表均抛 `FeatureNotImplemented`，不返回空候选；CLI 的 `split/index/run/score/report` 一律退出码 3。
- 测试：`tests/` 10 个文件（pytest），覆盖路径越界、指标口径、统计检验、schema 坏样本、manifest 漂移、live 门禁（MockTransport）、ITT、CLI 退出码。

**验证情况（诚实记录）**

- 本机全局 Python 3.13.7 的 pytest 缺 `pluggy`，无法运行 pytest；改用仓库外的临时断言脚本（`%TEMP%/raglab_verify.py`，已删除）对同一批逻辑做等价校验：126 项全通过。`python -m compileall` 通过。
- 用户执行 `uv sync` 后 `.venv/` 与 `uv.lock` 生成；用 `.venv/Scripts/python.exe -m pytest` 实跑 **105 passed（4.55s）**，覆盖 11 个测试文件（assets 21 / paths 13 / metrics 12 / config 9 / stats 9 / cli 8 / llm 8 / corpus 7 / intake 6 / runner 6 / schemes_base 6）。临时脚本的 126 项含部分非 pytest 断言（如合并断言），与 105 个用例不是一一对应。`raglab run` 退出码 3 符合预期。
- 根仓库 `npm test` 在本次改动后出现 1 个既有用例失败（`tests/mcp-manager.test.ts` 的 abort 时延断言 `700ms < 600ms`）；单独重跑该文件 35 项全过，判定为机器负载下的计时抖动，与实验目录改动无关（实验目录不进 vitest include）。

**被拒绝或纠偏的内容**

- 未生成任何占位语料、占位 queries.jsonl 或占位 gold——用户允许"绕过素材"，但 spec 与 STATUS.md 明确禁止用占位数据产出结果；骨架因此只实现纯逻辑，不产出任何"看起来像结果"的文件。
- 未执行 `uv sync` / `pip install`（依赖安装禁令），只输出命令。
- 未让占位方案返回空候选：那会把"未实现"伪装成"零命中"，违反 R3 与 T5。
- `uv_build` 改为 `hatchling`：避免 uv CLI 版本与构建后端版本耦合（原写法要求 `uv_build>=0.11,<0.13`，与 uv 0.11.3 可用性存疑）。

**翻车与返工**

- 首次设计 `RetrievalScheme.run` 时用 `except Exception` 兜底，会把 `FeatureNotImplemented` 吞成逐查询 `error`，导致"未实现"统计成"检索失败"。已改为对 `BlockedError` 重新抛出。
- 临时验证脚本里三处断言写错（fixture 文件名不匹配、`Scripted` 未拷贝列表导致 pop 清空调用方列表、missing-gold 用例用了已有文件的语料根），修正后 126/126 通过；对应 pytest 用例已同步修正。

## 2026-10-20 · worktree 与实验流程约定

**用户关键原话**：`开worktree进feat/rag-experiment，不使用.claude目录`；随后 `好了，这个实验不走superpowers`（依赖已装好；本实验不使用 superpowers 流程）。

**关键产出**

- 用 git worktree 在 `.worktrees/feat-rag-experiment` 检出既有分支 `feat/rag-experiment`（HEAD `dfb2628`，工作区干净），未使用 `.claude/worktrees/`；`.worktrees/` 写入 `.git/info/exclude`，仅本地忽略、不改版本库 `.gitignore`。
- 用户执行 `npm install` 后，在该 worktree 跑 `npm test`：54 文件通过，1521 passed / 1 skipped，基线干净。
- 实验仍为 `BLOCKED`：M1-M5 素材未到位，未实现、未跑批。

**被拒绝或纠偏的内容**：本实验不走 superpowers（不启用 brainstorming / writing-plans / TDD / subagent-driven 等技能流程），按 AGENTS.md 与实验 spec 直接推进。此前 dev-notes 中“按 AGENTS.md 不使用 git worktree”的记录被用户本次明确指令取代；worktree 使用已获用户特批。

**翻车与返工**：无。

## 2026-10-19 · 实验目录骨架

**用户关键原话**：`实验文件夹是在本项目根目录下的，拥有独立docs文件夹、README、.gitignore`。

**关键产出**：建立 `experiments/rag-vs-agentic-search/` 骨架：
- `README.md`（独立入口：问题、BLOCKED 状态、目录、权威设计链接、公平性底线摘要、计划命令）
- `STATUS.md`（`BLOCKED` + M1-M5 阻塞表 + 状态变更记录）
- `.gitignore`（忽略 `corpus/`、`.venv/`、`results/runs/`、缓存）
- `docs/README.md`（独立文档入口，指向主仓库设计文档，不复制内容以避免漂移）

同步更新设计文档 §12（目录结构含 `docs/`）与 §15 验收第 3 条（骨架已建、无代码无依赖无结果）。

**被拒绝或纠偏的内容**：未创建 `pyproject.toml`、`config/`、`src/`、`data/`、`results/` 等实现期文件——用户要求“只出设计不实现”，骨架只含文档与忽略规则。

**翻车与返工**：无。

## 2026-10-19 · 设计要点确认与 spec 落盘

**用户关键原话**：`按推荐`（确认切分与封存、C 的统一 dispatch、B 的 `submit` 契约三点建议）。

**关键产出**：spec 落盘为 `docs/superpowers/specs/2026-10-19-rag-vs-agentic-search-experiment-design.md`。未创建 `experiments/` 目录、未写代码、未安装依赖。

**状态说明**：用户确认的是对话中的设计要点；书面 spec 尚未逐节复核，状态保持“待用户复核本文档”，不写成“已评审”。

**待办**：① 用户复核 spec；② 素材 M1-M5 到位后另写实现 plan（writing-plans），再进入实现与跑批。
