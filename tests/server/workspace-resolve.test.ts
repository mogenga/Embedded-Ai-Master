import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiHandler } from "../../src/server/api.js";
import type { ApiOptions } from "../../src/server/api.js";
import {
  __resetWorkspaceRootsForTests,
  resolveWorkspaceCandidates,
} from "../../src/server/files-api.js";
import { HttpError } from "../../src/server/http.js";

/**
 * `POST /api/workspace/resolve`：把浏览器拿到的裸文件夹名变成本机绝对路径候选。
 *
 * 搜索边界全部由测试传入（`roots`），默认的用户主目录永远不会被扫到 —— 这些
 * 用例只碰临时目录。
 */

const tempDirs: string[] = [];

/** 宽松预算：让「找得到」的用例不受机器快慢影响，限量用例自己传小值。 */
const ROOMY = { timeoutMs: 5000, maxEntries: 10000 };

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function mkdirs(root: string, ...segments: string[]): string {
  const full = path.join(root, ...segments);
  mkdirSync(full, { recursive: true });
  return full;
}

function canSymlink(): boolean {
  const root = mkdtempSync(path.join(tmpdir(), "eam-resolve-symlink-"));
  try {
    symlinkSync(path.join(root, "missing"), path.join(root, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SYMLINK_SUPPORTED = canSymlink();

async function capture<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

function expectHttpError(error: unknown, status: number, code: string): HttpError {
  expect(error).toBeInstanceOf(HttpError);
  const httpError = error as HttpError;
  expect(httpError.status).toBe(status);
  expect(httpError.code).toBe(code);
  // R3：拒绝必须带可读原因，不能只给状态码。
  expect(httpError.message.trim()).not.toBe("");
  return httpError;
}

beforeEach(() => {
  __resetWorkspaceRootsForTests();
});

afterEach(() => {
  __resetWorkspaceRootsForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveWorkspaceCandidates", () => {
  it("按名字找到嵌套目录，返回 realpath 后的绝对路径与真实名称", async () => {
    const root = makeRoot("eam-resolve-basic-");
    const target = mkdirs(root, "work", "myproject");
    const result = await resolveWorkspaceCandidates("myproject", { roots: [root], ...ROOMY });
    expect(result.candidates).toEqual([
      { path: realpathSync(target), name: "myproject" },
    ]);
  });

  it("没找到时返回空数组，不是错误", async () => {
    const root = makeRoot("eam-resolve-empty-");
    mkdirs(root, "alpha");
    mkdirs(root, "beta");
    const result = await resolveWorkspaceCandidates("nope", { roots: [root], ...ROOMY });
    expect(result.candidates).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("只匹配目录：同名文件不算候选", async () => {
    const root = makeRoot("eam-resolve-file-");
    writeFileSync(path.join(root, "myproject"), "not a directory");
    const result = await resolveWorkspaceCandidates("myproject", { roots: [root], ...ROOMY });
    expect(result.candidates).toEqual([]);
  });

  it("深度受限：maxDepth 之内的能命中，更深的不进入", async () => {
    const root = makeRoot("eam-resolve-depth-");
    // root/a/b/c/proj 在第 4 层；root/a/b/c/d/proj 在第 5 层。
    const shallow = mkdirs(root, "a", "b", "c", "proj");
    mkdirs(root, "a", "b", "c", "d", "proj");

    const withinFour = await resolveWorkspaceCandidates("proj", { roots: [root], ...ROOMY });
    expect(withinFour.candidates.map((entry) => entry.path)).toEqual([realpathSync(shallow)]);

    // 放宽到 5 层后两个都能找到：证明上面的「只找到一个」来自深度上限，
    // 而不是路径写错。
    const withinFive = await resolveWorkspaceCandidates("proj", {
      roots: [root],
      maxDepth: 5,
      ...ROOMY,
    });
    expect(withinFive.candidates).toHaveLength(2);
  });

  it("条目预算：扫描不会超过 maxEntries，超出即标记 truncated", async () => {
    const root = makeRoot("eam-resolve-budget-");
    for (let index = 0; index < 30; index += 1) mkdirs(root, `dir-${String(index).padStart(2, "0")}`);
    const result = await resolveWorkspaceCandidates("proj", {
      roots: [root],
      maxEntries: 5,
      timeoutMs: 5000,
    });
    expect(result.scanned).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });

  it("预算充足时不标记 truncated，且 scanned 就是检查过的条目数", async () => {
    const root = makeRoot("eam-resolve-scanned-");
    mkdirs(root, "one");
    mkdirs(root, "two");
    const result = await resolveWorkspaceCandidates("proj", { roots: [root], ...ROOMY });
    expect(result.scanned).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("超时预算为 0 时立即返回已找到的（空），不继续遍历", async () => {
    const root = makeRoot("eam-resolve-timeout-");
    mkdirs(root, "proj");
    const result = await resolveWorkspaceCandidates("proj", {
      roots: [root],
      timeoutMs: 0,
      maxEntries: 10000,
    });
    expect(result.candidates).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("Windows 上大小写不敏感；其它平台按原样比较", async () => {
    const root = makeRoot("eam-resolve-case-");
    const target = mkdirs(root, "MyProject");
    const result = await resolveWorkspaceCandidates("myproject", { roots: [root], ...ROOMY });
    if (process.platform === "win32") {
      expect(result.candidates.map((entry) => entry.path)).toEqual([realpathSync(target)]);
    } else {
      expect(result.candidates).toEqual([]);
    }
  });

  it.skipIf(!SYMLINK_SUPPORTED)("跳过符号链接，不跟随到搜索范围外", async () => {
    const root = makeRoot("eam-resolve-link-");
    const outside = makeRoot("eam-resolve-outside-");
    mkdirs(outside, "proj-real");
    symlinkSync(path.join(outside, "proj-real"), path.join(root, "proj"), "dir");
    const result = await resolveWorkspaceCandidates("proj", { roots: [root], ...ROOMY });
    expect(result.candidates).toEqual([]);
  });

  it("跳过以 . 开头的目录（.git / .cache / $HARNESS_HOME）", async () => {
    const root = makeRoot("eam-resolve-hidden-");
    mkdirs(root, ".cache", "proj");
    mkdirs(root, ".hidden-project");
    const nested = await resolveWorkspaceCandidates("proj", { roots: [root], ...ROOMY });
    expect(nested.candidates).toEqual([]);
    const direct = await resolveWorkspaceCandidates(".hidden-project", { roots: [root], ...ROOMY });
    expect(direct.candidates).toEqual([]);
  });

  it("多个根扫到同一个目录时只保留一个候选", async () => {
    const root = makeRoot("eam-resolve-dedupe-");
    const target = mkdirs(root, "sub", "proj");
    const result = await resolveWorkspaceCandidates("proj", {
      roots: [root, path.join(root, "sub")],
      ...ROOMY,
    });
    expect(result.candidates).toEqual([{ path: realpathSync(target), name: "proj" }]);
  });

  it("根目录自身同名时也算候选（再次打开同一个工作区）", async () => {
    const root = makeRoot("eam-resolve-basename-");
    // mkdtemp 的后缀随机，改成固定名字的子目录作为根。
    const named = mkdirs(root, "myproject");
    const result = await resolveWorkspaceCandidates("myproject", { roots: [named], ...ROOMY });
    expect(result.candidates).toEqual([{ path: realpathSync(named), name: "myproject" }]);
  });

  it("候选按层数浅的在前，同层按路径排序", async () => {
    const root = makeRoot("eam-resolve-order-");
    const shallow = mkdirs(root, "proj");
    const deep = mkdirs(root, "a", "proj");
    const result = await resolveWorkspaceCandidates("proj", { roots: [root], ...ROOMY });
    expect(result.candidates.map((entry) => entry.path)).toEqual([
      realpathSync(shallow),
      realpathSync(deep),
    ]);
  });

  it("候选数量封顶 10 个，并标记 truncated", async () => {
    const root = makeRoot("eam-resolve-cap-");
    for (let index = 0; index < 12; index += 1) mkdirs(root, `p${index}`, "proj");
    const result = await resolveWorkspaceCandidates("proj", { roots: [root], ...ROOMY });
    expect(result.candidates).toHaveLength(10);
    expect(result.truncated).toBe(true);
    // 去重后每条路径都是唯一的，前端弹选择列表才有意义。
    expect(new Set(result.candidates.map((entry) => entry.path)).size).toBe(10);
  });

  it("根不存在时安静跳过（不抛错）", async () => {
    const root = makeRoot("eam-resolve-missing-root-");
    const result = await resolveWorkspaceCandidates("proj", {
      roots: [path.join(root, "does-not-exist")],
      ...ROOMY,
    });
    expect(result.candidates).toEqual([]);
  });

  it("名字非法时 400 invalid_name：空串、分隔符、.. 与 NUL", async () => {
    const root = makeRoot("eam-resolve-invalid-");
    for (const bad of ["", "   ", "a/b", "a\\b", "..", ".", "a\0b"]) {
      const error = await capture(
        resolveWorkspaceCandidates(bad, { roots: [root], ...ROOMY }),
      );
      expectHttpError(error, 400, "invalid_name");
    }
  });
});

describe("POST /api/workspace/resolve", () => {
  function rawRequest(
    port: number,
    urlPath: string,
    method = "GET",
    headers: Record<string, string> = {},
    payload?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        agent: false,
        headers: { connection: "close", ...headers },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  async function startApi(opts: ApiOptions): Promise<{ port: number; close(): Promise<void> }> {
    const handler = createApiHandler(opts);
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return {
      port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function makeHome(): string {
    const home = makeRoot("eam-resolve-home-");
    mkdirSync(path.join(home, "sessions"), { recursive: true });
    return home;
  }

  function writeHeaders(port: number): Record<string, string> {
    return {
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/json; charset=utf-8",
    };
  }

  function errorCode(body: string): string {
    return (JSON.parse(body) as { error: { code: string } }).error.code;
  }

  it("返回候选绝对路径；搜索根由 ApiOptions 注入，不扫真实主目录", async () => {
    const searchRoot = makeRoot("eam-resolve-api-");
    const target = mkdirs(searchRoot, "work", "myproject");
    const api = await startApi({
      harnessHome: makeHome(),
      workspaceSearchRoots: [searchRoot],
    });
    try {
      const res = await rawRequest(
        api.port,
        "/api/workspace/resolve",
        "POST",
        writeHeaders(api.port),
        JSON.stringify({ name: "myproject" }),
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        candidates: [{ path: realpathSync(target), name: "myproject" }],
        // 「没找到」与「没找完」是两件事，前端要靠这个字段区分（R3）。
        truncated: false,
      });
    } finally {
      await api.close();
    }
  });

  it("没找到时 200 + 空数组（不是错误）", async () => {
    const searchRoot = makeRoot("eam-resolve-api-empty-");
    const api = await startApi({
      harnessHome: makeHome(),
      workspaceSearchRoots: [searchRoot],
    });
    try {
      const res = await rawRequest(
        api.port,
        "/api/workspace/resolve",
        "POST",
        writeHeaders(api.port),
        JSON.stringify({ name: "absent" }),
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ candidates: [], truncated: false });
    } finally {
      await api.close();
    }
  });

  it("缺少 Origin 的写请求 403 forbidden_origin", async () => {
    const api = await startApi({ harnessHome: makeHome(), workspaceSearchRoots: [] });
    try {
      const res = await rawRequest(
        api.port,
        "/api/workspace/resolve",
        "POST",
        { "content-type": "application/json" },
        JSON.stringify({ name: "proj" }),
      );
      expect(res.status).toBe(403);
      expect(errorCode(res.body)).toBe("forbidden_origin");
    } finally {
      await api.close();
    }
  });

  it("name 不是字符串或带分隔符时 400 invalid_name", async () => {
    const api = await startApi({ harnessHome: makeHome(), workspaceSearchRoots: [] });
    try {
      for (const payload of [{ name: 1 }, { name: "a/b" }, {}]) {
        const res = await rawRequest(
          api.port,
          "/api/workspace/resolve",
          "POST",
          writeHeaders(api.port),
          JSON.stringify(payload),
        );
        expect(res.status).toBe(400);
        expect(errorCode(res.body)).toBe("invalid_name");
      }
    } finally {
      await api.close();
    }
  });

  it("GET 返回 405", async () => {
    const api = await startApi({ harnessHome: makeHome(), workspaceSearchRoots: [] });
    try {
      const res = await rawRequest(api.port, "/api/workspace/resolve", "GET");
      expect(res.status).toBe(405);
      expect(errorCode(res.body)).toBe("method_not_allowed");
    } finally {
      await api.close();
    }
  });
});
