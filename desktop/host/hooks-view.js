/**
 * What `/hook` shows: the kernel's own reading of the hooks file, reshaped.
 *
 * Kept out of `host.js` for the same reason `./subagent-session.js` and
 * `./roots.js` are: that module starts the NDJSON loop at module scope and
 * cannot be imported, so a rule living there can only be asserted with a regex
 * over its source. This one is a boundary between the kernel's reader and the
 * transcript row, and it is checked by calling it — with the kernel's real
 * `loadHookConfig`, not a stand-in.
 *
 * **It does not read or validate the file.** `src/hooks/config.ts` is the only
 * validator; a second copy here would be a second answer to "is this config
 * legal". This module only decides what the answer looks like on the wire, and
 * `hooks-host.test.js` still forbids the host's own file from naming the
 * reader or the file — the reader is reached only through the namespace it is
 * handed.
 *
 * Two outcomes, and the difference is the whole point (R3):
 *
 *   - `{ hooks, userConfigPath, projectConfigPath, projectSkipped? }`
 *     — the file was read; `hooks: []` here means "nothing is configured".
 *   - `{ error: { code, message }, userConfigPath, projectConfigPath }`
 *     — the file could not be read or did not validate. There is deliberately
 *     **no `hooks` key**: a broken file answered as an empty list would claim
 *     the opposite of what the user's file says.
 *
 * Nothing writes. Editing stays a hand edit of the file; a slash command that
 * could rewrite it would be a second write surface beside the permission layer.
 */

import path from "node:path";

/**
 * The two files the kernel reads when no explicit paths are given.
 *
 * Reached **only on the error path**: `loadHookConfig` throws before it can
 * return the paths it was about to use, and the answer still has to name them
 * — "which file is broken" is the whole actionable half of the message for a
 * reader who has both a user and a project file. The values are the same two
 * expressions `src/hooks/config.ts` applies as its defaults, and
 * `tests/desktop/hook-command.test.js` reads that file to keep the two in
 * step rather than trusting this comment.
 */
function defaultPaths(home, workdir) {
  return {
    userConfigPath: path.join(home, "hooks.json"),
    projectConfigPath: path.join(workdir, ".harness", "hooks.json"),
  };
}

/**
 * One configured hook, flattened for the transcript row.
 *
 * `source` and `index` are the kernel's own fields — which file, and which
 * entry in that file — and they are what makes a row actionable: two files can
 * hold entries that look identical. `args` travels as its own array; the
 * renderer joins it onto the command for display, because a row that printed
 * only the executable would hide the one argument that says what it does.
 *
 * A field the file did not give is absent rather than defaulted: `matcher`
 * absent means "every tool" and the `timeoutMs` default lives in the runner
 * (`src/hooks/run.ts`), so printing either here would state a value the user
 * never wrote.
 */
export function hookRow(hook) {
  const args = Array.isArray(hook?.args) ? hook.args.map((arg) => String(arg)) : [];
  return {
    event: String(hook?.event ?? ""),
    ...(typeof hook?.matcher === "string" && hook.matcher !== "" ? { matcher: hook.matcher } : {}),
    command: String(hook?.command ?? ""),
    ...(args.length === 0 ? {} : { args }),
    source: hook?.source === "project" ? "project" : "user",
    index: Number.isSafeInteger(hook?.index) ? hook.index : 0,
    ...(typeof hook?.timeoutMs === "number" ? { timeoutMs: hook.timeoutMs } : {}),
  };
}

/**
 * Read the configuration the next run would load, exactly as that run reads it.
 *
 * `includeProject: false` is not a choice this module makes: the desktop host
 * never passes `trustProjectConfig` to the runner either, so a project file is
 * not part of what the next run uses. Reading it here would make `/hook`
 * describe a configuration the run does not have. `projectSkipped` still
 * travels when the kernel reports it — "there is a file here and it is not
 * being loaded" is a different fact from "there is none", and the user has to
 * be able to tell which one they have.
 *
 * `module` is the kernel's hooks namespace (`kernel.hooks`), which is
 * `undefined` when this `dist/` predates `dist/hooks/config.js`. A namespace
 * rather than the function itself so the host never has to name the reader:
 * "the host does not judge this file" stays a property of the source, not just
 * of the call graph.
 *
 * @param {object} input
 * @param {{ loadHookConfig?: unknown } | undefined} input.module
 * @param {string} input.home `$HARNESS_HOME`
 * @param {string} input.workdir the workdir the next session would run under
 * @returns {object | undefined} `undefined` when the kernel has no reader at all
 */
export function hooksView({ module, home, workdir }) {
  const loadHookConfig = module?.loadHookConfig;
  if (typeof loadHookConfig !== "function") return undefined;
  try {
    const loaded = loadHookConfig({ home, workdir, includeProject: false });
    return {
      hooks: (Array.isArray(loaded?.hooks) ? loaded.hooks : []).map(hookRow),
      userConfigPath: String(loaded?.userConfigPath ?? ""),
      projectConfigPath: String(loaded?.projectConfigPath ?? ""),
      ...(typeof loaded?.projectSkipped === "string" && loaded.projectSkipped !== ""
        ? { projectSkipped: loaded.projectSkipped }
        : {}),
    };
  } catch (error) {
    // `HookConfigError`'s message is the actionable half — it names the file
    // and the entry (`hooks[0].macher`) — so it is passed through untouched.
    // Anything else is a genuine surprise and its own message is still the
    // honest answer.
    return {
      error: {
        code: typeof error?.code === "string" ? error.code : "read_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      ...defaultPaths(home, workdir),
    };
  }
}

/**
 * The two default paths, for the answer a kernel without a reader gets.
 *
 * Same values and same reason as `defaultPaths` above; exported because that
 * answer is built in `host.js`, which cannot compose them itself without
 * restating the defaults the kernel owns.
 */
export function hooksDefaultPaths(home, workdir) {
  return defaultPaths(home, workdir);
}
