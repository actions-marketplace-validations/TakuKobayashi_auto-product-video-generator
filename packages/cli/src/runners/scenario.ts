import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import {
  loadConfig,
  readJson,
  writeYaml,
  ensureDir,
  logger,
  describeTaskLlm,
  ProjectSummary,
  ScenarioSchema,
} from '@auto-product-video-generator/core';
import {
  createLlmProviderForTask,
  ScenarioGenerator,
  SubtitleGenerator,
} from '@auto-product-video-generator/ai';
import { resolveVoiceProfiles } from '@auto-product-video-generator/voicevox';
import { applyResolvedConfig } from '../utils/resolved-config.js';

interface ScenarioGenerateOptions {
  config?: string;
  type?: string;
  prompt?: string;
  projectSummary?: string;
  scenario?: string;
  script?: string;
  subtitles?: string;
  force?: boolean;
  dryRun?: boolean;
}

export async function runScenarioGenerate(options: ScenarioGenerateOptions): Promise<void> {
  logger.header('apvg video scenario generate');

  const configPath = options.config || 'apvg.config.yml';
  const config = await applyResolvedConfig(await loadConfig(configPath));

  const workDir = config.output.workDir;
  const summaryPath = options.projectSummary || join(workDir, 'project-summary.json');
  const scenarioPath = options.scenario || join(workDir, 'scenario.yml');
  const scriptPath = options.script || join(workDir, 'script.yml');
  const srtPath = options.subtitles || join(workDir, 'subtitles.srt');

  if (!existsSync(summaryPath)) {
    logger.error(`project-summary.json not found. Run 'pnpm apvg project analyze' first.`);
    process.exit(1);
  }

  if (existsSync(scenarioPath) && !options.force && !options.dryRun) {
    logger.warn(`${scenarioPath} already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  const summary = await readJson<ProjectSummary>(summaryPath);

  const videoConfig = {
    ...config.video,
    ...(options.type ? { type: options.type as 'teaser' | 'shorts' | 'demo' | 'tutorial' } : {}),
    ...(options.prompt ? { scenarioPrompt: options.prompt } : {}),
  };

  if (options.dryRun) {
    logger.dryRun(`Would generate scenario for: ${summary.name}`);
    logger.dryRun(
      `Video type: ${videoConfig.type}, duration: ${videoConfig.duration === undefined ? 'unrestricted' : `~${videoConfig.duration}s`}`
    );
    logger.dryRun(`Would write: ${scenarioPath}`);
    logger.dryRun(`Would write: ${scriptPath}`);
    logger.dryRun(`Would write: ${srtPath}`);
    return;
  }

  await Promise.all(
    [workDir, dirname(scenarioPath), dirname(scriptPath), dirname(srtPath)].map(ensureDir)
  );

  logger.info(`LLM: ${describeTaskLlm(config.llm, 'scenario')}`);

  const llm = createLlmProviderForTask(config.llm, 'scenario');
  const generator = new ScenarioGenerator(llm);
  const generateEmotion = resolveVoiceProfiles(config.voice, config.voicevox).some((profile) => {
    switch (profile.type) {
      case 'voicevox':
        return false;
      case 'aitalk':
        return profile.options.style === undefined;
    }
  });
  const { scenario, script } = await generator.generate(
    summary,
    videoConfig,
    config.target.url,
    generateEmotion
  );

  await writeYaml(scenarioPath, scenario);
  logger.success(`Saved: ${scenarioPath}`);

  await writeYaml(scriptPath, script);
  logger.success(`Saved: ${scriptPath}`);

  const subtitleGen = new SubtitleGenerator();
  const srt = subtitleGen.generateSrt(script, {
    singleLine: videoConfig.singleLineSubtitles,
  });
  await writeFile(srtPath, srt, 'utf-8');
  logger.success(`Saved: ${srtPath}`);

  logger.info('');
  logger.info(`Generated ${scenario.scenes.length} scenes:`);
  for (const scene of scenario.scenes) {
    logger.dim(`  • [${scene.id}] ${scene.title} (${scene.actions.length} actions)`);
  }
  logger.info('');
  logger.info('Review and edit the files above, then run:');
  logger.dim('  pnpm apvg video voice');
}

export async function runScenarioValidate(filePath: string): Promise<void> {
  logger.header('apvg video scenario validate');

  if (!existsSync(filePath)) {
    logger.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const { readYaml } = await import('@auto-product-video-generator/core');
  const raw = await readYaml(filePath);

  const result = ScenarioSchema.safeParse(raw);
  if (result.success) {
    logger.success(`Valid scenario: ${filePath}`);
    logger.dim(`  ${result.data.scenes.length} scenes, type: ${result.data.meta.type}`);
  } else {
    logger.error(`Invalid scenario: ${filePath}`);
    for (const issue of result.error.issues) {
      logger.error(`  ${issue.path.join('.')} — ${issue.message}`);
    }
    process.exit(1);
  }
}
