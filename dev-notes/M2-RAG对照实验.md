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

## 2026-10-20 · models.yaml 改为本地密钥文件

**用户关键原话**：`model.yaml填apikey应该ignore`。

**问题**：`config/models.yaml` 已被 c340423 提交跟踪，在里面填 key 会直接进版本库。

**关键产出**

- `git rm --cached config/models.yaml` 取消跟踪；`.gitignore` 增加 `config/models.yaml` 与环境文件规则。
- 新增 `config/models.example.yaml` 模板（不含密钥，`api_key: null`），入库。
- 本地 `config/models.yaml` 保留在磁盘上作可填写的本地副本。
- **补齐代码缺口**：此前没有任何代码读取 `models.yaml`，填了也不会生效。新增 `ModelCandidate` / `ModelsConfig` / `load_models()`，支持 `api_key`、`usable` 判定与 `redacted()`（日志/`env.json` 用，不暴露密钥）。
- 测试 155 → **165 passed**：新增模板可解析且无 `sk-`、本地文件被 ignore、本地文件未被跟踪、key 从本地文件加载、`redacted()` 不含密钥、`usable` 判定、四种非法配置拒绝。

**被拒绝或纠偏的内容**

- 未把 `models.example.yaml` 做成"复制即用"的完整配置：`base_url`/`model` 保持 `null`，避免误以为模板里填的就是生效值。
- `models.yaml` 缺失时返回空 `ModelsConfig` 而非报错——M4 未就绪是合法状态，不应阻塞 C′ 等离线工作。

## 2026-10-20 · 远程 API 密钥接线

**用户关键原话**：`M4的APIKEY填在哪`；`远程API`。

**背景**：此前 `OpenAIClient` 虽接受 `api_key` 参数，但**没有任何代码把环境变量传进去**，M4 即使配了密钥也不会生效。

**关键产出**

- `config.py`：`ModelConfig` 新增 `llm_api_key_env` / `embedding_api_key_env`（默认 `RAGLAB_LLM_API_KEY` / `RAGLAB_EMBED_API_KEY`）与 `llm_api_key()` / `embedding_api_key()` 读取方法；空值报 `ConfigurationError`。
- `config/experiment.yaml` 与 `config/models.yaml`：声明 `api_key_env` 字段，注明密钥只走环境变量。
- `docs/runbook.md`：补 bash 与 PowerShell 两套 live 运行的环境变量设置。
- 测试 148 → **155 passed**：新增 key 默认值、env 读取与覆盖、空名拒绝、Bearer 头发送、无 key 不发头、以及 `env.json` 不含密钥值的断言。

**被拒绝或纠偏的内容**

- **未提供 `.env` 文件方案**：实验目录的 `.gitignore` 没有 `.env` 规则，且代码未引 dotenv；写进 `.env` 有被误提交的风险。统一走环境变量。
- **未把 key 写进 `experiment.yaml` / `models.yaml`**：spec §9.2 与 T9 明确密钥不入库。
- 未让 `env.json` 记录密钥：只记 base URL 与模型名，并有测试断言序列化结果不含密钥值。

**遗留**：A/B/D 的实现尚未落地，密钥接线只是让实现阶段可用；当前 `index`/`run` 仍退出码 3。

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

## 2026-10-20 · 端点连通性实测（M4 解锁）

**用户关键原话**：`测试一下Api连通性`。

**方法**：先在 `%TEMP%\raglab_probe\` 写临时探针（当轮用完即弃），确认口径后固化到 `scripts/probe_endpoints.py`（见下一节）；全部经 `raglab.llm.OpenAIClient` 发真实请求；密钥只进请求头，输出里只出现 `api_key_set`，不打印密钥值。

**关键产出（实测，非推断）**

| 项 | LLM（`step-5-preview`） | Embedding（`BAAI/bge-m3`） |
|---|---|---|
| 连通 | 通过：回复 `pong`，首包 6.9s，稳态 3–7s | 通过：1024 维，L2 归一化（norm=1.0000） |
| 密钥校验 | 通过：不带 `Authorization` → 401 | 通过：不带 key → 401 `Token is invalid` |
| 批量 | — | 通过：110 条一次过，1.04s |
| 工具调用 | 通过：`finish_reason=tool_calls`，`kb_lookup` 参数 JSON 正确 | — |
| 多轮 tool 循环 | 通过：user → tool_calls → tool → 最终答案 | — |
| 确定性 | 不成立：同 prompt 3 次三份不同答案（temperature=0） | 非逐位一致：max_abs_diff≈0.0013–0.0022，余弦 0.999937 |

**LLM 的额外结构事实**

- 响应消息含 `reasoning_content`（推理模型），`content` 可能为空字符串。
- 第 2 轮回传 / 不回传 `reasoning_content` 都能跑通，客户端无须特殊处理；如需保留推理上下文可原样回传。
- `seed` 被接受但不回显，也无 `system_fingerprint`：`supports_seed: false` 的配置是准确的，不能靠 seed 复现。
- 长输出正常：请求 `max_tokens=1024`，返回 468 completion tokens，14.9s，`finish_reason=stop`。

**限流实测（本次最重要的发现）**

网关是共享队列，三种 429：`queue.full` / `queue.waiting` / `usage exceeds frequency limit`，均带 `retry in Ns`。

| 发起方式 | 成功 |
|---|---|
| 4 并发 | 0 / 4（全部 429） |
| 6 次连发（约 50ms 间隔） | 0 / 6 |
| 闲置 60s 后连发 2 次 | 2 / 2 |
| 10s 间隔 ×4 | 3 / 4（第 4 次 429，retry 27s） |
| 15s 间隔 ×5 | 5 / 5 |
| 30s 间隔 ×3 | 3 / 3 |

**可行口径：串行、单线程、间隔 ≥ 15s，约 4 次/分钟。并发与突发都不可用。**

按此估算跑批预算：

- 方案 B（80 查询 × repeat 3 = 240 次运行；agentic 每运行约 5–8 次调用）≈ 1,200–2,000 次调用 ≈ **5–8 小时**。
- B 的 dev 轮数网格 {6, 12, 20}（dev 55 条 × 3 重复 × 3 档）≈ **10 小时以上**。
- D1/D2 在此之上叠加。

结论：B 的重复次数与轮数网格必须按此预算重新预注册，否则跑不完。embedding 侧不是瓶颈（110 条/秒）。

**同一份配置下发现的文档与代码不一致（当轮记录，已于下一次提交前修复，见下节）**

- `docs/runbook.md` 与 `config/experiment.yaml` 写着可用 `RAGLAB_LLM_BASE_URL` / `RAGLAB_LLM_MODEL` / `RAGLAB_EMBED_BASE_URL` / `RAGLAB_EMBED_MODEL` 覆盖端点，但**源码里没有任何地方读这四个变量**；实际生效的只有 `models.yaml`（端点）与 `RAGLAB_LLM_API_KEY` / `RAGLAB_EMBED_API_KEY`（密钥）。
- `config/experiment.yaml` 的 `model.*` 段（`llm_base_url: null` 等）目前没有被任何调用方使用，与 `models.yaml` 是两套互不相通的配置。
- `config/models.yaml` 里"也可改用环境变量：RAGLAB_LLM_BASE_URL / …"这句注释同样不成立。
- **`env.json` 记录的不是实际使用的端点**：`cmd_env` 把 `experiment.yaml` 的 `model.*` 传给 `capture_env`，而该段全为 `null`；真实跑批读的是 `models.yaml`。跑批前必须修，否则 T9 的环境记录与事实不符。

按用户口径"不区分远程本地，有且能跑就行"，实测可用的是 LLM 候选 `remote-llm-1` 与 Embedding 候选 `api-embed-1`；`local-flash` 缺 model、`local-bge-m3` 缺可选依赖组，二者按设计判为不可用——判定与实际一致。

**被拒绝或纠偏的内容**

- 未把 429 当"端点不可用"：那是限流不是故障，重试即恢复。`raglab models` 的 `usable` 仍是离线判定、不触网，这个设计是对的。
- 未在 `raglab` 里加 `--live-probe` 子命令：连通性属于一次性人工确认，进 CLI 会把端点探测与退避重试逻辑带进产品代码。探针留在 `%TEMP%`。
- 未因"连通性通过"就把 STATUS 改成 READY：M3 仍缺，方案 C 无法忠实复现；A/B/D 的实现也尚未落地，仍不可跑完整对照。

**翻车与返工**

- 第一轮能力探针直接撞 429（`queue.full`），一度会把"网关限流"误读成"不支持 tool calling"；加退避重试后第二轮正常，确认支持。**教训：429 必须与能力失败分开判定。**
- `probe_budget.py` 把 4 并发当默认探测方式，结果全 429。这本身是正确的结论（并发不可用），但最初写法差点被读成"端点坏了"，已在脚本里改成一次一请求。

## 2026-10-20 · 收敛配置面：删掉没用的，修掉错的

**用户关键原话**：`没用的删掉。其他的修。先不开始实验`。

**判断口径**：上一节列出的四条不一致里，`experiment.yaml` 的 `model` 段与端点环境变量承诺属于**同一件事**——它们是 `models.yaml` 出现之前的旧方案残留，从未有任何调用方消费。留着只会让人误以为两条路径都能配端点。按"没用的删掉"，直接移除，不做兼容层。

**关键产出**

- **删除** `ModelConfig` 类及 `ExperimentConfig.model` 字段；`experiment.yaml` 出现 `model` 段现在直接抛 `ConfigurationError`（指向 `models.yaml`），而不是静默忽略。
- **删除** `DEFAULT_LLM_KEY_ENV` / `DEFAULT_EMBED_KEY_ENV` 与 `llm_api_key()` / `embedding_api_key()` / `llm_configured` / `embedding_configured`——密钥读取本来就该由拿到候选的那一层负责，配置类不该二次发明。
- **修 `env.json`（T9 缺口）**：`capture_env(models=ModelsConfig)` 改为接收 `load_models()` 的结果，写 `model_candidates`（全部候选，含 `usable` 与 `block_reason`，只含 `api_key_set`）。旧实现写的 `model.{llm_base_url,...}` 全为 `null`，与实际使用的端点不符。
- **同步文档**：`docs/runbook.md` 删掉"方式二：环境变量"整节（那是空头承诺），改为只讲 `models.yaml` + `raglab models`；`README.md`、`PREREGISTRATION.md`、`docs/fairness-protocol.md`（T4/T9 行）、`config/experiment.yaml`、`config/models.yaml` 注释一并订正。
- **测试 168 → 164**：删除 7 项针对已移除 API 的测试（`api_key_env` 默认值/读取/覆盖/空名拒绝、`llm_configured`、两处旧的 `model` 传参），新增 1 项 `test_model_section_is_rejected` 与 2 项 `env.json` 记录真实候选的断言。净减 4。

**关键验证（实测输出，不是推断）**

`raglab env` 现在写入的是真实候选：

```
"model_candidates": [
  {"id": "remote-llm-1", "base_url": "http://127.0.0.1:8788", "model": "step-5-preview", "api_key_set": true, "usable": true},
  {"id": "local-flash",  "block_reason": "缺少 model", "usable": false},
  {"id": "local-bge-m3", "block_reason": "缺少可选依赖组 local-embed", "usable": false},
  {"id": "api-embed-1", "base_url": "https://api.siliconflow.cn/v1", "model": "BAAI/bge-m3", "api_key_set": true, "usable": true}
]
```

`git grep` 确认密钥值与 `sk-` 前缀均未出现在任何被跟踪文件里；`models.yaml` 仍被 `.gitignore:21` 忽略、仍未被跟踪（两项回归测试持续把关）。

**被拒绝或纠偏的内容**

- 未给 `experiment.yaml` 的 `model` 段做"存在即读、缺失即忽略"的兼容：那会让两条配置路径长期并存，正是本轮要消除的问题。宁可报错。
- 未把 `raglab models` 改成发真实请求探测：连通性是人工一次性确认（探针在 `%TEMP%`），CLI 保持离线、不触网。
- 未把 `env.json` 只记录 `usable` 的候选：不可用的候选带着 `block_reason` 一起落盘，才能解释"为什么这次只跑了 A/C′ 没跑 B"。
- 按用户指示**未开始实验**：没有实现 A/B/C′/D，没有跑批，`STATUS.md` 仍是 `BLOCKED`。

**翻车与返工**

- 改 `ExperimentConfig.from_yaml` 时把 `model=model` 落在了 `return cls(...)` 里，被 11 项测试同时抓出 `NameError`；删除该行后全绿。属于机械改动漏改，不是设计问题。
- 首轮跑 `pytest` 与 `raglab` 时用了 `PYTHONPATH=src ...` 的行内赋值，被 worktree 隔离策略判为"无法确认不是 git 操作"而拒绝执行；改为在实验目录内直接调用 `.venv/Scripts/python.exe`（`pyproject.toml` 已配 `pythonpath = ["src"]`）。

## 2026-10-20 · 端点探针固化为 scripts/

**用户关键原话**：`整理`（承接上一轮"探针在 `%TEMP%`，不在版本库，要复跑得重写"的提示）。

**判断**：探针要留下，但**不能进 `src/raglab/`**。`raglab` 的 `index`/`run` 只该关心"候选能不能跑"，把端点探测与退避重试塞进去，等于让产品路径替实验决策。放在 `scripts/`：可复现、可被 review、不污染跑批链路。

**关键产出**

- `scripts/probe_endpoints.py`：合并此前 9 个一次性脚本（models / capabilities / budget / pacing×2 / rate / auth / multiturn / throughput）为一份带参数的探针。
  - 检查项：`llm.auth`、`llm.connect`、`llm.tool_calling`、`llm.multiturn`、`embedding.auth`、`embedding.connect`（含维度与归一化判定）、`embedding.batch`。
  - 可选：`--determinism`（3 次重复）、`--rate`（串行间隔探测）、`--embedding-batch N`。
  - 输出：人类可读的 PASS/WARN/FAIL 列表，或 `--json`。
- **复用产品代码而非另写一份**：全部经 `raglab.config.load_models` 与 `raglab.llm.OpenAIClient`，`require_live()` 门禁照旧——探针不能成为绕过门禁的后门。
- **默认间隔 15s**，按实测限流设定。调小会自己撞 429，把限流误读成故障，正是上一轮踩过的坑。
- 失败语义：任一检查 `fail` → 退出码 1；`warn` 不阻断（例如端点不校验密钥，是事实记录不是崩溃）；未设 `RAGLAB_LIVE` → 退出码 2；无可用候选 → 退出码 2。
- `tests/test_probe_script.py`（5 项，**全离线**）：脚本存在、门禁拦截、无候选拒绝运行、失败路径报 fail 且不泄露密钥（注入假客户端，不发真实连接）、默认间隔 ≥ 15s。
- 文档同步：`docs/runbook.md` 新增"端点连通性探针"一节、`README.md` 目录加 `scripts/`、`STATUS.md` 的 M4 实测记录改为"可用此脚本复现"。

**实测（脚本本身跑通，非推断）**

```
[PASS] llm.auth           不带密钥返回 401
[PASS] llm.connect        回复 'pong'，耗时 7.3s
[PASS] llm.tool_calling   finish_reason='tool_calls'，调用 ['kb_lookup']
[PASS] llm.multiturn      finish_reason='stop'，最终答案 980 字
[PASS] embedding.auth     不带密钥返回 401
[PASS] embedding.connect  1024 维，L2 范数 1.0000
[PASS] embedding.batch    2 条一次通过，耗时 2.38s

不可用候选（未探测）：
  - local-flash（llm）：缺少 model
  - local-bge-m3（embedding）：缺少可选依赖组 local-embed
```

与上一轮临时脚本的结论一致，说明合并没有改变判定口径。

**被拒绝或纠偏的内容**

- **没把探针做成 `raglab probe` 子命令**：那会让"发真实请求"成为产品 CLI 的一部分，且 `--help` 一列就会诱导人拿它当就绪检查。人工工具就该在 `scripts/`。
- **没把探针加入 `npm test` / 默认 pytest 路径**：它触网。新增的 5 项测试只测脚本的**边界行为**（门禁、退出码、不泄密钥、默认间隔），不发请求。
- 没为了让测试快就删掉默认 15s 间隔：改为在测试里显式传 `--spacing 0`，真实默认值保持按实测限流设定，并加一项测试锁住这个默认值。

**翻车与返工**

- 第一版脚本用了制表符缩进，与仓库 4 空格风格不一致，整体重写。
- 第一版测试用「不可达端口 + 2s 超时」制造失败路径，虽然能过但要真连一次网络、还白等约 40s；改为 `monkeypatch` 注入假客户端后降到 0.6s，且符合"单测离线"要求。
- 候选前缀逻辑最初写在循环内部反复遍历 `report.rows`，多候选时会重复加前缀；改为 `Report.prefix_since(start, id)` 只处理本次新增的行。

**测试**：164 → **169 passed**（新增 5 项脚本守卫）。

## 2026-10-20 · 删除两个不可运行的本地候选

**用户关键原话**：`- id: local-flash ... - id: local-bge-m3 ... 用不到就删了`。

**判断**：这两条候选在上一轮实测中都是 `usable: false`——`local-flash` 缺 `model`，`local-bge-m3` 依赖未安装的 `sentence-transformers`。留着只会让 `raglab models` 与 `env.json` 每次都输出两条必然不可用的记录，掩盖真正的候选状态。按"用不到就删"移除 YAML 条目。

**关键产出**

- `config/models.yaml`（本地，已 gitignore）：删掉 `local-flash` 与 `local-bge-m3`，只留 `remote-llm-1` + `api-embed-1`。
- `config/models.example.yaml`：同步删除，并在头部注明删除原因与日期。
- `tests/test_models_config.py`：模板候选数断言 2 → 1。
- `docs/runbook.md`：`local` 分支说明改为"当前没有本地候选"。
- **`PREREGISTRATION.md`：补记后果。** spec §6.3 方案 A 的网格是 `embedder ∈ {本地候选 1, API 候选 1}`，删掉本地候选后该档只剩一个值。**验收时不得声称做过 embedder 选择**；若以后补回本地 embedder，那是预注册网格的修订，必须在冻结记录里标注。
- `docs/fairness-protocol.md` T4：状态改为"两处候选各仅一个，当前无候选可选，须声明未做模型选择"。

**刻意保留的东西（没有跟着删）**

- **`kind: local` 的代码能力**（`OPTIONAL_GROUP_MODULES` / `_optional_available` / `usable` 的 local 分支）与 `pyproject.toml` 的 `local-embed` 可选组：spec §6.3 的 embedder 网格保留了"本地候选"这一档，删掉代码会让该档无法恢复，未来补候选时还得重写一遍判定逻辑。**删的是数据，不是能力。**
- 对应测试 `test_local_candidate_without_optional_dep_is_unusable` / `test_unknown_optional_group_is_unusable` 保留，它们验证的是判定逻辑而非某个具体候选。

**被拒绝或纠偏的内容**

- 一度顺手把 `OPTIONAL_GROUP_MODULES`、`_optional_available` 及 `import importlib.util` 一并删掉，并打算加 `KNOWN_KINDS` 白名单。**这是过度改动**：用户要求删的是两条跑不起来的候选数据，不是删掉"本地 embedding"这条能力线。已回退到原状，只在注释里说明"当前没有本地候选在用"。

**翻车与返工**

- 上述过度改动在写完后自查发现：`git diff` 显示 `config.py` 被删到只剩注释，而 spec §6.3 仍需该档。回退时逐条恢复 `importlib` 导入、`OPTIONAL_GROUP_MODULES` 与 `_optional_available`，并保留注释说明。

**测试**：169 passed（数量不变；只有模板候选数断言的值从 2 改为 1）。

## 2026-10-20 · M3 到位：kb-mcp 源码已读，基线复现一致，但量出三处口径分歧

**用户关键原话**：`当前kb_mcp开发完毕，材料可补齐`。

**判断**：M3 是 STATUS 上最后一个素材类阻塞项，用户说开发完毕，那就不该再等"用户提供算法说明"——源码就在主仓库 `mcp-servers/kb/`，直接读、直接复现基线，比要一份说明再转译更可靠。**读源码还能发现说明书里不会写的东西**，本轮最有价值的产出正是这类发现。

**来源与版本**

- 主仓库 `mcp-servers/kb/`，分支 `feat/m2-stage3`，tip `c529dcd`。
- `c529dcd` 相比上一版只加了 `kb_propose` 与 `status().inboxPending`，`lookup` / `search` / `read` 逐行未变（用 `git show` 取两个版本做 diff 核对过）。所以检索语义取哪个版本都一样。
- 本实验 `corpus/kb/`、`data/queries.jsonl`、`data/negatives.jsonl` 与 `mcp-servers/kb/` 下同名文件的 SHA-256 **逐一致**（`index.yaml` = `1ff21cc130…`、`manifest.sha256` = `baeb6e33…`）。语料没有分叉。

**基线复现**：用 kb-mcp 的构建产物在本实验查询集上重跑，逐项对上它自报的数字——index 轨 Recall@2 0.4400 / Hit@1 0.3800 / MRR 0.4100，search 轨 Hit@1 0.1333 / goldInTop20 0.4333，负样本 lookup 拒答率 0.8400。**说明两边是同一份世界，后续分歧只能来自口径而非数据。**

**量出来的三处口径分歧（按影响排序）**

1. **dispatch 读法，跨度 13.75pp。** spec §8.4 的散文是「`kb_lookup` 存在关键词得分 > 0 的条目则取 top-2」，但 `lookup()` 实际还有四道闸门：置信度阈值 `score >= 1.75`、技术 token 覆盖度须 > 50%、中文覆盖度（≥ 4 字或 ≥ 2 个 keyword）、未登录 token 折减。三种读法 Recall@2：(a) 按 `found` 回退 = **0.4500**、(b) 按「得分 > 0」回退 = **0.5375**、(c) 永不回退 = **0.4000**。跨度 13.75pp，远超 5pp 判定门槛——**这条不钉死，C 的成绩怎么说都有理**。
   顺带记一个容易漏的点：`kb_lookup` 的工具描述只要求"证据不足时如实告知"，**并没有要求 agent 改调 `kb_search`**。所以 (a) 依赖一个"agent 见 `found=false` 就换工具"的行为假设，该假设本身得进预注册。
2. **导航文件清单写的是文件名，T11 实际漏过滤 4 条。** `experiment.yaml` 写 `_vendor-index.md` / `_about.md`，语料里的真实路径是 `vendor/_vendor-index.md` / `cases/_about.md`；`filter_navigation` 做精确匹配，所以这两类从来没被过滤过。实测 `vendor/_vendor-index.md` 出现在 idx-040 / idx-044 / idx-047 的 top-2 与 srch-017 的前 5 里。已改成真实相对路径，改后泄漏 0 条。**关键对照：修正前后 Recall@2 都是 0.4500**——这个缺陷只污染候选列表，不影响主指标，值不值得修不靠指标说话，靠"T11 是不是真的生效"说话。
3. **`index_grep.yaml` 的 token 模式顺序会把 `0x271` 切成 `x271`。** 配置里两条正则以 YAML 列表形式列出且标识符在前；若按"逐条扫描再合并"实现，`0x271` 会先被标识符模式吃掉 `0`，剩下 `x271`。80 条查询里 3 条（srch-001 / srch-003 / srch-006）会走偏。kb-mcp 用的是单条交替 `0x…|[A-Za-z_]…`，十六进制在前。已改配置并加注释：必须单条交替。

**顺带量出的第四条**：**部署形态下的负样本拒答率是 0.08，不是 0.84。** 0.84 是只调 `lookup` 的数字；按 dispatch 回退到 `kb_search` 后，25 条负样本里 23 条拿到候选（`_sources.md` 恒居首）。这不算 kb-mcp 的缺陷——它的回归脚本本来就只测 lookup——但方案 C 的 H7 若照抄 0.84 会严重高估。已写进 `PREREGISTRATION.md` §7。

**被拒绝或纠偏的内容**

- 一度想把三种 dispatch 读法都实现出来跑一遍对比。**否掉**：跑对比是分析阶段的事，现在需要的是"把选择权交回预注册"，不是"用数据替实验负责人选一个"。三种读法的数字只作为**决策依据**记录，选定值必须由人在冻结时写进预注册。
- 没有直接把 `dispatch_rule: deployed` 当成已选定的值。配置里的 `deployed` 只是待确认的默认值，`PREREGISTRATION.md` §6bis 明确写了"不构成选择记录"。**默认值不能冒充选择。**

**更正了 M1 的一条错记**

原 STATUS 写「46 个文件 frontmatter 无法被 YAML 解析，仅 20 个可解析」。M3 到位后用 `parseFrontmatter` 和 `yaml.safe_load` 各跑一遍：**66 个文件有 frontmatter，66/66 全部解析成功，0 失败**，另有 42 个文件没有 frontmatter。原数字的成因是把整个 `.md` 文件喂给 `yaml.safe_load`——正文里的 `---` 分隔线会让它报 `expected a single document in the stream`，与 frontmatter 是否合法无关。另外原记录的「`description` 值含未加引号的冒号」也不成立：含「触发词: …」的 `description` 都已被单引号包裹，未加引号且含"冒号+空白"的字段实测 0 处。schema 种类也从三种更正为五种。

**为什么必须更正而不是留着**：这条错记会让人以为语料质量有问题、进而想去"修"语料。实际语料是干净的，错的是读取方式。

**关键产出**

- `STATUS.md`：新增「M3 实收记录」与「M3 实测出的口径分歧」两节；M3 阻塞项标为已取得；更正 M1 的 frontmatter 记录；状态变更记录补一行。
- `PREREGISTRATION.md`：§6 导航文件改真实路径并记下 T11 实测；新增 §6bis dispatch 读法三选一（含三组数字与行为假设）；§7 补负样本口径。
- `config/experiment.yaml`：`navigation_files` 改为真实相对路径。
- `config/schemes/index_grep.yaml`：`token_patterns` 列表改为单条交替 `token_pattern`，补 `dispatch_rule` / `token_min_length` / `search_limit`，并把三处非显然语义写进注释。
- `docs/fairness-protocol.md`：T11 标为已修正并记录影响；T12 补 token 顺序风险；新增「待钉死的口径」小节。
- `docs/runbook.md`：新增「复核 M3」一节（复现命令 + 三处非显然语义表）。
- `tests/test_config.py`：新增两项守卫——导航清单必须能在语料里找到对应文件（含两处嵌套路径）、C 的 token 模式必须保住 `0x271`。

**测试**：171 passed（169 → 171，新增两项守卫）。

**又一处措辞纠正**

原 STATUS 与 `intake.py` 的 warning 都写「11/80 条 gold 不在 index.yaml 中，方案 C **结构性无法命中**」。实测这 11 条里有 1 条（srch-011）经 `kb_search` 分支排到 rank 0、Recall@2 命中，该层分层召回率是 0.0909 而不是 0。**「结构性」这个词把 lookup 分支的限制说成了整个方案的限制**，已改两处：

- `intake.py` 的 warning 改为「方案 C 的 lookup 分支结构性无法命中」，并在注释里写明为什么不能写成 C 整体。
- `STATUS.md` 两处同步，补上 1/11 这一实测数。

**为什么值得单独记一笔**：这条错记会让人把整个 gold-未索引层当成必 miss，进而在分层报告里少算一个命中；更糟的是它会让人误以为「C 不能搜未索引文件」——实际上 `kb_search` 是遍历全部 `.md` 的，未索引文件完全可以被搜到。

**仍未解决**

- **dispatch 读法必须由人选定**，这是冻结的前置条件，agent 不得代选。
- 方案 C 的实现尚未落地；M3 到位只解除了"语义不明"这一层阻塞。
- `README.md` 的素材表与开场段落已同步，但「骨架状态」一节仍写着方案全部为占位——**这个仍属实，不动**。

## 2026-10-20 · 方案 C 实现：kb-mcp 逐行移植 + dispatch 三种读法

**用户关键原话**：`推荐一下；考虑到时间问题，所有方案不易运行太久` → 我给了三条预注册修订建议 → `确认`。

**判断**：用户确认的是**修订内容**，不是"开始跑正式实验"。所以这一轮做的是"把 C 实现出来"，跑批只到 smoke（秒级、随后清理），正式跑批仍等冻结。

**做法：移植，不重写**

新建 `src/raglab/schemes/kb_mcp.py`，逐行对齐主仓库 `mcp-servers/kb/service.ts` + `yaml.ts`。两处刻意与项目其它部分不同：

1. **不用 PyYAML 解析 `index.yaml`**，移植 `yaml.ts` 的最小子集。原因不是洁癖：PyYAML 会在 ` #` 处把值当注释截断，实测有 2 个条目的 `summary` 因此不同（`bic/and #1 …`、`#pragma …`）。而 `summary` 参与技术 token 覆盖度计算——用 PyYAML 就不是忠实复现。
2. **search 不做最小长度过滤**。`lookup` 的 `extractQueryTokens` 会丢长度 < 2 的 token，`search` 不会，`i.MX` 里的 `i` 真的会成为搜索词。照实复现，不"顺手修好"。

**保真度核验（一次性人工，不进单测）**

用 kb-mcp 的构建产物跑 105 条（80 正 + 25 负），导出 lookup / tokens / search 三项结果，再让 Python 移植版逐条比对：**lookup 0 差异、tokens 0 差异、search 0 差异**。

不进单测的理由：那需要主仓库的 `dist-mcp` 构建产物，会让 `pytest` 依赖 Node 环境，违反"单测离线"。

**端到端复核：三种 dispatch 读法全部对上**

在真实语料上跑 `raglab run`，三个数字与之前用 Node 侧量出的完全一致：

| 读法 | 之前（Node） | 现在（移植版） |
|---|---|---|
| deployed | 0.4500 | 0.4500 |
| lexical | 0.5375 | 0.5375 |
| lookup_only | 0.4000 | 0.4000 |

**返工：lexical 读法一开始算错了**

第一版把 lexical 实现成"用 `lookup()` 但跳过 `found` 判断"，结果得 0.4125，比预期低 12.5pp。

原因：`lookup()` 内部还有 OOV 折减 `max(0, 1 - 0.75 × OOV 比例)`。即使不看置信度阈值，折减本身也会把分数压到 0 附近，导致"得分 > 0"这个判据也被影响。而 spec §8.4 的散文写的是"按 index.yaml 关键词命中打分"，**根本没提折减**。

修正：新增 `KbMcpService.lexical_rank()`，按纯关键词得分排序取 top-k，不施加任何折减与闸门。改后 0.5375，对上。

**这个返工本身是有信息量的**：它说明"三种读法"的差异不只是阈值，还包括折减——所以冻结时必须明确写"lexical 读法不含 OOV 折减"，否则同一个名字能对应至少两种实现。

**实现清单**

- `schemes/kb_mcp.py`：`parse_index_yaml`（yaml.ts 子集）、`score_entry`、`matches_token`、`extract_query_tokens`、`extract_tech_tokens`、覆盖度/中文/折减四道闸门、`KbMcpService.lookup/search/lexical_rank`。
- `schemes/index_grep.py`：`SchemeC`，三种 `dispatch_rule`，T12 的 `extended_paths` 记录。
- `schemes/base.py`：`SchemeC` 从占位类移除，注册表改为延迟导入避免循环依赖；`get_scheme` 支持透传参数。
- `__main__.py`：新增 `cmd_run`（`--run-id/--scheme/--partition/--deadline-ms/--confirmatory`），`index` 仍退出码 3。
- `config.py`：新增 `SCHEME_FILES` 映射，避免"找不到参数文件就静默用默认值"。

**测试**：198 passed（171 → 198，新增 27 项）。新增 `tests/test_scheme_c.py` 覆盖：yaml.ts 语义（含 ` #` 保留）、四道闸门、search 不排除 `_sources.md`、单字符 token 保留、三种 dispatch 可分辨、T11 出口过滤、T12 extended 记录。

**已清理**：smoke 跑批产生的 `results/` 目录已删除，工作区无运行产物残留。

**仍未解决**

- **dispatch 读法仍待你选定**。配置里 `deployed` 是默认值，预注册 §6bis 明写它不构成选择记录。
- A/B/C′/D 仍是占位。按上一轮商定的顺序，下一步是 C′ + 索引侧（全离线，不占限流预算）。

## 2026-10-20 · 钉死两项口径：dispatch 主口径 = deployed，B 预算按限流修订

**用户关键原话**：`1. 你推荐` `2. 落进去`。

**判断**：第 1 项用户要我给推荐，第 2 项是明确授权把修订落进预注册。所以我既做决定也写下来，并在文档里把**理由**写清楚——预注册里只写"选了 deployed"是不够的，冻结后没人能重建"为什么"。

**决定一：dispatch 主口径 = `deployed`**

推荐理由不是它数字最好（0.4500 排第二，`lexical` 的 0.5375 更高）。理由只有一条：**它就是真实部署的那个系统**。`lexical` 要跳过 kb-mcp 实际存在的四道闸门、`lookup_only` 要删掉回退逻辑，两者都不是"现状基线"而是构想出来的变体。方案 C 在这一整个实验里的角色是回答"现在的 kb-mcp 有多好"——改写它就不再回答这个问题。

**用"全报"化解 13.75pp 的歧义**：三种读法都是纯本地计算，全报的边际成本约等于 0。所以预注册里同时写死：报告必须给三种读法的对照表；**若结论方向不一致，C 相关判定一律写"未决（口径敏感）"**，不得挑一个作定论。这样既不用在数据出来前替读者做选择，也堵死了事后挑好看读法的路。

**决定二：B 的预算修订落进 §4 / §4bis / §4ter**

`repeat: 3` → `1`；轮数网格 `{6,12,20}` → `{6,12}` 且只在 10 条子样本上选；波动用独立的 10 条 × 3 次稳定性跑测量。三项合计从 10+ 小时压到约 3–4 小时。

**这里发现了一个必须纠正的细节**：最初写的子样本抽取方式是"dev 分区内按 `id` 字典序取前 10 条"。实测一看，**这 10 条全部是 index 轨**（`idx-001`…`idx-013`），一条 search 轨都没有。

后果不是"不够随机"这么轻——B 的 `grep` 工具恰恰在精确 token 查询上最有价值。如果只用自然语言查询调轮数，**grep 的优势在选轮数这一步就完全不可见**，选出来的轮数会系统性偏低，最后 B 在 search 轨上的表现会被一个为 index 轨优化的预算拖累。这不是随机性问题，是**系统性偏向**。

改成按 track 分层：index 6 条（`idx-001/002/003/004/006/007`）+ search 4 条（`srch-001/002/003/004`），比例 34:21 ≈ 6:4。规则固定、无随机性，清单直接写进预注册。

**顺带修正了一处预注册与现实的脱离**

§2 的"主分析样本"还写着"全量 274 条"——那是原回归集，早已确认拿不到、换成自建 80 条了。这条一直没改，冻结时会把一个不存在的样本量写进哈希。已改为 80 条并注明这是对 spec §7.4 的修订、须披露功效下降。

**关键产出**

- `PREREGISTRATION.md`：§2 样本量 274→80（含修订说明）；§4 网格表同步；新增 §4bis（B 预算修订，含代价与披露义务）与 §4ter（10 条分层子样本清单 + "为什么不取前 10 条"）；§6bis 从"待选定"改为"**已选定：`deployed`**"，补理由、全报要求、口径敏感时的判定规则、两个连带披露。
- `config/schemes/agentic.yaml`：`max_tool_rounds: [6,12]`、`repeat: 1`、新增 `stability_*` 两项，注释写明原值为何不可行。
- `config/schemes/index_grep.yaml`：注明主口径已选定，三种读法都要报。
- `docs/fairness-protocol.md`：「待钉死的口径」改为「已钉死的口径」，新增「方案 B 的预算修订（公平性影响）」一节。
- `STATUS.md`：状态行同步。

**新增守卫（2 项）**：`test_agentic_budget_matches_preregistration` 断言 B 的网格是 `{6,12}`、`repeat` 是 1（改回原值会让 B 跑不完）；`test_scheme_c_dispatch_rule_is_preregistered` 断言配置与预注册文本一致，防止配置悄悄漂移。

**测试**：200 passed（198 → 200）。

**仍未解决**

- 预注册仍未冻结（无哈希）。冻结还需要：`config/resolved/*.json` 齐备——这要等 A/B/C′ 的实现与 dev 调参完成。
- A/B/C′/D 仍是占位。下一步按商定顺序：C′ + 索引侧（全离线，不占限流预算）。

## 2026-10-20 · 单方案诊断报告与图表（C）

**用户关键原话**：`C的报告文档和图表在哪里` → 我说明都不存在 → `我有点乱，你重新帮我理一下，说的通俗一点` → 重新解释后用户确认「不算，可以出图」。

**这件事暴露的问题**：上一轮我跑完 C 就删了 `results/`，用户据此以为报告和图已经有了。**只报告"跑通了"而不说明"产物已清理"，等于让人以为东西在那儿。** 以后跑完必须明确说产物在哪、是否保留。

**口径确认**：`STATUS.md` 的「禁止产出结果图表」，经用户确认**不包括单方案诊断图**。禁令防的是"只有 C 就画对比图，让人误以为做了方案比较"。这个确认写进了设计——所有对比类图表在当前 `schemes_available=1` 时**硬编码跳过**，不是靠自觉。

**新增命令 `raglab diagnose`**

产物在 `results/diagnostic/<run_id>/`：三种读法各一份逐条 JSONL、`diagnostic.json` 汇总、4 张 PNG、`report.md`。

设计上的三条硬约束（都有测试守着）：

1. **单方案不画对比图**：`fig1`/`fig4`/`fig8` 在 `schemes_available < 2` 时跳过，原因写进 manifest，不产出空图——空图会被读成"无差异"。
2. **跳过的图必须有原因**：`test_every_skipped_chart_has_a_reason` 逐条断言。
3. **报告开头就声明边界**：`test_report_declares_not_a_conclusion_upfront` 只检查前 6 行——避免把免责声明塞到文末。

**一个真实的测量偏差，已修**

第一次跑出来 `deployed` 的 P95 是 82 ms，但之前 smoke 实测是 346 ms。查下来是**执行顺序污染**：`index.yaml` 解析约 300 ms，只在进程内第一次付；三种读法依次跑，第一个独自承担这笔成本。

修正：`SchemeC.warm_up()` 显式预加载索引，`run` 和 `diagnose` 都在计时前调用。修正后三种读法的 P95 是 82 / 7 / 7 ms——`deployed` 仍略高，这次是真实差异（它要回退去 grep 全部 108 个文件），不是污染。

**报告内容（数字来自真实跑批）**

| 读法 | Recall@2 | Hit@1 | MRR | P50 | P95 |
|---|---|---|---|---|---|
| `deployed`（主口径） | 0.4500 | 0.3500 | 0.4000 | 1.6 ms | 82.7 ms |
| `lexical` | 0.5375 | 0.3375 | 0.4375 | 4.4 ms | 6.5 ms |
| `lookup_only` | 0.4000 | 0.3250 | 0.3625 | 5.8 ms | 7.2 ms |

**负样本按读法分开报**（这是本轮最有价值的一张表）：`lookup_only` 拒答率 0.84，`deployed`/`lexical` 都是 0.08——因为一旦回退到 `kb_search`，`_sources.md` 会命中几乎所有负样本且恒排第一。kb-mcp 自报的 0.84 只是 lookup 的数字，直接引用会严重高估部署形态的拒答能力。

**被拒绝或纠偏的内容**

- 第一版报告表 2 有一列空表头（主口径标记列没写列名），Markdown 渲染出无法解释的一列。已补为「主口径」，并加了 `test_report_has_no_empty_table_header`——但该测试初版写得太严（连数据行的空单元格也判错），已收窄为只查表头行（表头 = 分隔线的上一行）。
- 一度想用 `probe_scheme._service.load_index()` 预热，但那是**另一个实例**，起不到预热作用。改为在 `SchemeC` 上加 `warm_up()` 方法。

**关键产出**

- 新增 `src/raglab/report/charts.py`（4 张图 + 跳过原因）、`report/diagnostic.py`（三读法 + 负样本）、`report/diagnostic_md.py`（Markdown 报告）。
- `__main__.py` 新增 `cmd_diagnose`；`run` 与 `diagnose` 都在计时前 `warm_up()`。
- `schemes/index_grep.py` 新增 `warm_up()`。
- 新增 `tests/test_report.py`（13 项）。
- `docs/runbook.md` 与 `README.md` 同步（README 三处过期：171→213 项测试、方案占位状态、命令清单）。

**测试**：213 passed（200 → 213）。

**当前产物位置**

`experiments/rag-vs-agentic-search/results/diagnostic/c-diag/`（`report.md` + `figures/` 4 张 + 3 份 JSONL + `diagnostic.json`）。

**仍未解决**

- ~~`results/diagnostic/` 未被忽略~~ **已定（用户：`按你建议的来`）**：`.gitignore` 新增 `results/diagnostic/**/*.jsonl`，逐条记录不入库；`report.md`、`diagnostic.json`、`figures/*.png` 入库。`git add -n` 已确认只会加这 6 个文件。
- A/B/C′/D 仍是占位。

## 2026-10-20 · 实现 C′ + 缓解「评测集来源偏差」威胁

**用户关键原话**：`继续` → 实现 C′ → 我提出**先做威胁缓解**还是先做 A，用户选 `b`（先缓解）。

**判断**：C′ 比 C 高 38pp，这个数字太漂亮。在任何后续方案跑出来之前，如果不把
"这个差距有多少是真的"讲清楚，后面所有讨论都会建立在一个可疑的数字上。**先证伪再看别的**。

### C′ 的实现（顺带完成）

`retrieval/` 三个纯模块 + `schemes/bm25_grep.py`，全自实现无第三方。

**一处刻意的算法选择**：BM25 用 `ln(1 + …)` 形式的 IDF，不用经典 Robertson-Sparck Jones。
后者对出现在过半文档里的词会给**负 IDF**——即"常见词命中反而扣分"。108 个文件的小语料
上极易触发。这个选择会改变长文档排序，写进了代码注释与测试。

**grep 复核的边界**：只对 top-20 chunk 里实际出现的精确 token 加 `+0.05`，
**不改变 top-5 之外的块进入候选的资格**。有测试守着（`test_grep_review_does_not_promote_beyond_top_k`）。

### 威胁缓解：做了什么、发现了什么

**先说结论：威胁是真的，但只解释一部分。**

**做法**：新增 `raglab sensitivity`，按「查询 token 在语料词表中的覆盖率」把 70 条
index 轨查询分三层，比较 C 与 C′ 的 Recall@2 差距。

| 覆盖率层 | n | 区间 | C | C′ | 差距 |
|---|---|---|---|---|---|
| 低 | 23 | 0.50–0.88 | 0.391 | 0.565 | **+17.4pp** |
| 中 | 23 | 0.89–1.00 | 0.478 | 0.826 | +34.8pp |
| 高 | 24 | 1.00 | 0.292 | 0.625 | +33.3pp |

相关系数 **+0.121**。

**这三行说明三件事**：

1. 差距随覆盖率下降而收缩（34.8 → 17.4），机制存在，威胁不是空想；
2. 但最低层上 C′ 仍胜 17.4pp（13/23 vs 9/23），**威胁解释不了全部**；
3. 相关系数只有 0.121，说明覆盖率不是主因——它和查询长度、术语密度也纠缠在一起。

**我没有写"威胁解释了 50%"这种话**。分层是描述性的，相关系数低说明因果链条比
"覆盖率越高 C′ 越强"复杂得多，不能反推成一个百分比。

### 翻车：我做的"盲写"不算盲写

原本打算做 (b) 的第一项是"盲写一批查询"。我写了 20 条，然后**自己量了一下：
词表覆盖率只从 0.955 降到 0.918（−3.7pp）**。

原因很直接：**我读过这套语料**。我刻意换措辞也只能换掉表面，换不掉底层术语选择——
因为我知道那些文件里写的是什么。这不是一轮"独立来源"的评测集。

**处理方式**：这 20 条仍保留为 `data/queries_blind.jsonl`（它们让所有方案的分数都下降了，
C 从 0.44 掉到 0.25，本身有价值），但**在 STATUS 里明确标注「同人换措辞，非独立盲写」**，
不计入"已做盲写"。

**这是这轮最该记住的一条**：一个缓解手段只要执行者共享了威胁本身的成因，就缓解不了它。
真正要做，得找一个没读过语料的人来写查询。这一项仍未执行，已写进 STATUS 的未执行清单。

### 判定口径的变化

原来是「未执行缓解手段时，C′ vs C 一律标注未决」。现在改成：

- **方向可以报告**——三种覆盖率层上方向一致；
- **幅度不得报单一数字**——必须给分层区间（+17.4 至 +34.8pp）；
- 必须同时披露相关系数 0.121 与「盲写非独立」两个事实。

这是我能给的、分层数据支撑得住的最强结论。

### 关键产出

- `retrieval/chunking.py` / `tokenize.py` / `bm25.py`：切块、分词、BM25。
- `schemes/bm25_grep.py`：方案 C′。
- `report/sensitivity.py`：覆盖率分层敏感性分析（纯函数，可复跑）。
- `data/queries_blind.jsonl`：20 条同人换措辞查询（**非独立盲写**）。
- `__main__.py` 新增 `cmd_grid`（16 组网格全记录 + `--write-resolved`）与 `cmd_sensitivity`。
- `config/resolved/C_prime.json`：dev 最优配置。
- `results/tables/grid_search.{csv,md}`、`sensitivity_coverage.{csv,md}`。
- `STATUS.md`：C′ 首轮实测 + 威胁登记 + 缓解结果。

### 顺手修的两个真问题

1. **`run` 会把网格当标量用**：`bm25_grep.yaml` 里 `k1: [0.9, 1.5]` 被 `float()` 直接炸掉。
   已改为显式拒绝并指向 `raglab grid`——静默取第一个档位是最坏的结果。
2. **错误顺序错误**：A 会先报"参数是网格"而不是"尚未实现"，那句提示对占位方案是假的。
   已把实现状态判断提到参数校验之前，并加 `test_implemented_schemes_list_matches_registry`
   守住 `IMPLEMENTED_SCHEMES` 与方案注册表同步。

**测试**：271 passed（262 → 271）。新增 `test_retrieval.py`（29 项）、`test_scheme_c_prime.py`（13 项）、
`test_sensitivity.py`（10 项）。

**仍未解决**

- 真正的独立盲写查询（需要另一位标注者）。
- 预注册未冻结；A/B/D 未实现。
- `results/tables/` 未在 `.gitignore` 里被忽略——按诊断报告的既定口径，表格应入库，但需确认。

## 2026-10-20 · 实现方案 A（向量 RAG）与方案 B（Agentic search）

**用户关键原话**：`做A` → 完成后 `跑B`。

### 方案 A

`retrieval/vector_index.py` + `schemes/vector_rag.py` + `embedding.py`。

**三处刻意的设计**：

1. **构建时间与查询延迟分开记**（§8.2）。embedding 是离线批处理，混进单查询延迟会让
   A 看起来慢两个数量级。有测试断言 `latency_ms < 1000` 而 `build_seconds = 999`。
2. **索引必须显式传入**，不在构造函数里自动建。自动建会把"我只是想跑一下"变成
   一次几分钟的网络调用。
3. **缺索引即 `BlockedError`**，不回退成空候选——那会把配置问题伪装成"这个方案什么都找不到"。

**实测**：264 chunks / 3 次调用 / 33.6 秒建完，P50 查询延迟 106ms。

**网格**：`whole_file` 0.7818 > `section` 0.7636，选前者。

**一次真实的冒烟问题**：`grid --scheme A` 跑 `section` 那组时 `cache_hits=0`，
意味着它用 6 次新调用编码了 653 个 chunk，而我给了 `--spacing 5`（比实测建议的 15s 短）。
没报错，但这是**撞运气**不是可靠做法。已在 dev-notes 记录，跑批时长间隔必须留足。

### 方案 B

`tools.py`（glob/grep/read/submit）+ `schemes/agentic.py` + `chat_endpoint.py`，
并给 `llm.py` 补了 `tool_calls` 解析。

**必须解决的三件事**（都有测试守着）：

1. **必须 submit**。没提交 → `timeout` 按 ITT 计 miss。这一条是 B 与"让模型聊两句"
   的分界线。
2. **assistant 的 `tool_calls` 必须原样回灌**。少了这一步，模型会反复调同一个工具，
   烧完轮数还不给出答案。测试 `test_assistant_tool_calls_are_echoed_back` 断言这点。
3. **tool 结果按 `tool_call_id` 回灌**。测试 `test_tool_results_are_fed_back` 断言。

**一处刻意的宽容**：`tool_calls[].function.arguments` 的 JSON 解析失败**不抛错**，
而是当空参数交给工具层返回结构化错误，让模型下一轮自我纠正。抛异常会直接中断整轮循环，
把一个可恢复的错误变成一次失败。

**实测（idx-001，6 轮上限）**：

```
status   : ok
paths    : protocols/uart/no-output.md  ← gold 排第一
elapsed  : 80.4s
rounds   : 4
tools    : glob → grep → read → read → read → submit
tokens   : in=30930 out=724
```

模型的实际行为是合理的：先 glob 看结构，再 grep 找候选，然后读 3 个文件核对，最后 submit。
`reason` 字段也写得具体，不是套话。

**成本换算**：80 秒/查询 × 80 条 ≈ **1.8 小时**，与预注册 §4bis 估的 1.7–2.7 小时吻合。

### 关键产出

- `src/raglab/tools.py`：四个工具 + 路径安全 + 导航文件不暴露。
- `src/raglab/schemes/agentic.py`：B 的主循环（`AgentTrace` 记录完整轨迹）。
- `src/raglab/chat_endpoint.py`：LLM 端点 + 退避重试。
- `src/raglab/embedding.py`：embedding 端点 + 退避重试。
- `src/raglab/retrieval/vector_index.py`：向量索引、缓存、落盘。
- `src/raglab/schemes/vector_rag.py`：A。
- `src/raglab/llm.py`：新增 `ToolCall` / `tool_calls` / `finish_reason` / `reasoning` 解析。
- `config/resolved/A.json`：`whole_file`。
- `results/tables/grid_search_A.csv`。

### 测试

**327 passed**（301 → 327）。新增 `test_agentic.py` 26 项。修了几处因 A/B 不再是占位而失效的断言，
以及一个**会真的触网建索引**的测试——它读了真实仓库的 `config/resolved/A.json`，
已改为用临时项目隔离。

### 三方案当前对比（全量 80 条，探索性）

| 方案 | R@2 | R@5 | H@1 | MRR |
|---|---|---|---|---|
| A | 0.8000 | 0.9250 | 0.7250 | 0.7965 |
| C′ | 0.8000 | 0.8625 | 0.6250 | 0.7296 |
| C | 0.4500 | 0.4500 | 0.3500 | 0.4000 |

A 与 C′ 在 Recall@2 上打平，但方向相反：C′ 在 index 轨略胜（0.72 vs 0.70），
A 在 search 轨略胜（0.967 vs 0.933）。A 的 Hit@1 与 MRR 全面领先。

**这不构成结论**：样本 80 条、单标注者、评测集来源偏差未解决、预注册未冻结。

### 仍未解决

- B 的轮数网格正在跑（10 条子样本 × {6,12}，约 50 分钟）。
- B 的全量跑批（约 1.8 小时）未开始。
- D 仍是占位。
- 预注册未冻结。

## 2026-10-20 · 收尾：三块分析完成，B/D 本轮不跑全量

**用户关键原话**：`B不跑全量，D也不跑全量不行吗` → `补上` → `D方案直接舍弃掉，不做了`。

**判断**：用户的判断是对的，而且比我的原方案更诚实。理由写在 `docs/experiment-report.md` §7：
todo §6.2 的决策表里，「C′ 较 C 提升 ≥ 5pp」与「A 在自然语言轨领先 ≥ 10pp」两条
**只需要 A / C / C′ 的数据**；B 只出现在「B/C/C′ 均不劣于 A」那一条里，而那一条的
结论是「维持无 RAG」——本次实验的结论本来就是「维持无 RAG」。**花 1.8 小时跑 B，
换不来任何决策的改变。**

D 更是如此：H5 判据 2、3 已成立（判据 1 因 B 无全量数据标「数据不足」），
但 D1 的冒烟显示其种子召回等于 C′ 全量水平（0.80），增益空间有限，而 B 无基线。

**实现保留，只是不参与结论**。`config.py` 新增 `SKIPPED_THIS_ROUND = {"B", "D"}`，
报告会写明这两个方案本轮不跑——避免"结果目录里出现了 B"被误读成"B 参与了结论"。

### 三块分析（`raglab analyze --run-id main`，全部离线）

| 方案 | R@2 | R@5 | H@1 | MRR | P50 | P95 | 假候选率 | 正确拒答率 | AUROC |
|---|---|---|---|---|---|---|---|---|---|
| A | 0.8000 | 0.9250 | 0.7250 | 0.7965 | 105.9 ms | 136.2 ms | **0%** | **100%** | **1.00** |
| C′ | 0.8000 | 0.8625 | 0.6250 | 0.7296 | **0.6 ms** | **1.1 ms** | 100% | 92% | 0.67 |
| C | 0.4500 | 0.4500 | 0.3500 | 0.4000 | 1.7 ms | 86.9 ms | 92% | 92% | 0.76 |

显著性（预注册比较族 + Holm，bootstrap 按 track 分层 10,000 次）：
**C′ vs C = +35.0pp，p_adj = 4.9e−07，CI [+23.8, +46.2]pp，显著**；
A vs C′ = +0.0pp（6 条对 6 条翻转，CI 跨零，**不显著**）。

**A vs C′ 不显著**这条很重要：「向量召回优于 BM25」在本数据上没有得到支持。

### 一个在分析中查出的真问题（值得单独记）

首版 H7 出现自相矛盾：C′ 假候选率 100%，正确拒答率却只有 72%。

查下来是**阈值跨方案共用**：C 的 lookup 分是正数（BM25 分），C′ 的 search 分支用
**负名次**当分数（-1、-2…），量纲完全不同。拿 C 的阈值 16.8 去判 C′，负分数当然
"低于阈值" → 被判成正确拒答，可它同时又返回了候选。

修正：**阈值按方案各自在 dev 负样本上选**。修正后 C′ = 100% / 92%，不再矛盾。

**教训**：§7.7 说"阈值只在 dev 负样本上选"，没说"每个方案各选一个"。
跨方案共用阈值在多方案对比里是隐蔽的坑——量纲不同的方案共用一个数，
必然产生无法解释的结果。已写进 `report/h7.py` 注释与 `report/analysis.py`。

### 决策映射（todo §6.2）

- ✅ **成立**：C′ 较 C +35.0pp（远超 5pp）→ **C′ 成为默认检索实现，C 保留为兜底**。
- ❌ **不成立**：A 在自然语言轨领先最优稀疏 ≥ 10pp —— A 的 index 轨 0.70 **低于** C′ 的 0.72。
  **结论是「维持无 RAG，走 C′」，不是「引入向量召回层」。**
- ✅ **B 触发**：P95 ~75s/条 远超 3s → 只做夜批。A（136ms）与 C′（1ms）可进交互。
- ✅ **对 C′ 成立**：H7 假候选率 100% > 20% → 若用 C′ 必须补显式拒答通道
  （BM25 没有拒答机制，只按词频排序；neg-001 问 i.MX RT1170 MU 中断，
  它返回 `vendor/nxp/kinetis-imxrt.md`——型号相近但不是答案）。
- ⚠️ **无法判定**：B/C/C′ 均不劣于 A。缺 B 的全量数据。**不得写成"无差异"。**

### 关键产出

- `src/raglab/report/h7.py`：H7 拒答分析（阈值选择按方案各自进行）。
- `src/raglab/report/significance.py`：配对 McNemar + bootstrap + Holm，缺席的族内比较
  显式标 `skipped_reason` 且不缩小校正的族大小。
- `src/raglab/report/analysis.py`：三块汇总。
- `src/raglab/__main__.py`：新增 `analyze` 命令。
- `docs/experiment-report.md`：**完整报告**（含全部数字、决策映射、8 条必须披露的偏差、复现命令）。
- `STATUS.md`：状态从 BLOCKED 改为 PARTIAL，新增「本轮收尾」一节。
- `config.py`：新增 `SKIPPED_THIS_ROUND`。

**测试**：368 passed（354 → 368）。新增 `tests/test_analysis.py` 14 项。

### 一处需要说明的取舍

`analyze` 命令要跑负样本，而 A 的负样本需要 embedding——**这会把负样本文本发到外部 API**。
第一次跑时被权限分类器拦下（判定为数据外泄风险）。我先跑了纯本地的 C 与 C′，
确认逻辑无误后再由用户批准跑 A 的部分。这个拦截是对的：
负样本文本确实是本地资产外发，应当由人确认。

### 仍未解决

- 预注册未冻结（无哈希），`score --confirmatory` 拒绝；全部结果标 exploratory。
- 独立盲写查询、多 gold 标注两项未做。
- B 的全量未跑（用户决定）。
## 2026-10-21 · B 全量补跑完成：结论从「无法判定」变为「B 显著优于 A」

**用户关键原话**：`跑` → `咋样了` → `当前情况`。

**背景**：上一轮因缺 B 的全量数据，todo §6.2 决策表里「B/C/C′ 均不劣于 A → 维持无 RAG」
那条只能写「无法判定」。用户要求补跑 B 的全量（80 条）。

### 跑批前必须补的两处（不然两小时白跑）

1. **断点续跑**（`--resume`）。原实现是**跑完才写盘**——B 全量 1.8 小时，
   网关随时可能排队 9.7 小时（实测 `estimated_wait: 34910`），一次中断赔上两小时。
   改为**逐条落盘** + `--resume` 跳过已完成条目。用真实中断验证过：
   kill 掉进程后 3 条结果完整留在盘上，续跑正确跳过。
2. **查询间限流**（`--query-spacing 15`）。方案 B 自己的 `--spacing 15` 只管
   **一条查询内部**的轮次间隔，管不到**相邻查询之间**。不加这层，
   上一条的最后一个工具轮与下一条的第一个工具轮背靠背发出去——那是实测成功率 0% 的突发模式。

**顺带**：`run` 现在在目标文件已存在又不带 `--resume` 时**显式拒绝**（退出码 3）。
直接覆盖会让「这次跑批包含哪些查询」变得不可判定。

### 结果

| 方案 | R@2 | R@5 | H@1 | MRR | P50 | P95 | 失败率 |
|---|---|---|---|---|---|---|---|
| **B** | **0.9250** | **0.9500** | **0.8750** | **0.9073** | 65.0 s | 101.5 s | 2.5% |
| A | 0.8000 | 0.9250 | 0.7250 | 0.7965 | 105.9 ms | 136.2 ms | 0% |
| C′ | 0.8000 | 0.8625 | 0.6250 | 0.7296 | 0.6 ms | 1.1 ms | 0% |
| C | 0.4500 | 0.4500 | 0.3500 | 0.4000 | 1.7 ms | 86.9 ms | 15% |

B 的 78 ok / 2 timeout（`idx-006`、`idx-041`，都用满 6 轮未提交）。
token 成本：全量 149.2 万输入 + 5.0 万输出，**平均每条 1.86 万输入 token**。

### 结论变了

**A vs B 显著**：B 赢 12.5pp，McNemar 2/12，p_adj = 3.9e−02，CI [−21.2, −3.8]pp 不跨零。
「向量召回优于 agentic 检索」不成立，**反过来成立**。

决策表第一条「B/C/C′ 均不劣于 A → 维持无 RAG」：
B 两轨都不劣于 A（index +18.0pp / search +3.3pp），但 **C 明显劣于 A**（index −26.0pp、
search −50.0pp），C′ 的 search 轨 H@1 也劣于 A（0.7333 vs 0.9667）——
所以该条**字面不成立**，但其**意图**（不必引入向量层）由 B 单独达成。

**结论因此强化**：上一轮的理由是「A 未领先稀疏方案」，本轮有了更强的理由——
**agentic 检索显著优于向量检索**。若要在检索层加投入，方向是 agentic 而非向量。

### 三个在过程中查出的真 bug

1. **Holm 的族被悄悄缩小**。预注册比较族是 4 项，但缺席项（B vs A、D vs 最优）被直接剔除，
   Holm 的乘数从 4 掉到 2，校正后 p 值凭空小一半（C′ vs C 从 9.9e−07 变成 4.9e−07）。
   **族是预注册时定死的，缺数据不会让它变小**——让族变小等于让数据缺失的那一项「白赚」一个校正系数。
   已改为缺席项按 p = 1 计入族大小；`COMPARISON_FAMILY` 常量此前定义了却从未被使用，
   现改为单一事实源。

2. **B 的 H7 拒答率会被编造出来**。负样本跑批器对未知方案返回 `("no_match", [], 0)`，
   而 B 不在实现列表里——于是 B 被算成「假候选率 0%、正确拒答率 100%」，
   看起来像最强的拒答方案，实际只是**没人跑过 B 的负样本**。
   「没跑」和「跑出来满分」在报告里长得一模一样，读者分辨不出来。
   已改为：跑批器对未实现的方案显式抛 `BlockedError`，H7 整块标 `skipped`，不报数。
   能力判定改为**问跑批器本身**（探针调用），不再另抄一份方案名单——
   名单与实现不同步正是那个 bug 的成因。

3. **配对检验不检查配对**。McNemar 与配对 bootstrap 要求两方案在**同一批查询、同序**上比较，
   但 `analyze` 把各方案的命中列表独立传下去，不检查。跑批文件顺序不保证一致
   （B 可能是续跑出来的）。不检查就会算出「A 的第 3 条 vs B 的第 7 条」这种无意义比较，
   **而且算出来的 p 值看上去还挺正常**——不会报错，只会是错的。
   已加 `check_alignment`：query_id 集合不同或顺序不同都直接报错。

**另外修了一个可移植性 bug**：Windows 默认 GBK 编不了 `−`(U+2212)、`′`(U+2032)，
`raglab h5` **算完、结果也落盘了，却崩在最后一行 print**，退出码 1，看着像「分析失败」。
已在 CLI 入口强制 stdout/stderr 用 UTF-8（`errors="replace"`——宁可输出替代字符，
也不要在报告已经生成之后失败）。

### 一次事故：误用 git checkout 撤销了未提交的 STATUS.md

我想「先看看 STATUS.md 改前什么样」，用了 `git checkout STATUS.md`——
**它把 168 行未提交的改动一并撤销了**（`git checkout -- <file>` 是恢复文件到 HEAD，
不是恢复文件到「我改之前」）。

**教训**：想看改动前的状态，正确做法是 `git diff` 或 `git stash`，不是 `git checkout`。
已用 temp 目录里留着的脚本重建 STATUS.md（CRLF 原样，161 CRLF / 0 bare LF）。
其余文件未受影响（`git checkout` 只针对了那一个文件）。

**用户决定**：不提交（「先不提交」）。改为在 temp 目录留好重建脚本作为兜底。

### 关键产出

- `src/raglab/runner.py`：`append_result` / `read_completed_query_ids` / 查询间隔。
- `src/raglab/__main__.py`：`--resume` / `--query-spacing`、UTF-8 强制、H7 跳过逻辑。
- `src/raglab/report/significance.py`：Holm 族大小固定、`COMPARISON_FAMILY` 启用、`best_single` 解析。
- `src/raglab/report/analysis.py`：`check_alignment` 配对检查、H7 能力探测。
- `docs/experiment-report.md`：全文按 B 的结果重写（含 10 条披露偏差）。
- `PREREGISTRATION.md`：新增 §4quater「B 的全量补跑」与 4 条披露义务。
- `STATUS.md`：状态与决策映射同步。

**测试**：391 passed（368 → 391，新增 23 项）。

### 仍未解决

- **B 的 H7 无法评估**（无负样本跑批实现）——「KB 外查询会不会被瞎猜」未答。
- **B 的稳定性未量化**（预注册 §4bis 的 10 条 × 3 次未跑）。已观测到 `idx-006`
  在两次运行中一次成功一次超时。
- **B 的覆盖率分层敏感性未做**——「B 的优势是否部分来自评测集同源」这条威胁未排除，
  而 B 现在是结论里的最强方案，这条优先级最高。
- 独立盲写查询、多 gold 标注、预注册冻结三项仍未做。
### 补跑：B 的稳定性（预注册 §4bis 的 10 条 × 3 次）

预注册 §4bis 说「正文 `repeat: 1`，波动用独立的 10 条 × 3 次稳定性跑补偿」。
本轮**补跑了**。三次的来源省掉一次 45 分钟的重跑：

| 次次 | 来源 |
|---|---|
| 第 1 次 | 预注册 §4ter 的 rounds=6 网格档（逐条提交路径从日志还原） |
| 第 2 次 | 本次全量跑批（从 `results/runs/main/B.jsonl` 取这 10 条） |
| 第 3 次 | 本轮补跑 |

区间：R@2 **[90%, 100%]** · H@1 **[80%, 90%]** · 失败率 **[0%, 10%]**。

**最有信息量的不是区间，是逐条状态**：三次里有两条不一致，且**失败的不是同一条**——
`idx-006` 第 2 次超时、`idx-007` 第 3 次超时。两次都是 `max_rounds_exhausted`
（用满 6 轮未提交），不是网关错误、不是工具报错。

**这直接推出一个决策含义**：失败是「轮次预算敏感」的，加轮数能救回；
但 P95 会从 101.5 秒翻倍。所以「加轮数」不是改进，是「更稳 vs 只能夜批」的取舍。

### 更正：「该子样本偏易」是错的

上一轮我在报告偏差 6 里写「B 的子样本偏易（C′ 在同批 0.80，全量 index 轨 0.72，盲写集 0.55）」。
**这个说法经不起核对**——同一批 10 条上：

| 方案 | 同 10 条 | 全量 80 条 | 按全量轨配比重加权 |
|---|---|---|---|
| A | 0.6000 | 0.8000 | 0.8067 |
| B | 0.9000 | 0.9250 | 0.9280 |
| C | 0.1000 | 0.4500 | 0.4507 |
| C′ | 0.8000 | 0.8000 | 0.8053 |

子样本其实**略偏难**（A 0.60 vs 0.80）。差异来自**轨构成**：子样本是 index 6 / search 4，
全量是 index 50 / search 30；index 轨对 A 更难（0.70 vs 0.97）。
按全量轨配比重新加权后，各方案数字与全量几乎重合。

**根因**：上一轮那句「C′ 在同批 0.80，全量 index 轨 0.72」是**拿不同口径的数字在比**
（子样本整体 vs 全量的 index 子集），得出了「偏易」的错误结论。

**教训**：比较两个数之前先确认它们**同口径**。轨构成不同的时候，
必须先加权再比，否则差值里混着构成差异。

**结论没变的部分**：「子样本不能当独立验证样本」仍成立——但理由是
**它参与过轮数选择**，不是「偏易」。

### 新增：`results/analysis/main.md` 改为从 JSON 生成

上一轮留下的 `main.md` 是手写的，内容是「B 与 D 未做全量跑批」的旧结论，
还带着上面那条被证伪的「偏易」说法。**手写的可读版必然会漂移。**

已加 `src/raglab/report/analysis_md.py`（纯渲染，数字全来自 `main.json`），
`raglab analyze` 现在同时产出 JSON 与 MD。渲染器只做渲染、**不含任何结论文字**。
`tests/test_analysis_md.py` 7 项。

**测试**：403 passed（368 → 403，新增 35 项）。
## 2026-10-21 · 多 gold 标注：先接线（发现真缺口），再标注

**用户关键原话**：`多 gold 标注是` → `A`（选「先接线，再标注」）。

### 查出来的东西：这个缺口有两层

我原本以为「多 gold 未做」只是标注工作量问题。查下去发现是**两层**：

1. **标注数据没建**（工作量）
2. **代码没接线**（实现问题）——`annotation_multi_gold.jsonl` 只被 `intake.py` 读进来
   **数了个条数**（`counts["multi_gold"]`），而评分时 nDCG 用的是 `query.gold`
   （来自 `queries.jsonl` 的单 gold）。**两条路没接上。**

```
src/raglab/intake.py:263   multi_gold, multi_gold_report = load_multi_gold(data_root)   ← 读了，只计数
src/raglab/scoring.py:77   ndcg5=ndcg_at_k(status, paths, query.gold, 5)                 ← 用的是单 gold
```

**不修第 2 层，第 1 层做完也是白做**——标完 50 条，nDCG 一个数都不会变。

### 接线的设计：只影响 nDCG（spec §7.3 第 5 条）

spec §7.3 第 5 条明写「**主判定只用导入的原始 gold**」。这条给了接线一个
**可验证的验收标准**：

> **接线正确 = primary 指标一个数字都不变，只有 nDCG@5 变。**

为什么这样切是对的：多 gold 回答的是「回答这个问题**还需要**读哪些文件」。
用它改 Recall@2 会让「top-2 里放了 2 个正确答案」被误判成未命中——
**可 top-2 本来就只能放 2 个**。所以多 gold 只能影响 nDCG（IDCG 按 gold 数算）。

改动：
- `scoring.score_one` / `score_records` 加 `multi_gold` 参数；`ScoredQuery` 加
  `ndcg5_from_multi_gold` 标记（没给多 gold 时 nDCG **退化成单 gold 并标低置信**，不是不报）。
- `intake.multi_gold_map` 产出 `query_id -> gold` 映射，并查三件事：
  query_id 不在查询集内 / gold 路径不存在 / 同一 id 重复（**错误**）；
  覆盖不全只是**低置信**，不阻塞主实验（spec 说多 gold 是增强项）。
- `intake.check_multi_gold_coverage` 实现 G0 门禁。
- `cmd_score` 载入并传入；`summary.json` 增加 `ndcg_source` 段（用了多少条多 gold）。

**验收（实测）**：接线前后跑 `raglab score --run-id main`，对比 `overall.csv`：

| 方案 | Recall@2 / Hit@1 / MRR | nDCG@5 |
|---|---|---|
| A | **一字未变** ✅ | 0.8283 → 0.7736 |
| B | **一字未变** ✅ | 0.9182 → 0.8570 |
| C′ | **一字未变** ✅ | 0.7635 → 0.7070 |
| C | **一字未变** ✅ | 0.4131 → 0.3621 |

nDCG 全部下降（IDCG 变大，这是多 gold 的**预期效果**），但**排序不变**
（B > A > C′ > C）——**没有任何结论因此改变**。

### 标注

**判定标准写下来才可复核**：「回答这条查询时，人会实际打开它」，不是「主题相关」。

据此 **同协议的 `_overview.md`（速查表）不算**——它是查参数用的，不是查症状用的。
这一条挡掉了不少看起来合理的候选（比如 idx-003 的 `protocols/uart/_overview.md`）。

**依据**（按可核查性排序）：
1. 各文件 frontmatter 的 `protocols` / `symptoms` / `domain` / `description`；
2. `index.yaml` 的 `tags` 与 `summary`（语料作者自己写的「覆盖什么」）；
3. 正文交叉引用（语料里只有 5 个文件有显式交叉引用，覆盖有限）。

**候选生成**用了两个脚本（都在 temp 目录，未入库）：
`multigold_draft.py`（词面重叠）与 `multigold_candidates.py`（按 index.yaml 的 tags
共现 + summary 症状词命中）。后者更可靠——`index.yaml` 是结构化的「覆盖什么」声明。

结果：**50/50 条 index 查询覆盖，38 条为多 gold，平均 1.94 个 gold/条**，
12 条复核后确实只有 1 个相关文件。

### 标注过程中自己踩的一个坑

我写的校验脚本把「多 gold 文件里包含主 gold」当成**自引用错误**——报了一屏。
查 spec §7.5：「记录**全部**相关文件」，所以包含主 gold 是**对的**。

**教训**：校验脚本自己也会错。「看起来像 bug 的报告」要先查规范再改代码，
否则会把正确的实现改成错的。（真正该报的是「标了额外 gold 却漏了主 gold」——
那会让 nDCG 的 IDCG 少算一项。）

### 关键产出

- `data/annotation_multi_gold.jsonl`：50 条，38 条多 gold。
- `src/raglab/scoring.py`：`multi_gold` 参数 + `ndcg5_from_multi_gold` 标记。
- `src/raglab/intake.py`：`multi_gold_map` + `check_multi_gold_coverage`。
- `src/raglab/__main__.py`：`cmd_score` 接线 + `summary.json` 的 `ndcg_source`。
- `tests/test_multi_gold.py`：11 项（核心不变量「primary 不变」有专门断言）。

**测试**：414 passed（403 → 414，新增 11 项）。

### 仍未解决

- **仍是单标注者、无一致性系数** → nDCG@5 标低置信（spec §6.5 要求）。
- **search 轨 30 条未标多 gold**（按 spec §7.5）→ 那 30 条的 nDCG@5 仍是单 gold 口径。
- 独立盲写查询、第二位标注者两项仍依赖他人。
## 2026-10-21 · 收口：提交前检查抓出两个真 bug

**用户关键原话**：`就这样收口，汇总一下，然后给我git提交命令`。

用户要的是**提交命令**，不是「继续做」。所以这一轮的重点是
**提交前把不该进库的东西拦住、把会导致结论错的东西修掉**，
而不是再开新工作项。

### 提交前检查：三件事

1. **凭据扫描**：106 个改动文件全扫 `sk-*` / `api_key` / `bearer` → 0 命中。
2. **语料指纹扫描**：拿语料正文的连续片段做探针，逐个文件比对
   （查「语料明文不进版本库」这条到底守住了没）。
3. **体积与忽略规则核对**：哪些产物该入库、哪些是可重建的中间物。

### 抓出真问题一：`results/cache/A_index.json` 里躺着语料正文

`.gitignore` 忽略了 `corpus/`，但**向量索引缓存文件把每个 chunk 的全文都存了进去**——
634/1140 个语料指纹命中。它本来不在忽略列表里，`git add .` 就会把它带进去。

**修法**：`results/cache/` 整体忽略，并在 `.gitignore` 里写清原因
（不是「文件太大」，是「内嵌语料正文」）。

**顺带确认**：跑批 trace（`results/runs/*.jsonl`）**不含**语料正文
（40 字长探针 0 命中）——B 的 `extra.reason` 是模型自己写的诊断理由，
不是复制的原文。诊断目录的 jsonl 同理。所以 trace 继续忽略是对的，
但**报告正文、汇总 JSON、图表要入库**（可审计证据）。

### 抓出真问题二：冻结门禁根本不可能打开

`prereg.read_preregistration` 判「已冻结」的条件之一是文件里有
`"## 冻结记录"` 这一节——而**真实文件里的标题是 `## 8. 冻结记录`**（带章节号）。

```
真实文件：'## 8. 冻结记录' in text → False
模板测试：'## 冻结记录' in text   → True
```

于是：**占位符填得再全，真实文件也永远判不出「已冻结」**，
`score --confirmatory` 永远被拒。**测试却是绿的**——因为测试用的模板
没有章节号，恰好走了另一条分支。

这类 bug 的性质和之前那个「Holm 族大小缩水」一样：**不报错，只会让东西
悄悄地不对**。测试写的是模板，门禁跑的是真实文件，两者不一致。

**修法**：标题按 `^#{2,6}\s*(\d+[.\s]\s*)?冻结记录\s*$` 匹配，
带不带编号都认。加了两条回归测试把两种形态都钉住。

### 顺带发现：门禁的另一个洞（自己堵的）

修完标题匹配后，`read_preregistration` 判出 **frozen=True**——
可「本文件」那一行的哈希**还是空的**（我刚才把它换成了 resolved/splits 的真哈希，
顺手把本文件那行留成了「（G0 时计算）」）。

**这是我自己刚造出来的洞**：预注册**根本没冻结**，门禁却放行了。

**修法**：「本文件」那行用回占位符 `未生成`。语义也对——本文件此刻还在改，
哈希只能等内容定稿才算。**这正是 `HASH_PLACEHOLDER` 的用途**，
冻结判据本来就靠它（我一开始把它当成"还没填的表格"，其实是"填了就能开"的钥匙）。

**教训**：改门禁的时候得问「这道门现在拦住了什么」，
而不只是「我想让它拦什么」。我差点造出一个「预注册没冻结也能跑确认性评测」的门禁。

### 顺带补上：resolved 配置的 sha256 字段

`verify_resolved_configs` 要求 resolved 配置里有 `sha256` 字段，
但**没有任何代码写它**——`cmd_grid --write-resolved` 只写参数。
所以这道门也是永远关着的。

**修法**：
- `prereg.config_payload_sha256` 算参数本身的哈希（**排除 `sha256` 字段自身**，
  否则自指没法校验；**`sort_keys`**，否则改键顺序就误判成"配置被改过"）。
- `cmd_grid --write-resolved` **由代码写这个字段**——手改的文件会在下次
  跑 grid 时被整个覆盖，字段就没了。
- `verify_resolved_configs` 从「查字段存在」改成「**校验哈希值本身**」。
  只查字段在的话，手填的旧值一样能过门禁——那等于没有门禁。

三个已生成的 resolved 配置（A / B / C_prime）已回填哈希，
`PREREGISTRATION.md` 的冻结记录表也填了真哈希。

### 校验结果（全部实测）

| 项 | 结果 |
|---|---|
| 测试 | **419 passed**（414 → 419，新增 5 项） |
| 凭据扫描 | 106 文件 0 命中 |
| 语料正文扫描 | `results/cache/` 忽略后，剩余文件 0 命中（40 字长探针） |
| resolved 门禁 | `verify_resolved_configs` 返回空 |
| 冻结状态 | `frozen=False`，原因「冻结记录仍含占位符『未生成』」——**正确** |
| 多 gold 验收 | 接线前后主判定指标一字未变，nDCG 排序不变（复算通过） |

### 仍未解决（与上一轮相同，未因收口而缩小）

- **B 的 H7 无法评估**（无负样本跑批实现）——最大的未知。
- **B 在全量 80 条上的波动区间未知**（稳定性只在 10 条子样本上量化过）。
- **独立盲写查询 / 第二位标注者**——依赖他人。
- **预注册未冻结**——本文件自身的哈希要等内容定稿才算。

### 关键产出

- `src/raglab/prereg.py`：`config_payload_sha256` + 冻结章节标题正则 + 哈希值校验。
- `src/raglab/__main__.py`：`cmd_grid` 写入 `sha256`；`_config_payload_sha256` 转发到 prereg。
- `config/resolved/{A,B,C_prime}.json`：回填 `sha256`。
- `PREREGISTRATION.md`：冻结记录表填真哈希 + 说明「本文件」那行为什么是占位符。
- `.gitignore`：`results/cache/` 整体忽略（内嵌语料正文）。
- `tests/test_prereg.py`：新增 5 项（含标题带编号的回归测试）。
