/**
 * 工具链 pack 的存放位置，以及什么能当 pack id。
 *
 * 整个功能建立在一个不变量上：它写下的每个字节都在一个根目录下，且每个
 * pack 都是一个删掉后不留痕迹的目录。本模块拥有根目录和 id 规则；除它
 * 之外没有任何代码构造根目录下的路径。
 *
 * 根目录刻意**不是** `~/.harness`。那个目录放的是会随 Windows 配置文件漫游、
 * 会被卷进备份的小型 JSON；把几个 GB 的编译器放进去会让每次备份都昂贵、
 * 每次配置同步都变慢。OS 数据目录是机器本地且用户可写的：不需要管理员
 * 权限，也不会进 `Program Files`。它也不是 Electron 的 `userData`——CLI 与
 * 桌面宿主共用同一个根目录，谁都不依赖 Electron。
 *
 * （迁移自 Prometheus/src/packs/paths.ts；环境变量
 * `PROMETHEUS_TOOLCHAIN_HOME` 改名 `HARNESS_TOOLCHAIN_HOME`，默认根从
 * `%LOCALAPPDATA%\Prometheus\toolchains` 改为
 * `%LOCALAPPDATA%\Embedded-Ai-Master\toolchains`，不变量逐字保留。）
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { testRunner } from "../config/harness-home.js";

/** 覆盖根目录的环境变量，供 CI 与测试使用。 */
export const ROOT_ENV = "HARNESS_TOOLCHAIN_HOME";

/**
 * 所有 pack 所在的根目录。
 *
 * 覆盖值必须是绝对路径：相对路径会解析到宿主启动时碰巧所在的不同目录，
 * CLI 和桌面应用会得到两个不同的答案。
 *
 * D-170 防污染约定（与 `src/config/harness-home.ts` 同源）：测试进程没有
 * 显式设置根目录时直接抛错，而不是返回用户真实的 toolchains 目录——测试
 * fixture 一旦写穿，事后只能靠目录内容反推来源。检测基于传入的 env，
 * 测试可以用显式的空 env 验证默认分支。
 */
export function packsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ROOT_ENV]?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `${ROOT_ENV} must be an absolute path, got "${override}". ` +
          `A relative path would resolve against the current directory, which differs between the CLI and the app.`,
      );
    }
    return normalize(override);
  }

  const runner = testRunner(env);
  if (runner !== undefined) {
    throw new Error(
      `packsRoot() 拒绝在测试环境返回默认根目录：检测到 ${runner}，但没有设置 ${ROOT_ENV}。` +
        `测试必须把 ${ROOT_ENV} 指向临时目录，否则安装事务会写进用户真实的 toolchains 目录（D-170）。`,
    );
  }

  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local) return join(local, "Embedded-Ai-Master", "toolchains");
    // 被剥掉 LOCALAPPDATA 的环境：退回用户目录而不是失败，因为装不上的
    // pack 比装在稍不理想位置的 pack 更糟。
    return join(homedir(), "AppData", "Local", "Embedded-Ai-Master", "toolchains");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Embedded-Ai-Master", "toolchains");
  }

  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, "embedded-ai-master", "toolchains");
  return join(homedir(), ".local", "share", "embedded-ai-master", "toolchains");
}

/** 根目录下的子目录。命名成函数，调用方就不会手工拼接。 */
export function packsDir(root: string): string {
  return join(root, "packs");
}

export function tmpDir(root: string): string {
  return join(root, "tmp");
}

/** 这个 id 的 pack 安装到的目录。 */
export function packDir(root: string, id: string): string {
  assertPackId(id);
  return join(packsDir(root), id);
}

const GOOD_ID = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * pack id 就是一个目录名，所以它必须能安全地当目录名用。
 *
 * 规则刻意收得很窄，因为这个 id 会出现在卸载时被 `rm -rf` 的路径里。
 * 拒绝任何带分隔符、父目录引用或盘符的写法，就是"删一个目录"和"删了
 * 别的东西"之间的全部差别。
 */
export function assertPackId(id: string): void {
  if (!id) throw new Error("pack id is empty");
  if (id.length > 64) throw new Error(`pack id is too long (${id.length} chars, max 64)`);
  if (id.includes("\0")) throw new Error("pack id contains a NUL byte");
  if (id.includes("/") || id.includes("\\")) throw new Error(`pack id must not contain a path separator: "${id}"`);
  if (id.includes(":") || id.includes("*") || id.includes("?") || id.includes('"') || id.includes("<") || id.includes(">") || id.includes("|")) {
    throw new Error(`pack id contains a character that is not allowed in a file name: "${id}"`);
  }
  if (id.startsWith(".") || id === "." || id === "..") {
    throw new Error(`pack id must not start with a dot or be a relative reference: "${id}"`);
  }
  if (!GOOD_ID.test(id)) {
    throw new Error(`pack id must be lowercase letters, digits, dot, dash or underscore: "${id}"`);
  }
}

/** `child` 是 `parent` 本身或位于其内时为真。词法判断，基于规范化路径。 */
export function isInside(parent: string, child: string): boolean {
  const from = normalize(resolve(parent));
  const to = normalize(resolve(child));
  if (from === to) return true;
  // 末尾分隔符防止 `/a/bc` 被当作 `/a/b` 的内部路径。
  const prefix = from.endsWith(sep) ? from : from + sep;
  // Windows 路径大小写不敏感；大小写敏感的比较会在盘符大小写不同时把
  // 一个目录自己的子路径报成外部路径。
  return process.platform === "win32" ? to.toLowerCase().startsWith(prefix.toLowerCase()) : to.startsWith(prefix);
}

/**
 * 根目录不存在时创建它，并落下所有权标记。
 *
 * 标记让破坏性的清理能区分"本应用创建的目录"和"用户误指过来的目录"。
 * 它不是锁，除了创建时间不携带任何数据。
 */
export function ensureRoot(root: string = packsRoot()): void {
  mkdirSync(packsDir(root), { recursive: true });
  mkdirSync(tmpDir(root), { recursive: true });
  const marker = join(root, "root.json");
  if (!existsSync(marker)) {
    try {
      writeFileSync(marker, JSON.stringify({ schema: 1, createdAt: new Date().toISOString() }, null, 2) + "\n");
    } catch {
      /* 只读的根目录会在稍后以更清晰的错误失败 */
    }
  }
}

/** 根目录存在且带标记时为真。 */
export function isOwnedRoot(root: string): boolean {
  try {
    return statSync(join(root, "root.json")).isFile();
  } catch {
    return false;
  }
}

export interface RootLock {
  release(): void;
}

interface LockRecord {
  pid: number;
  startedAt: string;
  id?: string;
}

/**
 * 取根目录级的安装锁。
 *
 * 两个窗口就是两个宿主进程，而且都能触到 `installPack`。没有这把锁，
 * 同一个 pack 的两次安装会各自暂存到不同的事务目录，然后在 commit 的
 * rename 上竞争：一个赢，另一个在下完十分钟的包之后拿到 EPERM，落败方
 * 的暂存副本成为孤儿。锁把这种情况变成一个零成本的拒绝。
 *
 * 锁是否失效由 pid 决定，不由时长决定：一次真实安装可以比任何值得写下
 * 的超时都久，但死掉的 pid 永远不会回来。pid 属于活进程的记录——包括
 * 调用方自己的——不算失效，否则一个挂住的宿主会永远锁死安装。
 */
export function acquireRootLock(root: string = packsRoot(), record: Omit<LockRecord, "pid" | "startedAt"> = {}): RootLock {
  ensureRoot(root);
  const path = join(root, ".lock");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...record }, null, 2), {
        flag: "wx",
      });
      return {
        release() {
          // 只有锁还属于自己时才删除。另一个持有者可能在陈旧记录被破坏后
          // 替换了它，删掉别人的锁会放第三个进程进来。
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
            if (current.pid === process.pid) rmSync(path, { force: true });
          } catch {
            /* 已消失，或不可读——没有可释放的东西 */
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (attempt > 0 || !breakStaleLock(path)) {
        throw new Error(
          `${root} is in use by another Embedded-Ai-Master install. Close the other window, or remove ${path} if nothing is installing.`,
        );
      }
    }
  }

  // 不可达：循环要么返回锁，要么抛错。
  throw new Error(`could not lock ${root}`);
}

/** 持有者已消失时删除锁文件。删掉时返回真。 */
function breakStaleLock(path: string): boolean {
  let record: LockRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
  } catch {
    // 不可读的锁是写了一半或损坏的；无论哪种都不是活的持有者，留着它
    // 会让安装一直被挡到有人手工删除为止。
    try {
      rmSync(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  if (typeof record.pid === "number" && record.pid !== process.pid && isRunning(record.pid)) return false;
  if (record.pid === process.pid) return false; // 自己早先的锁：活的持有
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** pid 是否存在。`process.kill(pid, 0)` 是可移植的探测方式。 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但属于别人。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}