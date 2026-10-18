import type { JSX } from "preact";

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

export function StatusBar({
  probe,
  serial,
  alert,
  sessionId,
  context,
  cost,
  platform,
}: {
  probe?: string;
  serial?: string;
  alert?: string;
  sessionId?: string;
  context?: string;
  cost?: string;
  platform?: string;
}): JSX.Element {
  return (
    <footer class="statusbar">
      <span class="sb">
        <span class="dot" data-s={hasValue(probe) ? "ok" : "idle"} />
        <span>{hasValue(probe) ? probe : "探针 —"}</span>
      </span>
      <span class="sb">
        <span class="dot" data-s={hasValue(serial) ? "ok" : "idle"} />
        <span>{hasValue(serial) ? serial : "串口 —"}</span>
      </span>
      <span class="sb">
        <span class="dot" data-s={hasValue(alert) ? "warn" : "idle"} />
        <span>{hasValue(alert) ? alert : "告警 —"}</span>
      </span>
      <span class="spacer" />
      <span class="sb mono">{hasValue(sessionId) ? sessionId : "#—"}</span>
      <span class="sb mono">{hasValue(context) ? context : "—"}</span>
      <span class="sb mono">{hasValue(cost) ? cost : "—"}</span>
      <span class="sb mono">{hasValue(platform) ? platform : "—"}</span>
    </footer>
  );
}