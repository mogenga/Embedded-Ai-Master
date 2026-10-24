import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The toolchain-pack commands (`getPacks` / `getPackCatalog` /
 * `installFromManifest` / `removePack` / `verifyPack` / `prunePacks`) driven
 * through a real host process.
 *
 * Same three rules as `host-corpus.test.js`:
 *
 * 1. **Nothing leaves the machine.** The install path is exercised through
 *    `installFromManifest` with a local archive — the transaction, the member
 *    checks and the validation all run, but the bytes come from a file this
 *    test made. `installPack {id}` is only probed with an id that cannot exist.
 * 2. **Every home is a temp directory.** `HARNESS_HOME` and
 *    `HARNESS_TOOLCHAIN_HOME` both point at `mkdtemp` output (D-170).
 * 3. **The message shapes are asserted against what settings.js consumes** —
 *    the renderer is the contract here, not A's host.
 */
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const HOST = path.join(REPO_ROOT, "desktop", "host", "host.js");
const PACKS_BUILT = existsSync(path.join(REPO_ROOT, "dist", "packs", "registry.js"));
const TARBINARY = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const OFFLINE_INSTALLABLE = PACKS_BUILT && process.platform === "win32" && existsSync(TARBINARY);

const HOST_TIMEOUT_MS = 60_000;

const tempDirs = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Run a real host process and collect every NDJSON event it emits until the
 * caller's condition is met (or the process exits on its own).
 */
function runHost(home, commands, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: path.dirname(HOST),
      env: {
        ...process.env,
        ...(options.env ?? {}),
        HARNESS_HOME: home,
        HARNESS_TOOLCHAIN_HOME: options.toolchainHome ?? home,
        AGENTS_HOME: path.join(home, ".agents-fixture"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let buffer = "";
    let stopped = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`host timed out; events: ${events.map((event) => event.type).join(",")}`));
    }, HOST_TIMEOUT_MS);

    const maybeStop = () => {
      if (!stopped && options.until !== undefined && options.until(events)) {
        stopped = true;
        child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      }
    };

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
      maybeStop();
    });
    child.stderr.on("data", (chunk) => events.push({ type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(events);
    });

    for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`);
    maybeStop();
  });
}

const eventsOf = (events, type) => events.filter((event) => event.type === type);

describe.skipIf(!PACKS_BUILT)("packs: page queries", () => {
  it("getPacks 回一条含根目录、磁盘占用与列表的 packs 消息", async () => {
    const home = await tempDir("eam-packs-empty-");
    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getPacks" }], {
      until: (collected) => collected.some((event) => event.type === "packs"),
    });

    const packsEvents = eventsOf(events, "packs");
    expect(packsEvents.length).toBe(1);
    const message = packsEvents[0];
    expect(message.root).toBe(home);
    expect(typeof message.totalBytes).toBe("number");
    expect(message.packs).toEqual([]);
    // 元数据表随消息到达：探测区靠它渲染，缺了它整段空白。
    expect(Array.isArray(message.toolchains)).toBe(true);
    expect(message.toolchains.length).toBeGreaterThan(0);
    expect(message.toolchains[0]).toMatchObject({ kind: expect.any(String), label: expect.any(String) });
  });

  it("getPackCatalog 的条目带安装前显示所需的全部字段", async () => {
    const home = await tempDir("eam-packs-catalog-");
    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "getPackCatalog" }], {
      until: (collected) => collected.some((event) => event.type === "pack_catalog"),
    });

    const catalogEvents = eventsOf(events, "pack_catalog");
    expect(catalogEvents.length).toBe(1);
    const entries = catalogEvents[0].entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        version: expect.any(String),
        downloadBytes: expect.any(Number),
        provides: expect.any(Array),
        installable: expect.any(Boolean),
      });
      expect(entry.installable).toBe(true);
    }
    // 目录条目里必有 Ninja——它是 e2e 与手测的最小验证对象。
    expect(entries.some((entry) => entry.id === "ninja-1.13.2-win32-x64")).toBe(true);
  });

  it("installPack 对目录里不存在的 id 回 pack_error，而不是静默", async () => {
    const home = await tempDir("eam-packs-unknown-");
    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "installPack", id: "no-such-pack" }], {
      until: (collected) => collected.some((event) => event.type === "pack_error"),
    });

    const errors = eventsOf(events, "pack_error");
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/no such pack in the catalog/);
  });

  it("verifyPack 对不存在的 pack 回 pack_verified {ok:false} 并指名道姓", async () => {
    const home = await tempDir("eam-packs-verify-none-");
    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "verifyPack", id: "ghost" }], {
      until: (collected) => collected.some((event) => event.type === "pack_verified"),
    });

    const verified = eventsOf(events, "pack_verified");
    expect(verified.length).toBe(1);
    expect(verified[0].ok).toBe(false);
    expect(verified[0].problems[0]).toMatch(/pack\.json is missing/);
  });

  it("prunePacks 在干净根目录上回 pack_pruned {removed:0}", async () => {
    const home = await tempDir("eam-packs-prune-");
    const events = await runHost(home, [{ cmd: "init", cwd: home }, { cmd: "prunePacks" }], {
      until: (collected) => collected.some((event) => event.type === "pack_pruned"),
    });

    const pruned = eventsOf(events, "pack_pruned");
    expect(pruned.length).toBe(1);
    expect(pruned[0]).toMatchObject({ removed: 0, bytes: 0 });
  });
});

describe.skipIf(!OFFLINE_INSTALLABLE)("packs: offline install transaction", () => {
  /**
   * A hand-made pack: one archive holding `payload/bin/probe.exe` (a copy of
   * the system tar, so the validation phase runs a real executable whose
   * `--version` output is known) plus the `pack.json` that describes it.
   */
  async function makeOfflinePack(home) {
    const dir = await tempDir("eam-packs-src-");
    mkdirSync(path.join(dir, "payload", "bin"), { recursive: true });
    copyFileSync(TARBINARY, path.join(dir, "payload", "bin", "probe.exe"));

    const manifest = {
      schema: 1,
      id: "offline-probe-1.0-win32-x64",
      name: "Offline Probe",
      version: "1.0",
      provider: "test",
      platform: "win32",
      arch: "x64",
      installedAt: "2026-10-25T00:00:00.000Z",
      sources: [
        {
          url: "https://example.com/probe.zip",
          archive: "zip",
          sha256: "",
          bytes: 0,
          hosts: ["example.com"],
        },
      ],
      license: { name: "Apache-2.0", url: "https://example.com/license", separateProcess: true },
      provides: ["probe"],
      executables: [{ name: "probe", path: "bin/probe.exe", toolchain: "probe" }],
      env: { pathPrepend: ["payload/bin"], vars: {} },
      validation: { command: "bin/probe.exe", args: ["--version"], expect: "bsdtar" },
      payload: { root: "payload", files: 0, bytes: 0, treeHash: "" },
    };
    const manifestPath = path.join(dir, "pack.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // 压缩 payload 目录：成员形如 payload/bin/probe.exe，与厂商归档同构
    // （单顶层目录，安装器剥掉这一层）。
    const archive = path.join(dir, "probe.zip");
    const tar = spawn(TARBINARY, ["-a", "-cf", archive, "payload"], { cwd: dir, stdio: "ignore" });
    await new Promise((resolve, reject) => {
      tar.on("error", reject);
      tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });

    // 允许离线安装：sha256 与 bytes 按真实归档补齐（安装器仍会校验）。
    const bytes = readFileSync(archive);
    const { createHash } = await import("node:crypto");
    manifest.sources[0].sha256 = createHash("sha256").update(bytes).digest("hex");
    manifest.sources[0].bytes = bytes.length;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return { manifestPath, archive, id: manifest.id };
  }

  it("installFromManifest 走完九阶段事务并广播进度序列", async () => {
    const home = await tempDir("eam-packs-install-");
    const pack = await makeOfflinePack(home);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "installFromManifest", path: pack.manifestPath, files: [pack.archive] },
      ],
      {
        until: (collected) => collected.some((event) => event.type === "pack_installed" || event.type === "pack_error"),
      },
    );

    const errors = eventsOf(events, "pack_error");
    expect(errors, JSON.stringify(errors)).toEqual([]);

    // 进度序列必须以 preflight 开始、以 commit 结束；中间至少经过下载与
    // 解压——阶段被砍掉的"优化"会让这条断言立刻失败。
    const phases = eventsOf(events, "pack_progress").map((event) => event.phase);
    expect(phases[0]).toBe("preflight");
    expect(phases).toContain("download");
    expect(phases).toContain("extract");
    expect(phases[phases.length - 1]).toBe("commit");

    const installed = eventsOf(events, "pack_installed");
    expect(installed.length).toBe(1);
    expect(installed[0].id).toBe(pack.id);
  });

  it("装好的 pack 出现在 packs 消息里，卸载后消失且目录无残留", async () => {
    const home = await tempDir("eam-packs-lifecycle-");
    const pack = await makeOfflinePack(home);

    const installEvents = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "installFromManifest", path: pack.manifestPath, files: [pack.archive] },
        { cmd: "getPacks" },
      ],
      {
        until: (collected) => {
          const packsEvents = collected.filter((event) => event.type === "packs");
          return packsEvents.some((event) => (event.packs ?? []).some((item) => item.manifest.id === pack.id));
        },
      },
    );
    expect(eventsOf(installEvents, "pack_error")).toEqual([]);
    const listed = eventsOf(installEvents, "packs")
      .flatMap((event) => event.packs ?? [])
      .find((item) => item.manifest.id === pack.id);
    expect(listed).toMatchObject({ status: "ok", manifest: { name: "Offline Probe", version: "1.0" } });

    // 卸载（armed 两段式确认在渲染器，宿主收到的已是最终请求）。
    const packRoot = path.join(home, "packs", pack.id);
    expect(existsSync(packRoot)).toBe(true);
    const removeEvents = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "removePack", id: pack.id },
      ],
      {
        until: (collected) => {
          const packsEvents = collected.filter((event) => event.type === "packs");
          return packsEvents.some((event) => (event.packs ?? []).length === 0 && (event.packs ?? []) !== undefined && event.root === home);
        },
      },
    );
    expect(eventsOf(removeEvents, "pack_error")).toEqual([]);
    expect(existsSync(packRoot), "卸载后目录必须无残留").toBe(false);
  });
});