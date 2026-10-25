# 嵌入式部分缺陷修复 Todolist

> 来源: 2026-10-25 全面复查（6 路并行审查 + 2 轮对抗性复核）。
> 每条都有代码证据（文件+行号），复核被驳回的不在此列（见文末）。
> 格式约定沿用 deferred-issues.md：现象 / 影响 / 修复建议 / 状态。修复后标注「已解决」并保留条目。

## 使用方式

- 按批次顺序修：P0 安全 → P1 每天在用的数据丢失/假成功 → P2 Keil → P3 低危清理。
- 每批修完跑 `npm test`（离线必须全绿，3 个既有失败除外：skills-store.test.ts ×2、kb-review ×1）。
- AGENTS.md 铁律适用：R3 禁止假成功；修 shell 拦截器只能加严、不能放松红线名单。

---

## P0 · 安全：shell 拦截器绕过（3 条）

### T-001 · 默认 cwd 在工作区根，通配/`.` 删除全部放行

- **位置**: `src/tools/shell.ts:246-269`（`atRoot` 初始 false，仅 cd 段能置 true）。
- **现象**: 已实证：`rm -rf *`、`rm -rf ./*`、`rm -rf .`、`del /s /q .`、`cd /tmp && rm -rf *` 全部放行。spawn 以 workdir 根执行（`resolveCwd(ctx, input.cwd ?? ".")`，shell:true）。
- **影响**: danger-full-access 预设下拦截器是唯一防线，一条命令删掉整个工作区。默认 diagnose 预设靠审批兜住，不构成当前事故，但完全访问模式是被支持的使用方式。
- **修复建议**: 初始 `atRoot` 按 `resolveCwd` 结果等于 workdir 根来判定；或通配/`.` 分支不再依赖 atRoot，凡 recursive+force 目标是通配/`.` 一律拦截。
- **状态**: **已解决**（2026-10-25 P0 批次）。`evaluateDanger(command, atRoot=true, …)` 初始按 spawn 真实 cwd（workdir 根）判定。锁定测试 `tests/shell.test.ts`（`rm -rf *` / `rm -rf .` / `del /s /q .` 等 10 个新正例），225/225 绿。

### T-002 · 命令包装（`cmd /c`、`bash -c`、`powershell`、`env`、`nohup`）绕过红线名单

- **位置**: `src/tools/shell.ts:91-109`（commandOf 只剥 sudo/command）、`252`（分段只按 `[\n\r;|&()]+`）。
- **现象**: 已实证：`cmd /c del /s /q C:\`、`bash -c 'rm -rf /'`、`sh -c 'rm -rf /'`、`powershell Remove-Item -Recurse -Force C:\`、`env rm -rf /`、`nohup rm -rf /`、`` `rm -rf /` `` 全部放行。
- **影响**: spawn 用 `shell: true`（Windows = cmd.exe），包装命令原样执行内层，AGENTS.md 红线形同虚设。
- **修复建议**: commandOf 递归剥包装层（cmd/bash/sh/powershell/env/nohup/xargs 的 `-c`/`/c`/`-Command`），对内层命令串重新跑拦截器；反引号/`$()` 内容至少在含红线关键词时拦下。
- **状态**: **已解决**（2026-10-25 P0 批次）。`unwrapSegments` 递归剥 cmd/bash/sh/zsh/ksh/powershell/pwsh（含无 -Command 的裸 powershell）与 env/nohup/timeout/nice/xargs/setsid/stdbuf；反引号与 `$()` 内层变独立命令段重评；`--recursive=1` 长选项、`X=/; rm -rf $X` 变量间接、`Remove-Item` 均已覆盖。测试：`tests/shell.test.ts` 225/225 绿 + Temp 验证脚本 61 用例全过。

### T-003 · `cd .` / `cd ..` 重置 atRoot，绕过「cd 到根后通配删除」拦截

- **位置**: `src/tools/shell.ts:256-259`（每遇 cd 无条件覆写 atRoot）。
- **现象**: 已实证：`cd / && cd . && rm -rf *`、`cd / && pushd . && rm -rf *` 放行。顺带：`cd /c`（Windows 盘根）被当选项跳过（N1）。
- **影响**: 与 T-001 同级。
- **修复建议**: atRoot 一旦为 true 保持粘性（保守方向）；或用真实 cwd 追踪而非按 cd 段推断。
- **状态**: **已解决**（2026-10-25 P0 批次）。粘性语义：`cd .`/`cd ..` 不改变判定（防洗回）、`cd` 到根（含 `/c` 盘根形式）置位、`cd` 到真实子目录才解除。测试：`cd / && cd . && rm -rf *`、`cd / && pushd . && rm -rf *`、`cd /c && rm -rf *` 已进正例。

---

## P1 · 串口链路：数据丢失与假成功（7 条）

### T-010 · 切编码/改波特率/自动探测清空全部收发记录

- **位置**: `desktop/renderer/app.js:4686-4717`（setSerialState 对任何 `open:true` 清屏）+ `desktop/host/serial-bridge.js:505,518,637`（setEncoding/setBaud/auto-detect 也发 `serial_state open:true`）。
- **现象**: 已开 COM3 积累几百行 → 切编码下拉 → 历史全没、强制回底。更糟：auto-detect 是自动触发，「打开串口→来数据」流程本身就会先清一次。
- **影响**: 用户侧最痛的 bug，复盘日志直接丢证据。
- **修复建议**: serial_state 增加 `reason: "open"|"encoding"|"baud"|"detect"`（或 renderer 判断 detected/encoding 变化而非 open），只有真正新会话才清屏；编码切换只影响后续解码或触发 host 重放 ring。
- **状态**: **已解决**（2026-10-25 P1 批次）。桥侧 setEncoding/setBaud/auto-detect 现发 `mode: "reconfigured"`；renderer `setSerialState` 只在非 reconfigured 时清屏。测试：`tests/desktop/serial-bridge.test.js` T-010/T-010b，30/30 绿。

### T-011 · 切走再切回串口 tab，历史消失

- **位置**: `desktop/host/host.js:4190-4197`（serialStatus 快照发 `lines: []`）+ `desktop/renderer/app.js:2667-2681`（serial_snapshot 无条件覆盖 lines）。
- **现象**: 端口保持打开，切到 board 再切回 → 面板空了；host ring 里其实还有数据（open 路径带 ring，status 不带）。
- **修复建议**: serialStatus 快照带 `session.ring` 尾部（与 open 路径一致）；或 renderer 在 open 状态未变时不替换 lines。
- **状态**: **已解决**（2026-10-25 P1 批次）。host.js serialStatus 经 `ringTail(port, 500)` 回传全 ring 与 encoding；renderer 对 `mode:"reconfigured"` 快照保留 transcript。desktop 套件 284 通过。

### T-012 · 无换行尾部数据在 close/error 时永久丢失

- **位置**: `desktop/host/serial-bridge.js:556-563`（#teardown 只 flush pending）+ `112-124`（splitLines 的 rest 存 partial 但无消费点）。
- **现象**: 已用 FakePort 复现：发 `no-newline-tail` 后 close → 事件/ring/镜像三处皆无。
- **修复建议**: #teardown 里把 `session.partial` 非空时作为一行 flush（带「未终结」标记）。
- **状态**: **已解决**（2026-10-25 P1 批次）。#teardown 将 partial 作为 `tail:true` 行入 ring/pending 再 flush。测试：T-012（发 `no-newline-tail` 后 close，断言事件与 `tail:true` 标记）。

### T-013 · 关闭串口后 ring.json 镜像永不更新，agent 拿陈旧状态

- **位置**: `desktop/host/serial-bridge.js:670-689`（#writeMirror 仅被 #flushPending 调用，且 pending 为空早退）。
- **现象**: close 后镜像停留最后一帧，`embed_serial status/read` 把已关的口永远报成 open；应用退出后文件残留到下次开机（跨进程陈旧）。open 后无数据时镜像里根本没有该口。
- **修复建议**: close/clear/error 路径写一份 closed 状态镜像（条目加 `open:false` 字段）；host 启动时清掉上一轮残留镜像。
- **状态**: **已解决**（2026-10-25 P1 批次）。新增 `#writeClosedMirror(port)`：close/error/close 事件/mailbox close op 四条路径均把该端口从镜像移除；镜像条目新增 `open` 字段。mailbox close op 还能清除跨进程残留。测试：T-013/T-013b。

### T-014 · MCP 泵写失败报成功（R3 违规）

- **位置**: `mcp-servers/cubeide/serial.ts:318-331`（captureThenWrite 只处理 `ev==="line"`，error 事件被丢）+ `333`（exit 无条件 resolve）+ `tools.ts:712-718`（拿空 lines 照样报 wrote）。
- **现象**: 泵写抛错（拔线、非法 hex）→ agent 收到「已写入」的假成功。对照：captureSerialPort 是处理 error 的，captureThenWrite 漏了。
- **修复建议**: 处理 `ev==="error"`，置失败标志；exit 时若失败则以 isError 返回错误信息。
- **状态**: **已解决**（2026-10-25 P1 批次）。captureThenWrite 消费 `ev:"error"`，返回值带 `error`；tools.ts write 泵路径 error 非空时 `fail("write_failed")`。测试：`mcp-servers/cubeide/tests/write-pump-failure.test.ts` 3/3。

### T-015 · hex 奇数长度静默截断最后一字节

- **位置**: `mcp-servers/cubeide/serial.ts:390`（`[int]($config.data.Length / 2)` 舍入）+ schema（actions.ts:129-153）不校验。
- **现象**: `"0D0A0"` → 只发 `0D 0A`。与 host 端行为不一致（serial-bridge.js:454 明确拒绝奇数）。
- **修复建议**: schema 加 `regex(/^[0-9a-fA-F]*$/)` + 偶长校验；泵分支也加 `$config.data.Length % 2 -ne 0` 报错。双保险。
- **状态**: **已解决**（2026-10-25 P1 批次）。schema superRefine（hex:true 时奇长/非 hex 拒绝）+ WRITE_PUMP_SCRIPT 奇长分支显式报错退出 1。测试：embed-serial.test.ts T-015，27/27 绿。

### T-016 · spawn 子进程 error 事件无监听，可崩掉整个 MCP server

- **位置**: `mcp-servers/cubeide/serial.ts:180,229,308` 三个 spawn 点均无 `child.on("error")`；`334` stdin.write 同面。
- **现象**: PowerShell 被 AV/策略拦截（本项目历史真实发生过 Kaspersky 干预）→ ENOENT 异步 error 事件无监听 → uncaughtException → cubeide MCP server 整个挂，所有工具不可用。
- **修复建议**: 三处补 `child.on("error", ...)`（resolve 失败结果而非崩溃）；stdin.write 包 `?.on("error", noop)`。
- **状态**: **已解决**（2026-10-25 P1 批次）。captureSerialPort 与 captureThenWrite 均补 `child.on("error")`（resolve 而非崩溃，exit 用 settledByEvent 防双 resolve）与 `stdin.on("error")`。测试：write-pump-failure.test.ts「spawn 异步 error 事件进入返回值而非崩溃」。

---

## P2 · Keil（3 条）

### T-020 · flash 后 verify 会话复用未进调试模式的会话，校验失效

- **位置**: `mcp-servers/keil/tools.ts:1048-1065`（fail 只在 `compared.expected && compared.got` 时触发）+ `keilSession.ts:249-266`（复用只查 closed，不查/不恢复 debugging）+ `closeDebugSessions:139`（只关 debugging 会话，非调试残留不清理）。
- **现象**: 4823 残留非调试会话 → 复用 → readMemory 失败 → verifyFlash 返回无 expected/got 的失败 → flash 仍报成功。芯片不一致时最后一道防线失效。
- **修复建议**: openKeilSession 复用分支检查 `existing.debugging`，不符则 enterDebug 或弃用重开；tools.ts:1053 对 verifyFlash 的任何失败都视为校验未完成（fail-closed），而不是只认 expected/got。
- **状态**: 待修。

### T-021 · fitUtf8 用 UTF-8 模式截断 GBK，常用汉字被劈成半截

- **位置**: `mcp-servers/keil/uvsock.ts:320-328`（`(b & 0xc0) === 0x80` 是 UTF-8 continuation 判据，GBK trail 范围 0x40–0xFE）。
- **现象**: 已用仓库 gbk.ts 复现：trail ≥ 0xC0 的字（中/文/测/组…）cut 不回退 → 孤立 lead byte；trail 在 0x80–0xBF 的字则整字被吞。影响 sstr 定长字段写中文组名/路径。
- **修复建议**: 按正在写入的实际编码（GBK lead/trail 表）回退 cut；函数名与注释一并改（fitUtf8 名不副实）。
- **状态**: 待修。

### T-022 · closeKeilSession 固定 sleep 后强杀，可能损坏 .uvprojx

- **位置**: `mcp-servers/keil/keilSession.ts:99-113`（exit 后 sleep 800/2500ms → taskkill /T /F）。
- **现象**: uVision 收到 GEN_EXIT 后写大工程慢于 sleep → 强杀 → 编辑丢失或工程文件半写。
- **修复建议**: kill 前轮询工程文件 mtime 稳定（如 1s 内无变化才 kill），sleep 作为上限兜底。
- **状态**: 待修。

---

## P3 · UI 与其它（6 条）

### T-030 · pack 安装进行中按钮不禁用，二次点击中止第一次下载

- **位置**: `desktop/renderer/settings.js:499-505`（sButton 无 disabled）+ `desktop/host/host.js:4430-4435`（守卫检查后即 `packAbort?.abort()`）。
- **现象**: 1GB pack 下载中点另一个 Install → 第一个被 abort，用户视角「点了第二个，第一个坏了」。
- **修复建议**: packProgress 活跃时禁用全部 pack 按钮；host 侧 abort 只针对同一 pack。
- **状态**: 待修。

### T-031 · HEX 视图显示「解码文本的 UTF-8 再编码」，GBK 流字节错误

- **位置**: `desktop/renderer/app.js:4626,4852-4853`（hexView 用 TextEncoder 恒 UTF-8）+ `serial-bridge.js:573`（ring 只存解码后 text）。
- **现象**: GBK 发「你好」（C4 E3 BA C3）→ HEX 显示 E4 BD A0...（UTF-8 字节），与逻辑分析仪抓的不一致。
- **修复建议**: ring 条目带原始字节（base64 或 latin1 字符串），HEX 模式直接渲染原始字节。
- **状态**: 待修。

### T-032 · 中文界面下 "Port"/"Send" 残留英文

- **位置**: `desktop/renderer/index.html:474,546`（`data-i18n="serialPort"/"serialSend"`）——两份字典均无这两个 key。
- **修复建议**: i18n.js 补 key，或改用已有的等价 key。
- **状态**: 待修。

### T-033 · host serial 操作一律取 openPorts[0]，agent 开第二口后错位

- **位置**: `desktop/host/host.js:4191,4200,4210`（serialStatus/serialClear/serialWrite）。
- **现象**: agent 经 mailbox open 第二个口后，面板 status/clear/write 打到非用户所选的口。当前 UI 单口时无害。
- **修复建议**: 面板消息带目标 port 字段，host 不再默认取 [0]。
- **状态**: 待修（agent 多口使用成为现实时升级为 P1）。

### T-034 · agent 写失败仍播放动画并留假 TX 记录

- **位置**: `desktop/host/serial-bridge.js:251-259`（先发 serial_agent_write 再写）+ `app.js:2703-2717` + 非法 hex 渲染成 "NAN"（hexViewOfHex parseInt NaN）。
- **现象**: agent 传非法 hex → 面板播放「助手打字」动画、落一条 NaN 的 TX，随后 MCP 才报失败。
- **修复建议**: 先写后发事件（写失败不发）；hexViewOfHex 对非法 hex 显示原文+错误色；schema 补 hex 格式校验（与 T-015 同一改动）。
- **状态**: 待修。

### T-035 · dropped 计数反复累加，越跑越大

- **位置**: `desktop/renderer/app.js:2688`（`+= message.dropped`）vs `serial-bridge.js:656`（host 发的是累计值）。
- **修复建议**: renderer 改为直接赋值（与 serial_snapshot 路径一致）。
- **状态**: 待修。

---

## P4 · 目标板面板（用户已定性「太烂」，去留待拍板）

### T-040 · 目标板 tab：协议断裂 + 探测 bug，建议删独立 tab 并入他处

- **事实**（调研确认）:
  - 渲染层按「有扫描器」设计，host `board_state` 只发 7 个字段（host.js:4299-4310），不含 probes/tools/identity → 「目标」永远显示未连接探针、「本机」永远 0 探针。
  - 探测代码调 keil_debug 不存在的 `status` action（board-probe.js:28，action 枚举里没有）→ 「keil · keil_debug 失败 mcp_tool_error」任何机器必现，与硬件无关。
  - 串口小节与串口 tab 纯冗余；两个「串口」标题是同一 i18n key 用了两处（app.js:4167/4176）。
- **建议方案**（工作量小）: 删独立 tab；串口小节删掉、5 行尾巴并入串口 tab 顶部；端口选择并入串口 tab 下拉；工具链信息并入设置页（getToolchains 现成）；保留 setBoardSelection 数据路径（串口 tab 选端口时写入）。
- **备选**: 若坚持保留入口，必须先补 host board_state 形状（probes/identity/tools），工作量大且产出仍不如串口 tab。
- **附带小修**: board-probe.js:28 `keil_debug:status` → `keil_debug:capabilities`（若保留探测）。
- **状态**: 待用户拍板（删 / 重做）。

---

## 复核驳回项（存档，防止后人再报）

- ~~UVSOCK pending token 并发覆盖~~（uvsock.ts:899-917）：内核 McpClientManager 对每个 server 串行排队（src/mcp/manager.ts:275-282），当前接线下不可达。仅当未来出现第二个并发 MCP 客户端直连时需复查。
- ~~并发 flash 无互斥~~（tools.ts:1020-1026）：同上，per-server 串行队列已覆盖。
- ~~编码探测「全会话乱码」~~（serial-bridge.js:631）：复核发现多数切错位场景仍会正确选 UTF-8，实际误判窗口窄（ASCII 流+尾部残缺双字节对），降级低危。若 T-010 修 UI 清屏时可顺带把探测决策改为「gbkBad 显著小于 utf8Bad 才选 GBK」。
- ~~mailbox req/res 注入/串号~~：id 含 UUID，host 按 endsWith(".req.json") 处理，不存在。

## 既有测试失败（与本清单无关，但同属未清账）

- tests/skills-store.test.ts ×2（Windows symlink EPERM）
- mcp-servers/kb/tests/kb-review-script.test.ts ×1（断言失败）
