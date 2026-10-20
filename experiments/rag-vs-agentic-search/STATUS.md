# 实验状态

- **当前状态**：`BLOCKED`（阻塞项已收敛到 M3 / M4）
- **原因**：M1 语料与自建评测集已到位并通过 G0；但方案 C 需 M3 才能忠实复现，A/B/D 需 M4 端点，故仍不可跑完整对照
- **允许的动作**：C′（BM25+grep）实现与离线跑批、索引侧自检、导入与切分维护
- **禁止的动作**：用占位语料/占位 gold 跑批；产出“结果”图表；声称任何方案胜出；把自检索或单方案结果当作方案对比；未披露单标注者与未索引 gold 比例就报告成绩

## 阻塞项

| # | 材料 | 状态 | 解除条件 |
|---|---|---|---|
| M1 | Phase 0 KB 103 文件 + `index.yaml` | **已取得**（2026-10-20，实测 108 md / 90 条目） | 需确认口径差异，见下方「M1 实收记录」 |
| M2 | 274 条回归查询与预期文件 | **已替换为自建查询集**（80 条，2026-10-20） | 原集确认拿不到；自建集已通过 G0 |
| M3 | kb-mcp 源码或算法说明 | 未取得 | 用户提供 |
| M4 | LLM/embedding 端点 | 未取得 | 用户提供可用的 OpenAI 兼容端点 |
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

**仍未关闭**：M3（C 的忠实复现）、M4（A/B/D 的 live 运行）。决策点 #2 在 A/B/C/C′/D 全部跑完前不可关闭。

## 状态变更记录

| 日期 | 状态 | 说明 |
|---|---|---|
| 2026-10-19 | BLOCKED | 建立实验目录骨架（README / docs / .gitignore），未实现、未跑批 |
| 2026-10-20 | BLOCKED | 搭建代码骨架：纯逻辑模块（paths/corpus/assets/intake/metrics/stats/llm/config/runner）已实现并有离线单测；五方案与图表为显式占位。仍未引入任何占位语料/gold，未跑批 |
| 2026-10-20 | BLOCKED | 补齐不依赖素材的后段链路：`split`（分层切分）、`score`（评分+分组汇总）、`report`（表格）、`env`（环境记录）、预注册哈希与 confirmatory 门禁。143 项 pytest 全通过。`index`/`run` 仍依赖 M1/M3/M4 |
| 2026-10-20 | BLOCKED | M1 语料到位并迁入 `corpus/kb/`（109 文件哈希逐一致、manifest 已生成）；M2 确认拿不到，评测集缺失，阻断一切指标与判定 |
