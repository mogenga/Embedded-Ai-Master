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
