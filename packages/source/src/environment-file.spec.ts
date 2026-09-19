import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectProjectEnvironmentKind, placeProjectEnvironmentFile } from './environment-file.js';

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'apvg-env-'));
}

describe('project environment placement', () => {
  it('places dotenv input as Cloudflare .dev.vars', async () => {
    const root = await fixture();
    const input = join(root, 'secrets.env');
    await Promise.all([
      writeFile(join(root, 'wrangler.jsonc'), '{}'),
      writeFile(input, 'API_KEY="a b"\nPORT=8787\n'),
    ]);

    const result = await placeProjectEnvironmentFile(input, root);

    expect(result.kind).toBe('cloudflare');
    expect(result.path).toBe(join(root, '.dev.vars'));
    expect(await readFile(result.path, 'utf8')).toBe('API_KEY="a b"\nPORT=8787\n');
  });

  it('converts dotenv input to local.properties for a nested Android app', async () => {
    const root = await fixture();
    const android = join(root, 'android');
    const input = join(root, 'input.env');
    await mkdir(join(android, 'app', 'src', 'main'), { recursive: true });
    await Promise.all([
      writeFile(join(android, 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest />'),
      writeFile(input, 'API_URL=https://example.com/a:b\nTOKEN="hello world"\n'),
    ]);

    const result = await placeProjectEnvironmentFile(input, root);

    expect(detectProjectEnvironmentKind(root)).toBe('android');
    expect(result.path).toBe(join(android, 'local.properties'));
    expect(await readFile(result.path, 'utf8')).toBe(
      'API_URL=https\://example.com/a\:b\nTOKEN=hello world\n'
    );
  });

  it('uses .env for ordinary projects', async () => {
    const root = await fixture();
    const input = join(root, 'values.properties');
    await writeFile(input, 'NAME: product demo\n');

    const result = await placeProjectEnvironmentFile(input, root);

    expect(result.kind).toBe('dotenv');
    expect(await readFile(result.path, 'utf8')).toBe('NAME="product demo"\n');
  });
});
