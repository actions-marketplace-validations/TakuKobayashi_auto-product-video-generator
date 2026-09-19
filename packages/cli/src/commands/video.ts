import { Command } from 'commander';
import { buildCommand } from './build.js';
import { scenarioCommand } from './scenario.js';
import { voiceCommand } from './voice.js';
import { recordCommand } from './record.js';
import { renderCommand } from './render.js';
import { exportCommand } from './export.js';
import { convertCommand } from './convert.js';

export function videoCommand(): Command {
  const command = new Command('video').description(
    'Plan, narrate, record, and render promotional videos'
  );

  command.addCommand(buildCommand('generate'));
  command.addCommand(scenarioCommand());
  command.addCommand(voiceCommand());
  command.addCommand(recordCommand());
  command.addCommand(renderCommand());
  command.addCommand(exportCommand());
  command.addCommand(convertCommand());
  return command;
}
