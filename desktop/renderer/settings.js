/**
 * The Settings page.
 *
 * Built as a factory because it shares the renderer's state and helpers: the
 * app passes them in once and gets back the entry points it needs. Every
 * control applies immediately — there is no Save step, and no draft state to
 * lose when the page is closed.
 */

import { settingsStrings } from "./settings-i18n.js";
import {
  availableModelEntries,
  carriedFromModel,
  connectionSummary,
  modelEntryForSave,
  modelRowState,
  serviceHeaderFacts,
} from "./settings-models.js";
import {
  isAutoProviderName,
  nextProviderName,
  presetById,
  presetFillFor,
  presetModelSuggestions,
  providerPickerOptions,
} from "./provider-presets.js";
import {
  duplicateDisplayName,
  providerIdentity,
  readProviderMeta,
  writeProviderMeta,
} from "./provider-meta.js";
import { VENDOR_MARKS } from "./vendor-marks.js";
import { iconEl, setIcon } from "./icons.js";
import { normalizeTranscriptView } from "./thinking-view.js";

/**
 * Does this value look like an API key rather than the NAME of a variable?
 *
 * The rules mirror the kernel's (`looksLikeSecret` in `src/model/probe.ts`), so
 * the inline warning here and the probe's own failure message agree about what
 * went wrong:
 * - 32+ hexadecimal characters (the shape most tokens take);
 * - an `sk-` prefix;
 * - longer than 40 characters carrying no environment-variable naming feature
 *   (no `_`, `.`, `/` or `-`, and not all uppercase).
 *
 * A heuristic, and only a warning: it never rewrites the value. Silently
 * treating a mistyped variable name as a key would put an arbitrary string on
 * the wire as a credential; a false positive costs one sentence.
 */
export function looksLikeSecret(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return false;
  if (/^[0-9a-f]{32,}$/i.test(text)) return true;
  if (/^sk-/i.test(text)) return true;
  if (text.length > 40 && !/[_./-]/.test(text) && !/^[A-Z0-9]+$/.test(text)) return true;
  return false;
}

/**
 * The mirror-image mistake: is this "key" actually an environment variable
 * name? Uppercase words joined by underscores (`DEEPSEEK_API_KEY`) are how
 * variables are named; the length limit keeps a long uppercase token from
 * being waved through as a name. Also a warning only — the key is saved as
 * typed either way.
 */
export function looksLikeEnvName(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text.length >= 60) return false;
  return /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(text);
}

export function createSettings(deps) {
  const { state, $, api, formatTokens, setTheme, setDensity, setMode, applyLocale, openModal, closeModal, getT, applyCodeFont, confirmAction } = deps;
  // `t` is rebound on every locale change, so every read goes through getT().
  const t = new Proxy({}, { get: (_, key) => getT()[key] });
  const settingsDialog = $("settings-dialog");
  const shortcutsDialog = $("shortcuts-dialog");
  const modalScrim = $("modal-scrim");

/* ---------- settings ---------- */

/** Kernel defaults, mirrored so the form has something to compare against
 *  before the host answers (`src/config/app-config.ts`). `maxTurns: null` is
 *  the kernel's "no cap": a message may take as many model calls as it needs.
 *
 *  The three limits lost their controls on 2026-11-05; the keys stay because
 *  `saveRun` writes `run.json` whole. The values in a save come from
 *  `state.runLimits` (the file, as the host last read it), so editing the
 *  system prompt carries an existing limit through unchanged instead of
 *  dropping it back to the default. */
const DEFAULT_RUN_LIMITS = {
  maxTurns: null,
  maxCostUsd: null,
  timeoutMs: null,
  systemPrompt: "",
  /**
   * The operator's effort choice, keyed by `provider/model`.
   *
   * It lives here rather than in `providers.json` because that file describes
   * the endpoint, while this is "what I picked for this run". The form rewrites
   * `run.json` whole, so the field has to be present in the defaults: without
   * it, opening 行为 and pressing save would drop every stored choice.
   */
  reasoningEffortByModel: {},
};
const DEFAULT_PERMISSIONS = { preset: "diagnose", approvalTimeoutMs: 120_000, rules: [] };
/** The kernel's MCP server name rule (`src/mcp/config.ts`). */
const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/** `src/permissions/config.ts` MAX_APPROVAL_TIMEOUT_MS. */
const MAX_APPROVAL_TIMEOUT_MS = 2_147_483_647;
/** `src/permissions/config.ts` MAX_PATTERN_LENGTH. */
const MAX_PATTERN_LENGTH = 200;

/** Newest settings payload from the host; controls read from here on refill. */
state.settings = null;
state.settingsTab = "general";
/**
 * What the window's close button does, as the main process last reported it.
 *
 * `null` means "not asked yet" (the General page requests it when it builds).
 * The value is not a renderer preference and not a host setting: it lives in
 * `window-behavior.json` under `userData`, owned by `desktop/main.js`.
 */
state.closeBehavior = null;
/** Why the last read or write of the close behaviour was refused; "" = none. */
state.closeBehaviorError = "";
state.usageRange = 30;
state.usageSummary = null;
state.mcpServers = [];
/** Config files the settings pages write; reported by the host per platform. */
state.configPaths = {};
/** Why the host could not read the config files, if it could not. */
state.settingsError = "";
/** `$HARNESS_HOME/permissions.json`, as the host last reported it. */
state.permissions = null;
state.rules = [];
/** `$HARNESS_HOME/run.json`, as the host last reported it. */
state.runLimits = { ...DEFAULT_RUN_LIMITS };
state.skills = [];
/** Skill files the store could not read, as the host reported them. Shown at
 *  the top of the page: a file silently missing from the list is exactly the
 *  failure R3 forbids. */
state.skillProblems = [];
/** Why the last skill save/delete was refused. Empty = nothing to report.
 *  The host sends these as `notice{domain:"skills"}`; this page is the only
 *  surface that can show them while the settings dialog is on top. */
state.skillError = "";
/** Set when a save was refused, so the form stays open with the draft in it.
 *  Bumped rather than read: the form compares against the value it sent with. */
state.skillSubmitSeq = 0;
state.memory = { global: [], project: [] };
/**
 * The last `kb` answer from the host, or null before the first one arrives.
 *
 * Null is not "empty": the page has to say it is still reading rather than
 * draw an empty corpus, and only an answer can tell those apart (R3).
 */
state.kb = null;
state.systemState = null;
state.packState = null;
state.packProgress = null;
/** A transient "that worked" line, cleared on the next action. */
state.packNotice = null;
/** The pack id whose Remove button is awaiting its second click. */
state.packRemoveArmed = null;
state.settingsQuery = "";

/**
 * Draft bookkeeping for the model-services page (`connection` as an id only —
 * the rail and the header call it 模型服务 / "Model services").
 *
 * That page is the only one with a Save step (it edits `providers.json` whole),
 * so it is the only one that can lose work when the host pushes a fresh
 * snapshot and `fillSettings` rebuilds the pane. `connectionDirty` says a draft
 * exists; while it does, `fillSettings` leaves the pane alone.
 */
let connectionDirty = false;
/** Bumped by every edit, so a save can tell whether the form moved on while it
 *  was in flight — those keystrokes are newer than the file and must survive. */
let connectionEditSeq = 0;
/** The edit count at the moment the in-flight save was sent. */
let connectionSavedSeq = -1;
/** A save is in flight; the next settings payload is its answer. */
let connectionSavePending = false;
/**
 * 显示名称没能写进 localStorage（存储被禁用或写满）。
 *
 * 它在下次构建页面时显示一次：文件已经保存、标签没保存，这两件事必须分开说
 * （R3），否则用户会以为重启后还能看到同一个标签。
 */
let providerMetaWriteFailed = false;
/** The last save was accepted — shown until the draft is edited again. */
let connectionShowSaved = false;
/** Raised by `openSetup`; cleared when the user leaves the page. */
let connectionSetupHint = false;
/** openSetup 请求过初始焦点；连接页每次重建时消费一次。 */
let connectionSetupFocus = false;
/** A connection test that never hears back would leave its button reading
 *  "Testing…" forever; silence is not an answer (R3). */
const CONNECTION_TEST_TIMEOUT_MS = 15_000;
/**
 * Tests waiting on a `provider_test` answer, for the page build that started
 * them. The event names its endpoint, not its card, so an answer is matched on
 * `baseUrl`; one that matches nothing was started by a page that is gone.
 */
let connectionPendingTests = [];
/** Timeouts of the tests in flight, so a rebuild can cancel them all. */
const connectionTestTimers = new Set();
/** Bumped by every build of the model-services page. A test belongs to the
 *  build that started it: writing its answer into the nodes that build left
 *  behind would be invisible work on a detached tree. */
let connectionPageBuild = 0;

/**
 * The cards the user opened, by provider name.
 *
 * The page is rebuilt from the host's file on every answer, so expansion
 * cannot live in the DOM: a card the user opened would snap shut the moment a
 * save round-trip landed. Keyed by name because that is the only identity a
 * card has that survives the rebuild — and it is what `save()` keys the file
 * by. A rename rewrites the entry (`renameExpansion`), or the card would close
 * itself as a side effect of being renamed.
 *
 * Cards not in this set start collapsed, except a brand-new one, which is
 * added on creation: an empty card has nothing to read in its header.
 */
const connectionExpanded = new Set();
/** Names the `aria-controls` ids, so two cards never point at one body. */
let connectionCardSeq = 0;

/** Move the "open" mark to the new name. A rename is an edit like any other:
 *  if it closed the card, the user would lose the form they were typing in. */
function renameExpansion(from, to) {
  if (!connectionExpanded.delete(from)) return;
  connectionExpanded.add(to);
}

/**
 * The MCP cards the user opened, by server name.
 *
 * Same reasoning as `connectionExpanded`: the host pushes a whole new
 * `mcp.json` snapshot after every save, which rebuilds the list, so the mark
 * cannot live in the DOM. Only the name is a safe key — the name is the key in
 * the file, and the edit form locks it, so unlike a provider card there is no
 * rename to follow here. Empty means every card closed, which is the default
 * the page opens with.
 */
const mcpExpanded = new Set();
/** Names the `aria-controls` ids, so two cards never point at one body. */
let mcpCardSeq = 0;

/**
 * The knowledge-base folders the user opened, by path.
 *
 * The same rule as the cards above: the tree is redrawn whenever a fresh `kb`
 * answer lands, so a folder the user opened would snap shut on every refresh.
 * A path is the only identity a folder has. Empty means every folder is closed,
 * which is how the tree opens — a corpus of a hundred files is a wall of text
 * if it starts expanded.
 */
const kbExpanded = new Set();
/** Names the `aria-controls` ids of the tree's folder bodies. */
let kbNodeSeq = 0;

/**
 * The last `corpus_status` answer, or null before the page has asked.
 *
 * Null is not `bundled`: the page has to be able to say it has not heard back
 * yet. `unavailable` arrives as a real state with `kind: "unavailable"`, so a
 * missing answer and "there is no corpus" stay different facts (R3).
 */
state.corpusStatus = null;
/** Why the host could not read the update state at all — kernel not built, or
 *  a status read that threw. Not one of the seven states: it is the absence of
 *  an answer, and the page says so rather than picking a state to show. */
state.corpusError = "";
/** Which corpus command is in flight — `""`, `"check"` or `"apply"`.
 *
 *  Tracked by name rather than as a boolean so each button says what *it* is
 *  doing: showing "Updating…" on a check that is only fetching a manifest would
 *  be a label for work that is not happening. Both buttons are disabled while
 *  either runs, because a second click would queue behind the first and then
 *  answer twice — two results for one visible action. */
state.corpusBusy = "";
/** `{completed, total, path, action}` from the kernel's `onProgress`, forwarded
 *  by the host. Null until the first file. No timer: a line that advances on
 *  its own would be a progress bar that reports work nobody is doing. */
state.corpusProgress = null;
/** The last apply's outcome: `{ok, corpusVersion?, reason?}`. Stays on the page
 *  until the next action, because a failure the user blinked past is a failure
 *  they will repeat. */
state.corpusResult = null;
/** `corpus.json`'s path as the host resolved it, so `config_invalid` can name
 *  the file to edit rather than describing one in the abstract. */
state.corpusConfigPath = "";

/**
 * Drop every test still waiting on an answer, and cancel their timers.
 *
 * Called when the pane that started them goes away — a rebuild, or a switch to
 * another settings tab. The answer, if one still arrives, has no card to land
 * on and is ignored rather than written to a detached node.
 */
function abandonConnectionTests() {
  connectionPageBuild += 1;
  connectionPendingTests = [];
  for (const timer of connectionTestTimers) clearTimeout(timer);
  connectionTestTimers.clear();
}

/**
 * A `provider_test` answer from the host.
 *
 * The event names the endpoint, not the card: several cards may be testing at
 * once, and an answer whose `baseUrl` matches no waiting test belongs to a page
 * that is gone. It is ignored, not shown (R3: no invented result).
 */
function handleProviderTest(message) {
  const baseUrl = typeof message.baseUrl === "string" ? message.baseUrl : "";
  const at = connectionPendingTests.findIndex((entry) => entry.baseUrl === baseUrl);
  if (at < 0) return;
  const [pending] = connectionPendingTests.splice(at, 1);
  // A rebuild replaced the DOM this test was drawing into.
  if (pending.build !== connectionPageBuild) return;
  if (message.ok === true) {
    const models = Array.isArray(message.models)
      ? message.models.filter((model) => typeof model === "string")
      : [];
    pending.finish(models.length > 0 ? "ok" : "empty", {
      models,
      latencyMs: typeof message.latencyMs === "number" ? message.latencyMs : undefined,
    });
    return;
  }
  // The event's own words first; a failure that names neither an error nor a
  // code is still a failure, and saying so beats an empty warning line.
  const detail =
    typeof message.error === "string" && message.error !== ""
      ? message.error
      : typeof message.code === "string" && message.code !== ""
        ? message.code
        : S().connTestFailed;
  pending.finish("failed", detail);
}

const S = () => settingsStrings[state.locale] ?? settingsStrings.en;

/**
 * 渲染层的 localStorage，取不到时返回 null。
 *
 * 显示名称与厂商归属存在这里（内核 schema 会剥掉未知键），而设置页在没有
 * `window` 的环境里也必须能构建——取不到就给 `provider-meta.js` 一个 null，
 * 它自己会退化成「什么都没存」。
 */
function providerMetaStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // localStorage 的 getter 本身就可能抛（隐私模式、被禁用）。
    return null;
  }
}

/** Rail glyphs, named from the shared sprite so the rail and the toolbar
 *  speak the same visual language. */
const SETTINGS_ICON_NAMES = {
  general: "user",
  appearance: "palette",
  usage: "chart",
  connection: "plug",
  behavior: "sliders",
  sessions: "layers",
  mcp: "robot",
  kb: "book",
  skills: "sparkle",
  memory: "book",
  instructions: "file-code",
  tools: "layers",
  system: "monitor",
  about: "info",
};
/**
 * One settings page: a rail entry and a builder. Builders return the pane
 * element and may refresh themselves later (usage, MCP, skills, memory).
 */
function settingsPages() {
  const s = S();
  // Only pages whose controls reach a real backend are listed. The host owns
  // four config surfaces — UI preferences, the provider catalogue, MCP servers,
  // and the permissions/run limits files — so those are the four families of
  // form that can actually save something.
  // `connection` edits `providers.json` whole through `saveProviders`, which is
  // what makes it one of them: the first-run prompt and the host's own warning
  // ("设置 → 模型服务") both point here, so leaving it unlisted sent users to a
  // page that could not exist.
  // `skills` reaches the host too (`getSkills` / `saveSkill` / `removeSkill`),
  // and the composer's `/` menu draws from the same store — a skill file that
  // cannot be listed here is one the user can only edit by hand.
  // `tools` (toolchain packs) is listed since the host grew its backend: the
  // seven `*Pack*` handlers answer every control on the page, so hiding the
  // entry would now hide a working page (D-166 packs item).
  // The rest of the builders (usage, memory, instructions, hooks, system,
  // sessions) stay in this file so restoring a page is a one-line change, but
  // listing them would produce forms whose save button cannot work.
  return [
    { id: "general", group: s.groupSettings, title: s.pageGeneral, build: buildGeneralPage },
    { id: "connection", group: s.groupSettings, title: s.pageConnection, build: buildConnectionPage },
    { id: "appearance", group: s.groupSettings, title: s.pageAppearance, build: buildAppearancePage },
    { id: "behavior", group: s.groupSettings, title: s.pageBehavior, build: buildBehaviorPage },
    { id: "mcp", group: s.groupSettings, title: s.pageMcp, build: buildMcpPage },
    { id: "skills", group: s.groupSettings, title: s.pageSkills, build: buildSkillsPage },
    { id: "kb", group: s.groupComputer, title: s.pageKb, build: buildKbPage },
    { id: "tools", group: s.groupComputer, title: s.pageTools, build: buildToolsPage },
    { id: "about", group: s.groupComputer, title: s.pageAbout, build: buildAboutPage },
  ];
}

/* ---------- small builders ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * One label/description-on-the-left, control-on-the-right row.
 *
 * `required` adds a word — "Required" / 「必填」— beside the label, not a bare
 * asterisk: the mark has to reach a screen reader and the high-contrast theme
 * too. It is searchable like the rest of the row.
 */
function sRow({ label, desc, control, id, wide = false, mono = false, required = false }) {
  const row = el("div", `setting-row${wide ? " wide" : ""}`);
  row.dataset.search = `${label} ${desc ?? ""}${required ? ` ${S().connRequired}` : ""}`.toLowerCase();
  const copy = el("div", "setting-copy");
  const labelNode = mono ? el("code", "setting-code", label) : el("label", "setting-label", label);
  // 显式 id 优先；否则控件自己带了 id（sText 总会生成）就自动关联。
  if (id) labelNode.htmlFor = id;
  else if (labelNode.tagName === "LABEL" && control?.id) labelNode.htmlFor = control.id;
  if (required) {
    // 同一行：`.setting-label` 是 block，直接追加会把标记挤到下一行。
    const line = el("div", "setting-label-line");
    line.append(labelNode, el("span", "setting-required", S().connRequired));
    copy.appendChild(line);
  } else {
    copy.appendChild(labelNode);
  }
  if (desc) copy.appendChild(el("p", "setting-desc", desc));
  const controlNode = el("div", "setting-control");
  controlNode.appendChild(control);
  row.append(copy, controlNode);
  return row;
}

function sGroup(title, rows) {
  const group = el("section", "setting-group");
  if (title) group.appendChild(el("h3", "setting-group-title", title));
  for (const row of rows) group.appendChild(row);
  return group;
}

function sSelect({ id, value, options, onChange, disabled = false }) {
  const select = document.createElement("select");
  select.className = "setting-select";
  if (id) select.id = id;
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
  select.value = value;
  select.disabled = disabled;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/**
 * One vendor glyph, inline on the shared 24×24 grid.
 *
 * `vendor-marks.js` holds filled path data, while the sprite in `icons.js`
 * holds stroked 1.75 glyphs — so a mark is built here rather than reached for
 * with `<use>`, and `.vendor-mark` restores `fill: currentColor` that the
 * global `svg` rule would otherwise turn off. `id` with no mark (the custom
 * choice) draws the pencil instead of a vendor logo: a neutral placeholder,
 * not an invented brand (R3).
 */
function vendorMarkEl(id) {
  const mark = id ? VENDOR_MARKS[id] : undefined;
  if (!mark) return iconEl("edit", "vendor-mark vendor-mark-neutral");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "vendor-mark");
  svg.setAttribute("viewBox", mark.viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const path of mark.paths) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
    node.setAttribute("d", path);
    svg.appendChild(node);
  }
  return svg;
}

/**
 * The vertical bounds of the scrolling pane `node` is painted inside, or the
 * window's when there is no such ancestor (a test fixture, or a future place
 * outside Settings). This menu is `position: absolute` inside the scroll
 * container, so the pane — not the viewport — is what clips it.
 */
function settingsPanesBounds(node) {
  const panes = node.closest(".settings-panes");
  if (!panes) return { top: 0, bottom: window.innerHeight };
  const box = panes.getBoundingClientRect();
  return { top: box.top, bottom: box.bottom };
}

/**
 * 厂商选择器：带图标的自绘下拉。
 *
 * 原生 `<select>` 的每一行只能是文本，放不下厂商图标，所以这里是
 * WAI-ARIA 1.2 的「按钮 + listbox 弹出层」combobox：焦点始终在触发器上，
 * 高亮行走 `aria-activedescendant` 指认。只有一个焦点来源，Escape / 方向键 /
 * 回车就不必在两个控件之间倒手。
 *
 * `setValue` 只改显示，不回调 `onChange`：调用方改了归属要同步触发器，但那次
 * 同步不是一次新的选择。
 *
 * `getOptions` 每次展开时现算，缓存一份就会给出过期的菜单。
 */
function sProviderPicker({ id, value, getOptions, onChange, labels }) {
  let current = value ?? null;
  let open = false;
  /** Rendered rows, in visual order (preset rows, then the custom row). */
  let rows = [];

  const control = el("div", "provider-picker-control");
  const button = el("button", "provider-picker");
  button.type = "button";
  button.id = id;
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", `${id}-menu`);
  const menu = el("div", "provider-menu");
  menu.id = `${id}-menu`;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", labels.menu);
  menu.hidden = true;

  const renderTrigger = () => {
    const preset = current ? presetById(current) : undefined;
    button.textContent = "";
    button.append(
      vendorMarkEl(preset?.id),
      el("span", "provider-picker-name", preset ? preset.label : labels.custom),
      iconEl("chevron-down", "provider-picker-caret"),
    );
  };

  const setHighlight = (row) => {
    for (const other of rows) other.removeAttribute("data-highlight");
    button.removeAttribute("aria-activedescendant");
    if (!row) return;
    row.dataset.highlight = "1";
    button.setAttribute("aria-activedescendant", row.id);
    row.scrollIntoView({ block: "nearest" });
  };

  /** Move the highlight by `step`, clamped — the list is not a ring. */
  const moveHighlight = (step) => {
    const list = rows;
    if (list.length === 0) return;
    const at = list.findIndex((row) => row.dataset.highlight === "1");
    const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + step));
    setHighlight(list[next]);
  };

  const closeMenu = ({ restoreFocus = false } = {}) => {
    if (!open) return;
    open = false;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    if (restoreFocus) focusTrigger();
  };

  /** Focus the trigger without scrolling the settings pane back to the top.
   *  A plain `.focus()` scrolls the trigger into view, and inside a tall
   *  scrolling pane that yanks the page when the menu closes. */
  const focusTrigger = () => button.focus({ preventScroll: true });

  /** A click anywhere else closes the menu; so does the card being rebuilt
   *  out from under it (a detached control would otherwise keep the document
   *  listener alive for the rest of the session). */
  function onDocPointerDown(event) {
    if (!control.isConnected || !control.contains(event.target)) closeMenu({ restoreFocus: false });
  }

  /**
   * `source` is `"pointer"` or `"keyboard"`. The caller uses it to decide
   * where focus goes next: a click on a menu row can reasonably hand the
   * caret to the field the choice filled in, while a keyboard user is still
   * driving this control and must stay on it (WAI-ARIA's combobox pattern).
   */
  const choose = (row, { source = "pointer" } = {}) => {
    if (!row || row.disabled) return;
    const next = row.dataset.custom === "1" ? null : row.dataset.preset;
    closeMenu({ restoreFocus: true });
    onChange(next, { source });
  };

  const buildRows = () => {
    const view = getOptions();
    menu.textContent = "";
    rows = [];
    const addRow = ({ optionId, presetId, label, selected, custom }) => {
      const row = el("button", "provider-option");
      row.type = "button";
      row.id = `${id}-opt-${optionId}`;
      row.tabIndex = -1;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", selected ? "true" : "false");
      if (custom) row.dataset.custom = "1";
      else row.dataset.preset = presetId;
      row.append(vendorMarkEl(custom ? null : presetId), el("span", "provider-option-name", label));
      if (selected) row.appendChild(iconEl("check", "provider-option-check"));
      row.addEventListener("click", () => choose(row, { source: "pointer" }));
      menu.appendChild(row);
      rows.push(row);
    };
    for (const option of view.options) {
      addRow({
        optionId: option.id,
        presetId: option.id,
        label: option.label,
        selected: option.selected,
        custom: false,
      });
    }
    const separator = el("div", "provider-menu-sep");
    separator.setAttribute("role", "presentation");
    menu.appendChild(separator);
    addRow({
      optionId: "custom",
      presetId: "",
      label: labels.custom,
      selected: view.custom,
      custom: true,
    });
  };

  const openMenu = () => {
    if (open) return;
    buildRows();
    if (rows.length === 0) return;
    open = true;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    // The pane scrolls and clips, so a menu that only ever opened downwards
    // would lose its last rows on a card near the bottom edge — and the
    // custom row, which is last, is the one a user is most likely to want.
    // Open toward the roomier side and cap the height to what that side has;
    // with neither side big enough the menu scrolls inside its own box rather
    // than overrunning the panel. The bounds are the scrolling pane's own
    // edges, not the window's: the pane is what clips this absolutely
    // positioned menu, so a window-based estimate would call "plenty of room"
    // on a card that is actually at the pane's edge.
    const trigger = button.getBoundingClientRect();
    const { top: clipTop, bottom: clipBottom } = settingsPanesBounds(button);
    const gap = 6 + 10; // menu offset from the trigger, plus breathing room
    const spaceBelow = clipBottom - trigger.bottom - gap;
    const spaceAbove = trigger.top - clipTop - gap;
    const wanted = Math.min(320, rows.length * 36 + 16);
    const opensUp = spaceBelow < wanted && spaceAbove > spaceBelow;
    menu.classList.toggle("opens-up", opensUp);
    const room = Math.floor(opensUp ? spaceAbove : spaceBelow);
    // Clear the inline cap when there is enough room, so the stylesheet's
    // 320px is the only number in play in the ordinary case.
    menu.style.maxHeight = room < wanted ? `${Math.max(120, room)}px` : "";
    const selectedRow = rows.find((row) => row.getAttribute("aria-selected") === "true");
    setHighlight(selectedRow ?? rows[0]);
    document.addEventListener("pointerdown", onDocPointerDown, true);
  };

  // A click on the trigger toggles; Enter and Space arrive here the same way
  // when the menu is closed, because a real <button> does that for us.
  button.addEventListener("click", () => {
    if (open) closeMenu({ restoreFocus: false });
    else openMenu();
  });

  button.addEventListener("keydown", (event) => {
    const key = event.key;
    if (key === "Escape") {
      if (!open) return;
      // The settings page is a modal <dialog>: an Escape that reached the
      // document would close the whole page and throw away the draft. This
      // menu is the innermost open surface, so it takes the key.
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      moveHighlight(key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((key === "Home" || key === "End") && open) {
      event.preventDefault();
      if (rows.length > 0) setHighlight(key === "Home" ? rows[0] : rows[rows.length - 1]);
      return;
    }
    if ((key === "Enter" || key === " ") && open) {
      // Prevented so the button's native activation does not fire a second
      // click on keyup and snap the menu shut again.
      event.preventDefault();
      choose(rows.find((row) => row.dataset.highlight === "1"), { source: "keyboard" });
      return;
    }
    if (key === "Tab" && open) closeMenu({ restoreFocus: false });
  });

  control.append(button, menu);
  renderTrigger();

  return {
    node: control,
    controlId: id,
    /** Follow the card's own state (the name field) without firing onChange. */
    setValue: (next) => {
      current = next ?? null;
      renderTrigger();
    },
    close: () => closeMenu({ restoreFocus: false }),
  };
}

function sToggle({ id, checked, onChange, disabled = false }) {
  const button = el("button", `setting-switch${checked ? " on" : ""}`);
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", checked ? "true" : "false");
  if (id) button.id = id;
  button.disabled = disabled;
  button.appendChild(el("span", "setting-switch-knob"));
  button.addEventListener("click", () => {
    const next = !button.classList.contains("on");
    button.classList.toggle("on", next);
    button.setAttribute("aria-checked", next ? "true" : "false");
    onChange(next);
  });
  return button;
}

function sText({ id, value, placeholder, type = "text", mono = false, onChange, min, max, step, disabled = false }) {
  const input = document.createElement("input");
  input.className = `setting-input${mono ? " mono" : ""}`;
  input.type = type;
  // 没传 id 就生成一个：下面 sRow 依赖控件有 id 才能把 label 关联上
  // （WCAG 1.3.1 / 4.1.2），传了 id 的调用方自己负责 htmlFor。
  input.id = id ?? `stext-${Math.random().toString(36).slice(2, 10)}`;
  if (placeholder) input.placeholder = placeholder;
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  input.value = value ?? "";
  input.disabled = disabled;
  input.spellcheck = false;
  // Text commits on blur/Enter so a save round-trip does not fight typing.
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

function sTextarea({ id, value, placeholder, rows = 8, onSave, saveLabel }) {
  const wrap = el("div", "setting-textarea-wrap");
  const area = document.createElement("textarea");
  area.className = "setting-textarea";
  if (id) area.id = id;
  if (placeholder) area.placeholder = placeholder;
  area.rows = rows;
  area.spellcheck = false;
  area.value = value ?? "";
  const foot = el("div", "setting-textarea-foot");
  const status = el("span", "setting-inline-status", "");
  // 保存状态对读屏可见（aria-live），且持久显示到下一次编辑——定时消失
  // 的反馈对注意力不在线的用户等于没有。
  status.setAttribute("aria-live", "polite");
  const clearSaved = () => (status.textContent = "");
  area.addEventListener("input", clearSaved);
  const save = el("button", "btn btn-primary small", saveLabel);
  save.type = "button";
  save.addEventListener("click", () => {
    onSave(area.value);
    status.textContent = S().saved;
  });
  foot.append(status, save);
  wrap.append(area, foot);
  return wrap;
}

function sSegmented({ options, value, onChange, previews = false }) {
  const wrap = el("div", `setting-segmented${previews ? " with-previews" : ""}`);
  wrap.setAttribute("role", "radiogroup");
  for (const option of options) {
    const button = el("button", `setting-segment${option.value === value ? " active" : ""}`);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", option.value === value ? "true" : "false");
    if (option.preview) {
      const preview = el("span", `setting-preview setting-preview-${option.preview}`);
      preview.append(el("span", "setting-preview-bar"), el("span", "setting-preview-bar short"));
      button.appendChild(preview);
    }
    button.appendChild(el("span", "setting-segment-label", option.label));
    button.addEventListener("click", () => {
      wrap.querySelectorAll(".setting-segment").forEach((node) => {
        const active = node === button;
        node.classList.toggle("active", active);
        node.setAttribute("aria-checked", active ? "true" : "false");
      });
      onChange(option.value);
    });
    wrap.appendChild(button);
  }
  return wrap;
}

function sPage(title, description) {
  const pane = el("div", "settings-page");
  const head = el("header", "settings-page-head");
  head.appendChild(el("h1", "", title));
  if (description) head.appendChild(el("p", "", description));
  pane.appendChild(head);
  return pane;
}

function sHint(text) {
  return el("p", "setting-note", text);
}

function sButton(label, onClick, { primary = false, quiet = false, danger = false } = {}) {
  // danger 表示破坏性操作，需要在视觉上可辨识（不能被 quiet 弱化成链接
  // 样式——删除和编辑长得一样，是在邀请误点）。同时给出时 danger 优先。
  const quietResolved = quiet && !danger;
  const button = el("button", `btn small${primary ? " btn-primary" : ""}${quietResolved ? " btn-quiet" : ""}${danger ? " danger" : ""}`, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

/* ---------- apply helpers ---------- */

/** Appearance and behaviour toggles: immediate, no save step. */
function applyPref(key, value) {
  api.send({ cmd: "setUiPreference", key, value });
  applyUiPreference(key, value);
}

/** Configuration values: written straight through, without re-fetching models. */
function applyConfig(patch) {
  api.send({ cmd: "saveSettings", settings: patch, skipCatalog: true });
}

function applyUiPreference(key, value) {
  switch (key) {
    case "theme":
      setTheme(value);
      break;
    case "density":
      setDensity(value);
      break;
    case "fontScale":
      state.fontScale = Number(value);
      document.documentElement.style.setProperty("--font-scale", String(value));
      localStorage.setItem("prometheus.fontScale", String(value));
      break;
    case "suggestions":
    case "updateCheck":
      localStorage.setItem(`prometheus.${key}`, value ? "1" : "0");
      break;
    case "uiScale":
      state.uiScale = Number(value);
      document.documentElement.style.setProperty("--ui-scale", String(value));
      localStorage.setItem("prometheus.uiScale", String(value));
      // The sidebar width is stored unscaled, so zooming has to re-apply it:
      // otherwise a resized column would shrink relative to the rest of the UI
      // on every zoom step. Settings and the shell are separate modules, so
      // this goes through the same event bus every other cross-module UI
      // change uses.
      window.dispatchEvent(new CustomEvent("prometheus:ui-scale", { detail: Number(value) }));
      break;
    case "transcriptWidth":
      document.documentElement.dataset.width = value;
      localStorage.setItem("prometheus.width", value);
      break;
    case "transcriptView": {
      // Thinking blocks fold per block now, so this preference no longer
      // decides whether reasoning is visible. What it still controls is
      // whether a tool result opens as it arrives (`verbose`) or stays behind
      // its toggle. A stored `thinking` from an older build meant "show
      // reasoning", which every block now does on demand — it collapses to
      // `normal` rather than surviving as an option that changes nothing.
      const view = normalizeTranscriptView(value);
      state.transcriptView = view;
      document.documentElement.dataset.view = view;
      localStorage.setItem("prometheus.view", view);
      break;
    }
    case "reduceMotion":
      document.documentElement.dataset.motion = value ? "reduced" : "full";
      localStorage.setItem("prometheus.motion", value ? "reduced" : "full");
      break;
    case "codeFont":
      applyCodeFont(value);
      break;
    case "notifications":
      state.notifications = Boolean(value);
      break;
    case "keepAwake":
      state.keepAwake = Boolean(value);
      break;
    case "outputStyle":
      state.outputStyle = value;
      break;
    case "archiveAfterDays":
      state.archiveAfterDays = Number(value);
      break;
    default:
      break;
  }
}

/* ---------- pages ---------- */

function buildGeneralPage() {
  const s = S();
  const pane = sPage(s.pageGeneral, s.pageGeneralDesc);

  const profile = el("section", "setting-group profile-card");
  const avatar = el("span", "profile-avatar", "E");
  const copy = el("div", "profile-copy");
  copy.appendChild(el("strong", "", state.cwd ? basename(state.cwd) : s.noWorkspace));
  copy.appendChild(el("span", "profile-path", state.cwd || "—"));
  // No "change folder" button: the workspace is fixed when the host starts.
  // A button that cannot switch folders is a promise the host cannot keep.
  profile.append(avatar, copy);
  pane.appendChild(profile);

  pane.appendChild(
    sGroup(s.groupLanguage, [
      sRow({
        id: "setting-locale",
        label: s.language,
        desc: s.languageDesc,
        control: sSelect({
          id: "setting-locale",
          value: state.locale,
          options: [
            { value: "en", label: "English" },
            { value: "zh", label: "中文" },
          ],
          onChange: (value) => {
            applyConfig({ locale: value });
            applyLocale(value);
          },
        }),
      }),
    ]),
  );

  pane.appendChild(
    sGroup(s.groupStartup, [
      sRow({
        label: s.outputStyle,
        desc: s.outputStyleDesc,
        control: sSelect({
          value: state.outputStyle ?? "default",
          options: [
            { value: "default", label: s.outputDefault },
            { value: "concise", label: s.outputConcise },
            { value: "explanatory", label: s.outputExplanatory },
          ],
          onChange: (value) => applyPref("outputStyle", value),
        }),
      }),
      sRow({
        label: s.suggestionsPref,
        desc: s.suggestionsPrefDesc,
        control: sToggle({
          checked: state.suggestions !== false,
          onChange: (value) => applyPref("suggestions", value),
        }),
      }),
      sRow({
        label: s.updateCheckPref,
        desc: s.updateCheckPrefDesc,
        control: sToggle({
          checked: state.updateCheck !== false,
          onChange: (value) => applyPref("updateCheck", value),
        }),
      }),
    ]),
  );

  // 保存失败不是「一条普通说明」：用 danger 色，和技能页的问题行同一口径。
  const closeError = el("p", "setting-note pack-problem", "");
  closeError.id = "setting-close-behavior-error";
  closeError.hidden = state.closeBehaviorError === "";
  closeError.textContent = state.closeBehaviorError ?? "";
  state.renderCloseBehaviorError = (message) => {
    // The page may have been rebuilt before the main process answered; a node
    // that is no longer on screen has nothing to report into.
    if (!closeError.isConnected) return;
    closeError.textContent = message;
    closeError.hidden = message === "";
  };

  pane.appendChild(
    sGroup(s.groupClose, [
      sRow({
        id: "setting-close-behavior",
        label: s.closeBehavior,
        desc: s.closeBehaviorDesc,
        control: buildCloseBehaviorSelect(),
      }),
      closeError,
    ]),
  );
  return pane;
}

/**
 * The close-behaviour select, filled from the main process.
 *
 * Not an `applyPref` toggle: this value is not a renderer preference (it is not
 * in `localStorage`) and not a host setting either — the main process owns it,
 * because it decides what the window does, and the host may not even be
 * running.
 *
 * The select starts on the last known answer and asks for the current one once
 * the row is built. A choice only sticks if the main process reports
 * `saved: true`; a refused one puts the control back and names the reason, so
 * the page never shows a value that would not survive the next launch (R3).
 */
function buildCloseBehaviorSelect() {
  const s = S();
  /** Surfaced on the page; the IPC answer's own words first. */
  const report = (message) => state.renderCloseBehaviorError?.(message ?? "");
  /** A read that arrives after the user has already chosen must not win. */
  let userChose = false;

  const select = sSelect({
    id: "setting-close-behavior",
    value: state.closeBehavior ?? "tray",
    options: [
      { value: "tray", label: s.closeBehaviorTray },
      { value: "quit", label: s.closeBehaviorQuit },
    ],
    onChange: (value) => {
      userChose = true;
      if (typeof api.setCloseBehavior !== "function") return;
      void api.setCloseBehavior(value).then((result) => {
        // A rebuilt page replaced this node while the answer was in flight.
        if (!select.isConnected) return;
        if (result?.saved === true) {
          state.closeBehavior = result.behavior;
          state.closeBehaviorError = "";
          report("");
          return;
        }
        select.value = state.closeBehavior ?? "tray";
        state.closeBehaviorError = result?.error ?? s.closeBehaviorSaveFailed;
        report(state.closeBehaviorError);
      });
    },
  });
  if (typeof api.closeBehavior === "function") {
    void api.closeBehavior().then((answer) => {
      if (!select.isConnected || !answer || userChose) return;
      state.closeBehavior = answer.behavior;
      // A file that had to be ignored is worth one line: the page would
      // otherwise show the fallback without saying the stored choice was lost.
      state.closeBehaviorError = answer.source === "invalid" ? (answer.reason ?? "") : "";
      select.value = answer.behavior;
      report(state.closeBehaviorError);
    });
  }
  return select;
}

function buildAppearancePage() {
  const s = S();
  const pane = sPage(s.pageAppearance, s.pageAppearanceDesc);

  pane.appendChild(
    sGroup(s.groupTheme, [
      sRow({
        id: "setting-theme",
        label: s.theme,
        desc: s.themeDesc,
        control: sSegmented({
          value: state.theme,
          previews: true,
          options: [
            { value: "system", label: s.themeSystem, preview: "system" },
            { value: "light", label: s.themeLight, preview: "light" },
            { value: "dark", label: s.themeDark, preview: "dark" },
            { value: "high-contrast", label: s.themeHighContrast, preview: "dark" },
          ],
          onChange: (value) => applyPref("theme", value),
        }),
      }),
    ]),
  );

  pane.appendChild(
    sGroup(s.groupText, [
      sRow({
        label: s.fontSize,
        desc: s.fontSizeDesc,
        control: sSegmented({
          value: String(state.fontScale ?? 1),
          options: [
            { value: "0.9", label: s.fontSmall },
            { value: "1", label: s.fontDefault },
            { value: "1.12", label: s.fontLarge },
          ],
          onChange: (value) => applyPref("fontScale", Number(value)),
        }),
      }),
      sRow({
        label: s.width,
        desc: s.widthDesc,
        control: sSegmented({
          value: state.transcriptWidth ?? "standard",
          options: [
            { value: "narrow", label: s.widthNarrow },
            { value: "standard", label: s.widthStandard },
            { value: "wide", label: s.widthWide },
          ],
          onChange: (value) => applyPref("transcriptWidth", value),
        }),
      }),
      sRow({
        label: s.codeFont,
        desc: s.codeFontDesc,
        control: sText({
          value: state.codeFont ?? "",
          placeholder: "SF Mono, Cascadia Code",
          onChange: (value) => applyPref("codeFont", value),
        }),
      }),
    ]),
  );

  pane.appendChild(
    sGroup(s.groupTranscript, [
      sRow({
        label: s.view,
        desc: s.viewDesc,
        control: sSelect({
          value: normalizeTranscriptView(state.transcriptView),
          // Two options, not three. `thinking` used to mean "show the
          // reasoning text"; every block now opens on its own header, so that
          // option would be a control that changes nothing. What is left is
          // the one difference the setting still makes: whether tool output
          // is already open when it arrives.
          options: [
            { value: "normal", label: s.viewNormal },
            { value: "verbose", label: s.viewVerbose },
          ],
          onChange: (value) => applyPref("transcriptView", value),
        }),
      }),
      sRow({
        id: "setting-density",
        label: s.density,
        desc: s.densityDesc,
        control: sSegmented({
          value: state.density,
          options: [
            { value: "compact", label: s.densityCompact },
            { value: "balanced", label: s.densityBalanced },
            { value: "detailed", label: s.densityDetailed },
          ],
          onChange: (value) => applyPref("density", value),
        }),
      }),
      sRow({
        label: s.reduceMotion,
        desc: s.reduceMotionDesc,
        control: sToggle({
          checked: Boolean(state.reduceMotion),
          onChange: (value) => applyPref("reduceMotion", value),
        }),
      }),
    ]),
  );

  // Interface scale is separate from the transcript's font size: it grows the
  // sidebar, tabs, and dialogs too, which is what a user on a high-DPI display
  // or with low vision actually needs.
  pane.appendChild(
    sGroup(s.groupInterface, [
      sRow({
        label: s.interfaceScale,
        desc: s.interfaceScaleDesc,
        control: sSegmented({
          value: String(state.uiScale ?? 1),
          options: [
            { value: "0.9", label: "90%" },
            { value: "1", label: "100%" },
            { value: "1.1", label: "110%" },
            { value: "1.25", label: "125%" },
          ],
          onChange: (value) => applyPref("uiScale", Number(value)),
        }),
      }),
    ]),
  );
  return pane;
}

function buildUsagePage() {
  const s = S();
  const pane = sPage(s.pageUsage, s.pageUsageDesc);
  const body = el("div", "usage-page-body");
  pane.appendChild(body);

  const render = () => {
    body.innerHTML = "";
    const summary = state.usageSummary;
    const range = el("div", "setting-segmented usage-range");
    for (const days of [7, 30, 90]) {
      const button = el("button", `setting-segment${state.usageRange === days ? " active" : ""}`, s.rangeDays(days));
      button.type = "button";
      button.addEventListener("click", () => {
        state.usageRange = days;
        api.send({ cmd: "getUsage", days });
        render();
      });
      range.appendChild(button);
    }
    body.appendChild(range);

    if (!summary) {
      body.appendChild(el("p", "setting-note", s.loading));
      return;
    }

    const tiles = el("div", "usage-tiles");
    const total = summary.totals.inputTokens + summary.totals.outputTokens;
    const tile = (label, value, sub) => {
      const node = el("div", "usage-tile");
      node.appendChild(el("span", "usage-tile-label", label));
      node.appendChild(el("strong", "usage-tile-value", value));
      if (sub) node.appendChild(el("span", "usage-tile-sub", sub));
      return node;
    };
    tiles.append(
      tile(s.usageTotal, formatTokens(total), s.rangeDays(state.usageRange)),
      tile(s.usageInput, formatTokens(summary.totals.inputTokens)),
      tile(s.usageOutput, formatTokens(summary.totals.outputTokens)),
      tile(s.usageCached, formatTokens(summary.totals.cachedTokens)),
      tile(s.usageTurns, String(summary.totals.turns)),
    );
    // Money is the number people actually act on; token counts only explain it.
    if (summary.totals.cost > 0) {
      tiles.append(tile(s.usageCost, formatMoney(summary.totals.cost), s.usageEstimate));
    }
    body.appendChild(tiles);

    const chart = el("div", "usage-chart");
    const max = Math.max(1, ...summary.days.map((day) => day.inputTokens + day.outputTokens));
    for (const day of summary.days) {
      const column = el("div", "usage-day");
      const value = day.inputTokens + day.outputTokens;
      const bar = el("div", "usage-bar");
      bar.style.height = `${Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100))}%`;
      bar.title = `${day.date} · ${formatTokens(value)} ${t.tokens}`;
      if (value === 0) bar.classList.add("empty");
      column.appendChild(bar);
      const [year, month, date] = day.date.split("-");
      if (summary.days.length <= 14 || Number(date) % 7 === 1) {
        column.appendChild(el("span", "usage-day-label", `${month}/${date}`));
      }
      column.title = `${day.date} · ${formatTokens(value)} ${t.tokens}`;
      chart.appendChild(column);
    }
    body.appendChild(chart);

    if (summary.models.length > 0) {
      const models = el("div", "usage-models");
      models.appendChild(el("h3", "setting-group-title", s.usageByModel));
      for (const model of summary.models) {
        const row = el("div", "usage-model-row");
        row.appendChild(el("span", "usage-model-name", model.model));
        const value = el("span", "usage-model-value", formatTokens(model.inputTokens + model.outputTokens));
        if (model.cost > 0) value.textContent += ` · ${formatMoney(model.cost)}`;
        row.appendChild(value);
        models.appendChild(row);
      }
      body.appendChild(models);
    } else {
      body.appendChild(el("p", "setting-note", s.usageEmpty));
    }

    // Delegation has a price; until it was itemised, `delegate` looked free.
    // Only sources that actually spent something are listed, so a session with
    // no sub-agents does not grow two zero rows.
    const spent = (summary.sources ?? []).filter((entry) => entry.inputTokens + entry.outputTokens > 0);
    if (spent.length > 1) {
      const sources = el("div", "usage-models");
      sources.appendChild(el("h3", "setting-group-title", s.usageBySource));
      const labels = {
        main: s.usageSourceMain,
        subagent: s.usageSourceSubagent,
        background: s.usageSourceBackground,
      };
      for (const entry of spent) {
        const row = el("div", "usage-model-row");
        row.appendChild(el("span", "usage-model-name", labels[entry.source] ?? entry.source));
        const value = el("span", "usage-model-value", formatTokens(entry.inputTokens + entry.outputTokens));
        if (entry.cost > 0) value.textContent += ` · ${formatMoney(entry.cost)}`;
        row.appendChild(value);
        sources.appendChild(row);
      }
      body.appendChild(sources);
    }
    body.appendChild(el("p", "setting-note", s.usageNote));
  };

  state.renderUsagePage = render;
  render();
  return pane;
}

/** Prices are an estimate from a local table, so the label says so. */
function formatMoney(dollars) {
  if (!dollars) return "$0";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Only an http(s) endpoint can be called, so a URL of any other scheme is
 *  refused here rather than written and discovered on the first turn. */
function isFetchableUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Model services (page id `connection`): the endpoints every turn talks to.
 *
 * This page edits `providers.json` as one document, because the host writes it
 * that way (`saveProviders` → `writeProviders` validates the whole file before
 * touching disk). That is why, alone among the pages, it has a Save step: a
 * per-control write would carry only one field and silently drop its siblings.
 *
 * Two shapes come from the host and are not interchangeable: `providers` is the
 * flat list behind the model picker, `providerConfig` is the file itself.
 */
function buildConnectionPage() {
  const s = S();
  const pane = sPage(s.pageConnection, s.pageConnectionDesc);
  pane.classList.add("page-wide");

  // A fresh build starts from the host's snapshot; whatever the user had typed
  // belonged to the DOM that is being replaced. `fillSettings` does not rebuild
  // while a draft is dirty, so reaching here means there is no draft to lose.
  connectionDirty = false;
  // Any test started by the pane that is being replaced is now writing into a
  // tree nothing shows. Its answer has nowhere honest to go, so the record is
  // dropped and the timer cancelled; the rebuild draws fresh, idle buttons.
  abandonConnectionTests();
  const build = connectionPageBuild;

  const config = state.settings?.providerConfig;
  // Nothing safe to edit: `state.settings` is null until the host answers, and
  // a host that omits `providerConfig` cannot be written back — an empty form
  // saved in either state would replace a file nobody read with `{}`.
  if (config === undefined || config === null || typeof config !== "object" || Array.isArray(config)) {
    pane.appendChild(sHint(state.settings ? s.connUnsupported : s.connLoading));
    return pane;
  }

  // A read failure is stated, not hidden: the form below starts empty because
  // the file could not be parsed, and saving replaces it. Disabling the form
  // would leave the user with no way to repair the file from here.
  const readError = typeof state.settings.providersError === "string" ? state.settings.providersError : "";
  if (readError !== "") {
    pane.appendChild(el("p", "setting-note pack-problem", s.connReadFailed.replace("{error}", readError)));
  }

  // `openSetup` asks for this by setting the flag before it opens the page.
  // The hint has to be part of the build: the pane is rebuilt whenever the host
  // answers, and a hint written into the old node would vanish with it.
  const setupHint = el("p", "setting-note", connectionSetupHint ? t.setupHint : "");
  setupHint.id = "models-hint";
  setupHint.hidden = !connectionSetupHint;
  pane.appendChild(setupHint);

  const list = el("div");
  const emptyCard = el("div", "settings-empty-card");
  emptyCard.appendChild(el("h3", "", s.connEmptyTitle));
  emptyCard.appendChild(el("p", "", s.connEmptyBody));

  // `providers.json` was written but the display names could not be stored:
  // the services saved, their labels did not, and only a visible line says so
  // (R3 — a silently dropped field is a save that lied).
  if (providerMetaWriteFailed) {
    pane.appendChild(el("p", "setting-note pack-problem", s.connMetaWriteFailed));
    providerMetaWriteFailed = false;
  }

  // "Saved" is a success colour, so it gets its own node: painting "unsaved"
  // green would say the opposite of what it means.
  const savedNote = el("span", "setting-inline-status", connectionShowSaved ? s.saved : "");
  const unsavedNote = el("span", "setting-desc", "");
  const drawStatus = () => {
    savedNote.textContent = connectionShowSaved ? s.saved : "";
    unsavedNote.textContent = connectionDirty ? s.connUnsaved : "";
  };

  /** Any edit makes the draft the truth on screen and the file stale. */
  const markDirty = () => {
    connectionEditSeq += 1;
    connectionShowSaved = false;
    if (connectionDirty) {
      drawStatus();
      return;
    }
    connectionDirty = true;
    drawStatus();
  };

  const cards = [];
  const syncEmpty = () => {
    emptyCard.hidden = cards.length > 0;
  };
  /** `openSetup` focuses `#setting-base-url`, so the id has to follow
   *  whichever card is first — including after the first one is removed. */
  const refreshIds = () => {
    for (const card of cards) card.baseUrlInput.removeAttribute("id");
    cards[0]?.baseUrlInput.setAttribute("id", "setting-base-url");
    // openSetup 的焦点请求在每次重建时兑现一次：宿主慢回包时重建会把
    // 焦点打掉，靠这里补回来，而不是靠固定延时。
    if (connectionSetupFocus && cards[0]?.baseUrlInput) {
      cards[0].baseUrlInput.focus();
      connectionSetupFocus = false;
    }
  };

  /**
   * 显示名称与厂商归属，按服务名索引，来自渲染层 localStorage。
   *
   * `providers.json` 的 schema 会剥掉未知键，所以这两样不进文件（见
   * `provider-meta.js`）。页面重建时重读一次：别的窗口或上一次会话写下的
   * 标签要能跟上。
   */
  const storage = providerMetaStorage();
  let meta = readProviderMeta(storage);
  // Only the write path replaces it (after a successful write, so the page's
  // own state is what was stored); every read goes through the variable.

  /** The first free default name; `provider1` unless that one is taken. */
  const nextName = () =>
    nextProviderName(cards.map((card) => card.nameInput.value.trim()), null);

  // The only protocol the kernel has (`ProviderConfigSchema` in
  // src/config/providers.ts). A new entry carries it so the card states what
  // it will be saved as, rather than leaving the field to be guessed at.
  const DEFAULT_PROTOCOL = "openai-chat-completions";
  const blankEntry = () => ({
    name: nextName(),
    protocol: DEFAULT_PROTOCOL,
    baseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    // A model row is a name and nothing else. Its context window and output
    // cap are the kernel's to estimate (`src/config/providers.ts` defaults
    // them): an OpenAI-compatible endpoint does not report either, so asking
    // the user to type them was asking for a guess in a required field.
    models: [{ id: "", carried: {} }],
    extra: {},
  });

  /**
   * One saved provider, copied field by field.
   *
   * `carried` is per model: the fields this page does not show. They are kept
   * so saving does not erase a value the user set in an editor — the form not
   * displaying a field must not mean the file loses it (R3).
   *
   * `contextWindow` is copied here so the row has it to seed its select;
   * `modelRowState` then pulls it out of `carried`, because the select is that
   * key's edit surface and `modelEntryForSave` is what writes it back or omits
   * it.
   *
   * `extra` holds the provider-level keys the schema allows but this page does
   * not edit (`requestTimeoutMs`, `maxResponseBytes`, `pricePerMillion`); they
   * are carried through for the same reason.
   */
  const entryFrom = (name, provider) => {
    // Both come from localStorage (`provider-meta.js`), never from the file.
    // `providerIdentity` falls back to the service name for services
    // configured before this field existed; a `null` vendor means Custom.
    // A display name equal to the service name is stored as "" so the field
    // shows its placeholder rather than a second copy of the same string.
    const identity = providerIdentity(meta, name);
    return {
    name,
    displayName: identity.displayName === name ? "" : identity.displayName,
    vendor: identity.vendor,
    protocol: typeof provider?.protocol === "string" ? provider.protocol : DEFAULT_PROTOCOL,
    baseUrl: typeof provider?.baseUrl === "string" ? provider.baseUrl : "",
    // The key lives in the file in clear text (`ProviderConfigSchema.apiKey`).
    // It is carried in both directions: a file written by hand must not lose
    // the key just because the form went through a save.
    apiKey: typeof provider?.apiKey === "string" ? provider.apiKey : "",
    apiKeyEnv: typeof provider?.apiKeyEnv === "string" ? provider.apiKeyEnv : "",
    models: Object.entries(provider?.models ?? {}).map(([id, model]) => ({
      id,
      carried: carriedFromModel(model),
    })),
    extra: {
      ...(provider?.requestTimeoutMs !== undefined ? { requestTimeoutMs: provider.requestTimeoutMs } : {}),
      ...(provider?.maxResponseBytes !== undefined ? { maxResponseBytes: provider.maxResponseBytes } : {}),
      ...(provider?.pricePerMillion !== undefined ? { pricePerMillion: provider.pricePerMillion } : {}),
    },
    };
  };

  /**
   * What a new card starts as: an empty custom service.
   *
   * The vendor is Custom until the picker says otherwise — the page does not
   * guess a vendor from anything (R3), and a new card has no evidence either
   * way.
   */
  const newEntry = () => ({ ...blankEntry(), displayName: "", vendor: null });

  /** One card. Values are read from the live inputs at save time, so adding or
   *  removing a card never has to re-read the DOM first. */
  const makeCard = (entry) => {
    const node = el("section", "settings-form-card");
    /** Open or closed. Kept outside the DOM because the page can be rebuilt
     *  under it. `lastName` is the name the mark is filed under, tracked
     *  separately so a rename can move it — trimmed, because `save()` writes
     *  the trimmed name and the set has to agree with the file. */
    let expanded = connectionExpanded.has(entry.name.trim());
    let lastName = entry.name.trim();
    /** 这张卡此刻选中的厂商归属（预设 id 或 null = 自定义）。它不再从服务名
     *  反查：同一个厂商可以有多张卡，名字是名字、厂商是厂商。首次进入时用
     *  `provider-meta.js` 的判定（有存过的归属就用它，没有才从名字兼容旧数据）。 */
    let vendor = entry.vendor ?? null;

    const head = el("div", "settings-card-head");
    // A real button, so Enter and Space work without a key handler and
    // `aria-expanded` states what the chevron already shows.
    const toggle = el("button", "settings-card-toggle");
    toggle.type = "button";
    const chevron = iconEl("chevron-right", "settings-card-chevron");
    // The header answers "which key is this?": the display name first, then a
    // muted second line with the service name and vendor. Two cards of the
    // same vendor are told apart by the display name, and the service name is
    // what the file (and every `service/model` reference) actually uses.
    const titleBox = el("span", "settings-card-title");
    const title = el("span", "settings-card-name", "");
    const subtitle = el("span", "settings-card-sub", "");
    titleBox.append(title, subtitle);
    // What a closed card has to answer, without being opened: who this is,
    // how many models it offers, and whether it has what it needs to answer.
    // Each badge is an icon *and* words — colour alone would not survive the
    // high-contrast theme, a colour-blind reader, or a screenshot pasted into
    // a bug report. The endpoint and the keys themselves stay in the body;
    // collapsing is what puts them away.
    const badges = el("span", "conn-card-badges");
    const keyBadge = el("span", "conn-badge");
    const modelBadge = el("span", "conn-badge");
    // Only drawn when the address is empty: a card with no endpoint cannot be
    // saved, so that fact belongs in the header rather than surfacing only
    // when Save refuses.
    const addressBadge = el("span", "conn-badge warn");
    addressBadge.hidden = true;
    badges.append(keyBadge, modelBadge, addressBadge);
    const headMark = el("span", "settings-card-mark");
    toggle.append(chevron, headMark, titleBox, badges);
    /** This card's own ordinal, fixed at build time. Naming the picker's DOM
     *  ids from it keeps them unique even after a rename — `connectionCardSeq`
     *  is bumped by the next card, so reading it later would drift. */
    const cardSeq = connectionCardSeq++;
    const body = el("div", "settings-form-card-body");
    body.id = `settings-card-body-${cardSeq}`;
    toggle.setAttribute("aria-controls", body.id);
    // The test button and Remove go here; the button is built below, once the
    // result area it talks to exists. They sit outside the toggle so a click
    // on either is not also a click on the header.
    const headActions = el("div", "mcp-actions");
    head.append(toggle, headActions);

    const nameInput = sText({ value: entry.name, placeholder: "provider1", mono: true });
    const baseUrlInput = sText({
      value: entry.baseUrl,
      placeholder: "https://api.example.com/v1",
      mono: true,
    });
    /**
     * 人看的标签。默认等于服务名，改它就只是改标签——文件里的键仍是服务名。
     *
     * 它不在 `providers.json` 里（内核 schema 会剥掉），由 `save()` 写进
     * localStorage。空着等于「没设」：页面上显示服务名，不是编一个名字。
     */
    const displayNameInput = sText({
      value: entry.displayName ?? "",
      placeholder: entry.name || "",
    });
    displayNameInput.addEventListener("input", drawCardHeader);

    /** Redraw the header from the live inputs. Called on every keystroke that
     *  changes what the collapsed card says: display name, service name, and
     *  (through `refreshHeaderFacts`) the key, the endpoint and the models. */
    function drawCardHeader() {
      const serviceName = nameInput.value.trim();
      const displayName = displayNameInput.value.trim();
      const preset = vendor === null ? undefined : presetById(vendor);
      title.textContent =
        displayName !== ""
          ? displayName
          : serviceName !== ""
            ? serviceName
            : s.connNewProvider;
      // 第二行：服务名 + 厂商。服务名为空的新卡没有「键」可报，就只剩厂商。
      const vendorLabel = preset ? preset.label : s.connProviderCustomShort;
      subtitle.textContent = [serviceName, vendorLabel].filter(Boolean).join(" · ");
      headMark.textContent = "";
      headMark.appendChild(vendorMarkEl(preset?.id));
      // `drawBadges` also redraws the toggle's `aria-label`, which restates the
      // badges — the title is part of that name and has just changed.
      drawBadges();
    }

    /**
     * 卡片第一行的厂商选择器。
     *
     * 选中哪一家是这张卡自己的状态（`vendor`），不与服务名绑定——同一个厂商
     * 可以有任意多张卡。选一家预设时：
     * - 归属记为这家；
     * - 服务名只在它是页面自己生成的时候跟着换（`isAutoProviderName`：空、
     *   上一家厂商的 id 或它的 `-N`、`providerN`），换出来的名字在撞名时自动
     *   加后缀；手写的 `my-gateway` 不动——改厂商不等于改服务名；
     * - 地址交给 `presetFillFor`：只在空着或仍是某个预设地址时才换，用户手填
     *   的网关不被覆盖；
     * - 「推荐模型」chip 行按新厂商重画。
     */
    const providerPicker = sProviderPicker({
      id: `provider-picker-${cardSeq}`,
      value: vendor,
      labels: {
        menu: s.connProvider,
        custom: s.connProviderCustom,
      },
      getOptions: () => providerPickerOptions(vendor),
      onChange: (presetId, { source }) => {
        const previousVendor = vendor;
        vendor = presetId;
        providerPicker.setValue(vendor);
        const fill = presetFillFor(presetId === null ? null : presetById(presetId), {
          baseUrl: baseUrlInput.value,
        });
        if (fill !== null) {
          const serviceName = nameInput.value.trim();
          // A name this page would have generated itself — empty, a preset id,
          // or a generated suffix (`deepseek-2`, `provider1`) — follows the new
          // vendor, with a suffix when that vendor is already taken. A
          // hand-written name (`my-gateway`, `deepseek-home`) is left alone:
          // renaming a configured service is not what changing the vendor is
          // asking for.
          const otherNames = () =>
            cards
              .filter((card) => card.nameInput !== nameInput)
              .map((card) => card.nameInput.value);
          if (isAutoProviderName(serviceName, previousVendor)) {
            const nextNameValue = nextProviderName(otherNames(), fill.name);
            if (nextNameValue !== nameInput.value) {
              nameInput.value = nextNameValue;
              nameInput.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
          baseUrlInput.value = fill.baseUrl;
        }
        drawCardHeader();
        drawSuggestions();
        // 鼠标选完，焦点落在密钥栏：名字与地址刚刚替用户填好，下一步就是贴
        // key。键盘选完则留在触发器上——用户还在操作这个控件，焦点被抢走就
        // 等于把键盘流打断了。
        if (source === "pointer") apiKeyInput.focus();
        markDirty();
      },
    });

    nameInput.addEventListener("input", () => {
      const name = nameInput.value.trim();
      // The placeholder shows the default: leaving the display name blank is
      // exactly "call it whatever the service is called".
      displayNameInput.placeholder = name;
      drawCardHeader();
      // The expansion is filed by name, and this field is what changes it:
      // without the move, the next rebuild would reopen nothing.
      if (name !== lastName) {
        if (expanded) renameExpansion(lastName, name);
        lastName = name;
      }
    });
    const apiKeyEnvInput = sText({
      value: entry.apiKeyEnv,
      placeholder: "DEEPSEEK_API_KEY",
      mono: true,
    });

    /**
     * The key itself, saved in clear text in `providers.json`.
     *
     * `password` by default so a shoulder behind the user reads nothing; the
     * reveal button exists because "did the paste truncate?" is otherwise
     * unanswerable. The toggle carries its own `aria-label`, which changes with
     * the state, so it says what the next click will do rather than what the
     * field is doing now.
     */
    const apiKeyInput = document.createElement("input");
    apiKeyInput.className = "setting-input mono";
    apiKeyInput.type = "password";
    apiKeyInput.spellcheck = false;
    apiKeyInput.placeholder = "sk-…";
    apiKeyInput.value = entry.apiKey ?? "";
    apiKeyInput.autocomplete = "off";
    const apiKeyToggle = el("button", "btn small btn-quiet", s.connApiKeyShow);
    apiKeyToggle.type = "button";
    apiKeyToggle.setAttribute("aria-label", s.connApiKeyShow);
    const setKeyVisibility = (visible) => {
      apiKeyInput.type = visible ? "text" : "password";
      const label = visible ? s.connApiKeyHide : s.connApiKeyShow;
      apiKeyToggle.textContent = label;
      apiKeyToggle.setAttribute("aria-label", label);
      apiKeyToggle.setAttribute("aria-pressed", visible ? "true" : "false");
    };
    apiKeyToggle.addEventListener("click", () => setKeyVisibility(apiKeyInput.type === "password"));
    setKeyVisibility(false);

    /** The inline warning under a field: shown, never a reason to refuse a save. */
    const warningLine = () => {
      const line = el("p", "setting-note pack-problem", "");
      line.hidden = true;
      return line;
    };
    const keyWarning = warningLine();
    const envWarning = warningLine();
    const setWarning = (line, message) => {
      line.textContent = message;
      line.hidden = message === "";
    };

    /**
     * One input cell: the field, an optional button beside it, and the warning
     * that belongs under that field.
     *
     * Laid out inline rather than through a stylesheet class, the same way the
     * test result colours itself: a warning parked in the card's shared problem
     * line would be a sentence about a field, far from the field.
     */
    const fieldCell = (input, button, warning) => {
      const cell = el("div");
      cell.style.display = "grid";
      cell.style.gap = "4px";
      cell.style.width = "100%";
      const line = el("div");
      line.style.display = "flex";
      line.style.alignItems = "center";
      line.style.gap = "8px";
      input.style.flex = "1 1 auto";
      input.style.minWidth = "0";
      line.appendChild(input);
      if (button) {
        // A one-word button ("Show" / 显示) must not borrow the line's height:
        // in a flex row it stretches to the tallest item and, with the type
        // ramp up a step, a 2-character label wrapped onto two lines. It keeps
        // its own single-line box and its own width.
        button.style.flex = "0 0 auto";
        button.style.whiteSpace = "nowrap";
        line.appendChild(button);
      }
      cell.append(line, warning);
      return cell;
    };

    // A key can come from the environment instead; when it does, the empty key
    // field must say so rather than look like a missing credential.
    const keyEnvHint = el("p", "setting-note conn-key-env-hint", "");
    keyEnvHint.hidden = true;
    /** The "required" tag on the key row; assigned when that row is built. The
     *  first model row is drawn before it and reaches `drawBadges`, so the name
     *  has to exist — empty — from here on. */
    let keyRequiredMark = null;

    const modelList = el("div", "mcp-list");
    /** One row: a name, a context-window select, and Remove. `carried` rides
     *  along untouched so a save does not drop the counters this page does not
     *  edit (`maxOutput`, `supportsReasoning`, `reasoningEffort`). */
    const modelHandles = [];
    /** 「推荐模型」行；在模型组之后构建（它要用这里的 `addModelRow`），
     *  行本身的点击与重画由 `drawSuggestions` 驱动。 */
    let drawSuggestions = () => {};
    /** Assigned when the advanced section is built. The first model row is
     *  drawn before that happens, and its `refreshModelSummary` reaches the
     *  advanced summary, so the field has to exist — empty — from here on. */
    let advancedSummary = null;

    /**
     * One state badge in the header: an icon and a word.
     *
     * Colour is a third signal, never the only one — the high-contrast theme
     * has to carry the same fact, and so does a reader who cannot tell
     * `--success` from `--warn`.
     */
    const setBadge = (node, { icon, label, tone = "", title = "" }) => {
      node.className = `conn-badge${tone === "" ? "" : ` ${tone}`}`;
      node.textContent = "";
      node.append(iconEl(icon, "conn-badge-icon"), el("span", "conn-badge-text", label));
      if (title === "") node.removeAttribute("title");
      else node.title = title;
    };

    /**
     * Repaint the header's three facts from the live controls.
     *
     * The header is the only thing a collapsed card shows, so it has to track
     * the inputs rather than the `entry` it was built from: typing a key,
     * clearing the endpoint or adding a model has to be visible without
     * opening the card. A blank model row is skipped — it is an invitation to
     * type, not a model.
     *
     * The env-var state says what the card holds, not that the service will
     * work: the renderer cannot read the app's environment, so "a variable is
     * named" and "that variable is set" are different facts and only the
     * first is known here (R3).
     */
    function drawBadges() {
      const names = modelHandles.map((handle) => handle.idInput.value.trim()).filter((id) => id !== "");
      const facts = serviceHeaderFacts({
        apiKey: apiKeyInput.value,
        apiKeyEnv: apiKeyEnvInput.value,
        baseUrl: baseUrlInput.value,
        modelCount: names.length,
      });
      if (facts.key === "direct") {
        setBadge(keyBadge, { icon: "check", tone: "ok", label: s.connKeyDirect, title: s.connKeyDirectTitle });
      } else if (facts.key === "env") {
        setBadge(keyBadge, {
          icon: "shield",
          tone: "neutral",
          label: s.connKeyEnv,
          title: s.connKeyEnvTitle.replace("{name}", facts.envName),
        });
      } else {
        setBadge(keyBadge, { icon: "alert", tone: "warn", label: s.connKeyMissing, title: s.connKeyMissingTitle });
      }
      const countTemplate =
        facts.modelCount === 1 && s.connModelCountOne !== undefined ? s.connModelCountOne : s.connModelCount;
      setBadge(modelBadge, {
        icon: "layers",
        label: countTemplate.replace("{n}", String(facts.modelCount)),
        tone: facts.modelCount === 0 ? "warn" : "neutral",
        title: names.join(" · "),
      });
      addressBadge.hidden = !facts.noBaseUrl;
      if (facts.noBaseUrl) {
        setBadge(addressBadge, {
          icon: "alert",
          tone: "warn",
          label: s.connNoAddress,
          title: s.connNoAddressTitle,
        });
      }
      // The advanced summary restates the env-var field, which is folded away.
      drawAdvancedSummary();
      // The key row is marked required, but an env-var key satisfies it: the
      // hint below the field says which of the two the card is relying on.
      const usesEnv = facts.key === "env";
      keyEnvHint.hidden = !usesEnv;
      keyEnvHint.textContent = usesEnv ? s.connKeyFromEnv.replace("{name}", facts.envName) : "";
      if (keyRequiredMark !== null) keyRequiredMark.hidden = usesEnv;
      // The header's accessible name restates these badges, so it has to be
      // redrawn with them — not only when the title changes.
      drawToggleLabel();
      // 已加过的名字要从建议里让位，否则点一下就是一条重复行。
      drawSuggestions();
    }
    /** Kept under its old name: the model rows, the key fields and the endpoint
     *  all call it, because all three change what the collapsed card says. */
    const refreshModelSummary = drawBadges;
    const addModelRow = (model) => {
      // `.model-row` on top of `.rules-row`: the latter carries the frame
      // (border, padding, gap), while the former divides the free width
      // between the id and the two fixed-size controls beside it.
      const row = el("div", "rules-row model-row");
      const idInput = sText({ value: model.id, placeholder: "model-name", mono: true });
      idInput.setAttribute("aria-label", s.connModelName);
      // The row is the header's data source, so it has to say when it changes.
      // A row removed below takes its listener with it.
      idInput.addEventListener("input", refreshModelSummary);
      // `modelRowState` splits what the file holds into the keys this row does
      // not edit and the select's options; a value already in the file that no
      // size covers gets an option of its own, selected, so the first save
      // cannot rewrite it (R3).
      const rowState = modelRowState(model.carried, {
        defaultLabel: s.connContextWindowDefault,
        customLabel: s.connContextWindowCustom,
      });
      const windowSelect = sSelect({
        value: rowState.select.selected,
        options: rowState.select.options,
        onChange: () => {},
      });
      windowSelect.setAttribute("aria-label", s.connContextWindow);
      windowSelect.title = s.connContextWindowDesc;
      const remove = sButton(
        s.remove,
        () => {
          const at = modelHandles.findIndex((handle) => handle.row === row);
          if (at >= 0) modelHandles.splice(at, 1);
          row.remove();
          refreshModelSummary();
          markDirty();
        },
        { quiet: true, danger: true },
      );
      // `rowState.carried` has no `contextWindow`: the select is that key's
      // only owner from here on. Save folds the two back together with
      // `modelEntryForSave`, which never reads a stale copy.
      const handle = { row, idInput, windowSelect, carried: rowState.carried };
      modelHandles.push(handle);
      row.append(idInput, windowSelect, remove);
      modelList.appendChild(row);
      refreshModelSummary();
      return handle;
    };
    // A service with no models yet still gets one empty row: a card that only
    // holds "add" would hide what a model entry looks like.
    for (const model of entry.models.length > 0 ? entry.models : [{ id: "", carried: {} }]) {
      addModelRow(model);
    }
    const addModel = sButton(
      s.connAddModel,
      () => {
        addModelRow({ id: "", carried: {} });
        markDirty();
      },
      { quiet: true },
    );
    const modelFoot = el("div", "settings-list-foot");
    modelFoot.appendChild(addModel);

    // The models field is not a `.setting-row`: its control is a list, not one
    // input, and a label/control split would squeeze it into half the card.
    // The heading and description sit above the full-width list instead, and
    // each row carries its own `aria-label`.
    const modelsGroup = el("div", "conn-field");
    modelsGroup.dataset.search = `${s.connModels} ${s.connModelsDesc}`.toLowerCase();
    const modelHead = el("div", "setting-label-line");
    modelHead.append(
      el("span", "setting-label", s.connModels),
      el("span", "setting-required", s.connRequired),
    );
    modelsGroup.append(modelHead, el("p", "setting-desc", s.connModelsDesc), modelList, modelFoot);

    /**
     * 「推荐模型」：预设带的模型名，点一下才进卡片。
     *
     * 为什么不直接预填进模型行：官方文档里的模型名会随版本退役，写进文件
     * 就是一条可能失效的断言。chip 把「服务商这么说」和「我确认要这个」
     * 分开，文件里只留后者。
     *
     * 整行在两种情况下消失：预设没有模型名（OpenAI：文档站不可达，没核实
     * 过），或者全部都已在卡片里。前者是「我们没说」，后者是「这一行已经
     * 没有可点的东西」——两种情况都不该留一个空标题。
     */
    const suggestionRow = el("div", "preset-models");
    suggestionRow.hidden = true;
    drawSuggestions = () => {
      // The vendor is what says which documented names apply — not the
      // service name, which may be `deepseek-2` or a hand-written key.
      const pending = presetModelSuggestions(
        vendor === null ? [] : (presetById(vendor)?.models ?? []),
        modelHandles.map((handle) => handle.idInput.value),
      );
      suggestionRow.textContent = "";
      suggestionRow.hidden = pending.length === 0;
      if (pending.length === 0) return;
      suggestionRow.appendChild(el("span", "preset-models-label", s.connSuggestedModels));
      for (const name of pending) {
        const chip = el("button", "preset-model-chip");
        chip.type = "button";
        chip.title = s.connTestAddModel;
        chip.setAttribute("aria-label", `${name} — ${s.connTestAddModel}`);
        chip.append(iconEl("plus", "preset-model-chip-icon"), el("span", "", name));
        chip.addEventListener("click", () => {
          // A blank row is an invitation to type, not a model the user wanted:
          // fill the first one instead of appending, or a fresh card would end
          // up with an empty row beside the one just added — and Save refuses
          // a row without a name. Only add a row when every row already names
          // a model.
          const blank = modelHandles.find((handle) => handle.idInput.value.trim() === "");
          if (blank) {
            blank.idInput.value = name;
            blank.idInput.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            addModelRow({ id: name, carried: {} });
          }
          markDirty();
          // 这一行因为这个点击少一个 chip；加完重画，全部加完时整行收起。
          drawSuggestions();
        });
        suggestionRow.appendChild(chip);
      }
    };
    // 厂商一变，预设就跟着变；选回「自定义」时整行缩回去——那正是用户放弃
    // 预设、准备手填的时刻。模型行增删也要重画，否则已加过的名字会留在建议
    // 里，点一下就是一条重复行。
    drawSuggestions();

    // A rejected value has to say so where the field is, not in a notice that
    // scrolls away from the control at fault.
    const problem = el("p", "setting-note pack-problem", "");
    problem.hidden = true;

    /** What the last connection test said. Built fresh with the card, so a
     *  result never outlives the page that produced it. A container rather
     *  than a paragraph: a successful test draws a structured block, while a
     *  failure stays one line of text in the same place. `aria-live` because
     *  the answer arrives after the click, and a result only a sighted user
     *  can perceive is a click that reported nothing (R3).
     *
     *  It is the first thing in the body (see `body.append` below), directly
     *  under the header that holds the Test button. At the foot of the form it
     *  answered a click from a full set of fields away — the user had to find
     *  the result rather than simply see it. */
    const testResult = el("div", "setting-note", "");
    testResult.hidden = true;
    testResult.setAttribute("aria-live", "polite");

    // The protocol is the one fixed fact about a card (the kernel has exactly
    // one), so it stays a chip rather than a field. It lives in the advanced
    // section: nothing here can change it, and it is a detail of how the
    // endpoint is spoken to rather than a decision the form offers.
    const protocolLine = el("div", "settings-card-protocol");
    protocolLine.append(el("span", "conn-advanced-label", s.connProtocol), el("code", "setting-code", entry.protocol));

    // None of the warnings below stops a save: the value is written as typed,
    // and a wrong guess about a real naming scheme must not cost the user their
    // configuration (R3 — warn, do not pretend to know).
    //
    // `testResult` leads the body: the Test button is in the header just above
    // it, so the answer lands where the click happened instead of below every
    // field in the form. `problem`, the body's other note, stays at the foot —
    // it belongs to Save, which is at the foot too.
    // The provider picker leads the form: it is the one row that can fill in
    // the address below it, so it has to be read before it.
    //
    // Three tiers, because eight equal rows hid what a card actually needs:
    // 1) the minimum that makes a service work — vendor, key, models;
    // 2) things that already have a sensible value and are edited rarely —
    //    display name, service name (it changes `service/model` references
    //    already in sessions), address (filled by the vendor choice);
    // 3) the env-var key and the protocol — almost never touched, so they are
    //    folded away and the summary says what is inside.
    const requiredSection = el("section", "conn-section");
    requiredSection.append(
      el("h3", "conn-section-title", s.connSectionRequired),
      el("p", "conn-section-desc", s.connSectionRequiredDesc),
    );
    const keyRow = sRow({
      label: s.connApiKey,
      desc: s.connApiKeyDesc,
      control: fieldCell(apiKeyInput, apiKeyToggle, keyWarning),
      required: true,
    });
    // The key row is required *or* filled by the env-var field below. While a
    // variable is named, the tag on the empty key field would call a working
    // card unfinished, so it moves with the live state.
    keyRequiredMark = keyRow.querySelector(".setting-required");

    requiredSection.append(
      // `id` names the trigger, not the wrapper: the label has to point at the
      // thing a click focuses.
      sRow({
        id: providerPicker.controlId,
        label: s.connProvider,
        desc: s.connProviderDesc,
        control: providerPicker.node,
        required: true,
      }),
      keyRow,
      keyEnvHint,
      modelsGroup,
      suggestionRow,
    );

    const optionalSection = el("section", "conn-section");
    optionalSection.append(
      el("h3", "conn-section-title", s.connSectionOptional),
      el("p", "conn-section-desc", s.connSectionOptionalDesc),
      // 显示名称在服务名之上：它是人先看到、也先用来区分两张同厂商卡的那一行。
      sRow({ label: s.connDisplayName, desc: s.connDisplayNameDesc, control: displayNameInput }),
      sRow({ label: s.name, desc: s.connNameDesc, control: nameInput }),
      sRow({ label: s.baseUrl, desc: s.baseUrlDesc, control: baseUrlInput }),
    );

    // A native `<details>` gives the disclosure its keyboard behaviour for
    // free (Enter/Space on the summary, announced expanded state) and needs no
    // key handler. The summary carries the live env-var name, so a folded
    // section still says whether it holds anything.
    const advanced = el("details", "setting-advanced");
    advancedSummary = el("summary", "setting-advanced-summary", "");
    advanced.appendChild(advancedSummary);
    const advancedBody = el("div", "setting-advanced-body");
    advancedBody.append(
      sRow({
        label: s.connApiKeyOrEnv,
        desc: s.connApiKeyEnvDesc,
        control: fieldCell(apiKeyEnvInput, null, envWarning),
      }),
      protocolLine,
    );
    advanced.appendChild(advancedBody);
    // A value already in the file is opened, not hidden: folding it away while
    // it is in effect would make the card look like it has no key at all.
    advanced.open = entry.apiKeyEnv.trim() !== "";

    /** The advanced summary: what is folded under it, or that nothing is. */
    function drawAdvancedSummary() {
      if (advancedSummary === null) return;
      const selected = serviceHeaderFacts({ apiKey: apiKeyInput.value, apiKeyEnv: apiKeyEnvInput.value });
      advancedSummary.textContent =
        selected.key === "env"
          ? s.connAdvancedEnv.replace("{name}", selected.envName)
          : s.connAdvancedIdle;
    }

    body.append(testResult, requiredSection, optionalSection, advanced, problem);
    node.append(head, body);

    /**
     * What the header announces.
     *
     * An `aria-label` replaces the button's own content, so it has to carry
     * both halves: the action ("Expand") and which service it applies to.
     * Without the name, every card on the page announces the same word.
     */
    function drawToggleLabel() {
      // The header's own text, not the service name: a card is announced by
      // whatever it is called on screen, which with two keys of one vendor is
      // the display name, not the generated file key.
      const name = title.textContent || s.connNewProvider;
      // `aria-label` replaces the button's content, and the badges are inside
      // it — without this the state a sighted user reads off the header would
      // be silent to a screen reader.
      const state = [...badges.children]
        .filter((node) => !node.hidden)
        .map((node) => node.textContent)
        .filter(Boolean)
        .join(", ");
      const action = (expanded ? s.connCollapseNamed : s.connExpandNamed).replace("{name}", name);
      toggle.setAttribute("aria-label", state === "" ? action : `${action} — ${state}`);
    }

    /**
     * Open or close the card, and say so to assistive tech.
     *
     * `remember` is false only for the state the card opens in: an untouched
     * default must not be written into the set, or the next build would read
     * "this name is open" for a card the user never opened.
     */
    const setExpanded = (open, { remember = true } = {}) => {
      expanded = open;
      body.hidden = !open;
      // A menu that is open when the card closes would keep its document
      // listener and reopen with the card, in a state the user never asked
      // for. Closing is the same thing collapsing does to every other field.
      if (!open) providerPicker.close();
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      setIcon(chevron, open ? "chevron-down" : "chevron-right");
      drawToggleLabel();
      if (!remember) return;
      // A nameless card cannot be filed: `""` would be a key every blank card
      // shares, and opening one would open the next.
      const name = nameInput.value.trim();
      if (name === "") return;
      if (open) connectionExpanded.add(name);
      else connectionExpanded.delete(name);
    };
    toggle.addEventListener("click", () => setExpanded(!expanded));
    setExpanded(expanded, { remember: false });
    drawCardHeader();
    refreshModelSummary();

    /** Re-run both warnings against what is in the fields right now. */
    const checkFields = () => {
      // Mirror image of the accident this page is recovering from: a variable
      // name pasted into the key field would be sent as a Bearer credential.
      setWarning(
        keyWarning,
        looksLikeEnvName(apiKeyInput.value) ? s.connApiKeyLooksLikeName : "",
      );
      setWarning(
        envWarning,
        looksLikeSecret(apiKeyEnvInput.value) ? s.connApiKeyEnvLooksLikeSecret : "",
      );
    };
    // Live, not on save: the warning has to appear while the user is still
    // looking at the field they got wrong. The header follows the same three
    // controls, so a key typed or cleared is visible on the collapsed card.
    apiKeyInput.addEventListener("input", () => {
      checkFields();
      drawBadges();
    });
    apiKeyEnvInput.addEventListener("input", () => {
      checkFields();
      drawBadges();
    });
    baseUrlInput.addEventListener("input", drawBadges);
    checkFields();

    /**
     * The endpoint this card would test, and the key (direct, or the variable
     * naming it) and model that go with it; `problem` is set when the URL
     * cannot be called at all.
     *
     * The test does not save, so it reads the live inputs rather than the file:
     * a user who just typed an endpoint wants to find out whether it answers
     * before committing it.
     */
    const testTarget = () => {
      const baseUrl = baseUrlInput.value.trim();
      if (baseUrl === "") return { problem: s.connBaseUrlRequired, field: baseUrlInput };
      if (!isFetchableUrl(baseUrl)) return { problem: s.connBaseUrlInvalid, field: baseUrlInput };
      return {
        baseUrl,
        apiKey: apiKeyInput.value.trim(),
        apiKeyEnv: apiKeyEnvInput.value.trim(),
        model: modelHandles[0]?.idInput.value.trim() ?? "",
      };
    };

    let testing = false;

    /**
     * Empty the result area and forget which kind of result it held.
     *
     * Both writers start here, so a previous block can never leave a heading,
     * a chip, or the warning colour behind under a new answer.
     */
    const resetTestResult = () => {
      testResult.textContent = "";
      testResult.className = "";
      testResult.style.color = "";
    };

    /**
     * One line of outcome. A failed test takes the warn colour (the token the
     * transcript's warnings use), not the error red: an endpoint that did not
     * answer is a fact about the endpoint, not a crash. The colour is applied
     * inline because the settings stylesheet needs no entry for one class.
     *
     * Every writer opens the card first. `runTest` already does, but the answer
     * arrives later — a user who collapsed the card while waiting would other-
     * wise get a result nobody can see, and a test that "did nothing" (R3).
     */
    const showTestLine = (text, { warn = false } = {}) => {
      setExpanded(true);
      resetTestResult();
      testResult.className = "setting-note";
      testResult.textContent = text;
      testResult.style.color = warn ? "var(--warn)" : "";
      testResult.hidden = false;
    };

    /** The enabled chip says what clicking it does; the disabled one says why
     *  it cannot be clicked. */
    const chipLabel = (name, { added }) =>
      added ? `${name} — ${s.connTestAlreadyAdded}` : `${name} — ${s.connTestAddModel}`;

    /**
     * Turn a chip into the disabled "already added" state, in place.
     *
     * The chip stays where it is: removing it would make the list shrink under
     * the cursor and leave the user unsure whether the click landed. The new
     * row is what changed, and this chip is the receipt.
     */
    const markChipAdded = (chip, name) => {
      chip.classList.add("added");
      chip.disabled = true;
      chip.title = s.connTestAlreadyAdded;
      chip.setAttribute("aria-label", chipLabel(name, { added: true }));
      chip.textContent = "";
      chip.append(
        iconEl("check", "conn-model-chip-icon"),
        el("span", "conn-model-chip-name", name),
        el("span", "conn-model-chip-state", s.connTestAlreadyAdded),
      );
    };

    /**
     * A successful test, drawn as a result block: what answered, how fast, and
     * every model the endpoint listed.
     *
     * The list is complete. A model already on the card is not dropped — it is
     * drawn in the added state — because a list that quietly hides half the
     * answer is a wrong answer about the endpoint (R3).
     */
    const showTestModels = (models, latencyMs) => {
      setExpanded(true);
      resetTestResult();
      testResult.className = "conn-test-result";
      testResult.hidden = false;

      const entries = availableModelEntries(
        models,
        modelHandles.map((handle) => handle.idInput.value),
      );
      const count = entries.length;

      // The summary is built without a latency (it renders one only when it is
      // given one): the measurement gets its own muted span here, so folding
      // it into the sentence would print it twice.
      const head = el("div", "conn-test-head");
      // A test that reached the endpoint but got no list back is not the same
      // outcome as one that found models, and the mark says so rather than
      // leaving a green check beside a sentence about failure.
      const status = el("span", `conn-test-status${count === 0 ? " empty" : ""}`);
      status.append(
        iconEl("check", "conn-test-status-icon"),
        el("span", "", connectionSummary(state.locale, { modelCount: count })),
      );
      head.appendChild(status);
      if (Number.isFinite(latencyMs)) {
        head.appendChild(el("span", "conn-test-latency", `${Math.round(latencyMs)} ms`));
      }
      testResult.appendChild(head);

      // No list, no section: an empty "Available models 0" heading would be a
      // heading about nothing. The status line already said it.
      if (count === 0) return;

      const block = el("div", "conn-test-models");
      const modelsHead = el("div", "conn-test-models-head");
      modelsHead.append(
        el("span", "", s.connTestAvailableModels),
        el("span", "conn-test-count", s.connTestModelsCount.replace("{n}", String(count))),
      );
      block.appendChild(modelsHead);

      for (const entry of entries) {
        const chip = el("button", "conn-model-chip");
        chip.type = "button";
        if (entry.alreadyListed) {
          markChipAdded(chip, entry.name);
        } else {
          chip.title = s.connTestAddModel;
          chip.setAttribute("aria-label", chipLabel(entry.name, { added: false }));
          chip.append(iconEl("plus", "conn-model-chip-icon"), el("span", "conn-model-chip-name", entry.name));
          chip.addEventListener("click", () => {
            addModelRow({ id: entry.name, carried: {} });
            // The row is an edit like any other: the draft is now newer than
            // the file, and Save is what makes it real.
            markDirty();
            markChipAdded(chip, entry.name);
          });
        }
        block.appendChild(chip);
      }

      testResult.appendChild(block);
    };

    /** The test this card is waiting on, if any. */
    let currentTest = null;

    /** Drop the wait: cancel the timer and stop matching an answer to it. */
    const cancelTest = (pending) => {
      clearTimeout(pending.timer);
      connectionTestTimers.delete(pending.timer);
      const at = connectionPendingTests.indexOf(pending);
      if (at >= 0) connectionPendingTests.splice(at, 1);
      if (currentTest === pending) currentTest = null;
    };

    /** Back to the idle button, whatever the outcome was. */
    const endTest = (pending) => {
      cancelTest(pending);
      testing = false;
      testButton.disabled = false;
      testButton.textContent = s.connTest;
    };

    const runTest = () => {
      if (testing) return;
      // The result line lives in the body, so a test started from a collapsed
      // card would report to nobody. Opening it is the honest fix: the answer
      // has to be somewhere the user is looking (R3 — a click that produces no
      // visible answer is a lie by omission).
      setExpanded(true);
      const target = testTarget();
      if (target.problem !== undefined) {
        showTestLine(target.problem, { warn: true });
        target.field?.focus();
        return;
      }
      testing = true;
      testButton.disabled = true;
      testButton.textContent = s.connTesting;
      // The last answer described a test that has already happened; leaving it
      // on screen while a new one runs would show a result for the wrong try.
      resetTestResult();
      testResult.className = "setting-note";
      testResult.hidden = true;
      // No key of either kind. Leaving both empty is legal — a local endpoint
      // needs none — so this is not a refusal, but when the test then fails the
      // reason has to name the likely cause instead of leaving the user to
      // wonder what the endpoint wants.
      const keyless = target.apiKey === "" && target.apiKeyEnv === "";
      const pending = { build, baseUrl: target.baseUrl, timer: undefined };
      // The endpoint is the identity the answer comes back with; two cards may
      // be testing at once, so matching on it is what keeps an answer on the
      // card that asked.
      pending.finish = (kind, detail) => {
        endTest(pending);
        if (kind === "ok") showTestModels(detail.models ?? [], detail.latencyMs);
        else if (kind === "empty") showTestLine(s.connTestOkNoModels);
        else showTestLine(keyless ? `${detail} ${s.connTestNoKey}` : detail, { warn: true });
      };
      currentTest = pending;
      connectionPendingTests.push(pending);
      // Nothing else will ever resolve this test, and a button stuck on
      // "Testing…" is a click that produced no answer (R3).
      pending.timer = setTimeout(() => {
        connectionTestTimers.delete(pending.timer);
        if (pending.build !== connectionPageBuild) return;
        endTest(pending);
        showTestLine(s.connTestTimeout, { warn: true });
      }, CONNECTION_TEST_TIMEOUT_MS);
      // (A timeout is about reachability, not credentials, so it gets no
      // keyless addendum.)
      connectionTestTimers.add(pending.timer);
      // Only the fields that were filled in: an empty `apiKey` would ask the
      // host to send an empty credential, and an empty `apiKeyEnv` would ask it
      // to read a variable with no name.
      api.send({
        cmd: "testProvider",
        baseUrl: target.baseUrl,
        ...(target.apiKey === "" ? {} : { apiKey: target.apiKey }),
        ...(target.apiKeyEnv === "" ? {} : { apiKeyEnv: target.apiKeyEnv }),
        ...(target.model === "" ? {} : { model: target.model }),
      });
    };

    const testButton = sButton(s.connTest, runTest, { quiet: true });
    headActions.append(
      testButton,
      sButton(
        s.remove,
        () => {
          // A test this card started has nowhere to report now; leaving it
          // pending would let an answer land on a node nothing shows.
          if (currentTest) cancelTest(currentTest);
          // The card is gone, and the name it was filed under is free again;
          // leaving the mark behind would open an unrelated card that later
          // took the same name.
          if (lastName !== "") connectionExpanded.delete(lastName);
          const at = cards.findIndex((item) => item.node === node);
          if (at >= 0) cards.splice(at, 1);
          node.remove();
          markDirty();
          refreshIds();
          syncEmpty();
        },
        { quiet: true, danger: true },
      ),
    );

    /** Everything the file needs from this card, checked before it is sent: a
     *  round-trip that comes back rejected would leave the form describing a
     *  file that does not exist (R3). */
    const read = () => {
      const name = nameInput.value.trim();
      if (name === "") return { problem: s.connNameRequired, field: nameInput };
      if (name.includes("/")) return { problem: s.connNameSlash, field: nameInput };

      const baseUrl = baseUrlInput.value.trim();
      if (baseUrl === "") return { problem: s.connBaseUrlRequired, field: baseUrlInput };
      if (!isFetchableUrl(baseUrl)) return { problem: s.connBaseUrlInvalid, field: baseUrlInput };

      if (modelHandles.length === 0) return { problem: s.connModelRequired, field: addModel };
      const models = {};
      for (const handle of modelHandles) {
        const id = handle.idInput.value.trim();
        if (id === "") return { problem: s.connModelNameRequired, field: handle.idInput };
        // `resolveModelRef` splits a reference on the first `/`, so a slash in
        // either half would make `provider/model` point somewhere else.
        if (id.includes("/")) return { problem: s.connModelSlash, field: handle.idInput };
        if (Object.hasOwn(models, id)) return { problem: s.connModelDuplicate, field: handle.idInput };
        // The counters other than the context window are not on this form;
        // whatever the file already had for this model travels with it
        // unchanged. The context window comes from the row's select: "default"
        // removes the key (so `DEFAULT_CONTEXT_WINDOW` applies and follows any
        // future change to it), a number writes that number.
        models[id] = modelEntryForSave(handle.carried, handle.windowSelect.value);
      }

      // Keys are trimmed the same way the kernel trims them
      // (`resolveProviderApiKey`): a value that is only whitespace counts as
      // "not set" and is left out of the file rather than written as an empty
      // credential. Both may be present; the kernel prefers `apiKey`.
      const apiKey = apiKeyInput.value.trim();
      const apiKeyEnv = apiKeyEnvInput.value.trim();
      return {
        name,
        // 这两项不进 `value`（写的是 `providers.json`），由 `save()` 交给
        // localStorage。空白显示名称是「没设」，写进 meta 反而是给未来留一个
        // 会遮住服务名的旧标签。
        displayName: displayNameInput.value.trim(),
        vendor,
        value: {
          protocol: entry.protocol,
          baseUrl,
          ...(apiKey === "" ? {} : { apiKey }),
          ...(apiKeyEnv === "" ? {} : { apiKeyEnv }),
          models,
          // `pricePerMillion` rides in here with the other keys this page does
          // not show, for the same reason the per-model counters do.
          ...entry.extra,
        },
      };
    };

    return {
      node,
      nameInput,
      displayNameInput,
      baseUrlInput,
      // 供应商选择器里选完一家后，名字与地址已替用户填好，下一步就是贴 key。
      apiKeyInput,
      read,
      clearProblem: () => {
        problem.hidden = true;
        problem.textContent = "";
      },
      showProblem: (message, field) => {
        // The problem line is inside the body. Shown on a collapsed card it
        // would be a Save that visibly did nothing: the refusal has to open
        // the card it is about, or the user has no way to find it (R3).
        setExpanded(true);
        problem.textContent = message;
        problem.hidden = false;
        field?.focus();
      },
      /** The first-run path needs a way to open a card the user has never
       *  touched; the collapsed default would hide the field it focuses. */
      expand: () => setExpanded(true),
    };
  };

  const addCard = (entry) => {
    const card = makeCard(entry);
    cards.push(card);
    list.appendChild(card.node);
    refreshIds();
    syncEmpty();
    return card;
  };

  const save = () => {
    for (const card of cards) card.clearProblem();
    // `Object.create(null)` rather than `{}`: the file is a map keyed by names
    // the user chooses, and `__proto__` as a provider name must be a key, not
    // a prototype assignment that drops the provider.
    const next = Object.create(null);
    const read = [];
    for (const card of cards) {
      const result = card.read();
      if (result.problem !== undefined) {
        card.showProblem(result.problem, result.field);
        return;
      }
      if (result.name in next) {
        card.showProblem(s.connNameDuplicate, card.nameInput);
        return;
      }
      next[result.name] = result.value;
      read.push({ card, ...result });
    }
    // 两个卡都叫「DeepSeek 工作」，在面板左栏里就是两行一模一样的字——这正是
    // 显示名称要解决的事。比较在 `provider-meta.js` 里（trim + 忽略大小写，
    // 空显示名称按服务名算），第二个出问题的卡就地报错并聚焦。
    const duplicate = duplicateDisplayName(
      read.map((item) => ({ name: item.name, displayName: item.displayName })),
    );
    if (duplicate !== null) {
      const offender = read[duplicate.index].card;
      offender.showProblem(
        s.connDisplayNameDuplicate.replace("{name}", duplicate.displayName),
        offender.displayNameInput,
      );
      return;
    }
    // 标签不写进 `providers.json`（内核 schema 会剥掉），所以它们在这里、由
    // 页面上这些卡重新拼一整份写回 localStorage：这也是删掉的服务留下孤儿
    // 条目的清除点。
    //
    // 写在本机、不等宿主回包：写入失败时页面会明说这一半没存下，而不是让
    // 文件保存成功、标签悄悄消失（R3）。宿主拒绝保存时多出来的标签是孤儿
    // ——`provider-meta.js` 只按文件里的服务名查，孤儿永远不显示，下一次保存
    // 会把它清掉。
    const nextMeta = Object.create(null);
    for (const item of read) {
      const entryMeta = {
        ...(item.displayName !== "" ? { displayName: item.displayName } : {}),
        vendor: item.vendor,
      };
      if (Object.keys(entryMeta).length > 0) nextMeta[item.name] = entryMeta;
    }
    if (writeProviderMeta(storage, nextMeta)) {
      meta = readProviderMeta(storage);
      providerMetaWriteFailed = false;
    } else {
      providerMetaWriteFailed = true;
    }
    // The draft stays dirty until the host answers with a fresh snapshot; a
    // save that fails sends a notice and no snapshot, so the draft survives.
    connectionSavePending = true;
    connectionSavedSeq = connectionEditSeq;
    api.send({ cmd: "saveProviders", providers: next });
  };

  for (const [name, provider] of Object.entries(config)) addCard(entryFrom(name, provider));

  // First run: the page was opened to fill the endpoint in, and `openSetup`
  // focuses `#setting-base-url` on the first card. A collapsed card would make
  // that focus land on a hidden input, so the first card starts open.
  if (connectionSetupHint && cards.length > 0) cards[0].expand();

  const foot = el("div", "settings-form-actions");
  foot.append(
    savedNote,
    unsavedNote,
    sButton(
      s.connAddProvider,
      () => {
        const card = addCard(newEntry());
        // A new card has nothing to read in a header — no endpoint, no models —
        // so it opens, ready to be filled in.
        card.expand();
        markDirty();
        // Bring it into view before focusing. The list grows downward and the
        // button sits below it, so with two or three services the new card can
        // land entirely off-screen: focus had already moved there, and a
        // focused-but-invisible field is a click that looks like it did
        // nothing. `block: "nearest"` scrolls only when it has to.
        card.node.scrollIntoView({ block: "nearest", inline: "nearest" });
        card.nameInput.focus({ preventScroll: true });
      },
      { quiet: true },
    ),
    sButton(s.save, save, { primary: true }),
  );

  pane.append(emptyCard, list, foot);

  const file = state.configPaths?.providers;
  if (file) pane.appendChild(el("p", "setting-note", s.connConfigPath.replace("{path}", file)));

  // Typing or stepping any control makes the draft the truth on screen.
  pane.addEventListener("input", markDirty);
  pane.addEventListener("change", markDirty);

  drawStatus();
  syncEmpty();
  return pane;
}

/**
 * Behaviour: the two files the kernel reads before a turn — `permissions.json`
 * and `run.json` — plus the approval rules inside the first.
 *
 * Every control applies immediately; there is no Save step, which is why the
 * value checks below refuse a bad number instead of writing it. A refusal is
 * shown next to the field that produced it: dropping the edit silently would
 * leave the control displaying a value the kernel never received (R3).
 */
function buildBehaviorPage() {
  const s = S();
  const pane = sPage(s.pageBehavior, s.pageBehaviorDesc);
  const permissions = {
    ...DEFAULT_PERMISSIONS,
    ...(state.permissions ?? {}),
    rules: Array.isArray(state.permissions?.rules) ? state.permissions.rules : [],
  };
  const run = { ...DEFAULT_RUN_LIMITS, ...(state.runLimits ?? {}) };

  const configProblem = state.settingsError
    ? el("p", "setting-note pack-problem", s.behaviorConfigError.replace("{error}", state.settingsError))
    : null;
  if (configProblem) pane.appendChild(configProblem);

  /**
   * Write the permissions file back whole.
   *
   * The host replaces the file rather than patching it, so every save has to
   * carry all three fields; sending only what changed would reset the others
   * to the kernel defaults. The local copy is updated in the same breath as
   * the send, because the next save composes from it: two rule edits inside
   * one round-trip would otherwise both send the pre-edit list and the second
   * would undo the first.
   */
  const savePermissions = (patch) => {
    const next = {
      preset: patch.preset ?? permissions.preset,
      approvalTimeoutMs: patch.approvalTimeoutMs ?? permissions.approvalTimeoutMs,
      rules: patch.rules ?? permissions.rules,
    };
    Object.assign(permissions, next);
    api.send({ cmd: "savePermissions", permissions: next });
  };

  /** Same whole-object (and same optimistic local copy) rule for `run.json`. */
  const saveRun = (patch) => {
    Object.assign(run, patch);
    api.send({ cmd: "saveRunLimits", run: { ...run } });
  };

  /**
   * One refusal line per group, so a rejected value has somewhere to speak.
   *
   * A refusal also puts the field back to the value that is actually saved.
   * Leaving the rejected text in the box would show a number the kernel never
   * received, which is the same lie as saving it silently.
   */
  const refusals = [];
  const refusal = () => {
    const line = el("p", "setting-note pack-problem", "");
    line.hidden = true;
    refusals.push(line);
    return {
      node: line,
      show(message, field, restoreTo) {
        for (const other of refusals) other.hidden = true;
        line.textContent = message;
        line.hidden = false;
        if (field && restoreTo !== undefined) field.value = String(restoreTo);
        field?.focus();
      },
    };
  };

  /* ---------- permissions ---------- */

  const presetRefusal = refusal();
  const timeoutInput = sText({
    id: "setting-approval-timeout",
    type: "number",
    min: 1,
    max: Math.floor(MAX_APPROVAL_TIMEOUT_MS / 1000),
    step: 1,
    // Seconds on screen, milliseconds on the wire: 120000 ms is the kernel's
    // default and reads as "120" to anyone thinking about a prompt.
    value: Math.round(permissions.approvalTimeoutMs / 1000),
    onChange: (value) => {
      const seconds = Number(String(value).trim());
      const ms = seconds * 1000;
      if (!Number.isInteger(seconds) || seconds <= 0 || ms > MAX_APPROVAL_TIMEOUT_MS) {
        presetRefusal.show(s.behaviorApprovalTimeoutInvalid, timeoutInput, Math.round(permissions.approvalTimeoutMs / 1000));
        return;
      }
      savePermissions({ approvalTimeoutMs: ms });
    },
  });
  pane.appendChild(
    sGroup(s.groupPermissions, [
      sRow({
        id: "setting-preset",
        label: s.behaviorPreset,
        desc: s.behaviorPresetDesc,
        control: sSelect({
          id: "setting-preset",
          value: permissions.preset,
          options: [
            { value: "read-only", label: s.presetReadOnly },
            { value: "workspace-write", label: s.presetWorkspaceWrite },
            { value: "diagnose", label: s.presetDiagnose },
            { value: "danger-full-access", label: s.presetDangerFullAccess },
          ],
          onChange: (value) => savePermissions({ preset: value }),
        }),
      }),
      // The file is what a *new* run loads; the composer's menu owns the mode
      // of the run in flight. Saying so is the difference between a setting
      // and a switch that appears to do nothing.
      sHint(s.behaviorPresetNote),
      sRow({
        id: "setting-approval-timeout",
        label: s.behaviorApprovalTimeout,
        desc: s.behaviorApprovalTimeoutDesc,
        control: timeoutInput,
      }),
      presetRefusal.node,
    ]),
  );

  /* ---------- approval rules ---------- */

  const rulesGroup = el("section", "setting-group");
  rulesGroup.appendChild(el("h3", "setting-group-title", s.groupRules));
  rulesGroup.appendChild(el("p", "setting-note", s.rulesDesc));
  const rulesList = el("div", "rules-list");
  rulesList.id = "setting-rules";
  rulesGroup.appendChild(rulesList);

  const drawRules = () => {
    rulesList.innerHTML = "";
    if (permissions.rules.length === 0) {
      rulesList.appendChild(el("span", "rules-empty", s.rulesEmpty));
      return;
    }
    permissions.rules.forEach((rule, index) => {
      const row = el("div", "rules-row");
      row.appendChild(el("span", "rules-label", `${s.ruleActions[rule.action] ?? rule.action} · ${rule.tool}`));
      if (rule.reason) row.appendChild(el("span", "setting-desc", rule.reason));
      const remove = el("button", "link-button", s.remove);
      remove.type = "button";
      // The whole list goes back: the file has no ids, so an index is the only
      // identity a rule has here. The row disappears at once rather than
      // waiting for the host's reply — the removal is in the payload that was
      // just sent, and `fillSettings` redraws from the file when it lands.
      remove.addEventListener("click", () => {
        // 写盘且不可逆，与其他删除共用 confirmAction；确认后行即刻消失，
        // `fillSettings` 在宿主回包时按文件重画。
        void confirmAction(s.removeRuleConfirm, { danger: true }).then((yes) => {
          if (!yes) return;
          savePermissions({ rules: permissions.rules.filter((_, position) => position !== index) });
          drawRules();
        });
      });
      row.appendChild(remove);
      rulesList.appendChild(row);
    });
  };
  drawRules();

  const ruleRefusal = refusal();
  rulesGroup.appendChild(ruleRefusal.node);

  /** One form at a time; the button does nothing while it is already open. */
  let ruleFormOpen = false;

  const ruleForm = () => {
    const card = el("form", "settings-form-card");
    card.appendChild(el("h3", "", s.ruleAddTitle));
    const tool = sText({ placeholder: "fs", mono: true });
    const reason = sText({ placeholder: s.ruleReasonPlaceholder });
    let action = "ask";
    card.append(
      sRow({ label: s.ruleTool, desc: s.ruleToolDesc, control: tool }),
      sRow({
        label: s.ruleAction,
        desc: s.ruleActionDesc,
        control: sSelect({
          value: action,
          options: [
            { value: "allow", label: s.ruleAllow },
            { value: "ask", label: s.ruleAsk },
            { value: "deny", label: s.ruleDeny },
          ],
          onChange: (value) => (action = value),
        }),
      }),
      sRow({ label: s.ruleReason, desc: s.ruleReasonDesc, control: reason }),
      sHint(s.ruleParamsNote),
    );
    const actions = el("div", "settings-form-actions");
    const close = () => {
      ruleFormOpen = false;
      card.remove();
    };
    actions.append(
      sButton(s.cancel, close, { quiet: true }),
      sButton(
        s.ruleAdd,
        () => {
          const pattern = tool.value.trim();
          if (pattern === "" || pattern.length > MAX_PATTERN_LENGTH) {
            ruleRefusal.show(s.ruleToolInvalid, tool);
            return;
          }
          // A whitespace-only reason is no reason at all; the schema rejects
          // the blank string, so it is omitted rather than sent to fail.
          const text = reason.value.trim();
          const rule = {
            tool: pattern,
            action,
            ...(text === "" ? {} : { reason: text }),
          };
          savePermissions({ rules: [...permissions.rules, rule] });
          drawRules();
          close();
        },
        { primary: true },
      ),
    );
    card.appendChild(actions);
    card.addEventListener("submit", (event) => event.preventDefault());
    tool.focus();
    return card;
  };

  const foot = el("div", "settings-list-foot");
  foot.appendChild(
    sButton(
      s.ruleAdd,
      () => {
        if (ruleFormOpen) return;
        ruleFormOpen = true;
        rulesGroup.insertBefore(ruleForm(), rulesList);
      },
      { primary: true },
    ),
  );
  rulesGroup.appendChild(foot);
  pane.appendChild(rulesGroup);

  /* ---------- system prompt: not editable here ----------
   *
   * Removed on the user's instruction (2026-11-05). The field wrote
   * `run.json`'s `systemPrompt`, which the kernel prepends to every turn; a
   * free-text box over it let the operator overwrite the rules the agent runs
   * under. The kernel still reads that key — a file edited by hand keeps
   * working — the renderer simply no longer offers a way to change it.
   *
   * Same honesty rule as the removed limits below: a value that is actually in
   * force is named rather than hidden, so nobody is surprised by a prompt they
   * did not know was there.
   */
  const customPrompt = typeof run.systemPrompt === "string" ? run.systemPrompt.trim() : "";
  if (customPrompt !== "" && !configProblem) {
    pane.appendChild(
      sHint(
        s.behaviorSystemPromptNote
          .replace("{path}", state.configPaths?.run ?? "run.json"),
      ),
    );
  }

  // The three limits lost their controls (2026-11-05), but a value already in
  // `run.json` keeps capping the run. Only a set limit is worth a sentence: an
  // all-null file is the default, and a permanent note about nothing would be
  // noise. Naming the values that are actually in force is the honest half of
  // "we removed the UI" (R3) — a silent cap is one the operator cannot see.
  //
  // Skipped when the files could not be read: the copy above says so, and
  // numbers taken from a mirror of a file nobody just read are not "in force".
  const setLimits = [
    ["maxTurns", run.maxTurns],
    ["maxCostUsd", run.maxCostUsd],
    ["timeoutMs", run.timeoutMs],
  ].filter(([, value]) => typeof value === "number" && Number.isFinite(value));
  if (setLimits.length > 0 && !configProblem) {
    const limitsText = setLimits.map(([name, value]) => `${name} = ${value}`).join(", ");
    // `run.json` is the name the kernel uses; a host that could not read the
    // files sends no path, and naming the file is still more useful than
    // dropping the sentence.
    pane.appendChild(
      sHint(
        s.behaviorRunLimitsNote
          .replace("{limits}", limitsText)
          .replace("{path}", state.configPaths?.run ?? "run.json"),
      ),
    );
  }

  return pane;
}

function buildSessionsPage() {
  const s = S();
  const pane = sPage(s.pageSessions, s.pageSessionsDesc);
  pane.appendChild(
    sGroup(s.groupNotifications, [
      sRow({
        label: s.notifications,
        desc: s.notificationsDesc,
        control: sToggle({ checked: state.notifications !== false, onChange: (value) => applyPref("notifications", value) }),
      }),
    ]),
  );
  pane.appendChild(
    sGroup(s.groupSessions, [
      sRow({
        label: s.archiveInactive,
        desc: s.archiveInactiveDesc,
        control: sSelect({
          value: String(state.archiveAfterDays ?? 0),
          options: [
            { value: "0", label: s.never },
            { value: "7", label: s.days(7) },
            { value: "30", label: s.days(30) },
            { value: "90", label: s.days(90) },
          ],
          onChange: (value) => applyPref("archiveAfterDays", Number(value)),
        }),
      }),
    ]),
  );
  return pane;
}

/**
 * MCP servers: the stdio commands the kernel mounts as tools.
 *
 * The kernel reads one per-computer `mcp.json` (`src/mcp/config.ts`) and starts
 * each entry over stdio. There is no project scope, no HTTP transport and no
 * preset catalogue in this kernel, so the page edits exactly that file and
 * nothing else — an entry the kernel does not read would be a control that
 * saves into a void.
 */
function buildMcpPage() {
  const s = S();
  const pane = sPage(s.pageMcp, s.pageMcpDesc);
  // A plain container, like the model-services list: the cards carry their own
  // spacing, and a flex gap on top of it would space them twice as far apart
  // as the cards on the other page.
  const list = el("div");
  pane.appendChild(list);

  /** null = adding, a name = editing that server, undefined = list only.
   *  Scoped to the build: re-entering the page starts from the list, which is
   *  the same thing a failed save already does. */
  let mcpEditing;

  /** The file every save on this page writes, or nothing when the host did not
   *  say where it lives. */
  const configPathNote = () => {
    const file = state.configPaths?.mcp;
    return file ? el("p", "setting-note", s.mcpConfigPath.replace("{path}", file)) : null;
  };

  /** The host takes `args` as one space-separated string, not an array, and a
   *  server row is replaced wholesale by name — so every save sends all of it. */
  const payloadOf = (server, disabled) => ({
    name: server.name,
    command: server.command,
    args: (server.args ?? []).join(" "),
    cwd: server.cwd ?? "",
    timeoutMs: server.timeoutMs ?? null,
    disabled,
  });

  const form = (server, refresh) => {
    const card = el("form", "settings-form-card");
    card.appendChild(el("h3", "", server ? s.mcpEditTitle(server.name) : s.mcpAddTitle));

    const nameInput = sText({
      value: server?.name ?? "",
      placeholder: "filesystem",
      mono: true,
      // The name is the key in mcp.json: a save replaces the entry with that
      // name. Renaming here would silently add a second server instead.
      disabled: Boolean(server),
    });
    const command = sText({ value: server?.command ?? "", placeholder: "npx", mono: true });
    const args = sText({
      value: (server?.args ?? []).join(" "),
      placeholder: "-y @modelcontextprotocol/server-filesystem .",
      mono: true,
    });
    const cwd = sText({ value: server?.cwd ?? "", placeholder: "/path/to/project", mono: true });
    const timeout = sText({
      value: server?.timeoutMs ?? "",
      type: "number",
      min: 1,
      step: 1,
      placeholder: "15000",
    });
    let disabled = Boolean(server?.disabled);

    // Inline, in the form: a rejected name or command has to say so where the
    // field is, not in a toast that scrolls away from the control at fault.
    const problem = el("p", "setting-note pack-problem", "");
    problem.hidden = true;
    const fail = (message, field) => {
      problem.textContent = message;
      problem.hidden = false;
      field?.focus();
    };

    card.append(
      sRow({
        label: s.name,
        desc: server ? s.mcpNameLocked : s.mcpNameDesc,
        control: nameInput,
      }),
      sRow({ label: s.command, desc: s.commandDesc, control: command }),
      sRow({ label: s.arguments, desc: s.argumentsDesc, control: args }),
      sRow({ label: s.mcpCwd, desc: s.mcpCwdDesc, control: cwd }),
      sRow({ label: s.mcpTimeout, desc: s.mcpTimeoutDesc, control: timeout }),
      sRow({
        label: s.disabled,
        desc: s.mcpDisabledDesc,
        control: sToggle({ checked: disabled, onChange: (value) => (disabled = value) }),
      }),
      problem,
    );

    const actions = el("div", "settings-form-actions");
    actions.append(
      sButton(
        s.cancel,
        () => {
          mcpEditing = undefined;
          refresh();
        },
        { quiet: true },
      ),
      sButton(
        s.save,
        () => {
          const name = nameInput.value.trim();
          if (!MCP_NAME_PATTERN.test(name)) {
            fail(s.mcpNameInvalid, nameInput);
            return;
          }
          const commandText = command.value.trim();
          if (commandText === "") {
            fail(s.mcpCommandInvalid, command);
            return;
          }
          const timeoutText = String(timeout.value).trim();
          let timeoutMs = null;
          if (timeoutText !== "") {
            const parsed = Number(timeoutText);
            if (!Number.isInteger(parsed) || parsed <= 0) {
              fail(s.mcpTimeoutInvalid, timeout);
              return;
            }
            timeoutMs = parsed;
          }
          api.send({
            cmd: "saveMcpServer",
            server: {
              name,
              command: commandText,
              args: args.value.trim(),
              cwd: cwd.value.trim(),
              timeoutMs,
              disabled,
            },
          });
          mcpEditing = undefined;
          refresh();
        },
        { primary: true },
      ),
    );
    card.appendChild(actions);
    // A form element submits on Enter; without this the page would navigate
    // and the renderer would reload instead of saving.
    card.addEventListener("submit", (event) => event.preventDefault());
    nameInput.focus();
    return card;
  };

  /**
   * The one line a collapsed server card shows.
   *
   * The executable's basename says what kind of server this is (`npx`, `node`,
   * `python`), and the count says how much configuration is under it. The
   * arguments themselves stay in the body: that is what opening the card is
   * for. A command with no arguments prints as itself — `node · 0 args` would
   * be a count of nothing.
   */
  const summaryOf = (server) => {
    const command = String(server.command ?? "").trim();
    const name = basename(command) || command;
    const count = (server.args ?? []).length;
    if (count === 0) return name;
    // `mcpArgsCountOne` is optional: a locale without a plural form (zh) omits
    // it, and the fallback must be the plural key rather than `undefined`.
    const template = count === 1 && s.mcpArgsCountOne !== undefined ? s.mcpArgsCountOne : s.mcpArgsCount;
    return `${name} · ${template.replace("{n}", String(count))}`;
  };

  /**
   * One saved server as a collapsible card.
   *
   * The header is what a closed list shows, so it has to say which server this
   * is without opening it. The line is the command's basename plus its argument
   * count (`kb · 2 args`), not the command line: the words a stdio server is
   * launched with are long, mostly paths, and identical across `npx` servers —
   * printing them would fill the header with the one thing the expanded body is
   * there to show, and still not tell two servers apart. A bare command (no
   * args) is stated as itself, so a `node server.js` entry does not read as
   * "node · 0 args".
   */
  const serverCard = (server) => {
    const card = el("section", "settings-form-card");
    let expanded = mcpExpanded.has(server.name);

    const head = el("div", "settings-card-head");
    const toggle = el("button", "settings-card-toggle");
    toggle.type = "button";
    const chevron = iconEl("chevron-right", "settings-card-chevron");
    const title = el("span", "settings-card-name", server.name);
    toggle.append(chevron, title);
    // A disabled server stays in the list, so the fact has to survive the
    // collapse: the switch that would say it is in the body.
    if (server.disabled) toggle.appendChild(el("span", "mcp-scope disabled", s.disabled));
    toggle.appendChild(el("span", "settings-card-summary", summaryOf(server)));

    const body = el("div", "settings-form-card-body");
    body.id = `mcp-card-body-${mcpCardSeq++}`;
    toggle.setAttribute("aria-controls", body.id);

    // Outside the toggle: the switch and the two buttons all take a click, and
    // a click on them must not also be a click on the header (which would fold
    // the card the user is about to edit).
    const headActions = el("div", "mcp-actions");
    headActions.append(
      sToggle({
        checked: !server.disabled,
        onChange: (value) => {
          api.send({ cmd: "saveMcpServer", server: payloadOf(server, !value) });
        },
      }),
      sButton(
        s.edit,
        () => {
          mcpEditing = server.name;
          render();
        },
        { quiet: true },
      ),
      sButton(
        s.remove,
        () => {
          void confirmAction(s.removeMcpConfirm.replace("{name}", server.name), { danger: true }).then((yes) => {
            if (yes) api.send({ cmd: "removeMcpServer", name: server.name });
          });
        },
        { quiet: true, danger: true },
      ),
    );
    head.append(toggle, headActions);

    // The full command line lives here, and only here: `code` keeps the
    // arguments legible as separate words rather than re-joined prose.
    const commandLine = el("code", "setting-code mcp-card-command", [server.command, ...(server.args ?? [])].filter(Boolean).join(" "));
    /** An unset optional field says so instead of disappearing: a missing row
     *  would leave the user unsure whether the value is empty or the page just
     *  does not show it. */
    const optional = (value) =>
      value ? el("code", "setting-code", value) : el("span", "setting-desc", s.mcpNotSet);
    body.append(
      sRow({ label: s.command, desc: s.argumentsDesc, control: commandLine, wide: true }),
      sRow({ label: s.mcpCwd, control: optional(server.cwd) }),
      sRow({
        label: s.mcpTimeout,
        control: optional(server.timeoutMs ? `${server.timeoutMs} ms` : ""),
      }),
    );
    card.append(head, body);

    const setExpanded = (open) => {
      expanded = open;
      body.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute(
        "aria-label",
        (open ? s.mcpCollapseNamed : s.mcpExpandNamed).replace("{name}", server.name),
      );
      setIcon(chevron, open ? "chevron-down" : "chevron-right");
      // The set is the only copy that survives a rebuild, so it is written on
      // every change — there is no draft here to protect, and an unopened card
      // is simply absent.
      if (open) mcpExpanded.add(server.name);
      else mcpExpanded.delete(server.name);
    };
    toggle.addEventListener("click", () => setExpanded(!expanded));
    setExpanded(expanded);
    return card;
  };

  const render = () => {
    list.innerHTML = "";
    // A refresh can drop the server being edited (removed in an editor, or
    // renamed elsewhere). Falling back to the add form would quietly invite a
    // new server, so the form closes and the list speaks for itself.
    if (mcpEditing !== undefined) {
      const editing = state.mcpServers.find((entry) => entry.name === mcpEditing) ?? null;
      if (editing !== null || mcpEditing === null) list.appendChild(form(editing, render));
      else mcpEditing = undefined;
    }

    if (state.mcpServers.length === 0) {
      if (mcpEditing === undefined) {
        const empty = el("div", "settings-empty-card");
        empty.appendChild(el("h3", "", s.mcpEmptyTitle));
        empty.appendChild(el("p", "", s.mcpEmptyBody));
        const actions = el("div", "settings-empty-actions");
        actions.appendChild(
          sButton(
            s.mcpAdd,
            () => {
              mcpEditing = null;
              render();
            },
            { primary: true },
          ),
        );
        empty.appendChild(actions);
        const path = configPathNote();
        if (path) empty.appendChild(path);
        list.appendChild(empty);
      }
      list.appendChild(el("p", "setting-note", s.mcpTransportNote));
      return;
    }

    for (const server of state.mcpServers) {
      list.appendChild(serverCard(server));
    }

    if (mcpEditing === undefined) {
      const foot = el("div", "settings-list-foot");
      foot.appendChild(
        sButton(
          s.mcpAdd,
          () => {
            mcpEditing = null;
            render();
          },
          { primary: true },
        ),
      );
      list.appendChild(foot);
    }
    const path = configPathNote();
    if (path) list.appendChild(path);
    list.appendChild(el("p", "setting-note", s.mcpTransportNote));
  };

  state.renderMcpPage = render;
  render();
  return pane;
}

/**
 * The knowledge base: the local corpus the `kb` MCP server serves its tools
 * from.
 *
 * The corpus is not in the version library (see `mcp-servers/kb/README.md`),
 * so this page can only report what the host found on *this* computer. Every
 * state it can be in has to look different: still reading, no root at all, a
 * root that holds no files, and a tree. Drawing two of those the same would be
 * the page telling the user their corpus is empty when it is really missing
 * (R3) — and "empty" is the one answer that would make them stop looking.
 */
/**
 * The corpus root, rendered so a long absolute path loses its head rather
 * than its tail.
 *
 * Two elements are needed, and the split is not cosmetic: `direction: rtl` on
 * the outer box is what puts `text-overflow`'s ellipsis at the *start*, while
 * the inner `direction: ltr` span keeps the segments in readable order. One
 * element cannot do both — its own `direction` decides truncation, and a
 * bidi override on the same box either reverses the text or is ignored.
 *
 * The full path is the `title`, so truncation never hides it for good.
 */
function kbRootPath(root) {
  const code = el("code", "setting-code kb-root-path");
  code.title = root;
  code.appendChild(el("span", "", root));
  return code;
}

function buildKbPage() {
  const s = S();
  const pane = sPage(s.pageKb, s.pageKbDesc);
  const body = el("div", "kb-body");
  pane.appendChild(body);

  const refresh = () => {
    // Reading is a request, not a state to cache: until the answer lands the
    // page shows its "reading" line again, because the previous tree describes
    // a moment the user has just asked it to re-check.
    state.kb = null;
    api.send({ cmd: "getKb" });
    render();
  };

  /** The root's provenance, in words: a path with no explanation is a fact the
   *  user cannot check or change. Each `source` value gets its own sentence —
   *  a fall-through would make an unknown source read as the repository
   *  default, which is a claim this page is in no position to make. */
  const sourceNote = (kb) => {
    const name =
      kb.source === "mcp.json"
        ? s.kbSourceMcp
        : kb.source === "env"
          ? s.kbSourceEnv
          : kb.source === "default"
            ? s.kbSourceDefault
            : s.kbSourceUnknown;
    return s.kbSourceNote.replace("{source}", name);
  };

  /**
   * One folder of the tree.
   *
   * Folders open on click and files do not: there is no preview endpoint, and a
   * row that looks clickable but does nothing is a lie about what the app can
   * do. A file is a name, in a folder the user chose to open.
   */
  const treeNode = (node, depth, truncated) => {
    const wrap = el("div", "kb-node");
    const isDir = node.kind === "dir";
    const children = Array.isArray(node.children) ? node.children : [];
    if (!isDir) {
      const row = el("div", "kb-row");
      row.style.paddingLeft = `${depth * 16}px`;
      row.append(
        el("span", "kb-chevron-slot"),
        iconEl("file"),
        el("span", "kb-file", node.name),
      );
      wrap.appendChild(row);
      return wrap;
    }

    const open = kbExpanded.has(node.path);
    const row = el("div", "kb-row");
    row.style.paddingLeft = `${depth * 16}px`;
    const toggle = el("button", "kb-toggle");
    toggle.type = "button";
    const chevron = iconEl(open ? "chevron-down" : "chevron-right", "kb-chevron");
    toggle.append(chevron, iconEl("folder"), el("span", "kb-dir", node.name));
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute(
      "aria-label",
      (open ? s.kbCollapseNamed : s.kbExpandNamed).replace("{name}", node.name),
    );
    const kids = el("div", "kb-children");
    kids.id = `kb-node-${kbNodeSeq++}`;
    kids.hidden = !open;
    toggle.setAttribute("aria-controls", kids.id);
    for (const child of children) kids.appendChild(treeNode(child, depth + 1, truncated));
    // An empty folder still says so when opened: a toggle that reveals nothing
    // is indistinguishable from one that is broken. Under truncation it must
    // not claim to be empty — the scan stopped, so "no children" may just mean
    // "not reached".
    if (children.length === 0) {
      kids.appendChild(
        el("p", "setting-note kb-note", truncated ? s.kbFolderNotListed : s.kbFolderEmpty),
      );
    }
    toggle.addEventListener("click", () => {
      const next = !kbExpanded.has(node.path);
      if (next) kbExpanded.add(node.path);
      else kbExpanded.delete(node.path);
      kids.hidden = !next;
      toggle.setAttribute("aria-expanded", next ? "true" : "false");
      toggle.setAttribute("aria-label", (next ? s.kbCollapseNamed : s.kbExpandNamed).replace("{name}", node.name));
      setIcon(chevron, next ? "chevron-down" : "chevron-right");
    });
    row.appendChild(toggle);
    wrap.append(row, kids);
    return wrap;
  };

  /**
   * A timestamp from the host, in the reader's own time zone.
   *
   * The kernel stores ISO-8601 UTC (`checkedAt`), which is the right thing to
   * persist and the wrong thing to read. Anything unparseable comes back as the
   * raw string: inventing "just now" for a value the host could not have meant
   * would put a time on the page that nobody measured.
   */
  const checkedAtText = (iso) => {
    const text = typeof iso === "string" ? iso : "";
    if (text === "") return "";
    const at = new Date(text);
    if (Number.isNaN(at.getTime())) return text;
    return at.toLocaleString(state.locale === "zh" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  /**
   * The corpus update group.
   *
   * Contract §7 lists seven states and this draws all seven, each with its own
   * words. Two rules shape the layout:
   *
   * - The reason a state carries is shown **verbatim**, never as "failed".
   *   "403 from the update source, possibly not published or the bucket policy
   *   has not granted GetObject" tells the operator what to do; "check failed"
   *   tells them to try again, which will fail again.
   * - "Update now" exists only in `update_available`. A button whose only
   *   possible outcome is a refusal is the fake control R3 forbids, and the
   *   other six states have nothing to install.
   *
   * "Check for updates" is the exception: it is offered in every state,
   * `unavailable` included, because "is the update source even reachable from
   * this machine" is a question the operator may need answered before anything
   * else is fixed.
   */
  const updateGroup = () => {
    const group = el("section", "setting-group kb-update");
    group.appendChild(el("h3", "setting-group-title", s.kbGroupUpdate));

    const status = state.corpusStatus;
    const busy = state.corpusBusy;
    /** A plain label/value row: the state's name on the left, its facts on the
     *  right. No badge here — the badge is the state itself, drawn once below. */
    const row = (label, value) =>
      sRow({ label, control: el("span", "", value) });

    if (state.corpusError !== "") {
      // The host could not read the state at all — a different fact from any
      // of the seven, and the one that must not be dressed up as one of them.
      group.appendChild(
        el("p", "setting-note pack-problem kb-update-error", s.kbUpdateError.replace("{error}", state.corpusError)),
      );
    } else if (status === null) {
      // `kbLoading` is the file tree's line; reusing it here claimed the wrong
      // thing was loading and gave no hint that the update state was the
      // missing half. The distinction between "not asked yet" and "asked, no
      // answer yet" is not tracked, so this line covers both and says only what
      // is true of both: the page has no update state to show.
      group.appendChild(el("p", "setting-note", s.kbUpdateLoading));
    } else {
      /**
       * One descriptor per state: the badge variant, the badge text, the
       * sentence under it, and whichever facts that state actually has.
       *
       * A table rather than a switch with a `appendChild` in every branch: the
       * seven states differ only in what they say, and writing the layout once
       * is what keeps them from drifting into seven slightly different rows.
       * `undefined` for a field means the state does not carry it — which is
       * not the same as carrying zero, so nothing is filled in.
       */
      const view = (() => {
        switch (status.kind) {
          case "bundled":
            return {
              badge: "muted",
              title: s.kbStateBundled,
              desc: s.kbStateBundledDesc,
              facts: [],
            };
          case "up_to_date":
            return {
              badge: "ok",
              title: s.kbStateUpToDate,
              desc: s.kbStateUpToDateDesc,
              facts: [
                [s.kbUpdateVersion, s.kbUpdateVersionValue.replace("{n}", String(status.corpusVersion))],
                [s.kbUpdateCheckedAt, checkedAtText(status.checkedAt) || s.kbUpdateCheckedUnknown],
              ],
            };
          case "update_available":
            return {
              badge: "",
              title: s.kbStateUpdateAvailable,
              desc: s.kbStateUpdateAvailableDesc,
              facts: [
                [s.kbUpdateVersion, s.kbUpdateVersionValue.replace("{n}", String(status.corpusVersion))],
                [s.kbUpdateFiles, s.kbUpdateFilesValue.replace("{n}", String(status.fileCount))],
                [s.kbUpdateCheckedAt, checkedAtText(status.checkedAt) || s.kbUpdateCheckedUnknown],
              ],
            };
          case "check_failed":
            return {
              badge: "warn",
              title: s.kbStateCheckFailed,
              desc: "",
              // The reason, as the update client wrote it: it names the status
              // code and the URL, which is what makes it actionable.
              reason: status.reason,
              facts: typeof status.checkedAt === "string" && status.checkedAt !== ""
                ? [[s.kbUpdateCheckedAt, checkedAtText(status.checkedAt)]]
                : [],
            };
          case "verify_failed":
            return {
              badge: "warn",
              title: s.kbStateVerifyFailed,
              desc: s.kbStateVerifyFailedDesc,
              reason: status.reason,
              facts: [],
            };
          case "config_invalid":
            return {
              badge: "warn",
              title: s.kbStateConfigInvalid,
              desc: s.kbStateConfigInvalidDesc,
              reason: status.reason,
              // The file to edit, when the host named one. A "not configured"
              // with no location is a dead end.
              path: state.corpusConfigPath,
              facts: [],
            };
          case "unavailable":
            return {
              badge: "muted",
              title: s.kbStateUnavailable,
              desc: s.kbStateUnavailableDesc,
              facts: [],
            };
          default:
            // A state this build does not know. Saying "check failed" and
            // quoting the discriminant is honest; guessing which of the seven
            // it was would put a sentence on the page nobody authored.
            return {
              badge: "warn",
              title: s.kbStateCheckFailed,
              desc: "",
              reason: `无法识别的更新状态：${String(status.kind)}`,
              facts: [],
            };
        }
      })();

      // The badge carries the state; the label above it does not repeat the same
      // sentence. `kbUpdateState` is the neutral "Update status" heading the
      // badge answers.
      //
      // Deliberately **not** `wide`. A wide row gives `.setting-control`
      // `flex: 1`, so it splits the row with the copy column and the badge
      // lands mid-row; every other row on this page (version, index, the facts
      // below) keeps the control at its natural width and therefore at the same
      // right edge. A badge is a few characters — it needs no room of its own,
      // and matching the edge is what makes the column readable. The reason
      // text, which *does* need the full width, is drawn as its own paragraph
      // below rather than inside this control.
      group.appendChild(
        sRow({
          label: s.kbUpdateState,
          desc: view.desc === "" ? undefined : view.desc,
          control: el(
            "span",
            view.badge === "" ? "setting-badge" : `setting-badge ${view.badge}`,
            view.title,
          ),
        }),
      );
      for (const [label, value] of view.facts) group.appendChild(row(label, value));
      if (view.reason !== undefined) {
        group.appendChild(el("p", "setting-note pack-problem kb-update-reason", view.reason));
      }
      if (view.path !== undefined && view.path !== "") {
        group.appendChild(el("code", "setting-code kb-update-path", view.path));
      }
    }

    // Progress, from the kernel's own counts. Only while an apply is running:
    // a line left behind after the run would describe work that has stopped.
    if (busy && state.corpusProgress !== null) {
      const progress = state.corpusProgress;
      const text =
        progress.action === "reused"
          ? s.kbUpdateProgressReused
              .replace("{done}", String(progress.completed))
              .replace("{total}", String(progress.total))
          : s.kbUpdateProgress
              .replace("{done}", String(progress.completed))
              .replace("{total}", String(progress.total))
              .replace("{path}", String(progress.path));
      group.appendChild(el("p", "setting-note kb-update-progress", text));
    }

    // The last apply's outcome. Both halves are sentences the user acts on, and
    // both stay until the next click: a success that vanished is indistinguishable
    // from a click that did nothing, and a failure is exactly what they need to
    // read twice.
    if (state.corpusResult !== null) {
      const result = state.corpusResult;
      if (result.ok === true) {
        group.appendChild(
          el(
            "p",
            "setting-note kb-update-done",
            s.kbUpdateDone.replace("{n}", String(result.corpusVersion ?? "")),
          ),
        );
      } else {
        // Two lines, not one: the reason is the kernel's own sentence (or the
        // host's), and gluing a translated label onto it would need a
        // punctuation mark that is wrong in one of the two languages.
        group.appendChild(el("p", "setting-note pack-problem kb-update-failed", s.kbUpdateFailed));
        group.appendChild(el("p", "setting-note pack-problem kb-update-reason", result.reason));
        if (typeof result.corpusVersionUnchanged === "number") {
          group.appendChild(
            el(
              "p",
              "setting-note kb-update-unchanged",
              s.kbUpdateFailedUnchanged.replace("{n}", String(result.corpusVersionUnchanged)),
            ),
          );
        }
      }
    }

    // The buttons. Both are disabled while either runs: the host queues corpus
    // commands, so a second click would answer a second time for one visible
    // action. Each label describes its own command, never the other's.
    const actions = el("div", "kb-update-actions");
    const checkLabel = busy === "check" ? s.kbUpdateChecking : s.kbUpdateCheck;
    const checkButton = sButton(checkLabel, () => {
      state.corpusBusy = "check";
      state.corpusProgress = null;
      state.corpusResult = null;
      render();
      api.send({ cmd: "checkCorpusUpdate" });
    });
    checkButton.disabled = busy !== "";
    actions.appendChild(checkButton);

    // Only `update_available` has something to install. A button in any other
    // state could only be refused, and a control that can only be refused must
    // not look pressable (R3).
    if (status !== null && status.kind === "update_available") {
      const applyLabel = busy === "apply" ? s.kbUpdateApplying : s.kbUpdateApply;
      const applyButton = sButton(
        applyLabel,
        () => {
          state.corpusBusy = "apply";
          state.corpusProgress = null;
          state.corpusResult = null;
          render();
          api.send({ cmd: "applyCorpusUpdate" });
        },
        { primary: true },
      );
      applyButton.disabled = busy !== "";
      actions.appendChild(applyButton);
    }
    group.appendChild(actions);

    return group;
  };

  const render = () => {
    body.innerHTML = "";
    const kb = state.kb;

    const head = el("div", "kb-head");
    const refreshButton = sButton(s.kbRefresh, refresh, { quiet: true });
    head.append(el("p", "setting-note kb-head-note", s.kbLocalNote), refreshButton);
    body.appendChild(head);

    if (kb === null) {
      // Not an empty corpus: the host has not answered yet. The update group
      // is drawn anyway — it reads a different location (`$HARNESS_HOME/kb`)
      // through a different command, and its own "still reading" line is the
      // honest thing to show while the tree has not arrived.
      body.appendChild(el("p", "setting-note kb-loading", s.kbLoading));
      body.appendChild(updateGroup());
      return;
    }

    // A read failure is stated as itself, before anything the page might
    // otherwise imply about the corpus, and it changes what the rest may say:
    // an answer that failed halfway is not evidence that a folder is empty or
    // that a root has nothing in it.
    const failed = typeof kb.error === "string" && kb.error !== "";
    if (failed) {
      const problem = el("p", "setting-note pack-problem kb-error", `${s.kbError} ${kb.error}`);
      body.appendChild(problem);
    }

    const root = typeof kb.root === "string" ? kb.root : "";
    const tree = Array.isArray(kb.tree) ? kb.tree : [];
    const truncated = kb.truncated === true;
    const missing = root === "";

    if (missing) {
      // `root` is only empty when the backend could not even name a candidate.
      // That is the hard "no corpus here" state, and it must not be drawn as an
      // empty knowledge base: the user would read it as "the corpus loaded and
      // has nothing in it" and stop looking. The note says where it looked,
      // which is what makes the state actionable.
      const empty = el("div", "settings-empty-card");
      empty.appendChild(el("h3", "", s.kbMissingTitle));
      empty.appendChild(el("p", "", s.kbMissingBody));
      if (typeof kb.note === "string" && kb.note !== "") {
        empty.appendChild(el("p", "kb-note", kb.note));
      }
      empty.appendChild(el("p", "kb-note", s.kbHowToGet));
      body.appendChild(empty);
      // The update group is drawn here too, and for the same reason it is drawn
      // at all: the corpus updater's seven states are about `$HARNESS_HOME/kb`,
      // which is a different location from the folder the tools read. "No
      // folder here" does not answer "can this machine reach the update
      // source", and the check button is the only way to ask that.
      body.appendChild(updateGroup());
      return;
    }

    body.appendChild(
      sGroup(s.kbGroupStatus, [
        // Not `wide`: a wide row hands the control the whole line, which left
        // the path starting at the label and running across the row. The path
        // is a value belonging to the label, so it sits in the right-hand
        // column like every other value on this page — right-aligned against
        // the same edge as the counts and badges below it.
        sRow({
          label: s.kbRoot,
          desc: sourceNote(kb),
          // The path is the value, so it sits in the right-hand column — but
          // a path does not wrap, so it truncates from the left and keeps the
          // tail, which is the part that tells two corpus folders apart.
          // The inner span carries the left-to-right order while the box
          // around it carries the right-to-left truncation edge.
          control: kbRootPath(root),
        }),
        sRow({
          label: s.kbFileCount,
          control: el("span", "", s.kbFileCountValue.replace("{n}", String(kb.fileCount ?? 0))),
        }),
        sRow({
          label: s.kbIndex,
          control: kb.indexPresent
            ? el("span", "setting-badge ok", s.kbIndexPresent)
            : el("span", "setting-badge warn", s.kbIndexAbsent),
        }),
      ]),
    );

    body.appendChild(updateGroup());

    if (truncated) {
      // The count and the tree are both partial. Saying "108 files" beside a
      // tree that stops early would read as a complete listing.
      body.appendChild(el("p", "setting-note kb-truncated", s.kbTruncated));
    }

    const treeGroup = el("section", "setting-group");
    treeGroup.appendChild(el("h3", "setting-group-title", s.kbGroupTree));
    if (tree.length === 0) {
      const empty = el("div", "settings-empty-card");
      if (failed || truncated) {
        // "No files" would be a claim the read cannot back up.
        empty.appendChild(el("p", "", s.kbTreeUnknown));
      } else {
        // `root` is non-empty here, but that does not mean the folder exists:
        // the backend keeps the candidate path when the directory is missing,
        // so it can tell the user where to put the corpus. The page cannot stat
        // anything itself, so it states only what it knows — nothing was listed
        // — and quotes the backend's own note, which is what says which of the
        // two it is. Claiming "the folder exists but is empty" would be the one
        // sentence this page must never get wrong (R3).
        empty.appendChild(el("h3", "", s.kbNoFilesTitle));
        empty.appendChild(el("p", "", s.kbNoFilesBody));
        if (typeof kb.note === "string" && kb.note !== "") {
          empty.appendChild(el("p", "kb-note", kb.note));
        }
        empty.appendChild(el("p", "kb-note", s.kbHowToGet));
      }
      treeGroup.appendChild(empty);
    } else {
      const treeBox = el("div", "kb-tree");
      for (const node of tree) treeBox.appendChild(treeNode(node, 0, truncated));
      treeGroup.appendChild(treeBox);
    }
    body.appendChild(treeGroup);
  };

  state.renderKbPage = render;
  // The page asks on open: the answer is per computer and per file on disk, so
  // a cached tree from the last visit would be a claim about a corpus nobody
  // re-read.
  api.send({ cmd: "getKb" });
  // The update state is asked for too, but this is **not** a check: the command
  // reads `state.json` and never opens a connection. The startup check has
  // already decided what that file says (contract §6), and re-checking here
  // would turn "open Settings" into a network request the user did not make.
  // Asked once per visit, like the tree above: the stored state can have moved
  // since the last time this page was on screen (a startup check may have run
  // in between), and a figure nobody re-read would be a claim about a version
  // that may no longer be installed.
  api.send({ cmd: "getCorpusStatus" });
  render();
  return pane;
}

function buildSkillsPage() {
  const s = S();
  const pane = sPage(s.pageSkills, s.pageSkillsDesc);
  const body = el("div", "skills-body");
  pane.appendChild(body);

  /**
   * The refusal line, in place, without rebuilding the pane.
   *
   * A full re-render would clear `body` and take the open form with it — the
   * draft is exactly what the user needs after a rejected save. The line is
   * created once and updated afterwards, so showing a second error replaces
   * the first instead of stacking.
   */
  const showError = (text) => {
    let line = body.querySelector(".skill-error");
    if (text === "") {
      line?.remove();
      return;
    }
    if (line === null) {
      line = el("p", "setting-note pack-problem skill-error");
      line.setAttribute("role", "alert");
      body.prepend(line);
    }
    line.textContent = text;
  };

  const render = () => {
    body.innerHTML = "";
    // Unreadable skill files first: a file that failed to parse is absent from
    // the list below, and a page that only showed the survivors would read as
    // "these are all your skills" when it is not (R3).
    const problems = state.skillProblems.filter(
      (problem) => problem.file !== "" || problem.message !== "",
    );
    if (problems.length > 0) {
      const block = el("section", "setting-group");
      block.appendChild(el("h3", "setting-group-title", s.problemsTitle));
      for (const problem of problems) {
        block.appendChild(
          el("p", "setting-note pack-problem", s.skillProblemLine(problem.file, problem.message)),
        );
      }
      body.appendChild(block);
    }
    // The last refused save or delete, at the top: the host answers a failure
    // with a `notice{domain:"skills"}`, and the settings dialog covers the
    // transcript that used to receive it. Without this line a rejected name
    // looked exactly like a save that worked and drew nothing (R3).
    //
    // Above the problems block, not below it: those describe files already on
    // disk, while this describes the click the user just made. The newest fact
    // goes where the eye lands first.
    if (state.skillError !== "") {
      const failed = el("p", "setting-note pack-problem skill-error", state.skillError);
      failed.setAttribute("role", "alert");
      body.prepend(failed);
    }
    const search = el("input", "setting-input skill-search");
    search.type = "search";
    search.placeholder = s.searchSkills;
    const list = el("div", "skills-list");
    const draw = () => {
      const query = search.value.trim().toLowerCase();
      list.innerHTML = "";
      // Rows are the host's `skillRow` shape; optional chaining keeps one
      // malformed entry from taking the whole page down while the search box
      // is being typed in.
      const matches = state.skills.filter(
        (skill) => !query || `${skill?.name ?? ""} ${skill?.description ?? ""}`.toLowerCase().includes(query),
      );
      if (matches.length === 0) {
        const empty = el("div", "settings-empty-card");
        empty.appendChild(el("h3", "", query ? s.skillsNoMatch : s.skillsEmptyTitle));
        if (!query) {
          empty.appendChild(el("p", "", s.skillsEmptyBody));
          empty.appendChild(sButton(s.skillNew, () => openForm(null), { primary: true }));
        }
        list.appendChild(empty);
        return;
      }
      for (const skill of matches) {
        const row = el("div", "skill-row");
        const main = el("div", "skill-main");
        const title = el("div", "skill-title");
        title.appendChild(el("code", "skill-name", `/${skill.name}`));
        title.appendChild(el("span", `mcp-scope scope-${skill.scope}`, skill.scope === "project" ? s.scopeProject : s.scopeUser));
        main.appendChild(title);
        main.appendChild(el("p", "skill-desc", skill.description || s.skillNoDescription));
        // The hint is what the composer shows after `/name`, so the row shows
        // the same text in the same treatment: an edit here and a `/name`
        // typed in the composer must be recognisably the same command. Its own
        // line rather than inline, because `skill-desc` truncates with an
        // ellipsis and would swallow the chip behind a long description.
        if (typeof skill.argumentHint === "string" && skill.argumentHint !== "") {
          const line = el("p", "skill-desc");
          const chip = el("code", "setting-code", skill.argumentHint);
          chip.title = s.argumentHintShown(skill.argumentHint);
          line.appendChild(chip);
          main.appendChild(line);
        }
        const actions = el("div", "mcp-actions");
        actions.appendChild(sButton(s.edit, () => openForm(skill), { quiet: true }));
        actions.appendChild(
          sButton(
            s.remove,
            () => {
              void confirmAction(s.removeSkillConfirm.replace("{name}", skill.name), { danger: true }).then((yes) => {
                if (yes) api.send({ cmd: "removeSkill", scope: skill.scope, name: skill.name });
              });
            },
            { quiet: true, danger: true },
          ),
        );
        row.append(main, actions);
        list.appendChild(row);
      }
      const foot = el("div", "settings-list-foot");
      foot.appendChild(sButton(s.skillNew, () => openForm(null), { primary: true }));
      list.appendChild(foot);
    };
    search.addEventListener("input", draw);
    body.append(search, list);
    draw();
  };

  const openForm = (skill) => {
    const form = el("form", "settings-form-card");
    form.appendChild(el("h3", "", skill ? s.skillEditTitle(skill.name) : s.skillNewTitle));
    const name = sText({ value: skill?.name ?? "", placeholder: "review", mono: true });
    const description = sText({ value: skill?.description ?? "", placeholder: s.skillDescriptionPlaceholder });
    const hint = sText({ value: skill?.argumentHint ?? "", placeholder: "[path]" });
    const scope = sSelect({
      value: skill?.scope ?? "user",
      options: [
        { value: "user", label: s.scopeUser },
        { value: "project", label: s.scopeProject },
      ],
      onChange: () => {},
    });
    const bodyArea = document.createElement("textarea");
    bodyArea.className = "setting-textarea";
    bodyArea.rows = 7;
    bodyArea.spellcheck = false;
    bodyArea.placeholder = s.skillBodyPlaceholder;
    bodyArea.value = skill?.body ?? "";
    form.append(
      sRow({ label: s.name, desc: s.skillNameDesc, control: name }),
      sRow({ label: s.description, control: description }),
      sRow({ label: s.argumentHint, desc: s.argumentHintDesc, control: hint }),
      sRow({ label: s.scope, control: scope }),
      sRow({ label: s.prompt, desc: s.skillPromptDesc, control: bodyArea, wide: true }),
    );
    const actions = el("div", "settings-form-actions");
    actions.append(
      sButton(s.cancel, () => form.remove(), { quiet: true }),
      sButton(s.save, () => {
        name.value = name.value.trim();
        description.value = description.value.trim();
        hint.value = hint.value.trim();
        api.send({
          cmd: "saveSkill",
          skill: {
            name: name.value,
            description: description.value,
            argumentHint: hint.value,
            scope: scope.value,
            body: bodyArea.value,
          },
        });
        // The form stays up until the host says the save landed. It used to
        // close here, immediately — so a rejected name made the dialog
        // disappear, the list stay unchanged, and the draft be lost, which
        // from the user's seat is indistinguishable from a save that worked
        // and drew nothing (R3). `skills` (success) re-renders the page and
        // takes the form with it; a refusal leaves it where the fix is.
      }, { primary: true }),
    );
    form.appendChild(actions);
    body.prepend(form);
    name.focus();
  };

  state.renderSkillsPage = render;
  // A refusal updates one line in place instead of re-rendering: the open form
  // holds the draft the user has to fix, and `render` clears `body`. Success,
  // by contrast, goes through `renderSkillsPage` on the `skills` broadcast,
  // which rebuilds the page without the form — the edit landed, so the draft
  // has nothing left to do.
  state.showSkillsError = showError;
  // Same reason as the knowledge-base page: the files are hand-editable, so
  // the copy that arrived at boot may describe a folder nobody has re-read
  // since. Asking on open is what keeps the page from showing a deleted skill
  // or hiding a new one until the next launch.
  //
  // Deliberately *not* before `render()`: the answer only triggers a redraw
  // through `state.renderSkillsPage`, so a fresh empty library paints once and
  // then corrects itself, rather than the page waiting on a round trip to show
  // anything at all.
  render();
  api.send({ cmd: "getSkills" });
  return pane;
}

function buildMemoryPage() {
  const s = S();
  const pane = sPage(s.pageMemory, s.pageMemoryDesc);
  const body = el("div", "memory-body");
  pane.appendChild(body);

  const render = () => {
    body.innerHTML = "";
    const sections = [
      { key: "global", title: s.memoryGlobal, items: state.memory.global ?? [] },
      { key: "project", title: s.memoryProject, items: state.memory.project ?? [] },
    ];
    for (const section of sections) {
      const group = el("section", "setting-group");
      group.appendChild(el("h3", "setting-group-title", section.title));
      if (section.items.length === 0) {
        group.appendChild(el("p", "setting-note", s.memoryEmpty));
      }
      for (const entry of section.items) {
        const card = el("div", "memory-card");
        const head = el("div", "memory-head");
        head.appendChild(el("strong", "", entry.name));
        if (entry.description) head.appendChild(el("span", "memory-desc", entry.description));
        card.appendChild(head);
        card.appendChild(el("p", "memory-body-text", entry.body));
        const actions = el("div", "memory-actions");
        actions.appendChild(
          sButton(
            s.remove,
            () => {
              void confirmAction(s.removeMemoryConfirm.replace("{name}", entry.name), { danger: true }).then((yes) => {
                if (yes) api.send({ cmd: "deleteMemory", scope: section.key, name: entry.name });
              });
            },
            { quiet: true, danger: true },
          ),
        );
        card.appendChild(actions);
        group.appendChild(card);
      }
      body.appendChild(group);
    }
    body.appendChild(el("p", "setting-note", s.memoryHowTo));
  };

  state.renderMemoryPage = render;
  render();
  return pane;
}

function buildInstructionsPage() {
  const s = S();
  const pane = sPage(s.pageInstructions, s.pageInstructionsDesc);
  const wrap = sTextarea({
    id: "setting-instructions",
    value: state.instructionsText ?? "",
    placeholder: s.instructionsPlaceholder,
    rows: 14,
    saveLabel: s.save,
    onSave: (value) => api.send({ cmd: "saveInstructions", text: value }),
  });
  pane.appendChild(wrap);
  pane.appendChild(el("p", "setting-note", s.instructionsNote));
  pane.appendChild(el("p", "setting-note", s.instructionsProject));
  return pane;
}

/**
 * 工具链包。
 *
 * 这一页要回答的第一个问题不是"装了什么"，而是"磁盘被谁占了、能不能删"。
 * 所以最上面一行永远是根目录、已用、剩余 —— 用户装了几个 GB 的编译器之后
 * 第一件想确认的事就是这个。
 *
 * 进度是确定的（显示百分比和阶段），因为下载 289 MB 时一个转圈什么都说明
 * 不了；到底是在下载、校验、解压还是验证，决定了用户要不要等。
 */
/** Byte size for the toolchain page, at the module level so event handlers
 *  outside the page builder can use it too. */
function formatPackBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

function buildToolsPage() {
  const s = S();
  const pane = sPage(s.pageTools, s.pageToolsDesc);
  // 这页默认只回答"装了什么、还能装什么"：一行占用统计 + 一张统一列表。
  // 检测详情、搜索路径、清理、离线安装都是排查时才需要的东西，全部折进
  // 「高级」—— 页面上常年挂着一打按钮和几十行工具表，对只想装个编译器的
  // 人是噪音。
  const advanced = el("details", "tc-advanced");
  const advancedSummary = el("summary", "", s.tcAdvanced);
  advanced.appendChild(advancedSummary);
  const advancedBody = el("div", "tc-advanced-body");
  advanced.appendChild(advancedBody);
  const detectedBox = el("div");
  advancedBody.appendChild(detectedBox);

  const summary = el("div", "pack-summary");
  const list = el("div", "pack-list");
  pane.appendChild(list);

  const formatBytes = formatPackBytes;

  /** kind → the one-line purpose, from the host's table. */
  const infoFor = (kind) => Object.values(state.toolchainInfo ?? {}).find((entry) => entry.kind === kind) ?? { kind, label: kind, purpose: "", group: "build" };

  /** `14.2.Rel1 (Build arm-14.52)) 14.2.1 20241119` is three versions in a trench coat. */
  const shortVersion = (text) => {
    const first = String(text ?? "").split(/[\s(]/).filter(Boolean)[0] ?? "";
    return first.length > 24 ? `${first.slice(0, 24)}…` : first;
  };

  /** A catalog entry that would satisfy `kind` and is not installed yet. */
  const availableEntryFor = (kind) => {
    const installed = new Set((state.packState?.packs ?? []).map((pack) => pack.manifest.id));
    return (state.packCatalog ?? []).find(
      (entry) => entry.installable && !installed.has(entry.id) && (entry.provides ?? []).includes(kind),
    );
  };

  /**
   * 本机检测到的工具链。
   *
   * 这一段以前不存在，于是 Board 面板里能看到 pyocd、设置页里却看不到 ——
   * 用户会以为设置页只负责"下载"，而不是"告诉我手上有什么"。每一行都带
   * 一句这个工具是干什么的：`gcc-arm` 对做这个应用的人是常识，对刚装上
   * 的人是噪音。
   */
  const renderDetected = (detected) => {
    detectedBox.innerHTML = "";
    if (!detected) return;

    const found = new Map(detected.tools.map((tool) => [tool.kind, tool]));
    const groups = [
      { id: "build", title: s.tcGroupBuild },
      { id: "flash", title: s.tcGroupFlash },
      { id: "monitor", title: s.tcGroupMonitor },
      { id: "analyze", title: s.tcGroupAnalyze },
    ];
    for (const group of groups) {
      const kinds = (state.toolchainKinds ?? []).filter((kind) => infoFor(kind).group === group.id);
      if (kinds.length === 0) continue;
      const section = el("section", "setting-group");
      const heading = el("h3", "setting-group-title", group.title);
      const counts = kinds.filter((kind) => found.has(kind)).length;
      heading.appendChild(el("span", "tc-count", `${counts}/${kinds.length}`));
      section.appendChild(heading);

      for (const kind of kinds) {
        const tool = found.get(kind);
        const row = el("div", `tc-row${tool ? "" : " tc-missing"}`);
        row.dataset.search = `${infoFor(kind).label} ${kind} ${infoFor(kind).purpose}`.toLowerCase();

        const dot = el("span", `tc-dot${tool ? (tool.problem ? " warn" : " ok") : ""}`);
        dot.title = tool ? (tool.problem || s.tcFound) : s.tcMissing;
        row.appendChild(dot);

        const main = el("div", "pack-main");
        const title = el("div", "pack-title");
        title.appendChild(el("strong", "", infoFor(kind).label));
        if (tool?.version) title.appendChild(el("span", "pack-version", shortVersion(tool.version)));
        main.appendChild(title);
        main.appendChild(el("div", "tc-purpose", infoFor(kind).purpose));

        if (tool?.path) {
          const path = el("div", "tc-path", tool.path);
          path.title = tool.path;
          main.appendChild(path);
        } else if (tool?.problem) {
          main.appendChild(el("div", "pack-problem", tool.problem));
        }
        row.appendChild(main);

        // 来源：PATH、安装目录、还是本应用装的 pack。用户在排查
        // "为什么用的是旧版本"时，这一列就是答案。
        if (tool?.source) row.appendChild(el("span", "tc-source", s.tcSource?.[tool.source] ?? tool.source));

        // 未安装的工具若正好在可安装目录里，就在这里给一个入口 ——
        // 用户看到"未安装"的下一个念头就是"那怎么装"，不该让他滚到页面
        // 底部再自己把名字对上。
        if (!tool) {
          const entry = availableEntryFor(kind);
          if (entry) {
            const install = sButton(s.packInstall, () => api.send({ cmd: "installPack", id: entry.id }), { quiet: true });
            install.dataset.packAction = "install";
            install.classList.add("tc-install");
            row.appendChild(install);
          }
        }
        section.appendChild(row);
      }
      detectedBox.appendChild(section);
    }

    if ((detected.searchPaths ?? []).length) {
      // 搜索路径默认折叠。它是排查"为什么没找到"时才需要的信息，展开时
      // 占掉五行会把下面的"可安装"推到屏幕外——用户来这一页首先想装的。
      const details = el("details", "tc-searched");
      const summary = el("summary", "", s.tcSearched.replace("{n}", String(detected.searchPaths.length)));
      details.appendChild(summary);
      const paths = el("div", "tc-search-paths");
      for (const path of detected.searchPaths) paths.appendChild(el("code", "", path));
      details.appendChild(paths);
      detectedBox.appendChild(details);
    }
  };

  const render = () => {
    renderDetected(state.packState?.detected ?? null);
    const packs = state.packState;
    list.innerHTML = "";

    if (!packs) {
      list.appendChild(el("p", "setting-note", s.packLoading));
      return;
    }

    // 错误要留在页面上，而不是变成一个一闪而过的提示：安装失败的原因
    // （磁盘不够、哈希不对、包已损坏）恰恰是用户需要读的东西。
    if (state.packError) {
      const box = el("div", "pack-error");
      box.textContent = state.packError;
      list.appendChild(box);
    } else if (state.packNotice) {
      // 校验通过是"什么也没发生"，但用户点了按钮，总得有一句回话。
      const box = el("div", "pack-ok");
      box.textContent = state.packNotice;
      list.appendChild(box);
    }

    // 根目录与占用：一行说清"磁盘被谁占了"。
    summary.innerHTML = "";
    summary.appendChild(el("code", "pack-root", packs.root));
    summary.appendChild(
      el(
        "span",
        "pack-usage",
        `${s.packUsed} ${formatBytes(packs.totalBytes)}${packs.freeBytes ? ` · ${s.packFree} ${formatBytes(packs.freeBytes)}` : ""}`,
      ),
    );
    pane.insertBefore(summary, list);

    // 统一列表：已安装在前、可安装在后，同一张表同一个节奏。已安装的
    // 行带它满足的工具链种类（provides），扫一眼就知道"装这个是为了什么"。
    const installedIds = new Set((packs.packs ?? []).map((pack) => pack.manifest.id));
    for (const pack of packs.packs) {
      const row = el("div", "pack-row");

      const main = el("div", "pack-main");
      const title = el("div", "pack-title");
      title.appendChild(el("strong", "", pack.manifest.name));
      title.appendChild(el("span", "pack-version", pack.manifest.version));
      if (pack.status === "broken") title.appendChild(el("span", "mcp-scope disabled", s.packBroken));
      main.appendChild(title);

      const meta = el("div", "pack-meta");
      meta.appendChild(el("span", "pack-size", formatBytes(pack.bytes)));
      if (pack.manifest.provides.length) meta.appendChild(el("span", "pack-provides", pack.manifest.provides.join(", ")));
      if (pack.manifest.license?.url) {
        const link = el("button", "link-button", s.packLicence);
        link.type = "button";
        link.addEventListener("click", () => api.openExternal?.(pack.manifest.license.url));
        meta.appendChild(link);
      }
      main.appendChild(meta);

      if (pack.problem) main.appendChild(el("p", "setting-note pack-problem", pack.problem));

      const actions = el("div", "pack-actions");
      const verify = sButton(s.packVerify, () => api.send({ cmd: "verifyPack", id: pack.manifest.id }), { quiet: true });
      verify.dataset.packAction = "verify";
      actions.appendChild(verify);

      // 删除一个 pack 是一 GB，误删的代价是重新下载十分钟。与其他删除
      // 统一走 confirmAction 弹窗——确认状态放在 state 上的 armed 模式
      // 在 render 重建后会失效，而且同一产品里不该有两种删除确认。
      const remove = sButton(s.packRemove, () => {
        void confirmAction(s.packRemoveConfirm.replace("{name}", pack.manifest.name), { danger: true }).then((yes) => {
          if (!yes) return;
          state.packRemoveArmed = null;
          api.send({ cmd: "removePack", id: pack.manifest.id });
        });
      }, { quiet: true, danger: true });
      remove.dataset.packAction = "remove";
      actions.appendChild(remove);

      row.append(main, actions);
      list.appendChild(row);
    }

    if (packs.packs.length === 0) {
      const empty = el("div", "settings-empty-card");
      empty.appendChild(el("h3", "", s.packEmptyTitle));
      empty.appendChild(el("p", "", s.packEmptyBody));
      list.appendChild(empty);
    }

    // 可安装的条目接着已安装的排，样式上不再单独分组 —— "还能装什么"
    // 是这张统一列表的下半部分。已经装过的那个不再列出来。
    const available = (state.packCatalog ?? []).filter((entry) => !installedIds.has(entry.id) && entry.installable);
    for (const entry of available) {
      const row = el("div", "pack-row pack-available");
      const main = el("div", "pack-main");
      const title = el("div", "pack-title");
      title.appendChild(el("strong", "", entry.name));
      title.appendChild(el("span", "pack-version", entry.version));
      main.appendChild(title);
      main.appendChild(el("div", "pack-meta", `${formatBytes(entry.downloadBytes)} · ${entry.provides.join(", ")}`));

      const actions = el("div", "pack-actions");
      const installPrimary = sButton(s.packInstall, () => api.send({ cmd: "installPack", id: entry.id }), { primary: true });
      installPrimary.dataset.packAction = "install";
      actions.appendChild(installPrimary);
      row.append(main, actions);
      list.appendChild(row);
    }
    if (packs.packs.length && available.length === 0) {
      // 没有可安装项时不安静地留白：用户会以为页面坏了。真实原因有两种,
      // 都要说清楚 —— 已经装完了，或者目录里还没有通过校验的条目。
      const pending = (state.packCatalog ?? []).filter((entry) => !entry.installable && !installedIds.has(entry.id));
      const note = el("p", "setting-note pack-none");
      note.textContent = pending.length ? s.packNonePending : s.packNoneInstalled;
      list.appendChild(note);
    }

    // 高级区（页面底部，默认折叠）：本机检测详情在 renderDetected 里刷新；
    // 清理、离线安装是静态内容，在 render 外面只构建一次。
    if (advanced.parentNode !== pane) pane.appendChild(advanced);
  };

  // 清理只删「本应用创建且已经过期」的目录：中断留下的半截下载，
  // 和删了一半的旧版本。它不会碰任何已安装的包，所以可以放在这里
  // 让用户随时点，而不必等启动时那一次自动清理。
  const housekeeping = el("div", "pack-housekeeping");
  const prune = sButton(s.packPrune, () => api.send({ cmd: "prunePacks" }), { quiet: true });
  prune.dataset.packAction = "prune";
  housekeeping.appendChild(prune);
  advancedBody.appendChild(housekeeping);

  // 离线安装：内网机器连不上下载站时，用户手上只有别人拷过来的
  // pack.json 和压缩包。它和在线安装走同一个事务，只是字节来源不同。
  const offline = el("div", "pack-offline");
  offline.appendChild(el("p", "setting-note", s.packOfflineHint));
  offline.appendChild(
    sButton(s.packOffline, async () => {
      const manifestPath = await api.pickFile?.({ filters: [{ name: "pack.json", extensions: ["json"] }] });
      if (!manifestPath) return;
      // 同一个目录里的 .zip / .tar.xz 就是它的归档；找不到就让安装器
      // 自己按 manifest 里的 URL 去取。
      const dir = manifestPath.replace(/[\\/][^\\/]+$/, "");
      const archive = await api.pickFile?.({
        defaultPath: dir,
        filters: [{ name: "Archive", extensions: ["zip", "xz", "gz"] }],
      });
      api.send({ cmd: "installFromManifest", path: manifestPath, files: archive ? [archive] : [] });
    }),
  );
  advancedBody.appendChild(offline);

  // 进度条独立于列表，安装时它出现在最上面。
  const progressBar = el("div", "pack-progress");
  progressBar.hidden = true;
  progressBar.appendChild(el("div", "pack-progress-label"));
  const bar = el("div", "pack-progress-track");
  const fill = el("div", "pack-progress-fill");
  bar.appendChild(fill);
  progressBar.appendChild(bar);
  pane.insertBefore(progressBar, list);

  state.renderPackPage = render;
  state.renderPackProgress = (progress) => {
    // An in-flight operation disables every pack button on the page: the host
    // aborts the running install when a second one arrives, so a second click
    // did not just error — it killed the first download.
    const busy = progress !== null;
    for (const button of pane.querySelectorAll("button")) {
      if (button.dataset.packAction === undefined) continue;
      button.disabled = busy;
    }
    if (!progress) {
      progressBar.hidden = true;
      return;
    }
    progressBar.hidden = false;
    const label = progressBar.querySelector(".pack-progress-label");
    const phaseText = {
      preflight: s.packPhasePreflight,
      download: s.packPhaseDownload,
      verify: s.packPhaseVerify,
      extract: s.packPhaseExtract,
      inspect: s.packPhaseInspect,
      validate: s.packPhaseValidate,
      commit: s.packPhaseCommit,
    }[progress.phase] ?? progress.phase;

    if (progress.phase === "download" && progress.total) {
      const pct = Math.min(100, Math.round(((progress.received ?? 0) / progress.total) * 100));
      label.textContent = `${phaseText} ${pct}% · ${formatBytes(progress.received ?? 0)} / ${formatBytes(progress.total)}`;
      fill.style.width = `${pct}%`;
    } else {
      label.textContent = phaseText;
      // 非下载阶段没有可比的量，用一个不确定宽度表示"在动"而不是假装有进度。
      fill.style.width = progress.phase === "commit" ? "100%" : "60%";
    }
  };

  api.send({ cmd: "getPacks" });
  api.send({ cmd: "getPackCatalog" });
  render();
  return pane;
}

function buildSystemPage() {
  const s = S();
  const pane = sPage(s.pageSystem, s.pageSystemDesc);
  const sys = state.systemState ?? {};

  pane.appendChild(
    sGroup(s.groupComputer, [
      sRow({
        label: s.launchAtLogin,
        desc: s.launchAtLoginDesc,
        control: sToggle({
          checked: Boolean(sys.launchAtLogin),
          onChange: (value) => setSystem("launchAtLogin", value),
        }),
      }),
      sRow({
        label: s.tray,
        desc: s.trayDesc,
        control: sToggle({ checked: Boolean(sys.tray), onChange: (value) => setSystem("tray", value) }),
      }),
      sRow({
        label: s.keepAwake,
        desc: s.keepAwakeDesc,
        control: sToggle({ checked: Boolean(sys.keepAwake), onChange: (value) => setSystem("keepAwake", value) }),
      }),
      sRow({
        label: s.quickEntry,
        desc: s.quickEntryDesc,
        control: sText({
          value: sys.quickEntry ?? "",
          placeholder: api.platform === "darwin" ? "Cmd+Shift+Space" : "Ctrl+Alt+Space",
          mono: true,
          onChange: (value) => setSystem("quickEntry", value),
        }),
      }),
    ]),
  );
  pane.appendChild(el("p", "setting-note", s.systemNote));
  return pane;
}

function setSystem(key, value) {
  if (!api.systemSet) return;
  void api.systemSet(key, value).then((next) => {
    state.systemState = next;
    rerenderSettingsPage("system");
  });
}

/**
 * Hooks: what a workspace wants to run around agent activity, and whether the
 * user has accepted it.
 *
 * A project hook is code the checkout supplies and the agent runs with the
 * user's own permissions, so the page shows the commands before the switch
 * that enables them. Enabling is an explicit action recorded per workspace;
 * editing the file afterwards asks again.
 */
function buildHooksPage() {
  const s = S();
  const pane = sPage(s.pageHooks, s.pageHooksDesc);
  const status = state.hookStatus ?? { file: "", exists: false, trusted: false, entries: [], global: 0 };

  const stateRow = el("div", "setting-badge", "");
  if (!status.exists) {
    stateRow.textContent = s.hookNone;
    stateRow.classList.add("muted");
  } else if (status.trusted) {
    stateRow.textContent = s.hookTrusted;
    stateRow.classList.add("ok");
  } else {
    stateRow.textContent = s.hookUntrusted;
    stateRow.classList.add("warn");
  }

  const actions = el("div", "setting-control");
  if (status.exists) {
    const button = status.trusted
      ? sButton(s.hookRevoke, () => api.send({ cmd: "hookTrust", trust: false }), { danger: true })
      : sButton(s.hookTrust, () => api.send({ cmd: "hookTrust", trust: true }), { primary: true });
    actions.appendChild(button);
  }

  // A file path, not a setting: repeating the page description under it said
  // nothing about the file. The path is only shown when the host named a file
  // it actually read — this kernel has no hook mechanism, so a hard-coded
  // path would describe something that does not exist.
  const rows = [];
  if (status.file) rows.push(sRow({ label: status.file, desc: "", control: stateRow, wide: true, mono: true }));
  rows.push(
    status.exists
      ? sRow({ label: s.hookState, desc: s.hookReview, control: actions, wide: true })
      : sRow({ label: s.hookState, desc: "", control: stateRow, wide: true }),
  );
  pane.appendChild(sGroup(s.groupCustomize, rows));

  if (status.entries.length > 0) {
    const table = el("section", "setting-group");
    table.appendChild(el("h3", "setting-group-title", s.hookEvent));
    for (const entry of status.entries) {
      const row = el("div", "setting-row");
      const copy = el("div", "setting-copy");
      copy.appendChild(el("code", "setting-code", entry.event));
      const control = el("div", "setting-control");
      control.appendChild(el("code", "setting-code", entry.command));
      row.append(copy, control);
      table.appendChild(row);
    }
    pane.appendChild(table);
  }

  if (status.global > 0) pane.appendChild(el("p", "setting-note", s.hookGlobal.replace("{n}", String(status.global))));
  return pane;
}

/**
 * The folder the app keeps its files in.
 *
 * Every config file the host reports sits directly inside this folder. When
 * the host reported one, show the folder it names; otherwise name the variable
 * and its default rather than inventing a path that may not exist here.
 */
function dataFolderPath() {
  const file = state.configPaths?.providers;
  if (typeof file === "string" && file !== "") {
    const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
    if (cut > 0) return file.slice(0, cut);
  }
  return "$HARNESS_HOME (default ~/.harness)";
}

/**
 * How each update state is worded, and what the click does next.
 *
 * One table rather than a chain of ifs in the builder: the page has to answer
 * the same question twice (on build and when a status arrives over the event
 * channel), and two copies of this mapping would eventually disagree.
 *
 * `action` is the only button the state offers, or `null`. Every state that has
 * nothing to act on gets no button — a disabled control that can never become
 * enabled is the same lie as a control that does nothing (D-188).
 */
function updateStatusView(status) {
  const s = S();
  const version = typeof status?.version === "string" ? status.version : "";
  switch (status?.state) {
    case "unsupported":
      return {
        text: status.reason === "dev" ? s.updateUnsupportedDev : s.updateUnsupportedMissing,
        action: null,
      };
    case "checking":
      return { text: s.updateChecking, action: null };
    case "up-to-date":
      return {
        text: version === "" ? s.updateCurrent : `${s.updateCurrent} ${version}`,
        action: { id: "check", label: s.updateCheckAgain, run: "check" },
      };
    case "available":
      return {
        text: version === "" ? s.updateAvailable : `${s.updateAvailable} ${version}`,
        action: { id: "download", label: s.updateDownload, run: "download", primary: true },
      };
    case "downloading":
      return {
        text: `${s.updateDownloading} ${typeof status.percent === "number" ? status.percent : 0}%`,
        action: null,
      };
    case "downloaded":
      return {
        text: version === "" ? s.updateDownloaded : `${s.updateDownloaded} ${version}`,
        action: { id: "install", label: s.updateInstall, run: "install", primary: true },
      };
    case "error": {
      // The reason is the actionable half: "could not check" alone leaves the
      // user with nothing to do. `updateErrorReason` never returns "" — an
      // unknown code maps to its own sentence rather than to silence (R3).
      const reason = updateErrorReason(status.reason);
      const detail = typeof status.message === "string" && status.message !== "" ? ` (${status.message})` : "";
      return {
        text: `${s.updateError} ${reason}${detail}`,
        action: { id: "check", label: s.updateCheckAgain, run: "check" },
      };
    }
    default:
      // `idle`, or a state this build does not know: offer the check, which is
      // the only way to learn anything.
      return {
        text: s.updateIdle,
        action: { id: "check", label: t.checkUpdate, run: "check" },
      };
  }
}

/** The reason sentence for a failed check/download. Never empty. */
function updateErrorReason(reason) {
  const s = S();
  switch (reason) {
    case "network":
      return s.updateReasonNetwork;
    case "no-release":
      return s.updateReasonNoRelease;
    case "no-manifest":
      return s.updateReasonNoManifest;
    case "signature":
      return s.updateReasonSignature;
    case "checksum":
      return s.updateReasonChecksum;
    case "download":
      return s.updateReasonDownload;
    case "config":
      return s.updateReasonConfig;
    case "manifest":
      return s.updateReasonManifest;
    default:
      return s.updateReasonUnknown;
  }
}

function buildAboutPage() {
  const s = S();
  const pane = sPage(s.pageAbout, s.pageAboutDesc);
  // The product mark, at the size where the gradient actually reads. It is a
  // raster (`assets/mark.png`) rather than the sprite's SVG: the logo has its
  // own colours, which `currentColor` cannot carry.
  const head = el("div", "about-head");
  const logo = document.createElement("img");
  logo.className = "about-mark";
  logo.src = "assets/mark.png";
  logo.alt = "";
  logo.setAttribute("aria-hidden", "true");
  logo.draggable = false;
  head.appendChild(logo);
  head.appendChild(el("span", "about-name", "Embedded AI Master"));
  pane.appendChild(head);

  const row = el("section", "about-row");
  // The product name is in the header above; this row is the build identity.
  row.appendChild(el("span", "about-version", `v${state.appVersion ?? "?"}`));

  const actions = el("div", "about-actions");
  const note = el("div", "settings-hint update-note");
  note.id = "update-note";
  note.setAttribute("role", "status");
  // The page is rebuilt on every visit, so it draws from whatever the main
  // process last decided rather than starting at "checking" and waiting.
  const paint = (status) => {
    state.updateStatus = status;
    const view = updateStatusView(status);
    note.textContent = view.text;
    actions.innerHTML = "";
    if (view.action === null) return;
    const button = sButton(
      view.action.label,
      () => {
        // The click starts the work; the resulting state arrives as an
        // `update_status` event, so the page never assumes an outcome.
        if (view.action.run === "check") void api.updateCheck();
        else if (view.action.run === "download") void api.updateDownload();
        else if (view.action.run === "install") void api.updateInstall();
      },
      { primary: view.action.primary === true },
    );
    button.dataset.updateAction = view.action.id;
    actions.appendChild(button);
  };
  paint(state.updateStatus ?? { state: "idle" });
  state.renderAboutUpdate = paint;
  row.appendChild(actions);
  pane.appendChild(row);
  pane.appendChild(note);
  // Asked for, not assumed: the main process owns the state, and this page may
  // be the first thing that reads it after a check ran at startup. The call
  // only reads the cached status — it does not contact the release feed.
  if (typeof api.updateStatus === "function") {
    void api.updateStatus().then((status) => {
      // The page may have been closed or rebuilt while the answer was in
      // flight; only paint if this closure still owns the visible note.
      if (state.renderAboutUpdate === paint && status) paint(status);
    });
  }
  pane.appendChild(
    sGroup(s.groupData, [
      sRow({
        label: s.dataFolder,
        desc: s.dataFolderDesc,
        control: el("code", "setting-code", dataFolderPath()),
      }),
      sRow({
        label: s.localOnly,
        desc: s.localOnlyDesc,
        control: el("span", "setting-badge", s.localBadge),
      }),
    ]),
  );
  return pane;
}

/* ---------- rail, search, and lifecycle ---------- */

function settingsRail() {
  const nav = $("settings-nav");
  nav.innerHTML = "";
  const pages = settingsPages();
  let lastGroup = "";
  for (const page of pages) {
    if (page.group !== lastGroup) {
      lastGroup = page.group;
      nav.appendChild(el("div", "settings-nav-group", page.group));
    }
    const button = el("button", "settings-nav-item");
    button.type = "button";
    button.dataset.settingsTab = page.id;
    button.setAttribute("role", "tab");
    button.append(iconEl(SETTINGS_ICON_NAMES[page.id] ?? "user"), el("span", "", page.title));
    button.addEventListener("click", () => selectSettingsTab(page.id));
    nav.appendChild(button);
  }
}

/** The rail, the search placeholder, and the profile block — every part of the
 *  chrome outside the pane itself. Kept in one place because the locale
 *  rebuild needs exactly this set to follow a language change. */
function renderChrome() {
  settingsRail();
  $("settings-search").placeholder = S().searchSettings;
  $("settings-profile-name").textContent = state.cwd ? basename(state.cwd) : S().noWorkspace;
  $("settings-profile-sub").textContent = S().railProfileSub;
}

/**
 * Follow a language change while the page is open.
 *
 * Page builders read `S()` once, when they run, and none of their text carries
 * `data-i18n`, so the renderer's global pass cannot reach them. Rebuilding the
 * pane and the rail is the only way the labels can change without closing and
 * reopening Settings. Only the locale path calls this: a rebuild discards any
 * in-progress edit in a text field, which is exactly what a language switch
 * already implies.
 */
function applyLocaleChange() {
  if (settingsDialog.hidden) return;
  const scroll = $("settings-panes").scrollTop;
  renderChrome();
  selectSettingsTab(state.settingsTab);
  $("settings-panes").scrollTop = scroll;
}

function openSettings(tab = "general") {
  // Opening Settings starts from the file: `selectSettingsTab` below rebuilds
  // the model-services pane, so a draft from a previous visit is already gone from
  // the screen and must not linger in the flags either.
  connectionDirty = false;
  connectionShowSaved = false;
  connectionSavePending = false;
  connectionSavedSeq = -1;
  renderChrome();
  selectSettingsTab(tab);
  openModal(settingsDialog);
  // Only the settings payload is fetched: every other page's data source is
  // not mounted, so asking for it would generate one warning per open.
  api.send({ cmd: "getSettings" });
  // Focus the page container, not a rail button: a programmatic focus on a
  // button paints the keyboard ring and makes the page look selected-by-error.
  settingsDialog.focus?.();
  void refreshVersion().then(() => {
    if (state.settingsTab === "about") rerenderSettingsPage("about");
  });
}

/** Build one pane on demand; each page owns its own state and refresh. */
function selectSettingsTab(tab) {
  const pages = settingsPages();
  const page = pages.find((entry) => entry.id === tab) ?? pages[0];
  // Leaving the model-services page abandons its draft (it has a Save step,
  // so a draft left behind would be work the user can no longer see or reach),
  // and the first-run hint belongs to that visit, not to the next.
  if (page.id !== "connection") {
    connectionSetupHint = false;
    connectionDirty = false;
    connectionShowSaved = false;
    connectionSavedSeq = -1;
    // A test whose card is no longer on screen has no result to show; its
    // timer would otherwise fire into a page the user has left.
    abandonConnectionTests();
  }
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    const active = button.dataset.settingsTab === page.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  const panes = $("settings-panes");
  panes.innerHTML = "";
  // The bodies the search had opened belonged to the pane being replaced; a
  // tab switch with the box still full starts over on the new page's cards.
  searchOpenedBodies.clear();
  panes.appendChild(page.build());
  const empty = el("div", "settings-empty");
  empty.id = "settings-empty";
  empty.hidden = true;
  panes.appendChild(empty);
  panes.scrollTop = 0;
  state.settingsTab = page.id;
  applySettingsSearch();
}

function rerenderSettingsPage(tab) {
  if (state.settingsTab !== tab) return;
  const scroll = $("settings-panes").scrollTop;
  selectSettingsTab(tab);
  $("settings-panes").scrollTop = scroll;
}

$("settings-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-settings-tab]");
  if (button) selectSettingsTab(button.dataset.settingsTab);
});

$("settings-back").addEventListener("click", () => closeModal(settingsDialog));

/**
 * The rail foot names the open folder and opens the General page.
 *
 * It used to be a button that said "Not signed in" and did nothing at all —
 * there is no account in this product, so the label described a state that
 * cannot exist and the click was never wired. It is now what its position
 * implies: the workspace, and a way to get to the control that changes it.
 */
$("settings-profile").addEventListener("click", () => selectSettingsTab("general"));

$("settings-search").addEventListener("input", (event) => {
  state.settingsQuery = event.target.value.trim().toLowerCase();
  applySettingsSearch();
});

/**
 * Card bodies the search opened because they were collapsed.
 *
 * A row inside a closed card can match a query, and a result the user cannot
 * see is not a result. These are reopened for as long as the box holds text;
 * clearing it closes exactly the ones the search opened, leaving cards the
 * user had opened (or closed) alone. Module-level because the clear path runs
 * on a later event with no other record of what it changed.
 */
const searchOpenedBodies = new Set();

/**
 * Search filters the rows on the current page and, when nothing on this page
 * matches, points at the pages that do. A settings page without search makes
 * the user guess which tab hides the control they want.
 */
function applySettingsSearch() {
  const query = state.settingsQuery;
  const panes = $("settings-panes");
  const empty = $("settings-empty");
  // A row inside a collapsed card, or folded into an advanced disclosure, is
  // matched but invisible. A query opens both for as long as it is active;
  // clearing the box puts the card back the way the user had it — the toggle's
  // `aria-expanded` is the state `setExpanded` keeps, so the restore does not
  // have to guess.
  const opened = panes.querySelectorAll(".setting-advanced.search-open");
  if (!query) {
    panes
      .querySelectorAll(".setting-row, .conn-field, .setting-group, .conn-section, .setting-advanced, .settings-page")
      .forEach((node) => {
        node.hidden = false;
      });
    for (const section of opened) {
      section.open = false;
      section.classList.remove("search-open");
    }
    // `aria-expanded` is the card's own state: a card the user opened while
    // the search was running must stay open, and one they closed must stay
    // closed. Only the bodies the search itself revealed go back.
    for (const body of searchOpenedBodies) {
      const toggle = body.closest(".settings-form-card")?.querySelector(".settings-card-toggle");
      body.hidden = toggle?.getAttribute("aria-expanded") !== "true";
    }
    searchOpenedBodies.clear();
    if (empty) empty.hidden = true;
    return;
  }
  // Collapsed cards only. Other pages' `settings-form-card-body` is always
  // shown and is left alone — this list is what the clear path restores.
  panes.querySelectorAll(".settings-form-card-body").forEach((body) => {
    if (body.hidden) {
      searchOpenedBodies.add(body);
      body.hidden = false;
    }
  });
  let visible = 0;
  panes.querySelectorAll(".setting-row, .conn-field").forEach((row) => {
    const match = (row.dataset.search ?? "").includes(query);
    row.hidden = !match;
    if (match) visible++;
  });
  // A group keeps its heading only while something under it is showing.
  panes.querySelectorAll(".setting-group, .conn-section").forEach((group) => {
    group.hidden = ![...group.querySelectorAll(".setting-row, .conn-field")].some((row) => !row.hidden);
  });
  panes.querySelectorAll(".setting-advanced").forEach((section) => {
    const hasMatch = [...section.querySelectorAll(".setting-row")].some((row) => !row.hidden);
    // A folded section whose fields all missed the query is a summary line
    // about nothing — hide it while a query is active.
    section.hidden = !hasMatch;
    if (hasMatch) {
      if (!section.open) {
        section.open = true;
        section.classList.add("search-open");
      }
    } else if (section.classList.contains("search-open")) {
      section.open = false;
      section.classList.remove("search-open");
    }
  });
  if (!empty) return;
  empty.hidden = visible > 0;
  if (visible === 0) {
    const s = S();
    const pages = settingsPages().filter((entry) => {
      if (entry.id === state.settingsTab) return false;
      return true;
    });
    empty.innerHTML = "";
    empty.appendChild(el("p", "", s.noMatches(query)));
    const links = el("div", "settings-empty-actions");
    for (const entry of pages) {
      const button = el("button", "chip-button", entry.title);
      button.type = "button";
      button.addEventListener("click", () => {
        $("settings-search").value = "";
        state.settingsQuery = "";
        selectSettingsTab(entry.id);
        // Carry the query over so the target page opens already filtered.
        state.settingsQuery = query;
        $("settings-search").value = query;
        applySettingsSearch();
      });
      links.appendChild(button);
    }
    empty.appendChild(links);
  }
}

/** First-run path: open Settings on the connection fields with a short prompt. */
function openSetup() {
  // The flag is what makes the hint survive the rebuild that follows the
  // host's answer — the pane this call builds is usually replaced by the one
  // `fillSettings` builds a moment later, taking any hint written into it.
  connectionSetupHint = true;
  // 焦点同样走标志：页面构建时（含宿主回包后的重建）抓取，而不是用固定
  // 延时去赌一次异步渲染——宿主慢于 80ms 时旧实现会落空。
  connectionSetupFocus = true;
  openSettings("connection");
  // 页面本次是同步建好的；直接试一次，若 id 已在就立刻聚焦。
  $("setting-base-url")?.focus();
}

$("setup-button").addEventListener("click", openSetup);

/**
 * The host answered getSettings; refill the open page.
 *
 * Only the keys the host actually sent are applied. The kernel has no
 * preference store — a host that does not keep UI state used to answer with
 * placeholder values (`theme: "dark"`, `fontScale: 1`), and applying those
 * turned "open Settings" into "reset every display preference".
 */
function fillSettings(settings) {
  state.settings = settings;
  state.providers = settings.providers || [];
  state.provider = settings.provider || "custom";
  if (settings.locale) state.locale = settings.locale;
  // The config files. Absent means "this host could not read them", which the
  // pages must show as such rather than as an empty, editable file: writing
  // back over a file nobody read would delete every entry in it.
  if (Array.isArray(settings.mcpServers)) state.mcpServers = settings.mcpServers;
  if (settings.permissions) {
    state.permissions = settings.permissions;
    state.rules = Array.isArray(settings.permissions.rules) ? settings.permissions.rules : [];
  }
  if (settings.run) state.runLimits = { ...DEFAULT_RUN_LIMITS, ...settings.run };
  if (settings.configPaths) state.configPaths = settings.configPaths;
  const prefs = [
    ["theme", "theme"],
    ["density", "density"],
    ["fontScale", "fontScale"],
    ["transcriptWidth", "transcriptWidth"],
    ["transcriptView", "transcriptView"],
    ["reduceMotion", "reduceMotion"],
    ["codeFont", "codeFont"],
  ];
  for (const [key, field] of prefs) {
    const value = settings[field];
    if (value === undefined || value === null) continue;
    applyUiPreference(key, value);
  }
  if (settings.notifications !== undefined) state.notifications = settings.notifications !== false;
  if (settings.keepAwake !== undefined) state.keepAwake = Boolean(settings.keepAwake);
  if (settings.outputStyle !== undefined) state.outputStyle = settings.outputStyle;
  if (settings.archiveAfterDays !== undefined) state.archiveAfterDays = settings.archiveAfterDays;
  if (settings.sandbox !== undefined) state.sandbox = settings.sandbox === "off" ? "off" : "enforce";
  // The WSL answer arrives with the settings payload so the row can state the
  // truth ("Ubuntu is available") instead of offering a switch with no visible
  // effect.
  state.kernelSandbox = settings.kernelSandboxState ?? state.kernelSandbox ?? null;
  setMode(state.mode);
  // The model-services page holds a draft, every other page saves on change —
  // so a rebuild costs nothing there but would discard what the user typed
  // here. A payload that answers a save is the one case where the file really
  // changed: the draft becomes the saved state and the pane is rebuilt from
  // the file. A rejected save answers with a read error, and the draft stays
  // so the user can correct it instead of retyping it.
  const providersFailed = typeof settings.providersError === "string" && settings.providersError !== "";
  if (connectionSavePending) {
    connectionSavePending = false;
    // The pane is about to be rebuilt from the file, so the draft is no longer
    // the only copy of those edits — unless the form was typed into while the
    // save was in flight, in which case those newer keystrokes stay a draft.
    // A rejected save answers with a read error instead, and the draft stays
    // so the user can correct it rather than retype it.
    if (!providersFailed) {
      connectionShowSaved = true;
      connectionDirty = connectionEditSeq !== connectionSavedSeq;
    }
  }
  if (settingsDialog.hidden) return;
  if (state.settingsTab === "connection" && connectionDirty) return;
  rerenderSettingsPage(state.settingsTab);
}

/* ---------- about / update check ---------- */

async function refreshVersion() {
  if (!api.appVersion) return;
  const version = await api.appVersion();
  state.appVersion = version;
  return version;
}

function basename(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

  /** Wire the events the host sends back into the open pages. */
  function handleEvent(message) {
    switch (message.type) {
      case "settings":
        // A payload that could not read the config files says so at the top
        // level, beside the fields it did send, so the failure survives the
        // page rebuild that `fillSettings` triggers.
        state.settingsError = message.settingsError ?? "";
        fillSettings(message.settings);
        break;
      case "settings_saved":
        // Configuration changes are optimistic: the control already shows the
        // new value, and a failure is reported without closing the page.
        if (message.ok === false) {
          state.settingsError = message.error ?? "";
        }
        break;
      case "provider_test":
        handleProviderTest(message);
        break;
      case "usage_summary":
        state.usageSummary = message.summary;
        state.renderUsagePage?.();
        break;
      case "skills":
        // Both halves are optional in the protocol: a host that answers with
        // `problems` only, or with neither, must not put a non-array into the
        // page's `.filter` and blank the whole settings pane.
        state.skills = Array.isArray(message.skills) ? message.skills : [];
        state.skillProblems = (Array.isArray(message.problems) ? message.problems : []).map(
          (problem) => ({
            file: typeof problem?.file === "string" ? problem.file : "",
            message: typeof problem?.message === "string" ? problem.message : "",
          }),
        );
        // A fresh library means the last save landed (the host broadcasts only
        // after a successful write), so the error that belonged to an earlier
        // attempt must not stay on the page.
        state.skillError = "";
        state.renderSkillsPage?.();
        break;
      case "notice": {
        // Only the skills page is routed here (see `app.js`): the settings
        // dialog is a modal, so a transcript notice would never be read. Update
        // the line in place — re-rendering would take the open form, and the
        // draft it holds, down with it.
        // warn 和 error 都是失败，都要显示——把 error 丢掉等于把保存失败
        // 伪装成成功（R3）。只有 info 才是「什么也没发生」。
        const text = message.level === "info" ? "" : String(message.text ?? "");
        state.skillError = text;
        state.showSkillsError?.(text);
        break;
      }
      case "memory":
        state.memory = { global: message.global ?? [], project: message.project ?? [] };
        state.renderMemoryPage?.();
        break;
      case "kb":
        state.kb = message.kb ?? null;
        // The page may not be open (the command is only sent from it), but a
        // stale answer must not land on whatever is on screen now.
        if (state.settingsTab === "kb" && !settingsDialog.hidden) state.renderKbPage?.();
        break;
      case "update_status": {
        // The main process owns the updater; this page only draws. Painted in
        // place rather than by rebuilding the page, because a rebuild would
        // throw away the scroll position and the Data group's measured paths
        // for a line of text that changed.
        const status = message.status;
        if (status && typeof status.state === "string") {
          state.updateStatus = status;
          state.renderAboutUpdate?.(status);
        }
        break;
      }
      case "corpus_status":
        // Two shapes arrive here, and they mean different things. A `status`
        // object is one of the kernel's seven states; an `error` is the host
        // saying it could not read any of them. Keeping them apart is what
        // stops a missing kernel from being drawn as "bundled" — a state that
        // claims there is a corpus.
        if (typeof message.error === "string" && message.error !== "") {
          state.corpusError = message.error;
          state.corpusStatus = null;
        } else if (message.status && typeof message.status.kind === "string") {
          state.corpusError = "";
          state.corpusStatus = message.status;
        } else {
          // Neither half present: an answer with nothing in it is not evidence
          // of any state, and saying so beats leaving a stale one on screen.
          state.corpusError = S().kbUpdateEmptyAnswer;
          state.corpusStatus = null;
        }
        if (typeof message.configPath === "string" && message.configPath !== "") {
          state.corpusConfigPath = message.configPath;
        }
        // A status answer also ends whatever was in flight: the host only sends
        // one after the work it was doing. Progress lines are dropped with it,
        // because a counter left frozen at 3/12 after the run finished reads as
        // a download that stalled.
        state.corpusBusy = "";
        state.corpusProgress = null;
        if (state.settingsTab === "kb" && !settingsDialog.hidden) state.renderKbPage?.();
        break;
      case "corpus_update_progress":
        state.corpusProgress = {
          completed: typeof message.completed === "number" ? message.completed : 0,
          total: typeof message.total === "number" ? message.total : 0,
          path: typeof message.path === "string" ? message.path : "",
          action: message.action === "reused" ? "reused" : "downloaded",
        };
        if (state.settingsTab === "kb" && !settingsDialog.hidden) state.renderKbPage?.();
        break;
      case "corpus_update_result":
        // The outcome stays on the page until the next click; the status answer
        // that follows clears the busy flag.
        state.corpusResult = message.ok === true
          ? { ok: true, corpusVersion: message.corpusVersion }
          : {
              ok: false,
              reason: typeof message.reason === "string" ? message.reason : S().kbUpdateNoReason,
              corpusVersionUnchanged:
                typeof message.corpusVersionUnchanged === "number" ? message.corpusVersionUnchanged : null,
            };
        state.corpusProgress = null;
        // A result ends the work, whether or not a status answer follows. A
        // refusal the host answers with this event alone must not leave both
        // buttons disabled — that would be the only trace of a click.
        state.corpusBusy = "";
        if (state.settingsTab === "kb" && !settingsDialog.hidden) state.renderKbPage?.();
        break;
      case "instructions":
        state.instructionsText = message.text ?? "";
        if (state.settingsTab === "instructions" && !settingsDialog.hidden) {
          const area = $("setting-instructions");
          if (area && document.activeElement !== area) area.value = state.instructionsText;
        }
        break;
      case "hook_status":
        state.hookStatus = {
          file: message.file ?? "",
          exists: Boolean(message.exists),
          trusted: Boolean(message.trusted),
          entries: message.entries ?? [],
          global: message.global ?? 0,
        };
        if (state.settingsTab === "hooks") rerenderSettingsPage("hooks");
        break;
      case "rules":
        if (!settingsDialog.hidden) api.send({ cmd: "getSettings" });
        break;
      case "packs":
        state.packState = message;
        // The toolchain table arrives with the same message so a language
        // switch rebuilds from one source instead of racing two.
        state.toolchainInfo = {};
        for (const entry of message.toolchains ?? []) state.toolchainInfo[entry.kind] = entry;
        state.toolchainKinds = (message.toolchains ?? []).map((entry) => entry.kind);
        state.renderPackPage?.();
        break;
      case "pack_catalog":
        state.packCatalog = message.entries ?? [];
        state.renderPackPage?.();
        break;
      case "pack_progress":
        // 新的一次操作开始了，上一次的"校验通过"就不该再挂在页面上。
        if (message.phase === "preflight" || message.phase === "download") {
          state.packNotice = null;
          state.packError = "";
        }
        state.renderPackProgress?.(message);
        break;
      case "pack_installed":
        state.renderPackProgress?.(null);
        // 装完之后目录和列表都变了，重新拉一次而不是就地改状态。
        api.send({ cmd: "getPackCatalog" });
        break;
      case "pack_error":
        state.renderPackProgress?.(null);
        state.packError = message.message ?? "";
        state.renderPackPage?.();
        break;
      case "pack_verified":
        state.packError = message.ok ? "" : (message.problems ?? []).join("; ");
        state.packNotice = message.ok ? S().packVerifiedOk : null;
        state.renderPackPage?.();
        break;
      case "pack_pruned":
        // 没删到东西也是结果，也要说；否则用户分不清"已经干净了"和
        // "按钮坏了"。
        state.packNotice =
          message.removed > 0
            ? S().packPrunedSome.replace("{n}", String(message.removed)).replace("{size}", formatPackBytes(message.bytes))
            : S().packPrunedNone;
        api.send({ cmd: "getPacks" });
        break;
      default:
        break;
    }
  }

  return {
    open: openSettings,
    openSetup,
    handleEvent,
    applyLocaleChange,
    refreshVersion,
    close: () => closeModal(settingsDialog),
    isOpen: () => !settingsDialog.hidden,
    handleKey: (event) => {
      // Cmd/Ctrl+F inside Settings focuses its search, like a document.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !settingsDialog.hidden) {
        event.preventDefault();
        $("settings-search").focus();
        return true;
      }
      return false;
    },
  };
}

