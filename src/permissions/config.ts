import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PermissionConfigError } from "./errors.js";
import type {
  PermissionConfig,
  PermissionPreset,
  PermissionRule,
  SourcedRule,
} from "./types.js";

const DEFAULT_PRESET: PermissionPreset = "diagnose";
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PATTERN_LENGTH = 200;
const MAX_APPROVAL_TIMEOUT_MS = 2_147_483_647;

export interface InlinePermissionConfig {
  preset?: PermissionPreset;
  rules?: PermissionRule[];
  approvalTimeoutMs?: number;
}

export interface LoadPermissionOptions {
  home: string;
  workdir: string;
  inline?: InlinePermissionConfig;
  userConfigPath?: string;
  projectConfigPath?: string;
  trustProjectConfig?: boolean;
}

export interface LoadedPermissionConfig {
  preset: PermissionPreset;
  rules: SourcedRule[];
  approvalTimeoutMs: number;
  projectSkipped?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
}

const PresetSchema = z.enum(["read-only", "workspace-write", "diagnose", "danger-full-access"]);
const ActionSchema = z.enum(["allow", "ask", "deny"]);
const MatcherValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// 纯空白字段不是有效配置:规则会永不命中却看起来生效,理由也不可读(D-121)。
function isNotBlank(value: string): boolean {
  return value.trim().length > 0;
}

const KeySchema = z
  .string()
  .min(1, "key 不能为空")
  .max(MAX_PATTERN_LENGTH, `key 长度不能超过 ${MAX_PATTERN_LENGTH}`)
  .refine(isNotBlank, "key 不能只含空白")
  .refine(
    (value) => value.split(".").every((segment) => segment.length > 0),
    "key 的每个点分段都必须非空",
  );

const GlobSchema = z
  .string()
  .min(1, "glob 不能为空")
  .max(MAX_PATTERN_LENGTH, `glob 长度不能超过 ${MAX_PATTERN_LENGTH}`);

const MatcherSchema = z
  .strictObject({
    key: KeySchema,
    eq: MatcherValueSchema.optional(),
    glob: GlobSchema.optional(),
    in: z.array(MatcherValueSchema).min(1, "in 不能为空数组").optional(),
    range: z.tuple([z.number(), z.number()]).optional(),
  })
  .superRefine((matcher, ctx) => {
    const operatorCount = [matcher.eq, matcher.glob, matcher.in, matcher.range].filter(
      (value) => value !== undefined,
    ).length;
    if (operatorCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "matcher 必须且只能提供 eq/glob/in/range 中的一个操作符",
      });
    }
    if (matcher.range !== undefined && matcher.range[0] > matcher.range[1]) {
      ctx.addIssue({
        code: "custom",
        path: ["range"],
        message: "range 下界不能大于上界",
      });
    }
  });

const RuleSchema = z.strictObject({
  tool: z
    .string()
    .min(1, "tool 不能为空")
    .max(MAX_PATTERN_LENGTH, `tool 长度不能超过 ${MAX_PATTERN_LENGTH}`)
    .refine(isNotBlank, "tool 不能只含空白"),
  params: z.array(MatcherSchema).optional(),
  action: ActionSchema,
  reason: z
    .string()
    .min(1, "reason 不能为空")
    .refine(isNotBlank, "reason 不能只含空白")
    .optional(),
});

const ApprovalTimeoutSchema = z
  .number()
  .int("approvalTimeoutMs 必须是整数")
  .min(1, "approvalTimeoutMs 必须大于 0")
  .max(MAX_APPROVAL_TIMEOUT_MS, `approvalTimeoutMs 不能超过 ${MAX_APPROVAL_TIMEOUT_MS}`);

const PermissionConfigSchema = z.strictObject({
  version: z.literal(1),
  preset: PresetSchema.optional(),
  rules: z.array(RuleSchema).optional(),
  approvalTimeoutMs: ApprovalTimeoutSchema.optional(),
});

const InlinePermissionConfigSchema = z.strictObject({
  preset: PresetSchema.optional(),
  rules: z.array(RuleSchema).optional(),
  approvalTimeoutMs: ApprovalTimeoutSchema.optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssuePath(segments: readonly PropertyKey[]): string {
  return segments.length === 0 ? "<root>" : segments.map((segment) => String(segment)).join(".");
}

function schemaError(file: string, error: z.ZodError): PermissionConfigError {
  const details = error.issues
    .map((issue) => {
      const field = formatIssuePath(issue.path);
      if (issue.code === "unrecognized_keys") {
        const keys = issue.keys.map((key) => JSON.stringify(key)).join(", ");
        return `${field}: 未知字段 ${keys}`;
      }
      return `${field}: ${issue.message}`;
    })
    .join("; ");
  return new PermissionConfigError(
    "invalid_schema",
    `权限配置无效: ${file}（${details}）`,
    error.issues,
  );
}

export function parsePermissionConfig(text: string, file: string): PermissionConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch (error) {
    throw new PermissionConfigError("invalid_json", `权限配置 JSON 无效: ${file}`, error);
  }

  if (!isRecord(raw) || raw.version !== 1) {
    throw new PermissionConfigError(
      "unsupported_version",
      `权限配置版本不受支持（仅支持 version=1）: ${file}`,
      isRecord(raw) ? { version: raw.version } : undefined,
    );
  }

  const parsed = PermissionConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw schemaError(file, parsed.error);
  }
  return parsed.data;
}

export function parseInlinePermissionConfig(inline: unknown): InlinePermissionConfig {
  if (!isRecord(inline)) {
    throw new PermissionConfigError(
      "invalid_schema",
      "内联权限配置必须是对象",
      inline,
    );
  }
  const parsed = InlinePermissionConfigSchema.safeParse(inline);
  if (!parsed.success) {
    throw schemaError("<inline>", parsed.error);
  }
  return parsed.data;
}

function readConfigFile(filePath: string): PermissionConfig | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new PermissionConfigError(
      "read_failed",
      `权限配置读取失败: ${filePath}`,
      error,
    );
  }
  return parsePermissionConfig(text, filePath);
}

export function loadPermissionConfig(opts: LoadPermissionOptions): LoadedPermissionConfig {
  const userConfigPath = opts.userConfigPath ?? path.join(opts.home, "permissions.json");
  const projectConfigPath = opts.projectConfigPath ?? path.join(opts.workdir, ".harness", "permissions.json");

  const user = readConfigFile(userConfigPath);

  const projectTrusted = opts.projectConfigPath !== undefined || opts.trustProjectConfig === true;
  let project: PermissionConfig | undefined;
  let projectSkipped: string | undefined;
  if (projectTrusted) {
    project = readConfigFile(projectConfigPath);
  } else {
    // 未信任时不读内容,但仍要区分“不存在”和“存在但不可 stat”:
    // existsSync 把 EACCES/ENOTDIR 等一并吞成 false,会让用户看不到项目配置被跳过(D-122)。
    let exists = false;
    try {
      fs.statSync(projectConfigPath);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PermissionConfigError(
          "read_failed",
          `权限配置无法访问: ${projectConfigPath}`,
          error,
        );
      }
    }
    if (exists) projectSkipped = projectConfigPath;
  }

  // loadPermissionConfig 是对外导出的库函数:调用方可能绕过 runSession,内联配置
  // 必须在这里复用同一套 strict schema 校验,否则非法预设/未知字段会静默进入求值(D-120)。
  const inline =
    opts.inline === undefined ? undefined : parseInlinePermissionConfig(opts.inline);
  const rules: SourcedRule[] = [];
  for (const rule of inline?.rules ?? []) {
    rules.push({ rule, source: "inline" });
  }
  for (const rule of project?.rules ?? []) {
    rules.push({ rule, source: "project" });
  }
  for (const rule of user?.rules ?? []) {
    rules.push({ rule, source: "user" });
  }

  const loaded: LoadedPermissionConfig = {
    preset: inline?.preset ?? project?.preset ?? user?.preset ?? DEFAULT_PRESET,
    rules,
    approvalTimeoutMs:
      inline?.approvalTimeoutMs
      ?? project?.approvalTimeoutMs
      ?? user?.approvalTimeoutMs
      ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    userConfigPath,
    projectConfigPath,
  };
  if (projectSkipped !== undefined) {
    loaded.projectSkipped = projectSkipped;
  }
  return loaded;
}
