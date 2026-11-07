# Datasheet MCP 移植（Prometheus → Embedded-Ai-Master）

主线：把 A 仓库 `src/embedded/datasheet.ts`（197 行）的 PDF 手册检索能力重做成独立 MCP server `mcp-servers/datasheet/`。施工依据：工作区外 todolist（阶段 A–D，D1–D20）。

## 2026-10-25 阶段 A 完成（D1–D9）

- **调研**：逐行读 A 实现；抓取三个业界方案 README（hungnguyen1503/datasheet-mcp：3 工具 + gaps 显式报告 + golden retrieval gate；atillab1：verify_register_write 查 reserved 位/魔数/整字赋值；flaco-source/mcp-docs：FTS5+BM25、read_doc_page 页范围、lookup_doc 无命中给厂商链接）。todolist §0 差距判定与实际相符。走 clash 代理（7897）抓取。
- **产出**：`pdf.ts`（探测/提取，A 1:1 + env 注入位）、`cache.ts`（sha1 键 + stamp + empty 标记 + 越界显式拒绝）、`service.ts`（list/search/readPages/status，A 语义 + 新增 readPages ≤50 页 ≤512KiB）、`tools.ts`（4 工具 KbToolSpec 式）、`server.ts`（照 kb 骨架）、README、permissions.example.json。
- **测试**：56 例（pdf 5 / cache 7 / service 29 / tools 15）。fixture PDF 手写生成（最小合法 PDF，文本层 + 纯图两形态），本机 pdftotext 4.00 实测提取通过；无提取器机器上相关组 skip。
- **被测试抓出的两个实现缺陷（已修）**：
  1. walkPdfFiles 用 generator 时「预算截停」标志丢失 → scanTruncated 永假；改为返回 `{files, truncated}`。
  2. pdftotext 在最后一页后也输出 `\f`，split 后尾空段使 total 多一页 → readPages 页码与阅读器不一致；indexFile 丢弃尾空段。
- **实现期决策**：
  - 「写入前显式拒绝越界」落实为：缓存写目标恒为 `<cacheDir>/<hex16>.json`，store 前显式校验 dirname；cacheDir 必须解析为绝对路径否则构造抛错。
  - search 在提取器缺失时：保留 A 的 skipped 安装指引，**另置 isError: true + code extractor_missing**（验收 3「明确错误而非空结果」；B 有结构化错误通道，比 A 的纯文本 skipped 更强）。status 不报错但附 installHint（如实报告状态是本职）。
  - empty 查询照 A：不碰盘直接返回（service 层 empty_query 不抛，返回空集）。
- **验证**：`npx vitest run mcp-servers/datasheet` 56/56 过；`npm run typecheck` 报错全部为既有基线（cubeide 2 + keil 4，datasheet 零错误）；`npm run build:mcp` 过（dist-mcp/datasheet/ 5 个 js）；`npm test` 全仓 2954 passed / 3 failed（skills-store EPERM ×2 + kb-review 数据集 ×1，均为既有环境问题，非本次引入）。
- 用户约束：外网走 clash；未经允许不推远端；禁止合并远端。
## 2026-10-25 阶段 B/C/D 完成（D10–D20）

- **阶段 B（检索质量）**：`bm25.ts` 零依赖手写 BM25（k1=1.2/b=0.75）+ 整短语加成（+4）混合排序；`TERM_SYNONYMS` 30 条中英同义词；**词边界拒答**（查询全部 token 至少在一份文件按词边界出现，否则如实无命中）。测试抓出的两个实现缺陷：①「最长 token 锚」在等长时选到泛词（GPIO_CRLX 锚成 gpio），改全部 token AND 语义；②词边界正则漏 `i` 标志（小写 token 匹配不到大写原文，45 条正查询被误杀）。最终负例误报 1/25（唯一误报 ADC_CR3 跨外设撞名，词袋固有局限，README/设计文档披露）。
- **回归门禁**：语料 RM0008 Rev21 + RM0090 Rev22（sha256 钉死，corpus/ gitignore + 下载脚本）；50 金 + 25 负（data/ 自造标注入库）；基线 R@2 1.0 / Hit@1 1.0 / MRR 1.0 / 误报 0.04；`npm run datasheet:regression` PASS。
- **阶段 C（结构化）**：`registers.ts` 位域行启发式（`Bit n NAME:` 逐行正则，不做列对齐）。实测校准抓出四个版式事实：①页眉行尾 `(USB)` 会抢占真标题（含 `RM0\d{3}` 的行不当标题）；②`SWJ_CFG[2:0]:` 位名带位宽注记；③复位值 `0x0000 0000` 空格分组；④AFIO_MAPR 密度分段表两段各自从高位开始（降序校验改分段 ≤2 段）。实测 RM0008 提取 143 表，USB_CNTR/AFIO_MAPR/USART_SR 逐位与手册一致。
- **D16 spike → 放弃**：reserved 位域仅 1/1143（Reserved 位无位域描述行，只在位号图里）——verify_register_write 的核心原料缺失；补齐需列对齐解析（todolist 预判的列拆行风险）。按 todolist §3「spike 不过就放弃」执行，结论记入设计文档 §5 与 D-207。
- **阶段 D**：设计文档 `docs/operations/datasheet-mcp.md`（含 todolist §0 对照表 + 8 条实测偏差披露）；deferred-issues 录入 D-207 + 变更日志；rag-vs-agentic-search-todo §5 加关联行；MCP 注册示例在 README（B 无集中预设注册点，D18 条件分支不适用）。
- **验收偏差（向用户如实披露）**：验收 2 的 `USB_BCDR` 在 RM0008 Rev 21 / RM0090 Rev 22 均不存在（ST 当前最新版都没有 USB BCD 章节），实测替代 USB_CNTR→p642 / AFIO_MAPR→p184，USB_BCDR/USB_EPR 收入负例集作实证。
- **最终验证**：datasheet 95/95、行覆盖 93.65%、typecheck 零新增错误、build:mcp 产物 8 个 js、全仓 npm test 2992 passed / 4 failed（skills-store EPERM ×2 + kb-review 数据集 ×1 均为既有环境问题；mcp-manager 并发用例单跑 36/36 绿，全量并行下的负载偶发，与 datasheet 无关）。
- **翻车与返工**：bash 双引号里的 python 脚本含 Markdown 反引号被命令替换执行（AGENTS.md 2026-10-19 事故的第三次重演，本轮发生两次：node -e 的 String.raw 与 dev-notes 追记），均改用 Edit 工具/独立文件修复；教训：**含反引号的文本一律走 Write/Edit 工具，不走 bash 内联脚本**。python 补丁 `\n` 转义把测试文件写坏两次，均以 assert + Edit 修复。
