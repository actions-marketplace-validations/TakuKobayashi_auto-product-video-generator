import { describe, expect, it } from 'vitest';
import { ApvgConfigSchema } from './config.js';

function configWithAuth(auth: Record<string, unknown>) {
  return {
    project: { name: 'Authenticated app' },
    source: { localPath: '.' },
    target: { url: 'https://example.com', type: 'web', auth },
  };
}

describe('web authentication config', () => {
  it('applies secure manual-login defaults', () => {
    const config = ApvgConfigSchema.parse(configWithAuth({}));

    expect(config.target.auth).toEqual({
      mode: 'manual',
      storageStatePath: './.apvg/auth/storage-state.json',
    });
  });

  it('accepts login and success URLs without storing credentials', () => {
    const config = ApvgConfigSchema.parse(
      configWithAuth({
        loginUrl: 'https://example.com/login',
        successUrl: 'https://example.com/dashboard',
        storageStatePath: './.apvg/auth/example.json',
      })
    );

    expect(config.target.auth?.loginUrl).toBe('https://example.com/login');
    expect(config.target.auth?.successUrl).toBe('https://example.com/dashboard');
  });
});

describe('video subtitle config', () => {
  it('enables sequential one-line subtitles by default', () => {
    const config = ApvgConfigSchema.parse(configWithAuth({}));

    expect(config.video.subtitles).toBe(true);
    expect(config.video.screenshots).toBe(true);
    expect(config.video.singleLineSubtitles).toBe(true);
  });

  it('allows one-line subtitle splitting to be disabled', () => {
    const config = ApvgConfigSchema.parse({
      ...configWithAuth({}),
      video: { singleLineSubtitles: false },
    });

    expect(config.video.singleLineSubtitles).toBe(false);
  });
});

describe('video duration config', () => {
  it('uses unrestricted length by default', () => {
    const config = ApvgConfigSchema.parse(configWithAuth({}));
    expect(config.video.duration).toBeUndefined();
  });

  it('allows subtitle rendering to be disabled', () => {
    const config = ApvgConfigSchema.parse({
      ...configWithAuth({}),
      video: { subtitles: false },
    });
    expect(config.video.subtitles).toBe(false);
  });

  it('accepts an explicit target duration', () => {
    const config = ApvgConfigSchema.parse({ ...configWithAuth({}), video: { duration: 90 } });
    expect(config.video.duration).toBe(90);
  });

  it('accepts additional scenario direction', () => {
    const config = ApvgConfigSchema.parse({
      ...configWithAuth({}),
      video: { scenarioPrompt: 'Use a friendly character voice.' },
    });
    expect(config.video.scenarioPrompt).toBe('Use a friendly character voice.');
  });
});

describe('source environment config', () => {
  it('accepts an environment file path', () => {
    const config = ApvgConfigSchema.parse({
      ...configWithAuth({}),
      source: { localPath: '.', environmentFile: '/secure/product.env' },
    });

    expect(config.source.environmentFile).toBe('/secure/product.env');
  });
});
