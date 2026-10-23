import { z } from 'zod'

import { appendProposalTo, newProposalId } from './inbox.js'
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
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
  meta?: Record<string, unknown>
  handler: (args: unknown) => Promise<KbToolResult>
}

const lookupSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(10).optional(),
})

const readSchema = z.object({
  path: z.string(),
  offset: z.number().int().min(0).optional(),
  // 上限由 service 夹到 2000：让模型多要几行时直接拿到上限，而不是白丢一轮去改参数。
  limit: z.number().int().min(1).optional(),
})

const globSchema = z.object({
  pattern: z.string(),
})

const grepSchema = z.object({
  pattern: z.string(),
  glob: z.string().optional(),
})

const searchSchema = z.object({
  tokens: z.array(z.string()).max(8),
  limit: z.number().int().min(1).max(100).optional(),
})

const singleLine = (value: string) => !/[\r\n]/.test(value)
const notBlank = (value: string) => value.trim() !== ''
const notSeparatorLine = (value: string) => !/^\s*---\s*$/m.test(value)

const proposeSchema = z.object({
  kind: z.enum(['trap', 'correction', 'reference', 'case']),
  domain: z
    .string()
    .min(1)
    .max(64)
    .refine(notBlank, 'domain 不能只含空白')
    .refine(singleLine, 'domain 不能包含换行'),
  source: z
    .string()
    .min(1)
    .max(200)
    .refine(notBlank, 'source 不能只含空白')
    .refine(singleLine, 'source 不能包含换行'),
  content: z
    .string()
    .min(1)
    .max(8000)
    .refine(notBlank, 'content 不能只含空白')
    .refine(notSeparatorLine, 'content 不能包含单独成行的 ---'),
  title: z
    .string()
    .min(1)
    .max(200)
    .refine(notBlank, 'title 不能只含空白')
    .refine(singleLine, 'title 不能包含换行')
    .optional(),
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
      '按自然语言问题检索知识库索引，返回候选条目（path/title/summary/score）。无命中时返回 found=false、reason="no_match"；命中证据不足时返回 found=false、reason="low_confidence"。两种情况都必须如实告知用户，不得编造条目或内容。索引可能漏召回：未命中时改用 kb_grep / kb_glob 继续检索，不要直接断言知识库没有相关内容。',
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
      '读取知识库中的文件。path 必须是相对知识库根的 .md/.yaml 路径，禁止绝对路径与 .. 越界。可选 offset（0-based 行号，默认 0）与 limit（默认且上限 2000 行）只取一段窗口；content 是该窗口的原文，同时返回 offset/lines/totalLines/truncated。truncated: true 表示还有后续内容，应带上新的 offset 继续读，不要假设读完了。frontmatter 与 reviewStatus 始终按整份文件解析。不得根据文件名或摘要猜测未读取到的内容。',
    inputSchema: readSchema,
    annotations: { readOnlyHint: true },
    meta: { evidence: true },
    handler: withSchema(readSchema, async (args) => {
      try {
        return ok(service.read(args.path, { offset: args.offset, limit: args.limit }))
      } catch (error) {
        if (error instanceof KbServiceError) return fail(error.code, error.message)
        return fail('read_failed', errorMessage(error))
      }
    }),
  }

  const glob: KbToolSpec = {
    name: 'kb_glob',
    description:
      '按通配符列出知识库中的文件路径（相对知识库根，如 protocols/**/*.md）。支持 *（不跨目录）、**（跨目录）、?（单个字符）；已排除导航文件、index.yaml 与缓存目录，最多返回 100 条。命中只是候选，断言前必须 kb_read 原文确认；无命中时返回 found=false、matches=[]，必须如实告知用户，不得编造路径。truncated: true 表示返回条数被截，应收窄 pattern；scanTruncated: true 表示扫描中途停止，未命中不等于不存在，应缩小范围重试。',
    inputSchema: globSchema,
    annotations: { readOnlyHint: true },
    handler: withSchema(globSchema, async (args) => {
      try {
        return ok(service.glob(args.pattern))
      } catch (error) {
        if (error instanceof KbServiceError) return fail(error.code, error.message)
        return fail('glob_failed', errorMessage(error))
      }
    }),
  }

  const grep: KbToolSpec = {
    name: 'kb_grep',
    description:
      '按正则（大小写不敏感）逐行检索知识库正文，返回命中行（path/line/text，line 为 1-based，text 截断到 300 字符）。可选 glob 限定文件（如 **/*.md）；已排除导航文件、index.yaml 与缓存目录；最多返回 100 条。命中只是候选，断言知识库里有该结论前必须 kb_read 原文确认。fileCount 与 files（命中最多的前 10 个文件）只用来看命中集中还是散落：散落在很多文件各 1 行通常意味着该查询不属于知识库，但它不是置信度。无命中时 found=false、hits=[]，必须如实告知，不得编造。truncated: true 表示返回条数被截，应收窄正则；scanTruncated: true 表示扫描中途停止，未命中不等于不存在，应缩小范围重试。',
    inputSchema: grepSchema,
    annotations: { readOnlyHint: true },
    handler: withSchema(grepSchema, async (args) => {
      try {
        return ok(service.grep(args.pattern, args.glob))
      } catch (error) {
        if (error instanceof KbServiceError) return fail(error.code, error.message)
        return fail('grep_failed', errorMessage(error))
      }
    }),
  }

  const search: KbToolSpec = {
    name: 'kb_search',
    description:
      '按关键词或十六进制 token 在知识库中逐行检索，返回命中行及上下文。字面多 token 检索，不支持正则；需要正则时用 kb_grep。无命中时返回 found=false，必须如实告知用户，不得编造。scanTruncated: true 表示遍历被截，命中只覆盖已扫描部分，未命中不等于不存在。',
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
      '查看知识库根路径、markdown 文件数、索引条目数、待审提案数与索引是否存在。inboxPath 是待审 inbox 的实际位置（inboxExternal: true 表示它在知识库根之外、不经 kb_read 暴露）；inbox 为空或不存在时 inboxPending=0，读取失败时返回 inboxError，不得把读取失败说成「没有待审提案」。索引缺失时返回 indexPresent=false；索引损坏时返回 index_invalid。scanTruncated: true 表示文件遍历被预算截停，此时 fileCount 只是下界。',
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

  const propose: KbToolSpec = {
    name: 'kb_propose',
    description:
      '把诊断中发现的新知识或修正写入待审 inbox。只写入待审区，不参与 kb_lookup/kb_search，也不会自动合并；必须由人工审核后合并到正式条目。返回 proposalId、inboxPath（inbox 实际位置，可能是知识库根之外的绝对路径）与 pending_review 状态。',
    inputSchema: proposeSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: withSchema(proposeSchema, async (args) => {
      const now = new Date()
      const proposal = {
        id: newProposalId(now),
        date: now.toISOString().slice(0, 10),
        kind: args.kind,
        domain: args.domain,
        source: args.source,
        content: args.content,
        ...(args.title === undefined ? {} : { title: args.title }),
      }
      try {
        // 写 service 报出来的那个位置，不在这里另算一遍：位置只有一个来源。
        const result = appendProposalTo(service.inboxPath, proposal, service.inboxLabel())
        return ok({
          proposalId: result.duplicateOf ?? proposal.id,
          inboxPath: result.path,
          status: 'pending_review',
          ...(result.duplicateOf === undefined ? {} : { duplicate: true }),
        })
      } catch (error) {
        return fail('proposal_failed', errorMessage(error))
      }
    }),
  }

  return [lookup, glob, grep, read, search, propose, status]
}