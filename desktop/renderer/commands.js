/**
 * The renderer's slash-command catalogue and its two pure helpers.
 *
 * No DOM, no `window`, no imports: both the desktop renderer and a test can
 * load this module anywhere. The host owns *which* commands exist; this module
 * only knows how to describe them and how to read `/name rest` out of a
 * message.
 */

export const COMMANDS = [
  {
    name: "clear",
    description: { zh: "开始新会话", en: "Start a new conversation" },
    argumentHint: "",
  },
  {
    name: "context",
    description: { zh: "查看上下文占用", en: "Show context usage" },
    argumentHint: "",
  },
  {
    name: "compact",
    description: { zh: "立即压缩上下文", en: "Compact the context now" },
    argumentHint: "",
  },
];

const FALLBACK_LOCALE = "en";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Catalogue entries by name, for one lookup per reported row. */
const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

/** The catalogue copy for one locale, falling back to English. */
function localCommand(name, locale) {
  const command = BY_NAME.get(name);
  if (command === undefined) return undefined;
  const wanted = command.description[locale];
  return {
    ...command,
    description:
      typeof wanted === "string" ? wanted : command.description[FALLBACK_LOCALE],
  };
}

/**
 * A description the host sent, in the locale the renderer is showing.
 *
 * Hosts may send either a plain string or `{ zh, en }`; anything else is
 * treated as "no description" rather than stringified into `[object Object]`.
 */
function hostDescription(value, locale) {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  const wanted = value[locale];
  if (typeof wanted === "string") return wanted;
  const fallback = value[FALLBACK_LOCALE];
  return typeof fallback === "string" ? fallback : "";
}

/**
 * Host-reported names → the local catalogue, in the host's order.
 *
 * A name the catalogue does not know is kept with the host's own description:
 * the host is the one that can actually run it, and dropping the row would
 * hide a working command. Duplicates and entries without a usable name are
 * skipped, and the host's casing/whitespace is normalized so `/Clear` and
 * `/clear` are one command.
 *
 * A row the host tags `source: "skill"` stays a skill, so the composer can
 * expand its body instead of running it as a local verb. Unknown `source`
 * values are not trusted: only the exact tag the host and this module share
 * makes a skill, and everything else is a builtin row as before.
 *
 * Precedence is the local catalogue first. The three verbs here are the ones
 * this window implements, so a host row can never redefine `/clear` as a skill
 * — the expansion path would then hunt for a body that does not exist while
 * `/clear` stopped clearing. For every other name the host's description and
 * argument hint pass through verbatim: they are the skill file's own words,
 * and the catalogue has nothing to say about a name it does not know.
 */
export function mergeCommands(reported, locale) {
  if (!Array.isArray(reported)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of reported) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name !== "string") continue;
    const name = entry.name.trim().toLowerCase();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    const local = localCommand(name, locale);
    if (local !== undefined) {
      out.push({
        name,
        description: local.description,
        argumentHint: local.argumentHint,
        source: "builtin",
        known: true,
      });
      continue;
    }
    out.push({
      name,
      description: hostDescription(entry.description, locale),
      argumentHint: typeof entry.argumentHint === "string" ? entry.argumentHint : "",
      source: entry.source === "skill" ? "skill" : "builtin",
      known: false,
    });
  }
  return out;
}

/** The token a skill body uses for the text typed after the command. */
export const SKILL_ARGUMENT = "$ARGUMENTS";

/**
 * Expand a skill's prompt body.
 *
 * Every `$ARGUMENTS` becomes `args`; a body with no placeholder gets the args
 * appended as a new paragraph, so `/review src/main.ts` is never silently
 * dropped. Nothing else in the body is rewritten: substituting an empty args
 * leaves the author's spacing exactly as written ("Review  please", not
 * "Review please"), because collapsing it would be editing prose this module
 * did not write. Only the final result's leading and trailing whitespace is
 * trimmed.
 *
 * Returns `null` when the skill is unusable — not a record, or no body to
 * send — which is the caller's cue to say so instead of sending an empty
 * prompt.
 *
 * Substitution is `split`/`join`, not `String.replace`: `args` is user text,
 * and a replacement string would expand `$&` or `$'` inside it.
 */
export function expandSkill(skill, args) {
  if (!isRecord(skill)) return null;
  const body = typeof skill.body === "string" ? skill.body : "";
  if (body.trim() === "") return null;
  const text = typeof args === "string" ? args.trim() : "";
  if (body.includes(SKILL_ARGUMENT)) {
    return body.split(SKILL_ARGUMENT).join(text).trim();
  }
  const trimmed = body.trim();
  return text === "" ? trimmed : `${trimmed}\n\n${text}`;
}

// The name character set has to match the one the kernel accepts for skill
// files (`SKILL_NAME_PATTERN` in `src/skills/store.ts`) and the one the
// composer's completion menu uses: `_` is a legal name character everywhere
// else, so leaving it out here made a `review_diff` skill list and insert but
// never run — Enter sent `/review_diff` to the model as prose, with no notice.
// `/` is still excluded, which is what keeps `/usr_local/bin` a sentence.
const SLASH = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;

/**
 * `/name rest` at the start of a message.
 *
 * Returns `null` when the text is not a command attempt at all: `// note` is a
 * comment-style line, `/usr/bin/env is broken` is prose, and `/usr_local/bin`
 * is a path — sending any of them to the model untouched is the only honest
 * reading. The name is lowercased so `/CONTEXT` reaches the same command the
 * menu lists. `_` is a legal name character, for the reason stated beside
 * `SLASH` above.
 */
export function parseSlashText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const match = SLASH.exec(trimmed);
  if (match === null) return null;
  return { name: (match[1] ?? "").toLowerCase(), args: match[2] ?? "" };
}

/**
 * A local report for `/context`, built from `state.context` and the optional
 * per-category split (`state.contextBreakdown`).
 *
 * `state.context` is either the kernel's own measurement
 * (`{ tokens, percent, window? }`) or `null` when nothing was reported. Both
 * `tokens` and `percent` must be finite, and `tokens` must not be negative — a
 * record carrying only one of them is not a measurement, and filling the other
 * with 0 would paint a figure the kernel never reported (R3: unknown is not
 * zero). The window is only echoed when it is a positive finite number; a
 * missing or zero window means "not reported", never "a window of 0".
 *
 * The split is deliberately *not* used for `used`: the kernel scales the parts
 * to fit the measured total and its rounding can leave them a few tokens off,
 * while `context.tokens` is the figure the chip and the popover headline show.
 * Reporting a different total here than one line above would look like two
 * measurements of the same thing. `parts` is passed through as the kernel sent
 * it, so the percentages in the report and in the popover divide by the same
 * numbers.
 *
 * `compactAt` is where the kernel starts compacting; `headroom` is how much
 * room is left before that, floored at 0 like `free` — past the trigger the
 * honest figure is "none left", not a negative count. Both are `null` when the
 * split is unknown: a trigger is something only the producer measured, and
 * inventing one from the total would be exactly the fabricated figure the rest
 * of this function refuses.
 */
export function contextReport(context, breakdown) {
  const unknown = {
    known: false,
    used: null,
    window: null,
    percent: null,
    free: null,
    compactAt: null,
    headroom: null,
    parts: [],
  };
  if (!isRecord(context)) return unknown;
  const { tokens, percent, window } = context;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return unknown;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return unknown;
  const knownWindow =
    typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null;
  // Broken rows are dropped rather than zeroed: a 0-token part would add a
  // category line the kernel never measured.
  const parts = [];
  if (isRecord(breakdown) && Array.isArray(breakdown.parts)) {
    for (const part of breakdown.parts) {
      if (!isRecord(part)) continue;
      if (typeof part.key !== "string" || part.key === "") continue;
      if (typeof part.tokens !== "number" || !Number.isFinite(part.tokens) || part.tokens <= 0) continue;
      parts.push({ key: part.key, tokens: part.tokens });
    }
  }
  const compactAt =
    isRecord(breakdown) && typeof breakdown.compactAt === "number" && Number.isFinite(breakdown.compactAt)
      ? breakdown.compactAt
      : null;
  return {
    known: true,
    used: tokens,
    window: knownWindow,
    percent,
    free: knownWindow === null ? null : Math.max(0, knownWindow - tokens),
    compactAt,
    headroom: compactAt === null ? null : Math.max(0, compactAt - tokens),
    parts,
  };
}
