import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 批次 7 · 7.1：会话标题的有界读取。
 *
 * `sessions.titleOf()` 以前走 `sessions.detail()` → `readSessionDir()`，把**全部世代
 * 的全部日志**读进内存并逐行 `JSON.parse`，只为拿第一条 `user` 事件的 `content`。
 * 新的实现只读到第一条合格事件为止，输出行为（trim、80 字符截断加 `…`、找不到时
 * 回落 id）逐字符不变。
 *
 * 用例走真实宿主进程：`desktop/host/host.js` 是会启动 NDJSON 循环的程序，不能被
 * import，所以从侧栏 `sessions` 事件的 `title` 字段观察推导结果——这也正是渲染层
 * 看到的那个值。
 *
 * 其中「日志后段有坏 JSON 仍给出标题」一条是**有意的行为变化**（brief 实现要求 3）：
 * 旧实现整份日志解析失败就回落 id，新实现按行容错，坏行只跳过它自己。
 */
const HOST = path.join(import.meta.dirname, "..", "..", "desktop", "host", "host.js");
// 每个用例都要起一个 Node 宿主进程；满负载下会超过 vitest 的默认超时。
const HOST_TIMEOUT_MS = 30_000;
/** 新实现每次 `readSync` 读的字节数（brief 实现要求 1）。 */
const CHUNK = 64 * 1024;
const TS = "2026-01-01T00:00:00.000Z";
const tempDirs = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempHome() {
  const dir = await mkdtemp(path.join(tmpdir(), "eam-title-prefix-"));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, "providers.json"),
    JSON.stringify({
      gw: {
        protocol: "openai-chat-completions",
        // 从不连接：这些用例只打开列表，从不发起模型请求。
        baseUrl: "http://127.0.0.1:1/v1",
        models: { flash: { contextWindow: 8192, maxOutput: 512 } },
      },
    }),
    "utf8",
  );
  return dir;
}

function eventLine(seq, type, payload) {
  return `${JSON.stringify({ seq, ts: TS, type, payload })}\n`;
}

/** 一组 `{ type, payload }` 按 seq 顺序拼成一份日志。 */
function logOf(events) {
  return events.map(([type, payload], index) => eventLine(index, type, payload)).join("");
}

/**
 * 一条恰好 `targetBytes` 字节（含换行）的合法 `mcp_status` 行。
 *
 * 用来把后面的行摆到指定字节偏移上——跨块用例需要精确控制 user 事件从哪一字节开始。
 */
function paddedStatusLine(targetBytes) {
  const build = (padLength) =>
    `${JSON.stringify({ seq: 0, ts: TS, type: "mcp_status", payload: { server: "serial", state: "a".repeat(padLength) } })}\n`;
  const bare = Buffer.byteLength(build(0));
  const line = build(targetBytes - bare);
  expect(Buffer.byteLength(line)).toBe(targetBytes);
  return line;
}

/** 手写一个会话目录：header.json + 指定的日志文件。 */
async function writeSession(home, { id, logs }) {
  const dir = path.join(home, "sessions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "header.json"),
    JSON.stringify({ id, createdAt: TS, status: "closed" }),
    "utf8",
  );
  for (const [name, content] of Object.entries(logs)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

/**
 * 起宿主 → init → 等第一份含该行的 `sessions` 推送 → 取该行。
 *
 * `init` 自己就会推一次列表，所以不需要额外的 `listSessions`：这正是实测里
 * 每回合结束、每次 flag 变更都会走到的那条路径。
 */
async function rowOf(home, id) {
  const events = await runHost(home, [{ cmd: "init", cwd: home }], {
    until: (all) =>
      all.some(
        (event) => event.type === "sessions" && event.sessions.some((row) => row.id === id),
      ),
    timeoutMs: HOST_TIMEOUT_MS,
  });
  const push = events.filter((event) => event.type === "sessions").at(-1);
  const row = push.sessions.find((entry) => entry.id === id);
  expect(row, `no session row for ${id} in ${JSON.stringify(events.filter((e) => e.type === "sessions"))}`).toBeDefined();
  return row;
}

function runHost(home, commands, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: path.dirname(HOST),
      env: {
        ...process.env,
        HARNESS_HOME: home,
        AGENTS_HOME: path.join(home, ".agents-fixture"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let buffer = "";
    let lastCommand;
    const timer = setTimeout(() => {
      child.kill();
      const tail = events.slice(-3).map((event) => JSON.stringify(event).slice(0, 300));
      reject(new Error([
        "host timed out",
        `last command: ${JSON.stringify(lastCommand)}`,
        `last events (${events.length} total): ${tail.join(" | ") || "(none)"}`,
        `stderr: ${events.filter((event) => event.type === "stderr").map((event) => event.text).join("") || "(none)"}`,
      ].join("\n")));
    }, options.timeoutMs ?? HOST_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          events.push({ type: "unparsed", line });
        }
      }
      if (options.until !== undefined && options.until(events)) {
        child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      }
    });
    child.stderr.on("data", (chunk) => events.push({ type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(events);
    });

    for (const command of commands) {
      lastCommand = command;
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }
  });
}

describe("会话标题的有界读取（批次 7 · 7.1）", () => {
  it("首条 user 在日志开头：标题等于首条消息的 trim 结果", async () => {
    const home = await tempHome();
    await writeSession(home, {
      id: "sess-title-head",
      logs: { "session.v1.jsonl": logOf([["user", { content: "  串口没输出  " }]]) },
    });
    const row = await rowOf(home, "sess-title-head");
    expect(row.title).toBe("串口没输出");
  }, HOST_TIMEOUT_MS);

  it("首条 user 前有 40 条 mcp_status：不因前置事件漏读", async () => {
    const home = await tempHome();
    const noise = Array.from({ length: 40 }, (_, index) => [
      "mcp_status",
      { server: "serial", state: `ready-${index}` },
    ]);
    await writeSession(home, {
      id: "sess-title-noise",
      logs: { "session.v1.jsonl": logOf([...noise, ["user", { content: "探针连不上" }]]) },
    });
    const row = await rowOf(home, "sess-title-noise");
    expect(row.title).toBe("探针连不上");
  }, HOST_TIMEOUT_MS);

  it("首条消息超 80 字符：截断到 80 字符并加 …（共 81 字符）", async () => {
    const home = await tempHome();
    const long = "串".repeat(120);
    await writeSession(home, {
      id: "sess-title-long",
      logs: { "session.v1.jsonl": logOf([["user", { content: long }]]) },
    });
    const row = await rowOf(home, "sess-title-long");
    expect(row.title).toBe(`${"串".repeat(80)}…`);
    expect([...row.title]).toHaveLength(81);
  }, HOST_TIMEOUT_MS);

  it("空白 content / 非字符串 content 被跳过，取第一条合格 user", async () => {
    const home = await tempHome();
    await writeSession(home, {
      id: "sess-title-skip",
      logs: {
        "session.v1.jsonl": logOf([
          ["user", { content: "   " }],
          ["user", { content: 42 }],
          ["user", { content: null }],
          ["user", {}],
          ["user", { content: "\n\t " }],
          ["user", { content: "真正的第一条" }],
          ["user", { content: "第二条不该被选中" }],
        ]),
      },
    });
    const row = await rowOf(home, "sess-title-skip");
    expect(row.title).toBe("真正的第一条");
  }, HOST_TIMEOUT_MS);

  it("\\r\\n 行尾：标题正确，且不带 \\r", async () => {
    const home = await tempHome();
    const crlf = [
      { seq: 0, ts: TS, type: "mcp_status", payload: { server: "serial" } },
      { seq: 1, ts: TS, type: "user", payload: { content: "  串口没输出  " } },
    ].map((event) => JSON.stringify(event)).join("\r\n") + "\r\n";
    await writeSession(home, { id: "sess-title-crlf", logs: { "session.v1.jsonl": crlf } });
    const row = await rowOf(home, "sess-title-crlf");
    expect(row.title).toBe("串口没输出");
    expect(row.title).not.toContain("\r");
  }, HOST_TIMEOUT_MS);

  it("user 事件的行跨 64 KiB 块边界（且在多字节字符中间断开）：仍能找到", async () => {
    const home = await tempHome();
    // 标题本身远短于 80 字符，截断不会介入：这里唯一的难点就是「这一行跨块」。
    const content = "边".repeat(40);
    const head = '{"seq":1,"ts":"2026-01-01T00:00:00.000Z","type":"user","payload":{"content":"';
    const tail = '"}}\n';
    // 第一个「边」的三个 UTF-8 字节落在 65535 / 65536 / 65537 上，第一块只拿到其中
    // 1 个。按块各自 `toString("utf8")` 的实现会把它解成替换字符（实测 `���边边…`），
    // 于是标题的第一个字就错了——这正是这个用例要挡住的写法。
    const userStart = CHUNK - 1 - Buffer.byteLength(head);
    expect(userStart).toBeGreaterThan(0);
    expect(userStart + Buffer.byteLength(head)).toBe(CHUNK - 1);
    await writeSession(home, {
      id: "sess-title-chunk",
      logs: { "session.v1.jsonl": `${paddedStatusLine(userStart)}${head}${content}${tail}` },
    });
    const row = await rowOf(home, "sess-title-chunk");
    expect(row.title).toBe(content);
  }, HOST_TIMEOUT_MS);

  it("日志后段有一行坏 JSON：仍给出标题（行为变化：按行容错，不再回落 id）", async () => {
    // 旧实现 `readSessionDir()` 会把整份日志逐行 parse，一行坏掉就整次推导失败，
    // `titleOf` 回落到 id、侧栏显示「没有消息」。新实现只把坏行本身跳过。
    const home = await tempHome();
    await writeSession(home, {
      id: "sess-title-broken-tail",
      logs: {
        "session.v1.jsonl": [
          eventLine(0, "user", { content: "串口没输出" }),
          eventLine(1, "assistant", { content: "先量供电" }),
          "{ this line is not json }\n",
          eventLine(3, "status", { status: "closed" }),
        ].join(""),
      },
    });
    const row = await rowOf(home, "sess-title-broken-tail");
    expect(row.title).toBe("串口没输出");
  }, HOST_TIMEOUT_MS);

  it("v1 没有 user、v2 有：按世代顺序继续读，给出 v2 的标题", async () => {
    const home = await tempHome();
    await writeSession(home, {
      id: "sess-title-gen2",
      logs: {
        "session.v1.jsonl": logOf([
          ["mcp_status", { server: "serial", state: "ready" }],
          ["assistant", { content: "先看看日志" }],
        ]),
        // 世代文件的 seq 跨文件连续，与真实日志一致。
        "session.v2.jsonl": eventLine(2, "user", { content: "第二代才开口" }),
      },
    });
    const row = await rowOf(home, "sess-title-gen2");
    expect(row.title).toBe("第二代才开口");
  }, HOST_TIMEOUT_MS);

  it("完全没有 user 事件：title 为 \"\"（协议层把它渲染成「没有消息」，不是 id）", async () => {
    const home = await tempHome();
    await writeSession(home, {
      id: "sess-title-none",
      logs: {
        "session.v1.jsonl": logOf([
          ["mcp_status", { server: "serial", state: "ready" }],
          ["assistant", { content: "没有用户消息" }],
        ]),
      },
    });
    const row = await rowOf(home, "sess-title-none");
    expect(row.title).toBe("");
  }, HOST_TIMEOUT_MS);
});
