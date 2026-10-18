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

- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `src/model/openai.ts` 中成功响应的 `await response.json()` 若抛 `AbortError`(响应头已到、体读取阶段被取消),被 `catch` 统一包装为 `ModelResponseError(code: "invalid_response")`,cause 才是 `AbortError`。同文件错误路径的 `response.text()` 抛 `AbortError` 时却原样透传,两条路径语义不一致。
- **影响**: Task 9 主循环按错误类型区分"取消 → 落 `interrupted` + `done(aborted)`"与"模型响应非法 → 终止错";此场景会被记成后者,取消被误报为协议错误。
- **触发升级条件**: ① Task 9 开始实现取消分支(必然依赖错误类型判别);② 实际出现取消被显示为模型错误。
- **修复建议**: 在 `json()` 的 `catch` 中先 `isCancellationError(err) || opts.signal.aborted` 判断,命中则原样 `throw err`;补一条「`json()` 抛 AbortError → rejects AbortError 而非 invalid_response」测试(plan Task 6 已补该测试条目)。

### D-012 · `choices[0]` 非对象被静默当作空成功

- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `{"choices":[null]}` 或 `{"choices":["bad"]}` 返回 `{ content: "", toolCalls: [], truncatedByMaxTokens: false }`,不抛错。`21b8e63` 已把「`choices` 缺失/非数组/空数组」判为 `invalid_response`,但元素级未校验。
- **影响**: 网关畸形响应被伪装成"模型正常地没说话",主循环会以 `no_tool_calls` 正常终止并写入日志——违背 R3 诚实原则,且故障被掩盖。
- **触发升级条件**: ① Task 10 端到端集成前(建议随即修复,改动仅一行判空);② 出现网关畸形响应导致的静默空轮次。
- **修复建议**: 在取 `choices[0]` 后加 `if (choice === null || typeof choice !== "object" || Array.isArray(choice)) throw new ModelResponseError(...)`;补 plan 已列的 `choices[0]` 非对象测试。

### D-013 · 非 http(s) scheme 的 `baseUrl` 不被拒绝

- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `createOpenAIProvider({ baseUrl: "ftp://gw/v1" })` 构造成功;首次请求时 `fetch` 抛 `TypeError`,被包成 `NetworkError` 并按可重试错误退避 4 次才暴露。
- **影响**: 配置错误被延迟为"网络故障",排查成本高;每次启动白白消耗数秒退避。
- **触发升级条件**: 出现因误填 scheme 导致的启动延迟或误诊。
- **修复建议**: `resolveChatCompletionsUrl` 中校验 `url.protocol` 为 `http:`/`https:`,否则抛 `TypeError`(与非法 URL 同路径、创建期失败)。

### D-014 · `usage` 数字字段为字符串时整体省略 usage

- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: `usage: { prompt_tokens: "10", completion_tokens: 3 }` 时 `hasCompleteUsage` 为 false,返回结果不含 `usage`。
- **影响**: 计价与 `maxCostUsd` 熔断静默失去数据(只计 token 不熔断),与"字段缺失 ⇒ undefined"的刻意 fail-soft 难以区分。
- **触发升级条件**: ① 接入真实网关后发现 usage 字段类型漂移;② 计价出现无法解释的零成本。
- **修复建议**: 数值字段用 `Number()` 收窄后判 `Number.isFinite`,或对非数值 usage 记一条 `status` 事件说明被忽略的原因。

### D-015 · `opts.signal` 是否传给 `fetch` 无断言看守

- **发现**: 2026-10-17,Task 6 交付核验。
- **现象**: 变异探针删除 `fetch(...)` 中的 `signal: opts.signal` 后,43 条测试全绿。现有取消测试只覆盖"退避期间取消不再发下一次请求"与"fetch 自身抛 AbortError"。
- **影响**: 真实请求进行中的取消依赖 `signal` 传到 `fetch`;若被误删,长请求(串口长读、大模型响应)将无法中断,且无测试报警。
- **触发升级条件**: Task 9 接入真实取消路径前(建议随即补断言)。
- **修复建议**: 补一条断言 `init.signal === 传入的 signal` 的测试(plan Task 6 已补该测试条目)。

### D-016 · 错误面仅 `ModelFatalError` 带 `code`,其余错误类型未导出

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

- **发现**: 2026-10-18,Task 7 交付核验。
- **现象**: `ToolRegistry` 现按 OpenAI function 名契约校验(`a-z/A-Z/0-9/_/-`,1-64 字符)。经 Context7 查证 MCP SEP-986,工具名**额外允许 `.` 和 `/`**(用于命名空间,如 `user-profile/update`)。即 MCP 合法名可能被注册表直接拒绝。
- **影响**: 当前 P0 只有内置 echo,无影响;接入 MCP 客户端(设计稿 #5)时,带 `/` 或 `.` 的 server 工具会构造期抛错。且这类名字本就不能原样发给 OpenAI,必须在挂载层做**名称映射**(如 `mcp__server__tool`),而不是放宽注册表校验。
- **触发升级条件**: ① 实现 MCP 客户端工具挂载时(必然遇到);② 首个 MCP server 工具名含 `.` 或 `/`。
- **修复建议**: 在 MCP 挂载层统一重命名并维护 `暴露名 → (server, 原工具名)` 映射,注册表保持 OpenAI 契约;补一条「MCP 名含 `/` 经映射后可注册」的测试。

### D-022 · 超时只保证管线返回,不保证工具停止

- **发现**: 2026-10-18,Task 8 第三轮红队审查(I6)。原请求编号 D-021 已被 Task 7 占用,故顺延为 D-022。
- **现象**: `executeBatch` 以 `Promise.race` 在超时后返回 `tool_timeout`,但不监听 signal 的工具不会停止;串行分支在超时返回后立即发起下一次调用,前一个写工具可能仍在运行,实际形成并发写。
- **影响**: 当前 P0 只有只读 echo,无影响;接入探针写内存、复位或文件写入工具后,超时后的残留调用可能与下一次写调用重叠,破坏串行写假设并造成设备状态竞争。
- **触发升级条件**: P1 接入首个非只读工具(写内存/复位/文件写入)前。
- **修复建议**: 写工具接入前引入可等待的终止或隔离机制(进程级 worker、MCP 会话级取消并等待服务端确认);或在超时后拒绝启动同批次后续写工具,并把会话标记为需人工确认。

### D-023 · 非字符串 `call.id` 绕过重复检测

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

- **发现**: 2026-10-18,Task 9 第三轮红队审查(Minor)。
- **现象**: `buildMessages` 将 marker 的 raw 原样回填,`query` 的 markerResult 也将 raw 原样写入 text/detail;模型一次输出超长坏参数会直接放大下一轮上下文与日志。
- **影响**: 极端情况下可能触发 context 超限或日志膨胀,当前无上限/截断。
- **触发升级条件**: 真实模型输出超长非法 arguments,或日志/上下文预算被单条 raw 顶爆。
- **修复建议**: 对 raw 设字符上限(如 8k),超限截断并附 `truncated:true`,同时保留 hash/长度摘要。

### D-029 · assistant 重复 tool call id 的投影未拦截

- **发现**: 2026-10-18,Task 9 第三轮红队审查(Minor)。
- **现象**: `buildMessages` 登记批次时按 id 列表保留重复项;`tool_result` 侧用 seen 集合拒绝重复结果,但 assistant 自身声明重复 id 时,投影出的 `tool_calls` 仍含重复 id。
- **影响**: 若模型返回重复 id,批次可能永远缺一个结果并在 `buildMessages` 末尾抛 `missing tool_result`,或产生配对歧义。
- **触发升级条件**: 模型返回重复 tool call id,或引入非 Task 6 的响应构造方。
- **修复建议**: 在 `projectAssistant` 登记批次时检测重复 id 并抛错(与 `tool_result` 的 duplicate 语义对齐),或在 `query` 分流前归一化/拒绝重复 id。

### D-030 · query 初始化 append 失败不落 `interrupted(error)`

- **状态**: 已登记(2026-10-18,Task 9 第四轮整合审查 N2);N3/N5 并入本条目跟踪。
- **发现**: 2026-10-18,Task 9 第四轮整合审查(N2);N3(补偿写失败未测)与 N5(批次交错负例)同轮提出。
- **现象**: `query` 的 `ctx.systemPrompt` 补写与首次 `user` append 位于主循环 `try` 之前。systemPrompt 与已有会话冲突时会直接 throw;首次 user append 失败(磁盘满、权限、目录被删)时也不进入统一 catch/finally,因此日志可能只有部分事件且没有 `interrupted(error)`。
- **影响**: 会话回放看不到终止原因,审计链在初始化阶段断裂;Task 10 装配层若把写失败当作普通异常上报,日志与退出状态可能不一致。
- **触发升级条件**: ① Task 10 装配 `runSession` 并接入真实文件系统;② 会话目录写失败(磁盘满/权限/目录被删);③ 消费者依赖日志还原终止原因。
- **修复建议**: 把初始化 append 纳入统一错误出口(在 catch 中补 `interrupted(error)` 后 rethrow),或明确"初始化失败不保证日志"契约并在文档与测试中固定。
- **关联 N3(补偿写失败未测)**: catch/finally 的补偿 append 已用 try/catch 吞错以保留原错误,但现有测试只覆盖单次瞬时 append 失败,未覆盖补偿写本身失败(如 `tool_result_lost` 写失败、`interrupted(error)` 写失败)。影响: 补偿完整性无断言看守。触发: 会话写持续失败。建议补两条负例,断言原错误仍上抛且不抛补偿错误。
- **关联 N5(批次交错负例)**: `buildMessages` 已实现批次未完成时拒绝 user/system/assistant,但测试只覆盖 user 插批与 system 位置;未覆盖 assistant 插批、system 插批、跨批次 parent、批次完成后的孤立 `tool_result`。影响: 交错回归可能漏网。触发: 引入回放/并发写入方。建议补对应负例。

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
