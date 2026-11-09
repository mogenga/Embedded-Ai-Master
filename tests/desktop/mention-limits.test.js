import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries } from "../../desktop/renderer/i18n.js";

/**
 * The `@` popup's stale-build disclosure (D-184 ②, BACKLOG 5.4).
 *
 * D-184 ② was that the host warns once per process and then answers with an
 * empty list, so a user who missed that first notice cannot tell "this project
 * has no matching file" from "search never ran". A warning per keystroke would
 * bury the transcript, so the host now puts the fact on *every* answer
 * (`unavailable: true`) and the popup — the surface the user is looking at on
 * each keystroke — says it.
 *
 * The repository has no jsdom and adding one is a dependency the user has not
 * approved, so these read the renderer sources the way
 * `renderer-reachability.test.js` and `composer-copy.test.js` do. What is
 * asserted is not behaviour under a DOM but *wiring*: the flag is passed from
 * the `file_matches` event into `renderMention`, a visible note is built from
 * it, and the keydown guard does not swallow Enter when the popup holds a note
 * instead of rows. Those are exactly the places the fact could be dropped.
 */
const RENDERER = path.join(import.meta.dirname, "..", "..", "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

/** The body of a top-level `function name(` block, up to its closing brace. */
function functionBody(source, marker) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("旧 dist 的 @ 搜索在弹窗里可见（D-184 ② / BACKLOG 5.4）", () => {
  it("file_matches 的 unavailable 传到 renderMention", () => {
    const app = read("app.js");
    // The event consumer is where the flag would otherwise be dropped: the
    // popup renders only on `file_matches`.
    expect(app).toContain("renderMention(message.files ?? [], message.unavailable === true)");
  });

  it("unavailable 时弹窗显示说明，而不是把自己藏起来", () => {
    const app = read("app.js");
    const body = functionBody(app, "function renderMention(");
    expect(body).toContain("unavailable");
    expect(body).toContain("t.mentionSearchUnavailable");
    expect(body).toContain("mention-hint");
    // The empty-list early return must be *after* the unavailable branch, or
    // `hidden = true` would make the sentence unreachable.
    const earlyReturn = body.indexOf("if (files.length === 0)");
    const unavailableCheck = body.indexOf("if (unavailable)");
    expect(unavailableCheck).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(unavailableCheck);
    expect(read("styles.css")).toContain(".mention-hint");
  });

  it("两种语言都说明「搜索不可用」并给出修法", () => {
    for (const locale of ["en", "zh"]) {
      const text = dictionaries[locale].mentionSearchUnavailable;
      expect(typeof text).toBe("string");
      expect(text.trim()).not.toBe("");
      expect(text).toContain("npm run build");
    }
    expect(dictionaries.en.mentionSearchUnavailable.toLowerCase()).toContain("unavailable");
    expect(dictionaries.zh.mentionSearchUnavailable).toContain("不可用");
  });

  it("弹窗只有说明、没有可选项时，Enter/Tab 不被吞掉", () => {
    const app = read("app.js");
    const start = app.indexOf('input.addEventListener("keydown"');
    expect(start).toBeGreaterThan(-1);
    const end = app.indexOf("\n});", start);
    expect(end).toBeGreaterThan(start);
    const keydown = app.slice(start, end);
    // The unavailable popup has no rows. Trapping Enter there would prevent
    // the message from being sent while the screen shows nothing selectable.
    expect(keydown).toContain("mention.files.length > 0");
  });

  it("目录条目带 kind:dir，宿主把内核的 kind 透传下去（D-184 ①）", () => {
    // The kernel produces `FileNameMatch.kind`; before this the host mapped the
    // objects down to `file.path` and the field had no reader — produced and
    // discarded (the D-196 shape). Both are valid `@` targets, but the popup
    // has to be able to tell a folder from a file.
    const host = readFileSync(path.join(import.meta.dirname, "..", "..", "desktop", "host", "host.js"), "utf8");
    expect(host).toContain('file.kind === "dir"');

    const app = read("app.js");
    const body = functionBody(app, "function renderMention(");
    expect(body).toContain('entry.kind === "dir"');
    // A directory row must be visibly different from a file row.
    expect(body).toContain('${isDir ? "/" : ""}');
  });
});

describe("空 `@` 列出全部，而不是什么都不显示（2026-11-09）", () => {
  it("内核的空查询返回全部条目，不再短路成空数组", () => {
    // The short-circuit `if (query === "") return { files: [] }` was what made
    // an empty `@` show nothing at all, which reads as "this project has no
    // files". The assertion lives here rather than only in the kernel suite so
    // that a future "optimisation" that reinstates the early return breaks a
    // test named after the behaviour the user asked for.
    const source = readFileSync(
      path.join(import.meta.dirname, "..", "..", "src", "server", "files-api.ts"),
      "utf8",
    );
    const body = source.slice(source.indexOf("export async function searchFilesByName("));
    expect(body).not.toContain('if (query === "")');
    expect(body).toContain("const needle = query.toLowerCase();");
  });

  it("真的空工作区时弹窗说明原因，而不是把自己藏起来", () => {
    const app = read("app.js");
    const body = functionBody(app, "function renderMention(");
    expect(body).toContain("t.mentionNothingHere");
    expect(body).toContain("mention-hint");
    // The empty branch must render a hint and stay visible. Hiding it leaves
    // the reader with a keystroke that did nothing and no reason.
    const empty = body.slice(body.indexOf("if (files.length === 0)"));
    expect(empty).toContain("fileMention.hidden = false");
    const branch = empty.slice(0, empty.indexOf("files.forEach("));
    expect(branch).not.toContain("fileMention.hidden = true");
  });

  it("两种语言都有「这里没有可引用的文件」", () => {
    for (const locale of ["en", "zh"]) {
      const text = dictionaries[locale].mentionNothingHere;
      expect(typeof text).toBe("string");
      expect(text.trim()).not.toBe("");
    }
    expect(dictionaries.zh.mentionNothingHere).toContain("没有可引用");
    // It must not be the "unavailable" sentence again: that one names a broken
    // build, which is a different fact with a different fix.
    expect(dictionaries.zh.mentionNothingHere).not.toBe(dictionaries.zh.mentionSearchUnavailable);
  });
});
