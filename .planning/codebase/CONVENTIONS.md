# Coding Conventions

**Analysis Date:** 2026-09-14

## Naming Patterns

**Files & Directories:**
- `kebab-case.ts` for all standard TypeScript modules: `review.ts`, `symbol-index.ts`, `evidence-validator.ts`, `decision-gate.ts`.
- `kebab-case.tsx` or `app.tsx` for React/Ink TUI components (`src/renderers/tui/app.tsx`).
- Test files: `[name].test.ts` or `[name].test.tsx` co-located directly beside the source file under test.
- Directory names: `kebab-case` (`application`, `renderers`, `analysis`, `intelligence`, `model`, `review`, `cancellation`).
- Public package entry points: `index.ts` in each module directory exporting canonical APIs and types.

**Functions:**
- `camelCase` for all functions and methods: `createReviewCommand`, `resolveScope`, `collectDiagnostics`, `evaluateReviewPolicy`.
- Async functions: use standard `async` keyword without special prefix/suffix; return `Promise<T>`.
- Factory functions: prefix with `create*` or `make*`: `createReviewUseCase`, `createReviewEngine`, `createCancellationController`, `createSymbolIndex`.

**Variables & Constants:**
- Variables: `camelCase`: `repoRoot`, `changedFiles`, `rawFindings`, `maxFindings`.
- Constants: `UPPER_SNAKE_CASE`: `DEFAULT_CONFIG`, `RANKING_WEIGHTS`, `ReviewExitCodes`, `SEVERITY_ORDER`.
- Private fields / internals: standard camelCase, or `#private` fields where runtime encapsulation is needed.

**Types & Interfaces:**
- Types and Interfaces: `PascalCase`: `ReviewResult`, `RankedFinding`, `FindingDisposition`, `ReviewScope`, `CanonicalReviewStage`.
- Type Guards: prefix with `is*`: `isOctateError`, `isRepository`, `isReviewModel`, `isActionableFix`.
- Enums / Const Objects: `PascalCase` object name with `UPPER_SNAKE_CASE` keys (`ReviewExitCodes.BLOCKING_FINDINGS`).

## Code Style & Tooling

**Formatting (Biome):**
- Indentation: 2 spaces.
- Line width: 100 characters max.
- Semicolons: always required.
- Quotes: single quotes for strings; double quotes in JSON.
- Trailing commas: ES5 (trailing where syntactically valid in multiline collections).
- Import organization: automatically sorted via Biome (`organizeImports: on`).

**Linting (Biome):**
- Recommended rules: enabled.
- Correctness: error level (`noNodejsModules: off`, `noProcessGlobal: off` for CLI runtime).
- Suspicious: error level (`useAwait` enforced — do not mark functions `async` unless they perform await operations).
- Style: warn level (avoid `!` non-null assertions where explicit guards can be used; `noProcessEnv: off`).

**TypeScript Configuration (`tsconfig.json`):**
- Target: `ES2022`.
- Module & Resolution: `NodeNext`.
- Strict mode: `true` (including `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`).
- Path Aliases: `@/*` mapped to `./src/*`.
- Declarations: `.d.ts` and `.d.ts.map` generated on build.

## Error Handling & Exit Codes

**Pattern: Typed Error Hierarchy:**
- Base class: `OctateError` (`src/errors/index.ts`) extending native `Error` with `exitCode` and structured `context`.
- Standardized Exit Codes (`src/application/types.ts:ReviewExitCodes`):
  - **0** (`SUCCESS`): Review completed successfully with 0 blocking findings.
  - **1** (`BLOCKING_FINDINGS`): Review found defects that meet or exceed `--fail-on` policy (evaluated by `src/application/policy.ts`).
  - **2** (`CONFIG_ERROR`): Invalid CLI options, malformed `octate.yaml`, or unparseable configuration.
  - **3** (`REPOSITORY_ERROR`): Git repository not found, dirty tree errors, AST parse failures, or analysis aborts.
  - **4** (`MODEL_ERROR`): NVIDIA API authentication failure (`AuthenticationError`), rate limits, timeouts, or unrecoverable model payload errors.
  - **5** (`INTERNAL_ERROR`): Schema validation errors or unhandled system faults.
  - **130** (`CANCELLED`): User interrupted review via SIGINT / Ctrl+C.

## Review Pipeline & Safety Conventions

### 1. Deterministic Evidence Verification (4 Tiers)
All candidate model findings must be evaluated against deterministic ground truth (`src/review/evidence-validator.ts`):
- **Tier 1 (Diagnostic):** Corroborated by a deterministic local compiler or linter diagnostic (`tsc`, `biome`, `ruff`, `mypy`).
- **Tier 2 (Syntax / AST):** Directly backed by a Tree-sitter syntax check on modified lines.
- **Tier 3 (Context):** Backed by cross-file reference graph or import resolution.
- **Tier 4 (Unverified):** Pure model assertion without deterministic corroboration.

### 2. Deterministic Decision Gate & Disposition
The `DeterministicDecisionGate` (`src/review/decision-gate.ts`) assigns an authoritative disposition to each finding:
- `BLOCKING`: Real, high-severity bugs that meet blocking criteria (must have Tier 1 or Tier 2 evidence and `PATCH_LOCAL` attribution).
- `ADVISORY`: High-value observations or context-level concerns that should not block pull request merging.
- `DISMISSED`: Low-confidence, hallucinated, or ungrounded findings dropped before presentation.

### 3. Patch Attribution
Findings are strictly attributed to their origin (`src/review/attribution.ts`):
- `PATCH_LOCAL`: Bug introduced directly inside the diff / added lines.
- `CALLER_CALLEE`: Issue caused in unmodified code through a contract change in modified code.
- `AMBIENT`: Pre-existing code issue unrelated to the developer's commit.
- `SYSTEMIC`: Global architectural pattern issue.
*Rule:* Only `PATCH_LOCAL` (and verified `CALLER_CALLEE`) findings can ever trigger a `BLOCKING` status.

### 4. Prompt Architecture & Injection Defense
- **Sandwich Prompt Framing:** Untrusted diffs and repository files are encapsulated inside XML tags (`<diff>`, `<context_item>`).
- Trusted prompt instructions and guardrails always precede and follow untrusted content. Repository source code never appears in trusted instruction blocks.
- **Lightweight Template Engine:** Regex interpolation (`{{variable}}`, `{{#each list}}`) in `src/model/prompts/template.ts` avoids arbitrary code execution.

### 5. Schema Validation & 2-Turn Repair Loop
- Model outputs are untrusted until parsed and validated against compiled Zod schemas (`src/model/schema/finding.ts`).
- JSON extractor removes markdown code fences and cleans trailing commas.
- File paths are verified against repository files, and line numbers are clamped to actual file lengths (`src/model/schema/grounding.ts`).
- On schema validation failure, actionable Zod error messages are formatted into a repair prompt and retried once before failing.

### 6. Fast-Path Skipping for Low-Risk Diffs
- If all modified files are markdown documentation (`.md`) or test suites (`.test.ts`, `test/`), the Review DAG fast-paths past heavy LLM reviewers to save inference costs and avoid false positives on doc changes.

---

*Conventions analysis: 2026-09-14*
*Maintained under GSD codebase documentation guidelines*
