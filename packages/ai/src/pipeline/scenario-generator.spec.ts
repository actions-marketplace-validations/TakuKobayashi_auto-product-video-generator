import { describe, expect, it } from 'vitest';
import type { ProjectSummary, VideoConfig } from '@auto-product-video-generator/core';
import type { LlmProvider } from '../llm/provider.js';
import { ScenarioGenerator } from './scenario-generator.js';

describe('ScenarioGenerator route grounding', () => {
  it('replaces a dynamic route template with the concrete base URL', async () => {
    let receivedPrompt = '';
    const llm: LlmProvider = {
      generate: async () => '',
      generateJson: async <T>(prompt) => {
        receivedPrompt = prompt;
        return {
          meta: { title: 'Demo', description: 'Demo', type: 'demo', duration: 30, language: 'ja' },
          scenes: [
            {
              id: 'read-blogs',
              title: 'ブログ',
              narration: '記事を読めます。',
              actions: [{ type: 'goto', url: 'http://127.0.0.1:3000/en/blog/[slug]' }],
            },
          ],
        } as T;
      },
    };
    const summary: ProjectSummary = {
      name: 'Example',
      description: 'Example',
      platform: 'web',
      setupSteps: [],
      features: [
        {
          id: 'blog',
          title: 'ブログ',
          description: '記事を読む',
          route: '/en/blog/[slug]',
          demoable: true,
          priority: 'high',
        },
      ],
      targetAudience: '一般利用者',
      keyValueProps: [],
      suggestedVideoTypes: ['demo'],
      analyzedAt: new Date().toISOString(),
    };
    const video: VideoConfig = {
      type: 'demo',
      duration: 30,
      resolution: '1280x720',
      fps: 30,
      language: 'ja',
      scenarioPrompt: '語尾に「なのだ」を付ける',
      singleLineSubtitles: true,
      pageReadyWaitSeconds: 2,
      sceneGapSeconds: 1,
    };

    const { scenario } = await new ScenarioGenerator(llm).generate(
      summary,
      video,
      'http://127.0.0.1:3000'
    );

    expect(scenario.scenes[0].actions[0]).toEqual({
      type: 'goto',
      url: 'http://127.0.0.1:3000/',
    });
    expect(JSON.stringify(scenario)).not.toContain('[slug]');
    expect(receivedPrompt).toContain('語尾に「なのだ」を付ける');
    expect(receivedPrompt).toContain('<creative-direction>');
  });
});

describe('ScenarioGenerator CLI grounding', () => {
  it('keeps only documented CLI commands', async () => {
    const llm: LlmProvider = {
      generate: async () => '',
      generateJson: async <T>() =>
        ({
          meta: {
            title: 'CLI Demo',
            description: 'Demo',
            type: 'demo',
            duration: 20,
            language: 'ja',
          },
          scenes: [
            {
              id: 'help',
              title: 'Help',
              narration: '使い方を確認できます。',
              actions: [{ type: 'run_command', command: 'invented --dangerous' }],
            },
          ],
        }) as T,
    };
    const summary: ProjectSummary = {
      name: 'Example CLI',
      description: 'Example',
      platform: 'cli',
      setupSteps: [],
      features: [
        {
          id: 'help',
          title: 'Help',
          description: '使い方を見る',
          command: 'example --help',
          demoable: true,
          priority: 'high',
        },
      ],
      targetAudience: '利用者',
      keyValueProps: [],
      suggestedVideoTypes: ['demo'],
      analyzedAt: new Date().toISOString(),
    };
    const video: VideoConfig = {
      type: 'demo',
      duration: 20,
      resolution: '1280x720',
      fps: 30,
      language: 'ja',
      singleLineSubtitles: true,
      pageReadyWaitSeconds: 2,
      sceneGapSeconds: 1,
    };

    const { scenario } = await new ScenarioGenerator(llm).generate(
      summary,
      video,
      'http://localhost:3000'
    );
    expect(scenario.meta.platform).toBe('cli');
    expect(scenario.scenes[0].actions).toEqual([
      { type: 'run_command', command: 'example --help' },
    ]);
  });
});

describe('ScenarioGenerator Unity grounding', () => {
  it('asks for scene-ordered narration and retains only wait actions', async () => {
    let receivedPrompt = '';
    const llm = {
      generate: async () => '',
      generateJson: async <T>(prompt: string) => {
        receivedPrompt = prompt;
        return {
          meta: { title: 'Game', description: 'Demo', type: 'demo', duration: 10, language: 'ja' },
          scenes: [
            {
              id: 'title',
              title: 'Title',
              narration: 'ゲームを始めます。',
              actions: [{ type: 'launch_app' }],
            },
          ],
        } as T;
      },
    };
    const summary = {
      name: 'Game',
      description: 'A game',
      platform: 'unity',
      setupSteps: [],
      features: [
        {
          id: 'Assets/Scenes/Title.unity',
          title: 'Title',
          description: 'Start screen',
          demoable: true,
          priority: 'high',
        },
      ],
      targetAudience: 'players',
      keyValueProps: ['fun'],
      suggestedVideoTypes: ['demo'],
    } as const;
    const config = {
      type: 'demo',
      language: 'ja',
      resolution: '1920x1080',
      fps: 30,
      sceneGapSeconds: 0.5,
    } as any;

    const { scenario } = await new ScenarioGenerator(llm).generate(
      summary as any,
      config,
      'http://localhost'
    );

    expect(receivedPrompt).toContain(
      'Create exactly one scenario scene for each listed Unity Scene'
    );
    expect(receivedPrompt).toContain('Assets/Scenes/Title.unity');
    expect(scenario.scenes[0].actions).toEqual([{ type: 'wait', ms: 1000 }]);
  });
});
