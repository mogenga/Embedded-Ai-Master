import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeilTools } from "../tools.js";
import { declarationFor } from "../declarations.js";
import { backupProjectFiles, readProjectFacts } from "../keilProjectFile.js";
import { detectProject } from "../project.js";
import {
  registerSessionForTest,
  resetSessionsForTest,
  setUv4PathForTest,
  type KeilSession,
} from "../keilSession.js";
import { OP, type Reply } from "../uvsock.js";

/**
 * `declarations.ts` 曾声明「编辑前自动备份」，但生产路径从未调用备份函数
 * （OPT-06 / R3）。这里钉住两件事：声明与实现一致，以及编辑动作确实先备份、
 * 备份失败就不编辑。全部走注入的假会话，不连 Keil。
 */

const SAMPLE = join(import.meta.dirname, "fixtures", "sample-project");

function success(): Reply {
  return { status: 0, statusName: "SUCCESS", ok: true, data: Buffer.alloc(0) };
}

/** Registers an in-debug session whose every request is accepted. */
function installSession(project: string, seen: number[] = []): void {
  const session: KeilSession = {
    client: {
      closed: false,
      mark: 0,
      send: async (command: number) => {
        seen.push(command);
        return success();
      },
    } as unknown as KeilSession["client"],
    project,
    debugging: true,
    target: "hardware",
    extended: true,
    openedAt: 0,
  };
  registerSessionForTest(session);
}

let dir: string;
let project: string;
beforeEach(() => {
  resetSessionsForTest();
  setUv4PathForTest("C:/fake-keil/UV4/UV4.exe");
  dir = mkdtempSync(join(tmpdir(), "keil-backup-"));
  project = join(dir, "DEMO.uvprojx");
  copyFileSync(join(SAMPLE, "TOUCH.uvprojx"), project);
  copyFileSync(join(SAMPLE, "TOUCH.uvoptx"), join(dir, "DEMO.uvoptx"));
});
afterEach(() => {
  resetSessionsForTest();
  setUv4PathForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("工程编辑前的备份", () => {
  it("声明文案与实现一致：不再声称没有发生过的备份，而是写明备份文件名与 fail-closed", () => {
    const declaration = declarationFor("keil_project", "set_option", {});
    expect(declaration?.effect).toContain("自动备份");
    expect(declaration?.effect).toContain(".prometheus.bak");
    expect(declaration?.effect).toContain("备份失败则不编辑");
  });

  it("backupProjectFiles 复制 .uvprojx 与 .uvoptx，路径紧邻原文件", () => {
    const originalProject = readFileSync(project, "utf8");
    const originalOptions = readFileSync(join(dir, "DEMO.uvoptx"), "latin1");
    const result = backupProjectFiles(project);
    expect(result.ok).toBe(true);
    expect(result.backups).toEqual([`${project}.prometheus.bak`, `${join(dir, "DEMO.uvoptx")}.prometheus.bak`]);
    expect(readFileSync(`${project}.prometheus.bak`, "utf8")).toBe(originalProject);
    expect(readFileSync(`${join(dir, "DEMO.uvoptx")}.prometheus.bak`, "latin1")).toBe(originalOptions);
  });

  it("没有 .uvoptx 时只备份 .uvprojx，不伪造第二个文件", () => {
    rmSync(join(dir, "DEMO.uvoptx"));
    const result = backupProjectFiles(project);
    expect(result.ok).toBe(true);
    expect(result.backups).toEqual([`${project}.prometheus.bak`]);
    expect(existsSync(`${join(dir, "DEMO.uvoptx")}.prometheus.bak`)).toBe(false);
  });

  it("set_option 走生产路径时会先产生备份，并在输出里报告路径", async () => {
    installSession(project);
    const tools = createKeilTools();
    const projectTool = tools.find((tool) => tool.name === "keil_project")!;
    // `port` 4823 is where the injected session lives; project operations
    // otherwise run on the plain 4824 session, which would spawn a real UV4.
    const result = await projectTool.handler({ action: "set_option", project, port: 4823, option: "CDEF", value: "DEBUG=1" });
    // The fake answers every request with SUCCESS, so the read-back compares
    // "DEBUG=1" against an empty value and the call reports a failure — what
    // matters here is that the backup happened before the edit was attempted.
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("backed up:");
    expect(text).toContain(`${project}.prometheus.bak`);
    expect(existsSync(`${project}.prometheus.bak`)).toBe(true);
  });

  it("备份失败时不派发任何编辑请求（fail-closed）", async () => {
    const seen: number[] = [];
    installSession(project, seen);
    const tools = createKeilTools();
    const projectTool = tools.find((tool) => tool.name === "keil_project")!;
    // A directory where the backup file should go makes `copyFileSync` fail on
    // every platform, without touching the project itself.
    writeFileSync(`${project}.prometheus.bak`, "", "utf8");
    rmSync(`${project}.prometheus.bak`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${project}.prometheus.bak`);
    const result = await projectTool.handler({ action: "add_group", project, port: 4823, group: "BSP" });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("could not back up");
    expect(text).toContain("the project was not edited");
    expect(seen).not.toContain(OP.PRJ_ADD_GROUP);
  });

  it("备份文件不会被工程识别当成工程打开", () => {
    backupProjectFiles(project);
    expect(readdirSync(dir)).toContain("DEMO.uvprojx.prometheus.bak");
    const detected = detectProject(dir);
    expect(detected.file).toBe(project);
    // The backup parses as the same project bytes, so the only thing that
    // keeps it out is the suffix filter — assert the filter is what answered.
    expect(readProjectFacts(`${project}.prometheus.bak`).device).toBe("STM32F429IGTx");
  });
});
