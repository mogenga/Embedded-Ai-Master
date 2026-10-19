import { createHash } from "node:crypto";

const MAX_KEYS = 32;
const MAX_KEY_CODE_POINTS = 100;
const MAX_STRING_CODE_POINTS = 120;
const MAX_PREVIEW_BYTES = 4096;
const TRUNCATED_ENTRY = ',"truncated":true';

function truncateCodePoints(value: string, limit: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return value;
  return codePoints.slice(0, limit).join("");
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : `[non-finite:${String(value)}]`;
    case "bigint":
      return `[bigint:${value.toString()}]`;
    case "undefined":
      return undefined;
    case "function":
      return "[function]";
    case "symbol":
      return `[symbol:${String(value)}]`;
  }

  const object = value as object;
  if (seen.has(object)) return "[circular]";
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return object.map((item) => normalize(item, seen));
    }
    if (object instanceof Date) {
      return Number.isNaN(object.getTime()) ? "[date:Invalid]" : object.toISOString();
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const item = normalize((object as Record<string, unknown>)[key], seen);
      if (item !== undefined) sorted[key] = item;
    }
    return sorted;
  } finally {
    seen.delete(object);
  }
}

export function stableStringify(value: unknown): string {
  const normalized = normalize(value, new WeakSet<object>());
  return JSON.stringify(normalized) ?? "undefined";
}

export function digestParams(args: unknown): string {
  return createHash("sha256").update(stableStringify(args), "utf8").digest("hex").slice(0, 16);
}

function summarizeValue(value: unknown): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return truncateCodePoints(value, MAX_STRING_CODE_POINTS);
    case "number":
      return Number.isFinite(value) ? value : `[non-finite:${String(value)}]`;
    case "boolean":
      return value;
    case "undefined":
      return "[undefined]";
    case "bigint":
      return `[bigint:${value.toString()}]`;
    case "function":
      return "[function]";
    case "symbol":
      return `[symbol:${String(value)}]`;
  }

  if (Array.isArray(value)) return { type: "array", size: value.length };
  return { type: "object", size: Object.keys(value as object).length };
}

function utf8ByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeParams(args: unknown): {
  keys: string[];
  preview?: Record<string, unknown>;
} {
  if (!isPlainRecord(args)) return { keys: [] };

  const sourceKeys = Object.keys(args).sort();
  const entries = sourceKeys.slice(0, MAX_KEYS).map((sourceKey) => {
    const displayKey = truncateCodePoints(sourceKey, MAX_KEY_CODE_POINTS);
    return [displayKey, summarizeValue(args[sourceKey])] as const;
  });
  const keys = entries.map(([key]) => key);

  const preview: Record<string, unknown> = {};
  for (const [key, value] of entries) preview[key] = value;

  if (sourceKeys.length <= MAX_KEYS && utf8ByteLength(preview) <= MAX_PREVIEW_BYTES) {
    return { keys, preview };
  }

  const reservedBudget = MAX_PREVIEW_BYTES - Buffer.byteLength(TRUNCATED_ENTRY, "utf8");
  const truncatedPreview: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const candidate = { ...truncatedPreview, [key]: value };
    if (utf8ByteLength(candidate) > reservedBudget) break;
    truncatedPreview[key] = value;
  }
  truncatedPreview.truncated = true;

  return { keys, preview: truncatedPreview };
}