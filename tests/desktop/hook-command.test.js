import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMMANDS, parseSlashText } from "../../desktop/renderer/commands.js";
import { dictionaries } from "../../desktop/renderer/i18n.js";
import { hooksDefaultPaths, hooksView } from "../../desktop/host/hooks-view.js";
import { loadHookConfig } from "../../src/hooks/config.js";

/**
 * `/hook` —— 查看已配置的钩子（计划 Task 3，2026-11-09）。
 *
 * Three surfaces, each with the tool that can actually observe it:
 *
 *   - the **catalogue and the parser** are plain modules, so they are imported
 *     and called;
 *   - `hooksView` is a **boundary between the kernel's reader and the
 *     transcript row**, so it is asserted by calling it with the kernel's real
 *     `loadHookConfig` — not a stand-in. That is what makes "a broken file
 *     reports `error`, never `hooks: []`" a measurement rather than a claim
 *     about a regex;
 *   - `host.js` starts the NDJSON loop at module scope and `app.js` loads
 *     against `window.prometheus`, and the repository has no jsdom — adding one
 *     is an unapproved dependency. Their wiring is therefore asserted against
 *     the source, the way `hooks-host.test.js` and `subagent-strip.test.js` do.
 *
 * **What the static half proves and what it does not.** It can show that
 * `getHooks` reaches the kernel through `kernel.hooks`, that the missing-module
 * branch emits an event as well as a warning, and that no write API appears on
 * either side. It cannot show the drawing; the renderer's report function is
 * named and its inputs are checked for shape, not for pixels.
 */
const ROOT = path.join(import.meta.dirname, "..", "..");
const readHost = () => readFileSync(path.join(ROOT, "desktop", "host", "host.js"), "utf8");
const readApp = () => readFileSync(path.join(ROOT, "desktop", "renderer", "app.js"), "utf8");
const readHooksView = () =>
  readFileSync(path.join(ROOT, "desktop", "host", "hooks-view.js"), "utf8");
const readSource = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

/** The block that starts at `header` and ends at the first `}` at its indent. */
function bodyOf(text, header) {
  const start = text.indexOf(header);
  expect(start, `${header} not found`).toBeGreaterThan(-1);
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const indent = text.slice(lineStart, start);
  expect(indent.trim(), `${header} must start its line`).toBe("");
  let cursor = text.indexOf("\n", start);
  while (cursor !== -1) {
    const next = text.indexOf("\n", cursor + 1);
    const line = text.slice(cursor + 1, next === -1 ? text.length : next);
    if (line.startsWith(`${indent}}`)) return text.slice(start, next === -1 ? text.length : next);
    cursor = next;
  }
  throw new Error(`unterminated ${header}`);
}

const tempDirs = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** A temp `$HARNESS_HOME` + workdir pair. */
async function tempHome() {
  const root = await mkdtemp(path.join(tmpdir(), "eam-hook-command-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  return { root, home, work };
}

function hookFile(hooks) {
  return JSON.stringify({ version: 1, hooks });
}

function viewFor(home, work) {
  // The kernel's own reader, handed the way the host hands it: through the
  // namespace it imported, never a wrapper with its own schema.
  return hooksView({ module: { loadHookConfig }, home, workdir: work });
}

// ---------------------------------------------------------------------------
// 验收行 1：命令在两处目录里都存在
// ---------------------------------------------------------------------------

describe("/hook 在两份命令目录里都有一行", () => {
  it("渲染层 COMMANDS 有 hook，带参数提示与两种语言的描述", () => {
    const hook = COMMANDS.find((command) => command.name === "hook");
    expect(hook, "hook missing from desktop/renderer/commands.js").toBeDefined();
    // `/hook reload` is the only argument; the palette inserting `/hook `
    // is what makes that discoverable.
    expect(hook.argumentHint).toBe("[reload]");
    expect(hook.description.zh).not.toBe("");
    expect(hook.description.en).not.toBe("");
  });

  it("宿主 builtinCommands() 也有 hook（两处各一份，缺一处就没路由）", () => {
    const host = readHost();
    const body = bodyOf(host, "function builtinCommands()");
    expect(body).toContain('{ name: "hook" }');
    // Every renderer-side runnable verb has a host row: a verb only one side
    // knows is either a menu entry that 404s or a capability nobody can reach.
    for (const name of ["clear", "context", "compact", "hook"]) {
      expect(body, `builtinCommands is missing ${name}`).toContain(`{ name: "${name}" }`);
    }
  });

  it("渲染器的 RUNNABLE_COMMANDS 与 switch 都有 hook", () => {
    const app = readApp();
    const set = app.slice(app.indexOf("const RUNNABLE_COMMANDS = new Set("));
    expect(set.slice(0, set.indexOf(");"))).toContain('"hook"');
    const dispatch = bodyOf(app, "function runSlashCommand({ name, args }, rawText = `/${name}`)");
    expect(dispatch).toContain('case "hook":');
    expect(dispatch).toContain('cmd: "getHooks"');
  });
});

// ---------------------------------------------------------------------------
// 验收行 2：参数解析
// ---------------------------------------------------------------------------

describe("参数解析：只认 reload", () => {
  it("parseSlashText 还原 /hook 与 /hook reload", () => {
    // The parser is shared and already handles `name + args`; this pins that
    // the new verb rides it unchanged rather than needing a special case.
    expect(parseSlashText("/hook")).toStrictEqual({ name: "hook", args: "" });
    expect(parseSlashText("/hook reload")).toStrictEqual({ name: "hook", args: "reload" });
    expect(parseSlashText("  /HOOK  reload  ")).toStrictEqual({ name: "hook", args: "reload" });
  });

  it("/hook foo 被拒绝，提示里点名唯一支持的 reload", () => {
    const app = readApp();
    const dispatch = bodyOf(app, "function runSlashCommand({ name, args }, rawText = `/${name}`)");
    // The refusal is by name, before the transcript echo: a command that does
    // not run must not leave a message that looks like it did.
    expect(dispatch).toContain('argsText !== "reload"');
    expect(dispatch).toContain("t.commandHookUnknownArgument(argsText)");
    // And the wording really does name `reload` in both languages.
    for (const locale of ["en", "zh"]) {
      const text = dictionaries[locale].commandHookUnknownArgument("foo");
      expect(typeof text).toBe("string");
      expect(text).toContain("reload");
      expect(text).toContain("foo");
      expect(dictionaries[locale].commandHookUnknownArgument("foo")).not.toBe(
        dictionaries[locale].commandHookUnknownArgument("bar"),
      );
    }
    expect(dictionaries.en.commandHookUnknownArgument("foo")).not.toBe(
      dictionaries.zh.commandHookUnknownArgument("foo"),
    );
  });

  it("/hook 与 /hook reload 发的是同一条命令，只有 reload 字段不同", () => {
    const app = readApp();
    const dispatch = bodyOf(app, "function runSlashCommand({ name, args }, rawText = `/${name}`)");
    expect(dispatch).toContain('api.send(argsText === "reload" ? { cmd: "getHooks", reload: true } : { cmd: "getHooks" })');
  });
});

// ---------------------------------------------------------------------------
// 验收行 3：宿主惰性加载，缺模块时 warn + 空事件
// ---------------------------------------------------------------------------

describe("宿主惰性加载 hooks 模块", () => {
  it("启动时 import(dist(\"hooks/config.js\")) 且带 catch", () => {
    const host = readHost();
    expect(host).toContain('import(dist("hooks/config.js")).catch(() => undefined)');
    expect(host).toContain("hooks: hooksModule");
  });

  it("getHooks 走 kernel.hooks，缺模块时先 warn 再回一条带 error 的 hooks 事件", () => {
    const host = readHost();
    const body = bodyOf(host, "getHooks(payload = {})");
    expect(body).toContain("module: kernel.hooks");
    expect(body).toContain("hooksView(");
    // A warning alone would leave the renderer waiting for an answer that never
    // comes; the event is what releases it.
    expect(body).toContain('send({ type: "notice", level: "warn", text: HOOKS_MISSING })');
    expect(body).toContain('send({');
    expect(body).toContain('type: "hooks"');
    expect(body).toContain('code: "module_missing"');
  });

  it("内核没有这个模块时 hooksView 返回 undefined（宿主据此回 warn）", () => {
    expect(hooksView({ module: undefined, home: "h", workdir: "w" })).toBeUndefined();
    // A module that exists without the export is the same unsupported state.
    expect(hooksView({ module: {}, home: "h", workdir: "w" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 验收行 4：坏配置如实报 error，不是空列表
// ---------------------------------------------------------------------------

describe("坏配置报 error，不冒充「没有钩子」", () => {
  it("坏了就是 error，且整条结果里没有 hooks 键", async () => {
    const { home, work } = await tempHome();
    await writeFile(path.join(home, "hooks.json"), "{ not json", "utf8");

    const view = viewFor(home, work);

    expect(view.error, "a broken file must answer with an error").toBeDefined();
    expect(view.error.code).toBe("invalid_json");
    // The actionable half: which file. Two candidates exist, and "坏掉了" alone
    // sends the reader hunting between them.
    expect(view.error.message).toContain(path.join(home, "hooks.json"));
    // The load-bearing assertion: **no `hooks` key**. `hooks: []` would claim
    // "nothing is configured", which is the opposite of what the file says.
    expect(view).not.toHaveProperty("hooks");
  });

  it("schema 错误的消息带 hooks[N]，这正是用户要改的那一行", async () => {
    const { home, work } = await tempHome();
    await writeFile(
      path.join(home, "hooks.json"),
      hookFile([{ event: "preToolUse", macher: "shell", command: "node" }]),
      "utf8",
    );

    const view = viewFor(home, work);

    expect(view.error.code).toBe("invalid_schema");
    expect(view.error.message).toContain("hooks[0]");
    expect(view).not.toHaveProperty("hooks");
  });

  it("连路径都报：错误答案里仍带两份文件的位置", async () => {
    const { home, work } = await tempHome();
    await writeFile(path.join(home, "hooks.json"), "[]", "utf8");

    const view = viewFor(home, work);
    expect(view.userConfigPath).toBe(path.join(home, "hooks.json"));
    expect(view.projectConfigPath).toBe(path.join(work, ".harness", "hooks.json"));
  });

  it("hooksDefaultPaths 与 src/hooks/config.ts 的默认值一致", () => {
    // The error branch has to name the files the kernel would have opened.
    // `loadHookConfig` throws before it can return them, so they are composed
    // here — and this pins them to the kernel's own two expressions rather
    // than to a comment.
    const config = readSource("src/hooks/config.ts");
    expect(config).toContain('path.join(opts.home, "hooks.json")');
    expect(config).toContain('path.join(opts.workdir, ".harness", "hooks.json")');
    const home = path.join("C:", "h");
    const work = path.join("C:", "w");
    expect(hooksDefaultPaths(home, work)).toStrictEqual({
      userConfigPath: path.join(home, "hooks.json"),
      projectConfigPath: path.join(work, ".harness", "hooks.json"),
    });
  });
});

// ---------------------------------------------------------------------------
// 验收行 5：项目级如实披露
// ---------------------------------------------------------------------------

describe("项目级文件如实披露，不假装加载", () => {
  it("hooksView 以 includeProject: false 读取", () => {
    expect(readHooksView()).toContain("includeProject: false");
  });

  it("用户级钩子列出，项目级文件存在时带 projectSkipped", async () => {
    const { home, work } = await tempHome();
    await writeFile(
      path.join(home, "hooks.json"),
      hookFile([
        { event: "preToolUse", matcher: "shell", command: "node", args: ["deny-rm.mjs"] },
        { event: "postToolUse", command: "log" },
      ]),
      "utf8",
    );
    await mkdir(path.join(work, ".harness"), { recursive: true });
    await writeFile(
      path.join(work, ".harness", "hooks.json"),
      hookFile([{ event: "preToolUse", command: "project-hook" }]),
      "utf8",
    );

    const view = viewFor(home, work);

    expect(view.hooks).toHaveLength(2);
    expect(view.hooks.map((hook) => hook.source)).toStrictEqual(["user", "user"]);
    // The project entry is *not* in the list — it is not what the next run
    // loads — but its existence travels as its own field.
    expect(view.hooks.some((hook) => hook.command === "project-hook")).toBe(false);
    expect(view.projectSkipped).toBe(path.join(work, ".harness", "hooks.json"));
  });

  it("没有项目级文件时不写 projectSkipped（「没有」≠「有但没加载」）", async () => {
    const { home, work } = await tempHome();
    await writeFile(path.join(home, "hooks.json"), hookFile([]), "utf8");

    const view = viewFor(home, work);

    expect(view.hooks).toStrictEqual([]);
    expect(view).not.toHaveProperty("projectSkipped");
    expect(view.projectConfigPath).toBe(path.join(work, ".harness", "hooks.json"));
  });

  it("一条钩子的行带着 event / command / source / index，缺省字段不补", async () => {
    const { home, work } = await tempHome();
    await writeFile(
      path.join(home, "hooks.json"),
      hookFile([{ event: "preToolUse", command: "node", timeoutMs: 2500 }]),
      "utf8",
    );

    const [row] = viewFor(home, work).hooks;

    expect(row).toStrictEqual({
      event: "preToolUse",
      command: "node",
      source: "user",
      index: 0,
      timeoutMs: 2500,
    });
    // No `matcher` on this entry: absent, not `""` and not a made-up `"*"`.
    expect(row).not.toHaveProperty("matcher");
    expect(row).not.toHaveProperty("args");
  });

  it("index 是「它在自己那份文件里的序号」", async () => {
    const { home, work } = await tempHome();
    await writeFile(
      path.join(home, "hooks.json"),
      hookFile([
        { event: "preToolUse", command: "a" },
        { event: "postToolUse", command: "b" },
      ]),
      "utf8",
    );

    expect(viewFor(home, work).hooks.map((hook) => hook.index)).toStrictEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// 验收行 6：不提供写操作
// ---------------------------------------------------------------------------

describe("/hook 是只读的", () => {
  it("host 的 getHooks 与 hooks-view 都不含写 API", () => {
    const host = readHost();
    const body = bodyOf(host, "getHooks(payload = {})");
    const view = readHooksView();
    for (const forbidden of ["writeFile", "writeFileSync", "unlink", "rmSync", "rename", "appendFile"]) {
      expect(body, `getHooks calls ${forbidden}`).not.toContain(forbidden);
      expect(view, `hooks-view calls ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("也没有第二条校验：hooks-view 不解析 JSON、不看 version、不认识字段名", () => {
    const view = readHooksView();
    // `src/hooks/config.ts` is the only validator. A second one here would
    // eventually answer "this file is fine" about a file the kernel refuses.
    expect(view).not.toContain("JSON.parse");
    expect(view).not.toContain("version");
    expect(view).not.toContain("zod");
  });
});

// ---------------------------------------------------------------------------
// 渲染：回答是转录里的一段，并说明 reload 只重读给界面看
// ---------------------------------------------------------------------------

describe("回答画成转录里的一段（不是 notice）", () => {
  it("有 case \"hooks\"，且走专门的 renderHooksReport", () => {
    const app = readApp();
    expect(app).toContain('case "hooks":');
    expect(app).toContain("renderHooksReport(message);");
    const report = bodyOf(app, "function renderHooksReport(message)");
    // A block, not `addNotice`: the list needs columns, and a notice is the
    // shell talking rather than an answer to a question.
    expect(report).toContain("addNode(");
    expect(report).not.toContain("addNotice(");
  });

  it("每一项的四个字段都画，缺 matcher 时说「全部工具」", () => {
    const report = bodyOf(readApp(), "function renderHooksReport(message)");
    for (const field of ["hooks-event", "hooks-matcher", "hooks-command", "hooks-source"]) {
      expect(report).toContain(field);
    }
    expect(report).toContain("t.hooksAllTools");
    expect(report).toContain("t.hooksSourceUser");
    expect(report).toContain("t.hooksSourceProject");
  });

  it("坏配置画成 error 段，且不画一个空列表", () => {
    const report = bodyOf(readApp(), "function renderHooksReport(message)");
    expect(report).toContain("t.hooksErrorTitle");
    expect(report).toContain("t.hooksErrorEntry");
    expect(report).toContain("message.error !== undefined");
  });

  it("reload 只是重读给界面看——这句话在回答里，不只在文档里", () => {
    const report = bodyOf(readApp(), "function renderHooksReport(message)");
    expect(report).toContain("t.hooksReloadNote");
    // The note must not read as "applied": the running session keeps the file
    // it started with, and only a new run re-reads it.
    for (const locale of ["en", "zh"]) {
      const text = dictionaries[locale].hooksReloadNote;
      expect(typeof text).toBe("string");
      expect(text).not.toBe("");
    }
    expect(dictionaries.en.hooksReloadNote).toContain("new run");
    expect(dictionaries.zh.hooksReloadNote).toContain("新一轮");
    // And "this command never writes" is said where the answer is, because a
    // read-only command is exactly where someone would expect an editor.
    expect(report).toContain("t.hooksNoWriteNote");
  });

  it("两种语言的报告文案都在，且不是同一句", () => {
    for (const locale of ["en", "zh"]) {
      const dict = dictionaries[locale];
      for (const key of [
        "hooksTitle",
        "hooksReRead",
        "hooksEmpty",
        "hooksUserFile",
        "hooksProjectFile",
        "hooksErrorTitle",
        "hooksReloadNote",
        "hooksNoWriteNote",
        "hooksAllTools",
      ]) {
        expect(typeof dict[key], `${locale}.${key}`).toBe("string");
        expect(dict[key].trim(), `${locale}.${key}`).not.toBe("");
      }
      expect(typeof dict.hooksProjectSkipped("p")).toBe("string");
      expect(typeof dict.hooksErrorEntry("c", "m")).toBe("string");
      expect(typeof dict.hooksSourceUser(0)).toBe("string");
      expect(typeof dict.hooksSourceProject(0)).toBe("string");
    }
    expect(dictionaries.en.hooksEmpty).not.toBe(dictionaries.zh.hooksEmpty);
    expect(dictionaries.en.hooksProjectSkipped("p")).not.toBe(dictionaries.zh.hooksProjectSkipped("p"));
  });
});

// ---------------------------------------------------------------------------
// 文档：这一节真的存在且说的是同一件事
// ---------------------------------------------------------------------------

describe("docs/operations/hooks.md 有「用 /hook 查看」一节", () => {
  it("该节存在，写了 reload 只重读给界面看，也写了不改文件", () => {
    const doc = readSource("docs/operations/hooks.md");
    const start = doc.indexOf("## 用 `/hook` 查看");
    expect(start, "the /hook section is missing").toBeGreaterThan(-1);
    // Scope the assertions to that section: the same words appear elsewhere
    // in the document, and a match found there would prove nothing.
    const next = doc.indexOf("\n## ", start + 1);
    const section = doc.slice(start, next === -1 ? doc.length : next);
    expect(section).toContain("reload");
    expect(section).toContain("下一轮");
    expect(section).toContain("不会");
    // It has to name what the command cannot do, or it reads like an editor.
    expect(section).toContain("手改");
  });
});
