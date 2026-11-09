# 思考强度：六档映射 + 自绘滑块 —— 实施计划（2026-11-09）

> 用户原话：「做思考强度，UI组件用 https://leibox.pantoria.cn/docs/animations/galaxy-effort-slider，
> 模块内置的思考强度不统一，所以我们要做的是映射，而不是适配每一种模型」
>
> 追问后确认三件：
> 1. **自己画一个等价物**（组件是 React 四文件，本仓库前端是纯 ES 模块无框架无打包器，硬约束）
> 2. **六档 = `Low` / `Medium` / `High` / `Extra` / `Max` / `Galaxy`**，映射到各模型自己的强度
> 3. **映射表放 `providers.json`，可配**

## 事实依据（已核对代码，2026-11-09）

| 事实 | 证据 |
|---|---|
| 内核只认 5 个等级：`none` / `minimal` / `low` / `medium` / `high` | `src/config/providers.ts:29` 的 `REASONING_EFFORTS` |
| 注释明确写了「刻意不接受 `max` / `xhigh` 之类的网关私有档位」 | 同上，第 25-28 行 |
| 适配层把 `cfg.reasoningEffort` 原样放进 `requestBody.reasoning_effort` | `src/model/openai.ts:611-612` |
| `supportsReasoning` 的判据是「用户声明过」，不声明按不支持处理 | `src/config/providers.ts:135` |
| UI 现在是下拉菜单（`#effort-control` + `#effort-menu`），选项来自宿主 `effortChoices()` | `desktop/host/host.js:944`、`app.js:2897` |
| 选择按 `provider/model` 存 `run.json` 的 `reasoningEffortByModel`，缺席即 auto | `src/config/app-config.ts` 的 `AppRunLimits` |
| 渲染层是纯 ES 模块、无框架、无打包器、无构建步骤 | `AGENTS.md` 硬约束 |
| 仓库无 jsdom；渲染层测试只能是纯函数断言 + 源码静态断言 | 既有 `tests/desktop/*.test.js` |

## 核心设计：六档是**界面语言**，不是协议值

这一点定下了整个实现形状，先说清楚：

```
用户看到的：Low / Medium / High / Extra / Max / Galaxy     ← 六档，统一
                 │  每模型一张映射表（providers.json）
                 ▼
内核发出去的：none / minimal / low / medium / high         ← 仍是 5 个标准值
```

**不扩展 `REASONING_EFFORTS`。** 理由：那个常量是「协议层能安全发出去的值」的白名单，
而 `max` / `xhigh` 这类是网关私有的，收下一个内核不认识的值只会在某些网关上 400 或被
静默忽略——而界面已经显示「已设为 Max」。六档里 **Extra / Max / Galaxy 三档在多数模型上
会映射到同一个 `high`**，这是刻意的：档位是给人用的表达，不是必须六个不同的协议值。

## 约束（每个任务的 brief 都原样带着）

- **禁止任何依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。需要装东西就停下来报告。
- **禁止在宿主机真实执行危险命令做测试**；任何测试都不得真跑破坏性命令。
- **子代理不得执行任何 git 写操作**（`add` / `commit` / `reset` / `checkout` / `stash` / `switch` / `branch` / `worktree` / `merge`）。只读的 `git status` / `git diff` / `git log` 可以。
- **写文件只用 Write/Edit 工具**，不要用 `node -e` / `bash -c` 拼含反引号、`$()`、`${}` 的文本。
- 不得调大 `vitest.config.ts` 的超时，不得删改既有断言（可以新增）。
- **不得真实调用外部模型网关 / 触网**。
- 不得修改 `docs/BACKLOG.md`、`AGENTS.md`、`dev-notes/`、`docs/archive/**`。
- 渲染层**无框架、无打包器、无构建步骤**：不得引入 React/Vue/Svelte、不得引入 canvas 库、不得引入动画库。只能用原生 DOM + CSS +（如需）Canvas 2D。

---

### Task 1 · 内核：六档与映射表

**目标**：新增一层「界面档位 → 协议值」的解析，配置来自 `providers.json`，内核对外仍只发 5 个标准值。

1. `src/config/providers.ts`：
   - 新增
     ```ts
     /** 界面上的六档，稳定升序。*/
     export const EFFORT_TIERS = ["low", "medium", "high", "extra", "max", "galaxy"] as const;
     export type EffortTier = (typeof EFFORT_TIERS)[number];
     export function isEffortTier(value: unknown): value is EffortTier;
     ```
   - `ModelConfigSchema` 增可选 `effortMap`：
     ```ts
     effortMap: z.record(z.enum(EFFORT_TIERS), ReasoningEffortSchema).optional()
     ```
     语义：这个模型把某一档映射到哪个协议值。**没写的档用默认表补**（见第 2 点）。
   - 新增
     ```ts
     /**
      * 缺省映射：六档 → 5 个标准值。
      * 高出的三档（extra / max / galaxy）默认都落到 `high`——这是刻意的，
      * 见条目的设计说明。用户可以在 providers.json 里逐个覆盖。
      */
     export const DEFAULT_EFFORT_MAP: Record<EffortTier, ReasoningEffort> = {
       low: "low", medium: "medium", high: "high",
       extra: "high", max: "high", galaxy: "high",
     };
     export function resolveEffortTier(modelCfg: ModelCfg, tier: EffortTier): ReasoningEffort;
     ```
   - **语义要点**：`resolveEffortTier` 先用 `modelCfg.effortMap?.[tier]`，缺省回落 `DEFAULT_EFFORT_MAP[tier]`。
     一个模型没配 `effortMap` 也能用，只是六档退化成三档有效值。

2. `src/index.ts` 的 `RunOptions.reasoningEffort` 类型从 `ReasoningEffort` 改为
   `ReasoningEffort | EffortTier`，并在解析处调用 `resolveEffortTier`。**注意**：
   这里要有明确的判别——`"low"` / `"medium"` / `"high"` 同时是两边的成员，不是问题
   （同一个值），但 `"none"` / `"minimal"` 只属于协议值，`"extra"` / `"max"` / `"galaxy"`
   只属于档位。用一个 `isEffortTier` 判别后走映射，否则走原路。

3. `src/server/runner.ts` 的 `ActionInput.effort` 同样接受两者。

**验收**（`tests/effort-tiers.test.ts`）：

| 用例 | 断言 |
|---|---|
| 缺省映射 | 六档分别解析为 `low/medium/high/high/high/high` |
| 逐档覆盖 | `effortMap: { extra: "medium" }` → `extra` 得 `medium`，其余仍走缺省 |
| 全档覆盖 | 六档全覆盖时，缺省表完全不被使用 |
| 非法档位 | `resolveEffortTier` 收到 `"none"`（不是档位）**不该**被静默接受——类型层挡住，运行时也有断言 |
| 配置校验 | `effortMap: { turbo: "high" }`（未知档位名）被 schema 拒绝，错误信息含档位白名单 |
| 配置校验 | `effortMap: { max: "xhigh" }`（未知协议值）被拒绝 |
| 端到端 | `runSession({ reasoningEffort: "galaxy" })` 的请求体里 `reasoning_effort === "high"`；`reasoningEffort: "minimal"` 的请求体是 `"minimal"` |

---

### Task 2 · 自绘六档滑块（无框架、无打包器）

**目标**：一个视觉上对标 Galaxy 的六档滑块，用原生 DOM + CSS + Canvas 2D 实现。

**参考组件的观感**（读其文档描述）：脑形褶皱随档位增加、进入最高档后点亮闪动点阵、
放射粒子与光晕、切换时短促震动。**我们不复刻脑形与像素画**——那是它自己的美术资产；
我们做一个同价位但属于本项目视觉语言的等价物。

**形态**（必须实现）：

1. **六格轨道 + 拖拽滑块**：`<input type="range" min="0" max="5" step="1">` 作为**无障碍底座**
   （键盘、读屏、触摸都由它承担），上面叠一层可视化。**不要**自己实现键盘处理。
2. **档位标签**：`Low / Medium / High / Extra / Max / Galaxy`，当前档高亮。
3. **强度可视化**：随档位递进的点阵密度或光晕强度（CSS 自定义属性 `--tier` 驱动，
   0–5）。最高档（Galaxy）额外加一层缓慢脉动的光晕 + 少量漂浮粒子。
4. **降低动效**：`prefers-reduced-motion: reduce` 时**关掉**粒子和脉动，只留静态强度色阶。
5. **不可用时**：模型未声明 `supportsReasoning` 时整块隐藏并显示原因（沿用现有
   `effortChoices().note` 的措辞），**不要**画一个点了不生效的控件（R3）。

**放在哪**：替换现有的 `#effort-menu` 下拉。位置不变（输入框上方/模型选择器旁），
`#effort-control` 的 id 保留（既有测试引用它）。

**验收**（`tests/desktop/effort-slider.test.js`，纯函数 + 静态断言）：

| 用例 | 断言 |
|---|---|
| 六档常量 | `EFFORT_TIER_LABELS` 六个，顺序与 `EFFORT_TIERS` 一致 |
| 档位 → 索引 / 索引 → 档位 | 纯函数互逆，越界钳位（并断言钳位**有显式说明**而不是静默） |
| range 底座 | `index.html` 里有 `type="range" min="0" max="5" step="1"`，且 `aria-label` 存在 |
| 不自己处理键盘 | 静态断言：没有 `keydown` 处理 `ArrowLeft/Right` 来改档位（交给原生 range） |
| 降低动效 | CSS 里有 `@media (prefers-reduced-motion: reduce)` 且覆盖粒子/脉动 |
| 不支持时不画控件 | 静态：`effortChoices().levels` 为空时 `#effort-control` 不可见 |
| 中文/英文标签 | 两套字典都有六个档位名 |

---

### Task 3 · 宿主接线与文档

1. `desktop/host/host.js` 的 `effortChoices()` 改成返回**六档**（`EFFORT_TIERS`），
   并附带每个档位**实际会发的协议值**（这样界面能显示「Galaxy → high」这类映射结果，
   而不是让人猜）。
2. `setEffort` 的接受集合从 5 个协议值扩展为「六档 ∪ 5 个协议值」。
3. `docs/operations/` 新增一节（写在 `docs/operations/release.md` 之外，新建
   `docs/specs/effort-tiers.md`）：六档是什么、缺省映射表、如何在 `providers.json` 里
   覆盖、为什么 `max`/`galaxy` 默认落到 `high`、为什么内核不扩展协议白名单。
4. `desktop/MATRIX.md` 更新 `setEffort` 一行。

**验收**：`npm run check:docs` / `check:ledgers` 通过；新增 `tests/desktop/effort-host.test.js`
断言宿主返回六档且带映射结果。

---

## 顺序与并发

- **Task 1 → Task 2 → Task 3 串行**：Task 2 依赖 Task 1 的 `EFFORT_TIERS`，Task 3 依赖前两者。
- 子代理只写工作区、不做任何 git 写操作；每个任务由控制器单独提交。

## 明确不做

| 项 | 理由 |
|---|---|
| 引入 React / 组件原文件 | 仓库硬约束：渲染层无框架、无打包器、无构建步骤 |
| 复刻脑形与像素美术 | 那是参考组件的资产，不是我们的视觉语言；等价物取其交互与层级感 |
| 扩展 `REASONING_EFFORTS` 到六个 | 那个白名单是「能安全发出去的值」；`max`/`xhigh` 是网关私有，发出去可能 400 或被静默忽略 |
| 每模型自动探测支持哪些档位 | OpenAI 兼容协议不报告这项能力，只能由用户声明（既有设计） |
| 六档各自一个协议值 | 多数模型只有 3–5 档；硬凑六档会让界面显示的与实际发出的不符 |
