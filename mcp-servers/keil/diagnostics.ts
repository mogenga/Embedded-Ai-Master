/**
 * Keil build-log diagnostics, as data instead of prose.
 *
 * A failed `build` used to hand back the tail of uVision's log and a build
 * code; the caller then had to find the file and line itself, and a cascade of
 * twelve linker errors pushed the one root cause out of the context window.
 *
 * **The grammar below is the documented output format of ARMCC (AC5),
 * ARMCLANG (AC6) and armlink — it is not a sample taken from a real UV4
 * build.** There is no working Keil install on the bench these tests were
 * written on, and no real build log in the repository, so the failure here
 * would be claiming more than that. What the parser is worth is stated
 * exactly: it recognises the shapes the vendors document, and anything it does
 * not recognise is left in the raw log tail that still follows it.
 *
 * Pure: it takes a string and returns data. No file is read, no process is
 * started (the one import, `parseFileLine`, is the location splitter the
 * session already uses — a second copy of that rule is how the two drift).
 */

import { parseFileLine } from "./keilSession.js";

export interface Diagnostic {
  /** Source file, forward slashes. Absent for a linker error and for a compiler error with no location. */
  file?: string;
  line?: number;
  severity: "error" | "warning";
  /** `#20` / `#177-D` (compiler), `L6218E` (linker). Absent when the line carries none. */
  code?: string;
  message: string;
  /** The log line this came from, byte for byte. */
  raw: string;
}

/**
 * `<location>: <severity>: <message>`, anchored at the line start.
 *
 * The location may not contain whitespace: `..\USER\main.c(36)` is a location,
 * `see ..\USER\main.c(36)` is prose quoting one. A real path containing a
 * space is therefore not recognised here — its line still reaches the caller
 * in the raw log tail, which is the honest failure for a rule this narrow.
 */
const COMPILER_LINE =
  /^\s*(?<loc>[^\s"][^\s"]*(?:\(\s*\d+\s*\)|:\s*\d+(?::\d+)?))\s*:\s*(?<sev>[Ff]atal [Ee]rror|[Ee]rror|[Ww]arning)\s*:\s*(?<rest>.*)$/;

/**
 * `<image>: <Severity>: <code>: <message>` — armlink's shape, and also ARMCC's
 * when it has no location to give. Anchored at the line start; the optional
 * `prefix` is the image (`.\Objects\demo.axf`), which is **not** a source
 * location and is deliberately not reported as `file`.
 */
const LINKER_LINE =
  /^\s*(?:(?<prefix>\S+?)\s*:\s*)?(?<sev>[Ff]atal [Ee]rror|[Ee]rror|[Ww]arning)\s*:\s*(?:(?<code>#\d+(?:-[A-Za-z]+)?|L\d+[A-Za-z]*)\s*:\s*)?(?<message>.+)$/;

/** `#20` / `#177-D` at the head of a compiler diagnostic's text. */
const COMPILER_CODE = /^(?<code>#\d+(?:-[A-Za-z]+)?)\s*:\s*(?<message>.+)$/;

/**
 * The symbol a `L6218E` is about: `Undefined symbol HAL_Init (referred from
 * main.o).` → `HAL_Init`.
 *
 * Only this one linker code is unpacked, because it is the one whose cascade
 * the caller can do nothing with: the same missing symbol is reported once per
 * object file that referenced it.
 */
const UNDEFINED_SYMBOL = /^Undefined symbol (\S+) \(referred from /;

const severityOf = (word: string): "error" | "warning" => (/warning/i.test(word) ? "warning" : "error");

/**
 * Every diagnostic the log contains, in log order.
 *
 * A line that is not a diagnostic (a `Build target` banner, `Program Size`,
 * the `N Error(s), M Warning(s)` trailer) produces nothing; a line whose
 * message is empty after trimming produces nothing either.
 */
export function parseDiagnostics(log: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const compiler = COMPILER_LINE.exec(raw);
    if (compiler?.groups) {
      const located = locationFor(compiler.groups.loc ?? "");
      const rest = (compiler.groups.rest ?? "").trim();
      if (located && rest) {
        const coded = COMPILER_CODE.exec(rest);
        out.push({
          file: located.file,
          line: located.line,
          severity: severityOf(compiler.groups.sev ?? ""),
          ...(coded?.groups?.code ? { code: coded.groups.code } : {}),
          message: (coded?.groups?.message ?? rest).trim(),
          raw,
        });
        continue;
      }
    }
    const linker = LINKER_LINE.exec(raw);
    if (linker?.groups) {
      const message = (linker.groups.message ?? "").trim();
      if (!message) continue;
      out.push({
        severity: severityOf(linker.groups.sev ?? ""),
        ...(linker.groups.code ? { code: linker.groups.code } : {}),
        message,
        raw,
      });
    }
  }
  return out;
}

/**
 * The file and line of a compiler location, or `null`.
 *
 * `parseFileLine` owns the two forms the debugger accepts (`file(line)` and
 * `file:line`) and rejects a line below 1, which is why it is reused rather
 * than re-derived. ARMCLANG also prints a column (`main.c:36:12`); that is
 * stripped here first, because handing `parseFileLine` the three-part form
 * finds `main.c:36` as the "file" and mistakes `12` for the line.
 */
function locationFor(location: string): { file: string; line: number } | null {
  const columned = /^(?<file>.+?):\s*(?<line>\d+):\s*\d+$/.exec(location.trim());
  if (columned?.groups?.file && columned.groups.line) {
    const parsed = parseFileLine(`${columned.groups.file}:${columned.groups.line}`);
    if (parsed) return parsed;
  }
  return parseFileLine(location);
}

export interface CollapsedDiagnostics {
  diagnostics: Diagnostic[];
  /** How many were folded away. Reported, never silently dropped. */
  collapsed: number;
}

/**
 * Fold the repeats a single missing symbol causes.
 *
 * The rule is deliberately narrow: a `L6218E` is dropped only when an earlier
 * **error** already reports the same symbol (see `explains` for the two exact
 * shapes that counts as). So one unresolved symbol produces one line, not one
 * per object file, and a compiler error that explains the linker error wins
 * because it comes first. Compiler diagnostics are never folded, even when they
 * repeat word for word: two identical `#20` lines in one file are two places
 * the caller has to fix.
 *
 * Warnings are not a folding basis: a warning mentioning `HAL_Init` does not
 * explain why the link failed.
 */
export function collapseCascades(diagnostics: readonly Diagnostic[]): CollapsedDiagnostics {
  const kept: Diagnostic[] = [];
  let collapsed = 0;
  for (const entry of diagnostics) {
    const symbol = entry.code === "L6218E" ? UNDEFINED_SYMBOL.exec(entry.message)?.[1] : undefined;
    if (symbol && kept.some((earlier) => explains(earlier, symbol))) {
      collapsed++;
      continue;
    }
    kept.push(entry);
  }
  return { diagnostics: kept, collapsed };
}

/**
 * Whether an earlier diagnostic already reports `symbol`.
 *
 * Two shapes only, both exact:
 * - an earlier `L6218E` for the same symbol — this is the cascade itself: the
 *   first object file's error is the one kept, the rest are the repeats;
 * - a compiler error that quotes the name — ARMCC/ARMCLANG write
 *   `#20: identifier "HAL_Init" is undefined`, and the clang-style form
 *   armclang can also emit is `use of undeclared identifier 'HAL_Init'`.
 *
 * A looser "the name appears somewhere in the message" rule folds a missing
 * *header* into a missing *symbol*: `cannot open source input file "foo.h"`
 * contains `foo`, and `foo` is also an undefined symbol — two different
 * problems, one silently lost. Hence the quoted-name shapes.
 */
function explains(earlier: Diagnostic, symbol: string): boolean {
  if (earlier.severity !== "error") return false;
  if (earlier.code === "L6218E" && UNDEFINED_SYMBOL.exec(earlier.message)?.[1] === symbol) return true;
  return earlier.message.includes(`"${symbol}"`) || earlier.message.includes(`'${symbol}'`);
}

/** How many diagnostics are handed to the caller; the rest are counted, not listed. */
export const DIAGNOSTIC_LIMIT = 20;

export interface BuildDiagnostics {
  /** The first `DIAGNOSTIC_LIMIT` diagnostics, after cascades are folded. */
  entries: Diagnostic[];
  /** How many survived folding, listed or not. */
  total: number;
  /** How many the fold removed. */
  collapsed: number;
  /** The block appended to the tool's text: summary, entries, and what was left out. */
  detail: string;
}

/**
 * The diagnostics of one build log, ready for both exits: `entries` / `total` /
 * `collapsed` go to `structuredContent`, `detail` goes to the text.
 */
export function buildDiagnostics(log: string): BuildDiagnostics {
  const { diagnostics, collapsed } = collapseCascades(parseDiagnostics(log));
  const entries = diagnostics.slice(0, DIAGNOSTIC_LIMIT);
  return { entries, total: diagnostics.length, collapsed, detail: renderDetail(diagnostics, entries, collapsed) };
}

/** One diagnostic as a single line, in the shape the compiler itself prints. */
function formatDiagnostic(entry: Diagnostic): string {
  const where = entry.file ? `${entry.file}(${entry.line ?? "?"}): ` : "";
  const code = entry.code ? `${entry.code}: ` : "";
  return `  ${where}${entry.severity}: ${code}${entry.message}`;
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

function renderDetail(all: readonly Diagnostic[], entries: readonly Diagnostic[], collapsed: number): string {
  if (all.length === 0) {
    // "Nothing to do" and "I could not read this" are different answers: a log
    // this parser does not recognise must not read as a clean build. It does
    // happen on real paths — a refused `PRJ_BUILD` is answered with one status
    // word and no compiler output at all. The raw log follows either way.
    return (
      "no line of this build log matched a documented ARMCC/ARMCLANG/armlink diagnostic form, " +
      "so the failure is described only by the raw log below"
    );
  }
  const errors = all.filter((entry) => entry.severity === "error").length;
  const warnings = all.length - errors;
  const folded =
    collapsed > 0 ? `; ${count(collapsed, "repeated linker error")} folded into the error that named the same symbol` : "";
  const lines = [`build diagnostics: ${count(errors, "error")}, ${count(warnings, "warning")}${folded}`];
  for (const entry of entries) lines.push(formatDiagnostic(entry));
  const omitted = all.length - entries.length;
  if (omitted > 0) lines.push(`  ... and ${omitted} more (the log tail below has the rest)`);
  return lines.join("\n");
}
