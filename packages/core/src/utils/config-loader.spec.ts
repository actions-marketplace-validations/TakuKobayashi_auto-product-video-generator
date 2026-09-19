import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from './config-loader.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
  delete process.env.APVG_TEST_NAME;
  delete process.env.APVG_TEST_AITALK_USER;
  delete process.env.APVG_TEST_AITALK_PASSWORD;
});

describe('config environment placeholders', () => {
  it('expands arbitrary dotenv keys and restores placeholders when saving', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'apvg-config-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'apvg.config.yml');
    await Promise.all([
      writeFile(
        join(directory, '.env'),
        'APVG_TEST_NAME=dotenv-project\nAPVG_TEST_AITALK_USER=user-value\nAPVG_TEST_AITALK_PASSWORD=secret-value\n'
      ),
      writeFile(
        configPath,
        `project:\n  name: \${APVG_TEST_NAME}\nsource:\n  localPath: .\ntarget:\n  url: http://localhost:3000\nvoice:\n  profiles:\n    - type: aitalk\n      speakerName: nozomi\n      username: \${APVG_TEST_AITALK_USER}\n      password: \${APVG_TEST_AITALK_PASSWORD}\n      options:\n        style:\n          j: 0.5\n          s: 0.2\n          a: 0.3\n`
      ),
    ]);

    const config = await loadConfig(configPath);
    expect(config.project.name).toBe('dotenv-project');
    expect(config.voice?.profiles[0]).toMatchObject({
      username: 'user-value',
      password: 'secret-value',
      options: { style: { j: 0.5, s: 0.2, a: 0.3 } },
    });

    await saveConfig(configPath, config);
    const saved = await readFile(configPath, 'utf-8');
    expect(saved).toContain('${APVG_TEST_AITALK_USER}');
    expect(saved).toContain('${APVG_TEST_AITALK_PASSWORD}');
    expect(saved).not.toContain('secret-value');
  });
});
