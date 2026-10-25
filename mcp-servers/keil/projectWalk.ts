/**
 * `detectProject` 向上查找的边界（纯函数，便于单测）。
 *
 * 原先两轮循环都只写死「最多 5 层」，没有任何依据说明第 5 层为什么不是工程根。
 * 在 `%TEMP%` 下面工作或跑测试时，这个上界会把临时目录也读进去：本机 `%TEMP%`
 * 有 31,736 个同级条目，向上走到那一层时一次 `detectProject` 实测 2,654 ms，
 * 其中 2,741 ms 花在 `findProjectFileAbove` 对 31,745 个条目逐个 `statSync`
 * 上（同一层的 `readdirSync` 只要 13 ms）。真实用户从深目录启动也要付这笔钱。
 *
 * 停下来的依据，每条都是「这一层不可能是包含起点的工程根」：
 * - **盘根**：再往上没有目录了。
 * - **用户家目录及其祖先**：工程不会以整个 home 为根；`C:\Users\<name>` 与
 *   `C:\Users` 都只装别的目录。
 * - **临时目录及其祖先**：`%TEMP%`、`AppData\Local`、`AppData` 装的是别人
 *   项目的副本。**它们下面不算**：`%TEMP%\myproj` 可以是一个真实工程。
 * - **系统目录及其子树**：`C:\Windows`、`C:\Program Files`、`C:\ProgramData`
 *   不长工程，其子树也不会是「包含起点」的项目根。
 * - **单层条目数超过 `MAX_SIBLING_ENTRIES`**：工程根不会有几千个同级条目，
 *   有的话说明这里是 `%TEMP%`、下载目录或构建产物目录，不是项目。再往上查
 *   没有收益，而代价是逐条 `stat`。
 *
 * 边界只管**祖先**：`start` 本身总要按原语义检查一遍（用户就站在那儿，那正
 * 是他问的目录），只是条目数超阈值时不再向下逐个子目录探测。
 */

import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** 向上查找最多走几层。`start` 自己算第一层。 */
export const MAX_WALK_DEPTH = 5;

/**
 * 单层目录里最多容纳多少个同级条目，超过就不再把它当工程根，也不再向上走。
 *
 * 2,000 的依据：Keil / IAR 工程根通常只有几十个条目；本机一个真实工程根
 * （CORE / HALLIB / OBJ / USER 加头文件）不到 40 个。`%TEMP%` 有 31,736 个，
 * 差三个数量级，不需要更精确的阈值。
 */
export const MAX_SIBLING_ENTRIES = 2000;

/** Windows 上路径大小写不敏感：`c:\windows` 与 `C:\Windows` 是同一层。 */
function normalize(dir: string): string {
  const resolved = resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `candidate` is `root` or under it, compared as whole segments. */
export function insideRoot(candidate: string, root: string): boolean {
  const child = normalize(candidate);
  const parent = normalize(root);
  // 盘根自带结尾分隔符（`c:\`、`/`），再拼一个会变成 `c:\\`，永远匹配不上。
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(prefix);
}

/** POSIX 上的系统目录；Windows 从环境变量取，见 `systemDirs`。 */
const POSIX_SYSTEM_DIRS = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib64", "/var", "/proc", "/sys", "/dev", "/boot"];

/**
 * 系统目录从环境变量取，而不是写死 `C:\`：Windows 可以装在别的盘，
 * 写死会把真实安装位置漏掉。
 */
function systemDirs(): string[] {
  if (process.platform !== "win32") return POSIX_SYSTEM_DIRS;
  const env = process.env;
  const fromEnv = [env.SystemRoot, env.windir, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData];
  const dirs = fromEnv.filter((dir): dir is string => Boolean(dir && dir.trim().length > 0));
  return dirs.length > 0 ? dirs : ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"];
}

/** `C:\`、`/`：一个退化成盘根的边界会让每个路径都算「在它下面」。 */
function isFilesystemRoot(dir: string): boolean {
  return normalize(dir) === normalize(parse(resolve(dir)).root);
}

/**
 * `dir` 是不是 `boundary` 或它的祖先之一；`boundary` 退化成盘根时不算。
 *
 * 容器里 `HOME=/`、`TMPDIR=/` 很常见。盘根本身已经是边界（见 `isWalkBoundary`
 * 第一条），若再按「祖先」算进来，`C:\` 就会匹配任何路径——向上查找在 `start`
 * 之后立刻停住，真实祖先工程全被漏掉。单独导出是为了能直接测这条规则：
 * `os.homedir()` / `os.tmpdir()` 在 Node 里各自缓存，改环境变量造不出这个场景。
 */
export function isAncestorOrSelf(boundary: string, dir: string): boolean {
  if (isFilesystemRoot(boundary)) return false;
  return insideRoot(boundary, dir);
}

/**
 * 这一层本身就不可能是包含起点的工程根，与它有多少条目无关。
 *
 * 只管「位置」：盘根、家目录及其祖先、临时目录及其祖先、系统目录及其子树。
 *
 * 两个方向是**故意不同**的：
 * - home / tmp 只算**它们自己与它们的祖先**（`C:\Users\mogen`、`C:\Users`、
 *   `%TEMP%`、`AppData\Local`）。它们**下面**的目录照常走：工程完全可以在
 *   `%TEMP%\myproj` 里（本仓库的测试就是这样跑的），把子树也算进去会让那些
 *   工程全部检测不到。
 * - 系统目录算**它自己与子树**：`C:\Windows\System32` 里不会有「包含起点」
 *   的工程根，没必要逐层走下去。
 */
export function isWalkBoundary(dir: string): boolean {
  const here = normalize(dir);
  // 盘根：`C:\`、`/`、UNC 共享根。再往上没有目录。
  if (isFilesystemRoot(here)) return true;
  // 家目录 / 临时目录及其祖先：`isAncestorOrSelf(home, here)` 问的是「home
  // 是不是 here 或它下面」，即 here 是 home 的祖先之一（含自身）。
  if (isAncestorOrSelf(homedir(), here) || isAncestorOrSelf(tmpdir(), here)) return true;
  // 系统目录及其子树：`insideRoot(here, system)` 问的是「here 是不是在系统
  // 目录下面」。
  return systemDirs().some((system) => insideRoot(here, system));
}

/**
 * 是否该停止向上走：位置上是边界，或这一层条目多到不像工程根。
 *
 * `entryCount` 是这一层 `readdirSync` 的长度。
 */
export function shouldStopWalkingUp(dir: string, entryCount: number): boolean {
  return isWalkBoundary(dir) || entryCount > MAX_SIBLING_ENTRIES;
}

/**
 * `root` 下通往 `start` 的那第一段目录名；`start` 不在 `root` 下时返回 null。
 *
 * 向上查找时「下一层」只有一支有意义：`root` 是多个工程的父目录时，其他分支
 * 都是兄弟工程，采用它们正是 `keil_project` 读写别人工程的成因。直接算出这
 * 一段，比列一遍 `root` 再对每个条目 `stat` 便宜得多：在 `%TEMP%` 上后者是
 * 31,745 次 stat。
 */
export function branchToward(root: string, start: string): string | null {
  const rel = relative(resolve(root), resolve(start));
  if (!rel || isAbsolute(rel)) return null;
  const first = rel.split(sep)[0];
  return first && first !== ".." ? first : null;
}

export interface WalkLevel {
  dir: string;
  /** 这一层的条目名，已读好，供调用方复用，免得对同一层再 `readdir` 一次。 */
  entries: string[];
}

/**
 * 从 `start` 起向上的各层，已按边界规则截断。
 *
 * `list` 注入目录读取（生产传 `readdirSync` 的安全包装），这样边界规则可以
 * 在没有真实文件系统的测试里断言「某一层根本没有被读过」。读不了的目录按
 * 空目录处理：检测不上报失败，构建会报真实原因。
 */
export function walkLevels(
  start: string,
  list: (dir: string) => string[],
  maxDepth: number = MAX_WALK_DEPTH,
): WalkLevel[] {
  const levels: WalkLevel[] = [];
  const first = resolve(start);
  let dir = first;
  for (let depth = 0; depth < maxDepth; depth++) {
    // 祖先要先判断边界再读：`%TEMP%` 这一层读一次也要 13 ms，而它无论如何
    // 都不该被当成工程根。`start` 自己总是要读的。
    if (dir !== first && isWalkBoundary(dir)) break;
    const entries = list(dir);
    levels.push({ dir, entries });
    if (shouldStopWalkingUp(dir, entries.length)) break;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return levels;
}
