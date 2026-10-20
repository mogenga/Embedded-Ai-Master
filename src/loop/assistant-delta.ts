import type { SessionHandle } from "../session/session.js";

export interface AssistantDeltaWriterOptions {
  session: SessionHandle;
  /**
   * 两次落盘之间的最长间隔。超过它就写一次，不必等缓冲满。
   *
   * 实时流的轮询周期是 200ms，60ms 的间隔让 UI 看到的字是成段出现而不是
   * 逐字出现——逐字在 HTTP/SSE 通道上没有意义，模型本身也是按 token 吐的。
   */
  maxDelayMs?: number;
  /** 缓冲超过这个长度立刻落盘，避免一次响应写出几百个事件。 */
  maxChars?: number;
  /** 写失败时的回调。增量是显示优化，失败不应终止这一轮。 */
  onError?: (error: unknown) => void;
}

export interface AssistantDeltaWriter {
  /** 收下一段增量文本。同步，不阻塞模型调用。 */
  push(text: string): void;
  /** 把缓冲写完并等待落盘完成。 */
  flush(): Promise<void>;
  /** 因写失败而丢失的字符数。 */
  readonly dropped: number;
}

const DEFAULT_MAX_DELAY_MS = 60;
const DEFAULT_MAX_CHARS = 400;

/**
 * 把模型的增量文本批量写进会话日志。
 *
 * 为什么要批量：会话日志是唯一事实源，实时事件必须先落盘再被投影；而每条
 * 事件都要 fsync 一次（`session.append` 的既有语义），逐 token 落盘会把
 * 一轮回答变成上百次磁盘同步。
 *
 * 为什么写失败不致命：同一轮回答的完整内容在随后的 `assistant` 事件里，
 * 增量只是把它提前显示出来。丢几段增量等于少了几次流式刷新，不等于丢内容。
 */
export function createAssistantDeltaWriter(
  opts: AssistantDeltaWriterOptions,
): AssistantDeltaWriter {
  const session = opts.session;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  let buffer = "";
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let dropped = 0;

  function write(text: string): Promise<void> {
    chain = chain.then(async () => {
      try {
        await session.append({ type: "assistant_delta", payload: { text } });
      } catch (error) {
        dropped += text.length;
        opts.onError?.(error);
      }
    });
    return chain;
  }

  async function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (buffer !== "") {
      const text = buffer;
      buffer = "";
      await write(text);
    }
    await chain;
  }

  function schedule(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, maxDelayMs);
    // 定时器不阻止进程退出：未写完的增量会丢，但 `assistant` 事件仍在。
    timer.unref?.();
  }

  return {
    push(text) {
      if (text === "") return;
      buffer += text;
      if (buffer.length >= maxChars) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        void flush();
        return;
      }
      schedule();
    },
    flush,
    get dropped() {
      return dropped;
    },
  };
}
