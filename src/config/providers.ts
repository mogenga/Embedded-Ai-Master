import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ModelCapability } from "../model/catalog.js";

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
 *
 * 这五个值仍然是「没有能力目录时能安全发出去的白名单」。网关**明确报出**它
 * 接受别的值时，那条路走 `acceptedEfforts` + `resolveTierAgainst`；下面这张表
 * 本身不扩张。
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);

/**
 * 网关目录可能报出的、超出上面白名单的已知值。只在目录明确报出时才可发。
 *
 * 放进这里不等于放宽 `REASONING_EFFORTS`：它是「`providers.json` 的
 * `reasoningLevels` 允许写哪些值」的合法集，而请求能不能带这个值仍由
 * `acceptedEfforts` 决定（见 `resolveTierAgainst`）。
 */
export const EXTENDED_EFFORTS = ["xhigh", "max", "ultra", "persistent"] as const;

/**
 * 全序，用于按语义秩解析。
 *
 * 这是**协议值的强度序**，不是界面档位：`extra` / `galaxy` 这些档位名不在表里，
 * 它们的秩由 `TIER_RANK` 单独给出（两者刻意分开，混在一张表里会让
 * 「一个协议值同时是档位名」——`low` / `medium` / `high` 正是如此——变得含糊）。
 *
 * `persistent` 与 `ultra` 同为 7：两者都是「最高、且没有更细的强弱关系可依」的
 * 网关私有值，给不同的秩等于编造一个我们并不知道的排序。
 */
export const EFFORT_RANK = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
  persistent: 7,
} as const;

/** 协议值的强度秩；认不出的值返回 `undefined`（调用方据此保留原值）。 */
export function effortRank(value: string): number | undefined {
  return Object.hasOwn(EFFORT_RANK, value)
    ? EFFORT_RANK[value as keyof typeof EFFORT_RANK]
    : undefined;
}

/**
 * 界面上的六档，稳定升序。
 *
 * **这不是协议取值。** 请求体里能出现的仍然只有 `REASONING_EFFORTS` 那五个；
 * 这六档是给人看的表达，发上线之前一律经 `resolveEffortTier` 按模型的映射表
 * 折算成协议值。`max` / `galaxy` 这类名字敢在这里出现，正是因为它们永远到不了
 * 请求体——上面那段「刻意不接受网关私有档位」的约束没有变。
 */
export const EFFORT_TIERS = ["low", "medium", "high", "extra", "max", "galaxy"] as const;

export type EffortTier = (typeof EFFORT_TIERS)[number];

export function isEffortTier(value: unknown): value is EffortTier {
  return typeof value === "string" && (EFFORT_TIERS as readonly string[]).includes(value);
}

const EffortTierSchema = z.enum(EFFORT_TIERS);

/**
 * 档位 → 语义秩。
 *
 * 与 `EFFORT_RANK` 同一套数字，但这是**界面档位**的秩：`extra` 是 5（对齐
 * 协议值 `xhigh`），`galaxy` 是 7（对齐 `ultra` / `persistent`）。解析规则
 * （`resolveTierAgainst`）只看这张表与 `effortRank`。
 */
const TIER_RANK: Record<EffortTier, number> = {
  low: 2,
  medium: 3,
  high: 4,
  extra: 5,
  max: 6,
  galaxy: 7,
};

/** `acceptedEfforts` 的合法值全集：五档安全值 + 网关扩展值。 */
const KNOWN_EFFORTS: readonly string[] = [...REASONING_EFFORTS, ...EXTENDED_EFFORTS];

/** 档位白名单的报错文案；schema 与 `resolveEffortTier` 共用，保证两处口径一致。 */
const EFFORT_TIER_HINT = `合法档位: ${EFFORT_TIERS.join(", ")}`;

/** `reasoningLevels` 的报错文案；与 `EFFORT_TIER_HINT` 同风格。 */
const REASONING_LEVEL_HINT = `合法值: ${KNOWN_EFFORTS.join(", ")}`;

/**
 * 六档 → 协议值的**缺省**映射。
 *
 * 高出的三档（extra / max / galaxy）默认都落到 `high`，这是刻意的：多数模型
 * 只有 3–5 个真实档位，硬凑六个不同的协议值只会让界面显示的与实际发出的不符。
 * 用户可以在 providers.json 的 `effortMap` 里逐档覆盖。
 */
export const DEFAULT_EFFORT_MAP: Record<EffortTier, ReasoningEffort> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "high",
  max: "high",
  galaxy: "high",
};

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
    /**
     * 这个模型把界面上的哪一档映射到哪个协议值。
     *
     * 可选，且**逐档可选**：没写的档走 `DEFAULT_EFFORT_MAP`，所以一个模型只
     * 想改 `extra` 就只写 `extra`。值仍必须是 `REASONING_EFFORTS` 里的协议
     * 值——档位名（`galaxy` 之类）出现在值里说明配置写反了，这里直接拒绝。
     *
     * 用 `partialRecord` 而不是 `record`：Zod v4 的 `z.record(z.enum(...))`
     * 会要求六档**全部**出现，那样「只覆盖一档」的写法反而通不过校验。
     */
    effortMap: z
      .partialRecord(EffortTierSchema, ReasoningEffortSchema, {
        // 默认的 `Unrecognized key: "turbo"` 不告诉用户合法值是什么（R3）。
        //
        // 这里的收窄是手写的：Zod 给 record 声明的 issue 联合里没有
        // `unrecognized_keys`（它的 `isst` 只列了 invalid_type / invalid_key），
        // 但运行期明确会发出这个 code——`partialRecord` 遇到未知键时正是它。
        // 直接比较会被 TS 判成「永不相等」，所以按运行期形状取一次。
        error: (issue) => {
          const runtime = issue as { code: string; keys?: string[] };
          return runtime.code === "unrecognized_keys"
            ? `未知档位 ${JSON.stringify(runtime.keys ?? [])}；${EFFORT_TIER_HINT}`
            : undefined;
        },
      })
      .optional(),
    /**
     * 这个模型接受的协议值（三级回退的第 2 级）。
     *
     * 只在网关目录没报能力时才生效；两者都有时网关优先——它是执行方，它的表
     * 决定请求会不会被接受，而这里是用户的猜测。**有 `reasoningLevels` 时
     * `effortMap` 不再参与解析**：两套映射同时生效会得到两个答案。
     *
     * 可选，且**没有默认值**：缺省必须保持 `undefined`。`undefined` 与空数组是
     * 两件事——前者是「没写，回去用 `effortMap`」，后者是「这个模型确实一档都
     * 没有」。给它一个默认值就把这两级压成一级了。
     *
     * 元素必须是已知的协议值（见 `KNOWN_EFFORTS`）：这里放宽到 `xhigh` 之类，
     * 是因为用户可以按自己网关的文档手写；仍不接受凭空发明的字符串——那只会
     * 在发请求时换回一个 400。
     */
    reasoningLevels: z
      .array(
        z.string({ error: REASONING_LEVEL_HINT }).refine(
          (value) => KNOWN_EFFORTS.includes(value),
          { error: (issue) => `未知的推理强度 ${JSON.stringify(issue.input)}；${REASONING_LEVEL_HINT}` },
        ),
      )
      .optional(),
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
 * 把界面档位折算成这一模型实际会发的协议值。
 *
 * 先看模型的 `effortMap`，没写的档回落 `DEFAULT_EFFORT_MAP`——所以一个完全
 * 没配 `effortMap` 的模型也能用，只是六档退化成三档有效值。
 *
 * 档位不是协议值，所以**运行期也拒绝**非档位输入：类型层挡住了 TS 调用方，
 * 但宿主是 JavaScript，读的是 JSON 里的字符串。收下一个 `"none"` 当档位，
 * 会让它被当成「没配过」而悄悄落到 `high`——那正是「界面显示的与实际发出的
 * 不符」。
 */
export function resolveEffortTier(modelCfg: ModelCfg, tier: EffortTier): ReasoningEffort {
  if (!isEffortTier(tier)) {
    throw new TypeError(`effort tier 非法: ${JSON.stringify(tier)}；${EFFORT_TIER_HINT}`);
  }
  return modelCfg.effortMap?.[tier] ?? DEFAULT_EFFORT_MAP[tier];
}

/**
 * 这个模型真正接受的协议值（三级回退）。
 *
 * 优先级，从高到低：
 *
 * 1. **`supportsReasoning: false`（显式否定）** → `undefined`。用户说这个模型
 *    不吃参数，那是比目录更强的断言，不再去看目录。
 * 2. **网关目录** → 目录报出的 `efforts`。网关是执行方，它的表决定请求会不会
 *    被接受；配置是用户的猜测，猜错只会得到一个 400。
 * 3. **`providers.json` 的 `reasoningLevels`** → 原样返回（排序与去重由目录
 *    解析层负责；用户手写的这一份保持写入顺序，解析时也不依赖顺序）。
 * 4. 都没有 → `undefined`。
 *
 * **`undefined` 与 `[]` 不是一回事**：前者是「不知道」，调用方该回落到
 * `resolveEffortTier`（第三级）；后者是「确实一档都没有」，那一档就是不可用。
 * 两者都能表达，是三级回退成立的前提。
 *
 * 显式否定时返回的是 `undefined` 而不是 `[]`：它答的是「别问这个模型的能力」，
 * 而不是「它的能力是空集」——调用方仍会走第三级，只是第三级的结果在
 * `supportsReasoning: false` 的模型上根本不会被发出去。
 */
export function acceptedEfforts(
  modelCfg: ModelCfg,
  capability?: ModelCapability,
): string[] | undefined {
  if (modelCfg.supportsReasoning === false) return undefined;
  if (capability?.efforts !== undefined) return capability.efforts;
  if (modelCfg.reasoningLevels !== undefined) return modelCfg.reasoningLevels;
  return undefined;
}

/**
 * 档位 → 协议值，按这个模型**真实接受**的集合解析。
 *
 * - 有 `acceptedEfforts` 时：取「秩 ≤ 该档的秩」的最高者；一个都没有 → `null`
 *   （这一档不可用，调用方据此不把它画成滑块的一格）。
 * - 没有时（`undefined`）：回落到 `resolveEffortTier`（第三级，既有行为）。
 *
 * 这条规则与 Claude Code 文档的措辞一致：
 * "Claude Code falls back to the highest supported level at or below the one
 * you set."
 *
 * 认不出秩的值（网关可能报出我们不认识的新档位）永远不参与比较：硬把它当成
 * 某个已知档位会伪造出一个并不存在的强弱关系，而它偏偏可能是唯一的候选。
 * 那种值只能通过 `acceptedEfforts` 原样出现在「配置/目录列出的值」一侧，不会被
 * 档位解析选中。
 */
export function resolveTierAgainst(
  modelCfg: ModelCfg,
  tier: EffortTier,
  capability?: ModelCapability,
): string | null {
  if (!isEffortTier(tier)) {
    throw new TypeError(`effort tier 非法: ${JSON.stringify(tier)}；${EFFORT_TIER_HINT}`);
  }
  const accepted = acceptedEfforts(modelCfg, capability);
  if (accepted === undefined) return resolveEffortTier(modelCfg, tier);
  const tierRank = TIER_RANK[tier];
  let best: { value: string; rank: number } | undefined;
  for (const value of accepted) {
    const rank = effortRank(value);
    if (rank === undefined || rank > tierRank) continue;
    if (best === undefined || rank > best.rank) best = { value, rank };
  }
  return best?.value ?? null;
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
