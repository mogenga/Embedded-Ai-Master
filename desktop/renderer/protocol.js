/**
 * Kernel session events → Prometheus host events.
 *
 * Pure functions shared by the desktop host (Node) and the browser bridge
 * (renderer). Nothing here touches the DOM, the filesystem, or the network:
 * both adapters feed it `SessionEvent` objects from the kernel log and get
 * back the `{ type }` messages the ported renderer already knows how to draw.
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
]);

/** Tool output larger than this is truncated before it reaches the DOM. */
export const MAX_TOOL_OUTPUT_BYTES = 8 * 1024;

/** Matches the renderer's own preference key for the active conversation. */
const LAST_SESSION_KEY = "prometheus.lastSession";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value) {
  return typeof value === "string" ? value : "";
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
 * Mirrors the Prometheus host's `summarizeCall`: prefer the argument that
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
 */
export function sessionEventsToMessages(events) {
  const out = [];
  if (!Array.isArray(events)) return out;

  /** callId → { name, arguments } for the assistant event that spawned it. */
  const calls = new Map();
  let index = 0;
  for (const event of events) {
    if (!isRecord(event)) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
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
      out.push({
        role: "tool",
        name: call?.name ?? textOf(payload.toolName),
        summary: summarizeToolCall(call?.name, call?.arguments),
        ok: payload.ok !== false,
        done: true,
      });
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
  };
}

function toolNameFor(ctx, callId, fallback) {
  const call = ctx.pendingCalls.get(callId);
  return call?.name ?? textOf(fallback);
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

  switch (type) {
    case "system":
    case "tool_call":
    case "checkpoint":
      break;

    case "user":
      // The renderer already echoed the text when it sent the prompt.
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
      out.push({
        type: "tool_end",
        name,
        ok,
        summary: summarizeToolCall(name, call?.arguments),
        id: callId,
      });
      if (ok) {
        const content = truncateUtf8(textOf(payload.text), MAX_TOOL_OUTPUT_BYTES);
        const output = { type: "tool_output", name, content };
        // The kernel writes the artifact file for oversized output; the text
        // is a summary. Passing the path through gives the renderer something
        // to open instead of only something to read.
        if (typeof payload.artifactPath === "string" && payload.artifactPath !== "") {
          output.artifactPath = payload.artifactPath;
        }
        if (content !== "" || output.artifactPath !== undefined) out.push(output);
      }
      ctx.pendingCalls.delete(callId);
      if (ctx.openTool === name) ctx.openTool = "";
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

    case "device_status": {
      // The probe MCP reports `{ backend, probe, cpu, serial }` and nothing
      // else — it does not know about targets, ports or the workspace scan.
      // Passing it through as a whole `board_state` replaced the board pane's
      // state with an object none of its fields exist on, so the pane fell back
      // to "scanning…" and the chip stayed hidden. The device fields travel
      // under their own key instead; the renderer draws them as their own
      // section.
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
      out.push(message);
      break;
    }

    case "status": {
      const status = textOf(payload.status);
      if (status === "done") {
        ctx.running = false;
        out.push({ type: "run_end" });
      } else if (status === "usage_missing") {
        out.push({ type: "notice", level: "dim", text: "本轮未返回用量统计" });
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
      }
      break;
    }

    case "interrupted": {
      const reason = textOf(payload.reason);
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
        out.push({
          type: "notice",
          level: "warn",
          text: `压缩失败（${textOf(payload.stage)}）: ${textOf(payload.reason)}`,
        });
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
    context: { tokens: 0, percent: 0 },
    contextBreakdown: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    board: { selection: {}, projectKind: "unknown" },
    serial: { open: false, port: null, baud: null, buffered: 0, queued: 0 },
  };
  // Spend and occupancy only when the caller has a real figure. A zero here
  // would read as "known to be free" and blank the meter's honest unknown.
  if (isRecord(options.context)) {
    state.context = {
      tokens: Number(options.context.tokens) || 0,
      percent: Number(options.context.percent) || 0,
      ...(Number(options.context.window) ? { window: Number(options.context.window) } : {}),
    };
  }
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
    // A caller that already derived a title (the browser bridge reads it from
    // the first user event) passes it as `title`; without one the row still
    // needs a non-empty string because the renderer lowercases it.
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

/** `session_loaded` event for a freshly opened or created conversation. */
export function sessionLoadedEvent(events, options = {}) {
  const costUsd = sessionCostUsd(events);
  return {
    type: "session_loaded",
    messages: sessionEventsToMessages(events),
    cwd: textOf(options.cwd),
    mode: textOf(options.mode) || "diagnose",
    effort: "auto",
    usage: usageTotals(events),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/** Where the renderer remembers the last conversation, mirroring its boot code. */
export const LAST_SESSION_STORAGE_KEY = LAST_SESSION_KEY;

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
        lines.push(`### ${name === "" ? "tool" : name} ${payload.ok === false ? "(failed)" : ""}`.trimEnd());
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
