import { readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

/**
 * 「知识库在哪」与「它下面有什么」——设置页展示用的只读定位与列目录。
 *
 * 单独成层的原因：真实语料不在 `$HARNESS_HOME` 下，而在 MCP server 的
 * `KB_ROOT` 指向的目录里。端点若只扫 `$HARNESS_HOME/kb`，对真实用户返回的
 * 「空知识库」就是假话（R3）。
 *
 * 这一层只回答两个事实问题，不做领域逻辑：不解析 `index.yaml`、不建索引、
 * 不检索。凡是「根从哪来」「为什么是空的」都如实回报，让前端能区分
 * 「没定位到」与「定位到了但目录是空的」。
 */

export interface KbNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: KbNode[];
}

export type KbRootSource = "env" | "mcp.json" | "default" | "none";

export interface KbRootLocation {
  root: string;
  source: KbRootSource;
  /** 给用户看的一句话：为什么选这个根，或者为什么它是空的。 */
  note?: string;
}

export interface ResolveKbRootOptions {
  /** `$HARNESS_HOME`；不传则没有 mcp.json 这一级可查。 */
  harnessHome?: string;
  /** 仓库根：默认语料目录 `<repoRoot>/mcp-servers/kb/kb` 的基准。 */
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ScanKbOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxFiles?: number;
}

export interface KbScanResult {
  tree: KbNode[];
  /** 只数 `.md`；`truncated` 为真时它是实测到的下界，不是精确值。 */
  fileCount: number;
  indexPresent: boolean;
  truncated: boolean;
}

/** 根的直接子项为第 1 层；到第 8 层不再展开（D-064 的既有口径）。 */
export const KB_MAX_DEPTH = 8;

/** 树里最多放这么多节点；超出即停并标记截断。 */
export const KB_MAX_ENTRIES = 2000;

/** 最多数这么多个 `.md`；触顶后 `fileCount` 只能是「至少 N」。 */
export const KB_MAX_FILES = 20000;

const KB_INDEX_NAME = "index.yaml";

const MD_EXTENSION = ".md";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 目录的实测状态：定位结论要建立在文件系统事实上，不能只看字符串。 */
type RootState = "directory" | "missing" | "not-directory" | "unreadable";

function probeDirectory(target: string): RootState {
  try {
    return statSync(target).isDirectory() ? "directory" : "not-directory";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    return "unreadable";
  }
}

function stateNote(state: RootState): string | undefined {
  if (state === "directory") return undefined;
  if (state === "missing") return "目录不存在";
  if (state === "not-directory") return "该路径不是目录";
  return "目录无法访问（权限或 IO 错误）";
}

/**
 * 把候选路径连同来源与实测状态一起交出。
 *
 * 目录不存在时**不清空** `root`：前端要靠它告诉用户「去这个路径找语料」，
 * 而不是笼统地说「没有知识库」。清空只有一种情况——连候选都算不出来。
 */
function located(root: string, source: KbRootSource, reason: string): KbRootLocation {
  const deficiency = stateNote(probeDirectory(root));
  return {
    root,
    source,
    note: deficiency === undefined ? reason : `${reason}；${deficiency}`,
  };
}

interface McpKbCandidate {
  name: string;
  kbRoot: string;
  cwd?: string;
}

interface McpLookup {
  candidate?: McpKbCandidate;
  /** 读不了或解析不了时的真实原因：降级要写进 note，不能静默（R3）。 */
  degraded?: string;
}

/**
 * 在 `$HARNESS_HOME/mcp.json` 里找一台配了 `env.KB_ROOT` 的 server。
 *
 * 这里不复用 `readAppConfig`：它会因为任何一份配置坏掉而抛错，而设置页展示
 * 知识库时最需要「别的配置坏了也先把根显示出来」。所以自带一个宽容的读法，
 * 损坏只降级成 note，不影响定位。
 */
function findMcpKbCandidate(harnessHome: string): McpLookup {
  const mcpPath = path.join(harnessHome, "mcp.json");
  let text: string;
  try {
    text = readFileSync(mcpPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 没有 mcp.json 是常态（用户还没配 MCP），不是降级。
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    return { degraded: `mcp.json 读取失败（${messageOf(error)}）` };
  }
  let value: unknown;
  try {
    // 记事本存过的 mcp.json 常带 BOM，JSON.parse 会直接拒绝。
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return { degraded: `mcp.json 无法解析（${messageOf(error)}）` };
  }
  if (!isRecord(value)) return { degraded: "mcp.json 顶层不是对象" };
  const servers = value.mcpServers;
  if (servers === undefined) return {};
  if (!isRecord(servers)) return { degraded: "mcp.json 的 mcpServers 不是对象" };

  const candidates: McpKbCandidate[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw) || !isRecord(raw.env)) continue;
    const kbRoot = typeof raw.env.KB_ROOT === "string" ? raw.env.KB_ROOT.trim() : "";
    if (kbRoot === "") continue;
    const cwd = typeof raw.cwd === "string" && raw.cwd.trim() !== "" ? raw.cwd.trim() : undefined;
    candidates.push({ name, kbRoot, ...(cwd === undefined ? {} : { cwd }) });
  }
  if (candidates.length === 0) return {};
  // 名字就叫 `kb` 的那台，最可能就是设置页里配的知识库；其余按文件顺序取第一个。
  const preferred = candidates.find((entry) => entry.name === "kb") ?? candidates[0];
  return preferred === undefined ? {} : { candidate: preferred };
}

/**
 * 解析知识库根，按显式程度从高到低：
 *
 * 1. `KB_ROOT` 环境变量（操作员显式覆盖）；
 * 2. `$HARNESS_HOME/mcp.json` 里任一 server 的 `env.KB_ROOT`；
 * 3. 仓库默认的 `mcp-servers/kb/kb`（MCP server 自己的缺省值）。
 *
 * 优先级与 MCP server 实际读到的配置一致，设置页显示的必须就是内核会用的那个根。
 */
export function resolveKbRoot(opts: ResolveKbRootOptions): KbRootLocation {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const envRoot = env.KB_ROOT?.trim() ?? "";

  if (envRoot !== "") {
    return located(path.resolve(cwd, envRoot), "env", "来自环境变量 KB_ROOT");
  }

  let degraded: string | undefined;
  if (opts.harnessHome !== undefined && opts.harnessHome !== "") {
    const lookup = findMcpKbCandidate(opts.harnessHome);
    degraded = lookup.degraded;
    if (lookup.candidate !== undefined) {
      const entry = lookup.candidate;
      // server 自己的 cwd 也是相对进程 cwd 的：先把它定死，KB_ROOT 再按它解析，
      // 否则两层相对路径会互相错位。
      const base = entry.cwd === undefined ? cwd : path.resolve(cwd, entry.cwd);
      return located(path.resolve(base, entry.kbRoot), "mcp.json", `来自 mcp.json 的 server "${entry.name}"`);
    }
  }

  const defaultRoot =
    opts.repoRoot.trim() === ""
      ? ""
      : path.resolve(opts.repoRoot, "mcp-servers", "kb", "kb");
  if (defaultRoot === "") {
    return {
      root: "",
      source: "none",
      note:
        degraded === undefined
          ? "没有可用的知识库候选：未设置 KB_ROOT，mcp.json 里没有带 KB_ROOT 的 server，也算不出仓库默认目录"
          : `${degraded}，且没有其他可用的候选路径`,
    };
  }
  return located(
    defaultRoot,
    "default",
    degraded === undefined ? "使用仓库默认知识库目录" : `${degraded}，已回落到仓库默认知识库目录`,
  );
}

interface ScanBudget {
  entries: number;
  files: number;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  truncated: boolean;
}

function compareNames(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

async function walkKb(dir: string, depth: number, budget: ScanBudget): Promise<KbNode[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 根不存在（或根本不是一个目录）不是错误：调用方会带着候选路径和 note 回空树。
    if (depth === 0 && (code === "ENOENT" || code === "ENOTDIR")) return [];
    // 根的权限/IO 失败是真错误，交给调用方如实报 `error`。
    if (depth === 0) throw error;
    // 子目录读不了时，树就是不完整的；契约里能表达这件事的只有 `truncated`。
    // 静默给一个空 `children` 会让人以为那个目录是空的（R3）。
    budget.truncated = true;
    return [];
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).sort(compareNames);
  const files = entries.filter((entry) => entry.isFile()).sort(compareNames);
  // 符号链接既不算目录也不算文件，因此既不列出也不跟随：跟随它就能走出
  // 知识库根，这条规则与 `listDirectory` 一致。
  const nodes: KbNode[] = [];
  for (const entry of [...dirs, ...files]) {
    if (budget.entries >= budget.maxEntries) {
      budget.truncated = true;
      break;
    }
    budget.entries += 1;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const childDepth = depth + 1;
      let children: KbNode[] = [];
      if (childDepth < budget.maxDepth) {
        children = await walkKb(full, childDepth, budget);
      } else {
        // 到深度上限了，这个目录里还有没有东西本次没看：整棵树都不能算完整。
        budget.truncated = true;
      }
      nodes.push({ name: entry.name, path: full, kind: "dir", children });
    } else {
      if (path.extname(entry.name).toLowerCase() === MD_EXTENSION) {
        // 触顶后继续列文件、但不再计数：`fileCount` 变成「至少 N」，由
        // `truncated` 告诉前端不能当精确值读。
        if (budget.files < budget.maxFiles) budget.files += 1;
        else budget.truncated = true;
      }
      nodes.push({ name: entry.name, path: full, kind: "file" });
    }
  }
  return nodes;
}

async function hasIndexFile(root: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, KB_INDEX_NAME))).isFile();
  } catch {
    return false;
  }
}

/**
 * 列出一个知识库根下的树，并数出 `.md` 文件数。
 *
 * `root` 为空表示没定位到根，此时给的是真实的空结果，而不是编一个目录。
 * 根不存在同样回空树——那不是错误，是「没找到」；只有根可读但读不动
 * （权限/IO）才抛错，由调用方转成 `error` 字段。
 */
export async function scanKbRoot(root: string, options: ScanKbOptions = {}): Promise<KbScanResult> {
  if (root.trim() === "") {
    return { tree: [], fileCount: 0, indexPresent: false, truncated: false };
  }
  const budget: ScanBudget = {
    entries: 0,
    files: 0,
    maxDepth: options.maxDepth ?? KB_MAX_DEPTH,
    maxEntries: options.maxEntries ?? KB_MAX_ENTRIES,
    maxFiles: options.maxFiles ?? KB_MAX_FILES,
    truncated: false,
  };
  const tree = await walkKb(root, 0, budget);
  return {
    tree,
    fileCount: budget.files,
    indexPresent: await hasIndexFile(root),
    truncated: budget.truncated,
  };
}
