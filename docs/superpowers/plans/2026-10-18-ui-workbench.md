# P0 前端 Web 工作台实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `feat/p0` 分支上落地可运行的前端 Web 工作台（三栏布局、三态主题、消息流组件、调试坞、状态栏、回放），复用内核事件类型，前端唯一视图模型为纯函数归约 `TranscriptView`。

**Architecture:** 前端代码置于 `src/ui/`，与内核同仓共享类型（`SessionEvent` / `LoopEvent` / `ToolResultPayload` / `ToolAnnotations`）。Vite + Preact 负责组件化与构建（产物 `dist-web/`），Web 独立 tsconfig（`tsconfig.web.json`）。全部业务状态经 `view/transcript.ts` 纯函数归约；组件只消费 `TranscriptView` 渲染。UI 组件测试用 `// @vitest-environment happy-dom` 文件头切换环境；几何与浏览器行为（V1-V14）由 `scripts/verify-ui.mjs` 无头 Chromium 实测。

**Tech Stack:** Preact（dependency）+ Vite + `@preact/preset-vite` + happy-dom（devDependencies）＋既有 vitest ^4.1.6；TypeScript strict / ESM-only / Node 24。新增依赖仅此四项，其余不新增。

**Spec:** [2026-10-18-ui-workbench-design.md](../specs/2026-10-18-ui-workbench-design.md)

## Global Constraints

- Node >= 24, ESM-only, strict, 相对导入带 `.js` 后缀, `verbatimModuleSyntax`（类型导入用 `import type`）；不新增除 preact/@preact/preset-vite/vite/happy-dom 外任何依赖。
- **含 JSX 的文件一律用 `.tsx` 扩展名**（`.ts` 不能解析 JSX；Task 1 已实测该错误同时破坏 typecheck 与 lint）。
- 内核测试与配置零扰动：不改 `vitest.config.ts` 的全局 environment；UI 测试文件头部写 `// @vitest-environment happy-dom`；`vitest.config.ts` 增 `plugins: [preact()]`（否则 Vitest 的 JSX 转换会指向 react/jsx-runtime）；根 `tsconfig.json` 增 exclude `src/ui`、`tests/ui`（前端由 tsconfig.web 检查）；`tsconfig.build.json` 增 exclude `src/ui`。
- 所有颜色经 CSS 变量引用，组件中禁止硬编码十六进制值；令牌集中在 `src/ui/styles.css`（提取自 `prototypes/index.html`）。
- 零 emoji：图标一律内联 SVG（`<use href="#…">` 引用页内 symbol），文案不使用 emoji。
- `localStorage` 键名 `eam-theme`，默认 `system`；切换不重载页面、不丢滚动位置。
- 组件不加代码注释；不写日志调试代码。
- 依赖安装由用户手动执行：任何任务内**不得**运行 `npm install` / `npx` 下载包；若运行测试提示缺包，暂停并在完成报告中标明"待用户执行 npm install"。
- 禁止 `git worktree`；只在当前分支工作；提交信息 `type(scope): 中文描述 ≤50 字`。
- 每个任务 TDD：先写失败测试（RED）→ 最小实现（GREEN）→ 全量验证 → 提交。

## Review Focus

1. 前端脚本在依赖未安装（无 preact/happy-dom）时运行 `npm test` 会因模块缺失报错 → 测试命令需在用户按 Task 1 安装依赖后才可跑；Task 1 验证以 `typecheck:web`（无外部 import 解析需求之外的静态检查）与用户提供的安装输出为准。→ Task 1
2. 组件测试在 happy-dom 下无法做真实几何断言 → 只断言结构/aria/交互/禁用态；几何与浏览器行为一律留给 verify-ui.mjs。→ Task 4-9
3. `TranscriptView` 归约必须是确定性纯函数：同一事件序列输入两次结果全等 → Task 3 测试对同一输入归约两次并 `toEqual`。→ Task 3
4. 组件只消费 `TranscriptView`，不得自行聚合事件（防止第二套投影） → Task 4 起组件 prop 类型只出现 `TranscriptView` 与子模型，审查确认无 `SessionEvent[]` 直接进入组件。→ Task 4-9
5. `ok=false` 的工具结果不得渲染空白读数、必须显示 `code` 与错误文本 → Task 3 归约与 Task 7 ToolCard 渲染双重覆盖。→ Task 3、Task 7
6. 写操作（destructive）未确认前界面不得显示"已执行"（V14） → Task 7 GuardNotice / Task 9 复位按钮确认态。→ Task 7、Task 9

---

### Task 1: 前端工程脚手架（依赖声明与构建入口）

**Files:**
- Modify: `package.json`（scripts 增 `build:web` / `dev:web` / `verify:ui` / `test:ui` / `typecheck:web`；dependencies 增 `preact`；devDependencies 增 `@preact/preset-vite` / `vite` / `happy-dom`）
- Modify: `vitest.config.ts`（include 增 `tsx`：`tests/**/*.test.{ts,tsx,js}`；增 `plugins: [preact()]`；`environment`/reporter/coverage 均不动）
- Create: `tsconfig.web.json`
- Create: `web/index.html`
- Create: `vite.config.ts`（仓库根，root 即仓库根，避免 root 外模块解析）
- Modify: `tsconfig.build.json`（exclude 增 `src/ui`）
- Create: `src/ui/main.tsx`
- Create: `src/ui/styles.css`（首屏令牌 + 最小 reset；后续任务的组件样式亦追加于此）
- Test: `tests/ui/smoke.test.tsx`

**Interfaces:**
- Consumes: 无（既有 `package.json` / `tsconfig.json` 只读）。
- Produces:
  - `tsconfig.web.json`：extends 根 tsconfig，`compilerOptions`: `jsx: "react-jsx"`, `jsxImportSource: "preact"`, `lib: ["ES2023","DOM","DOM.Iterable"]`；`include`: `["src/ui","web","tests/ui","src/ui/demo"]`。
  - `web/index.html`：`<html lang="zh-CN" data-theme="system">`；`<div id="root">`；引用 `../src/ui/main.tsx`（Vite 入口模块）；`<head>` 内联首屏主题脚本（读 `localStorage.getItem("eam-theme")` 缺省 `"system"` 写 `document.documentElement.dataset.theme`）。
  - `vite.config.ts`（仓库根）：`import { defineConfig } from "vite"` + `import preact from "@preact/preset-vite"`；`plugins: [preact()]`；`build.outDir: "dist-web"`；`build.rollupOptions.input: "web/index.html"`（入口 HTML 在 web/ 下，模块在 src/ui/，二者都在 root 内；Vitest 优先读 `vitest.config.ts`，与本文件不冲突）。
  - `src/ui/main.tsx`：`import { render } from "preact"`；`render(<div class="app" />, document.getElementById("root")!)`（Task 2 起替换为真实 App）。`import "./styles.css"`。
  - `tests/ui/smoke.test.tsx`：文件头 `// @vitest-environment happy-dom`；断言 `preact` 可 import、`document.getElementById("root")` 挂载渲染后含 `class="app"` 节点。

- [ ] **Step 1: 写失败测试**

`tests/ui/smoke.test.tsx`:

```ts
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "preact";

describe("ui smoke", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
  });
  it("preact 可渲染 app 根节点", () => {
    render(<div class="app" />, document.getElementById("root")!);
    expect(document.querySelector(".app")).not.toBeNull();
  });
  it("styles.css 含首屏令牌（:root --bg-canvas）", () => {
    const css = readFileSync(fileURLToPath(new URL("../../src/ui/styles.css", import.meta.url)), "utf8");
    expect(css).toContain("--bg-canvas:#0e131a");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/smoke.test.tsx`
Expected: FAIL——`Cannot find module 'preact'`（依赖未装）或模块解析错误。

- [ ] **Step 3: 声明依赖与配置**

在 `package.json` 中：`dependencies` 增 `"preact": "^10.29.8"`（**注意**：npm `latest` 标签是 11.0.1，但 Context7 官方确认 v11 属 main 开发线未发布稳定，Preact **v10.x 才是当前稳定线**，**不得**用 ^11）；`devDependencies` 增 `"@preact/preset-vite": "^2.10.6"`、`"vite": "^8.3.4"`（本机 node_modules 已有 8.3.4）、`"happy-dom": "^21.0.3"`；scripts 增上述五条。修改 `vitest.config.ts` 的 `test.include` 为 `['tests/**/*.test.{ts,tsx,js}', ...(includesTmpTests ? ['.tmp/**/*.test.js'] : [])]`（只加 tsx，其余不动）。创建 `tsconfig.web.json`、`web/index.html`、`vite.config.ts`、`src/ui/main.tsx`、`src/ui/styles.css`（令牌区：复制 prototypes `:root` 与 `[data-theme=light]`、`@media (prefers-color-scheme: light){ [data-theme=system] }` 全部变量及滚动条/焦点/全局 reset）。修改 `tsconfig.build.json` 的 exclude 增 `"src/ui"`。

版本号 2026-10-18 已按 npm registry 最新值核实；安装后实际解析以 `package-lock.json` 为准。

- [ ] **Step 4: 运行确认通过（依赖已由用户安装后）**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/smoke.test.tsx`
Expected: PASS（1 passed）。若报缺 preact，暂停并请在报告中注明**待用户执行 `npm install`**。

- [ ] **Step 5: 静态类型检查**

Run: `node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit`
Expected: 0 error。若 npx 不可用（未装 vite）则跳过并以 Step 4 结果为准，报告中注明。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json tsconfig.web.json tsconfig.build.json web src/ui
git commit -m "feat(ui): 前端工程脚手架与构建入口"
```

> 注：若 `package-lock.json` 尚未更新（依赖未装），只 add package.json，不提交过时的 lock；提交信息可含"依赖待安装"。

---

### Task 2: 主题三态系统与图标 sprite

**Files:**
- Create: `src/ui/theme.ts`
- Create: `src/ui/icons.tsx`
- Modify: `src/ui/main.tsx`（应用主题初始化与 `Icon` 用法）
- Modify: `src/ui/styles.css`（图标渲染尺寸与 sprite 容器样式、seg/icon-btn 基础类，供后续组件复用）
- Test: `tests/ui/theme.test.ts`（node 环境，不带 happy-dom 注释）、`tests/ui/icons.test.tsx`（happy-dom）

**Interfaces:**
- Consumes: Task 1 的 `web/index.html`（`data-theme` 初始由内联脚本写入）、`tsconfig.web.json`。
- Produces:
  - `export type ThemeChoice = "light" | "system" | "dark";`
  - `export type ResolvedTheme = "light" | "dark";`
  - `export function resolveTheme(choice: ThemeChoice, media: "light" | "dark"): ResolvedTheme`（system 时取 media，否则取 choice）。
  - `export function readStoredTheme(): ThemeChoice`（`localStorage.getItem("eam-theme")`，非法值回落 `"system"`；无 localStorage 时返回 `"system"`）。
  - `export function applyTheme(choice: ThemeChoice, media: ResolvedTheme): void`（写 `document.documentElement.dataset.theme = resolveTheme(...)`）。
  - `export function persistTheme(choice: ThemeChoice): void`（`localStorage.setItem("eam-theme", choice)`，失败静默）。
  - `export function onChangeMedia(match: { matches: boolean }): ResolvedTheme`（返回 `matches ? "light" : "dark"`）。
  - `src/ui/icons.tsx`：`export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }): JSX.Element`，渲染 `<svg class="ico" width={size} height={size}><use href={"#" + name}/></svg>`；并导出 `export const SYMBOL_SPRITE = (<svg>…symbol…</svg>)` 内联全部图标 symbol（`i-logo / i-book / i-search / i-chat / i-plus / i-chevron / i-chevron-down / i-chip / i-branch / i-terminal / i-sun / i-moon / i-monitor / i-sidebar / i-send / i-refresh / i-copy / i-play / i-pause / i-power / i-cpu / i-plug / i-log / i-shield / i-check / i-alert / i-x / i-hand / i-user / i-spark`，path 照抄 `prototypes/index.html` 对应 symbol）。

- [ ] **Step 1: 写失败测试**

`tests/ui/theme.test.ts`（happy-dom，文件头 `// @vitest-environment happy-dom`）：

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { applyTheme, onChangeMedia, readStoredTheme, resolveTheme } from "../../src/ui/theme.js";

describe("theme", () => {
  it("system 跟随 media", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("system", "light")).toBe("light");
  });
  it("显式 choice 优先于 media", () => {
    expect(resolveTheme("dark", "light")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
  });
  it("非法存储值回落 system", () => {
    localStorage.setItem("eam-theme", "banana");
    expect(readStoredTheme()).toBe("system");
  });
  it("无存储值时默认 system", () => {
    localStorage.removeItem("eam-theme");
    expect(readStoredTheme()).toBe("system");
  });
  it("applyTheme 写入 data-theme", () => {
    applyTheme("light", "dark");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
  it("onChangeMedia 映射 matches", () => {
    expect(onChangeMedia({ matches: true })).toBe("light");
    expect(onChangeMedia({ matches: false })).toBe("dark");
  });
});
```

> theme.test.ts 需要 DOM（document / localStorage），因此使用 happy-dom 环境注释；`resolveTheme`/`onChangeMedia` 虽为纯函数，但同一文件整体跑 happy-dom 即可，不拆双环境。

`tests/ui/icons.test.tsx`（happy-dom）：

```tsx
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { Icon, SYMBOL_SPRITE } from "../../src/ui/icons.js";

describe("icons", () => {
  it("Icon 渲染 use 引用", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Icon name="i-logo" />, root);
    const use = root.querySelector("use");
    expect(use?.getAttribute("href")).toBe("#i-logo");
    const svg = root.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("ico");
  });
  it("sprite 含 i-logo 且 aria-hidden", () => {
    document.body.appendChild(SYMBOL_SPRITE as unknown as HTMLElement);
    const sym = document.getElementById("i-logo");
    expect(sym).not.toBeNull();
    expect(document.querySelector("svg[aria-hidden=true]")).not.toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/theme.test.ts tests/ui/icons.test.tsx`
Expected: FAIL——`Cannot find module '../../src/ui/theme.js'` 或 `icons.js`。

- [ ] **Step 3: 实现 `src/ui/theme.ts` 与 `src/ui/icons.tsx`**

按 Interfaces 签名实现；theme.ts 中 `localStorage` / `document` 访问包在 try/catch（无环境时返回默认），但 `applyTheme` 在无 document 时直接返回。icons.tsx 的 symbol path 从 `prototypes/index.html` 复制，一个不落。

- [ ] **Step 4: 运行确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/theme.test.ts tests/ui/icons.test.tsx`
Expected: PASS（6 + 2）。

- [ ] **Step 5: `main.tsx` 接入主题初始化**

`main.tsx` 中：`const choice = readStoredTheme(); applyTheme(choice, onChangeMedia({ matches: window.matchMedia("(prefers-color-scheme: light)").matches })); window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => applyTheme(readStoredTheme(), onChangeMedia(e)));`，随后 render `<App/>` 或空根（App 于 Task 4 接入）。

- [ ] **Step 6: 提交**

```bash
git add src/ui/theme.ts src/ui/icons.tsx src/ui/main.tsx src/ui/styles.css tests/ui
git commit -m "feat(ui): 主题三态系统与图标sprite"
```

---

### Task 3: TranscriptView 纯函数归约

**Files:**
- Create: `src/ui/view/transcript.ts`
- Create: `src/ui/demo/fixtures.ts`
- Create: `tests/ui/transcript.test.ts`（node 环境）
- Test: `tests/ui/transcript.test.ts`

**Interfaces:**
- Consumes: `import type { SessionEvent, ToolResultPayload } from "../../session/types.js"`；`import type { LoopEvent } from "../../loop/events.js"`；`import type { ToolAnnotations } from "../../tools/types.js"`。Task 1 tsconfig.web.json include 覆盖 `src/ui`（含 demo）与 `tests/ui`。
- Produces（全部从 `view/transcript.ts` 导出）:
  - `export type TranscriptStepId = "symptom" | "triage" | "kb" | "probe" | "verdict";`
  - `export interface TranscriptStep { id: TranscriptStepId; label: string; state: "done" | "now" | "todo" }`
  - `export interface ReadoutRow { label: string; value: string; note?: string }`
  - `export interface HitRow { path: string; desc: string; score: string; channel: number }`
  - `export interface EvidenceRow { name: string; code: string; value: string; verdict: "bad" | "warn" | "ok"; label: string }`
  - `export type ToolKind = "readout" | "hitlist" | "evidence" | "error";`
  - `export interface ToolCardModel { id: string; name: string; args: string; ok: boolean; kind: ToolKind; ms?: number; readout?: ReadoutRow[]; hits?: HitRow[]; evidence?: EvidenceRow[]; errorCode?: string; errorText?: string; readOnly?: boolean; destructive?: boolean }`
  - `export interface VerdictModel { rootCause: string; evidence: EvidenceRow[]; prediction: string; ownership: Array<{ t: "agent" | "user" | "manual"; title: string; desc: string }>; confidence: "高" | "中" | "低" }`
  - `export interface GuardModel { action: string; address: string; value: string; state: "待确认" | "已拒绝" | "已执行" }`
  - `export type TranscriptEvent = { id: string; kind: "user"; text: string } | { id: string; kind: "assistant"; text: string } | { id: string; kind: "ask"; text: string; note?: string } | { id: string; kind: "tool"; tool: ToolCardModel } | { id: string; kind: "verdict"; verdict: VerdictModel } | { id: string; kind: "guard"; guard: GuardModel } | { id: string; kind: "interrupted"; reason: string };`
  - `export interface TranscriptView { steps: TranscriptStep[]; status: "idle" | "diagnosing" | "done" | "interrupted"; events: readonly TranscriptEvent[]; usage?: { prompt: number; completion: number; cached: number; costUsd?: number }; interruptReason?: string }`
  - `export function transcriptFromSession(events: readonly SessionEvent[]): TranscriptView`（按 §8.2 投影表归约）
  - `export function transcriptFromLoop(events: readonly LoopEvent[]): TranscriptView`（实时渲染用；tool_result 事件携带完整字段）
  - `export function reduceStep(events: readonly unknown[]): TranscriptStep[]`（五步路径状态推断：有 user 事件 → symptom done；有 ask 渲染 → triage done；有 kb 工具 → kb done；有 mem_read 等取证工具（name 以 `mem_`/`serial_`/`reg_` 开头且非 error）→ probe done/now；有 verdict → verdict done）

**投影规则（本任务钉死）:**

- user → `{ kind:"user", text }`（payload.content）。
- assistant（content 非空）→ `{ kind:"assistant", text }`；`content` 开头含「第 0 步分流」前缀 → `{ kind:"ask", text, note? }`（note 取 payload.note）。
- assistant（toolCalls 非空）→ 每条 tool call 一个 `{ kind:"tool", tool }` 骨架，`ok` 置 `true`（占位，待结果）；`readOnly`/`destructive` 来自工具名已知表。
- tool_result → 查找同名 id 的骨架补齐：`ok`、`ms`、`kind`（按 `detail` 形状：有 `fields`/`readout` → readout，有 `hits` → hitlist，有 `rows`/`evidence` → evidence；否则按 `detail` 有无结构化内容取舍；`ok=false` → `error`，`errorCode`/`errorText` 取 `code` 与 `text`）。
- 未知 id 的 tool_result：丢弃（不创建幽灵卡）。
- interrupted → `{ kind:"interrupted", reason }`，status 置 `interrupted`。
- usage（末尾匹配合并）→ view.usage；status 由最后一条（done? 有 verdict 则 `done`；否则 diagnosing/idle）推断。
- 归约必须纯函数：无外部状态、无随机；同输入两次结果严格 `toEqual`。
- 工具名→语义表：`kb_lookup` → readOnly+evidence；`mem_read`/`serial_read`/`reg_read` → readOnly+evidence；`mem_write`/`serial_write`/`reset` → destructive。表内未列出的工具：`readOnly: false, destructive: false`（显示中性）。

`src/ui/demo/fixtures.ts`：导出 `export const UART_TRANSCRIPT_EVENTS: SessionEvent[]`，内容与 `prototypes/index.html` 消息流一致（上电乱码诊断：user 症状 → assistant ask（第 0 步分流）→ user 回答 → assistant kb_lookup 命中 → mem_read RCC_CFGR → mem_read USART2_BRR → verdict → guard 写 BRR 待确认）。每条事件按真实 `SessionEvent` 形状（seq/ts/type/payload/parent?），ts 用固定字符串。

- [ ] **Step 1: 写失败测试**

`tests/ui/transcript.test.ts`（node 环境，无 happy-dom 注释）：

```ts
import { describe, expect, it } from "vitest";
import { transcriptFromSession, reduceStep } from "../../src/ui/view/transcript.js";
import type { TranscriptEvent } from "../../src/ui/view/transcript.js";
import type { SessionEvent } from "../../src/session/types.js";
import { UART_TRANSCRIPT_EVENTS } from "../../src/ui/demo/fixtures.js";

describe("transcript", () => {
  it("user 事件渲染为用户气泡", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    expect(v.events[0]).toMatchObject({ kind: "user", text: expect.stringContaining("乱码") });
  });
  it("第0步分流渲染为 ask", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    expect(v.events[1]).toMatchObject({ kind: "ask", text: expect.stringContaining("分流") });
  });
  it("工具卡渲染且持有证据", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    const tools = v.events.filter((e) => e.kind === "tool") as Array<{ kind: "tool"; tool: { name: string; evidence?: unknown[] } }>;
    expect(tools.some((t) => t.tool.name === "mem_read" && ((t.tool.evidence ?? []).length > 0))).toBe(true);
  });
  it("ok=false 的工具呈现 error 形态且保留错误码", () => {
    const evs = [
      ...UART_TRANSCRIPT_EVENTS,
      { seq: 99, ts: "t", type: "assistant", payload: { content: "", toolCalls: [{ id: "c9", name: "serial_read", arguments: {} }] } },
      { seq: 100, ts: "t", type: "tool_result", payload: { id: "c9", ok: false, code: "io_timeout", text: "读取超时" }, parent: 99 },
    ] as unknown as SessionEvent[];
    const v = transcriptFromSession(evs);
    const tool = v.events.filter((e) => e.kind === "tool").at(-1) as Extract<TranscriptEvent, { kind: "tool" }>;
    expect(tool.tool.ok).toBe(false);
    expect(tool.tool.errorCode).toBe("io_timeout");
  });
  it("verdict 渲染为判决卡", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    expect(v.events.some((e) => e.kind === "verdict")).toBe(true);
  });
  it("guard 渲染为安全提示", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    const g = v.events.find((e) => e.kind === "guard");
    expect(g && g.kind === "guard" && g.guard.state).toBe("待确认");
  });
  it("归约确定性：同输入两次结果全等", () => {
    expect(transcriptFromSession(UART_TRANSCRIPT_EVENTS)).toEqual(transcriptFromSession(UART_TRANSCRIPT_EVENTS));
  });
  it("五步路径：verdict 后全部 done", () => {
    const steps = reduceStep(UART_TRANSCRIPT_EVENTS);
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
  });
});
```

> 第 4 条用到的 `SessionEvent` 类型导入仅用于 cast，顶部 `import type { SessionEvent } from "../../src/session/types.js"`；`TranscriptEvent` 已从 transcript.js 导入。

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/transcript.test.ts`
Expected: FAIL——`Cannot find module '../../src/ui/view/transcript.js'` 与 `../../src/ui/demo/fixtures.js`。

- [ ] **Step 3: 实现 `view/transcript.ts` 与 `src/ui/demo/fixtures.ts`**

按 Interfaces 与投影规则实现；fixture 事件形状参照 `prototypes/index.html` 的对话内容（seqt 连续、ts 固定）。工具证据字段映射：`detail.evidence` → evidence rows；`detail.hits` → hits；`detail.fields/readout` → readout。

- [ ] **Step 4: 运行确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/transcript.test.ts`
Expected: PASS（7 passed）。

- [ ] **Step 5: 全量测试确认内核零回归**

Run: `node ./node_modules/vitest/vitest.mjs run`
Expected: 原有全部内核测试仍通过（新增 tests/ui 与 demo fixture 加入后总数增加，内核 0 失败）。

- [ ] **Step 6: 提交**

```bash
git add src/ui/view tests/ui/transcript.test.ts src/ui/demo
git commit -m "feat(ui): transcript纯函数归约与fixture"
```

---

### Task 4: 应用骨架（TopBar / StatusBar / 三栏容器）

**Files:**
- Create: `src/ui/components/topbar.tsx`
- Create: `src/ui/components/statusbar.tsx`
- Create: `src/ui/app.tsx`
- Modify: `src/ui/main.tsx`（render `<App/>`）
- Modify: `src/ui/styles.css`（topbar/statusbar/app 栅格/workspace 三栏/seg/icon-btn/chip 等布局与令牌类）
- Test: `tests/ui/components/layout.test.tsx`（happy-dom）

**Interfaces:**
- Consumes: Task 2 的 `Icon` / `SYMBOL_SPRITE` / `resolveTheme` / `readStoredTheme` / `applyTheme` / `persistTheme`；Task 3 的 `TranscriptStep`、`TranscriptView`（本任务仅用于类型标注，渲染内容后续任务填充）。
- Produces:
  - `src/ui/components/topbar.tsx`：`export function TopBar({ themeChoice, onThemeChange, dockOpen, onDockToggle }: { themeChoice: ThemeChoice; onThemeChange: (c: ThemeChoice) => void; dockOpen: boolean; onDockToggle: () => void }): JSX.Element`。含 Brand（`Icon i-logo`）、TargetChips（芯片 / 分支 / 后端，芯片可点击、后端连接态 `chip--state`）、ThemeSwitch 三段式（`aria-pressed` 反映当前项）、DockToggle（`aria-pressed={dockOpen}`）。
  - `src/ui/components/statusbar.tsx`：`export function StatusBar({ probe, serial, alert, sessionId, context, cost, platform, }: { probe?: string; serial?: string; alert?: string; sessionId?: string; context?: string; cost?: string; platform?: string }): JSX.Element`，左探针/串口/告警（状态点），右会话/上下文/费用/平台（等宽）。
  - `src/ui/app.tsx`：`export function App(props: { view: TranscriptView; themeChoice?: ThemeChoice; onThemeChange?: (c: ThemeChoice) => void; dockOpen?: boolean; onDockToggle?: () => void; children?: ComponentChildren }): JSX.Element`——skyline 骨架：`.app` 栅格（48px / 1fr / 26px），TopBar + `.workspace`（`aside.rail` | `main.conversation` | `aside.dock`）+ StatusBar；三栏内部占位由后续任务填充；Dock 折叠经 `is-collapsed` 类控制。本任务先渲染占位文本「知识库 / 对话 / 调试坞」，后续任务替换为真实组件。
  - `main.tsx` 更新：`render(<App view={transcriptFromSession(UART_TRANSCRIPT_EVENTS)} themeChoice={readStoredTheme()} />, root)`；主题切换回调接 `persistTheme` + `applyTheme`。

- [ ] **Step 1: 写失败测试**

`tests/ui/components/layout.test.tsx`（happy-dom）：

```tsx
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { App } from "../../../src/ui/app.js";
import { TopBar } from "../../../src/ui/components/topbar.js";
import { UART_TRANSCRIPT_EVENTS } from "../../src/ui/demo/fixtures.js";
import { transcriptFromSession } from "../../../src/ui/view/transcript.js";

describe("layout", () => {
  it("App 渲染三栏与状态栏", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<App view={transcriptFromSession(UART_TRANSCRIPT_EVENTS)} />, root);
    expect(root.querySelector(".app")).not.toBeNull();
    expect(root.querySelector(".topbar")).not.toBeNull();
    expect(root.querySelector(".rail")).not.toBeNull();
    expect(root.querySelector(".conversation")).not.toBeNull();
    expect(root.querySelector(".dock")).not.toBeNull();
    expect(root.querySelector(".statusbar")).not.toBeNull();
  });
  it("TopBar 主题切换按 aria-pressed 高亮当前项", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<TopBar themeChoice="dark" onThemeChange={() => {}} dockOpen onDockToggle={() => {}} />, root);
    const pressed = root.querySelectorAll('[aria-pressed="true"]');
    expect(pressed.length).toBeGreaterThanOrEqual(1);
    expect(root.querySelector('[data-theme-opt="dark"]')?.getAttribute("aria-pressed")).toBe("true");
  });
  it("Dock 折叠类随 dockOpen 切换", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const { rerender } = render(<App view={transcriptFromSession(UART_TRANSCRIPT_EVENTS)} dockOpen={false} />, root);
    expect(root.querySelector(".workspace")?.className).toContain("is-collapsed");
    rerender(<App view={transcriptFromSession(UART_TRANSCRIPT_EVENTS)} dockOpen />, root);
    expect(root.querySelector(".workspace")?.className).not.toContain("is-collapsed");
  });
  it("StatusBar 展示会话/上下文/费用", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<StatusBar sessionId="#128" context="12.4k / 200k" cost="¥0.42" />, root);
    expect(root.textContent).toContain("#128");
    expect(root.textContent).toContain("12.4k / 200k");
    expect(root.textContent).toContain("¥0.42");
  });
  it("无 emoji：App 文案不含 emoji 码点", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<App view={transcriptFromSession(UART_TRANSCRIPT_EVENTS)} />, root);
    const text = root.textContent ?? "";
    const bad = [...text].filter((ch) => /\p{Extended_Pictographic}/u.test(ch));
    expect(bad).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/layout.test.tsx`
Expected: FAIL——模块缺失（topbar/app 未实现）。

- [ ] **Step 3: 实现组件与骨架**

按 Interfaces 实现；styles.css 追加 `.app/.topbar/.brand/.chip/.seg/.icon-btn/.workspace/.is-collapsed/.rail/.conversation/.dock/.statusbar/.sb` 等类（尺寸与令牌照 frontend-design §4/§5/§7.1/§7.15 与原型对应 CSS）。

- [ ] **Step 4: 运行确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/layout.test.tsx`
Expected: PASS（5 passed）。

- [ ] **Step 5: 全量 + 类型检查**

Run: `node ./node_modules/vitest/vitest.mjs run && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit`
Expected: 全绿；0 error。

- [ ] **Step 6: 提交**

```bash
git add src/ui/app.tsx src/ui/components/topbar.tsx src/ui/components/statusbar.tsx src/ui/styles.css src/ui/main.tsx tests/ui/components
git commit -m "feat(ui): 应用栅格骨架与顶栏状态栏"
```

---

### Task 5: 左栏（知识库 Pane + 会话 Pane）

**Files:**
- Create: `src/ui/components/rail/knowledge-pane.tsx`
- Create: `src/ui/components/rail/session-pane.tsx`
- Modify: `src/ui/app.tsx`（rail 接入两个 Pane）
- Modify: `src/ui/styles.css`（pane-head/kb-search/tree/row/chev/tag/session 组样式）
- Test: `tests/ui/components/rail.test.tsx`（happy-dom）

**Interfaces:**
- Consumes: Task 2 `Icon` / `SYMBOL_SPRITE`；Task 4 `App` 的 `.rail` 插槽。
- Produces:
  - `src/ui/components/rail/knowledge-pane.tsx`: `export function KnowledgePane(): JSX.Element`。栏头（Icon i-book + 「知识库」+ count 胶囊）；检索框（`<input type="search">`, aria-label "检索知识库", placeholder 照 spec）；树：默认展开「vendor/ 厂商分流」（aria-expanded=true，子项 STM32 系列 is-active），其余组收起；行高 32px；可展开项 chevron；叶子项 leaf-dot；整行 button 可点切换 aria-expanded。
  - `src/ui/components/rail/session-pane.tsx`: `export function SessionPane(): JSX.Element`。栏头（Icon i-chat + 「诊断会话」+ 新建 head-btn Icon i-plus）；分组「进行中」「历史」；四条会话行（标题/meta/状态点 run|warn|idle），某一条 is-active。
  - 数据为**静态演示数据**（组件内部常量，来源 `prototypes/index.html`），结构即接口，后续接入真实会话列表时替换数据源不换组件签名。
  - App 的 `<aside class="rail"><KnowledgePane/><SessionPane/></aside>`。

- [ ] **Step 1: 写失败测试**

`tests/ui/components/rail.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { KnowledgePane } from "../../../src/ui/components/rail/knowledge-pane.js";
import { SessionPane } from "../../../src/ui/components/rail/session-pane.js";

describe("rail", () => {
  it("知识库默认展开厂商分流且当前厂商高亮", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<KnowledgePane />, root);
    const vendor = [...root.querySelectorAll(".tree-row")].find((r) => r.textContent?.includes("厂商分流"));
    expect(vendor?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector(".tree-row.is-active")?.textContent).toContain("STM32");
  });
  it("知识库检索框占位正确且有 aria-label", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<KnowledgePane />, root);
    const input = root.querySelector("input[type=search]");
    expect(input?.getAttribute("aria-label")).toBe("检索知识库");
    expect(input?.getAttribute("placeholder")).toContain("kb_lookup");
  });
  it("点击可展开项切换 aria-expanded", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<KnowledgePane />, root);
    const protocols = [...root.querySelectorAll(".tree-row")].find((r) => r.textContent?.includes("协议层"));
    protocols?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(protocols?.getAttribute("aria-expanded")).toBe("true");
  });
  it("会话列表分两组且含状态点", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<SessionPane />, root);
    expect([...root.querySelectorAll(".session-group")].map((e) => e.textContent)).toEqual(["进行中", "历史"]);
    expect(root.querySelectorAll(".session .dot").length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/rail.test.tsx`
Expected: FAIL——模块缺失。

- [ ] **Step 3: 实现两个 Pane 与样式**

按 Interfaces 与 frontend-design §7.2/§7.3 实现。

- [ ] **Step 4: 运行确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/rail.test.tsx`
Expected: PASS（4 passed）。

- [ ] **Step 5: App 接入 + 全量 + 类型检查**

```bash
node ./node_modules/vitest/vitest.mjs run && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
```

Expected: 全绿；0 error。

- [ ] **Step 6: 提交**

```bash
git add src/ui/components/rail src/ui/app.tsx src/ui/styles.css tests/ui/components/rail.test.tsx
git commit -m "feat(ui): 左栏知识库与会话面板"
```

---

### Task 6: 主区（会话头 / 路径条 / 消息流 / 气泡）

**Files:**
- Create: `src/ui/components/conversation/header.tsx`
- Create: `src/ui/components/conversation/pathline.tsx`
- Create: `src/ui/components/conversation/stream.tsx`
- Create: `src/ui/components/conversation/messages.tsx`
- Modify: `src/ui/app.tsx`（`.conversation` 接入四个组件，`view` 传入）
- Modify: `src/ui/styles.css`（cnv-head/status/pathline/step/stream/turn/role/bubble/ask 样式）
- Test: `tests/ui/components/conversation.test.tsx`（happy-dom）

**Interfaces:**
- Consumes: Task 3 `TranscriptView` / `TranscriptStep` / `TranscriptEvent` 与 ui 模型；Task 2 Icon。
- Produces:
  - `header.tsx`: `export function ConversationHeader({ title, status }: { title: string; status: "idle" | "diagnosing" | "done" | "interrupted" }): JSX.Element`。标题单行省略；状态胶囊（诊断中 accent / 已完成 / 已中断，带 6px 状态点）；「回放」「导出 transcript」次级按钮（Icon i-refresh / i-copy）。
  - `pathline.tsx`: `export function PathLine({ steps }: { steps: TranscriptStep[] }): JSX.Element`。五步固定序列（done/now/todo 三态）、步间 14px 连线、窄屏横向滚动。
  - `messages.tsx`: `export function MessageStream({ view }: { view: TranscriptView }): JSX.Element`——事件 → 组件映射（user→气泡靠右；assistant→agent 气泡；ask→AskBlock；tool/verdict/guard→占位卡，交由 Task 7 组件渲染；interrupted→提示条）。
  - `stream.tsx`: `export function ConversationStream({ view }: { view: TranscriptView }): JSX.Element`，滚动容器包裹 `MessageStream`。
  - App 的 `.conversation`：`<ConversationHeader title view.status/><PathLine steps={view.steps}/><ConversationStream view/>{/* Composer Task 8 */}`。

- [ ] **Step 1: 写失败测试**

`tests/ui/components/conversation.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { ConversationHeader } from "../../../src/ui/components/conversation/header.js";
import { PathLine } from "../../../src/ui/components/conversation/pathline.js";
import { MessageStream } from "../../../src/ui/components/conversation/messages.js";
import { reduceStep, transcriptFromSession } from "../../../src/ui/view/transcript.js";
import { UART_TRANSCRIPT_EVENTS } from "../../src/ui/demo/fixtures.js";

describe("conversation", () => {
  const view = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
  it("会话头展示标题与胶囊", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<ConversationHeader title="测试会话" status="diagnosing" />, root);
    expect(root.textContent).toContain("测试会话");
    expect(root.querySelector(".status")).not.toBeNull();
  });
  it("路径条五步状态匹配 reduceStep", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<PathLine steps={reduceStep(UART_TRANSCRIPT_EVENTS)} />, root);
    expect(root.querySelectorAll(".step").length).toBe(5);
    expect(root.querySelectorAll(`.step[data-s="done"]`).length).toBe(5);
  });
  it("消息流渲染用户与 agent 与 ask", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<MessageStream view={view} />, root);
    expect(root.querySelector(".turn--user")).not.toBeNull();
    expect(root.textContent).toContain("Embedded-Ai-Master");
    expect(root.querySelector(".ask")).not.toBeNull();
  });
  it("消息流不渲染 checkpoint 事件（无幽灵节点）", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<MessageStream view={view} />, root);
    expect(root.querySelector(".checkpoint")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/conversation.test.tsx`
Expected: FAIL——模块缺失。

- [ ] **Step 3: 实现四个组件与样式**

按 Interfaces 与 frontend-design §7.4/§7.5/§7.6 实现。tool/verdict/guard 事件在本任务渲染占位（如 `<div class="placeholder">`），Task 7 替换。

- [ ] **Step 4: 运行确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/conversation.test.tsx`
Expected: PASS（4 passed）。

- [ ] **Step 5: App 接入 + 全量 + 类型检查**

```bash
node ./node_modules/vitest/vitest.mjs run && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
```

Expected: 全绿；0 error。

- [ ] **Step 6: 提交**

```bash
git add src/ui/components/conversation src/ui/app.tsx src/ui/styles.css tests/ui/components/conversation.test.tsx
git commit -m "feat(ui): 主区会话头路径条与消息流"
```

---

### Task 7: 工具卡 / 判决卡 / 安全提示

**Files:**
- Create: `src/ui/components/conversation/tool-card.tsx`
- Create: `src/ui/components/conversation/verdict-card.tsx`
- Create: `src/ui/components/conversation/guard-notice.tsx`
- Modify: `src/ui/components/conversation/messages.tsx`（占位替换为真实组件）
- Modify: `src/ui/components/conversation/stream.tsx`（大输出折叠状态可经 props 注入，本任务在 ToolCard 内部实现折叠）
- Modify: `src/ui/styles.css`（tool/readout/hit/ev/verdict/vc/own/guard 样式，照抄原型对应 CSS 类）
- Test: `tests/ui/components/cards.test.tsx`（happy-dom）

**Interfaces:**
- Consumes: Task 3 的 `ToolCardModel` / `VerdictModel` / `GuardModel`；Task 2 Icon；Task 6 `MessageStream`。
- Produces:
  - `tool-card.tsx`: `export function ToolCard({ tool }: { tool: ToolCardModel }): JSX.Element`。卡头：工具图标 + 等宽 `tool-name` + 参数摘要 + 结果标记（ok 勾 + 耗时或错误 `--danger`）；卡体按 `kind` 渲染 readout（三列 dl）/ hitlist（通道色 3px 条 + path/desc/score）/ evidence（`.ev-row`：名称+地址码 / 值 / 判定胶囊 `bad|warn|ok` 带图标与文字）/ error（code + text）；大输出默认折叠「摘要 + 行数 + 展开」按钮（本地 useState）。`readOnly` 卡头中性色；`destructive` 卡头与按钮 `--danger`。
  - `verdict-card.tsx`: `export function VerdictCard({ verdict }: { verdict: VerdictModel }): JSX.Element`。外框 `--accent-line`；卡头 Icon + 「根因判决」+ 置信度 tag；四区块 h4（根因 / 证据链 / 可证伪的修复建议 / 动作归属）；prediction 虚线框；ownership 三列（agent accent / user info / manual warn，样式照原型 `.own[data-o=…]`）。
  - `guard-notice.tsx`: `export function GuardNotice({ guard }: { guard: GuardModel }): JSX.Element`。warn 边框浅底；Icon i-alert；文案含 action/address/value/state；state 为 `待确认` 时不出现「已执行」字样。
  - `messages.tsx` 更新：`tool` 事件 → `<ToolCard tool={e.tool}/>`；`verdict` → `<VerdictCard verdict={e.verdict}/>`；`guard` → `<GuardNotice guard={e.guard}/>`。

- [ ] **Step 1: 写失败测试**

`tests/ui/components/cards.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { ToolCard } from "../../../src/ui/components/conversation/tool-card.js";
import { VerdictCard } from "../../../src/ui/components/conversation/verdict-card.js";
import { GuardNotice } from "../../../src/ui/components/conversation/guard-notice.js";
import { transcriptFromSession } from "../../../src/ui/view/transcript.js";
import type { TranscriptEvent } from "../../../src/ui/view/transcript.js";
import { UART_TRANSCRIPT_EVENTS } from "../../src/ui/demo/fixtures.js";

describe("cards", () => {
  it("工具卡失败形态显示错误码与文本，不渲染空白读数", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<ToolCard tool={{ id: "c", name: "serial_read", args: "COM3", ok: false, kind: "error", errorCode: "io_timeout", errorText: "读取超时" }} />, root);
    expect(root.textContent).toContain("io_timeout");
    expect(root.textContent).toContain("读取超时");
    expect(root.querySelector(".readout")).toBeNull();
  });
  it("证据卡判定胶囊带图标与文字", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    const toolEv = v.events.find((e) => e.kind === "tool" && e.tool.evidence && e.tool.evidence.length > 0) as Extract<TranscriptEvent, { kind: "tool" }>;
    expect(toolEv).toBeDefined();
  });
  it("判决卡含根因/证据/预测/归属四区块", () => {
    const v = transcriptFromSession(UART_TRANSCRIPT_EVENTS);
    const verdict = v.events.find((e) => e.kind === "verdict") as Extract<TranscriptEvent, { kind: "verdict" }>;
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<VerdictCard verdict={verdict.verdict} />, root);
    ["根因", "证据链", "可证伪", "动作归属"].forEach((k) => expect(root.textContent).toContain(k));
  });
  it("GuardNotice 待确认状态不出现已执行", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<GuardNotice guard={{ action: "写入", address: "0x40004408", value: "0x0009", state: "待确认" }} />, root);
    expect(root.textContent).not.toContain("已执行");
    expect(root.textContent).toContain("待确认");
  });
  it("写工具确认后显示已执行（V14 反面）", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<GuardNotice guard={{ action: "写入", address: "0x40004408", value: "0x0009", state: "已执行" }} />, root);
    expect(root.textContent).toContain("已执行");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/cards.test.tsx`
Expected: FAIL——模块缺失 / transcript fixture 的 evidence 断言失败（说明 fixture 或归约缺 evidence 映射，需先回头补 Task 3 契约）。

- [ ] **Step 3: 实现三个卡片组件与消息流接线**

按 Interfaces 与 frontend-design §7.7/§7.8/§7.9 实现；样式从原型 `.tool/.readout/.hit/.ev/.verdict/.vc-*/.own/.guard` 复制。

- [ ] **Step 4: 运行确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/cards.test.tsx`
Expected: PASS（5 passed）。

- [ ] **Step 5: 全量 + 类型检查**

```bash
node ./node_modules/vitest/vitest.mjs run && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
```

Expected: 全绿；0 error。

- [ ] **Step 6: 提交**

```bash
git add src/ui/components/conversation/tool-card.tsx src/ui/components/conversation/verdict-card.tsx src/ui/components/conversation/guard-notice.tsx src/ui/components/conversation/messages.tsx src/ui/components/conversation/stream.tsx src/ui/styles.css tests/ui/components/cards.test.tsx
git commit -m "feat(ui): 工具卡判决卡与安全提示"
```

---

### Task 8: Composer 输入栏与 Dock 调试坞

**Files:**
- Create: `src/ui/components/conversation/composer.tsx`
- Create: `src/ui/components/dock/dock.tsx`
- Create: `src/ui/components/dock/device-monitor.tsx`
- Create: `src/ui/components/dock/port-settings.tsx`
- Create: `src/ui/components/dock/debug-log.tsx`
- Modify: `src/ui/app.tsx`（`.conversation` 接 Composer；`.dock` 接 Dock）
- Modify: `src/ui/styles.css`（composer/btn/dock-sec/field/pill/reg-table/port-grid/io-stats/stat/log 样式）
- Test: `tests/ui/components/composer-dock.test.tsx`（happy-dom）

**Interfaces:**
- Consumes: Task 2 Icon；Task 4 App 插槽。
- Produces:
  - `composer.tsx`: `export function Composer({ onSend }: { onSend: (text: string) => void }): JSX.Element`。`.composer-box` textarea（22px 起、随内容至 120px）；工具行（上下文 / 工具集按钮 + hint「Enter 发送 · Shift + Enter 换行」+ 发送按钮）；Enter 发送、Shift+Enter 换行、发送后清空回底部；空输入时发送按钮禁用。
  - `dock.tsx`: `export function Dock({ logLines, registers, }: { logLines: Array<{ time: string; mark: "tx" | "rx" | "kv" | "err"; text: string }>; registers: Array<{ name: string; value: string; warn?: boolean }> }): JSX.Element`——栏头 + `.dock-body`，三段可折叠分区（`aria-expanded` + chevron）：设备监控 / 端口设置 / 调试日志。
  - `device-monitor.tsx`：`export function DeviceMonitor({ registers }: { registers: Array<{ name: string; value: string; warn?: boolean }> }): JSX.Element`——字段行（目标/探针/CPU/后端）；控制按钮（暂停 primary / 继续 / 复位 danger，复位点击进入确认流程：二次确认展示目标与值，未确认不显示已执行）；寄存器表两列，warn 行保留原值文本。
  - `port-settings.tsx`：`export function PortSettings(): JSX.Element`——原生 select（端口/波特率）+ 只读数据帧 + 打开/关闭 + 统计三卡；未打开端口统计显示 `—`；错误帧非 0 时 `--danger` 并显示数字。
  - `debug-log.tsx`：`export function DebugLog({ lines }: { lines: Array<{ time: string; mark: "tx" | "rx" | "kv" | "err"; text: string }> }): JSX.Element`——三列（时间/6×6 标记/文本）；上滚后暂停自动滚动（监听 scroll 事件，接近底部恢复）。
  - Dock 数据为演示常量（对齐原型右侧内容）；`logLines` / `registers` 为 props，便于未来接真实会话投影。

- [ ] **Step 1: 写失败测试**

`tests/ui/components/composer-dock.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { Composer } from "../../../src/ui/components/conversation/composer.js";
import { Dock } from "../../../src/ui/components/dock/dock.js";

describe("composer+dock", () => {
  it("空输入发送按钮禁用", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let sent = "";
    render(<Composer onSend={(t) => { sent = t; }} />, root);
    const send = root.querySelector<HTMLButtonElement>(".send")!;
    expect(send.disabled).toBe(true);
  });
  it("Enter 发送非空文本并清空", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let sent = "";
    render(<Composer onSend={(t) => { sent = t; }} />, root);
    const ta = root.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.value = "你好";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toBe("你好");
    expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });
  it("调试坞三分区可折叠且 aria-expanded 同步", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Dock logLines={[]} registers={[]} />, root);
    const heads = [...root.querySelectorAll<HTMLButtonElement>(".dock-sec-head")];
    expect(heads.length).toBe(3);
    const dev = heads.find((h) => h.textContent?.includes("设备监控"))!;
    expect(dev.getAttribute("aria-expanded")).toBe("true");
    dev.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dev.getAttribute("aria-expanded")).toBe("false");
  });
  it("未打开端口统计显示 — 而非 0", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Dock logLines={[]} registers={[]} />, root);
    expect(root.textContent).toContain("—");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/composer-dock.test.tsx`
Expected: FAIL——模块缺失。

- [ ] **Step 3: 实现 Composer 与 Dock 四组件 + 样式**

按 Interfaces 与 frontend-design §7.10-§7.14 实现。复位确认交互：点击「复位」→ `.confirm` 态展示目标与值 + 「确认复位」按钮；未点击确认不改变状态显示。

- [ ] **Step 4: 运行确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/components/composer-dock.test.tsx`
Expected: PASS（4 passed）。

- [ ] **Step 5: App 接入 + 全量 + 类型检查**

```bash
node ./node_modules/vitest/vitest.mjs run && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
```

Expected: 全绿；0 error。

- [ ] **Step 6: 提交**

```bash
git add src/ui/components/conversation/composer.tsx src/ui/components/dock src/ui/app.tsx src/ui/styles.css tests/ui/components/composer-dock.test.tsx
git commit -m "feat(ui): 输入栏与调试坞四分区"
```

---

### Task 9: SSE 客户端抽象与回放接线

**Files:**
- Create: `src/ui/view/sse.ts`
- Modify: `src/ui/main.tsx`（接入 demo 回放：无 SSE 时以 fixture 回放；有 EVENT_STREAM_URL 环境时 `createEventStream`）
- Test: `tests/ui/sse.test.ts`（node 环境，注入 fake EventSource 与 fetch）

**Interfaces:**
- Consumes: Task 3 `LoopEvent`（`import type` 自 `src/loop/events.js`）。
- Produces:
  - `export interface StreamHandlers { onEvent(ev: LoopEvent): void; onOpen?(): void; onError?(err: unknown): void }`
  - `export function createEventStream(url: string, handlers: StreamHandlers, deps?: { EventSourceCtor?: typeof EventSource; retryMs?: number; log?: (msg: string) => void }): { close(): void }`
  - `export async function postAction<T>(url: string, body: unknown, deps?: { fetchImpl?: typeof fetch }): Promise<T>`

行为：收到 `message` 事件解析 JSON 为 `LoopEvent` 交 `onEvent`（非法 JSON 调 onError 不中断流）；`open` 调 onOpen；`error` 后按 `retryMs` 重连；`close()` 幂等且停止重连。`postAction`：POST JSON，2xx 解析 json 返回；非 2xx 抛 `{ code: "http_error", status, text }`；网络异常上抛。

- [ ] **Step 1: 写失败测试**

`tests/ui/sse.test.ts`（node 环境）：

```ts
import { describe, expect, it, vi } from "vitest";
import { createEventStream, postAction } from "../../src/ui/view/sse.js";
import type { LoopEvent } from "../../src/loop/events.js";

class FakeES {
  static instances: FakeES[] = [];
  url: string;
  handlers: Record<string, (e?: unknown) => void> = {};
  closed = false;
  constructor(url: string) { this.url = url; FakeES.instances.push(this); }
  addEventListener(k: string, fn: (e?: unknown) => void) { this.handlers[k] = fn; }
  removeEventListener() {}
  close() { this.closed = true; }
  emit(k: string, data?: string) {
    if (data !== undefined) (this.handlers[k] as (e?: unknown) => void)({ data });
    else this.handlers[k]?.();
  }
}

describe("sse", () => {
  it("message 事件解析为 LoopEvent 并分发", () => {
    const seen: LoopEvent[] = [];
    const s = createEventStream("http://x/ev", { onEvent: (ev) => seen.push(ev) }, { EventSourceCtor: FakeES as unknown as typeof EventSource, retryMs: 0 });
    const es = FakeES.instances.at(-1)!;
    es.emit("message", JSON.stringify({ kind: "done", finishReason: "no_tool_calls" }));
    expect(seen).toEqual([{ kind: "done", finishReason: "no_tool_calls" }]);
    s.close();
  });
  it("非法 JSON 走 onError 不中断流", () => {
    const seen: unknown[] = [];
    const s = createEventStream("http://x/ev", { onEvent: () => {}, onError: (e) => seen.push(e) }, { EventSourceCtor: FakeES as unknown as typeof EventSource, retryMs: 0 });
    const es = FakeES.instances.at(-1)!;
    es.emit("message", "{bad json");
    expect(seen.length).toBe(1);
    expect(es.closed).toBe(false);
    s.close();
  });
  it("close 后不再重连", () => {
    const s = createEventStream("http://x/ev", { onEvent: () => {} }, { EventSourceCtor: FakeES as unknown as typeof EventSource, retryMs: 1 });
    const es = FakeES.instances.at(-1)!;
    s.close(); s.close();
    es.emit("error");
    expect(FakeES.instances.length).toBe(1);
  });
  it("postAction 成功与失败", async () => {
    const okFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await postAction("http://x/a", { v: 1 }, { fetchImpl: okFetch as unknown as typeof fetch })).toEqual({ ok: 1 });
    const badFetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(postAction("http://x/a", {}, { fetchImpl: badFetch as unknown as typeof fetch })).rejects.toMatchObject({ code: "http_error", status: 500 });
  });
});
```

> node 环境无 `Response` 全局可用（Node 24 有全局 Response）。若环境缺失，测试首跑失败→在测试文件头加 `// @vitest-environment happy-dom` 或改用 `new Response` 前先断言存在；Node 24 自带 global Response，保留 node 环境。

- [ ] **Step 2: 运行确认失败**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/sse.test.ts`
Expected: FAIL——`Cannot find module '../../src/ui/view/sse.js'`。

- [ ] **Step 3: 实现 `view/sse.ts`**，`main.tsx` 接线 demo 回放

`main.tsx`：若 `import.meta.env.VITE_EVENT_STREAM_URL` 存在 → `createEventStream` 把事件累积后归约渲染；否则渲染 `transcriptFromSession(UART_TRANSCRIPT_EVENTS)` 回放态。`onSend` 接 `postAction`（URL 不存在时静默丢弃并 console 提示由开发者确认——不落用户 UI 错误）。

- [ ] **Step 4: 运行确认通过**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/sse.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 全量 + 类型检查**

```bash
node ./node_modules/vitest/vitest.mjs run && node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
```

Expected: 全绿；0 error。

- [ ] **Step 6: 提交**

```bash
git add src/ui/view/sse.ts src/ui/main.tsx tests/ui/sse.test.ts
git commit -m "feat(ui): SSE流抽象与回放接线"
```

---

### Task 10: 视觉验收脚本与收尾

**Files:**
- Create: `scripts/verify-ui.mjs`
- Create: `src/ui/demo/fixtures.ts`
- Modify: `package.json`（若 Task 1 未含 `verify:ui` 则补）
- Test: `scripts/verify-ui.mjs`（运行验收，非 vitest 用例）

**Interfaces:**
- Consumes: `dist-web/` 构建产物；系统 Chromium 可执行文件（优先 `process.env.CHROME_PATH`，其次 Windows 常见路径：`C:\Program Files\Google\Chrome\Application\chrome.exe`、`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`、`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` 等，Linux/macOS 常见路径一并探测）。
- Produces:
  - `scripts/verify-ui.mjs`：Node 脚本（ESM，零依赖，仅用 `node:child_process` / `node:http` / `node:fs` / 内置 `WebSocket`）。实现步骤：
    1. 用 `node:http` 起一个静态文件服务，把 `dist-web/` 作为根目录 serve（仅本机回环地址，随机端口），保证页面以 `http://127.0.0.1:<port>/` 加载（file:// 下 ES module 与 fetch 受限，必须走 http）。
    2. 子进程启动 Chromium：`chrome --headless=new --disable-gpu --no-sandbox --remote-debugging-port=<随机端口> about:blank`。
    3. 轮询 `http://127.0.0.1:<debugPort>/json/version` 取 `webSocketDebuggerUrl`，用 Node 24 内置全局 `WebSocket` 连接 CDP。
    4. `Page.navigate` 到静态服务 URL → 等待 `Page.loadEventFired` → `Runtime.evaluate` 注入探针表达式（读取几何量/计算样式/扫描文本），结果以 JSON 数组形式从页面 `window.__VERIFY__` 收回到 Node。
    5. 逐项断言 V1-V14（断言值见下），每项输出 `PASS`/`FAIL` 与实测值；任一项 FAIL 时 exit code 1。
    6. Chromium 找不到 → stderr 明确报错并 exit 2（不静默跳过）。
    - V1 三栏头部 y=48 h=40；V2 左 264 右 404（≥1180px 视口）；V3 内容宽=主区宽−40；V4 `document.scrollWidth === window.innerWidth`；V5 关键文本元素 `scrollWidth <= clientWidth + 1`（采样：会话标题、路径步、工具 args、状态栏各项）；V6 717px 高工作区下默认展开树不裁剪（厂商分流子树完整可见）；V7 滚动条配色（夜间 thumb `rgb(47,61,75)`、日间 `rgb(198,208,217)`，track 透明，width `thin`）；V8 出现滚动条时实占 10px、无横向溢出；V9 三主题解析（`data-theme="light|dark|system"` + matchMedia 模拟后 canvas/accent 计算值符合 frontend-design §5.1）；V10 无 emoji（遍历文本节点，无 `\p{Extended_Pictographic}` 码点）；V11 焦点可见（逐元素 `Tab()` 后 `document.activeElement` 有 outline 计算值非 none）；V12 减少动效（CDP `Emulation.setEmulatedMedia` features 置 `prefers-reduced-motion: reduce` 后过渡 `transition` 计算值为 none）；V13 回放一致性由 vitest 已覆盖（脚本打印引用，不重复）；V14 写操作未确认不显示"已执行"（检查 GuardNotice 文案）。
  - `src/ui/demo/fixtures.ts`：**唯一定义的演示会话数据**（`SessionEvent[]`，Task 3 创建，内容与原型对话一致），既供 `main.tsx` 回放态渲染，也供测试 import；**不做转发层，无第二源**。`src/ui/main.tsx` 的 demo 回放与所有测试均从 `demo/fixtures.js` 导入。

- [ ] **Step 1: 写验收脚本骨架**

`scripts/verify-ui.mjs` 先编写框架：静态服务 + Chromium 进程启动 + CDP 连接 + 页面加载 + 探针收集（`window.__VERIFY__`）→ 先放 1-2 条断言（如 V1/V4）跑通链路。

- [ ] **Step 2: 构建产物并运行确认 Fail（伪断言先行）**

Run: 先运行 `node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit` 与（若依赖就绪）`vite build`，再 `node scripts/verify-ui.mjs`。
Expected: 脚本能启动 Chromium 并加载页面；至少 V1 通过（几何正确），允许部分 FAIL 在后续步骤修复。V4 首次若 FAIL，通常说明 scrollbar 占位导致横向溢出——这是真实缺陷，需修复样式而非放宽断言。

- [ ] **Step 3: 补齐断言并全绿**

对照 frontend-design §12 逐项落实探针；修复脚本或组件/样式至 14 项全 PASS。此步允许回过头修改 `src/ui/styles.css` 或组件尺寸（几何问题）。

- [ ] **Step 4: 用户安装依赖后全量验证清单**

```bash
npm run typecheck:web
npm run test:ui
npm run build:web
npm run verify:ui
npm run lint && npm test && npm run build
```

Expected: 全部通过；内核 `npm test` 无回归（UI 测试加入后总数增加）。

- [ ] **Step 5: 文档留痕**

`dev-notes/P0-UI.md` 增量追加本工程各阶段记录（每任务一段：用户关键原话 / 关键产出 / 被拒绝或纠偏 / 翻车与返工）；`docs/frontend-design.md` 变更记录追加 v1.2（若实现中发现设计契约偏差，逐条修订并注明）；`docs/deferred-issues.md` 登记实现期发现且不修的遗留。

- [ ] **Step 6: 提交**

```bash
git add scripts/verify-ui.mjs src/ui/demo package.json dev-notes docs/frontend-design.md docs/deferred-issues.md
git commit -m "feat(ui): 视觉验收脚本与收尾文档"
```

---

## Self-Review（写作期自审）

**1. Spec 覆盖**：spec §3 工程结构 17 个文件全部有归属任务（Task 1 脚手架/main/styles；Task 2 theme/icons；Task 3 transcript/fixtures；Task 4 app/topbar/statusbar；Task 5 rail 两 pane；Task 6 主区四组件；Task 7 三卡；Task 8 composer/dock 五组件；Task 9 sse；Task 10 verify-ui/demo）。spec §4 类型接线（4 个内核类型）由 Task 3 imports 覆盖。spec §5 投影规则由 Task 3 测试 7 条覆盖。spec §6 15 组件：§7.1 topbar(T4)、§7.2-7.3(T5)、§7.4-7.6(T6)、§7.7-7.9(T7)、§7.10-7.14(T8)、§7.15 statusbar(T4)。spec §7 SSE(T9)。spec §8 V1-V14（V1-V12 vite T10 脚本；V13 T3/T9；V14 T7/T8）。spec §9 测试策略逐任务落实。spec §10 demo fixture(T3/T10)。

**2. Step 扫描**：每步都有"写什么/跑什么/期望什么"；无 TBD 行。风险：Task 1 Step 4 依赖未经用户安装可能失败——已明确"暂停并注明待 npm install"这不属于模糊（有明确动作）。Task 3 工具→kind 映射 `detail` 形状判断存在实现自由度——已钉死三种形状与 error 兜底。

**3. 类型一致性**：`ThemeChoice/ResolvedTheme`(T2→T4)→TopBar props 一致；`TranscriptView/TranscriptStep/TranscriptEvent/ToolCardModel/VerdictModel/GuardModel`(T3→T6/T7/T4) 命名在 Task 3 Interfaces 全量定义，T4/T6/T7 引用同一标识符；`createEventStream/postAction`(T9) 自闭环；Dock props `logLines/registers`（T8 定义、T8 消费）。无跨任务改名。

**4. Review Focus**：六条风险逐条有归属任务（T1 依赖、T4-9 happy-dom 边界、T3 确定性、T4 repeated 投影防护、T3+T7 错误渲染、T7+T8 V14 确认）。额外检查：V5 文本截断在 T10 探针覆盖；`prefers-reduced-motion`（§9 交互）在 T10 V12 覆盖与样式遵守。

**5. 比例**：plan 约 450 行，spec 约 260 行，比例 ~1.7:1，处于“计划略长于规格”的合理区间；代码块均为测试断言与接口签名，无函数体实现抄写。
---

### Task 11: 第一轮整体审查修复（P1 + 关键 P2）

**Files:**
- Modify: `src/ui/view/transcript.ts`
- Modify: `src/ui/components/conversation/tool-card.tsx`
- Modify: `src/ui/components/conversation/guard-notice.tsx`
- Modify: `src/ui/components/conversation/messages.tsx`
- Modify: `src/ui/components/conversation/verdict-card.tsx`
- Modify: `src/ui/components/conversation/composer.tsx`
- Modify: `src/ui/components/conversation/pathline.tsx`（仅样式）
- Modify: `src/ui/components/dock/device-monitor.tsx`
- Modify: `src/ui/components/dock/dock.tsx`
- Modify: `src/ui/components/rail/knowledge-pane.tsx`（样式与 active 色）
- Modify: `src/ui/app.tsx`
- Modify: `src/ui/styles.css`
- Modify: `scripts/verify-ui.mjs`
- Modify: `web/index.html`
- Modify: `tests/ui/transcript.test.ts`
- Modify: `tests/ui/theme.test.ts`（拆分纯函数/DOM 用例）
- Modify: `tests/ui/components/conversation.test.tsx`
- Create: `tests/ui/transcript-consistency.test.ts`
- Modify: `docs/superpowers/specs/2026-10-18-ui-workbench-design.md`
- Modify: `docs/deferred-issues.md`

**Interfaces:**
- Consumes: Task 1-10 全部产物。
- Produces:
  - `ToolCardModel` 增 `text?: string`、`artifactPath?: string`、`pending?: boolean`。
  - `TranscriptView` 增 `context?: { used: number; limit: number }`、`sessionId?: string`。
  - `GuardNotice({ guard, onConfirm?, onReject? })`：待确认态渲染「确认写入」「拒绝」按钮；点击确认后本地状态为「执行中」（不得显示「已执行」）；`onReject` 后状态为「已拒绝」。
  - `MessageStream` 将 `onGuardConfirm/onGuardReject` 透传给 GuardNotice；App 传入回调（无后端时回调仅记录，不伪造成功）。
  - `verify-ui.mjs`：清理失败仅 warning，汇总与 exit code 必然执行；V13 读取 `tests/ui/transcript-consistency.test.ts` 的存在并明确标注「由 vitest 覆盖」，不得写死 PASS 值而不检查测试文件。

- [ ] **Step 1: 修复投影契约（P1-4 / P1-5 / P2-1 / P2-2）**

`transcript.ts`：
1. 成功 `tool_result` 分支：`detail` 存在 → 结构化形态；否则 `text` 非空 → `kind:"readout"`，把 text 放入 `text` 字段并渲染纯文本；`text` 为空 → `kind:"error"` 且 `errorCode:"empty_result"`、`errorText:"工具未返回读数"`。
2. 骨架创建时 `ok:true, pending:true`；收到结果后清 `pending`。
3. 新增 `status` 分支：`payload.status === "done"` → view.status = "done"；`payload.status === "usage_missing"` → 保持 "diagnosing" 并记录 interruptReason（或 view.status = "diagnosing"）；未知值忽略。
4. `usage` 事件投影 `view.usage`；`cost` 取 `payload.costUsd` 或 view.usage.costUsd 累计。
5. `transcriptFromLoop` 处理 `turn_end.costUsd`（累加）与 `done`/`interrupted` 状态；与 `transcriptFromSession` 的组件序列保持一致。
6. 导出 `DEMO_SESSION_ID = "#128"` 或在 fixture 里提供 sessionId，供 StatusBar 使用。

`app.tsx`：StatusBar 接 `view.usage` / `view.context` / `view.cost` / `view.sessionId`（无值显示 `—`）。

- [ ] **Step 2: 修复安全与工具卡 UI（P1-3 / P2-9 / Minor）**

1. `GuardNotice` 增加确认/拒绝按钮与回调；确认后显示「执行中，等待工具结果」；仅 state 为「已执行」才显示已执行。
2. `DeviceMonitor` 复位确认展示 `AIRCR @ 0xE000_ED0C = 0x05FA_0004`；点击确认后显示「执行中，等待工具结果」，不显示「已执行复位」。
3. `ToolCard`：`pending` 时不显示成功勾，显示「执行中」；成功无 detail 时渲染 `text`；折叠区显示行数/字节数并从 `text` 展开；`readOnly` 显式消费（中性色）；`errorText === ""` 时回退固定文案。
4. `VerdictCard` 根因文本中的寄存器/值用 `.k` 行内代码样式（对匹配 `/[A-Z_]+.{0,4}0x[0-9A-F_]+|PCLK1|HSI|HSE/` 的片段包 `<code>`）；低置信度追加不确定性说明。
5. `Composer` 发送后滚动消息流到底部（通过 `onSend` 后由父级或内部 `scrollIntoView` 实现）。
6. `styles.css`：PathLine 上下 padding 10px；`.hit[data-s="4"] .bar` 用 `--wave-4`；`.tree-row.is-active` 文字色 `--accent`；`.dock-sec-head .count` 计数胶囊样式。

- [ ] **Step 3: 修复验收脚本与测试（P1-1 / P1-2 / P2-5 / Minor）**

1. 新建 `tests/ui/transcript-consistency.test.ts`：以同一会话语义构造成对的 `SessionEvent[]` 与 `LoopEvent[]`（user → assistant(ask) → assistant(toolCalls) → tool_result → assistant(verdict) → guard），断言 `transcriptFromSession(a).events` 与 `transcriptFromLoop(b).events` 的 `kind` 序列和工具名序列一致；并断言两次归约结果稳定。
2. `verify-ui.mjs`：删除 `finally` 中的 `return`；清理失败 `console.warn`；汇总与 `process.exit(hasFail ? 1 : 0)` 必达；V13 改为读取 `tests/ui/transcript-consistency.test.ts` 文件存在且包含 `transcriptFromLoop` 断言，缺失则 FAIL。
3. `conversation.test.tsx` 的 checkpoint 断言改为构造含真实 `checkpoint` 事件（`type:"checkpoint"`）后断言不渲染。
4. `theme.test.ts` 拆分：`tests/ui/theme.test.ts` 保留纯函数用例（node 环境），`tests/ui/theme-dom.test.ts`（happy-dom）保留 `readStoredTheme/applyTheme` 用例。
5. `web/index.html` 首屏脚本校验 localStorage 值仅接受 `light|system|dark`，否则 `system`。

- [ ] **Step 4: 文档回填**

1. spec §3.1 默认导出改为命名导出（与实现一致）。
2. spec §5 补 `status` / usage / context / cost 投影规则与 `ToolCardModel.text/artifactPath/pending`。
3. spec §7.9 补确认/拒绝回调契约；§7.7 补 text-only 与 pending。
4. `docs/deferred-issues.md` 新增：D-058 Dock/设备/日志为静态演示数据、D-059 回放/导出按钮未接行为、D-060 SSE 无后端时输入处理、D-061 StatusBar context/limit 来源未定；更新变更记录。

- [ ] **Step 5: 全量验证**

```bash
node ./node_modules/vitest/vitest.mjs run
node ./node_modules/typescript/bin/tsc --noEmit
node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
node ./node_modules/vite/bin/vite.js build
node scripts/verify-ui.mjs
node ./node_modules/typescript/bin/tsc -p tsconfig.build.json
```
Expected: 全绿；verify-ui 14/14 且打印 SUMMARY；V13 非硬编码。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "fix(ui): 修复整体审查的投影安全与验收缺陷"
```

---

### Task 12: 第二轮红队审查修复（P2 + 可修 Minor）

**Files:**
- Modify: `src/ui/view/transcript.ts`
- Modify: `src/ui/view/sse.ts`
- Modify: `src/ui/components/conversation/tool-card.tsx`
- Modify: `src/ui/styles.css`
- Modify: `tests/ui/transcript.test.ts`
- Modify: `tests/ui/sse.test.ts`
- Modify: `tests/ui/components/cards.test.tsx`
- Modify: `docs/deferred-issues.md`

**Interfaces:**
- Consumes: Task 1-11 全部产物。
- Produces:
  - `ToolCardModel.text` 允许为空且 `artifactPath` 存在时保留 `kind:"readout"`（不降级为 error），UI 显示「结果已落盘」与路径。
  - `createEventStream` 维护单一重连 timer；同一 source 的重复 `error` 只调度一次；`close()` 后不再调用 `onError`；构造抛错转 `onError`。
  - `transcriptFromLoop`/`transcriptFromSession` 的 costUsd 均经有限数校验（非有限或负数忽略）。
  - 折叠摘要首行截断到 120 字符。

- [ ] **Step 1: 写失败测试**

1. `tests/ui/transcript.test.ts`：
   - `text` 为空但 `artifactPath` 存在 → 投影为 `kind:"readout"` 且保留 `artifactPath`（非 `empty_result`）。
   - session costUsd 为负数 / NaN → `view.cost` 缺失；loop costUsd 为 NaN / 负数 → `view.cost` 缺失。
2. `tests/ui/sse.test.ts`：
   - 连续两次 `error`（retryMs=5）→ 实例数 ≤ 2（初始 + 1 次重连），不得出现 3 个。
   - `close()` 后 `error` → `onError` 不被调用。
   - 构造抛错 → `onError` 被调用且不逃逸。
3. `tests/ui/components/cards.test.tsx`：
   - `text` 为 100000 字符且 `kind:"readout"` → 折叠摘要文本长度 ≤ 130。
   - `kind:"readout"` + `artifactPath` + 空 text → 渲染「结果已落盘」与路径。

- [ ] **Step 2: 运行确认 RED**

Run: `node ./node_modules/vitest/vitest.mjs run tests/ui/transcript.test.ts tests/ui/sse.test.ts tests/ui/components/cards.test.tsx`
Expected: 新增用例失败（当前实现行为不符）。

- [ ] **Step 3: 实现修复**

1. `transcript.ts`：成功结果分支——`detail` → 结构化；否则 `text` 非空 → readout 纯文本；否则 `artifactPath` 非空 → readout + artifactPath + `text:""`（不置 error）；三者皆空 → `empty_result`。`applyCost` 统一校验 `Number.isFinite(v) && v >= 0`。
2. `sse.ts`：`let retryTimer: ReturnType<typeof setTimeout> | null`；`scheduleReconnect()` 若 timer 已存在则不再调度；`close()` 置 closed 并清 timer；`error` 回调内先判 `closed`；`new ctor(url)` 包 try/catch → `onError`。
3. `tool-card.tsx`：折叠摘要 `firstLine.slice(0, 120)`，超长加省略号；新增 artifact 展示分支。
4. `styles.css`：删除重复 `.dock` 定义（保留合并后的单条，`overflow:hidden`，`dock-body` 负责滚动）与重复 `@media (max-width:819.98px)` 规则。
5. `docs/deferred-issues.md`：登记 Minor-4（usage 缺字段补 0）为 D-062；变更记录追加。

- [ ] **Step 4: 全量验证**

```bash
node ./node_modules/vitest/vitest.mjs run
node ./node_modules/typescript/bin/tsc --noEmit
node ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit
node ./node_modules/vite/bin/vite.js build
node scripts/verify-ui.mjs
node ./node_modules/typescript/bin/tsc -p tsconfig.build.json
```
Expected: 全绿；verify-ui 14/14 + SUMMARY。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "fix(ui): 修复红队审查的边界与SSE重连缺陷"
```
