import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  AnyToolHandler,
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { OpenOcdBackend } from "./openocd.js";
import { RenodeBackend } from "./renode-backend.js";
import { probeTools } from "./tools.js";
import type { ProbeBackends, ProbeToolSpec } from "./tools.js";

export interface ProbeBackendEnv {
  RENODE_PATH?: string | undefined;
}

export function createProbeBackends(env: ProbeBackendEnv = process.env): ProbeBackends {
  const renodePath = env.RENODE_PATH?.trim();
  return {
    renode: new RenodeBackend(renodePath ? { renodePath } : {}),
    openocd: new OpenOcdBackend(),
  };
}

export function createProbeTools(backends: ProbeBackends = createProbeBackends()): ProbeToolSpec[] {
  return probeTools(backends);
}

export function createProbeServer(backends: ProbeBackends = createProbeBackends()): McpServer {
  const server = new McpServer({ name: "embedded-ai-probe", version: "0.1.0" });
  for (const tool of createProbeTools(backends)) {
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
  await createProbeServer().connect(transport);
}
