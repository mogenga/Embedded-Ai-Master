import { truncateSurrogateSafe } from "./text.js";

export const ELIDED_FIRST_LINE_CHARS = 120;

function formatElided(payload: Record<string, unknown>, text: string): string {
  const artifactPath = payload.artifactPath;
  if (typeof artifactPath === "string") {
    return `[tool result elided; full output at ${artifactPath}]`;
  }
  const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
  const firstLine = text.split(/\r?\n/, 1)[0];
  return `[tool result elided; ${toolName}: ${truncateSurrogateSafe(firstLine, ELIDED_FIRST_LINE_CHARS)}]`;
}

export function elidedContent(
  payload: Record<string, unknown>,
  text: string,
): string | undefined {
  const replacement = formatElided(payload, text);
  return replacement.length < text.length ? replacement : undefined;
}
