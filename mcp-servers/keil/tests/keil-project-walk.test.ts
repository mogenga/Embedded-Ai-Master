/**
 * `detectProject` 向上查找的边界。
 *
 * 这些规则的存在理由是一条实测的性能缺陷：`%TEMP%` 下有 31,736 个同级条目，
 * 向上走到那一层时 `findProjectFileAbove` 会对每个条目做一次 `statSync`，
 * 一次 `detectProject` 2.7 s；全量并行跑测试时超过 15 s 超时。边界必须是
 * 「这一层不可能是包含起点的工程根」，而不是一个没有依据的层数。
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import {
  MAX_SIBLING_ENTRIES,
  isAncestorOrSelf,
  isWalkBoundary,
  shouldStopWalkingUp,
  branchToward,
  walkLevels,
} from "../projectWalk.js";
import { detectProject } from "../project.js";

const driveRoot = parse(process.cwd()).root;

describe("boundaries that stop the walk up", () => {
  it("stops at a drive root: there is no directory above it", () => {
    expect(isWalkBoundary(driveRoot)).toBe(true);
    expect(shouldStopWalkingUp(driveRoot, 3)).toBe(true);
  });

  it("stops at the user's home directory and every ancestor of it", () => {
    // `C:\Users\<name>` is not a project root; neither is `C:\Users`.
    expect(isWalkBoundary(homedir())).toBe(true);
    expect(isWalkBoundary(join(homedir(), ".."))).toBe(true);
    expect(shouldStopWalkingUp(homedir(), 20)).toBe(true);
  });

  it("stops at the temp directory and every ancestor of it", () => {
    // `%TEMP%` holds other projects' copies, not a project of its own.
    expect(isWalkBoundary(tmpdir())).toBe(true);
    expect(isWalkBoundary(join(tmpdir(), ".."))).toBe(true);
    expect(isWalkBoundary(join(tmpdir(), "..", ".."))).toBe(true);
    expect(shouldStopWalkingUp(tmpdir(), 10)).toBe(true);
  });

  it("stops at a system directory and below it", () => {
    const windows = process.env.SystemRoot ?? process.env.windir;
    if (windows) {
      expect(isWalkBoundary(windows)).toBe(true);
      expect(isWalkBoundary(join(windows, "System32"))).toBe(true);
    }
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      expect(isWalkBoundary(join(programFiles, "SomeApp"))).toBe(true);
    }
  });

  it("stops when one level has more entries than a project root ever has", () => {
    // A real Keil root has tens of entries; `%TEMP%` had 31,736.
    const projectSized = join(tmpdir(), "prometheus-walk-small");
    expect(shouldStopWalkingUp(projectSized, 40)).toBe(false);
    expect(shouldStopWalkingUp(projectSized, MAX_SIBLING_ENTRIES)).toBe(false);
    expect(shouldStopWalkingUp(projectSized, MAX_SIBLING_ENTRIES + 1)).toBe(true);
  });

  it("a plain project directory is not a boundary, so the walk continues", () => {
    const dir = mkdtempSync(join(tmpdir(), "prometheus-walk-"));
    try {
      const project = join(dir, "USER");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "P.uvprojx"), "<Project/>");
      expect(isWalkBoundary(dir)).toBe(false);
      expect(shouldStopWalkingUp(dir, 12)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a drive root is compared case-insensitively on Windows", () => {
    // `join("C:\\", "..")` normalises to `C:\`; a lowercase spelling must stop too.
    expect(isWalkBoundary(driveRoot.toLowerCase())).toBe(true);
  });

  it("a home or temp that degenerates to the drive root does not swallow every path", () => {
    // In a container `HOME` and `TMPDIR` are often `/`. The drive root is
    // already a boundary on its own; counting it again as the "home" boundary
    // would match every path and stop the walk right after the start, losing
    // every real ancestor project. `os.homedir()` / `os.tmpdir()` cache their
    // answer, so the rule is asserted through the pure form.
    expect(isAncestorOrSelf(driveRoot, join(driveRoot, "work", "proj"))).toBe(false);
    expect(isAncestorOrSelf(driveRoot.toUpperCase(), join(driveRoot, "work"))).toBe(false);
    // A real boundary still matches itself and its ancestors, and nothing below it.
    const temp = tmpdir();
    expect(isAncestorOrSelf(temp, temp)).toBe(true);
    expect(isAncestorOrSelf(temp, join(temp, ".."))).toBe(true);
    expect(isAncestorOrSelf(temp, join(temp, "some-proj"))).toBe(false);
  });

  it("a project inside %TEMP% is still walkable, not immediately a boundary", () => {
    // Tests (and users) legitimately keep projects under the temp directory.
    // Only %TEMP% and its ancestors are boundaries; its children are not.
    const base = mkdtempSync(join(tmpdir(), "prometheus-inside-"));
    try {
      mkdirSync(join(base, "proj", "src"), { recursive: true });
      writeFileSync(join(base, "proj", "P.uvprojx"), "<Project/>");
      expect(isWalkBoundary(base)).toBe(false);
      expect(isWalkBoundary(join(base, "proj"))).toBe(false);
      // And a project above a deep start inside %TEMP% is still detected.
      expect(detectProject(join(base, "proj", "src")).kind).toBe("keil");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the branch that leads down to the start", () => {
  it("is the first path segment below the ancestor", () => {
    const root = join(driveRoot, "repo");
    expect(branchToward(root, join(root, "app", "src"))).toBe("app");
    expect(branchToward(root, join(root, "app"))).toBe("app");
  });

  it("is null when the start is not below the ancestor", () => {
    const root = join(driveRoot, "repo");
    expect(branchToward(root, root)).toBe(null);
    expect(branchToward(root, join(driveRoot, "elsewhere"))).toBe(null);
  });
});

describe("the walk itself", () => {
  it("never reads a boundary level, so a huge %TEMP% is not listed", () => {
    // The measurement that motivated this: listing one level costs 13 ms, and
    // the old code then stat'ed all 31,745 entries beneath it.
    const listed: string[] = [];
    const start = join(driveRoot, "work", "app", "src");
    const levels = walkLevels(start, (dir) => {
      listed.push(dir);
      if (dir === driveRoot) throw new Error("the drive root must not be read");
      return [];
    });
    // Drive root is an ancestor of the start and a boundary: it must be skipped.
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((level) => level.dir !== driveRoot)).toBe(true);
    expect(listed).not.toContain(driveRoot);
  });

  it("still reads the start itself, even at a boundary", () => {
    // The user may be standing in a boundary directory and asking about it.
    const levels = walkLevels(tmpdir(), () => ["a"]);
    expect(levels[0]?.dir).toBe(tmpdir());
  });

  it("stops after a level with more entries than a project root", () => {
    const start = join(driveRoot, "work");
    const read: string[] = [];
    const levels = walkLevels(start, (dir) => {
      read.push(dir);
      return Array.from({ length: MAX_SIBLING_ENTRIES + 1 }, (_, index) => `entry-${index}`);
    });
    expect(levels.length).toBe(1);
    expect(read.length).toBe(1);
  });
});

describe("detection still finds a project above a deep start", () => {
  it("a project one level above the start is found", () => {
    const base = mkdtempSync(join(tmpdir(), "prometheus-above-"));
    try {
      mkdirSync(join(base, "proj", "src"), { recursive: true });
      writeFileSync(join(base, "proj", "P.uvprojx"), "<Project/>");
      const detected = detectProject(join(base, "proj", "src"));
      expect(detected.kind).toBe("keil");
      expect(detected.root).toBe(join(base, "proj"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a project two levels above the start is found", () => {
    // This is the case the old ancestor filter rejected: it asked whether the
    // project file's directory was inside the start, so a project *above* the
    // start could never match. The walk ran (and paid for it) but the answer
    // was always "unknown".
    const base = mkdtempSync(join(tmpdir(), "prometheus-above2-"));
    try {
      mkdirSync(join(base, "proj", "src", "deep"), { recursive: true });
      writeFileSync(join(base, "proj", "P.uvprojx"), "<Project/>");
      const detected = detectProject(join(base, "proj", "src", "deep"));
      expect(detected.kind).toBe("keil");
      expect(detected.root).toBe(join(base, "proj"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a project in a subdirectory of an ancestor still contains the start", () => {
    // Keil's own layout: the project sits in `USER\`, the start in `USER\src`.
    const base = mkdtempSync(join(tmpdir(), "prometheus-above3-"));
    try {
      mkdirSync(join(base, "repo", "USER", "src"), { recursive: true });
      writeFileSync(join(base, "repo", "USER", "P.uvprojx"), "<Project/>");
      const detected = detectProject(join(base, "repo", "USER", "src"));
      expect(detected.kind).toBe("keil");
      expect(detected.root).toBe(join(base, "repo", "USER"));
      expect(detected.file).toBe(join(base, "repo", "USER", "P.uvprojx"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a start with no project of its own and no project above stays unknown", () => {
    const base = mkdtempSync(join(tmpdir(), "prometheus-none-"));
    try {
      mkdirSync(join(base, "a", "b", "c"), { recursive: true });
      const detected = detectProject(join(base, "a", "b", "c"));
      expect(detected.kind).toBe("unknown");
      expect(detected.root).toBe(join(base, "a", "b", "c"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("the detection returned root and evidence keep their shape", () => {
    const base = mkdtempSync(join(tmpdir(), "prometheus-shape-"));
    try {
      mkdirSync(join(base, "proj", "src"), { recursive: true });
      writeFileSync(join(base, "proj", "P.uvprojx"), "<Project/>");
      const above = detectProject(join(base, "proj", "src"));
      // An ancestor match names the directory, because it is not where the
      // caller stands and the path alone would not explain the choice.
      expect(above.evidence).toEqual([`P.uvprojx (${join(base, "proj")})`]);
      const atStart = detectProject(join(base, "proj"));
      expect(atStart.root).toBe(join(base, "proj"));
      expect(atStart.evidence).toEqual(["P.uvprojx"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
