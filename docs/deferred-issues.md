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

- **状态**: **已解决**(2026-10-18,`fix/p0-full-review`;新增断言 `init.signal === opts.signal`)。
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

### D-032 · 模型请求无超时

- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: `fetch` 只传 `opts.signal`,没有请求级超时;工具管线有 `timeoutMs`,模型请求没有对应机制。
- **影响**: 网关接受连接后长期不返回时,主循环会无限等待(除非调用方主动 abort),无人值守场景不可用。
- **触发升级条件**: 真实网关出现挂起;需要长时间无人值守运行;出现无法解释的会话停滞。
- **修复建议**: 为模型请求增加可配置超时,超时映射为可重试或终止错误(需固定语义),并补「挂起 → 超时」测试。

### D-033 · token 预算不计 tool_calls

- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: `heuristicCountTokens` 只累加 `message.content.length`;assistant 消息的 `tool_calls` 名称与参数、以及回填的工具调用结构不计入预算。
- **影响**: 工具密集会话的预算被系统性低估,可能直到真实上下文超限才暴露。
- **触发升级条件**: 出现上下文超限;工具调用占比高的会话预算明显偏离 `usage`;引入 usage 锚定校准。
- **修复建议**: 将 `tool_calls[].function.name/arguments` 按序列化长度计入估算,或在 usage 锚定时按实际值校准。

### D-034 · 文本截断可能切断代理对

- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: `src/tools/pipeline.ts` 的 `truncateText` 按 UTF-16 code unit 直接 `slice`,当截断点落在代理对中间时会留下孤立代理字符;`MAX_TEXT_CHARS` 与 200/2000 的出口截断均受影响。
- **影响**: 含 emoji 或扩展 CJK 的工具输出被截断后,日志/JSON 可能出现替换字符或编码异常。
- **触发升级条件**: 真实工具输出含 emoji/扩展 CJK 且触发截断;下游对文本编码做严格校验。
- **修复建议**: 截断时检测 `charCodeAt(max - 1)` 是否为高代理,若是则回退一位;补代理对边界测试。

### D-035 · 会话 append 原子性与初始化回滚不完整

- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核;关联 D-003、D-030。
- **现象**: `append` 通过队列追加 JSONL,无 `fsync`,进程崩溃或断电可能留下半行;初始化阶段 `systemPrompt`/首条 `user` 写入失败不进入统一 `interrupted(error)` 出口,回滚分支覆盖也不完整。
- **影响**: 会话日志可能不可回放或缺少终止原因,违背「日志是唯一事实源」的审计要求。
- **触发升级条件**: 真实断电/强杀/磁盘满;多进程并发写同一会话;消费者依赖日志还原终止原因。
- **修复建议**: 写入后 `fsync` 或采用临时文件 + rename;启动时校验并隔离坏尾行;把初始化写入纳入统一错误出口并补失败回滚测试。
- **扩展**: 2026-10-18,维度6 Task3 审查。closed 会话末行缺换行时,`readSessionDir` 仍能解析,`resumeSession` 成功;后续 `append` 直接追加,与上一行粘连,再次读取报 `invalid_event_line`。已补测试钉死当前行为(`tests/session.test.ts`「closed 会话末行缺换行时 resume 仍成功续写」),未实现自动补换行或坏尾隔离,留待本项修复。

### D-036 · 4xx 未细分 408/409/425

- **发现**: 2026-10-18,`fix/p0-full-review` 全量复核。
- **现象**: `src/model/openai.ts` 将所有 4xx(429 除外)归为不可重试的 `ModelFatalError(api_4xx)`;408/409/425 等本可重试的状态同样立即终止。
- **影响**: 网关短暂过载或请求过早时无法自动恢复,会话以非预期 4xx 失败结束。
- **触发升级条件**: 网关返回 408/409/425;出现需要重试的 4xx 故障;扩展错误码分类。
- **修复建议**: 明确 4xx 状态 → 可重试/不可重试映射表,将 408/409/425 纳入重试集合,并补状态矩阵测试。

### D-037 · tool call type/content 校验缺失

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

### D-041 · fork 失败回滚只删 targetDir,父目录链残留且回滚失败静默

- **发现**: 2026-10-18,维度6 Task4 审查(Task5 登记)。
- **现象**: `forkSession` 失败时 `cleanupTargetDir` 仅对 `targetDir` 做 `rm(recursive)`,不回滚为占位而由 `mkdir(path.dirname(targetDir), { recursive: true })` 创建的父目录链;回滚步骤全部以 `.catch(() => undefined)` 吞掉错误。若失败发生在占位前(父目录已创建),或回滚本身失败,调用方只收到原始错误。
- **影响**: 失败 fork 会残留空父目录;反复失败可能留下目录树。回滚失败无任何信号,调用方可能误判「未写入任何内容」,也增加后续排障成本。
- **触发升级条件**: fork 目标固定为多层不存在目录;出现残留目录导致后续 `target_not_empty`;需要严格的失败原子性与可观测回滚。
- **修复建议**: 记录本次实际创建的父目录层级并在失败时逆序删除;把回滚失败聚合进抛出的错误(`cause`/`detail` 或 `AggregateError`),至少保留可诊断信号。

### D-042 · artifact 越界与缺失共用 artifactMissing,目录 artifact 未定义

- **发现**: 2026-10-18,维度6 Task4 审查(Task5 登记)。
- **现象**: artifact 路径词法越界(位于 sourceDir 外)与源文件缺失(`stat` ENOENT)都调用 `markArtifactMissing`,统一写 `detail.artifactMissing = true`,消费方无法区分「拒绝复制」与「源文件不存在」。此外 `artifactPath` 指向目录时行为未定义: `stat` 成功,但随后 `copyFile` 抛 `EISDIR`/`EPERM`,导致整个 fork 失败,而不是按 artifact 缺失跳过。
- **影响**: 缺失原因不可审计;目录型 artifact 会阻塞 fork,与设计「artifact 缺失不阻塞 fork」不一致。
- **触发升级条件**: 需要区分 artifact 缺失原因;工具产物可能为目录;出现因 artifact 为目录导致的 fork 失败。
- **修复建议**: 为越界、缺失、非普通文件定义区分性标记或原因码(如 `artifactRejected`/`artifactMissing`/`artifactUnsupported`);复制前用 `stat().isFile()` 校验,非普通文件按不支持标记并跳过复制。

### D-043 · `header.workdir` 与实际工具 cwd 来源不一致

- **发现**: 2026-10-18,维度6 Task6 审查修复。
- **现象**: `runSession` create 路径把 `workdir: opts.cwd ?? process.cwd()` 写入 `header.workdir`;但传给 `LoopCtx.cwd` 的仍是 `opts.cwd`(未提供即 `undefined`),工具管线在 `src/tools/pipeline.ts:314` 用 `opts.cwd ?? session.dir` 作为实际执行目录。未显式传 `opts.cwd` 时,header 记录的是启动进程的 cwd,工具实际在 `session.dir` 下执行。
- **影响**: header 元数据无法用于还原/审计工具真实工作目录;未来若基于 `header.workdir` 重放、fork 或恢复编辑上下文,会得到与执行语义不符的路径。当前工具仅 `echo`,风险低。
- **触发升级条件**: 出现依赖 `header.workdir` 恢复执行上下文的功能(重放、继续编辑、脚本路径解析);或工具从 `echo` 扩展到文件读写/命令执行。
- **修复建议**: 统一来源——create 时写入 `opts.cwd ?? session.dir`,或让 `LoopCtx.cwd` 默认取 `header.workdir`;在 design 中明确 `header.workdir` 是「会话工作目录」还是「进程启动目录」。

### D-044 · resume 只校验首个 system 事件

- **发现**: 2026-10-18,维度6 Task6 审查修复。
- **现象**: `runSession` resume 时用 `events.find((event) => event.type === "system")` 只比较首条 system 事件内容;后续 system 事件既不参与内容比较,也不影响「无 system」判定。当前 P0 仅由 `createSession` 写入一条 system,`query` 只在无 system 时补写一条,不会产生多条。
- **影响**: 若未来支持多 system 事件(分层提示、运行时追加/替换),resume 可能放行与当前 `systemPrompt` 不一致的会话,空会话补写判定也可能误判。
- **触发升级条件**: 引入多 system 事件;compaction 或运行时修改 system prompt;多段提示拼接。
- **修复建议**: 明确 `systemPrompt` 与多 system 的映射策略(拼接、比较全部、或只允许首条),校验所有相关事件并给出确定性规则。

### D-045 · `checkpoint.turn` 每次 query 从 1 重新编号,resume 后与历史重复

- **发现**: 2026-10-18,维度6 Task8 收尾。
- **现象**: `src/loop/query.ts` 在每次 `query` 调用内以 `let turn = 0` 起算,每轮 `turn += 1` 后写入 `checkpoint { turn }`。resume 后再次调用 `query` 会重新从 1 编号,生成的 checkpoint 与同目录历史 checkpoint 的 `turn` 重复;当前 checkpoint 只被写入,没有恢复/重放消费方。
- **影响**: 当前仅影响日志审计可读性,不影响执行;若未来按 `turn` 定位断点、去重或恢复,重复编号会产生歧义。
- **触发升级条件**: 出现 checkpoint 消费方(断点续跑、回合定位、恢复投影);需要按 `turn` 唯一定位。
- **修复建议**: 由 `query` 从会话日志最后一个 checkpoint 的 `turn` 续编,或改用全局 `seq`/事件序号作为唯一标识,并在 design 中明确语义。

### D-046 · 无主错误时 close 异常上抛分支缺真实路径测试

- **发现**: 2026-10-18,维度6 Task8 收尾。
- **现象**: `runSession` 的 `finally` 中,`session.close()` 异常仅在 `hasPrimaryError === false` 时上抛(`src/index.ts:179-185`)。现有集成测试只覆盖「运行期主错误 + close 异常不覆盖原错误」;`tests/integration.test.ts` 已有 `resumeCloseFailure` mock 可让 resume 返回的 handle `close` 抛出,但未构造「无主错误且 close 抛出」的用例,该上抛分支未被看守。
- **影响**: 当前行为正确但无回归保护;若重排 `finally` 或调整错误优先级,可能静默吞掉 close 失败而不被测试发现。
- **触发升级条件**: 重构 `runSession` 装配/关闭流程;引入可注入的 handle 工厂;审计关闭错误可观测性。
- **修复建议**: 复用现有 `resumeCloseFailure` mock(或抽 handle 工厂),补一条「resume 正常完成、close 抛错 → 调用方收到 close 错误」的集成测试。

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
