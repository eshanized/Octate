# Architecture

**Analysis Date:** 2026-09-14

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLI Layer (src/cli.ts)                          │
│     Commander.js program, global option parsing, exit code handling     │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Commands Layer (src/commands/)                     │
│  ┌──────────────────────┐ ┌────────────────────┐ ┌───────────────────┐  │
│  │   review (review.ts) │ │  doctor (doctor.ts)│ │   init (init.ts)  │  │
│  └──────────┬───────────┘ └────────────────────┘ └───────────────────┘  │
└─────────────┼───────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Application Layer (src/application/)                 │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ ReviewUseCase (review.ts) - 8 Canonical Stages Pipeline           │  │
│  │ StderrProgressReporter (progress.ts) | Policy Evaluator (policy.ts) │
│  └──────────┬────────────────────────────────────────────────────────┘  │
└─────────────┼───────────────────────────────────────────────────────────┘
              │
              ├───────────────────────────────────────┬───────────────────┐
              ▼                                       ▼                   ▼
┌───────────────────────────┐ ┌───────────────────────────┐ ┌───────────────────────────┐
│ Analysis (src/analysis/)  │ │Intelligence(src/intelli..)│ │ Review (src/review/)      │
│ - Orchestrator            │ │ - ContextEngine           │ │ - ReviewEngine            │
│ - Web-Tree-Sitter Parser  │ │ - SymbolIndex             │ │ - ReviewDAG (Staged)      │
│ - AST Symbol Extraction   │ │ - Reference & Dep Graphs  │ │ - Two-Stage Critic Gate   │
│ - Diagnostics Subprocesses│ │ - Token Budget & Windowing│ │ - Evidence Validator      │
│ - Semantic Safe Idioms    │ │ - Sandwich Serializer     │ │ - Deterministic Gate      │
└─────────────┬─────────────┘ └─────────────┬─────────────┘ └─────────────┬─────────────┘
              │                             │                             │
              └─────────────────────────────┼─────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Renderers Layer (src/renderers/)                   │
│  ┌────────────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐  │
│  │ Interactive TUI    │  │    JSON     │  │    SARIF    │  │  Quiet  │  │
│  │ (React 19 + Ink)   │  │ (json.ts)   │  │ (sarif.ts)  │  │(quiet.ts│  │
│  └────────────────────┘  └─────────────┘  └─────────────┘  └─────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Infrastructure & Support Layers                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │  Repository  │ │    Model     │ │    Cache     │ │  Cancellation  │  │
│  │(isomorphic-  │ │ (NVIDIA API  │ │ (LRU store,  │ │  (AbortSignal,  │  │
│  │ git, scope)  │ │ + repair)    │ │  keys, pool) │ │   subprocesses)│  │
│  └──────────────┘ └──────────────┘ └──────────────┘ └────────────────┘  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                     │
│  │    Config    │ │   Logging    │ │    Errors    │                     │
│  │(YAML, Zod,   │ │ (Pino, child │ │(Typed hierarchy│                   │
│  │ precedence)  │ │  redaction)  │ │ & exit codes)│                     │
│  └──────────────┘ └──────────────┘ └──────────────┘                     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | Primary Files |
|---|---|---|
| **CLI Entry** | Commander.js program definition, global options, signal handling, top-level error mapping | `src/cli.ts` |
| **Commands Layer** | Routes CLI subcommands (`review`, `doctor`, `init`) and connects CLI flags to application use cases | `src/commands/*.ts` |
| **Application Layer** | End-to-end review lifecycle orchestration, 8 canonical progress events, `--fail-on` policy evaluation | `src/application/review.ts`, `src/application/policy.ts`, `src/application/progress.ts` |
| **Repository Operations** | Git root discovery, commit/range/staged diff resolution via isomorphic-git, workspace detection, file filtering | `src/repository/*.ts` |
| **Deterministic Analysis** | Tree-sitter AST parsing, language detection, symbol query extraction, local linter/diagnostic execution | `src/analysis/orchestrator.ts`, `src/analysis/parser/`, `src/analysis/symbols/`, `src/analysis/diagnostics/` |
| **Intelligence & Context** | Cross-file symbol indexing, caller/callee reference graph traversal, token budgeting, sandwich prompt framing | `src/intelligence/index/`, `src/intelligence/graph/`, `src/intelligence/context/` |
| **Model Provider** | NVIDIA Nemotron chat completion client, resilient retries, Zod schema extraction, 2-turn repair loop, grounding | `src/model/providers/nvidia.ts`, `src/model/schema/` |
| **Review Engine** | Review DAG execution, two-stage Critic filtering, duplicate clustering, composite ranking, evidence validation, deterministic decision gate | `src/review/engine.ts`, `src/review/dag.ts`, `src/review/critic.ts`, `src/review/evidence-validator.ts`, `src/review/decision-gate.ts` |
| **Renderers** | Output format transformations: Interactive TUI (React 19 + Ink 7), JSON, SARIF v2.1.0, Console, and Quiet modes | `src/renderers/tui/`, `src/renderers/*.ts` |
| **Infrastructure** | Content-addressable LRU cache, config precedence loader, structured Pino logger with redaction, typed error classes, cancellation controllers | `src/cache/`, `src/config/`, `src/logging/`, `src/errors/`, `src/cancellation/` |

## Pattern Overview

**Overall:** Layered architectural pipeline with strict separation between deterministic static analysis, intelligence context generation, AI model reasoning, and post-inference validation gates.

**Key Characteristics:**
1. **Deterministic Analysis Before AI:** Tree-sitter AST parsing, symbol extraction, and static linter diagnostics execute deterministically before any LLM prompt is assembled.
2. **Untrusted Input Isolation (Sandwich Framing):** Diff content and repository files are treated as untrusted data and placed in demarcated XML envelopes (`<diff>`, `<context_item>`). Model instructions are placed in trusted sections to eliminate prompt injection risks.
3. **Multi-Stage Review DAG:** Structural review runs as a baseline; Semantic and Security reviewers trigger conditionally via AST heuristics and pattern matching. Short-circuit fast paths bypass heavy model reviewers for doc-only or test-only changes.
4. **4-Tier Evidence Verification:**
   - **Tier 1 (Diagnostic):** Corroborated by local compiler or linter diagnostic (`tsc`, `biome`, `ruff`).
   - **Tier 2 (Syntax / AST):** Directly verified against Tree-sitter syntax nodes (missing catch block, undefined symbol).
   - **Tier 3 (Context):** Derived from multi-file reference graph or import analysis.
   - **Tier 4 (Unverified / Speculative):** Pure model assertion without deterministic backing.
5. **Deterministic Decision Gate:** Final gate categorizes findings into `BLOCKING`, `ADVISORY`, or `DISMISSED`. Unverified or hallucinated findings are prevented from failing CI builds.
6. **Patch Attribution:** Findings are tagged as `PATCH_LOCAL`, `CALLER_CALLEE`, `AMBIENT`, or `SYSTEMIC` to ensure developers are only blocked on defects directly introduced in their changeset.
7. **Swappable Presentation Layer:** The review core produces a domain-level `ReviewResult`. Output renderers (Ink TUI, SARIF v2.1.0, JSON, Console, Quiet) are decoupled from core analysis.

## Layers & Execution Pipeline

```text
Step 1: git:read            ──► Discovers Git repository root and resolves ReviewScope diffs
Step 2: index:update        ──► Parses modified & dependent source files via Web-Tree-Sitter
Step 3: symbols:resolve     ──► Extracts AST symbols & builds cross-file ReferenceGraph
Step 4: diagnostics:collect ──► Runs local tools (tsc, biome, ruff) with concurrency limit 3
Step 5: context:build       ──► Ranks context candidates, fits token budget, formats sandwich prompt
Step 6: review:dag          ──► Executes ReviewDAG (Structural, Semantic, Security reviewers)
Step 7: review:critic       ──► Two-Stage Critic: Deterministic Hard Floor + Critic LLM
Step 8: review:rank         ──► Evidence Validator (4 tiers) + Deterministic Decision Gate + Ranking
Output: renderers           ──► Renders via Interactive TUI (Ink), SARIF, JSON, Console, or Quiet
```

## Data Flow

### 1. Invocation & Scope Resolution (`src/commands/review.ts` & `src/repository/`)
- User executes `octate review [flags]`.
- `validateScope()` ensures at most one scope flag is specified (`--staged`, `--working`, `--commit`, `--range`, `--branch`).
- `findGitRoot()` walks up the directory tree to locate the `.git` boundary.
- `loadConfig()` parses `octate.yaml`, merges global and CLI flags, and validates against `OctateConfigSchema`.
- `resolveScope()` inspects Git state via isomorphic-git, producing unified diffs and `ReviewScope`.

### 2. Application UseCase Orchestration (`src/application/review.ts`)
- `ReviewUseCase.execute()` initializes timing, subscribes `onProgress` callbacks, and tracks the 8 canonical stages.
- If scope contains 0 modified files, short-circuits immediately with clean `ReviewResult`.

### 3. Analysis & Intelligence (`src/analysis/` & `src/intelligence/`)
- `parseFiles()` loads WebAssembly grammars and builds concrete syntax trees.
- `extractSymbols()` queries classes, methods, functions, and interfaces.
- `collectDiagnostics()` spawns local compilers/linters concurrently (`PromisePool(3)`), normalizing outputs.
- `createReferenceGraph()` and `createSymbolIndex()` map caller/callee relationships across file boundaries.
- `createContextEngine()` selects top-ranked contextual snippets within token budget constraints and frames the sandwich prompt.

### 4. Review Execution & Quality Gates (`src/review/`)
- **ReviewDAG**: Runs reviewers with concurrency limit of 2. Employs fast-path skipping if diff is doc-only or test-only.
- **DeduplicationEngine**: Clusters duplicate findings across overlapping line ranges ($\pm 3$ lines) and identical symbols.
- **CriticStage**:
  1. *Hard Floor*: Drops low-confidence (<0.6), nonexistent files, out-of-bounds lines, and non-actionable findings.
  2. *LLM Critic*: Runs `critic.v1` prompt to challenge surviving findings with senior-engineer adversarial checks.
- **EvidenceValidator**: Evaluates deterministic evidence backing and assigns Tiers 1 through 4.
- **PatchAttribution**: Determines if finding is patch-local, caller-callee, ambient, or systemic.
- **DeterministicDecisionGate**: Applies strict disposition policies: findings without Tier 1 or Tier 2 evidence cannot be `BLOCKING`.
- **CompositeRanking**: Calculates 6-factor composite scores (0–100) and truncates to configured `max_findings` while protecting critical items.

### 5. Presentation & Policy Enforcement (`src/renderers/` & `src/application/policy.ts`)
- `evaluateReviewPolicy()` checks finding severities against `--fail-on` threshold.
- `createRenderer()` selects output formatter:
  - If TUI enabled and interactive TTY: launches `InteractiveTuiRenderer` with React 19 + Ink.
  - Automation flags: `--json` (`JsonRenderer`), `--sarif` (`SarifRenderer`), `-q`/`--quiet` (`QuietRenderer`).
- Command exits with standard exit code:
  - 0: Passed (no blocking findings)
  - 1: Blocked (blocking findings present)
  - 2: Configuration error
  - 3: Repository/analysis error
  - 4: Model/provider error
  - 5: Internal error
  - 130: User cancellation

## Key Abstractions

### `ReviewUseCase` (`src/application/review.ts`)
- **Purpose**: Authoritative orchestrator uniting all analysis, intelligence, model, and review layers.
- **Pattern**: Clean Architecture Use Case; emits typed progress events and handles cancellation.

### `ReviewModel` (`src/model/abstraction.ts`)
- **Purpose**: Abstract AI provider contract decoupling the review engine from specific model APIs.
- **Implementations**: `LocalNvidiaProvider`, `MockReviewModel`.

### `EvidenceValidator` (`src/review/evidence-validator.ts`)
- **Purpose**: Deterministic classification of model findings into 4 verification tiers based on AST queries and compiler diagnostics.

### `DeterministicDecisionGate` (`src/review/decision-gate.ts`)
- **Purpose**: Final non-AI arbiter enforcing company/project blocking rules. Prevents uncorroborated AI findings from breaking builds.

### `InteractiveTuiRenderer` (`src/renderers/tui/renderer.ts`)
- **Purpose**: Ink-based terminal user interface providing split views, finding lists, diff inspector, and keyboard navigation.

### `CancellationController` (`src/cancellation/controller.ts`)
- **Purpose**: Cooperative cancellation wrapper around Node.js `AbortController` and subprocess process-tree termination.

## Error Handling & CI/CD Integration

- **Strict Error Subclasses**: `OctateError`, `ConfigurationError`, `RepositoryError`, `GitError`, `ModelError`, `AuthenticationError`, `ValidationError`.
- **Structured JSON Logging**: Module-tagged Pino logs with credential redaction.
- **Predictable Exit Codes**: Enables headless integration into GitHub Actions, GitLab CI, and pre-commit hooks.

---

*Architecture analysis: 2026-09-14*
*Maintained under GSD codebase documentation guidelines*
