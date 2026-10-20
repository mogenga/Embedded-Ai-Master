import { z } from 'zod'

import { KbServiceError } from './service.js'
import type { KbService } from './service.js'

export interface KbToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: unknown
  isError?: boolean
}

export interface KbToolSpec {
  name: string
  description: string
  inputSchema?: z.ZodTypeAny
  annotations?: { readOnlyHint?: boolean }
  meta?: Record<string, unknown>
  handler: (args: unknown) => Promise<KbToolResult>
}

const lookupSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(10).optional(),
})

const readSchema = z.object({
  path: z.string(),
})

const searchSchema = z.object({
  tokens: z.array(z.string()).max(8),
  limit: z.number().int().min(1).max(100).optional(),
})

function ok(structuredContent: unknown): KbToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

function fail(code: string, message: string): KbToolResult {
  const structuredContent = { code, message }
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
    .join('; ')
}

function withSchema<T>(
  schema: z.ZodType<T>,
  run: (args: T) => Promise<KbToolResult>,
): (args: unknown) => Promise<KbToolResult> {
  return async (args: unknown): Promise<KbToolResult> => {
    const parsed = schema.safeParse(args ?? {})
    if (!parsed.success) return fail('invalid_argument', formatIssues(parsed.error))
    return run(parsed.data)
  }
}

export function kbTools(service: KbService): KbToolSpec[] {
  const lookup: KbToolSpec = {
    name: 'kb_lookup',
    description:
      '按自然语言问题检索知识库索引，返回候选条目（path/title/summary/score）。无命中时返回 found=false、reason="no_match"；命中证据不足时返回 found=false、reason="low_confidence"。两种情况都必须如实告知用户，不得编造条目或内容。',
    inputSchema: lookupSchema,
    annotations: { readOnlyHint: true },
    handler: withSchema(lookupSchema, async (args) => {
      try {
        return ok(service.lookup(args.query, args.limit))
      } catch (error) {
        if (error instanceof KbServiceError) return fail(error.code, error.message)
        return fail('index_invalid', errorMessage(error))
      }
    }),
  }

  const read: KbToolSpec = {
    name: 'kb_read',
    description:
      '读取知识库中的文件。path 必须是相对知识库根的 .md/.yaml 路径，禁止绝对路径与 .. 越界。返回原文 content；不得根据文件名或摘要猜测未读取到的内容。',
    inputSchema: readSchema,
    annotations: { readOnlyHint: true },
    meta: { evidence: true },
    handler: withSchema(readSchema, async (args) => {
      try {
        return ok(service.read(args.path))
      } catch (error) {
        if (error instanceof KbServiceError) return fail(error.code, error.message)
        return fail('read_failed', errorMessage(error))
      }
    }),
  }

  const search: KbToolSpec = {
    name: 'kb_search',
    description:
      '按关键词或十六进制 token 在知识库中逐行检索，返回命中行及上下文。无命中时返回 found=false，必须如实告知用户，不得编造。',
    inputSchema: searchSchema,
    annotations: { readOnlyHint: true },
    handler: withSchema(searchSchema, async (args) => {
      const tokens = args.tokens.map((token) => token.trim()).filter((token) => token !== '')
      if (tokens.length === 0) return fail('empty_query', 'tokens 至少需要一个非空词')
      return ok(service.search(tokens, args.limit))
    }),
  }

  const status: KbToolSpec = {
    name: 'kb_status',
    description:
      '查看知识库根路径、markdown 文件数、索引条目数与索引是否存在。索引缺失时返回 indexPresent=false；索引损坏时返回 index_invalid。',
    annotations: { readOnlyHint: true },
    handler: async () => {
      try {
        const result = service.status()
        if (result.indexPresent) service.lookup('\u0000')
        return ok(result)
      } catch (error) {
        return fail('index_invalid', errorMessage(error))
      }
    },
  }

  return [lookup, read, search, status]
}