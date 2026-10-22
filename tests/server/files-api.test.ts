import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/server/errors.js";
import {
  __resetWorkspaceRootsForTests,
  listDirectory,
  MAX_DIRECTORY_ENTRIES,
  readFilePreview,
  registerWorkspaceRoot,
  searchFilesByName,
} from "../../src/server/files-api.js";
import { createSessionRunner, RunnerError } from "../../src/server/runner.js";
import type { SessionRunner } from "../../src/server/runner.js";
import { readSessionHeader } from "../../src/session/persistence.js";

const tempDirs: string[] = [];
const runners: SessionRunner[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeHome(): string {
  const home = makeTempDir("eam-files-api-home-");
  mkdirSync(path.join(home, "sessions"), { recursive: true });
  return home;
}

function expectHttpError(error: unknown, status: number, code: string): HttpError {
  expect(error).toBeInstanceOf(HttpError);
  const httpError = error as HttpError;
  expect(httpError.status).toBe(status);
  expect(httpError.code).toBe(code);
  // R3：拒绝必须带上可读原因，不能只给状态码。
  expect(httpError.message.trim()).not.toBe("");
  return httpError;
}

async function capture<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

function canSymlink(): boolean {
  const root = mkdtempSync(path.join(tmpdir(), "eam-files-symlink-"));
  try {
    const target = path.join(root, "target.txt");
    writeFileSync(target, "x");
    symlinkSync(target, path.join(root, "link.txt"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SYMLINK_SUPPORTED = canSymlink();

beforeEach(() => {
  // 登记是模块级进程内状态：不重置会让前一例的根给后一例放行。
  __resetWorkspaceRootsForTests();
});

afterEach(async () => {
  __resetWorkspaceRootsForTests();
  await Promise.allSettled(runners.splice(0).map((runner) => runner.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("listDirectory", () => {
  it("目录在前、文件在后，各自按名称大小写不敏感排序", async () => {
    const home = makeHome();
    const root = path.join(home, "sessions", "project");
    mkdirSync(root, { recursive: true });
    // 故意打乱创建顺序：排序不能依赖 readdir 的返回顺序。
    writeFileSync(path.join(root, "b.txt"), "b");
    writeFileSync(path.join(root, "A.txt"), "a");
    writeFileSync(path.join(root, "c.log"), "c");
    mkdirSync(path.join(root, "sub2"));
    mkdirSync(path.join(root, "Sub1"));

    const result = await listDirectory(home, root);

    expect(result.path).toBe(realpathSync(root));
    expect(result.truncated).toBe(false);
    expect(result.entries.map((entry) => [entry.type, entry.name])).toEqual([
      ["dir", "Sub1"],
      ["dir", "sub2"],
      ["file", "A.txt"],
      ["file", "b.txt"],
      ["file", "c.log"],
    ]);
    for (const entry of result.entries) {
      expect(path.isAbsolute(entry.path)).toBe(true);
      expect(path.dirname(entry.path)).toBe(realpathSync(root));
    }
  });

  it("空目录返回空列表而不是报错", async () => {
    const home = makeHome();
    const root = path.join(home, "sessions", "empty");
    mkdirSync(root, { recursive: true });

    const result = await listDirectory(home, root);

    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("单层超过上限时截断并标记 truncated", async () => {
    const home = makeHome();
    const root = path.join(home, "sessions", "many");
    mkdirSync(root, { recursive: true });
    const total = MAX_DIRECTORY_ENTRIES + 2;
    for (let index = 0; index < total; index += 1) {
      writeFileSync(path.join(root, `f${String(index).padStart(4, "0")}.txt`), "x");
    }

    const result = await listDirectory(home, root);

    expect(result.entries).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(result.truncated).toBe(true);
    // 截断的是排序后的尾部，不是随机的一批。
    expect(result.entries[0]?.name).toBe("f0000.txt");
    expect(result.entries.at(-1)?.name).toBe(`f${String(MAX_DIRECTORY_ENTRIES - 1).padStart(4, "0")}.txt`);
  });

  it("越界路径返回 400 invalid_path", async () => {
    const home = makeHome();
    const outside = makeTempDir("eam-files-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "secret");

    const error = await capture(listDirectory(home, outside));

    expectHttpError(error, 400, "invalid_path");
  });

  it("不存在的路径返回 404 not_found", async () => {
    const home = makeHome();

    const error = await capture(listDirectory(home, path.join(home, "sessions", "nope")));

    expectHttpError(error, 404, "not_found");
  });

  it("指向文件的路径返回 400 not_directory", async () => {
    const home = makeHome();
    const file = path.join(home, "sessions", "notes.txt");
    writeFileSync(file, "x");

    const error = await capture(listDirectory(home, file));

    expectHttpError(error, 400, "not_directory");
  });

  it("非法入参返回 400 invalid_path", async () => {
    const home = makeHome();

    expectHttpError(await capture(listDirectory(home, "")), 400, "invalid_path");
    expectHttpError(await capture(listDirectory(home, "   ")), 400, "invalid_path");
    expectHttpError(
      await capture(listDirectory(home, 42 as never)),
      400,
      "invalid_path",
    );
    expectHttpError(
      await capture(listDirectory(home, `${home}\0x`)),
      400,
      "invalid_path",
    );
  });

  it.skipIf(!SYMLINK_SUPPORTED)("跳过符号链接", async () => {
    const home = makeHome();
    const root = path.join(home, "sessions", "links");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "real.txt"), "real");
    mkdirSync(path.join(root, "real-dir"));
    symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"), "file");
    symlinkSync(path.join(root, "real-dir"), path.join(root, "link-dir"), "dir");

    const result = await listDirectory(home, root);

    expect(result.entries.map((entry) => entry.name)).toEqual(["real-dir", "real.txt"]);
    expect(result.truncated).toBe(false);
  });
});

describe("searchFilesByName", () => {
  /** A project tree under the sessions root, so the boundary check passes unaided. */
  function makeProject(): { home: string; root: string } {
    const home = makeHome();
    const root = path.join(home, "sessions", "project");
    mkdirSync(root, { recursive: true });
    return { home, root };
  }

  it("文件名完全相等排在最前，其次是前缀，再其次是包含，最后才是仅路径命中", async () => {
    const { home, root } = makeProject();
    // One file per tier, plus a second tier-3 file so the within-tier sort
    // (shorter path first) is exercised rather than assumed.
    mkdirSync(path.join(root, "readme-dir"));
    writeFileSync(path.join(root, "readme"), "x");
    writeFileSync(path.join(root, "readme.md"), "x");
    writeFileSync(path.join(root, "x-readme.md"), "x");
    writeFileSync(path.join(root, "longer-x-readme.md"), "x");
    writeFileSync(path.join(root, "readme-dir", "notes.md"), "x");

    const result = await searchFilesByName(home, root, "readme");

    expect(result.files.map((file) => file.relative)).toEqual([
      "readme",
      "readme.md",
      "x-readme.md",
      "longer-x-readme.md",
      "readme-dir/notes.md",
    ]);
    expect(result.query).toBe("readme");
    expect(result.truncated).toBe(false);
    expect(result.scanTruncated).toBe(false);
  });

  it("嵌套路径查询命中子目录里的文件，relatives 用 / 分隔", async () => {
    const { home, root } = makeProject();
    mkdirSync(path.join(root, "src", "server"), { recursive: true });
    writeFileSync(path.join(root, "src", "server", "files-api.ts"), "x");
    writeFileSync(path.join(root, "src", "loop.ts"), "x");

    const result = await searchFilesByName(home, root, "src/server");

    expect(result.files).toHaveLength(1);
    const match = result.files[0];
    expect(match).toBeDefined();
    expect(match?.relative).toBe("src/server/files-api.ts");
    expect(match?.name).toBe("files-api.ts");
    expect(path.isAbsolute(match?.path ?? "")).toBe(true);
    expect(match?.path).toBe(path.join(realpathSync(root), "src", "server", "files-api.ts"));
    // POSIX separators on every platform: the renderer splits on "/".
    expect(match?.relative.includes("\\")).toBe(false);
  });

  it("大小写不敏感", async () => {
    const { home, root } = makeProject();
    writeFileSync(path.join(root, "README.md"), "x");

    const result = await searchFilesByName(home, root, "readme");

    expect(result.files.map((file) => file.name)).toEqual(["README.md"]);
    expect(result.files[0]?.relative).toBe("README.md");
  });

  it("空查询不遍历：scanned 为 0", async () => {
    const { home, root } = makeProject();
    writeFileSync(path.join(root, "readme.md"), "x");

    for (const query of ["", "   ", undefined, null, 42]) {
      const result = await searchFilesByName(home, root, query);
      expect(result.files).toEqual([]);
      expect(result.scanned).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.scanTruncated).toBe(false);
    }
  });

  it("忽略目录（node_modules）不贡献结果", async () => {
    const { home, root } = makeProject();
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "pkg", "readme.md"), "x");
    writeFileSync(path.join(root, "readme.md"), "x");

    const result = await searchFilesByName(home, root, "readme");

    expect(result.files.map((file) => file.relative)).toEqual(["readme.md"]);
    // Not even visited: the budget is spent on files the user wrote.
    expect(result.scanned).toBe(1);
  });

  it("目录本身不返回（遍历器只访问文件）", async () => {
    const { home, root } = makeProject();
    mkdirSync(path.join(root, "readme-dir"));
    writeFileSync(path.join(root, "readme-dir", "inner.md"), "x");

    const result = await searchFilesByName(home, root, "readme");

    expect(result.files.map((file) => file.relative)).toEqual(["readme-dir/inner.md"]);
  });

  it("越界路径返回 400 invalid_path", async () => {
    const home = makeHome();
    const outside = makeTempDir("eam-files-search-outside-");
    writeFileSync(path.join(outside, "readme.md"), "x");

    const error = await capture(searchFilesByName(home, outside, "readme"));

    expectHttpError(error, 400, "invalid_path");
  });

  it("超长查询与含 NUL 的查询返回 400 invalid_query", async () => {
    const { home, root } = makeProject();

    expectHttpError(await capture(searchFilesByName(home, root, "a".repeat(129))), 400, "invalid_query");
    expectHttpError(await capture(searchFilesByName(home, root, "a\0b")), 400, "invalid_query");
    // 128 是允许的上限。
    const atLimit = await searchFilesByName(home, root, "a".repeat(128));
    expect(atLimit.files).toEqual([]);
  });

  it("超过 limit 时截断并标记 truncated，返回的是排好序的前 N 个", async () => {
    const { home, root } = makeProject();
    for (const name of ["hit-9.md", "hit-1.md", "hit-3.md", "hit-2.md"]) {
      writeFileSync(path.join(root, name), "x");
    }

    const result = await searchFilesByName(home, root, "hit", { limit: 2 });

    expect(result.files.map((file) => file.name)).toEqual(["hit-1.md", "hit-2.md"]);
    expect(result.truncated).toBe(true);
  });

  it("扫描预算耗尽时置 scanTruncated 而不是把没扫完说成没有", async () => {
    const { home, root } = makeProject();
    for (const name of ["a1.txt", "a2.txt", "a3.txt"]) {
      writeFileSync(path.join(root, name), "x");
    }

    const result = await searchFilesByName(home, root, "a", { maxScanned: 1 });

    expect(result.files).toHaveLength(1);
    expect(result.scanTruncated).toBe(true);
  });

  it("路径不存在返回 404 not_found，指向文件返回 400 not_directory", async () => {
    const { home, root } = makeProject();
    const file = path.join(root, "readme.md");
    writeFileSync(file, "x");

    expectHttpError(
      await capture(searchFilesByName(home, path.join(root, "nope"), "readme")),
      404,
      "not_found",
    );
    expectHttpError(await capture(searchFilesByName(home, file, "readme")), 400, "not_directory");
  });
});

describe("registerWorkspaceRoot", () => {
  it("登记后该目录下的列目录与文件预览都可读", async () => {
    const home = makeHome();
    const workspace = makeTempDir("eam-files-workspace-");
    writeFileSync(path.join(workspace, "main.c"), "int main(void) { return 0; }\n");

    // 登记前：同样两个操作都被边界拒绝，证明可读性来自登记本身。
    expectHttpError(await capture(listDirectory(home, workspace)), 400, "invalid_path");
    expectHttpError(
      await capture(readFilePreview(home, path.join(workspace, "main.c"))),
      400,
      "invalid_path",
    );

    const registered = await registerWorkspaceRoot(workspace);
    expect(registered).toBe(realpathSync(workspace));

    const listing = await listDirectory(home, workspace);
    expect(listing.path).toBe(realpathSync(workspace));
    expect(listing.entries).toEqual([
      expect.objectContaining({ name: "main.c", type: "file" }),
    ]);

    const preview = await readFilePreview(home, path.join(workspace, "main.c"));
    expect(preview.content).toBe("int main(void) { return 0; }\n");
    expect(preview.binary).toBe(false);
  });

  it("传文件路径返回 400 invalid_path", async () => {
    const home = makeHome();
    const file = path.join(home, "sessions", "artifact.txt");
    writeFileSync(file, "x");

    expectHttpError(await capture(registerWorkspaceRoot(file)), 400, "invalid_path");
  });

  it("不存在的路径返回 400 invalid_path 且提示路径", async () => {
    const missing = path.join(makeTempDir("eam-files-missing-"), "nope");

    const error = expectHttpError(
      await capture(registerWorkspaceRoot(missing)),
      400,
      "invalid_path",
    );
    expect(error.message).toContain("nope");
  });

  it("非法入参返回 400 invalid_path", async () => {
    expectHttpError(await capture(registerWorkspaceRoot("")), 400, "invalid_path");
    expectHttpError(
      await capture(registerWorkspaceRoot(42 as never)),
      400,
      "invalid_path",
    );
  });
});

const PROVIDERS_TEXT = JSON.stringify({
  alpha: {
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    models: { m1: { contextWindow: 1000, maxOutput: 100 } },
  },
});

const COMPLETION = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 1 },
};

/** 离线的 OpenAI 兼容响应：绝不触网，只满足 runSession 的一次 complete。 */
function offlineFetch(): typeof fetch {
  const payload = JSON.stringify(COMPLETION);
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () => payload,
    json: async () => COMPLETION,
  })) as unknown as typeof fetch;
}

describe("runner cwd", () => {
  it("cwd 不存在时抛 invalid_cwd 且不创建会话目录", async () => {
    const home = makeHome();
    const runner = createSessionRunner({
      harnessHome: home,
      providersText: PROVIDERS_TEXT,
      fetchImpl: offlineFetch(),
    });
    runners.push(runner);
    const missing = path.join(home, "no-such-workdir");

    const error = await runner.start({ text: "hi", cwd: missing }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(RunnerError);
    expect((error as RunnerError).code).toBe("invalid_cwd");
    expect((error as RunnerError).message).toContain(missing);
    // 校验先于会话创建：sessions 根下不能留下任何会话目录。
    expect(readdirSync(path.join(home, "sessions"))).toEqual([]);
  });

  it("cwd 非字符串、相对路径或指向文件时都抛 invalid_cwd", async () => {
    const home = makeHome();
    const file = path.join(home, "sessions", "not-a-dir.txt");
    writeFileSync(file, "x");
    const runner = createSessionRunner({
      harnessHome: home,
      providersText: PROVIDERS_TEXT,
      fetchImpl: offlineFetch(),
    });
    runners.push(runner);

    for (const cwd of [42, "", "relative/workdir", "sessions", file]) {
      await expect(runner.start({ text: "hi", cwd: cwd as never })).rejects.toMatchObject({
        code: "invalid_cwd",
      });
    }
    // 全部在创建会话之前被拒：sessions 下没有新目录。
    expect(existsSync(path.join(home, "sessions"))).toBe(true);
    expect(existsSync(path.join(home, "sessions", "not-a-dir.txt"))).toBe(true);
    const entries = await listDirectory(home, path.join(home, "sessions"));
    expect(entries.entries.map((entry) => entry.name)).toEqual(["not-a-dir.txt"]);
  });

  it("合法 cwd 写入新会话 header.workdir", async () => {
    const home = makeHome();
    const workdir = makeTempDir("eam-runner-cwd-");
    const runner = createSessionRunner({
      harnessHome: home,
      providersText: PROVIDERS_TEXT,
      fetchImpl: offlineFetch(),
    });
    runners.push(runner);

    const outcome = await runner.start({ text: "hi", cwd: workdir });

    expect(outcome.created).toBe(true);
    const header = readSessionHeader(path.join(home, "sessions", outcome.sessionId));
    expect(header.workdir).toBe(workdir);
  });
});
