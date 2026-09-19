import { join } from 'node:path';
import {
  Scenario,
  Script,
  ScriptScene,
  getAudioDurationSeconds,
  logger,
} from '@auto-product-video-generator/core';

/**
 * Builds script.yml deterministically from an already-generated
 * scenario.yml, instead of asking the LLM to produce both in one call.
 *
 * Previously the LLM had to emit `scenario.scenes[].narration` AND
 * `script.scenes[].narration` (the same text, twice) plus made-up
 * startTime/endTime — a lot of redundant, easy-to-get-wrong JSON surface
 * for smaller/local models especially. Since the narration text already
 * lives on each scene in scenario.yml, and timing is just "how long does
 * this text take to say out loud", there's no reason for the LLM to
 * regenerate any of this — it's a pure calculation.
 */
export function buildScriptFromScenario(scenario: Scenario, sceneGapSeconds = 1): Script {
  let cursor = 0;

  const scenes: ScriptScene[] = scenario.scenes.map((scene) => {
    const duration = estimateNarrationSeconds(scene.narration, scenario.meta.language);
    const startTime = round1(cursor);
    const endTime = round1(cursor + duration);
    cursor = endTime + sceneGapSeconds;

    return {
      id: scene.id,
      narration: scene.narration,
      emotion: scene.emotion,
      startTime,
      endTime,
      voiceFile: `voice/scene-${scene.id}.wav`,
    };
  });

  logger.step(
    'script',
    `Derived timing for ${scenes.length} scene(s) from narration length (no LLM call).`
  );
  return { scenes };
}

/** Rebuild script timing from the actual synthesized WAV files. */
export async function recomputeScriptTimingFromAudio(
  script: Script,
  audioDir: string,
  sceneGapSeconds = 1
): Promise<Script> {
  let cursor = 0;
  const scenes: ScriptScene[] = [];

  for (const scene of script.scenes) {
    const duration = await getAudioDurationSeconds(join(audioDir, `scene-${scene.id}.wav`));
    const startTime = round3(cursor);
    const endTime = round3(cursor + duration);
    scenes.push({ ...scene, startTime, endTime });
    cursor = endTime + sceneGapSeconds;
  }

  logger.step('script', `Recomputed timing from ${scenes.length} synthesized audio file(s).`);
  return { scenes };
}

/**
 * Rough narration-length estimate. Japanese is character-paced (~6-7
 * chars/sec for narration-style speech); other languages are word-paced
 * (~2.5 words/sec). Good enough for scene timing — not meant to be exact,
 * and the whole point is it's cheap/deterministic rather than another LLM
 * round-trip. Edit script.yml by hand afterward for anything that needs
 * to be precise.
 */
function estimateNarrationSeconds(text: string, language: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 1.5;

  const seconds = language.startsWith('ja')
    ? trimmed.length / 6
    : trimmed.split(/\s+/).filter(Boolean).length / 2.5;

  return Math.max(1.5, seconds);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
