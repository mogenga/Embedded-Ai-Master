#!/usr/bin/env node
/**
 * Toolchain-pack end-to-end check: install → verify the executable runs →
 * remove → no residue.
 *
 * Mirrors `scripts/probe-e2e.mjs`: a standalone node script that drives the
 * compiled kernel modules (`dist/packs/*`) against a throwaway root, prints a
 * one-line JSON verdict, and exits non-zero on any broken invariant. The pack
 * defaults to pyOCD (the smallest entry in the catalog, ~35 MiB); override
 * with `PACKS_E2E_PACK=<id>`.
 *
 * The default used to be Ninja. `f03473b` removed that catalog entry (and
 * OpenOCD / RISC-V / probe-rs / esptool) when the product narrowed to the
 * Keil5 chain, which left this script failing with "no such pack" on every
 * run until the default was pointed at an entry that still exists.
 *
 * The install here is a real download over the network — this script is an
 * acceptance run, not part of `npm test` (which stays offline).
 *
 * The root is a temp directory by default. `PACKS_E2E_REAL_ROOT=1` installs
 * into the real `%LOCALAPPDATA%\Embedded-Ai-Master\toolchains` instead (the
 * pack is removed again before exit; only the empty root skeleton remains).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKS_DIR = path.join(ROOT, "dist", "packs");

function fail(message) {
  console.error(`packs e2e: ${message}`);
  process.exit(1);
}

if (!existsSync(path.join(PACKS_DIR, "registry.js"))) {
  console.error("packs e2e: 未找到 dist/packs/registry.js；请先运行 npm run build");
  process.exit(2);
}

// The packs modules resolve the root from the environment at call time, so the
// override must be in place before they are imported (they are pure functions,
// but `packsRoot()` defaults are evaluated per call — setting this first keeps
// the intent obvious either way).
const useRealRoot = process.env.PACKS_E2E_REAL_ROOT === "1";
const e2eRoot = useRealRoot ? undefined : mkdtempSync(path.join(tmpdir(), "eam-packs-e2e-"));
if (e2eRoot) process.env.HARNESS_TOOLCHAIN_HOME = e2eRoot;

/**
 * Remove the throwaway root on **every** exit path, not just the happy one.
 *
 * `fail()` calls `process.exit()`, which skips everything below it — so the
 * single `rmSync` that used to sit at the bottom of this file left a full temp
 * directory behind whenever a check failed or the run was killed. (实测：一次
 * 中断在 `tmp\txn-*\archive-0.zip` 上留下 1.7 MB，另有两个 0 字节残留目录。)
 * `mkdtempSync` gave us this directory and nothing else writes into it, so
 * deleting it is always safe.
 */
function cleanup() {
  if (e2eRoot === undefined) return;
  try {
    rmSync(e2eRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A locked file on Windows must not turn a failed check into a confusing
    // EBUSY — the verdict was already printed.
  }
}
process.on("exit", cleanup);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    cleanup();
    process.exit(code);
  });
}

const { installPack } = await import(pathToFileURL(path.join(PACKS_DIR, "install.js")));
const { catalogEntry, toInstallEntry } = await import(pathToFileURL(path.join(PACKS_DIR, "catalog.js")));
const { packBinDirs, removePack } = await import(pathToFileURL(path.join(PACKS_DIR, "registry.js")));
const { packsRoot, packsDir } = await import(pathToFileURL(path.join(PACKS_DIR, "paths.js")));

function pathToFileURL(file) {
  return new URL(`file://${file.replace(/\\/g, "/").replace(/^\/?([A-Za-z]:)/, "/$1")}`).href;
}

function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const wanted = process.env.PACKS_E2E_PACK?.trim() || "pyocd-0.46.0-win32-x64";
const entry = catalogEntry(wanted);
if (!entry) {
  const { catalogFor } = await import(pathToFileURL(path.join(PACKS_DIR, "catalog.js")));
  const installable = catalogFor().map((item) => item.id).join(", ");
  fail(`目录里没有 ${wanted}。可安装条目：${installable}`);
}

const root = packsRoot();
console.error(`packs e2e: root = ${root}`);
console.error(`packs e2e: installing ${entry.id} (${entry.downloadBytes} bytes)`);

let lastPhase = "";
try {
  await installPack(toInstallEntry(entry), {
    onProgress: (progress) => {
      if (progress.phase !== lastPhase) {
        lastPhase = progress.phase;
        const size =
          progress.phase === "download" && progress.total
            ? ` ${Math.round(((progress.received ?? 0) / progress.total) * 100)}%`
            : "";
        console.error(`packs e2e: phase ${progress.phase}${size}`);
      }
    },
  });
} catch (error) {
  fail(`安装失败：${error instanceof Error ? error.message : String(error)}`);
}

// The pack must answer to its own executable before it counts as installed.
const bins = packBinDirs();
const dirs = bins.get(entry.provides[0]) ?? [];
if (dirs.length === 0) {
  fail(`packBinDirs() 没有报告 ${entry.provides[0]} 的 bin 目录`);
}
const executable = path.join(dirs[0].dir, entry.executables[0].path.split("/").pop());
if (!existsSync(executable)) {
  fail(`可执行文件不在预期位置：${executable}`);
}
const probe = await run(executable, ["--version"]);
const probeText = `${probe.out}${probe.err}`.trim();
if (probe.code !== 0 || !probeText) {
  fail(`${executable} --version 退出码 ${probe.code}，输出为空或失败`);
}

// The keil MCP server reads the same registry through the injection wired in
// `dist-mcp/keil/server.js`; the bin directory above is exactly what
// `toolEnv()` would prepend, so the pack is reachable without system PATH.
await removePack(entry.id);

const residue = readdirSync(packsDir(root)).filter((name) => !name.startsWith("."));
const trash = readdirSync(packsDir(root)).filter((name) => name.startsWith(".trash-"));
if (residue.length > 0 || trash.length > 0) {
  fail(`卸载后有残留：packs=${residue.join(",")} trash=${trash.join(",")}`);
}

const verdict = {
  pack: entry.id,
  root,
  realRoot: useRealRoot,
  installed: true,
  executable,
  executableVersion: probeText.split(/\r?\n/)[0],
  binDirReachableWithoutPath: dirs[0].dir,
  removed: true,
  residue: false,
};
console.log(JSON.stringify(verdict));

// The root is removed by `cleanup()` on exit — including every `fail()` path.
