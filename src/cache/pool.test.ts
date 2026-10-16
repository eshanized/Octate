/**
 * Tests for bounded promise pool.
 */

import { describe, expect, it } from '@jest/globals';
import { createPromisePool, defaultPool } from './pool.js';

describe('PromisePool', () => {
  it('executes function with concurrency limit', async () => {
    const pool = createPromisePool(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return 'done';
    };

    const results = await Promise.all([pool.run(task), pool.run(task), pool.run(task)]);

    expect(results).toEqual(['done', 'done', 'done']);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('runs all functions with concurrency limit', async () => {
    const pool = createPromisePool(2);
    const tasks = Array.from({ length: 5 }, (_, i) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return i;
    });

    const results = await pool.runAll(tasks);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('maps items with concurrency limit', async () => {
    const pool = createPromisePool(2);
    const items = [1, 2, 3, 4, 5];

    const results = await pool.map(items, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('yields each concurrent task result exactly once', async () => {
    const pool = createPromisePool(2);
    const tasks = [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'slow';
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'medium';
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return 'fast';
      },
    ];

    const results: string[] = [];
    for await (const result of pool.iterate(tasks)) {
      results.push(result);
    }

    expect(results).toHaveLength(3);
    expect([...results].sort()).toEqual(['fast', 'medium', 'slow']);
    expect(new Set(results).size).toBe(3);
    expect(results[0]).toBe('medium');
  });

  it('propagates iterator task failures to the consumer', async () => {
    const pool = createPromisePool(2);
    const tasks = [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error('task failed');
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'ok';
      },
    ];

    await expect(async () => {
      for await (const _result of pool.iterate(tasks)) {
        // consume values until the iterator fails
      }
    }).rejects.toThrow('task failed');
  });

  it('tracks pending and active counts', async () => {
    const pool = createPromisePool(2);

    expect(pool.getPendingCount()).toBe(0);
    expect(pool.getActiveCount()).toBe(0);

    let resolve1: () => void = () => {};
    const promise1 = new Promise<void>((resolve) => {
      resolve1 = resolve;
    });

    const running = pool.run(async () => {
      await promise1;
    });

    // Give time for task to start
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(pool.getActiveCount()).toBe(1);

    resolve1?.();
    await running;

    expect(pool.getActiveCount()).toBe(0);
  });

  it('drains pool waiting for completion', async () => {
    const pool = createPromisePool(2);

    const tasks = Array.from({ length: 3 }, () => async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const promise = pool.runAll(tasks);
    await pool.drain();
    await promise;

    expect(pool.getActiveCount()).toBe(0);
    expect(pool.getPendingCount()).toBe(0);
  });
});

describe('createPromisePool', () => {
  it('creates pool with specified concurrency', async () => {
    const pool = createPromisePool(4);
    // Test that it works
    const result = await pool.run(async () => 'test');
    expect(result).toBe('test');
  });

  it('uses default concurrency when not specified', async () => {
    const pool = createPromisePool();
    const result = await pool.run(async () => 'test');
    expect(result).toBe('test');
  });
});

describe('defaultPool', () => {
  it('provides a default pool instance', async () => {
    const result = await defaultPool.run(async () => 'default');
    expect(result).toBe('default');
  });
});
