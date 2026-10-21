/**
 * The Settings page.
 *
 * Built as a factory because it shares the renderer's state and helpers: the
 * app passes them in once and gets back the entry points it needs. Every
 * control applies immediately — there is no Save step, and no draft state to
 * lose when the page is closed.
 */

import { settingsStrings } from "./settings-i18n.js";
import { iconEl } from "./icons.js";

export function createSettings(deps) {
  const { state, $, api, formatTokens, setTheme, setDensity, setMode, applyLocale, openModal, closeModal, getT, applyCodeFont } = deps;
  // `t` is rebound on every locale change, so every read goes through getT().
  const t = new Proxy({}, { get: (_, key) => getT()[key] });
  const settingsDialog = $("settings-dialog");
  const shortcutsDialog = $("shortcuts-dialog");
  const modalScrim = $("modal-scrim");

/* ---------- settings ---------- */

/** Kernel defaults, mirrored so the form has something to compare against
 *  before the host answers (`src/config/app-config.ts`). */
const DEFAULT_RUN_LIMITS = { maxTurns: 10, maxCostUsd: null, timeoutMs: null, systemPrompt: "" };
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
state.memory = { global: [], project: [] };
state.systemState = null;
state.packState = null;
state.packProgress = null;
/** A transient "that worked" line, cleared on the next action. */
state.packNotice = null;
/** The pack id whose Remove button is awaiting its second click. */
state.packRemoveArmed = null;
state.settingsQuery = "";

/**
 * Draft bookkeeping for the Connection page.
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
/** The last save was accepted — shown until the draft is edited again. */
let connectionShowSaved = false;
/** Raised by `openSetup`; cleared when the user leaves the page. */
let connectionSetupHint = false;

const S = () => settingsStrings[state.locale] ?? settingsStrings.en;

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
  // The rest of the builders (usage, skills, memory, instructions, hooks,
  // packs, system, sessions) stay in this file so restoring a page is a
  // one-line change, but listing them would produce forms whose save button
  // cannot work.
  return [
    { id: "general", group: s.groupSettings, title: s.pageGeneral, build: buildGeneralPage },
    { id: "connection", group: s.groupSettings, title: s.pageConnection, build: buildConnectionPage },
    { id: "appearance", group: s.groupSettings, title: s.pageAppearance, build: buildAppearancePage },
    { id: "behavior", group: s.groupSettings, title: s.pageBehavior, build: buildBehaviorPage },
    { id: "mcp", group: s.groupSettings, title: s.pageMcp, build: buildMcpPage },
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

function sRow({ label, desc, control, id, wide = false, mono = false }) {
  const row = el("div", `setting-row${wide ? " wide" : ""}`);
  row.dataset.search = `${label} ${desc ?? ""}`.toLowerCase();
  const copy = el("div", "setting-copy");
  const labelNode = mono ? el("code", "setting-code", label) : el("label", "setting-label", label);
  if (id) labelNode.htmlFor = id;
  copy.appendChild(labelNode);
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
  if (id) input.id = id;
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
  const save = el("button", "btn btn-primary small", saveLabel);
  save.type = "button";
  save.addEventListener("click", () => {
    onSave(area.value);
    status.textContent = S().saved;
    setTimeout(() => (status.textContent = ""), 1600);
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
  const button = el("button", `btn small${primary ? " btn-primary" : ""}${quiet ? " btn-quiet" : ""}${danger ? " danger" : ""}`, label);
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
    case "restartSession":
    case "suggestions":
    case "updateCheck":
    case "isolateByDefault":
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
    case "transcriptView":
      state.transcriptView = value;
      document.documentElement.dataset.view = value;
      localStorage.setItem("prometheus.view", value);
      break;
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
    case "branchPrefix":
      state.branchPrefix = value;
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
        label: s.restartSession,
        desc: s.restartSessionDesc,
        control: sToggle({
          checked: state.restartSession !== false,
          onChange: (value) => applyPref("restartSession", value),
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
      sRow({
        label: s.isolateByDefault,
        desc: s.isolateByDefaultDesc,
        control: sToggle({
          checked: Boolean(state.isolateByDefault),
          onChange: (value) => applyPref("isolateByDefault", value),
        }),
      }),
    ]),
  );
  return pane;
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
          value: state.transcriptView ?? "normal",
          options: [
            { value: "normal", label: s.viewNormal },
            { value: "thinking", label: s.viewThinking },
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

/** A positive whole number, or null when the text is not one (empty included). */
function positiveIntOrNull(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Connection: the model services every turn talks to.
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
  };

  /** The first free default name; `provider1` unless that one is taken. */
  const nextName = () => {
    const taken = new Set(cards.map((card) => card.nameInput.value.trim()));
    let index = 1;
    while (taken.has(`provider${index}`)) index += 1;
    return `provider${index}`;
  };

  // The only protocol the kernel has (`ProviderConfigSchema` in
  // src/config/providers.ts). A new entry carries it so the card states what
  // it will be saved as, rather than leaving the field to be guessed at.
  const DEFAULT_PROTOCOL = "openai-chat-completions";
  const blankEntry = () => ({
    name: nextName(),
    protocol: DEFAULT_PROTOCOL,
    baseUrl: "",
    apiKeyEnv: "",
    models: [{ id: "", contextWindow: "", maxOutput: "" }],
    price: { input: "", output: "", cachedInput: "" },
    extra: {},
  });

  /** One saved provider, copied field by field. `extra` holds the keys the
   *  schema allows but this page does not edit (`requestTimeoutMs`,
   *  `maxResponseBytes`); they are carried through so saving does not erase
   *  a setting the user made elsewhere. */
  const entryFrom = (name, provider) => ({
    name,
    protocol: typeof provider?.protocol === "string" ? provider.protocol : DEFAULT_PROTOCOL,
    baseUrl: typeof provider?.baseUrl === "string" ? provider.baseUrl : "",
    apiKeyEnv: typeof provider?.apiKeyEnv === "string" ? provider.apiKeyEnv : "",
    models: Object.entries(provider?.models ?? {}).map(([id, model]) => ({
      id,
      contextWindow: model?.contextWindow ?? "",
      maxOutput: model?.maxOutput ?? "",
    })),
    price: {
      input: provider?.pricePerMillion?.input ?? "",
      output: provider?.pricePerMillion?.output ?? "",
      cachedInput: provider?.pricePerMillion?.cachedInput ?? "",
    },
    extra: {
      ...(provider?.requestTimeoutMs !== undefined ? { requestTimeoutMs: provider.requestTimeoutMs } : {}),
      ...(provider?.maxResponseBytes !== undefined ? { maxResponseBytes: provider.maxResponseBytes } : {}),
    },
  });

  /** One card. Values are read from the live inputs at save time, so adding or
   *  removing a card never has to re-read the DOM first. */
  const makeCard = (entry) => {
    const node = el("section", "settings-form-card");

    const head = el("div", "about-row");
    const title = el("h3", "", entry.name || s.connNewProvider);
    head.append(
      title,
      el("code", "setting-code", entry.protocol),
      sButton(
        s.remove,
        () => {
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

    const nameInput = sText({ value: entry.name, placeholder: "provider1", mono: true });
    nameInput.addEventListener("input", () => {
      title.textContent = nameInput.value.trim() || s.connNewProvider;
    });
    const baseUrlInput = sText({
      value: entry.baseUrl,
      placeholder: "https://api.example.com/v1",
      mono: true,
    });
    const apiKeyEnvInput = sText({
      value: entry.apiKeyEnv,
      placeholder: "DEEPSEEK_API_KEY",
      mono: true,
    });

    const modelList = el("div", "mcp-list");
    const modelHandles = [];
    const addModelRow = (model) => {
      const row = el("div", "rules-row");
      const idInput = sText({ value: model.id, placeholder: "model-name", mono: true });
      idInput.setAttribute("aria-label", s.connModelName);
      const contextInput = sText({ value: model.contextWindow, placeholder: "contextWindow", mono: true });
      contextInput.setAttribute("aria-label", s.connContextWindow);
      const maxOutputInput = sText({ value: model.maxOutput, placeholder: "maxOutput", mono: true });
      maxOutputInput.setAttribute("aria-label", s.connMaxOutput);
      const remove = sButton(
        s.remove,
        () => {
          const at = modelHandles.findIndex((handle) => handle.row === row);
          if (at >= 0) modelHandles.splice(at, 1);
          row.remove();
          markDirty();
        },
        { quiet: true, danger: true },
      );
      modelHandles.push({ row, idInput, contextInput, maxOutputInput });
      row.append(idInput, contextInput, maxOutputInput, remove);
      modelList.appendChild(row);
    };
    // A service with no models yet still gets one empty row: a card that only
    // holds "add" would hide what a model entry looks like.
    for (const model of entry.models.length > 0 ? entry.models : [{ id: "", contextWindow: "", maxOutput: "" }]) {
      addModelRow(model);
    }
    const addModel = sButton(
      s.connAddModel,
      () => {
        addModelRow({ id: "", contextWindow: "", maxOutput: "" });
        markDirty();
      },
      { quiet: true },
    );
    const modelFoot = el("div", "settings-list-foot");
    modelFoot.appendChild(addModel);

    const modelsGroup = el("section", "setting-group");
    modelsGroup.append(
      el("h3", "setting-group-title", s.connModels),
      el("p", "setting-desc", s.connModelsDesc),
      modelList,
      modelFoot,
    );

    const priceRow = el("div", "mcp-actions");
    const priceInput = sText({ value: entry.price.input, placeholder: `${s.connPriceInput} $/M`, mono: true });
    priceInput.setAttribute("aria-label", `${s.connPrice} · ${s.connPriceInput}`);
    const priceOutputInput = sText({
      value: entry.price.output,
      placeholder: `${s.connPriceOutput} $/M`,
      mono: true,
    });
    priceOutputInput.setAttribute("aria-label", `${s.connPrice} · ${s.connPriceOutput}`);
    const priceCachedInput = sText({
      value: entry.price.cachedInput,
      placeholder: `${s.connPriceCached} $/M`,
      mono: true,
    });
    priceCachedInput.setAttribute("aria-label", `${s.connPrice} · ${s.connPriceCached}`);
    priceRow.append(priceInput, priceOutputInput, priceCachedInput);

    const priceGroup = el("section", "setting-group");
    priceGroup.append(
      el("h3", "setting-group-title", s.connPrice),
      el("p", "setting-desc", s.connPriceDesc),
      priceRow,
    );

    // A rejected value has to say so where the field is, not in a notice that
    // scrolls away from the control at fault.
    const problem = el("p", "setting-note pack-problem", "");
    problem.hidden = true;

    node.append(
      head,
      sRow({ label: s.name, desc: s.connNameDesc, control: nameInput }),
      sRow({ label: s.baseUrl, desc: s.baseUrlDesc, control: baseUrlInput }),
      sRow({ label: s.connApiKeyEnv, desc: s.connApiKeyEnvDesc, control: apiKeyEnvInput }),
      modelsGroup,
      priceGroup,
      problem,
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
        const contextWindow = positiveIntOrNull(handle.contextInput.value);
        if (contextWindow === null) return { problem: s.connCountInvalid, field: handle.contextInput };
        const maxOutput = positiveIntOrNull(handle.maxOutputInput.value);
        if (maxOutput === null) return { problem: s.connCountInvalid, field: handle.maxOutputInput };
        models[id] = { contextWindow, maxOutput };
      }

      const price = {};
      for (const [key, input] of [
        ["input", priceInput],
        ["output", priceOutputInput],
        ["cachedInput", priceCachedInput],
      ]) {
        const text = input.value.trim();
        if (text === "") continue;
        const value = Number(text);
        if (!Number.isFinite(value) || value < 0) return { problem: s.connPriceInvalid, field: input };
        price[key] = value;
      }
      // The schema requires input and output together; a lone cachedInput or a
      // lone output would be dropped by the parser, so it is refused here.
      if (Object.keys(price).length > 0 && (price.input === undefined || price.output === undefined)) {
        return { problem: s.connPriceIncomplete, field: price.input === undefined ? priceInput : priceOutputInput };
      }

      const apiKeyEnv = apiKeyEnvInput.value.trim();
      return {
        name,
        value: {
          protocol: entry.protocol,
          baseUrl,
          ...(apiKeyEnv === "" ? {} : { apiKeyEnv }),
          models,
          ...entry.extra,
          ...(price.input === undefined
            ? {}
            : {
                pricePerMillion: {
                  input: price.input,
                  output: price.output,
                  ...(price.cachedInput === undefined ? {} : { cachedInput: price.cachedInput }),
                },
              }),
        },
      };
    };

    return {
      node,
      nameInput,
      baseUrlInput,
      read,
      clearProblem: () => {
        problem.hidden = true;
        problem.textContent = "";
      },
      showProblem: (message, field) => {
        problem.textContent = message;
        problem.hidden = false;
        field?.focus();
      },
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
    }
    // The draft stays dirty until the host answers with a fresh snapshot; a
    // save that fails sends a notice and no snapshot, so the draft survives.
    connectionSavePending = true;
    connectionSavedSeq = connectionEditSeq;
    api.send({ cmd: "saveProviders", providers: next });
  };

  for (const [name, provider] of Object.entries(config)) addCard(entryFrom(name, provider));

  const foot = el("div", "settings-form-actions");
  foot.append(
    savedNote,
    unsavedNote,
    sButton(
      s.connAddProvider,
      () => {
        const card = addCard(blankEntry());
        markDirty();
        card.nameInput.focus();
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
        savePermissions({ rules: permissions.rules.filter((_, position) => position !== index) });
        drawRules();
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

  /* ---------- run limits ---------- */

  // Each numeric limit is positive-or-empty; empty means "no limit" and is
  // sent as null, which the host passes to the kernel as "unset".
  const positiveOrNull = (value) => {
    const text = String(value).trim();
    if (text === "") return { value: null };
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return { value: parsed };
  };

  const runRefusal = refusal();
  const promptArea = document.createElement("textarea");
  promptArea.className = "setting-textarea";
  promptArea.id = "setting-system-prompt";
  promptArea.rows = 6;
  promptArea.spellcheck = false;
  promptArea.placeholder = s.behaviorSystemPromptPlaceholder;
  promptArea.value = run.systemPrompt ?? "";
  // Text commits on blur, like every other text control in this dialog: a save
  // per keystroke would rewrite run.json while the sentence is still forming.
  promptArea.addEventListener("change", () => saveRun({ systemPrompt: promptArea.value }));

  const maxTurnsInput = sText({
    id: "setting-max-turns",
    type: "number",
    min: 1,
    step: 1,
    value: run.maxTurns,
    onChange: (value) => {
      const parsed = Number(String(value).trim());
      // The kernel stops the loop *before* turn one when this is 0, so a zero
      // here reads as "the agent does nothing" rather than "unlimited".
      if (!Number.isInteger(parsed) || parsed <= 0) {
        runRefusal.show(s.behaviorMaxTurnsInvalid, maxTurnsInput, run.maxTurns);
        return;
      }
      saveRun({ maxTurns: parsed });
    },
  });
  const maxCostInput = sText({
    id: "setting-max-cost",
    type: "number",
    min: 0,
    step: 0.01,
    value: run.maxCostUsd ?? "",
    placeholder: s.behaviorUnlimited,
    onChange: (value) => {
      const parsed = positiveOrNull(value);
      if (parsed === undefined) {
        runRefusal.show(s.behaviorMaxCostInvalid, maxCostInput, run.maxCostUsd ?? "");
        return;
      }
      saveRun({ maxCostUsd: parsed.value });
    },
  });
  const runTimeoutInput = sText({
    id: "setting-run-timeout",
    type: "number",
    min: 1,
    step: 1000,
    value: run.timeoutMs ?? "",
    placeholder: s.behaviorUnlimited,
    onChange: (value) => {
      const parsed = positiveOrNull(value);
      if (parsed === undefined) {
        runRefusal.show(s.behaviorRunTimeoutInvalid, runTimeoutInput, run.timeoutMs ?? "");
        return;
      }
      saveRun({ timeoutMs: parsed.value });
    },
  });

  pane.appendChild(
    sGroup(s.groupRunLimits, [
      sRow({
        id: "setting-max-turns",
        label: s.behaviorMaxTurns,
        desc: s.behaviorMaxTurnsDesc,
        control: maxTurnsInput,
      }),
      sRow({
        id: "setting-max-cost",
        label: s.behaviorMaxCost,
        desc: s.behaviorMaxCostDesc,
        control: maxCostInput,
      }),
      sRow({
        id: "setting-run-timeout",
        label: s.behaviorRunTimeout,
        desc: s.behaviorRunTimeoutDesc,
        control: runTimeoutInput,
      }),
      sRow({
        id: "setting-system-prompt",
        label: s.behaviorSystemPrompt,
        desc: s.behaviorSystemPromptDesc,
        control: promptArea,
        wide: true,
      }),
      runRefusal.node,
    ]),
  );

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
      sRow({
        label: s.branchPrefix,
        desc: s.branchPrefixDesc,
        control: sText({
          value: state.branchPrefix ?? "prometheus/",
          mono: true,
          placeholder: "prometheus/",
          onChange: (value) => applyPref("branchPrefix", value),
        }),
      }),
      sRow({
        label: s.worktreeLocation,
        desc: s.worktreeLocationDesc,
        control: el("code", "setting-code", "<repo>/.prometheus/worktrees"),
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
  const list = el("div", "mcp-list");
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
      const row = el("div", "mcp-row");
      const main = el("div", "mcp-main");
      const title = el("div", "mcp-title");
      title.appendChild(el("strong", "", server.name));
      if (server.disabled) title.appendChild(el("span", "mcp-scope disabled", s.disabled));
      main.appendChild(title);
      main.appendChild(
        el("code", "mcp-command", [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")),
      );
      const meta = [server.cwd, server.timeoutMs ? `${server.timeoutMs} ms` : ""].filter(Boolean).join(" · ");
      if (meta) main.appendChild(el("span", "setting-desc", meta));

      const actions = el("div", "mcp-actions");
      actions.appendChild(
        sToggle({
          checked: !server.disabled,
          onChange: (value) => {
            api.send({ cmd: "saveMcpServer", server: payloadOf(server, !value) });
          },
        }),
      );
      actions.appendChild(
        sButton(
          s.edit,
          () => {
            mcpEditing = server.name;
            render();
          },
          { quiet: true },
        ),
      );
      actions.appendChild(
        sButton(s.remove, () => api.send({ cmd: "removeMcpServer", name: server.name }), {
          quiet: true,
          danger: true,
        }),
      );
      row.append(main, actions);
      list.appendChild(row);
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

function buildSkillsPage() {
  const s = S();
  const pane = sPage(s.pageSkills, s.pageSkillsDesc);
  const body = el("div", "skills-body");
  pane.appendChild(body);

  const render = () => {
    body.innerHTML = "";
    const search = el("input", "setting-input skill-search");
    search.type = "search";
    search.placeholder = s.searchSkills;
    const list = el("div", "skills-list");
    const draw = () => {
      const query = search.value.trim().toLowerCase();
      list.innerHTML = "";
      const matches = state.skills.filter(
        (skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query),
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
        const actions = el("div", "mcp-actions");
        actions.appendChild(sButton(s.edit, () => openForm(skill), { quiet: true }));
        actions.appendChild(
          sButton(s.remove, () => api.send({ cmd: "removeSkill", scope: skill.scope, name: skill.name }), {
            quiet: true,
            danger: true,
          }),
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
        api.send({
          cmd: "saveSkill",
          skill: {
            name: name.value.trim(),
            description: description.value.trim(),
            argumentHint: hint.value.trim(),
            scope: scope.value,
            body: bodyArea.value,
          },
        });
        form.remove();
      }, { primary: true }),
    );
    form.appendChild(actions);
    body.prepend(form);
    name.focus();
  };

  state.renderSkillsPage = render;
  render();
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
          sButton(s.remove, () => api.send({ cmd: "deleteMemory", scope: section.key, name: entry.name }), {
            quiet: true,
            danger: true,
          }),
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
  // 顺序即优先级：本机有什么、装了什么、还能装什么。用户打开这一页问的
  // 就是这三个问题，按这个顺序回答。
  const detectedBox = el("section", "setting-group");
  const summary = el("div", "pack-summary");
  pane.appendChild(detectedBox);
  pane.appendChild(summary);

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

        // 来源：PATH、安装目录、还是 Prometheus 装的 pack。用户在排查
        // "为什么用的是旧版本"时，这一列就是答案。
        if (tool?.source) row.appendChild(el("span", "tc-source", s.tcSource?.[tool.source] ?? tool.source));

        // 未安装的工具若正好在可安装目录里，就在这里给一个入口 ——
        // 用户看到"未安装"的下一个念头就是"那怎么装"，不该让他滚到页面
        // 底部再自己把名字对上。
        if (!tool) {
          const entry = availableEntryFor(kind);
          if (entry) {
            const install = sButton(s.packInstall, () => api.send({ cmd: "installPack", id: entry.id }), { quiet: true });
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

    // 根目录与占用：这是"别把文件系统搞乱"这个问题最直接的回答。
    summary.innerHTML = "";
    summary.appendChild(el("code", "pack-root", packs.root));
    summary.appendChild(
      el(
        "span",
        "pack-usage",
        `${s.packUsed} ${formatBytes(packs.totalBytes)}${packs.freeBytes ? ` · ${s.packFree} ${formatBytes(packs.freeBytes)}` : ""}`,
      ),
    );

    if (packs.packs.length === 0) {
      const empty = el("div", "settings-empty-card");
      empty.appendChild(el("h3", "", s.packEmptyTitle));
      empty.appendChild(el("p", "", s.packEmptyBody));
      list.appendChild(empty);
    } else {
      // 清理只删「本应用创建且已经过期」的目录：中断留下的半截下载，
      // 和删了一半的旧版本。它不会碰任何已安装的包，所以可以放在这里
      // 让用户随时点，而不必等启动时那一次自动清理。
      const tools = el("div", "pack-housekeeping");
      tools.appendChild(sButton(s.packPrune, () => api.send({ cmd: "prunePacks" }), { quiet: true }));
      list.appendChild(tools);
    }

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
      actions.appendChild(sButton(s.packVerify, () => api.send({ cmd: "verifyPack", id: pack.manifest.id }), { quiet: true }));

      // 删除要两次点击：一个 pack 是一 GB，误删的代价是重新下载十分钟。
      // 确认状态放在 `state` 上而不是闭包里 —— `render()` 会重建整个列表，
      // 闭包里的 armed 会跟着旧按钮一起消失，用户第二次点的是新按钮，
      // 于是永远要求"再点一次"。
      const remove = sButton(s.packRemove, () => {
        if (state.packRemoveArmed !== pack.manifest.id) {
          state.packRemoveArmed = pack.manifest.id;
          render();
          setTimeout(() => {
            if (state.packRemoveArmed === pack.manifest.id) {
              state.packRemoveArmed = null;
              render();
            }
          }, 4000);
          return;
        }
        state.packRemoveArmed = null;
        api.send({ cmd: "removePack", id: pack.manifest.id });
      }, { quiet: true, danger: true });
      if (state.packRemoveArmed === pack.manifest.id) {
        remove.textContent = s.packRemoveConfirm;
        remove.classList.add("danger");
      }
      actions.appendChild(remove);

      row.append(main, actions);
      list.appendChild(row);
    }

    // 可安装的条目。已经装过的那个不再列出来 —— 同一份东西出现在
    // "已安装"和"可安装"两处，用户只会读成"还能再装一次"。
    const installedIds = new Set((packs.packs ?? []).map((pack) => pack.manifest.id));
    const available = (state.packCatalog ?? []).filter((entry) => !installedIds.has(entry.id) && entry.installable);
    if (available.length) {
      const group = el("section", "setting-group");
      group.appendChild(el("h3", "setting-group-title", s.packAvailable));
      for (const entry of available) {
        const row = el("div", "pack-row pack-available");
        const main = el("div", "pack-main");
        const title = el("div", "pack-title");
        title.appendChild(el("strong", "", entry.name));
        title.appendChild(el("span", "pack-version", entry.version));
        main.appendChild(title);
        main.appendChild(el("div", "pack-meta", `${formatBytes(entry.downloadBytes)} · ${entry.provides.join(", ")}`));

        const actions = el("div", "pack-actions");
        actions.appendChild(sButton(s.packInstall, () => api.send({ cmd: "installPack", id: entry.id }), { primary: true }));
        row.append(main, actions);
        group.appendChild(row);
      }
      list.appendChild(group);
    } else {
      // 没有可安装项时不安静地留白：用户会以为页面坏了。真实原因有两种,
      // 都要说清楚 —— 已经装完了，或者目录里还没有通过校验的条目。
      const pending = (state.packCatalog ?? []).filter((entry) => !entry.installable && !installedIds.has(entry.id));
      const note = el("p", "setting-note pack-none");
      note.textContent = pending.length ? s.packNonePending : s.packNoneInstalled;
      list.appendChild(note);
    }

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
    list.appendChild(offline);
  };

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

  pane.appendChild(
    sGroup(s.groupCustomize, [
      // A file path, not a setting: repeating the page description under it
      // said nothing about the file.
      sRow({ label: status.file || ".prometheus/hooks.json", desc: "", control: stateRow, wide: true, mono: true }),
      sRow({ label: s.hookState, desc: s.hookReview, control: actions, wide: true }),
    ]),
  );

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

function buildAboutPage() {  const s = S();
  const pane = sPage(s.pageAbout, s.pageAboutDesc);
  const row = el("section", "about-row");
  row.appendChild(el("span", "about-version", `Prometheus ${state.appVersion ?? ""}`));
  const check = sButton(t.checkUpdate, async () => {
    const note = $("update-note");
    note.textContent = t.updateChecking;
    const result = await api.checkUpdate();
    if (!result || result.status === "unconfigured") note.textContent = t.updateUnconfigured;
    else if (result.status === "error") note.textContent = `${t.updateError} ${result.message ?? ""}`;
    else if (result.status === "available") {
      note.textContent = `${t.updateAvailable} ${result.latest}`;
      if (result.url) note.appendChild(sButton(t.updateOpen, () => api.openExternal(result.url), { quiet: true }));
    } else note.textContent = t.updateCurrent;
  });
  row.appendChild(check);
  pane.appendChild(row);
  const note = el("div", "settings-hint", "");
  note.id = "update-note";
  pane.appendChild(note);
  pane.appendChild(
    sGroup(s.groupData, [
      sRow({
        label: s.dataFolder,
        desc: s.dataFolderDesc,
        control: el("code", "setting-code", "~/.prometheus"),
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
  // the Connection pane, so a draft from a previous visit is already gone from
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
  // Leaving the Connection page abandons its draft (that page has a Save step,
  // so a draft left behind would be work the user can no longer see or reach),
  // and the first-run hint belongs to that visit, not to the next.
  if (page.id !== "connection") {
    connectionSetupHint = false;
    connectionDirty = false;
    connectionShowSaved = false;
    connectionSavedSeq = -1;
  }
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    const active = button.dataset.settingsTab === page.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  const panes = $("settings-panes");
  panes.innerHTML = "";
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
 * Search filters the rows on the current page and, when nothing on this page
 * matches, points at the pages that do. A settings page without search makes
 * the user guess which tab hides the control they want.
 */
function applySettingsSearch() {
  const query = state.settingsQuery;
  const panes = $("settings-panes");
  const empty = $("settings-empty");
  if (!query) {
    panes.querySelectorAll(".setting-row, .setting-group, .settings-page").forEach((node) => {
      node.hidden = false;
    });
    if (empty) empty.hidden = true;
    return;
  }
  let visible = 0;
  panes.querySelectorAll(".setting-row").forEach((row) => {
    const match = (row.dataset.search ?? "").includes(query);
    row.hidden = !match;
    if (match) visible++;
  });
  panes.querySelectorAll(".setting-group").forEach((group) => {
    group.hidden = ![...group.querySelectorAll(".setting-row")].some((row) => !row.hidden);
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
  openSettings("connection");
  setTimeout(() => {
    const hint = $("models-hint");
    if (hint) {
      hint.textContent = t.setupHint;
      hint.hidden = false;
    }
    $("setting-base-url")?.focus();
  }, 80);
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
  if (settings.branchPrefix !== undefined) state.branchPrefix = settings.branchPrefix;
  if (settings.outputStyle !== undefined) state.outputStyle = settings.outputStyle;
  if (settings.archiveAfterDays !== undefined) state.archiveAfterDays = settings.archiveAfterDays;
  if (settings.sandbox !== undefined) state.sandbox = settings.sandbox === "off" ? "off" : "enforce";
  // The WSL answer arrives with the settings payload so the row can state the
  // truth ("Ubuntu is available") instead of offering a switch with no visible
  // effect.
  state.kernelSandbox = settings.kernelSandboxState ?? state.kernelSandbox ?? null;
  setMode(state.mode);
  // The Connection page holds a draft, and every other page saves on change —
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
      case "usage_summary":
        state.usageSummary = message.summary;
        state.renderUsagePage?.();
        break;
      case "skills":
        state.skills = message.skills ?? [];
        state.renderSkillsPage?.();
        break;
      case "memory":
        state.memory = { global: message.global ?? [], project: message.project ?? [] };
        state.renderMemoryPage?.();
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

