export interface ParsedDeviceStatus {
  state: Record<string, unknown>;
}

export type ParseDeviceStatusResult =
  | { ok: true; value: ParsedDeviceStatus }
  | { ok: false; reason: string };

const MAX_DEVICE_STATUS_BYTES = 8_192;
const MAX_DEVICE_STATUS_DEPTH = 4;

class DeviceStatusError extends Error {}

function fail(reason: string): never {
  throw new DeviceStatusError(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// 只按自有可枚举属性测量 JSON 字节数,遇到访问器直接失败,不触发 getter/toJSON。
function measure(value: unknown, depth: number, seen: Set<object>): number {
  if (value === null) return 4;
  const type = typeof value;
  if (type === "boolean") return value === true ? 4 : 5;
  if (type === "string") return bytesOf(JSON.stringify(value));
  if (type === "number") {
    if (!Number.isFinite(value)) fail("deviceStatus 含非法数字");
    return String(value).length;
  }
  if (type !== "object") fail("deviceStatus 含非 JSON 值");

  const container = value as object;
  if (depth > MAX_DEVICE_STATUS_DEPTH) {
    fail(`deviceStatus 深度超过 ${MAX_DEVICE_STATUS_DEPTH}`);
  }
  if (seen.has(container)) fail("deviceStatus 含循环引用");
  seen.add(container);

  let bytes = 2;
  if (Array.isArray(container)) {
    const length = container.length;
    for (let index = 0; index < length; index += 1) {
      if (index > 0) bytes += 1;
      const descriptor = Object.getOwnPropertyDescriptor(container, String(index));
      if (descriptor === undefined) fail("deviceStatus 数组含空槽");
      if (!("value" in descriptor)) fail("deviceStatus 含访问器属性");
      bytes += measure(descriptor.value, depth + 1, seen);
      if (bytes > MAX_DEVICE_STATUS_BYTES) {
        fail(`deviceStatus 超过 ${MAX_DEVICE_STATUS_BYTES} bytes`);
      }
    }
  } else {
    if (!isPlainObject(container)) fail("deviceStatus 含非普通对象");
    let first = true;
    for (const key of Object.keys(container)) {
      const descriptor = Object.getOwnPropertyDescriptor(container, key);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor)) fail("deviceStatus 含访问器属性");
      if (!first) bytes += 1;
      first = false;
      bytes += bytesOf(JSON.stringify(key)) + 1;
      bytes += measure(descriptor.value, depth + 1, seen);
      if (bytes > MAX_DEVICE_STATUS_BYTES) {
        fail(`deviceStatus 超过 ${MAX_DEVICE_STATUS_BYTES} bytes`);
      }
    }
  }

  seen.delete(container);
  return bytes;
}

export function parseDeviceStatus(value: unknown): ParseDeviceStatusResult {
  try {
    if (!isPlainObject(value)) {
      return { ok: false, reason: "deviceStatus 必须是普通对象" };
    }
    const bytes = measure(value, 1, new Set<object>());
    if (bytes > MAX_DEVICE_STATUS_BYTES) {
      return { ok: false, reason: `deviceStatus 超过 ${MAX_DEVICE_STATUS_BYTES} bytes` };
    }
    return { ok: true, value: { state: value } };
  } catch (error) {
    if (error instanceof DeviceStatusError) {
      return { ok: false, reason: error.message };
    }
    return {
      ok: false,
      reason: `deviceStatus 无法序列化: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}