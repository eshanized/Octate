/**
 * Deterministic Evidence Validation Engine for Review Findings.
 *
 * Validates finding evidence anchors against repository reality, git diffs, and filesystem bounds.
 * Classifies evidence into four canonical tiers:
 * - direct_changed: Line range intersects modified or added diff hunks
 * - indirect_context: Line range within a modified file but outside changed hunks
 * - baseline_context: Code in base revision or deleted files
 * - supporting_context: Unchanged file with documented causal connection to the patch
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ModelEvidence, ModelFinding } from '../model/types.js';
import type { LineInterval } from './heuristics.js';
import type { EvidenceTier } from './types.js';

/**
 * Comprehensive diff metadata per file.
 */
export interface FileDiffMetadata {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string | undefined;
  newPath?: string | undefined;
  addedModifiedLines: LineInterval[];
  deletedLines: LineInterval[];
}

/**
 * Detailed analysis of git diff.
 */
export interface ParsedDiffInfo {
  files: Map<string, FileDiffMetadata>;
  changedFiles: Set<string>;
  deletedFiles: Set<string>;
  renames: Map<string, string>; // oldPath -> newPath
}

/**
 * Options for evidence validator.
 */
export interface EvidenceValidatorOptions {
  repoRoot: string;
  diff?: string | undefined;
  changedFiles?: string[] | undefined;
  getFileContent?: ((file: string) => Promise<string | null>) | undefined;
  getFileLineCount?: ((file: string) => Promise<number | null>) | undefined;
  fileExists?: ((file: string) => Promise<boolean>) | undefined;
  isIgnoredFile?: ((file: string) => boolean) | undefined;
  baseRevision?: string | undefined;
  headRevision?: string | undefined;
}

/**
 * Result of validating a single evidence anchor.
 */
export interface ValidatedEvidenceItem {
  evidence: ModelEvidence;
  valid: boolean;
  tier: EvidenceTier;
  rejectionReason?: string | undefined;
}

/**
 * Result of validating all evidence for a finding.
 */
export interface EvidenceValidationResult {
  isValid: boolean;
  evidenceStrength: number; // 0 to 100
  hasDirectChangedEvidence: boolean;
  hasSupportingContext: boolean;
  validatedItems: ValidatedEvidenceItem[];
  validEvidence: ModelEvidence[];
  invalidEvidence: Array<{ evidence: ModelEvidence; reason: string }>;
  issues: string[];
}

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.bz2',
  '.xz',
  '.7z',
  '.exe',
  '.bin',
  '.dll',
  '.so',
  '.dylib',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.iso',
  '.dmg',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
]);

const GENERATED_OR_LOCK_EXTENSIONS = new Set([
  '.min.js',
  '.min.css',
  '.map',
  '.bundle.js',
  '.bundle.css',
]);

const GENERATED_OR_LOCK_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'composer.lock',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
]);

const COMMON_IGNORED_DIRS = [
  'node_modules/',
  '.git/',
  '.turbo/',
  '.next/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.cache/',
  'vendor/',
];

/**
 * Secret tokens and sensitive credential regexes for evidence sanitization.
 */
const SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  {
    // OpenAI / Anthropic / general API keys
    regex: /\b(sk-[a-zA-Z0-9_-]{20,})\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    // GitHub personal access tokens
    regex: /\b(gh[pousr]_[A-Za-z0-9_]{36,})\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    // AWS Access Key ID
    regex: /\b(AKIA[0-9A-Z]{16})\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  {
    // Bearer tokens
    regex: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  {
    // Private keys
    regex: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    // Password assignment strings
    regex: /(password|secret|passwd|apikey|api_key|access_token)\s*[:=]\s*['"][^'"]+['"]/gi,
    replacement: '$1: "[REDACTED]"',
  },
];

/**
 * Sanitizes sensitive tokens and credentials from evidence text.
 */
export function sanitizeSecretTokens(text: string): string {
  if (!text) return '';
  let sanitized = text;
  for (const { regex, replacement } of SECRET_PATTERNS) {
    sanitized = sanitized.replace(regex, replacement);
  }
  return sanitized;
}

/**
 * Checks whether a file path points to a known binary file.
 */
export function isBinaryPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Checks whether a file path points to a generated bundle or lockfile.
 */
export function isGeneratedOrLockPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = path.basename(lower);
  if (GENERATED_OR_LOCK_FILES.has(base)) {
    return true;
  }
  for (const ext of GENERATED_OR_LOCK_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a relative file path matches common ignored directories.
 */
export function isCommonIgnoredPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return COMMON_IGNORED_DIRS.some((dir) => normalized.startsWith(dir) || normalized.includes(`/${dir}`));
}

/**
 * Parses unified diff text into detailed file metadata including added/modified intervals,
 * deleted intervals, renames, and deletions.
 */
export function parseDetailedDiff(diff: string, defaultChangedFiles?: string[]): ParsedDiffInfo {
  const files = new Map<string, FileDiffMetadata>();
  const changedFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  const renames = new Map<string, string>();

  if (defaultChangedFiles) {
    for (const cf of defaultChangedFiles) {
      const norm = path.normalize(cf);
      changedFiles.add(norm);
      files.set(norm, {
        status: 'modified',
        oldPath: norm,
        newPath: norm,
        addedModifiedLines: [],
        deletedLines: [],
      });
    }
  }

  if (!diff?.trim()) {
    return { files, changedFiles, deletedFiles, renames };
  }

  const lines = diff.split('\n');
  let currentOldFile: string | null = null;
  let currentNewFile: string | null = null;
  let currentStatus: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified';
  let currentMeta: FileDiffMetadata | null = null;

  let oldLineCursor = 0;
  let newLineCursor = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Detect git diff header: diff --git a/path b/path
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (match) {
        currentOldFile = path.normalize(match[1] ?? '');
        currentNewFile = path.normalize(match[2] ?? '');
        changedFiles.add(currentNewFile);
        currentMeta = {
          status: 'modified',
          oldPath: currentOldFile,
          newPath: currentNewFile,
          addedModifiedLines: [],
          deletedLines: [],
        };
        files.set(currentNewFile, currentMeta);
      } else {
        currentOldFile = null;
        currentNewFile = null;
        currentMeta = null;
      }
      currentStatus = 'modified';
      continue;
    }

    // Detect file renames
    if (line.startsWith('rename from ')) {
      currentOldFile = path.normalize(line.slice(12).trim());
      currentStatus = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      currentNewFile = path.normalize(line.slice(10).trim());
      currentStatus = 'renamed';
      if (currentOldFile && currentNewFile) {
        renames.set(currentOldFile, currentNewFile);
      }
      continue;
    }

    // Detect deleted file mode
    if (line.startsWith('deleted file mode')) {
      currentStatus = 'deleted';
      continue;
    }

    // Detect old file header: --- a/path or --- /dev/null
    if (line.startsWith('--- ')) {
      const raw = line.slice(4).trim();
      if (raw !== '/dev/null') {
        currentOldFile = path.normalize(raw.replace(/^[ab]\//, ''));
      }
      continue;
    }

    // Detect new file header: +++ b/path or +++ /dev/null
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      if (raw === '/dev/null') {
        currentNewFile = null;
        currentStatus = 'deleted';
        if (currentOldFile) {
          deletedFiles.add(currentOldFile);
          files.set(currentOldFile, {
            status: 'deleted',
            oldPath: currentOldFile,
            addedModifiedLines: [],
            deletedLines: [],
          });
        }
      } else {
        currentNewFile = path.normalize(raw.replace(/^[ab]\//, ''));
        if (currentOldFile === null || currentOldFile === '/dev/null') {
          currentStatus = 'added';
        }
        const filePath = currentNewFile;
        changedFiles.add(filePath);
        currentMeta = {
          status: currentStatus,
          oldPath: currentOldFile ?? undefined,
          newPath: currentNewFile,
          addedModifiedLines: [],
          deletedLines: [],
        };
        files.set(filePath, currentMeta);
      }
      continue;
    }

    // Detect hunk header: @@ -oldStart,oldLen +newStart,newLen @@
    if (line.startsWith('@@ ')) {
      const match = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        oldLineCursor = parseInt(match[1] ?? '1', 10);
        newLineCursor = parseInt(match[3] ?? '1', 10);
      }
      continue;
    }

    // Process hunk lines
    if (currentMeta) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        // Added or modified line in new file
        const lineNum = newLineCursor;
        newLineCursor++;
        // Merge into current range if contiguous
        const lastRange = currentMeta.addedModifiedLines[currentMeta.addedModifiedLines.length - 1];
        if (lastRange && lastRange.end === lineNum - 1) {
          lastRange.end = lineNum;
        } else {
          currentMeta.addedModifiedLines.push({ start: lineNum, end: lineNum });
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // Deleted line in old file
        const lineNum = oldLineCursor;
        oldLineCursor++;
        const lastRange = currentMeta.deletedLines[currentMeta.deletedLines.length - 1];
        if (lastRange && lastRange.end === lineNum - 1) {
          lastRange.end = lineNum;
        } else {
          currentMeta.deletedLines.push({ start: lineNum, end: lineNum });
        }
      } else if (line.startsWith(' ')) {
        // Context line
        oldLineCursor++;
        newLineCursor++;
      }
    }
  }

  return { files, changedFiles, deletedFiles, renames };
}

/**
 * Checks whether a given line range overlaps with any line intervals.
 */
function intervalsOverlap(
  start: number,
  end: number,
  intervals: LineInterval[],
  tolerance = 1
): boolean {
  for (const interval of intervals) {
    if (start <= interval.end + tolerance && end >= interval.start - tolerance) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves file line count using options callbacks or filesystem.
 */
async function resolveLineCount(
  normalizedPath: string,
  options: EvidenceValidatorOptions
): Promise<number | null> {
  if (options.getFileLineCount) {
    return options.getFileLineCount(normalizedPath);
  }

  if (options.getFileContent) {
    const content = await options.getFileContent(normalizedPath);
    if (content !== null) {
      return content.split('\n').length;
    }
  }

  if (options.repoRoot) {
    try {
      const fullPath = path.resolve(options.repoRoot, normalizedPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return content.split('\n').length;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Checks file existence using options callbacks or filesystem.
 */
async function checkFileExists(
  normalizedPath: string,
  options: EvidenceValidatorOptions
): Promise<boolean> {
  if (options.fileExists) {
    return options.fileExists(normalizedPath);
  }

  if (options.getFileLineCount) {
    const count = await options.getFileLineCount(normalizedPath);
    return count !== null;
  }

  if (options.getFileContent) {
    const content = await options.getFileContent(normalizedPath);
    return content !== null;
  }

  // If file is explicitly in changedFiles, it exists in review scope
  if (
    options.changedFiles &&
    options.changedFiles.some(
      (cf) => path.normalize(cf) === normalizedPath || normalizedPath.endsWith(path.normalize(cf))
    )
  ) {
    return true;
  }

  if (options.repoRoot) {
    try {
      const rootStat = await fs.stat(options.repoRoot).catch(() => null);
      if (!rootStat) {
        return true;
      }
      const fullPath = path.resolve(options.repoRoot, normalizedPath);
      const stats = await fs.stat(fullPath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Validates a single evidence item against repo reality and diff context.
 */
export async function validateEvidenceItem(
  evidence: ModelEvidence,
  options: EvidenceValidatorOptions,
  parsedDiff: ParsedDiffInfo
): Promise<ValidatedEvidenceItem> {
  // 1. Path traversal / absolute path check
  if (
    evidence.file.includes('..') ||
    evidence.file.startsWith('/') ||
    path.isAbsolute(evidence.file)
  ) {
    return {
      evidence,
      valid: false,
      tier: 'supporting_context',
      rejectionReason: `Path traversal or absolute path not permitted: ${evidence.file}`,
    };
  }

  let normalizedFile = path.normalize(evidence.file).replace(/^[/\\]+/, '');
  if (!normalizedFile || normalizedFile.includes('..')) {
    return {
      evidence,
      valid: false,
      tier: 'supporting_context',
      rejectionReason: `Invalid path: ${evidence.file}`,
    };
  }

  // Handle renamed file resolution
  if (parsedDiff.renames.has(normalizedFile)) {
    normalizedFile = parsedDiff.renames.get(normalizedFile)!;
  }

  // 2. Ignored file check
  if (
    isCommonIgnoredPath(normalizedFile) ||
    (options.isIgnoredFile && options.isIgnoredFile(normalizedFile))
  ) {
    return {
      evidence,
      valid: false,
      tier: 'supporting_context',
      rejectionReason: `Evidence references ignored file: ${normalizedFile}`,
    };
  }

  // 3. Binary file check
  if (isBinaryPath(normalizedFile)) {
    return {
      evidence,
      valid: false,
      tier: 'supporting_context',
      rejectionReason: `Evidence references binary file: ${normalizedFile}`,
    };
  }

  // 4. Generated or lockfile check
  if (isGeneratedOrLockPath(normalizedFile)) {
    return {
      evidence,
      valid: false,
      tier: 'supporting_context',
      rejectionReason: `Evidence references generated or lock file: ${normalizedFile}`,
    };
  }

  // 5. Line numbers sanity
  const startLine = evidence.startLine;
  let endLine = evidence.endLine ?? startLine;

  if (startLine < 1) {
    return {
      evidence,
      valid: false,
      tier: 'supporting_context',
      rejectionReason: `Invalid startLine: ${startLine} (must be >= 1)`,
    };
  }

  if (endLine < startLine) {
    endLine = startLine;
  }

  // 6. Check deleted files vs head files
  const isDeleted = parsedDiff.deletedFiles.has(normalizedFile);
  const existsAtHead = isDeleted ? false : await checkFileExists(normalizedFile, options);

  if (!isDeleted && !existsAtHead) {
    return {
      evidence,
      valid: false,
      tier: 'supporting_context',
      rejectionReason: `File does not exist in repository: ${normalizedFile}`,
    };
  }

  // 7. Bounds check against total file lines
  if (existsAtHead) {
    const totalLines = await resolveLineCount(normalizedFile, options);
    if (totalLines !== null) {
      if (startLine > totalLines) {
        return {
          evidence,
          valid: false,
          tier: 'supporting_context',
          rejectionReason: `Start line ${startLine} exceeds total lines in file (${totalLines})`,
        };
      }
      if (endLine > totalLines) {
        endLine = totalLines;
      }
    }
  }

  // 8. Classify into 4 canonical tiers
  let tier: EvidenceTier;
  const isChangedFile =
    parsedDiff.changedFiles.has(normalizedFile) ||
    (options.changedFiles &&
      options.changedFiles.some(
        (cf) => path.normalize(cf) === normalizedFile || normalizedFile.endsWith(path.normalize(cf))
      ));

  if (isDeleted) {
    tier = 'baseline_context';
  } else if (isChangedFile) {
    const diffMeta = parsedDiff.files.get(normalizedFile);
    if (
      !diffMeta ||
      diffMeta.addedModifiedLines.length === 0 ||
      intervalsOverlap(startLine, endLine, diffMeta.addedModifiedLines)
    ) {
      tier = 'direct_changed';
    } else {
      tier = 'indirect_context';
    }
  } else {
    // Unchanged file
    tier = 'supporting_context';
    // Validate that supporting context has an explicit causal link
    const hasCausalLink = Boolean(evidence.causalLink && evidence.causalLink.trim().length > 0);
    const hasExplanation = Boolean(evidence.explanation && evidence.explanation.trim().length > 10);

    if (!hasCausalLink && !hasExplanation) {
      return {
        evidence,
        valid: false,
        tier: 'supporting_context',
        rejectionReason: `Supporting context in unchanged file "${normalizedFile}" requires an explicit causalLink or detailed technical explanation connecting it to the patch`,
      };
    }
  }

  // 9. Sanitize explanation and causal link
  const sanitizedExplanation = sanitizeSecretTokens(evidence.explanation ?? '');
  const sanitizedCausalLink = evidence.causalLink ? sanitizeSecretTokens(evidence.causalLink) : undefined;

  const validatedEvidence: ModelEvidence = {
    ...evidence,
    file: normalizedFile,
    startLine,
    endLine,
    tier,
    explanation: sanitizedExplanation,
    causalLink: sanitizedCausalLink,
  };

  return {
    evidence: validatedEvidence,
    valid: true,
    tier,
  };
}

/**
 * Validates all evidence items belonging to a finding and computes the deterministic evidence strength.
 */
export async function validateFindingEvidence(
  finding: ModelFinding,
  options: EvidenceValidatorOptions,
  parsedDiff?: ParsedDiffInfo | undefined
): Promise<EvidenceValidationResult> {
  const diffInfo = parsedDiff ?? parseDetailedDiff(options.diff ?? '', options.changedFiles);
  const issues: string[] = [];

  // 1. Primary anchor verification
  let primaryAnchorValid = true;
  if (
    finding.file.includes('..') ||
    finding.file.startsWith('/') ||
    path.isAbsolute(finding.file)
  ) {
    primaryAnchorValid = false;
    issues.push(`Finding primary file has invalid path: ${finding.file}`);
  } else {
    let normFindingFile = path.normalize(finding.file).replace(/^[/\\]+/, '');
    if (diffInfo.renames.has(normFindingFile)) {
      normFindingFile = diffInfo.renames.get(normFindingFile)!;
    }

    const isDeleted = diffInfo.deletedFiles.has(normFindingFile);
    const exists = isDeleted ? true : await checkFileExists(normFindingFile, options);

    if (!exists) {
      primaryAnchorValid = false;
      issues.push(`Finding targets non-existent file: ${normFindingFile}`);
    } else if (!isDeleted) {
      const totalLines = await resolveLineCount(normFindingFile, options);
      if (totalLines !== null && finding.startLine > totalLines) {
        primaryAnchorValid = false;
        issues.push(
          `Finding startLine ${finding.startLine} exceeds total lines in ${normFindingFile} (${totalLines})`
        );
      }
    }
  }

  // 2. Validate all evidence anchors
  const validatedItems: ValidatedEvidenceItem[] = [];
  const validEvidence: ModelEvidence[] = [];
  const invalidEvidence: Array<{ evidence: ModelEvidence; reason: string }> = [];

  const rawEvidence = finding.evidence ?? [];

  for (const ev of rawEvidence) {
    const itemResult = await validateEvidenceItem(ev, options, diffInfo);
    validatedItems.push(itemResult);
    if (itemResult.valid) {
      validEvidence.push(itemResult.evidence);
    } else {
      invalidEvidence.push({
        evidence: ev,
        reason: itemResult.rejectionReason ?? 'Unknown evidence validation error',
      });
      issues.push(itemResult.rejectionReason ?? 'Invalid evidence');
    }
  }

  // Check tiers present
  const hasDirectChangedEvidence = validEvidence.some((e) => e.tier === 'direct_changed');
  const hasSupportingContext = validEvidence.some((e) => e.tier === 'supporting_context');

  // Check if primary anchor itself is in changed lines
  let primaryInDiff = false;
  const normFindingFile = path.normalize(finding.file).replace(/^[/\\]+/, '');
  const isPrimaryChanged =
    diffInfo.changedFiles.has(normFindingFile) ||
    (options.changedFiles &&
      options.changedFiles.some(
        (cf) => path.normalize(cf) === normFindingFile || normFindingFile.endsWith(path.normalize(cf))
      ));
  const diffMeta = diffInfo.files.get(normFindingFile);
  if (isPrimaryChanged) {
    if (
      !diffMeta ||
      diffMeta.addedModifiedLines.length === 0 ||
      intervalsOverlap(finding.startLine, finding.endLine ?? finding.startLine, diffMeta.addedModifiedLines)
    ) {
      primaryInDiff = true;
    }
  }

  // 3. Compute deterministic evidence strength (0 to 100)
  let evidenceStrength = 0;

  if (validEvidence.length === 0 || !primaryAnchorValid) {
    evidenceStrength = 0;
  } else {
    // Base score for having valid evidence
    evidenceStrength = 20;

    // Direct changed evidence / anchor
    if (hasDirectChangedEvidence || primaryInDiff) {
      evidenceStrength += 40;
    }

    // Supporting context with causal link
    const supportingCount = validEvidence.filter((e) => e.tier === 'supporting_context').length;
    if (supportingCount > 0) {
      evidenceStrength += Math.min(20, supportingCount * 10);
    }

    // Indirect context
    const indirectCount = validEvidence.filter((e) => e.tier === 'indirect_context').length;
    if (indirectCount > 0) {
      evidenceStrength += Math.min(10, indirectCount * 5);
    }

    // Validity ratio bonus
    const ratio = validEvidence.length / rawEvidence.length;
    evidenceStrength += Math.round(ratio * 10);

    // Penalties for invalid / fabricated items
    const invalidPenalty = invalidEvidence.length * 25;
    evidenceStrength = Math.max(0, evidenceStrength - invalidPenalty);

    // Clamp between 0 and 100
    evidenceStrength = Math.min(100, Math.max(0, evidenceStrength));
  }

  const isValid = primaryAnchorValid && validEvidence.length > 0 && invalidEvidence.length === 0;

  return {
    isValid,
    evidenceStrength,
    hasDirectChangedEvidence: hasDirectChangedEvidence || primaryInDiff,
    hasSupportingContext,
    validatedItems,
    validEvidence,
    invalidEvidence,
    issues,
  };
}

/**
 * Validates evidence for all findings in batch.
 */
export async function validateAllFindingsEvidence(
  findings: ModelFinding[],
  options: EvidenceValidatorOptions
): Promise<{
  findings: ModelFinding[];
  results: Map<ModelFinding, EvidenceValidationResult>;
}> {
  const parsedDiff = parseDetailedDiff(options.diff ?? '', options.changedFiles);
  const results = new Map<ModelFinding, EvidenceValidationResult>();
  const updatedFindings: ModelFinding[] = [];

  for (const finding of findings) {
    const result = await validateFindingEvidence(finding, options, parsedDiff);
    results.set(finding, result);

    // Update finding with validated evidence
    updatedFindings.push({
      ...finding,
      evidence: result.validEvidence,
    });
  }

  return {
    findings: updatedFindings,
    results,
  };
}
