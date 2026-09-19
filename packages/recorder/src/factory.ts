import {
  UnityConfigSchema,
  type ApvgConfig,
  type ProjectPlatform,
  type SetupStep,
} from '@auto-product-video-generator/core';
import { SceneRecorder } from '@auto-product-video-generator/playwright';
import { AndroidRecorder } from './android-recorder.js';
import { CliRecorder } from './cli-recorder.js';
import { UnityRecorder } from './unity-recorder.js';
import type { PlatformRecorder } from './types.js';

export interface RecorderFactoryOptions {
  rootDir?: string;
  repositoryRoot?: string;
  workDir: string;
  setupSteps?: SetupStep[];
  sourceExcludePatterns?: string[];
}

export function isAndroidRecordingPlatform(platform: ProjectPlatform): boolean {
  switch (platform) {
    case 'android':
    case 'flutter':
    case 'react-native':
      return true;
    default:
      return false;
  }
}

export function createPlatformRecorder(
  platform: ProjectPlatform,
  config: ApvgConfig,
  options: RecorderFactoryOptions
): PlatformRecorder {
  switch (platform) {
    case 'web':
      return new SceneRecorder();
    case 'cli':
      return new CliRecorder(config.target.cli, {
        rootDir: options.rootDir,
        repositoryRoot: options.repositoryRoot,
        setupSteps: options.setupSteps || [],
        sourceExcludePatterns: options.sourceExcludePatterns || [],
      });
    case 'android':
    case 'flutter':
    case 'react-native':
      return new AndroidRecorder(config.target.android || {}, options);
    case 'unity':
      return new UnityRecorder(UnityConfigSchema.parse(config.target.unity || {}), options);
    default:
      throw new Error(
        `Recording platform '${platform}' is not implemented yet. ` +
          'Currently supported: web, CLI, Android, Flutter/React Native, and Unity Recorder.'
      );
  }
}
