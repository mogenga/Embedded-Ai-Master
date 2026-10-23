import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSketch } from "../arduinoCli.js";
import { routeProject } from "../../cubeide/route.js";
import { declarationFor } from "../declarations.js";
import { ARDUINO_DESTRUCTIVE_ACTIONS } from "../actions.js";
import { resolveSketchShape } from "../tools.js";

/**
 * arduino 后端的离线单元测试：fixture 是临时目录，不 spawn arduino-cli。
 * （CLI 的 JSON 形状与编译行为已由真机冒烟验证——arduino-cli 1.4.1、
 * arduino:avr 1.8.7、Blink 编译 924 bytes——那些依赖本机安装，不进离线测试。）
 */

const INO = `void setup() {}\nvoid loop() {}\n`;

function makeSketch(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.ino`), INO);
  return dir;
}

describe("findSketch", () => {
  it("recognises a sketch whose .ino matches the directory name", () => {
    const root = mkdtempSync(join(tmpdir(), "arduino-test-"));
    try {
      const dir = makeSketch(root, "Blink");
      const found = findSketch(dir);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Blink");
      expect(found!.inoFile).toBe(join(dir, "Blink.ino"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a directory whose .ino does not match the directory name", () => {
    const root = mkdtempSync(join(tmpdir(), "arduino-test-"));
    try {
      const dir = join(root, "NotSketch");
      mkdirSync(dir);
      writeFileSync(join(dir, "other.ino"), INO);
      expect(findSketch(dir)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveSketchShape", () => {
  it("finds a sketch one level below an explicit parent", () => {
    const root = mkdtempSync(join(tmpdir(), "arduino-test-"));
    try {
      makeSketch(root, "Blink");
      const resolved = resolveSketchShape({ project: root });
      expect(resolved.sketch?.name).toBe("Blink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an error for a directory without sketches", () => {
    const root = mkdtempSync(join(tmpdir(), "arduino-test-"));
    try {
      writeFileSync(join(root, "main.c"), "int main(){}");
      const resolved = resolveSketchShape({ project: root });
      expect(resolved.error).toContain("does not contain a sketch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("routeProject with arduino", () => {
  it("routes a sketch directory to arduino", () => {
    const root = mkdtempSync(join(tmpdir(), "arduino-test-"));
    try {
      makeSketch(root, "Blink");
      const route = routeProject(root);
      expect(route.kind).toBe("arduino");
      expect(route.sketchDirs).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes a sketch root containing several sketches", () => {
    const root = mkdtempSync(join(tmpdir(), "arduino-test-"));
    try {
      makeSketch(root, "Blink");
      makeSketch(root, "Fade");
      const route = routeProject(root);
      expect(route.kind).toBe("arduino");
      expect(route.sketchDirs).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports mixed when a sketch and a keil project share a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "arduino-test-"));
    try {
      makeSketch(root, "Blink");
      writeFileSync(join(root, "APP.uvprojx"), "<Project/>");
      expect(routeProject(root).kind).toBe("mixed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an .ino named differently from its directory is not a sketch", () => {
    const root = mkdtempSync(join(tmpdir(), "arduino-test-"));
    try {
      const dir = join(root, "Sketch1");
      mkdirSync(dir);
      writeFileSync(join(dir, "unrelated.ino"), INO);
      expect(routeProject(root).kind).toBe("none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("declarations", () => {
  it("declares upload, nothing else needs one", () => {
    for (const action of ARDUINO_DESTRUCTIVE_ACTIONS) {
      expect(declarationFor(action), `no declaration for ${action}`).toBeDefined();
    }
    expect(declarationFor("compile")).toBeUndefined();
  });
});
