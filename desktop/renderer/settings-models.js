/**
 * Pure data shaping for the "Test connection" result block.
 *
 * Kept out of `settings.js` so the two rules that are easy to get wrong — which
 * names count as models, and what the summary sentence says — can be tested
 * without a DOM. Nothing here touches `document`, so a Node test can import it.
 */

/**
 * The model names a successful probe reported, flagged with whether the card
 * already lists them.
 *
 * The list is complete on purpose: a name already on the card is not dropped,
 * because a result block that silently omits half the answer reads as if the
 * endpoint offered fewer models than it did (R3 — say what was found). The
 * caller draws those entries as the already-added state instead.
 *
 * De-duplication is on the trimmed name: two entries that differ only by
 * surrounding whitespace are one model, and the first spelling wins.
 */
export function availableModelEntries(models, listedIds) {
  const listed = new Set();
  if (Array.isArray(listedIds)) {
    for (const id of listedIds) {
      if (typeof id === "string") listed.add(id.trim());
    }
  }
  const seen = new Set();
  const entries = [];
  if (!Array.isArray(models)) return entries;
  for (const model of models) {
    if (typeof model !== "string") continue;
    const name = model.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, alreadyListed: listed.has(name) });
  }
  return entries;
}

/**
 * The status line of a successful test.
 *
 * Three facts, each omitted rather than faked when it is not known:
 * - a latency that is not finite gets no segment (never "0 ms");
 * - a count of zero is a different sentence, not "0 models available" — the
 *   endpoint answered but listed nothing, and those are different outcomes;
 * - an unknown locale falls back to English, like the rest of the settings
 *   dictionary.
 */
export function connectionSummary(locale, { modelCount, latencyMs } = {}) {
  const count = Number.isFinite(modelCount) ? Math.max(0, Math.trunc(modelCount)) : 0;
  const zh = locale === "zh";
  if (count === 0) {
    return zh ? "端点可达，但没能列出模型" : "The endpoint answered, but it did not list any models.";
  }
  const head = zh
    ? `连接正常 · ${count} 个模型可用`
    : `Connected · ${count} ${count === 1 ? "model" : "models"} available`;
  if (!Number.isFinite(latencyMs)) return head;
  return `${head} · ${Math.round(latencyMs)} ms`;
}
