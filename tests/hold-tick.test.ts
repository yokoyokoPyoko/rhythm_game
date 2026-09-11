import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOLD_TICK_BEATS, HOLD_TICK_SCORE, ScoreManager } from '../src/game/score';

function bonusOf(m: ScoreManager): number {
  return (m as unknown as { comboBonus: number }).comboBonus;
}

describe('hold tick scoring (combo + fixed score every 0.5 beats while holding)', () => {
  it('0.5 beats of holding grants combo+1 and +5 score (BPM120)', () => {
    const m = new ScoreManager();
    const beatMs = 500; // 120bpm
    m.recordHold(0.25, beatMs, true); // 0.25s = 0.5 beats
    expect(m.getStats().combo).toBe(1);
    expect(m.getStats().maxCombo).toBe(1);
    expect(m.getStats().score).toBe(HOLD_TICK_SCORE);
  });

  it('fractional beats carry over; holding=false resets the accumulator', () => {
    const m = new ScoreManager();
    const beatMs = 500;
    m.recordHold(0.1, beatMs, true); // 0.2 beats
    m.recordHold(0.1, beatMs, true); // 0.4 beats total — no tick yet
    expect(m.getStats().combo).toBe(0);
    expect(m.getStats().score).toBe(0);
    m.recordHold(0.1, beatMs, false); // hold ended — accumulator reset
    m.recordHold(0.1, beatMs, true); // 0.2 beats fresh — still no tick
    expect(m.getStats().combo).toBe(0);
    expect(m.getStats().score).toBe(0);
  });

  it('multiple ticks in one long frame each grant combo+1 (1.5 beats -> 3 ticks)', () => {
    const m = new ScoreManager();
    const beatMs = 500;
    m.recordHold(0.75, beatMs, true); // 1.5 beats
    expect(m.getStats().combo).toBe(3);
    expect(m.getStats().score).toBe(3 * HOLD_TICK_SCORE);
  });

  it('beat conversion follows BPM changes (240bpm: 0.125s = 0.5 beats)', () => {
    const m = new ScoreManager();
    m.recordHold(0.125, 250, true);
    expect(m.getStats().combo).toBe(1);
    expect(m.getStats().score).toBe(HOLD_TICK_SCORE);
  });

  it('miss resets combo and the hold accumulator', () => {
    const m = new ScoreManager();
    const beatMs = 500;
    m.recordHit('perfect');
    m.recordHold(0.1, beatMs, true); // 0.2 beats banked
    m.recordHit('miss');
    expect(m.getStats().combo).toBe(0);
    m.recordHold(0.1, beatMs, true); // 0.2 beats fresh, not 0.4 — no tick
    expect(m.getStats().combo).toBe(0);
    expect(m.getStats().score).toBe(50); // head perfect only
  });

  it('hold ticks do not touch the trace comboBonus pool', () => {
    const m = new ScoreManager();
    const beatMs = 500;
    m.recordHold(1.0, beatMs, true); // 2 beats -> 4 ticks
    expect(m.getStats().combo).toBe(4);
    expect(bonusOf(m)).toBe(0);
    expect(m.getStats().score).toBe(4 * HOLD_TICK_SCORE);
  });

  it('GameScreen tick calls recordHold with the holding state', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'screens', 'GameScreen.tsx'),
      'utf8',
    );
    expect(src).toMatch(/recordHold\s*\(\s*dt\s*,\s*currentBeatMs\s*,\s*holding\s*\)/);
  });

  it('constants are 0.5 beats and 5 points', () => {
    expect(HOLD_TICK_BEATS).toBe(0.5);
    expect(HOLD_TICK_SCORE).toBe(5);
  });
});
