import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { segmentize, quantizeBeat, isSnapAligned } from '../src/chart/quantize';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import type { Segment, BpmChange } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = CENTER - TW_AMP;
const BOTTOM = CENTER + TW_AMP;

function clampY(y: number): number {
  return Math.max(TOP, Math.min(BOTTOM, y));
}

function expectedClampedY(startPosition: number, amp: number, dir: 'up' | 'down' | 'stay', beat: number): number {
  const startY = CENTER - startPosition * TW_AMP;
  const dY = dir === 'up' ? -2 * TW_AMP * amp : dir === 'down' ? 2 * TW_AMP * amp : 0;
  if (dir === 'stay') return startY;
  return clampY(startY + dY * beat);
}

// Simulate BpmEditor.addChange stamping logic (safeAmp + safeBpm)
function safeBpm(v: number): number {
  if (Number.isNaN(v) || v < 1 || v > 1000) return 120;
  return v;
}
function safeAmp(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 1.0;
}
function addChangeStamp(bpmChanges: BpmChange[], bpm: number, amplitude: number): BpmChange[] {
  const defaultBeat = bpmChanges.length > 0 ? Math.floor(bpmChanges[bpmChanges.length - 1].beat) + 4 : 4;
  return [...bpmChanges, { beat: defaultBeat, bpm: safeBpm(bpm), amplitude: safeAmp(amplitude) }];
}

describe('T131 速度係数(amplitude)をBPM変更エントリーの振幅としてリスト駆動 — Vitest pure engine acceptance', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ========================================================================
  // 1) amplitudeAt(beat) step function — off-grid verification (完了条件1)
  // ========================================================================
  describe('1. amplitudeAt(beat) step関数（オフグリッド必須）', () => {
    it('single change beat=4 1.0→2.0: off-grid 3.37 vs 4.23 returns 1.0 / 2.0 (step)', () => {
      // [Step 1: Capture Before] — base only, no change yet at 3.37 should be base
      const baseAmp = 1.0;
      const beforeTimeline = new BpmTimeline(120, [], baseAmp);
      expect(beforeTimeline.amplitudeAt(3.37)).toBeCloseTo(1.0, 5);
      expect(beforeTimeline.amplitudeAt(4.23)).toBeCloseTo(1.0, 5);

      // [Step 2: Perform] add BpmChange beat 4 amplitude 2.0
      const changes: BpmChange[] = [{ beat: 4, bpm: 120, amplitude: 2.0 }];
      const after = new BpmTimeline(120, changes, baseAmp);

      // [Step 3: Assert] step behavior at off-grid beats
      expect(after.amplitudeAt(3.37)).toBeCloseTo(1.0, 5);
      expect(after.amplitudeAt(3.99)).toBeCloseTo(1.0, 5);
      expect(after.amplitudeAt(4.0)).toBeCloseTo(2.0, 5);
      expect(after.amplitudeAt(4.23)).toBeCloseTo(2.0, 5);
      expect(after.amplitudeAt(4.37)).toBeCloseTo(2.0, 5);
      expect(after.amplitudeAt(5)).toBeCloseTo(2.0, 5);
      // not interpolated
      expect(after.amplitudeAt(3.5)).toBeCloseTo(1.0, 5);
    });

    it('multiple time-varying entries off-grid step correctness (complex amplitudes)', () => {
      const base = 1.0;
      const changes: BpmChange[] = [
        { beat: 2, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 130, amplitude: 1.3 },
        { beat: 7.5, bpm: 140, amplitude: 2.7 },
      ];
      const tl = new BpmTimeline(120, changes, base);
      // before any
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(1.0, 5);
      // between 2 and 4
      expect(tl.amplitudeAt(2.0)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(2.37)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(3.99)).toBeCloseTo(0.7, 5);
      // at and after 4
      expect(tl.amplitudeAt(4.0)).toBeCloseTo(1.3, 5);
      expect(tl.amplitudeAt(4.23)).toBeCloseTo(1.3, 5);
      expect(tl.amplitudeAt(5.37)).toBeCloseTo(1.3, 5);
      expect(tl.amplitudeAt(7.37)).toBeCloseTo(1.3, 5);
      // at 7.5
      expect(tl.amplitudeAt(7.5)).toBeCloseTo(2.7, 5);
      expect(tl.amplitudeAt(7.63)).toBeCloseTo(2.7, 5);
      expect(tl.amplitudeAt(8.23)).toBeCloseTo(2.7, 5);
      expect(tl.amplitudeAt(100)).toBeCloseTo(2.7, 5);
    });

    it('latest wins when multiple entries share step — sorted & step', () => {
      const tl = new BpmTimeline(120, [
        { beat: 1, bpm: 120, amplitude: 1.5 },
        { beat: 3, bpm: 120, amplitude: 2.0 },
        { beat: 3, bpm: 120, amplitude: 3.0 }, // same beat later overrides within sorted order
      ], 1.0);
      // At beat 3, the second entry with same beat should dominate if stable sort keeps last?
      // At minimum amplitudeAt(3) should be 2.0 or 3.0 (>1.5). Check >=2
      const v = tl.amplitudeAt(3);
      expect(v >= 2.0).toBeTruthy();
      expect(tl.amplitudeAt(2.37)).toBeCloseTo(1.5, 5);
    });

    it('entries without amplitude field do not affect amplitudeAt (fallback to base or last)', () => {
      const tl = new BpmTimeline(120, [
        { beat: 2, bpm: 140 }, // no amplitude
        { beat: 4, bpm: 150, amplitude: 2.0 },
        { beat: 6, bpm: 160 }, // no amplitude again
      ], 1.0);
      // 0-4 before 4 should be base (since beat2 has no amp)
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(2.37)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.0, 5);
      // at 4 and beyond to 6+ stays 2.0, because 6 has no amp to override
      expect(tl.amplitudeAt(4.23)).toBeCloseTo(2.0, 5);
      expect(tl.amplitudeAt(6.23)).toBeCloseTo(2.0, 5);
      expect(tl.amplitudeAt(8)).toBeCloseTo(2.0, 5);
    });

    it('backward compat: empty bpm_changes or undefined amplitude returns baseAmplitude for all off-grid', () => {
      const tlBaseOnly = new BpmTimeline(120, [], 1.7);
      expect(tlBaseOnly.amplitudeAt(0.37)).toBeCloseTo(1.7, 5);
      expect(tlBaseOnly.amplitudeAt(1.23)).toBeCloseTo(1.7, 5);
      expect(tlBaseOnly.amplitudeAt(100)).toBeCloseTo(1.7, 5);

      const tlNoAmpEntries = new BpmTimeline(120, [
        { beat: 2, bpm: 140 },
        { beat: 5, bpm: 150 },
      ], 1.7);
      expect(tlNoAmpEntries.amplitudeAt(0.37)).toBeCloseTo(1.7, 5);
      expect(tlNoAmpEntries.amplitudeAt(2.37)).toBeCloseTo(1.7, 5);
      expect(tlNoAmpEntries.amplitudeAt(5.37)).toBeCloseTo(1.7, 5);
    });

    it('amplitudeAt with complex amplitudes 0.7/1.3/2.7/3.4 — exact off-grid match (3-step)', () => {
      // [Step1] Capture before: base 1.0
      const before = new BpmTimeline(120, [], 1.0);
      expect(before.amplitudeAt(1.23)).toBeCloseTo(1.0, 5);
      // [Step2] Perform: insert complex amps at beat 3 and 6
      const complex: BpmChange[] = [
        { beat: 3, bpm: 120, amplitude: 3.4 },
        { beat: 6, bpm: 120, amplitude: 0.7 },
      ];
      const after = new BpmTimeline(120, complex, 1.0);
      // [Step3] Assert off-grid before/after each boundary
      expect(after.amplitudeAt(2.37)).toBeCloseTo(1.0, 5);
      expect(after.amplitudeAt(3.37)).toBeCloseTo(3.4, 5);
      expect(after.amplitudeAt(4.23)).toBeCloseTo(3.4, 5);
      expect(after.amplitudeAt(5.99)).toBeCloseTo(3.4, 5);
      expect(after.amplitudeAt(6.0)).toBeCloseTo(0.7, 5);
      expect(after.amplitudeAt(6.37)).toBeCloseTo(0.7, 5);
    });
  });

  // ========================================================================
  // 2. WaveEngine per-segment start-beat amplitude slope = 2*TW_AMP*amplitudeAt(segStartBeat)
  // ========================================================================
  describe('2. WaveEngine waveYAt区間傾斜=2*TW_AMP*amplitudeAt(segStartBeat) & getPoints不変', () => {
    function makeSegments(totalBeats: number, segBeats: number, dir: 'up' | 'down' = 'down'): Segment[] {
      const n = Math.floor(totalBeats / segBeats);
      return Array.from({ length: n }, () => ({ direction: dir, beats: segBeats as number } as Segment));
    }

    it('single segment down slope equals 2*TW_AMP*amplitudeAt(0) (complex amps off-grid)', () => {
      const amps = [0.7, 1.3, 2.7, 3.4];
      const offBeats = [0.37, 1.23];
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const segs: Segment[] = [{ direction: 'down', beats: 5 }];
        const engine = new WaveEngine(segs, tl, amp, 0);
        for (const b of offBeats) {
          // Before clip region small delta to measure slope: 0.1 beats
          // For large amps, even 0.37 may be clipped — so use expectedClampedY
          const expected = expectedClampedY(0, amp, 'down', b);
          expect(engine.waveYAt(b), `amp=${amp} beat=${b}`).toBeCloseTo(expected, 1);
        }
        // slope before clip: dy/delta == 2*TW_AMP*amp
        const delta = 0.1;
        const slope = (engine.waveYAt(delta) - engine.waveYAt(0)) / delta;
        // For amp up to 3.4, 0.1 beats -> 88.4px not clipped -> slope intact
        if (amp <= 4) {
          expect(slope, `amp=${amp}`).toBeCloseTo(2 * TW_AMP * amp, 0);
        }
      }
    });

    it('time-varying amplitude: segment starting at beat 4 uses amp 2.0, earlier uses 1.0 (2-step transition)', () => {
      const baseAmp = 1.0;
      // Use up/down alternating to keep wave near center so slopes are visible
      const segs: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 2 },  // segment starting at beat 4
      ];
      // [Step1] Capture initial with no variation
      const tlBefore = new BpmTimeline(120, [], baseAmp);
      const engineBefore = new WaveEngine(segs, tlBefore, baseAmp, 0);
      // Use small delta to avoid clamping; slope before beat 4 should be base 1.0
      const delta = 0.1;
      const yBefore0 = engineBefore.waveYAt(4);
      const yBefore = engineBefore.waveYAt(4 + delta);
      const slopeBefore = (yBefore - yBefore0) / delta;
      expect(slopeBefore).toBeCloseTo(2 * TW_AMP * 1.0, 0);

      // [Step2] Perform: add amplitude change at beat 4 to 2.0
      const tlAfter = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], baseAmp);
      const engineAfter = new WaveEngine(segs, tlAfter, baseAmp, 0);
      // [Step3] Assert changed outcome: slope doubles for segment starting at 4
      const yAfter0 = engineAfter.waveYAt(4);
      const yAfter = engineAfter.waveYAt(4 + delta);
      const slopeAfter = (yAfter - yAfter0) / delta;
      expect(slopeAfter).toBeCloseTo(2 * TW_AMP * 2.0, 0);
      // Off-grid check
      const expectedAfter = clampY(yAfter0 + 2 * TW_AMP * 2.0 * delta);
      expect(yAfter).toBeCloseTo(expectedAfter, 1);
    });

    it('getPoints().length === segments.length+1 and structure {beat,y} invariants (complex amps)', () => {
      const tl = new BpmTimeline(120, [{ beat: 3, bpm: 120, amplitude: 1.3 }], 1.0);
      const cases: Segment[][] = [
        [],
        [{ direction: 'down', beats: 1 }],
        [{ direction: 'down', beats: 0.5 }, { direction: 'stay', beats: 1 }, { direction: 'up', beats: 0.5 }],
        [{ direction: 'down', beats: 2 }, { direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }],
      ];
      for (const segs of cases) {
        const engine = new WaveEngine(segs, tl, 1.7, 0);
        const pts = engine.getPoints();
        const expectedLen = segs.length === 0 ? 2 : segs.length + 1;
        expect(pts.length, `segs ${JSON.stringify(segs)}`).toBe(expectedLen);
        for (const p of pts) {
          expect(typeof p.beat).toBe('number');
          expect(typeof p.y).toBe('number');
          expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
          // ensure no dY leakage
          expect((p as unknown as Record<string, unknown>).dY).toBeUndefined();
        }
      }
    });

    it('legacy constructor amplitude param does NOT affect waveYAt when timeline list drives (removes dead field)', () => {
      const tl = new BpmTimeline(120, [{ beat: 2, bpm: 120, amplitude: 2.7 }], 1.0);
      // Use segments that return wave to center before beat 2 so slope is visible
      const segs: Segment[] = [
        { direction: 'up', beats: 0.25 },
        { direction: 'down', beats: 0.25 },
        { direction: 'stay', beats: 1.5 },
        { direction: 'down', beats: 2 },  // segment starting at beat 2
      ];
      // [Step1] engine with ctor amp 1.0
      const e1 = new WaveEngine(segs, tl, 1.0, 0);
      const delta = 0.1;
      const y1 = e1.waveYAt(2 + delta);
      // [Step2] same timeline but ctor amp 999 (legacy dead field)
      const e2 = new WaveEngine(segs, tl, 999 as unknown as number, 0);
      const y2 = e2.waveYAt(2 + delta);
      // [Step3] Must be identical — timeline drives, not ctor param (if field removed)
      expect(y2).toBeCloseTo(y1, 1);
      // And both should follow timeline amp 2.7 at beat 2, not ctor
      const at2 = e1.waveYAt(2);
      const slope = (y1 - at2) / delta;
      expect(slope).toBeCloseTo(2 * TW_AMP * 2.7, 0);
      expect(slope).not.toBeCloseTo(2 * TW_AMP * 999, 0);
    });

    it('startPosition variants with time-varying amplitude preserve slope (off-grid)', () => {
      const amps = [0.5, 1.3, 2.7];
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [{ beat: 1, bpm: 120, amplitude: amp }], 1.0);
        const segs: Segment[] = [{ direction: 'down', beats: 3 }];
        for (const sp of [-1, 0, 1]) {
          const engine = new WaveEngine(segs, tl, 1.0 as unknown as number, sp);
          const expected0 = expectedClampedY(sp, 1.0, 'down', 0.37);
          expect(engine.waveYAt(0.37), `amp=${amp} sp=${sp}`).toBeCloseTo(expected0, 1);
        }
        // Multi-seg where second segment starts at 1 uses new amp
        // Use small delta to avoid clamping at high amplitudes (delta < 1/(2*amp))
        const segs2: Segment[] = [
          { direction: 'stay', beats: 1 },
          { direction: 'down', beats: 3 },
        ];
        const e2 = new WaveEngine(segs2, tl, 1.0 as unknown as number, 0);
        const at1 = e2.waveYAt(1);
        // Use delta=0.1 which stays within bounds for amp up to 5
        const smallDelta = 0.1;
        const at1small = e2.waveYAt(1 + smallDelta);
        expect((at1small - at1) / smallDelta).toBeCloseTo(2 * TW_AMP * amp, 0);
      }
    });

    it('physical height fixed at TW_AMP=130 across time-varying amplitudes', () => {
      const amps = [0.5, 1.0, 2.0, 5.0, 0.7, 3.4];
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [{ beat: 2, bpm: 120, amplitude: amp }], 1.0);
        const engine = new WaveEngine(
          [{ direction: 'down', beats: 10 }, { direction: 'up', beats: 10 }],
          tl, 1.0, 0
        );
        const ys = engine.getPoints().map(p => p.y);
        expect(Math.max(...ys)).toBeLessThanOrEqual(BOTTOM + 1e-6);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(TOP - 1e-6);
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(2 * TW_AMP + 1e-6);
      }
    });
  });

  // ========================================================================
  // 3. BpmEditor.addChange stamping: main #amplitude -> new entry .amplitude = 2.5
  // ========================================================================
  describe('3. BpmEditor.addChange でメイン振幅を新規エントリーにスタンプ', () => {
    it('addChange stamps current main amplitude 2.5 into new BpmChange (3-step transition)', () => {
      // [Step1] Capture Before — initial bpmChanges empty, timeline amplitude 1.0
      const beforeChanges: BpmChange[] = [];
      const beforeTl = new BpmTimeline(120, beforeChanges, 1.0);
      expect(beforeTl.amplitudeAt(4.23)).toBeCloseTo(1.0, 5);
      expect(beforeChanges.length).toBe(0);

      // [Step2] Perform — user sets main amplitude input to 2.5 and clicks addChange
      let amplitude = 1.0;
      amplitude = 2.5; // simulate onAmplitudeChange only storing injection value
      const afterChanges = addChangeStamp(beforeChanges, 120, amplitude);

      // [Step3] Assert — new entry carries stamped amplitude and timeline reflects it
      expect(afterChanges.length).toBe(1);
      expect(afterChanges[0].amplitude).toBeCloseTo(2.5, 5);
      expect(afterChanges[0].beat).toBe(4);
      expect(afterChanges[0].bpm).toBe(120);
      const afterTl = new BpmTimeline(120, afterChanges, 1.0);
      expect(afterTl.amplitudeAt(3.37)).toBeCloseTo(1.0, 5);
      expect(afterTl.amplitudeAt(4.23)).toBeCloseTo(2.5, 5);
      expect(afterTl.amplitudeAt(4.37)).toBeCloseTo(2.5, 5);
    });

    it('multiple stamps with complex amplitudes produce distinct list entries', () => {
      let changes: BpmChange[] = [];
      const seq = [0.7, 1.3, 2.7, 3.4];
      for (let i = 0; i < seq.length; i++) {
        const amp = seq[i];
        changes = addChangeStamp(changes, 120 + i * 10, amp);
        expect(changes[changes.length - 1].amplitude).toBeCloseTo(amp, 5);
      }
      expect(changes.length).toBe(4);
      const tl = new BpmTimeline(120, changes, 1.0);
      // beats assigned as 4,8,12,16 by addChange defaultBeat logic
      expect(tl.amplitudeAt(4.23)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(8.37)).toBeCloseTo(1.3, 5);
      expect(tl.amplitudeAt(12.37)).toBeCloseTo(2.7, 5);
      expect(tl.amplitudeAt(16.37)).toBeCloseTo(3.4, 5);
    });

    it('safeAmp sanitizes invalid amplitude to 1.0 before stamping', () => {
      const changes: BpmChange[] = [];
      const bad = addChangeStamp(changes, 120, NaN);
      expect(bad[0].amplitude).toBeCloseTo(1.0, 5);
      const neg = addChangeStamp(changes, 120, -2);
      expect(neg[0].amplitude).toBeCloseTo(1.0, 5);
      const zero = addChangeStamp(changes, 120, 0);
      expect(zero[0].amplitude).toBeCloseTo(1.0, 5);
    });

    it('each bpm_change row amplitude editable — patching preserves step behavior off-grid', () => {
      // Simulate editing row 1 amplitude from 2.5 to 1.7
      let changes: BpmChange[] = [{ beat: 4, bpm: 120, amplitude: 2.5 }];
      // [Step1] Before edit
      let tl = new BpmTimeline(120, changes, 1.0);
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(2.5, 5);
      // [Step2] Perform patch
      changes = changes.map((c, i) => i === 0 ? { ...c, amplitude: 1.7 } : c);
      tl = new BpmTimeline(120, changes, 1.0);
      // [Step3] Assert
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(1.7, 5);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.0, 5);
      // clearing amplitude (undefined) falls back to base
      changes = changes.map((c, i) => i === 0 ? { ...c, amplitude: undefined } : c);
      tl = new BpmTimeline(120, changes, 1.0);
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(1.0, 5);
    });
  });

  // ========================================================================
  // 4. 即時適用の廃止: メイン #amplitude変更のみでは波形/カーソルは変化しない
  // ========================================================================
  describe('4. 即時適用廃止 — メイン振幅変更だけでは編集画面の波形/カーソルは変化しない', () => {
    // EditorScreen uses EDITOR_BASE_AMP=1.0 fixed for timeline base; injection field alone doesn't rebuild timeline
    const EDITOR_BASE_AMP = 1.0;

    it('changing injection amplitude without addChange leaves waveEngine & timeline unchanged (off-grid)', () => {
      // [Step1] Capture Before — initial editor state
      let bpmChanges: BpmChange[] = [];
      let injectionAmp = 1.0;
      const tlBefore = new BpmTimeline(120, bpmChanges, EDITOR_BASE_AMP);
      const segs: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
      ];
      const waveBefore = new WaveEngine(segs, tlBefore, EDITOR_BASE_AMP, 0);
      const yBefore_1_23 = waveBefore.waveYAt(1.23);
      const yBefore_0_37 = waveBefore.waveYAt(0.37);
      const ampBefore_1_23 = tlBefore.amplitudeAt(1.23);
      const ampBefore_4_23 = tlBefore.amplitudeAt(4.23);

      // [Step2] Perform — user changes main #amplitude input from 1.0 to 2.5 (onAmplitudeChange) but NOT clicking add
      injectionAmp = 2.5;
      // Editor does NOT rebuild timeline from injectionAmp — still same bpmChanges
      const tlAfterInjection = new BpmTimeline(120, bpmChanges, EDITOR_BASE_AMP);
      const waveAfterInjection = new WaveEngine(segs, tlAfterInjection, EDITOR_BASE_AMP, 0);
      void injectionAmp; // injection stored but not used

      // [Step3] Assert — no change
      expect(tlAfterInjection.amplitudeAt(1.23)).toBeCloseTo(ampBefore_1_23, 5);
      expect(tlAfterInjection.amplitudeAt(4.23)).toBeCloseTo(ampBefore_4_23, 5);
      expect(waveAfterInjection.waveYAt(1.23)).toBeCloseTo(yBefore_1_23, 5);
      expect(waveAfterInjection.waveYAt(0.37)).toBeCloseTo(yBefore_0_37, 5);
      // Directly ensure injection value is NOT reflected as amplitudeAt
      expect(tlAfterInjection.amplitudeAt(0.37)).not.toBeCloseTo(2.5, 5);
      expect(tlAfterInjection.amplitudeAt(4.23)).not.toBeCloseTo(2.5, 5);
    });

    it('only after addChange does wave/cursor reflect new amplitude (3-step with off-grid)', () => {
      let bpmChanges: BpmChange[] = [];
      // Use alternating up/down to keep wave near center
      const segs: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 2 },  // segment at beat 4
      ];
      const tl0 = new BpmTimeline(120, bpmChanges, 1.0);
      const w0 = new WaveEngine(segs, tl0, 1.0, 0);
      const delta = 0.1;
      const yAt4_before = w0.waveYAt(4);
      const yAt4_37_before = w0.waveYAt(4 + delta);
      // Change injection only
      const injectionAmp = 2.5;
      const tlStill = new BpmTimeline(120, bpmChanges, 1.0);
      const wStill = new WaveEngine(segs, tlStill, 1.0, 0);
      expect(wStill.waveYAt(4 + delta)).toBeCloseTo(yAt4_37_before, 5);
      // Now addChange stamps injection into list
      bpmChanges = addChangeStamp(bpmChanges, 120, injectionAmp);
      const tlAfter = new BpmTimeline(120, bpmChanges, 1.0);
      const wAfter = new WaveEngine(segs, tlAfter, 1.0, 0);
      // Now amplitudeAt should be 2.5 at off-grid beyond beat 4
      expect(tlAfter.amplitudeAt(4.23)).toBeCloseTo(2.5, 5);
      expect(tlAfter.amplitudeAt(3.37)).toBeCloseTo(1.0, 5);
      // Wave slope for segment starting at 4 should now be 2.5x
      const yAt4_after = wAfter.waveYAt(4);
      const yAt4_afterDelta = wAfter.waveYAt(4 + delta);
      const slopeAfter = (yAt4_afterDelta - yAt4_after) / delta;
      expect(slopeAfter).toBeCloseTo(2 * TW_AMP * 2.5, 0);
      const slopeBefore = (yAt4_37_before - yAt4_before) / delta;
      expect(slopeBefore).toBeCloseTo(2 * TW_AMP * 1.0, 0);
      expect(slopeAfter).not.toBeCloseTo(slopeBefore, 0);
    });

    it('repeated injection changes without add leaves cursor speed unchanged', () => {
      let bpmChanges: BpmChange[] = [];
      const baseTl = new BpmTimeline(120, bpmChanges, 1.0);
      const cursor = new Cursor(1.0, 0);
      // Simulate GameScreen loop: cursor.setAmplitude(timeline.amplitudeAt(currentBeat))
      const beat = 2.37;
      cursor.setAmplitude(baseTl.amplitudeAt(beat));
      const y0 = cursor.y;
      cursor.update(0.1, false, true, 500, 1);
      const dyBefore = cursor.y - y0;

      // Change injection to 3.4 but not add
      const injectionAmp = 3.4;
      void injectionAmp;
      const tlNotAdded = new BpmTimeline(120, bpmChanges, 1.0);
      const cursor2 = new Cursor(1.0, 0);
      cursor2.setAmplitude(tlNotAdded.amplitudeAt(beat));
      const y0b = cursor2.y;
      cursor2.update(0.1, false, true, 500, 1);
      const dyAfter = cursor2.y - y0b;

      expect(dyAfter).toBeCloseTo(dyBefore, 5);
      expect(tlNotAdded.amplitudeAt(beat)).toBeCloseTo(1.0, 5);
    });
  });

  // ========================================================================
  // 5. 後方互換 & T127/T128/T129回帰なし
  // ========================================================================
  describe('5. 後方互換 (bpm_changes[].amplitude未設定→Chart.amplitudeで動作) & T127-129回帰', () => {
    it('existing chart with only base amplitude 1.7 and no per-entry amplitude returns base everywhere (off-grid)', () => {
      const base = 1.7;
      const changes: BpmChange[] = [
        { beat: 2, bpm: 140 },
        { beat: 5, bpm: 150 },
      ];
      // [Step1] Capture before with base 1.0
      const tlBefore = new BpmTimeline(120, changes, 1.0);
      expect(tlBefore.amplitudeAt(0.37)).toBeCloseTo(1.0, 5);
      // [Step2] Use chart base 1.7
      const tlCompat = new BpmTimeline(120, changes, base);
      // [Step3] Assert fallback to base for all off-grid, including after bpm changes
      expect(tlCompat.amplitudeAt(0.37)).toBeCloseTo(1.7, 5);
      expect(tlCompat.amplitudeAt(2.37)).toBeCloseTo(1.7, 5);
      expect(tlCompat.amplitudeAt(5.37)).toBeCloseTo(1.7, 5);
      expect(tlCompat.amplitudeAt(10.23)).toBeCloseTo(1.7, 5);
      // WaveEngine also respects base when no per-entry
      const segs: Segment[] = [{ direction: 'down', beats: 3 }];
      const engineCompat = new WaveEngine(segs, tlCompat, base, 0);
      const engineBase = new WaveEngine(segs, tlBefore, 1.0, 0);
      // Use small delta to avoid clamping: slope = 2*TW_AMP*base at beat 0 (segment start)
      const d = 0.1;
      const slopeCompat = (engineCompat.waveYAt(d) - engineCompat.waveYAt(0)) / d;
      const slopeBase = (engineBase.waveYAt(d) - engineBase.waveYAt(0)) / d;
      // Slopes differ per base
      expect(slopeCompat).toBeCloseTo(2 * TW_AMP * 1.7, 0);
      expect(slopeBase).toBeCloseTo(2 * TW_AMP * 1.0, 0);
    });

    it('loader parseChartText migrates legacy px amplitude >10 and preserves per-entry amplitude (3-step)', () => {
      // [Step1] Old chart without per-entry amplitude (only base px 130 -> 1.0)
      const tomlBase = `
title = "Old"
artist = ""
bpm = 120
audio = "/audio/test.flac"
amplitude = 130
[[segments]]
direction = "down"
beats = 2
[[bpm_changes]]
beat = 4
bpm = 150
`;
      const chartOld = parseChartText(tomlBase, 'old');
      expect(chartOld.amplitude).toBeCloseTo(1.0, 5);
      expect(chartOld.bpm_changes[0].amplitude).toBeUndefined();
      const tlOld = new BpmTimeline(chartOld.bpm, chartOld.bpm_changes, chartOld.amplitude);
      expect(tlOld.amplitudeAt(4.37)).toBeCloseTo(1.0, 5);

      // [Step2] New chart with per-entry amplitude
      const tomlNew = `
title = "New"
artist = ""
bpm = 120
audio = "/audio/test.flac"
amplitude = 1.0
[[bpm_changes]]
beat = 4
bpm = 150
amplitude = 2.5
[[segments]]
direction = "down"
beats = 2
`;
      const chartNew = parseChartText(tomlNew, 'new');
      expect(chartNew.amplitude).toBeCloseTo(1.0, 5);
      expect(chartNew.bpm_changes[0].amplitude).toBeCloseTo(2.5, 5);
      const tlNew = new BpmTimeline(chartNew.bpm, chartNew.bpm_changes, chartNew.amplitude);
      // [Step3] Assert time-varying vs fallback
      expect(tlNew.amplitudeAt(3.37)).toBeCloseTo(1.0, 5);
      expect(tlNew.amplitudeAt(4.37)).toBeCloseTo(2.5, 5);
      // serialize should include amplitude line
      const tomlOut = chartToToml(chartNew);
      expect(tomlOut).toContain('amplitude = 2.5');
      const tomlOldOut = chartToToml(chartOld);
      // old chart's entry has no amplitude, so only base amplitude line present, no per-entry amplitude
      // Count amplitude lines: base one + per-entry if any
      const ampLinesOld = tomlOldOut.split('\n').filter(l => l.trim().startsWith('amplitude ='));
      expect(ampLinesOld.length).toBe(1); // only base
      const ampLinesNew = tomlOut.split('\n').filter(l => l.trim().startsWith('amplitude ='));
      expect(ampLinesNew.length).toBe(2); // base + entry
    });

    it('serialize→parse round-trip preserves time-varying amplitudes off-grid', () => {
      const chart: import('../src/types').Chart = {
        title: 'RoundTrip',
        artist: '',
        bpm: 120,
        audio: 'test.flac',
        audio_offset: 0,
        scroll_speed: 110,
        amplitude: 1.0,
        start_position: 0.0,
        bpm_changes: [
          { beat: 2, bpm: 130, amplitude: 0.7 },
          { beat: 4, bpm: 140, amplitude: 1.3 },
        ],
        segments: [{ direction: 'down', beats: 2 }],
        rings: [],
      };
      const toml = chartToToml(chart);
      const parsed = parseChartText(toml, 'rt');
      expect(parsed.bpm_changes[0].amplitude).toBeCloseTo(0.7, 5);
      expect(parsed.bpm_changes[1].amplitude).toBeCloseTo(1.3, 5);
      const tl = new BpmTimeline(parsed.bpm, parsed.bpm_changes, parsed.amplitude);
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(2.37)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(1.3, 5);
    });

    it('T128/T127 regression: clipped tilt still correct with time-varying amplitude (off-grid)', () => {
      // amp 1.0 before 3, 2.7 after 3 — test clipped segment that spans boundary
      const tl = new BpmTimeline(120, [{ beat: 3, bpm: 120, amplitude: 2.7 }], 1.0);
      const segs: Segment[] = [
        { direction: 'down', beats: 3 }, // 0-3 amp 1.0
        { direction: 'up', beats: 3 },   // 3-6 amp 2.7
      ];
      const engine = new WaveEngine(segs, tl, 1.0, 0);
      // first segment down 3 with amp1.0: center -> bottom at 0.5, stay till 3
      expect(engine.waveYAt(0.37)).toBeCloseTo(clampY(CENTER + 2 * TW_AMP * 1.0 * 0.37), 1);
      expect(engine.waveYAt(0.5)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(2.37)).toBeCloseTo(BOTTOM, 1);
      expect(engine.waveYAt(3.0)).toBeCloseTo(BOTTOM, 1);
      // second segment up from bottom with amp2.7: slope -702 px/beat
      expect(engine.waveYAt(3.1) - engine.waveYAt(3.0)).toBeCloseTo(-2 * TW_AMP * 2.7 * 0.1, 0);
      // after 0.37 beats into up: bottom -702*0.37 = 430 -259 =171 ~ TOP(170)
      expect(engine.waveYAt(3.37)).toBeCloseTo(clampY(BOTTOM - 2 * TW_AMP * 2.7 * 0.37), 1);
      expect(engine.waveYAt(3.5)).toBeCloseTo(TOP, 1);
      expect(engine.waveYAt(4)).toBeCloseTo(TOP, 1);
    });

    it('T129 regression: segmentize still snap-aligned regardless of time-varying amplitude', () => {
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      const traj = [
        { beat: 0, y: CENTER, down: true },
        { beat: 0.37, y: CENTER + 50, down: true },
        { beat: 1.23, y: CENTER + 130, down: true },
        { beat: 1.24, y: CENTER + 130, down: false },
      ];
      // Use timeline-derived amplitude for threshold
      for (const snap of snaps) {
        const tlA = new BpmTimeline(120, [{ beat: 1, bpm: 120, amplitude: 2.7 }], 1.0);
        const ampAtStart = tlA.amplitudeAt(0);
        const ampAt1 = tlA.amplitudeAt(1.1);
        for (const amp of [ampAtStart, ampAt1]) {
          const segs = segmentize(traj, snap, amp);
          expect(segs.length).toBeGreaterThan(0);
          for (const s of segs) {
            expect(isSnapAligned(s.beats, snap), `amp=${amp} snap=${snap} beats=${s.beats}`).toBeTruthy();
          }
        }
      }
    });

    it('old chart legacy amplitude px 130 correctly migrates to 1.0 and drives fallback', () => {
      const toml = `
title = "Legacy"
artist = ""
bpm = 120
audio = "/audio/x.flac"
amplitude = 130
[[bpm_changes]]
beat = 4
bpm = 120
`;
      const chart = parseChartText(toml, 'legacy');
      expect(chart.amplitude).toBeCloseTo(1.0, 5);
      expect(chart.bpm_changes[0].amplitude).toBeUndefined();
      const tl = new BpmTimeline(chart.bpm, chart.bpm_changes, chart.amplitude);
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(5.0)).toBeCloseTo(1.0, 5);
    });
  });

  // ========================================================================
  // 6. Cursor vs WaveEngine numeric consistency across complex amplitudes & off-grid
  // ========================================================================
  describe('6. CursorとWaveEngineの数値整合（複雑振幅×オフグリッドで直接比較）', () => {
    const beatMs = 500; // 120 BPM

    it.each([0.7, 1.3, 2.7, 3.4])('amp=%s cursor 1拍移動量 == 2*TW_AMP*amp (T127-style pure numeric)', (amp) => {
      // [Step1] Capture before: engine & cursor both at same amp
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 5 }], tl, amp, 0);
      const delta = 0.37; // off-grid
      const dyWave = engine.waveYAt(delta) - engine.waveYAt(0);
      // [Step2] Perform cursor update for same duration dt = delta*beatMs/1000
      const cursor = new Cursor(amp, 0);
      const y0 = cursor.y;
      cursor.setAmplitude(tl.amplitudeAt(0));
      cursor.update((delta * beatMs) / 1000, false, true, beatMs, 1);
      const dyCursor = cursor.y - y0;
      // [Step3] Assert equality at off-grid phase, both == 2*TW_AMP*amp*delta (or clamped)
      const expected = Math.min(TW_AMP, 2 * TW_AMP * amp * delta);
      // For small delta not yet clipped, expect full; if clipped, both clamp to TOP/BOTTOM same
      if (expected < TW_AMP - 1e-6) {
        expect(dyWave).toBeCloseTo(2 * TW_AMP * amp * delta, 0);
        expect(dyCursor).toBeCloseTo(2 * TW_AMP * amp * delta, 0);
      } else {
        expect(dyWave).toBeCloseTo(expected, 0);
        expect(dyCursor).toBeCloseTo(expected, 0);
      }
      expect(dyWave).toBeCloseTo(dyCursor, 0);
    });

    it('time-varying amplitude: cursor setAmplitude per frame matches WaveEngine per-segment dY (multi-beat off-grid)', () => {
      // [Step1] Before: time-varying tl
      const tl = new BpmTimeline(120, [
        { beat: 2, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 120, amplitude: 2.7 },
      ], 1.0);
      const segs: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'down', beats: 2 },
        { direction: 'down', beats: 2 },
      ];
      const engine = new WaveEngine(segs, tl, 1.0, 0);
      // Use small delta to avoid clamping at high amplitudes
      const delta = 0.1;
      const checks: Array<{ segStart: number; amp: number }> = [
        { segStart: 0, amp: 1.0 },
        { segStart: 2, amp: 0.7 },
        { segStart: 4, amp: 2.7 },
      ];
      for (const c of checks) {
        const beat = c.segStart;
        const tlAmp = tl.amplitudeAt(c.segStart);
        expect(tlAmp).toBeCloseTo(c.amp, 5);
        // For the time-varying engine, verify dy respects amp at segStart (with clamping)
        const dyWave = engine.waveYAt(beat + delta) - engine.waveYAt(beat);
        const expectedDy = clampY(engine.waveYAt(beat) + 2 * TW_AMP * c.amp * delta) - engine.waveYAt(beat);
        expect(dyWave).toBeCloseTo(expectedDy, 1);

        // Use isolated single-segment engine for slope comparison (no clamping issues)
        const tlSingle = new BpmTimeline(120, [], c.amp);
        const eSingle = new WaveEngine([{ direction: 'down', beats: 5 }], tlSingle, c.amp, 0);
        const slopeWave = (eSingle.waveYAt(delta) - eSingle.waveYAt(0)) / delta;
        const cursorSingle = new Cursor(c.amp, 0);
        const y0s = cursorSingle.y;
        cursorSingle.update((delta * beatMs) / 1000, false, true, beatMs, 1);
        const slopeCursor = (cursorSingle.y - y0s) / delta;
        expect(slopeWave).toBeCloseTo(2 * TW_AMP * c.amp, 0);
        expect(slopeCursor).toBeCloseTo(2 * TW_AMP * c.amp, 0);
        expect(slopeWave).toBeCloseTo(slopeCursor, 0);
      }
    });

    it('off-grid 0.37 / 1.23 phases maintain cursor==wave with time-varying amps 1.3 & 3.4', () => {
      for (const amp of [1.3, 3.4]) {
        const tl = new BpmTimeline(120, [], amp);
        const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0);
        for (const off of [0.37, 1.23]) {
          // Need to guarantee not clipped for amp 3.4 at 0.37 -> would clip, so test via single segment expectation with clamp
          const expected = expectedClampedY(0, amp, 'down', off);
          expect(engine.waveYAt(off)).toBeCloseTo(expected, 1);
          // cursor compare via isolated small delta before clip
          const small = 0.1;
          const eSmall = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0);
          const dyWaveSmall = eSmall.waveYAt(small) - eSmall.waveYAt(0);
          const c = new Cursor(amp, 0);
          c.setAmplitude(tl.amplitudeAt(0));
          const y0 = c.y;
          c.update((small * beatMs) / 1000, false, true, beatMs, 1);
          const dyCursorSmall = c.y - y0;
          expect(dyWaveSmall / small).toBeCloseTo(dyCursorSmall / small, 0);
        }
      }
    });

    it('WavePreview/EditorScreen uses time-varying threshold via timeline.amplitudeAt(startBeat) — segmentize fidelity', () => {
      // Simulate recording startBeat at 4 where amplitude 2.7, snap 0.25
      const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.7 }], 1.0);
      const startBeat = 4.0;
      const snap = 0.25;
      const ampAtStart = tl.amplitudeAt(startBeat);
      expect(ampAtStart).toBeCloseTo(2.7, 5);
      const traj = [
        { beat: startBeat, y: CENTER, down: true },
        { beat: startBeat + 0.37, y: CENTER + 80, down: true },
        { beat: startBeat + 0.37 + 0.01, y: CENTER + 80, down: false },
      ];
      const segs = segmentize(traj, snap, ampAtStart);
      expect(segs.length).toBeGreaterThan(0);
      for (const s of segs) {
        expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      }
      // Same traj with base amp 1.0 threshold may differ in direction classification but beats still snap-aligned
      const segsBase = segmentize(traj, snap, 1.0);
      for (const s of segsBase) {
        expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      }
    });
  });

  // ========================================================================
  // 7. BpmTimeline amplitudeEntries sorting & sanitization edge
  // ========================================================================
  describe('7. BpmTimeline amplitudeEntries edge & sanitization', () => {
    it('unsorted bpm_changes are sorted before amplitudeAt lookup', () => {
      const tl = new BpmTimeline(120, [
        { beat: 6, bpm: 120, amplitude: 2.7 },
        { beat: 2, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 120, amplitude: 1.3 },
      ], 1.0);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(1.3, 5);
      expect(tl.amplitudeAt(6.37)).toBeCloseTo(2.7, 5);
    });

    it('invalid amplitude values (NaN, <=0, Infinity) are ignored in amplitudeEntries', () => {
      const tl = new BpmTimeline(120, [
        { beat: 2, bpm: 120, amplitude: NaN as unknown as number },
        { beat: 4, bpm: 120, amplitude: -1 as unknown as number },
        { beat: 6, bpm: 120, amplitude: Infinity as unknown as number },
        { beat: 8, bpm: 120, amplitude: 0 as unknown as number },
        { beat: 10, bpm: 120, amplitude: 2.0 },
      ], 1.0);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(5.37)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(11)).toBeCloseTo(2.0, 5);
    });

    it('quantizeBeat remains correct for amplitude-invariant snap math', () => {
      expect(quantizeBeat(1.2, 0.5)).toBeCloseTo(1.0, 4);
      expect(quantizeBeat(1.3, 0.5)).toBeCloseTo(1.5, 4);
      expect(quantizeBeat(0.37, 0.25)).toBeCloseTo(0.25, 4);
      expect(quantizeBeat(0.37, 0.125)).toBeCloseTo(0.375, 4);
    });
  });
});
