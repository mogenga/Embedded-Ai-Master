import { z } from 'zod'

import { DatasheetServiceError, EXTRACTOR_INSTALL_HINT } from './service.js'
import type { DatasheetService } from './service.js'

export interface DatasheetToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: unknown
  isError?: boolean
}

export interface DatasheetToolSpec {
  name: string
  description: string
  inputSchema?: z.ZodTypeAny
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
  meta?: Record<string, unknown>
  handler: (args: unknown) => Promise<DatasheetToolResult>
}

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
})

const readSchema = z.object({
  path: z.string().min(1),
  page: z.number().int().min(1),
  pageEnd: z.number().int().min(1).optional(),
})

const registersSchema = z
  .object({
    query: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    page: z.number().int().min(1).optional(),
  })
  .refine((args) => (args.query === undefined) !== (args.path === undefined), {
    message: 'query 与 path 必须二选一（query 全库搜寄存器名；path 读指名文件的表）',
  })

function ok(structuredContent: unknown): DatasheetToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

function fail(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DatasheetToolResult {
  const structuredContent = details === undefined ? { code, message } : { code, message, ...details }
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

function serviceFailure(error: unknown): DatasheetToolResult {
  if (error instanceof DatasheetServiceError) {
    return fail(error.code, error.message, error.details)
  }
  return fail('internal_error', errorMessage(error))
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
    .join('; ')
}

function withSchema<T>(
  schema: z.ZodType<T>,
  run: (args: T) => Promise<DatasheetToolResult>,
): (args: unknown) => Promise<DatasheetToolResult> {
  return async (args: unknown): Promise<DatasheetToolResult> => {
    const parsed = schema.safeParse(args ?? {})
    if (!parsed.success) return fail('invalid_argument', formatIssues(parsed.error))
    return run(parsed.data)
  }
}

export function datasheetTools(service: DatasheetService): DatasheetToolSpec[] {
  const search: DatasheetToolSpec = {
    name: 'datasheet_search',
    description:
      '在工作区 PDF 数据手册里检索（BM25 词频打分 + 整短语命中加成的混合排序，大小写不敏感），返回 hits[{path,page,excerpt,score}]，page 为 1-based，按混合分降序。每份文件报最高分的一页；要完整上下文必须用 datasheet_read 读整页。查询的每个词都必须至少出现在一份手册里，否则如实返回 found=false（查不存在的寄存器名不会拿泛词页凑数）。skipped 列出无法检索的文件与原因：提取器缺失（附安装命令）、文件过大、无文本层（扫描件）——这些是事实报告，不是命中。count 是 limit 裁剪前的命中总数（可以大于 hits.length）；truncated: true 表示只返回了前 limit 条，应提高 limit（上限 50）或收窄查询，不要以为命中只有这些。scanTruncated: true 表示文件遍历被截停（200 个文件的预算或 6 层深度上限），count 与 found 只覆盖已扫描到的部分——此时未命中不等于手册里没有。无命中时必须如实告知用户，不得编造页码或内容；可换更短的关键词（寄存器名优先）重试。',
    inputSchema: searchSchema,
    annotations: { readOnlyHint: true },
    handler: withSchema(searchSchema, async (args) => {
      try {
        const result = await service.search(args.query, args.limit)
        const structuredContent = {
          found: result.hits.length > 0,
          hits: result.hits,
          count: result.count,
          truncated: result.truncated,
          scanTruncated: result.scanTruncated,
          skipped: result.skipped,
          extractor: result.extractor,
        }
        if (result.extractor === null) {
          // 环境缺失是错误，不是「无命中」：置 isError 并保留 skipped 里的
          // 安装指引（R3：读失败显式报错，不伪装成空结果）。
          return {
            content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
            structuredContent: { ...structuredContent, code: 'extractor_missing' },
            isError: true,
          }
        }
        return ok(structuredContent)
      } catch (error) {
        return serviceFailure(error)
      }
    }),
  }

  const read: DatasheetToolSpec = {
    name: 'datasheet_read',
    description:
      '读取一份数据手册 PDF 的整页文本。path 必须是相对检索根的路径（datasheet_search 返回的 path 原样可用），禁止绝对路径与 .. 越界；page 为 1-based，pageEnd 可选（含）。单次至多 50 页、累计至多 512KiB：truncated: true 表示还有后续页未返回，应收窄页范围续读，不要假设读完了。返回 total（总页数）与 pages[{page,text}]；页码越界、文件过大、无文本层（扫描件）、提取器缺失都返回显式错误码，不会用空结果伪装成功。页文本来自 pdftotext -layout，保留列对齐；表格可能有换行错位，引用原文时以 datasheet_read 的 text 为准。',
    inputSchema: readSchema,
    annotations: { readOnlyHint: true },
    meta: { evidence: true },
    handler: withSchema(readSchema, async (args) => {
      try {
        return ok(await service.readPages(args.path, args.page, args.pageEnd))
      } catch (error) {
        return serviceFailure(error)
      }
    }),
  }

  const status: DatasheetToolSpec = {
    name: 'datasheet_status',
    description:
      '查看数据手册检索的状态：检索根路径、pdftotext 提取器是否可用（缺失时其余工具都会报 extractor_missing，安装方法见其错误信息）、缓存目录与条目数、PDF 文件数。scanTruncated: true 表示文件遍历被截停（200 个文件的预算或 6 层深度上限），fileCount 只是下界，未列出的 PDF 不等于不存在。',
    annotations: { readOnlyHint: true },
    handler: async () => {
      try {
        const status = await service.status()
        // 提取器缺失时附安装指引：status 本身是如实报告，不是错误。
        return ok(
          status.extractor === null
            ? { ...status, installHint: EXTRACTOR_INSTALL_HINT }
            : status,
        )
      } catch (error) {
        return serviceFailure(error)
      }
    },
  }

  const registers: DatasheetToolSpec = {
    name: 'datasheet_registers',
    description:
      '查结构化寄存器表：{query} 按寄存器名全库模糊匹配（大小写不敏感包含，如 "usb" 命中 USB_CNTR），或 {path[, page]} 读指名文件（可选限定页）的表。返回 tables[{path,name,peripheral?,offset?,resetValue?,bits[{name,msb,lsb,desc?}],sourcePage,confidence}]。表由启发式从 -layout 页文本提取（标题/Address offset/Bit 行三个稳定版式），低置信度的表被丢弃——宁缺毋滥，不伪造。位域描述可能被表格换行拆断，引用寄存器事实（位定义/复位值）前必须用 datasheet_read 读 sourcePage 页原文核对；同一寄存器名可能命中多份手册（同名不同芯片），以 path + sourcePage 区分。',
    inputSchema: registersSchema,
    annotations: { readOnlyHint: true },
    handler: withSchema(registersSchema, async (args) => {
      try {
        const result =
          args.query !== undefined
            ? await service.registers(args.query)
            : await service.registersAt(args.path as string, args.page)
        return ok(result)
      } catch (error) {
        return serviceFailure(error)
      }
    }),
  }

  return [search, read, registers, status]
}