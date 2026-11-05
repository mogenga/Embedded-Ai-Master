# Task A — 设置页全面优化

先读 `docs/ui-polish-shared.md`（共享方向、硬约束、端口分配、自测口径），那是你的第一份需求。

## 用户原话

> 分发多个子代理全面优化界面

## 你独占的文件

- `desktop/renderer/settings.css`
- `desktop/renderer/settings.js`
- `desktop/renderer/settings-i18n.js`

**不要碰** `styles.css`、`index.html`、`app.js`、`i18n.js`（另外两个代理正在改）。大文件用 Edit 精确替换。

## 先读代码，别猜

- `desktop/renderer/settings.js` — `makeSettingsPage`（约 839 行）、`buildConnectionPage`（约 2050 行）、`makeCard`、`settingRow`（约 461 行附近）、`settingGroup`。
- `desktop/renderer/settings.css` — 分段注释在 1 / 1037 / 1104 / 1742 / 2068 / 2258 行。
- `docs/frontend-design.md` §7.9（设置页规格）。

## 实测到的设置页问题（已验证，直接改）

1. **标题层级跳级**：`h1 设置`（对话框标题）→ `h1 外观`（页标题，在 `settings.js:841`）→ `h3 主题`（分组标题，`settings.js:461`）。屏读器拿到的文档大纲是断的。页标题应与对话框标题同一层或降一级，分组标题保持 `h3` 但中间不能空。
2. **滚动容器没有样式**：`.settings-panes` / `.settings-nav` 是唯二 `overflow-y: auto` 的元素，`settings.css` 里**一条滚动条规则都没有**。深色主题下是浅色系统滚动条。两个都要接管，且要与 `styles.css` 已有口径一致（轨道透明、thumb 用 `--border`、hover 用 `--border-strong`、宽 10px、thumb 内 3px 透明边）。
3. **设置页没有 `::selection` 与 `caret-color`**：设置里全是输入框（服务地址、密钥、服务名、命令参数、超时秒数）。深色下选中文字是系统蓝。
4. **表单行间距不成套**：`settings.css` 里存在 14/18/28px 的零散 margin。收敛到 4/8/12/16/24/32 一套；**行内 label 与 desc 之间要比行与行之间紧**。
5. **`.conn-key-env-hint`（`settings.css:1170`）用 `border-left: 2px solid`**：共享方向第 2 条点名要去掉彩色竖线习惯，这个虽然用的是 `--border-strong`，仍应改成缩进 + 中性表面或干脆并入上一行。
6. **高对比主题下设置页要复查**：`--border` 在 contrast 下是 `#4a4a4a`，滚动条 thumb 会非常显眼，要确认不会变成一条粗白条。

## 重点：模型服务页（这一页是设置里最复杂的）

它刚重构过（三档分区：必填 / 可选 / 很少用），**不要推倒重来**，只做精度打磨：

- 服务卡折叠态：厂商图标 + 显示名称 + `服务名 · 厂商` + 「已配置密钥 / 缺少密钥」徽章 + 「N 个模型」+ 测试连接 + 删除。检查：
  - 徽章与按钮在 1100 宽下是否换行或挤压（现在 1440 下排得开，1100 未验证）；
  - 折叠态整行是否可点（现在只有箭头可点）；
  - 徽章颜色之外是否有文字（已有文字，确认不是纯色点）。
- 展开态：厂商下拉 → 显示名称 → 服务名 → 服务地址 → API 密钥 → 模型列表 → 推荐模型 chips。检查：
  - 必填项与可选项的视觉区分是否靠**标签文字**而不只靠位置；
  - 错误行（校验失败）是否说清「哪个字段、怎么改」；
  - 模型列表行的删除按钮在 1100 宽下是否还在可点区域。
- 「测试连接」的四类失败（地址不通 / 鉴权失败 / HTTP 错误 / 地址非法）是否都有可读的下一步。

## 允许的改动范围

- 只改 CSS + 渲染结构 + i18n 文案键。**不改保存路径**：仍是整份 `saveProviders`，校验（重名、服务名斜杠、必填）一条都不能少。
- **不改** `providers.json` 形状、**不改** `prometheus.providerMeta` 键名。
- i18n 必须 en + zh 同时补，键名风格照 `settings-i18n.js` 现有命名（`conn*` / `setting*` / `group*`）。

## 自测

1. `npm run check:js`、`npx vitest run tests/desktop`（后者有 536 例，改动若影响 `settings-models.test.js` 必须让它继续通过）。
2. Electron 实测（隔离，端口 **9371**）：空态、一张卡折叠/展开、多张卡、「添加模型服务」后滚动到新卡片、重名被拒、缺少密钥的显示、推荐模型 chips、测试连接失败展示；深色/浅色；1440 与 1100 宽。
3. 键盘：Tab 走完整个设置页，焦点环可见；Esc 关闭设置返回主界面。

## 交付

不要提交。报告按共享文档的「交付格式」写。
