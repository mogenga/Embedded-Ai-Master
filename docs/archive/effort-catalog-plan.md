# 推理强度：在线能力目录 + 三级回退 —— 实施计划（2026-11-09）

> **2026-11-10 日期注记（现状，本文是历史留档）**：三级回退本身已落地且仍是现行规则；
> 但本文里「按去重后的档位数决定轨道长度」的描述已被同日决定推翻——轨道固定六格，每格
> 如实标出实际会发的值。现行契约见 `docs/specs/effort-tiers.md`。原文保留。
>
> 用户决定：「直接按三级回退改内核，发子代理。保留当前设定的六档，还是走映射」
>
> 即：**六档仍是界面词汇**（Low / Medium / High / Extra / Max / Galaxy），
> 每档通过映射解析成该模型真正接受的值；不把网关的原始档位名直接画到界面上。

## 起因（实测，2026-11-09）

`GET /v1/models` 在用户这台网关上**报告每个模型的推理能力**：

```jsonc
{ "id": "space-bunny",
  "supports_reasoning": true,
  "reasoning_efforts": ["low","medium","high","xhigh","max"],
  "reasoning_default_effort": "max",
  "reasoning_can_disable": false }
{ "id": "glm-5.1",
  "reasoning_fixed_effort": "medium" }        // 锁死在一档
```

21 个模型全部带这些字段。而 `src/config/providers.ts:89` 的注释写着
「OpenAI 兼容协议的 `GET /v1/models` 不报告这项能力」——**在标准协议上成立，
在这个网关上不成立**。我们从来没读过它，所以只能靠用户在 `providers.json` 里
手工声明一个布尔。

对照调研（`.superpowers/sdd/research-effort-ui.md`）：Claude Code 维护逐模型
档位表、Codex 读模型目录的 `default_reasoning_level`、Zed 由 provider 下发
`supported_effort_levels`、opencode 每个 provider 内置一套集合——**没有一家
靠"猜"**。它们都有一张能力表，我们缺的正是这一层。

## 核心设计：档位是词汇，映射是语义

### 一张全局强度序

```
none(0) < minimal(1) < low(2) < medium(3) < high(4) < xhigh(5) < max(6) < ultra(7)
```

这是**协议值的强度序**，不是界面档位。档位到它的映射：

| 界面档位 | 语义秩 |
|---|---|
| `low` | 2 |
| `medium` | 3 |
| `high` | 4 |
| `extra` | 5 |
| `max` | 6 |
| `galaxy` | 7 |

### 解析规则（每条请求/每个档位）

给定模型**接受的协议值集合** `accepted`（有序，按上面的强渡序排好）：

```
resolve(tier) = accepted 中秩 ≤ tierRank 的最高者
                没有 → 这一档不可用（null）
```

例：`accepted = {high(4), xhigh(5)}`（glm-5.2）

| 档位 | 秩 | 解析结果 |
|---|---|---|
| low | 2 | **不可用**（没有 ≤ 2 的） |
| medium | 3 | **不可用** |
| high | 4 | `high` |
| extra | 5 | `xhigh` |
| max | 6 | `xhigh` |
| galaxy | 7 | `xhigh` |

去重后界面上是 `High` / `Extra` 两档 —— 因为 `xhigh` 只能从 `extra` 开始选。

例：`accepted = {low,medium,high,xhigh,max}`（space-bunny）

| 档位 | 解析结果 |
|---|---|
| low | `low` |
| medium | `medium` |
| high | `high` |
| extra | `xhigh` |
| max | `max` |
| galaxy | `max` ← 与 max 重复，去重后不出现 |

界面：`Low / Medium / High / Extra / Max` 五档。

**这条规则与 Claude Code 文档的措辞一致**：
`"Claude Code falls back to the highest supported level at or below the one you set."`

### 三级回退

`accepted` 的来源，从高到低：

1. **网关目录**：`GET /v1/models` 的 `reasoning_efforts`（字段名有别名，见下）
2. **`providers.json`**：模型新增可选字段 `reasoningLevels: string[]`
3. **都没有**：沿用现状 —— `DEFAULT_EFFORT_MAP` 折算六档，去重后通常三档

`reasoning_fixed_effort` / `reasoning_default_effort` 同样按这个顺序取。

**网关报的和配置写的冲突时**：网关优先。理由——网关是**执行方**，它的表决定
请求会不会被接受；配置是**用户的猜测**，猜错只会得到一个 400。

### 与 `supportsReasoning` / `effortMap` 的关系

- `supportsReasoning: false`（显式否定）**仍然最优先**：用户说这个模型不吃参数，
  那是更强的断言，不再去看目录。
- `effortMap` 保留，但语义收窄：**只在没有 `accepted` 时生效**（第三级）。
  有 `accepted` 时映射由语义秩算出来，`effortMap` 不再参与——两套映射同时生效
  会得到两个答案。
  - 这条要写进 `providers.json` 的注释与 `docs/specs/effort-tiers.md`。

## 内核改动

### 1. 新文件 `src/model/catalog.ts`

```ts
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

export function parseCatalogEntry(entry: unknown): ModelCapability | undefined
export function extractCatalog(payload: unknown): Map<string, ModelCapability> | undefined
```

**字段名别名**（不同网关各写各的，全部按"有就用"处理）：

| 语义 | 别名（依次尝试） |
|---|---|
| 可用档位 | `reasoning_efforts` / `supported_effort_levels` / `reasoning_levels` / `efforts` |
| 默认档 | `reasoning_default_effort` / `default_reasoning_level` / `default_effort` |
| 锁死档 | `reasoning_fixed_effort` / `fixed_reasoning_effort` |
| 可关闭 | `reasoning_can_disable` / `can_disable_reasoning` |

数组元素可以是字符串，也可以是 `{ effort, description }` 形状（Codex 那种）；
后者取 `effort` 字段。**认不出的形状返回 `undefined`**，不抛错——目录是外部输入。

### 2. `src/config/providers.ts`

- `REASONING_EFFORTS` **保持五个安全值不动**（它是"没有目录时能安全发出去的
  白名单"）。新增：

  ```ts
  /** 网关目录可能报出的、超出上面白名单的已知值。只在目录明确报出时才可发。 */
  export const EXTENDED_EFFORTS = ["xhigh", "max", "ultra", "persistent"] as const;
  /** 全序，用于按语义秩解析。 */
  export const EFFORT_RANK = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7, persistent: 7 } as const;
  export function effortRank(value: string): number | undefined
  ```

- `ModelConfigSchema` 新增：

  ```ts
  reasoningLevels: z.array(z.string()).optional(),
  ```

  校验：元素必须在 `REASONING_EFFORTS ∪ EXTENDED_EFFORTS` 里（未知值拒绝，
  报错列出合法值）。**空数组**等于"这个模型没有可选档位"，是合法输入。

- 新增解析函数：

  ```ts
  /**
   * 这个模型真正接受的协议值。
   * 优先级：显式否定 → 网关目录 → providers.json → undefined。
   */
  export function acceptedEfforts(
    modelCfg: ModelCfg,
    capability?: ModelCapability,
  ): string[] | undefined

  /**
   * 档位 → 协议值。有 accepted 时按语义秩取"≤ 该档的最高者"，
   * 那一档不可用时返回 null（调用方据此不把它画成滑块的一格）。
   */
  export function resolveTierAgainst(
    modelCfg: ModelCfg,
    tier: EffortTier,
    capability?: ModelCapability,
  ): string | null
  ```

  **`resolveEffortTier` 保持原签名与行为**（第三级回退要用它，且有既有测试）。
  `resolveTierAgainst` 是新的、按能力解析的版本。

- `ReasoningEffortScheme`：内核发出去的值现在可能是 `xhigh` 之类。保留现有
  `ReasoningEffortSchema` 用于"用户配置里的安全值"，另加一个更宽的
  `z.string()` 用于目录来的值——**在发请求前**用一个校验函数确认它来自
  `accepted`，而不是凭空相信目录。

### 3. `src/model/openai.ts`

`cfg.reasoningEffort` 的类型仍是 `ReasoningEffort`。为了让扩展值能上线，
改成 `string | undefined`，并加一条注释说明"值的合法性在解析层（`acceptedEfforts`）
已经确认过，适配层不做第二次判断"。

**这条要给 reviewer 重点看**：适配层的角色是"原样发送"，它不该是白名单的第二个
owner。

## 宿主改动（主控做，不派给子代理）

- `desktop/host/host.js`：init 时后台拉一次目录（2s 超时、失败静默），缓存到
  `$HARNESS_HOME/model-catalog.json`（带 `fetchedAt`，TTL 24h）。
  目录到达后补发一次 `state`。
- `effortChoices()` 改用 `resolveTierAgainst` 生成 `stops`。
- `setEffort` 的接受集合改成「`accepted` ∪ 档位键 ∪ 旧协议值」。

## 约束（子代理 brief 必须原样带上）

- **禁止任何依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。
- **禁止在宿主机真实执行危险命令做测试**。
- **不得执行任何 git 写操作**。
- **写文件只用 Write/Edit 工具**，禁止 `node -e` / `bash -c` 拼含反引号、`$()`、`${}` 的文本。
- 不得修改 `docs/**`、`AGENTS.md`、`dev-notes/**`、`desktop/**`、`vitest.config.ts`、`package.json`。
- 不得调大测试超时，不得删改既有断言（可以新增）。
- **不得触网**：所有目录测试用固定 payload 夹具，不请求真实网关。
