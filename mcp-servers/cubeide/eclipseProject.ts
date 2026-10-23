import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Eclipse CDT / CubeIDE 工程识别与构建封装。
 *
 * 工程的判据是同目录的 `.project` + `.cproject`（Eclipse CDT 的标准对）。
 * 两条从 findUvprojx 带过来的硬规则同样适用：
 * - 备份文件绝不能当工程；
 * - 不钻进输出目录（OBJ / build / Debug / Release / 点开头目录）。
 */

const SKIP_DIRS = /^(OBJ|obj|build|Build|Debug|Release|DebugConfig|RTE|\..*|node_modules)$/i;

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface EclipseProject {
  /** 工程目录（含 .project 与 .cproject）。 */
  dir: string;
  projectFile: string;
  cprojectFile: string;
  /** `<name>` from .project — headless -build 用的是这个名字。 */
  name: string;
}

/** 解析 .project 的 `<name>`；headlessbuild 用它来选工程。 */
export function readEclipseName(projectFile: string): string | null {
  try {
    const text = readFileSync(projectFile, "utf8");
    // .project 是无 BOM 的 ASCII/UTF-8 XML，name 在最前面一段。
    const match = /<name>([^<]+)<\/name>/.exec(text);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * 在目录里找 Eclipse CDT 工程（先本层，再下一层），多个时全部返回——
 * 调用方对 mixed 的情况需要把它们列出来，而不是只拿第一个。
 */
export function findEclipseProjects(root: string): EclipseProject[] {
  const at = (dir: string): EclipseProject[] => {
    const projectFile = join(dir, ".project");
    const cprojectFile = join(dir, ".cproject");
    if (!existsSync(projectFile) || !existsSync(cprojectFile)) return [];
    const name = readEclipseName(projectFile);
    if (!name) return [];
    return [{ dir, projectFile, cprojectFile, name }];
  };
  const found = at(root);
  if (found.length > 0) return found;
  const out: EclipseProject[] = [];
  for (const name of readdirSafe(root).filter((entry) => !SKIP_DIRS.test(entry)).sort((a, b) => a.localeCompare(b))) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(...at(dir));
  }
  return out;
}
