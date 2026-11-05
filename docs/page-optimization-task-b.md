# Task Brief — 模型服务页重构 + 对话模型面板按 API Key 划分

仓库：`E:\Project\personal\Embedded-Ai-Master`，分支 `feat/page-optimization`（已存在，直接在上面改。**不要新建分支、不要用 git worktree、不要提交、不要 push**）。
界面代码全在 `desktop/renderer/`，纯 ES 模块，**无框架、无打包器、无构建步骤**。内核在 `src/`，本任务**不改内核**。

## 用户原话

> 1. 模型服务页面整体重构优化，可配置多个相同厂商 APIKEY，但必须区分显示名称。
> 2. 对话框模型选择左侧侧边栏显示配置的厂商（主流厂商+自定义），根据厂商（APIKEY）划分模型

## 现状（先读代码，别猜）

- `providers.json` 是一张 **以服务名为键的 map**：`{ "deepseek": { protocol, baseUrl, apiKey, models: {...} }, ... }`。键就是模型引用 `服务/模型` 的前半段。**同名键在 JSON 里不可能共存**，所以「多个相同厂商」现在只能靠手工起两个名字（`deepseek-work` / `deepseek-home`），而 UI 上没有任何东西告诉你这两张卡是同一家厂商、也没有「显示名称」这个概念。
- 设置页每张卡片：`desktop/renderer/settings.js` 的 `buildConnectionPage` → `makeCard`（约 1201 行）。卡内第一行是厂商下拉 `sProviderPicker`（约 300–420 行 + 卡片内接线），选项来自 `provider-presets.js` 的 `providerPickerOptions`。
- 厂商下拉当前**把「另一张卡已占用同名」的选项置灰**（`disabled`），因为名字冲突时保存会被 `connNameDuplicate` 拦下。这就是「同一家厂商只能配一次」的直接原因。
- 对话页模型面板：`desktop/renderer/app.js` 的 `renderModelMenu`（约 2448 行）→ `modelGroups()`（按 `providerOf(id)` 分组）→ `buildProviderRail`（左栏，`role="tablist"`，两字母字标 `providerMark`）。左栏**只在分组数 > 1 时出现**。
- 宿主下发的模型条目形状（`desktop/host/host.js:678` `buildModelList`）：`{ id: "服务/模型", name, contextLength, supportsTools, supportsReasoning, supportsVision }`。**条目里没有厂商信息**——厂商目前只能从 `id` 的前缀（= 服务名）推。

## 要做的事

### 1. 模型服务页：同一厂商可配多个 Key，用「显示名称」区分

核心思路：**把「服务名（写入文件的键）」与「显示名称（人看的）」分开**，并给每张卡记一个**厂商归属**。

- 卡片里厂商下拉不再置灰：同一厂商可以被任意多张卡选中。
- 卡片新增一个**显示名称**输入（默认等于服务名，用户可改）。它只是给人看的标签，**不进 `providers.json` 的键**，所以：
  - 存哪里：`providers.json` 的 provider 对象里加一个字段。`ProviderConfigSchema`（`src/config/providers.ts:72`）是 Zod 的 `z.object`，**默认会剥掉未知键**（Zod 默认 strip）。所以要么**不要写进文件**（推荐：存渲染层 localStorage，按「服务名」索引），要么改内核 schema。**本任务不改内核**，因此：显示名称与厂商归属都存 `localStorage`，键名自拟（例如 `prometheus.providerMeta`），结构 `{ "服务名": { displayName, vendor } }`。
  - **删卡时要清掉对应的 meta**，否则以后新建同名服务会继承旧标签。
  - 文件里只有服务名，文件被人手改过（服务被删/改名）时，meta 里孤立条目要**静默忽略**，不要报错、不要显示。
- 服务名自动生成改成**不再与厂商 id 相同**，避免第二张同厂商卡默认就叫 `deepseek` 撞名。建议：第一张用厂商 id（保持现有行为，向后兼容），后续用 `厂商id-2`、`厂商id-3`；纯自定义则 `provider1`、`provider2`…（现有 `nextName()` 已有这套逻辑，扩展它）。
- 卡片头部与折叠态显示「显示名称」，其次一行小字显示服务名与厂商。两处都要能一眼区分两张名字不同的同厂商卡。
- 保存前校验：**显示名称不能重复**（两个卡都叫「DeepSeek 工作」会让人分不清），服务名仍按现有规则唯一。显示名称重复要像现有 `connNameDuplicate` 那样就地报错并聚焦该字段。

### 2. 对话页模型面板：左栏按「厂商（API Key）」

现在的左栏是按**服务名**分组，且服务名是机器起的（`deepseek`、`kimi`），用户看不出哪个 Key 是哪个。改成：

- 左栏每一项 = **一个已配置的服务（一张卡 / 一个 API Key）**，显示：厂商图标（`vendor-marks.js` 的 `VENDOR_MARKS`，自定义厂商用 `providerMark` 字标）+ **显示名称**。
- 右栏只显示该服务的模型。
- 有多个服务时左栏必现；只有一个服务时**仍然隐藏左栏**（现有逻辑，保持）。
- 左栏需要「厂商 + 显示名称」两样信息，而 `models` 事件里没有。可选做法（挑一个，说明理由）：
  - **(a)** 宿主在 `models` 条目里补 `provider` 与 `displayName` 字段（要改 `desktop/host/host.js` 的 `buildModelList`，但**不动内核**；显示名称来自 localStorage，宿主读不到，所以宿主只能给 `provider` 字段，`displayName` 由渲染层自己按服务名查 localStorage 拼）；
  - **(b)** 渲染层不改宿主，靠 `providerConfig`（`settings` 事件里已有整份文件）与 localStorage 自己拼出 `服务名 → {厂商, 显示名称}` 这张表，模型面板直接从这张表取。
  
  推荐 **(b)**：`state.settings.providerConfig` 已经在渲染层里，`settings` 事件在启动时就会到；不需要碰宿主。但要处理「设置页改了配置 → 模型面板的标签要跟着变」：`saveProviders` 成功后会推新的 `settings`，渲染层监听并刷新即可（确认这条链路存在）。

### 3. 不要做的事

- **不改内核** `src/`、不改 `providers.json` schema、不新增依赖、不引入框架/打包器/构建步骤。
- **不伪造**（R3）：厂商归属是根据用户选的下拉项记的，**不要**从 baseUrl 猜厂商；显示名称缺失时显示服务名，不要编一个。
- 不删 `provider-presets.js` / `vendor-marks.js`。
- 不动输入区（那是上一轮刚定的形状）。

## 硬约束（原样来自 AGENTS.md）

### 危险命令测试禁令（强制）

任何测试、探针、演示、子代理任务都**禁止在宿主机真实执行可能造成破坏的命令**，包括但不限于：`del /s /q <盘符根>`、`rm -rf /`、`rm -rf ~`、`format`、`diskpart`、`mkfs*`、`dd ... of=/dev/...`、`shutdown`/`reboot`/`poweroff`/`halt`、fork bomb、`reg delete HKLM`、`bcdedit`、`cipher /w`。

危险命令测试必须分两层，缺一不可：

1. 纯函数断言拦截器识别（如 `expect(isDangerousCommand(cmd)).toBe(true)`）；
2. 若测试 `execute`，必须先完成第 1 层断言，再调用 `execute`，并断言底层 `spawn`/`exec` **未被调用**。

- 禁止为制造 RED 而真实执行危险命令；RED 只能由纯函数断言或注入 mock 产生。
- 真实命令测试只允许无害、跨平台、无副作用的命令（如 `node -e "console.log(...)"`），并限定在临时 workdir。
- 违反即停止：立即停止当前任务、报告用户、不得重试，并把事故写入 `dev-notes`。

### 依赖安装禁令（强制）

- **禁止执行任何依赖安装/变更命令**：`npm install`、`npm ci`、`npm update`、`yarn`、`pnpm`、`bun install` 等。
- 写文档/文件禁止用 `node -e`、`bash -c` 拼接含反引号、`$()`、`${}` 的文本；一律用 Write/Edit 或独立脚本文件。
- 违反即停止：报告用户、记录 `dev-notes`、不得重试。

## 绝对不要写用户的真实配置（本会话已发生过一次）

验证「保存」路径时**必须先确认 `HARNESS_HOME` 指向测试目录**：

```bash
mkdir -p /tmp/harness-test
# 写一份只含假 provider 的 providers.json 到 /tmp/harness-test/
cd desktop && HARNESS_HOME=/tmp/harness-test ./node_modules/.bin/electron main.js --remote-debugging-port=9333
```

测完只关掉**自己启动的那个实例**（按命令行匹配 `--remote-debugging-port=9333`），**不要** `taskkill /IM electron.exe`，那是用户的窗口。临时目录测完删掉。

## 自测要求

1. `npm run check:js`、`npx vitest run tests/desktop`、`npm test` 全绿。
2. 新增纯逻辑（显示名称/厂商归属的读写、服务名自动生成、重名判定、面板左栏的数据表拼装）抽成**不碰 DOM 的纯函数**并加单测，放 `tests/desktop/`，风格照 `settings-models.test.js`。
3. Electron 实测（隔离 `HARNESS_HOME`）：
   - 建两张 DeepSeek 卡，分别填不同 Key 与不同显示名称 → 都能选中 DeepSeek、都能保存、头部显示各自的显示名称。
   - 把两张卡的显示名称改成一样 → 保存被拒并聚焦。
   - 对话页模型面板左栏出现两项（DeepSeek 图标 + 两个显示名称），点击切换右栏模型列表。
   - 只有一张卡时左栏消失。
   - 深色 / 浅色主题、1440 与 1100 宽度下无溢出。
4. 顺手更新：`docs/frontend-design.md`（设置页与模型面板两节）、`docs/page-optimization-todolist.md`、`desktop/MATRIX.md` 若有能力表变化、`dev-notes/页面优化.md` 追加一节（用户原话、关键产出、翻车与返工）。

## 交付

不要提交。报告里写：改了哪些文件、两个关键数据决策（显示名称存哪、面板左栏怎么拿到厂商信息）及理由、键盘行为、自测命令与结果、需要人看的地方。
