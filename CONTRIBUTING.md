# Contributing to Octate 🐙

Thank you for your interest in contributing to Octate! We welcome issues, suggestions, and pull requests to make AI-assisted code review faster, more deterministic, and more trustworthy.

---

## Development Setup

### Prerequisites

- **Node.js**: `≥ 22.0.0`
- **pnpm**: `≥ 9.0.0`
- **NVIDIA API Key** (optional for mock testing, required for live inference)

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/vedanthq/Octate.git
   cd Octate
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Build the project (compiles TypeScript and bundles Tree-sitter WASM assets):
   ```bash
   pnpm run build
   ```

---

## Verification & Quality Gates

Before opening a pull request, ensure all verification checks pass:

```bash
# 1. Typecheck TypeScript files
pnpm run typecheck

# 2. Run Biome lint & style checks
pnpm run lint

# 3. Format code if needed
pnpm run format

# 4. Run Jest unit and integration tests
pnpm test

# 5. Verify packaging and tarball contents
pnpm run pack:check
```

---

## Testing & Benchmarks

Octate maintains a suite of golden fixtures under `test/fixtures/golden` covering security, structural, and semantic defects.

```bash
# Run the fast testbed integrity harness (mock model)
pnpm exec tsx benchmark/evaluate.ts

# Run the live pipeline evaluation against real NVIDIA endpoint (requires NVIDIA_API_KEY)
pnpm exec tsx benchmark/evaluate.ts --live --fixtures sql-injection
```

---

## Submitting Pull Requests

1. Create a descriptive feature branch (`git checkout -b feat/my-improvement`).
2. Commit your changes with clear, conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
3. Push to your fork and open a Pull Request using our template.
4. Verify that the GitHub Actions CI suite passes.
