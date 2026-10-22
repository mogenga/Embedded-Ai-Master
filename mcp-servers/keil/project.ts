/**
 * Keil / IAR / CMSIS-Toolbox 工程识别与构建命令（从 A 侧 project.ts 摘出的 Keil 闭包）。
 *
 * A 的 project.ts 659 行覆盖 11 种生态（Zephyr/ESP-IDF/PlatformIO/Arduino/
 * Cargo/CMake/Make/Keil/IAR/csolution）。Keil 工具链只需后三种，本文件逐行保留
 * 这三条的识别与构建逻辑，其余生态不随迁移（keil-porting-spec.md §5.4）。
 *
 * 两条实测规则不能改：
 * - 备份文件绝不能当工程打开（`TOUCH.uvprojx.orig` 也匹配 `*.uvprojx*`）；
 * - 向上查找时，祖先目录只接受"包含起点"的工程，否则会把兄弟工程的
 *   `.uvprojx` 当成自己的，进而读改别人的工程。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type ProjectKind = "keil" | "iar" | "csolution" | "unknown";

export interface BuildCommand {
  kind: ProjectKind;
  /** The program to run (already resolved to a path or a bare name). */
  program: string;
  args: string[];
  /** Directory to run in. */
  cwd: string;
  /** Where the final binary should be, when the ecosystem has a convention. */
  artifactHint?: string;
  /** Build outputs to look for, newest first. */
  artifactPatterns?: string[];
  /**
   * A log the tool writes instead of stdout.
   *
   * Keil's `UV4 -b` prints nothing useful to the console; the diagnostics are
   * in the `-o` file. Parsing the file is the difference between a build that
   * reports "#20: identifier undefined" and one that reports "exit 2".
   */
  buildLog?: string;
  /**
   * Directories to search for artifacts, when the project decides where they
   * go. Keil names an `OutputDirectory` relative to its project file and the
   * default is `..\OBJ\`; a scan of the repository root finds nothing there.
   */
  artifactRoots?: string[];
}

export interface DetectedProject {
  kind: ProjectKind;
  root: string;
  /** Human-readable evidence for the detection, shown in the UI. */
  evidence: string[];
  /** The project file itself (`.uvprojx`, `.ewp`), when the ecosystem has one. */
  file?: string;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function has(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The `.uvprojx` to hand to `UV4 -b`.
 *
 * Keil's own convention puts the project in a subdirectory (`USER\`, `MDK-ARM\`,
 * `Project\`), not at the repository root — this was found on a real project
 * whose `.uvprojx` lives in `USER\` while the root only holds `CORE`,
 * `HALLIB`, `OBJ` and friends. So the root is searched first and then one level
 * down, which is where every Keil template puts it.
 *
 * Deterministic: same order every call, so a rebuild does not flip projects.
 */
export function keilProjectFile(root: string): string | null {
  return findProjectFile(root, /\.uvprojx?$/i);
}

/** The `.ewp` for `IarBuild`, same convention as Keil's. */
export function iarProjectFile(root: string): string | null {
  return findProjectFile(root, /\.ewp$/i);
}

/** A project file, at the root or one directory below it, in a stable order. */
function findProjectFile(root: string, pattern: RegExp): string | null {
  // A backup must never be opened as the project: `TOUCH.uvprojx.orig` matches
  // `*.uvprojx*` and sorts before the real file, so an edit would be written
  // into a copy that nothing builds.
  const matches = (dir: string): string[] =>
    readdirSyncSafe(dir)
      .filter((name) => pattern.test(name) && !/\.(bak|orig|backup|save|tmp)$/i.test(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => join(dir, name));

  const atRoot = matches(root);
  if (atRoot.length > 0) return atRoot[0];

  // One level down, but not into the output directory: `OBJ\` holds the
  // generated files, and a stale copy there is not the project.
  const subdirs = readdirSyncSafe(root)
    .filter((name) => !/^(OBJ|obj|build|Build|DebugConfig|RTE|\.|node_modules)$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  for (const name of subdirs) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = matches(dir);
    if (found.length > 0) return found[0];
  }
  return null;
}

/**
 * A project file inside `start`'s own subtree, when walking up from it.
 *
 * `findProjectFile` answers for "this directory or one level below", which at
 * an ancestor of several projects means a sibling. This variant accepts only a
 * project that contains `start`.
 */
function findProjectFileAbove(root: string, start: string, pattern: RegExp): string | null {
  const under = resolve(start);
  const candidates = [
    ...readdirSyncSafe(root)
      .filter((name) => pattern.test(name) && !/\.(bak|orig|backup|save|tmp)$/i.test(name))
      .map((name) => join(root, name)),
    ...readdirSyncSafe(root)
      .filter((name) => !/^(OBJ|obj|build|Build|DebugConfig|RTE|\.|node_modules)$/.test(name))
      .flatMap((name) => {
        const dir = join(root, name);
        try {
          if (!statSync(dir).isDirectory()) return [];
        } catch {
          return [];
        }
        // 只进入包含起点的子目录：语义与 A 相同（候选最终都会被 insideRoot
        // 过滤掉），但避免在上层目录里 stat 大量无关目录导致探测变慢。
        if (!insideRoot(resolve(dir), under)) return [];
        return readdirSyncSafe(dir)
          .filter((entry) => pattern.test(entry) && !/\.(bak|orig|backup|save|tmp)$/i.test(entry))
          .map((entry) => join(dir, entry));
      }),
  ];
  const inside = candidates.filter((path) => insideRoot(resolve(path, ".."), under));
  return inside.sort((a, b) => a.localeCompare(b))[0] ?? null;
}

/** True when `candidate` is `root` or under it, compared as whole segments. */
function insideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** Detect from the given directory upward, stopping at the first strong match. */
export function detectProject(start = process.cwd()): DetectedProject {
  let dir = start;
  for (let depth = 0; depth < 5; depth++) {
    // A CMSIS-Toolbox project states itself before any generic evidence does:
    // `*.csolution.yml` is the solution, `*.cprj` a single project. Both are
    // built by `cbuild`, which Keil ships in `ARM\cmsis-toolbox\bin`.
    // Only the directory itself: `findProjectFile` walks one level down *and*
    // this loop walks up five, so a match here picked up a `.csolution.yml`
    // from an unrelated sibling — measured, a temp directory detected the
    // solution file of a completely different temp directory. A solution file
    // names its own projects, so it only counts where it sits.
    const solution = readdirSyncSafe(dir).find((name) => /\.csolution\.yml$/i.test(name));
    if (solution) return { kind: "csolution", root: dir, evidence: ["csolution"], file: join(dir, solution) };
    // 只需本层：A 的写法是 `findProjectFile` 再要求 `dirname(cprj) === dir`，
    // 等价于"这个 .cprj 就在 dir 里"。直接读本层，避免向上探测时 stat 大量
    // 无关子目录（在临时目录的祖先上曾慢到超时）。
    const cprj = readdirSyncSafe(dir).find(
      (name) => /\.cprj$/i.test(name) && !/\.(bak|orig|backup|save|tmp)$/i.test(name),
    );
    if (cprj) return { kind: "csolution", root: dir, evidence: ["cprj"], file: join(dir, cprj) };

    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Keil and IAR templates put the project in a subdirectory (`USER\`,
  // `MDK-ARM\`, `Project\`). Looking only at the directory itself found
  // nothing on a real project whose root holds CORE/HALLIB/OBJ and whose
  // `.uvprojx` lives one level down.
  //
  // But the search must stay **below** `dir` on the way up: `findProjectFile`
  // also looks one level down, so at an ancestor that is the parent of
  // several projects it answers with a sibling's `.uvprojx`. Measured: a
  // directory with no project of its own was detected as a Keil project
  // pointing at another project in an unrelated tree, and `keil_project`
  // then read and edited that one. Only `start` itself may look downward —
  // that is the "run from the repository root" case the downward search is
  // for; an ancestor may only match a project that *contains* `start`.
  const ancestors: string[] = [];
  {
    let dir = start;
    for (let depth = 0; depth < 5; depth++) {
      ancestors.push(dir);
      const parent = join(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const dir of ancestors) {
    const vendor = dir === start ? findProjectFile(dir, /\.uvprojx?$|\.ewp$/i) : findProjectFileAbove(dir, start, /\.uvprojx?$|\.ewp$/i);
    if (vendor) {
      const name = vendor.split(/[\\/]/).pop() ?? vendor;
      const kind = /\.ewp$/i.test(vendor) ? "iar" : "keil";
      // The file path is carried on the result: a Keil debug session opens the
      // project, not the directory, and the caller should not have to repeat
      // the search to find what detection already found.
      return {
        kind,
        root: dir,
        evidence: [dir === start ? name : `${name} (${dir})`],
        file: vendor,
      };
    }
  }
  return { kind: "unknown", root: start, evidence: [] };
}

/**
 * Where a Keil target writes its image.
 *
 * Every target has its own `<OutputDirectory>`. Reading the first one meant a
 * build of the second target wrote to `OBJ_SIM\` while the artifact scan only
 * looked in `OBJ\`, so a successful build reported no image.
 *
 * Relative output directories resolve against the project file's **directory**,
 * not against the workspace root — that is Keil's own rule. `join(projectFile,
 * "..", output)` resolved against the file path itself and produced
 * `<dir>/USER/<dir>`.
 *
 * The existence filter is applied by the caller, after the build: doing it here
 * meant a freshly cloned project — whose `OBJ\` does not exist until UV4
 * creates it — reported a successful build with no image, because the root
 * that would contain it had already been dropped.
 */
export function keilOutputDirs(projectFile: string, root: string): string[] {
  const dirs: string[] = [];
  try {
    const xml = readFileIfExists(projectFile).replace(/^\uFEFF/, "");
    for (const match of xml.matchAll(/<OutputDirectory>([^<]*)<\/OutputDirectory>/g)) {
      if (!match[1]?.trim()) continue;
      const output = match[1].trim().replace(/\\/g, "/");
      dirs.push(resolve(dirname(projectFile), output));
    }
  } catch {
    /* an unreadable project is reported by the build itself */
  }
  dirs.push(join(projectFile, ".."));
  dirs.push(root);
  return dirs.filter((dir, index, all) => all.indexOf(dir) === index);
}

function readFileIfExists(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

/**
 * The build command for a detected project.
 *
 * `toolchains` is the resolved set from detection; a project whose ecosystem
 * tool is missing gets a command pointing at the bare name anyway, so the
 * error the agent sees names the missing program instead of a generic
 * "unsupported project".
 */
export function buildCommand(
  project: DetectedProject,
  toolchains: Record<string, string>,
  options: { preset?: string; target?: string; buildDir?: string; release?: boolean } = {},
): BuildCommand | null {
  const root = project.root;

  switch (project.kind) {
    case "keil": {
      // The documented headless commands, each with its own switch:
      //
      //   -b  build the current target      -r  re-translate (rebuild)
      //   -c  clean                          -cr clean and re-translate
      //   -f  download to flash              -t  select the target
      //   -o  write the log here             -j0 no GUI, no dialogs
      //
      // `-t` matters on a multi-target project: without it uVision builds
      // whichever target was last current, which is whatever the user happened
      // to leave open — not something a build command should decide.
      // `project.file` is the project detection settled on, which for a nested
      // working directory is found by walking up and only accepting a project
      // that contains the start. Re-searching from `root` loses that: with
      // `app1\P.uvprojx` and `app2\P.uvprojx` side by side, building from
      // `app2\src` picked `app1` because it sorts first.
      const project1 = project.file ?? keilProjectFile(root);
      if (!project1) return null;
      // `-o` is resolved against the project file's directory, not the
      // process's working directory, and the parent must exist before UV4
      // writes anything. Both were found the hard way on a real project: a
      // relative log path produced no log at all and the build looked clean
      // while carrying no diagnostics.
      const logDir = join(root, "build");
      try {
        mkdirSync(logDir, { recursive: true });
      } catch {
        /* the build will report it */
      }
      const log = join(logDir, "keil-build.log");
      const action = options.release ? "-r" : "-b";
      const args = [action, resolve(project1), "-j0", "-o", resolve(log)];
      if (options.target) args.push("-t", options.target);
      return {
        kind: "keil",
        program: toolchains.keil ?? "UV4.exe",
        args,
        cwd: root,
        // The linker prints all four numbers in the log:
        //   Program Size: Code=31978 RO-data=18842 RW-data=108 ZI-data=2050364
        // which is more accurate than `fromelf` for a Keil image because the
        // ZI region is exactly what the linker placed.
        buildLog: log,
        // Where the image lands is the project's own `OutputDirectory`, which
        // is relative to the project file and commonly `..\OBJ\`. Scanning the
        // repository root finds nothing on a real Keil tree, so the directory
        // is read out of the project and the scan runs there.
        // The image formats the target can produce. A stray `.hex` from a
        // debugger `SAVE` is excluded by size in `findArtifactsIn`: a 377 MB
        // memory dump was being listed as a build artifact.
        artifactPatterns: ["*.axf", "*.hex", "*.bin"],
        artifactRoots: keilOutputDirs(project1, root),
      };
    }
    case "csolution": {
      // `cbuild <solution.csolution.yml>` resolves the project list, the packs
      // and the toolchain from the solution; a bare `.cprj` is built the same
      // way. `--outdir` is left at its default (`./out`), which is where the
      // images land.
      const solution = project.file ?? findProjectFile(root, /\.csolution\.yml$/i) ?? findProjectFile(root, /\.cprj$/i);
      if (!solution) return null;
      return {
        kind: "csolution",
        program: toolchains.cbuild ?? "cbuild",
        args: [solution, ...(options.release ? ["--configuration", "Release"] : [])],
        cwd: root,
        artifactPatterns: ["out/**/*.elf", "out/**/*.axf", "out/**/*.hex", "out/**/*.bin", "*.elf"],
      };
    }
    case "iar": {
      const project1 = iarProjectFile(root);
      if (!project1) return null;
      return {
        kind: "iar",
        program: toolchains.iar ?? "IarBuild.exe",
        args: [project1, "-build", options.release ? "Release" : "Debug"],
        cwd: root,
        artifactPatterns: ["**/*.out", "**/*.hex", "**/*.bin", "*.out", "*.hex", "*.bin"],
      };
    }
    default:
      return null;
  }
}