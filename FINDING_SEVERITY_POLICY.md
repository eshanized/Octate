# Finding Severity & Disposition Policy Specification

**Version:** 1.0.0  
**Status:** Approved Policy  
**Effective Date:** 2026-09-14  
**Applies to:** Octate Review Engine, Decision Gate, Policy Evaluator, CLI, and Renderers

---

## 1. Core Principle: Decoupling Severity from Disposition

Octate enforces a strict separation between **technical severity** and **operational disposition**:
- **Severity** (`critical`, `high`, `medium`, `low`, `info`) measures the intrinsic technical or security magnitude of a theoretical defect.
- **Disposition** (`BLOCKING`, `ADVISORY`, `INFORMATIONAL`, `REJECTED`) determines what workflow action is taken, specifically whether the finding can block code merges or fail CI pipelines.

> [!IMPORTANT]
> **Deterministic Gate Authority:**  
> AI models may propose a suggested disposition (`modelSuggestedDisposition`), but the model possesses **zero authority** to unilaterally block a merge. The operational `finalDisposition` is strictly calculated by Octate's deterministic decision gate immediately before output.

```
┌──────────────────────────────────────────────────────────┐
│ Technical Severity                                       │
│ (Intrinsic defect impact if triggered: critical .. info) │
└────────────────────────────┬─────────────────────────────┘
                             │ + Evidence Validation
                             │ + Concrete Failure Mechanism
                             │ + Reachable Trigger Verification
                             │ + Patch Attribution (introduced/worsened)
                             │ + Adversarial Critic Approval
                             │ + No Strong Contradiction
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Operational Disposition                                  │
│ ├── BLOCKING      (Fails CI / blocks merge)             │
│ ├── ADVISORY      (Visible guidance; never blocks merge)│
│ ├── INFORMATIONAL (Style / maintainability notes)        │
│ └── REJECTED      (Filtered out; stored in audit trail) │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Classification Levels

### 2.1 Technical Severity Levels

| Severity | Definition | Examples |
| :--- | :--- | :--- |
| **`critical`** | Direct, unmitigated remote compromise, arbitrary code execution, catastrophic data loss, or systemic crash with immediate impact. | Remote Command Injection (`os.system`), Unparameterized SQL Injection (`db.query(f"...")`), Authentication Bypass, Uncontrolled Memory/Resource Depletion. |
| **`high`** | Severe security flaw or fatal runtime exception occurring under common operational flows, requiring prerequisite state. | Stored XSS, SSRF without direct egress filter, unhandled promise rejection crashing the main Node event loop, invalid transaction rollback. |
| **`medium`** | Defects causing degraded performance, edge-case incorrect calculations, broken secondary workflows, or leaky abstractions. | Logic regressions on boundary conditions, unindexed quadratic lookup, missing null check on nullable return. |
| **`low`** | Minor behavioral defects, non-fatal resource leaks, or edge-case inconsistencies that do not impact user availability. | Redundant database queries, unclosed ephemeral file handle in short-lived script, improper HTTP status code on client error. |
| **`info`** | Code health, maintainability, architectural observations, or documentation discrepancies. | Misleading comments, deprecated library usage without immediate security risk, dead private code. |

---

### 2.2 Operational Disposition Levels

| Disposition | Meaning | CI Impact | Filtered from Output? |
| :--- | :--- | :--- | :--- |
| **`BLOCKING`** | Fully verified, patch-introduced defect with proven reachable trigger and material harm. | **Fails CI (Exit Code 1)** if severity meets `--fail-on` threshold. | No. Emitted prominently with blocking badges. |
| **`ADVISORY`** | Real observation, potential risk, or pre-existing vulnerability lacking immediate exploitability or introduced status. | **Passes CI (Exit Code 0)**. Never blocks merges. | No. Displayed as actionable developer guidance. |
| **`INFORMATIONAL`** | Style, maintainability, or best-practice suggestion without operational risk. | **Passes CI (Exit Code 0)**. Never blocks merges. | Displayed in standard console/TUI, hidden in quiet mode. |
| **`REJECTED`** | Ungrounded, stale, fabricated, generic, disproven, or benign safe-idiom finding. | **Passes CI (Exit Code 0)**. | **Yes.** Stripped from primary findings; recorded in `metadata.rejectedFindings` for audit. |

---

## 3. Strict Blocking Requirements

A finding receives `finalDisposition: 'blocking'` **if and only if all 11 of the following conditions are true**:

1. **Changed-Code Relevance:** The defect directly targets code modified in the diff under review, or causally originates from modified lines.
2. **Valid Evidence:** All primary evidence anchors are verified against repository disk state (file exists, line numbers within file bounds, referenced code matches revision tokens).
3. **Concrete Failure Mechanism:** The finding provides a technically specific, non-generic explanation of how the failure occurs (no hand-waving or speculative "what-if" abstractions).
4. **Credible Trigger:** The finding identifies a specific, realistic input, state transition, or execution condition that activates the defect.
5. **Reachable Execution Path:** The execution path connecting the trigger to the vulnerable sink is plausible and reachable in standard or hostile execution environments.
6. **Material Impact:** Demonstrates tangible security compromise, data corruption, process termination, or severe behavioral regression.
7. **Justified Severity:** The technical severity rank is proportional to the proven impact.
8. **Acceptable Confidence:** The model's confidence meets or exceeds the configured threshold (`minConfidence >= 0.60`). *Note: High confidence is a prerequisite, but never constitutes proof on its own.*
9. **Patch Attribution:** The defect is classified as `introduced_by_patch` or `worsened_by_patch`. Pre-existing code **CANNOT** block.
10. **Critic Approval:** The adversarial Critic stage evaluated the finding and returned `criticDecision: 'approved'`.
11. **No Strong Contradiction:** Static analysis diagnostics, compiler outputs, or reviewer checks have not demonstrated that the pattern is safe or already guarded.

If **any** condition fails:
- If the finding contains useful insights but fails reachability, attribution, or complete proof $\to$ **`ADVISORY`**.
- If the finding is purely stylistic, pedantic, or cosmetic $\to$ **`INFORMATIONAL`**.
- If the finding has invalid evidence, fabricated paths, generic complaints, or describes a safe idiom $\to$ **`REJECTED`**.

---

## 4. Evidence Classification & Unchanged Code Rules

Evidence references are classified into four distinct tiers:

1. **`direct_changed`:** Line ranges directly intersecting modified unified diff hunks (`+` added or modified lines).
2. **`indirect_context`:** Line ranges within a changed file that fall outside modified hunks (e.g. enclosing class, imports, or local callers).
3. **`baseline_context`:** Line ranges representing the pre-patch state of the changed file in the base revision.
4. **`supporting_context`:** Line ranges in **unchanged files** (e.g. authentication middleware, database schemas, external helper functions, route definitions).

### Rule on Unchanged Supporting Context
Evidence from unchanged files (`supporting_context`) **is valid and MUST NOT be dropped**, provided that:
- The finding provides a documented causal link (`causalLink` or `relationship`) demonstrating how the changed code interfaces with the unchanged context.
- The unchanged file exists on disk at the specified revision and line range.

---

## 5. Baseline Attribution Policy

Every candidate finding is attributed to one of six categories:

| Attribution | Criteria | Blocking Eligibility |
| :--- | :--- | :--- |
| **`introduced_by_patch`** | The defect exists in newly added or modified lines. | **Eligible for BLOCKING** |
| **`worsened_by_patch`** | The patch modifies an existing component, expanding vulnerability surface or removing a guard. | **Eligible for BLOCKING** |
| **`pre_existing`** | The defect existed in base code before the patch and was not altered by the patch. | **ADVISORY only** (Never blocks) |
| **`fixed_by_patch`** | The patch remediates a previously existing defect. | **INFORMATIONAL only** |
| **`unrelated_to_patch`** | The defect is in an untouched file or module with no causal dependency. | **REJECTED** |
| **`unknown`** | Attribution cannot be established with confidence. | **ADVISORY or REJECTED** (Never blocks) |

---

## 6. Contextual Semantic Evaluation for Common Idioms

Octate rejects simplistic, hard-coded regex bypasses in favor of **contextual semantic analysis**:

### 6.1 TypeScript Type Assertions (`as Type`)
- **Policy:** A type assertion is not defective solely because it is a type assertion.
- **Contextual Signals:**
  - Query parameterization: Does the query use prepared statements preventing SQL injection?
  - Null guards: Does code verify `result.rows[0]` before accessing properties?
  - Downstream sinks: Does the cast value flow into sensitive sinks (e.g., dynamic code execution, raw shell commands, authorization bypass)?
- **Disposition:** A type assertion on database rows or external API payloads with parameterization and null checks is a standard TypeScript idiom and receives **`ADVISORY`** (e.g., recommending schema validation like Zod as a maintainability suggestion) or **`REJECTED`**, and **NEVER `BLOCKING`**.

### 6.2 Subprocess Execution (`subprocess.run`)
- **Policy:** Calling `subprocess.run` with list arguments (`shell=False`) reduces command-injection risk, but does not guarantee total safety.
- **Contextual Signals:**
  - Argument construction: Are arguments fixed strings or sanitized paths versus raw user concatenations?
  - Executable path: Is the executable binary hardcoded/whitelisted or user-controlled?
  - Privilege context: Does the command execute with elevated (root/admin) privileges?
  - Error handling: Does `check=True` intentionally propagate exceptions, or does failure create security bypass?
- **Disposition:** Safe list execution with hardcoded binaries and sanitized paths is **NOT** a critical command injection. Missing try/except error wrappers are reliability advisories at most and **NEVER `BLOCKING`**.

---

## 7. Auditability & Diagnostic Channels

To maintain complete observability without polluting standard developer output:
- **`result.findings`:** Contains only actionable findings (`BLOCKING`, `ADVISORY`, `INFORMATIONAL`).
- **`result.metadata.rejectedFindings`:** Full diagnostic record of all candidate findings rejected by deterministic gates or the Critic.
- **`result.metadata.downgradedFindings`:** Findings where the model suggested `BLOCKING`, but the deterministic gate downgraded to `ADVISORY` or `INFORMATIONAL`.
- **`result.metadata.gateDecisions`:** Step-by-step decision log recording which of the 11 checks passed or failed for each finding.
- **Secret Sanitization:** All diagnostic output automatically strips sensitive credentials, tokens, and raw secrets.
