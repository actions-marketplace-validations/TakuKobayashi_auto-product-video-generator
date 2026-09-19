import { describe, expect, it } from 'vitest';
import { buildSceneScreenshotArguments } from './scene-screenshot.js';

describe('buildSceneScreenshotArguments', () => {
  it('extracts one of the final frames as a single PNG', () => {
    expect(
      buildSceneScreenshotArguments(
        'recordings/scene-intro.mp4',
        'screenshots/scene-intro.png'
      )
    ).toEqual([
      '-y',
      '-sseof',
      '-0.1',
      '-i',
      'recordings/scene-intro.mp4',
      '-frames:v',
      '1',
      '-update',
      '1',
      'screenshots/scene-intro.png',
    ]);
  });
});
