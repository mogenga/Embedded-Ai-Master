/**
 * `release.mjs` 的类型声明。
 *
 * 与 `corpus-stage.d.mts` / `runtime-deps.d.mts` 同一理由：脚本是纯 JS（`.mjs`），
 * 测试是 TypeScript；没有声明文件时 `tsc --noEmit` 报 TS7016（隐式 any），给本来
 * 就不该再加错误的 typecheck 增一条。
 *
 * **必须与 `release.mjs` 的实现保持同步**：改了那边的签名就改这里。
 * 声明只覆盖测试与 `--check` 实际用到的出口，不复制检查文案。
 */

export type CheckStatus = "ok" | "warn" | "fail";

export type CheckResult = {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
};

export const STATUS: { OK: "ok"; WARN: "warn"; FAIL: "fail" };

export const REPOSITORY: { owner: string; repo: string };
export const INSTALLER_DIR: string;
export const DEFAULT_ARTIFACT_NAME: string;
export const GH_CANDIDATES: string[];
export const USAGE: string;

export function checkVersion(value: unknown): {
  status: CheckStatus;
  version: string | null;
  detail: string;
};

export function checkPath(item: {
  label: string;
  dirPath: string;
  exists: boolean;
  entries: string[] | null;
  required?: boolean;
}): CheckResult;

export function checkPaths(
  items: Array<{
    label: string;
    dirPath: string;
    exists: boolean;
    entries: string[] | null;
    required?: boolean;
  }>,
): CheckResult[];

export function findInstallers(entries: string[] | null): string[];

export function checkInstaller(input: {
  entries: string[] | null;
  dirPath: string;
}): CheckResult;

export function githubSafeArtifactName(fileName: string): string;

export function checkArtifactName(installers: string[]): CheckResult;

export function checkGitClean(porcelainOutput: string | null): CheckResult;

export function checkTag(input: {
  headTags: string[] | null;
  plannedTag: string;
}): CheckResult;

export function checkGhCli(input: {
  found: boolean;
  executable: string | null;
  authenticated: boolean;
  account?: string | null;
}): CheckResult;

export function checkSignature(input: {
  scriptMissing: boolean;
  files: Array<{ file: string; signed: boolean; error?: string | null }>;
}): CheckResult;

export function aggregateExitCode(checks: Array<{ status: string }>): 0 | 1;

export function formatChecks(checks: Array<{ title: string; status: string; detail: string }>): string;

export function defaultTag(version: string): string;

export function checkTagArgument(tag: unknown): {
  status: CheckStatus;
  tag: string | null;
  detail: string;
};

export function expandArtifactName(input: {
  artifactName: string;
  version: string;
  ext: string;
}): string;

export function renderSteps(input: {
  version: string;
  tag: string;
  repoRoot?: string;
  artifactName?: string;
}): string;

export function scrubTokens(text: string): string;

export function pickAccount(stdout: string, stderr: string): string | null;

export function inspectDir(dirPath: string): Promise<{
  exists: boolean;
  entries: string[] | null;
}>;

export function detectGh(): Promise<{
  found: boolean;
  executable: string | null;
  authenticated: boolean;
  account: string | null;
  detail: string;
}>;

export function readDesktopVersion(repoRoot?: string): Promise<{
  version: unknown;
  path: string;
}>;

export function readDesktopArtifactName(repoRoot?: string): Promise<{
  artifactName: unknown;
  path: string;
}>;

export function runChecks(options?: {
  repoRoot?: string;
  tag?: string;
}): Promise<CheckResult[]>;

export function runCheckCommand(options?: {
  repoRoot?: string;
  tag?: string;
}): Promise<0 | 1>;

export function parseArgs(argv: string[]):
  | { help: true }
  | { help: false; check: boolean; tag: string | undefined };
