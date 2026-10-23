# Arduino 无头构建使用指南

本文面向第一次使用 Arduino 集成的人。能力来源是你本机已安装的 Arduino CLI（Arduino IDE 自带，或独立安装的 `arduino-cli`），**不下载、不捆绑、不重分发任何 Arduino 组件**。

范围决策（2026-10-23，用户定）：Arduino 路线 = **编译 + 烧录 + 板卡/库查询**。没有调试动作——AVR 板（Uno/Mega/Nano）没有调试硬件，`arduino-cli debug check` 明确报不支持，工具不做假调试面。装了 SAMD/ESP32 核心后若需要调试，那是另一条 gdb 链路，按需评估。

---

## 一、先确认本机有什么

| 需要 | 怎么确认 | 没有会怎样 |
|---|---|---|
| arduino-cli | Arduino IDE 装了它就在 `<IDE>\resources\app\lib\backend\resources\`；独立安装的在 PATH；都可设 `ARDUINO_CLI` 指定 | 所有动作返回「arduino-cli is not found」 |
| 板卡核心 | `boards` 动作现查（本机实测 arduino:avr 1.8.7） | `boards` 列空表并提示 `arduino-cli core install <id>` |
| Arduino 板 + USB 线 | 烧录走串口（COMx） | `upload` 报端口打不开（错误原文带出） |

发现顺序：`ARDUINO_CLI` 环境变量 → Arduino IDE 自带位置（Program Files / LocalAppData）→ PATH。

---

## 二、接线

`mcp.json` 加：

```json
{
  "mcpServers": {
    "arduino": {
      "command": "node",
      "args": ["G:/Develop/AImaster/Embedded-Ai-Master/dist-mcp/arduino/server.js"],
      "timeoutMs": 300000
    }
  }
}
```

构建：仓库根 `npm run build:mcp`。

**推荐用法是 `embed_project` 总入口**：sketch 的判据是「目录里有与目录同名的 .ino」（Arduino 的硬规则，`Blink/Blink.ino` 才是 sketch）。路由会自动识别并分发。

---

## 三、arduino_build 动作面

```jsonc
{ "action": "info", "project": "C:/work/Blink" }              // sketch 概要
{ "action": "boards" }                                        // 已装核心列表
{ "action": "search_board", "query": "uno" }                  // 找 FQBN
{ "action": "libs", "query": "neo" }                          // 已装库（子串过滤）
{ "action": "compile", "project": "C:/work/Blink", "fqbn": "arduino:avr:uno" }
{ "action": "upload", "project": "C:/work/Blink", "fqbn": "arduino:avr:uno", "port": "COM3" }
```

要点：

1. **FQBN 必传**（compile/upload）：形如 `arduino:avr:uno`，用 `search_board` 找。核心决定可选值——esp32 核心没装就编译不了 ESP32 板（`arduino-cli core install esp32:esp32` 装完立刻可用）。
2. `compile` 产物在 `<sketch>\build\<fqbn 中的冒号换成点>\`（.elf/.hex/.bin）。
3. `upload` **拒绝隐式编译**：build 目录里没有对应产物就直接报「先 compile」——保证烧上去的永远是刚编译的那份，不可能是旧产物。
4. `upload` 默认 `--verify`（烧后校验）；串口占用/未接板的错误原文会带出来。
5. 串口监控不在这里——用 probe 后端的串口工具。

---

## 四、实测记录（本机）

- arduino-cli 1.4.1（Arduino IDE 自带），arduino:avr 1.8.7
- Blink sketch 编译 `arduino:avr:uno`：924 bytes（2%），产物 .elf/.hex/.with_bootloader.hex
- `debug check -b arduino:avr:uno`（不带/带 programmer）均报不支持
- `lib list` 的过滤词是精确名匹配（"Adafruit Neo" 匹配不到 "Adafruit NeoPixel"），工具改为全量拉回本地子串过滤

---

## 五、故障排查

| 现象 | 先查什么 | 通常原因 |
|---|---|---|
| 「arduino-cli is not found」 | 装了 Arduino IDE 没有 / `ARDUINO_CLI` | 没装；装在非标准位置没设环境变量 |
| 「no cores installed」 | `arduino-cli core list` | 装了 IDE 但没装任何板卡核心 |
| compile 报 Unknown FQBN | `search_board` | 板卡名拼错或核心未装 |
| upload 报 not_compiled | 是否先 compile 过同一 fqbn | upload 不隐式编译（设计如此） |
| upload 报 cannot open port | 端口号、串口占用 | 板子没插、串口被别的工具占着 |
| sketch 识别失败 | 目录名与 .ino 名是否一致 | `Blink/other.ino` 不是合法 sketch |

---

## 六、已知限制

1. 无调试（AVR 硬件限制；SAMD/ESP32 的 gdb 链路未接，需要时另行评估）。
2. 不支持 PlatformIO 工程（`platformio.ini` 只是识别线索，本机 PIO 未完整安装，路线未做）。
3. `lib install` / `core install` 未接入（装库装核心走 arduino-cli 本体；破坏性安装动作不急着 agent 化）。
4. ESP8266 经 PlatformIO/老核心的理论支持不在本路线内。

条目登记在 `docs/deferred-issues.md`。
