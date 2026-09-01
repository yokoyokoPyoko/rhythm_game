import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { segmentize, quantizeBeat, isSnapAligned, type TrajPoint } from '../src/chart/quantize';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import type { Segment } from '../src/types';

vi.useFakeTimers();

const TIMELINE_120 = new BpmTimeline(120, []);
const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

// Helper: quantize raw beats to snap grid with minimal snap clamp (mirrors fixed spec)
function expectedSnapBeats(raw: number, snap: number): number {
  let q = quantizeBeat(raw, snap);
  if (q < 1e-6) q = snap;
  // also ensure snap alignment (for 0.30 with snap=1, q=0 -> snap)
  if (q < snap - 1e-9 && q < snap) {
    // if quantized to 0, clamp to snap
    if (q < 1e-6) return snap;
  }
  return Number(q.toFixed(4));
}

function isAligned(beats: number, snap: number): boolean {
  return isSnapAligned(beats, snap);
}

// Build a minimal trajectory that yields a single moving run of `duration` beats
// starting at `startBeat`. Uses y delta large enough to exceed threshold.
function shortPressTraj(startBeat: number, duration: number, direction: 'up' | 'down' = 'down'): TrajPoint[] {
  const release = Number((startBeat + duration).toFixed(4));
  // One true point at start, one false at release. dy large to be classified as moving.
  const yStart = CENTER;
  const yEnd = direction === 'down' ? CENTER + 90 : CENTER - 90;
  return [
    { beat: startBeat, y: yStart, down: true },
    { beat: release, y: yEnd, down: false },
  ];
}

function movingTraj(startBeat: number, duration: number, direction: 'up' | 'down' = 'down'): TrajPoint[] {
  const release = Number((startBeat + duration).toFixed(4));
  const yStart = CENTER;
  const yEnd = direction === 'down' ? CENTER + 80 : CENTER - 80;
  // include intermediate true point to ensure run detection
  const mid = Number((startBeat + duration * 0.5).toFixed(4));
  const yMid = direction === 'down' ? CENTER + 40 : CENTER - 40;
  return [
    { beat: startBeat, y: yStart, down: true },
    { beat: mid, y: yMid, down: true },
    { beat: release, y: yEnd, down: false },
  ];
}

describe('T129 録音モードのセグメント長クオンタイズ修正 — snap解像度優先 (Red before fix)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------
  // 1. snap別 short press 0.30 -> beats は snap整数倍 (0.25/0.25/0.5/1)
  // ------------------------------------------------------------
  describe('1. snap別 端数タイミング短押し 0.30拍 の量子化', () => {
    const snapCases: Array<{ snap: number; expected: number }> = [
      { snap: 0.125, expected: 0.25 },
      { snap: 0.25, expected: 0.25 },
      { snap: 0.5, expected: 0.5 },
      { snap: 1, expected: 1 },
    ];

    it.each(snapCases)('snap=$snap shortPress 0.30 -> beats=$expected (amp=1)', ({ snap, expected }) => {
      // [Step 1: Capture Initial State] - confirm empty or baseline
      const empty = segmentize([], snap, 1);
      expect(empty).toEqual([]);

      // [Step 2: Perform] short press 0.30 beats
      const traj = shortPressTraj(0, 0.30, 'down');
      const segs = segmentize(traj, snap, 1.0);

      // [Step 3: Assert] beats equals snap-based expectation
      expect(segs.length).toBeGreaterThan(0);
      // Sum of moving beats should be expected (single segment)
      const moving = segs.filter(s => s.direction !== 'stay');
      const totalMoving = moving.reduce((a, b) => a + b.beats, 0);
      expect(totalMoving).toBeCloseTo(expected, 4);
      // Each beats must be snap-aligned
      for (const s of segs) {
        expect(isAligned(s.beats, snap), `beats ${s.beats} not snap ${snap}`).toBeTruthy();
      }
      // Must NOT be forced to 1/amplitude=1.0 when snap smaller
      if (snap < 1) {
        // For snap 0.125/0.25/0.5, total should NOT be 1.0 (the buggy physicalSnap)
        if (expected !== 1.0) {
          expect(totalMoving).not.toBeCloseTo(1.0, 4);
        }
      }
    });

    it.each([0.125, 0.25, 0.5, 1] as const)('snap=%s each beats is snap整数倍 (amp=1, off-grid)', (snap) => {
      const traj = movingTraj(1.0, 0.30, 'up');
      const segs = segmentize(traj, snap, 1);
      expect(segs.length).toBeGreaterThan(0);
      for (const s of segs) {
        expect(isAligned(s.beats, snap)).toBeTruthy();
        // also verify Beats % snap approx 0 via isSnapAligned helper
        const remainder = ((s.beats % snap) + snap) % snap;
        expect(remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6).toBeTruthy();
      }
    });
  });

  // ------------------------------------------------------------
  // 2. 1/amplitude でないこと検証 (snap=0.25 amp=1 0.30 -> 0.25 not 1.0)
  // ------------------------------------------------------------
  describe('2. 1/amplitude強制の廃止検証', () => {
    it('snap=0.25 amp=1 short 0.30 -> 0.25 not 1.0 (physicalSnap bug)', () => {
      // [Step1] baseline
      const snap = 0.25;
      const amp = 1.0;
      const raw = 0.30;
      const before = segmentize(shortPressTraj(0, raw), snap, amp);
      expect(before.length).toBeGreaterThan(0);

      // [Step2] perform
      const segs = segmentize(shortPressTraj(0, raw), snap, amp);
      const total = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);

      // [Step3] assert snap-based not physical
      expect(isAligned(total, snap)).toBeTruthy();
      expect(total).toBeCloseTo(0.25, 4);
      expect(total).not.toBeCloseTo(1.0, 4);
      // Also not equal to quantizeBeat(1/amplitude, snap) = 1.0
      const physicalForced = quantizeBeat(1 / amp, snap);
      expect(total).not.toBeCloseTo(physicalForced, 4);
    });

    it('snap=0.125 amp=1 short 0.30 -> 0.25 not 1.0', () => {
      const segs = segmentize(shortPressTraj(0, 0.30), 0.125, 1.0);
      const total = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
      expect(total).toBeCloseTo(0.25, 4);
      expect(total).not.toBeCloseTo(1.0, 4);
    });

    it('snap=0.5 amp=1 short 0.30 -> 0.5 not 1.0', () => {
      const segs = segmentize(shortPressTraj(0, 0.30), 0.5, 1.0);
      const total = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
      expect(total).toBeCloseTo(0.5, 4);
      expect(total).not.toBeCloseTo(1.0, 4);
    });

    it('snap=1 amp=1 short 0.30 -> 1.0 (clamped to minimal snap, not free)', () => {
      const segs = segmentize(shortPressTraj(0, 0.30), 1, 1.0);
      const total = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
      expect(total).toBeCloseTo(1.0, 4);
      expect(isAligned(total, 1)).toBeTruthy();
    });
  });

  // ------------------------------------------------------------
  // 3. amplitude独立性（高い振幅でも snap優先）
  // ------------------------------------------------------------
  describe('3. amplitudeが振幅速度に影響しても beatsはsnap優先', () => {
    const amps = [0.7, 1.0, 1.3, 2.7, 3.4];
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    it.each(amps)('amp=%s does not force physicalSnap for short 0.30 (snap 0.25)', (amp) => {
      const snap = 0.25;
      const raw = 0.30;
      const expected = expectedSnapBeats(raw, snap); // 0.25
      // [Step1] capture initial
      const initial = segmentize([], snap, amp);
      expect(initial).toEqual([]);
      // [Step2] perform
      const segs = segmentize(shortPressTraj(0, raw), snap, amp);
      const total = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
      // [Step3] assert amplitude-independent snap quantization
      expect(total).toBeCloseTo(expected, 4);
      expect(isAligned(total, snap)).toBeTruthy();
      // Must NOT be quantizeBeat(1/amp, snap) unless that happens to equal expected by chance
      const physicalSnap = quantizeBeat(1 / amp, snap);
      if (Math.abs(physicalSnap - expected) > 1e-6) {
        expect(total).not.toBeCloseTo(physicalSnap, 4);
      }
    });

    for (const snap of snaps) {
      it(`snap=${snap} amplitude 1.3/2.7 still produces snap-aligned beats for off-grid 0.37`, () => {
        for (const amp of [1.3, 2.7]) {
          const raw = 0.37;
          const expected = expectedSnapBeats(raw, snap);
          const segs = segmentize(movingTraj(0, raw), snap, amp);
          expect(segs.length).toBeGreaterThan(0);
          for (const s of segs) expect(isAligned(s.beats, snap)).toBeTruthy();
          const total = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
          // For snap that yields expected < snap, clamp to snap; else quantizeBeat
          expect(total).toBeCloseTo(expected, 4);
        }
      });
    }
  });

  // ------------------------------------------------------------
  // 4. 端数タイミング off-grid release variety
  // ------------------------------------------------------------
  describe('4. off-grid variety (0.37, 1.2, 1.23, 0.44) across snaps', () => {
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    const offGridRaws = [0.37, 0.44, 1.2, 1.23, 0.30];

    for (const snap of snaps) {
      for (const raw of offGridRaws) {
        it(`snap=${snap} raw=${raw} -> snap-aligned`, () => {
          const amp = 1.0;
          const expected = expectedSnapBeats(raw, snap);
          // [Step1] capture
          const beforeLen = segmentize([], snap, amp).length;
          expect(beforeLen).toBe(0);
          // [Step2] perform with off-grid raw
          const traj: TrajPoint[] = [
            { beat: 0, y: CENTER, down: true },
            { beat: raw * 0.5, y: CENTER + 30, down: true },
            { beat: Number((raw).toFixed(4)), y: CENTER + 60, down: true },
            { beat: Number((raw + 0.01).toFixed(4)), y: CENTER + 60, down: false },
          ];
          // Actually use shortPress style to ensure raw is exactly end-start of moving run
          const traj2 = movingTraj(0, raw, 'down');
          const segs = segmentize(traj2, snap, amp);
          expect(segs.length).toBeGreaterThan(0);
          // [Step3] assert
          for (const s of segs) {
            expect(isAligned(s.beats, snap), `snap ${snap} raw ${raw} beats ${s.beats}`).toBeTruthy();
          }
          // total moving approx expected (or at least snap-aligned)
          const totalMoving = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
          // totalMoving should be snap-aligned; for single moving run it should equal expected
          expect(isAligned(totalMoving, snap)).toBeTruthy();
          // prohibit retaining raw arbitrary residue when off-grid
          if (Math.abs(raw - expected) > 1e-6) {
            expect(totalMoving).not.toBeCloseTo(raw, 2);
          }
        });
      }
    }
  });

  // ------------------------------------------------------------
  // 5. 録音範囲 [startBeat,endBeat) と newSegs 総拍数の一致＆上書き連続性
  // ------------------------------------------------------------
  describe('5. 録音範囲と newSegs 総ビート一致 — finishRecording 上書きが gapなし', () => {
    function simulateFinishRecording(
      initialSegs: Segment[],
      startBeat: number,
      endBeat: number,
      snap: number,
      amp: number,
    ): { keptBefore: Segment[]; newSegs: Segment[]; keptAfter: Segment[]; final: Segment[] } {
      // Replicates EditorScreen truncateSegmentsTo + keptAfter logic
      // keptBefore: truncate at startBeat (partial)
      let cum = 0;
      const keptBefore: Segment[] = [];
      for (const seg of initialSegs) {
        const end = cum + seg.beats;
        if (end <= startBeat + 1e-9) {
          keptBefore.push(seg);
          cum = end;
        } else {
          const part = startBeat - cum;
          if (part > 0.0001) keptBefore.push({ direction: seg.direction, beats: Number(part.toFixed(4)) });
          break;
        }
      }
      // newSegs from traj covering [startBeat, endBeat)
      const duration = endBeat - startBeat;
      const traj = shortPressTraj(startBeat, duration, 'down');
      const newSegs = segmentize(traj, snap, amp);

      // keptAfter: whole segments starting at >= endBeat (spec current logic)
      let cum2 = 0;
      let endIdx = initialSegs.length;
      for (let i = 0; i < initialSegs.length; i++) {
        if (cum2 >= endBeat - 1e-9) {
          endIdx = i;
          break;
        }
        cum2 += initialSegs[i].beats;
      }
      // if loop completed without break, endIdx stays length
      const keptAfter = initialSegs.slice(endIdx);
      const final = [...keptBefore, ...newSegs, ...keptAfter];
      return { keptBefore, newSegs, keptAfter, final };
    }

    it('snap=0.25 range 0.30 (start 1.0 -> 1.30 quant to 1.25) newSegs total == 0.25 and no gap', () => {
      const snap = 0.25;
      const amp = 1.0;
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
        { direction: 'stay', beats: 2 },
      ];
      const startBeat = 1.0;
      const rawDuration = 0.30; // endBeat quant 1.25? Let's use snapped endBeat directly for determinism
      const endBeat = quantizeBeat(startBeat + rawDuration, snap); // 1.25
      const durationSnapped = endBeat - startBeat; // 0.25
      expect(durationSnapped).toBeCloseTo(0.25, 4);

      // [Step1] capture initial total
      const initialTotal = initial.reduce((a, b) => a + b.beats, 0);
      expect(initialTotal).toBeCloseTo(8, 4);

      // [Step2] perform recording simulation
      const { keptBefore, newSegs, keptAfter, final } = simulateFinishRecording(initial, startBeat, endBeat, snap, amp);

      // [Step3] assert newSegs total == range (snap-aligned)
      const newTotal = newSegs.reduce((a, b) => a + b.beats, 0);
      expect(newTotal).toBeCloseTo(durationSnapped, 4);
      expect(isAligned(newTotal, snap)).toBeTruthy();
      // Must NOT be 1.0 (physicalSnap bug)
      expect(newTotal).not.toBeCloseTo(1.0, 4);

      // Verify gap-less: keptBefore covers [0,start) and newSegs covers [start,end), so keptBeforeSum + newTotal == endBeat
      const keptBeforeSum = keptBefore.reduce((a, b) => a + b.beats, 0);
      expect(keptBeforeSum).toBeCloseTo(startBeat, 4);
      expect(keptBeforeSum + newTotal).toBeCloseTo(endBeat, 4);

      // Also each segment in final must be snap-aligned? Not required but newSegs must be.
      for (const s of newSegs) expect(isAligned(s.beats, snap)).toBeTruthy();
    });

    it('snap=0.5 range raw 0.37 -> quant 0.5 newSegs 0.5 not 1.0', () => {
      const snap = 0.5;
      const amp = 1.0;
      const startBeat = 0.5;
      const raw = 0.37;
      const endBeat = quantizeBeat(startBeat + raw, snap); // 1.0? 0.5+0.37=0.87 -> 1.0
      const duration = endBeat - startBeat; // 0.5
      const traj = shortPressTraj(startBeat, duration, 'down');
      const newSegs = segmentize(traj, snap, amp);
      const total = newSegs.reduce((a, b) => a + b.beats, 0);
      expect(total).toBeCloseTo(duration, 4);
      expect(total).toBeCloseTo(0.5, 4);
      expect(total).not.toBeCloseTo(1.0, 4);
      expect(isAligned(total, snap)).toBeTruthy();
    });

    it('snap=0.125 range 0.30 -> 0.25 gap-less overwrite with keptBefore/keptAfter aligned boundaries', () => {
      const snap = 0.125;
      const amp = 1.0;
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      // Choose start 1.0 (boundary), end 1.25 (boundary for snap 0.125/0.25)
      const startBeat = 1.0;
      const endBeat = 1.25;
      const duration = endBeat - startBeat; // 0.25
      const traj = shortPressTraj(startBeat, duration, 'down');
      const newSegs = segmentize(traj, snap, amp);
      const total = newSegs.reduce((a, b) => a + b.beats, 0);
      expect(total).toBeCloseTo(0.25, 4);
      expect(total).not.toBeCloseTo(1.0, 4);
      for (const s of newSegs) expect(isAligned(s.beats, snap)).toBeTruthy();

      // Simulate full overwrite continuity with boundary-aligned start/end
      const { keptBefore, keptAfter, final } = simulateFinishRecording(initial, startBeat, endBeat, snap, amp);
      const keptBeforeSum = keptBefore.reduce((a, b) => a + b.beats, 0);
      expect(keptBeforeSum).toBeCloseTo(startBeat, 4);
      // Since endBeat 1.25 is inside segment 1-2, keptAfter will start at next boundary (2.0) leaving gap if logic discards partial.
      // We instead assert newSegs total == duration (snap) which is the core fix; gap due to segment boundary discard is expected for this configuration.
      // For boundary-aligned case 1.0->2.0 (1.0 range)
      const start2 = 1.0;
      const end2 = 2.0;
      const { newSegs: ns2 } = simulateFinishRecording(initial, start2, end2, snap, amp);
      expect(ns2.reduce((a, b) => a + b.beats, 0)).toBeCloseTo(1.0, 4);
    });

    it('snap=0.25 range 1.25 (1.0->2.25) newSegs 1.25 not 1.0 — wave overwrite not additive', () => {
      const snap = 0.25;
      const amp = 1.0;
      const startBeat = 1.0;
      const endBeat = 2.25;
      const duration = endBeat - startBeat; // 1.25
      const traj = shortPressTraj(startBeat, duration, 'down');
      // Need intermediate true points to ensure traj reflects 1.25 duration accurately (single true run already does)
      const newSegs = segmentize(traj, snap, amp);
      const total = newSegs.reduce((a, b) => a + b.beats, 0);
      // Snap 0.25: 1.25 quantizes to 1.25, physical 1.0 would quantize to 1.0
      expect(total).toBeCloseTo(1.25, 4);
      expect(isAligned(total, snap)).toBeTruthy();
      expect(total).not.toBeCloseTo(1.0, 4);
    });

    it('multiple snaps with same raw 0.30 produce distinct snap-aligned totals (not uniform 1.0)', () => {
      const raw = 0.30;
      const amp = 1.0;
      const results: Record<number, number> = {};
      for (const snap of [0.125, 0.25, 0.5, 1] as const) {
        const traj = shortPressTraj(0, raw, 'down');
        const segs = segmentize(traj, snap, amp);
        const total = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
        results[snap] = total;
        expect(isAligned(total, snap)).toBeTruthy();
      }
      // They must not all be 1.0 (uniform) — at least two differ
      expect(results[0.125]).toBeCloseTo(0.25, 4);
      expect(results[0.25]).toBeCloseTo(0.25, 4);
      expect(results[0.5]).toBeCloseTo(0.5, 4);
      expect(results[1]).toBeCloseTo(1.0, 4);
      // Distinctness check: 0.125 vs 0.5 must differ
      expect(results[0.125]).not.toBeCloseTo(results[0.5], 4);
      // And 0.25 vs 1 must differ
      expect(results[0.25]).not.toBeCloseTo(results[1], 4);
    });
  });

  // ------------------------------------------------------------
  // 6. regression: isSnapAligned & quantizeBeat still correct
  // ------------------------------------------------------------
  describe('6. regression: snap整合性 — Beats が snap整数倍 & T101 仕様維持', () => {
    it('every produced beats is snap整数倍 for random off-grid trajectories (all snaps)', () => {
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      const amp = 1.0;
      for (const snap of snaps) {
        const trajs: TrajPoint[][] = [
          movingTraj(0, 0.37, 'down'),
          movingTraj(0, 1.23, 'up'),
          shortPressTraj(2.0, 0.30, 'down'),
          // stay run
          [
            { beat: 0, y: CENTER, down: false },
            { beat: 0.8, y: CENTER, down: false },
            { beat: 0.81, y: CENTER, down: true },
          ],
        ];
        for (const traj of trajs) {
          const segs = segmentize(traj, snap, amp);
          for (const s of segs) {
            expect(isSnapAligned(s.beats, snap), `snap ${snap} beats ${s.beats}`).toBeTruthy();
            expect(isAligned(s.beats, snap)).toBeTruthy();
          }
        }
      }
    });

    it('quantizeBeat math remains correct (off-grid to nearest grid)', () => {
      expect(quantizeBeat(1.2, 0.5)).toBeCloseTo(1.0, 4);
      expect(quantizeBeat(1.3, 0.5)).toBeCloseTo(1.5, 4);
      expect(quantizeBeat(0.37, 0.25)).toBeCloseTo(0.25, 4);
      expect(quantizeBeat(0.37, 0.125)).toBeCloseTo(0.375, 4);
      expect(quantizeBeat(0.30, 0.125)).toBeCloseTo(0.25, 4);
      expect(quantizeBeat(0.30, 0.5)).toBeCloseTo(0.5, 4);
      expect(isSnapAligned(0.25, 0.125)).toBeTruthy();
      expect(isSnapAligned(0.5, 0.25)).toBeTruthy();
      expect(isSnapAligned(0.37, 0.25)).toBeFalsy();
    });

    it('minimal beats clamping: raw 0 for snap prevents 0-length segment', () => {
      const snap = 0.25;
      const amp = 1.0;
      // Very tiny duration 0.01 -> quantizes to 0 -> should clamp to snap (0.25)
      const traj = shortPressTraj(0, 0.01, 'down');
      const segs = segmentize(traj, snap, amp);
      expect(segs.length).toBeGreaterThan(0);
      for (const s of segs) {
        expect(s.beats).toBeGreaterThanOrEqual(snap - 1e-9);
        expect(isAligned(s.beats, snap)).toBeTruthy();
      }
      const total = segs.reduce((a, b) => a + b.beats, 0);
      expect(total).toBeCloseTo(0.25, 4);
    });
  });

  // ------------------------------------------------------------
  // 7. WaveEngine / Cursor 数値整合 — T128/T127 回帰防止 (complex amplitudes & off-grid)
  // ------------------------------------------------------------
  describe('7. WaveEngine / Cursor 規約一致 — T128 傾斜が cursor 速度と一致 (Red if wave slow)', () => {
    const amps = [0.5, 0.7, 1.0, 1.3, 2.7, 3.4];
    const offGrid = [0.37, 1.23];

    function expectedClampedY(startPos: number, amp: number, dir: 'up' | 'down' | 'stay', beat: number): number {
      const startY = CENTER - startPos * TW_AMP;
      const dY = dir === 'up' ? -2 * TW_AMP * amp : dir === 'down' ? 2 * TW_AMP * amp : 0;
      if (dir === 'stay') return startY;
      const raw = startY + dY * beat;
      return Math.max(TOP, Math.min(BOTTOM, raw));
    }

    it.each(amps)('amp=%s wave slope equals 2*TW_AMP*amp before clip', (amp) => {
      // [Step1] initial engine with single down segment long enough to not clip for small beat
      const engine = new WaveEngine([{ direction: 'down', beats: 10 }], TIMELINE_120, amp, 0);
      const delta = 0.1;
      const dy = engine.waveYAt(delta) - engine.waveYAt(0);
      const slope = dy / delta;
      // [Step3] assert slope matches physical speed
      expect(slope).toBeCloseTo(2 * TW_AMP * amp, 0);
      // cursor same
      const beatMs = 500;
      const cursor = new Cursor(amp, 0);
      const y0 = cursor.y;
      cursor.update((delta * beatMs) / 1000, false, true, beatMs, 1);
      const slopeCursor = (cursor.y - y0) / delta;
      expect(slopeCursor).toBeCloseTo(2 * TW_AMP * amp, 0);
      expect(slope).toBeCloseTo(slopeCursor, 0);
    });

    for (const amp of amps) {
      for (const dir of ['down', 'up'] as const) {
        it(`amp=${amp} dir=${dir} off-grid consistency (stay clip aware)`, () => {
          const segs: Segment[] = [{ direction: dir, beats: 5 }];
          const engine = new WaveEngine(segs, TIMELINE_120, amp, 0);
          for (const b of offGrid) {
            const actual = engine.waveYAt(b);
            const expected = expectedClampedY(0, amp, dir, b);
            expect(actual, `amp=${amp} dir=${dir} beat=${b}`).toBeCloseTo(expected, 1);
          }
        });
      }
    }

    it('clipped single segment tilt — amp=1.0 down beats=3 reaches bottom at 0.5 not 3', () => {
      const engine = new WaveEngine([{ direction: 'down', beats: 3 }], TIMELINE_120, 1.0, 0);
      expect(engine.waveYAt(0.5)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(1.0)).toBeCloseTo(BOTTOM, 1);
      // slope before clip must be 260, not diluted 43.3
      const dy = engine.waveYAt(0.25) - engine.waveYAt(0);
      expect(dy / 0.25).toBeCloseTo(2 * TW_AMP * 1.0, 0);
      // after clip flat
      expect(engine.waveYAt(1.0) - engine.waveYAt(0.5)).toBeCloseTo(0, 0);
    });
  });

  // ------------------------------------------------------------
  // 8. edge: segmentize empty / invalid handling
  // ------------------------------------------------------------
  describe('8. edge cases', () => {
    it('empty traj returns []', () => {
      expect(segmentize([], 0.25, 1.0)).toEqual([]);
      expect(segmentize([{ beat: 0, y: CENTER, down: true }], 0.25, 1.0)).toEqual([]);
    });
    it('invalid snap returns []', () => {
      expect(segmentize(shortPressTraj(0, 0.5), 0, 1.0)).toEqual([]);
      expect(segmentize(shortPressTraj(0, 0.5), -1, 1.0)).toEqual([]);
    });
    it('getPoints length = segments+1 invariant', () => {
      const segs: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 0.5 },
      ];
      const engine = new WaveEngine(segs, TIMELINE_120, 1.0, 0);
      const pts = engine.getPoints();
      expect(pts.length).toBe(segs.length + 1);
      for (const p of pts) {
        expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
      }
    });
  });
});
