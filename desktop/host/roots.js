/**
 * Where the compiled kernel lives, and how that was decided.
 *
 * The host consumes the kernel through its compiled `dist/` modules, so it
 * needs one fact before anything else: the directory that contains `dist/`.
 * That is not always the repository root — a packaged install ships `desktop/`
 * and `dist/` under `resources/`, where `../../` from the host's own file is
 * the app bundle rather than the checkout — so the answer is resolved here, in
 * one place, instead of being inferred ad hoc at import time.
 *
 * Precedence:
 *
 * 1. `HARNESS_KERNEL_ROOT` — an operator pointing the host at a kernel on
 *    purpose (a second checkout, a build under test).
 * 2. `resourcesPath` — the packaged layout, supplied by the Electron main
 *    process. It is passed down rather than read here because the host cannot
 *    tell a packaged install from `electron .` on its own: a development host
 *    (also started with `ELECTRON_RUN_AS_NODE=1`) sees a `resourcesPath` too,
 *    and it points at Electron's own `dist/resources` — measured as
 *    `<repo>/desktop/node_modules/electron/dist/resources`, which holds no
 *    kernel. Reading that property in the host would pick the packaged branch
 *    on every dev run.
 * 3. The checkout layout — `../../` from `desktop/host/`, the directory that
 *    holds `dist/` in a working tree.
 *
 * Everything here is pure: every input is a parameter, so precedence can be
 * tested without spawning a process or touching the real layout.
 */

import path from "node:path";

/** Operator override: the directory that contains `dist/`. */
export const KERNEL_ROOT_ENV = "HARNESS_KERNEL_ROOT";

/** Packaged layout; the main process passes `process.resourcesPath` here. */
export const RESOURCES_PATH_ENV = "HARNESS_RESOURCES_PATH";

/** The compiled kernel's entry, used as the sentinel that a build exists. */
export const KERNEL_ENTRY = path.join("dist", "index.js");

/** Empty and whitespace-only values mean "not set", not "use the empty path". */
function given(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

/**
 * Resolve the directory that contains `dist/`.
 *
 * Named for what it returns, not for the repository: `distParent` is the
 * checkout root in development and `resources/` in a packaged install, and the
 * two only coincide by accident.
 *
 * @param {object} input
 * @param {string} input.here Directory of the running host module.
 * @param {string} [input.resourcesPath] `process.resourcesPath` from the main process.
 * @param {Record<string, string | undefined>} [input.env]
 * @returns {{ distParent: string, distDir: string, entry: string, form: "override" | "packaged" | "development" }}
 */
export function resolveRoots({ here, resourcesPath, env = {} }) {
  const override = given(env[KERNEL_ROOT_ENV]);
  const packaged = given(resourcesPath);
  const form = override ? "override" : packaged ? "packaged" : "development";
  const distParent =
    form === "override"
      ? path.resolve(override)
      : form === "packaged"
        ? path.resolve(packaged)
        : path.resolve(here, "..", "..");
  const distDir = path.join(distParent, "dist");
  return { distParent, distDir, entry: path.join(distDir, "index.js"), form };
}

/**
 * The `fatal` text for a kernel entry that is not on disk.
 *
 * The two shipped layouts need different cures — a dev checkout is missing a
 * build, an installed app is missing files — so the message names the one the
 * operator can act on. Both carry the path that was looked at: a message that
 * only says "not found" leaves them guessing which copy was consulted.
 *
 * @param {"override" | "packaged" | "development"} form
 * @param {string} entry
 */
export function kernelMissingMessage(form, entry) {
  if (form === "packaged") {
    return `安装可能不完整：缺少内核产物 ${entry}，请重新安装`;
  }
  if (form === "override") {
    return `找不到内核产物 ${entry}（来自环境变量 ${KERNEL_ROOT_ENV}）。请确认它指向包含 dist/ 的目录，或先在仓库根目录运行 npm run build`;
  }
  return `找不到内核产物 ${entry}，请在仓库根目录运行 npm run build 后重试`;
}
