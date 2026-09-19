import { describe, expect, it } from 'vitest';
import { buildAitalkRequestBody, resolveCredential, resolveVoiceProfiles } from './client.js';

describe('buildAitalkRequestBody', () => {
  it('maps every configured ttsget option to the API parameter', () => {
    const body = buildAitalkRequestBody('テスト', {
      type: 'aitalk',
      url: 'https://webapi.aitalk.jp/webapi/v5/ttsget.php',
      speakerName: 'nozomi',
      username: 'user',
      password: 'pass',
      usernameEnv: 'UNUSED_USER',
      passwordEnv: 'UNUSED_PASSWORD',
      options: {
        use_udic: true,
        ext: 'wav',
        fs: 48000,
        bit: 16,
        channels: 1,
        mvolume: 1.1,
        volume: 1.2,
        speed: 1.3,
        pitch: 1.4,
        range: 1.5,
        style: { j: 0.5, s: 0.2, a: 0.3 },
        spause: 150,
        lpause: 370,
        epause: 800,
        tpause: 0,
      },
    });

    expect(Object.fromEntries(body)).toMatchObject({
      use_udic: '1',
      ext: 'wav',
      fs: '48000',
      bit: '16',
      channels: '1',
      mvolume: '1.1',
      volume: '1.2',
      speed: '1.3',
      pitch: '1.4',
      range: '1.5',
      style: JSON.stringify({ j: 0.5, s: 0.2, a: 0.3 }),
      spause: '150',
      lpause: '370',
      epause: '800',
      tpause: '0',
    });
  });

  it('uses scene emotion only when the profile has no fixed style', () => {
    const baseProfile = {
      type: 'aitalk' as const,
      url: 'https://webapi.aitalk.jp/webapi/v5/ttsget.php',
      speakerName: 'nozomi',
      username: 'user',
      password: 'pass',
      usernameEnv: 'UNUSED_USER',
      passwordEnv: 'UNUSED_PASSWORD',
      options: { ext: 'wav' as const },
    };
    expect(buildAitalkRequestBody('text', baseProfile, { j: 0.7, s: 0, a: 0 }).get('style')).toBe(
      JSON.stringify({ j: 0.7, s: 0, a: 0 })
    );

    const fixed = {
      ...baseProfile,
      options: { ext: 'wav' as const, style: { j: 0, s: 0.4, a: 0 } },
    };
    expect(buildAitalkRequestBody('text', fixed, { j: 0.7, s: 0, a: 0 }).get('style')).toBe(
      JSON.stringify({ j: 0, s: 0.4, a: 0 })
    );
  });
});

describe('resolveCredential', () => {
  it('expands dotenv-style placeholders without changing literal credentials', () => {
    process.env.AITALK_TEST_USER = 'api-user';
    expect(resolveCredential('${AITALK_TEST_USER}', 'UNUSED')).toBe('api-user');
    expect(resolveCredential('literal-secret', 'UNUSED')).toBe('literal-secret');
    delete process.env.AITALK_TEST_USER;
  });

  it('uses the legacy environment-variable name when a value is omitted', () => {
    process.env.AITALK_TEST_PASSWORD = 'api-password';
    expect(resolveCredential(undefined, 'AITALK_TEST_PASSWORD')).toBe('api-password');
    delete process.env.AITALK_TEST_PASSWORD;
  });
});

describe('resolveVoiceProfiles', () => {
  it('uses configured profiles in their declared order', () => {
    const profiles = [
      { type: 'voicevox' as const, url: 'http://localhost:50021', speakerId: 1 },
      {
        type: 'aitalk' as const,
        url: 'https://webapi.aitalk.jp/webapi/v5/ttsget.php',
        speakerName: 'nozomi',
        usernameEnv: 'AITALK_USERNAME',
        passwordEnv: 'AITALK_PASSWORD',
        options: { ext: 'wav' as const },
      },
    ];
    expect(resolveVoiceProfiles({ profiles }, { host: 'http://legacy', speakerId: 3 })).toBe(
      profiles
    );
  });

  it('converts the legacy voicevox setting into one profile', () => {
    expect(
      resolveVoiceProfiles(undefined, { host: 'http://localhost:50021', speakerId: 3 })
    ).toEqual([{ type: 'voicevox', url: 'http://localhost:50021', speakerId: 3 }]);
  });
});
