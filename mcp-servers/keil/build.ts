/**
 * 构建产物扫描与 fromelf 解析（从 A 侧 build.ts 摘出的 Keil 闭包）。
 *
 * A 的 build.ts 还负责调用各生态的构建命令与诊断解析；Keil 工具链只需要
 * "在 OutputDirectory 里找镜像"和"读 fromelf 占用"这两件事，因此这里只保留
 * `findArtifactsIn` 与 `parseFromelf`，其余不随迁移。
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { MemoryUsage } from "./flash.js";

export interface BuildArtifact {
  path: string;
  /** Path relative to the project root, for display. */
  relative: string;
  bytes: number;
  kind: "elf" | "hex" | "bin" | "uf2";
}

function subdirectories(root: string, depth: number): string[] {
  const out: string[] = [];
  if (depth <= 0) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(path);
    out.push(...subdirectories(path, depth - 1));
  }
  return out;
}

export function findArtifactsIn(roots: string[], patterns: string[] | undefined, hint?: string, relativeTo = roots[0]): BuildArtifact[] {
  const found: BuildArtifact[] = [];
  const seen = new Set<string>();

  const kindOf = (path: string): BuildArtifact["kind"] | null => {
    const dot = path.lastIndexOf(".");
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
    if (ext === ".elf") return "elf";
    // Keil's name for an ELF. Same file, same magic, different suffix — and
    // without this the artifact was found and then thrown away.
    if (ext === ".axf") return "elf";
    if (ext === ".out" && /iar/i.test(path)) return "elf";
    if (ext === ".hex") return "hex";
    if (ext === ".bin") return "bin";
    if (ext === ".uf2") return "uf2";
    if (ext === "") {
      // An extensionless artifact is an ELF when it starts with \x7fELF.
      try {
        const handle = openSync(path, "r");
        const header = Buffer.alloc(4);
        readSync(handle, header, 0, 4, 0);
        closeSync(handle);
        if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) return "elf";
      } catch {
        return null;
      }
    }
    return null;
  };

  const add = (path: string) => {
    if (seen.has(path) || !existsSync(path)) return;
    let size = 0;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return;
      size = stat.size;
    } catch {
      return;
    }
    const kind = kindOf(path);
    if (!kind) return;
    // A directory can hold a debugger's memory dump next to the image. A
    // flash of a few megabytes is already enormous; anything past 64 MiB is
    // not firmware, and listing a 377 MB `SAVE` dump as an artifact is worse
    // than missing it because the next step would try to flash it.
    if ((kind === "hex" || kind === "bin") && size > 64 * 1024 * 1024) return;
    seen.add(path);
    found.push({
      path,
      relative: relative(relativeTo, path).replace(/\\/g, "/"),
      bytes: size,
      kind,
    });
  };

  if (hint) add(hint);
  for (const root of roots) for (const pattern of patterns ?? []) {
    const segments = pattern.split("/");
    let frontier = [root];
    for (const segment of segments) {
      const next: string[] = [];
      for (const dir of frontier) {
        if (segment === "**") {
          // A recursive segment, walked with a depth limit. csolution's
          // output is `out/<project>/<target>/<build>/<name>.axf`, so a
          // fixed-depth pattern would have to know every level; measured,
          // `out/**/*.elf` matched nothing and the build reported success
          // with no artifact.
          next.push(dir, ...subdirectories(dir, 6));
        } else if (segment.includes("*")) {
          const regex = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
          try {
            for (const entry of readdirSync(dir)) if (regex.test(entry)) next.push(join(dir, entry));
          } catch {
            /* unreadable directory */
          }
        } else {
          next.push(join(dir, segment));
        }
      }
      frontier = next;
    }
    for (const path of frontier) add(path);
  }

  // Patterns are conventions, and conventions get broken (an OUTPUT_NAME with no
  // suffix, a flavour directory). The scan always runs, so an ELF that a glob
  // missed is still found alongside the ones it caught.
  for (const root of roots) for (const dir of [join(root, "build"), root]) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        const candidate = join(dir, entry);
        try {
          if (statSync(candidate).isFile()) add(candidate);
        } catch {
          /* vanished between readdir and stat */
        }
      }
    } catch {
      /* unreadable */
    }
  }

  // Newest first; an ELF beats its own hex/bin at the same timestamp because it
  // carries the debug symbols a debugger step needs.
  found.sort((a, b) => {
    const at = statSync(a.path).mtimeMs;
    const bt = statSync(b.path).mtimeMs;
    if (Math.abs(at - bt) > 500) return bt - at;
    return a.kind === "elf" ? -1 : b.kind === "elf" ? 1 : 0;
  });
  return found;
}

/**
 * Flash/RAM from `fromelf --text -z`.
 *
 * The `ROM Totals` row is:
 *
 *      Code (inc. data)   RO Data    RW Data    ZI Data
 *      31978       1164      18842        108    2050364   ROM Totals for app.axf
 *
 * Flash is Code + RO Data (the two things that live in ROM). RAM is RW Data +
 * ZI Data: the initialised bytes are copied there, and ZI is reserved.
 *
 * The `Debug` column before the name is not part of the image and is ignored.
 * Column positions are not used either — the numbers are parsed by order from
 * the end, because Keil versions add and drop columns.
 */
export function parseFromelf(output: string): MemoryUsage | undefined {
  // The linker's own line is preferred when present: it carries all four
  // numbers, and its ZI figure is what the linker placed rather than what an
  // image reader infers.
  const program = /Program\s+Size:\s*Code=(\d+)\s+RO-data=(\d+)\s+RW-data=(\d+)\s+ZI-data=(\d+)/i.exec(output);
  if (program) {
    const [, code, ro, rw, zi] = program.map(Number);
    return { flash: code + ro, ram: rw + zi, sections: [] };
  }
  // `ROM Totals` prints **0** in the ZI column; the per-object row above it is
  // where the real figure is. Measured on `fromelf --text -z TOUCH.axf`:
  //
  //      31978  1164  18842  108  2050364  537275  TOUCH.axf
  //      31978  1164  18842  108        0       0  ROM Totals for TOUCH.axf
  //
  // so RAM read from the totals row was 108 bytes instead of 2 MB. The totals
  // row is used for flash only, and ZI is taken from the object row.
  const row = (line: string) =>
    line
      .replace(/(ROM\s+Totals|Object\s+Name).*$/i, "")
      .match(/[\d,]+/g)
      ?.map((value) => Number(value.replace(/,/g, "")))
      .filter((value) => Number.isFinite(value)) ?? [];
  let totals: number[] | undefined;
  let objectRow: number[] | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (/ROM\s+Totals/i.test(line)) totals = row(line);
    else if (!objectRow && /\.axf|\.elf|\.out/i.test(line) && row(line).length >= 5) objectRow = row(line);
  }
  if (!totals || totals.length < 5) return undefined;
  const [code, , roData, rwData] = totals;
  // Both rows have six numbers — Code, the "(inc. data)" subtotal, RO Data,
  // RW Data, ZI Data, Debug — so ZI is index 4, not 3.
  const zi = objectRow && objectRow.length >= 5 ? objectRow[4] : totals[4];
  return { flash: code + roData, ram: rwData + (zi || 0), sections: [] };
}