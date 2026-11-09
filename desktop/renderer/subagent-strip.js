/**
 * Pure helpers for the subagent strip above the composer.
 *
 * The strip answers "what is running, and for how long". Both halves are rules
 * rather than drawing, so they live out here where they can be exercised
 * without a DOM — the same reason `plan-summary.js` does. `app.js` owns the
 * elements and the one-second ticker; this module owns what the ticker says.
 */

/**
 * Characters of a run's id shown in a row.
 *
 * A generated id is `sa_` + 12 hex = 15 characters, so this shows every one of
 * them: shortening today's ids would cut three characters off the exact string
 * a reader needs to paste into `subagent_check`. The cap only bites on an id
 * from some future producer that makes them longer.
 */
const LABEL_ID_CHARS = 15;

/**
 * The name a row prints: the caller's `label` when there was one, else the id.
 *
 * The id is printed as an id — shortened with an ellipsis, never passed off as
 * a name the operator chose. Same rule as `summarizeSubagentResult`.
 */
export function subagentName(entry) {
  const label = typeof entry?.label === "string" ? entry.label.trim() : "";
  if (label !== "") return label;
  const id = typeof entry?.id === "string" ? entry.id : "";
  return id.length > LABEL_ID_CHARS ? `${id.slice(0, LABEL_ID_CHARS)}…` : id;
}

/**
 * A duration as `m:ss`, or `null` when there is no usable start time.
 *
 * `null` rather than `0:00`: a clock the kernel never wrote is not a run that
 * just started, and printing zero would be this layer inventing a measurement
 * (R3). The caller draws its "unknown" wording for it.
 *
 * A clock that is negative (a start time in the future — a machine whose clock
 * moved) is reported as zero rather than as a negative duration, because "it
 * has not started yet" is not a thing this strip can say about a run the kernel
 * has already announced.
 *
 * @param {string} startedAt an ISO 8601 timestamp, as the kernel writes it
 * @param {number} now epoch milliseconds
 * @returns {string | null}
 */
export function elapsedClock(startedAt, now) {
  if (typeof startedAt !== "string" || startedAt === "") return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || !Number.isFinite(now)) return null;
  const total = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * How many runs the folded header does not have room to name.
 *
 * The header names one run and counts all of them; `+N` is the rest. Never
 * negative, and never "0 more" — an extra zero on a line whose job is to stay
 * short is noise.
 */
export function subagentOverflow(count) {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return total > 1 ? total - 1 : 0;
}
