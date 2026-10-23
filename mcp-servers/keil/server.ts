import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  AnyToolHandler,
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createKeilTools, keilTools } from "./tools.js";
import { createEmbedProjectTool } from "../cubeide/route.js";

/**
 * Keil / UVSOCK MCP server。
 *
 * 领域代码全部在本目录，内核 `src/` 零改动（probe 的 bootstrap 红线）。
 * 接线方式与 probe/kb 同构：
 *
 *   { "mcpServers": { "keil": { "command": "node", "args": ["dist-mcp/keil/server.js"] } } }
 *
 * 除 keil_debug / keil_project 外，本 server 还挂载统一路由门面
 * `embed_project`（cubeide/route.ts）：模型调它，门面识别工程类型后分发。
 * cubeide 后端在自己的 server（dist-mcp/cubeide/server.js）里同样挂载，
 * 两边都暴露 embed_project，哪个 server 被接线都能路由。
 */

export const KEIL_SERVER_NAME = "embedded-ai-keil";

export function createKeilServer(): McpServer {
  const server = new McpServer({ name: KEIL_SERVER_NAME, version: "0.1.0" });
  const tools = [...createKeilTools(), createEmbedProjectTool(keilTools)];
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
  await createKeilServer().connect(transport);
}
