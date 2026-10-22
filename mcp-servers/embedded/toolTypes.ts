/** Shared annotation shape for the embedded/keil MCP servers (mirrors probe). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  /** Read-back / measurement results that downstream compaction must protect. */
  evidenceHint?: boolean;
}
