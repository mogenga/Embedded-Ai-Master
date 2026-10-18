# Embedded-Ai-Master

面向嵌入式调试场景的 agent 内核，附带一个可运行的 Web 诊断工作台。当前交付 P0 内核（主循环与模型接入、会话事实源、工具管线、headless demo）与前端工作台（三栏布局、三态主题、消息流、调试坞、会话回放）。

## 技术栈

- TypeScript + Node.js >= 24（ESM-only）
- Zod v4
- Vitest v4
- Preact 10 + Vite 8（前端工作台；`@preact/preset-vite`、happy-dom 仅用于构建与测试）
- 实时通道：SSE + HTTP POST（前端保留 `EventSource` 替换点，当前交付抽象层）

## 安装

```bash
npm install
```

## 命令

```bash
npm test            # 全量单元/集成测试（不触网）
npm run coverage    # 覆盖率（lines 阈值 85%）
npm run lint        # 当前为 tsc --noEmit
npm run typecheck   # tsc --noEmit（内核）
npm run build       # 编译到 dist/

npm run dev:web       # 启动前端开发服务器（Vite）
npm run build:web     # 构建前端到 dist-web/
npm run test:ui       # 仅跑前端测试（tests/ui）
npm run typecheck:web # 前端类型检查（tsconfig.web.json）
npm run verify:ui     # V1-V14 浏览器视觉验收（需 Chrome/Edge）
```

## 目录结构

```
src/
├── config/       providers.json 加载与模型引用解析
├── context/      日志投影（buildMessages）与上下文预算
├── demo/         headless CLI 入口
├── loop/         事件类型、熔断、query 主循环
├── model/        模型协议、OpenAI 兼容适配器、重试、token 估算
├── session/      append-only JSONL 会话
├── tools/        工具契约、注册表、echo、五阶段执行管线
├── ui/           前端工作台（Preact 组件、TranscriptView 投影、SSE 抽象）
└── index.ts      runSession 装配
web/              Vite 入口 HTML
scripts/          verify-ui.mjs 浏览器视觉验收
tests/            Vitest 测试（tests/ui 为前端测试）
docs/             设计、计划与已知问题
```

## 配置

默认读取 `$HARNESS_HOME/providers.json`；`HARNESS_HOME` 缺省为 `%USERPROFILE%/.harness`（Windows）或 `~/.harness`。

```json
{
  "local-gw": {
    "protocol": "openai-chat-completions",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "apiKeyEnv": "LOCAL_GW_KEY",
    "models": {
      "flash": { "contextWindow": 128000, "maxOutput": 8192 }
    },
    "pricePerMillion": { "input": 1, "output": 1, "cachedInput": 0.1 }
  }
}
```

模型引用为 `provider/model`（如 `local-gw/flash`）。`apiKeyEnv` 指向的环境变量存在且非空时发送 `Authorization: Bearer <key>`；否则不发送该头（本地网关可空跑）。`pricePerMillion` 缺省时只统计 token，不启用 `maxCostUsd` 熔断。

## headless demo

```bash
npm run build
node dist/demo/run.js "读取平台信息后结束"
```

环境变量：

| 变量 | 说明 |
|---|---|
| `HARNESS_COMPAT_MODEL` | 必填，`<provider>/<model>` |
| `HARNESS_HOME` | harness 数据目录 |
| `HARNESS_COMPAT_BASE_URL` | 可选，覆盖 provider 的 `baseUrl` |
| `HARNESS_COMPAT_API_KEY_ENV` | 可选，覆盖 provider 的 `apiKeyEnv` |

demo 不读取 `HARNESS_COMPAT_API_KEY`（该变量仅 live 测试使用）；demo 的密钥来自 `HARNESS_COMPAT_API_KEY_ENV` 指向的环境变量。

退出码：

| 码 | 含义 |
|---|---|
| 0 | 正常完成（模型无工具调用） |
| 1 | 熔断（`maxTurns` / `maxCostUsd`） |
| 130 | 取消（SIGINT/SIGTERM） |
| 2 | 用法或装配错误（含运行期未恢复错误：模型 4xx/网络/响应非法/会话写入失败） |

会话写入 `$HARNESS_HOME/sessions/<id>/`：`header.json`、`session.v1.jsonl`、按需生成 `session.vN.jsonl` 与 `artifacts/`。

## Web 工作台

```bash
npm run dev:web     # http://localhost:5173/web/index.html
npm run build:web   # 产物 dist-web/web/index.html
```

- **架构**：Preact 只承担组件化与增量 diff；全部业务状态经 `src/ui/view/transcript.ts` 的纯函数投影 `TranscriptView`，实时渲染与回放共用同一归约。前端类型直接复用内核 `SessionEvent` / `LoopEvent` / `ToolResultPayload` / `ToolAnnotations`，不维护第二套事件模型。
- **回放模式**：未配置事件流时，页面渲染 `src/ui/demo/fixtures.ts` 的演示会话，可离线评审完整诊断流程（症状 → 分流 → KB → 取证 → 判决 → 写操作确认）。
- **实时通道**：配置 `VITE_EVENT_STREAM_URL` 后通过 `EventSource` 消费 `LoopEvent`；配置 `VITE_ACTION_URL` 后 Composer 以 `POST {"text":...}` 提交。二者均为可注入抽象（`src/ui/view/sse.ts`），服务端接入前不伪造提交成功。
- **主题**：`light` / `system` / `dark` 三态，`localStorage` 键 `eam-theme`，默认 `system`；切换不重载页面。所有颜色经 CSS 变量，图标为内联 SVG sprite。
- **验收**：`npm run verify:ui` 通过无头 Chromium 实测 V1-V14（三栏几何、无溢出/截断、滚动条配色与占位、三主题解析、无 emoji、焦点可见、减少动效、回放一致性、写操作确认）。浏览器探测优先 `CHROME_PATH`，其次 Chrome/Edge 常见安装路径；找不到时以 exit 2 明确失败。
- **安全边界**：写内存/复位需显式确认，确认后仅进入「执行中，等待工具结果」，不会在前端伪造「已执行」（R2）；工具失败显式展示错误码与文本（R3）。

## 会话管理

```text
<sessionDir>/
├── header.json          # id、createdAt、status、provider、model、workdir、forkedFrom
├── session.v1.jsonl     # 首代事件日志
├── session.vN.jsonl     # 单代超过阈值（默认 50 MiB）后按需生成
└── artifacts/           # 工具产物（按需）
```

- `header.status` 取 `open` / `closed`：create/resume 后为 `open`，`close()` 用临时文件 + rename 原子写 `closed`，重复 close 幂等。
- create 把 `provider` / `model` / `workdir` 写入 header；`workdir` 记录创建时的进程 cwd。
- 分代：append 前按字节判断，仅当当前代非空且追加后会越过阈值才新建 `session.v(N+1).jsonl`；读取按代数字升序合并，seq 跨代连续。
- 每轮模型请求前由 `query` 追加 `checkpoint` 事件（`payload.turn`），只落会话日志，不进入 `LoopEvent` 流。

### resume

`runSession` 的 `RunOptions` 支持 `resume: true`，必须显式提供 `sessionDir`：

```ts
for await (const event of runSession({
  input: "继续排查",
  model: "local-gw/flash",
  resume: true,
  sessionDir: "C:/Users/me/.harness/sessions/<id>",
})) {
  // ...
}
```

前置与校验（均在首个 `next()` 前抛 `SessionResumeError`，失败不写 header/日志）：

- `sessionDir` 缺省、目录或 header 不存在 → `missing_session_dir`；`sessionDir` 为空或路径为文件 → `invalid_target`。
- `model` 与 `header.model`（存在时）不一致 → `model_mismatch`。
- 显式传入的 `sessionId` 与 `header.id` 不一致 → `session_id_mismatch`。
- 提供 `systemPrompt` 且已有 system 事件内容不同 → `system_prompt_mismatch`；非空会话无 system 事件时不允许补写，空会话可补写。
- 不重复写已有 system/user 事件；resume 后 `header.status` 改回 `open`。
- 崩溃尾部恢复：若日志最后一个 assistant 批次的 `toolCalls` 缺少 `tool_result`，resume 会按原调用顺序补写 `tool_result_lost`（`detail.crashRecovery = true`）并追加 `interrupted { reason: "crash_recovery" }`；其他投影错误仍 fail-closed。

### fork（仅库 API）

`forkSession` 位于 `src/session/persistence.ts`（构建后 `dist/session/persistence.js`），**尚未接入 CLI / `runSession`**：

```ts
import { forkSession } from "./dist/session/persistence.js";

const child = await forkSession(sourceDir, atSeq, {
  id: "branch-1",          // 可选，缺省随机
  targetDir: "…/branch-1", // 可选，缺省 $HARNESS_HOME/sessions/<id>
});
```

- `atSeq` 必须使 `events[0..atSeq]` 可被 `buildMessages` 投影（批次闭合），而非按事件类型判断：批中 `usage`、部分 `tool_result`、未闭合的 assistant 批次均 → `not_turn_boundary`；无工具轮的 `usage` 前缀与普通 user 前缀可通过。前缀含 `atSeq` 并保留原 `seq` / `parent`，新 header 写 `forkedFrom: { sessionId, seq }`。
- `opts.id` 不得与源会话 id 相同；`targetDir` 不得位于源会话目录内（含相同目录），否则 `invalid_target`。
- artifact 自包含：前缀中 `tool_result.payload.artifactPath` 指向的文件复制到新会话 `artifacts/` 并重写路径；源文件缺失或越界时保留原路径并标 `detail.artifactMissing = true`，不阻塞 fork。
- target 目录已存在（含空目录）→ `target_not_empty`；`targetDir` 或其父路径为文件 → `invalid_target`；失败时回滚本次写入。
- 两个会话可并发追加、互不影响；同一目录的跨进程锁尚未实现（D-039）。

## live 测试

默认跳过，不触网。开启后使用真实 OpenAI 兼容网关（git-bash）：

```bash
# git-bash
HARNESS_COMPAT_LIVE=1 \
HARNESS_COMPAT_MODEL=local-gw/flash \
HARNESS_COMPAT_BASE_URL=http://127.0.0.1:8080/v1 \
HARNESS_COMPAT_API_KEY=your-key \
npm test
```

PowerShell：

```powershell
$env:HARNESS_COMPAT_LIVE="1"; $env:HARNESS_COMPAT_MODEL="local-gw/flash"; $env:HARNESS_COMPAT_BASE_URL="http://127.0.0.1:8080/v1"; $env:HARNESS_COMPAT_API_KEY="your-key"; npm test
```

`HARNESS_COMPAT_MODEL` 同样使用 `provider/model` 引用，测试会从 `providers.json` 解析出裸模型名与 `apiKeyEnv`；`HARNESS_COMPAT_BASE_URL` 可覆盖 `baseUrl`；`HARNESS_COMPAT_API_KEY` 优先于 `apiKeyEnv`。

## 已知限制

见 `docs/deferred-issues.md`。当前与 P0 直接相关的：

- 超时只保证管线返回，不保证工具真正停止（D-022）。
- 网关不返回 `usage` 时 `maxCostUsd` 无法生效（D-027）。
- token 估算按 UTF-16 字符数 / 4，CJK 场景偏低（D-005）；且不计 `tool_calls` 参数（D-033）。
- 模型响应体无大小上限，模型请求无请求级超时（D-031、D-032）。
- 会话 append 无 `fsync`，断电或强杀可能留下半行（D-035）。
- 4xx 除 429 外均不重试，408/409/425 未细分（D-036）。
- 工具 JSON Schema 可能携带 `$schema`，严格网关兼容性待 live 验证（D-019）。

前端工作台：

- SSE 事件流与 action 端点契约未定，后端接入前不伪造提交成功（D-051、D-060）。
- Dock/设备/日志为静态演示数据，尚未由会话事件驱动（D-058）。
- 回放/导出按钮已渲染但未接行为（D-059）。
- StatusBar 的探针/串口状态由 props 推断，缺少显式状态枚举（D-052）。
- 无后端时输入不会回填，接入端点后需补提交中/失败态（D-053）。
- 717px 工作区下知识库整树需内部滚动（D-054）；V3/V11 的验收口径边界见 D-055、D-056。
- Chromium 非标准安装需设置 `CHROME_PATH`（D-057）。

## 设计文档

- `docs/BRD.md` — 业务需求与路线图
- `docs/p0-kernel-design.md` — P0 内核设计
- `docs/frontend-design.md` — 前端设计规范（布局、令牌、组件、验收）
- `docs/superpowers/specs/2026-10-16-p0-kernel-dims-1-2-design.md` — 维度 1+2 可实现设计
- `docs/superpowers/plans/2026-10-16-p0-kernel-dims-1-2.md` — 实现计划
- `docs/superpowers/specs/2026-10-18-ui-workbench-design.md` — 前端工程实现设计
- `docs/superpowers/plans/2026-10-18-ui-workbench.md` — 前端实现计划
- `docs/deferred-issues.md` — 已知问题与升级条件
