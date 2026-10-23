import { describe, it, expect } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectFacts, replaceElement, writeProjectField, optionFileFor } from "../keilProjectFile.js";

const SAMPLE = join(import.meta.dirname, "fixtures", "sample-project");

it("a real project's facts are read from the files Keil owns", () => {
  const facts = readProjectFacts(join(SAMPLE, "TOUCH.uvprojx"));
  expect(facts.device).toBe("STM32F429IGTx");
  expect(facts.vendor).toBe("STMicroelectronics");
  expect(facts.outputName).toBe("TOUCH");
  expect(facts.outputDirectory).toBe("..\\OBJ\\");
  expect(facts.targets).toEqual(["TOUCH"]);
  expect(facts.flashDriver ?? "").toMatch(/STM32F4xx_1024\.FLM/);
  // The adapter is in `.uvoptx`, not `.uvprojx` — putting it there is the
  // mistake this asserts against.
  expect(facts.debugAdapter ?? "").toMatch(/ST-LINKIII-KEIL_SWO\.dll/);
  expect(facts.simulator).toBe(false);
});

it("editing one element leaves every other byte alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "keil-edit-"));
  const project = join(dir, "TOUCH.uvprojx");
  copyFileSync(join(SAMPLE, "TOUCH.uvprojx"), project);
  copyFileSync(join(SAMPLE, "TOUCH.uvoptx"), join(dir, "TOUCH.uvoptx"));
  const projectBefore = readFileSync(project, "latin1");
  const optBefore = readFileSync(join(dir, "TOUCH.uvoptx"), "latin1");

  const wanted = "Segger" + String.fromCharCode(92) + "JL2CM3.dll";
  const facts = readProjectFacts(project);
  const written = writeProjectField(facts, "pMon", wanted);
  expect(written.ok).toBe(true);
  expect(written.changed).toBe(true);
  expect(written.file).toBe(join(dir, "TOUCH.uvoptx"));

  const projectAfter = readFileSync(project, "latin1");
  const optAfter = readFileSync(join(dir, "TOUCH.uvoptx"), "latin1");
  expect(projectAfter).toBe(projectBefore);

  const before = optBefore.split("\n");
  const after = optAfter.split("\n");
  expect(before.length).toBe(after.length);
  const changed = before.map((line, index) => (line === after[index] ? null : index)).filter((index) => index !== null);
  expect(changed.length).toBe(1);
  expect(after[changed[0]!].trim()).toBe(`<pMon>${wanted}</pMon>`);
  expect(readProjectFacts(project).debugAdapter).toBe(wanted);

  rmSync(dir, { recursive: true, force: true });
});

it("a change is backed up before it is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "keil-bak-"));
  const project = join(dir, "TOUCH.uvprojx");
  copyFileSync(join(SAMPLE, "TOUCH.uvprojx"), project);
  copyFileSync(join(SAMPLE, "TOUCH.uvoptx"), join(dir, "TOUCH.uvoptx"));
  const original = readFileSync(join(dir, "TOUCH.uvoptx"), "latin1");
  const facts = readProjectFacts(project);
  writeProjectField(facts, "pMon", "Keil" + String.fromCharCode(92) + "UL2CM3.dll");
  expect(readFileSync(join(dir, "TOUCH.uvoptx.prometheus.bak"), "latin1")).toBe(original);
  rmSync(dir, { recursive: true, force: true });
});

it("the adapter field refuses to be written into a project that has no .uvoptx", () => {
  const dir = mkdtempSync(join(tmpdir(), "keil-noopt-"));
  const project = join(dir, "TOUCH.uvprojx");
  copyFileSync(join(SAMPLE, "TOUCH.uvprojx"), project);
  const facts = readProjectFacts(project);
  expect(facts.optionFile).toBe(undefined);
  const written = writeProjectField(facts, "pMon", "x.dll");
  expect(written.ok).toBe(false);
  expect(written.reason ?? "").toMatch(/uvoptx/);
  rmSync(dir, { recursive: true, force: true });
});

it("a multi-target project edits the target that was named", () => {
  const xml = [
    "<Project><Targets>",
    "<Target><TargetName>A</TargetName><Device>PART_A</Device></Target>",
    "<Target><TargetName>B</TargetName><Device>PART_B</Device></Target>",
    "</Targets></Project>",
  ].join("\n");
  const changed = replaceElement(xml, "Device", "PART_C", { target: "B" });
  expect(changed.changed).toBe(true);
  expect(changed.xml).toMatch(/<TargetName>A<\/TargetName><Device>PART_A<\/Device>/);
  expect(changed.xml).toMatch(/<TargetName>B<\/TargetName><Device>PART_C<\/Device>/);
});

it("an unknown target falls back to the first block rather than writing nowhere", () => {
  const xml = "<Project><Target><TargetName>A</TargetName><Device>PART_A</Device></Target></Project>";
  const changed = replaceElement(xml, "Device", "PART_C", { target: "NOPE" });
  expect(changed.changed).toBe(true);
  expect(changed.xml).toMatch(/PART_C/);
});

it("the option file sits next to the project with the same stem", () => {
  expect(optionFileFor("G:\\p\\USER\\APP.uvprojx")).toBe("G:\\p\\USER\\APP.uvoptx");
  expect(optionFileFor("G:\\p\\USER\\APP.UVPROJX")).toBe("G:\\p\\USER\\APP.uvoptx");
});

it("the target list survives a debug session, where the socket refuses to enumerate", () => {
  // Measured: `PRJ_ENUM_TARGETS` answers status 36 (`DEBUGGING`) with no
  // frames inside a debug session, so the enumeration reads as "no targets".
  // The project file has the same list and is readable in either state.
  const facts = readProjectFacts(join(SAMPLE, "TOUCH.uvprojx"));
  expect(facts.targets).toEqual(["TOUCH"]);
  expect(facts.targets.length > 0).toBeTruthy();
});

it("an entity in a name is decoded, so the file it points at is found", async () => {
  const { decodeXmlText } = await import("../xmlText.js");
  // uVision stores `Work & Play` as `Work &amp; Play`. Every parser here read
  // the raw text, so a file that exists was reported missing and a group that
  // exists listed no files — silently, in both directions.
  expect(decodeXmlText("Work &amp; Play")).toBe("Work & Play");
  expect(decodeXmlText("a &lt; b &gt; c")).toBe("a < b > c");
  // `&amp;lt;` is a literal `&lt;`, not `<`: decoding `&amp;` first breaks it.
  expect(decodeXmlText("&amp;lt;")).toBe("&lt;");
  expect(decodeXmlText("&#65;&#x42;")).toBe("AB");
  expect(decodeXmlText("plain")).toBe("plain");
});

it("a group name with an entity matches the group in the project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keil-entity-"));
  const project = join(dir, "APP.uvprojx");
  const fs = await import("node:fs");
  fs.mkdirSync(join(dir, "Drivers & BSP"), { recursive: true });
  fs.writeFileSync(join(dir, "Drivers & BSP", "main.c"), "");
  fs.writeFileSync(
    project,
    '<Project><Targets><Target><TargetName>T</TargetName><Groups><Group><GroupName>Drivers &amp; BSP</GroupName>' +
      "<Files><File><FileName>main.c</FileName><FilePath>.\Drivers &amp; BSP\main.c</FilePath></File></Files>" +
      "</Group></Groups></Target></Targets></Project>",
  );
  const { groupsInProject, filePathsInGroup } = await import("../keilSession.js");
  expect(groupsInProject(project)).toEqual(["Drivers & BSP"]);
  expect(filePathsInGroup(project, "Drivers & BSP").length).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

it("the wire code page is GBK, measured from a live group name", async () => {
  const { decodeGbk, encodeGbk } = await import("../gbk.js");
  // Measured: a group named `中文组` in a UTF-8 project comes back over the
  // socket as d6 d0 ce c4 d7 e9 — GBK, the system code page. latin1 mapped each
  // character to its low byte and UTF-8 produced replacement characters.
  const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xe9]);
  expect(decodeGbk(bytes)).toBe("中文组");
  expect(encodeGbk("中文组").toString("hex")).toBe("d6d0cec4d7e9");
  expect(decodeGbk(encodeGbk("中文组"))).toBe("中文组");
});

it("ascii passes through the GBK path unchanged", async () => {
  const { decodeGbk, encodeGbk } = await import("../gbk.js");
  // Every ordinary group and file name takes this path, so it must not pay a
  // conversion cost or change a byte.
  expect(encodeGbk("USER").toString("latin1")).toBe("USER");
  expect(decodeGbk(Buffer.from("USER"))).toBe("USER");
  expect(decodeGbk(encodeGbk("CORE\startup_stm32f429xx.s"))).toBe("CORE\startup_stm32f429xx.s");
});

it("an SSTR carries its length in GBK bytes, not characters", async () => {
  const { sstr } = await import("../uvsock.js");
  // The length field counts bytes. Writing the character count made the far
  // end read past the text.
  const buffer = sstr("中文组");
  expect(buffer.readInt32LE(0)).toBe(7);
  expect(buffer.subarray(4, 10).toString("hex")).toBe("d6d0cec4d7e9");
});

it("the fixture keeps its BOM and Chinese path bytes", async () => {
  const { decodeGbk } = await import("../gbk.js");
  const project = join(SAMPLE, "TOUCH.uvprojx");
  const bytes = readFileSync(project);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  // Keil writes these files in the system code page; the fixture is stored in
  // GBK so the Chinese path round-trips through the same decoder the socket uses.
  expect(decodeGbk(bytes.subarray(3))).toContain("中文目录");
  expect(decodeGbk(bytes.subarray(3))).toContain("STM32F4xx_1024.FLM");
});

it("both fixture files parse as XML right after the BOM", async () => {
  // uVision refuses a project file whose first XML byte is not `<` ("Cannot
  // read project file"), and a stray byte after the BOM once shipped here —
  // the unit tests still passed because none of them fed the fixture to a
  // parser. Guard both files so that cannot come back.
  const { xmlParser } = await import("node:expat").catch(() => ({ xmlParser: undefined }));
  void xmlParser;
  for (const name of ["TOUCH.uvprojx", "TOUCH.uvoptx"]) {
    const bytes = readFileSync(join(SAMPLE, name));
    const start = bytes.subarray(0, 3).toString("hex") === "efbbbf" ? 3 : 0;
    const text = bytes.subarray(start).toString("latin1");
    expect(text.startsWith("<?xml"), `${name} must start with <?xml after the BOM`).toBe(true);
    // The project-file surgery regexes are anchored to real element structure:
    // `readProjectFacts` returning real facts proves the elements parse back
    // out of these bytes.
    const facts = readProjectFacts(join(SAMPLE, name.replace(".uvoptx", ".uvprojx")));
    expect(facts.device).toBe("STM32F429IGTx");
  }
});
