/**
 * `verify-signature.mjs` 的类型声明。
 *
 * 与 `corpus-stage.d.mts` / `runtime-deps.d.mts` 同一理由：脚本是纯 JS（`.mjs`），
 * 测试是 TypeScript；没有声明文件时 `tsc --noEmit` 报 TS7016（隐式 any），给本来
 * 就要求 0 错误的 typecheck 加一条。
 *
 * **必须与 `verify-signature.mjs` 的实现保持同步**：改了那边的签名就改这里。
 * 声明只覆盖测试与 CI 实际用到的出口。
 */

export type PeType = "PE32" | "PE32+";

export type SecurityDirectory = {
  peType: PeType;
  /** `size > 0` ⇔ 文件末尾挂着证书表。 */
  signed: boolean;
  /** Security Directory 的 Size 字段。 */
  size: number;
  /** 证书表的文件偏移（Security Directory 的 VirtualAddress 就是文件偏移，不是 RVA）。未签名时为 0。 */
  certificateTableOffset: number;
  numberOfRvaAndSizes: number;
  peHeaderOffset: number;
  sizeOfOptionalHeader: number;
};

export type FileInspection = SecurityDirectory & {
  file: string;
  fileSize: number;
  /** 证书表声称的范围是否落在文件内；未签名时恒为 true。 */
  certificateTableWithinFile: boolean;
};

export type ParsedVerifyArgs = { help: true } | { help: false; files: string[] };

export class VerifySignatureError extends Error {
  constructor(message: string, options?: { exitCode?: number; cause?: unknown });
  /** 2 = 无法检查（文件不存在 / 不是 PE / 读取失败），1 = 内部误用。 */
  exitCode: number;
}

export const USAGE: string;
export const MAX_HEADER_BYTES: number;

export function isPeFile(buf: Buffer): boolean;
export function readSecurityDirectory(buf: Buffer): SecurityDirectory;
export function inspectFile(filePath: string): Promise<FileInspection>;
export function parseArgs(argv: string[]): ParsedVerifyArgs;
export function formatResult(info: FileInspection): string;
