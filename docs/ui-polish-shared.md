# UI 全面优化 · 共享方向（三个子代理共读）

仓库：`E:\Project\personal\Embedded-Ai-Master`，分支 `feat/page-optimization`。
**不要建分支、不要 worktree、不要提交、不要 push。**

先读，按顺序：

1. `PRODUCT.md`（产品事实与硬约束）
2. `.claude/skills/impeccable/reference/craft-floor.md`（质量地板与禁用项）
3. `.claude/skills/impeccable/reference/operate.md`（这个界面的模式是 **Operate**：用户在做任务，不是在看营销页）
4. `docs/frontend-design.md` §5（令牌）、§7（组件）、§10（可访问性）、§12（验收清单）

## 用户原话

> 分发多个子代理全面优化界面

## 本轮的统一方向（三个代理必须朝同一处使劲）

**把「工作台」做实：去掉装饰性提示条，补上浏览器默认表面，让留白与密度有节奏。**

Operate 界面的野心长在精度和克制上，不长在表现力上。三条共享动作：

1. **浏览器默认表面必须由设计系统接管**（这是最高性价比、模型最常漏的一项）。
   现在 `::selection` 全仓库 **0 条规则**，`caret-color` 只有一处，滚动条只美化了 2 个（`.session-list` / `.transcript`），其余全是 Chromium 默认。深色主题下选中文字是系统蓝，滚动条是浅色默认条——一眼就露出「这是网页不是产品」。
   要覆盖：`::selection`（前景+背景都要，四套主题下都读得清）、`caret-color`、所有可滚动容器（设置页、命令面板、模型面板、工具输出、串口、转录）的滚动条、`::marker`、`text-underline-offset`。

2. **提示条（callout）不该靠一条彩色竖线。**
   现在 `.notice.setup`（accent）、`.notice.recovery`（warn）、内联 diff 评论（accent）、子代理分组（accent）全是 `border-left: 2px solid`。这是分类默认做法，不是这个产品的语言。改成**中性表面 + 一个明确的语义标记**（小图标、左上角标签、或 `--surface` 底）+ 首行文字承担语气。**例外**：`.serial-line.rx` / `.serial-line.tx` 的左侧色条**保留**——串口方向在滚动中必须一眼可辨，那是有功能意义的。

3. **节奏：同类间距成套。**
   表单行、转录轮次、设置页小节、工具行的上/下间距要来自同一套值（`4 / 8 / 12 / 16 / 24 / 32`），标题上方永远比下方松。现在存在 14/18/28/70px 一类的零散值。

## 已实测的现状（别重复测，直接用）

| 观测 | 值 | 判断 |
|---|---|---|
| 主题 | 默认 `light`，四套变体齐全 | 正常 |
| 正文字体 | `Inter` 未安装，实际落到 `Segoe UI Variable Text` | **不要引入 Web 字体**（无依赖、无打包器）；`document.fonts` 为空是正常的，不是 bug |
| `::selection` 规则数 | 0 | 要补 |
| 有样式的滚动条 | 2 个（会话列表、转录） | 要补 |
| `.model-meta` 深色对比 | 4.1:1（`#7d8797` on `#22272f`） | 低于 4.5，要修 |
| 设置页标题层级 | `h1 设置` → `h1 外观` → `h3 主题`（跳级） | 要修 |
| 图标按钮可访问名 | 22 个里 0 个有 `aria-label`，只有 `title` | 要补 |
| 动效时长 | 90–300ms，共 9 种 | 收敛成 `--fast`(110) / `--normal`(170) 两档 |
| `prefers-reduced-motion` | 有三处覆盖，全局 `*` 兜底存在 | 正常 |
| 空态 | `.empty-state` 距顶 8vh，下方 366px 空白，与输入框脱节 | 要重排 |

## 硬约束（违反即重做）

- **无框架、无打包器、无构建步骤**。`desktop/renderer/*.js` 是原生 ES 模块，直接改名就生效，没有编译。
- **圆角只有三档**：`--radius-sm` 6 / `--radius` 10 / `--radius-lg` 20。**不新增令牌**。
- **颜色只走语义令牌**：`--bg` `--sidebar` `--surface` `--surface-raised` `--surface-hover` `--border` `--border-strong` `--text` `--text-secondary` `--text-faint` `--accent` `--accent-text` `--warn` `--danger` `--success`。**不要在规则里写十六进制**。四套主题（dark / light / contrast / light-contrast）都必须成立。
- **零 emoji**、无装饰性图形、不允许渐变文字、不允许 `box-shadow: x y 0` 硬阴影。
- **图标只用 `icons.js` 的 24×24 / `stroke-width: 1.75` sprite**；不要在 HTML 里手写新 SVG。
- **CSP**：`script-src 'self'`，无 inline script、无 eval。
- **不改内核（`src/`）、不改宿主（`desktop/host/`、`desktop/main.js`）**。
- **不改 `providers.json` 形状与 `prometheus.providerMeta` 的 localStorage 键**。
- **诚实（R3）**：内核没有的能力不画假按钮；失败要说清是什么失败。**不要为了让截图好看而伪造状态**。
- 状态不得只靠颜色（色盲与高对比主题都依赖这一点）。

## 文件所有权（并行作业，越界即冲突）

| 代理 | 独占文件 |
|---|---|
| A（设置页） | `desktop/renderer/settings.css`、`desktop/renderer/settings.js`、`desktop/renderer/settings-i18n.js` |
| B（主窗口样式） | `desktop/renderer/styles.css` |
| C（主窗口结构） | `desktop/renderer/index.html`、`desktop/renderer/app.js`、`desktop/renderer/i18n.js` |

- **只改上表里属于你的文件。** 别的代理此刻正在改另外两列。
- 大文件用 **Edit 精确替换**，**禁止 Write 整文件重写**（会覆盖别人的并行改动）。
- 需要对方配合时**不要自己动手**，写进报告的「需要人看的地方」。

## 绝对不要写用户的真实配置

**任何会触发保存的验证都必须用隔离目录。** 每条命令单独一行，`HARNESS_HOME` 指向 `/tmp` 下的临时目录：

```bash
mkdir -p /tmp/harness-A && cd desktop
HARNESS_HOME=/tmp/harness-A ./node_modules/.bin/electron main.js --remote-debugging-port=9371 --user-data-dir=/tmp/ud-A
```

端口分配：**A 用 9371，B 用 9372，C 用 9373**。9361 上已经跑着一个，不要碰它。
测完**只关自己启的实例**（按命令行里 `--remote-debugging-port=<你的端口>` 匹配，用 PowerShell `Stop-Process`），**不要 `taskkill /IM electron.exe`**。

想让模型面板有内容，可以在临时的 `HARNESS_HOME/providers.json` 里写假 provider（key 写 `sk-placeholder-for-ui-only` 之类，别写真实密钥）。

**CDP 小工具已经存在**，直接复用，不要重写：

```
C:/Users/mogen/AppData/Local/Temp/impeccable-audit/cdp.mjs
```

用法：`node cdp.mjs <port> eval "<js>"` / `node cdp.mjs <port> shot <out.png>` / `node cdp.mjs <port> size 1440 900`。
注意：这台机器上 `Page.captureScreenshot` 偶尔会超时，重试一次通常就好；把视口覆盖清掉（`Emulation.clearDeviceMetricsOverride`）能缓解。**窗口最小化时截不到图**，先让窗口可见。

## 自测（每个代理都要跑，把真实输出贴进报告）

1. `npm run check:js` — 必须通过（它扫 `desktop/` 与 `scripts/` 下每个 JS 文件的语法）。
2. `npx vitest run tests/desktop` — 必须全绿。

> **三个代理会同时跑测试。** 这台机器上并行负载已知会让少数用例偶发超时（`tests/ls.test.ts` 的 500 条目、`background-terminal`、`mcp-manager`、`keil/exit-settle`）。如果失败的是这几组之一，**单独重跑一次**再下结论；不要因为一次红就去改无关代码。`tests/desktop` 本身应当稳定。
3. Electron 实测截图：**1440×900 与 1100×800 两档**，**深色与浅色两套主题**（有条件再跑高对比）。看的是渲染结果，不是代码。
4. 键盘：Tab 能到达所有控件，`:focus-visible` 可见；Esc 关闭浮层；箭头键方向正确。

## 交付格式

报告必须包含：

- 改了哪些文件、哪几段规则/函数（引用 `文件:行号`）
- **判断理由**：为什么这么改，对应哪条共享方向或哪条实测证据
- 截图路径（1440/1100 × dark/light 至少四张）
- 自测命令与真实输出
- 「需要人看的地方」：你不同意、拿不准、或留给别人的

不要提交。不要写 dev-notes（由主代理统一写）。
