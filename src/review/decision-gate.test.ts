/**
 * Comprehensive Unit Tests for Final Deterministic Decision Gate.
 */

import { describe, expect, it } from '@jest/globals';
import type { EvidenceValidationResult } from './evidence-validator.js';
import { evaluateFindingGate, runDecisionGate } from './decision-gate.js';
import type { RankedFinding } from './types.js';

function makeRankedFinding(overrides?: Partial<RankedFinding>): RankedFinding {
  return {
    id: 'src/db/users.ts:15:security:SQL Injection',
    severity: 'high',
    category: 'security',
    title: 'SQL Injection in search query',
    message: 'User input from query parameter is concatenated directly into SQL statement',
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
        tier: 'direct_changed',
      },
    ],
    impact: 'Remote code or data leakage via unauthorized SQL execution',
    suggestedFix: 'Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])',
    reviewer: 'security',
    claim: 'Concatenating req.query.id directly enables SQL injection',
    failureMechanism: 'Attacker supplies SQL fragments that break out of the string literal',
    trigger: "req.query.id = \"' OR '1'='1\"",
    requiredFix: 'db.query("SELECT * FROM users WHERE id = $1", [id])',
    finalDisposition: 'advisory',
    modelSuggestedDisposition: 'blocking',
    introducedByPatch: 'introduced_by_patch',
    criticDecision: 'approved',
    provenance: [
      {
        reviewer: 'security',
        role: 'security',
        confidence: 0.9,
        assignedSeverity: 'high',
        timestamp: new Date().toISOString(),
      },
    ],
    compositeScore: 85,
    scoreBreakdown: {
      severityScore: 80,
      confidenceScore: 90,
      evidenceStrengthScore: 85,
      blastRadiusScore: 50,
      securityImpactScore: 90,
      regressionProbabilityScore: 80,
    },
    blastRadius: 50,
    evidenceStrength: 85,
    contributingReviewers: ['security'],
    relatedFiles: [],
    relatedSymbols: [],
    ...overrides,
  };
}

function makeValidationResult(
  overrides?: Partial<EvidenceValidationResult>
): EvidenceValidationResult {
  return {
    isValid: true,
    evidenceStrength: 85,
    hasDirectChangedEvidence: true,
    hasSupportingContext: false,
    validatedItems: [],
    validEvidence: [
      {
        file: 'src/db/users.ts',
        startLine: 16,
        endLine: 18,
        relationship: 'taint-sink',
        explanation: 'Input string concatenated into query',
        tier: 'direct_changed',
      },
    ],
    invalidEvidence: [],
    issues: [],
    ...overrides,
  };
}

describe('Final Deterministic Decision Gate', () => {
  it('1. Critical severity with invalid evidence is REJECTED', () => {
    const finding = makeRankedFinding({
      severity: 'critical',
      evidence: [],
    });
    const invalidValidation = makeValidationResult({
      isValid: false,
      evidenceStrength: 0,
      validEvidence: [],
      invalidEvidence: [
        {
          evidence: {
            file: 'src/non-existent.ts',
            startLine: 1,
            endLine: 5,
            relationship: 'anchor',
            explanation: 'File does not exist',
          },
          reason: 'File does not exist: src/non-existent.ts',
        },
      ],
      issues: ['File does not exist in repository: src/non-existent.ts'],
    });

    const result = evaluateFindingGate(finding, invalidValidation);
    expect(result.finalDisposition).toBe('rejected');
    expect(result.decisionLog.failedChecks).toContain('evidenceValid');
  });

  it('2. Critical severity with no trigger cannot block (downgraded to advisory or rejected)', () => {
    const finding = makeRankedFinding({
      severity: 'critical',
      trigger: '', // Empty or missing trigger
    });
    const validation = makeValidationResult();

    const result = evaluateFindingGate(finding, validation);
    expect(result.finalDisposition).not.toBe('blocking');
    expect(result.decisionLog.failedChecks).toContain('credibleTrigger');
  });

  it('3. Valid vulnerability in unchanged code (pre_existing) is ADVISORY and non-blocking', () => {
    const finding = makeRankedFinding({
      severity: 'high',
      introducedByPatch: 'pre_existing',
    });
    const validation = makeValidationResult({
      hasDirectChangedEvidence: false,
    });

    const result = evaluateFindingGate(finding, validation);
    expect(result.finalDisposition).toBe('advisory');
    expect(result.decisionLog.failedChecks).toContain('patchAttribution');
    expect(result.downgraded).toBe(true);
  });

  it('4. Changed code with supporting unchanged context is eligible for BLOCKING', () => {
    const finding = makeRankedFinding({
      severity: 'high',
      introducedByPatch: 'introduced_by_patch',
      evidence: [
        {
          file: 'src/db/users.ts',
          startLine: 16,
          endLine: 18,
          relationship: 'taint-sink',
          explanation: 'Modified query caller',
          tier: 'direct_changed',
        },
        {
          file: 'src/db/client.ts',
          startLine: 40,
          endLine: 45,
          relationship: 'callee',
          explanation: 'Underlying raw SQL client method',
          tier: 'supporting_context',
          causalLink: 'Called by src/db/users.ts:16 without parameter escaping',
        },
      ],
    });
    const validation = makeValidationResult({
      hasDirectChangedEvidence: true,
      hasSupportingContext: true,
    });

    const result = evaluateFindingGate(finding, validation);
    expect(result.finalDisposition).toBe('blocking');
    expect(result.decisionLog.passedChecks).toHaveLength(11);
    expect(result.decisionLog.failedChecks).toHaveLength(0);
  });

  it('5. High model confidence (0.99) but no proof is non-blocking', () => {
    const finding = makeRankedFinding({
      confidence: 0.99,
      failureMechanism: 'potential issue', // Generic placeholder
      trigger: 'any input', // Generic placeholder
    });
    const validation = makeValidationResult();

    const result = evaluateFindingGate(finding, validation);
    expect(result.finalDisposition).not.toBe('blocking');
    expect(result.decisionLog.failedChecks).toContain('concreteFailureMechanism');
    expect(result.decisionLog.failedChecks).toContain('credibleTrigger');
  });

  it('6. Critic approval with strong contradiction is non-blocking', () => {
    const finding = makeRankedFinding({
      criticDecision: 'approved',
      contradictions: ['Static typechecker proves parameter is strongly typed as ReadonlyArray'],
    });
    const validation = makeValidationResult();

    const result = evaluateFindingGate(finding, validation);
    expect(result.finalDisposition).not.toBe('blocking');
    expect(result.decisionLog.failedChecks).toContain('noStrongContradiction');
  });

  it('7. Subprocess call with malicious argument injection is eligible for BLOCKING when evidence is sound', () => {
    const finding = makeRankedFinding({
      file: 'scripts/deploy.py',
      startLine: 25,
      endLine: 30,
      severity: 'critical',
      category: 'security',
      title: 'Argument injection in subprocess.run',
      message: 'Unvalidated user string is passed as flag argument into subprocess.run list',
      claim: 'Passing untrusted user flag allows argument injection into git binary',
      failureMechanism:
        'User supplies flag `--upload-pack=evil` which git executes as a subshell command',
      trigger: 'branchName = "--upload-pack=sh -c calc"',
      requiredFix: 'Validate branchName against ^[a-zA-Z0-9_.-]+$ before invoking subprocess',
      evidence: [
        {
          file: 'scripts/deploy.py',
          startLine: 26,
          endLine: 28,
          relationship: 'sink',
          explanation: 'subprocess.run(["git", "fetch", user_branch], check=True)',
          tier: 'direct_changed',
        },
      ],
      introducedByPatch: 'introduced_by_patch',
      criticDecision: 'approved',
    });
    const validation = makeValidationResult({
      validEvidence: finding.evidence,
      hasDirectChangedEvidence: true,
    });

    const result = evaluateFindingGate(finding, validation);
    expect(result.finalDisposition).toBe('blocking');
    expect(result.decisionLog.failedChecks).toHaveLength(0);
  });

  it('8. Type assertion flowing into dangerous sink is eligible for BLOCKING on sink merits', () => {
    const finding = makeRankedFinding({
      severity: 'high',
      category: 'security',
      title: 'XSS via unescaped type-asserted record field',
      message: 'Unescaped user-supplied field from type assertion rendered directly to DOM',
      claim: 'Field bio from UserRecord rendered as raw HTML without sanitization',
      failureMechanism: 'Attacker injects <script>alert(1)</script> which browser executes',
      trigger: 'userRecord.bio = "<img src=x onerror=alert(1)>"',
      requiredFix: 'Use DOMPurify.sanitize(userRecord.bio) or escapeHtml()',
      introducedByPatch: 'introduced_by_patch',
      criticDecision: 'approved',
    });
    const validation = makeValidationResult();

    const result = evaluateFindingGate(finding, validation);
    expect(result.finalDisposition).toBe('blocking');
  });

  it('9. Valid vulnerability spanning changed and unchanged files is eligible when causality is proven', () => {
    const finding = makeRankedFinding({
      evidence: [
        {
          file: 'src/api/routes.ts',
          startLine: 10,
          endLine: 15,
          relationship: 'entrypoint',
          explanation: 'Added route handler passing raw body to auth service',
          tier: 'direct_changed',
        },
        {
          file: 'src/services/auth.ts',
          startLine: 50,
          endLine: 55,
          relationship: 'callee',
          explanation: 'Existing authentication method executing query',
          tier: 'supporting_context',
          causalLink: 'Called by src/api/routes.ts:12 without prior schema validation',
        },
      ],
    });
    const validation = makeValidationResult({
      hasDirectChangedEvidence: true,
      hasSupportingContext: true,
      validEvidence: finding.evidence,
    });

    const result = evaluateFindingGate(finding, validation);
    expect(result.finalDisposition).toBe('blocking');
  });

  it('runDecisionGate partitions findings and returns full decision log', () => {
    const blocking = makeRankedFinding({ id: 'f-1' });
    const preExisting = makeRankedFinding({ id: 'f-2', introducedByPatch: 'pre_existing' });
    const info = makeRankedFinding({ id: 'f-3', category: 'maintainability', severity: 'info' });
    const rejected = makeRankedFinding({ id: 'f-4', criticDecision: 'rejected' });

    const evidenceMap = new Map();
    evidenceMap.set(blocking, makeValidationResult());
    evidenceMap.set(preExisting, makeValidationResult({ hasDirectChangedEvidence: false }));
    evidenceMap.set(info, makeValidationResult());
    evidenceMap.set(rejected, makeValidationResult());

    const result = runDecisionGate([blocking, preExisting, info, rejected], evidenceMap);

    expect(result.blockingFindings).toHaveLength(1);
    expect(result.advisoryFindings).toHaveLength(1);
    expect(result.informationalFindings).toHaveLength(1);
    expect(result.rejectedFindings).toHaveLength(1);
    expect(result.gateDecisions).toHaveLength(4);
    expect(result.byDisposition.blocking).toBe(1);
    expect(result.byDisposition.advisory).toBe(1);
    expect(result.byDisposition.informational).toBe(1);
    expect(result.byDisposition.rejected).toBe(1);
  });
});
