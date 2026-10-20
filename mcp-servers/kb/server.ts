import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import type { AnyToolHandler, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

import { KbService } from './service.js'
import { kbTools } from './tools.js'
import type { KbToolSpec } from './tools.js'

const DEFAULT_KB_ROOT = 'mcp-servers/kb/kb'

export function resolveKbRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env.KB_ROOT?.trim()
  return path.resolve(cwd, configured ? configured : DEFAULT_KB_ROOT)
}

export function createKbService(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): KbService {
  return new KbService(resolveKbRoot(env, cwd))
}

export function createKbTools(service: KbService = createKbService()): KbToolSpec[] {
  return kbTools(service)
}

export function createKbServer(service: KbService = createKbService()): McpServer {
  const server = new McpServer({ name: 'embedded-ai-kb', version: '0.1.0' })
  for (const tool of createKbTools(service)) {
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
  await createKbServer().connect(transport)
}