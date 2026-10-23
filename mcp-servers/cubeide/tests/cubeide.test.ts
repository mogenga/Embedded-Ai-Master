import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEclipseProjects, readEclipseName } from "../eclipseProject.js";
import { routeProject } from "../route.js";
import { parseMiLine, parseCsv, unquote, miQuote, frameFields } from "../gdbMi.js";
import { declarationFor } from "../declarations.js";
import { CUBEIDE_DESTRUCTIVE_ACTIONS, CUBEIDE_EVIDENCE_ACTIONS } from "../actions.js";
import { resolveCubeIdeTools, newestPlugin } from "../cubeideInstall.js";

/**
 * CubeIDE 后端 + 路由门面的离线单元测试。
 * 全部用临时 fixture 目录与字符串样例，不触硬件、不 spawn gdb。
 */

function makeEclipseProject(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".project"), `<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription>\n<name>${name}</name>\n</projectDescription>\n`);
  writeFileSync(join(dir, ".cproject"), `<?xml version="1.0" encoding="UTF-8"?>\n<cproject>\n</cproject>\n`);
  return dir;
}

describe("eclipseProject", () => {
  it("finds a project at the root and reads its name", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      makeEclipseProject(root, "blink");
      const found = findEclipseProjects(root);
      expect(found).toHaveLength(1);
      expect(found[0]!.name).toBe("blink");
      expect(readEclipseName(join(root, ".project"))).toBe("blink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a project one level down but not inside build output dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      makeEclipseProject(join(root, "proj"), "real");
      makeEclipseProject(join(root, "proj", "Debug"), "fake-in-output");
      const found = findEclipseProjects(root);
      expect(found).toHaveLength(1);
      expect(found[0]!.name).toBe("real");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing for a directory without .cproject", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, ".project"), "<projectDescription><name>only</name></projectDescription>");
      expect(findEclipseProjects(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("routeProject", () => {
  const UVPROJ = `<?xml version="1.0"?><Project><TargetName>T</TargetName></Project>`;

  it("routes a keil-only directory to keil", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      writeFileSync(join(root, "APP.uvprojx"), UVPROJ);
      expect(routeProject(root)).toMatchObject({ kind: "keil" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes a cubeide-only directory to cubeide", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      makeEclipseProject(root, "blink");
      expect(routeProject(root)).toMatchObject({ kind: "cubeide" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports mixed when both kinds are present", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      writeFileSync(join(root, "APP.uvprojx"), UVPROJ);
      makeEclipseProject(join(root, "cubeide-proj"), "blink");
      const route = routeProject(root);
      expect(route.kind).toBe("mixed");
      expect(route.keilFile).toBeDefined();
      expect(route.eclipseProjects).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports none with build-system hints", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)");
      const route = routeProject(root);
      expect(route.kind).toBe("none");
      expect(route.hints).toContain("CMakeLists.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never treats a backup .uvprojx.orig as a project", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      copyFileSync(join(root, "nothing"), join(root, "APP.uvprojx.orig")).valueOf;
    } catch {
      /* copyFileSync needs a real source; write directly instead */
    }
    writeFileSync(join(root, "APP.uvprojx.orig"), UVPROJ);
    writeFileSync(join(root, "APP.uvprojx.bak"), UVPROJ);
    expect(routeProject(root).kind).toBe("none");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("gdbMi parsing", () => {
  it("parses result records with tokens", () => {
    const parsed = parseMiLine(`12^done,bkpt={number="1",addr="0x08000123"}~"load\\n"`);
    expect(parsed).not.toBeNull();
    if ("resultClass" in parsed && parsed && "token" in parsed) {
      expect(parsed.token).toBe(12);
      expect(parsed.resultClass).toBe("done");
      expect(parsed.values["bkpt"]).toContain('number="1"');
    } else {
      throw new Error("expected a result record");
    }
  });

  it("parses exec-async stopped", () => {
    const parsed = parseMiLine(`*stopped,reason="breakpoint-hit",frame={addr="0x08000123",func="main"}`);
    expect(parsed).not.toBeNull();
    if (parsed && "kind" in parsed) {
      expect(parsed.kind).toBe("exec");
      expect(parsed.resultClass).toBe("stopped");
      expect(parsed.values["reason"]).toBe('"breakpoint-hit"');
    } else {
      throw new Error("expected an async record");
    }
  });

  it("unquotes C-style MI strings", () => {
    expect(unquote('"a\\"b\\nc"')).toBe('a"b\nc');
    expect(unquote('"\\x41"')).toBe("A");
    expect(miQuote('say "hi"')).toBe('say \\"hi\\"');
  });

  it("parseCsv handles nested tuples and lists", () => {
    const parsed = parseCsv(`a="1",b={x="2"},c=["3","4"]`);
    expect(parsed["a"]).toBe('"1"');
    expect(parsed["b"]).toBe('{x="2"}');
    expect(parsed["c"]).toBe('["3","4"]');
  });

  it("frameFields flattens a frame tuple", () => {
    const fields = frameFields('{addr="0x08000123",func="main",file="../Src/main.c",line="42"}');
    expect(fields["addr"]).toBe("0x08000123");
    expect(fields["func"]).toBe("main");
    expect(fields["line"]).toBe("42");
  });
});

describe("declarations", () => {
  it("declares every destructive debug action", () => {
    for (const action of CUBEIDE_DESTRUCTIVE_ACTIONS) {
      const input = { address: 0x20000000, width: "u32", count: 2 };
      // build/rebuild/clean 是 cubeide_build 的动作，其余是 cubeide_debug 的。
      const tool = ["build", "rebuild", "clean"].includes(action) ? "cubeide_build" : "cubeide_debug";
      const declaration = declarationFor(tool, action, input);
      expect(declaration, `no declaration for ${action}`).toBeDefined();
      expect(declaration!.effect.length).toBeGreaterThan(0);
    }
  });

  it("memory write declaration carries address and length", () => {
    const declaration = declarationFor("cubeide_debug", "write", { address: 0x20000000, width: "u32", count: 4 });
    expect(declaration!.address).toBe(0x20000000);
    expect(declaration!.length).toBe(16);
  });

  it("chip erase says so honestly", () => {
    const declaration = declarationFor("cubeide_build", "erase", {});
    expect(declaration!.operation).toBe("chip_erase");
    expect(declaration!.effect).toContain("整片");
  });

  it("evidence actions never overlap destructive ones on the same action", () => {
    for (const action of CUBEIDE_EVIDENCE_ACTIONS) {
      // flash 是证据（回读），也可能是破坏——keil 侧同样如此，允许唯一交集。
      if (action === "flash") continue;
      expect(CUBEIDE_DESTRUCTIVE_ACTIONS.has(action), `${action} in both lists`).toBe(false);
    }
  });
});

describe("cubeideInstall", () => {
  it("rejects a directory without the IDE binaries", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      expect(resolveCubeIdeTools(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("newestPlugin picks the highest-versioned directory", () => {
    const plugins = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      mkdirSync(join(plugins, "com.st.stm32cube.ide.mcu.externaltools.openocd.win32_2.3.400.202606220929"));
      mkdirSync(join(plugins, "com.st.stm32cube.ide.mcu.externaltools.openocd.win32_2.4.500.202604080855"));
      const picked = newestPlugin(plugins, "com.st.stm32cube.ide.mcu.externaltools.openocd.");
      expect(picked).toContain("2.4.500");
    } finally {
      rmSync(plugins, { recursive: true, force: true });
    }
  });

  it("resolves a complete fake install layout", () => {
    const root = mkdtempSync(join(tmpdir(), "cubeide-test-"));
    try {
      writeFileSync(join(root, "stm32cubeidec.exe"), "stub");
      const plugins = join(root, "plugins");
      const gnu = join(plugins, "com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.14.3.rel1.win32_1.0.100.202602081740");
      const stlink = join(plugins, "com.st.stm32cube.ide.mcu.externaltools.stlink-gdb-server.win32_2.2.500.202604010938");
      const cp = join(plugins, "com.st.stm32cube.ide.mcu.externaltools.cubeprogrammer.win32_2.2.500.202603051304");
      mkdirSync(join(gnu, "tools", "bin"), { recursive: true });
      mkdirSync(join(stlink, "tools", "bin"), { recursive: true });
      mkdirSync(join(cp, "tools", "bin"), { recursive: true });
      writeFileSync(join(gnu, "tools", "bin", "arm-none-eabi-gdb.exe"), "stub");
      writeFileSync(join(stlink, "tools", "bin", "ST-LINK_gdbserver.exe"), "stub");
      writeFileSync(join(cp, "tools", "bin", "STM32_Programmer_CLI.exe"), "stub");
      const tools = resolveCubeIdeTools(root);
      expect(tools).not.toBeNull();
      expect(tools!.gdb).toContain("arm-none-eabi-gdb.exe");
      expect(tools!.stlinkGdbServer).toContain("ST-LINK_gdbserver.exe");
      expect(tools!.programmerCli).toContain("STM32_Programmer_CLI.exe");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
