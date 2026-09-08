/**
 * Final Deterministic Decision Gate for Review Findings.
 *
 * Implements the 11 strict blocking conditions to ensure that AI models have zero
 * unilateral authority to block merges. Every candidate finding must pass all 11
 * deterministic checks to receive a 'blocking' disposition.
 *
 * Findings that fail attribution or reachability are downgraded to 'advisory'.
 * Style/maintainability findings become 'informational'.
 * Fabricated, disproven, or empty findings are 'rejected' and excluded from user output.
 */

import { createLogger } from '../logging/index.js';
import type { ModelFinding } from '../model/types.js';
import type { EvidenceValidationResult } from './evidence-validator.js';
import type { FindingDisposition, GateDecisionLog, RankedFinding } from './types.js';

const log = createLogger('review/decision-gate');

const GENERIC_MECHANISMS = [
  'potential issue',
  'might fail',
  'could cause an error',
  'bug',
  'error',
  'todo',
  'unspecified',
  'unknown',
  'may have problems',
  'needs review',
  'be careful',
];

const GENERIC_TRIGGERS = [
  'any input',
  'bad data',
  'invalid input',
  'user input',
  'unknown',
  'unexpected value',
  'hypothetical input',
  'edge case',
  'n/a',
  'none',
];

const COSMETIC_OR_STYLE_CATEGORIES = new Set(['maintainability', 'testing']);

const SPECULATIVE_PHRASES = [
  'what if',
  'could theoretically',
  'hypothetically',
  'in some rare future',
  'might possibly in the future',
  'speculative',
];

export interface DecisionGateOptions {
  minConfidence?: number | undefined;
  strictMode?: boolean | undefined;
}

export interface GateEvaluation {
  finalDisposition: FindingDisposition;
  decisionLog: GateDecisionLog;
  downgraded: boolean;
}

export interface DecisionGateResult {
  survivingFindings: RankedFinding[];
  blockingFindings: RankedFinding[];
  advisoryFindings: RankedFinding[];
  informationalFindings: RankedFinding[];
  rejectedFindings: RankedFinding[];
  downgradedFindings: RankedFinding[];
  gateDecisions: GateDecisionLog[];
  byDisposition: Record<FindingDisposition, number>;
}

/**
 * Checks whether a string contains a generic or placeholder text.
 */
function isGenericText(text: string | undefined, genericList: string[]): boolean {
  if (!text) return true;
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length < 5) return true;
  return genericList.some((g) => trimmed === g || trimmed.startsWith(`${g}:`) || trimmed.startsWith(`${g} `));
}

/**
 * Checks whether text contains speculative hypothetical phrasing without concrete mechanics.
 */
function isSpeculativeText(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return SPECULATIVE_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Evaluates a single candidate finding against the 11 strict blocking conditions.
 */
export function evaluateFindingGate(
  finding: RankedFinding,
  evidenceValidation: EvidenceValidationResult,
  options?: DecisionGateOptions
): GateEvaluation {
  const minConfidence = options?.minConfidence ?? 0.6;
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const reasons: string[] = [];

  const findingId = finding.id || `${finding.file}:${finding.startLine}:${finding.category}:${finding.title}`;
  const suggestedDisposition = finding.modelSuggestedDisposition;

  // 1. Changed code relevance
  const hasDiffRelevance =
    evidenceValidation.hasDirectChangedEvidence ||
    (finding.introducedByPatch === 'introduced_by_patch' || finding.introducedByPatch === 'worsened_by_patch');
  if (hasDiffRelevance) {
    passedChecks.push('changedCodeRelevance');
  } else {
    failedChecks.push('changedCodeRelevance');
    reasons.push('Finding does not target or causally stem from changed code in the patch');
  }

  // 2. Evidence validity
  const evidenceAnchorValid =
    evidenceValidation.isValid ||
    (evidenceValidation.validEvidence.length > 0 && evidenceValidation.invalidEvidence.length === 0);
  if (evidenceAnchorValid) {
    passedChecks.push('evidenceValid');
  } else {
    failedChecks.push('evidenceValid');
    reasons.push(
      `Evidence validation failed: ${evidenceValidation.issues.join('; ') || 'invalid or missing evidence anchors'}`
    );
  }

  // 3. Concrete failure mechanism
  const rawMechanism = finding.failureMechanism ?? finding.impact ?? finding.message;
  const mechanismValid = !isGenericText(rawMechanism, GENERIC_MECHANISMS) && rawMechanism.length >= 10;
  if (mechanismValid) {
    passedChecks.push('concreteFailureMechanism');
  } else {
    failedChecks.push('concreteFailureMechanism');
    reasons.push('Failure mechanism is missing, too brief, or generic');
  }

  // 4. Credible trigger
  const rawTrigger = finding.trigger ?? finding.message;
  const triggerValid =
    !isGenericText(rawTrigger, GENERIC_TRIGGERS) &&
    !isSpeculativeText(finding.trigger) &&
    rawTrigger.length >= 6;
  if (triggerValid) {
    passedChecks.push('credibleTrigger');
  } else {
    failedChecks.push('credibleTrigger');
    reasons.push('Trigger condition is speculative, missing, or generic');
  }

  // 5. Reachable execution path
  const executionPathPlausible =
    !isSpeculativeText(finding.message) &&
    (finding.evidence.length > 0 || finding.startLine > 0);
  if (executionPathPlausible) {
    passedChecks.push('reachableExecutionPath');
  } else {
    failedChecks.push('reachableExecutionPath');
    reasons.push('Execution path is purely theoretical or unreachable in practice');
  }

  // 6. Material impact
  const isMaterial =
    !COSMETIC_OR_STYLE_CATEGORIES.has(finding.category) &&
    finding.severity !== 'info' &&
    !finding.title.toLowerCase().includes('style preference') &&
    !finding.title.toLowerCase().includes('docstring');
  if (isMaterial) {
    passedChecks.push('materialImpact');
  } else {
    failedChecks.push('materialImpact');
    reasons.push('Impact is cosmetic, stylistic, or non-material');
  }

  // 7. Justified severity
  const severityJustified =
    finding.severity !== 'critical' ||
    finding.category === 'security' ||
    finding.category === 'correctness' ||
    finding.category === 'reliability';
  if (severityJustified) {
    passedChecks.push('justifiedSeverity');
  } else {
    failedChecks.push('justifiedSeverity');
    reasons.push(`Severity "${finding.severity}" is not justified for category "${finding.category}"`);
  }

  // 8. Acceptable confidence
  if (finding.confidence >= minConfidence) {
    passedChecks.push('acceptableConfidence');
  } else {
    failedChecks.push('acceptableConfidence');
    reasons.push(`Model confidence ${finding.confidence} is below minimum threshold ${minConfidence}`);
  }

  // 9. Patch attribution (pre-existing code CANNOT block)
  const attribution = finding.introducedByPatch ?? 'unknown';
  const isIntroducedOrWorsened =
    attribution === 'introduced_by_patch' ||
    attribution === 'worsened_by_patch' ||
    (attribution === 'unknown' && evidenceValidation.hasDirectChangedEvidence);
  if (isIntroducedOrWorsened) {
    passedChecks.push('patchAttribution');
  } else {
    failedChecks.push('patchAttribution');
    reasons.push(`Patch attribution is "${attribution}" (pre-existing or unrelated code cannot block merges)`);
  }

  // 10. Critic decision
  const criticOutcome = finding.criticDecision ?? 'approved';
  if (criticOutcome === 'approved') {
    passedChecks.push('criticDecision');
  } else {
    failedChecks.push('criticDecision');
    reasons.push(`Critic stage decision is "${criticOutcome}"`);
  }

  // 11. No strong contradiction
  const hasNoContradictions = !finding.contradictions || finding.contradictions.length === 0;
  if (hasNoContradictions) {
    passedChecks.push('noStrongContradiction');
  } else {
    failedChecks.push('noStrongContradiction');
    reasons.push(`Contradictions detected: ${finding.contradictions?.join('; ')}`);
  }

  // Compute final disposition
  let finalDisposition: FindingDisposition;

  // Immediate REJECTION criteria:
  // - Critic explicitly rejected
  // - Severe evidence fabrication (e.g. non-existent file or out-of-bounds lines)
  // - Disproven by strong contradiction with no surviving evidence
  const hasSevereFabrication =
    evidenceValidation.invalidEvidence.some(
      (e) => e.reason.includes('does not exist') || e.reason.includes('exceeds total lines')
    );

  if (
    criticOutcome === 'rejected' ||
    hasSevereFabrication ||
    (finding.contradictions && finding.contradictions.length > 0 && evidenceValidation.evidenceStrength < 30)
  ) {
    finalDisposition = 'rejected';
  } else if (failedChecks.length === 0) {
    // Passed all 11 conditions
    finalDisposition = 'blocking';
  } else if (
    COSMETIC_OR_STYLE_CATEGORIES.has(finding.category) ||
    finding.severity === 'info' ||
    finding.category === 'maintainability'
  ) {
    finalDisposition = 'informational';
  } else {
    // Valuable observation but not eligible to block merge
    finalDisposition = 'advisory';
  }

  const downgraded =
    (suggestedDisposition === 'blocking' || finding.severity === 'critical' || finding.severity === 'high') &&
    finalDisposition !== 'blocking' &&
    finalDisposition !== 'rejected';

  const decisionLog: GateDecisionLog = {
    findingId,
    finalDisposition,
    modelSuggestedDisposition: suggestedDisposition,
    reasons,
    passedChecks,
    failedChecks,
  };

  return {
    finalDisposition,
    decisionLog,
    downgraded,
  };
}

/**
 * Runs the Deterministic Decision Gate on a list of ranked findings.
 */
export function runDecisionGate(
  findings: RankedFinding[],
  evidenceResults: Map<ModelFinding, EvidenceValidationResult>,
  options?: DecisionGateOptions
): DecisionGateResult {
  const blockingFindings: RankedFinding[] = [];
  const advisoryFindings: RankedFinding[] = [];
  const informationalFindings: RankedFinding[] = [];
  const rejectedFindings: RankedFinding[] = [];
  const downgradedFindings: RankedFinding[] = [];
  const gateDecisions: GateDecisionLog[] = [];

  const byDisposition: Record<FindingDisposition, number> = {
    blocking: 0,
    advisory: 0,
    informational: 0,
    rejected: 0,
  };

  const survivingFindings: RankedFinding[] = [];

  for (const finding of findings) {
    const evidenceValidation = evidenceResults.get(finding) ?? {
      isValid: true,
      evidenceStrength: 75,
      hasDirectChangedEvidence: true,
      hasSupportingContext: false,
      validatedItems: [],
      validEvidence: finding.evidence,
      invalidEvidence: [],
      issues: [],
    };

    const evaluation = evaluateFindingGate(finding, evidenceValidation, options);
    finding.finalDisposition = evaluation.finalDisposition;
    gateDecisions.push(evaluation.decisionLog);
    byDisposition[evaluation.finalDisposition]++;

    if (evaluation.downgraded) {
      downgradedFindings.push(finding);
    }

    switch (evaluation.finalDisposition) {
      case 'blocking':
        blockingFindings.push(finding);
        survivingFindings.push(finding);
        break;
      case 'advisory':
        advisoryFindings.push(finding);
        survivingFindings.push(finding);
        break;
      case 'informational':
        informationalFindings.push(finding);
        survivingFindings.push(finding);
        break;
      case 'rejected':
        rejectedFindings.push(finding);
        break;
    }
  }

  log.info(
    {
      total: findings.length,
      blocking: blockingFindings.length,
      advisory: advisoryFindings.length,
      informational: informationalFindings.length,
      rejected: rejectedFindings.length,
      downgraded: downgradedFindings.length,
    },
    'Deterministic Decision Gate evaluation completed'
  );

  return {
    survivingFindings,
    blockingFindings,
    advisoryFindings,
    informationalFindings,
    rejectedFindings,
    downgradedFindings,
    gateDecisions,
    byDisposition,
  };
}
