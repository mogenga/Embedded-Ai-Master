import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Icon } from "../../icons.js";
import type { ApprovalModel } from "../../view/transcript.js";

type Decision = "allow" | "deny";

const TERMINAL_LABEL: Record<Exclude<ApprovalModel["status"], "pending">, string> = {
  allowed: "已允许",
  denied: "已拒绝",
  expired: "已过期",
  aborted: "已中断",
};

function deadlineText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const date = new Date(parsed);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function deadlineMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as { status?: unknown; text?: unknown };
    if (typeof record.text === "string" && record.text.length > 0) return record.text;
    if (typeof record.status === "number") return `审批提交失败（HTTP ${record.status}）`;
  }
  return "审批提交失败，请重试";
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

export function ApprovalNotice({
  approval,
  sessionId,
  onDecision,
}: {
  approval: ApprovalModel;
  sessionId?: string;
  onDecision?: (sessionId: string, requestId: string, decision: Decision) => Promise<void>;
}): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [terminalError, setTerminalError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  const deadlineAt = deadlineMs(approval.deadlineAt);
  const pending = approval.status === "pending";

  useEffect(() => {
    if (!pending || deadlineAt === undefined) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [pending, deadlineAt]);

  const timedOut = pending && deadlineAt !== undefined && now >= deadlineAt;
  const settled = !pending;
  const disabled =
    settled ||
    timedOut ||
    submitting ||
    submitted ||
    terminalError !== undefined ||
    onDecision === undefined ||
    sessionId === undefined;

  let stateLabel: string;
  if (settled) stateLabel = TERMINAL_LABEL[approval.status as Exclude<ApprovalModel["status"], "pending">];
  else if (timedOut) stateLabel = "已过期";
  else if (submitted) stateLabel = "已提交，等待确认";
  else if (submitting) stateLabel = "提交中…";
  else stateLabel = "待审批";

  const deadlineLabel = deadlineText(approval.deadlineAt);

  async function decide(decision: Decision): Promise<void> {
    if (disabled || onDecision === undefined || sessionId === undefined) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onDecision(sessionId, approval.requestId, decision);
      setSubmitted(true);
    } catch (err) {
      const text = errorText(err);
      setError(text);
      const status = errorStatus(err);
      if (status === 409 || status === 410) setTerminalError(text);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="approval" data-status={approval.status} data-expired={timedOut ? "true" : undefined}>
      <div class="approval-head">
        <Icon name="i-alert" size={15} />
        <span class="approval-tool">{approval.tool}</span>
        <code class="approval-action">ask</code>
        {approval.preset.length === 0 ? null : <code class="approval-preset">{approval.preset}</code>}
        <span class="approval-state">{stateLabel}</span>
      </div>
      {approval.reason.length === 0 ? null : <p class="approval-reason">{approval.reason}</p>}
      {approval.paramsPreviewText === undefined ? null : (
        <p class="approval-params">
          参数：<code>{approval.paramsPreviewText}</code>
        </p>
      )}
      {deadlineLabel === undefined ? null : <p class="approval-deadline">截止 {deadlineLabel}</p>}
      {error === undefined ? null : (
        <p class="approval-error" role="alert">
          {error}
        </p>
      )}
      {settled ? null : (
        <div class="approval-actions">
          <button
            type="button"
            class="btn"
            disabled={disabled}
            onClick={() => {
              void decide("allow");
            }}
          >
            <Icon name="i-check" size={14} />
            <span>批准</span>
          </button>
          <button
            type="button"
            class="btn btn--danger"
            disabled={disabled}
            onClick={() => {
              void decide("deny");
            }}
          >
            <Icon name="i-x" size={14} />
            <span>拒绝</span>
          </button>
        </div>
      )}
    </div>
  );
}