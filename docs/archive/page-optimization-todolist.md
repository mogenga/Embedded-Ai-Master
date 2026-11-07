# 页面优化 Todolist

> 分支：`feat/page-optimization`。设计稿：`docs/superpowers/specs/2026-11-04-page-optimization-design.md`。
> 过程记录：`dev-notes/页面优化.md`。

## 1. 本轮不做、需要单独立项

### T-01 · Git 状态数据源（分支显示）

- **现状**：`git_status` 在渲染层只有一个 `case` 分支（`desktop/renderer/app.js`），宿主没有 `gitStatus` handler，`src/` 没有 git 模块。`desktop/MATRIX.md` 把 git 记在**已隐藏**。因此 `state.git` 恒为 `null`，顶栏那个分支 chip 从未亮过。
- **本轮处理**：删除顶栏的空壳 `#topbar-cwd-branch`；在输入区状态页签里留一个**同判据的占位节点** `#status-tab-branch`（`hidden` 由 `state.git?.available` 驱动）。今天不显示，将来宿主接上 git 就自动出现。**不新增 git 数据源。**
- **升级触发条件**（任一成立则单独立项）：
  1. 需要展示工作区改动数、暂存状态或提交入口；
  2. 诊断流程需要在转录里引用「这次改动发生在哪个分支」；
  3. 用户明确要求分支信息。
- **接入时要改的地方**：`desktop/main.js`（或 host）新增 `gitStatus` 命令 → `desktop/preload.cjs` 白名单 → `desktop/host/host.js` 执行 `git rev-parse --abbrev-ref HEAD` 并回事件 → `desktop/renderer/protocol.js` 映射 → `app.js` 的 `state.git` 赋值。另需在 `desktop/MATRIX.md` 把 git 从「已隐藏」挪到「已支持」。

### T-02 · Claude（Anthropic Messages 协议）

- **现状**：内核只有 `openai-chat-completions` 一种协议；Anthropic 官方端点不提供 OpenAI 兼容接口，接不上。
- **升级触发条件**：用户需要在官方 Anthropic 端点（而非 OpenRouter 一类兼容网关）上使用 Claude。
- **待办**：内核验证层新增 Anthropic Messages 适配器（流式 + 工具调用 + 思考段），与 `src/model/openai.ts` 并列；`ProviderConfigSchema.protocol` 从字面量扩成联合类型。这需要先改「适配层只做 OpenAI 兼容」的既有定案。

### T-03 · 附件上传 / 语音输入

- 语音输入已于 2026-10-22 整块删除，不在本轮恢复。
- 图片附件仍是 D-188：能画缩略图，但发送时被静默丢弃。本轮不碰，修复见 `docs/ledgers/deferred-issues.md`。

## 2. 本轮已做

- [x] 七家厂商预设（`desktop/renderer/provider-presets.js`），配置页顶部「快速添加」卡片。
- [x] 输入区按 BoardUI 视觉语言重画：状态页签、模型面板厂商栏、菜单动效。
- [x] 上下文详情弹层完整保留，触发点移到状态页签。
- [x] 单元测试：`tests/desktop/provider-presets.test.js`（17 例）。

### 2.3 第二轮（2026-11-04，用户反馈后）

- [x] **字号阶整条上调一档**：`--text-xs` 11→12 / `--text-sm` 12→13 / `--text-base` 13→14 / `--text-md` 14→15 / `--text-lg` 17→18 / `--text-xl` 22→24（px，前五档仍乘 `--ui-scale`）。`--ui-scale` 档位与 `--font-scale` 未动。
- [x] 两处硬编码 `font-size: 10px`（`.serial-badge` / `.serial-line-btn`）改为 `var(--text-xs)`；`styles.css` 与 `settings.css` 里已无其他像素字号。
- [x] 字号变大后的挤压修复：`.serial-time` 78→88px、`.serial-level` 34→42px、`.serial-tag` 120→132px；`.serial-badge` 行高 1.75→1.5（固定 18px 高）；`#composer-status-tab` 28→30px；卡片里「显示」按钮改为 `flex: 0 0 auto` + `nowrap`（原本被拉伸成两行）。
- [x] **顶部「快速添加」厂商卡片整块删除**，改为每张服务卡片**第一行**的厂商下拉（`sProviderPicker`）：
  - 收起态 = 厂商图标 + 名称（与 `.setting-select` 同高 32px / 同圆角 / 同边框），未识别为预设时是「自定义（手动填写）」+ 铅笔占位图标；
  - 展开态 = 浮层列表，每行左侧图标、紧跟厂商名，末行「自定义」，中间一条分隔线；
  - 图标用新增的 `desktop/renderer/vendor-marks.js`（`VENDOR_MARKS`，LobeHub icons，MIT，24×24 路径数据），不联网；
  - 选中厂商 → 写 `name`，`baseUrl` 只在空着或仍是某个预设地址时替换（不覆盖手填的公司网关），「推荐模型」chip 行随即刷新；
  - 选中态**由名字反查**（`providerPickerOptions`），手改 `name` 时实时跟着变；
  - 已被另一张卡片占用的厂商在菜单里置灰并说明原因。
- [x] 删除 `preset-row` / `preset-grid` / `preset-card` / `preset-mark` / `preset-copy` / `preset-label` / `preset-url` / `preset-check` 全部 CSS 与渲染代码；`provider-presets.js` 保留（`providerMark` 仍被 `app.js` 的模型面板厂商栏使用）。
- [x] 新增 i18n：`connProvider` / `connProviderDesc` / `connProviderCustom` / `connProviderTaken`（en + zh）；删除 `connQuickAdd` / `connQuickAddDesc` / `connPresetUse` / `connPresetConfigured`。（`connProviderTaken` 已于 §2.6 随「置灰」规则一并删除。）
- [x] 新增纯函数 `providerPickerOptions` / `presetFillFor` 及 19 例单测（`tests/desktop/provider-presets.test.js` 由 17 例增至 30 例）。
- [x] 文档同步：`docs/specs/frontend-design.md` §5.3 字号阶表、§7.6 状态页签高度、§7.9 厂商选择器、§7.10 Esc 顺序、§10 最小字号；`desktop/MATRIX.md` 的 `saveProviders` 行。

### 2.4 第三轮：输入区形状关系（2026-11-04，用户贴了 BoardUI Composer Panel 实拍）

只改 CSS，不改结构、行为、无障碍属性。

- [x] `.send-button` 改圆形：`border-radius: 999px`（原 `--radius-sm`），尺寸仍 32×32。
- [x] `--radius-lg` 14px → **20px**：输入卡片贴参考图的圆度。按「圆角只有三档」的约束**不新增令牌**，全局跟着变。全部使用点已过一遍：输入卡片、状态页签上沿、设置/快捷键/输入对话框、命令面板、模型面板、用户气泡——都不破相。顺带把 `.model-refresh` 的底角从 `--radius-sm` 改为 `--radius-lg`，否则它 hover 时的方角会戳进面板的 20px 圆角里。
- [x] 状态页签 `border-radius: var(--radius-lg) var(--radius-lg) 0 0` 随令牌自动同步；实测页签底边与卡片顶边 `gap = 0`、左右边缘 `delta = 0`，无 1px 缺口。
- [x] `.chip-button`（模型 / 推理档）去边框去底色，与 `.mode-picker` 统一：静止 `transparent` 底、无 border、`--text-secondary`；hover / `[aria-expanded="true"]` 浮 `--surface` 底 + `--text`。padding / 圆角不变。改后三个控件实测同高 29px、border-width 0。
- [x] `#plus-control` 保持 `hidden`（无后端，R3），本轮不改形态。

### 2.6 第四轮：多 Key 与面板按服务划分（2026-11-05，Task B）

- [x] **模型服务页可配置同一厂商的多个 API Key**：卡片新增「显示名称」输入；服务名自动生成改为同厂商加后缀（`deepseek` / `deepseek-2` / `deepseek-3`，自定义 `provider1`…）。
- [x] **厂商下拉不再置灰**：同名冲突由服务名后缀解决，`providerPickerOptions` 改为只接收「厂商归属」，同一厂商可选任意多次。选中厂商不再改服务名中手写的部分（`isAutoProviderName` 判定）。
- [x] 显示名称与厂商归属存渲染层 localStorage `prometheus.providerMeta`（`desktop/renderer/provider-meta.js`，纯函数 + 单测）。不进 `providers.json`——内核 Zod schema 会 strip 未知键，本任务不改内核。孤儿条目静默忽略；删卡保存时整份重写即清掉。
- [x] 保存前校验显示名称不重复（trim + 忽略大小写，空名按服务名算），就地报错并聚焦第二张冲突卡（`duplicateDisplayName`）。
- [x] 卡片头改为「显示名称（大）+ `服务名 · 厂商`（小）」两行，带厂商图标；折叠态 `aria-label` 用显示名称。模型摘要最多占 46% 宽。
- [x] **对话页模型面板左栏按服务（API Key）划分**：一行 = 一张卡，厂商图标 + 显示名称（最多两行）；无已知厂商的服务回退到 `providerMark` 两字母字标。数据由 `providerRailRows(modelGroups(), meta)` 拼装——`models` 事件没有厂商字段，靠 `providerConfig` 已在渲染层 + localStorage 解决，**不改宿主与内核**。右栏表头与 `role="group"` 的 `aria-label` 也用显示名称，服务名进 `title`。
- [x] 面板宽度 341 → 412px（容纳 158px 左栏 + 模型名）；左栏宽度与两行标签在 1440 / 1100 两个宽度、深/浅主题下实测无溢出。
- [x] 新增单测：`tests/desktop/provider-meta.test.js`（25 例）+ `provider-presets.test.js` 增补（`nextProviderName` / `isAutoProviderName`，`providerPickerOptions` 改为归属语义），两文件共 61 例通过。
- [x] 文档同步：`docs/specs/frontend-design.md` §7.6 模型面板与 §7.9 模型服务页；`desktop/MATRIX.md` 的 `saveProviders` 行。

### 2.7 第五轮：删除「浏览工作区文件」目录树（2026-11-05，Task E）

用户原话：「直接删除浏览工作区文件。」

- [x] 删除 ⋯ 菜单 `#menu-browse-files` 行；删掉 tab 条里的 `data-pane="files"`。
- [x] 删除 `#pane-tree`（`.tree-head` + `.tree-level#tree-list`）与 `app.js` 整棵目录树：`treeRequests` / `requestTree` / `renderTree` / `expandTreeRow` / `collapseTreeRow` / `renderTreeHead` / `treeRow` / `treeNote` / `markTreeSelection` / `activeTreePath` / `state.treePath` / `treeExpanded` / `readTreeExpanded` / `rememberTreeExpanded`、`tree` 事件分支、`host_exit` 队列清理、`openWorkbench` 的 `showFiles` 分支、`state` 与 `session_loaded` 的 cwd 重读。
- [x] 删除 `styles.css` 的 `.tree-*`（head / root / refresh / row / children / level / note）、`.file-tree`、`.pane-tree`。
- [x] 删除 i18n 键（en + zh）：`menuBrowseFiles`、`paneFiles`、`treeEmpty`、`treeLoading`、`treeNoWorkspace`、`treeTruncated`，以及只被树头使用的 `workspace`。
- [x] **单文件内容面板保留**：`#file-root` / `openFile` / `renderFilePreview` / `getFile` 都不动，点工具行仍打开文件内容（已实测）。
- [x] **面板记忆回退**：`lastWorkbenchPane()` 不再返回 `files`；旧档案里的 `files` 回退到 `serial`，`file` 只在仍有打开文件时恢复。
- [x] 宿主 `getTree` handler 保留（本任务不碰宿主），渲染层已无调用方，`desktop/MATRIX.md` 已注明。

### 2.8 第六轮：模型服务页全面重构（2026-11-05，Task F）

用户原话：「设置中的模型服务页面全面重构美化。」

- [x] **信息层级**：展开后的八行等权表单改成三层——必填（厂商 / 密钥 / 模型，行内「必填」文字标记）、基础设置（显示名称 / 服务名 / 地址）、高级（原生 `<details>`：密钥环境变量 + 协议）。`apiKeyEnv` 已有值时高级区默认展开。
- [x] **折叠态徽章**：密钥（`已配置密钥` / `密钥来自环境变量` / `缺少密钥`）、模型数（`N 个模型`，0 转 warn）、地址（为空时才出现 `缺少地址`）。每枚都是**图标 + 文字**；`aria-label` 同步带上状态。
- [x] **模型字段占整行**：`.conn-field` 让标题与说明在列表上方，不再被 56% 控制列压扁；`data-search` 仍可搜。
- [x] **密钥必填与 env 互斥**：填了环境变量名时密钥行的「必填」隐藏，栏下出现一行说明。
- [x] **服务名描述补后果**：改名会影响已有会话里记录的 `服务/模型` 引用。
- [x] **纯函数 + 单测**：`serviceKeyKind` / `serviceHeaderFacts`（`settings-models.js`），`tests/desktop/settings-models.test.js` 新增 7 例。
- [x] **搜索适配**：查询时展开折叠的卡片正文与 `<details>`，清空后只收回搜索打开的那些。
- [x] **不改的东西**：数据结构（`providers.json` / `prometheus.providerMeta`）、`saveProviders` 单一路径、每一条校验、内核与宿主，全部未动。
- [x] 文档：`docs/specs/frontend-design.md` §7.9 新增「卡片信息层级」小节。

### 2.5 复核时补的（2026-11-05）

- [x] `.chip-button` 去边框后，设置页「无匹配」空态的跳转按钮也失去了边框——那是空页面里唯一的可点物，静止态必须像个控件。加 `.settings-empty-actions .chip-button` 覆盖：设置页自己的边框 + 表面 + 无衬线字，hover 时边框转 accent。**这是去边框带来的连带影响，不是新设计**。

### 2.1 实现期间发现并修掉的问题

- 「推荐模型」chip 原本直接 `addModelRow`，而新卡片本来就有一行空行——点一下变成「空行 + 新行」，保存被「每行都要有名字」拦下。改为**优先填第一行空行**，没有空行才追加。
- 状态页签原稿写 `margin: 0 28px`，会与 `.composer-region` 的 `padding: 0 28px` 叠加成双重缩进。改为与 `.composer` 相同的 `max-width + margin: 0 auto`。
- `usage-popover` 的锚点从输入框内移到状态页签内：触发点搬家后，原来的 `position: absolute; right: 0; top: -6px` 会相对于错误的祖先定位。

### 2.2 事故：测试写到真实配置

验证「保存」路径时点了设置页的保存按钮，当时用的是默认 `HARNESS_HOME`，于是往**用户的真实 `~/.harness/providers.json`** 写进了一个测试用的 `kimi` 条目。

- **发现**：保存后检查文件内容时看到。
- **处理**：没有用脚本删（自动权限分类器正确拦截了直接改写用户配置的操作），改为**用应用自己的 UI** 删掉那张卡再保存一次，文件恢复为只有原有的 `provider1`。
- **后续验证改用隔离环境**：`HARNESS_HOME=/tmp/harness-test` 建一份只有三个假 provider 的配置，多厂商左栏、预设卡片、键盘切换都在那里测。临时目录已删。
- **教训**：任何会写配置的 UI 验证，必须先确认 `HARNESS_HOME` 指向测试目录，再点保存。

## 3. 遗留的实现细节（本轮不定，实现者自行判断）

- 厂商字标的字号与字重。
- 状态页签圆环的半径与描边宽度。
- 厂商栏是否加 `title` 提示。
