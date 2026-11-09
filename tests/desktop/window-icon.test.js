import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 窗口图标必须在**装好之后也存在**（2026-11-09 用户报「桌面任务栏显示的图标
 * 不是应用图标」）。
 *
 * 当时的代码是 `icon: join(here, "build", "icon.ico")`。`here` 在 asar 根，
 * 而 `build/` 是打包器的**输入**目录（`win.icon` 从那里读、写进 exe 的资源段），
 * 它**不在 `build.files` 里**——所以装好之后 asar 内没有这个文件。
 *
 * 传一个不存在的 `icon` 不会报错。Electron 只是回退到默认图标，于是任务栏
 * 显示 Electron 的标志。这类缺陷没有任何运行时错误可抓：check:js 只查语法，
 * 打包器不校验，开发形态（`electron .`，`here` 是源码目录）里那个路径**恰好
 * 存在**，所以本地跑一遍也看不出来。
 *
 * 所以断言的是**路径落在一个会被打进 asar 的目录里**，而不是路径存在。
 */
const ROOT = path.join(import.meta.dirname, "..", "..");
const DESKTOP = path.join(ROOT, "desktop");

const readMain = () => readFileSync(path.join(DESKTOP, "main.js"), "utf8");
const readPkg = () => JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf8"));

/** `icon:` 那一行里出现的所有字符串路径片段（去掉平台分支）。 */
function iconPathParts(source) {
  const line = source.split("\n").find((entry) => entry.includes("icon: join(here,"));
  expect(line, "BrowserWindow 的 icon 应当是一句 join(here, …)").toBeDefined();
  return [...line.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    // 平台三元里的 `win32` 只是比较对象，不是路径片段。
    .filter((part) => part !== "win32");
}

/** `build.files` 里有没有一条 glob 能覆盖这个相对路径。 */
function coveredByFiles(relPath, files) {
  const posix = relPath.split(path.sep).join("/");
  return files.some((pattern) => {
    const glob = String(pattern);
    // `renderer/**/*` → 前缀 `renderer/` 且至少再一层。
    if (glob.endsWith("/**/*")) {
      const prefix = glob.slice(0, -"/**/*".length);
      return posix.startsWith(`${prefix}/`) && posix.length > prefix.length + 1;
    }
    // `*` / `**/*` 这类宽通配按「什么都覆盖」处理（当前的 files 里没有）。
    if (glob === "*" || glob === "**/*") return true;
    // 普通文件名：精确匹配，或 `dir/**` 覆盖其下。
    if (glob.endsWith("/**")) {
      const prefix = glob.slice(0, -"/**".length);
      return posix === prefix || posix.startsWith(`${prefix}/`);
    }
    return glob === posix;
  });
}

describe("窗口 / 任务栏图标", () => {
  it("icon 指向的每个文件都落在 build.files 覆盖范围内", () => {
    const files = readPkg().build.files;
    const parts = iconPathParts(readMain()).filter((part) => !part.includes("/"));
    const dirParts = iconPathParts(readMain()).filter((part) => !part.endsWith(".ico") && !part.endsWith(".png"));
    const dir = dirParts.join("/");
    const names = parts.filter((part) => part.endsWith(".ico") || part.endsWith(".png"));
    expect(names.length, "应当至少点名一个图标文件").toBeGreaterThan(0);
    for (const name of names) {
      const rel = `${dir}/${name}`;
      expect(
        coveredByFiles(rel, files),
        `icon 的 ${rel} 不在 build.files 里——装好之后 asar 内不会有它，` +
          "Electron 会静默回退到默认图标",
      ).toBe(true);
    }
  });

  it("那个文件在源码树里真的存在（开发形态也要能加载）", () => {
    const parts = iconPathParts(readMain());
    const dir = parts.filter((part) => !part.endsWith(".ico") && !part.endsWith(".png")).join("/");
    for (const name of parts.filter((part) => part.endsWith(".ico") || part.endsWith(".png"))) {
      const file = path.join(DESKTOP, dir, name);
      expect(existsSync(file), `${file} 不存在`).toBe(true);
    }
  });

  it("不再指向 build/ —— 那是打包器的输入目录，不进 asar", () => {
    // The regression this file exists for. `build/icon.ico` is electron-builder's
    // input (it becomes the exe's RT_GROUP_ICON); it is not packaged.
    const parts = iconPathParts(readMain());
    expect(parts).not.toContain("build");
    expect(readPkg().build.win.icon).toBe("build/icon.ico");
  });
});
