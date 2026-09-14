/**
 * Deterministic Patch Attribution Engine.
 *
 * Categorizes findings relative to the patch under review:
 * - introduced_by_patch: Defect was introduced directly in newly added/modified code
 * - worsened_by_patch: Pre-existing defect exacerbated by patch or triggered by new callers
 * - pre_existing: Baseline defect in unchanged lines, not caused by this patch
 * - fixed_by_patch: Defect was resolved or deleted in this patch
 * - unrelated_to_patch: Defect in an unrelated file with no causal connection
 * - unknown: Insufficient diff context to determine attribution
 */

import path from 'node:path';
import type { ModelFinding } from '../model/types.js';
import { parseDetailedDiff, type ParsedDiffInfo } from './evidence-validator.js';
import type { PatchAttribution } from './types.js';

export interface AttributionOptions {
  diff?: string | undefined;
  changedFiles?: string[] | undefined;
  parsedDiff?: ParsedDiffInfo | undefined;
}

/**
 * Checks whether a line range overlaps with any line intervals.
 */
function rangesOverlap(
  start: number,
  end: number,
  intervals: Array<{ start: number; end: number }>
): boolean {
  for (const range of intervals) {
    if (start <= range.end + 1 && end >= range.start - 1) {
      return true;
    }
  }
  return false;
}

/**
 * Determines the deterministic patch attribution for a finding based on diff analysis and evidence tiers.
 */
export function determinePatchAttribution(
  finding: ModelFinding,
  options: AttributionOptions
): PatchAttribution {
  const diffInfo =
    options.parsedDiff ?? parseDetailedDiff(options.diff ?? '', options.changedFiles);

  const normFindingFile = path.normalize(finding.file).replace(/^[/\\]+/, '');

  // 1. Check if the file is deleted in the patch
  if (diffInfo.deletedFiles.has(normFindingFile)) {
    const isFixClaim =
      finding.title.toLowerCase().includes('fixed') ||
      finding.message.toLowerCase().includes('removed') ||
      finding.message.toLowerCase().includes('deleted');
    return isFixClaim ? 'fixed_by_patch' : 'pre_existing';
  }

  // 2. Check if the file was touched in the diff / changedFiles
  const isChangedFile =
    diffInfo.changedFiles.has(normFindingFile) ||
    (options.changedFiles &&
      options.changedFiles.some(
        (cf) =>
          path.normalize(cf) === normFindingFile || normFindingFile.endsWith(path.normalize(cf))
      ));

  if (!isChangedFile) {
    // Finding is in an unchanged file
    // Check if there is a documented causal link connecting it to changed code
    const hasCausalConnection = finding.evidence?.some(
      (e) =>
        Boolean(e.causalLink && e.causalLink.trim().length > 0) || e.tier === 'supporting_context'
    );

    if (hasCausalConnection) {
      return 'worsened_by_patch';
    }

    return 'unrelated_to_patch';
  }

  // 3. File was changed in the patch; check diff hunk intersection
  const diffMeta = diffInfo.files.get(normFindingFile);
  const start = finding.startLine;
  const end = finding.endLine ?? start;

  if (diffMeta) {
    const isFixClaim =
      finding.title.toLowerCase().includes('fixed') ||
      finding.message.toLowerCase().includes('removed') ||
      finding.message.toLowerCase().includes('deleted') ||
      finding.introducedByPatch === 'fixed_by_patch';

    if (
      isFixClaim &&
      diffMeta.deletedLines.length > 0 &&
      rangesOverlap(start, end, diffMeta.deletedLines)
    ) {
      return 'fixed_by_patch';
    }

    // If diff has modified lines, check for overlap
    if (diffMeta.addedModifiedLines.length > 0) {
      if (rangesOverlap(start, end, diffMeta.addedModifiedLines)) {
        return 'introduced_by_patch';
      }

      // Check if any evidence item intersects added/modified lines
      if (finding.evidence && finding.evidence.length > 0) {
        for (const ev of finding.evidence) {
          const normEvFile = path.normalize(ev.file).replace(/^[/\\]+/, '');
          if (normEvFile === normFindingFile) {
            const evStart = ev.startLine;
            const evEnd = ev.endLine ?? evStart;
            if (rangesOverlap(evStart, evEnd, diffMeta.addedModifiedLines)) {
              return 'introduced_by_patch';
            }
          }
        }
      }

      // If line range overlaps deleted lines only
      if (diffMeta.deletedLines.length > 0 && rangesOverlap(start, end, diffMeta.deletedLines)) {
        return 'fixed_by_patch';
      }

      // Lines are in a modified file, but outside the modified hunks
      // Check if evidence links this to the modified hunks
      const hasCausalLink = finding.evidence?.some((e) =>
        Boolean(e.causalLink && e.causalLink.trim().length > 0)
      );

      if (hasCausalLink) {
        return 'worsened_by_patch';
      }

      return 'pre_existing';
    }

    // Headerless or unparsed diff: if file is in changedFiles, default to introduced_by_patch
    return 'introduced_by_patch';
  }

  // Fallback based on evidence tiers
  if (finding.evidence?.some((e) => e.tier === 'direct_changed')) {
    return 'introduced_by_patch';
  }

  if (finding.evidence?.some((e) => e.tier === 'supporting_context')) {
    return 'worsened_by_patch';
  }

  return 'pre_existing';
}

/**
 * Attributes a batch of findings against patch diff.
 */
export function attributeAllFindings(
  findings: ModelFinding[],
  options: AttributionOptions
): ModelFinding[] {
  const diffInfo =
    options.parsedDiff ?? parseDetailedDiff(options.diff ?? '', options.changedFiles);

  return findings.map((f) => {
    const attribution = determinePatchAttribution(f, { ...options, parsedDiff: diffInfo });
    return {
      ...f,
      introducedByPatch: attribution,
    };
  });
}
