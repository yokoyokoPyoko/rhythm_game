/**
 * @vitest-environment node
 * T163 Unit Tests: Cursor continuous snap (pull towards wave value every tick).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Cursor } from '../src/game/cursor';
import { WaveEngine, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';

describe('T163: Cursor continuous snap (pull towards wave every tick)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should continuously pull cursor towards nowWaveY every update tick with PULL_STRENGTH 0.04-0.05 (3-step)', () => {
    // [Step1] Capture initial state
    const cursor = new Cursor(1.0, 0);
    cursor.y = 200; // arbitrary initial position
    const initialY = cursor.y;
    const nowWaveY = 300;

    // [Step2] Perform update tick with nowWaveY argument
    // cursor.update(dt, upPressed, downPressed, beatMs, nowWaveY)
    cursor.update(0.016, false, false, 500, nowWaveY);

    // [Step3] Assert resulting transition: cursor.y should move towards nowWaveY by PULL_STRENGTH (0.04 - 0.05)
    const expectedDelta = (nowWaveY - initialY);
    const pulledY = initialY + expectedDelta * 0.045; // midpoint of 0.04 and 0.05
    expect(cursor.y).toBeGreaterThan(initialY);
    expect(cursor.y).toBeLessThan(nowWaveY);
    expect(cursor.y).toBeCloseTo(pulledY, 1);
  });

  it('should apply continuous snap immediately after up/down key operation (off-grid fractional timing & complex amplitude)', () => {
    // [Step1] Initial state with complex amplitude (e.g. 1.3)
    const amp = 1.3;
    const cursor = new Cursor(amp, 0);
    cursor.y = 250;
    const initialY = cursor.y;
    const nowWaveY = 200;
    const beatMs = 450; // off-grid beat ms

    // [Step2] Perform update with upPressed = true (movement + continuous snap)
    cursor.update(0.033, true, false, beatMs, nowWaveY);

    // [Step3] Assert transition: movement and snap are combined
    expect(cursor.y).toBeLessThan(initialY);
  });

  it('should smoothly pull cursor across multiple consecutive update ticks monotonically towards waveY', () => {
    // [Step1] Initial state far from waveY
    const cursor = new Cursor(1.0, 0);
    cursor.y = 150;
    const nowWaveY = 350;

    const positions: number[] = [cursor.y];

    // [Step2] Run 5 consecutive updates
    for (let i = 0; i < 5; i++) {
      cursor.update(0.016, false, false, 500, nowWaveY);
      positions.push(cursor.y);
    }

    // [Step3] Assert monotonic approach to nowWaveY
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
      expect(positions[i]).toBeLessThanOrEqual(nowWaveY);
    }
  });
});
