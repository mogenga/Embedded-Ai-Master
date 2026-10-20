import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionCorruptionError } from "../src/session/errors.js";
import { readSessionSnapshot } from "../src/session/persistence.js";
import { createSession } from "../src/session/session.js";
import { createLogTailEventSource } from "../src/events/log-tail.js";
import { SessionNotFoundError } from "../src/events/types.js";
import type { SessionEvent } from "../src/session/types.js";

type Session = Awaited<ReturnType<typeof createSession>>;

const tempDirs: string[] = [];
const controllers: AbortController[] = [];
const sessions: Session[] = [];

function makeTempDir(prefix = "events-log-tail-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function detectDirLinkSupport(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "events-log-tail-link-probe-"));
  try {
    const target = path.join(dir, "target");
    mkdirSync(target);
    symlinkSync(target, path.join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dirLinkSupported = detectDirLinkSupport();

async function makeSession(root: string, id = "sess-1"): Promise<{ dir: string; session: Session }> {
  const dir = path.join(root, id);
  const session = await createSession(dir, { id });
  sessions.push(session);
  return { dir, session };
}

function logPath(dir: string, generation = 1): string {
  return path.join(dir, `session.v${generation}.jsonl`);
}

function lineOf(event: SessionEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function event(seq: number, payload: Record<string, unknown> = { content: "x" }): SessionEvent {
  return { seq, ts: "2026-10-19T00:00:00.000Z", type: "user", payload };
}

function withTimeout<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function controller(): AbortController {
  const value = new AbortController();
  controllers.push(value);
  return value;
}

async function take<T extends SessionEvent>(count: number, iterable: AsyncIterable<T>): Promise<T[]> {
  const iterator = iterable[Symbol.asyncIterator]();
  const out: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = await withTimeout(iterator.next());
    if (next.done === true) throw new Error(`iterator ended after ${out.length} events`);
    out.push(next.value);
  }
  return out;
}

async function nextEvent<T extends SessionEvent>(iterator: AsyncIterator<T>, ms = 2_000): Promise<T> {
  const next = await withTimeout(iterator.next(), ms);
  if (next.done === true) throw new Error("iterator ended unexpectedly");
  return next.value;
}

describe("readSessionSnapshot", () => {
  it("open 会话尾部半行进入 pendingTail，offset 指向半行起始字节", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    const first = await session.append({ type: "user", payload: { content: "a" } });
    const completeBytes = statSync(logPath(dir)).size;
    const partial = Buffer.from(JSON.stringify(event(1, { content: "中文" })).slice(0, 20), "utf8");
    appendFileSync(logPath(dir), partial);

    const snapshot = await readSessionSnapshot(dir, { allowTrailingPartial: true });

    expect(snapshot.header.status).toBe("open");
    expect(snapshot.events).toEqual([first]);
    expect(snapshot.generations).toEqual([{ file: "session.v1.jsonl", offset: completeBytes }]);
    expect(snapshot.pendingTail?.file).toBe("session.v1.jsonl");
    expect(snapshot.pendingTail?.offset).toBe(completeBytes);
    expect(snapshot.pendingTail?.bytes.equals(partial)).toBe(true);
  });

  it("closed 会话尾部 JSON 不完整 → SessionCorruptionError", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.close();
    appendFileSync(logPath(dir), '{"seq":1,"ts":"t"');

    await expect(readSessionSnapshot(dir, { allowTrailingPartial: true })).rejects.toBeInstanceOf(
      SessionCorruptionError,
    );
  });

  it("closed 会话尾部无换行但 JSON 完整 → 按完整事件返回", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.close();
    const second = event(1, { content: "无换行" });
    appendFileSync(logPath(dir), JSON.stringify(second));

    const snapshot = await readSessionSnapshot(dir, { allowTrailingPartial: true });

    expect(snapshot.events.map((item) => item.seq)).toEqual([0, 1]);
    expect(snapshot.pendingTail).toBeUndefined();
    expect(snapshot.generations[0]?.offset).toBe(statSync(logPath(dir)).size);
  });

  it("默认 allowTrailingPartial:false 时 open 会话半行 → SessionCorruptionError", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    appendFileSync(logPath(dir), '{"seq":1,"ts":"t"');

    await expect(readSessionSnapshot(dir)).rejects.toBeInstanceOf(SessionCorruptionError);
    await expect(
      readSessionSnapshot(dir, { allowTrailingPartial: false }),
    ).rejects.toBeInstanceOf(SessionCorruptionError);
  });

  it("非末代尾部半行 → SessionCorruptionError（即使 header 是 open）", async () => {
    const root = makeTempDir();
    const dir = path.join(root, "sess-gap");
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "header.json"),
      `${JSON.stringify({ id: "sess-gap", createdAt: "2026-10-19T00:00:00.000Z", status: "open" })}
`,
      "utf8",
    );
    writeFileSync(
      logPath(dir, 1),
      lineOf(event(0, { content: "a" })) + '{"seq":1,"ts":"t"',
      "utf8",
    );
    writeFileSync(logPath(dir, 2), lineOf(event(1, { content: "b" })), "utf8");

    await expect(
      readSessionSnapshot(dir, { allowTrailingPartial: true }),
    ).rejects.toBeInstanceOf(SessionCorruptionError);
  });

  it("完整行 JSON 损坏 → SessionCorruptionError", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.close();
    appendFileSync(logPath(dir), "{oops}\n");

    await expect(readSessionSnapshot(dir, { allowTrailingPartial: true })).rejects.toBeInstanceOf(
      SessionCorruptionError,
    );
  });
});

describe("createLogTailEventSource.read", () => {
  it("read(id, -1) 返回全部事件并带 sessionId；since 过滤生效", async () => {
    const root = makeTempDir();
    const { session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.append({ type: "checkpoint", payload: { turn: 1 } });
    await session.append({ type: "usage", payload: { promptTokens: 1 } });
    const source = createLogTailEventSource({ sessionsRoot: root });

    const all = await source.read("sess-1", -1);
    expect(all.header.id).toBe("sess-1");
    expect(all.events.map((item) => item.seq)).toEqual([0, 1, 2]);
    expect(all.events.every((item) => item.sessionId === "sess-1")).toBe(true);
    expect(all.headSeq).toBe(2);

    expect((await source.read("sess-1", 1)).events.map((item) => item.seq)).toEqual([2]);
    expect((await source.read("sess-1", 0)).events.map((item) => item.seq)).toEqual([1, 2]);
    expect((await source.read("sess-1", 2)).events).toEqual([]);
    expect((await source.read("sess-1", 99)).headSeq).toBe(2);
  });

  it("活跃会话尾部半行不报错，补全后可读到", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    const second = event(1, { content: "补全" });
    const serialized = JSON.stringify(second);
    appendFileSync(logPath(dir), serialized.slice(0, 12));
    const source = createLogTailEventSource({ sessionsRoot: root });

    expect((await source.read("sess-1", -1)).events.map((item) => item.seq)).toEqual([0]);

    appendFileSync(logPath(dir), `${serialized.slice(12)}\n`);

    expect((await source.read("sess-1", -1)).events.map((item) => item.seq)).toEqual([0, 1]);
  });

  it("非法 ID 与不存在的会话抛 SessionNotFoundError 且不泄露真实路径", async () => {
    const root = makeTempDir();
    await makeSession(root);
    const source = createLogTailEventSource({ sessionsRoot: root });

    for (const id of ["../escape", "bad id", "missing", "CON", ""]) {
      const error = await source.read(id, -1).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionNotFoundError);
      expect((error as Error).message).not.toContain(root);
      expect((error as Error).message).not.toContain(path.resolve(root));
    }
  });

  it("分代文件合并读取，seq 断档抛错", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.close();
    writeFileSync(logPath(dir, 2), lineOf(event(1, { content: "b" })), "utf8");
    const source = createLogTailEventSource({ sessionsRoot: root });

    expect((await source.read("sess-1", -1)).events.map((item) => item.seq)).toEqual([0, 1]);

    const brokenRoot = makeTempDir();
    const broken = await makeSession(brokenRoot, "sess-2");
    await broken.session.append({ type: "user", payload: { content: "a" } });
    await broken.session.close();
    writeFileSync(logPath(broken.dir, 2), lineOf(event(5, { content: "b" })), "utf8");
    const brokenSource = createLogTailEventSource({ sessionsRoot: brokenRoot });

    await expect(brokenSource.read("sess-2", -1)).rejects.toMatchObject({ code: "invalid_seq" });
  });

  it.skipIf(!dirLinkSupported)("指向 root 外的目录链接 → SessionNotFoundError 且不泄露路径", async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    const victim = await makeSession(outside, "victim");
    symlinkSync(victim.dir, path.join(root, "evil"), process.platform === "win32" ? "junction" : "dir");
    const source = createLogTailEventSource({ sessionsRoot: root });

    const error = await source.read("evil", -1).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionNotFoundError);
    expect((error as Error).message).not.toContain(victim.dir);
    expect((error as Error).message).not.toContain(outside);

    const followError = await (async () => {
      for await (const _item of source.follow("evil", -1, controller().signal)) {
        void _item;
      }
    })().catch((caught: unknown) => caught);
    expect(followError).toBeInstanceOf(SessionNotFoundError);
    expect((followError as Error).message).not.toContain(victim.dir);
  });
});

describe("createLogTailEventSource.follow", () => {
  it("read 与 follow 交接窗口：追加后启动 follow 能补发 read 之后的事件", async () => {
    const root = makeTempDir();
    const { session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.append({ type: "usage", payload: { promptTokens: 1 } });
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const handoff = await source.read("sess-1", 1);
    const lastSeq = handoff.events.at(-1)?.seq ?? 1;

    const appended = await session.append({ type: "checkpoint", payload: { turn: 2 } });
    const received = await take(1, source.follow("sess-1", lastSeq, controller().signal));

    expect(received.map((item) => item.seq)).toEqual([appended.seq]);
    expect(received[0]?.sessionId).toBe("sess-1");
  });

  it("pendingTail：启动 follow 时半行未完成，补全后事件只出现一次", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    const first = await session.append({ type: "user", payload: { content: "a" } });
    const second = event(1, { content: "中文" });
    const serialized = JSON.stringify(second);
    appendFileSync(logPath(dir), serialized.slice(0, 15));

    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const iterator = source.follow("sess-1", -1, controller().signal)[Symbol.asyncIterator]();

    const snapshotPart = await nextEvent(iterator);
    expect(snapshotPart.seq).toBe(first.seq);

    appendFileSync(logPath(dir), `${serialized.slice(15)}\n`);
    const completed = await nextEvent(iterator);
    expect(completed).toMatchObject({ seq: 1, sessionId: "sess-1" });
    expect(completed.payload.content).toBe("中文");

    const third = event(2, { content: "c" });
    appendFileSync(logPath(dir), lineOf(third));
    const nextOne = await nextEvent(iterator);
    expect(nextOne.seq).toBe(2);
    expect(nextOne.payload).toMatchObject({ content: "c" });
  });

  it("follow 在 append 后 3 个轮询周期内产出，close 后自然结束", async () => {
    const root = makeTempDir();
    const { session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const iterator = source.follow("sess-1", -1, controller().signal)[Symbol.asyncIterator]();

    expect((await nextEvent(iterator)).seq).toBe(0);
    const appended = await session.append({ type: "usage", payload: { promptTokens: 1 } });
    expect((await nextEvent(iterator, 120)).seq).toBe(appended.seq);

    const closed = session.close();
    const ended = await withTimeout(iterator.next(), 600);
    expect(ended.done).toBe(true);
    await closed;
  });

  it("abort 发生在快照回放期间：剩余历史事件不再产出", async () => {
    const root = makeTempDir();
    const { session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.append({ type: "checkpoint", payload: { turn: 1 } });
    await session.append({ type: "usage", payload: { promptTokens: 1 } });
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const abort = controller();
    const iterator = source.follow("sess-1", -1, abort.signal)[Symbol.asyncIterator]();

    expect((await nextEvent(iterator)).seq).toBe(0);
    abort.abort();

    const ended = await withTimeout(iterator.next(), 150);
    expect(ended.done).toBe(true);
  });

  it("空 v1：read 返回空事件，follow 等待后续 append", async () => {
    const root = makeTempDir();
    const { session } = await makeSession(root);
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });

    expect((await source.read("sess-1", -1)).events).toEqual([]);

    const iterator = source.follow("sess-1", -1, controller().signal)[Symbol.asyncIterator]();
    const appended = await session.append({ type: "user", payload: { content: "first" } });
    const received = await nextEvent(iterator, 120);
    expect(received.seq).toBe(appended.seq);
    expect(received.sessionId).toBe("sess-1");
  });

  it("截断后从 0 重扫并按 seq 去重，不因重复报错", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a".repeat(400) } });
    await session.append({ type: "checkpoint", payload: { turn: 1 } });
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const iterator = source.follow("sess-1", -1, controller().signal)[Symbol.asyncIterator]();

    expect((await nextEvent(iterator)).seq).toBe(0);
    expect((await nextEvent(iterator)).seq).toBe(1);

    const oldSize = statSync(logPath(dir)).size;
    const rewritten =
      lineOf(event(0, { content: "a" })) + lineOf(event(2, { content: "c" }));
    expect(Buffer.byteLength(rewritten, "utf8")).toBeLessThan(oldSize);
    truncateSync(logPath(dir), 0);
    writeFileSync(logPath(dir), rewritten, "utf8");

    const emitted = await nextEvent(iterator);
    expect(emitted.seq).toBe(2);
    expect(emitted.payload).toMatchObject({ content: "c" });
  });

  it("跟随期间发生分代滚代：新代从 0 开始且 seq 连续", async () => {
    const root = makeTempDir();
    const dir = path.join(root, "sess-roll");
    const session = await createSession(dir, {
      id: "sess-roll",
      generationThresholdBytes: 200,
    });
    sessions.push(session);
    const first = await session.append({ type: "user", payload: { content: "start" } });
    expect(existsSync(logPath(dir, 2))).toBe(false);

    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const iterator = source.follow("sess-roll", -1, controller().signal)[Symbol.asyncIterator]();
    expect((await nextEvent(iterator)).seq).toBe(first.seq);

    const appended: number[] = [first.seq];
    let firstV2Seq: number | undefined;
    for (let index = 1; index <= 5; index += 1) {
      const item = await session.append({
        type: "user",
        payload: { content: "x".repeat(60) + index },
      });
      appended.push(item.seq);
      const received = await nextEvent(iterator);
      expect(received.seq).toBe(item.seq);
      if (firstV2Seq === undefined && existsSync(logPath(dir, 2))) {
        firstV2Seq = item.seq;
      }
    }

    expect(firstV2Seq).toBeDefined();
    expect(appended).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(appended).size).toBe(appended.length);
    const firstV2Line = readFileSync(logPath(dir, 2), "utf8").split("\n")[0]!;
    expect(JSON.parse(firstV2Line) as SessionEvent).toMatchObject({ seq: firstV2Seq });
  });

  it("非截断场景出现重复 seq → invalid_seq", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const iterator = source.follow("sess-1", -1, controller().signal)[Symbol.asyncIterator]();

    expect((await nextEvent(iterator)).seq).toBe(0);
    appendFileSync(logPath(dir), lineOf(event(0, { content: "dup" })));

    const error = await nextEvent(iterator).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionCorruptionError);
    expect((error as SessionCorruptionError).code).toBe("invalid_seq");
  });

  it("真实 follow 路径上多字节字符跨 append 不损坏", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    const second = event(1, { content: "中文测试" });
    const bytes = Buffer.from(JSON.stringify(second), "utf8");
    const charIndex = bytes.indexOf(Buffer.from("中", "utf8"));
    appendFileSync(logPath(dir), bytes.subarray(0, charIndex + 1));

    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const iterator = source.follow("sess-1", -1, controller().signal)[Symbol.asyncIterator]();
    expect((await nextEvent(iterator)).seq).toBe(0);

    appendFileSync(logPath(dir), Buffer.concat([bytes.subarray(charIndex + 1), Buffer.from("\n")]));
    const completed = await nextEvent(iterator);
    expect(completed.seq).toBe(1);
    expect(completed.payload.content).toBe("中文测试");
    expect(JSON.stringify(completed.payload)).not.toContain("\uFFFD");
  });

  it("截断后重扫停在半行：补全时重放旧 seq 不误报 invalid_seq", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.append({ type: "checkpoint", payload: { turn: 1 } });
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const iterator = source.follow("sess-1", -1, controller().signal)[Symbol.asyncIterator]();
    expect((await nextEvent(iterator)).seq).toBe(0);
    expect((await nextEvent(iterator)).seq).toBe(1);

    const thirdLine = JSON.stringify(event(2, { content: "c" }));
    truncateSync(logPath(dir), 0);
    writeFileSync(logPath(dir), lineOf(event(0, { content: "a" })), "utf8");
    appendFileSync(logPath(dir), thirdLine.slice(0, 10));

    await withTimeout(new Promise((resolve) => setTimeout(resolve, 80)), 200);
    expect(statSync(logPath(dir)).size).toBeGreaterThan(0);

    appendFileSync(logPath(dir), `${thirdLine.slice(10)}\n`);
    const emitted = await nextEvent(iterator);
    expect(emitted.seq).toBe(2);
    expect(emitted.payload).toMatchObject({ content: "c" });
  });

  it("open 会话空白-only 尾行不报损坏，后续事件正常产出", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    appendFileSync(logPath(dir), "   ");
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const iterator = source.follow("sess-1", -1, controller().signal)[Symbol.asyncIterator]();
    expect((await nextEvent(iterator)).seq).toBe(0);

    appendFileSync(logPath(dir), "\n");
    const appended = event(1, { content: "b" });
    appendFileSync(logPath(dir), lineOf(appended));

    const emitted = await nextEvent(iterator);
    expect(emitted.seq).toBe(1);
    expect(emitted.payload).toMatchObject({ content: "b" });
  });

  it("目录名与 header.id 不一致 → SessionNotFoundError", async () => {
    const root = makeTempDir();
    const dir = path.join(root, "sess-dir");
    const session = await createSession(dir, { id: "sess-other" });
    sessions.push(session);
    await session.append({ type: "user", payload: { content: "a" } });
    const source = createLogTailEventSource({ sessionsRoot: root });

    await expect(source.read("sess-dir", -1)).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("follow 期间 header 消失 → SessionNotFoundError 且不泄露绝对路径", async () => {
    const root = makeTempDir();
    const { dir, session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const iterator = source.follow("sess-1", -1, controller().signal)[Symbol.asyncIterator]();
    expect((await nextEvent(iterator)).seq).toBe(0);

    unlinkSync(path.join(dir, "header.json"));
    const error = await withTimeout(iterator.next(), 300).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionNotFoundError);
    expect((error as Error).message).not.toContain(dir);
    expect((error as Error).message).not.toContain(root);
  });

  it("abort 后 follow 在当前/下一轮询内停止", async () => {
    const root = makeTempDir();
    const { session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 50 });
    const abort = controller();
    const iterator = source.follow("sess-1", -1, abort.signal)[Symbol.asyncIterator]();

    expect((await nextEvent(iterator)).seq).toBe(0);
    abort.abort();

    const ended = await withTimeout(iterator.next(), 150);
    expect(ended.done).toBe(true);
  });
});

describe("since 参数校验", () => {
  it.each([Number.NaN, 1.5, -2, Number.POSITIVE_INFINITY])(
    "非法 since（%s）→ TypeError",
    async (since) => {
      const root = makeTempDir();
      const { session } = await makeSession(root);
      await session.append({ type: "user", payload: { content: "a" } });
      const source = createLogTailEventSource({ sessionsRoot: root });

      await expect(source.read("sess-1", since)).rejects.toBeInstanceOf(TypeError);
      expect(() => source.follow("sess-1", since, controller().signal)).toThrow(TypeError);
    },
  );

  it("since 超过 head 时夹紧到 head，后续增量不断档", async () => {
    const root = makeTempDir();
    const { session } = await makeSession(root);
    await session.append({ type: "user", payload: { content: "a" } });
    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });

    expect((await source.read("sess-1", 99)).events).toEqual([]);

    const iterator = source.follow("sess-1", 99, controller().signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const appended = await session.append({ type: "usage", payload: { promptTokens: 1 } });
    const next = await withTimeout(pending, 300);
    expect(next.done).toBe(false);
    if (next.done === true) throw new Error("follow ended unexpectedly");
    expect(next.value.seq).toBe(appended.seq);
    expect(next.value.seq).toBe(1);
  });
});
