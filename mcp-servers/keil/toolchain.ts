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
  | "cmake"
  | "cpackget"
  | "cppcheck"
  | "gcc-arm"
  | "iar"
  | "jlink"
  | "keil"
  | "make"
  | "pyocd"
  | "stm32-programmer"
  | "svdconv";

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
  cmake: { label: "CMake", purpose: "Configures projects that ship a CMakeLists.txt", group: "build" },
  make: { label: "Make", purpose: "Runs Makefile projects and the generated build files", group: "build" },
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
  pyocd: { label: "pyOCD", purpose: "Flashes and debugs Arm Cortex-M targets, with a built-in target table", group: "flash" },
  jlink: { label: "J-Link", purpose: "SEGGER's flasher and debugger for J-Link probes", group: "flash" },
  "stm32-programmer": {
    label: "STM32CubeProgrammer",
    purpose: "ST's own flasher: writes, reads back, and mass-erases STM32 flash through an ST-Link",
    group: "flash",
  },
  cppcheck: { label: "cppcheck", purpose: "Static analysis for the bugs a clean compile still ships", group: "analyze" },
};

/** The order a firmware session needs these in. */
export const TOOLCHAIN_GROUPS: { id: "build" | "flash" | "monitor" | "analyze"; kinds: ToolchainKind[] }[] = (() => {
  const order: ("build" | "flash" | "monitor" | "analyze")[] = ["build", "flash", "monitor", "analyze"];
  return order.map((id) => ({
    id,
    kinds: (Object.keys(TOOLCHAIN_INFO) as ToolchainKind[]).filter((kind) => TOOLCHAIN_INFO[kind].group === id),
  }));
})();