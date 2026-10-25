import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import type { AnyToolHandler, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

import { DatasheetCache } from './cache.js'
import { DatasheetService } from './service.js'
import { datasheetTools } from './tools.js'
import type { DatasheetToolSpec } from './tools.js'

const DEFAULT_CACHE_DIRNAME = '.datasheet-mcp'

/** `DATASHEET_ROOT`：PDF 检索根；不设时用进程 cwd（工作区形态）。 */
export function resolveDatasheetRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env.DATASHEET_ROOT?.trim()
  return path.resolve(cwd, configured ? configured : cwd)
}

/**
 * `DATASHEET_CACHE_DIR`：页级缓存目录。缺省 `<root>/.datasheet-mcp/`（遍历时
 * 被「跳点目录」规则排除，不自吃）；可显式挪到 `$HARNESS_HOME` 下，让用户
 * 工作区保持零写入之外的东西。
 */
export function resolveDatasheetCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  root = resolveDatasheetRoot(env, cwd),
): string {
  const configured = env.DATASHEET_CACHE_DIR?.trim()
  return path.resolve(cwd, configured ? configured : path.join(root, DEFAULT_CACHE_DIRNAME))
}

export function createDatasheetService(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): DatasheetService {
  const root = resolveDatasheetRoot(env, cwd)
  return new DatasheetService(root, new DatasheetCache(resolveDatasheetCacheDir(env, cwd, root)))
}

export function createDatasheetTools(service: DatasheetService = createDatasheetService()): DatasheetToolSpec[] {
  return datasheetTools(service)
}

export function createDatasheetServer(service: DatasheetService = createDatasheetService()): McpServer {
  const server = new McpServer({ name: 'embedded-ai-datasheet', version: '0.1.0' })
  for (const tool of createDatasheetTools(service)) {
    const inputSchema = (tool.inputSchema ?? z.object({})) as unknown as StandardSchemaWithJSON
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
        annotations: tool.annotations,
        _meta: tool.meta,
      },
      (async (args: unknown) =>
        tool.handler(args)) as unknown as AnyToolHandler<StandardSchemaWithJSON>,
    )
  }
  return server
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const transport = new StdioServerTransport()
  await createDatasheetServer().connect(transport)
}