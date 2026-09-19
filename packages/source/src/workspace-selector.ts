import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { ProjectPlatform, SourceConfig } from '@auto-product-video-generator/core';
import { DEFAULT_PLATFORM_PRIORITY, logger } from '@auto-product-video-generator/core';
import { isSourcePathExcluded, loadSourceExcludePatterns } from './source-ignore.js';

interface Candidate {
  path: string;
  relativePath: string;
  platform: ProjectPlatform;
  score: number;
  runnable: boolean;
  packageName?: string;
}

/** Selects one runnable application from a repository/monorepo. */
export async function selectProjectRoot(
  repositoryRoot: string,
  source: SourceConfig
): Promise<string> {
  if (source.projectPath) {
    const selected = resolveInside(repositoryRoot, source.projectPath);
    if (!existsSync(selected)) throw new Error(`source.projectPath does not exist: ${selected}`);
    logger.success(`Selected configured project: ${source.projectPath}`);
    return selected;
  }

  // A Unity repository commonly contains auxiliary Node.js services without
  // having a package.json at its own root. ProjectVersion.txt is authoritative:
  // do not let a nested server/tool replace the Unity project being requested.
  if (isUnityProjectRoot(repositoryRoot)) {
    logger.success(`Selected Unity project root: ${repositoryRoot}`);
    return repositoryRoot;
  }
  if (isAndroidProjectRoot(repositoryRoot)) {
    logger.success(`Selected Android project root: ${repositoryRoot}`);
    return repositoryRoot;
  }

  const excludePatterns = await loadSourceExcludePatterns(repositoryRoot, source.exclude);
  const candidates = await discoverCandidates(repositoryRoot, excludePatterns);
  const applications = candidates.filter((item) => item.platform !== 'web' || item.runnable);
  const priority = source.platformPriority || DEFAULT_PLATFORM_PRIORITY;
  const platformRank = (platform: ProjectPlatform) => {
    const index = priority.indexOf(platform);
    return index < 0 ? priority.length : index;
  };
  const ranked = applications.sort(
    (a, b) =>
      platformRank(a.platform) - platformRank(b.platform) ||
      b.score - a.score ||
      a.relativePath.localeCompare(b.relativePath)
  );
  const selected = ranked[0];
  if (!selected || selected.relativePath === '.') return repositoryRoot;

  // Do not unexpectedly jump into a weak library candidate. Runnable apps
  // have scripts/framework markers and score >= 40.
  if (selected.score < 40) return repositoryRoot;
  logger.success(
    `Monorepo project selected: ${selected.relativePath} ` +
      `(${selected.packageName || selected.platform}, platform=${selected.platform})`
  );
  return selected.path;
}

export function findRepositoryRoot(projectRoot: string): string {
  let current = resolve(projectRoot);
  while (true) {
    if (existsSync(resolve(current, '.git'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) return resolve(projectRoot);
    current = parent;
  }
}

async function discoverCandidates(root: string, excludePatterns: string[]): Promise<Candidate[]> {
  const results: Candidate[] = [];
  const excluded = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.apvg']);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    const packagePath = resolve(dir, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as {
          name?: string;
          scripts?: Record<string, string>;
          bin?: string | Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const dependencies = new Set([
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.devDependencies || {}),
        ]);
        const platform = detectCandidatePlatform(dir, dependencies, Boolean(pkg.bin));
        const runnable = Boolean(
          pkg.scripts?.dev || pkg.scripts?.start || pkg.scripts?.serve || pkg.bin
        );
        const relativePath = relative(root, dir) || '.';
        let score = runnable ? 40 : 0;
        if (platform === 'web') score += 35;
        if (relativePath.split(sep).includes('apps')) score += 20;
        if (/web|frontend|site/i.test(relativePath)) score += 15;
        if (relativePath === '.') score += 10;
        results.push({ path: dir, relativePath, platform, score, runnable, packageName: pkg.name });
      } catch {
        /* invalid package.json is not a candidate */
      }
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !excluded.has(entry.name) && !entry.name.startsWith('.')) {
        const relativePath = relative(root, resolve(dir, entry.name)).split(sep).join('/');
        if (isSourcePathExcluded(relativePath, excludePatterns)) continue;
        await walk(resolve(dir, entry.name), depth + 1);
      }
    }
  }
  await walk(root, 0);
  return results;
}

function detectCandidatePlatform(
  dir: string,
  dependencies: Set<string>,
  hasBin: boolean
): ProjectPlatform {
  if (existsSync(resolve(dir, 'ProjectSettings', 'ProjectVersion.txt'))) return 'unity';
  if (existsSync(resolve(dir, 'pubspec.yaml'))) return 'flutter';
  if (dependencies.has('react-native')) return 'react-native';
  if (existsSync(resolve(dir, 'app', 'src', 'main', 'AndroidManifest.xml'))) return 'android';
  if (
    ['next', 'react', 'react-dom', 'vue', 'nuxt', '@sveltejs/kit', 'vite', 'astro'].some((name) =>
      dependencies.has(name)
    )
  )
    return 'web';
  if (
    hasBin ||
    dependencies.has('commander') ||
    dependencies.has('yargs') ||
    dependencies.has('oclif')
  )
    return 'cli';
  return 'other';
}

function isUnityProjectRoot(dir: string): boolean {
  return (
    existsSync(resolve(dir, 'ProjectSettings', 'ProjectVersion.txt')) &&
    existsSync(resolve(dir, 'Assets')) &&
    existsSync(resolve(dir, 'Packages'))
  );
}

function isAndroidProjectRoot(dir: string): boolean {
  return (
    existsSync(resolve(dir, 'gradlew')) &&
    (existsSync(resolve(dir, 'settings.gradle')) ||
      existsSync(resolve(dir, 'settings.gradle.kts'))) &&
    existsSync(resolve(dir, 'app', 'src', 'main', 'AndroidManifest.xml'))
  );
}

function resolveInside(root: string, projectPath: string): string {
  const resolvedRoot = resolve(root);
  const selected = resolve(resolvedRoot, projectPath);
  const rel = relative(resolvedRoot, selected);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`source.projectPath must stay inside the repository: ${projectPath}`);
  }
  return selected;
}
