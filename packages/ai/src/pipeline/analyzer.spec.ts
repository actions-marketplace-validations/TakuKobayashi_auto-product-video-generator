import { describe, expect, it } from 'vitest';
import type { ProjectSourceContext } from '@auto-product-video-generator/source';
import type { LlmProvider } from '../llm/provider.js';
import { ProjectAnalyzer } from './analyzer.js';
import { join } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('ProjectAnalyzer setup grounding', () => {
  it('runs the selected workspace application command from its own directory', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'apvg-analyzer-workspace-'));
    const rootDir = join(repositoryRoot, 'apps', 'web');
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(repositoryRoot, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*'] })
    );
    const llm: LlmProvider = {
      generate: async () => '',
      generateJson: async <T>() =>
        ({
          name: 'Example',
          description: 'Example app',
          platform: 'web',
          setupSteps: [
            { name: 'Install dependencies', command: 'pnpm install', background: false },
            {
              name: 'Start application',
              command: 'pnpm --dir apps/web dev',
              cwd: 'apps/web',
              background: true,
              readyUrl: 'http://localhost:9999',
            },
          ],
          features: [],
          targetAudience: 'Everyone',
          keyValueProps: [],
          suggestedVideoTypes: ['demo'],
        }) as T,
    };
    const context = {
      rootDir,
      repositoryRoot,
      projectPath: 'apps/web',
      packageManager: 'pnpm',
      packageJson: { name: '@example/web', scripts: { dev: 'next dev' } },
      readme: '',
      framework: 'nextjs',
      routes: [],
      fileTree: [],
      platformHints: [],
      assetFiles: [],
    } as ProjectSourceContext;

    const summary = await new ProjectAnalyzer(llm).analyze(context, 'http://localhost:3000');

    expect(summary.setupSteps).toEqual([
      expect.objectContaining({ command: 'pnpm install', cwd: '../..', background: false }),
      expect.objectContaining({
        command: 'pnpm run dev',
        cwd: undefined,
        background: true,
        readyUrl: 'http://localhost:3000',
      }),
    ]);
  });

  it('keeps dependency installation inside a standalone nested application', async () => {
    const llm: LlmProvider = {
      generate: async () => '',
      generateJson: async <T>() =>
        ({
          name: 'Landing page',
          description: 'Example app',
          platform: 'web',
          setupSteps: [
            { name: 'Install dependencies', command: 'npm install', background: false },
          ],
          features: [],
          targetAudience: 'Everyone',
          keyValueProps: [],
          suggestedVideoTypes: ['demo'],
        }) as T,
    };
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'apvg-analyzer-standalone-'));
    const rootDir = join(repositoryRoot, 'landingpage');
    await mkdir(rootDir, { recursive: true });
    const context = {
      rootDir,
      repositoryRoot,
      projectPath: 'landingpage',
      packageManager: 'npm',
      packageJson: { name: 'landingpage' },
      readme: '',
      framework: 'nextjs',
      routes: [],
      fileTree: [],
      platformHints: [],
      assetFiles: [],
    } as ProjectSourceContext;

    const summary = await new ProjectAnalyzer(llm).analyze(context);

    expect(summary.setupSteps).toEqual([
      expect.objectContaining({
        name: 'Install dependencies',
        command: 'npm install',
        background: false,
      }),
    ]);
    expect(summary.setupSteps[0].cwd).toBeUndefined();
  });

  it('removes web-server setup and grounds commands for a CLI workspace', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'apvg-analyzer-cli-workspace-'));
    const rootDir = join(repositoryRoot, 'packages', 'cli');
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(repositoryRoot, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['packages/*'] })
    );
    const llm: LlmProvider = {
      generate: async () => '',
      generateJson: async <T>() =>
        ({
          name: 'Example CLI',
          description: 'Example',
          platform: 'cli',
          setupSteps: [
            { name: 'Install dependencies', command: 'npm install', background: false },
            { name: 'Build CLI', command: 'npm run build', background: false },
            {
              name: 'Start application',
              command: 'npm run dev',
              background: true,
              readyUrl: 'http://localhost:3000',
            },
          ],
          features: [
            {
              id: 'help',
              title: 'Help',
              description: 'Show help',
              command: 'invented-command --help',
              demoable: true,
              priority: 'high',
            },
            {
              id: 'video-help',
              title: 'Video commands',
              description: 'Show video workflows',
              command: 'example video --help',
              demoable: true,
              priority: 'medium',
            },
            {
              id: 'generate',
              title: 'Generate',
              description: 'Generate a video',
              command: 'example video generate --help',
              demoable: true,
              priority: 'high',
            },
          ],
          targetAudience: 'Everyone',
          keyValueProps: [],
          suggestedVideoTypes: ['demo'],
        }) as T,
    };
    const context = {
      rootDir,
      repositoryRoot,
      projectPath: 'packages/cli',
      packageManager: 'pnpm',
      packageJson: {
        name: 'example-cli',
        scripts: { build: 'tsc' },
        bin: { example: 'bin/example.js' },
      },
      readme: '',
      framework: 'unknown',
      routes: [],
      fileTree: [],
      platformHints: ['package.json declares bin command(s)'],
      assetFiles: [],
      cliCommands: ['video', 'video generate', 'video scenario generate'],
      cliDryRunCommands: [],
    } as ProjectSourceContext;

    const summary = await new ProjectAnalyzer(llm).analyze(context);

    expect(summary.setupSteps).toEqual([
      expect.objectContaining({ command: 'pnpm install', cwd: '../..', background: false }),
      expect.objectContaining({ command: 'npm run build', background: false }),
    ]);
    expect(summary.setupSteps.every((step) => !step.background)).toBe(true);
    expect(summary.features[0].command).toBe('node packages/cli/bin/example.js --help');
    expect(summary.features[1].command).toBe('node packages/cli/bin/example.js video --help');
    expect(summary.features[2].command).toBe(
      'node packages/cli/bin/example.js video generate --help'
    );
  });

  it('does not invent install or build steps for an already executable CLI', async () => {
    const llm: LlmProvider = {
      generate: async () => '',
      generateJson: async <T>() =>
        ({
          name: 'Standalone CLI',
          description: 'Example',
          platform: 'cli',
          setupSteps: [],
          features: [],
          targetAudience: 'Everyone',
          keyValueProps: [],
          suggestedVideoTypes: ['demo'],
        }) as T,
    };
    const context = {
      rootDir: 'C:\\repo\\tools\\standalone',
      repositoryRoot: 'C:\\repo',
      projectPath: 'tools\\standalone',
      packageManager: 'npm',
      packageJson: { name: 'standalone', bin: { standalone: 'bin/standalone.js' } },
      readme: 'Run node bin/standalone.js --help.',
      framework: 'unknown',
      routes: [],
      fileTree: [],
      platformHints: ['package.json declares bin command(s)'],
      assetFiles: [],
    } as ProjectSourceContext;

    const summary = await new ProjectAnalyzer(llm).analyze(context);

    expect(summary.setupSteps).toEqual([]);
  });

  it('preserves non-Node setup commands for a CLI in a subdirectory', async () => {
    const llm: LlmProvider = {
      generate: async () => '',
      generateJson: async <T>() =>
        ({
          name: 'Python CLI',
          description: 'Example',
          platform: 'cli',
          setupSteps: [
            { name: 'Install Python package', command: 'pip install -e .', background: false },
          ],
          features: [],
          targetAudience: 'Everyone',
          keyValueProps: [],
          suggestedVideoTypes: ['demo'],
        }) as T,
    };
    const context = {
      rootDir: 'C:\\repo\\tools\\python-cli',
      repositoryRoot: 'C:\\repo',
      projectPath: 'tools\\python-cli',
      packageManager: 'npm',
      packageJson: null,
      readme: 'Install with pip install -e .',
      framework: 'unknown',
      routes: [],
      fileTree: ['pyproject.toml'],
      platformHints: [],
      assetFiles: [],
    } as ProjectSourceContext;

    const summary = await new ProjectAnalyzer(llm).analyze(context);

    expect(summary.setupSteps).toEqual([
      expect.objectContaining({ command: 'pip install -e .', background: false }),
    ]);
  });

  it('adds the real build script when the declared bin references a missing artifact', async () => {
    const llm: LlmProvider = {
      generate: async () => '',
      generateJson: async <T>() =>
        ({
          name: 'APVG',
          description: 'Example',
          platform: 'cli',
          setupSteps: [
            { name: 'Install dependencies', command: 'pnpm install', background: false },
          ],
          features: [],
          targetAudience: 'Everyone',
          keyValueProps: [],
          suggestedVideoTypes: ['demo'],
        }) as T,
    };
    const repositoryRoot = process.cwd();
    const context = {
      rootDir: join(repositoryRoot, 'packages', 'cli'),
      repositoryRoot,
      projectPath: join('packages', 'cli'),
      packageManager: 'pnpm',
      packageJson: {
        name: 'auto-product-video-generator',
        scripts: { build: 'node build.mjs' },
        bin: { apvg: 'bin/apvg.js' },
      },
      readme: '',
      framework: 'unknown',
      routes: [],
      fileTree: [],
      platformHints: ['package.json declares bin command(s)'],
      assetFiles: [],
    } as ProjectSourceContext;

    const summary = await new ProjectAnalyzer(llm).analyze(context);

    expect(summary.setupSteps).toEqual([
      expect.objectContaining({ command: 'pnpm install', cwd: join('..', '..') }),
      expect.objectContaining({ command: 'pnpm run build', background: false }),
    ]);
  });

  it('uses parsed Unity evidence instead of an incorrect LLM CLI classification', async () => {
    const llm: LlmProvider = {
      generate: async () => '',
      generateJson: async <T>() =>
        ({
          name: 'Mixed Unity project',
          description: 'Example game with server-side tooling',
          platform: 'cli',
          setupSteps: [
            { name: 'Install dependencies', command: 'npm install', background: false },
          ],
          features: [
            {
              id: 'help',
              title: 'CLI help',
              description: 'Show CLI help',
              command: 'example --help',
              demoable: true,
              priority: 'high',
            },
          ],
          targetAudience: 'Players',
          keyValueProps: [],
          suggestedVideoTypes: ['demo'],
        }) as T,
    };
    const context = {
      rootDir: '/repo',
      repositoryRoot: '/repo',
      projectPath: '.',
      packageManager: 'npm',
      packageJson: { name: 'server-tools', bin: { example: 'bin/example.js' } },
      readme: '',
      framework: 'unknown',
      routes: [],
      fileTree: ['Assets/Main.unity', 'ProjectSettings/ProjectVersion.txt', 'package.json'],
      platformHints: ['ProjectSettings/ProjectVersion.txt found (Unity)'],
      assetFiles: [],
      unity: {
        editorVersion: '6000.3.6f1',
        enabledScenes: [
          {
            path: 'Assets/Main.unity',
            objectNames: ['Main Camera', 'Player'],
            referencedAssets: ['Assets/Scripts/PlayerController.cs'],
            referencedScripts: ['Assets/Scripts/PlayerController.cs'],
          },
        ],
        projectScripts: [],
        packages: ['com.unity.recorder'],
      },
    } as ProjectSourceContext;

    const summary = await new ProjectAnalyzer(llm).analyze(context);

    expect(summary.platform).toBe('unity');
    expect(summary.setupSteps).toEqual([]);
    expect(summary.features).toEqual([
      expect.objectContaining({
        id: 'Assets/Main.unity',
        title: 'Main',
        demoable: true,
      }),
    ]);
    expect(summary.features[0].command).toBeUndefined();
  });
});
