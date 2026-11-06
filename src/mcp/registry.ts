import type { McpManager } from "./manager.js";

/**
 * 会话级 MCP 连接表。
 *
 * 一个 key（实际用会话目录）对应一个 manager：同一 key 的并发 acquire 只调用
 * 一次 factory，后到的调用等待同一个 Promise。manager 是**终态**对象（close 后
 * 不可复用），所以复用只发生在 acquire 与 release 之间——这正是会话生命周期：
 * 一个会话内的多条消息共用一份连接，会话切换或 runner 关闭时统一释放。
 */
export interface McpRegistry {
  acquire(key: string, factory: () => Promise<McpManager>): Promise<McpManager>;
  release(key: string): Promise<void>;
  releaseAll(): Promise<void>;
  size(): number;
}

export interface McpRegistryOptions {
  log?: (message: string) => void;
}

export function createMcpRegistry(opts: McpRegistryOptions = {}): McpRegistry {
  const entries = new Map<string, Promise<McpManager>>();
  const log = opts.log ?? ((message: string) => console.error(message));

  async function acquire(key: string, factory: () => Promise<McpManager>): Promise<McpManager> {
    const existing = entries.get(key);
    if (existing !== undefined) {
      return existing;
    }
    // 先登记 Promise 再运行 factory（微任务里启动），这样同一 tick 的第二个
    // acquire 看到的是同一个 Promise，而不是再 spawn 一个进程。
    let pending: Promise<McpManager>;
    pending = Promise.resolve()
      .then(factory)
      .catch((error: unknown) => {
        // 失败不缓存：清掉这个 key，下一次 acquire 会重新尝试。只有表里仍是
        // 这一个 Promise 时才删——release 可能已经先一步把它移除了。
        if (entries.get(key) === pending) {
          entries.delete(key);
        }
        throw error;
      });
    entries.set(key, pending);
    return pending;
  }

  async function release(key: string): Promise<void> {
    const pending = entries.get(key);
    if (pending === undefined) {
      return;
    }
    // 先删再关：关闭期间的 acquire 应当新建一个 manager，而不是拿到一个正在
    // 关闭、即将进入终态的旧对象。
    entries.delete(key);
    let manager: McpManager;
    try {
      manager = await pending;
    } catch {
      // factory 失败时 acquire 的调用方已经拿到原错误；这里没有可关闭的对象。
      return;
    }
    await manager.close();
  }

  async function releaseAll(): Promise<void> {
    const keys = [...entries.keys()];
    const results = await Promise.allSettled(keys.map((key) => release(key)));
    // 一个关闭失败不能让其余连接留在表里：上面已经全部尝试过，这里只把第一个
    // 错误交给调用方决定是否吞掉。
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) {
      log(`[mcp] releaseAll: ${keys.length} 个连接中有释放失败`);
      throw failure.reason;
    }
  }

  function size(): number {
    return entries.size;
  }

  return { acquire, release, releaseAll, size };
}
