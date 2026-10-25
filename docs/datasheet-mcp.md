# Datasheet MCP 设计文档

> 移植来源：A 仓库 Prometheus `src/embedded/datasheet.ts`（197 行）。
> 施工依据：`docs/datasheet-mcp-todolist.md`（D1–D20）。
> 实现根：`mcp-servers/datasheet/`。

## 1. 定位

把工作区里的芯片数据手册 / 参考手册（PDF）变成可检索、可整页读取、可结构化查寄存器的 MCP 工具。stdio MCP server、纯只读（四个工具全部 `readOnlyHint: true`）、零新 npm 依赖（验收 6：`package.json` 只有 scripts 新增 `datasheet:regression` / `datasheet:corpus`，依赖零变化）、领域代码零进 `src/`（外挂子进程形态，与 kb/keil server 同构）。

环境变量：`DATASHEET_ROOT`（检索根，缺省进程 cwd）、`DATASHEET_CACHE_DIR`（页级缓存，缺省 `<root>/.datasheet-mcp/`）。

## 2. 工具面

| 工具 | 输入 | 作用 | 关键返回 |
|---|---|---|---|
| `datasheet_search` | `{query, limit?}` | BM25 + 整短语加成的混合排序检索 | `found` / `hits[{path,page,excerpt,score}]` / `skipped[]` / `extractor` |
| `datasheet_read` | `{path, page, pageEnd?}` | 整页文本（≤50 页、≤512KiB） | `pages[{page,text}]` / `total` / `truncated` |
| `datasheet_registers` | `{query}` 或 `{path, page?}` | 结构化寄存器表（启发式提取） | `tables[{name,peripheral?,offset?,resetValue?,bits[],sourcePage,confidence}]` |
| `datasheet_status` | `{}` | 提取器/缓存/文件统计 | `root` / `extractor` / `cacheDir` / `cacheEntries` / `fileCount` / `scanTruncated` |

错误码：`invalid_argument` / `path_denied` / `not_found` / `file_too_large` / `extractor_missing` / `no_text_layer` / `extract_failed` / `page_out_of_range` / `page_range_too_large` / `empty_query`。

## 3. 架构与缓存策略

- `pdf.ts`：`pdftotext -v` 探测（`-v` 恒非零退出码，ENOENT 才是「没装」）+ `-layout` 提取（120s 超时、64MiB buffer）。`-layout` 保留列对齐。
- `cache.ts`：键 = sha1(绝对路径) 前 16 位；stamp = `mtimeMs:size`；`empty: true` 标记无文本层（扫描件不反复重提取）。写失败静默（缓存丢失只损时间不损正确性）；写目标恒限缓存目录内（越界显式拒绝）。
- `service.ts`：遍历（≤6 层 / ≤200 文件 / >80MiB 跳过 / 跳 `.` 目录与 node_modules，`scanTruncated` 报下界）+ 检索 + 整页读 + 寄存器查。
- `bm25.ts`：零依赖手写 BM25（k1=1.2, b=0.75）+ 短语命中加成（+4）。
- `registers.ts`：启发式寄存器表提取（§5）。
- `regression-gate.ts` + `scripts/datasheet-regression.mjs` + `scripts/datasheet-corpus.mjs`：回归门禁。

缓存目录 `.datasheet-mcp/` 在遍历跳过清单内（`.` 开头规则，防自吃）；可用 `DATASHEET_CACHE_DIR` 挪到 `$HARNESS_HOME`。删缓存重查行为一致——缓存纯加速。

## 4. 检索设计与诚实边界

三条 A 侧继承 + 三条 B 侧新增：

**继承（A 的原话语义）**：
1. 提取器缺失 → 显式错误 + 安装指引（winget / MiKTeX 两条路），不返回看似「无命中」的空结果；`datasheet_status` 附 `installHint` 但不报错（如实报告状态是本职）。
2. 扫描件 → skipped 报「无文本层」，缓存 `empty` 标记防反复重提取。
3. 空查询不碰盘直接返回。

**新增**：
1. **混合排序**（D10/D13）：BM25（词频-逆文档频，稀有术语权重高）+ 整短语子串加成（短语命中稳赢分词命中）。A 的整短语匹配在「查询词被排版拆开」（`USB_BCDR` 拆成 `USB_ BCDR`）时失效；BM25 分词恰好补此短板。
2. **术语映射**（D11）：`TERM_SYNONYMS` 30 条（`alternate function`↔`AF`、`reset value`↔`复位值`），查询含一侧追加另一侧 token——中文查询打英文手册的主要通路。
3. **词边界拒答**（负例防线）：查询的每个 token 都必须在至少一份文件里**按词边界**出现，否则整条查询如实返回无命中。实测把关：`GPIO_CRLX`（crlx 零出现）拒答；`GPIO_ODRX`（文档通配记号 ODRx 真出现）不拒——文档自己的记号是真命中。

**如实披露的已知局限**：
- 跨外设撞名：`ADC_CR3` 命中 USART_CR3 的页（`CR3` token 真实存在，词袋模型无法区分外设归属）。回归负例集 n08 长期跟踪，误报 1/25。
- 位域描述可能被表格换行拆断（`-layout` 的列保持不完美）；工具描述写死「引用寄存器事实前必须 datasheet_read 核对原文」。

## 5. 寄存器表启发式提取（阶段 C）

依赖三个稳定版式（RM0008 Rev21 / RM0090 Rev22 实测同构，**实测校准，非想象**）：

1. 标题行 `Xxx register (REG_NAME)`（括号内全大写标识符；目录行带点线页码、页眉行含文档号 `RM0\d{3}`，显式排除——页眉行尾常是章节名的 `(USB)`，会抢占真标题，这是实测抓出的缺陷）；
2. 元信息行 `Address offset: 0x..` / `Reset value: 0x..`（复位值保留 `0x0000 0000` 空格分组形态）；
3. 位域行 `Bit 15 CTRM: desc` / `Bits 2:0 LATENCY: desc` / `Bits 26:24 SWJ_CFG[2:0]: desc`——**逐行正则即可，不需要列对齐推断**（列对齐只影响位号图，不影响位域行本身）。

置信度门槛（identifyGate 哲学，宁缺毋滥）：≥2 位域、msb ≤ 31、**分段降序**（≤2 段：AFIO_MAPR 这类「密度变体」表两段各自从高位开始——实测抓出的第二处版式事实）、段内位名不重；加分项 offset(+2)/reset(+1)/标题(+1)/desc 齐备(+1)，门槛 3 分。

实测质量（RM0008）：143 表 / 130 唯一名；USB_CNTR 逐位与手册一致（CTRM bit15 "Correct transfer interrupt mask" … FRES bit0 "Force USB Reset"，offset 0x40，reset 0x0003）；AFIO_MAPR 完整（0x04 / `0x0000 0000` / 36 bits 两段）。

**`verify_register_write` 不做**（D16 spike 结论，2026-10-24）：reserved 位域在 -layout 文本里只有 1/1143（Reserved 位通常无位域描述行，只在位号图里）；reserved 写 1 检测的核心原料缺失，补齐需列对齐解析（列拆行错位风险正是 todolist 预判的风险）。按 todolist §3「spike 不过就放弃，不硬上」执行。

## 6. 回归门禁（阶段 B）

- 语料：RM0008 Rev 21 + RM0090 Rev 22，sha256 钉死（哈希不符拒绝跑批）；ST 版权材料，`corpus/` gitignore，`scripts/datasheet-corpus.mjs` 下载（出网走本机代理）。
- 查询集：50 金查询 + 25 负例（`data/`，自造标注入库）。
- 基线（2026-10-24）：R@2 1.0 / Hit@1 1.0 / MRR 1.0 / 误报 1/25（n08 ADC_CR3 撞名）。**R@2 = 1.0 的口径**：gold 取自首跑 top-1（自标注）——门禁防的是未来退化，不是独立人工标注的绝对质量；todolist 的「R@2 ≥ 0.5 起步」线远已超过。
- `npm run datasheet:regression`：跑批 + 与 `tests/regression-baseline.json` 比较，指标退步 exit 1；`--update-baseline` 重标。
- `tests/regression.test.ts` 缺语料整组 skip（对齐 kb 先例）。

## 7. 与 A 及业界方案的差异（含 todolist §0 对照）

| 能力 | A（datasheet.ts） | 业界 | 本目录 |
|---|---|---|---|
| PDF 解析 | `pdftotext -layout` | MinerU(+VLM)/pdfjs-dist | 同 A；扫描件如实报无文本层 |
| 检索 | 子串匹配，页级 excerpt | BM25(FTS5)/向量+RRF | BM25 + 短语加成混合排序 + 词边界拒答 |
| 结构化 | 无 | 寄存器表启发式→JSON | 位域行启发式（非列对齐），置信度门槛 |
| 工具面 | `embed_datasheet` 单工具 | 3–5 工具 | 4 工具 |
| 缓存 | `.prometheus/datasheets/` | 各自私有 | `.datasheet-mcp/`，策略同 A |
| verify_register_write | 无 | atillab1 有 | **不做**（spike：reserved 位原料缺失） |

**明确不做**（todolist §3 全部执行）：向量嵌入/Qdrant/LanceDB（零依赖原则）、VLM 表格理解（扫描件如实报）、在线下载厂商 PDF（内核不触网；`lookup_doc` 式「无结果给厂商链接」未抄——语料由用户放置的形态下该提示意义有限）。

## 8. 与 todolist 的实测偏差（不静默改设计，逐条披露）

1. **验收 2 的示例查询 `USB_BCDR` 在语料中不存在**：RM0008 Rev 21 与 RM0090 Rev 22（当前 ST 官网最新版）均无此寄存器（RM0008 的 USB 寄存器仅 CNTR/ISTR/FNR/DADDR/BTABLE/EPnR）。实测替代：`USB_CNTR`→RM0008 p642（结构化提取逐位一致）、`AFIO_MAPR`→p184。`USB_BCDR`/`USB_EPR` 收入负例集（实证不存在）。
2. **D6 的「registers 先返回 not_available」在交付时已被 D15 转正取代**（阶段 C 同轮完成）。
3. **「写入前显式拒绝越界」落实为**：缓存写目标恒为 `<cacheDir>/<hex16>.json`，store 前显式校验 dirname；cacheDir 必须解析为绝对路径。
4. **`datasheet:regression` / `datasheet:corpus` 两个 npm script 是 package.json 的仅有变化**（todolist D12 自己要求，验收 6 的「零新依赖」不受影响）。
5. 负例误报实测 1/25（≤2 达标），唯一误报 ADC_CR3 是跨外设撞名（§4）。

## 9. 接线

`mcp.json` 示例（B 仓库无集中预设注册点，README 同款）：

```json
{ "mcpServers": { "datasheet": { "command": "node", "args": ["dist-mcp/datasheet/server.js"] } } }
```

改动工具面后须 `npm run build:mcp`（`dist-mcp/` 不入库、无热重载）。

## 10. 测试

95 例（pdf 5 / cache 7 / bm25 10 / service 31 / registers 18 / tools 24），行覆盖 93.65%。fixture PDF 由 `tests/fixtures.ts` 手写生成（最小合法 PDF，文本层 + 纯图两形态）；真实提取用例在有 pdftotext 的机器跑、无提取器机器 skip；真实语料回归（RM0008/RM0090）缺语料 skip。