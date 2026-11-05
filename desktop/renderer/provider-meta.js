/**
 * Display names and vendor attribution for the configured model services.
 *
 * `providers.json` is a map keyed by the service name, and the kernel's Zod
 * schema strips every key it does not declare. So a service's "display name"
 * (what the user reads) and "which vendor did the user pick" (what draws the
 * icon) cannot live in that file without changing the kernel. They live here
 * instead, in localStorage, keyed by the service name — the same key the file
 * uses, so a rename naturally leaves the old entry behind as an orphan.
 *
 * An orphan is not an error and is never shown: every lookup is by a name that
 * came from `providers.json`. The entry a save writes is rebuilt from the
 * cards on screen, which is also what prunes the orphans away.
 *
 * Pure data + pure functions (the storage argument is anything with
 * `getItem` / `setItem`), so the rules can be tested without a DOM.
 */

import { presetById } from "./provider-presets.js";

/** The localStorage key. JSON: `{ "服务名": { displayName?, vendor? } }`. */
export const PROVIDER_META_KEY = "prometheus.providerMeta";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Null-prototype map: a service legitimately named `__proto__` is a key. */
function emptyMeta() {
  return Object.create(null);
}

/**
 * Drop everything that is not a usable entry.
 *
 * - a non-object entry, or an entry with nothing usable, disappears;
 * - `displayName` is trimmed, and one that equals the service name is not
 *   stored: the name is already the fallback, and a stored copy would freeze
 *   the label to a name the user later renames;
 * - `vendor` is a preset id or an explicit `null`. `null` means "the user
 *   chose Custom" and must survive: without it, a card named `deepseek` that
 *   was switched to Custom would fall back to looking like DeepSeek again;
 * - an unknown vendor id becomes `null` (custom) rather than a guess.
 */
export function sanitizeProviderMeta(raw) {
  const out = emptyMeta();
  if (!isObject(raw)) return out;
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof name !== "string" || name.trim() === "" || UNSAFE_KEYS.has(name)) continue;
    if (!isObject(entry)) continue;
    const clean = {};
    if (typeof entry.displayName === "string") {
      const displayName = entry.displayName.trim();
      if (displayName !== "" && displayName !== name) clean.displayName = displayName;
    }
    if (typeof entry.vendor === "string" || entry.vendor === null) {
      clean.vendor =
        typeof entry.vendor === "string" ? (presetById(entry.vendor.trim())?.id ?? null) : null;
    }
    if (Object.keys(clean).length > 0) out[name] = clean;
  }
  return out;
}

/**
 * What `storage` holds, or `{}`. A missing key, broken JSON or a storage that
 * throws are all "nothing stored" — a label store must never be a reason the
 * settings page fails to open.
 */
export function readProviderMeta(storage) {
  if (!storage || typeof storage.getItem !== "function") return emptyMeta();
  let raw;
  try {
    raw = storage.getItem(PROVIDER_META_KEY);
  } catch {
    return emptyMeta();
  }
  if (typeof raw !== "string" || raw === "") return emptyMeta();
  try {
    return sanitizeProviderMeta(JSON.parse(raw));
  } catch {
    return emptyMeta();
  }
}

/**
 * Write the sanitized map back. Returns false when the storage refused the
 * write (quota, privacy mode, no storage): the caller can then say the labels
 * will not survive a restart instead of pretending they were stored.
 */
export function writeProviderMeta(storage, meta) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(PROVIDER_META_KEY, JSON.stringify(sanitizeProviderMeta(meta)));
    return true;
  } catch {
    return false;
  }
}

/** The entry for one service, or `{}`. Never the prototype's. */
function providerMetaEntry(meta, name) {
  const key = typeof name === "string" ? name : "";
  const entry = isObject(meta) && Object.hasOwn(meta, key) ? meta[key] : undefined;
  return isObject(entry) ? entry : {};
}

/**
 * Which vendor a service belongs to.
 *
 * The stored answer wins when there is one — including an explicit `null`,
 * which says "Custom". With no stored answer at all (a card configured before
 * this field existed, or a file edited by hand) the service name is the only
 * evidence there is: a name equal to a preset id was written by that preset,
 * so it is read as that vendor. That is the same lookup the picker has always
 * done, not a guess from the endpoint URL (R3).
 */
export function vendorIdFor(meta, name) {
  const key = typeof name === "string" ? name : "";
  const entry = providerMetaEntry(meta, key);
  if (Object.hasOwn(entry, "vendor")) {
    return typeof entry.vendor === "string" ? (presetById(entry.vendor)?.id ?? null) : null;
  }
  return presetById(key.trim())?.id ?? null;
}

/**
 * What the card header and the model panel's rail show for one service.
 *
 * A blank or missing display name falls back to the service name — that is
 * the default the form states, not an invented label.
 */
export function providerIdentity(meta, name) {
  const key = typeof name === "string" ? name : "";
  const entry = providerMetaEntry(meta, key);
  const stored = typeof entry.displayName === "string" ? entry.displayName.trim() : "";
  return {
    id: key,
    displayName: stored !== "" ? stored : key,
    vendor: vendorIdFor(meta, key),
  };
}

/**
 * The second card that would read the same in the model panel, or null.
 *
 * Compared trimmed and case-insensitively: "DeepSeek 工作" and "deepseek 工作"
 * look identical in a narrow rail, which is exactly what two display names
 * exist to prevent. A blank display name counts as the service name — that is
 * what the panel will show for it.
 *
 * Returns the offending card's index so the caller can focus the right field
 * (the *later* card is the one that has to change).
 */
export function duplicateDisplayName(entries) {
  const seen = new Map();
  const list = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const displayName = typeof entry?.displayName === "string" ? entry.displayName.trim() : "";
    const label = displayName !== "" ? displayName : name;
    if (label === "") continue;
    const key = label.toLowerCase();
    if (seen.has(key)) return { displayName: label, index };
    seen.set(key, label);
  }
  return null;
}

/**
 * The model panel's rail: one row per configured service, in the order the
 * models arrived (which is the file's order).
 *
 * `groups` is `modelGroups()`'s shape — `{provider, models}`. The row keeps the
 * provider name as `id`: that is what the model ids are prefixed with, and the
 * rail's selection is compared against it. `displayName` and `vendor` are what
 * the row draws.
 */
export function providerRailRows(groups, meta) {
  const rows = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const provider = typeof group?.provider === "string" ? group.provider : "";
    if (provider === "") continue;
    const identity = providerIdentity(meta, provider);
    rows.push({
      id: identity.id,
      displayName: identity.displayName,
      vendor: identity.vendor,
      models: Array.isArray(group?.models) ? group.models : [],
    });
  }
  return rows;
}
