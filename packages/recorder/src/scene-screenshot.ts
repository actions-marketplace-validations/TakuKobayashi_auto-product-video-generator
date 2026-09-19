import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger, resolveFfmpegPath } from '@auto-product-video-generator/core';

export async function captureSceneScreenshot(
  videoPath: string,
  screenshotPath: string
): Promise<void> {
  if (!existsSync(videoPath)) {
    throw new Error(`Cannot create scene screenshot because the recording is missing: ${videoPath}`);
  }
  await mkdir(dirname(screenshotPath), { recursive: true });
  logger.step('screenshot', `${videoPath} → ${screenshotPath}`);
  await runFfmpeg(buildSceneScreenshotArguments(videoPath, screenshotPath));
  logger.success(`Saved: ${screenshotPath}`);
}

export function buildSceneScreenshotArguments(
  videoPath: string,
  screenshotPath: string
): string[] {
  return [
    '-y',
    '-sseof',
    '-0.1',
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-update',
    '1',
    screenshotPath,
  ];
}

function runFfmpeg(args: string[]): Promise<void> {
  const ffmpeg = resolveFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(new Error(`Could not start FFmpeg: ${error.message}`)));
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`FFmpeg screenshot extraction failed (${code}): ${stderr.trim()}`))
    );
  });
}
