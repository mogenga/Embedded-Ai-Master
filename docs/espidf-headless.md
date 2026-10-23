# ESP-IDF（ESP32）无头调试使用指南

本文面向第一次使用 ESP-IDF 集成的人。能力来源是 ESP-IDF 自带的公开工具链（`idf.py` CMake 构建、`esptool` 烧录、`openocd-esp32` + esp-gdb 调试），**不下载、不捆绑、不重分发任何 Espressif 组件**。

范围决策（2026-10-23，用户定）：**只做 ESP32**（含 S2/S3/C2/C3/C5/C6/H2 等 IDF v6 支持的全系），**不做 ESP8266**（IDF v6 已放弃其构建支持）；Arduino 方向后续另做。

---

## 一、先确认本机有什么

| 需要 | 怎么确认 | 没有会怎样 |
|---|---|---|
| ESP-IDF（含 `tools/idf.py`） | 默认 `C:\Espressif\frameworks\esp-idf-*`；别处装的可设 `IDF_PATH` 指向安装根 | 所有动作返回「ESP-IDF is not found」 |
| IDF 工具集（`~\.espressif`） | 里面有 `python_env\`（含 esptool）与 `tools\`（openocd/gdb/工具链）；自定义安装位设 `IDF_TOOLS_PATH` | 同上；openocd/gdb 缺失时调试动作单独报「install looks incomplete」 |
| ESP32 板 + USB 线 | 烧录走串口（COMx），调试走 JTAG 或芯片内置 USB-JTAG | `probe`/`flash` 报 port 打不开 |

发现逻辑：`IDF_PATH` 环境变量 → `C:\Espressif\frameworks\esp-idf-*` glob → 其他候选。venv、esptool、openocd、gdb、工具链路径全部从 `IDF_TOOLS_PATH`（默认 `~\.espressif`）解析，不写死版本号。

设完 `IDF_PATH` / `IDF_TOOLS_PATH` 后**重启宿主**。

---

## 二、接线

`mcp.json` 加：

```json
{
  "mcpServers": {
    "espidf": {
      "command": "node",
      "args": ["G:/Develop/AImaster/Embedded-Ai-Master/dist-mcp/espidf/server.js"],
      "timeoutMs": 300000
    }
  }
}
```

构建：仓库根 `npm run build:mcp`。

工具三个（任选用法）：
- **`embed_project`（推荐）**：总入口，识别工程类型自动分发。IDF 工程的判据是 CMakeLists.txt 里 include 了 `$ENV{IDF_PATH}/tools/cmake/project.cmake`。
- `esp_build` / `esp_debug`：直接调后端。

---

## 三、esp_build 动作面

```jsonc
{ "action": "info", "project": "C:/work/blink" }      // 工程概要（target、ELF）
{ "action": "probe", "port": "COM3" }                  // esptool chip-id，探测芯片
{ "action": "build", "project": "C:/work/blink" }      // idf.py build（增量）
{ "action": "rebuild", "project": "…", "target": "esp32c3" }  // 换目标或重建
{ "action": "clean", "project": "…" }                  // idf.py fullclean
{ "action": "flash", "project": "…", "port": "COM3" }  // 烧全组镜像+校验
{ "action": "erase", "project": "…", "port": "COM3" }  // **整片擦除**（erase-flash）
```

要点：

1. **`project` 是工程目录**（CMakeLists.txt 所在层）。
2. `flash` 读 `build/flasher_args.json`（IDF 构建时写的偏移表：bootloader@0x0、分区表@0x8000、app@0x20000 等），照单拼 `esptool write-flash`，**不自己算偏移**，末尾 `--verify` 回读校验。
3. `flash` / `erase` 会先关打开的调试会话（串口/JTAG 独占）。
4. `probe` 需要显式 `port`；串口被占用会报 port busy——那也是"板子存在"的证据。

---

## 四、esp_debug 动作面

```jsonc
{ "action": "open", "project": "C:/work/blink" }
{ "action": "breakpoint_add", "location": "app_main" }
{ "action": "run" } / { "action": "halt" }
{ "action": "registers" } / { "action": "evaluate", "expression": "counter" }
{ "action": "read", "address": 106115527680, "width": "u32", "count": 4 }
{ "action": "stack" } / { "action": "disassemble" }
{ "action": "close" }
```

要点：

1. **调试需要 JTAG**：芯片内置 USB-JTAG（S3/C3 等用一根 USB 线即可，board cfg 是 `board/esp32s3-builtin.cfg` 这种）或外接 JTAG 适配器。**普通串口板只能烧录，不能调试**——这是芯片能力，不是工具限制。
2. board 配置**不猜**：IDF 构建时把 `debug_arguments_openocd`（如 `-f board/esp32s3-builtin.cfg`）写进 `build/project_description.json`，`open` 直接读它。工程没构建过会诚实报「先 build」（或显式传 `board_cfg`）。
3. 链路：`openocd -s <scripts> -f <board>` 起 gdbserver :3333 → esp-gdb（`--interpreter=mi2`）`target remote :3333`。GDB/MI 协议层与 cubeide 后端共用。
4. 端口 3333 被占（外部 openocd 已在跑）时自动复用，不再起第二份。
5. 断点/写内存/step 等动作有写前声明；读数带 evidence 标记。写内存后回读校验。

---

## 五、环境拼装（实现细节，排障用）

`idf.py` 不是独立可执行文件，服务每次 spawn 都带上实测的最小变量集：

- `IDF_PATH`、`IDF_PYTHON_ENV_PATH`、`ESP_IDF_VERSION`（idf_component_manager 读它做版本比较，缺席会 TypeError）
- PATH 前置：xtensa/riscv 工具链 bin、cmake、ninja、venv Scripts
- **清掉 `MSYSTEM`**（git-bash 派生环境会让 idf.py 走不支持的分支）

实测：真实 ESP32S3 工程（LVGL）首次构建 122s、增量 1.9s，均 exit 0。

---

## 六、故障排查

| 现象 | 先查什么 | 通常原因 |
|---|---|---|
| 「ESP-IDF is not found」 | `IDF_PATH` 与 `~\.espressif` 是否在 | 装在别处没设 `IDF_PATH`；设完没重启宿主 |
| 「install looks incomplete」 | `~\.espressif\tools\` 里有没有 openocd-esp32 / xtensa-esp-elf-gdb | IDF 安装时没勾调试组件 |
| idf.py 报 `ESP_IDF_VERSION` TypeError | 是否用了非标准入口 | 本服务会自动设；手动跑要照第五节拼 |
| open 起不来（port 3333 timeout） | openocd 日志尾部会带上 | 板子没进 USB-JTAG 模式；`flash` 先行占用串口；换 `board_cfg` |
| flash FAILED | 错误信息带 esptool 日志尾部 | 串口错、boot 模式没进（按住 BOOT 复位）、线缆差 |
| build 报 toolchain not found | `~\.espressif\tools\xtensa-esp-elf\` | 工具集没装全（重跑 IDF 安装器的 Tools 步骤） |

---

## 七、已知限制

1. ESP8266 不支持（范围决策）：esptool 本身兼容，但 IDF v6 不再为其构建；要烧 ESP8266 得装老 IDF 或等 Arduino 后端。
2. 串口监控（idf.py monitor 的输出流）未接入——probe MCP 已有串口能力，可先用那个。
3. menuconfig / sdkconfig 编辑未做；`rebuild` 换 target 走 `-DIDF_TARGET`。
4. 烧录后不会自动 `open` 调试会话（keil 侧同样语义）。

条目登记在 `docs/deferred-issues.md`（D-204 起）。
