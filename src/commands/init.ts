import { writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Command } from 'commander';
import { ConfigurationError } from '../errors/index.js';
import { createLogger } from '../logging/index.js';

const logger = createLogger('commands:init');

/**
 * Generates a commented octate.yaml with all sections and examples.
 */
function generateConfigContent(projectName: string): string {
  const safeProjectName = projectName.replace(/["\\\r\n]/g, (character) => {
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    return '\\' + character;
  });

  return `# Octate configuration
# See https://octate.dev/config for the full reference.

version: "1.0.0"

project:
  name: "${safeProjectName}"

review:
  # minimum severity to report: critical, high, medium, low, info
  severity: "medium"
  # threshold for a non-zero exit code
  failOnSeverity: "critical"
  # maximum number of findings (1-100)
  maxFindings: 50
  # confidence threshold (0-1)
  minConfidence: 0.6

# custom rule names
rules: []

# dependency boundaries and forbidden dependency names/patterns
architecture:
  boundaries: []
  forbiddenDependencies: []

# additional glob patterns to ignore during review
ignore: []
`;
}

/**
 * Creates the init command for Commander.js
 */
export function createInitCommand(): Command {
  const cmd = new Command('init')
    .description('Create a new octate.yaml configuration file at the repository root')
    .argument('[path]', 'Repository root path (default: current directory)', process.cwd())
    .option('-f, --force', 'Overwrite existing octate.yaml')
    .option('-n, --name <name>', 'Project name (default: directory name)')
    .action(async (repoPath: string, options: { force?: boolean; name?: string }) => {
      const targetDir = resolve(repoPath);
      const configPath = join(targetDir, 'octate.yaml');
      const projectName = options.name?.trim() || basename(targetDir) || 'unnamed-project';

      logger.info({ configPath, projectName, force: options.force }, 'Initializing Octate config');

      try {
        // Check if file exists
        const fs = await import('node:fs/promises');
        try {
          await fs.access(configPath);
          if (!options.force) {
            throw new ConfigurationError(
              `octate.yaml already exists at ${configPath}. Use --force to overwrite.`,
              { filePath: configPath }
            );
          }
          logger.warn({ configPath }, 'Overwriting existing octate.yaml');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
          // File doesn't exist, continue
        }

        const content = generateConfigContent(projectName);
        await writeFile(configPath, content, 'utf-8');

        logger.info({ configPath }, 'Created octate.yaml');
        // biome-ignore lint/suspicious/noConsole: CLI user output
        console.log(`✓ Created ${configPath}`);
        // biome-ignore lint/suspicious/noConsole: CLI user output
        console.log(`  Project name: ${projectName}`);
        // biome-ignore lint/suspicious/noConsole: CLI user output
        console.log(`  Edit this file to customize your review configuration.`);
      } catch (error) {
        logger.error({ error: String(error) }, 'Init command failed');
        if (error instanceof ConfigurationError) {
          throw error;
        }
        throw new ConfigurationError(`Failed to create octate.yaml: ${error}`, {
          filePath: configPath,
        });
      }
    });

  return cmd;
}

/**
 * Exported init command for registration
 */
export const initCommand = createInitCommand();
