# P0 内核架构方案(embeddedAgent harness)

> 版本: v0.1 草案 · 日期: 2026-10-15 · 状态: **M1 设计稿,待评审**
> 决策来源: 用户选型(2026-10-15)+ [harness-comparison.md](harness-comparison.md) 七工具调研 + [BRD.md](BRD.md) M1。
> 选型决定: 主循环 / 上下文管理 / 工具系统 / MCP 客户端取 **Claude Code** 母本;模型接入融合 **dsh + opencode** 并简化;会话管理取 **dsh** 母本。
> 语言栈假设: **TypeScript + Node**(决策点 #1 的落地倾向——本设计大量依赖 async generator / Zod / TS 类型系统,选型即隐含此假设;正式关闭 #1 待评审确认)。
> 定位: 领域无关内核;嵌入式调试的垂直影响以"贯穿约束"形式表达(§7),内核代码不含领域逻辑。

---

## 0. 选型总览

| # | 维度(P0 条目) | 方案名称 | 母本 | 关键简化 |
|---|---|---|---|---|
| 1 | Agent 主循环 | Query 生成器循环(生成器状态机) | Claude Code | 7 个续跑点 → 2 个;错误扣留两级分类 |
| 2 | 模型接入层 | 声明式 Provider 注册 + 单协议适配器 | dsh(llm-pi-ai)+ opencode | 三协议 → 一协议(OpenAI 兼容);不做降级链/OAuth |
| 3 | 上下文管理 | 三级渐进压缩(本地适配版) | Claude Code 五级压缩 | 五级 → 三级;去服务端 cache_edits 依赖 |
| 4 | 工具系统 | 统一 Tool 接口 + 五阶段执行管线 | Claude Code | 八阶段 → 五阶段;去 defer_loading / AST 分析 |
| 5 | MCP 客户端 | stdio 优先 + 两级作用域 | Claude Code | 6 种 transport → 1+1;四级 scope → 两级;去 OAuth |
| 6 | 会话管理与隔离 | Append-only 分代 JSONL 会话日志 | dsh | 去 zstd / FTS5;树状导航后置 |

```
┌────────────────────────── harness 内核(单 Node 进程)──────────────────────────┐
│                                                                               │
│   Query 生成器循环(#1) ──调用──▶ 模型接入层(#2)──HTTP──▶ 本地网关/云 API      │
│        │  ▲                           │                                       │
│        │  │ 工具调用/结果              │ usage(token/cache)                   │
│        ▼  │                           ▼                                       │
│   工具系统(#4) ──分发──▶ MCP 客户端(#5)──stdio──▶ probe-mcp / kb-mcp 子进程  │
│        │                      │(内置工具: fs/shell/glob/grep 直连)           │
│        ▼                                                              │
│   上下文管理(#3) ◀────────── 全部进出经 ──▶ 会话日志(#6, append-only JSONL)  │
│   (压缩/落盘/预算)                        (回放/恢复/fork 的唯一事实源)        │
└───────────────────────────────────────────────────────────────────────────┘
```

核心原则(全六项共用): **会话日志是唯一事实源**——凡进入模型上下文的内容必先落日志;凡工具执行必经同一管线;凡可恢复错误必在循环内消解,不上抛。

---

## 1. Agent 主循环 — Query 生成器循环

### 1.1 方案名称

**Query 生成器循环**(async generator 状态机,母本: Claude Code `query()` + QueryEngine)。

### 1.2 方案实现

核心是一个 `async function*`,即"一次诊断会话的执行体"本身是一个可被迭代的事件流:

```ts
async function* query(session: Session, input: UserInput, cfg: LoopConfig): AsyncGenerator<LoopEvent> {
  await session.append(userEvent(input));              // 先落日志(model-visible means logged)
  let turn = 0;
  while (true) {
    assertBreakers(cfg, ++turn, session.costUsed);     // 熔断:maxTurns / maxCostUsd → 抛 LoopBroke
    const resp = await provider.complete(session.context(), signal);  // AbortController 贯穿
    await session.append(assistantEvent(resp));        // 落日志
    yield* emit(resp);                                 // 向 UI/headless 流式吐事件
    const calls = collectToolUses(resp);
    if (calls.length === 0) return finish(session);    // 正常终止:模型无工具调用
    for await (const r of toolSystem.executeBatch(calls, signal))
      await session.append(toolResultEvent(r));        // 落日志(含 is_error 结构化错误)
    // ── 续跑点(continue sites)──
    if (contextOverBudget(session)) { await compaction.run(session); continue; }   // 续跑点 A
    if (resp.truncatedByMaxTokens) continue;                                        // 续跑点 B
  }
}
```

要点:

- **状态机即循环**:`while(true)` 直至模型无工具调用;没有独立的状态机类,turn 状态由循环变量 + 会话日志承载,天然可恢复。
- **中断与取消传播**:`AbortController` 在循环入口创建,贯穿 model 请求、工具执行、MCP 子进程;用户取消 → signal 中止 → 已产生的部分结果仍落日志(取消不提交半截 assistant 消息,与 dsh 语义一致)。
- **续跑点(简化为 2 个)**:
  - A 上下文超限 → 交给上下文管理(#3)压缩后 continue;
  - B 输出被 max_output_tokens 截断 → continue 让模型续写。
- **错误扣留(两级分类,简化)**:可恢复错误在循环内消解不上抛——网络/429 类在模型接入层内部退避重试(#2);上下文/截断类在续跑点消解。其余(认证失败、熔断、用户取消、工具不可恢复错)作为终止事件上抛。母本的 7 个 continue site 收敛为上述 2 个,余者归入"终止"。
- **熔断**:`maxTurns` 与 `maxCostUsd` 双保险,超限抛 `LoopBroke` 终止并落日志。默认值面向夜批(headless 单轮墙钟 25 min 由外层管线强制,循环内熔断是第二道保险);交互式默认放宽。
- **并行工具调用**:模型一次声明的多个 tool_use 为一批;批内只读工具并行、含写工具串行(判据来自工具的 readOnly 标注,#4)。母本的读写分区 + 流式投机执行简化为"批内只读并行",投机执行不做。

### 1.3 方案简述

主循环采用 Claude Code 的生成器状态机形态:一次诊断就是迭代一个 async generator,每轮"请求模型 → 落日志 → 流式吐事件 → 收集工具调用 → 批量执行 → 结果落日志",无工具调用即终止,可恢复错误(上下文超限、输出截断)在两个续跑点就地消解,不可恢复错误作为终止事件上抛。生成器形态使交互式 REPL、headless 夜批、未来 Web 服务器消费**同一个循环**——三形态差异只在事件流的消费者,这正是 BR-7 夜批与 BR-6 回放共享一套事件语义的结构基础。取消经 AbortController 一条线贯穿到探针工具(嵌入式串口长读必须可随时打断),双熔断(maxTurns/maxCost)为无人值守兜底。

### 1.4 相对母本的简化

| Claude Code 原样 | 本方案 | 理由 |
|---|---|---|
| 7 个 continue site(PTL/缓存/计费等多类恢复) | 2 个(超限压缩、截断续写) | OpenAI 兼容协议下其余恢复场景(服务端 cache_edits 等)不存在 |
| 错误扣留多级分类 | 两级(重试层内消解 / 续跑点消解) | 单进程单协议,错误类别少 |
| 读写分区并发 + 流式投机执行 | 批内只读并行 | 60+ 工具才需要投机;我们内置 4-6 个 + MCP,收益不抵复杂度 |
| (母本无 UI 解耦层) | 循环只产事件,UI/headless 是消费者 | 对齐 dsh "日志即真相",三形态复用 |

---

## 2. 模型接入层 — 声明式 Provider 注册 + 单协议适配器

### 2.1 方案名称

**声明式 Provider 注册 + 单协议适配器**(母本: dsh llm-pi-ai Custom model API + opencode provider config,按用户指示简化)。

### 2.2 方案实现

- **协议接口**:`ModelProtocol` 接口只有两个方法——`complete(messages, tools, signal)`(含流式增量回调)与 `countTokens(messages)`(启发式)。P0 只实现 `openai-chat-completions` 一种;接口留 enum 扩展位(`anthropic-messages` / `openai-responses` 按需后补)。
- **声明式注册**:provider 即一段配置,不做代码注册——
  ```jsonc
  // providers.json(用户级)
  { "local-gw": { "protocol": "openai-chat-completions",
                  "baseUrl": "http://127.0.0.1:PORT/v1", "apiKeyEnv": "LOCAL_GW_KEY",
                  "models": { "flash": { "contextWindow": 128000, "maxOutput": 8192 } } } }
  ```
  模型引用统一为 `provider/model` 二元组;`contextWindow` / `maxOutput` 显式声明(上下文管理 #3 的预算依据),不探测。
- **重试**:有界指数退避 + jitter(初值 1s,倍率 2,上限 5 次,超上限上抛)。母本 dsh llm-retry 的参数化策略,保留——成本低、夜批必需。
- **用量统计**:累计每次响应 `usage`(prompt/completion/cached tokens),写入会话日志的 usage 事件;`maxCostUsd` 熔断与 UI 成本显示都读这里。单价表随 provider 配置声明,缺省不计价只计 token。
- **不做**(明确出边界):自动降级链(诊断可复现性 NFR-3 要求夜批固定模型,降级反而有害)、OAuth/账号门户、模型路由热切换、models.dev 集成。换模型 = 改配置重启会话。

### 2.3 方案简述

模型接入刻意做薄:一个只有 `complete/countTokens` 两个方法的协议接口,P0 只实现 OpenAI chat completions 兼容一种(本地网关 Phase 0 已验证),provider 全部声明式配置(base_url + 环境变量取 key + 显式声明模型上下文窗口),重试用有界指数退避,用量按响应 usage 累计入会话日志。dsh 与 opencode 都证明了"多 provider 是配置问题而非架构问题",因此这里只为未来留接口,不为多协议付当下的复杂度;自动降级链明确不做——夜批可复现性(固定模型)与诊断证据链的严肃性都要求模型面越窄越好。

### 2.4 简化对照

| 母本能力 | 本方案 | 理由 |
|---|---|---|
| dsh:三协议适配 + 官方/第三方双轨 | 一协议 + 扩展位 | 本地网关只讲 OpenAI 兼容;Anthropic 协议按需后补 |
| opencode:75+ provider / models.dev / OAuth | 声明式 JSON,手写 provider | 单人项目,provider 数 ≤ 3 |
| Claude Code:降级链 fallback-model | 不做 | 夜批可复现性优先 |
| dsh:热改路由不重启 | 改配置重启 | 诊断会话生命周期短,重启成本低 |

---

## 3. 上下文管理 — 三级渐进压缩(本地适配版)

### 3.1 方案名称

**三级渐进压缩**(母本: Claude Code 五级压缩;去服务端依赖的本地适配,融合 dsh 的 token-meter / verbatim 尾部经验)。

### 3.2 方案实现

- **Token 计数**:`countTokens` = 4 字符/token 固定密度启发式 + 每次响应真实 usage 锚定校准(借 dsh token-meter 方案——OpenAI 兼容协议无 Anthropic 式精确计数 API,这是实践上最稳的近似)。
- **窗口预算**:每模型显式 `contextWindow`(provider 配置声明);软阈值 = 0.8 × 窗口(超即触发 autocompact)。
- **三级流水线**(按代价从低到高):
  1. **工具结果落盘**:单个工具结果超阈值(默认 8k tokens,可按工具标注覆盖)→ 全文写会话目录 `artifacts/`,上下文内替换为"句柄 + 头尾摘要 + 行数/字节数"。串口长捕获、内存 dump、反汇编大块都命此处。**落盘文件与会话同生命周期,回放时可复原全文**——证据不丢,只离场。
  2. **工具结果修剪(本地版 microcompact)**:更早轮次的工具结果在上下文里被替换为占位(保留工具名 + 结果摘要一行);只修剪"未受保护"的结果。完全本地编辑消息历史,无服务端参与。
  3. **autocompact 摘要**:达软阈值 → 用同一模型发独立请求,把"受保护窗口之外的老历史"摘要为一条 summary 事件,**尾部 verbatim 保留 16%**(借 dsh 经验——最近的证据链往往正是判决所在);原始事件永远在日志里,压缩只改"重建给模型的视图",不改日志本身。
- **证据链保护(NFR-5 落点)**:工具的 annotations 带 `evidence: true`(探针读/寄存器读类,MCP server 可声明)→ 其结果默认不参与修剪,autocompact 前若仍超限按"最老优先降级为落盘引用"处理,先落盘再离场,不直接丢。
- **缓存断裂态度**:本地网关的 prompt cache 按前缀自动命中,修剪/摘要必然破坏前缀 → 策略是**时序规避**:压缩尽量发生在"距上次请求 > 缓存 TTL"或"会话空闲"时;无法规避则接受断裂,用 usage 中 cached_tokens 的突降做告警(不自动修复)。

### 3.3 方案简述

上下文管理取 Claude Code 的多级渐进思路并做本地化收缩:三级流水线按代价递增——大工具结果全文落盘留句柄(嵌入式取证的串口捕获/内存 dump/反汇编都命此处),更早轮次的工具结果修剪为占位,触达 0.8 软阈值后对老历史做摘要并 verbatim 保留尾部 16%。与母本的关键差异是**完全本地执行**:不依赖 Anthropic 服务端 cache_edits(OpenAI 兼容协议没有),token 计数用启发式 + usage 锚定(dsh 已验证的近似方案)。诊断证据链的保护落在两层:工具可声明 `evidence: true` 免修剪;一切压缩只改"模型视图"不改日志——原始数据永远可回溯,这是"证据链不能丢"的结构保证而非约定。

### 3.4 简化对照

| Claude Code 五级 | 本方案三级 | 理由 |
|---|---|---|
| 工具结果落盘 | **保留**(一级) | 嵌入式大输出的主出口 |
| history snip | 并入修剪(二级) | 场景重叠 |
| microcompact(缓存热走 API 服务端 / 冷走本地) | 仅本地路径(二级) | 协议无服务端编辑能力 |
| context collapse | 砍掉 | 与 autocompact 职责重叠 |
| autocompact(fork 子 agent 摘要) | 独立摘要请求(三级)+ verbatim 尾部(dsh 经验) | P0 无子代理;尾部保留直接借 dsh 参数 |
| 缓存断裂检测 + 修复 | 检测告警,不修复 | 单协议,修复手段(服务端编辑)本就不存在 |

---

## 4. 工具系统 — 统一 Tool 接口 + 五阶段执行管线

### 4.1 方案名称

**统一 Tool 接口 + 五阶段执行管线**(母本: Claude Code `Tool<Input,Output>` 泛型 + 八阶段流水线)。

### 4.2 方案实现

- **统一接口**(Zod schema,TS 泛型):
  ```ts
  interface ToolDef<I, O> {
    name: string;                       // 内置:裸名;MCP:mcp__<server>__<tool>
    description: string;                // 进系统提示词,影响模型选择
    schema: z.ZodType<I>;               // 输入校验,失败=结构化错误回传
    annotations?: { readOnly?: boolean; // 并行调度与权限判据
                    evidence?: boolean; // 上下文压缩保护(#3)
                    destructive?: boolean };  // P1 权限的钩子
    execute(input: I, ctx: ToolCtx, signal: AbortSignal): Promise<ToolResult<O>>;
  }
  ```
  `ToolCtx` 携带会话 id、工作目录、事件发布器;`ToolResult` 含 `isError: boolean` + 结构化错误体(`code / message / detail`)——**R3"工具必须诚实"的类型化落点**:错误是数据,不是异常字符串。
- **五阶段管线**(每批工具调用统一走过):查找 → schema 验证 → 权限检查(P0 恒 allow,接口留位给 P1 #7)→ 执行(超时 / 取消 / 大输出截断)→ 后处理(超限落盘 #3、发布事件 #13 接口、usage 记账)。
- **超时分级**:内置 shell 默认 2 min;MCP 工具按 server 声明(serial 类长操作允许分钟级);超时 = signal 中止 + 结构化超时错误回传模型(模型可据此换策略——Phase 0 验证过"防 hang"必须做到工具级)。
- **大输出截断**:执行器出口统一截断(默认 25k tokens,对齐母本 MCP 截断值),截断体交 #3 一级落盘。
- **内置最小工具集**(决策点 #3 的答案):`fs`(读/写/编辑合一)、`shell`、`glob`、`grep` 四个进内核——诊断所需的"读日志、翻工程、跑编译"全够用;嵌入式取证一律走 MCP(探针/串口/KB),**不进内核**(领域逻辑不入内核的定位边界)。
- **不做**:ToolSearchTool / defer_loading 延迟加载(工具总数 < 20,全量注册;未来膨胀再引入)、tree-sitter Bash AST 分析(那是权限深水区,P1 #7 再议)。

### 4.3 方案简述

工具系统是一个泛型接口加一条五阶段管线:每个工具用 Zod 声明输入、用 annotations 声明读写/证据/破坏性三类语义标注,执行统一走"查找 → 验证 → 权限(P0 占位)→ 执行 → 后处理"。三个设计决定值得强调:错误是结构化数据而非异常文本(R3 的类型化落点,模型拿到 `code/detail` 才能决策重试还是绕行);超时分级且超时本身是结构化回传(Phase 0 教训:防 hang 必须做到工具级);大输出出口统一截断并接落盘。母本 Claude Code 的八阶段流水线与 60+ 工具生态被收缩为五阶段 + 4 个内置工具(fs/shell/glob/grep),嵌入式取证完全外置给 MCP——领域不入内核的边界在这里被物理保证。

### 4.4 简化对照

| Claude Code | 本方案 | 理由 |
|---|---|---|
| 60+ 内置工具 | 4 个(fs/shell/glob/grep) | 决策点 #3:pi 四件套为下界、dsh 全家桶为上界,取"诊断够用"最小面 |
| 八阶段管线 | 五阶段 | 去 hook 段(P1 #13 再挂)、去内部缓存段 |
| 读写分区 + 投机并发 | annotations.readOnly 驱动的批内并行 | 同 #1.4 |
| ToolSearch + defer_loading | 全量注册 | 工具总数小;MCP 命名空间已隔离 |
| Bash AST 安全分析 | 不做 | 随权限模型(P1)再议 |

---

## 5. MCP 客户端 — stdio 优先 + 两级作用域

### 5.1 方案名称

**stdio 优先 + 两级作用域**(母本: Claude Code MCP 客户端;生命周期语义借 dsh 的 scope 结论)。

### 5.2 方案实现

- **Transport**:P0 只实现 **stdio**(子进程 + 每行 JSON-RPC),官方 TypeScript SDK;`streamable-http` 在 `Transport` 接口留实现位,不做。领域工具(probe-mcp / kb-mcp)均为本地进程,HTTP 无消费者。
- **连接模型与生命周期**(决策点 #8 的答案:**会话级**):
  - 每个 MCP server 配置 = 一个连接定义;**连接归属其配置所在的作用域,作用域随会话**——一个会话启动时按"用户级 + 项目级"两层配置实例化全部 MCP 子进程,会话结束统一回收(杀进程组,防 OpenOCD/串口句柄泄漏——嵌入式特有要求)。
  - 会话间**零共享**:无全局连接池(PLAT-2"会话间上下文与 MCP 连接隔离"的直接落点)。
  - 健康检查:启动握手超时(默认 30s)→ 该 server 标记失败,工具以结构化"server 不可用"回传(不静默);运行中进程退出 → 自动重启一次,再失败降级为不可用并**通知会话**(工具列表变更事件)。
  - 工具列表变更:重连后 tool list 变化以事件进会话日志并同步给模型(下轮请求的工具目录更新)。
- **命名空间**:工具名 `mcp__<server>__<tool>` 全局唯一,进工具系统(#4)后与内置工具同管线;权限规则(P1)与 UI 展示都按此名寻址。
- **作用域两级**:`user`(~/.harness/mcp.json)/ `project`(<project>/.harness/mcp.json),project 覆盖 user 同名 server。母本的 local/project/user/managed 四级收敛为两级,managed(企业托管)砍掉。
- **server instructions**:server 声明的 instructions 注入系统提示词的 MCP 分节(组装机制属 P1 #8,P0 先按固定分节拼接)。
- **不做**:OAuth/PKCE(无远程认证 server)、roots、sampling、资源订阅(资源按需 list/read 即可,Phase 0 同款)。

### 5.3 方案简述

MCP 客户端收敛为"本地 stdio + 会话级生命周期":每个 server 一个子进程,随会话启动、随会话回收(杀整个进程组——探针工具挂着 OpenOCD 与串口句柄,泄漏是嵌入式场景的真实事故源),会话之间不共享任何连接(用户点名的会话隔离在 MCP 维度的直接实现)。健壮性三件套来自母本与 Phase 0 教训的交集:启动握手超时失败不静默(工具诚实回传"server 不可用")、运行中崩溃自动重启一次、重连后工具列表变更以事件进日志并更新模型目录。命名空间 `mcp__server__tool` 原样保留——它是权限规则、UI、日志三方共用的寻址语法。六种 transport 砍到 stdio 一种、四级作用域砍到两级,HTTP 与企业托管留接口不做。

### 5.4 简化对照

| Claude Code | 本方案 | 理由 |
|---|---|---|
| 6 种 transport | stdio(+HTTP 接口位) | 领域工具全部本地进程 |
| 4 级 scope + managed | user / project 两级 | 单人项目无企业托管 |
| OAuth 三阶段 | 不做 | 无远程 server |
| 工具结果 25k 截断 | 保留,接落盘 | 与 #3 一级联动 |

---

## 6. 会话管理与隔离 — Append-only 分代 JSONL 会话日志

### 6.1 方案名称

**Append-only 分代 JSONL 会话日志**(母本: dsh session-persistence,"model-visible means logged" 原则)。

### 6.2 方案实现

- **存储布局**:每会话一个目录 `$HARNESS_HOME/sessions/<id>/`:
  ```
  <id>/
  ├── header.json          # 元数据:id/创建时间/provider/model/workdir/状态
  ├── session.v1.jsonl     # append-only 事件日志(不可变,写满/压缩后 rollover 到 v2)
  └── artifacts/           # 工具结果落盘(#3 一级),按事件 id 命名
  ```
- **事件模型**:`SessionEvent { seq, ts, type, payload, parent? }`,type 覆盖 `user / assistant / tool_call / tool_result / usage / compaction / checkpoint / status / interrupted`。**与 headless 的事件流(BR-7)与 Web 状态通道(BR-6)复用同一套类型定义**——一份事件 schema,三个消费者。
- **"model-visible means logged"**(母本核心原则,原样继承):重建给模型的每一 token 必能从日志派生;模型视图 = 日志的投影函数(含 #3 的压缩投影)。禁止任何"只在内存、不落日志"的上下文修改。这一条同时兑现:回放(BR-6 从 tool_result 事件重建设备状态)、可复现(NFR-3)、可恢复(断电后从日志尾重建)。
- **可靠性三件套**(母本原样):header 校验(启动时对账);**损坏 fail-closed**——坏行不跳过,拒绝恢复该会话并报告(静默跳过 = 历史被改写,违反诚实原则);分代迁移——格式升级时显式 `vN → vN+1` 转换器链,旧文件不可变保留。
- **checkpoint**:每次模型请求前追加 checkpoint 事件(dsh checkpoint-policy 同款),崩溃恢复到最近 checkpoint,未完成 turn 以 `interrupted` 事件闭合。
- **resume / fork**:`resume` = 读 header + 重放日志尾重建内存状态;`fork` = turn 边界派生新会话目录,新 header 写 `forkedFrom`,种子 = 原日志前缀引用(诊断的"假设 A/B 分支"各 fork 一个,互不污染)。P0 只做 turn 边界 fork;树状导航 / 弃用分支摘要(pi 方案)记入 backlog。
- **隔离语义**(用户点名的硬需求):会话间无共享内存、无共享 MCP 连接(#5)、无跨会话上下文注入;跨会话知识沉淀只走显式通道(BR-5 inbox,人工审核)。

### 6.3 方案简述

会话层完整继承 dsh 的设计:每会话一目录,事件 append-only JSONL,header 校验、损坏 fail-closed、分代迁移链三件套保证日志本身可信;"model-visible means logged" 原则使模型上下文成为日志的纯投影,于是回放、恢复、可复现、fork 全部是同一份事实的不同读法,而非四个功能。fork 在 turn 边界派生子会话,恰好承载诊断最自然的动作——对同一症状分支验证两个假设,互不污染。P0 收缩两处:分代文件不做 zstd 压缩(诊断会话明文几 MB,压缩后置),FTS5 全文搜索后置到 P2;pi 的会话树导航作为 backlog 记录,其"分支不删除"的思想已由 append-only 天然满足一半。

### 6.4 简化对照

| dsh 原样 | 本方案 | 理由 |
|---|---|---|
| session.vN.jsonl[.zstd] 压缩分代 | 明文 JSONL,rollover 分代保留 | 单会话体积小;压缩后置 |
| FTS5 全文搜索(opt-in) | P0 不做 | P2 观测维度再议 |
| 会话树导航 / 分支摘要 | turn 边界 fork + backlog | P0 够用;树导航是体验项 |
| checkpoint-policy 可配 | 固定"每请求前" | 策略配置无多场景需求 |

---

## 7. 嵌入式垂直场景贯穿约束

内核领域无关,垂直影响收敛为七条贯穿约束(评审时逐条对表):

| # | 场景特征 | 落点 | 设计响应 |
|---|---|---|---|
| V1 | 串口长读 / 探针操作可持续数分钟 | #1 #4 #5 | AbortController 贯穿到 MCP 工具执行;用户中断即时生效,部分结果落日志 |
| V2 | 串口捕获 / 内存 dump / 反汇编 = 超大工具输出 | #3 #4 | 25k 截断 + 8k 落盘阈值,artifacts 全文可回溯;阈值可按工具标注覆盖 |
| V3 | 证据链是诊断结论的立身之本 | #3 #6 | `evidence` annotation 免修剪;压缩只改投影不改日志;fail-closed |
| V4 | 夜批无人值守(单轮 25 min) | #1 #2 #6 | maxTurns/maxCost 双熔断;固定模型无降级;interrupted 事件闭合崩溃 turn |
| V5 | 设备面板需从日志重建状态 | #6 | tool_result 事件携带结构化载荷,回放 = 日志重放(BR-6 验收口径) |
| V6 | OpenOCD / 串口句柄泄漏 = 真实事故 | #5 | 会话级连接 + 进程组回收;健康检查 + 一次重启 + 不可用诚实上报 |
| V7 | Windows 一等公民(PLAT-9) | 全部 | 路径统一 POSIX 风格内部表示 + 出口转换;子进程用进程组语义;编码强制 UTF-8;本设计不含 OS 沙箱(P3),安全先落 P1 权限层 |

---

## 8. 决策点收敛情况

| 决策点 | 状态 | 结论/去向 |
|---|---|---|
| #1 语言栈与复用边界 | **本设计隐含 TS**,待评审正式关闭 | async generator / Zod / MCP TS SDK 全按 TS 表达;MCP SDK 复用,harness 本体自研 |
| #2 KB 渐进加载载体 | **仍开放**(P1 范畴) | 待 RAG 对照实验;P0 不受阻塞 |
| #3 内置工具集最小范围 | **关闭** | fs/shell/glob/grep 四件进内核,取证全走 MCP(§4.2) |
| #4 会话存储与回放协议 | **大半关闭** | SessionEvent JSONL schema + 投影式回放;具体字段表随 M1 实现定稿 |
| #5 权限粒度 | 仍开放(P1) | P0 留管线阶段位 + annotations.destructive 钩子 |
| #6 上下文压缩策略 | **关闭** | 三级压缩 + 0.8 阈值 + verbatim 尾 16% + evidence 保护(§3.2) |
| #7 多模型路由与降级 | **关闭**(收缩式) | 不做自动降级;声明式 provider,换模型 = 换配置(§2.2) |
| #8 MCP 连接生命周期 | **关闭** | 会话级;握手超时/一次重启/变更事件(§5.2) |
| #9 UI 形态优先级 | 仍开放(P2) | 主循环事件化已为双形态解耦铺平 |
| #10 跨平台基线 | 收敛为实施规范 | V7 四条;随实现细化 |

---

## 9. M1 验收映射

BRD M1 验收:"一次'对话 + 工具调用'最小闭环跑通;决策点全部有结论"。本设计对其的兑现口径:

1. 主循环:交互式输入 → 模型流式响应 → 工具调用(内置 4 件 + 至少 1 个 echo 型 MCP server)→ 结果回灌 → 终止;全程事件落 JSONL;
2. 会话:resume 重放一致(字节级相同上下文);kill -9 后可恢复;fork 出独立目录;
3. 压缩:人为注入超窗负载,三级流水线逐级触发,日志原始事件完整;
4. 熔断:headless 下 maxTurns/maxCost 触发即终止,exit code 非零且日志有 `interrupted`;
5. 隔离:双会话并行,MCP 连接、上下文、artifacts 互不可见;
6. §8 决策点表更新(关闭 5 项,收敛 2 项)。
