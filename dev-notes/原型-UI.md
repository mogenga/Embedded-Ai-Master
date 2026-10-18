# 原型 UI（prototypes/）

## 2026-10-15 · 产品原型（HTML）首版

- **用户关键原话**："制作产品原型（HTML）……参考 Codex 桌面端应用的布局，右侧需额外预留各类嵌入式开发调试窗口（按需展开）……支持日、夜、随系统设置三类主题色……不得使用任何 EMOJI 作为 UI……必须进行视觉对齐"；追问澄清后补充："知识库应该在左侧侧边栏，会话的上方。右侧至少包括：设备监控、端口设置、调试日志等"、"单开一个 prototypes 目录"。
- **关键产出**：`prototypes/index.html`（单文件，内联 CSS/JS，零外部依赖，双击可开）。布局取自 Codex 官方文档首页的真实结构（左栏 New chat / Pinned / Projects / Recents + 中间对话 + 底栏输入），左栏改造为「知识库在上、诊断会话在下」，右栏为可折叠调试坞。
- **被拒绝或纠偏**：初版把知识库一并塞进右侧调试坞，被用户纠偏为左栏顶部、置于会话列表之上。
- **翻车与返工**：
  1. 左栏 `.pane-head` 被 flex 压缩成 20px，与中/右栏 40px 顶部行不齐（视觉对齐失败）→ 补 `flex:0 0 40px`；
  2. 知识库树因 `flex-basis:0` 被压扁到 174px 只露 5 行 → 改为 grid `minmax(0,58%)` 固定分区 + 头部 sticky；
  3. 本机 git-bash 的 `sed` / `which` 会挂起 → 文本替换统一改用 Node。
- **验证方式**：本机 Chromium（无头）注入探针实测几何量——三栏头部 y=48 / h=40 一致、内容宽 874 与头部内边距对齐、无横向溢出、无文本截断；三主题 computed 颜色正确（含 system 随 `prefers-color-scheme` 解析）。

## 2026-10-15 · 缺陷修复：夜间滚动条未适配

- **用户关键原话**："问题：夜间模式滚动条未做适配"。
- **关键产出**：`prototypes/index.html` 新增 `--scroll-thumb` / `--scroll-thumb-hover` / `--scroll-track` 三个变量（dark / light / system 三处各一份，track 透明），并加全局滚动条规则：标准属性 `scrollbar-color` + `scrollbar-width:thin` 与 `::-webkit-scrollbar` 伪元素双写（现代 Chromium / Firefox 走标准属性，旧 Chromium 与 Safari 走伪元素，渐进增强）。
- **验证方式**：无头实测 dark thumb `rgb(47,61,75)`、light thumb `rgb(198,208,217)`、track 透明、width `thin`、滚动条实占 10px；三栏头部仍均 40px，无横向溢出与文本截断。
- **翻车与返工**：无。

## 2026-10-18 · 前端决策讨论与 OPEN-UI-02 落地

- **用户关键原话**："带决策项讨论讨论"；逐项拍板：前端框架 = Preact + Vite、实时通道 = SSE + HTTP POST、`LoopEvent.tool_result` = 立即扩展。
- **关键产出**：
  1. `docs/frontend-design.md` v1.1：6 项 OPEN-UI 全部关闭（04 波形不做、05 虚拟滚动设触发条件、06 fork 仅派生入口）；§2 技术约束补 Preact + Vite 与 SSE + HTTP POST；§8.5 改为"已决"并写明实施要求。
  2. `src/loop/events.ts`：`tool_result` 改为 `{ kind: "tool_result" } & ToolResultPayload`。
  3. `src/loop/query.ts`：新增 `toLoopToolResult()`，替换 aborted 与正常分支两处 yield，使实时事件与会话落盘由同一份字段构造。
  4. `tests/query.test.ts`：新增"tool_result 事件透传结构化 detail 与 artifactPath"用例；同步 3 处严格 `toEqual` 断言补 `code`。
- **被拒绝或纠偏**：无；用户未采纳原生 TS 方案，改选 Preact + Vite。
- **翻车与返工**：先前用 `grep ... | head -20` 排查测试影响面时被截断，误判"tests 无形状断言"；实际有 3 处 `toEqual`，扩展字段后必须同步更新——说明影响面核验不能依赖截断输出。
- **验证**：`npm run typecheck` 通过；`npm test` 14 passed / 1 skipped，265 tests passed。

## 2026-10-18 · 原型落地为前端设计文档

- **用户关键原话**："把产品原型落地为前端设计文档"。
- **关键产出**：`docs/frontend-design.md` v1.0，共 14 章——目标与范围、技术约束（内联完整技术栈）、信息架构、布局与栅格、设计令牌、主题系统、15 个组件规格、数据契约与状态投影、交互规范、可访问性、响应式、14 项可量化视觉验收、6 项待决策。
- **关键决策**：前端框架尚未定案（UI 形态决策点仍开放），文档按**框架无关契约**书写，令牌与组件规格与实现框架解耦；核对真实类型 `SessionEvent` / `AssistantPayload` / `ToolResultPayload` / `ToolAnnotations` / `LoopEvent` 后落数据投影表，发现 `LoopEvent.tool_result` 仅含 `{id, ok, text}`、缺 `code`/`detail`/`artifactPath`，登记为 OPEN-UI-02（实时渲染无法复用回放投影）。
- **被拒绝或纠偏**：无。
- **翻车与返工**：无。
## 2026-10-18 · Task 9：SSE 客户端抽象与回放接线

- **用户关键原话**：按 `task-9-brief.md` 实现；"严格 TDD：先写测试 → RED → 实现 → GREEN → 提交"；"无 SSE 环境时以 fixture 回放渲染；不得在无后端时把用户输入静默丢弃"。
- **关键产出**：`src/ui/view/sse.ts`（可注入 `EventSourceCtor`/`retryMs`/`fetchImpl`，非法 JSON 不中断，close 幂等停止重连，非 2xx 抛结构化错误）；`src/ui/main.tsx` 接入 `VITE_EVENT_STREAM_URL` 累积归约与 `VITE_ACTION_URL` 发送；`tests/ui/sse.test.ts` 4 用例。提交 `454afd9`。
- **被拒绝或纠偏**：无用户纠偏。brief 测试的 `FakeES.instances` 未跨用例清理，导致 close 用例期望值错误（实测 3）；补 `beforeEach` 清空并把 close 用例改为等待 10ms 后才断言，未改被测语义。
- **翻车与返工**：首轮 GREEN 未一次达成（3/4），按上述测试隔离与时序问题修正后 4/4；实现本身无需返工。
- **验证**：`tests/ui/sse.test.ts` 4 passed；`tsc -p tsconfig.web.json --noEmit` 0 error；全量 482 passed / 1 skipped；内核 `tsc --noEmit` 0 error；`vite build` 成功。
## 2026-10-18 · Task 10：视觉验收脚本与收尾

- **用户关键原话**：按 `task-10-brief.md` 实现，"它是你的唯一需求来源"；"验收脚本必须用 CDP：静态服务 dist-web → chrome --headless=new … → /json/version 取 webSocketDebuggerUrl → 内置 WebSocket 连 CDP → Page.navigate → Page.loadEventFired → Runtime.evaluate 注入探针 → 逐项断言 V1-V14（V13 由 vitest 覆盖，脚本打印引用）"；"断言 V1-V12、V14 全部输出 PASS 才 exit 0；任一 FAIL exit 1"；"若发现组件/样式几何问题，直接修复 src/ui/styles.css 或组件"；"零新增依赖…不运行 npm install/npx"。
- **关键产出**：`scripts/verify-ui.mjs`（零依赖静态服务 + Chromium 探测 + CDP browser target/session + `Emulation.setDeviceMetricsOverride` 1600×1000 与 717px 工作区 + `Runtime.evaluate` 探针 + Tab 焦点遍历 + 主题媒体模拟；V1-V12/V14 逐项 PASS/FAIL，V13 打印 vitest 引用；找不到浏览器或 `CHROME_PATH` 无效 exit 2）；`theme.ts` 的 `applyTheme` 改为保留 `data-theme="system"` 交由 CSS 媒体查询解析；`styles.css` 补原生表单控件 `:focus-visible` 与 `prefers-reduced-motion` 规则；`tests/ui/theme.test.ts` 增 system 保留用例；设计 v1.2 修正 V2 公式与 V3/V6/V11 口径；`deferred-issues.md` 登记 D-051 ~ D-057。
- **被拒绝或纠偏**：初版 V2 依设计原文"视口 − 664"期望主区 936，实测 932；核实 264 + 404 = 668，判定设计公式为笔误，改文档与断言而非改布局。V6 初版探针取到未展开子树的 `bottom=0`，属假阳性，改为只取厂商分流展开子树的 4 项。V7 的 track 计算值为 `rgba(0, 0, 0, 0)` 而非字面 `transparent`，按透明接受。V3 主区内容宽按滚动条占位扣除后判定（882 = 932 − 40 − 10），已在设计 v1.2 明确口径。
- **翻车与返工**：首轮 5 项 FAIL（V2 口径、V7 透明值、V9 system 态、V11 原生控件焦点、V12 减少动效）。V11 首次只修好 textarea：`.port-grid select:focus` 与新增 `:focus-visible` 规则特异性相同且后置，覆盖了焦点环；把规则移到文件末尾后 41 个控件 0 无环。未改任何布局几何，仅补样式、主题语义与脚本口径。
- **验证**：`npm run typecheck:web` 0 error；`npm run test:ui` 55 passed；`npm run build:web` 成功；`npm run verify:ui` V1-V12/V14 全 PASS；`npm run lint` 0 error；`npm test` 483 passed / 1 skipped；`npm run build` 成功。

## 2026-10-18 · 前端工程 spec/plan 与 Task 1-8 交付

- **用户关键原话**："依据产品原型 prototypes\index.html 和前端设计规范文档 docs\frontend-design.md，推进前端工程任务"。
- **关键产出**：新建 `docs/superpowers/specs/2026-10-18-ui-workbench-design.md`（工程结构、模块边界、类型接线、投影契约、V1-V14 映射、UI-SPEC-01~04 决策）与 `docs/superpowers/plans/2026-10-18-ui-workbench.md`（Task 1-10，TDD）。Context7 查证 Preact preset-vite 配置、jsxImportSource、vitest happy-dom 用法；npm registry 核实版本并确认 Preact v11 仍是开发线、v10.x 为稳定线。交付：脚手架（Vite 根配置 + tsconfig.web + vitest tsx/preact 插件）、主题三态与 30 个 SVG symbol、TranscriptView 归约与 fixture、App 栅格/TopBar/StatusBar、左栏知识库与会话、主区会话头/路径条/消息流、工具卡/判决卡/安全提示、Composer 与调试坞四分区。
- **被拒绝或纠偏**：Preact 不采用 npm latest（11.0.1），坚持 ^10.29.8；组件不使用默认导出（由 Task 11 回填 spec 统一为命名导出）；知识库树与调试坞局部态允许组件内 useState。
- **翻车与返工**：Task 1 首版 smoke 测试用 `.ts` 承载 JSX，导致 tsc 解析失败（TS1005），改名 `.tsx`；根 tsconfig 未排除前端导致既有 `typecheck` 回归，且 Vitest 未加载 preact 插件会把 JSX 编译成 react/jsx-runtime——两处在 Task 1 审查后修复（`2d3289a`）；smoke 测试用 `fileURLToPath(import.meta.url)` 在 happy-dom 下报 URL scheme 错误，改为 `path.resolve(process.cwd(), ...)`（`390b9b4`）。Task 6 首次派发子代理异常中止无产出，重新派发后完成。
- **验证**：Task 1 完成后全量 438 passed / 1 skipped；Task 8 后 478 passed / 1 skipped；typecheck 与双构建通过。

## 2026-10-18 · 第一轮整体审查与修复

- **用户关键原话**："推进前端工程任务"；既定要求按 Superpowers 流程两轮审查核验。
- **关键产出**：独立整体审查（契约与设计一致性）结论 BLOCK，提出 5 项 P1：V13 恒真断言、verify-ui 的 finally 吞退出码、R2 写内存无确认入口、工具结果丢失 text/artifactPath、status/usage/context/cost 未投影；另有 10 项 P2 与多项 Minor。修复落为 plan Task 11：投影补齐 text/artifact/pending/status/usage/cost、GuardNotice 确认与拒绝入口（确认后仅"执行中"）、复位确认展示 `AIRCR @ 0xE000_ED0C = 0x05FA_0004`、StatusBar 接线、PathLine 10px、checkpoint 真实事件断言、主题测试拆分、首屏主题值校验、verify-ui 退出码必经、V13 改为检查一致性测试文件。提交 `2d483f0`。
- **被拒绝或纠偏**：不允许把"等待工具结果"渲染成"已执行"；不允许 V13 硬编码 PASS；Dock/回放按钮等未实现项改为登记（D-058~D-061）而非假装完成。
- **翻车与返工**：第一轮审查实测发现 verify-ui 在 `%TEMP%` 清理失败时走 `catch { return }`，导致无 SUMMARY 且失败退出被吞——属真实假绿路径，修复后复现为挂起（探针证明）。全量由 483 增至 513 passed / 1 skipped。

## 2026-10-18 · 第二轮红队审查与修复

- **用户关键原话**：按既定两轮审查流程推进。
- **关键产出**：红队审查结论 PASS_WITH_CONCERNS。6 个变异探针全部被杀（costUsd 累加、status 分支、text-only 回退、pending、verify-ui finally return、GuardNotice 直接置已执行），7 次还原均逐字一致。发现 4 项 P2：artifact-only 结果被投成 empty_result、SSE 重复 error 并发重连（实测 3 实例）、超长 text 折叠摘要仍渲染全首行、loop costUsd 未做有限数校验；另 4 项 Minor。修复落为 plan Task 12：artifact 保留 readout、SSE 单 timer 去重与 close 静默/构造异常转 onError、折叠摘要截断 120 字符、`asCost` 统一校验、清理 styles.css 重复 `.dock` 与重复 media 查询；Usage 缺字段补 0 登记 D-062。提交 `f34f696`。
- **被拒绝或纠偏**：未改 usage 缺字段补 0 的语义（仅登记）；未提交工作区既有的 README.md 无关改动。
- **翻车与返工**：无生产逻辑返工；Task 12 首跑 RED 9 failed 后一次转绿。全量 522 passed / 1 skipped；V1-V14 全 PASS。

## 2026-10-18 · 用户要求不要 mock 数据：真实数据链路与验收改造

- **用户关键原话**："把验收脚本改为真实数据服务链路，并更新文档"；"验收使用真实临时会话文件（header.json + session.v1.jsonl），不得向前端注入数据"；"临时目录清理失败只 warning，不得影响 SUMMARY 与退出码（Task 11 已修的假绿路径不能回归）"；"前端从 `/api/*` 加载真实数据；删除全部演示数据；无会话/无 KB/设备 unknown 显示空态；未配置 `VITE_ACTION_URL` 时发送禁用"。
- **关键产出**：
  1. `scripts/verify-ui.mjs` 删除静态 serve，改为「临时 `HARNESS_HOME`（真实 `header.json` + `session.v1.jsonl`，含 user / assistant ask / tool_call / tool_result（readout+evidence）/ verdict / guard / usage / status）+ 真实 KB 目录 → 启动 `dist/server/serve.js` → 轮询 `/api/sessions` → CDP 验收 → 关闭服务 → 清理」；V14 断言真实 guard 四要素（写入 / 0x40004408 / 0x0009 / 待确认）；新增 V0 空态附加检查（空 `HARNESS_HOME` 下「暂无会话」「未配置知识库」，不计入 14 项）；清理失败仅 warning，不改变 SUMMARY 与退出码。
  2. `README.md` Web 工作台改为真实数据启动流程（`build` + `build:web` + `serve:ui`）、`HARNESS_UI_PORT` / `HARNESS_HOME` / `HARNESS_UI_STATIC`、六个 API 端点与 501 诚实边界、空态说明；删除「示例会话 / 回放演示」表述。
  3. `docs/deferred-issues.md`：D-053、D-060 标记已解决；D-058 标记数据来源已解决、设备连接状态仍待 D-052；D-051 补 501 现状；D-059 复核仍存在；新增 D-063（API 只读、actions/events 未实现）、D-064（KB 深度 8 / 条目 2000 静默截断）、D-065（会话列表坏目录 errors 未展示）。
- **被拒绝或纠偏**：不接受「静态 serve `dist-web` + 前端演示数据」的验收方式；不向前端注入会话数据，只通过真实文件与 API 提供；不新增依赖、不跑 npm install/npx、不改 `.superpowers/`。
- **翻车与返工**：V11 首次在真实数据下只遍历到 1 个控件。定位为设备三字段均为 `unknown`，TopBar 前两个 chip 的 `tag|cls|label` 完全相同（`button|chip|未接入`），脚本误判为「Tab 回到同一控件」而提前 break。修复为 FOCUS_PROBE 附带元素坐标并纳入去重 key，复跑遍历 29 个控件、0 个无焦点环。旧版静态验收脚本在同样数据缺失下同样只覆盖 1 个控件，证明这是既有盲区而非本次新引入。
- **验证**：`vitest run`、`tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vite build`、`tsc -p tsconfig.build.json` 全通过；`node scripts/verify-ui.mjs` V1-V14 全 PASS + V0 PASS，SUMMARY 14/14 PASS，exit 0，临时服务与目录已清理。
