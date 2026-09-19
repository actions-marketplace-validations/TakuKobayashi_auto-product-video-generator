import { basename, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  ensureDir,
  loadConfig,
  readYaml,
  logger,
  ScenarioSchema,
  ScriptSchema,
} from '@auto-product-video-generator/core';
import {
  captureSceneScreenshot,
  createPlatformRecorder,
} from '@auto-product-video-generator/recorder';
import {
  resolveProjectSource,
  ensureAppRunning,
  findRepositoryRoot,
  loadSourceExcludePatterns,
  placeProjectEnvironmentFile,
} from '@auto-product-video-generator/source';
import { resolveWebStorageState } from '../utils/web-auth.js';
import { applyResolvedConfig } from '../utils/resolved-config.js';

interface RecordOptions {
  config?: string;
  scenario?: string;
  script?: string;
  voiceDir?: string;
  recordingsDir?: string;
  screenshotsDir?: string;
  sourceDir?: string;
  envFile?: string;
  serverLog?: string;
  scene?: string;
  headed?: boolean;
  slowMo?: string;
  dryRun?: boolean;
  screenshots?: boolean;
}

export async function runRecord(options: RecordOptions): Promise<void> {
  logger.header('apvg video record');

  const configPath = options.config || 'apvg.config.yml';
  const config = await applyResolvedConfig(await loadConfig(configPath));

  const workDir = config.output.workDir;
  const scenarioPath = options.scenario || join(workDir, 'scenario.yml');
  const scriptPath = options.script || join(workDir, 'script.yml');

  if (!existsSync(scenarioPath)) {
    logger.error(`scenario.yml not found. Run 'pnpm apvg video scenario generate' first.`);
    process.exit(1);
  }

  const rawScenario = await readYaml(scenarioPath);
  const scenario = ScenarioSchema.parse(rawScenario);

  if (!existsSync(scriptPath)) {
    throw new Error(`script.yml not found. Run 'pnpm apvg video voice' before recording.`);
  }
  const script = ScriptSchema.parse(await readYaml(scriptPath));

  const voiceDir = options.voiceDir || join(workDir, 'voice');
  const recordingsDir = options.recordingsDir || join(workDir, 'recordings');
  const screenshotDir = options.screenshotsDir || join(workDir, 'screenshots');

  const scenesToRecord = options.scene
    ? scenario.scenes.filter((s) => s.id === options.scene)
    : scenario.scenes;

  if (scenesToRecord.length === 0) {
    logger.error(`Scene '${options.scene}' not found in scenario.`);
    logger.error(`Available scenes: ${scenario.scenes.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  logger.info(`Scenes to record: ${scenesToRecord.map((s) => s.id).join(', ')}`);
  logger.info(`Output dir:       ${recordingsDir}`);
  logger.info(`Headed:           ${options.headed || false}`);
  logger.info(`Slow-mo:          ${options.slowMo || '0'}ms`);

  let rootDir: string | undefined;
  let startedApp: Awaited<ReturnType<typeof ensureAppRunning>>;
  if (!options.dryRun) {
    const cloneDir = options.sourceDir || join(workDir, 'source-repo');
    rootDir = await resolveProjectSource({ source: config.source, cloneDir });
    const environmentFile = options.envFile || config.source.environmentFile;
    if (environmentFile) {
      const placed = await placeProjectEnvironmentFile(environmentFile, rootDir);
      logger.info(`Project environment (${placed.kind}): ${placed.path}`);
    }
    if (scenario.meta.platform === 'web') {
      const serverLogPath = options.serverLog || join(workDir, 'dev-server.log');
      await ensureDir(dirname(serverLogPath));
      startedApp = await ensureAppRunning({
        url: config.target.url,
        setupSteps: scenario.setup,
        startCommand: config.source.startCommand,
        cwd: rootDir,
        installDeps: config.source.installDeps,
        logPath: serverLogPath,
      });
    }
  }

  const repositoryRoot = rootDir ? findRepositoryRoot(rootDir) : undefined;
  const sourceExcludePatterns = repositoryRoot
    ? await loadSourceExcludePatterns(repositoryRoot, config.source.exclude)
    : [];
  const recorder = createPlatformRecorder(scenario.meta.platform, config, {
    rootDir,
    repositoryRoot,
    workDir,
    setupSteps: scenario.setup,
    sourceExcludePatterns,
  });
  const storageStatePath = resolveWebStorageState(
    config,
    scenario.meta.platform,
    options.dryRun || false
  );

  try {
    for (const scene of scenesToRecord) {
      const scriptIndex = script.scenes.findIndex((item) => item.id === scene.id);
      if (scriptIndex < 0) throw new Error(`Scene '${scene.id}' is missing from script.yml.`);
      const scriptScene = script.scenes[scriptIndex];
      const voicePath = join(voiceDir, basename(scriptScene.voiceFile));
      if (!options.dryRun && !existsSync(voicePath)) {
        throw new Error(
          `Voice file not found: ${voicePath}. Run 'pnpm apvg video voice' before recording.`
        );
      }
      const nextScene = script.scenes[scriptIndex + 1];
      const targetDurationSeconds =
        (nextScene?.startTime ?? scriptScene.endTime) - scriptScene.startTime;
      logger.info('');
      await recorder.recordScene(
        scene,
        config.video,
        {
          headed: options.headed || false,
          slowMo: parseInt(options.slowMo || '0', 10),
          outputDir: recordingsDir,
          screenshotDir,
          dryRun: options.dryRun || false,
          sceneIndex: scenario.scenes.findIndex((item) => item.id === scene.id),
          storageStatePath,
        },
        targetDurationSeconds,
        scriptScene.endTime - scriptScene.startTime
      );
    }
    await recorder.finalize?.();
    if (!options.dryRun && options.screenshots !== false && config.video.screenshots) {
      for (const scene of scenesToRecord) {
        await captureSceneScreenshot(
          join(recordingsDir, `scene-${scene.id}.mp4`),
          join(screenshotDir, `scene-${scene.id}.png`)
        );
      }
    }
  } finally {
    await recorder.dispose?.();
    await startedApp?.stop();
  }

  logger.info('');
  logger.success('Recording complete.');
  if (!options.dryRun) {
    logger.info('Next: pnpm apvg video render');
  }
}
