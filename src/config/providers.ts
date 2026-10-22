import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * 模型容量参数的**估算**默认值。
 *
 * 这不是从服务商读到的真实上限：OpenAI 兼容协议里 `GET /v1/models` 只保证返回
 * 模型 id，contextWindow / maxOutput 没有标准来源，所以内核不能自动获取，只能给
 * 一个明示的估算值兜底。用户若在 providers.json 里写了值，一律以用户为准
 * （见 `resolveContextWindow` / `resolveMaxOutput`）。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT = 4_096;

/**
 * 推理强度（OpenAI 兼容协议的 `reasoning_effort`）。
 *
 * 这五个值是协议自己的枚举，不是本项目的发明：`minimal` / `low` / `medium` /
 * `high` 是 chat completions 的既有取值，`none` 是较新的一档（显式关闭推理）。
 * **`none` 与「字段缺席」不是一回事**：缺席表示「不提要求，用服务商默认」，
 * 而 `none` 是「明确不要推理」。两者必须都能表达，所以这里把 `none` 收进枚举，
 * 而不是把它当成「等于没填」。
 *
 * 刻意不接受 `max` / `xhigh` 之类的网关私有档位：内核只发协议字段，收下一个
 * 自己不认识的值，只会在某个不支持的网关上换来一个 400，或者更糟——被静默忽略，
 * 而界面已经显示「已设为 max」。
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);

// 两者都是可选的：要求用户填自己查不到的数值，只会得到凭感觉乱填。
// 注意这里**不**写 `.default()`——缺省必须保持 undefined，读值方才有机会
// 区分「用户没填」与「用户填了恰好等于默认值的数」。
//
// 推理强度同理，而且后果更大：凭空补一个默认值会改变每一个既有用户的每一次
// 请求（有的网关对不认识的字段直接 400，有的会因此关掉自己的默认推理）。
const ModelConfigSchema = z
  .object({
    contextWindow: z.number().int().positive().optional(),
    maxOutput: z.number().int().positive().optional(),
    /**
     * 这个模型接受推理强度参数。
     *
     * 可选，且**没有默认值**：OpenAI 兼容协议的 `GET /v1/models` 不报告这项
     * 能力，内核无从得知，只能由用户声明。不声明就是「没说过」，按不支持处理
     * （见 `supportsReasoning`），界面据此不摆出一个请求会被丢掉的选项。
     */
    supportsReasoning: z.boolean().optional(),
    /** 未从界面覆盖时使用的默认等级；缺省表示不发该字段。 */
    reasoningEffort: ReasoningEffortSchema.optional(),
  })
  .refine(
    (model) => !(model.supportsReasoning === false && model.reasoningEffort !== undefined),
    {
      // 自相矛盾的配置：说不支持，又指定了一个等级。信哪一半都会让另一半在
      // 某个界面上被当成事实展示，所以两份都不信——直接报错让用户改。
      message: "reasoningEffort 不能与 supportsReasoning: false 同时出现",
      path: ["reasoningEffort"],
    },
  );

const PriceSchema = z.number().nonnegative().finite();

const ProviderConfigSchema = z.object({
  protocol: z.literal("openai-chat-completions"),
  baseUrl: z.string().url(),
  /**
   * 直接写在配置文件里的 API 密钥（明文）。
   *
   * 为什么允许明文：这是用户本机的配置文件，威胁模型与 `~/.ssh/id_*`、
   * `~/.git-credentials` 同级——能读这个文件的人本来就能读用户的一切。
   * 桌面应用的用户装好软件后不可能为了填一个密钥去设系统环境变量再重启，
   * 强制 `apiKeyEnv` 只会把用户挡在门外（真实事故：用户把密钥填进了
   * 「环境变量名」字段，应用既没保存也没使用）。
   *
   * 与 `apiKeyEnv` 的关系：两者**可以并存**，此时 `apiKey` 优先（显式值
   * 覆盖环境变量）；两者都没有时请求不带 Authorization 头。空字符串等于
   * 没有——绝不会把空值当密钥发出去。判定统一走 `resolveProviderApiKey`。
   *
   * **安全**：这个值只允许出现在出站请求的 Authorization 头里，禁止写入
   * 日志、错误信息、事件流或任何对外输出。回显给用户时一律脱敏。
   */
  apiKey: z.string().optional(),
  /** 密钥所在的环境变量**名**（不是密钥本身）；`apiKey` 缺省时才用它。 */
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

/**
 * 取模型实际使用的上下文窗口：用户填了就用用户的，没填返回 `DEFAULT_CONTEXT_WINDOW`。
 *
 * 所有读 `modelCfg.contextWindow` 的地方都必须走这里——把 `?? 128000` 撒在调用点
 * 会让默认值失去单一出处，改一次要改 N 处，且容易漏掉一处得到 NaN。
 */
export function resolveContextWindow(modelCfg: ModelCfg): number {
  return modelCfg.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** 取模型实际使用的单次输出上限；语义同 `resolveContextWindow`。 */
export function resolveMaxOutput(modelCfg: ModelCfg): number {
  return modelCfg.maxOutput ?? DEFAULT_MAX_OUTPUT;
}

/**
 * 这个模型是否声明接受推理强度参数。
 *
 * 判据只有一条：用户说过。`supportsReasoning: true` 是明说；写了一个默认等级
 * 也算——值本身就是声明（schema 已经拒绝了「说不支持又给等级」的矛盾写法）。
 *
 * 拿不到声明时一律按**不支持**处理。反过来「猜它支持」会让界面摆出选项、请求
 * 却把参数丢掉，那正是本次要修的谎。
 */
export function supportsReasoning(modelCfg: ModelCfg): boolean {
  return modelCfg.supportsReasoning === true || modelCfg.reasoningEffort !== undefined;
}

/**
 * 这一次请求实际要发的等级：单次覆盖优先，其次是模型配置，都没有则 `undefined`。
 *
 * `undefined` 是「不发这个字段」，与 `"none"`（显式关闭推理）是两件事，调用方
 * 必须原样区分。校验覆盖值由调用方（runner）负责——这一层只解析，不判断运行期
 * 的合法性。
 */
export function resolveReasoningEffort(
  modelCfg: ModelCfg,
  override?: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  return override ?? modelCfg.reasoningEffort;
}

/**
 * 取 provider 实际使用的 API 密钥；返回 trim 后的值，未配置时 `undefined`。
 *
 * 优先级：`apiKey`（直接写在配置里的明文密钥）> `apiKeyEnv` 指向的环境变量。
 * 显式值覆盖间接值——用户既然直接填了密钥，就不该被一个旧的环境变量名盖住。
 *
 * 空值语义（三层都一致）：`apiKey` 为空串/纯空白等于「没填」，此时**回落**到
 * `apiKeyEnv`；两者都拿不到非空值就返回 `undefined`，调用方据此**不发**
 * Authorization 头。空串和纯空白从不算有效密钥——发一个 `Bearer ` 只会换来
 * 一个看似「密钥错误」的 401，掩盖真正的配置问题。
 *
 * 这个函数只做解析，不做任何日志：返回值只允许进请求头。
 */
export function resolveProviderApiKey(
  provider: { apiKey?: string | undefined; apiKeyEnv?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const direct = provider.apiKey?.trim();
  if (direct !== undefined && direct !== "") return direct;

  const envName = provider.apiKeyEnv?.trim();
  if (envName === undefined || envName === "") return undefined;
  const fromEnv = env[envName]?.trim();
  if (fromEnv === undefined || fromEnv === "") return undefined;
  return fromEnv;
}

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
