import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { arch, cpus } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { logger } from '@auto-product-video-generator/core';

export interface AndroidProjectOptions {
  package?: string;
  activity?: string;
  serial?: string;
  avd?: string;
  apkPath?: string;
  buildCommand?: string;
  sdkPath?: string;
  autoStartEmulator?: boolean;
  autoInstall?: boolean;
}

export interface AndroidProjectContext {
  rootDir: string;
  workDir: string;
}

export interface PreparedAndroidTarget {
  package: string;
  activity?: string;
  serial: string;
  adbPath: string;
  emulatorStartedByApvg: boolean;
}

interface AndroidDevice {
  serial: string;
  startedByApvg: boolean;
}

/** Prepares the same basic runtime Android Studio uses for Run: device, APK, install. */
export async function prepareAndroidProject(
  options: AndroidProjectOptions,
  context: AndroidProjectContext
): Promise<PreparedAndroidTarget> {
  const adbPath = findSdkTool('adb', options.sdkPath);
  const device = await ensureAndroidDevice(adbPath, options, context.workDir);
  try {
    return await prepareAndroidApp(options, context.rootDir, adbPath, device);
  } catch (error) {
    if (device.startedByApvg) await stopAndroidEmulator(adbPath, device.serial);
    throw error;
  }
}

async function prepareAndroidApp(
  options: AndroidProjectOptions,
  sourceRoot: string,
  adbPath: string,
  device: AndroidDevice
): Promise<PreparedAndroidTarget> {
  const configuredApk = options.apkPath ? resolve(sourceRoot, options.apkPath) : undefined;
  if (configuredApk && !existsSync(configuredApk)) {
    throw new Error(`Configured Android APK does not exist: ${configuredApk}`);
  }

  let apkPath = configuredApk;
  if (!apkPath) {
    const plan = await detectBuildPlan(sourceRoot, options.buildCommand);
    if (plan) {
      logger.step('android:build', `${plan.label}: ${plan.command}`);
      await runShell(plan.command, plan.cwd);
      apkPath = await findNewestApk(sourceRoot);
    } else {
      apkPath = await findNewestApk(sourceRoot);
    }
  }

  if (!apkPath) {
    throw new Error(
      'No Android APK was found and no conventional Gradle/Flutter build could be detected. ' +
        'For Unity or a custom project, set target.android.buildCommand and optionally target.android.apkPath.'
    );
  }
  logger.success(`Android APK: ${apkPath}`);

  // APK metadata is authoritative for debug applicationIdSuffix values;
  // source parsing is only a fallback when Android build-tools are absent.
  const packageName =
    options.package ||
    (await detectPackageFromApk(apkPath, options.sdkPath)) ||
    (await detectPackageFromSource(sourceRoot));
  if (!packageName) {
    throw new Error(
      `Could not detect the Android application id from source or ${apkPath}. ` +
        'Set target.android.package in apvg.config.yml.'
    );
  }

  if (options.autoInstall !== false) {
    logger.step('android:install', `Installing ${packageName} on ${device.serial}...`);
    await run(adbPath, ['-s', device.serial, 'install', '-r', '-t', apkPath]);
  }
  const installed = await run(adbPath, [
    '-s',
    device.serial,
    'shell',
    'pm',
    'path',
    packageName,
  ]);
  if (!installed.trim().startsWith('package:')) {
    throw new Error(`Android package '${packageName}' is not installed on ${device.serial}.`);
  }
  const activity =
    options.activity || (await resolveLauncherActivity(adbPath, device.serial, packageName));
  logger.success(`Android app ready: ${packageName} on ${device.serial}`);
  return {
    package: packageName,
    activity,
    serial: device.serial,
    adbPath,
    emulatorStartedByApvg: device.startedByApvg,
  };
}

async function resolveLauncherActivity(
  adbPath: string,
  serial: string,
  packageName: string
): Promise<string | undefined> {
  const output = await run(adbPath, [
    '-s',
    serial,
    'shell',
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '-c',
    'android.intent.category.LAUNCHER',
    packageName,
  ]).catch(() => '');
  const component = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.includes('/'));
  return component?.slice(component.indexOf('/') + 1);
}

export async function stopPreparedAndroidTarget(target: PreparedAndroidTarget): Promise<void> {
  if (!target.emulatorStartedByApvg) return;
  await stopAndroidEmulator(target.adbPath, target.serial);
}

async function stopAndroidEmulator(adbPath: string, serial: string): Promise<void> {
  logger.step('android:emulator', `Stopping ${serial}...`);
  try {
    await run(adbPath, ['-s', serial, 'emu', 'kill']);
    logger.success(`Android emulator stopped: ${serial}`);
  } catch (error) {
    logger.warn(`Could not stop Android emulator '${serial}': ${(error as Error).message}`);
  }
}

interface BuildPlan {
  label: string;
  command: string;
  cwd: string;
}

async function detectBuildPlan(rootDir: string, override?: string): Promise<BuildPlan | undefined> {
  if (override) return { label: 'Configured build', command: override, cwd: rootDir };
  if (existsSync(join(rootDir, 'pubspec.yaml'))) {
    return { label: 'Flutter debug build', command: 'flutter build apk --debug', cwd: rootDir };
  }
  for (const candidate of [rootDir, join(rootDir, 'android')]) {
    const wrapper =
      process.platform === 'win32' ? join(candidate, 'gradlew.bat') : join(candidate, 'gradlew');
    if (existsSync(wrapper)) {
      const executable = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
      return {
        label: 'Gradle debug build',
        command: `${executable} assembleDebug`,
        cwd: candidate,
      };
    }
  }
  return undefined;
}

async function ensureAndroidDevice(
  adbPath: string,
  options: AndroidProjectOptions,
  workDir: string
): Promise<AndroidDevice> {
  await run(adbPath, ['start-server']);
  const connected = await listConnectedDevices(adbPath);
  if (options.serial && connected.includes(options.serial)) {
    await waitForBoot(adbPath, options.serial);
    return { serial: options.serial, startedByApvg: false };
  }
  if (!options.serial && connected.length > 0) {
    const emulator = connected.find((serial) => serial.startsWith('emulator-'));
    const selected = emulator || connected[0];
    logger.success(`Using connected Android device: ${selected}`);
    await waitForBoot(adbPath, selected);
    return { serial: selected, startedByApvg: false };
  }
  if (options.autoStartEmulator === false) {
    throw new Error(
      'No Android device is connected and target.android.autoStartEmulator is false.'
    );
  }

  let emulatorPath = findSdkTool('emulator', options.sdkPath, false);
  if (!emulatorPath) {
    await installEmulator(options.sdkPath);
    emulatorPath = findSdkTool('emulator', options.sdkPath);
  }
  const sdkRoot = resolveSdkRoot(emulatorPath, options.sdkPath);
  await ensurePlatformTools(sdkRoot, options.sdkPath);
  const emulatorEnv = androidSdkEnvironment(sdkRoot);
  const avdmanager = findCommandLineTool('avdmanager', options.sdkPath);
  const hostArch = androidHostArchitecture();
  const requiredAbi = hostArch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  let avdState = await listAvds(avdmanager, emulatorEnv);
  const compatibleAvds = parseCompatibleAvds(avdState.output, requiredAbi);
  if (!options.avd) {
    const incompatibleAvds = avdState.valid.filter((avd) => !compatibleAvds.includes(avd));
    await deleteInvalidAvds(
      avdmanager,
      [...new Set([...avdState.invalid, ...incompatibleAvds])],
      emulatorEnv
    );
  }
  let avds = options.avd ? avdState.valid : compatibleAvds;
  if (avds.length === 0 && !options.avd) {
    await installStablePixelAvd(sdkRoot, hostArch, options.sdkPath);
    avdState = await listAvds(avdmanager, emulatorEnv);
    avds = parseCompatibleAvds(avdState.output, requiredAbi);
  }
  const avd = options.avd || avds[0];
  if (!avd) {
    throw new Error(
      'No connected Android device and no AVD is installed. Create one in Android Studio Device Manager, ' +
        'or with sdkmanager/avdmanager, then rerun this command.'
    );
  }
  if (!avds.includes(avd)) {
    throw new Error(
      `Configured AVD '${avd}' was not found. Available AVDs: ${avds.join(', ') || '(none)'}`
    );
  }

  await mkdir(workDir, { recursive: true });
  const logPath = join(workDir, 'android-emulator.log');
  logger.step('android:emulator', `Starting AVD '${avd}' (logs: ${logPath})...`);
  const logHandle = openSync(logPath, 'a');
  const child = spawn(
    emulatorPath,
    ['-avd', avd, '-no-window', '-no-boot-anim', '-no-snapshot-save', '-no-audio'],
    {
      detached: true,
      env: emulatorEnv,
      stdio: ['ignore', logHandle, logHandle],
    }
  );
  closeSync(logHandle);
  let emulatorExitCode: number | null = null;
  child.once('close', (code) => {
    emulatorExitCode = code;
  });
  child.unref();

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (emulatorExitCode !== null) {
      const logTail = await readEmulatorLogTail(logPath);
      throw new Error(
        `Android emulator '${avd}' exited with code ${emulatorExitCode} before connecting. ` +
          `Check ${logPath}.${logTail}`
      );
    }
    const devices = await listConnectedDevices(adbPath);
    const selected =
      options.serial && devices.includes(options.serial)
        ? options.serial
        : devices.find((serial) => serial.startsWith('emulator-'));
    if (selected) {
      await waitForBoot(adbPath, selected, Math.max(1, deadline - Date.now()));
      logger.success(`Android emulator ready: ${selected}`);
      return { serial: selected, startedByApvg: true };
    }
    await wait(1500);
  }
  const logTail = await readEmulatorLogTail(logPath);
  throw new Error(
    `Android emulator '${avd}' did not connect within 240 seconds. Check ${logPath}.${logTail}`
  );
}

async function readEmulatorLogTail(logPath: string): Promise<string> {
  try {
    const lines = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).slice(-40);
    return lines.length > 0 && lines[0]
      ? `\n\nAndroid emulator log (last ${lines.length} lines):\n${lines.join('\n')}`
      : '';
  } catch {
    return '';
  }
}

async function listAvds(
  avdmanager: string,
  env: NodeJS.ProcessEnv
): Promise<{ output: string; valid: string[]; invalid: string[] }> {
  const output = await run(avdmanager, ['list', 'avd'], { env });
  return {
    output,
    valid: parseValidAvds(output),
    invalid: parseInvalidAvds(output),
  };
}

export function parseValidAvds(output: string): string[] {
  const validSection = output.split('The following Android Virtual Devices could not be loaded:')[0];
  return [...validSection.matchAll(/^\s*Name:\s*(.+)$/gm)].map((match) => match[1].trim());
}

export function parseInvalidAvds(output: string): string[] {
  const marker = 'The following Android Virtual Devices could not be loaded:';
  const invalidSection = output.includes(marker) ? output.split(marker)[1] : '';
  return [...invalidSection.matchAll(/^\s*Name:\s*(.+)$/gm)].map((match) => match[1].trim());
}

export function parseCompatibleAvds(output: string, requiredAbi: string): string[] {
  const marker = 'The following Android Virtual Devices could not be loaded:';
  const validSection = output.split(marker)[0];
  return validSection
    .split(/^\s*Name:\s*/m)
    .slice(1)
    .filter((block) => new RegExp(`Tag/ABI:.*\\/${requiredAbi}(?:\\s|$)`).test(block))
    .map((block) => block.split(/\r?\n/, 1)[0].trim());
}

export function detectAndroidHostArchitecture(
  nodeArch = arch(),
  platform = process.platform,
  cpuModels = cpus().map((cpu) => cpu.model),
  windowsNativeArch = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE
): string {
  if (nodeArch === 'arm64') return 'arm64';
  if (platform === 'darwin' && cpuModels.some((model) => /^Apple\s/i.test(model))) return 'arm64';
  if (platform === 'win32' && windowsNativeArch?.toUpperCase().includes('ARM64')) return 'arm64';
  return nodeArch;
}

function androidHostArchitecture(): string {
  return detectAndroidHostArchitecture();
}

async function deleteInvalidAvds(
  avdmanager: string,
  invalidAvds: string[],
  env: NodeJS.ProcessEnv
): Promise<void> {
  for (const avd of invalidAvds) {
    logger.warn(`Removing unusable Android AVD '${avd}' and its data...`);
    try {
      await run(avdmanager, ['delete', 'avd', '--name', avd], { env });
    } catch (error) {
      logger.warn(`Could not remove unusable AVD '${avd}': ${(error as Error).message}`);
    }
  }
}

async function installEmulator(sdkPath?: string): Promise<void> {
  const sdkmanager = findCommandLineTool('sdkmanager', sdkPath);
  const sdkRoot = resolveSdkRoot(sdkmanager, sdkPath);
  logger.step('android:sdk', 'Installing the stable Android Emulator package...');
  await run(sdkmanager, [`--sdk_root=${sdkRoot}`, '--channel=0', 'emulator'], {
    input: licenseAnswers(),
    streamOutput: true,
  });
}

async function ensurePlatformTools(sdkRoot: string, sdkPath?: string): Promise<void> {
  if (existsSync(join(sdkRoot, 'platform-tools', executableName('adb')))) return;
  const sdkmanager = findCommandLineTool('sdkmanager', sdkPath);
  logger.step('android:sdk', `Installing platform-tools into ${sdkRoot}...`);
  await run(sdkmanager, [`--sdk_root=${sdkRoot}`, '--channel=0', 'platform-tools'], {
    input: licenseAnswers(),
    streamOutput: true,
  });
}

async function installStablePixelAvd(
  sdkRoot: string,
  hostArch: string,
  sdkPath?: string
): Promise<void> {
  const sdkmanager = findCommandLineTool('sdkmanager', sdkPath);
  const avdmanager = findCommandLineTool('avdmanager', sdkPath);
  const env = androidSdkEnvironment(sdkRoot);
  logger.step('android:sdk', 'Selecting the latest stable Android Pixel system image...');
  const packages = await run(sdkmanager, [`--sdk_root=${sdkRoot}`, '--channel=0', '--list'], {
    env,
  });
  const systemImage = selectLatestStableSystemImage(packages, hostArch);
  if (!systemImage) {
    throw new Error(
      `No stable Android system image compatible with ${hostArch} was found in sdkmanager channel 0.`
    );
  }
  logger.step('android:sdk', `Installing ${systemImage}...`);
  await run(sdkmanager, [`--sdk_root=${sdkRoot}`, '--channel=0', systemImage], {
    input: licenseAnswers(),
    streamOutput: true,
    env,
  });

  const devices = await run(avdmanager, ['list', 'device'], { env });
  const pixel = selectLatestPixelDevice(devices);
  if (!pixel) {
    throw new Error('No Pixel hardware profile was found in avdmanager.');
  }
  const api = systemImage.match(/android-(\d+)/)?.[1];
  const name = `apvg-pixel-stable-api-${api}`;
  logger.step('android:avd', `Creating '${name}' with device '${pixel}'...`);
  await run(
    avdmanager,
    ['create', 'avd', '--force', '--name', name, '--package', systemImage, '--device', pixel],
    { input: 'no\n', env }
  );
}

export function selectLatestStableSystemImage(
  output: string,
  hostArch: string
): string | undefined {
  const preferredAbi = hostArch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const pattern =
    /system-images;android-(\d+);(google_apis_playstore|google_apis);(arm64-v8a|x86_64)/g;
  const candidates = [...output.matchAll(pattern)]
    .map((match) => ({
      package: match[0],
      api: Number(match[1]),
      image: match[2],
      abi: match[3],
    }))
    .filter((candidate) => candidate.abi === preferredAbi);
  candidates.sort(
    (left, right) =>
      right.api - left.api ||
      Number(right.image === 'google_apis_playstore') -
        Number(left.image === 'google_apis_playstore')
  );
  return candidates[0]?.package;
}

export function selectLatestPixelDevice(output: string): string | undefined {
  const devices = [
    ...output.matchAll(/id:\s*\d+\s+or\s+"([^"]*pixel[_ -]?(\d+)[^"]*)"/gi),
  ].map((match) => ({ id: match[1], generation: Number(match[2]) }));
  devices.sort(
    (left, right) =>
      right.generation - left.generation || left.id.localeCompare(right.id)
  );
  return devices[0]?.id;
}

async function listConnectedDevices(adbPath: string): Promise<string[]> {
  const output = await run(adbPath, ['devices']);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && (parts[1] === 'device' || parts[1] === 'offline'))
    .map((parts) => parts[0]);
}

async function waitForBoot(adbPath: string, serial: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const booted = await run(adbPath, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']);
      if (booted.trim() === '1') {
        await run(adbPath, ['-s', serial, 'shell', 'input', 'keyevent', '82']).catch(() => '');
        return;
      }
    } catch {
      /* device is still transitioning */
    }
    await wait(1200);
  }
  throw new Error(
    `Android device '${serial}' did not finish booting within ${Math.round(timeoutMs / 1000)} seconds.`
  );
}

async function findNewestApk(rootDir: string): Promise<string | undefined> {
  const matches: Array<{ path: string; mtime: number }> = [];
  const excluded = new Set(['.git', 'node_modules', '.gradle', '.dart_tool']);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 9) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) await walk(join(dir, entry.name), depth + 1);
      } else if (entry.name.endsWith('.apk') && !/-androidTest|-unaligned/.test(entry.name)) {
        const path = join(dir, entry.name);
        matches.push({ path, mtime: (await stat(path)).mtimeMs });
      }
    }
  }
  await walk(rootDir, 0);
  matches.sort((a, b) => {
    const aDebug = /debug/i.test(a.path) ? 1 : 0;
    const bDebug = /debug/i.test(b.path) ? 1 : 0;
    return bDebug - aDebug || b.mtime - a.mtime;
  });
  return matches[0]?.path;
}

async function detectPackageFromSource(rootDir: string): Promise<string | undefined> {
  const candidates = [
    join(rootDir, 'app', 'build.gradle'),
    join(rootDir, 'app', 'build.gradle.kts'),
    join(rootDir, 'android', 'app', 'build.gradle'),
    join(rootDir, 'android', 'app', 'build.gradle.kts'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = await readFile(path, 'utf8');
    const match = text.match(/\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/);
    if (match) return match[1];
  }
  const manifests = [
    join(rootDir, 'app', 'src', 'main', 'AndroidManifest.xml'),
    join(rootDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  ];
  for (const path of manifests) {
    if (!existsSync(path)) continue;
    const match = (await readFile(path, 'utf8')).match(
      /<manifest\b[^>]*\bpackage=["']([^"']+)["']/
    );
    if (match) return match[1];
  }
  return undefined;
}

async function detectPackageFromApk(
  apkPath: string,
  sdkPath?: string
): Promise<string | undefined> {
  const aapt = findBuildTool('aapt', sdkPath) || findBuildTool('aapt2', sdkPath);
  if (!aapt) return undefined;
  try {
    const output = await run(aapt, ['dump', 'badging', apkPath]);
    return output.match(/^package: name='([^']+)'/m)?.[1];
  } catch {
    return undefined;
  }
}

function findBuildTool(name: string, sdkPath?: string): string | undefined {
  for (const sdk of sdkRoots(sdkPath)) {
    const dir = join(sdk, 'build-tools');
    if (!existsSync(dir)) continue;
    try {
      const versions = readdirSync(dir).sort().reverse();
      for (const version of versions) {
        const path = join(dir, version, executableName(name));
        if (existsSync(path)) return path;
      }
    } catch {
      /* continue */
    }
  }
  return undefined;
}

function findSdkTool(name: 'adb' | 'emulator', sdkPath?: string): string;
function findSdkTool(
  name: 'adb' | 'emulator',
  sdkPath: string | undefined,
  required: false
): string | undefined;
function findSdkTool(
  name: 'adb' | 'emulator',
  sdkPath?: string,
  required = true
): string | undefined {
  const relative =
    name === 'adb'
      ? join('platform-tools', executableName(name))
      : join('emulator', executableName(name));
  for (const sdk of sdkRoots(sdkPath)) {
    const path = join(sdk, relative);
    if (existsSync(path)) return path;
  }
  const executable = findExecutableOnPath(executableName(name));
  if (executable) return executable;
  if (!required) return undefined;
  throw new Error(
    `Android SDK tool '${name}' was not found. Install Android SDK Platform-Tools and add the ` +
      `directory containing '${executableName(name)}' to PATH. Alternatively, set ` +
      'target.android.sdkPath, ANDROID_SDK_ROOT, or ANDROID_HOME.'
  );
}

function sdkRoots(configured?: string): string[] {
  const sdkmanager = findExecutableOnPath(executableName('sdkmanager'));
  const inferred = sdkmanager ? inferSdkRoot(sdkmanager) : undefined;
  return [
    ...new Set([configured, process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME, inferred]),
  ].filter((value): value is string => Boolean(value));
}

function inferSdkRoot(sdkmanager: string): string | undefined {
  const realPath = realpathSync(sdkmanager);
  const binDir = dirname(realPath);
  const versionDir = dirname(binDir);
  if (dirname(versionDir).endsWith('cmdline-tools')) return dirname(dirname(versionDir));
  if (versionDir.endsWith('tools')) return dirname(versionDir);
  return undefined;
}

function resolveSdkRoot(toolPath: string, configured?: string): string {
  const realPath = realpathSync(toolPath);
  const parent = dirname(realPath);
  if (basename(parent) === 'emulator') return dirname(parent);
  const inferred = inferSdkRoot(realPath);
  if (inferred) return inferred;
  const root = sdkRoots(configured)[0];
  if (root) return root;
  throw new Error(
    'Could not resolve the Android SDK root. Set target.android.sdkPath, ANDROID_SDK_ROOT, or ANDROID_HOME.'
  );
}

function androidSdkEnvironment(sdkRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
  };
}

function findCommandLineTool(name: 'sdkmanager' | 'avdmanager', sdkPath?: string): string {
  const executable = process.platform === 'win32' ? `${name}.bat` : name;
  for (const sdk of sdkRoots(sdkPath)) {
    for (const relative of [
      join('cmdline-tools', 'latest', 'bin', executable),
      join('cmdline-tools', 'bin', executable),
      join('tools', 'bin', executable),
    ]) {
      const path = join(sdk, relative);
      if (existsSync(path)) return path;
    }
  }
  const path = findExecutableOnPath(executable);
  if (path) return path;
  throw new Error(
    `Android command-line tool '${name}' was not found. Install the official Android SDK Command-line Tools ` +
      'and add its bin directory to PATH, or set target.android.sdkPath, ANDROID_SDK_ROOT, or ANDROID_HOME.'
  );
}

function findExecutableOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!directory) continue;
    const path = join(directory, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}
function executableName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function runShell(command: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`Android build command exited with code ${code}: ${command}`))
    );
  });
}

interface RunOptions {
  input?: string;
  streamOutput?: boolean;
  env?: NodeJS.ProcessEnv;
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      shell: process.platform === 'win32' && command.endsWith('.bat'),
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => {
      stdout += chunk;
      if (options.streamOutput) process.stdout.write(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
      if (options.streamOutput) process.stderr.write(chunk);
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
    child.on('error', (error) => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.on('close', (code) =>
      code === 0
        ? resolvePromise(stdout)
        : reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr.trim()}`))
    );
  });
}
function licenseAnswers(): string {
  return 'y\n'.repeat(20);
}
function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
