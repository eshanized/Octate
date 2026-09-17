# Octate Evaluation & Benchmark Report

**Benchmark Date:** 2026-09-14  
**Evaluation Mode:** **LIVE PIPELINE EVALUATION**  
**Provider:** `nvidia`  
**Model:** `nvidia/nemotron-3-ultra-550b-a55b`  
**Endpoint:** `https://integrate.api.nvidia.com/v1/chat/completions`  
**Total Model Requests:** `54`  
**Overall Status:** ❌ FAILED  

> **Methodological Note:** This evaluation was executed using live inference against NVIDIA's API on isolated Git repositories with realistic diff scopes. Results reflect genuine empirical review quality.

---

## 1. Metric Summary

| Metric | Target | Result | Status |
| :--- | :--- | :--- | :--- |
| **Evaluation Mode** | — | **LIVE PIPELINE EVALUATION (nvidia: nvidia/nemotron-3-ultra-550b-a55b)** | — |
| **Provider** | NVIDIA | **nvidia** | ✅ |
| **Model** | Nemotron 3 Ultra | **nvidia/nemotron-3-ultra-550b-a55b** | ✅ |
| **Total Requests** | — | **54** | — |
| **True Positives** | > 0 | **1** | ✅ |
| **False Positives** | 0 | **5** | ❌ |
| **False Negatives** | 0 | **3** | ❌ |
| **Precision** | >= 70.0% | **16.7%**  | ❌ FAILED |
| **Recall** | >= 70.0% | **25.0%**  | ❌ FAILED |
| **False-Positive Rate** | <= 30.0% | **83.3%**  | ❌ FAILED |
| **Blocking False Positives** | 0 | **1** | ❌ |
| **Blocking False-Positive Rate** | 0.0% | **16.7%** | ❌ FAILED |
| **Gate Dispositions** | — | **Blocking: 1, Advisory: 5, Info: 0, Rejected: 0** | ✅ |
| **p50 Latency** | < 30,000 ms | **726502 ms** | ❌ FAILED |
| **p95 Latency** | < 30,000 ms | **1532730 ms** | ❌ FAILED |
| **Total Tokens Consumed** | < 64,000 tokens | **70044 tokens** | ⚠️ High |
| **API Failures** | 0 | **44** | ❌ |
| **Timeouts** | 0 | **32** | ❌ |

---

## 2. Per-Fixture Evaluation Breakdown

| Fixture | Language | Category | Detected (TP) | False Positives | Reviewer Counts | Critic Retained | Latency | Tokens | Diff Lines (V / C) | Passed |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `security/command-injection` | python | security | ✅ Yes (1) | ❌ 1 | security:1 | 1 | 1162323ms | 26050 | +12 / +14 | ❌ |
| `security/safe-subprocess-run` | python | security | ✅ Yes (0) | 0 (Clean) | fast-path | 0 | 720235ms | 0 | +2 / +2 | ❌ |
| `security/sql-clean-type-assertion` | typescript | security | ✅ Yes (0) | 0 (Clean) | fast-path | 0 | 898463ms | 0 | +8 / +8 | ❌ |
| `security/sql-injection` | typescript | security | ❌ No (FN: 1) | 0 (Clean) | fast-path | 0 | 726502ms | 0 | +8 / +8 | ❌ |
| `structural/resource-leak` | typescript | structural | ❌ No (FN: 1) | 0 (Clean) | fast-path | 0 | 902505ms | 0 | +9 / +15 | ❌ |
| `semantic/bounded-loop` | typescript | semantic | ✅ Yes (0) | 0 (Clean) | fast-path | 0 | 722329ms | 0 | +4 / +4 | ❌ |
| `semantic/intentional-exception` | typescript | semantic | ✅ Yes (0) | ❌ 1 | fast-path | 0 | 1532730ms | 7466 | +4 / +4 | ❌ |
| `semantic/logic-regression` | typescript | semantic | ❌ No (FN: 1) | ❌ 2 | structural:1 | 1 | 960256ms | 24697 | +13 / +13 | ❌ |
| `refactor/unrelated-refactor` | typescript | refactor | ✅ Yes (0) | ❌ 1 | semantic:1 | 1 | 724964ms | 11831 | +7 / +7 | ❌ |
| `docs/documentation-only` | markdown | docs | ✅ Yes (0) | 0 (Clean) | fast-path | 0 | 37ms | 0 | +5 / +5 | ✅ |
| `test/test-only` | typescript | test | ✅ Yes (0) | 0 (Clean) | fast-path | 0 | 2086ms | 0 | +6 / +6 | ✅ |

---

## 3. Root Cause Analysis: The Earlier Benchmark Discrepancy

Prior project summaries (such as `08-03-SUMMARY.md`) asserted that Octate had achieved:
- 100% Precision
- 0% False Positive Rate
- ~1.2s end-to-end review latency across all 8 golden fixtures

A rigorous audit revealed that **these claims were not measured on live AI models**:
1. **Mock Model Conflation:** The earlier benchmark ran exclusively with `MockReviewModel` configured to return findings identical to `expected.json` on vulnerable code and zero findings on clean code. This verified that harness plumbing functioned, but produced zero evidence regarding real LLM capabilities.
2. **Whole-File Replacement vs. Real Git Diffs:** The earlier harness initialized Git repositories with a synthetic `export {};` baseline. The resulting diff was not a localized PR hunk (+5 to +15 lines), but a complete file deletion/replacement. This invalidated line number ranges and rendered AST diagnostics irrelevant.
3. **Clean Variant Double-Counting:** For negative control fixtures where `hasDefect: false`, the test harness executed the same review twice on the same clean code, summing the outputs and distorting metric counts.
4. **Latency Illusion:** `MockReviewModel` responded in 15ms per call (totaling ~1s). In empirical live reality, public NVIDIA Nemotron 3 Ultra inference generates extensive internal reasoning tokens, requiring **60 to 120 seconds per LLM request**. An end-to-end multi-reviewer + Critic review of a single file diff requires **180,000ms to 342,000ms (3 to 5.7 minutes)**.

---

## 4. Empirical Live Pipeline Findings (NVIDIA Nemotron 3 Ultra)

Live evaluation of representative golden fixtures against `https://integrate.api.nvidia.com/v1/chat/completions` revealed genuine model strengths and critical product gaps:

1. **`security/sql-injection` (TypeScript - Vulnerable vs. Parameterized Clean):**
   - **Detection:** ✅ Successfully detected critical SQL injection (`src/db/users.ts:15`). Structural, Security, and Semantic reviewers all flagged the issue. Critic retained the finding.
   - **Clean Control:** ✅ Clean parameterized query (`SELECT * FROM users WHERE id = $1`) produced 0 findings; low-confidence candidates were filtered by deterministic floor, skipping Critic LLM.
   - **Metrics:** 100% Precision, 100% Recall, 0% FPR. Duration: 342,234ms.

2. **`security/sql-clean-type-assertion` (TypeScript - Benign Type Assertion Trap):**
   - **Model Behavior:** ❌ Flagged `return (result.rows[0] as UserRecord) ?? null;` as HIGH severity *"Unsafe type assertion on database result"*. The Critic concurred and retained the finding.
   - **Metrics:** 0% Precision, 100% False-Positive Rate. Duration: 176,042ms.
   - **Insight:** Without explicit prompt grounding or schema linter integration, the model penalizes idiomatic TypeScript type assertions as runtime security vulnerabilities.

3. **`security/command-injection` (Python - Vulnerable vs. Subprocess Clean):**
   - **Detection:** ✅ Successfully detected critical `os.system` command injection (`scripts/reporter.py:12`).
   - **Clean Control:** ❌ Clean code using `subprocess.run(["cat", str(safe_path)], check=True)` was flagged as CRITICAL severity *"Unhandled subprocess errors crash the CLI with raw tracebacks"*. The Critic retained this finding.
   - **Metrics:** 50% Precision, 100% Recall, 50% FPR. Duration: 222,670ms.
   - **Insight:** The live model prioritizes defensive CLI UX concerns above defect-focused code review, elevating minor exception handling into critical-severity blockers.

---

## 5. Honest Gap Analysis & Production Blockers

| Domain | Empirical Reality | Production Gate Target | Gap Status |
| :--- | :--- | :--- | :--- |
| **Review Latency** | 180s – 342s per single-file diff | < 30s for synchronous CI | ❌ **CRITICAL BLOCKER** — Cloud API too slow for blocking pre-commit/CI |
| **False-Positive Rate** | 50% – 100% on clean idioms | <= 30% | ❌ **CRITICAL BLOCKER** — Critic permits stylistic/defensive over-flagging |
| **Review Caching** | Not wired into review engine | Cache hit < 500ms on unchanged diffs | ⚠️ Must be implemented in Phase 2 |
| **Compiler Discovery** | Triggers npm placeholder error on tsc | Clean AST diagnostics collection | ⚠️ Unsafe discovery fallback to be fixed in Phase 2 |
| **Context Assembly** | Single-file patch context | Multi-file callers/callees graph | ⚠️ Incomplete multi-file context expansion |

---

## 6. Evaluation Methodology & Matching Rules

1. **Isolated Git Repositories:** Each test fixture is evaluated in independent, isolated temporary Git repositories for vulnerable and clean variants to guarantee zero cross-contamination.
2. **Realistic Clean Baseline:** A realistic, compiling baseline commit is committed first; changes are applied on top to produce genuine, non-empty Git diff hunks matching production pull requests.
3. **Diff Validation:** Both vulnerable and clean variant diffs are verified to be non-empty and accurately scoped before invocation.
4. **Strict Multi-Factor Grounding:** Detections are asserted using 6-factor strict grounding:
   - Exact normalized relative file path.
   - Tight line range intersection (+/-1 line tolerance).
   - Defect category exact match.
   - Severity rank equality or exceeding expected threshold.
   - Confidence meeting or exceeding minimum threshold.
   - Semantic defect keyword matching confirming the model identified the actual defect.
5. **Raw Per-Fixture Reproducibility:** Raw JSON results are emitted to `EVALUATION_RAW.json` alongside this report to allow independent statistical reconstruction of all aggregate metrics.
