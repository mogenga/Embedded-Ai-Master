# 数据手册 MCP Server 移植 Todolist(Prometheus → Embedded-Ai-Master)

> 状态:待执行。目标:把 A(`Prometheus/src/embedded/datasheet.ts`,197 行)的 PDF 手册检索能力按 B 的架构原则重做成独立 MCP server `mcp-servers/datasheet/`。
> 方法:逐行读 A 实现 + 调研业界三个同类方案([hungnguyen1503/datasheet-mcp](https://github.com/hungnguyen1503/datasheet-mcp)、[atillab1/embedded-ai-workspace/datasheet-mcp](https://github.com/atillab1/embedded-ai-workspace/tree/main/datasheet-mcp)、[flaco-source/mcp-docs](https://github.com/flaco-source/mcp-docs))定差距。

## 0. 三方对照:我们站在哪里

| 能力 | A(datasheet.ts) | 业界方案 | B 首期定位 |
|---|---|---|---|
| PDF 解析 | `pdftotext -layout`(poppler),纯文本层 | MinerU(+VLM 表格)/pdfjs-dist | **pdftotext,同 A**;扫描件如实报"无文本层" |
| 检索 | 子串匹配,页级 excerpt | BM25(FTS5)/向量(Qdrant/LanceDB)+RRF 融合 | **先子串,Phase B 升 BM25**——与 kb/index.yaml 同一套朴素起步、回归门禁护航的路线 |
| 结构化 | 无 | 寄存器表启发式解析→registers.json(atillab1 四阶段管线②) | Phase C 启发式寄存器表提取(无 LLM) |
| 工具面 | `embed_datasheet` 单工具(query/limit) | 3–5 工具:catalog/query/get、lookup/search/read/query/page、search/get_register/verify_write | 4 工具:search/read/search_registers/status |
| 缓存 | `.prometheus/datasheets/`,mtime+size 失效,sha1 键 | 各自私有 | 同 A 策略,缓存目录改 `.harness/` 下 |
| 诚实性 | 缺提取器给安装命令、扫描件记 `empty` | gaps 显式报告(hungnguyen) | 全盘继承 A 的两条 + gaps 风格 |

**B 原则落点**(与 kb server 完全同构):stdio MCP、zod 严格 schema、`KbToolSpec` 式工具声明、写前声明/审计不涉及(纯只读)、`permissions.example.json` 模板、vitest 覆盖率 85%、领域代码零进 `src/`。

## 1. 目标形态

```
mcp-servers/datasheet/
├── server.ts        # McpServer + StdioServerTransport + isEntryPoint(照 kb/server.ts)
├── tools.ts         # 4 个工具声明 + zod schema(KbToolSpec 式)
├── service.ts       # 核心:提取器探测/索引/检索/寄存器表
├── pdf.ts           # pdftotext 封装(findPdfExtractor + extract,-layout,-timeout 120s)
├── cache.ts         # 页级 JSON 缓存(sha1 16位键 + mtime:size stamp)
├── registers.ts     # Phase C:寄存器表启发式解析
├── permissions.example.json
└── tests/           # service/pdf/cache/registers/tools 五组
```

环境变量:`DATASHEET_ROOT`(检索根目录,缺省 `process.cwd()`)、`DATASHEET_CACHE_DIR`(缺省 `<root>/.datasheet-mcp/`,写入前显式拒绝越界)。

构建/测试:零配置变更——`tsconfig.mcp.json` 已含 `mcp-servers/**`,vitest 已含 `mcp-servers/**/*.test.ts`。

## 2. 执行清单

### 阶段 A:基础检索(对齐 A 的能力,1:1 重写成 B 形态)

- [ ] **D1** `pdf.ts`:`findPdfExtractor()`(探测 `pdftotext -v`,ENOENT→null)+ `extract()`(`-layout`、120s 超时、64MiB buffer)。照抄 A 的注释要点:`-v` 恒非零退出码,信号是"可执行文件是否运行"。
- [ ] **D2** `cache.ts`:页数组 JSON 缓存。键 = sha1(绝对路径)前 16 位;stamp = `mtimeMs:size`;`empty: true` 标记无文本层。写失败静默(缓存丢失只损时间不损正确性)。
- [ ] **D3** `service.ts` `listDatasheets()`:递归 ≤6 层、≤200 文件、>80MiB 跳过、跳 `.` 与 `node_modules`。返回 `{path, pages?, skipped?}` 元数据,不提取——列目录不应触发 30 秒的提取。
- [ ] **D4** `service.ts` `search()`:大小写不敏感整短语匹配,每页至多一 hit,excerpt 前后 120/200 字符,limit 缺省 12。`skipped[]` 带原因:提取器缺(附 winget 安装命令)/文件过大/无文本层(扫描件)。**这是 A 诚实性设计的核心,原样保留**。
- [ ] **D5** `service.ts` `readPages()`:按 path+页范围返回整页文本(A 没有的,业界全部有——检索命中后读上下文是刚需;单次 ≤50 页、≤512KiB 截断,对齐 B 的输出限额惯例)。
- [ ] **D6** `tools.ts` 四工具:
  - `datasheet_search {query, limit?}`(只读)
  - `datasheet_read {path, page, pageEnd?}`(只读)
  - `datasheet_status`(只读,Phase B 预留返回提取器/缓存统计)
  - `datasheet_registers`(Phase C 实现,先注册返回 `not_available` 明确错误——**不伪造**)
- [ ] **D7** `server.ts`:照 kb/server.ts 骨架注册四工具 + `isEntryPoint` + stdio transport。
- [ ] **D8** 测试:pdf 探测(假 PATH)/缓存 stamp 失效/empty 标记/search 的 skipped 理由/excerpt 边界/readPages 截断与越界。fixture PDF 手工生成一份文本层 PDF + 一份纯图 PDF 入 `tests/fixtures/`(不入库的生成脚本写在 tests 内 setUp 里跑 pdftotext 反向生成,确保 CI 可跑)。
- [ ] **D9** README.md(照 kb/README.md 风格:定位、安装 pdftotext 的两种途径、工具表、诚实边界)+ `permissions.example.json`(全部只读,demo 用)。

### 阶段 B:检索质量升级(BM25,对齐 kb 的既有路线)

- [ ] **D10** `service.ts` 检索升级为 BM25:页级 token 化(小写、按非字母数字切分、可停用词表为零起步)。**不引第三方依赖**——B 零依赖现状,~80 行手写 BM25,kb/index.yaml 的打分函数同款风格。
- [ ] **D11** 术语映射:查询先做领域同义词展开(`alternate function`↔`AF`、`reset value`↔`复位值`)。放 `service.ts` 常量表,20–40 条起步。
- [ ] **D12** 回归门禁:照 `mcp-servers/kb/regression-gate.ts` 模式建 `regression-gate.ts` + 基线 JSON + `npm run datasheet:regression` 脚本。语料用 1–2 份公开 ST 参考手册(RM0008/RM0090,许可允许再分发则入库,否则 gitignore + 下载脚本)+ 50 条金查询(寄存器名/位域名/章节标题)+ 25 条负例(不存在的寄存器)。基线指标:R@2 ≥ 0.5 起步(业界向量方案在 0.6–0.8,B 的朴素方案先立门槛再爬坡)。
- [ ] **D13** 混合排序:BM25 分 + 子串命中加成(整短语命中应稳赢分词命中)。RRF 融合是业界标配,但两条信号足够,不引重排模型。

### 阶段 C:结构化提取(启发式,无 LLM——atillab1 管线②的路数)

- [ ] **D14** `registers.ts`:页文本中识别寄存器表(ST 格式:`0xOffset` 列 + 寄存器名列 + 位域表 `bits [msb:lsb]`)。启发式正则 + 列对齐启发,输出 `{peripheral?, name, offset?, resetValue?, bits: [{name, msb, lsb, desc?}]}`。**只有解析置信度高才产出**,低于阈值宁缺毋滥(A 的 identifyGate 哲学)。
- [ ] **D15** `datasheet_registers` 工具转正:按 `{query}`(寄存器名模糊匹配)或 `{path, page}`(指名页)返回结构化结果 + 来源页。复用 D4 检索定位候选页。
- [ ] **D16** `verify_register_write` 评估(业界亮点,可选):输入 C 代码片段,对照提取出的寄存器表检查 reserved 位写 1/魔数偏移/整字覆盖。**先做可行性 spike 再决定是否立项**——启发式解析的假阳性会直接误导用户,若 D14 置信度不够就不做。

### 阶段 D:接线

- [ ] **D17** `docs/datasheet-mcp.md` 设计文档(定位/工具表/缓存策略/诚实边界/与 A 及业界方案的差异表,含本文件的对照表)。
- [ ] **D18** mcp.json 预设模板:写进 README 的 `{ "mcpServers": { "datasheet": { "command": "node", "args": ["dist-mcp/datasheet/server.js"] } } }` 示例;若 keil/cubeide 的预设模板机制有集中注册点,同步加。
- [ ] **D19** 测试补齐到 85% 覆盖率;`npm run typecheck` + `npm run build:mcp` 过;`npm test` 全绿。
- [ ] **D20** deferred-issues 登记:渲染层隐藏清单中与 PDF/数据手册相关的入口(如有)标记解决路径;`docs/rag-vs-agentic-search-todo.md` 若与此相关,加一行链接。

## 3. 明确不做的

- **向量嵌入/Qdrant/LanceDB**(hungnguyen、atillab1 路线):引入嵌入模型下载 30MB–数百 MB、GPU 依赖或大依赖树,违背 B 零依赖与"语料本地可控"原则;BM25 + 短语匹配对"寄存器名是精确标识符"这一领域特性已足够,且回归门禁给了量化的爬坡路径。
- **VLM 表格理解/图片描述**(MinerU hybrid):同上,且扫描件场景 B 如实报"无文本层"。
- **在线下载厂商 PDF**(flaco-source 的 Provider 类):网络获取超出 B 的"内核不触网"习惯,语料由用户放进工作区;`lookup_doc` 式"无结果时给厂商链接"倒是可以抄(一行 skipped 理由增强)。
- **verify_register_write 强承诺**:D16 spike 不过就放弃,不硬上。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| CI/无网环境无 pdftotext | D8 测试全部走"探测失败→skipped 理由"路径断言,不 require 提取器;fixture 生成脚本检测 pdftotext 不在则 skip 整组(对齐 kb 语料 gitignore 的既有先例 D-158) |
| pdftotext Windows 安装门槛 | README 给 winget/MiKTeX 两条路(A 的原话);未来 packs server(T5 裁剪项)可加一个 poppler 包,留 TODO 关联 |
| -layout 模式对表格的列破坏 | Phase C 启发式以"列对齐"为输入,-layout 恰好保留列;但须在 D14 用 RM0090 实测校准正则,不以想象写 |
| 缓存目录写进用户工作区 | `.datasheet-mcp/` 显式列进 D3 的跳过清单(防自吃);README 说明可 `DATASHEET_CACHE_DIR` 挪到 `$HARNESS_HOME` |
| 寄存器启发式假阳性 | D14 置信度门槛 + D12 回归金查询集直接覆盖寄存器类查询,基线不达标不转正 |

## 5. 验收标准

1. `npm test` 全绿,datasheet 组用例 ≥ 25,总覆盖率 ≥ 85%;
2. 对 RM0008(STM32F1)实测:`datasheet_search "USB_BCDR"` 命中正确页码,`datasheet_read` 能取整页,`datasheet_registers "USB_BCDR"`(Phase C 后)返回的结构与手册原文一致(offset/复位值以手册为准,验收时逐位核对,金查询集入库时同步记录期望值);
3. 无 pdftotext 环境:四工具全部返回含安装指引的明确错误,而非空结果;
4. 扫描件 PDF:search 的 skipped 列出"无文本层",后续查询不反复重提取(缓存 empty 标记生效);
5. BM25 升级后回归基线 R@2 达标且负例误报 ≤ 2 条;删缓存目录再查,行为一致(缓存纯加速);
6. 零新 npm 依赖(package.json diff 无变化)。
