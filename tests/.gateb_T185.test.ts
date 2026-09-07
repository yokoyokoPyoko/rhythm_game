/**
 * @vitest-environment node
 * T185: 録音カーソルの上下端突き抜け修正（クランプ無条件化）
 * Vitest unit tests (node) — pure engine math, no DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Cursor } from '../src/game/cursor';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';

const WAVE_TOP = TW_CENTER_Y - TW_AMP; // 170
const WAVE_BOTTOM = TW_CENTER_Y + TW_AMP; // 430
const WAVE_CENTER = TW_CENTER_Y; // 300
const PULL = 0.045;

function isClamped(y: number): boolean {
  return y >= WAVE_TOP - 1e-9 && y <= WAVE_BOTTOM + 1e-9;
}

describe('T185: Cursor clamp unconditional (recording overflow fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('1. Recording cursor (without nowWaveY) never escapes [TOP,BOTTOM] even on long hold', () => {
    it('UP hold for 10 seconds stays clamped at TOP (amplitude 1.0, BPM120)', () => {
      // [Step1] Capture initial state — center start, no wave snap argument
      const cursor = new Cursor(1.0, 0);
      expect(cursor.y).toBeCloseTo(WAVE_CENTER, 5);
      const initial = cursor.y;
      expect(isClamped(initial)).toBe(true);

      // [Step2] Perform user interaction — hold UP for many ticks without nowWaveY (recording loop signature)
      const beatMs = 500; // BPM 120
      const dt = 0.016;
      const ticks = Math.ceil(10 / dt); // 10 seconds
      let minY = cursor.y;
      for (let i = 0; i < ticks; i++) {
        // T185: recCursorRef.update(dt, up, down, beatMs) — 4 args, no nowWaveY
        cursor.update(dt, true, false, beatMs);
        minY = Math.min(minY, cursor.y);
      }

      // [Step3] Assert resulting transition — clamped to TOP, never below
      expect(isClamped(cursor.y)).toBe(true);
      expect(cursor.y).toBeCloseTo(WAVE_TOP, 5);
      expect(minY).toBeGreaterThanOrEqual(WAVE_TOP - 1e-9);
    });

    it('DOWN hold for 10 seconds stays clamped at BOTTOM (amplitude 1.0, BPM120)', () => {
      const cursor = new Cursor(1.0, 0);
      expect(cursor.y).toBeCloseTo(WAVE_CENTER, 5);
      const beatMs = 500;
      const dt = 0.016;
      const ticks = Math.ceil(10 / dt);
      let maxY = cursor.y;
      for (let i = 0; i < ticks; i++) {
        cursor.update(dt, false, true, beatMs);
        maxY = Math.max(maxY, cursor.y);
      }
      expect(isClamped(cursor.y)).toBe(true);
      expect(cursor.y).toBeCloseTo(WAVE_BOTTOM, 5);
      expect(maxY).toBeLessThanOrEqual(WAVE_BOTTOM + 1e-9);
    });

    it('UP hold with complex amplitudes 0.7 / 1.3 / 2.7 / 3.4 and off-grid dt stays clamped', () => {
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const dts = [0.037, 0.016, 0.033] as const; // off-grid fractional frame times
      for (const amp of amps) {
        for (const dt of dts) {
          // [Step1]
          const cursor = new Cursor(amp, 0);
          const beatMs = 60000 / 120;
          // [Step2] hold UP for 5 seconds
          const ticks = Math.ceil(5 / dt);
          for (let i = 0; i < ticks; i++) cursor.update(dt, true, false, beatMs);
          // [Step3]
          expect(isClamped(cursor.y)).toBe(true);
          expect(cursor.y).toBeCloseTo(WAVE_TOP, 5);
          // reset and test DOWN
          const cursor2 = new Cursor(amp, 0);
          for (let i = 0; i < ticks; i++) cursor2.update(dt, false, true, beatMs);
          expect(isClamped(cursor2.y)).toBe(true);
          expect(cursor2.y).toBeCloseTo(WAVE_BOTTOM, 5);
        }
      }
    });

    it('startPosition=1.0 (TOP) + DOWN, startPosition=-1.0 (BOTTOM) + UP — clamp still holds', () => {
      // TOP start, go down
      const topCursor = new Cursor(1.0, 1.0);
      expect(topCursor.y).toBeCloseTo(WAVE_TOP, 5);
      for (let i = 0; i < 500; i++) topCursor.update(0.016, false, true, 500);
      expect(isClamped(topCursor.y)).toBe(true);
      expect(topCursor.y).toBeCloseTo(WAVE_BOTTOM, 5);

      // BOTTOM start, go up
      const botCursor = new Cursor(1.0, -1.0);
      expect(botCursor.y).toBeCloseTo(WAVE_BOTTOM, 5);
      for (let i = 0; i < 500; i++) botCursor.update(0.016, true, false, 500);
      expect(isClamped(botCursor.y)).toBe(true);
      expect(botCursor.y).toBeCloseTo(WAVE_TOP, 5);
    });

    it('off-grid beatMs (e.g. BPM 137) with long hold still clamped', () => {
      const cursor = new Cursor(2.0, 0);
      const beatMs = 60000 / 137; // ~438ms off-grid
      const dt = 0.023; // fractional
      for (let i = 0; i < 800; i++) cursor.update(dt, true, false, beatMs);
      expect(isClamped(cursor.y)).toBe(true);
      expect(cursor.y).toBeCloseTo(WAVE_TOP, 5);
      const cursor2 = new Cursor(2.0, 0);
      for (let i = 0; i < 800; i++) cursor2.update(dt, false, true, beatMs);
      expect(isClamped(cursor2.y)).toBe(true);
      expect(cursor2.y).toBeCloseTo(WAVE_BOTTOM, 5);
    });
  });

  describe('2. Clamp is unconditional — snap (nowWaveY) not required for clamping, and snap is not applied without it', () => {
    it('without nowWaveY, movement is purely speed*dt clamped (no hidden snap pull)', () => {
      // [Step1] Capture initial state
      const cursor = new Cursor(1.0, 0);
      cursor.y = WAVE_CENTER;
      const beatMs = 500;
      const dt = 0.016;
      const speed = (2 * TW_AMP * 1.0) / (beatMs / 1000); // 520
      const initialY = cursor.y;

      // [Step2] Single tick UP without nowWaveY
      cursor.update(dt, true, false, beatMs);

      // [Step3] Assert exact clamped movement, no snap
      const expected = Math.max(WAVE_TOP, Math.min(WAVE_BOTTOM, initialY - speed * dt));
      expect(cursor.y).toBeCloseTo(expected, 5);
      // Repeat with DOWN
      const cursor2 = new Cursor(1.0, 0);
      cursor2.y = WAVE_CENTER;
      cursor2.update(dt, false, true, beatMs);
      const expected2 = Math.max(WAVE_TOP, Math.min(WAVE_BOTTOM, WAVE_CENTER + speed * dt));
      expect(cursor2.y).toBeCloseTo(expected2, 5);
    });

    it('with nowWaveY, snap pull is added after clamped movement (single tick precise)', () => {
      // [Step1]
      const cursor = new Cursor(1.0, 0);
      cursor.y = 250;
      const initialY = cursor.y;
      const beatMs = 500;
      const dt = 0.016;
      const speed = (2 * TW_AMP * 1.0) / (beatMs / 1000);
      const nowWaveY = WAVE_BOTTOM; // pull towards bottom
      const delta = -speed * dt; // UP press

      // [Step2] tick with UP + nowWaveY
      cursor.update(dt, true, false, beatMs, nowWaveY);

      // [Step3] Expected = clamp(clamp(initial+delta) + (clampedTarget - clamp(initial+delta))*PULL)
      const afterMove = Math.max(WAVE_TOP, Math.min(WAVE_BOTTOM, initialY + delta));
      const clampedTarget = Math.max(WAVE_TOP, Math.min(WAVE_BOTTOM, nowWaveY));
      const expected = Math.max(WAVE_TOP, Math.min(WAVE_BOTTOM, afterMove + (clampedTarget - afterMove) * PULL));
      expect(cursor.y).toBeCloseTo(expected, 5);
      expect(cursor.y).toBeGreaterThan(afterMove); // pull towards bottom
    });

    it('undefined / NaN nowWaveY does not trigger snap (recording path)', () => {
      const cursorA = new Cursor(1.0, 0);
      cursorA.y = 250;
      cursorA.update(0.016, false, false, 500, undefined as unknown as number);
      const cursorB = new Cursor(1.0, 0);
      cursorB.y = 250;
      cursorB.update(0.016, false, false, 500);
      expect(cursorA.y).toBeCloseTo(cursorB.y, 9);

      const cursorC = new Cursor(1.0, 0);
      cursorC.y = 250;
      cursorC.update(0.016, false, false, 500, NaN);
      expect(cursorC.y).toBeCloseTo(cursorB.y, 9);

      const cursorD = new Cursor(1.0, 0);
      cursorD.y = 250;
      cursorD.update(0.016, false, false, 500, Infinity);
      expect(cursorD.y).toBeCloseTo(cursorB.y, 9);
    });

    it('nowWaveY outside [TOP,BOTTOM] is clamped before snap pull', () => {
      const cursor = new Cursor(1.0, 0);
      cursor.y = WAVE_CENTER;
      // target far above top
      cursor.update(0.016, false, false, 500, WAVE_TOP - 1000);
      // clampedTarget = WAVE_TOP, so pull towards TOP
      // afterMove = CENTER (no key delta), so pull = (TOP - CENTER)*PULL
      const expected = WAVE_CENTER + (WAVE_TOP - WAVE_CENTER) * PULL;
      expect(cursor.y).toBeCloseTo(expected, 4);
      expect(isClamped(cursor.y)).toBe(true);

      const cursor2 = new Cursor(1.0, 0);
      cursor2.y = WAVE_CENTER;
      cursor2.update(0.016, false, false, 500, WAVE_BOTTOM + 1000);
      const expected2 = WAVE_CENTER + (WAVE_BOTTOM - WAVE_CENTER) * PULL;
      expect(cursor2.y).toBeCloseTo(expected2, 4);
      expect(isClamped(cursor2.y)).toBe(true);
    });
  });

  describe('3. Game cursor regression: with nowWaveY (T163) behavior unchanged and still clamped', () => {
    it('game loop tick with nowWaveY matching WaveEngine stays within bounds and snaps correctly', () => {
      // [Step1] Setup waveEngine with time-varying amplitude, cursor at startPosition 0 => CENTER
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 0);
      expect(engine.waveYAt(0)).toBeCloseTo(WAVE_CENTER, 5); // startPosition 0 => center
      const cursor = new Cursor(amp, 0);
      expect(cursor.y).toBeCloseTo(WAVE_CENTER, 5);

      const beatMs = tl.beatMsAt(0);
      // Simulate a few game ticks holding DOWN towards wave that goes down
      let beat = 0;
      const dt = 0.016;
      for (let i = 0; i < 10; i++) {
        beat += dt * 1000 / beatMs; // approximate beat advance (off-grid)
        const nowWaveY = engine.waveYAt(beat);
        const before = cursor.y;
        cursor.update(dt, false, true, tl.beatMsAt(beat), nowWaveY);
        expect(isClamped(cursor.y)).toBe(true);
        // cursor should move towards nowWaveY (which is descending) — monotonic or stable
        void before;
      }
      // After 10 ticks, cursor should have moved down from center but not escaped
      expect(cursor.y).toBeGreaterThan(WAVE_CENTER);
      expect(isClamped(cursor.y)).toBe(true);
    });

    it('game cursor with nowWaveY: short hold difference vs recording cursor (no snap) is ~pull amount', () => {
      // This verifies T163 snap is preserved and that we do not regress game behavior.
      // Use only 3 ticks so difference stays ~ few px (avoids accumulated snap drift trap).
      const amp = 1.0;
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'up', beats: 4 }], tl, amp, 1.0); // start at TOP
      expect(engine.waveYAt(0)).toBeCloseTo(WAVE_TOP, 5);

      const dt = 0.016;
      const beatMs = 500;

      // Game cursor: with nowWaveY = wave at current beat (use CENTER as wave value to isolate snap direction)
      // Use waveY = 300 (center) so pull is towards center while key pushes up towards TOP.
      const nowWaveY = WAVE_CENTER;
      const gameCursor = new Cursor(amp, 0);
      gameCursor.y = WAVE_CENTER;
      const recCursor = new Cursor(amp, 0);
      recCursor.y = WAVE_CENTER;

      // 3 ticks UP
      for (let i = 0; i < 3; i++) {
        gameCursor.update(dt, true, false, beatMs, nowWaveY);
        recCursor.update(dt, true, false, beatMs);
      }
      // Game cursor should be pulled slightly towards CENTER relative to recording cursor,
      // so gameCursor.y > recCursor.y (less far up). Difference is ~ PULL per tick accumulated.
      expect(gameCursor.y).toBeGreaterThan(recCursor.y);
      const diff = gameCursor.y - recCursor.y;
      // After 3 ticks, diff is small (approx 1-10 px), not huge. This guards against
      // exact accumulated-snap threshold errors while still verifying snap is active.
      expect(diff).toBeGreaterThan(0);
      expect(diff).toBeLessThan(35);
      expect(isClamped(gameCursor.y)).toBe(true);
      expect(isClamped(recCursor.y)).toBe(true);
    });

    it('snap equilibrium: holding against snap at boundary converges within 6px of TOP', () => {
      // Start at TOP-going wave, hold UP continuously with snap towards wave that stays at TOP
      // Cursor should stay near TOP, snap prevents escape but clamp is the ultimate guard.
      const amp = 1.0;
      const cursor = new Cursor(amp, 0);
      cursor.y = WAVE_TOP + 5;
      const nowWaveY = WAVE_TOP; // wave stays at top
      const beatMs = 500;
      const dt = 0.016;
      for (let i = 0; i < 200; i++) {
        cursor.update(dt, true, false, beatMs, nowWaveY);
        expect(isClamped(cursor.y)).toBe(true);
      }
      // After many ticks, cursor should be very close to TOP (within snap equilibrium range)
      expect(cursor.y).toBeLessThanOrEqual(WAVE_TOP + 6);
      expect(cursor.y).toBeGreaterThanOrEqual(WAVE_TOP - 1e-6);
    });

    it('off-grid beat phase: cursor and WaveEngine slope consistency (complex amp 0.7 / 1.3 / 2.7)', () => {
      const amps = [0.7, 1.3, 2.7] as const;
      const offBeats = [0.37, 1.23, 2.71] as const;
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const segs = [{ direction: 'down' as const, beats: 4 }];
        const engine = new WaveEngine(segs, tl, amp, 0);
        for (const ob of offBeats) {
          // wave slope per beat = 2*TW_AMP*amplitudeAt(beat)
          const perBeatPx = 2 * TW_AMP * tl.amplitudeAt(ob);
          // Check waveYAt slope matches expected climb (clamped)
          const y0 = WAVE_CENTER; // startPosition 0
          const expectedY = Math.max(WAVE_TOP, Math.min(WAVE_BOTTOM, y0 + perBeatPx * ob));
          expect(engine.waveYAt(ob)).toBeCloseTo(expectedY, 4);
          // Cursor per-beat displacement should match same perBeatPx
          const beatMs = tl.beatMsAt(ob);
          const speed = (2 * TW_AMP * amp) / (beatMs / 1000);
          // speed * (beatMs/1000) == perBeatPx
          expect(speed * (beatMs / 1000)).toBeCloseTo(perBeatPx, 4);
        }
      }
    });
  });

  describe('4. Recording trajectory simulation: live玉 never leaves field across mixed input', () => {
    it('alternating UP/DOWN with gaps stays clamped (T185 unconditional clamp)', () => {
      const cursor = new Cursor(1.5, 0);
      const beatMs = 500;
      const dt = 0.016;
      // Simulate 8 seconds of erratic recording input without nowWaveY
      const pattern: [boolean, boolean, number][] = [
        [true, false, 60], // up 60 ticks
        [false, false, 20], // release 20
        [false, true, 80], // down 80
        [false, false, 10],
        [true, false, 100],
        [false, true, 100],
      ];
      for (const [up, down, n] of pattern) {
        for (let i = 0; i < n; i++) {
          cursor.update(dt, up, down, beatMs);
          expect(isClamped(cursor.y)).toBe(true);
        }
      }
      expect(isClamped(cursor.y)).toBe(true);
    });

    it('setAmplitude mid-recording does not break clamp', () => {
      const cursor = new Cursor(0.5, 0);
      const beatMs = 500;
      const dt = 0.016;
      // Phase 1: low amp up
      for (let i = 0; i < 200; i++) {
        cursor.update(dt, true, false, beatMs);
        expect(isClamped(cursor.y)).toBe(true);
      }
      // Change amplitude mid-recording (T131)
      cursor.setAmplitude(3.4);
      for (let i = 0; i < 200; i++) {
        cursor.update(dt, true, false, beatMs);
        expect(isClamped(cursor.y)).toBe(true);
      }
      expect(cursor.y).toBeCloseTo(WAVE_TOP, 5);
      cursor.setAmplitude(0.7);
      for (let i = 0; i < 400; i++) {
        cursor.update(dt, false, true, beatMs);
        expect(isClamped(cursor.y)).toBe(true);
      }
      expect(cursor.y).toBeCloseTo(WAVE_BOTTOM, 5);
    });

    it('both keys pressed (up && down) yields zero delta but still clamped after snap', () => {
      const cursor = new Cursor(1.0, 0);
      cursor.y = WAVE_TOP + 1;
      // Both pressed => delta 0, only snap acts. Snap towards BOTTOM should still clamp.
      cursor.update(0.016, true, true, 500, WAVE_BOTTOM + 500);
      expect(isClamped(cursor.y)).toBe(true);
      // Without snap, both pressed is no-op and stays where it was (clamped)
      const cursor2 = new Cursor(1.0, 0);
      cursor2.y = WAVE_TOP + 1;
      cursor2.update(0.016, true, true, 500);
      expect(cursor2.y).toBeCloseTo(WAVE_TOP + 1, 5);
      expect(isClamped(cursor2.y)).toBe(true);
    });
  });

  describe('5. Edge: no regression on zero dt / invalid beatMs / NaN guards', () => {
    it('dt=0 causes no movement but still clamped', () => {
      const cursor = new Cursor(1.0, 0);
      cursor.y = WAVE_CENTER;
      cursor.update(0, true, false, 500);
      expect(cursor.y).toBeCloseTo(WAVE_CENTER, 5);
      // With snap, dt=0 still applies snap
      cursor.y = WAVE_CENTER;
      cursor.update(0, false, false, 500, WAVE_TOP);
      const expected = WAVE_CENTER + (WAVE_TOP - WAVE_CENTER) * PULL;
      expect(cursor.y).toBeCloseTo(expected, 4);
    });

    it('cursor y already out-of-range is clamped back on next update even without snap', () => {
      const cursor = new Cursor(1.0, 0);
      (cursor as unknown as { y: number }).y = WAVE_TOP - 500; // force illegal
      cursor.update(0.016, false, false, 500);
      expect(isClamped(cursor.y)).toBe(true);
      (cursor as unknown as { y: number }).y = WAVE_BOTTOM + 500;
      cursor.update(0.016, false, false, 500);
      expect(isClamped(cursor.y)).toBe(true);
    });
  });
});
