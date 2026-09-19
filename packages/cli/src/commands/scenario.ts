import { Command } from 'commander';

export function scenarioCommand(): Command {
  const cmd = new Command('scenario').description('Scenario management commands');

  cmd
    .command('generate')
    .description('Generate scenario.yml and script.yml via AI')
    .option('-c, --config <path>', 'path to apvg.config.yml', 'apvg.config.yml')
    .option('-t, --type <type>', 'override video type: teaser|shorts|demo|tutorial')
    .option('--prompt <text>', 'additional narration style or character direction')
    .option(
      '--project-summary <path>',
      'project summary JSON input (default: <workDir>/project-summary.json)'
    )
    .option('--scenario <path>', 'scenario YML output (default: <workDir>/scenario.yml)')
    .option('--script <path>', 'script YML output (default: <workDir>/script.yml)')
    .option('--subtitles <path>', 'SRT subtitles output (default: <workDir>/subtitles.srt)')
    .option('--force', 'overwrite existing scenario.yml')
    .option('--dry-run', 'preview scenario without saving')
    .action(async (options: Record<string, string | boolean>) => {
      const { runScenarioGenerate } = await import('../runners/scenario.js');
      await runScenarioGenerate(options);
    });

  cmd
    .command('validate')
    .description('Validate an existing scenario.yml against the schema')
    .argument('[file]', 'scenario file path', '.apvg/scenario.yml')
    .action(async (file: string) => {
      const { runScenarioValidate } = await import('../runners/scenario.js');
      await runScenarioValidate(file);
    });

  return cmd;
}
