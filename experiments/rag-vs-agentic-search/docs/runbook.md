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
uv run raglab run --run-id <id> --scheme C [--partition dev|test|all]   # 跑批
uv run raglab score --run-id <id> [--partition dev|test|all] [--confirmatory]
uv run raglab report --run-id <id>            # 由 scored CSV 生成 results/tables/
uv run raglab env                             # 写 env.json（缺失项进 missing，不猜）
uv run raglab models                          # 列出模型候选与可运行状态（不触网）
```

- `import` 失败即退出码 2，错误逐条列在 `errors`，不生成占位语料或占位 gold。
- `score` 默认 `mode=exploratory`，`summary.json` 带 warning，**不得**作主判定。
- `score --confirmatory` 要求**四项全满足**，任一不满足即退出码 3：
  1. 分区不是 dev（dev 只用于调参，§6.1 T2）；
  2. `PREREGISTRATION.md` 已冻结——**无「未生成」占位符**（含「本文件」那一行，它算的是预注册自身的哈希）**且有「冻结记录」一节**（标题带不带章节号都认）；
  3. `config/resolved/<scheme>.json` 齐备；
  4. **每个 resolved 配置的 `sha256` 与其内容对得上**——冻结后偷偷改参数会被当场拒绝。

  > 第 4 项的哈希算的是**参数本身**（不含 `sha256` 字段自身，键序无关），
  > 由 `raglab grid --write-resolved` **写入**——手改的文件会在下次跑 grid
  > 时被整个覆盖，字段就没了。

## 网格搜索（dev-only，§6.3）

```bash
uv run raglab grid --scheme C_prime --run-id <id> [--write-resolved]
```

- 跑完 `config/schemes/bm25_grep.yaml` 里的**全部 16 组**，写 `results/tables/grid_search.csv`。
- **不只报最优**——只报最优会让读者看不到搜索空间有多大（T3）。
- `--write-resolved` 才把 dev 最优写入 `config/resolved/<scheme>.json`；不加只打印。

## 敏感性分析：评测集来源偏差（探索性）

```bash
uv run raglab sensitivity [--out-dir <dir>]
```

- 检验「评测集与语料同一人撰写 → C′ 的全语料词频天然吃香」这条威胁。
- 按查询 token 在语料词表里的覆盖率分三层，比较 C 与 C′ 的 Recall@2 差距。
- 若查询集旁有 `data/queries_blind.jsonl` 会自动并入；没有则只用原集并告警。
- 产物 `results/tables/sensitivity_coverage.{csv,md}`。
- **输出里带「非因果推断」声明**：覆盖率与查询长度、术语密度也相关。

### 离线多方案模式（不重跑方案）

```bash
uv run raglab sensitivity --from-runs [--run-id main] [--scheme A B C C_prime] [--reference A]
```

- **读已落盘的跑批结果**做分层，**不重跑任何方案**——重跑 B 要 1.4 小时，
  而分层只需要「每条查询命中没有」，那个信息跑批时已经算出来存进 JSONL 了。
- 用于检验**任意多个**方案相对参照方案的覆盖率形态。典型用途：
  「B 的优势是不是同源红利」——要看的不只是 B 自己的数，还要看**对照组**：
  C′ 走词频匹配，若它呈现「低覆盖率层塌下来、高覆盖率层才转正」的形态，
  而 B 没有，就说明这个方法确实测得出这类偏差，B 的「不塌」才是有意义的证据。
- 只统计**各方案都有结果**的查询（缺一条就滤掉），否则各层的 n 不可比。
- 产物 `results/tables/sensitivity_coverage_all.{csv,md,json}`。
- **输出里同样带「非因果推断」声明**。

## 跑批（A / B / C / C′ 可跑）

```bash
uv run raglab run --run-id <id> --scheme C [--partition dev|test|all]
uv run raglab run --run-id <id> --scheme C_prime
uv run raglab run --run-id <id> --scheme A        # 需先 raglab index
uv run raglab run --run-id <id> --scheme B --spacing 15 --query-spacing 15   # 触网，慢
```

方案 B 的三条硬约束（都有测试）：

1. **必须调用 `submit`**。没提交 → `timeout`，按 ITT 计 miss。不能把"模型说了点什么"当成找到了。
2. **达到轮数上限仍在调工具** → `timeout`。
3. **工具结果必须按 `tool_call_id` 回灌**，否则模型会反复调同一个工具。

B 的实测成本：**约 80 秒/查询**（4 轮、6 次工具调用、约 3.1 万输入 token）。
80 条全量约 **1.8 小时**。

**两个 spacing 是不同的东西，缺一不可**：

- `--spacing 15`：**一条查询内部**的相邻工具轮次之间。由方案 B 自己管。
- `--query-spacing 15`：**相邻查询之间**。由跑批层管。

不加 `--query-spacing`，上一条查询的最后一个工具轮和下一条查询的第一个工具轮
会背靠背发出去——那正是实测成功率 0% 的突发模式。

**断点续跑**（B 的全量必须开）：

```bash
uv run raglab run --run-id <id> --scheme B --spacing 15 --query-spacing 15 --resume
```

- 结果**逐条落盘**，不是跑完才写。中途被网关排队打断，已完成的部分仍在盘上。
- `--resume` 跳过目标文件里已完成的 `query_id`，从断点接着跑。
- **不带 `--resume` 而目标文件已存在 → 退出码 3**：直接覆盖会让"这次跑批
  包含哪些查询"变得不可判定。两条路必须选一条。
- 续跑前若发现坏行（`不是合法 JSON`），先修文件——坏行意味着写坏了，
  继续追加只会更坏。

- **网格参数必须先选值**：`bm25_grep.yaml` 里 `k1` / `b` / `chunking` / `tokenizer` 是列表，
  直接跑 `run` 会以退出码 2 拒绝并指向 `raglab grid`。这是有意的——把网格当标量用
  会静默取到错误档位。
- C 的 `dispatch_rule` 已在预注册选定为 `deployed`，不是列表，可直接跑。

- 默认 `exploratory`；`--confirmatory` 只是给结果打标，真正的门禁在 `score --confirmatory`。
- 输出 `results/runs/<run_id>/<scheme>.jsonl`，形状对齐 §8.1。
- 单查询失败按 ITT 记 `error` 并继续；连续 5 次网关错误中止整批（§9.4）。
- 跑完用 `raglab score --run-id <id>` 评分。**C 的耗时在秒级**（80 条查询 P50 约 3 ms），不占限流预算。

方案 C 的 `dispatch_rule` 取自 `config/schemes/index_grep.yaml`，会写进每条结果的 `extra`，
便于事后核对这次跑批用的是哪种读法。

## 单方案诊断报告（探索性，不出方案对比）

```bash
uv run raglab diagnose --run-id <id> [--scheme C]
```

产物在 `results/diagnostic/<run_id>/`：

```
C_deployed.jsonl / C_lexical.jsonl / C_lookup_only.jsonl   # 逐条记录
diagnostic.json                                            # 汇总（含 negatives_by_rule）
figures/fig2_metrics_overall.png                           # 指标总览
figures/fig3_latency_cdf.png                               # 延迟 CDF（P50/P95）
figures/fig6_rejection_roc.png                             # 负样本行为
figures/fig_dispatch_variants.png                          # 三读法对照
report.md                                                  # 报告正文
```

- **这是唯一会出图的命令**，且只在单方案诊断场景使用。`report` 仍然只出表格。
- 跳过的图会带原因写进 `report_manifest`/JSON 输出，**不产出空图**——空图会被读成"无差异"。
- 报告正文第一段就声明"这不是实验结论"；`schemes_available < 2` 时对比类图表一律跳过。
- 延迟在 `warm_up()` 之后测量，不含 `index.yaml` 解析成本（每进程只付一次）。
- **入库口径**：`report.md`、`diagnostic.json`、`figures/*.png` 进版本库；`C_*.jsonl`（逐条记录，可重新生成）被 `.gitignore` 忽略。

## 仍未就绪

```bash
uv run raglab index                # 退出码 3：A 的向量索引侧未实现
uv run raglab run --scheme A       # 退出码 2：A/B/D 均为占位
```

`run` 指定未实现方案时退出码 **2**（配置错误），不写任何结果文件。

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

## 复核 M3（kb-mcp）语义与基线

方案 C 的权威语义在**主仓库** `mcp-servers/kb/`（本实验目录只读引用，不复制源码）。当前对齐的版本：分支 `feat/m2-stage3`，tip `c529dcd`。

```bash
# 1. 本实验语料与 kb-mcp 侧逐文件一致（应无输出）
diff <(cd ../../mcp-servers/kb/kb && find . -name "*.md" -exec sha256sum {} \; | sort) \
     <(cd corpus/kb && find . -name "*.md" -exec sha256sum {} \; | sort)

# 2. 用 kb-mcp 自己的实现重跑其回归（需先构建）
cd ../.. && npm run build:mcp && npm run kb:regression
```

kb-mcp 自报基线：index 轨 Recall@2 0.4400 / Hit@1 0.3800 / MRR 0.4100；search 轨 Hit@1 0.1333 / goldInTop20 0.4333；负样本拒答率 0.8400。三项在 2026-10-20 均已逐项复现。

读源码时注意这三处**不是**显而易见的语义（都影响方案 C 的忠实度）：

| 位置 | 语义 | 后果 |
|---|---|---|
| `service.ts` `lookup()` | `found` 需同时过 `score >= 1.75`、技术 token 覆盖度 > 50%、中文覆盖度、OOV 折减四道闸门 | 「关键词得分 > 0」≠ `found`；dispatch 读法差 13.75pp |
| `service.ts` `search()` | 只排除 `_inbox.md`/`_about.md`/`index.yaml` | `_sources.md` 仍可被搜到且按路径字典序排第一 |
| `service.ts` `extractQueryTokens()` | 丢弃长度 < 2 的 token；`search()` 则**不**做长度过滤 | `i.MX` 在 search 分支会让 `i` 成为搜索词 |

细节与量化见 `STATUS.md`「M3 实收记录」与「M3 实测出的口径分歧」。

## 常见失败

| 现象 | 原因 | 处置 |
|---|---|---|
| `缺少语料 manifest` | 未导入语料 | 导入语料后 `write_manifest()` 生成 `corpus/kb/manifest.sha256` |
| `语料不一致（changed/missing/unexpected）` | 语料被改动 | 视为新实验，换 `run_id` 并重生成 manifest |
| `gold 路径不存在` | 查询集与语料版本不匹配 | 核对 M1/M2 是否同一快照 |
| `live 调用被拒绝` | 未设 `RAGLAB_LIVE=1` | 显式开启；不要为了"跑通"关掉门禁 |
