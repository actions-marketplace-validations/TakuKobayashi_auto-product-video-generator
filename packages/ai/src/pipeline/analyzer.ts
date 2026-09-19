import {
  ProjectSummary,
  ProjectSummarySchema,
  isConcreteWebRoute,
  isSafeCliCommand,
  logger,
  withHeartbeat,
} from '@auto-product-video-generator/core';
import { detectStartCommand, ProjectSourceContext } from '@auto-product-video-generator/source';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, win32 } from 'node:path';
import { LlmProvider } from '../llm/provider.js';
import { generateValidatedJson } from '../utils/validated-json.js';
import { buildPlatformClassificationPrompt } from './platform-classifier.js';
import { buildSetupPlanningPrompt } from './setup-planner.js';
import { PROJECT_SUMMARY_OUTPUT_SCHEMA } from './output-schemas.js';

const SYSTEM_PROMPT = `You are a video production expert analyzing a project's source code
to plan a promotional demo video.

The resulting video is for general, non-technical viewers. Treat frameworks,
programming languages, hosting services, APIs, architecture, and implementation
details only as internal evidence. NEVER present them as product features or
customer value. Features, descriptions, targetAudience, and keyValueProps must
describe what a person can do, the problem it solves, and the visible benefit in
plain language. Prefer user workflows such as "browse work", "find information",
"submit a request", or "manage items" over how the software was built.

You will be given: the project's package.json (name/description/scripts/dependencies),
its README, deterministic platform signals, the detected web framework (if any), and
either a list of discovered routes (URL paths mapped from actual page/route files) or a
general file listing when routes couldn't be auto-discovered. A separately capped list
of promotional asset paths may also be provided. Treat asset names only as hints; never
claim to have inspected their visual, audio, video, or 3D contents.

Respond ONLY with one valid JSON object. This is strict JSON, not TypeScript.
Every top-level key shown below is REQUIRED. NEVER output null anywhere.

Copy this structure exactly and replace the example values:
{
  "name": "Example Product",
  "description": "A plain-language description of what the product helps people do.",
  "platform": "web",
  "setupSteps": [
    {"name":"Install dependencies","command":"npm install","background":false},
    {"name":"Start application","command":"npm run dev","background":true,"readyUrl":"http://localhost:3000"}
  ],
  "features": [
    {"id":"browse-items","title":"Browse items","description":"Find useful items quickly.","route":"/items","demoable":true,"priority":"high"}
  ],
  "targetAudience": "People who want to use the product",
  "keyValueProps": ["Find what you need quickly"],
  "suggestedVideoTypes": ["demo"]
}

Hard rules:
- "description" is always required, even when package.json has no description.
- Use exactly one allowed platform key from the platform section.
- setupSteps and features may be empty arrays, but must always be present.
- Every feature must contain id, title, description, demoable, and priority.
- For web projects, set route when it is known. For CLI projects, set each demoable feature's "command" to an exact safe command documented by package.json or README and omit route when it is not meaningful.
- CLI feature commands MUST be finite and safe. Prefer several real subcommand demonstrations rather than repeating root --help. A command may end in --help, -h, --version, -v, or --dry-run. Use --dry-run only when that exact option is documented by the supplied source. Never select commands that publish, authenticate, expose environment/secrets, create/delete files, or start servers/watchers.
- Optional setup fields must be OMITTED when unused. NEVER write null.
- A foreground setup step has no readyUrl key.
- A background web-server step has readyUrl as a real URL string.
- No markdown, comments, trailing commas, or explanation. JSON only.`;

export class ProjectAnalyzer {
  constructor(private llm: LlmProvider) {}

  async analyze(context: ProjectSourceContext, targetUrl?: string): Promise<ProjectSummary> {
    logger.step('analyze', 'Calling LLM to analyze project source...');
    logger.info(
      '  This can take a while, especially on local models — progress prints every few seconds.'
    );

    const prompt = buildPrompt(context, targetUrl);

    const summary = await withHeartbeat(
      'project analysis',
      generateValidatedJson<ProjectSummary>(this.llm, ProjectSummarySchema, prompt, SYSTEM_PROMPT, {
        label: 'analyze',
        jsonSchema: PROJECT_SUMMARY_OUTPUT_SCHEMA,
      })
    );

    // Unity inspection is stronger evidence than an LLM classification: this
    // object exists only after the source inspector found and parsed a Unity
    // project, including its Build Settings scenes. Mixed repositories may
    // also contain package.json files (for example, server-side tools), which
    // can otherwise make the LLM incorrectly choose the CLI recorder.
    const platformWasGroundedToUnity = Boolean(context.unity && summary.platform !== 'unity');
    if (platformWasGroundedToUnity) {
      logger.warn(
        `LLM classified the project as '${summary.platform}', but parsed Unity project evidence ` +
          `was found. Using platform='unity'.`
      );
      summary.platform = 'unity';
    }

    switch (summary.platform) {
      case 'cli':
        // CLI applications do not need a background development server.
        // Keep the preparation steps selected from the actual README/scripts by
        // the LLM. Do not blindly add install/build commands: some CLIs are
        // already executable, and their toolchain is not necessarily Node.js.
        // Ground demonstration commands in package.json's declared bin entry
        // rather than accepting an invented executable name from the LLM.
        summary.setupSteps = summary.setupSteps.filter((step) => !step.background);
        if (
          (await cliBuildRequired(context)) &&
          !summary.setupSteps.some((step) => isBuildStep(step.command))
        ) {
          summary.setupSteps.push({
            name: 'Build CLI',
            command: `${context.packageManager} run build`,
            background: false,
            readyTimeoutMs: 60000,
          });
        }
        const cliCommand = declaredCliHelpCommand(context);
        summary.features = summary.features.map((feature) => ({
          ...feature,
          command: groundDeclaredCliCommand(context, feature.command, feature.id) || cliCommand,
        }));
        summary.features = summary.features.filter(
          (feature) => !feature.command || isSafeCliCommand(feature.command)
        );
        break;
      case 'web':
        // Whatever URL the LLM guessed for a background server, replace it
        // with the actual configured target used by Playwright.
        // Also ground the start command in the selected application's
        // package.json. Setup steps execute relative to context.rootDir, so an
        // LLM-generated workspace command such as `pnpm --dir apps/web dev`
        // would otherwise resolve to `apps/web/apps/web`.
        const detectedStartCommand = detectStartCommand(
          context.packageJson,
          context.packageManager
        );
        summary.setupSteps = summary.setupSteps.map((step) =>
          step.background
            ? {
                ...step,
                ...(detectedStartCommand ? { command: detectedStartCommand, cwd: undefined } : {}),
                ...(targetUrl ? { readyUrl: targetUrl } : {}),
              }
            : step
        );
        break;
      case 'unity':
        // Unity Recorder opens configured, enabled, or safely discovered scenes
        // directly. Unity projects do not need Node/server setup commands.
        summary.setupSteps = [];
        const unityScenes = context.unity?.enabledScenes || [];
        const useGeneratedUnityFeatures =
          !platformWasGroundedToUnity && summary.features.length === unityScenes.length;
        summary.features = unityScenes.map((scene, index) => {
          const generated = useGeneratedUnityFeatures ? summary.features[index] : undefined;
          const fallbackTitle =
            scene.path
              .split('/')
              .pop()
              ?.replace(/\.unity$/i, '') || `Scene ${index + 1}`;
          const evidence = scene.objectNames.slice(0, 6).join(', ');
          const controllers = scene.referencedScripts
            .map((path) => path.split('/').pop()?.replace(/\.cs$/i, ''))
            .filter(Boolean)
            .slice(0, 8)
            .join(', ');
          return {
            id: scene.path,
            title: generated?.title || fallbackTitle,
            description:
              generated?.description ||
              `${fallbackTitle} screen. Visible/object evidence: ${evidence || '(none parsed)'}. ` +
                `Behavior/controller evidence: ${controllers || '(none parsed)'}.`,
            demoable: true,
            priority: generated?.priority || 'medium',
          };
        });
        break;
    }

    // When the LLM selected a dependency-install step for a workspace package,
    // ground that particular step at the repository root so workspace:*
    // dependencies can be resolved. Do not invent an install step when the
    // analyzed CLI does not need one.
    if (context.projectPath !== '.' && (await isNodeWorkspaceRoot(context.repositoryRoot))) {
      const workspaceCwd = crossPlatformRelative(context.rootDir, context.repositoryRoot) || '.';
      const installCommand = `${context.packageManager} install`;
      summary.setupSteps = summary.setupSteps.map((step) =>
        isNodePackageManagerInstall(step.command)
          ? { ...step, command: installCommand, cwd: workspaceCwd }
          : step
      );
    }

    logger.success(
      `Analysis complete: platform=${summary.platform}, ${summary.setupSteps.length} setup step(s), ` +
        `${summary.features.length} feature(s) identified.`
    );
    switch (summary.platform) {
      case 'web':
        break;
      case 'cli':
        logger.info(
          `Platform classified as 'cli'. Commands will be recorded in the Docker-based terminal recorder.`
        );
        break;
      default:
        logger.info(
          `Platform classified as '${summary.platform}'. Android, Flutter, and React Native can use ` +
            `Android recording; Unity uses Unity Recorder; other targets report ` +
            `their required recorder environment before recording.`
        );
    }
    return summary;
  }
}

async function isNodeWorkspaceRoot(root: string): Promise<boolean> {
  if (existsSync(resolve(root, 'pnpm-workspace.yaml'))) return true;
  try {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      workspaces?: unknown;
    };
    return Boolean(pkg.workspaces);
  } catch {
    return false;
  }
}

function crossPlatformRelative(from: string, to: string): string {
  const windowsPaths = /^[A-Za-z]:[\\/]/.test(from) && /^[A-Za-z]:[\\/]/.test(to);
  return windowsPaths ? win32.relative(from, to) : relative(from, to);
}

function isNodePackageManagerInstall(command: string): boolean {
  return /^(?:corepack\s+)?(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci)(?:\s|$)/i.test(command.trim());
}

function isBuildStep(command: string): boolean {
  return /^(?:corepack\s+)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile)(?:\s|$)/i.test(
    command.trim()
  );
}

async function cliBuildRequired(context: ProjectSourceContext): Promise<boolean> {
  if (!context.packageJson?.scripts?.build || !context.packageJson.bin) return false;
  const entries =
    typeof context.packageJson.bin === 'string'
      ? [context.packageJson.bin]
      : Object.values(context.packageJson.bin);

  for (const entry of entries) {
    const binPath = resolve(context.rootDir, entry);
    if (!existsSync(binPath)) return true;
    try {
      const source = await readFile(binPath, 'utf8');
      const relativeImports = [
        ...source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g),
      ];
      if (
        relativeImports.some(
          (match) =>
            /(?:^|\/)(?:dist|build|out)\//.test(match[1].replaceAll('\\', '/')) ||
            !existsSync(resolve(dirname(binPath), match[1]))
        )
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function declaredCliHelpCommand(context: ProjectSourceContext): string | undefined {
  const bin = context.packageJson?.bin;
  if (!bin) return undefined;
  const executable =
    typeof bin === 'string' ? bin : Object.values(bin).find((value) => typeof value === 'string');
  if (!executable) return undefined;
  const projectPath =
    context.projectPath === '.' ? '' : `${context.projectPath.replaceAll('\\', '/')}/`;
  return `node ${projectPath}${executable.replace(/^\.\//, '')} --help`;
}

function groundDeclaredCliCommand(
  context: ProjectSourceContext,
  proposed: string | undefined,
  featureId?: string
): string | undefined {
  if (!proposed) return undefined;
  const bin = context.packageJson?.bin;
  if (!bin) return undefined;
  const entries = typeof bin === 'string' ? [['', bin]] : Object.entries(bin);
  const normalized = proposed.trim().replace(/\s+/g, ' ');
  for (const [name, entry] of entries) {
    const projectPath =
      context.projectPath === '.' ? '' : `${context.projectPath.replaceAll('\\', '/')}/`;
    const invocation = `node ${projectPath}${entry.replace(/^\.\//, '')}`;
    const finalFlag = proposed.trim().split(/\s+/).at(-1);
    const safeFlag = ['--help', '-h', '--version', '-v', '--dry-run'].includes(
      finalFlag?.toLowerCase() || ''
    )
      ? finalFlag
      : '--help';
    const proposedLower = proposed.toLowerCase();
    const proposedTokens = `${featureId || ''} ${proposed}`.toLowerCase().split(/[^a-z0-9-]+/);
    const discoveredPath = [...(context.cliCommands || [])]
      .map((path) => {
        const pathLower = path.toLowerCase();
        const pathTokens = pathLower.split(' ');
        const leaf = pathTokens.at(-1)!;
        const score = proposedLower.includes(pathLower)
          ? 100 + pathTokens.length
          : pathTokens.every((token) => proposedTokens.includes(token))
            ? 50 + pathTokens.length
            : proposedTokens.includes(leaf)
              ? 10 - pathTokens.length
              : 0;
        return { path, score };
      })
      .sort((a, b) => b.score - a.score)
      .find((candidate) => candidate.score > 0)?.path;
    if (discoveredPath) {
      const pathIndex = proposedLower.indexOf(discoveredPath.toLowerCase());
      const proposedSuffix =
        pathIndex >= 0 ? proposed.slice(pathIndex + discoveredPath.length).trim() : '';
      let grounded = `${invocation} ${discoveredPath} ${safeFlag}`;
      if (proposedSuffix) {
        const withSampleArguments = `${invocation} ${discoveredPath} ${proposedSuffix}`;
        if (isSafeCliCommand(withSampleArguments)) grounded = withSampleArguments;
      }
      if (
        context.cliDryRunCommands?.includes(discoveredPath) &&
        discoveredPath.endsWith(' analyze')
      ) {
        grounded = `${invocation} ${discoveredPath} --dry-run`;
      }
      if (isSafeCliCommand(grounded)) return grounded;
    }
    if (!isSafeCliCommand(proposed)) return undefined;
    const acceptedPrefixes = [name, context.packageJson?.name, entry, `node ${entry}`]
      .filter(Boolean)
      .map((value) => String(value).replace(/^\.\//, ''));
    const prefix = acceptedPrefixes.find(
      (value) => normalized === value || normalized.startsWith(`${value} `)
    );
    if (prefix) return `${invocation}${normalized.slice(prefix.length)}`;
    if (normalized === invocation || normalized.startsWith(`${invocation} `)) return normalized;
  }
  return undefined;
}

function buildPrompt(context: ProjectSourceContext, targetUrl?: string): string {
  const pkg = context.packageJson;
  const assetFiles = context.assetFiles ?? [];
  const concreteRoutes = context.routes.filter((route) => isConcreteWebRoute(route.path));
  const omittedTemplateCount = context.routes.length - concreteRoutes.length;

  const unitySection = context.unity
    ? `Unity scene-first evidence (authoritative for product analysis):
Editor version: ${context.unity.editorVersion || '(unknown)'}
Recording scenes, in order (${context.unity.sceneSource || 'build-settings'}):
${context.unity.enabledScenes
  .map(
    (scene, index) =>
      `${index}. ${scene.path}\n` +
      `   GameObjects: ${scene.objectNames.join(', ') || '(none parsed)'}\n` +
      `   Referenced project scripts: ${scene.referencedScripts.join(', ') || '(none parsed)'}\n` +
      `   Other referenced assets: ${
        scene.referencedAssets
          .filter((asset) => !scene.referencedScripts.includes(asset))
          .slice(0, 30)
          .join(', ') || '(none parsed)'
      }`
  )
  .join('\n')}

Project script excerpts (use behavior and user-facing names as evidence):
${context.unity.projectScripts
  .map((script) => `--- ${script.path} ---\n${script.excerpt}`)
  .join('\n')}

Installed Unity packages (dependencies only, not product features):
${context.unity.packages.join(', ') || '(none)'}`
    : '';

  const routesSection = context.unity
    ? `${unitySection}

Unity rules:
- Create one demoable feature for each listed recording scene, in exactly the listed order.
- Set each feature id to the exact scene path. Do not set route or command.
- Infer the game/product experience primarily from scene GameObjects and project script excerpts.
- Asset Store libraries, plugins, packages, frameworks, and technical systems are supporting dependencies, never product features.
- If evidence is ambiguous, describe only directly supported visible gameplay or screen purpose; do not invent mechanics.`
    : concreteRoutes.length > 0
      ? `Discovered routes (use these exact paths for the "route" field — do not invent others):\n` +
        concreteRoutes.map((r) => `- ${r.path}  (from ${r.file})`).join('\n') +
        (omittedTemplateCount > 0
          ? `\n${omittedTemplateCount} dynamic route template(s) were omitted because paths such as [slug] cannot be opened directly.`
          : '')
      : context.routes.length > 0
        ? `Only dynamic route templates were discovered. They cannot be opened directly. ` +
          `Use "/" for every feature route; never copy [slug], [...parts], :id, or * into a URL.`
        : `No routes could be auto-discovered for this framework (${context.framework}).\n` +
          `Here is a partial file listing instead. Use "/" unless a concrete path is explicitly present; ` +
          `never invent parameter values:\n` +
          context.fileTree
            .slice(0, 150)
            .map((f) => `- ${f}`)
            .join('\n');

  const platformHint =
    context.platformHints.length > 0
      ? `Deterministic platform signals were already found: ${context.platformHints.join('; ')}.`
      : '';

  return `Analyze this project's source for a promotional demo video.

${buildPlatformClassificationPrompt(context.platformHints)}

## Project details

Project name: ${pkg?.name || '(unknown)'}
Description (from package.json): ${pkg?.description || '(none)'}
Web framework detected (if any): ${context.framework}
Selected application path: ${context.projectPath}
Repository package manager: ${context.packageManager}

package.json scripts: ${JSON.stringify(pkg?.scripts || {})}
package.json bin commands: ${JSON.stringify(pkg?.bin || {})}
Key dependencies: ${(pkg?.dependencies || []).slice(0, 40).join(', ') || '(none listed)'}

${context.readme ? `README:\n${context.readme}\n` : '(No README found)'}

CLI command-definition source excerpts (use exact command names/options only):
${context.cliSourceExcerpt || '(none; do not invent subcommands or options)'}

Statically discovered CLI command paths (exact hierarchy; prepend a declared bin name):
${context.cliCommands?.map((command) => `- ${command}`).join('\n') || '(none discovered)'}

${routesSection}

Representative promotional asset paths (names only; contents were not inspected):
${assetFiles.length > 0 ? assetFiles.map((file) => `- ${file}`).join('\n') : '(none found)'}

${buildSetupPlanningPrompt(targetUrl, platformHint)}

Workspace rule: the source resolver has already selected the application shown above.
Do not search for or start a different workspace package. If the selected path is not
".", any dependency installation you determine is necessary must run at the repository
root using "${context.packageManager} install"; other commands run in the selected
application directory unless the project's own documentation requires otherwise.

CLI setup rule: decide setupSteps from this repository's README, package scripts, bin
entry, lockfile/package manager, and file layout. Include only the preparation actually
needed to make the declared CLI entry executable from a fresh checkout. For example,
install dependencies only when the CLI depends on installed packages, and run a build
script only when the declared bin needs generated output. Do not assume pnpm, npm, yarn,
or bun merely because the project is a CLI; this repository's detected package manager
is "${context.packageManager}". Never add a dev server for a CLI.

CLI demo rule: when this is a CLI, identify multiple distinct, useful subcommands from
the README and command-definition excerpts. Give each demonstrated task its own feature
and exact command. Prefer a safe documented --dry-run example with realistic placeholder
arguments when available; otherwise use that subcommand's --help. Do not repeat the root
--help command for every feature. Preserve the complete parent/child command hierarchy
shown by addCommand calls (for example, a child added to "video" must be invoked through
"<bin> video <child>"). Every feature.command must start with a declared package.json bin
name and end in --help, --version, or a documented --dry-run. Never invent a subcommand,
option, or required argument.

Based on all of the above: first classify the platform (see "Platform classification"),
then produce the setup plan (see "Setup plan"), then identify the features that are
visually demonstrable in a recording, each anchored to a real discovered route where
possible (web only). Also determine the target audience, key value propositions, and
which video types suit this project.

IMPORTANT: setupSteps may contain technical commands because they are only executed
internally. All viewer-facing fields (description, features, targetAudience,
keyValueProps) must use plain, benefit-focused language and must not advertise the
framework, programming language, API, hosting provider, or architecture.

Respond with JSON only.`;
}
