# 页面优化设计稿：厂商预设 + 输入区视觉重画

- 日期：2026-11-04
- 分支：`feat/page-optimization`
- 状态：待评审

## 1. 目标与理由

两件事，共用一个产物。

**第一件：常见厂商一键配置。** 用户要接入 DeepSeek、Kimi、GLM、Qwen、ChatGPT、Gemini、MiniMax 七家；每家都是 OpenAI 兼容协议，但 baseUrl 各不相同且容易填错（是否带 `/v1`、用哪个域名）。目前「模型服务」页要求用户手填名字、baseUrl、密钥、模型名，四步里三步是查文档得来的常量。

**第二件：输入区与模型列表按 BoardUI 的视觉语言重画。** 用户看了 BoardUI 的 Composer Panel，要求「整体照它的视觉语言重画一遍，尤其是模型列表」。语音输入不需要。

为什么两件一起：第二件里模型列表的「厂商栏」只有在多厂商时才有意义；第一件正好提供了多厂商的数据与使用场景。先做第一件，第二件的厂商栏验收时才有真实数据。

**参考来源与边界**：BoardUI 的 Pro 组件源码不公开，能还原的只有它的免费层 `dropdown` / `select` 的 `menu-styles.ts` 与公开文档页渲染出的预览 DOM。本次**只借鉴视觉语法**（圆角层次、行高、选中态、进场动效、栏位排布），不复制任何源码，不引入 React / Tailwind / React Aria。许可证层面：免费层 MIT，Pro 层禁止再分发到公开仓库；本仓库是 PUBLIC，因此不得安装任何 BoardUI 组件。

## 2. 非目标

- **不接 Claude**（用户 2026-11-04 明确：本轮先不接）。Anthropic Messages 协议不在本轮范围，`providers.json` 仍只有 `openai-chat-completions` 一种协议。
- 不做语音输入（BoardUI 有，本项目已于 2026-10-22 整块删除）。
- 不做附件上传（无后端，D-188 仍是已知缺口）。
- 不改内核协议层、不改 `providers.json` schema。厂商预设是渲染层的静态数据。
- 不做独立首启向导（用户已否决）。
- 不引入构建步骤、不引入 UI 框架（既有硬约束）。

## 3. 约束

| 约束 | 出处 |
|---|---|
| 无框架、无打包器、无构建步骤，渲染层是纯 ES 模块 | AGENTS.md 硬约束 1 |
| 圆角只有三档（6 / 10 / 14px），阴影只用于输入框与浮层 | `docs/frontend-design.md` §5.4 |
| 工具必须诚实：不假装成功，不编造数据 | BRD R3 |
| 测试不触网 | AGENTS.md |
| 依赖安装由用户执行，agent 不代跑 | AGENTS.md |
| 前端能力边界以 `desktop/MATRIX.md` 为准 | AGENTS.md 事实源 |

## 4. 备选方案与选择

### 4.1 厂商预设的形态

| 方案 | 取舍 | 结论 |
|---|---|---|
| **顶部厂商卡片** | 复用现有探测与添加流程，不改数据结构；卡片与手填卡片同级 | **已选** |
| 独立首启向导 | 体验更顺，但等于把现有页面再实现一遍，且与「Set up a connection」入口重复 | 否决 |
| 只给 JSON 模板 | 最省事，不解决「简化配置界面」 | 否决 |

### 4.2 预设里预填什么

用户原话是「一键配置 baseurl」，所以 baseUrl 与名字必须预填。模型名是否预填有三个选项：

| 方案 | 取舍 | 结论 |
|---|---|---|
| **只预填名字 + baseUrl**，模型名放进卡片内的「推荐模型」chip 行，点一下才进文件 | 文件里只出现用户确认过的模型；模型名变动不会让已保存的配置指向死条目 | **已选** |
| 预填模型名进卡片 | 点一下就有完整配置，但官方文档的模型名会随版本退役，写进文件就是一条可能失效的断言 | 否决 |
| 什么都不给，只留空行 | 诚实但没帮上忙：用户还得先查模型名才能点测试 | 否决 |

「推荐模型」chip 复用测试结果里已有的 `conn-model-chip` 组件与 `markChipAdded` 状态，不新建组件。

### 4.3 视觉重画的路线

只有一条：同一棵 DOM 树换样式与排布。换成别的做法（重写 DOM、换组件模型）会把现有键盘导航、`aria-activedescendant`、复选框语义全部重做一遍，收益为零。**不再列为选择项。**

### 4.4 顺序

先预设、后视觉（用户已选）。

## 5. 第一部分：厂商预设与配置简化

### 5.1 预设数据

新建 `desktop/renderer/provider-presets.js`，纯数据 + 纯函数，不碰 `document`，可在 Node 里直接测试。

```js
export const PROVIDER_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    mark: "DS",                      // 两字母字标，界面不引入厂商 logo 资源
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    note: { zh: "…", en: "…" },      // 可选的补充说明，例如 Qwen 的工作区地址
    docsUrl: "https://api-docs.deepseek.com/zh-cn/",
  },
  // …
];
```

七家的值（**均为 2026-11-04 从官方文档或端点实测核实**，不是凭记忆写入）：

| id | label | baseUrl | models | 核实方式 |
|---|---|---|---|---|
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `deepseek-flash`、`deepseek-v4-pro` | 官方文档「首次调用 API」与「模型 & 价格」页 |
| `kimi` | Kimi | `https://api.moonshot.cn/v1` | `kimi-k3.1-pro`、`kimi-k3`、`kimi-k2.6`、`kimi-k2.7-code` | 官方文档代码示例 |
| `glm` | GLM | `https://open.bigmodel.cn/api/paas/v4` | `GLM-5.3`、`GLM-5.2`、`GLM-5.3-Flash`、`GLM-4.7` | 官方「OpenAI API 兼容」页示例；`/models` 实测 401 |
| `qwen` | Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.8-max`、`qwen3.7-plus`、`qwen3.8-flash` | 官方兼容模式文档；`/models` 实测 401 |
| `minimax` | MiniMax | `https://api.minimax.cn/v1` | `MiniMax-M3.1-Flash`、`MiniMax-M3` | 官方文档 `OPENAI_BASE_URL` 示例；`/models` 实测 401 |
| `openai` | OpenAI | `https://api.openai.com/v1` | （不预置，见下） | 端点实测 401 |
| `gemini` | Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` | 官方 OpenAI 兼容文档 |

**核实记录（供审阅者复查，不必重新验证）**：2026-11-04 当天，用 curl 直连或经本机 `127.0.0.1:7890` 代理读取官方文档原文；DeepSeek / Kimi / GLM / Qwen / MiniMax 五家的 `/models` 端点另外实测，均返回 401（端点存在、协议正确）。OpenAI 文档站从本机返回 403，Gemini 与 OpenAI 域名直连不通，两者只核实到 `/v1/models` 与 OpenAI 兼容端点存活。

**baseUrl 的书写规则**：内核用 `pathname.replace(/\/+$/, "") + "/chat/completions"` 拼接（`src/model/openai.ts:151-153`，探测层 `src/model/probe.ts:62-66` 同口径）。因此预设里**一律不写尾部斜杠**，且必须自带版本段（`/v1`、`/v4`、`/compatible-mode/v1`、`/v1beta/openai`）；DeepSeek 官方地址本身不带 `/v1`，照官方写。写错版本段会得到一个 404，界面会把它归咎于用户的密钥——这正是预设要防止的错误。

**模型名写错时的恢复路径**：卡片里的模型行是可编辑的文本输入，「推荐模型」chip 只是把名字填进去，不是锁定的下拉。测试连接若因模型名被拒，错误文案来自内核 `probeProvider`（会带上端点的原始状态码），用户可当场改名。预设不追求「永远正确」，追求「错了好改且看得出错在哪」。

**OpenAI 不预置模型名**：官方文档站从本机不可达（`platform.openai.com` 返回 403，直连超时），能核实的只有 `/v1/models` 端点存活（401）。不预置名字，卡片里只显示名字 + baseUrl，模型由测试结果列出。这是 R3：没核实过的东西不进预设表。

**GLM 的模型 id 大小写**：官网模型页标题是 `GLM-5.3`，接口示例里的 `model` 字段大小写未在文档中统一。预设按官网标题写；若请求返回「模型不存在」，用户可在卡片里改。这一点写进 `note`。

**Qwen 的地址**：官方文档现在主推按工作区的 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，经典 dashscope 地址仍然有效且不需要工作区 id。预设用经典地址，`note` 里说明另一种写法。

### 5.2 界面

「模型服务」页（`connection`）顶部、`setupHint` 之下，加一组厂商卡片：

```
┌─ 快速添加 ────────────────────────────────┐
│  DS     KM     GLM    QW     MM     AI   │
│ DeepSeek Kimi   GLM   Qwen  MiniMax OpenAI│
└───────────────────────────────────────────┘
```

- 已配置的厂商（同名卡片存在）显示为已添加态，点击聚焦到那张卡片而不是新建。
- 点击未配置的厂商 → 新建一张卡：`name` 用预设 id、`baseUrl` 用预设值、模型列表留一行空行、卡片自动展开、焦点落在密钥输入框。卡片内多一行「推荐模型」chip（若该预设带 `models`）。
- 厂商卡片区在搜索时也参与过滤：`dataset.search` 写「厂商名 + baseUrl 关键词」。
- **`mark` 不写进预设数据**，改由纯函数 `providerMark(name)` 从卡片名现算：取名字里的字母数字，首两字符大写；不足两字符时补齐为单字符加 `·`；完全取不出时回退到 `?`。理由：厂商栏列的是 `providers.json` 里的 provider，手写的 `my-gateway`、改名后的 `deepseek2` 都不在预设表里；把字标写死在预设里，就意味着这些真实存在的 provider 没有字标可显示。预设表因此只留 `id / label / baseUrl / models / note / docsUrl`。

### 5.3 已选定的实现决定

- **预设是渲染层数据，不进内核**。内核的 `ProviderConfigSchema` 不变。理由：只有一个前端，没必要为一份常量加一层协议。
- **名字冲突**：预设 id 已被占用时（用户手建过 `deepseek` 卡片），点厂商卡片不新建，聚焦已有卡片。否则保存时会出现两张同名卡。
- **不自动发探测**：点厂商卡片只是填表，不自动调用 `testProvider`。用户还没填密钥，自动探测只会得到一条 401 并让人以为配置错了。
- **保存路径不变**：仍是整份 `saveProviders`。

## 6. 第二部分：输入区与模型列表的视觉重画

### 6.1 视觉语法的映射

BoardUI 的值 → 本项目令牌。**不新增令牌，不改三档圆角**：

| BoardUI | 本项目 | 说明 |
|---|---|---|
| 面板 `rounded-2xl` 16px、`p-2.5` 10px | `--radius-lg` 14px、`padding: 10px` | 三档圆角不破 |
| 菜单行 `rounded-2lg` 10px、行间 `gap-1` 4px | `--radius` 10px、`gap: 4px` | |
| 选中行 = 中性悬停面 + 勾 | `--surface-hover` + 勾 | 现在用的是 `--accent-soft`；改为中性面，accent 只留给焦点环 |
| 进场 150ms `fade + scale-95 + blur(2px)`，原点朝触发方向 | 同参数，`--normal` 170ms 改为 150ms 仅用于菜单 | 新动效只作用于菜单与输入卡片，不改全局令牌 |
| 输入卡片 `rounded-3xl` 24px、控件行与文本框间距 20px | `--radius-lg`、间距 10px | 我们的输入框是多行自增高，20px 会把底栏顶太高 |
| 圆形按钮 36px（加号 / 发送） | 加号 28px、发送 32px | 底栏总高受 `composer-bar` 限制，36px 会让两行结构变三行 |
| 模型条 32px 高、`rounded-xl` 12px | `--radius-sm` 6px → 改为 8px 仅用于模型条 | 12px 与 10px 的行圆角同屏会糊 |

**不做**：语音按钮、附件按钮（无后端）、`Learn more` 链接、BoardUI 的 24 色 accent 体系。

### 6.2 输入区结构

保持现有 DOM 层级不变（`#composer-region > .composer > .composer-input-row + .composer-bar`），改的是样式与两处位置：

1. **状态页签**（新）：`.composer` 的**兄弟节点**，插在 `.composer` 之前、`#plan-strip` 与 `#pending-permission` 之后。定位用与 `.composer` 完全相同的 `max-width: var(--column-width); margin: 0 auto`——`.composer-region` 自己的 `padding: 0 28px 16px` 已经负责左右留白，页签再写 28px 会缩进两次。高 30px，`border-radius: var(--radius-lg) var(--radius-lg) 0 0`，无下边框，视觉上与卡片连成一体。
   - 内容：分支 · 工作目录名 · 上下文百分比（圆环 + 数字）。
   - 三者任一缺失就不显示那一段：没有 git 分支时不写「unknown」（R3）。
   - **不与计划条、审批条互斥**：页签是卡片的上沿，计划条与审批条排在它上面。DOM 顺序为 `pending-permission` → `plan-strip` → 状态页签 → `.composer`。页签始终可见——它是上下文详情的唯一入口，而计划运行中恰恰是最想看一眼占用的时刻，藏起来等于在最需要时拿走了它。
2. **底栏控件**：加号（保持隐藏，无后端）→ 模式 → 模型 → 发送。上下文 chip 从底栏移除（并入页签）。

#### 分支段：本构建里没有数据源

必须说清，否则实现者会去找一个不存在的事实来源：

- `state.git` 恒为 `null`。`git_status` 在整个仓库里只出现一次——`desktop/renderer/app.js:3049` 的一个 `case`；宿主没有 `gitStatus` handler，`src/` 没有 git 模块。`desktop/MATRIX.md` 把 git 记在**已隐藏**。
- 因此 `#topbar-cwd-branch` 一直是隐藏的（`app.js:7188-7191` 的 `state.git?.available` 判据恒假）。**删掉这个节点不是功能删除，是删掉一个从未亮过的空壳**；顶栏因此只留工作目录名。
- 状态页签里的分支段保留**同一个判据**（`state.git?.available && state.git.branch`），作为潜伏槽位：今天不显示，将来宿主接上 git 就自动亮。不新增 git 数据源——那是内核/宿主的能力决策，不在本设计范围内。页签今天实际显示的是「工作目录名 · 上下文百分比」两段。

#### 上下文详情弹层：完整保留

`#usage-popover` 的内容**一项不减**，只把触发点从底栏 chip 换到状态页签的百分比按钮：

| 保留项 | 说明 |
|---|---|
| 分段条 `#usage-stack` | 按类别着色，宽度即占比 |
| 分类明细 `#usage-breakdown` | 图例与各项数值 |
| 输入 / 缓存 / 输出三格 | `#usage-input-value` 等 |
| 本会话合计 | `#usage-total-value` |
| 会话成本 | `#usage-cost-value`，仅在配置了价格时出现（未定价 ≠ 成本 0） |
| 重置计数器 | `#usage-reset` |

按钮的 `aria-haspopup="dialog"`、`aria-expanded`、点击外部关闭、Escape 关闭全部保持。百分比未测量时（`protocol.measuredContext()` 返回 `null`）不显示数字，**但页签仍渲染**，此时点击弹层显示「尚未测量」而不是 0%——原因是取消触发点的做法会让弹层在会话头几轮彻底不可达，而它正是那段时期最该能打开的东西。

### 6.3 模型列表

```
┌──────────────────────────────────────────┐
│ DS │  Models                    / 搜索    │
│ KM │  ✓ Fable 5.1          [ Medium ▾ ]  │
│ GLM│    Anthropic · 1M · 推理             │
│ QW │    GPT-5.6                          │
│ MM │    OpenAI · 400K                    │
│    │    DeepSeek V4                      │
│    │    DeepSeek · 128K                  │
│    │    ──────────────────               │
│    │    刷新模型                          │
└──────────────────────────────────────────┘
```

- **左栏（厂商栏）**只在 `modelGroups().length > 1` 时出现，宽 44px，每项是一个两字母字标方块，24px，字标由 `providerMark(provider)` 现算（见 §5.2），不用预设里的固定值。选中项用 `--surface-hover` 底 + accent 左边条。点击切换右栏显示的厂商，不改变已选模型。
- **右栏表头**：`Models` 标题；模型数 > `MODEL_FILTER_THRESHOLD` 时变成过滤输入框（沿用现有逻辑与 `aria-activedescendant`）。
- **行**：主行模型名，次行 `厂商 · 上下文 · 能力`。选中行左侧有勾，底色用 `--surface-hover`。
- **面板宽度** 341px（BoardUI 值），比现在的 320px 略宽，好容纳左栏。

#### 推理档：留在底栏，不进模型行

原方案打算把推理档 chip 从底栏移进选中模型那一行。**放弃这个方案**，理由是它与现有键盘契约冲突，而这些冲突没有一个是无代价能解决的：

- **弹层套弹层**。模型面板本身是浮层，档位菜单也是浮层。`Escape` 现在关闭模型面板（`app.js:2678-2683`）；套上第二层后必须定义「先关哪个」，而 `handleModelMenuKey` 对 `Tab` 的处理是「当作关闭」（`app.js:2684-2689`）——行内出现可聚焦按钮后，`Tab` 要么够不到它（与「Tab 关闭」矛盾），要么被吞掉。
- **`Ctrl+E` 全局循环档位**（`app.js:6027-6043`，快捷键表里列着）。控件搬进只在菜单打开时存在的行里，`Ctrl+E` 就没有一个常驻的显示位置可以更新——用户按了快捷键看不到任何反馈。
- **`effortChoices` 是「当前选中模型」的单一事实**（`desktop/host/host.js:754-769`）。只有选中行需要它这一点与原判据一致，但这意味着档位控件的可见性依赖菜单打开状态，比现在多一个状态维度。

所以：**底栏顺序保持「模式 → 模型 → 推理档 → 发送」**，`#effort-control` 与 `#effort-menu` 的 DOM、定位、`syncEffortControl()` 判据、`Ctrl+E` 行为全部不变。模型行右侧不出现档位按钮。

代价是模型面板里看不到档位；接受，因为档位是「这一轮怎么跑」而不是「选哪个模型」的属性，它在底栏本来就与模型 chip 相邻。

- **语义不变**：`role="listbox"`、`role="option"`、`aria-selected`、`aria-activedescendant`、Arrow / Home / End / Enter / Tab / Escape 全部保持现有行为。左栏是 `role="tablist"`，上下键不改，左右键切换厂商。

### 6.4 已选定的实现决定

- **不新增设计令牌**：三档圆角与两条阴影不变；颜色只用既有语义 token。
- **不引入厂商 logo 图片**：用两字母字标。理由是 7 家要 7 个 SVG 资源、还要跟主题适配，而字标在 24px 方块里比 logo 更可读。
- **推理档留在底栏**：不做嵌套浮层，`Ctrl+E` 保有常驻的显示位置。这是对原方案的一次自我否决，理由见 §6.3。
- **状态页签与顶栏的分工**：顶栏是「我在哪个目录」，页签是「这一轮在什么上下文中」。分支只放页签一处，顶栏那个从未亮过的空壳删掉。
- **上下文详情整体保留**：`#usage-popover` 的 DOM 与所有条目都不动，只换触发点。这次重画的是它外面的入口，不是它本身。分段条、分类明细、三格用量、会话合计、会话成本、重置按钮六项缺一不可。
- **不接 git 数据源**：分支段是潜伏槽位，判据照抄 `state.git?.available`。接 git 是另一个能力决策，见 §6.2。

## 7. 验收口径

第一部分：

- 七个厂商卡片全部可见；点击未配置的厂商后，卡片里 `name` 与 `baseUrl` 已填好且卡片展开、焦点在密钥框。
- 点击已配置的厂商不新建卡片，聚焦已有卡片。
- 保存后刷新页面，配置仍在。
- 推荐模型 chip 点一下才进模型列表；保存前后的模型数一致。

第二部分：

- 输入区、模型面板、状态页签在深色 / 浅色 / 高对比三套主题下都可用（对比度达到现有的 AA 口径）。
- 模型列表：单厂商时无左栏；多厂商时左栏可点、可左右键切换；筛选、方向键、Enter、Tab、Escape、焦点回归 chip 全部照旧。
- 推理档仍在底栏，`Ctrl+E` 循环后底栏 chip 立即更新。
- 状态页签：无分支时不显示分支段；上下文未测量时不显示百分比（不是 0%），但页签本身仍在、仍可点开。
- 上下文详情弹层：分段条、分类明细、输入 / 缓存 / 输出三格、会话合计、会话成本（配置了价格时才出现）、重置按钮六项全部在，点击与 Escape 关闭行为不变。
- `npm test`、`npm run typecheck`、`npm run test:desktop` 全绿。

## 8. 留给实现者的判断

- 厂商字标的具体字号与字重（`providerMark` 的返回形状已定，视觉参数未定）。
- 状态页签里圆环的半径与描边宽度。
- 动效的具体缓动曲线（沿用 `--ease`）。
- 是否为厂商栏加 `title` 提示（建议加，左栏只有字标）。
- 厂商卡片在图示之外是否显示 baseUrl 文本（建议显示，用户才看得出预设是不是他要的那个端点）。
