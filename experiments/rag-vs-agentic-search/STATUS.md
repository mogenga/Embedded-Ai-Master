# 实验状态

- **当前状态**：`BLOCKED`（阻塞项已收敛到 M3，以及方案实现本身）
- **原因**：M1 语料与自建评测集已到位并通过 G0；M4 端点已实测可用（2026-10-20）；方案 C 需 M3 才能忠实复现，A/B/C′/D 的实现尚未落地，故仍不可跑完整对照
- **允许的动作**：A/B/C′/D 的实现与离线单测、C′（BM25+grep）离线跑批、索引侧自检、导入与切分维护、dev 分区上的小规模探索性跑批（须标注 exploratory）
- **禁止的动作**：用占位语料/占位 gold 跑批；产出“结果”图表；声称任何方案胜出；把自检索或单方案结果当作方案对比；未披露单标注者与未索引 gold 比例就报告成绩

## 阻塞项

| # | 材料 | 状态 | 解除条件 |
|---|---|---|---|
| M1 | Phase 0 KB 103 文件 + `index.yaml` | **已取得**（2026-10-20，实测 108 md / 90 条目） | 需确认口径差异，见下方「M1 实收记录」 |
| M2 | 274 条回归查询与预期文件 | **已替换为自建查询集**（80 条，2026-10-20） | 原集确认拿不到；自建集已通过 G0 |
| M3 | kb-mcp 源码或算法说明 | 未取得 | 用户提供 |
| M4 | LLM/embedding 端点 | **已取得并实测可用**（2026-10-20） | LLM `step-5-preview`、embedding `BAAI/bge-m3`；见下方「M4 实测记录」 |
| M5 | 扰动集 / 负样本 / 多 gold | 负样本已完成；扰动集与多 gold 未建 | 扰动集缺失只阻塞 H6（已按 §5.2 降级为 warning） |

## M1 实收记录（2026-10-20）

来源：`docs/kb-export/`，已迁移至 `corpus/kb/`（被 `.gitignore` 忽略，不进版本库）。
迁移前后 109 个文件逐一 SHA-256 比对一致；`corpus/kb/manifest.sha256` 已生成并通过 `verify_corpus`。

| 项 | 实测 | spec §5.1 声称 |
|---|---|---|
| md 文件 | 108 | 103 |
| `index.yaml` 条目 | 90 | 85 |
| 总大小 | 478 KB | ~500 KB |
| 编码 | 全部合法 UTF-8，无 BOM | — |
| `index.yaml` 路径有效性 | 90/90 存在，无越界 | — |

**已知偏差（需在预注册中登记，或按新实验换 `run_id`）**

1. **46 个文件 frontmatter 无法被 YAML 解析**：`description` 值含未加引号的冒号（如 `... 。触发词: hardfault, ...`），`yaml.safe_load` 报 `mapping values are not allowed here`。仅 20 个文件可解析，42 个无 frontmatter。
2. **三种 frontmatter schema 并存**：`id/title/tags/keywords/summary`（10 个 vendor 文件）、`name/description/protocols/measures/tools`（protocols/debug/system）、`complexity/domain/id/source/symptoms/title`（6 个 cases）。
3. **`_inbox.md`（51 KB，38 条未审阅条目）不属于可检索语料**，已加入 `config/experiment.yaml` 的 `navigation_files`；`cases/_about.md` 同理。
4. **15 个 reference 文件不在 `index.yaml` 中**（reference 共 39 个，索引 24 个）。若评测集 gold 指向这些文件，方案 C 结构性无法命中。

**未验证**：frontmatter 是否能被 kb-mcp 正确解析——依赖 M3。

## M2 缺口与替代方案（2026-10-20 决策：自建查询集）

原 274 条回归查询集确认无法取得，用户决定**自建查询集**。已交付：

| 资产 | 内容 |
|---|---|
| `data/queries.jsonl` | 80 条：index 轨 50（自然语言症状）+ search 轨 30（精确 token） |
| `data/splits.json` | seed 20261019，dev 55 / test 25 |
| `data/negatives.jsonl` | 25 条负样本（H7） |

**必须披露的三项偏差**

1. **单标注者**：全部由项目所有者编写，无一致性系数（spec §6.5）。
2. **11/80 条 gold 不在 `index.yaml` 中**：方案 C 在这些查询上结构性无法命中；必须按"gold 是否被索引"分层报告，不得与 A/B/C′ 全量成绩直接比较（T12/T13）。`raglab import` 已在 warning 中列出该数字。
3. **样本量 80 < 274**：功效下降，10pp 效应更可能被判为"未决"。

**仍未关闭**：M3（C 的忠实复现）。决策点 #2 在 A/B/C/C′/D 全部跑完前不可关闭。

## M4 实测记录（2026-10-20）

探针已固化为 `scripts/probe_endpoints.py`（人工工具，不属于跑批路径）：`uv run python scripts/probe_endpoints.py`，需 `RAGLAB_LIVE=1`。密钥只进请求头，输出只含 `api_key_set`；默认间隔 15s 按实测限流设定。下表的数字都可用它复现（确定性/限流两项需加 `--determinism --rate`）。

| 项 | LLM `step-5-preview` | Embedding `BAAI/bge-m3` |
|---|---|---|
| 连通性与延迟 | 通过，稳态 3–7s/次 | 通过，1024 维、L2 归一化 |
| 密钥校验 | 不带 key → 401 | 不带 key → 401 |
| 批量上限 | — | 110 条一次通过（1.04s） |
| tool calling | 通过，参数 JSON 正确 | — |
| 多轮工具循环 | 通过（含 tool 结果回灌） | — |
| 确定性 | **不成立**：temperature=0 三次三答 | 近似：余弦 0.999937 |

**限流（决定性约束）**：网关为共享队列，`queue.full` / `queue.waiting` / `usage exceeds frequency limit` 三种 429。

| 发起方式 | 成功率 |
|---|---|
| 4 并发 | 0/4 |
| 6 次连发 | 0/6 |
| 10s 间隔 ×4 | 3/4 |
| 15s 间隔 ×5 | 5/5 |
| 闲置 60s 后连发 2 次 | 2/2 |

**可行口径：串行单线程、间隔 ≥ 15s，约 4 次/分钟。** 并发与突发均不可用。

按此预算，方案 B（80 查询 × repeat 3 × 每运行 5–8 次调用）约需 5–8 小时；若再跑 dev 轮数网格 {6,12,20} 则超过 10 小时。**B 的重复次数与轮数网格必须在预注册前按此预算重新确定**，否则跑不完。

**已确认的结构事实**：响应含 `reasoning_content`，`content` 可能为空；`seed` 被接受但不回显、无 `system_fingerprint`（`supports_seed: false` 的配置准确，不能靠 seed 复现）；`reasoning_content` 回传与否都能跑通。

**顺带发现的两处不一致（均已修复，2026-10-20）**

1. ~~端点环境变量是空头承诺~~：`docs/runbook.md`、`config/experiment.yaml`、`config/models.yaml` 曾声称可用 `RAGLAB_LLM_BASE_URL` / `RAGLAB_LLM_MODEL` / `RAGLAB_EMBED_BASE_URL` / `RAGLAB_EMBED_MODEL` 覆盖端点，但源码从未读这四个变量。**已删除这些承诺**：M4 端点只认 `models.yaml`，`experiment.yaml` 出现 `model` 段直接报错。
2. ~~`env.json` 记录的不是实际用的端点~~（T9 记录缺口）：`cmd_env` 曾把 `experiment.yaml` 的 `model.*`（全为 `null`）传给 `capture_env`。**已改为**读取 `models.yaml` 并写 `model_candidates`（含 `usable`/`block_reason`，不含密钥）。

## 状态变更记录

| 日期 | 状态 | 说明 |
|---|---|---|
| 2026-10-19 | BLOCKED | 建立实验目录骨架（README / docs / .gitignore），未实现、未跑批 |
| 2026-10-20 | BLOCKED | 搭建代码骨架：纯逻辑模块（paths/corpus/assets/intake/metrics/stats/llm/config/runner）已实现并有离线单测；五方案与图表为显式占位。仍未引入任何占位语料/gold，未跑批 |
| 2026-10-20 | BLOCKED | 补齐不依赖素材的后段链路：`split`（分层切分）、`score`（评分+分组汇总）、`report`（表格）、`env`（环境记录）、预注册哈希与 confirmatory 门禁。143 项 pytest 全通过。`index`/`run` 仍依赖 M1/M3/M4 |
| 2026-10-20 | BLOCKED | M1 语料到位并迁入 `corpus/kb/`（109 文件哈希逐一致、manifest 已生成）；M2 确认拿不到，评测集缺失，阻断一切指标与判定 |
| 2026-10-20 | BLOCKED | M4 端点实测可用（LLM `step-5-preview` + embedding `BAAI/bge-m3`，tool calling 与多轮循环通过）；阻塞项收敛到 M3 与方案实现。同时测出网关串行限流约 4 次/分钟，B 的重复与轮数预算需据此重定 |
| 2026-10-20 | BLOCKED | 收敛配置面：删除从未被消费的 `experiment.yaml` `model` 段与端点环境变量承诺，M4 端点只认 `models.yaml`；`env.json` 改为记录 `models.yaml` 的真实候选（T9 记录缺口已修）。164 项 pytest 全通过 |
