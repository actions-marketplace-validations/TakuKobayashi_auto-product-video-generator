import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import {
  loadConfig,
  readJson,
  readYaml,
  writeJson,
  writeYaml,
  ensureDir,
  logger,
  describeTaskLlm,
  resolveFfmpegPath,
  UnityConfigSchema,
  ProjectSummary,
  ScenarioSchema,
  ScriptSchema,
} from '@auto-product-video-generator/core';
import {
  createLlmProviderForTask,
  ProjectAnalyzer,
  ScenarioGenerator,
  SubtitleGenerator,
  TimelineBuilder,
  recomputeScriptTimingFromAudio,
} from '@auto-product-video-generator/ai';
import {
  captureSceneScreenshot,
  createPlatformRecorder,
} from '@auto-product-video-generator/recorder';
import { VoicevoxClient, resolveVoiceProfiles } from '@auto-product-video-generator/voicevox';
import { FfmpegRenderer } from '@auto-product-video-generator/renderer';
import {
  resolveProjectSource,
  inspectProject,
  detectStartCommand,
  ensureAppRunning,
  findRepositoryRoot,
  loadSourceExcludePatterns,
  placeProjectEnvironmentFile,
} from '@auto-product-video-generator/source';
import { exportArtifacts } from '../utils/export-artifacts.js';
import { applyInferredTargetUrl } from '../utils/inferred-target.js';
import { applyResolvedConfig, saveResolvedConfig } from '../utils/resolved-config.js';
import { resolveWebStorageState } from '../utils/web-auth.js';

interface BuildOptions {
  config?: string;
  type?: string;
  url?: string;
  scenarioPrompt?: string;
  envFile?: string;
  skipAnalyze?: boolean;
  skipScenario?: boolean;
  skipRecord?: boolean;
  skipVoice?: boolean;
  subtitles?: boolean;
  screenshots?: boolean;
  preview?: boolean;
  headed?: boolean;
  dryRun?: boolean;
}

export async function runBuild(options: BuildOptions): Promise<void> {
  logger.header('apvg video generate');

  const configPath = options.config || 'apvg.config.yml';
  let config = await loadConfig(configPath);

  // Apply overrides
  if (options.url) {
    config.target.url = options.url;
    config.target.autoDetectUrl = false;
  }
  if (options.type) config.video.type = options.type as typeof config.video.type;
  if (options.scenarioPrompt) config.video.scenarioPrompt = options.scenarioPrompt;
  if (options.skipAnalyze) config = await applyResolvedConfig(config);

  const workDir = config.output.workDir;
  await ensureDir(workDir);

  logger.info(`Source:  ${config.source.repository || config.source.localPath}`);
  logger.info(
    `Target:  ${config.target.autoDetectUrl ? 'auto-detect from source' : config.target.url}`
  );
  logger.info(
    `Video:   ${config.video.type}, ${config.video.duration === undefined ? 'unrestricted length' : `~${config.video.duration}s`}`
  );
  logger.info(`LLM (analyze):  ${describeTaskLlm(config.llm, 'analyze')}`);
  logger.info(`LLM (scenario): ${describeTaskLlm(config.llm, 'scenario')}`);
  logger.info('');

  const summaryPath = join(workDir, 'project-summary.json');
  const contextPath = join(workDir, 'source-context.json');
  const cloneDir = join(workDir, 'source-repo');
  const scenarioPath = join(workDir, 'scenario.yml');
  const scriptPath = join(workDir, 'script.yml');
  const srtPath = join(workDir, 'subtitles.srt');
  const timelinePath = join(workDir, 'timeline.json');
  const recordingsDir = join(workDir, 'recordings');
  const voiceDir = join(workDir, 'voice');
  const screenshotDir = join(workDir, 'screenshots');
  const outputPath = join(config.output.dir, 'final.mp4');

  const analyzeLlm = createLlmProviderForTask(config.llm, 'analyze');
  const scenarioLlm = createLlmProviderForTask(config.llm, 'scenario');
  const dryRun = options.dryRun || false;

  // Resolved once upfront (not just in the analyze step) since the record
  // step also needs it to know where to run source.startCommand from.
  let rootDir: string | undefined;
  if (!dryRun) {
    rootDir = await resolveProjectSource({ source: config.source, cloneDir });
    const environmentFile = options.envFile || config.source.environmentFile;
    if (environmentFile) {
      const placed = await placeProjectEnvironmentFile(environmentFile, rootDir);
      logger.info(`Project environment (${placed.kind}): ${placed.path}`);
    }
  }

  // ── Step 1: Analyze ──────────────────────────────────────────────────────
  let summary: ProjectSummary;
  if (!options.skipAnalyze) {
    logger.step('1/5', 'Analyzing project source...');
    if (!dryRun) {
      const sourceContext = await inspectProject(
        rootDir!,
        config.source.exclude,
        config.target.unity?.scenes
      );
      await writeJson(contextPath, sourceContext);

      if (!config.source.startCommand) {
        const detected = detectStartCommand(
          sourceContext.packageJson,
          sourceContext.packageManager
        );
        if (detected) {
          config.source.startCommand = detected;
          logger.info(`Detected dev server command '${detected}'.`);
        }
      }

      const analyzer = new ProjectAnalyzer(analyzeLlm);
      summary = await analyzer.analyze(
        sourceContext,
        config.target.autoDetectUrl ? undefined : config.target.url
      );
      applyInferredTargetUrl(config, summary);
      switch (summary.platform) {
        case 'android':
        case 'flutter':
        case 'react-native':
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
            config.target.unity.scenes = sourceContext.unity.enabledScenes.map(
              (scene) => scene.path
            );
          }
          logger.info(`Enabled Unity Recorder scene capture (${sourceContext.unity?.sceneSource}).`);
          break;
        case 'cli':
          config.target.type = 'cli';
          logger.info(`Enabled Docker-based CLI recording.`);
          break;
      }
      await writeJson(summaryPath, summary);
      await saveResolvedConfig(config, summary.platform);
      logger.success(`Saved: ${summaryPath}`);
    } else {
      logger.dryRun(`Would resolve source: ${config.source.repository || config.source.localPath}`);
      logger.dryRun(`Would write: ${contextPath}`);
      logger.dryRun(`Would write: ${summaryPath}`);
      summary = {
        name: config.project.name,
        description: '',
        platform: 'web',
        setupSteps: [],
        features: [],
        targetAudience: '',
        keyValueProps: [],
        suggestedVideoTypes: [],
        analyzedAt: new Date().toISOString(),
      };
    }
  } else {
    logger.step('1/5', 'Skipping analyze (--skip-analyze)');
    if (!existsSync(summaryPath)) {
      logger.error(`project-summary.json not found: ${summaryPath}`);
      process.exit(1);
    }
    summary = await readJson<ProjectSummary>(summaryPath);
  }

  // ── Step 2: Scenario ─────────────────────────────────────────────────────
  let scenario: ReturnType<typeof ScenarioSchema.parse>;
  let script: ReturnType<typeof ScriptSchema.parse>;

  if (!options.skipScenario) {
    logger.step('2/5', 'Generating scenario...');
    const generator = new ScenarioGenerator(scenarioLlm);
    const voiceProfiles = resolveVoiceProfiles(config.voice, config.voicevox);
    const generateEmotion = voiceProfiles.some((profile) => {
      switch (profile.type) {
        case 'voicevox':
          return false;
        case 'aitalk':
          return profile.options.style === undefined;
      }
    });
    const result = await generator.generate(
      summary,
      config.video,
      config.target.url,
      generateEmotion
    );
    scenario = result.scenario;
    script = result.script;

    if (!dryRun) {
      const subtitleGen = new SubtitleGenerator();
      await Promise.all([
        writeYaml(scenarioPath, scenario),
        writeYaml(scriptPath, script),
        writeFile(
          srtPath,
          subtitleGen.generateSrt(script, {
            singleLine: config.video.singleLineSubtitles,
          }),
          'utf-8'
        ),
      ]);
      logger.success(`Saved scenario, script, subtitles`);
    } else {
      logger.dryRun(`Would write: ${scenarioPath}, ${scriptPath}, ${srtPath}`);
    }
  } else {
    logger.step('2/5', 'Skipping scenario (--skip-scenario)');
    for (const [label, p] of [
      ['scenario.yml', scenarioPath],
      ['script.yml', scriptPath],
    ] as const) {
      if (!existsSync(p)) {
        logger.error(`${label} not found: ${p}`);
        process.exit(1);
      }
    }
    const [scenarioData, scriptData] = await Promise.all([
      readYaml(scenarioPath),
      readYaml(scriptPath),
    ]);
    scenario = ScenarioSchema.parse(scenarioData);
    script = ScriptSchema.parse(scriptData);
  }

  // ── Step 3: Voice ────────────────────────────────────────────────────────
  if (!options.skipVoice) {
    logger.step('3/5', 'Synthesizing voice narration...');
    if (!dryRun) {
      const profiles = resolveVoiceProfiles(config.voice, config.voicevox);
      const voicevox = new VoicevoxClient(profiles);
      const healthy = await voicevox.checkHealth();
      if (!healthy) {
        throw new Error(
          `One or more configured voice engines are not available: ` +
            profiles.map((profile) => profile.url).join(', ')
        );
      } else {
        await voicevox.synthesizeAll(script, { outputDir: voiceDir, dryRun });
        script = await recomputeScriptTimingFromAudio(
          script,
          voiceDir,
          config.video.sceneGapSeconds
        );
        await Promise.all([
          writeYaml(scriptPath, script),
          writeFile(
            srtPath,
            new SubtitleGenerator().generateSrt(script, {
              singleLine: config.video.singleLineSubtitles,
            }),
            'utf-8'
          ),
        ]);
        logger.success('Updated script and subtitles from actual audio durations.');
      }
    } else {
      logger.dryRun(`Would synthesize ${script.scenes.length} voice files`);
    }
  } else {
    logger.step('3/5', 'Skipping voice (--skip-voice)');
    if (!dryRun && !options.skipRecord) {
      for (const scriptScene of script.scenes) {
        const voicePath = join(workDir, scriptScene.voiceFile);
        if (!existsSync(voicePath)) {
          throw new Error(`Voice file not found: ${voicePath}. Voice must run before recording.`);
        }
      }
      script = await recomputeScriptTimingFromAudio(script, voiceDir, config.video.sceneGapSeconds);
      await Promise.all([
        writeYaml(scriptPath, script),
        writeFile(
          srtPath,
          new SubtitleGenerator().generateSrt(script, {
            singleLine: config.video.singleLineSubtitles,
          }),
          'utf-8'
        ),
      ]);
    }
  }

  // ── Step 4: Record ───────────────────────────────────────────────────────
  if (!options.skipRecord) {
    let startedApp: Awaited<ReturnType<typeof ensureAppRunning>>;
    logger.step('4/5', `Recording ${scenario.meta.platform} interactions...`);
    if (!dryRun) {
      for (const scriptScene of script.scenes) {
        const voicePath = join(workDir, scriptScene.voiceFile);
        if (!existsSync(voicePath)) {
          throw new Error(`Voice file not found: ${voicePath}. Voice must run before recording.`);
        }
      }
      if (scenario.meta.platform === 'web') {
        startedApp = await ensureAppRunning({
          url: config.target.url,
          setupSteps: scenario.setup,
          startCommand: config.source.startCommand,
          cwd: rootDir!,
          installDeps: config.source.installDeps,
          logPath: join(workDir, 'dev-server.log'),
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
    const storageStatePath = resolveWebStorageState(config, scenario.meta.platform, dryRun);
    try {
      for (const scene of scenario.scenes) {
        const scriptIndex = script.scenes.findIndex((item) => item.id === scene.id);
        if (scriptIndex < 0) throw new Error(`Scene '${scene.id}' is missing from script.yml.`);
        const scriptScene = script.scenes[scriptIndex];
        const nextScene = script.scenes[scriptIndex + 1];
        const targetDurationSeconds =
          (nextScene?.startTime ?? scriptScene.endTime) - scriptScene.startTime;
        await recorder.recordScene(
          scene,
          config.video,
          {
            headed: options.headed || false,
            slowMo: 0,
            outputDir: recordingsDir,
            screenshotDir,
            dryRun,
            storageStatePath,
          },
          targetDurationSeconds,
          scriptScene.endTime - scriptScene.startTime
        );
      }
      await recorder.finalize?.();
      if (!dryRun && options.screenshots !== false && config.video.screenshots) {
        for (const scene of scenario.scenes) {
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
  } else {
    logger.step('4/5', 'Skipping record (--skip-record)');
  }

  // ── Step 5: Render ───────────────────────────────────────────────────────
  logger.step('5/5', 'Rendering final video...');
  const builder = new TimelineBuilder();
  const timeline = builder.build(scenario, script, config.video);
  if (!dryRun) await writeJson(timelinePath, timeline);

  const renderer = new FfmpegRenderer();
  await renderer.render(timeline, outputPath, {
    noSubtitles: options.subtitles === false || !config.video.subtitles,
    noVoice: options.skipVoice || false,
    preview: options.preview || false,
    dryRun,
    ffmpegPath: resolveFfmpegPath(),
    workDir,
  });

  if (!dryRun) {
    await exportArtifacts(workDir, config.output.dir, configPath);
  }

  logger.info('');
  logger.success(dryRun ? 'Dry-run complete.' : `Build complete! → ${outputPath}`);
}
