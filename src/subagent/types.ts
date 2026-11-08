/**
 * 只读子代理的对外形态（批次 9 · 9.4）。
 *
 * 纯类型模块：不 import 任何运行期代码，`src/session/types.ts` 才能安全地
 * 依赖它来声明 `subagent_result` 事件的 payload。
 */

export type SubagentStatus = "running" | "finished" | "failed" | "killed" | "timed_out";

/**
 * 一个子代理的当前状态或终局。
 *
 * 与后台作业（`BackgroundResultPayload`）同一口径：`text` 是我们**真正留下**的
 * 正文，`textBytes` 是子会话原文的字节数、`capturedBytes` 是留下部分的字节数；
 * 两者不等即 `truncated = true`。只报截断后的长度会把截断说成完整（R3）。
 *
 * `error` 只在 `status === "failed"` 时出现：`killed` / `timed_out` 的原因是
 * `killedBy`，不是一条错误消息。
 */
export interface SubagentSummary {
  id: string;
  sessionDir: string;
  status: SubagentStatus;
  startedAt: string;
  finishedAt?: string;
  turns: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
  /** 子会话最后一条 assistant 正文（超过上限时截断，`truncated` 为 true）。 */
  text: string;
  /** 子会话结论原文的字节数。 */
  textBytes: number;
  /** 实际保留进 `text` 的字节数；小于 `textBytes` 即发生了截断。 */
  capturedBytes: number;
  /** `failed` 时的原因；status 不是 failed 时不出现。 */
  error?: string;
  /** `text` 被截断。 */
  truncated?: boolean;
  killedBy?: "kill" | "timeout" | "abort";
  /** `subagent` 调用时给的显示名；没给就不出现——不拿 id 冒充名字。 */
  label?: string;
  /**
   * prompt 的开头预览。
   *
   * 名字里写明是**预览**：完成事件与列表都只需要一句话认出「这是哪一件差事」，
   * 把整段 prompt 复制进父日志则会让同一段文字在会话里出现两遍。
   */
  promptPreview: string;
}
