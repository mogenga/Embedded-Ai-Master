/**
 * The six reasoning-effort tiers, as the renderer sees them.
 *
 * The kernel owns the same list (`EFFORT_TIERS`, `src/config/providers.ts`).
 * This renderer is plain ES modules with no bundler, so it cannot import a
 * TypeScript module; `tests/desktop/effort-slider.test.js` imports both and
 * pins them equal, which is what keeps this copy honest.
 *
 * **That pin is the only reason this file still exists** (2026-11-10). Nothing
 * in `desktop/` reads it: the tier names come from the host's
 * `effortChoices.stops[i].label`, and the renderer converts a stop to a track
 * index with `effortStopIndex` (a `findIndex` over that list) rather than an
 * index into a fixed table. Do not delete the constant on the grounds that it
 * has no importer — deleting it also deletes the only check that the two lists
 * have not drifted. Three former exports (`EFFORT_TIER_LABELS`,
 * `effortTierIndex`, `effortTierAt`) were removed here because their only
 * callers were tests asserting on themselves.
 */
export const EFFORT_TIERS = ["low", "medium", "high", "extra", "max", "galaxy"];
