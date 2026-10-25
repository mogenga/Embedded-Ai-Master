import { describe, expect, it } from "vitest";
import { allPackBinDirs, prependPath, setPackBinDirsProvider, toolEnv } from "../toolEnv.js";

/**
 * toolEnv 的 pack 目录注入（Phase 3 接回后的行为）。
 *
 * A 侧对应断言在 tests/packs.test.ts 的「环境注入」段（已随 packs 迁入
 * `src/packs/packs.test.ts`）；这里补 keil 侧新增的注入面：注入、按 kind
 * 过滤、撤销，以及贯穿两者的硬规则——process.env 永不被写。
 */

describe("toolEnv 的 pack 目录注入", () => {
  it("未注入时 pack 贡献为空，环境里只有白名单基础", () => {
    const previous = setPackBinDirsProvider(null);
    try {
      expect(allPackBinDirs()).toEqual([]);
      const env = toolEnv();
      expect(Object.keys(env).some((key) => key.toUpperCase() === "PATH")).toBe(true);
    } finally {
      if (previous) setPackBinDirsProvider(previous);
    }
  });

  it("注入后 allPackBinDirs 按声明顺序去重返回", () => {
    const previous = setPackBinDirsProvider(
      () =>
        new Map([
          ["gcc-arm", [
            { dir: "C:\\packs\\arm\\payload\\bin", packId: "arm-gnu" },
            { dir: "C:\\packs\\arm\\payload\\bin", packId: "arm-gnu" },
          ]],
          ["ninja", [{ dir: "C:\\packs\\ninja\\payload", packId: "ninja" }]],
        ]),
    );
    try {
      expect(allPackBinDirs()).toEqual(["C:\\packs\\arm\\payload\\bin", "C:\\packs\\ninja\\payload"]);
    } finally {
      setPackBinDirsProvider(previous);
    }
  });

  it("toolEnv() 把 pack 目录前置到 PATH，且不写 process.env", () => {
    const before = process.env.PATH;
    const previous = setPackBinDirsProvider(
      () => new Map([["gcc-arm", [{ dir: "C:\\packs\\arm\\payload\\bin", packId: "arm-gnu" }]]]),
    );
    try {
      const env = toolEnv();
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
      expect(pathKey).toBeDefined();
      expect(String(env[pathKey!]).startsWith("C:\\packs\\arm\\payload\\bin")).toBe(true);
      expect(process.env.PATH, "process.env 必须一个字都不变").toBe(before);
    } finally {
      setPackBinDirsProvider(previous);
    }
  });

  it("toolEnv(['gcc-arm']) 只带指定 kind，避免别的 pack 盖住用户自己的工具", () => {
    const previous = setPackBinDirsProvider(
      () =>
        new Map<string, { dir: string; packId: string }[]>([
          ["gcc-arm", [{ dir: "C:\\packs\\arm\\payload\\bin", packId: "arm-gnu" }]],
          ["cargo", [{ dir: "C:\\packs\\rust\\payload\\bin", packId: "rust" }]],
        ]),
    );
    try {
      const env = toolEnv(["gcc-arm"]);
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
      const value = String(env[pathKey!]);
      expect(value.includes("packs\\arm")).toBe(true);
      expect(value.includes("packs\\rust")).toBe(false);
    } finally {
      setPackBinDirsProvider(previous);
    }
  });

  it("撤销注入后恢复空贡献（setPackBinDirsProvider 返回前一个值）", () => {
    const original = setPackBinDirsProvider(() => new Map([["ninja", [{ dir: "X:\\ninja", packId: "ninja" }]]]));
    try {
      expect(allPackBinDirs()).toEqual(["X:\\ninja"]);
    } finally {
      const restored = setPackBinDirsProvider(original);
      expect(restored?.().get("ninja")?.[0].dir).toBe("X:\\ninja");
      expect(allPackBinDirs()).toEqual(original ? ["X:\\ninja"] : []);
    }
    setPackBinDirsProvider(null);
  });

  it("prependPath 保持 A 侧语义：已在 PATH 的目录提前而不重复", () => {
    const env = prependPath({ PATH: "/usr/bin:/opt/pack/bin" }, ["/opt/pack/bin"]);
    const sep = process.platform === "win32" ? ";" : ":";
    const parts = String(env.PATH).split(sep);
    expect(parts[0]).toBe("/opt/pack/bin");
    expect(parts.filter((part) => part === "/opt/pack/bin").length).toBe(1);
  });
});