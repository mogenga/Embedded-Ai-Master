#!/usr/bin/env node
/**
 * 发布前检查 + 发布步骤打印。发布渠道是 **GitHub Releases**。
 *
 * ## 这个脚本做什么、不做什么
 *
 * **不做**：不执行任何 git 写操作（`add` / `commit` / `push` / `tag` / `checkout` /
 * `stash` / `reset` 一律没有），不执行 `electron-builder`，不调用 GitHub API，
 * 不创建 release，不碰网络。它只把「要敲的命令」打印出来，由人去敲。
 *
 * **`--check` 模式**会做几个**只读探针**，因为这几项检查的定义就是「问一问当前
 * 状态」，不看不出来：`git status --porcelain`（工作区是否干净）、
 * `git tag --points-at HEAD`（HEAD 有没有 tag）、`gh auth status`（gh 是否登录）。
 * 这三条都是只读命令，不改任何东西；它们通过 `spawn` 执行，且**只在 `--check`
 * 模式下执行**。默认（打印步骤）模式不 spawn 任何进程。
 *
 * 为什么要单独说明：AGENTS.md 允许只读的 `git status` / `git log` / `git diff`，
 * 禁止写操作。本文件把这条边界写进代码，而不是靠「记得别写」。
 *
 * ## 为什么还要「打印命令」而不是一条命令做完
 *
 * 发布是不可逆动作（tag 推上去、release 公开出去就收不回）。把命令打印出来让人
 * 逐条执行，比让一个脚本替你决定「现在可以发了」要安全。脚本的价值在两处：
 * 前置检查拦住「发了但包是坏的」，以及把容易漏的参数（tag 名、三个附件的文件名）
 * 拼对。
 *
 * ## 退出码
 *
 * - 0：`--check` 全部通过（`warn` 不算失败，它是「还没到那一步」的提示）
 * - 1：任一检查 FAIL，或脚本自身用错了（读不到 `desktop/package.json` 等）
 *
 * 无依赖，只用 `node:*`。
 */

import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");

/** 发布目标。与 `desktop/package.json` 的 `build.publish` 保持一致。 */
export const REPOSITORY = { owner: "mogenga", repo: "Embedded-Ai-Master" };

export const USAGE = `用法: node scripts/release.mjs [--check] [--tag <tag>]

  --check      只做前置检查，逐项报告 OK / WARN / FAIL，不打印发布步骤
  --tag <tag>  指定 tag 名；默认由 desktop/package.json 的 version 推出（v0.1.0）
  --help, -h   显示本说明

不带 --check 时打印完整发布步骤（可直接复制的命令）。

退出码: 0 = 全部通过 / 1 = 任一 FAIL 或脚本用错。

注意: 本脚本不执行任何 git 写操作、不跑 electron-builder、不调 GitHub API。
      --check 会运行三条只读探针: git status --porcelain、git tag --points-at HEAD、
      gh auth status。
`;

/** 安装包输出目录（`desktop/package.json` 的 `build.directories.output`）。 */
export const INSTALLER_DIR = "desktop/dist-installer";

/**
 * `desktop/package.json` 的 `build.win.artifactName` 的当前值。
 *
 * 只作为 `renderSteps` 的**默认参数**存在（让只传 version/tag 的旧调用方继续可用）。
 * 打印步骤的真实来源是 `main()` 从 `desktop/package.json` 读到的值；
 * `tests/release-check.test.ts` 有一条断言钉住二者相等——改了配置却忘了这里会红。
 */
export const DEFAULT_ARTIFACT_NAME = "Embedded-AI-Master-Setup-${version}.${ext}";

/**
 * `gh` 的候选位置。
 *
 * 为什么要列候选：Windows 的 GUI 安装器（winget / msi）不保证把 `GitHub CLI`
 * 目录加进 `PATH`。本机实测就是这个情况 —— `which gh` 空，但
 * `C:\Program Files\GitHub CLI\gh.exe` 存在且已登录。只试 `gh` 会误报「未安装」，
 * 那是不诚实的（R3）。
 */
export const GH_CANDIDATES = [
  "gh",
  ...(process.platform === "win32"
    ? [
        "C:\\Program Files\\GitHub CLI\\gh.exe",
        "C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
      ]
    : ["/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/usr/bin/gh"]),
];

/**
 * semver 2.0.0 的严格形状：`MAJOR.MINOR.PATCH[-prerelease][+build]`。
 *
 * 刻意**不接受** `v` 前缀与 `1.0` 这类简写：electron-builder 的 GitHub provider
 * 对 `version` 带 `v` 会直接抛
 * `Version must not start with "v"`（`electron-publish` 的 `gitHubPublisher.js`），
 * 而 `1.0` 会让产物名与 `latest.yml` 里的版本对不上。在这里挡掉比到打包末尾才炸好。
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** 检查状态。`warn` 不影响退出码：它是「还没到那一步」，不是「出了问题」。 */
export const STATUS = { OK: "ok", WARN: "warn", FAIL: "fail" };

/* ------------------------------------------------------------------ *
 * 纯函数部分（被 tests/release-check.test.ts 直接测，不碰 I/O、不跑进程）
 * ------------------------------------------------------------------ */

/**
 * 校验一个版本号字符串。
 *
 * @param {unknown} value
 * @returns {{ status: "ok" | "fail", version: string | null, detail: string }}
 */
export function checkVersion(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { status: STATUS.FAIL, version: null, detail: "版本号缺失或不是字符串" };
  }
  const text = value.trim();
  if (text.startsWith("v") || text.startsWith("V")) {
    return {
      status: STATUS.FAIL,
      version: null,
      detail: `版本号不能带 "v" 前缀（得到 ${JSON.stringify(text)}）；"v" 只属于 tag，electron-builder 会因 version 以 v 开头直接报错`,
    };
  }
  if (!SEMVER.test(text)) {
    return {
      status: STATUS.FAIL,
      version: null,
      detail: `${JSON.stringify(text)} 不是合法 semver（要求 MAJOR.MINOR.PATCH，例如 0.1.0）`,
    };
  }
  return { status: STATUS.OK, version: text, detail: `合法 semver: ${text}` };
}

/**
 * 检查一个目录（存在性 + 是否非空）。
 *
 * 纯函数：调用方把「已探明的事实」传进来（`exists` / `entries`），本函数只判断。
 * 这样测试不需要真的建目录树。
 *
 * @param {{
 *   label: string,
 *   dirPath: string,
 *   exists: boolean,
 *   entries: string[] | null,
 *   required?: boolean,
 * }} item
 *   `required` 为 false 时目录缺失只报 WARN（例如 `dist-mcp/` 在只发内核时可以不建）。
 * @returns {{ id: string, title: string, status: string, detail: string }}
 */
export function checkPath({ label, dirPath, exists, entries, required = true }) {
  const id = label;
  const title = `${label}（${dirPath}）`;
  if (!exists) {
    return {
      id,
      title,
      status: required ? STATUS.FAIL : STATUS.WARN,
      detail: required ? "目录不存在" : "目录不存在（可选）",
    };
  }
  if (entries === null) {
    return { id, title, status: STATUS.FAIL, detail: "目录存在但无法列出内容" };
  }
  if (entries.length === 0) {
    return { id, title, status: STATUS.FAIL, detail: "目录存在但为空" };
  }
  return { id, title, status: STATUS.OK, detail: `${entries.length} 项` };
}

/**
 * 批量版本：`checkPath` 的映射。输入是若干条「已探明」的目录事实。
 *
 * @param {Array<Parameters<typeof checkPath>[0]>} items
 * @returns {Array<ReturnType<typeof checkPath>>}
 */
export function checkPaths(items) {
  return items.map((item) => checkPath(item));
}

/**
 * 从安装包目录的条目里找安装包（`*.exe`，排除目录）。
 *
 * @param {string[] | null} entries
 * @returns {string[]}
 */
export function findInstallers(entries) {
  if (entries === null) {
    return [];
  }
  return entries.filter((name) => name.toLowerCase().endsWith(".exe"));
}

/**
 * @param {{ entries: string[] | null, dirPath: string }} input
 * @returns {{ id: string, title: string, status: string, detail: string }}
 */
export function checkInstaller({ entries, dirPath }) {
  const title = `安装包已产出（${dirPath}/*.exe）`;
  const id = "installer";
  if (entries === null) {
    return { id, title, status: STATUS.FAIL, detail: "安装包目录不存在或无法读取" };
  }
  const installers = findInstallers(entries);
  if (installers.length === 0) {
    return {
      id,
      title,
      status: STATUS.FAIL,
      detail: "没有 .exe。先跑 npm run build && npm run build:mcp && node scripts/package-prepare.mjs && 完整 NSIS 打包",
    };
  }
  return { id, title, status: STATUS.OK, detail: installers.join(", ") };
}

/**
 * 把磁盘上的安装包名，按 electron-builder 对 GitHub provider 的改写规则换算出
 * `latest.yml` 里会写成的名字。
 *
 * **为什么需要这个换算**：GitHub 只接受 `[0-9A-Za-z._-]` 的文件名
 * （`app-builder-lib/out/platformPackager.js` 的 `isSafeGithubName`）。默认产物名
 * 由 `productName` 拼出，是 `Embedded AI Master Setup 0.1.0.exe`（含空格），于是
 * `computeSafeArtifactNameIfNeeded` 会把空格换成 `-`，得到
 * `Embedded-AI-Master-Setup-0.1.0.exe`，并把这个值写进 `latest.yml` 的
 * `files[0].url` 与 `path`。
 *
 * **本仓库的 `artifactName` 已经显式写成连字符形式**（`desktop/package.json` 的
 * `build.win.artifactName`），所以 `computeSafeArtifactNameIfNeeded` 的第一分支
 * （`isSafeGithubName(suggestedName)` 为真）直接返回 `null`，electron-builder 用
 * basename 原样上传/写清单——**不会被二次改写**。本函数对这类名字也原样返回。
 *
 * 走 `--publish always` 时没问题：`GitHubPublisher` 构造 `super(context, true)`，
 * 上传用的是 `safeArtifactName`，远端资产名与 `latest.yml` 一致。
 *
 * **但走 `gh release create` / 网页手动上传时，上传用的是磁盘上的原名**
 * （带空格），而 `latest.yml` 里写的是带连字符的名字——两者对不上，
 * `electron-updater` 就会去下载一个不存在的资产。这是一个真实存在的不一致，
 * 不是猜测：换算规则逐行对照过源码。`artifactName` 显式配置之后这条不一致
 * 已从源头消除，本函数保留作 `--check` 的守门。
 *
 * @param {string} fileName 磁盘上的文件名
 * @returns {string} `latest.yml` 里会出现的名字
 */
export function githubSafeArtifactName(fileName) {
  if (/^[0-9A-Za-z._-]+$/.test(fileName)) {
    // 已经是安全名，computeSafeArtifactNameIfNeeded 返回 null → 用 basename 原样。
    return fileName;
  }
  const dashed = fileName.replace(/ /g, "-");
  if (/^[0-9A-Za-z._-]+$/.test(dashed)) {
    return dashed;
  }
  // 其余字符仍不安全：electron-builder 会退到 generateGitHubInstallerName()，
  // 那需要 appInfo，这里算不出来。如实说明，不假装知道。
  return dashed;
}

/**
 * 检查「磁盘上的安装包名」与「`latest.yml` 里会写的名字」是否一致。
 *
 * 不一致本身**不是这个仓库的配置错误**，而是一个必须知道的上传注意事项：
 * 手动上传时必须把文件按 `latest.yml` 里的名字改名，或者反过来把 `latest.yml`
 * 改成磁盘上的名字。所以这条报 WARN 并给出可直接照做的两条修法。
 *
 * @param {string[]} installers 磁盘上的安装包文件名
 * @returns {{ id: string, title: string, status: string, detail: string }}
 */
export function checkArtifactName(installers) {
  const id = "artifact-name";
  const title = "安装包名与 latest.yml 里的名字一致";
  if (installers.length === 0) {
    return { id, title, status: STATUS.WARN, detail: "没有安装包可检查" };
  }
  const mismatches = [];
  for (const name of installers) {
    const safe = githubSafeArtifactName(name);
    if (safe !== name) {
      mismatches.push({ name, safe });
    }
  }
  if (mismatches.length === 0) {
    return { id, title, status: STATUS.OK, detail: installers.join(", ") };
  }
  const lines = mismatches.map(
    (item) =>
      `${item.name}\n        latest.yml 里写的是 ${item.safe}\n` +
      `        手动上传时二选一: (a) 上传前把文件改名为 ${item.safe}；` +
      `(b) 把 latest.yml 的 url/path 改成 ${item.name}`,
  );
  return {
    id,
    title,
    status: STATUS.WARN,
    detail:
      "带空格的文件名会被改写为连字符（GitHub 只接受 [0-9A-Za-z._-]）。" +
      "走 --publish always 时上传名会自动跟着改，没问题；手动 gh/网页上传时名字会对不上：\n" +
      `      ${lines.join("\n      ")}`,
  };
}

/**
 * 工作区是否干净。
 *
 * 发布必须对应**一个确定的提交**：带未提交改动打出来的包，事后无法从 tag 复现。
 *
 * @param {string} porcelainOutput `git status --porcelain` 的原始输出
 * @returns {{ id: string, title: string, status: string, detail: string }}
 */
export function checkGitClean(porcelainOutput) {
  const id = "git-clean";
  const title = "git 工作区干净（git status --porcelain 为空）";
  if (typeof porcelainOutput !== "string") {
    return { id, title, status: STATUS.FAIL, detail: "拿不到 git status 输出" };
  }
  const lines = porcelainOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    return { id, title, status: STATUS.OK, detail: "没有未提交的改动" };
  }
  const shown = lines.slice(0, 8).join("\n      ");
  const more = lines.length > 8 ? `\n      ……另有 ${lines.length - 8} 项` : "";
  return {
    id,
    title,
    status: STATUS.FAIL,
    detail: `${lines.length} 项未提交改动：\n      ${shown}${more}`,
  };
}

/**
 * HEAD 有没有对应的 tag。
 *
 * 「还没有 tag」本身**不是失败** —— 打 tag 正是发布流程的第一步。所以这一项在
 * 缺 tag 时是 WARN，只有「HEAD 已经有一个**别的** tag」才值得注意（说明你可能
 * 已经在为另一个版本发布）。
 *
 * @param {{ headTags: string[] | null, plannedTag: string }} input
 * @returns {{ id: string, title: string, status: string, detail: string }}
 */
export function checkTag({ headTags, plannedTag }) {
  const id = "tag";
  const title = `HEAD 的 tag 状态（计划 ${plannedTag}）`;
  if (headTags === null) {
    return { id, title, status: STATUS.FAIL, detail: "拿不到 git tag --points-at HEAD 的输出" };
  }
  if (headTags.includes(plannedTag)) {
    return { id, title, status: STATUS.OK, detail: `HEAD 已打 ${plannedTag}` };
  }
  if (headTags.length === 0) {
    return {
      id,
      title,
      status: STATUS.WARN,
      detail: `HEAD 尚无 tag；发布流程第 3 步会创建 ${plannedTag}`,
    };
  }
  return {
    id,
    title,
    status: STATUS.WARN,
    detail: `HEAD 上的 tag 是 ${headTags.join(", ")}，与计划的 ${plannedTag} 不同`,
  };
}

/**
 * `gh` 可用性与登录状态。
 *
 * @param {{ found: boolean, executable: string | null, authenticated: boolean, account?: string | null }} input
 * @returns {{ id: string, title: string, status: string, detail: string }}
 */
export function checkGhCli({ found, executable, authenticated, account = null }) {
  const id = "gh";
  const title = "gh CLI 可用且已登录（gh auth status）";
  if (!found) {
    return {
      id,
      title,
      status: STATUS.FAIL,
      detail:
        "找不到 gh。安装后把它加进 PATH，或设置 GH_EXE 指向可执行文件；" +
        `Windows 常见位置 ${GH_CANDIDATES.slice(1).join(" / ")}`,
    };
  }
  if (!authenticated) {
    return {
      id,
      title,
      status: STATUS.FAIL,
      detail: `${executable} 存在但 gh auth status 非 0；运行 gh auth login 后重试`,
    };
  }
  return {
    id,
    title,
    status: STATUS.OK,
    detail: account === null ? `${executable}，已登录` : `${executable}，已登录账号 ${account}`,
  };
}

/**
 * 签名状态检查。`details` 是逐文件的结论（由 `scripts/verify-signature.mjs` 给出）。
 *
 * @param {{
 *   scriptMissing: boolean,
 *   files: Array<{ file: string, signed: boolean, error?: string | null }>,
 * }} input
 * @returns {{ id: string, title: string, status: string, detail: string }}
 */
export function checkSignature({ scriptMissing, files }) {
  const id = "signature";
  const title = "安装包已签名（scripts/verify-signature.mjs）";
  if (scriptMissing) {
    return {
      id,
      title,
      status: STATUS.FAIL,
      detail: "验证脚本缺失，无法确认签名状态（scripts/verify-signature.mjs 不存在）",
    };
  }
  if (files.length === 0) {
    return { id, title, status: STATUS.FAIL, detail: "没有可检查的安装包" };
  }
  const errors = files.filter((item) => item.error != null);
  if (errors.length > 0) {
    return {
      id,
      title,
      status: STATUS.FAIL,
      detail: errors.map((item) => `${path.basename(item.file)}: ${item.error}`).join("; "),
    };
  }
  const unsigned = files.filter((item) => !item.signed);
  if (unsigned.length > 0) {
    return {
      id,
      title,
      status: STATUS.FAIL,
      detail: `未签名: ${unsigned.map((item) => path.basename(item.file)).join(", ")}；用户会看到 SmartScreen 警告（见 docs/code-signing.md）`,
    };
  }
  return {
    id,
    title,
    status: STATUS.OK,
    detail: files.map((item) => path.basename(item.file)).join(", "),
  };
}

/**
 * 退出码聚合：任一 FAIL → 1，否则 0。`warn` 不算失败。
 *
 * @param {Array<{ status: string }>} checks
 * @returns {0 | 1}
 */
export function aggregateExitCode(checks) {
  return checks.some((check) => check.status === STATUS.FAIL) ? 1 : 0;
}

/** @type {Record<string, string>} */
const STATUS_LABEL = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

/**
 * 把检查结果排成人读的文本。
 *
 * @param {Array<{ title: string, status: string, detail: string }>} checks
 * @returns {string}
 */
export function formatChecks(checks) {
  const lines = [];
  for (const check of checks) {
    const label = STATUS_LABEL[check.status] ?? check.status.toUpperCase();
    lines.push(`[${label}] ${check.title}`);
    const detail = String(check.detail);
    for (const line of detail.split("\n")) {
      lines.push(`       ${line}`);
    }
  }
  const failed = checks.filter((check) => check.status === STATUS.FAIL).length;
  const warned = checks.filter((check) => check.status === STATUS.WARN).length;
  const passed = checks.filter((check) => check.status === STATUS.OK).length;
  lines.push("");
  lines.push(`合计 ${checks.length} 项：${passed} 通过，${warned} 提示，${failed} 失败`);
  return lines.join("\n");
}

/**
 * 由版本号推出默认 tag。
 *
 * `v` 前缀与 electron-builder 的 `vPrefixedTagName`（默认 true）一致：它给
 * GitHub release 用的 tag 就是 `v` + version。
 *
 * @param {string} version
 * @returns {string}
 */
export function defaultTag(version) {
  return `v${version}`;
}

/**
 * 校验 `--tag` 参数：允许 `v1.2.3` / `1.2.3` / `test1.2.3`，但必须**以合法 semver 结尾**。
 *
 * @param {unknown} tag
 * @returns {{ status: "ok" | "fail", tag: string | null, detail: string }}
 */
export function checkTagArgument(tag) {
  if (typeof tag !== "string" || tag.trim() === "") {
    return { status: STATUS.FAIL, tag: null, detail: "tag 为空" };
  }
  const text = tag.trim();
  const match = /^(.*?)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(text);
  if (match === null || !SEMVER.test(match[2])) {
    return {
      status: STATUS.FAIL,
      tag: null,
      detail: `${JSON.stringify(text)} 不以合法 semver 结尾（应形如 v0.1.0）`,
    };
  }
  return { status: STATUS.OK, tag: text, detail: text };
}

/**
 * 把 electron-builder 的 `artifactName` 模板展开成具体文件名。
 *
 * 模板里只有两个宏会被替换：`${version}` 与 `${ext}`（与 electron-builder 的
 * `expandMacro` 对这两个宏的行为一致）。`${productName}` / `${arch}` 等其它宏
 * 一概**不做替换**——做不到就不要编，让调用方看到原样的模板。
 *
 * 纯函数：不读文件、不碰 I/O。模板由调用方传入（`main()` 从
 * `desktop/package.json` 的 `build.win.artifactName` 读）。
 *
 * @param {{ artifactName: string, version: string, ext: string }} input
 * @returns {string}
 */
export function expandArtifactName({ artifactName, version, ext }) {
  return artifactName.split("${version}").join(version).split("${ext}").join(ext);
}

/**
 * 组装发布步骤文本。纯函数：只拼字符串，不做任何检查。
 *
 * `artifactName` 是 `desktop/package.json` 的 `build.win.artifactName`，由调用方
 * 传入；省略时退回 `DEFAULT_ARTIFACT_NAME`（保持旧调用方可用的默认值）。installer
 * 与 blockmap 两个文件名都从它派生，不再各自硬编码——硬编码正是它们与
 * electron-builder 实际产物漂移的来源。
 *
 * @param {{ version: string, tag: string, repoRoot?: string, artifactName?: string }} input
 * @returns {string}
 */
export function renderSteps({
  version,
  tag,
  repoRoot = REPO_ROOT,
  artifactName = DEFAULT_ARTIFACT_NAME,
}) {
  const installerDir = path.join(repoRoot, INSTALLER_DIR);
  const exeName = expandArtifactName({ artifactName, version, ext: "exe" });
  const blockmapName = `${exeName}.blockmap`;
  const exePath = path.posix.join(INSTALLER_DIR, exeName);
  const ymlPath = path.posix.join(INSTALLER_DIR, "latest.yml");
  const blockmapPath = path.posix.join(INSTALLER_DIR, blockmapName);
  const releaseUrl = `https://github.com/${REPOSITORY.owner}/${REPOSITORY.repo}/releases/new?tag=${tag}`;

  return `发布 Embedded AI Master v${version} 到 GitHub Releases
仓库: ${REPOSITORY.owner}/${REPOSITORY.repo}（public）
产物目录: ${installerDir}

下面每条命令都只打印、不代跑。最后三步（tag / release / 上传）是不可逆动作。

════════ 第 0 步：前置检查 ════════

  node scripts/release.mjs --check

必须 0 失败。有 FAIL 就修完再来，不要跳过。

════════ 第 1 步：构建 ════════

  npm run build
  npm run build:mcp
  node scripts/package-prepare.mjs
  cd desktop && npx electron-builder --win --x64

说明: electron-builder 不加 --publish 时**只生成本地产物**（含 latest.yml），
      不会上传任何东西。latest.yml 是给 electron-updater 用的更新描述文件。

════════ 第 2 步：确认三个附件都在 ════════

  ls -la "${INSTALLER_DIR}/"

要看到这三个文件（大小非零）：

  ${exeName}
  ${blockmapName}
  latest.yml

════════ 第 3 步：打 tag 并推送 ════════

  git tag -a ${tag} -m "Embedded AI Master ${tag}"
  git push origin ${tag}

**顺序很重要**：必须先推 tag，再创建 release。若反过来，gh 会从仓库默认分支
的 HEAD 新建一个 tag，那个 tag 不指向你刚构建的提交。

════════ 第 4 步（推荐）：gh CLI 创建 release 并上传 ════════

  gh release create ${tag} \\
    "${exePath}" \\
    "${ymlPath}" \\
    "${blockmapPath}" \\
    --title "Embedded AI Master ${tag}" \\
    --notes "首个发布版本。"

如果 gh 不在 PATH 里（Windows 的 GUI 安装器常这样），用完整路径：

  "/c/Program Files/GitHub CLI/gh.exe" release create ${tag} \\
    "${exePath}" "${ymlPath}" "${blockmapPath}" \\
    --title "Embedded AI Master ${tag}" --notes "首个发布版本。"

核对:

  gh release view ${tag}

════════ 第 4 步替代 A：electron-builder 直接发布（需要 GH_TOKEN）════════

  GH_TOKEN=<your-gh-token> npx electron-builder --win --x64 --publish always

GH_TOKEN 是 GitHub Personal Access Token。public 仓库用 public_repo 就够（fine-grained
token 只需 Contents: Read and write）。**绝不能把它写进仓库、写进 package.json、
或写进任何会被提交的文件**。

不推荐这条路作为主路径: 它把「构建」和「发布」合成一步，构建中途失败会留下半个
release；而且它不会在发布前跑签名 / 工作区检查。gh 那条路更可控。

════════ 第 4 步替代 B：网页手动上传（没有任何 CLI 时的兜底）════════

  1. 打开 ${releaseUrl}
  2. Tag 选已有的 ${tag}（不要新建）
  3. 标题填 "Embedded AI Master ${tag}"
  4. 上传三个文件:
       ${exeName}
       latest.yml
       ${blockmapName}
  5. 勾选 / 不勾选 "Set as the latest release" 按需

════════ 第 5 步：复验 ════════

  node scripts/release.mjs --check
  gh release view ${tag}

--check 现在应该报 HEAD 已打 ${tag}（tag 项从 WARN 变成 OK）。

════════ 附注 ════════

- 版本号的唯一来源是 desktop/package.json 的 version。根 package.json 也有一个
  version，两者不一致时**以 desktop/ 那份为准**（安装包用它），但这个不一致本身
  是隐患，见 docs/release.md。
- latest.yml 由 electron-updater 消费；应用内自动更新**已接入**（desktop/updater.js，
  desktop/package.json 的 dependencies 里有 electron-updater ^6.8.11），所以每次发布
  都必须上传它，否则用户会看到「该 release 缺少更新清单」（docs/release.md §12.2）。
  但「一次真实的更新」至今未跑过，残余边界见 D-212 与 docs/release.md §12.6。
- 安装包名由 desktop/package.json 的 build.win.artifactName 决定；本脚本打印的名字
  与它取自同一份配置，不要在这里另写常量。
- 未签名的 release，用户双击安装包会看到 SmartScreen 警告，见 docs/code-signing.md。
`;
}

/* ------------------------------------------------------------------ *
 * I/O 部分
 * ------------------------------------------------------------------ */

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 探明一个目录的事实。不存在不抛错（那不是异常，是检查项的输入）。
 *
 * @param {string} dirPath
 * @returns {Promise<{ exists: boolean, entries: string[] | null }>}
 */
export async function inspectDir(dirPath) {
  try {
    const info = await stat(dirPath);
    if (!info.isDirectory()) {
      return { exists: true, entries: null };
    }
    const entries = await readdir(dirPath);
    return { exists: true, entries };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return { exists: false, entries: null };
    }
    throw error;
  }
}

/**
 * 运行一个只读命令，返回 `{ ok, stdout, stderr, code }`，**永不抛错**。
 *
 * 用途仅限三条只读探针。写操作一个都没有。
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
async function runProbe(file, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd ?? REPO_ROOT,
      timeout: 20_000,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr, code: 0, missing: false };
  } catch (error) {
    // 命令不存在（ENOENT）与命令返回非 0 是两件事，必须分开报。
    const code = typeof error.code === "string" ? null : (error.code ?? null);
    const missing = error.code === "ENOENT";
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
      code: code ?? (missing ? null : 1),
      missing,
    };
  }
}

/**
 * 找到可用的 `gh`。
 *
 * @returns {Promise<{ found: boolean, executable: string | null, authenticated: boolean, account: string | null, detail: string }>}
 */
export async function detectGh() {
  const override = process.env.GH_EXE;
  const candidates = override ? [override, ...GH_CANDIDATES] : GH_CANDIDATES;
  let lastDetail = "";
  for (const candidate of candidates) {
    const version = await runProbe(candidate, ["--version"]);
    if (version.ok) {
      const status = await runProbe(candidate, ["auth", "status"]);
      const account = pickAccount(status.stdout, status.stderr);
      return {
        found: true,
        executable: candidate,
        authenticated: status.ok,
        account,
        detail: status.ok ? "已登录" : "未登录",
      };
    }
    lastDetail = version.missing ? "不存在" : `退出码 ${version.code}`;
  }
  return {
    found: false,
    executable: null,
    authenticated: false,
    account: null,
    detail: lastDetail,
  };
}

/**
 * 从 `gh auth status` 输出里取出账号名。
 *
 * **只取账号名，不碰 token**：输出里有一行 `Token: github_pat_...`，那行永远不该
 * 出现在本脚本的任何输出里。这里用白名单式正则只捞 "Logged in to <host> account <name>"，
 * 末了再把任何像 token 的片段抹掉 —— 宁可少报，不可泄露。
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {string | null}
 */
export function pickAccount(stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  const match = /Logged in to \S+ account (\S+)/.exec(scrubTokens(text));
  return match === null ? null : match[1];
}

/**
 * 抹掉形似 token 的片段。`gh auth status` 会把 token 打码，但打码实现可能变；
 * 这里再兜一次底。
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubTokens(text) {
  return text
    .replace(/github_pat_[A-Za-z0-9_]+/g, "<redacted>")
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted>");
}

/**
 * 调 `scripts/verify-signature.mjs` 检查签名。
 *
 * 用动态 `import()` 而不是 spawn：那边导出的是纯函数，返回结构化结果比解析退出码
 * 更准确。脚本不存在时如实报「无法确认」，不跳过（R3）。
 *
 * @param {string[]} files
 * @returns {Promise<{ scriptMissing: boolean, files: Array<{ file: string, signed: boolean, error: string | null }> }>}
 */
async function inspectSignatures(files) {
  if (files.length === 0) {
    return { scriptMissing: false, files: [] };
  }
  let mod;
  try {
    mod = await import("./verify-signature.mjs");
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      return { scriptMissing: true, files: [] };
    }
    throw error;
  }
  const results = [];
  for (const file of files) {
    try {
      const info = await mod.inspectFile(file);
      results.push({ file, signed: info.signed === true, error: null });
    } catch (error) {
      results.push({ file, signed: false, error: messageOf(error) });
    }
  }
  return { scriptMissing: false, files: results };
}

/**
 * 读 `desktop/package.json` 的 version。
 *
 * @param {string} [repoRoot]
 * @returns {Promise<{ version: unknown, path: string }>}
 */
export async function readDesktopVersion(repoRoot = REPO_ROOT) {
  const packagePath = path.join(repoRoot, "desktop", "package.json");
  const text = await readFile(packagePath, "utf8");
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  return { version: parsed?.version, path: packagePath };
}

/**
 * 读 `desktop/package.json` 的 `build.win.artifactName`。
 *
 * 这是安装包文件名的**唯一来源**：electron-builder 用它给产物命名，本脚本用它
 * 拼 `gh release create` 的附件路径。两边各写一份常量就会漂移——2026-10-25
 * 把 `artifactName` 改成连字符后，`renderSteps` 仍打印带空格的老名字，就是那次
 * 漂移的实例。
 *
 * @param {string} [repoRoot]
 * @returns {Promise<{ artifactName: unknown, path: string }>}
 */
export async function readDesktopArtifactName(repoRoot = REPO_ROOT) {
  const packagePath = path.join(repoRoot, "desktop", "package.json");
  const text = await readFile(packagePath, "utf8");
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  return { artifactName: parsed?.build?.win?.artifactName, path: packagePath };
}

/**
 * 跑全部检查。
 *
 * @param {{ repoRoot?: string, tag?: string }} [options]
 * @returns {Promise<Array<{ id: string, title: string, status: string, detail: string }>>}
 */
export async function runChecks(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const checks = [];

  // 1. 版本号
  let version = null;
  try {
    const read = await readDesktopVersion(repoRoot);
    const result = checkVersion(read.version);
    checks.push({
      id: "version",
      title: `desktop/package.json 的 version（${path.relative(repoRoot, read.path)}）`,
      status: result.status,
      detail: result.detail,
    });
    version = result.version;
  } catch (error) {
    checks.push({
      id: "version",
      title: "desktop/package.json 的 version",
      status: STATUS.FAIL,
      detail: `读不到 desktop/package.json：${messageOf(error)}`,
    });
  }

  // 2. 构建产物目录
  const dirSpecs = [
    { label: "内核产物 dist/", dirPath: path.join(repoRoot, "dist"), required: true },
    { label: "MCP 产物 dist-mcp/", dirPath: path.join(repoRoot, "dist-mcp"), required: true },
    {
      label: "运行时依赖 desktop/build/node_modules",
      dirPath: path.join(repoRoot, "desktop", "build", "node_modules"),
      required: true,
    },
    {
      label: "语料 desktop/build/corpus",
      dirPath: path.join(repoRoot, "desktop", "build", "corpus"),
      required: true,
    },
  ];
  const facts = [];
  for (const spec of dirSpecs) {
    const inspected = await inspectDir(spec.dirPath);
    facts.push({
      label: spec.label,
      dirPath: path.relative(repoRoot, spec.dirPath).split(path.sep).join("/"),
      exists: inspected.exists,
      entries: inspected.entries,
      required: spec.required,
    });
  }
  checks.push(...checkPaths(facts));

  // 3. 安装包
  const installerDir = path.join(repoRoot, INSTALLER_DIR);
  const installerDirInfo = await inspectDir(installerDir);
  checks.push(
    checkInstaller({
      entries: installerDirInfo.entries,
      dirPath: INSTALLER_DIR,
    }),
  );

  // 4. 签名
  const installers = findInstallers(installerDirInfo.entries).map((name) =>
    path.join(installerDir, name),
  );
  checks.push(checkSignature(await inspectSignatures(installers)));

  // 5. 文件名一致性（GitHub 会把空格改写成连字符）
  checks.push(checkArtifactName(installers.map((file) => path.basename(file))));

  // 5. gh CLI
  const gh = await detectGh();
  checks.push(checkGhCli(gh));

  // 6. 工作区干净（只读）
  const statusProbe = await runProbe("git", ["status", "--porcelain"], { cwd: repoRoot });
  checks.push(
    checkGitClean(
      statusProbe.ok ? statusProbe.stdout : /** @type {null} */ (null),
    ),
  );

  // 7. tag 状态（只读）
  const tagProbe = await runProbe("git", ["tag", "--points-at", "HEAD"], { cwd: repoRoot });
  let plannedTag = null;
  if (options.tag !== undefined) {
    const tagCheck = checkTagArgument(options.tag);
    if (tagCheck.status === STATUS.OK) {
      plannedTag = tagCheck.tag;
    } else {
      checks.push({
        id: "tag-argument",
        title: "--tag 参数",
        status: STATUS.FAIL,
        detail: tagCheck.detail,
      });
    }
  }
  if (plannedTag === null) {
    plannedTag = version === null ? null : defaultTag(version);
  }
  checks.push(
    checkTag({
      headTags: tagProbe.ok
        ? tagProbe.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "")
        : null,
      plannedTag: plannedTag ?? "v<version>",
    }),
  );

  return checks;
}

/**
 * `--check` 的入口：跑检查、打印、返回退出码。
 *
 * @param {{ repoRoot?: string, tag?: string }} [options]
 * @returns {Promise<0 | 1>}
 */
export async function runCheckCommand(options = {}) {
  const checks = await runChecks(options);
  process.stdout.write(`${formatChecks(checks)}\n`);
  return aggregateExitCode(checks);
}

/**
 * 解析参数。纯函数。
 *
 * @param {string[]} argv
 * @returns {{ help: true } | { help: false, check: boolean, tag: string | undefined }}
 */
export function parseArgs(argv) {
  let check = false;
  let tag;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--tag") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--tag 缺少值");
      }
      tag = value;
      index += 1;
      continue;
    }
    throw new Error(`不认识的参数：${arg}`);
  }
  return { help: false, check, tag };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (parsed.check === true) {
    return runCheckCommand({ tag: parsed.tag });
  }

  // 打印步骤模式：只读文件系统，不 spawn 任何进程。
  const read = await readDesktopVersion(REPO_ROOT);
  const versionCheck = checkVersion(read.version);
  if (versionCheck.status !== STATUS.OK) {
    process.stderr.write(
      `失败：${read.path} 的 version ${versionCheck.detail}\n`,
    );
    return 1;
  }

  let tag = defaultTag(versionCheck.version);
  if (parsed.tag !== undefined) {
    const tagCheck = checkTagArgument(parsed.tag);
    if (tagCheck.status !== STATUS.OK) {
      process.stderr.write(`失败：--tag ${tagCheck.detail}\n`);
      return 1;
    }
    tag = tagCheck.tag;
  }

  // 产物名从配置里读，不在这里另写一份常量 —— 两份迟早对不上（R3：说不出来就报错，
  // 不要悄悄退回一个可能已经过期的默认名）。
  const artifact = await readDesktopArtifactName(REPO_ROOT);
  if (typeof artifact.artifactName !== "string" || artifact.artifactName.trim() === "") {
    process.stderr.write(
      `失败：${artifact.path} 缺少 build.win.artifactName，无法推出安装包文件名\n`,
    );
    return 1;
  }

  process.stdout.write(
    `${renderSteps({
      version: versionCheck.version,
      tag,
      repoRoot: REPO_ROOT,
      artifactName: artifact.artifactName,
    })}`,
  );
  return 0;
}

// 只有被当成脚本直接运行时才跑 CLI；测试 import 本模块拿纯函数，不应触发 argv 解析。
const invokedPath =
  process.argv[1] === undefined ? "" : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== "" && import.meta.url === invokedPath) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`失败：${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}
