/**
 * Kernel session events → Embedded AI Master host events.
 *
 * Pure functions shared by the desktop host (Node) and the renderer. Nothing
 * here touches the DOM, the filesystem, or the network: the host feeds it
 * `SessionEvent` objects from the kernel log and gets back the `{ type }`
 * messages the renderer already knows how to draw. (There used to be a second
 * adapter — a browser bridge over HTTP + SSE — removed on 2026-10-22 when the
 * desktop form became the only one; this layer was what made the two agree,
 * and it stays because host and renderer are still two processes.)
 *
 * The kernel's log is the single source of truth. The renderer's expectations
 * differ from it in two ways this module bridges:
 *
 *   - the kernel writes one complete `assistant` event per turn, the renderer
 *     wants `assistant_start` / `assistant_delta` / `assistant_end`;
 *   - the kernel separates `tool_started` (no arguments) from the `assistant`
 *     event that carries them, the renderer wants one row per tool with a
 *     summary taken from those arguments.
 */

/** Kernel event types this module knows how to translate. */
const KNOWN_TYPES = new Set([
  "system",
  "user",
  "assistant",
  "assistant_delta",
  // The model's reasoning fragments. The renderer has had start / text / end
  // handlers for this since before the kernel produced any; this module is
  // where the three are synthesised (`openThinking` / `closeThinking`, plus the
  // `thinking_delta` case below). Leaving it out of this set would turn every
  // reasoning fragment into an "unknown event type" warning line.
  "thinking_delta",
  "tool_call",
  "tool_result",
  "tool_started",
  "mcp_status",
  "device_status",
  "usage",
  "checkpoint",
  "status",
  "interrupted",
  "compaction",
  "permission_decision",
  "approval_request",
  // `todos` must stay in this set. A type missing here does not pass silently:
  // it becomes a `未识别的事件类型` warn notice, so every plan update would
  // print a warning line above the plan card it just drew.
  "todos",
  // Same rule for `background_result`: a long build finishing is exactly the
  // moment the operator has walked away from the window, and the one line that
  // says it finished would otherwise be a warning that it could not be read.
  "background_result",
  // Same rule for `subagent_result`: a subagent's conclusion arrives after the
  // turn that started it may already be over. Leaving it out would print an
  // "unrecognised event type" warning exactly where the answer should be.
  "subagent_result",
  // Same rule for `subagent_started`: it is written by the runner before the
  // `subagent` tool returns, so it lands mid-turn on every dispatch. This
  // module registers it and draws nothing yet — a missing entry here would put
  // a warning line above every tool row that started a subagent.
  "subagent_started",
]);

/**
 * Kernel events that end an open reasoning block.
 *
 * Only events that either put something in the transcript after the block or
 * end the turn belong here. Status-carrying events (`usage`, `checkpoint`,
 * `mcp_status`, `device_status`, `compaction`, `permission_decision`, …) are
 * deliberately absent: they produce no transcript content of their own, and
 * closing on them would cut one chain of thought into several blocks for a
 * reason the reader cannot see.
 */
const THINKING_INTERRUPTING_TYPES = new Set([
  "assistant",
  "assistant_delta",
  "tool_call",
  "tool_started",
  "tool_result",
  "user",
  "status",
  "interrupted",
]);

/** Tool output larger than this is truncated before it reaches the DOM. */
export const MAX_TOOL_OUTPUT_BYTES = 8 * 1024;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Occupancy as the renderer consumes it, or `null` when there is no
 * measurement.
 *
 * `tokens` and `percent` must both be finite numbers: a record carrying one of
 * them is not a measurement, and filling the other with 0 would paint a figure
 * the kernel never reported (R3 — unknown is not zero). `window` travels only
 * when it is a positive finite number; 0 is "no window reported", not "a window
 * of zero", and it would make the percentage uninterpretable.
 */
function measuredContext(value) {
  if (!isRecord(value)) return null;
  const { tokens, percent, window } = value;
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return null;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const context = { tokens, percent };
  if (typeof window === "number" && Number.isFinite(window) && window > 0) {
    context.window = window;
  }
  return context;
}

/**
 * Per-category occupancy split as the renderer consumes it, or `null`.
 *
 * The kernel's producer guarantees `sum(parts.tokens) === used`; this only
 * checks the shape, because a translator is not the place to second-guess the
 * producer. A part whose `key` or `tokens` is unusable is dropped rather than
 * rounded to zero — a zero-token slice would still add a legend row nobody
 * measured (R3). A split with no usable part left is no split at all, and so
 * is one missing any of the four figures: every percentage in the panel
 * divides by `window`, and 0 is "not reported", not "a window of zero".
 */
function measuredBreakdown(value) {
  if (!isRecord(value)) return null;
  const { used, window, percent, compactAt, parts } = value;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return null;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  if (typeof compactAt !== "number" || !Number.isFinite(compactAt)) return null;
  if (!Array.isArray(parts)) return null;
  const kept = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.key !== "string" || part.key === "") continue;
    const tokens = part.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue;
    kept.push({ key: part.key, tokens });
  }
  if (kept.length === 0) return null;
  return { used, window, percent, compactAt, parts: kept };
}

/** The only statuses the kernel writes for a plan item. */
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** The kernel's `todo_write` schema caps item text at 500 characters. */
const MAX_TODO_CONTENT = 500;

/**
 * A `todos` payload as the renderer's plan card consumes it, or `null` when
 * there is no list at all.
 *
 * The renderer paints what this returns, so anything it cannot vouch for is
 * dropped rather than shown: a row with no usable text would put a blank line
 * on a plan nobody can read, and a status outside the three known values would
 * become a CSS class that matches no rule. The text, though, is what the model
 * actually meant to say — a broken status does not make the task disappear —
 * so such a row survives as `pending`.
 *
 * An empty list is *not* `null`: clearing the plan is a legal instruction the
 * model can give, and the renderer removes the card when it receives it. Only
 * a payload with no array at all is untranslatable.
 */
export function todosEvent(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return null;
  const items = [];
  for (const raw of payload.items) {
    if (!isRecord(raw)) continue;
    if (typeof raw.content !== "string") continue;
    // `trim` is only the emptiness test: the row keeps the text exactly as the
    // model wrote it, because that text is the one thing here it is entitled
    // to say without this module editing it.
    if (raw.content.trim() === "") continue;
    // The kernel already enforces the 500 limit; this defends against older
    // logs and other producers without inventing a different bound.
    const content =
      raw.content.length > MAX_TODO_CONTENT
        ? `${raw.content.slice(0, MAX_TODO_CONTENT)}…`
        : raw.content;
    const status = TODO_STATUSES.has(raw.status) ? raw.status : "pending";
    items.push({ content, status });
  }
  return { type: "todos", items };
}

/** Statuses the kernel writes for a finished background job. */
const BACKGROUND_STATUSES = new Set(["exited", "signaled", "timed_out"]);

function byteCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * One line for a finished background terminal job, or `null` when the payload
 * carries no outcome.
 *
 * The level is `warn` exactly when the job did not simply exit zero: a build
 * that died of a signal, ran out of its timeout or returned non-zero is
 * something the operator should see without going looking. A clean exit is
 * `dim` — it is news, not a problem.
 *
 * Truncation is stated in the same line, with both figures: the bytes the job
 * produced and the bytes kept. Printing only the kept count would present a
 * cut-down tail as the whole output (R3), and this is the one line the
 * operator reads before deciding whether to run `terminal_bg_check`.
 *
 * The command is capped at 120 characters, matching `summarizeToolCall`: this
 * is a transcript row, and a 4 KB heredoc in it would bury the outcome it is
 * supposed to announce.
 */
export function summarizeBackgroundResult(payload) {
  if (!isRecord(payload)) return null;
  const status = textOf(payload.status);
  if (!BACKGROUND_STATUSES.has(status)) return null;
  const command = textOf(payload.command);
  const label = command.length > 120 ? `${command.slice(0, 120)}…` : command;
  const who = label === "" ? "后台任务" : `后台任务 ${label}`;

  let outcome;
  if (status === "timed_out") {
    outcome = "已超时被终止";
  } else if (status === "signaled") {
    const signal = textOf(payload.signal);
    outcome = signal === "" ? "被信号终止" : `被信号 ${signal} 终止`;
  } else {
    const exitCode = payload.exitCode;
    outcome =
      typeof exitCode === "number" && Number.isFinite(exitCode)
        ? `已结束，退出码 ${exitCode}`
        : "已结束，退出码未知";
  }

  const verdict = status === "exited" && payload.exitCode === 0 ? "dim" : "warn";
  const parts = [`${who} ${outcome}`];

  const bytes = byteCount(payload.bytes);
  const capturedBytes = byteCount(payload.capturedBytes);
  if (payload.truncated === true) {
    // Both figures, and which end survived. Omitting either turns "we kept a
    // tail" into "this is the output".
    const produced = bytes === undefined ? "未知" : String(bytes);
    const kept = capturedBytes === undefined ? "未知" : String(capturedBytes);
    parts.push(`输出已截断：共 ${produced} 字节，仅保留最后 ${kept} 字节`);
  } else if (bytes !== undefined) {
    parts.push(`${bytes} 字节输出`);
  }

  return { type: "notice", level: verdict, text: parts.join("；") };
}

/** How much of a hook's own sentence reaches the tool row. */
const MAX_HOOK_NOTE_CHARS = 200;

/** One clause for an entry of `ToolResult.detail.hooks`. */
function hookEntryClause(entry) {
  if (entry.blocked === true) {
    const command = textOf(entry.command);
    return command === "" ? "被钩子拦截" : `被钩子拦截：${command}`;
  }
  // `failure` already reads `hook #N (source) <command>: <reason>` — it names
  // which entry of which file did not run and why, which is what the reader
  // needs. The two events need different clauses: a `preToolUse` failure is
  // fail-closed and the call never executed, while a `postToolUse` failure
  // leaves the tool's own result intact and only drops the annotation.
  const failure = textOf(entry.failure);
  if (failure === "") return "钩子未运行";
  return entry.event === "preToolUse"
    ? `钩子未跑成，调用未执行：${failure}`
    : `钩子未跑成：${failure}`;
}

/**
 * The extra line a tool row carries when a hook blocked it or failed to run,
 * or `undefined` when there is nothing to say.
 *
 * This is a note on an existing row, not an event: the kernel already put the
 * outcomes in `tool_result.detail.hooks`, and inventing a second event for the
 * same fact would be a second definition of it. It is also deliberately
 * *conditional* — a tool call with no hooks must produce exactly the message
 * it produced before hooks existed, so no field is written when the detail
 * carries none (or carries an empty list).
 *
 * Only `blocked` and `failure` are notable. A hook that ran and said nothing
 * (or whose post-output was appended to the text) is already visible in the
 * result body; annotating every call that merely has hooks configured would
 * turn a quiet mechanism into a status line on every row.
 *
 * `detail` is `unknown` on the wire, so every step is shape-checked: a log
 * written by another version is not a reason to throw inside the renderer.
 */
export function summarizeHookDetail(detail) {
  if (!isRecord(detail)) return undefined;
  const hooks = detail.hooks;
  if (!Array.isArray(hooks)) return undefined;
  const notable = hooks.filter(
    (entry) => isRecord(entry) && (entry.blocked === true || textOf(entry.failure) !== ""),
  );
  if (notable.length === 0) return undefined;
  const rest = notable.length > 1 ? `（另有 ${notable.length - 1} 条）` : "";
  const text = `${hookEntryClause(notable[0])}${rest}`;
  return text.length > MAX_HOOK_NOTE_CHARS ? `${text.slice(0, MAX_HOOK_NOTE_CHARS)}…` : text;
}

/** Statuses the kernel writes for a subagent's terminal state. */
const SUBAGENT_STATUSES = new Set(["finished", "failed", "killed", "timed_out"]);

/** How much of the conclusion's first line reaches the transcript row. */
const MAX_SUBAGENT_SUMMARY_CHARS = 120;

/**
 * The first non-empty line of a conclusion, flattened to one row.
 *
 * The completion notice is a headline, not the answer: the full text is in the
 * child session's log and one `subagent_check` away. Copying the whole body
 * into the parent transcript would make the same conclusion appear twice, and
 * an 8 KiB block is not a "line".
 */
function firstLineOf(text) {
  for (const line of textOf(text).split("\n")) {
    const flat = line.replace(/\s+/g, " ").trim();
    if (flat !== "") {
      return flat.length > MAX_SUBAGENT_SUMMARY_CHARS
        ? `${flat.slice(0, MAX_SUBAGENT_SUMMARY_CHARS)}…`
        : flat;
    }
  }
  return "";
}

/**
 * One line for a subagent's terminal state, or `null` when the payload carries
 * no status this module can draw.
 *
 * `finished` is `dim` — it is news, not a problem, and `dim` is the level the
 * renderer actually draws for news (anything other than warn/error/dim is
 * dropped by `addNotice`, so "the ordinary level" has to be one of the three).
 * `failed` / `killed` / `timed_out` are `warn`, each carrying the reason the
 * kernel recorded: an error message, or who asked it to stop. A `failed`
 * payload with no `error` says the reason was not recorded rather than
 * inventing one (R3).
 *
 * Deliberately one notice and nothing else: the renderer has no subagent view,
 * and a card with no content behind it would be the dead UI of D-185 again.
 * The name comes from `label` when the caller gave one; otherwise the id is
 * printed **as an id** (`子代理 sa_…`), never passed off as a name.
 */
export function summarizeSubagentResult(payload) {
  if (!isRecord(payload)) return null;
  const status = textOf(payload.status);
  if (!SUBAGENT_STATUSES.has(status)) return null;
  const label = textOf(payload.label);
  const id = textOf(payload.id);
  const who = label !== ""
    ? `子代理「${label}」`
    : id !== ""
      ? `子代理 ${id}`
      : "子代理";

  if (status === "finished") {
    const headline = firstLineOf(payload.text);
    return {
      type: "notice",
      level: "dim",
      text: headline === ""
        ? `${who} 完成，但没有留下结论正文`
        : `${who} 完成：${headline}`,
    };
  }

  if (status === "failed") {
    const error = textOf(payload.error);
    return { type: "notice", level: "warn", text: `${who} 失败：${error === "" ? "未记录原因" : error}` };
  }
  if (status === "timed_out") {
    return { type: "notice", level: "warn", text: `${who} 超时被终止：跑满了自身时限` };
  }
  // `killed`: the kernel records who asked (`kill` / `abort`), not an error.
  const killedBy = textOf(payload.killedBy);
  const reason =
    killedBy === "kill"
      ? "收到终止请求"
      : killedBy === "abort"
        ? "宿主中止"
        : "未记录原因";
  return { type: "notice", level: "warn", text: `${who} 已终止：${reason}` };
}

/**
 * A running subagent's opening line, or `null` when the payload cannot be keyed.
 *
 * This is interface state, not a transcript row: the strip above the composer
 * keeps one entry per run and drops it when the run's `subagent_result` arrives.
 * `id` is the only field that must be there — without it there is nothing to
 * key the entry on, and an entry nobody can drop would count as "running"
 * forever.
 *
 * No elapsed figure is computed here. That number changes every second, and a
 * pure function precomputing it hands the renderer a value that is already
 * stale by the time it is drawn; the renderer's ticker measures it from
 * `startedAt` against its own clock instead.
 *
 * `status` is deliberately ignored. The event is named `subagent_started`, and
 * a payload that happens to carry a status is still a start — a completion
 * travels as `subagent_result`, and drawing this one as anything else would be
 * two producers for one fact.
 *
 * Empty optional fields are omitted rather than written as `""`: the renderer
 * reads absence as "the kernel did not say", and an empty string there would
 * paint a blank label where an id is the honest fallback.
 */
export function subagentStartedEvent(payload) {
  if (!isRecord(payload)) return null;
  const id = textOf(payload.id);
  if (id === "") return null;
  const message = { type: "subagent_started", id };
  const label = textOf(payload.label);
  if (label !== "") message.label = label;
  const promptPreview = textOf(payload.promptPreview);
  if (promptPreview !== "") message.promptPreview = promptPreview;
  const startedAt = textOf(payload.startedAt);
  if (startedAt !== "") message.startedAt = startedAt;
  const sessionDir = textOf(payload.sessionDir);
  if (sessionDir !== "") message.sessionDir = sessionDir;
  if (typeof payload.maxTurns === "number" && Number.isFinite(payload.maxTurns)) {
    message.maxTurns = payload.maxTurns;
  }
  if (typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)) {
    message.timeoutMs = payload.timeoutMs;
  }
  return message;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function truncateUtf8(text, maxBytes) {
  if (typeof text !== "string") return "";
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  // Decoding a byte slice that ends mid-character yields U+FFFD for the tail.
  // Trim those replacement characters rather than showing them.
  const cut = decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/u, "");
  return `${cut}\n…[truncated]`;
}

/**
 * One line of argument summary for a tool row.
 *
 * Mirrors the original host's `summarizeCall`: prefer the argument that
 * names what the call touches, fall back to the first string value, and keep
 * it short enough for a single row.
 */
export function summarizeToolCall(name, args) {
  const record = isRecord(args) ? args : {};
  const preferred = ["path", "file", "command", "pattern", "query", "name", "address", "tool"];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 120);
    if (typeof value === "number") return String(value);
  }
  const tool = textOf(name);
  return tool;
}

/** The annotation flags the kernel may attach to a `tool_started` event. */
const ANNOTATION_FLAGS = ["readOnly", "destructive", "evidence"];

/**
 * The tool annotations worth carrying to the renderer, or `undefined`.
 *
 * Only `true` survives: a missing flag and a `false` one mean the same thing,
 * and writing the falses out turns a one-flag annotation into noise. A log
 * written before the kernel had annotations has no `annotations` at all and
 * must stay without one — the renderer reads "no field" as "unknown", which a
 * fabricated all-false object would erase.
 */
function toolAnnotations(value) {
  if (!isRecord(value)) return undefined;
  const out = {};
  let marked = false;
  for (const flag of ANNOTATION_FLAGS) {
    if (value[flag] === true) {
      out[flag] = true;
      marked = true;
    }
  }
  return marked ? out : undefined;
}

/**
 * Rebuild the renderer's `publicMessages` list from a full event log.
 *
 * Used when a session is opened: the renderer replaces the whole transcript
 * with these rows and then appends live events on top of them.
 *
 * `todos` is deliberately absent. The plan is interface state drawn beside the
 * transcript, not something the model said, so it travels in `sessionLoadedEvent`'s
 * own field and never becomes a bubble (which would also put it in an export).
 *
 * Reasoning is present as `role: "thinking"`. The kernel writes it as many
 * small `thinking_delta` fragments (batched by the delta writer), so adjacent
 * runs are merged into one completed block — the same shape the live
 * `thinking_start` / `thinking_text` / `thinking_end` sequence leaves behind.
 * Without this a reopened conversation would silently lose content its log
 * still contains.
 */
export function sessionEventsToMessages(events) {
  const out = [];
  if (!Array.isArray(events)) return out;

  /** callId → { name, arguments } for the assistant event that spawned it. */
  const calls = new Map();
  let index = 0;
  /** The open reasoning row, or `null` when the last event was not reasoning. */
  let thinkingRow = null;
  const closeThinkingRow = () => {
    thinkingRow = null;
  };
  for (const event of events) {
    if (!isRecord(event)) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (event.type === "thinking_delta") {
      const text = textOf(payload.text);
      if (text === "") continue;
      if (thinkingRow === null) {
        thinkingRow = { role: "thinking", text: "" };
        out.push(thinkingRow);
      }
      thinkingRow.text += text;
      continue;
    }
    // Every other event ends the run: reasoning that arrives either side of a
    // tool call or a paragraph is two blocks in the live transcript, and the
    // replay has to draw the same two.
    closeThinkingRow();
    if (event.type === "user") {
      const content = textOf(payload.content);
      if (content !== "") {
        out.push({ role: "user", text: content, index: index, images: 0 });
        index += 1;
      }
      continue;
    }
    if (event.type === "assistant") {
      const content = textOf(payload.content);
      if (content.trim() !== "") out.push({ role: "assistant", text: content });
      if (Array.isArray(payload.toolCalls)) {
        for (const call of payload.toolCalls) {
          if (!isRecord(call) || typeof call.id !== "string") continue;
          calls.set(call.id, {
            name: textOf(call.name),
            arguments: isRecord(call.arguments) ? call.arguments : {},
          });
        }
      }
      continue;
    }
    if (event.type === "tool_result") {
      const callId = textOf(payload.id);
      const call = calls.get(callId);
      const row = {
        role: "tool",
        name: call?.name ?? textOf(payload.toolName),
        summary: summarizeToolCall(call?.name, call?.arguments),
        ok: payload.ok !== false,
        done: true,
      };
      // The replayed row carries the same evidence verdict the live one has.
      // Without it, turning on the transcript's evidence filter after
      // reopening a conversation would hide rows that are in fact evidence,
      // and the two views of one log would disagree.
      if (typeof payload.evidence === "boolean") row.evidence = payload.evidence;
      // Same argument for the hook note: after a reload a blocked call would
      // otherwise read as an ordinary failure, and the reason the hook gave
      // would only exist in the log. One log, one transcript.
      const hookNote = summarizeHookDetail(payload.detail);
      if (hookNote !== undefined) row.hookNote = hookNote;
      out.push(row);
    }
  }
  return out;
}

/**
 * Context threaded through the translation.
 *
 * One per open session. `pendingCalls` is populated by `assistant` and read
 * by `tool_started`, which is why the two cannot be translated in isolation.
 */
export function createContext(options = {}) {
  return {
    sessionId: textOf(options.sessionId),
    cwd: textOf(options.cwd),
    running: false,
    /** callId → { name, arguments } */
    pendingCalls: new Map(),
    /** The last assistant paragraph, used for notification text. */
    lastAssistantText: "",
    /** Highest seq already translated; the adapters use it as their cursor. */
    lastSeq: -1,
    /** Tool name being started, so `tool_end` knows which row to close. */
    openTool: "",
    /**
     * callId → tool name for every call still executing, in start order.
     *
     * `openTool` above is a single slot, which is enough to close the row a
     * result belongs to but not enough to name what is running when several
     * read-only calls were dispatched in one batch. The progress line shows
     * the most recently started call that has not finished, which is why this
     * is a map rather than a counter.
     */
    runningTools: new Map(),
    /**
     * Epoch milliseconds of the `user` event that opened the current turn, or
     * 0 before one has been seen.
     *
     * The turn_progress readout carries how long the turn has run. That
     * figure is measured from the log's own timestamp of the user message, so
     * the protocol layer never consults a clock of its own and cannot invent
     * one — a stream with no user event simply omits the field.
     */
    turnStartedAt: 0,
    /** callIds that already produced a `tool_start` row. */
    startedTools: new Set(),
    /** requestIds the renderer is currently showing an approval bar for. */
    pendingApprovals: new Set(),
    /**
     * Text already streamed for the open assistant turn.
     *
     * The kernel sends `assistant_delta` fragments and then the complete
     * `assistant` event. Without this counter the complete text would be
     * appended a second time and the bubble would show the answer twice.
     */
    streamedText: "",
    /**
     * Whether a reasoning block is currently open in the renderer.
     *
     * The kernel emits one `thinking_delta` type, with no start/end of its own:
     * a segment boundary is derivable ("is the previous event a thinking
     * fragment?"), so writing them into the log would add two types that must
     * be kept consistent with `assistant_delta` and carry no new fact. The
     * renderer, though, needs an explicit `thinking_start` / `thinking_end`
     * pair — it builds one node on start and finalises it on end. This flag is
     * that boundary, tracked here so the renderer's state machine stays as it
     * is.
     */
    thinkingOpen: false,
  };
}

/**
 * Open the reasoning block if it is not already open.
 *
 * `thinking_start` is emitted exactly once per segment, before its first text
 * fragment: `appendThinking` on the renderer side silently drops text when no
 * block has been started, so a fragment without a start would be invisible.
 */
function openThinking(ctx, out) {
  if (ctx.thinkingOpen) return;
  ctx.thinkingOpen = true;
  out.push({ type: "thinking_start" });
}

/**
 * Close the reasoning block if one is open.
 *
 * Called before anything that is not a reasoning fragment. This is what keeps
 * a long chain of thought from swallowing the rest of the transcript: the
 * renderer finalises the block (it stops showing "thinking…" and, in the
 * Normal view, collapses to a one-line marker) as soon as the model moves on
 * to prose, a tool, or the end of the turn.
 */
function closeThinking(ctx, out) {
  if (!ctx.thinkingOpen) return;
  ctx.thinkingOpen = false;
  out.push({ type: "thinking_end" });
}

function toolNameFor(ctx, callId, fallback) {
  const call = ctx.pendingCalls.get(callId);
  return call?.name ?? textOf(fallback);
}

/**
 * A `turn_progress` message naming the tool that is executing, or `null`.
 *
 * There used to be no producer for this event at all: the renderer's handler
 * was written against "the host's once-a-second heartbeat" that no host ever
 * sent, so the progress line could only ever show the local clock. This is the
 * cheap honest half of that idea — the event is emitted when a tool starts and
 * when it ends, never on a timer, so the figure it carries is measured rather
 * than guessed:
 *
 *   - `tool` is the name of the most recently started call that has not
 *     finished. Read-only calls run concurrently, so a single "current" slot
 *     would be a lie the moment two of them overlap; the map is ordered by
 *     insertion, and the last entry is the one that started most recently.
 *     An empty string means "nothing is running now" — the renderer clears the
 *     tool half of the line and keeps its clock, which is the truth between
 *     two calls. It is emitted on every result, so a finished call cannot
 *     leave its name on screen while the model is answering.
 *   - `elapsedMs` is derived from the log's own `ts` of the opening `user`
 *     event. No clock is read here, and a log without one omits the field
 *     instead of inventing a zero. `0` would paint "0s" as if the turn had
 *     just begun, which is the same lie as a fabricated percentage.
 *   - `retry` is never reported: the kernel does not publish retry attempts
 *     to this layer, and a constant 0 would look like a measurement of "no
 *     retries". Omitted means "not known here".
 *
 * Nothing is emitted outside a running turn. `ctx.running` is the host's own
 * statement that a turn is in flight; a tool event projected from a log
 * without one (a replay of history, the compaction command's own pass) is
 * describing something that already finished, and a progress line for it
 * would report a turn nobody is waiting on. The renderer ignores those
 * anyway — this keeps the protocol from emitting them at all.
 */
function turnProgress(ctx, now) {
  if (!ctx.running) return null;
  const running = [...ctx.runningTools.values()];
  const message = { type: "turn_progress", tool: running.at(-1) ?? "" };
  if (now > 0 && ctx.turnStartedAt > 0) {
    message.elapsedMs = Math.max(0, now - ctx.turnStartedAt);
  }
  return message;
}

/** Epoch ms for an event's ISO timestamp, or 0 when it is unusable. */
function eventTime(event) {
  const parsed = Date.parse(textOf(event.ts));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Human text for a permission decision's `reason`.
 *
 * The kernel writes stable codes (`approval_timeout`, `preset:…`); showing the
 * raw code left operators reading "已拒绝 fs: approval_timeout" — the one
 * moment the reason matters most. Unknown codes fall through unchanged rather
 * than being replaced by a guess.
 */
const PERMISSION_REASON_TEXT = {
  approval_unavailable: "没有可用的审批通道",
  approval_aborted: "审批被中止",
  approval_denied: "审批被拒绝",
  approval_timeout: "审批超时",
  approval_granted: "已批准",
};

export function permissionReasonText(reason) {
  const text = textOf(reason);
  if (text === "") return "";
  const labels = [];
  for (const code of text.split(";")) {
    if (code === "") continue;
    // A policy reason (`preset:…` / `rule:…`) is what the gate already used to
    // decide, and it is shown in the approval question. Repeating it as the
    // denial reason reads like an error message.
    if (code.startsWith("preset:") || code.startsWith("rule:")) continue;
    if (code.startsWith("approval_error:")) {
      labels.push(`审批通道出错：${code.slice("approval_error:".length).trim()}`);
      continue;
    }
    labels.push(PERMISSION_REASON_TEXT[code] ?? code);
  }
  return labels.join("；");
}

/**
 * Translate one kernel event into zero or more host events.
 *
 * `ctx` is mutated: the cursor advances, pending calls are remembered, and
 * `running` flips on `status` / `interrupted`.
 */
export function sessionEventToHostEvents(event, ctx) {
  const out = [];
  if (!isRecord(event)) return out;
  const type = event.type;
  const payload = isRecord(event.payload) ? event.payload : {};
  if (typeof event.seq === "number" && Number.isSafeInteger(event.seq)) {
    if (event.seq <= ctx.lastSeq) return out;
    ctx.lastSeq = event.seq;
  }
  if (!KNOWN_TYPES.has(type)) {
    out.push({
      type: "notice",
      level: "warn",
      text: `未识别的事件类型: ${String(type)}`,
    });
    return out;
  }

  // Anything that is not another reasoning fragment ends the open reasoning
  // block, and does so *before* it produces its own messages: the renderer
  // gives `thinking_end` no content, so closing first keeps the block above
  // the prose / tool row that follows rather than after it. Status-only
  // events (`usage`, `checkpoint`, `mcp_status`, …) are excluded on purpose —
  // they frequently land in the middle of a reasoning stream (a usage frame
  // arrives between deltas), and closing on them would split one chain of
  // thought into several blocks.
  if (type !== "thinking_delta" && THINKING_INTERRUPTING_TYPES.has(type)) {
    closeThinking(ctx, out);
  }

  switch (type) {
    case "system":
    case "tool_call":
    case "checkpoint":
      break;

    case "user":
      // The renderer already echoed the text when it sent the prompt. The
      // event's timestamp is the turn's opening moment: `turnProgress` measures
      // the elapsed figure from it rather than from a clock of its own.
      ctx.turnStartedAt = eventTime(event) || ctx.turnStartedAt;
      break;

    case "assistant_delta": {
      // The kernel's streaming fragment. The renderer appends it to the open
      // bubble; the complete answer arrives later as an `assistant` event,
      // which replaces the bubble's content.
      const text = textOf(payload.text);
      if (text !== "") {
        ctx.streamedText += text;
        out.push({ type: "assistant_delta", text });
      }
      break;
    }

    case "thinking_delta": {
      // The kernel's reasoning fragment. The renderer needs an explicit block
      // lifecycle, so the first fragment of a segment opens one. The text is
      // shown as it arrives and never mixed into the answer bubble: it is not
      // part of what the model said in reply.
      const text = textOf(payload.text);
      if (text !== "") {
        openThinking(ctx, out);
        out.push({ type: "thinking_text", text });
      }
      break;
    }

    case "assistant": {
      const content = textOf(payload.content);
      out.push({ type: "assistant_start" });
      if (content !== "") {
        // The complete answer already arrived as delta fragments. Only the
        // part that never streamed is missing, so send that; sending the
        // whole text again would double it in the bubble.
        const missing = content.startsWith(ctx.streamedText)
          ? content.slice(ctx.streamedText.length)
          : content;
        if (missing !== "") out.push({ type: "assistant_delta", text: missing });
        ctx.streamedText = "";
        ctx.lastAssistantText = content;
      }
      out.push({ type: "assistant_end" });
      if (Array.isArray(payload.toolCalls)) {
        for (const call of payload.toolCalls) {
          if (!isRecord(call) || typeof call.id !== "string") continue;
          ctx.pendingCalls.set(call.id, {
            name: textOf(call.name),
            arguments: isRecord(call.arguments) ? call.arguments : {},
          });
        }
      }
      break;
    }

    case "tool_started": {
      const callId = textOf(payload.callId);
      const call = ctx.pendingCalls.get(callId);
      const name = toolNameFor(ctx, callId, payload.tool);
      ctx.openTool = name;
      ctx.startedTools.add(callId);
      ctx.runningTools.set(callId, name);
      const message = {
        type: "tool_start",
        name,
        summary: summarizeToolCall(name, call?.arguments),
        id: callId,
      };
      // The kernel marks what a tool does (`readOnly` / `destructive` /
      // `evidence`). Only the true flags travel: a `false` and an absent flag
      // both mean "not marked", and writing them out would make the renderer
      // read an unannotated tool as a complete, all-false annotation.
      const annotations = toolAnnotations(payload.annotations);
      if (annotations !== undefined) message.annotations = annotations;
      out.push(message);
      // The progress line names the call that is executing. Emitted here, at
      // the moment the kernel recorded the start, so the readout cannot drift
      // ahead of what actually ran. A call whose name is unusable contributes
      // nothing: announcing it would blank a name that is still running.
      if (name !== "") {
        const started = turnProgress(ctx, eventTime(event));
        if (started !== null) out.push(started);
      }
      break;
    }

    case "tool_result": {
      const callId = textOf(payload.id);
      const call = ctx.pendingCalls.get(callId);
      const name = toolNameFor(ctx, callId, payload.toolName);
      const ok = payload.ok !== false;
      if (!ctx.startedTools.has(callId)) {
        // A denied call never reaches `tool_started`: authorization is where
        // it stopped. Its `tool_result` still exists, and without a row the
        // transcript would hide exactly the call an operator needs to see.
        ctx.startedTools.add(callId);
        out.push({
          type: "tool_start",
          name,
          summary: summarizeToolCall(name, call?.arguments),
          id: callId,
        });
      }
      const ended = {
        type: "tool_end",
        name,
        ok,
        summary: summarizeToolCall(name, call?.arguments),
        id: callId,
      };
      // `evidence` is the kernel's own verdict on this result, written by the
      // pipeline from the tool's annotation and the result's success. It is
      // carried only when the payload has the field: a log from before the
      // producer existed has none, and "not declared" must not be written out
      // as `false` — the renderer's evidence filter treats only an explicit
      // `true` as evidence, but the export and the row badges must be able to
      // tell the two apart.
      if (typeof payload.evidence === "boolean") ended.evidence = payload.evidence;
      // `detail.hooks` is the kernel's record of the hooks that ran around
      // this call. Only the two outcomes a reader must not miss become a row
      // annotation; everything else is already in the result text (a post
      // hook's stdout is appended there). Absent detail means no hooks ran,
      // so the message stays byte-for-byte what it was before hooks existed.
      const hookNote = summarizeHookDetail(payload.detail);
      if (hookNote !== undefined) ended.hookNote = hookNote;
      out.push(ended);
      if (ok) {
        const content = truncateUtf8(textOf(payload.text), MAX_TOOL_OUTPUT_BYTES);
        // The id lets the renderer hang the output under the row that
        // produced it. Read-only calls run concurrently and their results can
        // land in any order; without it the output (and the evidence wrapper
        // the transcript filter keys on) would attach to whichever row
        // finished last.
        const output = { type: "tool_output", name, content, id: callId };
        // The kernel writes the artifact file for oversized output; the text
        // is a summary. Passing the path through gives the renderer something
        // to open instead of only something to read.
        if (typeof payload.artifactPath === "string" && payload.artifactPath !== "") {
          output.artifactPath = payload.artifactPath;
        }
        if (content !== "" || output.artifactPath !== undefined) out.push(output);
      }
      ctx.pendingCalls.delete(callId);
      const wasRunning = ctx.runningTools.delete(callId);
      if (ctx.openTool === name) ctx.openTool = "";
      // Only a call that had been announced leaves a progress line to update:
      // one that never started (a denial) announced no tool, so there is
      // nothing to correct. A call that did start now leaves the line naming
      // whatever is still running, or empty when nothing is — the renderer
      // keeps drawing the last named tool otherwise, and the line would still
      // say `grep` while the model writes its answer.
      if (wasRunning) {
        const remaining = turnProgress(ctx, eventTime(event));
        if (remaining !== null) out.push(remaining);
      }
      break;
    }

    case "approval_request": {
      const tool = textOf(payload.tool);
      const reason = textOf(payload.reason);
      const requestId = textOf(payload.requestId);
      ctx.pendingApprovals.add(requestId);
      out.push({
        type: "permission_request",
        id: requestId,
        question: reason === "" ? tool : `${tool}: ${reason}`,
        detail: {
          tool,
          preset: textOf(payload.preset),
          paramsPreview: isRecord(payload.paramsPreview) ? payload.paramsPreview : {},
          deadlineAt: textOf(payload.deadlineAt),
        },
      });
      break;
    }

    case "permission_decision": {
      // The decision can arrive without a click: the kernel denies when the
      // approval deadline passes. The bar must come down either way, or the
      // next click answers a request that no longer exists.
      const requestId = textOf(payload.requestId);
      if (requestId !== "" && ctx.pendingApprovals.delete(requestId)) {
        out.push({ type: "permission_closed", id: requestId });
      }
      if (payload.effective === "deny") {
        const tool = textOf(payload.tool);
        const reason = permissionReasonText(payload.reason);
        out.push({
          type: "notice",
          level: "warn",
          text: reason === "" ? `已拒绝 ${tool}` : `已拒绝 ${tool}：${reason}`,
        });
      }
      break;
    }

    case "todos": {
      // The plan card is interface state, not a message: it is drawn beside
      // the transcript and never becomes a bubble. `null` (an untranslatable
      // payload) produces nothing rather than a blank card.
      const todos = todosEvent(payload);
      if (todos !== null) out.push(todos);
      break;
    }

    case "background_result": {
      // A background terminal job finished. The renderer has no job panel, so
      // this is one transcript notice — but it must be one: the whole point of
      // running the command in the background is that its ending arrives
      // without anybody asking.
      const summary = summarizeBackgroundResult(payload);
      if (summary !== null) out.push(summary);
      break;
    }

    case "subagent_result": {
      // A subagent reached its terminal state. Same shape as
      // `background_result` above and for the same reason: the turn that
      // started it may already be over, so its ending has to arrive without
      // anybody asking. One transcript line — the renderer has no subagent
      // view, and the full conclusion is in the child session (`subagent_check`
      // reads it back).
      const summary = summarizeSubagentResult(payload);
      if (summary !== null) {
        // The strip above the composer counts running runs, so the same event
        // has to say which one stopped. The id rides on the notice rather than
        // becoming a second event: one kernel event stays one renderer
        // message ("only one notice, no card" — the rule that kept this from
        // being a panel), and the strip reads the field. Only written when the
        // payload has an id, so a log from before this field existed produces
        // exactly the message it always did.
        const id = textOf(payload.id);
        if (id !== "") summary.subagentId = id;
        out.push(summary);
      }
      break;
    }

    case "subagent_started": {
      // A subagent began. This produces interface state, not a transcript row:
      // the renderer's strip above the composer counts it and stops counting
      // when the matching `subagent_result` arrives. Nothing is drawn in the
      // transcript here — a start line plus an end line would be two rows for
      // one dispatch, and the tool row that launched it is already there.
      const started = subagentStartedEvent(payload);
      if (started !== null) out.push(started);
      break;
    }

    case "device_status": {
      // The probe MCP reports `{ backend, probe, cpu, serial }` and nothing
      // else — it does not know about targets, ports or the workspace scan.
      // It used to be folded into a `board_state`, which the Board pane then
      // misread; that pane is gone (2026-10-26) and the kernel event is passed
      // through under its own name so no shape is invented for it.
      const device = isRecord(payload.state) ? payload.state : {};
      out.push({
        type: "device_status",
        device,
        server: textOf(payload.server),
        tool: textOf(payload.tool),
        updatedAt: textOf(event.ts),
      });
      break;
    }

    case "mcp_status": {
      const kind = textOf(payload.kind);
      const server = textOf(payload.server);
      const message = textOf(payload.message);
      const level = kind === "connected" || kind === "tools_changed" ? "dim" : "warn";
      const label = server === "" ? kind : `${server}: ${kind}`;
      out.push({
        type: "notice",
        level,
        text: message === "" ? `MCP ${label}` : `MCP ${label} — ${message}`,
      });
      break;
    }

    case "usage": {
      const usage = {
        inputTokens: Number(payload.promptTokens) || 0,
        outputTokens: Number(payload.completionTokens) || 0,
        cachedTokens: Number(payload.cachedTokens) || 0,
      };
      const message = { type: "usage", usage };
      // Occupancy and spend are optional: an older log has neither, and a
      // provider without a price never produces a cost. Absent fields stay
      // absent so the renderer can tell "unknown" from zero.
      if (isRecord(payload.context)) {
        message.context = {
          tokens: Number(payload.context.tokens) || 0,
          percent: Number(payload.context.percent) || 0,
          window: Number(payload.context.window) || 0,
        };
      }
      if (typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd)) {
        message.costUsd = payload.costUsd;
      }
      // The per-category split is attached only when the payload carries the
      // field at all. An older log has none, and that absence is the file's
      // standing convention for "this event says nothing about it" — writing
      // `null` there would claim the kernel reported "no split". When the
      // field is present, the validated result travels as-is, `null` included:
      // a present-but-unusable split is an answer, just not a drawable one.
      if (isRecord(payload.contextBreakdown)) {
        message.contextBreakdown = measuredBreakdown(payload.contextBreakdown);
      }
      out.push(message);
      break;
    }

    case "status": {
      const status = textOf(payload.status);
      if (status === "done") {
        // `finishReason: "truncated"` 是一次**正常结束**（不是 interrupted），
        // 但内容确实没写完：不说一句就等于把截断伪装成完整回答（R3）。
        if (textOf(payload.finishReason) === "truncated") {
          out.push({ type: "notice", level: "warn", text: "连续输出被截断，已停止续写；回答可能不完整" });
        }
        ctx.running = false;
        out.push({ type: "run_end" });
      } else if (status === "usage_missing") {
        out.push({ type: "notice", level: "dim", text: "本轮未返回用量统计" });
      } else if (status === "cost_cap_untracked") {
        // 设了上限却没配价格：上限永远不会触发。warn 而不是 dim——这是一条
        // 「你以为的保护不存在」，不是普通的缺数据。
        out.push({
          type: "notice",
          level: "warn",
          text: "已设置成本上限，但该模型没有配置每百万 token 价格，上限不会生效",
        });
      } else if (status === "device_status_invalid") {
        out.push({
          type: "notice",
          level: "warn",
          text: `设备状态无效（${textOf(payload.tool)}）: ${textOf(payload.message)}`,
        });
      } else if (status === "permissions_project_config_skipped") {
        out.push({
          type: "notice",
          level: "warn",
          text: `项目权限配置未加载: ${textOf(payload.message)}`,
        });
      } else if (status === "hooks_config_failed") {
        // The kernel carries `HookConfigError.message`, which names the file
        // and the offending entry (`hooks[0].macher`). Passing it through is
        // the point: "钩子配置坏了" without the path leaves the reader with
        // two candidate files and no idea which one to fix. The run continues
        // — hooks are hardening, not a precondition — so this is a warning
        // about a missing safety net rather than a failure of the turn.
        out.push({
          type: "notice",
          level: "warn",
          text: `钩子配置读取失败，本次调用没有钩子在跑: ${textOf(payload.message)}`,
        });
      } else if (status === "hooks_project_config_skipped") {
        // Untrusted, not broken. Saying "failed" here would send the reader to
        // look for a syntax error in a file that is perfectly valid and simply
        // has not been trusted; the two need different next steps.
        out.push({
          type: "notice",
          level: "warn",
          text:
            `项目钩子配置未加载（未信任该工作区）: ${textOf(payload.message)}` +
            `——信任后才会读取 .harness/hooks.json`,
        });
      }
      break;
    }

    case "interrupted": {
      const reason = textOf(payload.reason);
      // 每个 reason 说清楚是哪一类停止：兜底的「运行中断」在排障时什么也告诉
      // 不了人，而这三类恰好各有明确的下一步（调超时 / 换网关 / 减小输入）。
      const label =
        reason === "aborted"
          ? "已中止"
          : reason === "max_turns"
            ? "达到最大回合数"
            : reason === "max_cost_usd"
              ? "达到成本上限"
              : reason === "consumer_closed"
                ? "客户端断开"
                : reason === "start_failed"
                  ? "启动失败"
                  : reason === "deadline"
                    ? "达到整跑时长上限"
                    : reason === "context_overflow"
                      ? "上下文超出服务端窗口，压缩一次后仍超限"
                      // 截断不走 interrupted（它是正常结束），所以这里**没有**
                      // `truncated` 分支：那会是一个没有生产者的 handler。
                      // 截断的提示在下面 `status:done` 的 finishReason 分支里。
                      : "运行中断";
      out.push({ type: "notice", level: "warn", text: label });
      ctx.running = false;
      out.push({ type: "run_end" });
      break;
    }

    case "compaction": {
      const kind = textOf(payload.kind);
      if (kind === "microcompact") {
        const removed = Array.isArray(payload.elidedSeqs) ? payload.elidedSeqs.length : 0;
        out.push({ type: "compacted", removed, level: "micro", before: 0, after: 0 });
      } else if (kind === "summary") {
        // `coversUpToSeq` is a sequence number, not a token count. The kernel
        // reports no token figures for a summary compaction, so `before`/`after`
        // stay 0 and the renderer omits the title rather than printing a number
        // that means nothing (the old code added 1 and passed it off as tokens).
        out.push({
          type: "compacted",
          removed: 0,
          level: "summary",
          before: 0,
          after: 0,
          coversUpToSeq: Number(payload.coversUpToSeq) || 0,
        });
      } else if (kind === "failed") {
        // `/compact` now always runs. On a session with nothing new to fold in,
        // the kernel answers `failed` for two reasons that are not failures:
        // the last summary already covers this far (`no_progress`), or there is
        // no user/assistant/tool turn to summarize at all. Reporting either as
        // a red "压缩失败" would be a false alarm on a perfectly healthy small
        // session — they are said quietly, and only a real error stays `warn`.
        const reason = textOf(payload.reason);
        if (reason === "no_progress") {
          out.push({ type: "notice", level: "dim", text: "压缩没有进展（上一次摘要已经覆盖到这里）" });
        } else if (reason === "no summarizable content") {
          out.push({ type: "notice", level: "dim", text: "没有可压缩的内容" });
        } else {
          out.push({
            type: "notice",
            level: "warn",
            text: `压缩失败（${textOf(payload.stage)}）: ${reason}`,
          });
        }
      }
      break;
    }
  }
  return out;
}

/**
 * The `state` event both adapters send on boot and after a config change.
 *
 * `models` uses the renderer's picker shape. The kernel resolves model
 * references as `provider/model`, so both halves are needed to build one.
 */
export function initialState(options = {}) {
  const models = Array.isArray(options.models) ? options.models : [];
  const state = {
    type: "state",
    sessionId: textOf(options.sessionId),
    cwd: textOf(options.cwd),
    locale: options.locale === "en" ? "en" : "zh",
    mode: textOf(options.mode) || "diagnose",
    effort: "auto",
    effortChoices: { levels: [], default: "", fixed: "" },
    sandbox: "enforce",
    networkPolicy: "off",
    model: textOf(options.model),
    models,
    modelsSource: textOf(options.modelsSource) || "providers.json",
    baseUrl: textOf(options.baseUrl),
    // Occupancy is unknown until a `usage` event measured it. `null` is the
    // renderer's explicit "unknown" sentinel: a zeroed record here would paint
    // "0%" for a session whose fill nobody has measured (R3).
    context: measuredContext(options.context),
    // The kernel now measures a per-category split alongside the total
    // (`src/context/breakdown.ts`); this passes one through when a caller has
    // it. Without one the popover draws the total only — a split invented from
    // the total would be a fabricated chart.
    contextBreakdown: measuredBreakdown(options.contextBreakdown),
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    serial: { open: false, port: null, baud: null, buffered: 0, queued: 0 },
  };
  // Spend only when the caller has a real figure. A zero here would read as
  // "known to be free" and blank the meter's honest unknown.
  if (typeof options.costUsd === "number" && Number.isFinite(options.costUsd)) {
    state.costUsd = options.costUsd;
  }
  return state;
}

/**
 * Split a `providers.json` file into the two shapes the renderer consumes.
 *
 * They are not interchangeable and both are needed:
 *
 *   - `providers` is the picker's flat list — one row per provider with the
 *     URL it points at, which is all the model chip and its menu need;
 *   - `providerConfig` is the file itself, which the settings page edits and
 *     saves back whole.
 *
 * A host that sends only the first leaves the settings page with nothing to
 * draw: it cannot write back an object it never received, and an empty form
 * saved in that state would replace the file with `{}`.
 */
export function providersEvent(config) {
  if (!isRecord(config)) return { providers: [], providerConfig: undefined };
  const providers = Object.entries(config).map(([name, provider]) => ({
    id: name,
    baseUrl: isRecord(provider) ? textOf(provider.baseUrl) : "",
  }));
  return { providers, providerConfig: config };
}

/**
 * Every `provider/model` reference in a `providers.json`, in the picker's shape.
 *
 * The kernel resolves references as `provider/model`, so a provider with no
 * models contributes nothing: a row that no run could use would be a promise
 * the file cannot keep.
 */
export function modelsOf(config) {
  if (!isRecord(config)) return [];
  const models = [];
  for (const [providerName, provider] of Object.entries(config)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [modelName, model] of Object.entries(provider.models)) {
      models.push({
        id: `${providerName}/${modelName}`,
        name: modelName,
        contextLength: isRecord(model) ? model.contextWindow : undefined,
        // The kernel's only adapter speaks OpenAI chat completions, which
        // carries tool calls; no reasoning or vision parameters are sent.
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
      });
    }
  }
  return models;
}

/**
 * `sessions` event from the kernel's session summaries.
 *
 * The renderer groups by `cwd` and sorts nothing itself, so `workdir` is
 * mapped to `cwd` and a missing summary falls back to the session id. The
 * kernel keeps `createdAt` only; `updatedAt` reuses it, which is what the
 * list sorts and displays.
 */
export function sessionsEvent(summaries) {
  const list = Array.isArray(summaries) ? summaries : [];
  const sessions = list.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    const id = textOf(record.id);
    const cwd = textOf(record.workdir);
    const createdAt = textOf(record.createdAt);
    // The host derives a title from the first user event and passes it here;
    // without one the row still needs a non-empty string because the renderer
    // lowercases it. An empty title is meaningful — it means "not readable
    // yet", which the renderer draws as "no messages" rather than as an id.
    const title = textOf(record.title);
    const summary = textOf(record.summary);
    return {
      id,
      cwd,
      model: textOf(record.model),
      createdAt,
      updatedAt: textOf(record.updatedAt) || createdAt,
      title,
      summary: summary === "" ? (title === "" ? id : title) : summary,
      pinned: record.pinned === true,
      archived: record.archived === true,
      status: "ready",
    };
  });
  return { type: "sessions", sessions, total: sessions.length, all: sessions.length, limit: sessions.length };
}

/**
 * Session-level token totals from a full log.
 *
 * `usage` events are written once per model call; the popover labels its
 * figures "this session", so the sum is the number it means.
 */
export function usageTotals(events) {
  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  if (!Array.isArray(events)) return totals;
  for (const event of events) {
    if (!isRecord(event) || event.type !== "usage") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    totals.inputTokens += Number(payload.promptTokens) || 0;
    totals.outputTokens += Number(payload.completionTokens) || 0;
    totals.cachedTokens += Number(payload.cachedTokens) || 0;
  }
  return totals;
}

/**
 * Session spend from a full log, or `undefined` when no call priced it.
 *
 * `costUsd` on a usage event is the running total for the session, not this
 * call's share, so the last one that carries it is the answer. Undefined is
 * kept distinct from 0: a provider with no price has not told us the spend.
 */
export function sessionCostUsd(events) {
  if (!Array.isArray(events)) return undefined;
  let cost;
  for (const event of events) {
    if (!isRecord(event) || event.type !== "usage") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd)) {
      cost = payload.costUsd;
    }
  }
  return cost;
}

/**
 * The plan a session ended on, or `null` when it never had one.
 *
 * Scans for the last `todos` event whose payload translates. An event that
 * does not translate is not an instruction to clear the plan — it is a log
 * line this module cannot read — so it is skipped instead of erasing the
 * plan the session honestly had before it. A translated empty list *is*
 * kept: that is the model clearing its own plan.
 */
function latestTodos(events) {
  if (!Array.isArray(events)) return null;
  let latest = null;
  for (const event of events) {
    if (!isRecord(event) || event.type !== "todos") continue;
    const translated = todosEvent(isRecord(event.payload) ? event.payload : {});
    if (translated !== null) latest = translated.items;
  }
  return latest;
}

/**
 * The last seq in a log, or -1 for a log that has none.
 *
 * The kernel appends in order, so the tail is the end; a file whose last line
 * was cut mid-write has already been dropped by the reader before it gets
 * here. `-1` is not a position — it is "this log has no events to replay",
 * which is why an `atSeq` of any value is out of range for an empty session.
 */
function lastSeqOf(events) {
  if (!Array.isArray(events) || events.length === 0) return -1;
  const seq = events.at(-1)?.seq;
  return Number.isInteger(seq) ? seq : -1;
}

/**
 * `session_loaded` event for a freshly opened or created conversation.
 *
 * `atSeq` replays the conversation only up to that event (BR-6). This is the
 * single truncation point: the bubbles, the plan and the usage totals are all
 * projected from the same prefix, so a replayed position cannot show a plan
 * the replay has not reached or a cost it has not spent.
 *
 * An `atSeq` outside `0..lastSeq` **throws** rather than clamping. The reason
 * is the same one `forkSession` has: a silently clamped index makes "replay to
 * event 3" look exactly like "replay to the end", which is the one thing the
 * reader would use this control to tell apart. The host turns the error into a
 * warning; the caller learns the legal range from the message.
 *
 * A cut in the middle of a tool call is legal and needs no special case:
 * `sessionEventsToMessages` emits a tool row when the `tool_result` arrives,
 * so a prefix that has the call's announcement and not its result produces the
 * assistant text and no row — never half a call.
 */
export function sessionLoadedEvent(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const lastSeq = lastSeqOf(list);
  let view = list;
  let atSeq;
  if (options.atSeq !== undefined) {
    atSeq = options.atSeq;
    if (!Number.isInteger(atSeq) || atSeq < 0 || atSeq > lastSeq) {
      throw new Error(
        `atSeq 必须是 0..${lastSeq} 之间的整数（收到 ${JSON.stringify(atSeq)}）`,
      );
    }
    // A position at the end of the log is not a cut; filtering there would
    // only rebuild the same array. It is still echoed below, so "the caller
    // asked for position N" stays a fact of the event rather than something
    // the reader has to infer from two fields agreeing.
    if (atSeq < lastSeq) {
      // An event without a numeric `seq` has no position in the log, so no
      // `atSeq` can include it. The kernel always writes one; this only keeps
      // a malformed line from being replayed as if it belonged to the prefix.
      view = list.filter((event) => isRecord(event) && Number.isInteger(event.seq) && event.seq <= atSeq);
    }
  }
  const costUsd = sessionCostUsd(view);
  return {
    type: "session_loaded",
    messages: sessionEventsToMessages(view),
    // The plan card is rebuilt from this, not from `messages`:
    // `sessionEventsToMessages` only produces chat bubbles, and the plan is
    // interface state the transcript replay never contained. The last
    // translatable `todos` is the answer because that is where the work
    // stopped; a malformed one is skipped rather than erasing a plan the
    // session really had. `null` means this session never carried one.
    todos: latestTodos(view),
    cwd: textOf(options.cwd),
    mode: textOf(options.mode) || "diagnose",
    effort: "auto",
    usage: usageTotals(view),
    ...(costUsd === undefined ? {} : { costUsd }),
    // The two fields of a truncated projection, together and only when one was
    // asked for. `atSeq` is the position that was projected; `lastSeq` is how
    // far the log goes, so the caller can draw "第 N / M 条" from the same
    // prefix it was handed instead of reading the log again for its maximum.
    // A whole-log event says neither: its reader is not scrubbing, and a
    // second spelling of "the log ends here" would have to agree with the
    // host's own cursor forever.
    ...(atSeq === undefined ? {} : { atSeq, lastSeq }),
  };
}

/**
 * Render a session log as Markdown.
 *
 * Export reads the log rather than the DOM: the transcript on screen may be
 * scrolled, collapsed or partly rebuilt, while the log is the record. Tool
 * results are quoted and capped so an export of a long session stays a
 * document rather than a dump of stack traces.
 */
export function sessionMarkdown(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const title = textOf(options.title);
  const lines = [`# ${title === "" ? "Conversation" : title}`, ""];
  const outputLimit = 2000;
  for (const event of list) {
    if (!isRecord(event)) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    switch (event.type) {
      case "user": {
        const content = textOf(payload.content).trim();
        if (content !== "") lines.push("## User", "", content, "");
        break;
      }
      case "assistant": {
        const content = textOf(payload.content).trim();
        const calls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
        if (content !== "") lines.push("## Assistant", "", content, "");
        for (const call of calls) {
          if (!isRecord(call)) continue;
          const args = isRecord(call.arguments) ? JSON.stringify(call.arguments) : "";
          lines.push(`- \`${textOf(call.name)}\` ${args}`.trimEnd());
        }
        if (calls.length > 0) lines.push("");
        break;
      }
      case "tool_result": {
        const text = textOf(payload.text).trim();
        const name = textOf(payload.toolName);
        const heading = `### ${name === "" ? "tool" : name} ${payload.ok === false ? "(failed)" : ""}`.trimEnd();
        // Evidence is the product's central claim about a result, and an
        // export is where a diagnosis is read by someone who was not watching
        // the screen. The marker goes on the heading, so it survives even
        // when the output itself was capped. Only an explicit `true` is
        // marked: an old log without the field says nothing about evidence,
        // and a `[evidence]` tag there would be this layer's verdict, not the
        // kernel's.
        lines.push(payload.evidence === true ? `${heading} [evidence]` : heading);
        if (text !== "") {
          const capped =
            text.length > outputLimit ? `${text.slice(0, outputLimit)}\n…[truncated]` : text;
          lines.push("```", capped, "```");
        }
        const artifact = textOf(payload.artifactPath);
        if (artifact !== "") lines.push(`Artifact: \`${artifact}\``);
        lines.push("");
        break;
      }
      case "interrupted": {
        lines.push(`> Interrupted: ${textOf(payload.reason) || "unknown"}`, "");
        break;
      }
      default:
        break;
    }
  }
  return lines.join("\n");
}

/** A filesystem-safe export name derived from the session or its title. */
export function sessionExportName(sessionId, title) {
  const base = textOf(title).trim() || textOf(sessionId) || "session";
  const safe = base.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
  return `${safe.slice(0, 60) || "session"}.md`;
}
