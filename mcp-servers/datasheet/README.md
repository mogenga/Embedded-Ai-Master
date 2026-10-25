# Datasheet MCP — 本地 PDF 数据手册检索

把工作区里的芯片数据手册 / 参考手册（PDF）变成可检索、可整页读取的 MCP 工具。移植自 A 仓库（Prometheus `src/embedded/datasheet.ts`），按本仓库 MCP server 形态重做，检索能力 1:1 对齐、诚实语义全盘继承，并补上 A 没有的整页读取。

## 定位与诚实边界

- **只读**：四个工具全部 `readOnlyHint: true`，唯一写入是 `.datasheet-mcp/` 页级缓存（可用 `DATASHEET_CACHE_DIR` 挪走）。
- **本地**：语料由用户放进工作区，不联网下载厂商 PDF；检索根是 `DATASHEET_ROOT`（缺省进程 cwd）。
- **两条 A 侧继承的诚实语义**：
  - 没有 `pdftotext` 时，工具返回带安装指引的显式错误，而不是看起来像「无命中」的空结果；
  - 扫描件（无文本层的 PDF）在 skipped 里如实报「无文本层」，且缓存里的 `empty` 标记让后续查询不再反复重提取。
- **明确不做**：向量嵌入 / Qdrant / LanceDB / VLM 表格理解（违背零依赖与语料本地可控原则；BM25 + 短语匹配对「寄存器名是精确标识符」的领域特性已够）；在线下载厂商 PDF（内核不触网）。

## 安装 pdftotext（Windows 两条路）

```powershell
winget install oschwartz10612.Poppler
# 或使用 MiKTeX 自带的副本
```

其他平台安装 poppler 后 `pdftotext` 即在 PATH 上。是否已安装可用 `datasheet_status` 的 `extractor` 字段确认。

## 工具面

| 工具 | 作用 | 关键返回值 |
|---|---|---|
| `datasheet_search(query, limit?)` | 整短语、大小写不敏感检索；每份文件报首个命中页 | `found` / `hits[{path,page,excerpt}]` / `skipped[{path,reason}]` / `extractor` |
| `datasheet_read(path, page, pageEnd?)` | 按相对路径 + 1-based 页码读整页文本 | `pages[{page,text}]` / `total` / `truncated` |
| `datasheet_registers(query?)` | 结构化寄存器表查询（未实现，规划中） | 恒 `not_available` 显式错误，不伪造 |
| `datasheet_status()` | 检索根 / 提取器 / 缓存统计 | `root` / `extractor` / `cacheDir` / `cacheEntries` / `fileCount` / `scanTruncated` |

- `datasheet_search`：limit 缺省 12、上限 50；文件遍历预算 200 个 PDF（`scanTruncated` 时 fileCount 是下界）；excerpt 取命中点前 120 / 后 200 字符。无命中必须如实告知，不得编造页码或内容。
- `datasheet_read`：path 相对检索根（`datasheet_search` 返回的 path 原样可用），拒绝绝对路径与 `..` 越界（`path_denied`）；单次至多 50 页、累计至多 512KiB，超出 `truncated: true`；页码越界返回 `page_out_of_range` 并附 `total`。页文本来自 `pdftotext -layout`，保留列对齐。
- `datasheet_status`：提取器缺失时附 `installHint`，本身不报错（如实报告状态是它的本职）。

错误码（`isError: true` 的结构化返回）：`invalid_argument` / `path_denied` / `not_found` / `file_too_large` / `extractor_missing` / `no_text_layer` / `extract_failed` / `page_out_of_range` / `page_range_too_large` / `not_available`。

## 环境变量与缓存

| 变量 | 缺省 | 说明 |
|---|---|---|
| `DATASHEET_ROOT` | 进程 cwd | PDF 检索根；遍历 ≤6 层、≤200 文件、>80MiB 跳过、跳 `.` 开头目录与 `node_modules` |
| `DATASHEET_CACHE_DIR` | `<root>/.datasheet-mcp/` | 页级 JSON 缓存。键 = sha1(绝对路径) 前 16 位，stamp = `mtimeMs:size`，文件被替换自然失效；写入目标恒限制在缓存目录内（越界显式拒绝），写失败静默（缓存丢失只损时间不损正确性）。可挪到 `$HARNESS_HOME` 下让工作区保持干净 |

缓存目录本身在遍历跳过清单里（`.` 开头规则），不会被当成语料自吃。删掉缓存目录再查，行为一致——缓存纯加速。

## MCP 注册示例

```json
{
  "mcpServers": {
    "datasheet": {
      "command": "node",
      "args": ["dist-mcp/datasheet/server.js"]
    }
  }
}
```

> 本目录是 TypeScript 源码；MCP server 实际加载的是 `dist-mcp/datasheet/`。改动工具面后必须先 `npm run build:mcp`（`dist-mcp/` 不在版本库内，无热重载）。

## 测试

```bash
npx vitest run mcp-servers/datasheet
```

- fixture PDF 由 `tests/fixtures.ts` 现场生成（最小合法 PDF：文本层 + 纯图两种形态），不入库。
- 依赖 `pdftotext` 的用例在没有提取器的机器上整组 skip（对齐 kb 语料缺失即 skip 的先例）；「探测失败 → 安装指引」路径全平台离线可测。

## 检索质量与回归门禁

检索是 **BM25 + 整短语加成的混合排序**（`bm25.ts`，零依赖手写）：

- 页级 token 化：小写、按非字母数字切分；停用词表为零起步（英文常用词的 idf 天然低）。
- 混合分 = BM25（稀有术语权重高）+ 短语命中加成（整短语连续出现稳赢分词命中）。
- 术语映射（`service.ts` 的 `TERM_SYNONYMS`，30 条起步）：查询含一侧短语时追加另一侧 token（`alternate function`↔`AF`、`复位值`↔`reset value`），主要服务中文查询打英文手册。
- **拒答防线**：查询的每个 token 都必须在至少一份文件里**按词边界**出现，否则整条查询如实返回无命中。乱拼寄存器名（`GPIO_CRLX`）不会拿只含泛词（GPIO）的页凑数；文档自己的通配记号（`ODRx`/`DHRx`）是真出现，不算误报。

回归门禁（照 kb 的模式）：

```bash
node scripts/datasheet-corpus.mjs        # 下载语料（需出网/走本机代理）
npm run datasheet:regression             # 跑批 + 与基线比较
npm run datasheet:regression -- --update-baseline  # 检索改动后重标基线
```

- 语料：RM0008 Rev 21（STM32F1）+ RM0090 Rev 22（STM32F4），sha256 钉死；ST 版权材料，`corpus/` 不入库。
- 查询集：`data/queries.jsonl` 50 条金查询（寄存器名/位域名/章节短语）+ `data/negatives.jsonl` 25 条负例（乱拼寄存器名）——标注是自造的，入库。
- 基线（`tests/regression-baseline.json`，2026-10-24）：R@2 1.0 / Hit@1 1.0 / MRR 1.0 / 负例误报 1/25。**R@2=1.0 的口径必须如实说明**：gold 页码取自首跑 top-1（自标注），它防的是未来改动退化，不是独立人工标注的绝对质量。
- 已知局限（如实披露）：n08 `ADC_CR3` 误报——`CR3` 真实存在于 USART_CR3（跨外设撞名），BM25 词袋无法区分；返回页确实含 CR3 寄存器文档。
- `tests/regression.test.ts` 在语料缺失时整组 skip（对齐 kb 先例，不伪造）。

## 与 A 侧及业界方案的差异

| 能力 | A（datasheet.ts） | 业界 | 本目录 |
|---|---|---|---|
| PDF 解析 | `pdftotext -layout` | MinerU(+VLM) / pdfjs-dist | 同 A；扫描件如实报无文本层 |
| 检索 | 子串匹配，页级 excerpt | BM25(FTS5)/向量+RRF | BM25 + 短语加成混合排序，回归门禁护栏 |
| 结构化 | 无 | 寄存器表启发式 → JSON | 规划中（启发式、无 LLM） |
| 工具面 | `embed_datasheet` 单工具 | 3–5 工具 | 4 工具（registers 未实现先报 not_available） |
| 缓存 | `.prometheus/datasheets/` | 各自私有 | `.datasheet-mcp/`，策略同 A |