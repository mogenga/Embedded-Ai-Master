import { copyFile, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AppMcpServer } from "../config/app-config.js";
import {
  ensureSnapshotDir,
  getKbLayout,
  readCurrentVersion,
  setCurrent,
} from "./snapshot.js";
import type { KbLayout } from "./snapshot.js";

/**
 * 首次种子化：把安装包内置的语料物化成快照，并把 `kb` 这台 MCP server 写进
 * `$HARNESS_HOME/mcp.json`。契约见 `docs/corpus-ota.md` §3（目录布局）与 §5
 * （内置快照 = 一份合法的签名清单，首次启动物化）。
 *
 * **为什么需要它**：全新安装的用户没有 `$HARNESS_HOME/mcp.json`，KB server 不会
 * 启动，模型手上没有 `kb_*` 工具；同时也没有 `kb/current`，设置页只能如实显示
 * `unavailable`。两件事都源于「装完什么都没发生」，而不是任何一处缺陷。
 *
 * 三条贯穿全文件的规则：
 *
 * 1. **绝不覆盖用户已有的东西**。`current` 已存在就不再物化；`mcp.json` 里已有
 *    名为 `kb` 的 server 就不再写——用户可能自己指过路径，覆盖是不可接受的。
 *
 * 2. **不伪造清单**。内置语料没有 `latest.json` 时只复制文件，不现算一份：
 *    客户端现算的清单没有签名，会被 `parseManifest` / 验签拒绝，装上去等于
 *    给用户一个「看起来有版本、实际验不过」的快照。缺清单时 `readCorpusStatus`
 *    返回 `bundled`（契约 §7），那是诚实的。
 *
 * 3. **失败抛错，不静默成功**。IO 失败一律抛出，由调用方决定怎么上报——
 *    种子化失败不该被说成「已就绪」。
 *
 * 快照目录与 `current` 指针一律走 `snapshot.ts` 的 `ensureSnapshotDir` /
 * `setCurrent`：Windows junction 的两段式替换、临时链接的回滚都在那里踩过坑，
 * 这里再写一份必然与那边漂移。
 */

/** 内置语料里随包分发的清单名（契约 §4/§5）。 */
const BUNDLED_MANIFEST = "latest.json";

/**
 * 永不进快照的文件名（按 basename 匹配）。
 *
 * 与 `src/corpus/manifest.ts` 的 `INBOX_FILE_NAME` / `REVIEWED_FILE_NAME` 和
 * `mcp-servers/kb/inbox.ts` 的 `MANAGED_CORPUS_EXCLUDES` 必须一致。三份常量不能
 * 互相 import（MCP server 不能引内核，见 D-086；manifest.ts 的两个常量也没有
 * 导出），所以这里再写一遍——发布侧跳过什么、验签侧拒什么、物化侧就不能复制什么。
 */
const MANAGED_EXCLUDES: ReadonlySet<string> = new Set(["_inbox.md", "_reviewed.md"]);

export interface SeedCorpusOptions {
  /** `$HARNESS_HOME`；`kb/` 布局在它下面。 */
  harnessHome: string;
  /**
   * 打包形态的 `<安装目录>/resources`；开发形态不传。
   *
   * 不传就等于「这台机器上没有内置语料」，`seedCorpus` 直接返回
   * `no_bundled_corpus`——开发机不该被塞进随包语料（见 `docs/corpus-ota.md` §5
   * 只描述安装包形态）。
   */
  resourcesRoot?: string;
  /** 覆盖内置语料目录；默认 `<resourcesRoot>/corpus`。仅测试与定制发行版使用。 */
  bundledCorpusDir?: string;
}

/**
 * 种子化结果。`already_present` 带着当前版本，让调用方能在日志里说清
 * 「已经是 v几」而不是笼统的「已存在」。
 */
export type SeedCorpusResult =
  | { seeded: true; version: number; fileCount: number }
  | { seeded: false; reason: "already_present"; version: number }
  | { seeded: false; reason: "no_bundled_corpus" };

/**
 * `seedKbMcpEntry` 依赖的配置读写。
 *
 * 用结构化类型而不是直接 import：宿主已经把 `dist/config/app-config.js` 的
 * `readAppConfig` / `writeMcpServers` 加载好了，注入进来就不必再 import 一次；
 * 测试也能直接用真实实现（这里不 mock 文件格式，mock 了就测不到真正写出的字节）。
 */
export interface SeedMcpModules {
  readAppConfig: (home: string) => { mcpServers: AppMcpServer[] };
  writeMcpServers: (home: string, input: unknown) => Promise<unknown>;
}

export interface SeedKbMcpEntryOptions {
  /** `$HARNESS_HOME`；`mcp.json` 在它下面。 */
  harnessHome: string;
  /** 含 `dist/` 的目录；打包形态是 `resources/`，开发形态是仓库根。 */
  kernelRoot: string;
  /** `KB_ROOT` 要指向的目录，即 `$HARNESS_HOME/kb/current`。 */
  currentKbRoot: string;
  /** `KB_INBOX_PATH` 要指向的文件，即 `$HARNESS_HOME/kb/inbox/_inbox.md`。 */
  inboxPath: string;
  mcpModules: SeedMcpModules;
  /** 测试注入用；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 写入 `mcp.json` 的结果。
 *
 * 三种跳过各有各的原因，合并不了：「已经有 kb 条目」是用户的配置，「没有 current」
 * 是这台机器还没语料，「KB_ROOT 被环境变量接管」是操作员的显式覆盖——调用方
 * 若要知道为什么没写，只能靠这个字段。
 */
export type SeedMcpResult =
  | { seeded: true }
  | {
      seeded: false;
      reason: "kb_entry_exists" | "no_current_snapshot" | "kb_server_missing" | "kb_root_env_override";
    };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 目录是否真的存在。不存在是常态（开发形态没有内置语料），不是错误。 */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    // 读不动（权限/IO）不等于「没有」：静默当成没有会让种子化无声跳过（R3）。
    throw new Error(`语料目录无法访问：${target}（${messageOf(error)}）`, { cause: error });
  }
}

/**
 * 内置清单里的 `corpusVersion`，没有清单时按 1。
 *
 * **不调 `parseManifest`、不验签**：种子化不是信任边界——安装包本身就是被信任的，
 * 而验签需要 `corpus.json` 的公钥，首次启动时它可能还没配置。这里只取一个数字，
 * 用来给快照目录命名。
 *
 * 但清单**存在却读不出合法版本**时必须抛错：那说明安装包坏了。静默退回 1 会让
 * 快照目录名与随包清单声称的版本不一致，而版本号正是 OTA 防回滚的比较基准
 * （契约 §4），一个错的基准比没有基准更难查。
 */
async function readBundledVersion(bundledDir: string): Promise<number> {
  const manifestPath = path.join(bundledDir, BUNDLED_MANIFEST);
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    const code = codeOf(error);
    // 没有清单是允许的：只复制文件（见文件头规则 2）。
    if (code === "ENOENT" || code === "ENOTDIR") return 1;
    throw new Error(`内置语料清单无法读取：${manifestPath}（${messageOf(error)}）`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text)) as unknown;
  } catch (error) {
    throw new Error(`内置语料清单不是合法 JSON：${manifestPath}（${messageOf(error)}）`, {
      cause: error,
    });
  }
  const version = isRecord(raw) ? raw.corpusVersion : undefined;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new Error(
      `内置语料清单的 corpusVersion 必须是 ≥ 1 的整数（实际为 ${JSON.stringify(version)}）：${manifestPath}`,
    );
  }
  return version;
}

/**
 * 目标快照路径，顺带自检它确实是 `snapshots/` 的直接子目录。
 *
 * 与 `snapshot.ts` 的 `assertSnapshotDirPath`、`update.ts` 的 `removeSnapshotDir`
 * 同一理由：下面跟着一个递归删除，任何一次拼接失误都会删掉别的东西。
 * 目录名格式（`v<数字>`，无前导零）在 `snapshot.ts` 里是私有的，这里与
 * `update.ts` 一样各写一份——一旦格式变动三处必须同时改。
 */
function snapshotTargetPath(layout: KbLayout, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`快照版本号必须是正整数，实际收到：${String(version)}`);
  }
  const snapshotsAbs = path.resolve(layout.snapshotsDir);
  const target = path.resolve(snapshotsAbs, `v${version}`);
  if (path.dirname(target) !== snapshotsAbs || path.basename(target) !== `v${version}`) {
    throw new Error(`拒绝写入：路径不是快照目录下的 v${version}（${target}）`);
  }
  return target;
}

/**
 * 清掉同版本号的残留快照，保证物化后的目录**正好等于**内置语料。
 *
 * 为什么必须清：`ensureSnapshotDir` 对已存在的目录是「原样返回、不删内容」，
 * 于是上一次被杀掉的物化（或一次失败的 OTA）留下的文件会与本次复制的内容混在
 * 一起。多出来的文件不会被任何校验发现——签名只覆盖清单，不覆盖「目录里多了
 * 什么」（与 `update.ts` 的 `prepareSnapshotDir` 同一条理由）。
 *
 * 只在 `current` 不存在时才走到这里（否则调用方已提前返回），因此没有正在使用
 * 的快照会被清掉。是链接就拒绝：顺着链接删会删到别处去。
 */
async function clearStaleSnapshot(layout: KbLayout, version: number): Promise<void> {
  const target = snapshotTargetPath(layout, version);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw new Error(`快照路径无法访问：${target}（${messageOf(error)}）`, { cause: error });
  }
  if (info.isSymbolicLink()) {
    throw new Error(`拒绝写入：${target} 是链接而不是快照目录`);
  }
  if (!info.isDirectory()) {
    throw new Error(`拒绝写入：${target} 不是目录`);
  }
  try {
    await rm(target, { recursive: true, force: false });
  } catch (error) {
    throw new Error(`残留快照清理失败：${target}（${messageOf(error)}）`, { cause: error });
  }
}

/**
 * 递归复制内置语料，返回复制的文件数。
 *
 * 排除两类：
 * - `latest.json`：它是清单本身，不在清单的 `files` 里。OTA 产出的快照也只有
 *   清单列出的文件，物化结果必须长得一样，否则「物化与 OTA 同一条校验路径」
 *   （契约 §5）就不成立，设置页的知识库树里还会多出一个 `latest.json`。
 * - `_inbox.md` / `_reviewed.md`：用户沉淀与审核记录，永不进快照（契约 §3/§4）。
 *
 * 链接直接报错而不是跳过：语料正文只有 `.md` / `.yaml`，出现链接说明打包有问题；
 * 悄悄跳过会让快照静默少文件，而少文件在 `kb_read` 那侧表现为「条目不存在」，
 * 用户没有任何线索能追到这里。
 */
async function copyCorpusTree(sourceDir: string, targetDir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`内置语料目录无法读取：${sourceDir}（${messageOf(error)}）`, { cause: error });
  }

  let copied = 0;
  for (const entry of entries) {
    if (MANAGED_EXCLUDES.has(entry.name)) continue;
    if (entry.name === BUNDLED_MANIFEST) continue;

    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      copied += await copyCorpusTree(from, to);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`内置语料含非普通文件，无法物化：${from}`);
    }
    try {
      await copyFile(from, to);
    } catch (error) {
      throw new Error(`语料复制失败：${from} → ${to}（${messageOf(error)}）`, { cause: error });
    }
    copied += 1;
  }
  return copied;
}

/**
 * 把内置语料物化成 `snapshots/v<N>` 并切换 `current`。
 *
 * 顺序是刻意的：**先判断、再落盘**。`no_bundled_corpus` 与「清单坏了」这两种
 * 情况都在建任何目录之前返回或抛错，磁盘上不会多出半个 `kb/`。
 *
 * 失败语义：任何 IO 失败抛错。调用方（宿主）据此发 warn 提示并继续启动——
 * 种子化失败是一件事，不是让窗口起不来的理由。
 */
export async function seedCorpus(opts: SeedCorpusOptions): Promise<SeedCorpusResult> {
  const layout = getKbLayout(opts.harnessHome);

  // 1. 已经有 `current` 就什么都不动。用户可能刚通过 OTA 装好一版语料，
  //    内置语料通常更旧——重新物化会把它顶掉。
  const currentVersion = await readCurrentVersion(layout);
  if (currentVersion !== null) {
    return { seeded: false, reason: "already_present", version: currentVersion };
  }

  // 2. 没有内置语料（开发形态就是这样）：不建目录、不报错。
  const bundledDir = opts.bundledCorpusDir
    ?? (opts.resourcesRoot === undefined ? undefined : path.join(opts.resourcesRoot, "corpus"));
  if (bundledDir === undefined || !(await isDirectory(bundledDir))) {
    return { seeded: false, reason: "no_bundled_corpus" };
  }

  const version = await readBundledVersion(bundledDir);

  await clearStaleSnapshot(layout, version);
  // `ensureSnapshotDir` 顺带建出 `inbox/`：首次物化之后 `kb_propose` 必须立刻可用。
  const snapshotDir = await ensureSnapshotDir(layout, version);
  const fileCount = await copyCorpusTree(bundledDir, snapshotDir);

  // 指针最后切：复制中途失败时 `current` 仍不存在，下次启动会重来一遍。
  await setCurrent(layout, version);
  return { seeded: true, version, fileCount };
}

/** `kb` server 条目。字段与 `src/mcp/config.ts` 的已知字段一一对应。 */
function buildKbEntry(serverPath: string, currentKbRoot: string, inboxPath: string): AppMcpServer {
  return {
    name: "kb",
    // 用运行时的 `process.execPath` 而不是 `node`：用户机器不保证装了 Node 24。
    // 打包形态下这是 Electron 二进制，配合 `ELECTRON_RUN_AS_NODE=1` 以 Node 方式运行；
    // 开发形态下它本来就是 node，这个变量无害。
    command: process.execPath,
    args: [serverPath],
    env: {
      // 绝对路径：`loadMcpConfig` 会把 server 的 cwd 设成会话工作目录，
      // 相对路径会随用户打开的项目漂移（`src/mcp/config.ts` 的 `mergeServer`）。
      KB_ROOT: currentKbRoot,
      KB_INBOX_PATH: inboxPath,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

/**
 * 把 `kb` 这台 server 写进 `$HARNESS_HOME/mcp.json`，让模型拿到 `kb_*` 工具。
 *
 * **只在 `current` 真的存在时才写**（见 `SeedKbMcpResult` 的 `no_current_snapshot`）。
 * 开发机上常见「已经 OTA 过」与「还没拉过语料」两种状态：前者的 `getKb` 与 OTA
 * 必须指向同一处，后者若写了 `mcp.json`，`getKb` 会指向一个不存在的目录——
 * 那比回落到仓库默认（`resolveKbRoot` 的第三级）更糟，因为设置页会显示
 * 「目录不存在」，而 MCP server 起来后 `kb_status` 也会报一个空库。
 *
 * 写入走内核自己的 `writeMcpServers`：它做字段校验与「临时文件 + rename」的原子落盘，
 * 写出来的东西保证能被 `loadMcpConfig`（真正拉起 server 的那一侧）与 `resolveKbRoot`
 * （设置页那一侧）读回来。
 *
 * 已知取舍：`writeMcpServers` 只认识内核已知字段，其它 server 条目上的**未知字段**
 * 会在整份写回时被丢掉。这与设置页自己的 `saveMcpServer` 行为一致，且未知字段本来
 * 就会让 `readAppConfig` 报 warning；为了保住它们而自写一套读写，会让这个文件出现
 * 第二个写者，两边迟早对「什么算合法配置」产生分歧。
 */
export async function seedKbMcpEntry(opts: SeedKbMcpEntryOptions): Promise<SeedMcpResult> {
  const env = opts.env ?? process.env;

  // 操作员用环境变量显式指定了 KB_ROOT：`resolveKbRoot` 让它排第一。此时再往
  // mcp.json 写一个不同的 KB_ROOT，会让设置页显示 env 的根、而真正拉起的 server
  // 用 mcp.json 的根（`buildEnv` 里 config.env 覆盖继承环境）——正是本任务要
  // 消灭的那种「两处说两种话」。
  if ((env.KB_ROOT ?? "").trim() !== "") {
    return { seeded: false, reason: "kb_root_env_override" };
  }

  // 没有 `current` 就先不写：见上面的取舍说明。悬空链接在这里表现为 ENOENT。
  if (!(await isDirectory(opts.currentKbRoot))) {
    return { seeded: false, reason: "no_current_snapshot" };
  }

  if (opts.kernelRoot.trim() === "") {
    throw new Error("kernelRoot 不能为空：无法定位 dist-mcp/kb/server.js");
  }
  const serverPath = path.join(path.resolve(opts.kernelRoot), "dist-mcp", "kb", "server.js");
  // 没有编译出 MCP server 就写一条指向不存在文件的配置，等于让每次会话都多一条
  // 必然失败的 connect_failed。跳过更诚实：模型没有 kb 工具，与今天一致。
  if (!(await isFile(serverPath))) {
    return { seeded: false, reason: "kb_server_missing" };
  }

  // 配置坏了要抛错而不是覆盖：`readAppConfig` 在读不动/解析不了时抛出，那正是
  // 「不要拿一份默认值盖掉用户文件」的时刻。
  const snapshot = opts.mcpModules.readAppConfig(opts.harnessHome);
  const existing = snapshot.mcpServers;
  if (existing.some((server) => server.name === "kb")) {
    // 用户可能自己配过路径（另一份语料、另一台机器上的共享目录），覆盖不可接受。
    return { seeded: false, reason: "kb_entry_exists" };
  }

  const entry = buildKbEntry(serverPath, path.resolve(opts.currentKbRoot), path.resolve(opts.inboxPath));
  await opts.mcpModules.writeMcpServers(opts.harnessHome, [...existing, entry]);
  return { seeded: true };
}

/** 普通文件是否存在。用于确认 MCP server 产物真的在，而不是只看路径拼得对不对。 */
async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new Error(`MCP server 产物无法访问：${target}（${messageOf(error)}）`, { cause: error });
  }
}
