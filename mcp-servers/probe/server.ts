import { McpServer } from "@modelcontextprotocol/server";
import type { AnyToolHandler, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { RenodeBackend } from "./renode-backend.js";
import { probeTools } from "./tools.js";

const server = new McpServer({ name: "embedded-ai-probe", version: "0.1.0" });
const backends = { renode: new RenodeBackend() };

for (const tool of probeTools(backends)) {
  const inputSchema = (tool.inputSchema ?? z.object({})) as unknown as StandardSchemaWithJSON;
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema,
      annotations: tool.annotations,
      _meta: tool.meta,
    },
    (async (args: unknown) => tool.handler(args)) as unknown as AnyToolHandler<StandardSchemaWithJSON>,
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);