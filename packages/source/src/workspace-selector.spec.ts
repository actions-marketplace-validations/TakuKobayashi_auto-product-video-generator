import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLATFORM_PRIORITY } from '@auto-product-video-generator/core';
import { selectProjectRoot } from './workspace-selector.js';

async function packageJson(root: string, path: string, value: object): Promise<void> {
  const directory = join(root, path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(value));
}

describe('selectProjectRoot', () => {
  it('keeps a Unity repository root instead of selecting a nested Node.js server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-unity-monorepo-'));
    await Promise.all([
      mkdir(join(root, 'Assets'), { recursive: true }),
      mkdir(join(root, 'Packages'), { recursive: true }),
      mkdir(join(root, 'ProjectSettings'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, 'ProjectSettings', 'ProjectVersion.txt'),
        'm_EditorVersion: 6000.3.6f1\n'
      ),
      packageJson(root, 'server', {
        scripts: { dev: 'wrangler dev' },
        dependencies: { commander: '^12.0.0' },
      }),
    ]);

    await expect(
      selectProjectRoot(root, {
        localPath: root,
        installDeps: false,
        platformPriority: DEFAULT_PLATFORM_PRIORITY,
      })
    ).resolves.toBe(root);
  });

  it('keeps a native Android repository root instead of selecting a nested web app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-android-with-landing-page-'));
    await Promise.all([
      mkdir(join(root, 'app', 'src', 'main'), { recursive: true }),
      writeFile(join(root, 'gradlew'), ''),
      writeFile(join(root, 'settings.gradle'), "include ':app'\n"),
      packageJson(root, 'landingpage', {
        scripts: { dev: 'next dev' },
        dependencies: { next: '^15.0.0', react: '^19.0.0' },
      }),
    ]);
    await writeFile(join(root, 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest />');

    await expect(
      selectProjectRoot(root, {
        localPath: root,
        installDeps: false,
        platformPriority: DEFAULT_PLATFORM_PRIORITY,
      })
    ).resolves.toBe(root);
  });

  it('selects the runnable web application in a mixed monorepo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-monorepo-'));
    await Promise.all([
      packageJson(root, '.', { scripts: { dev: 'pnpm --filter @sample/web dev' } }),
      packageJson(root, 'apps/cli', { scripts: { dev: 'tsx src.ts' } }),
      packageJson(root, 'apps/web-ui', { dependencies: { react: '^19.0.0' } }),
      packageJson(root, 'apps/web', {
        name: '@sample/web',
        scripts: { dev: 'next dev' },
        dependencies: { next: '^15.0.0' },
      }),
      packageJson(root, 'packages/shared', { name: '@sample/shared' }),
    ]);

    await expect(
      selectProjectRoot(root, {
        localPath: root,
        installDeps: false,
        platformPriority: DEFAULT_PLATFORM_PRIORITY,
      })
    ).resolves.toBe(join(root, 'apps/web'));
  });

  it('honors an explicit projectPath override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-monorepo-'));
    await Promise.all([
      packageJson(root, 'apps/web', {
        scripts: { dev: 'vite' },
        dependencies: { vite: '^7.0.0' },
      }),
      packageJson(root, 'apps/admin', {
        scripts: { dev: 'vite' },
        dependencies: { vite: '^7.0.0' },
      }),
    ]);

    await expect(
      selectProjectRoot(root, {
        localPath: root,
        installDeps: false,
        projectPath: 'apps/admin',
        platformPriority: DEFAULT_PLATFORM_PRIORITY,
      })
    ).resolves.toBe(join(root, 'apps/admin'));
  });

  it('uses configured platform priority before candidate score', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-monorepo-'));
    await Promise.all([
      packageJson(root, 'apps/web', {
        scripts: { dev: 'vite' },
        dependencies: { vite: '^7.0.0' },
      }),
      packageJson(root, 'apps/mobile', {
        scripts: { dev: 'react-native start' },
        dependencies: { 'react-native': '^0.80.0' },
      }),
    ]);

    await expect(
      selectProjectRoot(root, {
        localPath: root,
        installDeps: false,
        // No iOS candidate exists, so selection proceeds to React Native.
        platformPriority: ['ios', 'react-native', 'web', 'other'],
      })
    ).resolves.toBe(join(root, 'apps/mobile'));
  });

  it('recognizes a package.json bin entry as a CLI application', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apvg-monorepo-'));
    await Promise.all([
      packageJson(root, 'packages/shared', { name: '@sample/shared' }),
      packageJson(root, 'apps/tool', {
        name: '@sample/tool',
        bin: { sample: './dist/index.js' },
        dependencies: { commander: '^12.0.0' },
      }),
    ]);

    await expect(
      selectProjectRoot(root, {
        localPath: root,
        installDeps: false,
        platformPriority: ['cli', 'other'],
      })
    ).resolves.toBe(join(root, 'apps/tool'));
  });
});
