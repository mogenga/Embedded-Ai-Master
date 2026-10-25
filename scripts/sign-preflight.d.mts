/**
 * `sign-preflight.mjs` 的类型声明。
 *
 * 与 `verify-signature.d.mts` / `corpus-stage.d.mts` 同一理由：脚本是纯 JS（`.mjs`），
 * 测试是 TypeScript；没有声明文件时 `tsc --noEmit` 报 TS7016（隐式 any）。
 *
 * **必须与 `sign-preflight.mjs` 的实现保持同步**：改了那边的签名就改这里。
 * 声明只覆盖测试与 CLI 实际用到的出口。
 */

export type CertificateRecord = {
  Subject?: string | null;
  PSParentPath?: string | null;
  Thumbprint?: string | null;
  HasPrivateKey?: boolean | null;
  NotAfter?: string | Date | null;
};

export type DescribedCert = {
  subject: string;
  /** 完整 DN 里的 CN；取不到为 `null`。 */
  commonName: string | null;
  /** 大写指纹。 */
  thumbprint: string;
  /** `PSParentPath` 最后一段（`My` / `CA` / `Root` …）；取不到为 `null`。 */
  store: string | null;
  isLocalMachineStore: boolean;
  hasPrivateKey: boolean;
  /** 毫秒时间戳；认不出为 `null`。 */
  notAfter: number | null;
  /** `null` = 不知道（不是「没过期」）。 */
  expired: boolean | null;
};

export type Selection =
  | { kind: "selected"; cert: DescribedCert }
  | { kind: "no-selector"; candidates: DescribedCert[] }
  | { kind: "not-found"; candidates: DescribedCert[]; wanted: string }
  | { kind: "ambiguous"; candidates: DescribedCert[]; wanted: string };

export type Assessment = { ok: boolean; problems: string[] };

export type SigntoolInfo = {
  path: string | null;
  from: string;
  tried?: string;
};

export type TimestampProbe = { url: string; reachable: boolean; detail: string };

export type Summary = { ok: boolean; lines: string[]; cert?: DescribedCert };

export type ParsedSignArgs = {
  help: boolean;
  subjectName: string | null;
  sha1: string | null;
  checkTimestamp: boolean;
  json: boolean;
};

export class SignPreflightError extends Error {
  constructor(message: string, options?: { exitCode?: number; cause?: unknown });
  /** 2 = 无法检查（非 Windows / PowerShell 失败 / 参数错误），1 = 内部误用。 */
  exitCode: number;
}

export const USAGE: string;
export const CERT_QUERY: string;
export const DEFAULT_TIMESTAMP_SERVER: string;
export const WINDOWS_PS51_MODULES: string;

export function normalizeCertList(raw: string): CertificateRecord[];
export function extractCommonName(subject: string): string | null;
export function storeNameOf(parentPath: string): string | null;
export function isLocalMachineStore(parentPath: string): boolean;
export function describeCert(record: CertificateRecord, now?: number): DescribedCert;
export function parsePowerShellDate(value: unknown): number | null;
export function selectSigningCert(
  certs: DescribedCert[],
  options?: { subjectName?: string | null; sha1?: string | null },
): Selection;
export function assessCertificate(cert: DescribedCert, now?: number): Assessment;
export function buildSigningCommand(cert: DescribedCert): {
  signtoolOptions: { certificateSha1: string; certificateSubjectName: string | null };
  command: string;
};
export function looksLikeModulePathProblem(message: string): boolean;
export function resolvePowershell(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ path: string; kind: "pwsh" | "windows-powershell" }>;
export function queryCertificates(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ stdout: string; shell: "pwsh" | "windows-powershell" }>;
export function findSigntool(options?: { platform?: string }): Promise<SigntoolInfo>;
export function probeTimestampServer(
  url: string,
  options?: { timeoutMs?: number },
): Promise<TimestampProbe>;
export function summarize(input: {
  certs: DescribedCert[];
  selection: Selection;
  assessment: Assessment;
  signtool: SigntoolInfo;
  timestamp?: TimestampProbe | null;
}): Summary;
export function parseArgs(argv: string[]): ParsedSignArgs;
