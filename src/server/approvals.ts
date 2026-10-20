import type { PermissionPrompter, PermissionPromptRequest } from "../permissions/types.js";
import type { SessionHandle } from "../session/handle.js";
import type { ApprovalRequestPayload } from "../session/types.js";

export type DecideOutcome =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  | { kind: "unknown_request" }
  | { kind: "expired" }
  | { kind: "already_decided" };

export interface ApprovalBridge extends PermissionPrompter {
  bindSession(session: Pick<SessionHandle, "append">): void;
  decide(requestId: string, decision: "allow" | "deny"): DecideOutcome;
  pendingCount(): number;
  close(): void;
}

export interface ApprovalBridgeOptions {
  settledTtlMs?: number;
  settledMax?: number;
}

const DEFAULT_SETTLED_TTL_MS = 300_000;
const DEFAULT_SETTLED_MAX = 256;

interface PendingEntry {
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (decision: "allow" | "deny") => void;

}

interface SettledEntry {
  decision: "allow" | "deny" | undefined;
  at: number;
}

export function createApprovalBridge(opts: ApprovalBridgeOptions = {}): ApprovalBridge {
  const settledTtlMs = opts.settledTtlMs ?? DEFAULT_SETTLED_TTL_MS;
  const settledMax = opts.settledMax ?? DEFAULT_SETTLED_MAX;
  const pending = new Map<string, PendingEntry>();
  const settled = new Map<string, SettledEntry>();
  const inFlight = new Set<string>();
  let session: Pick<SessionHandle, "append"> | undefined;
  let closed = false;

  function detach(entry: PendingEntry): void {
    entry.signal.removeEventListener("abort", entry.onAbort);
  }

  function purgeExpired(now: number): void {
    for (const [requestId, entry] of settled) {
      if (now - entry.at >= settledTtlMs) settled.delete(requestId);
    }
  }

  function recordSettled(
    requestId: string,
    decision: "allow" | "deny" | undefined,
    now: number,
  ): void {
    settled.delete(requestId);
    settled.set(requestId, { decision, at: now });
    while (settled.size > settledMax) {
      const oldest = settled.keys().next().value;
      if (oldest === undefined) break;
      settled.delete(oldest);
    }
  }

  return {
    bindSession(next) {
      session = next;
    },

    async request(req: PermissionPromptRequest): Promise<"allow" | "deny"> {
      if (closed || session === undefined) return "deny";

      const { requestId } = req;
      if (pending.has(requestId) || inFlight.has(requestId)) {
        throw new Error(`duplicate approval request id: ${requestId}`);
      }

      const payload: ApprovalRequestPayload = {
        requestId,
        callId: req.callId,
        tool: req.tool,
        action: "ask",
        access: req.access,
        reason: req.reason,
        preset: req.preset,
        paramsDigest: req.paramsDigest,
        paramsKeys: [...req.paramsKeys],
        ...(req.paramsPreview === undefined ? {} : { paramsPreview: req.paramsPreview }),
        deadlineAt: req.deadlineAt,
      };

      inFlight.add(requestId);
      try {
        await session.append({ type: "approval_request", payload: { ...payload } });
      } finally {
        inFlight.delete(requestId);
      }

      if (closed) return "deny";

      if (req.signal.aborted) {
        recordSettled(requestId, undefined, Date.now());
        return "deny";
      }

      let resolveDecision!: (decision: "allow" | "deny") => void;
      const outcome = new Promise<"allow" | "deny">((resolve) => {
        resolveDecision = resolve;
      });

      let entry!: PendingEntry;
      const onAbort = (): void => {
        if (pending.get(requestId) !== entry) return;
        pending.delete(requestId);
        detach(entry);
        recordSettled(requestId, undefined, Date.now());
        resolveDecision("deny");
      };

      entry = { signal: req.signal, onAbort, resolve: resolveDecision };
      pending.set(requestId, entry);
      req.signal.addEventListener("abort", onAbort, { once: true });

      return outcome;
    },

    decide(requestId: string, decision: "allow" | "deny"): DecideOutcome {
      const active = pending.get(requestId);
      if (active !== undefined) {
        pending.delete(requestId);
        detach(active);
        recordSettled(requestId, decision, Date.now());
        active.resolve(decision);
        return { kind: "accepted" };
      }

      purgeExpired(Date.now());
      const past = settled.get(requestId);
      if (past === undefined) return { kind: "unknown_request" };
      if (past.decision === undefined) return { kind: "expired" };
      if (past.decision === decision) return { kind: "duplicate" };
      return { kind: "already_decided" };
    },

    pendingCount(): number {
      return pending.size;
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const [requestId, entry] of pending) {
        pending.delete(requestId);
        detach(entry);
        entry.resolve("deny");
      }
      settled.clear();
    },
  };
}
