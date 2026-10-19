import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ModelConfigSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
});

const PriceSchema = z.number().nonnegative().finite();

const ProviderConfigSchema = z.object({
  protocol: z.literal("openai-chat-completions"),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().optional(),
  models: z.record(z.string(), ModelConfigSchema),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxResponseBytes: z.number().int().positive().optional(),
  pricePerMillion: z.object({
    input: PriceSchema,
    output: PriceSchema,
    cachedInput: PriceSchema.optional(),
  }).optional(),
});

const ProvidersFileSchema = z.record(z.string(), ProviderConfigSchema);

export type ModelCfg = z.infer<typeof ModelConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersFileSchema>;

export class ConfigValidationError extends Error {
  readonly code: "providers_invalid_json" | "providers_invalid";
  readonly detail: unknown;

  constructor(code: "providers_invalid_json" | "providers_invalid", message: string, detail?: unknown) {
    super(message);
    this.name = "ConfigValidationError";
    this.code = code;
    this.detail = detail;
  }
}

export class ConfigLoadError extends Error {
  readonly code: "providers_not_found" | "providers_read_failed";
  readonly detail: unknown;

  constructor(
    code: "providers_not_found" | "providers_read_failed",
    message: string,
    detail?: unknown,
  ) {
    super(message);
    this.name = "ConfigLoadError";
    this.code = code;
    this.detail = detail;
  }
}

export class ModelReferenceError extends Error {
  readonly code = "model_reference_invalid";
  readonly detail: { ref: string; validReferences: string[] };

  constructor(ref: string, validReferences: string[]) {
    super(`模型引用无效: ${ref}。合法引用: ${validReferences.join(", ") || "<none>"}`);
    this.name = "ModelReferenceError";
    this.detail = { ref, validReferences };
  }
}

export function parseProviders(text: string): ProvidersConfig {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigValidationError(
      "providers_invalid_json",
      `providers 配置 JSON 无效: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  const result = ProvidersFileSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ConfigValidationError("providers_invalid", `providers 配置校验失败: ${details}`, result.error.issues);
  }
  return result.data;
}

export function loadProviders(
  home: string,
  readFile: (filePath: string) => string = (filePath) => fs.readFileSync(filePath, "utf8"),
): ProvidersConfig {
  const filePath = path.join(home, "providers.json");
  try {
    return parseProviders(readFile(filePath));
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new ConfigLoadError("providers_not_found", `providers 文件不存在: ${filePath}`, error);
    }
    if (error instanceof ConfigLoadError) {
      throw error;
    }
    if (error instanceof ConfigValidationError) {
      throw error;
    }
    throw new ConfigLoadError("providers_read_failed", `providers 文件读取失败: ${filePath}`, error);
  }
}

export function resolveModelRef(
  providers: Record<string, ProviderConfig>,
  ref: string,
): { providerName: string; provider: ProviderConfig; modelName: string; model: ModelCfg } {
  const references = Object.keys(providers).flatMap((providerName) =>
    Object.keys(providers[providerName]?.models ?? {}).map((modelName) => `${providerName}/${modelName}`),
  );
  const separator = ref.indexOf("/");
  const providerName = separator < 0 ? ref : ref.slice(0, separator);
  const modelName = separator < 0 ? "" : ref.slice(separator + 1);
  const provider = Object.hasOwn(providers, providerName) ? providers[providerName] : undefined;
  const model = provider !== undefined && Object.hasOwn(provider.models, modelName)
    ? provider.models[modelName]
    : undefined;
  if (!provider || !model || !providerName || !modelName) {
    throw new ModelReferenceError(ref, references);
  }
  return { providerName, provider, modelName, model };
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
