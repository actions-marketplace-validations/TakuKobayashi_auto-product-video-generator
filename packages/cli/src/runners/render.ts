import { basename, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  loadConfig,
  readJson,
  readYaml,
  writeJson,
  logger,
  resolveFfmpegPath,
  ScenarioSchema,
  ScriptSchema,
  TimelineSchema,
} from '@auto-product-video-generator/core';
import { TimelineBuilder } from '@auto-product-video-generator/ai';
import { FfmpegRenderer } from '@auto-product-video-generator/renderer';
import { exportArtifacts } from '../utils/export-artifacts.js';

interface RenderOptions {
  config?: string;
  scenario?: string;
  script?: string;
  voiceDir?: string;
  recordingsDir?: string;
  screenshotsDir?: string;
  subtitlesFile?: string;
  timeline?: string;
  output?: string;
  artifactsDir?: string;
  subtitles?: boolean;
  voice?: boolean;
  preview?: boolean;
  ffmpeg?: string;
  dryRun?: boolean;
}

export async function runRender(options: RenderOptions): Promise<void> {
  logger.header('apvg video render');

  const configPath = options.config || 'apvg.config.yml';
  const config = await loadConfig(configPath);

  const workDir = config.output.workDir;
  const scenarioPath = options.scenario || join(workDir, 'scenario.yml');
  const scriptPath = options.script || join(workDir, 'script.yml');
  const voiceDir = resolve(options.voiceDir || join(workDir, 'voice'));
  const recordingsDir = resolve(options.recordingsDir || join(workDir, 'recordings'));
  const screenshotsDir = resolve(options.screenshotsDir || join(workDir, 'screenshots'));
  const subtitlesPath = resolve(options.subtitlesFile || join(workDir, 'subtitles.srt'));
  const timelinePath = options.timeline || join(workDir, 'timeline.json');
  const outputPath = options.output || join(config.output.dir, 'final.mp4');

  // Validate prerequisites
  for (const [label, p] of [
    ['scenario.yml', scenarioPath],
    ['script.yml', scriptPath],
  ] as const) {
    if (!existsSync(p)) {
      logger.error(`${label} not found: ${p}`);
      logger.error(`Run 'pnpm apvg video scenario generate' first.`);
      process.exit(1);
    }
  }

  // Build timeline.json (deterministic from scenario + script)
  const rawScenario = await readYaml(scenarioPath);
  const scenario = ScenarioSchema.parse(rawScenario);

  const rawScript = await readYaml(scriptPath);
  const script = ScriptSchema.parse(rawScript);

  const builder = new TimelineBuilder();
  const timeline = builder.build(scenario, script, config.video);
  for (const track of timeline.tracks) {
    if (track.type === 'video') track.src = join(recordingsDir, basename(track.src));
    if (track.type === 'audio') track.src = join(voiceDir, basename(track.src));
  }

  await writeJson(timelinePath, timeline);
  logger.success(`Built: ${timelinePath}`);

  const noSubtitles = options.subtitles === false || !config.video.subtitles;
  const noVoice = options.voice === false;

  const ffmpegPath = resolveFfmpegPath(options.ffmpeg);
  logger.info(`ffmpeg:       ${ffmpegPath}`);
  logger.info(`Output:       ${outputPath}`);
  logger.info(`Subtitles:    ${!noSubtitles}`);
  logger.info(`Voice:        ${!noVoice}`);
  logger.info(`Preview mode: ${options.preview || false}`);
  logger.info(`Total scenes: ${timeline.tracks.filter((t) => t.type === 'video').length}`);
  logger.info(`Duration:     ${timeline.meta.totalDuration.toFixed(1)}s`);

  const renderer = new FfmpegRenderer();
  await renderer.render(timeline, outputPath, {
    noSubtitles,
    noVoice,
    preview: options.preview || false,
    dryRun: options.dryRun || false,
    ffmpegPath,
    workDir,
    subtitlesPath,
  });

  if (!options.dryRun) {
    await exportArtifacts(workDir, config.output.dir, configPath, {
      files: {
        'scenario.yml': scenarioPath,
        'script.yml': scriptPath,
        'subtitles.srt': subtitlesPath,
        'timeline.json': timelinePath,
      },
      dirs: {
        voice: voiceDir,
        recordings: recordingsDir,
        screenshots: screenshotsDir,
      },
      artifactsDir: options.artifactsDir,
    });
    logger.info('');
    logger.success(`Done! Video saved to: ${outputPath}`);
  }
}
