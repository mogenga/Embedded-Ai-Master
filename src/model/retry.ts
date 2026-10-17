export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
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
      await sleep(delay);
    }
  }
}
