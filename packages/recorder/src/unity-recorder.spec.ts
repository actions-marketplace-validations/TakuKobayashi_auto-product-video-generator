import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ApvgConfigSchema } from '@auto-product-video-generator/core';
import { createPlatformRecorder } from './factory.js';
import {
  ensureUnityRecorderPackage,
  resolveUnityEditorPath,
  UnityRecorder,
  unityEditorCandidates,
  unityRecorderPackageVersion,
} from './unity-recorder.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('UnityRecorder', () => {
  it('is selected for Unity when recorder mode is configured', () => {
    const config = ApvgConfigSchema.parse({
      project: { name: 'Unity game' },
      source: { localPath: '.' },
      target: {
        url: 'http://localhost:3000',
        type: 'unity',
        unity: {},
      },
    });
    expect(createPlatformRecorder('unity', config, { workDir: '.apvg' })).toBeInstanceOf(
      UnityRecorder
    );
  });

  it('accepts an explicitly configured Unity executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-unity-'));
    temporaryDirectories.push(root);
    const executable = join(root, process.platform === 'win32' ? 'Unity.exe' : 'Unity');
    await writeFile(executable, '');
    await expect(resolveUnityEditorPath(root, executable)).resolves.toBe(executable);
  });

  it('builds a platform-specific Unity Hub editor candidate', () => {
    expect(unityEditorCandidates('6000.0.1f1')[0]).toContain('6000.0.1f1');
  });

  it('adds a compatible Recorder package when the project does not provide one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-unity-recorder-package-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'Packages'), { recursive: true });
    await writeFile(join(root, 'Packages', 'manifest.json'), '{"dependencies":{}}');

    await ensureUnityRecorderPackage(root, '6000.0.34f1');

    const manifest = JSON.parse(await readFile(join(root, 'Packages', 'manifest.json'), 'utf8'));
    expect(manifest.dependencies['com.unity.recorder']).toBe('5.1.3');
  });

  it('preserves the Recorder version already selected by the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-unity-existing-recorder-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'Packages'), { recursive: true });
    await writeFile(
      join(root, 'Packages', 'manifest.json'),
      '{"dependencies":{"com.unity.recorder":"5.1.4"}}'
    );

    await ensureUnityRecorderPackage(root, '6000.0.34f1');

    const manifest = JSON.parse(await readFile(join(root, 'Packages', 'manifest.json'), 'utf8'));
    expect(manifest.dependencies['com.unity.recorder']).toBe('5.1.4');
  });

  it('selects the released Recorder line for each Unity generation', () => {
    expect(unityRecorderPackageVersion('2021.3.4f1')).toBe('3.0.3');
    expect(unityRecorderPackageVersion('2022.3.62f1')).toBe('4.0.1');
    expect(unityRecorderPackageVersion('2023.2.20f1')).toBe('5.0.0');
    expect(unityRecorderPackageVersion('6000.0.34f1')).toBe('5.1.3');
  });
});
