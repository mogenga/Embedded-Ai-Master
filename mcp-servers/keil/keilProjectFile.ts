/**
 * Reading and editing a Keil project's own XML.
 *
 * `.uvprojx` and `.uvoptx` are where Keil keeps the facts the socket interface
 * does not expose: the device, the flash algorithm, and which debug adapter
 * the project is configured for. uVision reads them when it opens the project
 * and writes them back when it exits, so as long as the project is loaded
 * these values are authoritative on disk and stale in memory.
 *
 * Two rules make editing safe:
 *
 *  - Only the text inside the target element is replaced. Everything else —
 *    attribute order, indentation, line endings, the byte-order mark — is
 *    copied through untouched, so a change shows up in `git diff` as the one
 *    line it is.
 *  - The file is read and written as latin1, not UTF-8. Keil writes these files
 *    in the system code page, and a path with a non-ASCII character would be
 *    re-encoded (and corrupted) by a UTF-8 round trip. latin1 is byte-preserving
 *    for any input, which is what "leave everything else alone" requires.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { decodeXmlText, encodeXmlText } from "./xmlText.js";

export interface KeilProjectFacts {
  /** `.uvprojx` path. */
  project: string;
  /** `.uvoptx` path when it exists next to the project. */
  optionFile?: string;
  /** Every `<TargetName>` in the project, in file order. */
  targets: string[];
  /** The target the facts below came from (the first, when none is named). */
  target?: string;
  /** `<Device>` — the exact part, e.g. `STM32F429IGTx`. */
  device?: string;
  /** `<Vendor>`. */
  vendor?: string;
  /** `<PackID>`. */
  packId?: string;
  /** `<Cpu>`. */
  cpu?: string;
  /** `<FlashDriverDll>` — the flash algorithm line. */
  flashDriver?: string;
  /** `<OutputName>` for that target. */
  outputName?: string;
  /** `<OutputDirectory>` for that target. */
  outputDirectory?: string;
  /** `.uvoptx` `<pMon>` — the debug adapter DLL, e.g. `STLink\ST-LINKIII-KEIL_SWO.dll`. */
  debugAdapter?: string;
  /** `.uvoptx` `<nTsel>`. */
  adapterIndex?: number;
  /** `.uvoptx` `<uSim>` — true when the project is set to the simulator. */
  simulator?: boolean;
}

/** The `.uvoptx` that belongs to a `.uvprojx`. */
export function optionFileFor(projectFile: string): string {
  return projectFile.replace(/\.uvprojx$/i, ".uvoptx");
}

/**
 * Read a file as latin1.
 *
 * Keil writes these in the system code page; decoding as UTF-8 would replace
 * bytes it does not recognise and then write those replacement characters
 * back. latin1 maps every byte to one code point, so a read-write cycle is
 * byte-identical.
 */
function readRaw(path: string): string {
  return readFileSync(path, "latin1");
}

/** The `<Target>…</Target>` block whose `<TargetName>` matches, or the first. */
function targetBlock(xml: string, name?: string): { block: string; name: string } | undefined {
  const blocks = [...xml.matchAll(/<Target>([\s\S]*?)<\/Target>/g)].map((match) => match[0]);
  if (blocks.length === 0) return undefined;
  const named = blocks.map((block) => ({ block, name: textOf(block, "TargetName") ?? "" }));
  if (name) {
    const exact = named.find((entry) => entry.name === name);
    if (exact) return exact;
  }
  return named[0];
}

/** The text content of the first `<tag>` in `xml`. */
function textOf(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!match) return undefined;
  const value = decodeXmlText(match[1]!).trim();
  return value ? value : undefined;
}

/** Every value of `<tag>` in `xml`, in file order. */
function allOf(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))]
    .map((match) => decodeXmlText(match[1]!).trim())
    .filter(Boolean);
}

/**
 * Read what a project says about itself.
 *
 * `target` picks the `<Target>` block; without it the first one is used, which
 * is what uVision opens for a single-target project. A multi-target project
 * needs the name, and `targets` is returned so a caller can offer the choice.
 */
export function readProjectFacts(projectFile: string, target?: string): KeilProjectFacts {
  const xml = readRaw(projectFile);
  const facts: KeilProjectFacts = { project: projectFile, targets: allOf(xml, "TargetName") };
  const chosen = targetBlock(xml, target);
  if (chosen) {
    facts.target = chosen.name;
    const block = chosen.block;
    facts.device = textOf(block, "Device");
    facts.vendor = textOf(block, "Vendor");
    facts.packId = textOf(block, "PackID");
    facts.cpu = textOf(block, "Cpu");
    facts.flashDriver = textOf(block, "FlashDriverDll");
    facts.outputName = textOf(block, "OutputName");
    facts.outputDirectory = textOf(block, "OutputDirectory");
  }
  const options = optionFileFor(projectFile);
  if (existsSync(options)) {
    facts.optionFile = options;
    const optXml = readRaw(options);
    facts.debugAdapter = textOf(optXml, "pMon");
    const tsel = textOf(optXml, "nTsel");
    if (tsel !== undefined && /^\d+$/.test(tsel)) facts.adapterIndex = Number.parseInt(tsel, 10);
    // `<uSim>` is 1 when the project is set to the simulator.
    const sim = textOf(optXml, "uSim");
    if (sim !== undefined) facts.simulator = sim === "1" || sim.toLowerCase() === "true";
  }
  return facts;
}

/**
 * Which file owns a field.
 *
 * The device and flash algorithm live in `.uvprojx`; the debug adapter lives
 * in `.uvoptx`. Writing the adapter into the wrong file would look like it
 * worked and change nothing, which is the failure mode this whole module
 * exists to avoid.
 */
export type ProjectField = "Device" | "Vendor" | "PackID" | "Cpu" | "FlashDriverDll" | "OutputName" | "OutputDirectory" | "pMon";

const OPT_FIELDS: readonly ProjectField[] = ["pMon"];

/** The file a field belongs to, and whether the project is the right one. */
export function fileForField(facts: KeilProjectFacts, field: ProjectField): string | undefined {
  if (OPT_FIELDS.includes(field)) return facts.optionFile;
  return facts.project;
}

/**
 * Replace one element's text, leaving every other byte alone.
 *
 * Anchored to `</Tag>` so the match cannot run past the element. When the tag
 * appears once per `<Target>` block and a target is named, only that block is
 * edited — a multi-target project otherwise had its first target changed while
 * the user was looking at the second.
 */
export function replaceElement(xml: string, tag: string, value: string, options: { target?: string } = {}): { xml: string; changed: boolean } {
  const escaped = encodeXmlText(value);
  let from = 0;
  let to = xml.length;
  if (options.target) {
    const chosen = targetBlock(xml, options.target);
    if (chosen) {
      from = xml.indexOf(chosen.block);
      to = from + chosen.block.length;
    }
  }
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  const head = xml.slice(0, from);
  const body = xml.slice(from, to);
  const tail = xml.slice(to);
  // A `<Target>` block is optional for `<pMon>`: the `.uvoptx` carries it per
  // target too, under `<Target>` blocks of its own.
  const match = pattern.exec(body);
  if (!match) return { xml, changed: false };
  const replaced = `<${tag}>${escaped}</${tag}>`;
  return { xml: head + body.replace(match[0], replaced) + tail, changed: match[0] !== replaced };
}

/**
 * Write a field back to the file that owns it, after taking a backup.
 *
 * The backup is the price of editing a file a closed-source IDE also writes.
 * It is named `<file>.prometheus.bak` and overwritten on each edit, so a
 * caller always has the state from just before the most recent change.
 */
export function writeProjectField(
  facts: KeilProjectFacts,
  field: ProjectField,
  value: string,
  options: { target?: string } = {},
): { ok: boolean; file?: string; backup?: string; changed: boolean; reason?: string } {
  const file = fileForField(facts, field);
  if (!file) {
    return {
      ok: false,
      changed: false,
      reason:
        field === "pMon"
          ? "there is no .uvoptx next to this project, so the debug adapter cannot be stored; open the project in uVision once to create it"
          : "the project file is unknown",
    };
  }
  if (!existsSync(file)) return { ok: false, changed: false, reason: `${file} does not exist` };
  const original = readRaw(file);
  const result = replaceElement(original, field, value, options);
  const backup = `${file}.prometheus.bak`;
  copyFileSync(file, backup);
  writeFileSync(file, result.xml, "latin1");
  return { ok: true, file, backup, changed: result.changed };
}

/**
 * What the adapter list should offer.
 *
 * uVision names adapters by their DLL (`STLink\ST-LINKIII-KEIL_SWO.dll`). The
 * short name is what a person picks in the dialog, so both are returned and
 * the writer stores the DLL form the file uses.
 */
export const KNOWN_ADAPTERS: readonly { name: string; dll: string }[] = [
  { name: "ST-Link", dll: "STLink\\ST-LINKIII-KEIL_SWO.dll" },
  { name: "J-Link / J-Trace", dll: "Segger\\JL2CM3.dll" },
  { name: "ULINK2", dll: "Keil\\UL2CM3.dll" },
  { name: "ULINKplus", dll: "Keil\\ULP2CM3.dll" },
  { name: "CMSIS-DAP", dll: "BIN\\CMSIS_AGDI.dll" },
  { name: "NULink", dll: "Nuvoton\\Nu_Link.dll" },
];
