export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  // 退避期间等待取消:signal 中止时立即抛出 AbortError,不再发下一次请求(D-010)。
  signal?: AbortSignal;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

async function sleepWithSignal(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // sleep 本身可能不响应取消(例如注入的测试 sleep),用 timer 兜底,
    // 保证中止后不会继续等待完整退避时间(D-010)。
    await Promise.race([
      sleep(ms),
      aborted,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    if (signal.aborted) throw abortError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

export async function retry<T>(fn: () => Promise<T>, cfg: RetryConfig): Promise<T> {
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rand = cfg.rand ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= cfg.maxRetries || !cfg.isRetryable(err)) throw err;
      const delay = cfg.baseDelayMs * 2 ** attempt * (0.5 + rand() * 0.5);
      await sleepWithSignal(sleep, delay, cfg.signal);
    }
  }
}
