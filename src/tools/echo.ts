import { z } from "zod";
import type { ToolDef } from "./types.js";

export const echoTool: ToolDef<{ text: string }> = {
  name: "echo",
  description: "回显输入文本",
  schema: z.object({ text: z.string() }),
  annotations: { readOnly: true },
  execute: async (input) => ({ isError: false, code: "ok", message: "", text: input.text }),
};
