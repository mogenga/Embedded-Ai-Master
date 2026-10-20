import type { ParamMatcher } from "./types.js";

const MAX_PATTERN_LENGTH = 200;

function matchWildcard(pattern: string, name: string): boolean {
  let patternIndex = 0;
  let nameIndex = 0;
  let starIndex = -1;
  let starNameIndex = 0;

  while (nameIndex < name.length) {
    if (patternIndex < pattern.length) {
      const char = pattern[patternIndex];
      if (char === "?" || char === name[nameIndex]) {
        patternIndex += 1;
        nameIndex += 1;
        continue;
      }
      if (char === "*") {
        starIndex = patternIndex;
        starNameIndex = nameIndex;
        patternIndex += 1;
        continue;
      }
    }
    if (starIndex === -1) return false;
    starNameIndex += 1;
    nameIndex = starNameIndex;
    patternIndex = starIndex + 1;
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

export function matchToolPattern(pattern: string, name: string): boolean {
  if (typeof pattern !== "string" || typeof name !== "string") return false;
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return false;
  return matchWildcard(pattern, name);
}

export function readPath(input: unknown, key: string): { found: boolean; value?: unknown } {
  if (typeof key !== "string" || key.length === 0) return { found: false };

  const segments = key.split(".");
  if (segments.some((segment) => segment.length === 0)) return { found: false };

  let current: unknown = input;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { found: false };
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = current[Number(segment)];
      continue;
    }
    if (typeof current === "object" && current !== null) {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}

// `-0 === 0` 为 true,因此这里无需归一 -0;保留显式注释说明该语义是设计的一部分。
function strictEqual(left: unknown, right: unknown): boolean {
  return left === right;
}

function countOperators(matcher: ParamMatcher): number {
  let count = 0;
  if (matcher.eq !== undefined) count += 1;
  if (matcher.glob !== undefined) count += 1;
  if (matcher.in !== undefined) count += 1;
  if (matcher.range !== undefined) count += 1;
  return count;
}

function matchRange(range: [number, number], value: unknown): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const [lower, upper] = range;
  if (typeof lower !== "number" || typeof upper !== "number") return false;
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return false;
  if (lower > upper) return false;
  return value >= lower && value <= upper;
}

function readExtent(input: unknown, key: string | undefined): number | undefined {
  if (key === undefined) return undefined;
  const extent = readPath(input, key);
  if (!extent.found) return undefined;
  if (Array.isArray(extent.value)) return extent.value.length;
  if (typeof extent.value === "number" && Number.isFinite(extent.value)) return extent.value;
  return undefined;
}

export function matchParam(matcher: ParamMatcher, input: unknown): boolean {
  if (countOperators(matcher) !== 1) return false;

  const path = readPath(input, matcher.key);
  if (!path.found) return false;

  if (matcher.eq !== undefined) return strictEqual(path.value, matcher.eq);
  if (matcher.glob !== undefined) {
    return typeof path.value === "string" && matchToolPattern(matcher.glob, path.value);
  }
  if (matcher.in !== undefined) {
    if (!Array.isArray(matcher.in)) return false;
    return matcher.in.some((candidate) => strictEqual(path.value, candidate));
  }
  if (matcher.range !== undefined) {
    if (!Array.isArray(matcher.range) || matcher.range.length !== 2) return false;
    if (!matchRange(matcher.range, path.value)) return false;
    if (matcher.extentKey === undefined) return true;
    const extent = readExtent(input, matcher.extentKey);
    if (extent === undefined || !Number.isFinite(extent) || extent < 1) return false;
    return (path.value as number) + extent - 1 <= matcher.range[1];
  }
  return false;
}

export function matchParams(matchers: readonly ParamMatcher[] | undefined, input: unknown): boolean {
  if (matchers === undefined || matchers.length === 0) return true;
  return matchers.every((matcher) => matchParam(matcher, input));
}
