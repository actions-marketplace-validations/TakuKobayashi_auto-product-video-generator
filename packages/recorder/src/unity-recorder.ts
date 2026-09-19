import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  logger,
  resolveFfmpegPath,
  type Scene,
  type UnityConfig,
  type VideoConfig,
} from '@auto-product-video-generator/core';
import { convertVideo } from '@auto-product-video-generator/renderer';
import type { PlatformRecorder, PlatformRecordOptions } from './types.js';

interface UnityRecorderContext {
  rootDir?: string;
  workDir: string;
}

interface QueuedRecording {
  id: string;
  finalOutput: string;
  sceneIndex: number;
  scenePath?: string;
  duration: number;
  warmup: number;
  fps: number;
  width: number;
  height: number;
  includeAudio: boolean;
}

interface UnityRecordingPlan {
  timeoutSeconds: number;
  jobs: Array<Omit<QueuedRecording, 'id' | 'finalOutput'> & { output: string }>;
}

const COPY_EXCLUDES = new Set(['.git', '.apvg', '.vs', 'Logs', 'obj', 'Temp', 'UserSettings']);

export class UnityRecorder implements PlatformRecorder {
  private readonly jobs: QueuedRecording[] = [];
  private temporaryProject?: string;
  private finalized = false;

  constructor(
    private readonly target: UnityConfig,
    private readonly context: UnityRecorderContext
  ) {}

  async recordScene(
    scene: Scene,
    config: VideoConfig,
    options: PlatformRecordOptions,
    targetDurationSeconds = 1
  ): Promise<string> {
    const outputPath = resolve(options.outputDir, `scene-${scene.id}.mp4`);
    const scenarioIndex = options.sceneIndex ?? this.jobs.length;
    const sceneNumber = this.target.sceneStartIndex + scenarioIndex;
    const configuredScene = this.target.scenes?.[scenarioIndex];
    if (this.target.scenes && configuredScene === undefined) {
      throw new Error(
        `No target.unity.scenes entry exists for APVG scene '${scene.id}'. ` +
          'Add another Unity scene path or record this APVG scene separately.'
      );
    }

    const ignoredActions = scene.actions.filter((action) => action.type !== 'wait');
    if (ignoredActions.length > 0) {
      logger.warn(
        `Unity Recorder loads the Scene directly; ${ignoredActions.length} interaction action(s) ` +
          `in '${scene.id}' are not executed.`
      );
    }
    logger.step(
      'record:unity',
      `Queued ${scene.id} -> ${configuredScene || `Build Settings index ${sceneNumber}`}`
    );
    if (options.dryRun) {
      logger.dryRun(
        `Would record ${targetDurationSeconds.toFixed(1)}s to ${outputPath} with Unity Recorder`
      );
      return outputPath;
    }

    const [width, height] = config.resolution.split('x').map(Number);
    this.jobs.push({
      id: scene.id,
      finalOutput: outputPath,
      sceneIndex: sceneNumber,
      scenePath: configuredScene,
      duration: Math.max(0.1, targetDurationSeconds),
      warmup: this.target.sceneLoadWaitSeconds,
      fps: config.fps,
      width,
      height,
      includeAudio: this.target.includeAudio,
    });
    return outputPath;
  }

  async finalize(): Promise<void> {
    if (this.finalized || this.jobs.length === 0) return;
    this.finalized = true;
    if (!this.context.rootDir) {
      throw new Error('Unity recording requires a resolved source project.');
    }

    const sourceRoot = resolve(this.context.rootDir);
    assertUnityProject(sourceRoot);
    const editorPath = await resolveUnityEditorPath(sourceRoot, this.target.editorPath);
    const token = `${process.pid}-${Date.now()}`;
    // Keep this path deliberately short. Unity PackageCache contains deeply
    // nested files and otherwise exceeds Windows' legacy MAX_PATH limit.
    this.temporaryProject = resolve(tmpdir(), `apvg-unity-${token}`);
    const stagedOutputDir = join(this.temporaryProject, 'APVGRecordings');
    const logPath = resolve(this.context.workDir, 'unity-recorder.log');

    logger.step(
      'record:unity',
      `Preparing isolated Unity project for ${this.jobs.length} scene(s)...`
    );
    await copyUnityProject(sourceRoot, this.temporaryProject);
    await ensureUnityRecorderPackage(
      this.temporaryProject,
      resolveUnityVersion(editorPath, sourceRoot)
    );
    const scriptPath = join(this.temporaryProject, 'Assets', 'APVG', 'Editor', 'ApvgRecorder.cs');
    await Promise.all([
      mkdir(dirname(scriptPath), { recursive: true }),
      mkdir(stagedOutputDir, { recursive: true }),
      mkdir(dirname(logPath), { recursive: true }),
    ]);
    await copyFile(resolveUnityEditorAsset(), scriptPath);

    const plan: UnityRecordingPlan = {
      timeoutSeconds: this.target.timeoutSeconds,
      jobs: this.jobs.map(({ id, finalOutput, ...job }) => ({
        ...job,
        output: join(stagedOutputDir, `${basename(finalOutput, '.mp4')}.webm`),
      })),
    };
    const planPath = join(this.temporaryProject, 'apvg-recording-plan.json');
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

    logger.info(`Unity Editor: ${editorPath}`);
    logger.info(`Scenes:       ${this.jobs.length} (single Editor session)`);
    logger.dim(`Temporary project: ${this.temporaryProject}`);
    await runUnity(
      editorPath,
      [
        '-batchmode',
        '-projectPath',
        this.temporaryProject,
        '-executeMethod',
        'APVG.Editor.ApvgRecorder.Run',
        '-apvgPlan',
        planPath,
        '-logFile',
        '-',
      ],
      this.target.timeoutSeconds * 1000 * Math.max(1, this.jobs.length),
      logPath
    );

    // Encode one scene at a time to avoid several CPU-heavy FFmpeg processes
    // competing for the same GitHub Actions runner.
    for (const job of this.jobs) {
      const staged = join(stagedOutputDir, `${basename(job.finalOutput, '.mp4')}.webm`);
      const stagedSize = existsSync(staged) ? (await stat(staged)).size : 0;
      if (stagedSize === 0) {
        throw new Error(`Unity Recorder did not create ${staged}. See ${logPath}.`);
      }
      logger.step('record:unity', `Converting ${basename(staged)} -> ${basename(job.finalOutput)}`);
      await convertVideo(staged, job.finalOutput, {
        ffmpegPath: resolveFfmpegPath(),
        format: 'mp4',
        overwrite: true,
      });
      logger.success(`Saved: ${job.finalOutput}`);
    }
  }

  async dispose(): Promise<void> {
    if (!this.temporaryProject) return;
    try {
      await rm(this.temporaryProject, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 250,
      });
    } catch (error) {
      logger.warn(
        `Could not remove temporary Unity project yet: ${(error as Error).message}. ` +
          'The OS temporary directory can remove it later.'
      );
    }
    this.temporaryProject = undefined;
  }
}

async function copyUnityProject(sourceRoot: string, destination: string): Promise<void> {
  const resolvedSource = resolve(sourceRoot);
  const resolvedDestination = resolve(destination);
  if (
    resolvedDestination === resolvedSource ||
    resolvedDestination.startsWith(`${resolvedSource}${sep}`)
  ) {
    // The destination itself is excluded below, but placing a recursive copy
    // inside the source is unnecessarily risky and expensive.
    throw new Error(
      `Unity recording workDir must be outside the Unity project: ${resolvedDestination}`
    );
  }
  await rm(resolvedDestination, { recursive: true, force: true });
  await cp(resolvedSource, resolvedDestination, {
    recursive: true,
    filter: (source) => {
      const rel = relative(resolvedSource, source);
      if (!rel) return true;
      const topLevel = rel.split(sep)[0];
      if (COPY_EXCLUDES.has(topLevel)) return false;
      if (/^Assets[\\/]APVGGenerated(?:-|[\\/])/.test(rel)) return false;
      return true;
    },
  });
}

export async function resolveUnityEditorPath(
  projectRoot: string,
  configured?: string
): Promise<string> {
  const explicit = configured || process.env.UNITY_EDITOR_PATH;
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`Unity Editor executable not found: ${path}`);
    return path;
  }
  const versionFile = join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt');
  const versionText = await readFile(versionFile, 'utf8');
  const version = versionText.match(/^m_EditorVersion:\s*(\S+)/m)?.[1];
  if (!version) throw new Error(`Could not read the Unity version from ${versionFile}.`);
  const candidates = unityEditorCandidates(version);
  const found = candidates.find(existsSync);
  if (found) return found;
  throw new Error(
    `Unity Editor ${version} was not found. Set target.unity.editorPath or UNITY_EDITOR_PATH. ` +
      `Checked: ${candidates.join(', ')}`
  );
}

export function unityEditorCandidates(version: string): string[] {
  switch (process.platform) {
    case 'win32':
      return [join('C:\\Program Files\\Unity\\Hub\\Editor', version, 'Editor', 'Unity.exe')];
    case 'darwin':
      return [join('/Applications/Unity/Hub/Editor', version, 'Unity.app/Contents/MacOS/Unity')];
    default:
      return [join('/opt/unity/editors', version, 'Editor', 'Unity')];
  }
}

function assertUnityProject(root: string): void {
  for (const required of ['Assets', 'Packages', 'ProjectSettings/ProjectVersion.txt']) {
    if (!existsSync(join(root, ...required.split('/')))) {
      throw new Error(`Not a Unity project (missing ${required}): ${root}`);
    }
  }
}

export async function ensureUnityRecorderPackage(
  projectRoot: string,
  unityVersion: string
): Promise<void> {
  const manifestPath = join(projectRoot, 'Packages', 'manifest.json');
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
  } catch (error) {
    throw new Error(
      `Could not read Unity package manifest ${manifestPath}: ${(error as Error).message}`
    );
  }
  manifest.dependencies ??= {};
  if (manifest.dependencies['com.unity.recorder']) return;

  const recorderVersion = unityRecorderPackageVersion(unityVersion);
  manifest.dependencies['com.unity.recorder'] = recorderVersion;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  logger.info(
    `Added com.unity.recorder ${recorderVersion} to the isolated recording project for Unity ${unityVersion}.`
  );
}

export function unityRecorderPackageVersion(unityVersion: string): string {
  const major = Number.parseInt(unityVersion.split('.')[0], 10);
  if (!Number.isFinite(major)) {
    throw new Error(
      `Could not determine a compatible Unity Recorder version for Unity ${unityVersion}.`
    );
  }
  if (major >= 6000) return '5.1.3';
  if (major >= 2023) return '5.0.0';
  if (major >= 2022) return '4.0.1';
  if (major >= 2021) return '3.0.3';
  if (major >= 2020) return '2.5.7';
  return '2.0.3-preview.1';
}

function resolveUnityVersion(editorPath: string, projectRoot: string): string {
  const installedVersion = editorPath
    .replaceAll('\\', '/')
    .match(/\/Hub\/Editor\/([^/]+)\//)?.[1];
  if (installedVersion) return installedVersion;
  const versionText = readFileSync(
    join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'),
    'utf8'
  );
  const projectVersion = versionText.match(/^m_EditorVersion:\s*(\S+)/m)?.[1];
  if (!projectVersion) throw new Error('Could not determine the Unity Editor version.');
  return projectVersion;
}

function runUnity(
  command: string,
  args: string[],
  timeoutMs: number,
  logPath: string
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const logStream = createWriteStream(logPath, { flags: 'a' });
    let stderr = '';
    let recentOutput = '';
    let recorderInitialized = false;
    let recordingsCompleted = false;
    let forcedExitTimer: NodeJS.Timeout | undefined;
    const startupTimer = setTimeout(
      () => {
        if (recorderInitialized) return;
        child.kill();
        reject(
          new Error(
            `Unity Editor did not invoke APVG.Editor.ApvgRecorder.Run within 900s. ` +
              `Check compiler, Package Manager, licensing, or startup errors above and in ${logPath}.`
          )
        );
      },
      Math.min(timeoutMs, 900_000)
    );
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      logStream.write(text);
      process.stdout.write(text);
      const combinedOutput = recentOutput + text;
      recentOutput = combinedOutput.slice(-512);
      if (!recorderInitialized && combinedOutput.includes('APVG_RECORDER_INITIALIZED')) {
        recorderInitialized = true;
        clearTimeout(startupTimer);
      }
      if (!recordingsCompleted && combinedOutput.includes('APVG_RECORDINGS_COMPLETE')) {
        recordingsCompleted = true;
        // All output files have been finalized. Do not let an Editor process
        // that ignores EditorApplication.Exit keep CI blocked indefinitely.
        forcedExitTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill();
        }, 5000);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      logStream.write(text);
      process.stderr.write(text);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Unity Recorder timed out after ${timeoutMs / 1000}s. See ${logPath}.`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(startupTimer);
      reject(new Error(`Could not start Unity Editor '${command}': ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(startupTimer);
      if (forcedExitTimer) clearTimeout(forcedExitTimer);
      logStream.end();
      if (code === 0 || recordingsCompleted) resolvePromise();
      else
        reject(
          new Error(`Unity Recorder exited with code ${code}: ${stderr.trim()}\nSee ${logPath}.`)
        );
    });
  });
}

function resolveUnityEditorAsset(): URL {
  const packaged = new URL('./unity/Assets/APVG/Editor/ApvgRecorder.cs', import.meta.url);
  if (existsSync(packaged)) return packaged;
  const workspace = new URL('../unity/Assets/APVG/Editor/ApvgRecorder.cs', import.meta.url);
  if (existsSync(workspace)) return workspace;
  throw new Error('The packaged APVG Unity Editor integration could not be found.');
}
