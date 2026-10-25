import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKeilSession, registerSessionForTest, resetSessionsForTest, sessionKey } from "../keilSession.js";
import type { KeilSession } from "../keilSession.js";

/**
 * T-020 的离线锁定：openKeilSession 复用一个「存在但未进调试态」的会话时
 * 必须拒绝，而不是把它交给 verifyFlash——那样 DBG_MEM_READ 会答
 * NOT_DEBUGGING，读失败不算失败，烧录校验形同虚设。全部走注入的假会话，
 * 不连 4823、不启动 UV4。
 */

let dir: string;
let projectPath: string;

function fakeSession(overrides: Partial<KeilSession> = {}): KeilSession {
  return {
    client: { closed: false } as KeilSession["client"],
    project: projectPath,
    debugging: false,
    target: "hardware",
    extended: false,
    openedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  resetSessionsForTest();
  dir = mkdtempSync(join(tmpdir(), "keil-reuse-"));
  projectPath = join(dir, "demo.uvprojx");
  writeFileSync(projectPath, "<Project/>", "utf8");
});

afterEach(() => {
  resetSessionsForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("openKeilSession 复用守卫（T-020）", () => {
  it("拒绝复用未进调试态的会话（fail-closed，verify 不再静默失效）", async () => {
    registerSessionForTest(fakeSession({ debugging: false }));
    const result = await openKeilSession({ cwd: dir, project: projectPath, target: "hardware", port: 4823 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not in debug mode");
  });

  it("复用处于调试态的同目标会话仍然放行（不破坏正常路径）", async () => {
    registerSessionForTest(fakeSession({ debugging: true, target: "hardware" }));
    const result = await openKeilSession({ cwd: dir, project: projectPath, target: "hardware", port: 4823 });
    expect(result.ok).toBe(true);
    expect(result.log.join("\n")).toContain("reused");
  });

  it("connectOnly 调用不受调试态守卫约束（下载路径的 plain 会话照常复用）", async () => {
    registerSessionForTest(fakeSession({ debugging: false }));
    const result = await openKeilSession({ cwd: dir, project: projectPath, target: "hardware", port: 4823, connectOnly: true });
    expect(result.ok).toBe(true);
    expect(result.log.join("\n")).toContain("reused");
  });

  it("目标不匹配的旧守卫仍然生效", async () => {
    registerSessionForTest(fakeSession({ debugging: true, target: "simulator" }));
    const result = await openKeilSession({ cwd: dir, project: projectPath, target: "hardware", port: 4823 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("simulator");
  });

  it("注入的会话确实登记在 project|port 键下", () => {
    registerSessionForTest(fakeSession());
    expect(sessionKey(projectPath.toLowerCase(), 4823)).toBe(`${projectPath.toLowerCase()}|4823`);
  });
});
