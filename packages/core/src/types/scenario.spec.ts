import { describe, expect, it } from 'vitest';
import { ActionSchema, SceneSchema } from './scenario.js';

describe('narration emotion', () => {
  it('accepts a valid AI Talk style and rejects a total over 1', () => {
    const scene = { id: 'intro', title: 'Intro', narration: 'Hello', actions: [] };
    expect(SceneSchema.parse({ ...scene, emotion: { j: 0.7, s: 0.1, a: 0.2 } }).emotion).toEqual({
      j: 0.7,
      s: 0.1,
      a: 0.2,
    });
    expect(() => SceneSchema.parse({ ...scene, emotion: { j: 0.7, s: 0.3, a: 0.2 } })).toThrow(
      /total 1.0 or less/
    );
  });
});

describe('device actions', () => {
  it('accepts Android actions used by generated scenarios', () => {
    expect(ActionSchema.parse({ type: 'launch_app' })).toEqual({ type: 'launch_app' });
    expect(ActionSchema.parse({ type: 'tap', text: 'はじめる' })).toMatchObject({ type: 'tap' });
    expect(
      ActionSchema.parse({
        type: 'swipe',
        fromX: 540,
        fromY: 1500,
        toX: 540,
        toY: 500,
      })
    ).toMatchObject({ type: 'swipe', durationMs: 400 });
  });

  it('rejects an unlocatable tap', () => {
    expect(() => ActionSchema.parse({ type: 'tap' })).toThrow(/tap requires/);
  });
});

describe('CLI actions', () => {
  it('accepts a non-empty command', () => {
    expect(ActionSchema.parse({ type: 'run_command', command: 'apvg --help' })).toEqual({
      type: 'run_command',
      command: 'apvg --help',
    });
  });

  it('rejects an empty command', () => {
    expect(() => ActionSchema.parse({ type: 'run_command', command: '' })).toThrow();
  });
});
