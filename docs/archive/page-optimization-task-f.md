# Task Brief — 模型服务页全面重构美化

仓库：`E:\Project\personal\Embedded-Ai-Master`，分支 `feat/page-optimization`（已存在。**不要建分支、不要 worktree、不要提交、不要 push**）。
界面在 `desktop/renderer/`，纯 ES 模块，**无框架、无打包器、无构建步骤**。

## 用户原话

> 设置中的模型服务页面全面重构美化。

## 先读，别猜

- `desktop/renderer/settings.js` → `buildConnectionPage`（约 1053 行）与 `makeCard`（约 1201 行）。
- `desktop/renderer/provider-presets.js`（厂商预设 + `providerPickerOptions` + `nextProviderName`）。
- `desktop/renderer/provider-meta.js`（显示名称与厂商归属的 localStorage 层）。
- `desktop/renderer/vendor-marks.js`（厂商图标路径数据）。
- `desktop/renderer/settings.css`（`.settings-form-card`、`.provider-picker*` 等）。
- `docs/specs/frontend-design.md` §7.9（设置页）与 §7.6。

## 现状（上一轮刚做的，这一轮是**继续重构**，不是推倒重来）

每张服务卡：
- 头部两行：厂商图标 + 显示名称，下面一行小字 `服务名 · 厂商`；右侧「测试连接」「删除」。
- 展开后：厂商下拉 → 显示名称 → 服务名 → 服务地址 → API 密钥 → 环境变量 → 模型列表 → 推荐模型 chips → 校验问题行。

## 目标

用户要的是「全面重构美化」，但**保留现有功能与数据结构**（显示名称存在 localStorage、模型面板左栏按服务分组，这些都刚做完，不要推翻）。重点是：

1. **信息层级**：现在展开后是八行等权重的表单，用户看不出哪些必填、哪些可选、哪些很少改。重组为：
   - **必填三件**：厂商、密钥、模型（这是「能用」的最小集）。
   - **可选/少改**：显示名称、服务名（服务名要说明它构成 `服务/模型` 引用，改了会影响已有会话的模型引用）、服务地址（选厂商后已自动填好）。
   - **很少用**：密钥环境变量。考虑折叠起来。
2. **视觉**：卡片现在是一长条普通表单。给出更清晰的分区（分隔、小节标题或分栏），让折叠态一眼能看懂「这家是谁、有几个模型、配没配好」。折叠态现在的信息是显示名称 + `服务名 · 厂商` + 模型摘要，可以再加强（例如「已配置密钥」/「缺少密钥」的状态，用图标+文字，不只靠颜色）。
3. **响应式**：1440 与 1100 宽下都要好看；设置页本身是 `page-wide` 布局。

**约束**：圆角只有三档（`--radius-sm` 6 / `--radius` 10 / `--radius-lg` 20），颜色只用语义 token，不新增令牌。深色/浅色/高对比三套主题都要能看。

## 硬性要求

- **不改数据结构**：`providers.json` 的形状、`prometheus.providerMeta` 的存在方式都不动。
- **不改内核、不改宿主**。
- **不新增依赖、不引入框架/打包器**。
- 键盘可达、`:focus-visible` 可见、状态不只靠颜色。
- 保存路径不变：仍是整份 `saveProviders`，校验（重名、服务名斜杠等）一条都不能少。
- **R3 诚实**：不伪造状态、不静默吞错误。

## 并行区域（其它子代理此刻在改，不要碰）

- `app.js` 全部、`index.html` 的工作台区块与 `#menu-browse-files`、`styles.css` 的 `.tree-*` / `.file-tree` / `.pane-tree`（另一个子代理在删「浏览工作区文件」）。
- `.composer*`、`#input`、`.send-button`。
- **可以改**：`settings.js` 的 `buildConnectionPage` / `makeCard` 及其纯辅助、`settings.css` 的设置页规则、`settings-i18n.js`、`provider-presets.js` / `provider-meta.js`（若需要纯函数）、`tests/desktop/settings-models.test.js` / `provider-*.test.js`。

## 硬约束（原样来自 AGENTS.md）

### 危险命令测试禁令（强制）

任何测试、探针、演示、子代理任务都**禁止在宿主机真实执行可能造成破坏的命令**，包括但不限于：`del /s /q <盘符根>`、`rm -rf /`、`rm -rf ~`、`format`、`diskpart`、`mkfs*`、`dd ... of=/dev/...`、`shutdown`/`reboot`/`poweroff`/`halt`、fork bomb、`reg delete HKLM`、`bcdedit`、`cipher /w`。

危险命令测试必须分两层，缺一不可：

1. 纯函数断言拦截器识别（如 `expect(isDangerousCommand(cmd)).toBe(true)`）；
2. 若测试 `execute`，必须先完成第 1 层断言，再调用 `execute`，并断言底层 `spawn`/`exec` **未被调用**。

- 禁止为制造 RED 而真实执行危险命令；RED 只能由纯函数断言或注入 mock 产生。
- 真实命令测试只允许无害、跨平台、无副作用的命令，并限定在临时 workdir。
- 违反即停止：立即停止当前任务、报告用户、不得重试，并把事故写入 `dev-notes`。

### 依赖安装禁令（强制）

- **禁止执行任何依赖安装/变更命令**：`npm install`、`npm ci`、`npm update`、`yarn`、`pnpm`、`bun install` 等。
- 写文档/文件禁止用 `node -e`、`bash -c` 拼接含反引号、`$()`、`${}` 的文本。
- 违反即停止：报告用户、记录 `dev-notes`、不得重试。

## 绝对不要写用户的真实配置（本会话已发生过一次）

```bash
mkdir -p /tmp/harness-svc && cd desktop
HARNESS_HOME=/tmp/harness-svc ./node_modules/.bin/electron main.js --remote-debugging-port=9341 --user-data-dir=/tmp/ud-svc
```

（用 **9341**；9333–9340 被占。）**任何会触发保存的验证，先确认这一行里的 `HARNESS_HOME` 指向临时目录。** 测完只关自己启的实例，不要 `taskkill /IM electron.exe`，临时目录删掉。

## 自测

1. `npm run check:js`、`npx vitest run tests/desktop`、`npm test` 全绿。
2. 纯逻辑抽成不碰 DOM 的函数并加单测（`tests/desktop/`，风格照 `settings-models.test.js`）。
3. Electron 实测（隔离）：空态、一张卡折叠/展开、多张卡、重名被拒、缺少密钥的状态显示、推荐模型 chips、测试连接失败与成功的展示；深色/浅色/高对比；1440 与 1100 宽无溢出。
4. 更新 `docs/specs/frontend-design.md` §7.9、`docs/archive/page-optimization-todolist.md`、`dev-notes/页面优化.md`。

## 交付

不要提交。报告：改了哪些文件、新的信息层级怎么分组的（附判断理由）、视觉上做了什么、键盘行为、自测命令与结果、需要人看的地方。
