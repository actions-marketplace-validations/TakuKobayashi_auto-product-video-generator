import { Command } from 'commander';

export function convertCommand(): Command {
  return new Command('convert')
    .description('Batch-convert video material with ffmpeg')
    .option('-c, --config <path>', 'path to apvg.config.yml', 'apvg.config.yml')
    .option('-i, --input-dir <path>', 'input directory (default: <workDir>/recordings)')
    .option('-o, --output-dir <path>', 'output directory (default: input directory)')
    .option('-f, --format <format>', 'output format: mp4 or webm', 'mp4')
    .option('--ffmpeg <path>', 'path to ffmpeg binary', 'ffmpeg')
    .option('--recursive', 'include nested directories')
    .option('--overwrite', 'overwrite existing converted files')
    .option('--dry-run', 'print conversions without executing ffmpeg')
    .action(async (options: Record<string, string | boolean>) => {
      const { runConvert } = await import('../runners/convert.js');
      await runConvert(options);
    });
}
