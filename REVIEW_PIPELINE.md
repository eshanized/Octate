# Octate Review Pipeline Architecture

## 1. Pipeline Overview

Octate processes pull requests and local working tree diffs through an end-to-end multi-stage pipeline designed around a foundational principle:
> **AI models are hypothesis generators, not judges. Final blocking authority belongs strictly to deterministic verification.**

```mermaid
flowchart TD
    Diff[Git Diff & Changed Files]
    --> DAG[Stage 1: Review DAG\nStructural, Semantic, Security, Diagnostics]
    --> PreDedup[Stage 2: Model Normalization & Pre-Critic Dedup]
    --> EV1[Stage 2B: Deterministic Evidence Validation (Pass 1)]
    --> SemAttr[Stage 2C: Semantic Patterns & Patch Attribution]
    --> CriticA[Stage 3A: Deterministic Hard Floor\nGrounding, Line Bounds, Safe Idioms]
    --> CriticB[Stage 3B: Adversarial Critic Model\n10 Structured Skeptical Questions]
    --> PostCons[Stage 4: Post-Critic Consolidation & Reconciliation]
    --> Rank[Stage 5: Composite Multi-Factor Ranking]
    --> EV2[Stage 5B: Deterministic Evidence Validation (Pass 2)]
    --> Gate[Stage 6: Deterministic Decision Gate\n11-Condition Verification]
    --> Policy[Stage 7: Policy & Exit Code Engine\nisBlockingFinding => exit 1]
    --> Output[Renderers: Console, JSON, SARIF, TUI]
```

---

## 2. Pipeline Stages

### Stage 1 — Review DAG Scheduling
- **Fast Path:** For diffs consisting entirely of documentation (`.md`, `.txt`, `.rst`) or test files (`.test.ts`, `_test.py`), heavy model reviewers are bypassed.
- **Reviewer Selection:** Selects structural, semantic, and security review roles based on changed file extensions and modified symbols.
- **Context Gathering:** Enriches diff with repository symbol indexes, call-graph relationships, and static linter diagnostics.

### Stage 2 & 2B — Pre-Critic Deduplication & Evidence Validation (Pass 1)
- **Normalization:** Enforces strict JSON schemas for untrusted model outputs, stripping prompt injection markers and invalid characters.
- **Pass 1 Evidence Validation:**
  - Validates that every evidence file exists in the repository or working tree.
  - Verifies start and end line bounds against real file line counts.
  - Classifies evidence into the 4 Canonical Evidence Tiers.
  - Redacts potential credential tokens and API secrets from evidence explanations.
  - Drops findings whose evidence points to non-existent files or invalid line bounds.

### Stage 2C — Context-Aware Semantic Analysis & Patch Attribution
- **Semantic Patterns (`src/analysis/semantic-patterns.ts`):**
  - Analyzes TypeScript type assertions (`x as T`) for downstream dangerous sinks (`eval`, `innerHTML`) vs. benign parameterized data access.
  - Analyzes Python subprocess invocations for `shell=True` and string interpolation vs. safe list argument execution.
  - Recognizes safe control flow idioms: bounded loops and intentional domain exceptions (`throw new NotFoundError()`).
- **Patch Attribution (`src/review/attribution.ts`):**
  - Compares finding line ranges against git diff added and deleted ranges.
  - Categorizes findings into: `introduced_by_patch`, `worsened_by_patch`, `pre_existing`, `fixed_by_patch`, `unrelated_to_patch`, or `unknown`.

### Stage 3 — Two-Stage Adversarial Critic
- **Stage 3A (Deterministic Hard Floor):**
  - Rejects findings lacking evidence or below minimum confidence thresholds.
  - Filters out ungrounded findings that refer to symbols or lines not present in the repository.
  - Filters out known benign or speculative patterns via `isBenignOrSpeculative()`.
  - If 0 candidates survive, the expensive Critic LLM call is bypassed completely.
- **Stage 3B (Adversarial LLM Inquest):**
  - Challenges each surviving finding against **10 adversarial questions**:
    1. *Exact failure mechanism:* What precise runtime exception occurs?
    2. *Reachable trigger:* What specific external input or caller triggers it?
    3. *Execution path:* Is there an unbroken execution path from entry to sink?
    4. *Counter-evidence:* Does surrounding context (guards, types, middleware) prevent it?
    5. *Patch introduction:* Was this defect introduced/worsened by this patch?
    6. *Impact materiality:* Does this represent real harm vs. theoretical pedantry?
    7. *Severity calibration:* Is the severity rating justified?
    8. *Actionable fix:* Does the suggested fix provide concrete code?
    9. *Pre-existing debt:* Is this legacy code that should not block this PR?
    10. *Skeptical verdict:* Should this finding be approved, rejected, or uncertain?

### Stage 4 & 5 — Consolidation & Composite Ranking
- **Post-Critic Consolidation:** Merges findings from multiple reviewers targeting the same issue, preserving contributing reviewer provenance.
- **Composite Scoring:** Calculates 0–100 composite ranking scores based on severity (40%), model confidence (25%), blast radius (20%), and evidence strength (15%).

### Stage 5B — Evidence Validation (Pass 2)
- Re-verifies all evidence items after consolidation and deduplication to ensure no fabricated references or mutated line bounds were introduced during ranking.

### Stage 6 — Deterministic Decision Gate
- Evaluates **all 11 mandatory blocking conditions** independently of model preference.
- Decouples `modelSuggestedDisposition` from `finalDisposition`.
- Only findings where **all 11 checks pass** receive `finalDisposition: 'blocking'`.
- All other valid findings are assigned `advisory` or `informational`.
- Invalid or unverified findings are marked `rejected` and moved to `result.metadata.rejectedFindings`.

### Stage 7 — Policy Evaluation & Output
- **Policy Engine (`src/application/policy.ts`):**
  - Enforces `isBlockingFinding(finding, threshold)`.
  - A finding fails CI **only if** `finding.finalDisposition === 'blocking' && findingLevel >= thresholdLevel`.
- **Output Renderers:** Emits formatted results to terminal console, JSON, SARIF (for GitHub Code Scanning), and Ink interactive TUI.

---

## 3. The 4 Canonical Evidence Tiers

Evidence is classified into four distinct tiers to support multi-file reasoning while rejecting speculative claims:

| Tier | Name | Definition | Blocking Authority |
| :--- | :--- | :--- | :---: |
| **Tier 1** | `direct_changed` | Lines modified directly within git diff added hunks. | Full |
| **Tier 2** | `indirect_context` | Lines in modified files outside immediate hunks (e.g. enclosing function, class definition, imports). | Full |
| **Tier 3** | `baseline_context` | Unchanged baseline revision state of the changed file prior to patch application. | Full (for regression proof) |
| **Tier 4** | `supporting_context` | Unchanged files (e.g. auth middleware, database schema, caller definitions) that establish a documented causal link. | Advisory / Supporting |

---

## 4. The 11 Mandatory Blocking Conditions

For a finding to receive `finalDisposition: 'blocking'`, all 11 conditions must evaluate to `true`:

1. **`changedCodeRelevance`**: The finding targets code modified in the patch or demonstrates causal impact from changed lines.
2. **`validEvidence`**: Evidence passes deterministic validation (existing files, within line bounds, classified into valid tiers).
3. **`concreteFailureMechanism`**: Finding states a concrete technical failure mechanism (e.g. null dereference, buffer overflow, SQL syntax error), not generic risk.
4. **`credibleTrigger`**: Finding specifies a credible external trigger condition or caller state.
5. **`reachableExecutionPath`**: Finding demonstrates an unbroken execution path from entry to defect.
6. **`materialImpact`**: Finding demonstrates security, correctness, or data corruption harm rather than cosmetic style nits.
7. **`justifiedSeverity`**: Severity matches objective criteria (e.g., info/low cannot block; critical/high requires severe impact).
8. **`acceptableConfidence`**: Confidence score meets minimum policy floor ($\ge 0.70$).
9. **`patchAttribution`**: Defect is `introduced_by_patch` or `worsened_by_patch`. Pre-existing debt cannot block.
10. **`criticApproval`**: Critic stage returned `criticDecision === 'approved'`.
11. **`noStrongContradiction`**: No static linter, compiler error, or test result contradicts the finding.

If any check fails, the decision gate logs the specific failed checks and downgrades the finding to `advisory` or `informational`.

---

## 5. Diagnostic Transparency & Metadata

Octate preserves complete audit trails for every review run in `reviewResult.metadata`:
- **`gateDecisions`**: Complete list of gate evaluations with condition status and downgrade reasons.
- **`downgradedFindings`**: Findings that were downgraded from high severity to advisory dispositions with rationale.
- **`rejectedFindings`**: Candidates rejected during evidence validation or critic hard floors.
- **`stageCounts`**: Exact finding counts entering and exiting each pipeline stage.
- **`timings`**: Millisecond latencies for each review phase.
