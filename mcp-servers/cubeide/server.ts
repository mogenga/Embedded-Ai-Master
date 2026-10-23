import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  AnyToolHandler,
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createCubeIdeTools } from "./tools.js";
import { createEmbedProjectTool } from "./route.js";
import { keilTools } from "../keil/tools.js";

/**
 * STM32CubeIDE MCP server。
 *
 * 与 keil/server.ts 同构：领域代码全部在本目录，内核 `src/` 零改动。
 * keilLegacy 只用来取 keil_debug/keil_project 的执行器供 embed_project
 * 路由——keil 的工具不在这里重复注册。
 *
 *   { "mcpServers": { "cubeide": { "command": "node", "args": ["dist-mcp/cubeide/server.js"] } } }
 */

export const CUBEIDE_SERVER_NAME = "embedded-ai-cubeide";

export function createCubeIdeServer(): McpServer {
  const server = new McpServer({ name: CUBEIDE_SERVER_NAME, version: "0.1.0" });
  const tools = [...createCubeIdeTools(), createEmbedProjectTool(keilTools)];
  for (const tool of tools) {
    const inputSchema = (tool.inputSchema ?? {}) as unknown as StandardSchemaWithJSON;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
        annotations: tool.annotations,
        _meta: tool.meta,
      },
      (async (args: unknown, ctx: ServerContext) =>
        tool.handler(args, ctx.mcpReq.signal)) as unknown as AnyToolHandler<StandardSchemaWithJSON>,
    );
  }
  return server;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const transport = new StdioServerTransport();
  await createCubeIdeServer().connect(transport);
}
