import { join, resolve } from 'node:path';
import { loadConfig, logger, resolveFfmpegPath } from '@auto-product-video-generator/core';
import { convertVideos } from '@auto-product-video-generator/renderer';

interface ConvertOptions {
  config?: string;
  inputDir?: string;
  outputDir?: string;
  format?: string;
  ffmpeg?: string;
  recursive?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
}

export async function runConvert(options: ConvertOptions): Promise<void> {
  logger.header('apvg video convert');
  const config = await loadConfig(options.config || 'apvg.config.yml');
  const format = options.format || 'mp4';
  if (format !== 'mp4' && format !== 'webm') {
    throw new Error(`Unsupported output format '${format}'. Use mp4 or webm.`);
  }
  const inputDir = resolve(options.inputDir || join(config.output.workDir, 'recordings'));
  const outputDir = resolve(options.outputDir || inputDir);
  logger.info(`Input:     ${inputDir}`);
  logger.info(`Output:    ${outputDir}`);
  logger.info(`Format:    ${format}`);

  const outputs = await convertVideos({
    inputDir,
    outputDir,
    format,
    ffmpegPath: resolveFfmpegPath(options.ffmpeg),
    recursive: options.recursive || false,
    overwrite: options.overwrite || false,
    dryRun: options.dryRun || false,
  });
  logger.success(`${outputs.length} video file(s) converted.`);
}
