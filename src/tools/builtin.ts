import { echoTool } from "./echo.js";
import { fsTool } from "./fs.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { shellTool } from "./shell.js";
import type { ToolDef } from "./types.js";

export function createBuiltinTools(): ToolDef<unknown>[] {
  return [echoTool, fsTool, shellTool, globTool, grepTool];
}