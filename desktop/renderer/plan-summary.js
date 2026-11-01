/**
 * Pure helpers for the plan strip above the composer.
 *
 * The strip is a second view of the list the transcript's plan card already
 * draws: the card scrolls away exactly when a long run makes it worth
 * watching, so the count and the current step sit next to the input as well.
 * Kept out of `app.js` so the rule that picks the one item worth naming can be
 * tested without a DOM — the same reason `thinking-view.js` and
 * `settings-models.js` exist.
 */

/**
 * Counts plus the item worth naming in a one-line header, or `null` when there
 * is no plan to show.
 *
 * The current item is the one that is running; if nothing is running it is the
 * first item that is not finished, so a plan written before the first update
 * still reads as "about to do X" rather than blank. `index` is `-1` exactly
 * when every item is done, which is how the caller tells "finished" from "the
 * current step has no text".
 *
 * Statuses outside the kernel's three are treated as pending: the protocol
 * layer already normalises them, and a plan whose status went missing is still
 * a plan — dropping the row would hide work the model said it would do.
 */
export function planSummary(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let done = 0;
  let running = -1;
  let next = -1;
  for (let index = 0; index < items.length; index += 1) {
    const status = items[index]?.status;
    if (status === "completed") {
      done += 1;
      continue;
    }
    if (status === "in_progress" && running === -1) running = index;
    if (next === -1) next = index;
  }
  const index = running !== -1 ? running : next;
  // `?? ""` rather than a string cast of whatever is there: a row with no text
  // is a blank header line, not the word "undefined".
  const current = index === -1 ? "" : String(items[index]?.content ?? "");
  return { total: items.length, done, current, index };
}
