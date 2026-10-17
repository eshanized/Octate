/**
 * File-based cache store with atomic writes.
 * Uses temp file + rename for atomicity.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DiagnosticCollection } from '../analysis/diagnostics/index.js';
import type { Diagnostic } from '../model/types.js';

/**
 * Cache entry metadata.
 */
export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  createdAt: number;
  size: number;
}

/**
 * Cache store options.
 */
export interface CacheStoreOptions {
  rootDir: string;
  maxSize?: number; // in bytes
}

/**
 * File-based cache store with atomic writes and size tracking.
 */
export class CacheStore {
  private rootDir: string;
  private maxSize: number;
  private currentSize: number = 0;
  private sizeInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: CacheStoreOptions) {
    this.rootDir = options.rootDir;
    this.maxSize = options.maxSize ?? 500 * 1024 * 1024; // 500MB default
  }

  /**
   * Initializes the store by calculating current size.
   */
  async initialize(): Promise<void> {
    if (this.sizeInitialized) return;
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        await mkdir(this.rootDir, { recursive: true });
        this.currentSize = await this.calculateDirectorySize(this.rootDir);
        this.sizeInitialized = true;
      })().finally(() => {
        if (!this.sizeInitialized) this.initializationPromise = null;
      });
    }
    await this.initializationPromise;
  }

  /**
   * Calculates the total size of a directory recursively.
   */
  private async calculateDirectorySize(dir: string): Promise<number> {
    let totalSize = 0;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          totalSize += await this.calculateDirectorySize(fullPath);
        } else if (entry.isFile()) {
          const stats = await stat(fullPath);
          totalSize += stats.size;
        }
      }
    } catch {
      // Directory doesn't exist or other error
    }
    return totalSize;
  }

  /**
   * Gets the cache entry for a key.
   */
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    await this.initialize();
    const filePath = this.keyToFilePath(key);

    try {
      const content = await readFile(filePath, 'utf-8');
      const entry = JSON.parse(content) as CacheEntry<T>;
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Sets a cache entry with atomic write.
   */
  async set<T>(key: string, value: T): Promise<void> {
    await this.initialize();

    await this.runExclusive(async () => {
      const filePath = this.keyToFilePath(key);
      const dir = dirname(filePath);
      await mkdir(dir, { recursive: true });

      const entry: CacheEntry<T> = {
        key,
        value,
        createdAt: Date.now(),
        size: 0,
      };

      // Include the final size field in the persisted size and settle the digit-width.
      let serialized = JSON.stringify(entry);
      for (let iteration = 0; iteration < 8; iteration++) {
        const actualSize = Buffer.byteLength(serialized, 'utf-8');
        if (entry.size === actualSize) break;
        entry.size = actualSize;
        serialized = JSON.stringify(entry);
      }
      const serializedSize = Buffer.byteLength(serialized, 'utf-8');
      if (serializedSize > this.maxSize) {
        throw new RangeError(
          `Cache entry exceeds maximum cache size (${serializedSize} > ${this.maxSize} bytes)`
        );
      }

      let previousSize = 0;
      try {
        previousSize = (await stat(filePath)).size;
      } catch {
        // this is a new cache key
      }

      // Preserve the key being replaced while evicting other entries.
      await this.ensureSpace(Math.max(0, serializedSize - previousSize), filePath);

      const tempPath = `${filePath}.tmp.${randomUUID()}`;
      try {
        await writeFile(tempPath, serialized, 'utf-8');
        await rename(tempPath, filePath);
        this.currentSize = Math.max(0, this.currentSize - previousSize + serializedSize);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
    });
  }
  /**
   * Deletes a cache entry.
   */
  async delete(key: string): Promise<boolean> {
    await this.initialize();
    return this.runExclusive(async () => {
      const filePath = this.keyToFilePath(key);
      try {
        const stats = await stat(filePath);
        await unlink(filePath);
        this.currentSize = Math.max(0, this.currentSize - stats.size);
        return true;
      } catch {
        return false;
      }
    });
  }
  /**
   * Checks if a key exists in the cache.
   */
  async has(key: string): Promise<boolean> {
    await this.initialize();
    const filePath = this.keyToFilePath(key);
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gets the current cache size in bytes.
   */
  async getSize(): Promise<number> {
    await this.initialize();
    return this.currentSize;
  }

  /**
   * Gets the maximum cache size in bytes.
   */
  getMaxSize(): number {
    return this.maxSize;
  }

  /**
   * Clears all cache entries.
   */
  async clear(): Promise<void> {
    await this.initialize();
    await this.runExclusive(async () => {
      await this.clearDirectory(this.rootDir);
      this.currentSize = 0;
    });
  }
  /**
   * Recursively clears a directory.
   */
  private async clearDirectory(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          await this.clearDirectory(fullPath);
          try {
            await rmdir(fullPath);
          } catch {
            // Ignore errors removing empty directories
          }
        } else if (entry.isFile()) {
          await unlink(fullPath);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Ensures there's enough space for a new entry.
   * Evicts LRU entries if necessary.
   */
  private async ensureSpace(requiredSize: number, protectedPath?: string): Promise<void> {
    if (this.currentSize + requiredSize <= this.maxSize) {
      return;
    }

    // Collect all entries with their creation times (including subdirectories)
    const entries: Array<{ path: string; createdAt: number; size: number }> = [];

    await this.collectEntries(this.rootDir, entries);

    // Sort by creation time (oldest first)
    entries.sort((a, b) => a.createdAt - b.createdAt);

    // Evict oldest entries until we have enough space.
    for (const entry of entries) {
      if (this.currentSize + requiredSize <= this.maxSize) {
        break;
      }
      if (protectedPath && entry.path === protectedPath) continue;
      await unlink(entry.path);
      this.currentSize = Math.max(0, this.currentSize - entry.size);
    }
  }

  /**
   * Serializes mutations so concurrent writes cannot overcommit capacity or
   * corrupt size accounting. Failed operations do not poison the queue.
   */
  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result as Promise<T>;
  }

  /**
   * Recursively collects all cache entries from a directory.
   */
  private async collectEntries(
    dir: string,
    entries: Array<{ path: string; createdAt: number; size: number }>
  ): Promise<void> {
    try {
      const files = await readdir(dir, { withFileTypes: true });
      for (const file of files) {
        const filePath = resolve(dir, file.name);
        if (file.isDirectory()) {
          await this.collectEntries(filePath, entries);
        } else if (file.isFile()) {
          try {
            const stats = await stat(filePath);
            const content = await readFile(filePath, 'utf-8');
            const entry = JSON.parse(content) as CacheEntry;
            entries.push({
              path: filePath,
              createdAt: entry.createdAt,
              size: stats.size,
            });
          } catch {
            // Skip invalid entries
          }
        }
      }
    } catch {
      // No files to evict
    }
  }

  /**
   * Converts a cache key to a file path.
   * Uses subdirectories based on key prefix for better filesystem performance.
   */
  private keyToFilePath(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex');
    const prefix = hash.substring(0, 2);
    return resolve(this.rootDir, prefix, hash);
  }

  // ===== Diagnostics Cache Methods =====

  /**
   * Gets cached diagnostic collection.
   */
  async getDiagnostics(key: string): Promise<DiagnosticCollection | null> {
    const entry = await this.get<DiagnosticCollection>(`analysis/diagnostics/${key}`);
    return entry?.value ?? null;
  }

  /**
   * Sets cached diagnostic collection.
   */
  async setDiagnostics(key: string, value: DiagnosticCollection): Promise<void> {
    return this.set(`analysis/diagnostics/${key}`, value);
  }

  /**
   * Checks if diagnostic collection exists in cache.
   */
  async hasDiagnostics(key: string): Promise<boolean> {
    return this.has(`analysis/diagnostics/${key}`);
  }

  // ===== Tool Result Cache Methods =====

  /**
   * Gets cached tool result diagnostics.
   */
  async getToolResult(key: string): Promise<Diagnostic[] | null> {
    const entry = await this.get<Diagnostic[]>(`analysis/tool-results/${key}`);
    return entry?.value ?? null;
  }

  /**
   * Sets cached tool result diagnostics.
   */
  async setToolResult(key: string, value: Diagnostic[]): Promise<void> {
    return this.set(`analysis/tool-results/${key}`, value);
  }

  /**
   * Checks if tool result exists in cache.
   */
  async hasToolResult(key: string): Promise<boolean> {
    return this.has(`analysis/tool-results/${key}`);
  }
}

/**
 * Creates a cache store with the given options.
 */
export async function createCacheStore(options: CacheStoreOptions): Promise<CacheStore> {
  const store = new CacheStore(options);
  await store.initialize();
  return store;
}
