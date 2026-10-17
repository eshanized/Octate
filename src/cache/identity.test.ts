/**
 * Tests for project identity hashing and cache directory resolution.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  computeConfigHash,
  computeProjectIdentity,
  getCacheDir,
  getGlobalCacheDir,
} from './identity.js';

const TEST_DIR = join(tmpdir(), `octate-identity-test-${randomUUID()}`);

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('computeProjectIdentity', () => {
  it('generates consistent hash for same repo root and remote', async () => {
    const repoRoot = resolve(TEST_DIR, 'repo1');
    await mkdir(resolve(repoRoot, '.git'), { recursive: true });
    await writeFile(
      resolve(repoRoot, '.git', 'config'),
      '[remote "origin"]\n  url = https://github.com/user/repo.git\n'
    );

    const hash1 = await computeProjectIdentity(repoRoot);
    const hash2 = await computeProjectIdentity(repoRoot);

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(16);
  });

  it('generates different hashes for different repos', async () => {
    const repo1 = resolve(TEST_DIR, 'repo1');
    const repo2 = resolve(TEST_DIR, 'repo2');

    await mkdir(resolve(repo1, '.git'), { recursive: true });
    await writeFile(
      resolve(repo1, '.git', 'config'),
      '[remote "origin"]\n  url = https://github.com/user/repo1.git\n'
    );

    await mkdir(resolve(repo2, '.git'), { recursive: true });
    await writeFile(
      resolve(repo2, '.git', 'config'),
      '[remote "origin"]\n  url = https://github.com/user/repo2.git\n'
    );

    const hash1 = await computeProjectIdentity(repo1);
    const hash2 = await computeProjectIdentity(repo2);

    expect(hash1).not.toBe(hash2);
  });

  it('falls back to path-based identity when no remote', async () => {
    const repoRoot = resolve(TEST_DIR, 'no-remote');
    await mkdir(resolve(repoRoot, '.git'), { recursive: true });
    await writeFile(resolve(repoRoot, '.git', 'config'), '[core]\n  repositoryformatversion = 0\n');

    const hash = await computeProjectIdentity(repoRoot);
    expect(hash.length).toBe(16);
  });

  it('normalizes relative and absolute paths to the same project identity', async () => {
    const repoRoot = resolve(TEST_DIR, 'relative-identity');
    await mkdir(resolve(repoRoot, '.git'), { recursive: true });
    await writeFile(
      resolve(repoRoot, '.git', 'config'),
      '[remote "origin"]\n  url = https://example.com/relative.git\n'
    );

    const absoluteIdentity = await computeProjectIdentity(repoRoot);
    const relativeIdentity = await computeProjectIdentity(relative(process.cwd(), repoRoot));
    expect(relativeIdentity).toBe(absoluteIdentity);
  });

  it('reads remote configuration through a linked worktree gitdir', async () => {
    const repoRoot = resolve(TEST_DIR, 'worktree-config');
    const commonGitDir = resolve(TEST_DIR, 'common-worktree-config', '.git');
    const worktreeGitDir = resolve(commonGitDir, 'worktrees', 'linked');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(resolve(worktreeGitDir, 'commondir'), '../..\n');
    await writeFile(resolve(repoRoot, '.git'), `gitdir: ${worktreeGitDir}\n`);
    await writeFile(
      resolve(commonGitDir, 'config'),
      '[remote "origin"]\n  url = https://example.com/first.git\n'
    );

    const firstHash = await computeProjectIdentity(repoRoot);
    await writeFile(
      resolve(commonGitDir, 'config'),
      '[remote "origin"]\n  url = https://example.com/second.git\n'
    );
    const secondHash = await computeProjectIdentity(repoRoot);

    expect(firstHash).not.toBe(secondHash);
  });
});

describe('getCacheDir', () => {
  it('returns correct path structure', async () => {
    const repoRoot = resolve(TEST_DIR, 'repo-cache');
    await mkdir(resolve(repoRoot, '.git'), { recursive: true });
    await writeFile(
      resolve(repoRoot, '.git', 'config'),
      '[remote "origin"]\n  url = https://github.com/user/repo.git\n'
    );

    const paths = await getCacheDir(repoRoot);

    expect(paths.root).toContain('.local/share/octate/');
    expect(paths.indexes).toBe(join(paths.root, 'indexes'));
    expect(paths.cache).toBe(join(paths.root, 'cache'));
    expect(paths.findings).toBe(join(paths.root, 'findings'));
    expect(paths.logs).toBe(join(paths.root, 'logs'));
  });

  it('creates all subdirectories', async () => {
    const repoRoot = resolve(TEST_DIR, 'repo-cache2');
    await mkdir(resolve(repoRoot, '.git'), { recursive: true });
    await writeFile(
      resolve(repoRoot, '.git', 'config'),
      '[remote "origin"]\n  url = https://github.com/user/repo.git\n'
    );

    const paths = await getCacheDir(repoRoot);

    // All directories should exist
    const { access } = await import('node:fs/promises');
    for (const dir of Object.values(paths)) {
      await expect(access(dir)).resolves.not.toThrow();
    }
  });
});

describe('computeConfigHash', () => {
  it('generates consistent hash for same config', () => {
    const config = { review: { severity: 'high', max_findings: 20 } };
    const hash1 = computeConfigHash(config);
    const hash2 = computeConfigHash(config);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(8);
  });

  it('generates different hashes for different configs', () => {
    const config1 = { review: { severity: 'high' } };
    const config2 = { review: { severity: 'low' } };
    const hash1 = computeConfigHash(config1);
    const hash2 = computeConfigHash(config2);
    expect(hash1).not.toBe(hash2);
  });

  it('ignores current schema defaults and canonicalizes object key order', () => {
    const configWithDefaults = {
      version: '1.0.0',
      project: { name: 'unnamed-project' },
      review: {
        severity: 'medium',
        failOnSeverity: 'critical',
        maxFindings: 50,
        minConfidence: 0.6,
      },
      rules: [],
      architecture: { boundaries: [], forbiddenDependencies: [] },
      ignore: [],
    };
    expect(computeConfigHash(configWithDefaults)).toBe(computeConfigHash({}));

    const left = { review: { maxFindings: 10, severity: 'high' }, project: { name: 'demo' } };
    const right = { project: { name: 'demo' }, review: { severity: 'high', maxFindings: 10 } };
    expect(computeConfigHash(left)).toBe(computeConfigHash(right));
  });

  it('changes hashes when a non-default policy changes', () => {
    expect(computeConfigHash({ review: { severity: 'high' } })).not.toBe(
      computeConfigHash({ review: { severity: 'low' } })
    );
  });
});

describe('getGlobalCacheDir', () => {
  it('returns global cache path', () => {
    const globalDir = getGlobalCacheDir();
    expect(globalDir).toContain('.local/share/octate/global');
  });
});
