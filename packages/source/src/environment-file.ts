import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export type ProjectEnvironmentKind = 'dotenv' | 'cloudflare' | 'android';

export interface PlacedEnvironmentFile {
  kind: ProjectEnvironmentKind;
  path: string;
}

/** Place a supplied environment file using the selected project's native convention. */
export async function placeProjectEnvironmentFile(
  inputPath: string,
  projectRoot: string
): Promise<PlacedEnvironmentFile> {
  const sourcePath = resolve(inputPath);
  if (!existsSync(sourcePath)) throw new Error(`Environment file not found: ${sourcePath}`);

  const kind = detectProjectEnvironmentKind(projectRoot);
  const destinationName =
    kind === 'android' ? 'local.properties' : kind === 'cloudflare' ? '.dev.vars' : '.env';
  const androidRoot = existsSync(join(projectRoot, 'android'))
    ? join(projectRoot, 'android')
    : projectRoot;
  const destinationPath = join(kind === 'android' ? androidRoot : projectRoot, destinationName);
  const contents = await readFile(sourcePath, 'utf8');

  // Preserve the file byte-for-byte when it already uses the target convention.
  // This also retains advanced dotenv syntax that does not need conversion.
  const output =
    basename(sourcePath) === destinationName
      ? contents
      : serializeEnvironment(parseEnvironment(contents), kind);
  await writeFile(destinationPath, output, { encoding: 'utf8', mode: 0o600 });
  await chmod(destinationPath, 0o600);
  return { kind, path: destinationPath };
}

export function detectProjectEnvironmentKind(projectRoot: string): ProjectEnvironmentKind {
  if (
    ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].some((name) =>
      existsSync(join(projectRoot, name))
    )
  )
    return 'cloudflare';

  if (
    ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].some((name) =>
      existsSync(join(projectRoot, name))
    ) ||
    existsSync(join(projectRoot, 'app', 'src', 'main', 'AndroidManifest.xml')) ||
    existsSync(join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'))
  )
    return 'android';

  return 'dotenv';
}

function parseEnvironment(contents: string): Array<[string, string]> {
  const values: Array<[string, string]> = [];
  for (const [index, originalLine] of contents.split(/\r?\n/).entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const separator = findSeparator(normalized);
    if (separator < 1) {
      throw new Error(`Cannot convert environment file line ${index + 1}: expected KEY=VALUE`);
    }
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new Error(`Cannot convert environment file line ${index + 1}: invalid key '${key}'`);
    }
    values.push([key, decodeValue(normalized.slice(separator + 1).trim())]);
  }
  return values;
}

function findSeparator(line: string): number {
  const equals = line.indexOf('=');
  if (equals >= 0) return equals;
  // Java properties also permits ':' as the key/value separator.
  return line.indexOf(':');
}

function decodeValue(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && /['"]/.test(value[0])) {
    const inner = value.slice(1, -1);
    return value[0] === '"'
      ? inner
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
      : inner;
  }
  return value;
}

function serializeEnvironment(
  values: Array<[string, string]>,
  kind: ProjectEnvironmentKind
): string {
  return `${values
    .map(([key, value]) => {
      if (kind === 'android') return `${escapePropertyKey(key)}=${escapePropertyValue(value)}`;
      return `${key}=${encodeDotenvValue(value)}`;
    })
    .join('\n')}\n`;
}

function encodeDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function escapePropertyValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/^ /, '\\ ')
    .replace(/ $/, '\\ ');
}

function escapePropertyKey(value: string): string {
  return escapePropertyValue(value)
    .replace(/([:=#!])/g, '\\$1')
    .replace(/ /g, '\\ ');
}
