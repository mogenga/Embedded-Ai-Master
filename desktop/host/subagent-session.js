/**
 * Where a subagent's session lives, and why that is a path rule of its own.
 *
 * The host resolves every session with `path.join(sessionsRoot, id)` and is
 * safe only because `isValidSessionId` rejects anything with a separator in it.
 * A subagent session is **two** segments (`<parent>/subagents/<child>`), so the
 * same join would have to take a user-supplied string and split it — and one
 * thing that can become two path segments is exactly the shape a traversal
 * needs.
 *
 * So the two ids are validated *separately* and `subagents` stays a literal.
 * There is no third segment and no way to address one: both halves must be a
 * single valid id, which by construction contains no `/`, no `\` and no `..`.
 *
 * Kept out of `host.js` for one reason: that module starts the NDJSON loop at
 * module scope and cannot be imported, so a rule living there can only be
 * asserted with a regex over its source. This one is a boundary — it is
 * checked by calling it. Same reason and same shape as `./roots.js`.
 */

import path from "node:path";

/** The literal between the two ids. Not user input, and never assembled. */
const SUBAGENTS_SEGMENT = "subagents";

/**
 * The directory of `childId` under `parentId`, or `undefined` when either id is
 * not one the kernel would accept.
 *
 * `isValidSessionId` is a parameter rather than an import: its definition is
 * the kernel's (`src/session/handle.ts`), and a second copy here would be a
 * second answer to "is this a session id" — the host passes the same function
 * it uses for every other session lookup, and the tests pass the real one.
 *
 * @param {object} input
 * @param {string} input.sessionsRoot
 * @param {unknown} input.parentId
 * @param {unknown} input.childId
 * @param {(id: unknown) => boolean} input.isValidSessionId
 * @returns {string | undefined}
 */
export function subagentSessionDir({ sessionsRoot, parentId, childId, isValidSessionId }) {
  if (!isValidSessionId(parentId) || !isValidSessionId(childId)) return undefined;
  return path.join(sessionsRoot, parentId, SUBAGENTS_SEGMENT, childId);
}
