# Task Brief — 浏览工作区文件的显示与关闭优化

仓库：`E:\Project\personal\Embedded-Ai-Master`，分支 `feat/page-optimization`（已存在。**不要建分支、不要 worktree、不要提交、不要 push**）。
界面在 `desktop/renderer/`，纯 ES 模块，无框架、无打包器、无构建步骤。

## 用户原话

> 发子代理，优化浏览工作区文件的显示和关闭窗口功能

## 你独占的代码区域（其它区域此刻有别人在改，**碰了会互相覆盖**）

- **可以改**：`app.js` 里「文件树 / 工作台」相关的函数与事件——`renderTree`（约 5252 行）、`openWorkbench` / `closeWorkbench`（约 4189 / 4227）、`fileTree`（约 50 行）、`workbench` 相关的点击与快捷键（约 5074 / 5394 / 6223 / 7405 / 7409 / 7645）、`showFile`、`getTree` 的处理分支（约 4146 / 5291）。
- **可以改**：`index.html` 里 `<section class="workbench" id="workbench">` 整块（约 394–470 行）、顶栏 `#menu-browse-files`（约 127 行）。
- **可以改**：`styles.css` 里 `.workbench*`、`.pane-tree`、`.file-tree`、`.file-row`、`.tree-*`、`.workbench-resizer`、`.workbench-head`、`.workbench-tabs`、`.workbench-meta` 这些选择器。
- **禁止改**：`.composer*`、`.composer-status-tab`、`#input`、`.send-button`、`.composer-actions`、`--column-width`、`:root` 里的令牌（我在改）。
- **禁止改**：模型面板（`renderModelMenu` / `modelGroups` / `buildProviderRail` / `.model-menu` / `.model-rail`）、设置页（`settings.js` / `settings.css` / `settings-i18n.js` 整体）。
- 改 `app.js` 只用 Edit 做**精确字符串替换**，不要整文件重写。

## 现状

- 顶栏菜单「浏览工作区文件」→ `openWorkbench("files")` → 右侧工作台面板（`.workbench`，宽 320–560px，可拖拽调宽）显示文件树 `#pane-tree`。
- `getTree` 真实可用：列一层子项（`listDirectory`，目录在前、按名排序、跳符号链接、超 500 项截断）。失败时宿主先发 warn notice **再**发空 `tree`（空树是释放等待的信号，不是「目录是空的」）。
- 关闭手段：工作台头部的 `#close-workbench` 按钮。**没有 Escape**，没有点外部关闭，没有记住上次的 pane。
- 点击文件会切到「文件」页签显示内容（`showFile`）。

## 要做的事

先自己打开界面看一遍（`cd desktop && npm run desktop`），再决定改什么。至少覆盖：

1. **浏览体验**：层级缩进、当前选中项、展开/折叠的可读性、长文件名的处理、空目录与加载中的状态、深色/浅色两套主题下都清楚。目录与文件要能一眼分辨（图标或字重，不要只靠颜色 —— 无障碍要求状态不只靠颜色）。
2. **关闭**：Escape 关闭工作台（注意：输入框有焦点时 Escape 可能另有含义，先读现有键盘处理再决定优先级；模型菜单展开时 Escape 属于菜单，不能抢）。关闭后焦点要回到打开它的那个按钮上。若当前没有别的关闭路径，这就是「关闭窗口功能」的主要缺口。
3. **状态保持**：工作台打开过哪个 pane、宽度、是否展开某目录，重新打开时应当合理（现状宽度已记住，pane 未记住）。**不要**为了记住而写入 `providers.json` 或任何配置文件；用 localStorage。

不要做的事：不改内核、不改宿主、不加依赖、不引入虚拟滚动之类的重写（500 项上限已被宿主截断，普通 DOM 够用）。

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

任何会写配置的验证都必须先设 `HARNESS_HOME` 到临时目录：

```bash
mkdir -p /tmp/harness-test
cd desktop && HARNESS_HOME=/tmp/harness-test ./node_modules/.bin/electron main.js --remote-debugging-port=9334
```

（用 **9334**，9333 被别的会话占用。）测完只关自己启的实例，**不要** `taskkill /IM electron.exe`。临时目录测完删掉。

## 自测

1. `npm run check:js`、`npx vitest run tests/desktop` 全绿（若你的改动影响 `tests/desktop/main-scope.test.js` 覆盖的 id 或作用域，一并修）。
2. Electron 实测：打开文件树、展开/折叠、点文件、Escape 关闭、关闭后焦点回到按钮、重开保持上次 pane；深色/浅色；1440 与 1100 宽；长文件名与深层目录不溢出。
3. 更新 `docs/specs/frontend-design.md` 里工作台/文件树相关小节，`dev-notes/页面优化.md` 追加一节（用户原话、关键产出、翻车与返工）。

## 交付

不要提交。报告：改了哪些文件、具体的体验改动清单、Escape 的优先级判断、自测命令与结果、需要人看的地方。
