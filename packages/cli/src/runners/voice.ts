import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import {
  ensureDir,
  loadConfig,
  readYaml,
  writeYaml,
  logger,
  ScriptSchema,
  VoiceProfile,
} from '@auto-product-video-generator/core';
import {
  recomputeScriptTimingFromAudio,
  SubtitleGenerator,
} from '@auto-product-video-generator/ai';
import { VoicevoxClient, resolveVoiceProfiles } from '@auto-product-video-generator/voicevox';

interface VoiceOptions {
  config?: string;
  script?: string;
  voiceDir?: string;
  subtitles?: string;
  speaker?: string;
  scene?: string;
  dryRun?: boolean;
}

function overrideVoicevoxSpeaker(profile: VoiceProfile, speakerId: number): VoiceProfile {
  switch (profile.type) {
    case 'voicevox':
      return { ...profile, speakerId };
    case 'aitalk':
      return profile;
  }
}

function describeVoiceProfile(profile: VoiceProfile): string {
  switch (profile.type) {
    case 'voicevox':
      return `${profile.name ?? profile.type} (${profile.url}, speaker=${profile.speakerId})`;
    case 'aitalk':
      return `${profile.name ?? profile.type} (${profile.url}, speaker=${profile.speakerName})`;
  }
}

export async function runVoice(options: VoiceOptions): Promise<void> {
  logger.header('apvg video voice');

  const configPath = options.config || 'apvg.config.yml';
  const config = await loadConfig(configPath);

  const workDir = config.output.workDir;
  const scriptPath = options.script || join(workDir, 'script.yml');

  if (!existsSync(scriptPath)) {
    logger.error(`script.yml not found. Run 'pnpm apvg video scenario generate' first.`);
    process.exit(1);
  }

  const rawScript = await readYaml(scriptPath);
  const script = ScriptSchema.parse(rawScript);

  let profiles = resolveVoiceProfiles(config.voice, config.voicevox);
  if (options.speaker) {
    const speakerId = parseInt(options.speaker, 10);
    profiles = profiles.map((profile) => overrideVoicevoxSpeaker(profile, speakerId));
  }

  const voiceDir = options.voiceDir || join(workDir, 'voice');
  const srtPath = options.subtitles || join(workDir, 'subtitles.srt');
  await Promise.all([voiceDir, dirname(scriptPath), dirname(srtPath)].map(ensureDir));

  profiles.forEach((profile, index) =>
    logger.info(`Voice ${index + 1}:       ${describeVoiceProfile(profile)}`)
  );
  logger.info(`Output dir:     ${voiceDir}`);

  if (!options.dryRun) {
    const client = new VoicevoxClient(profiles);
    const healthy = await client.checkHealth();
    if (!healthy) {
      logger.error(`One or more voice engines are not reachable.`);
      logger.error(
        'Start it with: docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-latest'
      );
      process.exit(1);
    }
  }

  const client = new VoicevoxClient(profiles);
  await client.synthesizeAll(script, {
    outputDir: voiceDir,
    dryRun: options.dryRun || false,
    sceneId: options.scene,
  });

  if (!options.dryRun) {
    const timedScript = await recomputeScriptTimingFromAudio(
      script,
      voiceDir,
      config.video.sceneGapSeconds
    );
    await writeYaml(scriptPath, timedScript);
    await writeFile(
      srtPath,
      new SubtitleGenerator().generateSrt(timedScript, {
        singleLine: config.video.singleLineSubtitles,
      }),
      'utf-8'
    );
    logger.success(`Updated actual audio timing: ${scriptPath}, ${srtPath}`);
  }

  logger.info('');
  logger.success('Voice synthesis complete.');
  if (!options.dryRun) {
    logger.info('Next: pnpm apvg video record');
  }
}
