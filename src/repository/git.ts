/**
 * Git operations using isomorphic-git.
 * Provides diff, status, rev-parse, log, and ref resolution.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { GitIndexManager } from 'isomorphic-git/managers';
import { FileSystem } from 'isomorphic-git/models';
import { createGitError } from '../errors/index.js';
import { createLogger } from '../logging/index.js';
import type { FileChange, ReviewScope } from '../types/index.js';

const logger = createLogger('repository:git');

// Use Node.js fs promises as the filesystem adapter
const fsAdapter = fs;
const indexFs = new FileSystem(fsAdapter);

/**
 * Resolves a Git ref to a commit hash.
 *
 * @param repoRoot - Repository root directory
 * @param ref - Git ref (HEAD, branch name, tag, SHA, HEAD~1, etc.)
 * @returns Commit hash (OID)
 * @throws GitError if ref cannot be resolved
 */
export async function resolveRef(repoRoot: string, ref: string): Promise<string> {
  if (!ref || typeof ref !== 'string' || ref.trim() === '') {
    throw createGitError('Git reference cannot be empty', { repoRoot, ref });
  }

  const trimmedRef = ref.trim();
  const gitDir = await findGitDir(repoRoot);

  // Parse relative revision modifiers: e.g. HEAD~1, HEAD~, HEAD^2, HEAD^^, <sha>~3
  const relIndex = trimmedRef.search(/[~^]/);
  let baseRef = trimmedRef;
  let modifiersStr = '';

  if (relIndex !== -1) {
    baseRef = trimmedRef.slice(0, relIndex);
    modifiersStr = trimmedRef.slice(relIndex);

    if (!baseRef) {
      throw createGitError(
        `Invalid revision "${trimmedRef}": missing base revision before modifier`,
        { repoRoot, ref: trimmedRef }
      );
    }

    if (!/^([~^]\d*)+$/.test(modifiersStr)) {
      throw createGitError(`Invalid revision syntax "${trimmedRef}"`, {
        repoRoot,
        ref: trimmedRef,
      });
    }
  }

  // Resolve baseRef to a commit OID
  let oid: string | undefined;

  // 1. Try resolving as a symbolic ref (HEAD, branch name, tag, etc.)
  try {
    oid = await git.resolveRef({ fs: fsAdapter, dir: repoRoot, gitdir: gitDir, ref: baseRef });
  } catch {
    // 2. Try resolving as commit OID (abbreviated or full 40-char SHA)
    if (/^[0-9a-fA-F]{4,40}$/.test(baseRef)) {
      try {
        oid = await git.expandOid({
          fs: fsAdapter,
          dir: repoRoot,
          gitdir: gitDir,
          oid: baseRef.toLowerCase(),
        });
      } catch {
        // Not a known object OID
      }
    }
  }

  if (!oid) {
    // Check if repository is empty
    const validRefs = await listRefs(repoRoot).catch(() => []);
    if (validRefs.length === 0) {
      throw createGitError(`Repository has no commits; cannot resolve ref "${trimmedRef}"`, {
        repoRoot,
        ref: trimmedRef,
      });
    }

    throw createGitError(`Failed to resolve ref "${trimmedRef}"`, {
      ref: trimmedRef,
      validRefs: validRefs.slice(0, 10),
      suggestion:
        validRefs.length > 0
          ? `Valid refs include: ${validRefs.slice(0, 5).join(', ')}`
          : undefined,
    });
  }

  // Ensure peeled to commit if baseRef was an annotated tag
  try {
    const commitObj = await git.readCommit({
      fs: fsAdapter,
      dir: repoRoot,
      gitdir: gitDir,
      oid,
    });
    oid = commitObj.oid;
  } catch (error) {
    throw createGitError(`Object "${oid}" for ref "${baseRef}" is not a valid commit`, {
      repoRoot,
      ref: trimmedRef,
      oid,
      error: String(error),
    });
  }

  // If there are revision modifiers (~ and/or ^), step through ancestors
  if (modifiersStr) {
    const modifierRegex = /([~^])(\d*)/g;
    let match = modifierRegex.exec(modifiersStr);
    while (match !== null) {
      const op = match[1];
      const numStr = match[2];
      const count = !numStr ? 1 : parseInt(numStr, 10);

      if (count === 0) {
        // e.g. HEAD~0 or HEAD^0 refers to the commit itself
        match = modifierRegex.exec(modifiersStr);
        continue;
      }

      if (op === '~') {
        for (let step = 0; step < count; step++) {
          const commitObj = await git.readCommit({
            fs: fsAdapter,
            dir: repoRoot,
            gitdir: gitDir,
            oid,
          });
          const parents = commitObj.commit.parent;
          if (!parents || parents.length === 0) {
            throw createGitError(
              `Commit ${oid} has no parent (reached root commit while resolving "${trimmedRef}")`,
              { repoRoot, ref: trimmedRef, commit: oid, step }
            );
          }
          oid = parents[0]!;
        }
      } else if (op === '^') {
        const commitObj = await git.readCommit({
          fs: fsAdapter,
          dir: repoRoot,
          gitdir: gitDir,
          oid,
        });
        const parents = commitObj.commit.parent;
        const parentIndex = count - 1;
        if (!parents || parentIndex < 0 || parentIndex >= parents.length) {
          throw createGitError(
            `Commit ${oid} does not have parent ${count} (found ${parents ? parents.length : 0} parents while resolving "${trimmedRef}")`,
            { repoRoot, ref: trimmedRef, commit: oid, parentIndex: count }
          );
        }
        oid = parents[parentIndex]!;
      }
      match = modifierRegex.exec(modifiersStr);
    }
  }

  logger.debug({ ref: trimmedRef, oid }, 'Resolved ref');
  return oid;
}

/**
 * Finds the .git directory (handles both directory and file cases for worktrees).
 */
export async function findGitDir(repoRoot: string): Promise<string> {
  const gitDir = path.join(repoRoot, '.git');

  try {
    const stat = await fs.stat(gitDir);
    if (stat.isDirectory()) {
      return gitDir;
    }
    if (stat.isFile()) {
      // Worktree case: .git is a file pointing to the actual git dir
      const content = await fs.readFile(gitDir, 'utf-8');
      const match = content.match(/gitdir: (.+)/);
      if (match?.[1]) {
        const actualGitDir = match[1].trim();
        // Handle relative paths
        return path.isAbsolute(actualGitDir) ? actualGitDir : path.join(repoRoot, actualGitDir);
      }
    }
  } catch {
    // Fall through to default
  }

  return gitDir;
}

/**
 * Lists all refs in the repository.
 */
async function listRefs(repoRoot: string): Promise<string[]> {
  try {
    const gitDir = await findGitDir(repoRoot);
    const refs = await git.listRefs({ fs: fsAdapter, dir: repoRoot, gitdir: gitDir });
    return refs.map((r) => (r as { ref?: string }).ref ?? '');
  } catch {
    return [];
  }
}

/**
 * Gets the commit log for a repository.
 *
 * @param repoRoot - Repository root directory
 * @param options - Log options
 * @returns Array of commit objects
 */
export async function getLog(
  repoRoot: string,
  options: { ref?: string; depth?: number } = {}
): Promise<
  Array<{
    oid: string;
    message: string;
    author: { name: string; email: string; timestamp: number };
  }>
> {
  try {
    const gitDir = await findGitDir(repoRoot);
    const log = await git.log({
      fs: fsAdapter,
      dir: repoRoot,
      gitdir: gitDir,
      ref: options.ref,
      depth: options.depth ?? 100,
    });

    return log.map((commit) => ({
      oid: commit.oid,
      message: commit.commit.message.trim(),
      author: {
        name: commit.commit.author.name,
        email: commit.commit.author.email,
        timestamp: commit.commit.author.timestamp,
      },
    }));
  } catch (error) {
    throw createGitError('Failed to get commit log', { repoRoot, error: String(error) });
  }
}

/**
 * Gets the status of files in the working tree.
 *
 * @param repoRoot - Repository root directory
 * @returns Status matrix entries
 */
export async function getStatus(
  repoRoot: string
): Promise<Array<[string, number, number, number]>> {
  try {
    const gitDir = await findGitDir(repoRoot);
    const matrix = await git.statusMatrix({ fs: fsAdapter, dir: repoRoot, gitdir: gitDir });
    return matrix;
  } catch (error) {
    throw createGitError('Failed to get status', { repoRoot, error: String(error) });
  }
}

/**
 * Gets the diff between two commits/refs.
 *
 * @param repoRoot - Repository root directory
 * @param base - Base ref/commit
 * @param head - Head ref/commit
 * @returns Unified diff string
 */
export async function getDiff(repoRoot: string, base: string, head: string): Promise<string> {
  try {
    const gitDir = await findGitDir(repoRoot);

    // Resolve refs to commit OIDs
    const baseOid = await resolveRef(repoRoot, base);
    const headOid = await resolveRef(repoRoot, head);

    // Get the tree OIDs for both commits
    const baseCommit = await git.readCommit({
      fs: fsAdapter,
      dir: repoRoot,
      gitdir: gitDir,
      oid: baseOid,
    });
    const headCommit = await git.readCommit({
      fs: fsAdapter,
      dir: repoRoot,
      gitdir: gitDir,
      oid: headOid,
    });

    const baseTreeOid = baseCommit.commit.tree;
    const headTreeOid = headCommit.commit.tree;

    // Use walk to generate diff
    const diffs: string[] = [];

    await git.walk({
      fs: fsAdapter,
      dir: repoRoot,
      gitdir: gitDir,
      trees: [git.TREE({ ref: baseTreeOid }), git.TREE({ ref: headTreeOid })],
      map: async (filepath, [baseEntry, headEntry]) => {
        if (filepath === '.') return;

        const baseType = baseEntry ? await baseEntry.type() : undefined;
        const headType = headEntry ? await headEntry.type() : undefined;

        // Skip directories
        if (baseType === 'tree' || headType === 'tree') return;

        const baseBlobOid = baseEntry ? await baseEntry.oid() : undefined;
        const headBlobOid = headEntry ? await headEntry.oid() : undefined;

        // Skip unchanged files
        if (baseBlobOid === headBlobOid) return;

        let status: FileChange['status'] = 'modified';
        if (baseBlobOid === undefined && headBlobOid !== undefined) status = 'added';
        if (baseBlobOid !== undefined && headBlobOid === undefined) status = 'deleted';

        // Read file contents for diff
        let diff = '';
        if (status !== 'deleted' && headBlobOid) {
          try {
            const headBlob = await git.readBlob({
              fs: fsAdapter,
              dir: repoRoot,
              gitdir: gitDir,
              oid: headBlobOid,
            });
            const headContent = Buffer.from(headBlob.blob).toString('utf-8');
            if (status === 'added') {
              diff = generateAddedDiff(filepath, headContent);
            } else if (baseBlobOid) {
              const baseBlob = await git.readBlob({
                fs: fsAdapter,
                dir: repoRoot,
                gitdir: gitDir,
                oid: baseBlobOid,
              });
              const baseContent = Buffer.from(baseBlob.blob).toString('utf-8');
              diff = generateUnifiedDiff(filepath, baseContent, headContent);
            }
          } catch {
            // Binary file or read error
            diff = `# Binary file ${filepath} differs\n`;
          }
        } else if (status === 'deleted' && baseBlobOid) {
          try {
            const baseBlob = await git.readBlob({
              fs: fsAdapter,
              dir: repoRoot,
              gitdir: gitDir,
              oid: baseBlobOid,
            });
            const baseContent = Buffer.from(baseBlob.blob).toString('utf-8');
            diff = generateDeletedDiff(filepath, baseContent);
          } catch {
            diff = `# Binary file ${filepath} deleted\n`;
          }
        }

        diffs.push(diff);
      },
    });

    return diffs.join('\n');
  } catch (error) {
    throw createGitError('Failed to get diff', { repoRoot, base, head, error: String(error) });
  }
}

/**
 * Splits text into logical lines without counting the final line terminator as a line.
 */
function splitContentLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

type DiffOperation = {
  kind: 'context' | 'remove' | 'add';
  line: string;
  oldLine: number;
  newLine: number;
};

/**
 * Creates a deterministic line edit script. LCS keeps ordinary source diffs
 * readable; very large comparisons use a bounded prefix/suffix fallback.
 */
function createDiffOperations(oldLines: string[], newLines: string[]): DiffOperation[] {
  let operations: DiffOperation[] = [];
  if (oldLines.length * newLines.length <= 1_000_000) {
    const lcs = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
    for (let i = oldLines.length - 1; i >= 0; i--) {
      const row = lcs[i];
      const nextRow = lcs[i + 1];
      if (!row || !nextRow) continue;
      for (let j = newLines.length - 1; j >= 0; j--) {
        row[j] = oldLines[i] === newLines[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
      }
    }

    let i = 0;
    let j = 0;
    let oldLine = 1;
    let newLine = 1;
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        operations.push({ kind: 'context', line: oldLines[i] ?? '', oldLine, newLine });
        i++; j++; oldLine++; newLine++;
      } else if (
        i < oldLines.length &&
        (j >= newLines.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
      ) {
        operations.push({ kind: 'remove', line: oldLines[i] ?? '', oldLine, newLine });
        i++; oldLine++;
      } else {
        operations.push({ kind: 'add', line: newLines[j] ?? '', oldLine, newLine });
        j++; newLine++;
      }
    }
    return operations;
  }

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  let oldLine = 1;
  let newLine = 1;
  for (let k = 0; k < prefix; k++) {
    operations.push({ kind: 'context', line: oldLines[k] ?? '', oldLine, newLine });
    oldLine++; newLine++;
  }
  for (let k = prefix; k < oldLines.length - suffix; k++) {
    operations.push({ kind: 'remove', line: oldLines[k] ?? '', oldLine, newLine });
    oldLine++;
  }
  for (let k = prefix; k < newLines.length - suffix; k++) {
    operations.push({ kind: 'add', line: newLines[k] ?? '', oldLine, newLine });
    newLine++;
  }
  for (let k = oldLines.length - suffix; k < oldLines.length; k++) {
    operations.push({ kind: 'context', line: oldLines[k] ?? '', oldLine, newLine });
    oldLine++; newLine++;
  }
  return operations;
}

/**
 * Generates a unified diff with correctly counted lines and separate hunks.
 */
function generateUnifiedDiff(filepath: string, oldContent: string, newContent: string): string {
  const oldLines = splitContentLines(oldContent);
  const newLines = splitContentLines(newContent);
  const operations = createDiffOperations(oldLines, newLines);
  const changedIndexes = operations
    .map((operation, index) => operation.kind === 'context' ? -1 : index)
    .filter((index) => index >= 0);
  const diffLines = ['--- a/' + filepath, '+++ b/' + filepath];
  if (changedIndexes.length === 0) return diffLines.join('\n');

  const ranges: Array<{ start: number; end: number }> = [];
  for (const changedIndex of changedIndexes) {
    const start = Math.max(0, changedIndex - 3);
    const end = Math.min(operations.length, changedIndex + 4);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  const oldHasFinalNewline = oldContent.endsWith('\n');
  const newHasFinalNewline = newContent.endsWith('\n');
  for (const range of ranges) {
    const hunk = operations.slice(range.start, range.end);
    const first = hunk[0];
    if (!first) continue;
    const oldCount = hunk.filter((operation) => operation.kind !== 'add').length;
    const newCount = hunk.filter((operation) => operation.kind !== 'remove').length;
    const oldStart = oldCount === 0 ? Math.max(0, first.oldLine - 1) : first.oldLine;
    const newStart = newCount === 0 ? Math.max(0, first.newLine - 1) : first.newLine;
    diffLines.push('@@ -' + oldStart + ',' + oldCount + ' +' + newStart + ',' + newCount + ' @@');

    for (const operation of hunk) {
      const prefix = operation.kind === 'context' ? ' ' : operation.kind === 'remove' ? '-' : '+';
      diffLines.push(prefix + operation.line);
      const oldHasNoNewline = operation.kind !== 'add' && operation.oldLine === oldLines.length && !oldHasFinalNewline;
      const newHasNoNewline = operation.kind !== 'remove' && operation.newLine === newLines.length && !newHasFinalNewline;
      if (oldHasNoNewline || newHasNoNewline) diffLines.push('\\ No newline at end of file');
    }
  }
  return diffLines.join('\n');
}

/**
 * Generates diff for added file.
 */
function generateAddedDiff(filepath: string, content: string): string {
  const lines = splitContentLines(content);
  const diffLines = ['--- /dev/null', '+++ b/' + filepath, '@@ -0,0 +'+ (lines.length === 0 ? 0 : 1) + ',' + lines.length + ' @@'];
  for (let index = 0; index < lines.length; index++) {
    diffLines.push('+' + (lines[index] ?? ''));
    if (index === lines.length - 1 && !content.endsWith('\n')) diffLines.push('\\ No newline at end of file');
  }
  return diffLines.join('\n');
}

/**
 * Generates diff for deleted file.
 */
function generateDeletedDiff(filepath: string, content: string): string {
  const lines = splitContentLines(content);
  const diffLines = ['--- a/' + filepath, '+++ /dev/null', '@@ -' + (lines.length === 0 ? 0 : 1) + ',' + lines.length + ' +0,0 @@'];
  for (let index = 0; index < lines.length; index++) {
    diffLines.push('-' + (lines[index] ?? ''));
    if (index === lines.length - 1 && !content.endsWith('\n')) diffLines.push('\\ No newline at end of file');
  }
  return diffLines.join('\n');
}

/**
 * Keeps only unified-diff file sections whose paths passed repository filtering.
 * Supports added/deleted files and the binary placeholders emitted by this module.
 */
export function filterDiffToFiles(diff: string, filePaths: readonly string[]): string {
  const included = new Set(filePaths.map((file) => file.replace(/\\/g, '/')));
  if (included.size === 0 || !diff) return '';

  const sections: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) sections.push(current);
    current = [];
  };

  for (const line of diff.split('\n')) {
    if (/^--- (?:a\/|\/dev\/null)$/.test(line) || /^# Binary(?: file| or unresolved index entry) /.test(line)) {
      flush();
    }
    current.push(line);
  }
  flush();

  const kept: string[] = [];
  for (const section of sections) {
    const addedPath = section.find((line) => line.startsWith('+++ b/'))?.slice(6);
    const deletedPath = section.find((line) => line.startsWith('--- a/'))?.slice(6);
    const binaryLine = section.find((line) => line.startsWith('# Binary'));
    const binaryMatch = binaryLine
      ? /^# Binary(?: file| or unresolved index entry) (.+) (?:differs|added|deleted)$/.exec(binaryLine)
      : null;
    const filePath = (addedPath ?? deletedPath ?? binaryMatch?.[1])?.replace(/\\/g, '/');
    if (filePath && included.has(filePath)) kept.push(...section);
  }

  return kept.join('\n');
}

/**
 * Gets changed files with their status between two refs.
 *
 * @param repoRoot - Repository root directory
 * @param base - Base ref/commit
 * @param head - Head ref/commit
 * @returns Array of file changes
 */
export async function getChangedFiles(
  repoRoot: string,
  base: string,
  head: string
): Promise<FileChange[]> {
  try {
    const gitDir = await findGitDir(repoRoot);
    const baseOid = await resolveRef(repoRoot, base);
    const headOid = await resolveRef(repoRoot, head);

    const baseCommit = await git.readCommit({
      fs: fsAdapter,
      dir: repoRoot,
      gitdir: gitDir,
      oid: baseOid,
    });
    const headCommit = await git.readCommit({
      fs: fsAdapter,
      dir: repoRoot,
      gitdir: gitDir,
      oid: headOid,
    });

    const baseTreeOid = baseCommit.commit.tree;
    const headTreeOid = headCommit.commit.tree;

    const changes: FileChange[] = [];

    await git.walk({
      fs: fsAdapter,
      dir: repoRoot,
      gitdir: gitDir,
      trees: [git.TREE({ ref: baseTreeOid }), git.TREE({ ref: headTreeOid })],
      map: async (filepath, [baseEntry, headEntry]) => {
        if (filepath === '.') return;

        const baseType = baseEntry ? await baseEntry.type() : undefined;
        const headType = headEntry ? await headEntry.type() : undefined;

        if (baseType === 'tree' || headType === 'tree') return;

        const baseBlobOid = baseEntry ? await baseEntry.oid() : undefined;
        const headBlobOid = headEntry ? await headEntry.oid() : undefined;

        // Skip unchanged files
        if (baseBlobOid === headBlobOid) return;

        let status: FileChange['status'] = 'modified';
        if (baseBlobOid === undefined && headBlobOid !== undefined) status = 'added';
        if (baseBlobOid !== undefined && headBlobOid === undefined) status = 'deleted';

        const change: FileChange = {
          path: filepath,
          status,
        };

        // Note: rename detection would require additional logic
        // For now, we don't detect renames

        changes.push(change);
      },
    });

    return changes;
  } catch (error) {
    throw createGitError('Failed to get changed files', {
      repoRoot,
      base,
      head,
      error: String(error),
    });
  }
}

/**
 * Reads a blob by filepath at a specific commit.
 */
async function readBlobAtCommit(
  repoRoot: string,
  gitDir: string,
  commitOid: string,
  filepath: string
): Promise<string | null> {
  try {
    const blob = await git.readBlob({
      fs: fsAdapter,
      dir: repoRoot,
      gitdir: gitDir,
      oid: commitOid,
      filepath,
    });
    return decodeTextBlob(blob.blob);
  } catch {
    return null;
  }
}

/**
 * Reads the stage-0 blob OIDs from the Git index. Reading the object by OID
 * avoids accidentally using the working-tree contents for staged changes.
 */
async function readIndexOids(gitDir: string): Promise<Map<string, string>> {
  const entries = await GitIndexManager.acquire(
    { fs: indexFs, gitdir: gitDir, cache: {} },
    (index: { entries: Array<{ path: string; oid: string; flags: { stage: number } }> }) =>
      index.entries
        .filter((entry) => entry.flags.stage === 0)
        .map((entry) => ({ filepath: entry.path, oid: entry.oid }))
  );
  return new Map(entries.map((entry) => [entry.filepath, entry.oid]));
}

/** Reads raw bytes for a Git blob OID. */
async function readBlobAtOid(
  repoRoot: string,
  gitDir: string,
  oid: string
): Promise<Buffer | null> {
  try {
    const blob = await git.readBlob({ fs: fsAdapter, dir: repoRoot, gitdir: gitDir, oid });
    return Buffer.from(blob.blob);
  } catch {
    return null;
  }
}

/** Decodes a text blob and returns null for binary or invalid UTF-8 data. */
function decodeTextBlob(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads a changed file from the exact target snapshot of a review scope.
 * This keeps staged and historical reviews aligned with the diff being reviewed.
 */
export async function readFileAtReviewScope(
  repoRoot: string,
  scopeType: ReviewScope['type'],
  headRef: string,
  filepath: string
): Promise<string | null> {
  if (scopeType === 'working-tree') {
    try {
      return decodeTextBlob(await fs.readFile(path.join(repoRoot, filepath)));
    } catch {
      return null;
    }
  }

  const gitDir = await findGitDir(repoRoot);
  if (scopeType === 'staged') {
    const oid = (await readIndexOids(gitDir)).get(filepath);
    if (!oid) return null;
    const blob = await readBlobAtOid(repoRoot, gitDir, oid);
    return blob ? decodeTextBlob(blob) : null;
  }

  try {
    const commitOid = await resolveRef(repoRoot, headRef);
    return await readBlobAtCommit(repoRoot, gitDir, commitOid, filepath);
  } catch {
    return null;
  }
}

/**
 * Gets the diff for staged changes (index vs HEAD).
 *
 * @param repoRoot - Repository root directory
 * @returns Unified diff string for staged changes
 */
export async function getStagedDiff(repoRoot: string): Promise<string> {
  try {
    const gitDir = await findGitDir(repoRoot);
    let headOid: string | null = null;
    try {
      headOid = await resolveRef(repoRoot, 'HEAD');
    } catch {
      headOid = null;
    }

    const matrix = await git.statusMatrix({ fs: fsAdapter, dir: repoRoot, gitdir: gitDir });
    const indexOids = await readIndexOids(gitDir);
    const diffs: string[] = [];

    for (const entry of matrix) {
      const filepath = entry[0];
      const headStatus = entry[1] as 0 | 1;
      const stageStatus = entry[3] as 0 | 1 | 2 | 3;
      if (stageStatus === headStatus) continue;

      let status: FileChange['status'] | undefined;
      if (headStatus === 0 && stageStatus !== 0) status = 'added';
      else if (headStatus === 1 && (stageStatus === 2 || stageStatus === 3)) status = 'modified';
      else if (headStatus === 1 && stageStatus === 0) status = 'deleted';
      if (!status) continue;

      if (status === 'deleted') {
        const headContent = headOid ? await readBlobAtCommit(repoRoot, gitDir, headOid, filepath) : null;
        diffs.push(headContent === null ? '# Binary file ' + filepath + ' deleted\n' : generateDeletedDiff(filepath, headContent));
        continue;
      }

      const indexOid = indexOids.get(filepath);
      const indexBuffer = indexOid ? await readBlobAtOid(repoRoot, gitDir, indexOid) : null;
      const indexContent = indexBuffer ? decodeTextBlob(indexBuffer) : null;
      if (indexContent === null) {
        diffs.push('# Binary or unresolved index entry ' + filepath + ' differs\n');
        continue;
      }

      if (status === 'added' || !headOid) {
        diffs.push(generateAddedDiff(filepath, indexContent));
        continue;
      }

      const headContent = await readBlobAtCommit(repoRoot, gitDir, headOid, filepath);
      diffs.push(headContent === null
        ? '# Binary file ' + filepath + ' differs\n'
        : generateUnifiedDiff(filepath, headContent, indexContent));
    }

    return diffs.join('\n');
  } catch (error) {
    throw createGitError('Failed to get staged diff', { repoRoot, error: String(error) });
  }
}

/**
 * Gets the diff for working tree changes (working tree vs index).
 *
 * @param repoRoot - Repository root directory
 * @returns Unified diff string for working tree changes
 */
export async function getWorkingDiff(repoRoot: string): Promise<string> {
  try {
    const gitDir = await findGitDir(repoRoot);
    const matrix = await git.statusMatrix({ fs: fsAdapter, dir: repoRoot, gitdir: gitDir });
    const indexOids = await readIndexOids(gitDir);
    const diffs: string[] = [];

    for (const entry of matrix) {
      const filepath = entry[0];
      const workdirStatus = entry[2] as 0 | 1 | 2;
      const indexOid = indexOids.get(filepath);

      if (workdirStatus === 0) {
        if (!indexOid) continue;
        const indexBuffer = await readBlobAtOid(repoRoot, gitDir, indexOid);
        const indexContent = indexBuffer ? decodeTextBlob(indexBuffer) : null;
        diffs.push(indexContent === null
          ? '# Binary file ' + filepath + ' deleted\n'
          : generateDeletedDiff(filepath, indexContent));
        continue;
      }

      let workingBuffer: Buffer;
      try {
        workingBuffer = await fs.readFile(path.join(repoRoot, filepath));
      } catch {
        // A disappearing file is handled as a deletion on the next status pass.
        continue;
      }

      if (!indexOid) {
        const workingContent = decodeTextBlob(workingBuffer);
        diffs.push(workingContent === null
          ? '# Binary file ' + filepath + ' added\n'
          : generateAddedDiff(filepath, workingContent));
        continue;
      }

      const indexBuffer = await readBlobAtOid(repoRoot, gitDir, indexOid);
      if (!indexBuffer) {
        diffs.push('# Binary file ' + filepath + ' differs\n');
        continue;
      }
      if (workingBuffer.equals(indexBuffer)) continue;

      const indexContent = decodeTextBlob(indexBuffer);
      const workingContent = decodeTextBlob(workingBuffer);
      diffs.push(indexContent === null || workingContent === null
        ? '# Binary file ' + filepath + ' differs\n'
        : generateUnifiedDiff(filepath, indexContent, workingContent));
    }

    return diffs.join('\n');
  } catch (error) {
    throw createGitError('Failed to get working diff', { repoRoot, error: String(error) });
  }
}

/**
 * Gets the parent commit OID of a given commit.
 *
 * @param repoRoot - Repository root directory
 * @param commit - Commit ref (HEAD, branch, SHA, etc.)
 * @returns Parent commit OID
 */
export async function getParentCommit(repoRoot: string, commit: string): Promise<string> {
  try {
    const oid = await resolveRef(repoRoot, commit);
    const gitDir = await findGitDir(repoRoot);
    const commitObj = await git.readCommit({ fs: fsAdapter, dir: repoRoot, gitdir: gitDir, oid });
    const parentOid = commitObj.commit.parent[0];
    if (!parentOid) {
      throw createGitError('Commit has no parent', { repoRoot, commit });
    }
    return parentOid;
  } catch (error) {
    throw createGitError('Failed to get parent commit', { repoRoot, commit, error: String(error) });
  }
}
