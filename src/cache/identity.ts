/**
 * Project identity hashing and cache directory resolution.
 * Uses SHA256(repo-root-path + git-remote-url) for namespacing.
 */

import { createHash } from 'node:crypto';
import { access, constants, lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const _require = createRequire(import.meta.url);

/**
 * Parsed git config for remote URL extraction.
 */
interface GitConfig {
  'remote "origin"': { url?: string };
  'remote "upstream"': { url?: string };
}

/**
 * Cache directory paths structure.
 */
export interface CachePaths {
  root: string;
  indexes: string;
  cache: string;
  findings: string;
  logs: string;
}

/**
 * Computes the project identity hash from repo root and git remote URL.
 * Falls back to absolute path + device/inode if no remote URL.
 */
export async function computeProjectIdentity(repoRoot: string): Promise<string> {
  const absoluteRepoRoot = resolve(repoRoot);
  let identityString: string;

  try {
    const gitConfigPath = await resolveGitConfigPath(absoluteRepoRoot);
    const configContent = await readFile(gitConfigPath, 'utf-8');

    const remoteUrl = extractRemoteUrl(configContent);
    if (remoteUrl) {
      identityString = `${absoluteRepoRoot}|${remoteUrl}`;
    } else {
      identityString = await fallbackIdentity(absoluteRepoRoot);
    }
  } catch {
    identityString = await fallbackIdentity(absoluteRepoRoot);
  }

  return createHash('sha256').update(identityString).digest('hex').substring(0, 16);
}

/**
 * Resolves the shared Git config path for ordinary repositories and linked worktrees.
 * A worktree's .git file points at its private gitdir; commondir then points at the
 * shared gitdir that owns remote configuration.
 */
async function resolveGitConfigPath(repoRoot: string): Promise<string> {
  const gitEntry = resolve(repoRoot, '.git');
  const entryStat = await lstat(gitEntry);
  let gitDir = gitEntry;

  if (entryStat.isFile()) {
    const pointer = await readFile(gitEntry, 'utf-8');
    const match = /^gitdir:\s*(.+?)\s*$/im.exec(pointer);
    if (!match?.[1]) throw new Error('Invalid .git pointer file');
    gitDir = isAbsolute(match[1]) ? resolve(match[1]) : resolve(repoRoot, match[1]);
  } else if (!entryStat.isDirectory()) {
    throw new Error('.git is neither a directory nor a pointer file');
  }

  try {
    const commonDirValue = (await readFile(resolve(gitDir, 'commondir'), 'utf-8')).trim();
    if (commonDirValue) {
      gitDir = isAbsolute(commonDirValue)
        ? resolve(commonDirValue)
        : resolve(gitDir, commonDirValue);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return resolve(gitDir, 'config');
}

/**
 * Extracts the first remote URL from git config content.
 */
function extractRemoteUrl(configContent: string): string | null {
  const lines = configContent.split('\n');
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1);
      continue;
    }

    if (currentSection.startsWith('remote "') && trimmed.startsWith('url')) {
      const match = trimmed.match(/url\s*=\s*(.+)/);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }

  return null;
}

/**
 * Fallback identity when no git remote is available.
 * Uses absolute path + platform-specific device info.
 */
async function fallbackIdentity(repoRoot: string): Promise<string> {
  const absolutePath = resolve(repoRoot);
  let deviceInfo = platform();

  try {
    // Try to get device/inode info for more uniqueness
    const { stat } = await import('node:fs/promises');
    const stats = await stat(absolutePath);
    deviceInfo += `-${stats.dev}-${stats.ino}`;
  } catch {
    // Ignore errors, use platform as fallback
  }

  return `${absolutePath}|${deviceInfo}`;
}

/**
 * Gets the cache directory paths for a project.
 * Creates the directory structure if it doesn't exist.
 */
export async function getCacheDir(repoRoot: string): Promise<CachePaths> {
  const identity = await computeProjectIdentity(repoRoot);
  const baseDir = join(homedir(), '.local', 'share', 'octate', identity);

  const paths: CachePaths = {
    root: baseDir,
    indexes: join(baseDir, 'indexes'),
    cache: join(baseDir, 'cache'),
    findings: join(baseDir, 'findings'),
    logs: join(baseDir, 'logs'),
  };

  // Ensure all directories exist
  for (const dir of Object.values(paths)) {
    await ensureDir(dir);
  }

  return paths;
}

/**
 * Initializes the project cache by creating the directory structure.
 * This is a convenience function that calls getCacheDir and ensures
 * all cache directories are created.
 */
export async function initializeProjectCache(repoRoot: string): Promise<CachePaths> {
  return await getCacheDir(repoRoot);
}

/**
 * Ensures a directory exists, creating it if necessary.
 */
async function ensureDir(dir: string): Promise<void> {
  try {
    await access(dir, constants.F_OK);
  } catch {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Gets the global cache directory (for non-project-specific data).
 */
export function getGlobalCacheDir(): string {
  return join(homedir(), '.local', 'share', 'octate', 'global');
}

/**
 * Computes a config hash for cache key invalidation.
 * Only includes user-set values, not defaults.
 */
export function computeConfigHash(config: Record<string, unknown>): string {
  const normalized = normalizeConfigForHash(config);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').substring(0, 8);
}

/**
 * Normalizes config for hashing by removing defaults and sorting keys.
 */
function normalizeConfigForHash(config: Record<string, unknown>): Record<string, unknown> {
  const defaults: Record<string, Record<string, unknown>> = {
    '': {
      version: '1.0.0',
      rules: [],
      ignore: [],
    },
    project: { name: 'unnamed-project' },
    review: {
      severity: 'medium',
      failOnSeverity: 'critical',
      maxFindings: 50,
      minConfidence: 0.6,
    },
    architecture: {
      boundaries: [],
      forbiddenDependencies: [],
    },
  };

  const normalize = (value: Record<string, unknown>, section: string): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      if (section === '' && key === 'architecture' && entry === null) continue;
      if (
        Object.prototype.hasOwnProperty.call(defaults[section] ?? {}, key) &&
        JSON.stringify(entry) === JSON.stringify(defaults[section]?.[key])
      ) {
        continue;
      }

      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const nested = normalize(entry as Record<string, unknown>, key);
        if (Object.keys(nested).length > 0) result[key] = nested;
      } else {
        result[key] = entry;
      }
    }
    return result;
  };

  return normalize(config, '');
}
