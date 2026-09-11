import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ScoreManager, traceBaseForDifficulty } from '../src/game/score';
import { startPreview } from '../src/audio/preview';

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('trace base points by difficulty (harder earns more)', () => {
  it('maps levels 1..5 to base 1,3,4,5,8', () => {
    expect([1, 2, 3, 4, 5].map(traceBaseForDifficulty)).toEqual([1, 3, 4, 5, 8]);
  });

  it('clamps out-of-range levels and falls back for non-finite input', () => {
    expect(traceBaseForDifficulty(0)).toBe(1);
    expect(traceBaseForDifficulty(9)).toBe(8);
    expect(traceBaseForDifficulty(NaN)).toBe(4);
    expect(traceBaseForDifficulty(2.4)).toBe(3);
    expect(traceBaseForDifficulty(2.6)).toBe(4);
  });

  it('recordTrace tick scores base + comboBonus (EXTRA base 8)', () => {
    const m = new ScoreManager(traceBaseForDifficulty(5));
    m.recordTrace(0.15, true, 500);
    expect(m.getStats().score).toBe(8);
  });

  it('recordTrace tick scores base + comboBonus (EASY base 1)', () => {
    const m = new ScoreManager(traceBaseForDifficulty(1));
    m.recordTrace(0.15, true, 500);
    expect(m.getStats().score).toBe(1);
  });

  it('default constructor keeps the legacy base 2', () => {
    const m = new ScoreManager();
    m.recordTrace(0.15, true, 500);
    expect(m.getStats().score).toBe(2);
  });

  it('GameScreen resolves difficulty and wires it into ScoreManager', () => {
    const src = readSrc('src/screens/GameScreen.tsx');
    expect(src).toMatch(/new ScoreManager\(traceBaseForDifficulty\(difficultyRef\.current\)\)/);
    expect(src).toMatch(/resolvedDifficulty = stored\.difficulty/);
    expect(src).toMatch(/resolvedDifficulty = song\.difficulty/);
    expect(src).toMatch(/difficultyRef\.current = resolvedDifficulty \?\? 3/);
  });
});

describe('hover preview start offset', () => {
  function stubCtx() {
    const calls: { when: number; offset: number }[] = [];
    const source = {
      buffer: null as unknown as AudioBuffer,
      connect() {},
      start(when: number, offset: number) {
        calls.push({ when, offset });
      },
      stop() {},
      disconnect() {},
    };
    const gainNode = { gain: { value: 0 }, connect() {}, disconnect() {} };
    const ctx = {
      currentTime: 1.5,
      destination: {},
      createBufferSource: () => source,
      createGain: () => gainNode,
    };
    return { ctx: ctx as unknown as AudioContext, calls };
  }

  it('starts playback at the given offset', () => {
    const { ctx, calls } = stubCtx();
    const handle = startPreview({ duration: 120 } as AudioBuffer, ctx, 0.2, 30);
    expect(calls).toHaveLength(1);
    expect(calls[0].offset).toBe(30);
    handle.stop();
  });

  it('clamps negative offsets to 0 and over-duration offsets to duration-0.1', () => {
    const a = stubCtx();
    startPreview({ duration: 120 } as AudioBuffer, a.ctx, 0.2, -5);
    expect(a.calls[0].offset).toBe(0);
    const b = stubCtx();
    startPreview({ duration: 120 } as AudioBuffer, b.ctx, 0.2, 500);
    expect(b.calls[0].offset).toBeCloseTo(119.9, 9);
  });

  it('defaults to 0 and tolerates NaN', () => {
    const a = stubCtx();
    startPreview({ duration: 120 } as AudioBuffer, a.ctx);
    expect(a.calls[0].offset).toBe(0);
    const b = stubCtx();
    startPreview({ duration: 120 } as AudioBuffer, b.ctx, 0.2, NaN);
    expect(b.calls[0].offset).toBe(0);
  });

  it('SelectScreen exposes a debug-only offset input persisted to localStorage', () => {
    const src = readSrc('src/screens/SelectScreen.tsx');
    expect(src).toContain('data-testid="preview-offset-input"');
    expect(src).toContain('rhythmPreviewOffsetSec');
    // Public mode forces offset 0; debug uses the saved value.
    expect(src).toMatch(/getViewMode\(\) === 'debug' \? previewOffsetRef\.current : 0/);
  });
});
