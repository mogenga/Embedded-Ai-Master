import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RESOURCES_PATH_ENV } from "../../desktop/host/roots.js";

/**
 * First-run seeding as the host actually runs it.
 *
 * The two halves are driven through a real host process, because the unit tests
 * in `tests/corpus-seed.test.ts` cannot see the wiring that decides *what* the
 * host passes: which `resourcesRoot` a packaged install gets, and that the
 * `kb/current` handed to `seedKbMcpEntry` is the layout one rather than a path
 * spelled out again here.
 *
 * **Two layouts, two expected outcomes**, and that is the point:
 *
 * - Packaged (`HARNESS_RESOURCES_PATH` set) — `resources/` is both the kernel
 *   root and the corpus root, so a fresh home gets `snapshots/v1`, a `current`
 *   junction, an `inbox/`, and a `kb` entry in `mcp.json`. This is the case the
 *   whole task exists for: a new install has a knowledge base without the
 *   operator copying anything.
 * - Development — the same home is untouched apart from the `mcp` entry, which
 *   the kernel skips because there is no `current`. A developer's `~/.harness`
 *   must not be filled with a shipped corpus that then looks like an OTA result.
 *
 * Nothing here reads the real `~/.harness`, no corpus file leaves a temp
 * directory, and no request is made: seeding is pure filesystem work.
 */

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const HOST = path.join(REPO_ROOT, "desktop", "host", "host.js");
const DIST = path.join(REPO_ROOT, "dist");
const DIST_MCP = path.join(REPO_ROOT, "dist-mcp");

/** Both builds are needed: the corpus half is `dist/corpus/seed.js`, the MCP
 *  entry half insists on a real `dist-mcp/kb/server.js` before writing. */
const SEED_BUILT = existsSync(path.join(DIST, "corpus", "seed.js"))
  && existsSync(path.join(DIST, "corpus", "snapshot.js"))
  && existsSync(path.join(DIST, "index.js"));
const MCP_SERVER_BUILT = existsSync(path.join(DIST_MCP, "kb", "server.js"));

const HOST_TIMEOUT_MS = 30_000;
const tempDirs = [];

afterEach(async () => {
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
 * A directory shaped like a packaged install: `dist/`, `dist-mcp/` and
 * `resources/corpus/` side by side under one `resources/` root.
 *
 * `dist/` and `dist-mcp/` are **junctions to the checkout**, not copies. A copy
 * would break module resolution: `dist/mcp/manager.js` imports
 * `@modelcontextprotocol/client`, and a copied tree under `os.tmpdir()` has no
 * `node_modules` above it. Node resolves through the junction to the checkout,
 * so the imports behave exactly as they do in a real install (which ships its
 * own `node_modules`).
 *
 * The corpus, by contrast, is a real directory of synthetic files — it must be
 * independent of anything the checkout holds, because the assertions are about
 * what the host *copied out of it*. No real shipped content is involved.
 */
async function packagedResources(corpusFiles) {
  const resources = await tempDir("eam-seed-resources-");
  await symlink(DIST, path.join(resources, "dist"), "junction");
  await symlink(DIST_MCP, path.join(resources, "dist-mcp"), "junction");
  const corpus = path.join(resources, "corpus");
  await mkdir(corpus, { recursive: true });
  for (const [relative, content] of Object.entries(corpusFiles)) {
    const target = path.join(corpus, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return resources;
}

/**
 * Start the host, wait for the handshake, then stop it.
 *
 * `ready` is the finish line on purpose: seeding is parked after it, so a run
 * that stops at `ready` would race the corpus copy. Waiting for `getKb` — which
 * the host makes settle the seed first — is what makes the assertions below
 * about *completed* work rather than about work in flight.
 */
function runHost(home, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: path.dirname(HOST),
      env: {
        ...process.env,
        HARNESS_HOME: home,
        AGENTS_HOME: path.join(home, ".agents-fixture"),
        ...env,
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
      if (events.some((event) => event.type === "kb")) {
        child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      }
    });
    child.stderr.on("data", (chunk) => events.push({ type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(events);
    });

    child.stdin.write(`${JSON.stringify({ cmd: "init", cwd: home })}\n`);
    child.stdin.write(`${JSON.stringify({ cmd: "getKb" })}\n`);
  });
}

describe.skipIf(!SEED_BUILT || !MCP_SERVER_BUILT)("first-run seeding (packaged)", () => {
  it("全新安装：内置语料物化成 v1，current/inbox 就位，kb 条目指向它", async () => {
    const resources = await packagedResources({
      "index.yaml": "version: 1\n",
      "protocols/uart/no-output.md": "# 无输出\n",
      // A shipped manifest decides the directory name; the version is what the
      // OTA client will later compare against (contract §4), so it must be the
      // one the package claims, not a number invented here.
      "latest.json": JSON.stringify({
        manifestVersion: 1,
        corpusVersion: 3,
        publishedAt: "2026-10-23T12:00:00Z",
        files: [
          { path: "index.yaml", sha256: "0".repeat(64) },
          { path: "protocols/uart/no-output.md", sha256: "1".repeat(64) },
        ],
        signature: "AAAA",
      }),
    });
    const home = await tempDir("eam-seed-home-");

    const events = await runHost(home, {
      [RESOURCES_PATH_ENV]: resources,
      // An operator with this exported would have seeding skip by design, and
      // the run would then assert nothing about the packaged path.
      KB_ROOT: "",
    });

    expect(events.some((event) => event.type === "fatal")).toBe(false);
    expect(events.some((event) => event.type === "unparsed")).toBe(false);
    expect(events.some((event) => event.type === "ready")).toBe(true);

    const kbRoot = path.join(home, "kb");
    const snapshot = path.join(kbRoot, "snapshots", "v3");
    expect(existsSync(path.join(snapshot, "index.yaml"))).toBe(true);
    expect(existsSync(path.join(snapshot, "protocols", "uart", "no-output.md"))).toBe(true);
    // The manifest is not part of a snapshot: OTA never writes one there, and
    // contract §5 says materialising and updating must produce the same shape.
    expect(existsSync(path.join(snapshot, "latest.json"))).toBe(false);
    expect(existsSync(path.join(kbRoot, "inbox"))).toBe(true);

    const document = JSON.parse(await readFile(path.join(home, "mcp.json"), "utf8"));
    expect(Object.keys(document.mcpServers)).toStrictEqual(["kb"]);
    const entry = document.mcpServers.kb;
    expect(entry.env.KB_ROOT).toBe(path.join(kbRoot, "current"));
    expect(entry.env.KB_INBOX_PATH).toBe(path.join(kbRoot, "inbox", "_inbox.md"));
    expect(entry.env.ELECTRON_RUN_AS_NODE).toBe("1");
    // The packaged kernel root, not the checkout: `resources/dist-mcp/...`.
    expect(entry.args).toStrictEqual([path.join(resources, "dist-mcp", "kb", "server.js")]);
    expect(entry.command).toBe(process.execPath);

    // And the page reads the same root back, `mcp.json` included.
    const kbEvent = events.find((event) => event.type === "kb");
    expect(kbEvent.kb.source).toBe("mcp.json");
    expect(kbEvent.kb.root).toBe(path.join(kbRoot, "current"));
    expect(kbEvent.kb.fileCount).toBe(1);
  }, HOST_TIMEOUT_MS);

  it("内置语料没有 latest.json：版本按 1 物化，且不伪造清单", async () => {
    const resources = await packagedResources({ "index.yaml": "version: 1\n" });
    const home = await tempDir("eam-seed-home-");

    const events = await runHost(home, { [RESOURCES_PATH_ENV]: resources, KB_ROOT: "" });

    const snapshot = path.join(home, "kb", "snapshots", "v1");
    expect(existsSync(path.join(snapshot, "index.yaml"))).toBe(true);
    // A client-computed manifest would carry no signature and be rejected by
    // verification; `readCorpusStatus` reporting `bundled` is the honest state.
    expect(existsSync(path.join(snapshot, "latest.json"))).toBe(false);
    expect(events.some((event) => event.type === "notice" && event.text.includes("内置知识库"))).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("内置语料坏掉时如实告警，但不阻断启动", async () => {
    const resources = await packagedResources({
      "index.yaml": "version: 1\n",
      // A malformed manifest is a broken package, not "no manifest": silently
      // treating it as version 1 would name a snapshot after a number the
      // package never claimed.
      "latest.json": "{ not json",
    });
    const home = await tempDir("eam-seed-home-");

    const events = await runHost(home, { [RESOURCES_PATH_ENV]: resources, KB_ROOT: "" });

    const notice = events.find(
      (event) => event.type === "notice" && event.text.includes("内置知识库初始化失败"),
    );
    expect(notice?.level).toBe("warn");
    expect(notice.text).toContain("latest.json");
    // Boot completed anyway: a corpus that could not be unpacked is a thing to
    // report, not a reason to refuse the window.
    expect(events.some((event) => event.type === "ready")).toBe(true);
    expect(events.some((event) => event.type === "fatal")).toBe(false);
    expect(existsSync(path.join(home, "kb"))).toBe(false);
    // No half-written entry either: the MCP half needs `current`, which the
    // failed seed never created.
    expect(existsSync(path.join(home, "mcp.json"))).toBe(false);
  }, HOST_TIMEOUT_MS);
});

describe.skipIf(!SEED_BUILT)("first-run seeding (development)", () => {
  it("开发形态一个字节都不塞进 home：没有 kb/，也没有 mcp.json", async () => {
    const home = await tempDir("eam-seed-home-");

    const events = await runHost(home, { KB_ROOT: "" });

    expect(events.some((event) => event.type === "ready")).toBe(true);
    expect(existsSync(path.join(home, "kb"))).toBe(false);
    expect(existsSync(path.join(home, "mcp.json"))).toBe(false);
    // Skipping is silent: nothing here is the operator's problem.
    expect(events.some((event) => event.type === "notice" && event.text.includes("知识库"))).toBe(false);
  }, HOST_TIMEOUT_MS);
});
