import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  AnyToolHandler,
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createKeilTools } from "./tools.js";

/**
 * Keil / UVSOCK MCP server。
 *
 * 领域代码全部在本目录，内核 `src/` 零改动（probe 的 bootstrap 红线）。
 * 接线方式与 probe/kb 同构：
 *
 *   { "mcpServers": { "keil": { "command": "node", "args": ["dist-mcp/keil/server.js"] } } }
 */

export const KEIL_SERVER_NAME = "embedded-ai-keil";

export function createKeilServer(): McpServer {
  const server = new McpServer({ name: KEIL_SERVER_NAME, version: "0.1.0" });
  for (const tool of createKeilTools()) {
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
  await createKeilServer().connect(transport);
}
