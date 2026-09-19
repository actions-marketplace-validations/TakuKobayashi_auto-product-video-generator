import { Command } from 'commander';

export function exportCommand(): Command {
  const command = new Command('export').description(
    'Export completed video assets to an editable project'
  );

  command.addCommand(
    new Command('remotion')
      .description('Export an independent Node.js + TypeScript Remotion project')
      .option('-c, --config <path>', 'path to apvg.config.yml', 'apvg.config.yml')
      .option('--timeline <path>', 'timeline JSON input (default: <workDir>/timeline.json)')
      .option(
        '-o, --output <dir>',
        'project output directory (default: <outputDir>/remotion-project)'
      )
      .option('--force', 'overwrite generated files when the output directory is not empty')
      .action(async (options: Record<string, string | boolean>) => {
        const { runExportRemotion } = await import('../runners/export-remotion.js');
        await runExportRemotion(options);
      })
  );

  return command;
}
