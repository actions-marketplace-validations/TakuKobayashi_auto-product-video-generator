import { Command } from 'commander';

export function recordCommand(): Command {
  return new Command('record')
    .description('Record interactions using the recorder selected for the detected platform')
    .option('-c, --config <path>', 'path to apvg.config.yml', 'apvg.config.yml')
    .option('--scenario <path>', 'scenario YML input (default: <workDir>/scenario.yml)')
    .option('--script <path>', 'timed script YML input (default: <workDir>/script.yml)')
    .option('--voice-dir <path>', 'WAV input directory (default: <workDir>/voice)')
    .option('--recordings-dir <path>', 'MP4 output directory (default: <workDir>/recordings)')
    .option(
      '--screenshots-dir <path>',
      'screenshot output directory (default: <workDir>/screenshots)'
    )
    .option('--source-dir <path>', 'source clone/cache directory (default: <workDir>/source-repo)')
    .option('--env-file <path>', 'environment file to convert and place in the selected project')
    .option(
      '--server-log <path>',
      'development server log output (default: <workDir>/dev-server.log)'
    )
    .option('-s, --scene <id>', 'record a specific scene only')
    .option('--headed', 'show the browser window during recording')
    .option('--slow-mo <ms>', 'slow down each action by N milliseconds', '0')
    .option('--no-screenshots', 'skip automatic per-scene screenshots')
    .option('--dry-run', 'validate the recording plan without launching a browser or device')
    .action(async (options: Record<string, string | boolean>) => {
      const { runRecord } = await import('../runners/record.js');
      await runRecord(options);
    });
}
