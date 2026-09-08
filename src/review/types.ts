/**
 * Authoritative Layer 5 Review Engine domain models and input contracts.
 */

import type { ReviewConfig } from '../config/schema.js';
import type { ReferenceGraph } from '../intelligence/graph/reference.js';
import type { SymbolIndex } from '../intelligence/index/symbol-index.js';
import type { ReviewContext } from '../intelligence/types.js';
import type { Diagnostic, ModelFinding, ReviewModel } from '../model/types.js';

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingDisposition = 'blocking' | 'advisory' | 'informational' | 'rejected';

export type EvidenceTier =
  | 'direct_changed'
  | 'indirect_context'
  | 'baseline_context'
  | 'supporting_context';

export type PatchAttribution =
  | 'introduced_by_patch'
  | 'worsened_by_patch'
  | 'pre_existing'
  | 'fixed_by_patch'
  | 'unrelated_to_patch'
  | 'unknown';

export type CriticDecision = 'approved' | 'rejected' | 'uncertain';

export interface ReviewerProvenance {
  reviewer: string;
  role: string;
  confidence: number;
  assignedSeverity: ReviewSeverity;
  timestamp: string;
}

export interface GateDecisionLog {
  findingId: string;
  finalDisposition: FindingDisposition;
  modelSuggestedDisposition?: FindingDisposition;
  reasons: string[];
  passedChecks: string[];
  failedChecks: string[];
}

export type FindingCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'architecture'
  | 'reliability'
  | 'maintainability'
  | 'compatibility'
  | 'testing';

/**
 * Breakdown of individual scoring dimensions contributing to composite score.
 */
export interface ScoreBreakdown {
  severityScore: number;
  confidenceScore: number;
  evidenceStrengthScore: number;
  blastRadiusScore: number;
  securityImpactScore: number;
  regressionProbabilityScore: number;
}

/**
 * Enriched finding with composite confidence-weighted score, blast radius,
 * reviewer attribution, and deterministic disposition.
 */
export interface RankedFinding extends ModelFinding {
  /** Deterministic SHA256 identifier (file:startLine:category:title) */
  id: string;
  /** Composite score (0.00 to 100.00) */
  compositeScore: number;
  /** Component scoring breakdown */
  scoreBreakdown: ScoreBreakdown;
  /** Deterministic blast radius (10 to 100) */
  blastRadius: number;
  /** Evidence strength (0 to 100) */
  evidenceStrength: number;
  /** Reviewers that contributed to this finding */
  contributingReviewers: string[];
  /** Concrete claim stated by finding */
  claim: string;
  /** Technical failure mechanism */
  failureMechanism: string;
  /** Specific input condition or execution state */
  trigger: string;
  /** Concrete required fix */
  requiredFix: string;
  /** Suggested disposition by model (optional signal) */
  modelSuggestedDisposition?: FindingDisposition | undefined;
  /** Final deterministic disposition computed by decision gate */
  finalDisposition: FindingDisposition;
  /** Patch attribution relative to baseline */
  introducedByPatch: PatchAttribution;
  /** Critic stage verification outcome */
  criticDecision: CriticDecision;
  /** Critic technical justification */
  criticReason?: string | undefined;
  /** Full reviewer provenance trail */
  provenance: ReviewerProvenance[];
  /** Documented contradictions from static analysis or reviewers */
  contradictions?: string[] | undefined;
  /** Compatibility alias for startLine */
  line?: number | undefined;
}

/**
 * High-level summary metrics for the review run.
 */
export interface ReviewSummary {
  totalFindings: number;
  bySeverity: Record<ReviewSeverity, number>;
  byDisposition?: Record<FindingDisposition, number> | undefined;
  byCategory: Record<FindingCategory, number>;
  byReviewer: Record<string, number>;
  filesAnalyzed: number;
  durationMs: number;
}
/**
 * Stage-by-stage finding counts across the complete review pipeline.
 */
export interface ReviewStageCounts {
  rawStructural: number;
  rawSemantic: number;
  rawSecurity: number;
  preCriticDedup: number;
  criticStage1: number;
  criticStage2: number;
  postCriticConsolidation: number;
  ranked: number;
  final: number;
}

/**
 * Telemetry and provenance metadata for the review execution.
 */
export interface ExecutionMetadata {
  scopeType: string;
  base?: string | undefined;
  head?: string | undefined;
  timestamp: string;
  version: string;
  model: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  warnings: string[];
  reviewersTriggered: string[];
  criticInvoked: boolean;
  preCriticFindingCount: number;
  postCriticFindingCount: number;
  stageCounts?: ReviewStageCounts | undefined;
  timings?: StageTimings | undefined;
  rejectedFindings?: RankedFinding[] | undefined;
  downgradedFindings?: RankedFinding[] | undefined;
  gateDecisions?: GateDecisionLog[] | undefined;
}

/**
 * Stage-by-stage timing metrics in milliseconds.
 */
export interface StageTimings {
  discoveryMs: number;
  parseMs: number;
  symbolsMs: number;
  diagnosticsMs: number;
  contextMs: number;
  modelMs: number;
  totalMs: number;
}

/**
 * Authoritative review result emitted by the Layer 5 Review Engine.
 */
export interface ReviewResult {
  summary: ReviewSummary;
  findings: RankedFinding[];
  metadata: ExecutionMetadata;
}

/**
 * Progress event emitted by the Review Engine across internal execution stages.
 * Structurally decoupled from Layer 6 ReviewProgressEvent.
 */
export interface ReviewStageProgressEvent {
  stage: string;
  status: 'start' | 'progress' | 'complete' | 'error';
  message: string;
  step?: { current: number; total: number } | undefined;
  payload?: Record<string, unknown> | undefined;
}

export type ReviewStageProgressCallback = (event: ReviewStageProgressEvent) => void;

/**
 * Input arguments required to execute the Review Engine.
 */
export interface ReviewEngineInput {
  repoRoot: string;
  diff: string;
  changedFiles: string[];
  reviewContext: ReviewContext;
  referenceGraph: ReferenceGraph;
  symbolIndex: SymbolIndex;
  diagnostics: Diagnostic[];
  model: ReviewModel;
  config?:
    | (Partial<ReviewConfig> & Pick<ReviewConfig, 'severity' | 'maxFindings' | 'minConfidence'>)
    | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ReviewStageProgressCallback | undefined;
  scopeMetadata?:
    | {
        scopeType: string;
        base?: string | undefined;
        head?: string | undefined;
      }
    | undefined;
}
