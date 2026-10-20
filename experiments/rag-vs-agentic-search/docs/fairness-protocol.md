# 公平性协议执行清单

> 内容权威来源：主仓库 spec §6（T1-T13）。本文件只把每条威胁翻译成**可在代码/流程里检查的钩子**，不重复论证。

| # | 威胁 | 已落地的检查点 | 当前状态 |
|---|---|---|---|
| T1 | 各方案看到不同语料 | `corpus.build_manifest` / `verify_manifest`；`intake.run_intake` 校验 | 已实现（纯逻辑） |
| T2 | 在 test 上调参 | `splitting` 固定 seed 切分；`prereg.require_confirmatory_ready` 禁止 dev 上确认性评分、要求预注册冻结与 resolved 配置齐备 | 已实现 |
| T3 | 调参预算不对称 | `config/schemes/*.yaml` 的预注册网格 | 配置已建，网格跑批未实现 |
| T4 | 模型货比三家 | `config/models.yaml` 候选清单 + `ModelCandidate.usable` 可运行判定 + `raglab models`；选择规则（dev 最高，差距 < 2pp 取本地）写在 `PREREGISTRATION.md` | 候选已就位并实测可用；选择规则待冻结 |
| T5 | B 与一次性检索口径不同 | `schemes.base.RetrievalScheme.run` 统一出口；B 必须 `submit` | 出口已实现；B 未实现 |
| T6 | 失败被静默剔除 | `runner.run_queries` 单查询失败记 `error` 并继续；ITT 分母不变 | 已实现 |
| T7 | 标注偏向某方案 | `assets.parse_multi_gold` 要求 `blind` 字段 | 已实现（字段级） |
| T8 | 指标挑选 | `metrics` 全指标同时产出；`scoring.summarize` 固定分组维度 | 已实现 |
| T9 | 运行环境漂移 | `env.capture_env` 记录 OS/Python/uv/lock 哈希/manifest 哈希/git SHA/seed，以及 `models.yaml` 的全部候选（含 `usable`/`block_reason`，不含密钥）；缺失项进 `missing` 不臆造 | 已实现 |
| T10 | 提示词泄漏评测信息 | `config/prompts/agentic_system.txt` 由测试断言不含 `index.yaml`/`track`/`gold` | 已实现（测试断言） |
| T11 | 导航文件污染候选 | `schemes.base.filter_navigation`；`experiment.yaml` 预注册清单 | 已实现 |
| T12 | C 只能返回 top-2 | `config/schemes/index_grep.yaml` 的 `extended_recall_k` | 配置已建；C 未实现 |
| T13 | C 在评测集上调过 | `index_grep.yaml` 的 `ablations: [no_index]` + 报告须标注"乐观上界" | 配置已建；报告未实现 |

## 骨架期硬规则

1. 方案占位一律抛 `FeatureNotImplemented`，不返回空候选。
2. 导入失败即中止（退出码 2），不跳过坏样本。
3. 未设 `RAGLAB_LIVE=1` 时任何网络调用直接拒绝。
4. 没有评分 CSV 就不出图（`report/charts.py` 抛异常）。
