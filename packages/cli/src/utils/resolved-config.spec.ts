import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApvgConfigSchema } from '@auto-product-video-generator/core';
import { applyResolvedConfig, saveResolvedConfig } from './resolved-config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('resolved analysis config', () => {
  it('persists inferred values separately and preserves explicit user settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'apvg-resolved-'));
    temporaryDirectories.push(directory);
    const config = ApvgConfigSchema.parse({
      project: { name: 'test' },
      source: { localPath: '.', startCommand: 'pnpm dev' },
      target: { url: 'http://localhost:4321', autoDetectUrl: false, type: 'web' },
      output: { workDir: directory },
    });
    await saveResolvedConfig(config, 'web');

    const userConfig = ApvgConfigSchema.parse({
      project: { name: 'test' },
      source: { localPath: '.', startCommand: 'npm run custom' },
      target: { url: 'http://localhost:9999', autoDetectUrl: false, type: 'cli' },
      output: { workDir: directory },
    });
    await applyResolvedConfig(userConfig);

    expect(userConfig.source.startCommand).toBe('npm run custom');
    expect(userConfig.target.url).toBe('http://localhost:9999');
    expect(userConfig.target.type).toBe('cli');
  });

  it('applies inferred URL and start command when configured for auto detection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'apvg-resolved-'));
    temporaryDirectories.push(directory);
    const analyzed = ApvgConfigSchema.parse({
      project: { name: 'test' },
      source: { localPath: '.', startCommand: 'pnpm dev' },
      target: { url: 'http://localhost:4321', autoDetectUrl: false },
      output: { workDir: directory },
    });
    await saveResolvedConfig(analyzed, 'web');

    const config = ApvgConfigSchema.parse({
      project: { name: 'test' },
      source: { localPath: '.' },
      target: { url: 'http://localhost:3000', autoDetectUrl: true },
      output: { workDir: directory },
    });
    await applyResolvedConfig(config);

    expect(config.source.startCommand).toBe('pnpm dev');
    expect(config.target.url).toBe('http://localhost:4321');
    expect(config.target.autoDetectUrl).toBe(false);
  });
});
