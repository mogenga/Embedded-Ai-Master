import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateExitCode,
  checkArtifactName,
  checkGhCli,
  checkGitClean,
  checkInstaller,
  checkPath,
  checkPaths,
  checkSignature,
  checkTag,
  checkTagArgument,
  checkVersion,
  DEFAULT_ARTIFACT_NAME,
  defaultTag,
  expandArtifactName,
  findInstallers,
  formatChecks,
  githubSafeArtifactName,
  inspectDir,
  parseArgs,
  pickAccount,
  readDesktopArtifactName,
  renderSteps,
  scrubTokens,
  STATUS,
} from "../scripts/release.mjs";

/**
 * 发布检查脚本测试。
 *
 * 全部是纯函数断言 + `mkdtemp` 临时目录，**绝不真跑 git、绝不调 GitHub API、
 * 绝不跑 electron-builder**：`checkGitClean` 吃的是注入的字符串（不是
 * `git status` 的真实输出），`checkGhCli` 吃的是注入的布尔值（不是 `gh auth status`）。
 *
 * 唯一的 I/O 用例是 `inspectDir`，它在临时目录里建/不建目录，用来验证那层
 * 「目录事实 → 纯函数判断」的接线确实通。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("checkVersion", () => {
  it("接受合法 semver", () => {
    for (const version of ["0.1.0", "1.0.0", "12.34.56", "1.2.3-beta.1", "1.2.3+build.7"]) {
      const result = checkVersion(version);
      expect(result.status, version).toBe(STATUS.OK);
      expect(result.version, version).toBe(version);
    }
  });

  it("拒绝带 v 前缀的版本号并说明原因", () => {
    const result = checkVersion("v0.1.0");
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.version).toBeNull();
    // 理由必须指向 electron-builder 的真实报错，而不是泛泛的「格式不对」。
    expect(result.detail).toContain("v");
    expect(result.detail).toContain("electron-builder");
  });

  it("拒绝 1.0 这类简写", () => {
    const result = checkVersion("1.0");
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("semver");
  });

  it("拒绝 abc", () => {
    expect(checkVersion("abc").status).toBe(STATUS.FAIL);
  });

  it("拒绝空值与非字符串", () => {
    expect(checkVersion("").status).toBe(STATUS.FAIL);
    expect(checkVersion("   ").status).toBe(STATUS.FAIL);
    expect(checkVersion(undefined).status).toBe(STATUS.FAIL);
    expect(checkVersion(123).status).toBe(STATUS.FAIL);
  });
});

describe("checkPath / checkPaths", () => {
  const base = { label: "dist/", dirPath: "dist" };

  it("目录存在且非空 → OK，并报条目数", () => {
    const result = checkPath({ ...base, exists: true, entries: ["a.js", "b.js"] });
    expect(result.status).toBe(STATUS.OK);
    expect(result.detail).toContain("2");
  });

  it("目录不存在 → FAIL", () => {
    const result = checkPath({ ...base, exists: false, entries: null });
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("不存在");
  });

  it("目录存在但为空 → FAIL（空目录等于没构建）", () => {
    const result = checkPath({ ...base, exists: true, entries: [] });
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("空");
  });

  it("目录存在但列不出内容 → FAIL", () => {
    const result = checkPath({ ...base, exists: true, entries: null });
    expect(result.status).toBe(STATUS.FAIL);
  });

  it("required=false 时缺失只报 WARN", () => {
    const result = checkPath({ ...base, exists: false, entries: null, required: false });
    expect(result.status).toBe(STATUS.WARN);
  });

  it("checkPaths 逐条映射且保持顺序", () => {
    const results = checkPaths([
      { label: "dist/", dirPath: "dist", exists: true, entries: ["x"] },
      { label: "dist-mcp/", dirPath: "dist-mcp", exists: false, entries: null },
    ]);
    expect(results.map((item) => item.id)).toEqual(["dist/", "dist-mcp/"]);
    expect(results.map((item) => item.status)).toEqual([STATUS.OK, STATUS.FAIL]);
  });
});

describe("checkInstaller / findInstallers", () => {
  it("找到 .exe", () => {
    const result = checkInstaller({
      entries: ["Embedded AI Master Setup 0.1.0.exe", "latest.yml"],
      dirPath: "desktop/dist-installer",
    });
    expect(result.status).toBe(STATUS.OK);
    expect(result.detail).toContain("Setup 0.1.0.exe");
  });

  it("没有 .exe → FAIL 并指向构建步骤", () => {
    const result = checkInstaller({ entries: ["latest.yml", "builder-debug.yml"], dirPath: "x" });
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("package-prepare");
  });

  it("目录不存在 → FAIL", () => {
    expect(checkInstaller({ entries: null, dirPath: "x" }).status).toBe(STATUS.FAIL);
  });

  it("findInstallers 只认 .exe，大小写不敏感", () => {
    expect(findInstallers(["a.EXE", "b.exe", "c.yml", "d.exe.blockmap"])).toEqual(["a.EXE", "b.exe"]);
    expect(findInstallers(null)).toEqual([]);
  });
});

describe("checkArtifactName / githubSafeArtifactName", () => {
  it("已安全的文件名原样返回", () => {
    expect(githubSafeArtifactName("Setup-0.1.0.exe")).toBe("Setup-0.1.0.exe");
  });

  it("带空格的文件名被换成连字符（GitHub 只接受 [0-9A-Za-z._-]）", () => {
    expect(githubSafeArtifactName("Embedded AI Master Setup 0.1.0.exe")).toBe(
      "Embedded-AI-Master-Setup-0.1.0.exe",
    );
  });

  it("真实产物名会触发名字不一致 → WARN，并给出两条修法", () => {
    const result = checkArtifactName(["Embedded AI Master Setup 0.1.0.exe"]);
    expect(result.status).toBe(STATUS.WARN);
    expect(result.detail).toContain("Embedded-AI-Master-Setup-0.1.0.exe");
    expect(result.detail).toContain("(a)");
    expect(result.detail).toContain("(b)");
  });

  it("文件名一致 → OK", () => {
    const result = checkArtifactName(["Setup-0.1.0.exe"]);
    expect(result.status).toBe(STATUS.OK);
    expect(result.detail).toContain("Setup-0.1.0.exe");
  });

  it("没有安装包 → WARN（不是 FAIL：别的地方已经报过缺产物）", () => {
    expect(checkArtifactName([]).status).toBe(STATUS.WARN);
  });
});

describe("checkGitClean（注入字符串，不跑 git）", () => {
  it("空输出 → OK", () => {
    const result = checkGitClean("");
    expect(result.status).toBe(STATUS.OK);
  });

  it("只有换行/空白 → OK", () => {
    expect(checkGitClean("\n \n\n").status).toBe(STATUS.OK);
  });

  it("有未提交改动 → FAIL，并报数量", () => {
    const porcelain = " M scripts/release.mjs\n?? docs/release.md\n";
    const result = checkGitClean(porcelain);
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("2 项");
    expect(result.detail).toContain("docs/release.md");
  });

  it("改动很多时截断显示，但数量如实", () => {
    const lines = Array.from({ length: 20 }, (_, index) => ` M file-${index}.ts`);
    const result = checkGitClean(`${lines.join("\n")}\n`);
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("20 项");
    expect(result.detail).toContain("另有 12 项");
  });

  it("拿不到输出（null）→ FAIL 而不是当作干净", () => {
    const result = checkGitClean(null);
    expect(result.status).toBe(STATUS.FAIL);
  });
});

describe("checkTag", () => {
  it("HEAD 已有计划中的 tag → OK", () => {
    const result = checkTag({ headTags: ["v0.1.0"], plannedTag: "v0.1.0" });
    expect(result.status).toBe(STATUS.OK);
  });

  it("HEAD 还没有 tag → WARN（打 tag 是流程的第一步，不是缺陷）", () => {
    const result = checkTag({ headTags: [], plannedTag: "v0.1.0" });
    expect(result.status).toBe(STATUS.WARN);
    expect(result.detail).toContain("v0.1.0");
  });

  it("HEAD 上是别的 tag → WARN 并点名两边", () => {
    const result = checkTag({ headTags: ["v0.0.9"], plannedTag: "v0.1.0" });
    expect(result.status).toBe(STATUS.WARN);
    expect(result.detail).toContain("v0.0.9");
    expect(result.detail).toContain("v0.1.0");
  });

  it("拿不到输出 → FAIL", () => {
    expect(checkTag({ headTags: null, plannedTag: "v0.1.0" }).status).toBe(STATUS.FAIL);
  });
});

describe("checkGhCli", () => {
  it("找到且已登录 → OK", () => {
    const result = checkGhCli({ found: true, executable: "gh", authenticated: true, account: "mogenga" });
    expect(result.status).toBe(STATUS.OK);
    expect(result.detail).toContain("mogenga");
  });

  it("找不到 → FAIL，并给出安装位置线索（不静默跳过）", () => {
    const result = checkGhCli({ found: false, executable: null, authenticated: false });
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("GitHub CLI");
    expect(result.detail).toContain("GH_EXE");
  });

  it("找到但未登录 → FAIL", () => {
    const result = checkGhCli({ found: true, executable: "gh", authenticated: false });
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("gh auth login");
  });
});

describe("pickAccount / scrubTokens", () => {
  it("从 gh auth status 输出取账号名", () => {
    const stdout = [
      "github.com",
      "  ✓ Logged in to github.com account mogenga (keyring)",
      "  - Active account: true",
      "  - Token: github_pat_ABCDEFG",
    ].join("\n");
    expect(pickAccount(stdout, "")).toBe("mogenga");
  });

  it("未登录时不返回账号", () => {
    expect(pickAccount("github.com\n  X You are not logged into any GitHub hosts.", "")).toBeNull();
  });

  it("把 token 抹掉", () => {
    const scrubbed = scrubTokens("Token: github_pat_11ABCDEFG\nghp_abcdefghijklmnopqrst");
    expect(scrubbed).not.toContain("github_pat_11ABCDEFG");
    expect(scrubbed).not.toContain("ghp_abcdefghijklmnopqrst");
    expect(scrubbed).toContain("<redacted>");
  });
});

describe("checkSignature", () => {
  it("验证脚本缺失 → FAIL 且明说无法确认（不是跳过）", () => {
    const result = checkSignature({ scriptMissing: true, files: [] });
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("verify-signature.mjs");
    expect(result.detail).toContain("无法确认");
  });

  it("全部已签名 → OK", () => {
    const result = checkSignature({
      scriptMissing: false,
      files: [{ file: "C:/x/Setup.exe", signed: true, error: null }],
    });
    expect(result.status).toBe(STATUS.OK);
    expect(result.detail).toContain("Setup.exe");
  });

  it("有未签名 → FAIL 并提到 SmartScreen", () => {
    const result = checkSignature({
      scriptMissing: false,
      files: [{ file: "C:/x/Setup.exe", signed: false, error: null }],
    });
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("SmartScreen");
  });

  it("检查本身出错 → FAIL（不能当成已签名）", () => {
    const result = checkSignature({
      scriptMissing: false,
      files: [{ file: "C:/x/Setup.exe", signed: false, error: "不是 PE 文件" }],
    });
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain("不是 PE 文件");
  });

  it("没有文件可检查 → FAIL", () => {
    expect(checkSignature({ scriptMissing: false, files: [] }).status).toBe(STATUS.FAIL);
  });
});

describe("aggregateExitCode", () => {
  const ok = { status: STATUS.OK, title: "t", detail: "", id: "a" };
  const warn = { status: STATUS.WARN, title: "t", detail: "", id: "b" };
  const fail = { status: STATUS.FAIL, title: "t", detail: "", id: "c" };

  it("全 OK → 0", () => {
    expect(aggregateExitCode([ok, ok])).toBe(0);
  });

  it("OK + WARN → 0（warn 是提示，不是失败）", () => {
    expect(aggregateExitCode([ok, warn])).toBe(0);
  });

  it("任一 FAIL → 1", () => {
    expect(aggregateExitCode([ok, warn, fail])).toBe(1);
  });

  it("只有 FAIL → 1", () => {
    expect(aggregateExitCode([fail])).toBe(1);
  });

  it("空列表 → 0", () => {
    expect(aggregateExitCode([])).toBe(0);
  });
});

describe("formatChecks", () => {
  it("逐项带状态标签，末尾给合计", () => {
    const text = formatChecks([
      { title: "版本号", status: STATUS.OK, detail: "合法" },
      { title: "签名", status: STATUS.FAIL, detail: "未签名" },
    ]);
    expect(text).toContain("[OK  ] 版本号");
    expect(text).toContain("[FAIL] 签名");
    expect(text).toContain("1 通过，0 提示，1 失败");
  });

  it("多行 detail 逐行缩进", () => {
    const text = formatChecks([{ title: "x", status: STATUS.FAIL, detail: "第一行\n第二行" }]);
    expect(text).toContain("       第一行");
    expect(text).toContain("       第二行");
  });
});

describe("defaultTag / checkTagArgument", () => {
  it("默认 tag 带 v 前缀", () => {
    expect(defaultTag("0.1.0")).toBe("v0.1.0");
  });

  it("接受 v1.2.3 / 1.2.3 / test1.2.3", () => {
    expect(checkTagArgument("v0.1.0").tag).toBe("v0.1.0");
    expect(checkTagArgument("0.1.0").tag).toBe("0.1.0");
    expect(checkTagArgument("test1.2.3").tag).toBe("test1.2.3");
  });

  it("拒绝不以 semver 结尾的 tag", () => {
    expect(checkTagArgument("").status).toBe(STATUS.FAIL);
    expect(checkTagArgument("v1.0").status).toBe(STATUS.FAIL);
    expect(checkTagArgument("release").status).toBe(STATUS.FAIL);
    expect(checkTagArgument(undefined).status).toBe(STATUS.FAIL);
  });
});

describe("expandArtifactName", () => {
  it("替换 ${version} 与 ${ext}", () => {
    expect(
      expandArtifactName({
        artifactName: "Embedded-AI-Master-Setup-${version}.${ext}",
        version: "0.1.5",
        ext: "exe",
      }),
    ).toBe("Embedded-AI-Master-Setup-0.1.5.exe");
  });

  it("同一个宏出现多次时全部替换", () => {
    expect(
      expandArtifactName({ artifactName: "${version}-x-${version}.${ext}", version: "1.2.3", ext: "exe" }),
    ).toBe("1.2.3-x-1.2.3.exe");
  });

  it("认不出的宏原样保留（不编造做不到的展开）", () => {
    expect(
      expandArtifactName({ artifactName: "${productName}-${version}.${ext}", version: "1.0.0", ext: "exe" }),
    ).toBe("${productName}-1.0.0.exe");
  });
});

describe("renderSteps", () => {
  const text = renderSteps({ version: "0.1.0", tag: "v0.1.0", repoRoot: "/repo" });

  it("包含打 tag 与推送两个真实命令", () => {
    expect(text).toContain('git tag -a v0.1.0 -m "Embedded AI Master v0.1.0"');
    expect(text).toContain("git push origin v0.1.0");
  });

  it("推荐路径是 gh release create，并带齐三个附件（名字由 artifactName 派生）", () => {
    const exeName = expandArtifactName({
      artifactName: DEFAULT_ARTIFACT_NAME,
      version: "0.1.0",
      ext: "exe",
    });
    expect(text).toContain("gh release create v0.1.0");
    expect(text).toContain(exeName);
    expect(text).toContain("latest.yml");
    expect(text).toContain(`${exeName}.blockmap`);
    // 旧硬编码（带空格）不得再出现——那是 electron-builder 产物名的漂移来源。
    expect(text).not.toContain("Embedded AI Master Setup 0.1.0.exe");
  });

  it("artifactName 变化时三个附件名随之变化", () => {
    const custom = renderSteps({
      version: "0.1.5",
      tag: "v0.1.5",
      repoRoot: "/repo",
      artifactName: "My-Setup-${version}.${ext}",
    });
    expect(custom).toContain("My-Setup-0.1.5.exe");
    expect(custom).toContain("My-Setup-0.1.5.exe.blockmap");
    expect(custom).not.toContain("Embedded-AI-Master-Setup-0.1.5.exe");
  });

  it("保留 --publish always + GH_TOKEN 的备选路径", () => {
    expect(text).toContain("--publish always");
    expect(text).toContain("GH_TOKEN");
  });

  it("保留网页手动上传备选路径", () => {
    expect(text).toContain("https://github.com/mogenga/Embedded-Ai-Master/releases/new?tag=v0.1.0");
  });

  it("不出现任何真实 token（只有占位符）", () => {
    expect(text).toContain("<your-gh-token>");
    expect(text).not.toMatch(/github_pat_[A-Za-z0-9]/);
    expect(text).not.toMatch(/ghp_[A-Za-z0-9]{16,}/);
  });
});

describe("readDesktopArtifactName", () => {
  it("从 desktop/package.json 的 build.win.artifactName 读出模板", async () => {
    const root = await tempDir("release-artifact-");
    await mkdir(path.join(root, "desktop"), { recursive: true });
    await writeFile(
      path.join(root, "desktop", "package.json"),
      JSON.stringify({ build: { win: { artifactName: "X-${version}.${ext}" } } }),
      "utf8",
    );
    const result = await readDesktopArtifactName(root);
    expect(result.artifactName).toBe("X-${version}.${ext}");
    expect(result.path).toBe(path.join(root, "desktop", "package.json"));
  });

  it("配置里没有该字段时返回 undefined（由调用方报错，不在这里兜底）", async () => {
    const root = await tempDir("release-artifact-");
    await mkdir(path.join(root, "desktop"), { recursive: true });
    await writeFile(path.join(root, "desktop", "package.json"), JSON.stringify({ build: {} }), "utf8");
    expect((await readDesktopArtifactName(root)).artifactName).toBeUndefined();
  });

  it("仓库里 desktop/package.json 的 artifactName 与 DEFAULT_ARTIFACT_NAME 一致", async () => {
    // 单一事实源守卫：main() 打印用的是配置文件里的值，这里确认脚本里的默认值
    // 没有在配置改名后悄悄过期（旧实现就是这样与磁盘产物漂移的）。
    const repoDesktop = fileURLToPath(new URL("../desktop/package.json", import.meta.url));
    const parsed = JSON.parse(await readFile(repoDesktop, "utf8"));
    expect(parsed.build.win.artifactName).toBe(DEFAULT_ARTIFACT_NAME);
    // 显式无空格 ⇒ computeSafeArtifactNameIfNeeded 第一分支（isSafeGithubName）命中、
    // 返回 null，electron-builder 用 basename 原样，不会被二次改写。
    const expanded = expandArtifactName({
      artifactName: parsed.build.win.artifactName,
      version: "0.1.5",
      ext: "exe",
    });
    expect(githubSafeArtifactName(expanded)).toBe(expanded);
  });
});

describe("parseArgs", () => {
  it("默认打印步骤", () => {
    expect(parseArgs([])).toEqual({ help: false, check: false, tag: undefined });
  });

  it("--check", () => {
    expect(parseArgs(["--check"])).toEqual({ help: false, check: true, tag: undefined });
  });

  it("--tag 带值", () => {
    expect(parseArgs(["--check", "--tag", "v1.2.3"])).toEqual({
      help: false,
      check: true,
      tag: "v1.2.3",
    });
  });

  it("--help / -h", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["-h"])).toEqual({ help: true });
  });

  it("--tag 缺值抛错", () => {
    expect(() => parseArgs(["--tag"])).toThrow();
    expect(() => parseArgs(["--tag", "--check"])).toThrow();
  });

  it("未知参数抛错", () => {
    expect(() => parseArgs(["--publish"])).toThrow();
  });
});

describe("inspectDir（唯一的真实 I/O，全在 mkdtemp 内）", () => {
  it("不存在的目录 → exists=false", async () => {
    const root = await tempDir("release-check-");
    const result = await inspectDir(path.join(root, "nope"));
    expect(result.exists).toBe(false);
    expect(result.entries).toBeNull();
  });

  it("空目录 → exists=true, entries=[]", async () => {
    const root = await tempDir("release-check-");
    const dir = path.join(root, "empty");
    await mkdir(dir, { recursive: true });
    const result = await inspectDir(dir);
    expect(result.exists).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it("非空目录 → 列出条目", async () => {
    const root = await tempDir("release-check-");
    const dir = path.join(root, "full");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.js"), "export {};\n", "utf8");
    const result = await inspectDir(dir);
    expect(result.exists).toBe(true);
    expect(result.entries).toEqual(["index.js"]);
  });

  it("路径是文件（不是目录）→ exists=true, entries=null（不假装是目录）", async () => {
    const root = await tempDir("release-check-");
    const file = path.join(root, "a-file");
    await writeFile(file, "x", "utf8");
    const result = await inspectDir(file);
    expect(result.exists).toBe(true);
    expect(result.entries).toBeNull();
  });
});
