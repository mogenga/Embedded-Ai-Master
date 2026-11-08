import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIAGNOSTIC_LIMIT, buildDiagnostics, collapseCascades, parseDiagnostics } from "../diagnostics.js";
import { createKeilTools } from "../tools.js";
import {
  registerSessionForTest,
  resetSessionsForTest,
  setUv4PathForTest,
  type KeilSession,
} from "../keilSession.js";
import { OP, type AsyncFrame, type Reply } from "../uvsock.js";

/**
 * 构建诊断的结构化解析（D-200）。
 *
 * **这些用例断言的是解析器对 ARMCC / ARMCLANG / armlink 文档化输出格式的处理，
 * 不是在真实 UV4 工程上验证过的行为**：本机没有可用的 Keil，仓库里也没有一份
 * 真实构建日志。样本行按厂商文档的形状手写，不是抓包。
 *
 * 纯函数部分零 I/O；最后一组用注入的假会话走真实 `keil_debug` handler，
 * 不连 4823、不启动 UV4。
 */

const severities = (log: string) => parseDiagnostics(log).map((entry) => entry.severity);

describe("parseDiagnostics：编译器诊断", () => {
  it("ARMCC 的 `error: #20`：文件、行号、级别、码、正文全部落位", () => {
    const line = '..\\USER\\main.c(36): error:  #20: identifier "HAL_Init" is undefined';

    const [diagnostic] = parseDiagnostics(line);

    expect(diagnostic).toEqual({
      file: "../USER/main.c",
      line: 36,
      severity: "error",
      code: "#20",
      message: 'identifier "HAL_Init" is undefined',
      raw: line,
    });
  });

  it("ARMCLANG 的 `warning: #177-D`：级别是 warning，码保留 -D 后缀", () => {
    const [diagnostic] = parseDiagnostics(
      '..\\USER\\main.c(36): warning:  #177-D: variable "x" was declared but never referenced',
    );

    expect(diagnostic.severity).toBe("warning");
    expect(diagnostic.code).toBe("#177-D");
    expect(diagnostic.file).toBe("../USER/main.c");
    expect(diagnostic.line).toBe(36);
  });

  it("反斜杠路径归一为 `/`，与 parseFileLine 一致；消息里的冒号不截断正文", () => {
    const [diagnostic] = parseDiagnostics(
      '..\\USER\\app.c(12): error:  #5: cannot open source input file "foo.h": No such file or directory',
    );

    expect(diagnostic.file).toBe("../USER/app.c");
    expect(diagnostic.line).toBe(12);
    expect(diagnostic.code).toBe("#5");
    expect(diagnostic.message).toBe('cannot open source input file "foo.h": No such file or directory');
  });

  it("`file:line` 写法同样认，行号不会被前缀吃掉", () => {
    const [diagnostic] = parseDiagnostics('..\\HAL\\drivers\\gpio.c:44: error:  #20: identifier "x" is undefined');

    expect(diagnostic.file).toBe("../HAL/drivers/gpio.c");
    expect(diagnostic.line).toBe(44);
  });

  it("`file:line:col` 取行号、不把列号当行号", () => {
    const [diagnostic] = parseDiagnostics("src/main.c:36:12: error: use of undeclared identifier 'HAL_Init'");

    expect(diagnostic.file).toBe("src/main.c");
    expect(diagnostic.line).toBe(36);
    expect(diagnostic.code).toBeUndefined();
    expect(diagnostic.message).toBe("use of undeclared identifier 'HAL_Init'");
  });

  it("盘符绝对路径里的冒号不会被当成行号分隔符", () => {
    for (const [line, expected] of [
      ["C:\\proj\\USER\\main.c(36): error:  #20: boom", { file: "C:/proj/USER/main.c", line: 36 }],
      ["C:\\proj\\USER\\main.c:36: error:  #20: boom", { file: "C:/proj/USER/main.c", line: 36 }],
      ["C:\\proj\\main.c:36:5: error: boom", { file: "C:/proj/main.c", line: 36 }],
    ] as const) {
      const [diagnostic] = parseDiagnostics(line);
      expect({ file: diagnostic!.file, line: diagnostic!.line }, line).toEqual(expected);
    }
  });
});

describe("parseDiagnostics：链接器诊断", () => {
  it("裸 `Error: L6218E` 不回填文件", () => {
    const [diagnostic] = parseDiagnostics("Error: L6218E: Undefined symbol HAL_Init (referred from main.o).");

    expect(diagnostic).toEqual({
      severity: "error",
      code: "L6218E",
      message: "Undefined symbol HAL_Init (referred from main.o).",
      raw: "Error: L6218E: Undefined symbol HAL_Init (referred from main.o).",
    });
  });

  it("带镜像前缀的 `Error: L6218E` 前缀进 raw，不进 file", () => {
    const line = ".\\Objects\\demo.axf: Error: L6218E: Undefined symbol foo (referred from bar.o).";

    const [diagnostic] = parseDiagnostics(line);

    expect(diagnostic.code).toBe("L6218E");
    expect(diagnostic.message).toBe("Undefined symbol foo (referred from bar.o).");
    expect(diagnostic.file).toBeUndefined();
    expect(diagnostic.raw).toBe(line);
  });

  it("链接器 warning 记为 warning", () => {
    const [diagnostic] = parseDiagnostics("Warning: L6329W: Pattern *(.text) not covered by any section.");

    expect(diagnostic.severity).toBe("warning");
    expect(diagnostic.code).toBe("L6329W");
  });
});

describe("parseDiagnostics：不误报", () => {
  it("`Build target` / `Program Size` 等非诊断行不进结果，也不影响相邻诊断", () => {
    const log = [
      'Build target \'DEMO\'',
      'assembling startup_stm32f4xx.s...',
      '.\\Objects\\demo.axf: Error: L6218E: Undefined symbol foo (referred from bar.o).',
      "Program Size: Code=31978 RO-data=18842 RW-data=108 ZI-data=2050364",
      '".\\Objects\\demo.axf" - 1 Error(s), 0 Warning(s).',
    ].join("\n");

    const diagnostics = parseDiagnostics(log);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("L6218E");
  });

  it("空日志与纯噪声都返回 []，不抛错", () => {
    expect(parseDiagnostics("")).toEqual([]);
    expect(parseDiagnostics("Build started.\nProgram Size: Code=0\n\n   \n")).toEqual([]);
  });

  it("行首锚定：消息正文里出现的 `file(line)` 不算第二条诊断", () => {
    const log =
      '..\\USER\\app.c(12): error:  #5: cannot open source input file "..\\HAL\\drivers\\gpio.c(45)": No such file or directory';

    const diagnostics = parseDiagnostics(log);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.file).toBe("../USER/app.c");
    expect(diagnostics[0]!.code).toBe("#5");
  });

  it("只有裸 `file(line)`、没有级别的行不猜", () => {
    expect(parseDiagnostics("..\\USER\\main.c(36):")).toEqual([]);
    expect(parseDiagnostics("see ..\\USER\\main.c(36): error:  #20: boom")).toEqual([]);
  });

  it("构建收尾的 `N Error(s), M Warning(s)` 汇总行不是诊断", () => {
    expect(parseDiagnostics('".\\Objects\\demo.axf" - 2 Error(s), 1 Warning(s).')).toEqual([]);
    expect(parseDiagnostics("Build Time Elapsed:  00:00:02")).toEqual([]);
  });

  it("没有位置的编译器错误（`Fatal error: #5:`）也认，code 保留", () => {
    const [diagnostic] = parseDiagnostics("Fatal error: #5: cannot open source input file 'foo.h'");

    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.code).toBe("#5");
    expect(diagnostic.file).toBeUndefined();
    expect(diagnostic.message).toBe("cannot open source input file 'foo.h'");
  });
});

describe("collapseCascades", () => {
  it("同一根因引起的 3 条 L6218E：折叠成 1 条，collapsed === 2", () => {
    const log = [
      "Error: L6218E: Undefined symbol HAL_Init (referred from main.o).",
      "Error: L6218E: Undefined symbol HAL_Init (referred from app.o).",
      "Error: L6218E: Undefined symbol HAL_Init (referred from isr.o).",
    ].join("\n");

    const result = collapseCascades(parseDiagnostics(log));

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message).toBe("Undefined symbol HAL_Init (referred from main.o).");
    expect(result.collapsed).toBe(2);
  });

  it("不同符号的 L6218E 各自保留", () => {
    const log = [
      "Error: L6218E: Undefined symbol HAL_Init (referred from main.o).",
      "Error: L6218E: Undefined symbol SystemClock_Config (referred from app.o).",
    ].join("\n");

    const result = collapseCascades(parseDiagnostics(log));

    expect(result.diagnostics).toHaveLength(2);
    expect(result.collapsed).toBe(0);
  });

  it("编译器错误一律不折叠：3 条编译器错误仍是 3 条", () => {
    const log = [
      '..\\USER\\main.c(36): error:  #20: identifier "HAL_Init" is undefined',
      '..\\USER\\main.c(36): error:  #20: identifier "HAL_Init" is undefined',
      '..\\USER\\app.c(12): error:  #5: cannot open source input file "foo.h"',
    ].join("\n");

    const result = collapseCascades(parseDiagnostics(log));

    expect(result.diagnostics).toHaveLength(3);
    expect(result.collapsed).toBe(0);
  });

  it("编译器错误点名了同一符号时，链接错误折进那条编译器错误", () => {
    const log = [
      '..\\USER\\main.c(36): error:  #20: identifier "HAL_Init" is undefined',
      "Error: L6218E: Undefined symbol HAL_Init (referred from main.o).",
      "Error: L6218E: Undefined symbol HAL_Init (referred from app.o).",
    ].join("\n");

    const result = collapseCascades(parseDiagnostics(log));

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe("#20");
    expect(result.collapsed).toBe(2);
  });

  it("符号必须整词相等：HAL_Init2 不会被 HAL_Init 折叠", () => {
    const log = [
      '..\\USER\\main.c(36): error:  #20: identifier "HAL_Init2" is undefined',
      "Error: L6218E: Undefined symbol HAL_Init (referred from main.o).",
    ].join("\n");

    const result = collapseCascades(parseDiagnostics(log));

    expect(result.diagnostics).toHaveLength(2);
    expect(result.collapsed).toBe(0);
  });

  it("符号只以子串出现在别的问题里时不折叠：缺头文件 `foo.h` 不解释缺符号 `foo`", () => {
    const log = [
      '..\\USER\\app.c(12): error:  #5: cannot open source input file "foo.h": No such file or directory',
      "Error: L6218E: Undefined symbol foo (referred from bar.o).",
    ].join("\n");

    const result = collapseCascades(parseDiagnostics(log));

    expect(result.diagnostics).toHaveLength(2);
    expect(result.collapsed).toBe(0);
  });

  it("warning 不构成折叠依据（brief：与前面某条 error 的消息重复）", () => {
    const log = [
      '..\\USER\\main.c(36): warning:  #177-D: variable "HAL_Init" was declared but never referenced',
      "Error: L6218E: Undefined symbol HAL_Init (referred from main.o).",
    ].join("\n");

    const result = collapseCascades(parseDiagnostics(log));

    expect(result.diagnostics).toHaveLength(2);
    expect(result.collapsed).toBe(0);
  });

  it("编译器错误必须把符号放在引号里才算点名（#20 的形式）", () => {
    const log = [
      '..\\USER\\main.c(36): error:  #147-D: declaration is incompatible with "void HAL_Init(void)"',
      '..\\USER\\main.c(40): error:  #20: identifier "HAL_Init" is undefined',
      "Error: L6218E: Undefined symbol HAL_Init (referred from main.o).",
    ].join("\n");

    const result = collapseCascades(parseDiagnostics(log));

    // 第一条不是「点名这个符号缺失」，它自己也保留；第三条被第二条折掉。
    expect(result.diagnostics).toHaveLength(2);
    expect(result.collapsed).toBe(1);
  });
});

describe("buildDiagnostics", () => {
  it("多于 20 条时只列前 20 条，并说明还有几条", () => {
    const log = Array.from({ length: 25 }, (_, index) => `..\\USER\\f${index}.c(1): error:  #20: boom ${index}`).join("\n");

    const report = buildDiagnostics(log);

    expect(report.entries).toHaveLength(DIAGNOSTIC_LIMIT);
    expect(report.total).toBe(25);
    expect(report.detail).toContain("../USER/f19.c(1): error: #20: boom 19");
    expect(report.detail).not.toContain("f20.c");
    expect(report.detail).toContain("and 5 more");
  });

  it("detail 带汇总行与折叠数，链接错误的 `referred from` 原样保留", () => {
    const log = [
      "Error: L6218E: Undefined symbol HAL_Init (referred from main.o).",
      "Error: L6218E: Undefined symbol HAL_Init (referred from app.o).",
    ].join("\n");

    const report = buildDiagnostics(log);

    expect(report.collapsed).toBe(1);
    expect(report.total).toBe(1);
    expect(report.detail.split("\n")[0]).toContain("1 error");
    expect(report.detail.split("\n")[0]).toContain("folded");
    expect(report.detail).toContain("error: L6218E: Undefined symbol HAL_Init (referred from main.o).");
  });

  it("认不出任何诊断时不假装「没有错误」，明说日志里没有可解析的行", () => {
    const report = buildDiagnostics("Build started.\nBuild target 'DEMO'\n");

    expect(report.entries).toEqual([]);
    expect(report.total).toBe(0);
    expect(report.detail).toContain("no");
    expect(report.detail.toLowerCase()).toContain("log");
  });
});

describe("diagnostics.ts 的边界", () => {
  it("模块自身不读文件、不起子进程（零 I/O）", () => {
    const source = readFileSync("mcp-servers/keil/diagnostics.ts", "utf8");
    const imports = [...source.matchAll(/^import .*$/gm)].map((match) => match[0]);

    expect(imports.join("\n")).not.toMatch(/node:fs|node:child_process|node:os/);
    expect(source).not.toMatch(/\bspawn\(|\bexecFile\(|\breadFileSync\(/);
  });
});

describe("build 失败时 diagnostics 进内容与 structuredContent", () => {
  const tools = createKeilTools();
  const debug = tools.find((tool) => tool.name === "keil_debug")!;

  const BUILD_LINES = [
    '..\\USER\\main.c(36): error:  #20: identifier "HAL_Init" is undefined',
    ".\\Objects\\demo.axf: Error: L6218E: Undefined symbol HAL_Init (referred from main.o).",
    ".\\Objects\\demo.axf: Error: L6218E: Undefined symbol HAL_Init (referred from app.o).",
    "Build target 'DEMO'",
    "Program Size: Code=31978 RO-data=18842 RW-data=108 ZI-data=2050364",
  ];

  function frame(type: number, text?: string): AsyncFrame {
    // `0x5001` lines carry `{ u32 echoed, u32 status }` first; `0x5000` carries
    // the build code at offset 4 (see `buildInIde`).
    const data = Buffer.alloc(8);
    if (type === 0x5000) {
      data.writeUInt32LE(3, 4);
      return { type, echoed: 0, data, raw: data };
    }
    const body = Buffer.concat([data, Buffer.from(text ?? "", "latin1")]);
    return { type, echoed: 0, data: body, raw: body };
  }

  let dir: string;
  let projectPath: string;

  beforeEach(() => {
    resetSessionsForTest();
    setUv4PathForTest("C:/fake-keil/UV4/UV4.exe");
    dir = mkdtempSync(join(tmpdir(), "keil-diagnostics-"));
    projectPath = join(dir, "DEMO.uvprojx");
    writeFileSync(projectPath, "<Project/>", "utf8");
    const frames = [...BUILD_LINES.map((text) => frame(0x5001, text)), frame(0x5000)];
    const session: KeilSession = {
      client: {
        closed: false,
        mark: 0,
        since: () => frames,
        send: async (command: number): Promise<Reply> =>
          command === OP.PRJ_BUILD
            ? { status: 0, statusName: "SUCCESS", ok: true, data: Buffer.alloc(0) }
            : { status: 0, statusName: "SUCCESS", ok: true, data: Buffer.alloc(0) },
      } as unknown as KeilSession["client"],
      project: projectPath,
      debugging: false,
      target: "hardware",
      extended: false,
      openedAt: 0,
    };
    registerSessionForTest(session);
  });

  afterEach(() => {
    resetSessionsForTest();
    setUv4PathForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("失败：结构化诊断在前、日志尾部在后，两者都还在", async () => {
    const result = await debug.handler({ action: "build", project: projectPath, port: 4823 });
    const text = (result.content[0] as { text: string }).text;

    expect(result.isError).toBe(true);
    // 结构化那条在前：文件:行号已经归一，且不再需要调用方自己刮。
    expect(text).toContain("../USER/main.c(36): error: #20: identifier \"HAL_Init\" is undefined");
    expect(text.indexOf("../USER/main.c(36): error: #20")).toBeLessThan(text.indexOf("Build target 'DEMO'"));
    // 原有文案一个字没动。
    expect(text).toContain("the build failed (uVision build code 3)");
    // 原有日志尾部仍在。
    expect(text).toContain("Program Size: Code=31978");
  });

  it("失败：structuredContent 带同级的 buildDiagnostics，code 仍是 keil_build_failed", async () => {
    const result = await debug.handler({ action: "build", project: projectPath, port: 4823 });
    const structured = result.structuredContent as {
      code?: string;
      buildDiagnostics?: { entries: unknown[]; total: number; collapsed: number };
    };

    expect(structured.code).toBe("keil_build_failed");
    expect(structured.buildDiagnostics).toBeDefined();
    // 两条 L6218E 都点名 HAL_Init，已被那条 `#20` 折掉。
    expect(structured.buildDiagnostics!.total).toBe(1);
    expect(structured.buildDiagnostics!.collapsed).toBe(2);
    expect(structured.buildDiagnostics!.entries).toHaveLength(1);
  });
});
