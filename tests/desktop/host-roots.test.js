import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KERNEL_ROOT_ENV,
  kernelMissingMessage,
  RESOURCES_PATH_ENV,
  resolveRoots,
} from "../../desktop/host/roots.js";

const here = path.join(import.meta.dirname, "..", "..", "desktop", "host");
const HOST = path.join(here, "host.js");
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
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

describe("resolveRoots", () => {
  it("开发形态回落到 host 的上两级，dist 在它下面", () => {
    const roots = resolveRoots({ here, env: {} });
    // `desktop/host/` → the checkout root, which is where `dist/` lives.
    expect(roots.distParent).toBe(REPO_ROOT);
    expect(roots.distDir).toBe(path.join(REPO_ROOT, "dist"));
    expect(roots.entry).toBe(path.join(REPO_ROOT, "dist", "index.js"));
    expect(roots.form).toBe("development");
  });

  it("打包形态用 resourcesPath，而不是 host 自己的位置", () => {
    const resources = path.join(path.sep === "/" ? "/" : "C:\\", "app", "resources");
    const roots = resolveRoots({ here, resourcesPath: resources, env: {} });
    // Packaged, `desktop/` and `dist/` both sit under `resources/`: `../../`
    // from the host would name the app bundle, which holds no `dist/`.
    expect(roots.distParent).toBe(path.resolve(resources));
    expect(roots.entry).toBe(path.join(path.resolve(resources), "dist", "index.js"));
    expect(roots.form).toBe("packaged");
  });

  it("HARNESS_KERNEL_ROOT 优先于 resourcesPath 与开发回落", () => {
    const override = path.join(path.sep === "/" ? "/" : "C:\\", "kernels", "under-test");
    const roots = resolveRoots({
      here,
      resourcesPath: path.join(path.sep === "/" ? "/" : "C:\\", "app", "resources"),
      env: { [KERNEL_ROOT_ENV]: override },
    });
    expect(roots.distParent).toBe(path.resolve(override));
    expect(roots.entry).toBe(path.join(path.resolve(override), "dist", "index.js"));
    // The message follows the source: an override that is wrong is the
    // operator's to fix, so it must not be reported as a broken install.
    expect(roots.form).toBe("override");
  });

  it("空串与纯空白的覆盖值等于没设", () => {
    const roots = resolveRoots({ here, resourcesPath: "", env: { [KERNEL_ROOT_ENV]: "   " } });
    expect(roots.form).toBe("development");
    expect(roots.distParent).toBe(REPO_ROOT);
  });

  it("各形态的提示区分构建与安装", () => {
    const entry = path.join(REPO_ROOT, "dist", "index.js");
    expect(kernelMissingMessage("development", entry)).toContain("npm run build");
    expect(kernelMissingMessage("packaged", entry)).toContain("重新安装");
    expect(kernelMissingMessage("packaged", entry)).not.toContain("npm run build");
    expect(kernelMissingMessage("override", entry)).toContain(KERNEL_ROOT_ENV);
    // All three name the path that was looked at: "not found" alone leaves the
    // operator guessing which copy was consulted.
    for (const form of ["development", "packaged", "override"]) {
      expect(kernelMissingMessage(form, entry)).toContain(entry);
    }
  });
});

/**
 * Start the host and collect its stdout until it exits.
 *
 * The cases below end the process themselves (a missing kernel exits 1), so
 * this waits for exit rather than for an event. `HARNESS_HOME` and
 * `AGENTS_HOME` are always pointed at a temp directory for the same reason
 * `host.test.js` does it: a test process must never read or write the
 * machine's real `~/.harness` or `~/.agents/skills`, even when the case is
 * expected to die before either is touched.
 */
function runToExit(env, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: here,
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
      reject(new Error(`host did not exit; events: ${events.map((event) => event.type).join(",")}`));
    }, 20_000);

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
    });
    child.stderr.on("data", (chunk) => events.push({ type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, events });
    });
    child.stdin.end();
  });
}

describe("host kernel lookup", () => {
  it("找不到内核入口时发 fatal 并以非零码退出，而不是抛模块错误", async () => {
    // An empty directory stands in for both layouts: there is no `dist/` in
    // it, so the host must say so in the terms of the shape it resolved.
    const empty = await tempDir("eam-kernel-missing-");
    const { code, events } = await runToExit({ [KERNEL_ROOT_ENV]: empty }, await tempDir("eam-home-"));

    const fatal = events.find((event) => event.type === "fatal");
    expect(fatal).toBeDefined();
    expect(fatal.message).toContain(path.join(empty, "dist", "index.js"));
    expect(fatal.message).toContain(KERNEL_ROOT_ENV);
    // Nothing else ran: no half-booted handshake on top of a failure.
    expect(events.some((event) => event.type === "hello")).toBe(false);
    expect(events.some((event) => event.type === "unparsed")).toBe(false);
    expect(code).toBe(1);
  }, 30_000);

  it("打包形态缺内核时提示重新安装（与开发形态的措辞不同）", async () => {
    const empty = await tempDir("eam-kernel-packaged-");
    const { code, events } = await runToExit({ [RESOURCES_PATH_ENV]: empty }, await tempDir("eam-home-"));

    const fatal = events.find((event) => event.type === "fatal");
    expect(fatal.message).toContain("重新安装");
    expect(fatal.message).not.toContain("npm run build");
    expect(fatal.message).toContain(path.join(empty, "dist", "index.js"));
    expect(code).toBe(1);
  }, 30_000);

  it.runIf(existsSync(path.join(REPO_ROOT, "dist", "index.js")))(
    "HARNESS_KERNEL_ROOT 指向另一份内核时，宿主从那里加载",
    async () => {
      // The sentinel exists, so the host goes on to import. A `resourcesPath`
      // that holds no kernel is passed beside the override on purpose: if the
      // override lost, this run would stop at the packaged branch's fatal.
      const empty = await tempDir("eam-kernel-shadowed-");
      const home = await tempDir("eam-home-");
      const { events } = await runToExit(
        { [KERNEL_ROOT_ENV]: REPO_ROOT, [RESOURCES_PATH_ENV]: empty },
        home,
      );
      expect(events.some((event) => event.type === "fatal")).toBe(false);
      expect(events[0]?.type).toBe("hello");
    },
    30_000,
  );
});
