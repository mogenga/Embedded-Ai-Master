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

- **发现**: 2026-10-17,Task 7 第二轮整合复审。
- **现象**: `ToolCtx` 要求 `sessionId` 与 `cwd`,但 `SessionHandle` 只有 `id`/`dir`,Task 8 计划中的 `executeBatch` opts 也只有 `signal`/`artifactDir`;`cwd` 由谁提供、取 `process.cwd()` 还是会话工作目录未定义。
- **影响**: echo 不受影响;文件类工具在 Task 8 接入时行为不确定,可能出现相对路径解析到错误目录。
- **触发升级条件**: ① Task 8 实现 `executeBatch` 时;② 首个依赖相对路径的工具接入时。
- **修复建议**: 在 Task 8 的 `executeBatch` opts 增加 `cwd`,由装配层显式传入;或把 `ToolCtx.cwd` 改为可选并约定缺省为 `process.cwd()`。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-17 | 建档,录入 D-001 ~ D-008 |
| 2026-10-17 | 录入 D-009(cached token 之外的 usage 明细延后) |
| 2026-10-17 | D-001 标注已解决(补默认 sleep/rand 真实重试测试);录入 D-010(退避 sleep 不响应取消) |
| 2026-10-17 | Task 6 交付核验:录入 D-011 ~ D-018(取消误报、choices[0] 畸形、scheme 校验、usage 类型漂移、signal 无断言、错误面不可分类、F9-F12 未闭环、.tmp 游离);D-010 排版归位 |
| 2026-10-17 | Task 7 整合复审:录入 D-019(`$schema` 网关兼容)、D-020(`ToolCtx.cwd` 来源) |
