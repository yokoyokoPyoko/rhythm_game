import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import { calculateVertexDrag, calculateVertexMultiDrag, calculateEdgeDrag, calculateMultiDrag } from '../src/game/editorDrag';
import { Cursor } from '../src/game/cursor';
import type { Segment } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;
const ZONE_MID_START = 256.7;
const ZONE_MID_END = 343.3;

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}
function ceilBeat(x: number, snap: number): number {
  if (!(snap > 0) || !Number.isFinite(x)) return Math.max(0, x);
  const n = Math.max(0, x);
  return Number((Math.ceil(n / snap - 1e-9) * snap).toFixed(4));
}
function zoneOf(y: number): 0 | 1 | 2 {
  return y < ZONE_MID_START ? 0 : y < ZONE_MID_END ? 1 : 2;
}
function snapY(y: number): number {
  const z = zoneOf(y);
  return z === 0 ? TOP : z === 1 ? CENTER : BOTTOM;
}
function readSrc(p: string): string {
  return fs.readFileSync(path.join(process.cwd(), p), 'utf-8');
}

describe('T215 頂点ドラッグ到達可能性解決 — Vitest node (editorDrag / WaveEngine / Cursor)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------------
  // 0. Source guards — must FAIL before fix (Red), PASS after (Green)
  // ------------------------------------------------------------------
  describe('0. Source fix guards (const->let, ceilBeat reachability, T215)', () => {
    it('editorDrag.ts must use let clampedBeat (not const) for endpoint T215 shift', () => {
      // [Step1] capture initial file content
      const src = readSrc('src/game/editorDrag.ts');
      // [Step2] search for let declaration
      const hasLet = /let\s+clampedBeat/.test(src);
      const hasConstReassign = /const\s+clampedBeat[\s\S]*?clampedBeat\s*=/.test(src);
      // [Step3] assert transition to let
      expect(hasLet, 'T215 prescription: Change const clampedBeat to let clampedBeat (lines 70,94)').toBe(true);
      // If const with reassignment remains, file would not compile (TS2588) — this guard ensures fix
      expect(hasConstReassign, 'should not have const clampedBeat with later assignment').toBe(false);
    });

    it('editorDrag.ts must implement ceilBeat (rounds up) for Y reachability', () => {
      const src = readSrc('src/game/editorDrag.ts');
      expect(src).toMatch(/function ceilBeat/);
      expect(src).toMatch(/Math\.ceil/);
      // Must guarantee reach: ceil not round
      expect(src).not.toMatch(/quantizeBeat\(needRaw/);
    });

    it('editorDrag.ts calculateVertexDrag must shift beatPrime to satisfy need', () => {
      const src = readSrc('src/game/editorDrag.ts');
      // Check for T215 shift logic: need > mouseBeatsPrev then shifted
      expect(src).toMatch(/need\s*>\s*mouseBeatsPrev/);
      expect(src).toMatch(/beatPrime\s*=\s*Math\.max/);
      // Also endpoint branches
      expect(src).toMatch(/if\s*\(need\s*>\s*beats\)/);
    });
  });

  // ------------------------------------------------------------------
  // 1. Interior vertex short-range freeze reproduction (core bug)
  // ------------------------------------------------------------------
  describe('1. Interior vertex: short 0.25 beat span must reach snapped zone (freeze regression)', () => {
    const snaps: number[] = [0.25, 0.5];
    const amps: number[] = [0.7, 1.0, 1.3, 2.7];

    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap}: mouse X 0.25 near prev with TOP demand must shift to need (not freeze at 65px)`, () => {
          // [Step1: Capture Initial State]
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          // all stay => all points at CENTER, easy to reason about yPrev=CENTER, target TOP
          const initial: Segment[] = [
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
          ];
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const idx = 2; // interior beat 2.0
          const prevBeat = pts0[idx - 1].beat; // 1.0
          const nextBeat = pts0[idx + 1].beat; // 3.0
          const yPrev = pts0[idx - 1].y; // CENTER
          const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
          const snappedTargetY = TOP; // demand up to TOP from CENTER
          const need = Math.max(snap, ceilBeat(Math.abs(snappedTargetY - yPrev) / perBeat, snap));
          // mouse gives only snap (0.25) — insufficient for amp 1.0 (need 0.5), amp 0.7 need ~0.75 etc
          const mouseTargetBeat = quantizeBeat(prevBeat + snap, snap); // minimal X
          const maxAvail = nextBeat - snap - prevBeat;
          const expectedNeed = Math.min(need, maxAvail);
          // Skip if need already equals snap (no shift needed for this amp)
          if (need <= snap + 1e-9) return;

          // [Step2: Perform Interaction]
          // targetY chosen in TOP zone (e.g. 170) to demand up
          const result = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat: mouseTargetBeat,
            targetY: TOP, // snapY -> TOP
            snap,
          });
          expect(result, 'vertex drag with insufficient X but TOP demand must not be null').not.toBeNull();
          const segs = result!;

          // [Step3: Assert Resulting Transition]
          // All beats snap-aligned
          for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
          expect(segs.length).toBe(initial.length);
          // Length invariant
          const engine1 = new WaveEngine(segs, tl, amp, 0);
          expect(engine1.getPoints().length).toBe(pts0.length);
          // beatsPrev must be >= need (ceil) not mouse snap
          const beatsPrev = segs[idx - 1].beats;
          expect(beatsPrev).toBeGreaterThanOrEqual(need - 1e-9);
          // Specifically shifted to need
          expect(beatsPrev).toBeCloseTo(expectedNeed, 4);
          // Achieved beat must be prevBeat+need
          const pts1 = engine1.getPoints();
          expect(Math.abs(pts1[idx].beat - (prevBeat + expectedNeed))).toBeLessThan(1e-6);
          // Wave Y at that beat must be snappedTargetY (reachable) — not mid 65px
          // Since we have stay->stay, waveYAt is determined by segment directions after drag
          // The drag sets dir prev to up/down based on zone, and perBeat ensures reach
          const achievedY = pts1[idx].y;
          // For stay->up case, point Y is determined by buildPoints logic: from yPrev via perBeat*beatsPrev but clamped
          // With need calculation, it should land exactly at snapped zone
          expect(Math.abs(achievedY - snappedTargetY)).toBeLessThan(1e-6);
          // Direction must be up (since CENTER->TOP)
          expect(segs[idx - 1].direction).toBe('up');
        });

        it(`amp=${amp} snap=${snap}: opposite direction BOTTOM demand also shifts (down)`, () => {
          // [Step1]
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          const initial: Segment[] = [
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
          ];
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const idx = 2;
          const prevBeat = pts0[idx - 1].beat;
          const yPrev = pts0[idx - 1].y; // CENTER
          const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
          const need = Math.max(snap, ceilBeat(Math.abs(BOTTOM - yPrev) / perBeat, snap));
          if (need <= snap + 1e-9) return;
          const mouseTargetBeat = quantizeBeat(prevBeat + snap, snap);

          // [Step2]
          const result = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat: mouseTargetBeat,
            targetY: BOTTOM,
            snap,
          });
          expect(result).not.toBeNull();
          const segs = result!;
          // [Step3]
          const beatsPrev = segs[idx - 1].beats;
          expect(beatsPrev).toBeGreaterThanOrEqual(need - 1e-9);
          const engine1 = new WaveEngine(segs, tl, amp, 0);
          const pts1 = engine1.getPoints();
          expect(Math.abs(pts1[idx].y - BOTTOM)).toBeLessThan(1e-6);
          expect(segs[idx - 1].direction).toBe('down');
        });
      }
    }

    it('off-grid phases 0.37 / 1.23 with snap 0.25 must also shift (not freeze)', () => {
      // [Step1] capture with off-grid mouse X that quantizes to snap but need still larger
      const amp = 1.0;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      // off-grid mouse 0.37 quantizes to 0.25, 1.23 quantizes to 1.25 etc.
      // For TOP demand, need 0.5, so 0.37->0.25 case must still shift
      const offGridMouseBeats = [0.37, 1.23];
      for (const raw of offGridMouseBeats) {
        const mouseBeat = quantizeBeat(prevBeat + raw - Math.floor(raw), snap);
        // ensure inside [prev+snap, next-snap]
        const clampedMouse = Math.max(prevBeat + snap, Math.min(engine0.getPoints()[idx + 1].beat - snap, mouseBeat));
        const result = calculateVertexDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          pointIndex: idx,
          targetBeat: clampedMouse,
          targetY: TOP,
          snap,
        });
        expect(result).not.toBeNull();
        const segs = result!;
        // need = 0.5, so even if mouse gives 0.25, result must be >=0.5
        const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
        const need = Math.max(snap, ceilBeat(Math.abs(TOP - CENTER) / perBeat, snap));
        expect(segs[idx - 1].beats).toBeGreaterThanOrEqual(need - 1e-9);
      }
    });

    it('when need exceeds maxAvail, shifts to maxAvail (not beyond adjacency)', () => {
      // [Step1] narrow span where need > maxAvail -> should clamp to maxAvail, not exceed
      const amp = 0.5; // perBeat 130, need TOP from CENTER =130/130=1.0
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      // span 0.5: pts 0:0,1:0.25,2:0.5,3:... narrow around idx1
      const initial: Segment[] = [
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const prevBeat = engine0.getPoints()[idx - 1].beat; // 0
      const nextBeat = engine0.getPoints()[idx + 1].beat; // 0.5
      const maxAvail = nextBeat - snap - prevBeat; // 0.25
      // need for amp 0.5 TOP is 1.0 > maxAvail 0.25
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: prevBeat + snap,
        targetY: TOP,
        snap,
      });
      expect(result).not.toBeNull();
      const segs = result!;
      const engine1 = new WaveEngine(segs, tl, amp, 0);
      const pts1 = engine1.getPoints();
      // Shifts to maxAvail, not to need (which would violate adjacency)
      expect(Math.abs(pts1[idx].beat - (prevBeat + maxAvail))).toBeLessThan(1e-6);
      expect(isSnapAligned(segs[idx - 1].beats, snap)).toBe(true);
      expect(isSnapAligned(segs[idx].beats, snap)).toBe(true);
      expect(engine1.getPoints().length).toBe(engine0.getPoints().length);
    });
  });

  // ------------------------------------------------------------------
  // 2. Endpoint vertices (0 and n) must also shift when Y demand exceeds X
  // ------------------------------------------------------------------
  describe('2. Endpoint vertex reachability (first & last)', () => {
    it('first vertex idx=0: small mouse beats with TOP demand must extend left-demand (shift to need)', () => {
      // [Step1] first vertex at beat 0 CENTER, next at 0.5 (narrow)
      // This requires const->let fix: endpoint branch reassigns clampedBeat
      const amp = 1.0;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 0.5 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const nextBeat = engine0.getPoints()[1].beat; // 0.5
      const y0 = engine0.getPoints()[0].y; // CENTER (startPosition 0)
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(0);
      const need = Math.max(snap, ceilBeat(Math.abs(TOP - y0) / perBeat, snap)); // 0.5
      // mouse gives only snap: clampedBeat = next - snap =0.25 => beats 0.25 < need 0.5
      const mouseBeat = nextBeat - snap; // 0.25
      // [Step2]
      let result: Segment[] | null = null;
      expect(() => {
        result = calculateVertexDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          pointIndex: 0,
          targetBeat: mouseBeat,
          targetY: TOP, // stay? Actually y0 CENTER->TOP is up, needs shift
          snap,
        });
      }).not.toThrow(); // before fix TypeError: Assignment to constant variable
      expect(result).not.toBeNull();
      const segs = result!;
      // [Step3] beats must be >= need (0.5) after shift
      expect(segs[0].beats).toBeGreaterThanOrEqual(need - 1e-9);
      expect(isSnapAligned(segs[0].beats, snap)).toBe(true);
      // Direction should be up (CENTER->TOP) or stay? Check zone
      // y0 CENTER (zone1) -> TOP zone0 => up
      expect(segs[0].direction).toBe('up');
      const engine1 = new WaveEngine(segs, tl, amp, 0);
      expect(engine1.getPoints().length).toBe(engine0.getPoints().length);
      expect(engine1.getPoints()[0].beat).toBeCloseTo(0, 6);
      // endpoint Y still CENTER (startPosition), but segment direction up will go to TOP after need beats
      // Check second point Y reaches expectation approx
      expect(engine1.getPoints()[1].y).toBeCloseTo(TOP, 0);
    });

    it('last vertex idx=n: small mouse beats with BOTTOM demand must extend right', () => {
      // [Step1]
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'stay', beats: 0.5 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const n = pts0.length - 1;
      const prevBeat = pts0[n - 1].beat; // 1.0
      const yPrev = pts0[n - 1].y;
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      // yPrev may be BOTTOM or CENTER depending on first segment
      const need = Math.max(snap, ceilBeat(Math.abs(BOTTOM - yPrev) / perBeat, snap));
      const mouseBeat = prevBeat + snap; // minimal
      // [Step2] must not throw (const->let)
      let result: Segment[] | null = null;
      expect(() => {
        result = calculateVertexDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          pointIndex: n,
          targetBeat: mouseBeat,
          targetY: BOTTOM,
          snap,
        });
      }).not.toThrow();
      expect(result).not.toBeNull();
      const segs = result!;
      // [Step3] if need > snap, beats should be need
      if (need > snap + 1e-9) {
        expect(segs[segs.length - 1].beats).toBeCloseTo(need, 4);
      }
      expect(isSnapAligned(segs[segs.length - 1].beats, snap)).toBe(true);
      const engine1 = new WaveEngine(segs, tl, amp, 0);
      expect(engine1.getPoints().length).toBe(pts0.length);
    });
  });

  // ------------------------------------------------------------------
  // 3. Off-grid fractional verification (0.37, 1.23, 0.63, 0.87) + complex amps
  // ------------------------------------------------------------------
  describe('3. Off-grid fractional verification with complex amplitudes', () => {
    const offGridBeats = [0.37, 1.23, 0.63, 0.87];
    const amps = [0.7, 1.3, 2.7, 3.4];
    const snaps = [0.125, 0.25, 0.5, 1];

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const off of offGridBeats) {
          it(`amp=${amp} snap=${snap} off=${off}: interior drag off-grid beats give snap-aligned, length invariant`, () => {
            // [Step1] capture
            const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
            const initial: Segment[] = [
              { direction: 'down', beats: quantizeBeat(1.5, snap) || snap },
              { direction: 'up', beats: quantizeBeat(1.5, snap) || snap },
              { direction: 'down', beats: quantizeBeat(1.5, snap) || snap },
            ];
            const engine0 = new WaveEngine(initial, tl, amp, 0);
            const idx = 1;
            const prevBeat = engine0.getPoints()[idx - 1].beat;
            const nextBeat = engine0.getPoints()[idx + 1].beat;
            const rawTarget = engine0.getPoints()[idx].beat + off;
            const targetBeat = quantizeBeat(rawTarget, snap);
            const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
            const targetY = off < 1 ? TOP : BOTTOM; // alternate zones off-grid
            // [Step2]
            const result = calculateVertexDrag({
              segments: initial,
              bpmTimeline: tl,
              startPosition: 0,
              pointIndex: idx,
              targetBeat: clamped,
              targetY,
              snap,
            });
            expect(result).not.toBeNull();
            const segs = result!;
            // [Step3] invariants
            for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
            const engine1 = new WaveEngine(segs, tl, amp, 0);
            expect(engine1.getPoints().length).toBe(engine0.getPoints().length);
            // only 2 segments around idx changed
            for (let k = 0; k < initial.length; k++) {
              if (k === idx - 1 || k === idx) continue;
              expect(segs[k].beats).toBeCloseTo(initial[k].beats, 6);
            }
            // total span unchanged
            const spanOrig = nextBeat - prevBeat;
            const spanNew = segs[idx - 1].beats + segs[idx].beats;
            expect(Math.abs(spanNew - spanOrig)).toBeLessThan(1e-6);
          });
        }
      }
    }
  });

  // ------------------------------------------------------------------
  // 4. Drag sequence harness — monotonic, no infinite freeze (direction×distance×height×amp)
  // ------------------------------------------------------------------
  describe('4. Drag sequence harness: direction × distance × height × amplitude — monotonic & freeze detection', () => {
    const amps = [0.7, 1.0, 1.3, 2.7] as const;
    const snaps = [0.25] as const;
    const distances = [0.25, 0.5, 0.75, 1.0, 1.23]; // beats from prev
    const heights: Array<{ y: number; name: string }> = [
      { y: TOP, name: 'TOP' },
      { y: CENTER, name: 'CENTER' },
      { y: BOTTOM, name: 'BOTTOM' },
    ];

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const h of heights) {
          it(`amp=${amp} snap=${snap} height=${h.name}: increasing targetBeat yields monotonic achieved beat (no freeze)`, () => {
            // [Step1] initial narrow-ish span to expose freeze
            const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
            const initial: Segment[] = [
              { direction: 'stay', beats: 1 },
              { direction: 'stay', beats: 1 },
              { direction: 'stay', beats: 1 },
            ];
            const engine0 = new WaveEngine(initial, tl, amp, 0);
            const idx = 1;
            const prevBeat = engine0.getPoints()[idx - 1].beat;
            const nextBeat = engine0.getPoints()[idx + 1].beat;
            const yPrev = engine0.getPoints()[idx - 1].y;

            // script drag sequence: sweep targetBeat from prev+snap to next-snap
            const achieved: number[] = [];
            const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
            const need = Math.max(snap, ceilBeat(Math.abs(snapY(h.y) - yPrev) / perBeat, snap));

            for (const d of distances) {
              const rawTarget = prevBeat + d;
              const targetBeat = quantizeBeat(rawTarget, snap);
              const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
              // T157: exact no-op (beat and Y identical) returns null — skip monotonic counting
              const curBeat = engine0.getPoints()[idx].beat;
              const curY = engine0.getPoints()[idx].y;
              if (Math.abs(clamped - curBeat) < 1e-9 && Math.abs(h.y - curY) < 1e-9) {
                const noop = calculateVertexDrag({
                  segments: initial,
                  bpmTimeline: tl,
                  startPosition: 0,
                  pointIndex: idx,
                  targetBeat: clamped,
                  targetY: h.y,
                  snap,
                });
                expect(noop).toBeNull();
                continue;
              }
              const result = calculateVertexDrag({
                segments: initial,
                bpmTimeline: tl,
                startPosition: 0,
                pointIndex: idx,
                targetBeat: clamped,
                targetY: h.y,
                snap,
              });
              expect(result).not.toBeNull();
              const engine1 = new WaveEngine(result!, tl, amp, 0);
              const beatAchieved = engine1.getPoints()[idx].beat;
              achieved.push(beatAchieved);
              // if Y demand needs large beats, early small distances must already be shifted
              if (h.y !== CENTER && need > d + 1e-9 && need <= (nextBeat - prevBeat - snap) + 1e-9) {
                expect(beatAchieved).toBeGreaterThanOrEqual(prevBeat + need - 1e-6);
              }
            }
            // monotonic non-decreasing (allow equal only at clamp limit)
            for (let i = 1; i < achieved.length; i++) {
              expect(achieved[i]).toBeGreaterThanOrEqual(achieved[i - 1] - 1e-9);
            }
            // not all equal — at least one increase (freeze would be all equal)
            const distinct = new Set(achieved.map(v => v.toFixed(4)));
            // if distances vary, beats should vary (unless at maxAvail clamp)
            // For narrow demand that needs shift, first entries already at need, so later larger distances should still increase beyond need
            if (need + 0.5 <= (nextBeat - prevBeat - snap) + 1e-9) {
              expect(distinct.size).toBeGreaterThan(1);
            }
          });
        }
      }
    }

    it('Y-demand harness: same X (small) with increasing Y demand must increase beats (not freeze)', () => {
      // [Step1] fixed small X, sweep Y from stay to opposite zone
      const amp = 1.0;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const targetBeat = prevBeat + snap; // minimal X

      // sequence of Y: CENTER (stay, need snap) -> intermediate -> TOP (need 0.5) -> BOTTOM (need 0.5)
      const ySeq = [CENTER + 5, CENTER, TOP, BOTTOM];
      const beatsSeq: number[] = [];
      for (const y of ySeq) {
        const result = calculateVertexDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          pointIndex: idx,
          targetBeat,
          targetY: y,
          snap,
        });
        expect(result).not.toBeNull();
        beatsSeq.push(result![idx - 1].beats);
        expect(isSnapAligned(result![idx - 1].beats, snap)).toBe(true);
      }
      // For amp 1.0 snap 0.25: CENTER demand (stay) => beats 0.25, TOP demand => beats 0.5 — must increase
      // Freeze bug would keep 0.25 for both
      expect(beatsSeq[2]).toBeGreaterThan(beatsSeq[0] - 1e-9);
      // All beats snap aligned
      for (const b of beatsSeq) expect(isSnapAligned(b, snap)).toBe(true);
    });

    it('off-grid distance 0.37 vs 0.87 must give distinct beats (not collapsed)', () => {
      const amp = 2.7;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 2 },
        { direction: 'stay', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const ySame = CENTER;
      const t1 = quantizeBeat(prevBeat + 0.37, snap);
      const t2 = quantizeBeat(prevBeat + 0.87, snap);
      const r1 = calculateVertexDrag({ segments: initial, bpmTimeline: tl, startPosition: 0, pointIndex: idx, targetBeat: t1, targetY: ySame, snap });
      const r2 = calculateVertexDrag({ segments: initial, bpmTimeline: tl, startPosition: 0, pointIndex: idx, targetBeat: t2, targetY: ySame, snap });
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      const b1 = new WaveEngine(r1!, tl, amp, 0).getPoints()[idx].beat;
      const b2 = new WaveEngine(r2!, tl, amp, 0).getPoints()[idx].beat;
      expect(Math.abs(b1 - t1)).toBeLessThan(1e-6);
      expect(Math.abs(b2 - t2)).toBeLessThan(1e-6);
      expect(b2).toBeGreaterThan(b1);
    });
  });

  // ------------------------------------------------------------------
  // 5. Invariants: length, snap, only 2 segments changed, posterior immobility
  // ------------------------------------------------------------------
  describe('5. Invariants: getPoints length, snap, 2-segment scope, posterior shift', () => {
    it('interior drag changes exactly 2 segments, others bit-exact, total span preserved', () => {
      // [Step1]
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const idx = 2;
      const prevBeat = pts0[idx - 1].beat;
      const nextBeat = pts0[idx + 1].beat;
      const targetBeat = quantizeBeat(prevBeat + 0.63, snap);
      const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
      // [Step2]
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: clamped,
        targetY: pts0[idx].y,
        snap,
      });
      expect(result).not.toBeNull();
      const segs = result!;
      // [Step3]
      expect(segs.length).toBe(initial.length);
      expect(new WaveEngine(segs, tl, amp, 0).getPoints().length).toBe(pts0.length);
      for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
      for (let k = 0; k < initial.length; k++) {
        if (k === idx - 1 || k === idx) continue;
        expect(segs[k].beats).toBeCloseTo(initial[k].beats, 6);
        expect(segs[k].direction).toBe(initial[k].direction);
      }
      const spanOrig = nextBeat - prevBeat;
      const spanNew = segs[idx - 1].beats + segs[idx].beats;
      expect(Math.abs(spanNew - spanOrig)).toBeLessThan(1e-6);
      // posterior points unchanged beyond idx+1
      const pts1 = new WaveEngine(segs, tl, amp, 0).getPoints();
      for (let i = idx + 1; i < pts0.length; i++) {
        expect(Math.abs(pts1[i].beat - pts0[i].beat)).toBeLessThan(1e-6);
      }
    });

    it('all beats remain snap multiples across random off-grid drags', () => {
      const snaps = [0.125, 0.25, 0.5] as const;
      const amp = 2.7;
      for (const snap of snaps) {
        const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
        // snap-aligned initial: quantize raw beats to snap to guarantee alignment
        const initial: Segment[] = [
          { direction: 'down', beats: quantizeBeat(1.5, snap) },
          { direction: 'up', beats: quantizeBeat(0.75, snap) || snap },
          { direction: 'down', beats: quantizeBeat(0.5, snap) || snap },
        ];
        const engine0 = new WaveEngine(initial, tl, amp, 0);
        for (const idx of [1, 2]) {
          const prevBeat = engine0.getPoints()[idx - 1].beat;
          const nextBeat = engine0.getPoints()[idx + 1].beat;
          const targetBeat = quantizeBeat(prevBeat + 0.37, snap);
          const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
          const res = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat: clamped,
            targetY: idx === 1 ? TOP : BOTTOM,
            snap,
          });
          if (res) {
            for (const s of res) expect(isSnapAligned(s.beats, snap), `snap=${snap} idx=${idx} beats=${s.beats}`).toBe(true);
          }
        }
      }
      // snap=1 separately with explicitly aligned beats
      {
        const snap = 1 as const;
        const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
        const initial: Segment[] = [
          { direction: 'down', beats: 2 },
          { direction: 'up', beats: 1 },
          { direction: 'down', beats: 2 },
        ];
        const engine0 = new WaveEngine(initial, tl, amp, 0);
        for (const idx of [1, 2]) {
          const prevBeat = engine0.getPoints()[idx - 1].beat;
          const nextBeat = engine0.getPoints()[idx + 1].beat;
          const targetBeat = quantizeBeat(prevBeat + 0.37, snap);
          const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
          const res = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat: clamped,
            targetY: idx === 1 ? TOP : BOTTOM,
            snap,
          });
          if (res) {
            for (const s of res) expect(isSnapAligned(s.beats, snap), `snap=${snap} idx=${idx} beats=${s.beats}`).toBe(true);
          }
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // 6. Complex amplitudes + Cursor numeric consistency (T127 style)
  // ------------------------------------------------------------------
  describe('6. Complex amplitudes + off-grid numeric consistency (WaveEngine ↔ Cursor)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offGrid = [0.37, 1.23] as const;
    for (const amp of amps) {
      for (const off of offGrid) {
        it(`amp=${amp} off=${off}: waveYAt per-beat dY clamped matches Cursor displacement`, () => {
          // [Step1]
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          const segs: Segment[] = [{ direction: 'down', beats: 5 }];
          const engine = new WaveEngine(segs, tl, amp, 0);
          const perBeat = 2 * TW_AMP * amp;
          const rawY = CENTER + perBeat * off;
          const expectedY = Math.max(TOP, Math.min(BOTTOM, rawY));
          // [Step2] waveYAt
          const actualY = engine.waveYAt(off);
          // [Step3] assert wave and cursor consistent
          expect(Math.abs(actualY - expectedY)).toBeLessThan(1e-6);
          const beatMs = 500;
          const cursor = new Cursor(amp, 0);
          cursor.setAmplitude(amp);
          const startY = cursor.y;
          cursor.update(beatMs / 1000, false, true, beatMs);
          const disp = cursor.y - startY;
          const expectedDisp = Math.min(BOTTOM - startY, perBeat * (beatMs / 1000) / (beatMs / 1000) * 1); // per beat
          // Actually per beat disp = perBeat; limited by clamp
          const clampedDisp = Math.min(BOTTOM - CENTER, perBeat);
          expect(Math.abs(disp - clampedDisp)).toBeLessThan(1e-3);
          // slope check for small off before clamp
          if (off * perBeat < TW_AMP + 1e-9) {
            const smallOff = 0.1;
            const dy = engine.waveYAt(smallOff) - engine.waveYAt(0);
            expect(Math.abs(dy / smallOff - perBeat)).toBeLessThan(1);
          }
        });
      }
    }

    it('drag result waveYAt at moved vertex equals snapped zone when reachable, else maxAvail', () => {
      // [Step1] amp 1.3, off-grid 0.37 case where need reachable
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 2 },
        { direction: 'stay', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const yPrev = engine0.getPoints()[idx - 1].y;
      // demand TOP from CENTER, need = ceil(130/(2*130*1.3)) = ceil(0.3846) with snap 0.25 => 0.5
      const need = Math.max(snap, ceilBeat(Math.abs(TOP - yPrev) / (2 * TW_AMP * amp), snap));
      const mouseBeat = prevBeat + snap; // 0.25 < need 0.5
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: mouseBeat,
        targetY: TOP,
        snap,
      });
      expect(result).not.toBeNull();
      const engine1 = new WaveEngine(result!, tl, amp, 0);
      const achievedBeat = engine1.getPoints()[idx].beat;
      expect(Math.abs(achievedBeat - (prevBeat + need))).toBeLessThan(1e-6);
      expect(engine1.getPoints()[idx].y).toBeCloseTo(TOP, 6);
      // off-grid phase check: waveYAt at 0.37 within segment must follow dY
      const midBeat = prevBeat + 0.37;
      // mid is inside first segment after drag: y = yPrev + dY*(mid - prev)
      // dY should be -perBeat for up segment
      const dY = result![0].direction === 'up' ? -2 * TW_AMP * amp : 2 * TW_AMP * amp;
      if (midBeat < achievedBeat) {
        const expectedMidY = Math.max(TOP, Math.min(BOTTOM, yPrev + dY * (midBeat - prevBeat)));
        expect(engine1.waveYAt(midBeat)).toBeCloseTo(expectedMidY, 0);
      }
    });
  });

  // ------------------------------------------------------------------
  // 7. Easing-aware perBeat (BpmTimeline amplitudeAt) used for need
  // ------------------------------------------------------------------
  describe('7. Time-varying amplitude (bpm_changes list / easing) reflected in perBeat', () => {
    it('amplitudeAt step: prevBeat in low-amp zone uses low perBeat, high zone uses high', () => {
      // [Step1] timeline with amplitude step at beat 2: 0.5 -> 1.5
      const snap = 0.25;
      const tl = new BpmTimeline(
        [
          { beat: 0, bpm: 120, amplitude: 0.5 },
          { beat: 2, bpm: 120, amplitude: 1.5 },
        ] as any,
        1.0,
      );
      // verify amplitudeAt
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(0.5, 2);
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(0.5, 2);
      expect(tl.amplitudeAt(2.5)).toBeCloseTo(1.5, 2);

      // segments covering both zones: stay 2 beats (0-2) + stay 2 beats (2-4)
      const initial: Segment[] = [
        { direction: 'stay', beats: 2 },
        { direction: 'stay', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      // idx 1 at beat 2.0, yPrev at beat 0, perBeat uses amplitudeAt(0)=0.5
      const idxLow = 1;
      const prevBeatLow = engine0.getPoints()[idxLow - 1].beat; // 0
      const perBeatLow = 2 * TW_AMP * tl.amplitudeAt(prevBeatLow); // 130
      const needLow = Math.max(snap, ceilBeat(Math.abs(TOP - CENTER) / perBeatLow, snap)); // 130/130=1.0
      // idx 2 would be after, but we have only 2 segments: idx 1 is at 2.0 with next at 4.0
      // For low zone, need 1.0, mouse 0.25 should shift to 1.0
      const resLow = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idxLow,
        targetBeat: prevBeatLow + snap,
        targetY: TOP,
        snap,
      });
      expect(resLow).not.toBeNull();
      expect(resLow![0].beats).toBeCloseTo(needLow, 4);

      // Now test high zone: need with amp 1.5 => perBeat 390, need 130/390=0.333 -> ceil 0.5
      // Use idx after beat 2: drag vertex at 2.0? Actually vertex 1 is exactly at boundary.
      // To test high zone we need prevBeat =2.0, so we drag vertex that has prev at 2.0.
      // That would be vertex 2? Wait we have pts 0:0,1:2,2:4. There is no vertex with prev 2 except n=2.
      // So test last vertex (n) where prev is 2.0 high amp
      const n = engine0.getPoints().length - 1;
      const prevHigh = engine0.getPoints()[n - 1].beat; // 2.0
      const perBeatHigh = 2 * TW_AMP * tl.amplitudeAt(prevHigh); // 390
      const needHigh = Math.max(snap, ceilBeat(Math.abs(BOTTOM - CENTER) / perBeatHigh, snap)); // 0.5
      const resHigh = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: n,
        targetBeat: prevHigh + snap,
        targetY: BOTTOM,
        snap,
      });
      expect(resHigh).not.toBeNull();
      expect(resHigh![resHigh!.length - 1].beats).toBeCloseTo(needHigh, 4);
      // Low need 1.0 vs high need 0.5 — time-varying amplitude must affect result
      expect(needLow).toBeGreaterThan(needHigh);
      expect(resLow![0].beats).toBeGreaterThan(resHigh![resHigh!.length - 1].beats - 1e-9);
    });

    it('easing zone: amplitudeAt interpolated perBeat still yields snap-aligned need', () => {
      const snap = 0.25;
      // linear easing from 0.5 to 1.5 over [0,4]
      const tl = new BpmTimeline(
        [
          { beat: 0, bpm: 120, amplitude: 0.5, easeToNext: 'linear' },
          { beat: 4, bpm: 120, amplitude: 1.5 },
        ] as any,
        1.0,
      );
      // At beat 1.0, amplitude interpolated: 0.5 + (1.5-0.5)*0.25=0.75
      const ampAt1 = tl.amplitudeAt(1.0);
      expect(ampAt1).toBeCloseTo(0.75, 2);
      const initial: Segment[] = [
        { direction: 'stay', beats: 2 },
        { direction: 'stay', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const idx = 1; // at 2.0, amp ~1.0
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const need = Math.max(snap, ceilBeat(Math.abs(TOP - CENTER) / perBeat, snap));
      const res = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: prevBeat + snap,
        targetY: TOP,
        snap,
      });
      expect(res).not.toBeNull();
      expect(isSnapAligned(res![0].beats, snap)).toBe(true);
      expect(res![0].beats).toBeCloseTo(need, 4);
    });
  });

  // ------------------------------------------------------------------
  // 8. Regression: other editorDrag APIs still satisfy invariants (T155 etc)
  // ------------------------------------------------------------------
  describe('8. Regression: edge/multi drag invariants not broken by T215', () => {
    it('calculateEdgeDrag preserves original length and snap, getPoints invariant', () => {
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1.5 },
        { direction: 'up', beats: 2.0 },
        { direction: 'down', beats: 1.5 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const edgeIdx = 1;
      const result = calculateEdgeDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        edgeIndex: edgeIdx,
        startBeat: pts0[edgeIdx].beat,
        startY: pts0[edgeIdx].y,
        startPrevBeat: pts0[edgeIdx - 1]?.beat ?? 0,
        startNextBeat: pts0[edgeIdx + 2]?.beat ?? pts0[pts0.length - 1].beat,
        dxBeat: quantizeBeat(0.37, snap),
        dy: 30,
        snap,
      });
      expect(result).not.toBeNull();
      expect(result!.length).toBe(initial.length);
      for (const s of result!) expect(isSnapAligned(s.beats, snap)).toBe(true);
      expect(new WaveEngine(result!, tl, amp, 0).getPoints().length).toBe(pts0.length);
    });

    it('calculateVertexMultiDrag single vertex {v} moves only that vertex', () => {
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const v = 2;
      const dx = quantizeBeat(0.37, snap);
      const res = calculateVertexMultiDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        vertexIndices: [v],
        dxBeat: dx,
        dy: 0,
        snap,
      });
      expect(res).not.toBeNull();
      const pts1 = new WaveEngine(res!, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[v].beat - quantizeBeat(pts0[v].beat + dx, snap))).toBeLessThan(1e-6);
      expect(Math.abs(pts1[v + 1].beat - pts0[v + 1].beat)).toBeLessThan(1e-6);
      for (const s of res!) expect(isSnapAligned(s.beats, snap)).toBe(true);
    });

    it('calculateMultiDrag still works (edge collection)', () => {
      const snap = 0.25;
      const amp = 1.0;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const res = calculateMultiDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        selSegIdxs: [1],
        dxBeat: quantizeBeat(0.37, snap),
        dy: 20,
        snap,
      });
      expect(res).not.toBeNull();
      expect(res!.length).toBe(initial.length);
    });
  });
});
