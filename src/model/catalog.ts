import { effortRank } from "../config/providers.js";

/**
 * 网关能力目录：`GET /v1/models` 里那些**协议没有规定、但有的网关会报**的
 * 推理能力字段。
 *
 * 这是三级回退的第 1 级（见 `docs/specs/effort-tiers.md`）：网关是执行方，它
 * 说一个模型接受哪些档位，那就比用户在 `providers.json` 里的猜测更可信。
 *
 * 两条与 `probe.ts` 的 `extractModels` 相同的诚实原则（R3）：
 * - **认不出就是 `undefined`**，不是空集合，也不是异常——目录是外部输入，
 *   网关可能用别的字段名，或干脆没实现这个扩展。「解析失败」与「确实没有
 *   能力」必须可区分，否则第三级回退会被一个空 Map 提前截断。
 * - **不抛错**：一个字段形状不对，只是那一个字段缺席，不牵连整个目录。
 */

/**
 * 一个模型上报的推理能力。
 *
 * 每个字段都可缺席，且缺席就是「目录没说」——与 `providers.json` 的
 * `ModelCfg` 一样，缺省不补默认值：补了就把「没说过」变成一句断言。
 */
export interface ModelCapability {
  /** 这个模型接受的协议值，已按强度序排好、去重。`undefined` = 目录没说。 */
  efforts?: string[];
  /** 服务端声明的默认档。 */
  defaultEffort?: string;
  /** 锁死在某一档（目录用 `reasoning_fixed_effort` 表达）。 */
  fixedEffort?: string;
  /** 能否显式关闭推理。 */
  canDisable?: boolean;
}

/**
 * 字段名别名表：不同网关各写各的，全部按「有就用」处理。
 *
 * 每种语义一张有序别名表，**取第一个能解析出值的**（见 `pick`）。理由是这些
 * 别名说的是同一件事，同时出现时互相矛盾的网关本来就没有可信答案；取顺序里的
 * 第一个至少是确定的、可复现的，而合并会造出一个哪家都没报过的集合。
 */
const EFFORTS_KEYS = [
  "reasoning_efforts",
  "supported_effort_levels",
  "reasoning_levels",
  "efforts",
] as const;

const DEFAULT_EFFORT_KEYS = [
  "reasoning_default_effort",
  "default_reasoning_level",
  "default_effort",
] as const;

const FIXED_EFFORT_KEYS = ["reasoning_fixed_effort", "fixed_reasoning_effort"] as const;

const CAN_DISABLE_KEYS = ["reasoning_can_disable", "can_disable_reasoning"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 数组元素可以是纯字符串，也可以是 `{ effort, description }`（Codex 那种）。
 * 后者只取 `effort`；`effort` 不是字符串就跳过**那一项**，不是整个字段作废。
 */
function effortOfItem(item: unknown): string | undefined {
  if (typeof item === "string") return item === "" ? undefined : item;
  if (!isRecord(item)) return undefined;
  const effort = item.effort;
  return typeof effort === "string" && effort !== "" ? effort : undefined;
}

/**
 * 去重并按强度序排序。
 *
 * 认不出秩的值（网关明天可能报出一个我们不认识的新档位）**不丢弃**，而是按出现
 * 顺序排在末尾：丢弃等于替网关删掉一个它确实接受的值，界面会因此少一格；而
 * 硬塞进秩序里又会伪造一个我们并不理解的强弱关系。返回 `undefined` 仅当输入
 * 不是数组——空数组是「确实一档都没有」，两者不可混同。
 */
function normalizeEfforts(items: unknown): string[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const seen = new Set<string>();
  const ranked: Array<{ value: string; rank: number }> = [];
  const unknown: string[] = [];
  for (const item of items) {
    const value = effortOfItem(item);
    if (value === undefined || seen.has(value)) continue;
    seen.add(value);
    const rank = effortRank(value);
    if (rank === undefined) unknown.push(value);
    else ranked.push({ value, rank });
  }
  return [...ranked.sort((left, right) => left.rank - right.rank).map((entry) => entry.value), ...unknown];
}

/** 别名表取值：第一个**类型对**的键胜出；类型不对的键跳过，继续试下一个。 */
function pick<T>(
  record: Record<string, unknown>,
  keys: readonly string[],
  accept: (value: unknown) => T | undefined,
): T | undefined {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    const value = accept(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * 解析一条目录条目（单个模型）。
 *
 * 返回 `undefined` 的条件是「一条能用的字段都没有」——与 `extractCatalog` 的
 * 「整个 payload 认不出」同一条语义：不把「解析失败」伪装成「没有能力」。
 * 字段里混了别的东西（比如 `description`、`id`）不算认得出，因为那些说明不了
 * 任何推理能力。
 */
export function parseCatalogEntry(entry: unknown): ModelCapability | undefined {
  if (!isRecord(entry)) return undefined;
  const efforts = pick(entry, EFFORTS_KEYS, normalizeEfforts);
  const defaultEffort = pick(entry, DEFAULT_EFFORT_KEYS, stringOf);
  const fixedEffort = pick(entry, FIXED_EFFORT_KEYS, stringOf);
  const canDisable = pick(entry, CAN_DISABLE_KEYS, booleanOf);

  const capability: ModelCapability = {
    ...(efforts === undefined ? {} : { efforts }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(fixedEffort === undefined ? {} : { fixedEffort }),
    ...(canDisable === undefined ? {} : { canDisable }),
  };
  return Object.keys(capability).length === 0 ? undefined : capability;
}

/**
 * 从 `GET /v1/models` 的响应体里取每个模型的能力。
 *
 * 与 `extractModels` 同一形状（`{ data: [{ id, … }] }`），但这里只收**至少
 * 认出过一个能力字段**的条目：一个只有 `id` 的条目说明这个网关没实现该扩展，
 * 把它当成空能力塞进 Map，会让调用方以为「这个模型确实什么都不接受」。
 *
 * `undefined` = 整个 payload 认不出；空 Map = 认得出形状，但没有任何模型报能力。
 */
export function extractCatalog(payload: unknown): Map<string, ModelCapability> | undefined {
  if (!isRecord(payload)) return undefined;
  const data = payload.data;
  if (!Array.isArray(data)) return undefined;
  const catalog = new Map<string, ModelCapability>();
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const id = entry.id;
    if (typeof id !== "string" || id === "") continue;
    const capability = parseCatalogEntry(entry);
    if (capability === undefined) continue;
    catalog.set(id, capability);
  }
  return catalog;
}
