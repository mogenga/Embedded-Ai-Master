import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 从 UV4.exe 的位置找同一次 Keil 安装里的 fromelf.exe。
 *
 * 摘自 Prometheus/src/embedded/build.ts 的同名函数（逐行复制）。完整 build.ts
 * 依赖 toolchain/project/diagnostics/flash 整条链，Keil 闭包只需要这一个函数。
 */
export function fromelfFor(uv4Path?: string): string | null {
  if (!uv4Path) return null;
  const isExe = /\.exe$/i.test(uv4Path);
  const sibling = uv4Path.replace(/UV4(\.exe)?$/i, isExe ? "fromelf.exe" : "fromelf");
  if (sibling !== uv4Path && existsSync(sibling)) return sibling;

  // <root>\UV4\UV4.exe → <root>
  const root = join(uv4Path, "..", "..");
  const candidates = [
    join(root, "ARM", "ARMCLANG", "bin", isExe ? "fromelf.exe" : "fromelf"),
    join(root, "ARM", "ARM_Compiler_5.06u7", "bin", isExe ? "fromelf.exe" : "fromelf"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // A version we do not name: take any `ARM_Compiler_*\bin\fromelf.exe`.
  try {
    for (const entry of readdirSync(join(root, "ARM"))) {
      if (!/^ARM_Compiler_/i.test(entry)) continue;
      const candidate = join(root, "ARM", entry, "bin", isExe ? "fromelf.exe" : "fromelf");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* no ARM directory: not a Keil install root */
  }
  return null;
}