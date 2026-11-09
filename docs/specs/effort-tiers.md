# 思考强度：六档界面语言与逐模型映射

> **本文是六档思考强度的唯一契约源。**
> 实现：
> [`src/config/providers.ts`](../../src/config/providers.ts)（`EFFORT_TIERS` / `DEFAULT_EFFORT_MAP` /
> `resolveEffortTier` / `ModelCfg.effortMap`）、
> [`src/config/app-config.ts`](../../src/config/app-config.ts)（`run.json` 的 `reasoningEffortByModel`
> 同时接受协议值与档位）、
> [`src/index.ts`](../../src/index.ts)（`runSession` 启动时按模型折算）、
> [`desktop/host/host.js`](../../desktop/host/host.js)（`effortChoices` / `setEffort`）、
> [`desktop/renderer/effort-tiers.js`](../../desktop/renderer/effort-tiers.js)（渲染层同一份档位常量）、
> [`desktop/renderer/app.js`](../../desktop/renderer/app.js)（`renderEffortPanel` / `commitEffort`）。
> 改实现要同步改本文；改本文要同步改 `desktop/MATRIX.md` 的 `setEffort` 行。

## 一句话

**六档是界面语言，协议值才是发出去的东西。** 用户看到 Low / Medium / High / Extra / Max /
Galaxy 六个停止点；每个模型有一张映射表，把它折成 `none` / `minimal` / `low` / `medium` /
`high` 之一。请求体里永远不会出现 `galaxy`。

```
用户看到的：  Low   Medium   High   Extra   Max   Galaxy     ← 六档，全局统一
                │      │       │      │      │      │
                ▼      ▼       ▼      ▼      ▼      ▼         ← 每模型一张表（providers.json）
内核发出去的： low   medium   high   high   high   high       ← 仍是协议白名单里的值
```

动机是「模块内置的思考强度不统一」。三种网关各叫各的档位，逐家适配会得到一个到处是
`if (provider === ...)` 的适配层；做一层映射，界面就只有一套词汇，差异全落在配置里。

## 六档

| 档位 | 键 | 界面名 | 缺省协议值 |
|---|---|---|---|
| 1 | `low` | `Low` | `low` |
| 2 | `medium` | `Medium` | `medium` |
| 3 | `high` | `High` | `high` |
| 4 | `extra` | `Extra` | `high` |
| 5 | `max` | `Max` | `high` |
| 6 | `galaxy` | `Galaxy` | `high` |

顺序即轨道顺序，是契约：`desktop/renderer/index.html` 的六个 `data-tier-index` 与滑块的
`max="5"` 都按它排。

**界面名只有英文，不翻译**（2026-11-09，用户原话「思考强度用英文，不用自动翻译」）。
六个名字在 `desktop/renderer/i18n.js` 的 `effortTierLow` … `effortTierGalaxy`，**中英两套
字典逐字相同**——`tests/desktop/effort-slider.test.js` 钉着这一点，并且断言这些值里不出现
中日韩字符。理由不是省事：同一个档位在规格表、`run.json` 的存档值、`providers.json` 的
`effortMap` 键和界面标签里必须只有一个名字；以前 zh 字典里有一套中文名（低 / 中 / 高 /
加强 / 极强 / 星系），于是同一档在四个地方有四个说法。`auto` 与面板标题 `Thinking` 同理。

**`auto` 不是第七档。** 它是「不提要求」的哨兵：`run.json` 里删掉该模型的条目，请求体里
完全不出现 `reasoning_effort`。缺席（不提要求，用服务商默认）与 `none`（明确关闭推理）
是两件事，两种都要能表达。

## 缺省映射表与逐模型覆盖

不配 `effortMap` 的模型走 `DEFAULT_EFFORT_MAP`（上表最后一列）——六档退化成三个有效值，
但仍能用。要改，就在 `providers.json` 里给那个模型写一张**逐档可选**的表：

```json
{
  "gw": {
    "protocol": "openai-chat-completions",
    "baseUrl": "https://api.example.com/v1",
    "models": {
      "flash": {
        "supportsReasoning": true,
        "effortMap": { "extra": "medium", "galaxy": "high" }
      }
    }
  }
}
```

规则：

- **没写的档回落缺省表**，不是 `undefined`。所以只想改一档就只写一档。
- **值必须仍是协议值**（`none` / `minimal` / `low` / `medium` / `high`）。写 `"galaxy": "galaxy"`
  会被 schema 拒绝——值里出现档位名说明配置写反了。
- 未知档位键（`turbo`）被拒绝，报错文案列出合法档位（R3）。
- `effortMap` 只在这里手写，**设置页不编辑它**；设置页保存时把它原样带出去
  （`carriedFromModel` 的透传名单），不会因为点一次「保存」被抹掉。

宿主在 `state.effortChoices.resolved` 里回报**每个档位这一模型实际会发的值**，界面据此
显示「Galaxy → high」，不必让人去读配置文件。折算的唯一实现是内核的 `resolveEffortTier`，
宿主只转述它的答案。

## 为什么 `extra` / `max` / `galaxy` 默认都落到 `high`

因为多数模型只有 3–5 个真实档位，而界面有六个停止点。硬凑六个不同的协议值只有两条路，
两条都是说谎：

1. **发一个协议里不存在的值**（`xhigh`、`max` 这类网关私有档）。OpenAI 兼容协议不保证
   认识它——不支持时轻则 400，重则被静默忽略，而界面已经显示「已设为 Max」。
2. **假装某档比 `high` 更强**，实际发同一个 `high`。这与第 1 条的区别只是没被网关拒绝。

所以选第一条之外的东西：**承认后三档在缺省情况下是同一个请求**。档位是人用的表达
（「我要它更用功一点」），不是必须六个不同的协议值。界面通过 `resolved` 把这件事说
明白；想要真正区分，就在那个模型的 `effortMap` 里给 `extra` / `max` / `galaxy` 各自写
不同的值——前提是确认过那家网关收得下。

## 为什么内核不扩展协议白名单

`REASONING_EFFORTS`（`src/config/providers.ts`）是「能安全发出去的值」的白名单，不是
界面选项表。它只有五个值，因为协议只保证这五个。往这个白名单里加 `max` / `galaxy` 会让
适配层不再拒绝它不认识的档位，代价是：

- 适配层的构造期校验（`createOpenAIProvider`）就失去意义——它存在的理由正是「内核不认识
  的值不发出去，错误立刻落在调用栈上，且不产生任何出站请求」；
- 界面上「已生效」与实际请求之间的差距重新出现，而这正是这个功能要修的谎。

六档因此被定义在**白名单之外**：它们只存在于 `EFFORT_TIERS`（界面词汇）和
`resolveEffortTier`（折算函数）。`runSession` 用 `isEffortTier` 判别走哪条路——
档位先折算，协议值原样交给适配层。`low` / `medium` / `high` 同属两边，走哪条都一样。

## 数据怎么流

| 环节 | 存什么 | 谁负责 |
|---|---|---|
| 点击滑块 | 档位名（`"galaxy"`），原样 | `desktop/renderer/app.js` 的 `commitEffort` |
| `run.json` | 档位名或协议值，**原样存，不提前折算** | `src/config/app-config.ts` 的 `reasoningEffortByModel` |
| 下一次启动 / 下一次运行 | 按**当时**的 `effortMap` 折算成协议值 | `src/index.ts` 的 `runSession` |
| 请求体 | 只能是 `REASONING_EFFORTS` 里的值 | `src/model/openai.ts` |

**`run.json` 里存档位名而不是折算后的值**，是为了让映射表可改：存了 `high` 之后，再改
`effortMap` 也回不到新映射，那条记录永远钉在旧值上。

`setEffort` 的接受集合是**六档 ∪ 五个协议值**。协议值仍收，因为旧构建写进 `run.json`
的值可能是 `minimal`——它没有对应档位，但内核确实发得出去，拒绝它等于让一次合法的选择
失效。拒绝时的提示把两套词汇都列出来。

## 已知边界

- **不自动探测模型支持哪些档位。** OpenAI 兼容协议不报告这项能力，`supportsReasoning`
  仍只能由用户在 `providers.json` 里声明（判据见 `src/config/providers.ts`）。
  **但界面始终显示六档滑块**（2026-11-09，用户原话「思考强度应该始终显示」）：
  曾经模型没声明时整块隐藏，现在改为滑块照常显示，另附一句说明「该模型未声明支持，
  请求不会携带该参数」，宿主用 `effortChoices.unsupported` 把这个事实单独标出来。
  区别是：以前用**消失**表达「这个模型收不到」，现在用**说明**表达。
- **档位与实际效果之间没有校准。** 映射表说 `max` 发 `high`，那个 `high` 在具体模型上
  有多「用功」是服务商定义的，内核无法验证。
- **`/compact` 也用同一个选择。** 上下文压缩的摘要调用是同一模型上的真实 completion，
  所以带上同一个等级（在宿主里按同一个 `resolveEffortTier` 折算）；一个悄悄用别的强度
  跑的压缩会是第二个看不见的设置。
- **旧字典键 `effortLow` / `effortMedium` / `effortHigh` 没有生产者了。** 它们属于旧的
  五值下拉菜单（用协议值当标签），六档滑块改用 `effortTierLow` 等键。保留在字典里是
  为了控制器的删除决定，删不删不影响任何界面。同理，宿主里的 `EFFORT_LEVELS` 现在只
  用于「协议值仍被接受」这一侧，不再是菜单内容。
- **没有独立的历史记录。** `run.json` 只存当前选择，没有「这个会话用过哪几档」的记录。
