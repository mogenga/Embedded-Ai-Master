import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CorpusConfig } from "../src/config/corpus-config.js";
import type { CorpusManifest } from "../src/corpus/manifest.js";
import { signManifestPayload } from "../src/corpus/manifest.js";
import {
  ensureSnapshotDir,
  getKbLayout,
  listSnapshotVersions,
  readCurrentVersion,
  readState,
  setCurrent,
  writeState,
} from "../src/corpus/snapshot.js";
import type { KbLayout } from "../src/corpus/snapshot.js";
import { applyUpdate, checkForUpdate, readCorpusStatus } from "../src/corpus/update.js";
import type { FetchLike } from "../src/corpus/update.js";

// 全程不触网：所有请求都走注入的 fetchImpl，仓库里不出现任何真实地址。
// 密钥对现场生成，绝不读取用户的真实私钥，也不出现密钥字面量。
// 所有落盘只发生在 os.tmpdir() 下的临时目录（同 D-170 的教训：不碰真实 $HARNESS_HOME）。

let privateKeyPem: string;
let publicKeyPem: string;
let otherPrivateKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync("ed25519");
  privateKeyPem = String(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  publicKeyPem = String(pair.publicKey.export({ type: "spki", format: "pem" }));
  const other = generateKeyPairSync("ed25519");
  otherPrivateKeyPem = String(other.privateKey.export({ type: "pkcs8", format: "pem" }));
});

const BASE_URL = "https://example.invalid/";
const PUBLISHED_AT = "2026-10-23T12:00:00Z";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "corpus-update-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<CorpusConfig> = {}): CorpusConfig {
  return { version: 1, updateBaseUrl: BASE_URL, publicKeyPem, ...overrides };
}

function sha256Of(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function urlOf(relativePath: string): string {
  return new URL(relativePath, BASE_URL).toString();
}

const LATEST_URL = urlOf("latest.json");

interface FileSpec {
  path: string;
  content: string;
}

function buildManifest(
  corpusVersion: number,
  files: FileSpec[],
  options: { key?: string; publishedAt?: string } = {},
): CorpusManifest {
  const unsigned: CorpusManifest = {
    manifestVersion: 1,
    corpusVersion,
    publishedAt: options.publishedAt ?? PUBLISHED_AT,
    files: files.map((file) => ({ path: file.path, sha256: sha256Of(file.content) })),
    signature: "",
  };
  return { ...unsigned, signature: signManifestPayload(unsigned, options.key ?? privateKeyPem) };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

/** 记录请求 URL 的假 fetch；未登记的路由按 404 处理（让「多余的请求」暴露成失败）。 */
interface FakeFetch {
  impl: FetchLike;
  calls: string[];
}

function makeFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): FakeFetch {
  const calls: string[] = [];
  const impl: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    return await route();
  };
  return { impl, calls };
}

function networkError(cause: string): never {
  throw Object.assign(new TypeError("fetch failed"), { cause: new Error(cause) });
}

/**
 * 让请求一直挂着，直到传入的 AbortSignal 触发。用来验证超时走的是真实信号
 * （`AbortSignal.timeout`），而不是靠假数据凑出一个 TimeoutError。
 */
function hangUntilAborted(init: { signal?: AbortSignal } | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = (): void => {
      reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    };
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** 建好 v1..vN 的空快照目录（可选把 current 指到某一版）。 */
async function seedHome(
  versions: number[],
  current: number | null = null,
): Promise<{ home: string; layout: KbLayout }> {
  const home = makeHome();
  const layout = getKbLayout(home);
  for (const version of versions) await ensureSnapshotDir(layout, version);
  if (current !== null) await setCurrent(layout, current);
  return { home, layout };
}

function writeSnapshotFile(layout: KbLayout, version: number, relativePath: string, content: string): void {
  const target = path.join(layout.snapshotsDir, `v${version}`, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function readSnapshotFile(layout: KbLayout, version: number, relativePath: string): string {
  return readFileSync(path.join(layout.snapshotsDir, `v${version}`, relativePath), "utf8");
}

describe("checkForUpdate", () => {
  it("200 + 合法签名 + 版本更高 → update_available，fileCount 是清单文件总数", async () => {
    const { home } = await seedHome([1], 1);
    const files: FileSpec[] = [
      { path: "index.yaml", content: "version: 2\n" },
      { path: "protocols/uart/no-output.md", content: "无输出排查\n" },
      { path: "new.md", content: "新增\n" },
    ];
    const fetch = makeFetch({ [LATEST_URL]: () => jsonResponse(buildManifest(2, files)) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("update_available");
    if (state.kind !== "update_available") throw new Error("状态应为 update_available");
    expect(state.corpusVersion).toBe(2);
    expect(state.fileCount).toBe(3);
    expect(state.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fetch.calls).toEqual([LATEST_URL]);
  });

  it("检查成功会写 state.json（设置页重启后仍能显示上次结果）", async () => {
    const { home, layout } = await seedHome([1], 1);
    const manifest = buildManifest(2, [{ path: "index.yaml", content: "v2\n" }]);
    const fetch = makeFetch({ [LATEST_URL]: () => jsonResponse(manifest) });

    await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    const state = await readState(layout);
    expect(state.lastResult).toBe("update_available");
    expect(state.corpusVersion).toBe(2);
    expect(state.lastCheckedAt).toBeTruthy();
  });

  it("200 + 合法签名 + 版本相同 → up_to_date", async () => {
    const { home } = await seedHome([2], 2);
    const manifest = buildManifest(2, [{ path: "index.yaml", content: "v2\n" }]);
    const fetch = makeFetch({ [LATEST_URL]: () => jsonResponse(manifest) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("up_to_date");
    if (state.kind !== "up_to_date") throw new Error("状态应为 up_to_date");
    expect(state.corpusVersion).toBe(2);
  });

  it("200 + 合法签名 + 版本更低 → check_failed，且明确说是拒绝回滚（不能说成已是最新）", async () => {
    const { home } = await seedHome([3], 3);
    // 签名合法、独立可验：这是「桶里的清单被换成旧版本」的真实攻击形态。
    const manifest = buildManifest(2, [{ path: "index.yaml", content: "old\n" }]);
    const fetch = makeFetch({ [LATEST_URL]: () => jsonResponse(manifest) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("check_failed");
    if (state.kind !== "check_failed") throw new Error("状态应为 check_failed");
    expect(state.reason).toContain("回滚");
    expect(state.reason).toContain("v2");
    expect(state.reason).toContain("v3");
    // 最要紧的一条：绝不能显示成「已是最新」。
    expect(state.reason).not.toContain("已是最新");
    expect(state.kind).not.toBe("up_to_date");
  });

  it("200 + 签名被篡改 → verify_failed，原因提到验签", async () => {
    const { home } = await seedHome([1], 1);
    const manifest = buildManifest(2, [{ path: "index.yaml", content: "v2\n" }]);
    const tampered = { ...manifest, corpusVersion: 3 };
    const fetch = makeFetch({ [LATEST_URL]: () => jsonResponse(tampered) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("verify_failed");
    if (state.kind !== "verify_failed") throw new Error("状态应为 verify_failed");
    expect(state.reason).toContain("验签失败");
    // 篡改后的版本号不能生效。
    expect(state.reason).not.toContain("已是最新");
  });

  it("200 + 用另一把钥匙签名 → verify_failed（不是「公钥格式错」凑出来的）", async () => {
    const { home } = await seedHome([1], 1);
    const manifest = buildManifest(2, [{ path: "index.yaml", content: "v2\n" }], {
      key: otherPrivateKeyPem,
    });
    const fetch = makeFetch({ [LATEST_URL]: () => jsonResponse(manifest) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("verify_failed");
  });

  it("200 + 结构不合法（缺字段）→ verify_failed，原因指出具体字段", async () => {
    const { home } = await seedHome([1], 1);
    const manifest = buildManifest(2, [{ path: "index.yaml", content: "v2\n" }]);
    const broken: Record<string, unknown> = { ...manifest };
    delete broken.publishedAt;
    const fetch = makeFetch({ [LATEST_URL]: () => jsonResponse(broken) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    // 归类理由：这是「拿到了 200，但内容不可信」——重试不会变好，和网络失败
    // 是两种处置方式，所以走 verify_failed 而不是 check_failed。
    expect(state.kind).toBe("verify_failed");
    if (state.kind !== "verify_failed") throw new Error("状态应为 verify_failed");
    expect(state.reason).toContain("结构不合法");
    expect(state.reason).toContain("publishedAt");
  });

  it("200 + 路径穿越 → verify_failed，且原因带出穿越路径", async () => {
    const { home } = await seedHome([1], 1);
    const raw = {
      manifestVersion: 1,
      corpusVersion: 2,
      publishedAt: PUBLISHED_AT,
      files: [{ path: "../../evil.md", sha256: sha256Of("x") }],
      signature: buildManifest(2, [{ path: "index.yaml", content: "v2\n" }]).signature,
    };
    const fetch = makeFetch({ [LATEST_URL]: () => jsonResponse(raw) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("verify_failed");
    if (state.kind !== "verify_failed") throw new Error("状态应为 verify_failed");
    expect(state.reason).toContain("结构不合法");
    expect(state.reason).toContain("..");
  });

  it("200 + 不是合法 JSON → verify_failed", async () => {
    const { home } = await seedHome([1], 1);
    const fetch = makeFetch({ [LATEST_URL]: () => textResponse("{ not json") });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("verify_failed");
    if (state.kind !== "verify_failed") throw new Error("状态应为 verify_failed");
    expect(state.reason).toContain("不是合法 JSON");
  });

  it("403 → check_failed，原因点名 403 与 OBS 的 GetObject 语义（绝不能是「已是最新」）", async () => {
    // 契约 §6.1 实测：OBS 只授予 GetObject 时，**不存在的对象返回 403 而不是 404**。
    // 这是本文件最要紧的一条用例——把 403 当成「没更新」就是 R3 意义上的撒谎。
    const { home, layout } = await seedHome([1], 1);
    const fetch = makeFetch({ [LATEST_URL]: () => textResponse("AccessDenied", 403) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("check_failed");
    if (state.kind !== "check_failed") throw new Error("状态应为 check_failed");
    expect(state.reason).toContain("403");
    expect(state.reason).toContain("GetObject");
    expect(state.reason).toContain("尚未发布");
    expect(state.reason).not.toContain("已是最新");
    // 当前版本保留：检查失败不得改动任何语料状态。
    expect(await readCurrentVersion(layout)).toBe(1);
    expect((await readState(layout)).lastResult).toBe("check_failed");
  });

  it("404 → check_failed（与 403 同等处理，都不能当成「没有更新」）", async () => {
    const { home } = await seedHome([1], 1);
    const fetch = makeFetch({ [LATEST_URL]: () => textResponse("not found", 404) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("check_failed");
    if (state.kind !== "check_failed") throw new Error("状态应为 check_failed");
    expect(state.reason).toContain("404");
    expect(state.reason).not.toContain("已是最新");
  });

  it("500 → check_failed，措辞提示可重试", async () => {
    const { home } = await seedHome([1], 1);
    const fetch = makeFetch({ [LATEST_URL]: () => textResponse("boom", 500) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("check_failed");
    if (state.kind !== "check_failed") throw new Error("状态应为 check_failed");
    expect(state.reason).toContain("500");
    expect(state.reason).toContain("重试");
  });

  it("网络错误 → check_failed，带上底层原因并说明版本保持不变", async () => {
    const { home, layout } = await seedHome([1], 1);
    const fetch: FakeFetch = {
      calls: [],
      impl: async (url) => {
        fetch.calls.push(url);
        return networkError("getaddrinfo ENOTFOUND example.invalid");
      },
    };

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("check_failed");
    if (state.kind !== "check_failed") throw new Error("状态应为 check_failed");
    expect(state.reason).toContain("网络请求失败");
    expect(state.reason).toContain("ENOTFOUND");
    expect(state.reason).toContain("版本保持不变");
    expect(await readCurrentVersion(layout)).toBe(1);
  });

  it("超时 → check_failed（归类为网络失败，不是验签失败）", async () => {
    const { home } = await seedHome([1], 1);
    const impl: FetchLike = (_url, init) => hangUntilAborted(init);

    const state = await checkForUpdate({
      harnessHome: home,
      config: makeConfig(),
      fetchImpl: impl,
      timeoutMs: 10,
    });

    expect(state.kind).toBe("check_failed");
    if (state.kind !== "check_failed") throw new Error("状态应为 check_failed");
    expect(state.reason).toContain("超时");
    expect(state.reason).not.toContain("验签");
  });

  it("config 为 null → config_invalid（不是「已是最新」，也不发任何请求）", async () => {
    const { home } = await seedHome([1], 1);
    const fetch = makeFetch({});

    const state = await checkForUpdate({ harnessHome: home, config: null, fetchImpl: fetch.impl });

    expect(state.kind).toBe("config_invalid");
    if (state.kind !== "config_invalid") throw new Error("状态应为 config_invalid");
    expect(state.reason).toContain("corpus.json");
    expect(fetch.calls).toEqual([]);
  });

  it("配置的 updateBaseUrl 不以 / 结尾 → config_invalid 并说明原因", async () => {
    const { home } = await seedHome([1], 1);
    const fetch = makeFetch({});
    const state = await checkForUpdate({
      harnessHome: home,
      config: makeConfig({ updateBaseUrl: "https://example.invalid" }),
      fetchImpl: fetch.impl,
    });
    expect(state.kind).toBe("config_invalid");
    if (state.kind !== "config_invalid") throw new Error("状态应为 config_invalid");
    expect(state.reason).toContain("updateBaseUrl");
  });

  it("HARNESS_HOME 为空 → unavailable（不是配置问题，也不触网）", async () => {
    const fetch = makeFetch({});
    const state = await checkForUpdate({ harnessHome: "", config: makeConfig(), fetchImpl: fetch.impl });
    expect(state.kind).toBe("unavailable");
    expect(fetch.calls).toEqual([]);
  });

  it("本地还没有 current 指针时按版本 0 比较：远端版本就算更新", async () => {
    const { home } = await seedHome([]);
    const manifest = buildManifest(1, [{ path: "index.yaml", content: "v1\n" }]);
    const fetch = makeFetch({ [LATEST_URL]: () => jsonResponse(manifest) });

    const state = await checkForUpdate({ harnessHome: home, config: makeConfig(), fetchImpl: fetch.impl });

    expect(state.kind).toBe("update_available");
  });
});

describe("applyUpdate", () => {
  /** 本地 v1（index.yaml 未变、a.md 待改），远端 v2（a.md 改内容、b.md 新增）。 */
  async function setupV1() {
    const { home, layout } = await seedHome([1], 1);
    writeSnapshotFile(layout, 1, "index.yaml", "version: 1\n");
    writeSnapshotFile(layout, 1, "a.md", "旧内容\n");
    const remote: FileSpec[] = [
      { path: "index.yaml", content: "version: 1\n" },
      { path: "a.md", content: "新内容\n" },
      { path: "b.md", content: "新增文件\n" },
    ];
    return { home, layout, remote, manifest: buildManifest(2, remote) };
  }

  it("正常：下载变化文件、校验、切指针，readCurrentVersion 读出新版本", async () => {
    const { home, layout, remote, manifest } = await setupV1();
    const routes: Record<string, () => Response> = {};
    for (const file of remote) routes[urlOf(file.path)] = () => textResponse(file.content);
    const fetch = makeFetch(routes);

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest,
      fetchImpl: fetch.impl,
    });

    expect(result).toEqual({ ok: true, corpusVersion: 2 });
    expect(await readCurrentVersion(layout)).toBe(2);
    expect(readSnapshotFile(layout, 2, "index.yaml")).toBe("version: 1\n");
    expect(readSnapshotFile(layout, 2, "a.md")).toBe("新内容\n");
    expect(readSnapshotFile(layout, 2, "b.md")).toBe("新增文件\n");
    // 上一版保留（契约 §6「保留上一版」）。
    expect(await listSnapshotVersions(layout)).toContain(1);
    // 切完指针记录状态，设置页据此显示「已是最新」。
    expect((await readState(layout)).lastResult).toBe("up_to_date");
    expect((await readState(layout)).corpusVersion).toBe(2);
  });

  it("只下载 sha256 变化的文件（未变的从上一版复制，但新快照仍是完整语料）", async () => {
    const { home, layout, remote, manifest } = await setupV1();
    const routes: Record<string, () => Response> = {};
    for (const file of remote) routes[urlOf(file.path)] = () => textResponse(file.content);
    const fetch = makeFetch(routes);

    await applyUpdate({ harnessHome: home, config: makeConfig(), manifest, fetchImpl: fetch.impl });

    // index.yaml 内容未变：不该被请求。
    expect(fetch.calls).not.toContain(urlOf("index.yaml"));
    expect(fetch.calls).toEqual([urlOf("a.md"), urlOf("b.md")]);
    // 但它仍然出现在新快照里——否则切过去会静默少文件（R3）。
    expect(readSnapshotFile(layout, 2, "index.yaml")).toBe("version: 1\n");
  });

  it("进度回调按文件报告下载与复用", async () => {
    const { home, remote, manifest } = await setupV1();
    const routes: Record<string, () => Response> = {};
    for (const file of remote) routes[urlOf(file.path)] = () => textResponse(file.content);
    const fetch = makeFetch(routes);
    const events: Array<{ path: string; action: string; completed: number }> = [];

    await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest,
      fetchImpl: fetch.impl,
      onProgress: (progress) => {
        events.push({ path: progress.path, action: progress.action, completed: progress.completed });
      },
    });

    expect(events).toEqual([
      { path: "index.yaml", action: "reused", completed: 1 },
      { path: "a.md", action: "downloaded", completed: 2 },
      { path: "b.md", action: "downloaded", completed: 3 },
    ]);
  });

  it("某文件 sha256 不匹配 → 失败、current 保持旧版本、半成品快照被清理", async () => {
    const { home, layout, remote, manifest } = await setupV1();
    const routes: Record<string, () => Response> = {};
    for (const file of remote) routes[urlOf(file.path)] = () => textResponse(file.content);
    // 服务端返回的内容与清单声明的不一致（中间人/发布事故）。
    routes[urlOf("a.md")] = () => textResponse("被篡改的内容\n");
    const fetch = makeFetch(routes);

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest,
      fetchImpl: fetch.impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当失败");
    expect(result.reason).toContain("a.md");
    expect(result.reason).toContain("sha256");
    expect(result.corpusVersionUnchanged).toBe(1);
    expect(await readCurrentVersion(layout)).toBe(1);
    await expect(listSnapshotVersions(layout)).resolves.toEqual([1]);
    expect(existsSync(path.join(layout.snapshotsDir, "v2"))).toBe(false);
    // 旧语料一个字节都没动。
    expect(readSnapshotFile(layout, 1, "a.md")).toBe("旧内容\n");
  });

  it("锁被占用 → 返回失败，且不破坏现状、不删别人的锁", async () => {
    const { home, layout, remote, manifest } = await setupV1();
    const routes: Record<string, () => Response> = {};
    for (const file of remote) routes[urlOf(file.path)] = () => textResponse(file.content);
    const fetch = makeFetch(routes);
    const lockPath = path.join(layout.kbRoot, ".lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999 }), "utf8");

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest,
      fetchImpl: fetch.impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当失败");
    expect(result.reason).toContain("另一个实例");
    expect(result.corpusVersionUnchanged).toBe(1);
    expect(fetch.calls).toEqual([]);
    expect(await readCurrentVersion(layout)).toBe(1);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(path.join(layout.snapshotsDir, "v2"))).toBe(false);
  });

  it("下载中途网络错误 → 失败、current 不动、半成品被清理", async () => {
    const { home, layout, remote, manifest } = await setupV1();
    const routes: Record<string, () => Response | Promise<Response>> = {};
    for (const file of remote) routes[urlOf(file.path)] = () => textResponse(file.content);
    routes[urlOf("b.md")] = () => networkError("ECONNRESET");
    const fetch = makeFetch(routes);

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest,
      fetchImpl: fetch.impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当失败");
    expect(result.reason).toContain("b.md");
    expect(result.reason).toContain("网络请求失败");
    expect(result.corpusVersionUnchanged).toBe(1);
    expect(await readCurrentVersion(layout)).toBe(1);
    expect(existsSync(path.join(layout.snapshotsDir, "v2"))).toBe(false);
  });

  it("下载超时 → 失败且归类为网络问题", async () => {
    const { home, layout, manifest } = await setupV1();
    const impl: FetchLike = (_url, init) => hangUntilAborted(init);

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest,
      fetchImpl: impl,
      timeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当失败");
    expect(result.reason).toContain("超时");
    expect(result.corpusVersionUnchanged).toBe(1);
    expect(await readCurrentVersion(layout)).toBe(1);
  });

  it("路径穿越的恶意清单 → 拒绝且不写任何文件、不发任何请求", async () => {
    const { home, layout } = await seedHome([1], 1);
    const fetch = makeFetch({});
    // 故意绕开 parseManifest 直接构造（模拟「清单来自不受类型约束的宿主」）。
    const malicious = {
      manifestVersion: 1,
      corpusVersion: 2,
      publishedAt: PUBLISHED_AT,
      files: [{ path: "../../evil.md", sha256: sha256Of("pwned") }],
      signature: buildManifest(2, [{ path: "index.yaml", content: "v2\n" }]).signature,
    } as unknown as CorpusManifest;

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest: malicious,
      fetchImpl: fetch.impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当拒绝");
    expect(result.reason).toContain("清单不合法");
    expect(result.corpusVersionUnchanged).toBe(1);
    expect(fetch.calls).toEqual([]);
    expect(existsSync(path.join(layout.snapshotsDir, "v2"))).toBe(false);
    expect(existsSync(path.join(home, "evil.md"))).toBe(false);
    expect(existsSync(path.join(layout.snapshotsDir, "evil.md"))).toBe(false);
    expect(existsSync(path.join(layout.kbRoot, "evil.md"))).toBe(false);
    expect(await readCurrentVersion(layout)).toBe(1);
  });

  it("未签名的清单 → 拒绝（落盘前重新验签）", async () => {
    const { home, layout } = await seedHome([1], 1);
    const fetch = makeFetch({});
    const unsigned: CorpusManifest = {
      ...buildManifest(2, [{ path: "index.yaml", content: "v2\n" }]),
      corpusVersion: 5,
    };

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest: unsigned,
      fetchImpl: fetch.impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当拒绝");
    expect(result.reason).toContain("验签失败");
    expect(fetch.calls).toEqual([]);
    expect(await readCurrentVersion(layout)).toBe(1);
  });

  it("远端版本不高于本地 → 拒绝（防回滚/不重装），不发请求", async () => {
    const { home, layout } = await seedHome([2], 2);
    const fetch = makeFetch({});
    const manifest = buildManifest(2, [{ path: "index.yaml", content: "v2\n" }]);

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest,
      fetchImpl: fetch.impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当拒绝");
    expect(result.reason).toContain("无需更新");
    expect(fetch.calls).toEqual([]);
    expect(await readCurrentVersion(layout)).toBe(2);

    const older = buildManifest(1, [{ path: "index.yaml", content: "v1\n" }]);
    const rollback = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest: older,
      fetchImpl: fetch.impl,
    });
    expect(rollback.ok).toBe(false);
    if (rollback.ok) throw new Error("应当拒绝");
    expect(rollback.reason).toContain("回滚");
    expect(await readCurrentVersion(layout)).toBe(2);
  });

  it("有中文/空格的路径按 percent-encoding 请求，文件落到快照目录内", async () => {
    const { home, layout } = await seedHome([1], 1);
    writeSnapshotFile(layout, 1, "index.yaml", "version: 1\n");
    const remote: FileSpec[] = [
      { path: "index.yaml", content: "version: 1\n" },
      { path: "protocols/串口 无输出.md", content: "中文路径\n" },
    ];
    const manifest = buildManifest(2, remote);
    const routes: Record<string, () => Response> = {};
    for (const file of remote) routes[urlOf(file.path)] = () => textResponse(file.content);
    const fetch = makeFetch(routes);

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest,
      fetchImpl: fetch.impl,
    });

    expect(result.ok).toBe(true);
    expect(fetch.calls).toContain(
      "https://example.invalid/protocols/%E4%B8%B2%E5%8F%A3%20%E6%97%A0%E8%BE%93%E5%87%BA.md",
    );
    expect(readSnapshotFile(layout, 2, "protocols/串口 无输出.md")).toBe("中文路径\n");
  });

  it("上次失败留下的同版本残留目录会被清空后重用（不会混进旧文件）", async () => {
    const { home, layout, remote, manifest } = await setupV1();
    // 上一次更新失败留下的 v2 目录，含一个本次清单里没有的文件。
    writeSnapshotFile(layout, 2, "stale.md", "上次残留\n");
    const routes: Record<string, () => Response> = {};
    for (const file of remote) routes[urlOf(file.path)] = () => textResponse(file.content);
    const fetch = makeFetch(routes);

    const result = await applyUpdate({
      harnessHome: home,
      config: makeConfig(),
      manifest,
      fetchImpl: fetch.impl,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(layout.snapshotsDir, "v2", "stale.md"))).toBe(false);
  });

  it("config 为 null → 失败并说明是配置问题", async () => {
    const { home, layout, manifest } = await setupV1();
    const fetch = makeFetch({});

    const result = await applyUpdate({
      harnessHome: home,
      config: null,
      manifest,
      fetchImpl: fetch.impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当失败");
    expect(result.reason).toContain("配置不可用");
    expect(await readCurrentVersion(layout)).toBe(1);
  });
});

describe("readCorpusStatus", () => {
  it("没有 current 指针 → unavailable（连内置快照都没有）", async () => {
    const { home } = await seedHome([]);
    await expect(readCorpusStatus({ harnessHome: home })).resolves.toEqual({ kind: "unavailable" });
  });

  it("HARNESS_HOME 为空 → unavailable", async () => {
    await expect(readCorpusStatus({ harnessHome: "" })).resolves.toEqual({ kind: "unavailable" });
  });

  it("有快照但从未检查 → bundled", async () => {
    const { home } = await seedHome([1], 1);
    await expect(readCorpusStatus({ harnessHome: home })).resolves.toEqual({ kind: "bundled" });
  });

  it("state.json 记录 up_to_date → up_to_date，版本以 current 指针为准", async () => {
    const { home, layout } = await seedHome([1, 2], 2);
    await writeState(layout, {
      lastCheckedAt: "2026-10-23T12:00:00.000Z",
      lastResult: "up_to_date",
      // 备注里写着 1，指针却是 2：指针才是「现在装着什么」。
      corpusVersion: 1,
    });

    const state = await readCorpusStatus({ harnessHome: home });

    expect(state.kind).toBe("up_to_date");
    if (state.kind !== "up_to_date") throw new Error("状态应为 up_to_date");
    expect(state.corpusVersion).toBe(2);
    expect(state.checkedAt).toBe("2026-10-23T12:00:00.000Z");
  });

  it("state.json 记录 update_available（含 fileCount）→ 完整还原成 update_available", async () => {
    const { home, layout } = await seedHome([1], 1);
    await writeState(layout, {
      lastCheckedAt: "2026-10-23T12:00:00.000Z",
      lastResult: "update_available",
      corpusVersion: 4,
      fileCount: 7,
    });

    const state = await readCorpusStatus({ harnessHome: home });

    // 指针仍停在 v1，发现的是 v4：报的是待更新的那一版，不是本地已装的版本。
    expect(state.kind).toBe("update_available");
    if (state.kind !== "update_available") throw new Error("状态应为 update_available");
    expect(state.corpusVersion).toBe(4);
    expect(state.fileCount).toBe(7);
    expect(state.checkedAt).toBe("2026-10-23T12:00:00.000Z");
  });

  it("state.json 记录 update_available 但缺 fileCount → 如实报「记录不完整」，不编造", async () => {
    const { home, layout } = await seedHome([1], 1);
    // 早期版本写下的状态文件没有 fileCount；用 0 顶上就是撒谎（R3）。
    await writeState(layout, {
      lastCheckedAt: "2026-10-23T12:00:00.000Z",
      lastResult: "update_available",
      corpusVersion: 4,
    });

    const state = await readCorpusStatus({ harnessHome: home });

    expect(state.kind).toBe("check_failed");
    if (state.kind !== "check_failed") throw new Error("状态应为 check_failed");
    expect(state.reason).toContain("v4");
    expect(state.reason).toContain("文件数");
    expect(state.reason).toContain("重新检查");
  });

  it("state.json 记录 check_failed → 带出上次的原因", async () => {
    const { home, layout } = await seedHome([1], 1);
    await writeState(layout, {
      lastCheckedAt: "2026-10-23T12:00:00.000Z",
      lastResult: "check_failed",
      detail: "更新源返回 403，可能是尚未发布或桶策略未授予 GetObject",
    });

    const state = await readCorpusStatus({ harnessHome: home });

    expect(state.kind).toBe("check_failed");
    if (state.kind !== "check_failed") throw new Error("状态应为 check_failed");
    expect(state.reason).toContain("403");
    expect(state.checkedAt).toBe("2026-10-23T12:00:00.000Z");
  });

  it("state.json 记录 verify_failed → 带出验签原因", async () => {
    const { home, layout } = await seedHome([1], 1);
    await writeState(layout, {
      lastCheckedAt: "2026-10-23T12:00:00.000Z",
      lastResult: "verify_failed",
      detail: "清单验签失败：签名与内容不符",
    });

    const state = await readCorpusStatus({ harnessHome: home });

    expect(state.kind).toBe("verify_failed");
    if (state.kind !== "verify_failed") throw new Error("状态应为 verify_failed");
    expect(state.reason).toContain("验签失败");
  });

  it("state.json 损坏 → bundled（不抛错，也不猜状态）", async () => {
    const { home, layout } = await seedHome([1], 1);
    mkdirSync(layout.kbRoot, { recursive: true });
    writeFileSync(layout.stateFile, "{ broken", "utf8");
    await expect(readCorpusStatus({ harnessHome: home })).resolves.toEqual({ kind: "bundled" });
  });
});
