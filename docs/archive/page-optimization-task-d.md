# Task Brief — 删除「运行上限」部分所有功能

仓库：`E:\Project\personal\Embedded-Ai-Master`，分支 `feat/page-optimization`（已存在。**不要建分支、不要 worktree、不要提交、不要 push**）。
界面在 `desktop/renderer/`，纯 ES 模块，无框架、无打包器、无构建步骤。

## 用户原话

> 删除运行上限部分所有功能，同样发子代理

## 范围：只删 UI，不删内核

**删的是设置页「行为」页里的「运行上限」这一组控件**，以及渲染层为它维护的状态与保存路径。**不要动内核** `src/config/app-config.ts` 的 `run.json` 读写、不要动 `saveRunLimits` 的宿主 handler、不要动 schema。理由：`run.json` 还承载 `systemPrompt`（「系统提示」那一段），内核与宿主都依赖它；删内核会连带删掉别的东西，超出用户要求。

具体要删的（先读代码确认，别照行号硬删）：

- `desktop/renderer/settings.js`：`buildBehaviorPage` 里 `sGroup(s.groupRunLimits, [...])` 整组（含 `maxTurnsInput`、`maxCostInput`、`runTimeoutInput` 三个控件及其校验）与 `pane.appendChild(...)` 那一处；`saveRun` 中只被这三个控件使用的分支；`DEFAULT_RUN_LIMITS` 若只剩 `systemPrompt` 在用，就只保留该字段需要的部分（**别删 `systemPrompt` 的整条链路**）。
- `desktop/renderer/settings-i18n.js`：`groupRunLimits`、`behaviorMaxTurns*`、`behaviorMaxCost*`、`behaviorRunTimeout*`、`behaviorUnlimited` 等**只**被这组控件使用的键（en + zh 都要删；删前用 grep 确认没有别处引用）。
- `desktop/renderer/app.js`：若 `state.runLimits` 只被上面这些控件读写，删掉；若还被别处读（例如状态栏显示），**保留**并在报告里说明。
- `desktop/renderer/settings.css`：若有只服务这组的样式，删。

保留：`systemPrompt`（系统提示）整条链路、权限预设那一组。

## 你独占的代码区域（其它区域此刻有别人在改）

- **可以改**：`settings.js` 的 `buildBehaviorPage` 与其直接辅助函数、`settings-i18n.js` 的对应键、`app.js` 里 `state.runLimits` 的初始化与 `settings` 事件处理、相关 CSS。
- **禁止改**：`.composer*`、`--column-width`、`:root` 令牌（我在改）；模型面板（`renderModelMenu` / `modelGroups` / `buildProviderRail` / `.model-menu` / `.model-rail`）；模型服务页（`buildConnectionPage` / `makeCard` / `sProviderPicker` / `provider-presets.js`）——有另一个子代理在改。
- 改 `app.js` / `settings.js` 只用 Edit 做**精确字符串替换**，不要整文件重写。

## 顺带要处理的两处（读代码后判断，写进报告）

1. **`run.json` 里已有的 `maxTurns` / `maxCostUsd` / `timeoutMs` 值**：UI 删了之后用户无法再从界面看到或修改它们，但它们仍在文件里生效。这是**真实的行为**，不能装作不存在（R3）。二选一并说明理由：
   - (a) 在「行为」页留一句说明文字：「运行上限已不再在此页编辑，仍可通过 `run.json` 设置」，并给出文件路径（`state.configPaths` 里已有）；
   - (b) 保存时把这些字段写回 `null`／删除（**不推荐**：等于替用户改了他没要求改的语义）。
2. **`saveRunLimits` 这个命令本身**：宿主还有 handler，但渲染层不再发它。**不要删宿主的 handler**（本任务不碰宿主），在报告里记一句「命令保留、无调用方」即可。

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

## 绝对不要写用户的真实配置

任何会写配置的验证都必须先设 `HARNESS_HOME` 到临时目录，并用 **9335** 端口（9333/9334 被别的会话占用）：

```bash
mkdir -p /tmp/harness-test-limit
cd desktop && HARNESS_HOME=/tmp/harness-test-limit ./node_modules/.bin/electron main.js --remote-debugging-port=9335
```

测完只关自己启的实例，**不要** `taskkill /IM electron.exe`。临时目录测完删掉。

## 自测

1. `npm run check:js`、`npx vitest run tests/desktop`、`npm test` 全绿。若有测试断言了被删的行/按钮/命令，按新行为更新并在报告里列出。
2. Electron 实测（隔离 HARNESS_HOME）：「行为」页不再有运行上限三行；系统提示仍在且能保存；权限预设仍在且能切换；保存后 `run.json` 里的 `maxTurns` 等旧值**未被改动**。
3. 更新 `docs/specs/frontend-design.md` 的行为页小节、`dev-notes/页面优化.md` 追加一节（用户原话、关键产出、翻车与返工）。

## 交付

不要提交。报告：改了哪些文件、你的两处判断（旧值怎么处理、`saveRunLimits` 保留）、自测命令与结果、需要人看的地方。
