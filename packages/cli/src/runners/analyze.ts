import { join } from 'node:path';
import {
  loadConfig,
  writeJson,
  logger,
  describeTaskLlm,
  UnityConfigSchema,
} from '@auto-product-video-generator/core';
import { createLlmProviderForTask, ProjectAnalyzer } from '@auto-product-video-generator/ai';
import {
  resolveProjectSource,
  inspectProject,
  detectStartCommand,
} from '@auto-product-video-generator/source';
import { applyInferredTargetUrl } from '../utils/inferred-target.js';
import { saveResolvedConfig } from '../utils/resolved-config.js';

interface AnalyzeOptions {
  config?: string;
  url?: string;
  sourceDir?: string;
  sourceContext?: string;
  projectSummary?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

export async function runAnalyze(options: AnalyzeOptions): Promise<void> {
  logger.header('apvg project analyze');

  const configPath = options.config || 'apvg.config.yml';
  const config = await loadConfig(configPath);

  if (options.url) {
    config.target.url = options.url;
    config.target.autoDetectUrl = false;
  }
  const targetUrl = config.target.autoDetectUrl ? undefined : config.target.url;
  const cloneDir = options.sourceDir || join(config.output.workDir, 'source-repo');
  const contextPath = options.sourceContext || join(config.output.workDir, 'source-context.json');
  const summaryPath = options.projectSummary || join(config.output.workDir, 'project-summary.json');

  logger.info(`Source:     ${config.source.repository || config.source.localPath}`);
  logger.info(`Target URL: ${targetUrl || 'auto-detect from source'}`);
  logger.info(`LLM:        ${describeTaskLlm(config.llm, 'analyze')}`);

  if (options.dryRun) {
    logger.dryRun('Would resolve project source (clone/verify) and inspect it for routes.');
    logger.dryRun(`Would write: ${contextPath}`);
    logger.dryRun('Would call LLM to analyze project.');
    logger.dryRun(`Would write: ${summaryPath}`);
    return;
  }

  // Deterministic: resolve (clone or verify local) + inspect the actual source.
  logger.step('source', 'Resolving project source (this may take a moment for a fresh clone)...');
  const rootDir = await resolveProjectSource({ source: config.source, cloneDir });
  const sourceContext = await inspectProject(
    rootDir,
    config.source.exclude,
    config.target.unity?.scenes
  );

  await writeJson(contextPath, sourceContext);
  logger.success(`Saved: ${contextPath}`);

  if (sourceContext.routes.length === 0) {
    logger.warn(
      `No routes could be auto-discovered for framework '${sourceContext.framework}'. ` +
        `The AI will infer routes from the file listing instead — review scenario.yml carefully after generation.`
    );
  }

  // If apvg.config.yml doesn't already say how to start the dev server,
  // suggest one from package.json's scripts and save it — 'record'/'build'
  // will use it to start the app automatically instead of requiring it to
  // already be running.
  if (!config.source.startCommand) {
    const detected = detectStartCommand(sourceContext.packageJson, sourceContext.packageManager);
    if (detected) {
      config.source.startCommand = detected;
      logger.info(`Detected dev server command '${detected}' (stored in resolved analysis state).`);
      logger.dim(`  Set source.startCommand in apvg.config.yml to override this detection.`);
    }
  }

  // AI: turn the deterministic source context into a feature summary.
  const llm = createLlmProviderForTask(config.llm, 'analyze');
  const analyzer = new ProjectAnalyzer(llm);
  const summary = await analyzer.analyze(sourceContext, targetUrl);

  applyInferredTargetUrl(config, summary);

  switch (summary.platform) {
    case 'android':
    case 'flutter':
    case 'react-native':
      // Build/install/emulator setup is deterministic in AndroidRecorder; do
      // not retain an LLM-guessed setup plan that would duplicate those steps.
      summary.setupSteps = [];
      config.target.type = 'android';
      config.target.android ||= { autoStartEmulator: true, autoInstall: true };
      logger.info(`Enabled automatic Android build/emulator preparation.`);
      break;
    case 'unity':
      summary.setupSteps = [];
      config.target.type = 'unity';
      config.target.unity = UnityConfigSchema.parse(config.target.unity || {});
      if (
        sourceContext.unity?.sceneSource === 'discovered' &&
        !config.target.unity.scenes?.length
      ) {
        config.target.unity.scenes = sourceContext.unity.enabledScenes.map((scene) => scene.path);
      }
      logger.info(`Enabled Unity Recorder scene capture (${sourceContext.unity?.sceneSource}).`);
      break;
    case 'cli':
      config.target.type = 'cli';
      logger.info(`Enabled Docker-based CLI recording.`);
      break;
  }

  await writeJson(summaryPath, summary);
  const resolvedPath = await saveResolvedConfig(config, summary.platform);

  logger.success(`Saved: ${summaryPath}`);
  logger.success(`Saved: ${resolvedPath}`);
  logger.info('');
  logger.info(`Platform: ${summary.platform}`);
  logger.info(`Found ${summary.features.length} features:`);
  for (const f of summary.features) {
    const mark = f.priority === 'high' ? '★' : f.priority === 'medium' ? '◆' : '◇';
    logger.dim(`  ${mark} [${f.priority}] ${f.title}  ${f.route ? `(${f.route})` : ''}`);
  }
  logger.info('');
  logger.info('Next: pnpm apvg video scenario generate');
}
