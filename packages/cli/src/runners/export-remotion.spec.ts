import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ApvgConfigSchema } from '@auto-product-video-generator/core';
import { exportRemotionProject } from './export-remotion.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('exportRemotionProject', () => {
  it('creates a standalone project and copies timeline assets without a lockfile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-remotion-'));
    temporaryDirectories.push(root);
    const workDir = join(root, '.apvg');
    const outputDir = join(root, 'remotion-project');
    await Promise.all([
      writeFixture(join(workDir, 'recordings', 'scene.mp4'), 'video'),
      writeFixture(join(workDir, 'voice', 'scene.wav'), 'audio'),
    ]);
    const timelinePath = join(workDir, 'timeline.json');
    await writeFixture(
      timelinePath,
      JSON.stringify({
        meta: { totalDuration: 2, resolution: '1920x1080', fps: 30 },
        tracks: [
          {
            type: 'video',
            id: 'video-1',
            sceneId: 'one',
            src: 'recordings/scene.mp4',
            startTime: 0,
            endTime: 2,
          },
          {
            type: 'audio',
            id: 'audio-1',
            sceneId: 'one',
            src: 'voice/scene.wav',
            startTime: 0,
            endTime: 2,
          },
          {
            type: 'subtitle',
            id: 'sub-1',
            sceneId: 'one',
            text: 'こんにちは',
            startTime: 0,
            endTime: 2,
          },
        ],
      })
    );
    const config = ApvgConfigSchema.parse({
      project: { name: 'Example App' },
      source: { localPath: root },
      target: { url: 'http://localhost:3000' },
      video: { subtitles: true },
      output: { workDir, dir: join(root, 'output') },
    });

    await exportRemotionProject(config, timelinePath, outputDir);

    const [packageJsonText, exportedTimelineText] = await Promise.all([
      readFile(join(outputDir, 'package.json'), 'utf8'),
      readFile(join(outputDir, 'src', 'data', 'timeline.json'), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageJsonText);
    const exportedTimeline = JSON.parse(exportedTimelineText);
    expect(packageJson.scripts.dev).toBe('remotion studio src/index.ts');
    expect(packageJson.name).toBe('example-app-remotion');
    expect(exportedTimeline.tracks[0].src).toBe('assets/video/video-1.mp4');
    expect(exportedTimeline.tracks[1].src).toBe('assets/audio/audio-1.wav');
    expect(existsSync(join(outputDir, 'public', 'assets', 'video', 'video-1.mp4'))).toBe(true);
    expect(existsSync(join(outputDir, 'package-lock.json'))).toBe(false);
  });

  it('does not overwrite a non-empty directory unless force is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-remotion-'));
    temporaryDirectories.push(root);
    const outputDir = join(root, 'project');
    await writeFixture(join(outputDir, 'keep.txt'), 'keep');
    const config = ApvgConfigSchema.parse({
      project: { name: 'Example' },
      source: { localPath: root },
      target: { url: 'http://localhost:3000' },
    });
    const timelinePath = join(root, 'timeline.json');
    await writeFixture(
      timelinePath,
      JSON.stringify({
        meta: { totalDuration: 1, resolution: '1920x1080', fps: 30 },
        tracks: [],
      })
    );
    await expect(exportRemotionProject(config, timelinePath, outputDir)).rejects.toThrow(
      'Output directory is not empty'
    );
  });
});

async function writeFixture(path: string, content: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
