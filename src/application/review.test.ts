/**
 * Unit and integration tests for ReviewUseCase application orchestrator.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as git from 'isomorphic-git';
import { DefaultConfig } from '../config/schema.js';
import { listFilesAtReviewScope } from '../repository/git.js';
import { createTestFinding, MockReviewModel } from '../review/__tests__/mocks.js';
import { createReviewUseCase, resolveWorkspaceInfosAtScope, ReviewUseCase } from './review.js';
import type { CanonicalReviewStage, ReviewProgressEvent } from './types.js';

describe('application:review', () => {
  let testDir: string;
  let model: MockReviewModel;
  let useCase: ReviewUseCase;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join('/tmp', 'octate-usecase-test-'));
    model = new MockReviewModel();
    useCase = createReviewUseCase();

    // Initialize clean git repository
    await git.init({ fs, dir: testDir });
    await git.setConfig({ fs, dir: testDir, path: 'user.name', value: 'Test User' });
    await git.setConfig({ fs, dir: testDir, path: 'user.email', value: 'test@example.com' });

    // Initial commit
    await fs.writeFile(path.join(testDir, 'README.md'), '# Octate Test\n');
    await git.add({ fs, dir: testDir, filepath: 'README.md' });
    await git.commit({ fs, dir: testDir, message: 'Initial commit' });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('creates instance via factory function', () => {
    expect(useCase).toBeInstanceOf(ReviewUseCase);
  });

  it('short-circuits on empty diff returning empty ReviewResult without calling model', async () => {
    const events: ReviewProgressEvent[] = [];
    const result = await useCase.execute({
      repoRoot: testDir,
      modelOverride: model,
      onProgress: (event) => events.push(event),
    });

    expect(result).toBeDefined();
    expect(result.summary.totalFindings).toBe(0);
    expect(result.summary.filesAnalyzed).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.metadata.totalTokens).toBe(0);
    expect(model.calls.length).toBe(0);

    // Should only have emitted git:read stage
    const stages = events.map((e) => e.stage);
    expect(stages).toContain('git:read');
    expect(stages).not.toContain('index:update');
  });

  it('sequentially invokes and emits all 8 canonical stages with step counters', async () => {
    // Create an unstaged TypeScript file with content
    const testFile = 'handler.ts';
    await fs.writeFile(
      path.join(testDir, testFile),
      'export function handleUser(user: { profile?: string }): string {\n  return user.profile || "default";\n}\n'
    );

    const testFinding = createTestFinding({
      file: testFile,
      startLine: 1,
      endLine: 2,
      evidence: [
        {
          file: testFile,
          startLine: 1,
          endLine: 2,
          relationship: 'caller',
          explanation: 'Object accessed here before null guard',
        },
      ],
      severity: 'high',
      category: 'correctness',
      title: 'Potential null dereference in handler',
    });

    // Configure mock model responses for DAG and Critic
    model.setRoleHandler('structural', async () => ({
      findings: [testFinding],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      model: 'mock-nemotron',
      latencyMs: 10,
      finishReason: 'stop',
    }));

    model.setRoleHandler('critic', async () => ({
      findings: [testFinding],
      usage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
      model: 'mock-nemotron',
      latencyMs: 10,
      finishReason: 'stop',
    }));

    const events: ReviewProgressEvent[] = [];
    const result = await useCase.execute({
      repoRoot: testDir,
      modelOverride: model,
      onProgress: (event) => events.push(event),
    });

    expect(result).toBeDefined();
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]?.severity).toBe('high');
    expect(result.summary.totalFindings).toBe(1);
    expect(result.summary.filesAnalyzed).toBe(1);

    // Verify all 8 canonical stages were emitted in exact order
    const expectedStages: CanonicalReviewStage[] = [
      'git:read',
      'index:update',
      'symbols:resolve',
      'diagnostics:collect',
      'context:build',
      'review:dag',
      'review:critic',
      'review:rank',
    ];

    for (const [i, stage] of expectedStages.entries()) {
      const startEvent = events.find((e) => e.stage === stage && e.status === 'start');
      const completeEvent = events.find((e) => e.stage === stage && e.status === 'complete');

      expect(startEvent).toBeDefined();
      expect(completeEvent).toBeDefined();
      expect(startEvent?.step).toEqual({ current: i + 1, total: 8 });
      expect(completeEvent?.step).toEqual({ current: i + 1, total: 8 });
    }
  });

  it('uses the requested commit snapshot instead of newer worktree contents', async () => {
    const filePath = path.join(testDir, 'snapshot.ts');
    await fs.writeFile(filePath, 'export const snapshotValue = "COMMITTED_VERSION";\n');
    await git.add({ fs, dir: testDir, filepath: 'snapshot.ts' });
    await git.commit({ fs, dir: testDir, message: 'Commit snapshot fixture' });
    const commitOid = await git.resolveRef({ fs, dir: testDir, ref: 'HEAD' });

    await fs.writeFile(filePath, 'export const snapshotValue = "WORKTREE_VERSION";\n');

    const result = await useCase.execute({
      repoRoot: testDir,
      modelOverride: model,
      scopeOptions: { type: 'commit', repoRoot: testDir, commit: commitOid },
    });

    expect(result.metadata.warnings).toContain(
      'Filesystem-based diagnostics were skipped because they cannot safely analyze a historical Git snapshot.'
    );

    const recordedRequests = JSON.stringify(model.calls);
    expect(recordedRequests).toContain('COMMITTED_VERSION');
    expect(recordedRequests).not.toContain('WORKTREE_VERSION');
  });

  it('resolves workspace names and layout from the reviewed snapshot', async () => {
    await fs.mkdir(path.join(testDir, 'packages', 'core'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'snapshot-root', workspaces: ['packages/*'] }, null, 2)
    );
    await fs.writeFile(
      path.join(testDir, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@snapshot/core' }, null, 2)
    );
    await git.add({ fs, dir: testDir, filepath: 'package.json' });
    await git.add({ fs, dir: testDir, filepath: 'packages/core/package.json' });
    await git.commit({ fs, dir: testDir, message: 'Add snapshot workspace manifest' });
    const commitOid = await git.resolveRef({ fs, dir: testDir, ref: 'HEAD' });

    // Change workspace discovery inputs after the commit. A historical review must
    // keep the committed manifest and package identity.
    await fs.writeFile(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'live-root', workspaces: ['apps/*'] }, null, 2)
    );
    await fs.mkdir(path.join(testDir, 'apps', 'live-only'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, 'apps', 'live-only', 'package.json'),
      JSON.stringify({ name: '@live-only/package' }, null, 2)
    );
    await fs.writeFile(
      path.join(testDir, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@live-changed/core' }, null, 2)
    );

    const snapshotPaths = await listFilesAtReviewScope(testDir, 'commit', commitOid);
    const workspaces = await resolveWorkspaceInfosAtScope(
      testDir,
      'commit',
      commitOid,
      snapshotPaths
    );

    expect(workspaces).toEqual([{ name: '@snapshot/core', path: 'packages/core' }]);
  });

  it('forwards project rules and architecture constraints to model requests', async () => {
    await fs.writeFile(
      path.join(testDir, 'handler.ts'),
      'export function handle(input: string): string { return input.trim(); }\n'
    );

    const config = {
      ...DefaultConfig,
      project: { name: 'review-rules-test' },
      rules: ['validate input before use'],
      architecture: {
        boundaries: ['src/domain'],
        forbiddenDependencies: ['src/domain -> src/infrastructure'],
      },
    };

    const result = await useCase.execute({
      repoRoot: testDir,
      modelOverride: model,
      config,
    });

    expect(result).toBeDefined();
    expect(model.calls.length).toBeGreaterThan(0);
    expect(model.calls[0]?.projectRules).toEqual([
      'Project rule: validate input before use',
      'Architecture boundaries to preserve: src/domain',
      'Forbidden dependencies and dependency directions: src/domain -> src/infrastructure',
    ]);
  });

  it('rejects when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      useCase.execute({
        repoRoot: testDir,
        modelOverride: model,
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});
