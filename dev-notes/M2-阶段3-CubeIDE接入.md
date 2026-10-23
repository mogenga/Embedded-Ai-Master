# M2 阶段 3 — CubeIDE 接入与工程路由门面

## 2026-10-23

- 用户原话：「开始调研cubeide如何像keil一样接入」→「我想做的就是 遇到什么工程调用哪个mcp 懂我意思了吧」→「选A吧 开始」。
- 关键产出：`docs/cubeide-porting-spec.md`（路由表、模块划分、安全模型）；`mcp-servers/cubeide/` 12 个文件；`embed_project` 门面（`route.ts` + `route-cubeide.ts`）挂进 keil/cubeide 两个 server；`docs/cubeide-headless.md`。
- 实测驱动的设计点：
  - CubeIDE 在 G:\software（非默认路径）→ 发现逻辑 = `CUBEIDE_HOME` 环境变量 → 默认路径 glob；注册表路线写了但 Uninstall 键名不确定，环境变量是主通道。
  - `newestPlugin` 第一版字符串排序会选中 `.jar` 而不是 `.win32_*` 目录（jar 排在后面），实测发现后改为 `withFileTypes` 只取目录。
  - GDB/MI 的 result-class 边界实测是空格**或逗号**（`*stopped,reason=...` 合法），第一版只按空格切导致解析为空。
  - 本机无 ST-Link 接入：烧录/调试的真机验证没做，`probe` 动作实测输出与 STM32_Programmer_CLI 直跑一致（No ST-Link detected）。
- 被拒绝/纠偏：无（方案 A 之前给过 A/B 两个选项，用户选 A）。
- 翻车与返工：一次端到端冒烟误把 keil `info` 转发跑了（会拉起 uVision），300s 超时进后台后 taskkill 停掉——真机动作不该在冒烟里顺手跑，identify-only 验证就够了。
- 测试：20 个离线单测全过；`npm test` 3 处失败（skills-store ×2、kb-review ×1）在干净树上同样失败，与本轮无关。`npm run build:mcp` 通过，dist-mcp/cubeide/ 产出验证。

## 2026-10-23（续）— ESP-IDF 后端

- 用户原话：「我想的是嵌入式有一个总的路由入口 然后分不同系列 这样是可以的吗 我们现在是不是就是这样」「我们现在只做ESP32吧 不做ESP8266了 后续做arduino」；中途问 push（答：未推，随后推送 debug 分支 4 提交）。
- 关键产出：`mcp-servers/espidf/` 8 文件；路由表加 espidf；`docs/espidf-headless.md`；D-204/D-205。
- 实测驱动：idf.py 需要的最小 env 三件套是踩错跑出来的（缺 ESP_IDF_VERSION 直接 TypeError；MSYSTEM 从 git-bash 派生会让它走警告分支）；烧录参数不自己算，flasher_args.json 是 IDF 自己写的事实源；board cfg 同理来自 project_description.json。
- 真实构建验证：ESP32S3 LVGL 工程首建 122s、增量 1.9s，exit 0。无板接入，flash/debug 未真机验证（probe 实测 COM3 不存在，报错路径符合预期）。

## 2026-10-23（续2）— Arduino 后端

- 用户原话：「开始做arduino路线」。
- 范围定案：编译+烧录+板卡/库查询，无调试（AVR 无调试硬件，debug check 实测报不支持；不做假面）。
- 实测驱动：arduino-cli 由 IDE 自带（Program Files 深路径）；三处 CLI JSON 形状与假设不符（core list 是 {platforms:[{releases:{...}}]} 嵌套、board fqbn 小写、lib 是 installed_libraries 包装）；lib list 过滤词精确匹配 → 本地子串过滤。upload 用 --input-dir 拒绝隐式编译，产物永不过期。
- 真机冒烟：Blink 编译 924 bytes 与 CLI 直跑一致；无板 upload 报错原文带出。
- 翻车与返工：测试里 resolveSketchShape 少传了对象包装（root vs {project: root}），报错文案断言也改了一次。
- 测试：9 个离线单测全过；MCP 全量 410 过 + kb-review 存量失败（与本轮无关）。

## 2026-10-23（续3）— 三件套真机全链路（阿波罗 F429IGT6）

- 用户原话：「插上设备了 全量测试cubeide链路」→「我用的是核心板 没用底板」→「核心板有一个串口 我就是接的这个串口」→「HSI是25mhz啊」→「高速晶振是25Mhz」→「我把cubemx也装好了 全套应该都在了 先把cubemx接进去」→「先全网搜索学习一下 别埋头苦干不出活」→「cube这个系列工具应该封装在一起 要求用户必须三者全部安装 一个用来生成工程 一个写工程 一个烧录工程 各司其职」→「我睡觉了 你慢慢测 记得要代入我们真实的harness层也测试」。
- 真机修复（全部实测驱动）：
  - `-c SWD` → `-c port=SWD`（CLI v2.23 真机语法）。
  - `-import` 要 `file:///` URI（EFS "No file system is defined for scheme: C"）。
  - 构建失败保留 workspace（stdout 只有 "See the log file"，.metadata/.log 是唯一诊断）。
  - `.cproject` MCU 提取正则：GUI 建的工程是 `value="STM32F429IGTx"`，CubeMX 生成的是 `target_mcu.value.stm32...`——最初按后者写，用户工程匹配不到，回退靠手工正则试错三次（教训：先看真实文件再写正则）。
- CubeMX 无头生成：UM1718 Table 1 命令（本地 PDF 提取，没用错网传语法）；`STM32CubeMX.exe -q` 退出码不可靠（timeout 124 但工程生成完了）→ `jre/bin/java -jar STM32CubeMX.exe -q` 稳定。CUBEMX_HOME 发现。
- S7 固件与 gdbserver：全网学习确认 ST 对 S7（V2J4xS7）固件做克隆检测，只拒自家 gdbserver；CubeProgrammer CLI 和 OpenOCD 都能连。实现 OpenOCD 回退（espidf 的 openocd-esp32 + stm32f4x.cfg），真机 open/halt/寄存器/读写内存全通。
- 真实 harness 层 E2E：mcp.json 加 cubeide server（env 传 CUBEIDE_HOME/CUBEMX_HOME）→ loadMcpConfig → McpManager.connectAll → call。五项过：version/probe/generate(33.8s)/build(10.6s)/flash(verified)。与 desktop 宿主同一代码路径。
- 翻车与返工：手工拼 .cproject 被 CDT 拒（fBuildData null，结构太深放弃，用户 GUI 建工程）；调试会话中途目标进入 "Unable to get core ID"（CLI 也连不上，AP 1→0），等物理复位才能继续——原因未定（可能 halt 后 detach 时序，登记 deferred）。
- 测试：cubeide 20 + espidf 12 全过；typecheck 干净；E2E 脚本 .smoke/harness-e2e-cube.mjs。

## 2026-10-23（终）— SWD 反复锁死根因修复 + 双链路终验

- 用户原话：「重新插拔了」（×4）→「你全网研究一下 我不想cube链路还混着openocd」→「哎呦 无所谓了 用ocd就用吧 确保keil链路和cube链路都能用就行了」。
- SWD 锁死根因链（最终定性）：**close 时断点未删（-break-delete 裸命令被 MI 静默拒绝）→ continue 秒命中同断点 → detach 后 FPB 硬件断点残留在目标 → 程序命中断点地址 → 目标锁死**。修复：close 先 -break-list 取编号逐个删，再 continue 再 gdb-exit。
- server 选型终态：pyOCD 优先（S7 克隆唯一稳定，自带驱动无 ST 检查）→ ST gdbserver（官方探针）→ OpenOCD 兜底。pyOCD 的 all-stop 忽略 Ctrl-C，halt 改 monitor-halt 优先 + already-stopped 短路 + interrupt 兜底。
- 五轮 open→halt→eval→close 全绿（5/5），板子存活；随后 cube 全链 generate→build(14.5s)→flash(verified) 一遍过；keil 路由识别正常。
- 遗留观察：pyocd 进程 close 后仍退出但目标不死——kill 进程非死因，断点卫生流程才是。ESP8266、串口监控（D-204）、sdkconfig（D-205）不变。
