import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadPermissionConfig, parseInlinePermissionConfig } from "../permissions/config.js";
import { PermissionConfigError } from "../permissions/errors.js";
import type { InlinePermissionConfig } from "../permissions/config.js";
import type { PermissionConfig, PermissionPreset, PermissionRule } from "../permissions/types.js";
import { ConfigValidationError, parseProviders } from "./providers.js";
import type { ProvidersConfig } from "./providers.js";

/**
 * 应用层配置（`$HARNESS_HOME` 下的 mcp.json / permissions.json / run.json / providers.json）的读写。
 *
 * 这一层只做「文件 <-> 普通对象」的校验与原子落盘，不含任何领域能力：MCP server
 * 由内核的 MCP 客户端挂载，权限规则由权限门求值。读写都要求显式失败（R3）：
 * 配置损坏不会静默降级成默认值，否则用户会以为探针/权限规则生效了。
 */

export interface AppMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  envAllowlist?: string[];
  inheritEnv?: boolean;
  cwd?: string;
  timeoutMs?: number;
  disabled?: boolean;
}

export interface AppRunLimits {
  /** 单次运行的最大轮数；null 表示不限制。 */
  maxTurns: number | null;
  /** 成本上限（美元）；null 表示不限。 */
  maxCostUsd: number | null;
  /** 模型请求超时（毫秒）；null 表示用内核默认。 */
  timeoutMs: number | null;
  /** 系统提示词；"" 表示用内核默认提示词。 */
  systemPrompt: string;
}

export interface AppPermissionSettings {
  preset: PermissionPreset;
  approvalTimeoutMs: number;
  rules: PermissionRule[];
}

export interface AppConfigSnapshot {
  mcpServers: AppMcpServer[];
  warnings: Array<{ server: string; field: string }>;
  permissions: AppPermissionSettings;
  permissionsPath: string;
  mcpPath: string;
  run: AppRunLimits;
  runPath: string;
  providers: ProvidersConfig;
  providersPath: string;
  /** providers.json 读失败时的原因；正常时该字段不存在。 */
  providersError?: string;
}

/**
 * providers.json 的原始对象（provider → 配置），与 src/config/providers.ts 的
 * ProvidersConfig 同型。单独起别名是因为这个名字描述的是「应用配置里的一份文件」，
 * 而 ProvidersConfig 描述的是「内核消费的配置」——两者同型但用途不同。
 */
export type AppProvidersFile = ProvidersConfig;

export type AppConfigErrorCode = "invalid_config" | "config_unreadable" | "config_write_failed";

export class AppConfigError extends Error {
  readonly code: AppConfigErrorCode;
  readonly detail?: unknown;

  constructor(code: AppConfigErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "AppConfigError";
    this.code = code;
    this.detail = detail;
  }
}

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MCP_SERVER_FIELDS = new Set([
  "name",
  "command",
  "args",
  "env",
  "envAllowlist",
  "inheritEnv",
  "cwd",
  "timeoutMs",
  "disabled",
]);

// 与 src/permissions/config.ts 的默认值保持一致：那边未导出常量，这里只镜像字面量。
//
// 这里原本写着「由 tests/server/config-api.test.ts 的默认快照断言锁定」。那个文件
// 随 HTTP 形态一起删了，所以这句话不再成立——而且它锁的始终只是 app-config 自己的
// 快照，从未真正比对过 permissions/config.ts 的值。**改一侧要同时改另一侧**，目前
// 没有测试能替你发现偏差。
const DEFAULT_PERMISSION_PRESET: PermissionPreset = "diagnose";
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

const DEFAULT_RUN_LIMITS: AppRunLimits = Object.freeze({
  maxTurns: null,
  maxCostUsd: null,
  timeoutMs: null,
  systemPrompt: "",
});

const RUN_LIMIT_FIELDS = new Set(["maxTurns", "maxCostUsd", "timeoutMs", "systemPrompt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidConfig(message: string, detail?: unknown): AppConfigError {
  return new AppConfigError("invalid_config", message, detail);
}

function unreadable(message: string, detail?: unknown): AppConfigError {
  return new AppConfigError("config_unreadable", message, detail);
}

const UTF8_BOM = String.fromCharCode(0xfeff);

function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
}

function parseJsonFile(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw unreadable(`配置读取失败: ${filePath}（${errorMessage(error)}）`, error);
  }
  try {
    return JSON.parse(stripBom(text)) as unknown;
  } catch (error) {
    throw unreadable(`配置 JSON 无效: ${filePath}（${errorMessage(error)}）`, error);
  }
}

function readJsonFileIfExists(filePath: string): unknown {
  try {
    return parseJsonFile(filePath);
  } catch (error) {
    // parseJsonFile 把底层 fs 错误放在 detail；只有「文件不存在」才按缺省处理。
    if (error instanceof AppConfigError && isFileNotFound(error.detail)) return undefined;
    throw error;
  }
}

// 临时文件 + fsync + rename：断电后要么看到旧文件，要么看到新文件，不会留下半截 JSON。
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(tmpPath, text, { encoding: "utf8", flag: "wx" });
    const handle = await open(tmpPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new AppConfigError(
      "config_write_failed",
      `配置写入失败: ${filePath}（${errorMessage(error)}）`,
      error,
    );
  }
}

function toMcpFileEntry(server: AppMcpServer): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: server.command };
  if (server.args !== undefined) entry.args = server.args;
  if (server.env !== undefined) entry.env = server.env;
  if (server.envAllowlist !== undefined) entry.envAllowlist = server.envAllowlist;
  if (server.inheritEnv !== undefined) entry.inheritEnv = server.inheritEnv;
  if (server.cwd !== undefined) entry.cwd = server.cwd;
  if (server.timeoutMs !== undefined) entry.timeoutMs = server.timeoutMs;
  if (server.disabled !== undefined) entry.disabled = server.disabled;
  return entry;
}

type UnknownFieldPolicy =
  | { mode: "reject" }
  | { mode: "warn"; warn: (field: string) => void };

function normalizeMcpServer(name: unknown, raw: unknown, policy: UnknownFieldPolicy): AppMcpServer {
  if (typeof name !== "string" || !MCP_SERVER_NAME_PATTERN.test(name)) {
    throw invalidConfig(
      `MCP server 名称非法: ${JSON.stringify(name)}（须匹配 ${MCP_SERVER_NAME_PATTERN.source}）`,
    );
  }
  if (!isRecord(raw)) {
    throw invalidConfig(`MCP server "${name}" 的配置必须是对象`);
  }
  for (const field of Object.keys(raw)) {
    if (field === "name" || MCP_SERVER_FIELDS.has(field)) continue;
    if (policy.mode === "reject") {
      throw invalidConfig(`MCP server "${name}" 含未知字段: ${JSON.stringify(field)}`);
    }
    policy.warn(field);
  }

  const where = `MCP server "${name}"`;
  const command = raw.command;
  if (typeof command !== "string" || command.trim() === "") {
    throw invalidConfig(`${where} 的 command 必须是非空字符串`);
  }
  const server: AppMcpServer = { name, command };

  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
      throw invalidConfig(`${where} 的 args 必须是字符串数组`);
    }
    server.args = [...(raw.args as string[])];
  }
  if (raw.env !== undefined) {
    if (!isRecord(raw.env) || Object.values(raw.env).some((value) => typeof value !== "string")) {
      throw invalidConfig(`${where} 的 env 必须是字符串 map`);
    }
    server.env = { ...(raw.env as Record<string, string>) };
  }
  if (raw.envAllowlist !== undefined) {
    if (
      !Array.isArray(raw.envAllowlist)
      || raw.envAllowlist.some((key) => typeof key !== "string")
    ) {
      throw invalidConfig(`${where} 的 envAllowlist 必须是字符串数组`);
    }
    server.envAllowlist = [...(raw.envAllowlist as string[])];
  }
  if (raw.inheritEnv !== undefined) {
    if (typeof raw.inheritEnv !== "boolean") {
      throw invalidConfig(`${where} 的 inheritEnv 必须是布尔值`);
    }
    server.inheritEnv = raw.inheritEnv;
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string" || raw.cwd.trim() === "") {
      throw invalidConfig(`${where} 的 cwd 必须是非空字符串`);
    }
    server.cwd = raw.cwd;
  }
  if (raw.timeoutMs !== undefined) {
    if (
      typeof raw.timeoutMs !== "number"
      || !Number.isInteger(raw.timeoutMs)
      || raw.timeoutMs <= 0
    ) {
      throw invalidConfig(`${where} 的 timeoutMs 必须是正整数`);
    }
    server.timeoutMs = raw.timeoutMs;
  }
  if (raw.disabled !== undefined) {
    if (typeof raw.disabled !== "boolean") {
      throw invalidConfig(`${where} 的 disabled 必须是布尔值`);
    }
    server.disabled = raw.disabled;
  }
  return server;
}

function readMcpServers(mcpPath: string, warnings: Array<{ server: string; field: string }>): AppMcpServer[] {
  const value = readJsonFileIfExists(mcpPath);
  if (value === undefined) return [];
  if (!isRecord(value)) {
    throw unreadable(`MCP 配置顶层必须是对象: ${mcpPath}`);
  }
  const rawServers = value.mcpServers;
  if (rawServers === undefined) return [];
  if (!isRecord(rawServers)) {
    throw unreadable(`MCP 配置 mcpServers 必须是对象: ${mcpPath}`);
  }
  const servers: AppMcpServer[] = [];
  for (const [name, raw] of Object.entries(rawServers)) {
    try {
      servers.push(
        normalizeMcpServer(name, raw, {
          mode: "warn",
          warn: (field) => warnings.push({ server: name, field }),
        }),
      );
    } catch (error) {
      if (error instanceof AppConfigError) {
        throw unreadable(`${error.message}（${mcpPath}）`, error);
      }
      throw error;
    }
  }
  return servers;
}

function readPermissions(home: string, permissionsPath: string): AppPermissionSettings {
  let loaded;
  try {
    loaded = loadPermissionConfig({ home, workdir: home });
  } catch (error) {
    if (error instanceof PermissionConfigError) {
      throw unreadable(`权限配置不可用: ${permissionsPath}（${error.message}）`, error);
    }
    throw error;
  }
  return {
    preset: loaded.preset,
    approvalTimeoutMs: loaded.approvalTimeoutMs,
    // loadPermissionConfig 的 rules 是带来源的 SourcedRule；快照只暴露规则本身。
    rules: loaded.rules.map((entry) => entry.rule),
  };
}

function parseRunLimits(value: unknown, source: string): AppRunLimits {
  if (!isRecord(value)) {
    throw invalidConfig(`运行上限配置必须是对象: ${source}`);
  }
  for (const field of Object.keys(value)) {
    if (!RUN_LIMIT_FIELDS.has(field)) {
      throw invalidConfig(`运行上限配置含未知字段 ${JSON.stringify(field)}: ${source}`);
    }
  }
  const limits: AppRunLimits = { ...DEFAULT_RUN_LIMITS };
  const maxTurns = value.maxTurns;
  if (maxTurns !== undefined) {
    // null 是显式的「不限制」；0 / 负数 / 非整数仍是错误——它们更像笔误，
    // 静默当成「不限」会让用户以为上限生效了。
    if (
      maxTurns !== null
      && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns <= 0)
    ) {
      throw invalidConfig(`运行上限 maxTurns 必须是正整数或 null: ${source}`);
    }
    limits.maxTurns = maxTurns;
  }
  if (value.maxCostUsd !== undefined) {
    if (
      value.maxCostUsd !== null
      && (
        typeof value.maxCostUsd !== "number"
        || !Number.isFinite(value.maxCostUsd)
        || value.maxCostUsd <= 0
      )
    ) {
      throw invalidConfig(`运行上限 maxCostUsd 必须是正数或 null: ${source}`);
    }
    limits.maxCostUsd = value.maxCostUsd;
  }
  if (value.timeoutMs !== undefined) {
    if (
      value.timeoutMs !== null
      && (
        typeof value.timeoutMs !== "number"
        || !Number.isFinite(value.timeoutMs)
        || value.timeoutMs <= 0
      )
    ) {
      throw invalidConfig(`运行上限 timeoutMs 必须是正数或 null: ${source}`);
    }
    limits.timeoutMs = value.timeoutMs;
  }
  if (value.systemPrompt !== undefined) {
    if (typeof value.systemPrompt !== "string") {
      throw invalidConfig(`运行上限 systemPrompt 必须是字符串: ${source}`);
    }
    limits.systemPrompt = value.systemPrompt;
  }
  return limits;
}

function readRunLimits(runPath: string): AppRunLimits {
  const value = readJsonFileIfExists(runPath);
  if (value === undefined) return { ...DEFAULT_RUN_LIMITS };
  try {
    return parseRunLimits(value, runPath);
  } catch (error) {
    if (error instanceof AppConfigError) {
      throw unreadable(error.message, error);
    }
    throw error;
  }
}

export function readProviders(home: string): {
  providers: ProvidersConfig;
  providersPath: string;
} {
  const providersPath = path.join(home, "providers.json");
  let text: string;
  try {
    text = readFileSync(providersPath, "utf8");
  } catch (error) {
    // 文件不存在 = 用户还没配模型，按空配置处理；其他 fs 错误（权限、IO）必须显式报错。
    if (isFileNotFound(error)) return { providers: {}, providersPath };
    throw unreadable(`providers 配置读取失败: ${providersPath}（${errorMessage(error)}）`, error);
  }
  try {
    // schema 只在 providers.ts 维护一份，这里复用，避免两处校验漂移。
    return { providers: parseProviders(stripBom(text)), providersPath };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      // JSON 坏 → config_unreadable；schema 坏 → invalid_config。
      const code = error.code === "providers_invalid_json" ? "config_unreadable" : "invalid_config";
      throw new AppConfigError(code, `${error.message}（${providersPath}）`, error);
    }
    throw error;
  }
}

export async function writeProviders(home: string, input: unknown): Promise<ProvidersConfig> {
  // 借 parseProviders 做校验：先序列化再解析，保证「写进去的一定读得回来」。
  // 序列化失败（循环引用、BigInt、undefined/函数）也在这里被收敛成 invalid_config。
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch (error) {
    throw invalidConfig(
      `providers 配置无法序列化为 JSON（<inline>）: ${errorMessage(error)}`,
      error,
    );
  }
  if (text === undefined) {
    throw invalidConfig("providers 配置不能是 undefined 或函数（<inline>）");
  }
  let providers: ProvidersConfig;
  try {
    providers = parseProviders(text);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw invalidConfig(`${error.message}（<inline>）`, error);
    }
    throw error;
  }
  // 校验通过才落盘：非法输入不会碰到原文件（writeJsonAtomic 是最后一步）。
  await writeJsonAtomic(path.join(home, "providers.json"), providers);
  return providers;
}

export function readAppConfig(home: string): AppConfigSnapshot {
  const mcpPath = path.join(home, "mcp.json");
  const permissionsPath = path.join(home, "permissions.json");
  const runPath = path.join(home, "run.json");
  const warnings: Array<{ server: string; field: string }> = [];
  const mcpServers = readMcpServers(mcpPath, warnings);
  const permissions = readPermissions(home, permissionsPath);
  const run = readRunLimits(runPath);
  // providers 走降级读取：模型配置坏掉不能把设置页整页打挂，否则用户没地方修。
  // 其余三份仍按显式失败（R3），只有 providers 带 providersError 继续返回。
  const providersPath = path.join(home, "providers.json");
  let providers: ProvidersConfig = {};
  let providersError: string | undefined;
  try {
    providers = readProviders(home).providers;
  } catch (error) {
    if (!(error instanceof AppConfigError)) throw error;
    providersError = error.message;
  }
  return {
    mcpServers,
    warnings,
    permissions,
    permissionsPath,
    mcpPath,
    run,
    runPath,
    providers,
    providersPath,
    ...(providersError === undefined ? {} : { providersError }),
  };
}

export async function writeMcpServers(home: string, input: unknown): Promise<AppMcpServer[]> {
  if (!Array.isArray(input)) {
    throw invalidConfig("MCP servers 必须是数组");
  }
  const servers: AppMcpServer[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!isRecord(raw)) {
      throw invalidConfig("MCP server 的每一项都必须是对象");
    }
    const server = normalizeMcpServer(raw.name, raw, { mode: "reject" });
    if (seen.has(server.name)) {
      throw invalidConfig(`MCP server 名称重复: ${JSON.stringify(server.name)}`);
    }
    seen.add(server.name);
    servers.push(server);
  }
  const document = {
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, toMcpFileEntry(server)])),
  };
  await writeJsonAtomic(path.join(home, "mcp.json"), document);
  return servers;
}

export async function writePermissionConfig(
  home: string,
  input: unknown,
): Promise<AppPermissionSettings> {
  let inline: InlinePermissionConfig;
  try {
    inline = parseInlinePermissionConfig(input);
  } catch (error) {
    if (error instanceof PermissionConfigError) {
      throw invalidConfig(error.message, error);
    }
    throw error;
  }
  // PUT 语义是整份替换：只写用户给出的字段，未给字段在文件中不存在，按内核默认值生效。
  const document: PermissionConfig = {
    version: 1,
    ...(inline.preset === undefined ? {} : { preset: inline.preset }),
    ...(inline.rules === undefined ? {} : { rules: inline.rules }),
    ...(inline.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: inline.approvalTimeoutMs }),
  };
  await writeJsonAtomic(path.join(home, "permissions.json"), document);
  return {
    preset: inline.preset ?? DEFAULT_PERMISSION_PRESET,
    approvalTimeoutMs: inline.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    rules: inline.rules ?? [],
  };
}

export async function writeRunLimits(home: string, input: unknown): Promise<AppRunLimits> {
  const limits = parseRunLimits(input, "<inline>");
  await writeJsonAtomic(path.join(home, "run.json"), limits);
  return limits;
}
