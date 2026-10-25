/**
 * 串口 MCP server 入口——`embed_serial` 一个工具，六动作。
 *
 * 与 probe/kb 同构的接线方式：
 *
 *   { "mcpServers": { "serial": { "command": "node", "args": ["dist-mcp/serial/server.js"] } } }
 *
 * 从 cubeide server 拆出（2026-10-25）：串口是平台级能力，不该绑在某个
 * 厂商后端上——没装 CubeIDE 的机器同样要能经 agent 复用桌面面板的串口。
 */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type { AnyToolHandler, ServerContext, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { embedSerialTool } from "./tools.js";

export const SERIAL_SERVER_NAME = "embedded-ai-serial";

export function createSerialServer(): McpServer {
  const server = new McpServer({ name: SERIAL_SERVER_NAME, version: "0.1.0" });
  const tools = [embedSerialTool];
  for (const tool of tools) {
    const inputSchema = (tool.inputSchema ?? z.object({})) as unknown as StandardSchemaWithJSON;
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
  await createSerialServer().connect(transport);
}
