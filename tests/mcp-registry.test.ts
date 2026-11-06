import { describe, expect, it, vi } from "vitest";
import { createMcpRegistry } from "../src/mcp/registry.js";
import type { McpManager } from "../src/mcp/manager.js";

/**
 * 全部用注入的假 manager：这一层只负责「哪个 key 对应哪个 manager、何时关」，
 * 不 spawn 任何进程。
 */
function fakeManager(): McpManager & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(async () => undefined) } as unknown as McpManager & {
    close: ReturnType<typeof vi.fn>;
  };
}

describe("McpRegistry", () => {
  it("同一 key 的并发 acquire 只调用一次 factory", async () => {
    const registry = createMcpRegistry();
    const manager = fakeManager();
    const factory = vi.fn(async () => manager);

    const [first, second] = await Promise.all([
      registry.acquire("session-a", factory),
      registry.acquire("session-a", factory),
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toBe(manager);
    expect(second).toBe(manager);
    expect(registry.size()).toBe(1);
    await registry.releaseAll();
  });

  it("factory 失败不缓存：错误原样抛给调用方，下次 acquire 会重试", async () => {
    const registry = createMcpRegistry();
    const manager = fakeManager();
    const failure = new Error("connect boom");
    const first = vi.fn(async () => {
      throw failure;
    });

    await expect(registry.acquire("session-a", first)).rejects.toBe(failure);
    // 失败没有留下表项，否则这个会话从此永远拿到一个 rejected Promise。
    expect(registry.size()).toBe(0);

    const retry = vi.fn(async () => manager);
    await expect(registry.acquire("session-a", retry)).resolves.toBe(manager);
    expect(retry).toHaveBeenCalledTimes(1);
    await registry.releaseAll();
  });

  it("release 关闭 manager、size 归零，重复 release 与未知 key 静默成功", async () => {
    const registry = createMcpRegistry();
    const manager = fakeManager();
    await registry.acquire("session-a", async () => manager);

    await registry.release("session-a");
    expect(manager.close).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);

    // 幂等：再释放一次不报错，也不会再关一次。
    await expect(registry.release("session-a")).resolves.toBeUndefined();
    await expect(registry.release("never-acquired")).resolves.toBeUndefined();
    expect(manager.close).toHaveBeenCalledTimes(1);
  });

  it("release 后同一 key 再次 acquire 会新建 manager", async () => {
    const registry = createMcpRegistry();
    const first = fakeManager();
    const second = fakeManager();
    await registry.acquire("session-a", async () => first);
    await registry.release("session-a");

    await expect(registry.acquire("session-a", async () => second)).resolves.toBe(second);
    expect(registry.size()).toBe(1);
    await registry.releaseAll();
  });

  it("releaseAll 单个失败不阻断其余，并把第一个错误抛出", async () => {
    const registry = createMcpRegistry();
    const ok = fakeManager();
    const bad = fakeManager();
    const boom = new Error("close boom");
    bad.close.mockRejectedValueOnce(boom);
    await registry.acquire("good", async () => ok);
    await registry.acquire("bad", async () => bad);

    await expect(registry.releaseAll()).rejects.toBe(boom);
    // 其余连接必须仍然被关掉，而不是因为一个失败整批留活。
    expect(ok.close).toHaveBeenCalledTimes(1);
    expect(bad.close).toHaveBeenCalledTimes(1);
    // 失败的 key 也已从表里移除：重试是调用方新建一次 acquire，不是回滚。
    expect(registry.size()).toBe(0);
  });

  it("release 在 factory 尚未完成时也能关闭最终结果", async () => {
    const registry = createMcpRegistry();
    const manager = fakeManager();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = registry.acquire("session-a", async () => {
      await gate;
      return manager;
    });

    const released = registry.release("session-a");
    release();
    await acquired;
    await released;

    expect(manager.close).toHaveBeenCalledTimes(1);
  });
});
