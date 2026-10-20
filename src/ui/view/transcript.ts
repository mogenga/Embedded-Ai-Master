import type { LoopEvent } from "../../loop/events.js";
import type { SessionEvent, ToolResultPayload } from "../../session/types.js";
import type { ToolAnnotations } from "../../tools/types.js";

export type TranscriptStepId = "symptom" | "triage" | "kb" | "probe" | "verdict";

export interface TranscriptStep {
  id: TranscriptStepId;
  label: string;
  state: "done" | "now" | "todo";
}

export interface ReadoutRow {
  label: string;
  value: string;
  note?: string;
}

export interface HitRow {
  path: string;
  desc: string;
  score: string;
  channel: number;
}

export interface EvidenceRow {
  name: string;
  code: string;
  value: string;
  verdict: "bad" | "warn" | "ok";
  label: string;
}

export type ToolKind = "readout" | "hitlist" | "evidence" | "error";

export type ToolRunState = "queued" | "running" | "done" | "failed";

export interface ToolCardModel {
  id: string;
  name: string;
  args: string;
  ok: boolean;
  state: ToolRunState;
  kind: ToolKind;
  ms?: number;
  readout?: ReadoutRow[];
  hits?: HitRow[];
  evidence?: EvidenceRow[];
  text?: string;
  artifactPath?: string;

  errorCode?: string;
  errorText?: string;
  readOnly?: boolean;
  destructive?: boolean;
}

export interface VerdictModel {
  rootCause: string;
  evidence: EvidenceRow[];
  prediction: string;
  ownership: Array<{ t: "agent" | "user" | "manual"; title: string; desc: string }>;
  confidence: "高" | "中" | "低";
}

export interface GuardModel {
  action: string;
  address: string;
  value: string;
  state: "待确认" | "已拒绝" | "已执行";
}

export interface PermissionModel {
  callId: string;
  tool: string;
  action: "allow" | "ask" | "deny";
  effective: "allow" | "deny";
  reason: string;
}

export interface ApprovalModel {
  requestId: string;
  callId: string;
  tool: string;
  reason: string;
  preset: string;
  paramsPreviewText?: string;
  deadlineAt?: string;
  status: "pending" | "allowed" | "denied" | "expired" | "aborted";
}

export type TranscriptEvent =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "ask"; text: string; note?: string }
  | { id: string; kind: "tool"; tool: ToolCardModel }
  | { id: string; kind: "verdict"; verdict: VerdictModel }
  | { id: string; kind: "guard"; guard: GuardModel }
  | { id: string; kind: "permission"; permission: PermissionModel }
  | { id: string; kind: "approval"; approval: ApprovalModel }
  | { id: string; kind: "interrupted"; reason: string };

export interface TranscriptView {
  steps: TranscriptStep[];
  status: "idle" | "diagnosing" | "done" | "interrupted";
  events: readonly TranscriptEvent[];
  usage?: { prompt: number; completion: number; cached: number; costUsd?: number };
  context?: { used: number; limit: number };
  cost?: number;
  sessionId?: string;
  interruptReason?: string;
}

const ASK_PREFIX = "第 0 步分流";

const STEP_LABELS: ReadonlyArray<{ id: TranscriptStepId; label: string }> = [
  { id: "symptom", label: "报症状" },
  { id: "triage", label: "分流提问" },
  { id: "kb", label: "检索 KB" },
  { id: "probe", label: "探针取证" },
  { id: "verdict", label: "根因判决" },
];

const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  kb_lookup: { readOnly: true, evidence: true },
  mem_read: { readOnly: true, evidence: true },
  serial_read: { readOnly: true, evidence: true },
  reg_read: { readOnly: true, evidence: true },
  mem_write: { destructive: true },
  serial_write: { destructive: true },
  reset: { destructive: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asCost(value: unknown): number | undefined {
  const parsed = asNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function defaultKind(name: string): ToolKind {
  if (name.startsWith("kb_")) return "hitlist";
  if (name.startsWith("mem_") || name.startsWith("serial_") || name.startsWith("reg_")) return "evidence";
  return "readout";
}

function formatArgs(args: unknown): string {
  if (isRecord(args) && args.error === "invalid_json" && typeof args.raw === "string") return args.raw;
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return String(args);
  }
}

function createToolCard(id: string, name: string, args: unknown): ToolCardModel {
  const annotations = TOOL_ANNOTATIONS[name];
  return {
    id,
    name,
    args: formatArgs(args),
    ok: true,
    state: "queued",

    kind: defaultKind(name),
    readOnly: annotations?.readOnly === true,
    destructive: annotations?.destructive === true,
  };
}

function readoutRows(detail: Record<string, unknown>): ReadoutRow[] | undefined {
  const raw = detail.readout ?? detail.fields;
  const rows: ReadoutRow[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const label = asString(item.label) ?? asString(item.name);
      if (label === undefined || item.value === undefined) continue;
      const note = asString(item.note);
      rows.push(note === undefined ? { label, value: String(item.value) } : { label, value: String(item.value), note });
    }
  } else if (isRecord(raw)) {
    for (const [label, value] of Object.entries(raw)) {
      rows.push({ label, value: String(value) });
    }
  }
  return rows.length > 0 ? rows : undefined;
}

function hitRows(detail: Record<string, unknown>): HitRow[] | undefined {
  if (!Array.isArray(detail.hits)) return undefined;
  const rows: HitRow[] = [];
  for (const item of detail.hits) {
    if (!isRecord(item)) continue;
    const path = asString(item.path);
    if (path === undefined) continue;
    rows.push({
      path,
      desc: asString(item.desc) ?? "",
      score: item.score === undefined ? "" : String(item.score),
      channel: asNumber(item.channel) ?? 0,
    });
  }
  return rows.length > 0 ? rows : undefined;
}

function evidenceRows(raw: unknown): EvidenceRow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: EvidenceRow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = asString(item.name);
    if (name === undefined) continue;
    rows.push({
      name,
      code: asString(item.code) ?? "",
      value: item.value === undefined ? "" : String(item.value),
      verdict: item.verdict === "bad" || item.verdict === "warn" ? item.verdict : "ok",
      label: asString(item.label) ?? "",
    });
  }
  return rows.length > 0 ? rows : undefined;
}

function applyToolResult(card: ToolCardModel, payload: ToolResultPayload): void {
  card.ok = payload.ok;
  card.state = payload.ok ? "done" : "failed";

  if (payload.artifactPath !== undefined) card.artifactPath = payload.artifactPath;
  const detail = isRecord(payload.detail) ? payload.detail : undefined;
  if (detail !== undefined) {
    const ms = asNumber(detail.ms);
    if (ms !== undefined) card.ms = ms;
    const readout = readoutRows(detail);
    const hits = hitRows(detail);
    const evidence = evidenceRows(detail.evidence ?? detail.rows);
    if (readout !== undefined) card.readout = readout;
    if (hits !== undefined) card.hits = hits;
    if (evidence !== undefined) card.evidence = evidence;
  }
  if (!payload.ok) {
    card.kind = "error";
    if (payload.code !== undefined) card.errorCode = payload.code;
    card.errorText = payload.text;
    return;
  }
  if (card.readout !== undefined) {
    card.kind = "readout";
    return;
  }
  if (card.hits !== undefined) {
    card.kind = "hitlist";
    return;
  }
  if (card.evidence !== undefined) {
    card.kind = "evidence";
    return;
  }
  if (payload.text.length > 0) {
    card.kind = "readout";
    card.text = payload.text;
    return;
  }
  if (card.artifactPath !== undefined && card.artifactPath.length > 0) {
    card.kind = "readout";
    card.text = "";
    return;
  }
  card.kind = "error";
  card.errorCode = "empty_result";
  card.errorText = "工具未返回读数";
}

function toToolResultPayload(payload: Record<string, unknown>): ToolResultPayload {
  const result: ToolResultPayload = {
    id: asString(payload.id) ?? "",
    ok: payload.ok === true,
    text: asString(payload.text) ?? "",
  };
  const code = asString(payload.code);
  if (code !== undefined) result.code = code;
  if (payload.detail !== undefined) result.detail = payload.detail;
  const artifactPath = asString(payload.artifactPath);
  if (artifactPath !== undefined) result.artifactPath = artifactPath;
  return result;
}

function toVerdictModel(raw: Record<string, unknown>): VerdictModel {
  const ownership: VerdictModel["ownership"] = [];
  if (Array.isArray(raw.ownership)) {
    for (const item of raw.ownership) {
      if (!isRecord(item)) continue;
      const t = item.t === "user" || item.t === "manual" ? item.t : "agent";
      ownership.push({ t, title: asString(item.title) ?? "", desc: asString(item.desc) ?? "" });
    }
  }
  return {
    rootCause: asString(raw.rootCause) ?? "",
    evidence: evidenceRows(raw.evidence) ?? [],
    prediction: asString(raw.prediction) ?? "",
    ownership,
    confidence: raw.confidence === "高" || raw.confidence === "中" ? raw.confidence : "低",
  };
}

function toGuardModel(raw: Record<string, unknown>): GuardModel {
  return {
    action: asString(raw.action) ?? "",
    address: asString(raw.address) ?? "",
    value: asString(raw.value) ?? "",
    state: raw.state === "已拒绝" || raw.state === "已执行" ? raw.state : "待确认",
  };
}

const PREVIEW_MAX_KEYS = 8;
const PREVIEW_MAX_VALUE_LENGTH = 200;

function truncateCodePoints(text: string): string {
  return Array.from(text).slice(0, PREVIEW_MAX_VALUE_LENGTH).join("");
}

function previewValueText(value: unknown): string {
  if (typeof value === "string") return truncateCodePoints(value);
  const text = JSON.stringify(value) ?? String(value);
  return truncateCodePoints(text);
}

function flattenPreview(preview: unknown): string | undefined {
  if (!isRecord(preview)) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(preview)) {
    if (parts.length >= PREVIEW_MAX_KEYS) break;
    parts.push(`${key}=${previewValueText(value)}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function approvalStatus(payload: Record<string, unknown>): ApprovalModel["status"] {
  if (payload.effective === "allow") return "allowed";
  const reason = asString(payload.reason) ?? "";
  if (reason.startsWith("approval_timeout")) return "expired";
  if (reason.startsWith("approval_aborted")) return "aborted";
  return "denied";
}

type UsageModel = NonNullable<TranscriptView["usage"]>;

function mergeUsage(current: UsageModel | undefined, payload: Record<string, unknown>): UsageModel {
  const costUsd = asCost(payload.costUsd);
  const next: UsageModel = {
    prompt: (current?.prompt ?? 0) + (asNumber(payload.promptTokens) ?? 0),
    completion: (current?.completion ?? 0) + (asNumber(payload.completionTokens) ?? 0),
    cached: (current?.cached ?? 0) + (asNumber(payload.cachedTokens) ?? 0),
  };
  const totalCost = (current?.costUsd ?? 0) + (costUsd ?? 0);
  if (costUsd !== undefined || current?.costUsd !== undefined) next.costUsd = totalCost;
  return next;
}

function pushAssistant(out: TranscriptEvent[], id: string, content: string, note?: string): void {
  if (content.length === 0) return;
  if (content.startsWith(ASK_PREFIX)) {
    out.push(note === undefined ? { id, kind: "ask", text: content } : { id, kind: "ask", text: content, note });
    return;
  }
  out.push({ id, kind: "assistant", text: content });
}

function pushToolSkeleton(
  out: TranscriptEvent[],
  tools: Map<string, Extract<TranscriptEvent, { kind: "tool" }>>,
  eventId: string,
  call: unknown,
): void {
  if (!isRecord(call)) return;
  const id = asString(call.id);
  const name = asString(call.name);
  if (id === undefined || name === undefined) return;
  const entry: Extract<TranscriptEvent, { kind: "tool" }> = {
    id: eventId,
    kind: "tool",
    tool: createToolCard(id, name, call.arguments),
  };
  out.push(entry);
  tools.set(id, entry);
}

function buildView(events: TranscriptEvent[], meta: ViewMeta): TranscriptView {
  const view: TranscriptView = { steps: reduceStep(events), status: meta.status, events };
  if (meta.usage !== undefined) view.usage = meta.usage;
  if (meta.context !== undefined) view.context = meta.context;
  if (meta.cost !== undefined) view.cost = meta.cost;
  if (meta.sessionId !== undefined) view.sessionId = meta.sessionId;
  if (meta.interruptReason !== undefined) view.interruptReason = meta.interruptReason;
  return view;
}

interface ViewMeta {
  status: TranscriptView["status"];
  usage?: UsageModel;
  context?: { used: number; limit: number };
  cost?: number;
  sessionId?: string;
  interruptReason?: string;
}

export function transcriptFromSession(events: readonly SessionEvent[]): TranscriptView {
  const out: TranscriptEvent[] = [];
  const tools = new Map<string, Extract<TranscriptEvent, { kind: "tool" }>>();
  const approvals = new Map<string, Extract<TranscriptEvent, { kind: "approval" }>>();
  let usage: UsageModel | undefined;
  let cost: number | undefined;
  let interruptReason: string | undefined;
  let sawVerdict = false;
  let sawDone = false;
  let interrupted = false;

  for (const event of events) {
    const payload = event.payload;
    switch (event.type) {
      case "user": {
        const text = asString(payload.content);
        if (text !== undefined) out.push({ id: `ev-${event.seq}`, kind: "user", text });
        break;
      }
      case "assistant": {
        if (isRecord(payload.verdict)) {
          out.push({ id: `ev-${event.seq}`, kind: "verdict", verdict: toVerdictModel(payload.verdict) });
          sawVerdict = true;
          break;
        }
        if (isRecord(payload.guard)) {
          out.push({ id: `ev-${event.seq}`, kind: "guard", guard: toGuardModel(payload.guard) });
          break;
        }
        pushAssistant(out, `ev-${event.seq}`, asString(payload.content) ?? "", asString(payload.note));
        if (Array.isArray(payload.toolCalls)) {
          for (const call of payload.toolCalls) {
            pushToolSkeleton(out, tools, `ev-${event.seq}-tool-${isRecord(call) ? String(call.id) : ""}`, call);
          }
        }
        break;
      }
      case "tool_result": {
        const id = asString(payload.id);
        if (id === undefined) break;
        const card = tools.get(id);
        if (card === undefined) break;
        applyToolResult(card.tool, toToolResultPayload(payload));
        break;
      }
      case "usage": {
        usage = mergeUsage(usage, payload);
        const delta = asCost(payload.costUsd);
        if (delta !== undefined) cost = (cost ?? 0) + delta;
        break;
      }
      case "status": {
        if (payload.status === "done") sawDone = true;
        else if (payload.status === "usage_missing") interruptReason = "缺少 usage 计费信息";
        break;
      }
      case "interrupted": {
        const reason = asString(payload.reason) ?? "已中断";
        interruptReason = reason;
        interrupted = true;
        out.push({ id: `ev-${event.seq}`, kind: "interrupted", reason });
        break;
      }
      case "tool_started": {
        const callId = asString(payload.callId);
        if (callId === undefined) break;
        const card = tools.get(callId);
        if (card !== undefined) card.tool.state = "running";
        break;
      }
      case "approval_request": {
        const callId = asString(payload.callId);
        if (callId === undefined) break;
        const approval: ApprovalModel = {
          requestId: asString(payload.requestId) ?? "",
          callId,
          tool: asString(payload.tool) ?? "",
          reason: asString(payload.reason) ?? "",
          preset: asString(payload.preset) ?? "",
          status: "pending",
        };
        const deadlineAt = asString(payload.deadlineAt);
        if (deadlineAt !== undefined) approval.deadlineAt = deadlineAt;
        const previewText = flattenPreview(payload.paramsPreview);
        if (previewText !== undefined) approval.paramsPreviewText = previewText;
        const entry: Extract<TranscriptEvent, { kind: "approval" }> = {
          id: `ev-${event.seq}`,
          kind: "approval",
          approval,
        };
        out.push(entry);
        approvals.set(callId, entry);
        break;
      }
      case "permission_decision": {
        const callId = asString(payload.callId);
        if (callId === undefined) break;
        const approval = approvals.get(callId);
        if (approval !== undefined) {
          approval.approval.status = approvalStatus(payload);
        } else {
          out.push({
            id: `ev-${event.seq}`,
            kind: "permission",
            permission: {
              callId,
              tool: asString(payload.tool) ?? "",
              action:
                payload.action === "allow" || payload.action === "ask" || payload.action === "deny"
                  ? payload.action
                  : "deny",
              effective: payload.effective === "allow" ? "allow" : "deny",
              reason: asString(payload.reason) ?? "",
            },
          });
        }
        if (payload.effective !== "allow") {
          const card = tools.get(callId);
          if (card !== undefined) {
            card.tool.state = "failed";
            card.tool.ok = false;
            if (card.tool.errorCode === undefined) card.tool.errorCode = "permission_denied";
            if (card.tool.errorText === undefined) {
              card.tool.errorText = asString(payload.reason) ?? "权限拒绝，未执行";
            }
          }
        }
        break;
      }
      case "mcp_status":
      case "device_status": {
        break;
      }
      default:
        break;
    }
  }

  const status: TranscriptView["status"] = interrupted
    ? "interrupted"
    : sawDone || sawVerdict
      ? "done"
      : out.length > 0
        ? "diagnosing"
        : "idle";
  return buildView(out, { status, usage, cost: cost ?? usage?.costUsd, interruptReason });
}

export function transcriptFromLoop(events: readonly LoopEvent[]): TranscriptView {
  const out: TranscriptEvent[] = [];
  const tools = new Map<string, Extract<TranscriptEvent, { kind: "tool" }>>();
  let interruptReason: string | undefined;
  let cost: number | undefined;
  let finished = false;
  let interrupted = false;

  events.forEach((event, index) => {
    switch (event.kind) {
      case "model_message": {
        pushAssistant(out, `loop-${index}`, event.content);
        break;
      }
      case "tool_use": {
        pushToolSkeleton(out, tools, `loop-${index}-tool-${event.id}`, {
          id: event.id,
          name: event.name,
          arguments: event.input,
        });
        break;
      }
      case "tool_result": {
        const card = tools.get(event.id);
        if (card === undefined) break;
        applyToolResult(card.tool, event);
        break;
      }
      case "turn_end": {
        const delta = asCost(event.costUsd);
        if (delta !== undefined) cost = (cost ?? 0) + delta;
        break;
      }
      case "interrupted": {
        interruptReason = event.reason;
        interrupted = true;
        out.push({ id: `loop-${index}`, kind: "interrupted", reason: event.reason });
        break;
      }
      case "done": {
        finished = true;
        break;
      }
      default:
        break;
    }
  });

  const status: TranscriptView["status"] = interrupted
    ? "interrupted"
    : finished
      ? "done"
      : out.length > 0
        ? "diagnosing"
        : "idle";
  return buildView(out, { status, cost, interruptReason });
}

export const TRANSCRIPT_KINDS: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "ask",
  "tool",
  "verdict",
  "guard",
  "permission",
  "approval",
  "interrupted",
]);
const LOOP_KINDS = new Set(["model_message", "tool_use", "tool_result", "turn_end", "compacted", "done"]);

function isTranscriptEvent(value: unknown): value is TranscriptEvent {
  return isRecord(value) && typeof value.id === "string" && typeof value.kind === "string" && TRANSCRIPT_KINDS.has(value.kind);
}

function normalizeEvents(events: readonly unknown[]): TranscriptEvent[] {
  if (events.length === 0) return [];
  const first = events[0];
  if (!isRecord(first)) return [];
  if (typeof first.type === "string") return [...transcriptFromSession(events as readonly SessionEvent[]).events];
  if (typeof first.kind === "string" && LOOP_KINDS.has(first.kind)) {
    return [...transcriptFromLoop(events as readonly LoopEvent[]).events];
  }
  return events.filter(isTranscriptEvent);
}

function isProbeTool(name: string): boolean {
  return name.startsWith("mem_") || name.startsWith("serial_") || name.startsWith("reg_");
}

export function reduceStep(events: readonly unknown[]): TranscriptStep[] {
  const transcript = normalizeEvents(events);
  const done: Record<TranscriptStepId, boolean> = {
    symptom: transcript.some((event) => event.kind === "user"),
    triage: transcript.some((event) => event.kind === "ask"),
    kb: transcript.some((event) => event.kind === "tool" && event.tool.name.startsWith("kb_")),
    probe: transcript.some((event) => event.kind === "tool" && isProbeTool(event.tool.name) && event.tool.ok),
    verdict: transcript.some((event) => event.kind === "verdict"),
  };
  let opened = false;
  return STEP_LABELS.map(({ id, label }) => {
    if (done[id]) return { id, label, state: "done" };
    if (!opened) {
      opened = true;
      return { id, label, state: "now" };
    }
    return { id, label, state: "todo" };
  });
}

export function emptyTranscriptView(): TranscriptView {
  return { steps: reduceStep([]), status: "idle", events: [] };
}
