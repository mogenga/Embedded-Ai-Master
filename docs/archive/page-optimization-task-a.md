# Task Brief — 整体美化调整（A：字号与厂商选择器）

仓库：`E:\Project\personal\Embedded-Ai-Master`，分支 `feat/page-optimization`（已存在，直接在上面改，**不要新建分支、不要用 git worktree**）。
所有界面代码在 `desktop/renderer/`，纯 ES 模块，**无框架、无打包器、无构建步骤**。内核在 `src/`（本任务不碰）。

## 你的任务

三件事，按顺序做完、全部自测通过再交回。

### 1. 默认字号偏小

用户原话：「默认100%字号有点小，需要优化」。

现状：`desktop/renderer/styles.css` 顶部 `:root` 里的字号阶是

```css
--text-xs: calc(11px * var(--ui-scale));
--text-sm: calc(12px * var(--ui-scale));
--text-base: calc(13px * var(--ui-scale));
--text-md: calc(14px * var(--ui-scale));
--text-lg: calc(17px * var(--ui-scale));
--text-xl: 22px;
```

要求：

- 把整条字号阶上调一档，目标是在 100% 缩放下接近主流桌面应用的可读性。建议值（可微调，但必须整条一起调，保持层级关系）：

  ```css
  --text-xs: calc(12px * var(--ui-scale));
  --text-sm: calc(13px * var(--ui-scale));
  --text-base: calc(14px * var(--ui-scale));
  --text-md: calc(15px * var(--ui-scale));
  --text-lg: calc(18px * var(--ui-scale));
  --text-xl: 24px;
  ```

- **不要改** `--ui-scale` 的分档（0.9 / 1 / 1.1 / 1.25），也不要动 `--font-scale`（转录正文）。
- `styles.css` 与 `settings.css` 里另有 **2 处硬编码 `font-size: 10px`**（`styles.css:6006`、`styles.css:6169` 附近）。把这两处改成 `var(--text-xs)`，否则字号阶调大后它们会成为漏网的最小字。
- 检查 `docs/specs/frontend-design.md` §5.3 里的字号阶表格，与实现同步更新（那份文档是事实源，表格里的数字必须与 `:root` 一致）。
- 字号变大后必然有地方会挤：**逐个检查并修掉换行、溢出、截断**。重点区域：
  - `composer-bar`（底栏控件行，`flex-wrap: nowrap`，字号变大后芯片可能挤爆）
  - 顶栏 `.topbar`、侧栏 `.session-item`
  - `settings.css` 的 `.setting-row` / `.setting-card-head` / `.setting-select`
  - `.model-menu` 与 `.model-option`
  - 工作台 tab、状态页签 `.composer-status-tab`
- 判断标准不是「看起来没问题」，而是**在 1440 宽与 1100 宽下都不出现横向溢出、不出现两行容器里被裁掉的文字**。用 Electron + CDP 实测（见下）。

### 2. 厂商一键配置改成卡片内的下拉选择器

用户原话：「模型服务的厂商一键配置应该是在添加模型服务后以下拉框形式供用户选择，左侧是厂商图标，然后紧跟厂商名称。厂商图标联网搜索获取」

当前实现：设置页「模型服务」页顶部有一排 `preset-row` 厂商卡片（7 张），点击新建一张已填好 name + baseUrl 的卡片。**这个顶部卡片区要整个删掉**，改成：

- 点「添加模型服务」新建的卡片里，**第一行**是一个厂商选择器（`sRow` 一行，label 用「厂商」/「Provider」），控件是一个自定义下拉：
  - 收起态：显示当前选中的厂商图标 + 名称；未选时显示「自定义」+ 一个中性占位图标。
  - 展开态：一个浮层列表，每行 **左侧厂商图标、紧跟厂商名**，最后一行是「自定义（手动填写）」。
  - 选中某个厂商 → 立刻把卡片的 `name` 与 `baseUrl` 填成预置值（可用 `existing` 判断冲突时不要覆盖用户已手填的非空值？——见下「边界」），并把「推荐模型」chip 行按该厂商刷新。
  - 选「自定义」→ 不清空已有内容，只是不再套预设。
- 厂商图标数据已经有了：`desktop/renderer/vendor-marks.js`（本次已生成，导出 `VENDOR_MARKS`，键为预设 id，值是 `{viewBox, paths}`，24×24 grid，`fill="currentColor"`）。**不要联网再取**，直接用这个模块。渲染方式参考 `desktop/renderer/icons.js` 的风格：内联 `<svg viewBox=... fill="currentColor"><path d=.../></svg>`。
- 新建卡片时是否默认选中某个厂商？**不默认**，显示「自定义」，除非用户主动选。理由：默认选一家会让人以为已经配好了。
- **已保存的卡片也要有这个选择器**，并且要按 `providers.json` 里的 `name` 反查预设：名字等于某个预设 id 时显示该厂商图标与名称，否则显示「自定义」。用户手动改 `name` 时也要实时跟着变。
- 「推荐模型」chip 行保留，逻辑不变，只是改成由这个选择器驱动（现在看起来是由 `nameInput` 输入驱动，改成同时也由预设选择驱动即可）。

### 3. 视觉细节（用户：「保持现有风格，只做细节调整」）

**不要重做视觉方向，不要换配色，不要换字体族。** 只做以下几处打磨：

- 删掉 `preset-row` / `preset-grid` / `preset-card` / `preset-mark` / `preset-label` / `preset-url` / `preset-check` 相关的 CSS（顶部卡片区没了）。
- 下拉选择器的视觉要与设置页其他控件（`.setting-select`、`.setting-input`）同一套：同样的高度、圆角 `--radius-sm`、边框 `var(--border)`、focus 时 `--border-strong`。
- 浮层列表用 `--surface-raised` + `--border` + `--radius` + `--shadow-popover`，行高与 `.mode-option` 一致，hover 用 `--surface-hover`。
- 选中行用中性面 + 勾，**不要**用 accent 底色（与模型面板的约定一致）。
- 字号阶调整后顺带检查：状态页签 `#composer-status-tab` 高度是否还合适（现为 28px）、模型面板宽度 341px 是否仍够放两栏。

## 硬约束（必须遵守）

1. **无框架、无打包器、无构建步骤**。不要引入 React/Vue/Vite/任何 npm 依赖。不要执行任何安装命令。
2. **不改内核 `src/`、不改协议层**。只改 `desktop/renderer/` 与必要的文档。
3. **工具必须诚实（R3）**：不伪造状态、不静默吞错误。厂商选择器选不到预设时显示「自定义」，不编一个。
4. **不删 `desktop/renderer/provider-presets.js`**：`presetById` / `presetModelSuggestions` / `providerMark` 仍被 `app.js` 的厂商栏使用。只删设置页里对 `PROVIDER_PRESETS` 的那段渲染。
5. **测试不得触网**；`npm test` 默认必须离线通过。

## 危险命令测试禁令（原样照抄自 AGENTS.md，强制）

任何测试、探针、演示、子代理任务都**禁止在宿主机真实执行可能造成破坏的命令**，包括但不限于：`del /s /q <盘符根>`、`rm -rf /`、`rm -rf ~`、`format`、`diskpart`、`mkfs*`、`dd ... of=/dev/...`、`shutdown`/`reboot`/`poweroff`/`halt`、fork bomb、`reg delete HKLM`、`bcdedit`、`cipher /w`。

危险命令测试必须分两层，缺一不可：

1. 纯函数断言拦截器识别（如 `expect(isDangerousCommand(cmd)).toBe(true)`）；
2. 若测试 `execute`，必须先完成第 1 层断言，再调用 `execute`，并断言底层 `spawn`/`exec` **未被调用**。

- 禁止为制造 RED 而真实执行危险命令；RED 只能由纯函数断言或注入 mock 产生。
- 真实命令测试只允许无害、跨平台、无副作用的命令（如 `node -e "console.log(...)"`、临时目录内读写），并限定在临时 workdir。
- 子代理 brief 必须原样包含本节约束；reviewer 必须检查测试是否存在真实执行危险命令的路径。
- 违反即停止：立即停止当前任务、报告用户、不得重试，并把事故写入 `dev-notes`。

## 依赖安装禁令（原样照抄自 AGENTS.md，强制）

- **agent 禁止执行任何依赖安装/变更命令**：`npm install`、`npm ci`、`npm update`、`yarn`、`pnpm`、`bun install` 等。只能把命令原样输出给用户，等用户确认完成后再继续。
- 写文档/文件禁止用 `node -e`、`bash -c` 拼接含反引号、`$()`、`${}` 的文本；一律用 Write/Edit 工具或独立脚本文件。
- 违反即停止：报告用户、记录 `dev-notes`、不得重试。

## 绝对不要写用户的真实配置（重要事故教训）

验证「保存」路径时**必须先确认 `HARNESS_HOME` 指向测试目录**。本会话已经出过一次事故：直接点保存把测试数据写进了用户真实的 `~/.harness/providers.json`。

正确做法：

```bash
# 1. 建隔离配置
mkdir -p /tmp/harness-test
# 写一份只含假 provider 的 providers.json 到 /tmp/harness-test/
# 2. 用隔离目录启动
cd desktop && HARNESS_HOME=/tmp/harness-test ./node_modules/.bin/electron main.js --remote-debugging-port=9333
```

测完只关掉**自己启动的那个实例**（按命令行匹配 `--remote-debugging-port=9333`），不要 `taskkill /IM electron.exe`——那会杀掉用户的窗口。

## 自测要求

1. `npm run check:js` 全绿。
2. `npx vitest run tests/desktop` 全绿。
3. `npm test` 全绿。
4. 若你为下拉选择器的纯逻辑（如「名字 → 预设」的反查、冲突判定）抽了纯函数，加单测，放在 `tests/desktop/`，风格照 `tests/desktop/settings-models.test.js`。
5. Electron 实测（用隔离 `HARNESS_HOME`）：
   - 设置页「模型服务」页顶部已无厂商卡片区；点「添加模型服务」后第一行有厂商选择器。
   - 展开下拉，逐项检查 **7 个厂商图标都渲染出来**（不是空白方块）、图标在左、名称紧跟其后。
   - 选 DeepSeek → 名字与 baseUrl 自动填好，推荐模型 chip 出现。
   - 已保存的 `kimi` 卡片打开后选择器显示 Kimi 与图标；把名字改成 `custom-thing` → 选择器变「自定义」。
   - 100% 缩放、1440 与 1100 宽下截图检查无溢出/裁字。
   - 深浅两套主题各看一次。

## 交付

- 改完直接在工作区，**不要提交、不要 push**。
- 交回时报告：改了哪些文件、字号阶最终值、下拉选择器的键盘行为（回车/空格打开、方向键移动、Esc 关闭、焦点回到触发器）、自测命令与结果、还有哪些你判断需要人看的地方。
- 顺手把以下文档同步更新（它们是对外事实源，不更新就是撒谎）：
  - `docs/specs/frontend-design.md` §5.3 字号阶表格、§7.6 输入区相关条目（如果受影响）
  - `docs/archive/page-optimization-todolist.md` §2 已做列表
  - `dev-notes/页面优化.md` 追加一节，记：用户原话（本次）、关键产出、翻车与返工
