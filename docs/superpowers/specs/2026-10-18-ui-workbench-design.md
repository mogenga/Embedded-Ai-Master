# P0 前端工程（Web 工作台）实现设计

> 版本 v1.0 · 2026-10-18 · 状态：设计基线，等待实现
> 上位事实源：`docs/frontend-design.md` v1.1（设计契约与视觉令牌，本 spec 不重复其全部内容，只落地工程实现决策）；视觉基线：`prototypes/index.html`
> 本 spec 边界：只定义前端工程的目录结构、模块职责、构建/测试配置、类型接线、状态投影、验收映射；不定义内核行为，不修改内核语义。

---

## 1. 目标与范围

在 `feat/p0` 分支上落地一个可运行的 Web 工作台（诊断工作台），实现 `docs/frontend-design.md` 定义的三栏布局、三态主题、消息流组件、调试坞、状态栏与回放能力。工程必须与既有内核（`src/loop` / `src/session`）复用同一套事件类型，避免第二套投影逻辑。

### 1.1 范围内

- 前端工程脚手架：Vite 构建、Preact 组件化、vitest 组件测试环境（happy-dom）。
- 三栏工作台布局与响应式降级（对齐 frontend-design §4、§11）。
- 三态主题系统（light / system / dark），`localStorage` 键 `eam-theme`，默认 `system`。
- 全部 15 个组件规格（topbar / knowledge pane / session pane / conversation header / pathline / message stream / tool card / verdict card / guard notice / composer / dock / device monitor / port settings / debug log / status bar）。
- `TranscriptView` 纯函数归约（前端唯一视图模型；实时渲染与回放共用）。
- 真实数据源：新增最小只读 HTTP API（会话列表、会话事件回放、知识库树、设备状态），前端从 API 加载；无数据时显示空态。
- SSE + HTTP POST 客户端抽象（保留 `EventSource` 替换点）。
- 视觉验收脚本：V1-V14 在无头 Chromium 下实测（对齐 frontend-design §12）。

### 1.2 范围外

- 不做真实写操作与实时事件生产：`POST /api/actions` 与 `GET /api/events` 诚实返回未实现，不伪造成功。
- 不做设备/串口真实探测：`GET /api/device` 返回 `unknown`，不伪造连接状态。
- 不做移动端优先；窄屏仅"可用降级"。
- 不做 MCP server 工具清单与权限策略界面。
- 不改变 `src/loop` / `src/session` 现有语义；API 只读复用会话持久化。
- 生产代码零演示数据（fixtures、DEMO 常量一律移除）；测试内部可显式构造测试数据。

---

## 2. 技术约束（内联，完整，实施不得更改）

以下为已定案约束（来源：AGENTS.md 硬约束 + frontend-design §2）：

- **语言与运行时**：TypeScript + Node 24，ESM-only，禁止 CommonJS 混用；`package.json` `"engines": { "node": ">=24" }`。
- **前端框架**：**Preact + Vite**（2026-10-18 定案，OPEN-UI-01）。Preact 只承担组件化与增量 diff；会话状态都必须留在纯函数投影（`TranscriptView`）中，不得塞进组件内部状态。构建产物为 ESM；Vite 仅用于开发期与打包。
- **依赖**：`preact`（dependency）；`@preact/preset-vite`、`vite`、`happy-dom`（devDependencies）。`vitest` 已存在（^4.1.6，devDependencies）。除上述外**不新增任何依赖**。
- **Preact JSX 配置**：TypeScript `"jsx": "react-jsx"`、`"jsxImportSource": "preact"`（Context7 查证 @preact/preset-vite 官方要求）。
- **Vite 配置**：仓库根 `vite.config.ts` 使用 `plugins: [preact()]`、`build.outDir: "dist-web"`、`build.rollupOptions.input: "web/index.html"`（Context7 查证：`@preact/preset-vite` 官方入门）；入口 `web/index.html` → `src/ui/main.tsx`；产物 `dist-web/`。根 `vitest.config.ts` 优先于 `vite.config.ts` 被 vitest 读取，二者不冲突。
- **主题**：令牌定义在 `:root`（夜间基线）；日间令牌同时定义在 `[data-theme="light"]` 与 `@media (prefers-color-scheme: light) { [data-theme="system"] }`（frontend-design §6.2）。`localStorage` 键 `eam-theme`，值 `light | system | dark`，默认 `system`。切换不重载、不丢滚动位置。
- **零 emoji**：界面图标一律内联 SVG（页内 `<symbol>` sprite + `<use>`）；状态点、连接线、分隔线用 CSS 绘制；文案中不使用 emoji（含 `→` 之外的一切图形符号）。
- **样式**：所有颜色经 CSS 变量引用，组件中**禁止硬编码十六进制值**；令牌与组件样式集中在单一样式表 `src/ui/styles.css`，从 `prototypes/index.html` 提取，不引用原型文件。
- **测试**：vitest（当前仓库 `vitest ^4.1.6`）。内核测试保持 node 环境不变；UI 组件测试在文件头部使用 `// @vitest-environment happy-dom` 注释切换环境（避免改动全局 environment）。`vitest.config.ts` 的 `test.include` 扩展为 `tests/**/*.test.{ts,tsx,js}`，并加载 `plugins: [preact()]`（否则 Vitest 的 JSX 转换指向 react/jsx-runtime）；根 `tsconfig.json` exclude `src/ui` 与 `tests/ui`，前端由 `tsconfig.web.json` 检查。UI 逻辑纯函数（投影、主题解析、SSE 抽象）在 node 环境测试。
- **严格模式**：`strict: true`；相对导入带 `.js` 后缀；`verbatimModuleSyntax` 生效（类型导入用 `import type`）。
- **不加代码注释**：生产代码与样式不加说明性注释。
- **浏览器基线**：Chromium 系与 Firefox 当前稳定版；滚动条使用标准属性 `scrollbar-color` + `::-webkit-scrollbar` 双写（frontend-design §5.4）。
- **安全边界落到界面**：写内存 / 复位操作的确认流程必须存在且默认不生效（R2）；工具失败显式展示错误（R3）。
- **查证规则**：涉及库/框架用法必须已通过 Context7 核实（Preact preset-vite 配置、vitest happy-dom/projects 用法均已核实）。
- **Git 协作**：禁止 `git worktree`；只开分支；提交信息 `type(scope): 中文描述 ≤50 字`；依赖安装由用户手动执行（控制器不得运行 `npm install`）。

---

## 3. 工程结构

```
vite.config.ts                # 仓库根；plugins:[preact()]，input web/index.html，产物 dist-web/
web/
  index.html                  # Vite 入口（静态骨架：root 容器 + 内联首屏主题脚本）
src/server/
  api.ts                      # 只读 HTTP API（sessions / kb / device / actions / events）+ 静态资源
  serve.ts                    # 服务入口：HARNESS_UI_PORT / HARNESS_HOME / HARNESS_UI_STATIC
src/ui/
  main.tsx                    # 入口：读取主题 → render(<App/>)
  app.tsx                     # App 根：TopBar / Workspace(Rail, Conversation, Dock) / StatusBar
  state.ts                    # 工作台状态与请求竞态闸门
  theme.ts                    # 主题三态解析与切换（纯函数 + DOM 副作用分离）
  icons.tsx                   # <Icon name> 组件 + Symbol sprite 定义（可被测试引用）
  styles.css                  # 全部令牌 + 组件样式（从 prototypes/index.html 提取整理）
  components/
    topbar.tsx                # Brand / TargetChips / ThemeSwitch / DockToggle
    rail/knowledge-pane.tsx   # 检索框 + 知识库树（32px 行、chevron、aria-expanded）
    rail/session-pane.tsx     # 会话列表（进行中/历史分组、状态点）
    conversation/header.tsx   # 会话头（标题/状态胶囊/回放/导出）
    conversation/pathline.tsx # 五步诊断路径条
    conversation/stream.tsx   # 消息流容器（滚动、gap）
    conversation/messages.tsx # UserTurn / AgentTurn / AskBlock / Bubble 渲染
    conversation/tool-card.tsx      # ToolCard（readout / hitlist / evidence / 错误态 / 大输出折叠）
    conversation/verdict-card.tsx   # VerdictCard（根因/证据链/可证伪/动作归属）
    conversation/guard-notice.tsx   # GuardNotice（R2 确认提示）
    conversation/composer.tsx       # Composer（输入/Enter 发送/禁用态）
    dock/device-monitor.tsx   # 设备监控（字段/按钮/寄存器表）
    dock/port-settings.tsx    # 端口设置（select/统计卡）
    dock/debug-log.tsx        # 调试日志（时间/类型标记/文本，自动滚动与暂停）
    statusbar.tsx             # 状态栏（探针/串口/告警/会话/上下文/费用/平台）
  api/
    client.ts                 # /api 只读客户端（可注入 fetch）
    load.ts                   # 首屏并行加载与会话视图装载
  view/
    transcript.ts             # TranscriptView 归约（纯函数，可测，前端唯一视图模型）
    sse.ts                    # EventSource 抽象 + HTTP POST 动作客户端
tests/
  ui/                         # 前端测试（组件用 happy-dom 环境注释，纯逻辑 node 环境）
    transcript.test.ts        # 归约与投影规则
    transcript-consistency.test.ts # Session/Loop 双向归约一致性（V13）
    theme.test.ts             # 主题纯函数
    theme-dom.test.ts         # 主题 DOM 副作用（happy-dom）

scripts/
  verify-ui.mjs               # 无头 Chromium 视觉验收脚本（V1-V14，探针注入）
```

### 3.1 模块职责边界

- `view/transcript.ts` 是**唯一**状态归约处：输入 `SessionEvent[]` / `LoopEvent[]`，输出 `TranscriptView`。组件一律只读 `TranscriptView` 渲染，不得自行聚合事件。
- `theme.ts` 分离纯解析（`resolveTheme(choice, media)` → `"light" | "dark"`）与副作用（apply/persist）。
- `sse.ts` 提供 `createEventStream(url, handlers)`，内部持 `EventSource`，处理重连与 `interrupted`/`done` 分派；`postAction(url, body)` 走 HTTP POST。二者均为独立纯逻辑/薄封装，可注入 `fetch` 与 `EventSource` 以便测试。
- `icons.tsx` 暴露 `<Icon name="i-logo" size={16}/>`，内部 `<use href="#<name>">`；sprite 声明为受控 SVG（`aria-hidden` + `focusable=false`）。
- 每个组件文件使用**命名导出**（`export function Xxx`），不提供默认导出；无内部私有状态（除 Composer 输入框、Dock 分区折叠、GuardNotice 本地确认态等**纯 UI 局部态**，与业务状态无关）。

### 3.2 构建与测试命令（合并进根 package.json）

```jsonc
{
  "scripts": {
    "build:web": "vite build",
    "dev:web": "vite",
    "verify:ui": "node scripts/verify-ui.mjs",
    "test:ui": "vitest run tests/ui",
    "typecheck:web": "tsc -p tsconfig.web.json --noEmit"
  }
}
```

类型检查采用两个 tsconfig：内核 `tsconfig.json`（现状不动）与 `tsconfig.web.json`（extends 内核，`include: ["src/ui", "web", "tests/ui"]`，补 `"jsx": "react-jsx"`、`"jsxImportSource": "preact"`、`lib` 加 DOM）。内核 build（`tsconfig.build.json`）**排除 `src/ui`**，避免前端代码进入内核产物；Web 产物由 Vite 单独产出 `dist-web/`。

---

## 4. 类型接线

前端复用内核现有类型，不复制定义（`import type` + 相对导入 `.js` 后缀）：

| 内核来源 | 类型 | 前端用途 |
|---|---|---|
| `src/session/types.ts` | `SessionEvent` / `EventType` / `AssistantPayload` / `ToolResultPayload` | TranscriptView 归约输入、回放 |
| `src/loop/events.ts` | `LoopEvent`（已扩展 `tool_result` 透传 `code`/`detail`/`artifactPath`） | 实时渲染输入（V13 与回放共用归约） |
| `src/tools/types.ts` | `ToolAnnotations` | 工具卡语义（readOnly / evidence / destructive） |

**禁止**：前端在 `src/ui/` 重新声明上述类型或字段。

---

## 5. 状态投影（TranscriptView）

`view/transcript.ts` 导出：

```ts
export type TranscriptStep = "symptom" | "triage" | "kb" | "probe" | "verdict";
export interface TranscriptView {
  steps: Array<{ id: TranscriptStep; label: string; state: "done" | "now" | "todo" }>;
  status: "idle" | "diagnosing" | "done" | "interrupted";
  events: TranscriptEvent[];          // 保序、只读
  usage?: { prompt: number; completion: number; cached: number; costUsd?: number };
  context?: { used: number; limit: number };
  cost?: number;
  sessionId?: string;
  interruptReason?: string;
}
export type TranscriptEvent =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "ask"; text: string; note?: string }
  | { id: string; kind: "tool"; tool: ToolCardModel }
  | { id: string; kind: "verdict"; verdict: VerdictCardModel }
  | { id: string; kind: "guard"; guard: GuardModel }
  | { id: string; kind: "interrupted"; reason: string };
```

规则（对齐 frontend-design §8.2 投影表）：

- `user` 事件 → 用户气泡；`assistant`（content 非空）→ agent 气泡；`assistant`（toolCalls 非空）→ 工具卡骨架；`tool_result` → 对应工具卡结果区；`usage` → `view.usage` 与费用；`status` → 状态胶囊；`interrupted` → 中断提示（danger）并保留既有证据；`checkpoint` / `compaction` 不直接渲染。
- 工具结果优先级：`detail` 可映射结构化行（readout / hits / evidence）时用结构化形态；否则 `text` 非空时 `kind:"readout"` 并把原文放入 `ToolCardModel.text`；`text` 为空时 `kind:"error"`、`errorCode:"empty_result"`、`errorText:"工具未返回读数"`。`artifactPath` 原样保留到 `ToolCardModel.artifactPath`。
- 工具骨架创建时 `ok:true, pending:true`；收到结果后清除 `pending`。
- `ToolCardModel` 在既有字段上新增 `text?: string`、`artifactPath?: string`、`pending?: boolean`。
- 工具结果 `ok=false` 必须渲染 `code` 与错误文本，不得渲染空白读数。
- `status` 事件：`payload.status === "done"` → `view.status = "done"`；`"usage_missing"` → 保持 `"diagnosing"` 并记录 `interruptReason`（不产生中断事件）；未知值忽略。
- `usage` 事件累加 `prompt/completion/cached` 与 `costUsd`；`view.cost` 取累加后的 `costUsd`（无 usage 时不推断）。`LoopEvent.turn_end.costUsd` 同样累加，`done`/`interrupted` 与 Session 归约终态一致。
- `view.context` 与 `view.sessionId` 由宿主提供；演示态使用 `DEMO_SESSION_ID = "#128"`，缺失时 StatusBar 显示 `—`。
- 写类工具（destructive）默认进入"待确认"，未确认不显示已执行。
- 归约必须是纯函数、确定性；同一事件序列输入两次必须得同一 `TranscriptView`（V13 一致性前提）。
- 组件只消费 `TranscriptView`。

---

## 6. 组件规格映射

每个组件严格落地 frontend-design §7 对应小节（尺寸、令牌、aria 属性、动效 160ms、`prefers-reduced-motion` 关闭过渡）。映射表供实现与审查对照，不逐条复制设计文档原文：

| frontend-design § | 组件 | 关键硬性点 |
|---|---|---|
| 7.1 | TopBar | 48px 高；三段栅格 `264px | 1fr | auto`；ThemeSwitch 30×24、`aria-pressed` |
| 7.2 | KnowledgePane | 检索框高 30、占位「kb_lookup · 寄存器名 / 错误码 / 症状」；树行 32px；chevron 旋转 90°；当前厂商 `--accent-soft` 底 |
| 7.3 | SessionPane | 分组标题 10.5px 弱色；状态点 run/warn/idle；当前会话 `--bg-active` 底 + 1px `--border` |
| 7.4 | ConversationHeader | 40px 高；左右对齐 20px；回放/导出次级按钮 |
| 7.5 | PathLine | 五步固定序列；done/now/todo 三态样式；步间连线 14×1px `--border-strong` |
| 7.6 | MessageStream | 容器 20px 内边距、条目 20px gap；用户靠右 max 540px；AskBlock 左 2px `--info` 竖条 |
| 7.7 | ToolCard | 卡头 34px `--bg-inset`；三种卡体形态；text-only 渲染纯文本并按行数/字节数折叠；骨架 `pending` 显示「执行中」不显示成功勾；`readOnly` 以中性色标记；失败标记 `--danger`；大输出折叠「摘要 + 行数 + 展开」 |
| 7.8 | VerdictCard | `--accent-line` 1px 边；四区块；动作归属三列等宽；置信度高/中/低 |
| 7.9 | GuardNotice | `--warn` 1px 边 + `--warn-soft` 底；写明操作类型/目标地址/写入值/当前状态；待确认渲染「确认写入」「拒绝」，`onConfirm`/`onReject` 由宿主提供；确认后本地仅「执行中」，仅当外部 state 为「已执行」才显示已执行 |
| 7.10 | Composer | 22px 起随内容长到 120px；Enter 发送 Shift+Enter 换行；空输入禁用发送 |
| 7.11 | Dock | 404px（<1180 340px）；分区头 38px 可折叠 `aria-expanded` |
| 7.12 | DeviceMonitor | 标签列 96px；复位按钮 danger 语义进确认流程；寄存器异常值 `--warn` 保留原文本 |
| 7.13 | PortSettings | 原生 select；错误帧非 0 用 `--danger`；未打开端口统计显示 `—` 不显示 `0` |
| 7.14 | DebugLog | 三列时间 56px/标记/文本；发送 `--wave-4` 接收 `--wave-1` KB `--wave-2` 错误 `--danger`；上滚后暂停自动滚动 |
| 7.15 | StatusBar | 26px 高；左右分区；数值 `tabular-nums` 等宽 |

---

## 7. 数据 API 与实时通道

### 7.1 只读 HTTP API（`src/server/api.ts`）

服务端只读复用 `src/session/persistence.ts` 的 `readSessionDir`，不改变内核语义。所有响应 `Content-Type: application/json`；错误响应 `{ error: { code, message } }` 与对应状态码。

| 方法 | 路径 | 响应 | 说明 |
|---|---|---|---|
| GET | `/api/sessions` | `{ sessions: SessionSummary[], errors: Array<{ dir, code }> }` | 扫描 `resolveHarnessHome()/sessions/*`，按 `header.createdAt` 倒序；`id` 一律取目录名，header 只读不解析事件；`header.id` 不一致进 `errors`（`id_mismatch`），读取失败进 `unreadable`，不影响其余会话 |
| GET | `/api/sessions/:id` | `{ header: SessionHeader, events: SessionEvent[] }` | 校验 id 仅含 `[A-Za-z0-9._-]` 且解析后位于会话根内；不存在 → 404 `session_not_found` |
| GET | `/api/kb` | `{ root: string \| null, tree: KbNode[] }` | 扫描 `resolveHarnessHome()/kb`；目录不存在 → `root:null, tree:[]` |
| GET | `/api/device` | `{ probe: "unknown", serial: "unknown", cpu: "unknown", backend: "unknown" }` | 未接真实探测，诚实返回 unknown |
| POST | `/api/actions` | 501 `{ error: { code: "action_not_implemented" } }` | 不伪造受理 |
| GET | `/api/events` | 501 `{ error: { code: "event_stream_not_implemented" } }` | SSE 未实现 |

`SessionSummary = { id, createdAt, status, model?, workdir? }`。
`KbNode = { name, path, kind: "dir" | "file", children?: KbNode[] }`，目录优先排序，深度上限 8 层，条目上限 2000。

静态资源：API 服务同源 serve `dist-web/`，`/` 与 `/web/index.html` 返回 `dist-web/web/index.html`；未命中静态与 API → 404；解码后含 NUL 或 `..` 段 → 400 `invalid_path`。开发期 `vite.config.ts` 将 `/api` 代理到 `http://127.0.0.1:${HARNESS_UI_PORT ?? 5174}`。

### 7.2 前端 API 客户端（`src/ui/api/client.ts`）

```ts
export interface SessionSummary { id: string; createdAt: string; status: "open" | "closed"; model?: string; workdir?: string }
export interface KbNode { name: string; path: string; kind: "dir" | "file"; children?: KbNode[] }
export interface DeviceStatus { probe: string; serial: string; cpu: string; backend: string }
export async function fetchSessions(deps?: { fetchImpl?: typeof fetch }): Promise<{ sessions: SessionSummary[]; errors: Array<{ dir: string; code: string }> }>;
export async function fetchSession(id: string, deps?: { fetchImpl?: typeof fetch }): Promise<{ header: SessionHeader; events: SessionEvent[] }>;
export async function fetchKb(deps?: { fetchImpl?: typeof fetch }): Promise<{ root: string | null; tree: KbNode[] }>;
export async function fetchDevice(deps?: { fetchImpl?: typeof fetch }): Promise<DeviceStatus>;
```

非 2xx 抛 `{ code, status }`；网络异常上抛。所有函数必须可注入 `fetchImpl` 以便 vitest node 环境测试，且请求相对路径 `/api/...`（dev 走 Vite proxy，生产同源）。

### 7.3 实时通道抽象（保留）

`view/sse.ts` 保留 `createEventStream` / `postAction`（接口与行为见 Task 9/11/12）。配置 `VITE_EVENT_STREAM_URL` 时订阅实时事件并累积归约；未配置时以 `GET /api/sessions/:id` 的真实会话事件回放。`VITE_ACTION_URL` 未配置时发送按钮禁用并给出可见说明（D-053）。

### 7.4 真实数据与空态（禁止演示数据）

- `src/ui/demo/fixtures.ts` 删除；生产代码不得再出现 UART 演示会话、固定知识库树、固定会话列表、DEMO 寄存器/日志常量。
- 会话列表来自 `fetchSessions`；选中会话事件来自 `fetchSession` 并交给 `transcriptFromSession`。
- 知识库树来自 `fetchKb`；设备字段来自 `fetchDevice`（`unknown` 显示「未接入」，不显示「已连接」）。
- 调试坞日志从 `TranscriptView.events` 的工具事件派生；寄存器从工具结果 `detail` 中出现 `registers`/`readout` 时派生；无数据时显示空态说明。
- 加载失败显示错误与重试入口；无会话显示「暂无会话」；无 KB 显示「未配置知识库」。
- 测试内部数据放 `tests/ui/support/builders.ts`，不得被生产代码 import。

---

## 8. 验收映射（V1-V14）

frontend-design §12 的 14 项验收由 `scripts/verify-ui.mjs` 在无头 Chromium 下实测（沿用原型验证同款探针注入法），实现后必须逐项通过。验收脚本读取 `dist-web/` 构建产物页面，注入几何探针并断言：

| 验收 | 断言方法 |
|---|---|
| V1 三栏头部对齐 | 左/中/右栏头 boundingClientRect：y=48, height=40 |
| V2 栏宽 | 左 264、右 404（≥1180px）；主区 = 视口 − 664 |
| V3 内容对齐 | 内容宽 = 主区宽 − 40 |
| V4 无横向溢出 | `document.scrollWidth === innerWidth` |
| V5 无文本截断 | 关键文本元素 scrollWidth ≤ clientWidth + 1 |
| V6 知识库树完整 | 717px 高工作区下默认展开树不裁剪 |
| V7 滚动条配色 | dark/light thumb 计算色符合令牌表 |
| V8 滚动条占位 | 出现滚动条时实占 10px、无横向溢出 |
| V9 三主题解析 | light/dark/system 的 canvas/accent 计算值符合 §5.1 |
| V10 无 emoji | 页面文本扫描无 emoji 码点 |
| V11 焦点可见 | Tab 遍历控件均有可见焦点环 |
| V12 减少动效 | 开启 reduce 后无过渡与平滑滚动 |
| V13 回放一致性 | `tests/ui/transcript-consistency.test.ts` 断言同一会话的 `SessionEvent[]`/`LoopEvent[]` 归约组件序列与工具名序列一致；验收脚本检查该文件存在且含双向归约断言，不写死 PASS |
| V14 写操作确认 | 未确认时界面不显示"已执行" |

运行 `npm run build:web` 后执行 `npm run verify:ui`（依赖系统 Chromium 可执行文件，见脚本 TOCTOU 探测：找不到可执行文件时报明确错误）。

---

## 9. 测试策略

- **内核测试**：`tests/` 现状不动，node 环境。
- **前端逻辑测试**（node 环境）：`tests/ui/transcript.test.ts`（归约、投影规则、pending/text/status/usage/cost 投影、ok=false 错误渲染）、`tests/ui/transcript-consistency.test.ts`（Session/Loop 双向归约一致性）、`tests/ui/theme.test.ts`（三态解析纯函数）、`tests/ui/sse.test.ts`（重连、close、POST 错误）。
- **组件测试**（happy-dom，文件头 `// @vitest-environment happy-dom`）：`tests/ui/components/` 下对齐每个组件文件，断言渲染结果与交互（点击折叠、aria 属性、禁用态、`use` 引用图标、无硬编码颜色断言通过 spot check）。
- **验收**：`scripts/verify-ui.mjs` 无头 Chromium 实测 V1-V14。
- 每任务 TDD：先写失败测试（RED）→ 最小实现（GREEN）→ 全量验证 → 提交。

---

## 10. 数据来源与空态

- 生产数据只来自 §7.1 的真实 API 与 §7.3 的实时通道；`src/ui/demo/fixtures.ts` 与 `DEMO_*` 常量删除。
- 无会话、无知识库、设备未知、API 失败均有明确空态/错误态，不使用占位数据填充。
- 测试数据集中在 `tests/ui/support/builders.ts`（`makeSessionEvents()` 等），仅供测试 import。
- 验收脚本构造真实临时会话目录（写真实 `header.json` + `session.v1.jsonl`）交给 API 服务，页面从 API 加载；脚本不向前端注入数据。

---

## 11. 决策记录（本 spec 新增）

| ID | 结论 | 依据 |
|---|---|---|
| UI-SPEC-01 | 前端代码置于 `src/ui/`，与内核同仓同类型域；Web 构建独立 tsconfig.web.json + Vite 产物 `dist-web/` | 复用内核事件类型避免第二套投影；内核构建不被前端 JSX 污染 |
| UI-SPEC-02 | UI 组件测试用文件头 `// @vitest-environment happy-dom` 切换环境，不改全局 vitest config | 内核测试保持 node 环境零扰动；vitest 官方支持 per-file environment 注释 |
| UI-SPEC-03 | 组件测试在 happy-dom 断言结构/aria/交互；几何与浏览器行为（V1-V12、V14）全走无头 Chromium `verify-ui.mjs` | happy-dom 不测真实几何布局；浏览器基线为 Chromium 系 |
| UI-SPEC-04 | ~~本阶段不回接真实 SSE 服务端，交付 `EventSource` 抽象 + fixture 回放~~（被 UI-SPEC-05 取代） | 服务端未实现时的过渡决策 |
| UI-SPEC-05 | 生产代码零演示数据；新增最小只读 HTTP API（会话/事件回放/KB 树/设备状态），实时与写操作诚实返回未实现；无数据显示空态 | 用户 2026-10-18 明确"不要 mock 数据"；BR-6 回放必须来自真实会话日志 |

---

## 12. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-10-18 | 首版：依据 frontend-design.md v1.1 与 prototypes/index.html 落地前端工程实现决策 |
| v1.1 | 2026-10-18 | 用户要求"不要 mock 数据"：新增只读 HTTP API 契约（§7.1-7.4），删除演示数据源（§10），UI-SPEC-05 取代 UI-SPEC-04 |