import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries } from "../../desktop/renderer/i18n.js";

/**
 * Two promises the composer used to make without any producer behind them
 * (D-186 / D-188 / OPT-07). Both are copy-level: the bug was that the UI said
 * something happened that the kernel never did. A behavioural test would need
 * a DOM and a host; what has to stay true is simpler — the words are gone, and
 * the honest replacement is in both languages.
 */
const RENDERER = path.join(import.meta.dirname, "..", "..", "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

describe("composer copy never promises what the kernel does not do", () => {
  it("「排队」整套 UI 与死代码不在了（queued / user_queued_delivered 无生产者）", () => {
    const needles = [
      "queued-badge",
      "queued-tag",
      "queueSend",
      "queuedTag",
      "queuedCount",
      "setQueuedBadge",
      "markQueuedDelivered",
      "user_queued_delivered",
    ];
    const offenders = [];
    for (const file of ["app.js", "index.html", "styles.css", "i18n.js"]) {
      const text = read(file);
      for (const needle of needles) {
        if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it("图片附件不再有「看起来发出去了」的文案", () => {
    for (const file of ["app.js", "i18n.js"]) {
      expect(read(file)).not.toContain("imageOnlyPrompt");
    }
  });

  it("两处拒绝在两种语言里都有话说", () => {
    for (const locale of ["en", "zh"]) {
      for (const key of ["busyThisTurn", "attachmentNotSent"]) {
        expect(typeof dictionaries[locale][key]).toBe("string");
        expect(dictionaries[locale][key].trim()).not.toBe("");
      }
    }
  });

  it("会话边界清空附件条（D-224）：新建与打开会话两条路径都要清", () => {
    const text = read("app.js");
    // 新建会话：`startSessionIn` 发 `newSession` 之前清。
    const newSessionIndex = text.indexOf('clearAttachments();\n  api.send({ cmd: "newSession" });');
    expect(newSessionIndex).toBeGreaterThan(-1);
    // 打开会话：`session_loaded` 分支里清（与清转录、清成本放在一起）。
    const loadedStart = text.indexOf('case "session_loaded"');
    expect(loadedStart).toBeGreaterThan(-1);
    const nextCase = text.indexOf('case "', loadedStart + 10);
    const loadedBlock = text.slice(loadedStart, nextCase === -1 ? undefined : nextCase);
    expect(loadedBlock).toContain("clearAttachments()");
  });
});
