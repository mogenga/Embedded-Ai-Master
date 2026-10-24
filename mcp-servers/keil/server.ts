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
import { setPackBinDirsProvider } from "./toolEnv.js";

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

/**
 * 接回工具链 pack 的 bin 目录。
 *
 * keil 的构建（tsconfig.mcp.json，rootDir=mcp-servers）不能静态 import 内核
 * `src/packs/`，所以这里在**入口模式**下从编译产物 `dist/packs/registry.js`
 * 动态加载并注入 toolEnv（Phase 3 的 TODO 在此勾销）。相对路径按标准布局
 * 解析：`dist-mcp/keil/server.js` → `../../dist/packs/registry.js`。
 *
 * 失败（dist 未构建、packs 不可用）不致命：pack 贡献为空，系统 PATH 与
 * 注册表发现照常工作；这是"没有 pack"的正常形态，不是故障。
 */
async function wirePackBinDirs(): Promise<void> {
  try {
    const registryUrl = new URL("../../dist/packs/registry.js", import.meta.url);
    const registry = (await import(registryUrl.href)) as {
      packBinDirs?: () => Map<string, { dir: string; packId: string }[]>;
    };
    if (typeof registry.packBinDirs !== "function") return;
    setPackBinDirsProvider(() => registry.packBinDirs!());
  } catch {
    /* dist/packs 不在：无 pack 环境，正常降级 */
  }
}

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
  await wirePackBinDirs();
  const transport = new StdioServerTransport();
  await createKeilServer().connect(transport);
}
