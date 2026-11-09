/**
 * The six reasoning-effort tiers, as the renderer sees them.
 *
 * The kernel owns the same list (`EFFORT_TIERS`, `src/config/providers.ts`).
 * This renderer is plain ES modules with no bundler, so it cannot import a
 * TypeScript module; `tests/desktop/effort-slider.test.js` imports both and
 * pins them equal, which is what keeps this copy honest.
 *
 * A tier is UI language, not a protocol value: the host maps each one onto a
 * standard `reasoning_effort` (`extra` / `max` / `galaxy` usually all become
 * `high`). The wire vocabulary stays the kernel's five values.
 */
export const EFFORT_TIERS = ["low", "medium", "high", "extra", "max", "galaxy"];

/**
 * English names, index-aligned with `EFFORT_TIERS`.
 *
 * Display names come from the i18n dictionaries (`effortTierLow` …); these
 * are the fallback for a locale that is missing one, and the key suffix the
 * dictionary entries are derived from.
 */
export const EFFORT_TIER_LABELS = ["Low", "Medium", "High", "Extra", "Max", "Galaxy"];

/**
 * The index of a tier on the track, or -1 when the value is not a tier.
 *
 * -1, not 0, for anything else — `auto`, or (before the host reports tiers) a
 * protocol-only level such as `minimal`. Those are the absence of a tier
 * choice, and returning the low end would paint a selection the request does
 * not carry (R3). Callers draw an unlit ramp for -1.
 */
export function effortTierIndex(tier) {
  return EFFORT_TIERS.indexOf(tier);
}

/**
 * The tier at an index, clamped to the ends of the track.
 *
 * Out-of-range input is clamped rather than returned as `undefined`: the
 * index comes from a range control whose value is user- and keyboard-driven,
 * and a caller that had to null-check would eventually paint `undefined` into
 * a label. The clamp is deliberate and stated here — not a silent fallback.
 * A malformed value (`NaN`) lands on the low end for the same reason.
 */
export function effortTierAt(index) {
  const position = Math.trunc(Number(index));
  if (!Number.isFinite(position)) return EFFORT_TIERS[0];
  return EFFORT_TIERS[Math.min(EFFORT_TIERS.length - 1, Math.max(0, position))];
}
