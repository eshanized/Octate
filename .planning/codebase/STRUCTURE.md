# Codebase Structure

**Analysis Date:** 2026-09-14

## Directory Layout

```
Octate/
├── bin/                          # Executable shell wrappers
│   └── octate                    # Primary CLI runner executable
├── src/                          # Application source code (TypeScript)
│   ├── cli.ts                    # CLI entry point (Commander setup & global error handling)
│   ├── cli.test.ts               # CLI options & execution tests
│   ├── commands/                 # CLI subcommand handlers
│   │   ├── index.ts              # Command registration barrel
│   │   ├── review.ts             # Review subcommand (CLI options → ReviewUseCase)
│   │   ├── review.test.ts        # Review command integration tests
│   │   ├── doctor.ts             # Doctor environment checks (Node, Git, linters, NVIDIA API)
│   │   ├── doctor.test.ts        # Doctor command tests
│   │   ├── init.ts               # Init configuration file generator
│   │   └── init.test.ts          # Init command tests
│   ├── application/              # Layer 6: Application orchestration & policies
│   │   ├── index.ts              # Public exports
│   │   ├── types.ts              # Domain types (CanonicalReviewStage, ProgressEvent, ExitCodes)
│   │   ├── review.ts             # ReviewUseCase: 8 canonical review stages orchestrator
│   │   ├── review.test.ts        # ReviewUseCase integration tests
│   │   ├── policy.ts             # Policy evaluator (--fail-on severity, blocking count, banners)
│   │   ├── policy.test.ts        # Policy calculation tests
│   │   ├── progress.ts           # StderrProgressReporter for stage progress output
│   │   ├── progress.test.ts      # Progress reporter tests
│   │   └── __tests__/            # Shared application test mocks
│   │       └── mocks.ts
│   ├── renderers/                # Presentation Layer: Output format renderers
│   │   ├── index.ts              # Renderer factory (createRenderer, OutputFormat)
│   │   ├── types.ts              # Renderer interfaces & base contracts
│   │   ├── json.ts               # Full machine-readable JSON renderer
│   │   ├── json.test.ts          # JSON renderer tests
│   │   ├── sarif.ts              # SARIF v2.1.0 standard schema renderer
│   │   ├── sarif.test.ts         # SARIF renderer tests
│   │   ├── quiet.ts              # Minimal summary-only renderer
│   │   ├── quiet.test.ts         # Quiet renderer tests
│   │   ├── console.ts            # Colored plain-text terminal renderer
│   │   ├── console.test.ts       # Console renderer tests
│   │   └── tui/                  # Interactive terminal user interface (Ink + React 19)
│   │       ├── renderer.ts       # InteractiveTuiRenderer entry
│   │       ├── renderer.test.ts  # TUI renderer lifecycle tests
│   │       ├── app.tsx           # Ink React component root
│   │       ├── state.ts          # TUI state machine & keyboard action reducer
│   │       ├── state.test.ts     # State machine tests
│   │       ├── terminal.ts       # Terminal capability detector (TTY, color, size)
│   │       ├── terminal.test.ts  # Terminal capability tests
│   │       ├── syntax.ts         # Syntax highlighting utility
│   │       ├── syntax.test.ts    # Syntax highlighting tests
│   │       ├── diff.ts           # Unified diff line formatting & colorizer
│   │       ├── diff.test.ts      # Diff formatter tests
│   │       ├── clipboard.ts      # System clipboard copy integration
│   │       ├── clipboard.test.ts # Clipboard helper tests
│   │       └── types.ts          # TUI specific state and component types
│   ├── repository/               # Layer 1: Git and repository operations
│   │   ├── index.ts              # Repository barrel
│   │   ├── discovery.ts          # Git root search & workspace discovery
│   │   ├── git.ts                # isomorphic-git wrapper (diff, log, statusMatrix, refs)
│   │   ├── scope.ts              # Scope resolution (--staged, --commit, --range, --branch)
│   │   ├── filter.ts             # Binary, generated, symlink, and size file filtering
│   │   ├── ignore.ts             # .gitignore and .octateignore rule matching
│   │   ├── monorepo.ts           # Workspace detection (pnpm, npm, yarn, turborepo, cargo)
│   │   └── *.test.ts             # Unit tests for repository modules
│   ├── analysis/                 # Layer 2: Deterministic static analysis
│   │   ├── index.ts              # Analysis public API barrel
│   │   ├── types.ts              # ParsedFile, Symbol, Diagnostic domain types
│   │   ├── orchestrator.ts       # Unified analysis pipeline (parse → symbols → diagnostics)
│   │   ├── orchestrator.test.ts  # Analysis orchestrator tests
│   │   ├── semantic-patterns.ts  # Context-aware safe-idiom patterns & false-positive filters
│   │   ├── semantic-patterns.test.ts # Semantic pattern tests
│   │   ├── parser/               # WebAssembly Tree-sitter AST parser
│   │   │   ├── index.ts          # Parser initialization and syntax tree creation
│   │   │   ├── index.test.ts     # Parser tests
│   │   │   ├── languages.ts      # Language detection & grammar loading
│   │   │   └── languages.test.ts # Language detection tests
│   │   ├── symbols/              # Symbol extraction from ASTs
│   │   │   ├── index.ts          # Symbol extractor (classes, functions, methods, interfaces)
│   │   │   ├── index.test.ts     # Symbol extractor tests
│   │   │   └── queries.ts        # Tree-sitter S-expression queries for TS and Python
│   │   └── diagnostics/          # Subprocess diagnostic tools
│   │       ├── index.ts          # Parallel collector with PromisePool concurrency (3)
│   │       ├── index.test.ts     # Diagnostics collector tests
│   │       ├── tools.ts          # Subprocess executors (tsc, biome, ruff, mypy, pyright, bandit, pytest)
│   │       ├── tools.test.ts     # Tool runner tests
│   │       ├── severity.ts       # Tool-specific severity normalization
│   │       └── severity.test.ts  # Severity mapping tests
│   ├── intelligence/             # Layer 3: Intelligence & Context Engine
│   │   ├── index.ts              # Intelligence public API barrel
│   │   ├── types.ts              # ReferenceGraph, DependencyGraph, ReviewContext contracts
│   │   ├── index/                # Multi-file symbol indexing
│   │   │   ├── symbol-index.ts   # In-memory symbol index with range & fuzzy queries
│   │   │   ├── symbol-index.test.ts
│   │   │   ├── path-resolver.ts  # Cross-file module import path resolver
│   │   │   └── path-resolver.test.ts
│   │   ├── graph/                # Relationship graphs
│   │   │   ├── reference.ts      # Caller/callee directed graph with getIncoming()
│   │   │   ├── reference.test.ts
│   │   │   ├── dependency.ts     # Package & internal module dependency graph
│   │   │   ├── dependency.test.ts
│   │   │   ├── serializer.ts     # Graph disk serialization and loading
│   │   │   └── serializer.test.ts
│   │   └── context/              # Context Engine & prompt serialization
│   │       ├── engine.ts         # Candidate ranking and ReviewContext assembly
│   │       ├── engine.test.ts
│   │       ├── budget.ts         # Token estimation & budget allocation
│   │       ├── budget.test.ts
│   │       ├── windowing.ts      # Snippet extraction and sliding windowing
│   │       ├── windowing.test.ts
│   │       ├── serializer.ts     # Sandwich prompt serialization & XML demarcation
│   │       └── serializer.test.ts
│   ├── model/                    # Layer 4: AI Model Provider & Structured Outputs
│   │   ├── index.ts              # Model public API barrel
│   │   ├── types.ts              # ModelRequest, ModelResponse, Finding domain models
│   │   ├── abstraction.ts        # ReviewModel interface & provider factory
│   │   ├── abstraction.test.ts
│   │   ├── prompts/              # Versioned markdown prompt templates
│   │   │   ├── index.ts          # Prompt exports
│   │   │   ├── template.ts       # Regex template engine for variables & blocks
│   │   │   ├── template.test.ts
│   │   │   ├── fallbacks.ts      # In-memory fallback prompt templates
│   │   │   ├── loader.ts         # File-based prompt loader with fallback
│   │   │   ├── loader.test.ts
│   │   │   ├── reviewer.structural.v1.md
│   │   │   ├── reviewer.semantic.v1.md
│   │   │   ├── reviewer.security.v1.md
│   │   │   └── critic.v1.md
│   │   ├── schema/               # Zod schemas, JSON extraction, grounding & repair
│   │   │   ├── index.ts          # Schema barrel
│   │   │   ├── finding.ts        # FindingsPayloadSchema with Zod AOT compilation
│   │   │   ├── finding.test.ts
│   │   │   ├── extractor.ts      # Code fence stripping & JSON trailing comma cleanup
│   │   │   ├── extractor.test.ts
│   │   │   ├── grounding.ts      # File existence & line bounds clamping
│   │   │   ├── grounding.test.ts
│   │   │   ├── repair.ts         # Actionable error formatting for 2-turn repair loop
│   │   │   └── repair.test.ts
│   │   └── providers/            # Concrete provider implementations
│   │       ├── nvidia.ts         # LocalNvidiaProvider chat completion client
│   │       ├── nvidia.test.ts
│   │       ├── resilience.ts     # 60s timeout, exponential backoff, retry, pool(2)
│   │       └── resilience.test.ts
│   ├── review/                   # Layer 5: Review Engine & Quality Gates
│   │   ├── index.ts              # Review public API barrel
│   │   ├── types.ts              # ReviewResult, RankedFinding, FindingDisposition types
│   │   ├── heuristics.ts         # AST executable logic & security triggers
│   │   ├── heuristics.test.ts
│   │   ├── dag.ts                # Staged ReviewDAG runner with fast-path skips
│   │   ├── dag.test.ts
│   │   ├── critic.ts             # Two-stage Critic quality gate (hard floor + critic.v1)
│   │   ├── critic.test.ts
│   │   ├── dedup.ts              # Multi-factor duplicate clustering & evidence merging
│   │   ├── dedup.test.ts
│   │   ├── ranking.ts            # 6-factor composite scoring & Critical-protection
│   │   ├── ranking.test.ts
│   │   ├── engine.ts             # ReviewEngine orchestrator (Stages 1–5)
│   │   ├── engine.test.ts
│   │   ├── evidence-validator.ts # Deterministic 4-tier evidence verification engine
│   │   ├── evidence-validator.test.ts
│   │   ├── decision-gate.ts      # Deterministic decision gate (BLOCKING, ADVISORY, DISMISSED)
│   │   ├── decision-gate.test.ts
│   │   ├── attribution.ts        # Patch attribution classifier (PATCH_LOCAL, AMBIENT, etc.)
│   │   ├── attribution.test.ts
│   │   └── __tests__/            # Review engine test mocks
│   │       └── mocks.ts
│   ├── cache/                    # Infrastructure: Content-addressable LRU cache
│   │   ├── index.ts              # Cache public API barrel
│   │   ├── store.ts              # CacheStore class (atomic file writes, size tracking)
│   │   ├── keys.ts               # Cache key generation (AST, index, tool, config hash)
│   │   ├── lru.ts                # In-memory LRU cache with TTL
│   │   ├── pool.ts               # PromisePool for concurrency control (p-limit wrapper)
│   │   ├── identity.ts           # Cache directory & project identity hashing
│   │   └── *.test.ts
│   ├── config/                   # Infrastructure: Configuration system
│   │   ├── index.ts              # Config public API barrel
│   │   ├── schema.ts             # Zod schemas + DefaultConfig
│   │   ├── loader.ts             # Config discovery (cosmiconfig + YAML parser)
│   │   ├── merger.ts             # Precedence merging (defaults < global < project < env < CLI)
│   │   └── *.test.ts
│   ├── logging/                  # Infrastructure: Structured logging
│   │   ├── index.ts              # Pino root logger, createLogger child factory, redaction
│   │   └── index.test.ts
│   ├── errors/                   # Infrastructure: Typed error hierarchy
│   │   ├── index.ts              # Base OctateError + 13 specialized error classes + type guards
│   │   └── index.test.ts
│   ├── cancellation/             # Infrastructure: Cancellation & subprocess management
│   │   ├── index.ts              # Cancellation public API barrel
│   │   ├── controller.ts         # CancellationController (AbortController wrapper)
│   │   ├── subprocess.ts         # spawnWithSignal + process tree termination
│   │   └── *.test.ts
│   └── types/                    # Cross-cutting domain types
│       ├── index.ts              # Repository, Workspace, FileChange, ReviewScope types & guards
│       └── index.test.ts
├── test/                         # Integration, evaluation, and stress test suites
│   ├── evaluation/               # Empirical evaluation harness & metrics
│   │   ├── types.ts              # Evaluation metrics and run contracts
│   │   ├── harness.ts            # Headless evaluation test runner
│   │   ├── evaluation.test.ts    # Evaluation harness test cases
│   │   └── benchmark-repo.test.ts# Evaluation against synthetic benchmark repos
│   ├── reproduction/             # Regression and root-cause reproduction tests
│   │   └── false-positives.test.ts # Direct regression suite for false positive traps
│   ├── stress/                   # Large repository & concurrency stress tests
│   │   ├── stress-helper.ts      # Stress test generator utilities
│   │   ├── repository-git.stress.test.ts
│   │   ├── parser-security.stress.test.ts
│   │   ├── context-review-pipeline.stress.test.ts
│   │   ├── model-cli.stress.test.ts
│   │   └── cache-fuzz.stress.test.ts
│   └── fixtures/                 # Test repositories and golden review cases
│       └── golden/               # Verified review golden baselines
│           ├── security/         # SQL injection, command injection, clean type assertions
│           ├── structural/       # Resource leaks, unclosed handles
│           ├── semantic/         # Logic regressions, bounded loops, intentional exceptions
│           ├── refactor/         # Safe refactoring without behavioral regressions
│           ├── docs/             # Documentation-only diffs
│           └── test/             # Test-only diffs
├── benchmark/                    # Benchmark repository & evaluation tooling
│   ├── evaluate.ts               # Standalone evaluation and metrics script
│   ├── expected-findings.json    # Canonical baseline expected findings database
│   ├── SPECIFICATION.md          # Benchmark specification & defect criteria
│   ├── README.md                 # Benchmark instructions
│   ├── octate.yaml               # Benchmark project config
│   ├── package.json              # Benchmark dependencies
│   ├── tsconfig.json             # Benchmark TypeScript config
│   ├── src/                      # Synthetic target source files for benchmarking
│   └── defects/                  # Benchmark defect descriptions
├── docs/                         # User-facing and developer documentation
│   ├── ci-cd.md                  # CI/CD integration guide (GitHub Actions, GitLab CI)
│   ├── configuration.md          # octate.yaml configuration reference
│   └── troubleshooting.md        # Common issues and debugging steps
├── scripts/                      # Build and benchmark scripts
│   ├── bench.ts                  # Micro-benchmark runner
│   └── copy-wasm.cjs             # Post-build Tree-sitter WASM file copier
├── test-wasm/                    # WebAssembly Tree-sitter language grammars
│   ├── tree-sitter-typescript.wasm
│   └── tree-sitter-python.wasm
├── .planning/                    # GSD planning directory & codebase maps
│   ├── codebase/                 # 7 structured codebase documents
│   ├── phases/                   # Milestone phase specifications and verifications
│   └── STATE.md                  # Project status tracking
├── PRODUCTION_READINESS.md       # Production readiness checklist and verification
├── REVIEW_PIPELINE.md            # Detailed review pipeline and gate specifications
├── TRUSTWORTHY_REVIEW_EVALUATION.md # Precision, recall, and false positive metrics
├── FALSE_POSITIVE_ROOT_CAUSE.md  # Detailed false positive root-cause audit
├── FINDING_SEVERITY_POLICY.md    # Severity classification and blocking policy
├── package.json                  # Root project manifest and npm scripts
├── pnpm-lock.yaml                # pnpm lockfile
├── tsconfig.json                 # TypeScript compiler configuration
├── biome.json                    # Biome linting and formatting configuration
├── jest.config.ts                # Jest configuration with ESM support
└── AGENTS.md                     # Agent instructions and rules
```

## Directory Purposes

**`src/cli.ts` & `src/commands/`:** CLI Program & Command Routing
- Parses arguments, configures flags, registers subcommands (`review`, `doctor`, `init`), handles global signals (`SIGINT`, `SIGTERM`), and maps errors to exit codes.

**`src/application/`:** Application Layer (Layer 6)
- Contains `ReviewUseCase`, the authoritative orchestrator of the review lifecycle.
- Manages the 8 canonical stages (`git:read` to `review:rank`), emits typed progress events (`StderrProgressReporter`), and enforces exit code severity policies (`policy.ts`).

**`src/renderers/`:** Presentation & Output Formatting Layer
- Translates `ReviewResult` domain objects into specific user and machine formats.
- Houses the Ink-based React 19 interactive TUI (`src/renderers/tui/`) as well as standard CI renderers (`json.ts`, `sarif.ts`, `quiet.ts`, `console.ts`).

**`src/review/`:** Review Engine & Quality Gates (Layer 5)
- Orchestrates review execution via `ReviewDAG`.
- Filters findings through the two-stage `CriticStage`, clusters duplicates in `DeduplicationEngine`, performs 6-factor `CompositeRanking`, validates evidence via `EvidenceValidator`, and applies deterministic blocking rules via `DecisionGate`.

**`src/analysis/`:** Deterministic Static Analysis Layer (Layer 2)
- Fast AST parsing via WebAssembly Tree-sitter, language detection, symbol extraction, safe-idiom pattern checks, and local compiler/linter subprocess execution.

**`src/intelligence/`:** Repository Intelligence & Context Engine (Layer 3)
- Multi-file symbol indexing, cross-file reference graphs with caller/callee traversal, dependency graphs, token budgeting, and sandwich prompt serialization.

**`src/model/`:** AI Model Provider & Structured Outputs (Layer 4)
- Encapsulates NVIDIA Nemotron 3 Ultra 550B-A55B API communications, connection resilience, Zod schema validation, grounding against repository files, and 2-turn error repair.

**`src/repository/`:** Git & Workspace Layer (Layer 1)
- Git discovery, isomorphic-git diff/status operations, monorepo workspace detection, file filtering, and ignore pattern matching.

**`src/cache/`, `src/config/`, `src/logging/`, `src/errors/`, `src/cancellation/`:** Infrastructure
- Content-addressable LRU file cache, hierarchical configuration loader, structured Pino logger with credential redaction, typed error hierarchy, and cooperative cancellation controllers.

**`test/` & `benchmark/`:** Testing & Empirical Evaluation
- Comprehensive unit tests, golden fixtures, reproduction tests for false positives, stress tests for scale, and automated precision/recall evaluation harnesses.

## Key File Locations

**Entry Points:**
- `bin/octate`: Shell executable script.
- `src/cli.ts`: Commander.js CLI application entry.
- `src/application/review.ts`: Core application review use case.

**Configuration:**
- `tsconfig.json`: TypeScript compiler options (strict, NodeNext).
- `biome.json`: Linter and formatter settings.
- `jest.config.ts`: Jest testing setup with ESM options.
- `octate.yaml`: Project review configuration and rules.

**Core Review Pipelines:**
- `src/application/review.ts`: End-to-end 8-stage orchestrator.
- `src/review/engine.ts`: 5-stage review engine.
- `src/review/evidence-validator.ts`: 4-tier deterministic evidence validator.
- `src/review/decision-gate.ts`: Final deterministic blocking decision gate.

**Testing & Benchmarking:**
- `benchmark/evaluate.ts`: Empirical evaluation script.
- `benchmark/expected-findings.json`: Canonical golden expected findings.
- `test/fixtures/golden/`: Golden diff test cases across categories.
- `test/reproduction/false-positives.test.ts`: Regression suite for false positive traps.

## Naming Conventions

**Files & Directories:**
- Source files: `kebab-case.ts` (`symbol-index.ts`, `evidence-validator.ts`).
- React TUI components: `kebab-case.tsx` or `app.tsx`.
- Test files: `[name].test.ts` or `[name].test.tsx` co-located with source.
- Specialized test suites: `[name].stress.test.ts`.
- Barrels: `index.ts` for public package exports.
- Types & schemas: `types.ts` for domain interfaces, `schema.ts` for Zod schemas.

**Functions & Variables:**
- Functions: `camelCase` (`createReviewCommand`, `evaluateReviewPolicy`, `resolveScope`).
- Factory functions: `create*` prefix (`createReviewEngine`, `createCancellationController`).
- Variables: `camelCase` (`repoRoot`, `rawFindings`, `maxFindings`).
- Constants: `UPPER_SNAKE_CASE` (`DEFAULT_CONFIG`, `RANKING_WEIGHTS`, `ReviewExitCodes`).

**Types:**
- Interfaces & Types: `PascalCase` (`ReviewResult`, `ReviewScope`, `FindingDisposition`).
- Type guards: `is*` prefix (`isOctateError`, `isRepository`, `isReviewModel`).

## Where to Add New Code

**Adding a New CLI Subcommand:**
- Define command in `src/commands/[command-name].ts`.
- Register in `src/commands/index.ts`.
- Add unit tests in `src/commands/[command-name].test.ts`.

**Adding a New Reviewer or Heuristic:**
- Define heuristic check in `src/review/heuristics.ts`.
- Add prompt template in `src/model/prompts/[reviewer-name].v1.md`.
- Register stage in `src/review/dag.ts`.
- Add unit tests in `src/review/dag.test.ts` and golden fixtures in `test/fixtures/golden/`.

**Adding a New Static Analysis / Linter Subprocess:**
- Add command and detection trigger in `src/analysis/diagnostics/tools.ts`.
- Add output normalization mapping in `src/analysis/diagnostics/severity.ts`.
- Add test coverage in `src/analysis/diagnostics/tools.test.ts` and `severity.test.ts`.

**Adding a New Output Renderer:**
- Implement `ReviewRenderer` interface in `src/renderers/[format].ts`.
- Add format option to `createRenderer()` in `src/renderers/index.ts`.
- Add unit tests in `src/renderers/[format].test.ts`.

**Adding a Test Case or False Positive Reproduction:**
- For false positive regression: add reproduction test case in `test/reproduction/false-positives.test.ts`.
- For golden test fixtures: create directory under `test/fixtures/golden/[category]/[case-name]/` with `baseline.ts`, `vulnerable.ts`, `clean.ts`, and `expected.json`.

---

*Structure analysis: 2026-09-14*
*Maintained under GSD codebase documentation guidelines*
