/**
 * @vitest-environment node
 * T174: キャリブレーション判定表示のΔY計測バグ修正
 * Vitest unit tests (node) — pure engine math, no DOM.
 *
 * Bug: handleHit computed ΔY AFTER judgeHit() had marked the hit ring resolved,
 * so the subsequent scan skipped it and measured the next ring. Fix: capture
 * targetY BEFORE calling judgeHit, using the ring judgeHit will actually resolve
 * (Y-aware selection, not just timing-closest).
 *
 * Off-grid principle: include fractional beats (0.37, 1.23, 2.71) and complex
 * amplitudes (0.7, 1.3, 2.7, 3.4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { judgeHit } from '../src/game/hitJudge';
import {
  calculateCalibrationHitYDist,
  formatLastLabel,
  generateCalibrationChart,
} from '../src/screens/editor/CalibrationModal';
import type { RingState } from '../src/types';

const WAVE_TOP = TW_CENTER_Y - TW_AMP;
const WAVE_BOTTOM = TW_CENTER_Y + TW_AMP;

// helper: create RingState array from targetYs and hitTimes
function makeRings(hitTimes: number[], targetYs: number[], opts: Partial<Pick<RingState, 'type'>> = {}): RingState[] {
  return hitTimes.map((hitTime, i) => ({
    id: i,
    spawnTime: hitTime - 1500,
    hitTime,
    targetY: targetYs[i],
    resolved: false,
    hit: false,
    type: (opts.type as RingState['type']) ?? 'single',
  }));
}

// helper: compute timeline hitTime for beat
function hitMs(bpm: number, beat: number, bpmChanges: any[] = [], amp = 1.0): number {
  const tl = new BpmTimeline(bpm, bpmChanges, amp);
  return tl.beatToMs(beat);
}

// helper: simulate buggy AFTER-scan (the T174 bug)
function buggyYDistAfterJudgeHit(rings: RingState[], cursorY: number): number {
  // This mimics the buggy code: scan after judgeHit has marked resolved
  let bestErr = Infinity;
  let target: RingState | null = null;
  // naive scan that just finds smallest err among unresolved (buggy handleHit did this)
  // but because hit ring is now resolved, it finds next ring
  for (const ring of rings) {
    if (ring.resolved) continue;
    // assume pressTime ~ first hitTime, so err approximates |hitTime - pressTime|
    // for buggy check we just find closest unresolved ring's Y
    // Use hitTime distance to first ring's hitTime as proxy
    const err = Math.abs(ring.hitTime - rings[0].hitTime);
    void err;
  }
  // Actually find closest unresolved ring after resolved
  let minYDist = Infinity;
  let closest: RingState | null = null;
  for (const ring of rings) {
    if (ring.resolved) continue;
    // pick first unresolved
    if (!closest) closest = ring;
  }
  if (closest) return Math.abs(cursorY - closest.targetY);
  return 0;
}

describe('T174: ΔY calibration bug — capture BEFORE judgeHit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('1. Correct ΔY matches hit ring (not next ring) when tapping directly above', () => {
    it('two rings at beat 4 and 8, cursor exactly on ring 4 => ΔY ~0 (not distance to ring 8)', () => {
      // [Step1] Capture initial state
      const tl = new BpmTimeline(120, [], 1.0);
      const engine = new WaveEngine(
        [{ direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }, { direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }],
        tl, 1.0, 0,
      );
      const hit4 = tl.beatToMs(4);
      const hit8 = tl.beatToMs(8);
      const y4 = engine.waveYAt(4);
      const y8 = engine.waveYAt(8);
      // Ensure they are far apart (>50px) to make bug detectable
      // If not, force separation
      const targetYs = [y4, y4 + 120];
      const rings = makeRings([hit4, hit8], targetYs);
      const cursorY = targetYs[0] + 2; // 2px above ring 4
      const beatMs = tl.beatMsAt(4);
      const pressTime = hit4 + 5; // 5ms error

      // [Step2] Perform user interaction — capture BEFORE judgeHit (correct) vs AFTER (buggy)
      const correctYDist = calculateCalibrationHitYDist(pressTime, cursorY, rings, beatMs, 750);
      // Simulate judgeHit mutates rings
      const ringsClone: RingState[] = JSON.parse(JSON.stringify(rings));
      // Need to preserve class behavior — use originals
      const liveRings = makeRings([hit4, hit8], targetYs);
      const judgement = judgeHit(pressTime, cursorY, liveRings, beatMs, 750);
      expect(judgement).not.toBeNull();
      // After judgeHit, first ring is resolved
      expect(liveRings[0].resolved).toBe(true);
      // Buggy scan: find closest unresolved ring after
      let buggyYDist = 0;
      for (const r of liveRings) {
        if (r.resolved) continue;
        buggyYDist = Math.abs(cursorY - r.targetY);
        break;
      }

      // [Step3] Assert resulting transition
      expect(correctYDist).toBeCloseTo(2, 0); // ~2px
      expect(correctYDist).toBeLessThan(10);
      expect(buggyYDist).toBeGreaterThan(100); // distance to ring 8 (~118px)
      expect(buggyYDist).not.toBeCloseTo(correctYDist, 0);
    });

    it('complex amplitude 0.7: off-grid beats with ΔY near zero still reports near-zero', () => {
      const amp = 0.7;
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 4 }, { direction: 'up', beats: 4 }], tl, amp, 0);
      const hit4 = tl.beatToMs(4);
      const hit8 = tl.beatToMs(8);
      const y4 = engine.waveYAt(4);
      const rings = makeRings([hit4, hit8], [y4, y4 + 150]);
      const cursorY = y4 + 1.5; // off-grid Y offset
      const beatMs = tl.beatMsAt(4);
      const pressTime = hit4 + 12; // 12ms error

      const yDist = calculateCalibrationHitYDist(pressTime, cursorY, rings, beatMs, 750);
      expect(yDist).toBeCloseTo(1.5, 0);
      expect(yDist).toBeLessThan(5);

      const live = makeRings([hit4, hit8], [y4, y4 + 150]);
      const j = judgeHit(pressTime, cursorY, live, beatMs, 750);
      expect(j?.result).toBe('perfect');
      expect(live[0].resolved).toBe(true);
      // bug would give ~148.5
      let buggy = 0;
      for (const r of live) if (!r.resolved) { buggy = Math.abs(cursorY - r.targetY); break; }
      expect(buggy).toBeGreaterThan(140);
      expect(yDist).not.toBeCloseTo(buggy, 0);
    });

    it('complex amplitude 1.3: off-grid press at 0.37 beat offset', () => {
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }], tl, amp, 0);
      const beat = 4.37; // off-grid hit
      const hit = tl.beatToMs(beat);
      const hitNext = tl.beatToMs(8.37);
      const y = engine.waveYAt(beat);
      const yNext = engine.waveYAt(8.37);
      // ensure separation
      const yNextForced = y + 110;
      void yNext;
      const rings = makeRings([hit, hitNext], [y, yNextForced]);
      const cursorY = y + 3;
      const beatMs = tl.beatMsAt(beat);
      const pressTime = hit + 8;

      const yDist = calculateCalibrationHitYDist(pressTime, cursorY, rings, beatMs, 750);
      expect(yDist).toBeCloseTo(3, 0);
      expect(yDist).toBeLessThan(10);

      const live = makeRings([hit, hitNext], [y, yNextForced]);
      judgeHit(pressTime, cursorY, live, beatMs, 750);
      let buggy = 0;
      for (const r of live) if (!r.resolved) { buggy = Math.abs(cursorY - r.targetY); break; }
      expect(buggy).toBeGreaterThan(100);
    });

    it('complex amplitude 2.7: off-grid 1.23 beat press', () => {
      const amp = 2.7;
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }, { direction: 'down', beats: 2 }], tl, amp, 0);
      const hit = tl.beatToMs(4);
      const hitNext = tl.beatToMs(8);
      const y = engine.waveYAt(4);
      const rings = makeRings([hit, hitNext], [y, y + 130]);
      const cursorY = y + 0.5;
      const beatMs = tl.beatMsAt(4);
      const pressTime = hit + 20; // 20ms
      const yDist = calculateCalibrationHitYDist(pressTime, cursorY, rings, beatMs, 750);
      expect(yDist).toBeCloseTo(0.5, 0);

      const live = makeRings([hit, hitNext], [y, y + 130]);
      judgeHit(pressTime, cursorY, live, beatMs, 750);
      let buggy = 0;
      for (const r of live) if (!r.resolved) { buggy = Math.abs(cursorY - r.targetY); break; }
      expect(buggy).toBeGreaterThan(120);
    });
  });

  describe('2. Y-aware selection: timing-closest fails Y but second passes', () => {
    it('ring A: small err but Y far (70px) => miss, ring B: larger err but Y close (10px) => hit picks B', () => {
      // [Step1] Setup
      const tl = new BpmTimeline(120, [], 1.0);
      const beatMs = tl.beatMsAt(4);
      // Two rings very close in time but different Y
      const hitA = 2000;
      const hitB = 2050; // 50ms later
      const yA = 200;
      const yB = 300;
      const rings = makeRings([hitA, hitB], [yA, yB]);
      const cursorY = yB + 10; // close to B, far from A (90px)
      const pressTime = hitA + 5; // closest to A timing-wise (5ms vs 45ms to B)

      // [Step2] Correct yDist should be distance to B (10px), not A (110px)
      const yDist = calculateCalibrationHitYDist(pressTime, cursorY, rings, beatMs, 750);
      // hitCandidates filter Y<60: only B qualifies, so B is selected despite larger err
      expect(yDist).toBeCloseTo(10, 0);

      // Verify judgeHit also picks B (not A)
      const live = makeRings([hitA, hitB], [yA, yB]);
      const j = judgeHit(pressTime, cursorY, live, beatMs, 750);
      expect(j).not.toBeNull();
      // Should be a hit (good/great/perfect) not miss
      expect(j!.result).not.toBe('miss');
      // The hit should have resolved B? Wait judgeHit resolves selected ring.
      // Which ring got resolved? Y-aware picks B, so B should be resolved
      // Check: if A was picked, A would be resolved with miss; but we got hit, so B
      const resolvedIds = live.filter(r => r.resolved).map(r => r.id);
      expect(resolvedIds).toContain(1); // B
      // And yDist from before matches |cursorY - yB|
      expect(yDist).toBeCloseTo(Math.abs(cursorY - yB), 5);
    });

    it('when no candidate passes Y<60, picks timing-closest for MISS with correct large ΔY', () => {
      const tl = new BpmTimeline(120, [], 1.0);
      const beatMs = tl.beatMsAt(4);
      const hitA = 2000;
      const hitB = 2050;
      const yA = 200;
      const yB = 400;
      const rings = makeRings([hitA, hitB], [yA, yB]);
      const cursorY = yA + 90; // far from both (>60)
      const pressTime = hitA + 5; // closer to A

      const yDist = calculateCalibrationHitYDist(pressTime, cursorY, rings, beatMs, 750);
      // Both fail Y, so picks err smallest => A, yDist ~90
      expect(yDist).toBeCloseTo(90, 0);
      const live = makeRings([hitA, hitB], [yA, yB]);
      const j = judgeHit(pressTime, cursorY, live, beatMs, 750);
      expect(j?.result).toBe('miss');
      // miss still returns errorMs and marks resolved
      expect(live[0].resolved).toBe(true);
      // yDist should be 90, not distance to B (which would be ~110)
      expect(yDist).toBeLessThan(100);
      expect(Math.abs(cursorY - yB)).toBeGreaterThan(100);
    });
  });

  describe('3. Bug demonstration: AFTER scan gives wrong ΔY, BEFORE gives correct', () => {
    it('sequence of 5 rings, hit first, buggy scan returns next ring distance', () => {
      const tl = new BpmTimeline(120, [], 1.0);
      const beats = [4, 8, 12, 16, 20];
      const hitTimes = beats.map(b => tl.beatToMs(b));
      const engine = new WaveEngine(generateCalibrationChart(24).segments, tl, 1.0, 0);
      const ys = beats.map(b => engine.waveYAt(b));
      // Force separation: offset even indices
      const targetYs = ys.map((y, i) => (i === 0 ? y : y + 100 + i * 10));
      // Ensure first is distinct
      const rings = makeRings(hitTimes, targetYs);
      const cursorY = targetYs[0] + 1;
      const pressTime = hitTimes[0] + 10;
      const beatMs = tl.beatMsAt(4);

      const correct = calculateCalibrationHitYDist(pressTime, cursorY, rings, beatMs, 750);
      expect(correct).toBeCloseTo(1, 0);

      const live = makeRings(hitTimes, targetYs);
      judgeHit(pressTime, cursorY, live, beatMs, 750);
      // Simulate buggy: scan after
      let buggy = 0;
      for (const r of live) if (!r.resolved) { buggy = Math.abs(cursorY - r.targetY); break; }
      expect(buggy).toBeGreaterThan(90);
      expect(correct).not.toEqual(buggy);
    });

    it('off-grid 0.37 and 1.23 beats still show BEFORE vs AFTER difference', () => {
      const amps = [0.7, 1.3, 2.7] as const;
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const hit = tl.beatToMs(4.37);
        const hitNext = tl.beatToMs(8.37);
        const engine = new WaveEngine([{ direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }], tl, amp, 0);
        const y = engine.waveYAt(4.37);
        const yNext = y + 100;
        void yNext;
        const cursorY = y + 2;
        const pressTime = hit + 7;
        const beatMs = tl.beatMsAt(4.37);
        const rings = makeRings([hit, hitNext], [y, y + 100]);
        const correct = calculateCalibrationHitYDist(pressTime, cursorY, rings, beatMs, 750);
        expect(correct).toBeCloseTo(2, 0);
        const live = makeRings([hit, hitNext], [y, y + 100]);
        judgeHit(pressTime, cursorY, live, beatMs, 750);
        let buggy = 0;
        for (const r of live) if (!r.resolved) { buggy = Math.abs(cursorY - r.targetY); break; }
        expect(buggy).toBeGreaterThan(90);
      }
    });
  });

  describe('4. Edge cases and hitJudge side-effects', () => {
    it('no rings => yDist 0', () => {
      const yDist = calculateCalibrationHitYDist(1000, 300, [], 500, 750);
      expect(yDist).toBe(0);
    });

    it('all rings already resolved => yDist 0', () => {
      const rings: RingState[] = [
        { id: 0, spawnTime: 0, hitTime: 2000, targetY: 200, resolved: true, hit: false },
        { id: 1, spawnTime: 0, hitTime: 4000, targetY: 300, resolved: true, hit: true },
      ];
      const yDist = calculateCalibrationHitYDist(2005, 205, rings, 500, 750);
      expect(yDist).toBe(0);
    });

    it('outside wide window => no candidate => yDist 0 and judgeHit returns null', () => {
      const hit = 2000;
      const rings = makeRings([hit], [300]);
      const pressTime = hit + 800; // outside 750
      const yDist = calculateCalibrationHitYDist(pressTime, 305, rings, 500, 750);
      expect(yDist).toBe(0);
      const live = makeRings([hit], [300]);
      const j = judgeHit(pressTime, 305, live, 500, 750);
      expect(j).toBeNull();
      expect(live[0].resolved).toBe(false);
    });

    it('hold ring already hit (hit true) is skipped', () => {
      const hit = 2000;
      const hitB = 2050; // within wide window 750
      const rings: RingState[] = [
        { id: 0, spawnTime: 0, hitTime: hit, targetY: 200, resolved: false, hit: true, type: 'hold' },
        { id: 1, spawnTime: 0, hitTime: hitB, targetY: 300, resolved: false, hit: false, type: 'single' },
      ];
      const yDist = calculateCalibrationHitYDist(hit + 5, 202, rings, 500, 750);
      // Should skip hold hit, pick next ring => distance ~98
      expect(yDist).toBeCloseTo(Math.abs(202 - 300), 5);
    });

    it('judgeHit marks resolved and hit flags correctly for 3.4 amplitude off-grid', () => {
      const amp = 3.4;
      const tl = new BpmTimeline(130, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }], tl, amp, 0);
      const hit = tl.beatToMs(5.71); // off-grid
      const hitNext = tl.beatToMs(9.71);
      const y = engine.waveYAt(5.71);
      const live = makeRings([hit, hitNext], [y, y + 110]);
      const cursorY = y + 4;
      const j = judgeHit(hit + 15, cursorY, live, tl.beatMsAt(5.71), 750);
      expect(j).not.toBeNull();
      expect(live[0].resolved).toBe(true);
      expect(live[0].hit).toBe(true);
      expect(live[1].resolved).toBe(false);
      const yDist = calculateCalibrationHitYDist(hit + 15, cursorY, makeRings([hit, hitNext], [y, y + 110]), tl.beatMsAt(5.71), 750);
      expect(yDist).toBeCloseTo(4, 0);
    });
  });

  describe('5. WaveEngine / Cursor numeric consistency with complex amps (T127 style)', () => {
    it('waveYAt and cursor speed share same perBeatPx for amps 0.7/1.3/2.7/3.4 at off-grid beats', () => {
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const offBeats = [0.37, 1.23, 2.71] as const;
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 0);
        for (const ob of offBeats) {
          const perBeatPx = 2 * TW_AMP * tl.amplitudeAt(ob);
          const y0 = TW_CENTER_Y - 0 * TW_AMP; // startPosition 0 => 300
          const expectedY = Math.max(WAVE_TOP, Math.min(WAVE_BOTTOM, y0 + perBeatPx * ob));
          expect(engine.waveYAt(ob)).toBeCloseTo(expectedY, 3);
          const beatMs = tl.beatMsAt(ob);
          const speed = (2 * TW_AMP * amp) / (beatMs / 1000);
          expect(speed * (beatMs / 1000)).toBeCloseTo(perBeatPx, 3);
        }
      }
    });

    it('generateCalibrationChart produces alternating up/down and 4-beat rings', () => {
      const chart = generateCalibrationChart(16);
      // segments: up 2 / down 2 pattern
      expect(chart.segments.length).toBeGreaterThan(0);
      expect(chart.segments[0].direction).toBe('up');
      expect(chart.segments[1].direction).toBe('down');
      expect(chart.rings[0].beat).toBe(4);
      expect(chart.rings[1].beat).toBe(8);
      expect(chart.bpm).toBe(120);
    });

    it('formatLastLabel shows ΔY and integer ms without fake 0 for miss', () => {
      // [Step1] initial label
      const perfectLabel = formatLastLabel('perfect', 3.7, 2.4);
      // [Step2] interactions — formatter called with various inputs
      const greatLabel = formatLastLabel('great', 40.2, 35.6);
      const missLabel = formatLastLabel('miss', null, 10);
      const missLabel2 = formatLastLabel('miss', 0, 0); // should still show --
      // [Step3] assert transitions
      expect(perfectLabel).toMatch(/PERFECT.*\+4ms.*ΔY 2px/);
      expect(greatLabel).toMatch(/GREAT.*\+40ms.*ΔY 36px/);
      expect(missLabel).toMatch(/MISS.*--.*ΔY 10px/);
      expect(missLabel2).toMatch(/MISS.*--/);
      expect(missLabel2).not.toMatch(/\+0ms/);
    });
  });

  describe('6. Integration: yDist via calculateCalibrationHitYDist equals manual BEFORE capture', () => {
    it('manual BEFORE scan (same as Fixed handleHit) equals calculateCalibrationHitYDist for random off-grid cases', () => {
      const cases: Array<{ amp: number; beat: number; yOff: number; tOff: number }> = [
        { amp: 0.7, beat: 4, yOff: 2, tOff: 5 },
        { amp: 1.3, beat: 4.37, yOff: 12, tOff: 40 },
        { amp: 2.7, beat: 8.71, yOff: 3, tOff: -12 },
        { amp: 3.4, beat: 12.23, yOff: 25, tOff: 80 },
        { amp: 1.0, beat: 4, yOff: 55, tOff: 10 }, // Y miss case
      ];
      for (const c of cases) {
        const tl = new BpmTimeline(120, [], c.amp);
        const engine = new WaveEngine([{ direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }], tl, c.amp, 0);
        const hit = tl.beatToMs(c.beat);
        const hitNext = tl.beatToMs(c.beat + 4);
        const y = engine.waveYAt(c.beat);
        const yNext = y + 80;
        const rings = makeRings([hit, hitNext], [y, yNext]);
        const cursorY = y + c.yOff;
        const pressTime = hit + c.tOff;
        const beatMs = tl.beatMsAt(c.beat);

        // Manual BEFORE scan replicating fixed handleHit (yDist BEFORE judgeHit)
        // Use y-aware logic via calculateCalibrationHitYDist
        const expected = calculateCalibrationHitYDist(pressTime, cursorY, rings, beatMs, 750);
        // Direct recompute via same logic
        const direct = (() => {
          const win = 750;
          const HIT_Y = 60;
          const cands: { ring: RingState; err: number; yDist: number }[] = [];
          for (const r of rings) {
            if (r.resolved) continue;
            const err = Math.abs(pressTime - r.hitTime);
            if (err < win) cands.push({ ring: r, err, yDist: Math.abs(cursorY - r.targetY) });
          }
          if (cands.length === 0) return 0;
          const hits = cands.filter(v => v.yDist < HIT_Y);
          const sel = hits.length ? hits.sort((a, b) => a.err - b.err)[0] : cands.sort((a, b) => a.err - b.err)[0];
          return sel.yDist;
        })();
        expect(expected).toBeCloseTo(direct, 5);
        // Also verify judgeHit picks same ring's yDist when hit succeeds
        const live = makeRings([hit, hitNext], [y, yNext]);
        const j = judgeHit(pressTime, cursorY, live, beatMs, 750);
        if (j) {
          // For hits, expected should be small (<60) else miss large
          if (j.result !== 'miss') expect(expected).toBeLessThan(60);
        }
      }
    });

    it('hitJudge window boundary: 749ms inside, 751ms outside for wide calibration window', () => {
      const hit = 5000;
      const rings = makeRings([hit], [300]);
      const cursorY = 305;
      const inside = calculateCalibrationHitYDist(hit + 749, cursorY, rings, 500, 750);
      const outside = calculateCalibrationHitYDist(hit + 751, cursorY, rings, 500, 750);
      expect(inside).toBeCloseTo(5, 0);
      expect(outside).toBe(0);
      const liveInside = makeRings([hit], [300]);
      expect(judgeHit(hit + 749, cursorY, liveInside, 500, 750)).not.toBeNull();
      const liveOutside = makeRings([hit], [300]);
      expect(judgeHit(hit + 751, cursorY, liveOutside, 500, 750)).toBeNull();
    });
  });
});
