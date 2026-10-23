import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { signManifestPayload } from "../../src/corpus/manifest.js";
import {
  ensureSnapshotDir,
  getKbLayout,
  readCurrentVersion,
  setCurrent,
  writeState,
} from "../../src/corpus/snapshot.js";

/**
 * The corpus commands (`getCorpusStatus` / `checkCorpusUpdate` /
 * `applyCorpusUpdate`) driven through a real host process.
 *
 * Three rules hold for every case here:
 *
 * 1. **Nothing leaves the machine.** The only HTTP endpoint any test uses is a
 *    server this file started on `127.0.0.1` (or port 1, which is never bound
 *    and refuses immediately). No OBS address, no real bucket, no fixtures
 *    copied from the deployment.
 * 2. **Every home is a temp directory.** `HARNESS_HOME` and `AGENTS_HOME` are
 *    always pointed at `mkdtemp` output, the same rule `host.test.js` follows
 *    (D-170: a test process must never read or write the machine's real config).
 * 3. **The interesting assertion is what was *not* done.** Opening the page
 *    must not produce a request, `config_invalid` must not produce one either,
 *    and a failure must never come back as a success state.
 *
 * `dist/corpus/update.js` is imported lazily by the host, so these cases need a
 * build. A tree without one skips rather than fails — "not built yet" is not
 * "broken" — and the skip is stated so it cannot be read as a pass.
 */
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const HOST = path.join(REPO_ROOT, "desktop", "host", "host.js");
const CORPUS_BUILT = existsSync(path.join(REPO_ROOT, "dist", "corpus", "update.js"))
  && existsSync(path.join(REPO_ROOT, "dist", "config", "corpus-config.js"))
  && existsSync(path.join(REPO_ROOT, "dist", "corpus", "snapshot.js"));

const HOST_TIMEOUT_MS = 30_000;

const tempDirs = [];
const servers = [];

/** A fresh Ed25519 key pair. Generated per run: the repository holds no key
 *  material, and the user's real signing key is never read. */
let publicKeyPem;
let privateKeyPem;
beforeAll(() => {
  const pair = generateKeyPairSync("ed25519");
  publicKeyPem = String(pair.publicKey.export({ type: "spki", format: "pem" }));
  privateKeyPem = String(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve)).catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * A local endpoint that answers every request with 403 and records what it was
 * asked for.
 *
 * 403 is the status contract §6.1 is about: Huawei OBS with only `GetObject`
 * granted answers a missing object with 403, never 404, so the client must not
 * read it as "nothing published". The `requests` array is how a test proves a
 * *different* command never called here at all.
 */
async function refusingSource() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("AccessDenied");
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/`, requests };
}

/**
 * An address nothing listens on. Port 1 on loopback is reserved and never
 * bound, so the connection is refused at once and the failure path runs
 * without a test-timeout.
 */
function unreachableBaseUrl() {
  return "http://127.0.0.1:1/";
}

function sha256Of(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A local update source serving `latest.json` and the files it names.
 *
 * Serves real signed manifests so the whole check → verify → download → switch
 * path runs against the kernel's own rules. `requests` records every path, which
 * is how the cache test proves the manifest was fetched once rather than twice.
 */
async function publishingSource({ corpusVersion, files }) {
  const signed = {
    manifestVersion: 1,
    corpusVersion,
    publishedAt: "2026-10-23T12:00:00Z",
    files: files.map((file) => ({ path: file.path, sha256: sha256Of(file.content) })),
    signature: "",
  };
  const manifest = { ...signed, signature: signManifestPayload(signed, privateKeyPem) };
  const bodies = new Map([
    ["/latest.json", JSON.stringify(manifest)],
    ...files.map((file) => [`/${file.path}`, file.content]),
  ]);
  const requests = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    const body = bodies.get(url);
    if (body === undefined) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(body);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/`, requests };
}

/** Write `$HARNESS_HOME/corpus.json`, the level that outranks everything else. */
async function writeCorpusConfig(home, updateBaseUrl) {
  await writeFile(
    path.join(home, "corpus.json"),
    JSON.stringify({ version: 1, updateBaseUrl, publicKeyPem }, null, 2),
    "utf8",
  );
}

/** Seed `kb/snapshots/v1` and point `current` at it. */
async function seedSnapshot(home) {
  const layout = getKbLayout(home);
  await ensureSnapshotDir(layout, 1);
  await setCurrent(layout, 1);
  return layout;
}

/**
 * Start the host and feed it NDJSON, stopping once `until` matches.
 *
 * Same surface the Electron main process drives. `HARNESS_HOME` and
 * `AGENTS_HOME` are always set: without the second, the skill store refuses to
 * default inside a test runner and the boot carries a `problems` entry.
 */
function runHost(home, commands, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: path.dirname(HOST),
      env: {
        ...process.env,
        ...(options.env ?? {}),
        HARNESS_HOME: home,
        AGENTS_HOME: path.join(home, ".agents-fixture"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`host timed out; events: ${events.map((event) => event.type).join(",")}`));
    }, HOST_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          events.push({ type: "unparsed", line });
        }
      }
      if (options.until !== undefined && options.until(events)) {
        child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      }
    });
    child.stderr.on("data", (chunk) => events.push({ type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(events);
    });

    for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`);
  });
}

describe.skipIf(!CORPUS_BUILT)("corpus commands", () => {
  /**
   * No `kb/` at all: there is no corpus snapshot on this machine.
   *
   * `unavailable` is the contract §7 answer, and the two things that would be
   * lies are both asserted against: `bundled` would claim a corpus exists, and
   * any other state would be a claim about a version nobody installed.
   */
  it("getCorpusStatus 在没有快照时返回 unavailable，不崩也不假装有语料", async () => {
    const home = await tempDir("eam-corpus-empty-");
    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getCorpusStatus" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    expect(answer.status).toStrictEqual({ kind: "unavailable" });
    expect(answer.error).toBeUndefined();
    // The boot completed and the process answered: a corpus command must never
    // be able to take the window down.
    expect(events.some((event) => event.type === "ready")).toBe(true);
    expect(events.some((event) => event.type === "fatal")).toBe(false);
    expect(events.some((event) => event.type === "unparsed")).toBe(false);
  }, HOST_TIMEOUT_MS);

  /**
   * A seeded snapshot plus a state file: the stored result has to come back
   * unchanged, version and timestamp included. Anything this host re-derived
   * would be a second opinion about a file the kernel owns.
   */
  it("getCorpusStatus 在 state.json 存在时如实映射（版本与检查时间都在）", async () => {
    const home = await tempDir("eam-corpus-up-to-date-");
    const layout = await seedSnapshot(home);
    const checkedAt = "2026-10-23T09:30:00.000Z";
    await writeState(layout, { lastCheckedAt: checkedAt, lastResult: "up_to_date", corpusVersion: 1 });
    await writeCorpusConfig(home, "http://127.0.0.1:1/");

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getCorpusStatus" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    expect(answer.status).toStrictEqual({ kind: "up_to_date", corpusVersion: 1, checkedAt });
    expect(answer.configSource).toBe("home");
    expect(answer.configPath).toBe(path.join(home, "corpus.json"));
  }, HOST_TIMEOUT_MS);

  /**
   * `update_available` requires `fileCount`, and the stored one has to survive.
   * Dropping it would leave the page with `fileCount: 0` — a number nobody
   * measured (R3).
   */
  it("getCorpusStatus 还原 update_available 的版本号与文件数", async () => {
    const home = await tempDir("eam-corpus-available-");
    const layout = await seedSnapshot(home);
    const checkedAt = "2026-10-23T10:00:00.000Z";
    await writeState(layout, {
      lastCheckedAt: checkedAt,
      lastResult: "update_available",
      corpusVersion: 2,
      fileCount: 7,
      detail: "有新版 v2，共 7 个文件",
    });
    await writeCorpusConfig(home, "http://127.0.0.1:1/");

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getCorpusStatus" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    expect(answer.status).toStrictEqual({
      kind: "update_available",
      corpusVersion: 2,
      fileCount: 7,
      checkedAt,
    });
  }, HOST_TIMEOUT_MS);

  /**
   * An early state file has no `fileCount`. The kernel degrades it to
   * `check_failed` with a sentence saying why; this host must pass that
   * sentence through rather than filling the gap with a zero.
   */
  it("状态文件缺 fileCount 时如实降级成 check_failed，原因原样带出", async () => {
    const home = await tempDir("eam-corpus-incomplete-");
    const layout = await seedSnapshot(home);
    await writeState(layout, {
      lastCheckedAt: "2026-10-23T10:00:00.000Z",
      lastResult: "update_available",
      corpusVersion: 2
    });
    await writeCorpusConfig(home, "http://127.0.0.1:1/");

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getCorpusStatus" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    expect(answer.status.kind).toBe("check_failed");
    expect(answer.status.reason).toContain("文件数");
    expect(answer.status.reason).toContain("重新检查");
    // `fileCount: 0` anywhere in this answer would be the invented number.
    expect(answer.status.fileCount).toBeUndefined();
  }, HOST_TIMEOUT_MS);

  /**
   * A snapshot with no `corpus.json` anywhere.
   *
   * Contract §2: the knowledge base keeps working, and the *update feature*
   * reports `config_invalid`. The sentence has to say what is missing and the
   * path has to point at the file the user can create — "not configured" with
   * no location is a dead end.
   */
  it("没有 corpus.json 时 getCorpusStatus 报 config_invalid 并给出可创建的文件路径", async () => {
    const home = await tempDir("eam-corpus-no-config-");
    await seedSnapshot(home);

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getCorpusStatus" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    expect(answer.status.kind).toBe("config_invalid");
    expect(answer.status.reason).toContain("corpus.json");
    expect(answer.configPath).toBe(path.join(home, "corpus.json"));
  }, HOST_TIMEOUT_MS);

  /**
   * The load-bearing constraint of this task: **opening the page must not
   * check.**
   *
   * Proven by construction rather than by timing. The config points at a local
   * server that records every request, so if `getCorpusStatus` reached out, the
   * array would not be empty. The stored state is `bundled`, which is only
   * reachable from a read of `state.json` — a check would have written
   * `check_failed` (the server answers 403) and reported that instead.
   */
  it("getCorpusStatus 不发起任何网络请求（配置指向会记录请求的本地端点）", async () => {
    const home = await tempDir("eam-corpus-offline-");
    const source = await refusingSource();
    await seedSnapshot(home);
    await writeCorpusConfig(home, source.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getCorpusStatus" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    // A never-checked corpus: `state.json` does not exist, so the answer is
    // `bundled`, not a failure and not a fabricated check result.
    expect(answer.status).toStrictEqual({ kind: "bundled" });
    expect(source.requests).toStrictEqual([]);
  }, HOST_TIMEOUT_MS);

  /**
   * No config at all, and an explicit check request. There is nothing to fetch,
   * so there must be no fetch — and the answer still has to arrive, because a
   * page waits on it.
   */
  it("没有配置时 checkCorpusUpdate 返回 config_invalid，不发起请求也不崩宿主", async () => {
    const home = await tempDir("eam-corpus-check-noconfig-");
    await seedSnapshot(home);

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "checkCorpusUpdate" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    expect(answer.status.kind).toBe("config_invalid");
    expect(answer.status.reason).toContain("corpus.json");
    expect(events.some((event) => event.type === "fatal")).toBe(false);
    expect(events.some((event) => event.type === "ready")).toBe(true);
  }, HOST_TIMEOUT_MS);

  /**
   * A real 403 from the update source. Contract §6.1 is the reason this is the
   * most important failure case in the feature: OBS answers a missing object
   * with 403, so "403" must never turn into "up to date".
   */
  it("更新源 403 时 checkCorpusUpdate 报 check_failed 并说明 GetObject 语义，绝不说成已是最新", async () => {
    const home = await tempDir("eam-corpus-403-");
    const source = await refusingSource();
    await seedSnapshot(home);
    await writeCorpusConfig(home, source.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "checkCorpusUpdate" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    expect(answer.status.kind).toBe("check_failed");
    expect(answer.status.reason).toContain("403");
    expect(answer.status.reason).toContain("GetObject");
    expect(answer.status.kind).not.toBe("up_to_date");
    // Exactly the manifest request, nothing more.
    expect(source.requests).toStrictEqual(["/latest.json"]);
  }, HOST_TIMEOUT_MS);

  /**
   * An address nothing answers on. The network layer's own failure reason (the
   * `cause` Node hides behind "fetch failed") is what makes this diagnosable,
   * so the assertion is that a reason arrived and that the version stayed put.
   */
  it("更新源不可达时 checkCorpusUpdate 报 check_failed 且带上底层原因", async () => {
    const home = await tempDir("eam-corpus-unreachable-");
    await seedSnapshot(home);
    await writeCorpusConfig(home, unreachableBaseUrl());

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "checkCorpusUpdate" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    expect(answer.status.kind).toBe("check_failed");
    expect(answer.status.reason).toContain("网络请求失败");
    expect(answer.status.reason).toContain("版本保持不变");
    expect(events.some((event) => event.type === "fatal")).toBe(false);
  }, HOST_TIMEOUT_MS);

  /**
   * `applyCorpusUpdate` with nothing configured: no manifest, so no download
   * and no snapshot switch. The result has to be a refusal with a reason, in
   * the shape the page renders — not silence, which reads as success.
   */
  it("没有配置时 applyCorpusUpdate 明确拒绝并给原因，不假装成功", async () => {
    const home = await tempDir("eam-corpus-apply-noconfig-");
    await seedSnapshot(home);

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "applyCorpusUpdate" }], {
      until: (all) => all.some((event) => event.type === "corpus_update_result"),
    });

    const result = events.find((event) => event.type === "corpus_update_result");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("corpus.json");
    expect(result.corpusVersion).toBeUndefined();
    expect(events.some((event) => event.type === "fatal")).toBe(false);
  }, HOST_TIMEOUT_MS);

  /**
   * "Update now" with a source that has nothing to offer: the apply re-checks
   * (it was never given a manifest) and refuses with the check's own reason.
   *
   * This is the path a page that stayed open across a publish would take, so it
   * must not be a crash and must not be a success.
   */
  it("applyCorpusUpdate 在更新源 403 时拒绝安装并转述检查失败的原因", async () => {
    const home = await tempDir("eam-corpus-apply-403-");
    const source = await refusingSource();
    await seedSnapshot(home);
    await writeCorpusConfig(home, source.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "applyCorpusUpdate" }], {
      // The status answer follows the result on purpose (the page renders the
      // outcome and then the new state), so waiting for the result alone would
      // shut the host down in the middle of the pair.
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const result = events.find((event) => event.type === "corpus_update_result");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("403");
    // The refusal came from a check, so the manifest was asked for exactly once
    // and no file was ever requested.
    expect(source.requests).toStrictEqual(["/latest.json"]);
    // And the page is told what the state is now, so the group is not left
    // describing the moment before the click.
    const status = events.filter((event) => event.type === "corpus_status").at(-1);
    expect(status.status.kind).toBe("check_failed");
  }, HOST_TIMEOUT_MS);

  /**
   * The whole feature, end to end, against a local source: check reports the
   * new version, apply installs it, and the snapshot pointer moves.
   *
   * The assertion that matters most is the request log. `latest.json` is
   * fetched **once**: the apply uses the manifest the check already verified,
   * so it neither re-downloads the manifest nor re-implements the HTTP rules to
   * get one. The two file requests are the corpus itself.
   */
  it("检查 → 更新全流程：清单只取一次，装完 current 指向新快照", async () => {
    const home = await tempDir("eam-corpus-apply-ok-");
    const files = [
      { path: "index.yaml", content: "version: 1\n" },
      { path: "protocols/uart/no-output.md", content: "无输出排查\n" },
    ];
    const source = await publishingSource({ corpusVersion: 2, files });
    const layout = await seedSnapshot(home);
    await writeCorpusConfig(home, source.baseUrl);

    const events = await runHost(
      home,
      [{ cmd: "init", cwd: home }, { cmd: "checkCorpusUpdate" }, { cmd: "applyCorpusUpdate" }],
      {
        until: (all) =>
          all.some((event) => event.type === "corpus_update_result")
          // The status that follows the result is the pair the page renders;
          // the check's own answer is the one before it.
          && all.filter((event) => event.type === "corpus_status").length >= 2,
      },
    );

    const available = events.filter((event) => event.type === "corpus_status")[0];
    expect(available.status).toStrictEqual({
      kind: "update_available",
      corpusVersion: 2,
      fileCount: 2,
      checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    const result = events.find((event) => event.type === "corpus_update_result");
    expect(result).toStrictEqual({ type: "corpus_update_result", ok: true, corpusVersion: 2 });

    // The manifest was requested once — by the check. The apply read it from
    // the cache it had just filled.
    expect(source.requests.filter((url) => url === "/latest.json")).toHaveLength(1);
    expect(source.requests).toStrictEqual([
      "/latest.json",
      "/index.yaml",
      "/protocols/uart/no-output.md",
    ]);

    // Progress came from the kernel's own callback, one event per file, both
    // marked downloaded (the previous snapshot was empty).
    const progress = events.filter((event) => event.type === "corpus_update_progress");
    expect(progress.map((event) => [event.completed, event.total, event.path])).toStrictEqual([
      [1, 2, "index.yaml"],
      [2, 2, "protocols/uart/no-output.md"],
    ]);
    expect(progress.every((event) => event.action === "downloaded")).toBe(true);

    // The pointer moved, and the files really are on disk.
    expect(await readCurrentVersion(layout)).toBe(2);
    const snapshot = path.join(layout.snapshotsDir, "v2");
    expect(await readFile(path.join(snapshot, "index.yaml"), "utf8")).toBe("version: 1\n");
    expect(await readFile(path.join(snapshot, "protocols", "uart", "no-output.md"), "utf8")).toBe(
      "无输出排查\n",
    );
    // The old snapshot is kept (contract §6: keep the previous version).
    expect((await readdir(layout.snapshotsDir)).sort()).toStrictEqual(["v1", "v2"]);

    // And the page is told the new state, not the one from before the click.
    const after = events.filter((event) => event.type === "corpus_status").at(-1);
    expect(after.status.kind).toBe("up_to_date");
    expect(after.status.corpusVersion).toBe(2);
  }, HOST_TIMEOUT_MS);

  /**
   * A second apply after a successful one has nothing to install.
   *
   * The cache was cleared by the install, so this re-checks. The source now
   * offers the version already installed, and the kernel's own "already at this
   * version" refusal is what comes back — not a second download of the same
   * files, and not a success.
   */
  it("装完再点更新：没有可装的版本，如实拒绝且不重复下载", async () => {
    const home = await tempDir("eam-corpus-apply-twice-");
    const files = [{ path: "index.yaml", content: "version: 1\n" }];
    const source = await publishingSource({ corpusVersion: 2, files });
    const layout = await seedSnapshot(home);
    // Already on v2, as if the previous case had run here.
    await ensureSnapshotDir(layout, 2);
    await setCurrent(layout, 2);
    await writeCorpusConfig(home, source.baseUrl);

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "applyCorpusUpdate" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const result = events.find((event) => event.type === "corpus_update_result");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("无需更新");
    // Only the manifest was asked for; not one corpus file.
    expect(source.requests).toStrictEqual(["/latest.json"]);
    expect(events.some((event) => event.type === "corpus_update_progress")).toBe(false);
  }, HOST_TIMEOUT_MS);

  /**
   * A manifest signed by a key the config does not trust.
   *
   * Contract §1's whole reason for signing: the bucket's contents cannot be
   * trusted, so a manifest that does not verify must be reported as
   * `verify_failed` — a different state from `check_failed`, because the cure
   * is different (retrying will fail again; someone has to look at the source).
   * Nothing may be installed.
   */
  it("签名对不上时报 verify_failed，且不下载任何文件", async () => {
    const home = await tempDir("eam-corpus-verify-");
    const other = generateKeyPairSync("ed25519");
    const otherPrivate = String(other.privateKey.export({ type: "pkcs8", format: "pem" }));
    const signed = {
      manifestVersion: 1,
      corpusVersion: 2,
      publishedAt: "2026-10-23T12:00:00Z",
      files: [{ path: "index.yaml", sha256: sha256Of("v2\n") }],
      signature: "",
    };
    const forged = { ...signed, signature: signManifestPayload(signed, otherPrivate) };
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(forged));
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const layout = await seedSnapshot(home);
    await writeCorpusConfig(home, `http://127.0.0.1:${port}/`);

    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "checkCorpusUpdate" }], {
      until: (all) => all.some((event) => event.type === "corpus_status"),
    });

    const answer = events.find((event) => event.type === "corpus_status");
    expect(answer.status.kind).toBe("verify_failed");
    expect(answer.status.reason).toContain("验签失败");
    // Exactly the manifest; the files were never named, so they were never
    // requested.
    expect(requests).toStrictEqual(["/latest.json"]);
    // The installed version did not move.
    expect(await readCurrentVersion(layout)).toBe(1);
  }, HOST_TIMEOUT_MS);
});
