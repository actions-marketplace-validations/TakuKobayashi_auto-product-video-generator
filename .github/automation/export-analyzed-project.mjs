import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const workDir = process.env.APVG_WORK_DIR;
const githubOutput = process.env.GITHUB_OUTPUT;
const unityVersionOverride = process.env.UNITY_VERSION_OVERRIDE?.trim();
if (!workDir) throw new Error('APVG_WORK_DIR is required');
if (!githubOutput) throw new Error('GITHUB_OUTPUT is required');

const resolved = JSON.parse(await readFile(join(workDir, 'resolved-config.json'), 'utf8'));
const source = JSON.parse(await readFile(join(workDir, 'source-context.json'), 'utf8'));
const platform = resolved.platform;
const lines = [`platform=${platform}`];

if (platform === 'unity') {
  if (!source.rootDir) throw new Error('Unity project root was not recorded by project analyze');
  const requestedVersion = unityVersionOverride || source.unity?.editorVersion;
  if (!requestedVersion) throw new Error('Unity Editor version was not detected');
  const unityVersion = isBelowMinimumUnityVersion(requestedVersion)
    ? await resolveLatestStableUnityVersion()
    : requestedVersion;
  if (unityVersion !== requestedVersion) {
    console.log(
      `::warning::Unity ${requestedVersion} is older than the minimum supported version 2022.2. ` +
        `Using the latest stable Unity Editor ${unityVersion} for recording.`
    );
  }
  lines.push(`unity-project-path=${source.rootDir}`);
  lines.push(`unity-version-file=${join(source.rootDir, 'ProjectSettings', 'ProjectVersion.txt')}`);
  lines.push(`unity-version=${unityVersion}`);
}

await appendFile(githubOutput, `${lines.join('\n')}\n`, 'utf8');

function isBelowMinimumUnityVersion(version) {
  const match = version.match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? undefined : Number(match[2]);
  return major < 2022 || (major === 2022 && minor !== undefined && minor < 2);
}

async function resolveLatestStableUnityVersion() {
  const url = new URL('https://services.api.unity.com/unity/editor/release/v1/releases');
  url.search = new URLSearchParams({
    limit: '25',
    offset: '0',
    order: 'RELEASE_DATE_DESC',
    platform: 'LINUX',
    architecture: 'X86_64',
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unity Releases API returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  const release = payload.results?.find(
    ({ version, stream }) =>
      /f\d+$/.test(version) && (stream === 'LTS' || stream === 'SUPPORTED')
  );
  if (!release) throw new Error('Unity Releases API returned no stable Linux Editor release');
  return release.version;
}
