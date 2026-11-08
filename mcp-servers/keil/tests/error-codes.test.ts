import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeilTools } from "../tools.js";
import { KEIL_ERROR_CODES, KEIL_ERROR_CODE_VALUES } from "../errors.js";
import {
  registerSessionForTest,
  resetSessionsForTest,
  setUv4PathForTest,
  type KeilSession,
} from "../keilSession.js";
import { OP, type Reply } from "../uvsock.js";

/**
 * `keil_debug` / `keil_project` 的失败结果必须带机器可读的 `structuredContent.code`。
 *
 * 此前只有「抛异常」一条路给了 `code: "keil_error"`，正常返回的 `isError: true`
 * （`failure` 变量那条路，以及各种提前 return）在结构化结果里没有 `code`，
 * 调用方只能去解析文案（OPT-43）。probe / kb / serial 的失败结果都带 `code`。
 *
 * 文案一个字都不能改：它已经被测试和文档引用。这里只钉结构化字段。
 */

const tools = createKeilTools();
const debug = tools.find((tool) => tool.name === "keil_debug")!;
const project = tools.find((tool) => tool.name === "keil_project")!;

type Structured = { code?: string; [key: string]: unknown };

function structured(result: Awaited<ReturnType<typeof debug.handler>>): Structured {
  return (result.structuredContent ?? {}) as Structured;
}

/** A registered session whose every command answers `answer`. */
function installSession(
  projectPath: string,
  answer: (command: number) => Reply | null,
  overrides: Partial<KeilSession> = {},
): void {
  const session: KeilSession = {
    client: {
      closed: false,
      mark: 0,
      since: () => [],
      send: async (command: number) => {
        const reply = answer(command);
        return reply ?? { status: 0, statusName: "SUCCESS", ok: true, data: Buffer.alloc(0) };
      },
    } as unknown as KeilSession["client"],
    project: projectPath,
    debugging: true,
    target: "hardware",
    extended: true,
    openedAt: 0,
    ...overrides,
  };
  registerSessionForTest(session);
}

let dir: string;
let projectPath: string;
beforeEach(() => {
  resetSessionsForTest();
  setUv4PathForTest("C:/fake-keil/UV4/UV4.exe");
  dir = mkdtempSync(join(tmpdir(), "keil-error-codes-"));
  projectPath = join(dir, "DEMO.uvprojx");
  writeFileSync(projectPath, "<Project/>", "utf8");
});
afterEach(() => {
  resetSessionsForTest();
  setUv4PathForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("keil 错误码词表", () => {
  it("八个必需的错误码都在，且都是 keil_ 前缀的非空字面量", () => {
    expect([...KEIL_ERROR_CODE_VALUES].sort()).toEqual(
      [
        "keil_action_failed",
        "keil_build_failed",
        "keil_erase_unavailable",
        "keil_error",
        "keil_not_debugging",
        "keil_not_installed",
        "keil_unsupported_action",
        "keil_verify_failed",
      ].sort(),
    );
    for (const code of KEIL_ERROR_CODE_VALUES) expect(code).toMatch(/^keil_[a-z_]+$/);
    // 一处定义：值互不重复。
    expect(new Set(KEIL_ERROR_CODE_VALUES).size).toBe(KEIL_ERROR_CODE_VALUES.length);
  });
});

describe("keil 失败结果带 code", () => {
  it("未安装 MDK：code 是 keil_not_installed，文案原样保留", async () => {
    setUv4PathForTest(null);

    const result = await debug.handler({ action: "open" });

    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe(KEIL_ERROR_CODES.notInstalled);
    expect((result.content[0] as { text: string }).text).toContain("Keil MDK is not installed");
  });

  it("keil_debug 的未知动作：code 是 keil_unsupported_action", async () => {
    installSession(projectPath, () => null);

    const result = await debug.handler({ action: "not_a_keil_action", project: projectPath });

    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe(KEIL_ERROR_CODES.unsupportedAction);
    expect((result.content[0] as { text: string }).text).toContain("unknown action");
  });

  it("keil_project 的未知动作：code 同样是 keil_unsupported_action", async () => {
    installSession(projectPath, () => null, { debugging: false });

    // `keil_project` runs on the plain session (port 4824 by default); the
    // registered fake session lives on 4823, so name the port.
    const result = await project.handler({ action: "not_a_project_action", project: projectPath, port: 4823 });

    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe(KEIL_ERROR_CODES.unsupportedAction);
  });

  it("会话存在但没进调试态：code 是 keil_not_debugging", async () => {
    installSession(projectPath, () => null, { debugging: false });

    const result = await debug.handler({ action: "registers", project: projectPath });

    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe(KEIL_ERROR_CODES.notDebugging);
    expect((result.content[0] as { text: string }).text).toContain("not in debug mode");
  });

  it("整片擦除不可用：code 是 keil_erase_unavailable", async () => {
    installSession(projectPath, (command) =>
      command === OP.PRJ_FLASH_ERASE
        ? { status: 29, statusName: "TIMEOUT", ok: false, data: Buffer.alloc(0), timedOut: true }
        : null,
    );

    const result = await debug.handler({ action: "erase", project: projectPath, port: 4823 });

    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe(KEIL_ERROR_CODES.eraseUnavailable);
  });

  it("构建失败：code 是 keil_build_failed", async () => {
    installSession(projectPath, (command) =>
      command === OP.PRJ_BUILD
        ? { status: 3, statusName: "FAILED", ok: false, data: Buffer.alloc(0), message: "3 errors" }
        : null,
      { debugging: false },
    );

    const result = await debug.handler({ action: "build", project: projectPath, port: 4823 });

    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe(KEIL_ERROR_CODES.buildFailed);
    expect((result.content[0] as { text: string }).text).toContain("uVision build code 3");
  });

  it("其余失败路径的兜底码是 keil_action_failed（读内存失败这一条）", async () => {
    installSession(projectPath, (command) =>
      command === OP.DBG_MEM_READ
        ? { status: 5, statusName: "NOT_DEBUGGING", ok: false, data: Buffer.alloc(0), message: "NOT_DEBUGGING" }
        : null,
    );

    const result = await debug.handler({ action: "read", project: projectPath, address: 0x20000000 });

    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe(KEIL_ERROR_CODES.actionFailed);
  });

  it("兜底覆盖提前 return 的参数错误：code 也非空且是词表里的值", async () => {
    installSession(projectPath, () => null);

    const result = await debug.handler({ action: "run_to", project: projectPath });

    expect(result.isError).toBe(true);
    expect(KEIL_ERROR_CODE_VALUES).toContain(structured(result).code);
  });
});
