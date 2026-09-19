import { describe, expect, it } from 'vitest';
import { buildConvertArguments } from './converter.js';

describe('buildConvertArguments', () => {
  it('normalizes arbitrary video material to H.264/AAC MP4', () => {
    const args = buildConvertArguments('scene.webm', 'scene.mp4', 'mp4', true);
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args.at(-1)).toBe('scene.mp4');
  });

  it('can normalize material to VP9/Opus WebM', () => {
    const args = buildConvertArguments('scene.mov', 'scene.webm', 'webm', false);
    expect(args[0]).toBe('-n');
    expect(args).toContain('libvpx-vp9');
    expect(args).toContain('libopus');
  });
});
