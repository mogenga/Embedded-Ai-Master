import type { SessionEvent } from "../../session/types.js";
import type { DeviceStatus } from "../api/client.js";

export const UNKNOWN_DEVICE: DeviceStatus = {
  probe: "unknown",
  serial: "unknown",
  cpu: "unknown",
  backend: "unknown",
};

const DEVICE_FIELDS = ["probe", "serial", "cpu", "backend"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patchDevice(current: DeviceStatus, state: unknown): DeviceStatus {
  if (!isRecord(state)) return current;
  let next: DeviceStatus | undefined;
  for (const field of DEVICE_FIELDS) {
    const value = state[field];
    if (typeof value !== "string") continue;
    if (next === undefined) next = { ...current };
    next[field] = value;
  }
  return next ?? current;
}

export function deviceFromSession(events: readonly SessionEvent[]): DeviceStatus {
  let device = UNKNOWN_DEVICE;
  for (const event of events) {
    if (event.type !== "device_status") continue;
    device = patchDevice(device, event.payload.state);
  }
  return device;
}