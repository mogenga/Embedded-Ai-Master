import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  AnyToolHandler,
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createEspIdfTools } from "./tools.js";

/**
 * ESP-IDF MCP server。
 *
 *   { "mcpServers": { "espidf": { "command": "node", "args": ["dist-mcp/espidf/server.js"] } } }
 */

export const ESPIDF_SERVER_NAME = "embedded-ai-espidf";

export function createEspIdfServer(): McpServer {
  const server = new McpServer({ name: ESPIDF_SERVER_NAME, version: "0.1.0" });
  for (const tool of createEspIdfTools()) {
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
  await createEspIdfServer().connect(transport);
}
