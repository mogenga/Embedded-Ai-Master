import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestParams, stableStringify, summarizeParams } from "../src/permissions/audit.js";

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("stableStringify", () => {
  it("sorts object keys recursively", () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, b: 1 }),
    );
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("keeps array order", () => {
    expect(stableStringify({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it("omits undefined object properties but keeps array slots deterministic", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined, 1])).toBe("[null,1]");
    expect(stableStringify(undefined)).toBe("undefined");
  });

  it("gives non-serializable values a deterministic representation", () => {
    expect(stableStringify({ fn: () => 1 })).toBe(stableStringify({ fn: () => 2 }));
    expect(stableStringify({ big: 10n })).toBe('{"big":"[bigint:10]"}');
    expect(stableStringify({ value: Number.NaN })).toBe('{"value":"[non-finite:NaN]"}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stableStringify(circular)).toBe('{"self":"[circular]"}');
  });
});

describe("digestParams", () => {
  it("is independent of key order", () => {
    expect(digestParams({ a: 1, b: 2 })).toBe(digestParams({ b: 2, a: 1 }));
  });

  it("returns the first 16 hex characters of the SHA-256 digest", () => {
    const expected = createHash("sha256").update('{"a":1}').digest("hex").slice(0, 16);
    expect(digestParams({ a: 1 })).toBe(expected);
    expect(digestParams({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("summarizeParams", () => {
  it("returns sorted top-level keys", () => {
    expect(summarizeParams({ path: "src/a.ts", op: "read" }).keys).toEqual(["op", "path"]);
  });

  it("truncates string values to 120 code points", () => {
    expect(summarizeParams({ content: "x".repeat(500) }).preview?.content).toHaveLength(120);
  });

  it("does not split surrogate pairs when truncating strings", () => {
    const preview = summarizeParams({ content: "😀".repeat(200) }).preview;
    const value = preview?.content as string;
    expect(Array.from(value)).toHaveLength(120);
    expect(hasLoneSurrogate(value)).toBe(false);
  });

  it("summarizes arrays and objects as type and size", () => {
    const preview = summarizeParams({
      list: [1, 2, 3],
      map: { a: 1, b: 2 },
    }).preview;
    expect(preview?.list).toEqual({ type: "array", size: 3 });
    expect(preview?.map).toEqual({ type: "object", size: 2 });
  });

  it("keeps numbers, booleans and null as-is", () => {
    const preview = summarizeParams({ num: 42, yes: true, no: false, empty: null }).preview;
    expect(preview).toMatchObject({ num: 42, yes: true, no: false, empty: null });
  });

  it("gives undefined and non-serializable values a deterministic representation", () => {
    const first = summarizeParams({ value: undefined, fn: () => 1 }).preview;
    const second = summarizeParams({ value: undefined, fn: () => 2 }).preview;
    expect(first).toEqual(second);
    expect(typeof first?.value).toBe("string");
    expect(typeof first?.fn).toBe("string");
  });

  it("keeps an own __proto__ parameter visible in keys, digest and preview", () => {
    const left = JSON.parse('{"__proto__":{"secret":"AAAA"},"path":"x"}') as Record<string, unknown>;
    const right = JSON.parse('{"__proto__":{"secret":"BBBB"},"path":"x"}') as Record<string, unknown>;

    expect(summarizeParams(left).keys).toEqual(["__proto__", "path"]);
    expect(digestParams(left)).not.toBe(digestParams(right));
    expect(stableStringify(left)).toContain("__proto__");

    const preview = summarizeParams(left).preview;
    expect(Object.hasOwn(preview ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(preview)).toBe(Object.prototype);
  });

  it("does not let a parameter named truncated collide with the truncation marker", () => {
    const args: Record<string, unknown> = { truncated: "user-value" };
    // 用 zz 前缀让 truncated 在排序中靠前,确保它不在预算裁剪时被丢弃。
    for (let index = 0; index < 32; index += 1) {
      args[`zz${String(index).padStart(2, "0")}${"k".repeat(86)}`] = "v".repeat(120);
    }

    const summary = summarizeParams(args);
    expect(summary.preview?.truncated).toBe("user-value");
    expect(summary.preview?.previewTruncated).toBe(true);
    expect(utf8Bytes(summary.preview)).toBeLessThanOrEqual(4096);
  });

  it("returns empty keys without preview for non-object input", () => {
    for (const input of [null, undefined, "text", 3, [1, 2]]) {
      const summary = summarizeParams(input);
      expect(summary.keys).toEqual([]);
      expect(summary.preview).toBeUndefined();
    }
  });

  it("keeps at most 32 keys after sorting and marks truncation", () => {
    const args: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1) {
      args[`k${String(index).padStart(2, "0")}`] = index;
    }
    const summary = summarizeParams(args);
    expect(summary.keys).toHaveLength(32);
    expect(summary.keys[0]).toBe("k00");
    expect(summary.keys[31]).toBe("k31");
    expect(summary.preview?.previewTruncated).toBe(true);
    expect(summary.preview?.truncated).toBeUndefined();
  });

  it("truncates a single key to 100 characters", () => {
    const summary = summarizeParams({ ["k".repeat(150)]: 1 });
    expect(summary.keys).toHaveLength(1);
    expect(summary.keys[0]).toHaveLength(100);
  });

  it("does not mark truncated when everything fits", () => {
    const summary = summarizeParams({ b: 1, a: 2 });
    expect(summary.preview).toEqual({ a: 2, b: 1 });
    expect(summary.preview?.previewTruncated).toBeUndefined();
  });

  it("drops trailing keys so the preview stays within 4096 UTF-8 bytes", () => {
    const args: Record<string, string> = {};
    for (let index = 0; index < 32; index += 1) {
      args[`${String(index).padStart(2, "0")}${"k".repeat(88)}`] = "v".repeat(120);
    }
    const summary = summarizeParams(args);
    expect(summary.preview?.previewTruncated).toBe(true);
    // 标记键计入预算:4096 字节上限对含标记的最终对象仍然成立。
    expect(Object.keys(summary.preview ?? {}).length).toBeLessThan(32);
    expect(utf8Bytes(summary.preview)).toBeLessThanOrEqual(4096);
  });
});
