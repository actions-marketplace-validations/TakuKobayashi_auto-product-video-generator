import { Command } from 'commander';

export function initCommand(): Command {
  return new Command('init')
    .description(
      'Initialize a new auto-product-video-generator project from a git-managed source project'
    )
    .argument('[directory]', 'target directory for apvg.config.yml', '.')
    .option(
      '--repo <url>',
      'git repository URL to clone and analyze (e.g. https://github.com/user/repo.git)'
    )
    .option('--source <path>', 'path to an existing local git project to analyze')
    .option(
      '--ref <ref>',
      'git branch/tag/commit to check out (only with --repo; defaults to the default branch)'
    )
    .option('--project-path <path>', 'monorepo application path; normally detected automatically')
    .option(
      '--platform-priority <types>',
      'monorepo platform order, comma-separated (default: web first)'
    )
    .option(
      '--serve-command <cmd>',
      'command to auto-start the app\'s dev server (e.g. "npm run dev"). ' +
        'If omitted, `analyze` will try to detect one from package.json and save it for you.'
    )
    .option(
      '--install-deps',
      'run npm install in the cloned/local project before starting the dev server'
    )
    .option(
      '-u, --url <url>',
      'URL where the app runs; omitted means infer a local URL during analyze'
    )
    .option('-t, --type <type>', 'video type: teaser|shorts|demo|tutorial', 'demo')
    .option('-n, --name <name>', 'project name')
    .option('--android-package <id>', 'Android application id to launch and record with adb')
    .option('--android-activity <name>', 'optional Android launch activity')
    .option('--android-serial <serial>', 'optional adb device/emulator serial')
    .option('--android-avd <name>', 'AVD to start when no Android device is connected')
    .option('--android-apk <path>', 'existing APK path relative to the source project')
    .option('--android-build-command <command>', 'custom command that builds an Android APK')
    .option(
      '--android-sdk <path>',
      'Android SDK root (otherwise ANDROID_SDK_ROOT/ANDROID_HOME/PATH)'
    )
    .option('--unity-editor <path>', 'path to the Unity Editor executable')
    .option(
      '--unity-scenes <paths>',
      'comma-separated Unity scene paths (default: Build Settings or auto-discovered scenes)'
    )
    .option('--force', 'overwrite an existing apvg.config.yml')
    .option('--dry-run', 'preview config without writing files')
    .action(async (directory: string, options: Record<string, string | boolean>) => {
      const { runInit } = await import('../runners/init.js');
      await runInit(directory, options);
    });
}
