# Changelog

All notable changes to Octate are documented here.

## [1.1.1] - 2026-10-17

### Fixed

- Replaced the stale development-version banner in the README with accurate package-version and release-note links.
- Changed npm package homepage metadata to the official Octate product website.
- Converted README links to changelog, release notes, configuration, CI/CD, troubleshooting, and benchmark documentation to stable GitHub URLs that work from the published npm README.
- Added release metadata validation to the package verification workflow so version, homepage, changelog, and release-note links cannot silently drift.
- Generalized GitHub release automation to validate versioned release notes and explicitly dispatch the npm publisher after creating the GitHub Release.

## [1.1.0] - 2026-10-17

### Fixed

- Corrected Git review-scope semantics so staged changes, working-tree changes, commits, and revision ranges are read from the intended snapshot.
- Improved diff handling for root commits, separate hunks, end-of-file newline changes, and file-mode changes.
- Made historical review context and evidence snapshot-aware, including cross-file import resolution, TypeScript path aliases, and common npm/pnpm workspace mappings.
- Hardened repository discovery for linked worktrees, symlink containment, Unicode-aware binary detection, and ignore-file handling.
- Corrected configuration precedence so layers only override values they explicitly define; invalid optional global configuration now falls back with a warning.
- Fixed cache size accounting, eviction and mutation behavior, initialization serialization, configuration hashing, project identity, and cancellation-listener cleanup.
- Updated the TUI to display source excerpts and diffs from the selected review scope and to calculate the final exit status from the latest re-review result.
- Made skipped or failed filesystem diagnostics visible in review metadata and console/TUI warnings.
- Corrected SARIF project metadata, generated configuration documentation links, repository links, and unsupported privacy and false-positive-rate claims.

### Tests

- Added and expanded regression coverage for Git snapshots and diffs, configuration precedence, linked worktrees, symlink and ignore behavior, cache accounting, workspace resolution, evidence consistency, cancellation, TUI re-reviews, and incomplete-analysis warnings.
- Validated with TypeScript typechecking, Biome linting, the unit/integration suite, and distribution-package verification in GitHub Actions.

## [1.0.0] - 2026-09-17

- Initial stable release of the terminal-native AI code review CLI.
- Introduced deterministic repository analysis, Tree-sitter parsing, symbol/reference intelligence, multi-stage AI review, an interactive terminal UI, and JSON/SARIF output.
