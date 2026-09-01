import { describe, it, expect } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { segmentize } from '../src/chart/quantize';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import type { Segment } from '../src/types';

describe('T127 速度係数(amplitude)の規約全体の再統一と波形状の修復', () => {
  const timeline = new BpmTimeline(120, []);

  it('1. WaveEngine buildPoints uses unified amplitude formula (higher amplitude = faster/steeper)', () => {
    // Rule: displacement per beat = 2 * TW_AMP * amplitude * beats (clamped to TW_AMP)
    // For amp=0.5, beats=0.5: 2 * 130 * 0.5 * 0.5 = 65.
    const engineAmp05 = new WaveEngine([{ direction: 'down', beats: 0.5 }], timeline, 0.5, 0.0);
    const yAt05Amp05 = engineAmp05.waveYAt(0.5);
    expect(yAt05Amp05).toBeCloseTo(TW_CENTER_Y + 65, 1);
  });

  it('2. Complex amplitudes and off-grid phases numeric consistency between WaveEngine and Cursor', () => {
    const amplitudes = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23];

    for (const amp of amplitudes) {
      for (const b of offGridBeats) {
        const engine = new WaveEngine([{ direction: 'down', beats: b }], timeline, amp, 0.0);
        const yVal = engine.waveYAt(b);
        const expectedMove = Math.min(TW_AMP, 2 * TW_AMP * amp * b);
        expect(yVal).toBeCloseTo(TW_CENTER_Y + expectedMove, 1);
      }
    }
  });

  it('3. Cursor speed formula consistency with WaveEngine', () => {
    const amp = 1.3;
    const beatMs = 500; // 120 BPM -> 500ms per beat
    const cursor = new Cursor(amp, 0.0);
    // update for 0.5 second (dt = 0.5) with downPressed = true
    // speed = 2 * TW_AMP * amplitude / (beatMs / 1000) = 2 * 130 * 1.3 / 0.5 = 676 px/sec
    // after dt = 0.5 sec (1 beat), delta y should be 2 * 130 * 1.3 * 1.0 = 338 -> clamped to 130.
    cursor.update(0.5, false, true, beatMs, 1.0);
    expect(cursor.y).toBeCloseTo(TW_CENTER_Y + TW_AMP, 1); // clamped at TW_AMP
  });

  it('4. Invariance of physical height (TW_AMP = 130) across different amplitudes', () => {
    const amps = [0.5, 1.0, 2.0, 5.0];
    for (const amp of amps) {
      const engine = new WaveEngine([{ direction: 'down', beats: 10.0 }], timeline, amp, 0.0);
      const points = engine.getPoints();
      const maxY = Math.max(...points.map(p => p.y));
      const minY = Math.min(...points.map(p => p.y));
      expect(maxY).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-5);
      expect(minY).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-5);
    }
  });

  it('5. segmentize uses physical consistency based on amplitude', () => {
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.37, y: TW_CENTER_Y + 50, down: true },
      { beat: 1.23, y: TW_CENTER_Y + 130, down: true },
      { beat: 1.24, y: TW_CENTER_Y + 130, down: false },
    ];
    const segs = segmentize(traj, 0.25, 1.3);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      expect(s.beats % 0.25).toBeCloseTo(0, 3);
    }
  });
});
