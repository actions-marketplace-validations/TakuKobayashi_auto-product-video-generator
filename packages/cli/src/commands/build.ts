import { Command } from 'commander';

export function buildCommand(name = 'build'): Command {
  return new Command(name)
    .description('Run the full pipeline: analyze → scenario → voice → record → render')
    .option('-c, --config <path>', 'path to apvg.config.yml', 'apvg.config.yml')
    .option('-t, --type <type>', 'video type: teaser|shorts|demo|tutorial', 'demo')
    .option('-u, --url <url>', 'target application URL (overrides config)')
    .option('--scenario-prompt <text>', 'additional narration style or character direction')
    .option('--env-file <path>', 'environment file to convert and place in the selected project')
    .option('--skip-analyze', 'skip analyze step (use existing project-summary.json)')
    .option('--skip-scenario', 'skip scenario generation (use existing scenario.yml)')
    .option('--skip-record', 'skip recording (use existing recordings)')
    .option('--skip-voice', 'skip voice generation (use existing wav files)')
    .option('--no-subtitles', 'skip subtitle overlay in final render')
    .option('--no-screenshots', 'skip automatic per-scene screenshots')
    .option('--preview', 'render a fast low-quality preview')
    .option('--headed', 'show browser during recording')
    .option('--dry-run', 'dry-run all steps')
    .action(async (options: Record<string, string | boolean>) => {
      const { runBuild } = await import('../runners/build.js');
      await runBuild(options);
    });
}
