import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSession } from "../src/index.js";
import type { RunOptions } from "../src/index.js";
import type { LoopEvent } from "../src/loop/events.js";
import { parseInlinePermissionConfig } from "../src/permissions/config.js";
import { PermissionConfigError } from "../src/permissions/errors.js";
import type { PermissionPreset } from "../src/permissions/types.js";
import { acquireSessionLock } from "../src/session/lock.js";
import { readSessionDir } from "../src/session/persistence.js";
import { createSession, readSessionFile } from "../src/session/session.js";
import { shellTool } from "../src/tools/shell.js";

const PROVIDERS = {
  gw: {
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    models: { flash: { contextWindow: 8192, maxOutput: 512 } },
  },
};

function providersText(): string {
  return JSON.stringify(PROVIDERS);
}

const EMPTY_RESPONSE = {
  choices: [{ message: { content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 3 },
};

function toolCall(id: string, name: string, args: unknown): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function mockFetch(bodies: unknown[]): typeof fetch {
  let index = 0;
  return vi.fn(async () => {
    const payload = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  }) as unknown as typeof fetch;
}

async function collect(generator: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const tempDirs: string[] = [];

const appendFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("../src/session/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/session/session.js")>();
  return {
    ...actual,
    createSession: async (
      dir: string,
      opts?: Parameters<typeof actual.createSession>[1],
    ) => {
      const handle = await actual.createSession(dir, opts);
      if (!appendFailure.enabled) return handle;
      appendFailure.enabled = false;
      const originalAppend = handle.append.bind(handle);
      let failed = false;
      handle.append = (event) => {
        if (failed) return originalAppend(event);
        failed = true;
        return Promise.reject(new Error("permission status append boom"));
      };
      return handle;
    },
  };
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "permissions-integration-"));
  tempDirs.push(dir);
  return dir;
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

afterEach(async () => {
  appendFailure.enabled = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

async function runIn(
  home: string,
  workdir: string,
  sessionName: string,
  bodies: unknown[],
  extra: Partial<RunOptions> = {},
): Promise<LoopEvent[]> {
  return collect(
    runSession({
      input: "hi",
      model: "gw/flash",
      providersText: providersText(),
      cwd: workdir,
      sessionDir: path.join(home, sessionName),
      fetchImpl: mockFetch(bodies),
      ...extra,
    }),
  );
}

async function writePermissionFile(file: string, config: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config), "utf8");
}

function statusPayloads(sessionDir: string): Record<string, unknown>[] {
  return readSessionFile(path.join(sessionDir, "session.v1.jsonl"))
    .filter((event) => event.type === "status")
    .map((event) => event.payload);
}

function toolResults(events: LoopEvent[]): Array<Extract<LoopEvent, { kind: "tool_result" }>> {
  return events.filter(
    (event): event is Extract<LoopEvent, { kind: "tool_result" }> =>
      event.kind === "tool_result",
  );
}

async function attempt(permissions: unknown): Promise<unknown> {
  // 校验失败应发生在触碰 home 之前;仍用隔离的临时 home,避免用例依赖实现顺序(D-125)。
  const home = await tempDir();
  vi.stubEnv("HARNESS_HOME", home);
  return collect(
    runSession({
      input: "hi",
      model: "gw/flash",
      providersText: providersText(),
      fetchImpl: mockFetch([EMPTY_RESPONSE]),
      permissions: permissions as RunOptions["permissions"],
    }),
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

const WRITE_CALL = toolCall("write-1", "write", {
  path: "new.txt",
  content: "written",
});

describe("runSession 权限装配", () => {
  it("不传 permissions 时默认 diagnose：写被拒绝、读放行", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    await writeFile(path.join(workdir, "note.txt"), "hello fs\n", "utf8");

    const events = await runIn(home, workdir, "default-diagnose", [
      WRITE_CALL,
      toolCall("read-1", "read", { path: "note.txt" }),
      EMPTY_RESPONSE,
    ]);

    const results = toolResults(events);
    expect(results[0]).toMatchObject({ id: "write-1", ok: false, code: "permission_denied" });
    expect(existsSync(path.join(workdir, "new.txt"))).toBe(false);
    expect(results[1]).toMatchObject({ id: "read-1", ok: true, code: "ok" });
  });

  it("user permissions.json 默认加载：preset danger-full-access 放行写", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    await writePermissionFile(path.join(home, "permissions.json"), {
      version: 1,
      preset: "danger-full-access",
    });

    const events = await runIn(home, workdir, "user-config", [WRITE_CALL, EMPTY_RESPONSE]);

    expect(toolResults(events)[0]).toMatchObject({ ok: true, code: "ok" });
    expect(existsSync(path.join(workdir, "new.txt"))).toBe(true);
  });

  it("内联 preset danger-full-access 放行写", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();

    const events = await runIn(home, workdir, "inline-preset", [WRITE_CALL, EMPTY_RESPONSE], {
      permissions: { preset: "danger-full-access" },
    });

    expect(toolResults(events)[0]).toMatchObject({ ok: true, code: "ok" });
    expect(existsSync(path.join(workdir, "new.txt"))).toBe(true);
  });

  it("项目权限未 trust：不生效并记录 permissions_project_config_skipped", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const projectPath = path.join(workdir, ".harness", "permissions.json");
    await writePermissionFile(projectPath, {
      version: 1,
      preset: "danger-full-access",
      rules: [{ tool: "write", action: "allow" }],
    });

    const sessionDir = path.join(home, "project-skipped");
    const events = await runIn(home, workdir, "project-skipped", [WRITE_CALL, EMPTY_RESPONSE]);

    expect(toolResults(events)[0]).toMatchObject({ ok: false, code: "permission_denied" });
    expect(existsSync(path.join(workdir, "new.txt"))).toBe(false);
    expect(statusPayloads(sessionDir)).toContainEqual({
      status: "permissions_project_config_skipped",
      message: projectPath,
    });
  });

  it("permissions.trustProjectConfig 为 true 时项目规则生效", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    await writePermissionFile(path.join(workdir, ".harness", "permissions.json"), {
      version: 1,
      rules: [{ tool: "write", action: "allow" }],
    });

    const events = await runIn(home, workdir, "project-trusted", [WRITE_CALL, EMPTY_RESPONSE], {
      permissions: { trustProjectConfig: true },
    });

    expect(toolResults(events)[0]).toMatchObject({ ok: true, code: "ok" });
    expect(existsSync(path.join(workdir, "new.txt"))).toBe(true);
  });

  it("mcp.trustProjectConfig 不放宽权限：项目权限仍被跳过", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const projectPath = path.join(workdir, ".harness", "permissions.json");
    await writePermissionFile(projectPath, {
      version: 1,
      rules: [{ tool: "write", action: "allow" }],
    });

    const sessionDir = path.join(home, "mcp-trust-independent");
    const events = await runIn(home, workdir, "mcp-trust-independent", [
      WRITE_CALL,
      EMPTY_RESPONSE,
    ], { mcp: { trustProjectConfig: true } });

    expect(toolResults(events)[0]).toMatchObject({ ok: false, code: "permission_denied" });
    expect(existsSync(path.join(workdir, "new.txt"))).toBe(false);
    expect(statusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({
        status: "permissions_project_config_skipped",
        message: projectPath,
      }),
    );
  });

  it.each([
    ["用户配置", "bad-user-config"],
    ["项目配置", "bad-project-config"],
  ])("%s 无效时不创建会话目录", async (label, sessionName) => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const badConfig = { version: 1, preset: "not-a-preset" };
    let extra: Partial<RunOptions> = {};
    if (label === "用户配置") {
      await writePermissionFile(path.join(home, "permissions.json"), badConfig);
    } else {
      const projectPath = path.join(workdir, "bad-permissions.json");
      await writePermissionFile(projectPath, badConfig);
      extra = { permissions: { projectConfigPath: projectPath } };
    }

    await expect(
      runIn(home, workdir, sessionName, [EMPTY_RESPONSE], extra),
    ).rejects.toBeInstanceOf(PermissionConfigError);
    expect(existsSync(path.join(home, sessionName))).toBe(false);
  });

  it("resume 时先加载配置：失败不触发 crash recovery、不改日志、锁可重取", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-bad-config");
    const session = await createSession(sessionDir, {
      id: "resume-bad-config",
      model: "gw/flash",
    });
    await session.append({ type: "user", payload: { content: "old" } });
    await session.append({
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [{ id: "pending", name: "echo", arguments: {} }],
      },
    });
    await session.close();

    const logPath = path.join(sessionDir, "session.v1.jsonl");
    const headerPath = path.join(sessionDir, "header.json");
    const logBefore = await readFile(logPath, "utf8");
    const headerBefore = await readFile(headerPath, "utf8");
    await writePermissionFile(path.join(home, "permissions.json"), {
      version: 1,
      preset: "not-a-preset",
    });

    await expect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        fetchImpl: mockFetch([EMPTY_RESPONSE]),
      }).next(),
    ).rejects.toBeInstanceOf(PermissionConfigError);

    expect(await readFile(logPath, "utf8")).toBe(logBefore);
    expect(await readFile(headerPath, "utf8")).toBe(headerBefore);
    const lock = await acquireSessionLock(sessionDir);
    await lock.release();
  });

  it("resume 时同样披露未信任的项目配置", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const sessionDir = path.join(home, "resume-project-skipped");
    await writePermissionFile(path.join(workdir, ".harness", "permissions.json"), {
      version: 1,
      rules: [{ tool: "write", action: "allow" }],
    });
    await runIn(home, workdir, "resume-project-skipped", [EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: providersText(),
        cwd: workdir,
        sessionDir,
        resume: true,
        fetchImpl: mockFetch([EMPTY_RESPONSE]),
      }),
    );

    const skipped = statusPayloads(sessionDir).filter(
      (payload) => payload.status === "permissions_project_config_skipped",
    );
    expect(skipped).toHaveLength(2);
    expect(skipped.every((payload) => typeof payload.message === "string")).toBe(true);
  });

  it("inline preset 覆盖 project 文件的 preset", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    await writePermissionFile(path.join(workdir, ".harness", "permissions.json"), {
      version: 1,
      preset: "read-only",
    });

    const events = await runIn(home, workdir, "inline-over-project", [WRITE_CALL, EMPTY_RESPONSE], {
      permissions: { preset: "danger-full-access", trustProjectConfig: true },
    });
    expect(toolResults(events)[0]).toMatchObject({ ok: true, code: "ok" });
  });

  it("内联 preset 覆盖文件 preset", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    await writePermissionFile(path.join(home, "permissions.json"), {
      version: 1,
      preset: "read-only",
    });

    const allowed = await runIn(home, workdir, "inline-override-allow", [
      WRITE_CALL,
      EMPTY_RESPONSE,
    ], { permissions: { preset: "danger-full-access" } });
    expect(toolResults(allowed)[0]).toMatchObject({ ok: true, code: "ok" });

    const denied = await runIn(home, workdir, "inline-override-deny", [
      WRITE_CALL,
      EMPTY_RESPONSE,
    ], { permissions: { preset: "read-only" } });
    expect(toolResults(denied)[0]).toMatchObject({ ok: false, code: "permission_denied" });
  });

  it("内联 rules 覆盖文件 preset 的默认拒绝", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    await writePermissionFile(path.join(home, "permissions.json"), {
      version: 1,
      preset: "read-only",
    });

    const events = await runIn(home, workdir, "inline-rules", [WRITE_CALL, EMPTY_RESPONSE], {
      permissions: { rules: [{ tool: "write", action: "allow" }] },
    });

    expect(toolResults(events)[0]).toMatchObject({ ok: true, code: "ok" });
  });

  it("默认 diagnose 下 shell 调用被拒绝且 execute 未被调用", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const executeSpy = vi.spyOn(shellTool, "execute");

    const events = await runIn(home, workdir, "shell-denied", [
      toolCall("shell-1", "shell", { command: 'node -e "process.exit(0)"' }),
      EMPTY_RESPONSE,
    ]);

    expect(toolResults(events)[0]).toMatchObject({
      id: "shell-1",
      ok: false,
      code: "permission_denied",
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("内联 preset 非字符串抛 TypeError", async () => {
    const error = await attempt({ preset: 42 });
    expect(error).toBeInstanceOf(TypeError);
  });

  it("内联 preset 不在枚举抛 PermissionConfigError(invalid_schema)", async () => {
    const error = await attempt({ preset: "not-a-preset" });
    expect(error).toBeInstanceOf(PermissionConfigError);
    expect((error as PermissionConfigError).code).toBe("invalid_schema");
  });

  it("approvalTimeoutMs 为 0 抛 PermissionConfigError(invalid_schema)", async () => {
    const error = await attempt({ approvalTimeoutMs: 0 });
    expect(error).toBeInstanceOf(PermissionConfigError);
    expect((error as PermissionConfigError).code).toBe("invalid_schema");
  });

  it("内联规则含未知字段抛 PermissionConfigError(invalid_schema)", async () => {
    const error = await attempt({
      rules: [{ tool: "write", action: "allow", unexpected: true }],
    });
    expect(error).toBeInstanceOf(PermissionConfigError);
    expect((error as PermissionConfigError).code).toBe("invalid_schema");
  });

  it("permissions 外层未知键 rule 抛 PermissionConfigError(invalid_schema)", async () => {
    const error = await attempt({ rule: [] });
    expect(error).toBeInstanceOf(PermissionConfigError);
    expect((error as PermissionConfigError).code).toBe("invalid_schema");
  });

  it("permissions 的 symbol 键视为未知字段", async () => {
    const permissions: Record<PropertyKey, unknown> = { preset: "diagnose" };
    permissions[Symbol("rule")] = { tool: "shell", action: "allow" };
    const error = await attempt(permissions);
    expect(error).toBeInstanceOf(PermissionConfigError);
    expect((error as PermissionConfigError).code).toBe("invalid_schema");
  });

  it.each([
    ["userConfigPath", { userConfigPath: 42 }],
    ["projectConfigPath", { projectConfigPath: null }],
    ["trustProjectConfig", { trustProjectConfig: "yes" }],
    ["rules", { rules: {} }],
    ["approvalTimeoutMs", { approvalTimeoutMs: "1000" }],
    ["prompter.request", { prompter: { request: "nope" } }],
    ["prompter", { prompter: null }],
  ])("permissions.%s 类型错误抛 TypeError", async (_label, permissions) => {
    const error = await attempt(permissions);
    expect(error).toBeInstanceOf(TypeError);
  });

  it.each([
    ["null", null],
    ["数组", []],
    ["Date", new Date()],
    ["字符串", "yes"],
  ])("permissions 非普通对象（%s）抛 TypeError", async (_label, permissions) => {
    const error = await attempt(permissions);
    expect(error).toBeInstanceOf(TypeError);
  });

  it("resume 时内联配置同样生效", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const sessionDir = path.join(home, "resume-inline");
    const first = await runIn(home, workdir, "resume-inline", [EMPTY_RESPONSE], {
      permissions: { preset: "danger-full-access" },
    });
    expect(first.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });

    const events = await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: providersText(),
        cwd: workdir,
        sessionDir,
        resume: true,
        fetchImpl: mockFetch([WRITE_CALL, EMPTY_RESPONSE]),
        permissions: { preset: "danger-full-access" },
      }),
    );

    expect(toolResults(events)[0]).toMatchObject({ ok: true, code: "ok" });
    expect(existsSync(path.join(workdir, "new.txt"))).toBe(true);
    expect(readSessionDir(sessionDir).header.status).toBe("closed");
  });

  it("prompter 被接入门控：ask 时请求审批并按结果放行", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const prompter = { request: vi.fn(async () => "allow" as const) };

    const events = await runIn(home, workdir, "prompter-allow", [
      WRITE_CALL,
      EMPTY_RESPONSE,
    ], { permissions: { prompter } });

    expect(prompter.request).toHaveBeenCalledTimes(1);
    expect(prompter.request).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "write", preset: "diagnose" }),
    );
    expect(toolResults(events)[0]).toMatchObject({ ok: true, code: "ok" });
    expect(existsSync(path.join(workdir, "new.txt"))).toBe(true);
  });

  it("project skipped status 写入失败时关闭会话并释放锁", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    await writePermissionFile(path.join(workdir, ".harness", "permissions.json"), {
      version: 1,
      rules: [{ tool: "write", action: "allow" }],
    });

    appendFailure.enabled = true;
    await expect(
      runIn(home, workdir, "status-append-failure", [EMPTY_RESPONSE]),
    ).rejects.toThrow("permission status append boom");

    expect(appendFailure.enabled).toBe(false);
    const lock = await acquireSessionLock(path.join(home, "status-append-failure"));
    await lock.release();
  });
});

describe("runtime preset contract", () => {
  it("accepts exactly the four documented presets and rejects others", () => {
    const accepted: PermissionPreset[] = [
      "read-only",
      "workspace-write",
      "diagnose",
      "danger-full-access",
    ];
    for (const preset of accepted) {
      expect(() =>
        parseInlinePermissionConfig({ preset }),
      ).not.toThrow();
    }
    expect(() => parseInlinePermissionConfig({ preset: "yolo" })).toThrow(PermissionConfigError);
  });
});
