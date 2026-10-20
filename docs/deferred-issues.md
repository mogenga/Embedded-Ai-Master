# 已知问题与延后处理清单

> 目的: 记录核验中发现、但**当前不影响功能正确性**的问题。每项标注触发升级的条件——一旦条件成立,转为正式任务修复。
> 记录规则: 新增条目追加到对应章节末尾,注明发现日期与来源任务;问题修复后标注「已解决」并保留条目(不删除)。

## 使用方式

- **不改代码,只登记**。除非触发条件已成立。
- 每项四要素: 现象 / 影响 / 触发升级条件 / 修复建议。
- 触发升级时,把该项复制为 plan 中的正式任务,并在本文件标注「已转入 Task N」。

---

## 一、测试覆盖缺口

### D-001 · `retry` 默认依赖分支未被测试

- **发现**: 2026-10-17,Task 5 核验。
- **现象**: `src/model/retry.ts:11-12` 的 `cfg.sleep ?? setTimeout` 与 `cfg.rand ?? Math.random` 兜底路径从未执行;现有 4 条测试全部显式注入了 `sleep` 与 `rand`。retry.ts 分支覆盖 75%、函数覆盖 33.33%。
- **影响**: 若默认 `sleep` 实现写错(如忘记 resolve 导致挂死),现有测试无法发现。Task 6 的 OpenAI 实现很可能依赖默认值。
- **触发升级条件**: 出现以下任一情况即修复——① Task 6 开始依赖默认 `sleep`/`rand`;② 覆盖率阈值(85%)因该项被卡;③ 实际出现重试挂死或计时异常。
- **修复建议**: 补一条「不传 `sleep`/`rand`,用 `baseDelayMs: 1` 走一次真实重试」的测试。
- **状态**: **已解决**(2026-10-17,Task 6 第二轮整合复审)。触发条件①成立:Task 6 适配器的 `retryConfig` 在调用方未注入时直接使用 `retry` 的默认 `sleep`/`rand`。已补「未注入 `sleep`/`rand` 时默认退避路径可完成重试」测试(`maxRetries: 1, baseDelayMs: 1`),默认分支转绿。

### D-002 · `readSessionFile` 不校验事件形状

- **发现**: 2026-10-17,Task 3 核验。
- **现象**: JSON 语法合法但结构不符的行(如 `null`)会被原样返回为 `SessionEvent[]`,例如 `readSessionFile` 对 `"null\n"` 返回 `[null]`。
- **影响**: 下游投影器(`context/build.ts`)若收到坏形状事件会抛非预期错误,而非受控的 fail-closed。
- **触发升级条件**: ① Task 9 投影器实现时若未做防御;② #6(完整会话)开始实现损坏检测;③ 出现因坏行导致的不可诊断崩溃。
- **修复建议**: 在 `readSessionFile` 增加最小形状校验(`seq`/`ts`/`type` 存在且类型正确),失败抛结构化错;或明确在 Task 9 投影器侧做防御。

### D-003 · `session.ts` 两处分支未覆盖

- **发现**: 2026-10-17,Task 3 核验。
- **现象**: 第 52、86 行(初始化回滚的 `logCreated` 分支、`close` 的二次调用分支)未被测试直接命中;行覆盖 100%,分支覆盖 88.88%。
- **影响**: 回滚清理逻辑是"防覆写"的核心保险,未被直接验证。
- **触发升级条件**: 覆盖率阈值被卡,或出现半初始化残留文件的实际事故。
- **修复建议**: 构造「header 写成功、log 创建失败」与「并发 close 两次」两个用例。注: 2026-10-17 已补一条回滚测试,但只覆盖了 `headerCreated` 分支。
- **状态**: **部分解决**(2026-10-18,维度6 Task 2)。已补「两次 `close` 返回同一 Promise」断言,`close` 二次调用分支已覆盖;`logCreated` 回滚分支仍未被直接命中,保留本项跟踪。

## 二、接口与契约

### D-004 · `stopReason: unknown` 过宽

- **发现**: 2026-10-17,Task 4 核验。
- **现象**: `CompletionResult.stopReason` 类型为 `unknown`,Task 9 无法基于它做类型收窄,只能依赖 `truncatedByMaxTokens` 布尔值。
- **影响**: 续跑点 B 的判据单一化;若未来需要区分 `max_tokens` / `stop_sequence` / `end_turn`,需再改类型。
- **触发升级条件**: Task 6 实现时必须填充真实值;若该值需要被消费(而非仅透传),立即收窄为字面量联合。
- **修复建议**: 在 Task 6 中把 OpenAI 的 `finish_reason` 映射为字面量联合,再评估是否收窄 `CompletionResult`。

### D-005 · `heuristicCountTokens` 对 CJK/emoji 系统性低估

- **发现**: 2026-10-17,Task 4 核验。
- **现象**: 按 JS `string.length`(UTF-16 code unit)÷4 计算。"你好世界"→1 token、"😀😀"→1 token,而实际分词通常更高。
- **影响**: 嵌入式诊断场景大量中文日志,预算判断会偏乐观,可能晚触发压缩或超出真实窗口。
- **触发升级条件**: ① 出现真实网关 400/上下文超限;② #3 上下文压缩实现时发现预算明显偏离实际 usage;③ usage 锚定校准任务启动。
- **修复建议**: 用响应 `usage.prompt_tokens` 做锚定校准(设计稿 §3.2 已列为计划),或对 CJK 引入加权系数。

### D-006 · `lint` 与 `typecheck` 是同一命令

- **发现**: 2026-10-17,Task 5 核验。
- **现象**: `package.json` 中 `"lint": "tsc --noEmit"` 与 `"typecheck"` 完全相同;报告写「lint 通过」容易被误读为有独立静态检查。
- **影响**: 无功能影响;只是文档表述易误导。
- **触发升级条件**: 引入 ESLint/Biome 时自然解决。
- **修复建议**: 引入真正的 linter,或把 `lint` 脚本改为说明性输出。

## 三、流程与仓库卫生

### D-007 · `.superpowers/` 报告不纳入版本控制

- **发现**: 2026-10-17,Task 3 起。
- **现象**: `.gitignore` 忽略整个 `.superpowers/`,任务报告、审查包、brief 均不进库;`git clone` 后无历史可查。
- **影响**: 审计链依赖本机文件系统;多人协作时看不到前序任务的执行与审查记录。
- **触发升级条件**: 需要对外交付/多人协作/需要复现历史审查结论时。
- **修复建议**: 保留忽略,**把关键结论同步进 `dev-notes`**(当前已如此);或改为只忽略临时大文件、提交 brief 与 report。

### D-008 · 无独立静态检查(见 D-006)

见 D-006。

### D-009 · 仅映射 cached token,其余 usage 明细字段未支持

- **发现**: 2026-10-17,Task 6 最终 review。
- **现象**: `Usage` 只映射 `promptTokens` / `completionTokens` / `cachedTokens`(`prompt_tokens_details.cached_tokens`);`completion_tokens_details.reasoning_tokens`、`audio_tokens`、`accepted_prediction_tokens` 等字段被忽略。
- **影响**: 当前预算与计价只依赖 prompt/completion/cached,不影响 Task 6 契约;若未来需要按推理 token 计价或诊断,数据会缺失。
- **触发升级条件**: ① providers 价格表需要新增明细字段;② 需要展示/审计推理 token;③ 出现网关返回 usage 明细但内核无法解释的计价偏差。
- **修复建议**: 在 `Usage` 增加可选字段并从 `prompt_tokens_details` / `completion_tokens_details` 定向读取;保持缺字段省略语义。

### D-011 · 响应体读取期间的取消被误报为 `invalid_response`

- **状态**: **已解决**(2026-10-18,`fix/p0-full-review`;`json()` 的 catch 先判 `isCancellationError(err) || opts.signal.aborted`,命中原样抛出,并补 AbortError 透传测试)。
- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `src/model/openai.ts` 中成功响应的 `await response.json()` 若抛 `AbortError`(响应头已到、体读取阶段被取消),被 `catch` 统一包装为 `ModelResponseError(code: "invalid_response")`,cause 才是 `AbortError`。同文件错误路径的 `response.text()` 抛 `AbortError` 时却原样透传,两条路径语义不一致。
- **影响**: Task 9 主循环按错误类型区分"取消 → 落 `interrupted` + `done(aborted)`"与"模型响应非法 → 终止错";此场景会被记成后者,取消被误报为协议错误。
- **触发升级条件**: ① Task 9 开始实现取消分支(必然依赖错误类型判别);② 实际出现取消被显示为模型错误。
- **修复建议**: 在 `json()` 的 `catch` 中先 `isCancellationError(err) || opts.signal.aborted` 判断,命中则原样 `throw err`;补一条「`json()` 抛 AbortError → rejects AbortError 而非 invalid_response」测试(plan Task 6 已补该测试条目)。

### D-012 · `choices[0]` 非对象被静默当作空成功

- **状态**: **已解决**(2026-10-18,`fix/p0-full-review`;校验 `choices[0]` 与 `message` 的元素形状,畸形响应抛 `invalid_response`,并补 `null`/数组/字符串/message null 用例)。
- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `{"choices":[null]}` 或 `{"choices":["bad"]}` 返回 `{ content: "", toolCalls: [], truncatedByMaxTokens: false }`,不抛错。`21b8e63` 已把「`choices` 缺失/非数组/空数组」判为 `invalid_response`,但元素级未校验。
- **影响**: 网关畸形响应被伪装成"模型正常地没说话",主循环会以 `no_tool_calls` 正常终止并写入日志——违背 R3 诚实原则,且故障被掩盖。
- **触发升级条件**: ① Task 10 端到端集成前(建议随即修复,改动仅一行判空);② 出现网关畸形响应导致的静默空轮次。
- **修复建议**: 在取 `choices[0]` 后加 `if (choice === null || typeof choice !== "object" || Array.isArray(choice)) throw new ModelResponseError(...)`;补 plan 已列的 `choices[0]` 非对象测试。

### D-013 · 非 http(s) scheme 的 `baseUrl` 不被拒绝

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`resolveChatCompletionsUrl` 在创建期校验 `http:`/`https:`,其他 scheme 抛 `TypeError`;补 ftp/file 用例。
- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `createOpenAIProvider({ baseUrl: "ftp://gw/v1" })` 构造成功;首次请求时 `fetch` 抛 `TypeError`,被包成 `NetworkError` 并按可重试错误退避 4 次才暴露。
- **影响**: 配置错误被延迟为"网络故障",排查成本高;每次启动白白消耗数秒退避。
- **触发升级条件**: 出现因误填 scheme 导致的启动延迟或误诊。
- **修复建议**: `resolveChatCompletionsUrl` 中校验 `url.protocol` 为 `http:`/`https:`,否则抛 `TypeError`(与非法 URL 同路径、创建期失败)。

### D-014 · `usage` 数字字段为字符串时整体省略 usage

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`toFiniteNumber` 接受可收窄的数值字符串,非数值字符串仍整体省略;补两条用例。
- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `usage: { prompt_tokens: "10", completion_tokens: 3 }` 时 `hasCompleteUsage` 为 false,返回结果不含 `usage`。
- **影响**: 计价与 `maxCostUsd` 熔断静默失去数据(只计 token 不熔断),与"字段缺失 ⇒ undefined"的刻意 fail-soft 难以区分。
- **触发升级条件**: ① 接入真实网关后发现 usage 字段类型漂移;② 计价出现无法解释的零成本。
- **修复建议**: 数值字段用 `Number()` 收窄后判 `Number.isFinite`,或对非数值 usage 记一条 `status` 事件说明被忽略的原因。

### D-015 · `opts.signal` 是否传给 `fetch` 无断言看守

- **状态**: **已解决**(2026-10-18,`fix/p0-full-review`;新增断言 `init.signal === opts.signal`)。
- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: 变异探针删除 `fetch(...)` 中的 `signal: opts.signal` 后,43 条测试全绿。现有取消测试只覆盖"退避期间取消不再发下一次请求"与"fetch 自身抛 AbortError"。
- **影响**: 真实请求进行中的取消依赖 `signal` 传到 `fetch`;若被误删,长请求(串口长读、大模型响应)将无法中断,且无测试报警。
- **触发升级条件**: Task 9 接入真实取消路径前(建议随即补断言)。
- **修复建议**: 补一条断言 `init.signal === 传入的 signal` 的测试(plan Task 6 已补该测试条目)。

### D-016 · 错误面仅 `ModelFatalError` 带 `code`,其余错误类型未导出

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):五个错误类全部导出并统一带 `code`(`api_4xx` / `retryable_http` / `unexpected_status` / `network` / `invalid_response` / `request_timeout`)。
- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `RetryableHttpError` / `UnexpectedHttpError` / `NetworkError` / `ModelResponseError` 均未从模块导出;其中除 `ModelResponseError` 带 `code: "invalid_response"` 外,其余无 `code`,消费者只能按 `name` 字符串判别。
- **影响**: Task 9/10 无法对错误做结构化分类(如区分"重试耗尽"与"3xx 意外响应");`instanceof` 不可用,只能比对字符串,重构时易失效。
- **触发升级条件**: Task 9 实现错误分类分支时(必然需要判别这些类型)。
- **修复建议**: 导出错误类或统一为带 `code` 联合的结构化错误(`api_4xx` / `retry_exhausted` / `unexpected_status` / `network` / `invalid_response` / `aborted`)。

### D-017 · Task 6 审查遗留项 F8-F12 未闭环

- **发现**: 2026-10-17,Task 6 多轮 review。
- **现象**: 第二轮整合复审共 13 项(F1-F13),`21b8e63` 修复了 F1-F7、F13;F8(空 `tools` 仍发送,与计划"提供即发送"一致,属明确不改)与 **F9/F10/F11/F12 按用户指示"留待后续"**,其具体内容只存在于控制器派发提示中,仓库内无文字记录(`.superpowers/` 报告为 diff 快照 + 实施留痕,不含 finding 正文)。
- **影响**: 这四项的实际风险未知;后续核验无法判断它们是否已被本次回填覆盖,存在重复发现或永久遗漏两种风险。
- **触发升级条件**: ① Task 9 派发前(建议届时向用户索取 F9-F12 原文并逐项判定);② 后续 review 再次提出同类问题时。
- **修复建议**: 取得原文后逐项登记为 D 条目或转入正式任务;今后 review finding 应连同编号正文一并落到 `dev-notes` 或本文件,而非只存在于派发提示里。

### D-010 · 退避 `sleep` 不响应取消

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`RetryConfig` 新增 `signal`,`retry` 在退避期间监听 abort(并用同长度 timer 兜底不响应取消的注入 sleep),中止即抛 `AbortError`;adapter 每次尝试传入 `opts.signal`;补「退避期间取消」与「已中止 signal」用例。
- **发现**: 2026-10-17,Task 6 第二轮整合复审。
- **现象**: `src/model/retry.ts` 的 `sleep` 只接受毫秒数、不接收 `AbortSignal`。适配器仅在每次尝试开始前检查 `opts.signal.aborted`,正在进行的 `setTimeout` 不会因取消提前结束,因此取消最多要等待当前退避周期结束。
- **影响**: 不发起新请求、结果仍正确;但交互取消的响应延迟最多为一个退避周期(默认首次约 1s,并按指数增长),取消后进程可能迟迟不退出。
- **触发升级条件**: ① 验收指标要求取消立即生效或用户明显感知延迟;② `baseDelayMs`/`maxRetries` 调大导致等待显著;③ 出现取消后进程迟迟不退出的问题。
- **修复建议**: 让 `sleep` 接受 `AbortSignal`(或把 signal 传入 `retry`),在睡眠中监听 abort 并提前 reject;或改用可取消定时器。

### D-018 · `.tmp/` 页面测试游离于默认测试流程

- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `.tmp/api-connectivity/connector.test.js`(13 条)需显式传路径才运行;默认 `npm test` 不覆盖,CI 化后会被完全遗忘。
- **影响**: 临时页回归无自动看守;`vitest.config.ts` 为它引入了 CLI 参数探测的特殊分支,增加配置复杂度。
- **触发升级条件**: ① 临时页转为正式交付物;② 引入 CI。
- **修复建议**: 届时把页面与测试迁出 `.tmp/`(或明确废弃并删除),同时移除 `vitest.config.ts` 中的 `.tmp` 分支。

### D-019 · `toModelToolSchemas` 输出含 `$schema` 关键字

- **发现**: 2026-10-17,Task 7 第二轮整合复审。
- **现象**: Zod 4.6.7 的 `z.toJSONSchema(schema, { io: "input" })` 输出包含 `"$schema": "https://json-schema.org/draft/2020-12/schema"`,当前原样作为 OpenAI `tools[].function.parameters` 发送,无断言也无剥离。
- **影响**: 官方 OpenAI 与多数兼容网关接受该关键字;少数严格网关可能拒绝并返回 400。Task 7 测试只断言 `type/properties/required`,未固化 `$schema` 的存在或剥离决定。
- **触发升级条件**: ① Task 10 端到端接真实网关时出现工具 schema 400;② 新增对网关兼容性有要求的 provider。
- **修复建议**: 若目标网关拒绝,在 `toModelToolSchemas` 中剥离顶层 `$schema` 并补断言;否则补一条断言固化保留行为。

### D-020 · `ToolCtx.cwd` 尚无来源

- **状态**: 已解决(2026-10-18;Task 8 `executeBatch` 增加 `cwd`/`timeoutMs`,Task 9 `LoopCtx` 已透传;装配层可选,缺省 `session.dir`)。
- **发现**: 2026-10-17,Task 7 第二轮整合复审。
- **现象**: `ToolCtx` 要求 `sessionId` 与 `cwd`,但 `SessionHandle` 只有 `id`/`dir`,Task 8 计划中的 `executeBatch` opts 也只有 `signal`/`artifactDir`;`cwd` 由谁提供、取 `process.cwd()` 还是会话工作目录未定义。
- **影响**: echo 不受影响;文件类工具在 Task 8 接入时行为不确定,可能出现相对路径解析到错误目录。
- **触发升级条件**: ① Task 8 实现 `executeBatch` 时;② 首个依赖相对路径的工具接入时。
- **修复建议**: 在 Task 8 的 `executeBatch` opts 增加 `cwd`,由装配层显式传入;或把 `ToolCtx.cwd` 改为可选并约定缺省为 `process.cwd()`。

### D-021 · MCP 工具名字符集与注册表校验不一致

- **状态**: 已解决(2026-10-19;维度5 Task3 `createMcpTools` 统一映射为 `mcp__<server>__<tool>`,sanitize 非 `[a-zA-Z0-9_-]` 字符,超长/冲突确定性改名,注册表保持 OpenAI 契约;`tests/mcp-tools.test.ts` 覆盖 `a.b`/`a_b` 跨 server 冲突与同 server `dup` 改名,`tests/integration.test.ts` 覆盖 fixture `dup.a`/`dup_a`)。
- **发现**: 2026-10-18,Task 7 交付核验。
- **现象**: `ToolRegistry` 现按 OpenAI function 名契约校验(`a-z/A-Z/0-9/_/-`,1-64 字符)。经 Context7 查证 MCP SEP-986,工具名**额外允许 `.` 和 `/`**(用于命名空间,如 `user-profile/update`)。即 MCP 合法名可能被注册表直接拒绝。
- **影响**: 当前 P0 只有内置 echo,无影响;接入 MCP 客户端(设计稿 #5)时,带 `/` 或 `.` 的 server 工具会构造期抛错。且这类名字本就不能原样发给 OpenAI,必须在挂载层做**名称映射**(如 `mcp__server__tool`),而不是放宽注册表校验。
- **触发升级条件**: ① 实现 MCP 客户端工具挂载时(必然遇到);② 首个 MCP server 工具名含 `.` 或 `/`。
- **修复建议**: 在 MCP 挂载层统一重命名并维护 `暴露名 → (server, 原工具名)` 映射,注册表保持 OpenAI 契约;补一条「MCP 名含 `/` 经映射后可注册」的测试。

### D-022 · 超时只保证管线返回,不保证工具停止

- **发现**: 2026-10-18,Task 8 第三轮红队审查(I6)。原请求编号 D-021 已被 Task 7 占用,故顺延为 D-022。
- **现象**: `executeBatch` 以 `Promise.race` 在超时后返回 `tool_timeout`,但不监听 signal 的工具不会停止;串行分支在超时返回后立即发起下一次调用,前一个写工具可能仍在运行,实际形成并发写。**MCP 层同源**: `McpManager` 的 per-server 串行队列以 `callOnce` 返回为释放条件,而 `invoke` 用 `Promise.race` 提前返回 `mcp_timeout`/`mcp_aborted`;底层 `client.callTool` 仍可能 pending,队列已释放,后续调用可与残留调用重叠。该限制已写入 design §4.2(2026-10-19 Task2 第二轮 review)。
- **影响**: 当前 P0 只有只读 echo,无影响;接入探针写内存、复位或文件写入工具后,超时后的残留调用可能与下一次写调用重叠,破坏串行写假设并造成设备状态竞争。MCP 侧同理:超时/取消后的串行保证不再成立。
- **触发升级条件**: P1 接入首个非只读工具(写内存/复位/文件写入)前;MCP 侧为接入首个非只读 MCP 工具前。
- **修复建议**: 写工具接入前引入可等待的终止或隔离机制(进程级 worker、MCP 会话级取消并等待服务端确认);或在超时后拒绝启动同批次后续写工具,并把会话标记为需人工确认。MCP 侧可维护"孤儿调用"屏障:超时/取消后暂停同 server 队列,直到原 promise settle、连接重置或人工确认。
- **状态**: **已缓解**(2026-10-19,fix/p0-a-tier): pipeline 超时/取消后等待残留执行 `settleGraceMs`(默认 2s),仍未结束则不再启动同批后续调用,后续结果标 `tool_skipped_after_timeout`;内置 `fs`/`glob`/`grep`/`shell` 均已响应 signal(D-071/D-077 已解决)。MCP 超时/取消/破坏性断线后终止 transport 并轮询 PID,确认退出后才允许重连;未确认时标记 `mcp_uncertain` 并拒绝重连。剩余风险仅限自定义/第三方 in-process 工具故意忽略 signal(见 D-109)与 MCP 终止失败时的环境性残留(见 D-111)。

### D-023 · 非字符串 `call.id` 绕过重复检测

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):管线入口对非字符串 id 直接返回 `tool_protocol_error` 且不执行工具;artifact 命名使用固定安全 id。
- **发现**: 2026-10-18,Task 8 交付核验。
- **现象**: `executeBatch` 的重复检测在 `typeof call.id !== "string"` 时直接判为非重复(`duplicates` 返回 `false`)。运行时探针: `[{id: 42}, {id: 42}]` 两条都执行并都返回 `ok`。`BatchResult.id` 类型声明为 `string`,但运行期不校验。
- **影响**: 正常路径无影响——`call.id` 来自 Task 6 适配器解析的 tool call `id`,该处已校验为字符串(Task 6 的 `invalid_response` 守卫)。但这是管线里唯一的静默旁路: 若未来有其他调用方(回放、测试脚本、MCP 工具)构造 `BatchCall`,非字符串 id 会同时绕过重复检测与证据文件命名的字符串假设。
- **Task 9 复核(F9)**: `query` 的 `collectToolUses` 不重复校验 `call.id`,明确信任 Task 6 适配器的字符串保证;若未来出现非适配器构造方,按本条目修复建议把校验前移到 `collectToolUses`。
- **触发升级条件**: ① 出现字符串以外的 id 构造方;② 重复 id 导致证据被覆盖或结果错位的事故。
- **修复建议**: 在管线入口统一把非法 `id` 归一为 `tool_protocol_error` 结构化结果(与 `normalizeToolResult` 同一风格),或把 `BatchCall.id` 的运行时校验前置到 `query` 的 `collectToolUses`。

### D-024 · `artifactDir` 为空串时的错误文案无指引

- **发现**: 2026-10-18,Task 8 交付核验。
- **现象**: `artifactDir: ""` 时大输出落盘失败,结果仍为 `isError: false`(正确,不掩盖工具成功),`detail.artifactError` 为 `"ENOENT: no such file or directory, mkdir ''"`。
- **影响**: 行为正确但文案对使用者无指向性;装配层( Task 10 )若把未配置的路径直接透传,排查时不易意识到是配置缺失。
- **触发升级条件**: Task 10 装配 `artifactDir` 时(建议届时在装配层做非空校验,而不是改管线)。
- **修复建议**: 在 `runSession` 装配处校验 `artifactDir` 非空且在会话目录下;管线侧保持现状。

### D-025 · assistant 空 `tool_calls` 数组原样投影

- **发现**: 2026-10-18,Task 9 第二轮整合审查(F4)。
- **现象**: `buildMessages` 对 `AssistantPayload.toolCalls = []` 仍输出 `tool_calls: []`。OpenAI 官方允许 assistant 消息携带该形状(与"同时含 content 与 tool_calls"一致),当前按不变处理。
- **影响**: 官方 API 无影响;少数严格兼容网关可能拒绝空数组,导致整轮 400。
- **触发升级条件**: 接入真实网关出现消息 400,且定位到空 `tool_calls`。
- **修复建议**: 若网关拒绝,在空数组时省略 `tool_calls` 键并补投影断言;否则保留现状并固化。

### D-026 · `maxCostUsd` 熔断延迟一轮

- **发现**: 2026-10-18,Task 9 第二轮整合审查(F8)。
- **现象**: 费用在每轮 `complete` 后累计,`assertBreakers` 只在下一轮 `turn += 1` 后检查。若本轮无工具调用,会先以 `no_tool_calls` 正常结束(不落 `max_cost_usd`);若有工具调用,本批工具会先执行完,下一轮才熔断。
- **影响**: 单轮成本可能超过上限一个模型响应加一批工具;若超支轮恰好是最后一轮,则不会落 `max_cost_usd`。
- **触发升级条件**: 成本上限要求单轮硬实时,或单轮成本可能远超阈值。
- **修复建议**: 在 usage 累计后立即检查并中断(需决定本批工具是否仍执行),或保留轮首检查并在文档写明延迟语义。

### D-027 · 无 usage 时 `maxCostUsd` 静默失效

- **发现**: 2026-10-18,Task 9 第三轮红队审查(I3)。
- **现象**: 响应缺失 usage 时 `query` 落 `status {status:"usage_missing"}` 并保持 cost 不变;若 provider 长期不返回 usage,`maxCostUsd` 永不计费、永不触发。
- **影响**: 成本上限在无 usage 的网关上失效;token 仍可从日志观察,但费用熔断不可用。
- **触发升级条件**: 接入不返回 usage 的网关并要求成本硬上限。
- **修复建议**: 无 usage 时按 `countTokens` 或响应字符数估算成本并标记 `estimated:true`,或明确拒绝在该 provider 上配置 `maxCostUsd`。

### D-028 · `invalid_json` marker 的 raw 无长度上限

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`query.markerResult` 与 `buildMessages` 双层限制 raw 为 8000 字符,超出追加 `[truncated]`。
- **发现**: 2026-10-18,Task 9 第三轮红队审查(Minor)。
- **现象**: `buildMessages` 将 marker 的 raw 原样回填,`query` 的 markerResult 也将 raw 原样写入 text/detail;模型一次输出超长坏参数会直接放大下一轮上下文与日志。
- **影响**: 极端情况下可能触发 context 超限或日志膨胀,当前无上限/截断。
- **触发升级条件**: 真实模型输出超长非法 arguments,或日志/上下文预算被单条 raw 顶爆。
- **修复建议**: 对 raw 设字符上限(如 8k),超限截断并附 `truncated:true`,同时保留 hash/长度摘要。

### D-029 · assistant 重复 tool call id 的投影未拦截

- **状态**: **已解决**(2026-10-18,Task 9 交付核验升级为阻塞项后修复)。
- **发现**: 2026-10-18,Task 9 第三轮红队审查(Minor);交付核验时用运行时探针确认后果远比 Minor 严重,随即升级修复。
- **原现象**: `buildMessages` 登记批次时按 id 列表保留重复项;`tool_result` 侧用 seen 集合拒绝重复结果,但 assistant 自身声明重复 id 时,投影出的 `tool_calls` 仍含重复 id。
- **实际后果(探针证实)**: 模型返回两条同 id tool call 时,`query` 会把两条同 id `tool_result` 写入 `session.v1.jsonl`;随后 `buildMessages` 抛 `duplicate id`,该异常冒到消费者;更严重的是 `readSessionFile` 重读同一会话再投影**同样抛错**——一次模型畸形输出即把整份会话日志变成永久不可回放的坏档,违背 BR-6 与「日志是唯一事实源」。
- **修复**: 双保险。① `query` 在 `session.append(assistant)` 之前调用 `assertUniqueToolCallIds`,重复即抛 `duplicate tool call id`,catch 分支落 `interrupted(error)` 后原错误上抛——**不产生**坏日志(探针复核: 磁盘只剩 `user` + `interrupted`,可正常回放);② `buildMessages` 在登记批次时检测重复 id 并抛 `assistant event <seq> has duplicate tool call id`,守住回放路径。
- **测试**: `tests/build.test.ts`「assistant 声明重复 tool call id 时抛错」;`tests/query.test.ts`「模型返回重复 tool call id → 不落不可回放的日志,原错误上抛」(同时断言 `buildMessages` 不抛)。两条新断言均经变异探针验证(分别删除两处守卫 → 各 1 例失败)。

### D-030 · query 初始化 append 失败不落 `interrupted(error)`

- **状态**: 已登记(2026-10-18,Task 9 第四轮整合审查 N2);N3/N5 并入本条目跟踪。
- **发现**: 2026-10-18,Task 9 第四轮整合审查(N2);N3(补偿写失败未测)与 N5(批次交错负例)同轮提出。
- **现象**: `query` 的 `ctx.systemPrompt` 补写与首次 `user` append 位于主循环 `try` 之前。systemPrompt 与已有会话冲突时会直接 throw;首次 user append 失败(磁盘满、权限、目录被删)时也不进入统一 catch/finally,因此日志可能只有部分事件且没有 `interrupted(error)`。
- **影响**: 会话回放看不到终止原因,审计链在初始化阶段断裂;Task 10 装配层若把写失败当作普通异常上报,日志与退出状态可能不一致。
- **触发升级条件**: ① Task 10 装配 `runSession` 并接入真实文件系统;② 会话目录写失败(磁盘满/权限/目录被删);③ 消费者依赖日志还原终止原因。
- **修复建议**: 把初始化 append 纳入统一错误出口(在 catch 中补 `interrupted(error)` 后 rethrow),或明确"初始化失败不保证日志"契约并在文档与测试中固定。
- **关联 N3(补偿写失败未测)**: catch/finally 的补偿 append 已用 try/catch 吞错以保留原错误,但现有测试只覆盖单次瞬时 append 失败,未覆盖补偿写本身失败(如 `tool_result_lost` 写失败、`interrupted(error)` 写失败)。影响: 补偿完整性无断言看守。触发: 会话写持续失败。建议补两条负例,断言原错误仍上抛且不抛补偿错误。
- **关联 N5(批次交错负例)**: `buildMessages` 已实现批次未完成时拒绝 user/system/assistant,但测试只覆盖 user 插批与 system 位置;未覆盖 assistant 插批、system 插批、跨批次 parent、批次完成后的孤立 `tool_result`。影响: 交错回归可能漏网。触发: 引入回放/并发写入方。建议补对应负例。

### D-031 · 模型响应体无大小上限

- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: `src/model/openai.ts` 对成功响应直接 `await response.json()`,不检查 `Content-Length`,也没有流式字节上限;响应体始终整体驻留内存。
- **影响**: 异常或恶意网关可返回超大 JSON 耗尽内存,长时间运行的嵌入式会话可能被单个响应拖垮。
- **触发升级条件**: 接入不可信网关;出现响应体导致的内存异常;需要限制单次响应开销。
- **修复建议**: 读取时累计字节数,超上限即取消并抛 `ModelResponseError`;或在请求前用 `Content-Length` 预检,并补上限边界测试。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier): `maxResponseBytes` 默认 8 MiB;流式读取累计字节,超限取消 reader 并抛 `ModelResponseError(invalid_response)`;支持 `Content-Length` 预检。

### D-032 · 模型请求无超时

- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: `fetch` 只传 `opts.signal`,没有请求级超时;工具管线有 `timeoutMs`,模型请求没有对应机制。
- **影响**: 网关接受连接后长期不返回时,主循环会无限等待(除非调用方主动 abort),无人值守场景不可用。
- **触发升级条件**: 真实网关出现挂起;需要长时间无人值守运行;出现无法解释的会话停滞。
- **修复建议**: 为模型请求增加可配置超时,超时映射为可重试或终止错误(需固定语义),并补「挂起 → 超时」测试。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier): `requestTimeoutMs` 默认 120s(provider 配置可覆盖);每次 attempt 独立 AbortController,超时抛 `RequestTimeoutError` 并纳入可重试集合;调用方 abort 仍透传 AbortError。

### D-033 · token 预算不计 tool_calls

- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: `heuristicCountTokens` 只累加 `message.content.length`;assistant 消息的 `tool_calls` 名称与参数、以及回填的工具调用结构不计入预算。
- **影响**: 工具密集会话的预算被系统性低估,可能直到真实上下文超限才暴露。
- **触发升级条件**: 出现上下文超限;工具调用占比高的会话预算明显偏离 `usage`;引入 usage 锚定校准。
- **修复建议**: 将 `tool_calls[].function.name/arguments` 按序列化长度计入估算,或在 usage 锚定时按实际值校准。
- **状态**: 已解决(2026-10-19 维度3 修复:`heuristicCountTokens` 已按序列化长度计入 `tool_calls`);剩余 CJK/emoji 低估见 D-005。

### D-034 · 文本截断可能切断代理对

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`truncateText` 在高代理处回退一位,artifact 截断路径统一走该函数;补 emoji 批次用例。
- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: `src/tools/pipeline.ts` 的 `truncateText` 按 UTF-16 code unit 直接 `slice`,当截断点落在代理对中间时会留下孤立代理字符;`MAX_TEXT_CHARS` 与 200/2000 的出口截断均受影响。
- **影响**: 含 emoji 或扩展 CJK 的工具输出被截断后,日志/JSON 可能出现替换字符或编码异常。
- **触发升级条件**: 真实工具输出含 emoji/扩展 CJK 且触发截断;下游对文本编码做严格校验。
- **修复建议**: 截断时检测 `charCodeAt(max - 1)` 是否为高代理,若是则回退一位;补代理对边界测试。

### D-035 · 会话 append 原子性与初始化回滚不完整

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):header 临时文件 `wx` + `fsync` + rename;append 后尽力 fsync;`createSession` 初始化失败(含 systemPrompt 写入)回滚 header/日志/锁;resume 续写前补齐末行换行。
- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核;关联 D-003、D-030。
- **现象**: `append` 通过队列追加 JSONL,无 `fsync`,进程崩溃或断电可能留下半行;初始化阶段 `systemPrompt`/首条 `user` 写入失败不进入统一 `interrupted(error)` 出口,回滚分支覆盖也不完整。
- **影响**: 会话日志可能不可回放或缺少终止原因,违背「日志是唯一事实源」的审计要求。
- **触发升级条件**: 真实断电/强杀/磁盘满;多进程并发写同一会话;消费者依赖日志还原终止原因。
- **修复建议**: 写入后 `fsync` 或采用临时文件 + rename;启动时校验并隔离坏尾行;把初始化写入纳入统一错误出口并补失败回滚测试。
- **扩展**: 2026-10-18,维度6 Task3 审查。closed 会话末行缺换行时,`readSessionDir` 仍能解析,`resumeSession` 成功;后续 `append` 直接追加,与上一行粘连,再次读取报 `invalid_event_line`。已补测试钉死当前行为(`tests/session.test.ts`「closed 会话末行缺换行时 resume 仍成功续写」),未实现自动补换行或坏尾隔离,留待本项修复。

### D-036 · 4xx 未细分 408/409/425

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):408/409/425 与 429/5xx 一样按 `RetryableHttpError` 重试;补状态矩阵用例。
- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: `src/model/openai.ts` 将所有 4xx(429 除外)归为不可重试的 `ModelFatalError(api_4xx)`;408/409/425 等本可重试的状态同样立即终止。
- **影响**: 网关短暂过载或请求过早时无法自动恢复,会话以非预期 4xx 失败结束。
- **触发升级条件**: 网关返回 408/409/425;出现需要重试的 4xx 故障;扩展错误码分类。
- **修复建议**: 明确 4xx 状态 → 可重试/不可重试映射表,将 408/409/425 纳入重试集合,并补状态矩阵测试。

### D-037 · tool call type/content 校验缺失

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`type` 非 `function`(且非缺失)、`function` 非对象、`content` 非字符串且非 `null` 均抛 `invalid_response`;补对应用例。
- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: 适配器只校验 `tool_calls[].id` 与 `function.name` 为字符串;不校验 `type === "function"`、`function.arguments` 的原始类型,`message.content` 非字符串时静默转空字符串。
- **影响**: 畸形 tool call 可能被当作正常调用执行;网关字段类型漂移被 fail-soft 掩盖,难以诊断。
- **触发升级条件**: 网关返回非 `function` 类型 tool call;content 类型漂移;需要严格协议合规审计。
- **修复建议**: 校验 `type` 与 `function` 形状,对非法形状抛 `invalid_response`;content 非字符串时落明确 `status` 事件而非静默替换。

### D-038 · `invalid_json` marker 形状可能被模型输出误判

- **状态**: **已解决**(2026-10-18,全量复核后用运行时探针证实可触发,随即修复)。
- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **原现象**: `src/context/build.ts` 与 `src/loop/query.ts` 通过 `value.error === "invalid_json" && typeof value.raw === "string"` 识别内部 marker;模型真实输出的工具参数若恰好是同一形状,会被误判为解析失败 marker。
- **实际后果(探针证实)**: 构造一个恰好接受 `{ error: "invalid_json", raw }` 的 Zod 工具,模型返回该形状的**合法**参数时,`query` 在 `splitToolUses` 直接短路为 `code: "invalid_json"` 的 tool_result,工具从未执行;日志也按错误记录。即模型合法输出被内核改写,违背 R3「工具必须诚实」。
- **修复**: 适配器在解析失败分支额外置 `invalidJson: true`(模型自己输出的参数不可能带该标记,除非恰好被 JSON.parse 成带此键的对象——但那需要模型显式输出该键,且解析成功路径不会补标记);`query` 与 `buildMessages` 的 marker 判定都改为「`invalidJson === true` 且形状匹配」的双条件。`CompletionResult.toolCalls[]` 与 `AssistantPayload.toolCalls[]` 增加 `invalidJson?: boolean`;该标记不进入工具入参。
- **测试**: `openai.test.ts` 三条 invalid_json 用例改为断言完整对象含 `invalidJson: true`,并新增「模型输出恰好形如 marker 的合法 arguments 时不标记」;`build.test.ts` 新增「未标记 invalidJson 的同形 arguments 按普通对象序列化」;`query.test.ts` 新增「模型输出形如 marker 的合法参数时照常执行工具」。变异探针:适配器永不置标记 → 4 failed,`query` 退回仅看形状 → 1 failed,`buildMessages` 退回仅看形状 → 1 failed。

### D-039 · 同一会话目录并发 resume/append 无跨进程锁

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):新增 `src/session/lock.ts`,`createSession`/`resumeSession`/`forkSession` 以 `O_EXCL` 目录锁持有到 `close()`,跨进程冲突返回 `session_locked`,崩溃遗留锁按 PID 存活回收;补锁单测与 create→resume 重入用例。
- **发现**: 2026-10-18,维度6 Task3 审查。
- **现象**: `resumeSession` 只校验目录与 header 后重建 handle,不获取目录级锁;同一会话目录可被多个进程或句柄同时 resume/append,seq 来自各自内存的 `eventList.length`,可产生重复 seq 或交错行。2026-10-18 Task4 审查补充: `forkSession` 仅用非递归 `mkdir` 对**目标目录创建**做原子占位,可挡住并发 fork 同一 target;但 fork 成功后其他进程仍可绕过该占位直接打开该目录 append,锁未覆盖会话生命周期。
- **影响**: 并发写会破坏 JSONL 的 seq 连续性,使日志无法回放;当前仅靠「同一目录只有一个活跃 handle」的约定规避。
- **触发升级条件**: CLI/UI 支持多窗口或多进程打开同一会话;出现实际重复 seq、交错写入或读取 `invalid_event_line`/`invalid_seq`。
- **修复建议**: 引入目录级锁文件(如 `session.lock`,`O_EXCL` 创建,带超时与陈旧锁回收),`resumeSession` 与 `forkSession` 成功后均持有到 `close`;或改为单写者服务统一代理写入。

### D-040 · artifact 越界校验仅做词法路径判断

- **发现**: 2026-10-18,维度6 Task4 审查修复。
- **现象**: `forkSession` 复制 artifact 前用 `path.resolve` 后的字符串前缀判断源路径是否位于 sourceDir 内(Windows 额外转小写);未调用 `realpath`,不解析符号链接、junction、Windows 8.3 短文件名或其他等价路径形态。若 sourceDir 内存在指向外部的链接,词法检查仍会放行。
- **影响**: 当前工具产物由 harness 直接写入 sourceDir/artifacts,不会产生链接,风险低;但若未来 artifact 来源扩展到用户指定路径或外部工具输出,可能复制 sourceDir 之外的文件。
- **触发升级条件**: artifact 路径可由用户/外部工具控制;出现链接目录、junction 或大小写/短名绕过;安全审查要求严格边界。
- **修复建议**: 对 sourceDir 与 artifact 路径分别 `realpath` 后比较,拒绝非普通文件与跨根路径;或在写入 artifact 时记录规范化后的相对路径,读取时只接受该相对路径。
- **2026-10-18 扩展**: 第二轮红队修复已对源根与 artifact 路径追加 `realpath` 越界检查,链接越界按 `artifactMissing` 处理;但词法检查仍保留在前,`lstat`/`realpath` 与 `copyFile` 之间的 TOCTOU、junction 与 8.3 短名仍未覆盖,详见 D-047。非普通文件(含目录 artifact)仍按 D-042 处理。

### D-041 · fork 失败回滚只删 targetDir,父目录链残留且回滚失败静默

- **发现**: 2026-10-18,维度6 Task4 审查(Task5 登记)。
- **现象**: `forkSession` 失败时 `cleanupTargetDir` 仅对 `targetDir` 做 `rm(recursive)`,不回滚为占位而由 `mkdir(path.dirname(targetDir), { recursive: true })` 创建的父目录链;回滚步骤全部以 `.catch(() => undefined)` 吞掉错误。若失败发生在占位前(父目录已创建),或回滚本身失败,调用方只收到原始错误。
- **影响**: 失败 fork 会残留空父目录;反复失败可能留下目录树。回滚失败无任何信号,调用方可能误判「未写入任何内容」,也增加后续排障成本。
- **触发升级条件**: fork 目标固定为多层不存在目录;出现残留目录导致后续 `target_not_empty`;需要严格的失败原子性与可观测回滚。
- **修复建议**: 记录本次实际创建的父目录层级并在失败时逆序删除;把回滚失败聚合进抛出的错误(`cause`/`detail` 或 `AggregateError`),至少保留可诊断信号。

### D-042 · artifact 越界与缺失共用 artifactMissing,目录 artifact 未定义

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):越界/链接越界/非普通文件标记 `artifactRejected`,源文件缺失仍标记 `artifactMissing`;目录型 artifact 按不支持跳过复制,fork 继续;补两组用例。
- **发现**: 2026-10-18,维度6 Task4 审查(Task5 登记)。
- **现象**: artifact 路径词法越界(位于 sourceDir 外)与源文件缺失(`stat` ENOENT)都调用 `markArtifactMissing`,统一写 `detail.artifactMissing = true`,消费方无法区分「拒绝复制」与「源文件不存在」。此外 `artifactPath` 指向目录时行为未定义: `stat` 成功,但随后 `copyFile` 抛 `EISDIR`/`EPERM`,导致整个 fork 失败,而不是按 artifact 缺失跳过。
- **影响**: 缺失原因不可审计;目录型 artifact 会阻塞 fork,与设计「artifact 缺失不阻塞 fork」不一致。
- **触发升级条件**: 需要区分 artifact 缺失原因;工具产物可能为目录;出现因 artifact 为目录导致的 fork 失败。
- **修复建议**: 为越界、缺失、非普通文件定义区分性标记或原因码(如 `artifactRejected`/`artifactMissing`/`artifactUnsupported`);复制前用 `stat().isFile()` 校验,非普通文件按不支持标记并跳过复制。
- **2026-10-18 复核扩展**: fork 边界改为「前缀可投影」后,artifact 处理未变: 越界(位于 sourceDir 外)与源文件缺失仍统一走 `markArtifactMissing`,共用 `detail.artifactMissing = true`;目录型 artifact 行为仍未定义。

### D-043 · `header.workdir` 与实际工具 cwd 来源不一致

- **发现**: 2026-10-18,维度6 Task6 审查修复。
- **现象**: `runSession` create 路径把 `workdir: opts.cwd ?? process.cwd()` 写入 `header.workdir`;但传给 `LoopCtx.cwd` 的仍是 `opts.cwd`(未提供即 `undefined`),工具管线在 `src/tools/pipeline.ts:314` 用 `opts.cwd ?? session.dir` 作为实际执行目录。未显式传 `opts.cwd` 时,header 记录的是启动进程的 cwd,工具实际在 `session.dir` 下执行。
- **影响**: header 元数据无法用于还原/审计工具真实工作目录;未来若基于 `header.workdir` 重放、fork 或恢复编辑上下文,会得到与执行语义不符的路径。当前工具仅 `echo`,风险低。
- **触发升级条件**: 出现依赖 `header.workdir` 恢复执行上下文的功能(重放、继续编辑、脚本路径解析);或工具从 `echo` 扩展到文件读写/命令执行。
- **修复建议**: 统一来源——create 时写入 `opts.cwd ?? session.dir`,或让 `LoopCtx.cwd` 默认取 `header.workdir`;在 design 中明确 `header.workdir` 是「会话工作目录」还是「进程启动目录」。
- **状态**: **已解决**(2026-10-19 复核;维度4 Task5 起 `runSession` 用 `runCwd = opts.cwd ?? process.cwd()` 同时写 `header.workdir` 与 `LoopCtx.cwd`;resume 用 `opts.cwd ?? header.workdir ?? process.cwd()`,并在两者都提供且不一致时抛 `workdir_mismatch`;`tests/integration.test.ts` 覆盖创建/恢复一致性)。

### D-044 · resume 只校验首个 system 事件

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):resume 校验**全部** system 事件,任一不一致抛 `system_prompt_mismatch`;补多 system 集成用例。
- **发现**: 2026-10-18,维度6 Task6 审查修复。
- **现象**: `runSession` resume 时用 `events.find((event) => event.type === "system")` 只比较首条 system 事件内容;后续 system 事件既不参与内容比较,也不影响「无 system」判定。当前 P0 仅由 `createSession` 写入一条 system,`query` 只在无 system 时补写一条,不会产生多条。
- **影响**: 若未来支持多 system 事件(分层提示、运行时追加/替换),resume 可能放行与当前 `systemPrompt` 不一致的会话,空会话补写判定也可能误判。
- **触发升级条件**: 引入多 system 事件;compaction 或运行时修改 system prompt;多段提示拼接。
- **修复建议**: 明确 `systemPrompt` 与多 system 的映射策略(拼接、比较全部、或只允许首条),校验所有相关事件并给出确定性规则。

### D-045 · `checkpoint.turn` 每次 query 从 1 重新编号,resume 后与历史重复

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`query` 从会话最后一个 checkpoint 的 `turn` 续编;补同一会话两次 query 用例。
- **发现**: 2026-10-18,维度6 Task8 收尾。
- **现象**: `src/loop/query.ts` 在每次 `query` 调用内以 `let turn = 0` 起算,每轮 `turn += 1` 后写入 `checkpoint { turn }`。resume 后再次调用 `query` 会重新从 1 编号,生成的 checkpoint 与同目录历史 checkpoint 的 `turn` 重复;当前 checkpoint 只被写入,没有恢复/重放消费方。
- **影响**: 当前仅影响日志审计可读性,不影响执行;若未来按 `turn` 定位断点、去重或恢复,重复编号会产生歧义。
- **触发升级条件**: 出现 checkpoint 消费方(断点续跑、回合定位、恢复投影);需要按 `turn` 唯一定位。
- **修复建议**: 由 `query` 从会话日志最后一个 checkpoint 的 `turn` 续编,或改用全局 `seq`/事件序号作为唯一标识,并在 design 中明确语义。

### D-046 · 无主错误时 close 异常上抛分支缺真实路径测试

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):补「resume 正常完成、close 抛错 → 调用方收到 close 错误」集成用例。
- **发现**: 2026-10-18,维度6 Task8 收尾。
- **现象**: `runSession` 的 `finally` 中,`session.close()` 异常仅在 `hasPrimaryError === false` 时上抛(`src/index.ts:179-185`)。现有集成测试只覆盖「运行期主错误 + close 异常不覆盖原错误」;`tests/integration.test.ts` 已有 `resumeCloseFailure` mock 可让 resume 返回的 handle `close` 抛出,但未构造「无主错误且 close 抛出」的用例,该上抛分支未被看守。
- **影响**: 当前行为正确但无回归保护;若重排 `finally` 或调整错误优先级,可能静默吞掉 close 失败而不被测试发现。
- **触发升级条件**: 重构 `runSession` 装配/关闭流程;引入可注入的 handle 工厂;审计关闭错误可观测性。
- **修复建议**: 复用现有 `resumeCloseFailure` mock(或抽 handle 工厂),补一条「resume 正常完成、close 抛错 → 调用方收到 close 错误」的集成测试。
- **2026-10-18 补充(close 失败重试语义)**: `createHandle.close()` 一旦失败,`accepting` 已置为 `false` 且 `closePromise` 缓存的是 rejected Promise;后续 `close()` 返回同一 rejected Promise,handle 也不能再 `append`。当前**不实现重试**,调用方需重建 handle 或重新 resume;该语义与「close 失败却标记 closed」的反目标一致。

### D-047 · lstat 校验与打开之间的 TOCTOU,junction/8.3 短名未专项覆盖

- **发现**: 2026-10-18,第二轮红队审查 C-1 修复。
- **现象**: 读取与 append 前用 `lstat` 拒绝符号链接/非普通文件,但检查与随后的 `readFileSync`/`appendFile` 不是同一文件描述符,存在被替换的窗口;Windows junction 的 `isSymbolicLink()` 表现依赖 Node/平台版本,8.3 短名也未纳入路径比较的专项测试。fork 的 source/target/artifact 已用 `realpath` 缓解路径等价问题,但不等于关闭 TOCTOU。
- **影响**: 会话目录可被非可信进程写时,理论上仍可能被诱导读写会话目录外的文件;当前单用户本机 harness、目录由 harness 独占,风险低。
- **触发升级条件**: 会话目录可被其他用户/进程写;多用户或共享目录部署;安全审查要求消除 TOCTOU 或明确覆盖 Windows reparse point/短名。
- **修复建议**: 用 `O_NOFOLLOW`(或平台等价语义)打开并以同一 fd 完成 `fstat` + 读写;Windows 侧明确 `FILE_FLAG_OPEN_REPARSE_POINT` 策略;补 junction、8.3 短名与「检查后替换」的对抗性测试。

### D-048 · 代文件不连续(只有 v2 无 v1)仍被接受

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`readSessionDir` 校验代编号从 v1 连续递增,缺档抛 `SessionCorruptionError(invalid_event_line)`;补「只有 v2」「v1+v3」用例。
- **发现**: 2026-10-18,第二轮红队审查修复。
- **现象**: `readSessionDir` 只按现存 `session.vN.jsonl` 的数字升序合并,不校验代编号从 1 连续到最大代;目录中只有 `session.v2.jsonl` 时,只要 seq 从 0 开始即可正常读取,缺失的 `v1` 不产生任何错误。
- **影响**: 代文件缺失可能是日志被删除、截断或同步失败的信号,当前被静默接受,审计链完整性无法保证;未来若按代定位断点或做增量同步,缺档会导致语义偏差。
- **触发升级条件**: 需要严格的日志完整性/审计证明;出现跨代缺档导致的断点续跑或定位错误;引入日志同步/备份。
- **修复建议**: 读取时校验代编号从 1 连续到最大代,缺档抛 `SessionCorruptionError`(新增专用 code 或复用 `invalid_event_line`),并补「只有 v2」「v1+v3」等缺档测试。

### D-049 · create/resume 允许目录符号链接,与 fork 拒绝源目录链接口径不一致

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):create/resume 与 fork 口径统一,目录符号链接一律 `invalid_target`;补 junction 用例。
- **发现**: 2026-10-18,最终加固审查。
- **现象**: `createSession`/`resumeSession` 通过 `path.resolve` + `stat` 跟随目录符号链接,允许在链接指向的真实目录中创建/读取会话;`forkSession` 则显式 `lstat` 源目录并拒绝符号链接(`invalid_target`)。同一会话目录经链接访问时,create/resume 可用而 fork 不可用。
- **影响**: 行为不一致会让调用方难以判断链接目录是否是受支持输入;若链接在 create/resume 期间被替换,实际读写位置可能与调用方预期不同,也削弱 fork 边界检查的可解释性。
- **触发升级条件**: CLI/UI 允许用户指定会话目录;需要统一链接语义(一律拒绝或一律解析);出现链接目录被替换导致的写入位置偏差。
- **修复建议**: 明确并统一策略——推荐 create/resume 与 fork 一致,对目录本身 `lstat` 拒绝符号链接;或全部改为 `realpath` 后按真实目录工作并在 header 记录,同时补三入口一致性的测试。

### D-050 · payload 非对象 fail-closed 后,含 `payload:null` 的旧日志无法读取

- **发现**: 2026-10-18,最终加固审查。
- **现象**: 第二轮修复后 `readSessionDir` 对 `payload` 非对象(含 `null`、数组、字符串、缺失)统一抛 `SessionCorruptionError("invalid_event_line")`。旧版本可能已写出 `payload:null` 或缺 `payload` 的 `usage` 事件,这类日志升级后从「可读取、`usageTotals` 按 0 跳过」变为整份会话不可读。
- **影响**: 兼容性回退:旧日志无法 resume/回放,只能人工修复或降级读取;这是有意的 fail-closed 收紧,但当前没有迁移/告警路径。
- **触发升级条件**: 需要读取历史会话;出现旧日志因 `payload:null` 无法恢复的事故;引入日志版本/迁移机制。
- **修复建议**: 明确日志 schema 版本并在读取时区分「旧版可容忍」与「新版必须对象」;或提供一次性修复工具把非对象 payload 归一为 `{}` 并记录迁移标记;至少在错误信息中提示兼容性变更。

### D-051 · SSE action 端点契约未定

- **发现**: 2026-10-18,Task 10 视觉验收。
- **现象**: `src/ui/main.tsx` 向 `VITE_ACTION_URL` POST `{ text }`,但未定义请求 id、会话 id、响应状态与错误映射;后端未接入时仅 `console.warn`,没有可观测的 UI 反馈。
- **Task 15 更新**: 本地服务当时已提供 `/api/actions`(POST)与 `/api/events`(GET),但两者均返回 501;action 请求/响应 schema 仍未定义(详见 D-063)。2026-10-20 起 `/api/events` 已实现为只读 SSE 事件流;`/api/actions` 随后也已落地(见 D-139)。
- **影响**: 真实后端接入时端点路径与 schema 仍需重新约定;UI 无法区分「已受理 / 参数拒绝 / 网络失败」,也无法安全重试或去重。
- **触发升级条件**: 接入首个真实 action 端点;需要失败重试、幂等或前端可观测的提交状态。
- **修复建议**: 定义 action 请求/响应 schema(`requestId`、`sessionId`、`text`;202 受理、4xx 校验失败、5xx 可重试),前端落提交中/失败态,并按 `requestId` 去重。
- **状态**: **已解决**(2026-10-20,`feat/m2-web-approval`,见 D-139):`POST /api/actions` 已落地并定义 `{ text, sessionId? }` 与 202/400/404/409/500/503 契约;`/api/events` 见 D-063;审批端点与 UI 见 D-137。旧稿中的 action `requestId` 字段未采用,去重只保留在审批端点。

### D-052 · StatusBar 状态点由 props 是否有值推断

- **发现**: 2026-10-18,Task 10 视觉验收。
- **现象**: `StatusBar` 用 `hasValue()` 判断 `probe`/`serial`/`alert` 是否非空,非空即 `data-s="ok"`(告警为 warn);`App` 默认不传这些 props,因此演示态全部显示「—」与中性点。探针实际已连接但未传值时同样显示未连接。
- **影响**: 状态栏颜色语义与真实连接状态脱节,无法表达「已连接但降级」或「探测中」。
- **触发升级条件**: 接入设备/串口状态事件;状态栏需要表达 warn/error/connecting 多态。
- **修复建议**: 用显式状态枚举(`connected | disconnected | degraded | unknown`)替代「有字符串即 ok」,由会话事件或设备状态投影提供。

### D-053 · 无后端时 Composer 清空输入

- **发现**: 2026-10-18,Task 10 视觉验收。
- **状态**: 已解决(2026-10-18,Task 14/15)。
- **原现象**: `Composer.send()` 在调用 `onSend` 后无条件 `setText("")` 并清空 textarea;`main.tsx` 在 `VITE_ACTION_URL` 未配置时只 `console.warn` 并返回。演示态用户输入被清空且未发送。
- **修复**: `main.tsx` 在未配置 `VITE_ACTION_URL` 时不传 `onSend`,`Composer` 据此禁用发送并展示「未配置提交端点,输入不会发送」;失败路径保留输入并提示「发送失败,输入已保留」。
- **验证**: `tests/ui/components/composer-dock.test.tsx` 覆盖禁用态、失败回填与输入保留;`verify:ui` 不覆盖该文案(页面默认不配置 `VITE_ACTION_URL`,V1-V14 不涉及 Composer 禁用态)。

### D-054 · 717px 工作区下知识库整树需内部滚动

- **发现**: 2026-10-18,Task 10 视觉验收。
- **现象**: 左栏知识库区按 58% 分配,717px 工作区下可用高约 415px;栏头 40 + 检索 48 + 树 334 = 422px,树底部约 7px 超出,最后一项 `index.yaml` 默认需滚动才能看见。V6 按 brief 只断言厂商分流子树完整可见(实测各子项底边 202–298px)。
- **影响**: 默认展开状态下索引末项不可见;若后续把 V6 理解为「整树不可裁剪」会误判。
- **触发升级条件**: 要求 717px 下整树默认全部可见;知识库树继续增加节点。
- **修复建议**: 将左栏知识库比例调到 60% 或压缩检索区/树间距,并在设计 v1.2 的 V6 口径中同步基准;若维持内部滚动,明确末项可滚动是预期行为。

### D-055 · V3 内容宽口径与滚动条占位耦合

- **发现**: 2026-10-18,Task 10 视觉验收。
- **现象**: 旧版 V3 写「主区内容宽 = 主区宽 − 40」,实测消息流内容宽 882px = 主区 932 − 40 − 滚动条 10px。验收脚本按「主区可用宽(扣除滚动条)−40」判定,设计 v1.2 已补口径。
- **影响**: 严格按旧口径会把合理的滚动条占位误判为内容对齐缺陷。
- **触发升级条件**: 改用 overlay 滚动条、`scrollbar-gutter` 策略变化,或要求内容与栏头完全同右边界。
- **修复建议**: 保持 V8 单列滚动条占位;若要内容与栏头同边界,在会话头/路径条/输入栏右侧预留同宽,或统一改为 overlay 滚动条。

### D-056 · V11 仅覆盖页面内静态 Tab 序列

- **发现**: 2026-10-18,Task 10 视觉验收。
- **现象**: CDP 发送 Tab 遍历页面内 41 个控件,覆盖 input/select/textarea/button;未覆盖原生 select 下拉展开态、浏览器原生弹层、以及事件流动态追加后的新控件。遇到重复 key 即停止。
- **影响**: 后续新增组件若遗漏 `:focus-visible` 覆盖,脚本不会发现;动态渲染控件缺少验收。
- **触发升级条件**: 新增交互组件、动态消息/工具卡、原生弹层交互。
- **修复建议**: 在组件测试中断言焦点样式,或让脚本在关键交互后重新枚举焦点序列;把采样数量作为变更检查项。

### D-057 · Chromium 探测未覆盖非标准安装

- **发现**: 2026-10-18,Task 10 视觉验收。
- **现象**: `scripts/verify-ui.mjs` 优先 `CHROME_PATH`,其次 Windows 常见 Chrome/Edge、Linux/macOS 常见路径;Chromium 便携版、Brave、Arc 等未内置。找不到时 exit 2。
- **影响**: 非标准安装环境需要手动设置 `CHROME_PATH`,否则验收不可运行。
- **触发升级条件**: CI/开发机仅安装其他 Chromium 发行版;需要无人工配置执行。
- **修复建议**: 扩展候选路径或读取注册表/常见包管理器安装位置;文档明确 `CHROME_PATH` 为兜底入口。

### D-058 · Dock/设备/日志为静态演示数据

- **发现**: 2026-10-18,Task 11 第一轮整体审查修复。
- **状态**: 数据来源已解决(2026-10-18,Task 14);设备连接状态仍待 D-052。
- **原现象**: `App` 用 `DEMO_REGISTERS` / `DEMO_LOG_LINES` 渲染调试坞;`DeviceMonitor` 的芯片型号、探针连接、CPU 状态为字面量;复位确认后只进入「执行中,等待工具结果」,没有外部事件把它推进到「已执行」。
- **修复**: 删除全部演示数据。`Dock` 的寄存器与日志改由 `TranscriptView` 的工具卡投影(`deriveRegisters` / `deriveLogLines`);设备字段来自 `/api/device`(当前恒为 `unknown`)。无读数时显示「暂无寄存器读数」。
- **残余**: 无 `device_status` 事件时 `/api/device` 仍恒为 `unknown`;复位确认后等待 action 通道。`tool_result` 与 `device_status` 已可经事件流投影,action 仍为 501(D-063 事件流部分已解决)。

### D-059 · 回放/导出按钮未接行为

- **发现**: 2026-10-18,Task 11 第一轮整体审查修复。
- **Task 15 复核**: 仍存在。`ConversationHeader` 的「回放」「导出 transcript」按钮没有 `onClick`,点击无任何反馈或副作用;真实数据接线后回放入口尚无契约。
- **现象**: 按钮存在但不可用,可能被误认为已实现。
- **影响**: 用户无法从界面触发回放或导出。
- **触发升级条件**: 交付回放/导出能力;验收脚本需要点击验证。
- **修复建议**: 增加 `onReplay` / `onExport` 回调并由宿主实现(导出 transcript 可序列化 `TranscriptView`);未接线时禁用按钮并给出可见说明。

### D-060 · SSE 无后端时输入处理

- **发现**: 2026-10-18,Task 11 第一轮整体审查修复。
- **状态**: 已解决(2026-10-18,Task 14/15)。
- **原现象**: `main.tsx` 中 `VITE_ACTION_URL` 未配置时 `console.warn` 后返回;配置了 `VITE_EVENT_STREAM_URL` 但无 action 端点时,Composer 仍清空输入且界面无失败提示。D-053 记录的是输入被清空,这里记录的是 SSE 与 action 两条通道不同步时的处理缺口。
- **修复**: 未配置 `VITE_ACTION_URL` 时 `onSend` 不传入,`Composer` 发送按钮禁用并显示「未配置提交端点,输入不会发送」;当时未配置 `VITE_EVENT_STREAM_URL` 时不建立实时流。2026-10-20 事件总线后默认连接 `/api/events`,两条通道仍不互相暗示已提交。
- **残余**: action 已实现(2026-10-20,见 D-139);事件流见 D-063;审批见 D-137(均已解决)。

### D-061 · StatusBar context/limit 来源未定

- **发现**: 2026-10-18,Task 11 第一轮整体审查修复。
- **现象**: `TranscriptView.context` 已在类型与 App 接线中支持(格式化为 `used / limit`),但 `SessionEvent` / `LoopEvent` 没有 context 投影来源;演示态始终显示 `—`。
- **影响**: 上下文用量无法在状态栏真实呈现;接入后需要确定 used/limit 的统计口径(是否含缓存、是否按模型上限)。
- **触发升级条件**: 内核提供上下文用量事件;状态栏需要显示真实占用。
- **修复建议**: 由内核/服务端在 `usage` 或独立 `context` 事件中提供 `used`/`limit`;明确是否包含 cached token,并在 spec 补充投影规则。

### D-062 · usage 缺字段按 0 补齐导致缺失与真实 0 不可区分

- **发现**: 2026-10-18,Task 12 第二轮红队审查修复。
- **现象**: `mergeUsage` 对缺失的 `promptTokens` / `completionTokens` / `cachedTokens` 一律按 0 累加;仅带 `costUsd` 的 `usage` 事件也会生成全 0 的 token 用量。
- **影响**: 用量展示把「字段缺失」呈现为真实 0,状态栏与成本核算无法据此告警;排查上游 usage 漂移时缺少信号。
- **触发升级条件**: 服务端 usage 字段可缺省,或需要在 UI 区分缺失与 0。
- **修复建议**: 记录已出现的字段集合,缺失字段保持 `undefined` 并由 UI 显示 `—`;或在投影层引入 `complete` 标记,单独告警不完整 usage。

### D-063 · Web API 只读,写操作与实时事件流未实现

- **发现**: 2026-10-18,Task 15 真实数据验收。
- **现象**: `dist/server/serve.js` 的 `/api/actions`(POST)与 `/api/events`(GET)固定返回 501 `action_not_implemented` / `event_stream_not_implemented`;没有 action 请求/响应 schema、会话绑定、SSE 事件格式与重连语义。前端 `VITE_ACTION_URL` / `VITE_EVENT_STREAM_URL` 默认未配置,发送按钮禁用。
- **影响**: 工作台只能读取既有会话与知识库,不能发起新对话、接收实时 LoopEvent 或回传写操作结果;复位提示会停留在「执行中,等待工具结果」。
- **触发升级条件**: 接入 `runSession`/`query` 或 MCP 事件;需要提交、重试、中断;真机调试写入。
- **修复建议**: 定义 action schema(`requestId`、`sessionId`、`text`,202 受理/4xx/5xx)与 SSE 事件(`LoopEvent` JSON、`id`/`Last-Event-ID` 重放);501 迁移为真实实现并补端到端测试。
- **状态**: **已解决**(2026-10-20,`feat/m2-event-bus`):`/api/events` 固定 501 已替换为真实 SSE 单会话事件流,支持 `since`/`Last-Event-ID` 补播、`tool_started`/`mcp_status`/`device_status` 投影、心跳/背压/`stream_end`/`stream_error`;契约见 README「实时事件流」,端到端覆盖见 `tests/events-e2e.test.ts`。`/api/actions` 已于 2026-10-20 落地(见 D-139),Web 写操作与审批见 D-051/D-137。

### D-064 · 知识库扫描深度与条目上限静默截断

- **发现**: 2026-10-18,Task 15 真实数据验收。
- **现象**: `src/server/api.ts` 的 `scanKb` 最多展开 8 层目录(`KB_MAX_DEPTH = 8`),总条目上限 2000(`KB_MAX_ENTRIES = 2000`);达到上限后循环 `break`,超深目录返回空 `children`,响应中没有截断标记。
- **影响**: 大型或深层知识库会被静默裁剪,界面看起来像完整索引;V6 只覆盖小规模 fixture,无法暴露该边界。
- **触发升级条件**: 知识库超过 2000 条目或目录深度超过 8;需要完整索引或性能上限提示。
- **修复建议**: 响应增加 `truncated` / `limits` 字段并在知识库面板提示「已截断」;上限可配置或改为按需懒加载子目录。

### D-065 · 会话列表坏目录进 errors 但界面未展示

- **发现**: 2026-10-18,Task 15 真实数据验收。
- **现象**: `/api/sessions` 对读取失败的会话目录收集 `{ dir, code }` 到 `errors`;前端 `loadWorkbench` 只使用 `sessions`,`SessionPane` 不渲染 `errors`。
- **影响**: 损坏、权限不足或格式非法的会话在界面上完全不可见,用户无法区分「没有会话」与「会话损坏」;排查只能直接看 API 响应或服务端日志。
- **触发升级条件**: 出现 `session_corrupt` / 权限错误;需要在界面提示可修复项。
- **修复建议**: 前端保留 `errors` 并在会话面板展示可折叠告警(区分损坏与读取失败);提供重试或定位目录的入口。
- **状态**: 2026-10-18 Task 17 已解决——`loadWorkbench` 透传 `errors`,`SessionPane` 底部显示「N 个会话目录不可读」;逐目录详情与定位入口仍未提供。

### D-066 · 会话列表 header-only 读取后仍不解析事件

- **发现**: 2026-10-18,Task 16 审查修复。
- **现象**: `/api/sessions` 改用 `readSessionHeader` 只读 `header.json`,并校验至少存在一个类型合法的日志文件,不再逐行解析事件;事件行 JSON 损坏、seq 断裂或未知类型的会话仍以正常摘要出现在列表。
- **影响**: 列表的 `status` / `createdAt` 可信且不再受日志体积影响,但事件损坏只在打开详情时以 500 `session_corrupt` 暴露;列表本身没有「可能损坏」信号。
- **触发升级条件**: 列表需要展示损坏标记;或需要在不打开详情时预判可读性。
- **修复建议**: 列表返回轻量健康标记(如抽样末行 seq 与文件大小一致性),或前端在详情返回 500 时把该会话标记为损坏并提示。

### D-067 · Host/Origin 未校验的 DNS rebinding 加固

- **发现**: 2026-10-18,Task 16 审查修复。
- **现象**: UI 服务只监听 `127.0.0.1`,但不校验 `Host` / `Origin` 请求头;恶意页面可借助 DNS rebinding 或跨源请求访问本机只读 API。
- **影响**: 会话、知识库目录结构与事件内容可能被同机浏览器中的其他页面读取;未来 `/api/actions` 实现后风险升级为写操作。
- **触发升级条件**: 实现 `/api/actions`;或需要在浏览器中承载不可信来源页面。
- **修复建议**: 校验 `Host` 仅为 `127.0.0.1:<port>` / `localhost:<port>`,拒绝跨源 `Origin`;或引入启动时生成的一次性 token。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier): API 请求校验 Host/Origin 必须为 loopback 且端口与监听端口一致;跨源返回 403 `forbidden_host`/`forbidden_origin`;补 raw Host/Origin 集成测试。

### D-068 · Windows 尾随点目录名与实测行为不一致

- **发现**: 2026-10-18,Task 16 审查修复;2026-10-18,Task 17 按实测重写。
- **实测**: Node 24 + Windows 11 下 `mkdirSync("s1.")` 创建独立目录 `s1.`;`readdir` / `lstat` / `realpath` 均保留尾随点,`s1.` 与 `s1` 不会互相命中,列表也不会重复。
- **现象**: 内核 `isValidSessionId` 仅接受 `[a-zA-Z0-9_-]`,header.id 不能含点。因此正常创建的 `s1.` 会话目录无法通过 header 校验:列表记 `invalid_header`,`GET /api/sessions/s1.` 返回 500 `session_corrupt`。若手工把 header.id 写成合法值(如 `s1`),列表会以目录名 `s1.` 出现并记 `id_mismatch`(既有「目录名即 id」语义),详情仍可打开。
- **影响**: API 不会把 `s1.` 与 `s1` 混为同一会话;残余风险是 Win32 友好 API(cmd、资源管理器)会把 `s1.` 显示为 `s1`,误导人工排查与备份/同步工具,且 Linux/macOS 行为不同。
- **触发升级条件**: 非 Node 工具参与会话目录管理;或要求目录名跨平台一致。
- **修复建议**: Windows 上在会话创建入口拒绝尾随点目录名(而不是等 header 解析失败),或统一规范化目录名。

### D-069 · Windows 大小写不敏感导致 id 大小写别名

- **发现**: 2026-10-18,Task 17 第二轮红队修复。
- **实测**: Windows/NTFS 上 `GET /api/sessions/S1` 经 `realpath` 命中目录 `s1` 并返回 200(合法会话),响应 `header.id` 为磁盘原大小写 `s1`;列表 id 同样取目录名 `s1`。
- **现象**: `SESSION_ID_PATTERN` 允许大写,目录 `s1` 与 `S1` 无法共存;同一会话可用不同大小写的 id 访问。Linux 部署下 `S1` 返回 404。
- **影响**: 前端选中态、缓存键或外部调用方按字符串精确比较时,同一会话可能表现为不同 id;跨平台行为不一致。
- **触发升级条件**: 调用方依赖 id 字符串相等;或要求跨平台一致。
- **修复建议**: 列表与请求统一按小写规范化,或在 Windows 上拒绝大小写不一致的请求并补跨平台测试。

### D-070 · 会话目录不可读 / ACL 拒绝未验证

- **发现**: 2026-10-18,Task 17 第二轮红队修复。
- **现象**: `/api/sessions` 把 `readSessionHeader` 的 `EACCES` / `EPERM` 及其它 I/O 错误都记为 `unreadable`,但测试以同一用户 / 管理员运行,无法稳定构造 Windows ACL 拒绝,该分支没有真实用例。`/api/sessions/:id` 遇到 `EACCES` 时 `readSessionDir` 的错误不被 `SessionCorruptionError` 分支捕获,由顶层兜底为 500 `internal_error`,未映射为 403 / 404。
- **影响**: 权限受限目录只能显示为「N 个会话目录不可读」,无法区分损坏与 ACL;详情请求返回泛化的内部错误,缺少可操作信息。
- **触发升级条件**: 真实环境出现 ACL / 只读介质拒绝;或需要区分错误类型。
- **修复建议**: 显式把 `EACCES` / `EPERM` 映射为 403 `session_forbidden`;在 Windows 上用 `icacls` 构造拒绝访问并补集成测试。

### D-071 · `fs` 不响应 `AbortSignal`,取消后大文件 IO 仍继续

- **发现**: 2026-10-18,维度4 Task1 审查修复。(注: 原拟编号 D-051/D-052 已被前端任务占用,顺延为 D-071/D-072。)
- **现象**: `fsTool.execute` 签收 `signal` 但从未读取;`read` 的 `createReadStream`、`edit` 的 `readFile`/`writeFile`、`write` 的 `writeFile` 均未接取消。管线超时/abort 只影响结果返回,不会终止已发起的文件 IO。
- **影响**: 会话取消或工具超时后,超大文件的读/写仍可能继续占用句柄与磁盘带宽;`read` 在启动后到首次命中截断前不会主动停止。
- **触发升级条件**: 取消后出现长时间 IO 占用、句柄泄漏,或接入 P1 权限层需要强制终止工具。
- **修复建议**: 把 `signal` 传给流并在 abort 时 `destroy()`,读循环内检查 `signal.aborted` 并关闭 `readline`;`readFile`/`writeFile` 前先快速检查 abort,失败返回结构化 `aborted`。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier): `fs.read` 把 signal 传给 `createReadStream` 并在读循环检查;`write/edit` 在操作前后检查并把 signal 传给 `readFile`/`writeFile`;取消返回 `aborted`，write/edit 明确提示可能留下部分文件。

### D-072 · `edit` 唯一性按非重叠匹配计数

- **发现**: 2026-10-18,维度4 Task1 审查修复。
- **现象**: `edit` 从 `first + needle.length` 继续查找第二处,重叠出现不计。例如内容 `aaa`、`oldText: "aa"` 被视为唯一匹配并替换为 `ba`。
- **影响**: 与“出现次数”的直觉不同;模型可能预期重叠匹配报 `edit_not_unique`。当前行为已在 design §4.2 明确为非重叠。
- **触发升级条件**: 实测需要重叠匹配语义,或模型反复因该差异产生错误编辑。
- **修复建议**: 若需重叠计数,用滑动窗口统计所有起点并在 `>1` 时返回 `edit_not_unique`;否则保持并补一条固化非重叠语义的测试。

### D-073 · 保留设备名未覆盖上标数字变体(`COM¹`/`LPT¹` 等)

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`WINDOWS_RESERVED` 扩展 `¹²³` 变体与 `CONIN$`/`CONOUT$`;补写/编辑用例。
- **发现**: 2026-10-18,维度4 Task1 收尾修复。
- **现象**: Windows 同时把 `COM¹`/`COM²`/`COM³`、`LPT¹`/`LPT²`/`LPT³` 等上标数字形式视为保留设备名,当前 `WINDOWS_RESERVED` 仅匹配 ASCII `1-9`,这类路径会放行到 `writeFile`/`edit`。`CONIN$`/`CONOUT$` 等控制台别名也未覆盖。
- **影响**: 在 Windows 上写入这些名称可能落到设备而非工作区文件;行为依赖系统,跨平台一致性差。
- **触发升级条件**: 出现模型/用户使用上标设备名写文件,或权限层要求 Windows 路径语义完备。
- **修复建议**: 将保留名匹配扩展为 Unicode 上标数字(`¹²³`)并显式列出 `CONIN$`/`CONOUT$`;补对应测试,保持现有规范化流程不变。

### D-074 · `shell` 的 cwd 校验与 spawn 之间存在 symlink TOCTOU

- **发现**: 2026-10-18,维度4 Task2 审查修复。
- **现象**: `resolveCwd` 先用 `resolveInWorkdir` 做词法边界与最近已存在祖先的 `realpath` 校验,随后才把字符串路径交给 `spawn` 的 `cwd`。两步之间若 workdir 内目录被替换为指向 workdir 外的 symlink/junction,子进程会在越界目录执行,已有校验不会感知。
- **影响**: 边界校验不是原子操作;本机并发进程可在窗口内绕过 workdir 限制。P0 单用户场景风险低,但语义上“cwd 在 workdir 内”并不严格成立。
- **触发升级条件**: 接入多用户/权限层,或工作区可能被不可信进程并发修改;需要给出“cwd 绝不越界”的强保证。
- **修复建议**: 在支持的平台用已打开目录句柄启动进程(`fchdir`/`posix_spawn`),或在 spawn 前紧邻地再次 `lstat`/`realpath` 并比较;Windows 可结合目录句柄与 job object 校验,失败返回结构化错误。

### D-075 · `shell` abort 只发一次且无升级/兜底,Promise 可能不 settle

- **发现**: 2026-10-18,维度4 Task2 复审。
- **现象**: `runCommand` 在 abort 事件里只调用一次 `terminateTree`(Windows `taskkill /T /F`、POSIX `kill(-pid)`),没有检查失败、重试或升级为 SIGKILL;`Promise` 只在子进程 `close`/`error` 事件到达时 settle。若 kill 因权限、PID 回收或进程忽略信号而失败,且两个事件都不到达,`execute` 会长期 pending。
- **影响**: 取消不保证“进程结束 + 结果返回”两件事同时成立;上层若未设置超时,会话可能挂住;进程残留会占用串口/OpenOCD 句柄,与嵌入式场景的清理要求冲突。
- **触发升级条件**: 实现工具级超时或出现 abort 后不返回/进程残留的真实现象。
- **修复建议**: abort 后启动短定时器兜底 `finish(shell_aborted)` 并记录 kill 失败;POSIX 在宽限期后升级 `SIGKILL`,Windows 失败时二次 `taskkill` 或改用 job object;把 kill 失败原因写入 `detail`。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier): abort 后 1s 升级 `SIGKILL`/再次 `taskkill`,3s 仍未确认则返回 `shell_aborted` 并写 `detail.abortEscalated`/`terminateFailed`,Promise 必 settle;文本显式声明“process termination not confirmed”。

### D-076 · `shell` 的 `exitSignal` 与 `code=null` 语义存在平台边缘

- **发现**: 2026-10-18,维度4 Task2 复审。
- **现象**: Node `close(code, signal)` 在 POSIX 被信号杀死时通常 `code=null, signal=<sig>`;Windows 上 `taskkill` 后常见 `code=1, signal=null`。当前实现只在 `signal !== null` 时返回 `shell_terminated`,若出现 `code===null && signal===null` 的异常组合,会落入正常分支并用 `code ?? 1` 把 null 伪装成退出码 1。同一次 abort 在不同平台的 `detail` 形状不一致。
- **影响**: 依赖 `exitCode`/`signal` 的消费者(日志回放、前端展示、模型决策)需要理解平台差异;极端情况下 null 被误报为 1,违反“不伪造事实”的诚实原则。
- **触发升级条件**: 跨平台回放需要一致的终止语义,或出现 `code=null` 的实际观测。
- **修复建议**: 把 `code===null && signal===null` 显式建模为 `shell_terminated`(detail 保持 `exitCode:null`)或新增 `shell_unknown`;统一各平台 detail 契约并补跨平台契约测试。

### D-077 · `glob` / `grep` 不响应 `AbortSignal`

- **发现**: 2026-10-18,维度4 Task6 收尾。
- **现象**: `globTool.execute` / `grepTool.execute` 签收 `signal` 但从未读取;`walkFiles` 的递归遍历、`grep` 的逐文件 `stat`/`readFile` 与逐行匹配都不检查取消。
- **影响**: 会话取消或管线超时后,遍历仍会继续扫完 5000 个文件并读盘;大目录或 2 MiB 文件较多时,取消不能缩短实际耗时,只能让上层提前返回。
- **触发升级条件**: 出现取消后长时间占用磁盘/句柄,或接入工具级强制终止与超时预算。
- **修复建议**: 给 `walkFiles` 传入 `signal`,在每个条目/每次递归前检查并返回 `aborted`;`grep` 在 `stat`、`readFile` 与行循环内检查;工具返回结构化 `aborted` 而不是伪造空结果。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier): `walkFiles` 接收 signal 并在每个条目/递归/访问前 `throwIfAborted`;`glob`/`grep` 捕获 AbortError 返回 `aborted`;`grep` 在文件读取前与每 256 行检查取消。

### D-078 · `grep` 先收集全部命中再排序截断

- **发现**: 2026-10-18,维度4 Task6 收尾。
- **现象**: `grep` 把所有命中行压入 `matches`,遍历结束后统一排序,再用 `maxResults` 截取输出。`maxResults` 只限制返回条数,不限制收集量。
- **影响**: 命中密集的大仓库会随命中数线性增长内存与排序耗时;即使只需要 200 条也要读完整个工具根,与“结果上限”的直觉不符。
- **触发升级条件**: 出现内存峰值、响应超时,或需要在大仓库上稳定低延迟。
- **修复建议**: 遍历时按文件路径有序处理并维护有界结果集(或命中达到硬上限后提前停止);至少在 `detail` 暴露 `matched` 已收集量并允许调用方设置收集上限。

### D-079 · `glob` / `grep` 显式 `path` 根为 symlink 时跟随

- **发现**: 2026-10-18,维度4 Task6 收尾。
- **现象**: 遍历中遇到的 symlink 文件/目录由 `walkFiles` 跳过,但显式 `path` 根本身若为 symlink/junction,`stat` 与 `readdir` 会跟随其目标;`resolveInWorkdir` 只做 realpath 边界校验,不改变返回的 `target`。
- **影响**: 同一工具对“根”和“内部链接”采用不同语义;根链接指向工具根内另一子树时,结果路径仍相对工具根,但扫描范围与用户直觉不同。
- **触发升级条件**: 需要统一的“绝不跟随 symlink”语义,或出现根链接导致的范围误判。
- **修复建议**: 对显式根先 `lstat` 并拒绝 symlink(返回 `path_invalid`/`not_a_directory`),或在 design/README 明确“仅遍历中不跟随”并补根链接用例固化语义。

### D-080 · `scanTruncated` 在达到 5000 文件后遇到任意后续条目即标记

- **发现**: 2026-10-18,维度4 Task6 收尾;2026-10-19 按实测修正描述。
- **实测**: `walkFiles` 在循环顶部判断 `state.scanned >= maxScanned`;恰好扫描 5000 个文件且之后没有剩余条目时不标记(`glob`/`grep` 均有「恰好 5000 个文件不标记」用例);达到上限后只要还有任意后续条目——包括目录、将被忽略的目录或 symlink——就会标记截断。
- **影响**: 标记本身不再误报「刚好扫满」;但仍无法区分后续条目里是否真有可扫描文件,例如 5000 个文件后跟一个空目录或被忽略目录也会标记,可能触发不必要的缩小范围重试。
- **触发升级条件**: 需要精确判断是否遗漏文件,或出现因误报截断导致的重复扫描。
- **修复建议**: 仅当后续存在可扫描文件时标记;或在 `detail` 增加 `scanned`/`maxScanned` 与 `possiblyTruncated` 字段,把保守语义显式化。

### D-081 · `glob` 的 `*` 与 `**` 匹配点开头的隐藏文件

- **发现**: 2026-10-18,维度4 Task6 收尾。
- **现象**: `compilePattern` 把 `*` 编译为 `[^/]*`、`**` 编译为 `.*`,都不排除 `.` 开头的条目;与常见 shell glob 默认跳过隐藏文件的行为相反。`description` 已写明 `*` 也匹配隐藏文件。
- **影响**: 模型按惯例写 `*` 或 `**/*` 时会额外得到 `.env`、`.gitignore` 等;虽然 `.git`/`.harness` 等目录已被忽略,但根级隐藏文件仍会进入结果,可能干扰判断。
- **触发升级条件**: 模型反复因隐藏文件产生误判,或需要与 shell glob 语义对齐。
- **修复建议**: 增加 `dot` 选项或默认排除 `.` 开头条目,并同步 `description`、design 与测试;若保持现状,补一条固化“包含隐藏文件”语义的用例。

### D-082 · 工具根与 resume 的 workdir 仅词法比较,不解析 symlink / 8.3 短名

- **发现**: 2026-10-18,维度4 Task6 收尾。
- **现象**: `sameWorkdir` 只做 `path.resolve` + win32 `toLowerCase`;`resolveInWorkdir` 虽对最近已存在祖先做 `realpath` 边界校验,但工具根本身保留传入字符串。同一目录经 symlink/junction、Windows 8.3 短名或不同大小写表达时,比较结果可能不一致。
- **影响**: resume 时 `opts.cwd` 与 `header.workdir` 指向同一物理目录却抛 `workdir_mismatch`;工具输出的相对路径也可能因根形式不同而变化。
- **触发升级条件**: 真实出现误报,或需要跨工具根/跨会话的一致路径身份。
- **修复建议**: 比较前对两侧做 `realpath`(存在时)并统一大小写;Windows 短名用 `fs.realpath` 或 `GetLongPathName` 归一;补 symlink/短名用例。

### D-083 · `shell` 危险命令黑名单是启发式,可被 `env` / `bash -c` / `xargs` 绕过

- **发现**: 2026-10-18,维度4 Task6 收尾。
- **现象**: `isDangerousCommand` 按 `[\n\r;|&()]` 切段、跳过 env 前缀与 `sudo`/`command`,再识别固定命令名;`env rm -rf /`、`bash -c "rm -rf /"`、`sh -c ...`、`xargs rm`、脚本文件、别名/函数、PowerShell `Remove-Item` 等都不会命中。工具本身也明确标注“非沙箱”。
- **影响**: 黑名单只能降低误操作概率,不能保证危险命令不执行;模型或用户可通过包装命令绕过,与“危险命令绝不执行”的强保证存在差距。
- **触发升级条件**: 接入不可信输入/多用户权限层,或需要可审计的强制安全边界。
- **修复建议**: 改为白名单 + 执行前确认,或在受控 shell 中静态解析命令(AST)并按语义判断;保持 `description` 与 README 的“启发式、非沙箱”声明,避免消费者误当安全边界。

### D-084 · 读取/跳过上限只披露布尔标记或总数,不披露规模与具体路径

- **状态**: **部分解决**(2026-10-19,`fix/p0-remaining`):`fs read` 的 `detail` 增加 `nextOffset`;`grep`/`glob` 已分别披露文件/目录跳过数。仍未列具体跳过路径与总行数/字节数,保留跟踪。
- **发现**: 2026-10-18,维度4 Task6 收尾。
- **现象**: `fs read` 触达 2000 行 / 256 KiB 时只追加 `[truncated]`,`detail` 无总行数/总字节/下一次 `offset`;`grep` 对超过 2 MiB、含 NUL、不可读的文件只给 `[skipped N files ...]` 与分类计数,不列具体路径;`glob` 的 `[scan truncated at 5000 files]` 同样只有固定文案。
- **影响**: 模型无法判断遗漏规模,可能把“截断后未搜到”误当“不存在”;排查时需要人工重跑并猜测范围,与 R3 的“诚实披露”仍有距离。
- **触发升级条件**: 出现因截断/跳过导致的漏报、误判,或需要可复现的取证报告。
- **修复建议**: `fs read` 的 `detail` 增加 `totalLines`/`bytesRead`/`nextOffset`;`grep` 在 `detail` 增加受上限约束的 `skippedPaths` 或按类别列出前 N 个路径;`glob` 增加 `scanned`/`maxScanned`,让调用方可判断是否需要缩小范围。

### D-085 · `grep` 正则同步执行,ReDoS 会阻塞事件循环且不可中断

- **发现**: 2026-10-19,第一轮整体审查修复(I3)。
- **现象**: `grep` 对每行用 `new RegExp(...).test()` 同步匹配;恶意或失控正则(如 `(a+)+$`)在长行上可触发灾难性回溯,阻塞 Node 事件循环。1 MiB 单行上限与 2 MiB 文件上限降低但不消除风险;匹配期间不检查 `AbortSignal`,取消/超时只能等当前正则返回。
- **影响**: 单个文件即可让会话卡死;工具超时只能让管线提前返回,无法停止正在执行的正则,与 D-077「不响应取消」叠加。
- **触发升级条件**: 接入不可信 pattern/仓库;出现 grep 期间事件循环长时间无响应;需要硬性匹配超时。
- **修复建议**: 用 `worker_threads`/子进程隔离正则并支持终止,或引入线性时间正则引擎;至少在 `description` 与 README 标注「正则同步执行、ReDoS 不可中断」,并限制单次匹配时间或行数。

### D-086 · `glob` 编译仍可能触发正则回溯(ReDoS)

- **发现**: 2026-10-19,第二轮红队审查(I-1)。
- **现象**: `compilePattern` 把 `**/` 编译为 `(?:.*/)?`;本轮已限制 pattern 长度 ≤256、段数 ≤64,并把连续 `**/` 折叠为一个,但含多个可选 `.*` 段的模式在长路径失败匹配时仍可能多项式/指数回溯;`matchesGlob` 同步执行且不可中断,`grep` 的 `glob` 过滤对每个候选文件调用一次。
- **影响**: 恶意或失控 glob 可长时间占用 CPU、阻塞事件循环;`glob` 与带 `glob` 的 `grep` 均受影响,与 D-085(正则 ReDoS)、D-077(不响应取消)叠加。
- **触发升级条件**: 接入不可信 pattern/超深目录;出现 glob 匹配长时间无响应;需要硬性匹配超时。
- **修复建议**: 改用非回溯 glob 匹配器(按段 DP/贪心),或在 worker 中执行并限时;缓存/预编译 `grep` 的 glob。
- **状态**: 未解决;本轮仅做长度/段数上限与连续 `**/` 折叠。

### D-087 · `shell` 的 `atRoot` 只跟踪显式目录切换命令

- **发现**: 2026-10-19,第二轮红队审查(Minor 项)。
- **现象**: `isDangerousCommand` 只根据 `cd`/`pushd`/`chdir`/`Set-Location` 更新 `atRoot`;初始 `cwd` 若为根、或通过 `env -C /`、`sudo -D /`、`git -C /` 等改变目录时,后续 `rm -r *`/`rm -f *` 不会被判为根目标。`cd / && rm -rf .` 已按当前目录目标拦截,但其他改目录方式未覆盖。
- **影响**: 组合命令可能漏判根目标,拦截结果依赖命令书写形式;属启发式黑名单的已知边界。
- **触发升级条件**: 出现实际绕过;P1 权限层接入;需要把 shell 拦截当作安全边界。
- **修复建议**: 维护更完整的 cwd 语义,或在真实 cwd 上解析目标(需文件系统访问);最终由 P1 权限层兜底。
- **状态**: 未解决。

### D-088 · `shell` 引号归一不解析 shell 展开

- **发现**: 2026-10-19,第二轮红队审查(Minor 项)。
- **现象**: 危险判定前会移除 token 内所有 `'`/`"`,但不展开 `$'/'`、`${HOME:?}`、`$(...)`、`~user` 或变量拼接;例如 `rm -rf $'/'`、`rm -rf ${HOME:?}/*` 仍可绕过根目标判断。该缺口与 D-083(`env`/`bash -c`/`xargs` 包装)不同,属 shell 自身展开语义。此外,先按分隔符/空白切分再移除引号会改变 token 结构:引号内分隔符(如 `echo "safe; shutdown"`)会被误当真实命令边界(保守误拦);带空格的环境变量赋值(如 `FOO="a b" rm -rf /`)会被拆成多个 token,使首词不再是 `rm`,造成漏判。
- **影响**: 引号拼接类绕过已封堵,但展开类绕过仍在;黑名单不能作为安全边界。
- **触发升级条件**: 接入不可信输入;P1 权限层接入;出现实际绕过事故。
- **修复建议**: 不做完整 shell 解析则无法闭合;可引入 shell AST/静态分析,或在 P1 权限层按真实解析结果判定。
- **状态**: 未解决。

### D-089 · `grep` 跳过披露把目录计为 files 且不区分来源

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`walkFiles` 区分 `skippedFiles`/`skippedDirectories`,`grep` 文案改为 `[skipped N entries (X files, Y unreadable directories)]`,`detail.skipped` 拆分两项。
- **发现**: 2026-10-19,第二轮红队审查(I-2)。
- **现象**: `walkFiles` 的 `state.skipped`(不可读目录)已并入 `detail.skipped.unreadable` 与总数披露,但 `text` 仍写 `[skipped N files (binary/too large/unreadable)]`,无法区分文件与目录;根/嵌套不可读只给总数,不列路径。
- **影响**: 模型可能把不可读目录误判为文件;排障时无法定位具体不可读位置,与 D-084(披露粒度不足)叠加。
- **触发升级条件**: 需要精确定位不可读路径;权限问题频发;调用方依赖跳过分类做决策。
- **修复建议**: 拆分 `skippedFiles`/`skippedDirectories`,文案改为 entries 或分别披露;在受上限约束下记录前 N 个路径。
- **状态**: 未解决;本轮已完成目录跳过计入总数与 `detail.skipped`。

### D-090 · `grep` 的 `glob` 过滤每个文件重新编译正则

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):新增 `compileGlobMatcher`,`grep` 在遍历前预编译一次。
- **发现**: 2026-10-19,第二轮红队审查(Minor 项)。
- **现象**: `grep` 在遍历回调中对每个候选文件调用 `matchesGlob(relative, input.glob)`,而 `matchesGlob` 每次都会执行 `compilePattern`;`glob` 工具本身已在 `execute` 中编译一次后复用。
- **影响**: 大仓带 `glob` 过滤时产生重复编译开销;与 D-086 的回溯风险叠加,放大 CPU 占用。
- **触发升级条件**: 大仓/频繁 glob 过滤导致可观测性能下降;需要降低单次 grep 成本。
- **修复建议**: 预编译一次并把 `RegExp` 传入遍历回调,或导出编译函数/增加缓存。
- **状态**: 未解决;本轮仅保证非法 glob 返回 `invalid_pattern`。

### D-091 · 压缩打断 prompt cache 且无 `cached_tokens` 突降告警

- **发现**: 2026-10-19,维度3 Task5 收尾。
- **现象**: 二级/三级压缩会改变送入模型的消息前缀;`query` 只把 `cachedTokens` 写入 usage 事件,没有对 `prompt_tokens_details.cached_tokens` 的相对突降做告警或标记;压缩也不感知 provider 的缓存键。设计将其列为非目标,只要求记录告警。
- **影响**: 每次压缩后缓存命中可能归零,实际输入成本上升;`maxCostUsd` 仍按落日志 usage 计算,不会少算,但调用方无法从日志区分「压缩导致缓存失效」与「网关不返回缓存」。
- **触发升级条件**: 长会话成本可观测上升;网关支持 prompt cache 且稳定返回 `cached_tokens`;需要定位压缩与成本的因果关系。
- **修复建议**: 在 `query` 中比较相邻 usage 的 `cachedTokens / promptTokens`,突降超过阈值时追加显式告警(不改变行为);或把 compaction 事件与下一次 usage 关联。真正修复需保持前缀稳定,超出 P0 范围。
- **状态**: 未解决;当前仅登记告警需求,未实现告警。

### D-092 · 摘要质量与遗漏风险无校验

- **发现**: 2026-10-19,维度3 Task5 收尾。
- **现象**: `compactSession` 用固定 `SUMMARY_PROMPT` 让同一模型一次性生成摘要,不校验是否保留用户目标、决策、evidence 引用与精确标识符;生成后不回读核对,也不做多次采样或合并。
- **影响**: 关键细节可能丢失且无提示,模型后续基于不完整摘要行动;原始事件仍在日志、可人工回放,但自动流程无法察觉。
- **触发升级条件**: 摘要后出现答非所问或丢失约束;需要跨长会话继续任务;摘要成为主要上下文来源。
- **修复建议**: 结构化摘要(分节 + 必填字段)、生成后自检/重试,或允许注入自定义摘要器。
- **状态**: 未解决;当前只保证不改原始事件、失败显式落 `failed`。

### D-093 · 三级边界的逐事件 token 估算为近似值

- **发现**: 2026-10-19,维度3 Task5 收尾。
- **现象**: `computeTailBoundary` 按事件文本长度 / 4 逐事件累计;assistant 事件已计入 `tool_calls` 序列化长度(与 `heuristicCountTokens` 口径一致),但仍未计入 role/分隔符开销与 CJK 偏差;transcript 也按 UTF-16 代码单元计数/截断(仅保证不切断代理对),CJK 无按字符或 token 的校正(CJK/emoji 低估与 D-005 同源)。边界计算不使用 `TokenMeter` 的锚定 ratio,与预算检查口径不完全一致。
- **影响**: 尾部 16% 的实际保留量可能偏离目标;边界可能过早或过晚摘要,极端情况下产生额外 `failed` 或超出预期窗口。
- **触发升级条件**: 尾部包含大 `tool_calls` 或 CJK 内容;实测窗口与估算偏差显著;摘要频繁在临界点失败。
- **修复建议**: 统一用 `TokenMeter.measure` 对候选前缀做增量估算,或在边界计算中补齐 role/分隔符/CJK 估算并复用 ratio。
- **状态**: 未解决;当前边界只保证批次完整与 evidence 回退。

### D-094 · 摘要失败后无同轮自动重试

- **发现**: 2026-10-19,维度3 Task5 收尾。
- **现象**: 摘要 `complete` 抛非取消错误、transcript 无法投影或没有可摘要内容时,只追加 `compaction {kind:"failed", stage:"summary"}` 并返回;同一轮 `query` 不会重试,也不会降级为更小前缀。
- **影响**: 本次请求继续以超阈值消息发出(可能触窗或 4xx),下一轮才再次尝试;持续失败时每轮重复消耗一次失败调用。
- **触发升级条件**: 网关间歇 5xx/超时;摘要输入不可投影;摘要失败与窗口超限同时出现。
- **修复建议**: 同轮有限重试(区分 4xx/5xx)、失败后缩小 `coversUpToSeq` 重试,或熔断一段时间避免每轮重试。
- **状态**: 未解决;当前保证失败显式记录、取消传播。

### D-095 · `compaction` 事件随会话持续增长

- **发现**: 2026-10-19,维度3 Task5 收尾。
- **现象**: 每次越过软阈值都会追加 `microcompact` / `summary` / `failed` 事件;`microcompact` 的 `elidedSeqs` 只增不合并,旧 summary 事件永久保留。
- **影响**: 长会话日志体积与 `buildMessages` 扫描成本随压缩次数线性增长;rollover 提前触发;可回放性保留但事件噪声变大。
- **触发升级条件**: 会话持续数百轮或频繁压缩;日志 I/O 成为瓶颈;需要限制单会话日志上限。
- **修复建议**: 在 rollover 新代/归档层限定投影所需元数据(例如归档索引中合并连续 `microcompact` 的 `elidedSeqs`、只索引最后一条有效 summary),由投影层按需读取;不删除或改写既有事件,保持 append-only 与回放一致。
- **状态**: 未解决;当前不合并、不删除任何事件。

### D-096 · `keepRecentTurns` 默认 2 轮未经场景校准

- **发现**: 2026-10-19,维度3 Task5 收尾。
- **现象**: `keepRecentTurns` 默认 2 轮,按 assistant 批次计一轮;该值未按模型窗口、工具输出规模或任务类型校准,也没有配置合理性提示。
- **影响**: 值过小会过早修剪当前任务依赖的工具结果;值过大则二级压缩效果有限,提前进入摘要。默认 2 只覆盖常见短工具链。
- **触发升级条件**: 单轮包含大量工具调用;任务需要回溯多轮证据;不同模型窗口下压缩行为差异明显。
- **修复建议**: 基于 token 预算而非固定轮数保护近期结果,或在 `RunOptions.compaction` 上提供文档化建议值与运行时告警。
- **状态**: 未解决;当前允许调用方显式覆盖。

### D-097 · `compacted` 事件不区分压缩成功与失败

- **发现**: 2026-10-19,维度3 第一轮整体审查(Minor 项)。
- **现象**: `query` 在 compactor 返回后无条件 `yield { kind: "compacted" }`;`compactSession` 在摘要为空、被 `maxOutputTokens` 截断、边界 `no_progress`、摘要后仍超阈值(`still_over_budget`)或摘要调用失败时只追加 `compaction {kind:"failed"}` 并正常返回,因此事件流同样发出 `compacted`。摘要缺 usage 的 `status {status:"usage_missing",stage:"summary"}` 也只落日志,事件流不携带。另,`still_over_budget` 的 `failed` 事件在有效 `summary` 事件之后追加,日志可能同时存在成功摘要与 `failed`;调用方若只看最后一条 `failed` 判定摘要未生成会误判。
- **影响**: 调用方若以 `compacted` 判断压缩成功会误判;成功/失败仍可从会话日志区分,但事件流与日志语义不一致。
- **触发升级条件**: 调用方依赖事件流做重试、成本提示或 UI 状态;需要把压缩结果暴露给上层。
- **修复建议**: 让 compactor 返回结果并由 `query` 携带成功/失败信息,或新增显式 `compaction_result` 事件;保持事件流与日志一致。
- **状态**: 未解决;README 已注明 `compacted` 仅表示"本轮压缩尝试结束"。

### D-098 · 坏 summary 容错与 `failed.stage:"microcompact"` 分支未闭环

- **发现**: 2026-10-19,维度3 第一轮整体审查(Minor 项)。
- **现象**: `buildMessages` 已对空/越界/非整数、落在批次中间、覆盖 evidence 的 summary 回退上一条有效 summary(无则原视图),但不会追加降级标记或告警;`compactSession` 仍没有追加 `failed.stage:"microcompact"` 的路径(二级只在 append 前做纯内存筛选)。
- **影响**: 损坏日志可能静默退化为全量视图,或在每次压缩时重复触发摘要/`no_progress`;二级阶段若未来引入 I/O 或裁剪失败,无法按 `stage` 区分。
- **触发升级条件**: 出现真实坏 summary 日志;microcompact 阶段引入可失败操作;需要按阶段统计压缩失败。
- **修复建议**: 为无效 summary 追加一次性降级标记/告警并明确重建策略;二级失败时补 `failed.stage:"microcompact"` 记录与测试。
- **状态**: 未解决;本轮不扩大范围。

### D-099 · 单条结果或近期批次超窗时仅有 `still_over_budget`

- **发现**: 2026-10-19,维度3 第二轮红队审查(I-2)。
- **现象**: 默认 `keepRecentTurns=2` 会保护最近批次不被 microcompact;若单个工具结果或最近批次本身超过 `contextWindow * softRatio`,二级无法修剪,三级摘要又必须保留尾部,摘落后重新测量仍超阈值。首轮追加 `compaction {kind:"failed",reason:"still_over_budget",stage:"summary"}` 并继续以超窗消息请求;后续轮因尾部边界不再前进,会命中 `no_progress`,不会再次调用摘要。另,`no_progress` 门槛取旧 summary 事件 `seq` 而非旧 `coversUpToSeq`;当新边界落在 `(旧 coversUpToSeq, 旧 summary.seq]` 时,边界相对旧 covers 已前进但仍判 `no_progress`,压缩会持续停滞(该口径用于避免新摘要丢失旧摘要文本)。
- **影响**: 极端大结果下压缩无法把视图降到软阈值以内,仍可能触窗或 4xx;首轮记 `still_over_budget`,之后每轮只记 `no_progress`,没有降级路径。
- **触发升级条件**: 单条工具结果接近或超过窗口;近期批次包含多个大结果;网关因超窗持续拒绝。
- **修复建议**: 一级截断按单条结果强制落盘并进一步缩短模型视图;允许把最近批次中的非 evidence 结果降级为占位;或在 `still_over_budget` 时触发更小尾部/更强摘要策略。
- **状态**: **已缓解**(2026-10-19,fix/p0-a-tier): 摘要后仍超阈值时执行 emergency microcompact,忽略 `keepRecentTurns`;非 evidence 大结果直接占位,`artifactPath` 存在的 evidence 降级为 artifact 引用,降到阈值内则不再落 `still_over_budget`。无 artifact 的 evidence-only 超窗仍只能记录 `still_over_budget`/`no_progress`(见 D-110)。

### D-100 · MCP 工具名消歧依赖 server 返回顺序

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`createMcpTools` 先按 `(server, tool)` 字典序排序再分配名称;补稳定顺序断言。
- **发现**: 2026-10-19,维度5 Task3 复核(N-4)。
- **现象**: `createMcpTools` 按 `manager.tools()` 顺序逐个占用名称。若 A 工具的基础名被 B 的确定性改名占用,后续工具会被连锁改名;同一批工具仅因 `listTools()` 返回顺序不同,最终暴露名可能不同。结果为全局唯一,且对同一输入列表确定。
- **影响**: 模型看到的工具名可能随 server 实现/升级改变,历史会话中的工具名与权限规则(P1 按名寻址)可能失配;不改名工具不受影响。
- **触发升级条件**: P1 权限规则按工具名持久化;跨会话回放依赖工具名稳定性;server 返回顺序被观察到变化并导致自动化脚本失败。
- **修复建议**: 消歧前先按 `(server, tool)` 字典序排序稳定输入,或改为「先检测全部冲突、再按排序分配」;把最终映射写入会话/配置以便审计。

### D-101 · MCP status 写入与 close 的迟到竞态

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`runSession` 的 `finally` 改为先 `mcpManager.close()`(停止 list_changed/refresh),再 flush status 队列,最后关闭 session。
- **发现**: 2026-10-19,维度5 Task4 第二轮复核(N-5)。
- **现象**: `runSession` 在 `finally` 中先 `await statusQueue` 再 `manager.close()`/`session.close()`。若某个 refresh 任务在 `await statusQueue` 之后才同步触发 listener 并入队 status,该写入会落在已关闭的 session 上;`appendMcpStatus` 在首个失败时立即输出 `[mcp] status event append failed`(迟到入队同样会输出)并继续关闭,但该条审计事件仍会丢失,且不重试。
- **影响**: list_changed 与会话结束高度重叠时可能丢失最后一条 `mcp_tools_changed`/`mcp_tools_refresh_failed` 审计;不影响工具调用结果与主会话退出码。
- **触发升级条件**: 自动化依赖会话日志完整审计 MCP 工具变更;观察到 close 与 list_changed 并发导致 status 缺失;需要强一致事件序列。
- **修复建议**: close 前先停止接收 refresh/listener(关闭标志或取消 token),再 flush 一次 status 队列;或为 status 写入增加有界重试/独立 sink。

### D-102 · MCP server 继承完整进程环境变量

- **发现**: 2026-10-19,维度5 Task2。
- **现象**: `McpManager` 以 `{...process.env, ...config.env}` 启动子进程(PATH/HOME 必需),因此 provider API key、代理凭据等敏感变量对第三方 MCP server 可见;配置只能覆盖,不能移除单个继承变量。
- **影响**: 不可信或供应链被污染的 server 可读取会话进程的密钥;不影响本仓库自身密钥管理,但扩大了信任边界。
- **触发升级条件**: 接入首个非自研/第三方 MCP server;安全评审要求最小环境;需要按 server 配置 allowlist。
- **修复建议**: 为 server 配置增加 `envAllowlist`/`envPassthrough`,默认仅传 PATH/HOME 等白名单;或提供显式 `inheritEnv: false`。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier): 默认仅传 PATH/HOME/SystemRoot/TEMP 等白名单;`inheritEnv: true` 恢复完整继承,`envAllowlist: [...]` 显式放行额外变量;`config.env` 始终覆盖。`inheritEnv: true` 属于显式放宽,敏感变量风险由配置方承担(设计取舍,不是未完成项)。

### D-103 · MCP 配置未知字段被静默忽略

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`loadMcpConfig` 新增 `onWarning`,未知 server 字段经 `mcp_config_warning` status 披露;不加 `onWarning` 时保持原宽松行为。
- **发现**: 2026-10-19,维度5 Task1。
- **现象**: `parseServer` 只校验已知字段,可选字段的拼写错误(如 `timeoutMS`、`arg`)不报错,直接按缺省值继续;若必填的 `command` 拼错(如 `commandd`),单级配置会因 `merged.command === undefined` 抛 `McpConfigError` 并跳过全部 MCP(另一级仍提供 command 时合并后不会报错)。
- **影响**: 配置 typo 不会 fail-fast,可能表现为超时/参数与预期不符;与 `command` 严格校验的风格不一致。
- **触发升级条件**: 配置由用户手写且出错难定位;需要配置 lint/诊断;出现因 typo 导致的现场问题。
- **修复建议**: 对未知字段输出 warning 或严格模式报错;在配置加载结果中保留原始 key 供 `mcp_config_failed` 诊断。

### D-104 · list_changed 刷新失败不自动重试

- **状态**: **已解决**(2026-10-19,`fix/p0-remaining`):`refreshTools` 有界重试 3 次(100ms 指数退避),最终失败仍保留旧缓存并记 `tools_refresh_failed{attempts:3}`。
- **发现**: 2026-10-19,维度5 Task2/Task4。
- **现象**: 刷新 `listTools()` 失败时保留旧缓存并记 `mcp_tools_refresh_failed`,不安排退避重试;只有下一次 list_changed 通知或连接重建才会再次刷新。
- **影响**: server 短暂抖动后工具集合可能长期停留在旧版本;模型继续看到已移除的工具或看不到新增工具,调用时以工具执行错误暴露。
- **触发升级条件**: server 侧工具频繁热更新;观察到刷新失败后长时间不恢复;需要工具目录强一致。
- **修复建议**: 失败后按指数退避重试有限次,并在 status 中记录 attempt;或在每轮请求前按 TTL 做一次惰性刷新。

### D-105 · 项目级 MCP 配置在会话启动时自动执行命令,无信任门槛

- **发现**: 2026-10-19,维度5全量复验。
- **现象**: `loadMcpConfig` 默认读取 `<workdir>/.harness/mcp.json`, `runSession` 随后直接 `new McpManager` + `connectAll()`,把配置中的 `command` 作为子进程启动。workdir 可能来自不可信仓库;当前没有 trust/审批或用户确认,也没有跳过项目配置的开关。
- **影响**: 打开/进入不可信工作区即可在会话启动阶段执行任意命令(且继承进程环境,见 D-102),发生在任何模型或工具调用之前;这是比“模型调用破坏性工具”更早的信任边界。
- **触发升级条件**: 首个不可信仓库/第三方工作区;多用户或共享工作区;P1 权限/审批层接入。
- **修复建议**: 项目配置默认不加载,需显式 `mcp.trustProjectConfig:true`(或按内容 hash 记录一次性信任);跳过时写 `mcp_project_config_skipped` status。显式传入的 `projectConfigPath` 视为调用方已信任。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier;实现与测试见 README「MCP 客户端」与 `tests/mcp-*`)。

### D-106 · MCP 连接类错误后的重试可能重复执行破坏性工具

- **发现**: 2026-10-19,维度5全量复验。
- **现象**: `performCall` 把连接类错误视为“调用未送达”并重连重试一次。但 `SendFailed`/`ConnectionClosed` 可能发生在 server 已执行工具之后、响应到达 client 之前;重试会让破坏性工具(写内存/复位)执行两次。`annotations.destructive` 未参与重试判断。
- **影响**: 设备状态可能被重复修改,违反 R2 的“先声明、可审计”预期;当前 P0 echo/fixture 无影响,P1 真硬件前必须处理。
- **触发升级条件**: 首个破坏性 MCP 工具;P1 真硬件;stdio/串口链路不稳定。
- **修复建议**: 对 `destructive:true` 的工具禁用自动重试,返回独立错误码(如 `mcp_uncertain`)并要求显式复核/人工确认;非破坏性工具保持一次重试。MCP 本身没有幂等键,不能靠重试保证 at-most-once。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier;实现与测试见 README「MCP 客户端」与 `tests/mcp-*`)。

### D-107 · MCP `listTools()` 未显式设置超时

- **发现**: 2026-10-19,维度5全量复验。
- **现象**: `connectServer`/`refreshTools` 的 `client.listTools()` 没有传 timeout,使用 MCP SDK 默认 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`;连接阶段的 15s 超时不覆盖工具发现。`connectAll` 会等待所有 server 的 `listTools()`;`list_changed` 刷新还会占用该 server 的串行队列。
- **影响**: server 连接成功但不响应 `tools/list` 时,会话启动最多多等约 60s;刷新期间同 server 的调用被队列阻塞,病态 server 可拖慢整个会话。
- **触发升级条件**: 病态/慢 server;启动时延 SLA;需要把连接+发现纳入同一超时预算。
- **修复建议**: 给 `listTools()` 传 `{ timeout: ... }`,使用 `min(connectTimeoutMs, timeoutMs, 上限)`;连接与首次 `listTools` 共享预算或分别有明确上限;补“连接成功但 tools/list 挂起”用例。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier;实现与测试见 README「MCP 客户端」与 `tests/mcp-*`)。

### D-108 · MCP content/schema 无大小上限

- **发现**: 2026-10-19,维度5全量复验。
- **现象**: `McpManager.toResult` 把所有 content block 拼接/`JSON.stringify` 后才交给管线截断;`inputSchema` 与 `description` 也原样进入模型请求,没有大小检查。管线截断发生在完整字符串已在内存中之后,且 schema/description 每次请求都会重复发送。
- **影响**: 异常或恶意 server 可造成瞬时内存压力、上下文膨胀和按请求计费上升;与 D-102 的不可信 server 前提叠加。
- **触发升级条件**: 首个第三方/不可信 server;大输出工具;需要限制单次调用开销。
- **修复建议**: 对 content 按字节/条数封顶并标记 `truncated`,对 `structuredContent`/非 text 序列化同样封顶;对 `description`/`inputSchema` 设上限,超限跳过或截断并记 status。保留现有管线截断作为第二道防线。
- **状态**: **已解决**(2026-10-19,fix/p0-a-tier;实现与测试见 README「MCP 客户端」与 `tests/mcp-*`)。

### D-109 · 自定义/第三方 in-process 工具缺少强制终止(worker/进程隔离)

- **发现**: 2026-10-19,B 档收尾。
- **现象**: pipeline 在超时/取消后能阻止同批后续写调用,但工具仍在本进程内执行;若自定义/第三方工具忽略 `AbortSignal`,JavaScript 没有强制终止手段。内置 `fs`/`shell`/`glob`/`grep` 已响应 signal(D-071/D-077 已解决)。
- **影响**: 忽略 signal 的工具可继续占用 CPU/IO 或操作硬件;pipeline 屏障避免后续调用重叠,但不能回收工具本身。
- **触发升级条件**: P1 接入第三方工具或真实写工具;需要硬性工具级超时/隔离;出现取消后残留执行事故。
- **修复建议**: 每个工具在 `worker_threads`/子进程执行并可 terminate/kill;或对非内置工具建立“必须响应 signal”的契约,超时后标记会话需人工确认。
- **状态**: 未解决;P1 架构项。

### D-110 · 无 artifact 的 evidence 超窗仍无法 emergency 降级

- **发现**: 2026-10-19,B 档收尾。
- **现象**: emergency microcompact 只对非 evidence 或带 `artifactPath` 的 evidence 生效;无 artifact 的 evidence 超过窗口时仍只能保留并落 `still_over_budget`/`no_progress`。
- **影响**: 极端大的 evidence 结果(且未触发一级落盘)仍可能触窗或 4xx;证据保护与窗口上限之间没有自动路径。
- **触发升级条件**: 真实探针/寄存器读结果接近窗口;一级落盘阈值未覆盖;需要零残窗。
- **修复建议**: emergency 前强制把 evidence 文本写入 `artifacts/`,并扩展 `CompactionPayload.microcompact` 携带 `artifactPaths`(seq→path),投影层优先使用该路径;保留原始日志与 evidence 标记。
- **状态**: 未解决;需要扩展 `CompactionPayload`/投影层。

### D-111 · P0 外部环境验证缺口(live 网关/真实 MCP/真机/终止失败路径)

- **发现**: 2026-10-19,B 档收尾。
- **现象**: `npm test` 的 live 网关用例因缺 `HARNESS_COMPAT_*` 环境变量 skip;MCP 仅使用本地 fixture;shell/MCP 终止失败路径只在 mock/spy 中验证;无真实探针/OpenOCD/串口。
- **影响**: 真实网关兼容性、第三方 MCP server 行为、Windows 权限/PID 回收下的终止语义、真机句柄回收尚未验证;不能据 mock 结果宣称现场可用。
- **触发升级条件**: P0 发布前/P1 真机前;接入真实网关或第三方 MCP server。
- **修复建议**: 建立三组验收环境——(1) live 网关三 env 跑 `HARNESS_COMPAT_LIVE=1 npm test`;(2) 至少一个第三方 MCP server 的连接/调用/终止/断线重连;(3) 真机探针写/复位与串口句柄回收;记录命令、退出码与日志。
- **状态**: 未解决;环境验证缺口,非本地代码缺陷。

### D-112 · 阶段 1 审批通道只有库层接口,Web/SSE 未实现;headless 下 ask 一律 deny

- **发现**: 2026-10-19,M2 权限系统 Task 8。
- **现象**: 阶段 1 只提供 `PermissionPrompter` 库接口;`runSession` 不内置审批器;headless demo 与 Web 后端不注入 prompter,`ask` 直接落 `effective: "deny"`(`reason: "approval_unavailable"`)。Web 的 `/api/actions` 仍返回 501;`/api/events` 仅提供只读事件流,前端没有审批 UI(见 D-137)。
- **影响**: 默认 `diagnose` 下写工具在 headless/Web 无法经人工批准执行,只能改预设或配置放行;审批记录只能从会话日志离线查看。
- **触发升级条件**: 阶段 2 接入 Web 审批/SSE;需要人工在 UI 中批准工具调用;需要实时展示待审批请求。
- **修复建议**: 定义审批请求/响应事件与 HTTP API,与 `permission_decision` 同源;前端展示工具名、参数摘要与原因并回传 allow/deny;保持“审计先于执行”和超时/取消语义。
- **状态**: **已解决**(2026-10-20,`feat/m2-web-approval`,Web 部分):Web 进程注入审批桥,`ask` 经 `approval_request` + `POST /api/approvals` 完成人工批准或拒绝,`/api/actions` 不再返回 501;headless demo 与未注入 prompter 的库调用仍按 `approval_unavailable` deny(设计如此)。实现见 D-137。

### D-113 · `paramsPreview` 可能保留最多 120 字符的敏感参数片段

- **发现**: 2026-10-19,M2 权限系统 Task 8。
- **现象**: 审计摘要对字符串保留前 120 个码点,`paramsPreview` 整体最多 4096 UTF-8 字节;不区分密钥、令牌、绝对路径、设备序列号等敏感键,也不提供脱敏配置。
- **影响**: 会话日志被分享、归档或上传时可能泄露敏感片段;仅 `paramsDigest`/`paramsKeys` 无法避免 preview 中的明文。
- **触发升级条件**: 接入含密钥/凭据/隐私参数的工具;日志需要外发、长期归档或跨团队共享;出现合规要求。
- **修复建议**: 增加按工具/键的脱敏配置或默认关闭 preview;必要时只保留 digest/keys;对已知敏感键建立内置黑名单并写入文档。
- **状态**: 未解决;需要脱敏策略。

### D-114 · 权限规则是声明式匹配而非沙箱,不替代 shell 黑名单、fs 路径安全或 OS 隔离

- **发现**: 2026-10-19,M2 权限系统 Task 8。
- **现象**: 规则只按工具名与参数决定 allow/ask/deny;allow 后仍由 `shell` 危险命令黑名单、`fs` 的 `resolveInWorkdir` 与 OS 权限各自把关。权限层不限制网络、文件系统范围、进程权限或资源使用。
- **影响**: 规则误配(例如对 `shell` 全 allow)仍可执行任意命令;黑名单与路径检查可被绕过的方式同样绕过权限层的安全预期;不能据此宣称强隔离。
- **触发升级条件**: 接入不可信模型或多租户;需要合规/安全边界;出现越权或逃逸事故。
- **修复建议**: 以 OS 沙箱/容器/最小权限账户提供强隔离,并限制网络与文件系统;权限层只承担策略判定与审计,不承担隔离。
- **状态**: 未解决;架构边界,非本轮代码缺陷。

### D-115 · 串行批次第 N 条审计写失败时前 N−1 条已执行,结果可能未落日志

- **发现**: 2026-10-19,M2 权限系统 Task 8。
- **现象**: 串行批次按“授权 → 审计 → 执行”逐条处理;第 N 条 `permission_decision` 写入失败时,前 N−1 条工具已执行,异常向上传播后主循环只能补 `tool_result_lost`,已执行结果可能没有对应日志。并发只读批次也先完成全部审计再执行,但执行阶段仍非事务。
- **影响**: 极端写失败/崩溃窗口下会出现“已执行但日志无结果”,与“日志是唯一事实源”的端到端保证存在缺口;不能声称执行与审计原子。
- **触发升级条件**: 真实写工具(探针写/复位)接入;审计或日志存储不可靠;需要执行-日志原子性。
- **修复建议**: 引入预写 intent/事务:执行前持久化调用意图,执行后写结果;写工具使用幂等操作 ID 并在恢复时对账;持续披露残余窗口。
- **状态**: 未解决;已知一致性边界。

### D-116 · `executeBatch` / `query` 是内部 API,直接调用可绕过权限层

- **发现**: 2026-10-19,M2 权限系统 Task 8。
- **现象**: `executeBatch` / `query` 位于内部模块(需深路径导入,未从 `src/index.ts` 导出),`BatchOptions.permission` 可省略,缺省保持 P0 的无判定行为;直接调用底层 API 不会经过 `runSession` 装配的 gate 与审计。
- **影响**: 第三方或后续内部调用若绕过 `runSession`,权限规则与 `permission_decision` 审计会被整体跳过;安全边界只在入口处成立。
- **触发升级条件**: 对外开放库 API;出现绕过入口的调用方;需要库层强制策略。
- **修复建议**: 将 gate 设为 `executeBatch` 必填或提供显式命名的 unsafe 选项;在类型/导出面标注不安全入口;补充“直接调用必须显式选择”测试与文档。
- **状态**: 未解决;内部 API 约定。

### D-117 · MCP 工具参数不应用 server `inputSchema` 默认值,参数规则只匹配实际提交值

- **发现**: 2026-10-19,M2 权限系统 Task 8。
- **现象**: MCP 工具的 Zod schema 是 `z.unknown()`,`safeParse` 不会应用 server `inputSchema` 的默认值或类型转换;权限参数规则与审计摘要都基于模型实际提交的参数。
- **影响**: 依赖 server 默认值的规则(例如期望未提交的 `address` 取默认 `0`)不会命中,可能表现为规则失效或误 deny;审计中的参数与实际生效参数可能不同。
- **触发升级条件**: MCP server 大量依赖默认值;规则需要按“生效参数”而非“提交参数”判定;出现因此产生的误判事故。
- **修复建议**: 在调用前按 server `inputSchema` 显式补默认值(需评估兼容性与安全影响);或要求模型显式提供参数并在文档中声明,保持判定与审计一致。
- **状态**: 未解决;MCP 参数边界。

### D-118 · `__proto__` 自有键在审计摘要与摘要哈希中被丢弃,可造成 digest 冲突

- **发现**: 2026-10-19,M2 权限系统 Task 4 review;全量复验确认。
- **现象**: 参数对象经 `JSON.parse` 得到自有 `__proto__` 键(模型对 `z.unknown()` 的 MCP 工具可直接提交)。`summarizeParams` 与 `stableStringify` 用 `target[key] = value` 构建普通对象,`__proto__` 命中原型 setter:该键被当作原型赋值,不成为自有键。实测 `{"__proto__":{"secret":"AAAA"},"path":"x"}` 与 `{"__proto__":{"secret":"BBBB"},"path":"x"}` 的 `digestParams` 完全相同(`4c99d722e6918fb1`),`stableStringify` 均输出 `{"path":"x"}`;`paramsKeys` 仍列出 `__proto__`,但 `paramsPreview` 缺失该键且其原型被改写为 `{type:"object",size:1}`。
- **影响**: 仅影响审计(判定走 `readPath` 的 `Object.hasOwn`,匹配不受影响)。两次参数仅在 `__proto__` 内容上不同的调用会得到相同 `paramsDigest`,审计无法区分;`paramsPreview` 丢失该字段,且预览对象原型被污染(局部对象,不污染全局)。
- **触发升级条件**: MCP/第三方工具允许任意对象参数且审计需要按 digest 唯一关联;出现因摘要冲突导致的取证歧义;需要对外导出审计摘要。
- **修复建议**: 用 `Object.create(null)` 构建摘要/序列化的中间对象,或对键做 `Object.defineProperty` 赋值;补 `__proto__`、`constructor`、`prototype` 键的回归用例。
- **状态**: **已解决**(2026-10-19,`feat/m2-permission`):`audit.ts` 新增 `setOwn`,`stableStringify`/`summarizeParams` 改用 `Object.defineProperty` 写入;新增 `__proto__` 自有键用例(keys/digest/preview 三处断言)。

### D-119 · 参数名 `truncated` 与预览截断标记同名时被覆盖

- **发现**: 2026-10-19,M2 权限系统 Task 4 review;全量复验确认。
- **现象**: `summarizeParams` 超预算时先写入用户键值,再执行 `truncatedPreview.truncated = true`。若模型提交的参数本身含 `truncated` 键(如实测 `{truncated:"user-value", x:"x".repeat(5000)}`),预览中的用户值被布尔 `true` 覆盖,无法区分“参数值”与“截断标记”。
- **影响**: 审计中该参数按截断标记解读,真实值丢失;`paramsDigest` 仍包含真实值,二者不一致。
- **触发升级条件**: 工具参数含 `truncated` 等保留名;审计需要从 preview 还原参数。
- **修复建议**: 改用不会与参数键冲突的保留键(如 `_truncated`),或把截断标记放在预览对象之外(如 `paramsPreviewTruncated` 字段)。
- **状态**: **已解决**(2026-10-19,`feat/m2-permission`):截断标记改为 `previewTruncated`,并计入 4096 字节预算;新增同名参数用例,README/spec 同步。

### D-120 · `loadPermissionConfig` 不校验 inline,导出库函数可绕过 schema

- **发现**: 2026-10-19,M2 权限系统 Task 2 review;全量复验确认。
- **现象**: `loadPermissionConfig` 直接把 `opts.inline` 合并进结果,不做 Zod 校验;实测 `inline: {preset:"yolo", rules:[{tool:"fs", action:"allow", bogus:1}]}` 原样返回(`preset=yolo`、未知字段保留)。`runSession` 入口会先经 `parseInlinePermissionConfig`,但该函数本身是导出的库 API。
- **影响**: 直接调用 `loadPermissionConfig` 的代码可注入非法预设与畸形规则;非法预设会在求值时回落为 `DEFAULT_ACTIONS[preset][access]` → `undefined`,`evaluatePolicy` 返回非枚举动作,gate 再按 deny 处理(不会 fail-open),但违规规则可能被静默接受。
- **触发升级条件**: 对外开放库 API;出现绕过 `runSession` 的调用方。
- **修复建议**: 在 `loadPermissionConfig` 内对 `inline` 复用 `parseInlinePermissionConfig`,或在类型/文档中明确该函数要求已校验输入。
- **状态**: **已解决**(2026-10-19,`feat/m2-permission`):`loadPermissionConfig` 对 `inline` 复用 `parseInlinePermissionConfig`;新增非法预设与未知规则字段用例。

### D-121 · 纯空白 `tool` / `reason` / `key` 被配置校验接受

- **发现**: 2026-10-19,M2 权限系统 Task 2 review;全量复验确认。
- **现象**: Zod schema 只校验 `min(1)`,不 `trim`。实测 `tool: "   "`、`reason: "   "`、`params.key: "   "` 均被 `parsePermissionConfig` 接受。
- **影响**: 空白规则通常不匹配任何工具,表现为“规则看似配置成功实则永不生效”;`reason: "   "` 会进入审计,理由不可读。
- **触发升级条件**: 用户手写配置且出现规则不生效;需要配置 lint。
- **修复建议**: 对 `tool`/`reason`/`key` 加 `trim().min(1)` 或 `.refine(v => v.trim().length > 0)`。
- **状态**: **已解决**(2026-10-19,`feat/m2-permission`):`tool`/`reason`/`key` 增加非空白 refine;三条纯空白用例覆盖。

### D-122 · 项目权限配置“存在但不可 stat”时静默不披露

- **发现**: 2026-10-19,M2 权限系统 Task 2 review;全量复验以 `.harness` 为普通文件的场景复现。
- **现象**: 未 trust 分支用 `fs.existsSync(projectConfigPath)` 判断是否存在;路径不可 stat(如父级 `.harness` 是文件、权限错误)时 `existsSync` 返回 false,既不读取也不写 `permissions_project_config_skipped`。trusted 分支此时 `readFileSync` 得到 ENOENT 也按“未配置”处理。实测两种情况均无披露。
- **影响**: 用户以为项目权限规则已生效或不生效,日志无任何提示;与 `mcp_project_config_skipped` 的披露语义不一致(参见 D-105)。
- **触发升级条件**: 需要排查“项目规则为何不生效”;多用户/共享工作区。
- **修复建议**: 用 `stat` 区分 ENOENT 与其他错误;非 ENOENT 时写 `status` 或抛 `PermissionConfigError`。
- **状态**: **已解决**(2026-10-19,`feat/m2-permission`):未信任分支改用 `statSync` 区分 ENOENT 与其他错误,非 ENOENT 抛 `read_failed`;新增 EACCES 用例。

### D-123 · resume 预读 header 与日志造成重复 IO

- **发现**: 2026-10-19,M2 权限系统 Task 7 review;全量复验确认。
- **现象**: `runSession` 的 resume 分支先 `stat(header.json)` 再 `readSessionDir(resumeDir)` 取 header 计算 cwd,随后 `planResume` 再次 `stat` + `readSessionDir` 完整读取同一日志。配置加载前移(`runSession` 装配 Task 7)放大了这次重复读取。
- **影响**: 只读、无副作用,但大日志 resume 的启动延迟与内存翻倍;并发写日志时两次读取可能看到不同内容(第二次为准)。
- **触发升级条件**: 会话日志达到 rollover 量级;resume 启动耗时成为问题。
- **修复建议**: 让 `planResume` 接收已读取的 `{header, events}` 快照,或在 `runSession` 侧复用第一次结果。
- **状态**: 未解决;性能边界。

### D-124 · 权限配置测试缺口:trust + 坏项目配置、resume skipped、inline 与 project 优先级、非有限 range

- **发现**: 2026-10-19,M2 权限系统 Task 2/7 review;全量复验确认无对应用例。
- **现象**: ①`trustProjectConfig:true` + 项目配置为坏 JSON/schema 的正例缺失(只有 untrusted 跳过与 trusted 生效两个 happy path);②resume 场景未断言 `permissions_project_config_skipped`;③`inline.preset` 对 project/user 文件 preset 的优先级无单测(代码顺序为 inline ?? project ?? user);④`range` 非有限值只在 JSON 路径被测,而 `JSON.parse("1e400")` 得到 `Infinity` 由 Zod 拒绝(实测 `invalid_schema`),缺少显式断言。
- **影响**: 上述行为当前正确,但后续修改(尤其配置优先级与错误路径)缺少回归保护。
- **触发升级条件**: 修改 `loadPermissionConfig` 合并顺序或 trust 语义;出现配置优先级事故。
- **修复建议**: 按四项各补 1 条用例。
- **状态**: **部分解决**(2026-10-19,`feat/m2-permission`):补齐 resume skipped、inline 对 project 文件优先级、`1e400` 非有限 range 用例;`trustProjectConfig:true` + 坏项目配置由既有「坏 project 配置（已信任）」用例覆盖。

### D-125 · 部分 `permissions` 校验用例未隔离 `HARNESS_HOME`

- **发现**: 2026-10-19,M2 权限系统 Task 7 review;全量复验确认。
- **现象**: `tests/permissions-integration.test.ts` 的 `attempt()` 辅助函数未 `vi.stubEnv("HARNESS_HOME", …)`,7 条类型错误用例与 4 条非普通对象用例因此使用真实 `~/.harness`。校验在创建会话前失败,实测未写入真实目录,但用例依赖该前提。
- **影响**: 若参数校验被移到 `createSession` 之后,这些用例会向真实 home 写入会话目录;测试结果受本机环境影响。
- **触发升级条件**: 调整 `runSession` 校验顺序;CI 环境共享 home。
- **修复建议**: 在 `attempt()` 内部创建临时 home 并 `stubEnv`,或让 `runSession` 的校验阶段完全不触碰 home。
- **状态**: **已解决**(2026-10-19,`feat/m2-permission`):`attempt()` 内创建临时 home 并 `stubEnv`。

### D-126 · `RunOptions.permissions` 的 symbol 键不参与未知键校验

- **发现**: 2026-10-19,M2 权限系统 Task 7 review;全量复验确认(代码路径)。
- **现象**: `normalizePermissionOptions` 用 `Object.keys(value)` 枚举未知键,只覆盖字符串键;symbol 键既不报错也不被读取,静默忽略。与“外层未知键一律 `PermissionConfigError`”的严格语义不一致。
- **影响**: 配置对象若通过符号键传递(反射/序列化库/错误拼写),不会 fail-fast;不影响判定结果。
- **触发升级条件**: 对外开放库 API;出现通过符号键注入配置的调用方。
- **修复建议**: 同时枚举 `Reflect.ownKeys(value)` 并对 symbol 键报错,或改用 `Object.getOwnPropertyNames` + 显式忽略。
- **状态**: **已解决**(2026-10-19,`feat/m2-permission`):改用 `Reflect.ownKeys`,symbol 键报 `invalid_schema`;新增用例。

### D-127 · 代码整洁:14 个新增文件缺末尾换行,`normalizeZero` 为空操作

- **发现**: 2026-10-19,M2 权限系统 Task 1/4/6/7 review 汇总;全量复验确认。
- **现象**: 缺 EOF 换行的新增文件包括 `src/permissions/{audit,config,errors,gate,rules,types}.ts`、`tests/permissions-{audit,config,gate,integration,query,rules}.test.ts`、`docs/superpowers/{plans/2026-10-19-permission-system.md,specs/2026-10-19-permission-system-design.md}`;`tests/session-persistence.test.ts`、`tests/ui/transcript.test.ts`、`src/tools/fs.ts`、`src/tools/shell.ts` 的缺换行为 main 既有状态。`rules.ts` 的 `normalizeZero` 在 `===` 比较下等价于原值(`-0 === 0`),当前为空操作。
- **影响**: 无功能影响;diff 噪声与潜在 `\ No newline` 标记;空操作函数易误导读者以为 `-0` 需要特殊处理。
- **触发升级条件**: 仓库引入 EOF 检查;需要清理 `rules.ts` 的可读性。
- **修复建议**: 批量补末尾换行;删除 `normalizeZero` 或在注释中说明其为显式语义文档。
- **状态**: **部分解决**(2026-10-19,`feat/m2-permission`):本轮新增/改动文件补齐 EOF 换行,`normalizeZero` 已删除(`-0 === 0`);`src/tools/fs.ts`、`src/tools/shell.ts` 等 main 既有文件保持原状。

### D-128 · 用例 `PermissionPreset 常量仍为四种` 为恒真断言

- **发现**: 2026-10-19,M2 权限系统 Task 7 review;全量复验确认。
- **现象**: `tests/permissions-integration.test.ts` 末尾该用例在本地字面量数组上断言 `new Set(presets).size === 4`;`PermissionPreset` 只是类型,运行时没有可被改动的值,断言恒真。
- **影响**: 该用例无法因生产代码变化而失败,给人一种“预设集合受测”的错觉;真正的回归保护来自 policy/config 用例。
- **触发升级条件**: 需要保证预设枚举与配置 schema/README 同步。
- **修复建议**: 改为对运行时来源断言(如解析四个预设名均通过 `parseInlinePermissionConfig`、第五个值被拒),或删除该用例。
- **状态**: **已解决**(2026-10-19,`feat/m2-permission`):恒真用例替换为 `parseInlinePermissionConfig` 的四预设接受/第五值拒绝断言。

### D-129 · query 层权限用例缺口:串行批次顺序、可选字段缺省、gate 返回值运行时校验

- **发现**: 2026-10-19,M2 权限系统 Task 6 review;全量复验确认。
- **现象**: ①`tests/permissions-query.test.ts` 全部使用 `echoTool`(`readOnly`),`executeBatch` 走并发两阶段路径,串行批次的“审计 → tool_result → 下一调用”事件顺序无 query 层用例;②未断言 `ruleIndex`/`paramsPreview` 缺省时事件中不存在该键;③`query` 直接信任 `PermissionGate` 返回结构,未做运行时字段校验(typed 契约)。
- **影响**: 串行路径的事件顺序与 parent 正确性只由 pipeline 层覆盖;gate 实现若返回缺失字段,审计事件会写入不完整 payload。
- **触发升级条件**: 修改 `query` 的批次循环或 gate 契约;第三方实现 `PermissionGate`。
- **修复建议**: 补一条写工具(串行)查询用例;补可选字段缺省断言;在 `query`/`onDecision` 处做最小运行时校验或明确文档化为内部契约。
- **状态**: **部分解决**(2026-10-19,`feat/m2-permission`):新增写工具串行批次用例(审计先于每次结果)并断言 `ruleIndex`/`paramsPreview` 缺省时键不存在;gate 返回值运行时校验仍按 typed 内部契约保留。

### D-130 · 审批期间 abort 的审计语义与队列槽位释放时机

- **发现**: 2026-10-19,M2 权限系统 Task 4/5 review;全量复验确认。
- **现象**: ①审批等待期间调用方 abort、gate 仍返回 `allow` 时,`onDecision` 会先写一条 `effective: "allow"` 的审计,随后 `executeAuthorized` 复查 signal 返回 `tool_aborted`;audit 与结果码不一致但可区分。②审批项因 abort/超时 settle 时立即释放串行槽位并 `pump()` 下一项;被 abort 的 prompter 底层异步操作可能仍在收尾,二者短暂重叠(审批已不可撤销)。
- **影响**: 审计读者需结合 `tool_result.code` 判断实际执行;prompter 责任方需保证 abort 后不再产生副作用。
- **触发升级条件**: Web 审批 UI 依赖 audit 展示“已批准”;prompter 实现有外部副作用(弹窗/设备)。
- **修复建议**: 可在 audit 中追加 `abortedBeforeExecution: true` 或改在 `executeAuthorized` 复查后再写审计;为 prompter 提供明确的 abort 契约文档。
- **状态**: 未解决;已记录的设计语义。

### D-131 · 病态 thenable 占用审批槽位(复核:受 `approvalTimeoutMs` 约束,非无限卡死)

- **发现**: 2026-10-19,M2 权限系统 Task 4 review 提出“病态 thenable 可能卡住队列”;全量复验专项复核。
- **现象**: prompter 返回 `then` 存在但永不 settle 的对象时,`Promise.resolve(thenable)` 保持 pending;实测连续两次此类返回值分别在 `approvalTimeoutMs` 后按 `approval_timeout` deny,第三次正常 allow,队列未毒化。
- **影响**: 不存在无限卡死;最坏代价是该审批占满一个超时窗口,期间后续审批排队(符合“入队即计时”的设计)。
- **触发升级条件**: 若未来移除此超时或放大默认值。
- **修复建议**: 保持 `approvalTimeoutMs` 为强制上限;无需改动。
- **状态**: 已复核,非缺陷;登记为边界。

### D-132 · 审批错误描述二次抛错导致 `check` 永不 settle、审批通道失效

- **发现**: 2026-10-19,全量复验。
- **现象**: `gate.ts` 与 `policy.ts` 的 `errorMessage` 直接读取 `error.message` / `String(error)`;若该值本身抛错(Error 子类 getter、Proxy、自定义 `toString`),异常从 rejection 回调逸出:`settle` 不执行、`active` 槽位永久占用,后续审批全部排队直至各自超时;`evaluatePolicy` 同路径会整体抛出,`runSession` 启动失败。`describeValue` 对自定义 `Symbol.toStringTag` getter 同样不设防。
- **影响**: 审批通道可整体失效;失败方向为 fail-closed(不会误放行),但会拒绝所有 `ask`。
- **触发升级条件**: 已修复。
- **修复建议**: —。
- **状态**: **已解决**(2026-10-19,`feat/m2-permission`):`errorMessage` 以 try/catch 兜底返回 `unknown error`,`describeValue` 兜底返回 `[object]`;新增 3 条回归用例(`message` getter、`toStringTag` getter、队列不被毒化),全量 1509 passed / 1 skipped,`src/permissions` lines 97.8%。

### D-133 · 只支持单会话流,多会话复用/全局流未实现

- **发现**: 2026-10-20,M2 事件总线 Task 7。
- **现象**: `GET /api/events` 强制要求 `sessionId`,每条 SSE 连接只补播/跟随一个会话;切换会话由客户端关闭旧流并新建连接。没有多会话复用连接、订阅切换协议或全局聚合流。
- **影响**: 同时观察多个会话需要多个连接/标签页;无法在单一连接上做全局活动列表或跨会话聚合。连接数随并发会话线性增长。
- **触发升级条件**: 需要同时实时观察多个会话、全局事件面板,或连接数成为瓶颈。
- **修复建议**: 在保持单会话帧语义的前提下增加多路复用协议(订阅/退订帧或每帧带 `sessionId`),或提供全局流并对客户端按会话过滤;复用现有 `SessionEventSource` 接口,避免另造事件模型。
- **状态**: 未解决;本轮按 spec 明确只做单会话流。

### D-134 · 进程内低延迟适配器未实现,当前依赖 200ms 日志轮询

- **发现**: 2026-10-20,M2 事件总线 Task 7。
- **现象**: `LogTailEventSource.follow` 以 200ms 间隔轮询增量字节;SSE 实际延迟还受文件读取与事件循环调度影响,未压测、无硬上限。没有 `EventEmitter`/共享注册表等进程内发布通道。
- **影响**: 对毫秒级工具/设备状态反馈不足;高频事件会合并到轮询批次。跨进程仍是最兼容的方案,但同进程场景多付一次轮询延迟。
- **触发升级条件**: 需要亚 100ms 延迟、高频设备事件,或轮询 I/O 成为开销。
- **修复建议**: 在同一 `SessionEventSource` 接口下增加进程内适配器(append 后立即通知,仍以日志为事实源并保留文件跟随作为补偿),SSE 与客户端协议不变。
- **状态**: 未解决;本轮按用户决策保留日志投影 + 轮询。

### D-135 · 无独立 `evidence` 事件,evidence 由 `tool_result.payload` 承载

- **发现**: 2026-10-20,M2 事件总线 Task 7。
- **现象**: 证据标记 `evidence`、`artifactPath`、`detail` 都附在 `tool_result.payload` 中并原样透传;没有独立的 `evidence` 事件类型,也没有证据级游标/分页。
- **影响**: 证据面板若要独立订阅、分页或跨调用去重,必须解析并缓存 `tool_result`;大 `detail` 会放大单条事件。当前 UI 投影够用,但不利于后续证据链独立演进。
- **触发升级条件**: 证据面板需要独立订阅/分页,或 `tool_result.detail` 体积成为流瓶颈。
- **修复建议**: 新增 `evidence` 事件并以 `callId`/`tool_result.seq` 关联,保留 `tool_result` 字段以兼容旧日志;先在 spec 定义去重与排序规则。
- **状态**: 未解决;本轮明确不新增独立事件,避免与 `tool_result` 重复。

### D-136 · 大日志/长断线补播的性能上限未压测;补播直写可能长时间占用连接

- **发现**: 2026-10-20,M2 事件总线 Task 7。
- **现象**: 补播按事件逐帧写响应,每帧有写超时(默认 30s),但没有补播总时长/总字节预算、批量化或分页。长断线或数十 MB 日志会持续占用连接,补播完成前无法开始跟随新增事件。
- **影响**: 首屏或长时间断线后的恢复可能很慢;慢客户端会长期占住连接;未量化 CPU/内存/背压表现,无法给出容量承诺。
- **触发升级条件**: 会话日志达到数十 MB、断线跨越大量事件,或实测补播超过可接受时延。
- **修复建议**: 压测并记录基准;补播增加总预算/分批让出事件循环、可选分页或快照压缩;对超长补播返回明确的可恢复错误并让客户端换用分页游标。
- **状态**: 未解决;本轮只保证正确性与单帧超时有界。

### D-137 · Web 审批 API/UI 未实现;`approval_request` 仅为保留类型

- **发现**: 2026-10-20,M2 事件总线 Task 7。
- **现象**: 事件流只透传已落日志的 `permission_decision`;没有 `POST /api/approvals`、审批请求事件或 Web 端批准/拒绝按钮。`approval_request` 未进入 `EventType`,仅作为阶段 2 的保留类型。
- **影响**: 在 Web 工作台无法响应 `ask` 审批;交互式审批仍依赖库层 `PermissionPrompter`(CLI/宿主)。Web 只能事后看到允许/拒绝结果,无法在诊断过程中操作。
- **触发升级条件**: Web 工作台发起需要 `ask` 审批的会话,或需要浏览器内完成批准/拒绝。
- **修复建议**: 定义 `approval_request` 事件与 `POST /api/approvals`(requestId/decision/超时/abort 语义),UI 在守卫区提供批准/拒绝并回显最终 `permission_decision`;复用现有审批队列与审计,不新造权限模型。
- **状态**: **已解决**(2026-10-20,`feat/m2-web-approval`):新增 `approval_request` 事件(`src/session/types.ts`、`src/session/persistence.ts`);审批桥 `src/server/approvals.ts` 负责写入事件、等待决策并区分首次/重复/相反/超时;`src/server/runner.ts` 注入 `PermissionPrompter`、`home` 与 `onSession`;`POST /api/approvals`(`src/server/api.ts`)回传 `{ sessionId, requestId, decision }`;前端 `ApprovalNotice`(`src/ui/components/conversation/approval-notice.tsx`)经 `permission_decision` 投影终态;崩溃恢复在 `src/session/session.ts` 补 `approval_aborted: crash_recovery`。测试:`tests/approvals-bridge.test.ts`、`tests/server/approvals-api.test.ts`、`tests/web-approval-e2e.test.ts`、`tests/ui/components/approval-notice.test.tsx`、`tests/ui/transcript.test.ts`、`tests/session-persistence.test.ts`。headless 无 prompter 时仍是 `ask` → deny(`approval_unavailable`);本轮残余边界见 D-145 ~ D-152。

### D-138 · 实时事件流的慢客户端检测依赖单帧写超时,写超时前不感知停读

- **发现**: 2026-10-20,事件总线全量复验(构建产物探针)。
- **现象**: 修复前实时阶段的 `writeBlock` 不带超时,`consume` 卡在首个 `drain` 等待上;完全不读的客户端既收不到 `stream_error {code:"slow_consumer"}`(队列溢出分支永远不可达),连接也不会被服务端关闭。探针:64 KiB 帧、`liveQueueMax=5`、socket `pause()` 20s → `closed_at_ms=never`。已通过 `liveWriteTimeoutMs`(默认取补播超时 30s)修复:实时单帧写超时即按慢客户端处理,发 `stream_error` 后关闭;默认配置下 handler 约 31s 有界退出。
- **影响(残余)**: 停读客户端在写超时(默认 30s)前仍占一个连接与有界队列;超时值可配置,未按会话/带宽自适应。
- **触发升级条件**: 需要秒级发现停读客户端;并发连接数成为瓶颈;需要按带宽预算而非固定超时判断慢客户端。
- **修复建议**: 用 `res.socket` 的 `writableLength`/`drain` 事件驱动的心跳探测替代固定超时,或在心跳帧上也加超时判定;补跨平台(Windows/macOS)的真实 socket 停读用例进回归。
- **状态**: **已解决**(2026-10-20,`feat/m2-event-bus` 复验修复):新增 `liveWriteTimeoutMs`(默认沿用 `replayTimeoutMs`),实时单帧写超时映射为 `slow_consumer` 并关闭;`tests/server/event-stream.test.ts` 新增「实时阶段完全不读的客户端在写超时后收到 slow_consumer 并关闭」。残余的「超时前仍占连接」按本条目保留。

### D-139 · `POST /api/actions` 仍为 501,Web 提交通道未实现

- **发现**: 2026-10-20,事件总线全量复验(端点实测)。
- **现象**: `/api/actions` 固定返回 501 `action_not_implemented`;D-063 只解决了事件流部分。前端未配置 `VITE_ACTION_URL` 时发送按钮禁用并提示「未配置提交端点」。
- **影响**: Web 工作台只读:可以订阅实时事件与回放,但不能发起新会话、追加输入或响应审批。
- **触发升级条件**: 需要从 Web 发起 runSession 或提交审批决定。
- **修复建议**: 见 D-051 的 action schema(`requestId`/`sessionId`/`text`、202/4xx/5xx)与 D-137 的审批端点;两者共用同一套请求去重与错误映射。
- **状态**: **已解决**(2026-10-20,`feat/m2-web-approval`):`POST /api/actions` 已落地(`src/server/api.ts` + `src/server/runner.ts`),接受 `{ text, sessionId? }`,缺省新建会话、带 id 追加输入,返回 202 `{ sessionId, created }`;错误码为 400 `invalid_body`/`invalid_text`/`invalid_session_id`、404 `unknown_session`、409 `session_busy`、503 `model_unavailable`/`session_start_timeout`;写端点强制 loopback `Origin`。测试:`tests/server/runner.test.ts`、`tests/server/api.test.ts`、`tests/server/approvals-api.test.ts`、`tests/web-approval-e2e.test.ts`。旧 D-051 中的 `requestId` 字段未采用,去重只保留在审批端点。

### D-140 · 会话列表与 `isValidSessionId` 的 id 规则已统一,但大小写别名(Windows)未处理

- **发现**: 2026-10-20,事件总线全量复验。
- **现象**: 修复前 `/api/sessions` 用宽松正则 `^[A-Za-z0-9._-]{1,128}$`,会把 `s1.old`、`s1.` 这类目录放进列表,而 `GET /api/sessions/:id` 走 `isValidSessionId` 返回 400——列表给出一个随后打不开的 id。已改为两处共用 `isValidSessionId`。D-069 的 Windows 大小写别名(`s1` 与 `S1`)仍按原条目跟踪。
- **影响**: 列表不再给出不可打开的 id;大小写别名与尾随点语义(D-068/D-069)不受本次改动影响。
- **触发升级条件**: 需要跨平台一致的 id 字符串语义。
- **修复建议**: 按 D-069 处理。
- **状态**: **已解决**(2026-10-20,`feat/m2-event-bus` 复验修复):`/api/sessions` 改用 `isValidSessionId`,`tests/server/api.test.ts` 新增「列表与详情使用同一 id 规则」用例。

### D-141 · `readSessionHeader` 曾重复实现,列表与详情校验规则可能漂移

- **发现**: 2026-10-20,事件总线全量复验(代码审查)。
- **现象**: `src/server/api.ts` 曾自行实现 `readSessionHeader`(lstat + JSON.parse + validateHeader),与 `src/session/persistence.ts` 的同名函数并存;两处对符号链接、权限错误、日志文件缺失的处理各自演化。已改为复用 persistence 实现,列表侧只额外要求「至少一个日志文件」,并把 `detail.cause` 中的 EACCES/EPERM 还原上抛供列表归入 `unreadable`。
- **影响**: 单一校验来源;`D-070` 的「权限错误记 unreadable」语义由新增的 EACCES 注入用例看守(此前无真实用例)。
- **触发升级条件**: 再出现第二份 header 解析实现。
- **修复建议**: 保持 `persistence.readSessionHeader` 为唯一入口;列表特有约束放在调用侧。
- **状态**: **已解决**(2026-10-20,`feat/m2-event-bus` 复验修复):`tests/server/api-unreadable.test.ts` 用 `vi.mock("node:fs")` 注入 EACCES,断言列表记 `unreadable`。

### D-142 · 旧 `LoopEvent` SSE 客户端与 `splitCompleteLines` 为无生产调用方的死代码

- **发现**: 2026-10-20,事件总线全量复验(引用扫描)。
- **现象**: `src/ui/view/sse.ts` 的 `createEventStream`(解析 `LoopEvent` 的 SSE 客户端)在 `src/ui/api/event-stream.ts` 落地后已无生产调用方,仅测试引用;`src/events/log-tail.ts` 的 `splitCompleteLines` 只被测试引用。两者都会让读者以为存在第二条实时链路或第二套分帧实现。
- **影响**: 误导性死代码;维护时会与真实实现漂移。
- **触发升级条件**: —
- **修复建议**: 删除死代码及其测试;需要时从实现中提取真正的共享函数。
- **状态**: **已解决**(2026-10-20,`feat/m2-event-bus` 复验修复):`sse.ts` 只保留 `postAction`/`HttpError`;`splitCompleteLines` 与其单测删除(多字节跨块由 `follow` 的真实路径用例覆盖)。

### D-143 · `applySessionEvent` 每条实时事件全量重算 `transcriptFromSession`

- **发现**: 2026-10-20,事件总线全量复验(代码审查)。
- **现象**: `src/ui/state.ts` 的 `applySessionEvent` 每次收到事件都对整个 `events` 数组调用 `transcriptFromSession` 重建 `TranscriptView`;会话事件数为 n 时累计 O(n²)。`mcpStatuses` 同样每次重建。
- **影响**: 长会话(数千事件)实时刷新时 CPU 与 GC 压力上升,可能拖慢流消费;当前会话规模下未观察到卡顿。
- **触发升级条件**: 单会话事件数达数千;UI 出现掉帧或流消费落后;启用 D-136 的大补播。
- **修复建议**: 让投影器支持增量 append(保留 fold 状态),或按 `seq` 分块缓存;补一条大事件数组的基准测试。
- **状态**: 未解决;性能边界。

### D-144 · 文档曾称 SSE 载荷为 `LoopEvent` 且 `since` 超前语义未写明

- **发现**: 2026-10-20,事件总线全量复验(文档核对)。
- **现象**: `docs/frontend-design.md` 第 49 行写「SSE 推送与 `LoopEvent` 同构的事件」,§8.5 仍以「已决:扩展 LoopEvent 透传结构化结果」表述,与实现的 `SessionEventEnvelope` 不符;README/spec 未写明 `since` 大于会话最大 `seq` 时会被夹紧到该 `seq`(实现如此,且属容错语义)。
- **影响**: 读者会按 `LoopEvent` 结构对接实时流;重连游标超前的行为只能从代码推断。
- **触发升级条件**: 第三方按文档实现 SSE 消费方。
- **修复建议**: 文档改为 `SessionEventEnvelope`,并写明 `since` 夹紧语义。
- **状态**: **已解决**(2026-10-20,`feat/m2-event-bus` 复验修复):`frontend-design` §2/§8.5 改为 `SessionEventEnvelope` 并标注 §8.6;README 与 spec §11.1 补 `since` 夹紧说明。

### D-145 · 服务重启后 pending 审批丢失

- **发现**: 2026-10-20,M2 Web 审批 Task 10。
- **现象**: 审批桥的 pending 表只在进程内存;服务重启后正在等待的审批随 gate 一起丢失。已落盘的 `approval_request` 没有对应 `permission_decision`,要等 `resumeSession` 的崩溃恢复补 `approval_aborted: crash_recovery` 才配对;重启前未完成的 HTTP 请求不会重放。
- **影响**: 重启期间页面卡片停留在 pending,只能等 `deadlineAt` 到点后本地显示已过期;日志在 resume 前不完整。不会误执行工具。
- **触发升级条件**: 需要跨重启保留待审批状态,或重启后继续同一次审批。
- **修复建议**: 以 `approval_request` 为源恢复待审批队列并重新等待,或明确重启即失效、在服务启动时批量补 deny 审计。
- **状态**: 未解决;本轮按「重启即失效、resume 补审计」处理。

### D-146 · 写端点只有 loopback Origin 校验,无 token/CSRF

- **发现**: 2026-10-20,M2 Web 审批 Task 10。
- **现象**: `POST /api/actions` 与 `POST /api/approvals` 校验 `Host`/`Origin` 必须为 loopback 且端口匹配,并拒绝浏览器自动发送的 `Sec-Fetch-Site: cross-site`;但不校验 token、会话 cookie 或 CSRF 头,也不区分浏览器标签页。
- **影响**: 同机其他进程或非浏览器客户端只要能以 loopback Origin 发请求,就能提交动作或审批;`Sec-Fetch-Site` 只覆盖浏览器真正跨站的请求,同 site 不同端口的页面(如 `localhost:5173` 写 `127.0.0.1:5174`)标记为 `same-site`,由 `Origin` 的 loopback + 端口校验拦截;不覆盖非浏览器客户端或同源页面内的脚本。该机制只阻断跨源网页(DNS rebinding / 跨源 POST),不是本机攻击者隔离。
- **触发升级条件**: 多用户、远程访问,或需要防本机其他应用。
- **修复建议**: 引入一次性 token / 会话 cookie + CSRF 头,或改用 Unix socket / 命名管道并做 OS 级鉴权。
- **状态**: 未解决;按 2026-10-20 决策不引入 token;浏览器跨源面已由 `Sec-Fetch-Site` 检查收紧。

### D-147 · 审批摘要可能在页面上暴露敏感片段

- **发现**: 2026-10-20,M2 Web 审批 Task 10。
- **现象**: `approval_request` 复用 `permission_decision` 的 `paramsPreview`(字符串最多 120 码点、整体 4096 字节),审批卡片直接渲染 `paramsPreviewText`,不做脱敏。
- **影响**: 设备序列号、绝对路径、令牌片段会出现在页面与日志中;截图、投屏或共享时泄露。
- **触发升级条件**: 接入含凭据的工具;审批界面需要共享或合规审查。
- **修复建议**: 按 D-113 增加键级脱敏或默认关闭 preview;卡片仅展示 `paramsKeys` 与 `paramsDigest`。
- **状态**: 未解决;与 D-113 同根因,此处只登记 Web 审批的展示面。

### D-148 · 单会话串行运行,运行中不能追加或取消

- **发现**: 2026-10-20,M2 Web 审批 Task 10。
- **现象**: 每个会话同时只允许一个 `runSession`;运行期间再次 `POST /api/actions` 返回 409 `session_busy`,没有排队、插话或取消端点。不同会话可并行。
- **影响**: 长工具调用期间无法追加输入或纠正指令,只能等待结束或重启服务;前端没有取消按钮。
- **触发升级条件**: 需要中途取消/插话/排队,或工具执行时长成为交互瓶颈。
- **修复建议**: 增加取消端点(暴露 `AbortController`)与有界队列,并在 UI 显示运行中状态与取消入口。
- **状态**: 未解决;本轮按 spec 显式拒绝并发。

### D-149 · 审批卡片受 SSE 200ms 轮询延迟影响

- **发现**: 2026-10-20,M2 Web 审批 Task 10。
- **现象**: `approval_request` 先落日志,再由 200ms 轮询的 SSE 跟随投影;卡片出现与终态更新最多滞后约 200ms 加文件读取/事件循环调度,无硬上限。
- **影响**: 审批交互不是即时反馈;极端调度下延迟更长。正确性不受影响(日志仍是事实源)。
- **触发升级条件**: 需要亚 100ms 交互,或审批频次显著提高。
- **修复建议**: 按 D-134 增加进程内低延迟适配器,保持 SSE 协议不变。
- **状态**: 未解决;与 D-134 同根因,此处登记审批链路的可见延迟。

### D-150 · 会话结束后迟到决策返回 404,运行中已超时返回 410

- **发现**: 2026-10-20,M2 Web 审批 Task 10。
- **现象**: `SessionRunner.decide` 先查运行器注册表;会话已结束(注册表无该项)时返回 404 `unknown_session`。只有会话仍运行、但请求已超时/中断时,桥的 settled 表才返回 410 `approval_expired`。
- **影响**: 同一语义(不可再决)对应两种状态码;会话结束后点击审批显示 404 文案,重复提交也可能从 200 变为 404。调用方需同时处理。
- **触发升级条件**: 前端需要统一「已过期」提示,或外部调用方按状态码做重试/告警。
- **修复建议**: 短期保留「已结束会话 + requestId → expired」映射,或前端把 404/410 统一映射为已过期。
- **状态**: 未解决;当前优先保持 HTTP 状态语义准确。

### D-151 · 就绪超时后未响应 abort 的 generator 可能长期占用 `session_busy`

- **发现**: 2026-10-20,M2 Web 审批 Task 10。
- **现象**: `start` 在就绪超时时 abort 并关闭审批桥,但注册表项只在 `consume` 的 `finally`(completion settle)删除;若 `runSession` 或工具不响应 `signal`,注册表项保留。带同一 `sessionId` 的后续追加会一直返回 409 `session_busy`;`close()` 等待 5s 后放弃。
- **影响**: 长生命周期服务内可能出现「会话永远忙」与注册表项残留;新建会话的随机 id 用户不可见,影响较小。
- **触发升级条件**: 出现实际挂起的 generator;Web 服务长时间运行。
- **修复建议**: 就绪失败时立即从注册表移除并异步等待 completion,或为运行增加硬超时与强制清理;补一条不响应 abort 的 generator 用例。
- **状态**: 未解决;当前依赖 `runSession` 与工具响应 `signal`。

### D-152 · 发送在途时手动切换会话仍可能被切回新会话

- **发现**: 2026-10-20,M2 Web 审批 Task 10。
- **现象**: `main.tsx` 的 `sessionEpoch` 只在「新会话」按钮递增;发送在途时手动点击其他会话(`selectSession` 不递增 epoch),`POST /api/actions` 返回后仍会 `selectSession(created.sessionId)`,把视图切回本次发送产生的会话。
- **影响**: 用户的手动选择被覆盖,需要再次切换;不产生错误数据。
- **触发升级条件**: 发送延迟明显(模型响应慢)或用户频繁切换会话。
- **修复建议**: 在 `selectSession` 递增 epoch,或在发送完成时校验当前 `activeSessionId` 是否仍等于提交前值。
- **状态**: 未解决;已知交互边界。

### D-153 · `createUiServer({ port: 0 })` 时写端点全部 403

- **发现**: 2026-10-20,M2 Web 审批红队修复。
- **现象**: `createUiServer` 把传入的 `port` 原样用于 `requireLocalRequest` 的端口比对;传 `0` 时 HTTP server 实际监听随机端口,但校验仍要求 `Host`/`Origin` 端口等于 `0`,所有写请求返回 403 `forbidden_host` / `forbidden_origin`。
- **影响**: 仅影响以 `port: 0` 嵌入并依赖系统分配端口的调用方;CLI/生产入口使用固定端口,测试用 `freePort()` 绕开。
- **触发升级条件**: 需要把 UI server 嵌入其他进程并动态取端口。
- **修复建议**: 监听 `listening` 后读取 `server.address().port`,回填给 handler;或把端口校验改为按实际监听端口。
- **状态**: 未解决;本轮未改端口获取方式。

### D-154 · runner 关闭后审批决策返回 404 而非 503

- **发现**: 2026-10-20,M2 Web 审批红队修复。
- **现象**: `SessionRunner.decide` 在 `close()` 清空 registry 后返回 `unknown_session`(HTTP 404);`start` 已对 `closed` 返回 503 `runner_unavailable`,两者不一致。
- **影响**: 客户端把「运行器已关闭」误判为「会话不存在」;不产生错误决策。
- **触发升级条件**: 服务关闭流程与在途审批决策并发,或需要客户端区分可重试状态。
- **修复建议**: `decide` 先检查 `closed` 并返回 `runner_unavailable`;补 close 后 decide 的 HTTP 用例。
- **状态**: **已解决**(2026-10-20,`feat/m2-web-approval`):`RunnerDecideOutcome` 增加 `{ kind: "runner_unavailable" }`,`SessionRunner.decide` 在查注册表前先判 `closed`,`src/server/api.ts` 映射为 503 `runner_unavailable`;新增 `tests/server/runner.test.ts` 的 close 后 decide 用例与 `tests/server/approvals-api.test.ts` 的 503 用例(删掉 api.ts 映射时该用例转 RED,恢复后 GREEN)。构建产物探针复验:`runner.close()` 后 `/api/approvals` 与 `/api/actions` 均返回 503 `runner_unavailable`,与 README / spec 一致。D-150 的运行中/会话结束后 404/410 语义不变。

### D-155 · 权限 / Web 审批 spec 仍保留 `requestId === callId` 的旧描述

- **发现**: 2026-10-20,权限引擎与 Web 审批全量复验。
- **现象**: 红队修复已把审批标识改为 gate 每次生成独立 UUID,但 `docs/superpowers/specs/2026-10-20-web-approval-design.md` 仍有三处旧描述:§6 第 71 行「`requestId` 即工具调用的 `callId`」、§7.3 第 146 行「用 `requestId = req.callId`」、§13.1 第 373 行「gate 传出 `requestId=callId`」。
- **影响**: 文档与实现(§8.1「每次 `check` 生成 `randomUUID()`」)自相矛盾;按 spec 实现后续功能的人可能重新引入「跨轮复用 `callId` 时两次审批共享标识」的缺陷,这正是第二轮红队修复的 Critical。
- **触发升级条件**: 任何人按该 spec 修改审批标识相关代码。
- **修复建议**: 三处改为「`requestId` 是 gate 为每次审批生成的独立 UUID,与模型 `callId` 解耦」,并在 §13.1 补一条「`requestId` 不等于 `callId`」的断言描述。
- **状态**: **已解决**(2026-10-20):spec §6、§7.3 第 1 步、§13.1 三处改为独立 UUID 语义,§7.3 的 `requestId = req.callId` 更正为 `req.requestId`;同时把 `runner_unavailable` 补进 §7.1 `DecideOutcome` 与 §7.2 的 close 语义(见 D-154)。

### D-156 · `tests/mcp-manager.test.ts` 时间阈值用例在并行负载下偶发失败

- **发现**: 2026-10-20,权限引擎与 Web 审批全量复验(coverage 运行)。
- **现象**: `单个 server 失败不阻塞其他 server` 在默认 5s 超时下偶发 `Test timed out`;`连接超时可注入并记录 connect_failed,且回收子进程` 偶发 `Date.now() - started` 达到 3024ms,超过 3000ms 断言。同一文件单独复跑 36/36 通过,连续全量复跑多数通过。
- **影响**: 全量 `npm test` / `npm run coverage` 偶发红灯,需要人工判断是否为真回归;不影响产品行为。同类现象在 dev-notes 上一轮已记录过一次,但当时未登记。
- **触发升级条件**: 再次出现;或 CI 要求稳定全绿。
- **修复建议**: 断言改为「不阻塞」而非绝对耗时(例如比较并发与串行完成的相对关系),或为这两条用例单独设置更宽的 `testTimeout` / 用假时钟替换 `Date.now()`;不改生产代码。
- **状态**: **已解决**(2026-10-20):两条用例各加 30s `testTimeout` 并注明「测的是故障隔离 / 超时注入是否生效,不是绝对耗时」;`连接超时可注入…` 的耗时上限从 3000ms 放宽到 10000ms——注入值是 300ms、默认值是 15s,10s 仍能区分二者,同时容纳并发负载下的 spawn 抖动。仅改测试,未改生产代码。

### D-157 · 真串口与真机 OpenOCD 未实测

- **发现**: 2026-10-20,BR-2/BR-3 回归与文档(Task 11)。
- **现象**: BR-2 的探针后端只在 Renode 仿真内存上跑通真实端到端闭环;`OpenOcdBackend` 的可用性检测与错误路径有测试,但没有连接任何真实 MCU;串口工具也没有对真实 USB 转串口设备做过读写与超时验证。
- **影响**: Renode 与真机在复位语义、内存访问时序、串口缓冲/流控、USB 枚举失败模式上存在差异;真机上的权限声明、超时与错误映射可能暴露当前测试覆盖不到的问题。
- **触发升级条件**: 获得可复现的真机/串口环境;或用户报告 OpenOCD/串口路径的实际失败。
- **修复建议**: 在真机上执行 attach → halt → read → write → 回读 → reset → detach,并单独验证串口打开、写、读超时与断开;把实测结果写入 `dev-notes`,不把硬件依赖加入默认 `npm test`。
- **状态**: 未解决。2026-10-20 第一轮独立审查修复进一步明确:本轮 `OpenOcdBackend.attach` 只建立 telnet transport,不 spawn `openocd`;`openocdConfig` 死参数已移除。真机启动与板卡验证仍由本条覆盖。

### D-158 · KB 语料与查询集不入库导致 CI 回归覆盖缺口

- **发现**: 2026-10-20,BR-2/BR-3 回归与文档(Task 11)。
- **现象**: `mcp-servers/kb/kb/` 与 `mcp-servers/kb/data/` 因许可口径被 `.gitignore` 排除;`regression.test.ts` 在这两个目录缺失时 `describe.skip`,CI 环境因此不会执行任何 KB 检索指标断言。
- **影响**: 本地基线能防住检索质量回退,但 CI 只能验证解析器与工具层的夹具测试;语料或查询集在本地被替换、损坏时,CI 不会报警。
- **触发升级条件**: 建立 CI;或需要对外分发 KB 回归能力。
- **修复建议**: 提供可公开的合成夹具语料与等价查询集供 CI 使用,真实语料仍留在本地;或在 CI 中显式下载受控语料并校验 `manifest.sha256`。不得把受限语料提交进仓库。
- **状态**: 未解决。

### D-159 · BR-3 负样本拒答率 84%,未达到 100% 目标

- **发现**: 2026-10-20,BR-2/BR-3 第一轮独立审查修复。
- **现象**: 引入技术 token 覆盖度与中文短查询覆盖度后,25 条负样本中 21 条正确拒答(refusalRate 0.84),残余 4 条误报: neg-005、neg-008、neg-011、neg-023。其中 neg-005、neg-008、neg-023 的 `near_domain: true`,分别命中 ESP32-S3/USB、Zephyr/devicetree/west、DMA/cache 等真实相邻条目,但 KB 并未覆盖提问中的具体细节(OTG 主机、overlay 应用、双缓冲 cache 时机);neg-011(`near_domain: false`)是“板子上电后完全没反应,电源指示灯也不亮”的纯硬件供电问题,仍命中串口无输出条目。短查询“优化”“对齐”“没反应”已由中文覆盖度规则拒答,但 neg-011 是长句,命中关键词之外有足够中文上下文,规则不会拒绝。
- **影响**: spec §6 的 100% 拒答是目标而非本轮实测;当前词法覆盖度无法区分“主题相邻”和“答案存在”,agent 可能拿到不足以回答问题的候选。不得对外声称 BR-3 拒答已达 100%。
- **触发升级条件**: BR-5 语义检索/答案覆盖评估落地;或负样本误报导致实际诊断错误。
- **修复建议**: 引入语义检索或答案覆盖度判断(例如基于条目正文与 query 意图的可答性评分),在此之前保持“余量预算 ≤4 条、不针对 neg-id/path 特判”。扩展评估集时按 calibration/evaluation 拆分,报告留出集拒答率,避免在同一组负样本上调参。
- **状态**: 未解决(已用原则性覆盖度规则从 0.56 提升到 0.84)。

### D-160 · Renode monitor 超时后迟到输出可能污染下一条命令

- **发现**: 2026-10-20,BR-2/BR-3 第一轮独立审查(Minor M-3)。
- **现象**: `mcp-servers/probe/renode.ts` 的命令超时后只清空 `pending`,没有 drain/隔离迟到字节;迟到输出可能拼到下一条命令的 buffer。OpenOCD telnet transport 有同类竞态。
- **影响**: 多数路径会变成显式解析错误而非静默错误数据,但存在真实竞态;超时后的下一次读取可能读到上一条命令的残留。
- **触发升级条件**: 真机/仿真出现超时后错误数据;或新增依赖命令输出长度的工具。
- **修复建议**: 超时后将连接标记为 degraded 并拒绝后续命令直到重连,或在发送下一条命令前 drain 并加注入测试;本轮不修,登记跟踪。
- **状态**: 未解决。

### D-161 · 10/20ms 真实定时器测试在 CI 负载下可能抖动

- **发现**: 2026-10-20,BR-2/BR-3 第一轮独立审查(Minor M-6)。
- **现象**: `mcp-servers/probe/tests/renode-monitor.test.ts` 使用 20ms 超时、`mcp-servers/probe/tests/serial.test.ts` 使用 10ms 超时;断言方向是“等待超时后返回”,高负载 CI 上仍可能因定时器抖动失败。
- **影响**: 偶发红灯,可能被误判为超时语义回归;不影响产品行为。
- **触发升级条件**: 再次出现;或 CI 要求稳定全绿。
- **修复建议**: 改用 fake timers,或把超时窗口放大到 100ms 以上并注明测的是超时语义而非绝对耗时。
- **状态**: 未解决。

### D-162 · OpenOCD 已发出的单条 telnet 命令无法撤回

- **发现**: 2026-10-20,BR-2/BR-3 第二轮独立复核修复(Minor F-2)。
- **现象**: `OpenOcdBackend` 在内存读写循环中接入 `AbortSignal`:abort 后不再发送后续命令,调用者在途等待会立即以 `aborted` 结束。但 `TelnetTransport.send` 已写入 socket 的单条命令无法撤回,底层 promise 仍会等到 OpenOCD 返回 prompt 或 5s 超时;该结果被丢弃,不会写入后续命令的输出。
- **影响**: 取消语义是“不再继续 + 立即返回”,不是“撤销已在设备上执行的单条命令”。读命令无副作用;写命令若在 abort 前已发出,单条字写入仍可能完成,但不会继续写剩余字节或回读。Renode 侧可清除 pending,取消更彻底。
- **触发升级条件**: 需要严格的“取消即未执行”语义;或写操作在 abort 后产生实际副作用并影响诊断。
- **修复建议**: 为写路径引入设备侧事务/回滚,或在 abort 时主动断开并重连 telnet,以连接重建保证后续命令不继承旧响应;同时补充写操作取消后的设备状态核验。
- **状态**: 未解决(已知边界,已在 README/spec 说明)。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-17 | 建档,录入 D-001 ~ D-008 |
| 2026-10-17 | 录入 D-009(cached token 之外的 usage 明细延后) |
| 2026-10-17 | D-001 标注已解决(补默认 sleep/rand 真实重试测试);录入 D-010(退避 sleep 不响应取消) |
| 2026-10-17 | Task 6 交付核验:录入 D-011 ~ D-018(取消误报、choices[0] 畸形、scheme 校验、usage 类型漂移、signal 无断言、错误面不可分类、F9-F12 未闭环、.tmp 游离);D-010 排版归位 |
| 2026-10-17 | Task 7 整合复审:录入 D-019(`$schema` 网关兼容)、D-020(`ToolCtx.cwd` 来源) |
| 2026-10-18 | Task 7 交付核验:录入 D-021(MCP 工具名 `.`/`/` 需映射);`ToolRegistry` 补注册期校验(名称/根 object/不可表示类型 fail-fast),io=input 断言补齐 |
| 2026-10-18 | Task 8 第三轮红队修复:D-020 标注接口已解决、Task 9 透传待验;录入 D-022(超时≠强制终止、串行写可能重叠) |
| 2026-10-18 | Task 8 交付核验:录入 D-023(非字符串 id 绕过重复检测)、D-024(空 artifactDir 文案);D-020 已随 plan Task 9 补 `cwd`/`timeoutMs` 透传要求 |
| 2026-10-18 | Task 9 第二轮整合审查:D-020 标记已解决(Task 9 已透传 `cwd`/`timeoutMs`);录入 D-025(空 `tool_calls` 数组)、D-026(`maxCostUsd` 延迟一轮);D-023 合并 F9(`query` 不重复校验 `call.id`,信任 Task 6) |
| 2026-10-18 | Task 9 第三轮红队审查:录入 D-027(无 usage 时 `maxCostUsd` 静默失效)、D-028(marker raw 无上限)、D-029(assistant 重复 tool call id 投影未拦截) |
| 2026-10-18 | Task 9 第四轮整合审查:录入 D-030(初始化 append 失败不落 `interrupted(error)`),N3(补偿写失败未测)与 N5(批次交错负例)并入;`pricePerMillion` 在 config schema 增加非负有限校验 |
| 2026-10-18 | Task 9 交付核验:D-029 升级为阻塞并**修复**(重复 tool call id 会使会话永久不可回放;query 落日志前拒绝 + buildMessages 二次守卫);补齐乱序 tool_result 投影断言 |
| 2026-10-18 | `fix/p0-full-review` 全量复核:修复 C1/C2/C3/I3/I7/I9/I6/D15;录入 D-031 ~ D-038(响应体上限、请求超时、tool_calls 预算、代理对截断、会话原子性、4xx 细分、tool call 校验、marker 形状) |
| 2026-10-18 | 全量复核(二轮):D-038 探针证实可触发并**修复**(适配器解析失败才置 `invalidJson: true`,query/buildMessages 双条件判定);补齐三处变异探针看守 |
| 2026-10-18 | 维度6 Task3 审查修复:录入 D-039(同目录并发 resume/append 无跨进程锁);D-035 扩展记录末行缺换行导致续写粘连;`usageTotals` 容错非对象 payload,导出 `openSessionHandle` 供 fork 复用 |
| 2026-10-18 | 维度6 Task4 审查修复:fork 增加 artifact 词法越界拒绝、失败回滚、非递归 `mkdir` 原子占位、同名 artifact 后缀、targetDir 为文件拒绝;D-039 扩展记录 fork 后 append 仍无跨进程锁,录入 D-040(artifact 路径仅词法校验,未解析链接/短名) |
| 2026-10-18 | 维度6 Task5:rollover 接线 `create/resume/fork`(默认 50 MiB、非法阈值 `TypeError`、resume/fork 字节校准);补已存在空目录与父路径为文件的 fork 用例;录入 D-041(fork 回滚父目录残留/静默)、D-042(artifact 缺失原因不可区分/目录 artifact 未定义) |
| 2026-10-18 | 维度6 Task6 审查修复:resume 改为「先读取校验、后 `resumeSession`」,失败不写 header/日志;新增 `session_id_mismatch`;`finally` 的 close 异常不再覆盖主错误;录入 D-043(`header.workdir` 与工具 cwd 来源不一致)、D-044(多 system 只校验首个) |
| 2026-10-18 | 维度6 Task8 收尾:复核 D-039 ~ D-044 均仍为未解决,描述与当前实现一致;录入 D-045(checkpoint.turn 每次 query 从 1 重编号、resume 后与历史重复)、D-046(无主错误时 close 异常上抛分支缺真实路径测试) |
| 2026-10-18 | 第一轮整体审查修复:fork 边界改为前缀可投影;resume 增加崩溃尾部恢复;统一 header 校验;D-042 扩展记录越界/缺失共用 artifactMissing;D-046 补充 close 失败不重试语义 |
| 2026-10-18 | 第二轮红队修复 C-1/I-1:读取与 append 增加 lstat 普通文件/非链接校验;resume 崩溃恢复改为先 append 后写 header open 并支持失败回滚与幂等补 interrupted;fork source/target/artifact 增加 realpath 边界;录入 D-047(TOCTOU/junction/短名)、D-048(代文件不连续仍被接受);D-040 扩展记录 realpath 接线与残余缺口 |
| 2026-10-18 | 最终加固:header 临时文件改为 `header.json.<uuid>.tmp` + `wx`,避免预置链接写入越界;补 `readSessionFile` symlink 直达用例与 Windows 无权限 skipIf;design §5 补 symlink/payload/恢复幂等/realpath 条目;录入 D-049(create/resume 跟随目录链接与 fork 不一致)、D-050(payload 非对象 fail-closed 的旧日志兼容性影响);dev-notes 明确恢复补偿分支为防御性 |
| 2026-10-18 | P0 前端 Task 11 第一轮整体审查修复:录入 D-058 ~ D-061(Dock 静态数据、回放/导出未接线、SSE 无后端输入处理、StatusBar context/limit 来源);V13 改为检查一致性测试文件,验收脚本清理失败不再吞汇总 |
| 2026-10-18 | P0 前端 Task 10 视觉验收:录入 D-051 ~ D-057(action 端点契约、StatusBar 状态推断、无后端清空输入、717px 树内部滚动、V3 滚动条口径、V11 静态 Tab 范围、Chromium 探测覆盖);设计 v1.2 同步 V2/V3/V6/V11 口径 |
| 2026-10-18 | P0 前端 Task 17 第二轮红队修复:锁定 header-only 会话列表(坏事件日志仍在列表、无日志文件 `invalid_header`)、junction/符号链接目录记 `skipped_link`、`errors` 透传到会话面板;实时态切换会话后保持 live;README/spec 补 `src/server/`、header-only 读取与寄存器来源;D-065 标注已解决,D-068 按实测改写,录入 D-069(大小写别名)、D-070(ACL 未验证) |
| 2026-10-18 | P0 前端 Task 12 第二轮红队审查修复:修正空 text + artifact 投影、SSE 单 timer 重连/close 后静默/构造抛错收敛、折叠摘要截断、costUsd 有限非负校验;清理 `styles.css` 重复 `.dock` 与 media 查询;录入 D-062(usage 缺字段补 0) |
| 2026-10-18 | P0 前端 Task 15 真实数据验收:验收脚本改为启动 `dist/server/serve.js`(临时 `HARNESS_HOME` 写入真实会话与 KB),V14 断言真实 guard 文案并新增 V0 空态附加检查;修复 V11 以坐标区分同文案控件(设备 unknown 下三个「未接入」chip 曾导致遍历提前终止);README 改为真实数据流程与 API 表;D-053/D-060 标记已解决,D-058 标记数据来源已解决,D-051 补 501 现状;录入 D-063(API 只读、actions/events 未实现)、D-064(KB 深度/条目上限)、D-065(坏目录 errors 未展示) |
| 2026-10-18 | Task 16 审查修复:会话列表改 header-only 读取(id 取目录名,`id_mismatch`/`unreadable`)、静态路径 NUL/穿越 400、Dock 状态点与日志 mark 由真实数据派生、V13 改实跑一致性测试、V14 删除恒真断言;D-053 验证描述修正;录入 D-066(列表不解析事件)、D-067(Host/Origin 未校验)、D-068(Windows 尾随点 id 别名) |
| 2026-10-18 | 维度4 Task1 审查修复:fs read 改流式读取、edit 按 CRLF/LF 风格映射、拒绝 Windows 保留设备名、offset 越界显式返回;design §4.2 补齐 read_failed/invalid_input/reserved_name/internal_error;拟用 D-051/D-052 与前端冲突,改录 D-071(fs 不响应 AbortSignal)、D-072(edit 非重叠匹配) |
| 2026-10-18 | 维度4 Task1 收尾:空文件 offset 显式返回、混合换行按 LF 处理并保留未命中行原始字节、保留名先规范化(trim/:stream/尾部点空格)、5MB 用例改名并明确流式仅代码审查、junction 改为真实探测;录入 D-073(上标设备名变体) |
| 2026-10-18 | 维度4 Task2 审查修复:危险命令补 `$HOME`/`${HOME}`/`..`/盘符根与 `del/rd` 通配、sudo 带值选项、信号终止 `shell_terminated`、abort 杀进程树、message 截断 200 字符;录入 D-074(cwd 校验与 spawn 的 symlink TOCTOU) |
| 2026-10-18 | 维度4 Task2 复审:危险 execute 用例补前置识别断言(截断用例);design §4.3 同步 shell 非沙箱/自管 abort/`shell_terminated`/`del`/`rd` 通配与错误码表;录入 D-075(abort 无升级兜底)、D-076(`exitSignal`/`code=null` 平台边缘) |
| 2026-10-18 | 维度4 Task6 收尾:README 补内置工具清单、fs/shell/glob/grep 语义与工具根;补 shell 截断多字节/AbortError 与 grep ENOTDIR/readdir 错误测试,工具行覆盖均 ≥90%;录入 D-077 ~ D-084(glob/grep 不响应取消、grep 先收集后截断、根 symlink 跟随、scanTruncated 保守、隐藏文件匹配、workdir 词法比较、shell 黑名单绕过、上限披露粒度) |
| 2026-10-19 | 维度4 第一轮整体审查修复:shell 归一化根目标并跟踪 `cd`/`pushd`/`Set-Location`;grep 补 scanTruncated 披露与 1 MiB 单行上限;shell `detail.stdout/stderr` 改为 4096 字符摘要 + 字节数;补 fs write/read 失败、grep 扫描上限、path-safety 每测试 workdir、win32 忽略目录大小写与相对 cwd 归一测试;按实测修正 D-080,录入 D-085(正则 ReDoS/不可中断) |
| 2026-10-19 | 维度4 第二轮红队修复:shell `rm` 任一 `-r/-f` + 根目标即危险、`--no-preserve-root` 一律危险、token 引号全移除、`chdir` 纳入跟踪、无参 `pushd` 保守、detail 摘要不切断代理对;glob 限制 pattern 长度/段数并折叠连续 `**/`;grep 校验 `glob` 非法、合并不可读目录披露;录入 D-086(glob ReDoS 未完全消除)与 D-087 ~ D-090(改目录方式未跟踪、shell 展开绕过、跳过披露分类、grep glob 重复编译) |
| 2026-10-19 | 维度4 复审 minor:glob 连续 `**/` 折叠改为只从完整段边界开始(避免 `a**/**/x` 被误折叠),补回归测试;文档补齐无参 `cd`/`chdir`/`pushd` 保守语义;D-088 现象扩充引号内分隔符与带空格环境变量赋值绕过 |
| 2026-10-19 | 维度3 Task5 收尾:README 补三级压缩、`RunOptions.compaction`、evidence 保护与摘要成本;录入 D-091 ~ D-096(prompt cache 断裂仅告警、摘要质量、逐事件估算、摘要不重试、compaction 事件增长、`keepRecentTurns` 默认值) |
| 2026-10-19 | 维度3 第一轮整体审查修复:摘要空/全空白/截断落 `failed` 且不计费;`no_progress` 幂等守卫;比例配置入口校验;`heuristicCountTokens` 计入 `tool_calls`;transcript/首行截断保护代理对;删除 `CompactOptions.pricePerMillion`;补充压缩后 resume、summary+坏尾部恢复、批次边界与 evidence 用例;更正 D-093(assistant 已计 `tool_calls`),录入 D-097(`compacted` 不区分成功/失败)、D-098(坏 summary 容错与 microcompact failed 分支) |
| 2026-10-19 | 维度3 第二轮红队修复:summary 投影拒绝覆盖 evidence 并回退上一条有效 summary;坏 summary 校验非空/边界/批次完整性;摘要后仍超阈值落 `failed(still_over_budget)`;缺 usage 改写 `status(usage_missing)` 并复用 `normalizeUsage`;新摘要必须覆盖旧 summary 事件并在 transcript 前置旧摘要;microcompact 仅在占位更短时生效;`keepRecentTurns` 校验非负整数;TokenMeter 防御非有限 heuristic;`enabled:false` 不再校验比例;扩写 D-093/D-097,录入 D-099(单条结果/近期批次超窗) |
| 2026-10-19 | 维度3 最后小修:移除 transcript 手动 `[Previous summary]` 前置(由 `buildMessages(prefix)` 注入一次);summary 投影按事件顺序只采信边界不倒退的有效 summary;D-099 补充首轮 `still_over_budget`、后续轮 `no_progress` 的轮次语义 |
| 2026-10-19 | 维度3 Task3 第一轮 review 修复:补长 evidence 候选变异守卫、transcript 60% 边界、摘要 messages 两条与投影失败 catch 用例;compact 的 `elidedSeqs` 改用 `Number.isInteger`;design §4.4/§4.6 删除 `pricePerMillion` 并同步 brief;D-097/D-099 补 `still_over_budget` 与 `no_progress` 边界语义 |
| 2026-10-19 | 维度3 Task5 第一轮 review 修复:README 更正 `tool_calls` 计数口径(D-033 已解决)、补 summary `covers < summary.seq`、二级候选排除旧 summary 覆盖范围、前缀投影失败、8000/25000 估算口径与无 system 回退;D-093 交叉引用 D-005;D-095 修复建议改为 rollover/归档层限定元数据、不删除既有事件;dev-notes 修正 Task1 提交信息与 task-5-brief 说明 |
| 2026-10-19 | 维度5 Task4:runSession 装配 MCP 与 list_changed 刷新;status 事件接入、配置错误隔离、finally close;spec §4.3/§4.4/§4.5 同步确定性消歧与 status 枚举;录入 D-100(消歧依赖 server 返回顺序) |
| 2026-10-19 | 维度5 Task4 第二轮复核修复:坏 schema 集成断言改为完整工具名、补 replace 原子性/scope global/invalid_schema status/移除工具/close 冒泡/mcp 非对象用例;`appendMcpStatus` 不再静默吞写入失败;spec 目标 3 同步确定性改名;录入 D-101(status 写入与 close 迟到竞态) |
| 2026-10-19 | 维度5 Task5 收尾:D-021 标记已解决(命名空间映射与确定性改名);录入 D-102(继承完整 env)、D-103(未知字段静默忽略)、D-104(list_changed 刷新失败不重试);README 补 MCP 配置/命名/隔离/刷新与依赖安装说明 |
| 2026-10-19 | 维度5全量复验:录入 D-105 ~ D-108(项目级 MCP 配置自动执行无信任门槛、连接错误重试可能重复破坏性工具、listTools 无显式超时、MCP content/schema 无大小上限);D-043 标注已解决;四项转入 A 档修复(fix/p0-a-tier) |
| 2026-10-19 | A 档修复(fix/p0-a-tier):D-022 管线超时后串行屏障 + MCP 超时/取消断开重连;D-031 响应流式上限、D-032 请求超时;D-067 API Host/Origin 校验;D-075 shell abort 升级/兜底;D-099 emergency microcompact;D-102 env 白名单;D-105 项目配置 opt-in;D-106 破坏性工具不自动重试;D-107 listTools 超时;D-108 MCP content/schema/description 上限 |
| 2026-10-19 | B 档修复(fix/p0-a-tier):`fs`/`glob`/`grep` 响应 `AbortSignal`(D-071/D-077 已解决);MCP 终止后轮询 PID,未确认退出则拒绝重连并返回 `mcp_uncertain`;`artifactPath` 存在的 evidence 在 emergency 阶段可降级为 artifact 引用(D-099 进一步缓解) |
| 2026-10-19 | 标记 P0 未完成面:录入 D-109(第三方 in-process 工具缺 worker 隔离)、D-110(无 artifact evidence 超窗)、D-111(live 网关/真实 MCP/真机/终止失败路径验证缺口);D-022/D-099 补交叉引用;D-102 标注 `inheritEnv:true` 为显式设计取舍 |
| 2026-10-19 | P0 剩余项修复(`fix/p0-remaining`):D-010/D-013/D-014/D-016/D-023/D-028/D-034/D-035/D-036/D-037/D-039/D-042/D-044/D-045/D-046/D-048/D-049/D-073/D-089/D-090/D-100/D-101/D-103/D-104 标已解决;D-084 标部分解决(新增 `nextOffset` 与跳过分类) |
| 2026-10-19 | M2 权限系统 Task 8:录入 D-112 ~ D-117(Web/SSE 审批未实现、`paramsPreview` 敏感片段、规则非沙箱、串行审计崩溃窗口、内部 API 绕过、MCP 参数不应用 server 默认值);README 新增「权限与审批」 |
| 2026-10-19 | M2 权限系统全量复验:录入 D-118 ~ D-131(审计摘要 `__proto__` 键丢失与 digest 冲突、`truncated` 参数被覆盖、`loadPermissionConfig` 不校验 inline、纯空白配置字段、不可 stat 的项目配置不披露、resume 重复 IO、四处测试缺口、symbol 键未防、EOF/空操作整洁性、恒真断言、串行路径缺口、审批 abort 语义);D-132 记录并标注已解决(`errorMessage`/`describeValue` 二次抛错导致审批队列卡死) |
| 2026-10-19 | 权限系统高价值项修复(`feat/m2-permission`):D-118 `__proto__` 审计键丢失、D-119 截断标记改名 `previewTruncated`、D-120 inline 复用 schema 校验、D-121 空白字段拒绝、D-122 不可 stat 项目配置 fail-closed、D-125 测试 home 隔离、D-126 symbol 键拒绝、D-128 恒真断言替换;D-124/D-127/D-129 部分解决;README/spec 同步标记名 |
| 2026-10-20 | M2 事件总线 Task 7 交付:D-063 标注已解决(`/api/events` 由 501 替换为真实 SSE,写操作仍 501);录入 D-133 ~ D-137(单会话流、无进程内低延迟适配器、无独立 evidence 事件、大日志补播未压测、Web 审批未实现);README 新增「实时事件流」,frontend-design 补统一事件数组/游标/缺口重拉/设备 patch/MCP 与权限展示 |
| 2026-10-20 | 事件总线全量复验与修复(`feat/m2-event-bus`):D-138 实时单帧写超时→`slow_consumer`(已解决,残余记入条目);D-140 列表与详情共用 `isValidSessionId`(已解决);D-141 `readSessionHeader` 收敛到 persistence 并补 EACCES 用例(已解决);D-142 删除死代码 `createEventStream`/`splitCompleteLines`(已解决);D-144 文档改为 `SessionEventEnvelope` 并补 `since` 夹紧语义(已解决);录入 D-139(`/api/actions` 仍 501)与 D-143(`applySessionEvent` O(n²))为未解决 |
| 2026-10-20 | M2 Web 审批闭环(`feat/m2-web-approval`):D-137(`approval_request` + `POST /api/approvals` + 审批 UI)与 D-139(`/api/actions` 落地)标已解决;D-112 的 Web 部分标已解决;录入 D-145 ~ D-152(重启丢失 pending、仅 Origin 校验、摘要敏感片段、单会话串行、SSE 200ms 延迟、迟到决策 404/410 不一致、未响应 abort 占用 `session_busy`、在途发送切回会话);README 新增「Web 会话与审批」,frontend-design 补审批卡片与状态机 |
| 2026-10-20 | M2 Web 审批红队修复(`feat/m2-web-approval`):审批标识改为 gate 生成的独立 UUID(与 `callId` 解耦),`permission_decision`/崩溃恢复/transcript 按 `requestId` 配对;408 不再销毁连接;写端点拒绝 `Sec-Fetch-Site: cross-site`;启动前失败写 `interrupted(start_failed)`;D-146 补浏览器跨源面;录入 D-153(port 0 写端点 403)与 D-154(close 后 decide 返回 404) |
| 2026-10-20 | 权限引擎与 Web 审批全量复验(`feat/m2-web-approval`):构建产物探针实测通过 135 项断言;D-154 复现并补记与 README/spec 的措辞冲突;录入 D-155(spec 三处残留 `requestId === callId` 旧描述)与 D-156(`tests/mcp-manager.test.ts` 时间阈值用例在并行负载下偶发失败);本轮未改生产代码 |
| 2026-10-20 | BR-2/BR-3 Task 11:新增 `scripts/kb-regression.mjs`(index/search/负样本三轨,缺少本地资产时退出码 2)与 `regression.test.ts`/`regression-baseline.json`;README 新增 KB MCP 配置、语料偏差与实测基线;录入 D-157(真串口与真机 OpenOCD 未实测)与 D-158(KB 本地资产不入库导致 CI 回归覆盖缺口) |
| 2026-10-20 | BR-2/BR-3 第一轮独立审查修复:C1/KB 拒答引入技术 token 覆盖度(refusalRate 0.56→0.84,Recall@2 0.46→0.44);I1 OpenOCD 全 0 warning;I2 Renode `available()`;I3 OpenOCD attach 仅 telnet、移除 `openocdConfig`;I4 search 严格 Hit@1 + `goldInTop20`;I5 工具接 AbortSignal 并收紧 `serial_read` 上限;I6 spec 工具数改 14;录入 D-159(拒答未达 100%)、D-160(超时迟到输出竞态)与 D-161(10/20ms 定时器抖动) |
