import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SYSTEM_SECTION_ORDER,
  hashSections,
  renderEnvironmentSection,
  renderSections,
} from "../src/context/system-sections.js";
import {
  SESSION_META_FILE,
  promptSectionsEqual,
  readSessionMeta,
  writeSessionMeta,
} from "../src/session/metadata.js";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eam-system-sections-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  // 只清理本用例自己创建的临时目录，不做任何系统级删除。
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("renderEnvironmentSection", () => {
  it("四个字段齐全时按固定顺序输出，只写事实", () => {
    const output = renderEnvironmentSection({
      workdir: "E:\\Project\\personal\\Embedded-Ai-Master",
      platform: "win32",
      shell: "C:\\Windows\\System32\\cmd.exe",
      createdDate: "2026-11-06",
    });

    expect(output).toBe(
      [
        "Working directory: E:/Project/personal/Embedded-Ai-Master",
        "Platform: win32",
        "Shell: C:\\Windows\\System32\\cmd.exe",
        "Date: 2026-11-06",
      ].join("\n"),
    );
  });

  it("workdir 的退格转成正斜杠（内部路径统一 POSIX 风格）", () => {
    const output = renderEnvironmentSection({
      workdir: "C:\\Users\\mogen\\proj",
      platform: "win32",
      shell: undefined,
      createdDate: "2026-11-06",
    });

    expect(output).toContain("Working directory: C:/Users/mogen/proj");
    expect(output).not.toContain("\\");
  });

  it("shell 缺失时整行省略，不写 unknown", () => {
    const output = renderEnvironmentSection({
      workdir: "/home/u/proj",
      platform: "linux",
      shell: undefined,
      createdDate: "2026-11-06",
    });

    expect(output.split("\n")).toStrictEqual([
      "Working directory: /home/u/proj",
      "Platform: linux",
      "Date: 2026-11-06",
    ]);
    expect(output).not.toMatch(/shell/i);
  });

  it("同一输入两次调用逐字节相同", () => {
    const facts = {
      workdir: "/w",
      platform: "darwin" as const,
      shell: "/bin/zsh",
      createdDate: "2026-11-06",
    };

    expect(renderEnvironmentSection(facts)).toBe(renderEnvironmentSection(facts));
  });

  it("日期只到日：不读当前时间，也不带时刻", () => {
    const today = new Date().toISOString().slice(0, 10);
    const output = renderEnvironmentSection({
      workdir: "/w",
      platform: "linux",
      shell: "/bin/bash",
      createdDate: "2001-02-03T12:34:56.000Z",
    });

    expect(output).toContain("Date: 2001-02-03");
    expect(output).not.toContain(today);
    expect(output).not.toContain("12:34");
    expect(output).not.toMatch(/\d{2}:\d{2}/);
  });
});

describe("renderSections", () => {
  it("按稳定性降序输出，顺序不随入参对象键顺序变化", () => {
    const rendered = renderSections({
      summary: "S",
      memory: "M",
      instructions: "I",
      tools: "T",
      environment: "E",
      base: "B",
    });

    expect(rendered.map((section) => section.key)).toStrictEqual([...SYSTEM_SECTION_ORDER]);
    expect(rendered.map((section) => section.content.split("\n")[0])).toStrictEqual([
      "# Base",
      "# Environment",
      "# Tools",
      "# Instructions",
      "# Memory",
      "# Summary",
    ]);
  });

  it("空串与全空白的节整节省略（不留空标题）", () => {
    const rendered = renderSections({
      base: "",
      environment: "   \n\t ",
      tools: "T",
    });

    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.key).toBe("tools");
    expect(rendered[0]!.content).toBe("# Tools\nT");
  });

  it("标题逐字节稳定，同输入两次输出相同", () => {
    const sections = { base: "B", environment: "E" };

    expect(renderSections(sections)).toStrictEqual(renderSections(sections));
  });

  it("全部为空时返回空数组", () => {
    expect(renderSections({})).toStrictEqual([]);
    expect(renderSections({ base: " ", memory: "\n" })).toStrictEqual([]);
  });
});

describe("hashSections", () => {
  it("同内容同哈希，哈希为 sha256 十六进制，chars 为内容字符数", () => {
    const entries = renderSections({ base: "abc" });

    const first = hashSections(entries);
    const second = hashSections(renderSections({ base: "abc" }));

    expect(first).toStrictEqual(second);
    expect(first.base!.hash).toBe(
      createHash("sha256").update(entries[0]!.content, "utf8").digest("hex"),
    );
    expect(first.base!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.base!.chars).toBe(entries[0]!.content.length);
    expect(first.base!.chars).toBeGreaterThan(0);
  });

  it("改一个字哈希就变", () => {
    const before = hashSections(renderSections({ environment: "Platform: linux" }));
    const after = hashSections(renderSections({ environment: "Platform: Linux" }));

    expect(after.environment!.hash).not.toBe(before.environment!.hash);
  });

  it("空内容 chars 为 0", () => {
    expect(hashSections([{ key: "x", content: "" }])).toStrictEqual({
      x: {
        hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        chars: 0,
      },
    });
  });
});

describe("meta.json 的 promptSections", () => {
  const sections = {
    environment: { hash: "a".repeat(64), chars: 42 },
    base: { hash: "b".repeat(64), chars: 7 },
  };

  it("写入后可读回；只改标题时不会被丢掉（三处同改）", async () => {
    const dir = makeDir();

    await writeSessionMeta(dir, { promptSections: sections });
    expect(readSessionMeta(dir).promptSections).toStrictEqual(sections);

    await writeSessionMeta(dir, { title: "改个标题" });
    const meta = readSessionMeta(dir);

    expect(meta.title).toBe("改个标题");
    expect(meta.promptSections).toStrictEqual(sections);
  });

  it("坏形状项逐项丢弃，好项保留", async () => {
    const dir = makeDir();
    writeFileSync(
      path.join(dir, SESSION_META_FILE),
      JSON.stringify({
        updatedAt: "2026-01-01T00:00:00.000Z",
        promptSections: {
          good: { hash: "abc", chars: 3 },
          emptyHash: { hash: "", chars: 3 },
          numberHash: { hash: 5, chars: 3 },
          negativeChars: { hash: "abc", chars: -1 },
          fractionalChars: { hash: "abc", chars: 1.5 },
          stringChars: { hash: "abc", chars: "3" },
          nullValue: null,
          notObject: "nope",
        },
      }),
      "utf8",
    );

    const meta = readSessionMeta(dir);

    expect(meta.promptSections).toStrictEqual({ good: { hash: "abc", chars: 3 } });
    expect(meta.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("字段整体不是对象或全部项都坏时视为不存在", async () => {
    const dir = makeDir();
    writeFileSync(
      path.join(dir, SESSION_META_FILE),
      JSON.stringify({ promptSections: { bad: { hash: "", chars: 1 } } }),
      "utf8",
    );
    expect(readSessionMeta(dir).promptSections).toBeUndefined();

    writeFileSync(
      path.join(dir, SESSION_META_FILE),
      JSON.stringify({ promptSections: "nope" }),
      "utf8",
    );
    expect(readSessionMeta(dir).promptSections).toBeUndefined();
  });

  it("patch 形状非法时拒绝写入", async () => {
    const dir = makeDir();

    await expect(
      writeSessionMeta(dir, {
        promptSections: { bad: { hash: "", chars: 1 } },
      }),
    ).rejects.toThrow(/hash/);
    await expect(
      writeSessionMeta(dir, {
        promptSections: { bad: { hash: "abc", chars: -1 } },
      }),
    ).rejects.toThrow(/chars/);
    await expect(
      writeSessionMeta(dir, {
        promptSections: { bad: { hash: "abc", chars: 1.5 } },
      }),
    ).rejects.toThrow(/chars/);
    await expect(
      writeSessionMeta(dir, { promptSections: null as never }),
    ).rejects.toThrow(/promptSections/);
    expect(readSessionMeta(dir).promptSections).toBeUndefined();
  });
});

describe("promptSectionsEqual", () => {
  it("内容相同（键顺序不同）视为相等", () => {
    expect(
      promptSectionsEqual(
        { a: { hash: "1", chars: 1 }, b: { hash: "2", chars: 2 } },
        { b: { hash: "2", chars: 2 }, a: { hash: "1", chars: 1 } },
      ),
    ).toBe(true);
  });

  it("哈希或字符数变化、缺键、多键都不等", () => {
    expect(
      promptSectionsEqual({ a: { hash: "1", chars: 1 } }, { a: { hash: "2", chars: 1 } }),
    ).toBe(false);
    expect(
      promptSectionsEqual({ a: { hash: "1", chars: 1 } }, { a: { hash: "1", chars: 2 } }),
    ).toBe(false);
    expect(promptSectionsEqual({ a: { hash: "1", chars: 1 } }, {})).toBe(false);
    expect(
      promptSectionsEqual(
        { a: { hash: "1", chars: 1 } },
        { a: { hash: "1", chars: 1 }, b: { hash: "2", chars: 2 } },
      ),
    ).toBe(false);
  });

  it("undefined 与空对象都表示没有节", () => {
    expect(promptSectionsEqual(undefined, undefined)).toBe(true);
    expect(promptSectionsEqual(undefined, {})).toBe(true);
    expect(promptSectionsEqual({}, undefined)).toBe(true);
    expect(promptSectionsEqual(undefined, { a: { hash: "1", chars: 1 } })).toBe(false);
  });
});
