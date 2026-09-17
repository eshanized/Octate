import { describe, expect, it } from '@jest/globals';
import { evaluateExitCode, isBlockingFinding } from '../../src/application/policy.js';
import { ReferenceGraph } from '../../src/intelligence/graph/reference.js';
import type { ModelFinding } from '../../src/model/types.js';
import { MockReviewModel } from '../../src/review/__tests__/mocks.js';
import { executeCriticStage } from '../../src/review/critic.js';
import { rankAndTruncateFindings } from '../../src/review/ranking.js';

describe('Stage 1 Baseline Audit: False-Positive Reproductions', () => {
  const dummyRefGraph = new ReferenceGraph();

  describe('Reproduction 1: TypeScript type assertion (result.rows[0] as UserRecord)', () => {
    const typeAssertionFinding: ModelFinding = {
      severity: 'high',
      category: 'correctness',
      title: 'Potential runtime error from unvalidated database row cast',
      message:
        'The function casts result.rows[0] directly to UserRecord. If the database returns a row with missing columns or type mismatches, callers accessing properties will encounter runtime errors.',
      file: 'src/db/users.ts',
      startLine: 19,
      endLine: 19,
      confidence: 0.95,
      evidence: [
        {
          file: 'src/db/users.ts',
          startLine: 19,
          endLine: 19,
          relationship: 'direct',
          explanation: 'Type assertion without runtime schema validation',
        },
      ],
      impact: 'Runtime TypeError when accessing properties that do not exist on the database row',
      suggestedFix:
        'Use a runtime schema validation library such as Zod to parse result.rows[0] before returning',
      reviewer: 'semantic',
      relatedFiles: [],
      relatedSymbols: ['getUserById', 'UserRecord'],
    };

    it('demonstrates how uncalibrated severity causes safe type assertion to block merges', () => {
      const ranked = rankAndTruncateFindings({
        findings: [typeAssertionFinding],
        referenceGraph: dummyRefGraph,
      });

      expect(ranked).toHaveLength(1);
      const finding = ranked[0]!;

      // With decoupled disposition: high severity alone NO LONGER blocks!
      // Only findings with finalDisposition === 'blocking' can block.
      const isBlockingUnderHigh = isBlockingFinding(finding, 'high');
      expect(isBlockingUnderHigh).toBe(false);

      const reviewResult = {
        summary: {
          totalFindings: 1,
          bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
          byCategory: {
            correctness: 1,
            security: 0,
            performance: 0,
            architecture: 0,
            reliability: 0,
            maintainability: 0,
            compatibility: 0,
            testing: 0,
          },
          byReviewer: { semantic: 1 },
          filesAnalyzed: 1,
          durationMs: 100,
        },
        findings: ranked,
        metadata: {
          scopeType: 'working-tree',
          timestamp: new Date().toISOString(),
          version: '0.1.0',
          model: 'mock',
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          warnings: [],
          reviewersTriggered: ['semantic'],
          criticInvoked: true,
          preCriticFindingCount: 1,
          postCriticFindingCount: 1,
        },
      };

      // Safe type assertion with advisory disposition does NOT block merges (exit code 0)
      const exitCode = evaluateExitCode(reviewResult, 'high');
      expect(exitCode).toBe(0);

      // But if a finding is legitimately assigned blocking disposition, it blocks:
      const blockingFinding = { ...finding, finalDisposition: 'blocking' as const };
      expect(isBlockingFinding(blockingFinding, 'high')).toBe(true);
      expect(evaluateExitCode({ ...reviewResult, findings: [blockingFinding] }, 'high')).toBe(1);
    });

    it('demonstrates that the critic stage passes the finding through when critic model approves it', async () => {
      const mockModel = new MockReviewModel();
      mockModel.setRoleHandler('critic', async () => ({
        findings: [typeAssertionFinding],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        model: 'mock-critic',
        latencyMs: 10,
        finishReason: 'stop' as const,
      }));

      const criticResult = await executeCriticStage({
        findings: [typeAssertionFinding],
        repoRoot: process.cwd(),
        diff: '+++ b/src/db/users.ts\n@@ -15,7 +15,7 @@\n+ return (result.rows[0] as UserRecord) ?? null;',
        reviewContext: { items: [], totalTokens: 0 },
        diagnostics: [],
        model: mockModel,
      });

      // The baseline critic accepts the finding without demanding a concrete failure mechanism or reachable trigger
      expect(criticResult.findings).toHaveLength(1);
      expect(criticResult.findings[0]?.title).toBe(typeAssertionFinding.title);
    });
  });

  describe('Reproduction 2: Python subprocess.run(command, check=True)', () => {
    const subprocessFinding: ModelFinding = {
      severity: 'critical',
      category: 'reliability',
      title: 'Unhandled subprocess errors crash the CLI with raw tracebacks',
      message:
        'The `subprocess.run(..., check=True)` call raises `CalledProcessError` on any failure (file not found, permission denied, directory instead of file). This crashes the script with an unhelpful Python traceback instead of a user-friendly error message. The CLI should catch exceptions and exit cleanly with a descriptive message.',
      file: 'scripts/reporter.py',
      startLine: 13,
      endLine: 16,
      confidence: 1.0,
      evidence: [
        {
          file: 'scripts/reporter.py',
          startLine: 13,
          endLine: 16,
          relationship: 'direct',
          explanation:
            'subprocess.run(["cat", str(safe_path)], check=True) will raise CalledProcessError if the file is missing or unreadable, with no try/except handling.',
        },
      ],
      impact:
        'Poor user experience; automated scripts calling this tool cannot reliably parse errors; potential information leakage via tracebacks.',
      suggestedFix:
        'Wrap subprocess.run in try/except CalledProcessError and FileNotFoundError; print friendly error to stderr and sys.exit(1).',
      reviewer: 'semantic',
      relatedFiles: [],
      relatedSymbols: ['view_audit_log'],
    };

    it('demonstrates how uncalibrated critical severity on safe subprocess blocks merges under default policy', () => {
      const ranked = rankAndTruncateFindings({
        findings: [subprocessFinding],
        referenceGraph: dummyRefGraph,
      });

      expect(ranked).toHaveLength(1);
      const finding = ranked[0]!;

      // With decoupled disposition: critical severity alone NO LONGER blocks!
      // Only findings with finalDisposition === 'blocking' can block.
      const isBlockingUnderDefault = isBlockingFinding(finding, 'critical');
      expect(isBlockingUnderDefault).toBe(false);

      const reviewResult = {
        summary: {
          totalFindings: 1,
          bySeverity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
          byCategory: {
            correctness: 0,
            security: 0,
            performance: 0,
            architecture: 0,
            reliability: 1,
            maintainability: 0,
            compatibility: 0,
            testing: 0,
          },
          byReviewer: { semantic: 1 },
          filesAnalyzed: 1,
          durationMs: 100,
        },
        findings: ranked,
        metadata: {
          scopeType: 'working-tree',
          timestamp: new Date().toISOString(),
          version: '0.1.0',
          model: 'mock',
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          warnings: [],
          reviewersTriggered: ['semantic'],
          criticInvoked: true,
          preCriticFindingCount: 1,
          postCriticFindingCount: 1,
        },
      };

      // Under default threshold ('critical'), safe subprocess with advisory disposition yields exit code 0!
      const exitCode = evaluateExitCode(reviewResult, 'critical');
      expect(exitCode).toBe(0);

      // But if a finding is legitimately assigned blocking disposition, it blocks:
      const blockingFinding = { ...finding, finalDisposition: 'blocking' as const };
      expect(isBlockingFinding(blockingFinding, 'critical')).toBe(true);
      expect(evaluateExitCode({ ...reviewResult, findings: [blockingFinding] }, 'critical')).toBe(
        1
      );
    });

    it('demonstrates that critical-protected truncation unconditionally preserves the finding', () => {
      // Even if maxFindings is 0 or low, critical findings are unconditionally protected!
      const ranked = rankAndTruncateFindings({
        findings: [subprocessFinding],
        referenceGraph: dummyRefGraph,
        maxFindings: 0,
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.severity).toBe('critical');
    });
  });
});
