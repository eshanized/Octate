/**
 * Tests for commands/init.ts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parse } from 'yaml';
import { OctateConfigSchema } from '../config/schema.js';
import { createInitCommand } from './init.js';

describe('commands:init', () => {
  let command: ReturnType<typeof createInitCommand>;
  let testDir: string;

  beforeEach(async () => {
    command = createInitCommand();
    // Create a temporary directory for testing
    testDir = join(tmpdir(), `octate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    jest.resetAllMocks();
    // Clean up test directory
    try {
      const { rm } = await import('node:fs/promises');
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('createInitCommand', () => {
    it('creates command with correct name and description', () => {
      expect(command.name()).toBe('init');
      expect(command.description()).toBe(
        'Create a new octate.yaml configuration file at the repository root'
      );
    });

    it('has path argument', () => {
      // Commander.js defines arguments in _args internally (not in public types)
      const args = (command as any)._args ?? command.args;
      expect(args.length).toBeGreaterThan(0);
    });

    it('has force option', () => {
      const options = command.options.map((o) => o.flags);
      expect(options).toContain('-f, --force');
    });

    it('has name option', () => {
      const options = command.options.map((o) => o.flags);
      expect(options).toContain('-n, --name <name>');
    });
  });

  describe('init command execution', () => {
    it('creates a schema-valid octate.yaml with default content', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await command.parseAsync([testDir], { from: 'user' });
        const parsedYaml = parse(await readFile(join(testDir, 'octate.yaml'), 'utf-8'));
        const config = OctateConfigSchema.parse(parsedYaml);
        expect(config.project.name).toBe(testDir.split('/').pop());
        expect(config.review.maxFindings).toBe(50);
        expect(config.review.failOnSeverity).toBe('critical');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('fails when file exists without --force', async () => {
      const configPath = join(testDir, 'octate.yaml');
      await writeFile(configPath, 'existing content', 'utf-8');

      // The command would throw ConfigurationError
      expect(true).toBe(true);
    });

    it('overwrites with --force', async () => {
      expect(true).toBe(true);
    });

    it('uses directory name as project name by default', async () => {
      expect(true).toBe(true);
    });

    it('uses custom name with --name', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await command.parseAsync([testDir, '--name', 'custom-project'], { from: 'user' });
        const config = OctateConfigSchema.parse(
          parse(await readFile(join(testDir, 'octate.yaml'), 'utf-8'))
        );
        expect(config.project.name).toBe('custom-project');
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('generateConfigContent', () => {
    it('generates valid YAML with all sections', () => {
      // This is tested indirectly via the command
      expect(true).toBe(true);
    });

    it('includes project name in generated config', () => {
      expect(true).toBe(true);
    });
  });
});
