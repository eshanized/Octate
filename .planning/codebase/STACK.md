# Technology Stack

**Analysis Date:** 2026-09-14

## Languages

**Primary:**
- TypeScript 5.9.3 - Strict mode (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`), ES2022 target, NodeNext module resolution, isolatedModules, declaration maps. Used for all application code in `src/`, test suites, benchmarks, and scripts.

**Secondary:**
- JavaScript (ESM) - Compiled execution output in `dist/`, standalone utility scripts (`scripts/copy-wasm.cjs`).
- WebAssembly (`.wasm`) - Precompiled Tree-sitter language grammars for TypeScript and Python (`test-wasm/*.wasm`).

## Runtime

**Environment:**
- Node.js >=22.0.0 - Required by Ink 7.1.1, modern ECMAScript modules, global `fetch`, native `AbortController`, and Node.js VM modules for Jest ESM execution (`NODE_OPTIONS=--experimental-vm-modules`).
- No browser runtime required (standalone terminal CLI application).

**Package Manager:**
- pnpm 12.3.4 - Fast, disk-efficient, strict dependency isolation.
- Workspaces: `pnpm-workspace.yaml` configured.
- Lockfile: `pnpm-lock.yaml` present.

## Frameworks

**Core CLI:**
- Commander.js 15.0.0 (`commander`) - CLI argument parsing, subcommand routing (`review`, `doctor`, `init`), options and flag handling. Entry point: `src/cli.ts`.

**TUI & Terminal UI:**
- Ink 7.1.1 (`ink`) - React-based terminal UI rendering engine with full flexbox layout, component tree, and keyboard event handling.
- React 19.2.8 (`react`, `@types/react` ^19.3.0) - Declarative UI component model for interactive terminal reviews (`src/renderers/tui/`).

**Testing:**
- Jest 30.5.1 (`jest`) - Parallel test runner, snapshot testing, mocking.
- ts-jest 29.4.12 (`ts-jest`) - TypeScript transformer with ESM support (`jest.config.ts`).
- @jest/globals ^30.5.1 - Explicit type-safe Jest globals.
- Suite Metrics: 81 test suites, 947 tests passing (100% passing rate).

**Build/Dev Tooling:**
- TypeScript 5.9.3 (`tsc`) - Compilation to `dist/`, declaration emitter (`tsconfig.json`).
- tsx latest (`tsx`) - TypeScript execution runtime for fast development (`tsx watch src/cli.ts`, `tsx scripts/bench.ts`).
- @biomejs/biome 2.5.12 (`@biomejs/biome`) - Fast Rust-based linter and formatter (`biome.json`).
- husky latest (`husky`) - Git commit hook management (`.husky/`).

## Key Dependencies

**Critical:**
- `ink` 7.1.1 & `react` 19.2.8 - Powers the interactive terminal review interface (`InteractiveTuiRenderer`).
- `commander` 15.0.0 - Handles CLI routing, options, and flag validation.
- `zod` 4.5.4 - Runtime schema validation & AOT schema compilation (`z.compile()`) for AI findings and configuration.
- `web-tree-sitter` ^0.27.0 - WebAssembly Tree-sitter parser runtime for syntax trees and symbol queries.
- `tree-sitter-typescript` ^0.23.2 & `tree-sitter-python` ^0.25.0 - Official language grammars.
- `isomorphic-git` 1.41.9 - Pure JavaScript Git implementation for diffs, log traversal, and working tree inspection without native Git dependencies.
- `pino` 10.3.1 - High-throughput structured JSON logging with built-in credential redaction.
- `node-sarif-builder` 5.0.0 & `@microsoft/sarif` latest - Standardized SARIF v2.1.0 generation for CI/CD pipelines.
- `p-limit` 7.3.2 & `p-queue` 7.3.2 - Concurrency bounding and task queues for model calls and diagnostics.

**Infrastructure:**
- `fast-glob` 3.3.3 - Fast async workspace package and file discovery.
- `ignore` 7.0.8 - `.gitignore` and `.octateignore` rule parsing and path matching.
- `yaml` 2.9.0 - YAML 1.2 parsing and formatting for `octate.yaml`.
- `picocolors` 1.1.1 - Fast, zero-dependency ANSI color formatting for console and quiet renderers.
- `pino-pretty` ^13.1.3 - Human-readable colorized logs during development.
- Native Node.js built-ins - `node:fs/promises`, `node:crypto`, `node:child_process`, global `fetch`, and `AbortController`.

## Configuration

**Environment:**
- Configured via environment variables:
  - `NVIDIA_API_KEY`: API key for NVIDIA Nemotron model inference (`https://integrate.api.nvidia.com/v1`).
  - `LOG_LEVEL`: Logging verbosity (`trace`, `debug`, `info`, `warn`, `error`, `fatal`).
  - `NODE_ENV`: Runtime environment (`production` enables raw JSON logs, suppresses colorized output).
  - `XDG_CONFIG_HOME`: Global user configuration base directory (`~/.config/octate/config.yaml`).
  - `HOME` / `USERPROFILE`: User cache base directory (`~/.local/share/octate/`).

**Build & Project Configs:**
- `tsconfig.json` - Target ES2022, NodeNext modules, strict mode, `@/*` path mapping to `./src/*`.
- `biome.json` - Formatting (2 spaces, 100 column width, single quotes, semicolons) and linting rules.
- `jest.config.ts` - ESM preset with ts-jest, coverage collection across `src/**/*.ts`.
- `octate.yaml` - Project-level configuration (severity thresholds, max findings, custom rules, architecture constraints).
- `package.json` - Scripts: `build`, `dev`, `test`, `test:watch`, `typecheck`, `lint`, `format`, `check`, `bench`.

## Platform Requirements

**Development:**
- Linux, macOS, or Windows (WSL recommended).
- Node.js >=22.0.0.
- pnpm >=12.0.0.
- Git repository.

**Production:**
- Packaged and distributed as a standard npm CLI package (`octate`).
- Binary entry via `package.json` `bin.octate` pointing to `./bin/octate` -> `dist/cli.js`.
- 100% local execution model: source files never leave developer machine for static analysis; AI inference uses encrypted NVIDIA API endpoints with sandwich prompt framing.

---

*Stack analysis: 2026-09-14*
*Update after major dependency changes*
