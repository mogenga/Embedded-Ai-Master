import { describe, expect, it, vi } from 'vitest';
import { retry } from '../src/model/retry.js';

describe('retry', () => {
  it('可重试后成功时调用次数等于失败次数加一', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('429');
        return 'ok';
      },
      {
        maxRetries: 5,
        baseDelayMs: 1000,
        isRetryable: () => true,
        sleep: async () => {},
        rand: () => 0.5,
      },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('使用精确指数与 jitter 退避延迟', async () => {
    const sleeps: number[] = [];
    let calls = 0;

    await retry(
      async () => {
        calls += 1;
        if (calls <= 2) throw new Error('temporary');
        return 'ok';
      },
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        isRetryable: () => true,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        rand: () => 0.5,
      },
    );

    expect(sleeps).toEqual([750, 1500]);
  });

  it('达到最大重试次数后抛出最后错误', async () => {
    const errors = [new Error('failure 1'), new Error('failure 2'), new Error('failure 3')];
    let calls = 0;

    await expect(
      retry(
        async () => {
          const error = errors[calls];
          calls += 1;
          throw error;
        },
        {
          maxRetries: 2,
          baseDelayMs: 1,
          isRetryable: () => true,
          sleep: async () => {},
          rand: () => 0.5,
        },
      ),
    ).rejects.toBe(errors[2]);

    expect(calls).toBe(3);
  });

  it('不可重试错误立即抛出且不 sleep', async () => {
    const error = new Error('401');
    const sleep = vi.fn(async () => {});
    let calls = 0;

    await expect(
      retry(
        async () => {
          calls += 1;
          throw error;
        },
        {
          maxRetries: 2,
          baseDelayMs: 1,
          isRetryable: () => false,
          sleep,
          rand: () => 0.5,
        },
      ),
    ).rejects.toBe(error);

    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
