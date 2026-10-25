/**
 * Pure helpers for the transcript's `data-view` preference and the per-block
 * thinking toggle.
 *
 * Kept out of `app.js` / `settings.js` so the two rules that are easy to get
 * wrong can be tested without a DOM: which stored view values still mean
 * something, and what a toggle click does to a block's `data-expanded`. Nothing
 * here touches `document`, so a Node test can import it — the same reason
 * `settings-models.js` exists.
 */

/**
 * The view preference as a value that still drives something.
 *
 * There used to be three: `normal` hid finished reasoning, `thinking` showed
 * it, and `verbose` showed it *and* opened every tool result on arrival. A
 * reasoning block now folds on its own header button, so nothing reads it for
 * thinking any more — a view switch could only apply to every block at once,
 * which is not the question the reader is asking. What survives is the tool
 * output half.
 *
 * `thinking` therefore collapses to `normal` rather than being kept as a
 * third value no rule consults: a stored preference that changes nothing is a
 * control that lies about what it does (R3). Unknown values do the same,
 * which is what makes this total rather than a whitelist with holes.
 */
export function normalizeTranscriptView(value) {
  return value === "verbose" ? "verbose" : "normal";
}

/**
 * The expansion state a toggle click lands on.
 *
 * The block owns its state in `data-expanded` (`"true"` / `"false"`); the
 * button flips it. Anything that is not exactly `"true"` counts as folded —
 * the attribute is read back from the DOM, and a missing or mistyped value
 * must not leave a block that cannot be opened.
 */
export function nextThinkingExpanded(currentAttribute) {
  return currentAttribute !== "true";
}

/**
 * Whether a block that just finished streaming stays open.
 *
 * A finished thought folds to one line — that is the settled shape, and the
 * reader opens the ones they want. But a reader who already clicked the header
 * while the model was still thinking asked to see *this* block: snapping it
 * shut the instant the thought ends would undo their click a second later.
 * So the automatic fold yields to an explicit choice; only an untouched block
 * folds itself.
 *
 * `userToggled` is `"true"` once the reader has clicked this block's header;
 * `expanded` is the state that click left it in. Both live on the node, so one
 * block's choice never touches another's.
 */
export function thinkingExpandedOnEnd(expanded, userToggled) {
  if (userToggled === "true") return expanded === "true";
  return false;
}
