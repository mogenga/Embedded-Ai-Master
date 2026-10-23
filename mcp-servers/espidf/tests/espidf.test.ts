import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIdfProject, readProjectDescription, appElf } from "../idfBuild.js";
import { readFlasherArgs } from "../idfFlash.js";
import { idfEnv } from "../idfEnv.js";
import { declarationFor } from "../declarations.js";
import { ESP_DESTRUCTIVE_ACTIONS, ESP_EVIDENCE_ACTIONS } from "../actions.js";
import { routeProject } from "../../cubeide/route.js";

/**
 * espidf 后端的离线单元测试。fixture 全部是临时目录与样例 JSON；
 * 不触串口、不 spawn idf.py / openocd。
 */

const CMAKE_IDF = `cmake_minimum_required(VERSION 3.16)\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(blink)\n`;
const CMAKE_PLAIN = `cmake_minimum_required(VERSION 3.16)\nproject(plain)\nadd_executable(app main.c)\n`;

describe("idfBuild detection", () => {
  it("recognises an IDF project by the project.cmake include", () => {
    const dir = mkdtempSync(join(tmpdir(), "espidf-test-"));
    try {
      writeFileSync(join(dir, "CMakeLists.txt"), CMAKE_IDF);
      expect(isIdfProject(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a plain CMake project", () => {
    const dir = mkdtempSync(join(tmpdir(), "espidf-test-"));
    try {
      writeFileSync(join(dir, "CMakeLists.txt"), CMAKE_PLAIN);
      expect(isIdfProject(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads target / openocd args / elf from project_description.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "espidf-test-"));
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      writeFileSync(
        join(dir, "build", "project_description.json"),
        JSON.stringify({ target: "esp32s3", debug_arguments_openocd: "-f board/esp32s3-builtin.cfg", app_elf: "blink.elf" }),
      );
      writeFileSync(join(dir, "build", "blink.elf"), "stub");
      const desc = readProjectDescription(dir);
      expect(desc).toMatchObject({ target: "esp32s3", openocdArgs: "-f board/esp32s3-builtin.cfg" });
      expect(appElf(dir)).toContain("blink.elf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null fields for an unbuilt project", () => {
    const dir = mkdtempSync(join(tmpdir(), "espidf-test-"));
    try {
      writeFileSync(join(dir, "CMakeLists.txt"), CMAKE_IDF);
      expect(readProjectDescription(dir)).toBeNull();
      expect(appElf(dir)).toBeNull();
      expect(readFlasherArgs(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses flasher_args.json offsets in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "espidf-test-"));
    try {
      mkdirSync(join(dir, "build"), { recursive: true });
      writeFileSync(
        join(dir, "build", "flasher_args.json"),
        JSON.stringify({
          flash_files: { "0x0": "bootloader/bootloader.bin", "0x8000": "partition_table/partition-table.bin", "0x20000": "blink.bin" },
          write_flash_args: ["--flash-mode", "dio", "--flash-size", "4MB"],
        }),
      );
      const parsed = readFlasherArgs(dir)!;
      expect(parsed.flashFiles).toHaveLength(3);
      expect(parsed.flashFiles[0]).toEqual({ offset: "0x0", file: "bootloader/bootloader.bin" });
      expect(parsed.flashSettings).toContain("dio");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("idfEnv", () => {
  it("sets the minimal variable set and clears MSYSTEM", () => {
    const tools = {
      idfPath: "C:/Espressif/frameworks/esp-idf-v6.0.2",
      idfVersion: "6.0.2",
      pythonEnv: "C:/Users/Admin/.espressif/python_env/idf6.0_py3.12_env",
      venvPython: "C:/Users/Admin/.espressif/python_env/idf6.0_py3.12_env/Scripts/python.exe",
      esptool: "C:/Users/Admin/.espressif/python_env/idf6.0_py3.12_env/Scripts/esptool.exe",
      openocd: "C:/Users/Admin/.espressif/tools/openocd-esp32/v0.12.0/openocd-esp32/bin/openocd.exe",
      openocdScripts: "C:/Users/Admin/.espressif/tools/openocd-esp32/v0.12.0/openocd-esp32/share/openocd/scripts",
      gdb: "C:/Users/Admin/.espressif/tools/xtensa-esp-elf-gdb/17.1/xtensa-esp-elf-gdb/bin/xtensa-esp-elf-gdb.exe",
      pathPrepend: ["C:/tools/bin"],
    };
    const env = idfEnv(tools, { MSYSTEM: "MINGW64", PATH: "C:/Windows" });
    expect(env.IDF_PATH).toBe(tools.idfPath);
    expect(env.IDF_PYTHON_ENV_PATH).toBe(tools.pythonEnv);
    expect(env.ESP_IDF_VERSION).toBe("6.0.2");
    expect(env.MSYSTEM).toBeUndefined();
    expect(env.PATH?.startsWith("C:/tools/bin;")).toBe(true);
    // 不改 process.env
    expect(process.env.MSYSTEM).toBeDefined();
  });
});

describe("declarations", () => {
  it("declares every destructive action", () => {
    for (const action of ESP_DESTRUCTIVE_ACTIONS) {
      const tool = ["build", "rebuild", "clean"].includes(action) ? "esp_build" : "esp_debug";
      const declaration = declarationFor(tool, action, { address: 0x3ff00000, width: "u32", count: 4 });
      expect(declaration, `no declaration for ${action}`).toBeDefined();
      expect(declaration!.effect.length).toBeGreaterThan(0);
    }
  });

  it("erase declares full-chip honestly", () => {
    const declaration = declarationFor("esp_build", "erase", {});
    expect(declaration!.operation).toBe("chip_erase");
    expect(declaration!.effect).toContain("整片");
  });

  it("evidence and destructive lists do not overlap (flash excepted)", () => {
    for (const action of ESP_EVIDENCE_ACTIONS) {
      if (action === "flash") continue;
      expect(ESP_DESTRUCTIVE_ACTIONS.has(action), `${action} in both lists`).toBe(false);
    }
  });
});

describe("routeProject with espidf", () => {
  it("routes an IDF project directory to espidf", () => {
    const dir = mkdtempSync(join(tmpdir(), "espidf-test-"));
    try {
      writeFileSync(join(dir, "CMakeLists.txt"), CMAKE_IDF);
      writeFileSync(join(dir, "sdkconfig"), "# sdkconfig stub");
      expect(routeProject(dir).kind).toBe("espidf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mistake a plain CMake project for IDF", () => {
    const dir = mkdtempSync(join(tmpdir(), "espidf-test-"));
    try {
      writeFileSync(join(dir, "CMakeLists.txt"), CMAKE_PLAIN);
      const route = routeProject(dir);
      expect(route.kind).toBe("none");
      expect(route.hints).toContain("CMakeLists.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports mixed when keil and IDF projects share a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "espidf-test-"));
    try {
      writeFileSync(join(dir, "CMakeLists.txt"), CMAKE_IDF);
      writeFileSync(join(dir, "APP.uvprojx"), "<Project/>");
      expect(routeProject(dir).kind).toBe("mixed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
