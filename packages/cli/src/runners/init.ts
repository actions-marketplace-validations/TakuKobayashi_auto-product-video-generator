import { join, resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import {
  createDefaultConfig,
  DEFAULT_PLATFORM_PRIORITY,
  saveConfig,
  logger,
  SourceConfig,
} from '@auto-product-video-generator/core';

interface InitOptions {
  repo?: string;
  source?: string;
  ref?: string;
  projectPath?: string;
  platformPriority?: string;
  serveCommand?: string;
  installDeps?: boolean;
  type?: string;
  url?: string;
  name?: string;
  androidPackage?: string;
  androidActivity?: string;
  androidSerial?: string;
  androidAvd?: string;
  androidApk?: string;
  androidBuildCommand?: string;
  androidSdk?: string;
  unityEditor?: string;
  unityScenes?: string;
  force?: boolean;
  dryRun?: boolean;
}

export async function runInit(directory: string, options: InitOptions): Promise<void> {
  logger.header('apvg project init');

  if (!options.repo && !options.source) {
    logger.error('You must specify exactly one of --repo <git-url> or --source <local-path>.');
    logger.error('');
    logger.error('apvg analyzes an actual (version-controlled) project to plan the');
    logger.error('recording, so it needs to know where that project lives:');
    logger.error('  pnpm apvg project init --repo https://github.com/user/repo.git');
    logger.error('  pnpm apvg project init --source ../my-local-project');
    process.exit(1);
  }

  if (options.repo && options.source) {
    logger.error('Specify only one of --repo or --source, not both.');
    process.exit(1);
  }

  const configPath = join(directory, 'apvg.config.yml');

  if (existsSync(configPath) && !options.dryRun && !options.force) {
    logger.warn(`Config already exists: ${configPath}`);
    logger.warn('Delete it, or re-run with --force to overwrite it.');
    process.exit(1);
  }

  // A placeholder keeps the config immediately valid. autoDetectUrl tells
  // analyze to replace it with the local readyUrl inferred from source.
  const url = options.url || 'http://localhost:3000';
  const name = options.name || basename(resolve(options.source || directory));

  const source: SourceConfig = options.repo
    ? {
        repository: options.repo,
        ref: options.ref,
        installDeps: options.installDeps || false,
        startCommand: options.serveCommand,
        projectPath: options.projectPath,
        platformPriority: parsePlatformPriority(options.platformPriority),
        exclude: [],
      }
    : {
        localPath: options.source,
        installDeps: options.installDeps || false,
        startCommand: options.serveCommand,
        projectPath: options.projectPath,
        platformPriority: parsePlatformPriority(options.platformPriority),
        exclude: [],
      };

  const config = createDefaultConfig(name, url, source, !options.url);
  if (
    options.androidPackage ||
    options.androidActivity ||
    options.androidSerial ||
    options.androidAvd ||
    options.androidApk ||
    options.androidBuildCommand ||
    options.androidSdk
  ) {
    config.target.type = 'android';
    config.target.android = {
      package: options.androidPackage,
      activity: options.androidActivity,
      serial: options.androidSerial,
      avd: options.androidAvd,
      apkPath: options.androidApk,
      buildCommand: options.androidBuildCommand,
      sdkPath: options.androidSdk,
      autoStartEmulator: true,
      autoInstall: true,
    };
  }
  if (options.unityEditor || options.unityScenes) {
    config.target.type = 'unity';
    config.target.unity = {
      editorPath: options.unityEditor,
      scenes: options.unityScenes
        ?.split(',')
        .map((scene) => scene.trim())
        .filter(Boolean),
      sceneStartIndex: 0,
      sceneLoadWaitSeconds: 2,
      includeAudio: false,
      timeoutSeconds: 900,
    };
  }
  config.video.type = (options.type as 'teaser' | 'shorts' | 'demo' | 'tutorial') || 'demo';

  if (options.dryRun) {
    logger.dryRun(`Would write: ${configPath}`);
    logger.dryRun(JSON.stringify(config, null, 2));
    return;
  }

  const hasExplicitTarget = Boolean(
    options.url ||
    options.androidPackage ||
    options.androidActivity ||
    options.androidSerial ||
    options.androidAvd ||
    options.androidApk ||
    options.androidBuildCommand ||
    options.androidSdk ||
    options.unityEditor ||
    options.unityScenes
  );
  await saveConfig(configPath, config, { omitAutoDetectedTarget: !hasExplicitTarget });

  logger.success(`Created: ${configPath}`);
  logger.info('');
  logger.info(
    `Source: ${options.repo ? `git repository ${options.repo}${options.ref ? ` (ref: ${options.ref})` : ' (default branch)'}` : `local path ${resolve(options.source!)}`}`
  );
  logger.info(`Target: ${options.url ? url : 'auto-detect from the project during analyze'}`);
  if (config.target.android?.package)
    logger.info(`Android package: ${config.target.android.package}`);
  logger.info(
    `Serve:  ${
      source.startCommand
        ? `'${source.startCommand}' will be run automatically when the target isn't already reachable`
        : `not set — 'analyze' will try to detect one from package.json, or start the app yourself before 'record'/'build'`
    }`
  );
  logger.info(
    `LLM: provider=${config.llm.provider} (${
      config.llm.provider === 'gemini' ? 'GEMINI_API_KEY was set' : 'GEMINI_API_KEY was not set'
    }), fallbackProvider=${config.llm.fallbackProvider}`
  );
  logger.info('Video:  non-technical, product-usage-focused promotion (built-in default)');
  logger.info('');
  logger.info('Next steps:');
  logger.dim(`  1. Run: pnpm apvg project analyze`);
  logger.dim(`  2. Run: pnpm apvg video scenario generate`);
  logger.dim(`  3. Run: pnpm apvg video voice`);
  logger.dim(`  4. Run: pnpm apvg video record`);
  logger.dim(`  5. Run: pnpm apvg video render`);
  logger.dim(`  Or run all five at once: pnpm apvg video generate`);
}

function parsePlatformPriority(value?: string): SourceConfig['platformPriority'] {
  if (!value) return DEFAULT_PLATFORM_PRIORITY;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean) as SourceConfig['platformPriority'];
}
