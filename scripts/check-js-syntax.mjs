#!/usr/bin/env node
/**
 * 对 `desktop/` 与 `scripts/` 下的每个 JS 文件做一次语法检查。
 *
 * **为什么需要它**：`tsconfig.json` 只 include `src` / `tests` / `mcp-servers`，
 * 而 `allowJs` 未开启——`desktop/renderer/app.js`（7561 行）与 `settings.js`
 * （4609 行）因此不在任何静态检查里。vitest 也不导入它们（只有 `protocol.js`
 * 这类纯函数有测试）。实测：往 `app.js` 末尾塞一段语法错误，`npm test` 仍然
 * 468 passed 全绿，CI 一句话不说——而那是一个会让应用打不开的错误。
 *
 * `main.js` 的 `stopHost` 事故（D-220）是同一盲区的另一面：主进程脚本既不在
 * tsc 里，也没有运行时测试加载它。`node --check` 只查语法、不查作用域，但那
 * 一类错误已经有 `tests/desktop/main-scope.test.js` 用静态解析兜住。
 *
 * **为什么是独立脚本而不是 CI 里写一段 PowerShell**：CI 与本地要跑同一个实现，
 * 否则「本地绿、CI 红」这类问题会转移到这里来。
 *
 * 退出码：0 = 全部通过；1 = 有文件不通过（逐个点名，不静默）。
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** 要扫的目录。刻意只列这两个：`src/` 有 tsc，`.tmp/` 是临时产物。 */
const ROOTS = ["desktop", "scripts"];

/**
 * 不扫的目录。`node_modules` 是依赖，`build` / `dist-installer` 是产物，
 * `dist*` 由 tsc 写出——它们都不用我们来判语法。
 */
const SKIP_DIRS = new Set(["node_modules", "build", "dist-installer", "dist", "dist-mcp", ".git"]);

const EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

export async function collect(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await collect(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    found.push(full);
  }
  return found;
}

/**
 * 在一个进程内解析一个文件，返回错误描述；通过时返回 `undefined`。
 *
 * **为什么不逐个 `node --check`**：那是**每个文件起一次 Node 进程**。38 个
 * 文件本机约 6 秒，其中 5.9 秒是进程启动开销。`vm.SourceTextModule` 在同一个
 * 进程里解析，同样的文件降到毫秒级，报错位置仍是 V8 自己算的行列号。
 *
 * `SourceTextModule` 是实验特性（需要 `--experimental-vm-modules`，见
 * `package.json` 的 `check:js`），且**可能在某些运行时里不可用**——vitest 在
 * 非 ESM 模块图下把它暴露成 `undefined`。所以这里保留一条回退：拿不到构造器
 * 时退回到 `node --check`，正确性优先于速度。测试因此不依赖实验特性是否开着。
 *
 * `new vm.Script()` 不能替代：它不接受 ESM 语法，而 `desktop/` 与 `scripts/`
 * 下绝大多数文件是 ESM（`export` 会被判成语法错误）。
 *
 * **`.cjs` 例外，仍走 `node --check`**：`SourceTextModule` 一律按 ESM 解析，
 * 而 `.cjs` 是 CommonJS——两边规则正好相反。顶层 `await` 在 ESM 合法、在 CJS
 * 非法（会漏报）；顶层 `return` 在 CJS 合法、在 ESM 非法（会误报）。`vm.Script`
 * 也不是 CJS 的等价物：它按裸脚本编译，顶层 `return` 同样判非法，而
 * `node --check` 按 CJS 包装函数解析。`desktop/preload.cjs` 正是这个脚本要
 * 保护的那类文件，承担一次进程启动换回与旧实现一致的判据。
 *
 * `.js` 与 `.mjs` 按 ESM 解析是有依据的：仓库根与 `desktop/package.json`
 * 都声明了 `"type": "module"`，这两个根下没有 CJS 的 `.js`。
 */
export async function checkFile(file) {
  const SourceTextModule = vm.SourceTextModule;
  if (typeof SourceTextModule === "function" && path.extname(file).toLowerCase() !== ".cjs") {
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      return `读取失败：${error instanceof Error ? error.message : String(error)}`;
    }
    let module;
    try {
      // 只构造，不求值：构造过程就是完整的 V8 解析，`link` / `evaluate` 不参与。
      module = new SourceTextModule(source, { identifier: path.resolve(file) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${path.relative(ROOT, file)}: ${message}`;
    }
    // 解析通过还不够：**具名 import 必须真的存在**。
    //
    // 这是 2026-11-09 的事故补上的一层：删掉 `link-policy.js` 的两个导出后，
    // `main.js` 的 `import { blockedRevealText }` 仍在。语法检查全绿、tsc 看不见
    // （`main.js` 不在 include 里）、没有任何测试加载 `main.js`，于是应用**打不开**
    // 而 CI 一句话不说。`link()` 会在链接期解析真实导出，正好抓这一类。
    //
    // 只校验相对路径：裸包名可能属于另一个模块图（`electron` 之类），由 Electron
    // 或 Node 解析，这里替它判只会制造假阳性。
    const missing = await missingLocalExports(source, file, SourceTextModule);
    return missing;
  }
  // 回退：与旧实现逐字等价。`.cjs` 与拿不到构造器时都走这里。
  try {
    await execFileAsync(process.execPath, ["--check", file], { cwd: ROOT });
    return undefined;
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    return detail === "" ? `node --check 退出码 ${error.code}` : detail;
  }
}

/**
 * 这个文件里有没有指向不存在的本地导出的 `import { … }`。
 *
 * 用 `SourceTextModule.link` 而不是自己解析 import 语句：链接器知道的事比正则多
 * ——`export * from` 的再导出、`export { x as y }` 的改名、`default` 与
 * `export { x as default }` 的区别，全都由它按真实模块图算出来。
 *
 * 链接目标只有两种情况：能解析到磁盘上的相对模块，就给它一个构造好的
 * `SourceTextModule`；否则（裸包名、`.json`、不存在）用一个返回空导出集的桩。
 * 桩是**故意宽松**的：那些模块由 Node / Electron 解析，本脚本没有能力也不应该
 * 替它们判断，报一个假失败会让人不再信这个检查。
 *
 * @returns 通过时 `undefined`，否则是一行带文件名的说明。
 */
/**
 * A copy of this source with every **non-relative** static import removed.
 *
 * Why this is necessary rather than clever: `SourceTextModule.link` asks for
 * *every* dependency and demands the exact export names, so a builtin or a
 * package (`node:fs/promises`, `electron`) can only be satisfied by a real
 * module — which `SourceTextModule` cannot make out of a builtin at all. Given
 * an empty stand-in, every `import { copyFile } from "node:fs/promises"` is a
 * failure, and a check that reports those is a check people turn off.
 *
 * Stripping the line removes that whole class of false positive while keeping
 * the one this check exists for. The rewrite is line-based and therefore
 * deliberately narrow: it only matches a **single-line** `import … from "…"`
 * whose specifier does not start with `./` or `../`. Nothing is executed, and
 * a multi-line or unusual form simply goes unlinked (no failure either way).
 */
function withoutExternalImports(source) {
  // Multiline form (`import {\n  a,\n  b,\n} from "node:fs";`) is the house
  // style in `scripts/`, so the pattern spans lines. It is anchored on the
  // statement's own `from "…"` clause rather than on `^import` alone, which is
  // what keeps it from swallowing a multi-import block at once.
  // `[\s\S]*?` spans the multiline form; the lazy quantifier stops at the
  // first `from "…"`, which is this statement's own clause because an import
  // declaration has exactly one. Comments between clauses are not expected
  // in an import block in this repo, and if one appeared the statement simply
  // would not be stripped — leaving a false positive, never a missed real one.
  const EXTERNAL_IMPORT = /^[ \t]*import\s[\s\S]*?from\s*["'](?!\.\.?\/)[^"']*["'];?[ \t]*$/gm;
  return source.replace(EXTERNAL_IMPORT, "");
}

async function missingLocalExports(source, file, SourceTextModule) {
  const body = withoutExternalImports(source);
  // Nothing local to link: the file only imports builtins and packages, which
  // this check by design cannot judge.
  if (!/^\s*import\s/m.test(body)) return undefined;

  let subject;
  try {
    subject = new SourceTextModule(body, { identifier: path.resolve(file) });
  } catch {
    // The original source failed to parse; that is reported by the caller and
    // is a different failure from a missing export.
    return undefined;
  }

  const locals = new Map();
  try {
    await subject.link(async (specifier) => {
      const resolved = await resolveLocalSpecifier(file, specifier);
      if (resolved === undefined) {
        return new SourceTextModule("", { identifier: specifier });
      }
      if (!locals.has(resolved)) {
        const target = await readFile(resolved, "utf8");
        // The dependency gets the **same** external-import stripping: what is
        // being checked is the edge between this file and its local target,
        // and a `node:*` clause inside the target would otherwise fail the
        // link for a reason that has nothing to do with this file. Its own
        // pass checks its own edges.
        locals.set(resolved, new SourceTextModule(withoutExternalImports(target), { identifier: resolved }));
      }
      return locals.get(resolved);
    });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("does not provide an export")) return undefined;
    return `${path.relative(ROOT, file)}: ${message}（本地模块里没有这个导出，应用会在加载时报错）`;
  }
}

/**
 * 把一个相对 import 说明符解析成磁盘路径，解析不了时 `undefined`。
 *
 * 只处理 `./` 与 `../`：其余（`node:*`、裸包名）留给运行时。省略扩展名时按
 * ESM 的规则试 `.js` / `.mjs` / `/index.js`——本仓库没有打包器，写 `./x`
 * 的地方确实就是这么解析的。
 */
async function resolveLocalSpecifier(fromFile, specifier) {
  // Only relative paths. `node:*` and bare specifiers resolve to real modules
  // with real export sets, but linking them here means holding the whole
  // builtin module graph in this process — and `SourceTextModule` cannot
  // produce one for a builtin at all. Stubbing them (the old body of this
  // check) made every `import { access } from "node:fs/promises"` a false
  // positive, which is worse than not checking them: a check that cries wolf
  // gets ignored. Which is also why this function's caller passes a stub for
  // them and never reports on them.
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = path.extname(base) === "" ? [`${base}.js`, `${base}.mjs`, path.join(base, "index.js")] : [base];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

async function main() {
  const { files, failures } = await checkRoots(
    ROOTS.map((root) => path.join(ROOT, root)),
    ROOT,
  );

  if (files.length === 0) {
    console.error("check-js-syntax: 没找到任何 JS 文件——扫描路径写错了？");
    process.exit(1);
  }

  if (failures.length === 0) {
    console.log(`check-js-syntax: ${files.length} 个文件全部通过`);
    return;
  }

  console.error(`check-js-syntax: ${failures.length}/${files.length} 个文件不通过`);
  for (const { file, failure } of failures) {
    console.error(`\n${file}\n${failure.split("\n").map((line) => `  ${line}`).join("\n")}`);
  }
  // 非零退出交给调用方（npm script / CI）当失败处理。
  process.exitCode = 1;
}

/**
 * 扫一组根目录并逐个检查。返回不通过的文件（相对 `baseDir`），空数组即全通过。
 *
 * 抽成函数是为了让测试能指向一个临时目录：直接跑 CLI 会检查整个仓库，
 * 那样测试只能验证「当前仓库是干净的」，永远造不出失败情形。
 */
export async function checkRoots(roots, baseDir = ROOT) {
  const files = [];
  for (const root of roots) files.push(...(await collect(root)));
  files.sort();

  const failures = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- 顺序执行，报错按路径排序输出
    const failure = await checkFile(file);
    if (failure !== undefined) failures.push({ file: path.relative(baseDir, file), failure });
  }
  return { files, failures };
}

const invokedDirectly =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
