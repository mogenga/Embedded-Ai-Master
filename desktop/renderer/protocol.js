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
  };
}

function toolNameFor(ctx, callId, fallback) {
  const call = ctx.pendingCalls.get(callId);
  return call?.name ?? textOf(fallback);
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

    case "assistant": {
      const content = textOf(payload.content);
      out.push({ type: "assistant_start" });
      if (content !== "") {
        out.push({ type: "assistant_delta", text: content });
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
      out.push({
        type: "tool_start",
        name,
        summary: summarizeToolCall(name, call?.arguments),
        id: callId,
      });
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
        if (content !== "") out.push({ type: "tool_output", name, content });
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
        const reason = textOf(payload.reason);
        out.push({
          type: "notice",
          level: "warn",
          text: reason === "" ? `已拒绝 ${tool}` : `已拒绝 ${tool}: ${reason}`,
        });
      }
      break;
    }

    case "device_status": {
      // The board chip reads `state.selection` / `state.projectKind`; the probe
      // MCP reports its own `state`, so it is passed through as-is.
      const device = isRecord(payload.state) ? payload.state : {};
      out.push({
        type: "board_state",
        state: {
          selection: {},
          projectKind: "unknown",
          device,
          tool: textOf(payload.tool),
          updatedAt: textOf(event.ts),
        },
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
      out.push({ type: "usage", usage });
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
        out.push({
          type: "compacted",
          removed: 0,
          level: "summary",
          before: Number(payload.coversUpToSeq) + 1 || 0,
          after: 0,
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
  return {
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

/** `session_loaded` event for a freshly opened or created conversation. */
export function sessionLoadedEvent(events, options = {}) {
  return {
    type: "session_loaded",
    messages: sessionEventsToMessages(events),
    cwd: textOf(options.cwd),
    mode: textOf(options.mode) || "diagnose",
    effort: "auto",
  };
}

/** Where the renderer remembers the last conversation, mirroring its boot code. */
export const LAST_SESSION_STORAGE_KEY = LAST_SESSION_KEY;
