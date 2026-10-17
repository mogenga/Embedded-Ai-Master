# P0 内核维度 1+2 可实现设计(主循环 + 模型接入)

> 日期: 2026-10-16 · 状态: 待复审(已完成 spec/plan 审查修订) · 上游: [p0-kernel-design.md](../../p0-kernel-design.md) §1 §2。
> 本轮交付终点: **可运行代码**(设计 → 计划 → 实现 → 测试一步到底)。

## 1. 意图与为什么

P0 内核共六维,本轮实现 **维度 1(Agent 主循环)** 与 **维度 2(模型接入层)**,并自带二者运行所需的最小依赖 子集(会话的最小记账、工具执行的最小管线),使"对话 → 模型响应 → 工具调用 → 结果回灌 → 终止"的最小闭环本机可跑、`vitest` 全绿、不依赖外网。

其余维度(上下文压缩 #3、完整工具集 #4、MCP 客户端 #5、完整会话 #6)在接口层留扩展位,不在本轮实现。

技术栈已定案(决策点 #1 关闭): **TypeScript + Node 24**(ESM-only)、**Zod v4**(经 Context7 查证)、**vitest**。禁止引入现成 harness、禁止引入 pi-ai 等模型库。

## 2. 目标 / 非目标 / 反目标

### 目标
- 交付 `query()` 主循环(事件流形态)与 `ModelProtocol`+OpenAI 兼容实现,含重试与用量记账。
- 交付最小依赖: 会话目录 + append-only JSONL(事件模型与 BR-6/BR-7 消费者共享通型)、工具管线(查表/校验/执行/后处理骨架)。
- 内置 **demo 工具 `echo`**,使最小闭环可跑;MCP server 占位由 v0.2 设计的"至少 1 个 echo 型 MCP server"以装配而非实现承接。
- `npm test` 全绿;每项单元测试不依赖真实模型(HTTP 层 mock)。
- 提供 **live test 可选开关**(环境变量),指向真实 OpenAI 兼容网关,缺省跳过。

### 非目标(本轮不做)
- 上下文三级压缩(#3)、工具四件套与 MCP 客户端(#4/#5)、完整会话回放/fork/分代迁移(#6)。
- 任何领域逻辑(嵌入式取证一律 MCP,不进内核)。
- 权限模型(P1)、Bash AST 分析、流式投机执行、多协议适配。

### 反目标(做了即失败)
- 引入现成 harness 或整体式 LLM 客户端库(违反决策点 #1 复用边界)。
- 循环内吞掉不可恢复错误(认证失败/熔断/取消)不落日志不上抛。
- 测试依赖外网或真实密钥(开发机上 `npm test` 必须确定性通过)。

## 3. 约束

- **ESM-only**,`"type": "module"`,Node >= 24;禁 CommonJS 混用。
- 库/框架用法一律经 Context7 查证后引入(已查证 Zod v4: 经典 API,`z.object`/`.parse`/`.safeParse`/`z.infer`;`import { z } from "zod"`)。
- 统一约定: 工具名 `mcp__<server>__<tool>`(本轮仅内置裸名);路径内部 POSIX 风格、出口转换 Windows。
- 会话日志是唯一事实源: 凡进入模型上下文的内容必先落日志("model-visible means logged")。
- 诚实原则(R3): 错误是结构化数据(`isError + code/message/detail`),非异常字符串;工具读失败显式报错。

## 4. 关键设计决策(已定,实现不得推翻)

### 4.1 模块划分(源码布局)

```
src/
├── loop/            # 维度1 主循环
│   ├── query.ts     #   async function* query(...)
│   ├── events.ts    #   LoopEvent 联合类型 + 压缩器输出事件
│   └── breakers.ts  #   maxTurns / maxCostUsd 熔断 → LoopBroke
├── model/           # 维度2 模型接入
│   ├── protocol.ts  #   ModelProtocol 接口(complete/countTokens)
│   ├── openai.ts   #   OpenAI 兼容 /v1/chat/completions 实现
│   ├── providers.ts  #   providers.json 加载 + 声明式 schema 校验
│   └── retry.ts     #   有界指数退避 + jitter
├── session/         # 最小会话子集(#6 扩展位)
│   ├── types.ts     #   SessionEvent / EventType 共享通型
│   └── session.ts   #   header.json + append-only JSONL + 目录布局
├── tools/           # 最小工具管线子集(#4 扩展位)
│   ├── types.ts     #   ToolDef / ToolResult / ToolCtx(annotations 契约)
│   ├── registry.ts  #   按名查表
│   ├── pipeline.ts  #   五阶段管线骨架(权限恒 allow;后处理 = 大输出截断+事件发布+usage)
│   └── echo.ts      #   demo 工具
├── context/         # 最小上下文投影(#3 扩展位)
│   ├── build.ts     #   日志投影 → 模型消息(按工具批次重组)
│   └── budget.ts    #   countTokens 软阈值判断(contextOverBudget)
├── config/
│   └── harness-home.ts  # HARNESS_HOME 解析(%USERPROFILE%/.harness,可注入)
└── demo/            # 最小闭环装配(CLI 入口)
    └── run.ts       #   node src/demo/run.ts "prompt"
```

装配根: `src/index.ts` 导出 `runSession(opts: RunOptions)`,对象签名见 §4.6。

### 4.2 维度1 主循环契约

```ts
// loop/events.ts
type LoopEvent =
  | { kind: "model_message"; content: string }        // 模型流式增量/整段
  | { kind: "tool_use";    id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; ok: boolean; text: string }
  | { kind: "turn_end";    turn: number; costUsd?: number }
  | { kind: "compacted" }                              // #3 实现后产出
  | { kind: "interrupted"; reason: string }
  | { kind: "done"; finishReason: "no_tool_calls" | "max_turns" | "max_cost_usd" | "aborted" };

// loop/query.ts
async function* query(ctx: LoopCtx, input: UserInput, cfg: LoopConfig): AsyncGenerator<LoopEvent>;
```

- `LoopCtx` 携带 `session`(append)、`model`(complete/countTokens)、`tools`(ToolRegistry)、`budget`(contextOverBudget)、可选 `compactor`(压缩器)、`signal`(AbortController)。`budget` 与 `compactor` 均通过依赖注入，不由主循环自行创建。
- 循环体严格按 v0.2 §1.2 伪代码: 落 user 事件 → 每轮熔断检查 → complete → 落 assistant 事件(**含 tool_calls 明细,见 B4**) → yield 事件流 → 收集 tool_use → executeBatch → 结果落日志 → 两个续跑点(A: overBudget 且 compactor 可用则 compaction; B: truncatedByMaxTokens 直接 continue)→ 无工具调用即 `finish("no_tool_calls")`。
- 本轮 compactor 为**可选注入**,缺省空实现,续跑点 A 存在但"无压缩器可调"时继续(不挂死、不静默丢证据)。预算判断本身必实现(`countTokens` + `contextWindow*0.8`),这样 #3 接入是"挂一个 compactor"而非改主循环。
- 批内并行: tools 的 `annotations.readOnly` 为 false 或缺失 → 串行;全部 readOnly → `Promise.all`。
- 熔断(breakers.ts): `maxTurns` 与 `maxCostUsd`(读 usage 累计)任一超限 → 先落 `interrupted` 事件再 `return finish(...)`;`LoopBroke` 承载结构化原因。
- 取消: 外部 abort → 循环捕获,已产出的部分结果仍落日志,发出 `interrupted` 后终止;不留半截 assistant 消息。

### 4.3 维度2 模型接入契约

```ts
// model/protocol.ts
export interface ModelChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;            // 本轮仅文本(P0 之 OpenAI 兼容)
  tool_call_id?: string;      // role=tool 时
  name?: string;              // role=tool 时
  tool_calls?: Array<{        // role=assistant 且该轮声明了工具调用时(Task 9 投影依赖)
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ModelToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: unknown /* JSON Schema 对象 */ };
}

export interface CompletionResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> | { error: "invalid_json"; raw: string } }>;
  truncatedByMaxTokens: boolean;
  usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number };
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | unknown;
}

export interface ModelProtocol {
  complete(messages: ModelChatMessage[], tools: ModelToolSchema[], opts: {
    signal: AbortSignal; maxOutputTokens: number; onDelta?: (text: string) => void;
  }): Promise<CompletionResult>;
  countTokens(messages: ModelChatMessage[]): number;  // 4字符/token 启发式(usage 锚定宣传进 backlog)
}
```

- OpenAI 实现(`openai.ts`): 组装 `/v1/chat/completions` body;`stream: false` 首版(流式留 onDelta 扩展位,实现可先整段返回);**响应只做定向读取,不做整体 schema 校验**(以 v0.2 §2.2 响应读取契约为准: `content` 缺失/非字符串 ⇒ `""`;`tool_calls` 缺失 ⇒ `[]`;非法 JSON 的 `arguments` 不抛异常而返回 `{ error: "invalid_json", raw }`;未知字段忽略);**但承载语义的必需结构缺失属另一类**——顶层非对象、`choices` 缺失/非数组/空数组、`choices[0]` 非对象、`tool_calls` 非数组非 null、tool call 缺 `id`/`function.name` → 抛 `ModelResponseError(code: "invalid_response")` 且不重试(边界理由见 v0.2 §2.2「fail-soft 的边界」);`finish_reason === "length"` → `truncatedByMaxTokens=true`;usage 透传;**apiKey 存在且非空时发 `Authorization: Bearer <key>` 头,缺省不发**(与 v0.2 §2.2 认证约定一致,`apiKeyEnv` 的 env 读取与空值判定由装配层 Task 10 负责)。
- 错误面(openai.ts 内部): 429/5xx 抛**可重试信号**(进 retry.ts);4xx 非 429 与认证失败抛**不可重试终止错**(结构化,主循环上抛)。
- `providers.json` schema(Zod v4,声明式):
  ```ts
  const ProviderConfig = z.object({
    protocol: z.literal("openai-chat-completions"),
    baseUrl: z.string().url(),              // http(s)://host:port/v1
    apiKeyEnv: z.string().optional(),       // env 名;装配层读之: 非空 → 发 Authorization: Bearer,P0 本地网关可缺省空跑
    models: z.record(z.object({
      contextWindow: z.number().int().positive(),
      maxOutput: z.number().int().positive(),
    })),
    pricePerMillion?: z.object({ input: z.number(), output: z.number(), cachedInput: z.number().optional() }).optional(), // 缺省不计价只记token;cachedInput 可缺省(计价口径见计划 Task 9)
  });
  ```
  默认读 `$HARNESS_HOME/providers.json`;API 允许注入文本(测试友好)。模型引用 `provider/model` 二元组。
- `retry.ts`: 有界指数退避 + jitter,初值 1s,倍率 2,最多重试 5 次;第 n 次重试等待 `baseDelayMs * 2^(n-1) * (0.5 + rand() * 0.5)`,超上限上抛结构化终止错。Live 测试时验证真实重试日志,单测注入 sleep/rand。

### 4.4 最小会话子集与事件模型(#6 扩展位)

- 目录布局与事件模型对齐 v0.2 §6(每会话 `<id>/header.json + session.v1.jsonl`,本轮建 `artifacts/` 但只落大输出全文,B3)。
- `SessionEvent = { seq, ts, type, payload, parent? }`,`type ∈ user / **system**(B2,会话首条) / assistant(含 tool_calls 明细,B4) / tool_call / tool_result(含 artifactPath?,B3) / usage / checkpoint / status / interrupted`。**进模型上下文的每一 token 必先落日志**,本轮即实现。
- 提供 `Session.append(ev)` / `Session.replay(): SessionEvent[]` / `Session.events()`;`class Session` 持文件句柄,append 走 fs.appendFile 同步语义(小文件、保序)。
- **不可变与快照语义**(核验回填): `append` 在**入队前**快照整个事件信封(`type`/`payload`/`parent`);落日志事件与 header 深冻结;`events()` 返回只读视图。理由: 日志是唯一事实源,信封被事后篡改等同于改写历史。
- 本轮不实现 fork / 分代迁移 / 损坏检测(接口留位,#6 全量实现)。**损坏检测的本轮边界**: 只对 JSON 语法错 fail-closed;JSON 合法但结构不符(如某行为 `null`)本**不**校验,留 #6 与 header 对账一并实现。

### 4.5 最小工具管线(#4 扩展位)

```ts
// tools/types.ts
interface ToolDef<I> {
  name: string;
  description: string;
  schema: z.ZodType<I>;                 // v4: .parse 可用于校验
  annotations?: { readOnly?: boolean; evidence?: boolean; destructive?: boolean };
  execute(input: I, ctx: ToolCtx, signal: AbortSignal): Promise<ToolResult>;
}
type ToolResult = { isError: boolean; code: string; message: string; detail?: unknown; artifactPath?: string; text: string };
```

- 管线五阶段: lookup → schema 校验(safeParse,失败=结构化错误回传,不 throw)→ 权限(P0 恒 allow,接口位)→ execute(超时=signal 中止+结构化超时错)→ 后处理(结果 >8k tokens 全文落盘 `artifacts/<eventId>.txt` 并留 `artifactPath`,事件 text 为截断体且**不超过 25k tokens**,发布 tool_result 事件 + usage 记账)。
- demo `echo`: `{ text: string }`,直接回显;`readOnly: true`(演示批内并行)。
- 内置注册表: `new ToolRegistry([echo])`,按名查找,未知工具 = 结构化错误。

### 4.6 装配与入口

- `src/index.ts`: `runSession(opts)` — 签名:
  ```ts
  type RunOptions = {
    input: string;
    model: string;                    // "provider/model",必传无缺省(B1)
    sessionDir?: string;              // 缺省 $HARNESS_HOME/sessions/<id>
    providersText?: string;           // providers.json 全文,缺省读 $HARNESS_HOME/providers.json
    systemPrompt?: string;            // 可选,落为会话首条 system 事件(B2)
    fetchImpl?: typeof fetch;         // 测试注入(mock),生产缺省全局 fetch
    signal?: AbortSignal;
  };
  // 返回 AsyncGenerator<LoopEvent>,消费完即会话终止
  ```
  内部: 读 providers → 校验(含 `model` 引用存在性)→ 构造 ModelProtocol → 构造 Session(首条落 system,再落 user)→ 构造 ToolRegistry([echo]) → 消费 query()。
- 事件消费者两种:
  - headless demo `src/demo/run.ts`: 初始化输入参数(`node src/demo/run.ts "给出平台信息然后结束"`),逐事件打印,退出码约定(M1 口径: 正常 0 / 熔断非零 / 取消非零)。
  - 测试消费者: 收集全部事件断言。
- CLI 交互式 REPL **本轮不做**(P2 #9)。

余下 4 项由 builders / 本人判定(builder check 结论,均属实现者可定夺范畴,不改用户已批范围):

- **B1 provider/model 选择**: `runSession` 签名统一为对象形态,`model: "provider/model"` **必传,无缺省**(确定性优先,夜批可复现);live 开关与 CLI 共用 `HARNESS_COMPAT_MODEL` 环境变量承载该引用。文档 §4.1 的 `runSession(input, cfg)` 是遗留笔误,以 §4.6 对象签名为准。
- **B2 systemPrompt 落日志**: `SessionEvent.type` 联合**新增 `system`**;会话初始化时 system 事件必为首条,投影只从事件流重建(不走 header.json 旁路)——保"model-visible means logged"结构成立。
- **B3 大输出截断后的字节去向**: 把 v0.2 §3.2 一级"工具结果落盘"**前移进本轮**(最小实现): 工具结果超 8k tokens 时全文写 `artifacts/<eventId>.txt`,事件存截断文本 + `artifactPath`(全文仍从日志可复原,证据链不丢;投影用截断文本)。这与 #3 完整实现同构,只是时序提前。
- **B4 含工具批次的投影非恒等**: `assistant` 事件携带完整 assistant 消息(含 `tool_calls` 明细);`tool_result` 事件按批用 `parent` 关联(对齐 v0.2 §6 事件模型);`context/build.ts` 投影器做**重组**(连续 assistant + 其同批 tool_result → OpenAI 消息序列),非线序恒等。

## 5. 测试策略

- **单测一律不含外网**: OpenAI 兼容实现接受注入的 `fetch`(构造器参数/依赖注入),测试用内存 mock fetch 返回夹具响应(含正常、429、500、`finish_reason:length`、tool_calls 各支)。
- 覆盖面至少:
  - openai: 请求体组装(含 tools、max_tokens、model)、响应解析(内容、tool_calls、截断、usage)、错误分类(429 可重试 / 4xx 不可重试 / 5xx 可重试)。
  - retry: 定时器假时间下重试次数上限、jitter 界限、超上限抛错。
  - budget: countTokens 启发式、0.8 阈值触发。
  - query: mock provider 脚本化返回序列(先 tool_use 后无 tool)验证事件顺序与终止;truncatedByMaxTokens→续写;maxTurns 熔断;abort 中断路径;批内 readOnly 并行(记录时序断言)。
  - session: append → replay 回文一致;user 事件先于一切;usage 累计。
  - providers: 合法配置通过、坏配置(无 contextWindow)抛结构化错。
- **live 开关**: 读 `HARNESS_COMPAT_LIVE=1` + `HARNESS_COMPAT_BASE_URL` + `HARNESS_COMPAT_MODEL`,缺省 `describe.skipIf` 跳过;不写死真实密钥到仓库。
- 覆盖率目标: 内核模块 line coverage ≥ 85%(demo 装配除外);`npm run coverage` 可复现。

## 6. 验收口径(本轮)

1. `npm install && npm test` 断网全绿;
2. `npm run lint && npm run typecheck` 通过(demo 装配可豁免 lint 严格规则? 不——全部通过);
3. `node dist/demo/run.js "..."` 或 tsx 直接跑,连接真实网关(live)时打印事件流并正常终止,退出码 0;
4. mock 单测证明: 事件顺序符合 v0.2 §1.2(落 user → complete → assistant → tool_use → tool_result → … → done);
5. dev-notes 增量留痕。

## 7. 留给实现的自由(计划/编码时)

- `fetch` 注入方式(构造器 vs 每调用可选参)。
- `onDelta` 流式是否首版实现(stream:false 起步可后补)。
- 配置文件未找到时的报错文案与 exit code(归于 M1 完整表)。
- 包管理锁定文件策略(`package-lock.json` 提交与否由实现定,倾向提交)。
- tsconfig 严格度: `strict: true` 起步,放行项(如 noUncheckedIndexedAccess)由实现权衡并在 PR 说明。
