import fs from "node:fs";
import path from "node:path";
import { McpConfigError } from "./errors.js";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  disabled?: boolean;
}

export interface LoadMcpConfigOptions {
  home: string;
  workdir: string;
  userConfigPath?: string;
  projectConfigPath?: string;
}

type PartialServerConfig = Omit<McpServerConfig, "name" | "command"> & { command?: string };

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfig(message: string, detail?: unknown): McpConfigError {
  return new McpConfigError(message, detail);
}

function readJsonFile(filePath: string): unknown | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw invalidConfig(`MCP 配置读取失败: ${filePath}`, error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw invalidConfig(`MCP 配置 JSON 无效: ${filePath}`, error);
  }
}

function parseServer(
  name: string,
  raw: Record<string, unknown>,
  filePath: string,
  baseDir: string,
): PartialServerConfig {
  const server: PartialServerConfig = {};
  const where = `${filePath} 中的 server "${name}"`;

  if (raw.command !== undefined) {
    if (typeof raw.command !== "string" || raw.command.trim() === "") {
      throw invalidConfig(`${where} 的 command 必须是非空字符串`);
    }
    server.command = raw.command;
  }

  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
      throw invalidConfig(`${where} 的 args 必须是字符串数组`);
    }
    server.args = [...raw.args] as string[];
  }

  if (raw.env !== undefined) {
    if (!isRecord(raw.env) || Object.values(raw.env).some((value) => typeof value !== "string")) {
      throw invalidConfig(`${where} 的 env 必须是字符串 map`);
    }
    server.env = { ...(raw.env as Record<string, string>) };
  }

  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string" || raw.cwd.trim() === "") {
      throw invalidConfig(`${where} 的 cwd 必须是非空字符串`);
    }
    server.cwd = path.resolve(baseDir, raw.cwd);
  }

  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0) {
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

function parseConfigFile(filePath: string): Map<string, PartialServerConfig> {
  const value = readJsonFile(filePath);
  const servers = new Map<string, PartialServerConfig>();
  if (value === undefined) {
    return servers;
  }
  if (!isRecord(value)) {
    throw invalidConfig(`MCP 配置顶层必须是对象: ${filePath}`);
  }
  const rawServers = value.mcpServers;
  if (rawServers === undefined) {
    return servers;
  }
  if (!isRecord(rawServers)) {
    throw invalidConfig(`MCP 配置 mcpServers 必须是对象: ${filePath}`);
  }
  const baseDir = path.dirname(filePath);
  for (const name of Object.keys(rawServers)) {
    if (!NAME_PATTERN.test(name)) {
      throw invalidConfig(`MCP server 名称非法: ${JSON.stringify(name)}（须匹配 ${NAME_PATTERN.source}）`);
    }
    const raw = rawServers[name];
    if (!isRecord(raw)) {
      throw invalidConfig(`MCP server "${name}" 配置必须是对象: ${filePath}`);
    }
    servers.set(name, parseServer(name, raw, filePath, baseDir));
  }
  return servers;
}

function mergeServer(
  name: string,
  user: PartialServerConfig | undefined,
  project: PartialServerConfig | undefined,
  workdir: string,
): McpServerConfig | undefined {
  const merged: PartialServerConfig = { ...user, ...project };
  if (user?.env !== undefined || project?.env !== undefined) {
    merged.env = { ...(user?.env ?? {}), ...(project?.env ?? {}) };
  }
  if (merged.command === undefined) {
    throw invalidConfig(`MCP server "${name}" 缺少必填字段 command`);
  }
  if (merged.disabled === true) {
    return undefined;
  }
  const config: McpServerConfig = {
    name,
    command: merged.command,
    cwd: merged.cwd ?? workdir,
    timeoutMs: merged.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (merged.args !== undefined) {
    config.args = merged.args;
  }
  if (merged.env !== undefined) {
    config.env = merged.env;
  }
  return config;
}

export function loadMcpConfig(opts: LoadMcpConfigOptions): McpServerConfig[] {
  const userPath = opts.userConfigPath ?? path.join(opts.home, "mcp.json");
  const projectPath = opts.projectConfigPath ?? path.join(opts.workdir, ".harness", "mcp.json");
  const userServers = parseConfigFile(userPath);
  const projectServers = parseConfigFile(projectPath);
  const workdir = path.resolve(opts.workdir);
  const names = new Set([...userServers.keys(), ...projectServers.keys()]);
  const result: McpServerConfig[] = [];
  for (const name of names) {
    const config = mergeServer(name, userServers.get(name), projectServers.get(name), workdir);
    if (config !== undefined) {
      result.push(config);
    }
  }
  result.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return result;
}