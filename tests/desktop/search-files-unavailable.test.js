import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A stale `dist/` and the `@` popup (D-184 ②, BACKLOG 5.4).
 *
 * D-184 says the host warns once per process and then answers every further
 * query with an empty list, so after missing the first notice the user cannot
 * tell "this project has no matching file" from "search never ran". The
 * intended fix is not a warning per keystroke — that would bury the transcript
 * — but making the state visible *on demand*: the popup is opened again on
 * every keystroke, so it is the surface that has to carry the fact.
 *
 * The host is spawned for real because the stale branch lives in its module
 * graph, not in a pure function: `kernel.filesApi.searchFilesByName` is a
 * namespace member, so "the compiled module lacks the export" has to be
 * produced by an actual `dist/`. The fixture is a temp root holding a copy of
 * `dist/` whose `server/files-api.js` drops that one export, pointed at with
 * `HARNESS_KERNEL_ROOT`. Nothing outside `os.tmpdir()` is written.
 */
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const HOST = path.join(REPO_ROOT, "desktop", "host", "host.js");
const DIST = path.join(REPO_ROOT, "dist");
const DIST_BUILT = existsSync(path.join(DIST, "server", "files-api.js"));
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
 * A kernel root whose compiled file API predates `searchFilesByName`.
 *
 * Only that one export is removed: `registerWorkspaceRoot` / `listDirectory`
 * stay, so the host boots and registers its workspace exactly as it does with
 * a full build — the missing capability under test is the only difference.
 *
 * `node_modules` is a junction to the checkout, not a copy: `dist/` imports
 * `@modelcontextprotocol/client` and `zod`, and a copied tree under
 * `os.tmpdir()` has no package above it. Node resolves through the junction,
 * exactly as in the seeding fixture (`host-seed.test.js`). The kernel is a
 * copy rather than a junction because this test has to *edit* one module.
 */
async function staleKernelRoot() {
  const root = await tempDir("eam-stale-search-kernel-");
  await cp(DIST, path.join(root, "dist"), { recursive: true });
  await symlink(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), "junction");
  const file = path.join(root, "dist", "server", "files-api.js");
  const source = await readFile(file, "utf8");
  expect(source).toContain("export async function searchFilesByName");
  await writeFile(
    file,
    source.replaceAll("searchFilesByName", "searchFilesByNameRemovedInFixture"),
    "utf8",
  );
  return root;
}

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
    let lastCommand;
    const timer = setTimeout(() => {
      child.kill();
      const tail = events.slice(-3).map((event) => JSON.stringify(event).slice(0, 300));
      reject(new Error([
        "host timed out",
        `last command: ${JSON.stringify(lastCommand)}`,
        `last events (${events.length} total): ${tail.join(" | ") || "(none)"}`,
        `process alive: ${child.exitCode === null && child.signalCode === null} (code ${child.exitCode}, signal ${child.signalCode})`,
      ].join("\n")));
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

    for (const command of commands) {
      lastCommand = command;
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }
  });
}

function fileMatches(events) {
  return events.filter((event) => event.type === "file_matches");
}

describe.skipIf(!DIST_BUILT)("旧 dist 下的 @ 文件搜索（D-184 ②）", () => {
  it("每条 file_matches 都带 unavailable:true，不是只靠第一条 notice", async () => {
    const home = await tempDir("eam-stale-search-home-");
    const project = await tempDir("eam-stale-search-project-");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src", "main.c"), "int main(void){}\n", "utf8");
    const kernelRoot = await staleKernelRoot();

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: project },
        // Three keystrokes, the way the popup actually asks.
        { cmd: "searchFiles", query: "m" },
        { cmd: "searchFiles", query: "ma" },
        { cmd: "searchFiles", query: "mai" },
      ],
      {
        env: { HARNESS_KERNEL_ROOT: kernelRoot },
        until: (all) => fileMatches(all).length === 3,
      },
    );

    const answers = fileMatches(events);
    expect(answers.map((answer) => answer.query)).toStrictEqual(["m", "ma", "mai"]);
    // Every answer carries the fact, so the popup can say it on any keystroke.
    // A flag only on the first (or only the notice) leaves keystrokes 2..n
    // indistinguishable from "no matching file" — the exact D-184 complaint.
    expect(answers.every((answer) => answer.unavailable === true)).toBe(true);
    expect(answers.every((answer) => Array.isArray(answer.files) && answer.files.length === 0)).toBe(true);
    // The once-per-process notice is still one per process: the flag is the
    // on-demand answer, not permission to flood the transcript.
    const notices = events.filter(
      (event) => event.type === "notice" && String(event.text).includes("searchFilesByName"),
    );
    expect(notices).toHaveLength(1);
  }, HOST_TIMEOUT_MS);

  it("完整 dist 下不谎报 unavailable", async () => {
    const home = await tempDir("eam-full-search-home-");
    const project = await tempDir("eam-full-search-project-");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src", "main.c"), "int main(void){}\n", "utf8");

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: project },
        { cmd: "searchFiles", query: "main" },
      ],
      { until: (all) => all.some((event) => event.type === "file_matches") },
    );

    const answer = fileMatches(events)[0];
    // The kernel reports the realpath of the workspace (the boundary test runs
    // on physical paths), so compare against that rather than the mkdtemp
    // spelling — Windows temp directories can be 8.3 short names.
    // Entries are `{path, kind?}` since D-184 ①; `kind` is absent on files.
    expect(answer.files).toEqual([{ path: path.join(await realpath(project), "src", "main.c") }]);
    expect(answer.unavailable).toBeUndefined();
  }, HOST_TIMEOUT_MS);
});
