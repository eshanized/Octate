/**
 * Application layer review use case orchestrator.
 * Coordinates the full review pipeline across Layer 1 to Layer 5,
 * emitting the 8 canonical progress events and enforcing cancellation checks.
 */

import { collectDiagnostics } from '../analysis/diagnostics/index.js';
import { parseFiles } from '../analysis/parser/index.js';
import { extractSymbols } from '../analysis/symbols/index.js';
import type { Symbol as AnalysisSymbol } from '../analysis/types.js';
import { loadConfig } from '../config/merger.js';
import {
  createContextEngine,
  createPathResolver,
  createReferenceGraph,
  createSymbolIndex,
} from '../intelligence/index.js';
import { createLogger } from '../logging/index.js';
import { LocalNvidiaProvider } from '../model/index.js';
import { findGitRoot } from '../repository/discovery.js';
import { createFileFilter, shouldReviewSnapshotContent } from '../repository/filter.js';
import {
  filterDiffToFiles,
  listFilesAtReviewScope,
  readFileAtReviewScope,
} from '../repository/git.js';
import { resolveScope, type ScopeOptions } from '../repository/scope.js';
import { createReviewEngine } from '../review/engine.js';
import type { ReviewResult } from '../review/types.js';
import type { ReviewScope } from '../types/index.js';
import { OCTATE_VERSION } from '../version.js';
import type { CanonicalReviewStage, ReviewProgressStatus, ReviewUseCaseOptions } from './types.js';

const logger = createLogger('application:review');

export class ReviewUseCase {
  /**
   * Executes the end-to-end review lifecycle.
   *
   * @param options - Pipeline execution options
   * @returns Authoritative ReviewResult domain object
   */
  public async execute(options: ReviewUseCaseOptions = {}): Promise<ReviewResult> {
    const startTime = Date.now();
    const { signal, onProgress } = options;
    signal?.throwIfAborted();

    const emit = (
      stage: CanonicalReviewStage,
      status: ReviewProgressStatus,
      message: string,
      currentStep: number,
      payload?: Record<string, unknown> | undefined
    ) => {
      onProgress?.({
        stage,
        status,
        message,
        step: { current: currentStep, total: 8 },
        payload,
      });
    };

    // Stage 1: git:read (Step 1/8)
    emit('git:read', 'start', 'Reading repository state & diff', 1);
    const cwd = options.repoRoot ?? process.cwd();
    const repoRoot = (await findGitRoot(cwd)) ?? cwd;
    const scopeOptions: ScopeOptions = options.scopeOptions ?? {
      type: 'working-tree',
      repoRoot,
    };
    const scope = await resolveScope({
      ...scopeOptions,
      repoRoot: scopeOptions.repoRoot || repoRoot,
    });
    const tDiscovery = Date.now();
    signal?.throwIfAborted();
    emit('git:read', 'complete', `Discovered ${scope.files.length} changed files`, 1, {
      fileCount: scope.files.length,
      scopeType: scope.type,
    });

    // Short-circuit on empty scope
    if (scope.files.length === 0) {
      const modelName =
        (options.modelOverride as { modelName?: string } | undefined)?.modelName ??
        (options.modelOverride as { modelId?: string } | undefined)?.modelId ??
        'none';
      return createEmptyReviewResult(scope, modelName, Date.now() - startTime);
    }

    const config = options.config ?? (await loadConfig({}));
    const projectRules = [
      ...config.rules.map((rule) => `Project rule: ${rule}`),
      ...(config.architecture.boundaries.length > 0
        ? [`Architecture boundaries to preserve: ${config.architecture.boundaries.join(', ')}`]
        : []),
      ...(config.architecture.forbiddenDependencies.length > 0
        ? [
            `Forbidden dependencies and dependency directions: ${config.architecture.forbiddenDependencies.join(', ')}`,
          ]
        : []),
    ];
    const fileFilter = await createFileFilter(repoRoot, {
      additionalIgnorePatterns: config.ignore,
    });
    const shouldIncludeFile = fileFilter.createFilter();
    const binaryPaths = new Set(
      [
        ...scope.diff.matchAll(
          /^# Binary(?: file| or unresolved index entry) (.+) (?:differs|added|deleted)$/gm
        ),
      ]
        .map((match) => match[1])
        .filter((filePath): filePath is string => filePath !== undefined)
    );
    const candidates = scope.files
      .map((file) => file.path)
      .filter((filePath) => shouldIncludeFile(filePath) && !binaryPaths.has(filePath));

    // Read each changed file from its requested Git snapshot before applying
    // content-based filters; never consult the worktree for staged/commit reviews.
    const snapshotContents = new Map<string, string | null>();
    await Promise.all(
      candidates.map(async (file) => {
        snapshotContents.set(
          file,
          await readFileAtReviewScope(repoRoot, scope.type, scope.head, file)
        );
      })
    );

    const filePaths = candidates.filter((filePath) =>
      shouldReviewSnapshotContent(filePath, snapshotContents.get(filePath) ?? null)
    );
    const reviewDiff = filterDiffToFiles(scope.diff, filePaths);

    // Ignore rules or content filters can remove every file from an otherwise valid Git scope.
    if (filePaths.length === 0 || !reviewDiff.trim()) {
      const modelName =
        (options.modelOverride as { modelName?: string } | undefined)?.modelName ??
        (options.modelOverride as { modelId?: string } | undefined)?.modelId ??
        'none';
      return createEmptyReviewResult(scope, modelName, Date.now() - startTime);
    }

    const fileContents = new Map<string, string>(
      filePaths.map((file) => [file, snapshotContents.get(file) ?? ''])
    );

    const validFiles = filePaths.map((p) => ({
      path: p,
      content: fileContents.get(p) ?? '',
    }));

    // Stage 2: index:update (Step 2/8) — Decoupled AST parse & symbols
    emit('index:update', 'start', 'Updating cache & AST parse trees', 2);
    signal?.throwIfAborted();
    const parseResult = await parseFiles(validFiles, signal ? { signal } : {});
    const allSymbols: AnalysisSymbol[] = [];
    for (const parsedFile of parseResult.files) {
      try {
        const symbols = extractSymbols(parsedFile);
        parsedFile.symbols = symbols;
        allSymbols.push(...symbols);
      } catch (error) {
        logger.warn({ file: parsedFile.file, error }, 'Symbol extraction failed');
      }
    }
    const tParse = Date.now();
    emit('index:update', 'complete', `Parsed ${parseResult.files.length} files`, 2, {
      parsedCount: parseResult.files.length,
    });

    // Stage 3: symbols:resolve (Step 3/8)
    emit('symbols:resolve', 'start', 'Resolving changed symbols & reference graph', 3);
    signal?.throwIfAborted();
    const symbolIndex = createSymbolIndex(parseResult.files, fileContents);
    // Resolve imports against files that exist in the reviewed snapshot, not files
    // that happen to exist in the developer's current worktree.
    const snapshotPaths = await listFilesAtReviewScope(
      repoRoot,
      scope.type,
      scope.head ?? 'HEAD'
    );
    const pathResolver = await createPathResolver(repoRoot, {
      knownFiles: new Set(snapshotPaths),
    });
    const referenceGraph = createReferenceGraph(
      parseResult.files,
      symbolIndex,
      pathResolver,
      undefined,
      fileContents
    );
    const tSymbols = Date.now();
    emit('symbols:resolve', 'complete', `Indexed ${allSymbols.length} symbols`, 3, {
      symbolCount: allSymbols.length,
    });

    // Stage 4: diagnostics:collect (Step 4/8) — Decoupled static diagnostics
    emit('diagnostics:collect', 'start', 'Collecting static diagnostics', 4);
    signal?.throwIfAborted();
    const languages = Array.from(new Set(parseResult.files.map((f) => f.language)));
    const parsedFilePaths = parseResult.files.map((f) => f.file);
    let diagnosticsResult: { diagnostics: import('../model/types.js').Diagnostic[] } = {
      diagnostics: [],
    };
    try {
      if (scope.type === 'working-tree') {
        diagnosticsResult = await collectDiagnostics(parsedFilePaths, repoRoot, languages, signal);
      } else {
        logger.warn(
          { scopeType: scope.type },
          'Skipping filesystem-based diagnostics because the requested Git snapshot may differ from the worktree'
        );
      }
    } catch (error) {
      logger.warn({ error }, 'Diagnostic collection failed, continuing pipeline');
    }
    const tDiagnostics = Date.now();
    emit(
      'diagnostics:collect',
      'complete',
      `Collected ${diagnosticsResult.diagnostics.length} diagnostics`,
      4,
      { diagnosticCount: diagnosticsResult.diagnostics.length }
    );

    // Stage 5: context:build (Step 5/8)
    emit('context:build', 'start', 'Building and token-budgeting review context', 5);
    signal?.throwIfAborted();
    const contextEngine = createContextEngine();
    const reviewContext = await contextEngine.buildContext({
      changedFiles: filePaths,
      diff: reviewDiff,
      symbolIndex,
      referenceGraph,
      diagnostics: diagnosticsResult.diagnostics,
      readFile: async (file: string) => {
        if (fileContents.has(file)) return fileContents.get(file) ?? '';
        return (await readFileAtReviewScope(repoRoot, scope.type, scope.head, file)) ?? '';
      },
    });
    const tContext = Date.now();
    emit(
      'context:build',
      'complete',
      `Context assembled (${reviewContext.totalTokens} tokens)`,
      5,
      {
        totalTokens: reviewContext.totalTokens,
      }
    );

    // Stages 6-8: review:dag, review:critic, review:rank (Steps 6-8/8)
    signal?.throwIfAborted();
    const model = options.modelOverride ?? new LocalNvidiaProvider();
    const engine = createReviewEngine();

    const result = await engine.run({
      repoRoot,
      diff: reviewDiff,
      changedFiles: filePaths,
      reviewContext,
      referenceGraph,
      symbolIndex,
      diagnostics: diagnosticsResult.diagnostics,
      model,
      projectRules,
      config: config.review,
      readFileAtScope: async (file) => {
        if (fileContents.has(file)) return fileContents.get(file) ?? '';
        return readFileAtReviewScope(repoRoot, scope.type, scope.head, file);
      },
      signal,
      onProgress: options.onProgress
        ? (e) => options.onProgress?.(e as unknown as import('./types.js').ReviewProgressEvent)
        : undefined,
      scopeMetadata: {
        scopeType: scope.type,
        base: scope.base,
        head: scope.head,
      },
    });
    const tEngine = Date.now();
    const totalMs = tEngine - startTime;

    result.metadata.timings = {
      discoveryMs: tDiscovery - startTime,
      parseMs: tParse - tDiscovery,
      symbolsMs: tSymbols - tParse,
      diagnosticsMs: tDiagnostics - tSymbols,
      contextMs: tContext - tDiagnostics,
      modelMs: tEngine - tContext,
      totalMs,
    };
    result.summary.durationMs = totalMs;

    return result;
  }
}

/**
 * Builds a consistent empty result for scopes with no reviewable files.
 */
function createEmptyReviewResult(
  scope: ReviewScope,
  modelName: string,
  durationMs: number
): ReviewResult {
  return {
    summary: {
      totalFindings: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      byCategory: {
        correctness: 0,
        security: 0,
        performance: 0,
        architecture: 0,
        reliability: 0,
        maintainability: 0,
        compatibility: 0,
        testing: 0,
      },
      byReviewer: {},
      filesAnalyzed: 0,
      durationMs,
    },
    findings: [],
    metadata: {
      scopeType: scope.type,
      base: scope.base,
      head: scope.head,
      timestamp: new Date().toISOString(),
      version: OCTATE_VERSION,
      model: modelName,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      warnings: [],
      reviewersTriggered: [],
      criticInvoked: false,
      preCriticFindingCount: 0,
      postCriticFindingCount: 0,
    },
  };
}

/**
 * Factory function creating a new ReviewUseCase instance.
 */
export function createReviewUseCase(): ReviewUseCase {
  return new ReviewUseCase();
}
