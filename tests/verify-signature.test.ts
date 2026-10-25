import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  VerifySignatureError,
  formatResult,
  inspectFile,
  isPeFile,
  parseArgs,
  readSecurityDirectory,
} from "../scripts/verify-signature.mjs";

/**
 * `scripts/verify-signature.mjs` 的测试。
 *
 * **全部在 `mkdtemp` 临时目录里手工构造 PE 头**，不读真实 `.exe`、不触网、不调
 * 外部工具：真实产物有没有签名取决于打包机有没有证书，那与「解析逻辑对不对」是
 * 两件事，混在一起会让测试随机器变红。
 *
 * PE 布局（本文件构造的最小样本）：
 * ```
 * 0x00  "MZ" + DOS 头（0x3c 处放 e_lfanew = 0x40）
 * 0x40  "PE\0\0"
 * 0x44  COFF 头 20 字节（偏移 16 = SizeOfOptionalHeader）
 * 0x58  可选头：Magic(2) ... NumberOfRvaAndSizes(4) ... 数据目录(16 项 × 8 字节)
 * ```
 * 可选头用规范里的最小尺寸（PE32 = 224、PE32+ = 240），并把
 * `NumberOfRvaAndSizes` 设 16（真实 Windows 产物的值）。
 */

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "verify-signature.mjs");

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eam-verify-sig-"));
  tempDirs.push(dir);
  return dir;
}

type PeOptions = {
  /** PE32 或 PE32+。默认 PE32+（x64 产物就是它）。 */
  peType?: "PE32" | "PE32+";
  /** Security Directory 的 Size；>0 即「已签名」。 */
  securitySize?: number;
  /** Security Directory 的 VirtualAddress（就是证书表的文件偏移）。 */
  securityOffset?: number;
  /** 可选头里的 NumberOfRvaAndSizes；默认 16。 */
  numberOfRvaAndSizes?: number;
  /** 覆盖 SizeOfOptionalHeader，用来造「头自相矛盾」的坏文件。 */
  sizeOfOptionalHeaderOverride?: number;
};

/**
 * 手工拼一个最小 PE 头。返回的是**完整文件内容**（头部 + 尾部填充字节），
 * 尾部长度足以覆盖宣称的证书表范围。
 */
function buildPe(options: PeOptions = {}): Buffer {
  const {
    peType = "PE32+",
    securitySize = 0,
    securityOffset = 0,
    numberOfRvaAndSizes = 16,
    sizeOfOptionalHeaderOverride,
  } = options;

  const PE_OFFSET = 0x40;
  const COFF_OFFSET = PE_OFFSET + 4;
  const OPTIONAL_OFFSET = COFF_OFFSET + 20;
  const isPe32Plus = peType === "PE32+";
  // 规范里可选头的标准长度：PE32 = 224 字节，PE32+ = 240 字节。
  const optionalHeaderSize = isPe32Plus ? 240 : 224;
  const sizeOfOptionalHeader = sizeOfOptionalHeaderOverride ?? optionalHeaderSize;

  const numberOfRvaAndSizesOffset = isPe32Plus ? 108 : 92;
  const dataDirectoryOffset = isPe32Plus ? 112 : 96;

  const headerEnd = OPTIONAL_OFFSET + Math.max(sizeOfOptionalHeader, dataDirectoryOffset + 8);
  // 给证书表留位置：声明了 size 就要让 offset + size 落在文件里，否则测的是「文件损坏」。
  const tail = securitySize > 0 ? securityOffset + securitySize : 0;
  const totalSize = Math.max(headerEnd, tail, 0x200);

  const buf = Buffer.alloc(totalSize);
  buf[0] = 0x4d; // MZ
  buf[1] = 0x5a;
  buf.writeUInt32LE(PE_OFFSET, 0x3c); // e_lfanew
  buf.writeUInt32LE(0x00004550, PE_OFFSET); // "PE\0\0"

  // COFF 头：Machine(2) NumberOfSections(2) TimeDateStamp(4) PointerToSymbolTable(4)
  // NumberOfSymbols(4) SizeOfOptionalHeader(2) Characteristics(2)
  buf.writeUInt16LE(isPe32Plus ? 0x8664 : 0x014c, COFF_OFFSET); // x64 / i386
  buf.writeUInt16LE(sizeOfOptionalHeader, COFF_OFFSET + 16);

  buf.writeUInt16LE(isPe32Plus ? 0x20b : 0x10b, OPTIONAL_OFFSET); // Magic
  buf.writeUInt32LE(numberOfRvaAndSizes, OPTIONAL_OFFSET + numberOfRvaAndSizesOffset);

  // 数据目录第 4 项 = Security Directory（VirtualAddress 4 + Size 4）。
  const securityEntry = OPTIONAL_OFFSET + dataDirectoryOffset + 4 * 8;
  buf.writeUInt32LE(securityOffset, securityEntry);
  buf.writeUInt32LE(securitySize, securityEntry + 4);

  // 证书表位置写点标记字节，便于肉眼确认偏移算对了。
  if (securitySize > 0) {
    buf.fill(0xab, securityOffset, securityOffset + securitySize);
  }
  return buf;
}

async function writeTempFile(dir: string, name: string, content: Buffer | string) {
  const file = path.join(dir, name);
  await writeFile(file, content);
  return file;
}

describe("isPeFile", () => {
  it("认出手工构造的 PE32 与 PE32+", () => {
    expect(isPeFile(buildPe({ peType: "PE32" }))).toBe(true);
    expect(isPeFile(buildPe({ peType: "PE32+" }))).toBe(true);
  });

  it("随机字节不是 PE", () => {
    const random = Buffer.from([0x13, 0x37, 0x00, 0xff, 0x42, 0x99, 0x7c, 0x21]);
    expect(isPeFile(random)).toBe(false);
    expect(isPeFile(Buffer.alloc(1024, 0x41))).toBe(false);
  });

  it("有 MZ 但 e_lfanew 处不是 PE 签名 → 不是 PE", () => {
    const buf = buildPe();
    buf.writeUInt32LE(0xdeadbeef, 0x40);
    expect(isPeFile(buf)).toBe(false);
  });

  it("只有 MZ 头、长度不够读完 e_lfanew → 不是 PE（不抛错）", () => {
    const buf = Buffer.alloc(8);
    buf[0] = 0x4d;
    buf[1] = 0x5a;
    expect(isPeFile(buf)).toBe(false);
  });

  it("e_lfanew 指向文件外 → 不是 PE", () => {
    const buf = buildPe();
    buf.writeUInt32LE(0xfffffff0, 0x3c);
    expect(isPeFile(buf)).toBe(false);
  });
});

describe("readSecurityDirectory", () => {
  it("size > 0 → 已签名，并报出证书表偏移与 PE 类型", () => {
    const buf = buildPe({ peType: "PE32+", securitySize: 0x4c0, securityOffset: 0x400 });
    const result = readSecurityDirectory(buf);

    expect(result.signed).toBe(true);
    expect(result.size).toBe(0x4c0);
    expect(result.peType).toBe("PE32+");
    expect(result.certificateTableOffset).toBe(0x400);
    expect(result.numberOfRvaAndSizes).toBe(16);
    expect(result.peHeaderOffset).toBe(0x40);
    expect(result.sizeOfOptionalHeader).toBe(240);
  });

  it("size = 0 → 未签名，证书表偏移归零", () => {
    const buf = buildPe({ securitySize: 0 });
    const result = readSecurityDirectory(buf);

    expect(result.signed).toBe(false);
    expect(result.size).toBe(0);
    expect(result.certificateTableOffset).toBe(0);
  });

  it("PE32 走另一套可选头偏移（NumberOfRvaAndSizes 在 92、目录在 96）", () => {
    const buf = buildPe({ peType: "PE32", securitySize: 0x100, securityOffset: 0x200 });
    const result = readSecurityDirectory(buf);

    expect(result.peType).toBe("PE32");
    expect(result.signed).toBe(true);
    expect(result.certificateTableOffset).toBe(0x200);
    expect(result.sizeOfOptionalHeader).toBe(224);
  });

  it("NumberOfRvaAndSizes 不足 5 项 → 一定未签名（没有这一项目录）", () => {
    // 即使把 size 字段写成非零，目录项不存在就不该被读到。
    const buf = buildPe({ numberOfRvaAndSizes: 4, securitySize: 0x80, securityOffset: 0x200 });
    const result = readSecurityDirectory(buf);

    expect(result.signed).toBe(false);
    expect(result.size).toBe(0);
    expect(result.numberOfRvaAndSizes).toBe(4);
  });

  it("没有 MZ 头 → 抛 VerifySignatureError（exitCode 2），不静默返回「未签名」", () => {
    const buf = Buffer.alloc(1024, 0x41);
    expect(() => readSecurityDirectory(buf)).toThrow(VerifySignatureError);
    try {
      readSecurityDirectory(buf);
      expect.unreachable("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(VerifySignatureError);
      expect((error as VerifySignatureError).exitCode).toBe(2);
      expect((error as Error).message).toContain("不是 PE 文件");
    }
  });

  it("可选头 Magic 既不是 0x10b 也不是 0x20b → 抛错", () => {
    const buf = buildPe();
    buf.writeUInt16LE(0x107, 0x58);
    expect(() => readSecurityDirectory(buf)).toThrow(/未知的可选头 Magic/);
  });

  it("头自相矛盾（声明有 Security Directory 但可选头装不下）→ 抛错，而不是报未签名", () => {
    // PE32 的 Security Directory 需要可选头至少到偏移 96 + 8 = 104。
    const buf = buildPe({ peType: "PE32", sizeOfOptionalHeaderOverride: 100 });
    expect(() => readSecurityDirectory(buf)).toThrow(/PE 头自相矛盾/);
  });

  it("缓冲区被截断在数据目录之前 → 抛错", () => {
    const full = buildPe();
    // 截到可选头中间：PE32+ 的 NumberOfRvaAndSizes 在 0x58+108 = 0xc4。
    const cutoff = 0x58 + 108;
    const truncated = full.subarray(0, cutoff);
    expect(() => readSecurityDirectory(truncated)).toThrow(/PE 可选头被截断/);
  });
});

describe("inspectFile", () => {
  it("已签名文件 → signed 且证书表落在文件内", async () => {
    const dir = await tempRoot();
    const file = await writeTempFile(
      dir,
      "signed.exe",
      buildPe({ securitySize: 0x300, securityOffset: 0x400 }),
    );

    const info = await inspectFile(file);
    expect(info.signed).toBe(true);
    expect(info.size).toBe(0x300);
    expect(info.peType).toBe("PE32+");
    expect(info.certificateTableWithinFile).toBe(true);
    // 证书表就挂在文件末尾（真实签名产物也是如此），所以是「不超过」而不是「小于」文件尾。
    expect(info.fileSize).toBeGreaterThanOrEqual(info.certificateTableOffset + info.size);
  });

  it("未签名文件 → signed false", async () => {
    const dir = await tempRoot();
    const file = await writeTempFile(dir, "unsigned.exe", buildPe());
    const info = await inspectFile(file);
    expect(info.signed).toBe(false);
    expect(info.size).toBe(0);
  });

  it("文件不存在 → 抛 VerifySignatureError，消息点名该文件", async () => {
    const dir = await tempRoot();
    const missing = path.join(dir, "nope.exe");
    await expect(inspectFile(missing)).rejects.toBeInstanceOf(VerifySignatureError);
    await expect(inspectFile(missing)).rejects.toThrow(/无法访问/);
    await expect(inspectFile(missing)).rejects.toThrow(/nope\.exe/);
  });

  it("不是 PE → 抛 VerifySignatureError（exitCode 2）", async () => {
    const dir = await tempRoot();
    const file = await writeTempFile(dir, "not-pe.bin", Buffer.alloc(4096, 0x5a));
    try {
      await inspectFile(file);
      expect.unreachable("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(VerifySignatureError);
      expect((error as VerifySignatureError).exitCode).toBe(2);
    }
  });

  it("过小的文件 → 抛错，而不是报未签名", async () => {
    const dir = await tempRoot();
    const file = await writeTempFile(dir, "tiny.bin", Buffer.from([0x4d, 0x5a, 0x00]));
    await expect(inspectFile(file)).rejects.toThrow(/不是 PE 文件/);
  });

  it("目录而不是文件 → 抛错", async () => {
    const dir = await tempRoot();
    await expect(inspectFile(dir)).rejects.toThrow(/不是普通文件/);
  });
});

describe("parseArgs", () => {
  it("收集多个文件路径", () => {
    expect(parseArgs(["a.exe", "b.dll"])).toEqual({ help: false, files: ["a.exe", "b.dll"] });
  });

  it("--help / -h 优先于其他参数", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["-h"])).toEqual({ help: true });
    expect(parseArgs(["a.exe", "--help"])).toEqual({ help: true });
  });

  it("没有文件 → 用法错误（exitCode 2）", () => {
    try {
      parseArgs([]);
      expect.unreachable("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(VerifySignatureError);
      expect((error as VerifySignatureError).exitCode).toBe(2);
    }
  });

  it("未知选项 → 用法错误", () => {
    expect(() => parseArgs(["--verbose", "a.exe"])).toThrow(/未知选项/);
  });
});

describe("formatResult", () => {
  it("已签名输出证书表偏移并声明未验证有效性", async () => {
    const dir = await tempRoot();
    const file = await writeTempFile(dir, "s.exe", buildPe({ securitySize: 0x200, securityOffset: 0x300 }));
    const text = formatResult(await inspectFile(file));
    expect(text).toContain("[已签名]");
    expect(text).toContain("0x300");
    expect(text).toContain("未验证签名有效性");
  });

  it("未签名只说 size=0，不编造证书表位置", async () => {
    const dir = await tempRoot();
    const file = await writeTempFile(dir, "u.exe", buildPe());
    const text = formatResult(await inspectFile(file));
    expect(text).toContain("[未签名]");
    expect(text).toContain("size=0");
    expect(text).not.toContain("证书表:");
  });
});

describe("CLI 退出码", () => {
  /** 跑真实脚本，返回 stdout/stderr/exitCode；不抛错（execFile 抛错时也读出信息）。 */
  async function runCli(args: string[]) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT_PATH, ...args], {
        cwd: REPO_ROOT,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("全部已签名 → 退出码 0", async () => {
    const dir = await tempRoot();
    const file = await writeTempFile(dir, "signed.exe", buildPe({ securitySize: 0x200, securityOffset: 0x300 }));
    const { code, stdout } = await runCli([file]);
    expect(code).toBe(0);
    expect(stdout).toContain("1 已签名，0 未签名，0 无法检查");
  });

  it("未签名 → 退出码 1", async () => {
    const dir = await tempRoot();
    const file = await writeTempFile(dir, "unsigned.exe", buildPe());
    const { code, stdout } = await runCli([file]);
    expect(code).toBe(1);
    expect(stdout).toContain("0 已签名，1 未签名");
  });

  it("一签一未签 → 退出码 1（混合也不放行）", async () => {
    const dir = await tempRoot();
    const signed = await writeTempFile(dir, "signed.exe", buildPe({ securitySize: 0x200, securityOffset: 0x300 }));
    const unsigned = await writeTempFile(dir, "unsigned.exe", buildPe());
    const { code, stdout } = await runCli([signed, unsigned]);
    expect(code).toBe(1);
    expect(stdout).toContain("1 已签名，1 未签名，0 无法检查");
  });

  it("文件不存在 → 退出码 2，并在 stderr 点名文件", async () => {
    const dir = await tempRoot();
    const missing = path.join(dir, "ghost.exe");
    const { code, stderr } = await runCli([missing]);
    expect(code).toBe(2);
    expect(stderr).toContain("ghost.exe");
    expect(code).not.toBe(0);
  });

  it("不是 PE → 退出码 2", async () => {
    const dir = await tempRoot();
    const file = await writeTempFile(dir, "junk.bin", Buffer.alloc(512, 0x7e));
    const { code, stderr } = await runCli([file]);
    expect(code).toBe(2);
    expect(stderr).toContain("junk.bin");
  });

  it("没有参数 → 退出码 2 并打印用法", async () => {
    const { code, stderr } = await runCli([]);
    expect(code).toBe(2);
    expect(stderr).toContain("用法");
  });

  it("--help → 退出码 0 并打印用法", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("用法");
  });
});
