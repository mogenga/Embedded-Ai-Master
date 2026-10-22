import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { mkdir, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolPathError, resolveInWorkdir } from "../tools/path-safety.js";
import { isWindowsReservedName } from "../tools/pipeline.js";
import type { Skill, SkillProblem, SkillScope } from "./types.js";

export type { Skill, SkillProblem, SkillScope } from "./types.js";

/**
 * 技能（可复用提示词模板）的磁盘存储层。
 *
 * 职责边界只有「存储、解析、校验」：斜杠命令的展开与发送由渲染层负责，内核不认
 * `$ARGUMENTS`，也不执行技能正文。因此这里没有任何领域逻辑，也不产生副作用之外的
 * 行为——写文件就是写文件。
 *
 * **四个根，两两成对**，优先级从低到高：
 *
 * | 优先级 | 位置 | 谁写的 |
 * |---|---|---|
 * | 1 | `<home>/skills/` | 本应用（设置页保存到这里） |
 * | 2 | `<agentsHome>/skills/` | skill CLI（`~/.agents`，目录式 `<name>/SKILL.md`） |
 * | 3 | `<workdir>/.harness/skills/` | 本应用（项目级） |
 * | 4 | `<workdir>/.agents/skills/` | skill CLI（项目级） |
 *
 * 项目级压过用户级，同一层里 `.agents` 压过应用的库：`/name` 指向哪一个，
 * 应当由「最近的范围」与「CLI 管理的这一份」共同决定，而不是由哪个库先被列出来。
 * 未提供 workdir 时项目作用域**没有根目录**，写入必须显式失败，不能悄悄落到用户目录
 * ——那会让「项目专属」的技能对所有项目生效。
 */

export interface SkillRoots {
  /** `$HARNESS_HOME`：应用自己的库（`<home>/skills/`），也是设置页的写入位置。 */
  home: string;
  workdir?: string;
  /**
   * skill CLI 的根（`<agentsHome>/skills/`），默认 `os.homedir()/.agents`。
   *
   * 单独列出来是因为它**不在 `$HARNESS_HOME` 下面**：CLI 装在所有项目共享的
   * 用户目录里。测试必须显式传一个临时目录（D-170 的同一条理由：默认值会
   * 读到跑测试那个人的真实技能）。
   */
  agentsHome?: string;
}

/** 一个技能根，按优先级从低到高排。 */
interface SkillRoot {
  dir: string;
  scope: SkillScope;
  /** 应用的库还是 skill CLI 的库——决定写入目标与删除方式。 */
  kind: "app" | "cli";
}

export type SkillStoreErrorCode = "invalid_skill" | "skill_unreadable" | "skill_write_failed";

export class SkillStoreError extends Error {
  readonly code: SkillStoreErrorCode;
  readonly detail?: unknown;

  constructor(code: SkillStoreErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "SkillStoreError";
    this.code = code;
    this.detail = detail;
  }
}

export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

// 渲染层的内置动词优先于技能；同名技能因此永远调不到，读盘时就当作坏文件报出来。
export const BUILTIN_COMMAND_NAMES: readonly string[] = ["clear", "context", "compact"];

// Windows 保留名复用 src/tools/pipeline.ts 的 isWindowsReservedName，不再写第二份正则。
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_ARGUMENT_HINT_CHARS = 100;

const SKILL_FILE_SUFFIX = ".md";
/** 目录式技能的入口文件名（`~/.agents/skills/<name>/SKILL.md`）。 */
export const SKILL_ENTRY_FILE = "SKILL.md";
const FRONTMATTER_FENCE = "---";
const BUILTIN_COMMAND_SET = new Set(BUILTIN_COMMAND_NAMES);

interface ResolvedRoots {
  /** 按优先级从低到高：读的时候后面的覆盖前面的。 */
  roots: SkillRoot[];
}

interface SkillFields {
  description: string;
  argumentHint: string;
  body: string;
}

type ParseResult = { ok: true; value: SkillFields } | { ok: false; message: string };

function invalidSkill(message: string, detail?: unknown): SkillStoreError {
  return new SkillStoreError("invalid_skill", message, detail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stripBom(text: string): string {
  const bom = String.fromCharCode(0xfeff);
  return text.startsWith(bom) ? text.slice(bom.length) : text;
}

/**
 * 换行统一为 LF：同一个技能在 Windows / POSIX 上读出的正文必须一字不差，
 * 否则「写进去再读出来」在跨平台仓库里不成立。
 */
function normaliseNewlines(text: string): string {
  return stripBom(text).replace(/\r\n?/g, "\n");
}

/**
 * skill CLI 的默认根：`~/.agents`。
 *
 * **测试环境例外（与 D-170 同一条理由）**：在测试进程里，没有显式传
 * `agentsHome` 就直接抛错，而不是返回跑测试那个人的真实目录。第一次接上
 * 这个根时测试确实读到了开发机的 20 个技能，所有断言一起变红——把「忘了
 * 隔离」变成硬失败，比让它读穿到用户目录更诚实（R3）。
 */
function defaultAgentsHome(env: NodeJS.ProcessEnv): string {
  const configured = env.AGENTS_HOME?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const runner = env.VITEST?.trim() !== undefined && env.VITEST?.trim() !== ""
    ? "VITEST"
    : env.NODE_ENV === "test"
      ? "NODE_ENV=test"
      : undefined;
  if (runner !== undefined) {
    throw invalidSkill(
      `resolveRoots() 拒绝在测试环境返回默认技能目录：检测到 ${runner}，但没有传 agentsHome。`
      + "测试必须显式传临时目录，否则会读到用户的真实技能（同 D-170）。",
    );
  }
  return path.join(os.homedir(), ".agents");
}

function resolveRoots(roots: SkillRoots): ResolvedRoots {
  if (typeof roots?.home !== "string" || roots.home.length === 0) {
    throw invalidSkill("技能根目录 home 必须是非空字符串");
  }
  const workdir = roots.workdir;
  if (workdir !== undefined && (typeof workdir !== "string" || workdir.length === 0)) {
    throw invalidSkill("技能根目录 workdir 必须是非空字符串（不提供则项目作用域不可用）");
  }
  const agentsHome = roots.agentsHome ?? defaultAgentsHome(process.env);
  if (typeof agentsHome !== "string" || agentsHome.length === 0) {
    throw invalidSkill("技能根目录 agentsHome 必须是非空字符串");
  }
  // 顺序就是优先级：读的时候后面的覆盖前面的。项目级压过用户级，
  // 同一层里 skill CLI 的库压过应用自己的库。
  const ordered: SkillRoot[] = [
    { dir: path.join(roots.home, "skills"), scope: "user", kind: "app" },
    { dir: path.join(agentsHome, "skills"), scope: "user", kind: "cli" },
    ...(workdir === undefined
      ? []
      : [
          { dir: path.join(workdir, ".harness", "skills"), scope: "project", kind: "app" },
          { dir: path.join(workdir, ".agents", "skills"), scope: "project", kind: "cli" },
        ] satisfies SkillRoot[]),
  ];
  return { roots: ordered };
}

/**
 * 写入目标：**只考虑应用自己的库**。
 *
 * 读的时候 `.agents` 排在前面（它可以遮住应用的库），但写入是一个不同的
 * 问题：CLI 的目录归 CLI 管，我们往里写一份，下一次 `skill update` 就会
 * 覆盖掉，而且锁文件会与实际内容脱节。所以写永远落在 app 根上；被 CLI 遮住
 * 的情况由 `writeCollision` 单独拒绝并说明。
 *
 * 把这两件事合成一个「rootForScope」是第一次实现时的错误：它返回读路径上
 * 优先级最高的根，于是写操作跑去写 `~/.agents/skills/`。
 */
function writeRootForScope(resolved: ResolvedRoots, scope: SkillScope): SkillRoot {
  const root = resolved.roots.find((entry) => entry.scope === scope && entry.kind === "app");
  if (root !== undefined) return root;
  // 显式失败而不是退回用户目录：项目技能悄悄变成全局技能，比报错更难发现。
  throw invalidSkill("项目作用域技能需要 workdir，未提供时没有可写入的目录");
}

function nameProblem(name: string): string | undefined {
  if (!SKILL_NAME_PATTERN.test(name)) {
    return `技能名 ${JSON.stringify(name)} 非法：须匹配 ${SKILL_NAME_PATTERN.source}`;
  }
  if (isWindowsReservedName(name)) {
    return `技能名 ${JSON.stringify(name)} 非法：是 Windows 保留名，无法可靠落盘`;
  }
  if (BUILTIN_COMMAND_SET.has(name)) {
    // 渲染层的内置动词优先，这个技能永远轮不到执行。
    return `技能名 ${JSON.stringify(name)} 与内置命令同名，永远无法被调用`;
  }
  return undefined;
}

function assertValidName(name: unknown): string {
  if (typeof name !== "string") {
    throw invalidSkill(`技能名必须是字符串: ${JSON.stringify(name)}`);
  }
  const problem = nameProblem(name);
  if (problem !== undefined) throw invalidSkill(problem);
  return name;
}

function parseScope(value: unknown, fallback: SkillScope | undefined): SkillScope {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw invalidSkill("技能作用域必须是 user 或 project");
  }
  if (value === "user" || value === "project") return value;
  throw invalidSkill(`技能作用域非法: ${JSON.stringify(value)}（只支持 user / project）`);
}

/**
 * `scope` 为空串时 path 会把 `<name>.md` 拼成相对路径，所以文件名一律经
 * resolveInWorkdir 解析并确认包含关系：即便名称校验被绕过，也走不出根目录。
 */
function skillFilePath(root: string, name: string): string {
  try {
    return resolveInWorkdir(root, `${name}${SKILL_FILE_SUFFIX}`);
  } catch (error) {
    if (error instanceof ToolPathError) {
      throw invalidSkill(`技能路径越界: ${JSON.stringify(name)}（${error.message}）`, error);
    }
    throw error;
  }
}

/** 剥掉一对匹配的引号；只剥一对，`""abc""` 读回 `"abc"`，因此引号值可以往返。 */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 解析「可选 frontmatter + 正文」。
 *
 * 没有 frontmatter 的文件是合法技能（整份文件就是正文）；**未闭合**的 frontmatter
 * 是坏文件——把 `---` 之后的全部内容当正文，等于把半个 YAML 头当提示词发出去，
 * 读不出来就必须说读不出来（R3）。
 */
function parseSkillText(text: string): ParseResult {
  const lines = normaliseNewlines(text).split("\n");
  if ((lines[0] ?? "").trim() !== FRONTMATTER_FENCE) {
    return { ok: true, value: { description: "", argumentHint: "", body: lines.join("\n").trim() } };
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === FRONTMATTER_FENCE) {
      end = index;
      break;
    }
  }
  if (end < 0) {
    return {
      ok: false,
      message: "frontmatter 未闭合：文件以 --- 开头，但找不到结束的 ---",
    };
  }

  let description = "";
  let argumentHint = "";
  // 正在读一个块标量（`description: >`）时，这里记着它的键名与风格。
  let openBlock: { key: string; style: ">" | "|" } | undefined;
  let blockLines: string[] = [];

  const assign = (key: string, value: string): void => {
    if (key === "description") description = value;
    else argumentHint = value;
  };

  /** 块读完了：`|` 保留换行，`>` 把行尾换行折成空格（YAML 语义）。 */
  const closeBlock = (): void => {
    if (openBlock === undefined) return;
    const joined = blockLines.join("\n");
    assign(
      openBlock.key,
      openBlock.style === "|"
        ? joined.trim()
        : joined.replace(/([^\n])\n(?=[^\n])/g, "$1 ").trim(),
    );
    openBlock = undefined;
    blockLines = [];
  };

  for (const line of lines.slice(1, end)) {
    if (openBlock !== undefined) {
      // 空行属于块（YAML 里它是段落分隔，折叠时可变成换行）；以空白开头的
      // 续行也属于块，取去掉行首缩进后的内容。其余任何行都意味着块结束。
      if (line.trim() === "") {
        blockLines.push("");
        continue;
      }
      if (/^\s/.test(line)) {
        blockLines.push(line.replace(/^\s+/, ""));
        continue;
      }
      closeBlock();
      // 落到下面，把这个不带缩进的行当普通键读。
    }
    // 没有冒号的行不是键值对，按额外元数据忽略（与未知键同等对待）。
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    // 只认这两个键，其余是额外元数据，不是故障。键名大小写不敏感：
    // 写了 `Description:` 却静默丢失描述，比宽松匹配更伤人。
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key !== "description" && key !== "argument-hint") continue;
    const raw = line.slice(colon + 1).trim();
    // `>` / `|` 后面可能还跟着 chomping 指示符（`>-`、`|+`），常出现在
    // 从别的工具导出的技能里；去掉指示符再判断，否则会把它当成字面值。
    const style = raw.replace(/[+-]\d*$/, "").replace(/\d+$/, "");
    if (style === ">" || style === "|") {
      openBlock = { key, style };
      blockLines = [];
      continue;
    }
    assign(key, unquote(raw));
  }
  closeBlock();
  return {
    ok: true,
    value: { description, argumentHint, body: lines.slice(end + 1).join("\n").trim() },
  };
}

function readScope(
  dir: string | undefined,
  scope: SkillScope,
  problems: SkillProblem[],
): Skill[] {
  if (dir === undefined) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // 目录不存在 = 用户还没建技能，是零个技能而不是错误；其余 fs 错误必须显式报出。
    if (isFileNotFound(error)) return [];
    problems.push({ file: dir, message: `技能目录读取失败（${errorMessage(error)}）` });
    return [];
  }

  const skills: Skill[] = [];

  /**
   * 读一个入口文件，产出技能、problem，或「没法读」。
   *
   * 平铺文件与目录式技能共用这一段：入口在哪由调用方决定，校验与解析
   * 必须完全一致，否则两种布局会各自漂移出不同的规则。
   *
   * 返回 `true` 表示真的产出了一个技能——同名歧义只在两份都能读时才是
   * 歧义；一份坏文件不该把另一份好的顶掉。
   */
  const load = (file: string, name: string): boolean => {
    const problem = nameProblem(name);
    if (problem !== undefined) {
      problems.push({ file, message: problem });
      return false;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      problems.push({ file, message: `技能文件读取失败（${errorMessage(error)}）` });
      return false;
    }
    const parsed = parseSkillText(text);
    if (!parsed.ok) {
      problems.push({ file, message: parsed.message });
      return false;
    }
    skills.push({ name, scope, ...parsed.value });
    return true;
  };

  /**
   * 目录式技能的入口：`<name>/SKILL.md`。
   *
   * `~/.agents/skills` 由 skill CLI 管理，就是这个布局。目录里其它文件——
   * `scripts/`、`references/`——一律不读：它们是给别的宿主按需打开的附件，
   * 拼进正文会让一次 `/name` 把整个技能包塞进上下文。
   */
  const loadDirectory = (dirPath: string, name: string): void => {
    const entryFile = path.join(dirPath, SKILL_ENTRY_FILE);
    let info;
    try {
      info = lstatSync(entryFile);
    } catch (error) {
      if (isFileNotFound(error)) {
        // 一个占着技能名字的目录却没有入口文件：这是坏布局，不是「没有
        // 技能」。静默跳过会让人以为那个技能不存在，而它明明在那儿。
        problems.push({ file: dirPath, message: `目录式技能缺少入口文件 ${SKILL_ENTRY_FILE}` });
        return;
      }
      problems.push({ file: entryFile, message: `技能文件读取失败（${errorMessage(error)}）` });
      return;
    }
    if (info.isSymbolicLink()) {
      problems.push({ file: entryFile, message: "符号链接不会被当作技能读取（可能指向技能目录之外）" });
      return;
    }
    if (!info.isFile()) {
      problems.push({ file: entryFile, message: `${SKILL_ENTRY_FILE} 不是普通文件` });
      return;
    }
    load(entryFile, name);
  };

  // 两趟而不是一趟：`readdir` 的顺序由文件系统决定，一趟边读边判会让
  // 「平铺文件优于同名目录」变成随机结果。先读全部平铺文件，再读目录，
  // 顺序就由这里决定而不是由 NTFS 决定。
  const directories: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      directories.push({ name: entry.name, path: path.join(dir, entry.name) });
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(SKILL_FILE_SUFFIX)) continue;
    // 特殊文件（FIFO、设备节点）不是技能文件。
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    const name = entry.name.slice(0, entry.name.length - SKILL_FILE_SUFFIX.length);
    // 符号链接不跟随：项目技能目录在别人的仓库里，一个指向技能根之外的 `.md`
    // 链接会把那个文件的内容当成提示词正文随下一次 `/名称` 发出去。规则与
    // `listDirectory` / `listSessionArtifacts` 一致，但这里要**报出来**而不是
    // 静默跳过——文件确实在那儿，说它不存在会让人查错方向。
    if (entry.isSymbolicLink()) {
      problems.push({ file, message: "符号链接不会被当作技能读取（可能指向技能目录之外）" });
      continue;
    }
    load(file, name);
  }

  const loaded = new Set(skills.map((skill) => skill.name));
  for (const directory of directories) {
    const entryFile = path.join(directory.path, SKILL_ENTRY_FILE);
    if (loaded.has(directory.name)) {
      // 平铺文件优于同名目录：它是显式的 `<name>.md`，而目录要再猜里面是
      // 什么。两者同时存在是真实的歧义，所以报出来——否则被忽略的那份会
      // 让人以为自己编辑的是另一份。
      problems.push({
        file: entryFile,
        message: `已有一个同名的 ${directory.name}${SKILL_FILE_SUFFIX}，这个目录被忽略`,
      });
      continue;
    }
    const before = skills.length;
    loadDirectory(directory.path, directory.name);
    if (skills.length > before) loaded.add(directory.name);
  }
  return skills;
}

/**
 * 读全部技能。单个坏文件只进 `problems`，不会让整张表消失——用户得能看见
 * 「哪个文件坏了、为什么」，同时继续用其余的技能。
 */
export function readSkills(roots: SkillRoots): { skills: Skill[]; problems: SkillProblem[] } {
  const resolved = resolveRoots(roots);
  const problems: SkillProblem[] = [];
  const byName = new Map<string, Skill>();
  // 按优先级从低到高遍历，后面的覆盖前面的：项目级压过用户级，同一层里
  // skill CLI 的库压过应用自己的库。覆盖本身不报——那是既定规则。
  for (const root of resolved.roots) {
    for (const skill of readScope(root.dir, root.scope, problems)) {
      byName.set(skill.name, skill);
    }
  }
  const skills = [...byName.values()].sort((left, right) => compareText(left.name, right.name));
  problems.sort((left, right) => compareText(left.file, right.file));
  return { skills, problems };
}

function optionalText(value: unknown, field: string, maxChars: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw invalidSkill(`${field} 必须是字符串`);
  const text = value.trim();
  if (text.length > maxChars) {
    throw invalidSkill(`${field} 超过 ${maxChars} 字符上限（当前 ${text.length}）`);
  }
  // 换行会撑破单行 frontmatter，写进去就读不回来，因此在写入前就拒绝。
  if (/[\r\n]/.test(text)) throw invalidSkill(`${field} 不能包含换行`);
  return text;
}

function requireBody(value: unknown): string {
  if (typeof value !== "string") throw invalidSkill("技能正文必须是字符串");
  const body = normaliseNewlines(value).trim();
  // 空正文 = 一条空消息。这个承诺兑现不了，写入时就拒绝，而不是留给运行时。
  if (body === "") throw invalidSkill("技能正文不能为空");
  return body;
}

function needsQuotes(value: string): boolean {
  if (value === "") return true;
  if (value !== value.trim()) return true;
  if (value.includes(":") || value.includes("#")) return true;
  const first = value[0];
  const last = value[value.length - 1];
  // 首尾同引号的值若不包裹，读回时会被剥掉这对引号（解析器只剥一对匹配引号）。
  return (first === '"' || first === "'") && last === first;
}

function formatFrontmatterValue(value: string): string {
  return needsQuotes(value) ? `"${value}"` : value;
}

/** 只序列化两个已知键，顺序固定；往返（write → read）因此是恒等的。 */
function serialiseSkill(skill: Skill): string {
  return [
    FRONTMATTER_FENCE,
    `description: ${formatFrontmatterValue(skill.description)}`,
    `argument-hint: ${formatFrontmatterValue(skill.argumentHint)}`,
    FRONTMATTER_FENCE,
    `${skill.body}\n`,
  ].join("\n");
}

// 临时文件 + fsync + rename：断电后要么看到旧技能，要么看到新技能，不会留下半截文件。
async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(tmpPath, text, { encoding: "utf8", flag: "wx" });
    const handle = await open(tmpPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new SkillStoreError(
      "skill_write_failed",
      `技能写入失败: ${filePath}（${errorMessage(error)}）`,
      error,
    );
  }
}

export interface WriteSkillInput {
  name: unknown;
  description?: unknown;
  argumentHint?: unknown;
  scope?: unknown;
  body: unknown;
}

/**
 * 写入一个技能并返回归一化后的结果（description/argumentHint 缺省为空串，
 * body 已裁掉首尾空白）。校验全部在落盘之前完成：非法输入不会碰到已有文件。
 *
 * **写入只落在应用的库里**（`<home>/skills/` 或 `<workdir>/.harness/skills/`），
 * 从不改 skill CLI 的目录——那是 CLI 管的，别人 `skill update` 一次就会覆盖，
 * 而我们的写入会变成一次静默丢失。因此当同名技能来自优先级更高的 `.agents`
 * 根时，写进去**看不见**（读的时候被覆盖），这里直接拒绝并说出那个文件的路径，
 * 而不是让用户以为保存成功了（R3）。
 */
export async function writeSkill(roots: SkillRoots, input: WriteSkillInput): Promise<Skill> {
  const resolved = resolveRoots(roots);
  const name = assertValidName(input.name);
  const scope = parseScope(input.scope, "user");
  const body = requireBody(input.body);
  const description = optionalText(input.description, "description", MAX_DESCRIPTION_CHARS);
  const argumentHint = optionalText(input.argumentHint, "argumentHint", MAX_ARGUMENT_HINT_CHARS);
  writeCollision(resolved, name, scope, "写入");
  const filePath = skillFilePath(writeRootForScope(resolved, scope).dir, name);
  const skill: Skill = { name, description, argumentHint, scope, body };
  await writeTextAtomic(filePath, serialiseSkill(skill));
  return skill;
}

/**
 * 删除成功返回 true；文件本来就不存在返回 false（不是错误，重复删除是幂等的）。
 *
 * 删除的是**读的时候真正生效的那一份**，不是应用库里同名的那一份：用户点的是
 * 列表里的一行，那一行代表的是解析结果。删掉一个被 `.agents` 遮住的应用库副本，
 * 只会让这一行原地不动——看起来像删除失败了。
 */
export async function removeSkill(
  roots: SkillRoots,
  input: { name: unknown; scope: unknown },
): Promise<boolean> {
  const resolved = resolveRoots(roots);
  const name = assertValidName(input.name);
  const scope = parseScope(input.scope, undefined);
  const target = resolveExisting(resolved, name, scope);
  if (target === undefined) return false;
  if (target.kind === "cli") {
    // CLI 的目录归 CLI 管：删掉之后 `skill update` 会重新装回来，而且
    // 锁文件（`.skill-lock.json`）会与实际内容脱节。说清楚，不给假成功。
    throw invalidSkill(
      `/${name} 由 skill CLI 管理（${target.dir}），请在 CLI 里卸载，而不是在这里删除`,
    );
  }
  const filePath = skillFilePath(target.dir, name);
  // 目录式技能在应用库里不该出现（我们只写平铺文件），但手工放进去的可能存在：
  // 删掉入口文件会让目录变成「缺 SKILL.md」的 problem，所以连目录一起删。
  // 目标只有 `SKILL.md` 这一个文件，不递归——不能因为名字叫清理就把旁边的文件带走。
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) {
      const dirPath = path.join(target.dir, name);
      const dirEntry = path.join(dirPath, SKILL_ENTRY_FILE);
      try {
        await unlink(dirEntry);
        await rm(dirPath, { recursive: false, force: false });
        return true;
      } catch (dirError) {
        if (isFileNotFound(dirError)) return false;
        throw new SkillStoreError(
          "skill_write_failed",
          `技能删除失败: ${dirEntry}（${errorMessage(dirError)}）`,
          dirError,
        );
      }
    }
    // 删除属于写侧：错误码沿用 skill_write_failed，避免为一次 unlink 再造一类语义。
    throw new SkillStoreError(
      "skill_write_failed",
      `技能删除失败: ${filePath}（${errorMessage(error)}）`,
      error,
    );
  }
}

/**
 * 写入前查一次：同名技能是否已经由更高优先级的根提供。
 *
 * 只有 `.agents` 会遮住应用的库（同一层里它排后面），所以只需要看 CLI 根。
 * 命中的话写入是不可见的，必须拒绝。
 */
function writeCollision(
  resolved: ResolvedRoots,
  name: string,
  scope: SkillScope,
  action: string,
): void {
  for (const root of resolved.roots) {
    if (root.scope !== scope || root.kind !== "cli") continue;
    // 报出去的必须是**真实存在的那条路径**：平铺文件与目录式技能的入口
    // 不是同一个文件名，笼统写成 `<dir>/<name>` 会让人照着去找一个不存在
    // 的文件。
    for (const candidate of [
      path.join(root.dir, name + SKILL_FILE_SUFFIX),
      path.join(root.dir, name, SKILL_ENTRY_FILE),
    ]) {
      if (!existsSync(candidate)) continue;
      throw invalidSkill(
        `${action}会被遮蔽：${candidate} 已由 skill CLI 提供且优先级更高，`
        + "在设置页保存不会生效。请直接编辑那份文件，或换一个名字",
      );
    }
  }
}

/** 读的时候真正生效的那一份（用于删除），没有就返回 undefined。 */
function resolveExisting(
  resolved: ResolvedRoots,
  name: string,
  scope: SkillScope,
): SkillRoot | undefined {
  // 从高优先级往低找：第一个存在文件的根就是 `/name` 实际打开的那份。
  for (const root of [...resolved.roots].reverse()) {
    if (root.scope !== scope) continue;
    if (existsSync(path.join(root.dir, name + SKILL_FILE_SUFFIX))) return root;
    if (existsSync(path.join(root.dir, name, SKILL_ENTRY_FILE))) return root;
  }
  return undefined;
}
