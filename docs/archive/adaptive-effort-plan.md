# 自适应思考强度 —— 实施计划（2026-11-09）

> **2026-11-10 日期注记（现状，本文是历史留档）**：本文的两条核心决定都已被后来的
> 用户决定推翻——`auto` 不再占轨道一格（「AUTO删掉」），轨道也不再按解析值去重缩短
> （「永远六格，映射做适配」）。「只剩一档、标签 `Off`」也已改成只剩一档、标签 `Low`。
> 现行契约见 `docs/specs/effort-tiers.md`。原文保留，不改写。

> 用户决定（AskUserQuestion，2026-11-09）：
> 1. 模型完全没声明 `supportsReasoning` → **只剩一档，拖不动**（标签 `Off`）
> 2. `auto` → **成为滑块最左一档**
>
> 前置调研：`.superpowers/sdd/research-effort-ui.md`（13 个工具的事实对照）

## 为什么改

现在的滑块固定六档，与模型真实能力无关。默认映射下 `extra` / `max` / `galaxy`
三档**都发 `high`**，滑块却显示三个不同的名字——这正是要在卡片里补一句声明的
原因。调研的对照事实：Claude Code 明确写「Caps are per model, so switching models
can change which levels are available.」，Codex / Copilot / Cline / opencode 的档位
同样由模型或 provider 决定。

改成自适应之后，**滑块的长度就是能力声明**，那句声明不再需要。

## 契约（宿主 ⇄ 组件）

宿主 `effortChoices` 新增 `stops`：

```js
stops: [
  { value: "auto", label: "Auto", sends: null },      // 不发字段
  { value: "low",  label: "Low",  sends: "low" },
  { value: "medium", label: "Medium", sends: "medium" },
  { value: "high", label: "High", sends: "high" },
]
```

- `value` 是 `setEffort` 接受的字符串（`auto` 或档位键）。
- `sends` 是这条请求实际会发的协议值，`null` 表示完全不发。**它是给人看的**
  （宿主可以据此写提示），组件不读它。
- 规则：
  - `!supportsReasoning(cfg)` → `[{ value: "auto", label: "Off" }]`（一档）
  - 否则 → `auto` + **按 `EFFORT_TIERS` 顺序去重后的 `resolved` 值**，每档的
    `value` 取**该协议值对应的第一个档位键**（例如 `resolved = {low, medium,
    high, high, high, high}` → 三档 `low` / `medium` / `high`）

组件签名改为：

```js
createGalaxyEffort({ mount, stops, value, reducedMotion, tooltip, onChange })
// 返回 { setValue(index, {silent}), getValue(), destroy() }
// effort-change: { index, value, label }
```

`stops` 长度 ≥ 1。长度为 1 时滑块不可拖（键盘、指针、点击全部无效），
`aria-valuemax` 为 0。

## 五层褶皱怎么铺

规格的 `foldReveal(position, level)` 拿 `level` 当位置用。档位不再是 6 个，
所以组件把第 f 层（f = 1..5）映射到位置 `f * (stops.length - 1) / 5`——
五层褶皱仍然均匀铺满整条轨道，只是每层的绝对位置随档位数变。

`foldVisibleCount` 是给六档验收用的，**不跟着改**：它继续按整数位置 0..5 给出
2/4/6/8/12/16，那是规格里的数。组件不再调用它。

## Galaxy 何时出现

`stops` 里存在 `value === "galaxy"` 时才启用 Galaxy 的像素层、放射层与放大。
它就是最后一档且等于 `galaxy` 时生效；否则（例如默认映射下最高档是 `high`）
Galaxy 整套效果不出现——因为那个模型没有比 `high` 更强的请求可发。

## 要删的

- `#effort-note`（声明句）整块删除：它的存在理由是「滑块显示的档位与请求不符」，
  自适应之后这个前提消失。
- `#effort-auto` 按钮删除：`auto` 已经是滑块最左一档。
- `layoutEffortExtras()` 随之简化或删除（`#effort-extras` 里只剩提示文字，
  若提示也空了就连块删除）。
- `effortSends` 那句 hint 保留：它说的是「你拖到 Extra，实际发 high」，
  自适应之后同名同义，这句基本不会出现，但协议值仍可被旧 `run.json` 选中。

## 文件归属

| 任务 | 独占写入 |
|---|---|
| 组件 | `desktop/renderer/galaxy-effort.js`、`desktop/renderer/galaxy-effort.css`、`tests/desktop/galaxy-effort.test.js` |
| 宿主 + 接线（我） | `desktop/host/host.js`、`desktop/renderer/app.js`、`desktop/renderer/index.html`、`desktop/renderer/styles.css`、`desktop/renderer/protocol.js`、`tests/effort-host.test.js`、`tests/desktop/effort-slider.test.js`、`desktop/renderer/galaxy-effort-demo.html`、`tests/desktop/galaxy-effort-demo.test.js` |
