/** Embedded AI Master desktop renderer. */

import { detectLocale, getDict } from "./i18n.js";
import { contextReport, expandSkill, mergeCommands, parseSlashText } from "./commands.js";
import { escapeHtml, renderMarkdown, IncrementalRenderer } from "./markdown.js";
import { createSettings } from "./settings.js";
import { icon, setIcon } from "./icons.js";
import { planSummary } from "./plan-summary.js";
import { elapsedClock, subagentName, subagentOverflow } from "./subagent-strip.js";
import { providerMark } from "./provider-presets.js";
import { providerRailRows, readProviderMeta } from "./provider-meta.js";
import { VENDOR_MARKS } from "./vendor-marks.js";
import { nextThinkingExpanded, normalizeTranscriptView, thinkingExpandedOnEnd } from "./thinking-view.js";

/** Saved preferences are restored here; the host gets them on init. */
const savedLocale = localStorage.getItem("prometheus.locale");
const savedTheme = localStorage.getItem("prometheus.theme");
const savedDensity = localStorage.getItem("prometheus.density");
const savedWorkbench = localStorage.getItem("prometheus.workbench");

const api = window.prometheus;

const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const input = $("input");
const sendButton = $("send-button");
const stopButton = $("stop-button");
const composerLock = $("composer-lock");
const composerLockText = $("composer-lock-text");
const statusDot = $("status-dot");
const statusText = $("status-text");
const modeControl = $("mode-control");
const effortControl = $("effort-control");
const modelPicker = $("model-picker");
const modelMenu = $("model-menu");
const modelLabel = $("model-label");
const pendingPermission = $("pending-permission");
const pendingQuestion = $("pending-question");
const sessionList = $("session-list");
const planStrip = $("plan-strip");
const planStripToggle = $("plan-strip-toggle");
const planStripCount = $("plan-strip-count");
const planStripCurrent = $("plan-strip-current");
const planStripList = $("plan-strip-items");
const subagentStrip = $("subagent-strip");
const subagentStripToggle = $("subagent-strip-toggle");
const subagentStripCount = $("subagent-strip-count");
const subagentStripCurrent = $("subagent-strip-current");
const subagentStripList = $("subagent-strip-items");
const readonlyBanner = $("readonly-banner");
const readonlyText = $("readonly-text");
const readonlyBack = $("readonly-back");

const workbench = $("workbench");
const workbenchTabs = $("workbench-tabs");
const workbenchMeta = $("workbench-meta");
const diffFilelist = $("diff-filelist");
const diffRoot = $("diff-root");
const fileRoot = $("file-root");
const changesList = $("changes-list");
const changesSummary = $("changes-summary");
const terminalRoot = $("terminal-root");
const terminalOutput = $("terminal-output");
const terminalInput = $("terminal-input");
const terminalPrompt = $("terminal-prompt");

const state = {
  busy: false,
  mode: "ask",
  effort: "auto",
  effortChoices: { levels: [], default: "", fixed: "" },
  model: "",
  models: [],
  modelsSource: "",
  modelsError: "",
  providers: [],
  sessionId: "",
  sessions: [],
  /** How many sessions exist and how many are loaded; see the "show more" row. */
  sessionsTotal: 0,
  sessionsLimit: 80,
  /** Host-side search results while a query is active; null means show the list. */
  sessionMatches: null,
  locale: savedLocale === "zh" || savedLocale === "en" ? savedLocale : detectLocale(),
  theme: savedTheme || "dark",
  density: savedDensity === "compact" || savedDensity === "detailed" ? savedDensity : "balanced",
  statusKey: "statusStarting",
  currentAssistant: null,
  currentThinking: null,
  currentTool: null,
  lastToolNode: null,
  /** The live "working" line at the bottom of the transcript, while a turn runs. */
  progress: null,
  pendingPermissionId: null,
  changedFiles: [],
  changes: { files: [], additions: 0, deletions: 0 },
  selectedChange: null,
  selectedFile: null,
  /** Pending "the preview never arrived" timeout; cleared on the reply. */
  fileLoadTimer: null,
  /** The same, for an artifact preview opened from a tool row. */
  artifactLoadTimer: null,
  cwd: "",
  /**
   * Occupancy of the current transcript, or null when nothing measured it.
   * Null is "unknown", never "empty": the chip stays hidden rather than
   * painting a 0% the kernel never reported (R3).
   */
  context: null,
  /**
   * The kernel's per-category split of `context`, or null when it reported
   * none. Null is "not measured", never "all zero": the popover draws the
   * total without a chart rather than a bar of fabricated slices (R3).
   */
  contextBreakdown: null,
  /** The active model's window, drawn next to its name in the bottom bar. */
  contextWindow: 0,
  sandbox: "enforce",
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  /**
   * Session spend in USD as the kernel reported it, or null when it reported
   * no price. Null is "unknown", never "free": the popover hides the row.
   */
  costUsd: null,
  /** Explicit project fold states; anything not listed follows the active-project default. */
  expandedProjects: new Set(JSON.parse(localStorage.getItem("prometheus.expandedProjects") || "[]")),
  collapsedProjects: new Set(JSON.parse(localStorage.getItem("prometheus.collapsedProjects") || "[]")),
  workbenchOpen: savedWorkbench === "1",
  // Serial is the only pane with a kernel backend that is reachable by
  // browsing; the other panes' markup is still in the document (their tabs are
  // not), and they are opened by an action instead. So serial is both the
  // default and the only pane the strip can start on.
  pane: "serial",
  git: null,
  /**
   * Which provider the model panel's rail currently shows. A view filter over
   * the model list, not a selection: it resets to the provider of the model in
   * use whenever that name is no longer in the list (a `models` event, an
   * endpoint switch), so the panel never opens onto an empty column.
   */
  modelRailProvider: null,
  artifacts: [],
  selectedArtifact: null,
  /**
   * Whether the transcript shows only tool output the kernel marked as
   * evidence. Renderer-local state: it filters what is drawn, it is not a host
   * preference, and it is not persisted — a restart opens on the full
   * transcript, which is the thing the filter is a view of.
   */
  evidenceOnly: false,
  /**
   * The subagents running right now: `id → { label, startedAt }`.
   *
   * Named for the strip, not after the feature: the old goals / subagents /
   * checkpoints UI (D-185) owned a handful of renderer symbols that a test
   * forbids by name, precisely so a revert cannot quietly resurrect those
   * cards. This map feeds the strip above the composer and nothing else, and
   * it is emptied by `newSession` and by `session_loaded` — a run belongs to
   * the session that started it.
   */
  liveSubagents: new Map(),
  /**
   * The subagent whose log is on screen, or null. `{ parentId, childId }`.
   *
   * Mirrors the host's `readonlySession`, which is also what refuses a prompt:
   * this copy exists so the composer can be disabled and the banner drawn
   * before the round trip. Never inferred — only `session_loaded` sets it,
   * from the field the host attaches to a `loadSubagent` answer.
   */
  readonly: null,
  /**
   * The last update state the main process reported, or null before the first
   * answer. Kept here so the About page can draw immediately when it is built,
   * and so an `update_status` that arrives while Settings is closed is not
   * lost — the page is rebuilt on every visit.
   */
  updateStatus: null,
  /** The version whose "available" banner was already announced, if any. */
  updateAnnounced: "",
  sessionQuery: "",
  showArchived: false,
  /** Sidebar filter: all | working | needs-input | error | cwd. */
  sessionFilter: "all",
  comments: [],
  attachments: [],
  /**
   * Paths picked by folder/file dialogs and drops. They are not uploaded: the
   * next message carries them as a path list (see submit()), then the list is
   * cleared. @-mentions typed into the text are already in the text itself.
   */
  mentionFiles: [],
  pr: null,
  commands: [],
  /**
   * The skill library as the host last sent it, bodies included.
   *
   * `commands` only carries a skill's name and blurb; the prompt being
   * expanded is here, from the `skills` event. A skill command typed before
   * that event arrives has no body yet, and says so rather than sending an
   * empty prompt (R3).
   *
   * The settings module reads the same field for its page — it was already
   * initialised there, because this object is the one both modules share. The
   * write below happens in the renderer's event switch, so it is current even
   * when Settings was never opened.
   */
  skills: [],
  diffScope: "session",
  /** The serial monitor is renderer-local except for the stream itself. */
  serialPorts: [],
  serial: {
    open: false,
    port: null,
    baud: null,
    /**
     * What the dropdowns show while the port is closed. `port`/`baud` describe
     * an open session (the host is the authority); these hold the operator's
     * pick so re-enumerating the port list does not reset it. They live here
     * because the Board pane's saved selection used to carry this role.
     */
    selectedPort: "",
    selectedBaud: 0,
    /** Pausing stops DOM updates; data keeps arriving in the host's ring. */
    paused: false,
    pausedBacklog: 0,
    filter: "all",
    /** Receive display mode: text | hex (the HTerm-style dual view). */
    view: "text",
    follow: true,
    lines: [],
    /** Lines the host could not keep up with, since the last clear. */
    dropped: 0,
    /**
     * Lines evicted by this pane's own `SERIAL_MAX_LINES` cap (OPT-37 ①).
     *
     * Separate from `dropped` on purpose: the host counts what never left its
     * ring, and has no way to know the renderer also trims. Folding the two
     * into one number would make the status line wrong in both directions
     * whenever only one side trimmed.
     */
    droppedLocal: 0,
    /** Lines the current filter hides, recomputed on each render. */
    filtered: 0,
    /** Why the port closed or failed to open, shown in the status row. */
    lastError: "",
  },
};

let t = getDict(state.locale);

/* ---------- localization ---------- */

/**
 * Rebuilds the open Settings page after a language change, or does nothing.
 *
 * Settings assembles its pages from `settingsStrings` at build time and gives
 * none of that text a `data-i18n` attribute, so the sweep below cannot reach
 * it. The page has to be rebuilt instead, which is why this is a hook rather
 * than part of `applyLocale`: it only exists once the settings module has been
 * constructed at the bottom of this file.
 */
let applySettingsLocale = () => {};

/**
 * Repaint the caption button that depends on the window's state, or nothing.
 *
 * The maximize/restore caption is the one control whose name is not a fixed
 * dictionary entry: the same button is "Maximize" in one state and "Restore"
 * in the other. The `[data-i18n-title]` sweep below would paint the resting
 * name over a maximized window, so the live state has to be re-applied after
 * it. Assigned once the window-controls block runs, long before any locale
 * switch.
 */
let applyWindowState = () => {};

/**
 * Does this element carry a name of its own in visible text?
 *
 * A control that shows words is already named by them, and an `aria-label`
 * would replace that name rather than complete it. A readout does not count:
 * `—`, `0`, `1/2` are figures, not names, so an icon-only button that happens
 * to print one still needs a label. `innerText` (not `textContent`) is the
 * right read here — it skips the `[hidden]` badge inside the changes button,
 * which `textContent` would have counted as the text "0".
 */
function hasVisibleName(node) {
  return /\p{L}/u.test(node.innerText ?? "");
}

/**
 * Paint an icon-only control's tooltip, and name it with the same string.
 *
 * Most of these strings come from `[data-i18n-title]` and are swept below, but
 * a few change at runtime (a paused serial port, a maximized window, the
 * current session filter), and those used to move the tooltip while leaving
 * the accessible name behind on the old value. One helper keeps the two in
 * step. `aria-labelledby` already names the element, and a `<label>` is named
 * by the text it wraps; neither is touched.
 */
function setControlTitle(node, text) {
  // A key with no entry in this dictionary leaves the element as it was: one
  // language missing a string must not blank the tooltip in the other.
  if (!node || typeof text !== "string") return;
  node.title = text;
  const named = node.hasAttribute("aria-labelledby") || (node.tagName === "LABEL" && hasVisibleName(node));
  if (named) return;
  if (String(text ?? "").trim() === "") node.removeAttribute("aria-label");
  else if (!hasVisibleName(node)) node.setAttribute("aria-label", text);
}

function applyLocale(locale, { announce = false } = {}) {
  state.locale = locale;
  t = getDict(locale);
  localStorage.setItem("prometheus.locale", locale);
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const value = t[node.dataset.i18n];
    if (typeof value === "string") node.textContent = value;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => setControlTitle(node, t[node.dataset.i18nTitle]));
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    const value = t[node.dataset.i18nPlaceholder];
    if (typeof value === "string") node.placeholder = value;
  });
  input.placeholder = t.placeholder;
  terminalInput.placeholder = terminalInput.disabled ? t.terminalExited : t.terminalPlaceholder;
  $("terminal-restart").textContent = t.terminalRestart;
  const terminalTab = workbenchTabs.querySelector('[data-pane="terminal"]');
  if (terminalTab) terminalTab.textContent = t.paneTerminal;
  setControlTitle(sendButton, t.sendTitle);
  setControlTitle(stopButton, t.stopTitle);
  // The sidebar workspace entry is written by renderTopbarLocation, and its
  // "no folder" text and tooltip are language-dependent, so redraw it here
  // after `t` has been swapped. This runs before the title assignment below
  // so the top bar keeps the tooltip it had.
  renderTopbarLocation();
  $("topbar-cwd").title = t.changeFolderTitle;
  $("refresh-sessions").title = t.refresh;
  const search = $("session-search");
  search.placeholder = t.searchSessions;
  // A placeholder is not a name: it disappears as soon as the field has
  // content, and some screen readers skip it. The field gets a real label.
  setControlTitle(search, t.searchSessions);
  $("find-input").placeholder = t.findPlaceholder;
  // No update control lives here: the About page builds its own button on
  // demand, and `#check-update` (looked up here for years) was never in the
  // document. The update state is kept in `state.updateStatus` instead, so a
  // language switch reaches the page through the rebuild `applyLocaleChange`
  // already performs.
  // The chip's tooltip is the model reference, which no dictionary can supply;
  // only the fallback text changes with the language. Assigning
  // `t.refreshModels` unconditionally here used to overwrite the reference
  // with "Refresh model list" on every locale switch, so redraw through the
  // same path that set it. Before the catalogue arrives there is nothing to
  // name — the fallback is then the right answer.
  if (state.models.length > 0) renderModels(state.models, state.model, state.modelsSource, state.modelsError);
  else modelPicker.title = t.refreshModels;
  // The strip's label comes from `data-i18n` and was just swept; its count and
  // step line are derived text with no attribute to sweep, so repaint the
  // whole strip from the list it already holds.
  if (planItems.length > 0) renderPlanStrip(planItems);
  // Same rule for the subagent strip: its count, clock and every row's tooltip
  // are derived text, and the language just changed under them. The list it
  // repaints from is the state map, so nothing has to be remembered here.
  renderSubagentStrip();
  renderReadonlyBanner();
  // The transcript card's title was written into its HTML once, when the card
  // was created, and carries no `data-i18n` — so a language switch left the
  // one heading in the middle of the transcript in the old language while
  // every label around it changed.
  const planTitle = planCard?.querySelector(".plan-title");
  if (planTitle) planTitle.textContent = t.plan;
  // The session list is built from `t` when it renders, so a language change
  // has to rebuild it. An empty workspace still draws a row (its folder and a
  // "no conversations yet" hint), which means "sessions exist" is no longer the
  // same question as "the list has something to relabel".
  if (state.sessions.length > 0 || state.cwd) renderSessions(state.sessions);
  syncMenuControls();
  setStatus(state.statusKey);
  if (state.models.length > 0) renderModelMenu();
  if (announce) api.send({ cmd: "setLocale", locale });
  const message = $("git-message");
  if (message) message.placeholder = t.commitPlaceholder;
  const commitButton = $("git-commit-button");
  if (commitButton) commitButton.textContent = t.commitAll;
  if (state.git) renderGitBar();
  applySettingsLocale();
  // The serial pane assembles its text from `t` when it renders and carries no
  // `data-i18n` on it, so the sweep above cannot reach it.
  if (!workbench.hidden && state.pane === "serial") {
    fillSerialControls();
    renderSerialStatus();
  }
  // The evidence filter's count and its empty note are derived text with no
  // `data-i18n` to sweep; the note's sentence was repainted above, and the
  // visibility rule has to be re-applied so it agrees with the new copy.
  renderEvidenceFilter();
  // The sentence explaining a locked composer is derived text with no
  // `data-i18n` to sweep; repaint it from the state already held.
  renderComposerLock();
  // Last, after the sweep: this caption's name follows the window's state, and
  // the sweep just painted the resting one.
  applyWindowState();
  void announce;
}

function statusLabel(key) {
  return t[key] ?? key;
}

/* ---------- utilities ---------- */

const md = (source) => renderMarkdown(source, t.copy);

/** The element that actually scrolls: the transcript, or its inner column when
 *  the workbench splits the pane. */
function scrollTarget() {
  return transcript;
}

function scrollToBottom(force = false) {
  const target = scrollTarget();
  // One layout read, reused for both decisions. The old shape measured
  // `scrollHeight` here, wrote `scrollTop`, then measured it again inside
  // `updateScrollButton` — twice per rAF while text streamed, on a transcript
  // that grows with every token.
  const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
  const nearBottom = distance < 140;
  const pinned = force || nearBottom;
  if (pinned) target.scrollTop = target.scrollHeight;
  // After a pinned scroll the button is certainly not needed; only an
  // unpinned stream has to look at the distance it already measured.
  setScrollButtonVisible(!pinned && distance > 220);
}

function updateScrollButton() {
  const target = scrollTarget();
  setScrollButtonVisible(target.scrollHeight - target.scrollTop - target.clientHeight > 220);
}

function setScrollButtonVisible(away) {
  const button = $("scroll-bottom");
  if (!button) return;
  if (away) {
    if (!button.hidden) return;
    button.hidden = false;
    // Start from the entering state and drop it next frame so the fade runs;
    // `hidden` is display:none and cannot be transitioned on its own.
    button.classList.add("entering");
    requestAnimationFrame(() => button.classList.remove("entering"));
    return;
  }
  if (button.hidden) return;
  button.hidden = true;
  button.classList.remove("entering", "leaving");
}

/**
 * The slot the empty state lives in.
 *
 * The slot is hidden, not just the card: a hidden child still leaves the
 * slot's own padding standing, which would keep an empty band above the
 * composer long after the first turn.
 */
const emptySlot = $("empty-slot");

function hideEmptyState() {
  if (emptySlot && !emptySlot.hidden) emptySlot.hidden = true;
}

/**
 * Draw the composer's introduction back for a session with no turns.
 *
 * The element is a sibling of the transcript, not a child, so it has to be
 * toggled rather than re-appended: it is not conversation content and must not
 * scroll away with it.
 */
function showEmptyState() {
  if (emptySlot && emptySlot.hidden) emptySlot.hidden = false;
}

function addNode(html, { keepEmptyState = false } = {}) {
  // A notice is the shell talking, not a turn: a startup notice used to hide
  // the introduction on a conversation that was still empty, leaving the first
  // screen with one dim line and no way in. Turns, tool rows and plans are
  // conversation content and do retire it.
  if (!keepEmptyState) hideEmptyState();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const node = wrapper.firstElementChild;
  // Streaming keeps the view pinned to the bottom; inserting a new turn
  // mid-scroll should not yank the reader away.
  const target = scrollTarget();
  const pinned = target.scrollHeight - target.scrollTop - target.clientHeight < 140;
  target.appendChild(node);
  if (pinned) scrollToBottom(true);
  return node;
}

/* ---------- transcript rendering ---------- */

/**
 * The line that shows a turn is still alive.
 *
 * It lives at the bottom of the transcript rather than in the top bar because
 * that is where the reader is already looking: during a minute-long tool call
 * the only thing that changed was an 8 px dot in the corner, which is
 * indistinguishable from a hang.
 *
 * Everything it shows comes from the host's once-a-second heartbeat plus the
 * text already streaming into the renderer, so there is no new protocol and
 * nothing here can claim progress that did not happen.
 */
function ensureProgress() {
  if (state.progress?.node?.isConnected) {
    // A turn that appended content after the line must keep it last, or the
    // live readout ends up above the answer it describes.
    transcript.appendChild(state.progress.node);
    return state.progress;
  }  const node = document.createElement("div");
  node.className = "turn-progress";
  node.innerHTML =
    `<span class="turn-progress-spinner" aria-hidden="true"></span>` +
    `<span class="turn-progress-meta"></span>` +
    `<span class="turn-progress-text"></span>`;
  transcript.appendChild(node);
  state.progress = {
    node,
    text: node.querySelector(".turn-progress-text"),
    meta: node.querySelector(".turn-progress-meta"),
    startedAt: Date.now(),
    tool: "",
    retry: 0,
    outputTokens: 0,
    chars: 0,
  };
  return state.progress;
}

/** Update the visible half of the progress line; called from several events. */
function renderProgress() {
  const progress = state.progress;
  if (!progress) return;
  const seconds = Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000));
  // Minutes read better than 166s for a long tool call.
  const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
  // Output tokens only, and only once the provider has reported some. The
  // input side is the prompt the user already sent; adding it made the number
  // jump by six figures on the first heartbeat and read as a runaway bill.
  // The streamed character count is the pre-usage stand-in because it is the
  // one figure that is measured rather than estimated.
  const parts = [elapsed];
  if (progress.outputTokens > 0) {
    parts.push(`${formatTokens(progress.outputTokens)} ${t.tokens}`);
  } else if (progress.chars > 0) {
    parts.push(`${formatTokens(progress.chars)} ${t.progressChars}`);
  }
  progress.meta.textContent = parts.join(" · ");

  // The second half names what is happening. When a tool is running it is the
  // tool; otherwise the spinner and the growing count already say "working",
  // and a sentence explaining the gateway's batching is noise between the user
  // and their answer.
  progress.text.textContent = progress.tool ? `· ${progress.tool}` : "";
}

function setProgress(update) {
  const progress = ensureProgress();
  if (update.tool !== undefined) progress.tool = String(update.tool ?? "");
  if (update.retry !== undefined) progress.retry = Number(update.retry) || 0;
  if (update.outputTokens !== undefined) progress.outputTokens = Number(update.outputTokens) || 0;
  if (update.chars !== undefined) progress.chars = Number(update.chars) || 0;
  if (update.startedAt) progress.startedAt = update.startedAt;
  startProgressTicker();
  renderProgress();
}

/** Interval that refreshes the progress clock between host heartbeats. */
let progressTimer = 0;

function clearProgress() {
  state.progress?.node?.remove();
  state.progress = null;
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = 0;
  }
}

/**
 * Tick the clock locally between heartbeats.
 *
 * The host's heartbeat is once a second but its arrival is not evenly spaced
 * (it shares a timer with the rest of the host), so a clock driven only by it
 * visibly stutters. The elapsed value here is derived from `startedAt`, which
 * the heartbeat keeps in sync, so the two never disagree.
 */
function startProgressTicker() {
  if (progressTimer) return;
  progressTimer = setInterval(() => {
    if (!state.progress) return;
    renderProgress();
  }, 250);
}

function addUserTurn(text, imageCount = 0) {
  const images = imageCount > 0 ? `<span class="user-images">${t.imageCount(imageCount)}</span>` : "";
  return addNode(
    `<div class="turn user">` +
      `<div class="user-bubble">${escapeHtml(text)}${images}</div>` +
      `</div>`,
  );
}

function addAssistantTurn() {
  const last = transcript.lastElementChild;
  const node = addNode(`<div class="turn assistant"><div class="markdown"></div></div>`);
  if (last && (last.classList.contains("tool-row") || last.classList.contains("tool-group"))) node.classList.add("after-tools");
  const body = node.querySelector(".markdown");
  // The caret is a sibling of the rendered prose, created once. Re-rendering
  // `innerHTML` each frame used to rebuild the caret element too, which
  // restarted its 1 s blink animation every frame — the caret never blinked,
  // it just sat there.
  const caret = document.createElement("span");
  caret.className = "caret";
  body.appendChild(caret);
  state.currentAssistant = { node, body, caret, text: "", raf: 0, renderer: new IncrementalRenderer(t.copy) };
  return state.currentAssistant;
}

function flushAssistant() {
  const current = state.currentAssistant;
  if (!current) return;
  if (current.raf) {
    cancelAnimationFrame(current.raf);
    current.raf = 0;
  }
  const hadText = current.text.trim().length > 0;
  current.body.innerHTML = current.renderer ? current.renderer.render(current.text) : md(current.text);
  current.body.classList.remove("streaming");
  current.caret?.remove();
  state.currentAssistant = null;
  bindCodeCopy(current.node);
  // A turn that produced no prose leaves an empty bubble behind.
  if (!hadText) current.node.remove();
}

/**
 * Render an option's preview next to the buttons.
 *
 * A preview is what the user compares before answering, so it goes above the
 * buttons at full width rather than inside a label that ellipsises it.
 */
function attachPreview(container, text) {
  const pre = document.createElement("pre");
  pre.className = "ask-preview";
  pre.textContent = text;
  container.appendChild(pre);
}

function bindCodeCopy(root) {
  root.querySelectorAll("[data-code]").forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = "1";
    button.addEventListener("click", async () => {
      const code = button.closest("pre").querySelector("code").textContent;
      // 复制可能被拒（权限/窗口失焦）：失败也要有回话，静默的「已复制」
      // 是在撒谎（R3）。按钮状态对读屏可见。
      button.setAttribute("aria-live", "polite");
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = t.copied;
      } catch {
        button.textContent = t.copyFailed;
      }
      setTimeout(() => (button.textContent = t.copy), 1200);
    });
  });
}

/**
 * Human labels for tool ids: the transcript should read as actions.
 *
 * The kernel's file tool is one row per verb as of 2026-10-22 (`fs` was split
 * into `read` / `write` / `edit` / `multiedit`, and `ls` was added). The old
 * single `fs` entry is gone on purpose: a tool the kernel no longer has should
 * not keep a friendly name here, or a stale log would be the only place it
 * shows up looking supported.
 */
const TOOL_LABELS = {
  read: "Read",
  ls: "List",
  write: "Write",
  edit: "Edit",
  multiedit: "Multi-edit",
  shell: "Run",
  glob: "Find files",
  grep: "Search",
  echo: "Echo",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  list_files: "List",
  search_codebase: "Search code",
  bash: "Run",
  todo_write: "Plan",
};

/** `mcp__probe__mem_read` → "probe · mem_read", so an MCP call reads as one. */
function mcpLabel(name) {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!match) return undefined;
  return `${match[1]} · ${match[2].replace(/_/g, " ")}`;
}

function toolLabel(name) {
  return TOOL_LABELS[name] ?? mcpLabel(name) ?? name;
}

/** Consecutive calls belong to one activity block, not a stream of lines. */
function toolGroup() {
  const last = transcript.lastElementChild;
  if (last && last.classList.contains("tool-group")) return last;
  return addNode(`<div class="tool-group"></div>`);
}

/** One icon per kind of work, so a glance down the column reads as a rhythm. */
function toolGlyph(name) {
  if (name === "bash" || name === "shell") return "terminal";
  if (name === "todo_write") return "list-check";
  if (name === "write" || name === "edit" || name === "multiedit") return "edit";
  if (name === "write_file" || name === "edit_file") return "edit";
  if (name === "search_codebase" || name === "grep") return "search";
  if (name === "ls" || name === "glob" || name === "list_files") return "folder";
  if (name === "read" || name === "fs") return "file";
  // The probe and KB servers are the two domain MCPs in this repo; their
  // calls read as hardware and book lookups rather than anonymous rows.
  if (name.startsWith("mcp__probe__")) {
    if (name.includes("mem_read") || name.includes("mem_write") || name.includes("status")) return "sliders";
    if (name.includes("serial")) return "terminal";
    if (name.includes("attach") || name.includes("detach")) return "plug";
    if (name.includes("device")) return "robot";
    return "chart";
  }
  if (name.startsWith("mcp__kb__")) return "book";
  return "file";
}

/**
 * One marker per property the tool declares about itself.
 *
 * Only properties the kernel actually sent are drawn: an absent annotation
 * means "not declared", and drawing a neutral badge for it would claim the
 * tool was checked and found safe. The glyph carries a title, so the meaning
 * is available without a legend.
 */
function toolAnnotationBadges(annotations) {
  if (!annotations || typeof annotations !== "object") return "";
  const badges = [];
  if (annotations.destructive === true) {
    badges.push(
      `<span class="tool-annotation destructive" title="${escapeHtml(t.toolDestructive)}">${icon("alert")}</span>`,
    );
  } else if (annotations.readOnly === true) {
    badges.push(
      `<span class="tool-annotation readonly" title="${escapeHtml(t.toolReadOnly)}">${icon("shield")}</span>`,
    );
  }
  if (annotations.evidence === true) {
    badges.push(
      `<span class="tool-annotation evidence" title="${escapeHtml(t.toolEvidence)}">${icon("check")}</span>`,
    );
  }
  return badges.join("");
}

/**
 * One line under a tool row saying a hook stopped it or did not run.
 *
 * Appended **inside** the row rather than as a sibling: `.tool-row` is a
 * subgrid whose children declare their columns, so a fifth child spanning
 * columns 2..-1 wraps onto a second implicit row of the same box. As a
 * sibling it would be left behind the moment `tool_output` re-parents the row
 * into a `.tool-item`, and the note would end up below the output it does not
 * describe.
 *
 * Idempotent on `data-hook-note`: both `tool_end` and a replayed
 * `session_loaded` describe the same call, and two identical lines under one
 * row would read as two hooks having objected. The text is set through
 * `textContent`, never parsed as markup — a hook's failure sentence quotes a
 * command line the user wrote.
 */
function attachHookNote(row, note) {
  if (row.dataset.hookNote === note) return;
  row.dataset.hookNote = note;
  const line = row.querySelector(".tool-hook-note") ?? document.createElement("div");
  line.className = "tool-hook-note";
  line.textContent = note;
  if (!line.isConnected) row.appendChild(line);
}

function addToolRow(name, summary, annotations, id = "") {
  const row = document.createElement("div");
  row.className = "tool-row running";
  // The call id is what `tool_end` looks the row up by. Read-only calls run
  // concurrently and their results can land in any order; without it the
  // evidence verdict below would be written onto whichever row finished
  // last. Not rendered, not announced.
  if (id !== "") row.dataset.callId = id;
  row.innerHTML =
    `<span class="tool-glyph">${icon(toolGlyph(name))}</span>` +
    // The label gets its own element inside the name cell: the cell lays the
    // label and the annotation badges out in a row, and only the label may
    // elide when a long MCP name meets a narrow pane.
    `<span class="tool-name"><span class="tool-label">${escapeHtml(toolLabel(name))}</span>` +
    toolAnnotationBadges(annotations) +
    `</span>` +
    `<span class="tool-summary">${escapeHtml(summary || "")}</span>` +
    // A chevron, not the word "details": it reads as "there is more here" at
    // a glance and costs no width in a column of many rows. It stays hidden
    // until there is something to open, so a bare `ls` is still one line. The
    // icon points down when closed and rotates a quarter turn when open.
    `<button class="tool-expand" hidden aria-expanded="false" aria-label="${escapeHtml(t.details)}">` +
    `${icon("chevron-down")}</button>`;
  row.dataset.path = summary || "";
  toolGroup().appendChild(row);
  // No filter repaint here: a new row has no verdict yet (the kernel writes
  // `evidence` on the result, not on the start), so the count cannot change.
  // The root class already hides it under an active filter, and `tool_end`
  // repaints once the verdict lands.
  // The summary of a file tool is its path; clicking opens it in the
  // workbench, like clicking a path in an editor's output pane.
  if (FILE_TOOLS.has(name) && summary) {
    row.classList.add("openable");
    row.title = `${t.openFile}: ${summary}`;
    row.addEventListener("click", (event) => {
      if (event.target.closest(".tool-expand")) return;
      openFile(summary);
    });
  }
  state.currentTool = { node: row, name, summary };
  state.lastToolNode = row;
  return row;
}

/* ---------- evidence filter ---------- */

/**
 * Paint the evidence filter's own controls and keep the count honest.
 *
 * The filtering itself is one CSS rule on `html.evidence-only` (see
 * `styles.css`): every row the kernel marked `evidence: true` stays, and so
 * does the output block wrapped around it. Doing it in CSS means there is no
 * DOM walk to keep in sync on every streamed event, and no second place where
 * "is this evidence" is decided.
 *
 * Only `true` survives. A missing attribute is a result the kernel has not
 * judged yet (its row is created at `tool_started`, before the verdict), and
 * `false` is a result that was judged and did not qualify; neither is
 * evidence, and the filter says so by drawing nothing.
 */
function renderEvidenceFilter() {
  document.documentElement.classList.toggle("evidence-only", state.evidenceOnly);
  const button = $("evidence-filter");
  if (button) button.setAttribute("aria-pressed", String(state.evidenceOnly));
  const count = transcript.querySelectorAll('.tool-row[data-evidence="true"]').length;
  const badge = $("evidence-filter-count");
  if (badge) {
    // The count is a fact about the session, not about the filter, so it is
    // shown whether or not the filter is on — that is how a reader learns
    // there is anything to filter before turning it on.
    badge.textContent = count === 0 ? "" : String(count);
    badge.hidden = count === 0;
  }
  const note = $("evidence-empty");
  if (note) note.hidden = !(state.evidenceOnly && count === 0);
}

/* ---------- composer lock ---------- */

/**
 * Close the composer when there is nothing behind it to answer a message, and
 * say why on screen.
 *
 * A disabled input with no sentence reads as a broken window. The note is a
 * sibling of the composer rather than transcript content: rebuilding the
 * transcript must not take the sentence explaining the rebuild with it.
 *
 * One state reaches here today — the read-only subagent record. It used to be
 * two: a replay position could lock the same box (BR-6's scrubber, removed
 * 2026-11-09). The replay half went with the control; this stays because the
 * read-only view still needs a locked, explained composer.
 */
function renderComposerLock() {
  const locked = state.readonly !== null;
  input.disabled = locked;
  if (composerLock) composerLock.hidden = !locked;
  if (composerLockText) composerLockText.textContent = locked ? t.readonlyComposerReason : "";
  if (sendButton) sendButton.disabled = locked;
}

/**
 * Open the output block of every evidence row.
 *
 * The filter says "show me the evidence", and an evidence row whose result is
 * still folded behind a chevron shows only its name and argument summary —
 * the one part of it that is not evidence. Opening them is a side effect of
 * turning the filter on and is left in place when it is turned off: the
 * reader asked to read these results, and collapsing them again would undo
 * the request.
 */
function revealEvidenceOutput() {
  for (const row of transcript.querySelectorAll('.tool-row[data-evidence="true"]')) {
    const output = row.parentElement?.querySelector(":scope > .tool-output");
    if (!output || !output.hidden) continue;
    output.hidden = false;
    const toggle = row.querySelector(".tool-expand");
    if (toggle) {
      toggle.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
    }
    row.classList.add("open");
  }
}

function setEvidenceFilter(on) {
  state.evidenceOnly = Boolean(on);
  if (state.evidenceOnly) revealEvidenceOutput();
  renderEvidenceFilter();
  // What remains after the filter may be above the scroll position the reader
  // was at; landing at the bottom puts them at the newest evidence rather
  // than at blank space.
  if (state.evidenceOnly) scrollToBottom();
}

/**
 * A collapsible diff under a file-write row.
 *
 * The pane's renderer is reused for the lines; only the container is new. It
 * starts collapsed for a large change and open for a small one, because a
 * twenty-line edit is usually worth reading and a four-hundred-line rewrite is
 * not.
 */
function attachInlineDiff(row, change) {
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains("inline-diff")) existing.remove();
  const total = (change.additions ?? 0) + (change.deletions ?? 0);
  if (!total && change.status === "modified") return;

  const box = document.createElement("div");
  box.className = "inline-diff";
  const toggle = document.createElement("button");
  toggle.className = "inline-diff-toggle";
  toggle.innerHTML =
    `<span class="add">+${change.additions ?? 0}</span> <span class="del">−${change.deletions ?? 0}</span>` +
    `<span class="inline-diff-path">${escapeHtml(change.path ?? "")}</span>`;
  toggle.title = t.inlineDiffHint;
  box.appendChild(toggle);

  const body = document.createElement("div");
  body.className = "inline-diff-body";
  body.hidden = total > 60;
  for (const hunk of change.hunks ?? []) decorateWordDiff(hunk.lines);
  for (const hunk of change.hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.kind === "context") continue;
      const node = document.createElement("div");
      node.className = `diff-line ${line.kind}`;
      const marker = line.kind === "add" ? "+" : "−";
      node.innerHTML =
        `<span class="diff-gutter">${String(line.oldNo ?? "").padStart(4)} ${String(line.newNo ?? "").padStart(4)}</span>` +
        `<span class="diff-text">${line.highlights ? lineHtml(line, marker) : escapeHtml(`${marker} ${line.text}`)}</span>`;
      body.appendChild(node);
    }
  }
  box.appendChild(body);
  toggle.setAttribute("aria-expanded", String(!body.hidden));
  toggle.addEventListener("click", () => {
    const opening = body.hidden;
    body.hidden = !body.hidden;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
    if (opening) {
      body.classList.add("entering");
      requestAnimationFrame(() => body.classList.remove("entering"));
    }
  });
  row.after(box);
  state.lastToolNode = null;
}

/**
 * Tools whose argument summary is a path, so the row can open it.
 *
 * The kernel's file tools are a verb each since 2026-10-22; `fs` stays listed
 * because an older session log still carries that name and its rows should
 * keep opening the file they named.
 */
// `ls` is deliberately absent: its summary is a directory, `getFile` refuses
// directories, and a row that looks clickable but always fails is worse than a
// plain row. Everything else here names a file.
const FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "multiedit",
  "fs",
  "read_file",
  "write_file",
  "edit_file",
]);

function lastToolRow() {
  return state.lastToolNode && state.lastToolNode.isConnected ? state.lastToolNode : null;
}

/**
 * The two actions a tool result whose full text was written to disk offers.
 *
 * They live inside the `<pre>` that holds the output, so they open and close
 * with the details block instead of floating above a collapsed row.
 *
 *   - "show in file manager" goes through the preload's `revealArtifact`:
 *     the renderer cannot open a `file://` URL itself (Electron blocks it),
 *     and a window that has no file manager answers with a notice, which is
 *     the honest degradation.
 *   - "preview in the panel" opens the artifact pane on this file. The pane
 *     asks the host for the file by path (`getArtifact`), so the preview is
 *     the kernel's own read, not a second copy of the text that is already in
 *     the transcript.
 */
function attachArtifactLink(container, artifactPath) {
  // The details arrive after the block is built (and a later `tool_output`
  // reuses it), so existing buttons are updated rather than stacked.
  const existing = container.querySelector(".artifact-open");
  if (existing) {
    existing.dataset.path = artifactPath;
    existing.title = `${t.artifactRevealHint} ${artifactPath}`;
    const preview = container.querySelector(".artifact-preview");
    if (preview) preview.dataset.path = artifactPath;
    return existing;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-quiet small artifact-open";
  button.dataset.path = artifactPath;
  button.textContent = t.artifactOpen;
  button.title = `${t.artifactRevealHint} ${artifactPath}`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = button.dataset.path;
    // The preload is the only route that can actually select the file in a
    // window. Without it the command goes to the host, which answers with a
    // notice naming the path: a notice is honest, while a `file://` anchor
    // would be blocked and look like a broken button.
    if (typeof api.revealArtifact === "function") {
      void api.revealArtifact(target);
      return;
    }
    api.send({ cmd: "revealArtifact", path: target });
  });
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "btn btn-quiet small artifact-preview";
  preview.dataset.path = artifactPath;
  preview.textContent = t.artifactPreview;
  preview.title = `${t.artifactPreviewHint} ${artifactPath}`;
  preview.addEventListener("click", (event) => {
    event.stopPropagation();
    previewArtifact(preview.dataset.path);
  });
  // A leading newline puts the buttons on their own line at the end of the
  // output; the container is a `<pre>` with pre-wrap, so without it they
  // would sit on the same line as the last line of text.
  container.append("\n", button, " ", preview);
  return button;
}

/**
 * Open one artifact in the workbench pane, by path.
 *
 * This is the second way into the artifact pane (the ⋯ menu is the first).
 * It does not wait for the list: `getArtifact` answers with the file itself,
 * and `renderArtifact` opens the pane and reveals the tab on the way through.
 */
function previewArtifact(path) {
  if (typeof path !== "string" || path === "") return;
  state.selectedArtifact = path;
  // The answer is a host round trip; say so in the pane instead of showing
  // the previous artifact while the new one loads.
  openWorkbench("artifact");
  const root = $("artifact-root");
  root.hidden = false;
  root.innerHTML = `<div class="diff-empty">…</div>`;
  // A refusal (a path outside this session's artifacts folder) arrives as a
  // transcript notice only, so the pane would sit on the ellipsis forever.
  // `openFile` uses the same guard for the same reason; the timer is separate
  // because the two panes can be loading different things.
  const wanted = path;
  clearTimeout(state.artifactLoadTimer);
  state.artifactLoadTimer = setTimeout(() => {
    if (state.selectedArtifact !== wanted) return;
    if (root.textContent.trim() !== "…") return;
    root.innerHTML = `<div class="diff-empty">${escapeHtml(t.artifactLoadFailed)}</div>`;
  }, 5000);
  api.send({ cmd: "getArtifact", path });
}

/**
 * Open the artifact pane on its list.
 *
 * The list is the pane's home: `openWorkbench("artifact")` alone would keep
 * whatever artifact was selected last, because `state.selectedArtifact` is
 * remembered while the window is open. Reaching the pane from the ⋯ menu means
 * "show me what was produced", not "show me the file I happened to look at
 * before".
 */
function openArtifactPane({ opener = null } = {}) {
  state.selectedArtifact = null;
  // A preview opened from a tool row may have a load still in flight; its
  // failure guard reads `state.selectedArtifact`, which was just cleared, so
  // it will not paint over the list. Clearing the timer is the belt to that
  // brace.
  clearTimeout(state.artifactLoadTimer);
  openWorkbench("artifact", { opener });
  // The caption still describes the artifact that was open; the pane below it
  // now shows the list.
  workbenchMeta.textContent = "";
}

function attachToolOutput(node, name, output, artifactPath) {
  // A large result keeps only a summary in the transcript and writes the full
  // text to a file. That path is the only way to see all of it, so a call with
  // an artifact is worth rendering even when the summary is empty.
  const hasArtifact = typeof artifactPath === "string" && artifactPath !== "";
  if ((!output || output.trim() === "") && !hasArtifact) return;
  const row = node;
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains("tool-output")) {
    // Rewriting the text drops any button the block already had, so it is
    // re-attached below; a result that arrives without a path leaves none.
    existing.textContent = output ?? "";
    if (hasArtifact) attachArtifactLink(existing, artifactPath);
    return;
  }
  const outputNode = document.createElement("pre");
  outputNode.className = "tool-output";
  // Verbose opens every result as it arrives; the other views keep it behind
  // the details toggle.
  const expanded = state.transcriptView === "verbose";
  outputNode.hidden = !expanded;
  outputNode.textContent = output ?? "";
  if (hasArtifact) attachArtifactLink(outputNode, artifactPath);
  // A detail block belongs to its call, so it is wrapped with it rather than
  // being a sibling inside the activity group.
  const block = document.createElement("div");
  block.className = "tool-item";
  row.before(block);
  block.append(row, outputNode);
  const button = row.querySelector(".tool-expand");
  button.hidden = expanded;
  button.setAttribute("aria-expanded", String(expanded));
  row.classList.toggle("open", expanded);
  button.addEventListener("click", () => {
    const opening = outputNode.hidden;
    outputNode.hidden = !outputNode.hidden;
    button.setAttribute("aria-expanded", String(!outputNode.hidden));
    row.classList.toggle("open", !outputNode.hidden);
    if (!outputNode.hidden) {
      // `hidden` is display:none, so the element cannot be transitioned from
      // it. Paint the entering class for one frame and drop it; the CSS
      // transition does the rest, and reduced-motion turns it off.
      outputNode.classList.add("entering");
      requestAnimationFrame(() => outputNode.classList.remove("entering"));
      outputNode.scrollTop = outputNode.scrollHeight;
    }
  });
}

/**
 * Markup for one reasoning block: a header button plus a foldable body.
 *
 * Two call sites build this — the live `thinking_start` path and the
 * `session_loaded` replay — and both must agree on the structure the toggle
 * and the CSS rely on, so the markup has exactly one definition. The body is
 * left empty: the caller fills it with `textContent`, because reasoning is
 * model output and must never be parsed as markup.
 *
 * `expanded` is a *per-block* state, not a view setting. A streaming block
 * starts open so the reader can watch it think; a finished one starts folded
 * to a single line. Two blocks on screen can disagree, which is exactly what
 * a global view switch could not express.
 */
function thinkingBlockHtml(label, expanded) {
  const open = expanded ? "true" : "false";
  return (
    `<div class="thinking" data-expanded="${open}">` +
    `<div class="thinking-head">` +
    // A real `<button>`: Tab reaches it, Enter and Space fire `click`, and
    // `aria-expanded` tells a screen reader which way it will go. Nothing
    // interactive may be nested inside it.
    `<button type="button" class="thinking-toggle" aria-expanded="${open}">` +
    `<span class="thinking-label">${escapeHtml(label)}</span>` +
    `${icon("chevron-down", "thinking-chevron")}` +
    `</button>` +
    `</div>` +
    // Folded, the body is clipped to zero height by CSS but stays in the DOM
    // (nothing is thrown away). `aria-hidden` keeps a screen reader from
    // reading text the sighted reader has explicitly folded shut; it is safe
    // here because the body holds nothing focusable.
    `<div class="thinking-text"${expanded ? "" : ` aria-hidden="true"`}></div>` +
    `</div>`
  );
}

/**
 * Fold or unfold one block.
 *
 * The state is written to the block itself (`data-expanded`), never to a
 * module-level flag: "expand the second block" must not disturb the first.
 * Nothing is persisted — a reopened conversation starts folded, because the
 * reasoning is not what the reader came back for.
 */
function setThinkingExpanded(node, expanded) {
  if (!node) return;
  node.dataset.expanded = expanded ? "true" : "false";
  const toggle = node.querySelector(".thinking-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", String(expanded));
  const body = node.querySelector(".thinking-text");
  if (body) {
    if (expanded) body.removeAttribute("aria-hidden");
    else body.setAttribute("aria-hidden", "true");
  }
  if (expanded) {
    // Opening a block near the bottom pushes content down; follow only when
    // the reader was already pinned, so a scrolled-up reader stays put.
    const pane = scrollTarget();
    if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 140) scrollToBottom(true);
  }
}

/** Wire a block's header button. Called once per block, on creation. */
function bindThinkingToggle(node) {
  const toggle = node?.querySelector(".thinking-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    // Record that this block's state is now the reader's choice: `endThinking`
    // folds untouched blocks, and must not undo a click made mid-stream.
    node.dataset.userToggled = "true";
    setThinkingExpanded(node, nextThinkingExpanded(node.dataset.expanded));
  });
}

function startThinking() {
  if (state.currentThinking) return;
  const node = addNode(thinkingBlockHtml(t.thinking, true));
  node.classList.add("streaming");
  // The block is appended, so a model that reasons *between* two paragraphs
  // would have its reasoning land after the prose it came from — and the next
  // paragraph would then be appended below the reasoning, splitting one answer
  // in half. Moving the prose turn under the block keeps the transcript in the
  // order the model produced it: prose, reasoning, more prose.
  const current = state.currentAssistant;
  if (current?.node?.isConnected) node.before(current.node);
  bindThinkingToggle(node);
  state.currentThinking = node;
  state.currentThinkingText = node.querySelector(".thinking-text");
  state.thinkingBuffer = "";
}

function appendThinking(text) {
  if (!state.currentThinkingText || !text) return;
  // Reasoning arrives one token at a time. Writing `textContent` per token
  // forced a layout per token; coalescing to one frame matches how the answer
  // stream is handled and keeps a long chain of thought from stuttering.
  state.thinkingBuffer = (state.thinkingBuffer ?? "") + text;
  if (state.thinkingRaf) return;
  state.thinkingRaf = requestAnimationFrame(() => {
    state.thinkingRaf = 0;
    if (!state.currentThinkingText) return;
    state.currentThinkingText.textContent = state.thinkingBuffer ?? "";
    // A block the reader folded shut mid-stream grows unseen; scrolling for
    // it would move the transcript under a click that asked for less, not
    // more. Follow only while it is open and the reader is at the bottom.
    if (state.currentThinking?.dataset.expanded !== "true") return;
    const pane = scrollTarget();
    if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 140) pane.scrollTop = pane.scrollHeight;
  });
}

/**
 * Settle the block: streaming leaves it open and growing, a finished block
 * folds back to one line that the reader can open. Nothing is thrown away —
 * the text stays in the DOM and the 320 px cap lives in CSS.
 */
function endThinking() {
  if (!state.currentThinking) return;
  if (state.thinkingRaf) {
    cancelAnimationFrame(state.thinkingRaf);
    state.thinkingRaf = 0;
  }
  const node = state.currentThinking;
  // Flush whatever the last frame did not paint, so the kept block is whole.
  if (state.currentThinkingText && state.thinkingBuffer) {
    state.currentThinkingText.textContent = state.thinkingBuffer;
  }
  const text = state.currentThinkingText?.textContent?.trim() ?? "";
  node.classList.remove("streaming");
  if (text === "") {
    // A segment with no reasoning is not a block. Keeping it would leave a
    // finished turn labelled 思考中… ("thinking…") — a line that claims work
    // still in progress after the turn has moved on.
    node.remove();
  } else {
    const label = node.querySelector(".thinking-label");
    if (label) label.textContent = t.thoughtBriefly;
    setThinkingExpanded(node, thinkingExpandedOnEnd(node.dataset.expanded, node.dataset.userToggled));
  }
  state.currentThinking = null;
  state.currentThinkingText = null;
  state.thinkingBuffer = "";
}

function addNotice(level, text) {
  const cls = level === "warn" ? "warn" : level === "error" ? "error" : level === "dim" ? "dim" : "";
  if (!cls) return;
  addNode(`<div class="notice ${cls}">${escapeHtml(text)}</div>`, { keepEmptyState: true });
}

/**
 * The task plan.
 *
 * It used to be removed and re-appended on every update, which physically
 * moved the card to the end of the transcript and pulled the view with it —
 * a plan that ticks items off while you read it should stay where it is. The
 * card is created once and its rows are updated in place.
 */
/** The current plan card; one per session view, reused across updates. */
let planCard = null;

function renderPlan(items) {
  const pane = scrollTarget();
  const wasPinned = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 140;
  let host = planCard;
  if (!items || items.length === 0) {
    if (host) host.remove();
    planCard = null;
    // The strip is a view of this same list; a cleared plan clears both. It
    // has to go through here rather than being left behind, or the composer
    // would keep advertising a plan nobody can see.
    renderPlanStrip([]);
    return;
  }
  if (!host || !host.isConnected) {
    host = document.createElement("div");
    host.className = "plan";
    host.innerHTML = `<div class="plan-card"><div class="plan-title">${escapeHtml(t.plan)}</div><div class="plan-items"></div></div>`;
    planCard = host;
    // Inserted before the composer, after the last turn, so it does not move
    // when a later tool row is appended: it is the first child of the run of
    // turns that follows it.
    hideEmptyState();
    if (state.currentAssistant?.node?.isConnected) state.currentAssistant.node.before(host);
    else transcript.appendChild(host);
  }
  const list = host.querySelector(".plan-items");
  paintPlanRows(list, items);
  // Only follow the plan if the reader was already at the bottom; otherwise
  // the update would scroll them away from what they were reading.
  if (wasPinned) pane.scrollTop = pane.scrollHeight;
  renderPlanStrip(items);
}

/**
 * Paint plan rows in place.
 *
 * Shared by the transcript's card and the strip above the composer: both show
 * the same list, and a second implementation of "what a finished row looks
 * like" would eventually disagree with the first. Rows are reused by index so
 * a status change does not rebuild the list (which would steal focus on a
 * button inside it, if one is ever added).
 */
function paintPlanRows(list, items) {
  const existing = [...list.children];
  items.forEach((item, index) => {
    let row = existing[index];
    if (!row) {
      row = document.createElement("div");
      list.appendChild(row);
    }
    row.className = `plan-item ${item.status}`;
    const box = row.querySelector(".box") ?? row.appendChild(document.createElement("span"));
    box.className = "box";
    const boxHtml = item.status === "completed" ? icon("check") : "";
    if (box.innerHTML !== boxHtml) box.innerHTML = boxHtml;
    let label = row.querySelector(".label");
    if (!label) {
      label = document.createElement("span");
      label.className = "label";
      row.appendChild(label);
    }
    const text = String(item.content);
    if (label.textContent !== text) label.textContent = text;
  });
  for (const stale of existing.slice(items.length)) stale.remove();
}

/**
 * The plan restated above the composer.
 *
 * The transcript card scrolls away exactly when a long run makes the plan worth
 * watching: by the time a five-step diagnostic reaches step three, the card is
 * several screens up. This strip stays next to the input and carries what a
 * glance needs — how far along, and which step the plan is on — with the full
 * list one click away.
 *
 * It is a *second view of the same list*, never a second source: every update
 * comes through `renderPlan`, which repaints both from the same `items`. A
 * plan the model clears hides the strip with the card.
 */
/** The last list drawn, so a language switch can repaint the derived labels. */
let planItems = [];

function renderPlanStrip(items) {
  if (!planStrip) return;
  const summary = planSummary(items);
  planItems = summary === null ? [] : items;
  if (summary === null) {
    planStrip.hidden = true;
    // A closed plan must not reopen already expanded when the next one starts
    // with a fresh list: the reader did not ask for that one.
    setPlanStripOpen(false);
    planStripList.replaceChildren();
    return;
  }
  planStrip.hidden = false;
  planStripCount.textContent = `${summary.done}/${summary.total}`;
  // `index === -1` means every step is done; saying "all steps done" is the
  // honest header then, since there is no current step to name.
  planStripCurrent.textContent =
    summary.index === -1 ? t.planComplete : summary.current || t.planNext;
  paintPlanRows(planStripList, items);
  setPlanStripTitle();
}

/**
 * The header's tooltip, in the language and direction of the moment.
 *
 * Set from code rather than left to `data-i18n-title` because it depends on
 * whether the list is open: a tooltip that says "show the full plan" over a
 * button that would fold it is a control claiming something it will not do.
 * Called again on every locale change, since `t` is what changed.
 */
function setPlanStripTitle() {
  if (!planStrip) return;
  const open = planStrip.classList.contains("open");
  planStripToggle.title = open ? t.planCollapse : t.planToggle;
}

function setPlanStripOpen(open) {
  if (!planStrip) return;
  planStrip.classList.toggle("open", open);
  planStripToggle.setAttribute("aria-expanded", open ? "true" : "false");
  // Same mechanics as the thinking block: the list stays in the DOM and is
  // clipped to zero height, so nothing has to be rebuilt on toggle.
  planStripList.setAttribute("aria-hidden", open ? "false" : "true");
  setPlanStripTitle();
}

// Guarded although the markup carries the button: a renderer loaded against an
// older `index.html` (a half-applied update) would otherwise throw at module
// load and take the whole transcript down with it.
planStripToggle?.addEventListener("click", () => {
  setPlanStripOpen(!planStrip.classList.contains("open"));
});

/* ---------- subagent strip (above the composer) ----------
 *
 * Same shape as the plan strip and for the same reason: a run that is worth
 * watching is a run whose rows have scrolled away. What it answers is the
 * operator's own question — which subagents are running, for how long, and one
 * click to go and read what one of them did.
 *
 * Two rules that are not obvious:
 *
 * 1. **The clock is the renderer's, the start time is the kernel's.** The
 *    protocol layer carries `startedAt` and refuses to compute an elapsed
 *    figure; a pure function's answer would be stale one second later. The
 *    ticker below reads `Date.now()` against that timestamp.
 * 2. **Nothing is redrawn on a tick.** The ticker rewrites the header's two
 *    numbers and each row's clock text; it never rebuilds rows. A rebuild once
 *    a second would steal focus from a row button under the cursor, which is
 *    the same mistake `renderPlan` was rewritten to avoid.
 */

/** The last `renderSubagentStrip` list, so a tick or a locale switch can repaint. */
let subagentRuns = [];
/** The one-second ticker, or null when nothing is running. */
let subagentTicker = null;
/** The ticker's period. One second: that is the resolution of the readout. */
const SUBAGENT_TICK_MS = 1_000;

/**
 * The runs the strip should show right now, oldest first.
 *
 * Oldest first so the folded header names the run that has been going longest —
 * the one whose elapsed figure is the one worth glancing at. `startedAt` is
 * sorted as a timestamp, and a run whose clock did not parse sorts last rather
 * than vanishing.
 */
function runningSubagents() {
  const runs = [...state.liveSubagents.values()];
  runs.sort((left, right) => {
    const a = Date.parse(left.startedAt);
    const b = Date.parse(right.startedAt);
    if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
    if (!Number.isFinite(a)) return 1;
    if (!Number.isFinite(b)) return -1;
    return a - b;
  });
  return runs;
}

/**
 * Stop the ticker and drop the rows. Called whenever the set becomes empty, so
 * the timer cannot outlive the thing it was counting.
 */
function haltSubagentTicker() {
  if (subagentTicker !== null) {
    clearInterval(subagentTicker);
    subagentTicker = null;
  }
}

function startSubagentTicker() {
  // One timer, started only with something to count. A tick with an empty map
  // would be a `setInterval` running for the life of the window.
  if (subagentTicker !== null || state.liveSubagents.size === 0) return;
  subagentTicker = setInterval(() => {
    if (state.liveSubagents.size === 0) {
      haltSubagentTicker();
      renderSubagentStrip();
      return;
    }
    // Numbers only — see rule 2 in the block comment.
    paintSubagentClocks();
  }, SUBAGENT_TICK_MS);
}

/**
 * Add a run to the strip, or refresh one already there.
 *
 * A second `subagent_started` for the same id is a duplicate (a re-delivered
 * event, or a resumed log): it keeps the **first** clock, because the run
 * started then and a later timestamp would make it look younger than it is.
 */
function noteSubagentStarted(message) {
  if (typeof message.id !== "string" || message.id === "") return;
  const existing = state.liveSubagents.get(message.id);
  state.liveSubagents.set(message.id, {
    id: message.id,
    label: message.label ?? existing?.label,
    startedAt: existing?.startedAt ?? message.startedAt,
    maxTurns: message.maxTurns ?? existing?.maxTurns,
    timeoutMs: message.timeoutMs ?? existing?.timeoutMs,
  });
  startSubagentTicker();
  renderSubagentStrip();
}

/**
 * Take a run out. Returns whether it was there, so the caller can tell "the
 * strip changed" from "a result for a run this window never saw".
 */
function noteSubagentSettled(id) {
  if (typeof id !== "string" || id === "") return false;
  const removed = state.liveSubagents.delete(id);
  if (state.liveSubagents.size === 0) haltSubagentTicker();
  if (removed) renderSubagentStrip();
  return removed;
}

function clearSubagents() {
  state.liveSubagents.clear();
  haltSubagentTicker();
  renderSubagentStrip();
}

/** A row's limit clause: turns when the kernel reported them, nothing when not. */
function subagentLimitText(run) {
  if (typeof run.maxTurns !== "number" || !Number.isFinite(run.maxTurns)) return "";
  const minutes =
    typeof run.timeoutMs === "number" && Number.isFinite(run.timeoutMs) && run.timeoutMs > 0
      ? t.minutesShort(Math.round(run.timeoutMs / 60000))
      : "";
  return t.subagentLimits(run.maxTurns, minutes);
}

/**
 * One row per running subagent. Reused by index like `paintPlanRows`: a status
 * change must not rebuild the list under the reader's cursor.
 *
 * The row is a `<button>`: it opens that run's own log. It is the only control
 * here, so the whole row being clickable is the honest target rather than a
 * chevron that means "open" and a label that does not.
 */
function paintSubagentRows(runs) {
  if (!subagentStripList) return;
  const existing = [...subagentStripList.children];
  runs.forEach((run, index) => {
    let row = existing[index];
    if (!row) {
      row = document.createElement("button");
      row.type = "button";
      row.className = "subagent-strip-row";
      row.dataset.subagentId = run.id;
      const name = document.createElement("span");
      name.className = "subagent-strip-name";
      row.appendChild(name);
      const clock = document.createElement("span");
      clock.className = "subagent-strip-clock";
      row.appendChild(clock);
      const limits = document.createElement("span");
      limits.className = "subagent-strip-limits";
      row.appendChild(limits);
      row.addEventListener("click", () => loadSubagent(row.dataset.subagentId));
      subagentStripList.appendChild(row);
    }
    if (row.dataset.subagentId !== run.id) row.dataset.subagentId = run.id;
    row.title = t.subagentOpen;
    row.querySelector(".subagent-strip-name").textContent = subagentName(run);
    row.querySelector(".subagent-strip-limits").textContent = subagentLimitText(run);
    paintSubagentClock(row, run);
  });
  for (const stale of existing.slice(runs.length)) stale.remove();
}

/**
 * How long a run may go before its row says so.
 *
 * Not a limit — the kernel has none by default (2026-11-09). This is the only
 * signal the reader gets that a dispatch has been going a long while, and with
 * no turn cap and no lifetime cap there is nothing else that would ever stop
 * it. A number on screen is what turns "it has been a while" into a decision.
 */
const SUBAGENT_LONG_RUN_MS = 10 * 60 * 1000;

/** One row's elapsed figure, from the kernel's start time and this clock. */
function paintSubagentClock(row, run) {
  const clock = row.querySelector(".subagent-strip-clock");
  if (!clock) return;
  const startedAt = Date.parse(String(run.startedAt ?? ""));
  const elapsed = elapsedClock(run.startedAt, Date.now());
  clock.textContent = elapsed === null ? t.subagentElapsedUnknown : t.subagentElapsed(elapsed);
  // A quiet marker, not a warning: the run is doing what it was told to do.
  // It goes on the clock rather than the limits cell because that cell is
  // blank when nothing was set — which is now the normal case.
  const long = Number.isFinite(startedAt) && Date.now() - startedAt >= SUBAGENT_LONG_RUN_MS;
  clock.classList.toggle("long", long);
  if (long) clock.title = t.subagentLongRun;
  else clock.removeAttribute("title");
}

/**
 * Rewrite every clock in place — the ticker's whole job.
 *
 * It also refreshes the folded header, whose one named run is the oldest and
 * therefore the one whose figure just changed.
 */
function paintSubagentClocks() {
  const runs = subagentRuns;
  if (!subagentStripList) return;
  const rows = [...subagentStripList.children];
  runs.forEach((run, index) => {
    const row = rows[index];
    if (row) paintSubagentClock(row, run);
  });
  if (subagentStripCount) subagentStripCount.textContent = t.subagentRunning(runs.length);
  if (subagentStripCurrent) subagentStripCurrent.textContent = foldedSubagentText(runs);
}

/**
 * What the folded header says after the count: the oldest run's name and clock,
 * then how many others are behind it. `+N` is the count of the rest, not of all
 * of them — the header already names one.
 */
function foldedSubagentText(runs) {
  if (runs.length === 0) return "";
  const first = runs[0];
  const elapsed = elapsedClock(first.startedAt, Date.now());
  const clock = elapsed === null ? t.subagentElapsedUnknown : t.subagentElapsed(elapsed);
  const parts = [`${subagentName(first)} ${clock}`];
  const overflow = subagentOverflow(runs.length);
  if (overflow > 0) parts.push(t.subagentMore(overflow));
  return parts.join(" · ");
}

/**
 * Draw the strip from the runs that exist now.
 *
 * Hidden when there is nothing to show, and **hidden while the transcript is a
 * replay**: the replay shows a past position, so a line saying "2 subagents
 * running" over it would be a claim about now drawn on a picture of then. The
 * same objection applies to a subagent's own read-only log, which is a finished
 * record — nothing in it is running.
 */
function renderSubagentStrip() {
  if (!subagentStrip) return;
  const runs = runningSubagents();
  subagentRuns = runs;
  if (runs.length === 0 || state.readonly !== null) {
    subagentStrip.hidden = true;
    setSubagentStripOpen(false);
    subagentStripList?.replaceChildren();
    return;
  }
  subagentStrip.hidden = false;
  if (subagentStripCount) subagentStripCount.textContent = t.subagentRunning(runs.length);
  if (subagentStripCurrent) subagentStripCurrent.textContent = foldedSubagentText(runs);
  paintSubagentRows(runs);
  setSubagentStripTitle();
}

function setSubagentStripTitle() {
  if (!subagentStrip || !subagentStripToggle) return;
  const open = subagentStrip.classList.contains("open");
  subagentStripToggle.title = open ? t.subagentStripCollapse : t.subagentToggle;
}

function setSubagentStripOpen(open) {
  if (!subagentStrip || !subagentStripToggle) return;
  subagentStrip.classList.toggle("open", open);
  subagentStripToggle.setAttribute("aria-expanded", open ? "true" : "false");
  // Same mechanics as the plan strip: the list stays in the DOM clipped to zero
  // height, so opening it rebuilds nothing.
  subagentStripList?.setAttribute("aria-hidden", open ? "false" : "true");
  setSubagentStripTitle();
}

subagentStripToggle?.addEventListener("click", () => {
  setSubagentStripOpen(!subagentStrip.classList.contains("open"));
});

/* ---------- read-only subagent session ---------- */

/**
 * Ask the host for a finished subagent's log.
 *
 * The host is the one that decides whether the pair of ids is legal
 * (`subagentSessionDir`) and where the record is; this only names the two.
 */
function loadSubagent(childId) {
  const parentId = state.readonly?.parentId ?? state.sessionId;
  if (typeof parentId !== "string" || parentId === "" || typeof childId !== "string" || childId === "") return;
  api.send({ cmd: "loadSubagent", parentId, childId });
}

/** Leave the child's log and reopen the parent's. */
function exitReadonly() {
  const parentId = state.readonly?.parentId ?? "";
  if (parentId === "") return;
  api.send({ cmd: "loadSession", id: parentId });
}

/**
 * The permanent banner over a subagent's log.
 *
 * It is not a notice: a notice scrolls away with the transcript it was written
 * into, and this one has to outlast every redraw of a screen that looks exactly
 * like a writable conversation. `loadSession` clears the state — there is no
 * dismiss button, because "dismiss" would mean "read this as an ordinary
 * conversation", which is the one thing it is not.
 */
function renderReadonlyBanner() {
  if (!readonlyBanner) return;
  const readonly = state.readonly;
  if (readonly === null) {
    readonlyBanner.hidden = true;
    return;
  }
  readonlyBanner.hidden = false;
  if (readonlyText) readonlyText.textContent = t.readonlySubagent(readonly.childId);
  if (readonlyBack) readonlyBack.textContent = t.readonlyBack;
}

readonlyBack?.addEventListener("click", exitReadonly);

/* ---------- state ---------- */

function setBusy(busy) {
  state.busy = busy;
  // A live region that announces every streamed token makes a screen reader
  // unusable during a turn: it reads the answer one character at a time, and
  // the finished text is announced again at the end. Marking the region busy
  // suppresses the incremental announcements while streaming.
  transcript.setAttribute("aria-busy", busy ? "true" : "false");
  // The progress line brackets the turn: it appears when the turn starts and
  // disappears when it ends, so it is never left behind as a stale "0s".
  if (busy) {
    if (!state.progress) {
      const progress = ensureProgress();
      progress.startedAt = Date.now();
      renderProgress();
      startProgressTicker();
    }
  } else {
    clearProgress();
  }
  stopButton.hidden = !busy;
  // The send button is never disabled for being busy: a greyed button explains
  // nothing, and pressing it mid-turn is answered (`submit()` says "wait or
  // stop" and keeps the draft). The host has no queue either — a second prompt
  // mid-turn is refused there — so the renderer says the same thing before the
  // message ever leaves the window (R3).
  //
  // A replay is the one case where it *is* disabled, with its reason on
  // screen. That decision belongs to the replay state, so this asks it rather
  // than forcing the button open: a `run_end` arriving from a turn that ended
  // just as the reader started scrubbing must not reopen the composer.
  sendButton.disabled = false;
  renderComposerLock();
  // Finishing a turn must not paint "ready" over a stopped host or a config
  // error that is still the actual state.
  if (busy) setStatus("statusWorking");
  else if (!BUSY_OVERRIDES.has(state.statusKey)) setStatus("statusReady");
}

const BUSY_OVERRIDES = new Set(["statusHostStopped", "statusConfigError", "statusError"]);

function setStatus(key) {
  state.statusKey = key;
  const dotKind = key === "statusWorking" || key === "statusConnecting" ? "working" : key.startsWith("statusError") || key === "statusHostStopped" || key === "statusConfigError" ? "error" : "ready";
  statusDot.className = `status-dot ${dotKind}`;
  statusText.textContent = statusLabel(key);
  // "Ready" is the resting state and needs no label; anything else is news.
  statusText.hidden = dotKind === "ready";
}

/* ---------- confirmation dialog ---------- */

/**
 * An in-window confirmation.
 *
 * `window.confirm` renders the OS dialog: it ignores the app's theme entirely,
 * blocks the renderer thread, and cannot be reached by the app's own tests. It
 * also cannot show a destructive action in the app's own color language. This
 * follows the same tokens as every other surface, traps focus while open, and
 * returns a promise.
 *
 * It is a modal `<dialog>`, not a z-indexed `<div>`. Settings and the shortcut
 * sheet are opened with `showModal()`, which puts them in the browser's top
 * layer; a plain element renders *behind* that layer no matter how high its
 * z-index, and cannot take focus (measured in Electron 44: hit-testing the
 * confirm button returned the settings dialog). Every destructive confirmation
 * on the settings pages was therefore drawn where nobody could see it. A
 * second modal dialog stacks correctly above the first and still traps focus.
 */
function confirmAction(message, options = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const overlay = document.createElement("dialog");
    overlay.className = "confirm-overlay";
    overlay.innerHTML =
      `<div class="confirm-dialog" role="alertdialog" aria-modal="true">` +
      `<div class="confirm-text">${escapeHtml(message)}</div>` +
      `<div class="confirm-actions">` +
      `<button class="confirm-cancel">${escapeHtml(options.cancel ?? t.cancel)}</button>` +
      `<button class="confirm-ok${options.danger ? " danger" : ""}">${escapeHtml(options.ok ?? t.confirm)}</button>` +
      `</div></div>`;
    document.body.appendChild(overlay);
    overlay.showModal();

    const ok = overlay.querySelector(".confirm-ok");
    const cancel = overlay.querySelector(".confirm-cancel");
    let settled = false;
    const close = (answer) => {
      if (settled) return;
      settled = true;
      // `close()` is what drops the dialog out of the top layer; removing the
      // node afterwards keeps the document free of spent dialogs.
      overlay.close?.();
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      if (previous && typeof previous.focus === "function") previous.focus();
      resolve(answer);
    };
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      if (event.key !== "Tab") return;
      // Two buttons: keep Tab inside the dialog rather than walking into the
      // page behind it.
      event.preventDefault();
      (document.activeElement === ok ? cancel : ok).focus();
    }
    document.addEventListener("keydown", onKey, true);
    ok.addEventListener("click", () => close(true));
    cancel.addEventListener("click", () => close(false));
    // The browser's own Escape path. The capture handler above normally
    // consumes the key first, but a close request that arrives some other way
    // must still answer the promise rather than leave it pending forever.
    overlay.addEventListener("cancel", (event) => {
      event.preventDefault();
      close(false);
    });
    // A modal dialog retargets clicks on its backdrop to the dialog element,
    // so `event.target === overlay` is exactly "clicked outside the card".
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    ok.focus();
  });
}

/* ---------- in-conversation search ---------- */

const findBar = $("find-bar");
const findInput = $("find-input");
let findHits = [];
let findIndex = 0;

function clearFindMarks() {
  transcript.querySelectorAll("mark.find-hit").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  findHits = [];
}

function openFind() {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findBar.hidden = true;
  clearFindMarks();
  $("find-count").textContent = "";
  input.focus();
}

/**
 * Highlight every literal occurrence of `query` in the transcript. Only text
 * nodes are touched, so markup and tool rows survive.
 */
function runFind() {
  clearFindMarks();
  const query = findInput.value.trim();
  if (!query) {
    $("find-count").textContent = "";
    return;
  }
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(".find-bar, script, style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  for (const node of targets) {
    const text = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let from = 0;
    for (;;) {
      const at = text.toLowerCase().indexOf(needle, from);
      if (at < 0) {
        fragment.appendChild(document.createTextNode(text.slice(from)));
        break;
      }
      if (at > from) fragment.appendChild(document.createTextNode(text.slice(from, at)));
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      mark.textContent = text.slice(at, at + needle.length);
      fragment.appendChild(mark);
      findHits.push(mark);
      from = at + needle.length;
    }
    node.parentNode.replaceChild(fragment, node);
  }

  findIndex = 0;
  focusFindHit();
}

function focusFindHit() {
  findHits.forEach((hit, index) => hit.classList.toggle("current", index === findIndex));
  const current = findHits[findIndex];
  // `behavior: "smooth"` is a JS option, so the CSS reduced-motion rule never
  // reaches it. Someone who asked for less motion gets an instant jump.
  const reduce = document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (current) current.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  $("find-count").textContent = findHits.length === 0 ? t.findNone : `${findIndex + 1}/${findHits.length}`;
}

function stepFind(delta) {
  if (findHits.length === 0) return;
  findIndex = (findIndex + delta + findHits.length) % findHits.length;
  focusFindHit();
}

let findTimer = null;
findInput.addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 120);
});
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    stepFind(event.shiftKey ? -1 : 1);
  }
});
$("find-next").addEventListener("click", () => stepFind(1));
$("find-prev").addEventListener("click", () => stepFind(-1));
$("find-close").addEventListener("click", closeFind);

/* ---------- slash commands ---------- */

const commandMenu = $("command-menu");
let commandState = null;

/**
 * The host-reported commands with the local catalogue's copy.
 *
 * `state.commands` stays exactly what the host said — that list is the
 * capability boundary — while the descriptions and the argument hint come
 * from `commands.js` in the language on screen. Merging on read keeps a
 * locale switch from leaving the menu in the previous language.
 */
function commandList() {
  return mergeCommands(state.commands, state.locale);
}

function commandsAtCaret() {
  const before = input.value.slice(0, input.selectionStart);
  const match = /(^|\n)\/([a-z0-9][a-z0-9-_]*)?$/i.exec(before);
  return match ? match[2] ?? "" : null;
}

function updateCommandMenu() {
  const query = commandsAtCaret();
  if (query === null) {
    closeCommandMenu();
    return;
  }
  const matches = commandList().filter((command) => command.name.startsWith(query.toLowerCase()));
  if (matches.length === 0) {
    closeCommandMenu();
    return;
  }
  commandState = { matches, index: 0 };
  commandMenu.innerHTML = "";
  matches.forEach((command, index) => {
    const row = document.createElement("button");
    row.className = `mention-row command-row${index === 0 ? " active" : ""}`;
    row.setAttribute("role", "option");
    // A command with no argument hint runs; one with a hint inserts its name
    // so arguments can be typed after it. Showing which is which before the
    // click is what keeps "Enter" from being a guess. Skills follow the same
    // rule — their hint comes from the skill file, and a skill without one is
    // a one-shot prompt.
    row.innerHTML =
      `<span class="command-name">/${escapeHtml(command.name)}</span>` +
      `<span class="command-hint">${escapeHtml(command.description || command.argumentHint || "")}</span>` +
      `<span class="command-arg">${escapeHtml(command.argumentHint || "")}</span>`;
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyCommand(command);
    });
    commandMenu.appendChild(row);
  });
  commandMenu.hidden = false;
}

function closeCommandMenu() {
  commandState = null;
  commandMenu.hidden = true;
}

function applyCommand(command) {
  closeCommandMenu();
  // A command with no argument hint runs on the spot. Inserting "/clear " and
  // waiting for a second Enter made a one-shot verb feel like a text field.
  // A skill with no hint is the same case: it may still contain `$ARGUMENTS`,
  // and running it with empty args is the only reading of a click that has no
  // text to give.
  if (!command.argumentHint) {
    const draft = input.value;
    input.value = "";
    autoSize();
    // Clicking a row is the same act as typing the verb: the transcript gets
    // `/${name}` as the message, exactly the text the palette would have put
    // in the composer had the command taken arguments.
    if (runSlashCommand({ name: command.name, args: "" }, `/${command.name}`) === "kept") {
      // The command refused (unknown, or asked for an argument this verb does
      // not take). Putting the draft back is the difference between "read the
      // notice and fix it" and "retype what you had".
      input.value = draft;
      autoSize();
      input.focus();
    }
    return;
  }
  input.value = `/${command.name} `;
  input.setSelectionRange(input.value.length, input.value.length);
  autoSize();
  input.focus();
}

/**
 * "This window cannot run that verb": name it, then list what it can run.
 *
 * The offending name is filtered out of the list it is answered with, so a
 * host-reported verb with no handler here cannot produce "unknown /deploy;
 * available /clear · /deploy".
 */
function reportUnknownCommand(name, available) {
  addNotice("dim", t.commandUnknownHeading(name));
  const names = available
    .filter((entry) => entry.name !== name)
    .map((entry) => `/${entry.name}`)
    .join(" · ");
  addNotice("dim", `${t.commandAvailable} ${names || "—"}`);
  scrollToBottom();
}

/**
 * The verbs `runSlashCommand` actually implements. A name outside this set is
 * a stale host catalogue, not a command, so it must not echo into the
 * transcript on its way to the "unknown" notice.
 */
const RUNNABLE_COMMANDS = new Set(["clear", "context", "compact", "hook"]);

/**
 * Run one built-in command locally.
 *
 * Slash commands are this window's own vocabulary: the kernel has no such
 * verbs, and `/clear` used to travel to the model as a prompt, which is why
 * the model answered "I can't clear the conversation". Each verb maps to the
 * action that actually exists, and `/context` prints only the figure the
 * kernel last reported — an unknown measurement is said out loud rather than
 * printed as 0.
 *
 * A command that really runs also *appears in the transcript*, as the plain
 * user message the user typed. The kernel is not involved in that: it is the
 * same convention Claude Code follows, where `/compact` sits in the record as
 * a message followed by its result. Without it the output arrived from nowhere
 * — a `/context` report with no question above it reads like a spontaneous
 * notice, and a reopened session lost every trace that a command ran. Refusals
 * do not echo: a typo or a stray argument must not leave a message in the log
 * that looks like something the kernel accepted.
 *
 * Resolution order for a name is fixed: a local verb runs here, a skill row
 * expands into a prompt (`runSkillCommand`), and anything else is reported as
 * unknown. Both entry points — a typed message and a palette click — go
 * through this one function, so the three cases cannot be ordered two ways.
 *
 * `rawText` is what the user actually typed, echoed verbatim. The command
 * palette has no typed text, so it defaults to `/${name}` — the same string
 * the palette would have inserted.
 *
 * Returns `"ran"` when the draft was consumed, and `"kept"` when it must stay
 * in the composer: an unknown name and a refused argument are both answers the
 * user has to see before retyping, so erasing their text would be the loss.
 */
function runSlashCommand({ name, args }, rawText = `/${name}`) {
  // The palette reaches this without going through `submit()`, so it gets the
  // read-only refusal too: `/compact` and `/context` would act on the
  // **parent's** log while the screen shows the child's, and `/clear` would
  // start a new conversation from a record the reader is still reading.
  // "kept" puts the draft the palette took back where it was.
  if (state.readonly !== null) {
    addNotice("warn", t.readonlyComposerReason);
    scrollToBottom();
    return "kept";
  }
  // Only the palette reaches this while a turn runs (`submit()` refuses
  // earlier for a typed command). The kernel refuses these verbs mid-turn too,
  // so the window answers with the same sentence — and "kept" restores the
  // draft the palette took out of the box.
  if (state.busy) {
    addNotice("warn", t.busyThisTurn);
    scrollToBottom();
    return "kept";
  }
  const available = commandList();
  const command = available.find((entry) => entry.name === name);
  if (command !== undefined && command.source === "skill") {
    return runSkillCommand(command, args, rawText);
  }
  // Both shipped hosts report exactly the three runnable verbs, so anything
  // else is a stale catalogue entry. Reporting it here rather than in the
  // switch keeps the echo below reachable only by a command that runs.
  if (command === undefined || !RUNNABLE_COMMANDS.has(name)) {
    reportUnknownCommand(name, available);
    return "kept";
  }
  const argsText = String(args ?? "").trim();
  if (name === "hook") {
    // `/hook` takes exactly one argument and it is `reload`. Anything else is
    // refused by name rather than passed on: a host that silently ignored
    // `foo` would answer with a list that looks like the answer to `/hook
    // foo`, which is not a question this window can answer.
    if (argsText !== "" && argsText !== "reload") {
      addNotice("warn", t.commandHookUnknownArgument(argsText));
      scrollToBottom();
      return "kept";
    }
  } else if (argsText !== "") {
    // None of the other verbs takes an argument, and the kernel's compaction
    // has no focus/keep option. Silently dropping the text would be the same
    // broken promise `--keep N` made before it was removed.
    addNotice("warn", t.commandTakesNoArguments(name));
    scrollToBottom();
    return "kept";
  }
  // Past this point the command runs, so the transcript gets the message that
  // asked for it. `/clear` echoes too, even though the `session_loaded` it
  // triggers wipes the transcript a moment later — that is the correct
  // outcome, and special-casing it here would be a second rule to keep in sync.
  addUserTurn(rawText);
  switch (name) {
    case "clear":
      api.send({ cmd: "newSession" });
      return "ran";
    case "context":
      reportContextLines();
      scrollToBottom();
      return "ran";
    case "compact":
      // The host answers with the kernel's own result: a compaction marker, a
      // "nothing to compact" note, or a warning.
      api.send({ cmd: "compact" });
      return "ran";
    case "hook":
      // The answer is drawn from the host's `hooks` event, not from here: the
      // list is the kernel's reading of the file, and this window has never
      // seen it. `reload` asks for the same read again — it changes what the
      // next `/hook` shows, not what the running session does.
      api.send(argsText === "reload" ? { cmd: "getHooks", reload: true } : { cmd: "getHooks" });
      return "ran";
    default:
      // Unreachable: `RUNNABLE_COMMANDS` is the same set these cases cover.
      return "kept";
  }
}

/**
 * A skill command: expand the saved prompt body, then send it as a message.
 *
 * The body comes from `state.skills`, not from the command row: `listCommands`
 * carries names and blurbs, and the prompt text only travels in the `skills`
 * event. The two lists can disagree for a moment — boot sends them one after
 * the other, and a save refreshes both — so a name with no body says exactly
 * that instead of sending an empty prompt (R3).
 *
 * The bubble shows what the user typed, not the expanded prompt. The
 * expansion is a kernel-side or model-side detail: a transcript that showed
 * `Review the changes in src/main.ts` instead of the `/review src/main.ts` the
 * user typed makes their own messages unrecognisable, and the command they
 * would retype unrecoverable. The typed text is also what goes into the
 * history, for the same reason.
 *
 * Returns `"ran"` or `"kept"` with the same meaning as `runSlashCommand`.
 */
function runSkillCommand(command, args, rawText = `/${command.name}${args ? ` ${args}` : ""}`) {
  const name = command.name;
  const skill = state.skills.find(
    (entry) => typeof entry?.name === "string" && entry.name.trim().toLowerCase() === name,
  );
  if (skill === undefined) {
    addNotice("warn", t.skillUnavailable(name));
    scrollToBottom();
    return "kept";
  }
  const expanded = expandSkill(skill, args ?? "");
  // An expansion that came out empty is the same answer as a body that was
  // never there: a body of just `$ARGUMENTS` with no args typed leaves nothing
  // to send, and the host would reject the empty prompt with its own wording
  // about a message that cannot be empty. Say it here, where the command is.
  if (expanded === null || expanded === "") {
    addNotice("warn", t.skillEmptyPrompt(name));
    scrollToBottom();
    return "kept";
  }
  // A skill expands to a prompt, and a prompt cannot carry the image on the
  // strip (see `submit()`). Refusing keeps the same rule for every way a
  // prompt is sent — a drop that only happened on the palette path would be
  // the harder bug to notice (D-188, R3).
  if (state.attachments.length > 0) {
    addNotice("warn", t.attachmentNotSent);
    scrollToBottom();
    return "kept";
  }
  addUserTurn(rawText);
  input.value = "";
  autoSize();
  // Recorded here as well as in `submit()`, which does the same for "ran":
  // the palette path never reaches that code, and a skill clicked twice in a
  // row must behave like one typed twice. The second call is a no-op — the
  // history guard drops a text that is already the newest entry.
  rememberInHistory(rawText);
  api.send({ cmd: "prompt", text: expanded });
  return "ran";
}

/**
 * The full `/context` report, one dim line per fact.
 *
 * The single "used / window (percent)" line said how full the window was but
 * not with what, which is the first question anyone asks when it fills up.
 * The split comes from the kernel's own measurement, so every figure here is
 * reported rather than derived — except the per-category percentage, which
 * divides the part by the window (the same denominator the popover uses, so
 * the two views agree).
 *
 * An unknown window drops the percentages and the free line rather than
 * printing them against a guess; an unknown measurement is one line saying so,
 * never a page of zeros (R3).
 */
function reportContextLines() {
  const report = contextReport(state.context, state.contextBreakdown);
  if (!report.known) {
    addNotice("dim", t.commandContextUnknown);
    return;
  }
  const used = formatTokens(report.used);
  if (report.window === null) {
    // No window: the existing wording for "this figure, no denominator".
    addNotice("dim", t.commandContextUsedNoWindow(used, Math.round(report.percent)));
  } else {
    addNotice(
      "dim",
      t.commandContextUsed(used, formatTokens(report.window), report.percent),
    );
  }
  for (const part of report.parts) {
    // The denominator is the window, matching the popover's own percentage
    // column, so a part reads the same in both places. Without a window there
    // is no denominator, and the token count stands alone.
    const share =
      report.window === null
        ? ""
        : t.commandContextPartShare(((part.tokens / report.window) * 100).toFixed(1));
    addNotice("dim", `· ${t.contextPart(part.key)} ${formatTokens(part.tokens)}${share}`);
  }
  if (report.window !== null) {
    addNotice("dim", `· ${t.contextFree} ${formatTokens(report.free)}`);
  }
  // Only a real, positive buffer is worth a line: "0 left before compaction"
  // means compaction is already due, and the free line above says that better.
  if (report.headroom !== null && report.headroom > 0) {
    addNotice("dim", `· ${t.contextCompactionBuffer} ${formatTokens(report.headroom)}`);
  }
}

/**
 * One `/hook` answer, drawn as a block in the transcript.
 *
 * A block rather than a notice because it is a list: one row per hook, plus
 * the two file paths and the project-file disclosure. A line-per-notice version
 * lost the alignment that makes "which file, which entry" readable, and a
 * notice is the shell talking — this is an answer to a question the operator
 * asked (the echoed `/hook` message sits directly above it).
 *
 * The host owns every fact here: the rows are `loadHookConfig`'s own output
 * (`source` / `index` included), and the renderer only joins `command` and
 * `args` for display. Nothing is inferred from a missing field — an absent
 * `matcher` is drawn as "all tools" because that is what the kernel does with
 * it, not because a default was filled in on the way here.
 *
 * `error` and `hooks` are mutually exclusive in practice (the host never sends
 * both), and the error branch draws no rows at all: a broken file must never
 * render as an empty list, which would say "nothing is configured" about a
 * file that says the opposite (R3).
 */
function renderHooksReport(message) {
  const rows = [];
  const headingSuffix = message.reload === true ? ` (${t.hooksReRead})` : "";
  rows.push(`<div class="hooks-title">${escapeHtml(t.hooksTitle + headingSuffix)}</div>`);
  if (message.error !== undefined && message.error !== null) {
    const code = typeof message.error.code === "string" ? message.error.code : "";
    const text = typeof message.error.message === "string" ? message.error.message : "";
    rows.push(
      `<div class="hooks-error">${escapeHtml(t.hooksErrorTitle)}</div>` +
        `<div class="hooks-error-detail">${escapeHtml(t.hooksErrorEntry(code, text))}</div>`,
    );
  } else {
    const hooks = Array.isArray(message.hooks) ? message.hooks : [];
    if (hooks.length === 0) {
      rows.push(`<div class="hooks-empty">${escapeHtml(t.hooksEmpty)}</div>`);
    } else {
      const list = hooks.map((hook) => {
        const command = [hook?.command ?? "", ...(Array.isArray(hook?.args) ? hook.args : [])]
          .filter((part) => String(part) !== "")
          .join(" ");
        const source = hook?.source === "project" ? t.hooksSourceProject : t.hooksSourceUser;
        const index = Number.isSafeInteger(hook?.index) ? hook.index : 0;
        return (
          `<div class="hooks-row">` +
          `<span class="hooks-event">${escapeHtml(String(hook?.event ?? ""))}</span>` +
          `<span class="hooks-matcher">${escapeHtml(
            typeof hook?.matcher === "string" && hook.matcher !== "" ? hook.matcher : t.hooksAllTools,
          )}</span>` +
          `<span class="hooks-command">${escapeHtml(command)}</span>` +
          `<span class="hooks-source">${escapeHtml(source(index))}</span>` +
          `</div>`
        );
      });
      rows.push(`<div class="hooks-rows">${list.join("")}</div>`);
    }
  }
  if (typeof message.userConfigPath === "string" && message.userConfigPath !== "") {
    rows.push(
      `<div class="hooks-path">${escapeHtml(t.hooksUserFile)}: ${escapeHtml(message.userConfigPath)}</div>`,
    );
  }
  if (typeof message.projectConfigPath === "string" && message.projectConfigPath !== "") {
    const skipped =
      typeof message.projectSkipped === "string" && message.projectSkipped !== ""
        ? message.projectSkipped
        : null;
    rows.push(`<div class="hooks-path">${escapeHtml(`${t.hooksProjectFile}: ${message.projectConfigPath}`)}</div>`);
    // Always one of the two sentences. The path alone leaves the reader unable
    // to tell "there is no project file" from "there is one and it is loaded" —
    // and in this window it is never loaded. A missing sentence would read as
    // the second, which is the one thing that is not true.
    rows.push(
      skipped === null
        ? `<div class="hooks-path">${escapeHtml(t.hooksProjectAbsent)}</div>`
        : `<div class="hooks-skipped">${escapeHtml(t.hooksProjectSkipped(skipped))}</div>`,
    );
  }
  // The two facts that keep this from reading like "something was applied":
  // `reload` is a display refresh, and this command never writes.
  rows.push(`<div class="hooks-note">${escapeHtml(t.hooksReloadNote)}</div>`);
  rows.push(`<div class="hooks-note">${escapeHtml(t.hooksNoWriteNote)}</div>`);
  addNode(`<div class="hooks-report">${rows.join("")}</div>`);
  scrollToBottom();
}

function moveCommand(delta) {
  if (!commandState) return;
  commandState.index = (commandState.index + delta + commandState.matches.length) % commandState.matches.length;
  commandMenu.querySelectorAll(".command-row").forEach((row, index) => {
    row.classList.toggle("active", index === commandState.index);
  });
  commandMenu.children[commandState.index]?.scrollIntoView({ block: "nearest" });
}

/* ---------- @ file references ---------- */

const fileMention = $("file-mention");
let mention = null;

/** The `@fragment` under the caret, if the token starts a word. */
function mentionAtCaret() {
  const before = input.value.slice(0, input.selectionStart);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: input.selectionStart - match[2].length - 1, query: match[2] };
}

function updateMention() {
  updateCommandMenu();
  if (state.mentionTimer) clearTimeout(state.mentionTimer);
  const found = mentionAtCaret();
  if (!found) {
    closeMention();
    return;
  }
  mention = { ...found, files: [], index: 0 };
  // Debounce so typing does not walk the tree on every keystroke.
  state.mentionTimer = setTimeout(() => {
    if (mention) api.send({ cmd: "searchFiles", query: found.query });
  }, 120);
}

function renderMention(files, unavailable = false) {
  if (!mention) return;
  mention.files = files;
  mention.index = 0;
  fileMention.innerHTML = "";
  if (unavailable) {
    // The host answered, but the kernel it loaded cannot search (a stale
    // `dist/`). Saying "no matching file" would be a lie; the popup stays
    // open with the reason and the fix, and Enter still sends the message
    // because there is nothing to choose (D-184 ②, R3).
    mention.files = [];
    const note = document.createElement("div");
    note.className = "mention-hint";
    note.textContent = t.mentionSearchUnavailable;
    fileMention.appendChild(note);
    fileMention.hidden = false;
    return;
  }
  if (files.length === 0) {
    fileMention.hidden = true;
    return;
  }
  files.forEach((entry, index) => {
    // Entries are `{path, kind?}` since D-184 ①: the kernel searches
    // directories as well as files. A directory gets a trailing `/` so the two
    // kinds are distinguishable at a glance — both are valid `@` targets, but
    // picking a folder and picking a file are different plans.
    const path = typeof entry === "string" ? entry : String(entry?.path ?? "");
    const isDir = typeof entry === "object" && entry !== null && entry.kind === "dir";
    const row = document.createElement("button");
    row.className = `mention-row${index === 0 ? " active" : ""}`;
    row.setAttribute("role", "option");
    const cut = path.lastIndexOf("/");
    row.innerHTML =
      `<span class="mention-name">${escapeHtml(path.slice(cut + 1))}${isDir ? "/" : ""}</span>` +
      (cut > 0 ? `<span class="mention-dir">${escapeHtml(path.slice(0, cut))}</span>` : "");
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyMention(path);
    });
    fileMention.appendChild(row);
  });
  fileMention.hidden = false;
}

function closeMention() {
  mention = null;
  fileMention.hidden = true;
}

function applyMention(path) {
  if (!mention) return;
  const caret = input.selectionStart;
  const before = input.value.slice(0, mention.start);
  const after = input.value.slice(caret);
  const inserted = `@${path} `;
  input.value = `${before}${inserted}${after}`;
  const position = before.length + inserted.length;
  input.setSelectionRange(position, position);
  // The path is already in the text the user is writing, so it needs no entry
  // in `mentionFiles`: submit() appends that list as a separate path block,
  // and adding the path twice would list the same file twice.
  closeMention();
  autoSize();
  input.focus();
}

function moveMention(delta) {
  if (!mention || mention.files.length === 0) return;
  mention.index = (mention.index + delta + mention.files.length) % mention.files.length;
  fileMention.querySelectorAll(".mention-row").forEach((row, index) => {
    row.classList.toggle("active", index === mention.index);
  });
  fileMention.children[mention.index]?.scrollIntoView({ block: "nearest" });
}

input.addEventListener("input", updateMention);
input.addEventListener("click", updateMention);
input.addEventListener("blur", () => setTimeout(closeMention, 120));

/* ---------- notifications ---------- */

/** Only notify when the window is not in front; otherwise the UI already told them. */
function notifyIfAway(title, body) {
  if (!api.notify || !body) return;
  if (state.notifications === false) return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  void api.notify(title, body.slice(0, 180));
}

function summariseLastAssistant() {
  const turns = transcript.querySelectorAll(".turn.assistant .markdown");
  const last = turns[turns.length - 1];
  const text = last?.textContent?.trim() ?? "";
  return text.replace(/\s+/g, " ").slice(0, 160);
}

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * Draw the chip's occupancy percentage, or clear it.
 *
 * Three inputs, deliberately distinct (R3 — a figure nobody measured is not
 * zero):
 *   - a record with a finite `percent` is a measurement: show it and its
 *     window;
 *   - `null` says "no measurement for this transcript": clear the figure and
 *     hide the chip rather than paint a 0%;
 *   - `undefined` says "this event does not speak about occupancy at all" —
 *     a `state` event that only changed a mode — so the known figure stays.
 */
function applyContext(context) {
  // `undefined` = this event says nothing about occupancy (a mode change on
  // the same session): keep whatever is on screen.
  if (context === undefined) return;
  const percent = context === null ? Number.NaN : context.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    // `null`, or a record without a usable percentage: nothing was measured,
    // so the chip goes back to "unknown" rather than keeping a stale number.
    // Strings are rejected rather than coerced — a coerced `"40"` would look
    // like a measurement the kernel never sent.
    state.context = null;
    renderContextFigure();
    return;
  }
  state.context = {
    // A missing token count stays unknown rather than becoming 0: the
    // percentage is what was measured, and the count is not implied by it.
    tokens: typeof context.tokens === "number" && Number.isFinite(context.tokens) ? context.tokens : null,
    // Kept as reported (one decimal); only the chip rounds.
    percent,
    ...(typeof context.window === "number" && Number.isFinite(context.window) && context.window > 0
      ? { window: context.window }
      : {}),
  };
  // The tab is one glance wide, so it rounds; the popover keeps the kernel's
  // one-decimal figure. Both are fed from `state.context`, never from each
  // other, so they cannot drift.
  renderContextFigure();
  // The window is what turns the percentage into "how much is left"; the
  // model picker knows it too, but the kernel's figure wins when it sends one.
  if (state.context.window && state.context.window !== state.contextWindow) {
    state.contextWindow = state.context.window;
  }
}

/**
 * The composer meter is the session's token accounting: how full the context
 * window is, and what the conversation has spent so far. Clicking it opens the
 * breakdown instead of hiding the numbers in a tooltip.
 *
 * `usage` events are per model call, not per session — a tool-using turn writes
 * several. The popover's label says "this session", so a state event's running
 * total replaces the numbers while a live `usage` event adds to them.
 *
 * `replace` is about the token totals, not the transcript: `state` replaces
 * the session-level sum while still describing the same conversation. A
 * caller that is swapping transcripts (the `session_loaded` handler) passes
 * `context: null` so the previous session's percentage is not inherited —
 * that session's `state` event then supplies the real figure.
 */
function updateMeter(context, usage, { replace = false } = {}) {
  applyContext(context);
  if (usage) {
    const add = {
      inputTokens: Number(usage.inputTokens) || 0,
      outputTokens: Number(usage.outputTokens) || 0,
      cachedTokens: Number(usage.cachedTokens) || 0,
    };
    state.usage = replace
      ? add
      : {
          inputTokens: state.usage.inputTokens + add.inputTokens,
          outputTokens: state.usage.outputTokens + add.outputTokens,
          cachedTokens: state.usage.cachedTokens + add.cachedTokens,
        };
    // The bar under the composer used to carry the running spend; the bottom
    // row now shows the model and its context window instead, and the spend
    // lives in the popover this chip opens.
  }
  renderUsage();
}

/**
 * Take the session spend an event carries, if it carries one.
 *
 * `costUsd` is optional and its absence is meaningful: an old log has none,
 * and an unpriced provider never produces one. So an event that omits it
 * leaves the displayed figure alone — a `state` event without a cost is the
 * same session changing a mode, not a session that spent nothing. `replace`
 * is for a different transcript: there, an absent cost means unknown, so the
 * previous session's number is cleared rather than inherited. `null` is the
 * kernel saying "no price" and clears the number either way.
 */
function applyCost(message, { replace = false } = {}) {
  if (message && "costUsd" in message) {
    const cost = message.costUsd;
    state.costUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  } else if (replace) {
    state.costUsd = null;
  }
}

/**
 * Dollars with enough precision to stay non-zero: sub-cent spend is common in
 * a short session, and "$0.00" would read as "this cost nothing".
 *
 * Below a hundredth of a cent even four places round to zero, so that case is
 * spelled as a bound rather than as a zero. A real zero stays "$0.00" — the
 * kernel priced the call and the price was nothing, which is a fact.
 */
function formatCost(usd) {
  const value = Number(usd);
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0.00";
  if (value > 0 && value < 0.00005) return "<$0.0001";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Bring the status tab's context figure in line with what has been measured.
 *
 * The tab shows the occupancy **share**, not the window's size: a reader
 * glancing at it asks "how full is it", and the size is a property of the
 * model that belongs in the popover beside the tokens it measures. Before any
 * measurement the figure is an em dash — the same "unknown" the popover uses,
 * so the two never disagree about what is known (R3).
 */
function renderContextFigure() {
  const label = $("context-label");
  const measured = state.context !== null && typeof state.context?.percent === "number";
  if (label) {
    label.textContent = measured ? `${Math.min(100, Math.round(state.context.percent))}%` : "—";
    // Tabular figures: the label is a fixed-width slot, and a proportional
    // "9%" → "10%" reflows the tab by a pixel every time it ticks over.
    label.classList.toggle("unknown", !measured);
  }
  renderContextRing(measured ? state.context.percent : null);
}

/**
 * The ring around the context figure.
 *
 * Its dash offset is the measured share of the window. Two states are not a
 * percentage and must not be drawn as one (R3): no measurement yet leaves the
 * ring as a plain track — **not** a full circle. An unstyled `<circle>` has no
 * dash array, which paints the whole circumference: that read as "100 % used"
 * from the first frame until the first `context` event arrived. Setting the
 * array explicitly here makes the empty state honest.
 *
 * The transform rotation puts the arc's start at twelve o'clock.
 */
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * 6;

function renderContextRing(percent) {
  const ring = $("context-ring");
  if (!ring) return;
  const measured = typeof percent === "number" && Number.isFinite(percent);
  const share = measured ? Math.min(100, Math.max(0, percent)) / 100 : 0;
  ring.style.strokeDasharray = String(CONTEXT_RING_CIRCUMFERENCE);
  ring.style.strokeDashoffset = String(CONTEXT_RING_CIRCUMFERENCE * (1 - share));
  ring.classList.toggle("empty", !measured);
}

/** Fill the usage popover from state. Harmless while it is closed. */
function renderUsage() {
  const usage = state.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  $("usage-input-value").textContent = formatTokens(usage.inputTokens);
  $("usage-cached-value").textContent = formatTokens(usage.cachedTokens);
  $("usage-output-value").textContent = formatTokens(usage.outputTokens);
  $("usage-total-value").textContent = formatTokens(usage.inputTokens + usage.outputTokens);

  // The spend line is filled before the breakdown guard: a session can have a
  // cost and no split, and returning first would make the cost invisible. No
  // price means no row — a $0.00 would be a claim.
  const costRow = $("usage-cost-row");
  const costValue = $("usage-cost-value");
  if (costRow && costValue) {
    const cost = state.costUsd;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      costValue.textContent = formatCost(cost);
      costRow.hidden = false;
    } else {
      costValue.textContent = "—";
      costRow.hidden = true;
    }
  }

  const context = state.context;
  const headline = $("usage-context-value");
  if (!context) {
    // R3: nothing has measured this transcript. `—` is the only honest
    // headline, and an empty bar beats a chart of invented zeros.
    headline.textContent = "—";
    headline.removeAttribute("title");
    $("usage-stack").innerHTML = "";
    $("usage-breakdown").innerHTML = "";
    return;
  }

  const info = state.contextBreakdown;
  // Headline: used / window (percent) — the three facts the chip reduces to
  // one, spelled out where there is room for all three. The breakdown, when
  // one exists, carries the per-category split; without it the total
  // occupancy still states all three facts. An unknown half is `—`, not 0.
  // The percentage is the kernel's own figure, the same one the chip rounds,
  // so the two never disagree beyond the rounding the chip is allowed.
  const used = info ? info.used : context.tokens;
  const window = info && info.window > 0 ? info.window : context.window;
  const percent = info ? info.percent : context.percent;
  const usedText = Number.isFinite(used) ? formatTokens(used) : "—";
  const windowText = Number.isFinite(window) && window > 0 ? formatTokens(window) : "—";
  const percentText = Number.isFinite(percent) ? `${percent}%` : "—";
  const windowKnown = Number.isFinite(window) && window > 0;
  headline.textContent =
    `${usedText} / ${windowText} (${percentText})` +
    // A percentage of an assumed window is a percentage of a guess. Saying so
    // costs one marker and stops the meter from reading as an endpoint fact.
    (info?.windowAssumed ? ` ${t.usageWindowAssumed}` : "");
  if (info?.windowAssumed) headline.title = t.usageWindowAssumedHint;
  else if (windowKnown) headline.title = `${windowText} ${t.tokens}`;
  // No window reported: a title saying "— tokens" states a fact nobody has.
  else headline.removeAttribute("title");

  if (!info) {
    // This transcript has no split (an older log, or a kernel that measured
    // only the total): leave the chart empty rather than drawing the whole
    // window as one fabricated slice.
    $("usage-stack").innerHTML = "";
    $("usage-breakdown").innerHTML = "";
    return;
  }

  // A colour per category, in a fixed order so the same slice is the same
  // colour between sessions. The palette is the app's own four accents plus
  // neutral greys; it is not a data-viz scheme, because there is one bar and
  // the labels sit right below it.
  const COLORS = {
    messages: "var(--accent)",
    toolResults: "var(--accent-warm, #c98b4b)",
    mcpTools: "var(--accent-2, #4b9ac9)",
    systemTools: "var(--success, #4caf7d)",
    systemPrompt: "var(--text-faint)",
    memory: "var(--warn, #c9a24b)",
    instructions: "var(--accent-3, #9a7bd1)",
    rules: "var(--text-secondary)",
  };

  const total = info.window > 0 ? info.window : info.used;
  const parts = info.parts.filter((part) => part.tokens > 0);
  const free = Math.max(0, total - info.used);
  const compactHeadroom = Math.max(0, info.compactAt - info.used);

  const segments = [
    ...parts.map((part) => ({
      key: part.key,
      tokens: part.tokens,
      color: COLORS[part.key] ?? "var(--text-faint)",
    })),
    // The band between "now" and the compaction threshold is still free to
    // use; past that, compaction starts, so it is drawn as a separate, dimmer
    // slice rather than pretending the whole window is available.
    { key: "compactBuffer", tokens: compactHeadroom, color: "var(--border-strong)" },
    { key: "free", tokens: Math.max(0, free - compactHeadroom), color: "var(--surface-hover)" },
  ].filter((segment) => segment.tokens > 0);

  $("usage-stack").innerHTML = segments
    .map(
      (segment) =>
        `<span class="usage-slice" style="flex:${segment.tokens};background:${segment.color}" title="${escapeHtml(segment.key)}"></span>`,
    )
    .join("");

  const rows = parts
    .map(
      (part) =>
        `<div class="usage-part">` +
        `<span class="usage-swatch" style="background:${COLORS[part.key] ?? "var(--text-faint)"}"></span>` +
        `<span class="usage-part-label">${escapeHtml(t.contextPart(part.key))}</span>` +
        `<span class="usage-part-tokens">${formatTokens(part.tokens)}</span>` +
        `<span class="usage-part-pct">${((part.tokens / total) * 100).toFixed(1)}%</span>` +
        `</div>`,
    )
    .join("");
  const freeRow =
    `<div class="usage-part">` +
    `<span class="usage-swatch" style="background:var(--surface-hover)"></span>` +
    `<span class="usage-part-label">${escapeHtml(t.contextFree)}</span>` +
    `<span class="usage-part-tokens">${formatTokens(Math.max(0, free - compactHeadroom))}</span>` +
    `<span class="usage-part-pct">${((Math.max(0, free - compactHeadroom) / total) * 100).toFixed(1)}%</span>` +
    `</div>` +
    (compactHeadroom > 0
      ? `<div class="usage-part">` +
        `<span class="usage-swatch" style="background:var(--border-strong)"></span>` +
        `<span class="usage-part-label">${escapeHtml(t.contextCompactionBuffer)}</span>` +
        `<span class="usage-part-tokens">${formatTokens(compactHeadroom)}</span>` +
        `<span class="usage-part-pct">${((compactHeadroom / total) * 100).toFixed(1)}%</span>` +
        `</div>`
      : "");
  $("usage-breakdown").innerHTML = rows + freeRow;
}

function setUsagePopover(open) {
  const popover = $("usage-popover");
  if (!popover) return;
  popover.hidden = !open;
  $("usage-meter").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderUsage();
}

$("usage-meter").addEventListener("click", (event) => {
  event.stopPropagation();
  setUsagePopover($("usage-popover").hidden);
});

$("usage-meter").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setUsagePopover($("usage-popover").hidden);
  }
});

$("usage-reset").addEventListener("click", () => {
  // The host owns the counters; a fresh baseline keeps the display honest
  // without pretending the spend never happened.
  state.usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  renderUsage();
  setUsagePopover(false);
});

$("evidence-filter").addEventListener("click", () => {
  setEvidenceFilter(!state.evidenceOnly);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#usage-popover") && !event.target.closest("#usage-meter")) setUsagePopover(false);
});

/**
 * The permission presets this kernel implements (src/permissions/types.ts).
 *
 * The ported renderer shipped with six modes of a different runtime; only
 * these four exist here, and offering a mode the gate would ignore is worse
 * than offering four honest ones. `diagnose` is the default preset.
 */
const MODES = ["diagnose", "read-only", "workspace-write", "danger-full-access"];

function modeCopy(mode) {
  switch (mode) {
    case "read-only":
      return { label: t.modeReadOnly, desc: t.modeReadOnlyDesc };
    case "workspace-write":
      return { label: t.modeWorkspaceWrite, desc: t.modeWorkspaceWriteDesc };
    case "danger-full-access":
      return { label: t.modeDangerFullAccess, desc: t.modeDangerFullAccessDesc };
    default:
      return { label: t.modeDiagnose, desc: t.modeDiagnoseDesc };
  }
}

function renderModeMenu() {
  const menu = $("mode-menu");
  menu.innerHTML = MODES.map((mode) => {
    const copy = modeCopy(mode);
    const active = mode === state.mode;
    const recommended = mode === "diagnose" ? `<span class="mode-badge">${escapeHtml(t.modeRecommended)}</span>` : "";
    return (
      `<button role="menuitemradio" data-mode="${mode}" aria-checked="${active}"` +
      ` class="mode-option${active ? " active" : ""}">` +
      `<span class="mode-option-head"><span class="mode-option-label">${escapeHtml(copy.label)}</span>${recommended}</span>` +
      `<span class="mode-option-desc">${escapeHtml(copy.desc)}</span>` +
      `</button>`
    );
  }).join("");
}

function setMode(mode) {
  state.mode = mode;
  $("mode-label").textContent = modeCopy(mode).label;
  $("mode-label").removeAttribute("data-i18n");
  renderModeMenu();
}

/**
 * The reasoning levels the active model accepts.
 *
 * The host derives this from `providers.json` (`supportsReasoning`), so an
 * empty list is a fact: the model does not take the parameter. It is not a
 * prompt to guess a default set — offering `low`/`medium`/`high` to a model
 * whose request drops the field is the lie this list exists to avoid.
 */
function effortLevels() {
  return state.effortChoices?.levels ?? [];
}

/**
 * Show or hide the chip for the model the host just described.
 *
 * A model with no levels has nothing to choose: `auto` is the only value and
 * the request sends nothing, so the control would be a menu with one row that
 * cannot change anything. It stays hidden and the reason lives in the menu's
 * `note`, which the settings page and the refusal notice also carry.
 */
function syncEffortControl() {
  effortControl.hidden = effortLevels().length === 0;
}

function setEffort(effort) {
  state.effort = effort;
  $("effort-label").textContent = effort === "auto" ? t.effortAuto : effort;
  syncEffortControl();
  renderEffortMenu();
}

function renderEffortMenu() {
  const menu = $("effort-menu");
  const choices = state.effortChoices ?? {};
  // A model with one fixed level takes no parameter at all; saying so is
  // clearer than showing a single row the user cannot change.
  if (choices.fixed && effortLevels().length === 0) {
    menu.innerHTML =
      `<div class="effort-fixed">${escapeHtml(t.effortFixed.replace("{level}", choices.fixed))}</div>`;
    return;
  }
  // Only the levels the host says this model accepts — an empty list renders
  // no rows instead of a made-up `low`/`medium`/`high` set. `auto` is always
  // present: it is the way back to whatever `providers.json` defaults to, and
  // without it a level could never be un-set from this menu.
  const rows = [{ level: "auto", label: t.effortAuto }]
    .concat(effortLevels().map((level) => ({ level, label: level })));
  menu.innerHTML =
    rows
      .map((row) => {
        const active = row.level === state.effort;
        // What `auto` will actually send, so the user does not have to open
        // providers.json to find out.
        const hint = row.level === "auto" && choices.default
          ? `<span class="effort-hint">${escapeHtml(choices.default)}</span>`
          : "";
        return (
          `<button role="menuitemradio" data-effort="${escapeHtml(row.level)}" aria-checked="${active}"` +
          ` class="${active ? "active" : ""}">` +
          `<span>${escapeHtml(row.label)}</span>${hint}</button>`
        );
      })
      .join("") +
    // Why there is nothing to choose, when the host gave a reason. Dim, not a
    // warning: "this model takes no effort parameter" is a property of the
    // model, not a fault the operator caused.
    (choices.note ? `<div class="effort-fixed">${escapeHtml(choices.note)}</div>` : "");
}

/* ---------- model picker ---------- */

/** How many entries before the menu grows a filter field. Below this the field
 *  costs more (a row, a tab stop) than it saves. */
const MODEL_FILTER_THRESHOLD = 8;

/**
 * Display names and vendor attribution, read fresh from localStorage.
 *
 * The settings page writes them on Save; this panel only reads. Reading on
 * every draw (rather than caching) is what makes a renamed service show up the
 * next time the panel opens, and a storage that cannot be reached degrades to
 * "nothing stored" — the service name is the honest fallback.
 */
function providerMeta() {
  let storage = null;
  try {
    storage = typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    storage = null;
  }
  return readProviderMeta(storage);
}

/** The part of a `provider/model` reference the picker calls the model. */
function modelNameOf(model) {
  if (model.name) return model.name;
  const slash = model.id.indexOf("/");
  return slash < 0 ? model.id : model.id.slice(slash + 1);
}

function providerOf(id) {
  const slash = id.indexOf("/");
  return slash < 0 ? "" : id.slice(0, slash);
}

/**
 * What the chip says.
 *
 * A model name is what the user is choosing; the gateway that serves it is a
 * detail of where it came from. So the bare name wins whenever it identifies
 * one entry — and `provider/model` comes back only when two providers offer a
 * model of the same name, where the short form would be a lie. The full id is
 * always in the title, so the reference is never lost.
 */
function modelChipLabel(id) {
  const entry = state.models.find((model) => model.id === id) ?? { id };
  const name = modelNameOf(entry);
  // Compared against the catalogue, not against the reference: "is this name
  // ambiguous here" is a fact about the list, not about the string.
  const sameName = state.models.filter((model) => modelNameOf(model) === name);
  return sameName.length > 1 ? id : name;
}

function renderModels(models, current, source, error) {
  state.models = models || [];
  state.model = current;
  state.modelsSource = source || "";
  state.modelsError = error || "";
  // A reference the catalogue does not contain cannot be run: the host would
  // reject it and the chip would be naming a model the user cannot pick. Say
  // so instead of printing an id that is not on the list.
  const known = Boolean(current) && state.models.some((model) => model.id === current);
  if (known) {
    modelLabel.textContent = modelChipLabel(current);
    // applyLocale rewrites every [data-i18n] node from the dictionary, so
    // leaving the attribute on would put "loading models…" back the next time
    // the user switches language — after the real model name had been shown.
    modelLabel.removeAttribute("data-i18n");
    modelPicker.classList.remove("unavailable");
    // The meter is a share of the model's real context, not a placeholder.
    // Only the stored window changes here: the figure on the tab is the
    // measured share, and switching models does not un-measure the transcript.
    const active = state.models.find((model) => model.id === current);
    if (active && Number.isFinite(active.contextLength)) state.contextWindow = active.contextLength;
  } else {
    // Nothing to show: the label must still leave the loading state, or the
    // chip spins forever on a misconfigured endpoint. The key goes *on* here
    // rather than off: this text is dictionary text, so a later language
    // switch must rewrite it — and going back to `loadingModels` would put the
    // spinner back on a chip that has already given up.
    modelLabel.textContent = t.modelsUnavailable;
    modelLabel.setAttribute("data-i18n", "modelsUnavailable");
    modelPicker.classList.add("unavailable");
  }
  modelPicker.title = state.modelsError || (known ? current : t.refreshModels);
  if (!modelMenu.hidden) renderModelMenu();
}

/** Rows grouped by provider; a single provider is one unnamed group. */
function modelGroups() {
  const groups = new Map();
  for (const model of state.models) {
    const provider = providerOf(model.id);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(model);
  }
  return [...groups].map(([provider, models]) => ({ provider, models }));
}

/**
 * The rail's rows: one per configured service (one card, one API key), with
 * the display name and vendor the settings page stored for it.
 *
 * A service is the grouping unit, not the vendor: two DeepSeek keys hold
 * different credentials and different model lists, so merging them under one
 * vendor row would hide which key a model comes from.
 */
function modelRailRows() {
  return providerRailRows(modelGroups(), providerMeta());
}

/** Current filter text; empty when the field is not on screen. */
function modelFilterValue() {
  const field = modelMenu.querySelector(".model-filter-input");
  return field ? field.value.trim().toLowerCase() : "";
}

/**
 * The listbox inside the popover, or null when the menu has not been drawn.
 *
 * `#model-menu` from the document is the positioned box; the listbox has to be
 * its own element because a `role="listbox"` may only contain options and
 * groups — the filter field and the refresh button are neither. The wrapper's
 * own `role="listbox"` (in index.html) is replaced below.
 */
function modelListbox() {
  return modelMenu.querySelector(".model-list");
}

/**
 * The element that actually holds focus while the menu is open.
 *
 * Only one of them exists at a time: the filter field when there are enough
 * models to be worth filtering (it is the combobox), otherwise the listbox
 * itself. Either way `aria-activedescendant` goes on whatever has focus, which
 * is what makes the highlight audible without a `tabindex` on every row.
 */
function modelFocusHolder() {
  return modelMenu.querySelector(".model-filter-input") ?? modelListbox();
}

/** The highlighted option's id, or "" when nothing is highlighted. */
function modelHighlightId() {
  const holder = modelFocusHolder() ?? modelMenu;
  return holder.getAttribute("aria-activedescendant") || "";
}

function setModelHighlight(option) {
  for (const node of modelMenu.querySelectorAll('.model-option[data-highlight="1"]')) {
    node.removeAttribute("data-highlight");
  }
  const holder = modelFocusHolder();
  if (!holder) return;
  holder.removeAttribute("aria-activedescendant");
  if (!option) return;
  option.dataset.highlight = "1";
  holder.setAttribute("aria-activedescendant", option.id);
  option.scrollIntoView({ block: "nearest" });
}

/** Visible options, ignoring separators and the footer. */
function modelOptions() {
  return [...modelMenu.querySelectorAll(".model-option")];
}

/** Move the highlight by `step`, clamped: the list is not a ring, so running
 *  past the end would land the user back where they started. */
function moveModelHighlight(step) {
  const options = modelOptions();
  if (options.length === 0) return;
  const at = options.findIndex((option) => option.id === modelHighlightId());
  const next = at < 0 ? (step > 0 ? 0 : options.length - 1) : Math.min(options.length - 1, Math.max(0, at + step));
  setModelHighlight(options[next]);
}

/** Put the highlight on the model in use, or the first row when there is none. */
function focusModelMenuSelection() {
  const options = modelOptions();
  if (options.length === 0) {
    modelMenu.removeAttribute("aria-activedescendant");
    return;
  }
  const active = options.find((option) => option.dataset.model === state.model);
  setModelHighlight(active ?? options[0]);
}

function chooseModel(id) {
  if (id !== state.model) api.send({ cmd: "setModel", model: id });
  closeModelMenu({ restoreFocus: true });
}

function renderModelMenu() {
  const filter = modelFilterValue();
  // The highlight is an id pointing at a row about to be discarded; remember
  // which model it was so a rebuild (a `models` event, a language switch) can
  // put it back instead of silently dropping the keyboard position.
  const previous = modelMenu.querySelector('[data-highlight="1"]')?.dataset.model;
  // Same reason for focus: rebuilding while the filter field is focused
  // detaches it, and a detached node cannot keep the caret.
  const hadFocus = !modelMenu.hidden && modelMenu.contains(document.activeElement);
  modelMenu.innerHTML = "";
  // The wrapper is a plain box now; the listbox below carries the role.
  modelMenu.removeAttribute("role");
  const filterable = state.models.length > MODEL_FILTER_THRESHOLD;

  if (state.models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = t.modelsUnavailable;
    modelMenu.appendChild(empty);
    // An empty list with no way to fill it is a dead end. The model services
    // live in settings, so offer the step that actually fixes this.
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "model-empty-action";
    fix.textContent = t.modelsOpenSettings;
    fix.addEventListener("click", () => {
      closeModelMenu();
      openSettings("connection");
    });
    modelMenu.appendChild(fix);
    modelMenu.appendChild(buildModelFooter());
    if (hadFocus) fix.focus();
    return;
  }

  const list = document.createElement("div");
  list.className = "model-list";
  // Stable id: the filter field points at it with `aria-controls`.
  list.id = "model-options";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t.modelPickerLabel);
  // Without a filter field the listbox holds the focus itself; with one, the
  // field does and points at the rows through `aria-activedescendant`.
  if (!filterable) list.tabIndex = 0;

  // One provider is not a grouping, it is a label above every row saying the
  // same thing; the chip already names where the model came from.
  const groups = modelGroups();
  // The rail's rows carry what the groups cannot: a human label and a vendor
  // icon for each service. Read once per draw so the list and the rail come
  // from the same snapshot of localStorage.
  const railRows = modelRailRows();
  const showGroups = groups.length > 1;
  // Which provider the right-hand list is showing. The rail is a view filter,
  // not a selection: switching providers must not switch models, so this is
  // renderer-local state, reset to the model in use whenever none is set.
  if (showGroups && !groups.some((group) => group.provider === state.modelRailProvider)) {
    state.modelRailProvider = providerOf(state.model ?? "");
  }
  const shownGroups = showGroups
    ? groups.filter((group) => group.provider === state.modelRailProvider)
    : groups;
  const shownRail = railRows.find((row) => row.id === state.modelRailProvider);
  let shown = 0;
  for (const group of shownGroups) {
    const matches = filter
      ? group.models.filter((model) => `${model.id} ${modelNameOf(model)}`.toLowerCase().includes(filter))
      : group.models;
    if (matches.length === 0) continue;
    // A `role="group"` with a label, not a heading: a listbox may not contain
    // arbitrary text, and this is exactly what group labelling is for. When
    // the rail is on screen it already names the provider, so no visible
    // caption is drawn here — but the label stays for assistive tech, which
    // does not see the rail as a group heading either.
    const section = document.createElement("div");
    if (showGroups) {
      section.setAttribute("role", "group");
      section.setAttribute(
        "aria-label",
        railRows.find((row) => row.id === group.provider)?.displayName ?? group.provider,
      );
    }
    for (const model of matches) {
      shown += 1;
      section.appendChild(buildModelOption(model));
    }
    list.appendChild(section);
  }

  if (shown === 0) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = t.modelsNoMatch;
    list.appendChild(empty);
  }

  // The panel is a row of two columns: an optional provider rail, then a body
  // that holds the header (title or filter), the list, and the refresh row.
  // The rail is left out entirely when there is one provider — see
  // `showGroups` above — so the panel collapses to the single column it was.
  const body = document.createElement("div");
  body.className = "model-body";

  if (filterable) {
    const field = document.createElement("input");
    field.className = "model-filter-input";
    field.type = "search";
    field.spellcheck = false;
    field.autocomplete = "off";
    field.placeholder = t.modelsFilterPlaceholder;
    field.setAttribute("aria-label", t.modelsFilterPlaceholder);
    // The field drives the listbox, so it is the combobox; the listbox is
    // named by it and the two are linked rather than nested.
    field.setAttribute("role", "combobox");
    field.setAttribute("aria-expanded", "true");
    field.setAttribute("aria-controls", "model-options");
    field.setAttribute("aria-autocomplete", "list");
    field.value = filter;
    // `renderModelMenu` re-focuses the rebuilt field itself (it remembers
    // `hadFocus`); doing it here as well would fight that on every keystroke.
    field.addEventListener("input", () => renderModelMenu());
    // Above the list on screen: a combobox is expected before the list it
    // controls, and the caret is at the top of the panel.
    body.appendChild(field);
  } else if (showGroups) {
    // The rail replaced the per-row group captions, so the header names what
    // the right column is showing rather than leaving the column anonymous.
    // The display name is the label; the service key is the tooltip, so the
    // `service/model` reference is never lost.
    const head = document.createElement("div");
    head.className = "model-head";
    head.textContent = shownRail?.displayName ?? state.modelRailProvider;
    if (shownRail && shownRail.id !== shownRail.displayName) head.title = shownRail.id;
    body.appendChild(head);
  }

  body.append(list, buildModelFooter());
  modelMenu.append(...(showGroups ? [buildProviderRail(railRows), body] : [body]));

  // Put the highlight back where it was. `previous` survives the rebuild only
  // as a model id, so a filtered-out row correctly leaves nothing highlighted
  // until the next arrow key rather than pointing at a row that is gone.
  const restored = previous ? modelOptions().find((option) => option.dataset.model === previous) : undefined;
  if (restored) setModelHighlight(restored);

  if (hadFocus) {
    const field = modelMenu.querySelector(".model-filter-input");
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    } else {
      modelListbox()?.focus();
    }
  }
}

/**
 * The provider rail: one row per configured service (one card, one API key).
 *
 * Each row is the vendor's mark and the service's display name. The vendor
 * glyph tells "which company", the name tells "which key" — two DeepSeek keys
 * share the glyph and are told apart by the label the settings page stored.
 * A vendor with no mark (a custom or hand-written service) gets the same
 * two-letter monogram the rail has always used; nothing is invented (R3).
 *
 * It is a `tablist` over the model list, not a second listbox: picking a
 * service narrows what the list shows, it does not choose a model. Arrow
 * Up/Down stay with the model list; Arrow Left/Right and Home/End move here,
 * which is why this is a real tab control rather than a column of buttons.
 */
function buildProviderRail(rows) {
  const rail = document.createElement("div");
  rail.className = "model-rail";
  rail.setAttribute("role", "tablist");
  rail.setAttribute("aria-orientation", "vertical");
  rail.setAttribute("aria-label", t.modelProvidersLabel);
  for (const row of rows) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "model-rail-mark";
    tab.dataset.provider = row.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(row.id === state.modelRailProvider));
    tab.tabIndex = row.id === state.modelRailProvider ? 0 : -1;
    tab.append(modelRailMark(row), modelRailLabel(row));
    // The row is an icon plus a label; the tab's accessible name is the whole
    // of what it means, and the service key stays reachable when the label
    // differs from it.
    tab.setAttribute("aria-label", row.id === row.displayName ? row.displayName : `${row.displayName} (${row.id})`);
    tab.title = row.id === row.displayName ? row.displayName : `${row.displayName} · ${row.id}`;
    // A click leaves focus on the list rather than the row: the reason to
    // click a provider is to pick one of its models, and the arrow keys have
    // to keep working for that.
    tab.addEventListener("click", () => selectModelRailProvider(row.id, { focusRail: false }));
    rail.appendChild(tab);
  }
  return rail;
}

/** The vendor glyph, or the monogram for a service with no known vendor. */
function modelRailMark(row) {
  const mark = row.vendor ? VENDOR_MARKS[row.vendor] : undefined;
  if (!mark) {
    const fallback = document.createElement("span");
    fallback.className = "model-rail-monogram";
    fallback.setAttribute("aria-hidden", "true");
    fallback.textContent = providerMark(row.id);
    return fallback;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "model-rail-glyph");
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

function modelRailLabel(row) {
  const label = document.createElement("span");
  label.className = "model-rail-label";
  label.textContent = row.displayName;
  return label;
}

/**
 * Switch which provider the list shows. The chosen model does not change.
 *
 * The rebuild replaces the rail, so focus has to land somewhere live: on the
 * newly selected mark when the user was working in the rail, and back on the
 * list (or the filter) when the switch came from a click on a mark — a click
 * that leaves focus nowhere would strand the keyboard user in the panel.
 */
function selectModelRailProvider(provider, { focusRail = true } = {}) {
  if (state.modelRailProvider === provider) return;
  state.modelRailProvider = provider;
  renderModelMenu();
  if (focusRail) {
    modelMenu.querySelector(`.model-rail-mark[data-provider="${CSS.escape(provider)}"]`)?.focus();
    return;
  }
  const field = modelMenu.querySelector(".model-filter-input");
  if (field) {
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    return;
  }
  modelListbox()?.focus();
  focusModelMenuSelection();
}

/** Move the rail selection by `step`, clamped the same way the list is. */
function moveModelRailProvider(step) {
  const tabs = [...modelMenu.querySelectorAll(".model-rail-mark")];
  if (tabs.length === 0) return;
  const at = tabs.findIndex((tab) => tab.dataset.provider === state.modelRailProvider);
  // Clamped, not wrapped: the list order is the config file's order, and
  // running off the end back to the first provider reads as a jump, not a step.
  const next = Math.min(tabs.length - 1, Math.max(0, (at < 0 ? 0 : at) + step));
  const provider = tabs[next]?.dataset.provider;
  if (provider === undefined) return;
  if (provider === state.modelRailProvider) {
    tabs[next].focus();
    return;
  }
  // Remember where focus was: a rebuild rejects a detached node, so the
  // caller's "was I on the rail" answer has to be read now.
  const fromRail = Boolean(document.activeElement?.closest?.(".model-rail"));
  selectModelRailProvider(provider, { focusRail: fromRail || !modelFocusHolder() });
}

function buildModelOption(model) {
  const selected = model.id === state.model;
  const option = document.createElement("button");
  option.type = "button";
  option.className = `model-option${selected ? " active" : ""}`;
  // The id is what the highlight points at; models can differ only by the
  // provider, so the reference itself is the stable key.
  option.id = `model-option-${model.id.replace(/[^\w-]/g, "-")}`;
  option.dataset.model = model.id;
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", String(selected));
  // The reference, not the bare name, is what the user is choosing; keep it on
  // hover even when the row shows only the short form. Selection reaches a
  // screen reader through `aria-selected` and the eye through the check mark,
  // so neither has to rely on the tint alone.
  option.title = model.id;
  const provider = providerOf(model.id);
  const detail = [
    model.supportsReasoning ? t.modelTagReasoning : "",
    model.supportsVision ? t.modelTagVision : "",
    Number.isFinite(model.contextLength) && model.contextLength > 0
      ? t.modelContextLength(formatContext(model.contextLength))
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  option.innerHTML =
    `<span class="model-mark" aria-hidden="true">${icon("check")}</span>` +
    `<span class="model-text">` +
    `<span class="model-name">${escapeHtml(modelNameOf(model))}</span>` +
    (provider || detail
      ? `<span class="model-meta">${escapeHtml([provider, detail].filter(Boolean).join(" · "))}</span>`
      : "") +
    `</span>`;
  option.addEventListener("click", () => chooseModel(model.id));
  return option;
}

function buildModelFooter() {
  const footer = document.createElement("button");
  footer.type = "button";
  footer.className = "model-refresh";
  footer.innerHTML = `${icon("refresh", "inline")}<span>${escapeHtml(t.refreshModels)}</span>`;
  footer.addEventListener("click", () => {
    modelMenu.innerHTML = `<div class="model-empty">${escapeHtml(t.loadingModels)}</div>`;
    api.send({ cmd: "refreshModels" });
  });
  return footer;
}

function formatContext(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function openModelMenu() {
  renderModelMenu();
  modelMenu.hidden = false;
  // `aria-expanded` mirrors the popover, not the chip's own state: it is the
  // chip that claims `aria-haspopup`, so it is the chip that reports open.
  modelPicker.setAttribute("aria-expanded", "true");
  // Focus goes to the field when filtering is possible (the user opening a
  // long list is usually looking for one entry) and to the listbox otherwise,
  // which is where the arrow keys drive `aria-activedescendant` from.
  const field = modelMenu.querySelector(".model-filter-input");
  if (field) field.focus();
  else modelListbox()?.focus();
  focusModelMenuSelection();
}

/**
 * `restoreFocus` puts the caret back on the chip. A selection or Escape does
 * that; a click elsewhere must not steal focus from wherever the user went.
 */
function closeModelMenu({ restoreFocus = false } = {}) {
  const wasOpen = !modelMenu.hidden;
  modelMenu.hidden = true;
  // The listbox and its field are rebuilt on every open, so the highlight is
  // cleared with them; clearing it here as well keeps a closed menu from
  // keeping a stale reference if something queries it before the next draw.
  for (const node of modelMenu.querySelectorAll("[aria-activedescendant]")) {
    node.removeAttribute("aria-activedescendant");
  }
  modelPicker.setAttribute("aria-expanded", "false");
  if (restoreFocus && wasOpen) modelPicker.focus();
}

/**
 * Keys that arrive while the menu is open. Returns true when consumed.
 *
 * Registered before the window's other key handlers, so the innermost surface
 * wins: Escape must dismiss this menu, not the conversation behind it.
 */
function handleModelMenuKey(event) {
  if (modelMenu.hidden) return false;
  const key = event.key;
  // The provider rail is a tablist, so the keys that move around it are the
  // rail's own: Left/Right step, Home/End jump. They are handled before the
  // focus check below because a click on a rail mark moves focus to that mark,
  // which is not the list's focus holder — the list must not swallow the key.
  const onRail = Boolean(document.activeElement?.closest?.(".model-rail"));
  if (onRail) {
    if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      moveModelRailProvider(key === "ArrowRight" ? 1 : -1);
      return true;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      moveModelRailProvider(key === "Home" ? -Infinity : Infinity);
      return true;
    }
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModelMenu({ restoreFocus: true });
      return true;
    }
    if (key === "ArrowDown" || key === "Enter") {
      // Stepping into the list from the rail is the expected continuation of
      // "I picked a provider, now pick a model".
      event.preventDefault();
      modelListbox()?.focus();
      focusModelMenuSelection();
      return true;
    }
    // Anything else belongs to whatever has focus (the rail is not a text
    // field today, so this is only a guard against swallowing a stray key).
    return false;
  }
  // Only act on keys aimed at this menu. A global listener would otherwise
  // swallow arrows typed into the composer while the menu happens to be open.
  const holder = modelFocusHolder();
  if (!holder || !(holder === document.activeElement || holder.contains(document.activeElement))) return false;
  // While the rail is on screen, Left/Right move between providers, which is
  // the same gesture the rail itself offers; Up/Down keep moving the highlight.
  // Not while the filter field has focus: there Left/Right are the caret.
  if (
    (key === "ArrowLeft" || key === "ArrowRight") &&
    !holder.classList.contains("model-filter-input") &&
    modelMenu.querySelector(".model-rail")
  ) {
    event.preventDefault();
    moveModelRailProvider(key === "ArrowRight" ? 1 : -1);
    return true;
  }

  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    moveModelHighlight(key === "ArrowDown" ? 1 : -1);
    return true;
  }
  // Home/End belong to the caret while the user is typing in the filter;
  // taking them there would move the list instead of the cursor.
  const inFilter = holder.classList.contains("model-filter-input");
  if ((key === "Home" || key === "End") && !inFilter) {
    event.preventDefault();
    const options = modelOptions();
    const target = key === "Home" ? options[0] : options[options.length - 1];
    if (target) setModelHighlight(target);
    return true;
  }
  if (key === "Enter") {
    const options = modelOptions();
    const chosen = options.find((option) => option.id === modelHighlightId());
    // Nothing highlighted means nothing was chosen; sending the first row
    // would switch models on a keystroke the user did not aim at a row.
    if (!chosen) return false;
    event.preventDefault();
    chooseModel(chosen.dataset.model);
    return true;
  }
  if (key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeModelMenu({ restoreFocus: true });
    return true;
  }
  if (key === "Tab") {
    // Tabbing out of a listbox is a dismissal, not a selection. The browser
    // moves the focus; the menu just gets out of the way.
    closeModelMenu();
    return false;
  }
  // Typing is not a mis-aimed arrow key: only keys that are real commands are
  // swallowed, so the filter field keeps receiving ordinary characters.
  return false;
}

/* ---------- host events ---------- */

function handleEvent(message) {
  switch (message.type) {
    case "hello":
      setStatus("statusConnecting");
      break;

    case "ready": {
      setBusy(false);
      if (state.statusKey !== "statusError") setStatus("statusReady");
      // A launch starts with no session open, deliberately.
      //
      // This used to reopen whatever conversation the window was last in
      // (`prometheus.lastSession` + the "reopen last session" setting). The
      // user asked for the opposite: the window should open empty. The
      // remembered-id approach also had a failure mode that made the choice
      // for us: when that session directory was deleted or its `header.json`
      // was damaged, the automatic `loadSession` pushed an error notice onto
      // a window that had just opened and had nothing the user wanted to do.
      // Opening a conversation is a sidebar click; the sidebar already lists
      // them, so there is nothing to restore automatically.
      if (state.needsSetup) {
        state.needsSetup = false;
        $("setup-button").hidden = true;
        addNode(`<div class="notice dim">${escapeHtml(t.setupBody)}</div>`, { keepEmptyState: true });
      }
      break;
    }

    case "setup_checklist": {
      state.setupChecklist = message.checks ?? [];
      // Shown once, on an empty conversation: a returning user does not need
      // to be told their toolchains again.
      const missing = state.setupChecklist.filter((check) => !check.ok);
      if (missing.length === 0 || localStorage.getItem("prometheus.setupDismissed") === "1") break;
      // A conversation with history is not a first run.
      if (state.sessions.length > 0) break;
      const rows = missing
        .map(
          (check) =>
            `<div class="setup-row"><div class="setup-label">${escapeHtml(check.label)}</div>` +
            `<div class="setup-detail">${escapeHtml(check.detail)}</div>` +
            (check.hint ? `<pre class="setup-hint">${escapeHtml(check.hint)}</pre>` : "") +
            `</div>`,
        )
        .join("");
      addNode(
        `<div class="notice setup"><div class="setup-head">${escapeHtml(t.setupChecklistTitle)}</div>${rows}` +
          `<button class="link-button" id="setup-dismiss">${escapeHtml(t.setupChecklistDismiss)}</button></div>`,
        // A checklist is the shell reporting on this machine, not a turn; the
        // first screen keeps its introduction underneath it.
        { keepEmptyState: true },
      );
      $("setup-dismiss")?.addEventListener("click", () => {
        localStorage.setItem("prometheus.setupDismissed", "1");
        document.querySelector(".notice.setup")?.remove();
      });
      break;
    }

    case "state":
      state.sessionId = message.sessionId;
      // Nothing is remembered here any more. `prometheus.lastSession` used to
      // be written on every state event so the next launch could reopen this
      // conversation; the launch no longer restores anything (see `ready`), so
      // keeping the write would leave a key nothing reads.
      if (message.cwd) state.cwd = message.cwd;
      state.locale = message.locale || state.locale;
      applyLocale(state.locale);
      // Sandbox state first: the mode label marks "auto" when it runs without
      // isolation, so it has to know before the label is drawn.
      if (message.sandbox) state.sandbox = message.sandbox;
      if (message.effortChoices) state.effortChoices = message.effortChoices;
      // A state event speaks for the whole transcript: it either brings a
      // fresh split or says there is none. An absent field falls back to
      // `null` because this event replaces the occupancy too — keeping the
      // previous split beside a new total would describe two different
      // measurements at once.
      state.contextBreakdown = message.contextBreakdown ?? null;
      setMode(message.mode);
      setEffort(message.effort || "auto");
      // A state event may arrive before the catalogue has been fetched; keep
      // whatever we already have rather than blanking the picker back to
      // "loading models…".
      if (Array.isArray(message.models) && message.models.length > 0) {
        renderModels(message.models, message.model, state.modelsSource);
      } else if (message.model) {
        renderModels(state.models, message.model, state.modelsSource);
      }
      state.cwd = message.cwd;
      renderTopbarLocation();
      // A state event carries session-level totals: replace, never add. It
      // may also carry spend and occupancy (the host attaches them when it
      // opens a stored session). An event that omits either is the same
      // session changing a mode, so `undefined` leaves the figure on screen;
      // an explicit `null` is the protocol saying "no measurement", which
      // clears the chip instead of keeping a stale percentage.
      applyCost(message);
      updateMeter(message.context, message.usage, { replace: true });
      break;

    case "device_status":
      // The probe's report used to feed the Board pane and its composer chip;
      // both are gone (2026-10-26). The tool's own row and output in the
      // transcript are what report a device now, so the event is consumed and
      // deliberately draws nothing rather than falling into the "unhandled
      // host event" debug line.
      break;

    case "serial_snapshot":
      state.serial.open = Boolean(message.open);
      state.serial.port = message.port ?? null;
      state.serial.baud = message.baud ?? null;
      if (message.encoding) {
        // Same authority rule as `serial_state`: the host opened the port and
        // chose the codec, so the control reflects that choice.
        state.serial.encoding = message.encoding;
        const select = $("serial-encoding");
        if (select && select.value !== message.encoding) select.value = message.encoding;
      }
      // A `reconfigured` snapshot accompanies a codec or baud change on a live
      // session: keep the transcript, only sync the controls.
      if (message.mode !== "reconfigured") {
        state.serial.lines = message.lines ?? [];
      }
      fillSerialControls();
      rerenderSerialLines();
      break;

    case "serial_state":
      setSerialState(message);
      break;

    case "serial_lines":
      // The host sends its running total; assign, don't accumulate — adding
      // made the counter climb by the same figure on every flush forever.
      state.serial.dropped = message.dropped ?? state.serial.dropped ?? 0;
      if (state.serial.paused) {
        // Data still arrives; the DOM just stops moving. The ring is the host's,
        // so resuming re-reads nothing — the backlog count is what the user sees.
        state.serial.lines.push(...(message.lines ?? []));
        if (state.serial.lines.length > SERIAL_MAX_LINES) {
          state.serial.lines.splice(0, state.serial.lines.length - SERIAL_MAX_LINES);
        }
        state.serial.pausedBacklog += (message.lines ?? []).length;
        renderSerialStatus();
      } else {
        appendSerialLines(message.lines ?? []);
      }
      break;

    case "serial_agent_write":
      // The agent's write enters the transcript like any other send, tagged
      // so the operator can tell who drove the port — the animation alone
      // leaves no record once it finishes.
      appendSerialLines([
        {
          text: message.hex === true ? hexViewOfHex(String(message.data ?? "").replace(/\s+/g, "")) : String(message.data ?? "").replace(/\r\n$/, ""),
          at: Date.now(),
          level: "info",
          dir: "tx",
          tag: t.serialSenderAgent,
        },
      ]);
      replayAgentWrite(message);
      break;

    case "serial_cleared":
      state.serial.lines = [];
      state.serial.filtered = 0;
      $("serial-output").innerHTML = "";
      renderSerialStatus();
      break;

    case "serial_ports":
      state.serialPorts = message.ports ?? [];
      fillSerialControls();
      break;

    case "serial_stats":
      // The pump counts on the wire; a host-side estimate would drift from
      // what actually left the adapter. Display-only.
      if (message.port === state.serial.port) {
        state.serial.rxBytes = message.rx;
        state.serial.txBytes = message.tx;
        renderSerialCounters();
      }
      break;

    case "models":
      renderModels(message.models, message.model, message.source, message.error);
      break;

    case "changes":
      state.changes = {
        files: message.files ?? [],
        additions: message.additions ?? 0,
        deletions: message.deletions ?? 0,
        lastTurn: message.lastTurn ?? { files: [], additions: 0, deletions: 0 },
      };
      if (message.files?.length > 0 && !message.files.some((file) => file.path === state.selectedChange)) {
        state.selectedChange = message.files[0].path;
      }
      renderChangesPanel();
      renderChangesBadge();
      if (state.pane === "diff" && !workbench.hidden) renderDiff();
      break;

    case "artifacts":
      state.artifacts = message.artifacts ?? [];
      renderArtifacts();
      break;

    case "artifact":
      renderArtifact(message.artifact);
      break;

    case "file_matches":
      // `unavailable` is the stale-`dist/` state (D-184 ②). It rides on every
      // answer, not just the first, because a one-time notice is easy to miss
      // and an empty list alone reads as "no matching file".
      if (message.query === mention?.query) {
        renderMention(message.files ?? [], message.unavailable === true);
      }
      break;

    case "export_ready":
      exportSessionFile(message.markdown, message.filename);
      break;

    case "commands":
      // Stored exactly as reported: this list is the host's capability answer,
      // not a display list. `commandList()` merges the local copy on read so a
      // locale switch re-labels the menu without asking the host again.
      state.commands = Array.isArray(message.commands) ? message.commands : [];
      break;

    case "context_report": {
      // `/context` typed in the composer: the same figures the popover shows,
      // stated in the transcript where the user was already looking.
      const parts = (message.parts ?? [])
        .filter((part) => part.tokens > 0)
        .map((part) => `${t.contextPart(part.key)} ${formatTokens(part.tokens)}`);
      const used = `${formatTokens(message.used)} / ${formatTokens(message.window)} (${message.percent}%)`;
      addNotice("dim", `[${used}] ${parts.join(" · ")}`);
      scrollToBottom();
      break;
    }

    case "command_expanded":
      // A built-in reports an empty prompt: it ran, it did not expand into
      // text. Saying "the model was asked" about `/clear` would be a lie.
      addNotice("dim", message.prompt === "" ? `/${message.name}` : `/${message.name} → ${message.prompt.slice(0, 120)}`);
      break;

    case "file":
      renderFilePreview(message.file);
      break;

    case "terminal_output":
      appendTerminalText(message.text ?? "");
      break;

    case "terminal_state":
      setTerminalState(message);
      break;

    case "git_status":
      state.git = message;
      renderGitBar();
      break;

    case "pr_status":
      state.pr = message;
      renderPrBar();
      break;

    case "pr_created":
      if (message.ok) {
        addNotice("dim", `${t.prCreated} ${message.url ?? ""}`);
        api.send({ cmd: "prStatus" });
      } else {
        addNotice("warn", `${t.prFailed} ${message.error ?? ""}`);
      }
      break;

    case "git_commit": {
      const note = $("git-commit-note");
      if (message.ok) {
        note.textContent = t.commitDone;
        $("git-message").value = "";
        addNode(`<div class="notice dim">${escapeHtml(t.commitDone)} ${escapeHtml(message.summary ?? "")}</div>`);
        scrollToBottom();
      } else {
        note.textContent = `${t.commitFailed} ${message.error ?? ""}`;
      }
      break;
    }

    case "settings":
      settings.handleEvent(message);
      break;

    case "rules":
      settings.handleEvent(message);
      break;

    case "provider_test":
      // The settings page owns the per-card state this answers, but it is not
      // in the renderer's event vocabulary until it arrives here: an event no
      // branch matches is dropped, which would leave the Test button spinning
      // until its own timeout said "no response" — a correct message for the
      // wrong reason.
      settings.handleEvent(message);
      break;


    case "settings_saved":
      // Applied immediately, so a failure is surfaced inline and the page stays open.
      if (!message.ok) addNotice("error", `${t.settingsError} ${message.error ?? ""}`);
      break;

    case "locale":
      applyLocale(message.locale);
      break;

    case "ui_preference": {
      // A preference changed anywhere (Settings sends one at a time). Mirror
      // the ones the transcript reads from localStorage, so a toggle takes
      // effect without a reload.
      // `isolateByDefault` used to be here. Nothing sends it any more: the
      // setting was removed from the page, and it never reached a git worktree
      // anyway — the kernel has no such capability. Keeping the mapping would
      // leave a localStorage key written by a control that no longer exists.
      // `restartSession` left for the same reason: the launch no longer
      // restores a session, so the toggle would describe a behaviour that
      // does not exist. `suggestions` followed on 2026-11-05 with the feature
      // itself: the next-turn hint is gone, so nothing reads that key.
      const map = {
        updateCheck: "updateCheck",
      };
      const key = map[message.key];
      if (key) localStorage.setItem(`prometheus.${key}`, message.value === false ? "0" : "1");
      break;
    }

    case "kb":
    case "corpus_status":
    case "corpus_update_progress":
    case "corpus_update_result":
      // The KB page owns both the file tree (`kb`) and the corpus update group
      // drawn under it (`corpus_*`). Nothing in the transcript reads any of
      // them, so forwarding is the whole job. They need their own labels all
      // the same: an event no branch names falls to `default`, and the update
      // group would then keep its "still waiting for the state" line forever,
      // with no way to tell that from a host that is merely slow. The Check
      // button would never come back either — `corpus_update_result` is what
      // clears the busy flag.
      settings.handleEvent(message);
      break;

    case "skills":
      // The library carries the prompt bodies, which `commands` does not: the
      // composer needs them here to expand `/name args`, and the state object
      // is the one the settings module shares, so its page draws the same
      // list. Reading it here rather than only in the settings handler keeps
      // expansion working when Settings was never opened.
      //
      // Skills are global, not per-session, so `session_loaded` leaves them
      // alone: the library does not change when the transcript does.
      state.skills = Array.isArray(message.skills) ? message.skills : [];
      settings.handleEvent(message);
      break;

    case "usage_summary":
    case "mcp_servers":
    case "memory":
    case "instructions":
    case "hook_status":
    case "packs":
    case "pack_catalog":
    case "pack_progress":
    case "pack_installed":
    case "pack_error":
    case "pack_verified":
    case "pack_pruned":
    case "update_status":
      // `update_status` needs a branch of its own even when Settings is closed:
      // an event no case names falls to `default`, which only logs. The About
      // page is rebuilt from `state.updateStatus`, so the state has to be kept
      // here too, not only in the page that happens to be open.
      if (message.type === "update_status" && message.status?.state === "available") {
        announceUpdate(message.status);
      }
      settings.handleEvent(message);
      break;

    case "usage":
      // A live event adds to the totals but may also carry occupancy and the
      // session's running spend. The cost is taken first so the redraw at the
      // end of updateMeter already has it; the token sum stays with the call
      // below, which owns the add-vs-replace rule. An event without a context
      // is not a measurement (the kernel only attaches one when it could
      // measure), so it must not erase the figure the last measurement set.
      //
      // The split takes the opposite rule on purpose. The kernel writes a
      // total and its split from the same measurement, so an event carrying
      // one without the other is an older kernel or a different producer —
      // and in that case the chart on screen no longer describes what was
      // just measured. `?? null` clears it instead of leaving last turn's
      // composition under this turn's total.
      applyCost(message);
      state.contextBreakdown = message.contextBreakdown ?? null;
      updateMeter(message.context, message.usage);
      break;

    case "run_start":
      setBusy(true);
      endThinking();
      // Typing stays possible while the turn runs (the next draft can be
      // prepared), but sending does not: `submit()` refuses while busy instead
      // of pretending the message was queued for this turn.
      input.focus();
      break;

    case "assistant_start":
      endThinking();
      if (!state.currentAssistant) addAssistantTurn();
      break;

    case "assistant_delta": {
      endThinking();
      if (!state.currentAssistant) addAssistantTurn();
      const current = state.currentAssistant;
      current.text += message.text;
      if (!current.raf) {
        current.raf = requestAnimationFrame(() => {
          current.raf = 0;
          // Only the block still receiving text is re-rendered; completed
          // blocks keep their HTML, so a long answer does not get slower as
          // it grows.
          current.body.innerHTML = current.renderer.render(current.text);
          // The caret survives the rewrite and is re-attached to the end of
          // the prose. Moving the same element keeps its animation running;
          // recreating it inside the HTML string restarted the blink.
          current.body.appendChild(current.caret);
          // The character count in the progress line is the visible proof that
          // text is still arriving, so it is updated on the same frame.
          if (state.progress) state.progress.chars = current.text.length;
          scrollToBottom();
        });
      }
      break;
    }
    case "assistant_end":
      flushAssistant();
      break;

    case "assistant_discard": {
      // The request is being retried and will stream from the first token.
      // Clear the half-written turn instead of letting the second attempt
      // append onto the first.
      const current = state.currentAssistant;
      if (current) {
        if (current.raf) cancelAnimationFrame(current.raf);
        current.node?.remove();
        state.currentAssistant = null;
      }
      break;
    }

    case "thinking_start":
      if (state.currentAssistant) flushAssistant();
      startThinking();
      scrollToBottom();
      break;

    case "thinking_text":
      appendThinking(message.text);
      break;

    case "thinking_end":
      endThinking();
      break;

    case "tool_delta":
      // A tool's arguments are still arriving. Show it in the same place the
      // spinner text goes, throttled by requestAnimationFrame.
      state.toolDelta = state.toolDelta || { name: "", text: "", raf: 0 };
      state.toolDelta.name = message.name || state.toolDelta.name;
      state.toolDelta.text = (state.toolDelta.text + (message.text ?? "")).slice(-400);
      if (!state.toolDelta.raf) {
        state.toolDelta.raf = requestAnimationFrame(() => {
          state.toolDelta.raf = 0;
          // The status line is where "working" already lives; appending the
          // argument tail turns it into a progress readout without a new
          // element competing for the same corner.
          statusText.hidden = false;
          statusText.textContent = `${state.toolDelta.name} … ${state.toolDelta.text.replace(/\s+/g, " ").slice(-60)}`;
        });
      }
      break;

    case "browser_request": {
      // The agent asked the pane for something. Answering here keeps the
      // browser tools in the same process that owns the view; the host only
      // relays the request and the result.
      const request = message.request ?? {};
      void (async () => {
        let result = { ok: false, error: "unsupported browser request" };
        try {
          if (request.kind === "open") {
            await api.browserOpen(request.url);
            result = { ok: true, url: request.url };
          } else if (request.kind === "read") {
            const snapshot = await api.browserSnapshot({ selector: request.selector });
            result = snapshot
              ? { ok: true, url: snapshot.url, title: snapshot.title, text: snapshot.text }
              : { ok: false, error: "the browser pane is not open" };
          } else if (request.kind === "screenshot") {
            const shot = await api.browserScreenshot?.();
            result = shot ? { ok: shot.ok, url: shot.url, text: shot.path, error: shot.error } : { ok: false, error: "screenshots are unavailable" };
          }
        } catch (error) {
          result = { ok: false, error: String(error?.message ?? error) };
        }
        api.send({ cmd: "browserResult", id: message.id, result });
      })();
      break;
    }

    case "tool_start":
      endThinking();
      // The argument stream is finished; the normal tool row takes over.
      if (state.toolDelta) {
        if (state.toolDelta.raf) cancelAnimationFrame(state.toolDelta.raf);
        state.toolDelta = null;
        setStatus("statusWorking");
      }
      if (state.currentAssistant) flushAssistant();
      addToolRow(message.name, message.summary, message.annotations, message.id);
      break;

    case "tool_detail":
      // The transcript already shows the tool's text; this is the structured
      // side, which the panes use.
      // A file write's diff, attached to its row: seeing what changed in place
      // is faster than opening the Changes pane and finding the file.
      if (message.data && message.data.change) {
        const row = state.lastToolNode;
        if (row) attachInlineDiff(row, message.data.change);
      }
      break;

    case "tool_end": {
      // Prefer the row with this call's id: several read-only calls can be in
      // flight, and `state.currentTool` is only whichever started last. The
      // fallback keeps the transcript working with a host built before ids
      // travelled on `tool_end`.
      const row =
        (message.id ? transcript.querySelector(`.tool-row[data-call-id="${CSS.escape(message.id)}"]`) : null) ??
        state.currentTool?.node;
      if (row) {
        row.classList.remove("running");
        row.classList.add("done");
        if (!message.ok) row.classList.add("failed");
        // The kernel's evidence verdict for this result. Absent means it did
        // not judge the call (an older log), and nothing is written — a
        // `false` there would be this layer's claim rather than the kernel's.
        if (typeof message.evidence === "boolean") row.dataset.evidence = String(message.evidence);
        // The protocol layer only sends this when a hook blocked the call or
        // failed to run. It attaches to the row rather than becoming its own
        // node type, so opening the conversation again (which draws rows from
        // the same field) shows the same thing.
        if (typeof message.hookNote === "string" && message.hookNote !== "") {
          attachHookNote(row, message.hookNote);
        }
        const summaryEl = row.querySelector(".tool-summary");
        if (message.summary) summaryEl.textContent = message.summary;
        // 失败色走类名，与同行的 .failed 同源；内联样式会绕开主题令牌。
        if (!message.ok) summaryEl.classList.add("failed");
        setIcon(row.querySelector(".tool-glyph svg"), message.ok ? "check" : "x");
        // An edit's result is a diff size: make it read like one, with the
        // file first and the counts after it — "edited types.ts +15 −1" reads
        // as a sentence, where "+15 −1 types.ts" reads as a table row.
        if (message.ok && (message.name === "edit_file" || message.name === "write_file")) {
          const parts = String(message.summary).match(/\+(\d+)\s+-(\d+)/);
          if (parts) {
            const name = row.dataset.path || String(message.summary).replace(/\+\d+\s+-\d+/, "").trim();
            summaryEl.innerHTML =
              `<span class="tool-path">${escapeHtml(name)}</span> ` +
              `<span class="add">+${parts[1]}</span> <span class="del">−${parts[2]}</span>`;
          }
        }
        if (state.currentTool?.node === row) state.currentTool = null;
        // A result that just arrived while the filter is on is evidence the
        // reader asked to see; its output block is still folded because the
        // filter was turned on before this call existed.
        if (state.evidenceOnly && row.dataset.evidence === "true") revealEvidenceOutput();
        renderEvidenceFilter();
      }
      break;
    }

    case "tool_output": {
      // The id picks the row that produced this output. Concurrent read-only
      // calls finish in any order, and `state.lastToolNode` is only whichever
      // started last — under the evidence filter the wrong pairing would hide
      // the output block the filter is meant to keep.
      const row =
        (message.id ? transcript.querySelector(`.tool-row[data-call-id="${CSS.escape(message.id)}"]`) : null) ??
        lastToolRow();
      if (row) attachToolOutput(row, message.name, message.content, message.artifactPath);
      scrollToBottom();
      break;
    }

    case "todos": {
      // `renderPlan` reads `items.length`, so an `undefined` here throws inside
      // the event loop and the rest of the transcript stops updating. The
      // protocol layer already guarantees an array, but this switch is a second
      // entrance: a host that has not been rebuilt may still send a payload
      // from before that guarantee existed. An empty array is legal —
      // it is how the model clears the plan, and `renderPlan` removes the card
      // for it.
      if (!Array.isArray(message.items)) break;
      renderPlan(message.items);
      scrollToBottom();
      break;
    }

    case "subagent_started":
      // Interface state: the strip above the composer counts it. Nothing is
      // written into the transcript — the tool row that dispatched it is
      // already there, and a start line plus a result line would be two rows
      // for one act.
      noteSubagentStarted(message);
      break;

    case "ask_user": {
      // A question from the model, drawn with the same bar the permission
      // prompt uses. Preview text is monospace and scrolls: it is code or a
      // layout, and the point of showing it is to compare, not to read prose.
      state.pendingPermissionId = message.id;
      pendingQuestion.textContent = message.header
        ? `${message.header}: ${message.question}`
        : message.question;
      const choices = $("pending-choices");
      choices.innerHTML = "";
      if (message.multiSelect) {
        const note = document.createElement("div");
        note.className = "ask-note";
        note.textContent = t.askMultiHint;
        choices.appendChild(note);
        for (const option of message.options ?? []) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn small";
          button.textContent = option.label;
          button.addEventListener("click", () => answerPermission(option.value));
          if (option.preview) attachPreview(choices, option.preview);
          choices.appendChild(button);
        }
      } else {
        for (const option of message.options ?? []) {
          if (option.preview) attachPreview(choices, option.preview);
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn small";
          button.textContent = option.label;
          button.addEventListener("click", () => answerPermission(option.value));
          choices.appendChild(button);
        }
      }
      choices.hidden = false;
      pendingPermission.hidden = false;
      // The allow/always/deny buttons belong to a permission prompt; a
      // question has its own options and no "allow" to give.
      pendingPermission.querySelectorAll("[data-permission]").forEach((button) => (button.hidden = true));
      stopPendingDeadline();
      choices.querySelector("button")?.focus();
      notifyIfAway(t.notifyNeedsInput, message.question);
      break;
    }

    case "permission_choice": {
      // Second-stage question after "always allow": remember all calls of a
      // tool, or only this exact one.
      state.pendingPermissionId = message.id;
      pendingQuestion.textContent = t.rememberScope || message.question;
      const choices = $("pending-choices");
      choices.innerHTML = "";
      for (const option of message.options ?? []) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn small";
        button.textContent = (option.i18nKey && t[option.i18nKey]) || option.label;
        button.addEventListener("click", () => answerPermission(option.value));
        choices.appendChild(button);
      }
      choices.hidden = false;
      pendingPermission.hidden = false;
      pendingPermission.querySelectorAll("[data-permission]").forEach((button) => (button.hidden = true));
      stopPendingDeadline();
      choices.querySelector("button")?.focus();
      break;
    }

    case "permission_request":
      state.pendingPermissionId = message.id;
      pendingQuestion.textContent = message.question;
      renderPendingDiff(message.detail);
      startPendingDeadline(message.detail?.deadlineAt);
      $("pending-choices").hidden = true;
      $("pending-choices").innerHTML = "";
      // "Always allow" stays hidden: the kernel approves one request at a time
      // and has no rule to persist, so the button would be a false promise.
      pendingPermission
        .querySelectorAll("[data-permission]:not([data-permission='always'])")
        .forEach((button) => (button.hidden = false));
      pendingPermission.hidden = false;
      pendingPermission.querySelector('[data-permission="yes"]').focus();
      notifyIfAway(t.notifyNeedsInput, message.question);
      break;

    case "permission_closed":
      // The request resolved without a click (deadline, abort, or a decision
      // made from another window). Leaving the bar up would invite a second
      // answer to a request the host no longer holds.
      if (state.pendingPermissionId === message.id || message.id === undefined) {
        state.pendingPermissionId = null;
        pendingPermission.hidden = true;
        $("pending-choices").hidden = true;
        stopPendingDeadline();
      }
      break;

    case "notice":
      // A `subagent_result` notice carries the id of the run it concludes, so
      // the strip above the composer can stop counting it. Read before the
      // routing below: the strip's count is about this window, not about where
      // the sentence ends up being drawn.
      if (message.subagentId !== undefined) noteSubagentSettled(message.subagentId);
      // A `domain` tag routes the message to the surface that asked for it.
      // Skill failures and refused settings saves are answered while the
      // settings dialog is open, and a `showModal()` sits on top of the
      // transcript: the notice would be complete and still invisible (R3).
      // `settings` is consumed only by the page that owns the refusal — a
      // notice for a page the user is not on stays in the transcript rather
      // than appearing under an unrelated form. Everything else stays in the
      // transcript, where it has always been.
      if (message.domain === "skills") {
        settings.handleEvent(message);
        break;
      }
      if (message.domain === "settings" && settings.handleEvent(message) === true) {
        break;
      }
      addNotice(message.level, message.text);
      scrollToBottom();
      break;

    case "open_external":
      // The host asks for a browser, usually for an OAuth consent page; only
      // the renderer can reach the shell.
      if (message.url) api.openExternal(message.url);
      break;

    case "compacted":
      // A visible seam in the transcript: earlier turns were summarised here.
      // The kernel reports no token counts for a summary compaction, so the
      // title falls back to the last event the summary covers — a real number
      // — instead of pretending the sequence number is a token count.
      addNode(
        `<div class="compact-marker"${
          message.before > 0 && message.after > 0
            ? ` title="${escapeHtml(t.compactedDetail(message.before, message.after))}"`
            : message.coversUpToSeq !== undefined
              ? ` title="${escapeHtml(t.compactedSummary(message.coversUpToSeq))}"`
              : ""
        }>` +
          `<span class="compact-line"></span>` +
          `<span class="compact-label">${escapeHtml(t.compactedLabel(message.removed, message.level))}</span>` +
          `<span class="compact-line"></span>` +
          `</div>`,
      );
      scrollToBottom();
      break;

    case "turn_progress": {
      // The status line names what the turn is doing and how long it has run.
      // It is not a message in the transcript: a heartbeat every second would
      // bury the conversation.
      if (!state.busy) break;
      const seconds = Math.max(0, Math.round((message.elapsedMs ?? 0) / 1000));
      const parts = [`${seconds}s`];
      if (message.tool) parts.push(message.tool);
      if (message.retry > 0) parts.push(t.retryCount.replace("{n}", String(message.retry)));
      statusText.hidden = false;
      statusText.textContent = parts.join(" · ");
      // The same facts, in the transcript where the reader is looking. The
      // start time is derived from the elapsed value rather than from a local
      // clock, so the two readouts cannot disagree.
      setProgress({
        startedAt: Date.now() - (message.elapsedMs ?? 0),
        tool: message.tool ?? "",
        retry: message.retry ?? 0,
        outputTokens: message.outputTokens ?? 0,
      });
      break;
    }

    case "ephemeral_done":
      // The host dropped the turn from the transcript; say so rather than
      // leaving the user wondering why the conversation forgot it.
      addNode(`<div class="notice dim">${escapeHtml(t.ephemeralDone)}</div>`);
      scrollToBottom();
      break;

    case "error":
      flushAssistant();
      endThinking();
      addNode(`<div class="notice error">${escapeHtml(message.message)}</div>`);
      setBusy(false);
      setStatus("statusError");
      scrollToBottom();
      break;

    case "run_end":
      flushAssistant();
      endThinking();
      setBusy(false);
      // The host's `run_end` carries no occupancy — the turn's `usage` event
      // already delivered it. Passing `undefined` keeps that figure instead of
      // clearing a measurement the run just made.
      updateMeter(message.context, message.usage);
      notifyIfAway(t.notifyTurnDone, summariseLastAssistant());
      if (message.files && message.files.length > 0) {
        const list = message.files.slice(0, 8).map((f) => f.path).join(", ");
        addNode(
          `<div class="notice dim">${escapeHtml(t.changedFiles(message.files.length, list + (message.files.length > 8 ? "…" : "")))}</div>`,
        );
      }
      break;

    case "session_loaded": {
      const target = scrollTarget();
      // Reopening a conversation restores the settings it was working with.
      // Without this a plan-mode investigation came back in auto mode, and the
      // next message ran under a different permission model than the one the
      // user was reading.
      if (message.mode && message.mode !== state.mode) {
        state.mode = message.mode;
        setMode(state.mode);
      }
      if (message.effort && message.effort !== state.effort) {
        setEffort(message.effort);
      }
      // The transcript was replaced with this session's; so was its spend.
      // The cost is replaced rather than merged: an older log carries none,
      // and keeping the previous session's figure would attribute it here.
      // Occupancy is cleared with it: this event never carries a measurement,
      // and inheriting the previous session's percentage would attribute it
      // to the wrong transcript. The `state` event that follows this one in
      // both adapters supplies the real figure (or leaves it unknown).
      applyCost(message, { replace: true });
      updateMeter(null, message.usage, { replace: true });
      // The categories belonged to the transcript that just left the screen.
      // The `state` event that follows supplies this session's split, if it
      // has one; until then the chart is empty rather than the old one.
      state.contextBreakdown = null;
      // Every row from the previous position goes, not just the ones the new
      // projection would overwrite: a replay to an earlier event has *fewer*
      // rows, and appending them onto the ones already drawn would show the
      // future the reader just scrubbed away from.
      target
        .querySelectorAll(".turn, .tool-row, .tool-group, .tool-item, .tool-output, .notice, .plan, .thinking, .compact-marker, .hooks-report")
        .forEach((node) => node.remove());
      state.currentAssistant = null;
      state.currentThinking = null;
      // 附件条属于**上一个**会话（D-224）。
      clearAttachments();
      // The filter belongs to the transcript that just left the screen. Left
      // on, it would silently hide most of the session the user just opened.
      setEvidenceFilter(false);
      state.currentTool = null;
      state.lastToolNode = null;
      state.currentThinkingText = null;
      // The plan card is part of the transcript and was just removed; the next
      // plan for this session must build a new one rather than update a node
      // that is no longer in the document.
      planCard = null;
      // The progress line belonged to the turn that was running in the old
      // session; leaving it would make the new one look busy.
      state.progress = null;
      // The read-only view is a property of this transcript, so it is decided
      // here rather than by a command the renderer sent: the host attaches
      // `readonly` to exactly the answers that are a subagent's log, and an
      // answer without it means the screen is a conversation again. Taking the
      // event's field is what keeps the banner and the host's `prompt` refusal
      // from disagreeing.
      state.readonly =
        message.readonly && typeof message.readonly.childId === "string"
          ? { parentId: String(message.readonly.parentId ?? ""), childId: message.readonly.childId }
          : null;
      // Runs belong to the session that started them. A transcript being
      // rebuilt means either a different session or the same one reopened, and
      // in both cases a run this window remembers is not evidence about what
      // is running now — the log is. Anything still running will be announced
      // again by a `subagent_started` this window has not yet seen.
      state.liveSubagents.clear();
      haltSubagentTicker();
      renderReadonlyBanner();
      renderSubagentStrip();
      // The box is opened or closed by the state decided above, and nothing
      // else on this path calls it. Without this line, opening a subagent's
      // log from a live conversation would leave an enabled composer over a
      // transcript nothing can answer.
      renderComposerLock();
      for (const item of message.messages || []) {
        if (item.role === "user") {
          addUserTurn(item.text, item.images ?? 0);
        }
        else if (item.role === "assistant") {
          const node = addNode(`<div class="turn assistant"><div class="markdown">${md(item.text)}</div></div>`);
          bindCodeCopy(node);
        } else if (item.role === "thinking") {
          // A finished reasoning block, replayed from the log. It is built in
          // its settled form — no `streaming` class, the "thought for a
          // moment" label, folded to one line — because that is what the live
          // path leaves after `thinking_end`. The reader can open it with the
          // same header button a live block has.
          const node = addNode(thinkingBlockHtml(t.thoughtBriefly, false));
          // Filled as `textContent` rather than interpolated into the HTML
          // string: reasoning is model output and must never be parsed as
          // markup.
          const body = node?.querySelector(".thinking-text");
          if (body) body.textContent = item.text ?? "";
          bindThinkingToggle(node);
        } else if (item.role === "tool") {
          const row = document.createElement("div");
          // A failed call keeps its failure when the conversation is reopened.
          // The live `tool_result` path paints `.failed` red, but replaying the
          // log used to hardcode `done`: the same failure read as a success
          // after a reload, which is exactly the dishonesty R3 forbids. The
          // protocol layer already carries `ok`; it was being dropped here.
          row.className = item.ok === false ? "tool-row failed done" : "tool-row done";
          // The evidence verdict survives a reopen: it is the same field the
          // live `tool_end` writes, so the filter is not a mode that only
          // works on turns run in this window.
          if (typeof item.evidence === "boolean") row.dataset.evidence = String(item.evidence);
          row.innerHTML =
            `<span class="tool-glyph">${icon(toolGlyph(item.name))}</span>` +
            `<span class="tool-name"><span class="tool-label">${escapeHtml(toolLabel(item.name))}</span></span>` +
            `<span class="tool-summary">${escapeHtml(item.summary || "")}</span>`;
          // Same annotation the live path draws: without it a blocked call
          // would come back from the log as an ordinary failure.
          if (typeof item.hookNote === "string" && item.hookNote !== "") {
            attachHookNote(row, item.hookNote);
          }
          toolGroup().appendChild(row);
        }
      }
      // The introduction ("start from a symptom") belongs to a session with no
      // log behind it; a session whose log has no chat rows yet still gets it,
      // because that is the same thing to the reader.
      if ((message.messages || []).length === 0) {
        showEmptyState();
      }
      // The plan is rebuilt from the session, not from the replayed messages:
      // `messages` only carries chat bubbles. Replayed after the messages so
      // the card lands below every turn. It goes to the end of the transcript
      // because `renderPlan` inserts before `state.currentAssistant` when there
      // is one — and the replay just set that to `null`: the plan belongs to
      // the whole conversation, not to its last message, so the tail is where
      // it reads correctly. No call at all for an absent or empty list: the
      // card was already removed above, and calling with `[]` would only repeat
      // that removal.
      if (Array.isArray(message.todos) && message.todos.length > 0) {
        renderPlan(message.todos);
      } else {
        // The strip above the composer draws the same list. The transcript's
        // card was removed a few lines above; leaving the strip alone would
        // keep the previous session's plan hanging over the new one's input.
        renderPlanStrip([]);
      }
      if (message.cwd) {
        state.cwd = message.cwd;
        renderTopbarLocation();
        api.send({ cmd: "listSessions", includeArchived: state.showArchived });
      }
      // The evidence count belongs to this transcript, and the rows for it
      // were just rebuilt; recomputing here keeps the badge from counting the
      // previous conversation's evidence.
      renderEvidenceFilter();
      // The artifact pane belongs to the session that produced it. It became
      // reachable from the menu, so a list left over from the previous
      // conversation would now be presented as this one's; clear it, and ask
      // again when the pane is the one on screen.
      state.artifacts = [];
      state.selectedArtifact = null;
      renderArtifacts();
      if (!workbench.hidden && state.pane === "artifact") openArtifactPane();
      scrollToBottom(true);
      break;
    }

    case "background_report": {
      // Rendered as a distinct card so it is clear this arrived on its own,
      // not in reply to the message above it.
      const ok = message.ok !== false;
      addNode(
        `<div class="background-report${ok ? "" : " failed"}">` +
          `<div class="background-head">${icon("corner-up-right")}<span>${escapeHtml(t.backgroundReport)}</span>` +
          `<span class="background-state">${escapeHtml(ok ? t.backgroundDone : t.backgroundFailed)}</span></div>` +
          `<div class="background-prompt">${escapeHtml(message.prompt ?? "")}</div>` +
          `<div class="markdown">${md(message.report ?? "")}</div>` +
        `</div>`,
      );
      scrollToBottom();
      break;
    }

    case "hooks":
      renderHooksReport(message);
      break;

    case "session_status":
      // The sidebar row for this conversation reflects what the task is doing.
      // Only that row is touched: a full `renderSessions` here rebuilt every
      // row (losing hover and keyboard focus) and then the `sessions` message
      // that follows rebuilt it again half a second later.
      {
        const current = state.sessions.find((session) => session.id === message.sessionId);
        if (current) {
          current.status = message.status;
          const row = sessionList.querySelector(`.session-item[data-session-id="${CSS.escape(message.sessionId)}"]`);
          const state_ = message.status && message.status !== "ready" ? message.status : "";
          if (row) {
            let dot = row.querySelector(".session-state");
            if (state_ && !dot) {
              dot = document.createElement("span");
              // Inside the flags lane, not at the front of the row: the lane is
              // fixed-width, and a dot prepended to the row would shove the
              // title off the edge every other title shares.
              (row.querySelector(".session-flags") ?? row).prepend(dot);
            }
            if (dot) {
              if (state_) {
                dot.className = `session-state ${state_}`;
                dot.title = t.sessionStatusLabel(state_);
              } else {
                dot.remove();
              }
            }
          }
        }
      }
      break;

    case "sessions":
      // The host pages the list; remember how many exist so the "show more"
      // row can disappear once everything is loaded. Search covers what was
      // loaded, and loading more is how a user reaches an old conversation.
      state.sessionsTotal = Number(message.total) || (message.sessions || []).length;
      state.sessionsLimit = Number(message.limit) || (message.sessions || []).length;
      renderSessions(message.sessions);
      break;

    case "session_matches":
      // Results of a host-side full search: they replace the visible list for
      // the duration of the query, then the normal list comes back.
      state.sessionMatches = message.query ? message.sessions || [] : null;
      renderSessions(state.sessions);
      break;

    case "sessions_archived": {
      // Answer to `archiveSessions` (the workspace row's remove action). The
      // host pushes the redrawn list itself; this event carries what could
      // not be archived, and silence would look like a clean result (R3).
      const archived = Number(message.archived) || 0;
      const failed = Array.isArray(message.failed) ? message.failed : [];
      if (failed.length === 0) {
        addNotice("dim", t.workspaceRemoved(archived));
      } else {
        const reasons = failed
          .map((entry) => `${entry.id}：${entry.reason}`)
          .join("；");
        addNotice("warn", t.workspaceRemovePartial(archived, failed.length, reasons));
      }
      // No scroll: this came from the sidebar, not from the conversation the
      // reader is looking at. Yanking a scrolled transcript to the bottom
      // would be a side effect of a list action.
      break;
    }

    case "session_saved":
      api.send({ cmd: "listSessions", includeArchived: state.showArchived });
      break;

    case "session_title":
      if (state.sessions.length > 0) {
        const current = state.sessions.find((session) => session.id === state.sessionId);
        if (current) current.title = message.title;
        renderSessions(state.sessions);
      }
      break;

    case "host_exit":
      setBusy(false);
      setStatus("statusHostStopped");
      addNode(
        `<div class="notice error">${escapeHtml(t.hostStopped)} ` +
          `<button class="link-button" id="host-retry">${escapeHtml(t.hostRestart)}</button></div>`,
      );
      $("host-retry")?.addEventListener("click", () => {
        $("host-retry")?.closest(".notice")?.remove();
        api.restartHost();
      });
      break;

    case "fatal":
      setBusy(false);
      setStatus("statusConfigError");
      state.needsSetup = true;
      $("setup-button").hidden = false;
      addNode(
        `<div class="notice error">${escapeHtml(t.configError(message.message))} ` +
          `<button class="link-button" id="inline-setup">${escapeHtml(t.setupTitle)}</button></div>`,
      );
      $("inline-setup")?.addEventListener("click", openSetup);
      break;

    default:
      if (message.type) console.debug("unhandled host event", message);
  }
}

/* ---------- workbench: diff, file ---------- */

/**
 * Panes with a backend in this kernel. Everything else is unreachable.
 *
 * The serial monitor is host-backed since the PowerShell serial bridge
 * landed: `serialOpen`/`serialStatus`/… have real handlers, the events feed
 * the pane below, and the agent reads the same ring through `embed_serial`.
 */
const SUPPORTED_PANES = new Set(["file", "artifact", "serial"]);

/**
 * Which pane the workbench was on last time it was open.
 *
 * `files` is not a pane in this build: a profile that ran the version with
 * the workspace tree can still hold it on disk, and restoring a pane that no
 * longer exists would draw an empty panel. Everything that is not a File tab
 * still holding a file falls back to the serial monitor, which always has a
 * backend. Every explicit open (a tab, a tool row) still wins.
 */
const WORKBENCH_PANE_KEY = "prometheus.workbenchPane";

function lastWorkbenchPane() {
  const saved = localStorage.getItem(WORKBENCH_PANE_KEY);
  if (saved === "file" && state.selectedFile) return "file";
  return "serial";
}

function openWorkbench(pane, { opener = null } = {}) {
  if (pane !== undefined && !SUPPORTED_PANES.has(pane)) {
    // A tool row for a diff or the terminal used to open the pane it belonged
    // to. Those backends are not mounted, so the row stays a row instead of
    // opening an empty inspector.
    return;
  }
  // Remember what opened the panel before the pane switch moves anything: a
  // close should put the focus back where the reader left it. Callers whose
  // control is gone by then (a menu row) name the button themselves.
  if (workbench.hidden) {
    const active = document.activeElement;
    workbenchOpener =
      opener ?? (active instanceof HTMLElement && active !== document.body ? active : null);
  }
  state.pane = pane ?? lastWorkbenchPane();
  // Use the attribute directly: a stale hidden="false" still matches
  // [hidden]{display:none} and would keep the pane invisible.
  workbench.removeAttribute("hidden");
  // A pane that is opened only by an action (a tool row, an artifact from a
  // different one) reveals its tab the first time it is reached; leaving it
  // hidden would leave the strip claiming a pane that is on screen.
  const activeTab = workbenchTabs.querySelector(`button[data-pane="${state.pane}"]`);
  if (activeTab) activeTab.hidden = false;
  state.workbenchOpen = true;
  localStorage.setItem("prometheus.workbench", "1");
  localStorage.setItem(WORKBENCH_PANE_KEY, state.pane);
  workbenchTabs.querySelectorAll("button").forEach((button) => {
    const active = button.dataset.pane === state.pane;
    button.classList.toggle("active", active);
    // A tab strip is one stop in the tab order, with arrows moving between
    // tabs: otherwise every pane button is a tab stop and keyboard users walk
    // through all of them to get past the strip.
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const showDiff = state.pane === "diff";
  const showTerminal = state.pane === "terminal";
  const showArtifact = state.pane === "artifact";
  const showBrowser = state.pane === "browser";
  const showFile = state.pane === "file";
  const showSerial = state.pane === "serial";
  $("diff-pane").hidden = !showDiff;
  diffRoot.hidden = !showDiff;
  diffFilelist.hidden = !showDiff || state.changes.files.length === 0;
  $("diff-scope").hidden = !showDiff;
  $("changes-list").hidden = !showDiff;
  $("artifact-list-pane").hidden = !showArtifact || Boolean(state.selectedArtifact);
  fileRoot.hidden = !showFile;
  terminalRoot.hidden = !showTerminal;
  $("artifact-root").hidden = !showArtifact || !state.selectedArtifact;
  $("browser-root").hidden = !showBrowser;
  $("serial-root").hidden = !showSerial;
  if (showDiff) renderDiff();
  if (showArtifact) api.send({ cmd: "getArtifacts" });
  if (showTerminal) {
    openTerminal();
  }
  if (showSerial) {
    openSerialPane();
  }
  if (showBrowser) {
    void api.browserOpen();
    scheduleBrowserBounds();
  }
  if (!showBrowser) void api.browserClose?.();
}

/**
 * The control that opened the panel, so closing it can put the focus back.
 *
 * Keyboard users lose their place when a panel they opened from the overflow
 * menu closes onto nothing: the menu row is gone by then (it closes on click),
 * so the button that revealed the menu is where the focus belongs. Explicit
 * in-pane actions (a tool row, a tab click) record themselves instead.
 */
let workbenchOpener = null;

function closeWorkbench({ restoreFocus = true } = {}) {
  const wasOpen = workbench.hidden === false;
  // Whether the focus is about to be dropped along with the panel. A shortcut
  // that closes the panel while the caret sits in the composer must not pull
  // the caret back to the button that opened it an hour ago.
  const focusInside =
    document.activeElement instanceof HTMLElement &&
    (workbench.contains(document.activeElement) || document.activeElement === document.body);
  workbench.setAttribute("hidden", "");
  state.workbenchOpen = false;
  localStorage.setItem("prometheus.workbench", "0");
  // The page view floats above the window, so it must be removed explicitly.
  void api.browserClose?.();
  const opener = workbenchOpener;
  workbenchOpener = null;
  if (!restoreFocus || !wasOpen || !focusInside) return;
  // A menu row is gone from view by the time the panel closes (the menu shuts
  // on click), so "still focusable" is checked now rather than at open time.
  const visible = opener?.isConnected && opener.getClientRects().length > 0;
  (visible ? opener : $("more-button"))?.focus?.();
}

/* ---------- terminal pane ---------- */

let terminalCwd = "";
let terminalBusy = false;
const terminalLines = [];
/** Pending paint for coalesced terminal output. */
let terminalRaf = 0;

function openTerminal() {
  api.send({ cmd: "terminalOpen" });
  terminalInput.focus();
}

/** The pane is a fixed-width transcript, so text is appended as plain lines. */
function appendTerminalText(text) {
  const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) terminalLines.push("");
    const last = terminalLines.length - 1;
    if (last < 0) terminalLines.push(parts[i]);
    else terminalLines[last] += parts[i];
  }
  while (terminalLines.length > 4000) terminalLines.shift();
  // A 300 MB/s `yes` used to rebuild a 4000-line string on every chunk.
  // Coalescing to one paint per frame keeps the scrollback intact while
  // costing the layout one write instead of hundreds.
  if (terminalRaf) return;
  terminalRaf = requestAnimationFrame(() => {
    terminalRaf = 0;
    const pinned = terminalOutput.scrollTop + terminalOutput.clientHeight >= terminalOutput.scrollHeight - 24;
    const html = terminalLines.map((line) => `<div class="terminal-line">${escapeHtml(line) || "&nbsp;"}</div>`).join("");
    terminalOutput.innerHTML = html;
    if (pinned) terminalOutput.scrollTop = terminalOutput.scrollHeight;
  });
}

function setTerminalState({ cwd: nextCwd, busy, exited, scrollback }) {
  if (typeof nextCwd === "string" && nextCwd) terminalCwd = nextCwd;
  terminalBusy = Boolean(busy);
  terminalPrompt.textContent = terminalCwd ? `${terminalCwd}>` : ">";
  terminalPrompt.title = terminalCwd;
  terminalInput.disabled = Boolean(exited);
  terminalInput.placeholder = exited ? t.terminalExited : t.terminalPlaceholder;
  if (typeof scrollback === "string") {
    terminalLines.length = 0;
    if (scrollback) appendTerminalText(scrollback);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }
}

terminalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    const command = terminalInput.value;
    if (!command.trim()) return;
    terminalInput.value = "";
    api.send({ cmd: "terminalRun", command });
  } else if (event.ctrlKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    api.send({ cmd: "terminalInterrupt" });
  }
});

$("terminal-restart").addEventListener("click", () => {
  terminalLines.length = 0;
  if (terminalRaf) cancelAnimationFrame(terminalRaf);
  terminalRaf = 0;
  terminalOutput.textContent = "";
  api.send({ cmd: "terminalRestart" });
});

/**
 * Mark the words that differ between a removed line and the line that
 * replaced it.
 *
 * Line diffs answer "which lines changed"; on a long line the answer is still
 * "this entire line", which is unreadable for a one-word edit. The line-level
 * diff is authoritative — this only decorates the pair it already produced,
 * and gives up (leaving plain lines) when the pair is not comparable.
 */
function decorateWordDiff(lines) {
  // Collect removed and added line indices per hunk, in order, and pair them
  // positionally: that is how most line diffs of a single edit fall out.
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].kind !== "del") continue;
    const dels = [];
    const adds = [];
    let cursor = index;
    while (cursor < lines.length && lines[cursor].kind === "del") dels.push(lines[cursor++]);
    while (cursor < lines.length && lines[cursor].kind === "add") adds.push(lines[cursor++]);
    const pairs = Math.min(dels.length, adds.length);
    for (let pair = 0; pair < pairs; pair++) {
      const before = dels[pair];
      const after = adds[pair];
      if (before.text.length + after.text.length > 800) continue;
      const oldWords = before.text.split(/(\s+)/);
      const newWords = after.text.split(/(\s+)/);
      const oldSet = new Set(oldWords.filter((word) => word.trim()));
      const newSet = new Set(newWords.filter((word) => word.trim()));
      // A pair that shares almost nothing is a different line, not an edit.
      const shared = [...oldSet].filter((word) => newSet.has(word)).length;
      if (shared === 0) continue;
      before.highlights = oldWords.map((word) => word.trim() !== "" && !newSet.has(word));
      after.highlights = newWords.map((word) => word.trim() !== "" && !oldSet.has(word));
      before.words = oldWords;
      after.words = newWords;
    }
    index = cursor - 1;
  }
  return lines;
}

/** Render a line's text, wrapping the marked words. */
function lineHtml(line, marker) {
  if (!line.highlights || !line.words) return escapeHtml(`${marker} ${line.text}`);
  const cls = line.kind === "add" ? "word-add" : "word-del";
  const body = line.words
    .map((word, index) => (line.highlights[index] ? `<span class="${cls}">${escapeHtml(word)}</span>` : escapeHtml(word)))
    .join("");
  return `${escapeHtml(marker)} ${body}`;
}

function renderDiff() {
  const scope = state.diffScope;
  const active = scope === "turn" ? state.changes.lastTurn ?? { files: [], additions: 0, deletions: 0 } : state.changes;
  const files = active.files;
  // The host pushes `changes` every 500 ms while a turn runs. Rebuilding the
  // pane on every push reset its scroll position, so a person reading a diff
  // was thrown back to the top twice a second. Identical content now renders
  // nothing, and a real change keeps the reader where they were.
  const signature = files.map((file) => `${file.path}:${file.additions}:${file.deletions}:${file.diff?.length ?? 0}`).join("|") + `#${state.selectedChange}#${scope}`;
  if (signature === diffSignature && diffRoot.childElementCount > 0) return;
  const previousScroll = diffRoot.scrollTop;
  diffSignature = signature;
  renderDiffFileList(files);
  diffRoot.innerHTML = "";
  commentEditor = null;
  if (files.length === 0) {
    diffRoot.innerHTML = `<div class="diff-empty">${escapeHtml(t.noChanges)}</div>`;
    workbenchMeta.textContent = "";
    return;
  }
  // Restored at the end of this function, after the content exists again.
  state.restoreDiffScroll = previousScroll;
  const selected = files.find((file) => file.path === state.selectedChange) ?? files[0];
  state.selectedChange = selected.path;
  workbenchMeta.innerHTML =
    `<span class="add">+${selected.additions}</span> <span class="del">−${selected.deletions}</span> · ${escapeHtml(selected.path)}`;
  if (selected.skipped) {
    diffRoot.innerHTML = `<div class="diff-empty">${escapeHtml(selected.skipped)}</div>`;
    return;
  }
  renderCommentRows(selected.path);
  // Word-level highlights are computed per hunk, after the line diff has
  // decided which lines pair up.
  for (const hunk of selected.hunks) decorateWordDiff(hunk.lines);
  for (const hunk of selected.hunks) {
    const header = document.createElement("div");
    header.className = "diff-hunk-header";
    header.textContent = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    diffRoot.appendChild(header);
    for (const line of hunk.lines) {
      const row = document.createElement("div");
      row.className = `diff-line ${line.kind}`;
      const lineNo = line.newNo ?? line.oldNo;
      if (lineNo != null) row.dataset.line = String(lineNo);
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
      const gutter = document.createElement("span");
      gutter.className = "diff-gutter";
      gutter.textContent = `${line.oldNo ?? ""}`.padStart(5) + " " + `${line.newNo ?? ""}`.padStart(5);
      const text = document.createElement("span");
      text.className = "diff-text";
      if (line.highlights) text.innerHTML = lineHtml(line, marker);
      else text.textContent = `${marker} ${line.text}`;
      row.append(gutter, text);
      if (lineNo != null && line.kind !== "del") {
        // Clicking a line attaches a review comment to it.
        row.title = t.commentHint;
        row.addEventListener("click", (event) => openLineComment(event, selected.path, lineNo, line.text));
      }
      diffRoot.appendChild(row);
    }
  }
  // Back to where the reader was; on a first render this is 0, which is the
  // top, so nothing changes for the common case.
  if (state.restoreDiffScroll) {
    diffRoot.scrollTop = state.restoreDiffScroll;
    state.restoreDiffScroll = 0;
  }
}

/* ---------- serial pane ---------- */

const SERIAL_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const SERIAL_MAX_LINES = 4000;

function openSerialPane() {
  fillSerialControls();
  // Never open the port automatically: asserting DTR resets most boards, and
  // the agent may be using it. A status read only fetches the ring, and the
  // port list is the monitor's own enumeration (friendly names from WMI).
  api.send({ cmd: "serialStatus", port: state.serial.port ?? undefined });
  api.send({ cmd: "listSerialPorts" });
}

function fillSerialControls() {
  const portSelect = $("serial-port");
  const baudSelect = $("serial-baud");
  // The monitor's own enumeration is the only source of ports. It used to fall
  // back to the Board pane's `boardState.ports`, which no longer exists.
  const ports = state.serialPorts ?? [];
  const wantedPort =
    state.serial.port || state.serial.selectedPort || (ports.length === 1 ? ports[0].path : "");

  portSelect.innerHTML = "";
  if (ports.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t.serialNoPort;
    portSelect.appendChild(option);
  }
  for (const port of ports) {
    const option = document.createElement("option");
    option.value = port.path;
    option.textContent = port.path;
    portSelect.appendChild(option);
  }
  // A selection may name a port that is not currently attached; keeping it on
  // the list lets the user see what they picked instead of silently dropping it.
  if (wantedPort && !ports.some((port) => port.path === wantedPort)) {
    const option = document.createElement("option");
    option.value = wantedPort;
    option.textContent = wantedPort;
    portSelect.appendChild(option);
  }
  if (wantedPort) portSelect.value = wantedPort;

  if (baudSelect.options.length === 0) {
    for (const baud of SERIAL_BAUDS) {
      const option = document.createElement("option");
      option.value = String(baud);
      option.textContent = String(baud);
      baudSelect.appendChild(option);
    }
  }
  baudSelect.value = String(state.serial.baud || state.serial.selectedBaud || 115200);
  // The port is fixed once open — the host owns that session and switching it
  // would be a different connection. The baud rate is not: `serialBaud`
  // reconfigures the open port in place (the ring and the session survive), so
  // disabling it here made a supported operation unreachable (OPT-37 ②).
  portSelect.disabled = state.serial.open;
  baudSelect.disabled = false;
  $("serial-toggle").textContent = state.serial.open ? t.serialStop : t.serialStart;
  $("serial-toggle").classList.toggle("btn-primary", !state.serial.open);
  renderSerialStatus();
}

function renderSerialStatus() {
  const status = $("serial-status");
  const serial = state.serial;
  const parts = [];
  if (serial.open) {
    parts.push(`${t.serialConnected} · ${serial.port} · ${serial.baud}`);
    status.className = "serial-status live";
  } else {
    parts.push(t.serialDisconnected);
    status.className = serial.lastError ? "serial-status bad" : "serial-status";
  }
  if (serial.lastError) parts.push(serial.lastError);
  if (serial.paused) {
    parts.push(`${t.serialPausedState}${serial.pausedBacklog ? ` · ${serial.pausedBacklog} ${t.serialNewLines}` : ""}`);
  } else if (serial.dropped) {
    parts.push(`${serial.dropped} ${t.serialDropped}`);
  }
  // The pane's own cap, reported separately: `dropped` above is the host's ring
  // and says nothing about lines that arrived and were then evicted here.
  if (serial.droppedLocal) {
    parts.push(`${serial.droppedLocal} ${t.serialTrimmed}`);
  }
  if (serial.filtered) parts.push(`${serial.filtered} ${t.serialFiltered}`);
  status.textContent = parts.join(" · ");
  $("serial-pause").disabled = !serial.open;
  setIcon($("serial-pause").querySelector("svg"), serial.paused ? "play" : "pause");
  // The glyph is the only visible label, so the name has to say what the next
  // click does — "Pause" painted over a play triangle names the button for the
  // wrong state.
  setControlTitle($("serial-pause"), serial.paused ? t.serialResume : t.serialPause);
  $("serial-follow").setAttribute("aria-pressed", String(serial.follow));
  // 发送按钮在串口未开时明确禁用，禁用原因放在 title 里——静默吞掉
  // 点击（点了没反应又不解释）违反禁用态要解释原因的规范。
  const send = $("serial-send");
  const input = $("serial-send-input");
  send.disabled = !serial.open;
  input.disabled = !serial.open;
  const reason = serial.open ? "" : t.serialSendDisabledHint;
  send.title = reason;
  input.title = reason;
}

/** One row per line; `serial_text` keeps the message, the rest is gutter. */
function serialLineNode(line) {
  const row = document.createElement("div");
  // `dir` is the line's direction: absent means what the device sent (RX).
  // The gutter carries a plain RX/TX badge for both directions instead of a
  // level word for one and an arrow for the other — one vocabulary, read at a
  // glance without decoding color, and legible to a screen reader.
  const dir = line.dir === "tx" ? "tx" : "rx";
  row.className = `serial-line ${dir}${line.level ? ` ${line.level}` : ""}`;
  row.dataset.dir = dir;
  const time = new Date(line.at).toTimeString().slice(0, 8);
  const millis = String(new Date(line.at).getMilliseconds()).padStart(3, "0");

  const timeEl = document.createElement("span");
  timeEl.className = "serial-time";
  timeEl.textContent = `${time}.${millis}`;

  // The badge replaces the level column. A warn/error RX line keeps its level
  // inside the badge's tooltip and its color, so the filter bar still works
  // and the row still reads at a glance.
  const badgeEl = document.createElement("span");
  badgeEl.className = `serial-badge ${dir}`;
  badgeEl.textContent = dir === "tx" ? "TX" : "RX";
  badgeEl.title = line.level && line.level !== "info" ? `${dir} · ${line.level.toUpperCase()}` : dir.toUpperCase();

  // What produced the line: the operator typed it, or the agent did. Kept in
  // its own column so both kinds of send are distinguishable at once.
  const tagEl = document.createElement("span");
  tagEl.className = "serial-tag";
  tagEl.textContent = line.tag ?? (dir === "tx" ? t.serialSenderUser : "");

  const textEl = document.createElement("span");
  textEl.className = "serial-text";
  // A TX line holds the plain text that was sent, so it is shown as written —
  // in HEX view mode the send box already took hex, and `hexView` would print
  // the digits rather than the bytes they encode.
  // HEX view shows the bytes the wire carried: prefer the raw latin1 bytes
  // the host attached to the line; fall back to re-encoding the decoded text
  // (UTF-8) only when the line has no raw payload.
  textEl.textContent = viewHex() && dir !== "tx" ? hexView(line) : line.text;

  row.append(timeEl, badgeEl, tagEl, textEl);
  if (line.level) row.dataset.level = line.level;
  if (line.tag === t.serialSenderAgent) row.dataset.agent = "true";
  return row;
}

/** Whether a line survives the current filter. An unlevelled line is info. */
function serialVisible(line) {
  if (state.serial.filter === "all") return true;
  const level = line.level ?? "info";
  if (state.serial.filter === "warn") return level === "error" || level === "warn";
  return level === "error";
}

function appendSerialLines(lines) {
  const output = $("serial-output");
  const pinned = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
  const serial = state.serial;
  serial.lines.push(...lines);
  // Keep the renderer's ring in step with the host's, so a re-render after a
  // long run does not grow without bound.
  if (serial.lines.length > SERIAL_MAX_LINES) {
    const excess = serial.lines.length - SERIAL_MAX_LINES;
    serial.lines.splice(0, excess);
    // Counted separately from the host's `dropped`: these lines reached the
    // pane and were then evicted here, so the host has no idea they are gone.
    // Without this the status line says "0 dropped" while the top of the
    // transcript is quietly disappearing (OPT-37 ①, 2026-11-08).
    serial.droppedLocal = (serial.droppedLocal ?? 0) + excess;
    for (let index = 0; index < excess; index++) output.firstElementChild?.remove();
  }

  serial.filtered = 0;
  for (const line of lines) {
    if (!serialVisible(line)) {
      serial.filtered += 1;
      continue;
    }
    output.appendChild(serialLineNode(line));
  }
  while (output.childElementCount > SERIAL_MAX_LINES) output.firstElementChild?.remove();
  if (serial.follow && pinned) output.scrollTop = output.scrollHeight;
  renderSerialStatus();
}

/** Rebuild the visible rows from the ring: used after a filter or a resume. */
function rerenderSerialLines() {
  const output = $("serial-output");
  output.innerHTML = "";
  state.serial.filtered = 0;
  const fragment = document.createDocumentFragment();
  for (const line of state.serial.lines) {
    if (!serialVisible(line)) {
      state.serial.filtered += 1;
      continue;
    }
    fragment.appendChild(serialLineNode(line));
  }
  output.appendChild(fragment);
  if (state.serial.follow) output.scrollTop = output.scrollHeight;
  renderSerialStatus();
}

function setSerialState(message) {
  const serial = state.serial;
  if ("open" in message) serial.open = Boolean(message.open);
  if ("port" in message) serial.port = message.port ?? null;
  if ("baud" in message) serial.baud = message.baud ?? null;
  // The host is the authority on the codec: an agent that opened the port
  // chose one, and the dropdown has to show that choice or the operator will
  // read GBK bytes through a control that says UTF-8.
  if ("encoding" in message && message.encoding) {
    serial.encoding = message.encoding;
    const select = $("serial-encoding");
    if (select && select.value !== message.encoding) select.value = message.encoding;
  }
  if (message.error) serial.lastError = message.error;
  else if (serial.open) serial.lastError = "";
  if (!serial.open) {
    serial.paused = false;
    serial.pausedBacklog = 0;
    serial.rxBytes = 0;
    serial.txBytes = 0;
    renderSerialCounters();
  } else if (message.mode !== "reconfigured") {
    // Opening a port starts a fresh ring on the host. A `reconfigured` state
    // (codec switch, baud change, auto-detect) keeps the same session —
    // wiping the transcript there threw away hours of log for a dropdown
    // change, and auto-detect fired it silently mid-session.
    $("serial-output").innerHTML = "";
    serial.lines = [];
    serial.filtered = 0;
    serial.dropped = 0;
    // The pane's own trim counter describes the ring that was just cleared.
    serial.droppedLocal = 0;
    serial.follow = true;
  }
  fillSerialControls();
  renderSerialStatus();
}

$("serial-toggle").addEventListener("click", () => {
  const serial = state.serial;
  if (serial.open) {
    api.send({ cmd: "serialClose" });
    return;
  }
  const port = $("serial-port").value;
  if (!port) return;
  const baud = Number($("serial-baud").value) || 115200;
  const encoding = $("serial-encoding")?.value || "auto";
  state.serial.port = port;
  state.serial.baud = baud;
  state.serial.selectedPort = port;
  state.serial.selectedBaud = baud;
  state.serial.encoding = encoding;
  api.send({ cmd: "serialOpen", port, baud, encoding });
});

$("serial-pause").addEventListener("click", () => {
  const serial = state.serial;
  serial.paused = !serial.paused;
  if (!serial.paused) {
    serial.pausedBacklog = 0;
    rerenderSerialLines();
  }
  renderSerialStatus();
});

$("serial-clear").addEventListener("click", () => {
  // 串口日志是调试取证数据（R3 语境），误点一次整个 buffer 就没了——与
  // transcript 清空同一待遇：先确认，文案里提示可先导出。
  void confirmAction(t.serialClearConfirm, { danger: true }).then((yes) => {
    if (!yes) return;
    state.serial.lines = [];
    state.serial.filtered = 0;
    // Clearing starts a new ring on both sides: the pane's own trim count is
    // about the lines that are gone, so it goes with them (OPT-37 ①).
    state.serial.droppedLocal = 0;
    $("serial-output").innerHTML = "";
    api.send({ cmd: "serialClear", port: state.serial.port ?? undefined });
    renderSerialStatus();
  });
});

$("serial-export").addEventListener("click", () => {
  const lines = state.serial.lines.map((line) => {
    const time = new Date(line.at).toISOString();
    const level = line.level ? line.level.toUpperCase().padEnd(5) : "     ";
    const tag = line.tag ? `${line.tag}: ` : "";
    return `${time} ${level} ${tag}${line.text}`;
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  void api.saveFile(`serial-${state.serial.port ?? "monitor"}-${stamp}.log`, `${lines.join("\n")}\n`, [
    { name: "Log", extensions: ["log", "txt"] },
  ]);
});

$("serial-follow").addEventListener("click", () => {
  state.serial.follow = !state.serial.follow;
  if (state.serial.follow) {
    const output = $("serial-output");
    output.scrollTop = output.scrollHeight;
  }
  renderSerialStatus();
});

$("serial-output").addEventListener("scroll", () => {
  const output = $("serial-output");
  const atBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
  // Scrolling up is the same gesture as unpinning in the terminal; the explicit
  // button is for people who want it to stay put.
  if (!atBottom && state.serial.follow) {
    state.serial.follow = false;
    renderSerialStatus();
  }
});

$("serial-filter").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.serial.filter = button.dataset.filter;
  $("serial-filter").querySelectorAll("button").forEach((entry) => {
    entry.classList.toggle("active", entry === button);
  });
  rerenderSerialLines();
});

$("serial-view").addEventListener("click", (event) => {
  // Hex view is a re-render of the same ring, not a second capture: nothing
  // on the wire changes, only how the pane draws it.
  const button = event.target.closest("[data-view]");
  if (!button) return;
  state.serial.view = button.dataset.view;
  $("serial-view").querySelectorAll("button").forEach((entry) => {
    entry.classList.toggle("active", entry === button);
  });
  rerenderSerialLines();
});

$("serial-port").addEventListener("change", () => {
  // Remember the pick in this pane: the port list is re-enumerated whenever the
  // pane opens or the host reports `serial_ports`, and a forgotten pick would
  // silently snap back to the first port.
  state.serial.selectedPort = $("serial-port").value;
  state.serial.selectedBaud = Number($("serial-baud").value) || 115200;
});

$("serial-baud").addEventListener("change", () => {
  const baud = Number($("serial-baud").value) || 115200;
  state.serial.selectedBaud = baud;
  // While the port is open the pick is a live reconfiguration, not just a
  // remembered preference for the next open (OPT-37 ②). The host answers with
  // `mode: "reconfigured"`, which keeps the transcript — only the decode
  // changes. If the driver refuses, `serial_state{open:false, error}` arrives
  // and the pane says why instead of showing a baud rate that is not in force.
  if (state.serial.open) api.send({ cmd: "serialBaud", baud });
});

$("serial-encoding")?.addEventListener("change", (event) => {
  const encoding = event.target.value;
  state.serial.encoding = encoding;
  if (state.serial.open) api.send({ cmd: "serialEncoding", encoding });
});

/* ---------- serial send ---------- */

/** The receive view mode (text | hex) — a pane-local display toggle. */
function viewHex() {
  return state.serial.view === "hex";
}

/** Hex dump of a received line: bytes spaced, 16 per row kept on one line. */
/**
 * Render an already-hex string (what the send box holds when HEX mode is on)
 * for the transcript. The bytes are known exactly here, so this must not go
 * through `hexView`, which would re-encode the *text of the hex* — "41" would
 * show up as the two bytes 0x34 0x31 instead of 0x41.
 */
function hexViewOfHex(clean) {
  // A non-hex payload (schema rejects it, but a stale client could still
  // relay one) must not render as "NAN NAN" — show it as the text it is.
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    return `${clean} (invalid hex)`;
  }
  const bytes = [];
  for (let i = 0; i + 1 < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  if (bytes.length === 0) return "(empty)";
  const out = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16).map((b) => b.toString(16).padStart(2, "0").toUpperCase());
    const ascii = bytes
      .slice(i, i + 16)
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·"))
      .join("");
    out.push(`${row.join(" ").padEnd(47)}  ${ascii}`);
    if (i + 16 < bytes.length) out.push("\n");
  }
  return out.join("");
}

function hexView(line) {
  // `raw` is the wire bytes, one byte per latin1 char — the truth HEX view
  // exists to show. TextEncoder re-encodes decoded text as UTF-8, which for
  // a GBK line displays different bytes than a logic analyzer captured.
  const bytes = line.raw
    ? [...line.raw].map((ch) => ch.charCodeAt(0) & 0xff)
    : [...new TextEncoder().encode(line.text)];
  if (bytes.length === 0) return "(empty)";
  const out = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16).map((b) => b.toString(16).padStart(2, "0").toUpperCase());
    const ascii = bytes.slice(i, 16 + i).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join("");
    out.push(`${row.join(" ").padEnd(47)}  ${ascii}`);
    if (i + 16 < bytes.length) out.push("\n");
  }
  return out.join("");
}

/** Send history for the ↑ recall — the terminal's muscle memory. */
const serialSendHistory = [];
const SERIAL_HISTORY_MAX = 50;
let serialHistoryIndex = 0;

/** RX/TX wire counters, counted by the pump, shown in the status row. */
function renderSerialCounters() {
  $("serial-counters").textContent = `RX ${state.serial.rxBytes ?? 0} · TX ${state.serial.txBytes ?? 0}`;
}

/** Validate hex input; the normalised byte string, or null when invalid. */
function normalizeHexSend(text) {
  const clean = text.replace(/\s+/g, "").toUpperCase();
  if (clean === "") return null;
  if (!/^[0-9A-F]+$/.test(clean) || clean.length % 2 !== 0) return null;
  return clean;
}

function sendSerialLine() {
  const input = $("serial-send-input");
  const text = input.value;
  if (text === "") return;
  // 串口未开的情况由 renderSerialStatus 把发送控件整体禁用并解释原因，
  // 这里不再需要静默 return。
  const hex = $("serial-send-hex").checked;
  const crlf = $("serial-send-crlf").checked;
  if (hex) {
    const normalized = normalizeHexSend(text);
    if (normalized === null) {
      // Refuse visibly rather than send garbage (R3): an odd digit count or a
      // stray character would go out as something else on the wire. 持久内联
      // 文本 + aria-invalid，颜色只是辅助——纯色闪一下等于没说错在哪。
      const error = $("serial-send-error");
      const odd = text.replace(/\s+/g, "").length % 2 !== 0;
      error.textContent = odd ? t.serialHexOdd : t.serialHexInvalid;
      error.hidden = false;
      input.classList.add("invalid");
      input.setAttribute("aria-invalid", "true");
      return;
    }
    api.send({ cmd: "serialWrite", port: state.serial.port ?? undefined, data: normalized, hex: true });
    // The pane shows what went out as well as what came back: a monitor that
    // only prints RX cannot be read as a conversation, and the operator has no
    // way to tell their own write from the device's answer.
    appendSerialLines([
      { text: hexViewOfHex(normalized), at: Date.now(), level: "info", dir: "tx", tag: t.serialSenderUser },
    ]);
  } else {
    api.send({ cmd: "serialWrite", port: state.serial.port ?? undefined, data: text + (crlf ? "\r\n" : "") });
    appendSerialLines([{ text, at: Date.now(), level: "info", dir: "tx", tag: t.serialSenderUser }]);
  }
  serialSendHistory.push(text);
  if (serialSendHistory.length > SERIAL_HISTORY_MAX) serialSendHistory.shift();
  serialHistoryIndex = serialSendHistory.length;
  input.value = "";
  input.focus();
}

/** Recall: at the end of history the draft slot (empty) comes back. */
function serialHistoryRecall() {
  $("serial-send-input").value = serialHistoryIndex < serialSendHistory.length ? serialSendHistory[serialHistoryIndex] : "";
}

/**
 * Replay an agent-authored write as the action it is: type the text into the
 * input, press Send, clear. Without this the characters just appear on the
 * wire and the operator cannot tell their own sends from the agent's.
 *
 * The bytes are already out (the host wrote them before announcing the
 * event); this is purely the visible echo of who did it. `typing` is a
 * module-level token so a second agent write cancels the first animation
 * instead of interleaving two typewriters.
 */
let agentTypingToken = 0;

function replayAgentWrite(write) {
  const input = $("serial-send-input");
  const button = $("serial-send");
  if (!input || !button) return;
  const token = ++agentTypingToken;
  const text = String(write.data ?? "");
  // A hex write is shown as the byte string the agent actually sent; the
  // panel would otherwise look like it typed a different payload.
  const shown = write.hex === true ? text.replace(/(..)/gi, "$1 ").trim() : text.replace(/\r\n$/, "");
  const chunk = Math.max(1, Math.ceil(shown.length / 24));
  input.classList.add("agent-typing");
  input.value = "";
  let index = 0;
  const typeNext = () => {
    if (token !== agentTypingToken) return;
    index = Math.min(shown.length, index + chunk);
    input.value = shown.slice(0, index);
    if (index < shown.length) {
      setTimeout(typeNext, 18);
      return;
    }
    // The press: a real click's visual, plus the same highlight the button
    // gets from a pointer.
    setTimeout(() => {
      if (token !== agentTypingToken) return;
      button.classList.add("agent-pressing");
      button.setAttribute("aria-busy", "true");
      setTimeout(() => {
        if (token !== agentTypingToken) return;
        button.classList.remove("agent-pressing");
        button.removeAttribute("aria-busy");
        input.value = "";
        input.classList.remove("agent-typing");
      }, 180);
    }, 140);
  };
  // One frame first so the caret and empty field are painted before typing.
  setTimeout(typeNext, 40);
}

$("serial-send").addEventListener("click", sendSerialLine);
// 修正输入后错误提示立刻消失：清除时机跟输入走，而不是定时器。
$("serial-send-input").addEventListener("input", () => {
  const input = $("serial-send-input");
  const error = $("serial-send-error");
  input.classList.remove("invalid");
  input.removeAttribute("aria-invalid");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
});

$("serial-send-input").addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    sendSerialLine();
  } else if (event.key === "ArrowUp" && serialHistoryIndex > 0) {
    event.preventDefault();
    serialHistoryIndex -= 1;
    serialHistoryRecall();
  } else if (event.key === "ArrowDown" && serialHistoryIndex < serialSendHistory.length) {
    event.preventDefault();
    serialHistoryIndex += 1;
    serialHistoryRecall();
  }
});

/** DTR/RTS toggles — the board-reset gesture. Polarity is the user's call. */
function serialLineToggle(which) {
  return () => {
    if (!state.serial.open) return;
    const button = $(`serial-${which}`);
    const next = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(next));
    button.classList.toggle("active", next);
    api.send({ cmd: "serialLine", port: state.serial.port ?? undefined, line: which, value: next });
  };
}

$("serial-dtr").addEventListener("click", serialLineToggle("dtr"));
$("serial-rts").addEventListener("click", serialLineToggle("rts"));

/* ---------- inline review comments ---------- */

let commentEditor = null;
/**
 * What the diff pane currently shows. `changes` arrives twice a second while a
 * turn runs; this is what lets an identical push be a no-op.
 */
let diffSignature = "";

function openLineComment(event, path, line, text) {
  if (event.target.closest(".line-comment, .comment-editor")) return;
  closeCommentEditor();
  const editor = document.createElement("div");
  editor.className = "comment-editor";
  editor.innerHTML =
    `<div class="comment-context">${escapeHtml(path)}:${line}</div>` +
    `<textarea rows="2" placeholder="${escapeHtml(t.commentPlaceholder)}"></textarea>` +
    `<div class="comment-actions">` +
    `<button class="btn small" data-cancel>${escapeHtml(t.cancel)}</button>` +
    `<button class="btn btn-primary small" data-save>${escapeHtml(t.commentAdd)}</button>` +
    `</div>`;
  const row = event.currentTarget;
  row.after(editor);
  const area = editor.querySelector("textarea");
  area.focus();
  const save = () => {
    const body = area.value.trim();
    if (!body) return closeCommentEditor();
    state.comments.push({ path, line, body, text: String(text ?? "").slice(0, 160) });
    closeCommentEditor();
    renderCommentsBar();
    renderDiff();
  };
  editor.querySelector("[data-save]").addEventListener("click", save);
  editor.querySelector("[data-cancel]").addEventListener("click", closeCommentEditor);
  area.addEventListener("keydown", (keyEvent) => {
    if (keyEvent.key === "Enter" && (keyEvent.metaKey || keyEvent.ctrlKey)) {
      keyEvent.preventDefault();
      save();
    }
    if (keyEvent.key === "Escape") {
      keyEvent.stopPropagation();
      closeCommentEditor();
    }
  });
  commentEditor = editor;
}

function closeCommentEditor() {
  if (commentEditor) {
    commentEditor.remove();
    commentEditor = null;
  }
}

/** Comments on the current file, shown as sticky rows above the diff. */
function renderCommentRows(path) {
  const mine = state.comments.filter((comment) => comment.path === path);
  for (const comment of mine) {
    const row = document.createElement("div");
    row.className = "line-comment";
    row.innerHTML =
      `<span class="line-comment-where">${escapeHtml(String(comment.line))}</span>` +
      `<span class="line-comment-body">${escapeHtml(comment.body)}</span>` +
      `<button class="line-comment-remove" title="${escapeHtml(t.commentRemove)}">${icon("x")}</button>`;
    row.querySelector(".line-comment-remove").addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      state.comments = state.comments.filter((item) => item !== comment);
      renderCommentsBar();
      renderDiff();
    });
    diffRoot.appendChild(row);
  }
}

/**
 * Pending comments become one message: file, line, and the reviewer's note.
 * Sending clears the list so the next review starts empty.
 */
function sendComments() {
  if (state.comments.length === 0) return;
  const lines = state.comments.map(
    (comment) => `- ${comment.path}:${comment.line} — ${comment.body}${comment.text ? `\n  (line: ${comment.text})` : ""}`,
  );
  const message = `${t.commentMessageIntro}\n\n${lines.join("\n")}`;
  const previous = input.value.trim();
  input.value = previous ? `${previous}\n\n${message}` : message;
  state.comments = [];
  renderCommentsBar();
  autoSize();
  input.focus();
  // The focus already moved to the composer: handing it back to the opener
  // would take it off the input the user is about to type in.
  if (!workbench.hidden) closeWorkbench({ restoreFocus: false });
}

function renderCommentsBar() {
  const bar = $("comments-bar");
  if (!bar) return;
  const count = state.comments.length;
  bar.hidden = count === 0;
  $("comments-count").textContent = t.commentCount(count);
  $("comments-clear").hidden = count === 0;
}

$("comments-send").addEventListener("click", sendComments);
$("comments-clear").addEventListener("click", () => {
  state.comments = [];
  renderCommentsBar();
});


function renderDiffFileList(files = state.changes.files) {
  diffFilelist.innerHTML = "";
  for (const file of files) {
    const row = document.createElement("button");
    row.className = `change-row${file.path === state.selectedChange ? " active" : ""}`;
    row.innerHTML =
      `<span class="change-path">${escapeHtml(file.path)}</span>` +
      `<span class="change-stat"><span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span></span>`;
    row.addEventListener("click", () => {
      state.selectedChange = file.path;
      openWorkbench("diff");
      renderDiff();
    });
    diffFilelist.appendChild(row);
  }
}

function renderChangesPanel() {
  renderGitBar();
  // The host pushes `changes` every 500 ms during a turn. Rebuilding a hidden
  // panel costs layout for something nobody can see, and the pane is rendered
  // from the same state when it opens, so there is nothing to keep fresh.
  if (workbench.hidden) return;
  changesList.innerHTML = "";
  const { files, additions, deletions } = state.changes;
  // The diff pane already carries the empty state; repeating it here stacked
  // the same sentence twice in one column.
  changesSummary.innerHTML = files.length
    ? `${files.length} file${files.length === 1 ? "" : "s"} · <span class="add">+${additions}</span> <span class="del">−${deletions}</span>`
    : "";
  for (const file of files) {
    const row = document.createElement("button");
    row.className = "change-row";
    row.innerHTML =
      `<span class="change-path">${escapeHtml(file.path)}</span>` +
      `<span class="change-stat"><span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span></span>`;
    row.addEventListener("click", () => {
      state.selectedChange = file.path;
      openWorkbench("diff");
      renderDiff();
    });
    changesList.appendChild(row);
  }
}

/* ---------- git ---------- */

function renderGitBar() {
  const bar = $("git-bar");
  const git = state.git;
  if (!git || !git.available) {
    renderTopbarLocation();
    bar.hidden = false;
    $("git-branch-name").textContent = t.gitNotRepo;
    $("git-sync").textContent = "";
    $("git-commit").hidden = true;
    return;
  }
  bar.hidden = false;
  renderTopbarLocation();
  $("git-branch-name").textContent = git.branch || "HEAD";
  const sync = [];
  if (git.ahead > 0) sync.push(t.gitAhead(git.ahead));
  if (git.behind > 0) sync.push(t.gitBehind(git.behind));
  if (sync.length === 0 && git.clean) sync.push(t.gitClean);
  $("git-sync").textContent = sync.join(" ");
  $("git-commit").hidden = git.clean;
}

function sendCommit() {
  const message = $("git-message").value.trim();
  const note = $("git-commit-note");
  if (!message) {
    note.textContent = t.commitEmpty;
    return;
  }
  note.textContent = "";
  api.send({ cmd: "gitCommit", message });
}

$("git-commit-button").addEventListener("click", sendCommit);
$("git-message").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    sendCommit();
  }
});
$("git-branch").addEventListener("click", () => {
  const name = state.git?.branch;
  if (!name) return;
  // 与代码块复制同一套反馈：成功有回话，失败不静默。
  const label = $("git-branch");
  navigator.clipboard
    .writeText(name)
    .then(() => (label.title = t.copied))
    .catch(() => (label.title = t.copyFailed))
    .finally(() => setTimeout(() => (label.title = name), 1200));
});

function openFile(path) {
  state.selectedFile = path;
  openWorkbench("file");
  fileRoot.innerHTML = `<div class="diff-empty">…</div>`;
  // The failure path is a notice, which the transcript shows — but the pane
  // would sit on the ellipsis forever, so a timeout puts a reason there.
  const wanted = path;
  clearTimeout(state.fileLoadTimer);
  state.fileLoadTimer = setTimeout(() => {
    if (state.selectedFile !== wanted) return;
    if (!fileRoot.textContent.trim() || fileRoot.textContent.trim() === "…") {
      fileRoot.innerHTML = `<div class="diff-empty">${escapeHtml(t.fileReadFailed)}</div>`;
    }
  }, 5000);
  api.send({ cmd: "getFile", path });
}

function renderFilePreview(file) {
  if (!file || file.path !== state.selectedFile) return;
  clearTimeout(state.fileLoadTimer);
  workbenchMeta.textContent = `${file.path}${file.truncated ? " · truncated" : ""}`;
  if (file.binary) {
    fileRoot.innerHTML = `<div class="diff-empty">${escapeHtml(t.fileBinary)}</div>`;
    return;
  }
  const lines = file.content.replace(/\r\n/g, "\n").split("\n");
  fileRoot.innerHTML = `<pre class="file-view-code">${lines
    .map((line, index) => {
      const gutter = `<span class="diff-gutter">${String(index + 1).padStart(4)}</span>`;
      return `<div class="file-line">${gutter}<span class="diff-text">${escapeHtml(line)}</span></div>`;
    })
    .join("")}</pre>`;
}

/* ---------- browser pane ---------- */

let browserBoundsTimer = null;

/** The page is a native view overlaying the window; keep it over its slot. */
function syncBrowserBounds() {
  if (state.pane !== "browser" || workbench.hidden) return;
  const slot = $("browser-page");
  if (!slot) return;
  const rect = slot.getBoundingClientRect();
  // Electron view bounds are in device-independent pixels, same as CSS pixels.
  void api.browserBounds({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  });
}

function scheduleBrowserBounds() {
  clearTimeout(browserBoundsTimer);
  browserBoundsTimer = setTimeout(syncBrowserBounds, 60);
}

function openBrowserPane(url) {
  openWorkbench("browser");
  if (url) {
    $("browser-url").value = url;
    void api.browserOpen(url);
  } else {
    void api.browserOpen("about:blank");
  }
  scheduleBrowserBounds();
}

function renderBrowserState(message) {
  if (!message) return;
  if (typeof message.url === "string" && message.url !== "about:blank" && document.activeElement !== $("browser-url")) {
    $("browser-url").value = message.url;
  }
  $("browser-back").disabled = !message.canGoBack;
  $("browser-forward").disabled = !message.canGoForward;
  $("browser-reload").textContent = "";
  workbenchMeta.textContent = message.title || message.url || t.paneBrowser;
}

$("browser-back").addEventListener("click", () => api.browserNavigate("back"));
$("browser-forward").addEventListener("click", () => api.browserNavigate("forward"));
$("browser-reload").addEventListener("click", () => api.browserNavigate("reload"));
$("browser-url").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    api.browserNavigate("load", $("browser-url").value);
  }
});
$("browser-use").addEventListener("click", async () => {
  const snapshot = await api.browserSnapshot();
  if (!snapshot) return;
  const text = `${t.browserUsePrefix}\n${snapshot.url}\n\n${snapshot.text ?? ""}`;
  input.value = input.value.trim() ? `${input.value}\n\n${text}` : text;
  autoSize();
  input.focus();
  closeWorkbench({ restoreFocus: false });
});

window.addEventListener("resize", scheduleBrowserBounds);
api.onBrowserState?.(renderBrowserState);

/* ---------- artifacts ---------- */

function renderArtifacts() {
  const list = $("artifact-list");
  list.innerHTML = "";
  if (state.artifacts.length === 0) {
    list.innerHTML = `<div class="sidebar-empty">${escapeHtml(t.noArtifacts)}</div>`;
    return;
  }
  for (const artifact of state.artifacts) {
    const row = document.createElement("button");
    row.className = "artifact-row";
    row.innerHTML =
      `<span class="artifact-kind">${escapeHtml(artifact.kind)}</span>` +
      `<span class="artifact-path">${escapeHtml(artifact.path)}</span>`;
    row.title = `${artifact.path} · ${Math.round(artifact.size / 1024)} KB`;
    row.addEventListener("click", () => {
      state.selectedArtifact = artifact.path;
      api.send({ cmd: "getArtifact", path: artifact.path });
    });
    list.appendChild(row);
  }
}

/** Render one artifact in the right-hand workbench. */
function renderArtifact(artifact) {
  // Open the artifact's own tab through the normal path so every other pane
  // is hidden consistently; `openWorkbench` reveals the tab on first reach.
  state.selectedArtifact = artifact.path;
  clearTimeout(state.artifactLoadTimer);
  openWorkbench("artifact");
  $("artifact-list-pane").hidden = true;
  const root = $("artifact-root");
  root.hidden = false;
  workbenchMeta.textContent = `${artifact.kind} · ${artifact.path}${artifact.truncated ? " · truncated" : ""}`;
  if (artifact.kind === "html") {
    // Scripts stay disabled: an agent-written page should not run in the app.
    root.innerHTML = `<iframe class="artifact-frame" sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeHtml(artifact.content)}"></iframe>`;
  } else if (artifact.kind === "svg") {
    root.innerHTML = `<div class="artifact-svg">${artifact.content}</div>`;
  } else if (artifact.kind === "markdown") {
    root.innerHTML = `<div class="artifact-markdown markdown">${md(artifact.content)}</div>`;
  } else if (artifact.kind === "csv") {
    renderCsvTable(root, artifact.content);
  } else {
    root.innerHTML = `<pre class="artifact-json">${escapeHtml(artifact.content)}</pre>`;
  }
}

function renderCsvTable(root, text) {
  const rows = parseCsvLocal(text);
  if (rows.length === 0) {
    root.innerHTML = `<div class="diff-empty">${escapeHtml(t.emptyFile)}</div>`;
    return;
  }
  const head = rows[0].map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");
  const body = rows
    .slice(1)
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  root.innerHTML = `<div class="artifact-table-wrap"><table class="artifact-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Local CSV parse (the host parser is not importable from the renderer). */
function parseCsvLocal(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < 500; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}

/* ---------- sessions ---------- */

function relativeDate(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return state.locale === "zh" ? "刚刚" : "just now";
  if (minutes < 60) return state.locale === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return state.locale === "zh" ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return state.locale === "zh" ? "昨天" : "yesterday";
  if (days < 7) return state.locale === "zh" ? `${days} 天前` : `${days}d ago`;
  return new Date(iso).toLocaleDateString(state.locale === "zh" ? "zh-CN" : "en-US");
}

/** One canonical spelling per workspace, for grouping only. */
function normalizeCwd(cwd) {
  return String(cwd || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Folder names for project headers. Two different folders can share a leaf
 * name; those get their parent as a suffix so they stay distinguishable.
 */
function projectLabels(keys, displayPaths) {
  const labels = new Map();
  const used = new Map();
  const partsFor = (key) => String(displayPaths?.get(key) || key).split(/[\\/]/).filter(Boolean);
  // Keys are lowercased for comparison; labels keep the original spelling.
  for (const key of keys) {
    const parts = partsFor(key);
    const label = (parts.length > 0 ? parts[parts.length - 1] : "").toLowerCase();
    used.set(label, (used.get(label) ?? 0) + 1);
  }
  for (const key of keys) {
    const parts = partsFor(key);
    const label = parts.length > 0 ? parts[parts.length - 1] : t.noProject;
    if ((used.get(label.toLowerCase()) ?? 0) > 1 && parts.length > 1) {
      labels.set(key, `${parts[parts.length - 2]}/${label}`);
    } else {
      labels.set(key, label);
    }
  }
  return labels;
}

function projectLabel(cwd) {
  const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : t.noProject;
}

/**
 * Start a conversation in `target`: move the workspace there, then open a new
 * session. Both paths in the workspace row — the "+" and the empty-state
 * button — go through here so they cannot drift apart.
 *
 * A `setCwd` makes the host adopt the folder and reply with a `state` event,
 * which is also when a fresh session can be created; the host refuses a
 * workspace switch mid-run, so the new-session command is only sent when the
 * target is already the open folder. Moving first and creating in the same
 * breath would create the session in the old folder under a running task.
 */
function startSessionIn(target) {
  if (target && target !== state.cwd) {
    api.send({ cmd: "setCwd", cwd: target });
    return;
  }
  // The evidence filter is a view of one transcript. Carrying it across a
  // session boundary would open the new conversation looking empty, and the
  // switch that explains why is a corner of the composer.
  setEvidenceFilter(false);
  clearAttachments();
  api.send({ cmd: "newSession" });
}

/**
 * 清空附件条。会话边界（新建 / 打开另一条会话）都要调它。
 *
 * 内核没有图片输入，`submit()` 只要看到附件就拒绝发送；把上一条会话的图留到
 * 新会话上，用户会撞上一个来路不明的阻塞（D-224）。
 */
function clearAttachments() {
  if (state.attachments.length === 0) return;
  state.attachments = [];
  renderAttachments();
}

/**
 * Sessions are grouped by workspace, and that grouping is the list's level
 * structure: the first level is a folder, the second the conversations inside
 * it. The workspace you are in is always on the list, even before it holds a
 * conversation — after picking a folder the sidebar has to show that the
 * switch happened, or the picker looks like it did nothing.
 *
 * Fold state is per workspace and remembered across restarts.
 */
function renderSessions(sessions) {
  state.sessions = sessions || [];
  sessionList.innerHTML = "";
  const query = state.sessionQuery.trim().toLowerCase();
  // A query goes to the host, which searches every saved transcript. The local
  // filter only ran over the page already in memory, so a match on the 81st
  // session reported that no such conversation existed.
  const visible = state.sessionMatches
    ? state.sessionMatches
    : query
      ? state.sessions.filter(
          (session) =>
            (session.title ?? session.summary).toLowerCase().includes(query) ||
            session.summary.toLowerCase().includes(query) ||
            session.cwd.toLowerCase().includes(query),
        )
      : state.sessions;
  const activeProject = normalizeCwd(state.cwd);
  // The open workspace gets a row of its own even with nothing inside it, but
  // only outside a search: during a search the list answers "what matched",
  // and an empty workspace row would read as a second, contradictory result.
  const showActiveOnly =
    !query && activeProject !== "" && !visible.some((session) => normalizeCwd(session.cwd) === activeProject);
  if (visible.length === 0 && !showActiveOnly) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = state.sessions.length === 0 ? t.noSessions : t.noSessionMatches;
    sessionList.appendChild(empty);
    return;
  }

  // Group by workspace, keeping the recency order of first appearance so the
  // project you just worked in stays on top. Older sessions stored the same
  // folder with different separators (G:\x vs G:/x), so keys are normalized.
  const groups = new Map();
  const displayPath = new Map();
  if (showActiveOnly) {
    // Inserted before the loop, so the folder you are in is where the eye
    // starts even when it is the only row.
    groups.set(activeProject, []);
    displayPath.set(activeProject, state.cwd ?? "");
  }
  for (const session of visible) {
    const key = normalizeCwd(session.cwd);
    if (!groups.has(key)) {
      groups.set(key, []);
      displayPath.set(key, session.cwd || "");
    }
    groups.get(key).push(session);
  }
  // A search result should reveal its projects rather than hide them.
  const expandAll = Boolean(query);

  const labels = projectLabels([...groups.keys()], displayPath);
  for (const [cwd, items] of groups) {
    // The open project expands to its conversations; a folded one is a single
    // row carrying the count, because a folder that still shows children is
    // not folded.
    const explicitOpen = state.expandedProjects.has(cwd) && !state.collapsedProjects.has(cwd);
    const explicitClosed = state.collapsedProjects.has(cwd);
    const open = expandAll || explicitOpen || (!explicitClosed && cwd === activeProject);
    const label = labels.get(cwd) ?? projectLabel(displayPath.get(cwd) || cwd);
    const target = displayPath.get(cwd) || cwd;
    // A `div` with the button role, not a `<button>`.
    //
    // The row carries two independent controls: folding the group, and
    // archiving its conversations. A `<button>` cannot contain another
    // interactive element — the HTML parser hoists the inner one out, which is
    // why the remove control used to end up as a *sibling* of the row and its
    // `:focus-within` rule could never match. A role-bearing div keeps the same
    // keyboard and screen-reader semantics without the nesting restriction.
    const head = document.createElement("div");
    head.className = `session-group${cwd === activeProject ? " active" : ""}`;
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    // Fold state is the chevron; identity is the folder. A workspace row
    // without the folder glyph reads as a plain text label, which is why the
    // old list had no visible levels even though the grouping existed.
    const twisty = document.createElement("span");
    twisty.className = "session-group-twisty";
    twisty.innerHTML = icon(open ? "chevron-down" : "chevron-right");
    const glyph = document.createElement("span");
    glyph.className = "session-group-glyph";
    glyph.innerHTML = icon("folder");
    const name = document.createElement("span");
    name.className = "session-group-name";
    name.textContent = label;
    name.title = displayPath.get(cwd) || cwd || t.noProject;
    const count = document.createElement("span");
    count.className = "session-group-count";
    count.textContent = String(items.length);
    // New chat inside this project, without leaving the current conversation.
    //
    // Built after the locale sweep, so it names itself here; "+" is
    // punctuation and cannot serve as a name. It stays a mouse affordance: the
    // stylesheet only draws it on `:hover` / `.session-group:focus-visible`,
    // and making it tabbable without a `:focus-within` rule would hide the
    // control the moment it took focus, dropping focus to nowhere. The
    // keyboard routes into a new conversation are `#new-session` and the
    // workspace row's "new chat" button.
    const add = document.createElement("span");
    add.className = "session-group-add";
    add.title = t.newSessionIn(label);
    add.setAttribute("aria-label", t.newSessionIn(label));
    add.textContent = "+";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      startSessionIn(target);
    });
    head.append(twisty, glyph, name, count, add);
    // "Remove this workspace" — which here means archiving its conversations.
    // A workspace is derived from session `cwd`s, so there is no folder entry
    // to delete, and the folder itself is the user's own project: this
    // control never touches the filesystem.
    //
    // Absent in three cases, all because `items` would not be the whole
    // workspace: an empty active workspace (nothing to archive), a live search
    // (rows are matches, not a workspace), and the archived filter (the rows
    // are already archived). Acting on a partial group while looking like a
    // workspace action would archive fewer sessions than the label promises.
    const wholeWorkspace = !query && !state.sessionMatches && state.showArchived !== true;
    //
    // Same interaction as the row's own … menu: out of the way until the row
    // is hovered or focused, then an explicit click. Nothing here acts on
    // hover.
    if (items.length > 0 && wholeWorkspace) {
      // 真按钮而非 span+role=button：键盘行为（Enter/Space）、禁用语义、
      // 焦点是 button 自带的，不用手工维护一份等价实现。
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "session-group-remove";
      remove.title = t.workspaceRemove;
      remove.setAttribute("aria-label", t.workspaceRemove);
      remove.innerHTML = icon("archive");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void removeWorkspace(label, items);
      });
      head.appendChild(remove);
    }
    const toggle = () => {
      if (open) {
        state.expandedProjects.delete(cwd);
        state.collapsedProjects.add(cwd);
      } else {
        state.expandedProjects.add(cwd);
        state.collapsedProjects.delete(cwd);
      }
      localStorage.setItem("prometheus.expandedProjects", JSON.stringify([...state.expandedProjects]));
      localStorage.setItem("prometheus.collapsedProjects", JSON.stringify([...state.collapsedProjects]));
      renderSessions(state.sessions);
    };
    head.addEventListener("click", toggle);
    // A div with role=button gets none of a real button's keyboard behaviour.
    // Without this the group could only be folded with a mouse, and the remove
    // control inside it would be unreachable in a way that looks like a
    // rendering bug rather than a missing handler.
    head.addEventListener("keydown", (event) => {
      // The remove control handles its own keys and stops propagation; this
      // fires only when the row itself has focus.
      if (event.target !== head) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
    sessionList.appendChild(head);
    // A folded project shows only its name. Leaving a few conversations visible
    // defeats the point of folding: the list is still crowded, and the count on
    // the group row already says how many are inside.
    const shown = open ? items : [];

    if (open && shown.length === 0) {
      // The folder you just switched to has nothing in it yet. Saying so is the
      // point: a workspace row with no children and no explanation is
      // indistinguishable from a list that failed to load (R3).
      const empty = document.createElement("div");
      empty.className = "session-empty";
      const hint = document.createElement("span");
      hint.className = "session-empty-hint";
      hint.textContent = t.noWorkspaceSessions;
      const start = document.createElement("button");
      start.className = "session-empty-action";
      start.textContent = t.newSession;
      start.addEventListener("click", () => startSessionIn(target));
      empty.append(hint, start);
      sessionList.appendChild(empty);
    }

    for (const session of shown) {
      const button = document.createElement("button");
      button.className = `session-item${session.id === state.sessionId ? " active" : ""}${session.pinned ? " pinned" : ""}`;
      // The row can be addressed for a status-only update, which avoids
      // rebuilding (and losing focus in) the whole sidebar twice per change:
      // the host sends `session_status` and then a fresh `sessions` list.
      button.dataset.sessionId = session.id;
      const title = session.title || (session.summary && session.summary !== "(no messages)" ? session.summary : t.noMessages);
      // The timestamp is reference, not navigation: it appears on hover and
      // gives the row back its second line of height.
      const status = session.status && session.status !== "ready" ? session.status : "";
      // The markers share one fixed-width lane so a row with a run-state dot
      // or a pin does not push its title right: every conversation title has
      // to start on the same edge, which is the workspace name above it.
      button.innerHTML =
        `<span class="session-flags">` +
        (status ? `<span class="session-state ${status}" title="${escapeHtml(t.sessionStatusLabel(status))}"></span>` : "") +
        (session.pinned ? `<span class="session-pin" title="${escapeHtml(t.sessionPinned)}">${icon("pin")}</span>` : "") +
        `</span>` +
        `<div class="session-title">${escapeHtml(title)}</div>` +
        `<span class="session-meta">${escapeHtml(relativeDate(session.updatedAt))}</span>`;
      button.title = `${title}\n${relativeDate(session.updatedAt)}\n${session.cwd}`;
      button.addEventListener("click", () => {
        api.send({ cmd: "loadSession", id: session.id });
        // On a narrow window the drawer covers the conversation once opened;
        // `isDrawerWidth` is the same breakpoint the stylesheet uses.
        if (isDrawerWidth()) document.querySelector(".shell").classList.add("collapsed");
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openSessionMenu(event, session);
      });
      // The same actions behind a visible control. A right-click menu is
      // invisible to anyone who does not think to try one, and the session
      // row is where pinning and renaming belong.
      const more = document.createElement("span");
      more.className = "session-more";
      more.setAttribute("role", "button");
      more.tabIndex = 0;
      // Built after the locale sweep ran, so it has to name itself: nothing
      // revisits this node to add the label. The glyph inside is `▁`-shaped
      // and carries no letters, so it cannot stand in as the name.
      more.title = t.sessionMenu;
      more.setAttribute("aria-label", t.sessionMenu);
      more.innerHTML = icon("more");
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        const rect = more.getBoundingClientRect();
        openSessionMenu({ clientX: rect.left, clientY: rect.bottom, preventDefault() {} }, session);
      });
      more.addEventListener("keydown", (event) => {
        // The menu key is what a keyboard user reaches for; both open it.
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          const rect = more.getBoundingClientRect();
          openSessionMenu({ clientX: rect.left, clientY: rect.bottom, preventDefault() {} }, session);
        }
      });
      button.appendChild(more);
      sessionList.appendChild(button);
    }
  }

  // Older conversations are reachable instead of silently missing. The host
  // used to cap the list at 80 with no way past it, so search only ever saw
  // the newest 80 and an old session could not be opened at all.
  if (!query && state.sessionsTotal > state.sessions.length) {
    const more = document.createElement("button");
    more.className = "sidebar-more";
    more.textContent = t.loadMoreSessions.replace("{n}", String(state.sessionsTotal - state.sessions.length));
    more.addEventListener("click", () => {
      api.send({ cmd: "listSessions", includeArchived: state.showArchived, limit: state.sessionsLimit + 200 });
    });
    sessionList.appendChild(more);
  }
}

/**
 * Remove a workspace from the sidebar by archiving the conversations inside
 * it.
 *
 * There is no "workspace" object to delete: the level is derived from the
 * `cwd` each session recorded, so the only thing the sidebar can act on is
 * the rows in that group. Archiving them is the recoverable form of removal —
 * the sessions disappear from the default list, the "show archived" filter
 * brings them back, and not one file is touched. That matters twice over:
 * deleting session directories is unrecoverable, and the workspace path is the
 * user's real project folder, which this app must never remove.
 *
 * The ids come from the group being rendered rather than from a `cwd` match on
 * the host: the renderer owns the workspace key (`normalizeCwd`) and already
 * knows exactly which rows are in the group. Sending a cwd would make the host
 * re-derive the same grouping with a second copy of the rule.
 */
async function removeWorkspace(label, sessions) {
  const ids = sessions.map((session) => session.id).filter((id) => typeof id === "string" && id !== "");
  if (ids.length === 0) return;
  const yes = await confirmAction(t.workspaceRemoveConfirm(label, ids.length), { danger: false });
  if (!yes) return;
  api.send({ cmd: "archiveSessions", ids });
}

let sessionMenu = null;

function closeSessionMenu() {
  if (sessionMenu) {
    sessionMenu.remove();
    sessionMenu = null;
  }
}

/**
 * Right-click actions for one session: pin, rename, fork, archive, delete.
 *
 * Split view is not offered: it needs a second BrowserWindow, and this shell
 * creates exactly one — the preload has no `splitWindow`, so the row would
 * throw on click rather than open anything.
 */
function openSessionMenu(event, session) {
  closeSessionMenu();
  const menu = document.createElement("div");
  menu.className = "session-menu";
  const actions = [
    [session.pinned ? t.sessionUnpin : t.sessionPin, () => sendSessionFlags(session, { pinned: !session.pinned })],
    [t.sessionRename, () => renameSession(session)],
    [t.sessionFork, () => api.send({ cmd: "forkSession", id: session.id })],
    [session.archived ? t.sessionUnarchive : t.sessionArchive, () => {
      sendSessionFlags(session, { archived: !session.archived });
    }],
    [t.sessionDelete, () => {
      void confirmAction(t.sessionDeleteConfirm, { danger: true }).then((yes) => {
        if (yes) api.send({ cmd: "deleteSession", id: session.id, includeArchived: state.showArchived });
      });
    }],
  ];
  for (const [label, action] of actions) {
    const item = document.createElement("button");
    item.className = "session-menu-item";
    item.textContent = label;
    if (label === t.sessionDelete) item.classList.add("danger");
    item.addEventListener("click", () => {
      closeSessionMenu();
      action();
    });
    menu.appendChild(item);
  }
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  document.body.appendChild(menu);
  sessionMenu = menu;
}

function sendSessionFlags(session, flags) {  api.send({ cmd: "sessionFlags", id: session.id, includeArchived: state.showArchived, ...flags });
}

function renameSession(session) {
  const current = session.title || session.summary || "";
  askText(t.sessionRenamePrompt, current).then((next) => {
    if (next === null) return;
    sendSessionFlags(session, { title: next.trim() || null });
  });
}

document.addEventListener("mousedown", (event) => {
  if (sessionMenu && !event.target.closest(".session-menu")) closeSessionMenu();
});
window.addEventListener("blur", closeSessionMenu);


function setDensity(density) {
  state.density = density;
  document.documentElement.dataset.density = density;
  localStorage.setItem("prometheus.density", density);
}

const systemTheme = matchMedia("(prefers-color-scheme: light)");
systemTheme.addEventListener("change", () => {
  // High contrast follows the same light/dark choice as "system"; both
  // resolve again when the OS preference flips.
  if (state.theme === "system" || state.theme === "high-contrast") {
    document.documentElement.dataset.theme = resolvedTheme(state.theme);
  }
});

function resolvedTheme(theme) {
  if (theme === "high-contrast") {
    // The high-contrast theme follows the system's light/dark choice for its
    // base, then raises every text and border token; it is a variant, not a
    // third palette.
    return systemTheme.matches ? "light-contrast" : "contrast";
  }
  if (theme !== "system") return theme;
  return systemTheme.matches ? "light" : "dark";
}

/** The code font preference swaps the monospace stack for the whole window. */
function applyCodeFont(font) {
  const stack = String(font ?? "").trim()
    ? `"${String(font).trim()}", "SF Mono", "Cascadia Code", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace`
    : '"SF Mono", "Cascadia Code", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
  document.documentElement.style.setProperty("--mono", stack);
  localStorage.setItem("prometheus.codeFont", String(font ?? ""));
}

/**
 * Apply a theme choice.
 *
 * `remember: false` is for values that were *derived*, not chosen: boot
 * resolves "follow the system" to light/dark for the first paint, and writing
 * that resolution back to storage turned the choice into a fixed theme after
 * one launch.
 */
function setTheme(theme, { remember = true } = {}) {
  state.theme = theme;
  syncMenuControls();
  document.documentElement.dataset.theme = resolvedTheme(theme);
  if (remember) localStorage.setItem("prometheus.theme", theme);
}

/* ---------- composer ---------- */

function autoSize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(220, input.scrollHeight)}px`;
}

/** Messages sent from this window, newest first; Up/Down walks them. */
const history = [];
let historyIndex = -1;
let draft = "";
const HISTORY_LIMIT = 100;

function rememberInHistory(text) {
  if (!text.trim()) return;
  if (history[0] === text) return;
  history.unshift(text);
  if (history.length > HISTORY_LIMIT) history.pop();
  historyIndex = -1;
  draft = "";
}

function submit() {
  const text = input.value.trim();
  // A subagent's record has no live session behind it. The input is disabled
  // there, so this is the keyboard path and the send button's; both are
  // refused with the same sentence the lock note gives, and the draft stays:
  // the reader may want to paste it into the parent conversation once they go
  // back.
  if (state.readonly !== null) {
    addNotice("warn", t.readonlyComposerReason);
    scrollToBottom();
    return;
  }
  // A turn already running refuses this message at the host (`session_busy`),
  // so say it here before anything leaves the window. The draft stays in the
  // box and no bubble is drawn: a bubble for a message the host never received
  // is the transcript claiming a turn that did not happen (D-186, R3).
  if (state.busy) {
    addNotice("warn", t.busyThisTurn);
    scrollToBottom();
    return;
  }
  // A slash command is not a prompt. Reading it before anything else keeps
  // `/clear` out of the model's inbox; an unknown name is named and left in
  // the box instead of being sent, so a typo costs a notice, not a turn.
  //
  // It is still *shown* as a message when it runs — `runSlashCommand` echoes
  // the typed text — but that bubble is this window's own record, not a
  // `prompt` command: the kernel has no slash verbs, so forwarding `/clear`
  // would only buy a model reply saying it cannot clear the conversation.
  //
  // A skill name is in the same list and is resolved by the same function: it
  // expands to a prompt and is sent as one, while the bubble keeps the typed
  // `/name args`.
  const slash = parseSlashText(text);
  if (slash !== null && commandList().some((command) => command.name === slash.name)) {
    if (runSlashCommand(slash, text) === "ran") {
      input.value = "";
      autoSize();
      // Up-arrow walks what was typed, commands included. Remembering only
      // prompts made a just-run `/compact` unreachable without retyping it.
      rememberInHistory(text);
    }
    return;
  }
  // A slash-looking message whose verb this window does not know: answer it
  // here and keep the draft. Sending it would spend a turn on text the model
  // cannot act on, and `/deploy` in the transcript would read as if it ran.
  if (slash !== null) {
    reportUnknownCommand(slash.name, commandList());
    return;
  }
  // This kernel has no image input (`ModelChatMessage.content` is a string and
  // the adapter never sends `image_url`), so an attached image cannot travel
  // with the message. Sending the text anyway would leave a thumbnail on the
  // strip and a model that never saw it — the failure this check exists to
  // stop (D-188, R3). The strip keeps its images and its remove buttons, and
  // the draft stays put until the user decides.
  //
  // It sits after the slash branch on purpose: `/clear` and `/context` send no
  // prompt, so an image on the strip is not part of them. A skill command does
  // send one, and `runSkillCommand` enforces the same rule.
  if (state.attachments.length > 0) {
    addNotice("warn", t.attachmentNotSent);
    scrollToBottom();
    input.focus();
    return;
  }
  // A picked path is not uploaded either, but it costs nothing to tell the
  // model which paths the user meant: the path list is appended to the text,
  // so the promise made when the path was added ("this is part of your
  // message") is kept without a kernel change.
  const mentions = state.mentionFiles.filter((path) => typeof path === "string" && path !== "");
  if (!text && mentions.length === 0) return;
  const withMentions =
    mentions.length === 0
      ? text
      : `${text}\n\n${t.mentionPathsHeader}\n${mentions.map((path) => `- ${path}`).join("\n")}`.trim();
  input.value = "";
  autoSize();
  rememberInHistory(text);
  // The bubble shows exactly what went to the host, path block included: a
  // transcript that hides part of the message cannot be used to explain what
  // the model answered.
  addUserTurn(withMentions, 0);
  api.send({ cmd: "prompt", text: withMentions });
  // Delivered. Keeping them would append the same paths to the next message.
  state.mentionFiles = [];
  input.focus();
}

input.addEventListener("input", () => {
  autoSize();
});
input.addEventListener("keydown", (event) => {
  if (!commandMenu.hidden && commandState) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveCommand(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeCommandMenu();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      applyCommand(commandState.matches[commandState.index]);
      return;
    }
  }
  if (!fileMention.hidden && mention) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveMention(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMention();
      return;
    }
    // Only a row consumes Enter/Tab. The popup can be open with no rows — the
    // stale-`dist/` note (D-184 ②) or a query that has not answered yet — and
    // swallowing Enter there would stop the message from being sent while the
    // screen shows nothing selectable.
    if (
      (event.key === "Enter" || event.key === "Tab")
      && !event.shiftKey
      && !event.isComposing
      && mention.files.length > 0
    ) {
      event.preventDefault();
      const entry = mention.files[mention.index];
      // `{path, kind?}` since D-184 ① — never the bare string it used to be.
      const path = typeof entry === "string" ? entry : String(entry?.path ?? "");
      if (path !== "") applyMention(path);
      return;
    }
  }
  // Up/Down walk the messages this window sent. Only when the caret is on the
  // first or last line, so arrows still move within a multi-line draft.
  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.isComposing) {
    const beforeCaret = input.value.slice(0, input.selectionStart);
    const afterCaret = input.value.slice(input.selectionStart);
    const caretAtEdge = event.key === "ArrowUp" ? !beforeCaret.includes("\n") : !afterCaret.includes("\n");
    if (caretAtEdge && (history.length > 0 || historyIndex >= 0)) {
      event.preventDefault();
      if (event.key === "ArrowUp") {
        if (historyIndex === -1) draft = input.value;
        historyIndex = Math.min(history.length - 1, historyIndex + 1);
      } else {
        historyIndex = historyIndex <= 0 ? -1 : historyIndex - 1;
      }
      input.value = historyIndex >= 0 ? history[historyIndex] : draft;
      autoSize();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});

sendButton.addEventListener("click", submit);
stopButton.addEventListener("click", () => {
  api.send({ cmd: "abort" });
  input.focus();
});

/**
 * True when the focus sits in a field where Escape may mean something else.
 *
 * Used by the window-level Escape chain: closing a panel out from under a
 * caret would be a surprise, and the fields that take Escape themselves (the
 * command palette, the mention popup, the model filter) already stop the
 * event before it gets here.
 */
function isTextEntry(node) {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

// The model menu's own keys (arrows, Home/End, Enter, Escape, Tab) are handled
// first: it is the innermost open surface, and Escape must dismiss it before
// any outer handler decides the key means something else.
document.addEventListener("keydown", (event) => {
  if (handleModelMenuKey(event)) return;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (paletteState) {
      closePalette();
      return;
    }
    if (!findBar.hidden) {
      closeFind();
      return;
    }
    if (!settingsDialog.hidden || !shortcutsDialog.hidden) {
      // Settings owns a draft (the model-services page is the only page with a
      // Save step), so it decides whether closing is allowed: with unsaved
      // edits it asks first. The shortcut sheet has nothing to lose and closes
      // straight away — including when both are open, which happens when the
      // sheet is summoned from inside Settings. The ordering of this whole
      // chain is unchanged: this branch still runs in the same place, and a
      // refusal only means the Settings dialog stays open.
      //
      // `preventDefault` is load-bearing, not defensive. Both dialogs here are
      // `showModal()`, so without it the browser turns this same keypress into
      // a native close request *after* this handler returns — and it lands on
      // whichever dialog is on top by then. With a draft, that is the
      // confirmation `requestClose` just opened: Escape would open the prompt
      // and dismiss it in the same keystroke, then natively close Settings
      // behind a `hidden` attribute that still said "open" (measured: the
      // dialog left the top layer while `settingsDialog.hidden === false`).
      event.preventDefault();
      closeModal(shortcutsDialog);
      if (!settingsDialog.hidden) void settings.requestClose();
      return;
    }
    if (!topbarMenu.hidden) {
      setTopbarMenu(false);
      return;
    }
    if (!modelMenu.hidden) {
      closeModelMenu({ restoreFocus: true });
      return;
    }
    if (!pendingPermission.hidden) {
      answerPermission("no");
      return;
    }
    // The workbench is the last *surface* before the fallback. It sits after
    // the menus and dialogs because those are floating panels drawn over it,
    // and before "abort the turn" because closing a panel is the smaller
    // action. A text field is the exception: the shortcut sheet promises
    // Escape means "stop the current turn", and the composer holds the caret
    // for most of a session — taking the key there to close a side panel
    // would break that promise mid-run. Escape inside a field therefore
    // belongs to the field.
    if (!workbench.hidden && !isTextEntry(document.activeElement)) {
      closeWorkbench();
      return;
    }
    if (state.busy) api.send({ cmd: "abort" });
    return;
  }
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;
  const key = event.key.toLowerCase();
  if (key === "k") {
    event.preventDefault();
    openPalette();
  } else if (key === "f") {
    event.preventDefault();
    // Ctrl+F means "find what I am looking at": in the settings dialog that is
    // the settings list, not the transcript behind it.
    if (!settingsDialog.hidden) {
      const search = $("settings-search");
      search.focus();
      search.select();
      return;
    }
    openFind();
  } else if (key === "n") {
    event.preventDefault();
    api.send({ cmd: "newSession" });
  } else if (key === "b") {
    event.preventDefault();
    toggleSidebar();
  } else if (key === ",") {
    event.preventDefault();
    openSettings();
  } else if (key === "/" || key === "?") {
    event.preventDefault();
    openShortcuts();
  } else if (key === "1" || key === "2" || key === "3" || key === "4") {
    event.preventDefault();
    const mode = MODES[Number(key) - 1];
    if (mode !== undefined && mode !== state.mode) {
      setMode(mode);
      api.send({ cmd: "setMode", mode });
    }
  } else if (key === "e") {
    // Ctrl+Shift+E lands here too: the branch that used to swallow it with
    // `event.shiftKey` is gone (2026-10-26), so Shift+E now cycles thinking
    // effort exactly like plain E. That is deliberate — the key it used to
    // mean had no pane behind it, and an accepted shortcut that does the
    // effort cycle beats one that does nothing while the sheet lists neither.
    event.preventDefault();
    // Silent when the model has no levels: the control is hidden, and sending
    // anyway would earn one warning per keypress for a setting the user cannot
    // see (D-169's complaint about this exact shortcut).
    if (effortLevels().length === 0) return;
    // Cycle through what this model actually accepts, not a fixed four. The
    // index advances from the chip's current value, and the host's answering
    // `state` is what moves it — same rule as the menu click above.
    const order = ["auto", ...effortLevels()];
    const next = order[(order.indexOf(state.effort) + 1) % order.length];
    api.send({ cmd: "setEffort", effort: next });
  } else if (key === "\\") {
    event.preventDefault();
    closeWorkbench();
  }
});

/**
 * Did this click land on the model panel — asked **before** the click's own
 * handler can rebuild the panel.
 *
 * Bubble-time geometry cannot answer that question: picking a provider (and
 * refreshing the list) re-renders the menu, which replaces its children. The
 * clicked button is then detached, so `event.target.closest("#model-menu")`
 * is null by the time the document-level dismissal runs, and a click on the
 * panel's own controls was indistinguishable from a click outside it — the
 * panel closed the moment a vendor was chosen. The capture phase runs first,
 * while the DOM the user clicked still exists.
 */
let modelMenuClickInside = false;
document.addEventListener(
  "click",
  (event) => {
    const target = event.target;
    modelMenuClickInside = Boolean(
      target?.closest?.("#model-menu") || target?.closest?.(".model-control"),
    );
  },
  true,
);

document.addEventListener("click", (event) => {
  if (modelMenu.hidden) return;
  if (modelMenuClickInside) return;
  // Belt and braces: a click synthesised without a capture pass (or one whose
  // target is still attached) is still recognised by geometry.
  if (event.target.closest?.(".model-control") || event.target.closest?.("#model-menu")) return;
  closeModelMenu();
});



/* ---------- pasted images ---------- */

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function addAttachment(dataUrl, name) {
  if (state.attachments.length >= 6) {
    addNotice("warn", t.attachmentLimit);
    return;
  }
  state.attachments.push({ url: dataUrl, name: name || "image" });
  renderAttachments();
}

function renderAttachments() {
  const strip = $("attachments");
  strip.innerHTML = "";
  strip.hidden = state.attachments.length === 0;
  state.attachments.forEach((attachment, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment";
    chip.innerHTML =
      `<img src="${attachment.url}" alt="${escapeHtml(attachment.name)}" />` +
      `<button class="attachment-remove" title="${escapeHtml(t.attachmentRemove)}">${icon("x")}</button>`;
    chip.querySelector(".attachment-remove").addEventListener("click", () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    strip.appendChild(chip);
  });
}

/**
 * Paste or drop files into the composer.
 *
 * Images travel as data URLs (the model sees them). Text and PDFs are passed
 * by path and the host reads them: a log file dropped into the composer used
 * to be silently ignored, which is exactly the file a user debugging a build
 * wants to show the agent.
 */
function handleImageFiles(files) {
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      if (file.size > MAX_IMAGE_BYTES) {
        addNotice("warn", t.attachmentTooLarge);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => addAttachment(String(reader.result), file.name);
      reader.readAsDataURL(file);
      continue;
    }
    // Electron exposes the real path on dropped files, and without one there
    // is nothing useful to send.
    const path = file.path;
    if (!path) {
      addNotice("warn", t.attachmentUnsupported);
      continue;
    }
    if (!state.mentionFiles.includes(path)) state.mentionFiles.push(path);
    addNotice("dim", t.mentionAdded(file.name));
  }
}

input.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length === 0) return;
  event.preventDefault();
  handleImageFiles(files);
});

document.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length === 0) return;
  event.preventDefault();
  handleImageFiles(files);
});
document.addEventListener("dragover", (event) => {
  if ([...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault();
});


/* ---------- pull request and checks ---------- */

function renderPrBar() {
  const bar = $("pr-bar");
  const info = state.pr;
  if (!info || !info.available) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const pr = info.pr;
  $("pr-create").hidden = Boolean(pr);
  $("pr-open").hidden = !pr;
  const failing = Boolean(pr && pr.checks && pr.checks.failed > 0);
  state.prNumber = pr?.number ?? null;
  $("pr-fix-ci").hidden = !failing;
  $("pr-rerun").hidden = !failing;
  if (!pr) {
    $("pr-state").textContent = t.prNone;
    $("pr-state").className = "pr-state";
    $("pr-title").textContent = "";
    $("pr-checks").textContent = "";
    return;
  }
  const stateLabel = pr.isDraft ? t.prDraft : pr.state === "OPEN" ? t.prOpenState : pr.state === "MERGED" ? t.prMerged : t.prClosed;
  $("pr-state").textContent = `#${pr.number} ${stateLabel}`;
  $("pr-state").className = `pr-state ${pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? "open" : "closed"}`;
  $("pr-title").textContent = pr.title ?? "";
  $("pr-title").title = pr.title ?? "";
  const checks = pr.checks ?? { total: 0 };
  if (checks.total === 0) {
    $("pr-checks").textContent = "";
  } else if (checks.failed > 0) {
    $("pr-checks").textContent = t.checksFailed(checks.failed, checks.total);
    $("pr-checks").className = "pr-checks failed";
    $("pr-checks").title = checks.failing.join("\n");
  } else if (checks.pending > 0) {
    $("pr-checks").textContent = t.checksPending(checks.pending, checks.total);
    $("pr-checks").className = "pr-checks pending";
  } else {
    $("pr-checks").textContent = t.checksPassed(checks.total);
    $("pr-checks").className = "pr-checks passed";
  }
}

$("pr-open").addEventListener("click", () => {
  if (state.pr?.pr?.url) api.openExternal(state.pr.pr.url);
});

$("pr-rerun").addEventListener("click", () => {
  api.send({ cmd: "prRerun", number: state.prNumber });
});

$("pr-fix-ci").addEventListener("click", () => {
  // The log becomes a normal turn: the transcript shows what the agent did
  // with it, and the user can interrupt.
  api.send({ cmd: "prFixCi", number: state.prNumber });
});

$("pr-create").addEventListener("click", async () => {
  // A PR needs a pushed branch; ask the agent to run the push so the user sees
  // the command in the transcript instead of it happening silently.
  const current = state.sessions.find((session) => session.id === state.sessionId);
  const title = await askText(t.prTitlePrompt, current?.title || current?.summary || "");
  if (title === null) return;
  api.send({ cmd: "createPr", title: title.trim(), body: t.prBodyDefault });
});

/**
 * Ask for one line of text.
 *
 * `window.prompt()` does not work in Electron: it is not implemented and
 * returns null without showing anything, so every call site that used it
 * looked like a dead button. This wraps a real `<dialog>` in the same shape —
 * resolves to the string, or null when cancelled.
 */
function askText(label, value = "") {
  return new Promise((resolve) => {
    const dialog = $("input-dialog");
    const field = $("input-dialog-field");
    $("input-dialog-label").textContent = label;
    field.value = value;

    const done = (result) => {
      dialog.removeEventListener("close", onClose);
      $("input-dialog-cancel").removeEventListener("click", onCancel);
      resolve(result);
    };
    const onCancel = () => dialog.close();
    const onClose = () => {
      // `returnValue` is "ok" only when the form was submitted; closing by Esc
      // or the cancel button leaves it empty.
      done(dialog.returnValue === "ok" ? field.value : null);
    };

    dialog.returnValue = "";
    dialog.addEventListener("close", onClose, { once: true });
    $("input-dialog-cancel").addEventListener("click", onCancel);

    dialog.showModal();
    field.focus();
    field.select();
  });
}

/* ---------- command palette ---------- */

/**
 * One searchable list of actions and open commands. It is the discoverable
 * counterpart to the keyboard shortcuts, not a second implementation: every
 * entry calls the same function the button or shortcut calls.
 */
function paletteEntries() {
  // Only actions with a backend are listed. A palette row that answers with
  // "not connected" is a dead end disguised as a feature; the entries that
  // remain all work against this kernel.
  const entries = [
    { label: t.newSession, run: () => api.send({ cmd: "newSession" }) },
    { label: t.shortcutSettings, run: openSettings },
    { label: t.shortcutShortcuts, run: openShortcuts },
    { label: t.toggleSidebar, run: toggleSidebar },
    { label: t.shortcutFind, run: openFind },
    ...MODES.map((mode) => ({
      label: modeCopy(mode).label,
      run: () => {
        setMode(mode);
        api.send({ cmd: "setMode", mode });
      },
    })),
    { label: t.shortcutStop, run: () => api.send({ cmd: "abort" }) },
  ];
  for (const command of commandList()) {
    entries.push({
      label: `/${command.name}`,
      hint: command.description || command.argumentHint || "",
      // The same rule as the popup: no argument hint runs it, a hint inserts
      // the name and waits. The palette does not go through `applyCommand`
      // because that one empties the composer first — right for a click in a
      // draft, wrong here, where the palette opened over text the user is
      // still writing.
      run: () => {
        if (!command.argumentHint) {
          runSlashCommand({ name: command.name, args: "" });
          return;
        }
        input.value = `/${command.name} `;
        autoSize();
        input.focus();
      },
    });
  }
  return entries;
}

let paletteState = null;

function openPalette() {
  paletteState = { index: 0, entries: [] };
  $("palette-scrim").hidden = false;
  $("command-palette").hidden = false;
  const field = $("palette-input");
  field.value = "";
  field.placeholder = t.palettePlaceholder;
  renderPalette();
  field.focus();
}

function closePalette() {
  paletteState = null;
  $("palette-scrim").hidden = true;
  $("command-palette").hidden = true;
  input.focus();
}

function renderPalette() {
  if (!paletteState) return;
  const query = $("palette-input").value.trim().toLowerCase();
  const all = paletteEntries();
  const matches = query
    ? all.filter((entry) => entry.label.toLowerCase().includes(query) || (entry.hint ?? "").toLowerCase().includes(query))
    : all;
  paletteState.entries = matches;
  paletteState.index = Math.min(paletteState.index, Math.max(0, matches.length - 1));
  const list = $("palette-list");
  list.innerHTML = "";
  if (matches.length === 0) {
    list.innerHTML = `<div class="palette-empty">${escapeHtml(t.paletteEmpty)}</div>`;
    return;
  }
  matches.forEach((entry, index) => {
    const row = document.createElement("button");
    row.className = `palette-row${index === paletteState.index ? " active" : ""}`;
    row.innerHTML =
      `<span class="palette-label">${escapeHtml(entry.label)}</span>` +
      (entry.hint ? `<span class="palette-hint">${escapeHtml(entry.hint)}</span>` : "");
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      runPaletteEntry(entry);
    });
    list.appendChild(row);
  });
}

function runPaletteEntry(entry) {
  closePalette();
  entry?.run();
}

$("palette-input").addEventListener("input", renderPalette);
$("palette-input").addEventListener("keydown", (event) => {
  if (!paletteState) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = paletteState.entries.length;
    if (count === 0) return;
    paletteState.index = (paletteState.index + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
    renderPalette();
    $("palette-list").children[paletteState.index]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") {
    event.preventDefault();
    runPaletteEntry(paletteState.entries[paletteState.index]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
  }
});
$("palette-scrim").addEventListener("mousedown", closePalette);

/* ---------- scroll-to-latest ---------- */

transcript.addEventListener("scroll", updateScrollButton);
$("scroll-bottom").addEventListener("click", () => scrollToBottom(true));

/**
 * What a permission prompt is about.
 *
 * Approving `edit_file: src/app.ts` while seeing only the path is a rubber
 * stamp. Two shapes reach here:
 *
 *   - a host that computed the change sends `before`/`after`; those lines are
 *     rendered as a diff;
 *   - the kernel's own approval request carries `paramsPreview` — the call's
 *     arguments, already summarised and truncated. Without it the bar showed
 *     an empty box, and the operator approved a write they could not read
 *     (R2: declare before writing).
 */
function renderPendingDiff(detail) {
  const box = $("pending-diff");
  box.innerHTML = "";
  if (!detail || typeof detail !== "object") {
    box.hidden = true;
    return;
  }
  if (detail.before === undefined && detail.after === undefined) {
    renderPendingParams(box, detail);
    return;
  }
  const older = String(detail.before ?? "").split("\n");
  const newer = String(detail.after ?? "").split("\n");
  const olderSet = new Set(older);
  const newerSet = new Set(newer);
  const rows = [];
  let i = 0;
  let j = 0;
  // Leading context: the last unchanged lines before the first change, so the
  // hunk has somewhere to sit.
  const contextBefore = [];
  while (i < older.length && j < newer.length && older[i] === newer[j]) {
    contextBefore.push(older[i]);
    i++;
    j++;
  }
  for (const line of contextBefore.slice(-3)) rows.push({ kind: "context", text: line });
  while ((i < older.length || j < newer.length) && rows.length < 40) {
    if (i < older.length && j < newer.length && older[i] === newer[j]) {
      rows.push({ kind: "context", text: older[i] });
      i++;
      j++;
      continue;
    }
    if (i < older.length && !newerSet.has(older[i])) {
      rows.push({ kind: "del", text: older[i] });
      i++;
      continue;
    }
    if (j < newer.length && !olderSet.has(newer[j])) {
      rows.push({ kind: "add", text: newer[j] });
      j++;
      continue;
    }
    i++;
    j++;
  }
  for (const row of rows) {
    const node = document.createElement("div");
    node.className = `pending-diff-line ${row.kind}`;
    node.textContent = `${row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "} ${row.text}`;
    box.appendChild(node);
  }
  if (i < older.length || j < newer.length) {
    const more = document.createElement("div");
    more.className = "pending-diff-more";
    more.textContent = `+${detail.additions} −${detail.deletions} · ${detail.path}`;
    box.appendChild(more);
  }
  box.hidden = rows.length === 0;
}

/** Readable text for one argument value; objects are JSON, never `[object]`. */
function previewValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const shape = value;
    if (typeof shape.type === "string" && typeof shape.size === "number") {
      // The kernel summarises arrays/objects by shape rather than content.
      return `${shape.type}(${shape.size})`;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * The arguments a kernel approval request carries.
 *
 * Rendered as `key = value` rows so the operator can see the address and the
 * value about to be written — the declaration R2 asks for.
 */
function renderPendingParams(box, detail) {
  const preview = detail.paramsPreview;
  const rows = [];
  if (preview && typeof preview === "object" && !Array.isArray(preview)) {
    for (const [key, value] of Object.entries(preview)) {
      if (key === "previewTruncated") continue;
      rows.push({ key, value: previewValue(value) });
    }
  }
  if (rows.length === 0) {
    box.hidden = true;
    return;
  }
  const truncated = preview.previewTruncated === true;
  for (const row of rows) {
    const node = document.createElement("div");
    node.className = "pending-param";
    const key = document.createElement("span");
    key.className = "pending-param-key";
    key.textContent = row.key;
    const value = document.createElement("span");
    value.className = "pending-param-value";
    value.textContent = row.value;
    node.append(key, value);
    box.appendChild(node);
  }
  if (truncated) {
    const more = document.createElement("div");
    more.className = "pending-diff-more";
    more.textContent = t.pendingParamsTruncated;
    box.appendChild(more);
  }
  box.hidden = false;
}

/**
 * The clock on the approval bar.
 *
 * The kernel denies the request when its deadline passes and writes the
 * decision to the log; without a visible countdown the bar looks like it will
 * wait for as long as the operator takes, and the request silently dies.
 */
let pendingDeadlineTimer = null;

function stopPendingDeadline() {
  if (pendingDeadlineTimer !== null) {
    clearInterval(pendingDeadlineTimer);
    pendingDeadlineTimer = null;
  }
  const node = $("pending-deadline");
  if (node) node.hidden = true;
}

function startPendingDeadline(deadlineAt) {
  stopPendingDeadline();
  const node = $("pending-deadline");
  if (!node) return;
  const deadline = Date.parse(String(deadlineAt ?? ""));
  if (!Number.isFinite(deadline)) return;
  const tick = () => {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) {
      // The decision event closes the bar; until it lands, say what is true.
      node.textContent = t.pendingExpires(0);
      node.classList.add("expiring");
      return;
    }
    node.textContent = t.pendingExpires(left);
    node.classList.toggle("expiring", left <= 10);
  };
  tick();
  node.hidden = false;
  pendingDeadlineTimer = setInterval(tick, 1000);
}

function answerPermission(answer) {  if (state.pendingPermissionId == null) return;
  api.send({ cmd: "permission", id: state.pendingPermissionId, answer });
  state.pendingPermissionId = null;
  pendingPermission.hidden = true;
  $("pending-choices").hidden = true;
  stopPendingDeadline();
  input.focus();
}

pendingPermission.querySelectorAll("[data-permission]").forEach((button) => {
  button.addEventListener("click", () => answerPermission(button.dataset.permission));
});

// The mode menu is rebuilt on open, so it reads the current labels after a
// language switch and the current sandbox state after a settings change.
const modePicker = $("mode-picker");
const modeMenu = $("mode-menu");

function setModeMenu(open) {
  if (open) renderModeMenu();
  modeMenu.hidden = !open;
  modePicker.setAttribute("aria-expanded", String(open));
}

modePicker.addEventListener("click", (event) => {
  event.stopPropagation();
  setModeMenu(modeMenu.hidden);
});

modeMenu.addEventListener("click", (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  setModeMenu(false);
  if (button.dataset.mode === state.mode) return;
  // Show the choice at once; the host confirms with a state event, and a
  // rejected mode would be corrected by that same event.
  setMode(button.dataset.mode);
  api.send({ cmd: "setMode", mode: button.dataset.mode });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#mode-control")) setModeMenu(false);
});

/* ---------- the "+" menu ---------- */

const plusPicker = $("plus-button");
const plusMenu = $("plus-menu");

function setPlusMenu(open) {
  plusMenu.hidden = !open;
  plusPicker.setAttribute("aria-expanded", String(open));
}

plusPicker.addEventListener("click", (event) => {
  event.stopPropagation();
  setPlusMenu(plusMenu.hidden);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#plus-control")) setPlusMenu(false);
});

// Files and photos: the OS dialog, then the same path the drop handler takes,
// so an image becomes an attachment and anything else becomes a mention chip.
$("plus-add-files").addEventListener("click", async () => {
  setPlusMenu(false);
  const picked = (await api.pickFile({ multiple: true })) ?? [];
  const paths = Array.isArray(picked) ? picked : [picked];
  addPathsAsAttachments(paths);
});

// A folder is added as a mention: the agent then has a path to list rather
// than a directory tree pre-loaded into the prompt.
$("plus-add-folder").addEventListener("click", async () => {
  setPlusMenu(false);
  const folder = await api.pickDirectory();
  if (folder) addPathsAsAttachments([folder]);
});

// Slash commands open the same menu typing "/" does, at the caret.
$("plus-slash").addEventListener("click", () => {
  setPlusMenu(false);
  input.focus();
  const caret = input.selectionStart;
  // The menu only opens on "/" at the start of the input or after a space,
  // which is also the rule the parser uses for a real command.
  const needsSpace = input.value.length > 0 && !/\s$/.test(input.value.slice(0, caret));
  input.value = `${input.value.slice(0, caret)}${needsSpace ? " /" : "/"}${input.value.slice(caret)}`;
  const position = caret + (needsSpace ? 2 : 1);
  input.setSelectionRange(position, position);
  autoSize();
  updateCommandMenu();
});

/**
 * Add picked paths to the composer.
 *
 * Images go through the attachment strip (the model sees them); anything else
 * is a mention, which travels with the message as a path the host reads. Kept
 * separate from the drop handler because the dialog returns paths, not Files.
 */
function addPathsAsAttachments(paths) {
  for (const path of paths) {
    if (!path) continue;
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) {
      api
        .readImage?.(path)
        ?.then((dataUrl) => dataUrl && addAttachment(dataUrl, path.split(/[\\/]/).pop()))
        .catch(() => addMentionPath(path));
      continue;
    }
    addMentionPath(path);
  }
}

function addMentionPath(path) {
  if (!state.mentionFiles.includes(path)) state.mentionFiles.push(path);
  input.focus();
  // The notice says "will be sent", not "added": the path is not uploaded,
  // only appended to the next message as a path list. Wording that implied a
  // file was attached would be the same lie the missing path used to be.
  addNotice("dim", t.mentionAdded(path.split(/[\\/]/).pop() || path));
}

const effortPicker = $("effort-picker");
const effortMenu = $("effort-menu");

function setEffortMenu(open) {
  if (open) renderEffortMenu();
  effortMenu.hidden = !open;
  effortPicker.setAttribute("aria-expanded", String(open));
}

effortPicker.addEventListener("click", (event) => {
  event.stopPropagation();
  setEffortMenu(effortMenu.hidden);
});

// Delegated: the menu is rebuilt whenever the model's level list changes, so
// per-row listeners would go stale after a model switch.
effortMenu.addEventListener("click", (event) => {
  const button = event.target.closest("[data-effort]");
  if (!button) return;
  setEffortMenu(false);
  if (button.dataset.effort === state.effort) return;
  // The label moves when the host answers with a `state`, not here. This host
  // can refuse a level (a stale menu, a model reloaded from disk), and moving
  // the chip first would show a value the next request does not carry — the
  // exact lie this control used to tell. The refusal notice is the feedback.
  api.send({ cmd: "setEffort", effort: button.dataset.effort });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#effort-control")) setEffortMenu(false);
});

modelPicker.addEventListener("click", (event) => {
  event.stopPropagation();
  if (modelMenu.hidden) openModelMenu();
  // The click is on the chip, which already has the focus; moving it around
  // here would scroll the list back to the top for no reason.
  else closeModelMenu();
});

/**
 * Register a local folder as the workspace root and switch to it.
 *
 * `setCwd` only moved the directory the next session would start in; it did
 * not register the folder as a workspace root, so every later `getFile` under
 * it was refused by the host's boundary check. `setWorkspace` does both, which
 * is why the top bar sends it instead.
 */
function setWorkspace(path) {
  const dir = typeof path === "string" ? path.trim() : "";
  if (dir === "") return;
  api.send({ cmd: "setWorkspace", path: dir });
}

/**
 * Ask for a workspace folder, then register it and switch to it.
 *
 * Both the top bar's folder button and the sidebar's workspace entry call
 * this one function, so the two paths cannot drift apart:
 * - a picker that throws is not an answer, so it falls through to typing;
 * - the native dialog returning null means it was cancelled, which is not an
 *   error to punish with a second prompt.
 */
async function chooseWorkspace() {
  let picked = null;
  let pickerFailed = false;
  try {
    picked = await api.pickDirectory();
  } catch {
    // A picker that throws is not an answer; fall through to typing.
    pickerFailed = true;
  }
  if (picked) {
    setWorkspace(picked);
    return;
  }
  // A null from the native dialog means the user closed it, and re-asking with
  // a text box would punish them for cancelling — the click has already done
  // something (a dialog opened and closed).
  if (!pickerFailed) return;
  // Only a picker that never produced an answer lands here. `askText`, not
  // `window.prompt`: Electron does not implement prompt and returns null
  // without drawing anything (see the note on askText), which would put a dead
  // click back in the desktop window.
  const typed = await askText(t.workspacePathPrompt, state.cwd ?? "");
  if (typed) setWorkspace(typed);
}

$("topbar-cwd").addEventListener("click", chooseWorkspace);
$("sidebar-workspace").addEventListener("click", chooseWorkspace);

const clearConversation = () => {
  // The kernel has no "erase this transcript" operation — the log is append
  // only and is the audit record. Starting a fresh conversation is the
  // closest real thing, so the confirmation says that instead of promising a
  // clear that would only redraw the screen.
  void confirmAction(t.clearConfirm, { danger: true }).then((yes) => {
    if (yes) api.send({ cmd: "newSession" });
  });
};
$("new-session").addEventListener("click", () => api.send({ cmd: "newSession" }));
$("refresh-sessions").addEventListener("click", () => {
  api.send({ cmd: "listSessions", includeArchived: state.showArchived });
});

/* ---------- session filter ---------- */

/**
 * Filter the sidebar by state or workspace.
 *
 * The filter runs on the host: a client-side filter only sees the page already
 * loaded, so "only errors" would miss a failure on the 81st session and give
 * the false impression that everything was fine.
 */
function openSessionFilter(event) {
  const trigger = $("session-filter");
  const menu = document.createElement("div");
  menu.className = "session-menu";
  const options = [
    { value: "all", label: t.sessionFilterAll },
    { value: "working", label: t.sessionFilterWorking },
    { value: "needs-input", label: t.sessionFilterNeedsInput },
    { value: "error", label: t.sessionFilterError },
    { value: "cwd", label: t.sessionFilterWorkspace },
  ];
  for (const option of options) {
    const item = document.createElement("button");
    item.className = "session-menu-item";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(state.sessionFilter === option.value));
    item.textContent = option.label;
    item.addEventListener("click", () => {
      state.sessionFilter = option.value;
      closeSessionMenu();
      trigger.setAttribute("aria-expanded", "false");
      setControlTitle(trigger, option.label);
      sendSessionList();
    });
    menu.appendChild(item);
  }
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.right - 160)}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  document.body.appendChild(menu);
  sessionMenu = menu;
  trigger.setAttribute("aria-expanded", "true");
  document.addEventListener(
    "mousedown",
    (dismiss) => {
      if (!menu.contains(dismiss.target) && dismiss.target !== trigger && !trigger.contains(dismiss.target)) {
        closeSessionMenu();
        trigger.setAttribute("aria-expanded", "false");
      }
    },
    { once: true },
  );
}

/** The filter the host should apply, given the current state. */
function sendSessionList(extra = {}) {
  const filter = state.sessionFilter;
  api.send({
    cmd: "listSessions",
    includeArchived: state.showArchived,
    ...(filter === "all" ? {} : filter === "cwd" ? { cwd: state.cwd } : { status: filter }),
    ...extra,
  });
}

$("session-filter").addEventListener("click", openSessionFilter);
$("session-filter").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openSessionFilter(event);
});

$("toggle-archived").addEventListener("click", () => {
  state.showArchived = !state.showArchived;
  $("toggle-archived").classList.toggle("active", state.showArchived);
  setControlTitle($("toggle-archived"), state.showArchived ? t.hideArchived : t.showArchived);
  sendSessionList();
});

let sessionSearchTimer = null;
$("session-search").addEventListener("input", (event) => {
  state.sessionQuery = event.target.value;
  if (sessionSearchTimer) clearTimeout(sessionSearchTimer);
  const query = state.sessionQuery.trim();
  if (!query) {
    state.sessionMatches = null;
    renderSessions(state.sessions);
    return;
  }
  sessionSearchTimer = setTimeout(() => {
    api.send({ cmd: "searchSessions", query, includeArchived: state.showArchived });
  }, 180);
});

/**
 * The width at which the sidebar stops sharing the row and becomes a drawer
 * that covers the conversation. It has to be one number, read by both the
 * stylesheet (`@media (max-width: 900px)`) and this file: they used to
 * disagree — CSS switched at 900, the auto-collapse below at 860 — so
 * between the two, and at exactly the Electron window's `minWidth` of 900,
 * the drawer opened *over* the transcript and left nothing else visible.
 *
 * The drawer is an overlay, so it must start closed. Below this width the
 * conversation is the only thing on screen until the user asks for the rail.
 */
const DRAWER_BREAKPOINT = 900;

function isDrawerWidth() {
  return window.innerWidth <= DRAWER_BREAKPOINT;
}

/** Collapse or expand the conversation sidebar; remembered across restarts. */
function toggleSidebar() {
  const collapsed = document.querySelector(".shell").classList.toggle("collapsed");
  localStorage.setItem("prometheus.sidebarCollapsed", collapsed ? "1" : "0");
}
if (localStorage.getItem("prometheus.sidebarCollapsed") === "1") {
  document.querySelector(".shell").classList.add("collapsed");
}
// A remembered "open" is a preference for the shared row, where an open rail
// costs width. In the drawer it costs the whole window, so the drawer always
// starts closed regardless of what was remembered. Resizing across the
// breakpoint applies the same rule in both directions: entering the drawer
// folds it, leaving restores the user's remembered preference.
const sidebarPreference = () => localStorage.getItem("prometheus.sidebarCollapsed") === "1";
function applyDrawerRule() {
  const shell = document.querySelector(".shell");
  if (isDrawerWidth()) shell.classList.add("collapsed");
  else shell.classList.toggle("collapsed", sidebarPreference());
}
if (isDrawerWidth()) document.querySelector(".shell").classList.add("collapsed");
window.addEventListener("resize", applyDrawerRule);

$("topbar-sidebar-toggle").addEventListener("click", toggleSidebar);

/* ---------- sidebar width ---------- */

/**
 * The sidebar is resizable by dragging its right edge, and by arrow keys when
 * the handle is focused.
 *
 * The width is stored unscaled, so it means the same thing when the UI scale
 * changes: a 300 px column stays 300 px of layout at scale 1 and grows with
 * everything else. The clamp is deliberately generous — below 200 px the
 * session titles are unreadable, above 520 px the conversation has nothing
 * left to grow into on a laptop screen — but it is a clamp, not a fixed set;
 * the user's number is what is remembered.
 */
const SIDEBAR_DEFAULT = 264;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 520;
/** Width the drag started from, so mousemove maps to the pointer's absolute
 *  position rather than accumulating per-event deltas. */
let sidebarDrag = null;

/**
 * Clamp the column so it can never crowd out the conversation.
 *
 * A wide sidebar is a preference; a sidebar that leaves no room for the
 * transcript is a broken window. On a narrow window the ceiling drops with it,
 * and below roughly 760 px the sidebar becomes a drawer anyway (the ≤900 px
 * media query), so the clamp is mostly about the windowed case.
 */
function clampSidebarWidth(width) {
  const requested = Number.isFinite(width) ? width : SIDEBAR_DEFAULT;
  const ceiling = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - 420));
  return Math.round(Math.min(ceiling, Math.max(SIDEBAR_MIN, requested)));
}

function applySidebarWidth(width, options = {}) {
  const clamped = clampSidebarWidth(width);
  const scale = Number(localStorage.getItem("prometheus.uiScale")) || 1;
  document.documentElement.style.setProperty("--sidebar-user-width", `${Math.round(clamped)}px`);
  document.documentElement.style.setProperty("--sidebar-width", `${Math.round(clamped * scale)}px`);
  // A drag in progress writes its own variable; a stale value from a drag that
  // ended in another window would otherwise win over this one.
  document.querySelector(".sidebar")?.style.removeProperty("--sidebar-drag-width");
  if (options.persist) localStorage.setItem("prometheus.sidebarWidth", String(Math.round(clamped)));
  return clamped;
}

/** While dragging, bypass the token and write the width directly. */
function setSidebarDragWidth(px) {
  document.querySelector(".sidebar")?.style.setProperty("--sidebar-drag-width", `${Math.round(px)}px`);
}

function beginSidebarDrag(event) {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;
  event.preventDefault();
  sidebarDrag = {
    startX: event.clientX,
    startWidth: sidebar.getBoundingClientRect().width,
    resizer: $("sidebar-resizer"),
  };
  sidebarDrag.resizer.classList.add("resizing");
  document.body.classList.add("resizing-sidebar");
  window.addEventListener("pointermove", onSidebarDrag);
  window.addEventListener("pointerup", endSidebarDrag, { once: true });
  // Pointer capture keeps the events coming even when the cursor leaves the
  // 6 px strip, which it does immediately at any normal drag speed.
  sidebarDrag.resizer.setPointerCapture?.(event.pointerId);
}

function onSidebarDrag(event) {
  if (!sidebarDrag) return;
  setSidebarDragWidth(clampSidebarWidth(sidebarDrag.startWidth + (event.clientX - sidebarDrag.startX)));
}

function endSidebarDrag() {
  if (!sidebarDrag) return;
  window.removeEventListener("pointermove", onSidebarDrag);
  const sidebar = document.querySelector(".sidebar");
  const width = sidebar?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT;
  sidebar?.style.removeProperty("--sidebar-drag-width");
  sidebarDrag.resizer.classList.remove("resizing");
  document.body.classList.remove("resizing-sidebar");
  sidebarDrag = null;
  // One write at the end: the whole drag is one localStorage update rather
  // than one per mousemove.
  applySidebarWidth(width, { persist: true });
}

{
  const resizer = $("sidebar-resizer");
  resizer?.addEventListener("pointerdown", beginSidebarDrag);
  // The UI scale lives in settings.js; re-apply the unscaled width when it
  // changes so a resized column keeps its proportion at every zoom level.
  window.addEventListener("prometheus:ui-scale", () => {
    applySidebarWidth(Number(localStorage.getItem("prometheus.sidebarWidth")) || SIDEBAR_DEFAULT);
  });
  // A window narrowing past the clamp leaves the column wider than it should
  // be until the next change; re-clamping on resize keeps it inside.
  window.addEventListener("resize", () => {
    const stored = Number(localStorage.getItem("prometheus.sidebarWidth"));
    if (stored) applySidebarWidth(stored);
  });
  // Double-click restores the default, the same escape hatch a split view has.
  resizer?.addEventListener("dblclick", () => {
    const width = applySidebarWidth(SIDEBAR_DEFAULT, { persist: true });
    resizer.setAttribute("aria-valuenow", String(Math.round(width)));
  });
  resizer?.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 32 : 8;
    const stored = Number(localStorage.getItem("prometheus.sidebarWidth")) || SIDEBAR_DEFAULT;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const width = applySidebarWidth(stored + (event.key === "ArrowRight" ? step : -step), { persist: true });
      // The separator role is what makes the new width audible to a screen
      // reader; without it the handle is a focus stop that does nothing.
      resizer.setAttribute("aria-valuenow", String(Math.round(width)));
    } else if (event.key === "Home") {
      event.preventDefault();
      const width = applySidebarWidth(SIDEBAR_DEFAULT, { persist: true });
      resizer.setAttribute("aria-valuenow", String(Math.round(width)));
    }
  });
}

/* ---------- inspector (right pane) width ---------- */

/**
 * The inspector is resizable by dragging its left edge, the mirror of the
 * sidebar handle. Its width is remembered unscaled, like the sidebar's, so
 * it keeps its meaning when the UI scale changes.
 *
 * The bounds are wider than the old fixed 420 px: the panel holds a serial
 * monitor and a hex view, which want room, while the conversation below
 * ~3000 px of inspector would have nothing left. The clamp drops the ceiling
 * on a narrow window so a drag can never crowd the transcript out.
 */
const WORKBENCH_DEFAULT = 420;
const WORKBENCH_MIN = 320;
const WORKBENCH_MAX = 900;
let workbenchDrag = null;

function clampWorkbenchWidth(width) {
  const requested = Number.isFinite(width) ? width : WORKBENCH_DEFAULT;
  const ceiling = Math.max(WORKBENCH_MIN, Math.min(WORKBENCH_MAX, window.innerWidth - 520));
  return Math.round(Math.min(ceiling, Math.max(WORKBENCH_MIN, requested)));
}

function applyWorkbenchWidth(width, options = {}) {
  const clamped = clampWorkbenchWidth(width);
  document.documentElement.style.setProperty("--workbench-width", `${Math.round(clamped)}px`);
  if (options.persist) localStorage.setItem("prometheus.workbenchWidth", String(Math.round(clamped)));
  return clamped;
}

function beginWorkbenchDrag(event) {
  const workbench = $("workbench");
  if (!workbench) return;
  event.preventDefault();
  workbenchDrag = {
    startX: event.clientX,
    startWidth: workbench.getBoundingClientRect().width,
    resizer: $("workbench-resizer"),
  };
  workbenchDrag.resizer.classList.add("resizing");
  document.body.classList.add("resizing-workbench");
  window.addEventListener("pointermove", onWorkbenchDrag);
  window.addEventListener("pointerup", endWorkbenchDrag, { once: true });
  workbenchDrag.resizer.setPointerCapture?.(event.pointerId);
}

function onWorkbenchDrag(event) {
  if (!workbenchDrag) return;
  // Dragging the pane's left edge leftwards makes it wider: the delta is
  // inverted against the sidebar's handle, which sits on the right edge.
  const width = workbenchDrag.startWidth - (event.clientX - workbenchDrag.startX);
  applyWorkbenchWidth(width);
}

function endWorkbenchDrag() {
  if (!workbenchDrag) return;
  window.removeEventListener("pointermove", onWorkbenchDrag);
  const workbench = $("workbench");
  const width = workbench?.getBoundingClientRect().width ?? WORKBENCH_DEFAULT;
  workbenchDrag.resizer.classList.remove("resizing");
  document.body.classList.remove("resizing-workbench");
  workbenchDrag = null;
  applyWorkbenchWidth(width, { persist: true });
}

{
  const stored = Number(localStorage.getItem("prometheus.workbenchWidth"));
  if (stored) applyWorkbenchWidth(stored);
  const resizer = $("workbench-resizer");
  resizer?.addEventListener("pointerdown", beginWorkbenchDrag);
  resizer?.addEventListener("dblclick", () => {
    applyWorkbenchWidth(WORKBENCH_DEFAULT, { persist: true });
  });
  resizer?.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 32 : 8;
    const current = Number(localStorage.getItem("prometheus.workbenchWidth")) || WORKBENCH_DEFAULT;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyWorkbenchWidth(current + step, { persist: true });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyWorkbenchWidth(current - step, { persist: true });
    } else if (event.key === "Home") {
      event.preventDefault();
      applyWorkbenchWidth(WORKBENCH_DEFAULT, { persist: true });
    }
  });
  window.addEventListener("resize", () => {
    const width = Number(localStorage.getItem("prometheus.workbenchWidth"));
    if (width) applyWorkbenchWidth(width);
  });
}

/* ---------- top bar: workspace, changes, terminal ---------- */

function renderTopbarLocation() {
  const cwd = state.cwd ?? "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const name = parts.length > 0 ? parts[parts.length - 1] : "";
  $("topbar-cwd-name").textContent = name || t.appName;
  $("topbar-cwd").title = cwd || t.appName;
  renderStatusTab(name);
  // The sidebar's folder button is an icon: the current folder is a row in the
  // list below it (the active workspace), so repeating the name here would
  // restore the second "workspace" concept the two-level list removed. The
  // button still needs a name of its own for a screen reader, and it has to
  // say what the click does — the folder in the list says where you are.
  // `setControlTitle` would skip this one: the button contains the folder
  // glyph and no text, so it is icon-only and does get named — the path is
  // the reason the name is built here rather than read off the dictionary.
  setControlTitle($("sidebar-workspace"), cwd ? `${t.changeFolderTitle}: ${cwd}` : t.workspaceChoose);
  $("sidebar-workspace").classList.toggle("empty", name === "");
}

/**
 * The tab along the composer's top edge: where this turn happens, and how
 * much of the window it has already used.
 *
 * The branch segment is a latent slot. No host in this build reports a git
 * status (`state.git` is always null and `desktop/MATRIX.md` records git as
 * hidden), so the segment stays hidden — but the predicate is the same one
 * the top bar used, so a host that starts sending `git_status` fills it in
 * without another edit here. It is not faked, and nothing is printed in its
 * place (R3).
 *
 * The context figure and the cwd are always rendered: the tab is the only
 * entry to the usage popover, and hiding it before the first measurement
 * would take that entry away exactly when a new session most wants it.
 */
function renderStatusTab(folderName) {
  const branch = state.git?.available ? state.git.branch : "";
  const branchNode = $("status-tab-branch");
  if (branchNode) {
    branchNode.hidden = !branch;
    branchNode.textContent = branch ?? "";
  }
  const cwdNode = $("status-tab-cwd");
  if (cwdNode) cwdNode.textContent = folderName || t.appName;
}

function renderChangesBadge() {
  const count = state.changes.files.length;
  const badge = $("changes-badge");
  badge.hidden = count === 0;
  badge.textContent = String(count);
  // A change landing mid-turn is worth a glance without opening the pane.
  badge.classList.toggle("live", state.busy && count > 0);
  setControlTitle($("changes-button"), count > 0 ? `${t.paneDiff} (${count})` : t.paneDiff);
}

$("changes-button").addEventListener("click", () => {
  if (!workbench.hidden && state.pane === "diff") closeWorkbench();
  else openWorkbench("diff");
});
$("terminal-button").addEventListener("click", () => {
  if (!workbench.hidden && state.pane === "terminal") closeWorkbench();
  else openWorkbench("terminal");
});


/**
 * Reaching the Artifact tab by hand — a click or the arrow keys — always lands
 * on the list.
 *
 * The pane has two roots: the list and one artifact's preview. A preview
 * leaves the list hidden, so without this the only way back to it would be
 * closing and reopening the pane. Reaching the tab is a request to browse what
 * was produced, not to revisit the file that happened to be open last.
 */
function openWorkbenchPane(pane) {
  if (pane === "artifact") openArtifactPane();
  else openWorkbench(pane);
}

workbenchTabs.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => openWorkbenchPane(button.dataset.pane));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // Only tabs on screen: File and Artifact start `hidden` and are revealed
    // by the action that opens them. Walking onto a hidden tab used to call
    // `focus()` on a `display: none` button and then reveal it, so the
    // selection moved to a pane the focus never followed — the strip showed
    // File selected while the keyboard was still on Serial. With one visible
    // tab the key does nothing.
    const tabs = [...workbenchTabs.querySelectorAll("button")].filter((tab) => !tab.hidden);
    if (tabs.length < 2) return;
    const index = Math.max(0, tabs.indexOf(button));
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    next.focus();
    openWorkbenchPane(next.dataset.pane);
  });
});

$("close-workbench").addEventListener("click", closeWorkbench);

$("diff-scope").querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => {
    state.diffScope = button.dataset.scope;
    $("diff-scope").querySelectorAll("button").forEach((node) => {
      node.classList.toggle("active", node === button);
    });
    state.selectedChange = null;
    renderDiff();
  });
});

/* ---------- window controls ---------- */

// Windows and Linux draw their caption buttons in the renderer so they match
// the top bar; macOS keeps its native traffic lights.
const windowControls = $("window-controls");
if (api.platform !== "darwin") {
  windowControls.hidden = false;
  document.documentElement.classList.add("custom-caption");
  windowControls.querySelectorAll("[data-window]").forEach((button) => {
    button.addEventListener("click", () => api.windowControl(button.dataset.window));
  });
  let windowMaximized = false;
  applyWindowState = ({ maximized } = {}) => {
    if (typeof maximized === "boolean") windowMaximized = maximized;
    document.documentElement.classList.toggle("window-maximized", windowMaximized);
    // The caption buttons are icon-only, and this string used to be hardcoded
    // English — the one place in the window bar that ignored the locale.
    setControlTitle($("window-maximize"), windowMaximized ? t.restore : t.maximize);
  };
  api.onWindowState?.(applyWindowState);
  void api.windowState?.().then(applyWindowState);
}

/* ---------- settings ---------- */

// The Settings page lives in its own module; this file owns the modal shell,
// the shared state, and the dialog helpers it needs.
const settingsDialog = $("settings-dialog");
const shortcutsDialog = $("shortcuts-dialog");
const modalScrim = $("modal-scrim");

function openModal(dialog) {
  modalScrim.hidden = false;
  dialog.hidden = false;
  dialog.showModal?.();
}

function closeModal(dialog) {
  dialog.hidden = true;
  dialog.close?.();
  if (settingsDialog.hidden && shortcutsDialog.hidden) modalScrim.hidden = true;
}

const settings = createSettings({
  state,
  $,
  api,
  formatTokens,
  setTheme,
  setDensity,
  setMode,
  applyLocale,
  openModal,
  closeModal,
  applyCodeFont,
  getT: () => t,
  confirmAction,
});

// Kept as free functions so the rest of this file can call them by name.
const openSettings = (tab) => settings.open(tab);
const openSetup = () => settings.openSetup();
const refreshVersion = () => settings.refreshVersion();
applySettingsLocale = () => settings.applyLocaleChange();
$("settings-button").addEventListener("click", () => openSettings());

/* ---------- shortcuts sheet ---------- */

/**
 * The keyboard sheet.
 *
 * Every row here is a key the renderer actually acts on; a row without a
 * branch behind it is a lie, and R3 covers the sheet as much as it covers a
 * tool result.
 *
 * 2026-10-26 removed three rows. Ctrl+Shift+D and Ctrl+` did nothing at all —
 * the first was an empty `preventDefault()`, the second called
 * `openWorkbench("terminal")`, which returns immediately because `terminal` is
 * not in `SUPPORTED_PANES`. Their branches went with them, per the user's
 * "delete the bindings too". Ctrl+Shift+E had a branch that swallowed the key
 * so it would not fall through to plain Ctrl+E; that branch is gone as well,
 * so the two keys now do the same thing (cycle thinking effort) — a deliberate
 * consequence, stated in the handler below.
 *
 * The three mode rows were also wrong: they named modes this build does not
 * have (Ask / Auto / Plan), while `MODES` is diagnose, read-only,
 * workspace-write and danger-full-access. Ctrl+4 was bound but unlisted, so
 * the sheet now carries all four real modes.
 */
function openShortcuts() {
  const mod = api.platform === "darwin" ? "⌘" : "Ctrl";
  const rows = [
    [t.shortcutNewChat, `${mod}+N`],
    [t.shortcutPalette, `${mod}+K`],
    [t.shortcutFind, `${mod}+F`],
    [t.shortcutSettings, `${mod}+,`],
    [t.shortcutShortcuts, `${mod}+/`],
    [t.shortcutToggleSidebar, `${mod}+B`],
    [t.shortcutStop, "Esc"],
    [t.shortcutClosePane, `${mod}+\\`],
    [t.modeDiagnose, `${mod}+1`],
    [t.modeReadOnly, `${mod}+2`],
    [t.modeWorkspaceWrite, `${mod}+3`],
    [t.modeDangerFullAccess, `${mod}+4`],
    [t.shortcutEffort, `${mod}+E`],
  ];
  const grid = $("shortcut-grid");
  grid.innerHTML = "";
  for (const [label, keys] of rows) {
    const labelNode = document.createElement("div");
    labelNode.className = "label";
    labelNode.textContent = label;
    const keyNode = document.createElement("kbd");
    keyNode.textContent = keys;
    grid.append(labelNode, keyNode);
  }
  openModal(shortcutsDialog);
}

$("shortcuts-close").addEventListener("click", () => closeModal(shortcutsDialog));

async function exportSessionFile(markdown, filename) {
  if (!api.saveFile) return;
  const result = await api.saveFile(filename, markdown);
  if (result?.saved) addNotice("dim", `${t.exportSaved} ${result.path}`);
}

/**
 * Say once that a newer version exists.
 *
 * The status can arrive more than once for the same version (a check at launch,
 * then another when the About page opens), and a line per arrival would turn
 * one fact into a pile of notices. Keyed by version, not by state: re-entering
 * `available` for a version already announced is the same news.
 */
function announceUpdate(status) {
  const version = typeof status.version === "string" ? status.version : "";
  if (version === "" || state.updateAnnounced === version) return;
  state.updateAnnounced = version;
  addNotice("dim", t.updateAvailableBanner(version));
}

/**
 * Background update check: only surfaces when a newer version exists.
 *
 * The check itself lives in the main process (`desktop/updater.js`) and its
 * result arrives as an `update_status` event. Nothing here downloads: a
 * version that is available is announced, and the download waits for a click
 * on the About page. Checking at launch is a preference; downloading is not.
 */
async function checkUpdateQuietly() {
  if (typeof api.updateCheck !== "function") return;
  if (localStorage.getItem("prometheus.updateCheck") === "0") return;
  // The answer is disregarded on purpose — `update_status` carries it. Reading
  // it here too would give the same event two handlers with two chances to
  // announce the same version.
  await api.updateCheck();
}

/* ---------- top bar overflow menu ---------- */

const topbarMenu = $("topbar-menu");

/** Reflect the current theme and language on the overflow menu controls. */
function syncMenuControls() {
  if (!document.getElementById("menu-theme")) return;
  document.querySelectorAll("#menu-theme [data-theme-choice]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeChoice === state.theme);
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === state.theme));
  });
  document.querySelectorAll("#menu-locale [data-locale]").forEach((button) => {
    button.classList.toggle("active", button.dataset.locale === state.locale);
  });
}

$("menu-theme").addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-choice]");
  if (!button) return;
  setTheme(button.dataset.themeChoice);
  syncMenuControls();
});

$("menu-locale").addEventListener("click", (event) => {
  const button = event.target.closest("[data-locale]");
  if (!button) return;
  if (button.dataset.locale !== state.locale) applyLocale(button.dataset.locale, { announce: true });
  syncMenuControls();
});


function setTopbarMenu(open) {
  topbarMenu.hidden = !open;
  $("more-button").setAttribute("aria-expanded", open ? "true" : "false");
}

$("more-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const open = topbarMenu.hidden;
  setTopbarMenu(open);
  if (open) syncMenuControls();
});

topbarMenu.addEventListener("click", (event) => {
  if (event.target.closest(".menu-setting")) return;
  const row = event.target.closest(".menu-row");
  if (!row) return;
  setTopbarMenu(false);
  if (row.id === "menu-export") api.send({ cmd: "exportSession" });
  else if (row.id === "menu-artifacts") openArtifactPane({ opener: $("more-button") });
  else if (row.id === "menu-shortcuts") openShortcuts();
  else if (row.id === "menu-open-serial") openWorkbench("serial", { opener: $("more-button") });
  else if (row.id === "menu-clear") clearConversation();
});

document.addEventListener("click", (event) => {
  if (!topbarMenu.hidden && !event.target.closest("#topbar-menu") && !event.target.closest("#more-button")) {
    setTopbarMenu(false);
  }
});

// Legacy path: in a shell without the top layer (no `showModal`), a backdrop
// click lands on the scrim itself. Kept for that case; in Electron the dialogs
// retarget it, so their own listeners below are the ones that fire.
modalScrim.addEventListener("click", () => {
  closeModal(shortcutsDialog);
  // Settings can own an unsaved draft, so it decides (OPT-39). Both routes go
  // through the same guard.
  void settings.requestClose();
});

// While a modal `<dialog>` is open it retargets backdrop clicks to itself, so
// the "clicked the scrim" gesture arrives here, with the dialog as the target.
// `event.target === settingsDialog` is therefore exactly "outside the card".
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) void settings.requestClose();
});

// The shortcut sheet has nothing to lose, so it closes straight away — same
// backdrop rule, no guard. Without this listener a click beside the sheet did
// nothing: the scrim never receives it while a modal dialog is up.
shortcutsDialog.addEventListener("click", (event) => {
  if (event.target === shortcutsDialog) closeModal(shortcutsDialog);
});


// A native close request (Escape handled by the browser, not by the chain
// above) takes the dialog out of the top layer without touching `hidden`. The
// two then disagree: `hidden === false` while nothing is on screen and the
// scrim is still up, and the next open would call `showModal()` on a dialog the
// DOM already considers closed. Refusing the request keeps the shell's own
// state the only source of truth; every intended close goes through
// `closeModal` / `requestClose`.
settingsDialog.addEventListener("cancel", (event) => event.preventDefault());

transcript.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (link && /^https?:/.test(link.href)) {
    event.preventDefault();
    api.openExternal(link.href);
  }
});

// Startup runs at the bottom of the module: everything above is a declaration.
// A thrown error here would leave the first paint unstyled, so the boot steps
// are individually guarded and reported rather than silently skipped.
function bootStep(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[boot] ${name}:`, err);
  }
}

api.onEvent(handleEvent);
// `platform` comes from the preload (`process.platform`), so this is always a
// real platform string — the `platform-*` classes key the caption-button and
// shortcut styling.
document.documentElement.classList.add(`platform-${api.platform}`);
bootStep("locale", () => applyLocale(state.locale));
bootStep("mode", () => setMode(state.mode));
// Preferences are restored from localStorage so the first paint is already
// correct; the host's copy is authoritative once it answers getSettings.
// No stored choice means "follow the system". The choice itself is kept, not
// its resolution: `setTheme` resolves at paint time and re-resolves when the OS
// flips, so writing light/dark here would freeze the preference on first launch.
if (!localStorage.getItem("prometheus.theme")) state.theme = "system";
bootStep("theme", () => setTheme(state.theme, { remember: false }));
bootStep("density", () => setDensity(state.density));
bootStep("width", () => {
  document.documentElement.dataset.width = localStorage.getItem("prometheus.width") || "standard";
});
bootStep("view", () => {
  // Only `verbose` still means something (tool output opens as it arrives).
  // A stored `thinking` from an older build described thinking visibility,
  // which each block now owns; it would be a value no rule reads.
  //
  // `state.transcriptView` is set here as well as in Settings: it used to be
  // written only when the dropdown changed, so a saved `verbose` did nothing
  // on launch until the user visited Settings and re-picked it. The host
  // never sends this preference (it is renderer-local), so this is the only
  // place the saved value can reach the code that reads it.
  state.transcriptView = normalizeTranscriptView(localStorage.getItem("prometheus.view"));
  document.documentElement.dataset.view = state.transcriptView;
  // Write the normalised value back. Leaving a dead `thinking` on disk would
  // make the stored preference disagree with what the app does — the same
  // trap the `lastSession` sweep avoids — and a later change might read it
  // again and "restore" a setting that no longer exists.
  if (localStorage.getItem("prometheus.view") !== state.transcriptView) {
    localStorage.setItem("prometheus.view", state.transcriptView);
  }
});
bootStep("motion", () => {
  document.documentElement.dataset.motion = localStorage.getItem("prometheus.motion") || "full";
});
bootStep("uiScale", () => {
  document.documentElement.style.setProperty("--ui-scale", localStorage.getItem("prometheus.uiScale") || "1");
});
bootStep("sidebarWidth", () => {
  applySidebarWidth(Number(localStorage.getItem("prometheus.sidebarWidth")) || SIDEBAR_DEFAULT);
});
bootStep("fontScale", () => {
  document.documentElement.style.setProperty("--font-scale", localStorage.getItem("prometheus.fontScale") || "1");
});
bootStep("codeFont", () => {
  const saved = localStorage.getItem("prometheus.codeFont");
  if (saved) applyCodeFont(saved);
});
// One-time sweep of keys whose features are gone. Deleting the reader and the
// writer is not enough: a profile that ran an older build still has the value
// on disk, and a stale `lastSession` pointing at a conversation that has since
// been deleted is exactly the kind of leftover that invites a future change to
// "just read it again". Cheap, idempotent, and it runs before anything reads.
for (const dead of ["prometheus.lastSession", "prometheus.restartSession"]) {
  localStorage.removeItem(dead);
}

void refreshVersion();
// An update that exists should be visible without opening About. The check is
// the same one the About page runs and does nothing when no feed is
// configured, so a build without an update feed pays nothing.
void checkUpdateQuietly();
api.send({ cmd: "getSetupChecklist" });
api.send({ cmd: "listSessions" });
api.send({ cmd: "listCommands" });
// The inspector is opened by the action that needs it, not on launch: a
// remembered pane used to eat half the window before the first message.
if (state.workbenchOpen) {
  state.workbenchOpen = false;
  localStorage.setItem("prometheus.workbench", "0");
}
api.send({ cmd: "setLocale", locale: state.locale });
input.focus();
