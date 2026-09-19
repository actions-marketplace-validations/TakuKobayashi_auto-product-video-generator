import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  Script,
  NarrationEmotion,
  VoiceProfile,
  VoicevoxConfig,
  logger,
  getAudioDurationSeconds,
} from '@auto-product-video-generator/core';

export interface SynthesizeOptions {
  outputDir: string;
  dryRun: boolean;
  sceneId?: string;
}

export function resolveCredential(value: string | undefined, envName: string): string {
  const source = value ?? `\${${envName}}`;
  return source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_placeholder, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`Environment variable ${name} is not set.`);
    return resolved;
  });
}

export function buildAitalkRequestBody(
  text: string,
  profile: Extract<VoiceProfile, { type: 'aitalk' }>,
  sceneEmotion?: NarrationEmotion
): URLSearchParams {
  const options = {
    ...profile.options,
    style: profile.options.style ?? sceneEmotion,
  };
  const body = new URLSearchParams({
    username: resolveCredential(profile.username, profile.usernameEnv),
    password: resolveCredential(profile.password, profile.passwordEnv),
    speaker_name: profile.speakerName,
    input_type: 'text',
    text,
    ext: options.ext,
  });
  for (const [key, value] of Object.entries(options)) {
    if (key === 'ext' || value === undefined) continue;
    switch (key) {
      case 'use_udic':
        body.set(key, value ? '1' : '0');
        break;
      case 'style':
        body.set(key, JSON.stringify(value));
        break;
      default:
        body.set(key, String(value));
    }
  }
  return body;
}

function healthUrl(profile: VoiceProfile): string {
  switch (profile.type) {
    case 'voicevox':
      return `${profile.url}/version`;
    case 'aitalk':
      return profile.url;
  }
}

function acceptsHealthResponse(profile: VoiceProfile, response: Response): boolean {
  switch (profile.type) {
    case 'voicevox':
      return response.ok;
    case 'aitalk':
      // AITalk has no unauthenticated health endpoint. Even an authentication
      // error confirms that the configured Web API endpoint is reachable.
      return true;
  }
}

export function resolveVoiceProfiles(
  voice: { profiles: VoiceProfile[] } | undefined,
  legacyVoicevox: VoicevoxConfig
): VoiceProfile[] {
  return (
    voice?.profiles ?? [
      {
        type: 'voicevox',
        url: legacyVoicevox.host,
        speakerId: legacyVoicevox.speakerId,
      },
    ]
  );
}

export class VoicevoxClient {
  constructor(private profiles: VoiceProfile[]) {
    if (profiles.length === 0) throw new Error('At least one voice profile is required.');
  }

  async synthesizeAll(script: Script, options: SynthesizeOptions): Promise<void> {
    const scenes = options.sceneId
      ? script.scenes.filter((s) => s.id === options.sceneId)
      : script.scenes;

    if (scenes.length === 0) {
      throw new Error(`Scene '${options.sceneId}' not found in script.`);
    }

    for (const scene of scenes) {
      const sceneIndex = script.scenes.findIndex((item) => item.id === scene.id);
      const profile = this.profiles[sceneIndex % this.profiles.length];
      const outputPath = `${options.outputDir}/scene-${scene.id}.wav`;
      await this.synthesizeWithProfile(
        scene.narration,
        profile,
        outputPath,
        options.dryRun,
        scene.emotion
      );
    }
  }

  async synthesizeWithProfile(
    text: string,
    profile: VoiceProfile,
    outputPath: string,
    dryRun: boolean,
    sceneEmotion?: NarrationEmotion
  ): Promise<void> {
    switch (profile.type) {
      case 'voicevox':
        return this.synthesize(text, profile.speakerId, outputPath, dryRun, profile.url);
      case 'aitalk':
        return this.synthesizeAitalk(text, profile, outputPath, dryRun, sceneEmotion);
    }
  }

  private async synthesizeAitalk(
    text: string,
    profile: Extract<VoiceProfile, { type: 'aitalk' }>,
    outputPath: string,
    dryRun: boolean,
    sceneEmotion?: NarrationEmotion
  ): Promise<void> {
    logger.step(
      'voice',
      `Synthesizing with AITalk: "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"`
    );
    logger.dim(`  -> ${outputPath}`);
    if (dryRun) {
      logger.dryRun(`Would call AITalk at ${profile.url} with speaker=${profile.speakerName}`);
      return;
    }

    const body = buildAitalkRequestBody(text, profile, sceneEmotion);

    const response = await fetch(profile.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    });
    if (!response.ok) {
      throw new Error(`AITalk synthesis failed (${response.status}): ${await response.text()}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('audio/')) {
      throw new Error(`AITalk returned an unexpected content type: ${contentType}`);
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    logger.success(`Voice saved: ${outputPath}`);
  }

  async synthesize(
    text: string,
    speakerId: number,
    outputPath: string,
    dryRun: boolean,
    url = this.profiles[0].url
  ): Promise<void> {
    logger.step('voice', `Synthesizing: "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"`);
    logger.dim(`  → ${outputPath}`);

    if (dryRun) {
      logger.dryRun(`Would call VOICEVOX at ${url} with speaker=${speakerId}`);
      return;
    }

    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Step 1: audio_query
    const queryUrl = `${url}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`;
    const queryRes = await fetch(queryUrl, { method: 'POST' });

    if (!queryRes.ok) {
      const body = await queryRes.text();
      throw new Error(
        `VOICEVOX audio_query failed (${queryRes.status}): ${body}\n` +
          `Make sure VOICEVOX Engine is running at ${url}`
      );
    }

    const query = await queryRes.json();

    // Step 2: synthesis
    const synthUrl = `${url}/synthesis?speaker=${speakerId}`;
    const synthRes = await fetch(synthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    });

    if (!synthRes.ok) {
      const body = await synthRes.text();
      throw new Error(`VOICEVOX synthesis failed (${synthRes.status}): ${body}`);
    }

    const buffer = await synthRes.arrayBuffer();
    await writeFile(outputPath, Buffer.from(buffer));
    logger.success(`Voice saved: ${outputPath}`);
  }

  async getWavDuration(wavPath: string): Promise<number> {
    return getAudioDurationSeconds(wavPath);
  }

  async checkHealth(): Promise<boolean> {
    const results = await Promise.all(
      this.profiles.map(async (profile) => {
        try {
          const res = await fetch(healthUrl(profile), {
            signal: AbortSignal.timeout(3000),
          });
          return acceptsHealthResponse(profile, res);
        } catch {
          return false;
        }
      })
    );
    return results.every(Boolean);
  }
}
