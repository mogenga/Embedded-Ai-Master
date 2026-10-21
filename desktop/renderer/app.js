/** Prometheus desktop renderer. */

import { detectLocale, getDict } from "./i18n.js";
import { escapeHtml, renderMarkdown, IncrementalRenderer } from "./markdown.js";
import { createSettings } from "./settings.js";
import { icon, setIcon } from "./icons.js";

/** Saved preferences are restored here; the host gets them on init. */
const savedLocale = localStorage.getItem("prometheus.locale");
const savedTheme = localStorage.getItem("prometheus.theme");
const savedDensity = localStorage.getItem("prometheus.density");
const savedWorkbench = localStorage.getItem("prometheus.workbench");
const savedPane = localStorage.getItem("prometheus.pane");

const api = window.prometheus;

const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const emptyState = $("empty-state");
const input = $("input");
const sendButton = $("send-button");
const stopButton = $("stop-button");
const statusDot = $("status-dot");
const statusText = $("status-text");
const modeControl = $("mode-control");
const effortControl = $("effort-control");
const modelPicker = $("model-picker");
const modelMenu = $("model-menu");
const modelLabel = $("model-label");
const contextLabel = $("context-label");
const pendingPermission = $("pending-permission");
const pendingQuestion = $("pending-question");
const sessionList = $("session-list");

const transcriptScroll = $("transcript-scroll");
const workbench = $("workbench");
const workbenchTabs = $("workbench-tabs");
const workbenchMeta = $("workbench-meta");
const diffFilelist = $("diff-filelist");
const diffRoot = $("diff-root");
const fileRoot = $("file-root");
const fileTree = $("pane-tree");
const changesList = $("changes-list");
const changesSummary = $("changes-summary");
const checkpointList = $("checkpoint-list");
const terminalRoot = $("terminal-root");
const terminalOutput = $("terminal-output");
const terminalInput = $("terminal-input");
const terminalPrompt = $("terminal-prompt");

const state = {
  busy: false,
  /** The next-turn suggestion currently offered; Tab accepts it. */
  suggestion: "",
  goalRun: null,
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
  checkpoints: [],
  /** True when the last rewind can be put back. */
  checkpointRedo: false,
  selectedChange: null,
  selectedFile: null,
  /** Pending "the preview never arrived" timeout; cleared on the reply. */
  fileLoadTimer: null,
  tree: [],
  cwd: "",
  context: { tokens: 0, percent: 0 },
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
  // Only board and serial have a kernel backend. The other panes' markup is
  // still in the document (their tabs are not), so an old saved pane must not
  // be restored into a view nothing can fill.
  pane: ["board"].includes(savedPane) ? savedPane : "board",
  git: null,
  worktree: null,
  worktreeDiffText: "",
  artifacts: [],
  selectedArtifact: null,
  queuedCount: 0,
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
  /** Sub-agent records for the Tasks pane. */
  subagents: [],
  /** Absolute root the Files pane last asked for; "" means no workspace yet. */
  treePath: "",
  pr: null,
  commands: [],
  diffScope: "session",
  currentSubagent: null,
  /** Selection and project kind from the last state event; cheap, always current. */
  board: { selection: {}, projectKind: "unknown" },
  /** The last assembled board state (project, then inventory). */
  boardState: null,
  /** The probe's own report from the last `device_status` event. */
  device: null,
  deviceTool: "",
  /** Whether the target table has been loaded, and the status that follows. */
  boardTargetStatus: { kind: "unloaded", candidates: [], total: 0 },
  boardSuggested: [],
  /** The serial monitor is renderer-local except for the stream itself. */
  serial: {
    open: false,
    port: null,
    baud: null,
    /** Pausing stops DOM updates; data keeps arriving in the host's ring. */
    paused: false,
    pausedBacklog: 0,
    filter: "all",
    follow: true,
    lines: [],
    /** Lines the host could not keep up with, since the last clear. */
    dropped: 0,
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

function applyLocale(locale, { announce = false } = {}) {
  state.locale = locale;
  t = getDict(locale);
  localStorage.setItem("prometheus.locale", locale);
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const value = t[node.dataset.i18n];
    if (typeof value === "string") node.textContent = value;
  });
  document.querySelectorAll("[data-prompt-key]").forEach((node) => {
    node.dataset.prompt = t[node.dataset.promptKey] || "";
  });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => {
    const value = t[node.dataset.i18nTitle];
    if (typeof value === "string") node.title = value;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    const value = t[node.dataset.i18nPlaceholder];
    if (typeof value === "string") node.placeholder = value;
  });
  input.placeholder = t.placeholder;
  terminalInput.placeholder = terminalInput.disabled ? t.terminalExited : t.terminalPlaceholder;
  $("terminal-restart").textContent = t.terminalRestart;
  const terminalTab = workbenchTabs.querySelector('[data-pane="terminal"]');
  if (terminalTab) terminalTab.textContent = t.paneTerminal;
  sendButton.title = t.sendTitle;
  stopButton.title = t.stopTitle;
  // The sidebar workspace entry is written by renderTopbarLocation, and its
  // "no folder" text and tooltip are language-dependent, so redraw it here
  // after `t` has been swapped. This runs before the title assignment below
  // so the top bar keeps the tooltip it had.
  renderTopbarLocation();
  $("topbar-cwd").title = t.changeFolderTitle;
  $("refresh-sessions").title = t.refresh;
  const search = $("session-search");
  search.placeholder = t.searchSessions;
  search.title = t.searchSessions;
  $("find-input").placeholder = t.findPlaceholder;
  // The update button lives in the About page and is built on demand, so there
  // is nothing to relabel here; touching a missing node used to abort the rest
  // of this function with a TypeError.
  const updateButton = $("check-update");
  if (updateButton) updateButton.textContent = t.checkUpdate;
  modelPicker.title = t.refreshModels;
  // applyLocale also runs during startup, before the voice state is declared.
  $("voice-button").title = $("voice-button").classList.contains("recording") ? t.voiceStop : t.voiceStart;
  if (state.sessions.length > 0) renderSessions(state.sessions);
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
  // The board and serial panes assemble their text from `t` when they render
  // and carry no `data-i18n` on it, so the sweep above cannot reach them.
  if (!workbench.hidden && (state.pane === "board" || state.pane === "serial")) {
    if (state.pane === "board") renderBoard();
    else {
      fillSerialControls();
      renderSerialStatus();
    }
  }
  renderBoardChip();
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

function hideEmptyState() {
  if (emptyState && !emptyState.hidden) emptyState.hidden = true;
}

function addNode(html) {
  hideEmptyState();
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
  const queued = state.busy;
  const images = imageCount > 0 ? `<span class="user-images">${t.imageCount(imageCount)}</span>` : "";
  const node = addNode(
    `<div class="turn user${queued ? " queued" : ""}">` +
      `<div class="user-bubble">${escapeHtml(text)}${images}${queued ? `<span class="queued-tag">${escapeHtml(t.queuedTag)}</span>` : ""}</div>` +
      `</div>`,
  );
  node.dataset.queued = queued ? "1" : "";
  return node;
}

/** Offer "rewind to here" on a user turn once the conversation moved past it. */
function attachRewind(node, index) {
  if (!node || !Number.isFinite(index)) return;
  node.dataset.index = String(index);
  if (node.querySelector(".rewind-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "rewind-button";
  button.dataset.i18n = "rewindHere";
  button.textContent = t.rewindHere;
  button.title = t.rewindTitle;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void confirmAction(t.rewindConfirm, { danger: true }).then((yes) => {
      if (!yes) return;
      api.send({ cmd: "rewindTo", index });
    });
  });
  node.appendChild(button);
}

function markQueuedDelivered() {
  const pending = transcript.querySelector('.turn.user.queued');
  if (!pending) return;
  pending.classList.remove("queued");
  pending.dataset.queued = "";
  pending.querySelector(".queued-tag")?.remove();
}

function setQueuedBadge(count) {
  state.queuedCount = count;
  const badge = $("queued-badge");
  if (!badge) return;
  badge.hidden = count <= 0;
  badge.textContent = t.queuedCount(count);
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
      await navigator.clipboard.writeText(code);
      button.textContent = t.copied;
      setTimeout(() => (button.textContent = t.copy), 1200);
    });
  });
}

/** Human labels for tool ids: the transcript should read as actions. */
const TOOL_LABELS = {
  fs: "Files",
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
  if (name === "write_file" || name === "edit_file") return "edit";
  if (name === "search_codebase" || name === "grep") return "search";
  if (name === "glob" || name === "list_files") return "folder";
  if (name === "fs") return "file";
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

function addToolRow(name, summary, annotations) {
  const row = document.createElement("div");
  row.className = "tool-row running";
  row.innerHTML =
    `<span class="tool-glyph">${icon(toolGlyph(name))}</span>` +
    `<span class="tool-name">${escapeHtml(toolLabel(name))}</span>` +
    toolAnnotationBadges(annotations) +
    `<span class="tool-summary">${escapeHtml(summary || "")}</span>` +
    // A chevron, not the word "details": it reads as "there is more here" at
    // a glance and costs no width in a column of many rows. It stays hidden
    // until there is something to open, so a bare `ls` is still one line. The
    // icon points down when closed and rotates a quarter turn when open.
    `<button class="tool-expand" hidden aria-expanded="false" aria-label="${escapeHtml(t.details)}">` +
    `${icon("chevron-down")}</button>`;
  row.dataset.path = summary || "";
  toolGroup().appendChild(row);
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
  // The embedded inventory tools answer a question the panes also answer; the
  // row opens the pane rather than a file.
  const paneForTool = EMBED_TOOL_PANES[name];
  if (paneForTool) {
    row.classList.add("openable");
    row.title = t.boardOpenPane;
    row.addEventListener("click", (event) => {
      if (event.target.closest(".tool-expand")) return;
      openWorkbench(paneForTool);
    });
  }
  state.currentTool = { node: row, name, summary };
  state.lastToolNode = row;
  return row;
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

/** Kernel file tools are one tool with an `op`; the path is still the summary. */
const FILE_TOOLS = new Set(["fs", "read_file", "write_file", "edit_file"]);
/** Rows that lead somewhere: the pane showing the same facts, in full. */
const EMBED_TOOL_PANES = {
  // Serial tools report state the board pane's Device section shows; they do
  // not open a serial console (there is none).
  mcp__probe__serial_read: "board",
  mcp__probe__serial_status: "board",
  mcp__probe__serial_open: "board",
  mcp__probe__device_status: "board",
  mcp__probe__attach: "board",
  mcp__probe__device_list: "board",
};

function lastToolRow() {
  return state.lastToolNode && state.lastToolNode.isConnected ? state.lastToolNode : null;
}

/**
 * A "show in file manager" button for a tool result whose full text was
 * written to disk.
 *
 * It lives inside the `<pre>` that holds the output, so it opens and closes
 * with the details block instead of floating above a collapsed row. The click
 * asks the host to reveal the path: the renderer cannot open a `file://` URL
 * (Electron blocks it, and in a browser it is meaningless), and a host that
 * has no file manager answers with a notice, which is the honest degradation.
 */
function attachArtifactLink(container, artifactPath) {
  // The details arrive after the block is built (and a later `tool_output`
  // reuses it), so an existing button is updated rather than stacked.
  const existing = container.querySelector(".artifact-open");
  if (existing) {
    existing.dataset.path = artifactPath;
    existing.title = `${t.artifactRevealHint} ${artifactPath}`;
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
    // window. Without it (the browser form) the command goes to the host,
    // which answers with a notice naming the path: a notice is honest, while
    // a `file://` anchor would be blocked and look like a broken button.
    if (typeof api.revealArtifact === "function") {
      void api.revealArtifact(target);
      return;
    }
    api.send({ cmd: "revealArtifact", path: target });
  });
  // A leading newline puts the button on its own line at the end of the
  // output; the container is a `<pre>` with pre-wrap, so without it the
  // button would sit on the same line as the last line of text.
  container.append("\n", button);
  return button;
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

function startThinking() {
  if (state.currentThinking) return;
  const node = addNode(
    `<div class="thinking streaming"><span class="thinking-label">${escapeHtml(t.thinking)}</span><span class="thinking-text"></span></div>`,
  );
  // The block is appended, so a model that reasons *between* two paragraphs
  // would have its reasoning land after the prose it came from — and the next
  // paragraph would then be appended below the reasoning, splitting one answer
  // in half. Moving the prose turn under the block keeps the transcript in the
  // order the model produced it: prose, reasoning, more prose.
  const current = state.currentAssistant;
  if (current?.node?.isConnected) node.before(current.node);
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
    // Follow only while the reader is already at the bottom; scrolling up to
    // read earlier reasoning must not be yanked back down.
    const pane = scrollTarget();
    if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 140) pane.scrollTop = pane.scrollHeight;
  });
}

/**
 * Keep the block after the turn: the Normal view hides finished reasoning in
 * CSS, while the Thinking and Verbose views show what the model actually said.
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
  const label = node.querySelector(".thinking-label");
  if (label) label.textContent = text ? t.thoughtBriefly : t.thinking;
  state.currentThinking = null;
  state.currentThinkingText = null;
  state.thinkingBuffer = "";
}

function addNotice(level, text) {
  const cls = level === "warn" ? "warn" : level === "error" ? "error" : level === "dim" ? "dim" : "";
  if (!cls) return;
  addNode(`<div class="notice ${cls}">${escapeHtml(text)}</div>`);
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
  // Only follow the plan if the reader was already at the bottom; otherwise
  // the update would scroll them away from what they were reading.
  if (wasPinned) pane.scrollTop = pane.scrollHeight;
}

/* ---------- state ---------- */

/**
 * Suggest the next thing to ask, after a turn ends.
 *
 * Drawn from the turn that just finished rather than a generic list: "run the
 * tests" is only a good suggestion when the agent just said they pass. Three
 * shapes cover what a follow-up usually is — verify, explain, continue.
 */
function suggestNextTurn() {
  const suggestion = $("composer-suggestion");
  if (!suggestion) return;
  const text = summariseLastAssistant();
  if (!text || localStorage.getItem("prometheus.suggestions") === "0") {
    suggestion.hidden = true;
    return;
  }
  const lower = text.toLowerCase();
  let next = "";
  if (/test/.test(lower) && !/pass(ed|ing)?/.test(lower)) next = t.suggestRunTests;
  else if (/error|fail/.test(lower)) next = t.suggestFixErrors;
  else if (/implemented|added|changed/.test(lower)) next = t.suggestReviewDiff;
  if (!next) {
    suggestion.hidden = true;
    return;
  }
  state.suggestion = next;
  suggestion.querySelector(".composer-suggestion-text").textContent = next;
  suggestion.hidden = false;
}

function clearSuggestion() {
  state.suggestion = "";
  const suggestion = $("composer-suggestion");
  if (suggestion) suggestion.hidden = true;
}

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
  // Enter has always queued a message mid-turn; the button was disabled, so
  // the two ways to send disagreed. The button now queues as well, and says so.
  sendButton.disabled = false;
  sendButton.classList.toggle("queues", busy);
  sendButton.title = busy ? t.queueSend : t.sendLabel;
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
 */
function confirmAction(message, options = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML =
      `<div class="confirm-dialog" role="alertdialog" aria-modal="true">` +
      `<div class="confirm-text">${escapeHtml(message)}</div>` +
      `<div class="confirm-actions">` +
      `<button class="confirm-cancel">${escapeHtml(options.cancel ?? t.cancel)}</button>` +
      `<button class="confirm-ok${options.danger ? " danger" : ""}">${escapeHtml(options.ok ?? t.confirm)}</button>` +
      `</div></div>`;
    document.body.appendChild(overlay);

    const ok = overlay.querySelector(".confirm-ok");
    const cancel = overlay.querySelector(".confirm-cancel");
    const close = (answer) => {
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
  const walker = document.createTreeWalker(transcriptScroll, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(".find-bar, .empty-state, script, style")) return NodeFilter.FILTER_REJECT;
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

function commandsAtCaret() {
  const before = input.value.slice(0, input.selectionStart);
  const match = /(^|\n)\/([a-z0-9][a-z0-9-_]*)?$/i.exec(before);
  return match ? match[2] ?? "" : null;
}

function updateCommandMenu() {
  const query = commandsAtCaret();
  if (query === null || state.commands.length === 0) {
    closeCommandMenu();
    return;
  }
  const matches = state.commands.filter((command) => command.name.startsWith(query.toLowerCase()));
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
    // A built-in runs; a markdown command inserts its name so arguments can be
    // typed after it. Showing which is which before the click is what keeps
    // "Enter" from being a guess.
    const builtin = command.source === "builtin";
    row.innerHTML =
      `<span class="command-name">/${escapeHtml(command.name)}</span>` +
      `<span class="command-hint">${escapeHtml(command.description || command.argumentHint || "")}</span>` +
      (builtin ? `<span class="command-arg">${escapeHtml(command.argumentHint || "")}</span>` : "");
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
  // A built-in with no arguments runs on the spot. Inserting "/clear " and
  // waiting for a second Enter made a one-shot verb feel like a text field.
  if (command.source === "builtin" && !command.argumentHint) {
    input.value = "";
    autoSize();
    api.send({ cmd: "prompt", text: `/${command.name}` });
    return;
  }
  input.value = `/${command.name} `;
  input.setSelectionRange(input.value.length, input.value.length);
  autoSize();
  input.focus();
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

function renderMention(files) {
  if (!mention) return;
  mention.files = files;
  mention.index = 0;
  fileMention.innerHTML = "";
  if (files.length === 0) {
    fileMention.hidden = true;
    return;
  }
  files.forEach((path, index) => {
    const row = document.createElement("button");
    row.className = `mention-row${index === 0 ? " active" : ""}`;
    row.setAttribute("role", "option");
    const cut = path.lastIndexOf("/");
    row.innerHTML =
      `<span class="mention-name">${escapeHtml(path.slice(cut + 1))}</span>` +
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
 * The composer meter is the session's token accounting: how full the context
 * window is, and what the conversation has spent so far. Clicking it opens the
 * breakdown instead of hiding the numbers in a tooltip.
 *
 * `usage` events are per model call, not per session — a tool-using turn writes
 * several. The popover's label says "this session", so a state event's running
 * total replaces the numbers while a live `usage` event adds to them.
 */
function updateMeter(context, usage, { replace = false } = {}) {
  if (context) {
    state.context = { tokens: context.tokens ?? 0, percent: Math.min(100, Math.round(context.percent ?? 0)) };
    contextLabel.textContent = `${state.context.percent}%`;
    // The window is what turns the percentage into "how much is left"; the
    // model picker knows it too, but the kernel's figure wins when it sends one.
    const window = Number(context.window) || 0;
    if (window > 0 && window !== state.contextWindow) {
      state.contextWindow = window;
      renderContextLength();
    }
  }
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
 * The model's window next to its name, e.g. "1M" — the figure the popover
 * explains. Kept to one glance-sized number: the exact window is in the
 * popover, where there is room for it.
 */
function renderContextLength() {
  const node = $("context-length");
  if (!node) return;
  const window = Number(state.contextWindow) || 0;
  if (!window) {
    node.textContent = "";
    return;
  }
  node.textContent = window >= 1_000_000 ? `${Math.round(window / 1_000_000)}M` : formatTokens(window);
}

/** Fill the usage popover from state. Harmless while it is closed. */
function renderUsage() {
  const usage = state.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  $("usage-input-value").textContent = formatTokens(usage.inputTokens);
  $("usage-cached-value").textContent = formatTokens(usage.cachedTokens);
  $("usage-output-value").textContent = formatTokens(usage.outputTokens);
  $("usage-total-value").textContent = formatTokens(usage.inputTokens + usage.outputTokens);

  // The spend line is filled before the breakdown guard: the kernel does not
  // produce a breakdown at all today, and returning first would make the cost
  // permanently invisible. No price means no row — a $0.00 would be a claim.
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

  const info = state.contextBreakdown;
  if (!info) {
    $("usage-context-value").textContent = "—";
    $("usage-stack").innerHTML = "";
    $("usage-breakdown").innerHTML = "";
    return;
  }

  // Headline: used / window (percent) — the three facts the chip reduces to
  // one, spelled out where there is room for all three.
  $("usage-context-value").textContent =
    `${formatTokens(info.used)} / ${formatTokens(info.window)} (${info.percent}%)` +
    // A percentage of an assumed window is a percentage of a guess. Saying so
    // costs one marker and stops the meter from reading as an endpoint fact.
    (info.windowAssumed ? ` ${t.usageWindowAssumed}` : "");
  $("usage-context-value").title = info.windowAssumed
    ? t.usageWindowAssumedHint
    : `${formatTokens(info.window)} ${t.tokens}`;

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
 * `auto` is a sentinel — the host sends nothing and the model uses its own
 * default — and the rest come from the endpoint's `reasoning_efforts`, so the
 * menu shows `max`/`xhigh` for a model that has them and does not offer a
 * level the gateway would refuse.
 */
function effortLevels() {
  return state.effortChoices?.levels ?? [];
}

function setEffort(effort) {
  state.effort = effort;
  $("effort-label").textContent = effort === "auto" ? t.effortAuto : effort;
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
  const levels = effortLevels();
  const list = levels.length > 0 ? levels : ["low", "medium", "high"];
  menu.innerHTML =
    [{ level: "auto", label: t.effortAuto }, ...list.map((level) => ({ level, label: level }))]
      .map((row) => {
        const active = row.level === state.effort;
        const hint = row.level === "auto" && choices.default ? `<span class="effort-hint">${escapeHtml(choices.default)}</span>` : "";
        return (
          `<button role="menuitemradio" data-effort="${escapeHtml(row.level)}" aria-checked="${active}"` +
          ` class="${active ? "active" : ""}">` +
          `<span>${escapeHtml(row.label)}</span>${hint}</button>`
        );
      })
      .join("");
}

/* ---------- model picker ---------- */

function renderModels(models, current, source, error) {
  state.models = models || [];
  state.model = current;
  state.modelsSource = source || "";
  state.modelsError = error || "";
  if (current) {
    modelLabel.textContent = current;
    // applyLocale rewrites every [data-i18n] node from the dictionary, so
    // leaving the attribute on would put "loading models…" back the next time
    // the user switches language — after the real model name had been shown.
    modelLabel.removeAttribute("data-i18n");
    modelPicker.classList.remove("unavailable");
    // The meter is a share of the model's real context, not a placeholder.
    const active = state.models.find((model) => model.id === current);
    if (active && Number.isFinite(active.contextLength)) state.contextWindow = active.contextLength;
    renderContextLength();
  } else {
    // Nothing to show: the label must still leave the loading state, or the
    // chip spins forever on a misconfigured endpoint.
    modelLabel.textContent = t.modelsUnavailable;
    modelPicker.classList.add("unavailable");
  }
  modelPicker.title = state.modelsError || t.refreshModels;
  if (!modelMenu.hidden) renderModelMenu();
}
function renderModelMenu() {
  modelMenu.innerHTML = "";
  if (state.models.length === 0) {
    modelMenu.innerHTML = `<div class="model-empty">${escapeHtml(t.modelsUnavailable)}</div>`;
    return;
  }
  for (const model of state.models) {
    const option = document.createElement("button");
    option.className = `model-option${model.id === state.model ? " active" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(model.id === state.model));
    const meta = [
      model.contextLength ? `${formatContext(model.contextLength)}` : "",
      model.supportsReasoning ? "reasoning" : "",
      model.supportsVision ? "vision" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    option.innerHTML =
      `<span class="model-id">${escapeHtml(model.id)}</span>` +
      (model.name && model.name !== model.id ? `<span class="model-name">${escapeHtml(model.name)}</span>` : "") +
      (meta ? `<span class="model-meta">${escapeHtml(meta)}</span>` : "");
    option.addEventListener("click", () => {
      api.send({ cmd: "setModel", model: model.id });
      closeModelMenu();
    });
    modelMenu.appendChild(option);
  }
  const footer = document.createElement("button");
  footer.className = "model-refresh";
  footer.textContent = t.refreshModels;
  footer.addEventListener("click", () => {
    modelMenu.innerHTML = `<div class="model-empty">${escapeHtml(t.loadingModels)}</div>`;
    api.send({ cmd: "refreshModels" });
  });
  modelMenu.appendChild(footer);
}

function formatContext(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function openModelMenu() {
  renderModelMenu();
  modelMenu.hidden = false;
  modelPicker.setAttribute("aria-expanded", "true");
  const active = modelMenu.querySelector(".model-option.active");
  if (active) active.scrollIntoView({ block: "center" });
}

function closeModelMenu() {
  modelMenu.hidden = true;
  modelPicker.setAttribute("aria-expanded", "false");
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
      // Reopen the conversation the window was in last time. The host starts
      // a fresh session on every launch, so without this every restart lost
      // the context of what the user was doing.
      const remembered = localStorage.getItem("prometheus.lastSession");
      if (remembered && remembered !== state.sessionId && localStorage.getItem("prometheus.restartSession") !== "0") {
        api.send({ cmd: "loadSession", id: remembered });
      }
      if (state.needsSetup) {
        state.needsSetup = false;
        $("setup-button").hidden = true;
        addNode(`<div class="notice dim">${escapeHtml(t.setupBody)}</div>`);
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
      );
      $("setup-dismiss")?.addEventListener("click", () => {
        localStorage.setItem("prometheus.setupDismissed", "1");
        document.querySelector(".notice.setup")?.remove();
      });
      break;
    }

    case "state":
      state.sessionId = message.sessionId;
      // Remember the conversation the user is in, so a restart comes back to
      // it instead of opening a blank window. The setting can be turned off.
      if (message.sessionId && localStorage.getItem("prometheus.restartSession") !== "0") {
        localStorage.setItem("prometheus.lastSession", message.sessionId);
      }
      if (message.cwd) state.cwd = message.cwd;
      state.locale = message.locale || state.locale;
      applyLocale(state.locale);
      // Sandbox state first: the mode label marks "auto" when it runs without
      // isolation, so it has to know before the label is drawn.
      if (message.sandbox) state.sandbox = message.sandbox;
      if (message.effortChoices) state.effortChoices = message.effortChoices;
      if (message.contextBreakdown !== undefined) state.contextBreakdown = message.contextBreakdown;
      setMode(message.mode);
      setEffort(message.effort || "auto");
      // Board selection and project kind are cheap, so every state event carries
      // them; the machine scan waits until the pane asks for it.
      if (message.board) {
        state.board = { ...state.board, ...message.board };
        renderBoardChip();
      }
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
      // A different workspace is a different tree. Only when the pane is on
      // screen: asking at every state event would refetch the list each time
      // a mode changes, and the reply would paint over a closed pane.
      if (!workbench.hidden && state.pane === "files" && state.treePath !== (state.cwd ?? "")) {
        requestTree(state.cwd);
      }
      // A state event carries session-level totals: replace, never add. It
      // may also carry spend and occupancy (the host attaches them when it
      // opens a stored session); a state event without them is the same
      // session changing a mode, so the figures on screen stay.
      applyCost(message);
      updateMeter(message.context, message.usage, { replace: true });
      break;

    case "board_state":
      setBoardState(message);
      break;

    case "device_status":
      // The probe's report. Kept apart from `board` so a device answer never
      // erases the (empty, but present) board shape the pane renders.
      state.device = message.device ?? null;
      state.deviceTool = message.tool ?? "";
      if (state.device) {
        $("board-control").hidden = false;
        renderBoardChip();
        if (state.pane === "board" && !workbench.hidden) renderBoard();
      }
      break;

    case "board_targets": {
      state.boardTargets = {
        total: message.total ?? 0,
        notes: message.notes ?? [],
        targets: message.targets ?? [],
        error: message.error ?? "",
      };
      // Names the attached chip answers to. Kept apart from the table's own
      // candidates because they were computed from the hardware, not from a
      // substring match on whatever the user typed.
      state.boardSuggested = Array.isArray(message.suggested) ? message.suggested : [];
      if (message.error) addNotice("error", message.error);
      // The host follows with a fresh board_state carrying the new verdict.
      renderBoard();
      break;
    }

    case "board_selection":
      state.board = { ...state.board, selection: message.selection ?? {} };
      renderBoardChip();
      break;

    case "serial_snapshot":
      state.serial.open = Boolean(message.open);
      state.serial.port = message.port ?? null;
      state.serial.baud = message.baud ?? null;
      state.serial.lines = message.lines ?? [];
      fillSerialControls();
      rerenderSerialLines();
      break;

    case "serial_state":
      setSerialState(message);
      break;

    case "serial_lines":
      state.serial.dropped = (state.serial.dropped ?? 0) + (message.dropped ?? 0);
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

    case "serial_cleared":
      state.serial.lines = [];
      state.serial.filtered = 0;
      $("serial-output").innerHTML = "";
      renderSerialStatus();
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

    case "checkpoints":
      state.checkpoints = message.entries ?? [];
      state.checkpointRedo = Boolean(message.redo);
      renderCheckpoints();
      break;

    case "tree": {
      const target = pendingTreeTarget ?? fileTree;
      pendingTreeTarget = null;
      target.innerHTML = "";
      const nodes = message.nodes ?? [];
      // An empty reply ends the "loading" state either way. It is not worded
      // as "this folder is empty": the host answers a refusal with a warning
      // notice and then an empty tree, so an empty reply can mean "empty" or
      // "not allowed to read it", and the notice above it says which.
      if (nodes.length === 0) {
        target.innerHTML = `<div class="sidebar-empty">${escapeHtml(t.treeEmpty)}</div>`;
        break;
      }
      for (const node of nodes) target.appendChild(treeRow(node));
      break;
    }

    case "artifacts":
      state.artifacts = message.artifacts ?? [];
      renderArtifacts();
      break;

    case "artifact":
      renderArtifact(message.artifact);
      break;

    case "file_matches":
      if (message.query === mention?.query) renderMention(message.files ?? []);
      break;

    case "subagent_start": {
      const node = addNode(
        `<div class="subagent running"${message.id ? ` data-subagent="${escapeHtml(message.id)}"` : ""}>` +
          `<div class="subagent-head"><span class="subagent-glyph">${icon("corner-down-right")}</span>` +
          `<span class="subagent-title">${escapeHtml(t.subagentLabel)}</span>` +
          `<span class="subagent-count"></span>` +
          (message.id ? `<button class="subagent-stop" type="button">${escapeHtml(t.subagentStop)}</button>` : "") +
          `<button class="subagent-toggle" type="button" aria-expanded="false">${escapeHtml(t.subagentExpand)}</button>` +
          `</div>` +
          `<div class="subagent-prompt">${escapeHtml(message.prompt ?? "")}</div>` +
          `<div class="subagent-activities"></div>` +
          `</div>`,
      );
      // Expand/collapse: the card stays compact by default but nothing is
      // discarded, so a stuck child can be read line by line.
      const toggle = node.querySelector(".subagent-toggle");
      toggle?.addEventListener("click", () => {
        const open = node.classList.toggle("expanded");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.textContent = open ? t.subagentCollapse : t.subagentExpand;
      });
      // Stopping a child from its own card is the difference between "the
      // agent is doing something odd" and "I can end that one part".
      node.querySelector(".subagent-stop")?.addEventListener("click", () => {
        api.send({ cmd: "stopSubagent", id: message.id });
      });
      state.currentSubagent = { node, count: 0, id: message.id ?? "" };
      break;
    }

    case "subagents": {
      // The Tasks panel's live view; the cards in the transcript already show
      // history, this is for the ones still running.
      state.subagents = message.subagents ?? [];
      renderSubagents();
      break;
    }

    case "subagent_activity": {
      const sub = state.currentSubagent;
      if (!sub) break;
      sub.count += 1;
      const list = sub.node.querySelector(".subagent-activities");
      const line = document.createElement("div");
      line.className = "subagent-line";
      line.innerHTML = `${icon(message.kind === "tool" ? "chevron-right" : "dot", "inline")}<span>${escapeHtml(message.text)}</span>`;
      list.appendChild(line);
      // A long sub-task used to keep only its last 40 lines, which is exactly
      // the point where you cannot see how it got stuck. Everything is kept in
      // the DOM; the collapsed card clips it and "expand" reveals the rest.
      sub.node.querySelector(".subagent-count").textContent = String(sub.count);
      break;
    }

    case "subagent_end": {
      const sub = state.currentSubagent;
      if (!sub) break;
      sub.node.classList.remove("running");
      if (!message.ok) sub.node.classList.add("failed");
      sub.node.querySelector(".subagent-count").textContent = message.ok ? t.subagentDone : t.subagentFailed;
      sub.node.querySelector(".subagent-stop")?.remove();
      state.currentSubagent = null;
      break;
    }

    case "export_ready":
      exportSessionFile(message.markdown, message.filename);
      break;

    case "commands":
      state.commands = message.commands ?? [];
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
      state.worktree = message.worktree ?? null;
      renderGitBar();
      renderWorktree();
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

    case "worktree_diff":
      state.worktreeDiffText = message.diff || "";
      addNotice("dim", `${t.worktreeDiff} · ${message.branch}`);
      showWorktreeDiff();
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

    case "queued":
      setQueuedBadge(message.count ?? 0);
      break;

    case "user_queued_delivered":
      // The host echoed the message when it reached the model, so the bubble
      // can lose its "queued" marker.
      markQueuedDelivered();
      break;

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
      const map = {
        restartSession: "restartSession",
        suggestions: "suggestions",
        updateCheck: "updateCheck",
        isolateByDefault: "isolateByDefault",
      };
      const key = map[message.key];
      if (key) localStorage.setItem(`prometheus.${key}`, message.value === false ? "0" : "1");
      break;
    }

    case "usage_summary":
    case "mcp_servers":
    case "skills":
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
      settings.handleEvent(message);
      break;

    case "usage":
      // A live event adds to the totals but may also carry occupancy and the
      // session's running spend. The cost is taken first so the redraw at the
      // end of updateMeter already has it; the token sum stays with the call
      // below, which owns the add-vs-replace rule.
      applyCost(message);
      updateMeter(message.context, message.usage);
      break;

    case "run_start":
      setBusy(true);
      clearSuggestion();
      endThinking();
      // Keep typing possible while the turn runs; the message is queued.
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
      addToolRow(message.name, message.summary, message.annotations);
      break;

    case "tool_detail":
      // The transcript already shows the tool's text; this is the structured
      // side, which the panes use. Only a build changes what they display.
      if (message.name === "embed_build") api.send({ cmd: "getBoardState" });
      // A file write's diff, attached to its row: seeing what changed in place
      // is faster than opening the Changes pane and finding the file.
      if (message.data && message.data.change) {
        const row = state.lastToolNode;
        if (row) attachInlineDiff(row, message.data.change);
      }
      break;

    case "tool_end": {
      const row = state.currentTool?.node;
      if (row) {
        row.classList.remove("running");
        row.classList.add("done");
        if (!message.ok) row.classList.add("failed");
        const summaryEl = row.querySelector(".tool-summary");
        if (message.summary) summaryEl.textContent = message.summary;
        if (!message.ok) summaryEl.style.color = "var(--danger)";
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
        state.currentTool = null;
      }
      break;
    }

    case "tool_output": {
      const row = lastToolRow();
      if (row) attachToolOutput(row, message.name, message.content, message.artifactPath);
      scrollToBottom();
      break;
    }

    case "todos":
      renderPlan(message.items);
      scrollToBottom();
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

    // ---- 自主循环 ----
    // 每一轮的边界都要看得见：否则几轮下来，用户读到的是一段连续的对话，
    // 分不清哪一段是自己说的、哪一段是循环自己接上的。
    case "goal_start":
      state.goalRun = { kind: message.kind, goal: message.goal, maxRounds: message.maxRounds, round: 0 };
      addNode(
        `<div class="compact-marker goal-marker">` +
          `<span class="compact-line"></span>` +
          `<span class="compact-label">${escapeHtml(
            message.kind === "goal"
              ? t.goalStarted.replace("{n}", String(message.maxRounds))
              : t.loopStarted.replace("{n}", String(message.maxRounds)),
          )}</span>` +
          `<span class="compact-line"></span>` +
          `</div>`,
      );
      renderGoalBadge();
      scrollToBottom();
      break;

    case "goal_round":
      if (message.phase === "start") {
        // 第 1 轮也要标出来：它是规划轮，和后面的执行轮性质不同，用户
        // 需要知道"这一轮只是拆步骤，还没动手"。
        addNode(
          `<div class="compact-marker">` +
            `<span class="compact-line"></span>` +
            `<span class="compact-label">${escapeHtml(
              message.round === 1 && state.goalRun?.kind === "loop" ? t.loopPlanRound : t.goalRound.replace("{n}", String(message.round)),
            )}</span>` +
            `<span class="compact-line"></span>` +
            `</div>`,
        );
        scrollToBottom();
        if (state.goalRun) {
          state.goalRun.round = message.round;
          renderGoalBadge();
        }
      }
      break;

    case "goal_end":
      state.goalRun = null;
      renderGoalBadge();
      addNode(
        `<div class="goal-summary ${message.stop === "goal-met" || message.stop === "task-list-complete" ? "done" : "stopped"}">` +
          `<strong>${escapeHtml(t.goalEnded)}</strong> ` +
          escapeHtml(message.detail) +
          `</div>`,
      );
      scrollToBottom();
      break;

    case "recovery": {
      // A previous process died mid-goal. Offer to pick the loop up rather
      // than silently dropping the work, with the round it had reached.
      const list = message.sessions || [];
      if (list.length === 0) break;
      const rows = list
        .slice(0, 4)
        .map((session) => {
          const label = escapeHtml(session.title || session.id);
          const note = escapeHtml(`${session.goal.kind} ${session.goal.round}/${session.goal.maxRounds}: ${session.goal.text}`);
          return (
            `<div class="recovery-row" data-session="${escapeHtml(session.id)}">` +
            `<div class="recovery-title">${label}</div>` +
            `<div class="recovery-note">${note}</div>` +
            `<div class="recovery-actions">` +
            `<button class="link-button" data-recovery-open="${escapeHtml(session.id)}">${escapeHtml(t.recoveryOpen)}</button>` +
            `</div></div>`
          );
        })
        .join("");
      addNode(`<div class="notice recovery"><div class="recovery-head">${escapeHtml(t.recoveryTitle)}</div>${rows}</div>`);
      for (const button of document.querySelectorAll("[data-recovery-open]")) {
        button.addEventListener("click", () => {
          const id = button.getAttribute("data-recovery-open");
          api.send({ cmd: "loadSession", id });
          api.send({ cmd: "resumeGoal" });
        });
      }
      break;
    }

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
      suggestNextTurn();
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
      applyCost(message, { replace: true });
      if (message.usage) updateMeter(null, message.usage, { replace: true });
      else renderUsage();
      target
        .querySelectorAll(".turn, .tool-row, .tool-group, .tool-item, .tool-output, .notice, .plan, .thinking, .subagent, .compact-marker")
        .forEach((node) => node.remove());
      state.currentAssistant = null;
      state.currentThinking = null;
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
      for (const item of message.messages || []) {
        if (item.role === "user") {
          const node = addUserTurn(item.text, item.images ?? 0);
          attachRewind(node, item.index);
        }
        else if (item.role === "assistant") {
          const node = addNode(`<div class="turn assistant"><div class="markdown">${md(item.text)}</div></div>`);
          bindCodeCopy(node);
        } else if (item.role === "tool") {
          const row = document.createElement("div");
          row.className = "tool-row done";
          row.innerHTML =
            `<span class="tool-glyph">${icon(toolGlyph(item.name))}</span>` +
            `<span class="tool-name">${escapeHtml(toolLabel(item.name))}</span>` +
            `<span class="tool-summary">${escapeHtml(item.summary || "")}</span>`;
          toolGroup().appendChild(row);
        }
      }
      if ((message.messages || []).length === 0) {
        target.appendChild(emptyState);
        emptyState.hidden = false;
      }
      if (message.cwd) {
        state.cwd = message.cwd;
        renderTopbarLocation();
        // Absolute, like every other tree request: "." is resolved against the
        // host process and refused by its boundary.
        requestTree(state.cwd);
        api.send({ cmd: "listSessions", includeArchived: state.showArchived });
      }
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
              row.prepend(dot);
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

/** The Tasks pane: every sub-agent this session started, and its state. */
function renderSubagents() {
  const list = $("tasks-list");
  if (!list) return;
  list.innerHTML = "";
  const subagents = state.subagents ?? [];
  if (subagents.length === 0) {
    list.innerHTML = `<div class="sidebar-empty">${escapeHtml(t.noTasks)}</div>`;
    return;
  }
  for (const agent of subagents) {
    const row = document.createElement("div");
    row.className = `task-row ${agent.status}`;
    const seconds = Math.max(0, Math.round((agent.elapsedMs ?? 0) / 1000));
    row.innerHTML =
      `<span class="task-state ${escapeHtml(agent.status)}"></span>` +
      `<span class="task-label">${escapeHtml(agent.label)}</span>` +
      `<span class="task-meta">${escapeHtml(t.taskMeta(agent.turns ?? 0, seconds))}</span>` +
      (agent.status === "running" ? `<button class="link-button task-stop">${escapeHtml(t.subagentStop)}</button>` : "");
    row.querySelector(".task-stop")?.addEventListener("click", () => api.send({ cmd: "stopSubagent", id: agent.id }));
    list.appendChild(row);
  }
}

/* ---------- workbench: diff, file, tree, checkpoints ---------- */

/**
 * Panes with a backend in this kernel. Everything else is unreachable.
 *
 * The serial monitor is not here: its commands (`serialOpen`/`serialRead`/…)
 * have no host implementation, so the tab was removed rather than left as a
 * pane whose Start button answers "unsupported". The probe's serial state is
 * visible as a field in the board pane's Device section.
 *
 * `files` is the workspace tree: `getTree` is real in the host and the bridge,
 * and a directory row expands through the same `getTree` the pane's root uses.
 */
const SUPPORTED_PANES = new Set(["board", "file", "files", "artifact"]);

/**
 * Fill the tree pane from `path`.
 *
 * An absolute path is required: the host decides access by comparing the
 * resolved path against the session workspace, and "." resolves against
 * whatever the host's process happened to have as its cwd — it gets refused.
 * With no workspace open there is nothing to ask for, so the pane says so
 * instead of leaving an empty list that looks like an empty folder.
 */
function requestTree(path) {
  const root = typeof path === "string" ? path.trim() : "";
  state.treePath = root;
  // A root request owns the next reply. Without this an expansion that never
  // answered (the host replies to a refusal with an empty tree, but a dropped
  // request leaves it set) would capture the root's answer into one row.
  pendingTreeTarget = null;
  if (root === "") {
    fileTree.innerHTML = `<div class="sidebar-empty">${escapeHtml(t.treeNoWorkspace)}</div>`;
    return;
  }
  fileTree.innerHTML = `<div class="sidebar-empty">${escapeHtml(t.treeLoading)}</div>`;
  api.send({ cmd: "getTree", path: root });
}

function openWorkbench(pane) {
  if (pane !== undefined && !SUPPORTED_PANES.has(pane)) {
    // A tool row for a diff or the terminal used to open the pane it belonged
    // to. Those backends are not mounted, so the row stays a row instead of
    // opening an empty inspector.
    return;
  }
  state.pane = pane ?? state.pane;
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
  localStorage.setItem("prometheus.pane", state.pane);
  workbenchTabs.querySelectorAll("button").forEach((button) => {
    const active = button.dataset.pane === state.pane;
    button.classList.toggle("active", active);
    // A tab strip is one stop in the tab order, with arrows moving between
    // tabs: otherwise every pane button is a tab stop and keyboard users walk
    // through eight of them to get past the strip.
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const showDiff = state.pane === "diff";
  const showTerminal = state.pane === "terminal";
  const showArtifact = state.pane === "artifact";
  const showBrowser = state.pane === "browser";
  const showFiles = state.pane === "files";
  const showHistory = state.pane === "history";
  const showTasks = state.pane === "tasks";
  const showFile = state.pane === "file";
  const showBoard = state.pane === "board";
  const showSerial = state.pane === "serial";
  const tasksRoot = $("tasks-root");
  if (tasksRoot) tasksRoot.hidden = !showTasks;
  if (showTasks) {
    api.send({ cmd: "subagents" });
    renderSubagents();
  }
  $("diff-pane").hidden = !showDiff;
  diffRoot.hidden = !showDiff;
  diffFilelist.hidden = !showDiff || state.changes.files.length === 0;
  $("diff-scope").hidden = !showDiff;
  $("pane-tree").hidden = !showFiles;
  $("changes-list").hidden = !showDiff;
  $("history-root").hidden = !showHistory;
  $("artifact-list-pane").hidden = !showArtifact || Boolean(state.selectedArtifact);
  fileRoot.hidden = !showFile;
  terminalRoot.hidden = !showTerminal;
  $("artifact-root").hidden = !showArtifact || !state.selectedArtifact;
  $("browser-root").hidden = !showBrowser;
  $("board-root").hidden = !showBoard;
  $("serial-root").hidden = !showSerial;
  if (showDiff) renderDiff();
  if (showFiles) requestTree(state.cwd);
  if (showHistory) api.send({ cmd: "getCheckpoints" });
  if (showArtifact) api.send({ cmd: "getArtifacts" });
  if (showTerminal) {
    openTerminal();
  }
  if (showBoard) {
    // Two-phase: the host answers synchronously with the project half and
    // fills the inventory in when the machine scan finishes.
    api.send({ cmd: "getBoardState" });
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

function closeWorkbench() {
  workbench.setAttribute("hidden", "");
  state.workbenchOpen = false;
  localStorage.setItem("prometheus.workbench", "0");
  // The page view floats above the window, so it must be removed explicitly.
  void api.browserClose?.();
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

function showWorktreeDiff() {
  // openWorkbench("diff") renders the session diff, so paint over it with the
  // worktree diff afterwards.
  openWorkbench("diff");
  workbenchMeta.textContent = t.worktreeDiff;
  diffFilelist.hidden = true;
  diffRoot.innerHTML = state.worktreeDiffText
    ? `<pre class="raw-diff">${escapeHtml(state.worktreeDiffText)}</pre>`
    : `<div class="diff-empty">${escapeHtml(t.noChanges)}</div>`;
}

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

/* ---------- board pane ---------- */

/**
 * The Board pane is a report, not a control panel: it answers "what is attached
 * and what will the tools use". The one thing it can change is the selection,
 * because that is what the agent falls back to — and that selection is saved by
 * the host, not held here.
 */
/**
 * The Board pane.
 *
 * One question, one block: what will the flasher be told to flash. Everything
 * else on this pane exists only to answer that or to explain why it cannot be
 * answered. The chip reading is the *evidence* for the target, never a second
 * target — when both were rows, a stale saved name and a live reading sat side
 * by side and the user was asked to adjudicate a conflict the pane invented.
 *
 * The machine inventory (every toolchain, every port, the whole target table)
 * lives in Settings and in `embed_targets`. It used to fill this pane, which
 * buried a one-second answer under a page of things that were not wrong.
 */
function renderBoard() {
  const body = $("board-body");
  const board = state.boardState;
  if (!board) {
    // No workspace scanner in this kernel. "Reading the workspace…" would
    // never finish; what is true is whether a probe has reported at all.
    body.innerHTML = state.device
      ? deviceSectionHtml()
      : `<div class="board-empty">${escapeHtml(t.boardNoDevice)}</div>`;
    return;
  }

  const parts = [];
  const row = (label, value, cls = "", note = "") => {
    parts.push(
      `<div class="board-row"><span class="board-label">${escapeHtml(label)}</span>` +
        `<span class="board-value${cls ? ` ${cls}` : ""}" title="${escapeHtml(value)}">${escapeHtml(value)}</span></div>` +
        (note ? `<div class="board-note">${escapeHtml(note)}</div>` : ""),
    );
  };

  const scanned = Boolean(board.scannedAt);
  const project = board.project ?? { kind: "unknown", evidence: [] };
  const effective = board.effective ?? {};
  const source = board.targetSource ?? (effective.target ? "manual" : "none");
  const identity = board.identity ?? null;
  const hasProbes = (board.probes ?? []).length > 0;

  // ---- Target: the one thing this pane is for -----------------------------
  parts.push(`<div class="board-section"><div class="board-section-title">${escapeHtml(t.boardTarget)}</div>`);

  // The evidence line, under the target: family, size, probe. Never a row of
  // its own — it is the explanation of the value above it.
  const evidence = [];
  if (identity?.family) {
    evidence.push(identity.family);
    if (identity.flashKib !== undefined) evidence.push(`${identity.flashKib} KiB`);
  }
  if (identity) evidence.push(t.boardReadFromChip);

  if (source === "chip") {
    row("", effective.target ?? "", "ok", evidence.join(" · "));
  } else if (source === "unlisted") {
    row("", t.boardNoTargetName, "warn", t.boardTargetUnlisted(identity?.family ?? ""));
  } else if (source === "manual") {
    row("", effective.target ?? "", "", t.boardTargetManual);
    if (evidence.length) parts.push(`<div class="board-note">${escapeHtml(evidence.join(" · "))}</div>`);
  } else if (!scanned) {
    parts.push(`<div class="board-empty">${escapeHtml(t.boardScanning)}</div>`);
  } else if (hasProbes) {
    row("", t.boardUnknownPart, "warn", board.identityNote || t.boardNoChipRead);
  } else {
    row("", t.boardNoProbeShort, "warn", t.boardPlugInHint);
  }

  // What carries the name. A target name has no meaning without the flasher
  // whose namespace it belongs to, so these live in the same block.
  if (source !== "none" || effective.flasher) {
    row(t.boardFlasher, effective.flasher || t.boardFlasherDefault, effective.flasher ? "" : "muted");
  }
  const portText = effective.port
    ? `${effective.port}${selectionHasBaud(board) ? ` · ${effective.baud}` : ""}`
    : t.boardUnset;
  row(t.boardSerial, portText, effective.port ? "" : "warn", effective.port && !selectionHasBaud(board) ? t.boardBaudDefault : "");
  parts.push(`</div>`);

  // ---- Alternatives ------------------------------------------------------
  // Only when the chip read leaves a real choice: 1 MiB vs 2 MiB, or two
  // probes. These are overrides on top of the chip's answer, not a second
  // answer to compare against.
  const options = board.targetOptions ?? [];
  const portChoices = (board.ports ?? []).filter((port) => port.path !== effective.port);
  if (options.length > 1 || portChoices.length > 0) {
    parts.push(`<div class="board-section"><div class="board-section-title">${escapeHtml(t.boardAlternatives)}</div>`);
    if (options.length > 1) {
      parts.push(`<div class="board-targets">`);
      for (const name of options) {
        const active = name === effective.target ? " active" : "";
        parts.push(`<button type="button" class="board-target${active}" data-target="${escapeHtml(name)}">${escapeHtml(name)}</button>`);
      }
      parts.push(`</div>`);
    }
    if (portChoices.length > 0) {
      parts.push(`<div class="board-targets">`);
      for (const port of portChoices) {
        parts.push(`<button type="button" class="board-port" data-port="${escapeHtml(port.path)}">${escapeHtml(port.path)}</button>`);
      }
      parts.push(`</div>`);
    }
    parts.push(`</div>`);
  }

  // ---- Project and the last build ----------------------------------------
  parts.push(`<div class="board-section"><div class="board-section-title">${escapeHtml(t.boardProject)}</div>`);
  if (project.kind === "unknown") {
    parts.push(`<div class="board-empty"><strong>${escapeHtml(t.boardNoProject)}</strong>${escapeHtml(t.boardNoProjectHint)}</div>`);
  } else {
    row(t.boardKind, project.kind, "ok");
    if (project.root) row(t.boardRoot, project.root);
  }
  if (board.build) {
    if (board.build.usage) {
      // Flash usage is a share of a capacity only when the part reported one.
      // Without it the bytes are still true; the percentage would not be.
      const flash = board.build.usage.flash;
      const total = identity?.flashKib !== undefined ? identity.flashKib * 1024 : undefined;
      const share = total ? ` (${((flash / total) * 100).toFixed(1)}%)` : "";
      row(t.boardFlash, `${formatBytes(flash)}${share}`, "", total ? "" : t.boardRamUnknown);
      row(t.boardRam, formatBytes(board.build.usage.ram));
    } else {
      row(t.boardBuild, board.build.ok ? t.boardBuildOk : t.boardBuildFailed, board.build.ok ? "ok" : "bad");
    }
    parts.push(`<div class="board-note">${escapeHtml(t.boardFromBuild)}</div>`);
  }
  parts.push(`</div>`);

  // ---- Machine, as one line ----------------------------------------------
  // The full inventory is in Settings. What belongs here is only what the user
  // can act on: is there a probe, is there a port, and what does this project
  // need that is missing. A list of every installed toolchain answered no
  // question anyone asked this pane.
  if (scanned) {
    const probes = (board.probes ?? []).length;
    const ports = (board.ports ?? []).length;
    const summary = [
      t.boardProbeCount(probes),
      t.boardPortCount(ports),
      (board.tools ?? []).length ? t.boardToolCount((board.tools ?? []).length) : t.boardNoTools,
    ].join(" · ");
    parts.push(`<div class="board-section"><div class="board-section-title">${escapeHtml(t.boardMachine)}</div>`);
    parts.push(`<div class="board-note">${escapeHtml(summary)}</div>`);
    for (const note of board.probeNotes ?? []) parts.push(`<div class="board-note dim">${escapeHtml(note)}</div>`);
    // Only the tools this project's own kind needs, and only when missing.
    const needed = requiredMissing(board);
    if (needed.length > 0) row(t.boardMissing, needed.join(", "), "warn");
    parts.push(`</div>`);
  }

  if (state.device) parts.unshift(deviceSectionHtml());
  body.innerHTML = parts.join("");
  body.querySelectorAll("[data-target]").forEach((button) => {
    button.addEventListener("click", () => saveBoardSelection({ target: button.dataset.target }));
  });
  body.querySelectorAll("[data-port]").forEach((button) => {
    button.addEventListener("click", () => saveBoardSelection({ port: button.dataset.port }));
  });
}

/**
 * Whether the baud rate shown was chosen or defaulted.
 *
 * A baud rate cannot be observed: nothing reads it back from the port. When
 * the user has not set one, the number on screen is this app's default, and
 * showing `COM7 · 115200` as though it were a property of the port is the same
 * mistake as showing a default context window as the model's.
 */
function selectionHasBaud(board) {
  const chosen = board?.selection?.baud;
  return typeof chosen === "number" && chosen > 0;
}

/**
 * Toolchains this project's kind needs and the machine does not have.
 *
 * The full missing list is every toolchain the detector knows about — telling
 * an STM32 project it lacks RISC-V GCC, `west` and `idf.py` is noise that
 * reads like an error. Only the tools this project would actually invoke are
 * listed, and only when they are absent.
 */
function requiredMissing(board) {
  const kind = board?.project?.kind ?? "unknown";
  const needs = {
    zephyr: ["cmake", "ninja", "gcc-arm", "west"],
    espIdf: ["idf", "cmake"],
    platformio: ["pio"],
    arduino: ["arduino-cli"],
    cmake: ["cmake", "gcc-arm"],
    // A bare Makefile or a bare-metal project still needs a compiler and make.
    make: ["make", "gcc-arm"],
  }[kind];
  if (!needs) return [];
  const missing = new Set(board?.missing ?? []);
  return needs.filter((tool) => missing.has(tool));
}

function formatBytes(bytes) {  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function saveBoardSelection(patch) {
  const next = { ...(state.board.selection ?? {}), ...patch };
  api.send({ cmd: "setBoardSelection", selection: next });
}

function setBoardState(message) {
  // The project phase arrives first and the inventory second; each replaces the
  // previous wholesale, so a mode change or folder switch cannot leave stale
  // toolchains on screen.
  state.boardState = message.state;
  state.board = state.boardState;
  if (message.targetStatus) state.boardTargetStatus = message.targetStatus;
  renderBoard();
  renderBoardChip();
}

/**
 * The probe's own report, as a section.
 *
 * This kernel has no workspace scanner: the only device facts come from the
 * probe MCP, which answers `{ backend, probe, cpu, serial }` after a tool call.
 * Rendering them under their own heading keeps them distinct from the target
 * and port fields no tool fills in.
 */
function deviceSectionHtml() {
  const device = state.device;
  if (!device) return "";
  const rows = [];
  const labels = {
    backend: t.boardDeviceBackend,
    probe: t.boardDeviceProbe,
    cpu: t.boardDeviceCpu,
    serial: t.boardDeviceSerial,
  };
  for (const [key, label] of Object.entries(labels)) {
    const value = device[key];
    if (value === undefined) continue;
    const bad = value === "detached" || value === "unknown" || value === "none";
    rows.push(
      `<div class="board-row"><span class="board-label">${escapeHtml(label)}</span>` +
        `<span class="board-value${bad ? " warn" : ""}">${escapeHtml(String(value))}</span></div>`,
    );
  }
  if (rows.length === 0) return "";
  const source = state.deviceTool ? `<div class="board-note">${escapeHtml(t.boardDeviceFrom(state.deviceTool))}</div>` : "";
  return (
    `<div class="board-section"><div class="board-section-title">${escapeHtml(t.boardDevice)}</div>` +
    rows.join("") +
    source +
    `</div>`
  );
}

/* ---------- board chip in the composer ---------- */

/** Hidden until there is something to say: a web project gets no extra chip. */
function renderBoardChip() {
  const control = $("board-control");
  const selection = state.board.selection ?? {};
  // The chip shows what the tools will use, not what was saved: a saved target
  // with a swapped board is exactly the stale value the pane stopped trusting,
  // and the chip would otherwise put it back in front of the user.
  const effective = state.boardState?.effective ?? selection;
  const target = effective.target;
  const projectKind = state.board.projectKind ?? "unknown";
  const hasPorts = (state.boardState?.ports ?? []).length > 0;
  // The probe's answer is also something to say: with no scanner in this
  // kernel, `device` is the only live reading the chip can carry.
  const device = state.device;
  const relevant =
    Boolean(effective.port || target) || projectKind !== "unknown" || hasPorts || Boolean(device);
  control.hidden = !relevant;
  if (!relevant) return;

  const parts = [];
  if (target) parts.push(target);
  if (effective.port) parts.push(effective.port);
  // Nothing named yet, but the probe answered: show its state rather than an
  // empty "not set" chip next to a visible device report.
  if (parts.length === 0 && device) {
    if (typeof device.backend === "string" && device.backend !== "none") parts.push(device.backend);
    if (typeof device.probe === "string") parts.push(device.probe);
  }
  // This node carries no data-i18n on purpose: the locale sweep would overwrite
  // it with placeholder text. Same reason as the model id label.
  $("board-chip-value").textContent = parts.join(" · ") || t.boardChipNone;
  $("board-chip-value").title = parts.join(" · ");
}

function openBoardMenu() {
  const menu = $("board-menu");
  const selection = state.board.selection ?? {};
  const ports = state.boardState?.ports ?? [];
  const parts = [];
  if (ports.length === 0) {
    parts.push(`<div class="menu-empty">${escapeHtml(t.boardNoPort)}</div>`);
  } else {
    for (const port of ports) {
      const detail = port.board || port.description || (port.vid ? `${port.vid}:${port.pid ?? "?"}` : "");
      const active = port.path === selection.port ? " active" : "";
      parts.push(
        `<button type="button" role="menuitem" class="model-option${active}" data-port="${escapeHtml(port.path)}">` +
          `<span>${escapeHtml(port.path)}</span>` +
          (detail ? `<span class="model-meta">${escapeHtml(detail)}</span>` : "") +
          `</button>`,
      );
    }
  }
  parts.push(`<div class="menu-sep"></div>`);
  parts.push(`<button type="button" role="menuitem" class="menu-action" data-action="board">${escapeHtml(t.boardOpenPane)}</button>`);
  parts.push(`<button type="button" role="menuitem" class="menu-action" data-action="refresh">${escapeHtml(t.boardRefresh)}</button>`);
  menu.innerHTML = parts.join("");
  menu.hidden = false;
  $("board-picker").setAttribute("aria-expanded", "true");

  menu.querySelectorAll("[data-port]").forEach((button) => {
    button.addEventListener("click", () => {
      saveBoardSelection({ port: button.dataset.port });
      closeBoardMenu();
    });
  });
  menu.querySelector('[data-action="board"]').addEventListener("click", () => {
    closeBoardMenu();
    openWorkbench("board");
  });
  menu.querySelector('[data-action="refresh"]').addEventListener("click", () => {
    closeBoardMenu();
    api.send({ cmd: "getBoardState", refresh: "all" });
  });
}

function closeBoardMenu() {
  $("board-menu").hidden = true;
  $("board-picker").setAttribute("aria-expanded", "false");
}

$("board-picker").addEventListener("click", (event) => {
  event.stopPropagation();
  if ($("board-menu").hidden) openBoardMenu();
  else closeBoardMenu();
});

$("board-refresh").addEventListener("click", () => api.send({ cmd: "getBoardState", refresh: "all" }));

/* ---------- serial pane ---------- */

const SERIAL_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const SERIAL_MAX_LINES = 4000;

function openSerialPane() {
  fillSerialControls();
  // Never open the port automatically: asserting DTR resets most boards, and
  // the agent may be using it. A status read only fetches the ring.
  api.send({ cmd: "serialStatus" });
}

function fillSerialControls() {
  const portSelect = $("serial-port");
  const baudSelect = $("serial-baud");
  const ports = state.boardState?.ports ?? [];
  const selection = state.board.selection ?? {};
  const wantedPort = state.serial.port || selection.port || (ports.length === 1 ? ports[0].path : "");

  portSelect.innerHTML = "";
  if (ports.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t.boardNoPort;
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
  baudSelect.value = String(state.serial.baud || selection.baud || 115200);
  portSelect.disabled = state.serial.open;
  baudSelect.disabled = state.serial.open;
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
  if (serial.filtered) parts.push(`${serial.filtered} ${t.serialFiltered}`);
  status.textContent = parts.join(" · ");
  $("serial-pause").disabled = !serial.open;
  setIcon($("serial-pause").querySelector("svg"), serial.paused ? "play" : "pause");
  $("serial-follow").setAttribute("aria-pressed", String(serial.follow));
}

/** One row per line; `serial_text` keeps the message, the rest is gutter. */
function serialLineNode(line) {
  const row = document.createElement("div");
  row.className = `serial-line${line.level ? ` ${line.level}` : ""}`;
  const time = new Date(line.at).toTimeString().slice(0, 8);
  const millis = String(new Date(line.at).getMilliseconds()).padStart(3, "0");

  const timeEl = document.createElement("span");
  timeEl.className = "serial-time";
  timeEl.textContent = `${time}.${millis}`;

  const levelEl = document.createElement("span");
  levelEl.className = `serial-level${line.level ? ` ${line.level}` : ""}`;
  levelEl.textContent = line.level ? line.level.toUpperCase().slice(0, 5) : "";

  const tagEl = document.createElement("span");
  tagEl.className = "serial-tag";
  tagEl.textContent = line.tag ?? "";

  const textEl = document.createElement("span");
  textEl.className = "serial-text";
  textEl.textContent = line.text;

  row.append(timeEl, levelEl, tagEl, textEl);
  if (line.level) row.dataset.level = line.level;
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
  if (message.error) serial.lastError = message.error;
  else if (serial.open) serial.lastError = "";
  if (!serial.open) {
    serial.paused = false;
    serial.pausedBacklog = 0;
  } else {
    // Opening a port starts a fresh ring on the host.
    $("serial-output").innerHTML = "";
    serial.lines = [];
    serial.filtered = 0;
    serial.dropped = 0;
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
  state.serial.port = port;
  state.serial.baud = baud;
  // Opening the monitor also states the port the agent should use; the two are
  // the same decision, and making the user repeat it is how they diverge.
  if ((state.board.selection ?? {}).port !== port) saveBoardSelection({ port, baud });
  api.send({ cmd: "serialOpen", port, baud });
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
  state.serial.lines = [];
  state.serial.filtered = 0;
  $("serial-output").innerHTML = "";
  api.send({ cmd: "serialClear" });
  renderSerialStatus();
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

$("serial-port").addEventListener("change", () => {
  saveBoardSelection({ port: $("serial-port").value, baud: Number($("serial-baud").value) || 115200 });
});

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
  if (!workbench.hidden) closeWorkbench();
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
  if (name) void navigator.clipboard.writeText(name);
});

function renderCheckpoints() {
  checkpointList.innerHTML = "";
  const entries = state.checkpoints;
  if (entries.length === 0) {
    checkpointList.innerHTML = `<div class="sidebar-empty">${escapeHtml(t.noCheckpoints)}</div>`;
    return;
  }
  if (state.checkpointRedo) {
    // The undo is itself undoable; without this the first click on "restore"
    // was a one-way door and users stopped using it.
    const redo = document.createElement("button");
    redo.className = "restore-start";
    redo.textContent = t.redoSafe;
    redo.addEventListener("click", () => api.send({ cmd: "redo" }));
    checkpointList.appendChild(redo);
  }

  const restoreAll = document.createElement("button");
  restoreAll.className = "restore-start";
  restoreAll.textContent = t.restoreStart;
  restoreAll.addEventListener("click", () => {
    void confirmAction(t.restoreConfirm, { danger: true }).then((yes) => {
      if (yes) api.send({ cmd: "restoreCheckpoint", id: "start" });
    });
  });
  checkpointList.appendChild(restoreAll);

  // History grouped by the turn that produced the change. A flat list of
  // paths lost the "what happened when" that makes a rewind decision possible.
  let lastIndex = null;
  for (const entry of [...entries].reverse()) {
    if (entry.messageIndex !== undefined && entry.messageIndex !== lastIndex) {
      lastIndex = entry.messageIndex;
      const header = document.createElement("div");
      header.className = "checkpoint-turn";
      header.textContent = t.checkpointTurn(entry.messageIndex);
      checkpointList.appendChild(header);
    }
    const row = document.createElement("button");
    row.className = "checkpoint-row";
    const time = new Date(entry.at).toLocaleTimeString(state.locale === "zh" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    row.innerHTML =
      `<span class="checkpoint-time">${escapeHtml(time)}</span>` +
      `<span class="checkpoint-path">${escapeHtml(entry.path)}</span>`;
    row.title = `${entry.tool} · ${t.restoreFile}`;
    row.addEventListener("click", () => {
      // This row is one file. Restoring the whole range from here undid every
      // later edit too, which is not what clicking one path promises.
      void confirmAction(`${t.restoreFile} ${entry.path}?`, { danger: true }).then((yes) => {
        if (yes) api.send({ cmd: "restoreFile", path: entry.path });
      });
    });
    checkpointList.appendChild(row);
  }
}

function renderTree() {
  fileTree.innerHTML = "";
  const nodes = state.tree ?? [];
  if (nodes.length === 0) {
    // The pane is only drawn when something asks for it; a blank list with no
    // text reads as "still loading" forever.
    const reason = state.treePath ? t.treeEmpty : t.treeNoWorkspace;
    fileTree.innerHTML = `<div class="sidebar-empty">${escapeHtml(reason)}</div>`;
    return;
  }
  for (const node of nodes) fileTree.appendChild(treeRow(node));
}

function treeRow(node) {
  const row = document.createElement("button");
  row.className = "tree-row";
  row.innerHTML =
    `<span class="twisty">${node.type === "dir" ? icon("chevron-right") : ""}</span>` +
    `<span class="tree-name">${escapeHtml(node.name)}</span>`;
  row.title = node.path;
  row.addEventListener("click", () => {
    if (node.type === "file") {
      openFile(node.path);
      return;
    }
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains("tree-children")) {
      existing.hidden = !existing.hidden;
      setIcon(row.querySelector(".twisty svg"), existing.hidden ? "chevron-right" : "chevron-down");
      return;
    }
    const container = document.createElement("div");
    container.className = "tree-children";
    row.after(container);
    setIcon(row.querySelector(".twisty svg"), "chevron-down");
    // The target is recorded before the request goes out. The browser bridge
    // answers a supported command synchronously, so setting this afterwards
    // delivered the reply into the root of the tree instead of under the row.
    pendingTreeTarget = container;
    api.send({ cmd: "getTree", path: node.path });
  });
  return row;
}

let pendingTreeTarget = null;

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

/* ---------- voice input ---------- */

/**
 * Dictation uses the Web Speech API. It is only present when Electron was built
 * with speech support and the OS exposes a recognizer, so the button stays
 * hidden when unavailable instead of failing on click.
 */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let voiceBase = "";

function setupVoice() {
  if (!SpeechRecognition) return;
  $("voice-button").hidden = false;
  $("voice-button").addEventListener("click", () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = state.locale === "zh" ? "zh-CN" : "en-US";
    voiceBase = input.value ? `${input.value} ` : "";

    recognition.onresult = (event) => {
      let final = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (final) {
        voiceBase += final;
      }
      input.value = `${voiceBase}${interim}`;
      autoSize();
    };
    recognition.onerror = () => stopVoice();
    recognition.onend = () => stopVoice();
    $("voice-button").classList.add("recording");
    $("voice-button").title = t.voiceStop;
    try {
      recognition.start();
    } catch {
      stopVoice();
    }
  });
}

function stopVoice() {
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
    recognition = null;
  }
  voiceBase = "";
  $("voice-button").classList.remove("recording");
  $("voice-button").title = t.voiceStart;
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
  closeWorkbench();
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
 * Sessions are grouped by workspace, the way every coding agent organizes
 * them: one collapsible project header, its conversations underneath, and the
 * active project expanded. A flat list mixed folders together and made it
 * impossible to tell which project a conversation belonged to.
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
  if (visible.length === 0) {
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
  const lastUsed = new Map();
  for (const session of visible) {
    const key = normalizeCwd(session.cwd);
    if (!groups.has(key)) {
      groups.set(key, []);
      displayPath.set(key, session.cwd || "");
      lastUsed.set(key, session.updatedAt);
    }
    groups.get(key).push(session);
  }
  const activeProject = normalizeCwd(state.cwd);
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
    const head = document.createElement("button");
    head.className = `session-group${cwd === activeProject ? " active" : ""}`;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    const count = document.createElement("span");
    count.className = "session-group-count";
    count.textContent = String(items.length);
    const name = document.createElement("span");
    name.className = "session-group-name";
    name.textContent = labels.get(cwd) ?? projectLabel(displayPath.get(cwd) || cwd);
    name.title = displayPath.get(cwd) || cwd || t.noProject;
    const twisty = document.createElement("span");
    twisty.className = "session-group-twisty";
    twisty.innerHTML = icon(open ? "chevron-down" : "chevron-right");
    // New chat inside this project, without leaving the current conversation.
    const add = document.createElement("span");
    add.className = "session-group-add";
    add.title = t.newSessionIn(projectLabel(cwd));
    add.textContent = "+";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = displayPath.get(cwd) || cwd;
      if (target && target !== state.cwd) api.send({ cmd: "setCwd", cwd: target });
      else api.send({ cmd: "newSession" });
    });
    head.append(twisty, name, count, add);
    head.addEventListener("click", () => {
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
    });
    sessionList.appendChild(head);
    // A folded project shows only its name. Leaving a few conversations visible
    // defeats the point of folding: the list is still crowded, and the count on
    // the group row already says how many are inside.
    const shown = open ? items : [];

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
      button.innerHTML =
        (status ? `<span class="session-state ${status}" title="${escapeHtml(t.sessionStatusLabel(status))}"></span>` : "") +
        (session.pinned ? `<span class="session-pin" title="${escapeHtml(t.sessionPinned)}">${icon("pin")}</span>` : "") +
        `<div class="session-title">${escapeHtml(title)}</div>` +
        `<span class="session-meta">${escapeHtml(relativeDate(session.updatedAt))}</span>`;
      button.title = `${title}\n${relativeDate(session.updatedAt)}\n${session.cwd}`;
      button.addEventListener("click", () => {
        api.send({ cmd: "loadSession", id: session.id });
        // On a narrow window the drawer covers the conversation once opened.
        if (window.matchMedia("(max-width: 860px)").matches) document.querySelector(".shell").classList.add("collapsed");
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
      more.title = t.sessionMenu;
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
  // Attachments and @-mentions have no upload path in this kernel. An image
  // stays in the strip and is not sent; a picked path is not uploaded either,
  // but it costs nothing to tell the model which paths the user meant: the
  // path list is appended to the text, so the promise made when the path was
  // added ("this is part of your message") is kept without a kernel change.
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
  if (input.value.trim()) clearSuggestion();
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
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const path = mention.files[mention.index];
      if (path) applyMention(path);
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
  if (event.key === "Tab" && state.suggestion && !input.value.trim() && !event.shiftKey) {
    event.preventDefault();
    input.value = state.suggestion;
    clearSuggestion();
    autoSize();
    input.focus();
    return;
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
      closeModal(settingsDialog);
      closeModal(shortcutsDialog);
      return;
    }
    if (!topbarMenu.hidden) {
      setTopbarMenu(false);
      return;
    }
    if (!modelMenu.hidden) {
      closeModelMenu();
      return;
    }
    if (!pendingPermission.hidden) {
      answerPermission("no");
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
  } else if (key === "d" && event.shiftKey) {
    // No diff pane in this build; the shortcut stays bound so it does not
    // fall through to whatever the next branch would have done.
    event.preventDefault();
  } else if (key === "e" && event.shiftKey) {
    event.preventDefault();
    openWorkbench("board");
  } else if (key === "e") {
    event.preventDefault();
    // Cycle through what this model actually accepts, not a fixed four.
    const order = ["auto", ...(effortLevels().length > 0 ? effortLevels() : ["low", "medium", "high"])];
    const next = order[(order.indexOf(state.effort) + 1) % order.length];
    setEffort(next);
    api.send({ cmd: "setEffort", effort: next });
  } else if (key === "\\") {
    event.preventDefault();
    closeWorkbench();
  } else if (key === "`") {
    event.preventDefault();
    openWorkbench("terminal");
  }
});

document.addEventListener("click", (event) => {
  if (!modelMenu.hidden && !event.target.closest(".model-control")) closeModelMenu();
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
    // Electron exposes the real path on dropped files; plain browser File
    // objects do not, and there is nothing useful to send without one.
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
 * Split `/compact` arguments into a focus and a keep count.
 *
 * Mirrors the REPL's parser: `--keep N` is pulled out wherever it appears and
 * the rest is the focus, so "tests --keep 12" and "--keep 12 tests" mean the
 * same thing.
 */
function parseCompactArgs(text) {
  const keepMatch = /(?:^|\s)--keep(?:=|\s+)(\d+)/.exec(text || "");
  const keep = keepMatch ? Number(keepMatch[1]) : 0;
  const focus = String(text || "").replace(/(?:^|\s)--keep(?:=|\s+)\d+/, "").trim();
  return { ...(focus ? { focus } : {}), ...(keep > 0 ? { keep } : {}) };
}

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

/**
 * The badge in the title bar while a goal or task loop is running.
 *
 * An autonomous run must be visible at all times and stoppable in one click.
 * Without the badge, the only sign that something is looping is the transcript
 * scrolling, and a user who looks away cannot tell whether it is still going.
 */
function renderGoalBadge() {
  const badge = $("goal-badge");
  const run = state.goalRun;
  if (!badge) return;
  if (!run) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  const label = run.kind === "goal" ? t.goalBadge : t.loopBadge;
  $("goal-badge-text").textContent = `${label} ${run.round}/${run.maxRounds}`;
}

$("goal-badge")?.addEventListener("click", () => api.send({ cmd: "stopGoal" }));

/**
 * Start a goal or task loop, asking for the goal first.
 *
 * The prompt names the round ceiling before anything runs: an autonomous loop
 * spends the user's tokens without them typing again, so the cost has to be
 * stated up front rather than discovered in the transcript.
 */
async function startAutonomous(command) {
  if (state.goalRun) {
    addNotice("warn", t.goalAlreadyRunning);
    return;
  }
  const goal = await askText(command === "startGoal" ? t.goalPrompt : t.loopPrompt, "");
  if (goal === null) return;
  const trimmed = goal.trim();
  if (!trimmed && command === "startGoal") return;
  api.send({ cmd: command, goal: trimmed, maxRounds: 8 });
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
    { label: t.paneBoard, run: () => openWorkbench("board") },
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
  for (const command of state.commands) {
    entries.push({
      label: `/${command.name}`,
      hint: command.description || command.argumentHint || "",
      run: () => {
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
transcriptScroll.addEventListener("scroll", updateScrollButton);
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
  setEffort(button.dataset.effort);
  api.send({ cmd: "setEffort", effort: button.dataset.effort });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#effort-control")) setEffortMenu(false);
});

modelPicker.addEventListener("click", (event) => {
  event.stopPropagation();
  if (modelMenu.hidden) openModelMenu();
  else closeModelMenu();
});

/**
 * Register a local folder as the workspace root and switch to it.
 *
 * `setCwd` only moved the directory the next session would start in; it did
 * not register the folder as a workspace root, so every later `getTree` and
 * `getFile` under it was refused by the host's boundary check. `setWorkspace`
 * does both, which is why the top bar sends it instead.
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
 * - Electron returning null means the native dialog was cancelled, which is
 *   not an error to punish with a second prompt;
 * - the browser bridge has no native picker and returns null, so the path is
 *   typed instead.
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
  // `api.platform` exists only when an Electron preload is in front. There a
  // null means the user closed the native dialog, and re-asking with a text
  // box would punish them for cancelling; here the click has already done
  // something (a dialog opened and closed).
  if (api.platform && !pickerFailed) return;
  // The browser bridge has no native picker and returns null, so the path is
  // typed instead. `askText`, not `window.prompt`: Electron does not implement
  // prompt and returns null without drawing anything (see the note on
  // askText), which would put a dead click back in the desktop window.
  const typed = await askText(t.workspacePathPrompt, state.cwd ?? "");
  if (typed) setWorkspace(typed);
}

$("topbar-cwd").addEventListener("click", chooseWorkspace);
$("sidebar-workspace").addEventListener("click", chooseWorkspace);

/* ---------- isolated worktree ---------- */

function renderWorktree() {
  const active = state.worktree;
  // The worktree control lives on the active project's header, so its state
  // reads where the project is named instead of in a second card.
  $("worktree-button").classList.toggle("active", Boolean(active));
  $("worktree-button").title = active ? `${t.worktreeLabel}: ${active.branch}` : t.worktreeLabel;
  $("worktree-actions-off").hidden = Boolean(active);
  $("worktree-actions-on").hidden = !active;
  $("worktree-copy").textContent = active ? `${t.worktreeActive} ${active.path}` : t.worktreeExplain;
}

$("worktree-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const panel = $("worktree-panel");
  panel.hidden = !panel.hidden;
  $("worktree-button").setAttribute("aria-expanded", String(!panel.hidden));
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#worktree-panel") && !event.target.closest("#worktree-button")) {
    const panel = $("worktree-panel");
    if (!panel.hidden) {
      panel.hidden = true;
      $("worktree-button").setAttribute("aria-expanded", "false");
    }
  }
});

$("worktree-enable").addEventListener("click", () => api.send({ cmd: "worktreeStart" }));
$("worktree-diff").addEventListener("click", () => api.send({ cmd: "worktreeDiff" }));
$("worktree-merge").addEventListener("click", () => {
  void confirmAction(t.worktreeMergeConfirm).then((yes) => {
    if (yes) api.send({ cmd: "worktreeMerge" });
  });
});
$("worktree-discard").addEventListener("click", () => {
  void confirmAction(t.worktreeDiscardConfirm, { danger: true }).then((yes) => {
    if (yes) api.send({ cmd: "worktreeDiscard" });
  });
});

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
      trigger.title = option.label;
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
  $("toggle-archived").title = state.showArchived ? t.hideArchived : t.showArchived;
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

/** Collapse or expand the conversation sidebar; remembered across restarts. */
function toggleSidebar() {
  const collapsed = document.querySelector(".shell").classList.toggle("collapsed");
  localStorage.setItem("prometheus.sidebarCollapsed", collapsed ? "1" : "0");
}
if (localStorage.getItem("prometheus.sidebarCollapsed") === "1") {
  document.querySelector(".shell").classList.add("collapsed");
}

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

/* ---------- top bar: workspace, changes, terminal ---------- */

function renderTopbarLocation() {
  const cwd = state.cwd ?? "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const name = parts.length > 0 ? parts[parts.length - 1] : "";
  $("topbar-cwd-name").textContent = name || t.appName;
  $("topbar-cwd").title = cwd || t.appName;
  // The sidebar entry reads the same name, computed once above: a second
  // basename helper is how the two views would come to disagree.
  $("sidebar-workspace-name").textContent = name || t.workspaceNone;
  $("sidebar-workspace").title = cwd ? `${t.changeFolderTitle}: ${cwd}` : t.workspaceChoose;
  // aria-label replaces the two lines above rather than adding to them, so it
  // has to name both the current folder and what the click does; otherwise a
  // screen reader would hear the action and lose the state.
  $("sidebar-workspace").setAttribute(
    "aria-label",
    `${t.workspaceLabel}: ${name || t.workspaceNone} — ${cwd ? t.changeFolderTitle : t.workspaceChoose}`,
  );
  $("sidebar-workspace").classList.toggle("empty", name === "");
  const branch = state.git?.available ? state.git.branch : "";
  const branchNode = $("topbar-cwd-branch");
  branchNode.hidden = !branch;
  branchNode.textContent = branch ?? "";
}

function renderChangesBadge() {
  const count = state.changes.files.length;
  const badge = $("changes-badge");
  badge.hidden = count === 0;
  badge.textContent = String(count);
  // A change landing mid-turn is worth a glance without opening the pane.
  badge.classList.toggle("live", state.busy && count > 0);
  $("changes-button").title = count > 0 ? `${t.paneDiff} (${count})` : t.paneDiff;
}

$("changes-button").addEventListener("click", () => {
  if (!workbench.hidden && state.pane === "diff") closeWorkbench();
  else openWorkbench("diff");
});
$("terminal-button").addEventListener("click", () => {
  if (!workbench.hidden && state.pane === "terminal") closeWorkbench();
  else openWorkbench("terminal");
});


workbenchTabs.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => openWorkbench(button.dataset.pane));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const tabs = [...workbenchTabs.querySelectorAll("button")];
    const index = tabs.indexOf(button);
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    openWorkbench(next.dataset.pane);
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
if (api.platform && api.platform !== "darwin") {
  windowControls.hidden = false;
  document.documentElement.classList.add("custom-caption");
  windowControls.querySelectorAll("[data-window]").forEach((button) => {
    button.addEventListener("click", () => api.windowControl(button.dataset.window));
  });
  const applyWindowState = ({ maximized }) => {
    document.documentElement.classList.toggle("window-maximized", Boolean(maximized));
    $("window-maximize").title = maximized ? "Restore" : "Maximize";
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
});

// Kept as free functions so the rest of this file can call them by name.
const openSettings = (tab) => settings.open(tab);
const openSetup = () => settings.openSetup();
const refreshVersion = () => settings.refreshVersion();
applySettingsLocale = () => settings.applyLocaleChange();
$("settings-button").addEventListener("click", () => openSettings());

/* ---------- shortcuts sheet ---------- */

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
    [t.shortcutChanges, `${mod}+Shift+D`],
    [t.shortcutFiles, `${mod}+Shift+E`],
    [t.shortcutTerminal, `${mod}+\``],
    [t.shortcutClosePane, `${mod}+\\`],
    [t.shortcutModeAsk, `${mod}+1`],
    [t.shortcutModeAuto, `${mod}+2`],
    [t.shortcutModePlan, `${mod}+3`],
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

/** Background update check: only surfaces when a newer version exists. */
async function checkUpdateQuietly() {
  if (!api.checkUpdate || localStorage.getItem("prometheus.updateCheck") === "0") return;
  const result = await api.checkUpdate();
  if (!result || result.status !== "available") return;
  state.updateAvailable = result;
  addNotice("dim", t.updateAvailableBanner(result.latest));
  const button = $("check-update");
  if (button) button.textContent = `${t.checkUpdate} · ${result.latest}`;
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
  else if (row.id === "menu-shortcuts") openShortcuts();
  else if (row.id === "menu-browse-files") openWorkbench("files");
  else if (row.id === "menu-clear") clearConversation();
});

document.addEventListener("click", (event) => {
  if (!topbarMenu.hidden && !event.target.closest("#topbar-menu") && !event.target.closest("#more-button")) {
    setTopbarMenu(false);
  }
});

modalScrim.addEventListener("click", () => {
  closeModal(settingsDialog);
  closeModal(shortcutsDialog);
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt || "";
    autoSize();
    input.focus();
  });
});

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
if (api.platform) document.documentElement.classList.add(`platform-${api.platform}`);
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
  document.documentElement.dataset.view = localStorage.getItem("prometheus.view") || "normal";
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
setupVoice();
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
// No tree request here: the Files pane asks for its own root with an absolute
// path when it is opened. A "." sent at boot was refused by the host boundary
// and its empty reply would have painted over a tree the pane had loaded.
api.send({ cmd: "setLocale", locale: state.locale });
input.focus();
