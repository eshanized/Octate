/**
 * Unit tests for Deterministic Evidence Validation Engine.
 */

import { describe, expect, it } from '@jest/globals';
import type { ModelEvidence, ModelFinding } from '../model/types.js';
import {
  isBinaryPath,
  isCommonIgnoredPath,
  isGeneratedOrLockPath,
  parseDetailedDiff,
  sanitizeSecretTokens,
  validateAllFindingsEvidence,
  validateEvidenceItem,
  validateFindingEvidence,
} from './evidence-validator.js';

function makeFinding(overrides?: Partial<ModelFinding>): ModelFinding {
  return {
    severity: 'high',
    category: 'security',
    title: 'SQL Injection in search query',
    message: 'User input directly concatenated into query',
    file: 'src/db/users.ts',
    startLine: 15,
    endLine: 20,
    confidence: 0.9,
    evidence: [
      {
        file: 'src/db/users.ts',
        startLine: 16,
        endLine: 18,
        relationship: 'taint-sink',
        explanation: 'Input string concatenated into query',
      },
    ],
    impact: 'Remote code or data leakage',
    suggestedFix: 'Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])',
    reviewer: 'security',
    relatedFiles: [],
    relatedSymbols: [],
    ...overrides,
  };
}

describe('Evidence Validator', () => {
  describe('Secret token sanitization', () => {
    it('redacts sensitive API keys and tokens', () => {
      const input =
        'Leak: sk-proj-1234567890abcdefghijklmn and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and AKIAIOSFODNN7EXAMPLE';
      const output = sanitizeSecretTokens(input);
      expect(output).toContain('[REDACTED_API_KEY]');
      expect(output).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(output).toContain('[REDACTED_AWS_KEY]');
      expect(output).not.toContain('sk-proj-');
      expect(output).not.toContain('ghp_');
      expect(output).not.toContain('AKIA');
    });

    it('redacts Bearer tokens and passwords', () => {
      const input = 'Authorization: Bearer secret_jwt_token_12345; password="mySuperSecretPassword!"';
      const output = sanitizeSecretTokens(input);
      expect(output).toContain('Bearer [REDACTED_TOKEN]');
      expect(output).toContain('password: "[REDACTED]"');
      expect(output).not.toContain('mySuperSecretPassword');
    });
  });

  describe('File path classifiers', () => {
    it('identifies binary files', () => {
      expect(isBinaryPath('assets/image.png')).toBe(true);
      expect(isBinaryPath('lib/native.so')).toBe(true);
      expect(isBinaryPath('fonts/glyph.woff2')).toBe(true);
      expect(isBinaryPath('src/index.ts')).toBe(false);
    });

    it('identifies generated or lock files', () => {
      expect(isGeneratedOrLockPath('package-lock.json')).toBe(true);
      expect(isGeneratedOrLockPath('dist/bundle.min.js')).toBe(true);
      expect(isGeneratedOrLockPath('src/app.map')).toBe(true);
      expect(isGeneratedOrLockPath('pnpm-lock.yaml')).toBe(true);
      expect(isGeneratedOrLockPath('src/users.ts')).toBe(false);
    });

    it('identifies common ignored directories', () => {
      expect(isCommonIgnoredPath('node_modules/pkg/index.js')).toBe(true);
      expect(isCommonIgnoredPath('.git/HEAD')).toBe(true);
      expect(isCommonIgnoredPath('dist/index.js')).toBe(true);
      expect(isCommonIgnoredPath('src/node_modules_helper.ts')).toBe(false);
    });
  });

  describe('Diff parsing', () => {
    const sampleDiff = `diff --git a/src/db/old-users.ts b/src/db/users.ts
rename from src/db/old-users.ts
rename to src/db/users.ts
--- a/src/db/old-users.ts
+++ b/src/db/users.ts
@@ -10,3 +10,5 @@
 context line 1
-deleted line 1
+added line 1
+added line 2
 context line 2
diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
--- a/src/legacy.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-old code
`;

    it('extracts renames, deleted files, and added line intervals', () => {
      const parsed = parseDetailedDiff(sampleDiff);
      expect(parsed.renames.get('src/db/old-users.ts')).toBe('src/db/users.ts');
      expect(parsed.deletedFiles.has('src/legacy.ts')).toBe(true);

      const usersMeta = parsed.files.get('src/db/users.ts');
      expect(usersMeta).toBeDefined();
      expect(usersMeta?.status).toBe('renamed');
      expect(usersMeta?.addedModifiedLines).toEqual([{ start: 11, end: 12 }]);
    });
  });

  describe('validateEvidenceItem', () => {
    const sampleDiff = `diff --git a/src/db/users.ts b/src/db/users.ts
--- a/src/db/users.ts
+++ b/src/db/users.ts
@@ -10,3 +10,5 @@
 context
+added line 11
+added line 12
 context
diff --git a/src/deleted.ts b/src/deleted.ts
--- a/src/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-deleted
`;
    const parsedDiff = parseDetailedDiff(sampleDiff);

    const defaultOptions = {
      repoRoot: '/fake/repo',
      diff: sampleDiff,
      fileExists: async (f: string) => f === 'src/db/users.ts' || f === 'src/auth/middleware.ts',
      getFileLineCount: async (f: string) => {
        if (f === 'src/db/users.ts') return 50;
        if (f === 'src/auth/middleware.ts') return 100;
        return null;
      },
    };

    it('classifies lines intersecting diff hunks as direct_changed', async () => {
      const ev: ModelEvidence = {
        file: 'src/db/users.ts',
        startLine: 11,
        endLine: 12,
        relationship: 'sink',
        explanation: 'Directly modified query lines',
      };
      const result = await validateEvidenceItem(ev, defaultOptions, parsedDiff);
      expect(result.valid).toBe(true);
      expect(result.tier).toBe('direct_changed');
    });

    it('classifies lines in changed file outside diff hunks as indirect_context', async () => {
      const ev: ModelEvidence = {
        file: 'src/db/users.ts',
        startLine: 40,
        endLine: 45,
        relationship: 'caller',
        explanation: 'Caller in same file outside diff hunk',
      };
      const result = await validateEvidenceItem(ev, defaultOptions, parsedDiff);
      expect(result.valid).toBe(true);
      expect(result.tier).toBe('indirect_context');
    });

    it('classifies deleted file lines as baseline_context', async () => {
      const ev: ModelEvidence = {
        file: 'src/deleted.ts',
        startLine: 1,
        endLine: 2,
        relationship: 'historical',
        explanation: 'Referenced code that was removed in this patch',
      };
      const result = await validateEvidenceItem(ev, defaultOptions, parsedDiff);
      expect(result.valid).toBe(true);
      expect(result.tier).toBe('baseline_context');
    });

    it('validates supporting context in unchanged file with causal link', async () => {
      const ev: ModelEvidence = {
        file: 'src/auth/middleware.ts',
        startLine: 20,
        endLine: 25,
        relationship: 'middleware',
        explanation: 'Auth middleware caller that passes unvalidated token downstream',
        causalLink: 'Calls src/db/users.ts:11 without validating tenant boundary',
      };
      const result = await validateEvidenceItem(ev, defaultOptions, parsedDiff);
      expect(result.valid).toBe(true);
      expect(result.tier).toBe('supporting_context');
      expect(result.evidence.causalLink).toBeDefined();
    });

    it('rejects supporting context in unchanged file without causal link or explanation', async () => {
      const ev: ModelEvidence = {
        file: 'src/auth/middleware.ts',
        startLine: 20,
        endLine: 25,
        relationship: 'middleware',
        explanation: '',
      };
      const result = await validateEvidenceItem(ev, defaultOptions, parsedDiff);
      expect(result.valid).toBe(false);
      expect(result.rejectionReason).toContain('requires an explicit causalLink');
    });

    it('rejects out-of-bounds line numbers', async () => {
      const ev: ModelEvidence = {
        file: 'src/db/users.ts',
        startLine: 100, // file has only 50 lines
        endLine: 105,
        relationship: 'sink',
        explanation: 'Invalid line beyond end of file',
      };
      const result = await validateEvidenceItem(ev, defaultOptions, parsedDiff);
      expect(result.valid).toBe(false);
      expect(result.rejectionReason).toContain('exceeds total lines');
    });

    it('rejects path traversal attempts', async () => {
      const ev: ModelEvidence = {
        file: '../../../etc/passwd',
        startLine: 1,
        endLine: 1,
        relationship: 'sink',
        explanation: 'Path traversal attempt',
      };
      const result = await validateEvidenceItem(ev, defaultOptions, parsedDiff);
      expect(result.valid).toBe(false);
      expect(result.rejectionReason).toContain('Path traversal');
    });

    it('rejects binary and generated files', async () => {
      const binaryEv: ModelEvidence = {
        file: 'assets/logo.png',
        startLine: 1,
        endLine: 2,
        relationship: 'resource',
        explanation: 'Binary file evidence',
      };
      const binResult = await validateEvidenceItem(binaryEv, defaultOptions, parsedDiff);
      expect(binResult.valid).toBe(false);
      expect(binResult.rejectionReason).toContain('binary file');

      const genEv: ModelEvidence = {
        file: 'package-lock.json',
        startLine: 1,
        endLine: 2,
        relationship: 'manifest',
        explanation: 'Lockfile evidence',
      };
      const genResult = await validateEvidenceItem(genEv, defaultOptions, parsedDiff);
      expect(genResult.valid).toBe(false);
      expect(genResult.rejectionReason).toContain('generated or lock');
    });
  });

  describe('validateFindingEvidence', () => {
    const sampleDiff = `diff --git a/src/db/users.ts b/src/db/users.ts
--- a/src/db/users.ts
+++ b/src/db/users.ts
@@ -10,3 +10,5 @@
 context
+line 11
+line 12
 context
`;
    const options = {
      repoRoot: '/fake/repo',
      diff: sampleDiff,
      fileExists: async (f: string) => f === 'src/db/users.ts' || f === 'src/auth/middleware.ts',
      getFileLineCount: async (f: string) => 50,
    };

    it('computes high evidence strength for valid direct changed evidence', async () => {
      const finding = makeFinding({
        file: 'src/db/users.ts',
        startLine: 11,
        endLine: 12,
        evidence: [
          {
            file: 'src/db/users.ts',
            startLine: 11,
            endLine: 12,
            relationship: 'direct',
            explanation: 'Vulnerable SQL query directly modified in this patch',
          },
        ],
      });

      const result = await validateFindingEvidence(finding, options);
      expect(result.isValid).toBe(true);
      expect(result.hasDirectChangedEvidence).toBe(true);
      expect(result.evidenceStrength).toBeGreaterThanOrEqual(70);
    });

    it('scores 0 and marks invalid when all evidence is fabricated or out of bounds', async () => {
      const finding = makeFinding({
        file: 'src/non-existent.ts',
        startLine: 10,
        evidence: [
          {
            file: 'src/fake.ts',
            startLine: 1,
            endLine: 5,
            relationship: 'fake',
            explanation: 'Fabricated file that does not exist',
          },
        ],
      });

      const result = await validateFindingEvidence(finding, options);
      expect(result.isValid).toBe(false);
      expect(result.evidenceStrength).toBe(0);
      expect(result.invalidEvidence.length).toBeGreaterThan(0);
    });
  });

  describe('validateAllFindingsEvidence', () => {
    it('validates multiple findings concurrently and attaches validated evidence', async () => {
      const validFinding = makeFinding({
        file: 'src/db/users.ts',
        startLine: 11,
        evidence: [
          {
            file: 'src/db/users.ts',
            startLine: 11,
            endLine: 12,
            relationship: 'direct',
            explanation: 'Valid direct evidence anchor',
          },
        ],
      });

      const invalidFinding = makeFinding({
        file: 'src/missing.ts',
        startLine: 1,
        evidence: [
          {
            file: 'src/missing.ts',
            startLine: 1,
            endLine: 2,
            relationship: 'direct',
            explanation: 'Missing file anchor',
          },
        ],
      });

      const { findings, results } = await validateAllFindingsEvidence(
        [validFinding, invalidFinding],
        {
          repoRoot: '/fake/repo',
          fileExists: async (f) => f === 'src/db/users.ts',
          getFileLineCount: async () => 30,
        }
      );

      expect(findings).toHaveLength(2);
      expect(results.get(validFinding)?.isValid).toBe(true);
      expect(results.get(invalidFinding)?.isValid).toBe(false);
      expect(findings[0]?.evidence[0]?.tier).toBeDefined();
    });
  });
});
