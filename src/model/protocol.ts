export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelChatMessage {
  role: ModelRole;
  content: string;
  tool_call_id?: string;
  name?: string;
  /**
   * assistant 消息声明过的工具调用,形取 OpenAI wire 格式(`arguments` 为原始字符串)。
   * Task 9 的 buildMessages 靠它把会话日志里的 toolCalls 投影回模型上下文;
   * 本层只做透传,不改写。
   */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ModelToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface CompletionResult {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown> | { error: "invalid_json"; raw: string };
    /**
     * 适配器内部标记: arguments 解析失败时为 true。
     * 模型自己输出的同形参数不会带此标记,避免形状误判(D-038)。
     */
    invalidJson?: boolean;
  }>;
  truncatedByMaxTokens: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
  };
  stopReason: unknown;
}

export interface ModelProtocol {
  complete(
    messages: ModelChatMessage[],
    tools: ModelToolSchema[],
    opts: {
      signal: AbortSignal;
      maxOutputTokens: number;
      onDelta?: (text: string) => void;
    },
  ): Promise<CompletionResult>;
  countTokens(messages: ModelChatMessage[]): number;
}
