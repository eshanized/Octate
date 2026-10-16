import { createPromisePool, type PromisePool } from '../../cache/pool.js';
import {
  AuthenticationError,
  ModelError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from '../../errors/index.js';

export interface ResilienceOptions {
  maxRetries?: number;
  timeoutMs?: number;
  concurrency?: number;
}

export interface ErrorWithHttpMetadata extends Error {
  status?: number;
  statusCode?: number;
  headers?: Headers | Record<string, string>;
  retryAfterMs?: number;
  response?: {
    status?: number;
    headers?: Headers | Record<string, string>;
  };
}

/**
 * Calculates exponential backoff with ±20% jitter, capped at maxMs.
 *
 * @param attempt - 0-indexed retry attempt number
 * @param baseMs - Initial backoff in milliseconds (default: 1000)
 * @param maxMs - Maximum backoff cap in milliseconds (default: 10000)
 * @returns Delay in milliseconds
 */
export function calculateBackoff(attempt: number, baseMs = 1000, maxMs = 10000): number {
  const delay = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = Math.random() * 0.4 - 0.2; // ±20%
  return Math.min(maxMs, Math.max(0, Math.round(delay * (1 + jitter))));
}

/**
 * Extracts Retry-After duration in milliseconds if present in headers or error.
 */
function getRetryAfterMs(
  headers?: Headers | Record<string, string>,
  error?: ErrorWithHttpMetadata
): number | null {
  if (error?.retryAfterMs !== undefined && Number.isFinite(error.retryAfterMs)) {
    return Math.max(0, error.retryAfterMs);
  }
  if (!headers) {
    return null;
  }

  let value: string | null = null;
  if (typeof (headers as Headers).get === 'function') {
    value = (headers as Headers).get('retry-after');
  } else if (typeof headers === 'object') {
    value =
      (headers as Record<string, string>)['retry-after'] ??
      (headers as Record<string, string>)['Retry-After'] ??
      null;
  }

  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  const parsedDate = Date.parse(value);
  if (!Number.isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    return Math.max(0, diff);
  }

  return null;
}

/**
 * Promise-based sleep that respects cancellation.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason ?? new Error('Operation cancelled'));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Operation cancelled'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isRetryableNetworkError(error: ErrorWithHttpMetadata): boolean {
  const code = (error as Error & { code?: string; cause?: unknown }).code;
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined;
  if (
    (code && NETWORK_ERROR_CODES.has(code)) ||
    (causeCode && NETWORK_ERROR_CODES.has(causeCode))
  ) {
    return true;
  }

  return (
    error.name === 'TypeError' &&
    /fetch failed|network error|socket|connection|dns|timed? out/i.test(error.message)
  );
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * Manages request concurrency, per-request timeouts, cancellation, and retry loops.
 */
export class ResilienceManager {
  readonly maxRetries: number;
  readonly timeoutMs: number;
  readonly concurrency: number;
  private pool: PromisePool;

  constructor(options?: ResilienceOptions) {
    const envTimeoutValue = process.env.OCTATE_TIMEOUT_MS ?? process.env.NVIDIA_TIMEOUT_MS;
    const envTimeout =
      envTimeoutValue !== undefined && envTimeoutValue.trim() !== ''
        ? Number(envTimeoutValue)
        : undefined;
    this.maxRetries = options?.maxRetries ?? 3;
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new RangeError('maxRetries must be a non-negative safe integer');
    }
    this.timeoutMs = requirePositiveInteger(
      'timeoutMs',
      options?.timeoutMs ?? envTimeout ?? 120000
    );
    this.concurrency = requirePositiveInteger('concurrency', options?.concurrency ?? 2);
    this.pool = createPromisePool(this.concurrency);
  }

  /**
   * Executes an operation with concurrency limiting and exponential backoff retry.
   */
  execute<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    return this.pool.run(() => this.runWithRetry(operation, callerSignal));
  }

  /**
   * Alias for execute() matching executeWithRetry naming convention.
   */
  executeWithRetry<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    return this.execute(operation, callerSignal);
  }

  private async runWithRetry<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    let attempt = 0;

    while (true) {
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? new Error('Operation cancelled');
      }

      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combinedSignal = callerSignal
        ? AbortSignal.any([timeoutSignal, callerSignal])
        : timeoutSignal;

      try {
        return await operation(combinedSignal);
      } catch (err: unknown) {
        const error = (
          err instanceof Error ? err : new Error(String(err))
        ) as ErrorWithHttpMetadata;

        // Check if caller aborted
        if (callerSignal?.aborted) {
          throw callerSignal.reason ?? error;
        }

        // Check if request timed out
        if (timeoutSignal.aborted) {
          throw new ProviderTimeoutError(`Request timed out after ${this.timeoutMs}ms`, {
            timeoutMs: this.timeoutMs,
            attempt,
          });
        }

        const status = error.status ?? error.statusCode ?? error.response?.status;
        const headers = error.headers ?? error.response?.headers;

        // Auth errors must NOT be retried
        if (status === 401 || status === 403) {
          throw new AuthenticationError(error.message, { status });
        }

        // Determine if error is retryable (429 rate limit, 5xx server errors, or network errors)
        const isRateLimit = status === 429;
        const isServerError = typeof status === 'number' && status >= 500 && status < 600;
        const isNetworkError = status === undefined && isRetryableNetworkError(error);
        const isRetryable = isRateLimit || isServerError || isNetworkError;

        if (!isRetryable || attempt >= this.maxRetries) {
          if (isRateLimit) {
            throw new ProviderRateLimitError(error.message, {
              status,
              attempts: attempt + 1,
            });
          }
          if (error instanceof ModelError || error instanceof AuthenticationError) {
            throw error;
          }
          throw new ModelError(error.message || 'Model provider operation failed', {
            status,
            attempts: attempt + 1,
          });
        }

        // Calculate retry delay (honor Retry-After or error metadata if present)
        const retryAfterMs = getRetryAfterMs(headers, error);
        const delayMs = retryAfterMs !== null ? retryAfterMs : calculateBackoff(attempt);

        attempt++;
        await sleep(delayMs, callerSignal);
      }
    }
  }
}

/**
 * Factory helper to instantiate ResilienceManager.
 */
export function createResilienceManager(options?: ResilienceOptions): ResilienceManager {
  return new ResilienceManager(options);
}
