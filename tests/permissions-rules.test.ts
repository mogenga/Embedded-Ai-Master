import { describe, expect, it } from "vitest";
import { matchParam, matchParams, matchToolPattern, readPath } from "../src/permissions/rules.js";

describe("matchToolPattern", () => {
  it("matches exact names", () => {
    expect(matchToolPattern("fs", "fs")).toBe(true);
  });

  it("matches wildcard segments", () => {
    expect(matchToolPattern("mcp__*__mem_*", "mcp__probe__mem_write")).toBe(true);
  });

  it("matches a single-character wildcard", () => {
    expect(matchToolPattern("fs?", "fsw")).toBe(true);
  });

  it("matches everything with a lone star", () => {
    expect(matchToolPattern("*", "anything")).toBe(true);
  });

  it("does not match longer names for an exact pattern", () => {
    expect(matchToolPattern("fs", "fss")).toBe(false);
  });

  it("is case sensitive", () => {
    expect(matchToolPattern("FS", "fs")).toBe(false);
  });

  it("rejects empty patterns", () => {
    expect(matchToolPattern("", "x")).toBe(false);
  });

  it("rejects overlong patterns", () => {
    expect(matchToolPattern("a".repeat(201), "a".repeat(201))).toBe(false);
  });

  it("escapes regular expression metacharacters", () => {
    expect(matchToolPattern("a.b", "a.b")).toBe(true);
    expect(matchToolPattern("a.b", "axb")).toBe(false);
    expect(matchToolPattern("(fs)", "(fs)")).toBe(true);
    expect(matchToolPattern("(fs)", "fs")).toBe(false);
  });

  it("handles repeated and trailing stars", () => {
    expect(matchToolPattern("a*", "a")).toBe(true);
    expect(matchToolPattern("*a*", "banana")).toBe(true);
    expect(matchToolPattern("a*b*c", "aXbYc")).toBe(true);
    expect(matchToolPattern("**", "")).toBe(true);
  });

  it("requires one character for each question mark", () => {
    expect(matchToolPattern("?", "")).toBe(false);
    expect(matchToolPattern("f??", "fs")).toBe(false);
  });

  it("stays bounded on long inputs with many stars", () => {
    expect(matchToolPattern("*a*a*a*a*a*a*a*a*b", "a".repeat(10_000))).toBe(false);
  });
});

describe("readPath", () => {
  it("reads nested object and array values", () => {
    expect(readPath({ a: { b: ["x"] } }, "a.b.0")).toEqual({ found: true, value: "x" });
  });

  it("reports missing nested keys", () => {
    expect(readPath({ a: 1 }, "a.b").found).toBe(false);
  });

  it("rejects empty keys and empty segments", () => {
    expect(readPath({ a: 1 }, "").found).toBe(false);
    expect(readPath({ a: 1 }, "a..b").found).toBe(false);
    expect(readPath({ a: 1 }, ".a").found).toBe(false);
  });

  it("rejects non-decimal array segments", () => {
    expect(readPath({ a: [1, 2] }, "a.length").found).toBe(false);
    expect(readPath({ a: [1, 2] }, "a.01").found).toBe(false);
  });

  it("reports out-of-range array indexes as missing", () => {
    expect(readPath({ a: [1, 2] }, "a.2").found).toBe(false);
  });
});

describe("matchParam", () => {
  it("matches strict equality", () => {
    expect(matchParam({ key: "op", eq: "read" }, { op: "read" })).toBe(true);
    expect(matchParam({ key: "op", eq: 1 }, { op: "1" })).toBe(false);
    expect(matchParam({ key: "v", eq: null }, { v: null })).toBe(true);
    expect(matchParam({ key: "v", eq: null }, { v: undefined })).toBe(false);
  });

  it("treats negative zero as zero", () => {
    expect(matchParam({ key: "v", eq: 0 }, { v: -0 })).toBe(true);
  });

  it("matches globs on strings only", () => {
    expect(matchParam({ key: "path", glob: "src/*.ts" }, { path: "src/a.ts" })).toBe(true);
    expect(matchParam({ key: "v", glob: "*" }, { v: 1 })).toBe(false);
  });

  it("matches membership strictly", () => {
    expect(matchParam({ key: "port", in: ["COM3", "/dev/ttyUSB0"] }, { port: "COM3" })).toBe(true);
    expect(matchParam({ key: "v", in: [] }, { v: 1 })).toBe(false);
    expect(matchParam({ key: "v", in: [1] }, { v: "1" })).toBe(false);
    expect(matchParam({ key: "v", in: [0] }, { v: -0 })).toBe(true);
  });

  it("matches inclusive finite ranges", () => {
    expect(matchParam({ key: "address", range: [0x20000000, 0x2000001f] }, { address: 0x2000001f })).toBe(true);
    expect(matchParam({ key: "v", range: [5, 5] }, { v: 5 })).toBe(true);
    expect(matchParam({ key: "v", range: [0, 1] }, { v: "1" })).toBe(false);
    expect(matchParam({ key: "v", range: [0, 1] }, { v: Number.NaN })).toBe(false);
  });

  it("does not match reversed ranges", () => {
    expect(matchParam({ key: "v", range: [2, 1] }, { v: 1.5 })).toBe(false);
  });

  it("does not match when the key is absent", () => {
    expect(matchParam({ key: "missing", eq: "read" }, { op: "read" })).toBe(false);
  });

  it("does not match matchers with zero or multiple operators", () => {
    expect(matchParam({ key: "v" }, { v: 1 })).toBe(false);
    expect(matchParam({ key: "v", eq: 1, glob: "*" }, { v: 1 })).toBe(false);
  });
});

describe("matchParams", () => {
  it("treats absent or empty matcher lists as matching", () => {
    expect(matchParams(undefined, {})).toBe(true);
    expect(matchParams([], {})).toBe(true);
  });

  it("requires every matcher to match", () => {
    expect(
      matchParams(
        [{ key: "op", eq: "write" }, { key: "path", glob: "src/*" }],
        { op: "write", path: "src/a.ts" },
      ),
    ).toBe(true);
    expect(
      matchParams(
        [{ key: "op", eq: "write" }, { key: "path", glob: "src/*" }],
        { op: "write", path: "lib/a.ts" },
      ),
    ).toBe(false);
  });
});