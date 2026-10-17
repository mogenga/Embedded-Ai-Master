export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelChatMessage {
  role: ModelRole;
  content: string;
  tool_call_id?: string;
  name?: string;
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
