import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { ZodError } from 'zod';
import { ApvgConfig, ApvgConfigSchema, SourceConfig } from '../types/config.js';

type ConfigPath = Array<string | number>;
interface PlaceholderEntry {
  path: ConfigPath;
  template: string;
}
const configPlaceholders = new WeakMap<ApvgConfig, PlaceholderEntry[]>();

export async function loadConfig(configPath: string): Promise<ApvgConfig> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}\nRun 'pnpm apvg project init' first.`);
  }
  const raw = await readFile(configPath, 'utf-8');
  const parsed = yaml.load(raw);

  await loadConfigEnvironment(configPath, parsed);
  const placeholders: PlaceholderEntry[] = [];
  const expanded = expandEnvironmentPlaceholders(parsed, [], placeholders);

  const result = ApvgConfigSchema.safeParse(expanded);
  if (!result.success) {
    throw new Error(formatConfigError(configPath, result.error));
  }
  configPlaceholders.set(result.data, placeholders);
  return result.data;
}

function expandEnvironmentPlaceholders(
  value: unknown,
  path: ConfigPath,
  placeholders: PlaceholderEntry[]
): unknown {
  if (typeof value === 'string' && value.includes('${')) {
    const expanded = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_placeholder, name: string) => {
        const resolved = process.env[name];
        if (resolved === undefined) {
          throw new Error(
            `Environment variable ${name} referenced at ${path.join('.')} is not set.`
          );
        }
        return resolved;
      }
    );
    if (expanded !== value) placeholders.push({ path: [...path], template: value });
    return expanded;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      expandEnvironmentPlaceholders(item, [...path, index], placeholders)
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expandEnvironmentPlaceholders(item, [...path, key], placeholders),
      ])
    );
  }
  return value;
}

async function loadConfigEnvironment(configPath: string, parsed: unknown): Promise<void> {
  const configDir = dirname(resolve(configPath));
  const voiceEnvFile =
    parsed && typeof parsed === 'object' && 'voice' in parsed
      ? (parsed as { voice?: { envFile?: unknown } }).voice?.envFile
      : undefined;
  const candidates = [join(configDir, '.env'), join(configDir, '.env.local')];
  if (typeof voiceEnvFile === 'string') {
    candidates.push(isAbsolute(voiceEnvFile) ? voiceEnvFile : join(configDir, voiceEnvFile));
  }

  const loaded: Record<string, string> = {};
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    Object.assign(loaded, parseDotenv(await readFile(path, 'utf-8')));
  }
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    values[match[1]] = value;
  }
  return values;
}

function formatConfigError(configPath: string, error: ZodError): string {
  const lines = error.issues.map(
    (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`
  );
  const missingSource = error.issues.some((i) => i.path[0] === 'source');
  const hint = missingSource
    ? `\nThis usually means ${configPath} predates the 'source' field (added so 'analyze' can read real ` +
      `project source instead of guessing from a URL). Re-run:\n` +
      `  pnpm apvg project init --repo <git-url> --url <target-url> --force\n` +
      `  pnpm apvg project init --source <local-path> --url <target-url> --force`
    : '';
  return `Invalid ${configPath}:\n${lines.join('\n')}${hint}`;
}

export async function saveConfig(
  configPath: string,
  config: ApvgConfig,
  options: { omitAutoDetectedTarget?: boolean } = {}
): Promise<void> {
  const serializable = structuredClone(config) as unknown as Record<string, unknown>;
  if (options.omitAutoDetectedTarget) delete serializable.target;
  for (const placeholder of configPlaceholders.get(config) ?? []) {
    setAtPath(serializable, placeholder.path, placeholder.template);
  }
  const content = yaml.dump(serializable, { lineWidth: 120, quotingType: '"' });
  await writeFile(configPath, content, 'utf-8');
}

function setAtPath(root: Record<string, unknown>, path: ConfigPath, value: string): void {
  let target: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    target = (target as Record<string | number, unknown>)[path[index]];
  }
  if (path.length > 0 && target && typeof target === 'object') {
    (target as Record<string | number, unknown>)[path[path.length - 1]] = value;
  }
}

export function createDefaultConfig(
  name: string,
  url: string,
  source: SourceConfig,
  autoDetectUrl = false
): ApvgConfig {
  // Pick a default that only references providers usable right now. Do not
  // add a cloud fallback without its API key: Ollama-only usage must remain
  // fully local and must never fail with an unrelated cloud-key error.
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;

  const llm = hasGeminiKey
    ? {
        provider: 'gemini' as const,
        model: 'gemini-2.5-pro',
        fallbackProvider: 'ollama' as const,
        fallbackModel: 'qwen2.5:7b-instruct',
      }
    : {
        provider: 'ollama' as const,
        model: 'qwen2.5:7b-instruct',
        ollamaHost: 'http://127.0.0.1:11434',
      };

  return ApvgConfigSchema.parse({
    project: { name, description: '' },
    source,
    target: { url, autoDetectUrl, type: 'web' },
    video: {},
    llm,
    voicevox: {},
    output: {},
  });
}
