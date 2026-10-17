import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ConfigurationError } from '../errors/index.js';
import { createLogger } from '../logging/index.js';
import {
  DefaultConfig,
  type OctateConfig,
  OctateConfigSchema,
  type PartialOctateConfig,
  PartialOctateConfigSchema,
  ProjectConfigLayerSchema,
} from './schema.js';

const logger = createLogger('config:loader');

/**
 * Finds a project config file by walking up from the supplied directory.
 * A directory named octate.yaml is not treated as a configuration file.
 */
export async function findConfigFile(startDir: string = process.cwd()): Promise<string | null> {
  let currentDir = resolve(startDir);
  const rootDir = resolve('/');

  while (true) {
    const configPath = join(currentDir, 'octate.yaml');
    try {
      const configStat = await stat(configPath);
      if (configStat.isFile()) return configPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (currentDir === rootDir) break;
    currentDir = dirname(currentDir);
  }

  return null;
}

function configurationError(label: string, filePath: string, error: unknown): ConfigurationError {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'root';
      return `${field}: ${issue.message}`;
    });
    return new ConfigurationError(`Invalid ${label}: ${issues.join('; ')}`, {
      filePath,
      issues,
    });
  }

  return new ConfigurationError(
    `Failed to load ${label} from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    { filePath }
  );
}

async function readYaml(filePath: string, label: string): Promise<unknown> {
  try {
    return parse(await readFile(filePath, 'utf-8'));
  } catch (error) {
    throw configurationError(label, filePath, error);
  }
}

/**
 * Loads the project config as an explicit-only layer.
 * Defaults are applied only after all configuration sources are merged.
 */
export async function loadProjectConfigLayer(configPath?: string): Promise<PartialOctateConfig> {
  const filePath = configPath ?? (await findConfigFile());
  if (!filePath) return {};

  logger.debug({ filePath }, 'Loading project config layer');
  const parsed = await readYaml(filePath, 'octate.yaml');
  try {
    return ProjectConfigLayerSchema.parse(parsed);
  } catch (error) {
    throw configurationError('octate.yaml', filePath, error);
  }
}

/**
 * Loads global config overrides from XDG_CONFIG_HOME or ~/.config.
 * Unlike a project config, a global layer may contain only the settings it
 * overrides (for example, review.failOnSeverity without project metadata).
 */
export async function loadGlobalConfigLayer(): Promise<PartialOctateConfig> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE;
  if (!homeDir) return {};

  const configDir = process.env.XDG_CONFIG_HOME ?? join(homeDir, '.config');
  const filePath = join(configDir, 'octate', 'config.yaml');
  let source: string;

  try {
    source = await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw configurationError('global config', filePath, error);
  }

  try {
    return PartialOctateConfigSchema.parse(parse(source));
  } catch (error) {
    const wrapped = configurationError('global config', filePath, error);
    // Global settings are optional; an invalid global file must not prevent Octate
    // from running with defaults and a valid project-level configuration.
    logger.warn(
      { filePath, error: wrapped.message },
      'Ignoring invalid global config and using defaults'
    );
    return {};
  }
}

/**
 * Loads and validates a complete project config, materializing defaults.
 * Retained for callers that explicitly need a complete OctateConfig value.
 */
export async function loadProjectConfig(configPath?: string): Promise<OctateConfig> {
  const filePath = configPath ?? (await findConfigFile());
  if (!filePath) {
    logger.debug('No project config file found, using defaults');
    return DefaultConfig;
  }

  logger.debug({ filePath }, 'Loading project config');
  const parsed = await readYaml(filePath, 'octate.yaml');
  try {
    const validated = OctateConfigSchema.parse(parsed);
    logger.info({ filePath }, 'Project config loaded successfully');
    return validated;
  } catch (error) {
    const wrapped = configurationError('octate.yaml', filePath, error);
    logger.error({ filePath, error: wrapped.message }, 'Project config validation failed');
    throw wrapped;
  }
}

/**
 * Loads a complete global config value by applying explicit overrides to
 * defaults. The precedence merger itself uses loadGlobalConfigLayer so the
 * original presence/absence of fields is preserved.
 */
export async function loadGlobalConfig(): Promise<OctateConfig> {
  const layer = await loadGlobalConfigLayer();
  const merged = {
    ...DefaultConfig,
    ...layer,
    project: { ...DefaultConfig.project, ...layer.project },
    review: { ...DefaultConfig.review, ...layer.review },
    rules: layer.rules ?? DefaultConfig.rules,
    architecture:
      layer.architecture === null ? null : { ...DefaultConfig.architecture, ...layer.architecture },
    ignore: layer.ignore ?? DefaultConfig.ignore,
  };

  try {
    return OctateConfigSchema.parse(merged);
  } catch (error) {
    throw configurationError('global config', 'global config', error);
  }
}
