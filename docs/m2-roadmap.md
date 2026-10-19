# M2 路线图（决策记录与任务拆分）

> 版本：v1.0 · 日期：2026-10-19 · 状态：已确认方向，待逐项出 spec/plan
>
> 本文记录 P0 内核完成后（M1 → M2）的任务规划与三项用户决策：
> **Web 优先、不做 CLI**；**采纳默认权限预设建议**；**P0 未完成项先修，剩余工作落成文档**。

## 0. 已确认的决策

| # | 决策 | 结论 | 影响 |
|---|---|---|---|
| 1 | 交互形态 | **Web 优先，不做 CLI** | M2 审批通道以 Web 前端 + HTTP API 为主；headless/库层策略先实现为权限引擎与审计事件，UI 在 M3 接实时审批；不建设 REPL/TUI |
| 2 | 权限默认预设 | **采纳 `diagnose`** | 读工具 allow；`mem_write`/`reset`/`serial_write` ask；`shell` ask；未知 MCP 工具 deny |
| 3 | 顺序 | **先修 P0 剩余，再进 M2** | 本轮 `fix/p0-remaining` 已完成可本地修复项，外部验证与架构项落 deferred |
| 4 | 已过时条目 | 决策点 #9（UI 形态）**关闭：Web 先行** | BRD §14 已就地标注关闭；M2 里程碑口径不变 |

## 1. P0 收尾（已完成部分）

见 `docs/deferred-issues.md` 变更记录 2026-10-19 行与 `dev-notes/P0-剩余项修复.md`。本轮状态：

- 已解决 24 项：D-010 / D-013 / D-014 / D-016 / D-023 / D-028 / D-034 / D-035 / D-036 / D-037 / D-039 / D-042 / D-044 / D-045 / D-046 / D-048 / D-049 / D-073 / D-089 / D-090 / D-100 / D-101 / D-103 / D-104。
- 部分解决 1 项：D-084（`fs read` 增 `nextOffset`，跳过分类披露）。
- 未完成且不计划在 P0 内修：
  - **D-109** 第三方 in-process 工具 worker/进程隔离（P1 架构项）。
  - **D-110** 无 artifact 的 evidence 超窗降级（需要扩展 `CompactionPayload`）。
  - **D-111** live 网关 / 真实第三方 MCP / 真机 / 终止失败路径的外部验证。

## 2. M2 工作流总览

| 工作流 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **A. 权限与审批（PLAT-5）** | 策略引擎、Web 审批通道、审计事件 | 决策 #5 已定 | headless 默认 deny 风险工具；Web 可审批；审计完整 |
| **B. 提示词与配置** | 分节组装、preset/分层配置 | A 的工具身份稳定 | 冲突显式报错；preset 可 patch |
| **C. 事件总线与钩子** | 工具/权限/MCP/evidence 事件发布 | 无 | Web 能订阅；回放协议可用 |
| **D. BR-2 取证 MCP** | 探针/串口 MCP server（Renode 优先） | A 的策略骨架 | Renode 端到端闭环；写前声明 |
| **E. BR-3 KB MCP** | 103 文件迁移、`kb_lookup/read/search`、回归 | 决策 #2 的 RAG 实验 | 回归双轨全绿；拒答通道可用 |
| **F. BR-4 参数级策略** | 地址范围、串口端口白名单、复位门禁 | A、D | 写/复位可被独立拦截 |
| **G. BR-5 沉淀闭环** | `kb_propose` → inbox → 审核 → 回归 | E | 合并前回归全绿 |
| **H. RAG 对照实验** | A/B/C/C′ 四方案 274 查询 | 无（可并行） | 报告 + 关闭决策点 #2 |
| **I. Web 审批与回放** | 实时审批 UI、设备面板、会话回放 | A、C | 页面重载状态从日志重建 |
| **J. 外部验证** | live 网关、第三方 MCP、真机 | 环境/板卡 | 记录命令与日志 |

## 3. 任务拆分与顺序

### 阶段 1（立即开始，可并行）

1. **权限系统 spec + plan**（决策 #5 关闭）
   - 规则模型：`tool`（名称/glob）+ `params`（参数谓词）+ `action`（allow/ask/deny）+ `reason`。
   - 预设：`read-only` / `workspace-write` / `diagnose`（默认）/ `danger-full-access`。
   - 管线接入点：schema 校验之后、`execute` 之前。
   - deny 必须不 spawn、不调用工具；ask 在无审批通道时按 deny 处理。
   - 审计事件：`permission_decision`（工具、参数摘要、动作、理由）。
   - 测试约束：危险命令只做纯函数断言 + 断言底层未调用（AGENTS.md 强制）。

2. **RAG 对照实验启动**（`docs/rag-vs-agentic-search-todo.md`）
   - 从 `regression.py` 导出 274 查询为 JSONL。
   - 搭 A（向量）/ B（agentic）/ C（index+grep）/ C′（BM25+grep）。
   - 指标：Recall@2/5、Hit@1、MRR、nDCG@5、P50/P95 延迟、token 成本、拒答率。
   - 结论写 `docs/rag-vs-agentic-search-report.md`，关闭决策点 #2。

3. **事件总线设计**（与 1 并行）
   - 事件类型：`permission_decision` / `tool_started` / `tool_result` / `mcp_status` / `evidence`。
   - Web 订阅协议：SSE（现有抽象层已有替换点）。
   - 不实现 Web 实时审批，只定义接口。

### 阶段 2（权限骨架完成后）

4. **权限引擎实现 + Web 审批 API**
   - `POST /api/approvals` 与 SSE 推送 `approval_request`。
   - headless/库层：`ask` → deny（显式预设），绝不挂起。
   - Web：审批面板（M3 的 I 工作流提前做最小版）。

5. **BR-2 取证 MCP MVP**
   - 工具面：`device_list` / `attach` / `detach` / `halt` / `resume` / `reset` / `mem_read` / `mem_write`；串口 `open/read/write/close/status`。
   - 后端：Renode 优先；OpenOCD 子进程 + TCL 通道；串口真口/仿真 UART 统一抽象。
   - 安全：写/复位/串口写标 destructive；写前声明；读失败显式报错；全 0 不得解码为“无故障”。
   - 证据输出落 `artifacts/`，带 `evidence: true` 与 `artifactPath`。

6. **BR-3 KB MCP 骨架**
   - 迁移 103 文件 + index.yaml（85 条目）。
   - `kb_lookup` / `kb_read`（路径限 KB 根）/ `kb_search`。
   - 回归入口：172 index + 102 search。
   - 检索后端可替换，默认实现待 RAG 报告。

### 阶段 3（领域闭环）

7. **BR-4 参数级策略**：地址范围、串口端口白名单、复位门禁，与权限引擎共用。
8. **BR-5 沉淀闭环**：`kb_propose` → inbox → 人工审核 → 回归全绿合并。
9. **端到端诊断验收**：Renode 上“症状 → kb_lookup → 读症状文件 → 探针取证 → 证据对表 → 根因 + 可证伪预测 → 会话回放”。

### 阶段 4（M3 衔接）

10. **Web 实时审批、设备面板、会话回放**（依赖事件总线与证据字段）。
11. **外部验证（D-111）**：live 网关三 env、第三方 MCP、真机串口/探针。

## 4. 明确不做 / 延后

| 项 | 处理 |
|---|---|
| CLI / TUI | 不做（用户决策） |
| 完整插件树、client 插件机制 | M3 |
| D-109 worker 隔离 | 延后；领域工具走 MCP 独立进程，不经过 in-process 工具 |
| D-110 无 artifact evidence | 延后；BR-2 取证结果默认落 artifact |
| shell 黑名单补全（D-083/087/088） | 不做；由权限层兜底，黑名单不是安全边界 |
| ReDoS/性能（D-078/085/086） | 触发式 |
| 压缩质量（D-091~D-098） | 触发式；等真实诊断会话数据 |

## 5. 验收锚点

- **M2 验收**：交互式诊断全流程在自研平台上走通；安全边界在框架层可执行；KB 回归双轨全绿（BRD §12）。
- **权限层**：默认 `diagnose` 下所有写/复位/串口写在 headless 被 deny；Web 可逐次审批；审计事件完整。
- **BR-2**：Renode 上连接 → 读内存 → 写前声明 → 写 → 复位 → 断开闭环，且每一步可被权限层独立拦截。
- **BR-3**：四段式 100%；172+102 回归全绿；KB 外查询有显式拒答。
- **RAG 实验**：按 `rag-vs-agentic-search-todo.md` §6 判定标准输出决策并关闭决策点 #2。

## 6. 文档关系

- 事实源：`docs/BRD.md`（M2/M3 验收）、`docs/framework-architecture-inventory.md`（P1 七项）、`docs/deferred-issues.md`（风险与触发条件）。
- 本文只记录 M2 规划与决策；具体实现以各任务的 spec/plan 为准。
