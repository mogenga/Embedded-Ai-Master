import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HookDef } from "./types.js";

/**
 * `hooks.json` 的读取与严格校验。
 *
 * 姿态与 `src/permissions/config.ts` / `src/config/app-config.ts` 一致：**未知字段
 * 直接报错**，不静默忽略——拼错的 `macher` 会让一条安全钩子从不运行，而日志上
 * 看不出少了什么（R3）。
 */

export type HookConfigErrorCode =
  | "invalid_json"
  | "invalid_schema"
  | "unsupported_version"
  | "read_failed";

export class HookConfigError extends Error {
  readonly code: HookConfigErrorCode;
  readonly detail?: unknown;

  constructor(code: HookConfigErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "HookConfigError";
    this.code = code;
    this.detail = detail;
  }
}

export interface LoadHookConfigOptions {
  home: string;
  workdir: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  /** 与 `mcp.json` 同一信任规则：只有显式信任（或给了显式路径）才读项目级配置。 */
  includeProject?: boolean;
}

export interface LoadedHookConfig {
  hooks: HookDef[];
  /** 项目级配置存在但未被信任时的路径；调用方据此发 `hooks_project_config_skipped`。 */
  projectSkipped?: string;
  userConfigPath: string;
  projectConfigPath: string;
}

const MAX_PATTERN_LENGTH = 200;
const MAX_HOOK_TIMEOUT_MS = 60_000;

function isNotBlank(value: string): boolean {
  return value.trim().length > 0;
}

const HookDefSchema = z.strictObject({
  event: z.enum(["preToolUse", "postToolUse"]),
  // 上限与 `matchToolPattern` 一致：更长的模式永远匹配不上，等于「配了但从不会跑」。
  matcher: z
    .string()
    .min(1, "matcher 不能为空")
    .max(MAX_PATTERN_LENGTH, `matcher 长度不能超过 ${MAX_PATTERN_LENGTH}`)
    .refine(isNotBlank, "matcher 不能只含空白")
    .optional(),
  command: z
    .string()
    .min(1, "command 不能为空")
    .refine(isNotBlank, "command 不能只含空白"),
  args: z.array(z.string()).optional(),
  timeoutMs: z
    .number()
    .int("timeoutMs 必须是整数")
    .min(1, "timeoutMs 必须大于 0")
    .max(MAX_HOOK_TIMEOUT_MS, `timeoutMs 不能超过 ${MAX_HOOK_TIMEOUT_MS}`)
    .optional(),
});

const HookFileSchema = z.strictObject({
  version: z.literal(1),
  hooks: z.array(HookDefSchema),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 数字段写成 `hooks[0]`，其余用点号——错误信息要能指回「哪份文件的第几条」。
function formatIssuePath(segments: readonly PropertyKey[]): string {
  if (segments.length === 0) return "<root>";
  let text = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      text += `[${segment}]`;
      continue;
    }
    text += text.length === 0 ? String(segment) : `.${String(segment)}`;
  }
  return text;
}

function schemaError(file: string, error: z.ZodError): HookConfigError {
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
  return new HookConfigError("invalid_schema", `钩子配置无效: ${file}（${details}）`, error.issues);
}

/** 文件里的一条钩子；`source` / `index` 由读取方补，因为它们不由文件内容决定。 */
export type ParsedHookDef = Omit<HookDef, "source" | "index">;

export function parseHookConfig(text: string, file: string): ParsedHookDef[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, "")) as unknown;
  } catch (error) {
    throw new HookConfigError("invalid_json", `钩子配置 JSON 无效: ${file}`, error);
  }

  if (!isRecord(raw) || raw.version !== 1) {
    throw new HookConfigError(
      "unsupported_version",
      `钩子配置版本不受支持（仅支持 version=1）: ${file}`,
      isRecord(raw) ? { version: raw.version } : undefined,
    );
  }

  const parsed = HookFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw schemaError(file, parsed.error);
  }
  return parsed.data.hooks;
}

function readConfigFile(filePath: string, source: HookDef["source"]): HookDef[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new HookConfigError("read_failed", `钩子配置读取失败: ${filePath}`, error);
  }
  // index 是「这条在它所属的那份文件里的序号」，不是合并后的全局下标：
  // 错误信息要能指回用户手里的那几行。
  return parseHookConfig(text, filePath).map((hook, index) => ({ ...hook, source, index }));
}

export function loadHookConfig(opts: LoadHookConfigOptions): LoadedHookConfig {
  const userConfigPath = opts.userConfigPath ?? path.join(opts.home, "hooks.json");
  const projectConfigPath =
    opts.projectConfigPath ?? path.join(opts.workdir, ".harness", "hooks.json");

  const user = readConfigFile(userConfigPath, "user") ?? [];

  let project: HookDef[] = [];
  let projectSkipped: string | undefined;
  if (opts.includeProject === true) {
    project = readConfigFile(projectConfigPath, "project") ?? [];
  } else {
    // 未信任时不读内容，但仍要区分「不存在」与「存在但不可 stat」：
    // existsSync 会把 EACCES/ENOTDIR 一并吞成 false，让用户看不到配置被跳过（D-122）。
    let exists = false;
    try {
      fs.statSync(projectConfigPath);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new HookConfigError("read_failed", `钩子配置无法访问: ${projectConfigPath}`, error);
      }
    }
    if (exists) projectSkipped = projectConfigPath;
  }

  const loaded: LoadedHookConfig = {
    hooks: [...user, ...project],
    userConfigPath,
    projectConfigPath,
  };
  if (projectSkipped !== undefined) loaded.projectSkipped = projectSkipped;
  return loaded;
}
