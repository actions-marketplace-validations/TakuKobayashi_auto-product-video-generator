import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { logger } from '@auto-product-video-generator/core';
import { findRepositoryRoot } from './workspace-selector.js';
import { isSourcePathExcluded, loadSourceExcludePatterns } from './source-ignore.js';

export interface RouteInfo {
  /** URL path, e.g. "/dashboard/settings" or "/posts/[id]" */
  path: string;
  /** Source file this route was discovered from, relative to the project root. */
  file: string;
}

export interface PackageJsonSummary {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
  dependencies?: string[];
  devDependencies?: string[];
}

export type DetectedFramework =
  | 'nextjs-app-router'
  | 'nextjs-pages-router'
  | 'vite'
  | 'create-react-app'
  | 'vue'
  | 'nuxt'
  | 'sveltekit'
  | 'unknown';

export interface ProjectSourceContext {
  rootDir: string;
  repositoryRoot: string;
  /** Selected application directory, relative to repositoryRoot. */
  projectPath: string;
  packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun';
  packageJson: PackageJsonSummary | null;
  readme: string | null;
  framework: DetectedFramework;
  routes: RouteInfo[];
  /** A capped, filtered listing of source files for extra AI context when no routes were discoverable. */
  fileTree: string[];
  /** A separately capped list of visual/media asset paths useful for planning a promotional video. */
  assetFiles: string[];
  /**
   * Deterministic, file-based signals for what platform this project targets
   * (e.g. "Podfile found (iOS/CocoaPods)"). Passed to the AI as grounding
   * for its platform classification — see
   * @auto-product-video-generator/ai's platform-classifier.ts. Not authoritative by
   * itself (a project could have stray files from an unrelated tool), just
   * strong evidence.
   */
  platformHints: string[];
  /** Capped source excerpts that define CLI commands/options, for grounded demo planning. */
  cliSourceExcerpt?: string;
  /** Command paths discovered from CLI composition source, without the executable name. */
  cliCommands?: string[];
  /** Discovered command paths that explicitly declare a --dry-run option. */
  cliDryRunCommands?: string[];
  /** Scene-first Unity evidence. Present only for a Unity project. */
  unity?: UnitySourceContext;
}

export interface UnitySceneContext {
  path: string;
  objectNames: string[];
  referencedAssets: string[];
  referencedScripts: string[];
}

export interface UnitySourceContext {
  editorVersion?: string;
  sceneSource?: 'configured' | 'build-settings' | 'discovered';
  enabledScenes: UnitySceneContext[];
  projectScripts: Array<{ path: string; excerpt: string }>;
  packages: string[];
}

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  '.turbo',
  '.vercel',
  'coverage',
  '.cache',
  '.apvg',
  '.output',
]);

const MAX_README_CHARS = 4000;
const MAX_CLI_SOURCE_CHARS = 20000;
const MAX_FILE_TREE_ENTRIES = 200;
const MAX_ASSET_FILE_ENTRIES = 40;
const MAX_INSPECTED_FILE_ENTRIES = 1000;
const MAX_WALK_DEPTH = 6;

const PROMOTIONAL_ASSET_EXTENSIONS = new Set([
  // Images and editable design files
  '.ai',
  '.avif',
  '.bmp',
  '.eps',
  '.fig',
  '.gif',
  '.heic',
  '.heif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.psd',
  '.sketch',
  '.svg',
  '.tga',
  '.tif',
  '.tiff',
  '.webp',
  '.xd',
  // Video and audio (TypeScript's .ts is intentionally not included)
  '.3gp',
  '.aac',
  '.aiff',
  '.alac',
  '.avi',
  '.flac',
  '.flv',
  '.m2ts',
  '.m4a',
  '.m4v',
  '.mid',
  '.midi',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.oga',
  '.ogg',
  '.ogv',
  '.opus',
  '.wav',
  '.webm',
  '.wma',
  '.wmv',
  // 3D and CAD source assets
  '.3ds',
  '.abc',
  '.blend',
  '.dae',
  '.dwg',
  '.dxf',
  '.fbx',
  '.glb',
  '.gltf',
  '.iges',
  '.igs',
  '.obj',
  '.ply',
  '.step',
  '.stl',
  '.stp',
  '.usd',
  '.usda',
  '.usdc',
  '.usdz',
]);

export async function inspectProject(
  rootDir: string,
  configuredExcludes: string[] = [],
  configuredUnityScenes?: string[]
): Promise<ProjectSourceContext> {
  logger.step('source', `Inspecting project at ${rootDir}...`);

  const repositoryRoot = findRepositoryRoot(rootDir);
  const excludePatterns = await loadSourceExcludePatterns(repositoryRoot, configuredExcludes);
  const packageManager = detectPackageManager(repositoryRoot);
  const packageJson = await readPackageJson(rootDir);
  const readme =
    (await readReadme(rootDir)) ||
    (rootDir !== repositoryRoot ? await readReadme(repositoryRoot) : null);

  const deps = new Set([
    ...(packageJson?.dependencies || []),
    ...(packageJson?.devDependencies || []),
  ]);
  const looksLikeNextProject =
    deps.has('next') ||
    existsSync(join(rootDir, 'next.config.js')) ||
    existsSync(join(rootDir, 'next.config.mjs')) ||
    existsSync(join(rootDir, 'next.config.ts'));

  // Directory presence alone isn't enough evidence — an "app/" (or "pages/")
  // directory can exist for unrelated reasons (e.g. an Android project's
  // app/ module). Only trust it if this actually looks like a Next.js
  // project (an explicit dependency/config file), or if we find real
  // page.* route files inside it.
  const appRouterDir = looksLikeNextProject ? await findFirst(rootDir, ['app', 'src/app']) : null;
  const pagesRouterDir = looksLikeNextProject
    ? await findFirst(rootDir, ['pages', 'src/pages'])
    : null;

  let framework: DetectedFramework = 'unknown';
  let routes: RouteInfo[] = [];

  if (appRouterDir) {
    const found = await discoverNextAppRoutes(rootDir, appRouterDir);
    if (found.length > 0 || looksLikeNextProject) {
      framework = 'nextjs-app-router';
      routes = found;
    }
  } else if (pagesRouterDir) {
    const found = await discoverNextPagesRoutes(rootDir, pagesRouterDir);
    if (found.length > 0 || looksLikeNextProject) {
      framework = 'nextjs-pages-router';
      routes = found;
    }
  } else if (deps.has('nuxt')) {
    framework = 'nuxt';
  } else if (deps.has('@sveltejs/kit')) {
    framework = 'sveltekit';
  } else if (deps.has('vue')) {
    framework = 'vue';
  } else if (deps.has('vite')) {
    framework = 'vite';
  } else if (deps.has('react-scripts')) {
    framework = 'create-react-app';
  }

  const fileIndex = await buildProjectFileIndex(rootDir, excludePatterns);
  const fileTree = routes.length === 0 ? fileIndex.sourceFiles : [];
  const assetFiles = fileIndex.assetFiles;
  const platformHints = await detectPlatformHints(rootDir, packageJson, deps);
  const unity = platformHints.some((hint) => hint.includes('(Unity)'))
    ? await inspectUnityProject(rootDir, configuredUnityScenes)
    : undefined;
  const cliSourceExcerpt = packageJson?.bin
    ? await readCliSourceExcerpt(rootDir, fileIndex.sourceFiles)
    : undefined;
  const cliCommandCatalog = packageJson?.bin
    ? await discoverCliCommandPaths(rootDir, fileIndex.sourceFiles)
    : undefined;

  logger.success(
    `Detected: ${framework}` +
      (routes.length > 0
        ? `, ${routes.length} route(s) discovered`
        : ', no routes auto-discovered') +
      (platformHints.length > 0 ? `; platform hints: ${platformHints.length}` : '')
  );

  const projectPath = relative(repositoryRoot, rootDir) || '.';
  return {
    rootDir,
    repositoryRoot,
    projectPath,
    packageManager,
    packageJson,
    readme,
    framework,
    routes,
    fileTree,
    assetFiles,
    platformHints,
    cliSourceExcerpt,
    cliCommands: cliCommandCatalog?.commands,
    cliDryRunCommands: cliCommandCatalog?.dryRunCommands,
    unity,
  };
}

async function inspectUnityProject(
  rootDir: string,
  configuredScenePaths?: string[]
): Promise<UnitySourceContext> {
  const settingsPath = join(rootDir, 'ProjectSettings', 'EditorBuildSettings.asset');
  const settings = await readTextIfPresent(settingsPath);
  let scenePaths = configuredScenePaths?.length
    ? validateConfiguredUnityScenePaths(rootDir, configuredScenePaths)
    : [...settings.matchAll(/- enabled:\s*1\s*[\s\S]*?path:\s*([^\r\n]+)/g)]
        .map((match) => match[1].trim())
        .filter((path) => path.startsWith('Assets/'));

  const guidPaths = new Map<string, string>();
  await walkUnityMetaFiles(join(rootDir, 'Assets'), rootDir, guidPaths);
  const sceneSource = configuredScenePaths?.length
    ? 'configured'
    : scenePaths.length > 0
      ? 'build-settings'
      : 'discovered';
  if (sceneSource === 'discovered') {
    scenePaths = discoverUnityScenePaths([...guidPaths.values()]);
  }
  const enabledScenes: UnitySceneContext[] = [];
  const referencedScriptPaths = new Set<string>();

  for (const path of scenePaths.slice(0, 40)) {
    const content = await readTextIfPresent(join(rootDir, ...path.split('/')));
    const objectNames = uniqueMatches(content, /^[ \t]*m_Name:[ \t]*(.+)$/gm, 40);
    const referencedAssets = (await resolveUnityReferenceClosure(rootDir, content, guidPaths))
      .map((guid) => guidPaths.get(guid))
      .filter((value): value is string => Boolean(value));
    const referencedScripts = referencedAssets.filter(
      (asset) => asset.endsWith('.cs') && !isLikelyThirdPartyUnityAsset(asset)
    );
    referencedScripts.forEach((script) => referencedScriptPaths.add(script));
    enabledScenes.push({
      path,
      objectNames,
      referencedAssets: referencedAssets.slice(0, 80),
      referencedScripts,
    });
  }

  // Include scene-referenced scripts first. Add a small selection of other
  // first-party-looking scripts so bootstrap/game-state logic is not missed.
  const scriptCandidates = [...guidPaths.values()].filter(
    (path) => path.endsWith('.cs') && !isLikelyThirdPartyUnityAsset(path)
  );
  const orderedScripts = [
    ...referencedScriptPaths,
    ...scriptCandidates.filter((path) => !referencedScriptPaths.has(path)),
  ].slice(0, 30);
  const projectScripts = await Promise.all(
    orderedScripts.map(async (path) => ({
      path,
      excerpt: (await readTextIfPresent(join(rootDir, ...path.split('/')))).slice(0, 3000),
    }))
  );
  const manifest = await readTextIfPresent(join(rootDir, 'Packages', 'manifest.json'));
  let packages: string[] = [];
  try {
    packages = Object.keys((JSON.parse(manifest).dependencies || {}) as Record<string, string>);
  } catch {
    // An invalid/missing manifest should not prevent the remaining source analysis.
  }
  const version = await readTextIfPresent(join(rootDir, 'ProjectSettings', 'ProjectVersion.txt'));
  return {
    editorVersion: version.match(/^m_EditorVersion:\s*(\S+)/m)?.[1],
    sceneSource,
    enabledScenes,
    projectScripts,
    packages,
  };
}

function validateConfiguredUnityScenePaths(rootDir: string, paths: string[]): string[] {
  return paths.map((path) => {
    const normalized = path.trim().replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (
      !normalized.startsWith('Assets/') ||
      !normalized.endsWith('.unity') ||
      segments.some((segment) => segment === '.' || segment === '..') ||
      !existsSync(join(rootDir, ...segments))
    ) {
      throw new Error(`Configured Unity scene does not exist under Assets: ${path}`);
    }
    return normalized;
  });
}

function discoverUnityScenePaths(assetPaths: string[]): string[] {
  return assetPaths
    .filter((path) => path.endsWith('.unity') && !isExcludedUnityScene(path))
    .sort((left, right) => unitySceneScore(right) - unitySceneScore(left) || left.localeCompare(right))
    .slice(0, 40);
}

function isExcludedUnityScene(path: string): boolean {
  if (isLikelyThirdPartyUnityAsset(path)) return true;
  const segments = path.toLowerCase().split('/');
  const filename = segments.at(-1)?.replace(/\.unity$/, '') || '';
  return (
    segments.some((segment) =>
      /^(?:editor|tests?|samples?|examples?|tutorials?|demos?)$/.test(segment)
    ) || /(?:^|[-_. ])(?:test|sample|example|tutorial)(?:$|[-_. ])/i.test(filename)
  );
}

function unitySceneScore(path: string): number {
  const segments = path.toLowerCase().split('/');
  const filename = segments.at(-1)?.replace(/\.unity$/, '') || '';
  let score = 0;
  if (segments.includes('scenes')) score += 100;
  else if (segments.includes('scene')) score += 90;
  if (/^(?:main|title|menu|game|start|bootstrap|intro)$/.test(filename)) score += 50;
  score -= segments.length;
  return score;
}

async function walkUnityMetaFiles(
  dir: string,
  rootDir: string,
  result: Map<string, string>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (result.size >= 20000) return;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walkUnityMetaFiles(absolute, rootDir, result);
    } else if (entry.name.endsWith('.meta')) {
      const meta = await readTextIfPresent(absolute);
      const guid = meta.match(/^guid:\s*([0-9a-f]{32})/m)?.[1];
      if (guid) {
        result.set(
          guid,
          relative(rootDir, absolute.slice(0, -'.meta'.length)).split(sep).join('/')
        );
      }
    }
  }
}

function uniqueMatches(source: string, pattern: RegExp, limit: number): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1].trim()))].slice(
    0,
    limit
  );
}

function isLikelyThirdPartyUnityAsset(path: string): boolean {
  return /(?:^|\/)(?:Plugins|ThirdParty|AssetStoreTools|IsoTools|AudioManager_KanKikuchi|APVGGenerated[^/]*)(?:\/|$)/i.test(
    path
  );
}

async function resolveUnityReferenceClosure(
  rootDir: string,
  initialContent: string,
  guidPaths: Map<string, string>
): Promise<string[]> {
  const discovered = new Set(uniqueMatches(initialContent, /guid:[ \t]*([0-9a-f]{32})/g, 500));
  const pending = [...discovered];
  while (pending.length > 0 && discovered.size < 500) {
    const guid = pending.shift()!;
    const path = guidPaths.get(guid);
    if (!path || !/\.(?:prefab|asset)$/i.test(path)) continue;
    const content = await readTextIfPresent(join(rootDir, ...path.split('/')));
    for (const nested of uniqueMatches(content, /guid:[ \t]*([0-9a-f]{32})/g, 250)) {
      if (discovered.has(nested)) continue;
      discovered.add(nested);
      pending.push(nested);
    }
  }
  return [...discovered];
}

async function readTextIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function discoverCliCommandPaths(
  rootDir: string,
  files: string[]
): Promise<{ commands: string[]; dryRunCommands: string[] }> {
  const sourceFiles = files.filter((file) => /\.(?:ts|tsx|js|mjs|cjs)$/i.test(file));
  const definitions = new Map<
    string,
    {
      command?: string;
      defaultCommand?: string;
      children: Array<{ fn: string; arg?: string }>;
      direct: string[];
      dryRun: boolean;
    }
  >();
  let rootSource = '';

  for (const file of sourceFiles) {
    let source: string;
    try {
      source = await readFile(join(rootDir, file), 'utf8');
    } catch {
      continue;
    }
    if (/(?:^|\/)index\.[^.]+$/i.test(file)) rootSource += `\n${source}`;
    const matches = [...source.matchAll(/export\s+function\s+(\w+)\s*\(([^)]*)\)[^{]*\{/g)];
    matches.forEach((match, index) => {
      const bodyStart = (match.index || 0) + match[0].length;
      const bodyEnd = matches[index + 1]?.index ?? source.length;
      const body = source.slice(bodyStart, bodyEnd);
      const literal = body.match(/new\s+Command\(\s*['"]([^'"]+)['"]\s*\)/)?.[1];
      const variable = body.match(/new\s+Command\(\s*(\w+)\s*\)/)?.[1];
      const defaultCommand = variable
        ? match[2].match(new RegExp(`${variable}\\s*=\\s*['\"]([^'\"]+)['\"]`))?.[1]
        : undefined;
      const children = [...body.matchAll(/\.addCommand\(\s*(\w+)\(\s*(?:['"]([^'"]+)['"])?/g)].map(
        (child) => ({ fn: child[1], arg: child[2] })
      );
      const direct = [
        ...body.matchAll(/\.command\(\s*['"]([^'"]+)['"]\s*\)/g),
        ...body.matchAll(/\.addCommand\(\s*new\s+Command\(\s*['"]([^'"]+)['"]/g),
      ].map((child) => child[1]);
      definitions.set(match[1], {
        command: literal,
        defaultCommand,
        children,
        direct,
        dryRun: /\.option\(\s*['"][^'"]*--dry-run(?:\s|['"])/.test(body),
      });
    });
  }

  const roots = [...rootSource.matchAll(/\.addCommand\(\s*(\w+)\(\s*(?:['"]([^'"]+)['"])?/g)].map(
    (match) => ({ fn: match[1], arg: match[2] })
  );
  const paths = new Set<string>();
  const dryRunCommands = new Set<string>();
  const visit = (fn: string, arg: string | undefined, parent: string[], seen: Set<string>) => {
    const definition = definitions.get(fn);
    if (!definition || seen.has(fn)) return;
    const name = arg || definition.command || definition.defaultCommand;
    if (!name) return;
    const path = [...parent, name];
    paths.add(path.join(' '));
    if (definition.dryRun) dryRunCommands.add(path.join(' '));
    const nextSeen = new Set(seen).add(fn);
    definition.direct.forEach((child) => paths.add([...path, child].join(' ')));
    definition.children.forEach((child) => visit(child.fn, child.arg, path, nextSeen));
  };
  roots.forEach((root) => visit(root.fn, root.arg, [], new Set()));
  return { commands: [...paths], dryRunCommands: [...dryRunCommands] };
}

async function readCliSourceExcerpt(rootDir: string, files: string[]): Promise<string | undefined> {
  const candidates = files.filter(
    (file) =>
      (/(?:^|\/)(?:commands?|cli)(?:\/|\.)/i.test(file) || /(?:^|\/)index\.[^.]+$/i.test(file)) &&
      /\.(?:ts|tsx|js|mjs|cjs|py|go|rs)$/i.test(file)
  );
  const sources = await Promise.all(
    candidates.map(async (file) => {
      try {
        return { file, source: await readFile(join(rootDir, file), 'utf8') };
      } catch {
        return undefined;
      }
    })
  );
  const ordered = sources
    .filter((item): item is { file: string; source: string } => Boolean(item))
    .sort((a, b) => {
      const priority = (source: string, file: string) =>
        /addCommand\s*\(/.test(source) ? 0 : /(?:^|\/)index\./i.test(file) ? 1 : 2;
      return (
        priority(a.source, a.file) - priority(b.source, b.file) || a.file.localeCompare(b.file)
      );
    });
  let excerpt = '';
  for (const { file, source } of ordered) {
    if (excerpt.length >= MAX_CLI_SOURCE_CHARS) break;
    const remaining = MAX_CLI_SOURCE_CHARS - excerpt.length;
    excerpt += `\n--- ${file} ---\n${source.slice(0, remaining)}`;
  }
  return excerpt.trim() || undefined;
}

function detectPackageManager(root: string): 'pnpm' | 'yarn' | 'npm' | 'bun' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

async function readPackageJson(rootDir: string): Promise<PackageJsonSummary | null> {
  const path = join(rootDir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw) as {
      name?: string;
      description?: string;
      scripts?: Record<string, string>;
      bin?: string | Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      name: data.name,
      description: data.description,
      scripts: data.scripts,
      bin: data.bin,
      dependencies: Object.keys(data.dependencies || {}),
      devDependencies: Object.keys(data.devDependencies || {}),
    };
  } catch {
    return null;
  }
}

async function readReadme(rootDir: string): Promise<string | null> {
  const candidates = ['README.md', 'README.MD', 'Readme.md', 'readme.md'];
  for (const name of candidates) {
    const path = join(rootDir, name);
    if (existsSync(path)) {
      const raw = await readFile(path, 'utf-8');
      return raw.length > MAX_README_CHARS
        ? raw.slice(0, MAX_README_CHARS) + '\n...(truncated)'
        : raw;
    }
  }
  return null;
}

async function findFirst(rootDir: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const path = join(rootDir, candidate);
    if (existsSync(path)) return candidate;
  }
  return null;
}

const PAGE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

/** Next.js App Router: app/dashboard/settings/page.tsx -> /dashboard/settings */
async function discoverNextAppRoutes(rootDir: string, appRelDir: string): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = [];
  const absAppDir = join(rootDir, appRelDir);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name === 'api') continue;
        await walk(join(dir, entry.name));
        continue;
      }

      const base = entry.name.replace(/\.(tsx|jsx|ts|js)$/, '');
      if (base !== 'page') continue;

      const relFromApp = relative(absAppDir, dir).split(sep).filter(Boolean);
      // Route groups like "(marketing)" don't appear in the URL.
      const segments = relFromApp.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
      const urlPath = '/' + segments.join('/');

      routes.push({
        path: urlPath === '/' ? '/' : urlPath.replace(/\/$/, ''),
        file: relative(rootDir, join(dir, entry.name)),
      });
    }
  }

  await walk(absAppDir);
  return routes;
}

/** Next.js Pages Router: pages/posts/[id].tsx -> /posts/[id] */
async function discoverNextPagesRoutes(rootDir: string, pagesRelDir: string): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = [];
  const absPagesDir = join(rootDir, pagesRelDir);
  const skipNames = new Set(['_app', '_document', '_error', '404', '500']);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name === 'api') continue;
        await walk(join(dir, entry.name));
        continue;
      }

      const ext = PAGE_EXTENSIONS.find((e) => entry.name.endsWith(e));
      if (!ext) continue;

      const base = entry.name.slice(0, -ext.length);
      if (skipNames.has(base)) continue;

      const relFromPages = relative(absPagesDir, dir).split(sep).filter(Boolean);
      const nameSegment = base === 'index' ? [] : [base];
      const segments = [...relFromPages, ...nameSegment];
      const urlPath = '/' + segments.join('/');

      routes.push({
        path: urlPath === '/' ? '/' : urlPath,
        file: relative(rootDir, join(dir, entry.name)),
      });
    }
  }

  await walk(absPagesDir);
  return routes;
}

/**
 * Cheap, top-level(ish) file existence checks for common non-web platform
 * markers. Deliberately shallow (a handful of readdir/existsSync calls, not
 * a deep walk) since this only needs to produce *hints* — the AI makes the
 * final call, grounded by these plus package.json/README.
 *
 * To recognize a new platform: add a check here that pushes a short,
 * human-readable hint string, and add the platform itself to
 * ProjectPlatformSchema in packages/core/src/types/config.ts.
 */
async function detectPlatformHints(
  rootDir: string,
  packageJson: PackageJsonSummary | null,
  deps: Set<string>
): Promise<string[]> {
  const hints: string[] = [];

  let topLevel: string[] = [];
  try {
    topLevel = (await readdir(rootDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isFile())
      .map((e) => e.name);
  } catch {
    /* ignore */
  }

  // iOS (Xcode / Swift)
  if (topLevel.some((n) => n.endsWith('.xcodeproj')))
    hints.push('*.xcodeproj found (iOS/macOS, Xcode)');
  if (topLevel.some((n) => n.endsWith('.xcworkspace')))
    hints.push('*.xcworkspace found (iOS/macOS, Xcode)');
  if (topLevel.includes('Podfile')) hints.push('Podfile found (iOS, CocoaPods)');
  if (topLevel.includes('Package.swift')) hints.push('Package.swift found (Swift Package Manager)');

  // Android (Gradle)
  if (topLevel.includes('build.gradle') || topLevel.includes('build.gradle.kts')) {
    hints.push('build.gradle(.kts) found (Android, Gradle)');
  }
  if (topLevel.includes('settings.gradle') || topLevel.includes('settings.gradle.kts')) {
    hints.push('settings.gradle(.kts) found (Android, Gradle)');
  }
  if (existsSync(join(rootDir, 'app', 'src', 'main', 'AndroidManifest.xml'))) {
    hints.push('app/src/main/AndroidManifest.xml found (Android)');
  }

  // Unity
  if (existsSync(join(rootDir, 'ProjectSettings', 'ProjectVersion.txt'))) {
    hints.push('ProjectSettings/ProjectVersion.txt found (Unity)');
  }
  if (topLevel.includes('Assets') && topLevel.includes('ProjectSettings')) {
    hints.push('Assets/ + ProjectSettings/ found (Unity)');
  }

  // Flutter
  if (topLevel.includes('pubspec.yaml')) hints.push('pubspec.yaml found (Flutter/Dart)');

  // React Native (package.json-based; often also has ios/ and android/ dirs)
  if (deps.has('react-native')) hints.push('package.json depends on react-native');
  if (topLevel.includes('ios') && topLevel.includes('android') && packageJson) {
    hints.push(
      'ios/ and android/ directories alongside package.json (likely React Native or similar)'
    );
  }

  // Desktop (Electron / Tauri)
  if (deps.has('electron')) hints.push('package.json depends on electron');
  if (deps.has('@tauri-apps/cli') || topLevel.includes('src-tauri'))
    hints.push('Tauri project (src-tauri/ or @tauri-apps/cli dependency)');

  // CLI applications
  if (packageJson?.bin)
    hints.push('package.json declares bin command(s) (command-line application)');
  if (deps.has('commander') || deps.has('yargs') || deps.has('oclif')) {
    hints.push('package.json depends on a command-line framework');
  }

  return hints;
}
async function buildProjectFileIndex(
  rootDir: string,
  excludePatterns: string[]
): Promise<{ sourceFiles: string[]; assetFiles: string[] }> {
  const sourceFiles: string[] = [];
  const assetFiles: string[] = [];
  let inspectedFileEntries = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (
      depth > MAX_WALK_DEPTH ||
      inspectedFileEntries >= MAX_INSPECTED_FILE_ENTRIES ||
      (sourceFiles.length >= MAX_FILE_TREE_ENTRIES && assetFiles.length >= MAX_ASSET_FILE_ENTRIES)
    )
      return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        inspectedFileEntries >= MAX_INSPECTED_FILE_ENTRIES ||
        (sourceFiles.length >= MAX_FILE_TREE_ENTRIES && assetFiles.length >= MAX_ASSET_FILE_ENTRIES)
      )
        return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

      const relativePath = relative(rootDir, join(dir, entry.name)).split(sep).join('/');
      if (isSourcePathExcluded(relativePath, excludePatterns)) continue;

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name), depth + 1);
      } else {
        inspectedFileEntries += 1;
        if (PROMOTIONAL_ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          if (assetFiles.length < MAX_ASSET_FILE_ENTRIES) assetFiles.push(relativePath);
        } else if (sourceFiles.length < MAX_FILE_TREE_ENTRIES) {
          sourceFiles.push(relativePath);
        }
      }
    }
  }

  await walk(rootDir, 0);
  return { sourceFiles, assetFiles };
}
