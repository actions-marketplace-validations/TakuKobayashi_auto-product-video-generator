import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareAndroidProject,
  detectAndroidHostArchitecture,
  parseCompatibleAvds,
  parseInvalidAvds,
  parseValidAvds,
  selectLatestPixelDevice,
  selectLatestStableSystemImage,
} from './android-project.js';

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('Android emulator selection', () => {
  it('excludes AVDs whose system images cannot be loaded', () => {
    const output = `
Available Android Virtual Devices:
    Name: apvg-pixel-stable-api-36
    Path: /tmp/apvg-pixel-stable-api-36.avd
  Target: Google Play
          Based on: Android 16.0 Tag/ABI: google_apis_playstore/x86_64

The following Android Virtual Devices could not be loaded:
    Name: Pixel_9
    Path: /tmp/Pixel_9.avd
   Error: Missing system image android-36/google_apis_playstore/arm64-v8a.
`;
    expect(parseValidAvds(output)).toEqual(['apvg-pixel-stable-api-36']);
    expect(parseInvalidAvds(output)).toEqual(['Pixel_9']);
    expect(parseCompatibleAvds(output, 'x86_64')).toEqual(['apvg-pixel-stable-api-36']);
    expect(parseCompatibleAvds(output, 'arm64-v8a')).toEqual([]);
  });

  it('detects Apple Silicon when Node runs through Rosetta', () => {
    expect(detectAndroidHostArchitecture('x64', 'darwin', ['Apple M4'])).toBe('arm64');
    expect(detectAndroidHostArchitecture('x64', 'linux', ['Intel Xeon'])).toBe('x64');
    expect(detectAndroidHostArchitecture('x64', 'win32', [], 'ARM64')).toBe('arm64');
  });

  it('selects the newest stable Google Play image for the host architecture', () => {
    const packages = `
system-images;android-35;google_apis_playstore;x86_64
system-images;android-36;google_apis;x86_64
system-images;android-36;google_apis_playstore;x86_64
system-images;android-37;google_apis_playstore;arm64-v8a
system-images;android-Baklava;google_apis_playstore;x86_64
`;
    expect(selectLatestStableSystemImage(packages, 'x64')).toBe(
      'system-images;android-36;google_apis_playstore;x86_64'
    );
    expect(selectLatestStableSystemImage(packages, 'arm64')).toBe(
      'system-images;android-37;google_apis_playstore;arm64-v8a'
    );
  });

  it('selects the newest Pixel hardware profile', () => {
    const devices = `
id: 17 or "pixel_8"
id: 18 or "pixel_9_pro"
id: 19 or "Nexus 7"
`;
    expect(selectLatestPixelDevice(devices)).toBe('pixel_9_pro');
  });
});

describe('prepareAndroidProject', () => {
  const posixTest = process.platform === 'win32' ? it.skip : it;

  posixTest(
    'builds a debug APK, detects its package, and installs it on a connected emulator',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'apvg-android-spec-'));
      temporaryPaths.push(temp);
      const sdk = join(temp, 'sdk');
      const project = join(temp, 'project');
      const workDir = join(temp, 'work');
      await Promise.all([
        mkdir(join(sdk, 'platform-tools'), { recursive: true }),
        mkdir(join(sdk, 'build-tools', '35.0.0'), { recursive: true }),
        mkdir(project, { recursive: true }),
      ]);

      const adb = join(sdk, 'platform-tools', 'adb');
      await Promise.all([
        executable(
          adb,
          `#!/bin/sh
case "$*" in
  "devices") printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  *"getprop sys.boot_completed"*) echo 1 ;;
  *"pm path com.example.demo"*) echo package:/data/app/com.example.demo/base.apk ;;
  *"resolve-activity"*) echo com.example.demo/.MainActivity ;;
  *) exit 0 ;;
esac
`
        ),
        executable(
          join(sdk, 'build-tools', '35.0.0', 'aapt'),
          "#!/bin/sh\necho \"package: name='com.example.demo' versionCode='1'\"\n"
        ),
        executable(
          join(project, 'gradlew'),
          `#!/bin/sh
mkdir -p app/build/outputs/apk/debug
printf apk > app/build/outputs/apk/debug/app-debug.apk
`
        ),
      ]);
      const result = await prepareAndroidProject({ sdkPath: sdk }, { rootDir: project, workDir });

      expect(result.package).toBe('com.example.demo');
      expect(result.activity).toBe('.MainActivity');
      expect(result.serial).toBe('emulator-5554');
      expect(result.emulatorStartedByApvg).toBe(false);
      expect(existsSync(join(project, 'app/build/outputs/apk/debug/app-debug.apk'))).toBe(true);
    }
  );
});

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8');
  await chmod(path, 0o755);
}
