# KB MCP — 本地语料与索引解析

本目录是 BR-3 诊断知识库 MCP 的实现根。语料与回归查询集只作为**本地资产**存在，不进版本库；进入版本库的是解析器、测试与本说明。

## 语料来源与迁移

- 来源（只读复制，未修改源目录）：
  - `.worktrees/feat-rag-experiment/experiments/rag-vs-agentic-search/corpus/kb/` → `mcp-servers/kb/kb/`
  - `.worktrees/feat-rag-experiment/experiments/rag-vs-agentic-search/data/queries.jsonl`、`negatives.jsonl` → `mcp-servers/kb/data/`
- 复制时间：2026-10-20。
- 文件统计（复制后实测）：
  - `kb/` 共 110 个文件 = 108 个 `.md` + `index.yaml` + `manifest.sha256`；
  - `index.yaml` 共 90 个 `entries` 条目；
  - `manifest.sha256` 逐文件校验：108/108 `OK`，无失败、无缺失；
  - `data/queries.jsonl` 80 条（`index` 轨 50 / `search` 轨 30）；`data/negatives.jsonl` 25 条。

### 与 BRD 基线数字的偏差（必须披露）

| 项 | BRD 基线 | 实测 | 说明 |
|---|---|---|---|
| 语料文件 | 103 | 108 md | 以 Phase 0 实验区实际语料为准，按实测记录，不裁剪、不改写 |
| 索引条目 | 85 | 90 | 同上，索引条目多于 BRD 基线 |
| frontmatter 非标准 YAML | — | 46 处 | 均为 `description` 值内嵌“触发词: …”冒号；这些值靠单引号包裹才构成合法 YAML，朴素解析器会在冒号处截断。`parseFrontmatter` 按引号边界处理，实测 66/66 个含 frontmatter 的文件全部解析成功 |
| 回调查询 gold 未被索引 | — | 11/80 | gold 指向 `reference/*.md` 等未进入 `index.yaml` 的文件；回归报告须按“gold 是否被索引”分层，不得与全量成绩混算 |

此外，108 个 md 中有 42 个没有 frontmatter（多为 `_inbox.md`、`_about.md` 等导航/登记文件），这是语料现状，不是解析失败。

## 不入库声明

`.gitignore` 已包含：

```text
mcp-servers/kb/kb/
mcp-servers/kb/data/
```

提交前须确认 `git status --short` 的待提交列表中不出现这两个目录。语料正文与查询集标注按 BRD R7 的许可口径只在本地使用，不随代码库分发。

## 重新获取本地资产

从实验区工作树复制（源目录保持只读，不要修改）：

```bash
SRC=.worktrees/feat-rag-experiment/experiments/rag-vs-agentic-search
mkdir -p mcp-servers/kb/data
cp -r "$SRC/corpus/kb" mcp-servers/kb/kb
cp "$SRC/data/queries.jsonl" "$SRC/data/negatives.jsonl" mcp-servers/kb/data/
cd mcp-servers/kb/kb && sha256sum -c manifest.sha256
```

`sha256sum -c` 应全部输出 `OK`；若校验失败，重新复制，不要修改语料内容。

## `yaml.ts` 支持的子集

只覆盖 `index.yaml` 与 KB 文件 frontmatter 所需的最小子集，不引入 YAML 依赖：

支持：

- 顶层 `entries:` 列表；`-` 列表项与缩进 `key: value` 字段；
- 行内数组 `[a, b]`（支持引号内的逗号）；
- 单引号、双引号值（单引号内 `''`、双引号内 `\"` / `\\`）；
- 行首 `#` 注释与空行。

不支持（按 YAML 完整语法）：

- 块标量（`|` / `>`）、嵌套 map/列表、多行字符串、锚点与标签；
- 行尾注释：`#` 只有作为行首（允许前导空白）时才被当作注释，值中的 `#` 原样保留（语料中存在 `bic/and #1`、`#pragma` 等值）；
- 值中的冒号：`index.yaml` 解析按首个 `key:` 冒号分割，其余冒号保留在值里；frontmatter 中未加引号且含“冒号+空白”的值视为无法解析。

### 接口与失败语义

```ts
parseIndexYaml(text: string): IndexEntry[]
parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string; parsed: boolean }
```

- `parseIndexYaml`：`id` / `title` / `path` / `tags` / `keywords` 缺失时抛错（错误信息含条目序号与字段名）；`summary` 可缺失，补 `''`；空文本或纯注释返回 `[]`。
- `parseFrontmatter`：首行不是 `---`、缺少结束 `---`、出现缩进/嵌套结构、值无法解析（如未加引号的冒号）时返回 `parsed: false`，且 `body` 始终保留结束分隔线之后的原文；不抛错。解析失败时 `data` 返回空对象，调用方（`kb_read`）应保留原文并标注未解析。

### 检索评分与拒答

`KbService.lookup` 的分数为命中 keyword 长度和 + 2 × 命中 tag 数，并施加以下收紧：

- 非 CJK keyword/tag 使用 ASCII 词边界匹配；长度 < 2 的纯英文 token 忽略（例如 tag `c` 不参与匹配）。
- 查询中长度 ≥ 2 的 ASCII/十六进制 token 若不在索引 keyword/tag 词表中，按 `max(0, 1 - 0.75 × 未登录比例)` 折减分数。折减后最高分低于 `1.75` 时返回 `found: false`、`reason: "low_confidence"`；完全无词面命中返回 `no_match`。
- 技术 token 覆盖度：从查询提取 ASCII/十六进制/型号，过滤英文停用词与 `CPU`/`MCU`/`SoC` 等泛指词；候选条目必须覆盖单个技术 token，多个技术 token 必须覆盖超过一半。
- 中文覆盖度（仅在查询没有 ASCII 技术 token 时生效）：候选须满足命中中文 keyword 字符总数 ≥ 4、或命中 ≥ 2 个不同中文 keyword、或命中 keyword 之外还有 ≥ 2 个中文字符上下文；否则按 `low_confidence` 拒答。因此 `优化`、`对齐`、`没反应` 等孤立短词拒答，`串口没输出`、`串口乱码` 仍可命中。

该门槛用于让 KB 外查询显式拒答，代价是少量相邻主题召回下降。2026-10-20 实测：index Recall@2 0.44 / Hit@1 0.38 / MRR 0.41，search 严格 Hit@1 0.1333 / goldInTop20 0.4333，负样本拒答率 0.84（上一版 0.46 / 0.40 / 0.43 / 0.56，search 指标当时未单列）。基线见 `tests/regression-baseline.json`，回归脚本为 `npm run kb:regression`。残余 4 条误报中 3 条是主题相邻但细节未覆盖（neg-005、neg-008、neg-023，`near_domain: true`），1 条 neg-011 是纯硬件供电问题（`near_domain: false`）；详见 D-159。

## 测试

```bash
npx vitest run mcp-servers/kb/tests/yaml.test.ts
```

测试使用内联夹具，不依赖本地语料；另有一条真实语料测试，仅当 `mcp-servers/kb/kb/index.yaml` 存在时运行并断言解析出 90 条，语料缺失时自动 skip（不伪造数据）。