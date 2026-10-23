import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  AnyToolHandler,
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createArduinoTools } from "./tools.js";

/**
 * Arduino MCP server。
 *
 *   { "mcpServers": { "arduino": { "command": "node", "args": ["dist-mcp/arduino/server.js"] } } }
 */

export const ARDUINO_SERVER_NAME = "embedded-ai-arduino";

export function createArduinoServer(): McpServer {
  const server = new McpServer({ name: ARDUINO_SERVER_NAME, version: "0.1.0" });
  for (const tool of createArduinoTools()) {
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
  await createArduinoServer().connect(transport);
}
