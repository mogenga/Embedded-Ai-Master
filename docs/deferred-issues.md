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

### D-010 · 退避 `sleep` 不响应取消

- **发现**: 2026-10-17,Task 6 第二轮整合复审。
- **现象**: `src/model/retry.ts` 的 `sleep` 只接受毫秒数、不接收 `AbortSignal`。适配器仅在每次尝试开始前检查 `opts.signal.aborted`,正在进行的 `setTimeout` 不会因取消提前结束,因此取消最多要等待当前退避周期结束。
- **影响**: 不发起新请求、结果仍正确;但交互取消的响应延迟最多为一个退避周期(默认首次约 1s,并按指数增长),取消后进程可能迟迟不退出。
- **触发升级条件**: ① 验收指标要求取消立即生效或用户明显感知延迟;② `baseDelayMs`/`maxRetries` 调大导致等待显著;③ 出现取消后进程迟迟不退出的问题。
- **修复建议**: 让 `sleep` 接受 `AbortSignal`(或把 signal 传入 `retry`),在睡眠中监听 abort 并提前 reject;或改用可取消定时器。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-17 | 建档,录入 D-001 ~ D-008 |
| 2026-10-17 | 录入 D-009(cached token 之外的 usage 明细延后) |
| 2026-10-17 | D-001 标注已解决(补默认 sleep/rand 真实重试测试);录入 D-010(退避 sleep 不响应取消) |
