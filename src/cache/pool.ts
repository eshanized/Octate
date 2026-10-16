/**
 * Bounded promise pool for concurrent operations.
 * Wrapper around p-limit with additional utilities.
 */

import pLimit from 'p-limit';

/**
 * Creates a promise pool with the given concurrency limit.
 * @param concurrency - Maximum number of concurrent operations (default: CPU cores)
 * @returns Promise pool controller
 */
export function createPromisePool(concurrency?: number): PromisePool {
  const detectedConcurrency =
    typeof navigator !== 'undefined' &&
    Number.isSafeInteger(navigator.hardwareConcurrency) &&
    navigator.hardwareConcurrency > 0
      ? navigator.hardwareConcurrency
      : 4;
  const limit = pLimit(concurrency ?? detectedConcurrency);
  return new PromisePool(limit);
}

/**
 * Promise pool controller for bounded concurrency.
 */
export class PromisePool {
  private limit: ReturnType<typeof pLimit>;

  constructor(limit: ReturnType<typeof pLimit>) {
    this.limit = limit;
  }

  /**
   * Executes a function with concurrency limiting.
   * @param fn - Function to execute
   * @returns Promise that resolves with the function's result
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return this.limit(fn);
  }

  /**
   * Executes multiple functions with concurrency limiting.
   * @param fns - Array of functions to execute
   * @returns Promise that resolves with array of results in order
   */
  async runAll<T>(fns: Array<() => Promise<T>>): Promise<T[]> {
    return Promise.all(fns.map((fn) => this.limit(fn)));
  }

  /**
   * Executes functions in batches with concurrency limiting.
   * @param items - Array of items to process
   * @param processor - Function to process each item
   * @returns Promise that resolves with array of results in order
   */
  async map<T, R>(items: T[], processor: (item: T) => Promise<R>): Promise<R[]> {
    return Promise.all(items.map((item) => this.limit(() => processor(item))));
  }

  /**
   * Executes functions with a concurrency limit, collecting results as they complete.
   * @param fns - Array of functions to execute
   * @returns Async iterator yielding results as they complete
   */
  async *iterate<T>(fns: Array<() => Promise<T>>): AsyncIterableIterator<T> {
    type SettledResult =
      | { task: Promise<SettledResult>; ok: true; value: T }
      | { task: Promise<SettledResult>; ok: false; error: unknown };

    const pending = new Set<Promise<SettledResult>>();

    for (const fn of fns) {
      let task: Promise<SettledResult>;
      task = this.limit(fn).then(
        (value): SettledResult => ({ task, ok: true, value }),
        (error: unknown): SettledResult => ({ task, ok: false, error })
      );
      pending.add(task);
    }

    // Each wrapped promise always resolves, so rejected tasks cannot create
    // unhandled rejections while other tasks are still running.
    while (pending.size > 0) {
      const settled = await Promise.race(pending);
      pending.delete(settled.task);
      if (!settled.ok) {
        throw settled.error;
      }
      yield settled.value;
    }
  }

  /**
   * Gets the number of pending (waiting) tasks.
   */
  getPendingCount(): number {
    return this.limit.pendingCount;
  }

  /**
   * Gets the number of active (running) tasks.
   */
  getActiveCount(): number {
    return this.limit.activeCount;
  }

  /**
   * Clears the pool and waits for all running tasks to complete.
   */
  async drain(): Promise<void> {
    await this.limit(() => Promise.resolve());
  }
}

/**
 * Default promise pool with CPU-core concurrency.
 */
export const defaultPool = createPromisePool();

/**
 * Creates a promise pool for a specific phase of the pipeline.
 * @param name - Phase name for logging
 * @param concurrency - Maximum concurrent operations
 */
export function createPhasePool(_name: string, concurrency?: number): PromisePool {
  return createPromisePool(concurrency);
}
