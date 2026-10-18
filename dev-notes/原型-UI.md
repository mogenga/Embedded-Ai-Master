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