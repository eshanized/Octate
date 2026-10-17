/**
 * File filtering: binary detection, generated file heuristics, size limits.
 * Integrates with IgnoreMatcher for comprehensive file filtering.
 */

import { realpathSync } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { IgnoreMatcher } from './ignore.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB default
const BINARY_SAMPLE_SIZE = 8192; // Check first 8KB for binary detection

/**
 * Safely extracts file size from stats, defaulting to 0 if undefined.
 */
function getSafeFileSize(stats: { size?: number }): number {
  return stats.size ?? 0;
}

const GENERATED_PATTERNS = [
  /^\s*\/\/\s*@generated/i,
  /^\s*\/\/\s*Generated\s+by/i,
  /^\s*\/\/\s*DO NOT EDIT/i,
  /^\s*\/\*\s*Generated\s+by/i,
  /^\s*#\s*Generated\s+by/i,
  /^\s*#\s*DO NOT EDIT/i,
  /^\s*\/\*\s*eslint-disable\s*\*\//i,
  /^\s*\/\/\s*ts-nocheck/i,
  /^\s*\/\/\s*@ts-nocheck/i,
  /^\s*#\s*Generated/i,
];

const MINIFIED_PATTERNS = [/\.min\.(js|css|html)$/i, /\.bundle\.(js|css)$/i, /\.map$/i];

const GENERATED_EXTENSIONS = [
  '.d.ts', // TypeScript declaration files (often generated)
  '.map', // Source maps
  '.min.js', // Minified JS
  '.min.css', // Minified CSS
];

/**
 * Configuration for FileFilter.
 */
export interface FileFilterConfig {
  maxFileSize?: number;
  additionalIgnorePatterns?: string[];
  allowBinary?: boolean;
  allowGenerated?: boolean;
}

/**
 * Result of file analysis for filtering.
 */
export interface FileFilterResult {
  shouldAnalyze: boolean;
  reason?: string;
  isBinary: boolean;
  isGenerated: boolean;
  isLarge: boolean;
  isIgnored: boolean;
  size: number;
}

/**
 * Checks if a file is binary by examining its content.
 * Uses UTF-8 validation on a sample of the file.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const buffer = await readFile(filePath);
    if (buffer.includes(0)) return true;
    // U+FFFD is valid Unicode; only malformed UTF-8 is binary.
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

/**
 * More efficient binary check using buffer inspection.
 * Reads first 8KB and checks for null bytes or high ratio of non-printable.
 */
export async function isBinaryFileFast(filePath: string): Promise<boolean> {
  try {
    const buffer = await readFile(filePath);
    if (buffer.includes(0)) return true;

    let decoded: string;
    try {
      // Validate the whole byte stream so UTF-8 sequences cannot be cut at a sample boundary.
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return true;
    }

    // Non-ASCII Unicode characters are valid text, not binary markers.
    const sample = Array.from(decoded).slice(0, BINARY_SAMPLE_SIZE).join('');
    if (sample.length === 0) return false;

    let suspiciousControls = 0;
    for (const char of sample) {
      const code = char.codePointAt(0);
      if (code === undefined) continue;
      const whitespace = code === 9 || code === 10 || code === 13;
      if (!whitespace && (code < 32 || (code >= 0x7f && code <= 0x9f))) {
        suspiciousControls++;
      }
    }
    return suspiciousControls / sample.length > 0.3;
  } catch {
    // If we can't read, assume binary to be safe
    return true;
  }
}

/**
 * Determines whether snapshot text should be included in a model review.
 *
 * This content-based variant is safe for staged and historical snapshots because
 * it never reads the current worktree. A null content value is retained for
 * deleted files; callers should separately exclude explicit binary diff sections.
 */
export function shouldReviewSnapshotContent(
  filePath: string,
  content: string | null,
  maxFileSize: number = MAX_FILE_SIZE
): boolean {
  const normalizedPath = filePath.toLowerCase();
  if (
    GENERATED_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension)) ||
    MINIFIED_PATTERNS.some((pattern) => pattern.test(normalizedPath))
  ) {
    return false;
  }

  // Deleted files have no content at the target snapshot but their removal must be reviewed.
  if (content === null) return true;
  if (Buffer.byteLength(content, 'utf-8') > maxFileSize || content.includes('\0')) return false;

  const sample = Array.from(content).slice(0, BINARY_SAMPLE_SIZE);
  if (sample.length > 0) {
    const suspiciousControls = sample.filter((character) => {
      const code = character.codePointAt(0);
      return (
        code !== undefined &&
        code !== 9 &&
        code !== 10 &&
        code !== 13 &&
        (code < 32 || (code >= 0x7f && code <= 0x9f))
      );
    }).length;
    if (suspiciousControls / sample.length > 0.3) return false;
  }

  const lines = content.split('\n');
  if (lines.slice(0, 50).some((line) => GENERATED_PATTERNS.some((pattern) => pattern.test(line)))) {
    return false;
  }

  // Avoid sending very long minified lines to the model as source context.
  if (lines.length < 100 && lines.some((line) => line.length > 500)) return false;
  return true;
}

/**
 * Checks if a file appears to be generated code.
 * Uses heuristics: file headers, minified patterns, common generated file markers.
 */
export async function isGeneratedFile(
  filePath: string,
  config?: FileFilterConfig
): Promise<boolean> {
  const _ext = extname(filePath).toLowerCase();

  // Check extension-based heuristics first
  if (GENERATED_EXTENSIONS.some((pattern) => filePath.toLowerCase().endsWith(pattern))) {
    return true;
  }

  if (MINIFIED_PATTERNS.some((pattern) => pattern.test(filePath))) {
    return true;
  }

  // Skip content check if disabled
  if (config?.allowGenerated === true) {
    return false;
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const headerLines = lines.slice(0, 50);
    // Markers are anchored, so test each header line separately.
    for (const line of headerLines) {
      if (GENERATED_PATTERNS.some((pattern) => pattern.test(line))) return true;
    }

    // Check for very long lines (minified code often has extremely long lines)
    const hasLongLines = lines.some((line) => line.length > 500);
    if (hasLongLines && lines.length < 100) {
      // Short file with very long lines = likely minified
      return true;
    }

    return false;
  } catch {
    // If we can't read as text, assume it's not generated (might be binary)
    return false;
  }
}

/**
 * Checks if a file is a symlink and resolves it safely.
 * Rejects symlinks that point outside the repository root.
 */
export function resolveSymlinkSafely(
  repoRoot: string,
  filePath: string
): { resolvedPath: string; isSymlink: boolean } {
  const absoluteRoot = resolve(repoRoot);
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(absoluteRoot, filePath);
  const lexicalRelative = relative(absoluteRoot, absolutePath);
  const isOutside = (candidate: string) =>
    candidate === '..' ||
    candidate.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) ||
    isAbsolute(candidate);

  if (isOutside(lexicalRelative)) {
    throw new Error(`Path is outside repository root: ${filePath}`);
  }

  let resolvedRoot: string;
  let resolvedPath: string;
  try {
    resolvedRoot = realpathSync(absoluteRoot);
    resolvedPath = realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`Unable to safely resolve path: ${filePath}`, { cause: error });
  }

  if (isOutside(relative(resolvedRoot, resolvedPath))) {
    throw new Error(`Symlink points outside repository root: ${filePath}`);
  }
  return { resolvedPath, isSymlink: absolutePath !== resolvedPath };
}

/**
 * Main file filter that combines ignore patterns, binary detection,
 * generated file detection, and size limits.
 */
export class FileFilter {
  private ignoreMatcher: IgnoreMatcher;
  private config: FileFilterConfig;

  constructor(ignoreMatcher: IgnoreMatcher, config: FileFilterConfig = {}) {
    this.ignoreMatcher = ignoreMatcher;
    const additionalIgnorePatterns = config.additionalIgnorePatterns ?? [];
    this.config = {
      maxFileSize: config.maxFileSize ?? MAX_FILE_SIZE,
      additionalIgnorePatterns,
      allowBinary: config.allowBinary ?? false,
      allowGenerated: config.allowGenerated ?? false,
    };

    // Add additional patterns to matcher
    if (additionalIgnorePatterns.length > 0) {
      this.ignoreMatcher.add(additionalIgnorePatterns);
    }
  }

  /**
   * Analyzes a file and returns whether it should be analyzed.
   */
  async analyzeFile(repoRoot: string, filePath: string): Promise<FileFilterResult> {
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(repoRoot, filePath);
    let safePath: string;
    try {
      safePath = resolveSymlinkSafely(repoRoot, absolutePath).resolvedPath;
    } catch (error) {
      return {
        shouldAnalyze: false,
        isBinary: false,
        isGenerated: false,
        isLarge: false,
        isIgnored: false,
        size: 0,
        reason: error instanceof Error ? error.message : 'Unsafe file path',
      };
    }
    const relativePath = relative(repoRoot, absolutePath).split('\\').join('/');

    // 1. Check ignore patterns first (fastest)
    const isIgnored = this.ignoreMatcher.ignores(relativePath);

    // 2. Get file stats for size check
    let size = 0;
    let isLarge = false;
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(safePath);
    } catch {
      return {
        shouldAnalyze: false,
        isBinary: false,
        isGenerated: false,
        isLarge: false,
        isIgnored: false,
        size: 0,
        reason: 'File does not exist or cannot be accessed',
      };
    }
    size = getSafeFileSize(stats);
    isLarge = size > (this.config.maxFileSize ?? MAX_FILE_SIZE);

    // 3. Check binary (only if not ignored and not large)
    let isBinary = false;
    if (!isIgnored && !isLarge) {
      isBinary = await isBinaryFileFast(safePath);
    }

    // 4. Check generated (only if not ignored, not large, not binary)
    let isGenerated = false;
    if (!isIgnored && !isLarge && !isBinary) {
      isGenerated = await isGeneratedFile(safePath, this.config);
    }

    // Determine if should analyze
    const allowBinary = this.config.allowBinary ?? false;
    const allowGenerated = this.config.allowGenerated ?? false;
    const maxFileSize = this.config.maxFileSize ?? MAX_FILE_SIZE;

    const shouldAnalyze =
      !isIgnored && !isLarge && (!isBinary || allowBinary) && (!isGenerated || allowGenerated);
    let reason: string | undefined;

    if (isIgnored) {
      reason = 'File matches ignore patterns';
    } else if (isLarge) {
      reason = `File exceeds max size (${maxFileSize} bytes)`;
    } else if (isBinary && !allowBinary) {
      reason = 'Binary file';
    } else if (isGenerated && !allowGenerated) {
      reason = 'Generated file';
    }

    const result: FileFilterResult = {
      shouldAnalyze,
      isBinary,
      isGenerated,
      isLarge,
      isIgnored,
      size,
    };
    if (reason !== undefined) {
      result.reason = reason;
    }
    return result;
  }

  /**
   * Creates a filter function for array.filter().
   * Note: This is synchronous and only uses ignore patterns.
   * For full analysis, use analyzeFile().
   */
  createFilter(): (filePath: string) => boolean {
    return (filePath: string) => !this.ignoreMatcher.ignores(filePath);
  }

  /**
   * Checks if a file should be analyzed (full async check).
   */
  async shouldAnalyzeFile(repoRoot: string, filePath: string): Promise<boolean> {
    const result = await this.analyzeFile(repoRoot, filePath);
    return result.shouldAnalyze;
  }
}

/**
 * Convenience function to create a FileFilter from repo root and config.
 */
export async function createFileFilter(
  repoRoot: string,
  config: FileFilterConfig = {}
): Promise<FileFilter> {
  const ignoreMatcher = await import('./ignore.js').then((m) =>
    m.loadIgnorePatterns(repoRoot, config.additionalIgnorePatterns)
  );
  return new FileFilter(ignoreMatcher, config);
}

/**
 * Checks if a path is a symlink.
 */
export async function isSymlink(filePath: string): Promise<boolean> {
  try {
    const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath);
    const stats = await lstat(absolutePath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}
