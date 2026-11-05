# Task Brief — 模型列表改为在线获取

仓库：`E:\Project\personal\Embedded-Ai-Master`，分支 `feat/page-optimization`（已存在。**不要建分支、不要 worktree、不要提交、不要 push**）。
界面在 `desktop/renderer/`，纯 ES 模块，**无框架、无打包器、无构建步骤**。

## 用户原话

> 模型列表应该由在线获取，而不是预设

## 先读懂现状，别猜

三条链路都已经存在，你要做的是**把它们接起来**，不是从零发明：

1. **探测已有**：`src/model/probe.ts` 的 `probeProvider()` 会 `GET {baseUrl}/models`，用 `extractModels()`（`probe.ts:120`）解析 `{data:[{id}]}`，成功时返回 `models: string[]`。拿不到时该字段**不存在**（不是空数组）——这是 R3 契约，别改。
2. **宿主已有**：`desktop/host/host.js:3499` 的 `testProvider(payload)` → `handleTestProvider()`（`host.js:2190`）→ 回 `provider_test` 事件，成功时带 `models` + `latencyMs`。
3. **界面已有**：`desktop/renderer/settings.js` 的 `showTestModels()`（约 2393 行）已经把探测到的模型画成可点击的 chip，点一下进模型行。

**所以「在线获取」在技术上是通的**，问题是它被藏在一个叫「测试连接」的按钮后面，而且卡片里还有一整行**预设**模型名（`preset-models` chip 行），两者并存——用户看到的是「预设」在前、「在线」要手动点测试才出现。

## 用户要什么

**模型列表以在线获取为准，预设退场。**

具体判定（按这个做，别再问）：

- **删掉「推荐模型」这一行**（`settings.js` 的 `suggestionRow` / `drawSuggestions` / `presetModelSuggestions` 消费点），以及 `provider-presets.js` 里每家的 `models` 数组和 `presetModelSuggestions()` 函数。
  - **连同测试一起改**：`tests/desktop/provider-presets.test.js` 里 `describe("presetModelSuggestions")` 整组、以及断言 `preset.models` 的三条（第 23–66 行区间）。这些断言的对象消失了，不是让它们变红。
- **把在线拉取做成模型区的主路径**，而不是「测试连接」的副产品：
  - 模型列表标题行右侧加一个**「在线获取」按钮**（i18n 新增键，en + zh 成对）。
  - 点击 → 走**现有的** `testProvider` 命令链路（不要新造命令、不要改宿主、不要改内核），传 `baseUrl` / `apiKey` / `apiKeyEnv`。
  - 结果落到模型区自己的一块状态行：成功显示「已获取 N 个模型」+ chip 列表（复用现有的 `availableModelEntries()` 与 `.conn-model-chip` 样式，**不要新建一套视觉**）；失败按现有四类失败码显示（`invalid_base_url` / `unreachable` / `unauthorized` / `http_error`），带内核原话。
  - 拿不到列表时（`ok` 但无 `models`）如实说「端点可达，但没能列出模型」——用已有的 `connTestOkNoModels`。
- **保留「测试连接」按钮**。它测的是「能不能用」，与「能列出哪些模型」是两件事，合并会丢掉一方的语义。但它成功时**不要再画一份模型 chip 列表**——那份现在归模型区，重复两份是噪音。测试成功只留一行状态（连接正常 · N ms）。
  - 现有 `showTestModels()` 里的 chip 渲染逻辑**搬到**模型区的在线获取结果里，别复制两份。

## 硬性要求

- **不改内核 `src/`、不改宿主 `desktop/host/`、不改 `desktop/main.js`、不改 `preload.cjs`**。`testProvider` 命令已经够用；如果你发现不够，**停下来写进报告**，不要自己扩协议。
- **不改 `providers.json` 形状**、不改 `prometheus.providerMeta` 键。
- 只动：`desktop/renderer/settings.js`、`desktop/renderer/settings.css`、`desktop/renderer/settings-i18n.js`、`desktop/renderer/provider-presets.js`、`tests/desktop/provider-presets.test.js`（及必要的新测试文件）。
- **不新增依赖**、无框架、无打包器。
- **R3**：失败如实报；拿不到列表不等于零个模型；不要把「刚点了按钮」画成「已获取」。
- 键盘可达、`:focus-visible` 可见、状态不只靠颜色。
- 颜色只走语义令牌，圆角只有 `--radius-sm` / `--radius` / `--radius-lg` 三档。
- i18n en + zh 必须成对（`settings-i18n.js` 现在两边的键数相等）。

## 你可能踩到的坑（前人踩过）

1. **`probeProvider` 的 `/models` 可能 401 或 404**。很多网关不实现模型列表。所以「在线获取」失败**不是**「服务配置错了」——文案不能说成后者。`testProvider` 在给了 `model` 时会退一步发一次最小 chat 请求，但那是「验通」不是「列模型」，**不要**把那条路的结果当成模型列表。
2. **`handleProviderTest` 按 `baseUrl` 匹配等待中的测试**（`settings.js:322`）。同一张卡同时点「测试连接」和「在线获取」会有两个 pending 用同一个 `baseUrl`，答案会串到先注册的那个。**你要解决这个**：给 pending 加一个 `kind`（`"test"` / `"list"`）并让宿主回包能区分——但宿主不改的话无法区分，那就**在同一张卡上串行化**（一个在飞时禁用另一个按钮），并在报告里说明这个限制。
3. **五个厂商的 `/models` 端点实测 401**（见 `provider-presets.js` 头注释），OpenAI/Gemini 从本机不通。所以默认态**不要**自动拉取——点了才拉。
4. **`Page.captureScreenshot` 在这台机器上会超时**：窗口被遮挡或 `visibilityState === "hidden"` 时必失败。用一次性的 `--user-data-dir` 让窗口可见，且「设视口」与「截图」必须在**同一个 CDP 会话**里。

## 绝对不要写用户的真实配置

```bash
mkdir -p /tmp/harness-model && cd desktop
HARNESS_HOME=/tmp/harness-model ./node_modules/.bin/electron main.js --remote-debugging-port=9390 --user-data-dir=/tmp/ud-model
```

端口 **9390**（9361/9371/9372/9373/9380 都被占过）。
测完**只关自己启的实例**（按命令行里的 `--remote-debugging-port=9390` 匹配，PowerShell `Stop-Process`），**不要 `taskkill /IM electron.exe`**。

CDP 小工具可直接复用：`C:/Users/mogen/AppData/Local/Temp/impeccable-audit/cdp.mjs`
用法：`node cdp.mjs <port> eval "<js>"` / `node cdp.mjs <port> shot <file>` / `node cdp.mjs <port> size 1440 900`
（`shot.mjs` 同目录，处理「同会话设视口+截图」+ `Page.bringToFront`。）

## 自测

1. `npm run check:js`、`npx vitest run tests/desktop` 全绿。
2. 纯逻辑抽成不碰 DOM 的函数并加单测（`tests/desktop/`，风格照 `settings-models.test.js`）。
3. Electron 实测（隔离，端口 9390）：
   - 一张卡点「在线获取」：成功路径（用一个假 OpenAI 兼容 server，或者直接指向一个返回 `{data:[{id:"x"}]}` 的本地端口）、失败路径（`127.0.0.1:9` 连不上）、无列表路径（返回空 `data`）；
   - 「测试连接」仍然工作，且不再重复画 chip；
   - 厂商下拉换厂商后，模型区状态清空（旧厂商的列表不能留在新厂商的卡上）；
   - 1440 与 1100 宽、深色与浅色。
4. 更新 `docs/frontend-design.md` §7.9（模型服务页）、`dev-notes/页面优化.md`。

## 交付

不要提交。报告：改了哪些文件与函数、删了什么、新按钮的交互与状态机、`baseUrl` 串匹配问题怎么处理的、自测命令与真实输出、截图路径、「需要人看的地方」。
