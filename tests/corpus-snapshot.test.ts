import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CorpusLockError,
  ensureSnapshotDir,
  getKbLayout,
  listSnapshotVersions,
  pruneSnapshots,
  readCurrentVersion,
  readState,
  setCurrent,
  withUpdateLock,
  writeState,
} from "../src/corpus/snapshot.js";

// 全部用例只碰 os.tmpdir() 下的临时目录。绝不读写真实 $HARNESS_HOME（D-170：
// 测试曾把 fixture 写进用户真实配置目录，改变了真实运行行为）。
const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "corpus-snapshot-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 建好 v1..vN，返回布局，供切指针/清理类用例复用。 */
async function seedSnapshots(home: string, versions: number[]) {
  const layout = getKbLayout(home);
  for (const version of versions) await ensureSnapshotDir(layout, version);
  return layout;
}

describe("getKbLayout", () => {
  it("按契约 §3 拼出 kb/ 下的五个路径", () => {
    const home = path.join(os.tmpdir(), "some-home");
    const layout = getKbLayout(home);
    expect(layout.kbRoot).toBe(path.join(home, "kb"));
    expect(layout.snapshotsDir).toBe(path.join(home, "kb", "snapshots"));
    expect(layout.currentLink).toBe(path.join(home, "kb", "current"));
    expect(layout.inboxDir).toBe(path.join(home, "kb", "inbox"));
    expect(layout.stateFile).toBe(path.join(home, "kb", "state.json"));
  });

  it("是纯函数：不建任何目录", () => {
    const home = path.join(makeHome(), "not-created");
    getKbLayout(home);
    expect(existsSync(home)).toBe(false);
  });

  it("空 HARNESS_HOME 拒绝，避免把快照落到进程当前目录", () => {
    expect(() => getKbLayout("")).toThrow(/HARNESS_HOME/);
    expect(() => getKbLayout("   ")).toThrow(/HARNESS_HOME/);
  });
});

describe("ensureSnapshotDir", () => {
  it("建出 v<N> 并返回路径", async () => {
    const layout = getKbLayout(makeHome());
    const dir = await ensureSnapshotDir(layout, 3);
    expect(dir).toBe(path.join(layout.snapshotsDir, "v3"));
    expect(existsSync(dir)).toBe(true);
  });

  it("幂等：重复调用返回同一路径且不删既有内容", async () => {
    const layout = getKbLayout(makeHome());
    const first = await ensureSnapshotDir(layout, 2);
    writeFileSync(path.join(first, "index.yaml"), "version: 1\n", "utf8");
    const second = await ensureSnapshotDir(layout, 2);
    expect(second).toBe(first);
    expect(readFileSync(path.join(second, "index.yaml"), "utf8")).toBe("version: 1\n");
  });

  it("顺带建出 inbox/", async () => {
    const layout = getKbLayout(makeHome());
    await ensureSnapshotDir(layout, 1);
    expect(existsSync(layout.inboxDir)).toBe(true);
  });

  it("非法版本号抛错", async () => {
    const layout = getKbLayout(makeHome());
    await expect(ensureSnapshotDir(layout, -1)).rejects.toThrow(/版本号/);
    await expect(ensureSnapshotDir(layout, 1.5)).rejects.toThrow(/版本号/);
  });
});

describe("listSnapshotVersions", () => {
  it("目录不存在时返回空数组", async () => {
    const layout = getKbLayout(makeHome());
    await expect(listSnapshotVersions(layout)).resolves.toEqual([]);
  });

  it("过滤无法识别的目录名与同名文件，并按升序返回", async () => {
    const layout = getKbLayout(makeHome());
    mkdirSync(layout.snapshotsDir, { recursive: true });
    for (const name of ["v10", "v2", "v1"]) mkdirSync(path.join(layout.snapshotsDir, name));
    for (const name of ["beta", "v1x", "v", "snapshots.tmp"]) mkdirSync(path.join(layout.snapshotsDir, name));
    // v01 不是规范写法：若被当成 1，清理时就无法由版本号反推出目录名。
    mkdirSync(path.join(layout.snapshotsDir, "v01"));
    writeFileSync(path.join(layout.snapshotsDir, "v3"), "not a dir", "utf8");

    await expect(listSnapshotVersions(layout)).resolves.toEqual([1, 2, 10]);
  });
});

describe("setCurrent / readCurrentVersion", () => {
  it("指针不存在时 readCurrentVersion 返回 null", async () => {
    const layout = getKbLayout(makeHome());
    await expect(readCurrentVersion(layout)).resolves.toBeNull();
  });

  it("setCurrent 后能读回版本，并返回解析后的真实路径", async () => {
    const layout = await seedSnapshots(makeHome(), [1, 2]);
    const resolved = await setCurrent(layout, 2);
    expect(await readCurrentVersion(layout)).toBe(2);
    expect(resolved).toBe(path.join(layout.snapshotsDir, "v2"));
  });

  it("重复调用切到另一版本后可读（覆盖既有 junction）", async () => {
    const layout = await seedSnapshots(makeHome(), [1, 2, 3]);
    await setCurrent(layout, 1);
    await setCurrent(layout, 3);
    expect(await readCurrentVersion(layout)).toBe(3);
    // 旧快照不受影响：切换只动指针。
    expect(existsSync(path.join(layout.snapshotsDir, "v1"))).toBe(true);
  });

  it("current 指向的目录内容可通过指针读到", async () => {
    const layout = await seedSnapshots(makeHome(), [4]);
    writeFileSync(path.join(layout.snapshotsDir, "v4", "index.yaml"), "version: 4\n", "utf8");
    await setCurrent(layout, 4);
    expect(readFileSync(path.join(layout.currentLink, "index.yaml"), "utf8")).toBe("version: 4\n");
  });

  it("指向不存在的版本抛错，且原 current 保持不变", async () => {
    const layout = await seedSnapshots(makeHome(), [1]);
    await setCurrent(layout, 1);

    await expect(setCurrent(layout, 9)).rejects.toThrow(/快照目录不存在/);
    expect(await readCurrentVersion(layout)).toBe(1);
    // 原指针保持不变：仍解析到 v1，快照内容也还在。
    expect(await realpath(layout.currentLink)).toBe(await realpath(path.join(layout.snapshotsDir, "v1")));
    expect(existsSync(path.join(layout.snapshotsDir, "v1"))).toBe(true);
  });

  it("失败时不留下临时链接残留", async () => {
    const layout = await seedSnapshots(makeHome(), [1]);
    await setCurrent(layout, 1);
    await expect(setCurrent(layout, 7)).rejects.toThrow();
    const names = await readdir(layout.kbRoot);
    expect(names.filter((name) => name.startsWith("current.tmp-"))).toEqual([]);
  });

  it("current 是坏链（目标已删）时返回 null 而不是抛错", async () => {
    const layout = await seedSnapshots(makeHome(), [2]);
    await setCurrent(layout, 2);
    rmSync(path.join(layout.snapshotsDir, "v2"), { recursive: true, force: true });
    await expect(readCurrentVersion(layout)).resolves.toBeNull();
  });

  it("current 是普通目录时返回 null", async () => {
    const layout = getKbLayout(makeHome());
    mkdirSync(layout.currentLink, { recursive: true });
    await expect(readCurrentVersion(layout)).resolves.toBeNull();
  });
});

describe("pruneSnapshots", () => {
  it("保留最新 N 个，删掉更早的", async () => {
    const layout = await seedSnapshots(makeHome(), [1, 2, 3, 4, 5]);
    const removed = await pruneSnapshots(layout, 2);
    expect(removed).toEqual([1, 2, 3]);
    await expect(listSnapshotVersions(layout)).resolves.toEqual([4, 5]);
  });

  it("当前指针指向的旧版本一定保留（keep=2、current=v1、存在 v1..v5）", async () => {
    const layout = await seedSnapshots(makeHome(), [1, 2, 3, 4, 5]);
    await setCurrent(layout, 1);
    const removed = await pruneSnapshots(layout, 2);
    expect(removed).toEqual([2, 3]);
    await expect(listSnapshotVersions(layout)).resolves.toEqual([1, 4, 5]);
    expect(await readCurrentVersion(layout)).toBe(1);
  });

  it("不碰 inbox/、state.json 与 .lock", async () => {
    const layout = await seedSnapshots(makeHome(), [1, 2, 3, 4]);
    mkdirSync(layout.inboxDir, { recursive: true });
    writeFileSync(path.join(layout.inboxDir, "_inbox.md"), "- 本地笔记\n", "utf8");
    await writeState(layout, { lastResult: "up_to_date", corpusVersion: 4 });
    writeFileSync(path.join(layout.kbRoot, ".lock"), "", "utf8");

    await pruneSnapshots(layout, 1);

    expect(readFileSync(path.join(layout.inboxDir, "_inbox.md"), "utf8")).toBe("- 本地笔记\n");
    expect((await readState(layout)).lastResult).toBe("up_to_date");
    expect(existsSync(path.join(layout.kbRoot, "state.json"))).toBe(true);
    expect(existsSync(path.join(layout.kbRoot, ".lock"))).toBe(true);
  });

  it("快照数量不超过 keep 时什么都不删", async () => {
    const layout = await seedSnapshots(makeHome(), [1, 2]);
    await expect(pruneSnapshots(layout, 5)).resolves.toEqual([]);
    await expect(listSnapshotVersions(layout)).resolves.toEqual([1, 2]);
  });

  it("无法识别的目录名不会被删除", async () => {
    const layout = await seedSnapshots(makeHome(), [1, 2, 3]);
    mkdirSync(path.join(layout.snapshotsDir, "beta"));
    await pruneSnapshots(layout, 1);
    expect(existsSync(path.join(layout.snapshotsDir, "beta"))).toBe(true);
  });

  it("keep < 1 抛错", async () => {
    const layout = await seedSnapshots(makeHome(), [1]);
    await expect(pruneSnapshots(layout, 0)).rejects.toThrow(/保留数量/);
    await expect(pruneSnapshots(layout, -3)).rejects.toThrow(/保留数量/);
    await expect(pruneSnapshots(layout, 1.5)).rejects.toThrow(/保留数量/);
  });
});

describe("readState / writeState", () => {
  it("文件缺失时返回 never", async () => {
    const layout = getKbLayout(makeHome());
    await expect(readState(layout)).resolves.toEqual({ lastResult: "never" });
  });

  it("坏 JSON 返回 never 且不抛错", async () => {
    const layout = getKbLayout(makeHome());
    mkdirSync(layout.kbRoot, { recursive: true });
    writeFileSync(layout.stateFile, "{ this is not json", "utf8");
    await expect(readState(layout)).resolves.toEqual({ lastResult: "never" });
  });

  it("结果字段不认识时返回 never，不猜状态", async () => {
    const layout = getKbLayout(makeHome());
    mkdirSync(layout.kbRoot, { recursive: true });
    writeFileSync(layout.stateFile, JSON.stringify({ lastResult: "maybe_ok" }), "utf8");
    await expect(readState(layout)).resolves.toEqual({ lastResult: "never" });
  });

  it("writeState 往返，且不含临时文件残留", async () => {
    const layout = getKbLayout(makeHome());
    const state = {
      lastCheckedAt: "2026-10-23T12:00:00.000Z",
      lastResult: "update_available" as const,
      corpusVersion: 7,
      detail: "有新版",
    };
    await writeState(layout, state);
    await expect(readState(layout)).resolves.toEqual(state);

    const names = await readdir(layout.kbRoot);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("withUpdateLock", () => {
  it("持有期间第二次获取抛 CorpusLockError", async () => {
    const layout = getKbLayout(makeHome());

    await expect(
      withUpdateLock(layout, async () => {
        // 同一个进程内再取一次也算冲突：锁的粒度是「谁在更新」，不是「哪个进程」。
        await expect(withUpdateLock(layout, async () => "second")).rejects.toBeInstanceOf(CorpusLockError);
        return "first";
      }),
    ).resolves.toBe("first");
  });

  it("锁的错误信息说明另一个实例正在更新，并带锁路径", async () => {
    const layout = getKbLayout(makeHome());
    await withUpdateLock(layout, async () => {
      await withUpdateLock(layout, async () => "never").catch((error: unknown) => {
        expect(error).toBeInstanceOf(CorpusLockError);
        expect((error as Error).message).toContain("另一个实例正在更新");
        expect((error as CorpusLockError).lockPath).toBe(path.join(layout.kbRoot, ".lock"));
      });
    });
  });

  it("fn 抛错后仍然释放锁，可以再次获取", async () => {
    const layout = getKbLayout(makeHome());
    await expect(
      withUpdateLock(layout, async () => {
        throw new Error("下载失败");
      }),
    ).rejects.toThrow("下载失败");

    expect(existsSync(path.join(layout.kbRoot, ".lock"))).toBe(false);
    await expect(withUpdateLock(layout, async () => "retry")).resolves.toBe("retry");
  });

  it("返回 fn 的结果", async () => {
    const layout = getKbLayout(makeHome());
    await expect(withUpdateLock(layout, async () => 42)).resolves.toBe(42);
  });
});
