import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

async function main(): Promise<void> {
  const requestedVersion = process.argv[2]?.replace(/^v/, '');

  if (!requestedVersion) {
    throw new Error('Version is required. Example: pnpm version:set 0.3.0');
  }

  if (!VERSION_PATTERN.test(requestedVersion)) {
    throw new Error(
      `Invalid release version: ${requestedVersion}. Use SemVer without build metadata, for example 0.3.0 or 0.3.0-beta.1.`
    );
  }

  const packageJsonPath = resolve('packages/cli/package.json');
  const packageJsonSource = await readFile(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(packageJsonSource) as {
    name?: string;
    version?: string;
    [key: string]: unknown;
  };

  if (packageJson.name !== 'auto-product-video-generator') {
    throw new Error(
      `Unexpected publish package in ${packageJsonPath}: ${packageJson.name ?? '(missing)'}`
    );
  }

  if (packageJson.version === requestedVersion) {
    console.log(`${packageJson.name} is already at version ${requestedVersion}.`);
  } else {
    const previousVersion = packageJson.version ?? '(missing)';
    const updatedSource = packageJsonSource.replace(
      /("version"\s*:\s*")[^"]+("\s*,)/,
      (_match, prefix: string, suffix: string) => `${prefix}${requestedVersion}${suffix}`
    );
    if (updatedSource === packageJsonSource) {
      throw new Error(`Unable to update the version field in ${packageJsonPath}`);
    }
    await writeFile(packageJsonPath, updatedSource, 'utf8');
    console.log(`Updated ${packageJson.name}: ${previousVersion} -> ${requestedVersion}`);
    console.log(`Updated: ${packageJsonPath}`);
  }

  console.log('After reviewing and committing the change, create the release tag:');
  console.log(`  git tag v${requestedVersion}`);
  console.log(`  git push origin v${requestedVersion}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
