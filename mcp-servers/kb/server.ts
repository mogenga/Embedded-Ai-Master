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

/**
 * `KB_INBOX_PATH`：待审 inbox 的位置。不设时沿用历史行为（写 `<KB 根>/_inbox.md`）。
 *
 * 为什么需要它：OTA 会整份替换语料快照（`docs/corpus-ota.md` §3），部署形态把沉淀
 * 放在 `$HARNESS_HOME/kb/inbox/` 下。没有这个入口，`KbServiceOptions.inboxPath`
 * 就只能被测试用上，真实 server 进程永远写不出去。
 */
export function resolveKbInboxPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | undefined {
  const configured = env.KB_INBOX_PATH?.trim()
  return configured ? path.resolve(cwd, configured) : undefined
}

export function createKbService(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): KbService {
  const inboxPath = resolveKbInboxPath(env, cwd)
  return new KbService(
    resolveKbRoot(env, cwd),
    inboxPath === undefined ? {} : { inboxPath },
  )
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