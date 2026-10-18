# P0 维度 4 可实现设计(工具系统)

> 日期: 2026-10-18 · 状态: 草稿待评审 · 上游: [p0-kernel-design.md](../../p0-kernel-design.md) §4, [BRD.md](../../BRD.md) PLAT-3。
> 本轮交付终点: `fs`/`shell`/`glob`/`grep` 四个内置工具接入现有五阶段管线与 `runSession`, 单测+集成测试, 两轮独立审查后合并 `feat/p0`。不合并 `main`。

## 1. 意图与为什么

P0 已有工具契约、注册表、五阶段管线与 echo demo, 但没有诊断真正需要的内置工具: 读日志、翻工程、跑编译。维度 4 交付四件套, 让"对话 + 工具调用"闭环具备实际工作能力。

嵌入式取证(探针/串口/KB)仍全部走 MCP(#5), 不进内核——领域边界不变。

## 2. 目标 / 非目标 / 反目标

### 目标

1. `fs`: 读/写/编辑合一, 全部限制在 `ToolCtx.cwd`(workdir)内。
2. `shell`: 在 workdir 内执行命令; **cwd 限制 + 明显破坏性命令拦截**(用户已定); 超时/取消/输出截断复用管线。
3. `glob`: 按 `*`/`**`/`?` 匹配文件名, 返回相对 POSIX 路径。
4. `grep`: 正则搜索文本文件, 返回 `path:line:text`。
5. `runSession` 注册 `[echo, fs, shell, glob, grep]`; 工具 schema 进模型请求。
6. 所有工具使用结构化 `ToolResult`; 错误是数据, 不抛异常字符串; 路径越界/symlink 越界拒绝。

### 非目标

- MCP 工具发现/命名空间(#5)。
- 权限模型/审批通道(P1): P0 无 allow/deny, 只有 shell 的固定危险命令拦截。
- 完整 glob 语法(brace/character class)、二进制 grep、编码检测、增量索引。
- OS 级沙箱/容器; shell 仍可执行任意未被拦截的命令。
- 工具结果落盘/截断策略(已由 #8 管线负责)。

### 反目标

- 声称 shell 是沙箱或安全隔离。
- 允许路径逃出 workdir(`..`、绝对路径、symlink 父目录)。
- 对非零退出码统一标 `isError:true`(命令执行成功但业务失败, 应让模型看 exitCode/stderr)。
- 为 glob/grep 引入外部二进制或新依赖。

## 3. 约束

- TypeScript + Node 24 ESM-only, strict, 相对导入 `.js`; 不新增依赖。
- Windows 一等公民: 用 `node:path`; 路径比较大小写不敏感; shell 用 Node `spawn(..., {shell:true})` 走平台 shell; 测试用跨平台 `node -e`。
- 所有工具输入用 Zod v4; 校验失败由管线回传 `schema_validation`。
- 所有路径操作先 `resolveInWorkdir(ctx.cwd, input)`; workdir 为绝对路径。
- shell 的超时/取消由管线 `AbortSignal` 传入; 工具自身不重复实现超时。
- 提交 `feat(tools): ...`; 每任务 TDD; 两轮独立审查(实现 + 整合/红队)。

## 4. 接口与行为

### 4.1 路径安全

```ts
// src/tools/path-safety.ts
export function resolveInWorkdir(workdir: string, input: string): string;
```

- `workdir = path.resolve(ctx.cwd)`; `target = path.resolve(workdir, input)`。
- 词法检查: `path.relative(workdir, target)` 不得以 `..` 开头、不得为绝对路径。
- 存在性检查: 对 `target` 或最近的已存在祖先做 `realpathSync`, 再次要求位于 `realpath(workdir)` 内; 拒绝 symlink/junction 指向外部。
- Windows 比较统一 `toLowerCase()`。
- 失败抛 `ToolPathError { code: "path_outside_workdir" | "path_invalid" }`; 工具捕获后返回 `{isError:true, code, message, text}`。
- workdir 来源: `runSession` 创建时 `workdir = opts.cwd ?? process.cwd()`, 写入 `header.workdir`; 恢复时优先 `opts.cwd`, 未提供则用 `header.workdir`; 两者都存在且不一致 → `SessionResumeError("workdir_mismatch")`。
- glob/grep 遍历一律不跟随 symlink(目录与文件均跳过), 避免越界。

### 4.2 `fs` 工具

```ts
schema = z.object({
  op: z.enum(["read", "write", "edit"]),
  path: z.string().min(1),
  content: z.string().optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  offset: z.number().int().nonnegative().optional(), // 0-based 行
  limit: z.number().int().positive().max(2000).optional(),
});
annotations = { readOnly: false, destructive: true };
```

- `read`: UTF-8 文本; 流式读取(`createReadStream` + `readline`), 不整文件载入内存; 默认最多 2000 行/256 KiB; 返回带 1-based 行号的行(`   1| text`); `offset/limit` 可选; 超出时 `text` 末尾加 `[truncated]`; `offset` 不小于总行数(含空文件 `offset:0`)时返回 `(no lines at offset)` 且 `detail.lines=0`(不返回空成功)。
- `write`: `content` 必填; 父目录在 workdir 内且不存在则 `mkdir(recursive)`; 覆盖写; 返回 `wrote <bytes> bytes to <relpath>`; 拒绝 Windows 保留设备名: 对 basename 先 `trim`、去 `:stream` 后缀、去尾部点/空格, 再匹配 `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`(含扩展名, 大小写不敏感)。
- `edit`: `oldText`/`newText` 必填; 读取全文; 按文件换行风格(`\r\n` / `\n`)归一 `oldText`/`newText` 后匹配与替换, CRLF 文件保持 CRLF; `oldText` 必须**恰好出现一次**(非重叠匹配), 否则 `edit_not_unique`/`edit_not_found`; 替换后写回; 返回 `replaced 1 occurrence in <relpath>`; 同样拒绝 Windows 保留设备名。
- 错误码: `path_outside_workdir`、`path_invalid`、`not_found`、`not_a_file`、`read_failed`、`edit_not_found`、`edit_not_unique`、`write_failed`、`invalid_input`、`reserved_name`、`internal_error`。
- 读失败/文件不存在必须显式报错(R3), 不返回空内容。
- `COM¹`/`COM²`/`COM³` 等上标设备名变体暂不覆盖, 见 D-073。

### 4.3 `shell` 工具

```ts
schema = z.object({ command: z.string().min(1), cwd: z.string().optional() });
annotations = { readOnly: false, destructive: true };
```

- `cwd = resolveInWorkdir(ctx.cwd, cwd ?? ".")`; 不存在/非目录 → `cwd_invalid`。
- 危险命令拦截(大小写不敏感, 仅明显破坏性; **不是沙箱**):
  - `rm` 带 `-r`/`-f` 且目标为 `/`、`~`、`$HOME`/`${HOME}`、多级 `..`、盘符根(`C:`/`C:\`/`C:\*`);
  - `mkfs`、`format <drive>:`、`diskpart`、`shutdown`、`reboot`、`poweroff`、`halt`;
  - `dd ... of=/dev/...`;
  - `:(){ :|:& };:`(fork bomb);
  - `del`/`erase`/`rd`/`rmdir /s` 打 `<drive>:\`、`<drive>:\*`、`<drive>:\*.*`、`reg delete HKLM`、`bcdedit`、`cipher /w`.
  - 命中 → `{isError:true, code:"dangerous_command", message, text}`，**不 spawn**。
- 执行: `spawn(command, { shell: true, cwd, env: process.env })`; 收集 stdout/stderr 各最多 1 MiB(超出截断并标记); 等待 close。
- 取消: `execute` 自管 abort——Windows 用 `taskkill /T /F` 杀进程树, POSIX 杀 `detached` 进程组; 不传 Node 内置 `signal`(避免只杀 shell 留下孙进程); 调用方中止返回 `shell_aborted`。
- 返回 `isError:false` + `detail: { exitCode, signal, stdout, stderr, stdoutTruncated, stderrTruncated }`; `text` 包含 `exit=<n>`、stdout、stderr(便于模型直接读)。
- 非零退出码不算工具错误; spawn 失败 `shell_spawn_failed`; 子进程被系统信号终止 → `isError:true`, `code:"shell_terminated"`, `detail.exitCode:null` + 实际 `signal`(不把 null 伪装成 1)。
- 错误码: `ok`、`dangerous_command`、`cwd_invalid`、`shell_spawn_failed`、`shell_aborted`、`shell_terminated`。
- 明确文档: 拦截列表不完备; P1 权限层再收紧。

### 4.4 `glob` 工具

```ts
schema = z.object({ pattern: z.string().min(1), path: z.string().optional() });
annotations = { readOnly: true };
```

- 根 = `resolveInWorkdir(path.resolve(ctx.cwd), path ?? ".")`; 递归遍历。
- 忽略目录: `.git`/`node_modules`/`.harness`/`dist`/`coverage`/`build`/`out`/`target`/`.pio`, 以及前缀 `cmake-build-`(如 `cmake-build-debug`)。
- 仅遍历中不跟随 symlink(目录与文件均跳过); 显式 `path` 根若为 symlink 目录, `stat`/`readdir` 会跟随并遍历其目标。
- pattern 先按 Windows 习惯把 `\` 规范化为 `/`; 仅完整路径段(前后为 `/` 或边界)的 `**` 特殊: `**/` → `(?:.*/)?`(使 `**/*.ts` 匹配根级), 段尾 `**` → `.*`; 段内 `**`(如 `a**b`)按 `*` 处理; `*` → `[^/]*`, `?` → `[^/]`, 其余字符转义; 正则加 `u` 标志。匹配相对 **workdir**(不是 `path` 根)的 POSIX 路径; 大小写敏感; `*` 也匹配以点开头的隐藏文件(不实现 dot:false)。
- 上限: 扫描 5000 个文件、返回 200 条结果; 返回按字典序排序的、相对 workdir 的 POSIX 路径, 每行一条; 结果超出 200 追加 `[truncated]`, 扫描达到 5000 且仍有未处理条目追加 `[scan truncated at 5000 files]`。
- 无匹配 → `text: "(no matches)"`, `isError:false`。
- `readdir` 的 `EACCES`/`EPERM`/`ENOENT` 计为不可读, 跳过并在 `text` 末尾加 `[skipped N unreadable entries]`(R3: 不静默); 其他资源错误(`EMFILE`/`ENOMEM` 等) → `read_failed`, 不静默。
- 非法 pattern(空/含 NUL) → `invalid_pattern`; 根不存在 → `not_found`; 根不是目录 → `not_a_directory`; 路径非法 → `path_invalid`; 越界 → `path_outside_workdir`。
- `detail`: `{ scanned, matched, returned, skipped, truncated, scanTruncated }`。

### 4.5 `grep` 工具

```ts
schema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(1000).optional(),
});
annotations = { readOnly: true };
```

- 根同 glob; 遍历同一忽略列表; 不跟随 symlink; 只读 ≤2 MiB 的文件; 含 NUL 的文件跳过(二进制)。
- `new RegExp(pattern, ignoreCase ? "i" : "")`; 无效正则 → `invalid_pattern`。
- `glob` 可选, 用 4.4 的同一匹配器过滤文件。
- 每行匹配输出 `<relpath>:<line>:<text>`, `<relpath>` 相对 **workdir**(可直接喂回 `fs`); 结果按 relpath 字典序、行号升序输出; 行号 1-based; CRLF 按行切分且输出不含 `\r`。
- 默认最多 200, 可到 1000; 超出加 `[truncated]`。
- 跳过二进制/超大/不可读文件时在 `text` 末尾加 `[skipped N files (binary/too large/unreadable)]`, 并写 `detail.skipped = { binary, tooLarge, unreadable }`(R3: 不静默)。
- 无匹配 → `(no matches)`; 不报错; 若同时有跳过文件, 跳过披露仍追加在末尾。
- 错误码: `invalid_pattern`、`not_found`、`not_a_directory`、`path_invalid`、`path_outside_workdir`、`read_failed`。
- `detail`: `{ scanned, matched, returned, skipped, truncated, scanTruncated }`。

### 4.6 注册与装配

```ts
// src/tools/builtin.ts
export function createBuiltinTools(): ToolDef<unknown>[]; // [echoTool, fsTool, shellTool, globTool, grepTool]
```

- `runSession` 用 `new ToolRegistry(createBuiltinTools())`。
- `runSession` 向 `LoopCtx.cwd` 传 `opts.cwd ?? process.cwd()`(创建与恢复一致; 恢复校验见 §4.1), 使工具根是用户工程而非会话目录。
- 工具名保持裸名 `fs/shell/glob/grep/echo`(符合 OpenAI `^[a-zA-Z0-9_-]{1,64}$`)。
- 工具描述写清用途与限制(尤其 shell 非沙箱), 进模型请求。

## 5. 测试策略

全部单测 + 一个集成测试; 不触网; 临时 workdir + `afterEach` 清理。

- path-safety: workdir 内相对/绝对; `../` 越界; 绝对路径外部; symlink 文件/目录指向外部; Windows 大小写。
- fs: read 正常/offset/limit/截断/不存在; write 新建/覆盖/父目录创建/越界/写失败; edit 唯一/不存在/多处/越界。
- shell: 正常命令(`node -e "console.log('ok')"`); 非零退出码保留 exitCode 且 isError=false; 危险命令不执行(spy spawn 未被调用); cwd 越界; stdout/stderr 截断标记。
- glob: `*.md`、`**/*.ts`(含根级 `a.ts`)、`?`、无匹配、跳过目录、不跟随 symlink、结果上限、路径相对 workdir。
- grep: 匹配/ignoreCase/glob 过滤/无匹配/无效正则/跳过二进制/超大/不可读并在 text 披露/结果上限/路径相对 workdir。
- workdir: runSession 缺省用 `process.cwd()`; resume 时 `opts.cwd` 与 `header.workdir` 冲突 → `SessionResumeError("workdir_mismatch")`。
- 集成: mock fetch 断言 `tools` 含 5 个 function schema; 模型返回 fs 调用时闭环执行。
- 覆盖率: 新增工具代码 line ≥ 90%。

## 6. 验收口径

1. `npm test` 全绿; `npm run coverage` lines ≥85%; lint/typecheck/build 通过。
2. `runSession` 请求体 tools 含 5 个内置工具; fs/shell 调用可闭环。
3. 路径逃逸与危险 shell 命令被拒绝且不产生副作用。
4. 无新增依赖; 既有 echo/管线/会话行为不回归。
5. 两轮独立审查通过; dev-notes 增量留痕。

## 7. 留给实现的自由

- 危险命令正则的具体边界(需覆盖测试列出的样例)。
- glob 遍历的实现(递归 `readdir` vs `opendir`)与忽略目录集。
- fs read 行号格式的具体宽度。
- shell 输出 text 的排版。
- 工具描述文案。
