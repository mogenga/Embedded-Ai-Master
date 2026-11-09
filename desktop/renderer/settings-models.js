/**
 * Pure data shaping for the model-services page.
 *
 * Kept out of `settings.js` so the rules that are easy to get wrong — which
 * names count as models, what the summary sentence says, and how the context
 * window survives a save — can be tested without a DOM. Nothing here touches
 * `document`, so a Node test can import it.
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
 * Which kind of credential a service card holds, from what is typed into it.
 *
 * - `direct`: a key in `apiKey`, which the kernel prefers when both are set;
 * - `env`: only the NAME of an environment variable;
 * - `missing`: neither.
 *
 * `env` is deliberately not called "configured": the renderer cannot read the
 * app's environment, so whether that variable is set is unknown here. The
 * header states which kind it is rather than implying the service is ready
 * (R3). Values are trimmed the way `resolveProviderApiKey` trims them, so a
 * whitespace-only field is not a credential.
 */
export function serviceKeyKind({ apiKey, apiKeyEnv } = {}) {
  const direct = typeof apiKey === "string" ? apiKey.trim() : "";
  if (direct !== "") return "direct";
  const env = typeof apiKeyEnv === "string" ? apiKeyEnv.trim() : "";
  return env !== "" ? "env" : "missing";
}

/**
 * What a collapsed card's header states about one service.
 *
 * `modelCount` counts named rows only (a card always carries at least one
 * blank row), and a non-finite count reads as zero rather than NaN. `noBaseUrl`
 * is true only for an empty field after trimming: a URL that is present but
 * malformed is a different fact, and save/test state it where the field is.
 */
export function serviceHeaderFacts({ apiKey, apiKeyEnv, baseUrl, modelCount } = {}) {
  const key = serviceKeyKind({ apiKey, apiKeyEnv });
  const count = Number.isFinite(modelCount) ? Math.max(0, Math.trunc(modelCount)) : 0;
  return {
    key,
    envName: key === "env" ? String(apiKeyEnv).trim() : "",
    modelCount: count,
    noBaseUrl: (typeof baseUrl === "string" ? baseUrl : "").trim() === "",
  };
}

/**
 * The per-model values this page does not edit, copied for the trip through
 * the form and back.
 *
 * `contextWindow` is included even though the row now has a select for it: the
 * select needs the stored value to seed itself, and an absent key has to stay
 * absent rather than become `undefined`. `modelRowState` is what splits it back
 * out, so the value has exactly one owner at save time.
 */
export function carriedFromModel(model) {
  return {
    ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model?.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
    // Reasoning support is a fact about the model that this form does not
    // edit, so it has to survive a save. Leaving it out meant one click on
    // 保存 silently erased it from providers.json — and with it every effort
    // level the composer was offering a moment earlier.
    ...(model?.supportsReasoning !== undefined ? { supportsReasoning: model.supportsReasoning } : {}),
    ...(model?.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {}),
    // `effortMap` is hand-written (`providers.json` only — no control here),
    // and the whole model object is rebuilt from this function on save. Omit
    // it and one click on 保存 drops the operator's tier mapping, silently
    // re-pointing every tier at `DEFAULT_EFFORT_MAP`. A spread of the model
    // would carry it, but it would also carry keys this form has no business
    // round-tripping (and keys the kernel's schema would then receive); the
    // whitelist is the contract, so a new field is added here on purpose.
    ...(model?.effortMap !== undefined ? { effortMap: model.effortMap } : {}),
  };
}

/**
 * The context-window sizes the form offers.
 *
 * A dropdown rather than a text box because this number is a fact about the
 * model, not something a user can read off the endpoint: an OpenAI-compatible
 * service does not report it. The round sizes below are the ones models
 * actually ship with; anything else has to come from the file.
 */
export const CONTEXT_WINDOW_CHOICES = [
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
  { value: 131072, label: "128K" },
  { value: 200000, label: "200K" },
  { value: 262144, label: "256K" },
  { value: 1000000, label: "1M" },
];

/** `300000` → `300K`, `1500000` → `1.5M`. Only for the custom option's label. */
export function shortWindow(value) {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(value);
}

/**
 * The `<option>` list a model row's context-window select gets, and which
 * option is selected.
 *
 * `""` is "default": saving it omits `contextWindow` from the file so the
 * kernel's `DEFAULT_CONTEXT_WINDOW` applies. Writing `128000` instead would
 * freeze today's default into every model entry, and a future change to the
 * default would then skip everyone who ever opened this page.
 *
 * A value already in the file that is not one of the sizes above gets an
 * option of its own, selected. Without it, opening the page and pressing Save
 * would silently rewrite a hand-written `contextWindow: 300000` to whatever
 * the select happened to show first — the form not offering a value must not
 * mean the file loses it (R3).
 */
export function contextWindowChoices(current, { defaultLabel, customLabel }) {
  const options = [{ value: "", label: defaultLabel }];
  for (const choice of CONTEXT_WINDOW_CHOICES) {
    options.push({ value: String(choice.value), label: choice.label });
  }
  const usable =
    typeof current === "number" && Number.isInteger(current) && current > 0;
  const known = usable && CONTEXT_WINDOW_CHOICES.some((choice) => choice.value === current);
  if (usable && !known) {
    options.push({ value: String(current), label: customLabel(current, shortWindow(current)) });
    return { options, selected: String(current) };
  }
  return { options, selected: known ? String(current) : "" };
}

/**
 * What to write for a select's value.
 *
 * `undefined` means "leave the key out of the file". Every branch that is not
 * a positive integer also returns `undefined` rather than a guess: the option
 * list only ever contains such values, so a surprise here is a bug, and
 * writing `NaN` into providers.json would fail the kernel's schema on the next
 * read.
 */
export function contextWindowForSave(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return number;
}

/**
 * Fold the select's value into the per-model object that gets saved.
 *
 * Returns a new object; `carried` is not mutated, because a save that is
 * refused or cancelled must leave the card's state untouched. The key is
 * deleted rather than set to `undefined` so the JSON that reaches the host has
 * no `contextWindow` member at all — `JSON.stringify` would drop it either
 * way, but a test comparing the object would see the difference.
 */
export function modelEntryForSave(carried, selectValue) {
  const entry = { ...(carried ?? {}) };
  const contextWindow = contextWindowForSave(selectValue);
  if (contextWindow === undefined) delete entry.contextWindow;
  else entry.contextWindow = contextWindow;
  return entry;
}

/**
 * Everything one model row needs, derived from what the file holds.
 *
 * `saved` is a model entry as `providers.json` has it (or the card's own
 * `carried`, which holds the same four keys — `carriedFromModel` is
 * idempotent, so either works). `carried` comes back without `contextWindow`:
 * the select owns that key now. Splitting the two here rather than in the DOM
 * code is what lets a test replay the exact round trip the page performs —
 * `modelRowState(saved)`, then `modelEntryForSave(state.carried,
 * state.select.selected)` — and compare against what a save would write.
 */
export function modelRowState(saved, labels) {
  const { contextWindow, ...carried } = carriedFromModel(saved);
  return {
    carried,
    select: contextWindowChoices(contextWindow, labels),
  };
}
