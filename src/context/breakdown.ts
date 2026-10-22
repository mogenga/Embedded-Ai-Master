import { heuristicCountTokens } from "../model/count.js";
import type { ModelChatMessage } from "../model/protocol.js";

export type ContextPartKey = "systemPrompt" | "messages" | "toolResults" | "mcpTools";

export interface ContextPart {
  key: ContextPartKey;
  tokens: number;
}

export interface ContextBreakdown {
  /** 与入参 `used` 完全相等：它是压缩阈值判定用的那个实测值。 */
  used: number;
  window: number;
  /** 一位小数，钳在 [0, 100]。 */
  percent: number;
  compactAt: number;
  /** 只含 tokens > 0 的项；`used > 0` 且非空时其和恰等于 `used`。 */
  parts: ContextPart[];
}

export interface ContextBreakdownOptions {
  window: number;
  used: number;
  compactAt: number;
  measure?: (messages: ModelChatMessage[]) => number;
}

/** 固定顺序：同一切片在不同会话里必须是同一个位置与同一种颜色。 */
const PART_ORDER: readonly ContextPartKey[] = [
  "systemPrompt",
  "messages",
  "toolResults",
  "mcpTools",
];

/** MCP 工具名由 `src/mcp/tools.ts` 生成，前缀是唯一可靠的归属标记。 */
const MCP_TOOL_PREFIX = "mcp__";

interface Bucket {
  key: ContextPartKey;
  messages: ModelChatMessage[];
}

type BucketMap = Record<ContextPartKey, ModelChatMessage[]>;

function emptyBuckets(): BucketMap {
  return { systemPrompt: [], messages: [], toolResults: [], mcpTools: [] };
}

/**
 * 建立 `tool_call_id -> 工具名` 的表，用来判断一条 tool 消息来自哪个工具。
 *
 * 名字只能取自 assistant 消息里声明的 `tool_calls[].function.name`：tool 消息本身
 * 的 `name` 字段在投影时并不写入（`buildMessages` 只带 `tool_call_id`），拿它判空
 * 会把所有 MCP 结果都算成普通工具结果。
 */
function collectToolNames(messages: readonly ModelChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      // 同一 id 重复声明时以最早的一条为准：首个声明才是这次调用的来源，
      // 后出现的同名 id 更可能是拼接错误，不该改写归属。
      if (!names.has(call.id)) names.set(call.id, call.function.name);
    }
  }
  return names;
}

function classify(messages: readonly ModelChatMessage[]): BucketMap {
  const buckets = emptyBuckets();
  const toolNames = collectToolNames(messages);
  for (const message of messages) {
    switch (message.role) {
      case "system":
        buckets.systemPrompt.push(message);
        break;
      case "user":
      case "assistant":
        buckets.messages.push(message);
        break;
      case "tool": {
        const id = message.tool_call_id;
        const name = id === undefined ? undefined : toolNames.get(id);
        // 查不到名字时退回普通工具结果：宁可少报一个 MCP 切片，
        // 也不能把来源不明的结果算进 MCP 那一块。
        if (name !== undefined && name.startsWith(MCP_TOOL_PREFIX)) {
          buckets.mcpTools.push(message);
        } else {
          buckets.toolResults.push(message);
        }
        break;
      }
      default:
        // ModelRole 目前只有上面四种；将来新增角色时按「普通消息」兜底，
        // 让总额不至于凭空少一块。
        buckets.messages.push(message);
        break;
    }
  }
  return buckets;
}

/**
 * 把消息按类别拆成 token 数，供上下文弹层画分段条。
 *
 * `used` 以调用方传入的实测值为准，**不是**各桶之和：调用方传的是压缩阈值判定
 * 用的那个数（可能来自 `TokenMeter`，已按真实 usage 校准过比例），而各桶只能逐桶
 * 重新测量。两者本来就会差几个 token——以调用方为准，图上的总量才和 chip、阈值
 * 说的是同一件事；差额通过下面的等比缩放摊回各桶。
 */
export function buildContextBreakdown(
  messages: ModelChatMessage[],
  opts: ContextBreakdownOptions,
): ContextBreakdown {
  const { window, used, compactAt } = opts;
  const percent =
    window > 0 && Number.isFinite(used)
      ? Math.max(0, Math.min(100, Math.round((used / window) * 1000) / 10))
      : 0;

  // 没有可归因的占用时返回空数组而不是编一组零：调用方据此隐藏分段条，
  // 与「已经量出 0%」是两件事。
  if (!Number.isFinite(used) || used <= 0 || messages.length === 0) {
    return { used, window, percent, compactAt, parts: [] };
  }

  const buckets = classify(messages);
  const measure = opts.measure ?? heuristicCountTokens;
  // 逐桶测量要按 PART_ORDER 走：输出顺序是契约的一部分，不能随对象键顺序变化。
  const grouped: Bucket[] = PART_ORDER.map((key) => ({
    key,
    messages: buckets[key],
  }));
  const raw = grouped.map((bucket) => {
    if (bucket.messages.length === 0) return 0;
    const value = measure(bucket.messages);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });

  const total = raw.reduce((sum, value) => sum + value, 0);
  // 逐桶测量后再按 used 等比缩放：如果直接把原始测量值当成结果，
  // 各桶之和会与 chip 上的 used 对不上，用户会看到「分段加起来不等于总数」。
  const scaled =
    total > 0 ? raw.map((value) => Math.floor((value * used) / total)) : raw.map(() => 0);

  // 取整丢掉的余数补给最大的那个桶（同分时取固定顺序里靠前的）：
  // 它占比最大，多一两个 token 不会改变读图结论，而分摊给多个桶会让
  // 「最大切片」发生无意义的抖动。
  let target = 0;
  if (total > 0) {
    for (let index = 1; index < raw.length; index += 1) {
      if (raw[index] > raw[target]) target = index;
    }
  } else {
    // 每个桶都量不出 token，但调用方说 used > 0（例如自定义 measure 只认某类内容）：
    // 总额不能凭空消失，记在第一个真的有消息的桶上，而不是伪造一个不存在的类别。
    const first = grouped.findIndex((bucket) => bucket.messages.length > 0);
    target = first < 0 ? 0 : first;
  }
  const remainder = used - scaled.reduce((sum, value) => sum + value, 0);
  scaled[target] += remainder;

  const parts: ContextPart[] = [];
  for (let index = 0; index < grouped.length; index += 1) {
    if (scaled[index] <= 0) continue;
    parts.push({ key: grouped[index].key, tokens: scaled[index] });
  }
  return { used, window, percent, compactAt, parts };
}
