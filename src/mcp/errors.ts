export type McpConfigErrorCode = "mcp_config_invalid";

export class McpConfigError extends Error {
  readonly code: McpConfigErrorCode = "mcp_config_invalid";
  readonly detail?: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "McpConfigError";
    this.detail = detail;
  }
}