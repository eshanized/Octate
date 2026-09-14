# Testing Patterns

**Analysis Date:** 2026-09-14

## Test Framework

**Runner:**
- Jest 30.5.1 with `ts-jest` 29.4.12 (ESM preset).
- Configuration: `jest.config.ts`.
- Runtime Options: Native ES modules enabled via `NODE_OPTIONS=--experimental-vm-modules`.
- TypeScript Transform: `ts-jest` targeting `tsconfig.json` with `useESM: true`.

**Assertion Library:**
- `@jest/globals` (`describe`, `it`, `expect`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll`, `jest`).

**Run Commands:**
```bash
pnpm test                               # Run full test suite (81 test suites, 947 tests)
pnpm test:watch                         # Run tests in interactive watch mode
pnpm test -- src/review/engine.test.ts  # Run single test file
NODE_OPTIONS=--experimental-vm-modules npx jest src/renderers/   # Run specific directory
pnpm test -- --coverage                 # Generate coverage report in coverage/
pnpm typecheck                          # Verify TypeScript types without emitting code
pnpm bench                              # Run micro-benchmarks via tsx scripts/bench.ts
tsx benchmark/evaluate.ts               # Run empirical benchmark precision/recall evaluation
```

**Test Suite Health:**
- **81 test suites**, **947 tests**, 0 snapshots.
- **100% passing rate** across all layers (CLI, commands, application, review engine, renderers, diagnostics, intelligence, model, repository, cache, config, logging, cancellation, and stress suites).

## Test File Organization

**1. Co-Located Unit & Component Tests:**
Every source module has its corresponding unit test file directly beside it:
- `src/cli.ts` → `src/cli.test.ts`
- `src/commands/review.ts` → `src/commands/review.test.ts`
- `src/application/review.ts` → `src/application/review.test.ts`
- `src/application/policy.ts` → `src/application/policy.test.ts`
- `src/renderers/tui/app.tsx` → `src/renderers/tui/components.test.tsx`
- `src/renderers/sarif.ts` → `src/renderers/sarif.test.ts`
- `src/review/evidence-validator.ts` → `src/review/evidence-validator.test.ts`
- `src/review/decision-gate.ts` → `src/review/decision-gate.test.ts`

**2. Stress Tests (`test/stress/`):**
Dedicated stress tests verifying stability under load and large repository conditions:
- `repository-git.stress.test.ts`: High commit count & large tree traversal.
- `parser-security.stress.test.ts`: Deeply nested ASTs and malformed files.
- `context-review-pipeline.stress.test.ts`: Large diff token windowing and budget limits.
- `model-cli.stress.test.ts`: Concurrent model requests and cancellation handling.
- `cache-fuzz.stress.test.ts`: High-concurrency atomic writes and LRU evictions.

**3. False-Positive Reproduction Suite (`test/reproduction/`):**
- `false-positives.test.ts`: Direct reproduction tests for known false-positive traps (safe type assertions, intentional error throwing, bounded loops, safe subprocess execution).

**4. Empirical Evaluation Harness (`test/evaluation/` & `benchmark/`):**
- `test/evaluation/evaluation.test.ts`: Validates precision, recall, and false-positive rate calculations.
- `test/evaluation/benchmark-repo.test.ts`: Evaluates end-to-end review accuracy on synthetic benchmark fixtures.
- `benchmark/evaluate.ts`: CLI evaluation harness comparing model output against `benchmark/expected-findings.json`.

**5. Golden Test Fixtures (`test/fixtures/golden/`):**
Structured test cases with 4 canonical files:
- `baseline.ts`: Base version of the file.
- `vulnerable.ts`: Modified version containing an intentional defect.
- `clean.ts`: Modified version implementing a safe idiom or clean fix.
- `expected.json`: Ground-truth expectation verifying whether a finding should or should not trigger.
Categories covered: `security/`, `structural/`, `semantic/`, `refactor/`, `docs/`, `test/`.

## Test Structure & Patterns

**Standard Suite Structure:**
```typescript
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('EvidenceValidator', () => {
  let validator: EvidenceValidator;

  beforeEach(() => {
    validator = new EvidenceValidator();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('classifies compiler diagnostic corroboration as Tier 1', async () => {
    // Arrange
    const finding = createSampleFinding();
    const diagnostics = [createSampleDiagnostic()];

    // Act
    const result = await validator.validate(finding, diagnostics);

    // Assert
    expect(result.tier).toBe('TIER_1_DIAGNOSTIC');
    expect(result.verified).toBe(true);
  });
});
```

**Testing Ink TUI Components:**
- React/Ink components are tested using `@jest/globals` and Ink's test rendering primitives to verify layout, color rendering, and keyboard event dispatch without requiring a real TTY.

## Mocking & Isolation

**1. Mock AI Model Provider (`MockReviewModel`):**
- Located in `src/review/__tests__/mocks.ts` and `src/application/__tests__/mocks.ts`.
- Implements `ReviewModel` abstraction (`generate(request)`).
- Allows test suites to configure deterministic findings, simulate slow inference, or inject schema corruption without making network requests to NVIDIA API.

**2. Subprocess & Git Mocking:**
- Subprocess tool executions (`tsc`, `biome`, `ruff`) are mocked in unit tests to test graceful degradation when tools are missing or return errors.
- Real Git repositories are created dynamically inside temporary directories (`mkdtemp`) using isomorphic-git to test end-to-end Git operations safely.

---

*Testing analysis: 2026-09-14*
*Maintained under GSD codebase documentation guidelines*
