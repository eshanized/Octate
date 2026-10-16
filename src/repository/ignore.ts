/**
 * Ignore pattern parsing and matching using the `ignore` package.
 * Handles .gitignore, .octateignore, and config-based ignore patterns.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Ignore } from 'ignore';
import ignore from 'ignore';

/**
 * Represents a compiled ignore pattern matcher.
 */
export interface IgnoreMatcher {
  /** Checks if a path should be ignored */
  ignores(path: string): boolean;
  /** Adds patterns to the matcher */
  add(patterns: string | string[]): this;
  /** Creates a filter function for array.filter() */
  createFilter(): (path: string) => boolean;
}

/**
 * Result of parsing an ignore file.
 */
export interface IgnoreParseResult {
  patterns: string[];
  filePath: string;
}

/**
 * Parses an ignore file (.gitignore, .octateignore) and returns patterns.
 */
export async function parseIgnoreFile(filePath: string): Promise<IgnoreParseResult> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
    // Preserve escaped trailing spaces and other Git ignore syntax; trimming patterns
    // changes their meaning (for example, "file\\ " matches a name ending in a space).
    const patterns = lines.filter(
      (line) => line.length > 0 && line.trim().length > 0 && !line.startsWith('#')
    );
    return { patterns, filePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { patterns: [], filePath };
    }
    throw error;
  }
}

/**
 * Creates an IgnoreMatcher from patterns.
 * The ignore package handles .gitignore pattern syntax including negation.
 */
export function createIgnoreMatcher(patterns: string[] = []): IgnoreMatcher {
  const matcher: Ignore = ignore();
  if (patterns.length > 0) {
    matcher.add(patterns);
  }
  const result: IgnoreMatcher = {
    ignores: (path: string) => matcher.ignores(path),
    add: (newPatterns: string | string[]) => {
      matcher.add(newPatterns);
      return result;
    },
    createFilter: () => matcher.createFilter(),
  };
  return result;
}

/**
 * Loads and merges ignore patterns from multiple sources.
 * Order of precedence (later overrides earlier):
 * 1. .gitignore (repository root)
 * 2. .octateignore (repository root)
 * 3. Config-based ignore patterns
 */
export async function loadIgnorePatterns(
  repoRoot: string,
  configPatterns: string[] = []
): Promise<IgnoreMatcher> {
  const matcher = createIgnoreMatcher();

  // 1. Load .gitignore from repo root
  const gitIgnorePath = resolve(repoRoot, '.gitignore');
  const gitIgnoreResult = await parseIgnoreFile(gitIgnorePath);
  if (gitIgnoreResult.patterns.length > 0) {
    matcher.add(gitIgnoreResult.patterns);
  }

  // 2. Load .octateignore from repo root
  const octateIgnorePath = resolve(repoRoot, '.octateignore');
  const octateIgnoreResult = await parseIgnoreFile(octateIgnorePath);
  if (octateIgnoreResult.patterns.length > 0) {
    matcher.add(octateIgnoreResult.patterns);
  }

  // 3. Add config-based patterns (highest precedence)
  if (configPatterns.length > 0) {
    matcher.add(configPatterns);
  }

  // Always exclude critical directories regardless of config
  const criticalPatterns = [
    '**/.git/**',
    '**/node_modules/**',
    '**/vendor/**',
    '**/dist/**',
    '**/build/**',
    '*.log',
    '.DS_Store',
  ];
  matcher.add(criticalPatterns);

  return matcher;
}

/**
 * Creates an IgnoreMatcher for a monorepo workspace.
 * Union of root patterns + workspace-specific patterns.
 */
export async function createWorkspaceIgnoreMatcher(
  repoRoot: string,
  workspaceRoot: string,
  configPatterns: string[] = []
): Promise<IgnoreMatcher> {
  const rootMatcher = await loadIgnorePatterns(repoRoot, configPatterns);
  const workspaceMatcher = createIgnoreMatcher();

  for (const filename of ['.gitignore', '.octateignore']) {
    const result = await parseIgnoreFile(resolve(workspaceRoot, filename));
    if (result.patterns.length > 0) workspaceMatcher.add(result.patterns);
  }

  const workspaceRelativeRoot = normalizePathForIgnore(repoRoot, workspaceRoot).replace(/\/+$/, '');
  const result: IgnoreMatcher = {
    ignores: (filePath: string) => {
      const normalized = normalizePathForIgnore(repoRoot, filePath);
      if (rootMatcher.ignores(normalized)) return true;

      if (!workspaceRelativeRoot || workspaceRelativeRoot === '.') return workspaceMatcher.ignores(normalized);
      if (normalized === workspaceRelativeRoot) return false;
      const prefix = workspaceRelativeRoot + '/';
      if (!normalized.startsWith(prefix)) return false;

      return workspaceMatcher.ignores(normalized.slice(prefix.length));
    },
    add: (patterns: string | string[]) => {
      rootMatcher.add(patterns);
      return result;
    },
    createFilter: () => (filePath: string) => !result.ignores(filePath),
  };

  return result;
}

/**
 * Normalizes a file path for ignore matching.
 * Converts to relative path from repo root with forward slashes.
 */
export function normalizePathForIgnore(repoRoot: string, filePath: string): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  const relativePath = relative(repoRoot, absolutePath);
  return relativePath.split('\\').join('/');
}
