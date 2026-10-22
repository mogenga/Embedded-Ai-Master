import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 在目录里找 `.uvprojx`（先本层，再下一层）。
 *
 * 摘自 Prometheus/src/embedded/project.ts 的 `findProjectFile` 调用契约，
 * 只保留 Keil 这一条正则 —— 完整的 11 种工程识别（project.ts 659 行）不随迁移。
 * 两条实测出来的规则必须保留：
 * - 备份文件绝不能当工程打开：`TOUCH.uvprojx.orig` 也匹配 `*.uvprojx*`；
 * - 不钻进输出目录：`OBJ\` 里的旧副本不是工程。
 */
export function findUvprojx(root: string): string | null {
  const pattern = /\.uvprojx?$/i;
  const matches = (dir: string): string[] =>
    readdirSafe(dir)
      .filter((name) => pattern.test(name) && !/\.(bak|orig|backup|save|tmp)$/i.test(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => join(dir, name));

  const atRoot = matches(root);
  if (atRoot.length > 0) return atRoot[0];

  const subdirs = readdirSafe(root)
    .filter((name) => !/^(OBJ|obj|build|Build|DebugConfig|RTE|\.|node_modules)$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  for (const name of subdirs) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = matches(dir);
    if (found.length > 0) return found[0];
  }
  return null;
}