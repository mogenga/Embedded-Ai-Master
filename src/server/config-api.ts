import {
  AppConfigError,
  readAppConfig,
  writeMcpServers,
  writePermissionConfig,
  writeProviders,
  writeRunLimits,
} from "../config/app-config.js";
import type {
  AppConfigSnapshot,
  AppMcpServer,
  AppPermissionSettings,
  AppRunLimits,
} from "../config/app-config.js";
import type { ProvidersConfig } from "../config/providers.js";
import { HttpError } from "./http.js";

/**
 * 配置读写端点的输入/输出与错误映射。
 *
 * 这一层不做 HTTP 的事（鉴权、body 解析、路由都在 api.ts），只负责：
 * 把不可信的请求体收敛成内核类型，把内核错误映射为带原因的状态码。
 * 失败必须带原因（R3）：只说「无效」会让用户不知道改哪个字段。
 */

export interface ConfigApi {
  get(): AppConfigSnapshot;
  putMcp(body: unknown): Promise<{
    mcpServers: AppMcpServer[];
    warnings: Array<{ server: string; field: string }>;
  }>;
  putPermissions(body: unknown): Promise<{ permissions: AppPermissionSettings }>;
  putRun(body: unknown): Promise<{ run: AppRunLimits }>;
  putProviders(body: unknown): Promise<{ providers: ProvidersConfig }>;
}

export interface ConfigApiOptions {
  harnessHome: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 读侧错误：文件不可读 / JSON 损坏 / schema 不符都按 500 报，附原因。
function mapReadError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof AppConfigError) {
    if (error.code === "invalid_config") {
      return new HttpError(500, "config_invalid", error.message);
    }
    return new HttpError(500, "config_unreadable", error.message);
  }
  return new HttpError(
    500,
    "config_unreadable",
    `配置读取失败: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// 写侧错误：用户输入不合法 → 400；磁盘/权限问题 → 500。两者不能混为一谈。
function mapWriteError(error: unknown, invalidCode: string): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof AppConfigError) {
    if (error.code === "invalid_config") {
      return new HttpError(400, invalidCode, error.message);
    }
    if (error.code === "config_write_failed") {
      return new HttpError(500, "config_unwritable", error.message);
    }
    return new HttpError(500, "config_unreadable", error.message);
  }
  return new HttpError(
    500,
    "config_unwritable",
    `配置写入失败: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function createConfigApi(opts: ConfigApiOptions): ConfigApi {
  const { harnessHome } = opts;
  return {
    get() {
      try {
        return readAppConfig(harnessHome);
      } catch (error) {
        throw mapReadError(error);
      }
    },

    async putMcp(body) {
      if (!isRecord(body) || !Array.isArray(body.servers)) {
        throw new HttpError(400, "invalid_body", "servers 必须是数组");
      }
      let mcpServers: AppMcpServer[];
      try {
        mcpServers = await writeMcpServers(harnessHome, body.servers);
      } catch (error) {
        throw mapWriteError(error, "invalid_config");
      }
      // 写进去的配置内核一定能解析，所以这里没有 warning；保留字段是为了让
      // 上层在同一个响应里拿到与 GET 同形状的数据。
      return { mcpServers, warnings: [] };
    },

    async putPermissions(body) {
      if (!isRecord(body) || !isRecord(body.permissions)) {
        throw new HttpError(400, "invalid_config", "permissions 必须是对象");
      }
      let permissions: AppPermissionSettings;
      try {
        permissions = await writePermissionConfig(harnessHome, body.permissions);
      } catch (error) {
        throw mapWriteError(error, "invalid_config");
      }
      return { permissions };
    },

    async putRun(body) {
      if (!isRecord(body) || !isRecord(body.run)) {
        throw new HttpError(400, "invalid_body", "run 必须是对象");
      }
      let run: AppRunLimits;
      try {
        run = await writeRunLimits(harnessHome, body.run);
      } catch (error) {
        throw mapWriteError(error, "invalid_config");
      }
      return { run };
    },

    async putProviders(body) {
      // 这里只判「是不是对象」，字段级校验全部交给内核的 zod schema：
      // 在协议层重写一遍 provider 规则，两边迟早会漂移。
      if (!isRecord(body) || !isRecord(body.providers)) {
        throw new HttpError(400, "invalid_config", "providers 必须是对象");
      }
      let providers: ProvidersConfig;
      try {
        providers = await writeProviders(harnessHome, body.providers);
      } catch (error) {
        throw mapWriteError(error, "invalid_config");
      }
      return { providers };
    },
  };
}
