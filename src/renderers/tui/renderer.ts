import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Instance, render } from 'ink';
import pc from 'picocolors';
import React from 'react';
import { countBlockingFindings } from '../../application/policy.js';
import type { ReviewFailOnSeverity, ReviewProgressEvent } from '../../application/types.js';
import type { ReviewResult } from '../../review/types.js';
import type { RendererOptions, ReviewRenderer } from '../types.js';
import { App } from './app.js';
import { TerminalLifecycleManager } from './terminal.js';
import type { TuiState } from './types.js';

export interface InteractiveTuiOptions extends RendererOptions {
  repoRoot?: string | undefined;
  scopeType?: string | undefined;
  failOn?: ReviewFailOnSeverity | undefined;
  onReReview?: (() => Promise<void>) | undefined;
  fileContents?: Map<string, string> | undefined;
  loadFileContents?: ((filePaths: readonly string[]) => Promise<Map<string, string>>) | undefined;
  loadDiff?: (() => Promise<string>) | undefined;
  diffText?: string | undefined;
}

export class InteractiveTuiRenderer implements ReviewRenderer {
  private readonly options: InteractiveTuiOptions;
  private readonly lifecycle: TerminalLifecycleManager;
  private readonly actionEmitter: EventEmitter;
  private inkInstance: Instance | null = null;
  private exitResolver: (() => void) | null = null;
  private exitPromise: Promise<void> | null = null;
  private finalSuppressedIds: ReadonlySet<string> = new Set();
  private latestResult: ReviewResult | null = null;
  private started = false;

  constructor(options: InteractiveTuiOptions = {}) {
    this.options = options;
    this.lifecycle = new TerminalLifecycleManager(
      (options.stream as NodeJS.WriteStream | undefined) ?? process.stdout
    );
    this.actionEmitter = new EventEmitter();
  }

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.lifecycle.enter();

    const initialState: TuiState = {
      findings: [],
      suppressedIds: new Set<string>(),
      cursorIndex: 0,
      expandedGroups: new Set(['critical', 'high', 'medium', 'low', 'info']),
      activeModal: null,
      viewMode: 'progress',
      snippetMode: 'source',
      evidenceIndex: 0,
      explainScrollOffset: 0,
      failOnSeverity: this.options.failOn ?? 'critical',
      repoRoot: this.options.repoRoot ?? process.cwd(),
      scopeType: this.options.scopeType ?? 'workspace',
      progressEvent: {
        stage: 'git:read',
        status: 'start',
        message: 'Initializing review pipeline...',
      },
    };

    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolver = resolve;
    });

    this.inkInstance = render(
      React.createElement(App, {
        initialState,
        onQuit: (suppressedIds) => {
          if (suppressedIds) {
            this.finalSuppressedIds = suppressedIds;
          }
          if (this.inkInstance) {
            this.inkInstance.unmount();
          }
          if (this.exitResolver) {
            this.exitResolver();
          }
        },
        onReReview: this.options.onReReview,
        fileContents: this.options.fileContents,
        diffText: this.options.diffText,
        actionEmitter: this.actionEmitter,
      }),
      {
        patchConsole: true,
        stdout: (this.options.stream as NodeJS.WriteStream | undefined) ?? process.stdout,
      }
    );
  }

  public dispatchProgress(event: ReviewProgressEvent): void {
    this.actionEmitter.emit('action', { type: 'SET_PROGRESS', event });
  }

  public dispatchResult(result: ReviewResult): void {
    this.latestResult = result;
    this.actionEmitter.emit('action', { type: 'FINISH_REVIEW', result });
  }

  /**
   * Replaces the visible review result and refreshes source context for that result.
   * Snapshot-aware callers must supply loadFileContents so historical reviews never
   * display unrelated live-worktree content.
   */
  public async updateResult(result: ReviewResult): Promise<void> {
    const fileContents = this.options.fileContents ?? new Map<string, string>();

    if (!this.options.fileContents) {
      const uniqueFiles = new Set<string>();
      for (const finding of result.findings) {
        if (finding.file) uniqueFiles.add(finding.file);
        for (const evidence of finding.evidence) {
          if (evidence.file) uniqueFiles.add(evidence.file);
        }
      }

      if (this.options.loadFileContents) {
        const loaded = await this.options.loadFileContents(Array.from(uniqueFiles));
        for (const [file, content] of loaded) fileContents.set(file, content);
      } else {
        await Promise.all(
          Array.from(uniqueFiles).map(async (relativeFile) => {
            try {
              const fullPath = path.resolve(this.options.repoRoot ?? process.cwd(), relativeFile);
              const content = await fs.promises.readFile(fullPath, 'utf-8');
              fileContents.set(relativeFile, content);
            } catch {
              // Ignore unreadable or deleted files.
            }
          })
        );
      }
    }

    const diffText = this.options.loadDiff
      ? await this.options.loadDiff()
      : (this.options.diffText ?? '');
    this.actionEmitter.emit('data', { fileContents, diffText });
    this.dispatchResult(result);
  }

  public async render(result: ReviewResult): Promise<void> {
    if (!this.started) {
      this.start();
    }

    try {
      await this.updateResult(result);

      if (this.exitPromise) {
        await this.exitPromise;
      }
    } finally {
      this.lifecycle.exit();
    }

    const threshold = this.options.failOn ?? 'critical';
    const finalResult = this.latestResult ?? result;
    const activeFindings = finalResult.findings.filter((f) => !this.finalSuppressedIds.has(f.id));
    const finalBlockingCount = countBlockingFindings(activeFindings, threshold);
    process.exitCode = finalBlockingCount > 0 ? 1 : 0;

    const stream = process.stderr;
    for (const warning of finalResult.metadata.warnings ?? []) {
      stream.write(pc.yellow(`Octate warning: ${warning}\n`));
    }

    if (finalBlockingCount > 0) {
      stream.write(
        pc.red(`\nOctate review finished: ${finalBlockingCount} blocking findings (exit 1)\n`)
      );
    } else {
      stream.write(pc.green('\nOctate review finished: clean (exit 0)\n'));
    }
  }

  public exit(): void {
    if (this.inkInstance) {
      this.inkInstance.unmount();
    }
    this.lifecycle.exit();
    if (this.exitResolver) {
      this.exitResolver();
    }
  }
}
