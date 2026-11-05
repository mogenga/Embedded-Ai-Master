# Task Brief — 删除「浏览工作区文件」

仓库：`E:\Project\personal\Embedded-Ai-Master`，分支 `feat/page-optimization`（已存在。**不要建分支、不要 worktree、不要提交、不要 push**）。
界面代码在 `desktop/renderer/`，纯 ES 模块，无框架、无打包器、无构建步骤。

## 用户原话

> 直接删除浏览工作区文件。

## 范围：删掉「文件树」这一个 pane，保留「文件内容」那个 pane

先读代码分清两个不同的东西，**只删前一个**：

| pane id | 是什么 | 处置 |
|---|---|---|
| `files` | 顶栏 ⋯ 菜单「浏览工作区文件」打开的**目录树**（`#pane-tree`，`getTree`） | **删掉** |
| `file` | 点工具行 / 会话里的文件路径打开的**单文件内容**视图（`getFile`），`openWorkbench("file")` | **保留** |

用户说「浏览工作区文件」，指的就是菜单里那一项及其打开的目录树。单文件预览是另一条链路，别一起删。

## 要删的（先 grep 确认，不要照行号硬删）

1. **入口**
   - `index.html`：`#menu-browse-files` 这个 `menu-row`（连带它的 `data-i18n` 键）。
   - `index.html`：工作台 tab 条里的 `data-pane="files"` 那个按钮。
   - `app.js`：菜单分发里 `row.id === "menu-browse-files"` 的分支。
   - `i18n.js`：`menuBrowseFiles`、`paneFiles`（en + zh；删前 grep 全仓确认无他处引用）。

2. **目录树本体**（`app.js`）—— 这一整套是上一位子代理刚做的，要整块拆干净：
   - `treeRequests` 队列与它的所有用法（`requestTree`、`renderTree`、`expandTreeRow`、`collapseTreeRow`、`renderTreeHead`、`treeRow`、`treeNote`、`markTreeSelection`、`activeTreePath`/`state.treePath`/`treeExpanded` 及相关 localStorage 键 `prometheus.treeExpanded`）。
   - `tree` 事件的宿主回包分支（`getTree` 的 reply）。
   - `host_exit` 里的队列清理。
   - `openWorkbench` 里 `state.pane === "files"` 的分支、`showFiles`、`$("pane-tree").hidden = …`。
   - 记住 pane 的逻辑里对 `files` 的引用（`prometheus.workbenchPane` 若存的是 `files`，回退到 `serial`）。
   - `state.treePath` 在 `state` 事件里的 cwd 变化比较（那段只为重读树而存在）。

3. **样式**（`styles.css`）：`.tree-head`、`.tree-root`、`.tree-refresh`、`.tree-row`、`.tree-children`、`.tree-level`、`.tree-note`、`.file-tree`、`.pane-tree` 等只服务目录树的选择器。

4. **单文件 pane 不能因此坏掉**：`fileRoot` / `#file-root` / `showFile` / `openWorkbench("file")` 必须仍然可用。删完请**实测**：在会话里点一个文件路径，右侧仍打开内容。

## 不要删的

- `getTree` 的**宿主** handler（`desktop/host/host.js`）——本任务不碰宿主。删除后它没有渲染层调用方，在报告里记一句即可。
- `searchFiles` / `@` 提及（那是另一个命令，不属于「浏览工作区文件」）。
- 工作台的其它 pane（`serial` / `diff` / `artifact` / `terminal` / `browser` / `history` / `tasks`）。

## 顺带检查

- 删掉 `files` 后，`openWorkbench()` 在不传 pane 时回退到什么？现在是「记住的上次 pane，否则 serial」。`files` 不再存在时**不能**回退到一个不存在的 pane（会画出一个空面板）。改成回退 `serial`。
- `Escape` 关闭工作台的链路（上一位做的）要仍然工作。
- 工作台 tab 条里现在只剩 `serial` / `file` / `artifact` 三个，检查切换逻辑没有硬编码四个 tab 的地方。

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

## 并行区域（其它子代理此刻在改，不要碰）

- `desktop/renderer/settings.js` / `settings.css` / `settings-i18n.js` / `provider-presets.js` / `provider-meta.js`（另一个子代理在重构模型服务页）。
- `.composer*`、`.composer-status-tab`、`#input`、`.send-button`、`.composer-actions`。
- **可以改**：`app.js` 里目录树与工作台相关函数、`index.html` 的工作台区块与菜单行、`styles.css` 的 `.tree-*` / `.file-tree` / `.pane-tree`、`i18n.js`。改 `app.js` 用 Edit 精确替换，不要整文件重写。

## 绝对不要写用户的真实配置

```bash
mkdir -p /tmp/harness-rm && cd desktop
HARNESS_HOME=/tmp/harness-rm ./node_modules/.bin/electron main.js --remote-debugging-port=9340 --user-data-dir=/tmp/ud-rm
```

（用 **9340**；9333–9337 被占。）测完只关自己启的实例（按命令行匹配端口），**不要** `taskkill /IM electron.exe`。临时目录测完删掉。

## 自测

1. `npm run check:js`、`npx vitest run tests/desktop` 全绿。若 `tests/desktop/main-scope.test.js` 因删掉的顶层标识符报错，按其规则处理。
2. Electron 实测（隔离环境）：
   - 顶栏 ⋯ 菜单里**没有**「浏览工作区文件」。
   - 工作台 tab 条里没有 Files。
   - 会话里点文件路径 → 右侧仍显示文件内容。
   - 打开工作台（serial）→ Escape 关闭 → 焦点回到 `#more-button`。
   - 重开应用，工作台 pane 记忆不会试图恢复一个已删除的 pane。
   - 深色/浅色、1440 与 1100 宽下无异常。
3. 更新 `docs/frontend-design.md`（工作台/文件树小节）、`desktop/MATRIX.md`（`getTree` 行注明渲染层已无调用方）、`docs/page-optimization-todolist.md`、`dev-notes/页面优化.md`。

## 交付

不要提交。报告：删了哪些文件/函数/选择器、`getTree` 宿主 handler 的现状、单文件 pane 的实测结论、自测命令与结果、需要人看的地方。
