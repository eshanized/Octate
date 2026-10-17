import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readText(relativePath) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Required release file is missing: ${relativePath}`);
  }
  return readFileSync(absolutePath, 'utf8');
}

function fail(message) {
  console.error(`Release metadata check failed: ${message}`);
  process.exitCode = 1;
}

const manifest = JSON.parse(readText('package.json'));
const readme = readText('README.md');
const changelog = readText('CHANGELOG.md');
const runtimeSource = readText('src/version.ts');
const releaseNotesPath = `docs/releases/v${manifest.version}.md`;
const releaseNotes = readText(releaseNotesPath);
const runtimeVersion = runtimeSource.match(/export const OCTATE_VERSION = '([^']+)';/)?.[1];

if (runtimeVersion !== manifest.version) {
  fail(`package.json version ${manifest.version} does not match runtime version ${runtimeVersion ?? 'not found'}.`);
}

if (manifest.homepage !== 'https://octate.tonmoyinfrastructure.org/') {
  fail('package.json homepage must point to https://octate.tonmoyinfrastructure.org/.');
}

if (!changelog.includes(`## [${manifest.version}]`)) {
  fail(`CHANGELOG.md has no entry for version ${manifest.version}.`);
}

if (!readme.includes('https://github.com/eshanized/Octate/blob/main/CHANGELOG.md')) {
  fail('README.md must link to the changelog using its canonical GitHub URL.');
}

const expectedReleaseUrl = `https://github.com/eshanized/Octate/blob/main/${releaseNotesPath}`;
if (!readme.includes(expectedReleaseUrl)) {
  fail(`README.md must link to ${expectedReleaseUrl}.`);
}

if (/Current development version|Release publication follows the passing release workflow/i.test(readme)) {
  fail('README.md still contains the stale development-version banner.');
}

const relativeDocumentationLinks = readme.match(/\]\((?:CHANGELOG\.md|docs\/[^)]+|\.planning\/[^)]+)\)/g) ?? [];
if (relativeDocumentationLinks.length > 0) {
  fail(`README.md contains documentation links that may be broken on npm: ${relativeDocumentationLinks.join(', ')}.`);
}

if (!releaseNotes.includes(`@tiverse/octate@${manifest.version}`)) {
  fail(`${releaseNotesPath} must document an install command for version ${manifest.version}.`);
}

if (process.exitCode === 1) {
  process.exit(1);
}

console.log(`Release metadata is consistent for @tiverse/octate@${manifest.version}.`);
