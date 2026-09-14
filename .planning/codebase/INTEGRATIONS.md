# External Integrations

**Analysis Date:** 2026-09-14

## APIs & External Services

**AI Model Inference:**
- **NVIDIA API** - Nemotron 3 Ultra 550B-A55B
  - Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions` (OpenAI-compatible chat completion endpoint)
  - Model ID: `nvidia/nemotron-3-ultra-550b-a55b`
  - Implementation: `LocalNvidiaProvider` in `src/model/providers/nvidia.ts` implementing the `ReviewModel` abstraction (`src/model/abstraction.ts`)
  - Transport: Native Node.js `fetch` + `AbortController` (zero external HTTP client dependencies)
  - Authentication: Bearer token via `NVIDIA_API_KEY` environment variable; missing credentials trigger typed `AuthenticationError` (exit code 4)
  - Concurrency: Bounded to 2 parallel model requests via `createPromisePool(2)` (`src/model/providers/resilience.ts`)
  - Resilience: 60s timeout, up to 3 retries on 429/5xx status codes with exponential backoff and `Retry-After` header parsing (`src/model/providers/resilience.ts`)
  - 2-Turn Schema Repair Loop: Automatically extracts Zod schema validation failures and formats targeted repair turns back to the model (`src/model/schema/repair.ts`)
  - Markdown Fence & JSON Extractor: Strips ````json code fences and cleans trailing commas before schema parsing (`src/model/schema/extractor.ts`)
  - Grounding: Strict file path verification against repository files and line number clamping against file line bounds (`src/model/schema/grounding.ts`)
  - Prompt Templates: Markdown prompt definitions (`src/model/prompts/reviewer.structural.v1.md`, `reviewer.semantic.v1.md`, `reviewer.security.v1.md`, `critic.v1.md`) rendered via regex template engine (`src/model/prompts/template.ts`) with in-memory fallbacks (`src/model/prompts/fallbacks.ts`)
  - Health Diagnostics: Verified via `octate doctor` (`src/commands/doctor.ts:checkNvidiaConnectivity()`)

**Language Parser WebAssembly Grammars:**
- **Tree-sitter WASM Grammars** - WebAssembly grammar distribution
  - Runtime: `web-tree-sitter`
  - Precompiled Binaries: `test-wasm/tree-sitter-typescript.wasm`, `test-wasm/tree-sitter-python.wasm`
  - Loader: `src/analysis/parser/languages.ts` & `src/analysis/parser/index.ts`

## Local Static Analysis Subprocesses

Octate runs deterministic local CLI linters, static analyzers, and test discovery tools inside the developer's repository before invoking AI reasoning:

| Tool | Language | Trigger Files / PATH | Command | Output Format | Normalization Handler |
|---|---|---|---|---|---|
| `tsc` | TypeScript/JS | `tsconfig.json` / PATH | `npx tsc --noEmit --pretty false` | Text lines (`file(line,col): error TS...`) | `src/analysis/diagnostics/severity.ts` |
| `biome` | TS/JS | `biome.json` / PATH | `npx biome check --formatter=json` | JSON diagnostic array | `src/analysis/diagnostics/severity.ts` |
| `ruff` | Python | `ruff.toml` / PATH | `ruff check --output-format=json .` | JSON array of violation objects | `src/analysis/diagnostics/severity.ts` |
| `mypy` | Python | `pyproject.toml` / PATH | `mypy --show-error-codes --no-error-summary .` | Text lines with error codes | `src/analysis/diagnostics/severity.ts` |
| `pyright` | Python | `pyrightconfig.json` / PATH | `pyright --outputjson` | JSON general diagnostics | `src/analysis/diagnostics/severity.ts` |
| `bandit` | Python | `pyproject.toml` / PATH | `bandit -f json -r .` | JSON security results array | `src/analysis/diagnostics/severity.ts` |
| `pytest` | Python | `pyproject.toml` / PATH | `pytest --collect-only -q` | Pytest session stdout | `src/analysis/diagnostics/severity.ts` |

**Subprocess Execution Protocol:**
- Managed by `src/cancellation/subprocess.ts:spawnWithSignal()`
- Bounded concurrency: Handled by `PromisePool` with a concurrency limit of 3 (`src/analysis/diagnostics/index.ts`)
- Graceful degradation: Failed tool executions log warnings and return empty diagnostic collections without aborting the review run
- Cancellation: Subprocess trees are terminated cleanly with `SIGTERM` followed by `SIGKILL` on AbortSignal

## Data Storage

**Databases:**
- None. Octate requires zero external database servers.

**File Storage:**
- **Local filesystem only** - Content-addressable storage at `~/.local/share/octate/{project-hash}/`
  - Subdirectories: `indexes/`, `cache/`, `findings/`, `logs/`
  - Project Identity: Derived via SHA256(repoRoot + remoteOriginUrl) truncated to 16 hex characters (`src/cache/identity.ts`)
  - Global Cache: `~/.local/share/octate/global/`

**Caching Subsystem:**
- **Cache Store**: Atomic file writes via temporary files and rename, LRU eviction (`src/cache/store.ts`)
- **Cache Keys**:
  - Analysis Cache Key: `contentHash:filePath:parserVersion:language:configHash`
  - Diagnostic Collection Key: Combined file hashes + tool list + config version (`diagnosticsKey`)
  - Tool Result Key: Tool name + tool version + file hashes + config version (`toolResultKey`)
  - Tool Version Caching: In-memory cache for `--version` command outputs (`getToolVersion`)
  - Config Version Hashing: SHA256 over repository configs (`tsconfig.json`, `biome.json`, `ruff.toml`, etc.)

## Authentication & Identity

**Authentication:**
- Static environment variable: `NVIDIA_API_KEY`
- No user accounts, credentials, or OAuth tokens stored on disk
- No per-seat billing or authentication servers

**Security Redaction:**
- Structured logging automatically redacts: `NVIDIA_API_KEY`, `apiKey`, `token`, `password`, `secret`, `authorization`, `x-api-key`, `apikey`

## Monitoring & Observability

**Error Tracking:**
- None (zero telemetry, zero phone-home behavior).

**Logging:**
- Pino structured JSON logging (`src/logging/index.ts`)
- Child loggers created per module (`createLogger('review/engine')`, `createLogger('application:review')`, etc.)
- Human-readable colorized output in development via `pino-pretty`
- Raw structured JSON output in production/automation mode

## CI/CD & Deployment

**Automation Output Formats:**
- **JSON**: Machine-readable full review output via `--json` (`src/renderers/json.ts`)
- **SARIF**: Static Analysis Results Interchange Format v2.1.0 via `--sarif` (`src/renderers/sarif.ts`)
- **Quiet**: Minimal one-line summary via `-q`/`--quiet` (`src/renderers/quiet.ts`)
- **Console**: Human-readable terminal text output (`src/renderers/console.ts`)
- **Interactive TUI**: Ink React-based terminal UI with live progress and keyboard navigation (`src/renderers/tui/renderer.ts`)

**Exit Code Policy Enforcement:**
- Enforced via `src/application/policy.ts`:
  - `--fail-on <severity>`: Evaluates finding severity thresholds (critical, high, medium, low, info)
  - Exit code 1 when blocking findings meet or exceed threshold
  - Exit code 0 when review succeeds with no blocking findings
  - Exit code 2 for configuration errors, 3 for repository errors, 4 for model errors, 5 for internal errors, 130 for cancellation

## Environment Configuration

**Required Environment Variables:**
- `NVIDIA_API_KEY` - API key for model reasoning (checked by `octate doctor`)

**Optional Environment Variables:**
- `LOG_LEVEL` - Log level (`debug`, `info`, `warn`, `error`)
- `NODE_ENV` - Set to `production` for raw JSON logs
- `XDG_CONFIG_HOME` - Override path for user config (`~/.config`)
- `HOME` / `USERPROFILE` - Base directory for local cache store

---

*Integration audit: 2026-09-14*
*Update when adding or modifying external service or subprocess integrations*
