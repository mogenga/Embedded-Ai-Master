# Task C — 主窗口结构与行为：空态、可访问名、键盘

先读 `docs/ui-polish-shared.md`（共享方向、硬约束、端口分配、自测口径），那是你的第一份需求。

## 用户原话

> 分发多个子代理全面优化界面

## 你独占的文件

- `desktop/renderer/index.html`
- `desktop/renderer/app.js`（7833 行）
- `desktop/renderer/i18n.js`

**不要碰** `styles.css`、`settings.css`、`settings.js`、`settings-i18n.js`。大文件用 Edit 精确替换，**禁止整文件重写**。

> 你要改的视觉结果很多要靠 `styles.css` 完成，但那个文件不归你。给你的做法：**结构改到「另一个代理只需要加一条选择器就能生效」的程度**，把要加的类名和期望样式写进报告。已经存在于 `styles.css` 的类优先复用。

## 实测到的问题（已验证，直接改）

### 1. 图标按钮没有可访问名（22 个里 0 个有 `aria-label`）

`desktop/frontend-design.md` §10 已把这条记作「已知缺口」。现状：

```
new-session, session-filter, toggle-archived, refresh-sessions,
topbar-sidebar-toggle, changes-button, terminal-button, more-button,
settings-button, find-prev, find-next, find-close, plus-button,
close-workbench, serial-pause, serial-clear, serial-export,
browser-back, browser-forward, browser-reload, settings-back, shortcuts-close
```

这 22 个 `id` 全都只有 `title`（经 `data-i18n-title`）。`title` 在屏幕阅读器与触屏上不朗读，键盘用户必须悬停。

要做：

- 给每个图标按钮补 `aria-label`，**取值复用现有 `data-i18n-title` 的键**（不要新造 22 个键）。
- 最省的做法：在 `app.js` 已有的 i18n 应用函数里，遇到 `[data-i18n-title]` 时**同时**写 `title` 与 `aria-label`（除非元素显式声明了 `aria-labelledby`）。这样一处改动覆盖全部。
- 顺手检查 `role="tab"` 的 workbench tab 条是否有正确的 `aria-controls`（现在有 `aria-selected` / `tabindex`，确认面板 id 对得上）。

### 2. 空态与输入框脱节

实测（1440×900，空会话）：

```
transcript 顶 48 → 底 712
empty-state 顶 151 → 底 346   （8vh 的 margin-top）
空白 346 → 712 = 366px
composer 顶 737
```

空态是「居中偏上的一小块」，下面 366px 空着，然后才是输入框。视觉上它不属于输入框，而事实上它就是输入框的引导。

要做（结构层面）：

- 让空态在**视觉上属于 composer**：把 `.empty-state` 移进或紧贴 `.transcript` 的底部对齐区（`margin: auto` 类的方案），或把它移到 composer 上方的固定槽位。
- **不要**用绝对定位硬压——两个宽度档（1440 / 1100）与侧栏折叠态都要成立。
- 空态里现在有这个：`<img class="empty-mark">` + `<h1>要构建点什么？</h1>` + `<p>` + 隐藏的「配置模型服务」按钮。文案是英文直译的中文，`要构建点什么？` 对嵌入式调试场景文不对题——**产品定位是「症状驱动的固件调试」**，不是「build 一个 app」。改成产品自己的语言（中文为准，英文同步）。

### 3. 键盘链路要复查

- Tab 顺序是否与视觉顺序一致（侧栏 → 顶栏 → 转录 → composer）。
- `Escape` 的关闭顺序（命令面板 → 菜单 → 设置 → 工作台）是否仍然正确。
- 模型面板的厂商栏用 `ArrowUp/Down` 还是 `ArrowLeft/Right`？现在两者都实现了（`moveModelRailProvider`），确认没有跟「模型列表」的上下键打架。

## 顺带修的小问题

- `#composer-status-tab` 里的 `#status-tab-branch` 是一个依赖 `state.git?.available` 的**占位节点**（T-01，git 数据源还没接）。**保留它**，不要删，也不要在本任务里接 git。
- 命令面板（`Ctrl+K`）现在是 `overflow: hidden` 且没有滚动条样式，条目多了会截断。**只报告，不改**——那是 `styles.css` 的事。

## 不改的东西

- 不改内核、不改宿主、不改 `protocol.js`。
- 不新增依赖。
- 不伪造状态：空态文案不能承诺内核做不到的事。
- i18n 必须 en + zh 成对补（`i18n.js` 现在 en 399 / zh 399，改完还要相等）。

## 自测

1. `npm run check:js`。
2. `npx vitest run tests/desktop` — 全绿。注意 `tests/desktop/main-scope.test.js` 对 `app.js` 的顶层标识符有静态断言，删改顶层声明可能触发它，按其规则处理。
3. Electron 实测（隔离，端口 **9373**）：空态在 1440 与 1100 宽下的位置；Tab 走完全程（贴出焦点序列）；Esc 关闭顺序；屏幕阅读器口径用 `document.querySelectorAll('[title]:not([aria-label])')` 自证清零。
4. 截图：**1440×900 与 1100×800**，深色与浅色。

## 交付

不要提交。报告按共享文档的「交付格式」写。
