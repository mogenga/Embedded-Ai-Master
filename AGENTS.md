# AGENTS.md — Embedded-Ai-Master

面向嵌入式调试场景的 agent 工具。当前处于**纯文档规划期**：受版本控制的文件只有 `docs/`（5 篇）、`LICENSE`、`.gitignore`，**无任何代码、构建、测试或 lint 配置**。不要臆造技术栈、包管理器或测试命令。

## 事实源（先读这些，别猜）
- `docs/BRD.md` — 业务需求（领域层 BR-xx / 平台层 PLAT-xx）、硬性规则 R1-R9、路线图 M1-M4。
- `docs/p0-kernel-design.md` — 当前 M1 设计稿（harness 内核六项：主循环 / 模型接入 / 上下文 / 工具系统 / MCP 客户端 / 会话）。
- `docs/framework-architecture-inventory.md` — 框架能力清单 24 项 + 10 个决策点。
- `docs/harness-comparison.md` — Claude Code / dsh / Codex / Gemini CLI / opencode / goose / pi 横向调研。
- `docs/rag-vs-agentic-search-todo.md` — 待办对照实验（决策点 #2 的判据）。

架构为两层：**平台层**（领域无关 harness，模型接入/上下文/工具/会话/权限）与**领域层**（嵌入式调试能力，经 MCP / 插件挂载）。内核代码不得含领域逻辑——嵌入式取证一律走 MCP，不进内核。

## 硬约束（不可违反）
1. **技术栈已定案（2026-10-16，决策点 #1 关闭），完整约束如下**：
   - **语言与运行时**：TypeScript + Node 24（ESM-only，禁止 CommonJS 混用）。本机已具备 Node 24.14.1，package.json 用 `"engines": { "node": ">=24" }` 声明。
   - **协议层（可复用，不得自研）**：MCP 官方 TS SDK v2——`@modelcontextprotocol/client`（CLI 侧客户端）、`@modelcontextprotocol/server`（MCP server 入口）、`@modelcontextprotocol/server/stdio`（stdio 传输）；工具与消息 schema 用 **Zod v4**（MCP SDK v2 走 Standard Schema，Zod v4 为首选接线）。
   - **内核（必须自研，禁止整体引入现成 harness）**：主循环 / 会话 / 工具系统 / 上下文管理 / MCP 生命周期。可借鉴 Claude Code / dsh / opencode 源码语义，但不得 vendor 任何现成 harness。
   - **模型适配层（必须自研）**：极简适配器，仅 `complete` / `countTokens` 两方法；P0 只实现 OpenAI 兼容（`/v1/chat/completions`）；可借鉴 dsh llm-pi-ai 语法，但不整体引 pi-ai。
   - **测试**：vitest。
   - **查证规则**：凡涉及库/框架用法（含上列已定案库的 API 细节），**必须先经 Context7 MCP 查证**（已配置：`.codeartsdoer/mcp/mcp_settings.json` → context7）核实版本、运行时要求与用法后再引入；禁止凭记忆臆造任何 API、版本号或配置项。
2. 安全边界（散见于 BRD §8）：R1 LLM 永不直接控制仪器；R2 探针写内存/复位前先声明；R3 工具必须诚实（读失败显式报错、全 0 不得解码为"无故障"）。

## 过程留痕（每阶段必做，禁止收尾一次性补记）
在 `dev-notes/{开发阶段}.md`（如 `dev-notes/P0-主循环.md`）**增量**追记。每完成一个阶段——定稿、计划评审通过、每个任务完成、code review 结论、finish——就补一段，每段记四样：用户关键原话、关键产出（spec / plan 路径、评审结论）、被拒绝或纠偏的内容、翻车与返工。

## 提交信息规范
- 格式 `type(scope): description`。
- `type` 仅限：`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `chore`。
- `scope` 用真实模块名（如 `hal`、`uart`、`debug`、`cli`），禁止 `misc` / `stuff`。
- `description` 用中文，不加句号，≤ 50 字。
- 破坏性变更：`feat(scope)!:` 或脚注 `BREAKING CHANGE:`。

## 完结交付
每个功能完结时交付三样：**功能演示命令、测试结果、dev-notes 路径**。

## 环境注意
Windows 为一等公民（git-bash）。已知坑（详见 BRD §13 / §11.2）：Kaspersky 启发式会静默删除 ELF；pyOCD USB 枚举死锁，真硬件后端必须用 OpenOCD；内部路径按 POSIX 风格统一表示，出口再转换。