/**
 * 工具链目录信息（从 A 侧 toolchain.ts 摘出的常量表）。
 *
 * Keil 闭包只需要这张表来做能力报告与"缺哪个工具"的提示；完整的 9 种工具链
 * 探测（SPECS/detectToolchains）不随迁移，见 keil-porting-spec.md §15。
 *
 * The three toolbox tools are first-class entries: the CMSIS-Toolbox ships
 * inside a Keil install (`ARM\cmsis-toolbox\bin`), and a report that omits them
 * claims a csolution project cannot be built on a machine that has MDK.
 */

export type ToolchainKind =
  | "cbuild"
  | "cpackget"
  | "svdconv"
  | "gcc-arm"
  | "gcc-riscv"
  | "cmake"
  | "ninja"
  | "make"
  | "west"
  | "idf"
  | "pio"
  | "arduino-cli"
  | "cargo"
  | "keil"
  | "iar"
  | "openocd"
  | "pyocd"
  | "probe-rs"
  | "jlink"
  | "esptool"
  | "st-flash"
  | "stm32-programmer"
  | "dfu-util"
  | "avrdude"
  | "qemu"
  | "renode"
  | "sigrok"
  | "cppcheck"
  | "clang-tidy";

export interface FoundTool {
  kind: ToolchainKind;
  /** Absolute path to the executable. */
  path: string;
  version: string;
  complete?: boolean;
}

export interface ToolchainReport {
  tools: FoundTool[];
  /** Kinds that were searched for and not found. */
  missing: ToolchainKind[];
  /** Extra install locations that were searched, for the settings UI. */
  searchPaths: string[];
}

export const TOOLCHAIN_INFO: Record<ToolchainKind, { label: string; purpose: string; group: "build" | "flash" | "monitor" | "analyze" }> = {
  "gcc-arm": { label: "Arm GNU Toolchain", purpose: "Compiles and links firmware for Cortex-M and Cortex-A parts", group: "build" },
  "gcc-riscv": { label: "RISC-V GCC", purpose: "Compiles firmware for RISC-V cores (ESP32-C, GD32V, CH32V)", group: "build" },
  cmake: { label: "CMake", purpose: "Configures projects that ship a CMakeLists.txt", group: "build" },
  ninja: { label: "Ninja", purpose: "Fast build backend that CMake and Zephyr prefer", group: "build" },
  make: { label: "Make", purpose: "Runs Makefile projects and the generated build files", group: "build" },
  west: { label: "west", purpose: "Zephyr's build and flash front end", group: "build" },
  idf: { label: "ESP-IDF", purpose: "Builds ESP32 projects and exposes idf.py", group: "build" },
  pio: { label: "PlatformIO", purpose: "Builds platformio.ini projects across boards and frameworks", group: "build" },
  "arduino-cli": { label: "Arduino CLI", purpose: "Compiles and uploads Arduino sketches", group: "build" },
  cargo: { label: "Cargo", purpose: "Builds Rust firmware and embedded Rust crates", group: "build" },
  cbuild: {
    label: "CMSIS-Toolbox (cbuild)",
    purpose: "Builds csolution/cprj projects; ships with Keil MDK and the standalone Arm CMSIS-Toolbox",
    group: "build",
  },
  cpackget: {
    label: "cpackget",
    purpose: "Installs and removes CMSIS-Packs; the same layout the device/SVD lookup reads",
    group: "build",
  },
  svdconv: {
    label: "SVDConv",
    purpose: "Validates and converts CMSIS-SVD files, including the vendor SVDs a pack ships",
    group: "analyze",
  },
  keil: {
    label: "Keil MDK",
    purpose: "Builds .uvprojx projects headless; its compilers and device packs are licensed and are never bundled",
    group: "build",
  },
  iar: {
    label: "IAR EWARM",
    purpose: "Builds .ewp projects headless; licensed, never bundled",
    group: "build",
  },
  openocd: { label: "OpenOCD", purpose: "Debugs and flashes through many probes, and serves GDB", group: "flash" },
  pyocd: { label: "pyOCD", purpose: "Flashes and debugs Arm Cortex-M targets, with a built-in target table", group: "flash" },
  "probe-rs": { label: "probe-rs", purpose: "Flashes and debugs Rust targets through CMSIS-DAP and J-Link", group: "flash" },
  jlink: { label: "J-Link", purpose: "SEGGER's flasher and debugger for J-Link probes", group: "flash" },
  esptool: { label: "esptool", purpose: "Flashes ESP32 and ESP8266 over the serial bootloader", group: "flash" },
  "st-flash": { label: "st-flash", purpose: "Writes STM32 flash through an ST-Link", group: "flash" },
  "stm32-programmer": {
    label: "STM32CubeProgrammer",
    purpose: "ST's own flasher: writes, reads back, and mass-erases STM32 flash through an ST-Link",
    group: "flash",
  },
  "dfu-util": { label: "dfu-util", purpose: "Flashes parts that expose a USB DFU bootloader", group: "flash" },
  avrdude: { label: "avrdude", purpose: "Flashes AVR parts over ISP, JTAG or the bootloader", group: "flash" },
  qemu: { label: "QEMU", purpose: "Runs firmware without hardware, for tests and CI", group: "flash" },
  renode: { label: "Renode", purpose: "Simulates whole boards and peripherals", group: "flash" },
  sigrok: { label: "sigrok", purpose: "Reads logic analysers and oscilloscopes", group: "monitor" },
  cppcheck: { label: "cppcheck", purpose: "Static analysis for the bugs a clean compile still ships", group: "analyze" },
  "clang-tidy": { label: "clang-tidy", purpose: "Deeper static analysis once a compile database exists", group: "analyze" },
};

/** The order a firmware session needs these in. */
export const TOOLCHAIN_GROUPS: { id: "build" | "flash" | "monitor" | "analyze"; kinds: ToolchainKind[] }[] = (() => {
  const order: ("build" | "flash" | "monitor" | "analyze")[] = ["build", "flash", "monitor", "analyze"];
  return order.map((id) => ({
    id,
    kinds: (Object.keys(TOOLCHAIN_INFO) as ToolchainKind[]).filter((kind) => TOOLCHAIN_INFO[kind].group === id),
  }));
})();