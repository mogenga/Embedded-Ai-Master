/**
 * The `UV4.exe` command-line switches as explicit operations.
 *
 * The build path already runs `-b`/`-r`; these are the rest of what the
 * documented interface offers and a project workflow actually uses:
 *
 *   -c / -cr   clean, and clean-then-re-translate
 *   -f         download to flash
 *   -X / -X1   generate `co-arm_<target>.h` preprocessor symbol files
 *   -5         convert a µVision 4 `.uvproj` to `.uvprojx`
 *
 * **Not** `-et`/`-ep`: they are documented as exporting a cprj and on MDK
 * 5.43.1 they exit 0 and write nothing. The export runs the CMSIS-Toolbox
 * converter pair instead — see `exportCprj`.
 *
 * Each is one headless run of UV4 with its own log, so the exit code and the
 * log are read the same way the build reads them.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { toolEnv } from "./toolEnv.js";
import { findUvprojx } from "./projectLookup.js";

export type KeilCliOperation = "clean" | "clean-rebuild" | "export-cprj" | "export-cprjs" | "symbols" | "symbols-all" | "convert" | "save";

export interface KeilCliResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  /** The log's contents, which is where UV4 writes its report. */
  log: string;
  /** Files the operation should have produced, when it produces files. */
  produced: string[];
  durationMs: number;
  reason?: string;
}

const SWITCH: Record<KeilCliOperation, string> = {
  clean: "-c",
  "clean-rebuild": "-cr",
  "export-cprj": "-et",
  "export-cprjs": "-ep",
  symbols: "-X",
  "symbols-all": "-X1",
  convert: "-5",
  // Not a UV4 switch: uVision rewrites the `.uvprojx` when it exits, and that
  // is the only way an interface edit reaches the file. See `saveProject`.
  save: "",
};

/**
 * Whether the project's target is configured for Arm Compiler 5.
 *
 * The `.uvprojx` states it as `<uAC6>0</uAC6>`. It matters because a cprj is a
 * CMSIS csolution artefact and that format is AC6-only: measured, `uv2csolution`
 * on an AC5 target answers `0 out of 1 target(s) converted` with
 * "CMSIS csolution projects support Arm Compiler 6 only", and `-et` on the same
 * project exits 0 and writes nothing. The second is the silent failure this
 * check turns into an explanation.
 */
export function isArmCompiler5(projectXml: string): boolean {
  return /<uAC6>\s*0\s*<\/uAC6>/i.test(projectXml);
}

/** Why a cprj cannot be produced for this project, in the converter's own terms. */
export function cprjUnavailableReason(kind: "ac5" | "missing-tools"): string {
  return kind === "ac5"
    ? "this target is built with Arm Compiler 5 and a cprj describes a CMSIS csolution project, which is Arm Compiler 6 only. " +
        "The converter reports \"CMSIS csolution projects support Arm Compiler 6 only\" and converts 0 targets. " +
        "Switch the target to AC6 (Options for Target - Target - ARM Compiler: use default compiler version 6), then export again."
    : "the cprj export needs uv2csolution.exe from the MDK install and cbuild.exe from the CMSIS-Toolbox pack, and neither was found. " +
        "`UV4 -et` is not a substitute: measured on MDK 5.43.1 it exits 0 and writes no file.";
}

/**
 * The two commands that actually produce a `.cprj`.
 *
 * `-et` is documented as writing `<projectName>.<targetName>.cprj`, and on MDK
 * 5.43.1 it exits 0 without writing anything — with or without extra options,
 * with or without `-t`, and on a project whose target *is* AC6. The working
 * path is the CMSIS-Toolbox converter pair:
 *
 *   uv2csolution <project>            → <project>.csolution.yml + .cproject.yml
 *   cbuild <solution> --cbuildgen     → <project>+<target>.cprj
 *
 * Measured end to end on the STM32F429 project: the cprj is 5,969 bytes and
 * carries the device, packs, compiler, flags, defines and include paths.
 * `cbuild` exits 1 when it goes on to build and finds no registered toolchain,
 * but the cprj is written before that, so the file's presence is the check.
 */
export function cprjExportPlan(input: {
  projectFile: string;
  uv4Dir: string;
  toolboxBin: string;
  /** For tests: whether a tool is present. Defaults to the filesystem. */
  has?: (path: string) => boolean;
  /** For tests: the project's XML. Defaults to reading the project file. */
  projectXml?: string;
}): {
  convert: [string, string];
  generate: [string, string[]];
  solution: string;
  produces: string[];
} | null {
  const has = input.has ?? existsSync;
  const converter = join(input.uv4Dir, "uv2csolution.exe");
  const cbuild = join(input.toolboxBin, "cbuild.exe");
  if (!has(converter) || !has(cbuild)) return null;
  const base = (input.projectFile.split(/[\\/]/).pop() ?? "").replace(/\.uvprojx?$/i, "");
  const dir = dirname(input.projectFile);
  const solution = join(dir, `${base}.csolution.yml`);
  const xml = input.projectXml ?? readFileSync(input.projectFile, "utf8").replace(/^﻿/, "");
  const targets = [...xml.matchAll(/<TargetName>([^<]*)<\/TargetName>/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
  const produces = (targets.length > 0 ? targets : [base]).map((target) => join(dir, `${base}+${target}.cprj`));
  return {
    convert: [converter, input.projectFile],
    generate: [cbuild, [solution, "--cbuildgen"]],
    solution,
    produces,
  };
}

/**
 * The `cprj` a `-et` run writes.
 *
 * `<projectName>.<targetName>.cprj` next to the project, with the target read
 * from the project file so the answer does not depend on which target uVision
 * last had current.
 */
export function cprjPaths(projectFile: string): string[] {
  const dir = dirname(projectFile);
  const base = (projectFile.split(/[\\/]/).pop() ?? "").replace(/\.uvprojx?$/i, "");
  const text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  const targets = [...text.matchAll(/<TargetName>([^<]*)<\/TargetName>/g)].map((match) => match[1]).filter(Boolean);
  if (targets.length === 0) return [join(dir, `${base}.cprj`)];
  return targets.map((target) => join(dir, `${base}.${target}.cprj`));
}

/** The `co-arm_<target>.h` a `-X` run writes into the target's output folder. */
export function symbolHeaderPaths(projectFile: string): string[] {
  const dir = dirname(projectFile);
  const text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  const output = /<OutputDirectory>([^<]*)<\/OutputDirectory>/.exec(text)?.[1] ?? ".\\";
  const outDir = join(dir, output.replace(/\\/g, "/"));
  return [...text.matchAll(/<TargetName>([^<]*)<\/TargetName>/g)]
    .map((match) => match[1])
    .filter(Boolean)
    .map((target) => join(outDir, `co-arm_${target}.h`));
}

/**
 * Write interface-made edits into the `.uvprojx`.
 *
 * `PRJ_ADD_FILE`, `PRJ_ADD_GROUP` and the option setters change uVision's
 * in-memory project and answer `SUCCESS`, but they never touch the file: a
 * clean exit, a `-b` run and a killed process all leave the `.uvprojx` exactly
 * as it was. Measured — a group's `Files` stayed empty through all three.
 *
 * uVision rewrites the project when one *opens* it, so an empty headless run
 * is what performs the save: it loads the file, writes it back, and exits.
 * The method is verified by the caller, which compares the file's bytes
 * before and after, so "saved" is never reported without evidence.
 */
async function saveProject(options: KeilCliOptions, projectFile: string, started: number): Promise<KeilCliResult> {
  const before = readFileSync(projectFile);
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile(
      options.uv4,
      [projectFile, "-j0", "-sg"],
      { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: toolEnv() },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
      },
    );
  });
  let changed = false;
  try {
    changed = !readFileSync(projectFile).equals(before);
  } catch {
    changed = false;
  }
  return {
    ok: result.code === 0,
    command: `${options.uv4} ${projectFile} -j0 -sg`,
    exitCode: result.code,
    log: result.out.trim(),
    produced: changed ? [projectFile] : [],
    durationMs: Date.now() - started,
    ...(changed
      ? {}
      : {
          reason:
            "the project file is unchanged after uVision opened and closed it. Interface edits live in uVision's memory until it rewrites the project, " +
            "and this run did not. Nothing was lost that was on disk, but the edit is not persisted.",
        }),
  };
}

/**
 * Produce a `.cprj` for the project's target(s), the way that actually works.
 *
 * `-et`/`-ep` are documented as exporting to cprj, and on MDK 5.43.1 they exit
 * 0 without writing anything — measured with and without `-t`, with and without
 * `-j0`/`-o`, and on a project whose target is already AC6. So the export runs
 * the CMSIS-Toolbox converter pair instead, and reports what each step said:
 *
 *   uv2csolution <project>          → <project>.csolution.yml + .cproject.yml
 *   cbuild <solution> --cbuildgen   → <project>+<target>.cprj
 *
 * The converter is also the only component that explains *why* a project cannot
 * be converted. A target built with Arm Compiler 5 is refused with "CMSIS
 * csolution projects support Arm Compiler 6 only"; that sentence is what turns
 * a silent exit 0 into an answer, so it is checked before anything runs.
 */
async function exportCprj(options: KeilCliOptions, projectFile: string, started: number): Promise<KeilCliResult> {
  const xml = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  const fail = (reason: string, log = "", command = ""): KeilCliResult => ({
    ok: false,
    command,
    exitCode: null,
    log,
    produced: [],
    durationMs: Date.now() - started,
    reason,
  });
  if (isArmCompiler5(xml)) return fail(cprjUnavailableReason("ac5"));

  const uv4Dir = dirname(options.uv4);
  const toolboxBin = join(uv4Dir, "..", "ARM", "cmsis-toolbox", "bin");
  const plan = cprjExportPlan({ projectFile, uv4Dir, toolboxBin });
  if (!plan) return fail(cprjUnavailableReason("missing-tools"));

  const run = (file: string, args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      execFile(
        file,
        args,
        { cwd: options.cwd, timeout: options.timeoutMs ?? 5 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: toolEnv() },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
        },
      );
    });

  const converted = await run(plan.convert[0], plan.convert.slice(1) as string[]);
  if (!existsSync(plan.solution)) {
    return fail(
      `the converter wrote no ${basename(plan.solution)}. Its output: ${converted.out.trim().split(/\r?\n/).filter(Boolean).slice(-6).join(" | ")}`,
      converted.out,
      `${plan.convert.join(" ")}`,
    );
  }
  // `cbuild` exits 1 when it goes on to build and finds no registered Arm
  // toolchain; the cprj is written before that, so the file is the check and
  // the log is passed through for whatever else it says.
  const generated = await run(plan.generate[0], plan.generate[1]);
  const produced = plan.produces.filter((path) => existsSync(path));
  const command = `${plan.convert.join(" ")} && ${plan.generate[0]} ${plan.generate[1].join(" ")}`;
  if (produced.length === 0) {
    return fail(`the converter ran but wrote none of: ${plan.produces.join(", ")}`, generated.out, command);
  }
  return {
    ok: true,
    command,
    exitCode: generated.code,
    log: generated.out.trim(),
    produced,
    durationMs: Date.now() - started,
  };
}

export interface KeilCliOptions {
  /** Project directory; the `.uvprojx` is found the same way a build finds it. */
  cwd: string;
  operation: KeilCliOperation;
  /** `UV4.exe`, resolved by toolchain detection. */
  uv4: string;
  /** Target to operate on, for a multi-target project. */
  target?: string;
  /** Project file, when the caller already knows it. */
  project?: string;
  timeoutMs?: number;
}

export async function keilCli(options: KeilCliOptions): Promise<KeilCliResult> {
  const started = Date.now();
  const projectFile = options.project ?? findUvprojx(options.cwd);
  if (!projectFile || !existsSync(projectFile)) {
    return { ok: false, command: "", exitCode: null, log: "", produced: [], durationMs: 0, reason: "no .uvprojx in this workspace" };
  }
  if (!existsSync(options.uv4)) {
    return { ok: false, command: "", exitCode: null, log: "", produced: [], durationMs: 0, reason: `UV4.exe was not found at ${options.uv4}` };
  }
  if (options.operation === "save") return saveProject(options, projectFile, started);
  if (options.operation === "export-cprj" || options.operation === "export-cprjs") {
    return exportCprj(options, projectFile, started);
  }
  const logDir = join(options.cwd, "build");
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* the run reports it */
  }
  const log = join(logDir, `keil-${options.operation}.log`);
  // `-5` takes only `-l`, not `-o`; every other operation writes its report
  // to `-o`.
  //
  // `-et`/`-ep` are **not** in this path: the command-line reference says of
  // `-et`, "No other options are supported with this command", and measured on
  // MDK 5.43.1 it exits 0 and writes no file either way. They go through
  // `exportCprj`, which uses the CMSIS-Toolbox converter and checks the file.
  //
  // `-sg` keeps uVision from reading and rewriting the per-user GUI layout
  // files (`*.uvguix.*`), which a batch run should never touch.
  const command: string[] = [SWITCH[options.operation], projectFile, "-j0", "-sg"];
  if (options.operation === "convert") command.push("-l", log);
  else command.push("-o", log);
  if (options.target) command.push("-t", options.target);

  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile(
      options.uv4,
      command,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 10 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: toolEnv() },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, out: `${stdout ?? ""}\n${stderr ?? ""}` });
      },
    );
  });

  let report = result.out;
  try {
    if (existsSync(log)) report = readFileSync(log, "utf8");
  } catch {
    /* the console output is all there is */
  }

  // What the operation should have produced, checked rather than assumed.
  // `-5` converts `X.uvproj` into `X.uvprojx`; when the project already *is*
  // a `.uvprojx` there is nothing to convert and the "expected" path was the
  // input itself, which always exists — so the check passed on a run that
  // exited 20 having done nothing.
  const expected =
    options.operation === "symbols" || options.operation === "symbols-all"
      ? symbolHeaderPaths(projectFile)
      : options.operation === "convert" && /\.uvproj$/i.test(projectFile)
        ? [projectFile.replace(/\.uvproj$/i, ".uvprojx")]
        : [];
  const produced = expected.filter((path) => existsSync(path));

  // UV4 exits 0 even when an export writes nothing, so an operation that is
  // supposed to produce a file is only successful when the file is there.
  // Measured: `-et` on this project printed nothing, exited 0 and produced no
  // `.cprj`; reporting that as success would be exactly the false completion
  // this project is trying to avoid.
  const shouldProduce = expected.length > 0;
  // `-5` on a project that is already `.uvprojx` has nothing to do; UV4 exits
  // 20 ("cannot convert") for it, which is a refusal of the request rather
  // than a failure of the tool.
  const alreadyConverted = options.operation === "convert" && !/\.uvproj$/i.test(projectFile);
  const ok = alreadyConverted ? true : (result.code === 0 || result.code === 1) && (!shouldProduce || produced.length > 0);
  return {
    ok,
    command: `${options.uv4} ${command.join(" ")}`,
    exitCode: result.code,
    log: report.trim(),
    produced,
    durationMs: Date.now() - started,
    ...(ok
      ? alreadyConverted
        ? { reason: `${projectFile} is already a .uvprojx; there was nothing to convert` }
        : {}
      : shouldProduce
        ? { reason: `UV4 exited ${result.code} but wrote none of: ${expected.join(", ")}` }
        : {
          reason:
            result.code === 11
              ? "cannot open the project file for writing"
              : result.code === 13
                ? "error writing the project file"
                : result.code === 12
                  ? "the device named in the project is not in the database"
                  : result.code === 20
                    ? "the .uvproj could not be converted"
                    : `UV4 exited with ${result.code}`,
        }),
  };
}
