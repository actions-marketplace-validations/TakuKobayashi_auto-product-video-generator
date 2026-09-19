import { describe, expect, it } from 'vitest';
import {
  buildAndroidNormalizationArguments,
  resolveAndroidRecordingSize,
} from './android-recorder.js';

describe('resolveAndroidRecordingSize', () => {
  it('rotates the configured video size to match the Android display orientation', () => {
    expect(resolveAndroidRecordingSize('1920x1080', '1080x2424')).toBe('1080x1920');
    expect(resolveAndroidRecordingSize('1080x1920', '1080x2424')).toBe('1080x1920');
    expect(resolveAndroidRecordingSize('1920x1080', '2560x1440')).toBe('1920x1080');
  });
});

describe('buildAndroidNormalizationArguments', () => {
  it('extends sparse screenrecord output to the requested scene duration', () => {
    const args = buildAndroidNormalizationArguments('raw.mp4', 'final.mp4', 12.68, 30);
    expect(args).toContain('tpad=stop_mode=clone:stop_duration=13.68');
    expect(args).toContain('12.680');
    expect(args.at(-1)).toBe('final.mp4');
  });
});
