# Codebase Concerns

**Analysis Date:** 2026-09-14

## Tech Debt

### [Subprocess Tool Invocation via `npx`]
- **Issue:** `src/analysis/diagnostics/tools.ts` executes TypeScript and Biome linters using `npx tsc` and `npx biome`.
- **Files:** `src/analysis/diagnostics/tools.ts`
- **Impact:** In environments where npm is present but local packages are not installed globally, `npx` emits notice logs (`npm notice run npx`, `This is not the tsc command you are looking for`) and introduces 1–2 seconds of process startup latency per invocation.
- **Fix approach:** Check for local project binaries in `./node_modules/.bin/tsc` and `./node_modules/.bin/biome` before falling back to `npx` or system PATH.

### [Scope Resolution - Empty Staged and Working File Lists]
- **Issue:** `getStagedFiles()` and `getWorkingFiles()` in `src/repository/scope.ts:152-165` return empty arrays (`return [];`).
- **Files:** `src/repository/scope.ts`
- **Impact:** If `getStagedFiles()` is called directly instead of extracting file lists from `ReviewScope.diff`, the file array is empty. Currently, `resolveScope()` derives changed files from unified diff patches, masking this limitation.
- **Fix approach:** Implement working and staged file listing using isomorphic-git's `statusMatrix`, consistent with the diff generation logic in `src/repository/git.ts`.

### [Scope Resolution - Simplified Merge Base]
- **Issue:** `findMergeBase()` in `src/repository/scope.ts:170-192` returns `ref1` as the base instead of computing the true common ancestor commit.
- **Files:** `src/repository/scope.ts`
- **Impact:** Three-dot range diffs (`--range base...head`) and branch reviews (`--branch feature`) compute diffs directly against the branch ref rather than the merge-base fork point.
- **Fix approach:** Implement commit graph traversal or use isomorphic-git's common ancestor utilities.

### [Cache Store - Directory Size Calculation on Init & O(n) Eviction Scan]
- **Issue:** `initialize()` in `src/cache/store.ts` recursively traverses the cache directory on startup to calculate total size, and `ensureSpace()` re-scans all files to find the oldest entries for eviction.
- **Files:** `src/cache/store.ts`
- **Impact:** As the cache grows toward its default limit (500MB), startup time and write latency degrade.
- **Fix approach:** Persist total size and an LRU index in a single `metadata.json` index file, updating it incrementally during writes and evictions.

## Known Bugs

### [Jest Worker Teardown / Open Handles Warning]
- **Issue:** When running the full test suite (`pnpm test`), Jest occasionally outputs: `A worker process has failed to exit gracefully and has been force exited. This is likely caused by tests leaking due to improper teardown.`
- **Files:** `jest.config.ts`, `src/cancellation/subprocess.ts`, `src/analysis/diagnostics/`
- **Impact:** All 81 test suites and 947 tests pass 100%, but worker force-exit warnings appear in the terminal output.
- **Fix approach:** Audit child process streams and unref'd timers in subprocess integration tests, ensuring explicit `.unref()` or cleanup in `afterEach`/`afterAll` hooks.

### [PromisePool.iterate() - Unstable Async Iteration]
- **Issue:** The `iterate()` method in `src/cache/pool.ts:61-100` uses `Promise.race([p, Promise.resolve(null)])`, which resolves to `null` immediately and fails to track task completion properly.
- **Files:** `src/cache/pool.ts`
- **Impact:** If `iterate()` is called, it yields invalid results. (Note: `run()`, `runAll()`, and `map()` are tested and working properly; the review DAG and diagnostic runner use `run()`, avoiding this issue).
- **Fix approach:** Re-implement `iterate()` using an async generator queue or deprecate the unused method.

### [Subprocess Timeout Detection Flag]
- **Issue:** In `src/cancellation/subprocess.ts:86-135`, `timeoutHandle` is cleared in `cleanup()` before the `close` event handler checks `if (timeout && timeoutHandle)`.
- **Files:** `src/cancellation/subprocess.ts`
- **Impact:** Subprocesses terminated by a timeout may occasionally be reported as generic process errors or cancellations rather than specific timeout errors.
- **Fix approach:** Set a dedicated boolean flag `timedOut = true` inside the timeout timer callback.

## Security Considerations

### [Git Remote URL Credentials in Cache Identity Hash]
- **Issue:** `computeProjectIdentity()` in `src/cache/identity.ts:40-49` hashes the Git remote URL (`git config --get remote.origin.url`). If a repository remote contains embedded personal access tokens (e.g., `https://token@github.com/...`), credentials are included in the SHA-256 hash.
- **Files:** `src/cache/identity.ts`
- **Risk:** While the hash is irreversible (SHA-256 truncated to 16 hex characters), exposing the remote URL in debug logs could reveal sensitive tokens.
- **Mitigation:** Strip credentials from URLs before computing project identity: `url.replace(/\/\/[^@]+@/, '//')`.

### [Prompt Injection via Malicious Repository Content]
- **Issue:** Attackers could craft repository diffs, commit messages, or comments containing jailbreak instructions attempting to manipulate review verdicts or suppress findings.
- **Files:** `src/intelligence/context/serializer.ts`, `src/model/prompts/`
- **Current mitigation:** Sandwich prompt framing strictly segregates untrusted repository text inside XML envelopes (`<diff>`, `<context_item>`). Trusted system instructions and guardrails are placed outside untrusted boundaries. The model is explicitly instructed to treat repository content purely as passive data.

### [Subprocess Argument Safety]
- **Issue:** Static analysis tools (`tsc`, `biome`, `ruff`, etc.) are spawned as child processes inside user repositories.
- **Files:** `src/analysis/diagnostics/tools.ts`, `src/cancellation/subprocess.ts`
- **Current mitigation:** `spawnWithSignal` uses `child_process.spawn` with discrete argument arrays (never `child_process.exec` with shell interpolation). Repository-defined configurations (`tsconfig.json`, `biome.json`) govern tool execution.

## Performance Bottlenecks & Fragile Areas

### [Tree-sitter WASM Binary Resolution in Distributed CLI Package]
- **Issue:** Tree-sitter WebAssembly grammars are stored in `test-wasm/` in the project root. `src/analysis/parser/languages.ts` resolves grammars relative to the execution working directory or repository root.
- **Files:** `src/analysis/parser/languages.ts`, `scripts/copy-wasm.cjs`
- **Impact:** When installed globally as an npm package (`npm i -g octate`), the relative path `test-wasm/` is not present in the user's current directory.
- **Improvement path:** Copy `.wasm` files into `dist/wasm/` during build and resolve them using `fileURLToPath(import.meta.url)` to guarantee reliable resolution across all global and local installations.

### [Subprocess Concurrency & Resource Spikes]
- **Issue:** Spawning multiple static analysis tools (`tsc`, `biome`, `ruff`, `mypy`, `pyright`, `bandit`, `pytest`) can create CPU and memory spikes on large repositories.
- **Current mitigation:** Concurrency is bounded to 3 parallel jobs via `PromisePool` in `src/analysis/diagnostics/index.ts`.
- **Improvement path:** Scale concurrency dynamically based on hardware resources (`os.availableParallelism?.() ?? 4`).

### [Large Diff Token Budget Exhaustion]
- **Issue:** Massive diffs (e.g. large lockfile changes, generated code, or major migrations) can exceed the model's 128k context window.
- **Current mitigation:** Binary/generated file filtering in `src/repository/filter.ts`, token budgeting in `src/intelligence/context/budget.ts`, and snippet windowing in `src/intelligence/context/windowing.ts` truncate oversized inputs.

---

*Concerns audit: 2026-09-14*
*Maintained under GSD codebase documentation guidelines*
