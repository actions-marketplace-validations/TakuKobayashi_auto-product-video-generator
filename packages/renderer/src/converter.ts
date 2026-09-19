import { spawn } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { logger } from '@auto-product-video-generator/core';

const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);

export interface ConvertVideosOptions {
  inputDir: string;
  outputDir: string;
  ffmpegPath: string;
  format: 'mp4' | 'webm';
  recursive: boolean;
  overwrite: boolean;
  dryRun: boolean;
}

export interface ConvertVideoOptions {
  ffmpegPath: string;
  format: 'mp4' | 'webm';
  overwrite: boolean;
}

/** Normalize one video file. Used by recorders that emit an intermediate format. */
export async function convertVideo(
  input: string,
  output: string,
  options: ConvertVideoOptions
): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  await runFfmpeg(
    options.ffmpegPath,
    buildConvertArguments(input, output, options.format, options.overwrite)
  );
}

export async function convertVideos(options: ConvertVideosOptions): Promise<string[]> {
  const inputDir = resolve(options.inputDir);
  const outputDir = resolve(options.outputDir);
  const files = await collectVideoFiles(inputDir, options.recursive);
  const outputs: string[] = [];

  for (const input of files) {
    const rel = relative(inputDir, input);
    const output = resolve(
      outputDir,
      dirname(rel),
      `${basename(rel, extname(rel))}.${options.format}`
    );
    if (resolve(input) === output) {
      logger.dim(`Already ${options.format}: ${input}`);
      continue;
    }
    if (!options.overwrite && (await fileExists(output))) {
      logger.dim(`Skipped existing: ${output}`);
      continue;
    }

    const args = buildConvertArguments(input, output, options.format, options.overwrite);
    if (options.dryRun) {
      logger.dryRun([options.ffmpegPath, ...args].join(' '));
    } else {
      logger.step('convert', `${input} -> ${output}`);
      await convertVideo(input, output, options);
      logger.success(`Converted: ${output}`);
    }
    outputs.push(output);
  }
  return outputs;
}

export function buildConvertArguments(
  input: string,
  output: string,
  format: 'mp4' | 'webm',
  overwrite: boolean
): string[] {
  const args = [overwrite ? '-y' : '-n', '-i', input, '-map', '0:v:0', '-map', '0:a?'];
  switch (format) {
    case 'mp4':
      args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p');
      args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
      break;
    case 'webm':
      args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
      args.push('-c:a', 'libopus', '-b:a', '128k');
      break;
  }
  args.push(output);
  return args;
}

async function collectVideoFiles(root: string, recursive: boolean): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && recursive) files.push(...(await collectVideoFiles(path, true)));
    else if (entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      files.push(path);
  }
  return files.sort();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function runFfmpeg(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-4000)}`));
    });
  });
}
